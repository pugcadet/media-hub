//! Music: browse albums, artists and tracks from Jellyfin, and play them. Songs are fetched
//! whole as MP3 through the private `hubmedia://` address (with the key added here), so the
//! window can seek freely and never sees the server address or the key.

use crate::error::{Error, Result};
use crate::jellyfin::valid_item_id;
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MusicItem {
    id: String,
    /// "album" | "artist" | "track" | "playlist"
    kind: &'static str,
    name: String,
    artist: String,
    album: String,
    album_id: Option<String>,
    year: Option<i64>,
    index: Option<i64>,
    disc: Option<i64>,
    /// seconds
    duration: f64,
    /// Item whose picture to show (the album for a track).
    art_id: String,
    has_art: bool,
    count: Option<i64>,
    favorite: bool,
    /// Picture address for songs from a music folder (Jellyfin items use `art_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    art_url: Option<String>,
}

impl MusicItem {
    #[allow(clippy::too_many_arguments)]
    pub fn set_duration(&mut self, d: f64) {
        self.duration = d;
    }

    pub fn local(id: String, kind: &'static str, name: String, artist: String, album: String, album_id: Option<String>, year: Option<i64>, index: Option<i64>, disc: Option<i64>, art_url: Option<String>, count: Option<i64>) -> Self {
        MusicItem { id, kind, name, artist, album, album_id, year, index, disc, duration: 0.0, art_id: String::new(), has_art: art_url.is_some(), count, favorite: false, art_url }
    }
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn clean(id: &str) -> String {
    id.replace('-', "")
}

pub fn to_item(v: &Value) -> Option<MusicItem> {
    let id = clean(s(v, "Id"));
    if !valid_item_id(&id) {
        return None;
    }
    let kind = match s(v, "Type") {
        "MusicAlbum" => "album",
        "MusicArtist" => "artist",
        "Audio" => "track",
        "Playlist" => "playlist",
        _ => return None,
    };
    let album_id = Some(clean(s(v, "AlbumId"))).filter(|a| valid_item_id(a));
    let has_own = v.get("ImageTags").and_then(|t| t.get("Primary")).is_some();
    let album_art = v.get("AlbumPrimaryImageTag").and_then(Value::as_str).is_some();
    let art_id = if kind == "track" && !has_own && album_art { album_id.clone().unwrap_or_else(|| id.clone()) } else { id.clone() };
    let artist = v
        .get("AlbumArtist")
        .and_then(Value::as_str)
        .filter(|a| !a.is_empty())
        .map(String::from)
        .or_else(|| v.get("Artists").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")))
        .unwrap_or_default();
    Some(MusicItem {
        kind,
        name: s(v, "Name").to_string(),
        artist,
        album: s(v, "Album").to_string(),
        album_id,
        year: v.get("ProductionYear").and_then(Value::as_i64),
        index: v.get("IndexNumber").and_then(Value::as_i64),
        disc: v.get("ParentIndexNumber").and_then(Value::as_i64),
        duration: v.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / 10_000_000.0,
        has_art: has_own || album_art,
        art_id,
        count: v.get("ChildCount").and_then(Value::as_i64).or_else(|| v.get("SongCount").and_then(Value::as_i64)),
        favorite: v.pointer("/UserData/IsFavorite").and_then(Value::as_bool).unwrap_or(false),
        art_url: None,
        id,
    })
}

/// Lists music. `view`: "albums" | "artists" | "tracks" (of `parent`: an album or artist) |
/// "recent" | "favorites" | "songs" (every song) | "search".
#[tauri::command]
pub async fn music_list(app: tauri::AppHandle, state: State<'_, AppState>, view: String, parent: Option<String>, query: Option<String>, start: u64, limit: u64) -> Result<Vec<MusicItem>> {
    let query = query.unwrap_or_default().chars().take(100).collect::<String>();
    let settings = state.settings()?;
    if settings.music_from_folder && settings.music_dir.is_some() {
        let app2 = app.clone();
        let (view, parent, query) = (view.clone(), parent.clone(), query.clone());
        // Reading a big folder takes a moment: off the main thread.
        return tauri::async_runtime::spawn_blocking(move || crate::localmusic::list(&app2, &tauri::Manager::state::<AppState>(&app2), &view, parent.as_deref(), &query, start, limit))
            .await
            .map_err(|e| crate::error::Error::msg(e.to_string()))?;
    }
    let c = state.reader().await?;
    if view == "artists" {
        let v = c.album_artists(&query, start, limit).await?;
        return Ok(v.get("Items").and_then(Value::as_array).into_iter().flatten().filter_map(to_item).collect());
    }
    let fields = "ProductionYear,RunTimeTicks,ChildCount,AlbumArtist,Artists,Album,AlbumId,AlbumPrimaryImageTag,ParentIndexNumber,IndexNumber".to_string();
    let mut q: Vec<(&'static str, String)> = vec![("Recursive", "true".into()), ("Fields", fields), ("StartIndex", start.to_string())];
    match view.as_str() {
        "albums" => {
            q.push(("IncludeItemTypes", "MusicAlbum".into()));
            q.push(("SortBy", "AlbumArtist,ProductionYear,SortName".into()));
        }
        "recent" => {
            q.push(("IncludeItemTypes", "MusicAlbum".into()));
            q.push(("SortBy", "DateCreated".into()));
            q.push(("SortOrder", "Descending".into()));
        }
        "favorites" => {
            q.push(("IncludeItemTypes", "Audio,MusicAlbum".into()));
            q.push(("Filters", "IsFavorite".into()));
            q.push(("SortBy", "SortName".into()));
        }
        "tracks" => {
            let p = parent.filter(|p| valid_item_id(p)).ok_or_else(|| Error::msg("bad id"))?;
            let item = c.item_json(&p).await?;
            if s(&item, "Type") == "MusicArtist" {
                q.push(("ArtistIds", p));
                q.push(("SortBy", "Album,ParentIndexNumber,IndexNumber,SortName".into()));
            } else {
                q.push(("ParentId", p));
                q.push(("SortBy", "ParentIndexNumber,IndexNumber,SortName".into()));
            }
            q.push(("IncludeItemTypes", "Audio".into()));
        }
        "artist_albums" => {
            let p = parent.filter(|p| valid_item_id(p)).ok_or_else(|| Error::msg("bad id"))?;
            q.push(("AlbumArtistIds", p));
            q.push(("IncludeItemTypes", "MusicAlbum".into()));
            q.push(("SortBy", "ProductionYear,SortName".into()));
            q.push(("SortOrder", "Descending".into()));
        }
        "songs" => {
            q.push(("IncludeItemTypes", "Audio".into()));
            q.push(("SortBy", "AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName".into()));
        }
        "search" => {
            q.push(("IncludeItemTypes", "Audio,MusicAlbum".into()));
            q.push(("SearchTerm", query.clone()));
        }
        _ => return Err(Error::msg("bad view")),
    }
    if !query.is_empty() && view != "search" {
        q.push(("SearchTerm", query));
    }
    let items = c.items_query(q, limit.clamp(1, 2000) as usize).await?;
    Ok(items.iter().filter_map(to_item).collect())
}

/// Starts a song: returns a private address that delivers it as MP3.
#[tauri::command]
pub async fn music_play(state: State<'_, AppState>, id: String) -> Result<String> {
    if id.starts_with('L') {
        return crate::localmusic::play_url(&id);
    }
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let _ = state.reader().await?; // connected?
    crate::player::audio_session(&id)
}

#[tauri::command]
pub fn music_stop(token: String) {
    crate::player::end_audio_session(&token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_borrow_the_album_picture() {
        let v = serde_json::json!({
            "Id": "0123456789abcdef0123456789abcdef", "Type": "Audio", "Name": "Song", "AlbumId": "fedcba9876543210fedcba9876543210",
            "AlbumPrimaryImageTag": "x", "Artists": ["A", "B"], "RunTimeTicks": 1_800_000_000i64, "IndexNumber": 3
        });
        let t = to_item(&v).unwrap();
        assert_eq!(t.kind, "track");
        assert_eq!(t.art_id, "fedcba9876543210fedcba9876543210");
        assert_eq!(t.artist, "A, B");
        assert!((t.duration - 180.0).abs() < 1e-9);
        assert!(to_item(&serde_json::json!({"Id": "0123456789abcdef0123456789abcdef", "Type": "Movie"})).is_none());
    }
}
