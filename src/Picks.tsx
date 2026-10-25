// Picks of the day you can edit: take titles out, put your own in. Your changes are kept per
// day and go to Jellyfin (and so Infuse) like the automatic picks.
import { folderMap } from "./folders";
import { useEffect, useState } from "react";
import { api, cleanTitle, imageUrl, Item, localDate, Pick } from "./api";
import { prefs, setPrefs, usePrefs, type Prefs } from "./prefs";
import { syncPicks } from "./scheduler";
import { CheckMenu, Icon, useUndoableSet } from "./ui";

/** Today's picks with your edits applied. */
export async function getPicks(date: string = localDate()): Promise<Pick[]> {
  const folders = prefs().picksFolders;
  let only: string[] | null = null;
  if (folders.length) {
    const map = await folderMap();
    only = [...map.entries()].filter(([, f]) => folders.includes(f)).map(([id]) => id);
    if (!only.length) only = null;
  }
  const auto = await api.picks(date, only);
  const e = prefs().pickEdits[date];
  if (!e) return auto;
  const out = auto.filter((p) => !e.remove.includes(p.id));
  for (const a of e.add) if (!out.some((p) => p.id === a.id)) out.unshift(a);
  return out;
}

function asPick(i: Item): Pick {
  const meta = [i.year, i.kind === "series" ? (i.seasons ? `${i.seasons} season${i.seasons === 1 ? "" : "s"}` : "Show") : i.runtime ? `${Math.round(i.runtime)} min` : "Movie"].filter(Boolean).join(" · ");
  return { id: i.id, artId: i.id, title: cleanTitle(i.name, i.year), why: "Your pick", meta };
}

export function PicksEditor({ onClose }: { onClose: () => void }) {
  const today = localDate();
  const { pickEdits, picksFolders } = usePrefs();
  const [list, setList] = useState<Pick[] | null>(null);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Item[]>([]);
  useEffect(() => void getPicks(today).then(setList).catch(() => setList([])), [today, pickEdits, picksFolders.join("|")]);
  useEffect(() => {
    if (!query.trim()) return setFound([]);
    const t = setTimeout(() => api.list(null, query.trim(), "name", 0, 12).then(setFound).catch(() => setFound([])), 200);
    return () => clearTimeout(t);
  }, [query]);
  const edits = pickEdits[today] ?? { add: [], remove: [] };
  const save = (e: { add: Pick[]; remove: string[] }) => setPrefs((p) => ({ pickEdits: { [today]: e, ...Object.fromEntries(Object.entries(p.pickEdits).filter(([d]) => d >= today && d !== today)) } }));
  const remove = (id: string) => save({ add: edits.add.filter((a) => a.id !== id), remove: [...new Set([...edits.remove, id])] });
  const add = (i: Item) => { save({ add: [asPick(i), ...edits.add.filter((a) => a.id !== i.id)], remove: edits.remove.filter((r) => r !== i.id) }); setQuery(""); };
  const done = () => { void syncPicks(today).catch(() => undefined); onClose(); };

  return (
    <div className="overlay confirm-layer" onClick={done}>
      <div className="card picks-editor" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2>Today's picks</h2><button className="link-plain" onClick={done} aria-label="Close"><Icon name="x" /></button></div>
        <FolderPicker label="Picks come from" pref="picksFolders" />
        <label className="searchbox"><Icon name="search" /><input autoFocus placeholder="Add a show or movie" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        {found.length > 0 && (
          <div className="pick-found">
            {found.map((i) => (
              <button key={i.id} className="tool-row" onClick={() => add(i)}>
                <div className="thumb">{i.hasPoster ? <img src={imageUrl(i.id, "Primary", 80)} alt="" /> : null}</div>
                <div className="names"><div className="title">{cleanTitle(i.name, i.year)}</div><div className="muted small">{i.kind === "series" ? "Show" : "Movie"}{i.year ? ` · ${i.year}` : ""}</div></div>
                <Icon name="plus" />
              </button>
            ))}
          </div>
        )}
        <div className="pick-edit-list">
          {(list ?? []).map((p) => (
            <div key={p.id} className="pick-edit">
              <img src={imageUrl(p.artId, "Primary", 120)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
              <div className="grow"><div className="strong">{p.title}</div><div className="muted small">{p.why} · {p.meta}</div></div>
              <button className="icon-btn" title="Take it out" aria-label={`Remove ${p.title}`} onClick={() => remove(p.id)}><Icon name="x" /></button>
            </div>
          ))}
          {list && list.length === 0 && <p className="muted">No picks left. Add one above.</p>}
        </div>
        <div className="row between">
          <button className="link small" disabled={!edits.add.length && !edits.remove.length} onClick={() => setPrefs((p) => { const n = { ...p.pickEdits }; delete n[today]; return { pickEdits: n }; })}>Back to the automatic picks</button>
          <button className="primary" onClick={done}>Done</button>
        </div>
      </div>
    </div>
  );
}

/** Library folders to draw from (empty = every folder), saved in a prefs list. */
export function FolderPicker({ label, pref }: { label: string; pref: "randomFolders" | "picksFolders" }) {
  const p = usePrefs();
  const [folders, setFolders] = useState<string[]>([]);
  const sel = useUndoableSet<string>();
  useEffect(() => {
    api.libraryHealth(false).then((h) => {
      const f = [...new Set(h.rows.map((r) => r.libraryFolder || "Other"))].sort();
      setFolders(f);
      sel.reset(p[pref].length ? p[pref].filter((x) => f.includes(x)) : f);
    }).catch(() => setFolders([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!folders.length) return;
    const on = folders.filter((f) => sel.has(f));
    setPrefs({ [pref]: on.length === folders.length ? [] : on } as Partial<Prefs>);
  }, [sel.set]); // eslint-disable-line react-hooks/exhaustive-deps
  if (folders.length < 2) return null;
  return (
    <div className="row">
      <span className="small strong">{label}</span>
      <CheckMenu label="Folders" options={folders.map((f) => ({ id: f, label: f }))} sel={sel} allLabel="Every folder" />
    </div>
  );
}

