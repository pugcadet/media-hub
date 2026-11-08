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

/// Only for servers without Intro Skipper's editor endpoint: the MediaSegments API plugin's
/// provider (it never regenerates, so Jellyfin keeps what is saved under it).
const LEGACY_PROVIDER: &str = "MediaSegments API";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seg {
    id: String,
    kind: String,
    start: f64,
    end: f64,
}

#[cfg(test)]
impl Seg {
    pub fn new(kind: &str, start: f64, end: f64) -> Seg {
        Seg { id: String::new(), kind: kind.into(), start, end }
    }
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

/// Does this marker fit in the episode? (Intro Skipper sometimes stores credits from 0:00 over
/// the whole episode, or past its end.)
fn plausible(s: &Seg, duration: f64) -> bool {
    s.start >= 0.0 && s.end > s.start + 0.5 && (duration <= 0.0 || (s.end <= duration + 5.0 && s.end - s.start <= duration * 0.5))
}

/// One marker per kind: when Jellyfin has two (one saved here, an older one from Intro
/// Skipper), the one that fits the episode. A kind with only a bad one keeps it, so it's flagged.
fn best_per_kind(segs: Vec<Seg>, duration: f64) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    for s in segs {
        match out.iter().position(|o| o.kind == s.kind) {
            None => out.push(s),
            Some(i) if !plausible(&out[i], duration) && plausible(&s, duration) => out[i] = s,
            Some(_) => {}
        }
    }
    out
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

async fn reader(state: &AppState) -> Result<crate::jellyfin::Client> {
    state.reader().await
}

#[tauri::command]
pub async fn segments_overview(state: State<'_, AppState>, season_id: String) -> Result<Overview> {
    let c = reader(&state).await?;
    let children = c.children(&season_id).await?;
    let eps: Vec<&Value> = children.iter().filter(|e| e.get("Type").and_then(Value::as_str) == Some("Episode")).collect();
    // Every episode's markers asked for at once (one at a time made a season slow to open).
    let tasks: Vec<_> = eps
        .iter()
        .map(|e| {
            let id = e.get("Id").and_then(Value::as_str).unwrap_or("").to_string();
            let c2 = c.clone();
            tauri::async_runtime::spawn(async move {
                if !valid_item_id(&id) {
                    return None;
                }
                Some(read_segs(&c2.segments(&id).await.unwrap_or_default()))
            })
        })
        .collect();
    let mut episodes = Vec::new();
    for (e, task) in eps.iter().zip(tasks) {
        let id = e.get("Id").and_then(Value::as_str).unwrap_or("").to_string();
        let Some(segments) = task.await.ok().flatten() else { continue };
        let duration = e.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND;
        episodes.push(EpisodeRow {
            name: e.get("Name").and_then(Value::as_str).unwrap_or("").to_string(),
            index: e.get("IndexNumber").and_then(Value::as_i64),
            segments: best_per_kind(segments, duration),
            duration,
            id,
        });
    }
    let s = state.settings()?;
    let ffmpeg = media_tools::locate_ffmpeg(s.ffmpeg_path.as_deref()).map(|p| p.to_string_lossy().into_owned());
    let first = episodes.first().map(|e| e.id.clone()).unwrap_or_default();
    let editor = if first.is_empty() { false } else { c.segments_editor(&first).await.ok().flatten().is_some() };
    let can_write_segments = editor || c.segment_api().await.ok().flatten().is_some();
    Ok(Overview { episodes, ffmpeg, can_write_segments })
}

/// Which episodes to listen to: all of them, or the asked-for ones plus the 3 nearest others.
fn listen_to(ids: &[String], only: Option<&[String]>) -> Vec<bool> {
    let Some(only) = only.filter(|o| !o.is_empty()) else { return vec![true; ids.len()] };
    let picked: Vec<usize> = (0..ids.len()).filter(|&i| only.contains(&ids[i])).collect();
    let mut out: Vec<bool> = (0..ids.len()).map(|i| picked.contains(&i)).collect();
    let mut others: Vec<usize> = (0..ids.len()).filter(|i| !out[*i]).collect();
    others.sort_by_key(|&i| picked.iter().map(|&p| p.abs_diff(i)).min().unwrap_or(usize::MAX));
    for i in others.into_iter().take(3) {
        out[i] = true;
    }
    out
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
    find_intro: Option<bool>,
    find_credits: Option<bool>,
    only: Option<Vec<String>>,
) -> Result<Vec<Suggestion>> {
    let (find_intro, find_credits) = (find_intro.unwrap_or(true), find_credits.unwrap_or(true));
    if !find_intro && !find_credits {
        return Err(Error::msg("Tick intros, credits or both."));
    }
    let c = reader(&state).await?;
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
    // Only some episodes asked for: those, plus the 3 nearest others to compare with (an intro
    // is found by hearing the same music in several episodes). The rest isn't listened to.
    let ids: Vec<String> = episodes.iter().map(|e| e.get("Id").and_then(Value::as_str).unwrap_or("").to_string()).collect();
    let listen = listen_to(&ids, only.as_deref());
    let total = listen.iter().filter(|x| **x).count();
    let mut heard = 0usize;

    let mut intros: Vec<Option<Window>> = Vec::new();
    let mut credits: Vec<Option<Window>> = Vec::new();
    let mut out: Vec<Suggestion> = Vec::new();

    crate::cancel::begin("detect");
    for (n, e) in episodes.iter().enumerate() {
        crate::cancel::check("detect")?;
        let id = e.get("Id").and_then(Value::as_str).unwrap_or("").to_string();
        if !listen[n] {
            intros.push(None);
            credits.push(None);
            out.push(Suggestion { id, intro: None, credits: None, intro_source: String::new(), credits_source: String::new(), problem: None });
            continue;
        }
        let name = e.get("Name").and_then(Value::as_str).unwrap_or("").to_string();
        let _ = app.emit("detect-progress", Progress { done: heard, total, label: format!("Listening to {name}") });
        heard += 1;

        let item = c.item_json(&id).await?;
        let duration = item.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND;
        let (ch_intro, ch_credits) = detect::from_chapters(&item);
        let (ch_intro, ch_credits) = (ch_intro.filter(|_| find_intro), ch_credits.filter(|_| find_credits));
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
        let need_intro = find_intro && sug.intro.is_none();
        let need_credits = find_credits && sug.credits.is_none();
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

/// Replaces this item's Intro, Outro and/or Recap segments. `None` leaves that kind alone;
/// a kind listed in `clear` is removed.
#[tauri::command]
pub async fn save_segments(
    state: State<'_, AppState>,
    item_id: String,
    intro: Option<Span>,
    credits: Option<Span>,
    recap: Option<Span>,
    clear: Vec<String>,
) -> Result<SaveReport> {
    if !valid_item_id(&item_id) {
        return Err(Error::msg("bad id"));
    }
    let w = state.writer().await?;
    let item = w.reader().item_json(&item_id).await?;
    let duration = item.get("RunTimeTicks").and_then(Value::as_f64).map(|t| t / TICKS_PER_SECOND);

    let mut wanted: Vec<(String, Option<Span>)> = Vec::new();
    if let Some(s) = intro {
        wanted.push(("Intro".into(), Some(s)));
    }
    if let Some(s) = credits {
        wanted.push(("Outro".into(), Some(s)));
    }
    if let Some(s) = recap {
        wanted.push(("Recap".into(), Some(s)));
    }
    for k in clear {
        if (k == "Intro" || k == "Outro" || k == "Recap") && !wanted.iter().any(|(w, _)| *w == k) {
            wanted.push((k, None));
        }
    }
    if wanted.is_empty() {
        return Ok(SaveReport { confirmed: true, message: "Nothing to change".into() });
    }
    for (_, s) in &wanted {
        if let Some(s) = s {
            if !valid_span(s, duration) {
                return Err(Error::msg("A start or end time is outside the episode."));
            }
        }
    }

    let kinds: Vec<String> = wanted.iter().map(|(k, _)| k.clone()).collect();
    let created: Vec<Seg> = wanted
        .iter()
        .filter_map(|(k, s)| s.map(|s| Seg { id: String::new(), kind: k.clone(), start: s.start, end: s.end }))
        .collect();
    let before = current(&w, &item_id).await?;
    let record = serde_json::to_string(&SegRecord { before: before.clone(), kinds: kinds.clone(), created: created.clone() })
        .map_err(|e| Error::msg(e.to_string()))?;
    state.store()?.journal_add("segment", &item_id, &record, &kinds.join(","))?;

    let report = store_markers(&w, &item_id, &kinds, &created).await?;
    if let Some(series) = item.get("SeriesId").and_then(Value::as_str) {
        crate::library::seg_invalidate(&state.dir, series);
    }
    Ok(report)
}

/// What happened to one episode's markers, in plain words for the progress list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SaveReport {
    /// Read back from Jellyfin and found exactly as sent: players will offer "Skip".
    pub confirmed: bool,
    pub message: String,
}

/// The markers as the editor endpoint sees them (every provider), else as players see them.
async fn current(w: &Writer, item_id: &str) -> Result<Vec<Seg>> {
    Ok(match w.reader().segments_editor(item_id).await? {
        Some(r) => read_segs(&r.items),
        None => read_segs(&w.reader().segments(item_id).await?),
    })
}

/// A new segment id in the form Jellyfin uses (a random GUID).
fn new_guid(salt: &str) -> String {
    use sha2::{Digest, Sha256};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let h = Sha256::digest(format!("{salt}{nanos}{n}").as_bytes());
    let mut b: Vec<u8> = h[..16].to_vec();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let x: String = b.iter().map(|v| format!("{v:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

fn wire(item_id: &str, id: &str, kind: &str, start: f64, end: f64) -> Value {
    serde_json::json!({
        "Id": id,
        "ItemId": item_id,
        "Type": kind,
        "StartTicks": (start * TICKS_PER_SECOND).round() as i64,
        "EndTicks": (end * TICKS_PER_SECOND).round() as i64,
    })
}

/// The whole set to send: everything of other kinds untouched, plus the new markers.
fn replacement(item_id: &str, existing: &[Value], kinds: &[String], new: &[Seg]) -> Vec<Value> {
    let mut out: Vec<Value> = existing
        .iter()
        .filter(|s| !kinds.iter().any(|k| Some(k.as_str()) == s.get("Type").and_then(Value::as_str)))
        .cloned()
        .collect();
    out.extend(new.iter().map(|s| wire(item_id, &new_guid(item_id), &s.kind, s.start, s.end)));
    out
}

/// Did the read-back find what was saved? Times within a second count (ticks get rounded).
fn matches(read: &[Seg], kinds: &[String], new: &[Seg]) -> bool {
    let all_new_there = new
        .iter()
        .all(|n| read.iter().any(|r| r.kind == n.kind && (r.start - n.start).abs() < 1.0 && (r.end - n.end).abs() < 1.0));
    let cleared_gone = kinds
        .iter()
        .filter(|k| !new.iter().any(|n| &n.kind == *k))
        .all(|k| !read.iter().any(|r| &r.kind == k));
    all_new_there && cleared_gone
}

/// Saves the markers of `kinds` the way Jellyfin's Segment Editor does, then reads them back:
/// 1. read the set with its version tag, replace it in one guarded step (PUT + If-Match);
/// 2. older Intro Skipper: delete the old ones and add the new ones under its provider;
/// 3. no Intro Skipper at all: the MediaSegments API plugin.
/// Finally reads back what players get, so "saved" only ever means "saved and confirmed".
pub async fn store_markers(w: &Writer, item_id: &str, kinds: &[String], new: &[Seg]) -> Result<SaveReport> {
    let mut wrote = false;
    for _ in 0..2 {
        match w.reader().segments_editor(item_id).await? {
            Some(read) if read.etag.is_some() => {
                let body = replacement(item_id, &read.items, kinds, new);
                if w.segments_put(item_id, read.etag.as_deref().unwrap_or(""), &body).await? {
                    wrote = true;
                    break;
                }
                // 412: changed meanwhile (Intro Skipper was busy); read again and retry once.
            }
            Some(read) => {
                for old in read_segs(&read.items).iter().filter(|s| kinds.contains(&s.kind) && !s.id.is_empty()) {
                    w.segment_delete_editor(&old.id, item_id, &old.kind).await?;
                }
                for s in new {
                    w.segment_post_editor(item_id, &s.kind, s.start, s.end).await?;
                }
                wrote = true;
                break;
            }
            None => {
                let api = w.reader().segment_api().await?.ok_or_else(|| {
                    Error::msg("Jellyfin has no way to store skip markers yet: install the “Intro Skipper” plugin (Jellyfin → Dashboard → Plugins → Catalog) and restart Jellyfin.")
                })?;
                for old in read_segs(&w.reader().segments(item_id).await?).iter().filter(|s| kinds.contains(&s.kind)) {
                    w.segment_delete(&api, &old.id).await?;
                }
                for s in new {
                    w.segment_create(&api, item_id, &s.kind, s.start, s.end, LEGACY_PROVIDER).await?;
                }
                wrote = true;
                break;
            }
        }
    }
    if !wrote {
        return Err(Error::msg("The markers kept changing on the server while saving (Intro Skipper may be analysing this show). Try again in a minute."));
    }
    // Other markers of the same kind still there (Intro Skipper's own, from another provider):
    // removed, so players don't pick the old one.
    let editor = w.reader().segments_editor(item_id).await.ok().flatten().is_some();
    let api = if editor { None } else { w.reader().segment_api().await.ok().flatten() };
    for old in read_segs(&w.reader().segments(item_id).await.unwrap_or_default()) {
        let ours = new.iter().any(|n| n.kind == old.kind && (n.start - old.start).abs() < 0.5 && (n.end - old.end).abs() < 0.5);
        if ours || old.id.is_empty() || !kinds.contains(&old.kind) {
            continue;
        }
        let _ = if editor {
            w.segment_delete_editor(&old.id, item_id, &old.kind).await
        } else if let Some(api) = &api {
            w.segment_delete(api, &old.id).await
        } else {
            Ok(())
        };
    }

    // Read back. Players read the filtered list; the editor list shows what was stored at all.
    for wait in [300u64, 1200, 2500] {
        tokio_sleep_ms(wait).await;
        let seen = read_segs(&w.reader().segments(item_id).await.unwrap_or_default());
        if matches(&seen, kinds, new) {
            return Ok(SaveReport { confirmed: true, message: "Saved and confirmed".into() });
        }
    }
    let stored = w.reader().segments_editor(item_id).await.ok().flatten().map(|r| read_segs(&r.items)).unwrap_or_default();
    if matches(&stored, kinds, new) {
        return Ok(SaveReport {
            confirmed: false,
            message: "Saved, but players won't see it: “Intro Skipper” is switched off as a segment provider for this library. Turn it on under Intros → Options (or Jellyfin → Libraries → Manage library).".into(),
        });
    }
    Err(Error::msg("Jellyfin accepted the markers but didn't keep them. Check that Intro Skipper is up to date (Jellyfin page → Plugins), then save again."))
}

async fn tokio_sleep_ms(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await.ok();
}

/// Puts the segments of the touched kinds back to how they were.
pub async fn undo_segments(w: &Writer, item_id: &str, record_json: &str) -> Result<()> {
    let rec: SegRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let back: Vec<Seg> = rec.before.iter().filter(|s| rec.kinds.contains(&s.kind)).cloned().collect();
    store_markers(w, item_id, &rec.kinds, &back).await.map(|_| ())
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
    fn only_the_picked_episodes_and_a_few_neighbours_are_heard() {
        let ids: Vec<String> = (1..=10).map(|i| format!("e{i}")).collect();
        let got = listen_to(&ids, Some(&["e5".to_string()]));
        assert_eq!(got.iter().filter(|x| **x).count(), 4);
        assert!(got[4] && got[3] && got[5]);
        assert_eq!(listen_to(&ids, None), vec![true; 10]);
    }

    #[test]
    fn a_bad_marker_from_intro_skipper_gives_way_to_the_good_one() {
        let seg = |k: &str, a: f64, b: f64| Seg { id: String::new(), kind: k.into(), start: a, end: b };
        // Credits over the whole episode (Intro Skipper), then the one saved here.
        let got = best_per_kind(vec![seg("Outro", 0.0, 1474.0), seg("Intro", 55.0, 110.0), seg("Outro", 1427.0, 1474.0)], 1474.0);
        assert_eq!(got.len(), 2);
        assert_eq!(got.iter().find(|s| s.kind == "Outro").map(|s| s.start), Some(1427.0));
        // Only a bad one: kept, so it shows up as suspicious.
        let got = best_per_kind(vec![seg("Outro", 0.0, 1474.0)], 1474.0);
        assert_eq!(got[0].start, 0.0);
        assert!(!plausible(&seg("Outro", 1400.0, 3000.0), 1474.0), "past the end");
    }

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

/* ------------------------------------------------- markers survive a folder rename */

/// One episode's skip markers by season/episode number (ids change when a show folder is
/// renamed, numbers don't).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SegSnap {
    season: i64,
    episode: i64,
    kind: String,
    start: f64,
    end: f64,
}

async fn episode_ids(c: &crate::jellyfin::Client, series_id: &str) -> Result<Vec<(i64, i64, String)>> {
    let eps = c
        .items_query(
            vec![
                ("ParentId", series_id.to_string()),
                ("Recursive", "true".into()),
                ("IncludeItemTypes", "Episode".into()),
                ("EnableUserData", "false".into()),
                ("EnableImages", "false".into()),
            ],
            20_000,
        )
        .await?;
    Ok(eps
        .iter()
        .filter_map(|e| {
            let s = e.get("ParentIndexNumber").and_then(Value::as_i64)?;
            let n = e.get("IndexNumber").and_then(Value::as_i64)?;
            let id = e.get("Id").and_then(Value::as_str)?.replace('-', "");
            Some((s, n, id))
        })
        .collect())
}

/// Before renaming a show's folder: every skip marker of the show, by episode number.
#[tauri::command]
pub async fn segments_snapshot(state: State<'_, AppState>, series_id: String) -> Result<Vec<SegSnap>> {
    if !valid_item_id(&series_id) {
        return Err(Error::msg("bad id"));
    }
    let c = state.reader().await?;
    let mut out = Vec::new();
    for (season, episode, id) in episode_ids(&c, &series_id).await? {
        for s in read_segs(&c.segments(&id).await.unwrap_or_default()) {
            out.push(SegSnap { season, episode, kind: s.kind, start: s.start, end: s.end });
        }
    }
    Ok(out)
}

/// After the rename: waits (up to ~4 minutes) until Jellyfin lists the show under its new
/// folder, then puts the markers back on the same episodes. Runs in the background.
#[tauri::command]
pub async fn segments_carry(app: AppHandle, state: State<'_, AppState>, snapshot: Vec<SegSnap>, folder_name: String, old_series_id: String) -> Result<()> {
    if snapshot.is_empty() || folder_name.is_empty() || folder_name.contains('/') || folder_name.contains('\\') {
        return Ok(());
    }
    let w = state.writer().await?;
    tauri::async_runtime::spawn(async move {
        let found = carry(&w, &snapshot, &folder_name, &old_series_id).await;
        let _ = app.emit("segments-carried", serde_json::json!({ "folder": folder_name, "ok": found.as_ref().map(|n| *n).unwrap_or(0), "error": found.err().map(|e| e.to_string()) }));
    });
    Ok(())
}

async fn carry(w: &Writer, snap: &[SegSnap], folder_name: &str, old_id: &str) -> Result<usize> {
    let suffix = format!("/{}", folder_name.to_lowercase());
    for _ in 0..48 {
        tokio_sleep(5).await;
        let shows = w
            .reader()
            .items_query(vec![("IncludeItemTypes", "Series".into()), ("Recursive", "true".into()), ("Fields", "Path".into()), ("EnableImages", "false".into())], 50_000)
            .await
            .unwrap_or_default();
        let new_id = shows.iter().find_map(|s| {
            let p = s.get("Path").and_then(Value::as_str)?.replace('\\', "/").trim_end_matches('/').to_lowercase();
            let id = s.get("Id").and_then(Value::as_str)?.replace('-', "");
            (p.ends_with(&suffix) && id != old_id).then_some(id)
        });
        let Some(new_id) = new_id else { continue };
        let eps = episode_ids(w.reader(), &new_id).await?;
        if eps.is_empty() {
            continue; // episodes not scanned yet
        }
        let mut n = 0;
        for (season, episode, id) in eps {
            let have = read_segs(&w.reader().segments(&id).await.unwrap_or_default());
            let todo: Vec<Seg> = snap
                .iter()
                .filter(|s| s.season == season && s.episode == episode && !have.iter().any(|h| h.kind == s.kind))
                .map(|s| Seg { id: String::new(), kind: s.kind.clone(), start: s.start, end: s.end })
                .collect();
            if todo.is_empty() {
                continue;
            }
            let kinds: Vec<String> = todo.iter().map(|s| s.kind.clone()).collect();
            if store_markers(w, &id, &kinds, &todo).await.is_ok() {
                n += todo.len();
            }
        }
        return Ok(n);
    }
    Err(Error::msg("Jellyfin didn't list the renamed show in time; its skip markers could not be carried over."))
}

async fn tokio_sleep(secs: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_secs(secs))).await.ok();
}
