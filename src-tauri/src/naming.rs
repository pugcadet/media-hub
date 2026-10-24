//! Pure naming logic: reading names, cleaning them, and filling name templates.
//! Nothing in this file touches the disk or the network, so all of it is unit tested.

use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

pub const VIDEO_EXT: &[&str] = &[
    "mkv", "mp4", "m4v", "avi", "mov", "wmv", "ts", "m2ts", "mpg", "mpeg", "webm", "flv",
];
pub const SIDECAR_EXT: &[&str] = &["srt", "ass", "ssa", "sub", "idx", "vtt", "sup"];

macro_rules! re {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static Regex {
            static R: OnceLock<Regex> = OnceLock::new();
            R.get_or_init(|| Regex::new($pat).expect("valid regex"))
        }
    };
}

re!(re_sxe, r"(?i)(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?:[^0-9]|$)");
re!(re_more, r"(?i)^(?:-e|e|-)(\d{1,3})(?:[^0-9]|$)");
re!(re_nxm, r"(?i)(?:^|[^0-9a-z])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)");
re!(re_lead, r"(?i)^(?:episode[ ._-]*|ep[ ._-]*|e)?(\d{1,3})(?:[ ._-]+|$)");
re!(re_idtag, r"(?i)[\{\[](tmdb|tmdbid|imdb|imdbid|tvdb|tvdbid)[- ]?([a-z0-9]+)[\}\]]");
re!(re_year, r"(?:^|[ ._(\[-])((?:19|20)\d{2})(?:$|[ ._)\]-])");
re!(re_season_dir, r"(?i)^(?:season|series|s)[ ._-]*(\d{1,2})$");
re!(re_res, r"(?i)^\d{3,4}[pi]$");
re!(re_brackets, r"\[[^\]]*\]");

// ---------------------------------------------------------------- file names

/// Splits "name.ext" into ("name", "ext"). A "dot" far from the end is not an extension.
pub fn split_ext(name: &str) -> (&str, &str) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() && ext.len() <= 5 => (stem, ext),
        _ => (name, ""),
    }
}

/// "a/b/c.mkv" -> ("a/b", "c.mkv")
pub fn split_path(p: &str) -> (&str, &str) {
    match p.rsplit_once('/') {
        Some((d, n)) => (d, n),
        None => ("", p),
    }
}

pub fn is_video(name: &str) -> bool {
    VIDEO_EXT.contains(&split_ext(name).1.to_lowercase().as_str())
}

pub fn is_sidecar(name: &str) -> bool {
    SIDECAR_EXT.contains(&split_ext(name).1.to_lowercase().as_str())
}

// ------------------------------------------------------------------ cleaning

const JUNK: &[&str] = &[
    "bluray", "blu-ray", "bdrip", "brrip", "webrip", "web-dl", "webdl", "hdtv", "dvdrip", "x264",
    "x265", "h264", "h265", "hevc", "avc", "aac", "ac3", "dts", "dd5", "ddp5", "remux", "repack",
    "4k", "uhd", "amzn", "dsnp", "hmax", "atvp", "10bit",
];

/// Turns a release-style tail ("Muddy.Puddles.1080p.WEB-DL.x264") into a plain title.
pub fn clean_release(s: &str) -> String {
    let no_brackets = re_brackets().replace_all(s, " ").to_string();
    let spaced = if no_brackets.contains(' ') {
        no_brackets
    } else {
        no_brackets.replace(['.', '_'], " ")
    };
    let mut words: Vec<&str> = Vec::new();
    for w in spaced.split_whitespace() {
        let key = w
            .trim_matches(|c: char| !c.is_alphanumeric() && c != '-')
            .to_lowercase();
        if JUNK.contains(&key.as_str()) || re_res().is_match(&key) {
            break;
        }
        words.push(w);
    }
    words
        .join(" ")
        .trim_matches(|c| c == ' ' || c == '-' || c == '.' || c == '_')
        .to_string()
}

/// Safe single path component: no characters Windows, macOS or SMB shares dislike.
pub fn sanitize(s: &str) -> String {
    let s = s.replace(": ", " - ");
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            ':' | '/' | '\\' => out.push('-'),
            '"' | '*' | '?' | '<' | '>' | '|' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    finalize_component(&out)
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Final tidy of one path component: single spaces, no trailing dots/spaces, not too long.
pub fn finalize_component(c: &str) -> String {
    let collapsed = c.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut t = collapsed.trim_end_matches(['.', ' ']).to_string();
    if RESERVED.contains(&split_ext(&t).0.to_lowercase().as_str()) {
        t.insert(0, '_');
    }
    const MAX: usize = 200;
    if t.chars().count() > MAX {
        let (stem, ext) = split_ext(&t);
        let keep = MAX.saturating_sub(ext.chars().count() + 1);
        let short: String = stem.chars().take(keep).collect();
        t = if ext.is_empty() { short } else { format!("{short}.{ext}") };
    }
    t
}

// ---------------------------------------------------------- reading folder / movie names

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ParsedName {
    pub title: String,
    pub year: Option<i32>,
    pub tmdb: Option<String>,
    pub tvdb: Option<String>,
    pub imdb: Option<String>,
}

/// Works for movie file names and show folder names:
/// "Inception (2010) {tmdb-27205}", "The.Matrix.1999.1080p.BluRay", "Bluey (2018)".
pub fn parse_name(raw: &str) -> ParsedName {
    let mut out = ParsedName::default();
    for c in re_idtag().captures_iter(raw) {
        let id = c[2].to_string();
        match c[1].to_lowercase().trim_end_matches("id") {
            "tmdb" => out.tmdb = Some(id),
            "tvdb" => out.tvdb = Some(id),
            "imdb" => out.imdb = Some(id),
            _ => {}
        }
    }
    let without_tags = re_idtag().replace_all(raw, " ").to_string();
    let text = without_tags.trim();

    // The last year-looking number that still leaves a title in front of it.
    let mut chosen: Option<(usize, i32)> = None;
    for c in re_year().captures_iter(text) {
        let g = c.get(1).expect("group 1");
        let y: i32 = g.as_str().parse().unwrap_or(0);
        if g.start() > 0 && !text[..g.start()].trim_matches(|ch: char| !ch.is_alphanumeric()).is_empty() {
            chosen = Some((g.start(), y));
        }
    }
    match chosen {
        Some((pos, y)) => {
            out.year = Some(y);
            out.title = clean_release(text[..pos].trim_end_matches(|c| c == '(' || c == '[' || c == ' '));
        }
        None => out.title = clean_release(text),
    }
    if out.title.is_empty() {
        out.title = text.to_string();
    }
    out
}

// ------------------------------------------------------------------- episodes

#[derive(Debug, Clone, PartialEq)]
pub struct EpisodeMatch {
    pub season: u32,
    pub episodes: Vec<u32>,
    /// Byte range of the episode marker inside the stem; the title follows it.
    pub end: usize,
}

/// "Season 2" / "S02" / "Specials" -> season number.
pub fn season_from_dir(name: &str) -> Option<u32> {
    if name.eq_ignore_ascii_case("specials") {
        return Some(0);
    }
    re_season_dir().captures(name).and_then(|c| c[1].parse().ok())
}

/// Reads the season and episode number(s) out of a file name (no extension).
/// `season_hint` is the season of the folder the file sits in, if any.
pub fn parse_episode(stem: &str, season_hint: Option<u32>) -> Option<EpisodeMatch> {
    if let Some(c) = re_sxe().captures(stem) {
        let season: u32 = c[1].parse().ok()?;
        let first = c.get(2)?;
        let mut eps = vec![first.as_str().parse::<u32>().ok()?];
        let mut end = first.end();
        while let Some(m) = re_more().captures(&stem[end..]) {
            let g = m.get(1)?;
            let n: u32 = g.as_str().parse().ok()?;
            let last = *eps.last()?;
            if n <= last || n - last > 20 {
                break;
            }
            eps.push(n);
            end += g.end();
        }
        return Some(EpisodeMatch { season, episodes: eps, end });
    }
    if let Some(c) = re_nxm().captures(stem) {
        let g = c.get(2)?;
        return Some(EpisodeMatch {
            season: c[1].parse().ok()?,
            episodes: vec![g.as_str().parse().ok()?],
            end: g.end(),
        });
    }
    let season = season_hint?;
    let c = re_lead().captures(stem)?;
    let g = c.get(1)?;
    Some(EpisodeMatch {
        season,
        episodes: vec![g.as_str().parse().ok()?],
        end: g.end(),
    })
}

/// The title part that follows the episode marker, if the file name has one.
pub fn title_after(stem: &str, m: &EpisodeMatch) -> String {
    let tail = stem[m.end..].trim_matches(|c: char| " -._".contains(c));
    clean_release(tail)
}

// ------------------------------------------------------------------ templates

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Lit(String),
    Tok { name: String, pad: usize },
    /// `<...>`: only written when every token inside has a value.
    Opt(Vec<Node>),
}

#[derive(Debug, Clone, Default)]
pub struct Var {
    pub text: String,
    pub num: Option<u32>,
}

impl Var {
    pub fn text(s: impl Into<String>) -> Self {
        Var { text: s.into(), num: None }
    }
    pub fn num(n: u32) -> Self {
        Var { text: n.to_string(), num: Some(n) }
    }
}

#[derive(Debug, Clone)]
pub struct Template {
    nodes: Vec<Node>,
}

impl Template {
    /// Syntax: `{token}`, `{token:00}` (zero padded), `<optional part with {token}>`, `/` between folders.
    pub fn parse(src: &str, allowed: &[&str]) -> Result<Template, String> {
        if src.trim().is_empty() {
            return Err("The name pattern is empty.".into());
        }
        if src.starts_with('/') || src.contains('\\') || src.split('/').any(|p| p == ".." || p == ".") {
            return Err("The pattern must be a relative path using / between folders.".into());
        }
        let mut stack: Vec<Vec<Node>> = vec![Vec::new()];
        let mut lit = String::new();
        let mut chars = src.chars();
        let flush = |lit: &mut String, stack: &mut Vec<Vec<Node>>| {
            if !lit.is_empty() {
                stack.last_mut().expect("stack").push(Node::Lit(std::mem::take(lit)));
            }
        };
        while let Some(c) = chars.next() {
            match c {
                '{' => {
                    flush(&mut lit, &mut stack);
                    let mut inner = String::new();
                    loop {
                        match chars.next() {
                            Some('}') => break,
                            Some(ch) => inner.push(ch),
                            None => return Err("A { is missing its closing }.".into()),
                        }
                    }
                    let (name, fmt) = inner.split_once(':').unwrap_or((inner.as_str(), ""));
                    if !allowed.contains(&name) {
                        return Err(format!(
                            "Unknown item {{{name}}}. You can use: {}.",
                            allowed.iter().map(|a| format!("{{{a}}}")).collect::<Vec<_>>().join(" ")
                        ));
                    }
                    if !fmt.chars().all(|ch| ch == '0') {
                        return Err(format!("Use {{{name}:00}} for zero padding."));
                    }
                    stack.last_mut().expect("stack").push(Node::Tok { name: name.to_string(), pad: fmt.len() });
                }
                '<' => {
                    flush(&mut lit, &mut stack);
                    stack.push(Vec::new());
                }
                '>' => {
                    flush(&mut lit, &mut stack);
                    if stack.len() < 2 {
                        return Err("A > has no matching <.".into());
                    }
                    let group = stack.pop().expect("group");
                    stack.last_mut().expect("stack").push(Node::Opt(group));
                }
                c => lit.push(c),
            }
        }
        flush(&mut lit, &mut stack);
        if stack.len() != 1 {
            return Err("A < is missing its closing >.".into());
        }
        Ok(Template { nodes: stack.pop().expect("root") })
    }

    /// Fills in the template. Err when a required (non-optional) item has no value.
    pub fn render(&self, vars: &HashMap<&str, Var>) -> Result<String, String> {
        let mut out = String::new();
        let mut missing = None;
        render_nodes(&self.nodes, vars, &mut out, &mut missing);
        if let Some(name) = missing {
            return Err(format!("No value for {{{name}}} in this file."));
        }
        let parts: Vec<String> = out
            .split('/')
            .map(finalize_component)
            .filter(|p| !p.is_empty())
            .collect();
        if parts.is_empty() {
            return Err("The pattern produced an empty name.".into());
        }
        Ok(parts.join("/"))
    }
}

fn render_nodes(nodes: &[Node], vars: &HashMap<&str, Var>, out: &mut String, missing: &mut Option<String>) {
    for n in nodes {
        match n {
            Node::Lit(s) => out.push_str(s),
            Node::Tok { name, pad } => match vars.get(name.as_str()) {
                Some(v) if !v.text.is_empty() => match (*pad, v.num) {
                    (w, Some(num)) if w > 0 => out.push_str(&format!("{num:0w$}")),
                    _ => out.push_str(&sanitize(&v.text)),
                },
                _ => {
                    missing.get_or_insert_with(|| name.clone());
                }
            },
            Node::Opt(inner) => {
                let mut tmp = String::new();
                let mut inner_missing = None;
                render_nodes(inner, vars, &mut tmp, &mut inner_missing);
                if inner_missing.is_none() {
                    out.push_str(&tmp);
                }
            }
        }
    }
}

// ------------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    fn ep(stem: &str, hint: Option<u32>) -> Option<(u32, Vec<u32>)> {
        parse_episode(stem, hint).map(|m| (m.season, m.episodes))
    }

    #[test]
    fn episode_formats() {
        assert_eq!(ep("Bluey (2018) - S01E01 - Magic Xylophone", None), Some((1, vec![1])));
        assert_eq!(ep("bluey.s02e10.1080p.web-dl", None), Some((2, vec![10])));
        assert_eq!(ep("Bluey (2018) - S01E03-E04", None), Some((1, vec![3, 4])));
        assert_eq!(ep("Show S01E05E06 Title", None), Some((1, vec![5, 6])));
        assert_eq!(ep("Paw Patrol - 1x02", None), Some((1, vec![2])));
        assert_eq!(ep("01 Muddy Puddles", Some(1)), Some((1, vec![1])));
        assert_eq!(ep("Episode 12", Some(3)), Some((3, vec![12])));
        assert_eq!(ep("01 Muddy Puddles", None), None);
    }

    #[test]
    fn resolution_is_not_an_episode() {
        assert_eq!(ep("Show S01E01-1080p", None), Some((1, vec![1])));
        assert_eq!(ep("Movie 1920x1080", None), None);
        assert_eq!(ep("2001 A Space Odyssey", Some(1)), None);
    }

    #[test]
    fn titles_after_marker() {
        let m = parse_episode("Show - S01E01 - Magic Xylophone", None).unwrap();
        assert_eq!(title_after("Show - S01E01 - Magic Xylophone", &m), "Magic Xylophone");
        let m = parse_episode("show.s01e02.the.beach.1080p.web-dl.x264", None).unwrap();
        assert_eq!(title_after("show.s01e02.the.beach.1080p.web-dl.x264", &m), "the beach");
        let m = parse_episode("Bluey (2018) - S01E02", None).unwrap();
        assert_eq!(title_after("Bluey (2018) - S01E02", &m), "");
    }

    #[test]
    fn names_with_years_and_ids() {
        let p = parse_name("Inception (2010) {tmdb-27205}");
        assert_eq!((p.title.as_str(), p.year, p.tmdb.as_deref()), ("Inception", Some(2010), Some("27205")));
        let p = parse_name("The.Matrix.1999.1080p.BluRay.x264");
        assert_eq!((p.title.as_str(), p.year), ("The Matrix", Some(1999)));
        let p = parse_name("Mission Impossible - Fallout (2018)");
        assert_eq!((p.title.as_str(), p.year), ("Mission Impossible - Fallout", Some(2018)));
        let p = parse_name("The Matrix");
        assert_eq!((p.title.as_str(), p.year), ("The Matrix", None));
        let p = parse_name("2012");
        assert_eq!((p.title.as_str(), p.year), ("2012", None));
        let p = parse_name("Bluey [tvdbid-353546]");
        assert_eq!((p.title.as_str(), p.tvdb.as_deref()), ("Bluey", Some("353546")));
    }

    #[test]
    fn seasons_from_folders() {
        assert_eq!(season_from_dir("Season 1"), Some(1));
        assert_eq!(season_from_dir("season02"), Some(2));
        assert_eq!(season_from_dir("S03"), Some(3));
        assert_eq!(season_from_dir("Specials"), Some(0));
        assert_eq!(season_from_dir("Extras"), None);
    }

    #[test]
    fn sanitizing() {
        assert_eq!(sanitize("Mission: Impossible"), "Mission - Impossible");
        assert_eq!(sanitize("What?* Is \"this\"|"), "What Is this");
        assert_eq!(sanitize("AC/DC"), "AC-DC");
        assert_eq!(sanitize("Title..."), "Title");
        assert_eq!(sanitize("con"), "_con");
        assert!(sanitize(&"x".repeat(500)).chars().count() <= 200);
    }

    fn vars() -> HashMap<&'static str, Var> {
        let mut v = HashMap::new();
        v.insert("show", Var::text("Bluey"));
        v.insert("year", Var::num(2018));
        v.insert("s", Var::num(1));
        v.insert("e", Var::num(2));
        v.insert("title", Var::text("Hotel: The Movie"));
        v.insert("ext", Var::text("mkv"));
        v
    }

    #[test]
    fn templates_fill_in_and_skip_optional_parts() {
        let t = Template::parse(
            "{show}< ({year})>/Season {s:00}/{show} - S{s:00}E{e:00}< - {title}>.{ext}",
            &["show", "year", "s", "e", "title", "ext"],
        )
        .unwrap();
        assert_eq!(
            t.render(&vars()).unwrap(),
            "Bluey (2018)/Season 01/Bluey - S01E02 - Hotel - The Movie.mkv"
        );
        let mut v = vars();
        v.remove("title");
        v.remove("year");
        assert_eq!(t.render(&v).unwrap(), "Bluey/Season 01/Bluey - S01E02.mkv");
        v.remove("show");
        assert!(t.render(&v).is_err());
    }

    #[test]
    fn bad_templates_are_rejected() {
        let a = ["show", "ext"];
        assert!(Template::parse("", &a).is_err());
        assert!(Template::parse("../{show}.{ext}", &a).is_err());
        assert!(Template::parse("/abs/{show}", &a).is_err());
        assert!(Template::parse("{nope}", &a).is_err());
        assert!(Template::parse("{show", &a).is_err());
        assert!(Template::parse("<{show}", &a).is_err());
        assert!(Template::parse("{show}>", &a).is_err());
        assert!(Template::parse("{show:abc}", &a).is_err());
    }
}
