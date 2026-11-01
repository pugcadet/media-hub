// Clean-up → Names and years: one plain layout for the whole library.
// Movies: folder, video and subtitles "Title (Year)". Shows: the year on the show folder only,
// episodes in "Season 07" folders without the year. One batch, undoable in History.
import { useEffect, useMemo, useState } from "react";
import { api, errorText, PlanOp, Status } from "./api";
import { Icon, TriCheck, useUndoableSet } from "./ui";
import { prefs } from "./prefs";
import { useRun } from "./FolderTidy";

interface TidyTitle { id: string; name: string; kind: "series" | "movie"; folder: string; ops: PlanOp[] }

const last = (p: string) => p.split("/").pop() ?? p;

export default function Tidy({ status }: { status: Status }) {
  const [plan, setPlan] = useState<{ planId: string; titles: TidyTitle[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const sel = useUndoableSet<string>();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const p = await api.tidyNamesPlan(prefs().renameOff);
      setPlan(p);
      sel.reset(p.titles.filter((t) => t.ops.some((o) => o.status === "ok")).map((t) => t.id));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { if (status.libraryRoot) void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { run, mark, bar, busy } = useRun(() => void load());

  const titles = plan?.titles ?? [];
  const movies = useMemo(() => titles.filter((t) => t.kind === "movie"), [titles]);
  const shows = useMemo(() => titles.filter((t) => t.kind === "series"), [titles]);
  const picked = titles.filter((t) => sel.has(t.id));
  const pickedOps = picked.flatMap((t) => t.ops.filter((o) => o.status === "ok"));

  async function apply() {
    if (!plan || !pickedOps.length) return;
    const owner = new Map<string, string>();
    for (const t of picked) for (const o of t.ops) owner.set(o.from, t.id);
    try {
      await run(`Names and years (${picked.length})`, plan.planId, pickedOps, (f) => owner.get(f) ?? null,
        `Tidy the names of ${picked.length} title${picked.length === 1 ? "" : "s"} (${pickedOps.length} file${pickedOps.length === 1 ? "" : "s"} and folders)?\n\nMovies: folder, video and subtitles become “Title (Year)”. Shows: the year goes on the show folder only, episodes go in “Season 07” folders.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!status.libraryRoot) return <p className="note">Choose your library folder in Settings first.</p>;
  const group = (label: string, list: TidyTitle[]) => list.length > 0 && (
    <div className="todo-group">
      <div className="todo-head">
        <TriCheck state={sel.state(list.map((t) => t.id))} onChange={(on) => sel.setMany(list.map((t) => t.id), on)} />
        <b className="grow">{label}</b>
      </div>
      <div className="tidy-list">
        {list.map((t) => {
          const ok = t.ops.filter((o) => o.status === "ok");
          const ex = ok.find((o) => o.kind === "video") ?? ok[0];
          return (
            <div key={t.id} className="tidy-row">
              <label className="check small mf-row">
                <input type="checkbox" checked={sel.has(t.id)} disabled={!ok.length} onChange={() => sel.toggle(t.id)} />
                {mark(t.id)}
                <span className="strong ellipsis">{t.name}</span>
                <span className="muted">{ok.length} change{ok.length === 1 ? "" : "s"}{ok.length < t.ops.length ? ` · ${t.ops.length - ok.length} left alone (name taken)` : ""}</span>
                {ex && <span className="mono ellipsis muted grow">{last(ex.from)} → <span className="accent">{last(ex.to)}</span></span>}
                <button className="link small" onClick={(e) => { e.preventDefault(); setOpen(open === t.id ? null : t.id); }}>{open === t.id ? "Hide" : "Show all"}</button>
              </label>
              {open === t.id && (
                <div className="struct-list">
                  {t.ops.map((o) => (
                    <div key={o.from} className={`small mono tidy-op ${o.status}`}>
                      <span className="ellipsis muted" title={o.from}>{o.from.slice(t.folder.length + 1) || last(o.from)}</span>
                      <span className="muted">→</span>
                      <span className="ellipsis accent" title={o.to}>{o.to}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
  return (
    <div className="stack">
      <div className="row between">
        <span className="muted small">Movies: folder, video and subtitles all <span className="mono">Title (Year)</span>. Shows: <span className="mono">Show (Year)/Season 07/Show - S07E01 - Title.mkv</span>. Folders you leave alone (Renamer → Folders → Options) are skipped.</span>
        <button disabled={loading || busy} onClick={() => void load()}>{loading ? <span className="spinner small-spin" /> : <Icon name="reload" />} Refresh</button>
      </div>
      {error && <p className="error">{error}</p>}
      {loading && !plan && <div className="pg-loading"><span className="spinner" /> Looking at every movie and show folder…</div>}
      {plan && titles.length === 0 && <div className="card form"><p className="ok">✓ Every movie and show already has the right names and years.</p></div>}
      {titles.length > 0 && (
        <div className="card form folders-card">
          {group(`${movies.length} movie${movies.length === 1 ? "" : "s"}: folder, video and subtitles get one name`, movies)}
          {group(`${shows.length} show${shows.length === 1 ? "" : "s"}: year on the folder, Season 07 folders, no year in the episode names`, shows)}
          {bar}
          <div className="row end">
            <button className="primary" disabled={busy || status.readOnly || !pickedOps.length} onClick={() => void apply()}>{busy ? "Working…" : `Fix ${picked.length} selected`}</button>
          </div>
        </div>
      )}
    </div>
  );
}
