//! The Inbox: new downloads in one folder you choose. Media Hub works out what each one is
//! (episodes of a show you have, a new show, a movie, an album, something else), where it
//! goes and under which name, and skips what you already have. Nothing moves until you say
//! so: then the files go to the library (moved, or copied and checked when it's another
//! drive) and the download goes to the system Trash, from where it can be put back.

use crate::error::{Error, Result};
use crate::fsops::safe_rel;
use crate::import::{describe, is_audio};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::naming::{is_sidecar, is_video, parse_episode, parse_name, sanitize, season_from_dir, split_ext};
use crate::state::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxFile {
    /// Inside the download (forward slashes), or the file name.
    pub rel: String,
    pub size: u64,
    pub video: bool,
    pub season: Option<u32>,
    pub episodes: Vec<u32>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MusicInfo {
    pub artist: String,
    pub album: String,
    pub year: Option<i32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// Its name in the downloads folder (the key for everything else).
    pub key: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: u64,
    /// Best guess: "tv" | "movie" | "music" | "other".
    pub kind: &'static str,
    /// Show or movie title from the names, and the year.
    pub title: String,
    pub year: Option<i32>,
    pub files: Vec<InboxFile>,
    pub music: Option<MusicInfo>,
}

fn re_marker() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)(?:^|[ ._\-\[(])(?:s\d{1,3}[ ._-]?e\d{1,4}|\d{1,2}x\d{2,3}|season[ ._-]?\d+|complete)").expect("marker pattern"))
}

/// "Severance.S02E04.1080p" → "Severance"; "The.Bear.2022.S03E01" → ("The Bear", 2022).
pub fn show_title_of(stem: &str) -> (String, Option<i32>) {
    let before = re_marker().find(stem).map(|m| &stem[..m.start()]).unwrap_or(stem);
    let p = parse_name(before);
    (p.title, p.year)
}

/// "Drake feat. Rihanna" → "Drake": featured artists stay with the main artist.
pub fn main_artist(a: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?i)\s*(?:[\(\[]\s*)?(?:\bfeat\.?|\bft\.?|\bfeaturing\b|;).*$").expect("feat pattern"));
    let out = re.replace(a.trim(), "").trim().to_string();
    if out.is_empty() { a.trim().to_string() } else { out }
}

/// Album artist, album and year from the songs' tags (the most common answer wins).
fn music_info(base: &Path, files: &[InboxFile]) -> Option<MusicInfo> {
    use lofty::prelude::*;
    let mut artists: HashMap<String, usize> = HashMap::new();
    let mut albums: HashMap<String, usize> = HashMap::new();
    let mut year = None;
    for f in files.iter().filter(|f| is_audio(&f.rel)).take(12) {
        let opts = lofty::config::ParseOptions::new().read_cover_art(false);
        let Ok(probe) = lofty::probe::Probe::open(base.join(&f.rel)) else { continue };
        let Ok(file) = probe.options(opts).read() else { continue };
        let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) else { continue };
        let artist = tag.get_string(&ItemKey::AlbumArtist).map(String::from).or_else(|| tag.artist().map(|a| a.to_string()));
        if let Some(a) = artist.map(|a| main_artist(&a)).filter(|a| !a.is_empty()) {
            *artists.entry(a).or_default() += 1;
        }
        if let Some(al) = tag.album().map(|a| a.trim().to_string()).filter(|a| !a.is_empty()) {
            *albums.entry(al).or_default() += 1;
        }
        year = year.or(tag.year().map(|y| y as i32).filter(|y| (1900..2100).contains(y)));
    }
    let top = |m: HashMap<String, usize>| m.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|x| x.0);
    let (artist, album) = (top(artists)?, top(albums)?);
    Some(MusicInfo { artist, album, year })
}

fn inbox_dir(state: &AppState) -> Result<PathBuf> {
    let dir = state.settings()?.inbox_dir.ok_or_else(|| Error::msg("Choose your downloads folder first."))?;
    let p = PathBuf::from(dir);
    if !p.is_dir() {
        return Err(Error::msg("The downloads folder can't be reached. Is the drive connected?"));
    }
    Ok(p)
}

fn item_path(state: &AppState, key: &str) -> Result<PathBuf> {
    if key.is_empty() || key.contains('/') || key.contains('\\') || key == "." || key == ".." {
        return Err(Error::msg("bad name"));
    }
    let p = inbox_dir(state)?.join(key);
    if !p.exists() {
        return Err(Error::msg("That download isn't in the folder any more."));
    }
    Ok(p)
}

fn read_item(path: &Path, key: &str, modified: u64) -> Option<InboxItem> {
    let src = describe(path).ok()?;
    let v: Value = serde_json::to_value(&src).ok()?;
    let is_folder = v.get("isFolder").and_then(Value::as_bool).unwrap_or(false);
    let kind_guess = v.get("kind").and_then(Value::as_str).unwrap_or("movie").to_string();
    let base = if is_folder { path.to_path_buf() } else { path.parent()?.to_path_buf() };
    let mut files: Vec<InboxFile> = v
        .get("files")?
        .as_array()?
        .iter()
        .filter_map(|f| {
            let rel = f.get("rel")?.as_str()?.to_string();
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let video = is_video(&name);
            // A season folder in the download ("Season 2/03.mkv") helps.
            let hint = rel.rsplit('/').nth(1).and_then(season_from_dir);
            let ep = if video { parse_episode(split_ext(&name).0, hint) } else { None };
            Some(InboxFile { rel, size: f.get("size")?.as_u64().unwrap_or(0), video, season: ep.as_ref().map(|e| e.season), episodes: ep.map(|e| e.episodes).unwrap_or_default() })
        })
        .collect();
    files.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
    let size = files.iter().map(|f| f.size).sum();
    let audio = files.iter().any(|f| is_audio(&f.rel));
    let stem = if is_folder { key.to_string() } else { split_ext(key).0.to_string() };
    if audio && !files.iter().any(|f| f.video) {
        let music = music_info(&base, &files);
        let p = parse_name(&stem);
        return Some(InboxItem { key: key.into(), is_folder, size, modified, kind: "music", title: music.as_ref().map(|m| m.album.clone()).unwrap_or(p.title), year: music.as_ref().and_then(|m| m.year).or(p.year), files, music });
    }
    let has_eps = files.iter().any(|f| f.video && f.season.is_some());
    let kind: &'static str = if has_eps || kind_guess == "tv" { "tv" } else { "movie" };
    let (title, year) = if kind == "tv" {
        // The show's name: before the episode marker of the folder or the first episode.
        let (t, y) = show_title_of(&stem);
        if !t.is_empty() { (t, y) } else { files.iter().find(|f| f.video).map(|f| show_title_of(split_ext(f.rel.rsplit('/').next().unwrap_or(&f.rel)).0)).unwrap_or_default() }
    } else {
        let p = parse_name(&stem);
        (p.title, p.year)
    };
    Some(InboxItem { key: key.into(), is_folder, size, modified, kind, title, year, files, music: None })
}

/// What's in the downloads folder now (newest first).
#[tauri::command]
pub async fn inbox_scan(state: State<'_, AppState>) -> Result<(Option<String>, Vec<InboxItem>)> {
    let Some(dir) = state.settings()?.inbox_dir else { return Ok((None, Vec::new())) };
    let d2 = PathBuf::from(&dir);
    let list = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<InboxItem>> {
        let rd = std::fs::read_dir(&d2).map_err(|_| Error::msg("The downloads folder can't be read. Is the drive connected?"))?;
        let mut out = Vec::new();
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".part") || name.ends_with(".mediahub-part") || name.ends_with(".!qB") || name.ends_with(".crdownload") {
                continue;
            }
            let p = e.path();
            if !(p.is_dir() || is_video(&name) || is_audio(&name)) {
                continue;
            }
            let modified = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            if let Some(item) = read_item(&p, &name, modified) {
                out.push(item);
            }
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    Ok((Some(dir), list))
}

/* ------------------------------------------------------------------ where it goes */

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// "tv" | "movie" | "music" | "other"
    pub kind: String,
    /// A show or movie already in Jellyfin: it goes there.
    pub item_id: Option<String>,
    /// The main folder for something new ("TV", "Kids", "Movies", "Music", "YouTube").
    pub top: String,
    pub title: String,
    pub year: Option<i32>,
    /// For episodes without a season in their name.
    pub season: Option<u32>,
    /// Music: the album artist and album (from the tags, or as you typed them).
    pub artist: Option<String>,
    pub album: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    /// Inside the download.
    pub from: String,
    /// In the library (relative to the library folder).
    pub to: String,
    /// Already there (same episode, or the same file): skipped.
    pub have: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InboxPlan {
    /// The show / movie / album folder it goes to.
    pub folder: String,
    /// It goes into a show or movie you already have.
    pub existing: bool,
    pub moves: Vec<Placement>,
}

/// "Season 01" in the style the show already uses ("Season 1", "S01", "Season 01").
pub fn season_dir_like(existing: &[String], season: u32) -> String {
    let plain = |d: &String| crate::naming::is_plain_season_dir(d);
    if let Some(d) = existing.iter().find(|d| plain(d) && season_from_dir(d) == Some(season)) {
        return d.clone();
    }
    if let Some(d) = existing.iter().find(|d| season_from_dir(d) == Some(season)) {
        return d.clone(); // a downloaded season folder already there ("You.S05.1080p…")
    }
    if season == 0 {
        return existing.iter().find(|d| d.eq_ignore_ascii_case("specials")).cloned().unwrap_or_else(|| "Specials".into());
    }
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"^(\D*?)(\d+)(\D*)$").expect("season style"));
    for d in existing.iter().filter(|d| plain(d) && season_from_dir(d).map(|n| n > 0).unwrap_or(false)) {
        if let Some(c) = re.captures(d) {
            let width = c[2].len();
            return format!("{}{:0width$}{}", &c[1], season, &c[3], width = width);
        }
    }
    format!("Season {season:02}")
}

fn sub_dirs(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// The episodes a folder already has: (season, episode) from the video names in it.
fn episodes_in(dir: &Path, season_hint: Option<u32>) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !is_video(&n) {
            continue;
        }
        if let Some(m) = parse_episode(split_ext(&n).0, season_hint) {
            out.extend(m.episodes.iter().map(|ep| (m.season, *ep)));
        }
    }
    out
}

fn join(a: &str, b: &str) -> String {
    if a.is_empty() { b.to_string() } else { format!("{a}/{b}") }
}

/// Language of a subtitle file from its name ("Movie.en.srt", "Subs/2_English.srt"): the code
/// it gets in the new name ("eng"), plus ".forced"/".sdh". None = not one of your languages.
/// Ok(None) inside = no language in the name at all.
pub fn sub_language(rel: &str, langs: &[String]) -> Option<(Option<String>, String)> {
    let lower = rel.to_lowercase();
    let stem = split_ext(rel.rsplit('/').next().unwrap_or(rel)).0.to_lowercase();
    let tokens: Vec<&str> = lower.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let stem_tokens: Vec<&str> = stem.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    let mut flags = String::new();
    if stem_tokens.iter().any(|t| *t == "forced") {
        flags.push_str(".forced");
    }
    if stem_tokens.iter().any(|t| matches!(*t, "sdh" | "hi" | "cc")) {
        flags.push_str(".sdh");
    }
    let mut wanted: Vec<String> = langs.to_vec();
    if !wanted.iter().any(|l| l == "eng") {
        wanted.push("eng".into());
    }
    for l in &wanted {
        let codes = crate::sublock::name_codes(l);
        if stem_tokens.iter().any(|t| codes.iter().any(|c| c == t)) || (tokens.iter().any(|t| codes.iter().any(|c| c.len() > 3 && c == t))) {
            return Some((Some(l.clone()), flags));
        }
    }
    // Some other language named in it: not wanted.
    const OTHER: &[&str] = &["fre", "fra", "french", "ger", "deu", "german", "spa", "spanish", "ita", "italian", "por", "portuguese", "rus", "russian", "ara", "arabic", "chi", "chinese", "jpn", "japanese", "kor", "korean", "pol", "polish", "tur", "turkish", "swe", "swedish", "nor", "norwegian", "dan", "danish", "fin", "finnish", "dut", "nld", "dutch", "heb", "hebrew", "hun", "hungarian", "cze", "czech", "gre", "greek", "rum", "romanian", "vie", "vietnamese", "tha", "thai", "ind", "indonesian", "may", "malay", "hin", "hindi", "ukr", "ukrainian", "bul", "bulgarian", "hrv", "croatian", "srp", "serbian", "slv", "slovenian", "est", "lav", "lit"];
    if stem_tokens.iter().any(|t| OTHER.contains(t)) || tokens.iter().any(|t| t.len() > 3 && OTHER.contains(t)) {
        return None;
    }
    Some((None, flags))
}

fn is_sample(rel: &str) -> bool {
    let l = rel.to_lowercase();
    l.split(|c: char| !c.is_alphanumeric()).any(|t| t == "sample" || t == "trailer" || t == "featurette")
}

/// Works out every file's place and its clean name (pure apart from reading the target folders).
/// Only the videos (no samples) and subtitles in your languages go; .nfo, .txt, pictures,
/// samples and other languages stay behind (and go to the Trash with the download).
pub fn plan_moves(root: &Path, item: &InboxItem, t: &Target, folder: &str, existing: bool, langs: &[String]) -> Vec<Placement> {
    let mut moves = Vec::new();
    let name_of = |rel: &str| rel.rsplit('/').next().unwrap_or(rel).to_string();
    let videos: Vec<&InboxFile> = item.files.iter().filter(|f| f.video && (!is_sample(&f.rel) || item.files.iter().filter(|x| x.video).count() == 1)).collect();
    // Which video a subtitle belongs to: same name start, its episode number, a folder named
    // after the video ("Subs/<video>/2_English.srt"), or the only video.
    let video_of = |f: &InboxFile| -> Option<&InboxFile> {
        let n = name_of(&f.rel);
        if let Some(v) = videos.iter().copied().filter(|v| n.starts_with(split_ext(&name_of(&v.rel)).0)).max_by_key(|v| v.rel.len()) {
            return Some(v);
        }
        let parent = f.rel.rsplit('/').nth(1).unwrap_or("");
        if let Some(v) = videos.iter().copied().find(|v| !parent.is_empty() && split_ext(&name_of(&v.rel)).0 == parent) {
            return Some(v);
        }
        if let Some(m) = parse_episode(split_ext(&n).0, None) {
            if let Some(v) = videos.iter().copied().find(|v| v.season == Some(m.season) && v.episodes == m.episodes) {
                return Some(v);
            }
        }
        (videos.len() == 1).then(|| videos[0])
    };
    let title_plain = {
        let p = crate::naming::parse_name(&t.title);
        if p.title.is_empty() { t.title.trim().to_string() } else { p.title }
    };
    // The clean name of a video (without extension): "Heat (1995)", "Bluey - S03E48".
    let clean_stem = |v: &InboxFile| -> Option<String> {
        match t.kind.as_str() {
            "movie" if videos.len() == 1 => Some(sanitize(&match t.year { Some(y) => format!("{title_plain} ({y})"), None => title_plain.clone() })),
            "tv" => {
                let s = v.season.or(t.season)?;
                if v.episodes.is_empty() {
                    return None;
                }
                let mut sxe = format!("S{:02}E{:02}", s, v.episodes[0]);
                for e in &v.episodes[1..] {
                    sxe.push_str(&format!("-E{e:02}"));
                }
                Some(sanitize(&format!("{title_plain} - {sxe}")))
            }
            _ => None,
        }
    };
    let new_name = |f: &InboxFile| -> Option<String> {
        let n = name_of(&f.rel);
        let ext = split_ext(&n).1.to_lowercase();
        if f.video {
            return Some(match clean_stem(f) { Some(stem) => format!("{stem}.{ext}"), None => n });
        }
        if !matches!(ext.as_str(), "srt" | "ass" | "ssa" | "vtt" | "sub" | "idx" | "sup") {
            return None; // .nfo, .txt, .jpg …: stay behind
        }
        let (lang, flags) = sub_language(&f.rel, langs)?;
        let v = video_of(f)?;
        let stem = clean_stem(v).unwrap_or_else(|| split_ext(&name_of(&v.rel)).0.to_string());
        Some(match lang { Some(l) => format!("{stem}.{l}{flags}.{ext}"), None => format!("{stem}{flags}.{ext}") })
    };
    let mut used: HashSet<String> = HashSet::new();
    match t.kind.as_str() {
        "tv" => {
            let show = root.join(folder);
            let dirs = sub_dirs(&show);
            let uses_seasons = !existing || dirs.iter().any(|d| season_from_dir(d).is_some());
            let place = |f: &InboxFile| -> (String, Option<(u32, Vec<u32>)>) {
                let season = f.season.or(t.season);
                match season {
                    Some(s) if uses_seasons => (join(folder, &season_dir_like(&dirs, s)), Some((s, f.episodes.clone()))),
                    Some(s) => (folder.to_string(), Some((s, f.episodes.clone()))),
                    None => (folder.to_string(), None),
                }
            };
            let mut have_cache: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
            for f in &item.files {
                let base = if f.video { videos.iter().copied().find(|v| v.rel == f.rel) } else { video_of(f) };
                let Some(v) = base else { continue };
                let Some(name) = new_name(f) else { continue };
                let (dir, ep) = place(v);
                let to = join(&dir, &name);
                if !used.insert(to.to_lowercase()) {
                    continue; // a second English subtitle for the same episode
                }
                let have_ep = match (&ep, f.video) {
                    (Some((s, eps)), true) if !eps.is_empty() => {
                        let known = have_cache.entry(dir.clone()).or_insert_with(|| episodes_in(&root.join(&dir), season_from_dir(dir.rsplit('/').next().unwrap_or(""))));
                        eps.iter().all(|e| known.contains(&(*s, *e)))
                    }
                    _ => false,
                };
                moves.push(Placement { have: have_ep || root.join(&to).exists(), from: f.rel.clone(), to });
            }
            // A subtitle whose video is already there is skipped too.
            let skipped: Vec<String> = moves.iter().filter(|m| m.have).map(|m| m.from.clone()).collect();
            for m in moves.iter_mut().filter(|m| !m.have) {
                if let Some(f) = item.files.iter().find(|f| f.rel == m.from && !f.video) {
                    if let Some(v) = video_of(f) {
                        if skipped.contains(&v.rel) {
                            m.have = true;
                        }
                    }
                }
            }
        }
        "music" => {
            for f in &item.files {
                // Keep "CD1/…" inside an album; the album folder itself is the target.
                let inner = if item.is_folder { f.rel.clone() } else { name_of(&f.rel) };
                let inner = match inner.split_once('/') { Some((first, rest)) if !first.to_lowercase().starts_with("cd") && !first.to_lowercase().starts_with("disc") => rest.to_string(), _ => inner };
                let to = join(folder, &inner);
                moves.push(Placement { have: root.join(&to).exists(), from: f.rel.clone(), to });
            }
        }
        "other" => {
            for f in &item.files {
                if !f.video && !is_sidecar(&name_of(&f.rel)) {
                    continue;
                }
                let to = join(folder, &name_of(&f.rel));
                moves.push(Placement { have: existing || root.join(&to).exists(), from: f.rel.clone(), to });
            }
        }
        _ => {
            for f in &item.files {
                if f.video && !videos.iter().any(|v| v.rel == f.rel) {
                    continue; // sample
                }
                let Some(name) = new_name(f) else { continue };
                let to = join(folder, &name);
                if !used.insert(to.to_lowercase()) {
                    continue;
                }
                moves.push(Placement { have: (existing && f.video) || root.join(&to).exists(), from: f.rel.clone(), to });
            }
        }
    }
    moves
}

#[tauri::command]
pub async fn inbox_resolve(state: State<'_, AppState>, key: String, target: Target) -> Result<InboxPlan> {
    let root = state.library_root()?;
    let path = item_path(&state, &key)?;
    let modified = 0;
    let p2 = path.clone();
    let k2 = key.clone();
    let item = tauri::async_runtime::spawn_blocking(move || read_item(&p2, &k2, modified))
        .await
        .map_err(|e| Error::msg(e.to_string()))?
        .ok_or_else(|| Error::msg("No videos or music found in that download."))?;
    // Where: a show or movie you have, or a new folder in the main folder you chose.
    let (folder, existing) = match target.item_id.as_deref().filter(|i| valid_item_id(i)) {
        Some(id) => {
            let it = state.reader().await?.item_json(id).await?;
            let server = it.get("Path").and_then(Value::as_str).ok_or_else(|| Error::msg("Jellyfin has no folder for that title."))?;
            let local_p = local::to_local(&state, server)?;
            let dir = if local_p.is_dir() { local_p } else { local_p.parent().map(Path::to_path_buf).unwrap_or(local_p) };
            (local::rel_to_root(&root, &dir).ok_or_else(|| Error::msg("That title is outside your library folder."))?, true)
        }
        None => {
            safe_rel(&target.top)?;
            let name = match target.kind.as_str() {
                "music" => {
                    let artist = sanitize(&main_artist(target.artist.as_deref().unwrap_or("Unknown artist")));
                    let album = target.album.clone().unwrap_or_else(|| target.title.clone());
                    let album = sanitize(&match target.year { Some(y) if !album.contains(&y.to_string()) => format!("{album} ({y})"), _ => album });
                    format!("{artist}/{album}")
                }
                _ => {
                    let t = target.title.trim();
                    if t.is_empty() {
                        return Err(Error::msg("Give it a name first."));
                    }
                    sanitize(&match target.year { Some(y) if target.kind != "other" => format!("{t} ({y})"), _ => t.to_string() })
                }
            };
            (join(&target.top, &name), false)
        }
    };
    let (r2, f2, t2) = (root.clone(), folder.clone(), target.clone());
    let langs = state.settings()?.sub_langs.clone();
    let moves = tauri::async_runtime::spawn_blocking(move || plan_moves(&r2, &item, &t2, &f2, existing, &langs))
        .await
        .map_err(|e| Error::msg(e.to_string()))?;
    Ok(InboxPlan { folder, existing, moves })
}

/* ------------------------------------------------------------------ putting it in place */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    key: String,
    done: u64,
    total: u64,
    file: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceResult {
    placed: Vec<String>,
    skipped: usize,
    failed: Vec<String>,
    /// The download went to the Trash (everything arrived, or was already there).
    trashed: bool,
}

fn copy_checked(app: &AppHandle, key: &str, from: &Path, to: &Path, done: &mut u64, total: u64, label: &str) -> Result<()> {
    let mut src = std::fs::File::open(from)?;
    let size = src.metadata()?.len();
    let tmp = to.with_extension(format!("{}.mediahub-part", to.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut last = std::time::Instant::now();
    loop {
        if crate::cancel::stopped("inbox") {
            drop(dst);
            let _ = std::fs::remove_file(&tmp); // our own partial file only
            return Err(Error::Stopped);
        }
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        *done += n as u64;
        if last.elapsed().as_millis() > 300 {
            last = std::time::Instant::now();
            let _ = app.emit("inbox-progress", Progress { key: key.into(), done: *done, total, file: label.into() });
        }
    }
    dst.flush()?;
    dst.sync_all().ok();
    drop(dst);
    // Checked: the copy has every byte before it counts.
    if std::fs::metadata(&tmp)?.len() != size {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::msg("The copy came out a different size; nothing was changed."));
    }
    if to.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err(Error::msg("already exists"));
    }
    std::fs::rename(&tmp, to)?;
    Ok(())
}

/// Puts a download's files in the library as planned, checks them, and then moves the
/// download to the system Trash. Files that are already there are skipped.
#[tauri::command]
pub async fn inbox_place(app: AppHandle, state: State<'_, AppState>, key: String, moves: Vec<Placement>) -> Result<PlaceResult> {
    let root = state.library_root()?;
    let item = item_path(&state, &key)?;
    let base = if item.is_dir() { item.clone() } else { item.parent().map(Path::to_path_buf).ok_or_else(|| Error::msg("bad item"))? };
    let canon_base = base.canonicalize()?;
    let canon_root = root.canonicalize()?;
    for m in &moves {
        safe_rel(&m.to)?;
        safe_rel(&m.from)?;
    }
    crate::cancel::begin("inbox");
    let (app2, key2) = (app.clone(), key.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<PlaceResult> {
        let todo: Vec<&Placement> = moves.iter().filter(|m| !m.have).collect();
        let total: u64 = todo.iter().map(|m| std::fs::metadata(base.join(&m.from)).map(|x| x.len()).unwrap_or(0)).sum::<u64>().max(1);
        let mut done = 0u64;
        let mut res = PlaceResult { placed: Vec::new(), skipped: moves.len() - todo.len(), failed: Vec::new(), trashed: false };
        for m in todo {
            if crate::cancel::stopped("inbox") {
                res.failed.push("Stopped: the rest was left in the downloads folder".into());
                break;
            }
            let from = base.join(&m.from);
            let to = root.join(&m.to);
            // Only files from this download, only into the library.
            let ok_from = from.canonicalize().map(|c| c.starts_with(&canon_base)).unwrap_or(false);
            if !ok_from || !from.is_file() {
                res.failed.push(format!("{}: not found in the download", m.from));
                continue;
            }
            if let Some(parent) = to.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    res.failed.push(format!("{}: {e}", m.to));
                    continue;
                }
                if !parent.canonicalize().map(|c| c.starts_with(&canon_root)).unwrap_or(false) {
                    res.failed.push(format!("{}: outside the library folder", m.to));
                    continue;
                }
            }
            if to.exists() {
                res.skipped += 1;
                continue;
            }
            let size = std::fs::metadata(&from).map(|x| x.len()).unwrap_or(0);
            let _ = app2.emit("inbox-progress", Progress { key: key2.clone(), done, total, file: m.to.clone() });
            // Same drive: a quick move. Another drive: a checked copy.
            let r = if std::fs::rename(&from, &to).is_ok() {
                done += size;
                Ok(())
            } else {
                copy_checked(&app2, &key2, &from, &to, &mut done, total, &m.to)
            };
            match r {
                Ok(()) => res.placed.push(m.to.clone()),
                Err(Error::Stopped) => {
                    res.failed.push("Stopped: the rest was left in the downloads folder".into());
                    break;
                }
                Err(e) => res.failed.push(format!("{}: {e}", m.to)),
            }
        }
        let _ = app2.emit("inbox-progress", Progress { key: key2.clone(), done: total, total, file: String::new() });
        // Everything arrived (or was there already): the download goes to the Trash.
        if res.failed.is_empty() && item.exists() {
            res.trashed = trash::delete(&item).is_ok();
            // A single video's subtitles next to it (copied, not moved) go along.
            if !item.is_dir() {
                for m in &moves {
                    let f = base.join(&m.from);
                    if f.is_file() && f != item {
                        let _ = trash::delete(&f);
                    }
                }
            }
        }
        Ok(res)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?
}

/// Opens the downloads folder in Finder / Explorer.
#[tauri::command]
pub fn inbox_reveal(state: State<'_, AppState>) -> Result<()> {
    let dir = inbox_dir(&state)?;
    local::show_in_file_manager(&dir);
    Ok(())
}

/// "Remove download": a download you don't need (already in the library) goes to the Trash.
#[tauri::command]
pub async fn inbox_trash(state: State<'_, AppState>, key: String) -> Result<()> {
    let item = item_path(&state, &key)?;
    trash::delete(&item).map_err(|e| Error::msg(format!("It couldn't be moved to the Trash ({e}).")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn show_titles_and_artists() {
        assert_eq!(show_title_of("Severance.S02E04.1080p.WEB.h264").0, "Severance");
        let (t, y) = show_title_of("The.Bear.2022.S03E01.720p");
        assert_eq!((t.as_str(), y), ("The Bear", Some(2022)));
        assert_eq!(show_title_of("Bluey.Season.3.Complete").0, "Bluey");
        assert_eq!(main_artist("Drake feat. Rihanna"), "Drake");
        assert_eq!(main_artist("Calvin Harris ft. Dua Lipa"), "Calvin Harris");
        assert_eq!(main_artist("Simon & Garfunkel"), "Simon & Garfunkel");
        assert_eq!(main_artist("Earth, Wind & Fire"), "Earth, Wind & Fire");
        assert_eq!(main_artist("Lil Nas X"), "Lil Nas X");
        assert_eq!(main_artist("Daft Punk (feat. Pharrell)"), "Daft Punk");
    }

    #[test]
    fn season_folders_follow_the_show() {
        assert_eq!(season_dir_like(&["Season 1".into(), "Season 2".into()], 3), "Season 3");
        assert_eq!(season_dir_like(&["Season 01".into()], 3), "Season 03");
        assert_eq!(season_dir_like(&["S01".into()], 2), "S02");
        assert_eq!(season_dir_like(&["Season 02".into()], 2), "Season 02");
        assert_eq!(season_dir_like(&[], 4), "Season 04");
    }

    #[test]
    fn plans_episodes_into_the_show_and_skips_what_is_there() {
        let root = std::env::temp_dir().join(format!("mh-inbox-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Kids/Bluey (2018)/Season 3")).unwrap();
        std::fs::write(root.join("Kids/Bluey (2018)/Season 3/Bluey (2018) - S03E47 - Ghost Basket.mkv"), b"x").unwrap();
        let f = |rel: &str, s: Option<u32>, e: &[u32]| InboxFile { rel: rel.into(), size: 1, video: is_video(rel), season: s, episodes: e.to_vec() };
        let item = InboxItem {
            key: "Bluey.S03".into(), is_folder: true, size: 3, modified: 0, kind: "tv", title: "Bluey".into(), year: None, music: None,
            files: vec![f("Bluey.S03E47.mkv", Some(3), &[47]), f("Bluey.S03E48.mkv", Some(3), &[48]), f("Bluey.S03E48.en.srt", None, &[]), f("Bluey.S03E47.en.srt", None, &[])],
        };
        let t = Target { kind: "tv".into(), item_id: None, top: "Kids".into(), title: "Bluey".into(), year: Some(2018), season: None, artist: None, album: None };
        let moves = plan_moves(&root, &item, &t, "Kids/Bluey (2018)", true, &["eng".to_string()]);
        let get = |from: &str| moves.iter().find(|m| m.from == from).unwrap();
        assert!(get("Bluey.S03E47.mkv").have, "episode 47 is already there");
        assert!(get("Bluey.S03E47.en.srt").have, "its subtitle is skipped too");
        assert_eq!(get("Bluey.S03E48.mkv").to, "Kids/Bluey (2018)/Season 3/Bluey - S03E48.mkv");
        assert!(!get("Bluey.S03E48.mkv").have);
        assert_eq!(get("Bluey.S03E48.en.srt").to, "Kids/Bluey (2018)/Season 3/Bluey - S03E48.eng.srt");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn episodes_without_a_season_go_in_the_show_folder() {
        let root = std::env::temp_dir().join(format!("mh-inbox2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("YouTube/Kurzgesagt")).unwrap();
        let item = InboxItem {
            key: "video.mp4".into(), is_folder: false, size: 1, modified: 0, kind: "tv", title: "Kurzgesagt".into(), year: None, music: None,
            files: vec![InboxFile { rel: "Why Bees Dance.mp4".into(), size: 1, video: true, season: None, episodes: vec![] }],
        };
        let t = Target { kind: "tv".into(), item_id: None, top: "YouTube".into(), title: "Kurzgesagt".into(), year: None, season: None, artist: None, album: None };
        let moves = plan_moves(&root, &item, &t, "YouTube/Kurzgesagt", true, &[]);
        assert_eq!(moves[0].to, "YouTube/Kurzgesagt/Why Bees Dance.mp4");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_movie_brings_only_the_video_and_your_subtitles_with_clean_names() {
        let root = std::env::temp_dir().join(format!("mh-inbox3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let f = |rel: &str| InboxFile { rel: rel.into(), size: 1, video: is_video(rel), season: None, episodes: vec![] };
        let item = InboxItem {
            key: "Heat.1995.1080p.BluRay.x264-GRP".into(), is_folder: true, size: 9, modified: 0, kind: "movie", title: "Heat".into(), year: Some(1995), music: None,
            files: vec![f("Heat.1995.1080p.BluRay.x264-GRP.mkv"), f("Sample/heat-sample.mkv"), f("Heat.1995.nfo"), f("Subs/2_English.srt"), f("Subs/3_French.srt"), f("Subs/4_English.SDH.srt"), f("RARBG.txt")],
        };
        let t = Target { kind: "movie".into(), item_id: None, top: "Movies".into(), title: "Heat".into(), year: Some(1995), season: None, artist: None, album: None };
        let moves = plan_moves(&root, &item, &t, "Movies/Heat (1995)", false, &["eng".to_string()]);
        let to: Vec<&str> = moves.iter().map(|m| m.to.as_str()).collect();
        assert_eq!(to, vec!["Movies/Heat (1995)/Heat (1995).mkv", "Movies/Heat (1995)/Heat (1995).eng.srt", "Movies/Heat (1995)/Heat (1995).eng.sdh.srt"], "{moves:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
