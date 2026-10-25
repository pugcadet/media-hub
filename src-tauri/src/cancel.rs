//! Stop buttons for long jobs. A job calls `begin(kind)` when it starts and `check(kind)`
//! between steps; the Stop button calls `cancel_job(kind)`. Whatever finished before the
//! stop stays done (and in History, so it can still be undone).

use crate::error::{Error, Result};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

fn flags() -> &'static Mutex<HashSet<String>> {
    static F: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Clears an old stop request for this kind of job.
pub fn begin(kind: &str) {
    if let Ok(mut f) = flags().lock() {
        f.remove(kind);
    }
}

pub fn stopped(kind: &str) -> bool {
    flags().lock().map(|f| f.contains(kind)).unwrap_or(false)
}

/// `Err(Stopped)` when the job was asked to stop.
pub fn check(kind: &str) -> Result<()> {
    if stopped(kind) {
        Err(Error::Stopped)
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn cancel_job(kind: String) {
    if kind == "naming" {
        crate::naming_check::naming_check_cancel();
    }
    if kind.len() <= 40 {
        if let Ok(mut f) = flags().lock() {
            f.insert(kind);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_and_restart() {
        begin("t");
        assert!(check("t").is_ok());
        cancel_job("t".into());
        assert!(matches!(check("t"), Err(Error::Stopped)));
        begin("t");
        assert!(!stopped("t"));
    }
}
