//! Commands for the renamer screen.

use crate::error::{Error, Result};
use crate::fsops::{self, ApplyReport, FolderInfo, UndoReport};
use crate::jellyfin;
use crate::secrets;
use crate::sources::{self, Candidate, Tmdb};
use serde_json::Value;
use crate::planner::{self, MovieMatch, PlanOp, PlanRequest};
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
    /// Movies: also look in sub-folders.
    #[serde(default)]
    recursive: bool,
    /// Where names come from: "auto" | "jellyfin" | "tmdb" | "tvmaze" | "none".
    #[serde(default)]
    source: Option<String>,
    /// A specific match picked by the user, "source:id".
    #[serde(default)]
    match_id: Option<String>,
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
    /// What the files seem to be (from folder and file names).
    guess: String,
    candidates: Vec<Candidate>,
    chosen: Option<Candidate>,
    matched_movies: usize,
}

fn tmdb_client(state: &AppState) -> Option<Tmdb> {
    let s = state.settings().ok()?;
    if !s.has_tmdb {
        return None;
    }
    let key = secrets::load_tmdb().ok().flatten()?;
    Some(Tmdb::new(&key, &s.title_lang))
}

fn year_of(v: &Value) -> Option<i32> {
    v.get("ProductionYear").and_then(Value::as_i64).map(|y| y as i32)
}

async fn tv_candidates(state: &AppState, source: &str, name: &str, year: Option<i32>, warn: &mut Vec<String>) -> Vec<Candidate> {
    let mut all: Vec<Candidate> = Vec::new();
    if matches!(source, "auto" | "jellyfin") {
        if let Ok(store) = state.store() {
            let rows = store.list(Some("series"), None, None, Some(name), "name", 0, 10).unwrap_or_default();
            all.extend(rows.into_iter().map(|r| Candidate {
                source: "jellyfin".into(),
                id: r.id,
                name: r.name,
                year: r.year,
                poster: None,
                score: 0,
                ids: HashMap::new(),
            }));
        }
    }
    let tmdb = tmdb_client(state);
    let online = match source {
        "tmdb" => Some("tmdb"),
        "tvmaze" => Some("tvmaze"),
        "auto" => Some(if tmdb.is_some() { "tmdb" } else { "tvmaze" }),
        _ => None,
    };
    match (online, &tmdb) {
        (Some("tmdb"), Some(t)) => match t.search_tv(name, year).await {
            Ok(c) => all.extend(c),
            Err(e) => warn.push(e.to_string()),
        },
        (Some("tmdb"), None) => warn.push("Add your TMDB key in Settings to match with TMDB.".into()),
        (Some("tvmaze"), _) => match sources::tvmaze_search(name).await {
            Ok(c) => all.extend(c),
            Err(e) => warn.push(e.to_string()),
        },
        _ => {}
    }
    // Stable sort keeps your own Jellyfin library first when scores are equal.
    sources::rank(all, name, year)
}

async fn episode_titles_for(state: &AppState, c: &Candidate) -> Result<HashMap<(u32, u32), String>> {
    match c.source.as_str() {
        "jellyfin" => Ok(jellyfin::episode_titles(&state.reader().await?.episodes(&c.id).await?)),
        "tmdb" => tmdb_client(state).ok_or_else(|| Error::msg("No TMDB key."))?.episodes(&c.id).await,
        "tvmaze" => sources::tvmaze_episodes(&c.id).await,
        _ => Ok(HashMap::new()),
    }
}

async fn movie_candidates(state: &AppState, name: &str, year: Option<i32>) -> Result<Vec<Candidate>> {
    if let Some(t) = tmdb_client(state) {
        return Ok(sources::rank(t.search_movie(name, year).await?, name, year));
    }
    // Without a TMDB key, ask Jellyfin's own TMDB lookup.
    let found = state.reader().await?.remote_search("movie", name, year, &HashMap::new()).await?;
    let list = found
        .iter()
        .map(|r| Candidate {
            source: "jellyfin".into(),
            id: String::new(),
            name: r.get("Name").and_then(Value::as_str).unwrap_or("").to_string(),
            year: year_of(r),
            poster: r.get("ImageUrl").and_then(Value::as_str).map(String::from),
            score: 0,
            ids: r
                .get("ProviderIds")
                .and_then(Value::as_object)
                .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.to_lowercase(), v.to_string()))).collect())
                .unwrap_or_default(),
        })
        .collect();
    Ok(sources::rank(list, name, year))
}

const MAX_MOVIE_LOOKUPS: usize = 150;

#[tauri::command]
pub async fn plan_rename(state: State<'_, AppState>, args: PlanArgs) -> Result<PlanResult> {
    let root = state.library_root()?;
    fsops::safe_rel(&args.req.folder)?;
    let PlanArgs { mode, mut req, recursive, source, match_id } = args;
    let source = source.unwrap_or_else(|| "auto".into());

    let (root2, folder) = (root.clone(), req.folder.clone());
    let recurse = mode == "tv" || recursive;
    let files = blocking(move || fsops::scan_files(&root2, &folder, recurse)).await?;

    let mut warn: Vec<String> = Vec::new();
    let mut candidates = Vec::new();
    let mut chosen: Option<Candidate> = None;
    let mut titles = HashMap::new();
    let mut movie_matches: HashMap<String, MovieMatch> = HashMap::new();
    let mut movie_scores: HashMap<String, u8> = HashMap::new();
    let guess;

    if mode == "tv" {
        let (gname, gyear) = planner::guess_show(&req.folder, &files);
        let name = req.show.clone().filter(|s| !s.trim().is_empty()).unwrap_or(gname);
        let year = req.year.or(gyear);
        guess = format!("{name}{}", year.map(|y| format!(" ({y})")).unwrap_or_default());
        if source != "none" && !name.trim().is_empty() {
            candidates = tv_candidates(&state, &source, &name, year, &mut warn).await;
            chosen = match &match_id {
                Some(m) => candidates.iter().find(|c| format!("{}:{}", c.source, c.id) == *m).cloned(),
                None => candidates.first().filter(|c| c.score >= 60).cloned(),
            };
        }
        if let Some(c) = &chosen {
            match episode_titles_for(&state, c).await {
                Ok(t) => titles = t,
                Err(e) => warn.push(format!("Episode titles could not be loaded ({e}).")),
            }
            if req.show.as_deref().map(|s| s.trim().is_empty()).unwrap_or(true) {
                req.show = Some(c.name.clone());
            }
            if req.year.is_none() {
                req.year = c.year;
            }
            req.ids = c.ids.clone();
        } else if source != "none" {
            warn.push("No confident match found online; names come from the files. Pick a match or type the name.".into());
        }
    } else {
        guess = String::new();
        if source != "none" {
            let mut cache: HashMap<(String, Option<i32>), Option<Candidate>> = HashMap::new();
            let videos: Vec<&String> = files.iter().filter(|f| crate::naming::is_video(f)).collect();
            if videos.len() > MAX_MOVIE_LOOKUPS {
                warn.push(format!("Only the first {MAX_MOVIE_LOOKUPS} movies were looked up online; pick a smaller folder for the rest."));
            }
            for f in videos.into_iter().take(MAX_MOVIE_LOOKUPS) {
                let (name, year) = planner::movie_guess(f, &req.folder);
                if name.trim().is_empty() {
                    continue;
                }
                let key = (name.to_lowercase(), year);
                if !cache.contains_key(&key) {
                    let best = match movie_candidates(&state, &name, year).await {
                        Ok(list) => list.into_iter().next().filter(|c| c.score >= 70),
                        Err(e) => {
                            warn.push(e.to_string());
                            break;
                        }
                    };
                    cache.insert(key.clone(), best);
                }
                if let Some(Some(c)) = cache.get(&key) {
                    movie_matches.insert(f.clone(), MovieMatch { title: c.name.clone(), year: c.year, tmdb: c.ids.get("tmdb").cloned() });
                    movie_scores.insert(f.clone(), c.score);
                }
            }
        }
    }

    let titles_found = titles.len();
    let matched_movies = movie_matches.len();
    let root3 = root.clone();
    let (mode2, titles2, chosen_score) = (mode.clone(), titles.clone(), chosen.as_ref().map(|c| c.score));
    let mut ops = blocking(move || {
        let exists = |rel: &str| fsops::exists(&root3, rel);
        let ops = if mode2 == "tv" {
            planner::plan_tv(&files, &req, &titles2, &exists)
        } else {
            planner::plan_movies(&files, &req, &movie_matches, &exists)
        };
        ops.map_err(Error::Msg)
    })
    .await?;

    for op in ops.iter_mut().filter(|o| o.kind == "video") {
        op.score = if mode == "tv" {
            chosen_score.map(|s| {
                let known = !titles.is_empty() && op.season.map(|se| op.episodes.iter().all(|e| titles.contains_key(&(se, *e)))).unwrap_or(false);
                if known { s } else { s.min(60) }
            })
        } else {
            movie_scores.get(&op.from).copied()
        };
    }

    let count = |s: &str| ops.iter().filter(|o| o.status == s).count();
    let result = PlanResult {
        plan_id: stamp(),
        ok: count("ok"),
        unchanged: count("unchanged"),
        conflict: count("conflict"),
        unparsed: count("unparsed"),
        titles_found,
        warning: (!warn.is_empty()).then(|| warn.join(" ")),
        ops: ops.clone(),
        guess,
        candidates: candidates.into_iter().take(8).collect(),
        chosen,
        matched_movies,
    };
    state.set_plan(StoredPlan { id: result.plan_id.clone(), root, ops })?;
    Ok(result)
}

/// Runs the plan that was last previewed (and only that one).
#[tauri::command]
pub async fn apply_plan(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    remove_empty: bool,
    selected: Option<Vec<String>>,
) -> Result<ApplyReport> {
    let mut plan = state.take_plan(&plan_id)?;
    if let Some(sel) = selected {
        // Only the rows you left ticked. A subtitle follows its video.
        let picked: std::collections::HashSet<String> = sel.into_iter().collect();
        let video_targets: Vec<(String, String)> = plan
            .ops
            .iter()
            .filter(|o| o.kind == "video" && picked.contains(&o.from))
            .map(|o| {
                let (d, n) = crate::naming::split_path(&o.from);
                (d.to_string(), crate::naming::split_ext(n).0.to_string())
            })
            .collect();
        plan.ops.retain(|o| {
            picked.contains(&o.from)
                || (o.kind == "sidecar" && {
                    let (d, n) = crate::naming::split_path(&o.from);
                    video_targets.iter().any(|(vd, vs)| vd == d && n.starts_with(&format!("{vs}.")))
                })
        });
    }
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
