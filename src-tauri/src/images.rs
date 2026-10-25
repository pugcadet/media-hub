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
            let width = width_from_query(uri.query());
            let tag = query_value(uri.query(), "t").unwrap_or_default();
            let file = cache_file(&state.dir, id, kind, index, width, &tag);
            // Pictures come from this computer's cache first (instant at start-up); an untagged
            // one older than a day is fetched again in the background for next time.
            if let Some(f) = file.as_ref() {
                if let Ok(bytes) = std::fs::read(f) {
                    let age = std::fs::metadata(f).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX);
                    // After "Reload data": pictures cached before it are fetched again now.
                    let reload_at = REVALIDATE_AT.load(std::sync::atomic::Ordering::Relaxed);
                    let cached_at = std::fs::metadata(f).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                    if tag.is_empty() && cached_at < reload_at {
                        if let Ok(Some(c)) = state.client() {
                            if let Ok((b, ct)) = c.image(id, kind, index, width).await {
                                let _ = write_cache(f, &b);
                                return Response::builder()
                                    .status(200)
                                    .header("Content-Type", ct)
                                    .header("Cache-Control", "private, max-age=86400")
                                    .body(b)
                                    .map_err(|e| Error::msg(e.to_string()));
                            }
                        }
                    }
                    if tag.is_empty() && age > 86_400 {
                        let (app2, id2, kind2, f2) = (app.clone(), id.to_string(), kind.to_string(), f.clone());
                        tauri::async_runtime::spawn(async move {
                            if let Ok(Some(c)) = app2.state::<AppState>().client() {
                                if let Ok((b, _)) = c.image(&id2, &kind2, index, width).await {
                                    let _ = write_cache(&f2, &b);
                                }
                            }
                        });
                    }
                    let ct = if bytes.starts_with(&[0x89, b'P']) { "image/png" } else if bytes.starts_with(b"RIFF") { "image/webp" } else { "image/jpeg" };
                    return Response::builder()
                        .status(200)
                        .header("Content-Type", ct)
                        .header("Cache-Control", "private, max-age=86400")
                        .body(bytes)
                        .map_err(|e| Error::msg(e.to_string()));
                }
            }
            let client = state.client()?.ok_or_else(|| Error::msg("not connected"))?;
            let (bytes, ct) = client.image(id, kind, index, width).await?;
            if let Some(f) = file.as_ref() {
                let _ = write_cache(f, &bytes);
            }
            (bytes, ct)
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

/// Where a picture is kept on this computer (None for odd ids or kinds).
fn cache_file(dir: &std::path::Path, id: &str, kind: &str, index: u32, width: u32, tag: &str) -> Option<std::path::PathBuf> {
    let ok = |x: &str| !x.is_empty() && x.len() <= 64 && x.chars().all(|c| c.is_ascii_alphanumeric());
    if !ok(id) || !ok(kind) {
        return None;
    }
    let tag: String = tag.chars().filter(|c| c.is_ascii_alphanumeric()).take(40).collect();
    // Two levels so no folder holds too many files.
    Some(dir.join("imgcache").join(&id[..2.min(id.len())]).join(format!("{id}_{kind}_{index}_{width}_{tag}")))
}

fn write_cache(f: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    if bytes.len() < 64 || bytes.len() > 15 * 1024 * 1024 {
        return Ok(());
    }
    if let Some(p) = f.parent() {
        std::fs::create_dir_all(p)?;
    }
    let tmp = f.with_extension("part");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(tmp, f)
}

static REVALIDATE_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// "Reload data": pictures cached until now are checked with Jellyfin again on next use.
#[tauri::command]
pub fn images_revalidate() {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    REVALIDATE_AT.store(now, std::sync::atomic::Ordering::Relaxed);
}

/// Forgets the cached pictures of one title (after you change its artwork).
pub fn forget(dir: &std::path::Path, id: &str) {
    if let Some(f) = cache_file(dir, id, "Primary", 0, 0, "") {
        if let Some(folder) = f.parent() {
            if let Ok(rd) = std::fs::read_dir(folder) {
                for e in rd.flatten() {
                    if e.file_name().to_string_lossy().starts_with(&format!("{id}_")) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
    }
}

/// Keeps the picture cache under about 1.5 GB: the oldest files go first. Run at start-up.
pub fn prune(dir: &std::path::Path) {
    let root = dir.join("imgcache");
    let mut files: Vec<(std::time::SystemTime, u64, std::path::PathBuf)> = Vec::new();
    for sub in std::fs::read_dir(&root).into_iter().flatten().flatten() {
        for e in std::fs::read_dir(sub.path()).into_iter().flatten().flatten() {
            if let Ok(m) = e.metadata() {
                files.push((m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()));
            }
        }
    }
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total < 1_500_000_000 {
        return;
    }
    files.sort_by_key(|f| f.0);
    for (_, len, p) in files {
        if total < 1_000_000_000 {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
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
    fn cache_names_are_safe() {
        let d = std::path::Path::new("/x");
        assert!(cache_file(d, "../etc", "Primary", 0, 300, "").is_none());
        assert!(cache_file(d, "0123abcd", "Primary", 0, 300, "a/b").unwrap().ends_with("01/0123abcd_Primary_0_300_ab"));
    }

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
