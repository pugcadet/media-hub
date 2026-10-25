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

pub(crate) fn sync_row(state: &AppState, id: &str, item: &Value) -> Result<()> {
    let name = item.get("Name").and_then(Value::as_str).unwrap_or("");
    let year = item.get("ProductionYear").and_then(Value::as_i64).map(|y| y as i32);
    let rating = item.get("CommunityRating").and_then(Value::as_f64);
    let genres: Vec<String> = item
        .get("Genres")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let overview = item.get("Overview").and_then(Value::as_str).unwrap_or("");
    let store = state.store()?;
    store.patch_item(id, name, year, rating, &genres, overview)?;
    let matched = item
        .get("ProviderIds")
        .and_then(Value::as_object)
        .map(|p| ["Tmdb", "Tvdb", "Imdb"].iter().any(|k| p.get(*k).and_then(Value::as_str).map(|v| !v.is_empty()).unwrap_or(false)))
        .unwrap_or(false);
    let has_poster = item.get("ImageTags").and_then(|t| t.get("Primary")).is_some();
    store.patch_flags(id, matched, has_poster)
}

/// Reads the item again and updates the local list (so it leaves "unmatched" or "no poster").
async fn resync(state: &AppState, id: &str) {
    if let Ok(c) = state.reader().await {
        if let Ok(item) = c.item_json(id).await {
            let _ = sync_row(state, id, &item);
        }
    }
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
    // Your edit wins from now on: lock it (unless you just chose to unlock it).
    if edits.lock_data.is_none() && state.settings()?.lock_edits {
        new["LockData"] = Value::Bool(true);
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
    unlock_for_refresh(&w, &id).await?;
    if let Err(e) = w.apply_remote(&id, &result, replace_images).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    // Jellyfin fetches the new details in the background; wait until the ids show up.
    for _ in 0..10 {
        tokio_sleep(1500).await;
        if let Ok(item) = w.reader().item_json(&id).await {
            let linked = item.get("ProviderIds").and_then(Value::as_object).map(|p| !p.is_empty()).unwrap_or(false);
            let _ = sync_row(&state, &id, &item);
            if linked {
                break;
            }
        }
    }
    Ok(())
}

/// After a picture you chose by hand: lock the title so Jellyfin keeps it (Settings).
pub(crate) async fn lock_after_edit(state: &AppState, w: &crate::jellyfin::Writer, id: &str) {
    if !state.settings().map(|s| s.lock_edits).unwrap_or(false) {
        return;
    }
    if let Ok(mut item) = w.reader().item_json(id).await {
        if item.get("LockData").and_then(Value::as_bool) != Some(true) {
            item["LockData"] = Value::Bool(true);
            let _ = w.update_item(id, &item).await;
        }
    }
}

/// Before asking Jellyfin to fetch again: a locked title would be skipped, so unlock it.
async fn unlock_for_refresh(w: &crate::jellyfin::Writer, id: &str) -> Result<()> {
    let mut item = w.reader().item_json(id).await?;
    if item.get("LockData").and_then(Value::as_bool) == Some(true) {
        item["LockData"] = Value::Bool(false);
        w.update_item(id, &item).await?;
    }
    Ok(())
}

async fn tokio_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms)))
        .await
        .ok();
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
    lock_after_edit(&state, &w, &id).await;
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

    if kind == "Backdrop" {
        // A show can have many backdrops. Jellyfin adds a downloaded one at the end, so it is
        // moved to the front to become the main one. Undo removes it again; nothing is replaced.
        let before = backdrop_count(&w, &id).await;
        let entry = state.store()?.journal_add("image", &format!("{id}|{kind}|0"), "", &url)?;
        if let Err(e) = w.download_remote_image(&id, kind, &url).await {
            state.store()?.journal_delete(entry)?;
            return Err(e);
        }
        let after = backdrop_count(&w, &id).await;
        if after > before && before > 0 {
            w.move_image(&id, kind, after - 1, 0).await?;
        }
        lock_after_edit(&state, &w, &id).await;
        resync(&state, &id).await;
        return Ok(());
    }

    let backup = backup_current(&state, &w, &id, kind).await?;
    let entry = state
        .store()?
        .journal_add("image", &format!("{id}|{kind}|0"), &backup, &url)?;
    if let Err(e) = w.download_remote_image(&id, kind, &url).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    lock_after_edit(&state, &w, &id).await;
    resync(&state, &id).await;
    Ok(())
}

async fn backdrop_count(w: &crate::jellyfin::Writer, id: &str) -> u32 {
    w.reader()
        .image_list(id)
        .await
        .map(|l| l.iter().filter(|i| i.get("ImageType").and_then(Value::as_str) == Some("Backdrop")).count() as u32)
        .unwrap_or(0)
}

/// Makes another backdrop the main one (moves it to the front). Nothing is removed.
#[tauri::command]
pub async fn main_backdrop(state: State<'_, AppState>, id: String, index: u32) -> Result<()> {
    check_id(&id)?;
    if index > 50 {
        return Err(Error::msg("bad index"));
    }
    let w = state.writer().await?;
    w.move_image(&id, "Backdrop", index, 0).await?;
    lock_after_edit(&state, &w, &id).await;
    Ok(())
}

/// Removes one picture. A copy is kept so it can be put back with Undo.
#[tauri::command]
pub async fn remove_image(state: State<'_, AppState>, id: String, kind: String, index: u32) -> Result<()> {
    check_id(&id)?;
    let kind = image_kind(&kind).ok_or_else(|| Error::msg("bad image kind"))?;
    if index > 50 {
        return Err(Error::msg("bad index"));
    }
    let w = state.writer().await?;
    let Some((bytes, ct)) = w.reader().image_original(&id, kind, index).await? else {
        return Err(Error::msg("That picture is already gone."));
    };
    let dir = state.dir.join("backups");
    std::fs::create_dir_all(&dir)?;
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("{id}-{kind}-{index}-{stamp}.{}", ext_for(&ct)));
    std::fs::write(&path, bytes)?;
    let entry = state.store()?.journal_add(
        "image_removed",
        &format!("{id}|{kind}|{index}"),
        &format!("{}|{}", path.to_string_lossy(), ct),
        "",
    )?;
    if let Err(e) = w.delete_image(&id, kind, index).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    lock_after_edit(&state, &w, &id).await;
    resync(&state, &id).await;
    Ok(())
}

/// Fills in missing pictures of the given kinds with the best-rated option online.
/// Returns the kinds that were added.
#[tauri::command]
pub async fn fill_missing_art(state: State<'_, AppState>, id: String, kinds: Vec<String>, lang: Option<String>) -> Result<Vec<String>> {
    check_id(&id)?;
    let w = state.writer().await?;
    let have: Vec<String> = w
        .reader()
        .image_list(&id)
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|i| i.get("ImageType").and_then(Value::as_str).map(String::from))
        .collect();
    let lang = lang.unwrap_or_else(|| "en".into());
    let mut added = Vec::new();
    for k in kinds.iter().take(8) {
        let Some(kind) = image_kind(k) else { continue };
        if have.iter().any(|h| h == kind) {
            continue;
        }
        let options = w.reader().remote_images(&id, kind).await.unwrap_or_default();
        let Some(url) = best_image(&options, kind, &lang) else { continue };
        if crate::images::allowed_remote(&url).is_none() {
            continue;
        }
        let entry = state.store()?.journal_add("image", &format!("{id}|{kind}|0"), "", &url)?;
        match w.download_remote_image(&id, kind, &url).await {
            Ok(()) => added.push(kind.to_string()),
            Err(_) => state.store()?.journal_delete(entry)?,
        }
    }
    if !added.is_empty() {
        resync(&state, &id).await;
    }
    Ok(added)
}

/// Best picture: your language (or no text for backdrops), then rating, votes and size.
pub fn best_image(options: &[Value], kind: &str, lang: &str) -> Option<String> {
    let lang2: String = lang.chars().take(2).collect::<String>().to_lowercase();
    let score = |o: &Value| -> f64 {
        let l = o.get("Language").and_then(Value::as_str).unwrap_or("").to_lowercase();
        let lang_score = if kind == "Backdrop" {
            if l.is_empty() { 3.0 } else if l == lang2 { 2.0 } else { 0.0 }
        } else if l == lang2 {
            3.0
        } else if l == "en" {
            2.0
        } else if l.is_empty() {
            1.0
        } else {
            0.0
        };
        let rating = o.get("CommunityRating").and_then(Value::as_f64).unwrap_or(0.0);
        let votes = o.get("VoteCount").and_then(Value::as_f64).unwrap_or(0.0);
        let width = o.get("Width").and_then(Value::as_f64).unwrap_or(0.0);
        lang_score * 100.0 + rating * 5.0 + votes.min(50.0) * 0.2 + (width / 1000.0).min(4.0)
    };
    options
        .iter()
        .filter(|o| o.get("Url").and_then(Value::as_str).is_some())
        .max_by(|a, b| score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal))
        .and_then(|o| o.get("Url").and_then(Value::as_str).map(String::from))
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
    if ch.action == "subtitle_timing" {
        crate::subsync::undo_timing(&ch.old_value)?;
        state.store()?.journal_mark_undone(change_id)?;
        if let (Ok(w), true) = (state.writer().await, valid_item_id(&ch.target)) {
            let _ = w.refresh_light(&ch.target).await;
        }
        return Ok(());
    }
    if ch.action == "file_trashed" {
        crate::library::undo_trash(&ch.old_value)?;
        state.store()?.journal_mark_undone(change_id)?;
        if let Ok(c) = state.reader().await {
            let _ = c.library_scan().await;
        }
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
        "image_removed" => {
            let mut parts = ch.target.split('|');
            let (Some(id), Some(kind)) = (parts.next(), parts.next()) else {
                return Err(Error::msg("bad journal entry"));
            };
            check_id(id)?;
            let (path, ct) = ch.old_value.rsplit_once('|').ok_or_else(|| Error::msg("bad journal entry"))?;
            let bytes = std::fs::read(path).map_err(|_| Error::msg("The backup picture is missing."))?;
            // Index 0 replaces the main picture; for backdrops Jellyfin adds it back at the end.
            w.upload_image(id, kind, 0, &bytes, ct).await?;
        }
        "library_options" => {
            check_id(&ch.target)?;
            crate::library::undo_library_options(&w, &ch.target, &ch.old_value).await?;
        }
        "task_triggers" => {
            crate::backend::undo_task_triggers(&w, &ch.target, &ch.old_value).await?;
        }
        "collection" => {
            crate::collections::undo(&w, &ch.target, &ch.old_value, &ch.new_value).await?;
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
    let w = state.writer().await?;
    unlock_for_refresh(&w, &id).await?;
    w.refresh(&id, replace_all).await
}

#[tauri::command]
pub fn set_read_only(state: State<'_, AppState>, value: bool) -> Result<()> {
    state.update_settings(|s| s.read_only = value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn best_picture_prefers_language_then_rating() {
        let opts = vec![
            serde_json::json!({"Url": "https://image.tmdb.org/a.jpg", "Language": "de", "CommunityRating": 9.0}),
            serde_json::json!({"Url": "https://image.tmdb.org/b.jpg", "Language": "en", "CommunityRating": 5.0}),
            serde_json::json!({"Url": "https://image.tmdb.org/c.jpg", "Language": "nl", "CommunityRating": 4.0}),
            serde_json::json!({"Url": "https://image.tmdb.org/d.jpg", "CommunityRating": 8.0}),
        ];
        assert_eq!(best_image(&opts, "Primary", "nl-NL").as_deref(), Some("https://image.tmdb.org/c.jpg"));
        assert_eq!(best_image(&opts, "Primary", "fr").as_deref(), Some("https://image.tmdb.org/b.jpg"));
        assert_eq!(best_image(&opts, "Backdrop", "fr").as_deref(), Some("https://image.tmdb.org/d.jpg"));
        assert_eq!(best_image(&[], "Logo", "en"), None);
    }

    #[test]
    fn recognises_pictures_by_content() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<svg onload=alert(1)>"), None);
    }
}
