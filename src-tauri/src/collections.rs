//! Home page lists, collections and "more like this". Reading is always allowed; changing a
//! collection needs changes switched on and is journaled ("collection") so it can be undone.

use crate::error::{Error, Result};
use crate::jellyfin::{valid_item_id, Writer};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

/// One tile in a row: enough to draw it and open it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    id: String,
    /// "movie" | "series" | "episode" | "season" | "collection" | "person" | "other"
    kind: &'static str,
    title: String,
    subtitle: String,
    /// Item whose poster/backdrop is shown (the show for an episode).
    art_id: String,
    series_id: Option<String>,
    year: Option<i64>,
    /// 0..1 when partly watched.
    progress: Option<f64>,
    played: bool,
    has_poster: bool,
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn clean_id(id: &str) -> String {
    id.replace('-', "")
}

pub fn card(v: &Value) -> Option<Card> {
    let id = clean_id(s(v, "Id"));
    if !valid_item_id(&id) {
        return None;
    }
    let kind = match s(v, "Type") {
        "Movie" => "movie",
        "Series" => "series",
        "Episode" => "episode",
        "Season" => "season",
        "BoxSet" => "collection",
        "Person" => "person",
        _ => "other",
    };
    let series_id = Some(clean_id(s(v, "SeriesId"))).filter(|i| valid_item_id(i));
    let year = v.get("ProductionYear").and_then(Value::as_i64);
    let ud = v.get("UserData");
    let played = ud.and_then(|u| u.get("Played")).and_then(Value::as_bool).unwrap_or(false);
    let pos = ud.and_then(|u| u.get("PlaybackPositionTicks")).and_then(Value::as_f64).unwrap_or(0.0);
    let total = v.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0);
    let progress = (pos > 0.0 && total > 0.0).then(|| (pos / total).clamp(0.0, 1.0));
    let has_poster = v.get("ImageTags").and_then(|t| t.get("Primary")).is_some();
    let (title, subtitle, art_id) = match kind {
        "episode" => {
            let code = match (v.get("ParentIndexNumber").and_then(Value::as_i64), v.get("IndexNumber").and_then(Value::as_i64)) {
                (Some(a), Some(b)) => format!("S{a:02}E{b:02} · "),
                (None, Some(b)) => format!("E{b:02} · "),
                _ => String::new(),
            };
            (s(v, "SeriesName").to_string(), format!("{code}{}", s(v, "Name")), series_id.clone().unwrap_or_else(|| id.clone()))
        }
        "series" => {
            let n = v.get("ChildCount").and_then(Value::as_i64);
            (s(v, "Name").to_string(), n.map(|n| format!("{n} season{}", if n == 1 { "" } else { "s" })).unwrap_or_else(|| "Show".into()), id.clone())
        }
        "collection" => {
            let n = v.get("ChildCount").and_then(Value::as_i64).unwrap_or(0);
            (s(v, "Name").to_string(), format!("{n} title{}", if n == 1 { "" } else { "s" }), id.clone())
        }
        "person" => (s(v, "Name").to_string(), s(v, "Role").to_string(), id.clone()),
        _ => (s(v, "Name").to_string(), year.map(|y| y.to_string()).unwrap_or_default(), id.clone()),
    };
    Some(Card { id, kind, title, subtitle, art_id, series_id, year, progress, played, has_poster })
}

fn cards(list: &[Value]) -> Vec<Card> {
    list.iter().filter_map(card).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeFeed {
    resume: Vec<Card>,
    next_up: Vec<Card>,
    recent: Vec<Card>,
    collections: Vec<Card>,
}

#[tauri::command]
pub async fn home_feed(state: State<'_, AppState>) -> Result<HomeFeed> {
    let c = state.reader().await?;
    Ok(HomeFeed {
        resume: cards(&c.resume().await.unwrap_or_default()),
        next_up: cards(&c.next_up().await.unwrap_or_default()),
        recent: cards(&c.recently_added(40).await.unwrap_or_default()),
        collections: cards(&c.collections().await.unwrap_or_default()),
    })
}

#[tauri::command]
pub async fn collections_list(state: State<'_, AppState>) -> Result<Vec<Card>> {
    Ok(cards(&state.reader().await?.collections().await?))
}

#[tauri::command]
pub async fn collection_items(state: State<'_, AppState>, id: String) -> Result<Vec<Card>> {
    Ok(cards(&state.reader().await?.collection_items(&id).await?))
}

/// The collections a title is in.
#[tauri::command]
pub async fn collections_of(state: State<'_, AppState>, id: String) -> Result<Vec<Card>> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let c = state.reader().await?;
    let want = id.replace('-', "").to_lowercase();
    let mut out = Vec::new();
    for col in c.collections().await? {
        let cid = col.get("Id").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        if !valid_item_id(&cid.replace('-', "")) {
            continue;
        }
        let items = c.collection_items(&cid).await.unwrap_or_default();
        if items.iter().any(|v| v.get("Id").and_then(serde_json::Value::as_str).map(|x| x.replace('-', "").to_lowercase() == want).unwrap_or(false)) {
            out.push(col);
        }
    }
    Ok(cards(&out))
}

#[tauri::command]
pub async fn similar_items(state: State<'_, AppState>, id: String) -> Result<Vec<Card>> {
    Ok(cards(&state.reader().await?.similar(&id, 16).await?))
}

#[tauri::command]
pub async fn person_items(state: State<'_, AppState>, id: String) -> Result<Vec<Card>> {
    Ok(cards(&state.reader().await?.person_items(&id).await?))
}

fn check_ids(ids: &[String]) -> Result<()> {
    if ids.is_empty() || !ids.iter().all(|i| valid_item_id(i)) {
        return Err(Error::msg("Pick at least one title."));
    }
    Ok(())
}

fn ids_json(ids: &[String]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub async fn collection_create(state: State<'_, AppState>, name: String, ids: Vec<String>) -> Result<String> {
    if !ids.is_empty() {
        check_ids(&ids)?;
    }
    let w = state.writer().await?;
    let id = w.collection_create(&name, &ids).await?;
    state.store()?.journal_add("collection", &id, "created", &ids_json(&ids))?;
    Ok(id)
}

#[tauri::command]
pub async fn collection_add(state: State<'_, AppState>, id: String, ids: Vec<String>) -> Result<()> {
    check_ids(&ids)?;
    let w = state.writer().await?;
    let entry = state.store()?.journal_add("collection", &id, "added", &ids_json(&ids))?;
    if let Err(e) = w.collection_add(&id, &ids).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn collection_remove(state: State<'_, AppState>, id: String, ids: Vec<String>) -> Result<()> {
    check_ids(&ids)?;
    let w = state.writer().await?;
    let entry = state.store()?.journal_add("collection", &id, "removed", &ids_json(&ids))?;
    if let Err(e) = w.collection_remove(&id, &ids).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

/// Undo for the "collection" journal entries.
pub async fn undo(w: &Writer, id: &str, what: &str, ids_json: &str) -> Result<()> {
    let ids: Vec<String> = serde_json::from_str(ids_json).map_err(|_| Error::msg("bad journal entry"))?;
    match what {
        "added" => w.collection_remove(id, &ids).await,
        "removed" => w.collection_add(id, &ids).await,
        // Only ever removes the collection this app made; the titles in it stay.
        "created" => w.collection_delete(id).await,
        _ => Err(Error::msg("bad journal entry")),
    }
}

pub const PICKS_NAME: &str = "Picks of the day";

/// Keeps a Jellyfin collection called "Picks of the day" equal to today's picks, so Infuse
/// and every other Jellyfin app shows them too. Only touches that one collection.
#[tauri::command]
pub async fn sync_picks_collection(state: State<'_, AppState>, ids: Vec<String>) -> Result<String> {
    let ids: Vec<String> = ids.into_iter().filter(|i| valid_item_id(i)).take(30).collect();
    check_ids(&ids)?;
    let w = state.writer().await?;
    let existing = w
        .reader()
        .collections()
        .await?
        .into_iter()
        .find(|c| s(c, "Name") == PICKS_NAME)
        .map(|c| clean_id(s(&c, "Id")));
    let Some(cid) = existing.filter(|i| valid_item_id(i)) else {
        return w.collection_create(PICKS_NAME, &ids).await;
    };
    let current: Vec<String> = w
        .reader()
        .collection_items(&cid)
        .await?
        .iter()
        .map(|v| clean_id(s(v, "Id")))
        .filter(|i| valid_item_id(i))
        .collect();
    let gone: Vec<String> = current.iter().filter(|c| !ids.contains(c)).cloned().collect();
    let new: Vec<String> = ids.iter().filter(|i| !current.contains(i)).cloned().collect();
    if !gone.is_empty() {
        w.collection_remove(&cid, &gone).await?;
    }
    if !new.is_empty() {
        w.collection_add(&cid, &new).await?;
    }
    Ok(cid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episode_cards_point_at_the_show() {
        let v = serde_json::json!({
            "Id": "0123456789abcdef0123456789abcdef", "Type": "Episode", "Name": "Hotel",
            "SeriesName": "Bluey", "SeriesId": "fedcba9876543210fedcba9876543210",
            "ParentIndexNumber": 1, "IndexNumber": 5, "RunTimeTicks": 4000.0,
            "UserData": {"PlaybackPositionTicks": 1000.0}
        });
        let c = card(&v).unwrap();
        assert_eq!(c.kind, "episode");
        assert_eq!(c.title, "Bluey");
        assert_eq!(c.subtitle, "S01E05 · Hotel");
        assert_eq!(c.art_id, "fedcba9876543210fedcba9876543210");
        assert_eq!(c.progress, Some(0.25));
        assert!(card(&serde_json::json!({"Id": "../x", "Type": "Movie"})).is_none());
    }
}

/* ------------------------------------------- a collection's movies in one folder */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderPlan {
    plan_id: String,
    /// The folder the movies go into, relative to the library folder.
    folder: String,
    ops: Vec<crate::planner::PlanOp>,
    /// Movies that can't be moved, and why.
    skipped: Vec<String>,
}

/// "Alien Collection" → "Alien".
pub fn collection_folder_name(name: &str) -> String {
    let n = name.trim();
    let n = n.strip_suffix(" Collection").or_else(|| n.strip_suffix(" collection")).unwrap_or(n);
    crate::naming::sanitize(n.trim())
}

/// Plans moving every movie folder of a collection into one folder named after it, next to
/// where most of them are now ("Movies/Alien/Alien (1979)/…"). Nothing moves until applied;
/// it's one undoable batch.
#[tauri::command]
pub async fn collection_folder_plan(state: State<'_, AppState>, id: String, name: Option<String>) -> Result<FolderPlan> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let root = state.settings()?.library_root.map(std::path::PathBuf::from).ok_or_else(|| Error::msg("Choose your library folder in Settings first."))?;
    let c = state.reader().await?;
    let coll = c.item_json(&id).await?;
    let folder_name = collection_folder_name(name.as_deref().unwrap_or_else(|| coll.get("Name").and_then(Value::as_str).unwrap_or("Collection")));
    if folder_name.is_empty() {
        return Err(Error::msg("The collection needs a name."));
    }
    let items = c.items_query(vec![("ParentId", id.clone()), ("Fields", "Path".into()), ("IncludeItemTypes", "Movie".into())], 500).await?;
    let mut movie_dirs: Vec<(String, String)> = Vec::new(); // (name, folder rel)
    let mut skipped = Vec::new();
    for v in &items {
        let title = v.get("Name").and_then(Value::as_str).unwrap_or("?").to_string();
        let Some(server) = v.get("Path").and_then(Value::as_str) else { continue };
        let Ok(local) = crate::local::to_local(&state, server) else {
            skipped.push(format!("{title}: not found in your library folder"));
            continue;
        };
        let Some(dir) = local.parent().and_then(|d| crate::local::rel_to_root(&root, d)) else {
            skipped.push(format!("{title}: outside your library folder"));
            continue;
        };
        movie_dirs.push((title, dir));
    }
    // Where most of them live now.
    let mut parents: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (_, d) in &movie_dirs {
        *parents.entry(crate::naming::split_path(d).0.to_string()).or_default() += 1;
    }
    let base = parents.into_iter().max_by_key(|x| x.1).map(|x| x.0).unwrap_or_default();
    let base = if crate::naming::split_path(&base).1 == folder_name { crate::naming::split_path(&base).0.to_string() } else { base };
    let target_dir = if base.is_empty() { folder_name.clone() } else { format!("{base}/{folder_name}") };
    let mut ops = Vec::new();
    for (title, dir) in movie_dirs {
        let (parent, last) = crate::naming::split_path(&dir);
        if parent == target_dir {
            continue; // already there
        }
        if dir == base || last.is_empty() {
            skipped.push(format!("{title}: not in a folder of its own (give it one with the Renamer first)"));
            continue;
        }
        let to = format!("{target_dir}/{last}");
        let exists = root.join(&to).exists();
        ops.push(crate::planner::PlanOp {
            from: dir.clone(),
            to: to.clone(),
            kind: "folder",
            status: if exists { "conflict" } else { "ok" },
            note: exists.then(|| "A folder with that name is already there.".to_string()),
            season: None,
            episodes: Vec::new(),
            verified: true,
            score: None,
            step_to: to,
            title: Some(title),
        });
    }
    let plan_id = format!("coll-{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
    state.set_plan(crate::state::StoredPlan { id: plan_id.clone(), root, ops: ops.clone() })?;
    Ok(FolderPlan { plan_id, folder: target_dir, ops, skipped })
}

/// After moving movies: Jellyfin gives them new ids, which drops them from the collection.
/// Waits until it has found them again (by name and year) and puts them back. Background.
#[tauri::command]
pub async fn collection_relink(app: tauri::AppHandle, state: State<'_, AppState>, id: String, movies: Vec<(String, Option<i64>)>) -> Result<()> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let w = state.writer().await?;
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let norm = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
        let mut found: Vec<String> = Vec::new();
        for _ in 0..48 {
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_secs(5))).await.ok();
            found.clear();
            for (name, year) in &movies {
                let hits = w
                    .reader()
                    .items_query(vec![("IncludeItemTypes", "Movie".into()), ("Recursive", "true".into()), ("SearchTerm", name.chars().take(80).collect()), ("Fields", "ProductionYear".into())], 20)
                    .await
                    .unwrap_or_default();
                if let Some(v) = hits.iter().find(|v| norm(v.get("Name").and_then(Value::as_str).unwrap_or("")) == norm(name) && (year.is_none() || v.get("ProductionYear").and_then(Value::as_i64) == *year)) {
                    if let Some(i) = v.get("Id").and_then(Value::as_str) {
                        found.push(i.replace('-', ""));
                    }
                }
            }
            if found.len() == movies.len() {
                break;
            }
        }
        let ok = !found.is_empty() && w.collection_add(&id, &found).await.is_ok();
        let _ = app.emit("collection-relinked", serde_json::json!({ "id": id, "count": if ok { found.len() } else { 0 } }));
    });
    Ok(())
}
