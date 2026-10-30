// Renamer → Folders → Movie folders: the folder every movie's video sits in, checked against
// Jellyfin's title and year. Wrong folder names get fixed, loose movies get a folder of their
// own, and movies grouped in a collection folder either stay there (and the collection folder
// can be renamed) or move out into the main movies folder. One batch, undoable in History.
import { useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, MovieFolder, scanAround } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { Icon, TriCheck, useUndoableSet } from "./ui";
import { useSaved } from "./saved";
import { Seg } from "./kit";

const last = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

type Mode = "fix" | "out";

export default function MovieFolders({ readOnly }: { readOnly: boolean }) {
  const [saved, save] = useSaved<MovieFolder[]>("moviefolders");
  const list = saved?.data ?? null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = useUndoableSet<string>();
  // Per collection folder: keep the movies there, or take them out. And its new name.
  const [groupMode, setGroupMode] = useState<Record<string, Mode>>({});
  const [groupName, setGroupName] = useState<Record<string, string>>({});
  const [prog, setProg] = useState<{ done: number; total: number; now: string } | null>(null);
  const [rowState, setRowState] = useState<Record<string, "working" | "done" | "failed">>({});

  const todo = useMemo(() => (list ?? []).filter((m) => !m.ok || m.group), [list]);
  const plain = todo.filter((m) => !m.group);
  const groups = useMemo(() => {
    const g = new Map<string, MovieFolder[]>();
    for (const m of todo) if (m.group) g.set(m.group, [...(g.get(m.group) ?? []), m]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [todo]);
  const modeOf = (g: string): Mode => groupMode[g] ?? "fix";
  // In a kept collection folder, a movie that's already right needs nothing.
  const needs = (m: MovieFolder) => !m.ok || (!!m.group && modeOf(m.group) === "out");

  async function check() {
    setError(null);
    try {
      const r = await track("Checking movie folders", () => api.movieFolders(), { reload: false });
      save(r);
      sel.reset(r.filter((m) => !m.ok || m.group).map((m) => m.video));
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function apply() {
    if (!list) return;
    const moves = todo.filter((m) => sel.has(m.video) && needs(m)).map((m) => ({ video: m.video, mode: (m.group ? modeOf(m.group) : "fix") as Mode }));
    const renames = groups
      .filter(([g]) => modeOf(g) === "fix" && (groupName[g] ?? last(g)).trim() && (groupName[g] ?? last(g)).trim() !== last(g))
      .map(([g]) => ({ folder: g, name: (groupName[g] ?? last(g)).trim() }));
    if (!moves.length && !renames.length) return setError("Nothing selected to change.");
    setBusy(true);
    setError(null);
    try {
      const plan = await api.movieFoldersPlan(moves, renames);
      const ok = plan.ops.filter((o) => o.status === "ok");
      const clash = plan.ops.filter((o) => o.status === "conflict").length;
      if (!ok.length) return setError(clash ? `Nothing can move: ${clash} would clash with something already there.` : "Nothing to change.");
      const folders = ok.filter((o) => o.kind === "folder").length;
      const files = ok.filter((o) => o.kind !== "folder").length;
      if (!(await askConfirm(`${[folders ? `${folders} folder${folders === 1 ? "" : "s"} renamed or moved` : "", files ? `${files} file${files === 1 ? "" : "s"} put in a folder of their own` : ""].filter(Boolean).join(", ")}?${clash ? `\n\n${clash} left alone because the name is taken.` : ""}\n\nNothing is deleted or overwritten, and it's one batch you can undo in History. Jellyfin sees moved movies as new: watched status stays (by TMDB id).`, { okLabel: "Do it" }))) return;
      setRowState({});
      setProg({ done: 0, total: ok.length, now: "" });
      const byPath = new Map<string, string>();
      for (const m of todo) {
        byPath.set(m.video, m.video);
        byPath.set(m.folder, m.video);
      }
      await track(`Tidying movie folders (${ok.length})`, async (job) => {
        const un = await listen<{ index: number; total: number; from: string; state: "working" | "done" | "failed" }>("rename-step", (e) => {
          const p = e.payload;
          const done = p.state === "working" ? p.index : p.index + 1;
          const name = last(p.from).replace(/\.[^.]+$/, "");
          setProg({ done, total: p.total, now: name });
          job.update(`${p.state === "failed" ? "Couldn't move" : "Moving"} ${name} · ${done} of ${p.total}`, p.total ? done / p.total : null);
          const key = byPath.get(p.from);
          if (key) setRowState((m) => ({ ...m, [key]: m[key] === "failed" ? "failed" : p.state }));
        });
        let rep;
        try {
          rep = await api.apply(plan.planId, true, ok.map((o) => o.from));
        } finally {
          un();
        }
        job.update("Asking Jellyfin to look at the changed folders", null);
        await scanAround([...new Set(ok.flatMap((o) => [parentOf(o.from), parentOf(o.to)]))]);
        if (rep.failed.length) throw `${rep.done} done; ${rep.failed.length} failed: ${rep.failed[0]}`;
        job.update(`${rep.done} done`, 1);
      });
      // Let the share settle, then look again.
      window.setTimeout(() => void check(), 5000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      setProg(null);
    }
  }

  const mark = (key: string) => {
    const st = rowState[key];
    return st ? <span className={`struct-mark ${st}`}>{st === "working" ? <span className="spinner small-spin" /> : st === "done" ? <Icon name="check" size={12} /> : <Icon name="x" size={12} />}</span> : null;
  };
  const row = (m: MovieFolder, mode: Mode) => {
    const where = mode === "out" ? m.top : m.kind === "own" ? parentOf(m.folder) : m.kind === "loose" ? m.top : m.folder;
    const what = m.kind === "own" ? last(m.folder) : last(m.video);
    const right = !needs(m);
    return (
      <label key={m.video} className={`check small mf-row ${right ? "right" : ""}`}>
        <input type="checkbox" disabled={right} checked={!right && sel.has(m.video)} onChange={() => sel.toggle(m.video)} />
        {mark(m.video)}
        <span className="mono ellipsis mf-from" title={m.kind === "own" ? m.folder : m.video}>{what}</span>
        {right ? <span className="ok">✓ right</span> : <>
          <span className="muted">→</span>
          <span className="mono ellipsis accent" title={`${where}/${m.expected}`}>{mode === "out" || m.kind === "loose" ? `${last(m.top)}/` : ""}{m.expected}{m.kind === "own" ? "" : `/${last(m.video)}`}</span>
        </>}
      </label>
    );
  };
  const picked = todo.filter((m) => sel.has(m.video) && needs(m)).length;
  const groupRenames = groups.filter(([g]) => modeOf(g) === "fix" && (groupName[g] ?? last(g)).trim() !== last(g)).length;

  return (
    <section className="card form struct-card">
      <div className="row between">
        <div>
          <div className="row"><Icon name="film" /><h2>Movie folders</h2></div>
          <div className="muted small">Each movie in a folder of its own named “Title (Year)”, from what Jellyfin knows. Movies grouped in a collection folder can stay there or move out.</div>
        </div>
        <button className="primary" disabled={busy} onClick={() => void check()}><Icon name="search" /> {list ? "Check again" : "Check movie folders"}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {list && todo.length === 0 && <p className="ok small">✓ Every movie has a folder of its own with the right name.</p>}

      {plain.length > 0 && (
        <div className="struct-block">
          <div className="row">
            <TriCheck state={sel.state(plain.map((m) => m.video))} onChange={(on) => sel.setMany(plain.map((m) => m.video), on)} />
            <span className="strong small">Folder names to fix</span>
            <span className="muted small">{plain.length} movie{plain.length === 1 ? "" : "s"}{plain.some((m) => m.kind !== "own") ? " (loose ones get a folder of their own)" : ""}</span>
          </div>
          <div className="struct-list">{plain.map((m) => row(m, "fix"))}</div>
        </div>
      )}

      {groups.map(([g, ms]) => {
        const mode = modeOf(g);
        return (
          <div key={g} className="struct-block mf-group">
            <div className="row between">
              <div className="row">
                <TriCheck state={sel.state(ms.filter(needs).map((m) => m.video))} onChange={(on) => sel.setMany(ms.filter(needs).map((m) => m.video), on)} />
                <Icon name="folder" size={14} />
                <span className="strong small mono">{last(g)}</span>
                <span className="muted small">{ms.length} movie{ms.length === 1 ? "" : "s"} in this folder</span>
              </div>
              <Seg value={mode} onChange={(v) => setGroupMode((x) => ({ ...x, [g]: v }))} options={[
                { id: "fix", label: "Keep them in this folder" },
                { id: "out", label: `Move them to “${last(ms[0].top)}”` },
              ]} />
            </div>
            {mode === "fix" && (
              <div className="small mf-rename">
                <span className="muted">Rename the folder</span>
                <input aria-label="Folder name" value={groupName[g] ?? last(g)} onChange={(e) => setGroupName((x) => ({ ...x, [g]: e.target.value }))} />
                {(groupName[g] ?? last(g)) !== last(g) && <button className="link small" onClick={() => setGroupName((x) => ({ ...x, [g]: last(g) }))}>Keep “{last(g)}”</button>}
              </div>
            )}
            {mode === "out" && <div className="muted small">The movies move out into “{last(ms[0].top)}”, each in a folder of its own. The collection folder is removed once it's empty (anything else in it keeps it).</div>}
            <div className="struct-list">{ms.map((m) => row(m, mode))}</div>
          </div>
        );
      })}

      {prog && (
        <div className="struct-progress" role="status">
          <div className="row between small"><span className="ellipsis">{prog.now ? <>Moving <b>{prog.now}</b></> : "Starting…"}</span><span className="mono">{prog.done} of {prog.total} · {prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%</span></div>
          <div className="struct-bar"><span style={{ width: `${prog.total ? (prog.done / prog.total) * 100 : 0}%` }} /></div>
        </div>
      )}
      {list && todo.length > 0 && (
        <div className="row end">
          {sel.canUndo && <button className="link small" onClick={sel.undo}><Icon name="undo" size={12} /> Undo selection</button>}
          <button className="primary" disabled={busy || readOnly || (!picked && !groupRenames)} onClick={() => void apply()}>
            {busy ? (prog ? `Working… ${prog.total ? Math.round((prog.done / prog.total) * 100) : 0}%` : "Working…") : `Fix ${picked} movie${picked === 1 ? "" : "s"}${groupRenames ? ` and rename ${groupRenames} folder${groupRenames === 1 ? "" : "s"}` : ""}`}
          </button>
        </div>
      )}
    </section>
  );
}
