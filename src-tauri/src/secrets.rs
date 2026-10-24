//! The API key is kept in the operating system's own key storage
//! (macOS Keychain, Windows Credential Manager). It is never written to a file.

use crate::error::{Error, Result};

const SERVICE: &str = "app.mediahub.desktop";
const ACCOUNT: &str = "jellyfin-api-key";

fn entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| Error::Keyring(e.to_string()))
}

pub fn save(key: &str) -> Result<()> {
    entry()?
        .set_password(key)
        .map_err(|e| Error::Keyring(e.to_string()))
}

pub fn load() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Keyring(e.to_string())),
    }
}

pub fn clear() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Keyring(e.to_string())),
    }
}

const TMDB_ACCOUNT: &str = "tmdb-api-key";

fn tmdb_entry() -> Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, TMDB_ACCOUNT).map_err(|e| Error::Keyring(e.to_string()))
}

pub fn save_tmdb(key: &str) -> Result<()> {
    tmdb_entry()?.set_password(key).map_err(|e| Error::Keyring(e.to_string()))
}

pub fn load_tmdb() -> Result<Option<String>> {
    match tmdb_entry()?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Keyring(e.to_string())),
    }
}

pub fn clear_tmdb() -> Result<()> {
    match tmdb_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(Error::Keyring(e.to_string())),
    }
}
