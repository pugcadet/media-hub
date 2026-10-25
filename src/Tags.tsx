import { useEffect, useMemo, useState } from "react";
import { api, errorText, Status, TagStat } from "./api";
import { track, useEpoch } from "./activity";
import { askChoice, Icon } from "./ui";
import { askConfirm } from "./confirm";

/** "sci-fi", "Sci Fi", "Science Fiction" → the same key, to suggest merges. */
function key(n: string): string {
  return n.toLowerCase().replace(/&/g, "and").replace(/science fiction/g, "scifi").replace(/[^a-z0-9]/g, "");
}

/** Genres and tags across the library: merge look-alikes, rename, remove junk. */
export default function Tags({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [stats, setStats] = useState<TagStat[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<"genre" | "tag">("genre");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const canEdit = !status.readOnly;

  useEffect(() => {
    api.tagStats().then(setStats).catch((e) => setError(errorText(e)));
  }, [epoch]);
  useEffect(() => setPicked(new Set()), [kind]);

  const list = (stats ?? []).filter((t) => t.kind === kind);
  const suggestions = useMemo(() => {
    const groups = new Map<string, TagStat[]>();
    for (const t of list) groups.set(key(t.name), [...(groups.get(key(t.name)) ?? []), t]);
    return [...groups.values()].filter((g) => g.length > 1);
  }, [list]);
  const shown = list.filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  async function mergeInto(from: string[], suggested?: string) {
    const r = await askChoice(
      `Merge ${from.map((f) => `“${f}”`).join(", ")} into…`,
      list.filter((t) => !from.includes(t.name)).slice(0, 40).map((t) => ({ value: t.name, label: t.name, hint: `${t.count}` })).concat(suggested ? [{ value: suggested, label: suggested, hint: "suggested" }] : []),
      { label: "Or type a new name", placeholder: suggested ?? "", okLabel: "Merge" },
    );
    if (!r) return;
    const to = "text" in r ? r.text : r.value;
    await run(from, to);
  }

  async function run(from: string[], to: string | null) {
    try {
      const n = await track(to ? `Merging into “${to}”` : `Removing ${from.length} ${kind}${from.length === 1 ? "" : "s"}`, () => api.tagsMerge(kind, from, to));
      void n;
      setPicked(new Set());
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Genres and tags</h1>
          <div className="muted small">Clean up look-alikes such as “Sci-Fi” and “Science Fiction”. Each title changed is one entry in History, so it can be undone. Lock a title's details if Jellyfin keeps putting a genre back.</div>
        </div>
        <div className="seg">
          <button className={kind === "genre" ? "on" : ""} onClick={() => setKind("genre")}>Genres</button>
          <button className={kind === "tag" ? "on" : ""} onClick={() => setKind("tag")}>Tags</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {!canEdit && <p className="note">Changing genres needs changes switched on in Settings.</p>}
      {suggestions.length > 0 && (
        <section className="card form">
          <h2>Look-alikes</h2>
          {suggestions.map((g) => {
            const best = [...g].sort((a, b) => b.count - a.count)[0];
            return (
              <div key={key(best.name)} className="row between">
                <span>{g.map((t) => `${t.name} (${t.count})`).join(" · ")}</span>
                <button disabled={!canEdit} onClick={() => void run(g.filter((t) => t !== best).map((t) => t.name), best.name)}>Merge into “{best.name}”</button>
              </div>
            );
          })}
        </section>
      )}
      <div className="toolbar">
        <div className="row">
          <span className="muted small">{list.length} {kind}s{picked.size ? ` · ${picked.size} selected` : ""}</span>
          {picked.size > 0 && (
            <>
              <button disabled={!canEdit} onClick={() => void mergeInto([...picked])}>{picked.size > 1 ? "Merge…" : "Rename…"}</button>
              <button className="danger-outline" disabled={!canEdit} onClick={() => void askConfirm(`Remove ${[...picked].map((p) => `“${p}”`).join(", ")} from every title?`, { okLabel: "Remove", danger: true }).then((ok) => { if (ok) void run([...picked], null); })}>Remove</button>
            </>
          )}
        </div>
        <label className="searchbox"><Icon name="search" /><input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      {!stats && !error && <p className="muted">Reading the library…</p>}
      <div className="tag-grid">
        {shown.map((t) => (
          <label key={t.name} className={`tag-cell ${picked.has(t.name) ? "on" : ""}`}>
            <input type="checkbox" checked={picked.has(t.name)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(t.name)) n.delete(t.name); else n.add(t.name); return n; })} />
            <span className="grow ellipsis">{t.name}</span>
            <span className="muted small">{t.count}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
