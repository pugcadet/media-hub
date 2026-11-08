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
use crate::naming::{fuller_title, is_video, parse_name, sanitize, split_ext};
use crate::planner::PlanOp;
use crate::state::{AppState, StoredPlan};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
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
    /// Jellyfin's title doesn't look like the file's name: maybe identified wrong. Never
    /// moved or renamed automatically; identify it first.
    pub doubt: bool,
    /// The Jellyfin collection it's in, as a folder name ("Alien Collection"), when that
    /// collection holds two or more of your movies.
    pub collection: Option<String>,
}

/// "Alien (1979)". Id tags ("[tmdbid-348]") are left out; the file's own fuller name wins
/// when it's the same title with more to it ("Star Wars Episode IV - A New Hope (1977)").
pub fn expected_name(title: &str, year: Option<i64>, video_stem: &str) -> String {
    let title = &crate::naming::title_without_year(title, year);
    let file = parse_name(video_stem);
    let title = if file.year.is_none() || file.year.map(i64::from) == year { fuller_title(title, &file.title) } else { title.trim().to_string() };
    let base = match year {
        Some(y) => format!("{} ({y})", title.trim()),
        None => title.trim().to_string(),
    };
    sanitize(&base)
}

/// Does Jellyfin's title fit the file or folder name? (Catches a wrong identification
/// like "Aliens Special Cut" → "Alien Warrior".)
pub fn fits(title: &str, year: Option<i64>, video_stem: &str, folder: &str) -> bool {
    fn words(t: &str) -> Vec<String> {
        t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty() && *w != "the" && *w != "a").map(str::to_string).collect()
    }
    let want = words(title);
    let close = |name: &str| {
        let p = parse_name(name);
        if let (Some(a), Some(b)) = (p.year.map(i64::from), year) {
            if (a - b).abs() > 1 {
                return false;
            }
        }
        let got = words(&p.title);
        if got.is_empty() || want.is_empty() {
            return false;
        }
        let n = got.len().min(want.len());
        got[..n] == want[..n] || crate::sources::similarity(&p.title, title) >= 0.8
    };
    close(video_stem) || close(folder)
}

/// A folder named after exactly this movie ("Sling Blade (1996)"), not a collection ("Alien Collection").
fn same_movie_folder(title: &str, year: Option<i64>, name: &str) -> bool {
    fn words(t: &str) -> Vec<String> {
        t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
    }
    let p = parse_name(name);
    if let (Some(a), Some(b)) = (p.year.map(i64::from), year) {
        if a != b {
            return false;
        }
    }
    let (got, want) = (words(&p.title), words(title));
    !got.is_empty() && (got == want || crate::sources::similarity(&p.title, title) >= 0.9)
}

fn parent(rel: &str) -> &str {
    rel.rsplit_once('/').map(|x| x.0).unwrap_or("")
}

fn last(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

/// Sorts the movies into own / shared / loose / nested, with their collection folder (pure, for tests).
/// - own: the only movie in its folder, and no other movie anywhere below that folder;
/// - shared: next to other movies, or in a folder that also holds other movies' folders
///   (a collection folder: never renamed as if it were this movie's folder);
/// - nested: its own folder sits inside another folder of the same movie
///   ("Sling Blade (1996)/Sling Blade (1996) [tmdbid-…]/…"): the inner folder goes;
/// - loose: straight in the main folder.
pub fn classify(movies: Vec<(String, String, Option<i64>, String)>) -> Vec<MovieFolder> {
    // How many different movies sit in each folder, and below each folder.
    let mut per_dir: HashMap<String, HashSet<String>> = HashMap::new();
    let mut below: HashMap<String, HashSet<String>> = HashMap::new();
    for (id, _, _, video) in &movies {
        let dir = parent(video).to_string();
        per_dir.entry(dir.clone()).or_default().insert(id.clone());
        let mut d = dir.as_str();
        while !d.is_empty() {
            below.entry(d.to_string()).or_default().insert(id.clone());
            d = parent(d);
        }
    }
    let count = |m: &HashMap<String, HashSet<String>>, k: &str| m.get(k).map(|s| s.len()).unwrap_or(0);
    let mut out = Vec::new();
    for (id, title, year, video) in movies {
        let folder = parent(&video).to_string();
        let top = video.split('/').next().unwrap_or("").to_string();
        if folder.is_empty() || top.is_empty() || top == video {
            continue; // straight in the library folder: nothing sensible to suggest
        }
        let stem = split_ext(last(&video)).0.to_string();
        let alone = count(&per_dir, &folder) <= 1 && count(&below, &folder) <= 1;
        let up = parent(&folder).to_string();
        let mut kind = if folder == top { "loose" } else if alone { "own" } else { "shared" };
        // Its own folder inside a folder that is also just this movie: nested.
        if kind == "own" && up != top && !up.is_empty() && count(&below, &up) <= 1 && same_movie_folder(&title, year, last(&up)) {
            kind = "nested";
        }
        let group = match kind {
            "own" => Some(up.clone()).filter(|g| g != &top && !g.is_empty()),
            "shared" => Some(folder.clone()),
            _ => None,
        };
        let expected = expected_name(&title, year, &stem);
        if expected.is_empty() {
            continue;
        }
        let doubt = !fits(&title, year, &stem, last(&folder));
        let ok = kind == "own" && last(&folder) == expected;
        out.push(MovieFolder { id, title, year, video, folder, top, kind, group, expected, ok, doubt, collection: None });
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
    // (id, title, year, server path) of every movie file; disc folders (VIDEO_TS, BDMV) are left alone.
    let wanted: Vec<(String, &str, Option<i64>, &str)> = items
        .iter()
        .filter_map(|v| {
            let id = v.get("Id").and_then(Value::as_str).unwrap_or("").replace('-', "");
            let (Some(server), Some(title)) = (v.get("Path").and_then(Value::as_str), v.get("Name").and_then(Value::as_str)) else { return None };
            (valid_item_id(&id) && is_video(last(server.trim_end_matches(['/', '\\'])))).then_some((id, title, v.get("ProductionYear").and_then(Value::as_i64), server))
        })
        .collect();
    let servers: Vec<&str> = wanted.iter().map(|w| w.3).collect();
    let locals = local::to_local_many(&state, &servers);
    // Moved here a moment ago (Fix selected) and Jellyfin hasn't looked yet: the place from
    // the move log, so the list shows what's on the NAS now instead of the same suggestions.
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0) - 3 * 86_400;
    let moves = state.store().and_then(|s| s.renames_since(since)).unwrap_or_default();
    let settings = state.settings()?;
    let mut movies = Vec::new();
    for ((id, title, year, server), lp) in wanted.into_iter().zip(locals) {
        let known = settings.path_map.as_ref().and_then(|m| crate::media_tools::map_known(server, m)).and_then(|p| p.strip_prefix(&root).ok().map(|r| r.to_string_lossy().replace('\\', "/")));
        let moved = known.and_then(|r| local::follow_renames(&r, &moves)).filter(|r| root.join(r).is_file());
        let Some(rel) = moved.or_else(|| lp.and_then(|p| local::rel_to_root(&root, &p))) else { continue };
        movies.push((id, title.to_string(), year, rel));
    }
    let mut list = classify(movies);
    // Which collection each movie is in (the smallest one, when it's in several).
    if let Ok(m) = crate::collections::membership(&c).await {
        let named: Vec<(String, Vec<Value>)> = m
            .collections
            .iter()
            .filter_map(|x| {
                let id = x.get("Id").and_then(Value::as_str)?.replace('-', "");
                let name = x.get("Name").and_then(Value::as_str)?.to_string();
                (name != crate::collections::PICKS_NAME).then(|| (name, m.items.get(&id).cloned().unwrap_or_default()))
            })
            .collect();
        let mut member: HashMap<String, (String, usize)> = HashMap::new();
        for (name, items) in named {
            let ids: Vec<String> = items.iter().filter(|v| v.get("Type").and_then(Value::as_str) == Some("Movie")).filter_map(|v| v.get("Id").and_then(Value::as_str).map(|i| i.replace('-', ""))).collect();
            if ids.len() < 2 {
                continue;
            }
            for id in ids {
                let e = member.entry(id).or_insert((name.clone(), usize::MAX));
                if items.len() < e.1 {
                    *e = (name.clone(), items.len());
                }
            }
        }
        for m in &mut list {
            m.collection = member.get(&m.id).map(|(n, _)| sanitize(&crate::inbox::clean_collection(n))).filter(|n| !n.is_empty());
        }
    }
    if let Ok(mut c) = LAST.lock() {
        *c = Some((std::time::Instant::now(), root.clone(), list.clone()));
    }
    Ok(list)
}

/// The list the Folders screen just showed. "Fix selected" plans from it instead of asking
/// Jellyfin and the NAS for every movie again (slow over a VPN). The plan itself still checks
/// every file it moves, and applying checks again.
static LAST: std::sync::Mutex<Option<(std::time::Instant, PathBuf, Vec<MovieFolder>)>> = std::sync::Mutex::new(None);

async fn recent_movie_folders(state: State<'_, AppState>, root: &Path) -> Result<Vec<MovieFolder>> {
    let cached = LAST.lock().ok().and_then(|c| c.clone()).filter(|(at, r, _)| r == root && at.elapsed() < std::time::Duration::from_secs(30 * 60));
    match cached {
        Some((_, _, list)) => Ok(list),
        None => movie_folders(state).await,
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MovieMove {
    pub video: String,
    /// "fix" (stays where it is, in a folder of its own with the right name) | "out" (into the
    /// main folder) | "collect" (into its collection's folder in the main folder)
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

/// "Heat.1995.1080p.en.srt" with the video "Heat.1995.1080p" renamed to "Heat (1995)" → "Heat (1995).en.srt".
fn renamed(name: &str, old_stem: &str, new_stem: &str) -> String {
    match name.strip_prefix(old_stem) {
        Some(rest) if rest.is_empty() || rest.starts_with('.') => format!("{new_stem}{rest}"),
        _ => name.to_string(),
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

/// Subtitles named only by their language ("English.srt", "eng.srt") get the video's name, so
/// Jellyfin and Infuse pick them up: "Movie (1996).eng.srt".
pub(crate) fn language_subs(root: &Path, dir: &str, video_stem: &str, taken: &mut HashSet<String>) -> Vec<PlanOp> {
    const LANGS: &[(&[&str], &str)] = &[
        (&["english", "eng", "en"], "eng"), (&["dutch", "nederlands", "dut", "nld", "nl"], "dut"), (&["french", "francais", "fre", "fra", "fr"], "fre"),
        (&["german", "deutsch", "ger", "deu", "de"], "ger"), (&["spanish", "espanol", "spa", "es"], "spa"), (&["italian", "ita", "it"], "ita"),
    ];
    let Ok(rd) = std::fs::read_dir(root.join(dir)) else { return Vec::new() };
    let mut out = Vec::new();
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        let (stem, ext) = split_ext(&n);
        if !matches!(ext.to_lowercase().as_str(), "srt" | "ass" | "ssa" | "vtt" | "sub") || !e.path().is_file() {
            continue;
        }
        let key = stem.to_lowercase();
        let (base, forced) = key.strip_suffix(".forced").map(|b| (b, true)).unwrap_or((key.as_str(), false));
        if let Some((_, code)) = LANGS.iter().find(|(names, _)| names.contains(&base)) {
            let to = format!("{dir}/{video_stem}.{code}{}.{}", if forced { ".forced" } else { "" }, ext.to_lowercase());
            out.push(op(format!("{dir}/{n}"), to, "sidecar", None, taken, root));
        }
    }
    out
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
        let collect = match (mv.mode.as_str(), &m.collection) {
            ("collect", Some(c)) => Some(format!("{}/{c}", m.top)),
            _ => None,
        };
        if m.doubt {
            continue; // maybe identified wrong: never moved by a batch
        }
        if m.kind == "nested" {
            // Everything in the inner folder moves up into the outer one, which gets the name;
            // the empty inner folder is tidied away afterwards.
            let outer = parent(&m.folder).to_string();
            if let Ok(rd) = std::fs::read_dir(root.join(&m.folder)) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if n.starts_with('.') {
                        continue;
                    }
                    let new = renamed(&n, split_ext(last(&m.video)).0, &m.expected);
                    files.push(op(format!("{}/{n}", m.folder), format!("{outer}/{new}"), if is_video(&n) { "video" } else { "sidecar" }, None, &mut taken, root));
                }
            }
            files.extend(language_subs(root, &outer, &m.expected, &mut taken));
            let to = format!("{}/{}", parent(&outer), m.expected);
            if to != outer {
                folders.push(op(outer.clone(), to, "folder", Some(m.title.clone()), &mut taken, root));
            }
            continue;
        }
        if m.kind == "own" {
            // The whole folder moves (or is renamed): extras and posters inside go along.
            let to_parent = collect.clone().unwrap_or_else(|| if out { m.top.clone() } else { parent(&m.folder).to_string() });
            let to = format!("{to_parent}/{}", m.expected);
            // The video and its subtitles get the same name as the folder (renamed in place first).
            let stem = split_ext(last(&m.video)).0.to_string();
            if stem != m.expected {
                for n in std::iter::once(m.video.clone()).chain(sidecars(root, &m.video)) {
                    let new = renamed(last(&n), &stem, &m.expected);
                    if new != last(&n) {
                        let mut o = op(n.clone(), format!("{to}/{new}"), if is_video(last(&n)) { "video" } else { "sidecar" }, None, &mut taken, root);
                        o.step_to = format!("{}/{new}", m.folder);
                        if o.status == "ok" && fsops::exists(root, &o.step_to) && o.step_to.to_lowercase() != n.to_lowercase() {
                            o.status = "conflict";
                        }
                        files.push(o);
                    }
                }
            }
            files.extend(language_subs(root, &m.folder, &m.expected, &mut taken));
            if to != m.folder {
                folders.push(op(m.folder.clone(), to, "folder", Some(m.title.clone()), &mut taken, root));
            }
        } else {
            // A loose video: into a new folder of its own, with its subtitles.
            let to_parent = collect.clone().unwrap_or_else(|| if out || m.kind == "loose" { m.top.clone() } else { m.folder.clone() });
            let to_dir = format!("{to_parent}/{}", m.expected);
            let stem = split_ext(last(&m.video)).0.to_string();
            files.push(op(m.video.clone(), format!("{to_dir}/{}", renamed(last(&m.video), &stem, &m.expected)), "video", Some(m.title.clone()), &mut taken, root));
            for s in sidecars(root, &m.video) {
                files.push(op(s.clone(), format!("{to_dir}/{}", renamed(last(&s), &stem, &m.expected)), "sidecar", None, &mut taken, root));
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
    let movies = recent_movie_folders(state.clone(), &root).await?;
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
        assert_eq!(get("c").expected, "Heat (1995)", "id tags are left out");
        assert!(!get("c").ok);
        assert_eq!(get("c").group, None);
        assert_eq!(get("d").kind, "loose");
        assert_eq!(get("e").kind, "shared");
        assert_eq!(get("e").group.as_deref(), Some("Movies/Pixar"));
    }

    #[test]
    fn never_swallows_or_nests_movies() {
        let list = classify(vec![
            // A collection folder with one loose movie and another movie's folder inside.
            m("a", "Aliens", 1986, "Movies/Alien Collection/Aliens (1986) Special Cut Remastered.mkv"),
            m("b", "Alien: Romulus", 2024, "Movies/Alien Collection/Alien - Romulus (2024)/Alien Romulus.mkv"),
            // A movie folder inside a folder of the same movie.
            m("c", "Sling Blade", 1996, "Movies/Sling Blade (1996)/Sling Blade (1996) [tmdbid-12498]/Sling Blade Directors Cut (1996).mp4"),
            // A one-movie collection folder is not "the same movie".
            m("d", "Alien", 1979, "Movies/Alien Saga/Alien (1979)/Alien.mkv"),
            // Identified wrong.
            m("e", "Alien Warrior", 1986, "Movies/Aliens (1986)/Aliens (1986) Special Cut Remastered.mkv"),
            // Fuller name from the file.
            m("f", "Star Wars", 1977, "Movies/Star Wars Collection/Star Wars (1977)/Star Wars Episode IV - A New Hope (1977).mkv"),
            m("g", "Return of the Jedi", 1983, "Movies/Star Wars Collection/Return of the Jedi (1983)/Return of the Jedi (1983).mkv"),
            // Jellyfin couldn't look it up and kept the year in the name; a folder already doubled.
            m("h", "Prometheus (2012)", 2012, "Movies/Alien Collection/Prometheus (2012) (2012)/Prometheus (2012).mkv"),
        ]);
        let get = |id: &str| list.iter().find(|x| x.id == id).unwrap();
        assert_eq!(get("a").kind, "shared", "the collection folder isn't Aliens' own folder");
        assert_eq!(get("a").group.as_deref(), Some("Movies/Alien Collection"));
        assert_eq!(get("a").expected, "Aliens (1986)");
        assert_eq!(get("b").kind, "own");
        assert_eq!(get("c").kind, "nested");
        assert_eq!(get("c").expected, "Sling Blade (1996)");
        assert_eq!(get("d").kind, "own");
        assert!(get("e").doubt);
        assert!(!get("a").doubt && !get("c").doubt && !get("f").doubt);
        assert_eq!(get("f").expected, "Star Wars Episode IV - A New Hope (1977)");
        assert!(get("g").ok);
        assert_eq!(get("h").expected, "Prometheus (2012)");
        assert!(!get("h").ok, "the doubled year gets fixed");
    }

    #[test]
    fn nested_folders_are_flattened() {
        let root = std::env::temp_dir().join(format!("mh-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for f in ["Movies/Sling Blade (1996)/Sling Blade (1996) [tmdbid-12498]/Sling Blade Directors Cut (1996).mp4", "Movies/Sling Blade (1996)/English.srt"] {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let v = "Movies/Sling Blade (1996)/Sling Blade (1996) [tmdbid-12498]/Sling Blade Directors Cut (1996).mp4";
        let movies = classify(vec![m("c", "Sling Blade", 1996, v)]);
        let ops = plan(&root, &movies, &[MovieMove { video: v.into(), mode: "fix".into() }], &[]).unwrap();
        let pairs: Vec<(&str, &str)> = ops.iter().map(|o| (o.from.as_str(), o.to.as_str())).collect();
        assert!(pairs.contains(&(v, "Movies/Sling Blade (1996)/Sling Blade (1996).mp4")), "{pairs:?}");
        assert!(pairs.contains(&("Movies/Sling Blade (1996)/English.srt", "Movies/Sling Blade (1996)/Sling Blade (1996).eng.srt")), "{pairs:?}");
        assert!(!pairs.iter().any(|p| p.1.contains("tmdbid")));
        let _ = std::fs::remove_dir_all(&root);
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
        // Collected: into the collection's folder in the main folder.
        let mut coll = movies.clone();
        for m in &mut coll {
            m.collection = Some("Pixar Collection".into());
        }
        let c_ops = plan(&root, &coll, &[MovieMove { video: "Movies/Pixar/Coco.mkv".into(), mode: "collect".into() }], &[]).unwrap();
        assert_eq!(c_ops[0].to, "Movies/Pixar Collection/Coco (2017)/Coco (2017).mkv");
        let ops = plan(&root, &movies, &moves, &groups).unwrap();
        let pairs: Vec<(&str, &str)> = ops.iter().map(|o| (o.from.as_str(), o.to.as_str())).collect();
        assert!(pairs.contains(&("Movies/Pixar/Up.mkv", "Movies/Pixar/Up (2009)/Up (2009).mkv")), "{pairs:?}");
        assert!(pairs.contains(&("Movies/Pixar/Up.en.srt", "Movies/Pixar/Up (2009)/Up (2009).en.srt")));
        assert!(pairs.contains(&("Movies/Pixar/Coco.mkv", "Movies/Coco (2017)/Coco (2017).mkv")));
        assert!(pairs.contains(&("Movies/Alien Collection/Alien.1979.1080p/Alien.1979.1080p.mkv", "Movies/Alien Collection/Alien (1979)/Alien (1979).mkv")), "{pairs:?}");
        assert!(pairs.contains(&("Movies/Alien Collection/Alien.1979.1080p", "Movies/Alien Collection/Alien (1979)")));
        // The collection folder is renamed last, after the movies inside it.
        assert_eq!(ops.last().map(|o| (o.from.as_str(), o.to.as_str())), Some(("Movies/Alien Collection", "Movies/Alien")));
        assert!(ops.iter().all(|o| o.status == "ok"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
