//! Downloads with yt-dlp (the Goblin module): videos and music, plus "custom series"
//! (a YouTube channel or playlist saved as Show/Season 01/Show - S01E01 - Title).
//!
//! THIS FILE IS SHARED: the standalone Goblin app and Media Hub use the exact same copy.
//! Change it in one, copy it to the other. It only needs these from the app around it:
//! `error::{Error, Result}`, `state::AppState` (`dir`, `settings()`, `update_settings()`),
//! `Settings { download_dir, ffmpeg_path, cookies_browser }`, `media_tools::locate_ffmpeg`
//! and `naming::sanitize`.
//!
//! Safety: yt-dlp is started directly (never through a shell) with a fixed set of
//! options built here; user config files are ignored; only http(s) addresses are accepted;
//! files can only be written inside the chosen download folder; the address always comes
//! after `--`, so it can never be read as an option.
//!
//! Helper programs: ffmpeg, ffprobe and deno are used from inside the app when it ships
//! them (next to its own executable), otherwise from the usual install places.

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

/// Browsers yt-dlp can borrow sign-in cookies from (for age-restricted or "confirm you're not a bot" videos).
pub const COOKIE_BROWSERS: &[&str] = &["brave", "chrome", "chromium", "edge", "firefox", "opera", "safari", "vivaldi"];

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
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A helper program shipped inside the app, next to its own executable.
fn beside_app(name: &str) -> Option<PathBuf> {
    let p = std::env::current_exe().ok()?.parent()?.join(exe_name(name));
    p.is_file().then_some(p)
}

/// A program on PATH or in the usual install places. (Apps started from the Dock or the
/// Start menu do not see the shell's PATH, so common locations are checked by name.)
fn on_path(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        dirs.push(PathBuf::from(home).join(".deno").join("bin"));
    }
    let exe = exe_name(name);
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
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
    on_path("yt-dlp")
}

/// ffmpeg: the one chosen in Settings, then the one inside the app, then a system one.
fn locate_ffmpeg(custom: Option<&str>) -> Option<PathBuf> {
    custom
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| beside_app("ffmpeg"))
        .or_else(|| media_tools::locate_ffmpeg(None))
}

/// deno runs YouTube's player code for yt-dlp (needed for the full list of qualities).
fn locate_deno() -> Option<PathBuf> {
    beside_app("deno").or_else(|| on_path("deno"))
}

fn version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.args(["--ignore-config", "--version"]).stdin(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

/// Everything around yt-dlp that changes how it runs, gathered once per download.
#[derive(Debug, Clone, Default)]
pub struct Tools {
    pub ffmpeg: Option<PathBuf>,
    pub deno: Option<PathBuf>,
    pub cookies_browser: Option<String>,
}

fn tools(state: &AppState) -> Result<Tools> {
    let s = state.settings()?;
    Ok(Tools {
        ffmpeg: locate_ffmpeg(s.ffmpeg_path.as_deref()),
        deno: locate_deno(),
        cookies_browser: s.cookies_browser.filter(|b| COOKIE_BROWSERS.contains(&b.as_str())),
    })
}

/// Options every yt-dlp run gets: no user config, our helper programs, cookies if chosen.
pub fn base_args(t: &Tools) -> Vec<String> {
    let mut a: Vec<String> = vec!["--ignore-config".into(), "--no-colors".into()];
    if let Some(d) = &t.deno {
        a.extend(["--no-js-runtimes".into(), "--js-runtimes".into(), format!("deno:{}", d.to_string_lossy())]);
    }
    if let Some(b) = t.cookies_browser.as_deref().filter(|b| COOKIE_BROWSERS.contains(b)) {
        a.extend(["--cookies-from-browser".into(), b.to_string()]);
    }
    a
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolState {
    path: Option<String>,
    version: Option<String>,
    managed: bool,
    folder: Option<String>,
    ffmpeg: Option<String>,
    deno: Option<String>,
    cookies: Option<String>,
}

#[tauri::command]
pub async fn ytdlp_info(state: State<'_, AppState>) -> Result<ToolState> {
    let p = locate(&state);
    let managed = p.as_ref().map(|p| *p == own_copy(&state)).unwrap_or(false);
    let s = state.settings()?;
    let t = tools(&state)?;
    let pp = p.clone();
    let version = tauri::async_runtime::spawn_blocking(move || pp.as_deref().and_then(version))
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    let show = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    Ok(ToolState {
        path: show(p),
        version,
        managed,
        folder: s.download_dir,
        ffmpeg: show(t.ffmpeg),
        deno: show(t.deno),
        cookies: t.cookies_browser,
    })
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
        .user_agent("Goblin/1.0")
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
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        if running_count() > 0 {
            Error::msg("yt-dlp is busy with a download. Update again when the downloads have finished.")
        } else {
            Error::Io(e)
        }
    })?;
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

/// `None` switches cookies off.
#[tauri::command]
pub fn dl_set_cookies(state: State<'_, AppState>, browser: Option<String>) -> Result<()> {
    let b = browser.map(|b| b.trim().to_lowercase()).filter(|b| !b.is_empty());
    if let Some(b) = &b {
        if !COOKIE_BROWSERS.contains(&b.as_str()) {
            return Err(Error::msg("That browser is not supported."));
        }
    }
    state.update_settings(move |s| s.cookies_browser = b)
}

pub fn valid_url(u: &str) -> bool {
    match url::Url::parse(u.trim()) {
        Ok(p) => (p.scheme() == "https" || p.scheme() == "http") && p.host_str().is_some() && u.len() < 2000,
        Err(_) => false,
    }
}

/// An ERROR line from yt-dlp in plain words: "ERROR: [youtube] abc: Private video. Sign in…"
/// becomes "Private video. Sign in…".
pub fn friendly_error(line: &str) -> String {
    let t = line.trim();
    let t = t.strip_prefix("ERROR:").map(str::trim_start).unwrap_or(t);
    let t = match t.strip_prefix('[').and_then(|r| r.split_once("] ")) {
        Some((_, rest)) => match rest.split_once(": ") {
            // "[youtube] <id>: message"; ids have no spaces.
            Some((id, msg)) if !id.contains(' ') && !msg.is_empty() => msg,
            _ => rest,
        },
        None => t,
    };
    t.chars().take(300).collect()
}

/// The last ERROR line yt-dlp wrote, in plain words.
fn last_error(stderr: &[u8], fallback: &str) -> String {
    let err = String::from_utf8_lossy(stderr);
    err.lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .map(friendly_error)
        .unwrap_or_else(|| fallback.to_string())
}

fn run_json(state: &AppState, args: Vec<String>, fallback: &'static str) -> Result<Value> {
    let bin = locate(state).ok_or_else(|| Error::msg("yt-dlp is not installed yet. Press “Install yt-dlp”."))?;
    let mut cmd = Command::new(bin);
    cmd.args(base_args(&tools(state)?))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::msg(format!("Could not start yt-dlp: {e}")))?;
    if !out.status.success() {
        return Err(Error::msg(last_error(&out.stderr, fallback)));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| Error::msg("yt-dlp gave an unexpected answer."))
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

fn best_thumb(v: &Value) -> Option<String> {
    v.get("thumbnail")
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| v.get("thumbnails").and_then(Value::as_array).and_then(|t| t.last()).and_then(|t| t.get("url")).and_then(Value::as_str).map(String::from))
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
        thumbnail: best_thumb(v),
        is_playlist: v.get("_type").and_then(Value::as_str) == Some("playlist"),
        entry_count: entries.len(),
        entries: entries.into_iter().take(200).collect(),
    }
}

#[tauri::command]
pub async fn dl_probe(app: AppHandle, url: String) -> Result<Probe> {
    if !valid_url(&url) {
        return Err(Error::msg("Paste a full web address starting with https://"));
    }
    let v = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        run_json(&state, vec!["--no-warnings".into(), "-J".into(), "--flat-playlist".into(), "--".into(), url.trim().to_string()], "yt-dlp could not read that address.")
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    Ok(summarize(&v))
}

// ------------------------------------------------------------------ search

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub url: String,
    pub title: String,
    pub channel: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

/// What yt-dlp should read for a search: YouTube Music's song search, or YouTube's video search.
pub fn search_target(query: &str, kind: &str) -> Result<String> {
    let q = query.split_whitespace().collect::<Vec<_>>().join(" ");
    if q.is_empty() {
        return Err(Error::msg("Type something to search for."));
    }
    if q.chars().count() > 200 {
        return Err(Error::msg("That search is too long."));
    }
    Ok(match kind {
        "songs" => format!("https://music.youtube.com/search?q={}#songs", url::form_urlencoded::byte_serialize(q.as_bytes()).collect::<String>()),
        _ => format!("ytsearch20:{q}"),
    })
}

/// Turns yt-dlp's flat search listing into result rows. Songs link to YouTube Music, so the
/// download gets the artist, album and square cover from there.
pub fn parse_hits(v: &Value, kind: &str) -> Vec<Hit> {
    let Some(entries) = v.get("entries").and_then(Value::as_array) else { return Vec::new() };
    entries
        .iter()
        .filter_map(|e| {
            let id = e.get("id").and_then(Value::as_str).filter(|id| id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))?;
            let s = |k: &str| e.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
            let artists = e
                .get("artists")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            let title = s("title");
            if title.is_empty() {
                return None;
            }
            Some(Hit {
                url: if kind == "songs" { format!("https://music.youtube.com/watch?v={id}") } else { format!("https://www.youtube.com/watch?v={id}") },
                title,
                channel: [artists, s("artist"), s("channel"), s("uploader")].into_iter().find(|x| !x.is_empty()).unwrap_or_default(),
                duration: e.get("duration").and_then(Value::as_f64),
                thumbnail: best_thumb(e).filter(|t| t.starts_with("https://")).or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"))),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn dl_search(app: AppHandle, query: String, kind: String) -> Result<Vec<Hit>> {
    let target = search_target(&query, &kind)?;
    let v = tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        run_json(
            &state,
            vec!["--no-warnings".into(), "-J".into(), "--flat-playlist".into(), "--playlist-end".into(), "20".into(), "--".into(), target],
            "The search did not work. Try again in a moment.",
        )
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    Ok(parse_hits(&v, &kind))
}

// ------------------------------------------------------------------ downloading

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

/// YouTube's auto-made album playlists ("OLAK5uy_…"): their order is the track order.
pub fn is_album_playlist(url: &str) -> bool {
    url.contains("list=OLAK5uy_")
}

/// Builds the yt-dlp command line (without the program). Pure, unit tested.
pub fn build_args(r: &DlRequest, folder: &Path, t: &Tools) -> Result<Vec<String>> {
    if !valid_url(&r.url) {
        return Err(Error::msg("Paste a full web address starting with https://"));
    }
    let mut a = base_args(t);
    a.extend(
        [
            "--newline", "--no-mtime", "--windows-filenames", "--no-overwrites", "--continue",
            // --print below would otherwise switch on quiet + simulate mode.
            "--no-quiet", "--progress", "--no-simulate",
            "-N", "4", "--socket-timeout", "20", "--retries", "5", "--fragment-retries", "10",
        ]
        .map(String::from),
    );
    a.push("--progress-template".into());
    a.push("download:MH|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.playlist_index|)s|%(info.n_entries|)s".into());
    a.extend(["--print".into(), "before_dl:MHT|%(title)s".into(), "--print".into(), "after_move:MHF|%(filepath)s".into()]);
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
            a.extend(["--embed-thumbnail".into(), "--convert-thumbnails".into(), "jpg".into()]);
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
            a.extend(["--embed-metadata".into(), "--embed-thumbnail".into(), "--convert-thumbnails".into(), "jpg".into()]);
            // YouTube pictures are 16:9 with the cover in the middle: cut them square.
            a.extend(["--ppa".into(), r"ThumbnailsConvertor+ffmpeg_o:-vf crop='min(iw\,ih)':'min(iw\,ih)'".into()]);
            if r.playlist && is_album_playlist(&r.url) {
                a.extend(["--parse-metadata".into(), "%(playlist_index|)s:%(track_number)s".into()]);
            }
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
    let out = match (r.naming.as_str(), r.kind.as_str()) {
        ("channel", "audio") => "%(artist,channel,uploader)s/%(title)s.%(ext)s".to_string(),
        ("channel", _) => "%(channel,uploader)s/%(title)s [%(id)s].%(ext)s".to_string(),
        ("series", _) => {
            let name = r.series_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| Error::msg("Give the series a name."))?;
            let show = tpl_text(name);
            let s = r.season.unwrap_or(1).min(99);
            format!("{show}/Season {s:02}/{show} - S{s:02}E%(playlist_index|0)02d - %(title)s.%(ext)s")
        }
        // "Daft Punk - Get Lucky" when YouTube knows the artist, otherwise just the title.
        (_, "audio") => "%(artist&{} - |)s%(title)s.%(ext)s".to_string(),
        _ => "%(title)s [%(id)s].%(ext)s".to_string(),
    };
    a.extend(["-P".into(), folder.to_string_lossy().into_owned(), "-o".into(), out]);
    if let Some(f) = &t.ffmpeg {
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
    /// "progress" | "status" | "title" | "file" | "done" | "failed" | "cancelled"
    kind: &'static str,
    percent: Option<f32>,
    speed: Option<String>,
    eta: Option<String>,
    /// Playlists: "3/12"
    item: Option<String>,
    text: Option<String>,
}

impl DlEvent {
    fn new(id: u64, kind: &'static str) -> Self {
        DlEvent { id, kind, percent: None, speed: None, eta: None, item: None, text: None }
    }
}

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Mutex<Child>>>> {
    static J: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Child>>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

fn running_count() -> usize {
    jobs().lock().map(|j| j.len()).unwrap_or(0)
}

#[derive(Debug, PartialEq)]
pub struct Progress {
    pub percent: Option<f32>,
    pub speed: String,
    pub eta: String,
    pub item: Option<String>,
}

/// Parses one progress line from our template: "MH|  45.3%|1.20MiB/s|00:12|3|12".
pub fn parse_progress(line: &str) -> Option<Progress> {
    let rest = line.trim().strip_prefix("MH|")?;
    let mut p = rest.split('|');
    let clean = |s: Option<&str>| {
        let s = s.unwrap_or("").trim();
        if s.is_empty() || s.contains("Unknown") || s == "NA" { String::new() } else { s.to_string() }
    };
    let percent = p.next()?.trim().trim_end_matches('%').trim().parse::<f32>().ok();
    let speed = clean(p.next());
    let eta = clean(p.next());
    let index = clean(p.next());
    let count = clean(p.next());
    let item = (!index.is_empty()).then(|| if count.is_empty() { index.clone() } else { format!("{index}/{count}") });
    Some(Progress { percent, speed, eta, item })
}

/// Stops a download and everything it started (yt-dlp itself, ffmpeg, ...).
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        // dl_start puts each download in its own process group.
        let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).status();
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut c);
        let _ = c.status();
    }
    let _ = child.kill();
}

/// Called when the app quits: nothing keeps running in the background.
pub fn kill_all() {
    let all: Vec<_> = jobs().lock().map(|mut j| j.drain().map(|(_, c)| c).collect()).unwrap_or_default();
    for c in all {
        if let Ok(mut c) = c.lock() {
            kill_tree(&mut c);
        }
    }
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
    let args = build_args(&req, &folder, &tools(&state)?)?;

    static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();
    let id = {
        let mut n = NEXT.get_or_init(|| Mutex::new(0)).lock().map_err(|_| Error::msg("internal error"))?;
        *n += 1;
        *n
    };

    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| Error::msg(format!("Could not start yt-dlp: {e}")))?;
    let stdout = child.stdout.take().ok_or_else(|| Error::msg("no output"))?;
    let stderr = child.stderr.take().ok_or_else(|| Error::msg("no output"))?;
    let child = Arc::new(Mutex::new(child));
    jobs().lock().map_err(|_| Error::msg("internal error"))?.insert(id, child.clone());

    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let errs = errors.clone();
    let err_reader = std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if line.contains("ERROR") {
                if let Ok(mut e) = errs.lock() {
                    e.push(friendly_error(&line));
                }
            }
        }
    });
    std::thread::spawn(move || {
        let emit = |e: DlEvent| {
            let _ = app.emit("dl-event", e);
        };
        let mut files = 0usize;
        for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
            if let Some(p) = parse_progress(&line) {
                emit(DlEvent { percent: p.percent, speed: Some(p.speed), eta: Some(p.eta), item: p.item, ..DlEvent::new(id, "progress") });
            } else if let Some(t) = line.strip_prefix("MHT|") {
                emit(DlEvent { text: Some(t.chars().take(300).collect()), ..DlEvent::new(id, "title") });
            } else if let Some(f) = line.strip_prefix("MHF|") {
                files += 1;
                emit(DlEvent { text: Some(f.to_string()), ..DlEvent::new(id, "file") });
            } else if line.starts_with('[') && !line.starts_with("[download]") {
                emit(DlEvent { text: Some(line.chars().take(300).collect()), ..DlEvent::new(id, "status") });
            } else if line.contains("has already been downloaded") || line.contains("has already been recorded") {
                emit(DlEvent { text: Some("Already downloaded".into()), ..DlEvent::new(id, "status") });
            }
        }
        let _ = err_reader.join();
        let status = child.lock().ok().and_then(|mut c| c.wait().ok());
        let was_cancelled = jobs().lock().map(|mut j| j.remove(&id).is_none()).unwrap_or(false);
        let last = errors.lock().ok().and_then(|e| e.last().cloned());
        let (kind, text) = match status {
            _ if was_cancelled => ("cancelled", None),
            Some(s) if s.success() => ("done", None),
            // A playlist where some videos failed (private, removed) but others were saved.
            _ if files > 0 => ("done", Some(format!("Finished with problems: {}", last.unwrap_or_default()))),
            _ => ("failed", last.or(Some("yt-dlp stopped with an error.".into()))),
        };
        emit(DlEvent { text, ..DlEvent::new(id, kind) });
    });
    Ok(id)
}

#[tauri::command]
pub fn dl_cancel(id: u64) -> Result<()> {
    let job = jobs().lock().map_err(|_| Error::msg("internal error"))?.remove(&id);
    if let Some(c) = job {
        if let Ok(mut c) = c.lock() {
            kill_tree(&mut c);
        }
    }
    Ok(())
}

/// Shows a downloaded file (or, without a path, the download folder) in Finder / Explorer.
/// Only places inside the download folder can be opened.
#[tauri::command]
pub fn dl_reveal(state: State<'_, AppState>, path: Option<String>) -> Result<()> {
    let folder = state
        .settings()?
        .download_dir
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
        .ok_or_else(|| Error::msg("Choose a download folder first."))?;
    let (target, select) = match path {
        Some(p) => {
            let c = PathBuf::from(p).canonicalize().map_err(|_| Error::msg("That file is no longer there."))?;
            if !c.starts_with(&folder) {
                return Err(Error::msg("Only files in the download folder can be shown."));
            }
            (c, true)
        }
        None => (folder, false),
    };
    show_in_file_manager(&target, select);
    Ok(())
}

fn show_in_file_manager(p: &Path, select: bool) {
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        if select {
            c.arg("-R");
        }
        let _ = c.arg(p).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let s = p.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&*s).to_string();
        let mut c = Command::new("explorer");
        if select {
            c.raw_arg(format!("/select,\"{s}\""));
        } else {
            c.arg(&s);
        }
        let _ = c.spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if select { p.parent().unwrap_or(p) } else { p };
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
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

    fn out_template(a: &[String]) -> &str {
        &a[a.iter().position(|x| x == "-o").unwrap() + 1]
    }

    #[test]
    fn builds_safe_arguments() {
        let a = build_args(&req(), Path::new("/dl"), &Tools::default()).unwrap();
        assert_eq!(a[0], "--ignore-config");
        assert_eq!(a[a.len() - 2], "--", "the address must come after -- so it can't be read as an option");
        assert!(a.contains(&"en.*,nl.*".to_string()));
        assert!(!a.iter().any(|x| x.contains("bad")));
        assert!(a.contains(&"res:1080,vcodec:h264,acodec:aac".to_string()));
        assert!(a.contains(&"--no-simulate".to_string()), "--print must not switch downloads off");
    }

    #[test]
    fn helper_programs_and_cookies() {
        let t = Tools {
            ffmpeg: Some(PathBuf::from("/app/ffmpeg")),
            deno: Some(PathBuf::from("/app/deno")),
            cookies_browser: Some("firefox".into()),
        };
        let a = build_args(&req(), Path::new("/dl"), &t).unwrap();
        assert!(a.windows(2).any(|w| w[0] == "--js-runtimes" && w[1] == "deno:/app/deno"));
        assert!(a.windows(2).any(|w| w[0] == "--ffmpeg-location" && w[1] == "/app/ffmpeg"));
        assert!(a.windows(2).any(|w| w[0] == "--cookies-from-browser" && w[1] == "firefox"));
        let bad = Tools { cookies_browser: Some("--exec".into()), ..Tools::default() };
        assert!(!build_args(&req(), Path::new("/dl"), &bad).unwrap().iter().any(|x| x == "--cookies-from-browser"));
    }

    #[test]
    fn series_naming_makes_jellyfin_style_names() {
        let mut r = req();
        r.naming = "series".into();
        r.series_name = Some("Little 100% Club".into());
        r.season = Some(2);
        r.playlist = true;
        let a = build_args(&r, Path::new("/dl"), &Tools::default()).unwrap();
        assert_eq!(out_template(&a), "Little 100%% Club/Season 02/Little 100%% Club - S02E%(playlist_index|0)02d - %(title)s.%(ext)s");
        r.series_name = None;
        assert!(build_args(&r, Path::new("/dl"), &Tools::default()).is_err());
    }

    #[test]
    fn rejects_non_web_addresses() {
        let mut r = req();
        r.url = "--exec rm -rf ~".into();
        assert!(build_args(&r, Path::new("/dl"), &Tools::default()).is_err());
        r.url = "file:///etc/passwd".into();
        assert!(build_args(&r, Path::new("/dl"), &Tools::default()).is_err());
    }

    #[test]
    fn audio_mode() {
        let mut r = req();
        r.kind = "audio".into();
        r.format = "exe".into();
        let a = build_args(&r, Path::new("/dl"), &Tools::default()).unwrap();
        assert!(a.windows(2).any(|w| w[0] == "--audio-format" && w[1] == "m4a"));
        assert!(!a.contains(&"--write-subs".to_string()));
        assert_eq!(out_template(&a), "%(artist&{} - |)s%(title)s.%(ext)s");
        assert!(a.iter().any(|x| x.starts_with("ThumbnailsConvertor+ffmpeg_o:")), "covers are cut square");
        assert!(!a.contains(&"--parse-metadata".to_string()));
        r.playlist = true;
        r.url = "https://music.youtube.com/playlist?list=OLAK5uy_abc".into();
        let a = build_args(&r, Path::new("/dl"), &Tools::default()).unwrap();
        assert!(a.contains(&"--parse-metadata".to_string()), "album playlists get track numbers");
    }

    #[test]
    fn reads_progress_and_checksums() {
        assert_eq!(
            parse_progress("MH|  45.3%|1.20MiB/s|00:12|3|12"),
            Some(Progress { percent: Some(45.3), speed: "1.20MiB/s".into(), eta: "00:12".into(), item: Some("3/12".into()) })
        );
        assert_eq!(
            parse_progress("MH|  1.1%| Unknown B/s|Unknown||"),
            Some(Progress { percent: Some(1.1), speed: String::new(), eta: String::new(), item: None })
        );
        assert_eq!(parse_progress("MH|  45.3%|1.20MiB/s|00:12").map(|p| p.item), Some(None), "older format still reads");
        assert_eq!(parse_progress("[download] something"), None);
        assert_eq!(parse_progress("MHF|/dl/a.mp4"), None);
        let sums = "aaaa  yt-dlp\n0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  yt-dlp_macos\n";
        assert_eq!(checksum_for(sums, "yt-dlp_macos").unwrap().len(), 64);
        assert_eq!(checksum_for(sums, "yt-dlp"), None, "malformed hash is refused");
    }

    #[test]
    fn plain_error_text() {
        assert_eq!(
            friendly_error("ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access"),
            "Private video. Sign in if you've been granted access"
        );
        assert_eq!(friendly_error("ERROR: Unable to download webpage: timed out"), "Unable to download webpage: timed out");
        assert_eq!(friendly_error("ERROR: [generic] Unsupported URL: https://x.y"), "Unsupported URL: https://x.y");
    }

    #[test]
    fn summarizes_playlists() {
        let v = serde_json::json!({"_type": "playlist", "title": "Season 1", "uploader": "Kids TV", "entries": [{"title": "A"}, {"title": "B"}]});
        let p = summarize(&v);
        assert!(p.is_playlist);
        assert_eq!((p.entry_count, p.channel.as_str()), (2, "Kids TV"));
    }

    #[test]
    fn search_targets_and_results() {
        assert_eq!(search_target("  daft   punk ", "videos").unwrap(), "ytsearch20:daft punk");
        assert_eq!(search_target("get lucky & more", "songs").unwrap(), "https://music.youtube.com/search?q=get+lucky+%26+more#songs");
        assert!(search_target("   ", "songs").is_err());
        let v = serde_json::json!({"entries": [
            {"id": "5NV6Rdv1a3I", "title": "Get Lucky", "artists": ["Daft Punk", "Pharrell Williams"], "duration": 369.0,
             "thumbnails": [{"url": "https://lh3.googleusercontent.com/x=w120"}, {"url": "https://lh3.googleusercontent.com/x=w544"}]},
            {"id": "not-an-id", "title": "Channel row"},
            {"id": "dQw4w9WgXcQ", "title": "", "channel": "Somebody"}
        ]});
        let hits = parse_hits(&v, "songs");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://music.youtube.com/watch?v=5NV6Rdv1a3I");
        assert_eq!(hits[0].channel, "Daft Punk, Pharrell Williams");
        assert_eq!(hits[0].thumbnail.as_deref(), Some("https://lh3.googleusercontent.com/x=w544"));
        let v = serde_json::json!({"entries": [{"id": "dQw4w9WgXcQ", "title": "Video", "channel": "Chan"}]});
        let hits = parse_hits(&v, "videos");
        assert_eq!(hits[0].url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        assert_eq!(hits[0].thumbnail.as_deref(), Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"));
    }
}
