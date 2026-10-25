//! "Add a show or movie": take a folder (or one file) from anywhere on this computer and put
//! it in the right library folder under its proper name. The renamer then names the files
//! inside, and Jellyfin is asked to scan.
//!
//! Safety: nothing is overwritten (a file that already exists at the target is skipped) and
//! nothing is deleted. "Move" is a plain rename on the same drive; across drives the files
//! are copied and the originals stay where they were.

use crate::error::{Error, Result};
use crate::fsops::safe_rel;
use crate::naming::{finalize_component, is_sidecar, is_video, parse_episode, parse_name, sanitize, split_ext};
use crate::state::AppState;
use serde::Serialize;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;

/// The folder or file picked in the dialog. The window only ever refers to "the picked one",
/// so it can never name an arbitrary path itself.
static PICKED: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    /// Path inside the picked folder (forward slashes), or the file name.
    rel: String,
    size: u64,
    video: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    name: String,
    is_folder: bool,
    files: Vec<ImportFile>,
    total_bytes: u64,
    /// Best guess from the names: "tv" when files carry episode numbers.
    kind: &'static str,
    title: String,
    year: Option<i32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDone {
    /// The new folder, relative to the library folder.
    folder: String,
    moved: usize,
    copied: usize,
    skipped: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    done: u64,
    total: u64,
    file: String,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::msg(format!("Background task failed: {e}")))?
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<ImportFile>, depth: usize) {
    if depth > 6 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('@') || name.starts_with('#') {
            continue;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            walk(base, &p, out, depth + 1);
        } else if ft.is_file() && (is_video(&name) || is_sidecar(&name)) {
            let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or(name.clone());
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ImportFile { rel, size, video: is_video(&name) });
        }
    }
}

/// Lists what would be added and guesses show/movie, title and year.
pub(crate) fn describe(path: &Path) -> Result<ImportSource> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let mut files = Vec::new();
    let is_folder = path.is_dir();
    if is_folder {
        walk(path, path, &mut files, 0);
    } else {
        let dir = path.parent().ok_or_else(|| Error::msg("That file cannot be used."))?;
        let stem = format!("{}.", split_ext(&name).0);
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n == name || (n.starts_with(&stem) && is_sidecar(&n)) {
                    let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                    files.push(ImportFile { rel: n.clone(), size, video: is_video(&n) });
                }
            }
        }
        files.sort_by(|a, b| a.rel.cmp(&b.rel));
    }
    if !files.iter().any(|f| f.video) {
        return Err(Error::msg("No videos found there."));
    }
    let episodes = files
        .iter()
        .filter(|f| f.video)
        .filter(|f| parse_episode(split_ext(f.rel.rsplit('/').next().unwrap_or(&f.rel)).0, None).is_some())
        .count();
    let videos = files.iter().filter(|f| f.video).count();
    let kind = if episodes > 0 && (episodes * 2 >= videos || videos > 3) { "tv" } else { "movie" };
    let source_name = if is_folder { name.clone() } else { split_ext(&name).0.to_string() };
    let parsed = parse_name(&source_name);
    let total_bytes = files.iter().map(|f| f.size).sum();
    Ok(ImportSource { name, is_folder, files, total_bytes, kind, title: parsed.title, year: parsed.year })
}

/// Opens the system picker for a folder (a show or a movie folder) or one video file.
#[tauri::command]
pub async fn import_pick(app: AppHandle, folder: bool) -> Result<Option<ImportSource>> {
    let picked = blocking(move || {
        let d = app.dialog().file();
        Ok(if folder { d.blocking_pick_folder() } else { d.add_filter("Video", &["mkv", "mp4", "m4v", "avi", "mov", "ts", "wmv", "webm"]).blocking_pick_file() })
    })
    .await?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|_| Error::msg("That cannot be used."))?;
    let info = blocking({
        let p = path.clone();
        move || describe(&p)
    })
    .await?;
    *PICKED.lock().map_err(|_| Error::msg("internal error"))? = Some(path);
    Ok(Some(info))
}

/// The folder name a show or movie gets: "Title (Year)".
pub fn folder_name(title: &str, year: Option<i32>) -> Result<String> {
    let t = sanitize(title.trim());
    if t.is_empty() {
        return Err(Error::msg("Give it a title first."));
    }
    Ok(finalize_component(&match year {
        Some(y) if (1880..=2100).contains(&y) => format!("{t} ({y})"),
        _ => t,
    }))
}

fn copy_with_progress(app: &AppHandle, from: &Path, to: &Path, done: &mut u64, total: u64, label: &str) -> Result<()> {
    let mut src = std::fs::File::open(from)?;
    // Write to a temporary name first, so a half copy never looks like a finished file.
    let tmp = to.with_extension(format!("{}.mediahub-part", to.extension().and_then(|e| e.to_str()).unwrap_or("")));
    let mut dst = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    let mut last = std::time::Instant::now();
    loop {
        let n = src.read(&mut buf)?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n])?;
        *done += n as u64;
        if last.elapsed().as_millis() > 300 {
            last = std::time::Instant::now();
            let _ = app.emit("import-progress", Progress { done: *done, total, file: label.to_string() });
        }
    }
    dst.flush()?;
    drop(dst);
    if to.exists() {
        let _ = std::fs::remove_file(&tmp); // our own partial file only
        return Err(Error::msg("already exists"));
    }
    std::fs::rename(&tmp, to)?;
    Ok(())
}

/// Puts the picked folder/file into `dest` (a folder inside the library, e.g. "TV") as
/// "<Title (Year)>". `mode` is "move" or "copy".
#[tauri::command]
pub async fn import_run(app: AppHandle, state: State<'_, AppState>, dest: String, title: String, year: Option<i32>, mode: String) -> Result<ImportDone> {
    let root = state.library_root()?;
    let src = PICKED.lock().map_err(|_| Error::msg("internal error"))?.clone().ok_or_else(|| Error::msg("Pick a folder or file first."))?;
    let dest_rel = safe_rel(&dest)?;
    let dest_dir = root.join(&dest_rel);
    if !dest_dir.is_dir() {
        return Err(Error::msg("That library folder does not exist."));
    }
    let name = folder_name(&title, year)?;
    let target = dest_dir.join(&name);
    // Refuse to import the library into itself.
    if let (Ok(s), Ok(r)) = (src.canonicalize(), root.canonicalize()) {
        if dest_dir.canonicalize().map(|d| d.starts_with(&s)).unwrap_or(false) {
            return Err(Error::msg("The target folder is inside what you are adding."));
        }
        if s == r {
            return Err(Error::msg("That is the whole library folder."));
        }
    }
    let move_files = mode == "move";
    let rel_folder = {
        let mut p = dest.trim_matches('/').to_string();
        if !p.is_empty() {
            p.push('/');
        }
        p.push_str(&name);
        p
    };
    let app2 = app.clone();
    blocking(move || {
        let info = describe(&src)?;
        let base = if info.is_folder { src.clone() } else { src.parent().map(Path::to_path_buf).unwrap_or_default() };
        std::fs::create_dir_all(&target)?;
        let total = info.total_bytes.max(1);
        let mut done = 0u64;
        let (mut moved, mut copied, mut skipped) = (0usize, 0usize, Vec::new());
        for f in &info.files {
            let rel = safe_rel(&f.rel)?;
            let from = base.join(&rel);
            let to = target.join(&rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if to.exists() {
                skipped.push(format!("{} (already there)", f.rel));
                done += f.size;
                continue;
            }
            let _ = app2.emit("import-progress", Progress { done, total, file: f.rel.clone() });
            if move_files && std::fs::rename(&from, &to).is_ok() {
                moved += 1;
                done += f.size;
                continue;
            }
            match copy_with_progress(&app2, &from, &to, &mut done, total, &f.rel) {
                Ok(()) => copied += 1,
                Err(e) => skipped.push(format!("{}: {e}", f.rel)),
            }
        }
        let _ = app2.emit("import-progress", Progress { done: total, total, file: String::new() });
        Ok(ImportDone { folder: rel_folder, moved, copied, skipped })
    })
    .await
}

/* ------------------------------------------------------------------ inbox */

/// Chooses the folder to watch for new downloads.
#[tauri::command]
pub async fn inbox_pick(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>> {
    let picked = blocking(move || Ok(app.dialog().file().blocking_pick_folder())).await?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|_| Error::msg("That folder cannot be used."))?;
    if !path.is_dir() {
        return Err(Error::msg("That is not a folder."));
    }
    let s = path.to_string_lossy().into_owned();
    let saved = s.clone();
    state.update_settings(move |st| st.inbox_dir = Some(saved))?;
    Ok(Some(s))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    name: String,
    source: ImportSource,
    modified: u64,
}

/// What's waiting in the inbox: each folder or video directly inside it.
#[tauri::command]
pub async fn inbox_list(state: State<'_, AppState>) -> Result<(Option<String>, Vec<InboxEntry>)> {
    let Some(dir) = state.settings()?.inbox_dir else { return Ok((None, Vec::new())) };
    let d2 = dir.clone();
    let list = blocking(move || {
        let mut out = Vec::new();
        let Ok(rd) = std::fs::read_dir(&d2) else { return Err(Error::msg("The inbox folder can't be read. Is the drive connected?")) };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.ends_with(".part") || name.ends_with(".mediahub-part") {
                continue;
            }
            let p = e.path();
            if !(p.is_dir() || is_video(&name)) {
                continue;
            }
            let modified = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
            if let Ok(source) = describe(&p) {
                out.push(InboxEntry { name, source, modified });
            }
        }
        out.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(out)
    })
    .await?;
    Ok((Some(dir), list))
}

/// Picks one inbox entry as the thing to add (like choosing it in the dialog).
#[tauri::command]
pub async fn inbox_select(state: State<'_, AppState>, name: String) -> Result<ImportSource> {
    let dir = state.settings()?.inbox_dir.ok_or_else(|| Error::msg("No inbox folder chosen."))?;
    if name.is_empty() || name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(Error::msg("bad name"));
    }
    let p = Path::new(&dir).join(&name);
    let info = blocking({
        let p = p.clone();
        move || describe(&p)
    })
    .await?;
    *PICKED.lock().map_err(|_| Error::msg("internal error"))? = Some(p);
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names() {
        assert_eq!(folder_name("Bluey", Some(2018)).unwrap(), "Bluey (2018)");
        assert_eq!(folder_name("  Bluey ", None).unwrap(), "Bluey");
        assert_eq!(folder_name("Mission: Impossible", Some(1996)).unwrap(), sanitize("Mission: Impossible") + " (1996)");
        assert!(folder_name("   ", Some(2000)).is_err());
        assert_eq!(folder_name("Old", Some(3000)).unwrap(), "Old");
    }

    #[test]
    fn describes_a_show_folder() {
        let dir = std::env::temp_dir().join(format!("mh-import-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let show = dir.join("bluey.2018.complete");
        std::fs::create_dir_all(show.join("s1")).unwrap();
        for n in ["s1/Bluey.S01E01.720p.mkv", "s1/Bluey.S01E02.720p.mkv", "s1/Bluey.S01E02.720p.en.srt", "s1/readme.txt"] {
            std::fs::write(show.join(n), b"x").unwrap();
        }
        let d = describe(&show).unwrap();
        assert_eq!(d.kind, "tv");
        assert_eq!(d.files.len(), 3, "videos and subtitles only");
        assert!(d.title.to_lowercase().contains("bluey"));
        assert_eq!(d.year, Some(2018));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
