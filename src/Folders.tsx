// Renamer → Folders: your main folders on the left (with a switch to leave one alone, like
// YouTube), and for the chosen one plain suggestions on the right: movies in a folder of their
// own with the right name (or together with their collection), episodes in season folders,
// featured artists into the main artist. Every change is one batch History can undo, with a
// progress bar that shows what's moving.
import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, MovieFolder, PlanOp, scanAround, Status } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { Icon, TriCheck, useUndoableSet } from "./ui";
import { agoText, useSaved } from "./saved";
import { Seg } from "./kit";
import { folderOff, setPrefs, usePrefs } from "./prefs";
import { foldersSummary, savePart } from "./scan";

export interface LooseShow { folder: string; name: string; loose: number; seasons: number }
export interface TopFolder { folder: string; kind: "tv" | "movies" | "mixed" | "empty"; shows: LooseShow[]; looseMovies: string[]; folderedMovies: string[] }
interface ArtistMerge { from: string; to: string; albums: string[] }

const last = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

/* ------------------------------------------------------------------ running a batch */

type StepState = "working" | "done" | "failed";

/** Applies a plan with a progress bar and a mark per item; returns when Jellyfin was told. */
function useRun(onDone: () => void) {
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
  return (
    <div className="folders">
      <div className="row between">
        <span className="muted small">One tidy layout: every movie in its own folder, every episode in a season folder.{structure ? ` Checked ${agoText(structure.at)}.` : ""}</span>
        <button className="primary" disabled={checking} onClick={() => void look()}>{checking ? <span className="spinner" /> : <Icon name="search" />} Look again</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="folders-split">
        <section className="folders-tops" aria-label="Your folders">
          <h2 className="folders-h">Your folders</h2>
          {list.map((t) => {
            const off = folderOff(t, p);
            const n = todoOf(t);
            return (
              <div key={t} className={`folders-top ${active === t ? "on" : ""} ${off ? "off" : n ? "warn" : "ok"}`}>
                <button className="folders-top-main" onClick={() => setSel(t)}>
                  <span className="strong">{t}</span>
                  <span className="small muted">{kindOf(t)}</span>
                  <span className={`small strong folders-state`}>{off ? "Left alone" : !structure ? "–" : n ? `${n} to tidy` : "Tidy"}</span>
                </button>
                <label className="folders-switch small" title="Off: the Renamer, the naming checks and the missing-episode check leave this folder alone">
                  Rename
                  <input type="checkbox" className="switch" checked={!off} onChange={(e) => setPrefs((x) => ({ renameOff: e.target.checked ? x.renameOff.filter((f) => f.toLowerCase() !== t.toLowerCase()) : [...x.renameOff, t] }))} />
                </label>
              </div>
            );
          })}
          <p className="small muted">Switch Rename off for a folder (like YouTube) and the Renamer, the naming checks and the missing-episode check leave it alone.</p>
        </section>

        <section className="folders-main" aria-label="Suggestions">
          {active && folderOff(active, p) && (
            <div className="card form"><h2>{active} is left alone</h2><p className="muted">Nothing here is renamed or moved. Switch Rename back on to get suggestions.</p></div>
          )}
          {active && !folderOff(active, p) && (
            <>
              <h2 className="folders-h">Suggestions for {active}</h2>
              {!structure && !movies && <div className="pg-loading"><span className="spinner" /> Looking at your folders…</div>}
              {movies && (movies.data.some((m) => m.top === active)) && <MovieSuggestions key={`m-${active}`} top={active} list={movies.data.filter((m) => m.top === active)} readOnly={status.readOnly} onDone={() => void look()} />}
              {structure && <ShowSuggestions key={`s-${active}`} folder={structure.data.find((x) => x.folder === active) ?? null} readOnly={status.readOnly} onDone={() => void look()} />}
              {/music|muziek/i.test(active) && <MusicSuggestions key={`a-${active}-${musicN}`} top={active} readOnly={status.readOnly} onDone={() => setMusicN((x) => x + 1)} />}
              {structure && movies && todoOf(active) === 0 && !/music|muziek/i.test(active) && <div className="card form"><p className="ok">✓ {active} is tidy.</p></div>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ movies */

/** Where a movie should end up and whether it's there. */
function movieWant(m: MovieFolder, keepCollections: boolean): { mode: "fix" | "collect"; to: string } {
  if (keepCollections && m.collection) return { mode: "collect", to: `${m.top}/${m.collection}/${m.expected}` };
  const parent = m.kind === "own" ? parentOf(m.folder) : m.kind === "loose" ? m.top : m.folder;
  return { mode: "fix", to: `${parent}/${m.expected}` };
}
function movieNeeds(m: MovieFolder, keepCollections: boolean): boolean {
  const w = movieWant(m, keepCollections);
  return !(m.kind === "own" && m.folder === w.to);
}

function MovieSuggestions({ top, list, readOnly, onDone }: { top: string; list: MovieFolder[]; readOnly: boolean; onDone: () => void }) {
  const { keepCollections } = usePrefs();
  const [groupOut, setGroupOut] = useState<Record<string, boolean>>({});
  const [groupName, setGroupName] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const { run, mark, bar, busy } = useRun(onDone);
  const sel = useUndoableSet<string>();

  // With collections: movies of a collection together. Otherwise: per folder they're in.
  const collected = keepCollections ? list.filter((m) => m.collection) : [];
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
    const renames = groups
      .filter(([g]) => !outOf(g) && (groupName[g] ?? last(g)).trim() && (groupName[g] ?? last(g)).trim() !== last(g))
      .map(([g]) => ({ folder: g, name: (groupName[g] ?? last(g)).trim() }));
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
      <span className="mono ellipsis" title={m.kind === "own" ? m.folder : m.video}>{m.kind === "own" ? last(m.folder) : last(m.video)}</span>
      <span className="muted">→</span>
      <span className="mono ellipsis accent" title={to}>{to.slice(top.length + 1)}</span>
    </label>
  );
  const picked = all.filter((m) => sel.has(m.video)).length;
  return (
    <div className="stack">
      <div className="card form folders-opt">
        <label className="switch-row">
          <span className="grow"><span className="strong">Keep collections together</span><br /><span className="muted small">Movies of one collection share a folder: <span className="mono">{top}/Alien Collection/Alien (1979)</span>. Jellyfin and Infuse find them either way; this is for tidiness.</span></span>
          <input type="checkbox" className="switch" checked={keepCollections} onChange={(e) => setPrefs({ keepCollections: e.target.checked })} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}

      {byColl.map(([c, ms]) => (
        <div key={c} className="card form folders-card">
          <div className="row">
            <TriCheck state={sel.state(ms.filter((m) => movieNeeds(m, true)).map((m) => m.video))} onChange={(on) => sel.setMany(ms.filter((m) => movieNeeds(m, true)).map((m) => m.video), on)} />
            <Icon name="stack" size={14} />
            <b className="grow">{c}</b>
            <span className="muted small">{ms.length} movies together in <span className="mono">{top}/{c}</span></span>
          </div>
          <div className="struct-list">{ms.filter((m) => movieNeeds(m, true)).map((m) => row(m, movieWant(m, true).to))}</div>
        </div>
      ))}

      {plain.length > 0 && (
        <div className="card form folders-card">
          <div className="row">
            <TriCheck state={sel.state(plain.map((m) => m.video))} onChange={(on) => sel.setMany(plain.map((m) => m.video), on)} />
            <b className="grow">{plain.length} movie{plain.length === 1 ? "" : "s"} get the right folder</b>
            <span className="muted small">Name and year from Jellyfin{plain.some((m) => m.kind !== "own") ? " · loose ones get a folder" : ""}</span>
          </div>
          <div className="struct-list">{plain.map((m) => row(m, movieWant(m, false).to))}</div>
        </div>
      )}

      {groups.map(([g, ms]) => {
        const out = outOf(g);
        const todo = ms.filter(needs);
        if (!out && !todo.length && (groupName[g] ?? last(g)) === last(g)) {
          return (
            <div key={g} className="card form folders-card quiet">
              <div className="row"><Icon name="folder" size={14} /><b className="grow">“{last(g)}” holds {ms.length} movies</b>
                <button className="link small" onClick={() => setGroupOut((x) => ({ ...x, [g]: true }))}>Move them out</button></div>
            </div>
          );
        }
        return (
          <div key={g} className="card form folders-card">
            <div className="row">
              <TriCheck state={sel.state(todo.map((m) => m.video))} onChange={(on) => sel.setMany(todo.map((m) => m.video), on)} />
              <Icon name="folder" size={14} />
              <b className="grow">“{last(g)}” holds {ms.length} movies</b>
              <Seg value={out ? "out" : "keep"} onChange={(v) => setGroupOut((x) => ({ ...x, [g]: v === "out" }))} options={[{ id: "keep", label: "Keep this folder" }, { id: "out", label: `Move them to “${top}”` }]} />
            </div>
            {!out && (
              <div className="small mf-rename">
                <span className="muted">Folder name</span>
                <input aria-label="Folder name" value={groupName[g] ?? last(g)} onChange={(e) => setGroupName((x) => ({ ...x, [g]: e.target.value }))} />
              </div>
            )}
            <div className="folders-diff">
              <div><span className="small strong">Now</span>{ms.slice(0, 4).map((m) => <span key={m.video} className="mono small muted ellipsis">{m.kind === "own" ? m.folder.slice(top.length + 1) : m.video.slice(top.length + 1)}</span>)}{ms.length > 4 && <span className="small muted">… {ms.length - 4} more</span>}</div>
              <div><span className="small strong">After</span>{ms.slice(0, 4).map((m) => <span key={m.video} className="mono small accent ellipsis">{out ? m.expected : `${groupName[g] ?? last(g)}/${m.expected}`}</span>)}{ms.length > 4 && <span className="small muted">… {ms.length - 4} more</span>}</div>
            </div>
            {todo.length > 0 && <div className="struct-list">{todo.map((m) => row(m, out ? `${top}/${m.expected}` : movieWant(m, false).to))}</div>}
          </div>
        );
      })}

      {bar}
      {(picked > 0 || groups.some(([g]) => !outOf(g) && (groupName[g] ?? last(g)) !== last(g))) && (
        <div className="row end"><button className="primary" disabled={busy || readOnly} onClick={() => void apply()}>{busy ? "Working…" : `Tidy ${picked} movie${picked === 1 ? "" : "s"}`}</button></div>
      )}
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
        `Put the episodes of ${actions.length} show${actions.length === 1 ? "" : "s"} in season folders (with their subtitles)?`);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <div className="card form folders-card">
      <div className="row">
        <TriCheck state={sel.state(shows.map((s) => s.folder))} onChange={(on) => sel.setMany(shows.map((s) => s.folder), on)} />
        <b className="grow">{shows.length} show{shows.length === 1 ? "" : "s"} get season folders</b>
        <span className="muted small">Episodes go into <span className="mono">Season 01</span>, <span className="mono">Season 02</span> …</span>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="struct-list">
        {shows.map((s) => (
          <label key={s.folder} className="check small mf-row">
            <input type="checkbox" checked={sel.has(s.folder)} onChange={() => sel.toggle(s.folder)} />
            {mark(s.folder)}
            <span className="ellipsis">{s.name}</span>
            <span className="muted">{s.loose} episode{s.loose === 1 ? "" : "s"} loose{s.seasons ? ` · ${s.seasons} season folder${s.seasons === 1 ? "" : "s"} already` : ""}</span>
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

