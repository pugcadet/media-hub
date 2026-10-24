//! Commands for the renamer screen.

use crate::error::{Error, Result};
use crate::fsops::{self, ApplyReport, FolderInfo, UndoReport};
use crate::jellyfin;
use crate::planner::{self, PlanOp, PlanRequest};
use crate::state::{AppState, StoredPlan};
use crate::store::BatchInfo;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

fn stamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_else(|_| "0".into())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::msg(format!("Background task failed: {e}")))?
}

/// Opens the system folder picker. Returns the chosen folder, or None if cancelled.
#[tauri::command]
pub async fn pick_library_root(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>> {
    let picked = blocking(move || Ok(app.dialog().file().blocking_pick_folder())).await?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp
        .into_path()
        .map_err(|_| Error::msg("That folder cannot be used."))?;
    if !path.is_dir() {
        return Err(Error::msg("That is not a folder."));
    }
    let s = path.to_string_lossy().into_owned();
    let saved = s.clone();
    state.update_settings(move |st| st.library_root = Some(saved))?;
    Ok(Some(s))
}

#[tauri::command]
pub async fn list_folders(state: State<'_, AppState>, folder: String) -> Result<Vec<FolderInfo>> {
    let root = state.library_root()?;
    blocking(move || fsops::list_folders(&root, &folder)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanArgs {
    /// "tv" | "movie"
    mode: String,
    #[serde(flatten)]
    req: PlanRequest,
    /// Jellyfin series to take episode titles from (TV only).
    series_id: Option<String>,
    /// Movies: also look in sub-folders.
    #[serde(default)]
    recursive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResult {
    plan_id: String,
    ops: Vec<PlanOp>,
    ok: usize,
    unchanged: usize,
    conflict: usize,
    unparsed: usize,
    titles_found: usize,
    warning: Option<String>,
}

#[tauri::command]
pub async fn plan_rename(state: State<'_, AppState>, args: PlanArgs) -> Result<PlanResult> {
    let root = state.library_root()?;
    fsops::safe_rel(&args.req.folder)?;

    let mut warning = None;
    let mut titles = HashMap::new();
    if args.mode == "tv" {
        if let Some(id) = args.series_id.as_deref().filter(|s| !s.is_empty()) {
            match state.client()? {
                Some(client) => match client.episodes(id).await {
                    Ok(eps) => titles = jellyfin::episode_titles(&eps),
                    Err(e) => warning = Some(format!("Episode titles could not be loaded from Jellyfin ({e}). Names from the files are used.")),
                },
                None => warning = Some("Not connected to Jellyfin, so episode titles come from the file names.".into()),
            }
        }
    }

    let titles_found = titles.len();
    let root2 = root.clone();
    let PlanArgs { mode, req, recursive, .. } = args;
    let ops = blocking(move || {
        let recurse = mode == "tv" || recursive;
        let files = fsops::scan_files(&root2, &req.folder, recurse)?;
        let exists = |rel: &str| fsops::exists(&root2, rel);
        let ops = if mode == "tv" {
            planner::plan_tv(&files, &req, &titles, &exists)
        } else {
            planner::plan_movies(&files, &req, &exists)
        };
        ops.map_err(Error::Msg)
    })
    .await?;

    let count = |s: &str| ops.iter().filter(|o| o.status == s).count();
    let result = PlanResult {
        plan_id: stamp(),
        ok: count("ok"),
        unchanged: count("unchanged"),
        conflict: count("conflict"),
        unparsed: count("unparsed"),
        titles_found,
        warning,
        ops: ops.clone(),
    };
    state.set_plan(StoredPlan { id: result.plan_id.clone(), root, ops })?;
    Ok(result)
}

/// Runs the plan that was last previewed (and only that one).
#[tauri::command]
pub async fn apply_plan(app: AppHandle, state: State<'_, AppState>, plan_id: String, remove_empty: bool) -> Result<ApplyReport> {
    let plan = state.take_plan(&plan_id)?;
    let batch = stamp();
    blocking(move || {
        use tauri::Manager;
        let st = app.state::<AppState>();
        let store = st.store()?;
        fsops::apply(&plan.root, &plan.ops, &store, &batch, remove_empty)
    })
    .await
}

#[tauri::command]
pub fn rename_history(state: State<'_, AppState>) -> Result<Vec<BatchInfo>> {
    state.store()?.journal_batches(30)
}

#[tauri::command]
pub async fn undo_rename(app: AppHandle, batch: String) -> Result<UndoReport> {
    blocking(move || {
        use tauri::Manager;
        let st = app.state::<AppState>();
        let store = st.store()?;
        fsops::undo(&store, &batch)
    })
    .await
}
