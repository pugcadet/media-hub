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

async fn download(state: &AppState, w: &Writer, id: &str, item: &Value, sub_id: &str, codes: Vec<String>) -> Result<()> {
    let record = DownloadRecord {
        lang: codes,
        before: streams(item).into_iter().filter(|s| s.external).map(|s| s.path).collect(),
        subtitle_id: sub_id.to_string(),
    };
    let rec = serde_json::to_string(&record).map_err(|e| Error::msg(e.to_string()))?;
    let entry = state.store()?.journal_add("subtitle", id, &rec, sub_id)?;
    if let Err(e) = w.subtitle_download(id, sub_id).await {
        state.store()?.journal_delete(entry)?;
        return Err(e);
    }
    Ok(())
}

/// Downloads one subtitle and waits (up to ~20 s) until Jellyfin lists it, so the window
/// can show it straight away. Returns the new subtitle's stream index, if it showed up.
#[tauri::command]
pub async fn subtitle_download(state: State<'_, AppState>, id: String, subtitle_id: String, lang: String, codes: Vec<String>) -> Result<Option<i64>> {
    let codes = check_codes(&lang, &codes)?;
    let w = state.writer().await?;
    let item = w.reader().item_json(&id).await?;
    let before: Vec<String> = streams(&item).into_iter().filter(|s| s.external).map(|s| s.path).collect();
    download(&state, &w, &id, &item, &subtitle_id, codes.clone()).await?;
    Ok(wait_for_new(&w, &id, &before, &codes, 14).await)
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
    download(&state, &w, &id, &item, &sub_id, codes).await?;
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
    fn language_lists_are_checked() {
        assert_eq!(check_codes("eng", &[]).unwrap(), vec!["eng".to_string()]);
        assert_eq!(check_codes("dut", &["nld".into(), "BAD".into()]).unwrap(), vec!["nld".to_string(), "dut".to_string()]);
        assert!(check_codes("../", &[]).is_err());
    }
}
