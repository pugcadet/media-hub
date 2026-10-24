//! Commands for intros & credits: detection on this computer, saving to Jellyfin as
//! media segments (which Infuse and Jellyfin's own apps use for "Skip intro").

use crate::detect::{self, Span, Window, CREDITS_LIMITS, INTRO_LIMITS};
use crate::error::{Error, Result};
use crate::fingerprint::fingerprint;
use crate::jellyfin::{valid_item_id, Writer, TICKS_PER_SECOND};
use crate::media_tools::{self, PathMap};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

/// Provider name the MediaSegments API plugin accepts for segments written by other tools.
const PROVIDER: &str = "Chapter Segments Provider";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seg {
    id: String,
    kind: String,
    start: f64,
    end: f64,
}

fn read_segs(list: &[Value]) -> Vec<Seg> {
    list.iter()
        .map(|s| Seg {
            id: s.get("Id").and_then(Value::as_str).unwrap_or("").to_string(),
            kind: s.get("Type").and_then(Value::as_str).unwrap_or("Unknown").to_string(),
            start: s.get("StartTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND,
            end: s.get("EndTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND,
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeRow {
    id: String,
    name: String,
    index: Option<i64>,
    duration: f64,
    segments: Vec<Seg>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    episodes: Vec<EpisodeRow>,
    ffmpeg: Option<String>,
    can_write_segments: bool,
}

fn reader(state: &AppState) -> Result<crate::jellyfin::Client> {
    state.client()?.ok_or_else(|| Error::msg("Connect to your server first."))
}

#[tauri::command]
pub async fn segments_overview(state: State<'_, AppState>, season_id: String) -> Result<Overview> {
    let c = reader(&state)?;
    let children = c.children(&season_id).await?;
    let mut episodes = Vec::new();
    for e in children.iter().filter(|e| e.get("Type").and_then(Value::as_str) == Some("Episode")) {
        let id = e.get("Id").and_then(Value::as_str).unwrap_or("").to_string();
        if !valid_item_id(&id) {
            continue;
        }
        let segments = read_segs(&c.segments(&id).await.unwrap_or_default());
        episodes.push(EpisodeRow {
            name: e.get("Name").and_then(Value::as_str).unwrap_or("").to_string(),
            index: e.get("IndexNumber").and_then(Value::as_i64),
            duration: e.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND,
            segments,
            id,
        });
    }
    let s = state.settings()?;
    let ffmpeg = media_tools::locate_ffmpeg(s.ffmpeg_path.as_deref()).map(|p| p.to_string_lossy().into_owned());
    let can_write_segments = c.segment_api().await.ok().flatten().is_some();
    Ok(Overview { episodes, ffmpeg, can_write_segments })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    id: String,
    intro: Option<Span>,
    credits: Option<Span>,
    /// "audio" | "chapters" | "" per part
    intro_source: String,
    credits_source: String,
    problem: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    label: String,
}

#[tauri::command]
pub async fn detect_season(
    app: AppHandle,
    state: State<'_, AppState>,
    season_id: String,
    intro_max: f64,
    credits_max: f64,
) -> Result<Vec<Suggestion>> {
    let c = reader(&state)?;
    let settings = state.settings()?;
    let ffmpeg = media_tools::locate_ffmpeg(settings.ffmpeg_path.as_deref())
        .ok_or_else(|| Error::msg("ffmpeg was not found. See Settings → Tools."))?;
    let root = settings.library_root.as_ref().map(PathBuf::from);
    let mut map: Option<PathMap> = settings.path_map.clone();

    let children = c.children(&season_id).await?;
    let episodes: Vec<&Value> = children
        .iter()
        .filter(|e| e.get("Type").and_then(Value::as_str) == Some("Episode"))
        .collect();
    let total = episodes.len();

    let mut intros: Vec<Option<Window>> = Vec::new();
    let mut credits: Vec<Option<Window>> = Vec::new();
    let mut out: Vec<Suggestion> = Vec::new();

    for (n, e) in episodes.iter().enumerate() {
        let id = e.get("Id").and_then(Value::as_str).unwrap_or("").to_string();
        let name = e.get("Name").and_then(Value::as_str).unwrap_or("").to_string();
        let _ = app.emit("detect-progress", Progress { done: n, total, label: format!("Listening to {name}") });

        let item = c.item_json(&id).await?;
        let duration = item.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND;
        let (ch_intro, ch_credits) = detect::from_chapters(&item);
        let mut sug = Suggestion {
            id: id.clone(),
            intro: ch_intro,
            credits: ch_credits,
            intro_source: if ch_intro.is_some() { "chapters".into() } else { String::new() },
            credits_source: if ch_credits.is_some() { "chapters".into() } else { String::new() },
            problem: None,
        };

        let server_path = item.get("Path").and_then(Value::as_str).unwrap_or("").to_string();
        let local = media_tools::map_path(&server_path, map.as_ref(), root.as_deref());
        let (Some((file, new_map)), true) = (local, duration > 60.0) else {
            sug.problem = Some(if duration <= 60.0 {
                "Too short to analyse.".into()
            } else {
                "File not found under your library folder (check the folder in Settings).".into()
            });
            intros.push(None);
            credits.push(None);
            out.push(sug);
            continue;
        };
        map = Some(new_map);

        let (i_off, i_len) = detect::intro_window(duration, intro_max);
        let (c_off, c_len) = detect::credits_window(duration, credits_max);
        let (bin1, bin2, f1, f2) = (ffmpeg.clone(), ffmpeg.clone(), file.clone(), file.clone());
        let need_intro = sug.intro.is_none();
        let need_credits = sug.credits.is_none();
        let ih = tauri::async_runtime::spawn_blocking(move || {
            need_intro.then(|| media_tools::decode_audio(&bin1, &f1, i_off, i_len).map(|s| fingerprint(&s)))
        });
        let chh = tauri::async_runtime::spawn_blocking(move || {
            need_credits.then(|| media_tools::decode_audio(&bin2, &f2, c_off, c_len).map(|s| fingerprint(&s)))
        });
        let ires = ih.await.map_err(|e| Error::msg(e.to_string()))?;
        let cres = chh.await.map_err(|e| Error::msg(e.to_string()))?;
        let mut take = |r: Option<Result<crate::fingerprint::Fingerprint>>, offset: f64| -> Option<Window> {
            match r {
                Some(Ok(fp)) => Some(Window { offset, fp }),
                Some(Err(err)) => {
                    sug.problem = Some(err.to_string());
                    None
                }
                None => None,
            }
        };
        intros.push(take(ires, i_off));
        credits.push(take(cres, c_off));
        out.push(sug);
    }
    let _ = app.emit("detect-progress", Progress { done: total, total, label: "Comparing episodes".into() });

    let durations: Vec<f64> = episodes
        .iter()
        .map(|e| e.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND)
        .collect();
    let intro_spans = detect::season_spans(&intros, &INTRO_LIMITS);
    let credit_spans = detect::season_spans(&credits, &CREDITS_LIMITS);
    for (i, s) in out.iter_mut().enumerate() {
        if s.intro.is_none() {
            if let Some(sp) = intro_spans[i] {
                s.intro = Some(detect::snap_to_start(sp));
                s.intro_source = "audio".into();
            }
        }
        if s.credits.is_none() {
            if let Some(sp) = credit_spans[i] {
                s.credits = Some(detect::snap_to_end(sp, durations[i]));
                s.credits_source = "audio".into();
            }
        }
    }
    if map != settings.path_map {
        state.update_settings(|st| st.path_map = map)?;
    }
    Ok(out)
}

/// What undo needs to put things back.
#[derive(Serialize, Deserialize)]
struct SegRecord {
    before: Vec<Seg>,
    kinds: Vec<String>,
    created: Vec<Seg>,
}

fn valid_span(s: &Span, duration: Option<f64>) -> bool {
    s.start >= 0.0 && s.end > s.start + 0.5 && duration.map(|d| s.end <= d + 1.0).unwrap_or(true)
}

/// Replaces this item's Intro and/or Outro segments. `None` leaves that kind alone;
/// a kind listed in `clear` is removed.
#[tauri::command]
pub async fn save_segments(
    state: State<'_, AppState>,
    item_id: String,
    intro: Option<Span>,
    credits: Option<Span>,
    clear: Vec<String>,
) -> Result<()> {
    if !valid_item_id(&item_id) {
        return Err(Error::msg("bad id"));
    }
    let w = state.writer()?;
    let api = w
        .reader()
        .segment_api()
        .await?
        .ok_or_else(|| Error::msg("Saving needs the “MediaSegments API” plugin in Jellyfin (Dashboard → Plugins → Catalog), then restart Jellyfin."))?;
    let item = w.reader().item_json(&item_id).await?;
    let duration = item.get("RunTimeTicks").and_then(Value::as_f64).map(|t| t / TICKS_PER_SECOND);

    let mut wanted: Vec<(String, Option<Span>)> = Vec::new();
    if let Some(s) = intro {
        wanted.push(("Intro".into(), Some(s)));
    }
    if let Some(s) = credits {
        wanted.push(("Outro".into(), Some(s)));
    }
    for k in clear {
        if (k == "Intro" || k == "Outro") && !wanted.iter().any(|(w, _)| *w == k) {
            wanted.push((k, None));
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }
    for (_, s) in &wanted {
        if let Some(s) = s {
            if !valid_span(s, duration) {
                return Err(Error::msg("A start or end time is outside the episode."));
            }
        }
    }

    let before = read_segs(&w.reader().segments(&item_id).await?);
    let kinds: Vec<String> = wanted.iter().map(|(k, _)| k.clone()).collect();
    let created: Vec<Seg> = wanted
        .iter()
        .filter_map(|(k, s)| s.map(|s| Seg { id: String::new(), kind: k.clone(), start: s.start, end: s.end }))
        .collect();
    let record = serde_json::to_string(&SegRecord { before: before.clone(), kinds: kinds.clone(), created: created.clone() })
        .map_err(|e| Error::msg(e.to_string()))?;
    state.store()?.journal_add("segment", &item_id, &record, &kinds.join(","))?;

    for old in before.iter().filter(|s| kinds.contains(&s.kind)) {
        w.segment_delete(&api, &old.id).await?;
    }
    for s in &created {
        w.segment_create(&api, &item_id, &s.kind, s.start, s.end, PROVIDER).await?;
    }
    Ok(())
}

/// Puts the segments of the touched kinds back to how they were.
pub async fn undo_segments(w: &Writer, item_id: &str, record_json: &str) -> Result<()> {
    let rec: SegRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let api = w
        .reader()
        .segment_api()
        .await?
        .ok_or_else(|| Error::msg("The MediaSegments API plugin is not available."))?;
    let now = read_segs(&w.reader().segments(item_id).await?);
    for s in now.iter().filter(|s| rec.kinds.contains(&s.kind)) {
        w.segment_delete(&api, &s.id).await?;
    }
    for s in rec.before.iter().filter(|s| rec.kinds.contains(&s.kind)) {
        w.segment_create(&api, item_id, &s.kind, s.start, s.end, PROVIDER).await?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
pub async fn ffmpeg_info(state: State<'_, AppState>) -> Result<ToolInfo> {
    let custom = state.settings()?.ffmpeg_path;
    tauri::async_runtime::spawn_blocking(move || {
        let p = media_tools::locate_ffmpeg(custom.as_deref());
        ToolInfo {
            version: p.as_deref().and_then(media_tools::ffmpeg_version),
            path: p.map(|p| p.to_string_lossy().into_owned()),
        }
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))
}

#[tauri::command]
pub async fn pick_ffmpeg(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>> {
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|_| Error::msg("That file cannot be used."))?;
    if media_tools::ffmpeg_version(&path).map(|v| v.to_lowercase().contains("ffmpeg")) != Some(true) {
        return Err(Error::msg("That does not look like ffmpeg."));
    }
    let s = path.to_string_lossy().into_owned();
    let saved = s.clone();
    state.update_settings(move |st| st.ffmpeg_path = Some(saved))?;
    Ok(Some(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_jellyfin_segments() {
        let v = vec![serde_json::json!({"Id": "abc-1", "Type": "Intro", "StartTicks": 50_000_000i64, "EndTicks": 350_000_000i64})];
        let s = read_segs(&v);
        assert_eq!(s[0].kind, "Intro");
        assert_eq!((s[0].start, s[0].end), (5.0, 35.0));
    }

    #[test]
    fn span_checks() {
        assert!(valid_span(&Span { start: 0.0, end: 30.0 }, Some(1500.0)));
        assert!(!valid_span(&Span { start: 30.0, end: 10.0 }, Some(1500.0)));
        assert!(!valid_span(&Span { start: 1400.0, end: 1600.0 }, Some(1500.0)));
        assert!(!valid_span(&Span { start: -1.0, end: 10.0 }, None));
    }
}
