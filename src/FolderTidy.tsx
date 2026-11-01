// Renamer → Folders: your main folders on the left (with a switch to leave one alone, like
// YouTube), and for the chosen one plain suggestions on the right: movies in a folder of their
// own with the right name (or together with their collection), episodes in season folders,
// featured artists into the main artist. Every change is one batch History can undo, with a
// progress bar that shows what's moving.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, MovieFolder, PlanOp, scanAround, Status } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { Icon, TriCheck, useUndoableSet } from "./ui";
import { agoText, useSaved } from "./saved";
import { KTabs } from "./kit";
import { folderOff, setPrefs, usePrefs } from "./prefs";
import { foldersSummary, savePart } from "./scan";
import { nav } from "./nav";

export interface LooseShow { folder: string; name: string; loose: number; seasons: number; messy?: string[] }
export interface TopFolder { folder: string; kind: "tv" | "movies" | "mixed" | "empty"; shows: LooseShow[]; looseMovies: string[]; folderedMovies: string[] }
interface ArtistMerge { from: string; to: string; albums: string[] }

const last = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

/* ------------------------------------------------------------------ running a batch */

type StepState = "working" | "done" | "failed";

/** Applies a plan with a progress bar and a mark per item; returns when Jellyfin was told. */
export function useRun(onDone: () => void) {
  const [prog, setProg] = useState<{ done: number; total: number; now: string } | null>(null);
  const [marks, setMarks] = useState<Record<string, StepState>>({});
  const [busy, setBusy] = useState(false);
  async function run(label: string, planId: string, ops: PlanOp[], keyOf: (from: string) => string | null, confirm: string) {
    const ok = ops.filter((o) => o.status === "ok");
    const clash = ops.length - ok.length;
    if (!ok.length) throw clash ? `Nothing can move: ${clash} would clash with something already there.` : "Nothing to change.";
    if (!(await askConfirm(`${confirm}${clash ? `\n\n${clash} left alone because the name is taken.` : ""}\n\nNothing is deleted or overwritten, and it's one batch you can undo in History.`, { okLabel: "Do it" }))) return;
    setBusy(true);
    setMarks({});
    setProg({ done: 0, total: ok.length, now: "" });
    try {
      await track(label, async (job) => {
        const un = await listen<{ index: number; total: number; from: string; state: StepState }>("rename-step", (e) => {
          const p = e.payload;
          const done = p.state === "working" ? p.index : p.index + 1;
          const name = last(p.from).replace(/\.[^.]+$/, "");
          setProg({ done, total: p.total, now: name });
          job.update(`${p.state === "failed" ? "Couldn't move" : "Moving"} ${name} · ${done} of ${p.total}`, p.total ? done / p.total : null);
          const key = keyOf(p.from);
          if (key) setMarks((m) => ({ ...m, [key]: m[key] === "failed" ? "failed" : p.state }));
        });
        let rep;
        try {
          rep = await api.apply(planId, true, ok.map((o) => o.from));
        } finally {
          un();
        }
        job.update("Asking Jellyfin to look at the changed folders", null);
        await scanAround([...new Set(ok.flatMap((o) => [parentOf(o.from), parentOf(o.to)]))]);
        if (rep.failed.length) throw `${rep.done} done; ${rep.failed.length} failed: ${rep.failed[0]}`;
        job.update(`${rep.done} done`, 1);
      });
      // Let the share settle, then look again.
      window.setTimeout(onDone, 4000);
    } finally {
      setBusy(false);
      setProg(null);
    }
  }
  const mark = (key: string) => {
    const st = marks[key];
    return st ? <span className={`struct-mark ${st}`}>{st === "working" ? <span className="spinner small-spin" /> : st === "done" ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}</span> : null;
  };
  const bar = prog && (
    <div className="struct-progress" role="status">
      <div className="row between small"><span className="ellipsis">{prog.now ? <>Moving <b>{prog.now}</b></> : "Starting…"}</span><span className="mono">{prog.done} of {prog.total} · {prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%</span></div>
      <div className="struct-bar"><span style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} /></div>
    </div>
  );
  return { run, mark, bar, busy };
}

/* ------------------------------------------------------------------ the page */

export default function Folders({ status }: { status: Status }) {
  const p = usePrefs();
  const [structure, saveStructure] = useSaved<TopFolder[]>("structure");
  const [movies, saveMovies] = useSaved<MovieFolder[]>("moviefolders");
  const [tops, setTops] = useState<string[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [musicN, setMusicN] = useState(0);

  useEffect(() => {
    api.folders("").then((f) => setTops(f.map((x) => x.name))).catch(() => setTops([]));
  }, []);

  async function look() {
    setError(null);
    setChecking(true);
    try {
      await track("Looking at your folders", async (job) => {
        job.update("Folders on the NAS", 0.2);
        const s = await api.structureScan();
        saveStructure(s);
        savePart("folders", foldersSummary(s, Date.now()));
        job.update("Movies in Jellyfin", 0.6);
        saveMovies(await api.movieFolders());
        setMusicN((x) => x + 1);
      }, { reload: false });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setChecking(false);
    }
  }
  // The first time: look by itself.
  useEffect(() => {
    if (status.libraryRoot && !structure && !movies) void look();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const kindOf = (t: string): string => {
    const s = structure?.data.find((x) => x.folder === t);
    if (/music|muziek/i.test(t)) return "Music";
    if (!s) return "";
    return s.kind === "tv" ? "Shows" : s.kind === "movies" ? "Movies" : s.kind === "mixed" ? "Shows and movies" : "Empty";
  };
  const todoOf = (t: string): number => {
    if (folderOff(t, p)) return 0;
    const s = structure?.data.find((x) => x.folder === t);
    const shows = s?.shows.length ?? 0;
    const mv = (movies?.data ?? []).filter((m) => m.top === t && movieNeeds(m, p.keepCollections)).length;
    return shows + mv;
  };
  const list = tops ?? [];
  const active = sel && list.includes(sel) ? sel : list.find((t) => todoOf(t) > 0) ?? list[0] ?? null;

  if (!status.libraryRoot) return <p className="note">Choose your library folder in Settings first.</p>;
  const off = active ? folderOff(active, p) : false;
  return (
    <div className="folders-page">
      <div className="folders-bar">
        <KTabs active={active ?? ""} onChange={setSel} tabs={list.map((t) => ({ id: t, label: t, count: folderOff(t, p) ? null : structure ? todoOf(t) || null : null, warn: todoOf(t) > 0 }))} />
        <span className="grow" />
        <span className="muted small">{structure ? `Checked ${agoText(structure.at)}` : ""}</span>
        <button disabled={checking} onClick={() => void look()}>{checking ? <span className="spinner small-spin" /> : <Icon name="reload" />} Refresh</button>
      </div>
      {error && <p className="error">{error}</p>}
      {active && (
        <details className="folders-options small">
          <summary className="muted">Options for {active}</summary>
          <label className="switch-row"><span className="grow">Leave {active} alone<br /><span className="muted">Nothing in it is renamed or moved (for example YouTube). The Renamer and the episode checks skip it too.</span></span>
            <input type="checkbox" className="switch" checked={off} onChange={(e) => setPrefs((x) => ({ renameOff: !e.target.checked ? x.renameOff.filter((f) => f.toLowerCase() !== active.toLowerCase()) : [...x.renameOff, active] }))} />
          </label>
          {kindOf(active) !== "Shows" && kindOf(active) !== "Music" && (
            <label className="switch-row"><span className="grow">Keep collections together<br /><span className="muted">Movies of one Jellyfin collection share a folder, e.g. <span className="mono">{active}/Alien Collection/Alien (1979)</span>. Jellyfin and Infuse find them either way.</span></span>
              <input type="checkbox" className="switch" checked={p.keepCollections} onChange={(e) => setPrefs({ keepCollections: e.target.checked })} />
            </label>
          )}
        </details>
      )}
      {active && off && <div className="card form"><p className="muted">{active} is left alone. Turn that off under Options to tidy it.</p></div>}
      {active && !off && (
        <div className="folders-main">
          {!structure && !movies && <div className="pg-loading"><span className="spinner" /> Looking at your folders…</div>}
          {movies && movies.data.some((m) => m.top === active) && <MovieSuggestions key={`m-${active}`} top={active} list={movies.data.filter((m) => m.top === active)} readOnly={status.readOnly} onDone={() => void look()} />}
          {structure && <ShowSuggestions key={`s-${active}`} folder={structure.data.find((x) => x.folder === active) ?? null} readOnly={status.readOnly} onDone={() => void look()} />}
          {/music|muziek/i.test(active) && <MusicSuggestions key={`a-${active}-${musicN}`} top={active} readOnly={status.readOnly} onDone={() => setMusicN((x) => x + 1)} />}
          {structure && movies && todoOf(active) === 0 && !/music|muziek/i.test(active) && <div className="card form"><p className="ok">✓ Everything in {active} is tidy.</p></div>}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ movies */

/** Where a movie should end up and whether it's there. */
function movieWant(m: MovieFolder, keepCollections: boolean): { mode: "fix" | "collect"; to: string } {
  if (m.kind === "nested") return { mode: "fix", to: `${parentOf(parentOf(m.folder))}/${m.expected}` };
  if (keepCollections && m.collection) return { mode: "collect", to: `${m.top}/${m.collection}/${m.expected}` };
  const parent = m.kind === "own" ? parentOf(m.folder) : m.kind === "loose" ? m.top : m.folder;
  return { mode: "fix", to: `${parent}/${m.expected}` };
}
function movieNeeds(m: MovieFolder, keepCollections: boolean): boolean {
  if (m.doubt) return false;
  if (m.kind === "nested") return true;
  const w = movieWant(m, keepCollections);
  return !(m.kind === "own" && m.folder === w.to);
}

function MovieSuggestions({ top, list: everything, readOnly, onDone }: { top: string; list: MovieFolder[]; readOnly: boolean; onDone: () => void }) {
  const doubtful = everything.filter((m) => m.doubt);
  const list = everything.filter((m) => !m.doubt);
  const { keepCollections } = usePrefs();
  const [groupOut, setGroupOut] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const { run, mark, bar, busy } = useRun(onDone);
  const sel = useUndoableSet<string>();

  // With collections: movies of a collection together. Otherwise: per folder they're in.
  const collected = keepCollections ? list.filter((m) => m.collection && m.kind !== "nested") : [];
  const rest = list.filter((m) => !collected.includes(m));
  const byColl = useMemo(() => {
    const g = new Map<string, MovieFolder[]>();
    for (const m of collected) g.set(m.collection!, [...(g.get(m.collection!) ?? []), m]);
    return [...g.entries()].filter(([, ms]) => ms.some((m) => movieNeeds(m, true))).sort((a, b) => a[0].localeCompare(b[0]));
  }, [collected]);
  const plain = rest.filter((m) => !m.group && movieNeeds(m, false));
  const groups = useMemo(() => {
    const g = new Map<string, MovieFolder[]>();
    for (const m of rest) if (m.group) g.set(m.group, [...(g.get(m.group) ?? []), m]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rest]);
  const outOf = (g: string) => !!groupOut[g];
  const needs = (m: MovieFolder) => (collected.includes(m) ? movieNeeds(m, true) : m.group && outOf(m.group) ? true : movieNeeds(m, false));
  const all = [...collected, ...rest].filter(needs);
  useEffect(() => { sel.reset(all.map((m) => m.video)); }, [list, keepCollections]); // eslint-disable-line react-hooks/exhaustive-deps

  async function apply() {
    const moves = all.filter((m) => sel.has(m.video)).map((m) => ({ video: m.video, mode: (collected.includes(m) ? "collect" : m.group && outOf(m.group) ? "out" : "fix") as "fix" | "out" | "collect" }));
    const renames: { folder: string; name: string }[] = [];
    if (!moves.length && !renames.length) return setError("Nothing selected to change.");
    setError(null);
    try {
      const plan = await api.movieFoldersPlan(moves, renames);
      const byPath = new Map<string, string>();
      for (const m of list) { byPath.set(m.video, m.video); byPath.set(m.folder, m.video); }
      const ok = plan.ops.filter((o) => o.status === "ok");
      const folders = ok.filter((o) => o.kind === "folder").length;
      const files = ok.filter((o) => o.kind !== "folder").length;
      await run(`Tidying movie folders (${ok.length})`, plan.planId, plan.ops, (f) => byPath.get(f) ?? null,
        `${[folders ? `${folders} folder${folders === 1 ? "" : "s"} renamed or moved` : "", files ? `${files} file${files === 1 ? "" : "s"} put in a folder of their own` : ""].filter(Boolean).join(", ")}? Jellyfin sees moved movies as new; watched status stays (by TMDB id).`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const row = (m: MovieFolder, to: string) => (
    <label key={m.video} className="check small mf-row">
      <input type="checkbox" checked={sel.has(m.video)} onChange={() => sel.toggle(m.video)} />
      {mark(m.video)}
      <span className="mono ellipsis" title={m.kind === "own" || m.kind === "nested" ? m.folder : m.video}>{m.kind === "nested" ? `${last(parentOf(m.folder))}/${last(m.folder)}` : m.kind === "own" ? last(m.folder) : last(m.video)}</span>
      <span className="muted">→</span>
      <span className="mono ellipsis accent" title={to}>{to.slice(top.length + 1)}</span>
    </label>
  );
  const picked = all.filter((m) => sel.has(m.video)).length;
  const section = (key: string, title: string, items: MovieFolder[], to: (m: MovieFolder) => string, extra?: ReactNode) => items.length > 0 && (
    <div key={key} className="todo-group">
      <div className="todo-head">
        <TriCheck state={sel.state(items.map((m) => m.video))} onChange={(on) => sel.setMany(items.map((m) => m.video), on)} />
        <b className="grow">{title}</b>
        {extra}
      </div>
      <div className="struct-list">{items.map((m) => row(m, to(m)))}</div>
    </div>
  );
  const named = plain.filter((m) => m.kind !== "nested");
  const nested = plain.filter((m) => m.kind === "nested");
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return (
    <div className="card form folders-card">
      {error && <p className="error">{error}</p>}
      {doubtful.length > 0 && (
        <div className="todo-group warn">
          <div className="todo-head"><Icon name="warn" size={14} /><b className="grow">{n(doubtful.length, "movie may be identified wrong", "movies may be identified wrong")}: left alone</b></div>
          <div className="muted small">Jellyfin's name doesn't match the file. Identify it, then press Refresh.</div>
          <div className="struct-list">
            {doubtful.map((m) => (
              <div key={m.video} className="small mf-row">
                <span className="mono ellipsis" title={m.video}>{last(m.video)}</span>
                <span className="muted">Jellyfin says</span>
                <span className="strong ellipsis">{m.title}{m.year ? ` (${m.year})` : ""}</span>
                <button className="link small" onClick={() => nav.open(m.id)}>Identify…</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {section("named", n(named.length, "movie folder gets the right name", "movie folders get the right name"), named, (m) => movieWant(m, false).to)}
      {section("nested", n(nested.length, "movie is in an extra folder inside its own folder", "movies are in an extra folder inside their own folder"), nested, (m) => movieWant(m, false).to)}
      {byColl.map(([c, ms]) => section(`c-${c}`, `${c}: ${n(ms.filter((m) => movieNeeds(m, true)).length, "movie goes", "movies go")} together`, ms.filter((m) => movieNeeds(m, true)), (m) => movieWant(m, true).to))}
      {groups.map(([g, ms]) => {
        const out = outOf(g);
        const todo = ms.filter(needs);
        if (!todo.length && !out) return null;
        return section(`g-${g}`, out ? `“${last(g)}”: ${n(ms.length, "movie moves", "movies move")} out to ${top}` : `In “${last(g)}”: ${n(todo.length, "movie gets", "movies get")} a folder of its own`, out ? ms : todo,
          (m) => (out ? `${top}/${m.expected}` : movieWant(m, false).to),
          <button className="link small" onClick={() => setGroupOut((x) => ({ ...x, [g]: !out }))}>{out ? "Keep them in this folder" : `Move them to ${top} instead`}</button>);
      })}
      {bar}
      {picked > 0 && <div className="row end"><button className="primary" disabled={busy || readOnly} onClick={() => void apply()}>{busy ? "Working…" : `Fix ${picked} selected`}</button></div>}
      {picked === 0 && all.length === 0 && doubtful.length === 0 && <p className="ok">✓ Every movie folder in {top} is right.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ shows */

function ShowSuggestions({ folder, readOnly, onDone }: { folder: TopFolder | null; readOnly: boolean; onDone: () => void }) {
  const sel = useUndoableSet<string>();
  const [error, setError] = useState<string | null>(null);
  const { run, mark, bar, busy } = useRun(onDone);
  const shows = folder?.shows ?? [];
  useEffect(() => { sel.reset(shows.map((s) => s.folder)); }, [folder]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!shows.length) return null;
  async function apply() {
    const actions = shows.filter((s) => sel.has(s.folder)).map((s) => ({ kind: "seasons", path: s.folder }));
    if (!actions.length) return;
    setError(null);
    try {
      const plan = await api.structurePlan(actions);
      const wanted = plan.ops;
      await run(`Season folders (${actions.length} show${actions.length === 1 ? "" : "s"})`, plan.planId, wanted, (f) => shows.find((s) => f.startsWith(s.folder + "/"))?.folder ?? null,
        `Give ${actions.length} show${actions.length === 1 ? "" : "s"} proper season folders? Loose episodes move in (with their subtitles) and downloaded season folders are renamed "Season NN".`);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="card form folders-card">
      <div className="row">
        <TriCheck state={sel.state(shows.map((s) => s.folder))} onChange={(on) => sel.setMany(shows.map((s) => s.folder), on)} />
        <b className="grow">{shows.length} show{shows.length === 1 ? "" : "s"} get proper season folders</b>
        <span className="muted small">Loose episodes and downloaded season folders (<span className="mono">You.S05.1080p…</span>) become <span className="mono">Season 05</span></span>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="struct-list">
        {shows.map((s) => (
          <label key={s.folder} className="check small mf-row">
            <input type="checkbox" checked={sel.has(s.folder)} onChange={() => sel.toggle(s.folder)} />
            {mark(s.folder)}
            <span className="ellipsis">{s.name}</span>
            <span className="muted ellipsis">{[s.loose ? `${s.loose} episode${s.loose === 1 ? "" : "s"} loose` : "", s.messy?.length ? `${s.messy.length} season folder${s.messy.length === 1 ? "" : "s"} to rename (${s.messy[0].slice(0, 40)}${s.messy[0].length > 40 ? "…" : ""})` : ""].filter(Boolean).join(" · ")}</span>
          </label>
        ))}
      </div>
      {bar}
      <div className="row end"><button className="primary" disabled={busy || readOnly || !sel.set.size} onClick={() => void apply()}>{busy ? "Working…" : `Tidy ${sel.set.size} show${sel.set.size === 1 ? "" : "s"}`}</button></div>
    </div>
  );
}

/* ------------------------------------------------------------------ music */

function MusicSuggestions({ top, readOnly, onDone }: { top: string; readOnly: boolean; onDone: () => void }) {
  const [merges, setMerges] = useState<ArtistMerge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sel = useUndoableSet<string>();
  const { run, mark, bar, busy } = useRun(onDone);
  useEffect(() => {
    api.musicArtistMerges(top).then((m) => { setMerges(m); sel.reset(m.map((x) => x.from)); }).catch((e) => setError(errorText(e)));
  }, [top]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="error">{error}</p>;
  if (!merges) return <div className="pg-loading"><span className="spinner" /> Looking at the artists…</div>;
  if (!merges.length) return <div className="card form"><p className="ok">✓ No featured artists with folders of their own.</p></div>;
  async function apply() {
    try {
      const plan = await api.musicMergePlan(top, merges!.filter((m) => sel.has(m.from)).map((m) => m.from));
      await run("Featured artists into their main artist", plan.planId, plan.ops, (f) => merges!.find((m) => f.startsWith(m.from + "/"))?.from ?? null,
        `Move the albums of ${sel.set.size} featured-artist folder${sel.set.size === 1 ? "" : "s"} into the main artist's folder?`);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="card form folders-card">
      <div className="row">
        <TriCheck state={sel.state(merges.map((m) => m.from))} onChange={(on) => sel.setMany(merges.map((m) => m.from), on)} />
        <b className="grow">{merges.length} featured-artist folder{merges.length === 1 ? "" : "s"} go with the main artist</b>
        <span className="muted small">So one artist doesn't get several folders</span>
      </div>
      <div className="struct-list">
        {merges.map((m) => (
          <label key={m.from} className="check small mf-row">
            <input type="checkbox" checked={sel.has(m.from)} onChange={() => sel.toggle(m.from)} />
            {mark(m.from)}
            <span className="mono ellipsis">{last(m.from)}</span>
            <span className="muted">→</span>
            <span className="mono ellipsis accent">{last(m.to)}/ ({m.albums.length} album{m.albums.length === 1 ? "" : "s"})</span>
          </label>
        ))}
      </div>
      {bar}
      <div className="row end"><button className="primary" disabled={busy || readOnly || !sel.set.size} onClick={() => void apply()}>{busy ? "Working…" : `Merge ${sel.set.size}`}</button></div>
    </div>
  );
}

