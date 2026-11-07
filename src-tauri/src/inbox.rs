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
    R.get_or_init(|| Regex::new(r"(?i)(?:^|[ ._\-\[(])(?:s\d{1,3}[ ._-]?e\d{1,4}|\d{1,2}x\d{2,3}|season[ ._-]?\d+|s\d{1,3}(?:[ ._\-\])]|$)|complete)").expect("marker pattern"))
}

/// A download named for one season ("Reacher S01", "Reacher.Season.2.1080p"): its number.
/// Not an episode ("S01E03") and not several seasons ("S01-S03").
fn pack_season(name: &str) -> Option<u32> {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?i)(?:^|[ ._(\[-])(?:season[ ._-]*(\d{1,2})|s(\d{1,2}))(?:$|[ ._)\]-])").expect("pack season"));
    if parse_episode(name, None).is_some() {
        return None;
    }
    static RANGE: OnceLock<Regex> = OnceLock::new();
    if RANGE.get_or_init(|| Regex::new(r"(?i)s\d{1,2}[ ._]*-[ ._]*s?\d{1,2}(?:$|[^0-9])").expect("range")).is_match(name) {
        return None;
    }
    let mut found = None;
    for c in re.captures_iter(name) {
        let n: u32 = c.get(1).or(c.get(2))?.as_str().parse().ok()?;
        if found.is_some_and(|f| f != n) {
            return None;
        }
        found = Some(n);
    }
    found
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

/// The first artist of a credit: "Drake & 21 Savage" → "Drake", "Pete Rock & C.L. Smooth" →
/// "Pete Rock", "Drake feat. Rihanna" → "Drake". (Whether to use it is decided by who else is in
/// the library: see `artist_groups`.)
pub fn first_artist(a: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| Regex::new(r"(?i)\s+(?:&|and|x|with|vs\.?|\+)\s+|\s*,\s+").expect("artist separators"));
    let m = main_artist(a);
    let first = re.split(&m).next().unwrap_or(&m).trim().to_string();
    if first.is_empty() { m } else { first }
}

/// A name as artists compare: no case, accents, dots or spaces ("C.L. Smooth" = "CL Smooth").
pub fn artist_key(a: &str) -> String {
    crate::naming::fold_accents(&a.to_lowercase()).chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Which artist each name belongs under: its first artist when that artist is in the library
/// too, or when two or more names start with the same artist. "Mumford & Sons" on its own
/// stays as it is.
pub fn artist_groups(names: &[String]) -> HashMap<String, String> {
    let keys: HashMap<String, &String> = names.iter().map(|n| (artist_key(n), n)).collect();
    let mut firsts: HashMap<String, usize> = HashMap::new();
    for n in names {
        let f = first_artist(n);
        if artist_key(&f) != artist_key(n) {
            *firsts.entry(artist_key(&f)).or_default() += 1;
        }
    }
    let mut out = HashMap::new();
    for n in names {
        let f = first_artist(n);
        let fk = artist_key(&f);
        if fk.is_empty() || fk == artist_key(n) {
            continue;
        }
        if let Some(main) = keys.get(&fk) {
            out.insert(n.clone(), (*main).clone());
        } else if firsts.get(&fk).copied().unwrap_or(0) >= 2 || main_artist(n) != *n {
            out.insert(n.clone(), f);
        }
    }
    out
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
            // A season folder in the download ("Season 2/03.mkv", "Reacher.S01.1080p/03.mkv"), or
            // the download's own name for files right inside it ("Reacher S01" → season 1).
            let hint = match rel.rsplit('/').nth(1) {
                Some(dir) => season_from_dir(dir),
                None if is_folder => season_from_dir(key).or_else(|| pack_season(key)),
                None => None,
            };
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
    // Several different movies in one download (a collection pack).
    if kind == "movie" && is_folder {
        let mut seen: Vec<(String, Option<i32>)> = Vec::new();
        let mains: Vec<&InboxFile> = files.iter().filter(|f| f.video && !is_sample(&f.rel) && !is_part(&f.rel)).collect();
        for f in &mains {
            let (title, year) = movie_of(&f.rel);
            let k = (folder_key(&title).0, year);
            if !k.0.is_empty() && !seen.contains(&k) {
                seen.push(k);
            }
        }
        // Different movies inside, or a download called a collection with several movies in it.
        if seen.len() >= 2 || (mains.len() >= 2 && pack_word(&stem)) {
            let name = collection_name(&stem);
            return Some(InboxItem { key: key.into(), is_folder, size, modified, kind: "pack", title: if name.is_empty() { stem.clone() } else { name }, year: None, files, music: None });
        }
    }
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
    /// A movie's TMDB id (to find the collection it belongs to).
    #[serde(default)]
    pub tmdb: Option<String>,
    /// A collection pack: each movie file → (its folder, already in your library).
    #[serde(skip)]
    pub pack: HashMap<String, (String, bool)>,
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
    /// Files that stay behind and go to the Trash with the download (samples, .nfo, .txt,
    /// pictures, subtitles in other languages).
    pub leftovers: Vec<String>,
    /// Why it goes where it goes, in plain words.
    pub note: String,
    /// A movie that's part of a collection you already have.
    pub collection: Option<CollectionHit>,
    /// A collection pack: every movie's folder, title and whether it's new (to find them in
    /// Jellyfin after placing and put them in the collection).
    pub movies: Vec<(String, String, bool)>,
}

/// The collection a new movie belongs with.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CollectionHit {
    pub name: String,
    /// The collection in Jellyfin (the movie is added to it after placing).
    pub id: Option<String>,
    /// Your folder for it on disk ("Movies/Alien Collection"): the movie goes inside.
    pub folder: Option<String>,
}

/// A collection's name without the extra words: "Indiana Jones Collection 1-5 (1981) 1080p" →
/// "Indiana Jones", "The Hunger Games 4 Film Complete Collection" → "The Hunger Games".
pub fn collection_base(name: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let re = R.get_or_init(|| {
        Regex::new(r"(?i)\b(?:complete|full|ultimate|definitive|\d+\s*(?:film|movie)s?|\d+\s*-\s*\d+|collection|saga|trilogy|quadrilogy|pentalogy|anthology|box\s*set|boxset|pack|series)\b").expect("collection words")
    });
    let p = parse_name(name);
    let base = if p.title.is_empty() { name.to_string() } else { p.title };
    let cut = re.replace_all(&base, " ");
    let t = cut.split_whitespace().collect::<Vec<_>>().join(" ");
    t.trim_matches(|c: char| c == '-' || c == ' ' || c == '&' || c == ',').to_string()
}

/// The clean name for a collection folder: "Indiana Jones Collection".
pub fn collection_name(name: &str) -> String {
    let b = collection_base(name);
    if b.is_empty() { String::new() } else { format!("{b} Collection") }
}

/// What a collection is called without the extra words, for comparing: "The Alien Collection" → "alien".
pub fn collection_key(name: &str) -> String {
    let k = artist_key(&collection_base(name));
    k.strip_prefix("the").filter(|x| x.len() >= 3).map(str::to_string).unwrap_or(k)
}

/// The series part of a movie title: "Dune: Part Two" → "dune", "Toy Story 4" → "toystory",
/// "Alien: Romulus" → "alien", "The Matrix Reloaded" stays "matrixreloaded".
pub fn series_key(title: &str) -> String {
    static NUM: OnceLock<Regex> = OnceLock::new();
    let num = NUM.get_or_init(|| Regex::new(r"(?i)\s+(?:part\s+\w+|chapter\s+\w+|\d{1,2}|[ivx]{1,4})$").expect("sequel number"));
    let base = title.split([':', '–']).next().unwrap_or(title);
    let base = base.split(" - ").next().unwrap_or(base).trim();
    let base = num.replace(base, "");
    let k = artist_key(&base);
    k.strip_prefix("the").filter(|x| x.len() >= 3).map(str::to_string).unwrap_or(k)
}

/// A collection folder you keep on disk for this movie: by the collection's name when TMDB
/// knows it, otherwise by the movie's series name. Only a clear single match counts.
pub fn find_collection_folder(root: &Path, top: &str, collection: Option<&str>, title: &str) -> Option<String> {
    let want = collection.map(collection_key).unwrap_or_else(|| series_key(title));
    if want.len() < 3 {
        return None;
    }
    let mut tops: Vec<String> = vec![top.to_string()];
    tops.extend(sub_dirs(root).into_iter().filter(|d| d != top && !d.starts_with('.')));
    for t in tops {
        let hits: Vec<String> = sub_dirs(&root.join(&t))
            .into_iter()
            .filter(|d| {
                let l = d.to_lowercase();
                // A collection folder: called so, or holding two or more movie folders.
                let looks = ["collection", "saga", "trilogy", "box set"].iter().any(|w| l.contains(w))
                    || sub_dirs(&root.join(&t).join(d)).iter().filter(|m| parse_name(m).year.is_some()).count() >= 2;
                looks && collection_key(d) == want
            })
            .collect();
        if hits.len() == 1 {
            return Some(join(&t, &hits[0]));
        }
    }
    None
}

/// "Season 01" in the style the show already uses ("Season 1", "S01", "Season 01").
pub fn season_dir_like(existing: &[String], season: u32) -> String {
    // A folder the show already has for this season is used (Clean-up → Names and years makes
    // it "Season 07"); a new one is always "Season 07".
    let plain = |d: &String| crate::naming::is_plain_season_dir(d);
    if let Some(d) = existing.iter().find(|d| plain(d) && season_from_dir(d) == Some(season)) {
        return d.clone();
    }
    if let Some(d) = existing.iter().find(|d| season_from_dir(d) == Some(season)) {
        return d.clone();
    }
    if season == 0 {
        return "Specials".into();
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
    l.split(|c: char| !c.is_alphanumeric()).any(|t| matches!(t, "sample" | "trailer" | "trailers" | "featurette" | "featurettes" | "extras" | "bonus" | "deleted" | "interview" | "interviews"))
}

/// "Episode 5", "Aflevering 3", "TBA": not a real episode title.
fn generic_title(t: &str) -> bool {
    let l = t.trim().to_lowercase();
    l.is_empty() || l == "tba" || l == "tbd" || l.split_whitespace().count() <= 2 && l.split_whitespace().last().map(|w| w.chars().all(|c| c.is_ascii_digit())).unwrap_or(false)
}

/// A title as a folder name compares: no year, no tags, no punctuation, no accents.
fn folder_key(name: &str) -> (String, Option<i32>) {
    let p = parse_name(name);
    let title = if p.title.is_empty() { name.to_string() } else { p.title };
    let key: String = crate::naming::fold_accents(&title.to_lowercase()).chars().filter(|c| c.is_alphanumeric()).collect();
    let key = key.strip_prefix("the").filter(|k| k.len() > 2).map(str::to_string).unwrap_or(key);
    (key, p.year)
}

/// A folder you already have for this title (in the chosen main folder first, then any main
/// folder), so a download never makes a second "Severance" next to "Severance (2022)".
/// Years only have to match when both have one.
pub fn find_title_folder(root: &Path, top: &str, title: &str, year: Option<i32>) -> Option<String> {
    let (want, _) = folder_key(title);
    if want.is_empty() {
        return None;
    }
    let mut tops: Vec<String> = vec![top.to_string()];
    tops.extend(sub_dirs(root).into_iter().filter(|d| d != top && !d.starts_with('.')));
    for t in tops {
        let hits: Vec<String> = sub_dirs(&root.join(&t))
            .into_iter()
            .filter(|d| {
                let (k, y) = folder_key(d);
                k == want && (year.is_none() || y.is_none() || y == year)
            })
            .collect();
        if hits.len() == 1 {
            return Some(join(&t, &hits[0]));
        }
    }
    None
}

/// What stays behind in the download (and goes to the Trash with it): every file not placed.
pub fn leftovers(item: &InboxItem, moves: &[Placement]) -> Vec<String> {
    item.files.iter().filter(|f| !moves.iter().any(|m| m.from == f.rel)).map(|f| f.rel.clone()).collect()
}

/// Works out every file's place and its clean name (pure apart from reading the target folders).
/// Only the videos (no samples) and subtitles in your languages go; .nfo, .txt, pictures,
/// samples and other languages stay behind (and go to the Trash with the download).
pub fn plan_moves(root: &Path, item: &InboxItem, t: &Target, folder: &str, existing: bool, langs: &[String], titles: &HashMap<(u32, u32), String>) -> Vec<Placement> {
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
        // Deeper in the download ("Police Academy 2 (1985)/Subs/English.srt"): the one video in
        // the nearest folder above it.
        let dir_of = |rel: &str| rel.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
        let mut dir = dir_of(&f.rel);
        loop {
            let here: Vec<&InboxFile> = videos.iter().copied().filter(|v| { let d = dir_of(&v.rel); d == dir || (!dir.is_empty() && d.starts_with(&format!("{dir}/"))) }).collect();
            if here.len() == 1 {
                return Some(here[0]);
            }
            if !here.is_empty() || dir.is_empty() {
                break;
            }
            dir = dir_of(&dir);
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
                // The episode's own title when the online list has it ("Show - S02E05 - Title").
                let named: Vec<&String> = v.episodes.iter().filter_map(|e| titles.get(&(s, *e))).filter(|n| !generic_title(n)).collect();
                if !named.is_empty() && named.len() == v.episodes.len() {
                    let joined = named.iter().map(|n| n.as_str()).collect::<Vec<_>>().join(" + ");
                    let full = sanitize(&format!("{title_plain} - {sxe} - {joined}"));
                    if full.chars().count() <= 180 {
                        return Some(full);
                    }
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
        "pack" => {
            // Each movie into its own folder (worked out in `inbox_resolve`), named after it.
            for f in &item.files {
                let base = if f.video { videos.iter().copied().find(|v| v.rel == f.rel) } else { video_of(f) };
                let Some(v) = base else { continue };
                let Some((dir, have)) = t.pack.get(&v.rel) else { continue };
                let leaf = dir.rsplit('/').next().unwrap_or(dir);
                let n = name_of(&f.rel);
                let ext = split_ext(&n).1.to_lowercase();
                let name = if f.video {
                    format!("{leaf}.{ext}")
                } else {
                    if !matches!(ext.as_str(), "srt" | "ass" | "ssa" | "vtt" | "sub" | "idx" | "sup") {
                        continue;
                    }
                    let Some((lang, flags)) = sub_language(&f.rel, langs) else { continue };
                    match lang { Some(l) => format!("{leaf}.{l}{flags}.{ext}"), None => format!("{leaf}{flags}.{ext}") }
                };
                let to = join(dir, &name);
                if !used.insert(to.to_lowercase()) {
                    continue;
                }
                moves.push(Placement { have: *have || root.join(&to).exists(), from: f.rel.clone(), to });
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

/// The collection a movie belongs with: your folder for it on disk and/or the Jellyfin collection.
/// TMDB's collection name when a TMDB key is set up, otherwise the series name.
async fn collection_for(state: &AppState, root: &Path, top: &str, title: &str, tmdb: Option<&str>) -> Option<CollectionHit> {
    let tmdb_name = match (tmdb.filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())), crate::rename_cmds::tmdb_client(state)) {
        (Some(id), Some(t)) => t.movie_collection(id).await.ok().flatten(),
        _ => None,
    };
    let want = tmdb_name.as_deref().map(collection_key).unwrap_or_else(|| series_key(title));
    let (r, top2, title2, tn) = (root.to_path_buf(), top.to_string(), title.to_string(), tmdb_name.clone());
    let disk = tauri::async_runtime::spawn_blocking(move || find_collection_folder(&r, &top2, tn.as_deref(), &title2)).await.ok().flatten();
    let jf: Option<(String, String)> = match state.reader().await {
        Ok(c) if want.len() >= 3 => {
            let hits: Vec<(String, String)> = c
                .items_query(vec![("IncludeItemTypes", "BoxSet".into()), ("Recursive", "true".into())], 2000)
                .await
                .unwrap_or_default()
                .iter()
                .filter_map(|v| Some((v.get("Id")?.as_str()?.replace('-', ""), v.get("Name")?.as_str()?.to_string())))
                .filter(|(_, n)| collection_key(n) == want)
                .collect();
            if hits.len() == 1 { hits.into_iter().next() } else { None }
        }
        _ => None,
    };
    if disk.is_none() && jf.is_none() {
        return None;
    }
    let name = jf.as_ref().map(|x| x.1.clone()).or(tmdb_name).or_else(|| disk.as_ref().map(|d| d.rsplit('/').next().unwrap_or(d).to_string())).unwrap_or_default();
    Some(CollectionHit { name, id: jf.map(|x| x.0), folder: disk })
}

/// A collection pack ("The Hunger Games 4 Film Complete Collection"): every movie on its own.
/// The ones you have stay out (their copies go to the Trash with the download); the new ones go
/// into your collection folder (or the main folder), each in its own "Title (Year)" folder.
async fn resolve_pack(state: &AppState, root: &Path, item: InboxItem, target: Target) -> Result<InboxPlan> {
    safe_rel(&target.top)?;
    let movies = pack_movies(&item);
    let r = root.to_path_buf();
    let index = tauri::async_runtime::spawn_blocking(move || movie_index(&r)).await.map_err(|e| Error::msg(e.to_string()))?;
    let first = movies.iter().map(|m| m.1.clone()).filter(|t| !t.is_empty()).min_by_key(|t| t.len()).unwrap_or_else(|| target.title.clone());
    // The collection you have (on disk or in Jellyfin); otherwise a new, cleanly named folder for it
    // ("Indiana Jones Collection"), and a new collection in Jellyfin after placing.
    let found = collection_for(state, root, &target.top, &first, None).await;
    let fresh_name = {
        let n = collection_name(&target.title);
        if n.is_empty() { collection_name(&first) } else { n }
    };
    let base = match found.as_ref().and_then(|c| c.folder.clone()) {
        Some(f) => f,
        None if !fresh_name.is_empty() => join(&target.top, &sanitize(&fresh_name)),
        None => target.top.clone(),
    };
    let collection = Some(match found {
        Some(c) => CollectionHit { folder: Some(base.clone()), ..c },
        None => CollectionHit { name: fresh_name.clone(), id: None, folder: Some(base.clone()) },
    });
    let reader = state.reader().await.ok();
    let mut t2 = target.clone();
    t2.kind = "pack".into();
    let mut new_movies: Vec<(String, String)> = Vec::new();
    let mut all_movies: Vec<(String, String, bool)> = Vec::new();
    let mut had = 0;
    for (rel, title, year) in &movies {
        let (key, _) = folder_key(title);
        let hit: Vec<&MovieEntry> = index.iter().filter(|e| !key.is_empty() && e.key == key && (year.is_none() || e.year.is_none() || e.year == *year)).collect();
        if hit.len() == 1 {
            had += 1;
            t2.pack.insert(rel.clone(), (hit[0].rel.clone(), true));
            all_movies.push((hit[0].rel.clone(), title.clone(), false));
            continue;
        }
        // The proper title ("The Hunger Games: Catching Fire") from Jellyfin's online search.
        let mut name = title.clone();
        if let Some(c) = &reader {
            if let Ok(found) = c.remote_search("movie", title, *year, &HashMap::new()).await {
                let pick = found.iter().find(|v| year.is_some() && v.get("ProductionYear").and_then(Value::as_i64) == year.map(i64::from)).or(found.first());
                if let Some(n) = pick.and_then(|v| v.get("Name")).and_then(Value::as_str).filter(|n| folder_key(n).0 == key || year.is_some()) {
                    name = n.to_string();
                }
            }
        }
        let leaf = sanitize(&match year { Some(y) => format!("{name} ({y})"), None => name.clone() });
        let dir = join(&base, &leaf);
        new_movies.push((dir.clone(), name.clone()));
        all_movies.push((dir.clone(), name, true));
        t2.pack.insert(rel.clone(), (dir, false));
    }
    let (r2, b2) = (root.to_path_buf(), base.clone());
    let langs = vec!["eng".to_string()];
    let (moves, left) = tauri::async_runtime::spawn_blocking(move || {
        let m = plan_moves(&r2, &item, &t2, &b2, false, &langs, &HashMap::new());
        let l = leftovers(&item, &m);
        (m, l)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    let total = movies.len();
    let new = total - had;
    let mut note = format!("{total} movies in this download");
    if had > 0 {
        note.push_str(&format!(": {had} you already have (those copies go to the Trash with the download)"));
    }
    if new > 0 {
        let leaf = base.rsplit('/').next().unwrap_or(&base);
        let place = if root.join(&base).is_dir() { format!("your folder “{leaf}”") } else { format!("a new folder “{leaf}”") };
        note.push_str(&format!("{} {new} new go{} into {place}, each in its own folder", if had > 0 { "; the" } else { ": the" }, if new == 1 { "es" } else { "" }));
        match collection.as_ref() {
            Some(c) if c.id.is_some() => note.push_str(&format!(" and join “{}” in Jellyfin", c.name)),
            Some(c) => note.push_str(&format!("; “{}” is made in Jellyfin with all of them", c.name)),
            None => {}
        }
    }
    note.push('.');
    movie_index_forget();
    let _ = new_movies;
    Ok(InboxPlan { folder: base, existing: had > 0, moves, leftovers: left, note, collection, movies: all_movies })
}

/* --------------------------------------------- a quick list of every movie folder on disk */

/// One movie folder: where it is and the name it's compared by.
#[derive(Clone, Debug)]
pub struct MovieEntry {
    pub rel: String,
    pub key: String,
    pub year: Option<i32>,
}

static MOVIE_INDEX: std::sync::Mutex<Option<(PathBuf, std::time::Instant, Vec<MovieEntry>)>> = std::sync::Mutex::new(None);

/// A collection folder: called so, or holding two or more movie folders.
fn is_collection_dir(dir: &Path, name: &str) -> bool {
    let l = name.to_lowercase();
    ["collection", "saga", "trilogy", "box set"].iter().any(|w| l.contains(w)) || sub_dirs(dir).iter().filter(|m| parse_name(m).year.is_some()).count() >= 2
}

/// Every movie folder in the library (main folders, and one level into collection folders),
/// kept for two minutes so comparing many downloads stays quick.
pub fn movie_index(root: &Path) -> Vec<MovieEntry> {
    if let Ok(g) = MOVIE_INDEX.lock() {
        if let Some((r, at, list)) = g.as_ref() {
            if r == root && at.elapsed() < std::time::Duration::from_secs(120) {
                return list.clone();
            }
        }
    }
    let mut out = Vec::new();
    for top in sub_dirs(root).into_iter().filter(|d| !d.starts_with('.')) {
        let tp = root.join(&top);
        for d in sub_dirs(&tp).into_iter().filter(|d| !d.starts_with('.')) {
            if is_collection_dir(&tp.join(&d), &d) {
                for m in sub_dirs(&tp.join(&d)).into_iter().filter(|m| !m.starts_with('.')) {
                    let (key, year) = folder_key(&m);
                    out.push(MovieEntry { rel: format!("{top}/{d}/{m}"), key, year });
                }
            } else {
                let (key, year) = folder_key(&d);
                out.push(MovieEntry { rel: format!("{top}/{d}"), key, year });
            }
        }
    }
    if let Ok(mut g) = MOVIE_INDEX.lock() {
        *g = Some((root.to_path_buf(), std::time::Instant::now(), out.clone()));
    }
    out
}

/// After placing: the quick list is read again next time.
pub fn movie_index_forget() {
    if let Ok(mut g) = MOVIE_INDEX.lock() {
        *g = None;
    }
}

/// A movie you already have on disk (same title, and the same year when both have one).
pub fn find_movie(root: &Path, title: &str, year: Option<i32>) -> Option<String> {
    let (key, _) = folder_key(title);
    if key.is_empty() {
        return None;
    }
    let hits: Vec<MovieEntry> = movie_index(root).into_iter().filter(|e| e.key == key && (year.is_none() || e.year.is_none() || e.year == year)).collect();
    if hits.len() == 1 { Some(hits[0].rel.clone()) } else { None }
}

/// A download with several movies (a collection pack): what each movie file is.
fn pack_movies(item: &InboxItem) -> Vec<(String, String, Option<i32>)> {
    item.files
        .iter()
        .filter(|f| f.video && !is_sample(&f.rel) && !is_part(&f.rel))
        .map(|f| {
            let (title, year) = movie_of(&f.rel);
            (f.rel.clone(), title, year)
        })
        .collect()
}

/// Which movie a video in a pack is: from its file name, or from the folder it sits in when
/// that says more ("Police Academy 2 (1985)/movie.mkv", "Part 3/Police.Academy.mkv").
fn movie_of(rel: &str) -> (String, Option<i32>) {
    let parts: Vec<&str> = rel.split('/').collect();
    let file = parse_name(split_ext(parts[parts.len() - 1]).0);
    // The nearest folder that names a movie (skips "Subs", "Video", "CD1" and the like).
    let dir = parts[..parts.len() - 1].iter().rev().map(|d| parse_name(d)).find(|p| !p.title.is_empty() && !matches!(p.title.to_lowercase().as_str(), "video" | "videos" | "movie" | "movies" | "subs" | "cd1" | "cd2" | "disc 1" | "disc 2"));
    match dir {
        Some(d) if file.title.is_empty() => (d.title, d.year),
        Some(d) if file.year.is_none() && d.year.is_some() => (d.title, d.year),
        // "movie.mkv", "1.mkv": a name that says nothing.
        Some(d) if file.title.chars().filter(|c| c.is_alphabetic()).count() < 3 || matches!(file.title.to_lowercase().as_str(), "movie" | "film" | "video" | "main") => (d.title, d.year.or(file.year)),
        _ => (file.title, file.year),
    }
}

/// "CD2", "Part 2 of 2", "disc2": one half of a movie split in pieces, not a movie of its own.
fn is_part(rel: &str) -> bool {
    let n = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?:^|[ ._\-\[(])(?:cd|disc|disk|dvd)[ ._\-]?[2-9](?:[ ._\-\])]|$)").unwrap());
    re.is_match(&split_ext(&n).0.to_string())
}

/// The download's name says it holds several movies ("Complete Collection", "Trilogy", "1-7").
fn pack_word(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?i)\b(?:collection|complete|trilogy|quadrilogy|pentalogy|hexalogy|anthology|saga|box ?set|boxset|\d+ ?(?:film|movie)s?|\d{1,2} ?- ?\d{1,2}|(?:19|20)\d\d ?- ?(?:19|20)\d\d)\b").unwrap());
    re.is_match(&name.replace(['.', '_'], " "))
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
    if target.kind == "pack" {
        return resolve_pack(&state, &root, item, target).await;
    }
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
            // Never a second folder: one you have with the same title (with or without the year) is used.
            let found = match target.kind.as_str() {
                "tv" | "movie" => {
                    let (r, top, title, year) = (root.clone(), target.top.clone(), target.title.clone(), target.year);
                    tauri::async_runtime::spawn_blocking(move || find_title_folder(&r, &top, &title, year)).await.ok().flatten()
                }
                _ => None,
            };
            match found {
                Some(f) => (f, true),
                None => (join(&target.top, &name), false),
            }
        }
    };
    // A new movie: already on disk somewhere (also inside a collection folder)? Otherwise, is it
    // part of a collection you already have (on disk or in Jellyfin)?
    let mut collection: Option<CollectionHit> = None;
    let mut folder = folder;
    let mut existing = existing;
    if target.kind == "movie" && !existing {
        let (r, title, year) = (root.clone(), target.title.clone(), target.year);
        let on_disk = tauri::async_runtime::spawn_blocking(move || find_movie(&r, &title, year)).await.ok().flatten();
        if let Some(d) = on_disk {
            folder = d;
            existing = true;
        } else {
            collection = collection_for(&state, &root, &target.top, &target.title, target.tmdb.as_deref()).await;
            if let Some(d) = collection.as_ref().and_then(|c| c.folder.clone()) {
                let leaf = folder.rsplit('/').next().unwrap_or(&folder).to_string();
                folder = join(&d, &leaf);
            }
        }
    }
    // Episode titles for a show you have ("Show - S02E05 - Trojan's Horse").
    let titles = match (target.kind.as_str(), target.item_id.as_deref().filter(|i| valid_item_id(i))) {
        ("tv", Some(id)) => crate::library::episode_titles(&state, id).await.unwrap_or_default(),
        _ => HashMap::new(),
    };
    let (r2, f2, t2) = (root.clone(), folder.clone(), target.clone());
    // Only English subtitles come along; every other language goes to the Trash.
    let langs = vec!["eng".to_string()];
    let (moves, left) = tauri::async_runtime::spawn_blocking(move || {
        let m = plan_moves(&r2, &item, &t2, &f2, existing, &langs, &titles);
        let l = leftovers(&item, &m);
        (m, l)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    let mut note = if existing && target.item_id.is_none() {
        format!("You already have a folder “{}”, so it goes in there (no second folder).", folder.rsplit('/').next().unwrap_or(&folder))
    } else if existing {
        format!("Into your folder “{}”.", folder.rsplit('/').next().unwrap_or(&folder))
    } else {
        "Not in your library yet: a new folder, with no other folder of this title anywhere in your library.".to_string()
    };
    if let Some(c) = &collection {
        note.push_str(&match (&c.folder, &c.id) {
            (Some(f), Some(_)) => format!(" Part of “{}”: it goes in your folder “{}” and joins the collection in Jellyfin.", c.name, f.rsplit('/').next().unwrap_or(f)),
            (Some(f), None) => format!(" Part of “{}”: it goes in your folder “{}”.", c.name, f.rsplit('/').next().unwrap_or(f)),
            (None, Some(_)) => format!(" Part of “{}”: it joins that collection in Jellyfin.", c.name),
            (None, None) => String::new(),
        });
    }
    if target.kind == "movie" {
        movie_index_forget();
    }
    Ok(InboxPlan { folder, existing, moves, leftovers: left, note, collection, movies: Vec::new() })
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

/// After placing: the title Jellyfin made for that folder (None until it has scanned it).
#[tauri::command]
pub async fn inbox_find_item(state: State<'_, AppState>, folder: String, kind: String, title: String) -> Result<Option<String>> {
    let last = folder.trim_end_matches('/').rsplit('/').next().unwrap_or("").to_lowercase();
    if last.is_empty() {
        return Ok(None);
    }
    let t = if kind == "tv" { "Series" } else { "Movie" };
    let c = state.reader().await?;
    let search = parse_name(&title).title;
    let list = c
        .items_query(vec![("IncludeItemTypes", t.into()), ("Recursive", "true".into()), ("SearchTerm", if search.is_empty() { title.clone() } else { search }), ("Fields", "Path".into())], 60)
        .await?;
    Ok(list.iter().find_map(|v| {
        let p = v.get("Path").and_then(Value::as_str)?.replace('\\', "/").to_lowercase();
        let p = p.trim_end_matches('/');
        let dir = if kind == "tv" { p } else { p.rsplit_once('/').map(|x| x.0).unwrap_or(p) };
        let id = v.get("Id").and_then(Value::as_str)?.replace('-', "");
        (dir.ends_with(&format!("/{last}")) && valid_item_id(&id)).then_some(id)
    }))
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
        assert_eq!(season_dir_like(&["Season 1".into(), "Season 2".into()], 3), "Season 03");
        assert_eq!(season_dir_like(&["Season 1".into()], 1), "Season 1", "an existing folder is used");
        assert_eq!(season_dir_like(&["Season 01".into()], 3), "Season 03");
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
        let t = Target { kind: "tv".into(), item_id: None, top: "Kids".into(), title: "Bluey".into(), year: Some(2018), season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        let moves = plan_moves(&root, &item, &t, "Kids/Bluey (2018)", true, &["eng".to_string()], &HashMap::new());
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
        let t = Target { kind: "tv".into(), item_id: None, top: "YouTube".into(), title: "Kurzgesagt".into(), year: None, season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        let moves = plan_moves(&root, &item, &t, "YouTube/Kurzgesagt", true, &[], &HashMap::new());
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
        let t = Target { kind: "movie".into(), item_id: None, top: "Movies".into(), title: "Heat".into(), year: Some(1995), season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        let moves = plan_moves(&root, &item, &t, "Movies/Heat (1995)", false, &["eng".to_string()], &HashMap::new());
        let to: Vec<&str> = moves.iter().map(|m| m.to.as_str()).collect();
        assert_eq!(to, vec!["Movies/Heat (1995)/Heat (1995).mkv", "Movies/Heat (1995)/Heat (1995).eng.srt", "Movies/Heat (1995)/Heat (1995).eng.sdh.srt"], "{moves:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn episodes_get_their_title_and_junk_stays_behind() {
        let root = std::env::temp_dir().join(format!("mh-inbox4-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("TV/Severance (2022)/Season 02")).unwrap();
        let f = |rel: &str, s: Option<u32>, e: &[u32]| InboxFile { rel: rel.into(), size: 1, video: is_video(rel), season: s, episodes: e.to_vec() };
        let item = InboxItem {
            key: "Severance.S02E05.1080p.WEB.H264-GRP".into(), is_folder: true, size: 9, modified: 0, kind: "tv", title: "Severance".into(), year: None, music: None,
            files: vec![
                f("Severance.S02E05.1080p.WEB.H264-GRP.mkv", Some(2), &[5]),
                f("Sample/sample.mkv", None, &[]),
                f("Subs/2_English.srt", None, &[]),
                f("Subs/3_Dutch.srt", None, &[]),
                f("Subs/4_French.srt", None, &[]),
                f("RARBG.txt", None, &[]),
                f("poster.jpg", None, &[]),
                f("Severance.S02E05.nfo", None, &[]),
            ],
        };
        let t = Target { kind: "tv".into(), item_id: Some("x".into()), top: "TV".into(), title: "Severance".into(), year: Some(2022), season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        let mut titles = HashMap::new();
        titles.insert((2, 5), "Trojan's Horse".to_string());
        let moves = plan_moves(&root, &item, &t, "TV/Severance (2022)", true, &["eng".to_string()], &titles);
        let to: Vec<&str> = moves.iter().map(|m| m.to.as_str()).collect();
        assert_eq!(to, vec![
            "TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.mkv",
            "TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.eng.srt",
        ], "{moves:?}");
        let left = leftovers(&item, &moves);
        for junk in ["Sample/sample.mkv", "Subs/3_Dutch.srt", "Subs/4_French.srt", "RARBG.txt", "poster.jpg", "Severance.S02E05.nfo"] {
            assert!(left.iter().any(|l| l == junk), "{junk} stays behind: {left:?}");
        }
        // A generic title is left out.
        titles.insert((2, 5), "Episode 5".to_string());
        let moves = plan_moves(&root, &item, &t, "TV/Severance (2022)", true, &["eng".to_string()], &titles);
        assert_eq!(moves[0].to, "TV/Severance (2022)/Season 02/Severance - S02E05.mkv");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_title_you_have_is_never_given_a_second_folder() {
        let root = std::env::temp_dir().join(format!("mh-inbox5-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["TV/Severance (2022)", "Kids/Bluey", "Movies/Dune (1984)", "Movies/Amélie (2001)", "TV/The Office (US)"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        assert_eq!(find_title_folder(&root, "TV", "Severance", None).as_deref(), Some("TV/Severance (2022)"));
        assert_eq!(find_title_folder(&root, "TV", "Severance", Some(2022)).as_deref(), Some("TV/Severance (2022)"));
        assert_eq!(find_title_folder(&root, "TV", "Bluey", Some(2018)).as_deref(), Some("Kids/Bluey"), "found in another main folder");
        assert_eq!(find_title_folder(&root, "Movies", "Dune", Some(2021)), None, "a different year is a different movie");
        assert_eq!(find_title_folder(&root, "Movies", "Amelie", Some(2001)).as_deref(), Some("Movies/Amélie (2001)"));
        assert_eq!(find_title_folder(&root, "Movies", "Heat", Some(1995)), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn artists_combine_under_their_first_name() {
        let names: Vec<String> = ["Drake", "Drake & 21 Savage", "Drake & Future", "Pete Rock & C.L. Smooth", "Pete Rock & CL Smooth", "Pete Rock & Deda", "Mumford & Sons", "Earth, Wind & Fire", "Kanye West feat. Jay-Z"].iter().map(|s| s.to_string()).collect();
        let g = artist_groups(&names);
        assert_eq!(g.get("Drake & 21 Savage").map(String::as_str), Some("Drake"));
        assert_eq!(g.get("Drake & Future").map(String::as_str), Some("Drake"));
        assert_eq!(g.get("Pete Rock & C.L. Smooth").map(String::as_str), Some("Pete Rock"));
        assert_eq!(g.get("Pete Rock & CL Smooth").map(String::as_str), Some("Pete Rock"));
        assert_eq!(g.get("Pete Rock & Deda").map(String::as_str), Some("Pete Rock"));
        assert_eq!(g.get("Kanye West feat. Jay-Z").map(String::as_str), Some("Kanye West"));
        assert!(!g.contains_key("Mumford & Sons"));
        assert!(!g.contains_key("Earth, Wind & Fire"));
        assert!(!g.contains_key("Drake"));
        assert_eq!(first_artist("Pete Rock & C.L. Smooth"), "Pete Rock");
    }

    #[test]
    fn season_packs_are_seen_as_seasons_of_the_show() {
        assert_eq!(show_title_of("Reacher.S01.1080p.AMZN.WEB-DL.DDP5.1.H.264").0, "Reacher");
        assert_eq!(show_title_of("Reacher S01").0, "Reacher");
        assert_eq!(show_title_of("Reacher (2022) S02 1080p").0, "Reacher");
        assert_eq!(pack_season("Reacher S01"), Some(1));
        assert_eq!(pack_season("Reacher.Season.2.1080p.WEB"), Some(2));
        assert_eq!(pack_season("Reacher.S01E03.1080p"), None);
        assert_eq!(pack_season("Reacher S01-S03"), None);
        let root = std::env::temp_dir().join(format!("mh-inbox6-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let d = root.join("Reacher S01");
        std::fs::create_dir_all(&d).unwrap();
        for n in ["01 - Welcome to Margrave.mkv", "02 - First Dance.mkv"] {
            std::fs::write(d.join(n), b"x").unwrap();
        }
        let it = read_item(&d, "Reacher S01", 0).unwrap();
        assert_eq!(it.kind, "tv");
        assert_eq!(it.title, "Reacher");
        assert!(it.files.iter().filter(|f| f.video).all(|f| f.season == Some(1)), "{:?}", it.files);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn movies_find_the_collection_you_already_have() {
        assert_eq!(series_key("Dune: Part Two"), "dune");
        assert_eq!(series_key("Toy Story 4"), "toystory");
        assert_eq!(series_key("Alien: Romulus"), "alien");
        assert_eq!(collection_key("The Alien Collection"), "alien");
        assert_eq!(collection_key("Dune Collection"), "dune");
        assert_eq!(collection_name("Indiana Jones Collection 1-5 (1981) 1080p BluRay"), "Indiana Jones Collection");
        assert_eq!(collection_name("The Hunger Games 4 Film Complete Collection 1080p BluRay 5.1Ch x265 HEVC"), "The Hunger Games Collection");
        assert_eq!(collection_key("Indiana Jones Collection 1-5 (1981)"), "indianajones");
        let root = std::env::temp_dir().join(format!("mh-inbox7-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["Movies/Alien Collection/Alien (1979)", "Movies/Alien Collection/Aliens (1986)", "Movies/Heat (1995)", "Kids/Toy Story/Toy Story (1995)", "Kids/Toy Story/Toy Story 2 (1999)"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        assert_eq!(find_collection_folder(&root, "Movies", None, "Alien: Romulus").as_deref(), Some("Movies/Alien Collection"));
        assert_eq!(find_collection_folder(&root, "Movies", Some("Alien Collection"), "Romulus").as_deref(), Some("Movies/Alien Collection"));
        assert_eq!(find_collection_folder(&root, "Movies", None, "Toy Story 4").as_deref(), Some("Kids/Toy Story"), "a folder of movie folders counts too");
        assert_eq!(find_collection_folder(&root, "Movies", None, "Heat 2"), None, "a single movie folder isn't a collection");
        assert_eq!(find_collection_folder(&root, "Movies", None, "Dune: Part Two"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_collection_pack_adds_only_the_movies_you_miss() {
        let root = std::env::temp_dir().join(format!("mh-inbox8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for d in ["Movies/The Hunger Games Collection/The Hunger Games (2012)", "Movies/The Hunger Games Collection/The Hunger Games - Catching Fire (2013)", "Movies/The Hunger Games Collection/The Hunger Games - Mockingjay - Part 1 (2014)", "Movies/Heat (1995)"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        movie_index_forget();
        assert_eq!(find_movie(&root, "The Hunger Games Catching Fire", Some(2013)).as_deref(), Some("Movies/The Hunger Games Collection/The Hunger Games - Catching Fire (2013)"));
        assert_eq!(find_movie(&root, "Heat", Some(1995)).as_deref(), Some("Movies/Heat (1995)"));
        assert_eq!(find_movie(&root, "The Hunger Games Mockingjay Part 2", Some(2015)), None);
        // The download is seen as a pack of four movies.
        let dl = root.join("dl/The Hunger Games 4 Film Complete Collection 1080p BluRay x265");
        std::fs::create_dir_all(&dl).unwrap();
        for n in ["The.Hunger.Games.2012.1080p.mkv", "The.Hunger.Games.Catching.Fire.2013.1080p.mkv", "The.Hunger.Games.Mockingjay.Part.1.2014.1080p.mkv", "The.Hunger.Games.Mockingjay.Part.2.2015.1080p.mkv", "The.Hunger.Games.Mockingjay.Part.2.2015.1080p.en.srt", "RARBG.txt"] {
            std::fs::write(dl.join(n), b"x").unwrap();
        }
        let item = read_item(&dl, "The Hunger Games 4 Film Complete Collection 1080p BluRay x265", 0).unwrap();
        assert_eq!(item.kind, "pack");
        assert_eq!(item.title, "The Hunger Games Collection");
        let movies = pack_movies(&item);
        assert_eq!(movies.len(), 4);
        // Placing: three are there already, the fourth goes into the collection folder with its subtitle.
        let mut t = Target { kind: "pack".into(), item_id: None, top: "Movies".into(), title: item.title.clone(), year: None, season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        let base = "Movies/The Hunger Games Collection";
        for (rel, title, year) in &movies {
            match find_movie(&root, title, *year) {
                Some(d) => { t.pack.insert(rel.clone(), (d, true)); }
                None => { t.pack.insert(rel.clone(), (format!("{base}/The Hunger Games - Mockingjay - Part 2 (2015)"), false)); }
            }
        }
        let moves = plan_moves(&root, &item, &t, base, false, &["eng".to_string()], &HashMap::new());
        let mut new: Vec<&str> = moves.iter().filter(|m| !m.have).map(|m| m.to.as_str()).collect();
        new.sort();
        assert_eq!(new, vec![
            "Movies/The Hunger Games Collection/The Hunger Games - Mockingjay - Part 2 (2015)/The Hunger Games - Mockingjay - Part 2 (2015).eng.srt",
            "Movies/The Hunger Games Collection/The Hunger Games - Mockingjay - Part 2 (2015)/The Hunger Games - Mockingjay - Part 2 (2015).mkv",
        ], "{moves:?}");
        assert_eq!(moves.iter().filter(|m| m.have).count(), 3);
        let _ = std::fs::remove_dir_all(&root);
        movie_index_forget();
    }

    #[test]
    fn a_pack_with_a_folder_per_movie_and_subtitles_deeper_inside() {
        let root = std::env::temp_dir().join(format!("mh-inbox9-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Movies/Police Academy Collection/Police Academy (1984)")).unwrap();
        let dl = root.join("dl/Police Academy - The Complete Collection (1984-1994) 1080p");
        for n in [
            "Police Academy (1984)/Police.Academy.1984.1080p.mkv",
            "Police Academy (1984)/Subs/English.srt",
            "Police Academy (1984)/Subs/French.srt",
            "Police Academy 2 - Their First Assignment (1985)/movie.mkv",
            "Police Academy 2 - Their First Assignment (1985)/Subs/2_English.srt",
            "Police Academy 3 - Back in Training (1986)/Police Academy 3.mkv",
            "Police Academy 3 - Back in Training (1986)/Sample/sample.mkv",
            "Police Academy 3 - Back in Training (1986)/Extras/Deleted Scenes.mkv",
        ] {
            let p = dl.join(n);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"x").unwrap();
        }
        let item = read_item(&dl, "Police Academy - The Complete Collection (1984-1994) 1080p", 0).unwrap();
        assert_eq!(item.kind, "pack");
        assert_eq!(item.title, "Police Academy Collection");
        let movies = pack_movies(&item);
        let names: Vec<(String, Option<i32>)> = movies.iter().map(|m| (folder_key(&m.1).0, m.2)).collect();
        assert_eq!(names, vec![("policeacademy".to_string(), Some(1984)), ("policeacademy2theirfirstassignment".to_string(), Some(1985)), ("policeacademy3backintraining".to_string(), Some(1986))], "{names:?}");
        movie_index_forget();
        let base = "Movies/Police Academy Collection";
        let mut t = Target { kind: "pack".into(), item_id: None, top: "Movies".into(), title: item.title.clone(), year: None, season: None, artist: None, album: None, tmdb: None, pack: HashMap::new() };
        for (rel, title, year) in &movies {
            match find_movie(&root, title, *year) {
                Some(d) => { t.pack.insert(rel.clone(), (d, true)); }
                None => { t.pack.insert(rel.clone(), (format!("{base}/{} ({})", title, year.unwrap()), false)); }
            }
        }
        let moves = plan_moves(&root, &item, &t, base, false, &["eng".to_string()], &HashMap::new());
        let mut new: Vec<String> = moves.iter().filter(|m| !m.have).map(|m| m.to.rsplit('/').next().unwrap().to_string()).collect();
        new.sort();
        assert_eq!(new.len(), 3, "{moves:?}");
        assert!(new[0].ends_with("(1985).eng.srt") && new[1].ends_with("(1985).mkv") && new[2].ends_with("(1986).mkv"), "{new:?}");
        // The one you have: its video and English subtitle are doubles.
        assert_eq!(moves.iter().filter(|m| m.have).count(), 2, "{moves:?}");
        assert!(pack_word("The Matrix Trilogy") && pack_word("Alien.Quadrilogy.1080p") && pack_word("Rocky 1-6") && !pack_word("Heat.1995.1080p.x265-RARBG"));
        assert!(is_part("Movie.CD2.avi") && !is_part("Movie.2.avi"));
        let _ = std::fs::remove_dir_all(&root);
        movie_index_forget();
    }
}
