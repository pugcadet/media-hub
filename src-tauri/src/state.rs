use crate::config::{self, Settings};
use crate::error::{Error, Result};
use crate::jellyfin::Client;
use crate::secrets;
use crate::store::Store;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub struct AppState {
    pub dir: PathBuf,
    store: Mutex<Store>,
    settings: Mutex<Settings>,
    /// The API key, read from the key storage once and then kept in memory only.
    key: Mutex<Option<String>>,
}

fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    m.lock().map_err(|_| Error::msg("Internal error: please restart the app."))
}

impl AppState {
    pub fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let store = Store::open(&dir.join("hub.sqlite"))?;
        let settings = config::load(&dir);
        Ok(AppState {
            dir,
            store: Mutex::new(store),
            settings: Mutex::new(settings),
            key: Mutex::new(None),
        })
    }

    pub fn store(&self) -> Result<MutexGuard<'_, Store>> {
        lock(&self.store)
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(lock(&self.settings)?.clone())
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<()> {
        let mut s = lock(&self.settings)?;
        f(&mut s);
        config::save(&self.dir, &s)
    }

    pub fn set_key(&self, key: Option<String>) -> Result<()> {
        *lock(&self.key)? = key;
        Ok(())
    }

    fn key(&self) -> Result<Option<String>> {
        let mut k = lock(&self.key)?;
        if k.is_none() {
            *k = secrets::load()?;
        }
        Ok(k.clone())
    }

    /// A client for the saved server, or None when the app is not connected yet.
    pub fn client(&self) -> Result<Option<Client>> {
        let Some(url) = self.settings()?.server_url else {
            return Ok(None);
        };
        let Some(key) = self.key()? else {
            return Ok(None);
        };
        Ok(Some(Client::new(&url, &key)?))
    }
}
