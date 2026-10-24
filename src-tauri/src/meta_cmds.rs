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

fn reader(state: &AppState) -> Result<crate::jellyfin::Client> {
    state.client()?.ok_or_else(|| Error::msg("Connect to your server first."))
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
    let c = reader(&state)?;
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
    let w = state.writer()?;
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
    let c = reader(&state)?;
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
    let w = state.writer()?;
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
    reader(&state)?.remote_images(&id, &kind).await
}

fn ext_for(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "jpg",
    }
}

#[tauri::command]
pub async fn set_image(state: State<'_, AppState>, id: String, kind: String, url: String) -> Result<()> {
    check_id(&id)?;
    let kind = image_kind(&kind).ok_or_else(|| Error::msg("bad image kind"))?;
    if crate::images::allowed_remote(&url).is_none() {
        return Err(Error::msg("That picture does not come from a known image site."));
    }
    let w = state.writer()?;

    // Keep a copy of the current picture so the change can be undone.
    let backup = match w.reader().image_original(&id, kind, 0).await? {
        Some((bytes, ct)) => {
            let dir = state.dir.join("backups");
            std::fs::create_dir_all(&dir)?;
            let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let path = dir.join(format!("{id}-{kind}-{stamp}.{}", ext_for(&ct)));
            std::fs::write(&path, bytes)?;
            format!("{}|{}", path.to_string_lossy(), ct)
        }
        None => String::new(),
    };
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
    let w = state.writer()?;
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
    state.writer()?.refresh(&id, replace_all).await
}

#[tauri::command]
pub fn set_read_only(state: State<'_, AppState>, value: bool) -> Result<()> {
    state.update_settings(|s| s.read_only = value)
}
