//! Music straight from a folder (on this computer or the NAS), without Jellyfin.
//! Song details come from the files' tags (title, artist, album, year, track, cover art),
//! falling back to the folder layout: Artist / Album (Year) / 01 - Song.flac, with
//! cover.jpg or folder.jpg as the album picture. What was read is kept in a library file in
//! the music folder (`.mediahub/library.json`, covers in `.mediahub/covers/`), so opening
//! the app again is instant and only new or changed songs are read.

use crate::error::{Error, Result};
use crate::music::MusicItem;
use crate::state::AppState;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

const AUDIO: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "alac", "aiff", "aif"];
const COVERS: &[&str] = &["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "album.jpg", "Cover.jpg", "Folder.jpg"];
const LIB_DIR: &str = ".mediahub";

#[derive(Clone, Debug)]
pub struct Track {
    pub key: String,
    pub path: PathBuf,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_key: String,
    pub year: Option<i64>,
    pub index: Option<i64>,
    pub disc: Option<i64>,
    pub duration: f64,
    /// When the file was added (for "New").
    pub added: u64,
}

struct Index {
    root: PathBuf,
    at: Instant,
    tracks: Vec<Track>,
    /// album key -> cover file
    covers: HashMap<String, PathBuf>,
    /// artist key -> picture file
    artists: HashMap<String, PathBuf>,
    /// Read from the files' tags (not only from folder names).
    tagged: bool,
}

/// One song in the library file.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
struct Entry {
    rel: String,
    size: u64,
    mtime: u64,
    title: Option<String>,
    artist: Option<String>,
    album_artist: Option<String>,
    album: Option<String>,
    year: Option<i64>,
    track: Option<i64>,
    disc: Option<i64>,
    duration: f64,
    #[serde(default)]
    embedded_art: bool,
}

#[derive(Serialize, Deserialize, Default)]
struct LibFile {
    version: u32,
    entries: Vec<Entry>,
    /// The finished list (what the app shows), so the next start needs no walk over the NAS.
    #[serde(default)]
    tracks: Vec<SavedTrack>,
    /// album key -> cover file, relative to the music folder
    #[serde(default)]
    covers: HashMap<String, String>,
    /// artist key -> picture file, relative to the music folder
    #[serde(default)]
    artists: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct SavedTrack {
    rel: String,
    title: String,
    artist: String,
    album: String,
    album_key: String,
    year: Option<i64>,
    index: Option<i64>,
    disc: Option<i64>,
    duration: f64,
    added: u64,
}

/// The index straight from the library file (instant; the folder is read again in the background).
fn from_lib(root: &Path) -> Option<Index> {
    let lib = load_lib(root);
    if lib.tracks.is_empty() {
        return None;
    }
    let tracks = lib
        .tracks
        .iter()
        .map(|t| Track {
            key: key_of(&t.rel),
            path: root.join(&t.rel),
            title: t.title.clone(),
            artist: t.artist.clone(),
            album: t.album.clone(),
            album_key: t.album_key.clone(),
            year: t.year,
            index: t.index,
            disc: t.disc,
            duration: t.duration,
            added: t.added,
        })
        .collect();
    let covers = lib.covers.iter().map(|(k, v)| (k.clone(), root.join(v))).collect();
    let artists = lib.artists.iter().map(|(k, v)| (k.clone(), root.join(v))).collect();
    Some(Index { root: root.to_path_buf(), at: Instant::now(), tracks, covers, artists, tagged: false })
}

fn index() -> &'static Mutex<Option<Index>> {
    static I: OnceLock<Mutex<Option<Index>>> = OnceLock::new();
    I.get_or_init(|| Mutex::new(None))
}

static SCANNING: AtomicBool = AtomicBool::new(false);

fn key_of(s: &str) -> String {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn re_track() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // "01 - Song", "1-02 Song", "02. Song", "Artist - 03 - Song"
    R.get_or_init(|| Regex::new(r"^(?:(\d)[-.])?(\d{1,3})(?:\s*[-._)]\s*|\s+)(.+)$").expect("track pattern"))
}

fn re_year() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^(.*?)\s*[\(\[]((?:19|20)\d{2})[\)\]]\s*$").expect("year pattern"))
}

/// Title, track and disc number from a file name ("1-02 - Song.flac" → ("Song", 2, 1)).
pub fn parse_file(stem: &str) -> (String, Option<i64>, Option<i64>) {
    match re_track().captures(stem.trim()) {
        Some(c) => {
            let disc = c.get(1).and_then(|m| m.as_str().parse().ok());
            let n = c.get(2).and_then(|m| m.as_str().parse().ok());
            (c[3].trim().to_string(), n, disc)
        }
        None => (stem.trim().to_string(), None, None),
    }
}

/// Album name and year from a folder name ("Moon Safari (1998)").
pub fn parse_album(name: &str) -> (String, Option<i64>) {
    match re_year().captures(name) {
        Some(c) => (c[1].trim().to_string(), c[2].parse().ok()),
        None => (name.trim().to_string(), None),
    }
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")).unwrap_or_default()
}

fn lib_dir(root: &Path) -> PathBuf {
    root.join(LIB_DIR)
}

fn load_lib(root: &Path) -> LibFile {
    std::fs::read(lib_dir(root).join("library.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn save_lib(root: &Path, lib: &LibFile) {
    let dir = lib_dir(root);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(b) = serde_json::to_vec(lib) {
        let tmp = dir.join("library.json.tmp");
        if std::fs::write(&tmp, b).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("library.json"));
        }
    }
}

/// Reads a song's tags. `None` when the file can't be read as audio.
fn read_tags(path: &Path) -> Option<Entry> {
    use lofty::prelude::*;
    let opts = lofty::config::ParseOptions::new().read_cover_art(false);
    let file = lofty::probe::Probe::open(path).ok()?.options(opts).read().ok()?;
    let mut e = Entry { duration: file.properties().duration().as_secs_f64(), ..Default::default() };
    if let Some(tag) = file.primary_tag().or_else(|| file.first_tag()) {
        let clean = |s: Option<std::borrow::Cow<'_, str>>| s.map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        e.title = clean(tag.title());
        e.artist = clean(tag.artist());
        e.album = clean(tag.album());
        e.album_artist = tag.get_string(&ItemKey::AlbumArtist).map(|x| x.trim().to_string()).filter(|x| !x.is_empty());
        e.year = tag.year().map(i64::from).filter(|y| (1000..3000).contains(y)).or_else(|| {
            tag.get_string(&ItemKey::RecordingDate).and_then(|d| d.get(..4)).and_then(|y| y.parse().ok())
        });
        e.track = tag.track().map(i64::from).filter(|n| *n > 0);
        e.disc = tag.disk().map(i64::from).filter(|n| *n > 0);
    }
    Some(e)
}

/// The first picture inside a song file, with its file extension.
fn embedded_cover(path: &Path) -> Option<(Vec<u8>, &'static str)> {
    use lofty::prelude::*;
    let file = lofty::probe::Probe::open(path).ok()?.options(lofty::config::ParseOptions::new().read_properties(false)).read().ok()?;
    for tag in file.tags() {
        let pics = tag.pictures();
        let pic = pics.iter().find(|p| p.pic_type() == lofty::picture::PictureType::CoverFront).or_else(|| pics.first());
        if let Some(p) = pic {
            let ext = match p.mime_type() {
                Some(lofty::picture::MimeType::Png) => "png",
                _ => "jpg",
            };
            return Some((p.data().to_vec(), ext));
        }
    }
    None
}

/// Walks the folder. With `tags`, reads new or changed songs' tags (and keeps the library
/// file up to date); without, uses the library file as it is plus folder names.
fn scan(root: &Path, tags: bool) -> Index {
    let old = load_lib(root);
    let known: HashMap<&str, &Entry> = old.entries.iter().map(|e| (e.rel.as_str(), e)).collect();
    let mut entries: Vec<Entry> = Vec::new();
    let mut tracks = Vec::new();
    let mut covers = HashMap::new();
    let cover_dir = lib_dir(root).join("covers");
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut changed = false;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<(PathBuf, std::fs::Metadata)> = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(md) = e.metadata() else { continue };
            if md.is_dir() {
                if depth < 6 {
                    stack.push((p, depth + 1));
                }
            } else {
                files.push((p, md));
            }
        }
        let rel_dir = rel_of(root, &dir);
        let parts: Vec<&str> = rel_dir.split('/').filter(|x| !x.is_empty()).collect();
        let (folder_album, folder_year) = parse_album(parts.last().copied().unwrap_or("Unsorted"));
        let folder_artist = if parts.len() >= 2 { parts[parts.len() - 2].to_string() } else { "Unknown artist".to_string() };
        let album_key = key_of(&rel_dir);
        let mut album_tracks: Vec<Track> = Vec::new();
        let mut art_in_file: Option<PathBuf> = None;
        for (f, md) in &files {
            let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !AUDIO.contains(&ext.as_str()) {
                continue;
            }
            let rel = rel_of(root, f);
            let size = md.len();
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            let entry = match known.get(rel.as_str()) {
                Some(e) if e.size == size && e.mtime == mtime => (*e).clone(),
                _ if tags => {
                    changed = true;
                    let mut e = read_tags(f).unwrap_or_default();
                    e.rel = rel.clone();
                    e.size = size;
                    e.mtime = mtime;
                    e
                }
                Some(e) => (*e).clone(),
                None => Entry { rel: rel.clone(), size, mtime, ..Default::default() },
            };
            let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let (mut file_title, file_index, file_disc) = parse_file(stem);
            if let Some(rest) = file_title.strip_prefix(&format!("{folder_artist} - ")) {
                file_title = rest.to_string();
            }
            if entry.embedded_art && art_in_file.is_none() {
                art_in_file = Some(f.clone());
            }
            album_tracks.push(Track {
                key: key_of(&rel),
                path: f.clone(),
                title: entry.title.clone().unwrap_or(file_title),
                artist: entry.album_artist.clone().or_else(|| entry.artist.clone()).unwrap_or_else(|| folder_artist.clone()),
                album: entry.album.clone().unwrap_or_else(|| folder_album.clone()),
                album_key: album_key.clone(),
                year: entry.year.or(folder_year),
                index: entry.track.or(file_index),
                disc: entry.disc.or(file_disc),
                duration: entry.duration,
                added: mtime,
            });
            entries.push(entry);
        }
        if album_tracks.is_empty() {
            continue;
        }
        // One album name and artist for the whole folder (the most common tag wins).
        let common = |f: &dyn Fn(&Track) -> String| -> String {
            let mut c: HashMap<String, usize> = HashMap::new();
            for t in &album_tracks {
                *c.entry(f(t)).or_default() += 1;
            }
            c.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|x| x.0).unwrap_or_default()
        };
        let album = common(&|t| t.album.clone());
        let artist = common(&|t| t.artist.clone());
        let year = album_tracks.iter().filter_map(|t| t.year).min();
        for t in &mut album_tracks {
            t.album = album.clone();
            t.artist = artist.clone();
            t.year = year;
        }
        // The album picture: a picture file in the folder, then one saved earlier, then the
        // one inside a song (saved to the library folder for next time).
        if let Some(c) = COVERS.iter().map(|c| dir.join(c)).find(|p| p.is_file()) {
            covers.insert(album_key.clone(), c);
        } else if let Some((img, _)) = files.iter().find(|(f, _)| matches!(f.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(), Some("jpg" | "jpeg" | "png"))) {
            covers.insert(album_key.clone(), img.clone());
        } else if let Some(saved) = ["jpg", "png"].iter().map(|e| cover_dir.join(format!("{album_key}.{e}"))).find(|p| p.is_file()) {
            covers.insert(album_key.clone(), saved);
        } else if tags {
            let source = art_in_file.or_else(|| album_tracks.first().map(|t| t.path.clone()));
            if let Some((bytes, ext)) = source.as_deref().and_then(embedded_cover) {
                let out = cover_dir.join(format!("{album_key}.{ext}"));
                if std::fs::create_dir_all(&cover_dir).is_ok() && std::fs::write(&out, bytes).is_ok() {
                    covers.insert(album_key.clone(), out);
                }
            }
        }
        tracks.extend(album_tracks);
        if tracks.len() > 200_000 {
            break;
        }
    }
    tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.year, a.album.to_lowercase(), a.disc, a.index, a.title.to_lowercase()).cmp(&(b.artist.to_lowercase(), b.year, b.album.to_lowercase(), b.disc, b.index, b.title.to_lowercase())));
    // Artist pictures found online earlier.
    let artist_dir = lib_dir(root).join("artists");
    let mut artists = HashMap::new();
    for e in std::fs::read_dir(&artist_dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(k) = name.split('.').next().filter(|k| k.len() == 16) {
            artists.insert(k.to_string(), e.path());
        }
    }
    if tags {
        entries.sort_by(|a, b| a.rel.cmp(&b.rel));
        let saved: Vec<SavedTrack> = tracks
            .iter()
            .map(|t| SavedTrack { rel: rel_of(root, &t.path), title: t.title.clone(), artist: t.artist.clone(), album: t.album.clone(), album_key: t.album_key.clone(), year: t.year, index: t.index, disc: t.disc, duration: t.duration, added: t.added })
            .collect();
        let covers_rel = covers.iter().map(|(k, v): (&String, &PathBuf)| (k.clone(), rel_of(root, v))).collect();
        let artists_rel = artists.iter().map(|(k, v): (&String, &PathBuf)| (k.clone(), rel_of(root, v))).collect();
        let _ = changed;
        save_lib(root, &LibFile { version: 2, entries, tracks: saved, covers: covers_rel, artists: artists_rel });
    }
    Index { root: root.to_path_buf(), at: Instant::now(), tracks, covers, artists, tagged: tags }
}

/// Reads tags in the background and swaps the result in; the window is told to reload.
fn refresh_in_background(root: PathBuf, app: Option<AppHandle>) {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let ix = scan(&root, true);
        if let Ok(mut g) = index().lock() {
            if g.as_ref().map(|i| i.root == root).unwrap_or(true) {
                *g = Some(ix);
            }
        }
        SCANNING.store(false, Ordering::SeqCst);
        if let Some(app) = app {
            let _ = app.emit("music-updated", ());
        }
    });
}

/// The music index. The first time it comes from the library file and folder names (fast),
/// and the tags are read in the background; after 10 minutes it's refreshed in the background.
fn with_index<T>(root: &Path, app: Option<&AppHandle>, f: impl FnOnce(&Index) -> T) -> Result<T> {
    let mut g = index().lock().map_err(|_| Error::msg("internal error"))?;
    let missing = g.as_ref().map(|i| i.root != root).unwrap_or(true);
    if missing {
        // From the library file when there is one (no walk over the NAS), else folder names.
        *g = Some(from_lib(root).unwrap_or_else(|| scan(root, false)));
    }
    let ix = g.as_ref().expect("just set");
    if !ix.tagged || ix.at.elapsed() > Duration::from_secs(600) {
        refresh_in_background(root.to_path_buf(), app.cloned());
    }
    Ok(f(ix))
}

/// Settings / Music → refresh: reads the folder again now (tags of new and changed songs).
#[tauri::command]
pub async fn music_rescan(state: State<'_, AppState>) -> Result<usize> {
    let root = root_of(&state)?;
    let ix = tauri::async_runtime::spawn_blocking(move || scan(&root, true)).await.map_err(|e| Error::msg(e.to_string()))?;
    let n = ix.tracks.len();
    *index().lock().map_err(|_| Error::msg("internal error"))? = Some(ix);
    Ok(n)
}

fn base() -> &'static str {
    if cfg!(windows) {
        "http://hubmedia.localhost"
    } else {
        "hubmedia://localhost"
    }
}

fn track_item(t: &Track, has_cover: bool) -> MusicItem {
    let mut m = MusicItem::local(
        format!("L{}", t.key),
        "track",
        t.title.clone(),
        t.artist.clone(),
        t.album.clone(),
        Some(format!("A{}", t.album_key)),
        t.year,
        t.index,
        t.disc,
        has_cover.then(|| format!("{}/lc/{}", base(), t.album_key)),
        None,
    );
    m.set_duration(t.duration);
    m
}

fn root_of(state: &AppState) -> Result<PathBuf> {
    let dir = state.settings()?.music_dir.ok_or_else(|| Error::msg("Choose your music folder first."))?;
    let p = PathBuf::from(dir);
    if !p.is_dir() {
        return Err(Error::msg("The music folder can't be reached (is the NAS connected?)."));
    }
    Ok(p)
}

/// Same views as Jellyfin music: albums, artists, tracks of an album/artist, search.
pub fn list(app: &AppHandle, state: &AppState, view: &str, parent: Option<&str>, query: &str, start: u64, limit: u64) -> Result<Vec<MusicItem>> {
    let root = root_of(state)?;
    let q = query.to_lowercase();
    with_index(&root, Some(app), |ix| {
        let hit = |t: &Track| q.is_empty() || t.title.to_lowercase().contains(&q) || t.album.to_lowercase().contains(&q) || t.artist.to_lowercase().contains(&q);
        let out: Vec<MusicItem> = match view {
            "albums" | "recent" | "artist_albums" | "favorites" => {
                let mut seen: Vec<&Track> = Vec::new();
                let mut order: Vec<&Track> = ix.tracks.iter().filter(|t| hit(t)).collect();
                if view == "recent" {
                    // Newest albums first.
                    let mut newest: HashMap<&str, u64> = HashMap::new();
                    for t in &order {
                        let e = newest.entry(t.album_key.as_str()).or_default();
                        *e = (*e).max(t.added);
                    }
                    order.sort_by(|a, b| newest[b.album_key.as_str()].cmp(&newest[a.album_key.as_str()]));
                }
                for t in order {
                    if view == "artist_albums" && Some(format!("R{}", key_of(&t.artist)).as_str()) != parent {
                        continue;
                    }
                    if !seen.iter().any(|s| s.album_key == t.album_key) {
                        seen.push(t);
                    }
                }
                seen.iter()
                    .map(|t| {
                        let count = ix.tracks.iter().filter(|x| x.album_key == t.album_key).count() as i64;
                        MusicItem::local(format!("A{}", t.album_key), "album", t.album.clone(), t.artist.clone(), t.album.clone(), None, t.year, None, None, ix.covers.contains_key(&t.album_key).then(|| format!("{}/lc/{}", base(), t.album_key)), Some(count))
                    })
                    .collect()
            }
            "artists" => {
                let mut names: Vec<&str> = ix.tracks.iter().filter(|t| hit(t)).map(|t| t.artist.as_str()).collect();
                names.dedup();
                names.sort_by_key(|n| n.to_lowercase());
                names.dedup();
                names
                    .into_iter()
                    .map(|n| {
                        let first = ix.tracks.iter().find(|t| t.artist == n);
                        let cover = if ix.artists.contains_key(&key_of(n)) {
                            Some(format!("{}/la/{}", base(), key_of(n)))
                        } else {
                            first.filter(|t| ix.covers.contains_key(&t.album_key)).map(|t| format!("{}/lc/{}", base(), t.album_key))
                        };
                        let albums = ix.tracks.iter().filter(|t| t.artist == n).map(|t| &t.album_key).collect::<std::collections::HashSet<_>>().len() as i64;
                        MusicItem::local(format!("R{}", key_of(n)), "artist", n.to_string(), n.to_string(), String::new(), None, None, None, None, cover, Some(albums))
                    })
                    .collect()
            }
            "tracks" => {
                let p = parent.unwrap_or("");
                ix.tracks
                    .iter()
                    .filter(|t| (p.strip_prefix('A') == Some(t.album_key.as_str())) || (p.starts_with('R') && format!("R{}", key_of(&t.artist)) == p))
                    .map(|t| track_item(t, ix.covers.contains_key(&t.album_key)))
                    .collect()
            }
            "search" => ix.tracks.iter().filter(|t| hit(t)).take(300).map(|t| track_item(t, ix.covers.contains_key(&t.album_key))).collect(),
            _ => Vec::new(),
        };
        out.into_iter().skip(start as usize).take(limit.clamp(1, 5000) as usize).collect()
    })
}

/// The address a local song plays from.
pub fn play_url(id: &str) -> Result<String> {
    let key = id.strip_prefix('L').filter(|k| k.len() == 16 && k.chars().all(|c| c.is_ascii_hexdigit())).ok_or_else(|| Error::msg("bad id"))?;
    Ok(format!("{}/lf/{key}", base()))
}

/// Serves "lf/<track>" (the song) and "lc/<album>" (its cover) for the hubmedia scheme.
pub fn serve(app: &AppHandle, path: &str) -> Option<(Vec<u8>, String)> {
    use tauri::Manager;
    let (kind, key) = path.trim_start_matches('/').split_once('/')?;
    if key.len() != 16 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let state = app.state::<AppState>();
    let root = root_of(&state).ok()?;
    let file = with_index(&root, Some(app), |ix| match kind {
        "lf" => ix.tracks.iter().find(|t| t.key == key).map(|t| t.path.clone()),
        "lc" => ix.covers.get(key).cloned(),
        "la" => ix.artists.get(key).cloned(),
        _ => None,
    })
    .ok()??;
    // Only files inside the music folder.
    if !file.canonicalize().ok()?.starts_with(root.canonicalize().ok()?) {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let ct = match ext.as_str() {
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" | "aac" | "alac" => "audio/mp4",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "aiff" | "aif" => "audio/aiff",
        "png" => "image/png",
        _ => "image/jpeg",
    };
    Some((bytes, ct.to_string()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicSource {
    folder: Option<String>,
    /// "jellyfin" | "folder"
    source: String,
}

#[tauri::command]
pub fn music_source(state: State<'_, AppState>) -> Result<MusicSource> {
    let s = state.settings()?;
    Ok(MusicSource { folder: s.music_dir.clone(), source: if s.music_from_folder && s.music_dir.is_some() { "folder".into() } else { "jellyfin".into() } })
}

#[tauri::command]
pub fn set_music_source(state: State<'_, AppState>, folder: bool) -> Result<()> {
    state.update_settings(|s| s.music_from_folder = folder)
}

#[tauri::command]
pub async fn pick_music_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_folder()).await.map_err(|e| Error::msg(e.to_string()))?;
    let Some(fp) = picked else { return Ok(None) };
    let p = fp.into_path().map_err(|_| Error::msg("That folder cannot be used."))?;
    if !p.is_dir() {
        return Err(Error::msg("That is not a folder."));
    }
    let s = p.to_string_lossy().into_owned();
    let saved = s.clone();
    state.update_settings(move |st| {
        st.music_dir = Some(saved);
        st.music_from_folder = true;
    })?;
    if let Ok(mut g) = index().lock() {
        *g = None;
    }
    Ok(Some(s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_and_folder_names() {
        assert_eq!(parse_file("01 - Midnight City"), ("Midnight City".to_string(), Some(1), None));
        assert_eq!(parse_file("1-02 Wait"), ("Wait".to_string(), Some(2), Some(1)));
        assert_eq!(parse_file("03. Reunion"), ("Reunion".to_string(), Some(3), None));
        assert_eq!(parse_file("Intro"), ("Intro".to_string(), None, None));
        assert_eq!(parse_album("Moon Safari (1998)"), ("Moon Safari".to_string(), Some(1998)));
        assert_eq!(parse_album("Discovery"), ("Discovery".to_string(), None));
    }

    #[test]
    fn reads_tags_and_cover_when_available() {
        let root = std::path::PathBuf::from("/tmp/mt");
        if !root.join("Whatever/x.mp3").exists() {
            return;
        }
        let _ = std::fs::remove_dir_all(root.join(LIB_DIR));
        let ix = scan(&root, true);
        assert_eq!(ix.tracks[0].title, "Real Title");
        assert_eq!(ix.tracks[0].artist, "Real Artist");
        assert_eq!(ix.tracks[0].album, "Real Album");
        assert_eq!(ix.tracks[0].year, Some(1999));
        assert_eq!(ix.tracks[0].index, Some(4));
        assert_eq!(ix.covers.len(), 1, "embedded cover saved");
        assert!(root.join(LIB_DIR).join("library.json").exists());
        // From the library file alone, without reading tags again.
        let quick = scan(&root, false);
        assert_eq!(quick.tracks[0].title, "Real Title");
        assert_eq!(quick.covers.len(), 1);
    }

    #[test]
    fn scans_a_folder() {
        let root = std::env::temp_dir().join(format!("mh-music-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Air/Moon Safari (1998)")).unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/01 - La Femme d'Argent.mp3"), b"x").unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/02 - Sexy Boy.mp3"), b"x").unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/cover.jpg"), b"x").unwrap();
        let ix = scan(&root, true);
        assert_eq!(ix.tracks.len(), 2);
        assert_eq!(ix.tracks[0].artist, "Air");
        assert_eq!(ix.tracks[0].album, "Moon Safari");
        assert_eq!(ix.tracks[1].title, "Sexy Boy");
        assert_eq!(ix.covers.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/* ------------------------------------------------ covers and artist pictures online */

fn web() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            // MusicBrainz asks every app to say who it is.
            .user_agent(concat!("MediaHub/", env!("CARGO_PKG_VERSION"), " ( https://github.com/pugcadet/media-hub )"))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("http client")
    })
}

async fn get_json(url: &str) -> Option<serde_json::Value> {
    let r = web().get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

async fn get_image(url: &str) -> Option<(Vec<u8>, &'static str)> {
    let r = web().get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?.to_vec();
    let ext = if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if b.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else {
        return None;
    };
    (b.len() > 1000 && b.len() < 15_000_000).then_some((b, ext))
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Lucene-safe text for a MusicBrainz query.
fn lucene(s: &str) -> String {
    s.chars().filter(|c| !"+-&|!(){}[]^\"~*?:\\/".contains(*c)).collect()
}

/// An album cover: MusicBrainz (Cover Art Archive) first, then Deezer.
async fn find_cover(artist: &str, album: &str) -> Option<(Vec<u8>, &'static str)> {
    let q = format!("releasegroup:\"{}\" AND artist:\"{}\"", lucene(album), lucene(artist));
    let url = format!("https://musicbrainz.org/ws/2/release-group/?query={}&fmt=json&limit=3", enc(&q));
    if let Some(v) = get_json(&url).await {
        for rg in v.get("release-groups").and_then(|x| x.as_array()).into_iter().flatten() {
            let score = rg.get("score").and_then(|x| x.as_i64()).unwrap_or(0);
            let Some(id) = rg.get("id").and_then(|x| x.as_str()) else { continue };
            if score < 85 {
                continue;
            }
            if let Some(img) = get_image(&format!("https://coverartarchive.org/release-group/{id}/front-500")).await {
                return Some(img);
            }
        }
    }
    let url = format!("https://api.deezer.com/search/album?q={}&limit=3", enc(&format!("artist:\"{artist}\" album:\"{album}\"")));
    let v = get_json(&url).await?;
    let first = v.get("data")?.as_array()?.iter().find(|a| {
        let t = a.get("title").and_then(|x| x.as_str()).unwrap_or("");
        crate::sources::similarity(t, album) >= 0.7
    })?;
    get_image(first.get("cover_xl").and_then(|x| x.as_str())?).await
}

/// An artist picture from Deezer (MusicBrainz has no pictures itself).
async fn find_artist(artist: &str) -> Option<(Vec<u8>, &'static str)> {
    let url = format!("https://api.deezer.com/search/artist?q={}&limit=3", enc(artist));
    let v = get_json(&url).await?;
    let a = v.get("data")?.as_array()?.iter().find(|a| {
        let n = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        crate::sources::similarity(n, artist) >= 0.85
    })?;
    let pic = a.get("picture_xl").and_then(|x| x.as_str())?;
    // Deezer's placeholder for artists without a picture.
    if pic.contains("/artist//") {
        return None;
    }
    get_image(pic).await
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArtResult {
    covers: usize,
    artists: usize,
    missing_covers: usize,
}

/// Looks online for album covers and artist pictures the music folder doesn't have, saves
/// them in `.mediahub/` (never touches your music files). One request a second, as
/// MusicBrainz asks. Progress as "music-art-progress"; Stop with the "musicart" job.
#[tauri::command]
pub async fn music_fetch_art(app: AppHandle, state: State<'_, AppState>) -> Result<ArtResult> {
    let root = root_of(&state)?;
    let (albums, artists): (Vec<(String, String, String)>, Vec<String>) = {
        let g = index().lock().map_err(|_| Error::msg("internal error"))?;
        let ix = g.as_ref().filter(|i| i.root == root).ok_or_else(|| Error::msg("Open Music first so the folder is read."))?;
        let mut seen = std::collections::HashSet::new();
        let albums = ix
            .tracks
            .iter()
            .filter(|t| !ix.covers.contains_key(&t.album_key) && seen.insert(t.album_key.clone()))
            .map(|t| (t.album_key.clone(), t.artist.clone(), t.album.clone()))
            .collect();
        let mut names: Vec<String> = ix.tracks.iter().map(|t| t.artist.clone()).filter(|a| !ix.artists.contains_key(&key_of(a)) && a != "Unknown artist").collect();
        names.sort();
        names.dedup();
        (albums, names)
    };
    crate::cancel::begin("musicart");
    let total = albums.len() + artists.len();
    let covers_dir = lib_dir(&root).join("covers");
    let artists_dir = lib_dir(&root).join("artists");
    let _ = std::fs::create_dir_all(&covers_dir);
    let _ = std::fs::create_dir_all(&artists_dir);
    let mut res = ArtResult { covers: 0, artists: 0, missing_covers: 0 };
    let pause = || tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(1100)));
    for (i, (key, artist, album)) in albums.iter().enumerate() {
        crate::cancel::check("musicart")?;
        let _ = app.emit("music-art-progress", serde_json::json!({ "done": i, "total": total, "label": format!("{artist} · {album}") }));
        match find_cover(artist, album).await {
            Some((bytes, ext)) => {
                let f = covers_dir.join(format!("{key}.{ext}"));
                if std::fs::write(&f, bytes).is_ok() {
                    res.covers += 1;
                    if let Ok(mut g) = index().lock() {
                        if let Some(ix) = g.as_mut() {
                            ix.covers.insert(key.clone(), f);
                        }
                    }
                }
            }
            None => res.missing_covers += 1,
        }
        let _ = pause().await;
    }
    for (i, name) in artists.iter().enumerate() {
        crate::cancel::check("musicart")?;
        let _ = app.emit("music-art-progress", serde_json::json!({ "done": albums.len() + i, "total": total, "label": name }));
        if let Some((bytes, ext)) = find_artist(name).await {
            let f = artists_dir.join(format!("{}.{ext}", key_of(name)));
            if std::fs::write(&f, bytes).is_ok() {
                res.artists += 1;
                if let Ok(mut g) = index().lock() {
                    if let Some(ix) = g.as_mut() {
                        ix.artists.insert(key_of(name), f);
                    }
                }
            }
        }
        let _ = pause().await;
    }
    // Next start shows them straight from the library file.
    let r2 = root.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let ix = scan(&r2, true);
        if let Ok(mut g) = index().lock() {
            *g = Some(ix);
        }
    })
    .await;
    Ok(res)
}
