//! Where an item lives on this computer: open it in Finder / Explorer, and find its folder
//! inside the library folder (for the renamer). Uses the same server-to-local path mapping
//! as intro detection, learned automatically.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::media_tools::{self, PathMap};
use crate::state::AppState;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

/// Where an item is on this computer: from the saved path first, else Jellyfin's current one.
pub async fn locate(state: &AppState, id: &str) -> Result<PathBuf> {
    let first = server_path(state, id).await?;
    match to_local(state, &first) {
        Ok(p) => Ok(p),
        Err(e) => {
            let fresh = state.reader().await?.item_json(id).await.ok().and_then(|v| v.get("Path").and_then(Value::as_str).map(String::from));
            match fresh.filter(|f| *f != first) {
                Some(f) => to_local(state, &f),
                None => Err(e),
            }
        }
    }
}

/// Where a file is now after the renames Media Hub made (oldest first), for when Jellyfin
/// hasn't looked yet and still gives the old place. None when no rename touched it.
pub fn follow_renames(rel: &str, newest_first: &[(i64, String, String)]) -> Option<String> {
    let mut cur = rel.to_string();
    for (_, from, to) in newest_first.iter().rev() {
        if cur == *from {
            cur = to.clone();
        } else if let Some(rest) = cur.strip_prefix(&format!("{from}/")) {
            cur = format!("{to}/{rest}");
        }
    }
    (cur != rel).then_some(cur)
}

/// `to_local` for a long list at once: 16 lookups at a time, because each one may wait on the
/// NAS (slow over a VPN). Same order as the list; None where it isn't found.
pub fn to_local_many(state: &AppState, servers: &[&str]) -> Vec<Option<PathBuf>> {
    let mut out: Vec<Option<PathBuf>> = vec![None; servers.len()];
    let next = std::sync::atomic::AtomicUsize::new(0);
    let found = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..16.min(servers.len().max(1)) {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(server) = servers.get(i) else { break };
                if let Ok(p) = to_local(state, server) {
                    if let Ok(mut f) = found.lock() {
                        f.push((i, p));
                    }
                }
            });
        }
    });
    for (i, p) in found.into_inner().unwrap_or_default() {
        out[i] = Some(p);
    }
    out
}

/// The server path of an item (the folder for a show, the file for a movie or episode).
async fn server_path(state: &AppState, id: &str) -> Result<String> {
    if !valid_item_id(id) {
        return Err(Error::msg("bad id"));
    }
    if let Some(p) = state.store()?.path_of(id)? {
        return Ok(p);
    }
    let item = state.reader().await?.item_json(id).await?;
    item.get("Path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .ok_or_else(|| Error::msg("Jellyfin has no file location for this item."))
}

/// Maps a server path to this computer, remembering what it learned. When the exact path isn't
/// there any more (renamed by Media Hub, the Inbox or by hand, and Jellyfin hasn't scanned yet),
/// the same title is looked for step by step: "Severance" → "Severance (2022)", "Season 7" →
/// "Season 07", an episode by its SxxEyy, a movie by its title and year.
pub fn to_local(state: &AppState, server: &str) -> Result<PathBuf> {
    let settings = state.settings()?;
    let root = settings.library_root.as_ref().map(PathBuf::from);
    if let Some((p, map)) = media_tools::map_path(server, settings.path_map.as_ref(), root.as_deref()) {
        if Some(&map) != settings.path_map.as_ref() {
            state.update_settings(|s| s.path_map = Some(map))?;
        }
        return Ok(p);
    }
    let Some(root) = root else {
        return Err(Error::msg("Choose your library folder in Settings first, so Media Hub can find files on this computer."));
    };
    if let Some(why) = crate::state::root_problem(&root.to_string_lossy()) {
        return Err(Error::msg(why));
    }
    if let Some(p) = find_renamed(&root, settings.path_map.as_ref(), server) {
        return Ok(p);
    }
    Err(Error::msg("This isn't in your library folder under the name Jellyfin knows. It was probably renamed or moved: refresh the Library (Jellyfin then reads the folder again) and try once more."))
}

/// The name a folder or file is compared by: no year, tags, punctuation or accents; an episode
/// by its season and episode number; a season folder by its number.
fn match_key(name: &str, is_dir: bool) -> String {
    use crate::naming::{fold_accents, parse_episode, parse_name, season_from_dir, split_ext};
    if is_dir {
        if let Some(n) = season_from_dir(name) {
            return format!("season:{n}");
        }
    } else {
        let (stem, ext) = split_ext(name);
        if let Some(m) = parse_episode(stem, None) {
            return format!("ep:{}:{:?}:{}", m.season, m.episodes, ext.to_lowercase());
        }
    }
    let base = if is_dir { name } else { crate::naming::split_ext(name).0 };
    let p = parse_name(base);
    let title = if p.title.is_empty() { base.to_string() } else { p.title };
    let t: String = fold_accents(&title.to_lowercase()).chars().filter(|c| c.is_alphanumeric()).collect();
    let ext = if is_dir { String::new() } else { crate::naming::split_ext(name).1.to_lowercase() };
    format!("{t}:{}:{ext}", p.year.map(|y| y.to_string()).unwrap_or_default())
}

/// Same title, allowing a year on one side only.
fn same_key(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (pa, pb): (Vec<&str>, Vec<&str>) = (a.split(':').collect(), b.split(':').collect());
    pa.len() == 3 && pb.len() == 3 && !pa[0].is_empty() && pa[0] == pb[0] && pa[2] == pb[2] && (pa[1].is_empty() || pb[1].is_empty())
}

/// Walks the server path's parts from the library folder, taking the exact name when it's there
/// and otherwise the one entry with the same title (never a guess between two).
pub fn find_renamed(root: &Path, map: Option<&PathMap>, server: &str) -> Option<PathBuf> {
    let parts: Vec<String> = server.split(['/', '\\']).filter(|p| !p.is_empty()).map(String::from).collect();
    if parts.is_empty() {
        return None;
    }
    // Where the library folder starts in the server path: after the known prefix, else try each.
    let mut starts: Vec<usize> = Vec::new();
    if let Some(m) = map {
        let n = m.server.split(['/', '\\']).filter(|p| !p.is_empty()).count();
        if server.starts_with(m.server.as_str()) {
            starts.push(n);
        }
    }
    starts.extend(0..parts.len());
    for start in starts {
        if start >= parts.len() {
            continue;
        }
        let rest = &parts[start..];
        // The first part has to exist as it is (a main folder like "TV"): otherwise any suffix
        // would match somewhere.
        if !root.join(&rest[0]).exists() {
            continue;
        }
        let mut cur = root.join(&rest[0]);
        let mut fuzzy = 0;
        let mut ok = true;
        for (i, part) in rest.iter().enumerate().skip(1) {
            let exact = cur.join(part);
            if exact.exists() {
                cur = exact;
                continue;
            }
            let last = i == rest.len() - 1;
            let want = match_key(part, !last || !part.contains('.'));
            let Ok(rd) = std::fs::read_dir(&cur) else { ok = false; break };
            let hits: Vec<PathBuf> = rd
                .flatten()
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    !n.starts_with('.') && same_key(&match_key(&n, e.path().is_dir()), &want)
                })
                .map(|e| e.path())
                .collect();
            if hits.len() != 1 {
                ok = false;
                break;
            }
            fuzzy += 1;
            cur = hits[0].clone();
        }
        if ok && fuzzy > 0 && fuzzy <= 3 && cur.exists() {
            return Some(cur);
        }
    }
    None
}

/// Path relative to the library folder, with "/" separators (what the renamer uses).
pub fn rel_to_root(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    Some(parts.join("/"))
}

/// A folder opens with its contents shown; a file opens its folder with the file selected.
pub fn show_in_file_manager(p: &Path) {
    let is_dir = p.is_dir();
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        if !is_dir {
            c.arg("-R");
        }
        let _ = c.arg(p).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let s = p.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&*s).to_string();
        let _ = if is_dir {
            Command::new("explorer").raw_arg(format!("\"{s}\"")).spawn()
        } else {
            Command::new("explorer").raw_arg(format!("/select,\"{s}\"")).spawn()
        };
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(if is_dir { p } else { p.parent().unwrap_or(p) }).spawn();
    }
}

/// Shows the item's file (or folder) in Finder / Explorer.
#[tauri::command]
pub async fn reveal_item(state: State<'_, AppState>, id: String) -> Result<()> {
    let local = locate(&state, &id).await?;
    show_in_file_manager(&local);
    Ok(())
}

/// Opens a title's video in the computer's own player (QuickTime, IINA, VLC …). Videos only.
#[tauri::command]
pub async fn open_video(state: State<'_, AppState>, id: String) -> Result<()> {
    let local = locate(&state, &id).await?;
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !local.is_file() || !crate::naming::is_video(&name) {
        return Err(Error::msg("There's no single video file to open for this (open the folder instead)."));
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(&local).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let s = local.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&*s).to_string();
        let _ = Command::new("explorer").raw_arg(format!("\"{s}\"")).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(&local).spawn();
    }
    Ok(())
}

/// Shows a folder inside the library folder (renamer rows).
#[tauri::command]
pub fn reveal_rel(state: State<'_, AppState>, rel: String) -> Result<()> {
    let root = state.library_root()?;
    crate::fsops::safe_rel(&rel)?;
    let p = if rel.is_empty() { root.clone() } else { root.join(&rel) };
    let p = p.canonicalize().map_err(|_| Error::msg("That folder is no longer there."))?;
    if !p.starts_with(root.canonicalize().unwrap_or(root)) {
        return Err(Error::msg("Only folders inside the library folder can be shown."));
    }
    show_in_file_manager(&p);
    Ok(())
}

/// The folder to rename for an item: the show folder, or the movie's folder (or its file's
/// folder for a loose movie). Relative to the library folder.
#[tauri::command]
pub async fn item_folder(state: State<'_, AppState>, id: String) -> Result<String> {
    let local = locate(&state, &id).await?;
    let folder = if local.is_dir() { local } else { local.parent().map(Path::to_path_buf).unwrap_or(local) };
    let root = state.library_root()?;
    rel_to_root(&root, &folder).ok_or_else(|| Error::msg("This item is outside your library folder."))
}

/// Asks Jellyfin to look for new and renamed files.
#[tauri::command]
pub async fn library_scan(state: State<'_, AppState>) -> Result<()> {
    state.reader().await?.library_scan().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_moved_file_is_followed() {
        let moves = vec![
            (3, "Movies/Heat (1995)/Heat.mkv".to_string(), "Movies/Heat (1995)/Heat (1995).mkv".to_string()),
            (2, "Movies/Heat".to_string(), "Movies/Heat (1995)".to_string()),
        ];
        assert_eq!(follow_renames("Movies/Heat/Heat.mkv", &moves).as_deref(), Some("Movies/Heat (1995)/Heat (1995).mkv"));
        assert_eq!(follow_renames("Movies/Dune/Dune.mkv", &moves), None);
    }

    #[test]
    fn relative_paths_use_forward_slashes() {
        let root = Path::new("/Volumes/media");
        assert_eq!(rel_to_root(root, Path::new("/Volumes/media/TV/Bluey")).as_deref(), Some("TV/Bluey"));
        assert_eq!(rel_to_root(root, Path::new("/Volumes/media")).as_deref(), Some(""));
        assert_eq!(rel_to_root(root, Path::new("/Volumes/other/x")), None);
    }

    #[test]
    fn finds_titles_that_were_renamed_since_jellyfin_last_looked() {
        let root = std::env::temp_dir().join(format!("mh-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("TV/Severance (2022)/Season 02")).unwrap();
        std::fs::write(root.join("TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.mkv"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Movies/Heat (1995)")).unwrap();
        std::fs::write(root.join("Movies/Heat (1995)/Heat (1995).mkv"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Movies/Dune (1984)")).unwrap();
        std::fs::create_dir_all(root.join("Movies/Dune (2021)")).unwrap();
        let map = PathMap { server: "/volume1/media".into(), local: root.to_string_lossy().into_owned() };
        // Show folder got its year, the season folder two digits, the file a title.
        let ep = find_renamed(&root, Some(&map), "/volume1/media/TV/Severance/Season 2/Severance (2022) - S02E05.mkv");
        assert_eq!(ep, Some(root.join("TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.mkv")));
        // Without a map too.
        let mv = find_renamed(&root, None, "/data/Movies/Heat.1995.1080p.BluRay/Heat.1995.1080p.BluRay.mkv");
        assert_eq!(mv, Some(root.join("Movies/Heat (1995)/Heat (1995).mkv")));
        // Two candidates: no guess.
        assert_eq!(find_renamed(&root, Some(&map), "/volume1/media/Movies/Dune/Dune.mkv"), None);
        // Something that isn't there at all.
        assert_eq!(find_renamed(&root, Some(&map), "/volume1/media/TV/Bluey/Season 01/Bluey - S01E01.mkv"), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
