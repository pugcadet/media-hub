//! After Identify: the match goes into the folder name ("Heat (1995) [tmdbid-949]"), so
//! Jellyfin matches the title the same way every time, also after a reset or a new scan.
//! One rename, journaled like every rename (History can undo it).

use crate::error::{Error, Result};
use crate::fsops::{self, ApplyReport};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::naming::sanitize;
use crate::planner::PlanOp;
use crate::state::AppState;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager, State};

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)\s*[\[{](?:tmdbid|tvdbid|imdbid|tmdb|tvdb|imdb)[-=][^\]}]*[\]}]").expect("id tag pattern"))
}

/// "Heat (1995) [tmdbid-949]": the name, the year and the best id for the kind of title.
pub fn pinned_name(name: &str, year: Option<i64>, kind: &str, ids: &Value) -> Option<String> {
    let id = |k: &str| ids.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric()));
    let tag = match kind {
        "Series" => id("Tvdb").map(|v| format!("[tvdbid-{v}]")).or_else(|| id("Tmdb").map(|v| format!("[tmdbid-{v}]"))),
        _ => id("Tmdb").map(|v| format!("[tmdbid-{v}]")).or_else(|| id("Imdb").map(|v| format!("[imdbid-{v}]"))),
    }?;
    let clean = tag_re().replace_all(name, "").trim().to_string();
    let base = match year {
        Some(y) if !clean.contains(&format!("({y})")) => format!("{clean} ({y})"),
        _ => clean,
    };
    let out = sanitize(&format!("{base} {tag}"));
    (!out.is_empty()).then_some(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PinResult {
    /// The folder (or file) name now; empty when nothing needed changing.
    name: String,
    changed: bool,
    /// Why nothing was renamed, when it wasn't.
    note: Option<String>,
    report: Option<ApplyReport>,
}

/// Puts the identified match into the title's folder name (a movie without its own folder:
/// into the file name, with its subtitles).
#[tauri::command]
pub async fn pin_identity(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<PinResult> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let _ = state.writer().await?; // renaming needs changes switched on
    let item = state.reader().await?.item_json(&id).await?;
    let kind = item.get("Type").and_then(Value::as_str).unwrap_or("").to_string();
    if kind != "Movie" && kind != "Series" {
        return Ok(PinResult { name: String::new(), changed: false, note: Some("Only movies and shows get the match in their folder name.".into()), report: None });
    }
    let name = item.get("Name").and_then(Value::as_str).unwrap_or("").to_string();
    let year = item.get("ProductionYear").and_then(Value::as_i64);
    let ids = item.get("ProviderIds").cloned().unwrap_or(Value::Null);
    let Some(new_name) = pinned_name(&name, year, &kind, &ids) else {
        return Ok(PinResult { name: String::new(), changed: false, note: Some("It has no TMDB, TVDB or IMDb id yet.".into()), report: None });
    };
    let server = item.get("Path").and_then(Value::as_str).ok_or_else(|| Error::msg("Jellyfin has no folder for this title."))?;
    let path = local::to_local(&state, server)?;
    let root = state.library_root()?;
    let rel = local::rel_to_root(&root, &path).ok_or_else(|| Error::msg("This title is outside your library folder."))?;

    // Which name to change: a show's folder; a movie's own folder; else the movie file.
    let mut ops: Vec<PlanOp> = Vec::new();
    let op = |from: String, to: String, kind: &'static str| PlanOp { from, to: to.clone(), kind, status: "ok", note: None, season: None, episodes: vec![], verified: true, score: Some(100), step_to: to, title: None };
    let (parent, last) = rel.rsplit_once('/').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((String::new(), rel.clone()));
    let join = |d: &str, n: &str| if d.is_empty() { n.to_string() } else { format!("{d}/{n}") };
    if kind == "Series" || path.is_dir() {
        if last == new_name {
            return Ok(PinResult { name: new_name, changed: false, note: None, report: None });
        }
        if parent.is_empty() {
            return Err(Error::msg("That folder is the top of your library; it can't be renamed."));
        }
        ops.push(op(rel.clone(), join(&parent, &new_name), "folder"));
    } else {
        let (gparent, folder) = parent.rsplit_once('/').map(|(a, b)| (a.to_string(), b.to_string())).unwrap_or((String::new(), parent.clone()));
        let dir = root.join(fsops::safe_rel(&parent)?);
        let videos = std::fs::read_dir(&dir)
            .map(|rd| rd.flatten().filter(|e| e.path().is_file() && crate::naming::is_video(&e.file_name().to_string_lossy())).count())
            .unwrap_or(0);
        if !gparent.is_empty() && videos == 1 {
            // The movie has a folder of its own: that gets the name.
            if folder == new_name {
                return Ok(PinResult { name: new_name, changed: false, note: None, report: None });
            }
            ops.push(op(parent.clone(), join(&gparent, &new_name), "folder"));
        } else {
            // Loose in the movies folder: the file (and its subtitles) get the name.
            let stem = Path::new(&last).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            if stem == new_name {
                return Ok(PinResult { name: new_name, changed: false, note: None, report: None });
            }
            for e in std::fs::read_dir(&dir)?.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if e.path().is_file() && (n == last || (n.starts_with(&format!("{stem}.")) && crate::naming::is_sidecar(&n))) {
                    let rest = &n[stem.len()..];
                    ops.push(op(join(&parent, &n), join(&parent, &format!("{new_name}{rest}")), if n == last { "video" } else { "sidecar" }));
                }
            }
        }
    }
    for o in &mut ops {
        if fsops::exists(&root, &o.to) {
            o.status = "conflict";
        }
    }
    if ops.iter().any(|o| o.status == "conflict") {
        return Ok(PinResult { name: new_name, changed: false, note: Some("Something with that name is already there; nothing was renamed.".into()), report: None });
    }
    let batch = format!("pin-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let r2 = root.clone();
    let rep = tauri::async_runtime::spawn_blocking(move || fsops::apply(&r2, &ops, &*app.state::<AppState>(), &batch, false))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    let changed = rep.done > 0;
    if changed {
        let _ = state.reader().await?.library_scan().await;
    }
    Ok(PinResult { name: new_name, changed, note: rep.failed.first().cloned(), report: Some(rep) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn puts_the_match_in_the_name() {
        let ids = serde_json::json!({ "Tmdb": "949", "Imdb": "tt0113277" });
        assert_eq!(pinned_name("Heat", Some(1995), "Movie", &ids).unwrap(), "Heat (1995) [tmdbid-949]");
        let show = serde_json::json!({ "Tvdb": "353546", "Tmdb": "82728" });
        assert_eq!(pinned_name("Bluey", Some(2018), "Series", &show).unwrap(), "Bluey (2018) [tvdbid-353546]");
        // An old tag is replaced, not added to.
        assert_eq!(pinned_name("Bluey [tvdbid-1]", Some(2018), "Series", &show).unwrap(), "Bluey (2018) [tvdbid-353546]");
        assert!(pinned_name("Heat", None, "Movie", &serde_json::json!({})).is_none());
        assert!(pinned_name("Heat", None, "Movie", &serde_json::json!({ "Tmdb": "../x" })).is_none());
    }
}
