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
    /// Recent previews (newest last), so two screens previewing at once don't cancel each other.
    plan: Mutex<Vec<StoredPlan>>,
}

#[derive(Clone)]
pub struct StoredPlan {
    pub id: String,
    pub root: PathBuf,
    pub ops: Vec<PlanOp>,
}

/// The library folder as it is mounted right now. When a Mac reconnects a share while an old
/// "/Volumes/Media" folder is still in the way, it mounts it as "/Volumes/Media-1" instead, and
/// the saved folder is then missing (or an empty leftover). In that case use the "-1" one.
pub fn live_root(saved: &str) -> String {
    // Asked for on every settings read: the answer is kept for 10 seconds, so loops over
    // thousands of files don't look at the NAS each time.
    static LAST: Mutex<Option<(std::time::Instant, String, String)>> = Mutex::new(None);
    if let Ok(g) = LAST.lock() {
        if let Some((at, s, live)) = g.as_ref() {
            if s == saved && at.elapsed() < std::time::Duration::from_secs(10) {
                return live.clone();
            }
        }
    }
    let live = find_live_root(saved);
    if let Ok(mut g) = LAST.lock() {
        *g = Some((std::time::Instant::now(), saved.to_string(), live.clone()));
    }
    live
}

fn find_live_root(saved: &str) -> String {
    let p = std::path::Path::new(saved);
    let (Some(parent), Some(name)) = (p.parent(), p.file_name().and_then(|n| n.to_str())) else { return saved.into() };
    if parent != std::path::Path::new("/Volumes") || is_mount(p) {
        return saved.into();
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|c| {
            c.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_prefix(name)).and_then(|n| n.strip_prefix('-')).is_some_and(|n| !n.is_empty() && n.chars().all(|ch| ch.is_ascii_digit()))
        })
        .filter(|c| is_mount(c))
        .collect();
    found.sort();
    found.first().map(|c| c.to_string_lossy().into_owned()).unwrap_or_else(|| saved.into())
}

/// Is the library folder really there? A folder under /Volumes that isn't a mounted share is a
/// leftover from an earlier connection, so the NAS isn't actually connected.
pub fn root_ok(root: &str) -> bool {
    let p = std::path::Path::new(root);
    p.is_dir() && (!p.starts_with("/Volumes") || p == std::path::Path::new("/Volumes") || is_mount(p) || p.parent() != Some(std::path::Path::new("/Volumes")))
}

/// Is this folder a mounted drive or share (not just a folder on the same disk as its parent)?
#[cfg(unix)]
fn is_mount(p: &std::path::Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(p), p.parent().map(std::fs::metadata)) {
        (Ok(m), Some(Ok(up))) => m.is_dir() && m.dev() != up.dev(),
        _ => false,
    }
}
#[cfg(not(unix))]
fn is_mount(p: &std::path::Path) -> bool {
    p.is_dir()
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
            plan: Mutex::new(Vec::new()),
        })
    }

    pub fn store(&self) -> Result<MutexGuard<'_, Store>> {
        lock(&self.store)
    }

    pub fn settings(&self) -> Result<Settings> {
        let mut s = lock(&self.settings)?.clone();
        if let Some(r) = s.library_root.take() {
            let live = live_root(&r);
            if live != r {
                if let Some(m) = s.path_map.as_mut() {
                    if let Some(rest) = m.local.strip_prefix(r.as_str()).filter(|x| x.is_empty() || x.starts_with('/')) {
                        m.local = format!("{live}{rest}");
                    }
                }
            }
            s.library_root = Some(live);
        }
        Ok(s)
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<()> {
        let mut s = lock(&self.settings)?;
        f(&mut s);
        config::save(&self.dir, &s)
    }

    pub fn set_plan(&self, p: StoredPlan) -> Result<()> {
        let mut list = lock(&self.plan)?;
        list.retain(|x| x.id != p.id);
        list.push(p);
        let extra = list.len().saturating_sub(40);
        list.drain(..extra);
        Ok(())
    }

    /// Takes the plan out so it cannot be applied twice.
    pub fn take_plan(&self, id: &str) -> Result<StoredPlan> {
        let mut list = lock(&self.plan)?;
        match list.iter().position(|p| p.id == id) {
            Some(i) => Ok(list.remove(i)),
            None => Err(Error::msg("This preview is out of date. Make a new preview first.")),
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
    pub async fn writer(&self) -> Result<Writer> {
        if self.settings()?.read_only {
            return Err(Error::msg("Changes to Jellyfin are switched off. Turn them on in Settings first."));
        }
        Ok(self.reader().await?.into_writer())
    }

    /// A connected client that acts as a Jellyfin user (picked once, then remembered).
    pub async fn reader(&self) -> Result<Client> {
        let mut c = self.client()?.ok_or_else(|| Error::msg("Connect to your server first."))?;
        if c.user.is_none() {
            let u = c.pick_user().await?;
            let saved = u.clone();
            self.update_settings(move |s| s.user_id = Some(saved))?;
            c.user = Some(u);
        }
        Ok(c)
    }

    /// A client for the saved server, or None when the app is not connected yet.
    pub fn client(&self) -> Result<Option<Client>> {
        let Some(url) = self.settings()?.server_url else {
            return Ok(None);
        };
        let Some(key) = self.key()? else {
            return Ok(None);
        };
        let mut c = Client::new(&url, &key)?;
        c.user = self.settings()?.user_id;
        Ok(Some(c))
    }
}

/// Each journal write takes the database lock only for that write.
impl crate::fsops::Journal for AppState {
    fn begin(&self, batch: &str, root: &str, from: &str, to: &str) -> Result<i64> {
        self.store()?.journal_begin(batch, root, from, to)
    }
    fn set_state(&self, id: i64, state: &str) -> Result<()> {
        self.store()?.journal_set_state(id, state)
    }
    fn delete(&self, id: i64) -> Result<()> {
        self.store()?.journal_delete(id)
    }
    fn entries(&self, batch: &str) -> Result<Vec<crate::store::JournalEntry>> {
        self.store()?.journal_entries(batch)
    }
    fn mark_undone(&self, id: i64) -> Result<()> {
        self.store()?.journal_mark_undone(id)
    }
    fn pending(&self) -> Result<Vec<crate::store::JournalEntry>> {
        self.store()?.journal_pending()
    }
}
