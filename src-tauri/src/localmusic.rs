//! Music straight from a folder (on this computer or the NAS), without Jellyfin.
//! The layout is read from the folders: Artist / Album (Year) / 01 - Song.flac, with
//! cover.jpg or folder.jpg as the album picture.

use crate::error::{Error, Result};
use crate::music::MusicItem;
use crate::state::AppState;
use regex::Regex;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const AUDIO: &[&str] = &["mp3", "flac", "m4a", "aac", "ogg", "opus", "wav", "alac", "aiff", "aif"];
const COVERS: &[&str] = &["cover.jpg", "cover.png", "folder.jpg", "folder.png", "front.jpg", "album.jpg", "Cover.jpg", "Folder.jpg"];

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
}

struct Index {
    root: PathBuf,
    at: Instant,
    tracks: Vec<Track>,
    /// album key -> cover file
    covers: HashMap<String, PathBuf>,
}

fn index() -> &'static Mutex<Option<Index>> {
    static I: OnceLock<Mutex<Option<Index>>> = OnceLock::new();
    I.get_or_init(|| Mutex::new(None))
}

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

fn scan(root: &Path) -> Index {
    let mut tracks = Vec::new();
    let mut covers = HashMap::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                if depth < 6 {
                    stack.push((p, depth + 1));
                }
            } else {
                files.push(p);
            }
        }
        let rel: Vec<String> = dir.strip_prefix(root).map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        let (album_name, year) = parse_album(rel.last().map(String::as_str).unwrap_or("Unsorted"));
        let artist = if rel.len() >= 2 { rel[rel.len() - 2].clone() } else { "Unknown artist".to_string() };
        let album_key = key_of(&dir.to_string_lossy());
        let mut any = false;
        for f in &files {
            let ext = f.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !AUDIO.contains(&ext.as_str()) {
                continue;
            }
            any = true;
            let stem = f.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let (mut title, index, disc) = parse_file(stem);
            // "Artist - Song" inside the artist's own folder: drop the repeated artist.
            if let Some(rest) = title.strip_prefix(&format!("{artist} - ")) {
                title = rest.to_string();
            }
            tracks.push(Track { key: key_of(&f.to_string_lossy()), path: f.clone(), title, artist: artist.clone(), album: album_name.clone(), album_key: album_key.clone(), year, index, disc });
        }
        if any {
            if let Some(c) = COVERS.iter().map(|c| dir.join(c)).find(|p| p.is_file()) {
                covers.insert(album_key.clone(), c);
            } else if let Some(img) = files.iter().find(|f| matches!(f.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(), Some("jpg" | "jpeg" | "png"))) {
                covers.insert(album_key.clone(), img.clone());
            }
        }
        if tracks.len() > 200_000 {
            break;
        }
    }
    tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.year, a.album.to_lowercase(), a.disc, a.index, a.title.to_lowercase()).cmp(&(b.artist.to_lowercase(), b.year, b.album.to_lowercase(), b.disc, b.index, b.title.to_lowercase())));
    Index { root: root.to_path_buf(), at: Instant::now(), tracks, covers }
}

/// The scanned folder (scanned again after 10 minutes or when the folder changes).
fn with_index<T>(root: &Path, f: impl FnOnce(&Index) -> T) -> Result<T> {
    let mut g = index().lock().map_err(|_| Error::msg("internal error"))?;
    let stale = g.as_ref().map(|i| i.root != root || i.at.elapsed() > Duration::from_secs(600)).unwrap_or(true);
    if stale {
        *g = Some(scan(root));
    }
    Ok(f(g.as_ref().expect("just set")))
}

fn base() -> &'static str {
    if cfg!(windows) {
        "http://hubmedia.localhost"
    } else {
        "hubmedia://localhost"
    }
}

fn track_item(t: &Track, has_cover: bool) -> MusicItem {
    MusicItem::local(
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
    )
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
pub fn list(state: &AppState, view: &str, parent: Option<&str>, query: &str, start: u64, limit: u64) -> Result<Vec<MusicItem>> {
    let root = root_of(state)?;
    let q = query.to_lowercase();
    with_index(&root, |ix| {
        let hit = |t: &Track| q.is_empty() || t.title.to_lowercase().contains(&q) || t.album.to_lowercase().contains(&q) || t.artist.to_lowercase().contains(&q);
        let out: Vec<MusicItem> = match view {
            "albums" | "recent" | "artist_albums" | "favorites" => {
                let mut seen: Vec<&Track> = Vec::new();
                for t in ix.tracks.iter().filter(|t| hit(t)) {
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
                        let cover = first.filter(|t| ix.covers.contains_key(&t.album_key)).map(|t| format!("{}/lc/{}", base(), t.album_key));
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
    let file = with_index(&root, |ix| match kind {
        "lf" => ix.tracks.iter().find(|t| t.key == key).map(|t| t.path.clone()),
        "lc" => ix.covers.get(key).cloned(),
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
    fn scans_a_folder() {
        let root = std::env::temp_dir().join(format!("mh-music-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("Air/Moon Safari (1998)")).unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/01 - La Femme d'Argent.mp3"), b"x").unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/02 - Sexy Boy.mp3"), b"x").unwrap();
        std::fs::write(root.join("Air/Moon Safari (1998)/cover.jpg"), b"x").unwrap();
        let ix = scan(&root);
        assert_eq!(ix.tracks.len(), 2);
        assert_eq!(ix.tracks[0].artist, "Air");
        assert_eq!(ix.tracks[0].album, "Moon Safari");
        assert_eq!(ix.tracks[1].title, "Sexy Boy");
        assert_eq!(ix.covers.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
