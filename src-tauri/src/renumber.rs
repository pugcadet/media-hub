//! "This episode is really S01E03": renames one episode file (and its subtitles) to the right
//! season and episode number, moving it into that season's folder when the show uses season
//! folders. Done through the same journal as every rename, so History can undo it.

use crate::error::{Error, Result};
use crate::fsops::{self, ApplyReport};
use crate::jellyfin::valid_item_id;
use crate::local;
use crate::naming::{sanitize, season_from_dir, split_ext, split_path};
use crate::planner::PlanOp;
use crate::state::AppState;
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

fn ep_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)S\d{1,3}\s?E\d{1,4}(?:-?E\d{1,4})*").expect("episode pattern"))
}

/// The new file name (without extension): the SxxEyy part swapped, or added after the show name.
pub fn new_stem(stem: &str, show: &str, title: &str, season: u32, episode: u32) -> String {
    let tag = format!("S{season:02}E{episode:02}");
    if ep_re().is_match(stem) {
        return ep_re().replace(stem, tag.as_str()).into_owned();
    }
    let parts: Vec<&str> = [show.trim(), tag.as_str(), title.trim()].into_iter().filter(|p| !p.is_empty()).collect();
    sanitize(&parts.join(" - "))
}

/// The folder for the new season: a sibling season folder when the episode sits in one.
pub fn new_dir(dir: &str, season: u32, siblings: &[String]) -> String {
    let (parent, name) = split_path(dir);
    if season_from_dir(name).is_none() {
        return dir.to_string(); // no season folders: stays where it is
    }
    let pick = siblings
        .iter()
        .find(|s| season_from_dir(s) == Some(season))
        .cloned()
        .unwrap_or_else(|| if season == 0 { "Specials".to_string() } else { format!("Season {season:02}") });
    if parent.is_empty() { pick } else { format!("{parent}/{pick}") }
}

fn plan(root: &Path, file_rel: &str, show: &str, title: &str, season: u32, episode: u32) -> Result<Vec<PlanOp>> {
    let (dir, name) = split_path(file_rel);
    let (stem, ext) = split_ext(name);
    let parent = split_path(dir).0;
    let siblings: Vec<String> = std::fs::read_dir(root.join(fsops::safe_rel(parent)?))
        .map(|rd| rd.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    let to_dir = new_dir(dir, season, &siblings);
    let to_stem = new_stem(stem, show, title, season, episode);
    let join = |d: &str, n: &str| if d.is_empty() { n.to_string() } else { format!("{d}/{n}") };
    let mut ops = Vec::new();
    let mut push = |from: String, to: String, kind: &'static str| {
        let status = if from == to { "unchanged" } else if fsops::exists(root, &to) { "conflict" } else { "ok" };
        ops.push(PlanOp { from, to: to.clone(), kind, status, note: None, season: Some(season), episodes: vec![episode], verified: true, score: Some(100), step_to: to, title: None });
    };
    push(file_rel.to_string(), join(&to_dir, &format!("{to_stem}.{ext}")), "video");
    // Subtitles and other files named like the video follow it.
    for e in std::fs::read_dir(root.join(fsops::safe_rel(dir)?))?.flatten() {
        let Ok(n) = e.file_name().into_string() else { continue };
        if n != name && n.starts_with(&format!("{stem}.")) && e.path().is_file() {
            push(join(dir, &n), join(&to_dir, &format!("{to_stem}{}", &n[stem.len()..])), "sidecar");
        }
    }
    Ok(ops)
}

#[tauri::command]
pub async fn episode_renumber(app: AppHandle, state: tauri::State<'_, AppState>, id: String, season: u32, episode: u32) -> Result<ApplyReport> {
    if !valid_item_id(&id) || season > 300 || episode == 0 || episode > 5000 {
        return Err(Error::msg("bad request"));
    }
    let item = state.reader().await?.item_json(&id).await?;
    let server = item.get("Path").and_then(Value::as_str).ok_or_else(|| Error::msg("Jellyfin has no file for this episode."))?.to_string();
    let local_path = local::to_local(&state, &server)?;
    let root = state.library_root()?;
    let rel = local::rel_to_root(&root, &local_path).ok_or_else(|| Error::msg("This file is outside your library folder."))?;
    let show = item.get("SeriesName").and_then(Value::as_str).unwrap_or("").to_string();
    let title = item.get("Name").and_then(Value::as_str).unwrap_or("").to_string();
    let r2 = root.clone();
    let ops = tauri::async_runtime::spawn_blocking(move || plan(&r2, &rel, &show, &title, season, episode))
        .await
        .map_err(|e| Error::msg(e.to_string()))??;
    if ops.iter().any(|o| o.kind == "video" && o.status == "conflict") {
        return Err(Error::msg("There's already a file with that episode number. Nothing was changed."));
    }
    let batch = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    let rep = tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        fsops::apply(&root, &ops, &*st, &batch, true)
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))??;
    let _ = state.reader().await?.library_scan().await;
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_or_adds_the_episode_number() {
        assert_eq!(new_stem("Bluey - S00E05 - Hotel", "Bluey", "Hotel", 1, 3), "Bluey - S01E03 - Hotel");
        assert_eq!(new_stem("hotel", "Bluey", "Hotel", 1, 3), "Bluey - S01E03 - Hotel");
    }

    #[test]
    fn moves_to_the_right_season_folder() {
        let sib = vec!["Season 01".to_string(), "Specials".to_string()];
        assert_eq!(new_dir("TV/Bluey/Specials", 1, &sib), "TV/Bluey/Season 01");
        assert_eq!(new_dir("TV/Bluey/Specials", 2, &sib), "TV/Bluey/Season 02");
        assert_eq!(new_dir("TV/Bluey", 1, &sib), "TV/Bluey", "no season folders: stays");
    }
}
