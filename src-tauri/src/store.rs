//! Local cache (SQLite) on this computer. Nothing here is the source of truth:
//! Jellyfin is. The cache only makes browsing fast and lets the app start offline.

use crate::error::{Error, Result};
use crate::jellyfin::NewItem;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

const GENRE_SEP: &str = "|";

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemRow {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub year: Option<i32>,
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub overview: String,
    pub has_poster: bool,
    pub library: String,
    /// Linked to TMDB, TVDB or IMDb in Jellyfin.
    pub matched: bool,
    pub seasons: Option<i64>,
    pub episodes: Option<i64>,
    /// minutes
    pub runtime: Option<f64>,
    pub played: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryInfo {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attention {
    pub unmatched: i64,
    pub no_poster: i64,
}

#[derive(Debug, Clone)]
pub struct JournalEntry {
    pub id: i64,
    pub root: String,
    pub from: String,
    pub to: String,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: i64,
    pub at: i64,
    pub action: String,
    pub target: String,
    pub undone: bool,
}

#[derive(Debug, Clone)]
pub struct ChangeFull {
    pub action: String,
    pub target: String,
    pub old_value: String,
    pub new_value: String,
    pub undone: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchInfo {
    pub batch: String,
    pub at: i64,
    pub files: i64,
    pub undone: i64,
    pub example: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub movies: i64,
    pub series: i64,
    pub last_sync: Option<i64>,
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "BEGIN;
             CREATE TABLE items(
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL CHECK(kind IN ('movie','series')),
               name TEXT NOT NULL,
               sort_name TEXT NOT NULL,
               year INTEGER,
               rating REAL,
               genres TEXT NOT NULL DEFAULT '',
               overview TEXT NOT NULL DEFAULT '',
               has_poster INTEGER NOT NULL DEFAULT 0,
               added TEXT,
               synced INTEGER NOT NULL
             );
             CREATE INDEX items_kind ON items(kind);
             -- Filled by later modules: every change the app makes to Jellyfin is written
             -- here first, with the old value, so it can be undone.
             CREATE TABLE undo_journal(
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               at TEXT NOT NULL,
               action TEXT NOT NULL,
               target TEXT NOT NULL,
               old_value TEXT NOT NULL,
               new_value TEXT NOT NULL,
               undone INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;
             COMMIT;",
        )?;
    }
    if version < 2 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE undo_journal ADD COLUMN batch TEXT NOT NULL DEFAULT '';
             ALTER TABLE undo_journal ADD COLUMN state TEXT NOT NULL DEFAULT 'done';
             CREATE INDEX undo_batch ON undo_journal(batch);
             PRAGMA user_version = 2;
             COMMIT;",
        )?;
    }
    if version < 3 {
        conn.execute_batch(
            "BEGIN;
             ALTER TABLE items ADD COLUMN library TEXT NOT NULL DEFAULT '';
             ALTER TABLE items ADD COLUMN matched INTEGER NOT NULL DEFAULT 1;
             ALTER TABLE items ADD COLUMN seasons INTEGER;
             ALTER TABLE items ADD COLUMN episodes INTEGER;
             ALTER TABLE items ADD COLUMN runtime REAL;
             ALTER TABLE items ADD COLUMN played INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE items ADD COLUMN path TEXT NOT NULL DEFAULT '';
             CREATE TABLE libraries(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, ord INTEGER NOT NULL);
             PRAGMA user_version = 3;
             COMMIT;",
        )?;
    }
    Ok(())
}

fn row_to_item(r: &rusqlite::Row) -> rusqlite::Result<ItemRow> {
    let genres: String = r.get(5)?;
    Ok(ItemRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        year: r.get(3)?,
        rating: r.get(4)?,
        genres: genres
            .split(GENRE_SEP)
            .filter(|g| !g.is_empty())
            .map(String::from)
            .collect(),
        overview: r.get(6)?,
        has_poster: r.get::<_, i64>(7)? != 0,
        library: r.get(8)?,
        matched: r.get::<_, i64>(9)? != 0,
        seasons: r.get(10)?,
        episodes: r.get(11)?,
        runtime: r.get(12)?,
        played: r.get::<_, i64>(13)? != 0,
    })
}

const COLS: &str = "id, kind, name, year, rating, genres, overview, has_poster, library, matched, seasons, episodes, runtime, played";

/// Escapes % and _ so a search for "100%" is a literal search.
fn like_pattern(q: &str) -> String {
    let mut s = String::from("%");
    for c in q.trim().chars() {
        if matches!(c, '%' | '_' | '\\') {
            s.push('\\');
        }
        s.push(c);
    }
    s.push('%');
    s
}

/// Only these sort keys exist. The text goes into the query, so it must never come from the UI as-is.
fn order_by(sort: &str) -> &'static str {
    match sort {
        "rating" => "rating IS NULL, rating DESC, sort_name",
        "year" => "year IS NULL, year DESC, sort_name",
        "added" => "added IS NULL, added DESC, sort_name",
        _ => "sort_name COLLATE NOCASE",
    }
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    /// Replaces the whole cached list in one transaction. If the server suddenly returns
    /// nothing while we hold a list, we keep the old list and say so.
    pub fn replace_all(&mut self, items: &[NewItem], libraries: &[(String, String, String)], now: i64) -> Result<()> {
        let existing: i64 = self.conn.query_row("SELECT COUNT(*) FROM items", [], |r| r.get(0))?;
        if items.is_empty() && existing > 0 {
            return Err(Error::msg(
                "The server returned an empty library, so the saved list was kept. Try again in a moment.",
            ));
        }
        let tx = self.conn.transaction()?;
        {
            let mut up = tx.prepare(
                "INSERT INTO items(id,kind,name,sort_name,year,rating,genres,overview,has_poster,added,synced,
                                   library,matched,seasons,episodes,runtime,played,path)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                 ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, name=excluded.name,
                   sort_name=excluded.sort_name, year=excluded.year, rating=excluded.rating,
                   genres=excluded.genres, overview=excluded.overview, has_poster=excluded.has_poster,
                   added=excluded.added, synced=excluded.synced, library=excluded.library,
                   matched=excluded.matched, seasons=excluded.seasons, episodes=excluded.episodes,
                   runtime=excluded.runtime, played=excluded.played, path=excluded.path",
            )?;
            for it in items {
                up.execute(params![
                    it.id,
                    it.kind,
                    it.name,
                    it.sort_name,
                    it.year,
                    it.rating,
                    it.genres.join(GENRE_SEP),
                    it.overview,
                    it.has_poster as i64,
                    it.added,
                    now,
                    it.library,
                    it.matched as i64,
                    it.seasons,
                    it.episodes,
                    it.runtime,
                    it.played as i64,
                    it.path
                ])?;
            }
        }
        tx.execute("DELETE FROM items WHERE synced <> ?1", params![now])?;
        tx.execute("DELETE FROM libraries", [])?;
        for (i, (id, name, kind)) in libraries.iter().enumerate() {
            tx.execute(
                "INSERT OR REPLACE INTO libraries(id,name,kind,ord) VALUES (?1,?2,?3,?4)",
                params![id, name, kind, i as i64],
            )?;
        }
        tx.execute(
            "INSERT INTO meta(key,value) VALUES('last_sync',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![now.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn libraries(&self) -> Result<Vec<LibraryInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT l.id, l.name, l.kind, (SELECT COUNT(*) FROM items i WHERE i.library = l.id)
             FROM libraries l ORDER BY l.ord",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(LibraryInfo { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, count: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn attention(&self) -> Result<Attention> {
        let n = |sql: &str| -> Result<i64> { Ok(self.conn.query_row(sql, [], |r| r.get(0))?) };
        Ok(Attention {
            unmatched: n("SELECT COUNT(*) FROM items WHERE matched = 0")?,
            no_poster: n("SELECT COUNT(*) FROM items WHERE has_poster = 0")?,
        })
    }

    /// Every title with a poster, for the daily picks.
    pub fn pick_rows(&self) -> Result<Vec<ItemRow>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {COLS} FROM items WHERE has_poster=1"))?;
        let rows = stmt.query_map([], row_to_item)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn clear(&mut self) -> Result<()> {
        self.conn.execute_batch("DELETE FROM items; DELETE FROM meta; DELETE FROM libraries;")?;
        Ok(())
    }

    pub fn counts(&self) -> Result<Counts> {
        let count = |kind: &str| -> Result<i64> {
            Ok(self
                .conn
                .query_row("SELECT COUNT(*) FROM items WHERE kind=?1", params![kind], |r| r.get(0))?)
        };
        let last: Option<String> = self
            .conn
            .query_row("SELECT value FROM meta WHERE key='last_sync'", [], |r| r.get(0))
            .optional()?;
        Ok(Counts {
            movies: count("movie")?,
            series: count("series")?,
            last_sync: last.and_then(|v| v.parse().ok()),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn list(
        &self,
        kind: Option<&str>,
        library: Option<&str>,
        flag: Option<&str>,
        query: Option<&str>,
        sort: &str,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<ItemRow>> {
        let kind = kind.filter(|k| *k == "movie" || *k == "series");
        let library = library.filter(|l| !l.is_empty());
        // Fixed conditions only; nothing from the window is pasted into the query.
        let flag_sql = match flag {
            Some("unmatched") => "matched = 0",
            Some("noposter") => "has_poster = 0",
            Some("unwatched") => "played = 0",
            _ => "1 = 1",
        };
        let pattern = query.filter(|q| !q.trim().is_empty()).map(like_pattern);
        let sql = format!(
            "SELECT {COLS} FROM items
             WHERE (?1 IS NULL OR kind = ?1) AND (?2 IS NULL OR library = ?2)
               AND (?3 IS NULL OR name LIKE ?3 ESCAPE '\\' OR path LIKE ?3 ESCAPE '\\' OR id = ?5)
               AND {flag_sql}
             ORDER BY {} LIMIT ?4 OFFSET ?6",
            order_by(sort)
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let exact = query.map(|q| q.trim().to_lowercase());
        let rows = stmt.query_map(
            params![kind, library, pattern, limit.clamp(1, 500), exact, offset.max(0)],
            row_to_item,
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Ids of titles that have a poster, for the daily picks.
    pub fn candidate_ids(&self, kind: &str) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM items WHERE kind=?1 AND has_poster=1")?;
        let rows = stmt.query_map(params![kind], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Returns rows in the order of `ids`.
    pub fn get_many(&self, ids: &[String]) -> Result<Vec<ItemRow>> {
        let mut out = Vec::with_capacity(ids.len());
        let mut stmt = self
            .conn
            .prepare(&format!("SELECT {COLS} FROM items WHERE id=?1"))?;
        for id in ids {
            if let Some(r) = stmt.query_row(params![id], row_to_item).optional()? {
                out.push(r);
            }
        }
        Ok(out)
    }
}

impl Store {
    // ------------------------------------------------------------ undo journal

    /// Written BEFORE a file is moved. State goes to "done" after the move succeeds.
    pub fn journal_begin(&self, batch: &str, root: &str, from: &str, to: &str) -> Result<i64> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO undo_journal(at, action, target, old_value, new_value, batch, state)
             VALUES (?1, 'rename', ?2, ?3, ?4, ?5, 'pending')",
            params![at.to_string(), root, from, to, batch],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn journal_set_state(&self, id: i64, state: &str) -> Result<()> {
        self.conn.execute("UPDATE undo_journal SET state=?1 WHERE id=?2", params![state, id])?;
        Ok(())
    }

    pub fn journal_delete(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM undo_journal WHERE id=?1", params![id])?;
        Ok(())
    }

    pub fn journal_mark_undone(&self, id: i64) -> Result<()> {
        self.conn.execute("UPDATE undo_journal SET undone=1 WHERE id=?1", params![id])?;
        Ok(())
    }

    /// Newest first. Pending rows (app closed mid-move) are included: undo checks the disk anyway.
    pub fn journal_entries(&self, batch: &str) -> Result<Vec<JournalEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, target, old_value, new_value, undone FROM undo_journal
             WHERE batch=?1 AND action='rename' ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![batch], |r| {
            Ok(JournalEntry {
                id: r.get(0)?,
                root: r.get(1)?,
                from: r.get(2)?,
                to: r.get(3)?,
                undone: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Records a change made in Jellyfin (metadata or picture). `old_value` is what undo restores.
    pub fn journal_add(&self, action: &str, target: &str, old_value: &str, new_value: &str) -> Result<i64> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.conn.execute(
            "INSERT INTO undo_journal(at, action, target, old_value, new_value, batch, state)
             VALUES (?1, ?2, ?3, ?4, ?5, '', 'done')",
            params![at.to_string(), action, target, old_value, new_value],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Jellyfin changes for one item (pictures use "itemid|Kind|index" as target).
    pub fn changes_for(&self, item_id: &str, limit: i64) -> Result<Vec<Change>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, CAST(at AS INTEGER), action, target, undone FROM undo_journal
             WHERE action IN ('item_update','identify','image','image_removed','collection','subtitle','segment','file_trashed') AND (target = ?1 OR target LIKE ?1 || '|%')
             ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![item_id, limit.clamp(1, 100)], |r| {
            Ok(Change {
                id: r.get(0)?,
                at: r.get(1)?,
                action: r.get(2)?,
                target: r.get(3)?,
                undone: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Every journaled change except file renames (those are listed per batch).
    pub fn changes_all(&self, limit: i64) -> Result<Vec<Change>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, CAST(at AS INTEGER), action, target, undone FROM undo_journal
             WHERE batch = '' ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, 1000)], |r| {
            Ok(Change {
                id: r.get(0)?,
                at: r.get(1)?,
                action: r.get(2)?,
                target: r.get(3)?,
                undone: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn changes_by_action(&self, action: &str, limit: i64) -> Result<Vec<Change>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, CAST(at AS INTEGER), action, target, undone FROM undo_journal
             WHERE action = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![action, limit.clamp(1, 200)], |r| {
            Ok(Change {
                id: r.get(0)?,
                at: r.get(1)?,
                action: r.get(2)?,
                target: r.get(3)?,
                undone: r.get::<_, i64>(4)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn change(&self, id: i64) -> Result<ChangeFull> {
        Ok(self.conn.query_row(
            "SELECT action, target, old_value, new_value, undone FROM undo_journal WHERE id=?1",
            params![id],
            |r| {
                Ok(ChangeFull {
                    action: r.get(0)?,
                    target: r.get(1)?,
                    old_value: r.get(2)?,
                    new_value: r.get(3)?,
                    undone: r.get::<_, i64>(4)? != 0,
                })
            },
        )?)
    }

    /// Keeps the library list in step after an edit, without a full sync.
    pub fn patch_item(&self, id: &str, name: &str, year: Option<i32>, rating: Option<f64>, genres: &[String], overview: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE items SET name=?2, year=?3, rating=?4, genres=?5, overview=?6 WHERE id=?1",
            params![id, name, year, rating, genres.join(GENRE_SEP), overview],
        )?;
        Ok(())
    }

    pub fn set_played(&self, id: &str, played: bool) -> Result<()> {
        self.conn.execute("UPDATE items SET played=?2 WHERE id=?1", params![id, played as i64])?;
        Ok(())
    }

    /// Keeps the "matched" and "has a poster" marks in step after a change made in this app.
    pub fn patch_flags(&self, id: &str, matched: bool, has_poster: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE items SET matched=?2, has_poster=?3 WHERE id=?1",
            params![id, matched as i64, has_poster as i64],
        )?;
        Ok(())
    }

    /// (id, name, year, Jellyfin path, matched) of every movie or show, for the naming check.
    pub fn with_paths(&self, kind: &str) -> Result<Vec<(String, String, Option<i32>, String, bool)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, year, path, matched FROM items WHERE kind=?1 AND path <> '' ORDER BY name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![kind], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get::<_, i64>(4)? != 0))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn path_of(&self, id: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT path FROM items WHERE id=?1", params![id], |r| r.get::<_, String>(0))
            .optional()?
            .filter(|p| !p.is_empty()))
    }

    pub fn journal_batches(&self, limit: i64) -> Result<Vec<BatchInfo>> {
        let mut stmt = self.conn.prepare(
            "SELECT batch, MAX(CAST(at AS INTEGER)), COUNT(*), SUM(undone), MIN(new_value)
             FROM undo_journal WHERE batch <> '' GROUP BY batch ORDER BY MAX(id) DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, 200)], |r| {
            Ok(BatchInfo {
                batch: r.get(0)?,
                at: r.get(1)?,
                files: r.get(2)?,
                undone: r.get(3)?,
                example: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_are_listed_per_item() {
        let s = Store::in_memory().unwrap();
        let id = "0123456789abcdef0123456789abcdef";
        s.journal_add("item_update", id, "{}", "{}").unwrap();
        s.journal_add("image", &format!("{id}|Primary|0"), "", "url").unwrap();
        s.journal_add("item_update", "ffffffffffffffffffffffffffffffff", "{}", "{}").unwrap();
        let c = s.changes_for(id, 10).unwrap();
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].action, "image");
        s.journal_mark_undone(c[0].id).unwrap();
        assert!(s.change(c[0].id).unwrap().undone);
        // Jellyfin changes never show up in the rename history.
        assert!(s.journal_batches(10).unwrap().is_empty());
    }

    #[test]
    fn journal_records_batches() {
        let s = Store::in_memory().unwrap();
        let a = s.journal_begin("b1", "/root", "a.mkv", "A.mkv").unwrap();
        s.journal_set_state(a, "done").unwrap();
        let b = s.journal_begin("b1", "/root", "b.mkv", "B.mkv").unwrap();
        s.journal_delete(b).unwrap();
        let e = s.journal_entries("b1").unwrap();
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].from.as_str(), e[0].to.as_str()), ("a.mkv", "A.mkv"));
        s.journal_mark_undone(a).unwrap();
        let batches = s.journal_batches(10).unwrap();
        assert_eq!((batches[0].files, batches[0].undone), (1, 1));
    }

    fn item(id: &str, kind: &'static str, name: &str, poster: bool) -> NewItem {
        NewItem {
            id: id.into(),
            kind,
            name: name.into(),
            sort_name: name.to_lowercase(),
            year: Some(2020),
            rating: Some(7.5),
            genres: vec!["Kids".into(), "Animation".into()],
            overview: "x".into(),
            has_poster: poster,
            added: None,
            library: "lib".into(),
            matched: true,
            seasons: None,
            episodes: None,
            runtime: None,
            played: false,
            path: String::new(),
        }
    }

    #[test]
    fn sync_replaces_and_removes_old_items() {
        let mut s = Store::in_memory().unwrap();
        s.replace_all(&[item("a", "movie", "Alpha", true), item("b", "series", "Beta", true)], &[], 1).unwrap();
        s.replace_all(&[item("b", "series", "Beta", true), item("c", "movie", "Gamma", false)], &[], 2).unwrap();
        let all = s.list(None, None, None, None, "name", 0, 100).unwrap();
        let names: Vec<_> = all.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["Beta", "Gamma"]);
        let c = s.counts().unwrap();
        assert_eq!((c.movies, c.series, c.last_sync), (1, 1, Some(2)));
    }

    #[test]
    fn empty_answer_keeps_old_list() {
        let mut s = Store::in_memory().unwrap();
        s.replace_all(&[item("a", "movie", "Alpha", true)], &[], 1).unwrap();
        assert!(s.replace_all(&[], &[], 2).is_err());
        assert_eq!(s.counts().unwrap().movies, 1);
    }

    #[test]
    fn search_is_literal_and_filters_kind() {
        let mut s = Store::in_memory().unwrap();
        s.replace_all(
            &[item("a", "movie", "100% Wolf", true), item("b", "series", "Bluey", true), item("c", "movie", "Blue Planet", true)],
            &[],
            1,
        )
        .unwrap();
        assert_eq!(s.list(None, None, None, Some("100%"), "name", 0, 10).unwrap().len(), 1);
        assert_eq!(s.list(None, None, None, Some("%"), "name", 0, 10).unwrap().len(), 1);
        assert_eq!(s.list(Some("movie"), None, None, Some("blue"), "name", 0, 10).unwrap().len(), 1);
        assert_eq!(s.list(None, None, None, Some("blue"), "name", 0, 10).unwrap().len(), 2);
    }

    #[test]
    fn unknown_sort_falls_back_and_candidates_need_poster() {
        let mut s = Store::in_memory().unwrap();
        s.replace_all(&[item("a", "movie", "A", true), item("b", "movie", "B", false)], &[("lib".into(), "Films".into(), "movies".into())], 1).unwrap();
        assert_eq!(s.list(None, None, Some("x; DROP"), None, "x; DROP TABLE items", 0, 10).unwrap().len(), 2);
        assert_eq!(s.list(None, None, Some("noposter"), None, "name", 0, 10).unwrap().len(), 1);
        assert_eq!(s.candidate_ids("movie").unwrap(), vec!["a".to_string()]);
        assert_eq!(s.libraries().unwrap()[0].count, 2);
        assert_eq!(s.attention().unwrap().no_poster, 1);
        let row = &s.get_many(&["a".to_string()]).unwrap()[0];
        assert_eq!(row.genres, vec!["Kids", "Animation"]);
    }
}
