//! Serves pictures to the window through a private address scheme (`hubimg://`).
//! The window never sees the server address or the API key. Two kinds of address:
//!   /<item id>/<Primary|Backdrop|...>[/<index>]?w=<width>   picture stored in Jellyfin
//!   /remote?u=<https url>                                    candidate picture from TMDB/TVDB/fanart
//! Remote pictures are only fetched from a short list of known image hosts.

use crate::error::{Error, Result};
use crate::state::AppState;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, UriSchemeResponder};

const REMOTE_HOSTS: &[&str] = &[
    "image.tmdb.org",
    "artworks.thetvdb.com",
    "thetvdb.com",
    "assets.fanart.tv",
    "m.media-amazon.com",
    "static.tvmaze.com",
    "i.ytimg.com",
];
const MAX_REMOTE_BYTES: usize = 15 * 1024 * 1024;

fn plain(status: u16) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .body(Vec::new())
        .expect("static response")
}

fn query_value(q: Option<&str>, key: &str) -> Option<String> {
    url::form_urlencoded::parse(q.unwrap_or("").as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

fn width_from_query(q: Option<&str>) -> u32 {
    query_value(q, "w").and_then(|v| v.parse().ok()).unwrap_or(400)
}

/// Only https, only allow-listed hosts (or their sub-domains), no user info, default port.
pub fn allowed_remote(raw: &str) -> Option<url::Url> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    REMOTE_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
        .then_some(u)
}

fn remote_client() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            // Follow a redirect only to another allow-listed image host.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() > 3 || allowed_remote(attempt.url().as_str()).is_none() {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .user_agent("MediaHub/0.8")
            .build()
            .expect("http client")
    })
}

async fn fetch_remote(raw: &str) -> Result<(Vec<u8>, String)> {
    let u = allowed_remote(raw).ok_or_else(|| Error::msg("host not allowed"))?;
    let resp = remote_client()
        .get(u)
        .send()
        .await
        .map_err(|e| Error::Network(e.without_url().to_string()))?;
    // A redirect may have taken us elsewhere: check the final address too.
    if allowed_remote(resp.url().as_str()).is_none() || !resp.status().is_success() {
        return Err(Error::msg("remote image not available"));
    }
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
    if bytes.len() > MAX_REMOTE_BYTES {
        return Err(Error::msg("image too large"));
    }
    Ok((bytes.to_vec(), ct))
}

async fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let uri = request.uri();
    let parts: Vec<&str> = uri.path().split('/').filter(|p| !p.is_empty()).collect();
    let (bytes, content_type) = match parts.as_slice() {
        ["remote"] => {
            let u = query_value(uri.query(), "u").ok_or_else(|| Error::msg("missing url"))?;
            fetch_remote(&u).await?
        }
        [id, kind] | [id, kind, _] => {
            let index: u32 = match parts.get(2) {
                Some(i) => i.parse().map_err(|_| Error::msg("bad index"))?,
                None => 0,
            };
            if index > 50 {
                return Err(Error::msg("bad index"));
            }
            let state = app.state::<AppState>();
            let client = state.client()?.ok_or_else(|| Error::msg("not connected"))?;
            client.image(id, kind, index, width_from_query(uri.query())).await?
        }
        _ => return Err(Error::msg("bad path")),
    };
    Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "private, max-age=86400")
        .body(bytes)
        .map_err(|e| Error::msg(e.to_string()))
}

pub fn handle(app: AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let response = serve(&app, &request).await.unwrap_or_else(|_| plain(404));
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_width() {
        assert_eq!(width_from_query(Some("w=300")), 300);
        assert_eq!(width_from_query(Some("x=1&w=640")), 640);
        assert_eq!(width_from_query(Some("w=abc")), 400);
        assert_eq!(width_from_query(None), 400);
    }

    #[test]
    fn remote_hosts_are_allow_listed() {
        assert!(allowed_remote("https://image.tmdb.org/t/p/original/a.jpg").is_some());
        assert!(allowed_remote("https://artworks.thetvdb.com/banners/x.jpg").is_some());
        assert!(allowed_remote("http://image.tmdb.org/a.jpg").is_none());
        assert!(allowed_remote("https://image.tmdb.org.evil.com/a.jpg").is_none());
        assert!(allowed_remote("https://evilimage.tmdb.org.com/a.jpg").is_none());
        assert!(allowed_remote("https://user@image.tmdb.org/a.jpg").is_none());
        assert!(allowed_remote("https://image.tmdb.org:8443/a.jpg").is_none());
        assert!(allowed_remote("https://192.168.1.1/a.jpg").is_none());
        assert!(allowed_remote("file:///etc/passwd").is_none());
    }
}
