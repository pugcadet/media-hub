//! Builds a rename plan from a list of file paths. Pure: no disk, no network.
//! Every path in and out is relative to the library root and uses `/` between folders.

use crate::naming::*;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

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
    /// Show folder (TV) or folder with movie files, relative to the root. May be empty for movies.
    pub folder: String,
    pub show: Option<String>,
    pub year: Option<i32>,
    #[serde(default)]
    pub find_replace: Vec<FindReplace>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanOp {
    pub from: String,
    pub to: String,
    /// "video" | "sidecar"
    pub kind: &'static str,
    /// "ok" | "unchanged" | "conflict" | "unparsed"
    pub status: &'static str,
    pub note: Option<String>,
    pub season: Option<u32>,
    pub episodes: Vec<u32>,
    /// True when reading the NEW name back gives the same season/episode (or title/year).
    pub verified: bool,
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

fn apply_rules(stem: &str, rules: &[Rule]) -> String {
    let mut s = stem.to_string();
    for r in rules {
        s = match r {
            Rule::Literal(f, t) => s.replace(f.as_str(), t),
            Rule::Pattern(re, t) => re.replace_all(&s, t.as_str()).to_string(),
        };
    }
    s
}

/// Applies the find/replace rules to the file name part only (never to folders or the extension).
fn with_rules(path: &str, rules: &[Rule]) -> String {
    if rules.is_empty() {
        return path.to_string();
    }
    let (dir, name) = split_path(path);
    let (stem, ext) = split_ext(name);
    let new_stem = apply_rules(stem, rules);
    let mut new_name = if ext.is_empty() { new_stem } else { format!("{new_stem}.{ext}") };
    new_name = sanitize_keep_ext(&new_name);
    if dir.is_empty() { new_name } else { format!("{dir}/{new_name}") }
}

fn sanitize_keep_ext(name: &str) -> String {
    let (stem, ext) = split_ext(name);
    let s = sanitize(stem);
    if ext.is_empty() { s } else { format!("{s}.{ext}") }
}

struct VideoInfo {
    from: String,
    to: String,
}

fn status_pass(ops: &mut [PlanOp], exists: &dyn Fn(&str) -> bool) {
    let lower = |s: &str| s.to_lowercase();
    let mut count: HashMap<String, usize> = HashMap::new();
    for op in ops.iter() {
        *count.entry(lower(&op.to)).or_default() += 1;
    }
    let vacated: HashSet<String> = ops
        .iter()
        .filter(|o| o.from != o.to)
        .map(|o| lower(&o.from))
        .collect();
    for op in ops.iter_mut() {
        if op.status == "unparsed" {
            continue;
        }
        if op.from == op.to {
            op.status = "unchanged";
            continue;
        }
        let same_name_ignoring_case = lower(&op.from) == lower(&op.to);
        if count[&lower(&op.to)] > 1 {
            op.status = "conflict";
            op.note = Some("Another file would get exactly this name.".into());
        } else if !same_name_ignoring_case && vacated.contains(&lower(&op.to)) {
            op.status = "conflict";
            op.note = Some("This name belongs to a file that is also being renamed. Rename in two rounds.".into());
        } else if !same_name_ignoring_case && exists(&op.to) {
            op.status = "conflict";
            op.note = Some("A file with this name already exists.".into());
        } else {
            op.status = "ok";
        }
    }
}

/// Subtitle files travel with their video: "X.en.srt" follows "X.mkv".
fn add_sidecars(files: &[String], videos: &[VideoInfo], rules: &[Rule], ops: &mut Vec<PlanOp>) {
    for f in files {
        let (dir, name) = split_path(f);
        if !is_sidecar(name) {
            continue;
        }
        let mut best: Option<(&VideoInfo, usize)> = None;
        for v in videos {
            let (vdir, vname) = split_path(&v.from);
            if vdir != dir {
                continue;
            }
            let vstem = split_ext(vname).0;
            let prefix = format!("{vstem}.");
            if name.starts_with(&prefix) && best.map(|b| vstem.len() > b.1).unwrap_or(true) {
                best = Some((v, vstem.len()));
            }
        }
        let Some((v, old_len)) = best else { continue };
        let rest = &name[old_len..]; // ".en.srt"
        let (ndir, nname) = split_path(&v.to);
        let new_stem = split_ext(nname).0;
        let mut to = if ndir.is_empty() { format!("{new_stem}{rest}") } else { format!("{ndir}/{new_stem}{rest}") };
        // Rules were already applied to the video's name; the sidecar follows it exactly.
        let _ = rules;
        if to.is_empty() {
            to = f.clone();
        }
        ops.push(PlanOp {
            from: f.clone(),
            to,
            kind: "sidecar",
            status: "ok",
            note: None,
            season: None,
            episodes: Vec::new(),
            verified: true,
        });
    }
}

pub fn plan_tv(
    files: &[String],
    req: &PlanRequest,
    titles: &HashMap<(u32, u32), String>,
    exists: &dyn Fn(&str) -> bool,
) -> Result<Vec<PlanOp>, String> {
    let tpl = Template::parse(&req.template, TV_TOKENS)?;
    let rules = compile_rules(&req.find_replace)?;

    let folder_name = req.folder.rsplit('/').next().unwrap_or("");
    let parsed = parse_name(folder_name);
    let show = req
        .show
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| parsed.title.clone());
    let year = req.year.or(parsed.year);
    if show.trim().is_empty() {
        return Err("Could not work out the show name. Type it in.".into());
    }

    let mut ops: Vec<PlanOp> = Vec::new();
    let mut videos: Vec<VideoInfo> = Vec::new();

    for f in files.iter().filter(|f| is_video(split_path(f).1)) {
        let (dir, name) = split_path(f);
        let (stem, ext) = split_ext(name);
        let hint = dir.rsplit('/').find_map(season_from_dir);

        let Some(m) = parse_episode(stem, hint) else {
            ops.push(PlanOp {
                from: f.clone(),
                to: f.clone(),
                kind: "video",
                status: "unparsed",
                note: Some("Could not find a season and episode number in this name.".into()),
                season: None,
                episodes: Vec::new(),
                verified: false,
            });
            continue;
        };

        let looked_up: Vec<&String> = m.episodes.iter().filter_map(|e| titles.get(&(m.season, *e))).collect();
        let title = if looked_up.len() == m.episodes.len() {
            let mut names: Vec<&str> = looked_up.iter().map(|s| s.as_str()).collect();
            names.dedup();
            names.join(" + ")
        } else {
            title_after(stem, &m)
        };

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
        vars.insert(
            "seasondir",
            Var::text(if m.season == 0 { "Specials".to_string() } else { format!("Season {:02}", m.season) }),
        );
        if !title.is_empty() {
            vars.insert("title", Var::text(title));
        }
        vars.insert("ext", Var::text(ext.to_lowercase()));
        if let Some(id) = &parsed.tmdb {
            vars.insert("tmdbtag", Var::text(format!("{{tmdb-{id}}}")));
        }
        if let Some(id) = &parsed.tvdb {
            vars.insert("tvdbtag", Var::text(format!("{{tvdb-{id}}}")));
        }

        let to = match tpl.render(&vars) {
            Ok(p) => with_rules(&p, &rules),
            Err(why) => {
                ops.push(PlanOp {
                    from: f.clone(),
                    to: f.clone(),
                    kind: "video",
                    status: "unparsed",
                    note: Some(why),
                    season: Some(m.season),
                    episodes: m.episodes.clone(),
                    verified: false,
                });
                continue;
            }
        };

        let (nd, nn) = split_path(&to);
        let verified = parse_episode(split_ext(nn).0, nd.rsplit('/').find_map(season_from_dir))
            .map(|r| r.season == m.season && r.episodes == m.episodes)
            .unwrap_or(false);

        videos.push(VideoInfo { from: f.clone(), to: to.clone() });
        ops.push(PlanOp {
            from: f.clone(),
            to,
            kind: "video",
            status: "ok",
            note: if verified { None } else { Some("The new name does not read back as the same episode. Check the pattern.".into()) },
            season: Some(m.season),
            episodes: m.episodes,
            verified,
        });
    }

    add_sidecars(files, &videos, &rules, &mut ops);
    status_pass(&mut ops, exists);
    ops.sort_by(|a, b| a.to.to_lowercase().cmp(&b.to.to_lowercase()).then(a.kind.cmp(b.kind)));
    Ok(ops)
}

pub fn plan_movies(
    files: &[String],
    req: &PlanRequest,
    exists: &dyn Fn(&str) -> bool,
) -> Result<Vec<PlanOp>, String> {
    let tpl = Template::parse(&req.template, MOVIE_TOKENS)?;
    let rules = compile_rules(&req.find_replace)?;
    let folder_name = req.folder.rsplit('/').next().unwrap_or("");

    let mut ops: Vec<PlanOp> = Vec::new();
    let mut videos: Vec<VideoInfo> = Vec::new();

    for f in files.iter().filter(|f| is_video(split_path(f).1)) {
        let (dir, name) = split_path(f);
        let (stem, ext) = split_ext(name);
        let mut p = parse_name(stem);
        // A file named "movie.mkv" inside a folder "Inception (2010)" takes its name from the folder.
        if (p.title.is_empty() || p.year.is_none()) && !dir.is_empty() && dir.rsplit('/').next() != Some(folder_name) {
            let from_dir = parse_name(dir.rsplit('/').next().unwrap_or(""));
            if p.year.is_none() {
                p.year = from_dir.year;
            }
            if p.title.is_empty() {
                p.title = from_dir.title;
            }
        }
        let title = req.show.clone().filter(|s| !s.trim().is_empty() && files.len() == 1).unwrap_or(p.title.clone());
        let year = req.year.filter(|_| files.len() == 1).or(p.year);

        let mut vars: HashMap<&str, Var> = HashMap::new();
        vars.insert("title", Var::text(title.as_str()));
        if let Some(y) = year {
            vars.insert("year", Var { text: y.to_string(), num: Some(y.max(0) as u32) });
        }
        vars.insert("ext", Var::text(ext.to_lowercase()));
        if let Some(id) = &p.tmdb {
            vars.insert("tmdbtag", Var::text(format!("{{tmdb-{id}}}")));
        }
        if let Some(id) = &p.imdb {
            vars.insert("imdbtag", Var::text(format!("{{imdb-{id}}}")));
        }

        let to = match tpl.render(&vars) {
            Ok(path) => with_rules(&path, &rules),
            Err(why) => {
                ops.push(PlanOp {
                    from: f.clone(),
                    to: f.clone(),
                    kind: "video",
                    status: "unparsed",
                    note: Some(why),
                    season: None,
                    episodes: Vec::new(),
                    verified: false,
                });
                continue;
            }
        };
        let back = parse_name(split_ext(split_path(&to).1).0);
        let verified = back.title.eq_ignore_ascii_case(&title) && back.year == year;
        videos.push(VideoInfo { from: f.clone(), to: to.clone() });
        ops.push(PlanOp {
            from: f.clone(),
            to,
            kind: "video",
            status: "ok",
            note: if verified { None } else { Some("The new name does not read back as the same title and year.".into()) },
            season: None,
            episodes: Vec::new(),
            verified,
        });
    }

    add_sidecars(files, &videos, &rules, &mut ops);
    status_pass(&mut ops, exists);
    ops.sort_by(|a, b| a.to.to_lowercase().cmp(&b.to.to_lowercase()).then(a.kind.cmp(b.kind)));
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TV: &str = "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}";
    const MOVIE: &str = "{title}< ({year})>/{title}< ({year})>.{ext}";

    fn req(folder: &str, template: &str) -> PlanRequest {
        PlanRequest { template: template.into(), folder: folder.into(), show: None, year: None, find_replace: vec![] }
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn nothing_exists(_: &str) -> bool {
        false
    }

    fn by_from<'a>(ops: &'a [PlanOp], from: &str) -> &'a PlanOp {
        ops.iter().find(|o| o.from == from).expect("op for file")
    }

    #[test]
    fn renames_tv_files_into_standard_layout() {
        let f = files(&[
            "Bluey (2018)/Season 1/Bluey.S01E01.Magic.Xylophone.1080p.mkv",
            "Bluey (2018)/Season 1/Bluey - 1x02.mp4",
            "Bluey (2018)/Season 1/Bluey.S01E03-E04.mkv",
            "Bluey (2018)/Specials/Bluey S00E01 Minisode.mkv",
            "Bluey (2018)/Season 1/Bluey.S01E01.Magic.Xylophone.1080p.en.srt",
        ]);
        let ops = plan_tv(&f, &req("Bluey (2018)", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(
            by_from(&ops, &f[0]).to,
            "Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic Xylophone.mkv"
        );
        assert_eq!(by_from(&ops, &f[1]).to, "Bluey (2018)/Season 01/Bluey (2018) - S01E02.mp4");
        assert_eq!(by_from(&ops, &f[2]).to, "Bluey (2018)/Season 01/Bluey (2018) - S01E03-E04.mkv");
        assert_eq!(by_from(&ops, &f[3]).to, "Bluey (2018)/Specials/Bluey (2018) - S00E01 - Minisode.mkv");
        assert_eq!(
            by_from(&ops, &f[4]).to,
            "Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic Xylophone.en.srt"
        );
        assert!(ops.iter().all(|o| o.status == "ok" && o.verified), "{ops:#?}");
    }

    #[test]
    fn titles_from_the_server_win_over_file_names() {
        let f = files(&["Peppa Pig (2004)/Season 1/01 muddy puddles.mp4"]);
        let mut titles = HashMap::new();
        titles.insert((1, 1), "Muddy Puddles".to_string());
        let ops = plan_tv(&f, &req("Peppa Pig (2004)", TV), &titles, &nothing_exists).unwrap();
        assert_eq!(ops[0].to, "Peppa Pig (2004)/Season 01/Peppa Pig (2004) - S01E01 - Muddy Puddles.mp4");
    }

    #[test]
    fn unreadable_names_are_left_alone() {
        let f = files(&["Show/Season 1/behind the scenes.mkv"]);
        let ops = plan_tv(&f, &req("Show", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops[0].status, "unparsed");
        assert_eq!(ops[0].to, ops[0].from);
    }

    #[test]
    fn already_correct_files_are_unchanged() {
        let f = files(&["Bluey (2018)/Season 01/Bluey (2018) - S01E01 - Magic Xylophone.mkv"]);
        let ops = plan_tv(&f, &req("Bluey (2018)", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert_eq!(ops[0].status, "unchanged");
    }

    #[test]
    fn two_files_for_one_name_conflict() {
        let f = files(&["Show/Season 1/Show.S01E01.mkv", "Show/Season 1/Show 1x01.mkv"]);
        let ops = plan_tv(&f, &req("Show", TV), &HashMap::new(), &nothing_exists).unwrap();
        assert!(ops.iter().all(|o| o.status == "conflict"));
    }

    #[test]
    fn existing_target_conflicts_but_case_only_change_does_not() {
        let f = files(&["Show/Season 1/Show.S01E01.mkv"]);
        let ops = plan_tv(&f, &req("Show", TV), &HashMap::new(), &|p| p == "Show/Season 01/Other.mkv").unwrap();
        assert_eq!(ops[0].status, "ok");
        assert_eq!(ops[0].to, "Show/Season 01/Show - S01E01.mkv");
        let ops2 = plan_tv(&f, &req("Show", TV), &HashMap::new(), &|_| true).unwrap();
        assert_eq!(ops2[0].status, "conflict");
        let f3 = files(&["show/season 01/show - S01E01.mkv"]);
        let mut r = req("show", TV);
        r.show = Some("show".into());
        let ops3 = plan_tv(&f3, &r, &HashMap::new(), &|_| true).unwrap();
        assert_ne!(ops3[0].status, "conflict");
    }

    #[test]
    fn find_replace_changes_only_the_file_name() {
        let f = files(&["Show/Season 1/Show.S01E01.Title.mkv"]);
        let mut r = req("Show", TV);
        r.find_replace = vec![
            FindReplace { find: "Title".into(), replace: "Name".into(), regex: false },
            FindReplace { find: r"S(\d+)E(\d+)".into(), replace: "S${1}E${2}".into(), regex: true },
            FindReplace { find: "Show".into(), replace: "Series".into(), regex: false },
        ];
        let ops = plan_tv(&f, &r, &HashMap::new(), &nothing_exists).unwrap();
        // Folder "Show" stays; only the file name is rewritten.
        assert_eq!(ops[0].to, "Show/Season 01/Series - S01E01 - Name.mkv");
    }

    #[test]
    fn bad_patterns_report_an_error() {
        let mut r = req("Show", TV);
        r.find_replace = vec![FindReplace { find: "(".into(), replace: "".into(), regex: true }];
        assert!(plan_tv(&[], &r, &HashMap::new(), &nothing_exists).is_err());
        assert!(plan_tv(&[], &req("Show", "{bogus}"), &HashMap::new(), &nothing_exists).is_err());
    }

    #[test]
    fn movies_get_their_own_folder() {
        let f = files(&[
            "The.Matrix.1999.1080p.BluRay.x264.mkv",
            "The.Matrix.1999.1080p.BluRay.x264.en.srt",
            "Mission Impossible - Fallout (2018).mp4",
        ]);
        let ops = plan_movies(&f, &req("", MOVIE), &nothing_exists).unwrap();
        assert_eq!(by_from(&ops, &f[0]).to, "The Matrix (1999)/The Matrix (1999).mkv");
        assert_eq!(by_from(&ops, &f[1]).to, "The Matrix (1999)/The Matrix (1999).en.srt");
        assert_eq!(
            by_from(&ops, &f[2]).to,
            "Mission Impossible - Fallout (2018)/Mission Impossible - Fallout (2018).mp4"
        );
        assert!(ops.iter().all(|o| o.status == "ok"));
    }

    #[test]
    fn movie_id_tags_can_be_kept() {
        let f = files(&["Inception (2010) {tmdb-27205}.mp4"]);
        let ops = plan_movies(
            &f,
            &req("", "{title}< ({year})>< {tmdbtag}>/{title}< ({year})>< {tmdbtag}>.{ext}"),
            &nothing_exists,
        )
        .unwrap();
        assert_eq!(ops[0].to, "Inception (2010) {tmdb-27205}/Inception (2010) {tmdb-27205}.mp4");
    }
}
