import { useEffect, useState } from "react";
import { api, Batch, errorText, JournalRow, Status } from "./api";
import { track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { nav } from "./nav";
import { Icon, SettingsLink } from "./ui";

const KIND: Record<string, string> = {
  item_update: "Details", identify: "Identified", image: "Picture", image_removed: "Picture removed", collection: "Collection",
  subtitle: "Subtitle", segment: "Intro/credits", storage: "Storage", file_trashed: "Moved to trash", rename: "Renamed files",
};

interface Entry {
  key: string;
  at: number;
  kind: string;
  what: string;
  itemId: string | null;
  undone: boolean;
  undo: () => Promise<unknown>;
}

/** Everything Media Hub changed, newest first, from every screen. Undo any of it. */
export default function History({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    Promise.all([api.journalAll(500), api.history().catch(() => [] as Batch[])])
      .then(([j, b]) => {
        const a: Entry[] = j.map((r: JournalRow) => {
          const [id, kind] = r.target.split("|");
          return {
            key: `j${r.id}`, at: r.at, kind: r.action, undone: r.undone,
            what: `${r.title || (r.action === "collection" ? "Collection" : "Title")}${kind ? ` · ${kind}` : ""}`,
            itemId: /^[0-9a-f]{32}$/.test(id) ? id : null,
            undo: () => api.undoChange(r.id),
          };
        });
        const c: Entry[] = b.map((x) => ({
          key: `b${x.batch}`, at: x.at, kind: "rename", undone: x.undone >= x.files, itemId: null,
          what: `${x.files} file${x.files === 1 ? "" : "s"} · ${x.example}`,
          undo: () => api.undo(x.batch),
        }));
        setEntries([...a, ...c].sort((p, q) => q.at - p.at));
      })
      .catch((e) => setError(errorText(e)));
  }, [epoch]);

  const kinds = [...new Set((entries ?? []).map((e) => e.kind))];
  const shown = (entries ?? []).filter((e) => (!filter || e.kind === filter) && (!query || e.what.toLowerCase().includes(query.toLowerCase())));
  let lastDay = "";

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>History and undo</h1>
          <div className="muted small">Every change Media Hub made: details, pictures, subtitles, markers, collections, renames, files moved to the trash folder.</div>
        </div>
      </div>
      {status.readOnly && <p className="note">Undoing changes in Jellyfin needs changes switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      {error && <p className="error">{error}</p>}
      <div className="toolbar">
        <div className="chips">
          <button className={`chip ${!filter ? "on" : ""}`} onClick={() => setFilter("")}>Everything</button>
          {kinds.map((k) => <button key={k} className={`chip ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>{KIND[k] ?? k}</button>)}
        </div>
        <label className="searchbox"><Icon name="search" /><input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      {!entries && !error && <p className="muted">Loading…</p>}
      {entries && entries.length === 0 && <p className="muted">Nothing changed yet.</p>}
      <div className="card list-card">
        {shown.map((e) => {
          const day = new Date(e.at * 1000).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
          const head = day !== lastDay;
          lastDay = day;
          return (
            <div key={e.key}>
              {head && <div className="hist-day small muted">{day}</div>}
              <div className="hist-row">
                <span className="chip static">{KIND[e.kind] ?? e.kind}</span>
                <button className="names link-plain" disabled={!e.itemId} onClick={() => e.itemId && nav.open(e.itemId)}>
                  <div className={`ellipsis ${e.undone ? "muted" : ""}`}>{e.what}</div>
                  <div className="muted small">{new Date(e.at * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
                </button>
                {e.undone ? <span className="muted small">Undone</span> : (
                  <button onClick={() => void askConfirm(`Undo this change (${KIND[e.kind] ?? e.kind})?`, { okLabel: "Undo" }).then((ok) => { if (ok) void track("Undoing", e.undo).catch((err) => setError(errorText(err))); })}>Undo</button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
