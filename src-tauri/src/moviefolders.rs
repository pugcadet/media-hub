//! Renamer → Folders → Movie folders. Asks Jellyfin which movie every video file is, then
//! looks at the folder it sits in:
//! - its own folder with the wrong name ("Alien.1979.1080p") → "Alien (1979)";
//! - loose next to other movies → a folder of its own;
//! - inside a collection folder ("Movies/Alien Collection/…") → stay there (each in its own
//!   folder, and the collection folder can be renamed) or move out into the main folder.
//! Nothing moves until applied; it's one batch History can undo.

use crate::error::{Error, Result};
use crate::fsops;
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::naming::{is_video, sanitize, split_ext};
use crate::planner::PlanOp;
use crate::state::{AppState, StoredPlan};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use tauri::State;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MovieFolder {
    pub id: String,
    pub title: String,
    pub year: Option<i64>,
    /// The video file, relative to the library folder.
    pub video: String,
    /// The folder it's in.
    pub folder: String,
    /// The main folder it belongs to ("Movies").
    pub top: String,
    /// "own" (a folder of its own) | "shared" (next to other movies) | "loose" (straight in the main folder)
    pub kind: &'static str,
    /// The collection folder it sits in, when it's deeper than the main folder.
    pub group: Option<String>,
    /// The folder name it should have: "Alien (1979)" (keeping an id tag that's there).
    pub expected: String,
    /// Already in a folder of its own with the right name.
    pub ok: bool,
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)[\[{](?:tmdbid|imdbid|tvdbid|tmdb|imdb)[-=][A-Za-z0-9]+[\]}]").expect("tag pattern"))
}

/// "Alien (1979)", plus the id tag the current folder already has ("[tmdbid-348]").
pub fn expected_name(title: &str, year: Option<i64>, current: &str) -> String {
    let base = match year {
        Some(y) => format!("{} ({y})", title.trim()),
        None => title.trim().to_string(),
    };
    let tag = tag_re().find(current).map(|m| format!(" {}", m.as_str())).unwrap_or_default();
    sanitize(&format!("{base}{tag}"))
}

fn parent(rel: &str) -> &str {
    rel.rsplit_once('/').map(|x| x.0).unwrap_or("")
}

fn last(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Sorts the movies into own / shared / loose, with their collection folder (pure, for tests).
pub fn classify(movies: Vec<(String, String, Option<i64>, String)>) -> Vec<MovieFolder> {
    // How many different movies sit in each folder (extra parts of one movie don't count).
    let mut per_dir: HashMap<String, HashSet<String>> = HashMap::new();
    for (id, _, _, video) in &movies {
        per_dir.entry(parent(video).to_string()).or_default().insert(id.clone());
    }
    let mut out = Vec::new();
    for (id, title, year, video) in movies {
        let folder = parent(&video).to_string();
        let top = video.split('/').next().unwrap_or("").to_string();
        if folder.is_empty() || top.is_empty() || top == video {
            continue; // straight in the library folder: nothing sensible to suggest
        }
        let shared = per_dir.get(&folder).map(|s| s.len() > 1).unwrap_or(false);
        let kind = if folder == top { "loose" } else if shared { "shared" } else { "own" };
        let group = match kind {
            "own" => Some(parent(&folder).to_string()).filter(|g| g != &top && !g.is_empty()),
            "shared" => Some(folder.clone()),
            _ => None,
        };
        let expected = expected_name(&title, year, if kind == "own" { last(&folder) } else { "" });
        if expected.is_empty() {
            continue;
        }
        let ok = kind == "own" && last(&folder) == expected;
        out.push(MovieFolder { id, title, year, video, folder, top, kind, group, expected, ok });
    }
    out.sort_by(|a, b| a.video.to_lowercase().cmp(&b.video.to_lowercase()));
    out
}

#[tauri::command]
pub async fn movie_folders(state: State<'_, AppState>) -> Result<Vec<MovieFolder>> {
    let root = state.library_root()?;
    let c = state.reader().await?;
    let items = c
        .items_query(
            vec![
                ("IncludeItemTypes", "Movie".into()),
                ("Recursive", "true".into()),
                ("Fields", "Path,ProductionYear".into()),
                ("EnableImages", "false".into()),
                ("EnableUserData", "false".into()),
            ],
            20_000,
        )
        .await?;
    let mut movies = Vec::new();
    for v in &items {
        let id = v.get("Id").and_then(Value::as_str).unwrap_or("").replace('-', "");
        let (Some(server), Some(title)) = (v.get("Path").and_then(Value::as_str), v.get("Name").and_then(Value::as_str)) else { continue };
        if !valid_item_id(&id) || !is_video(last(server.trim_end_matches(['/', '\\']))) {
            continue; // disc folders (VIDEO_TS, BDMV) are left alone
        }
        let Ok(local_path) = local::to_local(&state, server) else { continue };
        let Some(rel) = local::rel_to_root(&root, &local_path) else { continue };
        movies.push((id, title.to_string(), v.get("ProductionYear").and_then(Value::as_i64), rel));
    }
    Ok(classify(movies))
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MovieMove {
    pub video: String,
    /// "fix" (stays where it is, in a folder of its own with the right name) | "out" (into the main folder)
    pub mode: String,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GroupRename {
    pub folder: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoviePlan {
    plan_id: String,
    ops: Vec<PlanOp>,
}

fn op(from: String, to: String, kind: &'static str, title: Option<String>, taken: &mut HashSet<String>, root: &Path) -> PlanOp {
    // A change in capitals only ("alien" → "Alien") is the same entry on a Mac: no clash.
    let same = from.to_lowercase() == to.to_lowercase();
    let clash = (!same && fsops::exists(root, &to)) || !taken.insert(to.to_lowercase());
    PlanOp {
        from,
        to: to.clone(),
        kind,
        status: if clash { "conflict" } else { "ok" },
        note: clash.then(|| "Something with that name is already there.".into()),
        season: None,
        episodes: vec![],
        verified: true,
        score: None,
        step_to: to,
        title,
    }
}

/// Files that belong to a video: same name start (subtitles "x.en.srt", "x.nfo", "x-poster.jpg").
fn sidecars(root: &Path, video: &str) -> Vec<String> {
    let dir = parent(video);
    let stem = split_ext(last(video)).0.to_string();
    let Ok(rd) = std::fs::read_dir(root.join(dir)) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != last(video) && n.starts_with(&stem) && !is_video(n))
        .map(|n| if dir.is_empty() { n } else { format!("{dir}/{n}") })
        .collect()
}

/// The moves for what you chose. Files first, then movie folders, then collection folders.
pub fn plan(root: &Path, movies: &[MovieFolder], moves: &[MovieMove], groups: &[GroupRename]) -> Result<Vec<PlanOp>> {
    let by_video: HashMap<&str, &MovieFolder> = movies.iter().map(|m| (m.video.as_str(), m)).collect();
    let mut taken = HashSet::new();
    let (mut files, mut folders) = (Vec::new(), Vec::new());
    for mv in moves {
        let Some(m) = by_video.get(mv.video.as_str()) else { continue };
        fsops::safe_rel(&m.video)?;
        let out = mv.mode == "out";
        if m.kind == "own" {
            // The whole folder moves (or is renamed): extras and posters inside go along.
            let to_parent = if out { m.top.clone() } else { parent(&m.folder).to_string() };
            let to = format!("{to_parent}/{}", m.expected);
            if to != m.folder {
                folders.push(op(m.folder.clone(), to, "folder", Some(m.title.clone()), &mut taken, root));
            }
        } else {
            // A loose video: into a new folder of its own, with its subtitles.
            let to_parent = if out || m.kind == "loose" { m.top.clone() } else { m.folder.clone() };
            let to_dir = format!("{to_parent}/{}", m.expected);
            files.push(op(m.video.clone(), format!("{to_dir}/{}", last(&m.video)), "video", Some(m.title.clone()), &mut taken, root));
            for s in sidecars(root, &m.video) {
                files.push(op(s.clone(), format!("{to_dir}/{}", last(&s)), "sidecar", None, &mut taken, root));
            }
        }
    }
    let mut renames = Vec::new();
    for g in groups {
        fsops::safe_rel(&g.folder)?;
        let name = sanitize(g.name.trim());
        if name.is_empty() || name == last(&g.folder) || !movies.iter().any(|m| m.group.as_deref() == Some(g.folder.as_str())) {
            continue;
        }
        renames.push(op(g.folder.clone(), format!("{}/{name}", parent(&g.folder)), "folder", Some(name.clone()), &mut taken, root));
    }
    let mut ops = files;
    ops.extend(folders);
    ops.extend(renames);
    Ok(ops)
}

#[tauri::command]
pub async fn movie_folders_plan(state: State<'_, AppState>, moves: Vec<MovieMove>, groups: Vec<GroupRename>) -> Result<MoviePlan> {
    if moves.len() > 20_000 || groups.len() > 5_000 {
        return Err(Error::msg("bad request"));
    }
    let root = state.library_root()?;
    let movies = movie_folders(state.clone()).await?;
    let r2 = root.clone();
    let ops = tauri::async_runtime::spawn_blocking(move || plan(&r2, &movies, &moves, &groups)).await.map_err(|e| Error::msg(e.to_string()))??;
    let plan_id = format!("moviefolders-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    state.set_plan(StoredPlan { id: plan_id.clone(), root, ops: ops.clone() })?;
    Ok(MoviePlan { plan_id, ops })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, title: &str, year: i64, video: &str) -> (String, String, Option<i64>, String) {
        (id.into(), title.into(), Some(year), video.into())
    }

    #[test]
    fn sorts_movies_by_their_folders() {
        let list = classify(vec![
            m("a", "Alien", 1979, "Movies/Alien Collection/Alien.1979.1080p/Alien.1979.1080p.mkv"),
            m("b", "Aliens", 1986, "Movies/Alien Collection/Aliens (1986)/Aliens (1986).mkv"),
            m("c", "Heat", 1995, "Movies/Heat (1995) [tmdbid-949]/Heat.mkv"),
            m("d", "Dune", 2021, "Movies/Dune.2021.mkv"),
            m("e", "Up", 2009, "Movies/Pixar/Up.mkv"),
            m("f", "Coco", 2017, "Movies/Pixar/Coco.mkv"),
        ]);
        let get = |id: &str| list.iter().find(|x| x.id == id).unwrap();
        assert_eq!(get("a").kind, "own");
        assert_eq!(get("a").group.as_deref(), Some("Movies/Alien Collection"));
        assert_eq!(get("a").expected, "Alien (1979)");
        assert!(!get("a").ok);
        assert!(get("b").ok);
        assert_eq!(get("c").expected, "Heat (1995) [tmdbid-949]", "the id tag stays");
        assert!(get("c").ok);
        assert_eq!(get("c").group, None);
        assert_eq!(get("d").kind, "loose");
        assert_eq!(get("e").kind, "shared");
        assert_eq!(get("e").group.as_deref(), Some("Movies/Pixar"));
    }

    #[test]
    fn plans_keep_out_and_collection_rename() {
        let root = std::env::temp_dir().join(format!("mh-moviefolders-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for f in ["Movies/Alien Collection/Alien.1979.1080p/Alien.1979.1080p.mkv", "Movies/Pixar/Up.mkv", "Movies/Pixar/Up.en.srt", "Movies/Pixar/Coco.mkv"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let movies = classify(vec![
            m("a", "Alien", 1979, "Movies/Alien Collection/Alien.1979.1080p/Alien.1979.1080p.mkv"),
            m("e", "Up", 2009, "Movies/Pixar/Up.mkv"),
            m("f", "Coco", 2017, "Movies/Pixar/Coco.mkv"),
        ]);
        let moves = vec![
            MovieMove { video: "Movies/Alien Collection/Alien.1979.1080p/Alien.1979.1080p.mkv".into(), mode: "fix".into() },
            MovieMove { video: "Movies/Pixar/Up.mkv".into(), mode: "fix".into() },
            MovieMove { video: "Movies/Pixar/Coco.mkv".into(), mode: "out".into() },
        ];
        let groups = vec![GroupRename { folder: "Movies/Alien Collection".into(), name: "Alien".into() }];
        let ops = plan(&root, &movies, &moves, &groups).unwrap();
        let pairs: Vec<(&str, &str)> = ops.iter().map(|o| (o.from.as_str(), o.to.as_str())).collect();
        assert!(pairs.contains(&("Movies/Pixar/Up.mkv", "Movies/Pixar/Up (2009)/Up.mkv")));
        assert!(pairs.contains(&("Movies/Pixar/Up.en.srt", "Movies/Pixar/Up (2009)/Up.en.srt")));
        assert!(pairs.contains(&("Movies/Pixar/Coco.mkv", "Movies/Coco (2017)/Coco.mkv")));
        assert!(pairs.contains(&("Movies/Alien Collection/Alien.1979.1080p", "Movies/Alien Collection/Alien (1979)")));
        // The collection folder is renamed last, after the movies inside it.
        assert_eq!(ops.last().map(|o| (o.from.as_str(), o.to.as_str())), Some(("Movies/Alien Collection", "Movies/Alien")));
        assert!(ops.iter().all(|o| o.status == "ok"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
