//! In-app updates from this project's GitHub Releases.
//!
//! The app asks GitHub for the newest release, downloads the file for this computer,
//! checks it against the SHA-256 checksum published next to it, and then:
//!   - Mac: swaps the app in place (the old copy is removed only after the new one is in place) and restarts;
//!   - Windows: starts the installer and closes, the installer replaces the app.

use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::AppHandle;

const REPO: &str = "pugcadet/media-hub";
const MAX_BYTES: usize = 400 * 1024 * 1024;

fn platform() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "macos"
    }
}

fn asset_name() -> &'static str {
    if cfg!(windows) {
        "MediaHub-windows-setup.exe"
    } else {
        "MediaHub-macos.app.tar.gz"
    }
}

/// "v0.10.2" -> (0, 10, 2). Anything unreadable counts as 0.
pub fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches('v').split(|c: char| c == '.' || c == '-').map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn newer(latest: &str, current: &str) -> bool {
    parse_version(latest) > parse_version(current)
}

pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut p = l.split_whitespace();
        let (h, f) = (p.next()?, p.next()?);
        (f.trim_start_matches('*') == name && h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit())).then(|| h.to_lowercase())
    })
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("MediaHub/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| Error::msg(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    latest: Option<String>,
    available: bool,
    notes: String,
}

/// GitHub allows only a few questions an hour without an account, so answers are kept: a
/// repository is asked at most once every 6 hours (a manual check: once every 10 minutes), and
/// after "slow down" not again until GitHub says it's fine.
struct Cached {
    at: std::time::Instant,
    value: Option<Value>,
    blocked_until: Option<std::time::Instant>,
}

fn cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Cached>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Cached>>> = std::sync::OnceLock::new();
    C.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The latest release of a GitHub repository ("owner/name"), from the cache when it's recent.
pub async fn github_latest(repo: &str, max_age: Duration) -> Result<Value> {
    let now = std::time::Instant::now();
    if let Ok(c) = cache().lock() {
        if let Some(x) = c.get(repo) {
            if let Some(v) = &x.value {
                if now.duration_since(x.at) < max_age {
                    return Ok(v.clone());
                }
            }
            if x.blocked_until.map(|t| now < t).unwrap_or(false) {
                return match &x.value {
                    Some(v) => Ok(v.clone()),
                    None => Err(Error::msg("GitHub asked Media Hub to wait before checking again; it will try by itself later.")),
                };
            }
        }
    }
    let resp = http()?
        .get(format!("https://api.github.com/repos/{repo}/releases/latest"))
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| Error::Network(e.without_url().to_string()))?;
    let status = resp.status().as_u16();
    if status == 403 || status == 429 {
        // Wait until GitHub's limit resets (its header says when), at least 15 minutes.
        let reset = resp.headers().get("x-ratelimit-reset").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
        let now_unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let wait = reset.map(|r| r.saturating_sub(now_unix)).unwrap_or(3600).clamp(900, 6 * 3600);
        let mut c = cache().lock().map_err(|_| Error::msg("internal error"))?;
        let e = c.entry(repo.to_string()).or_insert(Cached { at: now, value: None, blocked_until: None });
        e.blocked_until = Some(now + Duration::from_secs(wait));
        return match &e.value {
            Some(v) => Ok(v.clone()),
            None => Err(Error::msg("GitHub asked Media Hub to wait before checking again; it will try by itself later.")),
        };
    }
    let v: Value = match status {
        200 => resp.json().await.map_err(|_| Error::msg("GitHub gave an unexpected answer."))?,
        404 => return Err(Error::msg("No update information found. The GitHub repository must be public for updates to work.")),
        s => return Err(Error::msg(format!("GitHub answered with status {s}."))),
    };
    if let Ok(mut c) = cache().lock() {
        c.insert(repo.to_string(), Cached { at: now, value: Some(v.clone()), blocked_until: None });
    }
    Ok(v)
}

async fn latest_release() -> Result<Value> {
    github_latest(REPO, Duration::from_secs(6 * 3600)).await
}

#[tauri::command]
pub async fn check_update(manual: Option<bool>) -> Result<UpdateInfo> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let rel = if manual.unwrap_or(false) { github_latest(REPO, Duration::from_secs(600)).await? } else { latest_release().await? };
    let latest = rel.get("tag_name").and_then(Value::as_str).map(|t| t.trim_start_matches('v').to_string());
    let has_asset = rel
        .get("assets")
        .and_then(Value::as_array)
        .map(|a| a.iter().any(|x| x.get("name").and_then(Value::as_str) == Some(asset_name())))
        .unwrap_or(false);
    Ok(UpdateInfo {
        available: has_asset && latest.as_deref().map(|l| newer(l, &current)).unwrap_or(false),
        notes: rel.get("body").and_then(Value::as_str).unwrap_or("").chars().take(2000).collect(),
        latest,
        current,
    })
}

fn asset_url(rel: &Value, name: &str) -> Option<String> {
    rel.get("assets")?
        .as_array()?
        .iter()
        .find(|a| a.get("name").and_then(Value::as_str) == Some(name))?
        .get("browser_download_url")?
        .as_str()
        .filter(|u| u.starts_with("https://github.com/") || u.starts_with("https://objects.githubusercontent.com/"))
        .map(String::from)
}

async fn download(url: &str) -> Result<Vec<u8>> {
    let resp = http()?.get(url).send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(Error::msg(format!("Download failed with status {}.", resp.status())));
    }
    let bytes = resp.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::msg("Unexpectedly large download; stopped."));
    }
    Ok(bytes.to_vec())
}

/// The running app's bundle: /Applications/Media Hub.app (from .../Contents/MacOS/media-hub).
fn current_bundle() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let bundle = exe.ancestors().nth(3).ok_or_else(|| Error::msg("Could not find the app."))?.to_path_buf();
    if bundle.extension().and_then(|e| e.to_str()) != Some("app") {
        return Err(Error::msg("Media Hub is not running from an .app bundle, so it can't update itself."));
    }
    Ok(bundle)
}

fn swap_bundle(new_app: &Path, bundle: &Path) -> Result<()> {
    let old = bundle.with_file_name(format!(
        ".{}-old",
        bundle.file_name().and_then(|n| n.to_str()).unwrap_or("Media Hub.app")
    ));
    if old.exists() {
        std::fs::remove_dir_all(&old)?;
    }
    std::fs::rename(bundle, &old).map_err(|e| Error::msg(format!("Could not replace the app ({e}). Is it in a folder you can write to?")))?;
    if let Err(e) = std::fs::rename(new_app, bundle) {
        let _ = std::fs::rename(&old, bundle); // put the old one back
        return Err(e.into());
    }
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<()> {
    let rel = latest_release().await?;
    let url = asset_url(&rel, asset_name()).ok_or_else(|| Error::msg("This release has no file for this computer."))?;
    let sums_url = asset_url(&rel, &format!("SHA256SUMS-{}.txt", platform())).ok_or_else(|| Error::msg("This release has no checksum file."))?;
    let sums = String::from_utf8_lossy(&download(&sums_url).await?).into_owned();
    let expected = checksum_for(&sums, asset_name()).ok_or_else(|| Error::msg("The checksum file does not list this download."))?;
    let bytes = download(&url).await?;
    let actual: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err(Error::msg("The download did not match its checksum, so it was thrown away."));
    }
    let dir = std::env::temp_dir().join(format!("mediahub-update-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(asset_name());
    std::fs::write(&file, &bytes)?;

    if cfg!(windows) {
        std::process::Command::new(&file)
            .spawn()
            .map_err(|e| Error::msg(format!("Could not start the installer: {e}")))?;
        app.exit(0);
        return Ok(());
    }

    let out = std::process::Command::new("tar").arg("-xzf").arg(&file).arg("-C").arg(&dir).output()?;
    if !out.status.success() {
        return Err(Error::msg("Could not unpack the update."));
    }
    let new_app = std::fs::read_dir(&dir)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|e| e.to_str()) == Some("app"))
        .ok_or_else(|| Error::msg("The update did not contain the app."))?;
    let bundle = current_bundle()?;
    swap_bundle(&new_app, &bundle)?;
    let _ = std::process::Command::new("open").arg("-n").arg(&bundle).spawn();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare() {
        assert!(newer("v0.10.0", "0.9.5"));
        assert!(newer("1.0.0", "0.99.99"));
        assert!(!newer("v0.9.0", "0.9.0"));
        assert!(!newer("garbage", "0.1.0"));
        assert_eq!(parse_version("v1.2.3-beta"), (1, 2, 3));
    }

    #[test]
    fn checksums_and_assets() {
        let h = "a".repeat(64);
        assert_eq!(checksum_for(&format!("{h}  MediaHub-macos.app.tar.gz\n"), "MediaHub-macos.app.tar.gz"), Some(h.clone()));
        assert_eq!(checksum_for("short  x", "x"), None);
        let rel = serde_json::json!({"assets": [
            {"name": "a", "browser_download_url": "https://github.com/pugcadet/media-hub/releases/download/v1/a"},
            {"name": "b", "browser_download_url": "https://evil.example/b"}
        ]});
        assert!(asset_url(&rel, "a").is_some());
        assert!(asset_url(&rel, "b").is_none(), "only GitHub download addresses are accepted");
    }

    #[test]
    fn swap_keeps_old_when_new_is_missing() {
        let d = std::env::temp_dir().join(format!("mediahub-swap-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("Media Hub.app")).unwrap();
        std::fs::write(d.join("Media Hub.app/x"), b"old").unwrap();
        assert!(swap_bundle(&d.join("missing.app"), &d.join("Media Hub.app")).is_err());
        assert_eq!(std::fs::read(d.join("Media Hub.app/x")).unwrap(), b"old");
        std::fs::create_dir_all(d.join("new.app")).unwrap();
        std::fs::write(d.join("new.app/x"), b"new").unwrap();
        swap_bundle(&d.join("new.app"), &d.join("Media Hub.app")).unwrap();
        assert_eq!(std::fs::read(d.join("Media Hub.app/x")).unwrap(), b"new");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
