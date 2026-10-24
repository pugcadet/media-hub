//! Settings kept on this computer. The API key is NOT stored here; it lives in the
//! operating system's key storage (see secrets.rs).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub server_url: Option<String>,
    pub server_name: Option<String>,
    /// The folder on this computer where the NAS share is mounted (for renaming).
    pub library_root: Option<String>,
    /// Preferred subtitle languages, 3-letter codes in order ("eng", "dut").
    pub sub_langs: Vec<String>,
    /// ffmpeg chosen by the user, if it is not in a usual place.
    pub ffmpeg_path: Option<String>,
    /// How Jellyfin's file paths map to this computer (learned automatically).
    pub path_map: Option<crate::media_tools::PathMap>,
    /// Random id Jellyfin uses to tell this computer's streams apart.
    pub device_id: Option<String>,
    /// While true, the app only reads from Jellyfin. Later modules check this
    /// flag before they change anything. It starts on and stays on by default.
    pub read_only: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: None,
            server_name: None,
            library_root: None,
            sub_langs: vec!["eng".into()],
            ffmpeg_path: None,
            path_map: None,
            device_id: None,
            read_only: true,
        }
    }
}

fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read(path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> Result<()> {
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| Error::msg(e.to_string()))?)?;
    std::fs::rename(tmp, path(dir))?;
    Ok(())
}

/// Turns what a person types ("192.168.1.5:8096", "https://jf.example.com/")
/// into a clean base address without a trailing slash.
pub fn normalize_server_url(input: &str) -> Result<String> {
    let t = input.trim();
    if t.is_empty() {
        return Err(Error::msg("Enter the address of your Jellyfin server."));
    }
    let with_scheme = if t.contains("://") {
        t.to_string()
    } else {
        format!("http://{t}")
    };
    let u = url::Url::parse(&with_scheme)
        .map_err(|_| Error::msg("That address does not look right. Example: http://192.168.1.20:8096"))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(Error::msg("The address must start with http:// or https://"));
    }
    let host = u
        .host_str()
        .ok_or_else(|| Error::msg("The address has no server name in it."))?;
    if !u.username().is_empty() || u.password().is_some() {
        return Err(Error::msg("Do not put a user name or password in the address."));
    }
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    let path = u.path().trim_end_matches('/');
    Ok(format!("{}://{}{}{}", u.scheme(), host, port, path))
}

/// Jellyfin API keys are plain letters and digits. Anything else is a paste mistake
/// (and we never want odd characters inside a header).
pub fn valid_key(k: &str) -> bool {
    (8..=128).contains(&k.len()) && k.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_scheme_and_keeps_port() {
        assert_eq!(normalize_server_url("192.168.1.5:8096").unwrap(), "http://192.168.1.5:8096");
    }

    #[test]
    fn strips_trailing_slash_query_and_fragment() {
        assert_eq!(
            normalize_server_url("https://jf.example.com/jellyfin/?x=1#y").unwrap(),
            "https://jf.example.com/jellyfin"
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("ftp://nas").is_err());
        assert!(normalize_server_url("http://user:pw@nas").is_err());
    }

    #[test]
    fn key_validation() {
        assert!(valid_key("0123456789abcdef0123456789abcdef"));
        assert!(!valid_key("short"));
        assert!(!valid_key("0123456789abcdef\"0123456789abcdef"));
        assert!(!valid_key("0123456789abcdef 0123456789abcdef"));
    }
}
