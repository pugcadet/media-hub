//! "This one is right": keeps one subtitle for a video and makes it final. The timing you set
//! in the player goes into the file, the other files in that language go to the trash folder,
//! and the kept one is named after the video (`Video.eng.srt`), so Jellyfin and Infuse both
//! pick it up the same way. Every step is journaled, so History can undo it.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::planner::PlanOp;
use crate::state::AppState;
use crate::subsync::{apply_fit, parse_subs, write_subs, Fit};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const SUB_EXT: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx", "smi", "sup"];

/// A subtitle file on this computer, from a server path (Jellyfin's) or a local one (a file
/// Media Hub just saved). Only subtitle files inside the library folder.
pub fn resolve_sub(state: &AppState, path: &str) -> Result<PathBuf> {
    let direct = PathBuf::from(path);
    let p = if direct.is_file() { direct } else { local::to_local(state, path)? };
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !SUB_EXT.contains(&ext.as_str()) {
        return Err(Error::msg("That isn't a subtitle file."));
    }
    let root = state.library_root()?.canonicalize()?;
    if !p.is_file() || !p.canonicalize()?.starts_with(&root) {
        return Err(Error::msg("That subtitle file isn't in your library folder (any more)."));
    }
    Ok(p)
}

/// Every way a language shows up in subtitle file names ("eng", "en", "english" …).
pub fn name_codes(lang: &str) -> Vec<String> {
    let mut out = crate::sub_cmds::lang_aliases(lang);
    const TWO: &[(&str, &str, &str)] = &[
        ("eng", "en", "english"), ("dut", "nl", "dutch"), ("nld", "nl", "nederlands"), ("ger", "de", "german"), ("deu", "de", "deutsch"),
        ("fre", "fr", "french"), ("fra", "fr", "francais"), ("spa", "es", "spanish"), ("ita", "it", "italian"), ("por", "pt", "portuguese"),
        ("swe", "sv", "swedish"), ("nor", "no", "norwegian"), ("dan", "da", "danish"), ("fin", "fi", "finnish"), ("pol", "pl", "polish"),
        ("tur", "tr", "turkish"), ("rus", "ru", "russian"), ("jpn", "ja", "japanese"), ("kor", "ko", "korean"), ("ara", "ar", "arabic"),
    ];
    for c in out.clone() {
        for (a, b, word) in TWO {
            if c == *a {
                out.push(b.to_string());
                out.push(word.to_string());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The subtitle files next to a video in this language (by their names), forced ones left out.
pub fn same_language_files(video: &Path, codes: &[String]) -> Vec<PathBuf> {
    let (Some(dir), Some(stem)) = (video.parent(), video.file_stem().map(|s| s.to_string_lossy().to_lowercase())) else { return Vec::new() };
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_lowercase();
        let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
        if !p.is_file() || !SUB_EXT.contains(&ext.as_str()) || !name.starts_with(&format!("{stem}.")) {
            continue;
        }
        let tags: Vec<&str> = name[stem.len() + 1..].split('.').collect();
        if tags.iter().any(|t| *t == "forced") {
            continue;
        }
        if tags.iter().any(|t| codes.iter().any(|c| c == t)) {
            out.push(p);
        }
    }
    out
}

/// `Video.eng.srt` (the clean name for the kept subtitle).
pub fn clean_name(video: &Path, lang: &str, ext: &str) -> Option<String> {
    Some(format!("{}.{}.{}", video.file_stem()?.to_string_lossy(), lang, ext))
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LockResult {
    /// Seconds the file was shifted by (0 when the timing stayed).
    shifted: f64,
    /// Other files in this language moved to the trash folder.
    removed: usize,
    /// The kept file's name now.
    file: String,
    renamed: bool,
}

#[tauri::command]
pub async fn subtitle_lock(app: AppHandle, state: State<'_, AppState>, id: String, path: String, lang: String, offset: f64, remove_others: bool) -> Result<LockResult> {
    if !valid_item_id(&id) || lang.len() > 8 || !lang.chars().all(|c| c.is_ascii_alphabetic()) || !offset.is_finite() || offset.abs() > 600.0 {
        return Err(Error::msg("bad request"));
    }
    let w = state.writer().await?; // changing files needs changes switched on
    let item = w.reader().item_json(&id).await?;
    let video = local::to_local(&state, item.get("Path").and_then(Value::as_str).unwrap_or(""))?;
    let mut keep = resolve_sub(&state, &path)?;
    if keep.parent() != video.parent() {
        return Err(Error::msg("That subtitle isn't next to this video."));
    }
    let root = state.library_root()?;
    let mut res = LockResult::default();
    let lang = lang.to_lowercase();

    // 1. The timing into the file (a copy of the original is kept for undo).
    let ext = keep.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if offset.abs() >= 0.05 {
        if ext != "srt" && ext != "vtt" {
            return Err(Error::msg("Only SRT and VTT subtitles can get new timing in the file."));
        }
        let raw = std::fs::read(&keep)?;
        let (cues, vtt) = parse_subs(&String::from_utf8_lossy(&raw));
        if cues.is_empty() {
            return Err(Error::msg("No subtitle lines found in that file."));
        }
        let dir = state.dir.join("backups");
        std::fs::create_dir_all(&dir)?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let backup = dir.join(format!("{id}-lock-{stamp}.{ext}"));
        std::fs::write(&backup, &raw)?;
        state.store()?.journal_add("subtitle_timing", &id, &format!("{}|{}", keep.to_string_lossy(), backup.to_string_lossy()), &format!("{offset:+.1} s"))?;
        let fit = Fit { offset, scale: 1.0, before: 0.0, after: 0.0 };
        std::fs::write(&keep, write_subs(&apply_fit(&cues, &fit), vtt))?;
        res.shifted = offset;
    }

    // 2. The others in this language to the trash folder (put back from History).
    if remove_others {
        let codes = name_codes(&lang);
        let others: Vec<PathBuf> = same_language_files(&video, &codes).into_iter().filter(|p| p != &keep).collect();
        let stamp = format!("subs-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        let mut moves = Vec::new();
        for o in others {
            let Some(rel) = local::rel_to_root(&root, &o) else { continue };
            let to_rel = format!("{}/{stamp}/{rel}", crate::storage::TRASH);
            let to = root.join(crate::fsops::safe_rel(&to_rel)?);
            if to.exists() {
                continue;
            }
            if let Some(p) = to.parent() {
                std::fs::create_dir_all(p)?;
            }
            std::fs::rename(&o, &to)?;
            moves.push((rel, to_rel));
        }
        res.removed = moves.len();
        if !moves.is_empty() {
            let rec = serde_json::json!({ "root": root.to_string_lossy(), "moves": moves });
            state.store()?.journal_add("file_trashed", &id, &rec.to_string(), "subtitles")?;
        }
    }

    // 3. Named after the video, when that name is free (a rename History can undo).
    if let Some(name) = clean_name(&video, &lang, &ext) {
        let target = keep.with_file_name(&name);
        if target != keep && !target.exists() {
            if let (Some(from), Some(to)) = (local::rel_to_root(&root, &keep), local::rel_to_root(&root, &target)) {
                let op = PlanOp { from, to: to.clone(), kind: "sidecar", status: "ok", note: None, season: None, episodes: vec![], verified: true, score: None, step_to: to, title: None };
                let batch = format!("sub-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
                let (r2, a2) = (root.clone(), app.clone());
                let rep = tauri::async_runtime::spawn_blocking(move || crate::fsops::apply(&r2, &[op], &*a2.state::<AppState>(), &batch, false))
                    .await
                    .map_err(|e| Error::msg(e.to_string()))??;
                if rep.done == 1 {
                    keep = target;
                    res.renamed = true;
                }
            }
        }
    }
    res.file = keep.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = w.refresh_light(&id).await;
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_same_language_by_name() {
        let dir = std::env::temp_dir().join(format!("mh-sublock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let video = dir.join("Heat (1995).mkv");
        for f in ["Heat (1995).mkv", "Heat (1995).en.srt", "Heat (1995).eng.2.srt", "Heat (1995).English.srt", "Heat (1995).eng.forced.srt", "Heat (1995).nl.srt", "Other.eng.srt"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mut got: Vec<String> = same_language_files(&video, &name_codes("eng")).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        got.sort();
        assert_eq!(got, vec!["Heat (1995).English.srt", "Heat (1995).en.srt", "Heat (1995).eng.2.srt"]);
        assert_eq!(clean_name(&video, "eng", "srt").unwrap(), "Heat (1995).eng.srt");
        assert!(name_codes("dut").contains(&"nl".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
