//! Whole-library views: health per title, missing episodes, duplicates, genre/tag cleanup,
//! episode stills from the video, alerts, the picks playlist and the undo center.
//! Reading is always allowed; every change needs changes switched on and is journaled.

use crate::error::{Error, Result};
use crate::jellyfin::{valid_item_id, Client};
use crate::local;
use crate::media_tools;
use crate::sources::{self, EpInfo};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn clean_id(id: &str) -> String {
    id.replace('-', "")
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn check_id(id: &str) -> Result<()> {
    if valid_item_id(id) {
        Ok(())
    } else {
        Err(Error::msg("bad id"))
    }
}

/* ------------------------------------------------------------------ health */

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthRow {
    id: String,
    kind: String,
    name: String,
    year: Option<i64>,
    identified: bool,
    poster: bool,
    backdrop: bool,
    logo: bool,
    thumb: bool,
    banner: bool,
    /// Episodes (shows) or 1 (movies).
    videos: i64,
    /// Videos without any subtitles.
    no_subs: i64,
    library_folder: String,
    /// Where it is, as Jellyfin sees it (for "leave this folder alone" settings).
    #[serde(default)]
    path: String,
}

fn has_img(v: &Value, kind: &str) -> bool {
    if kind == "Backdrop" {
        return v.get("BackdropImageTags").and_then(Value::as_array).map(|a| !a.is_empty()).unwrap_or(false);
    }
    v.get("ImageTags").and_then(|t| t.get(kind)).is_some()
}

fn identified(v: &Value) -> bool {
    v.get("ProviderIds")
        .and_then(Value::as_object)
        .map(|p| ["Tmdb", "Tvdb"].iter().any(|k| p.get(*k).and_then(Value::as_str).map(|x| !x.is_empty()).unwrap_or(false)))
        .unwrap_or(false)
}

#[derive(Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    at: u64,
    rows: Vec<HealthRow>,
}

fn health_path(state: &AppState) -> PathBuf {
    state.dir.join("health.json")
}

/// The last health check (instant), or a new one when `fresh` (sends "health-progress").
#[tauri::command]
pub async fn library_health(app: AppHandle, state: State<'_, AppState>, fresh: bool) -> Result<HealthResult> {
    if !fresh {
        if let Some(r) = std::fs::read(health_path(&state)).ok().and_then(|b| serde_json::from_slice::<HealthResult>(&b).ok()) {
            // Checks saved by older versions have no file locations, so folders you switched
            // off for subtitles couldn't be left out: those are checked again.
            let has_paths = r.rows.is_empty() || r.rows.iter().any(|x| !x.path.is_empty());
            if has_paths {
                let mut r = r;
                if let Ok(known) = state.store().and_then(|s| s.known_ids()) {
                    if !known.is_empty() {
                        r.rows.retain(|x| known.contains(&x.id.replace('-', "")));
                    }
                }
                return Ok(r);
            }
        }
    }
    let rows = health_rows(&app, &state).await?;
    let r = HealthResult { at: now_secs(), rows };
    if let Ok(b) = serde_json::to_vec(&r) {
        let _ = std::fs::write(health_path(&state), b);
    }
    Ok(r)
}

fn progress(app: &AppHandle, done: u32, total: u32, label: &str) {
    let _ = app.emit("health-progress", serde_json::json!({ "done": done, "total": total, "label": label }));
}

async fn health_rows(app: &AppHandle, state: &AppState) -> Result<Vec<HealthRow>> {
    crate::cancel::begin("health");
    progress(app, 0, 3, "Reading shows and movies");
    let c = state.reader().await?;
    let titles = c
        .items_query(
            vec![
                ("IncludeItemTypes", "Series,Movie".into()),
                ("Recursive", "true".into()),
                ("Fields", "ProviderIds,Path,RecursiveItemCount,ProductionYear".into()),
                ("SortBy", "SortName".into()),
                ("EnableUserData", "false".into()),
                ("ImageTypeLimit", "1".into()),
            ],
            20_000,
        )
        .await?;
    crate::cancel::check("health")?;
    progress(app, 1, 3, "Finding videos without subtitles");
    let no_subs = c
        .items_query(
            vec![
                ("IncludeItemTypes", "Episode,Movie".into()),
                ("Recursive", "true".into()),
                ("HasSubtitles", "false".into()),
                ("Fields", "SeriesId".into()),
                ("EnableImages", "false".into()),
                ("EnableUserData", "false".into()),
            ],
            100_000,
        )
        .await
        .unwrap_or_default();
    let mut count: HashMap<String, i64> = HashMap::new();
    for e in &no_subs {
        let key = if s(e, "Type") == "Episode" { clean_id(s(e, "SeriesId")) } else { clean_id(s(e, "Id")) };
        *count.entry(key).or_default() += 1;
    }
    crate::cancel::check("health")?;
    progress(app, 2, 3, "Putting it together");
    let root = state.settings()?.library_root;
    let map = state.settings()?.path_map;
    let rows: Vec<HealthRow> = titles
        .iter()
        .filter_map(|v| {
            let id = clean_id(s(v, "Id"));
            if !valid_item_id(&id) {
                return None;
            }
            let series = s(v, "Type") == "Series";
            let path = s(v, "Path");
            // The folder right under the library root ("TV", "Movies", "Kids" …).
            let lib = root
                .as_deref()
                // Only with a known path mapping: guessing one would touch the NAS for every title.
                .filter(|_| map.is_some())
                .and_then(|r| media_tools::map_path(path, map.as_ref(), Some(Path::new(r))).map(|(p, _)| (r, p)))
                .and_then(|(r, p)| local::rel_to_root(Path::new(r), &p))
                .and_then(|rel| rel.split('/').next().map(String::from))
                .unwrap_or_default();
            Some(HealthRow {
                kind: if series { "series".into() } else { "movie".into() },
                name: s(v, "Name").to_string(),
                year: v.get("ProductionYear").and_then(Value::as_i64),
                identified: identified(v),
                poster: has_img(v, "Primary"),
                backdrop: has_img(v, "Backdrop"),
                logo: has_img(v, "Logo"),
                thumb: has_img(v, "Thumb"),
                banner: has_img(v, "Banner"),
                videos: if series { v.get("RecursiveItemCount").and_then(Value::as_i64).unwrap_or(0) } else { 1 },
                no_subs: count.get(&id).copied().unwrap_or(0),
                library_folder: lib,
                path: path.to_string(),
                id,
            })
        })
        .collect();
    progress(app, 3, 3, "");
    Ok(rows)
}

/* ---------------------------------------------------------- missing episodes */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingReport {
    source: String,
    have: usize,
    known: usize,
    missing: Vec<EpInfo>,
    /// Not aired yet.
    upcoming: Vec<EpInfo>,
    specials_missing: usize,
}

/// Compares a show's files with the episode list online (TMDB with a key, else TVmaze).
#[tauri::command]
pub async fn missing_episodes(state: State<'_, AppState>, series_id: String) -> Result<MissingReport> {
    check_id(&series_id)?;
    let c = state.reader().await?;
    let item = c.item_json(&series_id).await?;
    let ids = item.get("ProviderIds").cloned().unwrap_or(Value::Null);
    let pid = |k: &str| ids.get(k).and_then(Value::as_str).filter(|x| !x.is_empty()).map(String::from);
    let (tmdb, tvdb, imdb) = (pid("Tmdb"), pid("Tvdb"), pid("Imdb"));

    let mut list: Option<(String, Vec<EpInfo>)> = None;
    if let Some(t) = crate::rename_cmds::tmdb_client(&state) {
        let id = match tmdb.clone() {
            Some(id) => Some(id),
            None => t.find_tv(tvdb.as_deref(), imdb.as_deref()).await.ok().flatten(),
        };
        if let Some(id) = id {
            if let Ok(l) = t.episode_list(&id).await {
                list = Some(("TMDB".into(), l));
            }
        }
    }
    if list.is_none() {
        if let Some(id) = sources::tvmaze_lookup(tvdb.as_deref(), imdb.as_deref()).await? {
            list = Some(("TVmaze".into(), sources::tvmaze_episode_list(&id).await?));
        }
    }
    let (source, known) = list.ok_or_else(|| Error::msg("This show isn't linked to TMDB, TVDB or IMDb yet. Identify it first."))?;

    let eps = c
        .items_query(
            vec![
                ("ParentId", series_id.clone()),
                ("IncludeItemTypes", "Episode".into()),
                ("Recursive", "true".into()),
                ("Fields", "Path".into()),
            ],
            5000,
        )
        .await?;
    let mut have: HashSet<(u32, u32)> = HashSet::new();
    for e in eps.iter().filter(|e| !s(e, "Path").is_empty() && s(e, "LocationType") != "Virtual") {
        let (Some(sn), Some(a)) = (e.get("ParentIndexNumber").and_then(Value::as_u64), e.get("IndexNumber").and_then(Value::as_u64)) else { continue };
        let b = e.get("IndexNumberEnd").and_then(Value::as_u64).unwrap_or(a).max(a);
        for n in a..=b.min(a + 20) {
            have.insert((sn as u32, n as u32));
        }
    }
    Ok(compare_episodes(&source, &known, &have, &today()))
}

fn today() -> String {
    let days = (now_secs() / 86_400) as i64;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{:04}-{:02}-{:02}", if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn compare_episodes(source: &str, known: &[EpInfo], have: &HashSet<(u32, u32)>, today: &str) -> MissingReport {
    let mut missing = Vec::new();
    let mut upcoming = Vec::new();
    let mut specials = 0;
    for e in known {
        if have.contains(&(e.season, e.episode)) {
            continue;
        }
        let aired = e.air_date.as_deref().map(|d| d <= today).unwrap_or(false);
        if !aired {
            if e.air_date.is_some() {
                upcoming.push(e.clone());
            }
            continue;
        }
        if e.season == 0 {
            specials += 1;
        } else {
            missing.push(e.clone());
        }
    }
    missing.sort_by_key(|e| (e.season, e.episode));
    upcoming.sort_by_key(|e| (e.season, e.episode));
    MissingReport { source: source.into(), have: have.len(), known: known.iter().filter(|e| e.season > 0).count(), missing, upcoming, specials_missing: specials }
}

/* -------------------------------------------------------------- duplicates */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DupItem {
    id: String,
    name: String,
    path: String,
    size: u64,
    width: i64,
    height: i64,
    codec: String,
    hdr: bool,
    bitrate: i64,
    /// Already grouped as versions in Jellyfin.
    versions: usize,
    best: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DupGroup {
    title: String,
    kind: &'static str,
    items: Vec<DupItem>,
}

fn norm(name: &str) -> String {
    name.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

fn dup_item(v: &Value) -> DupItem {
    let src = v.pointer("/MediaSources/0").cloned().unwrap_or(Value::Null);
    let video = src
        .get("MediaStreams")
        .and_then(Value::as_array)
        .and_then(|a| a.iter().find(|m| s(m, "Type") == "Video").cloned())
        .unwrap_or(Value::Null);
    let range = s(&video, "VideoRange");
    DupItem {
        id: clean_id(s(v, "Id")),
        name: s(v, "Name").to_string(),
        path: s(v, "Path").to_string(),
        size: src.get("Size").and_then(Value::as_u64).unwrap_or(0),
        width: video.get("Width").and_then(Value::as_i64).unwrap_or(0),
        height: video.get("Height").and_then(Value::as_i64).unwrap_or(0),
        codec: s(&video, "Codec").to_string(),
        hdr: !range.is_empty() && range != "SDR",
        bitrate: src.get("Bitrate").and_then(Value::as_i64).unwrap_or(0),
        versions: v.get("MediaSources").and_then(Value::as_array).map(|a| a.len()).unwrap_or(1),
        best: false,
    }
}

/// True when the episodes in a group have clearly different titles.
fn episodes_differ(ids: &[String], names: &HashMap<String, String>) -> bool {
    let titles: Vec<&String> = ids.iter().filter_map(|i| names.get(i)).filter(|t| !t.trim().is_empty()).collect();
    titles.len() > 1 && titles.iter().skip(1).any(|t| !crate::planner::same_episode_title(t, titles[0]) && crate::sources::similarity(t, titles[0]) < 0.6)
}

/// Higher resolution, then HDR, then a newer codec, then bitrate.
pub fn quality(d: &DupItem) -> (i64, bool, u8, i64) {
    let codec = match d.codec.to_lowercase().as_str() {
        "av1" => 3,
        "hevc" | "h265" => 2,
        "h264" | "avc" => 1,
        _ => 0,
    };
    (d.height, d.hdr, codec, d.bitrate)
}

/// The same movie (same TMDB/IMDb id, or same name and year) or the same episode more than once.
#[tauri::command]
pub async fn find_duplicates(state: State<'_, AppState>) -> Result<Vec<DupGroup>> {
    let c = state.reader().await?;
    let light = c
        .items_query(
            vec![
                ("IncludeItemTypes", "Movie,Episode".into()),
                ("Recursive", "true".into()),
                ("Fields", "ProviderIds,Path,ProductionYear,SeriesId".into()),
            ],
            200_000,
        )
        .await?;
    let mut groups: BTreeMap<String, (String, &'static str, Vec<String>)> = BTreeMap::new();
    let mut names: HashMap<String, String> = HashMap::new();
    for v in light.iter().filter(|v| !s(v, "Path").is_empty()) {
        let id = clean_id(s(v, "Id"));
        if s(v, "Type") == "Movie" {
            let key = v
                .pointer("/ProviderIds/Tmdb")
                .and_then(Value::as_str)
                .filter(|x| !x.is_empty())
                .map(|x| format!("tmdb:{x}"))
                .or_else(|| v.pointer("/ProviderIds/Imdb").and_then(Value::as_str).filter(|x| !x.is_empty()).map(|x| format!("imdb:{x}")))
                .unwrap_or_else(|| format!("name:{}:{}", norm(s(v, "Name")), v.get("ProductionYear").and_then(Value::as_i64).unwrap_or(0)));
            let title = match v.get("ProductionYear").and_then(Value::as_i64) {
                Some(y) => format!("{} ({y})", s(v, "Name")),
                None => s(v, "Name").to_string(),
            };
            groups.entry(format!("m|{key}")).or_insert((title, "movie", Vec::new())).2.push(id);
        } else {
            let (Some(sn), Some(en)) = (v.get("ParentIndexNumber").and_then(Value::as_i64), v.get("IndexNumber").and_then(Value::as_i64)) else { continue };
            let key = format!("e|{}|{sn}|{en}", clean_id(s(v, "SeriesId")));
            let title = format!("{} · S{sn:02}E{en:02}", s(v, "SeriesName"));
            names.insert(id.clone(), s(v, "Name").to_string());
            groups.entry(key).or_insert((title, "episode", Vec::new())).2.push(id);
        }
    }
    // Same number but clearly different episodes ("Planet Earth III · Heroes" and "Planet Earth ·
    // Jungles"): not a duplicate, but two shows Jellyfin has mixed into one.
    let dups: Vec<(String, &'static str, Vec<String>)> = groups
        .into_values()
        .filter(|g| g.2.len() > 1)
        .map(|(title, kind, ids)| {
            if kind == "episode" && episodes_differ(&ids, &names) {
                (title, "mixed", ids)
            } else {
                (title, kind, ids)
            }
        })
        .take(300)
        .collect();
    let all_ids: Vec<String> = dups.iter().flat_map(|g| g.2.clone()).collect();
    let mut detail: HashMap<String, DupItem> = HashMap::new();
    for chunk in all_ids.chunks(100) {
        let items = c
            .items_query(vec![("Ids", chunk.join(",")), ("Fields", "Path,MediaSources".into())], 200)
            .await
            .unwrap_or_default();
        for v in &items {
            let d = dup_item(v);
            detail.insert(d.id.clone(), d);
        }
    }
    Ok(dups
        .into_iter()
        .map(|(title, kind, ids)| {
            let mut items: Vec<DupItem> = ids.iter().filter_map(|i| detail.get(i).cloned()).collect();
            if let Some(best) = items.iter().enumerate().max_by_key(|(_, d)| quality(d)).map(|(i, _)| i) {
                items[best].best = true;
            }
            DupGroup { title, kind, items }
        })
        .filter(|g| g.items.len() > 1)
        .collect())
}

/// Groups movies as versions of one title (one entry in Jellyfin and Infuse, pick a version when playing).
#[tauri::command]
pub async fn merge_versions(state: State<'_, AppState>, ids: Vec<String>) -> Result<()> {
    if ids.iter().any(|i| !valid_item_id(i)) {
        return Err(Error::msg("bad id"));
    }
    let w = state.writer().await?;
    w.merge_versions(&ids).await
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TrashRecord {
    root: String,
    moves: Vec<(String, String)>,
}

/// Moves an item's video file (and its subtitles etc.) into the trash folder in the
/// library. Nothing is deleted; Undo puts it back.
#[tauri::command]
pub async fn trash_item_file(state: State<'_, AppState>, id: String) -> Result<usize> {
    check_id(&id)?;
    let item = state.reader().await?.item_json(&id).await?;
    let server = s(&item, "Path").to_string();
    if server.is_empty() {
        return Err(Error::msg("Jellyfin has no file for this."));
    }
    let file = local::to_local(&state, &server)?;
    if !file.is_file() {
        return Err(Error::msg("The file isn't there (is the NAS connected?)."));
    }
    let root = state.library_root()?;
    let canon_root = root.canonicalize()?;
    if !file.canonicalize()?.starts_with(&canon_root) {
        return Err(Error::msg("Only files inside the library folder can be moved."));
    }
    let dir = file.parent().ok_or_else(|| Error::msg("bad path"))?.to_path_buf();
    let stem = file.file_stem().and_then(|x| x.to_str()).unwrap_or("").to_string();
    let stamp = format!("dup-{}", now_secs());
    let mut moves = Vec::new();
    for e in std::fs::read_dir(&dir)?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if p == file || (p.is_file() && name.starts_with(&format!("{stem}."))) {
            let rel = local::rel_to_root(&root, &p).ok_or_else(|| Error::msg("bad path"))?;
            let to_rel = format!("{}/{stamp}/{rel}", crate::storage::TRASH);
            let to = root.join(crate::fsops::safe_rel(&to_rel)?);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent)?;
            }
            if to.exists() {
                continue;
            }
            std::fs::rename(&p, &to)?;
            moves.push((rel, to_rel));
        }
    }
    let rec = TrashRecord { root: root.to_string_lossy().into_owned(), moves };
    let n = rec.moves.len();
    state.store()?.journal_add("file_trashed", &id, &serde_json::to_string(&rec).unwrap_or_default(), "")?;
    let _ = state.reader().await.map(|c| async move { c.library_scan().await });
    Ok(n)
}

/// Undo for "file_trashed".
pub fn undo_trash(record_json: &str) -> Result<()> {
    let r: TrashRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let root = PathBuf::from(&r.root);
    for (orig, trashed) in &r.moves {
        let (o, t) = (root.join(crate::fsops::safe_rel(orig)?), root.join(crate::fsops::safe_rel(trashed)?));
        if t.is_file() && !o.exists() {
            std::fs::rename(t, o)?;
        }
    }
    Ok(())
}

/* -------------------------------------------------------- genres and tags */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagStat {
    kind: &'static str,
    name: String,
    count: usize,
}

#[tauri::command]
pub async fn tag_stats(state: State<'_, AppState>) -> Result<Vec<TagStat>> {
    let items = state
        .reader()
        .await?
        .items_query(vec![("IncludeItemTypes", "Movie,Series".into()), ("Recursive", "true".into()), ("Fields", "Genres,Tags".into())], 50_000)
        .await?;
    let mut counts: BTreeMap<(&'static str, String), usize> = BTreeMap::new();
    for v in &items {
        for (kind, field) in [("genre", "Genres"), ("tag", "Tags")] {
            for g in v.get(field).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
                *counts.entry((kind, g.to_string())).or_default() += 1;
            }
        }
    }
    Ok(counts.into_iter().map(|((kind, name), count)| TagStat { kind, name, count }).collect())
}

/// The new list after merging `from` into `to` (or removing `from` when `to` is None).
pub fn merge_list(list: &[String], from: &[String], to: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut hit = false;
    for g in list {
        if from.iter().any(|f| f.eq_ignore_ascii_case(g)) {
            hit = true;
            continue;
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(g)) {
            out.push(g.clone());
        }
    }
    if let (true, Some(t)) = (hit, to) {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    out
}

/// Renames/merges genres or tags across the library (or removes them). Each title is one
/// journaled change, so it can be undone title by title.
#[tauri::command]
pub async fn tags_merge(app: AppHandle, state: State<'_, AppState>, kind: String, from: Vec<String>, to: Option<String>) -> Result<usize> {
    let field = match kind.as_str() {
        "genre" => "Genres",
        "tag" => "Tags",
        _ => return Err(Error::msg("bad kind")),
    };
    let from: Vec<String> = from.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect();
    if from.is_empty() {
        return Err(Error::msg("Pick what to change."));
    }
    let to = to.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let w = state.writer().await?;
    let items = w
        .reader()
        .items_query(vec![("IncludeItemTypes", "Movie,Series".into()), ("Recursive", "true".into()), ("Fields", format!("{field}"))], 50_000)
        .await?;
    let targets: Vec<String> = items
        .iter()
        .filter(|v| v.get(field).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).any(|g| from.iter().any(|f| f.eq_ignore_ascii_case(g))))
        .map(|v| clean_id(s(v, "Id")))
        .filter(|i| valid_item_id(i))
        .collect();
    let total = targets.len();
    let mut done = 0;
    crate::cancel::begin("bulk");
    for (i, id) in targets.iter().enumerate() {
        if crate::cancel::stopped("bulk") {
            break;
        }
        let _ = app.emit("bulk-progress", serde_json::json!({ "done": i, "total": total }));
        let old = w.reader().item_json(id).await?;
        let list: Vec<String> = old.get(field).and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
        let mut new = old.clone();
        new[field] = serde_json::json!(merge_list(&list, &from, to.as_deref()));
        if new == old {
            continue;
        }
        let entry = state.store()?.journal_add("item_update", id, &old.to_string(), &new.to_string())?;
        if let Err(e) = w.update_item(id, &new).await {
            state.store()?.journal_delete(entry)?;
            return Err(e);
        }
        let _ = crate::meta_cmds::sync_row(&state, id, &new);
        done += 1;
    }
    Ok(done)
}

/* ------------------------------------------------------- episode stills */

fn grab_frame(ff: &Path, file: &Path, at: f64) -> Option<Vec<u8>> {
    let mut cmd = Command::new(ff);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", &format!("{at:.2}")])
        .arg("-i")
        .arg(file)
        .args(["-frames:v", "1", "-vf", "scale=960:-2", "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    media_tools::hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    (out.status.success() && out.stdout.len() > 2000).then_some(out.stdout)
}

/// Makes a still for every episode (of a season or a whole show) that has none: three
/// frames from the middle part, the most detailed one wins (dark or empty frames compress
/// small). Returns how many were added.
#[tauri::command]
pub async fn make_episode_stills(app: AppHandle, state: State<'_, AppState>, parent_id: String) -> Result<usize> {
    check_id(&parent_id)?;
    let ff = media_tools::locate_ffmpeg(state.settings()?.ffmpeg_path.as_deref()).ok_or_else(|| Error::msg("This needs ffmpeg (Settings → Tools)."))?;
    let w = state.writer().await?;
    let eps = w
        .reader()
        .items_query(
            vec![("ParentId", parent_id.clone()), ("IncludeItemTypes", "Episode".into()), ("Recursive", "true".into()), ("Fields", "Path".into())],
            3000,
        )
        .await?;
    let todo: Vec<&Value> = eps.iter().filter(|e| !has_img(e, "Primary") && !s(e, "Path").is_empty()).collect();
    let total = todo.len();
    let mut added = 0;
    crate::cancel::begin("bulk");
    for (i, e) in todo.into_iter().enumerate() {
        if crate::cancel::stopped("bulk") {
            break;
        }
        let id = clean_id(s(e, "Id"));
        if !valid_item_id(&id) {
            continue;
        }
        let _ = app.emit("bulk-progress", serde_json::json!({ "done": i, "total": total, "label": s(e, "Name") }));
        let Ok(file) = local::to_local(&state, s(e, "Path")) else { continue };
        let dur = e.get("RunTimeTicks").and_then(Value::as_f64).map(|t| t / 10_000_000.0).unwrap_or(1200.0).max(60.0);
        let ff2 = ff.clone();
        let best = tauri::async_runtime::spawn_blocking(move || {
            [0.3, 0.45, 0.6]
                .iter()
                .filter_map(|f| grab_frame(&ff2, &file, dur * f))
                .max_by_key(|b| b.len())
        })
        .await
        .ok()
        .flatten();
        let Some(bytes) = best else { continue };
        let entry = state.store()?.journal_add("image", &format!("{id}|Primary|0"), "", "still from the video")?;
        match w.upload_image(&id, "Primary", 0, &bytes, "image/jpeg").await {
            Ok(()) => added += 1,
            Err(_) => state.store()?.journal_delete(entry)?,
        }
    }
    Ok(added)
}

/* ---------------------------------------------------------------- alerts */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    /// "error" | "warn" | "info"
    level: &'static str,
    title: String,
    detail: String,
    /// Where to fix it: "settings:<section>" or a screen name.
    fix: String,
}

fn alert_fix(level: &'static str, title: &str, detail: &str, fix: &str) -> Alert {
    Alert { level, title: title.into(), detail: detail.into(), fix: fix.into() }
}

/// Problems worth knowing about, instead of things failing quietly.
#[tauri::command]
pub async fn health_alerts(state: State<'_, AppState>) -> Result<Vec<Alert>> {
    let mut out = Vec::new();
    let st = state.settings()?;
    match st.library_root.as_deref() {
        None => out.push(alert_fix("warn", "No library folder chosen", "The renamer, intro detection and adding new titles need it.", "settings:folder")),
        Some(r) if !Path::new(r).is_dir() => out.push(alert_fix("error", "The NAS isn't connected", &format!("{r} can't be reached. Mount the share, then press reload."), "settings:folder")),
        _ => {}
    }
    let c: Option<Client> = match state.reader().await {
        Ok(c) => match c.ping().await {
            Ok(()) => Some(c),
            Err(e) => {
                out.push(alert_fix("error", "Jellyfin can't be reached", &e.to_string(), "settings:jellyfin"));
                None
            }
        },
        Err(e) => {
            out.push(alert_fix("error", "Not connected to Jellyfin", &e.to_string(), "settings:jellyfin"));
            None
        }
    };
    if let Some(c) = c {
        if let Ok(plugins) = c.plugins().await {
            let has = |words: &[&str]| plugins.iter().any(|(n, _, status)| {
                let n = n.to_lowercase().replace(' ', "");
                words.iter().any(|w| n.contains(w)) && status != "Disabled"
            });
            if !has(&["mediasegment"]) {
                out.push(alert_fix("warn", "Skip markers can't be saved", "Install the “MediaSegments API” plugin in Jellyfin (Dashboard → Plugins → Catalog) and restart Jellyfin.", "settings:plugins"));
            }
            if !has(&["opensubtitles"]) {
                out.push(alert_fix("warn", "Subtitle downloads are off", "Install the “Open Subtitles” plugin in Jellyfin and sign in to it.", "settings:plugins"));
            }
            if !has(&["fanart"]) {
                out.push(alert_fix("info", "Few banners, clear art and disc pictures", "Install the “Fanart” plugin in Jellyfin and turn it on in the library's image fetchers.", "settings:plugins"));
            }
            if !has(&["tvdb"]) {
                out.push(alert_fix("info", "No TheTVDB plugin", "TheTVDB adds banners and better episode data for shows.", "settings:plugins"));
            }
        }
        if let Ok(views) = c.all_views().await {
            if !views.iter().any(|(_, _, t)| t == "playlists") {
                out.push(alert_fix(
                    "info",
                    "Picks of the day aren't in Infuse yet",
                    "Media Hub keeps them as a Jellyfin playlist. Sync picks once, then in Infuse pin the Playlists folder: Settings → Shares → your Jellyfin server → Add Favorite.",
                    "settings:picks",
                ));
            }
        }
        if let Ok(info) = c.system_info().await {
            if !crate::backend::version_at_least(&info.version, 10, 10) {
                out.push(alert_fix("warn", "Infuse can't read your skip markers", &format!("Infuse reads intro and credits markers from Jellyfin 10.10 or newer; this server runs {}.", info.version), "settings:backend"));
            }
        }
        if let Ok(folders) = c.virtual_folders().await {
            let rows = crate::backend::lib_rows(&folders);
            let refreshes = rows.iter().any(|r| !r.is_ok() && r.is_key("AutomaticRefreshIntervalDays"));
            if refreshes {
                out.push(alert_fix("warn", "Jellyfin may overwrite your edits", "A library refreshes details on its own. Let Media Hub set Jellyfin up as its backend.", "settings:backend"));
            } else if rows.iter().any(|r| !r.is_ok()) {
                out.push(alert_fix("info", "Jellyfin could be faster", "Some library settings slow down scans or Infuse's sync.", "settings:backend"));
            }
        }
    }
    if media_tools::locate_ffmpeg(st.ffmpeg_path.as_deref()).is_none() {
        out.push(alert_fix("info", "ffmpeg isn't installed", "Needed for intro detection, episode stills, subtitle timing and storage tools.", "settings:tools"));
    }
    if st.read_only {
        out.push(alert_fix("info", "Read-only", "Media Hub can't change anything in Jellyfin until you allow changes.", "settings:changes"));
    }
    if !st.has_tmdb {
        out.push(alert_fix("info", "No TMDB key", "Missing-episode checks and matching work better with a free TMDB key.", "settings:metadata"));
    }
    Ok(out)
}

/* ------------------------------------------------------- picks playlist */

pub const PICKS_NAME: &str = crate::collections::PICKS_NAME;

/// Keeps a playlist called "Picks of the day" for the chosen user: movies as they are,
/// shows as their next unwatched episode (a playlist plays videos, not whole shows).
#[tauri::command]
pub async fn sync_picks_playlist(state: State<'_, AppState>, ids: Vec<String>) -> Result<usize> {
    let w = state.writer().await?;
    let c = w.reader();
    let mut videos: Vec<String> = Vec::new();
    for id in ids.iter().filter(|i| valid_item_id(i)).take(30) {
        let item = c.item_json(id).await?;
        match s(&item, "Type") {
            "Movie" | "Episode" => videos.push(id.clone()),
            "Series" => {
                let next = c
                    .items_query(
                        vec![
                            ("ParentId", id.clone()),
                            ("IncludeItemTypes", "Episode".into()),
                            ("Recursive", "true".into()),
                            ("IsPlayed", "false".into()),
                            ("SortBy", "ParentIndexNumber,IndexNumber".into()),
                        ],
                        1,
                    )
                    .await
                    .unwrap_or_default();
                if let Some(e) = next.first() {
                    let eid = clean_id(s(e, "Id"));
                    if valid_item_id(&eid) {
                        videos.push(eid);
                    }
                }
            }
            _ => {}
        }
    }
    if videos.is_empty() {
        return Err(Error::msg("No picks to put in the playlist."));
    }
    let existing = c.playlists().await?.into_iter().find(|p| s(p, "Name") == PICKS_NAME).map(|p| clean_id(s(&p, "Id")));
    match existing.filter(|i| valid_item_id(i)) {
        Some(pid) => {
            let entries: Vec<String> = c.playlist_items(&pid).await?.iter().map(|e| s(e, "PlaylistItemId").to_string()).filter(|e| !e.is_empty()).collect();
            w.playlist_remove_entries(&pid, &entries).await?;
            w.playlist_add(&pid, &videos).await?;
        }
        None => {
            w.playlist_create(PICKS_NAME, &videos).await?;
        }
    }
    Ok(videos.len())
}

/* ------------------------------------------------------------- undo center */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalRow {
    id: i64,
    at: i64,
    action: String,
    target: String,
    /// Name of the title the change was made to, when known.
    title: String,
    undone: bool,
}

#[tauri::command]
pub fn journal_all(state: State<'_, AppState>, limit: i64) -> Result<Vec<JournalRow>> {
    let store = state.store()?;
    let rows = store.changes_all(limit)?;
    let ids: Vec<String> = rows.iter().map(|r| r.target.split('|').next().unwrap_or("").to_string()).filter(|i| valid_item_id(i)).collect();
    let names: HashMap<String, String> = store.get_many(&ids)?.into_iter().map(|r| (r.id, r.name)).collect();
    Ok(rows
        .into_iter()
        .map(|r| {
            let key = r.target.split('|').next().unwrap_or("").to_string();
            JournalRow { title: names.get(&key).cloned().unwrap_or_default(), id: r.id, at: r.at, action: r.action, target: r.target, undone: r.undone }
        })
        .collect())
}

/* ---------------------------------------------------- intro marker summary */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SegSummary {
    episodes: usize,
    intro: usize,
    credits: usize,
    recap: usize,
}

fn seg_cache() -> &'static Mutex<HashMap<String, (Instant, SegSummary)>> {
    static C: std::sync::OnceLock<Mutex<HashMap<String, (Instant, SegSummary)>>> = std::sync::OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// How many episodes of a show have intro, credits and recap markers (cached 10 minutes).
#[tauri::command]
pub async fn segment_summary(state: State<'_, AppState>, series_id: String, fresh: Option<bool>) -> Result<SegSummary> {
    check_id(&series_id)?;
    if !fresh.unwrap_or(false) {
        if let Some((t, v)) = seg_cache().lock().map_err(|_| Error::msg("internal error"))?.get(&series_id) {
            if t.elapsed() < Duration::from_secs(600) {
                return Ok(v.clone());
            }
        }
    }
    let c = state.reader().await?;
    let eps = c
        .items_query(vec![("ParentId", series_id.clone()), ("IncludeItemTypes", "Episode".into()), ("Recursive", "true".into())], 3000)
        .await?;
    let mut sum = SegSummary { episodes: 0, intro: 0, credits: 0, recap: 0 };
    for e in &eps {
        let id = clean_id(s(e, "Id"));
        if !valid_item_id(&id) || s(e, "LocationType") == "Virtual" {
            continue;
        }
        sum.episodes += 1;
        let segs = c.segments(&id).await.unwrap_or_default();
        let has = |k: &str| segs.iter().any(|x| s(x, "Type") == k);
        sum.intro += has("Intro") as usize;
        sum.credits += has("Outro") as usize;
        sum.recap += has("Recap") as usize;
    }
    seg_cache().lock().map_err(|_| Error::msg("internal error"))?.insert(series_id, (Instant::now(), sum.clone()));
    Ok(sum)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(s: u32, e: u32, d: Option<&str>) -> EpInfo {
        EpInfo { season: s, episode: e, title: format!("E{e}"), air_date: d.map(String::from) }
    }

    #[test]
    fn missing_skips_unaired_and_counts_specials() {
        let known = vec![ep(1, 1, Some("2020-01-01")), ep(1, 2, Some("2020-01-08")), ep(1, 3, Some("2099-01-01")), ep(0, 1, Some("2019-12-01")), ep(1, 4, None)];
        let have: HashSet<(u32, u32)> = [(1, 1)].into_iter().collect();
        let r = compare_episodes("TMDB", &known, &have, "2026-10-25");
        assert_eq!(r.missing.len(), 1);
        assert_eq!(r.missing[0].episode, 2);
        assert_eq!(r.upcoming.len(), 1);
        assert_eq!(r.specials_missing, 1);
        assert_eq!(r.known, 4);
    }

    #[test]
    fn today_looks_like_a_date() {
        let t = today();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }

    #[test]
    fn merging_genres() {
        let l = vec!["Sci-Fi".to_string(), "Drama".to_string(), "Science Fiction".to_string()];
        assert_eq!(merge_list(&l, &["Sci-Fi".into()], Some("Science Fiction")), vec!["Drama", "Science Fiction"]);
        assert_eq!(merge_list(&l, &["drama".into()], None), vec!["Sci-Fi", "Science Fiction"]);
        assert_eq!(merge_list(&l, &["Western".into()], Some("X")), l);
    }

    #[test]
    fn best_version_wins_on_resolution_then_hdr() {
        let mk = |h: i64, hdr: bool, codec: &str| DupItem { id: String::new(), name: String::new(), path: String::new(), size: 0, width: 0, height: h, codec: codec.into(), hdr, bitrate: 0, versions: 1, best: false };
        assert!(quality(&mk(2160, false, "h264")) > quality(&mk(1080, true, "hevc")));
        assert!(quality(&mk(1080, true, "h264")) > quality(&mk(1080, false, "hevc")));
        assert!(quality(&mk(1080, false, "hevc")) > quality(&mk(1080, false, "h264")));
    }
}

/* ------------------------------------------------------- favourites, languages */

#[tauri::command]
pub async fn set_favorite(state: State<'_, AppState>, id: String, favorite: bool) -> Result<()> {
    check_id(&id)?;
    state.writer().await?.set_favorite(&id, favorite).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryLang {
    id: String,
    name: String,
    kind: String,
    language: String,
    country: String,
}

#[tauri::command]
pub async fn library_languages(state: State<'_, AppState>) -> Result<Vec<LibraryLang>> {
    let folders = state.reader().await?.virtual_folders().await?;
    Ok(folders
        .iter()
        .filter_map(|f| {
            let id = clean_id(s(f, "ItemId"));
            valid_item_id(&id).then(|| LibraryLang {
                name: s(f, "Name").to_string(),
                kind: s(f, "CollectionType").to_string(),
                language: f.pointer("/LibraryOptions/PreferredMetadataLanguage").and_then(Value::as_str).unwrap_or("").to_string(),
                country: f.pointer("/LibraryOptions/MetadataCountryCode").and_then(Value::as_str).unwrap_or("").to_string(),
                id,
            })
        })
        .collect())
}

/// Sets the language (and country) titles and summaries are fetched in for one library,
/// and optionally fetches them again for everything in it. Undo puts the old setting back.
#[tauri::command]
pub async fn set_library_language(state: State<'_, AppState>, id: String, language: String, country: String, refresh: bool) -> Result<()> {
    check_id(&id)?;
    let ok = |x: &str, n: usize| x.len() <= n && x.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok(&language, 10) || !ok(&country, 3) {
        return Err(Error::msg("bad language"));
    }
    let w = state.writer().await?;
    let folder = w
        .reader()
        .virtual_folders()
        .await?
        .into_iter()
        .find(|f| clean_id(s(f, "ItemId")) == id)
        .ok_or_else(|| Error::msg("That library isn't there."))?;
    let old = folder.get("LibraryOptions").cloned().unwrap_or(Value::Null);
    let mut new = old.clone();
    new["PreferredMetadataLanguage"] = Value::String(language.clone());
    new["MetadataCountryCode"] = Value::String(country.clone());
    let entry = state.store()?.journal_add("library_options", &id, &old.to_string(), &new.to_string())?;
    if let Err(e) = w.set_library_options(&id, &new).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    if refresh {
        w.refresh_library_metadata(&id).await?;
    }
    Ok(())
}

pub async fn undo_library_options(w: &crate::jellyfin::Writer, id: &str, old_json: &str) -> Result<()> {
    let old: Value = serde_json::from_str(old_json).map_err(|_| Error::msg("bad journal entry"))?;
    w.set_library_options(id, &old).await
}
