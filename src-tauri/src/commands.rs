use crate::config;
use crate::error::{Error, Result};
use crate::picks;
use crate::secrets;
use crate::state::AppState;
use crate::store::ItemRow;
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

const PAGE: u64 = 500;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    connected: bool,
    server_url: Option<String>,
    server_name: Option<String>,
    library_root: Option<String>,
    sub_langs: Vec<String>,
    title_lang: String,
    has_tmdb: bool,
    sync_watched: bool,
    user_id: Option<String>,
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
        title_lang: s.title_lang,
        has_tmdb: s.has_tmdb,
        sync_watched: s.sync_watched,
        user_id: s.user_id.clone(),
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
    let mut client = crate::jellyfin::Client::new(&base, &key)?;
    client.ping().await?;
    let info = client.system_info().await?;
    let user = client.pick_user().await?;
    client.user = Some(user.clone());

    secrets::save(&key)?;
    state.set_key(Some(key))?;
    let name = info.server_name.clone();
    state.update_settings(|s| {
        s.server_url = Some(base);
        s.server_name = Some(name);
        s.user_id = Some(user);
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
        s.user_id = None;
    })?;
    state.store()?.clear()?;
    Ok(())
}

#[tauri::command]
pub async fn sync_library(state: State<'_, AppState>) -> Result<SyncResult> {
    let client = state.reader().await?;
    let views = client.views().await.unwrap_or_default();

    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // One pass per library, so every title knows which library it is in.
    let parents: Vec<(Option<String>, String)> = if views.is_empty() {
        vec![(None, String::new())]
    } else {
        views.iter().map(|(id, _, _)| (Some(id.clone()), id.clone())).collect()
    };
    for (parent, lib) in &parents {
        let mut start = 0u64;
        loop {
            let page = client.items_page(parent.as_deref(), start, PAGE).await?;
            let got = page.items.len() as u64;
            for it in page.items.into_iter().filter_map(|i| i.into_new(lib)) {
                if seen.insert(it.id.clone()) {
                    items.push(it);
                }
            }
            start += got;
            if got == 0 || start >= page.total_record_count {
                break;
            }
        }
    }

    let mut store = state.store()?;
    store.replace_all(&items, &views, now())?;
    let c = store.counts()?;
    Ok(SyncResult {
        movies: c.movies,
        series: c.series,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn list_items(
    state: State<'_, AppState>,
    kind: Option<String>,
    library: Option<String>,
    flag: Option<String>,
    query: Option<String>,
    sort: String,
    offset: i64,
    limit: i64,
) -> Result<Vec<ItemRow>> {
    state
        .store()?
        .list(kind.as_deref(), library.as_deref(), flag.as_deref(), query.as_deref(), &sort, offset, limit)
}

#[tauri::command]
pub fn libraries(state: State<'_, AppState>) -> Result<Vec<crate::store::LibraryInfo>> {
    state.store()?.libraries()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttentionInfo {
    unmatched: i64,
    no_poster: i64,
    no_subtitles: Option<u64>,
}

#[tauri::command]
pub async fn attention(state: State<'_, AppState>) -> Result<AttentionInfo> {
    let a = state.store()?.attention()?;
    let no_subtitles = match state.reader().await {
        Ok(c) => c.count_without_subtitles().await.ok(),
        Err(_) => None,
    };
    Ok(AttentionInfo { unmatched: a.unmatched, no_poster: a.no_poster, no_subtitles })
}

#[tauri::command]
pub async fn missing_subtitles(state: State<'_, AppState>, start: u64, limit: u64) -> Result<serde_json::Value> {
    state.reader().await?.without_subtitles(start, limit).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    /// Item to open (movie, show or episode).
    id: String,
    /// Item whose wide picture is shown (the show for an episode).
    art_id: String,
    title: String,
    why: String,
    meta: String,
}

fn minutes(v: &serde_json::Value) -> Option<i64> {
    v.get("RunTimeTicks").and_then(|t| t.as_f64()).map(|t| (t / 600_000_000.0).round() as i64)
}

fn fmt_minutes(m: i64) -> String {
    if m >= 60 {
        format!("{} h {} min", m / 60, m % 60)
    } else {
        format!("{m} min")
    }
}

fn episode_pick(e: &serde_json::Value, why: &str) -> Option<Pick> {
    let s = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let id = s("Id");
    if id.is_empty() {
        return None;
    }
    let is_episode = s("Type") == "Episode";
    let code = match (e.get("ParentIndexNumber").and_then(|v| v.as_i64()), e.get("IndexNumber").and_then(|v| v.as_i64())) {
        (Some(se), Some(ep)) => format!("S{se:02}E{ep:02}"),
        _ => String::new(),
    };
    let mut meta = vec![if is_episode { code } else { "Movie".into() }];
    if let Some(m) = minutes(e) {
        meta.push(fmt_minutes(m));
    }
    Some(Pick {
        art_id: if is_episode { s("SeriesId").replace('-', "") } else { id.replace('-', "") },
        id: id.replace('-', ""),
        title: if is_episode { s("SeriesName") } else { s("Name") },
        why: why.to_string(),
        meta: meta.into_iter().filter(|m| !m.is_empty()).collect::<Vec<_>>().join(" · "),
    })
}

/// Up to twelve picks for today: something you left halfway, the next episode, then one from
/// several shelves (unwatched, top rated, your genres, quick movies, …). Same picks all day, new ones tomorrow.
#[tauri::command]
pub async fn todays_picks(state: State<'_, AppState>, date: String) -> Result<Vec<Pick>> {
    if !picks::valid_date(&date) {
        return Err(Error::msg("bad date"));
    }
    let client = state.reader().await.ok();
    let mut out: Vec<Pick> = Vec::new();
    let choose = |list: &[serde_json::Value], salt: &str| -> Option<serde_json::Value> {
        let ids: Vec<String> = list.iter().filter_map(|v| v.get("Id").and_then(|i| i.as_str()).map(String::from)).collect();
        let id = picks::pick_ids(&ids, &date, salt, 1).into_iter().next()?;
        list.iter().find(|v| v.get("Id").and_then(|i| i.as_str()) == Some(id.as_str())).cloned()
    };
    if let Some(c) = &client {
        if let Ok(list) = c.resume().await {
            if let Some(p) = choose(&list, "resume").and_then(|v| episode_pick(&v, "Left halfway")) {
                out.push(p);
            }
        }
        if let Ok(list) = c.next_up().await {
            let short: Vec<serde_json::Value> = list.iter().filter(|e| minutes(e).map(|m| m <= 15).unwrap_or(false)).cloned().collect();
            if let Some(p) = choose(&short, "short").and_then(|v| episode_pick(&v, "Short one tonight")) {
                out.push(p);
            }
            if let Some(p) = choose(&list, "next").and_then(|v| episode_pick(&v, "Next episode")) {
                if !out.iter().any(|o| o.art_id == p.art_id) {
                    out.push(p);
                }
            }
        }
    }
    let rows = state.store()?.pick_rows()?;
    for (why, salt, list) in pick_shelves(&rows) {
        if out.len() >= MAX_PICKS {
            break;
        }
        let ids: Vec<String> = list.iter().map(|r| r.id.clone()).collect();
        for id in picks::pick_ids(&ids, &date, salt, 6) {
            if out.iter().any(|o| o.art_id == id) {
                continue;
            }
            if let Some(r) = list.iter().find(|r| r.id == id) {
                let meta = match r.kind.as_str() {
                    "series" => r.episodes.map(|e| format!("{e} episodes")).unwrap_or_else(|| "Show".into()),
                    _ => format!("Movie{}", r.runtime.map(|m| format!(" · {}", fmt_minutes(m.round() as i64))).unwrap_or_default()),
                };
                let meta = match r.year {
                    Some(y) => format!("{y} · {meta}"),
                    None => meta,
                };
                out.push(Pick { id: r.id.clone(), art_id: r.id.clone(), title: r.name.clone(), why, meta });
                break;
            }
        }
    }
    out.truncate(MAX_PICKS);
    Ok(out)
}

const MAX_PICKS: usize = 12;

/// The shelves picks are drawn from, one pick each, in this order.
fn pick_shelves(rows: &[crate::store::ItemRow]) -> Vec<(String, &'static str, Vec<&crate::store::ItemRow>)> {
    let f = |p: &dyn Fn(&crate::store::ItemRow) -> bool| rows.iter().filter(|r| p(r)).collect::<Vec<_>>();
    let movie = |r: &crate::store::ItemRow| r.kind == "movie";
    let show = |r: &crate::store::ItemRow| r.kind == "series";
    // A genre you watch a lot, for "Because you like …".
    let mut genre_count: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for r in rows.iter().filter(|r| r.played) {
        for g in &r.genres {
            *genre_count.entry(g.as_str()).or_default() += 1;
        }
    }
    let mut top: Vec<(&str, usize)> = genre_count.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let mut shelves: Vec<(String, &'static str, Vec<&crate::store::ItemRow>)> = vec![
        ("Unwatched".into(), "unwatched-movie", f(&|r| movie(r) && !r.played)),
        ("New to you".into(), "unwatched-show", f(&|r| show(r) && !r.played)),
        ("Top rated".into(), "top", f(&|r| !r.played && r.rating.unwrap_or(0.0) >= 7.5)),
    ];
    for (i, (g, _)) in top.iter().take(2).enumerate() {
        let g = g.to_string();
        let list = f(&|r| !r.played && r.genres.iter().any(|x| *x == g));
        shelves.push((format!("Because you like {g}"), if i == 0 { "genre1" } else { "genre2" }, list));
    }
    shelves.extend([
        ("Quick movie".to_string(), "quick", f(&|r| movie(r) && !r.played && r.runtime.map(|m| m > 0.0 && m <= 95.0).unwrap_or(false))),
        ("Something to binge".to_string(), "binge", f(&|r| show(r) && !r.played && r.episodes.unwrap_or(0) >= 20)),
        ("Hidden gem".to_string(), "gem", f(&|r| !r.played && r.rating.unwrap_or(0.0) >= 7.0 && r.year.map(|y| y < 2010).unwrap_or(false))),
        ("Throwback".to_string(), "throwback", f(&|r| r.year.map(|y| y < 2000).unwrap_or(false))),
        ("Rewatch".to_string(), "rewatch", f(&|r| movie(r) && r.played)),
        ("Old favourite".to_string(), "fav", f(&|r| show(r) && r.played)),
        ("From your library".to_string(), "any", f(&|_| true)),
    ]);
    shelves
}

/// Saves a TMDB API key (or read access token) after checking that TMDB accepts it.
#[tauri::command]
pub async fn set_tmdb_key(state: State<'_, AppState>, key: String) -> Result<()> {
    let key = key.trim().to_string();
    if key.is_empty() {
        secrets::clear_tmdb()?;
        return state.update_settings(|s| s.has_tmdb = false);
    }
    if key.len() > 400 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(Error::msg("That does not look like a TMDB key."));
    }
    let lang = state.settings()?.title_lang;
    crate::sources::Tmdb::new(&key, &lang).check().await?;
    secrets::save_tmdb(&key)?;
    state.update_settings(|s| s.has_tmdb = true)
}

#[tauri::command]
pub fn set_title_lang(state: State<'_, AppState>, lang: String) -> Result<()> {
    if lang.len() > 10 || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(Error::msg("bad language"));
    }
    state.update_settings(|s| s.title_lang = lang)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    id: String,
    name: String,
    admin: bool,
}

#[tauri::command]
pub async fn list_users(state: State<'_, AppState>) -> Result<Vec<UserInfo>> {
    let users = state.reader().await?.users().await?;
    Ok(users.into_iter().map(|(id, name, admin)| UserInfo { id, name, admin }).collect())
}

/// Which Jellyfin user's watched status, resume points and picks the app uses.
#[tauri::command]
pub async fn set_user(state: State<'_, AppState>, id: String) -> Result<()> {
    let users = state.reader().await?.users().await?;
    if !users.iter().any(|(u, _, _)| *u == id) {
        return Err(Error::msg("Unknown user."));
    }
    state.update_settings(|s| s.user_id = Some(id))
}

#[tauri::command]
pub fn set_sync_watched(state: State<'_, AppState>, value: bool) -> Result<()> {
    state.update_settings(|s| s.sync_watched = value)
}
