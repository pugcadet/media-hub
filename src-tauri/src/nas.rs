//! Keeping the NAS connected. While the library share is mounted, the Mac's own list of
//! mounts says where it comes from ("//me@nas.local/Media on /Volumes/Media (smbfs)"); that is
//! remembered. When the share drops (a VPN going on or off, the Mac waking up), macOS is asked
//! to mount it again, with the password it keeps in the Keychain. Nothing is asked of you and
//! no password passes through the app.

use crate::state::AppState;
use std::path::Path;

/// The share's address from the Mac's list of mounts, for the folder it's mounted on.
pub fn share_url(mount_list: &str, mount_point: &str) -> Option<String> {
    for line in mount_list.lines() {
        let Some((source, rest)) = line.split_once(" on ") else { continue };
        let Some((point, kind)) = rest.rsplit_once(" (") else { continue };
        if point != mount_point {
            continue;
        }
        let scheme = if kind.starts_with("smbfs") { "smb" } else if kind.starts_with("afpfs") { "afp" } else { return None };
        let src = source.strip_prefix("//")?;
        // Never a password: only "user@host/share".
        let src = match src.split_once('@') {
            Some((user, host)) => format!("{}@{host}", user.split(';').next_back().unwrap_or(user).split(':').next().unwrap_or(user)),
            None => src.to_string(),
        };
        return Some(format!("{scheme}://{src}"));
    }
    None
}

/// Only plain address characters, so it's safe inside the AppleScript line.
fn safe(url: &str) -> bool {
    (url.starts_with("smb://") || url.starts_with("afp://")) && url.chars().all(|c| c.is_ascii_alphanumeric() || "@._%/:-~".contains(c))
}

/// "/Volumes/Media" for a library folder at or under it.
fn mount_point(root: &str) -> Option<String> {
    let rest = root.strip_prefix("/Volumes/")?;
    Some(format!("/Volumes/{}", rest.split('/').next()?))
}

/// While the share is there: remember where it comes from.
pub fn remember(state: &AppState, root: &str) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Some(point) = mount_point(root) else { return };
    let Ok(out) = std::process::Command::new("/sbin/mount").output() else { return };
    let list = String::from_utf8_lossy(&out.stdout);
    if let Some(url) = share_url(&list, &point).filter(|u| safe(u)) {
        if state.settings().ok().and_then(|s| s.nas_url) != Some(url.clone()) {
            let _ = state.update_settings(move |s| s.nas_url = Some(url));
        }
    }
}

/// macOS blocks the app from network drives (an old "allowed" that belonged to the previous
/// version): forget that answer for Media Hub only, so macOS asks again. Once per app start.
pub fn ask_again() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static DONE: AtomicBool = AtomicBool::new(false);
    if !cfg!(target_os = "macos") || DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        let _ = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", "SystemPolicyNetworkVolumes", "app.mediahub.desktop"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    });
}

/// The share is gone: ask macOS to mount it again (at most once a minute, in the background).
/// Returns true when a try was started.
pub fn reconnect(state: &AppState, root: &str) -> bool {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    if !cfg!(target_os = "macos") || !Path::new("/Volumes").is_dir() {
        return false;
    }
    let Some(url) = state.settings().ok().and_then(|s| s.nas_url).filter(|u| safe(u)) else { return false };
    if mount_point(root).is_none() {
        return false;
    }
    {
        let Ok(mut last) = LAST.lock() else { return false };
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
            return false;
        }
        *last = Some(Instant::now());
    }
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(format!("try\nmount volume \"{url}\"\nend try"))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_share_from_the_list_of_mounts() {
        let list = "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n//pug@DS920.local/Media on /Volumes/Media (smbfs, nodev, nosuid, mounted by pug)\n//guest:@nas/Other on /Volumes/Other (smbfs, nodev)";
        assert_eq!(share_url(list, "/Volumes/Media").as_deref(), Some("smb://pug@DS920.local/Media"));
        assert_eq!(share_url(list, "/Volumes/Other").as_deref(), Some("smb://guest@nas/Other"));
        assert_eq!(share_url(list, "/Volumes/Gone"), None);
        assert!(safe("smb://pug@DS920.local/Media"));
        assert!(!safe("smb://x\"; do shell script \"rm"));
        assert_eq!(mount_point("/Volumes/Media/Library").as_deref(), Some("/Volumes/Media"));
    }
}
