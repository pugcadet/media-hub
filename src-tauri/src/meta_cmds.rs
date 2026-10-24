//! Commands for the metadata & artwork screen. Reading is always allowed; every change
//! goes through `AppState::writer` (switched off by default) and is journaled for undo.

use crate::error::{Error, Result};
use crate::jellyfin::{apply_edits, image_kind, valid_item_id, ItemEdits};
use crate::state::AppState;
use crate::store::Change;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    item: Value,
    images: Vec<Value>,
    seasons: Vec<Value>,
    changes: Vec<Change>,
    can_edit: bool,
}

async fn reader(state: &AppState) -> Result<crate::jellyfin::Client> {
    state.reader().await
}

fn check_id(id: &str) -> Result<()> {
    if valid_item_id(id) {
        Ok(())
    } else {
        Err(Error::msg("bad id"))
    }
}

#[tauri::command]
pub async fn item_details(state: State<'_, AppState>, id: String) -> Result<Details> {
    check_id(&id)?;
    let c = reader(&state).await?;
    let item = c.item_json(&id).await?;
    let images = c.image_list(&id).await.unwrap_or_default();
    let seasons = if item.get("Type").and_then(Value::as_str) == Some("Series") {
        c.seasons(&id).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let changes = state.store()?.changes_for(&id, 20)?;
    Ok(Details {
        item,
        images,
        seasons,
        changes,
        can_edit: !state.settings()?.read_only,
    })
}

fn sync_row(state: &AppState, id: &str, item: &Value) -> Result<()> {
    let name = item.get("Name").and_then(Value::as_str).unwrap_or("");
    let year = item.get("ProductionYear").and_then(Value::as_i64).map(|y| y as i32);
    let rating = item.get("CommunityRating").and_then(Value::as_f64);
    let genres: Vec<String> = item
        .get("Genres")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let overview = item.get("Overview").and_then(Value::as_str).unwrap_or("");
    state.store()?.patch_item(id, name, year, rating, &genres, overview)
}

#[tauri::command]
pub async fn save_metadata(state: State<'_, AppState>, id: String, edits: ItemEdits) -> Result<()> {
    check_id(&id)?;
    let w = state.writer().await?;
    let old = w.reader().item_json(&id).await?;
    let mut new = old.clone();
    apply_edits(&mut new, &edits)?;
    if new == old {
        return Ok(());
    }
    // Journal first: if saving fails halfway we still know the old state.
    let entry = state
        .store()?
        .journal_add("item_update", &id, &old.to_string(), &new.to_string())?;
    if let Err(e) = w.update_item(&id, &new).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    sync_row(&state, &id, &new)?;
    Ok(())
}

#[tauri::command]
pub async fn identify_search(
    state: State<'_, AppState>,
    kind: String,
    name: String,
    year: Option<i32>,
    ids: HashMap<String, String>,
) -> Result<Vec<Value>> {
    let c = reader(&state).await?;
    let mut clean_ids = HashMap::new();
    for (k, v) in ids {
        let key = match k.to_lowercase().as_str() {
            "tmdb" => "Tmdb",
            "tvdb" => "Tvdb",
            "imdb" => "Imdb",
            _ => continue,
        };
        let v = v.trim().to_string();
        if !v.is_empty() && v.chars().all(|c| c.is_ascii_alphanumeric()) {
            clean_ids.insert(key.to_string(), v);
        }
    }
    if name.trim().is_empty() && clean_ids.is_empty() {
        return Err(Error::msg("Type a name or an id to search for."));
    }
    c.remote_search(&kind, name.trim(), year, &clean_ids).await
}

#[tauri::command]
pub async fn identify_apply(state: State<'_, AppState>, id: String, result: Value, replace_images: bool) -> Result<()> {
    check_id(&id)?;
    if !result.is_object() {
        return Err(Error::msg("bad result"));
    }
    let w = state.writer().await?;
    let old = w.reader().item_json(&id).await?;
    let entry = state
        .store()?
        .journal_add("identify", &id, &old.to_string(), &result.to_string())?;
    if let Err(e) = w.apply_remote(&id, &result, replace_images).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_images(state: State<'_, AppState>, id: String, kind: String) -> Result<Vec<Value>> {
    check_id(&id)?;
    reader(&state).await?.remote_images(&id, &kind).await
}

fn ext_for(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    }
}

/// Keeps a copy of the current picture so a change can be undone. Returns "path|type", or "" if there was none.
async fn backup_current(state: &AppState, w: &crate::jellyfin::Writer, id: &str, kind: &str) -> Result<String> {
    Ok(match w.reader().image_original(id, kind, 0).await? {
        Some((bytes, ct)) => {
            let dir = state.dir.join("backups");
            std::fs::create_dir_all(&dir)?;
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let path = dir.join(format!("{id}-{kind}-{stamp}.{}", ext_for(&ct)));
            std::fs::write(&path, bytes)?;
            format!("{}|{}", path.to_string_lossy(), ct)
        }
        None => String::new(),
    })
}

/// Recognises a picture by its first bytes (never trusts the file name).
pub fn sniff_image(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Uses a picture file from this computer (for shows that exist nowhere online).
#[tauri::command]
pub async fn upload_image_file(app: tauri::AppHandle, state: State<'_, AppState>, id: String, kind: String) -> Result<bool> {
    use tauri_plugin_dialog::DialogExt;
    check_id(&id)?;
    let kind = image_kind(&kind).ok_or_else(|| Error::msg("bad image kind"))?;
    let w = state.writer().await?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().add_filter("Pictures", &["jpg", "jpeg", "png", "webp"]).blocking_pick_file()
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    let Some(fp) = picked else { return Ok(false) };
    let path = fp.into_path().map_err(|_| Error::msg("That file cannot be used."))?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() > 20 * 1024 * 1024 {
        return Err(Error::msg("That picture is larger than 20 MB."));
    }
    let bytes = std::fs::read(&path)?;
    let ct = sniff_image(&bytes).ok_or_else(|| Error::msg("Use a JPEG, PNG or WebP picture."))?;
    let backup = backup_current(&state, &w, &id, kind).await?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let entry = state
        .store()?
        .journal_add("image", &format!("{id}|{kind}|0"), &backup, &format!("upload:{name}"))?;
    if let Err(e) = w.upload_image(&id, kind, 0, &bytes, ct).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(true)
}

#[tauri::command]
pub async fn set_image(state: State<'_, AppState>, id: String, kind: String, url: String) -> Result<()> {
    check_id(&id)?;
    let kind = image_kind(&kind).ok_or_else(|| Error::msg("bad image kind"))?;
    if crate::images::allowed_remote(&url).is_none() {
        return Err(Error::msg("That picture does not come from a known image site."));
    }
    let w = state.writer().await?;

    let backup = backup_current(&state, &w, &id, kind).await?;
    let entry = state
        .store()?
        .journal_add("image", &format!("{id}|{kind}|0"), &backup, &url)?;
    if let Err(e) = w.download_remote_image(&id, kind, &url).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn undo_change(state: State<'_, AppState>, change_id: i64) -> Result<()> {
    let ch = state.store()?.change(change_id)?;
    if ch.undone {
        return Err(Error::msg("This change was already undone."));
    }
    if ch.action == "storage" {
        // A local file swap: no Jellyfin change involved.
        crate::storage::undo_swap(&ch.old_value)?;
        state.store()?.journal_mark_undone(change_id)?;
        return Ok(());
    }
    let w = state.writer().await?;
    match ch.action.as_str() {
        "item_update" | "identify" => {
            check_id(&ch.target)?;
            let old: Value = serde_json::from_str(&ch.old_value).map_err(|_| Error::msg("The saved old version is damaged."))?;
            w.update_item(&ch.target, &old).await?;
            sync_row(&state, &ch.target, &old)?;
        }
        "image" => {
            let mut parts = ch.target.split('|');
            let (Some(id), Some(kind), Some(index)) = (parts.next(), parts.next(), parts.next()) else {
                return Err(Error::msg("bad journal entry"));
            };
            check_id(id)?;
            let index: u32 = index.parse().map_err(|_| Error::msg("bad journal entry"))?;
            if ch.old_value.is_empty() {
                w.delete_image(id, kind, index).await?;
            } else {
                let (path, ct) = ch.old_value.rsplit_once('|').ok_or_else(|| Error::msg("bad journal entry"))?;
                let bytes = std::fs::read(path).map_err(|_| Error::msg("The backup picture is missing."))?;
                w.upload_image(id, kind, index, &bytes, ct).await?;
            }
        }
        "segment" => {
            check_id(&ch.target)?;
            crate::seg_cmds::undo_segments(&w, &ch.target, &ch.old_value).await?;
        }
        "subtitle" => {
            check_id(&ch.target)?;
            crate::sub_cmds::undo_download(&w, &ch.target, &ch.old_value).await?;
        }
        _ => return Err(Error::msg("This kind of change cannot be undone here.")),
    }
    state.store()?.journal_mark_undone(change_id)?;
    Ok(())
}

#[tauri::command]
pub async fn refresh_item(state: State<'_, AppState>, id: String, replace_all: bool) -> Result<()> {
    check_id(&id)?;
    state.writer().await?.refresh(&id, replace_all).await
}

#[tauri::command]
pub fn set_read_only(state: State<'_, AppState>, value: bool) -> Result<()> {
    state.update_settings(|s| s.read_only = value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_pictures_by_content() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg onload=alert(1)>"), None);
    }
}
