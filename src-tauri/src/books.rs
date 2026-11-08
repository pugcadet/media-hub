//! Ebooks: the books in the library's Ebooks folder, matched with Open Library (free, no key).
//!
//! Jellyfin reads a book's details from a `metadata.opf` next to it and its cover from
//! `cover.jpg`, and wants every book in a folder of its own. Saving a match does exactly that:
//! the book file itself is never changed. Everything goes into History; Undo moves the book
//! back and puts the added files in the trash folder.

use crate::error::{Error, Result};
use crate::fsops::{safe_rel, with_timeout};
use crate::local;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::State;

pub const BOOK_EXTS: &[&str] = &["epub", "pdf", "mobi", "azw", "azw3", "cbz", "cbr", "cb7", "cbt"];
/// Folder names (in the library folder) taken for the books, first match wins.
const FOLDER_NAMES: &[&str] = &["ebooks", "e-books", "books", "boeken", "ebook"];
const COVER_NAMES: &[&str] = &["cover", "folder", "poster"];
const PIC_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/* ------------------------------------------------------------- the folder */

/// The books folder inside the library folder (rel name), e.g. "Ebooks".
pub fn books_folder(root: &Path) -> Option<String> {
    let mut found: Vec<String> = std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| FOLDER_NAMES.contains(&n.to_lowercase().as_str()))
        .collect();
    found.sort_by_key(|n| FOLDER_NAMES.iter().position(|f| *f == n.to_lowercase()).unwrap_or(99));
    found.into_iter().next()
}

fn is_book(name: &str) -> bool {
    name.rsplit_once('.').map(|(_, e)| BOOK_EXTS.contains(&e.to_lowercase().as_str())).unwrap_or(false)
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('@') || name == "#recycle" || name == crate::storage::TRASH
}

/// Every book file under `dir`, at most 5 folders deep.
fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if depth < 5 && !skip_dir(&name) {
                walk(&e.path(), depth + 1, out);
            }
        } else if ft.is_file() && !name.starts_with('.') && is_book(&name) {
            out.push(e.path());
        }
    }
}

/* ------------------------------------------------- what the file says */

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub isbn: Option<String>,
    pub language: Option<String>,
}

fn unescape(s: &str) -> String {
    let s = s.replace("<![CDATA[", "").replace("]]>", "");
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&#39;", "'").replace("&amp;", "&").trim().to_string()
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Text of every `<dc:name …>…</dc:name>` (also without the `dc:` prefix).
fn tags(xml: &str, name: &str) -> Vec<String> {
    let re = regex::Regex::new(&format!(r"(?is)<(?:dc:)?{name}\b([^>]*)>(.*?)</(?:dc:)?{name}>")).expect("regex");
    re.captures_iter(xml).map(|c| unescape(&c[2])).filter(|t| !t.is_empty()).collect()
}

/// The details in an OPF file (inside an EPUB, or a `metadata.opf` next to a book).
pub fn parse_opf(xml: &str) -> Meta {
    let year = tags(xml, "date").iter().find_map(|d| d.get(0..4).and_then(|y| y.parse::<u32>().ok())).filter(|y| (1400..2100).contains(y));
    let isbn = {
        let re = regex::Regex::new(r"(?is)<(?:dc:)?identifier\b([^>]*)>(.*?)</(?:dc:)?identifier>").expect("regex");
        let found = re.captures_iter(xml).find_map(|c| {
            let attrs = c[1].to_lowercase();
            let v: String = unescape(&c[2]).chars().filter(|ch| ch.is_ascii_digit() || *ch == 'X' || *ch == 'x').collect();
            let looks = v.len() == 13 || v.len() == 10;
            (looks && (attrs.contains("isbn") || c[2].to_lowercase().contains("isbn") || v.starts_with("978") || v.starts_with("979"))).then(|| v.to_uppercase())
        });
        found
    };
    Meta {
        title: tags(xml, "title").into_iter().next().unwrap_or_default(),
        authors: tags(xml, "creator"),
        year,
        isbn,
        language: tags(xml, "language").into_iter().next(),
    }
}

/// One file out of a zip (an EPUB), read from the end of the file: no need to read it all.
fn zip_entry(path: &Path, want: &dyn Fn(&str) -> bool) -> Option<(String, Vec<u8>)> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let tail = len.min(66_000);
    f.seek(SeekFrom::Start(len - tail)).ok()?;
    let mut buf = vec![0u8; tail as usize];
    f.read_exact(&mut buf).ok()?;
    let eocd = (0..buf.len().saturating_sub(21)).rev().find(|&i| buf[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])?;
    let u16at = |b: &[u8], i: usize| u16::from_le_bytes([b[i], b[i + 1]]) as usize;
    let u32at = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as u64;
    let cd_size = u32at(&buf, eocd + 12);
    let cd_off = u32at(&buf, eocd + 16);
    if cd_size > 8_000_000 || cd_off + cd_size > len {
        return None;
    }
    let mut cd = vec![0u8; cd_size as usize];
    f.seek(SeekFrom::Start(cd_off)).ok()?;
    f.read_exact(&mut cd).ok()?;
    let mut i = 0;
    while i + 46 <= cd.len() && cd[i..i + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let method = u16at(&cd, i + 10);
        let csize = u32at(&cd, i + 20);
        let usize_ = u32at(&cd, i + 24);
        let (nlen, xlen, clen) = (u16at(&cd, i + 28), u16at(&cd, i + 30), u16at(&cd, i + 32));
        let local = u32at(&cd, i + 42);
        let name = String::from_utf8_lossy(cd.get(i + 46..i + 46 + nlen)?).into_owned();
        i += 46 + nlen + xlen + clen;
        if !want(&name) {
            continue;
        }
        if usize_ > 4_000_000 || csize > 4_000_000 {
            return None;
        }
        let mut lh = [0u8; 30];
        f.seek(SeekFrom::Start(local)).ok()?;
        f.read_exact(&mut lh).ok()?;
        if lh[0..4] != [0x50, 0x4b, 0x03, 0x04] {
            return None;
        }
        let skip = 30 + u16at(&lh, 26) + u16at(&lh, 28);
        f.seek(SeekFrom::Start(local + skip as u64)).ok()?;
        let mut raw = vec![0u8; csize as usize];
        f.read_exact(&mut raw).ok()?;
        let data = match method {
            0 => raw,
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(&raw[..]).take(4_000_000).read_to_end(&mut out).ok()?;
                out
            }
            _ => return None,
        };
        return Some((name, data));
    }
    None
}

/// The details written inside an EPUB.
pub fn epub_meta(path: &Path) -> Option<Meta> {
    let (_, container) = zip_entry(path, &|n| n.eq_ignore_ascii_case("META-INF/container.xml"))?;
    let c = String::from_utf8_lossy(&container);
    let opf = regex::Regex::new(r#"full-path\s*=\s*"([^"]+)""#).ok()?.captures(&c)?[1].to_string();
    let (_, xml) = zip_entry(path, &|n| n == opf)?;
    let m = parse_opf(&String::from_utf8_lossy(&xml));
    (!m.title.is_empty()).then_some(m)
}

/// "Andy_Weir-Project.Hail.Mary" → "Andy Weir - Project Hail Mary"; the best guess from a name.
pub fn name_guess(stem: &str) -> String {
    let s = stem.replace(['_', '.'], " ");
    let s = regex::Regex::new(r"(?i)\b(retail|ebook|epub|pdf|mobi|azw3?|v\d+|calibre)\b").expect("regex").replace_all(&s, " ");
    let s = regex::Regex::new(r"\s+").expect("regex").replace_all(&s, " ");
    s.trim().trim_matches(['-', ' ']).to_string()
}

/* ------------------------------------------------------------- the list */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Book {
    /// Path inside the library folder ("Ebooks/Author - Title/Title.epub").
    pub rel: String,
    pub file: String,
    pub ext: String,
    pub size: u64,
    pub meta: Meta,
    /// Where the details came from: "opf" (a metadata.opf next to it), "file" (inside the book), "name".
    pub from: &'static str,
    /// The only book in a folder of its own (Jellyfin wants that).
    pub own_folder: bool,
    pub has_cover: bool,
    pub has_opf: bool,
    /// Saved with Media Hub (or set up the same way): its own folder, details and cover.
    pub done: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookList {
    /// The books folder ("Ebooks"), or None when the library folder has none.
    pub folder: Option<String>,
    pub books: Vec<Book>,
}

type Cache = HashMap<PathBuf, (u64, u64, Option<Meta>)>;
fn epub_cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pic_in(dir: &Path) -> Option<PathBuf> {
    COVER_NAMES.iter().find_map(|n| PIC_EXTS.iter().map(|e| dir.join(format!("{n}.{e}"))).find(|p| p.is_file()))
}

fn opf_for(file: &Path) -> Option<PathBuf> {
    let dir = file.parent()?;
    let stem = file.file_stem()?.to_string_lossy().into_owned();
    [format!("{stem}.opf"), "metadata.opf".into(), "content.opf".into()].into_iter().map(|n| dir.join(n)).find(|p| p.is_file())
}

pub fn scan(root: &Path) -> BookList {
    let Some(folder) = books_folder(root) else { return BookList { folder: None, books: vec![] } };
    let base = root.join(&folder);
    let mut files = Vec::new();
    walk(&base, 0, &mut files);
    let mut per_dir: HashMap<PathBuf, usize> = HashMap::new();
    for f in &files {
        if let Some(d) = f.parent() {
            *per_dir.entry(d.to_path_buf()).or_default() += 1;
        }
    }
    let mut books: Vec<Book> = files
        .iter()
        .filter_map(|f| {
            let rel = local::rel_to_root(root, f)?;
            let file = f.file_name()?.to_string_lossy().into_owned();
            let ext = file.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default();
            let md = f.metadata().ok()?;
            let dir = f.parent()?;
            let own_folder = dir != base.as_path() && per_dir.get(dir).copied().unwrap_or(0) == 1;
            let opf = opf_for(f);
            let has_cover = own_folder && pic_in(dir).is_some();
            let (meta, from) = if let Some(m) = opf.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).map(|x| parse_opf(&x)).filter(|m| !m.title.is_empty()) {
                (m, "opf")
            } else if ext == "epub" {
                let mtime = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
                let cached = epub_cache().lock().ok().and_then(|c| c.get(f).filter(|e| e.0 == mtime && e.1 == md.len()).map(|e| e.2.clone()));
                let m = cached.unwrap_or_else(|| {
                    let m = epub_meta(f);
                    if let Ok(mut c) = epub_cache().lock() {
                        c.insert(f.clone(), (mtime, md.len(), m.clone()));
                    }
                    m
                });
                match m {
                    Some(m) => (m, "file"),
                    None => (Meta { title: name_guess(&file[..file.len() - ext.len() - 1]), ..Default::default() }, "name"),
                }
            } else {
                (Meta { title: name_guess(&file[..file.len() - ext.len() - 1]), ..Default::default() }, "name")
            };
            let has_opf = own_folder && opf.is_some();
            Some(Book { rel, file, ext, size: md.len(), meta, from, own_folder, has_cover, has_opf, done: own_folder && has_cover && has_opf })
        })
        .collect();
    books.sort_by_key(|b| b.meta.title.to_lowercase());
    BookList { folder: Some(folder), books }
}

#[tauri::command]
pub async fn books_list(state: State<'_, AppState>) -> Result<BookList> {
    let root = state.library_root()?;
    with_timeout(Duration::from_secs(90), move || Ok(scan(&root)))
}

/* --------------------------------------------------------- Open Library */

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookMatch {
    /// The Open Library work ("/works/OL27448W").
    pub key: String,
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub isbn: Option<String>,
    pub cover_id: Option<u64>,
    pub pages: Option<u32>,
    pub subjects: Vec<String>,
    pub languages: Vec<String>,
    pub publisher: Option<String>,
    pub editions: u32,
    /// Title and author both line up with what the file says.
    pub sure: bool,
}

fn web() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            // Open Library asks apps to say who they are.
            .user_agent(concat!("MediaHub/", env!("CARGO_PKG_VERSION"), " ( https://github.com/pugcadet/media-hub )"))
            .timeout(Duration::from_secs(20))
            .build()
            .expect("http client")
    })
}

async fn get_json(url: &str) -> Result<Value> {
    let r = web().get(url).send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if !r.status().is_success() {
        return Err(Error::msg(format!("Open Library didn't answer (error {}). Try again in a minute.", r.status().as_u16())));
    }
    r.json().await.map_err(|_| Error::msg("Open Library sent something unexpected."))
}

fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// Lower case letters and digits only, for comparing titles and names.
pub fn norm(s: &str) -> String {
    let s = s.to_lowercase();
    let s = s.split([':', '(', '[']).next().unwrap_or(&s).to_string();
    s.chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Does this match fit the book? Same title (or one the start of the other) and, when the
/// file names an author, one of the same authors.
pub fn is_sure(guess: &Meta, m: &BookMatch) -> bool {
    let (a, b) = (norm(&guess.title), norm(&m.title));
    if a.len() < 2 || b.len() < 2 {
        return false;
    }
    let title_ok = a == b || (a.starts_with(&b) && b.len() >= 6) || (b.starts_with(&a) && a.len() >= 6);
    let author_ok = guess.authors.iter().any(|g| m.authors.iter().any(|x| same_person(g, x)));
    title_ok && author_ok && !guess.authors.is_empty()
}

/// "Weir, Andy", "Andy Weir" and "A. Weir" are the same person: they share the surname.
fn same_person(a: &str, b: &str) -> bool {
    let words = |s: &str| -> Vec<String> { s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(String::from).collect() };
    let (wa, wb) = (words(a), words(b));
    wa.iter().any(|w| wb.contains(w))
}

pub fn parse_search(v: &Value, guess: &Meta) -> Vec<BookMatch> {
    let strs = |d: &Value, k: &str| -> Vec<String> { d.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
    let docs = v.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
    docs.iter()
        .filter_map(|d| {
            let key = d.get("key")?.as_str()?.to_string();
            let title = d.get("title")?.as_str()?.to_string();
            let isbns = strs(d, "isbn");
            let isbn = guess.isbn.clone().filter(|g| isbns.contains(g)).or_else(|| isbns.iter().find(|i| i.len() == 13).cloned()).or_else(|| isbns.first().cloned());
            let mut m = BookMatch {
                key,
                title,
                authors: strs(d, "author_name"),
                year: d.get("first_publish_year").and_then(Value::as_u64).map(|y| y as u32),
                isbn,
                cover_id: d.get("cover_i").and_then(Value::as_u64),
                pages: d.get("number_of_pages_median").and_then(Value::as_u64).map(|p| p as u32),
                subjects: strs(d, "subject").into_iter().take(6).collect(),
                languages: strs(d, "language").into_iter().take(4).collect(),
                publisher: strs(d, "publisher").into_iter().next(),
                editions: d.get("edition_count").and_then(Value::as_u64).unwrap_or(0) as u32,
                sure: false,
            };
            m.sure = is_sure(guess, &m) || guess.isbn.as_ref().is_some_and(|g| isbns.contains(g));
            Some(m)
        })
        .collect()
}

const FIELDS: &str = "key,title,author_name,first_publish_year,isbn,cover_i,number_of_pages_median,subject,language,publisher,edition_count";

/// Matches for a book: by ISBN when the file has one, else by title and author, else the text.
#[tauri::command]
pub async fn books_search(guess: Meta, text: Option<String>) -> Result<Vec<BookMatch>> {
    let text = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let digits: String = text.as_deref().unwrap_or("").chars().filter(|c| c.is_ascii_digit() || *c == 'X').collect();
    let url = if let Some(t) = &text {
        if digits.len() == 10 || digits.len() == 13 {
            format!("https://openlibrary.org/search.json?isbn={}&fields={FIELDS}&limit=10", enc(&digits))
        } else {
            format!("https://openlibrary.org/search.json?q={}&fields={FIELDS}&limit=10", enc(t))
        }
    } else if let Some(i) = &guess.isbn {
        format!("https://openlibrary.org/search.json?isbn={}&fields={FIELDS}&limit=10", enc(i))
    } else if let Some(a) = guess.authors.first() {
        format!("https://openlibrary.org/search.json?title={}&author={}&fields={FIELDS}&limit=10", enc(&guess.title), enc(a))
    } else {
        format!("https://openlibrary.org/search.json?q={}&fields={FIELDS}&limit=10", enc(&guess.title))
    };
    let mut found = parse_search(&get_json(&url).await?, &guess);
    // Nothing by ISBN or title+author: try the plain words once.
    if found.is_empty() && text.is_none() {
        let words = [guess.title.clone(), guess.authors.first().cloned().unwrap_or_default()].join(" ");
        found = parse_search(&get_json(&format!("https://openlibrary.org/search.json?q={}&fields={FIELDS}&limit=10", enc(words.trim()))).await?, &guess);
    }
    found.sort_by_key(|m| (!m.sure, m.cover_id.is_none(), std::cmp::Reverse(m.editions)));
    Ok(found)
}

/// The description of a work ("/works/OL…W").
#[tauri::command]
pub async fn books_description(key: String) -> Result<Option<String>> {
    if !regex::Regex::new(r"^/works/OL\d+W$").expect("regex").is_match(&key) {
        return Err(Error::msg("Not an Open Library work."));
    }
    let v = get_json(&format!("https://openlibrary.org{key}.json")).await?;
    let d = v.get("description").and_then(|d| d.as_str().map(String::from).or_else(|| d.get("value").and_then(Value::as_str).map(String::from)));
    Ok(d.map(|d| d.split("\r\n----------").next().unwrap_or(&d).split("([source]").next().unwrap_or(&d).trim().to_string()).filter(|d| !d.is_empty()))
}

/* ------------------------------------------------------------- saving */

/// A file or folder name that works on Mac, Windows and the NAS.
pub fn clean_name(s: &str) -> String {
    let s: String = s.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { ' ' } else { c }).collect();
    let s = regex::Regex::new(r"\s+").expect("regex").replace_all(&s, " ");
    let s = s.trim().trim_end_matches('.').trim().to_string();
    s.chars().take(150).collect()
}

/// "Andy Weir - Project Hail Mary (2021)".
pub fn book_name(m: &BookMatch) -> String {
    let title = clean_name(&m.title);
    let base = match m.authors.first() {
        Some(a) if !a.trim().is_empty() => format!("{} - {title}", clean_name(a)),
        _ => title,
    };
    match m.year {
        Some(y) => format!("{base} ({y})"),
        None => base,
    }
}

pub fn opf_xml(m: &BookMatch, description: Option<&str>) -> String {
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"2.0\" unique-identifier=\"id\">\n  <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:opf=\"http://www.idpf.org/2007/opf\">\n");
    x += &format!("    <dc:title>{}</dc:title>\n", esc(&m.title));
    for a in &m.authors {
        x += &format!("    <dc:creator opf:role=\"aut\">{}</dc:creator>\n", esc(a));
    }
    if let Some(y) = m.year {
        x += &format!("    <dc:date>{y}</dc:date>\n");
    }
    if let Some(p) = &m.publisher {
        x += &format!("    <dc:publisher>{}</dc:publisher>\n", esc(p));
    }
    if let Some(i) = &m.isbn {
        x += &format!("    <dc:identifier opf:scheme=\"ISBN\">{}</dc:identifier>\n", esc(i));
    }
    let ol = m.key.rsplit('/').next().unwrap_or("");
    if !ol.is_empty() {
        x += &format!("    <dc:identifier id=\"id\" opf:scheme=\"OPENLIBRARY\">{}</dc:identifier>\n", esc(ol));
    }
    for l in m.languages.iter().take(1) {
        x += &format!("    <dc:language>{}</dc:language>\n", esc(l));
    }
    for s in &m.subjects {
        x += &format!("    <dc:subject>{}</dc:subject>\n", esc(s));
    }
    if let Some(d) = description {
        x += &format!("    <dc:description>{}</dc:description>\n", esc(d));
    }
    x += "  </metadata>\n</package>\n";
    x
}

/// What a save did, so Undo can reverse it.
#[derive(Serialize, Deserialize, Default, Debug)]
pub struct BookRecord {
    pub root: String,
    /// (from, to): the book moved into its own folder.
    pub moved: Vec<(String, String)>,
    /// Files added (metadata.opf, cover.jpg).
    pub created: Vec<String>,
    /// (original, in the trash): files that were in the way (an old cover or metadata.opf).
    pub trashed: Vec<(String, String)>,
    /// A folder made for the book (removed again on Undo when it is empty).
    pub made_dir: Option<String>,
}

fn trash_rel(stamp: &str, rel: &str) -> String {
    format!("{}/{stamp}/{rel}", crate::storage::TRASH)
}

fn move_rel(root: &Path, from: &str, to: &str) -> Result<()> {
    let (f, t) = (root.join(safe_rel(from)?), root.join(safe_rel(to)?));
    if t.exists() {
        return Err(Error::msg(format!("“{to}” is already there.")));
    }
    if let Some(p) = t.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::rename(f, t)?;
    Ok(())
}

/// Saves a match: own folder, metadata.opf and cover.jpg. Returns the book's new path.
pub fn save_files(root: &Path, rel: &str, m: &BookMatch, description: Option<&str>, cover: Option<&[u8]>, stamp: &str) -> Result<(String, BookRecord)> {
    let folder = books_folder(root).ok_or_else(|| Error::msg("There's no Ebooks folder in your library folder."))?;
    if !rel.starts_with(&format!("{folder}/")) {
        return Err(Error::msg("Only books in the Ebooks folder can be saved."));
    }
    let file = root.join(safe_rel(rel)?);
    if !file.is_file() {
        return Err(Error::msg("The book isn't there any more (moved or renamed?)."));
    }
    let base = root.join(&folder);
    let dir = file.parent().ok_or_else(|| Error::msg("bad path"))?.to_path_buf();
    let others = std::fs::read_dir(&dir)?.flatten().filter(|e| e.path() != file && e.path().is_file() && is_book(&e.file_name().to_string_lossy())).count();
    let mut rec = BookRecord { root: root.to_string_lossy().into_owned(), ..Default::default() };
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let name = book_name(m);
    if name.is_empty() {
        return Err(Error::msg("This match has no title."));
    }

    // Not alone in a folder of its own: it gets one, next to where it is now.
    let new_rel = if dir == base || others > 0 {
        let parent_rel = local::rel_to_root(root, &dir).ok_or_else(|| Error::msg("bad path"))?;
        let dir_rel = format!("{parent_rel}/{name}");
        if root.join(safe_rel(&dir_rel)?).exists() {
            return Err(Error::msg(format!("There's already a folder “{name}”. Is this book in your library twice?")));
        }
        std::fs::create_dir(root.join(safe_rel(&dir_rel)?))?;
        rec.made_dir = Some(dir_rel.clone());
        let to = format!("{dir_rel}/{name}.{ext}");
        if let Err(e) = move_rel(root, rel, &to) {
            let _ = std::fs::remove_dir(root.join(safe_rel(&dir_rel)?));
            return Err(e);
        }
        rec.moved.push((rel.to_string(), to.clone()));
        to
    } else {
        rel.to_string()
    };
    let book_dir = root.join(safe_rel(&new_rel)?).parent().ok_or_else(|| Error::msg("bad path"))?.to_path_buf();
    let dir_rel = local::rel_to_root(root, &book_dir).ok_or_else(|| Error::msg("bad path"))?;

    // What's in the way goes to the trash folder, never deleted.
    let mut in_way: Vec<PathBuf> = vec![book_dir.join("metadata.opf")];
    if cover.is_some() {
        in_way.extend(COVER_NAMES.iter().flat_map(|n| PIC_EXTS.iter().map(move |e| format!("{n}.{e}"))).map(|f| book_dir.join(f)));
    }
    for p in in_way.into_iter().filter(|p| p.is_file()) {
        let r = local::rel_to_root(root, &p).ok_or_else(|| Error::msg("bad path"))?;
        let t = trash_rel(stamp, &r);
        move_rel(root, &r, &t)?;
        rec.trashed.push((r, t));
    }
    std::fs::write(book_dir.join("metadata.opf"), opf_xml(m, description))?;
    rec.created.push(format!("{dir_rel}/metadata.opf"));
    if let Some(bytes) = cover {
        let ext = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "png" } else { "jpg" };
        std::fs::write(book_dir.join(format!("cover.{ext}")), bytes)?;
        rec.created.push(format!("{dir_rel}/cover.{ext}"));
    }
    Ok((new_rel, rec))
}

/// Undo of a save: added files to the trash folder, old ones back, the book back where it was.
pub fn undo_save(record_json: &str) -> Result<()> {
    let r: BookRecord = serde_json::from_str(record_json).map_err(|_| Error::msg("bad journal entry"))?;
    let root = PathBuf::from(&r.root);
    let stamp = format!("undo-book-{}", now());
    for c in &r.created {
        if root.join(safe_rel(c)?).is_file() {
            move_rel(&root, c, &trash_rel(&stamp, c))?;
        }
    }
    for (orig, t) in &r.trashed {
        if root.join(safe_rel(t)?).is_file() && !root.join(safe_rel(orig)?).exists() {
            move_rel(&root, t, orig)?;
        }
    }
    for (from, to) in r.moved.iter().rev() {
        if root.join(safe_rel(to)?).is_file() && !root.join(safe_rel(from)?).exists() {
            move_rel(&root, to, from)?;
        }
    }
    if let Some(d) = &r.made_dir {
        // Only when empty: remove_dir never removes a folder with something in it.
        let _ = std::fs::remove_dir(root.join(safe_rel(d)?));
    }
    Ok(())
}

async fn cover_bytes(id: u64) -> Option<Vec<u8>> {
    let r = web().get(format!("https://covers.openlibrary.org/b/id/{id}-L.jpg")).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let b = r.bytes().await.ok()?.to_vec();
    let pic = b.starts_with(&[0xFF, 0xD8, 0xFF]) || b.starts_with(&[0x89, b'P', b'N', b'G']);
    (pic && b.len() > 2000 && b.len() < 15_000_000).then_some(b)
}

#[tauri::command]
pub async fn books_save(state: State<'_, AppState>, rel: String, m: BookMatch, description: Option<String>) -> Result<String> {
    if state.settings()?.read_only {
        return Err(Error::msg("Changes are switched off in Settings."));
    }
    let root = state.library_root()?;
    let cover = match m.cover_id {
        Some(id) => cover_bytes(id).await,
        None => None,
    };
    let stamp = format!("book-{}", now());
    let (r2, m2) = (rel.clone(), m.clone());
    let (new_rel, rec) = with_timeout(Duration::from_secs(60), move || save_files(&root, &r2, &m2, description.as_deref(), cover.as_deref(), &stamp))?;
    let label = format!("{} saved as “{}”", rel.rsplit('/').next().unwrap_or(&rel), book_name(&m));
    state.store()?.journal_add("book", &new_rel, &serde_json::to_string(&rec).unwrap_or_default(), &label)?;
    if let Ok(c) = state.reader().await {
        let _ = c.library_scan().await;
    }
    Ok(new_rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mh-books-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A zip with stored (uncompressed) files, enough to stand in for an EPUB.
    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut cd = Vec::new();
        for (name, body) in files {
            let off = out.len() as u32;
            let crc = 0u32; // not checked by the reader
            let (n, b) = (name.as_bytes(), body.as_bytes());
            out.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(n);
            out.extend_from_slice(b);
            cd.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            cd.extend_from_slice(&crc.to_le_bytes());
            cd.extend_from_slice(&(b.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(b.len() as u32).to_le_bytes());
            cd.extend_from_slice(&(n.len() as u16).to_le_bytes());
            cd.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
            cd.extend_from_slice(&off.to_le_bytes());
            cd.extend_from_slice(n);
        }
        let cd_off = out.len() as u32;
        out.extend_from_slice(&cd);
        out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(cd.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&[0, 0]);
        out
    }

    const OPF: &str = r#"<package><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Project Hail Mary</dc:title><dc:creator opf:role="aut">Andy Weir</dc:creator><dc:date>2021-05-04</dc:date><dc:identifier opf:scheme="ISBN">978-0-593-13520-4</dc:identifier><dc:language>en</dc:language></metadata></package>"#;

    #[test]
    fn reads_the_details_inside_an_epub() {
        let d = tmp("epub");
        let p = d.join("x.epub");
        let container = r#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#;
        std::fs::File::create(&p).unwrap().write_all(&zip(&[("mimetype", "application/epub+zip"), ("META-INF/container.xml", container), ("OEBPS/content.opf", OPF)])).unwrap();
        let m = epub_meta(&p).unwrap();
        assert_eq!(m.title, "Project Hail Mary");
        assert_eq!(m.authors, vec!["Andy Weir"]);
        assert_eq!(m.year, Some(2021));
        assert_eq!(m.isbn.as_deref(), Some("9780593135204"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_broken_file_gives_no_details_instead_of_failing() {
        let d = tmp("broken");
        let p = d.join("x.epub");
        std::fs::write(&p, b"not a zip at all").unwrap();
        assert!(epub_meta(&p).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn guesses_from_the_name_and_judges_matches() {
        assert_eq!(name_guess("Andy_Weir-Project.Hail.Mary.retail"), "Andy Weir-Project Hail Mary");
        let guess = Meta { title: "Project Hail Mary".into(), authors: vec!["Weir, Andy".into()], ..Default::default() };
        let good = BookMatch { title: "Project Hail Mary".into(), authors: vec!["Andy Weir".into()], ..Default::default() };
        let other = BookMatch { title: "The Martian".into(), authors: vec!["Andy Weir".into()], ..Default::default() };
        assert!(is_sure(&guess, &good));
        assert!(!is_sure(&guess, &other));
        assert!(!is_sure(&guess, &BookMatch { title: "Project Hail Mary".into(), authors: vec!["Someone Else".into()], ..Default::default() }));
        // Without an author in the file, never "sure": you pick.
        assert!(!is_sure(&Meta { title: "Project Hail Mary".into(), ..Default::default() }, &good));
    }

    #[test]
    fn reads_open_library_search_results() {
        let v: Value = serde_json::from_str(r#"{"docs":[{"key":"/works/OL1W","title":"Project Hail Mary","author_name":["Andy Weir"],"first_publish_year":2021,"isbn":["0593135202","9780593135204"],"cover_i":123,"edition_count":40}]}"#).unwrap();
        let guess = Meta { title: "Project Hail Mary".into(), authors: vec!["Andy Weir".into()], ..Default::default() };
        let r = parse_search(&v, &guess);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].isbn.as_deref(), Some("9780593135204"));
        assert_eq!(r[0].cover_id, Some(123));
        assert!(r[0].sure);
        assert_eq!(book_name(&r[0]), "Andy Weir - Project Hail Mary (2021)");
    }

    fn sample_match() -> BookMatch {
        BookMatch { key: "/works/OL1W".into(), title: "Project Hail Mary".into(), authors: vec!["Andy Weir".into()], year: Some(2021), isbn: Some("9780593135204".into()), ..Default::default() }
    }

    #[test]
    fn saving_gives_the_book_its_own_folder_and_undo_puts_everything_back() {
        let root = tmp("save");
        std::fs::create_dir_all(root.join("Ebooks")).unwrap();
        std::fs::write(root.join("Ebooks/hail mary weir.epub"), b"book").unwrap();
        std::fs::write(root.join("Ebooks/other.pdf"), b"other").unwrap();
        let cover = [0xFFu8, 0xD8, 0xFF, 0xE0, 1, 2, 3];
        let (new_rel, rec) = save_files(&root, "Ebooks/hail mary weir.epub", &sample_match(), Some("A & B"), Some(&cover), "t1").unwrap();
        assert_eq!(new_rel, "Ebooks/Andy Weir - Project Hail Mary (2021)/Andy Weir - Project Hail Mary (2021).epub");
        assert_eq!(std::fs::read(root.join(&new_rel)).unwrap(), b"book");
        let dir = root.join("Ebooks/Andy Weir - Project Hail Mary (2021)");
        let opf = std::fs::read_to_string(dir.join("metadata.opf")).unwrap();
        assert!(opf.contains("<dc:title>Project Hail Mary</dc:title>") && opf.contains("A &amp; B"));
        assert_eq!(parse_opf(&opf).authors, vec!["Andy Weir"]);
        assert!(dir.join("cover.jpg").is_file());
        // The list now sees it as done.
        let list = scan(&root);
        let b = list.books.iter().find(|b| b.rel == new_rel).unwrap();
        assert!(b.done && b.own_folder && b.from == "opf");

        undo_save(&serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(std::fs::read(root.join("Ebooks/hail mary weir.epub")).unwrap(), b"book");
        assert!(!dir.exists(), "the folder made for it is gone again (it was empty)");
        // The added files went to the trash folder, not deleted.
        let trash = root.join(crate::storage::TRASH);
        assert!(std::fs::read_dir(&trash).unwrap().count() > 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_old_cover_and_details_go_to_the_trash_and_come_back_on_undo() {
        let root = tmp("inway");
        std::fs::create_dir_all(root.join("Ebooks/Dune")).unwrap();
        std::fs::write(root.join("Ebooks/Dune/Dune.epub"), b"book").unwrap();
        std::fs::write(root.join("Ebooks/Dune/cover.jpg"), b"old cover").unwrap();
        std::fs::write(root.join("Ebooks/Dune/metadata.opf"), b"old opf").unwrap();
        let m = BookMatch { key: "/works/OL2W".into(), title: "Dune".into(), authors: vec!["Frank Herbert".into()], year: Some(1965), ..Default::default() };
        let new_cover = [0xFFu8, 0xD8, 0xFF, 9];
        let (new_rel, rec) = save_files(&root, "Ebooks/Dune/Dune.epub", &m, None, Some(&new_cover), "t2").unwrap();
        // Already alone in its own folder: stays where it is.
        assert_eq!(new_rel, "Ebooks/Dune/Dune.epub");
        assert_eq!(std::fs::read(root.join("Ebooks/Dune/cover.jpg")).unwrap(), new_cover);
        assert_eq!(rec.trashed.len(), 2);
        undo_save(&serde_json::to_string(&rec).unwrap()).unwrap();
        assert_eq!(std::fs::read(root.join("Ebooks/Dune/cover.jpg")).unwrap(), b"old cover");
        assert_eq!(std::fs::read(root.join("Ebooks/Dune/metadata.opf")).unwrap(), b"old opf");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn never_overwrites_a_folder_that_is_already_there() {
        let root = tmp("clash");
        std::fs::create_dir_all(root.join("Ebooks/Andy Weir - Project Hail Mary (2021)")).unwrap();
        std::fs::write(root.join("Ebooks/x.epub"), b"book").unwrap();
        assert!(save_files(&root, "Ebooks/x.epub", &sample_match(), None, None, "t3").is_err());
        assert!(root.join("Ebooks/x.epub").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_books_in_the_ebooks_folder_are_touched() {
        let root = tmp("outside");
        std::fs::create_dir_all(root.join("Ebooks")).unwrap();
        std::fs::create_dir_all(root.join("Movies")).unwrap();
        std::fs::write(root.join("Movies/x.epub"), b"book").unwrap();
        assert!(save_files(&root, "Movies/x.epub", &sample_match(), None, None, "t4").is_err());
        assert!(save_files(&root, "Ebooks/../Movies/x.epub", &sample_match(), None, None, "t4").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
