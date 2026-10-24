//! Read-only Jellyfin client.
//!
//! This type only knows how to send GET requests. There is no function here that can
//! change anything on the server, which is how "read-only" is guaranteed in module 1.
//! Later modules that write get their own, separate, clearly named client.

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
}

impl RawItem {
    /// Returns None for item types we do not list (module 1 lists movies and shows).
    pub fn into_new(self) -> Option<NewItem> {
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
        Some(NewItem {
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
            .user_agent("MediaHub/0.1")
            .build()
            .map_err(|e| Error::msg(e.to_string()))?;
        Ok(Client {
            http,
            base: base.trim_end_matches('/').to_string(),
            auth: format!("MediaBrowser Token=\"{api_key}\""),
        })
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<reqwest::Response> {
        let resp = self
            .http
            .get(format!("{}{}", self.base, path))
            .query(query)
            .header("Authorization", &self.auth)
            .send()
            .await
            .map_err(|e| Error::Network(e.without_url().to_string()))?;
        match resp.status().as_u16() {
            200..=299 => Ok(resp),
            401 | 403 => Err(Error::Unauthorized),
            s => Err(Error::msg(format!("The server answered with status {s}."))),
        }
    }

    async fn get_json<T: DeserializeOwned>(&self, path: &str, query: &[(&str, String)]) -> Result<T> {
        let resp = self.get(path, query).await?;
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

    /// Does not need the key; proves that something answers at this address.
    pub async fn ping(&self) -> Result<()> {
        self.get("/System/Info/Public", &[]).await.map(|_| ())
    }

    /// Needs a valid key, so this is the real "does the key work" check.
    pub async fn system_info(&self) -> Result<ServerInfo> {
        self.get_json("/System/Info", &[]).await
    }

    pub async fn items_page(&self, start: u64, limit: u64) -> Result<Page> {
        let q = vec![
            ("IncludeItemTypes", "Movie,Series".to_string()),
            ("Recursive", "true".to_string()),
            ("Fields", "Genres,Overview,DateCreated,SortName".to_string()),
            ("SortBy", "SortName".to_string()),
            ("StartIndex", start.to_string()),
            ("Limit", limit.to_string()),
        ];
        self.get_json("/Items", &q).await
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
        let page: EpisodePage = self.get_json("/Items", &q).await?;
        Ok(page.items)
    }

    /// Returns (bytes, content-type) of one picture. Only allow-listed picture kinds.
    pub async fn image(&self, id: &str, kind: &str, max_width: u32) -> Result<(Vec<u8>, String)> {
        if !valid_item_id(id) {
            return Err(Error::msg("bad id"));
        }
        let kind = image_kind(kind).ok_or_else(|| Error::msg("bad image kind"))?;
        let q = vec![
            ("maxWidth", max_width.clamp(64, 1920).to_string()),
            ("quality", "85".to_string()),
        ];
        let resp = self.get(&format!("/Items/{id}/Images/{kind}"), &q).await?;
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
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "Items": [
        {"Id":"0123456789abcdef0123456789abcdef","Name":"Bluey","SortName":"bluey","Type":"Series",
         "ProductionYear":2018,"CommunityRating":9.1,"Genres":["Kids","Animation"],
         "Overview":"A family of dogs.","DateCreated":"2024-01-01T10:00:00.0000000Z",
         "ImageTags":{"Primary":"abc","Logo":"def"}},
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
        let items: Vec<NewItem> = page.items.into_iter().filter_map(RawItem::into_new).collect();
        assert_eq!(items.len(), 2, "seasons must be skipped");
        assert_eq!(items[0].kind, "series");
        assert!(items[0].has_poster);
        assert_eq!(items[0].genres, vec!["Kids", "Animation"]);
        assert_eq!(items[1].kind, "movie");
        assert!(!items[1].has_poster);
        assert_eq!(items[1].sort_name, "inception");
        assert!(items[1].genres.is_empty());
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
