//! Builds a rename plan from a list of file paths. Pure: no disk, no network.
//! Every path in and out is relative to the library root and uses `/` between folders.
//!
//! Renames happen IN PLACE: files keep their folder, existing season folders and the show
//! (or movie) folder are renamed rather than recreated. Nothing new is created unless you
//! ask for it (episodes into season folders, or a loose movie into its own folder).
//!
//! Apply order matters and is the order of the returned list: files first (inside their
//! current folders), then season folders, then the show folder.

use crate::naming::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};

pub const TV_TOKENS: &[&str] = &[
    "show", "year", "s", "e", "sxe", "seasondir", "title", "ext", "tmdbtag", "tvdbtag",
];
pub const MOVIE_TOKENS: &[&str] = &["title", "year", "ext", "tmdbtag", "imdbtag"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindReplace {
    pub find: String,
    pub replace: String,
    #[serde(default)]
    pub regex: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub template: String,
    /// The show folder (TV) or folder with movies, relative to the root ("" = the root itself).
    pub folder: String,
    pub show: Option<String>,
    pub year: Option<i32>,
    #[serde(default)]
    pub find_replace: Vec<FindReplace>,
    /// Rename the chosen folder itself to the show name. None = decide (yes when it already
    /// looks like the show's folder).
    #[serde(default)]
    pub rename_folder: Option<bool>,
    /// Move episodes that sit directly in the show folder into season folders.
    #[serde(default)]
    pub season_folders: bool,
    /// Shows: a name that only differs by a "(2018)" year is left as it is (renaming a
    /// show in Jellyfin loses its watched status and markers, so a year alone isn't worth it).
    #[serde(default)]
    pub year_optional: bool,
    /// Only tidy names that are messy (release tags, dots for spaces). Names that are fine for
    /// Jellyfin but in another style are left alone; nothing moves into new folders.
    #[serde(default)]
    pub minimal: bool,
    /// Ids of the matched show (tmdb/tvdb), used for {tmdbtag}/{tvdbtag}. Filled by the app.
    #[serde(default, skip_deserializing)]
    pub ids: HashMap<String, String>,
    /// Episode titles from the other databases (TMDB, TVmaze …). When one of them agrees with
    /// the title already in a file name, that title is kept. Filled by the app.
    #[serde(default, skip_deserializing)]
    pub alt_titles: Vec<HashMap<(u32, u32), String>>,
}

/// What the online match decided for one movie file.
#[derive(Debug, Clone, PartialEq)]
pub struct MovieMatch {
    pub title: String,
    pub year: Option<i32>,
    pub tmdb: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanOp {
    pub from: String,
    /// Where it ends up after everything is applied (shown to you).
    pub to: String,
    /// "video" | "sidecar" | "folder"
    pub kind: &'static str,
    /// "ok" | "unchanged" | "conflict" | "unparsed"
    pub status: &'static str,
    pub note: Option<String>,
    pub season: Option<u32>,
    pub episodes: Vec<u32>,
    /// True when reading the NEW name back gives the same season/episode (or title/year).
    pub verified: bool,
    /// How sure the online match is (0-100), when one was made.
    pub score: Option<u8>,
    /// The single rename this step performs (before later folder renames). Internal.
    #[serde(skip)]
    pub step_to: String,
    /// Episode title, for the Infuse preview.
    pub title: Option<String>,
}

enum Rule {
    Literal(String, String),
    Pattern(Regex, String),
}

fn compile_rules(rules: &[FindReplace]) -> Result<Vec<Rule>, String> {
    let mut out = Vec::new();
    for r in rules.iter().filter(|r| !r.find.is_empty()) {
        if r.regex {
            let re = RegexBuilder::new(&r.find)
                .size_limit(1 << 20)
                .build()
                .map_err(|_| format!("“{}” is not a valid pattern.", r.find))?;
            out.push(Rule::Pattern(re, r.replace.clone()));
        } else {
            out.push(Rule::Literal(r.find.clone(), r.replace.clone()));
        }
    }
    Ok(out)
}

/// Applies the find/replace rules to a file name (never to folders or the extension).
fn name_with_rules(name: &str, rules: &[Rule]) -> String {
    if rules.is_empty() {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    let mut s = stem.to_string();
    for r in rules {
        s = match r {
            Rule::Literal(f, t) => s.replace(f.as_str(), t),
            Rule::Pattern(re, t) => re.replace_all(&s, t.as_str()).to_string(),
        };
    }
    let s = sanitize(&s);
    if ext.is_empty() { s } else { format!("{s}.{ext}") }
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// Path of `p` relative to folder `f` ("" when p == f). None when outside.
fn rel_to<'a>(p: &'a str, f: &str) -> Option<&'a str> {
    if f.is_empty() {
        return Some(p);
    }
    if p == f {
        return Some("");
    }
    p.strip_prefix(f).and_then(|r| r.strip_prefix('/'))
}

/// Rendered template split into its folder and file parts.
struct Parts {
    /// first folder (show folder for TV, movie folder for movies)
    top: Option<String>,
    /// second folder (season folder), TV only
    season: Option<String>,
    file: String,
}

fn parts_of(rendered: &str, tv: bool) -> Parts {
    let p: Vec<&str> = rendered.split('/').collect();
    let n = p.len();
    let file = p[n - 1].to_string();
    match (tv, n) {
        (_, 1) => Parts { top: None, season: None, file },
        (true, 2) => Parts { top: Some(p[0].into()), season: None, file },
        (true, _) => Parts { top: Some(p[0].into()), season: Some(p[n - 2].into()), file },
        (false, _) => Parts { top: Some(p[n - 2].into()), season: None, file },
    }
}

fn op(from: &str, step_to: &str, to: &str, kind: &'static str) -> PlanOp {
    PlanOp {
        from: from.into(),
        to: to.into(),
        kind,
        status: "ok",
        note: None,
        season: None,
        episodes: Vec::new(),
        verified: true,
        score: None,
        step_to: step_to.into(),
        title: None,
    }
}

fn unparsed(f: &str, why: String, season: Option<u32>, eps: Vec<u32>) -> PlanOp {
    let mut o = op(f, f, f, "video");
    o.status = "unparsed";
    o.note = Some(why);
    o.season = season;
    o.episodes = eps;
    o.verified = false;
    o
}

/// The name with any " (2018)" year taken out, to compare names that differ only by it.
pub fn without_year(name: &str) -> String {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\s*\((?:19|20)\d{2}\)").expect("year pattern"));
    re.replace_all(name, "").to_string()
}

/// Sets ok / unchanged / conflict. Files are checked on their own step (inside their
/// current folder); folders on their new name next to them.
fn status_pass(ops: &mut [PlanOp], exists: &dyn Fn(&str) -> bool) {
    let lower = |s: &str| s.to_lowercase();
    let mut count: HashMap<String, usize> = HashMap::new();
    for o in ops.iter().filter(|o| o.status != "unparsed") {
        *count.entry(lower(&o.step_to)).or_default() += 1;
    }
    let vacated: HashSet<String> = ops.iter().filter(|o| o.from != o.step_to).map(|o| lower(&o.from)).collect();
    for o in ops.iter_mut() {
        if o.status == "unparsed" {
            continue;
        }
        if o.from == o.step_to {
            o.status = "unchanged";
            continue;
        }
        let case_only = lower(&o.from) == lower(&o.step_to);
        let what = if o.kind == "folder" { "folder" } else { "file" };
        if count[&lower(&o.step_to)] > 1 {
            o.status = "conflict";
            o.note = Some(format!("Another {what} would get exactly this name."));
        } else if !case_only && vacated.contains(&lower(&o.step_to)) {
            o.status = "conflict";
            o.note = Some("This name belongs to something that is also being renamed. Run the renamer twice.".into());
        } else if !case_only && exists(&o.step_to) {
            o.status = "conflict";
            o.note = Some(format!("A {what} with this name already exists."));
        } else {
            o.status = "ok";
        }
    }
}

/// Subtitles follow their video: "X.en.srt" becomes "<new X>.en.srt" in the same place.
fn add_sidecars(files: &[String], videos: &[(String, String, String)], ops: &mut Vec<PlanOp>) {
    for f in files {
        let (dir, name) = split_path(f);
        if !is_sidecar(name) {
            continue;
        }
        // (from, step_to, final)
        let best = videos
            .iter()
            .filter(|(from, _, _)| split_path(from).0 == dir)
            .filter_map(|v| {
                let stem = split_ext(split_path(&v.0).1).0;
                name.starts_with(&format!("{stem}.")).then_some((v, stem.len()))
            })
            .max_by_key(|(_, l)| *l);
        let Some(((_, step, fin), len)) = best else { continue };
        let rest = &name[len..];
        let with = |p: &str| {
            let (d, n) = split_path(p);
            join(d, &format!("{}{rest}", split_ext(n).0))
        };
        ops.push(op(f, &with(step), &with(fin), "sidecar"));
    }
}

/// "tv" when most videos have a season/episode number, otherwise "movie".
pub fn detect_kind(files: &[String]) -> &'static str {
    let videos: Vec<&String> = files.iter().filter(|f| is_video(split_path(f).1)).collect();
    if videos.is_empty() {
        return "movie";
    }
    let episodes = videos
        .iter()
        .filter(|f| {
            let (dir, name) = split_path(f);
            parse_episode(split_ext(name).0, dir.rsplit('/').find_map(season_from_dir)).is_some()
        })
        .count();
    if episodes * 2 >= videos.len() { "tv" } else { "movie" }
}

/// A year written in the file names ("Bluey (2018) - S01E01"), when the folder has none.
pub fn year_from_files(files: &[String]) -> Option<i32> {
    files.iter().filter(|f| is_video(split_path(f).1)).find_map(|f| {
        let stem = split_ext(split_path(f).1).0;
        let before = match parse_episode(stem, None) {
            Some(m) => {
                let marker = stem[..m.end].rfind(['s', 'S']).unwrap_or(0);
                &stem[..marker]
            }
            None => stem,
        };
        parse_name(before).year
    })
}

/// Best guess of the show's name and year, from the folder or else the file names.
pub fn guess_show(folder: &str, files: &[String]) -> (String, Option<i32>) {
    let name = folder.rsplit('/').next().unwrap_or("");
    let p = parse_name(name);
    let year = p.year.or_else(|| year_from_files(files));
    let from_file = files
        .iter()
        .find(|f| is_video(split_path(f).1))
        .map(|f| {
            let stem = split_ext(split_path(f).1).0;
            let end = parse_episode(stem, None).map(|m| stem[..m.end].rfind(['s', 'S']).unwrap_or(0)).unwrap_or(0);
            parse_name(&stem[..end]).title
        })
        .filter(|t| !t.trim().is_empty());
    let folder_ok = !p.title.trim().is_empty() && season_from_dir(name).is_none();
    // The folder name wins, unless the files clearly name a different show
    // (a folder like "Downloads" or "Season 1" says nothing about the show).
    match (folder_ok, from_file) {
        (true, Some(f)) if title_similarity(&p.title, &f) < 0.5 => (f, year),
        (true, _) => (p.title, year),
        (false, Some(f)) => (f, year),
        (false, None) => (p.title, year),
    }
}

/// Title and year read from a movie file name (or its folder).
pub fn movie_guess(rel: &str, folder: &str) -> (String, Option<i32>) {
    let (dir, name) = split_path(rel);
    let mut p = parse_name(split_ext(name).0);
    if (p.title.is_empty() || p.year.is_none()) && !dir.is_empty() && dir != folder {
        let d = parse_name(dir.rsplit('/').next().unwrap_or(""));
        // A folder like "Inception (2010)" says more than a file called "movie.mkv".
        if p.title.is_empty() || (p.year.is_none() && d.year.is_some()) {
            p.title = d.title;
        }
        p.year = p.year.or(d.year);
    }
    (p.title, p.year)
}

fn title_similarity(a: &str, b: &str) -> f64 {
    crate::sources::similarity(a, b)
}

/// Episode titles compared loosely: "Stan of Arabia (1)", "Stan of Arabia, Part 1" and
/// "Stan Of Arabia Pt. 1" are the same episode.
pub fn same_episode_title(a: &str, b: &str) -> bool {
    fn norm(t: &str) -> String {
        let t = t.to_lowercase().replace("part one", "1").replace("part two", "2").replace("part three", "3");
        t.split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty() && !matches!(*w, "part" | "pt" | "the" | "a" | "an" | "and"))
            .collect::<Vec<_>>()
            .join(" ")
    }
    let (x, y) = (norm(a), norm(b));
    !x.is_empty() && (x == y || title_similarity(&x, &y) >= 0.85)
}

pub fn plan_tv(
    files: &[String],
    req: &PlanRequest,
    titles: &HashMap<(u32, u32), String>,
    exists: &dyn Fn(&str) -> bool,
) -> Result<Vec<PlanOp>, String> {
    let tpl = Template::parse(&req.template, TV_TOKENS)?;
    let rules = compile_rules(&req.find_replace)?;
    let folder = req.folder.trim_end_matches('/');
    let folder_name = folder.rsplit('/').next().unwrap_or("");
    let parsed = parse_name(folder_name);
    let (guess, guess_year) = guess_show(folder, files);
    let show = req.show.clone().filter(|s| !s.trim().is_empty()).unwrap_or(guess);
    let year = req.year.or(guess_year);
    if show.trim().is_empty() {
        return Err("Could not work out the show name. Type it in.".into());
    }

    let mut file_ops: Vec<PlanOp> = Vec::new();
    let mut videos: Vec<(String, String, String)> = Vec::new(); // (from, step, final-without-folder-renames)
    let mut top_name: Option<String> = None;
    // season folder (relative to the show folder) -> wanted names
    let mut season_dirs: BTreeMap<String, HashSet<String>> = BTreeMap::new();

    for f in files.iter().filter(|f| is_video(split_path(f).1)) {
        let Some(inside) = rel_to(f, folder) else { continue };
        let (dir, name) = split_path(f);
        let (stem, ext) = split_ext(name);
        let hint = dir.rsplit('/').find_map(season_from_dir);
        let Some(m) = parse_episode(stem, hint) else {
            file_ops.push(unparsed(f, "No season and episode number found in this name, so it is left alone.".into(), None, vec![]));
            continue;
        };
        let looked_up: Vec<&String> = m.episodes.iter().filter_map(|e| titles.get(&(m.season, *e))).collect();
        let current = title_after(stem, &m);
        let mut title = if !looked_up.is_empty() && looked_up.len() == m.episodes.len() {
            let mut names: Vec<&str> = looked_up.iter().map(|s| s.as_str()).collect();
            names.dedup();
            names.join(" + ")
        } else {
            current.clone()
        };
        // The databases don't always number episodes the same way. When the title already in
        // the file matches another database for this number, or this database under another
        // number, the file is probably right: keep its title and say why.
        let mut kept: Option<String> = None;
        if !current.is_empty() && title != current && !same_episode_title(&title, &current) {
            let same_slot = |a: &HashMap<(u32, u32), String>| m.episodes.iter().all(|e| a.get(&(m.season, *e)).map(|t| same_episode_title(t, &current)).unwrap_or(false));
            if req.alt_titles.iter().any(same_slot) {
                kept = Some(format!("Kept “{current}”: another database has it as this episode (the episode order differs between databases)."));
            } else if titles.iter().any(|(k, t)| !(k.0 == m.season && m.episodes.contains(&k.1)) && same_episode_title(t, &current))
            {
                kept = Some(format!("Kept “{current}”: the database lists it under another number, so the order differs. Check it yourself."));
            }
            if kept.is_some() {
                title = current.clone();
            }
        }
        let first = m.episodes[0];
        let mut sxe = format!("S{:02}E{:02}", m.season, first);
        for e in &m.episodes[1..] {
            sxe.push_str(&format!("-E{e:02}"));
        }
        let mut vars: HashMap<&str, Var> = HashMap::new();
        vars.insert("show", Var::text(show.as_str()));
        if let Some(y) = year {
            vars.insert("year", Var { text: y.to_string(), num: Some(y.max(0) as u32) });
        }
        vars.insert("s", Var::num(m.season));
        vars.insert("e", Var::num(first));
        vars.insert("sxe", Var::text(sxe));
        vars.insert("seasondir", Var::text(if m.season == 0 { "Specials".to_string() } else { format!("Season {:02}", m.season) }));
        if !title.is_empty() {
            vars.insert("title", Var::text(title.clone()));
        }
        vars.insert("ext", Var::text(ext.to_lowercase()));
        if let Some(id) = req.ids.get("tmdb").or(parsed.tmdb.as_ref()) {
            vars.insert("tmdbtag", Var::text(format!("{{tmdb-{id}}}")));
        }
        if let Some(id) = req.ids.get("tvdb").or(parsed.tvdb.as_ref()) {
            vars.insert("tvdbtag", Var::text(format!("{{tvdb-{id}}}")));
        }
        let rendered = match tpl.render(&vars) {
            Ok(r) => r,
            Err(why) => {
                file_ops.push(unparsed(f, why, Some(m.season), m.episodes.clone()));
                continue;
            }
        };
        let parts = parts_of(&rendered, true);
        let mut new_name = name_with_rules(&parts.file, &rules);
        if req.year_optional && without_year(name) == without_year(&new_name) {
            new_name = name.to_string();
        }
        if req.minimal && !crate::naming::is_messy(stem) {
            new_name = name.to_string();
        }
        if top_name.is_none() {
            top_name = parts.top.clone();
        }
        // Folder handling: rename an existing season folder, or (on request) move episodes
        // that sit directly in the show folder into one.
        let inside_dir = split_path(inside).0;
        let first_dir = inside_dir.split('/').next().unwrap_or("");
        let step_dir = if inside_dir.is_empty() {
            match (&parts.season, req.season_folders && !req.minimal) {
                (Some(sd), true) => join(folder, sd),
                _ => dir.to_string(),
            }
        } else {
            if let Some(sd) = &parts.season {
                // Only folders that already are season folders (or hold one season) get renamed.
                season_dirs.entry(first_dir.to_string()).or_default().insert(sd.clone());
            }
            dir.to_string()
        };
        let step = join(&step_dir, &new_name);
        let (nd, nn) = split_path(&step);
        let verified = parse_episode(split_ext(nn).0, nd.rsplit('/').find_map(season_from_dir).or(parts.season.as_deref().and_then(season_from_dir)))
            .map(|r| r.season == m.season && r.episodes == m.episodes)
            .unwrap_or(false);
        let mut o = op(f, &step, &step, "video");
        o.season = Some(m.season);
        o.episodes = m.episodes.clone();
        o.verified = verified;
        o.title = (!title.is_empty()).then_some(title);
        if !verified {
            o.note = Some("The new name does not read back as the same episode. Check the pattern.".into());
        } else if kept.is_some() {
            o.note = kept;
        }
        videos.push((f.clone(), step.clone(), step));
        file_ops.push(o);
    }

    // Season folders: rename "Season 1" -> "Season 01" etc. A folder that mixes seasons,
    // or is not a season folder at all ("Extras"), is left alone.
    let mut dir_map: Vec<(String, String)> = Vec::new(); // old full path -> new full path
    let mut folder_ops: Vec<PlanOp> = Vec::new();
    for (d, wanted) in &season_dirs {
        if d.is_empty() || wanted.len() != 1 {
            continue;
        }
        let new = wanted.iter().next().cloned().unwrap_or_default();
        if season_from_dir(d).is_none() && season_from_dir(&new).is_none() {
            continue;
        }
        if season_from_dir(d).is_none() {
            continue;
        }
        if req.minimal && !crate::naming::is_messy(d) {
            continue;
        }
        if *d != new {
            let (old_full, new_full) = (join(folder, d), join(folder, &new));
            dir_map.push((old_full.clone(), new_full.clone()));
            folder_ops.push(op(&old_full, &new_full, &new_full, "folder"));
        }
    }

    // The show folder itself.
    let rename_top = match req.rename_folder {
        _ if req.minimal && !crate::naming::is_messy(folder_name) => false,
        Some(v) => v,
        None => {
            !folder.is_empty()
                && season_from_dir(folder_name).is_none()
                && (title_similarity(&parsed.title, &show) >= 0.5 || title_similarity(folder_name, &show) >= 0.5)
        }
    };
    let mut top_map: Option<(String, String)> = None;
    if let (true, Some(top)) = (rename_top && !folder.is_empty(), &top_name) {
        // Show folders all follow the same pattern (with the year where the style has one), so
        // the year being optional only applies to episode file names.
        if folder_name != top {
            let parent = split_path(folder).0;
            let new_full = join(parent, top);
            top_map = Some((folder.to_string(), new_full.clone()));
            folder_ops.push(op(folder, &new_full, &new_full, "folder"));
        }
    }

    // Final places (after the folder renames), for display.
    let finalize = |p: &str| -> String {
        let mut out = p.to_string();
        for (old, new) in &dir_map {
            if let Some(r) = rel_to(&out, old) {
                out = join(new, r);
                break;
            }
        }
        if let Some((old, new)) = &top_map {
            if let Some(r) = rel_to(&out, old) {
                out = join(new, r);
            }
        }
        out
    };
    let mut ops = file_ops;
    add_sidecars(files, &videos, &mut ops);
    status_pass(&mut ops, exists);
    status_pass(&mut folder_ops, exists);
    for o in ops.iter_mut().chain(folder_ops.iter_mut()) {
        o.to = finalize(&o.step_to);
    }
    // Season folders deeper first, show folder last.
    folder_ops.sort_by_key(|o| std::cmp::Reverse(o.from.matches('/').count()));
    ops.extend(folder_ops);
    Ok(ops)
}

pub fn plan_movies(
    files: &[String],
    req: &PlanRequest,
    matches: &HashMap<String, MovieMatch>,
    exists: &dyn Fn(&str) -> bool,
) -> Result<Vec<PlanOp>, String> {
    let tpl = Template::parse(&req.template, MOVIE_TOKENS)?;
    let rules = compile_rules(&req.find_replace)?;
    let folder = req.folder.trim_end_matches('/');
    let videos_in: Vec<&String> = files.iter().filter(|f| is_video(split_path(f).1)).collect();
    let per_dir = |d: &str| videos_in.iter().filter(|f| split_path(f).0 == d).count();

    let mut ops: Vec<PlanOp> = Vec::new();
    let mut folder_ops: Vec<PlanOp> = Vec::new();
    let mut videos: Vec<(String, String, String)> = Vec::new();
    let mut renamed_dirs: HashMap<String, String> = HashMap::new();

    for f in &videos_in {
        let (dir, name) = split_path(f);
        let ext = split_ext(name).1;
        let (title0, year0) = movie_guess(f, folder);
        let mut tmdb = parse_name(split_ext(name).0).tmdb;
        let imdb = parse_name(split_ext(name).0).imdb;
        let found = matches.get(f.as_str());
        if let Some(m) = found {
            tmdb = m.tmdb.clone().or(tmdb);
        }
        let title = found.map(|m| m.title.clone()).unwrap_or(title0);
        let year = found.and_then(|m| m.year).or(year0);

        let mut vars: HashMap<&str, Var> = HashMap::new();
        vars.insert("title", Var::text(title.as_str()));
        if let Some(y) = year {
            vars.insert("year", Var { text: y.to_string(), num: Some(y.max(0) as u32) });
        }
        vars.insert("ext", Var::text(ext.to_lowercase()));
        if let Some(id) = &tmdb {
            vars.insert("tmdbtag", Var::text(format!("{{tmdb-{id}}}")));
        }
        if let Some(id) = &imdb {
            vars.insert("imdbtag", Var::text(format!("{{imdb-{id}}}")));
        }
        let rendered = match tpl.render(&vars) {
            Ok(p) => p,
            Err(why) => {
                ops.push(unparsed(f, why, None, vec![]));
                continue;
            }
        };
        let parts = parts_of(&rendered, false);
        let mut new_name = name_with_rules(&parts.file, &rules);
        let own_folder = dir != folder && !dir.is_empty() && per_dir(dir) == 1;
        let dir_name = split_path(dir).1;
        let mut top = parts.top.clone();
        if req.minimal {
            if !crate::naming::is_messy(split_ext(name).0) {
                new_name = name.to_string();
            }
            if !(own_folder && crate::naming::is_messy(dir_name)) {
                // The folder is fine (or isn't the movie's own): don't rename or create one.
                top = None;
            }
        }
        let (step, note) = match (&top, own_folder, dir == folder) {
            // In its own folder: rename the file there; the folder is renamed after.
            (Some(top), true, _) => {
                let parent = split_path(dir).0;
                let new_dir = join(parent, top);
                if new_dir != dir && !renamed_dirs.contains_key(dir) {
                    renamed_dirs.insert(dir.to_string(), new_dir.clone());
                    folder_ops.push(op(dir, &new_dir, &new_dir, "folder"));
                }
                (join(dir, &new_name), None)
            }
            // Loose in the chosen folder and the style wants a folder per movie.
            (Some(top), false, true) => (join(&join(folder, top), &new_name), Some("Gets its own folder".to_string())),
            _ => (join(dir, &new_name), None),
        };
        let back = parse_name(split_ext(split_path(&step).1).0);
        let verified = (req.minimal && step == **f) || back.title.eq_ignore_ascii_case(&sanitize(&title)) && back.year == year;
        let mut o = op(f, &step, &step, "video");
        o.verified = verified;
        o.note = if verified { note } else { Some("The new name does not read back as the same title and year.".into()) };
        o.title = Some(title);
        videos.push((f.to_string(), step.clone(), step));
        ops.push(o);
    }

    add_sidecars(files, &videos, &mut ops);
    status_pass(&mut ops, exists);
    status_pass(&mut folder_ops, exists);
    for o in ops.iter_mut().chain(folder_ops.iter_mut()) {
        let mut out = o.step_to.clone();
        for (old, new) in &renamed_dirs {
            if let Some(r) = rel_to(&out, old) {
                out = join(new, r);
                break;
            }
        }
        o.to = out;
    }
    ops.extend(folder_ops);
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TV: &str = "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}";
    const CLEAN: &str = "{show}< ({year})>/{seasondir}/{e:00}< {title}>.{ext}";
    const MOVIE: &str = "{title}< ({year})>/{title}< ({year})>.{ext}";

    fn req(folder: &str, template: &str) -> PlanRequest {
        PlanRequest {
            template: template.into(),
            folder: folder.into(),
            show: None,
            year: None,
            find_replace: vec![],
            rename_folder: None,
            season_folders: false,
            year_optional: false,
            minimal: false,
            ids: HashMap::new(),
            alt_titles: Vec::new(),
        }
    }

    #[test]
    fn titles_another_database_agrees_with_are_kept() {
        let f = files(&["TV/American Dad!/Season 02/American Dad! - S02E05 - Stan of Arabia (1).mkv"]);
        let mut r = req("TV/American Dad!", "{show}/{seasondir}/{show} - {sxe}< - {title}>.{ext}");
        r.show = Some("American Dad!".into());
        let mut primary = HashMap::new();
        primary.insert((2, 5), "Dungeons and Wagons".to_string());
        primary.insert((1, 23), "Stan of Arabia (1)".to_string());
        // Only the main database: the title is found under another number → kept, with a note.
        let ops = plan_tv(&f, &r, &primary, &nothing_exists).unwrap();
        assert_eq!(ops[0].status, "unchanged", "{ops:#?}");
        // Another database agrees with the file → kept too.
        let mut tvmaze = HashMap::new();
        tvmaze.insert((2, 5), "Stan of Arabia, Part 1".to_string());
        r.alt_titles = vec![tvmaze];
        let mut primary2 = HashMap::new();
        primary2.insert((2, 5), "Dungeons and Wagons".to_string());
        let ops = plan_tv(&f, &r, &primary2, &nothing_exists).unwrap();
        assert!(ops[0].status == "unchanged" || ops[0].note.as_deref().unwrap_or("").starts_with("Kept"), "{ops:#?}");
        // Nothing agrees: the database title wins.
        r.alt_titles.clear();
        let ops = plan_tv(&f, &r, &primary2, &nothing_exists).unwrap();
        assert!(ops[0].to.ends_with("S02E05 - Dungeons and Wagons.mkv"), "{ops:#?}");
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn nothing_exists(_: &str) -> bool {
        false
    }

    fn by_from<'a>(ops: &'a [PlanOp], from: &str) -> &'a PlanOp {
        ops.iter().find(|o| o.from == from).unwrap_or_else(|| panic!("no op for {from}"))
    }

    /// Applies a plan to a list of paths the way the disk would end up.
    fn simulate(files: &[String], ops: &[PlanOp]) -> Vec<String> {
        let mut paths: Vec<String> = files.to_vec();
        for o in ops.iter().filter(|o| o.status == "ok") {
            for p in paths.iter_mut() {
                if o.kind == "folder" {
                    if let Some(r) = rel_to(p, &o.from) {
                        *p = join(&o.step_to, r);
                    }
                } else if *p == o.from {
                    *p = o.step_to.clone();
                }
            }
        }
        paths.sort();
        paths
    }

    #[test]
    fn renames_in_place_including_folders() {
        let f = files(&[
            "TV/Bluey/Season 1/Bluey.S01E01.Magic.Xylophone.1080p.mkv",
            "TV/Bluey/Season 1/Bluey.S01E01.Magic.Xylophone.1080p.en.srt",
            "TV/Bluey/Season 1/Bluey - 1x02.mp4",
            "TV/Bluey/Specials/Bluey S00E01 Minisode.mkv",
            "TV/Bluey/poster.jpg",
        ]);
        let mut r = req("TV/Bluey", TV);
        r.year = Some(2018);
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        // Files are renamed where they are (inside "Season 1")...
        assert_eq!(by_from(&ops, &f[0]).step_to, "TV/Bluey/Season 1/Bluey (2018) - S01E01 - Magic Xylophone.mkv");
        // ...and end up in the renamed folders.
        assert_eq!(by_from(&ops, &f[0]).to, "TV/Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic Xylophone.mkv");
        assert_eq!(by_from(&ops, &f[1]).to, "TV/Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic Xylophone.en.srt");
        assert_eq!(by_from(&ops, "TV/Bluey/Season 1").to, "TV/Bluey (2018)/Season 01");
        assert_eq!(by_from(&ops, "TV/Bluey").to, "TV/Bluey (2018)");
        // Specials folder keeps its name.
        assert!(!ops.iter().any(|o| o.from == "TV/Bluey/Specials"));
        // Show folder is renamed last.
        assert_eq!(ops.last().unwrap().from, "TV/Bluey");
        assert!(ops.iter().all(|o| o.status == "ok"), "{ops:#?}");
        // Other files (artwork) simply move along with the folder.
        let after = simulate(&f, &ops);
        assert!(after.contains(&"TV/Bluey (2018)/poster.jpg".to_string()));
    }

    #[test]
    fn running_twice_finds_nothing_to_do() {
        for template in [TV, CLEAN] {
            let f = files(&[
                "TV/Bluey/Season 1/Bluey.S01E01.Magic.Xylophone.mkv",
                "TV/Bluey/Season 1/bluey 1x02 the weekend.mp4",
                "TV/Bluey/Season 2/Bluey.S02E03-E04.mkv",
            ]);
            let mut r = req("TV/Bluey", template);
            r.year = Some(2018);
            let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
            let after = simulate(&f, &ops);
            let r2 = PlanRequest { folder: "TV/Bluey (2018)".into(), ..r.clone() };
            let again = plan_tv(&after, &r2, &HashMap::new(), &nothing_exists).unwrap();
            assert!(again.iter().all(|o| o.status == "unchanged"), "{template}: {again:#?}");
            assert!(again.iter().all(|o| o.kind != "folder"), "{template}: {again:#?}");
        }
    }

    #[test]
    fn year_and_name_come_from_files_and_folder_is_kept_when_unrelated() {
        let f = files(&["Downloads/Bluey (2018) - S01E01 - Magic Xylophone.mkv"]);
        let ops = plan_tv(&f, &req("Downloads", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops.len(), 1, "the Downloads folder is not renamed: {ops:#?}");
        assert_eq!(ops[0].status, "unchanged");
        assert_eq!(guess_show("Downloads", &f), ("Bluey".to_string(), Some(2018)));
        assert_eq!(guess_show("TV/Season 1", &f).0, "Bluey");
    }

    #[test]
    fn minimal_only_tidies_messy_names() {
        // A messy movie file and folder are cleaned; the year stays.
        let f = files(&["Movies/Ad.Astra.2019.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX]/Ad.Astra.2019.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX].mkv"]);
        let mut r = req("Movies", MOVIE);
        r.minimal = true;
        let ops = plan_movies(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        let v = ops.iter().find(|o| o.kind == "video").unwrap();
        assert_eq!(v.status, "ok", "{ops:#?}");
        assert_eq!(v.to, "Movies/Ad Astra (2019)/Ad Astra (2019).mkv");
        // A tidy movie in another style is left alone.
        let f = files(&["Movies/Heat 1995/Heat.mkv"]);
        let ops = plan_movies(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        assert!(ops.iter().all(|o| o.status == "unchanged"), "{ops:#?}");
        // Episodes Jellyfin reads fine: no year, no titles, no season folders added.
        let f = files(&["TV/Bluey/Bluey - S01E01.mkv", "TV/Bluey/Season 1/Bluey - S01E02.mkv"]);
        let mut r = req("TV/Bluey", TV);
        r.year = Some(2018);
        r.minimal = true;
        r.season_folders = true;
        let ops = plan_tv(&f, &r, &HashMap::from([((1, 1), "Magic Xylophone".to_string())]), &nothing_exists).unwrap();
        assert!(ops.iter().all(|o| o.status == "unchanged"), "{ops:#?}");
        // A messy episode is tidied in place.
        let f = files(&["TV/Bluey/Bluey.S01E03.1080p.WEB-DL.mkv"]);
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        let v = ops.iter().find(|o| o.kind == "video").unwrap();
        assert_eq!(v.status, "ok");
        assert_eq!(v.to, "TV/Bluey/Bluey (2018) - S01E03.mkv");
    }

    #[test]
    fn show_year_can_be_optional() {
        // Folder has the year, files don't: with the year optional nothing changes.
        let f = files(&["TV/Bluey (2018)/Season 01/Bluey - S01E01 - Magic Xylophone.mkv", "TV/Bluey/Season 01/x.txt"]);
        let mut r = req("TV/Bluey (2018)", TV);
        r.year = Some(2018);
        let ops = plan_tv(&f[..1], &r, &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops[0].status, "ok", "strict: the year is added to the file");
        r.year_optional = true;
        let ops = plan_tv(&f[..1], &r, &HashMap::new(), &nothing_exists).unwrap();
        assert!(ops.iter().all(|o| o.status == "unchanged"), "{ops:#?}");
        // Show folders are kept alike: one without the year gets it, the files stay as they are.
        let f = files(&["TV/Bluey/Season 01/Bluey - S01E01 - Magic Xylophone.mkv"]);
        let mut r = req("TV/Bluey", TV);
        r.year = Some(2018);
        r.year_optional = true;
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        let folders: Vec<_> = ops.iter().filter(|o| o.status == "ok").collect();
        assert_eq!(folders.len(), 1, "{ops:#?}");
        assert_eq!(folders[0].to, "TV/Bluey (2018)");
        assert_eq!(without_year("Bluey (2018) - S01E01.mkv"), "Bluey - S01E01.mkv");
    }

    #[test]
    fn episodes_can_be_moved_into_season_folders_on_request() {
        let f = files(&["Kids/Little Wonders Club/Little Wonders Club - S01E01 - Pancake Day.mp4"]);
        let mut r = req("Kids/Little Wonders Club", TV);
        assert_eq!(plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap()[0].status, "unchanged");
        r.season_folders = true;
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops[0].to, "Kids/Little Wonders Club/Season 01/Little Wonders Club - S01E01 - Pancake Day.mp4");
    }

    #[test]
    fn titles_from_the_internet_win() {
        let f = files(&["Peppa Pig (2004)/Season 01/01 muddy puddles.mp4"]);
        let mut titles = HashMap::new();
        titles.insert((1, 1), "Muddy Puddles".to_string());
        let ops = plan_tv(&f, &req("Peppa Pig (2004)", TV), &titles, &nothing_exists).unwrap();
        assert_eq!(ops[0].to, "Peppa Pig (2004)/Season 01/Peppa Pig (2004) - S01E01 - Muddy Puddles.mp4");
        assert_eq!(ops[0].title.as_deref(), Some("Muddy Puddles"));
    }

    #[test]
    fn conflicts_and_unreadable_names() {
        let f = files(&["Show/Season 1/Show.S01E01.mkv", "Show/Season 1/Show 1x01.mkv", "Show/Season 1/behind the scenes.mkv"]);
        let ops = plan_tv(&f, &req("Show", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(by_from(&ops, &f[0]).status, "conflict");
        assert_eq!(by_from(&ops, &f[1]).status, "conflict");
        assert_eq!(by_from(&ops, &f[2]).status, "unparsed");
    }

    #[test]
    fn find_replace_only_touches_file_names() {
        let f = files(&["Show/Season 01/Show.S01E01.Title.mkv"]);
        let mut r = req("Show", TV);
        r.find_replace = vec![FindReplace { find: "Title".into(), replace: "Name".into(), regex: false }];
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops[0].to, "Show/Season 01/Show - S01E01 - Name.mkv");
        r.find_replace = vec![FindReplace { find: "(".into(), replace: "".into(), regex: true }];
        assert!(plan_tv(&f, &r, &HashMap::new(), &nothing_exists).is_err());
    }

    #[test]
    fn movies_rename_their_own_folder() {
        let f = files(&[
            "Movies/The.Matrix.1999.1080p.BluRay/The.Matrix.1999.1080p.BluRay.x264.mkv",
            "Movies/The.Matrix.1999.1080p.BluRay/The.Matrix.1999.1080p.BluRay.x264.en.srt",
            "Movies/Mission Impossible - Fallout (2018).mp4",
        ]);
        let ops = plan_movies(&f, &req("Movies", MOVIE), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(by_from(&ops, &f[0]).to, "Movies/The Matrix (1999)/The Matrix (1999).mkv");
        assert_eq!(by_from(&ops, &f[1]).to, "Movies/The Matrix (1999)/The Matrix (1999).en.srt");
        assert_eq!(by_from(&ops, "Movies/The.Matrix.1999.1080p.BluRay").to, "Movies/The Matrix (1999)");
        let loose = by_from(&ops, &f[2]);
        assert_eq!(loose.to, "Movies/Mission Impossible - Fallout (2018)/Mission Impossible - Fallout (2018).mp4");
        assert_eq!(loose.note.as_deref(), Some("Gets its own folder"));
        // Second run: nothing left to do.
        let after = simulate(&f, &ops);
        let again = plan_movies(&after, &req("Movies", MOVIE), &HashMap::new(), &nothing_exists).unwrap();
        assert!(again.iter().all(|o| o.status == "unchanged"), "{again:#?}");
    }

    #[test]
    fn online_movie_matches_fix_titles() {
        let f = files(&["matrix.mkv"]);
        let mut m = HashMap::new();
        m.insert("matrix.mkv".to_string(), MovieMatch { title: "The Matrix".into(), year: Some(1999), tmdb: Some("603".into()) });
        let ops = plan_movies(&f, &req("", "{title}< ({year})>< {tmdbtag}>/{title}< ({year})>.{ext}"), &m, &nothing_exists).unwrap();
        assert_eq!(ops[0].to, "The Matrix (1999) {tmdb-603}/The Matrix (1999).mkv");
        assert_eq!(movie_guess("Inception (2010)/movie.mkv", ""), ("Inception".to_string(), Some(2010)));
    }

    #[test]
    fn detects_shows_and_movies() {
        assert_eq!(detect_kind(&files(&["a/S01E01.mkv", "a/S01E02.mkv"])), "tv");
        assert_eq!(detect_kind(&files(&["Season 1/01 Pilot.mkv"])), "tv");
        assert_eq!(detect_kind(&files(&["The Matrix (1999).mkv", "Heat (1995).mkv"])), "movie");
    }
}
