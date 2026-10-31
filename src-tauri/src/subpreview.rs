//! Subtitle preview: the lines of a subtitle file, and short clips of the video (with sound) to
//! check them against. Only reads; saving the chosen timing is `sublock::subtitle_lock`.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::state::AppState;
use crate::subsync::parse_subs;
use crate::{local, media_tools};
use serde::Serialize;
use serde_json::Value;
use std::process::{Command, Stdio};
use tauri::State;

#[derive(Serialize)]
pub struct Line {
    s: f64,
    e: f64,
    t: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubPreview {
    /// Length of the video in seconds (0 when Jellyfin doesn't know).
    duration: f64,
    lines: Vec<Line>,
    /// Four moments worth checking: start, early, middle, late (each the start of a line).
    spots: Vec<f64>,
    file: String,
}

/// Strips the formatting tags people never see ({\an8}, <i>, <font …>).
pub(crate) fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut depth_angle = false;
    let mut depth_curly = false;
    for ch in text.chars() {
        match ch {
            '<' => depth_angle = true,
            '>' if depth_angle => depth_angle = false,
            '{' => depth_curly = true,
            '}' if depth_curly => depth_curly = false,
            _ if depth_angle || depth_curly => {}
            _ => out.push(ch),
        }
    }
    out.trim().to_string()
}

/// Lines nearest to 3 %, 25 %, 55 % and 85 % of the way through.
pub(crate) fn pick_spots(starts: &[f64], duration: f64) -> Vec<f64> {
    if starts.is_empty() {
        return vec![];
    }
    let end = if duration > 0.0 { duration } else { starts[starts.len() - 1] };
    let mut out: Vec<f64> = Vec::new();
    for share in [0.03, 0.25, 0.55, 0.85] {
        let want = end * share;
        let best = starts.iter().copied().min_by(|a, b| (a - want).abs().total_cmp(&(b - want).abs())).unwrap_or(0.0);
        if !out.iter().any(|o| (o - best).abs() < 1.0) {
            out.push(best);
        }
    }
    out
}

#[tauri::command]
pub async fn subtitle_preview(state: State<'_, AppState>, id: String, path: String) -> Result<SubPreview> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let sub = crate::sublock::resolve_sub(&state, &path)?;
    let lower = sub.to_string_lossy().to_lowercase();
    if !(lower.ends_with(".srt") || lower.ends_with(".vtt")) {
        return Err(Error::msg("Only SRT and VTT subtitles can be previewed."));
    }
    let item = state.reader().await?.item_json(&id).await?;
    let duration = item.get("RunTimeTicks").and_then(Value::as_f64).map(|t| t / 10_000_000.0).unwrap_or(0.0);
    let raw = std::fs::read(&sub)?;
    let (cues, _) = parse_subs(&String::from_utf8_lossy(&raw));
    if cues.is_empty() {
        return Err(Error::msg("This subtitle file has no lines Media Hub can read."));
    }
    let lines: Vec<Line> = cues.iter().take(6000).map(|c| Line { s: c.start, e: c.end, t: plain(&c.text) }).filter(|l| !l.t.is_empty()).collect();
    let starts: Vec<f64> = lines.iter().map(|l| l.s).collect();
    Ok(SubPreview { duration, spots: pick_spots(&starts, duration), lines, file: sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() })
}

/// A short, small clip of the video with sound, as base64 MP4 (the window plays it from memory).
#[tauri::command]
pub async fn video_clip(state: State<'_, AppState>, id: String, start: f64, seconds: f64) -> Result<String> {
    if !valid_item_id(&id) || !start.is_finite() || !seconds.is_finite() {
        return Err(Error::msg("bad clip"));
    }
    let item = state.reader().await?.item_json(&id).await?;
    let video = local::to_local(&state, item.get("Path").and_then(Value::as_str).unwrap_or(""))?;
    let ff = media_tools::locate_ffmpeg(state.settings()?.ffmpeg_path.as_deref()).ok_or_else(|| Error::msg("The preview needs ffmpeg (Settings → Tools)."))?;
    let dir = state.dir.join("tmp");
    std::fs::create_dir_all(&dir)?;
    let out = dir.join(format!("clip-{id}.mp4"));
    let (start, seconds) = (start.max(0.0), seconds.clamp(2.0, 20.0));
    let o = out.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
        let mut cmd = Command::new(&ff);
        cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"])
            .args(["-ss", &format!("{start:.3}"), "-t", &format!("{seconds:.3}")])
            .arg("-i")
            .arg(&video)
            .args(["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", "scale=854:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart"])
            .arg(&o)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        media_tools::hide_window(&mut cmd);
        let r = cmd.output().map_err(|e| Error::msg(format!("Could not start ffmpeg: {e}")))?;
        if !r.status.success() {
            let why = String::from_utf8_lossy(&r.stderr);
            return Err(Error::msg(format!("ffmpeg could not make the clip: {}", why.lines().last().unwrap_or("unknown error"))));
        }
        let b = std::fs::read(&o)?;
        let _ = std::fs::remove_file(&o); // our own temporary file
        Ok(b)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_removed() {
        assert_eq!(plain("{\\an8}<i>Hello</i> <font color=\"red\">there</font>"), "Hello there");
        assert_eq!(plain("a < b"), "a");
    }

    #[test]
    fn spots_spread_out() {
        let starts: Vec<f64> = (0..100).map(|i| i as f64 * 30.0).collect();
        let s = pick_spots(&starts, 3000.0);
        assert_eq!(s, vec![90.0, 750.0, 1650.0, 2550.0]);
        assert_eq!(pick_spots(&[5.0], 0.0), vec![5.0]);
    }
}
