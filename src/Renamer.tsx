import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, titleYear, applyPlan, scanAround, Batch, Candidate, CheckResult, CheckRow, errorText, FindReplace, imageUrl, PlanArgs, PlanOp, PlanResult, remoteImageUrl, Status } from "./api";
import { askConfirm } from "./confirm";
import type { View } from "./nav";
import { nav } from "./nav";
import { track, useEpoch, useRenameSteps, type StepState } from "./activity";
import { BulkSelect, Icon, itemMenu, openMenu, TriCheck, useUndoableSet } from "./ui";
import { folderTabs, IconBtn, KTabs, PageHead, SearchBox, Seg } from "./kit";
import { usePageState } from "./saved";
import { Studio, StudioItem } from "./Studio";
import Structure from "./Structure";
import { setPrefs, usePrefs, withShowYear, yearOptional, minimalNames, type Prefs } from "./prefs";

type Source = PlanArgs["source"];
type Kind = "auto" | "tv" | "movie";

const STYLES: Record<"tv" | "movie", { id: string; label: string; hint: string; value: string }[]> = {
  tv: [
    { id: "standard", label: "Standard", hint: "Bluey (2018) - S01E02 - Hotel.mkv · works everywhere", value: "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}" },
    { id: "short", label: "Short", hint: "S01E02 - Hotel.mkv", value: "{show}< ({year})>/{seasondir}/{sxe}< - {title}>.{ext}" },
    { id: "clean", label: "Clean", hint: "02 Hotel.mkv · Infuse folders only, Jellyfin may not read it", value: "{show}< ({year})>/{seasondir}/{e:00}< {title}>.{ext}" },
  ],
  movie: [
    { id: "standard", label: "Standard", hint: "The Matrix (1999)/The Matrix (1999).mkv", value: "{title}< ({year})>/{title}< ({year})>.{ext}" },
    { id: "ids", label: "With TMDB id", hint: "The Matrix (1999) {tmdb-603}", value: "{title}< ({year})>< {tmdbtag}>/{title}< ({year})>< {tmdbtag}>.{ext}" },
    { id: "flat", label: "No movie folders", hint: "The Matrix (1999).mkv", value: "{title}< ({year})>.{ext}" },
  ],
};
const SHOW_YEAR: { id: Prefs["showYear"]; label: string; hint: string }[] = [
  { id: "folder", label: "Show folder only", hint: "Bluey (2018)/Season 01/Bluey - S01E02.mkv · recommended" },
  { id: "everywhere", label: "Folder and every file", hint: "Bluey (2018) - S01E02.mkv" },
  { id: "never", label: "No year", hint: "Bluey/Season 01/Bluey - S01E02.mkv" },
];

/** Where the year goes in show names. Movies always get it. */
export function ShowYearPicker() {
  const { showYear } = usePrefs();
  return (
    <div className="stack-s">
      <div className="strong small">Year in show names</div>
      <div className="seg">
        {SHOW_YEAR.map((o) => <button key={o.id} className={showYear === o.id ? "on" : ""} title={o.hint} onClick={() => setPrefs({ showYear: o.id })}>{o.label}</button>)}
      </div>
      <div className="muted small">
        {SHOW_YEAR.find((o) => o.id === showYear)?.hint}. The year in the folder helps Jellyfin pick the right show when there are remakes; the episode files don't need it.
        {" Show folders all get the same pattern; episode files that only differ by the year are left alone. Watched status stays (Jellyfin keeps it by TMDB/TVDB id) and Media Hub moves the skip markers over to the renamed show."}
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = { auto: "Automatic", jellyfin: "My Jellyfin library", tmdb: "TMDB", tvmaze: "TVmaze", none: "Don't look online" };

const last = (p: string) => p.split("/").pop() ?? p;
const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

/** A file's rename while it happens: spinner, then green check or red cross. */
function StepMark({ s }: { s: StepState | undefined }) {
  if (!s) return null;
  if (s === "working") return <span className="spinner small-spin" title="Renaming…" />;
  return <span className={`step-mark ${s}`} title={s === "done" ? "Renamed" : "Not renamed"}><Icon name={s === "done" ? "check" : "x"} size={12} /></span>;
}

function stateOf(o: PlanOp): { label: string; cls: string } {
  if (o.status === "conflict") return { label: "Clash", cls: "bad" };
  if (o.status === "unparsed") return { label: "Not understood", cls: "bad" };
  if (o.status === "unchanged") return { label: "Already right", cls: "muted" };
  if (o.kind === "video" && ((o.score ?? 100) < 80 || !o.verified)) return { label: "Check", cls: "warn" };
  return { label: "Will rename", cls: "ok" };
}

/** Right-click on a file or folder in a rename list. */
function fileMenu(o: PlanOp) {
  return [
    { label: "Open folder", run: () => void api.revealRel(o.from).catch(() => undefined) },
    { label: "Copy the current name", run: () => void navigator.clipboard?.writeText(last(o.from)).catch(() => undefined) },
    ...(o.from !== o.to ? [{ label: "Copy the new name", run: () => void navigator.clipboard?.writeText(last(o.to)).catch(() => undefined) }] : []),
  ];
}

/** Folder tree of the result, with renamed folders marked. */
function FolderTree({ ops, base }: { ops: PlanOp[]; base: string }) {
  const tree = useMemo(() => {
    const folders = new Map<string, { files: number; renamedFrom?: string }>();
    for (const o of ops) {
      if (o.kind === "folder") {
        const cur = folders.get(o.to) ?? { files: 0 };
        folders.set(o.to, { ...cur, renamedFrom: o.status === "ok" ? last(o.from) : undefined });
      } else if (o.kind === "video") {
        const d = dirOf(o.to);
        const cur = folders.get(d) ?? { files: 0 };
        folders.set(d, { ...cur, files: cur.files + 1 });
        // make sure parent folders show up
        let p = dirOf(d);
        while (p && p.length >= base.length && !folders.has(p)) {
          folders.set(p, { files: 0 });
          p = dirOf(p);
        }
      }
    }
    return [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [ops, base]);
  const root = base.split("/").slice(0, -1).join("/");
  return (
    <div className="tree">
      {root && <div className="tree-row muted"><span className="ico">▸</span>{root}</div>}
      {tree.map(([path, info]) => {
        const depth = path.split("/").length - (root ? root.split("/").length : 0) - 1;
        return (
          <div key={path} className="tree-row" style={{ paddingLeft: 10 + depth * 18 }}>
            <span className="ico">📁</span>
            <span className={info.renamedFrom ? "ok strong" : ""}>{last(path)}</span>
            {info.renamedFrom && <span className="muted small">was “{info.renamedFrom}”</span>}
            {info.files > 0 && <span className="muted small">· {info.files} video{info.files === 1 ? "" : "s"}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** How Infuse (through Jellyfin) will list it: show, seasons, episode numbers and titles. */
function InfusePreview({ plan, poster }: { plan: PlanResult; poster: string | null }) {
  const videos = plan.ops.filter((o) => o.kind === "video" && o.status !== "unparsed" && o.status !== "conflict");
  const [season, setSeason] = useState<number | null>(null);
  if (plan.mode === "movie") {
    return (
      <div className="infuse movies">
        {videos.slice(0, 60).map((o) => (
          <div key={o.from} className="if-movie">
            <div className="if-poster"><span>{o.title ?? stripExt(last(o.to))}</span></div>
            <div className="small strong ellipsis">{stripExt(last(dirOf(o.to)) || last(o.to)).replace(/\s*\{.*\}$/, "")}</div>
          </div>
        ))}
      </div>
    );
  }
  const seasons = [...new Set(videos.map((o) => o.season ?? 0))].sort((a, b) => (a === 0 ? 99 : a) - (b === 0 ? 99 : b));
  const cur = season ?? seasons[0] ?? 1;
  const eps = videos.filter((o) => (o.season ?? 0) === cur).sort((a, b) => (a.episodes[0] ?? 0) - (b.episodes[0] ?? 0));
  const showName = plan.chosen?.name ?? plan.guess;
  const year = plan.chosen?.year;
  return (
    <div className="infuse">
      <div className="if-head">
        {poster ? <img src={poster} alt="" className="if-cover" /> : <div className="if-cover empty">{showName}</div>}
        <div>
          <div className="if-title">{showName}</div>
          <div className="muted small">{year ? `${year} · ` : ""}{seasons.length} season{seasons.length === 1 ? "" : "s"} · {videos.length} episodes</div>
        </div>
      </div>
      <div className="if-seasons">
        {seasons.map((s) => <button key={s} className={s === cur ? "on" : ""} onClick={() => setSeason(s)}>{s === 0 ? "Specials" : `Season ${s}`}</button>)}
      </div>
      <div className="if-eps">
        {eps.map((o) => (
          <div key={o.from} className="if-ep">
            <span className="if-num">{o.episodes.join("–")}</span>
            <span className={o.title ? "" : "muted"}>{o.title ?? `Episode ${o.episodes[0]}`}</span>
            {o.episodes.length > 1 && <span className="muted small">shown as episode {o.episodes[0]} only</span>}
          </div>
        ))}
      </div>
      <p className="muted small">Titles come from {plan.chosen ? `${SOURCE_LABEL[plan.chosen.source]} (the match above)` : "the file names"}. After Jellyfin scans the new names, Infuse shows them like this.</p>
    </div>
  );
}

interface Preset {
  folder: string;
  kind: Kind;
  matchId: string | null;
  onlyFile: string | null;
  itemId: string | null;
  label?: string;
}

function FolderFix({ status, onChanged, preset, embedded, onDone }: { status: Status; onChanged: () => void; preset?: Preset; embedded?: boolean; onDone?: () => void }) {
  const [base, setBase] = useState("");
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("auto");
  const [style, setStyle] = useState<Record<"tv" | "movie", string>>({ tv: STYLES.tv[0].value, movie: STYLES.movie[0].value });
  const [custom, setCustom] = useState(false);
  const [source, setSource] = useState<Source>("auto");
  const live = useRenameSteps();
  const [matchId, setMatchId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState("");
  const [renameFolder, setRenameFolder] = useState<boolean | null>(null);
  const [seasonFolders, setSeasonFolders] = useState(false);
  const [rules, setRules] = useState<FindReplace[]>([]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  // What changes, file by file, comes first; the Infuse preview is one click away.
  const [tab, setTab] = useState<"infuse" | "files">("files");
  const sel = useUndoableSet<string>();
  const picked = sel.set;
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [removeEmpty, setRemoveEmpty] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [done, setDone] = useState<{ batch: string; count: number } | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);
  const [onlyFile, setOnlyFile] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const presetRef = useRef<Preset | undefined>(preset);
  const root = status.libraryRoot;
  const { showYear } = usePrefs();
  /** The pattern to use: shows get the year where Settings wants it (custom patterns as typed). */
  const tpl = (m: "tv" | "movie") => (m === "tv" && !custom ? withShowYear(style.tv, showYear) : style[m]);

  // Start on a given show or movie (from the library check or an item page).
  useEffect(() => {
    if (!preset) return;
    presetRef.current = preset;
    setKind(preset.kind);
    setTarget(preset.folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.folder, preset?.itemId]);

  useEffect(() => {
    if (!root) return;
    api.folders(base).then(setFolders).catch((e) => { setMessage({ text: errorText(e), error: true }); setFolders([]); });
  }, [root, base]);
  const loadHistory = useCallback(() => void api.history().then(setHistory).catch(() => setHistory([])), []);
  useEffect(() => loadHistory(), [loadHistory]);

  const mode: "tv" | "movie" = plan?.mode === "movie" || kind === "movie" ? "movie" : "tv";

  const preview = useCallback(async (over: Partial<{ matchId: string | null; source: Source; search: string; year: string; kind: Kind; template: string; renameFolder: boolean | null; seasonFolders: boolean; onlyFile: string | null; itemId: string | null }> = {}) => {
    if (target === null) return;
    setBusy("Reading the folder and looking it up…");
    setMessage(null);
    setDone(null);
    try {
      const k = over.kind ?? kind;
      const yv = (over.year ?? year).trim();
      const sv = (over.search ?? search).trim();
      const m = k === "auto" ? (plan?.mode as "tv" | "movie" | undefined) : k;
      const template = over.template ?? tpl(m ?? "tv");
      const rf = over.renameFolder !== undefined ? over.renameFolder : renameFolder;
      const result = await api.plan({
        mode: k, folder: target, template, show: sv || null, year: yv ? Number(yv) : null, yearOptional: yearOptional(),
        findReplace: rules.filter((r) => r.find), recursive: true,
        source: over.source ?? source, matchId: over.matchId !== undefined ? over.matchId : matchId,
        renameFolder: rf, seasonFolders: over.seasonFolders ?? seasonFolders,
        onlyFile: over.onlyFile !== undefined ? over.onlyFile : onlyFile, itemId: over.itemId !== undefined ? over.itemId : itemId,
      });
      // The first look decides show/movie; use that style if the guess changed.
      if (k === "auto" && !over.template && result.mode !== (m ?? "tv")) {
        const again = await api.plan({
          mode: result.mode as "tv" | "movie", folder: target, template: tpl(result.mode as "tv" | "movie"), show: sv || null, year: yv ? Number(yv) : null, yearOptional: yearOptional(),
          findReplace: rules.filter((r) => r.find), recursive: true, source: over.source ?? source, matchId: null, renameFolder: rf, seasonFolders: over.seasonFolders ?? seasonFolders,
        });
        setPlan(again);
        sel.reset(again.ops.filter((o) => o.status === "ok").map((o) => o.from));
      } else {
        setPlan(result);
        sel.reset(result.ops.filter((o) => o.status === "ok").map((o) => o.from));
      }
      if (result.warning) setMessage({ text: result.warning, error: false });
    } catch (e) {
      setPlan(null);
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }, [target, kind, year, search, plan?.mode, style, custom, showYear, renameFolder, rules, source, matchId, seasonFolders, onlyFile, itemId]);

  useEffect(() => {
    setPlan(null);
    setSearch("");
    setYear("");
    setRenameFolder(null);
    setDone(null);
    const p = presetRef.current;
    if (p && p.folder === target) {
      setMatchId(p.matchId);
      if (p.matchId) setSource("jellyfin");
      setOnlyFile(p.onlyFile);
      setItemId(p.itemId);
      if (target !== null) void preview({ matchId: p.matchId, search: "", year: "", renameFolder: null, kind: p.kind, onlyFile: p.onlyFile, itemId: p.itemId, source: p.matchId ? "jellyfin" : undefined, template: p.kind === "auto" ? undefined : tpl(p.kind as "tv" | "movie") });
    } else {
      setMatchId(null);
      setOnlyFile(null);
      setItemId(null);
      if (target !== null) void preview({ matchId: null, search: "", year: "", renameFolder: null, onlyFile: null, itemId: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const previewFor = () => preview({ search: "", year: "", renameFolder: null });
  // The year setting changed: look again with the new pattern.
  useEffect(() => {
    if (plan && !custom) void preview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showYear]);

  async function apply() {
    if (!plan || !picked.size) return;
    const files = plan.ops.filter((o) => o.kind !== "folder" && picked.has(o.from)).length;
    const dirs = plan.ops.filter((o) => o.kind === "folder" && picked.has(o.from)).length;
    const what = [files ? `${files} file${files === 1 ? "" : "s"}` : "", dirs ? `${dirs} folder${dirs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    if (!(await askConfirm(`Rename ${what}? Nothing is deleted or overwritten, and you can undo it.`, { okLabel: "Rename" }))) return;
    setBusy("Renaming…");
    try {
      const rep = await applyPlan(plan, removeEmpty, [...picked], matchId?.startsWith("jellyfin:") ? matchId.slice(9) : null, target);
      setDone({ batch: rep.batch, count: rep.done });
      if (rep.failed.length) setMessage({ text: `${rep.failed.length} skipped: ${rep.failed.slice(0, 3).join("; ")}`, error: true });
      // Follow the renamed folder, so "check again" looks at the right place.
      const top = plan.ops.find((o) => o.kind === "folder" && o.from === target && picked.has(o.from));
      setPlan(null);
      loadHistory();
      onChanged();
      void scanAround([target ?? ""]);
      if (presetRef.current && top) presetRef.current = { ...presetRef.current, folder: top.to };
      if (top) setTarget(top.to);
      onDone?.();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function undo(batch: string, files: number) {
    if (!(await askConfirm(`Put ${files} item(s) back to their old names?`, { okLabel: "Undo" }))) return;
    try {
      const rep = await api.undo(batch);
      setMessage({ text: `Put back ${rep.restored} item(s).` + (rep.skipped.length ? ` Skipped: ${rep.skipped.slice(0, 3).join("; ")}` : ""), error: rep.skipped.length > 0 });
      setDone(null);
      loadHistory();
      setTarget(null);
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  const ops = plan?.ops ?? [];
  const sorted = useMemo(() => {
    const f = ops.filter((o) => o.kind === "folder");
    const v = ops.filter((o) => o.kind !== "folder").sort((a, b) => a.to.localeCompare(b.to));
    return [...f, ...v];
  }, [ops]);
  const rows = sorted.filter((o) => !onlyChanges || (o.status !== "unchanged"));
  // Grouped by folder, each with a checkbox for everything in it.
  const dirGroups = useMemo(() => {
    const g = new Map<string, PlanOp[]>();
    for (const o of rows) {
      const k = o.kind === "folder" ? "Folders" : dirOf(o.from) || "(top)";
      g.set(k, [...(g.get(k) ?? []), o]);
    }
    return [...g.entries()];
  }, [rows]);
  const okOf = (list: PlanOp[]) => list.filter((o) => o.status === "ok").map((o) => o.from);
  const counts = useMemo(() => {
    const c = { files: 0, folders: 0, check: 0, problems: 0, right: 0 };
    for (const o of ops) {
      const s = stateOf(o).label;
      if (o.status === "unchanged") c.right++;
      if (s === "Check") c.check++;
      if (s === "Clash" || s === "Not understood") c.problems++;
      if (picked.has(o.from)) { if (o.kind === "folder") c.folders++; else c.files++; }
    }
    return c;
  }, [ops, picked]);
  const poster = (c: Candidate | null | undefined) => (c?.poster ? remoteImageUrl(c.poster) : c?.source === "jellyfin" ? imageUrl(c.id, "Primary", 240) : null);
  const crumbs = base ? base.split("/") : [];
  const visible = folders.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()));
  const allRight = plan && counts.files + counts.folders === 0 && counts.problems === 0;
  const topFolderOp = ops.find((o) => o.kind === "folder" && o.from === target);

  if (!root) {
    return (
      <div className="pg">
        <div className="pg-head"><h1>Renamer</h1></div>
        <div className="card form narrow-card">
          <h2>Choose your library folder</h2>
          <p className="muted">Pick the NAS share as it appears on this computer (for example /Volumes/media on a Mac, or M:\ on Windows). The renamer only works inside this folder.</p>
          <button className="primary" onClick={() => void api.pickRoot().then(() => onChanged()).catch((e) => setMessage({ text: errorText(e), error: true }))}>Choose folder</button>
        </div>
      </div>
    );
  }

  return (
    <div className={embedded ? "stack" : "stack"}>
      {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

      {/* 1 · folder */}
      {target === null && embedded ? (
        <p className="muted">Finding the files…</p>
      ) : target === null ? (
        <section className="card picker">
          <div className="picker-head">
            <span className="step-dot">1</span>
            <div className="grow">
              <div className="strong">Pick the folder to fix</div>
              <div className="muted small">A show folder (with its seasons inside), or a folder with movies.</div>
            </div>
            <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="picker-path">
            <button className="link" onClick={() => setBase("")}>{last(root)}</button>
            {crumbs.map((c, i) => <span key={i}><span className="muted"> › </span><button className="link" onClick={() => setBase(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
            <div className="spacer" />
            {base && <button onClick={() => setTarget(base)}>Fix “{last(base)}”</button>}
          </div>
          <div className="picker-list">
            {base && <button className="picker-row up" onClick={() => setBase(crumbs.slice(0, -1).join("/"))}><span className="ico">↰</span><span className="muted">Up one level</span></button>}
            {visible.map((f) => {
              const rel = base ? `${base}/${f.name}` : f.name;
              return (
                <div className="picker-row" key={f.name}>
                  <button className="picker-open" onClick={() => { setBase(rel); setFilter(""); }}><span className="ico">📁</span><span>{f.name}</span></button>
                  <button className="primary small-btn" onClick={() => setTarget(rel)}>Fix this</button>
                </div>
              );
            })}
            {visible.length === 0 && <div className="muted small pad">No folders here.</div>}
          </div>
        </section>
      ) : (
        <section className="card chosen">
          <span className="step-dot done">✓</span>
          <span className="ico">📁</span>
          <span className="mono grow">{preset?.label ?? (target || last(root))}{onlyFile ? <span className="muted"> · {last(onlyFile)}</span> : null}</span>
          <button className="icon-btn" title="Open folder" onClick={() => void api.revealRel(target ?? "").catch((e) => setMessage({ text: errorText(e), error: true }))}><Icon name="folder" /></button>
          <div className="seg">
            {(["auto", "tv", "movie"] as Kind[]).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); void preview({ kind: k, matchId: null, template: k === "auto" ? undefined : tpl(k as "tv" | "movie") }); }}>
                {k === "auto" ? `Auto${plan ? ` (${plan.mode === "movie" ? "movies" : "show"})` : ""}` : k === "tv" ? "Show" : "Movies"}
              </button>
            ))}
          </div>
          {!embedded && <button onClick={() => { presetRef.current = undefined; setTarget(null); }}>Change folder</button>}
        </section>
      )}

      {busy && <p className="muted">{busy}</p>}

      {done && (
        <section className="card form done-card">
          <div className="strong">Renamed {done.count} item{done.count === 1 ? "" : "s"}.</div>
          <div className="muted small">Jellyfin has been asked to scan, so the new names show up in a minute.</div>
          <div className="row">
            <button className="primary" onClick={() => void previewFor()}>Check again</button>
            <button onClick={() => void undo(done.batch, done.count)}>Undo</button>
            {!embedded && <button onClick={() => { presetRef.current = undefined; setTarget(null); }}>Fix another folder</button>}
          </div>
        </section>
      )}

      {plan && target !== null && (
        <div className="ren-grid">
          {/* 2 · match */}
          <section className="card form">
            <div className="picker-head"><span className="step-dot">2</span><div className="strong grow">{plan.mode === "movie" ? "Movies found" : "Which show is this?"}</div></div>
            {plan.mode === "tv" ? (
              <>
                {plan.chosen ? (
                  <div className="match-chosen">
                    {poster(plan.chosen) ? <img src={poster(plan.chosen)!} alt="" /> : <div className="thumb" />}
                    <div className="grow">
                      <div className="strong big-text">{plan.chosen.name}{plan.chosen.year ? ` (${plan.chosen.year})` : ""}</div>
                      <div className="muted small">{SOURCE_LABEL[plan.chosen.source]} · {plan.chosen.score}% sure · {plan.titlesFound} episode titles found</div>
                    </div>
                  </div>
                ) : (
                  <p className="note">No confident match for “{plan.guess}”. Names come from the files. Search below or pick another source.</p>
                )}
                {plan.candidates.length > 1 && (
                  <label>Not right? Pick another
                    <select value={plan.chosen ? `${plan.chosen.source}:${plan.chosen.id}` : ""} onChange={(e) => { setMatchId(e.target.value || null); void preview({ matchId: e.target.value || null }); }}>
                      <option value="">None (use the file names)</option>
                      {plan.candidates.map((c) => <option key={`${c.source}:${c.id}`} value={`${c.source}:${c.id}`}>{c.name}{c.year ? ` (${c.year})` : ""} · {SOURCE_LABEL[c.source]} · {c.score}%</option>)}
                    </select>
                  </label>
                )}
                <div className="row">
                  <label>Search for another name<input value={search} placeholder={plan.guess} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void preview({ matchId: null })} /></label>
                  <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
                  <button onClick={() => { setMatchId(null); void preview({ matchId: null }); }}>Search</button>
                </div>
              </>
            ) : (
              <p className="muted small">{plan.matchedMovies} of {ops.filter((o) => o.kind === "video").length} movies matched online ({status.hasTmdb ? "TMDB" : "Jellyfin's TMDB lookup"}). Titles and years come from the match.</p>
            )}
            <div className="row">
              <label>Look up names in
                <select value={source} onChange={(e) => { setSource(e.target.value as Source); setMatchId(null); void preview({ source: e.target.value as Source, matchId: null }); }}>
                  {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k} disabled={k === "tmdb" && !status.hasTmdb}>{v}{k === "tmdb" && !status.hasTmdb ? " (add a key in Settings)" : ""}</option>)}
                </select>
              </label>
            </div>
          </section>

          {/* 3 · preview */}
          <section className="card form preview-card">
            <div className="picker-head">
              <span className="step-dot">3</span>
              <div className="strong grow">Check the result</div>
              <div className="seg">
                <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>What changes</button>
                <button className={tab === "infuse" ? "on" : ""} onClick={() => setTab("infuse")}>How Infuse shows it</button>
              </div>
            </div>

            {allRight ? (
              <p className="ok strong">Everything in this folder already has the right name. Nothing to do.</p>
            ) : null}

            {tab === "infuse" ? (
              <div className="preview-two">
                <InfusePreview plan={plan} poster={poster(plan.chosen)} />
                <div className="stack-s">
                  <div className="strong small">Folder layout after renaming</div>
                  <FolderTree ops={ops} base={target} />
                  {plan.mode === "tv" && !ops.some((o) => o.kind === "video" && dirOf(o.to) !== (topFolderOp?.to ?? target) ) && (
                    <p className="muted small">The episodes stay directly in the show folder (no season folders). Jellyfin and Infuse handle that fine.</p>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="row between">
                  <BulkSelect sel={sel} keys={okOf(ops)} noun="changes" />
                  <label className="check small"><input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />Only show what changes</label>
                </div>
                <div className="file-table">
                  {dirGroups.map(([dir, list]) => {
                    const open = dirGroups.length === 1 || openDirs.has(dir);
                    const keys = okOf(list);
                    return (
                      <div key={dir} className="file-group">
                        <div className="change-group">
                          <TriCheck state={sel.state(keys)} disabled={!keys.length} onChange={(on) => sel.setMany(keys, on)} />
                          <button className="link-plain group-toggle" onClick={() => setOpenDirs((x) => { const n = new Set(x); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; })}>
                            <span className={`chev ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                            <Icon name="folder" size={13} /> <span className="strong small mono">{dir === "Folders" ? "Folders" : last(dir)}</span>
                          </button>
                          <span className="muted small">{keys.filter((k) => picked.has(k)).length} of {keys.length} selected{list.length > keys.length ? ` · ${list.length - keys.length} unchanged or skipped` : ""}</span>
                        </div>
                        {open && list.map((o) => {
                    const st = stateOf(o);
                    const can = o.status === "ok";
                    return (
                      <div className={`file-row ${o.kind} ${live.get(o.from) ?? ""}`} key={o.from} onContextMenu={(e) => openMenu(e, fileMenu(o))}>
                        <input type="checkbox" disabled={!can} checked={picked.has(o.from)} onChange={() => sel.toggle(o.from)} aria-label="Include" />
                        <StepMark s={live.get(o.from)} />
                        <div className="names">
                          <div className="mono">{last(o.from)}</div>
                          {o.from !== o.to && <div className="mono to">→ {o.kind === "folder" ? last(o.to) : last(o.to)}</div>}
                          <div className={`small ${o.status === "ok" ? "muted" : "warn"}`}>{explain(o, plan.chosen ? SOURCE_LABEL[plan.chosen.source] : null).join(" · ")}</div>
                        </div>
                        {o.kind === "video" && o.score != null && <span className={`small strong ${o.score >= 90 ? "ok" : o.score >= 75 ? "warn" : "bad"}`}>{o.score}%</span>}
                        <span className={`small strong ${st.cls}`}>{st.label}</span>
                      </div>
                    );
                        })}
                      </div>
                    );
                  })}
                  {rows.length === 0 && <div className="muted small pad">Nothing changes.</div>}
                </div>
              </>
            )}

            <details className="more">
              <summary>Naming options</summary>
              <div className="stack-s">
                {mode === "tv" && <ShowYearPicker />}
                <div className="style-cards">
                  {STYLES[mode].map((s) => (
                    <button key={s.id} className={`style-card ${style[mode] === s.value && !custom ? "on" : ""}`} onClick={() => { setCustom(false); setStyle({ ...style, [mode]: s.value }); void preview({ template: mode === "tv" ? withShowYear(s.value, showYear) : s.value }); }}>
                      <div className="strong">{s.label}</div>
                      <div className="mono small muted">{mode === "tv" && showYear !== "everywhere" ? s.hint.replace(" (2018) - ", " - ") : s.hint}</div>
                    </button>
                  ))}
                  <button className={`style-card ${custom ? "on" : ""}`} onClick={() => setCustom(true)}><div className="strong">Custom</div><div className="small muted">Write your own pattern</div></button>
                </div>
                {custom && (
                  <div className="row">
                    <label>Pattern<input className="mono" value={style[mode]} onChange={(e) => setStyle({ ...style, [mode]: e.target.value })} spellCheck={false} /></label>
                    <button onClick={() => void preview({ template: style[mode] })}>Use</button>
                  </div>
                )}
                {plan.mode === "tv" && (
                  <>
                    <label className="check small"><input type="checkbox" checked={renameFolder ?? !!topFolderOp} onChange={(e) => { setRenameFolder(e.target.checked); void preview({ renameFolder: e.target.checked }); }} />Rename the folder “{last(target)}” to the show's name</label>
                    <label className="check small"><input type="checkbox" checked={seasonFolders} onChange={(e) => { setSeasonFolders(e.target.checked); void preview({ seasonFolders: e.target.checked }); }} />Put episodes that sit loose in the show folder into season folders</label>
                  </>
                )}
                <label className="check small"><input type="checkbox" checked={removeEmpty} onChange={(e) => setRemoveEmpty(e.target.checked)} />Remove folders that end up empty</label>
                <div className="strong small">Find and replace in file names</div>
                {rules.map((r, i) => (
                  <div className="rule" key={i}>
                    <input placeholder="Find" value={r.find} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, find: e.target.value } : x)))} />
                    <input placeholder="Replace with" value={r.replace} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))} />
                    <label className="check small"><input type="checkbox" checked={r.regex} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, regex: e.target.checked } : x)))} />Pattern</label>
                    <button onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">×</button>
                  </div>
                ))}
                <div className="row"><button className="link" onClick={() => setRules([...rules, { find: "", replace: "", regex: false }])}>+ Add rule</button>{rules.length > 0 && <button onClick={() => void preview()}>Apply rules to preview</button>}</div>
              </div>
            </details>

            <div className="applybar">
              <div className="grow">
                <div className="strong">{counts.files + counts.folders ? `${counts.files} file${counts.files === 1 ? "" : "s"}${counts.folders ? ` and ${counts.folders} folder${counts.folders === 1 ? "" : "s"}` : ""} will be renamed` : "Nothing selected to rename"}</div>
                <div className="muted small">{counts.right} already right{counts.check ? ` · ${counts.check} to check` : ""}{counts.problems ? ` · ${counts.problems} skipped (see Files and folders)` : ""}. Nothing is deleted or overwritten; you can undo.</div>
              </div>
              <button className="primary" disabled={!picked.size || !!busy} onClick={() => void apply()}>{busy === "Renaming…" ? "Renaming…" : "Rename"}</button>
            </div>
          </section>
        </div>
      )}

      {history.length > 0 && !embedded && (
        <details className="card history">
          <summary className="strong">History ({history.length})</summary>
          {history.slice(0, 15).map((b) => (
            <div className="batch" key={b.batch}>
              <div>
                <div>{b.files} item{b.files === 1 ? "" : "s"} · {new Date(b.at * 1000).toLocaleString()}</div>
                <div className="muted small mono">{b.example}</div>
              </div>
              <div className="spacer" />
              {b.undone >= b.files ? <span className="muted small">Undone</span> : <button onClick={() => void undo(b.batch, b.files - b.undone)}>Undo</button>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ library check */

/** The library check's show pattern (standard, with the year where Settings wants it). */
const tvTemplate = () => withShowYear(STYLES.tv[0].value);
const MOVIE_TEMPLATE = STYLES.movie[0].value;
/** The naming settings the library check uses (for scanning everything from Home). */
export const namingArgs = (): [string, string, boolean, boolean] => [tvTemplate(), MOVIE_TEMPLATE, yearOptional(), minimalNames()];

function presetFor(r: CheckRow): Preset {
  return r.kind === "series"
    ? { folder: r.folder, kind: "tv", matchId: `jellyfin:${r.id}`, onlyFile: null, itemId: null, label: titleYear(r.name, r.year) }
    : { folder: r.folder, kind: "movie", matchId: null, onlyFile: r.file, itemId: r.id, label: titleYear(r.name, r.year) };
}

/** Plans and renames one checked title the same way the check did. Returns files renamed. */
async function renameRow(r: CheckRow): Promise<number> {
  const p = presetFor(r);
  const plan = await api.plan({
    mode: p.kind, folder: p.folder, template: r.kind === "series" ? tvTemplate() : MOVIE_TEMPLATE, show: null, year: null, yearOptional: yearOptional(), minimal: minimalNames(),
    findReplace: [], recursive: r.kind === "series", source: r.kind === "series" ? "jellyfin" : "none", matchId: p.matchId,
    renameFolder: null, seasonFolders: false, onlyFile: p.onlyFile, itemId: p.itemId,
  });
  const ok = plan.ops.filter((o) => o.status === "ok").map((o) => o.from);
  if (!ok.length) return 0;
  const rep = await applyPlan(plan, true, ok, r.kind === "series" ? r.id : null, r.folder);
  return rep.done;
}

const JUNK = /\b(2160p|1080p|720p|480p|4k|uhd|x26[45]|h\.?26[45]|hevc|web-?dl|webrip|bluray|brrip|hdtv|amzn|nf|dsnp|hmax|ddp?5\.1|aac|ac3|atmos|10bit|hdr|proper|repack)\b/i;

/** Why one file or folder gets its new name, in plain words. */
export function explain(o: PlanOp, source: string | null): string[] {
  const from = last(o.from);
  const to = last(o.to);
  const why: string[] = [];
  if (o.status === "conflict") return [o.note ?? "A file with the new name already exists, so this one is skipped"];
  if (o.status === "unparsed") return [o.note ?? "No season and episode number found in the name, so it's left alone"];
  if (o.status === "unchanged") return ["Already right"];
  if (o.kind === "folder") {
    if (/\(\d{4}\)/.test(to) && !/\(\d{4}\)/.test(from)) why.push("adds the year, so Jellyfin finds the right show");
    if (/^Season \d+$/i.test(to)) why.push("standard season folder name");
    if (!why.length) why.push("uses the name Jellyfin knows it by");
    return why;
  }
  if (o.kind === "sidecar") return ["follows its video (subtitle or extra file)"];
  const fromDir = dirOf(o.from), toDir = dirOf(o.to);
  if (fromDir !== toDir) why.push(`moves into “${last(toDir)}”`);
  if (JUNK.test(stripExt(from)) && !JUNK.test(stripExt(to))) why.push("drops release tags (quality, codec, group)");
  if (/\(\d{4}\)/.test(to) && !/\(\d{4}\)/.test(from)) why.push("adds the year");
  if (/S\d{2}E\d{2}/.test(to) && !/S\d{2}E\d{2}/.test(from)) why.push("standard S01E02 numbering");
  if (o.title && !from.toLowerCase().includes(o.title.toLowerCase())) why.push(`adds the episode title “${o.title}”${source ? ` from ${source}` : ""}`);
  if (/\./.test(stripExt(from)) && !/\./.test(stripExt(to).replace(/\.$/, ""))) why.push("spaces instead of dots");
  if (o.note && o.note !== "Gets its own folder") why.push(o.note);
  if (o.note === "Gets its own folder") why.push("gets its own folder (how Jellyfin likes movies)");
  if (!why.length) why.push("tidies the name to the standard pattern");
  return why;
}

function CheckDetail({ r, onDone }: { r: CheckRow; onDone: () => void }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [ids, setIds] = useState<Record<string, string>>({});
  const sel = useUndoableSet<string>();
  const picked = sel.set;
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRight, setShowRight] = useState(false);
  const { tidy, showYear } = usePrefs();
  const live = useRenameSteps();
  const [renameTop, setRenameTop] = useState(true);
  const [seasonDirs, setSeasonDirs] = useState(false);
  // A clicked summary chip ("3× adds the episode title"): its files stand out, the rest fade.
  const [hl, setHl] = useState<{ group: string; what: string } | null>(null);
  const short = (w: string) => w.replace(/ “[^”]*”/, "").replace(/ from .*$/, "");

  useEffect(() => {
    const p = presetFor(r);
    setPlan(null);
    api.plan({
      mode: p.kind, folder: p.folder, template: r.kind === "series" ? tvTemplate() : MOVIE_TEMPLATE, show: null, year: null, yearOptional: yearOptional(), minimal: minimalNames(),
      findReplace: [], recursive: r.kind === "series", source: r.kind === "series" ? "jellyfin" : "none", matchId: p.matchId,
      renameFolder: r.kind === "series" ? renameTop : null, seasonFolders: seasonDirs, onlyFile: p.onlyFile, itemId: p.itemId,
    }).then((pl) => {
      setPlan(pl);
      sel.reset(pl.ops.filter((o) => o.status === "ok").map((o) => o.from));
    }).catch((e) => setError(errorText(e)));
  }, [r.id, tidy, showYear, renameTop, seasonDirs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void api.details(r.id).then((d) => setIds(d.item.ProviderIds ?? {})).catch(() => undefined), [r.id]);

  if (error) return <div className="check-detail"><p className="error">{error}</p></div>;
  if (!plan) return <div className="check-detail"><p className="muted small">Working out every change…</p></div>;
  const videos = plan.ops.filter((o) => o.kind === "video");
  const known = videos.filter((o) => o.score === 100 && o.verified).length;
  const idText = Object.entries(ids).filter(([k]) => ["Tmdb", "Tvdb", "Imdb"].includes(k)).map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" · ");
  const source = plan.chosen ? (plan.chosen.source === "jellyfin" ? "your Jellyfin library" : SOURCE_LABEL[plan.chosen.source]) : null;
  const changes = plan.ops.filter((o) => o.status !== "unchanged" || showRight);
  const groups = new Map<string, PlanOp[]>();
  for (const o of changes) {
    const g = o.kind === "folder" ? "Folders" : o.season != null ? (o.season === 0 ? "Specials" : `Season ${o.season}`) : "Files";
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const toggle = (k: string) => sel.toggle(k);
  const okKeys = (ops: PlanOp[]) => ops.filter((o) => o.status === "ok").map((o) => o.from);
  // One group stays open; with several, only the headers show until you open one.
  const isOpen = (g: string) => groups.size === 1 || openGroups.has(g);

  async function apply() {
    if (!plan || !picked.size) return;
    setBusy(true);
    try {
      await track(`Renaming ${r.name}`, async () => {
        const rep = await applyPlan(plan, true, [...picked], r.kind === "series" ? r.id : null, r.folder);
        if (rep.failed.length) throw `${rep.done} renamed; ${rep.failed.length} skipped: ${rep.failed[0]}`;
        await scanAround([r.folder]);
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="check-detail">
      <div className={`why-box ${r.sure ? "sure" : ""}`}>
        <div className="strong">{r.sure ? "Why this is a 100% match" : "Why this needs a look"}</div>
        <ul>
          {r.kind === "series" ? (
            <>
              <li className={ids.Tmdb || ids.Tvdb ? "ok" : "warn"}>
                {ids.Tmdb || ids.Tvdb ? `Identified in Jellyfin as “${titleYear(r.name, r.year)}” (${idText})` : "Not identified in Jellyfin yet, so the name and year aren't certain"}
              </li>
              <li className={known === videos.length && videos.length ? "ok" : "warn"}>{known} of {videos.length} episode files were found in the episode list{plan.titlesFound ? ` (${plan.titlesFound} titles known)` : ""}</li>
              {plan.unparsed > 0 && <li className="warn">{plan.unparsed} file{plan.unparsed === 1 ? "" : "s"} without a season/episode number: left alone</li>}
              {plan.conflict > 0 && <li className="warn">{plan.conflict} would clash with an existing file: skipped</li>}
            </>
          ) : (
            <>
              <li className={ids.Tmdb || ids.Imdb ? "ok" : "warn"}>{ids.Tmdb || ids.Imdb ? `Jellyfin knows this file as “${titleYear(r.name, r.year)}” (${idText})` : "Not identified in Jellyfin yet"}</li>
              <li>Only this movie's own files are touched (the video and files with the same name)</li>
            </>
          )}
          <li className="muted">Nothing is deleted or overwritten, and the whole rename can be undone in History.</li>
        </ul>
      </div>

      <div className="row between">
        <div className="row">
          <BulkSelect sel={sel} keys={okKeys(plan.ops)} noun="changes" />
          <label className="check small"><input type="checkbox" checked={showRight} onChange={(e) => setShowRight(e.target.checked)} />Also show what's already right ({plan.unchanged})</label>
        </div>
        <div className="row end">
          {!(ids.Tmdb || ids.Tvdb) && <button onClick={() => nav.open(r.id, { tab: "identify" })}>Identify first…</button>}
          <button className="primary" disabled={!picked.size || busy} onClick={() => void apply()}>{busy ? "Renaming…" : `Rename ${picked.size} selected`}</button>
        </div>
      </div>

      <div className="ren-options">
        <div className="seg" role="group" aria-label="What to rename">
          <button className={tidy !== "style" ? "on" : ""} onClick={() => setPrefs({ tidy: "messy" })} title="Release tags (2160p, BluRay, x265, [YTS]) and dots for spaces">Only messy names</button>
          <button className={tidy === "style" ? "on" : ""} onClick={() => setPrefs({ tidy: "style" })} title="Every name follows the naming style exactly">Match the naming style</button>
        </div>
        {tidy === "style" && r.kind === "series" && (
          <>
            <div className="seg" role="group" aria-label="Year in show names">
              {SHOW_YEAR.map((o) => <button key={o.id} className={showYear === o.id ? "on" : ""} title={o.hint} onClick={() => setPrefs({ showYear: o.id })}>{o.label}</button>)}
            </div>
            <label className="check small"><input type="checkbox" checked={renameTop} onChange={(e) => setRenameTop(e.target.checked)} />Rename the show folder</label>
            <label className="check small"><input type="checkbox" checked={seasonDirs} onChange={(e) => setSeasonDirs(e.target.checked)} />Put loose episodes in season folders</label>
          </>
        )}
        <span className="muted small">{tidy !== "style" ? "Names Jellyfin already reads fine are left alone." : "Jellyfin finds titles either way; this only makes names uniform."}</span>
      </div>

      <div className="change-list">
        {[...groups.entries()].map(([g, ops]) => (
          <div key={g}>
            <div className="change-group">
              <TriCheck state={sel.state(okKeys(ops))} disabled={!okKeys(ops).length} onChange={(on) => sel.setMany(okKeys(ops), on)} />
              {groups.size > 1 ? (
                <button className="link-plain group-toggle" onClick={() => setOpenGroups((s) => { const n = new Set(s); if (n.has(g)) n.delete(g); else n.add(g); return n; })}>
                  <span className={`chev ${isOpen(g) ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                  <span className="strong small">{g}</span>
                </button>
              ) : <span className="strong small">{g}</span>}
              <span className="muted small">{okKeys(ops).filter((k) => picked.has(k)).length} of {okKeys(ops).length} selected{ops.length > okKeys(ops).length ? ` · ${ops.length - okKeys(ops).length} left alone` : ""}</span>
            </div>
            {(() => {
              // What happens to this group, counted once instead of on every file.
              const tally = new Map<string, number>();
              for (const o of ops.filter((x) => x.status === "ok" && x.kind !== "sidecar")) for (const w of explain(o, source).map(short)) tally.set(w, (tally.get(w) ?? 0) + 1);
              const parts = [...tally.entries()].sort((a, b) => b[1] - a[1]);
              return parts.length > 0 && (
                <div className="change-summary">
                  {parts.map(([w, n]) => {
                    const on = hl?.group === g && hl.what === w;
                    return (
                      <button key={w} className={`chip ${on ? "on" : ""}`} title={on ? "Show all files again" : "Show which files this applies to"}
                        onClick={() => {
                          setHl(on ? null : { group: g, what: w });
                          if (!on && !isOpen(g)) setOpenGroups((s) => new Set(s).add(g));
                        }}>
                        {n}× {w}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            {isOpen(g) && ops.map((o) => {
              const can = o.status === "ok";
              return (
                <label key={o.from} className={`change ${can ? "" : "off"} ${live.get(o.from) ?? ""} ${hl?.group === g ? (can && explain(o, source).some((w) => short(w) === hl.what) ? "hl" : "dim") : ""}`} onContextMenu={(e) => openMenu(e, fileMenu(o))}>
                  <input type="checkbox" disabled={!can} checked={picked.has(o.from)} onChange={() => toggle(o.from)} />
                  <StepMark s={live.get(o.from)} />
                  <div className="names">
                    <div className="mono small"><span className="muted">{last(o.from)}</span></div>
                    {o.from !== o.to && <div className="mono small accent">→ {o.kind === "video" && dirOf(o.from) !== dirOf(o.to) ? `${last(dirOf(o.to))}/` : ""}{last(o.to)}</div>}
                    <div className="why small">{explain(o, source).join(" · ")}</div>
                  </div>
                  {o.kind === "video" && o.score != null && <span className={`small strong ${o.score >= 100 ? "ok" : o.score >= 75 ? "warn" : "bad"}`} title="How sure the episode is right">{o.score}%</span>}
                </label>
              );
            })}
          </div>
        ))}
        {changes.length === 0 && <p className="muted small pad">Nothing to change.</p>}
      </div>
    </div>
  );
}

function CheckList({ status, focus }: { status: Status; focus?: string }) {
  const epoch = useEpoch();
  const [res, setRes] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const pickedSel = useUndoableSet<string>();
  const picked = pickedSel.set;
  const [show, setShow] = useState<"todo" | "right" | "errors">("todo");
  const [open, setOpen] = useState<string | null>(null);
  // The folder tab (like the Library's): "@all" or a top folder.
  const [folderTab, setFolderTab] = usePageState<string>("renamer.folder", "@all");
  // How each title's rename went during "Rename all" (turns green when done).
  const [titleState, setTitleState] = useState<Record<string, StepState>>({});

  useEffect(() => {
    api.namingCheckLast().then((r) => setRes(r)).catch(() => setRes(null));
  }, [epoch]);

  const { tidy } = usePrefs();
  const [checkedTidy, setCheckedTidy] = useState(tidy);
  async function check(ids: string[] | null = null) {
    setError(null);
    if (!ids) setCheckedTidy(tidy);
    try {
      await track(ids ? "Checking names again" : "Checking every show and movie", async (job) => {
        const un = await listen<{ done: number; total: number; name: string }>("naming-progress", (e) => {
          setChecking(e.payload.name ? `${e.payload.name} (${e.payload.done + 1}/${e.payload.total})` : null);
          job.update(e.payload.name, e.payload.total ? e.payload.done / e.payload.total : null);
        });
        try {
          setRes(await api.namingCheck(tvTemplate(), MOVIE_TEMPLATE, ids, yearOptional(), minimalNames()));
        } finally {
          un();
          setChecking(null);
        }
      }, { reload: false, stop: "naming" });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const rows = res?.rows ?? [];
  const top = (r: CheckRow) => r.folder.split("/")[0] || "(library folder)";
  const q = filter.toLowerCase();
  const match = (r: CheckRow) => (folderTab === "@all" || top(r) === folderTab) && (!q || r.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q));
  const tops = [...new Set(rows.map(top))];
  const todo = rows.filter((r) => !r.error && (r.toRename + r.folders + r.problems > 0 || r.reasons.length > 0));
  const sure = todo.filter((r) => r.sure);
  const look = todo.filter((r) => !r.sure);
  const right = rows.filter((r) => !r.error && !todo.includes(r));
  const errors = rows.filter((r) => r.error);

  async function bulk() {
    const list = sure.filter((r) => picked.has(r.id) && match(r));
    if (!list.length) return;
    const files = list.reduce((n, r) => n + r.toRename + r.folders, 0);
    if (!(await askConfirm(`Rename ${files} files and folders in ${list.length} title${list.length === 1 ? "" : "s"}? All are 100% matches (open one to see exactly what changes). Nothing is deleted or overwritten, and every batch can be undone.`, { okLabel: "Rename all" }))) return;
    try {
      await track(`Renaming ${list.length} titles`, async (job) => {
        let n = 0;
        const failed: string[] = [];
        setTitleState(Object.fromEntries(list.map((r) => [r.id, "working" as StepState])));
        for (const [i, r] of list.entries()) {
          if (job.cancelled) break;
          job.update(r.name, i / list.length);
          try {
            n += await renameRow(r);
            setTitleState((t) => ({ ...t, [r.id]: "done" }));
          } catch (e) {
            failed.push(`${r.name}: ${errorText(e)}`);
            setTitleState((t) => ({ ...t, [r.id]: "failed" }));
          }
        }
        job.update("Asking Jellyfin to look at the renamed folders", null);
        await scanAround(list.map((r) => r.folder));
        await check(list.map((r) => r.id));
        pickedSel.reset();
        if (failed.length) throw `${n} renamed; ${failed.length} failed: ${failed[0]}`;
        job.update(`${n} renamed`, 1);
      }, { cancellable: true });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const menuFor = (r: CheckRow) => [
    { label: "Open title", run: () => nav.open(r.id) },
    { label: "Open folder", run: () => void api.revealRel(r.folder).catch(() => undefined) },
    { label: "Check again", run: () => void check([r.id]) },
    { sep: true },
    ...itemMenu({ id: r.id, kind: r.kind, title: r.name }).filter((m) => m.label === "Identify…" || m.label === "Fill in missing artwork"),
  ];

  // The list on the left: sure matches (with a box to rename many at once), then the rest.
  const listed: CheckRow[] = show === "todo" ? [...sure.filter(match), ...look.filter(match)] : show === "right" ? right.filter(match) : errors.filter(match);
  const items: StudioItem[] = listed.map((r) => ({
    id: r.id,
    title: titleYear(r.name, r.year),
    sub: r.error ?? (show === "right" ? `✓ ${r.right} right · ${r.folder}` : r.reasons[0] ?? r.folder),
    thumb: imageUrl(r.id, "Primary", 80),
    group: show === "todo" ? (r.sure ? `Sure matches · rename in one go` : "Needs a look") : undefined,
    lead: show === "todo" && r.sure ? <input type="checkbox" checked={picked.has(r.id)} onChange={() => pickedSel.toggle(r.id)} aria-label="Select" /> : undefined,
    tail: titleState[r.id] ? <StepMark s={titleState[r.id]} /> : r.sure && show === "todo" ? <span className="chip static on">100%</span> : undefined,
  }));
  const openRow = listed.find((r) => r.id === open) ?? null;
  // Opened for one title ("Rename…" on a title): select it, checking it first when it isn't listed.
  const focused = useRef<string | null>(null);
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || focused.current === focus || !res) return;
    const row = rows.find((r) => r.id === focus);
    if (!row) {
      if (!checking && tried.current !== focus) {
        tried.current = focus;
        void check([focus]);
      }
      return;
    }
    focused.current = focus;
    setFilter("");
    if (folderTab !== "@all" && top(row) !== folderTab) setFolderTab("@all");
    setShow(row.error ? "errors" : todo.includes(row) ? "todo" : "right");
    setOpen(focus);
  }, [focus, res]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!openRow && listed.length && !(focus && focused.current !== focus)) setOpen(listed[0].id);
  }, [openRow, listed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const sureKeys = sure.filter(match).map((r) => r.id);
  const pickedCount = sure.filter((r) => picked.has(r.id) && match(r)).length;

  if (!status.libraryRoot) return null;
  return (
    <div className="stack grow-col">
      <KTabs
        folders
        active={folderTab}
        onChange={setFolderTab}
        tabs={folderTabs(tops, (f) => (f === null ? todo.length : todo.filter((r) => top(r) === f).length))}
        after={<>
          <span className="spacer" />
          <span className="muted small">{checking ? `Checking ${checking}…` : res ? `Checked ${new Date(res.at * 1000).toLocaleString()} · numbers are titles to fix` : "Not checked yet. Checking renames nothing."}</span>
          {checking ? <button onClick={() => void api.namingCheckCancel()}><Icon name="stop" size={12} /> Stop</button> : (
            <button className="primary" title="Reads every show and movie folder on the NAS and compares the names (renames nothing)" onClick={() => void check(folderTab === "@all" ? null : rows.filter((r) => top(r) === folderTab).map((r) => r.id))}>
              <Icon name="search" /> {res ? (checkedTidy !== tidy ? "Check names with the new setting" : folderTab === "@all" ? "Check all names" : `Check names in ${folderTab}`) : "Check my library"}
            </button>
          )}
        </>}
      />
      {error && <p className="error">{error}</p>}

      {res && (
        <Studio
          items={items}
          selected={open}
          onSelect={setOpen}
          empty={show === "todo" ? "Everything here is named right." : "Nothing here."}
          head={
            <>
              <SearchBox value={filter} onChange={setFilter} placeholder="Find a title" />
              <Seg value={show} onChange={setShow} options={[
                { id: "todo", label: `To fix ${todo.filter(match).length}` },
                { id: "right", label: `Right ${right.filter(match).length}` },
                ...(errors.length > 0 ? [{ id: "errors" as const, label: `Couldn't check ${errors.filter(match).length}` }] : []),
              ]} />
              {show === "todo" && sureKeys.length > 0 && (
                <div className="row between studio-bulk">
                  <BulkSelect sel={pickedSel} keys={sureKeys} noun="sure" />
                  <button className="primary" disabled={!pickedCount} onClick={() => void bulk()}>Rename {pickedCount || ""}</button>
                </div>
              )}
            </>
          }
        >
          {openRow && (
            <div className="inspector" onContextMenu={(e) => openMenu(e, menuFor(openRow))}>
              <div className="insp-head">
                <button className="insp-poster" onClick={() => nav.open(openRow.id)} title="Open title"><img src={imageUrl(openRow.id, "Primary", 200)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></button>
                <div className="grow">
                  <h2 className="big">{openRow.name}{openRow.year ? <span className="muted thin"> ({openRow.year})</span> : null}</h2>
                  <div className="muted small">{openRow.kind === "series" ? "Show" : "Movie"} · <span className="mono">{openRow.folder || "(library folder)"}</span></div>
                  <div className="check-reasons">
                    {openRow.sure && <span className="chip static on">100% match</span>}
                    {openRow.error ? <span className="bad small">{openRow.error}</span> : openRow.reasons.map((x, i) => <span key={i} className={`small ${/Not identified|clash|without/.test(x) ? "warn" : "muted"}`}>{x}</span>)}
                  </div>
                </div>
                <div className="row end">
                  <IconBtn icon="folder" title="Open folder" onClick={() => void api.revealRel(openRow.folder).catch(() => undefined)} />
                  <IconBtn icon="expand" title="Open the title's page" onClick={() => nav.open(openRow.id)} />
                  <button className="icon-btn" aria-label="More" onClick={(e) => openMenu(e, menuFor(openRow))}><Icon name="more" /></button>
                </div>
              </div>
              {show === "right" ? <p className="ok">✓ Every file and folder already has the right name.</p> : (
                <CheckDetail key={openRow.id} r={openRow} onDone={() => void check([openRow.id])} />
              )}
            </div>
          )}
        </Studio>
      )}
    </div>
  );
}

const TAGS_HINT = "2160p, 1080p, x264, x265, HEVC, WEB-DL, WEBRip, BluRay, HDR, AAC, DDP5.1, [YTS.MX] … and dots for spaces";

/** The same edits over many titles at once: find & replace, release tags, S01E01. */
function BulkEdit({ status, onCheck }: { status: Status; onCheck: () => void }) {
  const epoch = useEpoch();
  const [res, setRes] = useState<CheckResult | null | undefined>(undefined);
  useEffect(() => {
    api.namingCheckLast().then(setRes).catch(() => setRes(null));
  }, [epoch]);
  const titles = useUndoableSet<string>();
  const picked = useUndoableSet<string>();
  const [q, setQ] = useState("");
  const [folderTab, setFolderTab] = usePageState<string>("renamer.folder", "@all");
  const live = useRenameSteps();
  const [rules, setRules] = useState<FindReplace[]>([{ find: "", replace: "", regex: false }]);
  const [dropTags, setDropTags] = useState(true);
  const [epTag, setEpTag] = useState<"keep" | "add" | "remove">("keep");
  const [incFolder, setIncFolder] = useState(true);
  const [showSame, setShowSame] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const rows = (res?.rows ?? []).filter((r) => r.folder && !r.error);
  const top = (r: CheckRow) => r.folder.split("/")[0] || "(library folder)";
  const ql = q.toLowerCase();
  const tops = [...new Set(rows.map(top))];
  const shown = rows
    .filter((r) => (folderTab === "@all" || top(r) === folderTab) && (!ql || r.name.toLowerCase().includes(ql) || r.folder.toLowerCase().includes(ql)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = rows.filter((r) => titles.has(r.id));
  const ruleKey = JSON.stringify([rules, dropTags, epTag, incFolder, [...titles.set].sort()]);
  // Any change to the edits or the titles makes the preview old.
  useEffect(() => setPlan(null), [ruleKey]);
  const hasEdit = dropTags || epTag !== "keep" || rules.some((r) => r.find);

  async function preview() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      // A movie in its own folder is planned from that folder, so the folder gets the same
      // clean-up as the file (release tags out, year in brackets).
      const targets = chosen.map((r) => (r.kind === "movie" && r.file ? { folder: dirOf(r.file) || r.folder, file: r.file } : { folder: r.folder, file: null }));
      const p = await api.bulkPlan(targets, { rules: rules.filter((r) => r.find), dropTags, episodeTag: epTag, includeFolder: incFolder });
      setPlan(p);
      picked.reset(p.ops.filter((o) => o.status === "ok").map((o) => o.from));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!plan || !picked.size) return;
    if (!(await askConfirm(`Rename ${picked.size} files and folders? Nothing is deleted or overwritten, and the whole batch can be undone in History.`, { okLabel: "Rename" }))) return;
    setBusy(true);
    setError(null);
    try {
      await track(`Renaming ${picked.size} files`, async () => {
        const rep = await applyPlan(plan, true, [...picked.set], null, null);
        await scanAround(chosen.map((r) => r.folder));
        if (rep.failed.length) throw `${rep.done} renamed; ${rep.failed.length} skipped: ${rep.failed[0]}`;
        setNote(`${rep.done} renamed. Jellyfin is looking at the folders again; run the library check afterwards to see the new names here.`);
      });
      setPlan(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status.libraryRoot) return <p className="muted">Choose your library folder in Settings first.</p>;
  if (res === undefined) return <div className="pg-loading"><span className="spinner" /> Loading…</div>;
  if (!rows.length) {
    return (
      <div className="card form">
        <p>Run the library check first, so the Renamer knows where every title's files are. Checking renames nothing.</p>
        <div className="row"><button className="primary" onClick={onCheck}>Go to the library check</button></div>
      </div>
    );
  }

  // The changes per title (by its folder), so a long list stays readable.
  const ownerOf = (from: string) => chosen.find((r) => from === r.folder || from.startsWith(`${r.folder}/`));
  const ops = (plan?.ops ?? []).filter((o) => o.status !== "unchanged" || showSame);
  const groups = new Map<string, PlanOp[]>();
  for (const o of ops) {
    const r = ownerOf(o.from);
    const g = r ? titleYear(r.name, r.year) : "Other";
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const okKeys = (list: PlanOp[]) => list.filter((o) => o.status === "ok").map((o) => o.from);

  return (
    <div className="stack">
    <KTabs folders active={folderTab} onChange={setFolderTab} tabs={folderTabs(tops, (f) => (f === null ? rows.length : rows.filter((r) => top(r) === f).length))} />
    <div className="bulk-grid">
      <div className="card bulk-titles">
        <div className="row between"><span className="strong">Titles</span><span className="muted small">{chosen.length} chosen</span></div>
        <SearchBox value={q} onChange={setQ} placeholder="Find a title or folder" />
        <BulkSelect sel={titles} keys={shown.map((r) => r.id)} noun="titles" />
        <div className="bulk-list">
          {shown.map((r) => (
            <label key={r.id} className="scope-row">
              <input type="checkbox" checked={titles.has(r.id)} onChange={() => titles.toggle(r.id)} />
              <span className="ellipsis grow" title={r.folder}>{r.name}{r.year ? <span className="muted"> ({r.year})</span> : null}</span>
              {folderTab === "@all" && <span className="muted small ellipsis">{top(r)}</span>}
            </label>
          ))}
          {shown.length === 0 && <p className="muted small pad">Nothing here.</p>}
        </div>
      </div>

      <div className="stack">
        <section className="card form">
          <div className="section-head"><h2>What to change</h2><span className="muted small">Applies to the files of the chosen titles{incFolder ? " and their own folder" : ""}.</span></div>
          <label className="check"><input type="checkbox" checked={dropTags} onChange={(e) => setDropTags(e.target.checked)} />Drop release tags <span className="muted small">({TAGS_HINT})</span></label>
          <div className="row">
            <span className="small strong">Episode numbers (S01E01)</span>
            <div className="seg" role="group" aria-label="Episode numbers">
              <button className={epTag === "keep" ? "on" : ""} onClick={() => setEpTag("keep")}>Keep</button>
              <button className={epTag === "remove" ? "on" : ""} onClick={() => setEpTag("remove")} title="For YouTube channels and other videos that aren't episodes">Remove</button>
              <button className={epTag === "add" ? "on" : ""} onClick={() => setEpTag("add")} title="Videos without one are numbered oldest first">Add</button>
            </div>
            <span className="muted small">{epTag === "remove" ? "“Show - S01E02 - Title” becomes “Show - Title”." : epTag === "add" ? "Videos without a number get one, oldest first (S01E01, S01E02 …)." : ""}</span>
          </div>
          <div className="stack-s">
            <span className="small strong">Find and replace</span>
            {rules.map((r, i) => (
              <div key={i} className="row fr-rule">
                <input className="mono grow" placeholder="Find" value={r.find} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, find: e.target.value } : x)))} spellCheck={false} />
                <span className="muted">→</span>
                <input className="mono grow" placeholder="Replace with (empty removes it)" value={r.replace} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))} spellCheck={false} />
                <label className="check small" title="Use a regular expression ($1 for groups)"><input type="checkbox" checked={r.regex} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, regex: e.target.checked } : x)))} />Pattern</label>
                <button className="icon-btn" aria-label="Remove rule" disabled={rules.length === 1 && !r.find} onClick={() => setRules(rules.length === 1 ? [{ find: "", replace: "", regex: false }] : rules.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
              </div>
            ))}
            <div><button className="link small" onClick={() => setRules([...rules, { find: "", replace: "", regex: false }])}><Icon name="plus" size={12} /> Another rule</button></div>
          </div>
          <label className="check"><input type="checkbox" checked={incFolder} onChange={(e) => setIncFolder(e.target.checked)} />Also rename each title's own folder <span className="muted small">(a folder shared by several movies is left alone)</span></label>
          <div className="row end">
            <span className="muted small grow">{chosen.length ? `${chosen.length} title${chosen.length === 1 ? "" : "s"} chosen` : "Choose titles on the left"}</span>
            <button className="primary" disabled={!chosen.length || !hasEdit || busy} onClick={() => void preview()}>{busy && !plan ? "Working it out…" : "Show the changes"}</button>
          </div>
        </section>
        {error && <p className="error">{error}</p>}
        {note && <p className="note">{note}</p>}
        {plan && (
          <section className="card form">
            <div className="row between">
              <div className="row">
                <BulkSelect sel={picked} keys={okKeys(plan.ops)} noun="changes" />
                <label className="check small"><input type="checkbox" checked={showSame} onChange={(e) => setShowSame(e.target.checked)} />Also show what stays the same ({plan.unchanged})</label>
              </div>
              <button className="primary" disabled={!picked.size || busy} onClick={() => void apply()}>{busy ? "Renaming…" : `Rename ${picked.size} selected`}</button>
            </div>
            {plan.conflict > 0 && <p className="note small">{plan.conflict} would clash with another name and are skipped.</p>}
            <div className="change-list">
              {[...groups.entries()].map(([g, list]) => (
                <div key={g}>
                  <div className="change-group">
                    <TriCheck state={picked.state(okKeys(list))} disabled={!okKeys(list).length} onChange={(on) => picked.setMany(okKeys(list), on)} />
                    <span className="strong small">{g}</span>
                    <span className="muted small">{okKeys(list).filter((k) => picked.has(k)).length} of {okKeys(list).length} selected</span>
                  </div>
                  {list.map((o) => (
                    <label key={o.from} className={`change ${o.status === "ok" ? "" : "off"} ${live.get(o.from) ?? ""}`} onContextMenu={(e) => openMenu(e, fileMenu(o))}>
                      <input type="checkbox" disabled={o.status !== "ok"} checked={picked.has(o.from)} onChange={() => picked.toggle(o.from)} />
                      <StepMark s={live.get(o.from)} />
                      <div className="names">
                        <div className="mono small"><span className="muted">{o.kind === "folder" ? `${last(o.from)}/` : last(o.from)}</span></div>
                        {o.from !== o.to && <div className="mono small accent">→ {o.kind === "folder" ? `${last(o.to)}/` : last(o.to)}</div>}
                        {o.note && <div className="why small">{o.note}</div>}
                      </div>
                    </label>
                  ))}
                </div>
              ))}
              {ops.length === 0 && <p className="muted small pad">Nothing changes with these edits.</p>}
            </div>
          </section>
        )}
      </div>
    </div>
    </div>
  );
}

export default function Renamer({ status, onChanged, start, embedded }: {
  status: Status; onChanged: () => void; onNav: (v: View) => void;
  start?: { folder?: string; item?: string; section?: string }; embedded?: boolean;
}) {
  // A folder given (from Clean-up → Folders) opens that folder; a title selects it in the check.
  const [savedMode, setSavedMode] = usePageState<"check" | "bulk" | "folders">("renamer.mode", "check");
  const [mode, setModeState] = useState<"check" | "bulk" | "folder" | "folders">(start?.section === "folders" ? "folders" : start?.folder !== undefined && !start?.item ? "folder" : start?.item ? "check" : savedMode);
  const setMode = (m: "check" | "bulk" | "folder" | "folders") => { setModeState(m); if (m !== "folder") setSavedMode(m); };
  const [preset, setPreset] = useState<Preset | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!start?.item) {
      if (start?.folder !== undefined) setPreset({ folder: start.folder, kind: "auto", matchId: null, onlyFile: null, itemId: null });
      return;
    }
    if (!embedded) return;
    // Inside a title's page: find its folder (and file, for a movie) first.
    setError(null);
    api.namingCheck(tvTemplate(), MOVIE_TEMPLATE, [start.item], yearOptional(), minimalNames())
      .then((r) => {
        const row = r.rows.find((x) => x.id === start.item);
        if (!row) throw "Jellyfin has no file location for this title.";
        if (row.error && !row.folder) throw row.error;
        setPreset(presetFor(row));
      })
      .catch((e) => setError(errorText(e)));
  }, [start?.item, start?.folder, embedded]);

  if (embedded) {
    if (!status.libraryRoot) return <p className="muted">Choose your library folder in Settings first.</p>;
    return (
      <div className="stack">
        {error && <p className="error">{error}</p>}
        {preset ? <FolderFix status={status} onChanged={onChanged} preset={preset} embedded /> : !error && <p className="muted">Finding the files…</p>}
      </div>
    );
  }

  return (
    <div className={`pg ${mode === "check" && status.libraryRoot ? "studio-page" : ""}`}>
      <PageHead
        title="Renamer"
        sub="Fixes file and folder names so Jellyfin and Infuse recognise every show, season and movie."
        actions={status.libraryRoot ? (
          <Seg value={mode === "folder" ? "check" : mode} onChange={(m) => setMode(m)} options={[
            { id: "check", label: <><Icon name="check" size={13} /> Names to fix</> },
            { id: "bulk", label: <><Icon name="rename" size={13} /> Find &amp; replace</> },
            { id: "folders", label: <><Icon name="folder" size={13} /> Folders</> },
          ]} />
        ) : undefined}
      />
      {error && <p className="error">{error}</p>}
      {!status.libraryRoot ? <FolderFix status={status} onChanged={onChanged} />
        : mode === "check" ? <CheckList status={status} focus={start?.item} />
        : mode === "bulk" ? <BulkEdit status={status} onCheck={() => setMode("check")} />
        : mode === "folders" ? <Structure status={status} />
        : (
          <>
            <p className="muted small"><button className="link" onClick={() => setMode("check")}>← Back to the list</button></p>
            <FolderFix key={preset ? `${preset.folder}|${preset.itemId ?? ""}` : "free"} status={status} onChanged={onChanged} preset={preset} />
          </>
        )}
    </div>
  );
}
