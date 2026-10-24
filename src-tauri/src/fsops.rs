//! The only code that changes files on disk. Rules it follows:
//! - every path stays inside the chosen library root (checked after resolving links);
//! - nothing is ever overwritten or deleted (only empty folders may be removed, on request);
//! - each move is written to the undo journal before it happens.

use crate::error::{Error, Result};
use crate::planner::PlanOp;
use crate::store::Store;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_FILES: usize = 100_000;
const MAX_DEPTH: usize = 8;

/// Folders that NAS systems and operating systems create and that must never be touched.
fn skip_name(name: &str) -> bool {
    name.starts_with('.')
        || name.starts_with('@') // Synology @eaDir
        || name.starts_with('#') // #recycle
        || name.eq_ignore_ascii_case("$RECYCLE.BIN")
        || name.eq_ignore_ascii_case("System Volume Information")
}

/// Turns "a/b/c" into a path, refusing anything that could step outside the root.
pub fn safe_rel(rel: &str) -> Result<PathBuf> {
    let mut p = PathBuf::new();
    for part in rel.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." || part.contains('\\') || part.contains(':') {
            return Err(Error::msg(format!("Unsafe path: {rel}")));
        }
        p.push(part);
    }
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(Error::msg(format!("Unsafe path: {rel}")));
    }
    Ok(p)
}

fn inside(root_canon: &Path, p: &Path) -> Result<()> {
    let c = p.canonicalize()?;
    if c.starts_with(root_canon) {
        Ok(())
    } else {
        Err(Error::msg("A path leads outside the library folder; stopped for safety."))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    pub name: String,
}

/// Lists the folders directly inside `rel` (e.g. one folder per show).
pub fn list_folders(root: &Path, rel: &str) -> Result<Vec<FolderInfo>> {
    let dir = root.join(safe_rel(rel)?);
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().into_string() else { continue };
        if skip_name(&name) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            out.push(FolderInfo { name });
        }
    }
    out.sort_by_key(|f| f.name.to_lowercase());
    Ok(out)
}

/// All files under `rel`, as paths relative to the root. Does not follow links.
/// With `recursive` false only the files directly in the folder are listed.
pub fn scan_files(root: &Path, rel: &str, recursive: bool) -> Result<Vec<String>> {
    let base = safe_rel(rel)?;
    let mut out = Vec::new();
    let mut stack = vec![(base, 0usize)];
    while let Some((dir_rel, depth)) = stack.pop() {
        for entry in fs::read_dir(root.join(&dir_rel))? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else { continue }; // skip names that are not valid text
            if skip_name(&name) {
                continue;
            }
            let ft = entry.file_type()?;
            let child = dir_rel.join(&name);
            if ft.is_dir() && recursive && depth < MAX_DEPTH {
                stack.push((child, depth + 1));
            } else if ft.is_file() {
                let rel_str = child
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push(rel_str);
                if out.len() > MAX_FILES {
                    return Err(Error::msg("That folder has too many files. Pick a smaller folder."));
                }
            }
        }
    }
    out.sort();
    Ok(out)
}

pub fn exists(root: &Path, rel: &str) -> bool {
    safe_rel(rel)
        .map(|p| fs::symlink_metadata(root.join(p)).is_ok())
        .unwrap_or(false)
}

fn move_one(root: &Path, root_canon: &Path, from_rel: &str, to_rel: &str) -> Result<()> {
    let from = root.join(safe_rel(from_rel)?);
    let to = root.join(safe_rel(to_rel)?);
    let md = fs::symlink_metadata(&from).map_err(|_| Error::msg("It is no longer there."))?;
    // Regular files and folders only; links are never followed or moved.
    if !(md.is_file() || md.is_dir()) || md.file_type().is_symlink() {
        return Err(Error::msg("Not a regular file or folder."));
    }
    if let Some(parent) = from.parent() {
        inside(root_canon, parent)?;
    }
    let parent = to.parent().ok_or_else(|| Error::msg("Bad target."))?;
    fs::create_dir_all(parent)?;
    inside(root_canon, parent)?;

    let case_only = from_rel != to_rel && from_rel.to_lowercase() == to_rel.to_lowercase();
    if case_only {
        // Mac and Windows treat "a.mkv" and "A.mkv" as the same file: go through a temporary name.
        let tmp = from.with_file_name(format!(".mediahub-tmp-{}", std::process::id()));
        if fs::symlink_metadata(&tmp).is_ok() {
            return Err(Error::msg("A temporary file is in the way."));
        }
        fs::rename(&from, &tmp)?;
        if let Err(e) = fs::rename(&tmp, &to) {
            let _ = fs::rename(&tmp, &from);
            return Err(e.into());
        }
        return Ok(());
    }
    if fs::symlink_metadata(&to).is_ok() {
        return Err(Error::msg("Something with the new name already exists; skipped."));
    }
    fs::rename(&from, &to)?;
    Ok(())
}

/// Removes now-empty folders left behind, walking up but never past the root.
/// `remove_dir` only succeeds on empty folders, so files can never be lost here.
fn remove_empty_parents(root: &Path, rel_file: &str) {
    let Ok(p) = safe_rel(rel_file) else { return };
    let mut dir = p.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d.as_os_str().is_empty() {
            break;
        }
        if fs::remove_dir(root.join(&d)).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyReport {
    pub batch: String,
    pub done: usize,
    pub failed: Vec<String>,
}

pub fn apply(root: &Path, ops: &[PlanOp], store: &Store, batch: &str, remove_empty: bool) -> Result<ApplyReport> {
    let root_canon = root.canonicalize().map_err(|_| Error::msg("The library folder cannot be reached. Is the share mounted?"))?;
    let root_str = root.to_string_lossy().into_owned();
    let mut done = 0;
    let mut failed = Vec::new();
    // In the given order: files first, then season folders, then the show folder.
    for op in ops.iter().filter(|o| o.status == "ok") {
        let target = if op.step_to.is_empty() { &op.to } else { &op.step_to };
        let id = store.journal_begin(batch, &root_str, &op.from, target)?;
        match move_one(root, &root_canon, &op.from, target) {
            Ok(()) => {
                store.journal_set_state(id, "done")?;
                done += 1;
                if remove_empty && op.kind != "folder" {
                    remove_empty_parents(root, &op.from);
                }
            }
            Err(e) => {
                store.journal_delete(id)?;
                failed.push(format!("{}: {e}", op.from));
            }
        }
    }
    Ok(ApplyReport { batch: batch.to_string(), done, failed })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub restored: usize,
    pub skipped: Vec<String>,
}

/// Moves every file of a batch back, newest first. Skips a file when its old name is
/// taken again or the file was moved away since.
pub fn undo(store: &Store, batch: &str) -> Result<UndoReport> {
    let mut restored = 0;
    let mut skipped = Vec::new();
    for e in store.journal_entries(batch)? {
        if e.undone {
            continue;
        }
        let root = PathBuf::from(&e.root);
        let root_canon = match root.canonicalize() {
            Ok(c) => c,
            Err(_) => {
                skipped.push(format!("{}: library folder not reachable", e.to));
                continue;
            }
        };
        match move_one(&root, &root_canon, &e.to, &e.from) {
            Ok(()) => {
                store.journal_mark_undone(e.id)?;
                restored += 1;
            }
            Err(err) => skipped.push(format!("{}: {err}", e.to)),
        }
    }
    Ok(UndoReport { restored, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mediahub-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn op(from: &str, to: &str) -> PlanOp {
        PlanOp {
            from: from.into(),
            to: to.into(),
            kind: "video",
            status: "ok",
            note: None,
            season: None,
            episodes: vec![],
            verified: true,
            score: None,
            step_to: to.into(),
            title: None,
        }
    }

    #[test]
    fn unsafe_paths_are_refused() {
        assert!(safe_rel("../x").is_err());
        assert!(safe_rel("a/../../x").is_err());
        assert!(safe_rel("C:/x").is_err());
        assert!(safe_rel("a\\..\\x").is_err());
        assert!(safe_rel("a/b/c.mkv").is_ok());
    }

    #[test]
    fn scan_skips_hidden_and_nas_folders() {
        let r = temp_root("scan");
        fs::create_dir_all(r.join("Show/Season 1")).unwrap();
        fs::create_dir_all(r.join("Show/@eaDir")).unwrap();
        fs::create_dir_all(r.join("Show/.hub")).unwrap();
        fs::write(r.join("Show/Season 1/a.mkv"), b"x").unwrap();
        fs::write(r.join("Show/@eaDir/b.mkv"), b"x").unwrap();
        fs::write(r.join("Show/.hub/c.jpg"), b"x").unwrap();
        fs::write(r.join("Show/.DS_Store"), b"x").unwrap();
        assert_eq!(scan_files(&r, "Show", true).unwrap(), vec!["Show/Season 1/a.mkv".to_string()]);
        assert_eq!(list_folders(&r, "").unwrap().len(), 1);
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn apply_then_undo_restores_everything() {
        let r = temp_root("apply");
        fs::create_dir_all(r.join("Show/Season 1")).unwrap();
        fs::write(r.join("Show/Season 1/a.mkv"), b"video").unwrap();
        fs::write(r.join("Show/Season 1/a.en.srt"), b"subs").unwrap();
        fs::write(r.join("Show/keep.mkv"), b"keep").unwrap();
        fs::write(r.join("Show/other.mkv"), b"other").unwrap();
        let store = Store::in_memory().unwrap();
        let ops = vec![
            op("Show/Season 1/a.mkv", "Show/Season 01/Show - S01E01.mkv"),
            op("Show/Season 1/a.en.srt", "Show/Season 01/Show - S01E01.en.srt"),
            op("Show/missing.mkv", "Show/x.mkv"),
            op("Show/other.mkv", "Show/keep.mkv"),
        ];
        let rep = apply(&r, &ops, &store, "b1", true).unwrap();
        assert_eq!(rep.done, 2);
        assert_eq!(rep.failed.len(), 2);
        assert_eq!(fs::read(r.join("Show/Season 01/Show - S01E01.mkv")).unwrap(), b"video");
        assert!(!r.join("Show/Season 1").exists(), "empty folder should be removed");
        assert_eq!(fs::read(r.join("Show/keep.mkv")).unwrap(), b"keep", "never overwrite");

        let u = undo(&store, "b1").unwrap();
        assert_eq!(u.restored, 2);
        assert_eq!(fs::read(r.join("Show/Season 1/a.mkv")).unwrap(), b"video");
        assert_eq!(fs::read(r.join("Show/Season 1/a.en.srt")).unwrap(), b"subs");
        // Undoing twice does nothing.
        assert_eq!(undo(&store, "b1").unwrap().restored, 0);
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn folders_are_renamed_after_their_files_and_undo_reverses_it() {
        let r = temp_root("dirs");
        fs::create_dir_all(r.join("Bluey/Season 1")).unwrap();
        fs::write(r.join("Bluey/Season 1/a.mkv"), b"v").unwrap();
        fs::write(r.join("Bluey/poster.jpg"), b"p").unwrap();
        let store = Store::in_memory().unwrap();
        let mut folder = op("Bluey/Season 1", "Bluey/Season 01");
        folder.kind = "folder";
        let mut show = op("Bluey", "Bluey (2018)");
        show.kind = "folder";
        let file = PlanOp { step_to: "Bluey/Season 1/Bluey - S01E01.mkv".into(), ..op("Bluey/Season 1/a.mkv", "Bluey (2018)/Season 01/Bluey - S01E01.mkv") };
        let rep = apply(&r, &[file, folder, show], &store, "b", true).unwrap();
        assert_eq!(rep.done, 3, "{:?}", rep.failed);
        assert_eq!(fs::read(r.join("Bluey (2018)/Season 01/Bluey - S01E01.mkv")).unwrap(), b"v");
        assert_eq!(fs::read(r.join("Bluey (2018)/poster.jpg")).unwrap(), b"p", "other files move with the folder");
        assert_eq!(undo(&store, "b").unwrap().restored, 3);
        assert_eq!(fs::read(r.join("Bluey/Season 1/a.mkv")).unwrap(), b"v");
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn case_only_rename_works() {
        let r = temp_root("case");
        fs::write(r.join("show.mkv"), b"v").unwrap();
        let store = Store::in_memory().unwrap();
        let rep = apply(&r, &[op("show.mkv", "Show.mkv")], &store, "b", false).unwrap();
        assert_eq!(rep.done, 1, "{:?}", rep.failed);
        let names: Vec<_> = fs::read_dir(&r).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(names, vec!["Show.mkv".to_string()]);
        fs::remove_dir_all(&r).unwrap();
    }
}
