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
