//! Jellyfin as Media Hub's backend. Media Hub decides details, art and skip markers;
//! Jellyfin stores them and hands them to Infuse. This module sets Jellyfin up for that
//! (no refreshing on its own, lighter scans, a backup on the NAS), keeps your edits locked,
//! and tells Jellyfin about changed folders instead of scanning everything.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::media_tools;
use crate::state::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TuneRow {
    /// "library" | "task"
    scope: &'static str,
    /// Library id or task id.
    target: String,
    target_name: String,
    key: String,
    label: String,
    detail: String,
    current: Value,
    recommended: Value,
    /// Already as recommended.
    ok: bool,
}

impl TuneRow {
    pub fn is_ok(&self) -> bool {
        self.ok
    }
    pub fn is_key(&self, k: &str) -> bool {
        self.key == k
    }
}

struct LibTune {
    key: &'static str,
    label: &'static str,
    detail: &'static str,
    recommended: fn() -> Value,
    ok: fn(&Value) -> bool,
}

fn is_false(v: &Value) -> bool {
    v.as_bool() == Some(false)
}

const LIB_TUNES: &[LibTune] = &[
    LibTune {
        key: "AutomaticRefreshIntervalDays",
        label: "Refreshes details on its own",
        detail: "Off: Jellyfin never downloads details or pictures again by itself, so what you set in Media Hub stays.",
        recommended: || json!(0),
        ok: |v| v.as_i64().unwrap_or(0) == 0,
    },
    LibTune {
        key: "EnableRealtimeMonitor",
        label: "Notices new files right away",
        detail: "On: new and renamed files show up in Infuse without waiting for a full scan.",
        recommended: || json!(true),
        ok: |v| v.as_bool() == Some(true),
    },
    LibTune {
        key: "ExtractChapterImagesDuringLibraryScan",
        label: "Makes chapter pictures during scans",
        detail: "Off: scans finish much faster. The nightly task still makes them.",
        recommended: || json!(false),
        ok: is_false,
    },
    LibTune {
        key: "ExtractTrickplayImagesDuringLibraryScan",
        label: "Makes seek thumbnails during scans",
        detail: "Off: scans finish much faster. The nightly task still makes them.",
        recommended: || json!(false),
        ok: is_false,
    },
    LibTune {
        key: "SaveLocalMetadata",
        label: "Saves pictures next to the videos",
        detail: "On: posters and backgrounds are also kept on the NAS, as a backup that survives a Jellyfin reinstall.",
        recommended: || json!(true),
        ok: |v| v.as_bool() == Some(true),
    },
    LibTune {
        key: "MetadataSavers",
        label: "Writes .nfo files next to the videos",
        detail: "On: titles, descriptions and ids are also saved on the NAS (.nfo), so nothing is lost if Jellyfin's database is.",
        recommended: || json!(["Nfo"]),
        ok: |v| v.as_array().map(|a| a.iter().any(|x| x.as_str() == Some("Nfo"))).unwrap_or(false),
    },
    LibTune {
        key: "SubtitleDownloadLanguages",
        label: "Downloads subtitles by itself",
        detail: "Off: Media Hub picks subtitles (plain over SDH, nothing when good ones are built in) instead of Jellyfin guessing during scans.",
        recommended: || json!([]),
        ok: |v| v.as_array().map(|a| a.is_empty()).unwrap_or(true),
    },
];

/// Library kinds Media Hub manages (music and photo libraries are left alone).
fn managed_kind(kind: &str) -> bool {
    matches!(kind, "movies" | "tvshows" | "mixed" | "homevideos" | "")
}

/// Tasks worth showing: the ones that make Jellyfin (and Infuse's sync) slow when they run.
const TASK_KEYS: &[(&str, &str)] = &[
    ("RefreshLibrary", "Looks for new and changed files in every library."),
    ("RefreshChapterImages", "Makes chapter pictures. Heavy on the NAS; best at night."),
    ("RefreshTrickplayImages", "Makes seek thumbnails for Media Hub's player. Heavy; best at night. Infuse makes its own."),
    ("KeyframeExtraction", "Reads keyframes for faster seeking while converting. Not needed for Infuse."),
    ("RefreshPeople", "Downloads cast photos and biographies."),
];

pub fn lib_rows(folders: &[Value]) -> Vec<TuneRow> {
    let mut out = Vec::new();
    for f in folders {
        let id = s(f, "ItemId").replace('-', "");
        if !valid_item_id(&id) || !managed_kind(s(f, "CollectionType")) {
            continue;
        }
        let opts = f.get("LibraryOptions").cloned().unwrap_or(Value::Null);
        for t in LIB_TUNES {
            let current = opts.get(t.key).cloned().unwrap_or(Value::Null);
            out.push(TuneRow {
                scope: "library",
                target: id.clone(),
                target_name: s(f, "Name").to_string(),
                key: t.key.into(),
                label: t.label.into(),
                detail: t.detail.into(),
                ok: (t.ok)(&current),
                current,
                recommended: (t.recommended)(),
            });
        }
    }
    out
}

/// "Daily at 02:00", "Every 12 hours", "On startup", "Never".
pub fn schedule_text(triggers: &Value) -> String {
    let list = triggers.as_array().cloned().unwrap_or_default();
    if list.is_empty() {
        return "Never (only when started)".into();
    }
    let parts: Vec<String> = list
        .iter()
        .map(|t| {
            let ticks = t.get("TimeOfDayTicks").or_else(|| t.get("IntervalTicks")).and_then(Value::as_i64).unwrap_or(0);
            let mins = ticks / 600_000_000;
            match s(t, "Type") {
                "DailyTrigger" => format!("Daily at {:02}:{:02}", mins / 60, mins % 60),
                "WeeklyTrigger" => format!("{}s at {:02}:{:02}", s(t, "DayOfWeek"), mins / 60, mins % 60),
                "IntervalTrigger" if mins % 60 == 0 => format!("Every {} hour{}", mins / 60, if mins == 60 { "" } else { "s" }),
                "IntervalTrigger" => format!("Every {mins} minutes"),
                "StartupTrigger" => "When Jellyfin starts".into(),
                other => other.to_string(),
            }
        })
        .collect();
    parts.join(", ")
}

fn task_rows(tasks: &[Value]) -> Vec<TuneRow> {
    let mut out = Vec::new();
    for (key, detail) in TASK_KEYS {
        let Some(t) = tasks.iter().find(|t| s(t, "Key") == *key) else { continue };
        let triggers = t.get("Triggers").cloned().unwrap_or(json!([]));
        let last = t.get("LastExecutionResult");
        let mut d = detail.to_string();
        if let Some(l) = last {
            let status = s(l, "Status");
            if !status.is_empty() {
                d.push_str(&format!(" Last run: {}.", if status == "Completed" { "finished" } else { status }));
            }
        }
        out.push(TuneRow {
            scope: "task",
            target: s(t, "Id").to_string(),
            target_name: s(t, "Name").to_string(),
            key: key.to_string(),
            label: schedule_text(&triggers),
            detail: d,
            ok: true,
            current: triggers,
            recommended: Value::Null,
        });
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    rows: Vec<TuneRow>,
    /// Jellyfin's version, and whether Infuse can read skip markers from it (10.10+).
    version: String,
    markers_ok: bool,
    lock_edits: bool,
}

pub fn version_at_least(v: &str, major: u32, minor: u32) -> bool {
    let mut it = v.split('.').map(|p| p.trim().parse::<u32>().unwrap_or(0));
    let (a, b) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    (a, b) >= (major, minor)
}

/// How Jellyfin is set up, compared with what works best as Media Hub's backend.
#[tauri::command]
pub async fn backend_tuning(state: State<'_, AppState>) -> Result<Tuning> {
    let c = state.reader().await?;
    let folders = c.virtual_folders().await?;
    let mut rows = lib_rows(&folders);
    if let Ok(tasks) = c.scheduled_tasks().await {
        rows.extend(task_rows(&tasks));
    }
    let version = c.system_info().await.map(|i| i.version).unwrap_or_default();
    Ok(Tuning { markers_ok: version_at_least(&version, 10, 10), version, rows, lock_edits: state.settings()?.lock_edits })
}

/// Changes one library setting (journaled; Undo puts the library's old settings back).
async fn set_lib(state: &AppState, w: &crate::jellyfin::Writer, id: &str, changes: &[(String, Value)]) -> Result<()> {
    let folder = w
        .reader()
        .virtual_folders()
        .await?
        .into_iter()
        .find(|f| s(f, "ItemId").replace('-', "") == id)
        .ok_or_else(|| Error::msg("That library isn't there."))?;
    let old = folder.get("LibraryOptions").cloned().unwrap_or(Value::Null);
    let mut new = old.clone();
    if !new.is_object() {
        return Err(Error::msg("Jellyfin didn't send this library's settings."));
    }
    for (k, v) in changes {
        new[k.as_str()] = v.clone();
    }
    if new == old {
        return Ok(());
    }
    let entry = state.store()?.journal_add("library_options", id, &old.to_string(), &new.to_string())?;
    if let Err(e) = w.set_library_options(id, &new).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

fn allowed_key(key: &str) -> bool {
    LIB_TUNES.iter().any(|t| t.key == key)
}

/// Sets one library option (`scope` "library") or turns a scheduled task on/off
/// (`scope` "task": `value` false clears its schedule, true puts back the one it had).
#[tauri::command]
pub async fn backend_set(state: State<'_, AppState>, scope: String, target: String, key: String, value: Value) -> Result<()> {
    let w = state.writer().await?;
    match scope.as_str() {
        "library" => {
            if !valid_item_id(&target) || !allowed_key(&key) {
                return Err(Error::msg("bad setting"));
            }
            set_lib(&state, &w, &target, &[(key, value)]).await
        }
        "task" => {
            let tasks = w.reader().scheduled_tasks().await?;
            let t = tasks.iter().find(|t| s(t, "Id") == target).ok_or_else(|| Error::msg("That task isn't there."))?;
            let old = t.get("Triggers").cloned().unwrap_or(json!([]));
            let new = if value.as_bool() == Some(false) {
                json!([])
            } else {
                // Put back the schedule from before it was turned off (newest journal entry).
                state.store()?.last_old_value("task_triggers", &target)?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_else(|| default_triggers(&key))
            };
            let entry = state.store()?.journal_add("task_triggers", &target, &old.to_string(), &new.to_string())?;
            if let Err(e) = w.set_task_triggers(&target, &new).await {
                state.store()?.journal_delete(entry)?;
                return Err(e);
            }
            Ok(())
        }
        _ => Err(Error::msg("bad scope")),
    }
}

/// Jellyfin's usual schedule for a task, for when there's no older one to put back.
fn default_triggers(key: &str) -> Value {
    let hours = |h: i64| h * 36_000_000_000;
    match key {
        "RefreshLibrary" => json!([{ "Type": "IntervalTrigger", "IntervalTicks": hours(12) }]),
        _ => json!([{ "Type": "DailyTrigger", "TimeOfDayTicks": hours(3) }]),
    }
}

pub async fn undo_task_triggers(w: &crate::jellyfin::Writer, task_id: &str, old_json: &str) -> Result<()> {
    let old: Value = serde_json::from_str(old_json).map_err(|_| Error::msg("bad journal entry"))?;
    w.set_task_triggers(task_id, &old).await
}

/// Applies every recommended library setting that isn't set yet (one History entry per
/// library). Returns how many settings changed.
#[tauri::command]
pub async fn backend_apply_recommended(state: State<'_, AppState>) -> Result<usize> {
    let w = state.writer().await?;
    let rows = lib_rows(&w.reader().virtual_folders().await?);
    let mut by_lib: std::collections::BTreeMap<String, Vec<(String, Value)>> = Default::default();
    for r in rows.into_iter().filter(|r| !r.ok) {
        by_lib.entry(r.target).or_default().push((r.key, r.recommended));
    }
    let mut n = 0;
    for (id, changes) in by_lib {
        n += changes.len();
        set_lib(&state, &w, &id, &changes).await?;
    }
    Ok(n)
}

#[tauri::command]
pub async fn backend_run_task(state: State<'_, AppState>, task_id: String) -> Result<()> {
    state.writer().await?.run_task(&task_id).await
}

#[tauri::command]
pub fn set_lock_edits(state: State<'_, AppState>, value: bool) -> Result<()> {
    state.update_settings(|s| s.lock_edits = value)
}

/// Locks (or unlocks) every show and movie (or only `ids`) at once, e.g. after cleaning up the library.
/// Each title is one History entry. Returns how many changed.
#[tauri::command]
pub async fn lock_all(app: tauri::AppHandle, state: State<'_, AppState>, lock: bool, ids: Option<Vec<String>>) -> Result<usize> {
    use tauri::Emitter;
    let w = state.writer().await?;
    let items = w
        .reader()
        .items_query(vec![("IncludeItemTypes", "Movie,Series".into()), ("Recursive", "true".into()), ("Fields", "LockData".into())], 50_000)
        .await?;
    let todo: Vec<String> = items
        .iter()
        .filter(|v| v.get("LockData").and_then(Value::as_bool).unwrap_or(false) != lock)
        .map(|v| s(v, "Id").replace('-', ""))
        .filter(|i| valid_item_id(i))
        // Only these titles, when given (the library wall's selection).
        .filter(|i| ids.as_ref().map(|l| l.iter().any(|x| x == i)).unwrap_or(true))
        .collect();
    let total = todo.len();
    crate::cancel::begin("bulk");
    let mut n = 0;
    for (i, id) in todo.iter().enumerate() {
        if crate::cancel::stopped("bulk") {
            break;
        }
        let _ = app.emit("bulk-progress", json!({ "done": i, "total": total }));
        let old = w.reader().item_json(id).await?;
        let mut new = old.clone();
        new["LockData"] = Value::Bool(lock);
        let entry = state.store()?.journal_add("item_update", id, &old.to_string(), &new.to_string())?;
        if let Err(e) = w.update_item(id, &new).await {
            state.store()?.journal_delete(entry)?;
            return Err(e);
        }
        n += 1;
    }
    Ok(n)
}

/// Asks Jellyfin to look only at these folders (relative to the library folder), or at
/// everything when that isn't possible (no folders given, or no known path mapping).
#[tauri::command]
pub async fn scan_folders(state: State<'_, AppState>, folders: Vec<String>) -> Result<String> {
    let c = state.reader().await?;
    let settings = state.settings()?;
    let paths: Option<Vec<String>> = (|| {
        let map = settings.path_map.as_ref()?;
        let root = settings.library_root.as_ref()?;
        if folders.is_empty() || folders.len() > 100 {
            return None;
        }
        folders
            .iter()
            .map(|rel| {
                crate::fsops::safe_rel(rel).ok()?;
                let local = Path::new(root).join(rel);
                media_tools::to_server(map, &local)
            })
            .collect()
    })();
    match paths {
        Some(p) if c.media_updated(&p).await.is_ok() => Ok("folders".into()),
        _ => {
            c.library_scan().await?;
            Ok("all".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn library_rows_compare_with_recommended() {
        let folders = json!([
            { "Name": "TV", "ItemId": "0123456789abcdef0123456789abcdef", "CollectionType": "tvshows",
              "LibraryOptions": { "AutomaticRefreshIntervalDays": 30, "EnableRealtimeMonitor": true, "MetadataSavers": ["Nfo"], "SubtitleDownloadLanguages": ["eng"] } },
            { "Name": "Music", "ItemId": "fedcba9876543210fedcba9876543210", "CollectionType": "music", "LibraryOptions": {} }
        ]);
        let rows = lib_rows(folders.as_array().unwrap());
        assert_eq!(rows.len(), LIB_TUNES.len(), "music is left alone");
        let get = |k: &str| rows.iter().find(|r| r.key == k).unwrap();
        assert!(!get("AutomaticRefreshIntervalDays").ok);
        assert!(get("EnableRealtimeMonitor").ok);
        assert!(get("MetadataSavers").ok);
        assert!(!get("SubtitleDownloadLanguages").ok);
        assert!(!get("ExtractChapterImagesDuringLibraryScan").ok, "missing counts as not set");
    }

    #[test]
    fn schedules_read_nicely() {
        assert_eq!(schedule_text(&json!([])), "Never (only when started)");
        assert_eq!(schedule_text(&json!([{ "Type": "DailyTrigger", "TimeOfDayTicks": 9_000_000_000i64 * 12 }])), "Daily at 03:00");
        assert_eq!(schedule_text(&json!([{ "Type": "IntervalTrigger", "IntervalTicks": 36_000_000_000i64 * 12 }])), "Every 12 hours");
    }

    #[test]
    fn versions() {
        assert!(version_at_least("10.10.3", 10, 10));
        assert!(version_at_least("10.11.0", 10, 10));
        assert!(!version_at_least("10.9.11", 10, 10));
    }
}
