use crate::config;
use crate::error::{Error, Result};
use crate::jellyfin::RawItem;
use crate::picks;
use crate::secrets;
use crate::state::AppState;
use crate::store::ItemRow;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const PAGE: u64 = 500;
const PICKS_PER_KIND: usize = 2;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    connected: bool,
    server_url: Option<String>,
    server_name: Option<String>,
    library_root: Option<String>,
    sub_langs: Vec<String>,
    read_only: bool,
    movies: i64,
    series: i64,
    last_sync: Option<i64>,
    /// Set when the saved key could not be read from the key storage.
    problem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    server_name: String,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    movies: i64,
    series: i64,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn status(state: State<'_, AppState>) -> Result<Status> {
    let s = state.settings()?;
    let counts = state.store()?.counts()?;
    let (connected, problem) = match state.client() {
        Ok(c) => (c.is_some(), None),
        Err(e) => (false, Some(e.to_string())),
    };
    Ok(Status {
        connected,
        server_url: s.server_url,
        server_name: s.server_name,
        library_root: s.library_root,
        sub_langs: s.sub_langs,
        read_only: s.read_only,
        movies: counts.movies,
        series: counts.series,
        last_sync: counts.last_sync,
        problem,
    })
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, url: String, api_key: String) -> Result<ConnectResult> {
    let base = config::normalize_server_url(&url)?;
    let key = api_key.trim().to_string();
    if !config::valid_key(&key) {
        return Err(Error::msg(
            "That does not look like a Jellyfin API key. It is letters and digits only, usually 32 characters.",
        ));
    }
    let client = crate::jellyfin::Client::new(&base, &key)?;
    client.ping().await?;
    let info = client.system_info().await?;

    secrets::save(&key)?;
    state.set_key(Some(key))?;
    let name = info.server_name.clone();
    state.update_settings(|s| {
        s.server_url = Some(base);
        s.server_name = Some(name);
    })?;
    Ok(ConnectResult {
        server_name: info.server_name,
        version: info.version,
    })
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>) -> Result<()> {
    secrets::clear()?;
    state.set_key(None)?;
    state.update_settings(|s| {
        s.server_url = None;
        s.server_name = None;
    })?;
    state.store()?.clear()?;
    Ok(())
}

#[tauri::command]
pub async fn sync_library(state: State<'_, AppState>) -> Result<SyncResult> {
    let client = state
        .client()?
        .ok_or_else(|| Error::msg("Connect to your server first."))?;

    let mut items = Vec::new();
    let mut start = 0u64;
    loop {
        let page = client.items_page(start, PAGE).await?;
        let got = page.items.len() as u64;
        items.extend(page.items.into_iter().filter_map(RawItem::into_new));
        start += got;
        if got == 0 || start >= page.total_record_count {
            break;
        }
    }

    let mut store = state.store()?;
    store.replace_all(&items, now())?;
    let c = store.counts()?;
    Ok(SyncResult {
        movies: c.movies,
        series: c.series,
    })
}

#[tauri::command]
pub fn list_items(
    state: State<'_, AppState>,
    kind: Option<String>,
    query: Option<String>,
    sort: String,
    offset: i64,
    limit: i64,
) -> Result<Vec<ItemRow>> {
    state
        .store()?
        .list(kind.as_deref(), query.as_deref(), &sort, offset, limit)
}

/// `date` is the viewer's local day as YYYY-MM-DD, so "today" follows their clock.
#[tauri::command]
pub fn todays_picks(state: State<'_, AppState>, date: String) -> Result<Vec<ItemRow>> {
    if !picks::valid_date(&date) {
        return Err(Error::msg("bad date"));
    }
    let store = state.store()?;
    let mut ids = picks::pick_ids(&store.candidate_ids("movie")?, &date, "movie", PICKS_PER_KIND);
    ids.extend(picks::pick_ids(&store.candidate_ids("series")?, &date, "series", PICKS_PER_KIND));
    store.get_many(&ids)
}
