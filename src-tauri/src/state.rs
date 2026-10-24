use crate::config::{self, Settings};
use crate::error::{Error, Result};
use crate::jellyfin::{Client, Writer};
use crate::planner::PlanOp;
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
    /// The last rename plan shown to the user. Apply only ever runs this exact plan.
    plan: Mutex<Option<StoredPlan>>,
}

#[derive(Clone)]
pub struct StoredPlan {
    pub id: String,
    pub root: PathBuf,
    pub ops: Vec<PlanOp>,
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
            plan: Mutex::new(None),
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

    pub fn set_plan(&self, p: StoredPlan) -> Result<()> {
        *lock(&self.plan)? = Some(p);
        Ok(())
    }

    /// Takes the plan out so it cannot be applied twice.
    pub fn take_plan(&self, id: &str) -> Result<StoredPlan> {
        let mut slot = lock(&self.plan)?;
        match slot.as_ref() {
            Some(p) if p.id == id => Ok(slot.take().expect("checked")),
            _ => Err(Error::msg("This preview is out of date. Make a new preview first.")),
        }
    }

    pub fn library_root(&self) -> Result<PathBuf> {
        self.settings()?
            .library_root
            .map(PathBuf::from)
            .ok_or_else(|| Error::msg("Choose your library folder first."))
    }

    pub fn device_id(&self) -> Result<String> {
        if let Some(id) = self.settings()?.device_id {
            return Ok(id);
        }
        let id = crate::player::token()?;
        let saved = id.clone();
        self.update_settings(move |s| s.device_id = Some(saved))?;
        Ok(id)
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

    /// The only way to get something that can change Jellyfin. Refuses while changes are switched off.
    pub fn writer(&self) -> Result<Writer> {
        if self.settings()?.read_only {
            return Err(Error::msg("Changes to Jellyfin are switched off. Turn them on in Settings first."));
        }
        let client = self.client()?.ok_or_else(|| Error::msg("Connect to your server first."))?;
        Ok(client.into_writer())
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
