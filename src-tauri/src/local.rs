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

/// Maps a server path to this computer, remembering what it learned.
pub fn to_local(state: &AppState, server: &str) -> Result<PathBuf> {
    let settings = state.settings()?;
    let root = settings.library_root.as_ref().map(PathBuf::from);
    let (p, map): (PathBuf, PathMap) = media_tools::map_path(server, settings.path_map.as_ref(), root.as_deref())
        .ok_or_else(|| {
            Error::msg(if root.is_none() {
                "Choose your library folder in Settings first, so Media Hub can find files on this computer."
            } else {
                "This item was not found in your library folder on this computer. Is the NAS connected?"
            })
        })?;
    if Some(&map) != settings.path_map.as_ref() {
        state.update_settings(|s| s.path_map = Some(map))?;
    }
    Ok(p)
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
    let server = server_path(&state, &id).await?;
    let local = to_local(&state, &server)?;
    show_in_file_manager(&local);
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
    let server = server_path(&state, &id).await?;
    let local = to_local(&state, &server)?;
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
    fn relative_paths_use_forward_slashes() {
        let root = Path::new("/Volumes/media");
        assert_eq!(rel_to_root(root, Path::new("/Volumes/media/TV/Bluey")).as_deref(), Some("TV/Bluey"));
        assert_eq!(rel_to_root(root, Path::new("/Volumes/media")).as_deref(), Some(""));
        assert_eq!(rel_to_root(root, Path::new("/Volumes/other/x")), None);
    }
}
