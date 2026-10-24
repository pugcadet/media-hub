import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Batch, Candidate, errorText, FindReplace, imageUrl, PlanArgs, PlanOp, PlanResult, remoteImageUrl, Status } from "./api";
import { askConfirm } from "./confirm";
import type { View } from "./App";

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

export default function Renamer({ status, onChanged }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
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
  const root = status.libraryRoot;

  useEffect(() => {
    if (!root) return;
    api.folders(base).then(setFolders).catch((e) => { setMessage({ text: errorText(e), error: true }); setFolders([]); });
  }, [root, base]);
  const loadHistory = useCallback(() => void api.history().then(setHistory).catch(() => setHistory([])), []);
  useEffect(() => loadHistory(), [loadHistory]);

  const mode: "tv" | "movie" = plan?.mode === "movie" || kind === "movie" ? "movie" : "tv";

  const preview = useCallback(async (over: Partial<{ matchId: string | null; source: Source; search: string; year: string; kind: Kind; template: string; renameFolder: boolean | null; seasonFolders: boolean }> = {}) => {
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
  }, [target, kind, year, search, plan?.mode, style, renameFolder, rules, source, matchId, seasonFolders]);

  useEffect(() => {
    setPlan(null);
    setMatchId(null);
    setSearch("");
    setYear("");
    setRenameFolder(null);
    setDone(null);
    if (target !== null) void previewFor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const previewFor = () => preview({ matchId: null, search: "", year: "", renameFolder: null });

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
      if (top) setTarget(top.to);
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
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Renamer</h1>
          <div className="muted small">Fixes file and folder names so Jellyfin and Infuse recognise every show, season and movie.</div>
        </div>
      </div>
      {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

      {/* 1 · folder */}
      {target === null ? (
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
          <span className="mono grow">{target || last(root)}</span>
          <div className="seg">
            {(["auto", "tv", "movie"] as Kind[]).map((k) => (
              <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); void preview({ kind: k, matchId: null, template: k === "auto" ? undefined : style[k as "tv" | "movie"] }); }}>
                {k === "auto" ? `Auto${plan ? ` (${plan.mode === "movie" ? "movies" : "show"})` : ""}` : k === "tv" ? "Show" : "Movies"}
              </button>
            ))}
          </div>
          <button onClick={() => setTarget(null)}>Change folder</button>
        </section>
      )}

      {busy && <p className="muted">{busy}</p>}

      {done && (
        <section className="card form done-card">
          <div className="strong">Renamed {done.count} item{done.count === 1 ? "" : "s"}.</div>
          <div className="muted small">Jellyfin picks up the new names at its next library scan (Dashboard → Libraries → Scan, or wait for the scheduled scan).</div>
          <div className="row">
            <button className="primary" onClick={() => void previewFor()}>Check this folder again</button>
            <button onClick={() => void undo(done.batch, done.count)}>Undo</button>
            <button onClick={() => setTarget(null)}>Fix another folder</button>
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
                          {o.note && <div className="small warn">{o.note}</div>}
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

      {history.length > 0 && (
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
