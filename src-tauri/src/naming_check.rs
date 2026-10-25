//! "Which shows and movies are named wrong, and why": runs the renamer's preview for every
//! show and movie Jellyfin knows (nothing is renamed), using Jellyfin's own identification
//! as the match. A title Jellyfin has identified with all episodes found counts as a sure
//! match, so it can be renamed in bulk safely.

use crate::error::{Error, Result};
use crate::local;
use crate::naming::{is_video, split_path};
use crate::planner::{PlanOp, PlanRequest};
use crate::rename_cmds::{make_plan, PlanArgs};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    pub id: String,
    /// "series" | "movie"
    pub kind: String,
    pub name: String,
    pub year: Option<i32>,
    /// Folder the renamer works on (relative to the library folder).
    pub folder: String,
    /// Movies: the movie file.
    pub file: Option<String>,
    pub to_rename: usize,
    pub folders: usize,
    pub problems: usize,
    pub right: usize,
    /// Identified in Jellyfin and every file found: safe to rename in bulk.
    pub sure: bool,
    pub reasons: Vec<String>,
    pub example: Option<(String, String)>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub at: i64,
    pub rows: Vec<CheckRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: usize,
    total: usize,
    name: String,
}

fn last(p: &str) -> &str {
    p.rsplit('/').next().unwrap_or(p)
}

/// Turns a preview into a short list of reasons.
pub fn summarize(row: &mut CheckRow, ops: &[PlanOp], matched: bool, is_tv: bool) {
    let videos: Vec<&PlanOp> = ops.iter().filter(|o| o.kind == "video").collect();
    let ok_videos: Vec<&PlanOp> = videos.iter().copied().filter(|o| o.status == "ok").collect();
    let folder_ops: Vec<&PlanOp> = ops.iter().filter(|o| o.kind == "folder" && o.status == "ok").collect();
    let unparsed = ops.iter().filter(|o| o.status == "unparsed").count();
    let conflict = ops.iter().filter(|o| o.status == "conflict").count();
    row.to_rename = ops.iter().filter(|o| o.kind != "folder" && o.status == "ok").count();
    row.folders = folder_ops.len();
    row.problems = unparsed + conflict;
    row.right = ops.iter().filter(|o| o.status == "unchanged").count();
    let mut r = Vec::new();
    if !matched {
        r.push("Not identified in Jellyfin yet: identify it first for a sure rename".to_string());
    }
    for f in folder_ops.iter().take(2) {
        r.push(format!("Folder “{}” should be “{}”", last(&f.from), last(&f.to)));
    }
    if folder_ops.len() > 2 {
        r.push(format!("{} more folders to rename", folder_ops.len() - 2));
    }
    if !ok_videos.is_empty() {
        let what = if is_tv { "episode" } else { "file" };
        r.push(format!("{} {what} name{} to fix", ok_videos.len(), if ok_videos.len() == 1 { "" } else { "s" }));
    }
    let unknown = ok_videos.iter().filter(|o| o.score.map(|s| s < 100).unwrap_or(true)).count();
    if is_tv && matched && unknown > 0 {
        r.push(format!("{unknown} episode{} not in the episode list", if unknown == 1 { "" } else { "s" }));
    }
    if unparsed > 0 {
        r.push(format!("{unparsed} file{} without a season/episode number", if unparsed == 1 { "" } else { "s" }));
    }
    if conflict > 0 {
        r.push(format!("{conflict} would clash with a file that already exists"));
    }
    let moved = ok_videos.iter().filter(|o| o.note.as_deref() == Some("Gets its own folder")).count();
    if moved > 0 {
        r.push("Gets its own folder".to_string());
    }
    row.reasons = r;
    row.example = ok_videos
        .first()
        .map(|o| (last(&o.from).to_string(), last(&o.to).to_string()))
        .or_else(|| folder_ops.first().map(|o| (last(&o.from).to_string(), last(&o.to).to_string())));
    row.sure = matched
        && row.problems == 0
        && (row.to_rename + row.folders) > 0
        && ok_videos.iter().all(|o| o.score == Some(100) && o.verified);
}

fn req(template: &str, folder: &str) -> PlanRequest {
    PlanRequest {
        template: template.to_string(),
        folder: folder.to_string(),
        show: None,
        year: None,
        find_replace: Vec::new(),
        rename_folder: None,
        season_folders: false,
        year_optional: YEAR_OPTIONAL.load(Ordering::SeqCst),
        ids: HashMap::new(),
    }
}

/// Set for the length of one check: shows whose names differ only by a year are fine.
static YEAR_OPTIONAL: AtomicBool = AtomicBool::new(true);

fn args(mode: &str, template: &str, folder: &str, match_id: Option<String>, only_file: Option<String>, item_id: Option<String>) -> PlanArgs {
    PlanArgs {
        mode: mode.to_string(),
        req: req(template, folder),
        recursive: false,
        source: Some(if mode == "tv" { "jellyfin".into() } else { "none".into() }),
        match_id,
        only_file,
        item_id,
    }
}

/// Where a movie should be planned from: its own folder (only video in a sub-folder) or loose.
fn movie_target(root: &Path, file_rel: &str) -> (String, Option<String>) {
    let (dir, _) = split_path(file_rel);
    let videos_here = std::fs::read_dir(root.join(dir))
        .map(|rd| rd.flatten().filter(|e| e.file_name().to_str().map(is_video).unwrap_or(false)).count())
        .unwrap_or(0);
    if !dir.is_empty() && dir.contains('/') && videos_here == 1 {
        // Own folder: plan from its parent so the folder itself can be renamed.
        (split_path(dir).0.to_string(), None)
    } else {
        (dir.to_string(), Some(file_rel.to_string()))
    }
}

async fn check_one(state: &AppState, root: &Path, id: &str, kind: &str, server: &str, matched: bool, tv_tpl: &str, movie_tpl: &str) -> Result<CheckRow> {
    let local = local::to_local(state, server)?;
    let mut row = CheckRow { id: id.to_string(), kind: kind.to_string(), ..Default::default() };
    if kind == "series" {
        let folder = local::rel_to_root(root, &local).ok_or_else(|| Error::msg("Outside the library folder."))?;
        if folder.is_empty() {
            return Err(Error::msg("The show is the library folder itself."));
        }
        row.folder = folder.clone();
        let (res, _, ops) = make_plan(state, args("tv", tv_tpl, &folder, Some(format!("jellyfin:{id}")), None, None)).await?;
        summarize(&mut row, &ops, matched && res.chosen.as_ref().map(|c| c.score >= 100).unwrap_or(false), true);
    } else {
        let file = local::rel_to_root(root, &local).ok_or_else(|| Error::msg("Outside the library folder."))?;
        let (folder, only) = movie_target(root, &file);
        row.folder = folder.clone();
        row.file = Some(file.clone());
        let only = only.or_else(|| Some(file.clone()));
        // Own folder: plan the whole movie folder (only that movie's files are in it).
        let (_, _, ops) = make_plan(state, args("movie", movie_tpl, &folder, None, only, Some(id.to_string()))).await?;
        summarize(&mut row, &ops, matched, false);
    }
    Ok(row)
}

fn saved_path(state: &AppState) -> std::path::PathBuf {
    state.dir.join("naming-check.json")
}

#[tauri::command]
pub fn naming_check_last(state: State<'_, AppState>) -> Result<Option<CheckResult>> {
    let p = saved_path(&state);
    Ok(std::fs::read(&p).ok().and_then(|b| serde_json::from_slice(&b).ok()))
}

#[tauri::command]
pub fn naming_check_cancel() {
    CANCEL.store(true, Ordering::SeqCst);
}

/// Checks every show and movie (or only `ids`). Sends "naming-progress" events while it runs.
#[tauri::command]
pub async fn naming_check(app: AppHandle, tv_template: String, movie_template: String, ids: Option<Vec<String>>, year_optional: Option<bool>) -> Result<CheckResult> {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return Err(Error::msg("A check is already running."));
    }
    YEAR_OPTIONAL.store(year_optional.unwrap_or(true), Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
    let out = run(&app, &tv_template, &movie_template, ids).await;
    RUNNING.store(false, Ordering::SeqCst);
    out
}

async fn run(app: &AppHandle, tv_tpl: &str, movie_tpl: &str, only: Option<Vec<String>>) -> Result<CheckResult> {
    let state = app.state::<AppState>();
    let root = state.library_root()?;
    let mut work: Vec<(String, String, String, Option<i32>, String, bool)> = Vec::new();
    {
        let store = state.store()?;
        for kind in ["series", "movie"] {
            for (id, name, year, path, matched) in store.with_paths(kind)? {
                if only.as_ref().map(|o| o.contains(&id)).unwrap_or(true) {
                    work.push((id, kind.to_string(), name, year, path, matched));
                }
            }
        }
    }
    let total = work.len();
    let mut rows: Vec<CheckRow> = Vec::with_capacity(total);
    for (i, (id, kind, name, year, path, matched)) in work.into_iter().enumerate() {
        if CANCEL.load(Ordering::SeqCst) {
            break;
        }
        let _ = app.emit("naming-progress", Progress { done: i, total, name: name.clone() });
        let mut row = match check_one(&state, &root, &id, &kind, &path, matched, tv_tpl, movie_tpl).await {
            Ok(r) => r,
            Err(e) => CheckRow { id: id.clone(), kind: kind.clone(), error: Some(e.to_string()), ..Default::default() },
        };
        row.name = name;
        row.year = year;
        rows.push(row);
    }
    let _ = app.emit("naming-progress", Progress { done: total, total, name: String::new() });
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    // A partial check (some ids) updates the saved full list.
    let mut result = CheckResult { at, rows };
    if only.is_some() {
        if let Some(prev) = std::fs::read(saved_path(&state)).ok().and_then(|b| serde_json::from_slice::<CheckResult>(&b).ok()) {
            let mut merged = prev.rows;
            for r in result.rows.drain(..) {
                match merged.iter_mut().find(|m| m.id == r.id) {
                    Some(m) => *m = r,
                    None => merged.push(r),
                }
            }
            result.rows = merged;
        }
    }
    if let Ok(b) = serde_json::to_vec(&result) {
        let _ = std::fs::write(saved_path(&state), b);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(from: &str, to: &str, kind: &'static str, status: &'static str, score: Option<u8>) -> PlanOp {
        PlanOp {
            from: from.into(),
            to: to.into(),
            kind,
            status,
            note: None,
            season: Some(1),
            episodes: vec![1],
            verified: true,
            score,
            step_to: to.into(),
            title: None,
        }
    }

    #[test]
    fn sure_only_when_identified_and_every_episode_known() {
        let ops = vec![
            op("TV/bluey/s1e1.mkv", "TV/Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic.mkv", "video", "ok", Some(100)),
            op("TV/bluey", "TV/Bluey (2018)", "folder", "ok", None),
        ];
        let mut r = CheckRow::default();
        summarize(&mut r, &ops, true, true);
        assert!(r.sure);
        assert_eq!((r.to_rename, r.folders, r.problems), (1, 1, 0));
        assert!(r.reasons.iter().any(|x| x.contains("Folder “bluey” should be “Bluey (2018)”")));

        let mut r2 = CheckRow::default();
        summarize(&mut r2, &ops, false, true);
        assert!(!r2.sure, "not identified in Jellyfin");

        let mut ops3 = ops.clone();
        ops3[0].score = Some(60);
        let mut r3 = CheckRow::default();
        summarize(&mut r3, &ops3, true, true);
        assert!(!r3.sure);
        assert!(r3.reasons.iter().any(|x| x.contains("not in the episode list")));
    }

    #[test]
    fn already_right_has_no_reasons() {
        let ops = vec![op("a.mkv", "a.mkv", "video", "unchanged", Some(100))];
        let mut r = CheckRow::default();
        summarize(&mut r, &ops, true, true);
        assert!(!r.sure);
        assert!(r.reasons.is_empty());
        assert_eq!(r.right, 1);
    }

    #[test]
    fn problems_are_counted() {
        let ops = vec![op("x.mkv", "x.mkv", "video", "unparsed", None), op("y.mkv", "z.mkv", "video", "conflict", Some(100))];
        let mut r = CheckRow::default();
        summarize(&mut r, &ops, true, true);
        assert_eq!(r.problems, 2);
        assert!(!r.sure);
    }
}
