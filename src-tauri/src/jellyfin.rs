//! Jellyfin client.
//!
//! `Client` only reads (GET, plus the remote search POST, which changes nothing).
//! `Writer` is the only type that can change anything, and the app only creates one when
//! the user has switched changes on in Settings (see `AppState::writer`).

use crate::error::{Error, Result};
use serde::{de::DeserializeOwned, Deserialize};
use std::collections::HashMap;
use std::time::Duration;

const MAX_JSON_BYTES: usize = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_OVERVIEW_CHARS: usize = 2000;

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    auth: String,
    /// The Jellyfin user the app acts as (needed by newer Jellyfin versions for item
    /// details and to see watched status). Picked automatically: the first administrator.
    pub user: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct ServerInfo {
    pub server_name: String,
    pub version: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct Page {
    pub items: Vec<RawItem>,
    pub total_record_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RawItem {
    pub id: String,
    pub name: String,
    pub sort_name: Option<String>,
    #[serde(rename = "Type")]
    pub kind: String,
    pub production_year: Option<i32>,
    pub community_rating: Option<f64>,
    pub genres: Option<Vec<String>>,
    pub overview: Option<String>,
    pub date_created: Option<String>,
    pub image_tags: Option<HashMap<String, String>>,
    pub provider_ids: Option<HashMap<String, String>>,
    pub child_count: Option<i64>,
    pub recursive_item_count: Option<i64>,
    pub run_time_ticks: Option<f64>,
    pub user_data: Option<UserData>,
    pub path: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
pub struct UserData {
    pub played: Option<bool>,
    pub playback_position_ticks: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct RawEpisode {
    pub name: Option<String>,
    pub index_number: Option<u32>,
    pub index_number_end: Option<u32>,
    pub parent_index_number: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct EpisodePage {
    items: Vec<RawEpisode>,
}

/// (season, episode) -> episode title, as Jellyfin knows it.
pub fn episode_titles(eps: &[RawEpisode]) -> HashMap<(u32, u32), String> {
    let mut out = HashMap::new();
    for e in eps {
        let (Some(season), Some(first), Some(name)) = (e.parent_index_number, e.index_number, e.name.as_ref()) else {
            continue;
        };
        let last = e.index_number_end.unwrap_or(first).clamp(first, first + 20);
        for n in first..=last {
            out.insert((season, n), name.clone());
        }
    }
    out
}

/// What the local database stores for one title.
#[derive(Debug, Clone, PartialEq)]
pub struct NewItem {
    pub id: String,
    pub kind: &'static str, // "movie" | "series"
    pub name: String,
    pub sort_name: String,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub overview: String,
    pub has_poster: bool,
    pub added: Option<String>,
    pub library: String,
    pub matched: bool,
    pub seasons: Option<i64>,
    pub episodes: Option<i64>,
    pub runtime: Option<f64>,
    pub played: bool,
    pub path: String,
}

impl RawItem {
    /// Returns None for item types we do not list (module 1 lists movies and shows).
    pub fn into_new(self, library: &str) -> Option<NewItem> {
        let kind = match self.kind.as_str() {
            "Movie" => "movie",
            "Series" => "series",
            _ => return None,
        };
        let sort_name = self
            .sort_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| self.name.to_lowercase());
        let overview: String = self
            .overview
            .unwrap_or_default()
            .chars()
            .take(MAX_OVERVIEW_CHARS)
            .collect();
        let matched = self
            .provider_ids
            .as_ref()
            .map(|p| ["Tmdb", "Tvdb"].iter().any(|k| p.get(*k).map(|v| !v.is_empty()).unwrap_or(false)))
            .unwrap_or(false);
        let is_series = kind == "series";
        Some(NewItem {
            library: library.to_string(),
            matched,
            seasons: if is_series { self.child_count } else { None },
            episodes: if is_series { self.recursive_item_count } else { None },
            runtime: self.run_time_ticks.map(|t| t / TICKS_PER_SECOND / 60.0),
            played: self.user_data.as_ref().and_then(|u| u.played).unwrap_or(false),
            path: self.path.clone().unwrap_or_default(),
            has_poster: self
                .image_tags
                .as_ref()
                .map(|t| t.contains_key("Primary"))
                .unwrap_or(false),
            id: self.id,
            kind,
            name: self.name,
            sort_name,
            year: self.production_year,
            rating: self.community_rating,
            genres: self.genres.unwrap_or_default(),
            overview,
            added: self.date_created,
        })
    }
}

/// Jellyfin ids are 32 hex characters. Checked before an id goes into a URL.
/// What a "not found" answer means, from the address that was asked for. Only a missing title
/// is reported as a missing title.
pub fn not_found_text(path: &str) -> String {
    let p = path.trim_end_matches('/');
    let parts: Vec<&str> = p.split('/').filter(|x| !x.is_empty()).collect();
    let is_id = |x: &str| x.len() == 32 && x.chars().all(|c| c.is_ascii_hexdigit()) || (x.len() == 36 && x.chars().filter(|c| *c == '-').count() == 4);
    match parts.as_slice() {
        ["Items", id] | ["Users", _, "Items", id] if is_id(id) => TITLE_GONE.to_string(),
        ["Shows", id, ..] | ["Items", id, "Similar"] if is_id(id) => TITLE_GONE.to_string(),
        ["Items", _, "Images", ..] => "Jellyfin has no such picture for this title.".to_string(),
        ["Items", _, "RemoteImages", ..] => "Jellyfin couldn't fetch that picture (the image site may have removed it).".to_string(),
        ["MediaSegments", ..] => "Jellyfin can't store skip markers: install the “MediaSegments API” plugin (Dashboard → Plugins) and restart Jellyfin.".to_string(),
        ["Providers", "Subtitles", ..] | ["Items", _, "RemoteSearch", "Subtitles", ..] => "The subtitle site doesn't have this subtitle (any more). Pick another one.".to_string(),
        _ => format!("Jellyfin couldn't find what Media Hub asked for ({}).", parts.iter().map(|x| if is_id(x) { "…" } else { x }).collect::<Vec<_>>().join("/")),
    }
}

pub const TITLE_GONE: &str = "This title is no longer in Jellyfin (removed, or renamed and found again under a new id). Scan the library to update Media Hub's list.";

pub fn valid_item_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn image_kind(k: &str) -> Option<&'static str> {
    match k {
        "Primary" => Some("Primary"),
        "Backdrop" => Some("Backdrop"),
        "Logo" => Some("Logo"),
        "Thumb" => Some("Thumb"),
        "Banner" => Some("Banner"),
        "Art" => Some("Art"),
        "Disc" => Some("Disc"),
        _ => None,
    }
}

impl Client {
    pub fn new(base: &str, api_key: &str) -> Result<Self> {
        if !crate::config::valid_key(api_key) {
            return Err(Error::msg("That does not look like a Jellyfin API key."));
        }
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            // Never follow a redirect: the key must only ever go to the address the user typed.
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("MediaHub/0.8")
            .build()
            .map_err(|e| Error::msg(e.to_string()))?;
        Ok(Client {
            http,
            base: base.trim_end_matches('/').to_string(),
            auth: format!("MediaBrowser Client=\"Media Hub\", Device=\"Desktop\", DeviceId=\"media-hub\", Version=\"0.9\", Token=\"{api_key}\""),
            user: None,
        })
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let resp = req
            .header("Authorization", &self.auth)
            .send()
            .await
            .map_err(|e| Error::Network(e.without_url().to_string()))?;
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 | 403 => Err(Error::Unauthorized),
            404 => Err(Error::msg(not_found_text(resp.url().path()))),
            s => {
                // Jellyfin usually says why in the body; show a short, single-line version.
                let body = resp.text().await.unwrap_or_default();
                let why: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(160).collect();
                Err(Error::msg(if why.is_empty() {
                    format!("The server answered with status {s}.")
                } else {
                    format!("The server answered with status {s}: {why}")
                }))
            }
        }
    }

    fn with_user(&self, mut q: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
        if let Some(u) = &self.user {
            q.push(("userId", u.clone()));
        }
        q
    }

    /// All Jellyfin users: (id, name, is admin).
    pub async fn users(&self) -> Result<Vec<(String, String, bool)>> {
        let users: Vec<serde_json::Value> = self.get_json("/Users", &[]).await?;
        Ok(users
            .iter()
            .filter(|u| u.pointer("/Policy/IsDisabled").and_then(|v| v.as_bool()) != Some(true))
            .filter_map(|u| {
                Some((
                    u.get("Id")?.as_str()?.replace('-', ""),
                    u.get("Name")?.as_str()?.to_string(),
                    u.pointer("/Policy/IsAdministrator").and_then(|v| v.as_bool()).unwrap_or(false),
                ))
            })
            .collect())
    }

    /// The first enabled administrator (an API key can act for any user).
    pub async fn pick_user(&self) -> Result<String> {
        let users: Vec<serde_json::Value> = self.get_json("/Users", &[]).await?;
        let enabled = |u: &&serde_json::Value| u.pointer("/Policy/IsDisabled").and_then(|v| v.as_bool()) != Some(true);
        let admin = users
            .iter()
            .filter(enabled)
            .find(|u| u.pointer("/Policy/IsAdministrator").and_then(|v| v.as_bool()) == Some(true))
            .or_else(|| users.iter().find(enabled));
        admin
            .and_then(|u| u.get("Id").and_then(|i| i.as_str()))
            .map(|s| s.replace('-', ""))
            .filter(|s| valid_item_id(s))
            .ok_or_else(|| Error::msg("No Jellyfin user found to act as."))
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    async fn get(&self, path: &str, query: &[(&'static str, String)]) -> Result<reqwest::Response> {
        self.send(self.http.get(self.url(path)).query(query)).await
    }

    async fn read_json<T: DeserializeOwned>(resp: reqwest::Response) -> Result<T> {
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Error::Network(e.without_url().to_string()))?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err(Error::msg("The server sent an unexpectedly large answer."));
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| Error::msg("The server answered, but not like a Jellyfin server."))
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str, query: &[(&'static str, String)]) -> Result<T> {
        Self::read_json(self.get(path, query).await?).await
    }

    /// Does not need the key; proves that something answers at this address.
    pub async fn ping(&self) -> Result<()> {
        self.get("/System/Info/Public", &[]).await.map(|_| ())
    }

    /// Needs a valid key, so this is the real "does the key work" check.
    pub async fn system_info(&self) -> Result<ServerInfo> {
        self.get_json("/System/Info", &[]).await
    }

    /// The user's libraries ("TV Shows", "Movies", "Kids", ...): (id, name, kind).
    pub async fn views(&self) -> Result<Vec<(String, String, String)>> {
        let v: serde_json::Value = self.get_json("/UserViews", &self.with_user(vec![])).await?;
        Ok(v.get("Items")
            .and_then(|i| i.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let kind = x.get("CollectionType").and_then(|c| c.as_str()).unwrap_or("mixed").to_string();
                        if !["movies", "tvshows", "mixed", "homevideos"].contains(&kind.as_str()) {
                            return None;
                        }
                        Some((x.get("Id")?.as_str()?.replace('-', ""), x.get("Name")?.as_str()?.to_string(), kind))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// How many movies and episodes have no subtitles at all.
    pub async fn count_without_subtitles(&self) -> Result<u64> {
        let q = vec![
            ("IncludeItemTypes", "Movie,Episode".to_string()),
            ("Recursive", "true".to_string()),
            ("HasSubtitles", "false".to_string()),
            ("Limit", "0".to_string()),
        ];
        let v: serde_json::Value = self.get_json("/Items", &self.with_user(q)).await?;
        Ok(v.get("TotalRecordCount").and_then(|t| t.as_u64()).unwrap_or(0))
    }

    /// Movies and episodes without subtitles, newest first.
    pub async fn without_subtitles(&self, start: u64, limit: u64) -> Result<serde_json::Value> {
        let q = vec![
            ("IncludeItemTypes", "Movie,Episode".to_string()),
            ("Recursive", "true".to_string()),
            ("HasSubtitles", "false".to_string()),
            ("SortBy", "SeriesSortName,ParentIndexNumber,IndexNumber,SortName".to_string()),
            ("Fields", "Path".to_string()),
            ("EnableImages", "false".to_string()),
            ("EnableUserData", "false".to_string()),
            ("StartIndex", start.to_string()),
            ("Limit", limit.min(3000).to_string()),
        ];
        self.get_json("/Items", &self.with_user(q)).await
    }

    /// In-progress items (for "Left halfway").
    pub async fn resume(&self) -> Result<Vec<serde_json::Value>> {
        let q = self.with_user(vec![("Limit", "20".to_string()), ("MediaTypes", "Video".to_string())]);
        let v: serde_json::Value = match self.get_json("/UserItems/Resume", &q).await {
            Ok(v) => v,
            Err(_) => {
                let u = self.user.clone().unwrap_or_default();
                self.get_json(&format!("/Users/{u}/Items/Resume"), &q).await?
            }
        };
        Ok(v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }

    /// Next episode to watch per show.
    pub async fn next_up(&self) -> Result<Vec<serde_json::Value>> {
        let q = self.with_user(vec![("Limit", "30".to_string())]);
        let v: serde_json::Value = self.get_json("/Shows/NextUp", &q).await?;
        Ok(v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }

    pub async fn items_page(&self, parent: Option<&str>, start: u64, limit: u64) -> Result<Page> {
        let mut q = vec![
            ("IncludeItemTypes", "Movie,Series".to_string()),
            ("Recursive", "true".to_string()),
            ("Fields", "Genres,Overview,DateCreated,SortName,ProviderIds,ChildCount,RecursiveItemCount,ParentId,Path".to_string()),
            ("SortBy", "SortName".to_string()),
            ("StartIndex", start.to_string()),
            ("Limit", limit.to_string()),
        ];
        if let Some(p) = parent {
            q.push(("ParentId", p.to_string()));
        }
        self.get_json("/Items", &self.with_user(q)).await
    }

    pub async fn episodes(&self, series_id: &str) -> Result<Vec<RawEpisode>> {
        if !valid_item_id(series_id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("ParentId", series_id.to_string()),
            ("IncludeItemTypes", "Episode".to_string()),
            ("Recursive", "true".to_string()),
            ("Limit", "5000".to_string()),
        ];
        let page: EpisodePage = self.get_json("/Items", &self.with_user(q)).await?;
        Ok(page.items)
    }

    async fn image_bytes(resp: reqwest::Response) -> Result<(Vec<u8>, String)> {
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !ct.starts_with("image/") {
            return Err(Error::msg("not an image"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Error::Network(e.without_url().to_string()))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(Error::msg("image too large"));
        }
        Ok((bytes.to_vec(), ct))
    }

    fn image_path(id: &str, kind: &str, index: u32) -> Result<String> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        // Chapter pictures can be read (never written).
        let kind = if kind == "Chapter" { "Chapter" } else { image_kind(kind).ok_or_else(|| Error::msg("bad image kind"))? };
        Ok(if index == 0 && kind != "Chapter" {
            format!("/Items/{id}/Images/{kind}")
        } else {
            format!("/Items/{id}/Images/{kind}/{index}")
        })
    }

    /// Returns (bytes, content-type) of one picture, scaled down. Only allow-listed picture kinds.
    pub async fn image(&self, id: &str, kind: &str, index: u32, max_width: u32) -> Result<(Vec<u8>, String)> {
        let q = vec![
            ("maxWidth", max_width.clamp(64, 1920).to_string()),
            ("quality", "85".to_string()),
        ];
        let resp = self.get(&Self::image_path(id, kind, index)?, &q).await?;
        Self::image_bytes(resp).await
    }

    /// The full original picture, for a backup before it is replaced. None if there is none.
    pub async fn image_original(&self, id: &str, kind: &str, index: u32) -> Result<Option<(Vec<u8>, String)>> {
        let req = self.http.get(self.url(&Self::image_path(id, kind, index)?));
        match self.send(req).await {
            Ok(resp) => Ok(Some(Self::image_bytes(resp).await?)),
            Err(Error::Msg(m)) if m.starts_with("Jellyfin does not know") || m.contains("no such picture") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The complete item as Jellyfin stores it. Kept as raw JSON so that saving it back
    /// never drops fields this app does not know about.
    pub async fn item_json(&self, id: &str) -> Result<serde_json::Value> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.get_json(&format!("/Items/{id}"), &self.with_user(vec![])).await
    }

    pub async fn seasons(&self, series_id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(series_id) {
            return Err(Error::msg("bad id"));
        }
        let v: serde_json::Value = self.get_json(&format!("/Shows/{series_id}/Seasons"), &self.with_user(vec![])).await?;
        Ok(v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }

    pub async fn image_list(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.get_json(&format!("/Items/{id}/Images"), &[]).await
    }

    pub async fn remote_images(&self, id: &str, kind: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let kind = image_kind(kind).ok_or_else(|| Error::msg("bad image kind"))?;
        let q = vec![
            ("type", kind.to_string()),
            ("includeAllLanguages", "true".to_string()),
            ("limit", "300".to_string()),
        ];
        let v: serde_json::Value = self.get_json(&format!("/Items/{id}/RemoteImages"), &q).await?;
        Ok(v.get("Images").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }

    /// Direct children (seasons of a show, episodes of a season), with file path and streams.
    pub async fn children(&self, parent_id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(parent_id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("ParentId", parent_id.to_string()),
            ("Fields", "Path,MediaStreams,Overview".to_string()),
            ("SortBy", "IndexNumber,SortName".to_string()),
            ("Limit", "2000".to_string()),
        ];
        let v: serde_json::Value = self.get_json("/Items", &self.with_user(q)).await?;
        Ok(v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }

    pub async fn cultures(&self) -> Result<Vec<serde_json::Value>> {
        self.get_json("/Localization/Cultures", &[]).await
    }

    /// Asks Jellyfin's subtitle providers (e.g. OpenSubtitles) for candidates. Changes nothing.
    pub async fn subtitle_search(&self, id: &str, lang: &str) -> Result<Vec<crate::subs::SubInfo>> {
        if !valid_item_id(id) || !crate::subs::valid_lang(lang) {
            return Err(Error::msg("bad request"));
        }
        let q = vec![("isPerfectMatch", "false".to_string())];
        self.get_json(&format!("/Items/{id}/RemoteSearch/Subtitles/{lang}"), &q).await
    }

    /// Asks Jellyfin's metadata providers (TMDB, TVDB, ...) for matches. Uses POST,
    /// but only searches: nothing on the server changes.
    pub async fn remote_search(&self, kind: &str, name: &str, year: Option<i32>, ids: &HashMap<String, String>) -> Result<Vec<serde_json::Value>> {
        let kind = match kind {
            "series" => "Series",
            "movie" => "Movie",
            _ => return Err(Error::msg("bad kind")),
        };
        let body = serde_json::json!({
            "SearchInfo": { "Name": name, "Year": year, "ProviderIds": ids },
            "IncludeDisabledProviders": false
        });
        let req = self.http.post(self.url(&format!("/Items/RemoteSearch/{kind}"))).json(&body);
        Self::read_json(self.send(req).await?).await
    }

    /// Turns this read-only client into one that may change things. Only `AppState::writer`
    /// calls this, and only when the user has switched changes on.
    pub fn into_writer(self) -> Writer {
        Writer { c: self }
    }
}

/// Where the MediaSegments API plugin accepts new segments and deletions. Found in the
/// server's own API description, so the app adapts to the installed plugin version.
#[derive(Debug, Clone, PartialEq)]
pub struct SegmentApi {
    /// e.g. "/MediaSegmentsApi/{itemId}"
    pub create: String,
    /// e.g. "/MediaSegmentsApi/{segmentId}"
    pub delete: String,
}

pub fn parse_segment_api(spec: &serde_json::Value) -> Option<SegmentApi> {
    let paths = spec.get("paths")?.as_object()?;
    let mut create = None;
    let mut delete = None;
    for (path, methods) in paths {
        if !path.to_lowercase().contains("mediasegmentsapi") {
            continue;
        }
        let m = methods.as_object()?;
        if m.contains_key("post") && path.contains("{itemId}") && path.matches('{').count() == 1 {
            create.get_or_insert_with(|| path.clone());
        }
        if m.contains_key("delete") && path.matches('{').count() == 1 && !path.contains("{itemId}") {
            delete.get_or_insert_with(|| path.clone());
        }
    }
    Some(SegmentApi { create: create?, delete: delete? })
}

pub const TICKS_PER_SECOND: f64 = 10_000_000.0;

fn valid_segment_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

impl Client {
    /// Asks Jellyfin how to play an item on this computer. POST, but it changes nothing stored.
    pub async fn playback_info(&self, id: &str, device_id: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let req = self
            .http
            .post(self.url(&format!("/Items/{id}/PlaybackInfo")))
            .query(&self.with_user(vec![("deviceId", device_id.to_string())]))
            .json(body);
        Self::read_json(self.send(req).await?).await
    }

    /// Fetches a part of a playback stream (playlist, video piece or subtitle file).
    /// Only paths under /videos/ are allowed, so a stream token can't be used for anything else.
    pub async fn raw_get(&self, path_query: &str) -> Result<(Vec<u8>, String)> {
        let path = path_query.split('?').next().unwrap_or("");
        let low = path.to_lowercase();
        if !(low.starts_with("/videos/") || low.starts_with("/audio/")) || path.contains("..") || path_query.contains("://") {
            return Err(Error::msg("bad stream path"));
        }
        let mut req = self.http.get(self.url(path_query));
        if low.contains("/subtitles/") || low.contains("/trickplay/") {
            // Jellyfin pulls a subtitle out of the video file the first time: on a big file on
            // the NAS that takes longer than a normal request.
            req = req.timeout(Duration::from_secs(300));
        }
        let resp = self.send(req).await?;
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| Error::Network(e.without_url().to_string()))?;
        if bytes.len() > 200 * 1024 * 1024 {
            return Err(Error::msg("stream piece too large"));
        }
        Ok((bytes.to_vec(), ct))
    }

    /// The episode after `episode_id` in its show (None at the end).
    pub async fn next_episode(&self, series_id: &str, episode_id: &str) -> Result<Option<serde_json::Value>> {
        if !valid_item_id(series_id) || !valid_item_id(episode_id) {
            return Err(Error::msg("bad id"));
        }
        let q = self.with_user(vec![("StartItemId", episode_id.to_string()), ("Limit", "2".to_string())]);
        let v: serde_json::Value = self.get_json(&format!("/Shows/{series_id}/Episodes"), &q).await?;
        Ok(v.get("Items").and_then(|i| i.as_array()).and_then(|a| a.get(1)).cloned())
    }

    /// Play data for the chosen user (resume point). This is the one kind of write the
    /// read-only Client does, and only when "sync watched" is switched on.
    pub async fn save_position(&self, item_id: &str, seconds: f64) -> Result<()> {
        let user = self.user.clone().ok_or_else(|| Error::msg("no user"))?;
        if !valid_item_id(item_id) {
            return Err(Error::msg("bad id"));
        }
        let now = chrono_now();
        let body = serde_json::json!({ "PlaybackPositionTicks": (seconds * TICKS_PER_SECOND) as i64, "LastPlayedDate": now, "Played": false });
        let req = self.http.post(self.url(&format!("/UserItems/{item_id}/UserData"))).query(&[("userId", user.as_str())]).json(&body);
        if self.send(req).await.is_ok() {
            return Ok(());
        }
        self.save_position_legacy(item_id, seconds).await
    }

    /// The pre-10.9 route (some servers and proxies only accept this one).
    pub async fn save_position_legacy(&self, item_id: &str, seconds: f64) -> Result<()> {
        let user = self.user.clone().ok_or_else(|| Error::msg("no user"))?;
        if !valid_item_id(item_id) {
            return Err(Error::msg("bad id"));
        }
        let body = serde_json::json!({ "PlaybackPositionTicks": (seconds * TICKS_PER_SECOND) as i64, "LastPlayedDate": chrono_now(), "Played": false });
        let req = self.http.post(self.url(&format!("/Users/{user}/Items/{item_id}/UserData"))).json(&body);
        self.send(req).await.map(|_| ())
    }

    /// The saved position (seconds) for the chosen user.
    pub async fn saved_position(&self, item_id: &str) -> Result<f64> {
        if self.user.is_none() {
            return Err(Error::msg("No Jellyfin user chosen in Settings → Jellyfin."));
        }
        let v = self.item_json(item_id).await?;
        Ok(v.pointer("/UserData/PlaybackPositionTicks").and_then(serde_json::Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND)
    }

    /// Marks an item as watched for the chosen user (only with "sync watched" on).
    pub async fn mark_played(&self, item_id: &str) -> Result<()> {
        let user = self.user.clone().ok_or_else(|| Error::msg("no user"))?;
        if !valid_item_id(item_id) {
            return Err(Error::msg("bad id"));
        }
        let req = self.http.post(self.url(&format!("/UserPlayedItems/{item_id}"))).query(&[("userId", user.as_str())]).header("Content-Length", "0");
        if self.send(req).await.is_ok() {
            return Ok(());
        }
        let req = self.http.post(self.url(&format!("/Users/{user}/PlayedItems/{item_id}"))).header("Content-Length", "0");
        self.send(req).await.map(|_| ())
    }

    /// Marks an item as not watched for the chosen user.
    pub async fn mark_unplayed(&self, item_id: &str) -> Result<()> {
        let user = self.user.clone().ok_or_else(|| Error::msg("no user"))?;
        if !valid_item_id(item_id) {
            return Err(Error::msg("bad id"));
        }
        let req = self.http.delete(self.url(&format!("/UserPlayedItems/{item_id}"))).query(&[("userId", user.as_str())]);
        if self.send(req).await.is_ok() {
            return Ok(());
        }
        let req = self.http.delete(self.url(&format!("/Users/{user}/PlayedItems/{item_id}")));
        self.send(req).await.map(|_| ())
    }

    /// Tells Jellyfin to stop converting for a finished playback. Changes nothing stored.
    pub async fn stop_encoding(&self, device_id: &str, play_session_id: &str) -> Result<()> {
        let req = self
            .http
            .delete(self.url("/Videos/ActiveEncodings"))
            .query(&[("deviceId", device_id), ("playSessionId", play_session_id)]);
        self.send(req).await.map(|_| ())
    }

    pub async fn segment_api(&self) -> Result<Option<SegmentApi>> {
        let spec: serde_json::Value = self.get_json("/api-docs/openapi.json", &[]).await?;
        Ok(parse_segment_api(&spec))
    }

    /// Segments Jellyfin knows for an item: [{Id, Type, StartTicks, EndTicks}, ...].
    pub async fn segments(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let v: serde_json::Value = self.get_json(&format!("/MediaSegments/{id}"), &[]).await?;
        Ok(v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default())
    }
}

/// The current time as Jellyfin writes dates ("2026-10-25T12:00:00.000Z").
fn chrono_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// The only type that can change anything in Jellyfin.
pub struct Writer {
    c: Client,
}

impl Writer {
    async fn post(&self, path: &str, query: &[(&str, String)], body: Option<&serde_json::Value>) -> Result<()> {
        let mut req = self.c.http.post(self.c.url(path)).query(query);
        req = match body {
            Some(b) => req.json(b),
            None => req.header("Content-Length", "0"),
        };
        self.c.send(req).await.map(|_| ())
    }

    pub fn reader(&self) -> &Client {
        &self.c
    }

    /// Saves the complete item. `item` must be the full JSON from `item_json` with edits applied.
    pub async fn update_item(&self, id: &str, item: &serde_json::Value) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.post(&format!("/Items/{id}"), &[], Some(item)).await
    }

    pub async fn apply_remote(&self, id: &str, result: &serde_json::Value, replace_images: bool) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![("replaceAllImages", replace_images.to_string())];
        self.post(&format!("/Items/RemoteSearch/Apply/{id}"), &q, Some(result)).await
    }

    pub async fn download_remote_image(&self, id: &str, kind: &str, url: &str) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let kind = image_kind(kind).ok_or_else(|| Error::msg("bad image kind"))?;
        let q = vec![("type", kind.to_string()), ("imageUrl", url.to_string())];
        self.post(&format!("/Items/{id}/RemoteImages/Download"), &q, None).await
    }

    /// Uploads a picture (used to put a backup back). Jellyfin expects the bytes base64-encoded.
    pub async fn upload_image(&self, id: &str, kind: &str, index: u32, bytes: &[u8], content_type: &str) -> Result<()> {
        use base64::Engine;
        let path = Client::image_path(id, kind, index)?;
        let body = base64::engine::general_purpose::STANDARD.encode(bytes);
        let req = self
            .c
            .http
            .post(self.c.url(&path))
            .header("Content-Type", content_type)
            .body(body);
        self.c.send(req).await.map(|_| ())
    }

    pub async fn delete_image(&self, id: &str, kind: &str, index: u32) -> Result<()> {
        let path = Client::image_path(id, kind, index)?;
        let req = self.c.http.delete(self.c.url(&path));
        self.c.send(req).await.map(|_| ())
    }

    /// Jellyfin downloads the subtitle and stores it with the video.
    pub async fn subtitle_download(&self, id: &str, subtitle_id: &str) -> Result<()> {
        // The id goes into the URL path, so only plain characters are accepted.
        let plain = subtitle_id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        if !valid_item_id(id) || subtitle_id.is_empty() || subtitle_id.len() > 200 || !plain {
            return Err(Error::msg("bad request"));
        }
        self.post(&format!("/Items/{id}/RemoteSearch/Subtitles/{subtitle_id}"), &[], None).await
    }

    /// The subtitle file itself, straight from the provider (Media Hub saves it next to the video).
    pub async fn subtitle_file(&self, subtitle_id: &str) -> Result<Vec<u8>> {
        let plain = subtitle_id.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        if subtitle_id.is_empty() || subtitle_id.len() > 200 || !plain {
            return Err(Error::msg("bad request"));
        }
        let resp = self.c.get(&format!("/Providers/Subtitles/Subtitles/{subtitle_id}"), &[]).await?;
        let bytes = resp.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err(Error::msg("subtitle file too large"));
        }
        Ok(bytes.to_vec())
    }

    /// Removes an external subtitle stream. Only used to undo a download made by this app.
    pub async fn subtitle_delete(&self, id: &str, index: i64) -> Result<()> {
        if !valid_item_id(id) || index < 0 {
            return Err(Error::msg("bad request"));
        }
        let req = self.c.http.delete(self.c.url(&format!("/Videos/{id}/Subtitles/{index}")));
        self.c.send(req).await.map(|_| ())
    }

    pub async fn segment_create(&self, api: &SegmentApi, id: &str, kind: &str, start: f64, end: f64, provider: &str) -> Result<()> {
        if !valid_item_id(id) || !["Intro", "Outro", "Recap", "Preview", "Commercial"].contains(&kind) || !(0.0..end).contains(&start) {
            return Err(Error::msg("bad segment"));
        }
        let body = serde_json::json!({
            "ItemId": id,
            "Type": kind,
            "StartTicks": (start * TICKS_PER_SECOND).round() as i64,
            "EndTicks": (end * TICKS_PER_SECOND).round() as i64,
        });
        let path = api.create.replace("{itemId}", id);
        self.post(&path, &[("providerId", provider.to_string())], Some(&body)).await
    }

    pub async fn segment_delete(&self, api: &SegmentApi, segment_id: &str) -> Result<()> {
        if !valid_segment_id(segment_id) {
            return Err(Error::msg("bad segment id"));
        }
        let start = api.delete.find('{').ok_or_else(|| Error::msg("bad api"))?;
        let end = api.delete[start..].find('}').map(|e| start + e + 1).ok_or_else(|| Error::msg("bad api"))?;
        let path = format!("{}{}{}", &api.delete[..start], segment_id, &api.delete[end..]);
        let req = self.c.http.delete(self.c.url(&path));
        self.c.send(req).await.map(|_| ())
    }

    /// A light refresh: Jellyfin looks at the files again (finds new subtitles), keeps all details.
    pub async fn refresh_light(&self, id: &str) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("metadataRefreshMode", "Default".to_string()),
            ("imageRefreshMode", "Default".to_string()),
            ("replaceAllMetadata", "false".to_string()),
            ("replaceAllImages", "false".to_string()),
        ];
        self.post(&format!("/Items/{id}/Refresh"), &q, None).await
    }

    pub async fn refresh(&self, id: &str, replace_all: bool) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("metadataRefreshMode", "FullRefresh".to_string()),
            ("imageRefreshMode", "FullRefresh".to_string()),
            ("replaceAllMetadata", replace_all.to_string()),
            ("replaceAllImages", "false".to_string()),
        ];
        self.post(&format!("/Items/{id}/Refresh"), &q, None).await
    }
}


/// Fields the home page, collections and "more like this" lists need.
const LIST_FIELDS: &str = "ProductionYear,PremiereDate,RunTimeTicks,ChildCount,SeriesName,SeriesId,ParentIndexNumber,IndexNumber,CommunityRating,Genres,ProviderIds,DateCreated";

fn ids_param(ids: &[String]) -> Result<String> {
    if ids.is_empty() || ids.len() > 500 || !ids.iter().all(|i| valid_item_id(i)) {
        return Err(Error::msg("bad ids"));
    }
    Ok(ids.join(","))
}

impl Client {
    fn items_of(v: serde_json::Value) -> Vec<serde_json::Value> {
        v.get("Items").and_then(|i| i.as_array()).cloned().unwrap_or_default()
    }

    /// Asks Jellyfin to look for new and renamed files. Changes no metadata.
    pub async fn library_scan(&self) -> Result<()> {
        let req = self.http.post(self.url("/Library/Refresh")).header("Content-Length", "0");
        self.send(req).await.map(|_| ())
    }

    pub async fn collections(&self) -> Result<Vec<serde_json::Value>> {
        let q = vec![
            ("IncludeItemTypes", "BoxSet".to_string()),
            ("Recursive", "true".to_string()),
            ("SortBy", "SortName".to_string()),
            ("Fields", format!("{LIST_FIELDS},Overview")),
        ];
        Ok(Self::items_of(self.get_json("/Items", &self.with_user(q)).await?))
    }

    pub async fn collection_items(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![("ParentId", id.to_string()), ("Fields", LIST_FIELDS.to_string()), ("SortBy", "ProductionYear,SortName".to_string())];
        Ok(Self::items_of(self.get_json("/Items", &self.with_user(q)).await?))
    }

    /// Newest movies and episodes.
    pub async fn recently_added(&self, limit: u32) -> Result<Vec<serde_json::Value>> {
        let q = vec![
            ("IncludeItemTypes", "Movie,Episode".to_string()),
            ("Recursive", "true".to_string()),
            ("SortBy", "DateCreated".to_string()),
            ("SortOrder", "Descending".to_string()),
            ("Fields", LIST_FIELDS.to_string()),
            ("Limit", limit.min(100).to_string()),
        ];
        Ok(Self::items_of(self.get_json("/Items", &self.with_user(q)).await?))
    }

    pub async fn similar(&self, id: &str, limit: u32) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![("limit", limit.min(40).to_string()), ("fields", LIST_FIELDS.to_string())];
        Ok(Self::items_of(self.get_json(&format!("/Items/{id}/Similar"), &self.with_user(q)).await?))
    }

    /// Movies and shows a person appears in.
    pub async fn person_items(&self, person_id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(person_id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("PersonIds", person_id.to_string()),
            ("IncludeItemTypes", "Movie,Series".to_string()),
            ("Recursive", "true".to_string()),
            ("SortBy", "ProductionYear".to_string()),
            ("SortOrder", "Descending".to_string()),
            ("Fields", LIST_FIELDS.to_string()),
            ("Limit", "60".to_string()),
        ];
        Ok(Self::items_of(self.get_json("/Items", &self.with_user(q)).await?))
    }
}

impl Writer {
    async fn post_json(&self, path: &str, query: &[(&str, String)]) -> Result<serde_json::Value> {
        let req = self.c.http.post(self.c.url(path)).query(query).header("Content-Length", "0");
        let resp = self.c.send(req).await?;
        Client::read_json(resp).await
    }

    /// Moves a picture to another position (backdrop 3 becomes backdrop 0, the main one).
    pub async fn move_image(&self, id: &str, kind: &str, index: u32, new_index: u32) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let kind = image_kind(kind).ok_or_else(|| Error::msg("bad image kind"))?;
        if index == new_index {
            return Ok(());
        }
        self.post(&format!("/Items/{id}/Images/{kind}/{index}/Index"), &[("newIndex", new_index.to_string())], None).await
    }

    /// Saves a plugin's whole configuration (read it first with `plugin_config`).
    pub async fn set_plugin_config(&self, id: &str, config: &serde_json::Value) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.post(&format!("/Plugins/{id}/Configuration"), &[], Some(config)).await
    }

    /// Makes a new collection and returns its id.
    pub async fn collection_create(&self, name: &str, ids: &[String]) -> Result<String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 200 {
            return Err(Error::msg("Give the collection a name."));
        }
        let mut q = vec![("name", name.to_string())];
        if !ids.is_empty() {
            q.push(("ids", ids_param(ids)?));
        }
        let v = self.post_json("/Collections", &q).await?;
        v.get("Id").and_then(|i| i.as_str()).filter(|i| valid_item_id(i)).map(String::from).ok_or_else(|| Error::msg("Jellyfin did not return the new collection."))
    }

    pub async fn collection_add(&self, id: &str, ids: &[String]) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.post(&format!("/Collections/{id}/Items"), &[("ids", ids_param(ids)?)], None).await
    }

    pub async fn collection_remove(&self, id: &str, ids: &[String]) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let req = self.c.http.delete(self.c.url(&format!("/Collections/{id}/Items"))).query(&[("ids", ids_param(ids)?)]);
        self.c.send(req).await.map(|_| ())
    }

    /// Removes a collection (only the collection; the movies and shows in it stay).
    /// Checks first that the id really is a collection.
    pub async fn collection_delete(&self, id: &str) -> Result<()> {
        let item = self.c.item_json(id).await?;
        if item.get("Type").and_then(|t| t.as_str()) != Some("BoxSet") {
            return Err(Error::msg("That is not a collection."));
        }
        let req = self.c.http.delete(self.c.url(&format!("/Items/{id}")));
        self.c.send(req).await.map(|_| ())
    }
}

/// For fields that can be "leave as is" (missing), "clear" (null) or "set" (value).
fn double<'de, D, T>(d: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    use serde::Deserialize as _;
    Option::<T>::deserialize(d).map(Some)
}

/// Edits the user can make on the metadata screen. `None` means "leave as is".
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEdits {
    pub name: Option<String>,
    pub original_title: Option<String>,
    pub sort_name: Option<String>,
    #[serde(default, deserialize_with = "double")]
    pub production_year: Option<Option<i32>>,
    pub overview: Option<String>,
    pub genres: Option<Vec<String>>,
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double")]
    pub community_rating: Option<Option<f64>>,
    pub official_rating: Option<String>,
    pub provider_ids: Option<HashMap<String, String>>,
    pub lock_data: Option<bool>,
    /// Language Jellyfin uses for this item's titles and summaries ("en", "nl", ...).
    pub preferred_language: Option<String>,
}

/// Applies edits to the full item JSON, touching only the edited keys.
pub fn apply_edits(item: &mut serde_json::Value, e: &ItemEdits) -> Result<()> {
    use serde_json::{json, Value};
    let obj = item
        .as_object_mut()
        .ok_or_else(|| Error::msg("Unexpected item format from Jellyfin."))?;
    let clean = |s: &str| s.trim().to_string();
    if let Some(v) = &e.name {
        if v.trim().is_empty() {
            return Err(Error::msg("The name cannot be empty."));
        }
        obj.insert("Name".into(), json!(clean(v)));
    }
    if let Some(v) = &e.original_title {
        obj.insert("OriginalTitle".into(), json!(clean(v)));
    }
    if let Some(v) = &e.sort_name {
        // Jellyfin keeps the user's sort title in ForcedSortName.
        obj.insert("ForcedSortName".into(), json!(clean(v)));
    }
    if let Some(v) = &e.production_year {
        if let Some(y) = v {
            if !(1870..=2100).contains(y) {
                return Err(Error::msg("That year looks wrong."));
            }
        }
        obj.insert("ProductionYear".into(), json!(v));
    }
    if let Some(v) = &e.overview {
        obj.insert("Overview".into(), json!(v.trim()));
    }
    let list = |v: &Vec<String>| -> Value {
        let mut out: Vec<String> = Vec::new();
        for s in v.iter().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(s)) {
                out.push(s.to_string());
            }
        }
        json!(out)
    };
    if let Some(v) = &e.genres {
        obj.insert("Genres".into(), list(v));
    }
    if let Some(v) = &e.tags {
        obj.insert("Tags".into(), list(v));
    }
    if let Some(v) = &e.community_rating {
        if let Some(r) = v {
            if !(0.0..=10.0).contains(r) {
                return Err(Error::msg("Ratings go from 0 to 10."));
            }
        }
        obj.insert("CommunityRating".into(), json!(v));
    }
    if let Some(v) = &e.official_rating {
        obj.insert("OfficialRating".into(), json!(clean(v)));
    }
    if let Some(ids) = &e.provider_ids {
        let mut map = obj
            .get("ProviderIds")
            .and_then(|p| p.as_object())
            .cloned()
            .unwrap_or_default();
        for (k, v) in ids {
            let key = match k.to_lowercase().as_str() {
                "tmdb" => "Tmdb",
                "tvdb" => "Tvdb",
                "imdb" => "Imdb",
                _ => return Err(Error::msg(format!("Unknown id type {k}."))),
            };
            let val = v.trim();
            if val.is_empty() {
                map.remove(key);
            } else if val.chars().all(|c| c.is_ascii_alphanumeric()) {
                map.insert(key.into(), json!(val));
            } else {
                return Err(Error::msg(format!("The {key} id may only contain letters and digits.")));
            }
        }
        obj.insert("ProviderIds".into(), Value::Object(map));
    }
    if let Some(v) = e.lock_data {
        obj.insert("LockData".into(), json!(v));
    }
    if let Some(v) = &e.preferred_language {
        let v = v.trim();
        if v.len() > 10 || !v.chars().all(|c| c.is_ascii_alphabetic() || c == '-') {
            return Err(Error::msg("bad language"));
        }
        obj.insert("PreferredMetadataLanguage".into(), json!(v));
    }
    Ok(())
}

#[cfg(test)]
mod date_tests {
    #[test]
    fn dates_look_right() {
        let d = super::chrono_now();
        assert_eq!(d.len(), 24);
        assert!(d.starts_with("20") && d.ends_with(".000Z") && &d[10..11] == "T");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "Items": [
        {"Id":"0123456789abcdef0123456789abcdef","Name":"Bluey","SortName":"bluey","Type":"Series",
         "ProductionYear":2018,"CommunityRating":9.1,"Genres":["Kids","Animation"],
         "Overview":"A family of dogs.","DateCreated":"2024-01-01T10:00:00.0000000Z",
         "ImageTags":{"Primary":"abc","Logo":"def"},"ProviderIds":{"Tvdb":"353546"},"ChildCount":3,"RecursiveItemCount":151,
         "UserData":{"Played":true}},
        {"Id":"fedcba9876543210fedcba9876543210","Name":"Inception","Type":"Movie","Genres":null,"ImageTags":{}},
        {"Id":"11111111111111111111111111111111","Name":"Some Season","Type":"Season"}
      ],
      "TotalRecordCount": 3,
      "StartIndex": 0
    }"#;

    #[test]
    fn parses_a_jellyfin_page() {
        let page: Page = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(page.total_record_count, 3);
        let items: Vec<NewItem> = page.items.into_iter().filter_map(|i| i.into_new("lib")).collect();
        assert_eq!(items.len(), 2, "seasons must be skipped");
        assert_eq!(items[0].kind, "series");
        assert!(items[0].has_poster);
        assert_eq!(items[0].genres, vec!["Kids", "Animation"]);
        assert!(items[0].matched && items[0].played);
        assert_eq!((items[0].seasons, items[0].episodes), (Some(3), Some(151)));
        assert!(!items[1].matched);
        assert_eq!(items[1].kind, "movie");
        assert!(!items[1].has_poster);
        assert_eq!(items[1].sort_name, "inception");
        assert!(items[1].genres.is_empty());
    }

    #[test]
    fn finds_segment_endpoints_in_the_api_description() {
        let spec = serde_json::json!({"paths": {
            "/MediaSegments/{itemId}": {"get": {}},
            "/MediaSegmentsApi/{itemId}": {"post": {}, "get": {}},
            "/MediaSegmentsApi/{segmentId}": {"delete": {}},
            "/MediaSegmentsApi/{itemId}/{type}": {"delete": {}}
        }});
        let api = parse_segment_api(&spec).unwrap();
        assert_eq!(api.create, "/MediaSegmentsApi/{itemId}");
        assert_eq!(api.delete, "/MediaSegmentsApi/{segmentId}");
        assert!(parse_segment_api(&serde_json::json!({"paths": {"/MediaSegments/{itemId}": {"get": {}}}})).is_none());
        assert!(valid_segment_id("3f2b6c1e-0000-4abc-9def-1234567890ab"));
        assert!(!valid_segment_id("../x"));
    }

    #[test]
    fn edits_touch_only_what_changed() {
        let mut item = serde_json::json!({
            "Name": "Old", "Overview": "x", "Genres": ["Kids"], "People": [{"Name": "Someone"}],
            "ProviderIds": {"Tmdb": "1", "Tvdb": "2"}, "Unknown": {"keep": true}
        });
        let mut ids = HashMap::new();
        ids.insert("tvdb".to_string(), "".to_string());
        ids.insert("imdb".to_string(), "tt0133093".to_string());
        let e = ItemEdits {
            name: Some(" New ".into()),
            genres: Some(vec!["Kids".into(), " kids ".into(), "Animation".into(), "".into()]),
            production_year: Some(Some(2018)),
            provider_ids: Some(ids),
            ..Default::default()
        };
        apply_edits(&mut item, &e).unwrap();
        assert_eq!(item["Name"], "New");
        assert_eq!(item["Genres"], serde_json::json!(["Kids", "Animation"]));
        assert_eq!(item["ProductionYear"], 2018);
        assert_eq!(item["ProviderIds"], serde_json::json!({"Tmdb": "1", "Imdb": "tt0133093"}));
        assert_eq!(item["People"][0]["Name"], "Someone");
        assert_eq!(item["Unknown"]["keep"], true);
        assert_eq!(item["Overview"], "x");
    }

    #[test]
    fn missing_null_and_value_are_different() {
        let e: ItemEdits = serde_json::from_str(r#"{"productionYear": null}"#).unwrap();
        assert_eq!(e.production_year, Some(None));
        let e: ItemEdits = serde_json::from_str(r#"{"productionYear": 2001}"#).unwrap();
        assert_eq!(e.production_year, Some(Some(2001)));
        let e: ItemEdits = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(e.production_year, None);
    }

    #[test]
    fn bad_edits_are_refused() {
        let mut item = serde_json::json!({"Name": "A"});
        assert!(apply_edits(&mut item, &ItemEdits { name: Some("  ".into()), ..Default::default() }).is_err());
        assert!(apply_edits(&mut item, &ItemEdits { community_rating: Some(Some(11.0)), ..Default::default() }).is_err());
        let mut ids = HashMap::new();
        ids.insert("tmdb".to_string(), "1/../2".to_string());
        assert!(apply_edits(&mut item, &ItemEdits { provider_ids: Some(ids), ..Default::default() }).is_err());
        let mut bad = HashMap::new();
        bad.insert("other".to_string(), "1".to_string());
        assert!(apply_edits(&mut item, &ItemEdits { provider_ids: Some(bad), ..Default::default() }).is_err());
    }

    #[test]
    fn episode_titles_cover_double_episodes() {
        let page: EpisodePage = serde_json::from_str(r#"{"Items":[
            {"Name":"Magic Xylophone","IndexNumber":1,"ParentIndexNumber":1},
            {"Name":"Double","IndexNumber":3,"IndexNumberEnd":4,"ParentIndexNumber":1},
            {"Name":"No number","ParentIndexNumber":1}
        ]}"#).unwrap();
        let t = episode_titles(&page.items);
        assert_eq!(t.get(&(1, 1)).map(String::as_str), Some("Magic Xylophone"));
        assert_eq!(t.get(&(1, 4)).map(String::as_str), Some("Double"));
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn not_found_names_the_right_thing() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(not_found_text(&format!("/Items/{id}")), TITLE_GONE);
        assert_eq!(not_found_text(&format!("/Users/{id}/Items/{id}")), TITLE_GONE);
        assert!(not_found_text(&format!("/MediaSegments/{id}")).contains("plugin"));
        assert!(not_found_text("/Providers/Subtitles/Subtitles/abc").contains("subtitle"));
        assert!(not_found_text(&format!("/Items/{id}/Images/Logo")).contains("picture"));
        assert!(!not_found_text("/Library/VirtualFolders").contains("no longer"));
    }

    #[test]
    fn id_and_image_kind_checks() {
        assert!(valid_item_id("0123456789abcdef0123456789abcdef"));
        assert!(!valid_item_id("../../etc/passwd"));
        assert!(!valid_item_id("0123456789abcdef0123456789abcde"));
        assert_eq!(image_kind("Primary"), Some("Primary"));
        assert_eq!(image_kind("Primary/../x"), None);
    }

    #[test]
    fn client_rejects_odd_keys() {
        assert!(Client::new("http://x", "bad\"key1234").is_err());
        assert!(Client::new("http://x", "0123456789abcdef0123456789abcdef").is_ok());
    }
}

// ------------------------------------------------------------- 0.11 additions

impl Client {
    /// Any /Items query as the chosen user (all pages up to `max`).
    pub async fn items_query(&self, mut q: Vec<(&'static str, String)>, max: usize) -> Result<Vec<serde_json::Value>> {
        let mut out = Vec::new();
        let page = 1000usize.min(max.max(1));
        q.push(("Limit", page.to_string()));
        q.push(("EnableTotalRecordCount", "false".to_string()));
        loop {
            let mut qq = q.clone();
            qq.push(("StartIndex", out.len().to_string()));
            let v: serde_json::Value = self.get_json("/Items", &self.with_user(qq)).await?;
            let items = Self::items_of(v);
            let n = items.len();
            out.extend(items);
            if n < page || out.len() >= max {
                break;
            }
        }
        out.truncate(max);
        Ok(out)
    }

    /// Installed server plugins: (name, version, status).
    pub async fn plugins(&self) -> Result<Vec<(String, String, String)>> {
        let v: serde_json::Value = self.get_json("/Plugins", &[]).await?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .map(|p| {
                let s = |k: &str| p.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
                (s("Name"), s("Version"), s("Status"))
            })
            .collect())
    }

    /// Id of the first installed plugin whose name matches.
    pub async fn plugin_id(&self, name_has: &str) -> Result<Option<String>> {
        let v: serde_json::Value = self.get_json("/Plugins", &[]).await?;
        Ok(v.as_array().into_iter().flatten().find_map(|p| {
            let n = p.get("Name")?.as_str()?.to_lowercase();
            n.contains(name_has).then(|| p.get("Id")?.as_str().map(|x| x.replace('-', "")))?
        }))
    }

    pub async fn plugin_config(&self, id: &str) -> Result<serde_json::Value> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        self.get_json(&format!("/Plugins/{id}/Configuration"), &[]).await
    }

    /// Playlists of the chosen user.
    pub async fn playlists(&self) -> Result<Vec<serde_json::Value>> {
        let q = vec![("IncludeItemTypes", "Playlist".to_string()), ("Recursive", "true".to_string())];
        Ok(Self::items_of(self.get_json("/Items", &self.with_user(q)).await?))
    }

    /// Entries of a playlist (each has PlaylistItemId).
    pub async fn playlist_items(&self, id: &str) -> Result<Vec<serde_json::Value>> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        Ok(Self::items_of(self.get_json(&format!("/Playlists/{id}/Items"), &self.with_user(vec![])).await?))
    }
}

impl Writer {
    /// Groups items as versions of one title (Jellyfin "merge versions").
    pub async fn merge_versions(&self, ids: &[String]) -> Result<()> {
        if ids.len() < 2 {
            return Err(Error::msg("Pick at least two."));
        }
        self.post("/Videos/MergeVersions", &[("ids", ids_param(ids)?)], None).await
    }

    /// Makes a playlist for the chosen user and returns its id.
    pub async fn playlist_create(&self, name: &str, ids: &[String]) -> Result<String> {
        let user = self.c.user.clone().ok_or_else(|| Error::msg("Choose a user in Settings first."))?;
        let body = serde_json::json!({ "Name": name, "Ids": ids, "UserId": user, "MediaType": "Video" });
        let req = self.c.http.post(self.c.url("/Playlists")).json(&body);
        let resp = self.c.send(req).await?;
        let v: serde_json::Value = Client::read_json(resp).await?;
        v.get("Id").and_then(|i| i.as_str()).map(|s| s.replace('-', "")).filter(|i| valid_item_id(i)).ok_or_else(|| Error::msg("Jellyfin did not return the playlist."))
    }

    pub async fn playlist_add(&self, id: &str, ids: &[String]) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let mut q = vec![("ids", ids_param(ids)?)];
        if let Some(u) = &self.c.user {
            q.push(("userId", u.clone()));
        }
        self.post(&format!("/Playlists/{id}/Items"), &q, None).await
    }

    pub async fn playlist_remove_entries(&self, id: &str, entry_ids: &[String]) -> Result<()> {
        if !valid_item_id(id) || entry_ids.is_empty() {
            return Ok(());
        }
        let clean: Vec<String> = entry_ids.iter().filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).cloned().collect();
        let req = self.c.http.delete(self.c.url(&format!("/Playlists/{id}/Items"))).query(&[("entryIds", clean.join(","))]);
        self.c.send(req).await.map(|_| ())
    }
}

// ------------------------------------------------------------- 0.12 additions

impl Client {
    /// All user views with their kind ("movies", "tvshows", "boxsets", "playlists", "music" …).
    pub async fn all_views(&self) -> Result<Vec<(String, String, String)>> {
        let v: serde_json::Value = self.get_json("/UserViews", &self.with_user(vec![])).await?;
        Ok(v.get("Items")
            .and_then(|i| i.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| {
                        let kind = x.get("CollectionType").and_then(|c| c.as_str()).unwrap_or("mixed").to_string();
                        Some((x.get("Id")?.as_str()?.replace('-', ""), x.get("Name")?.as_str()?.to_string(), kind))
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Libraries as the server sets them up (with their options).
    pub async fn virtual_folders(&self) -> Result<Vec<serde_json::Value>> {
        let v: serde_json::Value = self.get_json("/Library/VirtualFolders", &[]).await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    /// Album artists, sorted by name.
    pub async fn album_artists(&self, query: &str, start: u64, limit: u64) -> Result<serde_json::Value> {
        let mut q = vec![
            ("SortBy", "SortName".to_string()),
            ("StartIndex", start.to_string()),
            ("Limit", limit.min(500).to_string()),
            ("Fields", "ChildCount".to_string()),
        ];
        if !query.is_empty() {
            q.push(("SearchTerm", query.chars().take(100).collect()));
        }
        self.get_json("/Artists/AlbumArtists", &self.with_user(q)).await
    }
}

impl Writer {
    pub async fn set_favorite(&self, id: &str, favorite: bool) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let user = self.c.user.clone().ok_or_else(|| Error::msg("Choose a user in Settings first."))?;
        let url = self.c.url(&format!("/UserFavoriteItems/{id}"));
        let req = if favorite { self.c.http.post(url).header("Content-Length", "0") } else { self.c.http.delete(url) };
        if self.c.send(req.query(&[("userId", user.as_str())])).await.is_ok() {
            return Ok(());
        }
        // Jellyfin before 10.9
        let url = self.c.url(&format!("/Users/{user}/FavoriteItems/{id}"));
        let req = if favorite { self.c.http.post(url).header("Content-Length", "0") } else { self.c.http.delete(url) };
        self.c.send(req).await.map(|_| ())
    }

    pub async fn set_library_options(&self, id: &str, options: &serde_json::Value) -> Result<()> {
        let body = serde_json::json!({ "Id": id, "LibraryOptions": options });
        let req = self.c.http.post(self.c.url("/Library/VirtualFolders/LibraryOptions")).json(&body);
        self.c.send(req).await.map(|_| ())
    }

    /// Fetches titles and summaries again for everything in a library (pictures stay).
    pub async fn refresh_library_metadata(&self, id: &str) -> Result<()> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let q = vec![
            ("Recursive", "true".to_string()),
            ("metadataRefreshMode", "FullRefresh".to_string()),
            ("imageRefreshMode", "Default".to_string()),
            ("replaceAllMetadata", "true".to_string()),
            ("replaceAllImages", "false".to_string()),
        ];
        self.post(&format!("/Items/{id}/Refresh"), &q, None).await
    }
}

// ------------------------------------------------------------- 0.13 additions

impl Client {
    /// Jellyfin's scheduled tasks (scans, chapter pictures, trickplay …) with their triggers.
    pub async fn scheduled_tasks(&self) -> Result<Vec<serde_json::Value>> {
        let v: serde_json::Value = self.get_json("/ScheduledTasks", &[("isHidden", "false".to_string())]).await?;
        Ok(v.as_array().cloned().unwrap_or_default())
    }

    /// Tells Jellyfin that these folders or files changed, so it looks only there instead of
    /// scanning every library. Paths are as the server sees them.
    pub async fn media_updated(&self, server_paths: &[String]) -> Result<()> {
        if server_paths.is_empty() || server_paths.len() > 200 {
            return Err(Error::msg("bad paths"));
        }
        let updates: Vec<serde_json::Value> = server_paths.iter().map(|p| serde_json::json!({ "Path": p, "UpdateType": "Modified" })).collect();
        let req = self.http.post(self.url("/Library/Media/Updated")).json(&serde_json::json!({ "Updates": updates }));
        self.send(req).await.map(|_| ())
    }
}

impl Writer {
    pub async fn set_task_triggers(&self, task_id: &str, triggers: &serde_json::Value) -> Result<()> {
        if !task_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || task_id.is_empty() || task_id.len() > 40 || !triggers.is_array() {
            return Err(Error::msg("bad task"));
        }
        let req = self.c.http.post(self.c.url(&format!("/ScheduledTasks/{task_id}/Triggers"))).json(triggers);
        self.c.send(req).await.map(|_| ())
    }

    pub async fn run_task(&self, task_id: &str) -> Result<()> {
        if !task_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') || task_id.is_empty() || task_id.len() > 40 {
            return Err(Error::msg("bad task"));
        }
        self.post(&format!("/ScheduledTasks/Running/{task_id}"), &[], None).await
    }
}
