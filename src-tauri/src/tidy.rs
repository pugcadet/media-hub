//! Clean-up → Names and years: one plain layout for the whole library.
//! - Movies: folder, video and subtitles all "Title (Year)".
//! - Shows: the year on the show folder only (not in episode file names), every episode in a
//!   "Season 07" folder (two digits).
//! Only mechanical changes on titles Jellyfin knows; anything that would clash is left alone.
//! Nothing moves until applied, and it's one batch History can undo.

use crate::error::{Error, Result};
use crate::fsops;
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::naming::{dedupe_year, is_sidecar, is_video, parse_episode, parse_name, sanitize, season_from_dir, split_ext};
use crate::planner::PlanOp;
use crate::state::{AppState, StoredPlan};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use tauri::State;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TidyTitle {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    /// Its folder (relative to the library folder).
    pub folder: String,
    pub ops: Vec<PlanOp>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TidyPlan {
    plan_id: String,
    titles: Vec<TidyTitle>,
}

fn last(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() { b.to_string() } else { format!("{a}/{b}") }
}

fn op(from: String, step: String, to: String, kind: &'static str, taken: &mut HashSet<String>, root: &Path) -> PlanOp {
    let same = from.to_lowercase() == step.to_lowercase();
    let clash = (!same && fsops::exists(root, &step)) || !taken.insert(to.to_lowercase());
    PlanOp {
        from,
        to,
        kind,
        status: if clash { "conflict" } else { "ok" },
        note: clash.then(|| "Something with that name is already there; left alone.".into()),
        season: None,
        episodes: vec![],
        verified: true,
        score: None,
        step_to: step,
        title: None,
    }
}

fn entries(root: &Path, rel: &str) -> (Vec<String>, Vec<String>) {
    let (mut dirs, mut files) = (Vec::new(), Vec::new());
    for e in std::fs::read_dir(root.join(rel)).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with('.') || n.starts_with('@') || n.eq_ignore_ascii_case("#recycle") {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => dirs.push(n),
            Ok(t) if t.is_file() => files.push(n),
            _ => {}
        }
    }
    dirs.sort();
    files.sort();
    (dirs, files)
}

/// "Show (2018) - S01E01 - Title" → "Show - S01E01 - Title" (only that show year, only in parentheses).
pub fn drop_year(name: &str, year: i64) -> String {
    let tag = format!(" ({year})");
    let out = name.replace(&tag, "").replace(&format!("({year})"), "");
    let out = out.split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    if out.trim().is_empty() { name.to_string() } else { out }
}

/// "Season 07" (or "Specials") for a season folder, when its name isn't that yet.
pub fn season_name(dir: &str) -> Option<String> {
    let n = season_from_dir(dir)?;
    let want = if n == 0 { "Specials".to_string() } else { format!("Season {n:02}") };
    (want != dir).then_some(want)
}

/// A show's folder with the year: "Bluey" → "Bluey (2018)". A different name is left to the Renamer.
pub fn show_folder_name(current: &str, title: &str, year: Option<i64>) -> Option<String> {
    let y = year?;
    let fixed = dedupe_year(current);
    let p = parse_name(&fixed);
    if p.year.is_some() {
        return (fixed != current).then_some(fixed);
    }
    let same = crate::sources::similarity(&p.title, title) >= 0.85 || p.title.eq_ignore_ascii_case(title);
    same.then(|| sanitize(&format!("{} ({y})", fixed.trim())))
}

/// The plan for one show.
pub fn plan_show(root: &Path, folder: &str, title: &str, year: Option<i64>, taken: &mut HashSet<String>) -> Vec<PlanOp> {
    let mut files = Vec::new();
    let mut dirs_ops = Vec::new();
    let (dirs, loose) = entries(root, folder);
    let new_show = show_folder_name(last(folder), title, year).map(|n| join(folder.rsplit_once('/').map(|x| x.0).unwrap_or(""), &n));
    let show_final = new_show.clone().unwrap_or_else(|| folder.to_string());
    // Season folders: their names, unless two would get the same one.
    let mut season_to: Vec<(String, String)> = Vec::new();
    for d in &dirs {
        if let Some(w) = season_name(d) {
            let taken_by_other = dirs.iter().any(|x| x == &w) || dirs.iter().filter(|x| season_name(x).as_deref() == Some(w.as_str())).count() > 1;
            if !taken_by_other {
                season_to.push((d.clone(), w));
            }
        }
    }
    let final_dir = |d: &str| season_to.iter().find(|(a, _)| a == d).map(|(_, b)| b.clone()).unwrap_or_else(|| d.to_string());
    let rename_file = |n: &str| -> String {
        let (stem, ext) = split_ext(n);
        let s = match year { Some(y) => drop_year(stem, y), None => stem.to_string() };
        let s = dedupe_year(&s);
        if ext.is_empty() { s } else { format!("{s}.{ext}") }
    };
    // Episodes in season folders: no year in the name.
    for d in dirs.iter().filter(|d| season_from_dir(d).is_some()) {
        let (_, inner) = entries(root, &join(folder, d));
        for n in inner.iter().filter(|n| is_video(n) || is_sidecar(n)) {
            let new = rename_file(n);
            if &new != n {
                let from = join(&join(folder, d), n);
                let step = join(&join(folder, d), &new);
                let to = join(&join(&show_final, &final_dir(d)), &new);
                files.push(op(from, step, to, if is_video(n) { "video" } else { "sidecar" }, taken, root));
            }
        }
    }
    // Episodes straight in the show folder: into their season folder (with their subtitles).
    let mut placed: HashSet<String> = HashSet::new();
    for n in loose.iter().filter(|n| is_video(n)) {
        let Some(m) = parse_episode(split_ext(n).0, None) else { continue };
        let season = if m.season == 0 { "Specials".to_string() } else { format!("Season {:02}", m.season) };
        // An existing folder for that season (maybe still "Season 7") is used.
        let dir = dirs.iter().find(|d| season_from_dir(d) == Some(m.season)).cloned().unwrap_or(season.clone());
        let stem = split_ext(n).0.to_string();
        for s in loose.iter().filter(|s| *s == n || (s.starts_with(&stem) && !is_video(s) && is_sidecar(s))) {
            if !placed.insert(s.clone()) {
                continue;
            }
            let new = rename_file(s);
            let from = join(folder, s);
            let step = join(&join(folder, &dir), &new);
            let to = join(&join(&show_final, &final_dir(&dir)), &new);
            files.push(op(from, step, to, if is_video(s) { "video" } else { "sidecar" }, taken, root));
        }
    }
    for (d, w) in &season_to {
        let from = join(folder, d);
        dirs_ops.push(op(from, join(folder, w), join(&show_final, w), "folder", taken, root));
    }
    if let Some(n) = new_show {
        dirs_ops.push(op(folder.to_string(), n.clone(), n, "folder", taken, root));
    }
    files.extend(dirs_ops);
    files
}

/// The plan for one movie in a folder of its own: folder "Title (Year)", the video and its
/// subtitles named the same.
pub fn plan_movie(root: &Path, video: &str, title: &str, year: Option<i64>, taken: &mut HashSet<String>) -> Vec<PlanOp> {
    let Some((folder, file)) = video.rsplit_once('/') else { return vec![] };
    let Some((parent, fname)) = folder.rsplit_once('/') else { return vec![] }; // straight in a top folder
    let (dirs, inside) = entries(root, folder);
    let videos: Vec<&String> = inside.iter().filter(|n| is_video(n) && !n.to_lowercase().contains("sample")).collect();
    if videos.len() != 1 || dirs.iter().any(|d| entries(root, &join(folder, d)).1.iter().any(|n| is_video(n) && !n.to_lowercase().contains("sample") && !d.to_lowercase().contains("extra") && !d.to_lowercase().contains("featurette"))) {
        return vec![]; // shared folder, several parts, or other movies inside: the Folders page handles those
    }
    let (stem, ext) = split_ext(file);
    if !crate::moviefolders::fits(title, year, stem, fname) {
        return vec![]; // maybe identified wrong
    }
    // The folder's name: kept when it already has the title and year, otherwise "Title (Year)".
    let name = {
        let fixed = dedupe_year(fname);
        let p = parse_name(&fixed);
        let tag_free = !fixed.contains('[') && !fixed.contains('{');
        if p.year.is_some() && p.year.map(i64::from) == year && tag_free && !crate::naming::is_messy(&fixed) {
            fixed
        } else {
            crate::moviefolders::expected_name(title, year, stem)
        }
    };
    if name.is_empty() {
        return vec![];
    }
    let new_folder = join(parent, &name);
    let mut ops = Vec::new();
    if stem != name {
        ops.push(op(video.to_string(), join(folder, &format!("{name}.{}", ext.to_lowercase())), join(&new_folder, &format!("{name}.{}", ext.to_lowercase())), "video", taken, root));
        for n in inside.iter().filter(|n| *n != file && n.starts_with(stem) && !is_video(n)) {
            let rest = &n[stem.len()..];
            ops.push(op(join(folder, n), join(folder, &format!("{name}{rest}")), join(&new_folder, &format!("{name}{rest}")), "sidecar", taken, root));
        }
    }
    for mut o in crate::moviefolders::language_subs(root, folder, &name, taken) {
        o.to = join(&new_folder, last(&o.to));
        ops.push(o);
    }
    if fname != name {
        ops.push(op(folder.to_string(), new_folder.clone(), new_folder, "folder", taken, root));
    }
    ops
}

#[tauri::command]
pub async fn tidy_names_plan(state: State<'_, AppState>, skip: Vec<String>) -> Result<TidyPlan> {
    let root = state.library_root()?;
    let c = state.reader().await?;
    let items = c
        .items_query(
            vec![
                ("IncludeItemTypes", "Movie,Series".into()),
                ("Recursive", "true".into()),
                ("Fields", "Path,ProductionYear".into()),
                ("EnableImages", "false".into()),
                ("EnableUserData", "false".into()),
            ],
            50_000,
        )
        .await?;
    let mut list: Vec<(String, String, &'static str, Option<i64>, String)> = Vec::new();
    let servers: Vec<&str> = items.iter().map(|v| v.get("Path").and_then(Value::as_str).unwrap_or("")).collect();
    let locals = local::to_local_many(&state, &servers);
    for (v, lp) in items.iter().zip(locals) {
        let id = v.get("Id").and_then(Value::as_str).unwrap_or("").replace('-', "");
        let kind = if v.get("Type").and_then(Value::as_str) == Some("Series") { "series" } else { "movie" };
        let (Some(_), Some(name)) = (v.get("Path").and_then(Value::as_str), v.get("Name").and_then(Value::as_str)) else { continue };
        if !valid_item_id(&id) {
            continue;
        }
        let Some(lp) = lp else { continue };
        let Some(rel) = local::rel_to_root(&root, &lp) else { continue };
        let top = rel.split('/').next().unwrap_or("").to_lowercase();
        if skip.iter().any(|s| s.to_lowercase() == top) {
            continue;
        }
        let year = v.get("ProductionYear").and_then(Value::as_i64);
        list.push((id, crate::naming::title_without_year(name, year), kind, year, rel));
    }
    let r2 = root.clone();
    let titles = tauri::async_runtime::spawn_blocking(move || {
        let mut taken = HashSet::new();
        let mut out = Vec::new();
        for (id, name, kind, year, rel) in list {
            let ops = if kind == "series" {
                if !r2.join(&rel).is_dir() || !rel.contains('/') {
                    continue;
                }
                plan_show(&r2, &rel, &name, year, &mut taken)
            } else {
                if !is_video(last(&rel)) {
                    continue;
                }
                plan_movie(&r2, &rel, &name, year, &mut taken)
            };
            if !ops.is_empty() {
                let folder = if kind == "series" { rel.clone() } else { rel.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default() };
                out.push(TidyTitle { id, name, kind, folder, ops });
            }
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    let ops: Vec<PlanOp> = titles.iter().flat_map(|t| t.ops.clone()).collect();
    let plan_id = format!("tidy-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    state.set_plan(StoredPlan { id: plan_id.clone(), root, ops })?;
    Ok(TidyPlan { plan_id, titles })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make(root: &Path, files: &[&str]) {
        for f in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
    }

    #[test]
    fn shows_get_year_on_the_folder_only_and_two_digit_seasons() {
        let root = std::env::temp_dir().join(format!("mh-tidy-show-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        make(&root, &[
            "TV/SpongeBob SquarePants/Season 7/SpongeBob SquarePants (1999) - S07E01 - Tentacle-Vision.mkv",
            "TV/SpongeBob SquarePants/Season 7/SpongeBob SquarePants (1999) - S07E01 - Tentacle-Vision.eng.srt",
            "TV/SpongeBob SquarePants/Season 08/SpongeBob SquarePants - S08E01 - Accidents Will Happen.mkv",
            "TV/SpongeBob SquarePants/SpongeBob SquarePants - S09E01 - Extreme Spots.mkv",
        ]);
        let mut taken = HashSet::new();
        let ops = plan_show(&root, "TV/SpongeBob SquarePants", "SpongeBob SquarePants", Some(1999), &mut taken);
        let to: Vec<(&str, &str)> = ops.iter().map(|o| (o.from.as_str(), o.to.as_str())).collect();
        assert!(to.contains(&("TV/SpongeBob SquarePants/Season 7/SpongeBob SquarePants (1999) - S07E01 - Tentacle-Vision.mkv", "TV/SpongeBob SquarePants (1999)/Season 07/SpongeBob SquarePants - S07E01 - Tentacle-Vision.mkv")), "{to:#?}");
        assert!(to.contains(&("TV/SpongeBob SquarePants/Season 7/SpongeBob SquarePants (1999) - S07E01 - Tentacle-Vision.eng.srt", "TV/SpongeBob SquarePants (1999)/Season 07/SpongeBob SquarePants - S07E01 - Tentacle-Vision.eng.srt")));
        assert!(to.contains(&("TV/SpongeBob SquarePants/SpongeBob SquarePants - S09E01 - Extreme Spots.mkv", "TV/SpongeBob SquarePants (1999)/Season 09/SpongeBob SquarePants - S09E01 - Extreme Spots.mkv")));
        assert!(to.contains(&("TV/SpongeBob SquarePants/Season 7", "TV/SpongeBob SquarePants (1999)/Season 07")));
        assert_eq!(ops.last().map(|o| (o.from.as_str(), o.to.as_str())), Some(("TV/SpongeBob SquarePants", "TV/SpongeBob SquarePants (1999)")));
        assert!(!to.iter().any(|t| t.0.contains("Accidents")), "already right");
        assert!(ops.iter().all(|o| o.status == "ok"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn movies_get_one_name_for_folder_video_and_subtitles() {
        let root = std::env::temp_dir().join(format!("mh-tidy-movie-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        make(&root, &[
            "Movies/Heat/Heat.1995.1080p.BluRay.mkv",
            "Movies/Heat/Heat.1995.1080p.BluRay.en.srt",
            "Movies/Heat/English.srt",
            "Movies/Up (2009)/Up (2009).mkv",
            "Movies/Up (2009)/Up (2009).eng.srt",
        ]);
        let mut taken = HashSet::new();
        let ops = plan_movie(&root, "Movies/Heat/Heat.1995.1080p.BluRay.mkv", "Heat", Some(1995), &mut taken);
        let to: Vec<(&str, &str)> = ops.iter().map(|o| (o.from.as_str(), o.to.as_str())).collect();
        assert!(to.contains(&("Movies/Heat/Heat.1995.1080p.BluRay.mkv", "Movies/Heat (1995)/Heat (1995).mkv")), "{to:#?}");
        assert!(to.contains(&("Movies/Heat/Heat.1995.1080p.BluRay.en.srt", "Movies/Heat (1995)/Heat (1995).en.srt")));
        assert!(to.contains(&("Movies/Heat/English.srt", "Movies/Heat (1995)/Heat (1995).eng.srt")));
        assert_eq!(ops.last().map(|o| (o.from.as_str(), o.to.as_str())), Some(("Movies/Heat", "Movies/Heat (1995)")));
        assert!(plan_movie(&root, "Movies/Up (2009)/Up (2009).mkv", "Up", Some(2009), &mut taken).is_empty(), "already right");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn years_only_come_out_of_episode_names() {
        assert_eq!(drop_year("Bluey (2018) - S01E01 - Magic Xylophone", 2018), "Bluey - S01E01 - Magic Xylophone");
        assert_eq!(drop_year("1917 (2019)", 2018), "1917 (2019)");
        assert_eq!(season_name("Season 7").as_deref(), Some("Season 07"));
        assert_eq!(season_name("Season 07"), None);
        assert_eq!(show_folder_name("Bluey", "Bluey", Some(2018)).as_deref(), Some("Bluey (2018)"));
        assert_eq!(show_folder_name("Bluey (2018)", "Bluey", Some(2018)), None);
        assert_eq!(show_folder_name("Something Else", "Bluey", Some(2018)), None);
    }
}
