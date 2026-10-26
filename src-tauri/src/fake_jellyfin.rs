//! A small stateful stand-in for Jellyfin, for tests: answers the requests Media Hub makes
//! the way a real server does (including its quirks), so the client code is tested end to end.
#![cfg(test)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct FakeState {
    /// item id -> playback position (ticks) saved for the user
    pub positions: HashMap<String, i64>,
    /// When true, the new /UserItems route answers OK but keeps nothing (seen on some servers).
    pub new_route_ignored: bool,
    /// Subtitle provider answers for /Providers/Subtitles/Subtitles/{id}: (status, body)
    pub subtitle: (u16, String),
    /// Every request: "METHOD /path?query"
    pub log: Vec<String>,
}

pub struct Fake {
    pub url: String,
    pub state: Arc<Mutex<FakeState>>,
}

pub const KEY: &str = "0123456789abcdef0123456789abcdef";
pub const ITEM: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

pub fn start() -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(FakeState { subtitle: (200, "1\n00:00:01,000 --> 00:00:02,000\nHello\n".repeat(30)), ..Default::default() }));
    let st = state.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let st = st.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                let mut parts = line.split_whitespace();
                let method = parts.next().unwrap_or("").to_string();
                let target = parts.next().unwrap_or("").to_string();
                let mut len = 0usize;
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h == "\r\n" || h.is_empty() {
                        break;
                    }
                    if let Some(v) = h.to_lowercase().strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; len];
                let _ = reader.read_exact(&mut body);
                let body = String::from_utf8_lossy(&body).to_string();
                let (status, out) = answer(&st, &method, &target, &body);
                let mut s = stream;
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}", out.len());
            });
        }
    });
    Fake { url, state }
}

fn answer(st: &Arc<Mutex<FakeState>>, method: &str, target: &str, body: &str) -> (u16, String) {
    let mut s = st.lock().unwrap();
    s.log.push(format!("{method} {target}"));
    let path = target.split('?').next().unwrap_or("");
    let ticks = || serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("PlaybackPositionTicks").and_then(|t| t.as_i64())).unwrap_or(0);
    match (method, path) {
        ("POST", p) if p == format!("/UserItems/{ITEM}/UserData") => {
            if !s.new_route_ignored {
                let t = ticks();
                s.positions.insert(ITEM.into(), t);
            }
            (200, "{}".into())
        }
        ("POST", p) if p.starts_with("/Users/") && p.ends_with(&format!("/Items/{ITEM}/UserData")) => {
            let t = ticks();
            s.positions.insert(ITEM.into(), t);
            (200, "{}".into())
        }
        ("GET", p) if p == format!("/Items/{ITEM}") => {
            let pos = s.positions.get(ITEM).copied().unwrap_or(0);
            (200, serde_json::json!({ "Id": ITEM, "Name": "Bluey", "UserData": { "PlaybackPositionTicks": pos } }).to_string())
        }
        ("GET", p) if p.starts_with("/Providers/Subtitles/Subtitles/") => {
            let (code, text) = s.subtitle.clone();
            (code, text)
        }
        ("GET", p) if p.starts_with("/MediaSegments/") => (404, String::new()),
        ("GET", p) if p == format!("/Items/{ITEM}/Images/Backdrop/0") || p == format!("/Items/{ITEM}/Images/Backdrop") => (200, "\u{FFD8}fakejpeg".into()),
        _ => (404, String::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jellyfin::Client;

    fn client(f: &Fake) -> Client {
        let mut c = Client::new(&f.url, KEY).unwrap();
        c.user = Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
        c
    }

    #[test]
    fn position_is_saved_and_read_back() {
        let f = start();
        let c = client(&f);
        tauri::async_runtime::block_on(async {
            c.save_position(ITEM, 754.0).await.unwrap();
            let back = c.saved_position(ITEM).await.unwrap();
            assert!((back - 754.0).abs() < 1.0, "read back {back}");
        });
    }

    #[test]
    fn position_falls_back_to_the_older_route_when_the_new_one_keeps_nothing() {
        let f = start();
        f.state.lock().unwrap().new_route_ignored = true;
        let c = client(&f);
        tauri::async_runtime::block_on(async {
            c.save_position(ITEM, 300.0).await.unwrap();
            assert!(c.saved_position(ITEM).await.unwrap() < 1.0, "new route kept nothing");
            c.save_position_legacy(ITEM, 300.0).await.unwrap();
            assert!((c.saved_position(ITEM).await.unwrap() - 300.0).abs() < 1.0);
        });
    }

    #[test]
    fn subtitle_download_limit_is_reported_not_hidden() {
        let f = start();
        f.state.lock().unwrap().subtitle = (500, "DownloadLimitReached: 20 downloads per day".into());
        let w = client(&f).into_writer();
        tauri::async_runtime::block_on(async {
            let e = w.subtitle_file("srt-eng-123").await.unwrap_err().to_string();
            let msg = crate::sub_cmds::provider_error(&e);
            assert!(msg.contains("limit"), "{msg}");
        });
        // A normal subtitle comes back as text.
        f.state.lock().unwrap().subtitle = (200, "1\n00:00:01,000 --> 00:00:02,000\nHi\n".into());
        let w = client(&f).into_writer();
        let bytes = tauri::async_runtime::block_on(w.subtitle_file("srt-eng-123")).unwrap();
        assert!(String::from_utf8_lossy(&bytes).contains("-->"));
    }

    #[test]
    fn a_missing_picture_is_none_not_an_error() {
        let f = start();
        let c = client(&f);
        // Jellyfin answers 404 for a picture a title doesn't have (here: no thumbnail).
        let r = tauri::async_runtime::block_on(c.image_original(ITEM, "Thumb", 0)).unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn missing_markers_plugin_is_not_called_a_missing_title() {
        let f = start();
        let c = client(&f);
        let e = tauri::async_runtime::block_on(c.segments(ITEM)).unwrap_err().to_string();
        assert!(!e.contains("no longer in Jellyfin"), "{e}");
        assert!(e.contains("plugin"), "{e}");
        let gone = tauri::async_runtime::block_on(c.item_json("cccccccccccccccccccccccccccccccc")).unwrap_err().to_string();
        assert!(gone.contains("no longer in Jellyfin"), "{gone}");
    }
}
