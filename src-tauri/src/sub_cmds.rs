//! Commands for subtitles. Searching is always allowed; downloading needs changes switched on
//! and is journaled so it can be undone.

use crate::error::{Error, Result};
use crate::jellyfin::{valid_item_id, Writer};
use crate::state::AppState;
use crate::subs::{self, Scored};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubStream {
    index: i64,
    language: String,
    title: String,
    external: bool,
    forced: bool,
    path: String,
}

fn streams(item: &Value) -> Vec<SubStream> {
    item.get("MediaStreams")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|s| s.get("Type").and_then(Value::as_str) == Some("Subtitle"))
                .map(|s| SubStream {
                    index: s.get("Index").and_then(Value::as_i64).unwrap_or(-1),
                    language: s.get("Language").and_then(Value::as_str).unwrap_or("").to_lowercase(),
                    title: s
                        .get("DisplayTitle")
                        .or_else(|| s.get("Title"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    external: s.get("IsExternal").and_then(Value::as_bool).unwrap_or(false),
                    forced: s.get("IsForced").and_then(Value::as_bool).unwrap_or(false),
                    path: s.get("Path").and_then(Value::as_str).unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn file_stem(item: &Value) -> String {
    let path = item.get("Path").and_then(Value::as_str).unwrap_or("");
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    crate::naming::split_ext(name).0.to_string()
}

fn has_lang(list: &[SubStream], codes: &[String]) -> bool {
    list.iter().any(|s| {
        if s.forced {
            return false;
        }
        if codes.iter().any(|c| c.eq_ignore_ascii_case(&s.language)) {
            return true;
        }
        // Built-in subtitles often have no language tag, only a name like "English (SDH)".
        let unknown = s.language.is_empty() || s.language == "und" || s.language == "unknown";
        unknown && !s.external && title_names_lang(&s.title, codes)
    })
}

/// "English", "English SDH", "Nederlands" … for a subtitle without a language tag.
fn title_names_lang(title: &str, codes: &[String]) -> bool {
    const NAMES: &[(&[&str], &[&str])] = &[
        (&["eng", "en"], &["english"]),
        (&["dut", "nld", "nl"], &["dutch", "nederlands"]),
        (&["ger", "deu", "de"], &["german", "deutsch"]),
        (&["fre", "fra", "fr"], &["french", "français", "francais"]),
        (&["spa", "es"], &["spanish", "español", "espanol"]),
        (&["ita", "it"], &["italian", "italiano"]),
        (&["por", "pt"], &["portuguese", "português", "portugues"]),
    ];
    let t = title.to_lowercase();
    NAMES.iter().any(|(cs, names)| {
        cs.iter().any(|c| codes.iter().any(|x| x.eq_ignore_ascii_case(c))) && names.iter().any(|n| t.split(|ch: char| !ch.is_alphanumeric()).any(|w| w == *n))
    })
}

fn check_codes(lang: &str, codes: &[String]) -> Result<Vec<String>> {
    if !subs::valid_lang(lang) {
        return Err(Error::msg("bad language"));
    }
    let mut all: Vec<String> = codes.iter().filter(|c| subs::valid_lang(c)).cloned().collect();
    if !all.iter().any(|c| c == lang) {
        all.push(lang.to_string());
    }
    Ok(all)
}

async fn reader(state: &AppState) -> Result<crate::jellyfin::Client> {
    state.reader().await
}

#[tauri::command]
pub async fn languages(state: State<'_, AppState>) -> Result<Vec<Value>> {
    reader(&state).await?.cultures().await
}

#[tauri::command]
pub fn set_sub_langs(state: State<'_, AppState>, langs: Vec<String>) -> Result<()> {
    let mut clean: Vec<String> = Vec::new();
    for l in langs {
        if subs::valid_lang(&l) && !clean.contains(&l) {
            clean.push(l);
        }
    }
    if clean.is_empty() {
        return Err(Error::msg("Keep at least one language."));
    }
    state.update_settings(|s| s.sub_langs = clean)
}

#[tauri::command]
pub async fn item_children(state: State<'_, AppState>, id: String) -> Result<Vec<Value>> {
    reader(&state).await?.children(&id).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    file: String,
    current: Vec<SubStream>,
    results: Vec<Scored>,
}

#[tauri::command]
pub async fn subtitle_options(state: State<'_, AppState>, id: String, lang: String) -> Result<Options> {
    if !valid_item_id(&id) || !subs::valid_lang(&lang) {
        return Err(Error::msg("bad request"));
    }
    let c = reader(&state).await?;
    let item = c.item_json(&id).await?;
    let file = file_stem(&item);
    let found = c.subtitle_search(&id, &lang).await.map_err(|e| {
        Error::msg(format!(
            "Subtitle search failed ({e}). Check that a subtitle provider such as OpenSubtitles is installed and signed in under Jellyfin's Dashboard → Plugins."
        ))
    })?;
    Ok(Options { results: subs::rank(&file, found), current: streams(&item), file })
}

/// What undo needs: the language and the external subtitle files that existed before.
#[derive(Serialize, Deserialize)]
struct DownloadRecord {
    lang: Vec<String>,
    before: Vec<String>,
    subtitle_id: String,
}

/// What a download produced. With the NAS reachable Media Hub saves the file itself
/// (`text` is set, so the player can show it at once); otherwise Jellyfin downloads it.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Downloaded {
    /// Stream index once Jellyfin lists it.
    index: Option<i64>,
    /// The subtitle text (for showing it before Jellyfin has noticed the file).
    text: Option<String>,
    /// "srt" | "vtt" | "ass" | …
    format: String,
    /// Where it was saved on this computer (empty when Jellyfin downloaded it).
    file: String,
}

/// Bytes from a subtitle provider as text: UTF-8 when it is, otherwise Windows-1252 (what
/// most older subtitles use), without a byte-order mark.
fn decode_text(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Some(rest) = b.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        return String::from_utf16_lossy(&units);
    }
    match std::str::from_utf8(b) {
        Ok(t) => t.to_string(),
        Err(_) => b.iter().map(|&c| cp1252(c)).collect(),
    }
}

fn cp1252(c: u8) -> char {
    const HI: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xA0).contains(&c) {
        HI[(c - 0x80) as usize]
    } else {
        c as char
    }
}

/// The subtitle format from its content (providers don't always say).
fn sniff_format(text: &str, hint: &str) -> &'static str {
    let t = text.trim_start();
    if t.starts_with("WEBVTT") {
        "vtt"
    } else if t.starts_with("[Script Info]") || t.contains("\n[Events]") {
        "ass"
    } else if t.starts_with('{') && hint.eq_ignore_ascii_case("sub") {
        "sub"
    } else {
        "srt"
    }
}

/// `<video name>.<lang>.<ext>` next to the video, with a number added if that name is taken.
fn subtitle_path(video: &std::path::Path, lang: &str, ext: &str) -> Option<std::path::PathBuf> {
    let dir = video.parent()?;
    let stem = video.file_stem()?.to_string_lossy().into_owned();
    for n in 0..50 {
        let name = if n == 0 { format!("{stem}.{lang}.{ext}") } else { format!("{stem}.{lang}.{}.{ext}", n + 1) };
        let p = dir.join(name);
        if !p.exists() {
            return Some(p);
        }
    }
    None
}

/// Where the video is on this computer, if the NAS is reachable.
fn local_video(state: &AppState, item: &Value) -> Option<std::path::PathBuf> {
    let server = item.get("Path").and_then(Value::as_str).filter(|p| !p.is_empty())?;
    crate::local::to_local(state, server).ok().filter(|p| p.is_file())
}

/// Turns a provider failure into something you can act on (daily limits above all).
pub fn provider_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("limit") || l.contains("quota") || l.contains("429") || l.contains("too many") || l.contains("406") || l.contains("remaining") {
        format!("The subtitle site's download limit is reached for today ({e}). Media Hub stopped; try again tomorrow or sign in with an account that has more downloads (Jellyfin → Plugins → OpenSubtitles).")
    } else if l.contains("401") || l.contains("unauthor") || l.contains("login") || l.contains("credentials") {
        format!("The subtitle site refused the download ({e}). Check the OpenSubtitles login in Jellyfin → Plugins.")
    } else {
        format!("The subtitle couldn't be downloaded: {e}")
    }
}

/// Saves the subtitle next to the video ourselves.
async fn save_local(state: &AppState, w: &Writer, id: &str, video: &std::path::Path, sub_id: &str, lang: &str, hint: &str) -> Result<Downloaded> {
    let bytes = w.subtitle_file(sub_id).await.map_err(|e| Error::msg(provider_error(&e.to_string())))?;
    let text = decode_text(&bytes);
    if text.trim().is_empty() {
        return Err(Error::msg("The subtitle site sent an empty file (often its daily download limit). Media Hub stopped."));
    }
    // A provider that's out of downloads sometimes sends a short message instead of subtitles.
    if text.len() < 400 && !text.contains("-->") && !text.contains("[Events]") {
        return Err(Error::msg(provider_error(text.trim())));
    }
    let format = sniff_format(&text, hint);
    let path = subtitle_path(video, lang, format).ok_or_else(|| Error::msg("No free file name for the subtitle."))?;
    std::fs::write(&path, text.as_bytes()).map_err(|e| Error::msg(format!("Could not save the subtitle: {e}")))?;
    let file = path.to_string_lossy().into_owned();
    state.store()?.journal_add("subtitle_file", id, &file, sub_id)?;
    Ok(Downloaded { index: None, text: Some(text), format: format.to_string(), file })
}

/// Undo for "subtitle_file": removes the file Media Hub saved (only a subtitle file).
pub fn undo_saved_file(path: &str) -> Result<()> {
    let p = std::path::Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["srt", "vtt", "ass", "ssa", "sub"].contains(&ext.as_str()) {
        return Err(Error::msg("bad journal entry"));
    }
    match std::fs::remove_file(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::msg(format!("Could not remove the subtitle: {e}"))),
    }
}

async fn download(state: &AppState, w: &Writer, id: &str, item: &Value, sub_id: &str, codes: Vec<String>, hint: &str) -> Result<Downloaded> {
    let lang = codes.last().cloned().unwrap_or_default();
    // With the NAS reachable Media Hub saves it itself, and a failure is reported as it is
    // (no silent second try through Jellyfin that hides a download limit).
    if let Some(video) = local_video(state, item) {
        let d = save_local(state, w, id, &video, sub_id, &lang, hint).await?;
        // Hand it to Jellyfin: it picks the file up on a quick look at the folder.
        let _ = w.refresh_light(id).await;
        return Ok(d);
    }
    let record = DownloadRecord {
        lang: codes,
        before: streams(item).into_iter().filter(|s| s.external).map(|s| s.path).collect(),
        subtitle_id: sub_id.to_string(),
    };
    let rec = serde_json::to_string(&record).map_err(|e| Error::msg(e.to_string()))?;
    let entry = state.store()?.journal_add("subtitle", id, &rec, sub_id)?;
    if let Err(e) = w.subtitle_download(id, sub_id).await {
        state.store()?.journal_delete(entry)?;
        return Err(Error::msg(provider_error(&e.to_string())));
    }
    Ok(Downloaded { format: hint.to_lowercase(), ..Default::default() })
}

/// Downloads one subtitle. Saved by Media Hub itself when the NAS is reachable (the text
/// comes back so the player can show it at once); otherwise Jellyfin downloads it and this
/// waits (up to ~20 s) until it is listed.
#[tauri::command]
pub async fn subtitle_download(state: State<'_, AppState>, id: String, subtitle_id: String, lang: String, codes: Vec<String>, format: Option<String>) -> Result<Downloaded> {
    let mut codes = check_codes(&lang, &codes)?;
    // The language asked for names the file.
    codes.retain(|c| c != &lang);
    codes.push(lang.clone());
    let w = state.writer().await?;
    let item = w.reader().item_json(&id).await?;
    let before: Vec<String> = streams(&item).into_iter().filter(|s| s.external).map(|s| s.path).collect();
    let mut d = download(&state, &w, &id, &item, &subtitle_id, codes.clone(), format.as_deref().unwrap_or("srt")).await?;
    if d.text.is_none() {
        d.index = wait_for_new(&w, &id, &before, &codes, 14).await;
    }
    Ok(d)
}

async fn wait_for_new(w: &Writer, id: &str, before: &[String], codes: &[String], tries: u32) -> Option<i64> {
    for i in 0..tries {
        sleep_ms(if i == 0 { 800 } else { 1500 }).await;
        if let Ok(item) = w.reader().item_json(id).await {
            if let Some(s) = streams(&item)
                .into_iter()
                .find(|s| s.external && !before.contains(&s.path) && codes.iter().any(|c| c.eq_ignore_ascii_case(&s.language)))
            {
                return Some(s.index);
            }
        }
        if i == 3 {
            // Still not there: ask Jellyfin to look at the files again.
            let _ = w.refresh_light(id).await;
        }
    }
    None
}

async fn sleep_ms(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms)))
        .await
        .ok();
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoResult {
    /// "has" | "downloaded" | "low" | "none"
    outcome: &'static str,
    score: Option<u32>,
    name: Option<String>,
}

/// For bulk use: skip if the language is already there, otherwise take the best match
/// if it scores at least `min_score`.
#[tauri::command]
pub async fn subtitle_auto(state: State<'_, AppState>, id: String, lang: String, codes: Vec<String>, min_score: u32) -> Result<AutoResult> {
    let codes = check_codes(&lang, &codes)?;
    let w = state.writer().await?;
    let item = w.reader().item_json(&id).await?;
    if has_lang(&streams(&item), &codes) {
        return Ok(AutoResult { outcome: "has", score: None, name: None });
    }
    let found = w.reader().subtitle_search(&id, &lang).await?;
    let ranked = subs::rank(&file_stem(&item), found);
    let Some(best) = ranked.first() else {
        return Ok(AutoResult { outcome: "none", score: None, name: None });
    };
    if best.score < min_score.clamp(1, 100) {
        return Ok(AutoResult { outcome: "low", score: Some(best.score), name: best.sub.name.clone() });
    }
    let sub_id = best.sub.id.clone().unwrap_or_default();
    let hint = best.sub.format.clone().unwrap_or_default();
    let mut codes = codes;
    codes.retain(|c| c != &lang);
    codes.push(lang.clone());
    let before: Vec<String> = streams(&item).into_iter().filter(|s| s.external).map(|s| s.path).collect();
    let d = download(&state, &w, &id, &item, &sub_id, codes.clone(), &hint).await?;
    if d.text.is_none() && wait_for_new(&w, &id, &before, &codes, 8).await.is_none() {
        // Jellyfin answers "done" even when the subtitle site refused: check for the file.
        return Err(Error::msg("Jellyfin said the subtitle was downloaded, but no new subtitle appeared. That's usually the subtitle site's daily download limit. Media Hub stopped."));
    }
    Ok(AutoResult { outcome: "downloaded", score: Some(best.score), name: best.sub.name.clone() })
}

/// Removes the external subtitles in the downloaded language that were not there before.
pub async fn undo_download(w: &Writer, id: &str, record_json: &str) -> Result<()> {
    let rec: DownloadRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let item = w.reader().item_json(id).await?;
    let mut added: Vec<SubStream> = streams(&item)
        .into_iter()
        .filter(|s| s.external && !rec.before.contains(&s.path) && rec.lang.iter().any(|l| l.eq_ignore_ascii_case(&s.language)))
        .collect();
    if added.is_empty() {
        return Err(Error::msg("The downloaded subtitle is not visible in Jellyfin yet (or was already removed). Try again in a minute."));
    }
    // Highest index first so the other indexes stay valid.
    added.sort_by(|a, b| b.index.cmp(&a.index));
    for s in added {
        w.subtitle_delete(id, s.index).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_subtitles_without_a_tag_count_by_name() {
        let st = |lang: &str, title: &str, external: bool| SubStream { index: 2, language: lang.into(), title: title.into(), external, forced: false, path: String::new() };
        let eng = vec!["eng".to_string()];
        assert!(has_lang(&[st("eng", "", true)], &eng));
        assert!(has_lang(&[st("", "English (SDH)", false)], &eng));
        assert!(has_lang(&[st("und", "English - SUBRIP", false)], &eng));
        assert!(!has_lang(&[st("", "Dutch", false)], &eng));
        assert!(!has_lang(&[st("", "Englishman", false)], &eng));
        assert!(has_lang(&[st("", "Nederlands", false)], &["dut".to_string(), "nld".to_string()]));
    }

    fn item() -> Value {
        serde_json::json!({
            "Path": "/volume1/media/TV/Bluey/Season 01/Bluey - S01E05 - Hotel.mkv",
            "MediaStreams": [
                {"Type": "Video", "Index": 0},
                {"Type": "Subtitle", "Index": 2, "Language": "eng", "IsExternal": false, "IsForced": true},
                {"Type": "Subtitle", "Index": 3, "Language": "dut", "IsExternal": true, "Path": "/x/Bluey.nl.srt", "DisplayTitle": "Dutch"}
            ]
        })
    }

    #[test]
    fn reads_streams_and_file_name() {
        let s = streams(&item());
        assert_eq!(s.len(), 2);
        assert_eq!(s[1].title, "Dutch");
        assert_eq!(file_stem(&item()), "Bluey - S01E05 - Hotel");
        assert_eq!(file_stem(&serde_json::json!({"Path": "C:\\TV\\a.b.mkv"})), "a.b");
    }

    #[test]
    fn forced_subtitles_do_not_count_as_having_the_language() {
        let s = streams(&item());
        assert!(!has_lang(&s, &["eng".to_string()]));
        assert!(has_lang(&s, &["nld".to_string(), "dut".to_string()]));
    }

    #[test]
    fn limits_are_named() {
        assert!(provider_error("The server answered with status 500: DownloadLimitReached").contains("limit"));
        assert!(provider_error("status 429").contains("limit"));
        assert!(provider_error("status 401").contains("login"));
        assert!(provider_error("boom").contains("couldn't be downloaded"));
    }

    #[test]
    fn subtitle_text_and_format() {
        assert_eq!(decode_text(b"\xEF\xBB\xBF1\n"), "1\n");
        assert_eq!(decode_text(b"caf\xE9 \x93hi\x94"), "café “hi”");
        assert_eq!(sniff_format("WEBVTT\n\n", "srt"), "vtt");
        assert_eq!(sniff_format("[Script Info]\nTitle: x", "srt"), "ass");
        assert_eq!(sniff_format("1\n00:00:01,000 --> 00:00:02,000\nHi", ""), "srt");
        assert!(undo_saved_file("/etc/passwd").is_err());
    }

    #[test]
    fn language_lists_are_checked() {
        assert_eq!(check_codes("eng", &[]).unwrap(), vec!["eng".to_string()]);
        assert_eq!(check_codes("dut", &["nld".into(), "BAD".into()]).unwrap(), vec!["nld".to_string(), "dut".to_string()]);
        assert!(check_codes("../", &[]).is_err());
    }
}
