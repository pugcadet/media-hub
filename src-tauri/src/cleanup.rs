//! Clean-up tools: subtitle files in languages you never use. Files are moved into the
//! library's trash folder (never deleted), so Undo in History puts them back.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use tauri::{AppHandle, Emitter, State};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// Two- and three-letter codes of one language map to one name ("en", "eng" → "eng").
pub fn lang_family(code: &str) -> String {
    let c = code.trim().to_lowercase();
    let fam = match c.as_str() {
        "en" | "eng" | "english" => "eng",
        "nl" | "nld" | "dut" | "dutch" | "nederlands" => "dut",
        "de" | "deu" | "ger" | "german" => "ger",
        "fr" | "fra" | "fre" | "french" => "fre",
        "es" | "spa" | "spanish" => "spa",
        "it" | "ita" | "italian" => "ita",
        "pt" | "por" | "pob" | "portuguese" => "por",
        "sv" | "swe" | "swedish" => "swe",
        "da" | "dan" | "danish" => "dan",
        "no" | "nor" | "nob" | "nno" | "norwegian" => "nor",
        "fi" | "fin" | "finnish" => "fin",
        "pl" | "pol" | "polish" => "pol",
        "ru" | "rus" | "russian" => "rus",
        "zh" | "chi" | "zho" | "chinese" => "chi",
        "ja" | "jpn" | "japanese" => "jpn",
        "ko" | "kor" | "korean" => "kor",
        "ar" | "ara" | "arabic" => "ara",
        "tr" | "tur" | "turkish" => "tur",
        _ => return c,
    };
    fam.to_string()
}

/// Whether a subtitle language should go: tagged, and not one you keep.
pub fn is_extra(language: &str, keep: &HashSet<String>) -> bool {
    let l = language.trim();
    !(l.is_empty() || l.eq_ignore_ascii_case("und") || keep.contains(&lang_family(l)))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtraSub {
    id: String,
    name: String,
    index: i64,
    language: String,
    title: String,
    /// The subtitle file as Jellyfin sees it.
    path: String,
}

fn label(v: &Value) -> String {
    if s(v, "Type") == "Episode" {
        let se = v.get("ParentIndexNumber").and_then(Value::as_i64).unwrap_or(0);
        let ep = v.get("IndexNumber").and_then(Value::as_i64).unwrap_or(0);
        format!("{} · S{se:02}E{ep:02} · {}", s(v, "SeriesName"), s(v, "Name"))
    } else {
        s(v, "Name").to_string()
    }
}

/// Subtitle files (next to the videos) in languages you don't keep. Subtitles built into the
/// video file can't be taken out this way and are not listed.
#[tauri::command]
pub async fn extra_subtitles(app: AppHandle, state: State<'_, AppState>, keep: Vec<String>) -> Result<Vec<ExtraSub>> {
    let keep: HashSet<String> = keep.iter().map(|k| lang_family(k)).collect();
    if keep.is_empty() {
        return Err(Error::msg("Pick at least one language to keep."));
    }
    let _ = app.emit("bulk-progress", serde_json::json!({ "done": 0, "total": 2, "label": "Reading every video" }));
    let items = state
        .reader()
        .await?
        .items_query(
            vec![
                ("IncludeItemTypes", "Movie,Episode".into()),
                ("Recursive", "true".into()),
                ("HasSubtitles", "true".into()),
                ("Fields", "MediaStreams,Path".into()),
                ("EnableImages", "false".into()),
                ("EnableUserData", "false".into()),
            ],
            100_000,
        )
        .await?;
    let mut out = Vec::new();
    for v in &items {
        let id = s(v, "Id").replace('-', "");
        if !valid_item_id(&id) {
            continue;
        }
        for st in v.get("MediaStreams").and_then(Value::as_array).into_iter().flatten() {
            if s(st, "Type") != "Subtitle" || !st.get("IsExternal").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            let path = s(st, "Path");
            if path.is_empty() || !is_extra(s(st, "Language"), &keep) {
                continue;
            }
            out.push(ExtraSub {
                id: id.clone(),
                name: label(v),
                index: st.get("Index").and_then(Value::as_i64).unwrap_or(-1),
                language: s(st, "Language").to_string(),
                title: st.get("DisplayTitle").and_then(Value::as_str).unwrap_or("").to_string(),
                path: path.to_string(),
            });
        }
    }
    let _ = app.emit("bulk-progress", serde_json::json!({ "done": 2, "total": 2, "label": "" }));
    Ok(out)
}

#[derive(Deserialize)]
pub struct SubFile {
    id: String,
    path: String,
}

/// Moves the given subtitle files into the trash folder (one History entry per video, so each
/// can be put back) and asks Jellyfin to look at those videos again.
#[tauri::command]
pub async fn remove_subtitle_files(app: AppHandle, state: State<'_, AppState>, files: Vec<SubFile>) -> Result<usize> {
    let w = state.writer().await?; // moving files is a change: needs changes switched on
    let root = state.library_root()?;
    let canon_root = root.canonicalize()?;
    let stamp = format!("subs-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
    let mut by_item: std::collections::BTreeMap<String, Vec<(String, String)>> = Default::default();
    let total = files.len();
    crate::cancel::begin("bulk");
    for (i, f) in files.iter().enumerate() {
        if crate::cancel::stopped("bulk") {
            break;
        }
        let _ = app.emit("bulk-progress", serde_json::json!({ "done": i, "total": total }));
        if !valid_item_id(&f.id) {
            continue;
        }
        let ext = f.path.rsplit('.').next().unwrap_or("").to_lowercase();
        if !["srt", "ass", "ssa", "vtt", "sub", "idx", "smi", "sup"].contains(&ext.as_str()) {
            continue; // only subtitle files, never a video
        }
        let Ok(local) = local::to_local(&state, &f.path) else { continue };
        if !local.is_file() || !local.canonicalize()?.starts_with(&canon_root) {
            continue;
        }
        let Some(rel) = local::rel_to_root(&root, &local) else { continue };
        let to_rel = format!("{}/{stamp}/{rel}", crate::storage::TRASH);
        let to = root.join(crate::fsops::safe_rel(&to_rel)?);
        if to.exists() {
            continue;
        }
        if let Some(p) = to.parent() {
            std::fs::create_dir_all(p)?;
        }
        std::fs::rename(&local, &to)?;
        by_item.entry(f.id.clone()).or_default().push((rel, to_rel));
    }
    let mut n = 0;
    for (id, moves) in &by_item {
        n += moves.len();
        let rec = serde_json::json!({ "root": root.to_string_lossy(), "moves": moves });
        state.store()?.journal_add("file_trashed", id, &rec.to_string(), "subtitles")?;
        let _ = w.refresh_light(id).await;
    }
    Ok(n)
}

/// An episode without its own picture.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BareEpisode {
    id: String,
    name: String,
    series_id: String,
    series: String,
}

/// Episodes (with a file) that have no picture of their own.
#[tauri::command]
pub async fn episodes_without_picture(state: State<'_, AppState>) -> Result<Vec<BareEpisode>> {
    let items = state
        .reader()
        .await?
        .items_query(
            vec![
                ("IncludeItemTypes", "Episode".into()),
                ("Recursive", "true".into()),
                ("IsMissing", "false".into()),
                ("Fields", "SeriesId".into()),
                ("ImageTypeLimit", "1".into()),
                ("EnableUserData", "false".into()),
            ],
            100_000,
        )
        .await?;
    Ok(items
        .iter()
        .filter(|v| v.get("ImageTags").and_then(|t| t.get("Primary")).is_none() && s(v, "LocationType") != "Virtual")
        .filter_map(|v| {
            let id = s(v, "Id").replace('-', "");
            valid_item_id(&id).then(|| BareEpisode { name: label(v), series_id: s(v, "SeriesId").replace('-', ""), series: s(v, "SeriesName").to_string(), id })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_group_by_family() {
        let keep: HashSet<String> = ["eng", "nl"].iter().map(|x| lang_family(x)).collect();
        assert!(!is_extra("en", &keep));
        assert!(!is_extra("ENG", &keep));
        assert!(!is_extra("nld", &keep));
        assert!(!is_extra("dut", &keep));
        assert!(is_extra("fre", &keep));
        assert!(is_extra("spa", &keep));
        assert!(!is_extra("", &keep), "untagged subtitles are kept (unknown language)");
        assert!(!is_extra("und", &keep));
    }
}
