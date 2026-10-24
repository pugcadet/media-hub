//! Downloads with yt-dlp (the Goblin module): videos, music and "custom series"
//! (a YouTube channel or playlist saved as Show/Season 01/Show - S01E01 - Title).
//!
//! Safety: yt-dlp is started directly (never through a shell) with a fixed set of
//! options built here; user config files are ignored; only http(s) addresses are accepted;
//! files can only be written inside the chosen download folder.

use crate::error::{Error, Result};
use crate::media_tools;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

const RELEASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";

fn asset_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    }
}

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn own_copy(state: &AppState) -> PathBuf {
    state.dir.join("bin").join(asset_name())
}

/// yt-dlp kept by this app first (it can update it), then one installed on the system.
fn locate(state: &AppState) -> Option<PathBuf> {
    let own = own_copy(state);
    if own.is_file() {
        return Some(own);
    }
    let exe = if cfg!(windows) { "yt-dlp.exe" } else { "yt-dlp" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

fn version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.args(["--ignore-config", "--version"]).stdin(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    path: Option<String>,
    version: Option<String>,
    managed: bool,
    folder: Option<String>,
}

#[tauri::command]
pub async fn ytdlp_info(state: State<'_, AppState>) -> Result<ToolState> {
    let p = locate(&state);
    let managed = p.as_ref().map(|p| *p == own_copy(&state)).unwrap_or(false);
    let folder = state.settings()?.download_dir;
    let pp = p.clone();
    let version = tauri::async_runtime::spawn_blocking(move || pp.as_deref().and_then(version))
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    Ok(ToolState { path: p.map(|p| p.to_string_lossy().into_owned()), version, managed, folder })
}

/// The expected checksum for `name` from yt-dlp's SHA2-256SUMS file.
pub fn checksum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut parts = l.split_whitespace();
        let (hash, file) = (parts.next()?, parts.next()?);
        (file.trim_start_matches('*') == name && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
            .then(|| hash.to_lowercase())
    })
}

/// Downloads (or updates) the app's own copy of yt-dlp from its official GitHub releases,
/// and only keeps it if the file matches the published SHA-256 checksum.
#[tauri::command]
pub async fn ytdlp_install(state: State<'_, AppState>) -> Result<String> {
    let http = reqwest::Client::builder()
        .user_agent("MediaHub/0.6")
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| Error::msg(e.to_string()))?;
    let get = |url: String| {
        let http = http.clone();
        async move {
            let r = http.get(&url).send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
            if !r.status().is_success() {
                return Err(Error::msg(format!("Download failed with status {}", r.status())));
            }
            r.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))
        }
    };
    let sums = get(format!("{RELEASE}SHA2-256SUMS")).await?;
    let expected = checksum_for(&String::from_utf8_lossy(&sums), asset_name())
        .ok_or_else(|| Error::msg("The checksum list did not include this computer's version."))?;
    let bin = get(format!("{RELEASE}{}", asset_name())).await?;
    if bin.len() > 80 * 1024 * 1024 {
        return Err(Error::msg("Unexpectedly large download; stopped."));
    }
    let actual: String = Sha256::digest(&bin).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected {
        return Err(Error::msg("The download did not match its published checksum, so it was thrown away."));
    }
    let target = own_copy(&state);
    std::fs::create_dir_all(target.parent().expect("bin dir"))?;
    let tmp = target.with_extension("download");
    std::fs::write(&tmp, &bin)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &target)?;
    #[cfg(target_os = "macos")]
    {
        // Files downloaded by an app get a quarantine flag that would block running it.
        let _ = Command::new("xattr").args(["-d", "com.apple.quarantine"]).arg(&target).output();
    }
    let t = target.clone();
    let v = tauri::async_runtime::spawn_blocking(move || version(&t))
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    Ok(v.unwrap_or_else(|| "installed".into()))
}

#[tauri::command]
pub async fn pick_download_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|_| Error::msg("That folder cannot be used."))?;
    let s = path.to_string_lossy().into_owned();
    let saved = s.clone();
    state.update_settings(move |st| st.download_dir = Some(saved))?;
    Ok(Some(s))
}

pub fn valid_url(u: &str) -> bool {
    match url::Url::parse(u.trim()) {
        Ok(p) => (p.scheme() == "https" || p.scheme() == "http") && p.host_str().is_some() && u.len() < 2000,
        Err(_) => false,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    title: String,
    channel: String,
    duration: Option<f64>,
    thumbnail: Option<String>,
    is_playlist: bool,
    entries: Vec<String>,
    entry_count: usize,
}

pub fn summarize(v: &Value) -> Probe {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let entries: Vec<String> = v
        .get("entries")
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|e| e.get("title").and_then(Value::as_str).unwrap_or("?").to_string()).collect())
        .unwrap_or_default();
    Probe {
        title: s("title"),
        channel: [s("channel"), s("uploader"), s("playlist_uploader")].into_iter().find(|x| !x.is_empty()).unwrap_or_default(),
        duration: v.get("duration").and_then(Value::as_f64),
        thumbnail: v
            .get("thumbnail")
            .and_then(Value::as_str)
            .map(String::from)
            .or_else(|| v.get("thumbnails").and_then(Value::as_array).and_then(|t| t.last()).and_then(|t| t.get("url")).and_then(Value::as_str).map(String::from)),
        is_playlist: v.get("_type").and_then(Value::as_str) == Some("playlist"),
        entry_count: entries.len(),
        entries: entries.into_iter().take(200).collect(),
    }
}

#[tauri::command]
pub async fn dl_probe(state: State<'_, AppState>, url: String) -> Result<Probe> {
    if !valid_url(&url) {
        return Err(Error::msg("Paste a full web address starting with https://"));
    }
    let bin = locate(&state).ok_or_else(|| Error::msg("yt-dlp is not installed yet. Press “Install yt-dlp”."))?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(bin);
        cmd.args(["--ignore-config", "--no-warnings", "-J", "--flat-playlist", "--"])
            .arg(url.trim())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_window(&mut cmd);
        cmd.output()
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(Error::msg(err.lines().rev().find(|l| l.contains("ERROR")).unwrap_or("yt-dlp could not read that address.").replace("ERROR: ", "")));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| Error::msg("yt-dlp gave an unexpected answer."))?;
    Ok(summarize(&v))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DlRequest {
    pub url: String,
    /// "video" | "audio"
    pub kind: String,
    /// 2160 | 1440 | 1080 | 720 | 480
    pub max_height: u32,
    /// video: "mp4" | "mkv"; audio: "m4a" | "mp3" | "opus" | "flac"
    pub format: String,
    pub subtitles: bool,
    /// e.g. ["en", "nl"]
    pub sub_langs: Vec<String>,
    pub sponsorblock: bool,
    pub playlist: bool,
    /// "title" | "channel" | "series"
    pub naming: String,
    pub series_name: Option<String>,
    pub season: Option<u32>,
}

/// yt-dlp output templates use %(...)s; a literal % must be doubled.
fn tpl_text(s: &str) -> String {
    crate::naming::sanitize(s).replace('%', "%%")
}

/// Builds the yt-dlp command line (without the program). Pure, unit tested.
pub fn build_args(r: &DlRequest, folder: &Path, ffmpeg: Option<&Path>) -> Result<Vec<String>> {
    if !valid_url(&r.url) {
        return Err(Error::msg("Paste a full web address starting with https://"));
    }
    let mut a: Vec<String> = ["--ignore-config", "--newline", "--no-mtime", "--windows-filenames", "--no-overwrites", "--continue"]
        .map(String::from)
        .to_vec();
    a.push("--progress-template".into());
    a.push("download:MH|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s".into());
    a.push(if r.playlist { "--yes-playlist" } else { "--no-playlist" }.into());
    match r.kind.as_str() {
        "video" => {
            let h = match r.max_height {
                2160 | 1440 | 1080 | 720 | 480 => r.max_height,
                _ => 1080,
            };
            let fmt = if r.format == "mkv" { "mkv" } else { "mp4" };
            a.extend(["-f".into(), "bv*+ba/b".into(), "-S".into()]);
            a.push(if fmt == "mp4" { format!("res:{h},vcodec:h264,acodec:aac") } else { format!("res:{h}") });
            a.extend(["--merge-output-format".into(), fmt.into(), "--embed-metadata".into(), "--embed-chapters".into()]);
            if r.subtitles {
                a.extend(["--write-subs".into(), "--embed-subs".into()]);
            }
        }
        "audio" => {
            let fmt = match r.format.as_str() {
                "mp3" | "opus" | "flac" | "m4a" => r.format.as_str(),
                _ => "m4a",
            };
            a.extend(["-f".into(), "ba/b".into(), "-x".into(), "--audio-format".into(), fmt.into(), "--audio-quality".into(), "0".into()]);
            a.extend(["--embed-metadata".into(), "--embed-thumbnail".into()]);
        }
        _ => return Err(Error::msg("Unknown download type.")),
    }
    if r.subtitles && r.kind == "video" {
        let langs: Vec<String> = r
            .sub_langs
            .iter()
            .filter(|l| (2..=3).contains(&l.len()) && l.chars().all(|c| c.is_ascii_lowercase()))
            .map(|l| format!("{l}.*"))
            .collect();
        a.extend(["--sub-langs".into(), if langs.is_empty() { "en.*".into() } else { langs.join(",") }]);
    }
    if r.sponsorblock {
        a.extend(["--sponsorblock-remove".into(), "sponsor,selfpromo,interaction".into()]);
    }
    let out = match r.naming.as_str() {
        "channel" => "%(channel,uploader)s/%(title)s [%(id)s].%(ext)s".to_string(),
        "series" => {
            let name = r.series_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| Error::msg("Give the series a name."))?;
            let show = tpl_text(name);
            let s = r.season.unwrap_or(1).min(99);
            format!("{show}/Season {s:02}/{show} - S{s:02}E%(playlist_index|0)02d - %(title)s.%(ext)s")
        }
        _ => "%(title)s [%(id)s].%(ext)s".to_string(),
    };
    a.extend(["-P".into(), folder.to_string_lossy().into_owned(), "-o".into(), out]);
    if let Some(f) = ffmpeg {
        a.extend(["--ffmpeg-location".into(), f.to_string_lossy().into_owned()]);
    }
    a.push("--".into());
    a.push(r.url.trim().to_string());
    Ok(a)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlEvent {
    id: u64,
    /// "progress" | "status" | "done" | "failed" | "cancelled"
    kind: &'static str,
    percent: Option<f32>,
    speed: Option<String>,
    eta: Option<String>,
    text: Option<String>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Mutex<Child>>>> {
    static J: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parses one progress line from our template: "MH|  45.3%|1.20MiB/s|00:12".
pub fn parse_progress(line: &str) -> Option<(Option<f32>, String, String)> {
    let rest = line.trim().strip_prefix("MH|")?;
    let mut p = rest.split('|');
    let pct = p.next()?.trim().trim_end_matches('%').trim().parse::<f32>().ok();
    let speed = p.next().unwrap_or("").trim().to_string();
    let eta = p.next().unwrap_or("").trim().to_string();
    Some((pct, speed, eta))
}

#[tauri::command]
pub async fn dl_start(app: AppHandle, state: State<'_, AppState>, req: DlRequest) -> Result<u64> {
    let settings = state.settings()?;
    let folder = settings
        .download_dir
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .ok_or_else(|| Error::msg("Choose a download folder first."))?;
    let bin = locate(&state).ok_or_else(|| Error::msg("yt-dlp is not installed yet."))?;
    let ffmpeg = media_tools::locate_ffmpeg(settings.ffmpeg_path.as_deref());
    let args = build_args(&req, &folder, ffmpeg.as_deref())?;

    static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();
    let id = {
        let mut n = NEXT.get_or_init(|| Mutex::new(0)).lock().map_err(|_| Error::msg("internal error"))?;
        *n += 1;
        *n
    };

    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::msg(format!("Could not start yt-dlp: {e}")))?;
    let stdout = child.stdout.take().ok_or_else(|| Error::msg("no output"))?;
    let stderr = child.stderr.take().ok_or_else(|| Error::msg("no output"))?;
    let child = Arc::new(Mutex::new(child));
    jobs().lock().map_err(|_| Error::msg("internal error"))?.insert(id, child.clone());

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let errs = errors.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if line.contains("ERROR") {
                if let Ok(mut e) = errs.lock() {
                    e.push(line.replace("ERROR: ", ""));
                }
            }
        }
    });
    std::thread::spawn(move || {
        let emit = |e: DlEvent| {
            let _ = app.emit("dl-event", e);
        };
        for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            if let Some((percent, speed, eta)) = parse_progress(&line) {
                emit(DlEvent { id, kind: "progress", percent, speed: Some(speed), eta: Some(eta), text: None });
            } else if line.starts_with('[') {
                emit(DlEvent { id, kind: "status", percent: None, speed: None, eta: None, text: Some(line.chars().take(300).collect()) });
            }
        }
        let status = child.lock().ok().and_then(|mut c| c.wait().ok());
        let was_cancelled = jobs().lock().map(|mut j| j.remove(&id).is_none()).unwrap_or(false);
        let (kind, text) = match status {
            _ if was_cancelled => ("cancelled", None),
            Some(s) if s.success() => ("done", None),
            _ => ("failed", errors.lock().ok().and_then(|e| e.last().cloned()).or(Some("yt-dlp stopped with an error.".into()))),
        };
        emit(DlEvent { id, kind, percent: None, speed: None, eta: None, text });
    });
    Ok(id)
}

#[tauri::command]
pub fn dl_cancel(id: u64) -> Result<()> {
    let job = jobs().lock().map_err(|_| Error::msg("internal error"))?.remove(&id);
    if let Some(c) = job {
        if let Ok(mut c) = c.lock() {
            let _ = c.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> DlRequest {
        DlRequest {
            url: "https://www.youtube.com/watch?v=abc".into(),
            kind: "video".into(),
            max_height: 1080,
            format: "mp4".into(),
            subtitles: true,
            sub_langs: vec!["en".into(), "nl".into(), "bad;rm".into()],
            sponsorblock: false,
            playlist: false,
            naming: "title".into(),
            series_name: None,
            season: None,
        }
    }

    #[test]
    fn builds_safe_arguments() {
        let a = build_args(&req(), Path::new("/dl"), None).unwrap();
        assert_eq!(a[0], "--ignore-config");
        assert_eq!(a[a.len() - 2], "--", "the address must come after -- so it can't be read as an option");
        assert!(a.contains(&"en.*,nl.*".to_string()));
        assert!(!a.iter().any(|x| x.contains("bad")));
        assert!(a.contains(&"res:1080,vcodec:h264,acodec:aac".to_string()));
    }

    #[test]
    fn series_naming_makes_jellyfin_style_names() {
        let mut r = req();
        r.naming = "series".into();
        r.series_name = Some("Little 100% Club".into());
        r.season = Some(2);
        r.playlist = true;
        let a = build_args(&r, Path::new("/dl"), None).unwrap();
        let o = &a[a.iter().position(|x| x == "-o").unwrap() + 1];
        assert_eq!(o, "Little 100%% Club/Season 02/Little 100%% Club - S02E%(playlist_index|0)02d - %(title)s.%(ext)s");
        r.series_name = None;
        assert!(build_args(&r, Path::new("/dl"), None).is_err());
    }

    #[test]
    fn rejects_non_web_addresses() {
        let mut r = req();
        r.url = "--exec rm -rf ~".into();
        assert!(build_args(&r, Path::new("/dl"), None).is_err());
        r.url = "file:///etc/passwd".into();
        assert!(build_args(&r, Path::new("/dl"), None).is_err());
    }

    #[test]
    fn audio_mode() {
        let mut r = req();
        r.kind = "audio".into();
        r.format = "exe".into();
        let a = build_args(&r, Path::new("/dl"), None).unwrap();
        assert!(a.windows(2).any(|w| w[0] == "--audio-format" && w[1] == "m4a"));
        assert!(!a.contains(&"--write-subs".to_string()));
    }

    #[test]
    fn reads_progress_and_checksums() {
        assert_eq!(parse_progress("MH|  45.3%|1.20MiB/s|00:12"), Some((Some(45.3), "1.20MiB/s".into(), "00:12".into())));
        assert_eq!(parse_progress("[download] something"), None);
        let sums = "aaaa  yt-dlp\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  yt-dlp_macos\n";
        assert_eq!(checksum_for(sums, "yt-dlp_macos").unwrap().len(), 64);
        assert_eq!(checksum_for(sums, "yt-dlp"), None, "malformed hash is refused");
    }

    #[test]
    fn summarizes_playlists() {
        let v = serde_json::json!({"_type": "playlist", "title": "Season 1", "uploader": "Kids TV", "entries": [{"title": "A"}, {"title": "B"}]});
        let p = summarize(&v);
        assert!(p.is_playlist);
        assert_eq!((p.entry_count, p.channel.as_str()), (2, "Kids TV"));
    }
}
