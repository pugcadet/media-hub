import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, Batch, Candidate, CheckResult, CheckRow, errorText, FindReplace, imageUrl, PlanArgs, PlanOp, PlanResult, remoteImageUrl, Status } from "./api";
import { askConfirm } from "./confirm";
import type { View } from "./nav";
import { nav } from "./nav";
import { track, useEpoch } from "./activity";
import { Icon, itemMenu, openMenu } from "./ui";

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
const SOURCE_LABEL: Record<string, string> = { auto: "Automatic", jellyfin: "My Jellyfin library", tmdb: "TMDB", tvmaze: "TVmaze", none: "Don't look online" };

const last = (p: string) => p.split("/").pop() ?? p;
const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
const stripExt = (n: string) => n.replace(/\.[^.]+$/, "");

function stateOf(o: PlanOp): { label: string; cls: string } {
  if (o.status === "conflict") return { label: "Clash", cls: "bad" };
  if (o.status === "unparsed") return { label: "Not understood", cls: "bad" };
  if (o.status === "unchanged") return { label: "Already right", cls: "muted" };
  if (o.kind === "video" && ((o.score ?? 100) < 80 || !o.verified)) return { label: "Check", cls: "warn" };
  return { label: "Will rename", cls: "ok" };
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
  const [matchId, setMatchId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [year, setYear] = useState("");
  const [renameFolder, setRenameFolder] = useState<boolean | null>(null);
  const [seasonFolders, setSeasonFolders] = useState(false);
  const [rules, setRules] = useState<FindReplace[]>([]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [tab, setTab] = useState<"infuse" | "files">("infuse");
  const [picked, setPicked] = useState<Set<string>>(new Set());
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
      const template = over.template ?? (m ? style[m] : style.tv);
      const rf = over.renameFolder !== undefined ? over.renameFolder : renameFolder;
      const result = await api.plan({
        mode: k, folder: target, template, show: sv || null, year: yv ? Number(yv) : null,
        findReplace: rules.filter((r) => r.find), recursive: true,
        source: over.source ?? source, matchId: over.matchId !== undefined ? over.matchId : matchId,
        renameFolder: rf, seasonFolders: over.seasonFolders ?? seasonFolders,
        onlyFile: over.onlyFile !== undefined ? over.onlyFile : onlyFile, itemId: over.itemId !== undefined ? over.itemId : itemId,
      });
      // The first look decides show/movie; use that style if the guess changed.
      if (k === "auto" && !over.template && result.mode !== (m ?? "tv")) {
        const again = await api.plan({
          mode: result.mode as "tv" | "movie", folder: target, template: style[result.mode as "tv" | "movie"], show: sv || null, year: yv ? Number(yv) : null,
          findReplace: rules.filter((r) => r.find), recursive: true, source: over.source ?? source, matchId: null, renameFolder: rf, seasonFolders: over.seasonFolders ?? seasonFolders,
        });
        setPlan(again);
        setPicked(new Set(again.ops.filter((o) => o.status === "ok").map((o) => o.from)));
      } else {
        setPlan(result);
        setPicked(new Set(result.ops.filter((o) => o.status === "ok").map((o) => o.from)));
      }
      if (result.warning) setMessage({ text: result.warning, error: false });
    } catch (e) {
      setPlan(null);
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }, [target, kind, year, search, plan?.mode, style, renameFolder, rules, source, matchId, seasonFolders, onlyFile, itemId]);

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
      if (target !== null) void preview({ matchId: p.matchId, search: "", year: "", renameFolder: null, kind: p.kind, onlyFile: p.onlyFile, itemId: p.itemId, source: p.matchId ? "jellyfin" : undefined, template: p.kind === "auto" ? undefined : style[p.kind as "tv" | "movie"] });
    } else {
      setMatchId(null);
      setOnlyFile(null);
      setItemId(null);
      if (target !== null) void preview({ matchId: null, search: "", year: "", renameFolder: null, onlyFile: null, itemId: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const previewFor = () => preview({ search: "", year: "", renameFolder: null });

  async function apply() {
    if (!plan || !picked.size) return;
    const files = plan.ops.filter((o) => o.kind !== "folder" && picked.has(o.from)).length;
    const dirs = plan.ops.filter((o) => o.kind === "folder" && picked.has(o.from)).length;
    const what = [files ? `${files} file${files === 1 ? "" : "s"}` : "", dirs ? `${dirs} folder${dirs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    if (!(await askConfirm(`Rename ${what}? Nothing is deleted or overwritten, and you can undo it.`, { okLabel: "Rename" }))) return;
    setBusy("Renaming…");
    try {
      const rep = await api.apply(plan.planId, removeEmpty, [...picked]);
      setDone({ batch: rep.batch, count: rep.done });
      if (rep.failed.length) setMessage({ text: `${rep.failed.length} skipped: ${rep.failed.slice(0, 3).join("; ")}`, error: true });
      // Follow the renamed folder, so "check again" looks at the right place.
      const top = plan.ops.find((o) => o.kind === "folder" && o.from === target && picked.has(o.from));
      setPlan(null);
      loadHistory();
      onChanged();
      void api.libraryScan().catch(() => undefined);
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
          <button className="icon-btn" title="Show in Finder" onClick={() => void api.revealRel(target ?? "").catch((e) => setMessage({ text: errorText(e), error: true }))}><Icon name="folder" /></button>
          <div className="seg">
            {(["auto", "tv", "movie"] as Kind[]).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); void preview({ kind: k, matchId: null, template: k === "auto" ? undefined : style[k as "tv" | "movie"] }); }}>
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
                <button className={tab === "infuse" ? "on" : ""} onClick={() => setTab("infuse")}>How Infuse shows it</button>
                <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Files and folders</button>
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
                <label className="check small"><input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} />Only show what changes</label>
                <div className="file-table">
                  {rows.map((o) => {
                    const st = stateOf(o);
                    const can = o.status === "ok";
                    return (
                      <div className={`file-row ${o.kind}`} key={o.from}>
                        <input type="checkbox" disabled={!can} checked={picked.has(o.from)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(o.from)) n.delete(o.from); else n.add(o.from); return n; })} aria-label="Include" />
                        <div className="names">
                          <div className="small muted">{o.kind === "folder" ? "Folder" : dirOf(o.from) || "(top)"}</div>
                          <div className="mono">{last(o.from)}</div>
                          {o.from !== o.to && <div className="mono to">→ {o.kind === "folder" ? last(o.to) : last(o.to)}</div>}
                          <div className={`small ${o.status === "ok" ? "muted" : "warn"}`}>{explain(o, plan.chosen ? SOURCE_LABEL[plan.chosen.source] : null).join(" · ")}</div>
                        </div>
                        {o.kind === "video" && o.score != null && <span className={`small strong ${o.score >= 90 ? "ok" : o.score >= 75 ? "warn" : "bad"}`}>{o.score}%</span>}
                        <span className={`small strong ${st.cls}`}>{st.label}</span>
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
                <div className="style-cards">
                  {STYLES[mode].map((s) => (
                    <button key={s.id} className={`style-card ${style[mode] === s.value && !custom ? "on" : ""}`} onClick={() => { setCustom(false); setStyle({ ...style, [mode]: s.value }); void preview({ template: s.value }); }}>
                      <div className="strong">{s.label}</div>
                      <div className="mono small muted">{s.hint}</div>
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

const TV_TEMPLATE = STYLES.tv[0].value;
const MOVIE_TEMPLATE = STYLES.movie[0].value;

function presetFor(r: CheckRow): Preset {
  return r.kind === "series"
    ? { folder: r.folder, kind: "tv", matchId: `jellyfin:${r.id}`, onlyFile: null, itemId: null, label: `${r.name}${r.year ? ` (${r.year})` : ""}` }
    : { folder: r.folder, kind: "movie", matchId: null, onlyFile: r.file, itemId: r.id, label: `${r.name}${r.year ? ` (${r.year})` : ""}` };
}

/** Plans and renames one checked title the same way the check did. Returns files renamed. */
async function renameRow(r: CheckRow): Promise<number> {
  const p = presetFor(r);
  const plan = await api.plan({
    mode: p.kind, folder: p.folder, template: r.kind === "series" ? TV_TEMPLATE : MOVIE_TEMPLATE, show: null, year: null,
    findReplace: [], recursive: r.kind === "series", source: r.kind === "series" ? "jellyfin" : "none", matchId: p.matchId,
    renameFolder: null, seasonFolders: false, onlyFile: p.onlyFile, itemId: p.itemId,
  });
  const ok = plan.ops.filter((o) => o.status === "ok").map((o) => o.from);
  if (!ok.length) return 0;
  const rep = await api.apply(plan.planId, true, ok);
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

function CheckDetail({ r, onFix, onDone }: { r: CheckRow; onFix: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [ids, setIds] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showRight, setShowRight] = useState(false);

  useEffect(() => {
    const p = presetFor(r);
    api.plan({
      mode: p.kind, folder: p.folder, template: r.kind === "series" ? TV_TEMPLATE : MOVIE_TEMPLATE, show: null, year: null,
      findReplace: [], recursive: r.kind === "series", source: r.kind === "series" ? "jellyfin" : "none", matchId: p.matchId,
      renameFolder: null, seasonFolders: false, onlyFile: p.onlyFile, itemId: p.itemId,
    }).then((pl) => {
      setPlan(pl);
      setPicked(new Set(pl.ops.filter((o) => o.status === "ok").map((o) => o.from)));
    }).catch((e) => setError(errorText(e)));
    api.details(r.id).then((d) => setIds(d.item.ProviderIds ?? {})).catch(() => undefined);
  }, [r.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  async function apply() {
    if (!plan || !picked.size) return;
    setBusy(true);
    try {
      await track(`Renaming ${r.name}`, async () => {
        const rep = await api.apply(plan.planId, true, [...picked]);
        if (rep.failed.length) throw `${rep.done} renamed; ${rep.failed.length} skipped: ${rep.failed[0]}`;
        await api.libraryScan().catch(() => undefined);
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
              <li className={ids.Tmdb || ids.Tvdb || ids.Imdb ? "ok" : "warn"}>
                {ids.Tmdb || ids.Tvdb || ids.Imdb ? `Identified in Jellyfin as “${r.name}${r.year ? ` (${r.year})` : ""}” (${idText})` : "Not identified in Jellyfin yet, so the name and year aren't certain"}
              </li>
              <li className={known === videos.length && videos.length ? "ok" : "warn"}>{known} of {videos.length} episode files were found in the episode list{plan.titlesFound ? ` (${plan.titlesFound} titles known)` : ""}</li>
              {plan.unparsed > 0 && <li className="warn">{plan.unparsed} file{plan.unparsed === 1 ? "" : "s"} without a season/episode number: left alone</li>}
              {plan.conflict > 0 && <li className="warn">{plan.conflict} would clash with an existing file: skipped</li>}
            </>
          ) : (
            <>
              <li className={ids.Tmdb || ids.Imdb ? "ok" : "warn"}>{ids.Tmdb || ids.Imdb ? `Jellyfin knows this file as “${r.name}${r.year ? ` (${r.year})` : ""}” (${idText})` : "Not identified in Jellyfin yet"}</li>
              <li>Only this movie's own files are touched (the video and files with the same name)</li>
            </>
          )}
          <li className="muted">Nothing is deleted or overwritten, and the whole rename can be undone in History.</li>
        </ul>
      </div>

      <div className="row between">
        <div className="row">
          <button className="link small" onClick={() => setPicked(new Set(plan.ops.filter((o) => o.status === "ok").map((o) => o.from)))}>Select all</button>
          <button className="link small" onClick={() => setPicked(new Set())}>Select none</button>
          <label className="check small"><input type="checkbox" checked={showRight} onChange={(e) => setShowRight(e.target.checked)} />Also show what's already right ({plan.unchanged})</label>
        </div>
        <div className="row end">
          {!(ids.Tmdb || ids.Tvdb || ids.Imdb) && <button onClick={() => nav.open(r.id, { tab: "identify" })}>Identify first…</button>}
          <button onClick={onFix}>More options…</button>
          <button className="primary" disabled={!picked.size || busy} onClick={() => void apply()}>{busy ? "Renaming…" : `Rename ${picked.size} selected`}</button>
        </div>
      </div>

      <div className="change-list">
        {[...groups.entries()].map(([g, ops]) => (
          <div key={g}>
            <div className="change-group small strong">{g}</div>
            {ops.map((o) => {
              const can = o.status === "ok";
              return (
                <label key={o.from} className={`change ${can ? "" : "off"}`}>
                  <input type="checkbox" disabled={!can} checked={picked.has(o.from)} onChange={() => toggle(o.from)} />
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

function CheckList({ status, onFix }: { status: Status; onFix: (r: CheckRow) => void }) {
  const epoch = useEpoch();
  const [res, setRes] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [show, setShow] = useState<"todo" | "right" | "errors">("todo");
  const [open, setOpen] = useState<string | null>(null);
  const [scope, setScope] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.namingCheckLast().then((r) => setRes(r)).catch(() => setRes(null));
  }, [epoch]);

  async function check(ids: string[] | null = null) {
    setError(null);
    try {
      await track(ids ? "Checking names again" : "Checking every show and movie", async (job) => {
        const un = await listen<{ done: number; total: number; name: string }>("naming-progress", (e) => {
          setChecking(e.payload.name ? `${e.payload.name} (${e.payload.done + 1}/${e.payload.total})` : null);
          job.update(e.payload.name, e.payload.total ? e.payload.done / e.payload.total : null);
        });
        try {
          setRes(await api.namingCheck(TV_TEMPLATE, MOVIE_TEMPLATE, ids));
        } finally {
          un();
          setChecking(null);
        }
      }, { reload: false });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const rows = res?.rows ?? [];
  const top = (r: CheckRow) => r.folder.split("/")[0] || "(library folder)";
  const tops = [...new Set(rows.map(top))].sort();
  const q = filter.toLowerCase();
  const match = (r: CheckRow) => (!scope.size || scope.has(top(r))) && (!q || r.name.toLowerCase().includes(q) || r.folder.toLowerCase().includes(q));
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
        for (const [i, r] of list.entries()) {
          if (job.cancelled) break;
          job.update(r.name, i / list.length);
          try {
            n += await renameRow(r);
          } catch (e) {
            failed.push(`${r.name}: ${errorText(e)}`);
          }
        }
        job.update("Asking Jellyfin to scan", null);
        await api.libraryScan().catch(() => undefined);
        await check(list.map((r) => r.id));
        setPicked(new Set());
        if (failed.length) throw `${n} renamed; ${failed.length} failed: ${failed[0]}`;
        job.update(`${n} renamed`, 1);
      }, { cancellable: true });
    } catch (e) {
      setError(errorText(e));
    }
  }

  const rowView = (r: CheckRow) => (
    <div key={r.id} className={`check-item ${open === r.id ? "open" : ""}`}>
      <div
        className="check-row"
        onContextMenu={(e) => openMenu(e, [
          { label: open === r.id ? "Hide the changes" : "Show the changes", run: () => setOpen(open === r.id ? null : r.id) },
          { label: "More options…", run: () => onFix(r) },
          { label: "Open title", run: () => nav.open(r.id) },
          { label: "Show folder in Finder", run: () => void api.revealRel(r.folder).catch(() => undefined) },
          { label: "Check again", run: () => void check([r.id]) },
          { sep: true },
          ...itemMenu({ id: r.id, kind: r.kind, title: r.name }).filter((m) => m.label === "Identify…" || m.label === "Fill in missing artwork"),
        ])}
      >
        {r.sure ? <input type="checkbox" checked={picked.has(r.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} aria-label="Select" /> : <span style={{ width: 16 }} />}
        <button className="thumb" onClick={() => nav.open(r.id)} title="Open"><img src={imageUrl(r.id, "Primary", 120)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></button>
        <button className="check-main link-plain" onClick={() => setOpen(open === r.id ? null : r.id)}>
          <div className="title">{r.name}{r.year ? <span className="muted"> ({r.year})</span> : null} <span className="muted small">· {r.kind === "series" ? "Show" : "Movie"} · <span className="mono">{r.folder || "(library folder)"}</span></span></div>
          <div className="check-reasons">
            {r.sure && <span className="chip static on">100% match</span>}
            {r.error ? <span className="bad small">{r.error}</span> : r.reasons.map((x, i) => <span key={i} className={`small ${/Not identified|clash|without/.test(x) ? "warn" : "muted"}`}>{x}</span>)}
          </div>
          {r.example && open !== r.id && <div className="mono small check-example"><span className="muted">{r.example[0]}</span> <span className="accent">→ {r.example[1]}</span></div>}
        </button>
        <div className="row end">
          <button className="icon-btn" title="Show in Finder" onClick={() => void api.revealRel(r.folder).catch(() => undefined)}><Icon name="folder" /></button>
          <button onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? "Hide" : "See changes"}</button>
        </div>
      </div>
      {open === r.id && <CheckDetail r={r} onFix={() => onFix(r)} onDone={() => { setOpen(null); void check([r.id]); }} />}
    </div>
  );

  if (!status.libraryRoot) return null;
  return (
    <div className="stack">
      <section className="card form">
        <div className="row between">
          <div>
            <div className="strong">Which shows and movies are named wrong, and why</div>
            <div className="muted small">{res ? `Last checked ${new Date(res.at * 1000).toLocaleString()} · ${rows.length} titles` : "Not checked yet. Checking renames nothing."} Click a title to see every change and why; pick the files you want.</div>
          </div>
          <div className="row end">
            {checking ? <button onClick={() => void api.namingCheckCancel()}>Stop</button> : (
              <>
                {scope.size > 0 && <button onClick={() => void check(rows.filter((r) => scope.has(top(r))).map((r) => r.id))}>Check only {[...scope].join(", ")}</button>}
                <button className="primary" onClick={() => void check()}>{res ? "Check everything again" : "Check my library"}</button>
              </>
            )}
          </div>
        </div>
        {tops.length > 1 && (
          <div className="chips">
            <span className="muted small">Folders:</span>
            <button className={`chip ${scope.size === 0 ? "on" : ""}`} onClick={() => setScope(new Set())}>All</button>
            {tops.map((t) => <button key={t} className={`chip ${scope.has(t) ? "on" : ""}`} onClick={() => setScope((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })}>{t}</button>)}
          </div>
        )}
        {checking && <div className="muted small">Checking {checking}…</div>}
        {error && <p className="error">{error}</p>}
      </section>

      {res && (
        <>
          <div className="toolbar">
            <div className="chips">
              <button className={`chip ${show === "todo" ? "on" : ""}`} onClick={() => setShow("todo")}>To fix ({todo.filter(match).length})</button>
              <button className={`chip ${show === "right" ? "on" : ""}`} onClick={() => setShow("right")}>Already right ({right.filter(match).length})</button>
              {errors.length > 0 && <button className={`chip ${show === "errors" ? "on" : ""}`} onClick={() => setShow("errors")}>Couldn't check ({errors.filter(match).length})</button>}
            </div>
            <label className="searchbox"><Icon name="search" /><input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
          </div>

          {show === "todo" && (
            <>
              {sure.filter(match).length > 0 && (
                <section className="card list-card">
                  <div className="section-head">
                    <div>
                      <h2>Sure matches ({sure.filter(match).length})</h2>
                      <div className="muted small">Identified in Jellyfin and every episode found in the episode list. Safe to rename in one go.</div>
                    </div>
                    <div className="row end">
                      <button className="link small" onClick={() => setPicked(new Set(sure.filter(match).map((r) => r.id)))}>Select all</button>
                      <button className="primary" disabled={!sure.some((r) => picked.has(r.id) && match(r))} onClick={() => void bulk()}>Rename {sure.filter((r) => picked.has(r.id) && match(r)).length || ""} selected</button>
                    </div>
                  </div>
                  {sure.filter(match).map(rowView)}
                </section>
              )}
              {look.filter(match).length > 0 && (
                <section className="card list-card">
                  <div className="section-head">
                    <div>
                      <h2>Needs a look ({look.filter(match).length})</h2>
                      <div className="muted small">Not identified, some episodes not in the list, or files without numbers. Open one to choose what to rename.</div>
                    </div>
                  </div>
                  {look.filter(match).map(rowView)}
                </section>
              )}
              {todo.filter(match).length === 0 && <p className="ok strong">Everything here is named right.</p>}
            </>
          )}
          {show === "right" && (
            <section className="card list-card">
              {right.filter(match).slice(0, 400).map((r) => (
                <button key={r.id} className="tool-row" onClick={() => nav.open(r.id)}>
                  <div className="names"><div className="title">{r.name}{r.year ? ` (${r.year})` : ""}</div><div className="muted small mono">{r.folder}</div></div>
                  <span className="ok small">✓ {r.right} right</span>
                </button>
              ))}
            </section>
          )}
          {show === "errors" && <section className="card list-card">{errors.filter(match).map(rowView)}</section>}
        </>
      )}
    </div>
  );
}

export default function Renamer({ status, onChanged, start, embedded }: {
  status: Status; onChanged: () => void; onNav: (v: View) => void;
  start?: { folder?: string; item?: string }; embedded?: boolean;
}) {
  const [mode, setMode] = useState<"check" | "folder">(start ? "folder" : "check");
  const [preset, setPreset] = useState<Preset | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Opened for one title: find its folder (and file, for a movie) first.
  useEffect(() => {
    if (!start?.item) {
      if (start?.folder !== undefined) setPreset({ folder: start.folder, kind: "auto", matchId: null, onlyFile: null, itemId: null });
      return;
    }
    setError(null);
    api.namingCheck(TV_TEMPLATE, MOVIE_TEMPLATE, [start.item])
      .then((r) => {
        const row = r.rows.find((x) => x.id === start.item);
        if (!row) throw "Jellyfin has no file location for this title.";
        if (row.error && !row.folder) throw row.error;
        setPreset(presetFor(row));
      })
      .catch((e) => setError(errorText(e)));
  }, [start?.item, start?.folder]);

  const fix = (r: CheckRow) => {
    setPreset(presetFor(r));
    setMode("folder");
  };

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
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Renamer</h1>
          <div className="muted small">Fixes file and folder names so Jellyfin and Infuse recognise every show, season and movie.</div>
        </div>
        <div className="seg">
          <button className={mode === "check" ? "on" : ""} onClick={() => setMode("check")}>Library check</button>
          <button className={mode === "folder" ? "on" : ""} onClick={() => { setPreset(undefined); setMode("folder"); }}>Pick a folder</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {mode === "check" ? (
        status.libraryRoot ? <CheckList status={status} onFix={fix} /> : <FolderFix status={status} onChanged={onChanged} />
      ) : (
        <>
          {preset && <p className="muted small"><button className="link" onClick={() => setMode("check")}>← Back to the list</button></p>}
          <FolderFix key={preset ? `${preset.folder}|${preset.itemId ?? ""}` : "free"} status={status} onChanged={onChanged} preset={preset} />
        </>
      )}
    </div>
  );
}
