//! Finding ffmpeg, decoding audio with it, and turning Jellyfin's file paths (as the
//! server sees them, e.g. /volume1/media/...) into paths on this computer (/Volumes/media/...).

use crate::error::{Error, Result};
use crate::fingerprint::RATE;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(crate) fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Looks for ffmpeg: the path chosen in Settings, then the usual install places.
/// (Apps started from the Dock or Start menu do not see the shell's PATH, so common
/// Homebrew / winget locations are checked by name.)
pub fn locate_ffmpeg(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = custom.map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(c);
    }
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Microsoft").join("WinGet").join("Links"));
        }
        dirs.extend([r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin"].map(PathBuf::from));
        if let Some(home) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(home).join("scoop").join("shims"));
        }
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}

pub fn ffmpeg_version(bin: &Path) -> Option<String> {
    let mut cmd = Command::new(bin);
    cmd.arg("-version").stdin(Stdio::null()).stderr(Stdio::null());
    hide_window(&mut cmd);
    let out = cmd.output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().next().map(|l| l.chars().take(80).collect())
}

/// Decodes `duration` seconds of audio starting at `start` into mono 16-bit samples at
/// the fingerprint sample rate. Video, subtitles and data streams are skipped.
pub fn decode_audio(bin: &Path, file: &Path, start: f64, duration: f64) -> Result<Vec<i16>> {
    let mut cmd = Command::new(bin);
    cmd.args(["-nostdin", "-hide_banner", "-loglevel", "error"])
        .args(["-ss", &format!("{start:.3}"), "-t", &format!("{duration:.3}")])
        .arg("-i")
        .arg(file)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", &RATE.to_string(), "-f", "s16le", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut cmd);
    let out = cmd.output().map_err(|e| Error::msg(format!("Could not start ffmpeg: {e}")))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr);
        return Err(Error::msg(format!("ffmpeg could not read the file: {}", why.lines().last().unwrap_or("unknown error"))));
    }
    Ok(out.stdout.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect())
}

/// How the server's paths line up with this computer's: replace `server` with `local`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PathMap {
    pub server: String,
    pub local: String,
}

fn components(s: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in s.char_indices() {
        if c == '/' || c == '\\' {
            if let Some(st) = start.take() {
                out.push((st, &s[st..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(st) = start {
        out.push((st, &s[st..]));
    }
    out
}

fn join_rest(base: &Path, rest: &[(usize, &str)]) -> Option<PathBuf> {
    let mut p = base.to_path_buf();
    for (_, c) in rest {
        if *c == ".." || *c == "." || c.contains(':') {
            return None;
        }
        p.push(c);
    }
    Some(p)
}

/// Finds the file on this computer. With a known map it is a simple swap; otherwise the
/// server path is tried against the library folder with ever fewer leading folders
/// ("/volume1/media/TV/x.mkv" -> root/media/TV/x.mkv, root/TV/x.mkv, root/x.mkv) and the
/// first hit becomes the new map.
pub fn map_path(server_path: &str, map: Option<&PathMap>, root: Option<&Path>) -> Option<(PathBuf, PathMap)> {
    let comps = components(server_path);
    if let Some(m) = map {
        if let Some(rest) = server_path.strip_prefix(m.server.as_str()) {
            if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') {
                let rc = components(rest);
                if let Some(p) = join_rest(Path::new(&m.local), &rc).filter(|p| p.exists()) {
                    return Some((p, m.clone()));
                }
            }
        }
    }
    let root = root?;
    for i in 0..comps.len() {
        let Some(candidate) = join_rest(root, &comps[i..]) else { continue };
        if candidate.exists() {
            let server = server_path[..comps[i].0].trim_end_matches(['/', '\\']).to_string();
            return Some((candidate, PathMap { server, local: root.to_string_lossy().into_owned() }));
        }
    }
    None
}

/// The other way round: a path on this computer (inside the mapped folder) as the server
/// sees it. None when it isn't under the mapped folder.
pub fn to_server(map: &PathMap, local: &Path) -> Option<String> {
    let rest = local.strip_prefix(Path::new(&map.local)).ok()?;
    let sep = if map.server.contains('\\') && !map.server.contains('/') { "\\" } else { "/" };
    let mut out = map.server.trim_end_matches(['/', '\\']).to_string();
    for c in rest.components() {
        let part = c.as_os_str().to_string_lossy();
        if part == ".." {
            return None;
        }
        out.push_str(sep);
        out.push_str(&part);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn maps_back_to_the_server() {
        let m = PathMap { server: "/volume1/media".into(), local: "/Volumes/media".into() };
        assert_eq!(to_server(&m, Path::new("/Volumes/media/TV/Bluey")).as_deref(), Some("/volume1/media/TV/Bluey"));
        assert_eq!(to_server(&m, Path::new("/Users/x")), None);
        let w = PathMap { server: "D:\\Media".into(), local: "/Volumes/media".into() };
        assert_eq!(to_server(&w, Path::new("/Volumes/media/TV")).as_deref(), Some("D:\\Media\\TV"));
    }

    #[test]
    fn learns_and_reuses_the_path_map() {
        let root = std::env::temp_dir().join(format!("mediahub-map-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("TV/Bluey/Season 01")).unwrap();
        fs::write(root.join("TV/Bluey/Season 01/ep1.mkv"), b"x").unwrap();
        fs::write(root.join("TV/Bluey/Season 01/ep2.mkv"), b"x").unwrap();

        let (p, m) = map_path("/volume1/media/TV/Bluey/Season 01/ep1.mkv", None, Some(&root)).unwrap();
        assert_eq!(p, root.join("TV").join("Bluey").join("Season 01").join("ep1.mkv"));
        assert_eq!(m.server, "/volume1/media");

        let (p2, _) = map_path("/volume1/media/TV/Bluey/Season 01/ep2.mkv", Some(&m), None).unwrap();
        assert!(p2.ends_with("ep2.mkv"));

        // Windows-style server paths work too.
        let (_, m3) = map_path(r"D:\Media\TV\Bluey\Season 01\ep1.mkv", None, Some(&root)).unwrap();
        assert_eq!(m3.server, r"D:\Media");

        assert!(map_path("/volume1/media/TV/Other/x.mkv", Some(&m), Some(&root)).is_none());
        assert!(map_path("/volume1/../../etc/passwd", None, Some(&root)).is_none());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn splits_both_separator_styles() {
        let c: Vec<&str> = components(r"/a/b\c//d").into_iter().map(|x| x.1).collect();
        assert_eq!(c, vec!["a", "b", "c", "d"]);
    }
}
