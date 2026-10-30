//! The only code that changes files on disk. Rules it follows:
//! - every path stays inside the chosen library root (checked after resolving links);
//! - nothing is ever overwritten or deleted (only empty folders may be removed, on request);
//! - each move is written to the undo journal before it happens.

use crate::error::{Error, Result};
use crate::planner::PlanOp;
use crate::store::{JournalEntry, Store};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

/// How long one rename on the share may take before Media Hub gives up waiting. A rename
/// is a single quick step on a healthy share; this only triggers when the NAS hangs.
const STEP_TIMEOUT: Duration = Duration::from_secs(60);
const NAS_STUCK: &str = "The library folder stopped answering (NAS asleep or network problem). Stopped here; everything done so far is kept and can be undone.";

/// Where renames are written down. Implemented by the database directly (tests) and by
/// the app state, which locks the database only for each single write, so the rest of the
/// app keeps working while a long batch runs.
pub trait Journal {
    fn begin(&self, batch: &str, root: &str, from: &str, to: &str) -> Result<i64>;
    fn set_state(&self, id: i64, state: &str) -> Result<()>;
    fn delete(&self, id: i64) -> Result<()>;
    fn entries(&self, batch: &str) -> Result<Vec<JournalEntry>>;
    fn mark_undone(&self, id: i64) -> Result<()>;
    fn pending(&self) -> Result<Vec<JournalEntry>>;
}

impl Journal for Store {
    fn begin(&self, batch: &str, root: &str, from: &str, to: &str) -> Result<i64> {
        self.journal_begin(batch, root, from, to)
    }
    fn set_state(&self, id: i64, state: &str) -> Result<()> {
        self.journal_set_state(id, state)
    }
    fn delete(&self, id: i64) -> Result<()> {
        self.journal_delete(id)
    }
    fn entries(&self, batch: &str) -> Result<Vec<JournalEntry>> {
        self.journal_entries(batch)
    }
    fn mark_undone(&self, id: i64) -> Result<()> {
        self.journal_mark_undone(id)
    }
    fn pending(&self) -> Result<Vec<JournalEntry>> {
        self.journal_pending()
    }
}

/// Runs a file-system step on its own thread and waits at most `limit` for it. A share
/// that stops answering can block a call for minutes; this keeps the app responsive.
pub fn with_timeout<T: Send + 'static>(limit: Duration, f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(limit).unwrap_or_else(|_| Err(Error::msg(NAS_STUCK)))
}

/// One finished step, for live progress ("renamed", turns green).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub index: usize,
    pub total: usize,
    pub from: String,
    pub to: String,
    /// "working" | "done" | "failed"
    pub state: &'static str,
    pub error: Option<String>,
}

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
    /// The batch ended early (stopped, or the share stopped answering).
    pub stopped: bool,
}

/// Pause between moves, and a longer one every few, so a network share keeps up.
const PACE_STEP: Duration = Duration::from_millis(if cfg!(test) { 0 } else { 60 });
const PACE_REST: Duration = Duration::from_millis(if cfg!(test) { 0 } else { 1200 });
const PACE_EVERY: usize = 20;

fn reach_root(root: &Path) -> Result<PathBuf> {
    let r = root.to_path_buf();
    with_timeout(Duration::from_secs(15), move || {
        r.canonicalize().map_err(|_| Error::msg("The library folder cannot be reached. Is the share mounted?"))
    })
}

fn move_with_timeout(root: &Path, root_canon: &Path, from: &str, to: &str) -> Result<()> {
    let (r, rc, f, t) = (root.to_path_buf(), root_canon.to_path_buf(), from.to_string(), to.to_string());
    with_timeout(STEP_TIMEOUT, move || move_one(&r, &rc, &f, &t))
}

pub fn apply(root: &Path, ops: &[PlanOp], journal: &dyn Journal, batch: &str, remove_empty: bool) -> Result<ApplyReport> {
    apply_with(root, ops, journal, batch, remove_empty, &|_| false, &|_| {})
}

/// Renames step by step. `stop` is asked before every step; `progress` hears about each one.
pub fn apply_with(
    root: &Path,
    ops: &[PlanOp],
    journal: &dyn Journal,
    batch: &str,
    remove_empty: bool,
    stop: &dyn Fn(usize) -> bool,
    progress: &dyn Fn(Step),
) -> Result<ApplyReport> {
    let root_canon = reach_root(root)?;
    let root_str = root.to_string_lossy().into_owned();
    let mut done = 0;
    let mut failed = Vec::new();
    let mut stopped = false;
    let todo: Vec<&PlanOp> = ops.iter().filter(|o| o.status == "ok").collect();
    let total = todo.len();
    // Folders left empty are tidied once at the end (not after every file).
    let mut emptied: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    // In the given order: files first, then season folders, then the show folder.
    for (index, op) in todo.into_iter().enumerate() {
        if stop(index) {
            stopped = true;
            break;
        }
        // Give the share room to breathe: a network drive (and Finder, which shares its
        // connection) chokes on hundreds of moves in a row.
        if index > 0 {
            std::thread::sleep(if index % PACE_EVERY == 0 { PACE_REST } else { PACE_STEP });
        }
        let target = if op.step_to.is_empty() { &op.to } else { &op.step_to };
        let step = |state, error| Step { index, total, from: op.from.clone(), to: target.clone(), state, error };
        progress(step("working", None));
        let id = journal.begin(batch, &root_str, &op.from, target)?;
        match move_with_timeout(root, &root_canon, &op.from, target) {
            Ok(()) => {
                journal.set_state(id, "done")?;
                done += 1;
                progress(step("done", None));
                // The folder it came from may be empty now (also after moving a whole folder).
                if remove_empty {
                    if let Some((dir, _)) = op.from.rsplit_once('/') {
                        emptied.insert(dir.to_string());
                    }
                }
            }
            Err(e) => {
                let stuck = e.to_string() == NAS_STUCK;
                // When the share hung, the move may still finish later: keep the entry
                // "pending" so the next start can check what really happened.
                if !stuck {
                    journal.delete(id)?;
                }
                progress(step("failed", Some(e.to_string())));
                failed.push(format!("{}: {e}", op.from));
                if stuck {
                    stopped = true;
                    break;
                }
            }
        }
    }
    if !emptied.is_empty() {
        // One folder at a time, deepest first; each check only removes a folder that is empty.
        let mut dirs: Vec<String> = emptied.into_iter().map(|d| format!("{d}/x")).collect();
        dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
        let r = root.to_path_buf();
        let _ = with_timeout(Duration::from_secs(30), move || {
            for d in &dirs {
                remove_empty_parents(&r, d);
            }
            Ok(())
        });
    }
    Ok(ApplyReport { batch: batch.to_string(), done, failed, stopped })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoReport {
    pub restored: usize,
    pub skipped: Vec<String>,
}

/// Moves every file of a batch back, newest first. Skips a file when its old name is
/// taken again or the file was moved away since.
pub fn undo(journal: &dyn Journal, batch: &str) -> Result<UndoReport> {
    let mut restored = 0;
    let mut skipped = Vec::new();
    for e in journal.entries(batch)? {
        if e.undone {
            continue;
        }
        let root = PathBuf::from(&e.root);
        let root_canon = match reach_root(&root) {
            Ok(c) => c,
            Err(_) => {
                skipped.push(format!("{}: library folder not reachable", e.to));
                continue;
            }
        };
        match move_with_timeout(&root, &root_canon, &e.to, &e.from) {
            Ok(()) => {
                journal.mark_undone(e.id)?;
                restored += 1;
            }
            Err(err) => {
                let stuck = err.to_string() == NAS_STUCK;
                skipped.push(format!("{}: {err}", e.to));
                if stuck {
                    break;
                }
            }
        }
    }
    Ok(UndoReport { restored, skipped })
}

/// Is there an entry with exactly this name (also on Mac/Windows, where "a" and "A" match)?
fn exact_exists(p: &Path) -> bool {
    let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { return false };
    fs::read_dir(parent)
        .map(|rd| rd.flatten().any(|e| e.file_name() == name))
        .unwrap_or(false)
}

/// After the app was closed in the middle of renaming: looks at every rename that was
/// started but not confirmed, checks the disk, and makes the journal match it. A file left
/// under a temporary name (a case-only rename) is put back under its old name.
/// Returns how many entries were sorted out. Does nothing for shares that are not mounted.
pub fn recover(journal: &dyn Journal) -> Result<usize> {
    let mut fixed = 0;
    for e in journal.pending()? {
        let root = PathBuf::from(&e.root);
        let r2 = root.clone();
        let reachable = with_timeout(Duration::from_secs(15), move || Ok(r2.is_dir())).unwrap_or(false);
        if !reachable {
            continue;
        }
        let (Ok(from_rel), Ok(to_rel)) = (safe_rel(&e.from), safe_rel(&e.to)) else { continue };
        let (from, to) = (root.join(from_rel), root.join(to_rel));
        let (f2, t2) = (from.clone(), to.clone());
        let Ok((has_from, has_to)) = with_timeout(Duration::from_secs(15), move || Ok((exact_exists(&f2), exact_exists(&t2)))) else { continue };
        if has_to && !has_from {
            journal.set_state(e.id, "done")?;
            fixed += 1;
        } else if has_from && !has_to {
            journal.delete(e.id)?; // never happened
            fixed += 1;
        } else if !has_from && !has_to {
            // A case-only rename stopped halfway: the file waits under a temporary name.
            let Some(dir) = from.parent() else { continue };
            let tmps: Vec<PathBuf> = fs::read_dir(dir)
                .map(|rd| rd.flatten().filter(|x| x.file_name().to_string_lossy().starts_with(".mediahub-tmp-")).map(|x| x.path()).collect())
                .unwrap_or_default();
            if tmps.len() == 1 && fs::rename(&tmps[0], &from).is_ok() {
                journal.delete(e.id)?;
                fixed += 1;
            }
        }
    }
    Ok(fixed)
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
    fn recovery_matches_the_journal_to_the_disk() {
        let r = temp_root("recover");
        fs::write(r.join("moved.mkv"), b"v").unwrap();
        fs::write(r.join("stayed.mkv"), b"v").unwrap();
        fs::write(r.join(".mediahub-tmp-42"), b"t").unwrap();
        let store = Store::in_memory().unwrap();
        let root = r.to_string_lossy().into_owned();
        let a = store.journal_begin("b", &root, "old.mkv", "moved.mkv").unwrap();
        let b = store.journal_begin("b", &root, "stayed.mkv", "new.mkv").unwrap();
        let _c = store.journal_begin("b", &root, "half.mkv", "Half.mkv").unwrap();
        assert_eq!(recover(&store).unwrap(), 3);
        assert!(store.journal_pending().unwrap().is_empty());
        let left: Vec<i64> = store.journal_entries("b").unwrap().iter().map(|e| e.id).collect();
        assert_eq!(left, vec![a], "only the move that really happened stays");
        assert!(!left.contains(&b));
        assert_eq!(fs::read(r.join("half.mkv")).unwrap(), b"t", "the temporary file got its old name back");
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn stop_ends_the_batch_and_progress_reports_each_step() {
        let r = temp_root("stop");
        fs::write(r.join("a.mkv"), b"1").unwrap();
        fs::write(r.join("b.mkv"), b"2").unwrap();
        let store = Store::in_memory().unwrap();
        let steps = std::cell::RefCell::new(Vec::new());
        let rep = apply_with(&r, &[op("a.mkv", "A1.mkv"), op("b.mkv", "B1.mkv")], &store, "s", false, &|i| i >= 1, &|s| steps.borrow_mut().push(s.state)).unwrap();
        assert_eq!(rep.done, 1);
        assert!(rep.stopped);
        assert_eq!(*steps.borrow(), vec!["working", "done"]);
        assert!(r.join("b.mkv").exists());
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
