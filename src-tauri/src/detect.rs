//! Turns fingerprints of a season's episodes into intro / credits suggestions.
//! Pure logic (no ffmpeg, no network), unit tested.

use crate::fingerprint::{find_common, Fingerprint};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

impl Span {
    pub fn len(&self) -> f64 {
        self.end - self.start
    }
}

/// One episode's audio windows. `offset` is where the window starts in the episode (seconds).
pub struct Window {
    pub offset: f64,
    pub fp: Fingerprint,
}

pub struct Limits {
    pub min: f64,
    pub max: f64,
}

pub const INTRO_LIMITS: Limits = Limits { min: 12.0, max: 150.0 };
pub const CREDITS_LIMITS: Limits = Limits { min: 15.0, max: 420.0 };

/// For every episode, the span it shares with its neighbours (next two and previous two),
/// chosen to agree with the typical length found across the season.
pub fn season_spans(windows: &[Option<Window>], limits: &Limits) -> Vec<Option<Span>> {
    let n = windows.len();
    let mut found: Vec<Vec<Span>> = vec![Vec::new(); n];
    for i in 0..n {
        for j in [i + 1, i + 2] {
            if j >= n {
                continue;
            }
            let (Some(a), Some(b)) = (&windows[i], &windows[j]) else { continue };
            if let Some(c) = find_common(&a.fp, &b.fp, limits.min as f32) {
                let sa = Span { start: a.offset + c.a_start as f64, end: a.offset + c.a_end as f64 };
                let sb = Span { start: b.offset + c.b_start as f64, end: b.offset + c.b_end as f64 };
                if sa.len() <= limits.max {
                    found[i].push(sa);
                    found[j].push(sb);
                }
            }
        }
    }
    let mut lens: Vec<f64> = found.iter().flatten().map(Span::len).collect();
    if lens.is_empty() {
        return vec![None; n];
    }
    lens.sort_by(|a, b| a.total_cmp(b));
    let typical = lens[lens.len() / 2];
    found
        .into_iter()
        .map(|spans| {
            spans
                .into_iter()
                .min_by(|a, b| (a.len() - typical).abs().total_cmp(&(b.len() - typical).abs()).then(b.len().total_cmp(&a.len())))
        })
        .collect()
}

/// Credits that end close to the end of the file are stretched to the very end.
pub fn snap_to_end(span: Span, duration: f64) -> Span {
    if duration - span.end < 10.0 {
        Span { start: span.start, end: duration }
    } else {
        span
    }
}

/// An intro that starts within 2 seconds of the beginning starts at 0.
pub fn snap_to_start(span: Span) -> Span {
    if span.start < 2.0 {
        Span { start: 0.0, end: span.end }
    } else {
        span
    }
}

/// Where to listen: the first part of an episode for the intro, the last part for credits.
pub fn intro_window(duration: f64, max: f64) -> (f64, f64) {
    (0.0, (duration * 0.30).min(max).max(30.0_f64.min(duration)))
}

pub fn credits_window(duration: f64, max: f64) -> (f64, f64) {
    let len = (duration * 0.25).min(max).max(30.0_f64.min(duration));
    ((duration - len).max(0.0), len)
}

const TICKS: f64 = 10_000_000.0;

/// Intro / credits from chapter names, when the file has them ("Intro", "Opening", "Credits", ...).
pub fn from_chapters(item: &Value) -> (Option<Span>, Option<Span>) {
    let duration = item.get("RunTimeTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS;
    let chapters: Vec<(f64, String)> = item
        .get("Chapters")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|c| {
                    (
                        c.get("StartPositionTicks").and_then(Value::as_f64).unwrap_or(0.0) / TICKS,
                        c.get("Name").and_then(Value::as_str).unwrap_or("").trim().to_lowercase(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let span_at = |i: usize| -> Span {
        let end = chapters.get(i + 1).map(|c| c.0).unwrap_or(duration);
        Span { start: chapters[i].0, end }
    };
    let is = |name: &str, words: &[&str]| words.iter().any(|w| name == *w || name.starts_with(&format!("{w} ")) || name.ends_with(&format!(" {w}")));
    let mut intro = None;
    let mut credits = None;
    for (i, (_, name)) in chapters.iter().enumerate() {
        if intro.is_none() && is(name, &["intro", "opening", "opening credits", "op", "title sequence"]) {
            intro = Some(span_at(i));
        }
        if credits.is_none() && is(name, &["credits", "end credits", "ending", "outro", "ed", "closing credits"]) {
            credits = Some(span_at(i));
        }
    }
    let ok = |s: Option<Span>, l: &Limits| s.filter(|s| s.len() >= 5.0 && s.len() <= l.max * 1.5);
    (ok(intro, &INTRO_LIMITS), ok(credits, &CREDITS_LIMITS))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fingerprint::{fingerprint, RATE};

    struct Lcg(u64);
    impl Lcg {
        fn noise(&mut self, seconds: f64) -> Vec<i16> {
            (0..(seconds * RATE as f64) as usize)
                .map(|_| {
                    self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    ((self.0 >> 33) as i32 % 8000) as i16
                })
                .collect()
        }
    }

    #[test]
    fn finds_the_intro_in_every_episode_of_a_season() {
        let intro = Lcg(1000).noise(25.0);
        // Cold opens of different length before the intro; episode 4 has no intro at all.
        let cold = [3.0, 10.0, 0.0, 6.0, 15.0];
        let windows: Vec<Option<Window>> = cold
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut a = Lcg(i as u64 + 1).noise(*c);
                if i != 3 {
                    a.extend(&intro);
                }
                a.extend(Lcg(i as u64 + 50).noise(30.0));
                Some(Window { offset: 0.0, fp: fingerprint(&a) })
            })
            .collect();
        let spans = season_spans(&windows, &INTRO_LIMITS);
        for (i, c) in cold.iter().enumerate() {
            if i == 3 {
                assert!(spans[i].is_none(), "episode without intro: {:?}", spans[i]);
                continue;
            }
            let s = spans[i].unwrap_or_else(|| panic!("episode {i} missing"));
            assert!((s.start - c).abs() < 1.5 && (s.len() - 25.0).abs() < 2.5, "episode {i}: {s:?}");
        }
    }

    #[test]
    fn windows_and_snapping() {
        assert_eq!(intro_window(1500.0, 360.0), (0.0, 360.0));
        assert_eq!(intro_window(600.0, 360.0), (0.0, 180.0));
        assert_eq!(credits_window(1500.0, 240.0), (1260.0, 240.0));
        assert_eq!(snap_to_end(Span { start: 1400.0, end: 1495.0 }, 1500.0).end, 1500.0);
        assert_eq!(snap_to_end(Span { start: 1300.0, end: 1400.0 }, 1500.0).end, 1400.0);
        assert_eq!(snap_to_start(Span { start: 1.2, end: 30.0 }).start, 0.0);
    }

    #[test]
    fn chapters_with_names_are_used() {
        let item = serde_json::json!({
            "RunTimeTicks": 1500.0 * TICKS,
            "Chapters": [
                {"StartPositionTicks": 0, "Name": "Prologue"},
                {"StartPositionTicks": 90.0 * TICKS, "Name": "Opening"},
                {"StartPositionTicks": 180.0 * TICKS, "Name": "Part A"},
                {"StartPositionTicks": 1400.0 * TICKS, "Name": "End Credits"}
            ]
        });
        let (i, c) = from_chapters(&item);
        assert_eq!(i, Some(Span { start: 90.0, end: 180.0 }));
        assert_eq!(c, Some(Span { start: 1400.0, end: 1500.0 }));
        let plain = serde_json::json!({"RunTimeTicks": 100, "Chapters": [{"StartPositionTicks": 0, "Name": "Chapter 1"}]});
        assert_eq!(from_chapters(&plain), (None, None));
    }
}
