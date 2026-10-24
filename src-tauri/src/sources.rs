//! Online metadata for the renamer: TMDB (with your own free API key, any language) and
//! TVmaze (no key, English). Plus name matching so the right show or movie is picked.

use crate::error::{Error, Result};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::time::Duration;

const TMDB: &str = "https://api.themoviedb.org/3";
const TVMAZE: &str = "https://api.tvmaze.com";

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("MediaHub/0.9")
        .build()
        .map_err(|e| Error::msg(e.to_string()))
}

// ------------------------------------------------------------------ matching

fn normalize(s: &str) -> String {
    let lower = s.to_lowercase().replace('&', " and ");
    let words: Vec<String> = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && *w != "the" && *w != "a" && *w != "an")
        .map(String::from)
        .collect();
    words.join(" ")
}

fn bigrams(s: &str) -> Vec<(char, char)> {
    let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
    chars.windows(2).map(|w| (w[0], w[1])).collect()
}

/// 0.0 ..= 1.0 similarity of two titles (Dice coefficient on letter pairs, after dropping
/// punctuation and words like "the").
pub fn similarity(a: &str, b: &str) -> f64 {
    let (na, nb) = (normalize(a), normalize(b));
    if na.is_empty() || nb.is_empty() {
        return 0.0;
    }
    if na == nb {
        return 1.0;
    }
    let (ba, mut bb) = (bigrams(&na), bigrams(&nb));
    if ba.is_empty() || bb.is_empty() {
        return 0.0;
    }
    let total = (ba.len() + bb.len()) as f64;
    let mut hits = 0.0;
    for x in ba {
        if let Some(pos) = bb.iter().position(|y| *y == x) {
            bb.swap_remove(pos);
            hits += 1.0;
        }
    }
    2.0 * hits / total
}

/// Match percentage for a candidate: mostly the name, with the year as tie breaker.
pub fn match_score(wanted: &str, wanted_year: Option<i32>, name: &str, year: Option<i32>) -> u8 {
    let mut s = similarity(wanted, name) * 92.0;
    match (wanted_year, year) {
        (Some(a), Some(b)) if a == b => s += 8.0,
        (Some(a), Some(b)) if (a - b).abs() == 1 => s += 3.0,
        (Some(_), Some(_)) => s -= 15.0,
        _ => s += 3.0,
    }
    s.round().clamp(0.0, 100.0) as u8
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// "tmdb" | "tvmaze" | "jellyfin"
    pub source: String,
    pub id: String,
    pub name: String,
    pub year: Option<i32>,
    pub poster: Option<String>,
    pub score: u8,
    /// Other ids we know (tmdb/tvdb/imdb), for name tags.
    pub ids: HashMap<String, String>,
}

fn year_of(date: Option<&str>) -> Option<i32> {
    date.and_then(|d| d.get(0..4)).and_then(|y| y.parse().ok())
}

pub fn rank(mut list: Vec<Candidate>, wanted: &str, year: Option<i32>) -> Vec<Candidate> {
    for c in &mut list {
        c.score = match_score(wanted, year, &c.name, c.year);
    }
    list.sort_by(|a, b| b.score.cmp(&a.score));
    list
}

// ---------------------------------------------------------------------- TMDB

pub struct Tmdb {
    key: String,
    lang: String,
}

impl Tmdb {
    pub fn new(key: &str, lang: &str) -> Self {
        let lang = if lang.len() <= 10 && lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { lang } else { "en-US" };
        Tmdb { key: key.trim().to_string(), lang: lang.to_string() }
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value> {
        let mut req = http()?.get(format!("{TMDB}{path}")).query(query).query(&[("language", self.lang.as_str())]);
        // A long key is a "read access token" (sent as a header); a short one is an API key.
        req = if self.key.len() > 40 { req.bearer_auth(&self.key) } else { req.query(&[("api_key", self.key.as_str())]) };
        let resp = req.send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
        match resp.status().as_u16() {
            200..=299 => resp.json().await.map_err(|_| Error::msg("TMDB gave an unexpected answer.")),
            401 => Err(Error::msg("TMDB did not accept the API key. Check it in Settings.")),
            429 => Err(Error::msg("TMDB asks to slow down; try again in a few seconds.")),
            s => Err(Error::msg(format!("TMDB answered with status {s}."))),
        }
    }

    pub async fn check(&self) -> Result<()> {
        self.get("/configuration", &[]).await.map(|_| ())
    }

    fn poster(v: &Value) -> Option<String> {
        v.get("poster_path").and_then(Value::as_str).map(|p| format!("https://image.tmdb.org/t/p/w185{p}"))
    }

    pub async fn search_tv(&self, name: &str, year: Option<i32>) -> Result<Vec<Candidate>> {
        let mut q = vec![("query", name.to_string())];
        if let Some(y) = year {
            q.push(("first_air_date_year", y.to_string()));
        }
        let mut v = self.get("/search/tv", &q).await?;
        // A wrong year in a folder name should not hide the show: retry without it.
        if year.is_some() && v.get("results").and_then(Value::as_array).map(|a| a.is_empty()).unwrap_or(true) {
            v = self.get("/search/tv", &[("query", name.to_string())]).await?;
        }
        Ok(results(&v)
            .iter()
            .take(10)
            .map(|r| Candidate {
                source: "tmdb".into(),
                id: r.get("id").map(|i| i.to_string()).unwrap_or_default(),
                name: r.get("name").and_then(Value::as_str).unwrap_or("").into(),
                year: year_of(r.get("first_air_date").and_then(Value::as_str)),
                poster: Self::poster(r),
                score: 0,
                ids: HashMap::from([("tmdb".to_string(), r.get("id").map(|i| i.to_string()).unwrap_or_default())]),
            })
            .collect())
    }

    pub async fn search_movie(&self, name: &str, year: Option<i32>) -> Result<Vec<Candidate>> {
        let mut q = vec![("query", name.to_string())];
        if let Some(y) = year {
            q.push(("year", y.to_string()));
        }
        let mut v = self.get("/search/movie", &q).await?;
        if year.is_some() && v.get("results").and_then(Value::as_array).map(|a| a.is_empty()).unwrap_or(true) {
            v = self.get("/search/movie", &[("query", name.to_string())]).await?;
        }
        Ok(results(&v)
            .iter()
            .take(10)
            .map(|r| Candidate {
                source: "tmdb".into(),
                id: r.get("id").map(|i| i.to_string()).unwrap_or_default(),
                name: r.get("title").and_then(Value::as_str).unwrap_or("").into(),
                year: year_of(r.get("release_date").and_then(Value::as_str)),
                poster: Self::poster(r),
                score: 0,
                ids: HashMap::from([("tmdb".to_string(), r.get("id").map(|i| i.to_string()).unwrap_or_default())]),
            })
            .collect())
    }

    /// All episode titles of a show: (season, episode) -> title.
    pub async fn episodes(&self, id: &str) -> Result<HashMap<(u32, u32), String>> {
        if !id.chars().all(|c| c.is_ascii_digit()) {
            return Err(Error::msg("bad id"));
        }
        let show = self.get(&format!("/tv/{id}"), &[]).await?;
        let seasons: Vec<u32> = show
            .get("seasons")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|s| s.get("season_number").and_then(Value::as_u64)).map(|n| n as u32).collect())
            .unwrap_or_default();
        let mut out = HashMap::new();
        for n in seasons.into_iter().take(60) {
            let s = self.get(&format!("/tv/{id}/season/{n}"), &[]).await?;
            for e in s.get("episodes").and_then(Value::as_array).into_iter().flatten() {
                if let (Some(ep), Some(name)) = (e.get("episode_number").and_then(Value::as_u64), e.get("name").and_then(Value::as_str)) {
                    out.insert((n, ep as u32), name.to_string());
                }
            }
        }
        Ok(out)
    }
}

fn results(v: &Value) -> Vec<Value> {
    v.get("results").and_then(Value::as_array).cloned().unwrap_or_default()
}

// -------------------------------------------------------------------- TVmaze

pub async fn tvmaze_search(name: &str) -> Result<Vec<Candidate>> {
    let resp = http()?
        .get(format!("{TVMAZE}/search/shows"))
        .query(&[("q", name)])
        .send()
        .await
        .map_err(|e| Error::Network(e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(Error::msg(format!("TVmaze answered with status {}.", resp.status())));
    }
    let v: Value = resp.json().await.map_err(|_| Error::msg("TVmaze gave an unexpected answer."))?;
    Ok(v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r.get("show"))
        .take(10)
        .map(|s| {
            let mut ids = HashMap::new();
            if let Some(t) = s.pointer("/externals/thetvdb").and_then(Value::as_u64) {
                ids.insert("tvdb".to_string(), t.to_string());
            }
            if let Some(i) = s.pointer("/externals/imdb").and_then(Value::as_str) {
                ids.insert("imdb".to_string(), i.to_string());
            }
            Candidate {
                source: "tvmaze".into(),
                id: s.get("id").map(|i| i.to_string()).unwrap_or_default(),
                name: s.get("name").and_then(Value::as_str).unwrap_or("").into(),
                year: year_of(s.get("premiered").and_then(Value::as_str)),
                poster: s.pointer("/image/medium").and_then(Value::as_str).map(|u| u.replace("http://", "https://")),
                score: 0,
                ids,
            }
        })
        .collect())
}

pub async fn tvmaze_episodes(id: &str) -> Result<HashMap<(u32, u32), String>> {
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::msg("bad id"));
    }
    let resp = http()?
        .get(format!("{TVMAZE}/shows/{id}/episodes"))
        .query(&[("specials", "1")])
        .send()
        .await
        .map_err(|e| Error::Network(e.without_url().to_string()))?;
    let v: Value = resp.json().await.map_err(|_| Error::msg("TVmaze gave an unexpected answer."))?;
    let mut out = HashMap::new();
    for e in v.as_array().into_iter().flatten() {
        let season = e.get("season").and_then(Value::as_u64);
        let number = e.get("number").and_then(Value::as_u64);
        let name = e.get("name").and_then(Value::as_str);
        if let (Some(s), Some(n), Some(name)) = (season, number, name) {
            out.insert((s as u32, n as u32), name.to_string());
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_compare_sensibly() {
        assert_eq!(similarity("The Office", "Office"), 1.0);
        assert!(similarity("Bluey", "Bluey") > 0.99);
        assert!(similarity("Mission Impossible - Fallout", "Mission: Impossible – Fallout") > 0.95);
        assert!(similarity("Bluey", "Blue's Clues") < 0.6);
        assert_eq!(similarity("", "x"), 0.0);
    }

    #[test]
    fn year_breaks_ties() {
        let right = match_score("Doctor Who", Some(2005), "Doctor Who", Some(2005));
        let old = match_score("Doctor Who", Some(2005), "Doctor Who", Some(1963));
        assert!(right > old + 15);
        assert_eq!(right, 100);
        assert!(match_score("Bluey", None, "Bluey", Some(2018)) >= 95);
    }

    #[test]
    fn ranking_puts_best_first() {
        let c = |n: &str, y: i32| Candidate { source: "tmdb".into(), id: "1".into(), name: n.into(), year: Some(y), poster: None, score: 0, ids: HashMap::new() };
        let r = rank(vec![c("Bluey Minisodes", 2024), c("Bluey", 2018)], "Bluey", Some(2018));
        assert_eq!(r[0].name, "Bluey");
        assert!(r[0].score > r[1].score);
    }

    #[test]
    fn language_is_sanitised() {
        assert_eq!(Tmdb::new("k", "nl-NL").lang, "nl-NL");
        assert_eq!(Tmdb::new("k", "x&y=z").lang, "en-US");
    }
}
