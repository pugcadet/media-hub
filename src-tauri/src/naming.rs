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
// Edition words that are not part of the title ("Directors Cut", "Special Cut Remastered").
re!(re_edition, r"(?i)[ ._(\[-]+(?:(?:the[ ._-]+)?(?:directors?'?s?|director'?s|extended|special|theatrical|final|ultimate|collectors?'?s?|anniversary|limited|definitive|\d{1,3}(?:th|st|nd|rd)[ ._-]+anniversary)[ ._-]+(?:cut|edition|version)|unrated|uncut|remaster(?:ed)?|restored|remake|re-?cut|criterion(?:[ ._-]+collection)?|despecialized|open[ ._-]matte)(?:[ ._-]+(?:cut|edition|version))?(?:$|[ ._)\]-]+)");
// Release-style season folders: "You.S05.1080p…", "You.SEASON.03.S03.COMPLETE…", "YOU (2018) Season 02 S02 (…)".
re!(re_season_release, r"(?i)(?:^|[ ._(\[-])(?:season|series)[ ._-]*(\d{1,2})(?:$|[^0-9])|(?:^|[ ._(\[-])s(\d{1,2})(?:$|[ ._)\]-])");

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
    let spaced = if no_brackets.trim().contains(' ') {
        no_brackets
    } else {
        no_brackets.replace(['.', '_'], " ")
    };
    let spaced = strip_editions(&spaced);
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

/// Removes edition words ("Directors Cut", "Remastered", "Extended Edition") from a title.
/// The whole title is never removed ("Remastered" alone stays).
pub fn strip_editions(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        let next = re_edition().replace_all(&out, " ").to_string();
        if next == out {
            break;
        }
        out = next;
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let out = out.trim_matches(|c: char| c == ' ' || c == '-' || c == '.' || c == '_' || c == '(' || c == '[').to_string();
    if out.chars().any(|c| c.is_alphanumeric()) { out } else { s.to_string() }
}

/// True when a name needs tidying for its own sake: release tags (quality, codec, source,
/// group like "[YTS.MX]") or dots/underscores instead of spaces. Names that are only in a
/// different style ("Show - 1x02", no year, no episode title) are not messy: Jellyfin reads them.
pub fn is_messy(stem: &str) -> bool {
    let s = stem.trim();
    // Any [bracket] counts: release groups, and also id tags ([tmdbid-123]), which you don't want in names.
    if re_brackets().is_match(s) || re_idtag().is_match(s) {
        return true;
    }
    if !s.contains(' ') && (s.matches('.').count() >= 2 || s.contains('_')) {
        return true;
    }
    if dedupe_year(s) != s {
        return true; // "Aliens (1986) (1986)"
    }
    if strip_editions(s) != s.split_whitespace().collect::<Vec<_>>().join(" ") {
        return true; // "Sling Blade Directors Cut (1996)"
    }
    let spaced = if s.contains(' ') { s.to_string() } else { s.replace(['.', '_'], " ") };
    spaced.split(|c: char| c.is_whitespace() || c == '.').any(|w| {
        let key = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-').to_lowercase();
        JUNK.contains(&key.as_str()) || re_res().is_match(&key)
    })
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

/// "Aliens (1986) (1986)" → "Aliens (1986)": a year is never written twice.
pub fn dedupe_year(s: &str) -> String {
    let mut out = s.to_string();
    loop {
        let b = out.as_bytes();
        let mut hit: Option<(usize, usize)> = None;
        let mut i = 0;
        while i + 6 <= b.len() {
            if b[i] == b'(' && b[i + 5] == b')' && b[i + 1..i + 5].iter().all(u8::is_ascii_digit) {
                let year = &out[i..i + 6];
                let rest = &out[i + 6..];
                let trimmed = rest.trim_start_matches([' ', '-', '.', '_']);
                if trimmed.starts_with(year) {
                    let skip = rest.len() - trimmed.len();
                    hit = Some((i + 6, i + 6 + skip + 6));
                    break;
                }
            }
            i += 1;
        }
        match hit {
            Some((a, z)) => out.replace_range(a..z, ""),
            None => break,
        }
    }
    out
}

/// The title without a year it already carries ("Prometheus (2012)" → "Prometheus"), so the
/// year can be added once.
pub fn title_without_year(title: &str, year: Option<i64>) -> String {
    let t = title.trim();
    if let Some(y) = year {
        for form in [format!("({y})"), format!("[{y}]"), y.to_string()] {
            if let Some(rest) = t.strip_suffix(form.as_str()) {
                let rest = rest.trim_end_matches([' ', '-', '.', '_']);
                if !rest.is_empty() {
                    return rest.to_string();
                }
            }
        }
    }
    t.to_string()
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Final tidy of one path component: single spaces, no trailing dots/spaces, not too long.
pub fn finalize_component(c: &str) -> String {
    let collapsed = dedupe_year(&c.split_whitespace().collect::<Vec<_>>().join(" "));
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

/// The title to name a movie by: the database's, unless the file's own name is the same title
/// with more to it ("Star Wars" vs the file's "Star Wars Episode IV - A New Hope"), then the
/// file's, so the folder and the file say the same thing.
pub fn fuller_title(db: &str, file: &str) -> String {
    fn words(t: &str) -> Vec<String> {
        t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_string).collect()
    }
    let (d, f) = (words(db), words(file));
    if !d.is_empty() && f.len() > d.len() && f[..d.len()] == d[..] && file.chars().any(|c| c.is_uppercase()) {
        file.trim().to_string()
    } else {
        db.trim().to_string()
    }
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
    if let Some(n) = re_season_dir().captures(name).and_then(|c| c[1].parse().ok()) {
        return Some(n);
    }
    season_from_release_dir(name)
}

/// "Season 1", "S01", "Specials": a season folder named the plain way (any style).
pub fn is_plain_season_dir(name: &str) -> bool {
    name.eq_ignore_ascii_case("specials") || re_season_dir().is_match(name)
}

/// A downloaded season folder: "You.S05.1080p.WEBRip", "You.SEASON.03.S03.COMPLETE",
/// "YOU (2018) Season 02 S02 (1080p …)". Not an episode ("S05E01") and only one season.
pub fn season_from_release_dir(name: &str) -> Option<u32> {
    if re_sxe().is_match(name) || re_nxm().is_match(name) {
        return None;
    }
    // "S01-S03", "Season 1-3": several seasons in one folder.
    static RANGE: OnceLock<Regex> = OnceLock::new();
    let range = RANGE.get_or_init(|| Regex::new(r"(?i)(?:s|season[ ._-]*)\d{1,2}[ ._]*-[ ._]*(?:s|season[ ._-]*)?\d{1,2}(?:$|[^0-9])").expect("season range"));
    if range.is_match(name) {
        return None;
    }
    let mut found: Option<u32> = None;
    for c in re_season_release().captures_iter(name) {
        let n: u32 = c.get(1).or(c.get(2))?.as_str().parse().ok()?;
        match found {
            Some(f) if f != n => return None, // "S01-S03": several seasons
            _ => found = Some(n),
        }
    }
    // A plain name with a lone "S2" in it isn't enough unless it also looks like a release.
    let f = found?;
    let lower = name.to_lowercase();
    let releaseish = lower.contains("season") || lower.contains("complete") || is_messy(name) || re_season_dir().is_match(name);
    releaseish.then_some(f)
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


/// "Amélie" → "amelie"-style folding for comparing names (lowercase stays as given).
pub fn fold_accents(t: &str) -> String {
    t.chars()
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'A',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'È' | 'É' | 'Ê' | 'Ë' => 'E',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
            'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' => 'O',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'Ù' | 'Ú' | 'Û' | 'Ü' => 'U',
            'ñ' => 'n',
            'ç' => 'c',
            c => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messy_names() {
        assert!(is_messy("Ad.Astra.2019.2160p.4K.BluRay.x265.10bit.AAC5.1-[YTS.MX]"));
        assert!(is_messy("Dune Part Two 2024 1080p WEB-DL"));
        assert!(is_messy("the_bear_s01e01"));
        assert!(!is_messy("Planet Earth - S01E08 - Jungles"));
        assert!(!is_messy("Bluey - S01E02"));
        assert!(!is_messy("Mr. Robot - S01E01 - eps1.0_hellofriend.mov"[..23].trim()));
        assert!(!is_messy("Ad Astra (2019)"));
        assert!(is_messy("Ad Astra (2019) [tmdbid-419704]"));
        assert!(is_messy("Sling Blade Directors Cut (1996)"));
    }

    #[test]
    fn edition_words_are_not_the_title() {
        assert_eq!(parse_name("Sling Blade Directors Cut (1996)").title, "Sling Blade");
        assert_eq!(parse_name("Aliens (1986) Special Cut Remastered").title, "Aliens");
        assert_eq!(parse_name("Blade.Runner.1982.The.Final.Cut.1080p").title, "Blade Runner");
        assert_eq!(parse_name("Apocalypse Now Redux Extended Edition (1979)").title, "Apocalypse Now Redux");
        assert_eq!(parse_name("Dawn of the Dead Remake (2004)").title, "Dawn of the Dead");
        assert_eq!(parse_name("The Director (2010)").title, "The Director");
        assert_eq!(parse_name("Final Destination (2000)").title, "Final Destination");
        assert_eq!(parse_name("Special (2006)").title, "Special");
        assert_eq!(strip_editions("Remastered"), "Remastered");
        assert_eq!(parse_name("Heat.1995.Directors.Cut.1080p.BluRay").title, "Heat");
        assert_eq!(clean_release("Some.Movie.Extended.Cut.1080p"), "Some Movie");
    }

    #[test]
    fn a_year_is_written_once() {
        assert_eq!(dedupe_year("Aliens (1986) (1986)"), "Aliens (1986)");
        assert_eq!(dedupe_year("Alien - Covenant (2017) (2017)"), "Alien - Covenant (2017)");
        assert_eq!(dedupe_year("Prometheus (2012) (2012).mkv"), "Prometheus (2012).mkv");
        assert_eq!(dedupe_year("Dune (1984) (2021)"), "Dune (1984) (2021)");
        assert_eq!(finalize_component("Aliens (1986)  (1986)"), "Aliens (1986)");
        assert!(is_messy("Aliens (1986) (1986)"));
        assert_eq!(title_without_year("Prometheus (2012)", Some(2012)), "Prometheus");
        assert_eq!(title_without_year("Blade Runner 2049", Some(2017)), "Blade Runner 2049");
        assert_eq!(title_without_year("1917", Some(1917)), "1917");
    }

    #[test]
    fn fuller_titles() {
        assert_eq!(fuller_title("Star Wars", "Star Wars Episode IV - A New Hope"), "Star Wars Episode IV - A New Hope");
        assert_eq!(fuller_title("Dune: Part Two", "Dune Part Two"), "Dune: Part Two");
        assert_eq!(fuller_title("Alien", "Aliens"), "Alien");
        assert_eq!(fuller_title("Heat", "heat extra words"), "Heat");
    }

    #[test]
    fn release_season_folders() {
        assert_eq!(season_from_dir("You.SEASON.03.S03.COMPLETE.1080p.10bit.WEBRip.6CH.x265.HEVC-PSA"), Some(3));
        assert_eq!(season_from_dir("You.SEASON.01.S01.COMPLETE.1080p.WEB-DL.6CH.x265.HEVC-PSA"), Some(1));
        assert_eq!(season_from_dir("You.S05.1080p.WEBRip.10bit.DDP5.1.x265-HODL"), Some(5));
        assert_eq!(season_from_dir("You.S04.Complete.1080p.WEBRip.DDP5.1.H.265-HODL"), Some(4));
        assert_eq!(season_from_dir("YOU (2018) Season 02 S02 (1080p NF WEB-DL x265 HEVC 10bit AC3 5.1 Qman) [UTR]"), Some(2));
        assert_eq!(season_from_dir("Season 2"), Some(2));
        assert_eq!(season_from_dir("You.S01E01.1080p"), None);
        assert_eq!(season_from_dir("Show.S01-S03.1080p"), None);
        assert_eq!(season_from_dir("Extras"), None);
        assert!(!is_messy("Bluey"));
    }

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

/// Accented letters as base letter + accent mark (what macOS and many NAS shares store), for
/// comparing names: "Léon" typed one way and "Léon" stored the other way are the same file.
static DECOMPOSED: &[(char, &str)] = &[
    ('\u{00C0}', "\u{0041}\u{0300}"),
    ('\u{00C1}', "\u{0041}\u{0301}"),
    ('\u{00C2}', "\u{0041}\u{0302}"),
    ('\u{00C3}', "\u{0041}\u{0303}"),
    ('\u{00C4}', "\u{0041}\u{0308}"),
    ('\u{00C5}', "\u{0041}\u{030A}"),
    ('\u{00C7}', "\u{0043}\u{0327}"),
    ('\u{00C8}', "\u{0045}\u{0300}"),
    ('\u{00C9}', "\u{0045}\u{0301}"),
    ('\u{00CA}', "\u{0045}\u{0302}"),
    ('\u{00CB}', "\u{0045}\u{0308}"),
    ('\u{00CC}', "\u{0049}\u{0300}"),
    ('\u{00CD}', "\u{0049}\u{0301}"),
    ('\u{00CE}', "\u{0049}\u{0302}"),
    ('\u{00CF}', "\u{0049}\u{0308}"),
    ('\u{00D1}', "\u{004E}\u{0303}"),
    ('\u{00D2}', "\u{004F}\u{0300}"),
    ('\u{00D3}', "\u{004F}\u{0301}"),
    ('\u{00D4}', "\u{004F}\u{0302}"),
    ('\u{00D5}', "\u{004F}\u{0303}"),
    ('\u{00D6}', "\u{004F}\u{0308}"),
    ('\u{00D9}', "\u{0055}\u{0300}"),
    ('\u{00DA}', "\u{0055}\u{0301}"),
    ('\u{00DB}', "\u{0055}\u{0302}"),
    ('\u{00DC}', "\u{0055}\u{0308}"),
    ('\u{00DD}', "\u{0059}\u{0301}"),
    ('\u{00E0}', "\u{0061}\u{0300}"),
    ('\u{00E1}', "\u{0061}\u{0301}"),
    ('\u{00E2}', "\u{0061}\u{0302}"),
    ('\u{00E3}', "\u{0061}\u{0303}"),
    ('\u{00E4}', "\u{0061}\u{0308}"),
    ('\u{00E5}', "\u{0061}\u{030A}"),
    ('\u{00E7}', "\u{0063}\u{0327}"),
    ('\u{00E8}', "\u{0065}\u{0300}"),
    ('\u{00E9}', "\u{0065}\u{0301}"),
    ('\u{00EA}', "\u{0065}\u{0302}"),
    ('\u{00EB}', "\u{0065}\u{0308}"),
    ('\u{00EC}', "\u{0069}\u{0300}"),
    ('\u{00ED}', "\u{0069}\u{0301}"),
    ('\u{00EE}', "\u{0069}\u{0302}"),
    ('\u{00EF}', "\u{0069}\u{0308}"),
    ('\u{00F1}', "\u{006E}\u{0303}"),
    ('\u{00F2}', "\u{006F}\u{0300}"),
    ('\u{00F3}', "\u{006F}\u{0301}"),
    ('\u{00F4}', "\u{006F}\u{0302}"),
    ('\u{00F5}', "\u{006F}\u{0303}"),
    ('\u{00F6}', "\u{006F}\u{0308}"),
    ('\u{00F9}', "\u{0075}\u{0300}"),
    ('\u{00FA}', "\u{0075}\u{0301}"),
    ('\u{00FB}', "\u{0075}\u{0302}"),
    ('\u{00FC}', "\u{0075}\u{0308}"),
    ('\u{00FD}', "\u{0079}\u{0301}"),
    ('\u{00FF}', "\u{0079}\u{0308}"),
    ('\u{0100}', "\u{0041}\u{0304}"),
    ('\u{0101}', "\u{0061}\u{0304}"),
    ('\u{0102}', "\u{0041}\u{0306}"),
    ('\u{0103}', "\u{0061}\u{0306}"),
    ('\u{0104}', "\u{0041}\u{0328}"),
    ('\u{0105}', "\u{0061}\u{0328}"),
    ('\u{0106}', "\u{0043}\u{0301}"),
    ('\u{0107}', "\u{0063}\u{0301}"),
    ('\u{0108}', "\u{0043}\u{0302}"),
    ('\u{0109}', "\u{0063}\u{0302}"),
    ('\u{010A}', "\u{0043}\u{0307}"),
    ('\u{010B}', "\u{0063}\u{0307}"),
    ('\u{010C}', "\u{0043}\u{030C}"),
    ('\u{010D}', "\u{0063}\u{030C}"),
    ('\u{010E}', "\u{0044}\u{030C}"),
    ('\u{010F}', "\u{0064}\u{030C}"),
    ('\u{0112}', "\u{0045}\u{0304}"),
    ('\u{0113}', "\u{0065}\u{0304}"),
    ('\u{0114}', "\u{0045}\u{0306}"),
    ('\u{0115}', "\u{0065}\u{0306}"),
    ('\u{0116}', "\u{0045}\u{0307}"),
    ('\u{0117}', "\u{0065}\u{0307}"),
    ('\u{0118}', "\u{0045}\u{0328}"),
    ('\u{0119}', "\u{0065}\u{0328}"),
    ('\u{011A}', "\u{0045}\u{030C}"),
    ('\u{011B}', "\u{0065}\u{030C}"),
    ('\u{011C}', "\u{0047}\u{0302}"),
    ('\u{011D}', "\u{0067}\u{0302}"),
    ('\u{011E}', "\u{0047}\u{0306}"),
    ('\u{011F}', "\u{0067}\u{0306}"),
    ('\u{0120}', "\u{0047}\u{0307}"),
    ('\u{0121}', "\u{0067}\u{0307}"),
    ('\u{0122}', "\u{0047}\u{0327}"),
    ('\u{0123}', "\u{0067}\u{0327}"),
    ('\u{0124}', "\u{0048}\u{0302}"),
    ('\u{0125}', "\u{0068}\u{0302}"),
    ('\u{0128}', "\u{0049}\u{0303}"),
    ('\u{0129}', "\u{0069}\u{0303}"),
    ('\u{012A}', "\u{0049}\u{0304}"),
    ('\u{012B}', "\u{0069}\u{0304}"),
    ('\u{012C}', "\u{0049}\u{0306}"),
    ('\u{012D}', "\u{0069}\u{0306}"),
    ('\u{012E}', "\u{0049}\u{0328}"),
    ('\u{012F}', "\u{0069}\u{0328}"),
    ('\u{0130}', "\u{0049}\u{0307}"),
    ('\u{0134}', "\u{004A}\u{0302}"),
    ('\u{0135}', "\u{006A}\u{0302}"),
    ('\u{0136}', "\u{004B}\u{0327}"),
    ('\u{0137}', "\u{006B}\u{0327}"),
    ('\u{0139}', "\u{004C}\u{0301}"),
    ('\u{013A}', "\u{006C}\u{0301}"),
    ('\u{013B}', "\u{004C}\u{0327}"),
    ('\u{013C}', "\u{006C}\u{0327}"),
    ('\u{013D}', "\u{004C}\u{030C}"),
    ('\u{013E}', "\u{006C}\u{030C}"),
    ('\u{0143}', "\u{004E}\u{0301}"),
    ('\u{0144}', "\u{006E}\u{0301}"),
    ('\u{0145}', "\u{004E}\u{0327}"),
    ('\u{0146}', "\u{006E}\u{0327}"),
    ('\u{0147}', "\u{004E}\u{030C}"),
    ('\u{0148}', "\u{006E}\u{030C}"),
    ('\u{014C}', "\u{004F}\u{0304}"),
    ('\u{014D}', "\u{006F}\u{0304}"),
    ('\u{014E}', "\u{004F}\u{0306}"),
    ('\u{014F}', "\u{006F}\u{0306}"),
    ('\u{0150}', "\u{004F}\u{030B}"),
    ('\u{0151}', "\u{006F}\u{030B}"),
    ('\u{0154}', "\u{0052}\u{0301}"),
    ('\u{0155}', "\u{0072}\u{0301}"),
    ('\u{0156}', "\u{0052}\u{0327}"),
    ('\u{0157}', "\u{0072}\u{0327}"),
    ('\u{0158}', "\u{0052}\u{030C}"),
    ('\u{0159}', "\u{0072}\u{030C}"),
    ('\u{015A}', "\u{0053}\u{0301}"),
    ('\u{015B}', "\u{0073}\u{0301}"),
    ('\u{015C}', "\u{0053}\u{0302}"),
    ('\u{015D}', "\u{0073}\u{0302}"),
    ('\u{015E}', "\u{0053}\u{0327}"),
    ('\u{015F}', "\u{0073}\u{0327}"),
    ('\u{0160}', "\u{0053}\u{030C}"),
    ('\u{0161}', "\u{0073}\u{030C}"),
    ('\u{0162}', "\u{0054}\u{0327}"),
    ('\u{0163}', "\u{0074}\u{0327}"),
    ('\u{0164}', "\u{0054}\u{030C}"),
    ('\u{0165}', "\u{0074}\u{030C}"),
    ('\u{0168}', "\u{0055}\u{0303}"),
    ('\u{0169}', "\u{0075}\u{0303}"),
    ('\u{016A}', "\u{0055}\u{0304}"),
    ('\u{016B}', "\u{0075}\u{0304}"),
    ('\u{016C}', "\u{0055}\u{0306}"),
    ('\u{016D}', "\u{0075}\u{0306}"),
    ('\u{016E}', "\u{0055}\u{030A}"),
    ('\u{016F}', "\u{0075}\u{030A}"),
    ('\u{0170}', "\u{0055}\u{030B}"),
    ('\u{0171}', "\u{0075}\u{030B}"),
    ('\u{0172}', "\u{0055}\u{0328}"),
    ('\u{0173}', "\u{0075}\u{0328}"),
    ('\u{0174}', "\u{0057}\u{0302}"),
    ('\u{0175}', "\u{0077}\u{0302}"),
    ('\u{0176}', "\u{0059}\u{0302}"),
    ('\u{0177}', "\u{0079}\u{0302}"),
    ('\u{0178}', "\u{0059}\u{0308}"),
    ('\u{0179}', "\u{005A}\u{0301}"),
    ('\u{017A}', "\u{007A}\u{0301}"),
    ('\u{017B}', "\u{005A}\u{0307}"),
    ('\u{017C}', "\u{007A}\u{0307}"),
    ('\u{017D}', "\u{005A}\u{030C}"),
    ('\u{017E}', "\u{007A}\u{030C}"),
    ('\u{1E00}', "\u{0041}\u{0325}"),
    ('\u{1E01}', "\u{0061}\u{0325}"),
    ('\u{1E02}', "\u{0042}\u{0307}"),
    ('\u{1E03}', "\u{0062}\u{0307}"),
    ('\u{1E04}', "\u{0042}\u{0323}"),
    ('\u{1E05}', "\u{0062}\u{0323}"),
    ('\u{1E06}', "\u{0042}\u{0331}"),
    ('\u{1E07}', "\u{0062}\u{0331}"),
    ('\u{1E08}', "\u{0043}\u{0327}\u{0301}"),
    ('\u{1E09}', "\u{0063}\u{0327}\u{0301}"),
    ('\u{1E0A}', "\u{0044}\u{0307}"),
    ('\u{1E0B}', "\u{0064}\u{0307}"),
    ('\u{1E0C}', "\u{0044}\u{0323}"),
    ('\u{1E0D}', "\u{0064}\u{0323}"),
    ('\u{1E0E}', "\u{0044}\u{0331}"),
    ('\u{1E0F}', "\u{0064}\u{0331}"),
    ('\u{1E10}', "\u{0044}\u{0327}"),
    ('\u{1E11}', "\u{0064}\u{0327}"),
    ('\u{1E12}', "\u{0044}\u{032D}"),
    ('\u{1E13}', "\u{0064}\u{032D}"),
    ('\u{1E14}', "\u{0045}\u{0304}\u{0300}"),
    ('\u{1E15}', "\u{0065}\u{0304}\u{0300}"),
    ('\u{1E16}', "\u{0045}\u{0304}\u{0301}"),
    ('\u{1E17}', "\u{0065}\u{0304}\u{0301}"),
    ('\u{1E18}', "\u{0045}\u{032D}"),
    ('\u{1E19}', "\u{0065}\u{032D}"),
    ('\u{1E1A}', "\u{0045}\u{0330}"),
    ('\u{1E1B}', "\u{0065}\u{0330}"),
    ('\u{1E1C}', "\u{0045}\u{0327}\u{0306}"),
    ('\u{1E1D}', "\u{0065}\u{0327}\u{0306}"),
    ('\u{1E1E}', "\u{0046}\u{0307}"),
    ('\u{1E1F}', "\u{0066}\u{0307}"),
    ('\u{1E20}', "\u{0047}\u{0304}"),
    ('\u{1E21}', "\u{0067}\u{0304}"),
    ('\u{1E22}', "\u{0048}\u{0307}"),
    ('\u{1E23}', "\u{0068}\u{0307}"),
    ('\u{1E24}', "\u{0048}\u{0323}"),
    ('\u{1E25}', "\u{0068}\u{0323}"),
    ('\u{1E26}', "\u{0048}\u{0308}"),
    ('\u{1E27}', "\u{0068}\u{0308}"),
    ('\u{1E28}', "\u{0048}\u{0327}"),
    ('\u{1E29}', "\u{0068}\u{0327}"),
    ('\u{1E2A}', "\u{0048}\u{032E}"),
    ('\u{1E2B}', "\u{0068}\u{032E}"),
    ('\u{1E2C}', "\u{0049}\u{0330}"),
    ('\u{1E2D}', "\u{0069}\u{0330}"),
    ('\u{1E2E}', "\u{0049}\u{0308}\u{0301}"),
    ('\u{1E2F}', "\u{0069}\u{0308}\u{0301}"),
    ('\u{1E30}', "\u{004B}\u{0301}"),
    ('\u{1E31}', "\u{006B}\u{0301}"),
    ('\u{1E32}', "\u{004B}\u{0323}"),
    ('\u{1E33}', "\u{006B}\u{0323}"),
    ('\u{1E34}', "\u{004B}\u{0331}"),
    ('\u{1E35}', "\u{006B}\u{0331}"),
    ('\u{1E36}', "\u{004C}\u{0323}"),
    ('\u{1E37}', "\u{006C}\u{0323}"),
    ('\u{1E38}', "\u{004C}\u{0323}\u{0304}"),
    ('\u{1E39}', "\u{006C}\u{0323}\u{0304}"),
    ('\u{1E3A}', "\u{004C}\u{0331}"),
    ('\u{1E3B}', "\u{006C}\u{0331}"),
    ('\u{1E3C}', "\u{004C}\u{032D}"),
    ('\u{1E3D}', "\u{006C}\u{032D}"),
    ('\u{1E3E}', "\u{004D}\u{0301}"),
    ('\u{1E3F}', "\u{006D}\u{0301}"),
    ('\u{1E40}', "\u{004D}\u{0307}"),
    ('\u{1E41}', "\u{006D}\u{0307}"),
    ('\u{1E42}', "\u{004D}\u{0323}"),
    ('\u{1E43}', "\u{006D}\u{0323}"),
    ('\u{1E44}', "\u{004E}\u{0307}"),
    ('\u{1E45}', "\u{006E}\u{0307}"),
    ('\u{1E46}', "\u{004E}\u{0323}"),
    ('\u{1E47}', "\u{006E}\u{0323}"),
    ('\u{1E48}', "\u{004E}\u{0331}"),
    ('\u{1E49}', "\u{006E}\u{0331}"),
    ('\u{1E4A}', "\u{004E}\u{032D}"),
    ('\u{1E4B}', "\u{006E}\u{032D}"),
    ('\u{1E4C}', "\u{004F}\u{0303}\u{0301}"),
    ('\u{1E4D}', "\u{006F}\u{0303}\u{0301}"),
    ('\u{1E4E}', "\u{004F}\u{0303}\u{0308}"),
    ('\u{1E4F}', "\u{006F}\u{0303}\u{0308}"),
    ('\u{1E50}', "\u{004F}\u{0304}\u{0300}"),
    ('\u{1E51}', "\u{006F}\u{0304}\u{0300}"),
    ('\u{1E52}', "\u{004F}\u{0304}\u{0301}"),
    ('\u{1E53}', "\u{006F}\u{0304}\u{0301}"),
    ('\u{1E54}', "\u{0050}\u{0301}"),
    ('\u{1E55}', "\u{0070}\u{0301}"),
    ('\u{1E56}', "\u{0050}\u{0307}"),
    ('\u{1E57}', "\u{0070}\u{0307}"),
    ('\u{1E58}', "\u{0052}\u{0307}"),
    ('\u{1E59}', "\u{0072}\u{0307}"),
    ('\u{1E5A}', "\u{0052}\u{0323}"),
    ('\u{1E5B}', "\u{0072}\u{0323}"),
    ('\u{1E5C}', "\u{0052}\u{0323}\u{0304}"),
    ('\u{1E5D}', "\u{0072}\u{0323}\u{0304}"),
    ('\u{1E5E}', "\u{0052}\u{0331}"),
    ('\u{1E5F}', "\u{0072}\u{0331}"),
    ('\u{1E60}', "\u{0053}\u{0307}"),
    ('\u{1E61}', "\u{0073}\u{0307}"),
    ('\u{1E62}', "\u{0053}\u{0323}"),
    ('\u{1E63}', "\u{0073}\u{0323}"),
    ('\u{1E64}', "\u{0053}\u{0301}\u{0307}"),
    ('\u{1E65}', "\u{0073}\u{0301}\u{0307}"),
    ('\u{1E66}', "\u{0053}\u{030C}\u{0307}"),
    ('\u{1E67}', "\u{0073}\u{030C}\u{0307}"),
    ('\u{1E68}', "\u{0053}\u{0323}\u{0307}"),
    ('\u{1E69}', "\u{0073}\u{0323}\u{0307}"),
    ('\u{1E6A}', "\u{0054}\u{0307}"),
    ('\u{1E6B}', "\u{0074}\u{0307}"),
    ('\u{1E6C}', "\u{0054}\u{0323}"),
    ('\u{1E6D}', "\u{0074}\u{0323}"),
    ('\u{1E6E}', "\u{0054}\u{0331}"),
    ('\u{1E6F}', "\u{0074}\u{0331}"),
    ('\u{1E70}', "\u{0054}\u{032D}"),
    ('\u{1E71}', "\u{0074}\u{032D}"),
    ('\u{1E72}', "\u{0055}\u{0324}"),
    ('\u{1E73}', "\u{0075}\u{0324}"),
    ('\u{1E74}', "\u{0055}\u{0330}"),
    ('\u{1E75}', "\u{0075}\u{0330}"),
    ('\u{1E76}', "\u{0055}\u{032D}"),
    ('\u{1E77}', "\u{0075}\u{032D}"),
    ('\u{1E78}', "\u{0055}\u{0303}\u{0301}"),
    ('\u{1E79}', "\u{0075}\u{0303}\u{0301}"),
    ('\u{1E7A}', "\u{0055}\u{0304}\u{0308}"),
    ('\u{1E7B}', "\u{0075}\u{0304}\u{0308}"),
    ('\u{1E7C}', "\u{0056}\u{0303}"),
    ('\u{1E7D}', "\u{0076}\u{0303}"),
    ('\u{1E7E}', "\u{0056}\u{0323}"),
    ('\u{1E7F}', "\u{0076}\u{0323}"),
    ('\u{1E80}', "\u{0057}\u{0300}"),
    ('\u{1E81}', "\u{0077}\u{0300}"),
    ('\u{1E82}', "\u{0057}\u{0301}"),
    ('\u{1E83}', "\u{0077}\u{0301}"),
    ('\u{1E84}', "\u{0057}\u{0308}"),
    ('\u{1E85}', "\u{0077}\u{0308}"),
    ('\u{1E86}', "\u{0057}\u{0307}"),
    ('\u{1E87}', "\u{0077}\u{0307}"),
    ('\u{1E88}', "\u{0057}\u{0323}"),
    ('\u{1E89}', "\u{0077}\u{0323}"),
    ('\u{1E8A}', "\u{0058}\u{0307}"),
    ('\u{1E8B}', "\u{0078}\u{0307}"),
    ('\u{1E8C}', "\u{0058}\u{0308}"),
    ('\u{1E8D}', "\u{0078}\u{0308}"),
    ('\u{1E8E}', "\u{0059}\u{0307}"),
    ('\u{1E8F}', "\u{0079}\u{0307}"),
    ('\u{1E90}', "\u{005A}\u{0302}"),
    ('\u{1E91}', "\u{007A}\u{0302}"),
    ('\u{1E92}', "\u{005A}\u{0323}"),
    ('\u{1E93}', "\u{007A}\u{0323}"),
    ('\u{1E94}', "\u{005A}\u{0331}"),
    ('\u{1E95}', "\u{007A}\u{0331}"),
    ('\u{1E96}', "\u{0068}\u{0331}"),
    ('\u{1E97}', "\u{0074}\u{0308}"),
    ('\u{1E98}', "\u{0077}\u{030A}"),
    ('\u{1E99}', "\u{0079}\u{030A}"),
    ('\u{1E9B}', "\u{017F}\u{0307}"),
    ('\u{1EA0}', "\u{0041}\u{0323}"),
    ('\u{1EA1}', "\u{0061}\u{0323}"),
    ('\u{1EA2}', "\u{0041}\u{0309}"),
    ('\u{1EA3}', "\u{0061}\u{0309}"),
    ('\u{1EA4}', "\u{0041}\u{0302}\u{0301}"),
    ('\u{1EA5}', "\u{0061}\u{0302}\u{0301}"),
    ('\u{1EA6}', "\u{0041}\u{0302}\u{0300}"),
    ('\u{1EA7}', "\u{0061}\u{0302}\u{0300}"),
    ('\u{1EA8}', "\u{0041}\u{0302}\u{0309}"),
    ('\u{1EA9}', "\u{0061}\u{0302}\u{0309}"),
    ('\u{1EAA}', "\u{0041}\u{0302}\u{0303}"),
    ('\u{1EAB}', "\u{0061}\u{0302}\u{0303}"),
    ('\u{1EAC}', "\u{0041}\u{0323}\u{0302}"),
    ('\u{1EAD}', "\u{0061}\u{0323}\u{0302}"),
    ('\u{1EAE}', "\u{0041}\u{0306}\u{0301}"),
    ('\u{1EAF}', "\u{0061}\u{0306}\u{0301}"),
    ('\u{1EB0}', "\u{0041}\u{0306}\u{0300}"),
    ('\u{1EB1}', "\u{0061}\u{0306}\u{0300}"),
    ('\u{1EB2}', "\u{0041}\u{0306}\u{0309}"),
    ('\u{1EB3}', "\u{0061}\u{0306}\u{0309}"),
    ('\u{1EB4}', "\u{0041}\u{0306}\u{0303}"),
    ('\u{1EB5}', "\u{0061}\u{0306}\u{0303}"),
    ('\u{1EB6}', "\u{0041}\u{0323}\u{0306}"),
    ('\u{1EB7}', "\u{0061}\u{0323}\u{0306}"),
    ('\u{1EB8}', "\u{0045}\u{0323}"),
    ('\u{1EB9}', "\u{0065}\u{0323}"),
    ('\u{1EBA}', "\u{0045}\u{0309}"),
    ('\u{1EBB}', "\u{0065}\u{0309}"),
    ('\u{1EBC}', "\u{0045}\u{0303}"),
    ('\u{1EBD}', "\u{0065}\u{0303}"),
    ('\u{1EBE}', "\u{0045}\u{0302}\u{0301}"),
    ('\u{1EBF}', "\u{0065}\u{0302}\u{0301}"),
    ('\u{1EC0}', "\u{0045}\u{0302}\u{0300}"),
    ('\u{1EC1}', "\u{0065}\u{0302}\u{0300}"),
    ('\u{1EC2}', "\u{0045}\u{0302}\u{0309}"),
    ('\u{1EC3}', "\u{0065}\u{0302}\u{0309}"),
    ('\u{1EC4}', "\u{0045}\u{0302}\u{0303}"),
    ('\u{1EC5}', "\u{0065}\u{0302}\u{0303}"),
    ('\u{1EC6}', "\u{0045}\u{0323}\u{0302}"),
    ('\u{1EC7}', "\u{0065}\u{0323}\u{0302}"),
    ('\u{1EC8}', "\u{0049}\u{0309}"),
    ('\u{1EC9}', "\u{0069}\u{0309}"),
    ('\u{1ECA}', "\u{0049}\u{0323}"),
    ('\u{1ECB}', "\u{0069}\u{0323}"),
    ('\u{1ECC}', "\u{004F}\u{0323}"),
    ('\u{1ECD}', "\u{006F}\u{0323}"),
    ('\u{1ECE}', "\u{004F}\u{0309}"),
    ('\u{1ECF}', "\u{006F}\u{0309}"),
    ('\u{1ED0}', "\u{004F}\u{0302}\u{0301}"),
    ('\u{1ED1}', "\u{006F}\u{0302}\u{0301}"),
    ('\u{1ED2}', "\u{004F}\u{0302}\u{0300}"),
    ('\u{1ED3}', "\u{006F}\u{0302}\u{0300}"),
    ('\u{1ED4}', "\u{004F}\u{0302}\u{0309}"),
    ('\u{1ED5}', "\u{006F}\u{0302}\u{0309}"),
    ('\u{1ED6}', "\u{004F}\u{0302}\u{0303}"),
    ('\u{1ED7}', "\u{006F}\u{0302}\u{0303}"),
    ('\u{1ED8}', "\u{004F}\u{0323}\u{0302}"),
    ('\u{1ED9}', "\u{006F}\u{0323}\u{0302}"),
    ('\u{1EDA}', "\u{004F}\u{031B}\u{0301}"),
    ('\u{1EDB}', "\u{006F}\u{031B}\u{0301}"),
    ('\u{1EDC}', "\u{004F}\u{031B}\u{0300}"),
    ('\u{1EDD}', "\u{006F}\u{031B}\u{0300}"),
    ('\u{1EDE}', "\u{004F}\u{031B}\u{0309}"),
    ('\u{1EDF}', "\u{006F}\u{031B}\u{0309}"),
    ('\u{1EE0}', "\u{004F}\u{031B}\u{0303}"),
    ('\u{1EE1}', "\u{006F}\u{031B}\u{0303}"),
    ('\u{1EE2}', "\u{004F}\u{031B}\u{0323}"),
    ('\u{1EE3}', "\u{006F}\u{031B}\u{0323}"),
    ('\u{1EE4}', "\u{0055}\u{0323}"),
    ('\u{1EE5}', "\u{0075}\u{0323}"),
    ('\u{1EE6}', "\u{0055}\u{0309}"),
    ('\u{1EE7}', "\u{0075}\u{0309}"),
    ('\u{1EE8}', "\u{0055}\u{031B}\u{0301}"),
    ('\u{1EE9}', "\u{0075}\u{031B}\u{0301}"),
    ('\u{1EEA}', "\u{0055}\u{031B}\u{0300}"),
    ('\u{1EEB}', "\u{0075}\u{031B}\u{0300}"),
    ('\u{1EEC}', "\u{0055}\u{031B}\u{0309}"),
    ('\u{1EED}', "\u{0075}\u{031B}\u{0309}"),
    ('\u{1EEE}', "\u{0055}\u{031B}\u{0303}"),
    ('\u{1EEF}', "\u{0075}\u{031B}\u{0303}"),
    ('\u{1EF0}', "\u{0055}\u{031B}\u{0323}"),
    ('\u{1EF1}', "\u{0075}\u{031B}\u{0323}"),
    ('\u{1EF2}', "\u{0059}\u{0300}"),
    ('\u{1EF3}', "\u{0079}\u{0300}"),
    ('\u{1EF4}', "\u{0059}\u{0323}"),
    ('\u{1EF5}', "\u{0079}\u{0323}"),
    ('\u{1EF6}', "\u{0059}\u{0309}"),
    ('\u{1EF7}', "\u{0079}\u{0309}"),
    ('\u{1EF8}', "\u{0059}\u{0303}"),
    ('\u{1EF9}', "\u{0079}\u{0303}")
];

/// A name in one fixed form, so two spellings of the same accented name compare equal.
pub fn same_form(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match DECOMPOSED.binary_search_by(|(k, _)| k.cmp(&c)) {
            Ok(i) => out.push_str(DECOMPOSED[i].1),
            Err(_) => out.push(c),
        }
    }
    out
}
