// Clean-up → Folders: the same structure everywhere. Shows get season folders, loose movies
// get a folder each (or every movie goes straight into the movies folder). You pick per folder
// and per title; every move is one batch you can undo in History.
import { useState } from "react";
import { api, errorText, scanAround, Status } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { Icon, TriCheck, useUndoableSet } from "./ui";
import { agoText, useSaved } from "./saved";

export interface LooseShow { folder: string; name: string; loose: number; seasons: number }
export interface TopFolder { folder: string; kind: "tv" | "movies" | "mixed" | "empty"; shows: LooseShow[]; looseMovies: string[]; folderedMovies: string[] }

const last = (p: string) => p.split("/").pop() ?? p;

export default function Structure({ status }: { status: Status }) {
  const [saved, save] = useSaved<TopFolder[]>("structure");
  const data = saved?.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What you ticked: "seasons:<show folder>", "own:<movie file>", "flat:<movie folder>".
  const sel = useUndoableSet<string>();
  // Per movies folder: give movies a folder each, or put them all straight in.
  const [movieMode, setMovieMode] = useState<Record<string, "own" | "flat">>({});

  async function scan() {
    setError(null);
    try {
      const r = await track("Looking at your folders", () => api.structureScan(), { reload: false });
      save(r);
      sel.reset([
        ...r.flatMap((t) => t.shows.map((s) => `seasons:${s.folder}`)),
        ...r.flatMap((t) => t.looseMovies.map((m) => `own:${m}`)),
      ]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function apply() {
    if (!data) return;
    const actions: { kind: string; path: string }[] = [];
    for (const t of data) {
      for (const s of t.shows) if (sel.has(`seasons:${s.folder}`)) actions.push({ kind: "seasons", path: s.folder });
      const mode = movieMode[t.folder] ?? "own";
      if (mode === "own" && t.looseMovies.some((m) => sel.has(`own:${m}`))) actions.push({ kind: "movie_folders", path: t.folder });
      if (mode === "flat" && t.folderedMovies.some((m) => sel.has(`flat:${m}`))) actions.push({ kind: "flatten", path: t.folder });
    }
    if (!actions.length) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await api.structurePlan(actions);
      // Only what you ticked (a movie's subtitles follow it).
      const wanted = plan.ops.filter((o) => o.status === "ok" && o.kind !== "sidecar" && (
        sel.has(`own:${o.from}`) || [...sel.set].some((k) => (k.startsWith("seasons:") && o.from.startsWith(k.slice(8) + "/")) || (k.startsWith("flat:") && o.from.startsWith(k.slice(5) + "/")))
      ));
      const skipped = plan.ops.filter((o) => o.status === "conflict").length;
      if (!wanted.length) {
        setError(skipped ? `Nothing can move: ${skipped} would clash with something already there.` : "Nothing to move.");
        return;
      }
      const folders = new Set(wanted.map((o) => o.to.split("/").slice(0, -1).join("/")));
      if (!(await askConfirm(`Move ${wanted.length} video${wanted.length === 1 ? "" : "s"} (with their subtitles) into ${folders.size} folder${folders.size === 1 ? "" : "s"}?${skipped ? `\n\n${skipped} are left where they are because the name is taken.` : ""}\n\nNothing is deleted or overwritten, and it's one batch you can undo in History. Jellyfin sees moved files as new: watched status stays (by TMDB/TVDB id).`, { okLabel: "Move" }))) return;
      await track(`Tidying folders (${wanted.length} videos)`, async (job) => {
        const rep = await api.apply(plan.planId, true, wanted.map((o) => o.from));
        job.update("Asking Jellyfin to look at the changed folders", null);
        await scanAround([...folders, ...actions.map((a) => a.path)]);
        if (rep.failed.length) throw `${rep.done} moved; ${rep.failed.length} failed: ${rep.failed[0]}`;
        job.update(`${rep.done} moved`, 1);
      });
      await scan();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const todo = (t: TopFolder) => t.shows.length + t.looseMovies.length + ((movieMode[t.folder] ?? "own") === "flat" ? t.folderedMovies.length : 0);
  const picked = [...sel.set].filter((k) => !k.startsWith("flat:") || data?.some((t) => (movieMode[t.folder] ?? "own") === "flat" && t.folderedMovies.includes(k.slice(5)))).length;

  return (
    <div className="stack">
      <div className="row between">
        <div className="muted small" style={{ maxWidth: 720 }}>
          Jellyfin and Infuse find titles in any of these layouts; this is about having one tidy structure. Shows: episodes in <span className="mono">Season 01</span> folders. Movies: either a folder per movie (what Jellyfin recommends) or every movie straight in the movies folder.
        </div>
        <div className="row end">
          {saved && <span className="muted small">Checked {agoText(saved.at)}</span>}
          <button className="primary" disabled={busy || !status.libraryRoot} onClick={() => void scan()}><Icon name="search" /> {data ? "Look again" : "Look at my folders"}</button>
        </div>
      </div>
      {!status.libraryRoot && <p className="note">Choose your library folder in Settings first.</p>}
      {error && <p className="error">{error}</p>}
      {data && data.filter((t) => t.kind !== "empty").map((t) => (
        <section key={t.folder} className="card form struct-card">
          <div className="row between">
            <div className="row"><Icon name="folder" /><h2>{t.folder}</h2><span className="chip static">{t.kind === "tv" ? "Shows" : t.kind === "movies" ? "Movies" : "Shows and movies"}</span></div>
            <span className={`small ${todo(t) ? "warn" : "ok"}`}>{todo(t) ? `${todo(t)} to tidy` : "✓ Tidy"}</span>
          </div>

          {t.shows.length > 0 && (
            <div className="struct-block">
              <div className="row">
                <TriCheck state={sel.state(t.shows.map((s) => `seasons:${s.folder}`))} onChange={(on) => sel.setMany(t.shows.map((s) => `seasons:${s.folder}`), on)} />
                <span className="strong small">Put episodes in season folders</span>
                <span className="muted small">{t.shows.length} show{t.shows.length === 1 ? "" : "s"} with episodes loose in the show folder</span>
              </div>
              <div className="struct-list">
                {t.shows.map((s) => (
                  <label key={s.folder} className="check small">
                    <input type="checkbox" checked={sel.has(`seasons:${s.folder}`)} onChange={() => sel.toggle(`seasons:${s.folder}`)} />
                    {s.name} <span className="muted">· {s.loose} episode{s.loose === 1 ? "" : "s"}{s.seasons ? ` · already ${s.seasons} season folder${s.seasons === 1 ? "" : "s"}` : ""}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {(t.looseMovies.length > 0 || t.folderedMovies.length > 0) && (
            <div className="struct-block">
              <div className="seg" role="group" aria-label="Movie layout">
                <button className={(movieMode[t.folder] ?? "own") === "own" ? "on" : ""} onClick={() => setMovieMode((m) => ({ ...m, [t.folder]: "own" }))}>A folder per movie ({t.looseMovies.length} loose)</button>
                <button className={movieMode[t.folder] === "flat" ? "on" : ""} onClick={() => { setMovieMode((m) => ({ ...m, [t.folder]: "flat" })); sel.setMany(t.folderedMovies.map((m) => `flat:${m}`), true); }}>All straight in “{last(t.folder)}” ({t.folderedMovies.length} in folders)</button>
              </div>
              {(movieMode[t.folder] ?? "own") === "own" ? (
                t.looseMovies.length ? (
                  <>
                    <div className="row">
                      <TriCheck state={sel.state(t.looseMovies.map((m) => `own:${m}`))} onChange={(on) => sel.setMany(t.looseMovies.map((m) => `own:${m}`), on)} />
                      <span className="muted small">Each gets a folder named “Title (Year)”, with its subtitles</span>
                    </div>
                    <div className="struct-list">
                      {t.looseMovies.map((m) => (
                        <label key={m} className="check small mono"><input type="checkbox" checked={sel.has(`own:${m}`)} onChange={() => sel.toggle(`own:${m}`)} />{last(m)}</label>
                      ))}
                    </div>
                  </>
                ) : <p className="muted small">Every movie already has its own folder.</p>
              ) : (
                <>
                  <div className="row">
                    <TriCheck state={sel.state(t.folderedMovies.map((m) => `flat:${m}`))} onChange={(on) => sel.setMany(t.folderedMovies.map((m) => `flat:${m}`), on)} />
                    <span className="muted small">The video and its subtitles move up; a folder that's empty afterwards is removed (posters or .nfo files keep it)</span>
                  </div>
                  <div className="struct-list">
                    {t.folderedMovies.map((m) => (
                      <label key={m} className="check small"><input type="checkbox" checked={sel.has(`flat:${m}`)} onChange={() => sel.toggle(`flat:${m}`)} />{last(m)}</label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {!todo(t) && <p className="muted small">Nothing to tidy here.</p>}
        </section>
      ))}
      {data && (
        <div className="row end struct-apply">
          {sel.canUndo && <button className="link small" onClick={sel.undo}><Icon name="undo" size={12} /> Undo selection</button>}
          <button className="primary" disabled={busy || !picked || status.readOnly} onClick={() => void apply()}>{busy ? "Working…" : `Tidy ${picked} selected`}</button>
        </div>
      )}
    </div>
  );
}
