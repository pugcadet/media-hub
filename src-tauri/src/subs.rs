//! Subtitle match scores. Pure logic, unit tested.
//!
//! Jellyfin's subtitle providers (usually OpenSubtitles) return candidates with a release
//! name. We score how well each candidate fits the actual video file:
//!   100      file hash matches (provider says it was made for exactly this file)
//!   0        it names a different episode (never auto-picked)
//!   1..99    release group, source, resolution and other words in common, popularity,
//!            minus points for machine translation.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase", default)]
pub struct SubInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    pub provider_name: Option<String>,
    pub format: Option<String>,
    pub author: Option<String>,
    pub comment: Option<String>,
    pub download_count: Option<i64>,
    pub community_rating: Option<f64>,
    pub is_hash_match: Option<bool>,
    pub hearing_impaired: Option<bool>,
    pub forced: Option<bool>,
    pub machine_translated: Option<bool>,
    pub ai_translated: Option<bool>,
    #[serde(rename = "ThreeLetterISOLanguageName")]
    pub three_letter_iso_language_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scored {
    pub sub: SubInfo,
    pub score: u32,
    pub reasons: Vec<String>,
}

const SOURCES: &[&str] = &["bluray", "bdrip", "brrip", "remux", "webrip", "webdl", "web", "hdtv", "dvdrip", "amzn", "nf", "dsnp", "hmax", "atvp"];
const RESOLUTIONS: &[&str] = &["480p", "576p", "720p", "1080p", "2160p", "4k"];
const NOISE: &[&str] = &["x264", "x265", "h264", "h265", "hevc", "aac", "ac3", "dts", "ddp5", "dd5", "the", "and", "a", "of", "srt", "en", "eng"];

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase()
        .replace("web-dl", "webdl")
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(String::from)
        .collect()
}

fn re_sxe() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)s(\d{1,2})[ ._-]?e(\d{1,3})").expect("valid regex"))
}

fn sxe(s: &str) -> Option<(u32, u32)> {
    let c = re_sxe().captures(s)?;
    Some((c[1].parse().ok()?, c[2].parse().ok()?))
}

/// Release group: the part after the last '-' ("Show.S01E01.1080p.WEB-DL-NTb" -> "ntb").
fn group(s: &str) -> Option<String> {
    let (_, g) = s.rsplit_once('-')?;
    let g = g.split(|c: char| !c.is_ascii_alphanumeric()).next()?.to_lowercase();
    (g.len() >= 2 && g != "dl").then_some(g)
}

pub fn score(file_stem: &str, sub: &SubInfo) -> (u32, Vec<String>) {
    let mut reasons = Vec::new();
    let name = sub.name.clone().unwrap_or_default();
    if sub.is_hash_match == Some(true) {
        return (100, vec!["Made for exactly this file".into()]);
    }
    if let (Some(a), Some(b)) = (sxe(file_stem), sxe(&name)) {
        if a != b {
            return (0, vec![format!("Different episode (S{:02}E{:02})", b.0, b.1)]);
        }
        reasons.push("Same episode".into());
    }
    let ft: Vec<String> = tokens(file_stem);
    let st: Vec<String> = tokens(&name);
    let fset: HashSet<&str> = ft.iter().map(String::as_str).collect();
    let sset: HashSet<&str> = st.iter().map(String::as_str).collect();

    let mut points: f64 = 20.0;
    if let (Some(a), Some(b)) = (group(file_stem), group(&name)) {
        if a == b {
            points += 30.0;
            reasons.push(format!("Same release group ({a})"));
        }
    }
    let both = |list: &[&str]| list.iter().find(|t| fset.contains(**t) && sset.contains(**t)).map(|t| t.to_string());
    if let Some(src) = both(SOURCES) {
        points += 15.0;
        reasons.push(format!("Same source ({src})"));
    } else {
        let fs = SOURCES.iter().any(|t| fset.contains(t));
        let ss = SOURCES.iter().any(|t| sset.contains(t));
        if fs && ss {
            points -= 10.0;
            reasons.push("Different source".into());
        }
    }
    if let Some(res) = both(RESOLUTIONS) {
        points += 8.0;
        reasons.push(format!("Same resolution ({res})"));
    }
    let meaningful = |set: &HashSet<&str>| -> HashSet<String> {
        set.iter()
            .filter(|t| !NOISE.contains(t) && !SOURCES.contains(t) && !RESOLUTIONS.contains(t))
            .map(|t| t.to_string())
            .collect()
    };
    let (mf, ms) = (meaningful(&fset), meaningful(&sset));
    if !mf.is_empty() && !ms.is_empty() {
        let inter = mf.intersection(&ms).count() as f64;
        let union = mf.union(&ms).count() as f64;
        points += 20.0 * inter / union;
    }
    let downloads = sub.download_count.unwrap_or(0).max(0) as f64;
    points += ((downloads + 1.0).log10() * 3.0).min(10.0);
    if sub.machine_translated == Some(true) || sub.ai_translated == Some(true) {
        points -= 25.0;
        reasons.push("Machine translated".into());
    }
    if sub.forced == Some(true) {
        points -= 10.0;
        reasons.push("Forced only (partial)".into());
    }
    let name_l = name.to_lowercase();
    let sdh_name = name_l.contains("sdh") || name_l.contains(".hi.") || name_l.contains("[hi]") || name_l.contains("hearing");
    if sub.hearing_impaired == Some(true) || sdh_name {
        points -= 8.0;
        reasons.push("For hearing impaired (sound descriptions)".into());
    }
    (points.round().clamp(1.0, 99.0) as u32, reasons)
}

/// Best first. Ties go to the more downloaded one.
pub fn rank(file_stem: &str, subs: Vec<SubInfo>) -> Vec<Scored> {
    let mut out: Vec<Scored> = subs
        .into_iter()
        .filter(|s| s.id.as_deref().map(|i| !i.is_empty()).unwrap_or(false))
        .map(|sub| {
            let (score, reasons) = score(file_stem, &sub);
            Scored { sub, score, reasons }
        })
        .collect();
    // Same score: plain subtitles before ones with sound descriptions, then more downloaded.
    let hi = |s: &Scored| s.sub.hearing_impaired == Some(true) || s.reasons.iter().any(|r| r.starts_with("For hearing impaired"));
    out.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then(hi(a).cmp(&hi(b)))
            .then(b.sub.download_count.unwrap_or(0).cmp(&a.sub.download_count.unwrap_or(0)))
    });
    out
}

/// 3-letter language code as Jellyfin uses it ("eng", "dut", "fre").
pub fn valid_lang(code: &str) -> bool {
    code.len() == 3 && code.chars().all(|c| c.is_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(name: &str) -> SubInfo {
        SubInfo { id: Some("1".into()), name: Some(name.into()), download_count: Some(100), ..Default::default() }
    }

    const FILE: &str = "Bluey.S01E05.1080p.WEB-DL.AAC2.0.H.264-NTb";

    #[test]
    fn hash_match_wins() {
        let mut s = sub("anything");
        s.is_hash_match = Some(true);
        assert_eq!(score(FILE, &s).0, 100);
    }

    #[test]
    fn wrong_episode_is_zero() {
        assert_eq!(score(FILE, &sub("Bluey.S01E06.1080p.WEB-DL-NTb")).0, 0);
    }

    #[test]
    fn same_release_beats_other_release() {
        let same = score(FILE, &sub("Bluey.S01E05.1080p.WEB-DL.AAC2.0.H.264-NTb")).0;
        let other = score(FILE, &sub("Bluey.S01E05.720p.HDTV.x264-KILLERS")).0;
        let vague = score(FILE, &sub("Bluey season 1 episode 5")).0;
        assert!(same > other, "{same} vs {other}");
        assert!(same > vague, "{same} vs {vague}");
        assert!(same >= 80, "{same}");
    }

    #[test]
    fn machine_translation_is_penalised() {
        let mut mt = sub("Bluey.S01E05.1080p.WEB-DL-NTb");
        mt.machine_translated = Some(true);
        let human = sub("Bluey.S01E05.1080p.WEB-DL-NTb");
        assert!(score(FILE, &mt).0 + 20 <= score(FILE, &human).0);
    }

    #[test]
    fn ranking_sorts_and_drops_empty_ids() {
        let mut no_id = sub("x");
        no_id.id = None;
        let r = rank(FILE, vec![sub("Bluey.S01E05.720p.HDTV-LOL"), no_id, sub("Bluey.S01E05.1080p.WEB-DL-NTb")]);
        assert_eq!(r.len(), 2);
        assert!(r[0].score >= r[1].score);
        assert!(r[0].sub.name.as_deref().unwrap().contains("NTb"));
    }

    #[test]
    fn parses_jellyfin_json() {
        let s: SubInfo = serde_json::from_str(
            r#"{"Id":"opensubtitles_123","Name":"Bluey.S01E05","ProviderName":"Open Subtitles","DownloadCount":50,"IsHashMatch":false,"ThreeLetterISOLanguageName":"eng","Extra":1}"#,
        )
        .unwrap();
        assert_eq!(s.id.as_deref(), Some("opensubtitles_123"));
        assert_eq!(s.download_count, Some(50));
        assert_eq!(s.three_letter_iso_language_name.as_deref(), Some("eng"));
    }

    #[test]
    fn language_codes() {
        assert!(valid_lang("eng"));
        assert!(!valid_lang("en"));
        assert!(!valid_lang("en/"));
        assert!(!valid_lang("ENG"));
    }
}
