//! Subtitle timing fixer: lines a subtitle file up with the speech in the video.
//!
//! The audio is read on this computer (ffmpeg), turned into "someone is talking" per 100 ms,
//! and compared with when the subtitle shows text. The best shift (and, for subtitles made
//! for a 25 fps or 23.976 fps version, the best speed) wins. The original file is kept in
//! the app's backup folder, so the fix can be undone.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::media_tools;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const FRAME: f64 = 0.1; // seconds per step

#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start: f64,
    pub end: f64,
    /// Everything of the cue except its timing line (index line for SRT kept separately).
    pub text: String,
}

fn parse_time(t: &str) -> Option<f64> {
    let t = t.trim().replace(',', ".");
    let parts: Vec<&str> = t.split(':').collect();
    let (h, m, s) = match parts.len() {
        3 => (parts[0].parse::<f64>().ok()?, parts[1].parse::<f64>().ok()?, parts[2].parse::<f64>().ok()?),
        2 => (0.0, parts[0].parse::<f64>().ok()?, parts[1].parse::<f64>().ok()?),
        _ => return None,
    };
    Some(h * 3600.0 + m * 60.0 + s)
}

fn fmt_time(t: f64, comma: bool) -> String {
    let ms = (t.max(0.0) * 1000.0).round() as u64;
    let (h, m, s, f) = (ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60, ms % 1000);
    format!("{h:02}:{m:02}:{s:02}{}{f:03}", if comma { ',' } else { '.' })
}

/// Reads SRT or WebVTT. Returns the cues and whether it was VTT.
/// How much audio is listened to (seconds).
const LISTEN_SECS: f64 = 1800.0;

pub fn parse_subs(text: &str) -> (Vec<Cue>, bool) {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let vtt = text.starts_with("WEBVTT");
    let mut cues = Vec::new();
    for block in text.split("\n\n") {
        let lines: Vec<&str> = block.lines().collect();
        let Some(pos) = lines.iter().position(|l| l.contains("-->")) else { continue };
        let (a, b) = lines[pos].split_once("-->").unwrap_or(("", ""));
        let b = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_time(a), parse_time(b)) else { continue };
        cues.push(Cue { start, end, text: lines[pos + 1..].join("\n") });
    }
    (cues, vtt)
}

pub fn write_subs(cues: &[Cue], vtt: bool) -> String {
    let mut out = String::new();
    if vtt {
        out.push_str("WEBVTT\n\n");
    }
    for (i, c) in cues.iter().enumerate() {
        if !vtt {
            out.push_str(&format!("{}\n", i + 1));
        }
        out.push_str(&format!("{} --> {}\n{}\n\n", fmt_time(c.start, !vtt), fmt_time(c.end, !vtt), c.text));
    }
    out
}

/// "Talking" per 100 ms frame from mono samples: louder than the quiet parts of the film.
pub fn speech_frames(samples: &[i16], rate: u32) -> Vec<bool> {
    let per = ((rate as f64) * FRAME) as usize;
    if per == 0 {
        return Vec::new();
    }
    let energy: Vec<f64> = samples
        .chunks(per)
        .map(|c| (c.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / c.len().max(1) as f64).sqrt())
        .collect();
    let mut sorted = energy.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let q = |p: f64| sorted.get(((sorted.len() as f64 - 1.0) * p) as usize).copied().unwrap_or(0.0);
    let threshold = (q(0.2) * 2.5).max(q(0.55));
    energy.iter().map(|&e| e > threshold && e > 30.0).collect()
}

fn cue_frames(cues: &[Cue], scale: f64, offset: f64, len: usize) -> Vec<usize> {
    let mut out = Vec::new();
    for c in cues {
        let a = ((c.start * scale + offset) / FRAME).floor();
        let b = ((c.end * scale + offset) / FRAME).ceil();
        if b <= 0.0 {
            continue;
        }
        for f in (a.max(0.0) as usize)..(b as usize).min(len) {
            out.push(f);
        }
    }
    out
}

fn overlap(speech: &[bool], cues: &[Cue], scale: f64, offset: f64) -> f64 {
    let frames = cue_frames(cues, scale, offset, speech.len());
    if frames.is_empty() {
        return 0.0;
    }
    frames.iter().filter(|&&f| speech[f]).count() as f64 / frames.len() as f64
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    /// Seconds to add (after scaling).
    pub offset: f64,
    pub scale: f64,
    /// Share of subtitle time that has speech under it, before and after (0..1).
    pub before: f64,
    pub after: f64,
}

/// Searches shifts of ±90 s (coarse, then fine) at three speeds.
pub fn best_fit(speech: &[bool], cues: &[Cue]) -> Fit {
    let before = overlap(speech, cues, 1.0, 0.0);
    let mut best = Fit { offset: 0.0, scale: 1.0, before, after: before };
    for scale in [1.0, 25.0 / 23.976, 23.976 / 25.0] {
        let mut local = (0.0, -1.0);
        let mut o = -90.0;
        while o <= 90.0 {
            let v = overlap(speech, cues, scale, o);
            if v > local.1 {
                local = (o, v);
            }
            o += 0.5;
        }
        let mut f = local.0 - 0.5;
        while f <= local.0 + 0.5 {
            let v = overlap(speech, cues, scale, f);
            if v > local.1 {
                local = (f, v);
            }
            f += FRAME;
        }
        if local.1 > best.after + 0.005 {
            best = Fit { offset: (local.0 * 10.0).round() / 10.0, scale, before, after: local.1 };
        }
    }
    best
}

pub fn apply_fit(cues: &[Cue], fit: &Fit) -> Vec<Cue> {
    cues.iter()
        .map(|c| Cue { start: (c.start * fit.scale + fit.offset).max(0.0), end: (c.end * fit.scale + fit.offset).max(0.0), text: c.text.clone() })
        .filter(|c| c.end > 0.0)
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncOutcome {
    fit: Fit,
    /// True when the change is clear enough to be worth saving.
    sure: bool,
    applied: bool,
    file: String,
}

/// Checks (and with `apply`, fixes) the timing of one external subtitle of an item.
#[tauri::command]
pub async fn subtitle_sync(state: State<'_, AppState>, id: String, index: i64, apply: bool, path: Option<String>) -> Result<SyncOutcome> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let item = state.reader().await?.item_json(&id).await?;
    // A file just downloaded isn't listed by Jellyfin yet: then it comes by its path.
    let sub_path = match path.filter(|p| !p.is_empty()) {
        Some(p) => crate::sublock::resolve_sub(&state, &p)?,
        None => {
            let stream = item
                .get("MediaStreams")
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|s| s.get("Index").and_then(Value::as_i64) == Some(index) && s.get("Type").and_then(Value::as_str) == Some("Subtitle")))
                .cloned()
                .ok_or_else(|| Error::msg("That subtitle isn't there any more."))?;
            if !stream.get("IsExternal").and_then(Value::as_bool).unwrap_or(false) {
                return Err(Error::msg("Only subtitle files next to the video can be fixed (this one is built into the video)."));
            }
            local::to_local(&state, stream.get("Path").and_then(Value::as_str).unwrap_or(""))?
        }
    };
    let lower = sub_path.to_string_lossy().to_lowercase();
    if !(lower.ends_with(".srt") || lower.ends_with(".vtt")) {
        return Err(Error::msg("Only SRT and VTT subtitles can be fixed."));
    }
    let video_server = item.get("Path").and_then(Value::as_str).unwrap_or("").to_string();
    let video_path = local::to_local(&state, &video_server)?;
    let ff = media_tools::locate_ffmpeg(state.settings()?.ffmpeg_path.as_deref()).ok_or_else(|| Error::msg("This needs ffmpeg (Settings → Tools)."))?;
    // The first half hour is plenty to find the shift, and much quicker than the whole film.
    let duration = item.get("RunTimeTicks").and_then(Value::as_f64).map(|t| t / 10_000_000.0).unwrap_or(7200.0).clamp(60.0, LISTEN_SECS);

    let raw = std::fs::read(&sub_path)?;
    let text = String::from_utf8_lossy(&raw).into_owned();
    let (cues, vtt) = parse_subs(&text);
    if cues.len() < 10 {
        return Err(Error::msg("This subtitle has too few lines to line up."));
    }
    let vp = video_path.clone();
    let speech = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<bool>> {
        let samples = media_tools::decode_audio(&ff, &vp, 0.0, duration + 5.0)?;
        Ok(speech_frames(&samples, crate::fingerprint::RATE))
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    let window: Vec<Cue> = cues.iter().filter(|c| c.end < duration).cloned().collect();
    if window.len() < 10 {
        return Err(Error::msg("Too few subtitle lines in the first half hour to line up."));
    }
    let fit = best_fit(&speech, &window);
    let moved = fit.offset.abs() >= 0.3 || (fit.scale - 1.0).abs() > 0.001;
    let sure = moved && fit.after >= 0.45 && fit.after - fit.before >= 0.08;
    let mut applied = false;
    if apply && sure {
        if state.settings()?.read_only {
            return Err(Error::msg("Fixing files needs changes switched on in Settings."));
        }
        let dir = state.dir.join("backups");
        std::fs::create_dir_all(&dir)?;
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let backup = dir.join(format!("{id}-sub{index}-{stamp}.{}", if vtt { "vtt" } else { "srt" }));
        std::fs::write(&backup, &raw)?;
        state.store()?.journal_add(
            "subtitle_timing",
            &id,
            &format!("{}|{}", sub_path.to_string_lossy(), backup.to_string_lossy()),
            &format!("{:+.1} s", fit.offset),
        )?;
        std::fs::write(&sub_path, write_subs(&apply_fit(&cues, &fit), vtt))?;
        applied = true;
        if let Ok(w) = state.writer().await {
            let _ = w.refresh_light(&id).await;
        }
    }
    Ok(SyncOutcome { fit, sure, applied, file: sub_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() })
}

/// Undo for "subtitle_timing": puts the original file back.
pub fn undo_timing(old_value: &str) -> Result<()> {
    let (target, backup) = old_value.split_once('|').ok_or_else(|| Error::msg("bad journal entry"))?;
    let bytes = std::fs::read(backup).map_err(|_| Error::msg("The backup of the subtitle is missing."))?;
    std::fs::write(target, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SRT: &str = "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:05,000 --> 00:00:06,000\n<i>Two</i>\nlines\n\n";

    #[test]
    fn reads_and_writes_srt_and_vtt() {
        let (c, vtt) = parse_subs(SRT);
        assert!(!vtt);
        assert_eq!(c.len(), 2);
        assert_eq!(c[1].text, "<i>Two</i>\nlines");
        assert!((c[0].end - 2.5).abs() < 1e-9);
        let again = write_subs(&c, false);
        assert_eq!(parse_subs(&again).0, c);
        let v = "WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nHi\n\n";
        let (c, vtt) = parse_subs(v);
        assert!(vtt);
        assert_eq!(c.len(), 1);
        assert!(write_subs(&c, true).starts_with("WEBVTT"));
    }

    #[test]
    fn finds_a_shift() {
        // Irregular speech: talking parts of 1–4 s with 1–6 s pauses.
        let mut seed = 7u64;
        let mut rnd = |n: u64| { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) % n };
        let mut speech = vec![false; 9000];
        let mut cues = Vec::new();
        let mut t = 20.0;
        while t < 850.0 {
            let talk = 1.0 + rnd(30) as f64 / 10.0;
            let pause = 1.0 + rnd(50) as f64 / 10.0;
            for f in ((t / FRAME) as usize)..(((t + talk) / FRAME) as usize) {
                speech[f] = true;
            }
            // The subtitle file is 4.2 s early.
            cues.push(Cue { start: t - 4.2, end: t + talk - 4.2, text: "x".into() });
            t += talk + pause;
        }
        let fit = best_fit(&speech, &cues);
        assert!((fit.offset - 4.2).abs() <= 0.15, "offset {}", fit.offset);
        assert!((fit.scale - 1.0).abs() < 1e-9);
        assert!(fit.after > 0.9 && fit.before < 0.7, "{fit:?}");
        let fixed = apply_fit(&cues, &fit);
        assert!((fixed[0].start - 20.0).abs() <= 0.15);
    }

    #[test]
    fn speech_detection_follows_loudness() {
        let rate = 1000;
        let mut s = vec![5i16; 1000];
        s.extend(vec![3000i16; 1000]);
        s.extend(vec![5i16; 1000]);
        let f = speech_frames(&s, rate);
        assert_eq!(f.len(), 30);
        assert!(!f[2] && f[15] && !f[28]);
    }
}
