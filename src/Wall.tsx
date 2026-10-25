// The library "wall": posters grouped by folder, flags for what's missing, and a bar to fix
// many titles at once. Folder boxes show a stripe when part of the folder is selected.
import { useEffect, useMemo, useState } from "react";
import { api, CheckRow, cleanTitle, HealthRow, imageUrl, Item, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { addToCollection, Icon, itemMenu, openMenu, playTitle, TriCheck, useUndoableSet } from "./ui";
import { CORE_ART, fixSummary, fixTitles, FixKind, FixTarget, namesToFix, targetOf } from "./fixers";
import { askConfirm } from "./confirm";

export type Problem = "" | "id" | "art" | "subs" | "names";

const PROBLEMS: { id: Problem; label: string }[] = [
  { id: "id", label: "Not identified" },
  { id: "art", label: "Missing art" },
  { id: "subs", label: "No subtitles" },
  { id: "names", label: "Names to fix" },
];

interface Entry {
  id: string;
  name: string;
  year: number | null;
  kind: "movie" | "series";
  hasPoster: boolean;
  played: boolean;
  sub: string;
  folder: string;
  health: HealthRow | null;
  check: CheckRow | null;
}

function flagsOf(e: Entry): { key: Problem; label: string; bad?: boolean }[] {
  const out: { key: Problem; label: string; bad?: boolean }[] = [];
  const h = e.health;
  if (h && !h.identified) out.push({ key: "id", label: "ID", bad: true });
  if (h && CORE_ART.some((a) => !h[a.key])) out.push({ key: "art", label: "ART", bad: !h.poster });
  if (h && h.noSubs > 0) out.push({ key: "subs", label: "SUBS" });
  if (namesToFix(e.check)) out.push({ key: "names", label: "NAMES" });
  return out;
}

function has(e: Entry, p: Problem): boolean {
  return !p || flagsOf(e).some((f) => f.key === p);
}

function subOf(i: Item): string {
  if (i.kind === "series") return [i.year, i.seasons ? `${i.seasons} season${i.seasons === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return [i.year, i.runtime ? `${Math.round(i.runtime)} min` : ""].filter(Boolean).join(" · ");
}

/**
 * `items` is what the library page loaded (sorted and searched). With a problem filter the
 * wall lists every title with that problem straight from the last health check instead.
 */
export default function Wall({ items, status, problem, onProblem, query, kind }: {
  items: Item[]; status: Status; problem: Problem; onProblem: (p: Problem) => void; query: string; kind: "movie" | "series" | null;
}) {
  const epoch = useEpoch();
  const [health, setHealth] = useState<Map<string, HealthRow>>(new Map());
  const [checks, setChecks] = useState<Map<string, CheckRow>>(new Map());
  const [healthAt, setHealthAt] = useState<number | null>(null);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const sel = useUndoableSet<string>();
  const canEdit = !status.readOnly;

  useEffect(() => {
    api.libraryHealth(false).then((h) => { setHealth(new Map(h.rows.map((r) => [r.id, r]))); setHealthAt(h.at); }).catch(() => undefined);
    api.namingCheckLast().then((r) => setChecks(new Map((r?.rows ?? []).map((x) => [x.id, x])))).catch(() => undefined);
  }, [epoch]);

  const entries: Entry[] = useMemo(() => {
    if (problem) {
      const q = query.toLowerCase();
      return [...health.values()]
        .filter((h) => (!kind || h.kind === kind) && (!q || h.name.toLowerCase().includes(q)))
        .map((h) => ({ id: h.id, name: h.name, year: h.year, kind: h.kind, hasPoster: h.poster, played: false, sub: [h.year, h.kind === "series" ? `${h.videos} episodes` : "Movie"].filter(Boolean).join(" · "), folder: h.libraryFolder, health: h, check: checks.get(h.id) ?? null }))
        .filter((e) => has(e, problem))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    return items.map((i) => {
      const h = health.get(i.id) ?? null;
      return { id: i.id, name: cleanTitle(i.name, i.year), year: i.year, kind: i.kind, hasPoster: i.hasPoster, played: i.played, sub: subOf(i), folder: h?.libraryFolder ?? "", health: h, check: checks.get(i.id) ?? null };
    });
  }, [items, health, checks, problem, query, kind]);

  const groups = useMemo(() => {
    const g = new Map<string, Entry[]>();
    for (const e of entries) g.set(e.folder || "Other", [...(g.get(e.folder || "Other") ?? []), e]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [entries]);
  const allIds = entries.map((e) => e.id);
  const picked = entries.filter((e) => sel.has(e.id));
  const selecting = sel.size > 0;
  const count = (p: Problem) => [...health.values()].filter((h) => (!kind || h.kind === kind) && has({ id: h.id, name: h.name, year: h.year, kind: h.kind, hasPoster: h.poster, played: false, sub: "", folder: "", health: h, check: checks.get(h.id) ?? null }, p)).length;

  const targets = (): FixTarget[] => picked.filter((e) => e.health).map((e) => targetOf(e.health!, e.check));
  function run(what: FixKind, label: string) {
    const list = targets();
    if (!list.length) return;
    void track(`${label}: ${list.length} title${list.length === 1 ? "" : "s"}`, async (job) => {
      const r = await fixTitles(list, [what], status.subLangs, job);
      job.update(fixSummary(r), 1);
    }, { cancellable: true }).catch(() => undefined);
  }
  async function renameSelected() {
    const sure = picked.filter((e) => e.check?.sure);
    if (!sure.length) return;
    if (!(await askConfirm(`Rename ${sure.length} title${sure.length === 1 ? "" : "s"} that are a 100% match? ${picked.length - sure.length ? `${picked.length - sure.length} others need a look in the Renamer first. ` : ""}Nothing is deleted or overwritten; every rename can be undone.`, { okLabel: "Rename" }))) return;
    run("rename", "Renaming");
  }
  function lock(on: boolean) {
    const ids = picked.map((e) => e.id);
    void track(`${on ? "Locking" : "Unlocking"} ${ids.length} titles`, () => api.lockAll(on, ids).then(() => undefined), { stop: "bulk" }).catch(() => undefined);
  }

  const tile = (e: Entry) => {
    const flags = flagsOf(e);
    const on = sel.has(e.id);
    const click = () => (selecting ? sel.toggle(e.id) : nav.open(e.id));
    return (
      <div key={e.id} className={`wall-tile ${on ? "picked" : ""}`} onContextMenu={(ev) => openMenu(ev, [
        { label: on ? "Unselect" : "Select", run: () => sel.toggle(e.id) },
        { sep: true },
        ...itemMenu({ id: e.id, kind: e.kind, title: e.name, played: e.played }, canEdit),
      ])}>
        <button className="wall-art" onClick={click} title={e.name}>
          {e.hasPoster ? <img src={imageUrl(e.id, "Primary", 300)} alt="" loading="lazy" decoding="async" onError={(x) => ((x.target as HTMLImageElement).style.visibility = "hidden")} /> : <span className="noart">{e.name}</span>}
          {flags.length > 0 && <span className="wall-flags">{flags.map((f) => <span key={f.key} className={f.bad ? "bad" : "warn"} title={PROBLEMS.find((p) => p.id === f.key)?.label}>{f.label}</span>)}</span>}
          {e.played && <span className="played" title="Watched">✓</span>}
          {!selecting && <span className="tile-play" role="button" aria-label={`Play ${e.name}`} onClick={(x) => { x.stopPropagation(); if (e.kind === "movie") nav.play(e.id); else void playTitle(e.id); }}><Icon name="play" size={20} /></span>}
        </button>
        <span className="wall-check"><input type="checkbox" checked={on} onChange={() => sel.toggle(e.id)} aria-label={`Select ${e.name}`} /></span>
        <button className="wall-text" onClick={() => nav.open(e.id)}>
          <span className="title ellipsis">{e.name}</span>
          <span className="sub ellipsis">{e.sub}</span>
        </button>
      </div>
    );
  };

  return (
    <div className={`wall ${selecting ? "selecting" : ""}`}>
      <div className="wall-bar">
        <TriCheck state={sel.state(allIds)} onChange={(on) => sel.setMany(allIds, on)} title="Select all shown" />
        <span className="muted small">{selecting ? `${sel.size} selected` : `${entries.length} titles`}</span>
        <div className="chips">
          <button className={`chip ${problem === "" ? "on" : ""}`} onClick={() => onProblem("")}>All</button>
          {PROBLEMS.map((p) => {
            const n = count(p.id);
            return <button key={p.id} className={`chip ${problem === p.id ? "on" : ""}`} disabled={!n && problem !== p.id} onClick={() => onProblem(problem === p.id ? "" : p.id)}>{p.label} ({n})</button>;
          })}
        </div>
        {sel.canUndo && <button className="link small" onClick={sel.undo}><Icon name="undo" size={12} /> Undo selection</button>}
        <span className="spacer" />
        {healthAt && <span className="muted small" title="Flags come from the last library health check">Flags from {new Date(healthAt * 1000).toLocaleDateString()}</span>}
      </div>

      {groups.map(([g, list]) => {
        const ids = list.map((e) => e.id);
        const isClosed = closed.has(g);
        return (
          <section key={g} className="wall-group">
            {groups.length > 1 && (
              <div className="wall-group-head">
                <TriCheck state={sel.state(ids)} onChange={(on) => sel.setMany(ids, on)} title={`Select everything in ${g}`} />
                <button className="link-plain wall-group-name" onClick={() => setClosed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
                  <span className={`chev ${isClosed ? "" : "open"}`}><Icon name="chevron" size={12} /></span>
                  <Icon name="folder" size={14} /> {g}
                </button>
                <span className="muted small">{ids.filter((i) => sel.has(i)).length ? `${ids.filter((i) => sel.has(i)).length} of ${ids.length} selected` : `${ids.length} titles`}</span>
              </div>
            )}
            {!isClosed && <div className="wall-grid">{list.map(tile)}</div>}
          </section>
        );
      })}

      {selecting && (
        <div className="wall-actions" role="toolbar">
          <span className="strong">{sel.size} selected</span>
          <button className="primary" disabled={!canEdit} onClick={() => run("art", "Artwork")}><Icon name="image" /> Fill in art</button>
          <button disabled={!canEdit} onClick={() => run("subs", "Subtitles")}><Icon name="subtitles" /> Get subtitles</button>
          <button disabled={!canEdit || !picked.some((e) => e.check?.sure)} title="Only titles that are a 100% match" onClick={() => void renameSelected()}><Icon name="rename" /> Rename</button>
          <button disabled={!canEdit} onClick={() => lock(true)}><Icon name="lock" /> Lock</button>
          <button disabled={!canEdit} onClick={() => lock(false)}>Unlock</button>
          <button disabled={!canEdit} onClick={() => void addToCollection(picked.map((e) => e.id))}><Icon name="stack" /> Collection</button>
          <button className="link-plain wall-clear" onClick={() => sel.setMany(sel.set, false)} title="Clear the selection"><Icon name="x" /></button>
        </div>
      )}
    </div>
  );
}
