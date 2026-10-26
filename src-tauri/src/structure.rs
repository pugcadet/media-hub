//! Folder structure suggestions (Clean-up → Folders): episodes into season folders, loose
//! movies into a folder each, or the other way round (every movie straight in the movies
//! folder). Works on the library folder on this computer; every move is one undoable batch.

use crate::error::{Error, Result};
use crate::naming::{is_video, parse_episode, sanitize, season_from_dir, split_ext};
use crate::planner::PlanOp;
use crate::state::{AppState, StoredPlan};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LooseShow {
    /// Show folder, relative to the library folder.
    pub folder: String,
    pub name: String,
    /// Episodes directly in the show folder (not in a season folder).
    pub loose: usize,
    pub seasons: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopFolder {
    pub folder: String,
    /// "tv" | "movies" | "mixed" | "empty"
    pub kind: &'static str,
    pub shows: Vec<LooseShow>,
    /// Movie files directly in this folder (relative paths).
    pub loose_movies: Vec<String>,
    /// Movies that have a folder of their own (folder relative paths).
    pub foldered_movies: Vec<String>,
}

fn skip(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('@') || name.eq_ignore_ascii_case("#recycle") || name.starts_with(".mediahub")
}

fn rel(root: &Path, p: &Path) -> String {
    crate::local::rel_to_root(root, p).unwrap_or_default()
}

fn list(dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => dirs.push(e.path()),
            Ok(t) if t.is_file() => files.push(e.path()),
            _ => {}
        }
    }
    dirs.sort();
    files.sort();
    (dirs, files)
}

fn name_of(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

fn videos(files: &[PathBuf]) -> Vec<&PathBuf> {
    files.iter().filter(|f| is_video(&name_of(f)) && !name_of(f).to_lowercase().contains("sample")).collect()
}

fn is_episode(p: &Path) -> bool {
    parse_episode(split_ext(&name_of(p)).0, None).is_some()
}

/// Looks at every top folder of the library ("TV", "Movies", "Kids" …).
pub fn scan(root: &Path) -> Vec<TopFolder> {
    let (tops, _) = list(root);
    let mut out = Vec::new();
    for top in tops {
        let (subs, files) = list(&top);
        let mut t = TopFolder { folder: rel(root, &top), kind: "empty", shows: vec![], loose_movies: vec![], foldered_movies: vec![] };
        let mut tv_votes = 0;
        let mut movie_votes = 0;
        for v in videos(&files) {
            if is_episode(v) {
                tv_votes += 1;
            } else {
                movie_votes += 1;
                t.loose_movies.push(rel(root, v));
            }
        }
        for d in subs {
            let (inner_dirs, inner_files) = list(&d);
            let vids = videos(&inner_files);
            let eps = vids.iter().filter(|v| is_episode(v)).count();
            let season_dirs = inner_dirs.iter().filter(|x| season_from_dir(&name_of(x)).is_some()).count();
            if eps > 0 || season_dirs > 0 {
                tv_votes += 1;
                if eps > 0 {
                    t.shows.push(LooseShow { folder: rel(root, &d), name: name_of(&d), loose: eps, seasons: season_dirs });
                }
            } else if vids.len() == 1 && inner_dirs.iter().all(|x| !videos(&list(x).1).iter().any(|_| true) || name_of(x).to_lowercase().contains("extra")) {
                movie_votes += 1;
                t.foldered_movies.push(rel(root, &d));
            } else if !vids.is_empty() {
                movie_votes += 1;
            }
        }
        t.kind = match (tv_votes, movie_votes) {
            (0, 0) => "empty",
            (a, b) if a > 0 && b == 0 => "tv",
            (a, b) if b > 0 && a == 0 => "movies",
            (a, b) if a >= b * 4 => "tv",
            (a, b) if b >= a * 4 => "movies",
            _ => "mixed",
        };
        out.push(t);
    }
    out
}

/// Files that belong to a video: same name start (subtitles "x.en.srt", "x.nfo", "x-thumb.jpg").
fn sidecars(dir: &Path, video: &Path) -> Vec<PathBuf> {
    let stem = split_ext(&name_of(video)).0.to_string();
    list(dir).1.into_iter().filter(|f| f != video && name_of(f).starts_with(&stem) && !is_video(&name_of(f))).collect()
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// "seasons" (path = a show folder) | "movie_folders" | "flatten" (path = a top folder)
    pub kind: String,
    pub path: String,
}

fn safe_rel(p: &str) -> Result<()> {
    if p.is_empty() || p.split('/').any(|x| x == ".." || x == "." || x.is_empty()) || p.starts_with('/') || p.contains('\\') {
        return Err(Error::msg("bad folder"));
    }
    Ok(())
}

fn mv(root: &Path, from: &Path, to_rel: String, kind: &'static str, title: Option<String>) -> PlanOp {
    let exists = root.join(&to_rel).exists();
    PlanOp {
        from: rel(root, from),
        to: to_rel.clone(),
        kind,
        status: if exists { "conflict" } else { "ok" },
        note: exists.then(|| "Something with that name is already there.".into()),
        season: None,
        episodes: vec![],
        verified: true,
        score: None,
        step_to: to_rel,
        title,
    }
}

/// The moves for the chosen actions (nothing moves until applied).
pub fn plan(root: &Path, actions: &[Action]) -> Result<Vec<PlanOp>> {
    let mut ops = Vec::new();
    for a in actions {
        safe_rel(&a.path)?;
        let dir = root.join(&a.path);
        if !dir.is_dir() {
            continue;
        }
        let (subs, files) = list(&dir);
        match a.kind.as_str() {
            "seasons" => {
                for v in videos(&files) {
                    let Some(m) = parse_episode(split_ext(&name_of(v)).0, None) else { continue };
                    let season = if m.season == 0 { "Specials".to_string() } else { format!("Season {:02}", m.season) };
                    let to_dir = format!("{}/{season}", a.path);
                    ops.push(mv(root, v, format!("{to_dir}/{}", name_of(v)), "video", None));
                    for s in sidecars(&dir, v) {
                        ops.push(mv(root, &s, format!("{to_dir}/{}", name_of(&s)), "sidecar", None));
                    }
                }
            }
            "movie_folders" => {
                for v in videos(&files).into_iter().filter(|v| !is_episode(v)) {
                    let (title, year) = crate::planner::movie_guess(&rel(root, v), &a.path);
                    let folder = sanitize(&match year { Some(y) => format!("{title} ({y})"), None => title.clone() });
                    if folder.is_empty() {
                        continue;
                    }
                    let to_dir = format!("{}/{folder}", a.path);
                    ops.push(mv(root, v, format!("{to_dir}/{}", name_of(v)), "video", Some(folder.clone())));
                    for s in sidecars(&dir, v) {
                        ops.push(mv(root, &s, format!("{to_dir}/{}", name_of(&s)), "sidecar", None));
                    }
                }
            }
            "flatten" => {
                for d in subs {
                    let (inner_dirs, inner) = list(&d);
                    let vids = videos(&inner);
                    if vids.len() != 1 || vids.iter().any(|v| is_episode(v)) || inner_dirs.iter().any(|x| season_from_dir(&name_of(x)).is_some()) {
                        continue;
                    }
                    let v = vids[0];
                    ops.push(mv(root, v, format!("{}/{}", a.path, name_of(v)), "video", Some(name_of(&d))));
                    for s in sidecars(&d, v) {
                        ops.push(mv(root, &s, format!("{}/{}", a.path, name_of(&s)), "sidecar", None));
                    }
                }
            }
            _ => return Err(Error::msg("unknown action")),
        }
    }
    Ok(ops)
}

fn root_of(state: &AppState) -> Result<PathBuf> {
    let root = state.settings()?.library_root.map(PathBuf::from).ok_or_else(|| Error::msg("Choose your library folder in Settings first."))?;
    if !root.is_dir() {
        return Err(Error::msg("The library folder can't be reached. Is the NAS connected?"));
    }
    Ok(root)
}

#[tauri::command]
pub async fn structure_scan(state: State<'_, AppState>) -> Result<Vec<TopFolder>> {
    let root = root_of(&state)?;
    tauri::async_runtime::spawn_blocking(move || scan(&root)).await.map_err(|e| Error::msg(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructurePlan {
    plan_id: String,
    ops: Vec<PlanOp>,
}

#[tauri::command]
pub async fn structure_plan(state: State<'_, AppState>, actions: Vec<Action>) -> Result<StructurePlan> {
    let root = root_of(&state)?;
    let r2 = root.clone();
    let ops = tauri::async_runtime::spawn_blocking(move || plan(&r2, &actions)).await.map_err(|e| Error::msg(e.to_string()))??;
    let plan_id = format!("struct-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    state.set_plan(StoredPlan { id: plan_id.clone(), root, ops: ops.clone() })?;
    Ok(StructurePlan { plan_id, ops })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn suggests_and_plans_structure() {
        let root = std::env::temp_dir().join(format!("mh-struct-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        touch(&root, "TV/Bluey/Bluey - S01E01.mkv");
        touch(&root, "TV/Bluey/Bluey - S01E01.en.srt");
        touch(&root, "TV/Bluey/Bluey - S02E01.mkv");
        touch(&root, "TV/Severance/Season 01/Severance - S01E01.mkv");
        touch(&root, "Movies/Heat (1995).mkv");
        touch(&root, "Movies/Heat (1995).nl.srt");
        touch(&root, "Movies/Dune (2021)/Dune (2021).mkv");
        let s = scan(&root);
        let tv = s.iter().find(|t| t.folder == "TV").unwrap();
        assert_eq!(tv.kind, "tv");
        assert_eq!(tv.shows.len(), 1, "{tv:?}");
        assert_eq!(tv.shows[0].loose, 2);
        let mv = s.iter().find(|t| t.folder == "Movies").unwrap();
        assert_eq!(mv.kind, "movies");
        assert_eq!(mv.loose_movies, vec!["Movies/Heat (1995).mkv".to_string()]);
        assert_eq!(mv.foldered_movies, vec!["Movies/Dune (2021)".to_string()]);

        let ops = plan(&root, &[Action { kind: "seasons".into(), path: "TV/Bluey".into() }]).unwrap();
        assert!(ops.iter().any(|o| o.to == "TV/Bluey/Season 01/Bluey - S01E01.mkv"));
        assert!(ops.iter().any(|o| o.to == "TV/Bluey/Season 01/Bluey - S01E01.en.srt"));
        assert!(ops.iter().any(|o| o.to == "TV/Bluey/Season 02/Bluey - S02E01.mkv"));
        let ops = plan(&root, &[Action { kind: "movie_folders".into(), path: "Movies".into() }]).unwrap();
        assert!(ops.iter().any(|o| o.to == "Movies/Heat (1995)/Heat (1995).mkv"), "{ops:?}");
        assert!(ops.iter().any(|o| o.to == "Movies/Heat (1995)/Heat (1995).nl.srt"));
        let ops = plan(&root, &[Action { kind: "flatten".into(), path: "Movies".into() }]).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(ops[0].to, "Movies/Dune (2021).mkv");
        assert!(plan(&root, &[Action { kind: "flatten".into(), path: "../x".into() }]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
