//! Storage tools: shrink movies to H.265 using this computer's graphics chip, and even out
//! loudness by changing gain only (no compression). Both run ffmpeg locally and write the
//! result next to the original on the NAS.
//!
//! Safety: the original is never deleted by a job. When the new file checks out (right
//! length, has video, and for H.265 is actually smaller) the original moves into a hidden
//! ".mediahub-trash" folder in the library, and the swap is journaled so it can be undone.

use crate::error::{Error, Result};
use crate::fsops::safe_rel;
use crate::media_tools;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};

pub const TRASH: &str = ".mediahub-trash";

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// ffprobe ships next to ffmpeg.
pub fn ffprobe_for(ffmpeg: &Path) -> PathBuf {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    ffmpeg.with_file_name(name)
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub duration: f64,
    pub size: u64,
    pub bitrate: u64,
    pub video_codec: String,
    pub width: u64,
    pub height: u64,
    pub hdr: bool,
    pub audio_codec: String,
    pub audio_channels: u64,
    pub audio_streams: usize,
}

pub fn parse_probe(v: &Value) -> MediaInfo {
    let streams: Vec<&Value> = v.get("streams").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let is = |s: &&Value, t: &str| s.get("codec_type").and_then(Value::as_str) == Some(t);
    let video = streams
        .iter()
        .find(|s| is(s, "video") && s.get("disposition").and_then(|d| d.get("attached_pic")).and_then(Value::as_i64) != Some(1));
    let audio = streams.iter().find(|s| is(s, "audio"));
    let fmt = v.get("format");
    let num = |x: Option<&Value>| -> f64 {
        x.and_then(|y| y.as_f64().or_else(|| y.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0.0)
    };
    let s = |x: Option<&&Value>, k: &str| x.and_then(|y| y.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let transfer = s(video, "color_transfer");
    MediaInfo {
        duration: num(fmt.and_then(|f| f.get("duration"))),
        size: num(fmt.and_then(|f| f.get("size"))) as u64,
        bitrate: num(fmt.and_then(|f| f.get("bit_rate"))) as u64,
        video_codec: s(video, "codec_name"),
        width: video.and_then(|x| x.get("width")).and_then(Value::as_u64).unwrap_or(0),
        height: video.and_then(|x| x.get("height")).and_then(Value::as_u64).unwrap_or(0),
        hdr: transfer == "smpte2084" || transfer == "arib-std-b67",
        audio_codec: s(audio, "codec_name"),
        audio_channels: audio.and_then(|x| x.get("channels")).and_then(Value::as_u64).unwrap_or(0),
        audio_streams: streams.iter().filter(|x| is(x, "audio")).count(),
    }
}

fn probe(ffprobe: &Path, file: &Path) -> Result<MediaInfo> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::msg(format!("Could not start ffprobe: {e}")))?;
    if !out.status.success() {
        return Err(Error::msg("ffprobe could not read this file."));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|_| Error::msg("ffprobe gave an unexpected answer."))?;
    Ok(parse_probe(&v))
}

fn probe_json(ffprobe: &Path, file: &Path) -> Result<Value> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::msg(format!("Could not start ffprobe: {e}")))?;
    if !out.status.success() {
        return Err(Error::msg("ffprobe could not read this file."));
    }
    serde_json::from_slice(&out.stdout).map_err(|_| Error::msg("ffprobe gave an unexpected answer."))
}

/// An audio or subtitle track inside a video file.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub index: i64,
    /// "audio" | "subtitle"
    pub kind: String,
    pub language: String,
    pub codec: String,
    pub title: String,
    pub channels: u64,
    pub default: bool,
    /// In a language you don't keep (and not the original audio): can be taken out.
    pub extra: bool,
}

/// Tracks from ffprobe's JSON (stream index = position in the file).
pub fn probe_tracks(v: &Value) -> Vec<Track> {
    v.get("streams")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|st| {
                    let kind = match st.get("codec_type").and_then(Value::as_str)? {
                        "audio" => "audio",
                        "subtitle" => "subtitle",
                        _ => return None,
                    };
                    let tag = |k: &str| st.get("tags").and_then(|t| t.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
                    Some(Track {
                        index: st.get("index").and_then(Value::as_i64)?,
                        kind: kind.into(),
                        language: tag("language"),
                        codec: st.get("codec_name").and_then(Value::as_str).unwrap_or("").into(),
                        title: tag("title"),
                        channels: st.get("channels").and_then(Value::as_u64).unwrap_or(0),
                        default: st.get("disposition").and_then(|d| d.get("default")).and_then(Value::as_i64) == Some(1),
                        extra: false,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Marks the tracks that can go: audio and subtitles in languages you don't keep. The
/// original audio (the default track, else the first) and untagged tracks always stay, so a
/// file never ends up without sound.
pub fn mark_extra(tracks: &mut [Track], keep: &[String]) {
    let keep: std::collections::HashSet<String> = keep.iter().map(|k| crate::cleanup::lang_family(k)).collect();
    let original = tracks
        .iter()
        .find(|t| t.kind == "audio" && t.default)
        .or_else(|| tracks.iter().find(|t| t.kind == "audio"))
        .map(|t| t.index);
    let original_lang = tracks.iter().find(|t| Some(t.index) == original).map(|t| crate::cleanup::lang_family(&t.language));
    for t in tracks.iter_mut() {
        let fam = crate::cleanup::lang_family(&t.language);
        let same_as_original = t.kind == "audio" && original_lang.as_deref() == Some(fam.as_str());
        t.extra = !keep.is_empty() && Some(t.index) != original && !same_as_original && crate::cleanup::is_extra(&t.language, &keep);
    }
}

/// ffmpeg arguments for a copy without the given track indexes (nothing re-encoded).
pub fn strip_args(input: &Path, output: &Path, drop: &[i64]) -> Vec<String> {
    let ext = out_ext(&input.to_string_lossy());
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
        .map(String::from)
        .to_vec();
    a.push(input.to_string_lossy().into_owned());
    a.extend(["-map", "0:v", "-map", "0:a?", "-map", "0:s?"].map(String::from));
    if ext == "mkv" {
        a.extend(["-map".into(), "0:t?".into()]);
    }
    for i in drop {
        a.extend(["-map".into(), format!("-0:{i}")]);
    }
    a.extend(["-c".into(), "copy".into()]);
    if ext == "mp4" {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.push(output.to_string_lossy().into_owned());
    a
}

/// Size per hour of video against what's usual for that picture size: rows that are much
/// bigger than the median of their resolution (and over 2 GB) are "unusually big".
/// Input per row: (height, GB per hour, bytes).
pub fn big_flags(rows: &[(u64, f64, u64)]) -> Vec<bool> {
    fn bucket(h: u64) -> usize {
        match h {
            h if h >= 1600 => 3,
            h if h >= 900 => 2,
            h if h >= 600 => 1,
            _ => 0,
        }
    }
    // Typical GB per hour when there are too few files to compare with.
    const USUAL: [f64; 4] = [1.2, 2.5, 5.0, 16.0];
    let mut per: [Vec<f64>; 4] = Default::default();
    for (h, g, _) in rows {
        if *g > 0.0 {
            per[bucket(*h)].push(*g);
        }
    }
    let median: Vec<f64> = per
        .iter_mut()
        .enumerate()
        .map(|(i, v)| {
            if v.len() < 5 {
                return USUAL[i];
            }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            v[v.len() / 2]
        })
        .collect();
    rows.iter().map(|(h, g, size)| *size > 2_000_000_000 && *g > median[bucket(*h)] * 1.8).collect()
}

fn tools(state: &AppState) -> Result<(PathBuf, PathBuf)> {
    let ff = media_tools::locate_ffmpeg(state.settings()?.ffmpeg_path.as_deref())
        .ok_or_else(|| Error::msg("ffmpeg was not found. See Settings → Tools."))?;
    let fp = ffprobe_for(&ff);
    if !fp.is_file() {
        return Err(Error::msg("ffprobe was not found next to ffmpeg."));
    }
    Ok((ff, fp))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRow {
    rel: String,
    info: Option<MediaInfo>,
    problem: Option<String>,
}

#[tauri::command]
pub async fn storage_scan(state: State<'_, AppState>, folder: String) -> Result<Vec<FileRow>> {
    let root = state.library_root()?;
    let (_, fp) = tools(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let files = crate::fsops::scan_files(&root, &folder, true)?;
        let mut out = Vec::new();
        for rel in files.into_iter().filter(|f| crate::naming::is_video(f)).take(1000) {
            let path = root.join(safe_rel(&rel)?);
            match probe(&fp, &path) {
                Ok(info) => out.push(FileRow { rel, info: Some(info), problem: None }),
                Err(e) => out.push(FileRow { rel, info: None, problem: Some(e.to_string()) }),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?
}

/// One video as Jellyfin knows it, for the storage overview (no file is opened).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewRow {
    id: String,
    name: String,
    /// Path inside the library folder ("" when it can't be mapped).
    rel: String,
    folder: String,
    size: u64,
    duration: f64,
    bitrate: u64,
    codec: String,
    width: u64,
    height: u64,
    hdr: bool,
    gb_per_hour: f64,
    big: bool,
    can_shrink: bool,
    tracks: Vec<Track>,
}

fn jf_tracks(streams: &[Value]) -> Vec<Track> {
    streams
        .iter()
        .filter_map(|st| {
            let kind = match st.get("Type").and_then(Value::as_str)? {
                "Audio" => "audio",
                // Subtitle files next to the video are not inside it.
                "Subtitle" if !st.get("IsExternal").and_then(Value::as_bool).unwrap_or(false) => "subtitle",
                _ => return None,
            };
            let txt = |k: &str| st.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            Some(Track {
                index: st.get("Index").and_then(Value::as_i64)?,
                kind: kind.into(),
                language: txt("Language"),
                codec: txt("Codec"),
                title: txt("DisplayTitle"),
                channels: st.get("Channels").and_then(Value::as_u64).unwrap_or(0),
                default: st.get("IsDefault").and_then(Value::as_bool).unwrap_or(false),
                extra: false,
            })
        })
        .collect()
}

/// Every video with size, codec and tracks, straight from Jellyfin (fast: no file is read).
/// `keep` = languages you keep, to mark audio and subtitle tracks that could go.
#[tauri::command]
pub async fn storage_overview(state: State<'_, AppState>, keep: Vec<String>) -> Result<Vec<OverviewRow>> {
    let items = state
        .reader()
        .await?
        .items_query(
            vec![
                ("IncludeItemTypes", "Movie,Episode".into()),
                ("Recursive", "true".into()),
                ("Fields", "MediaSources,Path".into()),
                ("EnableImages", "false".into()),
                ("EnableUserData", "false".into()),
            ],
            100_000,
        )
        .await?;
    let settings = state.settings()?;
    let root = settings.library_root.clone();
    let map = settings.path_map.clone();
    let mut rows: Vec<OverviewRow> = Vec::new();
    for v in &items {
        let id = v.get("Id").and_then(Value::as_str).unwrap_or("").replace('-', "");
        let Some(src) = v.get("MediaSources").and_then(Value::as_array).and_then(|a| a.first()) else { continue };
        let streams: Vec<Value> = src.get("MediaStreams").and_then(Value::as_array).cloned().unwrap_or_default();
        let video = streams.iter().find(|x| x.get("Type").and_then(Value::as_str) == Some("Video"));
        let path = src.get("Path").and_then(Value::as_str).or_else(|| v.get("Path").and_then(Value::as_str)).unwrap_or("");
        let rel = root
            .as_deref()
            .filter(|_| map.is_some())
            .and_then(|r| media_tools::map_path(path, map.as_ref(), Some(Path::new(r))).map(|(p, _)| (r, p)))
            .and_then(|(r, p)| crate::local::rel_to_root(Path::new(r), &p))
            .unwrap_or_default();
        let size = src.get("Size").and_then(Value::as_u64).unwrap_or(0);
        let ticks = src.get("RunTimeTicks").or_else(|| v.get("RunTimeTicks")).and_then(Value::as_f64).unwrap_or(0.0);
        let duration = ticks / 10_000_000.0;
        let name = if v.get("Type").and_then(Value::as_str) == Some("Episode") {
            let se = v.get("ParentIndexNumber").and_then(Value::as_i64).unwrap_or(0);
            let ep = v.get("IndexNumber").and_then(Value::as_i64).unwrap_or(0);
            format!("{} · S{se:02}E{ep:02} · {}", v.get("SeriesName").and_then(Value::as_str).unwrap_or(""), v.get("Name").and_then(Value::as_str).unwrap_or(""))
        } else {
            v.get("Name").and_then(Value::as_str).unwrap_or("").to_string()
        };
        let codec = video.and_then(|x| x.get("Codec")).and_then(Value::as_str).unwrap_or("").to_lowercase();
        let range = video.and_then(|x| x.get("VideoRange")).and_then(Value::as_str).unwrap_or("SDR");
        let hdr = range != "SDR" && !range.is_empty();
        let mut tracks = jf_tracks(&streams);
        mark_extra(&mut tracks, &keep);
        rows.push(OverviewRow {
            folder: rel.split('/').next().unwrap_or("").to_string(),
            id,
            name,
            rel,
            size,
            duration,
            bitrate: src.get("Bitrate").and_then(Value::as_u64).unwrap_or(0),
            width: video.and_then(|x| x.get("Width")).and_then(Value::as_u64).unwrap_or(0),
            height: video.and_then(|x| x.get("Height")).and_then(Value::as_u64).unwrap_or(0),
            gb_per_hour: if duration > 60.0 { size as f64 / 1e9 / (duration / 3600.0) } else { 0.0 },
            big: false,
            can_shrink: !hdr && codec != "hevc" && codec != "av1" && !codec.is_empty(),
            codec,
            hdr,
            tracks,
        });
    }
    let flags = big_flags(&rows.iter().map(|r| (r.height, r.gb_per_hour, r.size)).collect::<Vec<_>>());
    for (r, b) in rows.iter_mut().zip(flags) {
        r.big = b;
    }
    rows.sort_by(|a, b| b.size.cmp(&a.size));
    Ok(rows)
}

/// Which H.265 encoders this ffmpeg has, best first.
#[tauri::command]
pub async fn hevc_encoders(state: State<'_, AppState>) -> Result<Vec<String>> {
    let (ff, _) = tools(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(ff);
        cmd.args(["-hide_banner", "-encoders"]).stdin(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut cmd);
        let out = cmd.output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
        ["hevc_videotoolbox", "hevc_nvenc", "hevc_amf", "hevc_qsv", "libx265"]
            .iter()
            .filter(|e| out.split_whitespace().any(|w| w == **e))
            .map(|e| e.to_string())
            .collect()
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub rel: String,
    /// "hevc" | "loudness"
    pub mode: String,
    /// for hevc
    pub encoder: Option<String>,
    /// 1 (smallest) ..= 5 (best quality)
    pub quality: Option<u8>,
    /// for loudness, LUFS (e.g. -20)
    pub target_lufs: Option<f64>,
    /// for strip: languages to keep (the original audio and untagged tracks always stay)
    #[serde(default)]
    pub keep_langs: Vec<String>,
    /// for strip: take out audio tracks in other languages
    #[serde(default)]
    pub strip_audio: bool,
    /// for strip: take out built-in subtitles in other languages
    #[serde(default)]
    pub strip_subs: bool,
}

/// Output container: keep mp4/mkv as they are, everything else becomes mkv.
pub fn out_ext(input: &str) -> &'static str {
    match crate::naming::split_ext(input).1.to_lowercase().as_str() {
        "mp4" | "m4v" => "mp4",
        _ => "mkv",
    }
}

fn encoder_args(encoder: &str, quality: u8) -> Result<Vec<String>> {
    let q = quality.clamp(1, 5) as i32;
    let v: Vec<String> = match encoder {
        // Apple chips: quality 1..100
        "hevc_videotoolbox" => vec!["-c:v:0".into(), encoder.into(), "-q:v".into(), (45 + q * 5).to_string()],
        "hevc_nvenc" => vec![
            "-c:v:0".into(), encoder.into(), "-preset".into(), "p5".into(), "-rc".into(), "vbr".into(),
            "-cq".into(), (30 - q * 2).to_string(), "-b:v".into(), "0".into(), "-spatial-aq".into(), "1".into(),
        ],
        "hevc_amf" => vec!["-c:v:0".into(), encoder.into(), "-quality".into(), "quality".into(), "-rc".into(), "cqp".into(), "-qp_i".into(), (30 - q * 2).to_string(), "-qp_p".into(), (32 - q * 2).to_string()],
        "hevc_qsv" => vec!["-c:v:0".into(), encoder.into(), "-global_quality".into(), (30 - q * 2).to_string()],
        "libx265" => vec!["-c:v:0".into(), encoder.into(), "-crf".into(), (28 - q * 2).to_string(), "-preset".into(), "medium".into()],
        _ => return Err(Error::msg("Unknown encoder.")),
    };
    Ok(v)
}

fn maps(ext: &str) -> Vec<String> {
    let mut m: Vec<String> = ["-map", "0:v:0", "-map", "0:a?", "-map", "0:s?"].map(String::from).to_vec();
    if ext == "mkv" {
        m.extend(["-map".into(), "0:t?".into()]); // fonts for styled subtitles
    }
    m
}

/// ffmpeg arguments for an H.265 copy (audio and subtitles copied untouched).
pub fn hevc_args(input: &Path, output: &Path, encoder: &str, quality: u8) -> Result<Vec<String>> {
    let ext = out_ext(&input.to_string_lossy());
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
        .map(String::from)
        .to_vec();
    a.push(input.to_string_lossy().into_owned());
    a.extend(maps(ext));
    a.extend(["-c".into(), "copy".into()]);
    a.extend(encoder_args(encoder, quality)?);
    a.extend(["-tag:v".into(), "hvc1".into(), "-max_muxing_queue_size".into(), "4096".into()]);
    if ext == "mp4" {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.push(output.to_string_lossy().into_owned());
    Ok(a)
}

/// Gain to reach the target, limited so peaks stay at or below -1 dBTP, and to ±12 dB.
pub fn gain_for(measured_lufs: f64, true_peak_db: f64, target: f64) -> f64 {
    let wanted = target - measured_lufs;
    let headroom = -1.0 - true_peak_db;
    (wanted.min(headroom)).clamp(-12.0, 12.0)
}

/// Reads integrated loudness and true peak from ffmpeg's ebur128 summary.
pub fn parse_ebur128(stderr: &str) -> Option<(f64, f64)> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    let grab = |label: &str| -> Option<f64> {
        summary.lines().find_map(|l| {
            let t = l.trim();
            let rest = t.strip_prefix(label)?;
            rest.split_whitespace().next()?.parse::<f64>().ok()
        })
    };
    Some((grab("I:")?, grab("Peak:")?))
}

fn audio_codec_args(codec: &str, channels: u64) -> Vec<String> {
    let (c, b) = match codec {
        "ac3" => ("ac3", "640k"),
        "eac3" => ("eac3", "768k"),
        "aac" if channels > 2 => ("aac", "512k"),
        _ => ("aac", if channels > 2 { "512k" } else { "256k" }),
    };
    vec!["-c:a".into(), c.into(), "-b:a".into(), b.into()]
}

/// ffmpeg arguments that change only the volume (video and subtitles copied untouched).
pub fn loudness_args(input: &Path, output: &Path, gain_db: f64, info: &MediaInfo) -> Vec<String> {
    let ext = out_ext(&input.to_string_lossy());
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", "-i"]
        .map(String::from)
        .to_vec();
    a.push(input.to_string_lossy().into_owned());
    a.extend(maps(ext));
    a.extend(["-c".into(), "copy".into()]);
    a.extend(audio_codec_args(&info.audio_codec, info.audio_channels));
    a.extend(["-filter:a".into(), format!("volume={gain_db:.2}dB")]);
    if ext == "mp4" {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.push(output.to_string_lossy().into_owned());
    a
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobEvent {
    id: u64,
    kind: &'static str, // "progress" | "status" | "done" | "failed" | "cancelled"
    percent: Option<f32>,
    text: Option<String>,
}

fn jobs() -> &'static Mutex<HashMap<u64, Arc<Mutex<Option<Child>>>>> {
    static J: OnceLock<Mutex<HashMap<u64, Arc<Mutex<Option<Child>>>>>> = OnceLock::new();
    J.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What undo needs to put the original back.
#[derive(Serialize, Deserialize)]
struct SwapRecord {
    root: String,
    original: String,
    trashed: String,
    replacement: String,
}

fn rel_string(p: &Path) -> String {
    p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

fn run_ffmpeg(ff: &Path, args: &[String], duration: f64, child_slot: &Arc<Mutex<Option<Child>>>, on_progress: &dyn Fn(f32)) -> Result<()> {
    let mut cmd = Command::new(ff);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| Error::msg(format!("Could not start ffmpeg: {e}")))?;
    let stdout = child.stdout.take().ok_or_else(|| Error::msg("no output"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| Error::msg("no output"))?;
    *child_slot.lock().map_err(|_| Error::msg("internal error"))? = Some(child);
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stderr, &mut s);
        s
    });
    for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
        if let Some(us) = line.strip_prefix("out_time_us=").or_else(|| line.strip_prefix("out_time_ms=")) {
            if let Ok(v) = us.trim().parse::<f64>() {
                if duration > 0.0 {
                    on_progress(((v / 1_000_000.0) / duration * 100.0).clamp(0.0, 100.0) as f32);
                }
            }
        }
    }
    let status = child_slot
        .lock()
        .map_err(|_| Error::msg("internal error"))?
        .as_mut()
        .map(|c| c.wait())
        .transpose()?;
    let err = err_thread.join().unwrap_or_default();
    match status {
        Some(s) if s.success() => Ok(()),
        _ => Err(Error::msg(err.lines().last().unwrap_or("ffmpeg stopped").to_string())),
    }
}

fn measure_loudness(ff: &Path, input: &Path) -> Result<(f64, f64)> {
    let mut cmd = Command::new(ff);
    cmd.args(["-nostdin", "-hide_banner", "-nostats", "-i"])
        .arg(input)
        .args(["-map", "0:a:0", "-af", "ebur128=peak=true", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::msg(format!("Could not start ffmpeg: {e}")))?;
    parse_ebur128(&String::from_utf8_lossy(&out.stderr)).ok_or_else(|| Error::msg("Could not measure the loudness."))
}

fn job_body(app: &AppHandle, id: u64, req: &JobRequest, slot: &Arc<Mutex<Option<Child>>>) -> Result<String> {
    let state = app.state::<AppState>();
    let root = state.library_root()?;
    let (ff, fp) = tools(&state)?;
    let rel = safe_rel(&req.rel)?;
    let input = root.join(&rel);
    let emit = |kind: &'static str, percent: Option<f32>, text: Option<String>| {
        let _ = app.emit("storage-event", JobEvent { id, kind, percent, text });
    };
    let info = probe(&fp, &input)?;
    if info.video_codec.is_empty() {
        return Err(Error::msg("No video in this file."));
    }
    let ext = out_ext(&req.rel);
    let stem = crate::naming::split_ext(rel.file_name().and_then(|n| n.to_str()).unwrap_or("video")).0.to_string();
    let parent = input.parent().ok_or_else(|| Error::msg("bad path"))?.to_path_buf();
    let temp = parent.join(format!(".mediahub-tmp-{stem}.{ext}"));
    if temp.exists() {
        return Err(Error::msg("A previous run left a temporary file; remove it or try again later."));
    }

    let args = match req.mode.as_str() {
        "hevc" => {
            if info.video_codec == "hevc" {
                return Ok("Already H.265; skipped.".into());
            }
            if info.hdr {
                return Ok("HDR video; skipped to keep the picture exactly as it is.".into());
            }
            hevc_args(&input, &temp, req.encoder.as_deref().unwrap_or("libx265"), req.quality.unwrap_or(3))?
        }
        "loudness" => {
            if info.audio_streams == 0 {
                return Ok("No audio; skipped.".into());
            }
            emit("status", None, Some("Measuring loudness…".into()));
            let (lufs, peak) = measure_loudness(&ff, &input)?;
            let gain = gain_for(lufs, peak, req.target_lufs.unwrap_or(-20.0).clamp(-31.0, -10.0));
            if gain.abs() < 1.0 {
                return Ok(format!("Already fine ({lufs:.1} LUFS); skipped."));
            }
            emit("status", None, Some(format!("Measured {lufs:.1} LUFS, peak {peak:.1} dB; applying {gain:+.1} dB")));
            loudness_args(&input, &temp, gain, &info)
        }
        "strip" => {
            let mut tracks = probe_tracks(&probe_json(&fp, &input)?);
            mark_extra(&mut tracks, &req.keep_langs);
            let drop: Vec<i64> = tracks
                .iter()
                .filter(|t| t.extra && ((t.kind == "audio" && req.strip_audio) || (t.kind == "subtitle" && req.strip_subs)))
                .map(|t| t.index)
                .collect();
            if drop.is_empty() {
                return Ok("Nothing to take out; skipped.".into());
            }
            emit("status", None, Some(format!("Taking out {} track{}", drop.len(), if drop.len() == 1 { "" } else { "s" })));
            strip_args(&input, &temp, &drop)
        }
        _ => return Err(Error::msg("Unknown job.")),
    };

    let res = run_ffmpeg(&ff, &args, info.duration, slot, &|p| emit("progress", Some(p), None));
    if let Err(e) = res {
        let _ = std::fs::remove_file(&temp); // our own temporary file only
        return Err(e);
    }
    // Check the result before touching the original.
    let new = match probe(&fp, &temp) {
        Ok(n) => n,
        Err(e) => {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
    };
    let new_size = std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    let problem = if (new.duration - info.duration).abs() > 2.0 {
        Some("The new file has a different length".to_string())
    } else if new.video_codec.is_empty() {
        Some("The new file has no video".to_string())
    } else if req.mode == "hevc" && new_size >= info.size {
        Some("The H.265 version was not smaller".to_string())
    } else if req.mode == "strip" && new_size >= info.size {
        Some("The new file was not smaller".to_string())
    } else if req.mode == "strip" && info.audio_streams > 0 && new.audio_streams == 0 {
        Some("The new file has no sound".to_string())
    } else {
        None
    };
    if let Some(p) = problem {
        let _ = std::fs::remove_file(&temp);
        return Ok(format!("{p}; kept the original."));
    }

    // Swap: original to the trash folder, new file into its place. Both are moves; nothing is deleted.
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let trash_rel = Path::new(TRASH).join(stamp.to_string()).join(&rel);
    let trash_abs = root.join(&trash_rel);
    std::fs::create_dir_all(trash_abs.parent().expect("parent"))?;
    let final_rel = rel.with_extension(ext);
    let record = SwapRecord {
        root: root.to_string_lossy().into_owned(),
        original: rel_string(&rel),
        trashed: rel_string(&trash_rel),
        replacement: rel_string(&final_rel),
    };
    let rec = serde_json::to_string(&record).map_err(|e| Error::msg(e.to_string()))?;
    let entry = state.store()?.journal_add("storage", &rel_string(&rel), &rec, &req.mode)?;
    if let Err(e) = std::fs::rename(&input, &trash_abs) {
        state.store()?.journal_delete(entry)?;
        let _ = std::fs::remove_file(&temp);
        return Err(e.into());
    }
    let final_abs = root.join(&final_rel);
    if final_abs.exists() {
        // Put things back rather than overwrite anything.
        let _ = std::fs::rename(&trash_abs, &input);
        state.store()?.journal_delete(entry)?;
        let _ = std::fs::remove_file(&temp);
        return Err(Error::msg("A file with the new name already exists; nothing was changed."));
    }
    std::fs::rename(&temp, &final_abs)?;
    let saved = info.size.saturating_sub(new_size);
    Ok(if req.mode == "hevc" || req.mode == "strip" {
        format!("Done: {:.1} GB saved. The original is in {TRASH} until you empty it.", saved as f64 / 1e9)
    } else {
        "Done. The original is in the trash folder until you empty it.".to_string()
    })
}

#[tauri::command]
pub fn storage_start(app: AppHandle, req: JobRequest) -> Result<u64> {
    static NEXT: OnceLock<Mutex<u64>> = OnceLock::new();
    let id = {
        let mut n = NEXT.get_or_init(|| Mutex::new(0)).lock().map_err(|_| Error::msg("internal error"))?;
        *n += 1;
        *n
    };
    safe_rel(&req.rel)?;
    let slot = Arc::new(Mutex::new(None));
    jobs().lock().map_err(|_| Error::msg("internal error"))?.insert(id, slot.clone());
    std::thread::spawn(move || {
        let result = job_body(&app, id, &req, &slot);
        let cancelled = jobs().lock().map(|mut j| j.remove(&id).is_none()).unwrap_or(false);
        let ev = match result {
            _ if cancelled => JobEvent { id, kind: "cancelled", percent: None, text: Some("Cancelled".into()) },
            Ok(msg) => JobEvent { id, kind: "done", percent: Some(100.0), text: Some(msg) },
            Err(e) => JobEvent { id, kind: "failed", percent: None, text: Some(e.to_string()) },
        };
        let _ = app.emit("storage-event", ev);
    });
    Ok(id)
}

#[tauri::command]
pub fn storage_cancel(id: u64) -> Result<()> {
    let slot = jobs().lock().map_err(|_| Error::msg("internal error"))?.remove(&id);
    if let Some(s) = slot {
        if let Ok(mut c) = s.lock() {
            if let Some(child) = c.as_mut() {
                let _ = child.kill();
            }
        }
    }
    Ok(())
}

/// Undo of a swap: the new file goes to the trash folder, the original comes back.
pub fn undo_swap(record_json: &str) -> Result<()> {
    let r: SwapRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let root = PathBuf::from(&r.root);
    let (orig, trashed, repl) = (root.join(safe_rel(&r.original)?), root.join(safe_rel(&r.trashed)?), root.join(safe_rel(&r.replacement)?));
    if !trashed.is_file() {
        return Err(Error::msg("The original is no longer in the trash folder."));
    }
    if repl.is_file() {
        let aside = trashed.with_file_name(format!(
            "replaced-{}",
            repl.file_name().and_then(|n| n.to_str()).unwrap_or("file")
        ));
        std::fs::rename(&repl, aside)?;
    }
    if orig.exists() {
        return Err(Error::msg("Something else now has the original name; nothing was changed."));
    }
    std::fs::rename(trashed, orig)?;
    Ok(())
}

#[tauri::command]
pub fn storage_history(state: State<'_, AppState>) -> Result<Vec<crate::store::Change>> {
    state.store()?.changes_by_action("storage", 50)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashInfo {
    files: usize,
    bytes: u64,
}

#[tauri::command]
pub async fn trash_info(state: State<'_, AppState>) -> Result<TrashInfo> {
    let root = state.library_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root.join(TRASH);
        let (mut files, mut bytes) = (0usize, 0u64);
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(e.path());
                } else if ft.is_file() {
                    files += 1;
                    bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
        TrashInfo { files, bytes }
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashFile {
    /// Where it came from in the library.
    rel: String,
    bytes: u64,
    /// When it went into the trash (seconds).
    at: u64,
}

/// What's in the trash folder (biggest first, at most 2000), so you see what Empty removes.
#[tauri::command]
pub async fn trash_list(state: State<'_, AppState>) -> Result<Vec<TrashFile>> {
    let root = state.library_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = root.join(TRASH);
        let mut out = Vec::new();
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    stack.push(e.path());
                } else if ft.is_file() {
                    let meta = e.metadata().ok();
                    let inside = e.path().strip_prefix(&dir).map(rel_string).unwrap_or_default();
                    // "<stamp>/Movies/a.mkv" → "Movies/a.mkv"
                    let rel = inside.split_once('/').map(|(_, r)| r.to_string()).unwrap_or(inside);
                    out.push(TrashFile {
                        rel,
                        bytes: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        at: meta
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                    });
                }
            }
        }
        out.sort_by(|a, b| b.bytes.cmp(&a.bytes));
        out.truncate(2000);
        out
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))
}

/// Permanently deletes the originals kept in the trash folder. Only that folder, only
/// when the user confirms it in the window.
#[tauri::command]
pub async fn trash_empty(state: State<'_, AppState>, confirm: String) -> Result<()> {
    if confirm != "DELETE" {
        return Err(Error::msg("Not confirmed."));
    }
    let root = state.library_root()?;
    let dir = root.join(TRASH);
    let canon_root = root.canonicalize()?;
    if !dir.exists() {
        return Ok(());
    }
    let canon = dir.canonicalize()?;
    if canon.parent() != Some(canon_root.as_path()) || std::fs::symlink_metadata(&dir)?.file_type().is_symlink() {
        return Err(Error::msg("The trash folder is not where it should be; nothing was deleted."));
    }
    tauri::async_runtime::spawn_blocking(move || std::fs::remove_dir_all(canon))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ffprobe_output() {
        let v = serde_json::json!({
            "format": {"duration": "5400.5", "size": "8000000000", "bit_rate": "11850000"},
            "streams": [
                {"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
                {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "color_transfer": "bt709", "disposition": {"attached_pic": 0}},
                {"codec_type": "audio", "codec_name": "eac3", "channels": 6},
                {"codec_type": "audio", "codec_name": "aac", "channels": 2}
            ]
        });
        let i = parse_probe(&v);
        assert_eq!((i.video_codec.as_str(), i.width, i.hdr), ("h264", 1920, false));
        assert_eq!((i.audio_codec.as_str(), i.audio_channels, i.audio_streams), ("eac3", 6, 2));
        assert_eq!(i.size, 8_000_000_000);
        assert!((i.duration - 5400.5).abs() < 0.01);
    }

    #[test]
    fn hevc_arguments_copy_everything_but_video() {
        let a = hevc_args(Path::new("/m/Film.mp4"), Path::new("/m/.mediahub-tmp-Film.mp4"), "hevc_videotoolbox", 3).unwrap();
        assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "copy"));
        assert!(a.windows(2).any(|w| w[0] == "-c:v:0" && w[1] == "hevc_videotoolbox"));
        assert!(a.windows(2).any(|w| w[0] == "-tag:v" && w[1] == "hvc1"));
        assert!(!a.contains(&"0:t?".to_string()), "mp4 cannot hold font attachments");
        assert!(hevc_args(Path::new("/m/a.mkv"), Path::new("/m/b.mkv"), "evil", 3).is_err());
    }

    #[test]
    fn loudness_gain_respects_peaks() {
        assert_eq!(gain_for(-26.0, -10.0, -20.0), 6.0);
        assert_eq!(gain_for(-26.0, -3.0, -20.0), 2.0, "limited by peak headroom");
        assert_eq!(gain_for(-12.0, -0.5, -20.0), -8.0);
        assert_eq!(gain_for(-50.0, -40.0, -20.0), 12.0, "never more than 12 dB");
    }

    #[test]
    fn reads_ebur128_summary() {
        let s = "[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.6 LUFS\n\n  True peak:\n    Peak:       -1.8 dBFS\n";
        assert_eq!(parse_ebur128(s), Some((-23.4, -1.8)));
        assert_eq!(parse_ebur128("no summary"), None);
    }

    #[test]
    fn containers() {
        assert_eq!(out_ext("a.mp4"), "mp4");
        assert_eq!(out_ext("a.avi"), "mkv");
        let i = MediaInfo { audio_codec: "ac3".into(), audio_channels: 6, ..Default::default() };
        let a = loudness_args(Path::new("/m/a.mkv"), Path::new("/m/b.mkv"), 3.0, &i);
        assert!(a.windows(2).any(|w| w[0] == "-c:a" && w[1] == "ac3"));
        assert!(a.contains(&"volume=3.00dB".to_string()));
    }

    #[test]
    fn unusually_big_is_relative_to_resolution() {
        // Ten 1080p files around 3 GB/h, one at 12 GB/h; one 4K at 20 GB/h is normal for 4K.
        let mut rows: Vec<(u64, f64, u64)> = (0..10).map(|i| (1080, 2.8 + i as f64 * 0.05, 6_000_000_000)).collect();
        rows.push((1080, 12.0, 24_000_000_000));
        rows.push((2160, 20.0, 40_000_000_000));
        rows.push((1080, 12.0, 1_500_000_000)); // short: under 2 GB never counts
        let f = big_flags(&rows);
        assert!(!f[0] && !f[9]);
        assert!(f[10], "four times the 1080p median");
        assert!(!f[11], "4K uses its own typical size");
        assert!(!f[12]);
    }

    #[test]
    fn extra_tracks_keep_original_and_your_languages() {
        let v = serde_json::json!({ "streams": [
            {"index": 0, "codec_type": "video", "codec_name": "h264"},
            {"index": 1, "codec_type": "audio", "codec_name": "eac3", "channels": 6, "tags": {"language": "jpn"}, "disposition": {"default": 1}},
            {"index": 2, "codec_type": "audio", "codec_name": "ac3", "tags": {"language": "eng"}, "disposition": {"default": 0}},
            {"index": 3, "codec_type": "audio", "codec_name": "ac3", "tags": {"language": "ita"}},
            {"index": 4, "codec_type": "audio", "codec_name": "ac3"},
            {"index": 5, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "en"}},
            {"index": 6, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "fre"}},
            {"index": 7, "codec_type": "subtitle", "codec_name": "subrip", "tags": {"language": "und"}}
        ]});
        let mut t = probe_tracks(&v);
        assert_eq!(t.len(), 7);
        mark_extra(&mut t, &["eng".into(), "nl".into()]);
        let extra: Vec<i64> = t.iter().filter(|x| x.extra).map(|x| x.index).collect();
        assert_eq!(extra, vec![3, 6], "original Japanese, English, untagged stay");
        // Nothing to keep given: nothing is marked.
        let mut t2 = probe_tracks(&v);
        mark_extra(&mut t2, &[]);
        assert!(t2.iter().all(|x| !x.extra));
    }

    #[test]
    fn strip_arguments_copy_and_drop_by_index() {
        let a = strip_args(Path::new("/m/Film.mkv"), Path::new("/m/.mediahub-tmp-Film.mkv"), &[3, 6]);
        assert!(a.windows(2).any(|w| w[0] == "-c" && w[1] == "copy"));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "-0:3"));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "-0:6"));
        assert!(a.contains(&"0:t?".to_string()));
        assert!(!a.iter().any(|x| x.starts_with("-c:v")), "nothing is re-encoded");
        let m = strip_args(Path::new("/m/a.mp4"), Path::new("/m/b.mp4"), &[2]);
        assert!(!m.contains(&"0:t?".to_string()));
        assert_eq!(m.last().unwrap(), "/m/b.mp4");
    }

    #[test]
    fn undo_puts_the_original_back() {
        let root = std::env::temp_dir().join(format!("mediahub-swap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".mediahub-trash/1/Movies")).unwrap();
        std::fs::create_dir_all(root.join("Movies")).unwrap();
        std::fs::write(root.join(".mediahub-trash/1/Movies/a.avi"), b"orig").unwrap();
        std::fs::write(root.join("Movies/a.mkv"), b"new").unwrap();
        let rec = serde_json::to_string(&SwapRecord {
            root: root.to_string_lossy().into_owned(),
            original: "Movies/a.avi".into(),
            trashed: ".mediahub-trash/1/Movies/a.avi".into(),
            replacement: "Movies/a.mkv".into(),
        })
        .unwrap();
        undo_swap(&rec).unwrap();
        assert_eq!(std::fs::read(root.join("Movies/a.avi")).unwrap(), b"orig");
        assert!(!root.join("Movies/a.mkv").exists());
        assert!(root.join(".mediahub-trash/1/Movies/replaced-a.mkv").exists(), "new file kept aside, not deleted");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
