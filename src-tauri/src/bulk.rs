//! Renamer "Find & replace": the same edits over many titles at once (their files and their
//! own folder). Gives a normal rename plan, so it is previewed, applied and undone like any
//! other rename.

use crate::error::{Error, Result};
use crate::fsops::safe_rel;
use crate::naming::{is_video, sanitize, split_ext, split_path};
use crate::planner::{FindReplace, PlanOp};
use crate::rename_cmds::PlanResult;
use crate::state::{AppState, StoredPlan};
use regex::{Regex, RegexBuilder};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::OnceLock;
use tauri::State;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// The title's folder, relative to the library root.
    pub folder: String,
    /// Movies sharing a folder: only this video (and files with its name).
    #[serde(default)]
    pub file: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BulkOptions {
    #[serde(default)]
    pub rules: Vec<FindReplace>,
    /// Remove release tags (1080p, x265, WEB-DL, [YTS.MX] …) and dots for spaces.
    #[serde(default)]
    pub drop_tags: bool,
    /// "keep" | "add" | "remove" the S01E01 part of episode names.
    #[serde(default)]
    pub episode_tag: String,
    /// Also rename the title's own folder.
    #[serde(default)]
    pub include_folder: bool,
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[\s._\-\[\(])((?:2160|1080|720|576|480)[pi]|4k|uhd|x26[45]|h\.?26[45]|hevc|web-?dl|web-?rip|bluray|blu-ray|brrip|bdrip|dvdrip|hdtv|hdrip|amzn|dsnp|hmax|atvp|dd[p+]?[25][\. ]?[01]|ddp|aac(?:[25][\. ]?[01])?|e?ac3|dts(?:-?hd)?|atmos|truehd|10-?bit|8-?bit|hdr10\+?|hdr|dovi|proper|repack|remux|yts(?:\.[a-z]{2,3})?|rarbg|eztv|ettv)(?:[\s._\-\]\)]|$)",
        )
        .expect("tag pattern")
    })
}

fn ep_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\bS\d{1,3}\s?E\d{1,4}(?:-?E\d{1,4})*\b").expect("ep pattern"))
}

fn tidy(s: &str) -> String {
    let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t = collapsed.replace("()", "").replace("[]", "");
    while t.contains(" - - ") {
        t = t.replace(" - - ", " - ");
    }
    loop {
        let n = t.trim_matches(|c: char| c.is_whitespace() || c == '-' || c == '.' || c == '_').to_string();
        let n = n.strip_suffix(" (").or_else(|| n.strip_suffix(" [")).map(String::from).unwrap_or(n);
        if n == t {
            break;
        }
        t = n;
    }
    t
}

/// "Movie.Name.2019.1080p.WEB-DL.x264-GRP" → "Movie Name 2019".
pub fn drop_tags(stem: &str) -> String {
    let mut s = stem.to_string();
    // A release group in front: "[Erai-raws] Show - 01".
    if let Some(rest) = s.strip_prefix('[').and_then(|r| r.split_once(']')).map(|(_, r)| r.trim_start().to_string()) {
        if !rest.is_empty() {
            s = rest;
        }
    }
    if let Some(m) = tag_re().find(&s) {
        let cut = m.start();
        // Keep the name in front; a tag right at the start isn't a name to cut after.
        if cut > 0 {
            s.truncate(cut);
        }
    }
    // Scene style: dots or underscores for spaces.
    if !s.contains(' ') && (s.matches('.').count() >= 2 || s.contains('_')) {
        s = s.replace(['.', '_'], " ");
    }
    tidy(&s)
}

/// "Show - S01E02 - Title" → "Show - Title".
pub fn remove_episode_tag(stem: &str) -> String {
    tidy(&ep_re().replace_all(stem, " - "))
}

pub fn has_episode_tag(stem: &str) -> bool {
    ep_re().is_match(stem)
}

/// "Show - Title" → "Show - S01E05 - Title" (after the show name when it starts with it).
pub fn add_episode_tag(stem: &str, show: &str, season: u32, episode: u32, width: usize) -> String {
    if has_episode_tag(stem) {
        return stem.to_string();
    }
    let tag = format!("S{season:02}E{episode:0width$}");
    let lower = stem.to_lowercase();
    let sl = show.to_lowercase();
    if !sl.is_empty() && lower.starts_with(&sl) && stem.len() > show.len() {
        let rest = tidy(&stem[show.len()..]);
        return if rest.is_empty() { format!("{} - {tag}", &stem[..show.len()]) } else { format!("{} - {tag} - {rest}", &stem[..show.len()]) };
    }
    format!("{tag} - {stem}")
}

enum Rule {
    Literal(String, String),
    Pattern(Regex, String),
}

fn compile(rules: &[FindReplace]) -> Result<Vec<Rule>> {
    let mut out = Vec::new();
    for r in rules.iter().filter(|r| !r.find.is_empty()) {
        if r.regex {
            let re = RegexBuilder::new(&r.find)
                .size_limit(1 << 20)
                .build()
                .map_err(|_| Error::msg(format!("“{}” is not a valid pattern.", r.find)))?;
            out.push(Rule::Pattern(re, r.replace.clone()));
        } else {
            out.push(Rule::Literal(r.find.clone(), r.replace.clone()));
        }
    }
    Ok(out)
}

fn edit(stem: &str, opts: &BulkOptions, rules: &[Rule], remove_ep: bool) -> String {
    let mut s = stem.to_string();
    if opts.drop_tags {
        s = drop_tags(&s);
    }
    if remove_ep {
        s = remove_episode_tag(&s);
    }
    for r in rules {
        s = match r {
            Rule::Literal(f, t) => s.replace(f.as_str(), t),
            Rule::Pattern(re, t) => re.replace_all(&s, t.as_str()).into_owned(),
        };
    }
    let s = sanitize(&tidy(&s));
    if s.is_empty() { stem.to_string() } else { s }
}

fn skip(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('@') || name.eq_ignore_ascii_case("#recycle")
}

/// Every file under `dir` (relative to `root`), sorted; hidden and system folders left out.
fn files_under(root: &Path, dir: &Path, out: &mut Vec<(String, std::time::SystemTime)>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if skip(&name) {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => files_under(root, &e.path(), out),
            Ok(t) if t.is_file() => {
                if let Some(rel) = crate::local::rel_to_root(root, &e.path()) {
                    let m = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    out.push((rel, m));
                }
            }
            _ => {}
        }
    }
}

fn op(from: String, step_to: String, to: String, kind: &'static str) -> PlanOp {
    PlanOp { from, to, kind, status: "ok", note: None, season: None, episodes: vec![], verified: true, score: None, step_to, title: None }
}

/// The plan for every target. Files keep their folder; sidecars follow their video.
pub fn plan(root: &Path, targets: &[Target], opts: &BulkOptions) -> Result<Vec<PlanOp>> {
    let rules = compile(&opts.rules)?;
    let mut ops: Vec<PlanOp> = Vec::new();
    for t in targets {
        safe_rel(&t.folder)?;
        let dir = root.join(&t.folder);
        if t.folder.is_empty() || !dir.is_dir() {
            continue;
        }
        let mut all = Vec::new();
        files_under(root, &dir, &mut all);
        if let Some(f) = &t.file {
            // Only this movie: the video and the files named like it.
            let stem = split_ext(split_path(f).1).0.to_string();
            all.retain(|(p, _)| {
                let (d, n) = split_path(p);
                d == split_path(f).0 && (n == split_path(f).1 || n.starts_with(&format!("{stem}.")))
            });
        }
        let videos: Vec<(String, std::time::SystemTime)> = all.iter().filter(|(p, _)| is_video(split_path(p).1)).cloned().collect();
        // A shared folder (several movies) is never renamed for one of them.
        let folder_own = t.file.is_none() || videos.len() == 1 && {
            let mut every = Vec::new();
            files_under(root, &dir, &mut every);
            every.iter().filter(|(p, _)| is_video(split_path(p).1)).count() == 1
        };
        let folder_name = split_path(&t.folder).1.to_string();
        let new_folder = if opts.include_folder && folder_own { edit(&folder_name, opts, &rules, false) } else { folder_name.clone() };
        let new_folder_rel = {
            let parent = split_path(&t.folder).0;
            if parent.is_empty() { new_folder.clone() } else { format!("{parent}/{new_folder}") }
        };
        let show = crate::planner::without_year(&folder_name);
        let show = show.trim();

        // Numbers for "add": per folder, oldest first, after the highest one already there.
        let mut numbers: HashMap<String, u32> = HashMap::new();
        if opts.episode_tag == "add" {
            let mut by_dir: HashMap<String, Vec<&(String, std::time::SystemTime)>> = HashMap::new();
            for v in &videos {
                by_dir.entry(split_path(&v.0).0.to_string()).or_default().push(v);
            }
            for (_, mut list) in by_dir {
                list.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
                let mut n = 0;
                for v in list {
                    if has_episode_tag(split_ext(split_path(&v.0).1).0) {
                        continue;
                    }
                    n += 1;
                    numbers.insert(v.0.clone(), n);
                }
            }
        }
        let width = if numbers.len() >= 100 { 3 } else { 2 };
        let season_of = |p: &str| -> u32 {
            split_path(p).0.rsplit('/').next().and_then(crate::naming::season_from_dir).unwrap_or(1)
        };

        let mut renamed: HashMap<String, (String, String)> = HashMap::new(); // video path → (old stem, new stem)
        for (v, _) in &videos {
            let (_, name) = split_path(v);
            let (stem, _) = split_ext(name);
            let mut new = edit(stem, opts, &rules, opts.episode_tag == "remove");
            if let Some(n) = numbers.get(v) {
                new = add_episode_tag(&new, show, season_of(v), *n, width);
            }
            renamed.insert(v.clone(), (stem.to_string(), new));
        }
        for (p, _) in &all {
            let (d, name) = split_path(p);
            let (stem, ext) = split_ext(name);
            let (new_name, kind) = if let Some((_, new)) = renamed.get(p) {
                (if ext.is_empty() { new.clone() } else { format!("{new}.{ext}") }, "video")
            } else if let Some((old, new)) = renamed
                .iter()
                .filter(|(vp, _)| split_path(vp).0 == d)
                .map(|(_, x)| x)
                .find(|(old, _)| name.starts_with(&format!("{old}.")))
            {
                (format!("{new}{}", &name[old.len()..]), "sidecar")
            } else if t.file.is_none() {
                let new = edit(stem, opts, &rules, opts.episode_tag == "remove");
                (if ext.is_empty() { new } else { format!("{new}.{ext}") }, "file")
            } else {
                continue;
            };
            let step = if d.is_empty() { new_name.clone() } else { format!("{d}/{new_name}") };
            let fin = format!("{new_folder_rel}{}", &step[t.folder.len()..]);
            let mut o = op(p.clone(), step, fin, kind);
            if new_name == name {
                o.status = "unchanged";
            }
            ops.push(o);
        }
        if new_folder != folder_name {
            ops.push(op(t.folder.clone(), String::new(), new_folder_rel, "folder"));
        }
    }
    // Clashes: an existing file with the new name, or two changes ending at the same place.
    let mut seen: HashSet<String> = HashSet::new();
    let sources: HashSet<String> = ops.iter().map(|o| o.from.to_lowercase()).collect();
    for o in ops.iter_mut().filter(|o| o.status == "ok") {
        let target = if o.step_to.is_empty() { o.to.clone() } else { o.step_to.clone() };
        let case_only = target.to_lowercase() == o.from.to_lowercase();
        if !seen.insert(o.to.to_lowercase()) {
            o.status = "conflict";
            o.note = Some("Two files would get the same name, so this one is skipped".into());
        } else if !case_only && root.join(&target).exists() && !sources.contains(&target.to_lowercase()) {
            o.status = "conflict";
            o.note = Some("A file with the new name already exists, so this one is skipped".into());
        }
    }
    Ok(ops)
}

#[tauri::command]
pub async fn bulk_plan(state: State<'_, AppState>, targets: Vec<Target>, options: BulkOptions) -> Result<PlanResult> {
    let root = state.library_root()?;
    let r2 = root.clone();
    let ops = tauri::async_runtime::spawn_blocking(move || plan(&r2, &targets, &options))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    let plan_id = format!("bulk-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let count = |s: &str| ops.iter().filter(|o| o.status == s).count();
    let result = PlanResult {
        plan_id: plan_id.clone(),
        ok: count("ok"),
        unchanged: count("unchanged"),
        conflict: count("conflict"),
        unparsed: 0,
        titles_found: 0,
        warning: None,
        ops: ops.clone(),
        guess: String::new(),
        candidates: vec![],
        chosen: None,
        matched_movies: 0,
        mode: "bulk".into(),
    };
    state.set_plan(StoredPlan { id: plan_id, root, ops })?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_release_tags() {
        assert_eq!(drop_tags("Movie.Name.2019.1080p.WEB-DL.x264-GRP"), "Movie Name 2019");
        assert_eq!(drop_tags("Dune (2021) [2160p] [4K] [WEB] [5.1] [YTS.MX]"), "Dune (2021)");
        assert_eq!(drop_tags("Show - S01E02 - Title.1080p.BluRay.x265.HEVC"), "Show - S01E02 - Title");
        assert_eq!(drop_tags("[Erai-raws] Some Anime - 01 [1080p]"), "Some Anime - 01");
        assert_eq!(drop_tags("The.Office.S02E03.720p.HDTV.AAC2.0"), "The Office S02E03");
        assert_eq!(drop_tags("Charlotte's Web (1973)"), "Charlotte's Web (1973)", "plain names stay");
        assert_eq!(drop_tags("Show - S01E01 - Pilot"), "Show - S01E01 - Pilot");
        assert_eq!(drop_tags("Film 2020 DDP5.1 Atmos"), "Film 2020");
    }

    #[test]
    fn removes_and_adds_episode_tags() {
        assert_eq!(remove_episode_tag("Show - S01E02 - Title"), "Show - Title");
        assert_eq!(remove_episode_tag("S01E02 - Title"), "Title");
        assert_eq!(remove_episode_tag("Show S01E02E03 Title"), "Show - Title");
        assert_eq!(remove_episode_tag("No tag here"), "No tag here");
        assert_eq!(add_episode_tag("Channel - My video", "Channel", 1, 5, 2), "Channel - S01E05 - My video");
        assert_eq!(add_episode_tag("My video", "Channel", 1, 7, 3), "S01E007 - My video");
        assert_eq!(add_episode_tag("Show - S01E02 - x", "Show", 1, 9, 2), "Show - S01E02 - x", "already has one");
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, b"x").unwrap();
    }

    #[test]
    fn plans_files_sidecars_and_folder() {
        let root = std::env::temp_dir().join(format!("mh-bulk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        touch(&root, "YT/Chan.1080p/Chan - S01E01 - Hello.1080p.WEB-DL.mkv");
        touch(&root, "YT/Chan.1080p/Chan - S01E01 - Hello.1080p.WEB-DL.en.srt");
        touch(&root, "YT/Chan.1080p/poster.jpg");
        let opts = BulkOptions { drop_tags: true, episode_tag: "remove".into(), include_folder: true, ..Default::default() };
        let ops = plan(&root, &[Target { folder: "YT/Chan.1080p".into(), file: None }], &opts).unwrap();
        let v = ops.iter().find(|o| o.kind == "video").unwrap();
        assert_eq!(v.step_to, "YT/Chan.1080p/Chan - Hello.mkv");
        assert_eq!(v.to, "YT/Chan/Chan - Hello.mkv");
        let s = ops.iter().find(|o| o.kind == "sidecar").unwrap();
        assert_eq!(s.to, "YT/Chan/Chan - Hello.en.srt");
        assert_eq!(ops.iter().find(|o| o.from.ends_with("poster.jpg")).unwrap().status, "unchanged");
        let f = ops.last().unwrap();
        assert_eq!((f.kind, f.to.as_str()), ("folder", "YT/Chan"));

        // Find & replace and numbering.
        let opts = BulkOptions { rules: vec![FindReplace { find: "Hello".into(), replace: "Hi".into(), regex: false }], episode_tag: "keep".into(), ..Default::default() };
        let ops = plan(&root, &[Target { folder: "YT/Chan.1080p".into(), file: None }], &opts).unwrap();
        assert!(ops.iter().any(|o| o.to.ends_with("Chan - S01E01 - Hi.1080p.WEB-DL.mkv")));
        assert!(!ops.iter().any(|o| o.kind == "folder"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
