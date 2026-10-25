//! Playback. Jellyfin prepares an HLS stream (copying the video when it can, converting
//! only what the computer can't play), and this module passes it to the window through
//! a private address scheme (`hubmedia://`). The window never sees the server address or
//! the API key: each playback gets a random token, and the key is added here.

use crate::error::{Error, Result};
use crate::jellyfin::{valid_item_id, TICKS_PER_SECOND};
use crate::state::AppState;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, State, UriSchemeResponder};

struct Session {
    /// Jellyfin path of the folder the playlists live in, e.g. "/videos/<id>/".
    dir: String,
    /// subtitle index -> Jellyfin path (+query) of its WebVTT version
    subs: HashMap<i64, String>,
    device_id: String,
    play_session_id: String,
    item_id: String,
}

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn token() -> Result<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| Error::msg(e.to_string()))?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn re_key() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)([?&])(api_key|apikey)=[^&\s]*&?").expect("valid regex"))
}

/// Removes any API key that Jellyfin put into a URL or playlist line.
pub fn strip_key(s: &str) -> String {
    let out = re_key().replace_all(s, "$1");
    out.replace("?&", "?").trim_end_matches(['?', '&']).to_string()
}

/// Rewrites an HLS playlist so every address stays inside the session: absolute Jellyfin
/// paths become relative to the playlist folder, and API keys are removed.
pub fn rewrite_playlist(text: &str, dir: &str) -> String {
    let dir_l = dir.to_lowercase();
    text.lines()
        .map(|line| {
            let l = line.trim();
            if l.is_empty() || l.starts_with('#') {
                // URI="..." attributes inside tags (e.g. #EXT-X-MAP, #EXT-X-MEDIA)
                if let (Some(a), true) = (l.find("URI=\""), l.starts_with('#')) {
                    let start = a + 5;
                    if let Some(len) = l[start..].find('"') {
                        let uri = &l[start..start + len];
                        let fixed = fix_uri(uri, &dir_l);
                        return format!("{}{}{}", &l[..start], fixed, &l[start + len..]);
                    }
                }
                return line.to_string();
            }
            fix_uri(l, &dir_l)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn fix_uri(uri: &str, dir_l: &str) -> String {
    let u = strip_key(uri);
    if u.starts_with('/') {
        if u.to_lowercase().starts_with(dir_l) {
            return u[dir_l.len()..].to_string();
        }
        // Outside the session folder: not allowed (left broken on purpose).
        return "about:blank".to_string();
    }
    if u.contains("://") {
        return "about:blank".to_string();
    }
    u
}

fn device_profile() -> Value {
    // HEVC only where the system can decode it in the browser engine (Macs do; Windows often not).
    let video = if cfg!(target_os = "macos") { "h264,hevc" } else { "h264" };
    json!({
        "Name": "Media Hub",
        "MaxStreamingBitrate": 120_000_000,
        "DirectPlayProfiles": [],
        "TranscodingProfiles": [{
            "Container": "mp4",
            "Type": "Video",
            "Protocol": "hls",
            "AudioCodec": "aac",
            "VideoCodec": video,
            "Context": "Streaming",
            "MaxAudioChannels": "2",
            "BreakOnNonKeyFrames": true,
            "MinSegments": 1
        }],
        "SubtitleProfiles": [
            {"Format": "vtt", "Method": "External"},
            {"Format": "srt", "Method": "External"},
            {"Format": "ass", "Method": "External"},
            {"Format": "ssa", "Method": "External"}
        ],
        "CodecProfiles": [],
        "ContainerProfiles": []
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubTrack {
    index: i64,
    language: String,
    title: String,
    url: String,
    default: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    index: i64,
    title: String,
    selected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayInfo {
    token: String,
    url: String,
    title: String,
    subtitle: String,
    audio: Vec<AudioTrack>,
    duration: f64,
    start: f64,
    subtitles: Vec<SubTrack>,
    segments: Vec<Value>,
    /// Where you stopped last time (seconds), if anywhere.
    resume: f64,
    /// The next episode to play after this one.
    next: Option<NextEpisode>,
    /// For the pause screen.
    about: About,
    /// Preview pictures for the timeline, if Jellyfin made them.
    trickplay: Option<Trickplay>,
    /// Chapter marks: (name, start in seconds).
    chapters: Vec<Chapter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    name: String,
    start: f64,
}

pub fn chapters_of(item: &Value) -> Vec<Chapter> {
    item.get("Chapters")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    Some(Chapter {
                        name: c.get("Name").and_then(Value::as_str).unwrap_or("").to_string(),
                        start: c.get("StartPositionTicks").and_then(Value::as_f64)? / TICKS_PER_SECOND,
                    })
                })
                .take(200)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct About {
    item_id: String,
    /// The show for an episode, else the item itself (backdrop and logo come from here).
    art_id: String,
    overview: String,
    year: Option<i64>,
    rating: Option<f64>,
    official_rating: String,
    genres: Vec<String>,
    people: Vec<Person>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    id: String,
    name: String,
    role: String,
    has_image: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trickplay {
    /// "<base>/<index>.jpg" is one sheet of tiles.
    base: String,
    width: i64,
    height: i64,
    tile_width: i64,
    tile_height: i64,
    count: i64,
    /// milliseconds between pictures
    interval: i64,
}

fn about_of(item: &Value, id: &str) -> About {
    let sv = |k: &str| item.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let series = sv("SeriesId").replace('-', "");
    About {
        item_id: id.to_string(),
        art_id: if valid_item_id(&series) { series } else { id.to_string() },
        overview: sv("Overview").chars().take(900).collect(),
        year: item.get("ProductionYear").and_then(Value::as_i64),
        rating: item.get("CommunityRating").and_then(Value::as_f64),
        official_rating: sv("OfficialRating"),
        genres: item
            .get("Genres")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).take(4).collect())
            .unwrap_or_default(),
        people: item
            .get("People")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|p| matches!(p.get("Type").and_then(Value::as_str), Some("Actor") | Some("GuestStar") | None))
                    .filter_map(|p| {
                        let pid = p.get("Id").and_then(Value::as_str)?.replace('-', "");
                        valid_item_id(&pid).then(|| Person {
                            name: p.get("Name").and_then(Value::as_str).unwrap_or("").to_string(),
                            role: p.get("Role").and_then(Value::as_str).unwrap_or("").to_string(),
                            has_image: p.get("PrimaryImageTag").is_some(),
                            id: pid,
                        })
                    })
                    .take(16)
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Picks the trickplay size closest to 320 px wide.
fn trickplay_of(item: &Value, tok: &str) -> Option<Trickplay> {
    let per_source = item.get("Trickplay")?.as_object()?.values().next()?.as_object()?;
    let (w, info) = per_source
        .iter()
        .filter_map(|(w, i)| w.parse::<i64>().ok().map(|w| (w, i)))
        .min_by_key(|(w, _)| (w - 320).abs())?;
    let g = |k: &str| info.get(k).and_then(Value::as_i64).unwrap_or(0);
    let t = Trickplay {
        base: format!("{}/s/{tok}/trick/{w}", media_base()),
        width: g("Width").max(1),
        height: g("Height").max(1),
        tile_width: g("TileWidth").max(1),
        tile_height: g("TileHeight").max(1),
        count: g("ThumbnailCount"),
        interval: g("Interval").max(1),
    };
    (t.count > 0).then_some(t)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextEpisode {
    id: String,
    label: String,
}

fn media_base() -> &'static str {
    if cfg!(windows) {
        "http://hubmedia.localhost"
    } else {
        "hubmedia://localhost"
    }
}

/// Jellyfin path split into folder and the rest: "/videos/x/master.m3u8?a=1" -> ("/videos/x/", "master.m3u8?a=1")
fn split_dir(path_query: &str) -> (String, String) {
    let (path, query) = path_query.split_once('?').unwrap_or((path_query, ""));
    let (dir, file) = path.rsplit_once('/').map(|(d, f)| (format!("{d}/"), f)).unwrap_or(("/".into(), path));
    let rest = if query.is_empty() { file.to_string() } else { format!("{file}?{query}") };
    (dir, rest)
}

#[tauri::command]
pub async fn play_start(state: State<'_, AppState>, id: String, start: f64, audio_index: Option<i64>) -> Result<PlayInfo> {
    if !valid_item_id(&id) {
        return Err(Error::msg("bad id"));
    }
    let c = state.reader().await?;
    let device_id = state.device_id()?;
    let item = c.item_json(&id).await?;
    let start = start.max(0.0);
    let mut body = json!({
        "DeviceProfile": device_profile(),
        "StartTimeTicks": (start * TICKS_PER_SECOND) as i64,
        "EnableDirectPlay": false,
        "EnableDirectStream": false,
        "EnableTranscoding": true,
        "AllowVideoStreamCopy": true,
        "AllowAudioStreamCopy": true,
        "AutoOpenLiveStream": true,
        "MaxStreamingBitrate": 120_000_000
    });
    if let Some(a) = audio_index.filter(|a| (0..200).contains(a)) {
        body["AudioStreamIndex"] = json!(a);
    }
    let info = c.playback_info(&id, &device_id, &body).await?;
    let source = info
        .get("MediaSources")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| Error::msg("Jellyfin offered no way to play this."))?;
    let transcode = source
        .get("TranscodingUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::msg("Jellyfin could not prepare a stream for this file."))?;
    let play_session_id = info.get("PlaySessionId").and_then(Value::as_str).unwrap_or("").to_string();
    let (dir, master) = split_dir(&strip_key(transcode));

    let tok = token()?;
    let mut subs = HashMap::new();
    let mut tracks = Vec::new();
    for s in source.get("MediaStreams").and_then(Value::as_array).into_iter().flatten() {
        if s.get("Type").and_then(Value::as_str) != Some("Subtitle") {
            continue;
        }
        let Some(url) = s.get("DeliveryUrl").and_then(Value::as_str) else { continue };
        let index = s.get("Index").and_then(Value::as_i64).unwrap_or(-1);
        subs.insert(index, strip_key(url));
        tracks.push(SubTrack {
            index,
            language: s.get("Language").and_then(Value::as_str).unwrap_or("").to_string(),
            title: s.get("DisplayTitle").and_then(Value::as_str).unwrap_or("Subtitle").to_string(),
            url: format!("{}/s/{tok}/sub/{index}", media_base()),
            default: s.get("IsDefault").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    let default_audio = audio_index.or_else(|| source.get("DefaultAudioStreamIndex").and_then(Value::as_i64));
    let audio: Vec<AudioTrack> = source
        .get("MediaStreams")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("Type").and_then(Value::as_str) == Some("Audio"))
        .map(|s| {
            let index = s.get("Index").and_then(Value::as_i64).unwrap_or(-1);
            AudioTrack {
                index,
                title: s.get("DisplayTitle").and_then(Value::as_str).unwrap_or("Audio").to_string(),
                selected: Some(index) == default_audio,
            }
        })
        .collect();
    let segments = c.segments(&id).await.unwrap_or_default();
    let resume = item.pointer("/UserData/PlaybackPositionTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND;
    let next = match (item.get("Type").and_then(Value::as_str), item.get("SeriesId").and_then(Value::as_str)) {
        (Some("Episode"), Some(series)) => c.next_episode(&series.replace('-', ""), &id).await.ok().flatten().map(|e| {
            let label = match (e.get("ParentIndexNumber").and_then(Value::as_i64), e.get("IndexNumber").and_then(Value::as_i64)) {
                (Some(s), Some(n)) => format!("S{s:02}E{n:02} · {}", e.get("Name").and_then(Value::as_str).unwrap_or("")),
                _ => e.get("Name").and_then(Value::as_str).unwrap_or("Next episode").to_string(),
            };
            NextEpisode { id: e.get("Id").and_then(Value::as_str).unwrap_or("").replace('-', ""), label }
        }),
        _ => None,
    };
    sessions()
        .lock()
        .map_err(|_| Error::msg("internal error"))?
        .insert(tok.clone(), Session { dir, subs, device_id, play_session_id, item_id: id.clone() });

    let name = item.get("Name").and_then(Value::as_str).unwrap_or("").to_string();
    let (title, subtitle) = match item.get("SeriesName").and_then(Value::as_str) {
        Some(series) => {
            let se = item.get("ParentIndexNumber").and_then(Value::as_i64);
            let ep = item.get("IndexNumber").and_then(Value::as_i64);
            let mut parts = Vec::new();
            if let Some(s) = se {
                parts.push(if s == 0 { "Special".to_string() } else { format!("Season {s}") });
            }
            if let Some(e) = ep {
                parts.push(format!("Episode {e}"));
            }
            parts.push(name);
            (series.to_string(), parts.join(" · "))
        }
        None => (name, item.get("ProductionYear").and_then(Value::as_i64).map(|y| y.to_string()).unwrap_or_default()),
    };
    let trickplay = trickplay_of(&item, &tok);
    Ok(PlayInfo {
        url: format!("{}/s/{tok}/{master}", media_base()),
        token: tok,
        title,
        subtitle,
        audio,
        duration: item.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS_PER_SECOND,
        start,
        subtitles: tracks,
        segments,
        resume,
        next: next.filter(|n| valid_item_id(&n.id)),
        trickplay,
        chapters: chapters_of(&item),
        about: about_of(&item, &id),
    })
}

/// Subtitles added while playing (for example just downloaded): adds them to the running
/// playback without restarting it. Returns the full list.
#[tauri::command]
pub async fn play_subtitles(state: State<'_, AppState>, token: String) -> Result<Vec<SubTrack>> {
    let item_id = {
        let map = sessions().lock().map_err(|_| Error::msg("internal error"))?;
        map.get(&token).map(|s| s.item_id.clone()).ok_or_else(|| Error::msg("This playback has ended."))?
    };
    let item = state.reader().await?.item_json(&item_id).await?;
    let source_id = item
        .pointer("/MediaSources/0/Id")
        .and_then(Value::as_str)
        .map(|s| s.replace('-', ""))
        .filter(|s| valid_item_id(s))
        .unwrap_or_else(|| item_id.clone());
    let mut map = sessions().lock().map_err(|_| Error::msg("internal error"))?;
    let session = map.get_mut(&token).ok_or_else(|| Error::msg("This playback has ended."))?;
    let mut out = Vec::new();
    for s in item.get("MediaStreams").and_then(Value::as_array).into_iter().flatten() {
        if s.get("Type").and_then(Value::as_str) != Some("Subtitle") {
            continue;
        }
        let index = s.get("Index").and_then(Value::as_i64).unwrap_or(-1);
        if index < 0 {
            continue;
        }
        let text = s.get("IsTextSubtitleStream").and_then(Value::as_bool).unwrap_or(false);
        if !session.subs.contains_key(&index) {
            if !text {
                continue; // picture subtitles can't be shown without restarting the stream
            }
            session.subs.insert(index, format!("/Videos/{item_id}/{source_id}/Subtitles/{index}/0/Stream.vtt"));
        }
        out.push(SubTrack {
            index,
            language: s.get("Language").and_then(Value::as_str).unwrap_or("").to_string(),
            title: s.get("DisplayTitle").and_then(Value::as_str).unwrap_or("Subtitle").to_string(),
            url: format!("{}/s/{token}/sub/{index}", media_base()),
            default: s.get("IsDefault").and_then(Value::as_bool).unwrap_or(false),
        });
    }
    Ok(out)
}

/// Saves where you are (and, at the end, that you watched it) in Jellyfin for your user,
/// so Infuse and other apps continue at the same spot. Off when "sync watched" is off.
#[tauri::command]
pub async fn play_progress(state: State<'_, AppState>, token: String, position: f64, finished: bool) -> Result<()> {
    if !state.settings()?.sync_watched {
        return Ok(());
    }
    let item = {
        let map = sessions().lock().map_err(|_| Error::msg("internal error"))?;
        map.get(&token).map(|s| s.item_id.clone())
    };
    let Some(item) = item else { return Ok(()) };
    let c = state.reader().await?;
    if finished {
        c.mark_played(&item).await
    } else {
        c.save_position(&item, position.max(0.0)).await
    }
}

/// Ends the stream so Jellyfin stops converting.
#[tauri::command]
pub async fn play_stop(state: State<'_, AppState>, token: String) -> Result<()> {
    let s = sessions().lock().map_err(|_| Error::msg("internal error"))?.remove(&token);
    if let (Some(s), Some(c)) = (s, state.client()?) {
        c.stop_encoding(&s.device_id, &s.play_session_id).await?;
    }
    Ok(())
}

fn plain(status: u16) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).expect("static response")
}

async fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Result<Response<Vec<u8>>> {
    let uri = request.uri();
    let path = uri.path();
    let rest = path.strip_prefix("/s/").ok_or_else(|| Error::msg("bad path"))?;
    let (tok, file) = rest.split_once('/').ok_or_else(|| Error::msg("bad path"))?;
    // Only plain relative names: no "..", no encoded characters that a server could decode into "..".
    if file.split('/').any(|p| p == ".." || p == "." || p.is_empty()) || file.contains('%') || file.contains('\\') {
        return Err(Error::msg("bad path"));
    }
    let target = {
        let map = sessions().lock().map_err(|_| Error::msg("internal error"))?;
        let s = map.get(tok).ok_or_else(|| Error::msg("unknown session"))?;
        if let Some(idx) = file.strip_prefix("sub/") {
            let idx: i64 = idx.parse().map_err(|_| Error::msg("bad index"))?;
            (s.subs.get(&idx).cloned().ok_or_else(|| Error::msg("no such subtitle"))?, s.dir.clone())
        } else if let Some(rest) = file.strip_prefix("trick/") {
            // "trick/<width>/<n>.jpg": numbers only.
            let (w, n) = rest.split_once('/').ok_or_else(|| Error::msg("bad path"))?;
            let n = n.strip_suffix(".jpg").ok_or_else(|| Error::msg("bad path"))?;
            let (w, n): (u32, u32) = (w.parse().map_err(|_| Error::msg("bad path"))?, n.parse().map_err(|_| Error::msg("bad path"))?);
            (format!("/Videos/{}/Trickplay/{w}/{n}.jpg", s.item_id), s.dir.clone())
        } else {
            let q = uri.query().map(|q| format!("?{}", strip_key(q))).unwrap_or_default();
            (format!("{}{}{}", s.dir, file, q.trim_end_matches('?')), s.dir.clone())
        }
    };
    let state = app.state::<AppState>();
    let c = state.client()?.ok_or_else(|| Error::msg("not connected"))?;
    let (bytes, ct) = c.raw_get(&target.0).await?;
    let is_playlist = ct.contains("mpegurl") || target.0.split('?').next().unwrap_or("").ends_with(".m3u8");
    let body = if is_playlist {
        rewrite_playlist(&String::from_utf8_lossy(&bytes), &target.1).into_bytes()
    } else {
        bytes
    };
    Response::builder()
        .status(200)
        .header("Content-Type", if is_playlist { "application/vnd.apple.mpegurl".to_string() } else { ct })
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
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
    fn keys_are_removed() {
        assert_eq!(strip_key("/videos/x/master.m3u8?api_key=SECRET&a=1"), "/videos/x/master.m3u8?a=1");
        assert_eq!(strip_key("main.m3u8?a=1&ApiKey=SECRET"), "main.m3u8?a=1");
        assert_eq!(strip_key("seg.mp4?a=1&api_key=S&b=2"), "seg.mp4?a=1&b=2");
        assert!(!strip_key("x?API_KEY=abc").to_lowercase().contains("abc"));
    }

    #[test]
    fn playlists_stay_inside_the_session() {
        let pl = "#EXTM3U\n#EXT-X-MAP:URI=\"/videos/abc/hls1/main/-1.mp4?api_key=K\"\nhls1/main/0.mp4?a=1&api_key=K\n/videos/abc/hls1/main/1.mp4\n/other/x.mp4\nhttps://evil.example/x.mp4\n";
        let out = rewrite_playlist(pl, "/videos/abc/");
        assert!(!out.contains("api_key"));
        assert!(out.contains("#EXT-X-MAP:URI=\"hls1/main/-1.mp4\""));
        assert!(out.contains("\nhls1/main/0.mp4?a=1\n"));
        assert!(out.contains("\nhls1/main/1.mp4\n"));
        assert_eq!(out.matches("about:blank").count(), 2);
    }

    #[test]
    fn splits_folder_and_file() {
        assert_eq!(
            split_dir("/videos/abc/master.m3u8?DeviceId=1"),
            ("/videos/abc/".to_string(), "master.m3u8?DeviceId=1".to_string())
        );
    }
}
