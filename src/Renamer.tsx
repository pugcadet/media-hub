import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Batch, Candidate, errorText, FindReplace, imageUrl, PlanArgs, PlanOp, PlanResult, remoteImageUrl, Status } from "./api";
import { askConfirm } from "./confirm";
import type { View } from "./App";

type Mode = "tv" | "movie";
type Source = PlanArgs["source"];

const STYLES: Record<Mode, { id: string; label: string; example: string; value: string }[]> = {
  tv: [
    { id: "standard", label: "Standard", example: "Name - S01E02 - Title", value: "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}" },
    { id: "clean", label: "Clean", example: "02 Title · Infuse folders only", value: "{show}< ({year})>/{seasondir}/{e:00}< {title}>.{ext}" },
  ],
  movie: [
    { id: "standard", label: "Standard", example: "Title (Year)/Title (Year)", value: "{title}< ({year})>/{title}< ({year})>.{ext}" },
    { id: "ids", label: "With TMDB id", example: "Title (Year) {tmdb-…}", value: "{title}< ({year})>< {tmdbtag}>/{title}< ({year})>< {tmdbtag}>.{ext}" },
  ],
};
const TOKENS: Record<Mode, string> = {
  tv: "{show} {year} {s} {s:00} {e} {e:00} {sxe} {seasondir} {title} {ext} {tmdbtag} {tvdbtag}",
  movie: "{title} {year} {ext} {tmdbtag} {imdbtag}",
};
const SOURCE_LABEL: Record<string, string> = { auto: "Auto", jellyfin: "Jellyfin", tmdb: "TMDB", tvmaze: "TVmaze", none: "Off (file names)" };
const TITLE_LANGS: [string, string][] = [["en-US", "English"], ["nl-NL", "Nederlands"], ["de-DE", "Deutsch"], ["fr-FR", "Français"], ["es-ES", "Español"]];

function rowState(o: PlanOp): { label: string; cls: string } {
  if (o.status === "conflict") return { label: "Conflict", cls: "bad" };
  if (o.status === "unparsed") return { label: "Not understood", cls: "bad" };
  if (o.status === "unchanged") return { label: "Already right", cls: "muted" };
  if (o.kind === "video" && (o.score ?? 100) < 80) return { label: "Check", cls: "warn" };
  if (!o.verified) return { label: "Check", cls: "warn" };
  return { label: "Ready", cls: "ok" };
}

const join = (base: string, name: string) => (base ? `${base}/${name}` : name);

export default function Renamer({ status, onChanged }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
  const [mode, setMode] = useState<Mode>("tv");
  const [base, setBase] = useState("");
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [template, setTemplate] = useState(STYLES.tv[0].value);
  const [source, setSource] = useState<Source>("auto");
  const [matchId, setMatchId] = useState<string | null>(null);
  const [show, setShow] = useState("");
  const [year, setYear] = useState("");
  const [rules, setRules] = useState<FindReplace[]>([]);
  const [recursive, setRecursive] = useState(true);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [removeEmpty, setRemoveEmpty] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);
  const [applied, setApplied] = useState(false);
  const root = status.libraryRoot;

  useEffect(() => {
    if (!root) return;
    api.folders(base).then(setFolders).catch((e) => { setMessage({ text: errorText(e), error: true }); setFolders([]); });
  }, [root, base]);
  const loadHistory = useCallback(() => void api.history().then(setHistory).catch(() => setHistory([])), []);
  useEffect(() => loadHistory(), [loadHistory]);

  const preview = useCallback(async (over: Partial<{ matchId: string | null; source: Source; show: string; year: string }> = {}) => {
    if (target === null) return;
    setBusy("Matching…");
    setMessage(null);
    setApplied(false);
    try {
      const yv = over.year ?? year;
      const sv = over.show ?? show;
      const y = yv.trim() ? Number(yv) : null;
      const result = await api.plan({
        mode, folder: target, template, show: sv.trim() || null, year: y !== null && Number.isFinite(y) ? y : null,
        findReplace: rules.filter((r) => r.find), recursive,
        source: over.source ?? source, matchId: over.matchId !== undefined ? over.matchId : matchId,
      });
      setPlan(result);
      setPicked(new Set(result.ops.filter((o) => o.kind === "video" && o.status === "ok").map((o) => o.from)));
      if (result.warning) setMessage({ text: result.warning, error: false });
    } catch (e) {
      setPlan(null);
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }, [target, year, mode, template, show, rules, recursive, source, matchId]);

  // A new folder: forget the old match and preview straight away.
  useEffect(() => {
    setPlan(null);
    setMatchId(null);
    setShow("");
    setYear("");
    if (target !== null) void previewFresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  const previewFresh = () => preview({ matchId: null, show: "", year: "" });

  function switchMode(m: Mode) {
    setMode(m);
    setTemplate(STYLES[m][0].value);
    setTarget(null);
    setPlan(null);
  }

  async function apply() {
    if (!plan) return;
    const n = picked.size;
    if (!n) return;
    const ok = await askConfirm(`Rename ${n} file${n === 1 ? "" : "s"} (and their subtitles)? Nothing is deleted or overwritten, and you can undo this from History.`, { okLabel: `Apply ${n} changes` });
    if (!ok) return;
    setBusy("Renaming…");
    try {
      const rep = await api.apply(plan.planId, removeEmpty, [...picked]);
      setMessage({
        text: `Renamed ${rep.done} file${rep.done === 1 ? "" : "s"}.` + (rep.failed.length ? ` ${rep.failed.length} skipped: ${rep.failed.slice(0, 3).join("; ")}` : " Jellyfin picks up the new names at its next library scan."),
        error: rep.failed.length > 0,
      });
      setPlan(null);
      setApplied(true);
      loadHistory();
      onChanged();
      api.folders(base).then(setFolders).catch(() => undefined);
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function undo(b: Batch) {
    if (!(await askConfirm(`Put ${b.files - b.undone} file(s) back to their old names?`, { okLabel: "Undo" }))) return;
    try {
      const rep = await api.undo(b.batch);
      setMessage({ text: `Restored ${rep.restored} file(s).` + (rep.skipped.length ? ` Skipped: ${rep.skipped.slice(0, 3).join("; ")}` : ""), error: rep.skipped.length > 0 });
      loadHistory();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  const videoOps = useMemo(() => (plan?.ops ?? []).filter((o) => o.kind === "video"), [plan]);
  const rows = useMemo(() => videoOps.filter((o) => showAll || o.status !== "unchanged"), [videoOps, showAll]);
  const counts = useMemo(() => {
    const c = { ready: 0, check: 0, conflict: 0 };
    for (const o of videoOps) {
      const s = rowState(o).label;
      if (s === "Ready") c.ready++;
      else if (s === "Check") c.check++;
      else if (s === "Conflict" || s === "Not understood") c.conflict++;
    }
    return c;
  }, [videoOps]);

  const infuse = useMemo(() => {
    const seasons = new Map<number, PlanOp[]>();
    for (const o of videoOps) {
      if (o.status === "unparsed" || o.season == null) continue;
      if (!seasons.has(o.season)) seasons.set(o.season, []);
      seasons.get(o.season)!.push(o);
    }
    return [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([s, list]) => ({ s, list: list.sort((a, b) => (a.episodes[0] ?? 0) - (b.episodes[0] ?? 0)) }));
  }, [videoOps]);

  const step = target === null ? 0 : !plan ? (applied ? 3 : 1) : 2;
  const steps = ["Source", "Match", "Preview", "Apply"];
  const showName = plan?.chosen?.name ?? (show || plan?.guess || target?.split("/").pop() || "");
  const visibleFolders = folders.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase()));
  const crumbs = base ? base.split("/") : [];
  const posterOf = (c: Candidate | null | undefined) => (c?.poster ? remoteImageUrl(c.poster) : c?.source === "jellyfin" ? imageUrl(c.id, "Primary", 160) : null);

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
        <h1>Renamer</h1>
        <div className="steps-row">
          {steps.map((s, i) => (
            <button key={s} className={`step ${i === step ? "on" : i < step ? "done" : ""}`} onClick={() => i === 0 && setTarget(null)} disabled={i !== 0}>
              <span className="step-dot">{i < step ? "✓" : i + 1}</span>{s}
            </button>
          ))}
        </div>
      </div>
      {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

      {target === null ? (
        <div className="card form source-card">
          <div className="row between">
            <div className="seg">
              <button className={mode === "tv" ? "on" : ""} onClick={() => switchMode("tv")}>Shows</button>
              <button className={mode === "movie" ? "on" : ""} onClick={() => switchMode("movie")}>Movies</button>
            </div>
            <span className="muted small mono">{root}</span>
          </div>
          <div className="crumbs">
            <button className="link" onClick={() => setBase("")}>Library</button>
            {crumbs.map((c, i) => <span key={i}> / <button className="link" onClick={() => setBase(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
          </div>
          <p className="muted small">{mode === "tv" ? "Open the folder with your shows (or an incoming folder), then click a show." : "Open the folder with your movies, then click Use this folder."}</p>
          <div className="row">
            <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {mode === "movie" && <button className="primary" onClick={() => setTarget(base)}>Use this folder</button>}
            {mode === "movie" && <label className="check small"><input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />Include sub-folders</label>}
          </div>
          <ul className="folders tall">
            {visibleFolders.map((f) => {
              const rel = join(base, f.name);
              return (
                <li key={f.name}>
                  <button className="pick" onClick={() => setTarget(rel)}>{f.name}</button>
                  <button className="open" onClick={() => { setBase(rel); setFilter(""); }} title="Open folder">›</button>
                </li>
              );
            })}
            {visibleFolders.length === 0 && <li className="muted small">No folders here.</li>}
          </ul>
        </div>
      ) : (
        <div className="ren-cols">
          <section className="ren-main">
            <div className="section-head">
              <h2 className="big">{showName || "Movies"} <span className="muted thin">· {target || "library folder"}</span></h2>
              <span className="muted small">Showing {rows.length} of {videoOps.length} files</span>
            </div>

            {busy === "Matching…" && <p className="muted">Reading the folder and matching online…</p>}
            {plan && (
              <>
                <div className="card table-card">
                  <div className="ren-row head"><span /><span>Current name</span><span>New name</span><span>Match</span><span>Status</span></div>
                  {rows.map((o) => {
                    const st = rowState(o);
                    const selectable = o.status === "ok";
                    return (
                      <div className="ren-row" key={o.from}>
                        <input type="checkbox" disabled={!selectable} checked={picked.has(o.from)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(o.from)) n.delete(o.from); else n.add(o.from); return n; })} aria-label="Select file" />
                        <span className="mono small muted brk">{o.from}</span>
                        <span className="mono small brk" title={o.note ?? ""}>{o.from === o.to ? "—" : o.to}{o.note && <span className="note-line">{o.note}</span>}</span>
                        <span className={`small strong ${o.score == null ? "muted" : o.score >= 90 ? "ok" : o.score >= 75 ? "warn" : "bad"}`}>{o.score == null ? "–" : `${o.score}%`}</span>
                        <span className={`small strong ${st.cls}`}>{st.label}</span>
                      </div>
                    );
                  })}
                  {rows.length === 0 && <p className="muted small pad">All files already have the right names.</p>}
                </div>
                <label className="check small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Show files that are already right</label>

                <div className="dryrun">
                  <div>
                    <div className="strong">Dry run · {counts.ready} ready, {counts.check} to check, {counts.conflict} conflict</div>
                    <div className="muted small">Nothing is renamed until you apply. The old names are kept so this can be undone. Subtitles move along with their video.</div>
                    <label className="check small"><input type="checkbox" checked={removeEmpty} onChange={(e) => setRemoveEmpty(e.target.checked)} />Remove folders left empty</label>
                  </div>
                  <div className="row">
                    <button onClick={() => setTarget(null)}>Cancel</button>
                    <button className="primary" disabled={!picked.size || !!busy} onClick={() => void apply()}>{busy === "Renaming…" ? "Renaming…" : `Apply ${picked.size} changes`}</button>
                  </div>
                </div>
              </>
            )}
          </section>

          <aside className="ren-side">
            <div className="card form">
              <h2>Naming style</h2>
              <div className="style-cards">
                {STYLES[mode].map((s) => (
                  <button key={s.id} className={`style-card ${template === s.value ? "on" : ""}`} onClick={() => setTemplate(s.value)}>
                    <div className="strong">{s.label}</div>
                    <div className="mono small muted">{s.example}</div>
                  </button>
                ))}
              </div>
              <label>Pattern<input className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} /></label>
              <p className="muted small">Items: <span className="mono">{TOKENS[mode]}</span>. Optional parts go in &lt; &gt;.</p>
              <div className="chips">
                <span className="chip static on">Engine: Built-in</span>
                <label className="chip static selchip">Data:
                  <select value={source} onChange={(e) => { setSource(e.target.value as Source); setMatchId(null); void preview({ source: e.target.value as Source, matchId: null }); }}>
                    {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k} disabled={k === "tmdb" && !status.hasTmdb}>{v}{k === "tmdb" && !status.hasTmdb ? " (add key in Settings)" : ""}</option>)}
                  </select>
                </label>
                <label className="chip static selchip">Titles:
                  <select value={status.titleLang} onChange={(e) => void api.setTitleLang(e.target.value).then(() => { onChanged(); })} disabled={!status.hasTmdb} title={status.hasTmdb ? "" : "Title language needs TMDB"}>
                    {TITLE_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <span className="chip static">Remove release tags</span>
              </div>
              <button className="primary" disabled={!!busy} onClick={() => void preview()}>Update preview</button>
            </div>

            {mode === "tv" && plan && (
              <div className="card form">
                <h2>Match</h2>
                {plan.chosen ? (
                  <div className="match-chosen">
                    {posterOf(plan.chosen) ? <img src={posterOf(plan.chosen)!} alt="" /> : <div className="thumb" />}
                    <div>
                      <div className="strong">{plan.chosen.name}{plan.chosen.year ? ` (${plan.chosen.year})` : ""}</div>
                      <div className="muted small">{SOURCE_LABEL[plan.chosen.source]} · {plan.chosen.score}% · {plan.titlesFound} episode titles</div>
                    </div>
                  </div>
                ) : <p className="muted small">No confident match{plan.guess ? ` for “${plan.guess}”` : ""}.</p>}
                {plan.candidates.length > 0 && (
                  <label>Other matches
                    <select value={plan.chosen ? `${plan.chosen.source}:${plan.chosen.id}` : ""} onChange={(e) => { setMatchId(e.target.value || null); void preview({ matchId: e.target.value || null }); }}>
                      <option value="">None (use file names)</option>
                      {plan.candidates.map((c) => <option key={`${c.source}:${c.id}`} value={`${c.source}:${c.id}`}>{c.name}{c.year ? ` (${c.year})` : ""} · {SOURCE_LABEL[c.source]} · {c.score}%</option>)}
                    </select>
                  </label>
                )}
                <div className="row">
                  <label>Search for<input value={show} placeholder={plan.guess} onChange={(e) => setShow(e.target.value)} /></label>
                  <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
                </div>
                <button disabled={!!busy} onClick={() => { setMatchId(null); void preview({ matchId: null }); }}>Search again</button>
              </div>
            )}
            {mode === "movie" && plan && (
              <div className="card form"><h2>Match</h2><p className="muted small">{plan.matchedMovies} of {videoOps.length} movies matched online ({status.hasTmdb ? "TMDB" : "Jellyfin's TMDB lookup"}).</p></div>
            )}

            {mode === "tv" && plan && (
              <div className="card form">
                <div className="section-head"><h2>As it appears in Infuse</h2><span className="muted small">Preview</span></div>
                <div className="infuse-box">
                  <div className="infuse-show">
                    {posterOf(plan.chosen) ? <img src={posterOf(plan.chosen)!} alt="" /> : <div className="thumb" />}
                    <div>
                      <div className="strong">{showName}</div>
                      <div className="muted small">{infuse.map((x) => `${x.s === 0 ? "Specials" : `Season ${x.s}`} · ${x.list.length} episodes`).join(" · ")}</div>
                    </div>
                  </div>
                  {infuse.slice(0, 3).map((x) => x.list.slice(0, 8).map((o) => (
                    <div className="infuse-ep" key={o.from}>
                      <span><span className="muted">{o.episodes.join("-")}</span>&nbsp;&nbsp;{(o.to.split("/").pop() ?? "").replace(/\.[^.]+$/, "").split(" - ").slice(2).join(" - ") || o.to.split("/").pop()}</span>
                      <span className="muted small">{x.s === 0 ? "Special" : `S${x.s}`}</span>
                    </div>
                  )))}
                </div>
                <div className="checks">
                  <div><span className={plan.chosen ? "ok" : "warn"}>{plan.chosen ? "✓" : "!"}</span>{plan.chosen ? `Show recognised and matched${Object.keys(plan.chosen.ids).length ? " by ID" : ""}` : "Show not matched online; names come from the files"}</div>
                  <div><span className={videoOps.every((o) => o.verified || o.status !== "ok") ? "ok" : "warn"}>{videoOps.every((o) => o.verified || o.status !== "ok") ? "✓" : "!"}</span>Season folder and S01E02 pattern are read correctly</div>
                  <div><span className="ok">✓</span>No characters Infuse cannot handle</div>
                  {plan.conflict > 0 && <div><span className="warn">!</span>{plan.conflict} file(s) would clash with another name, so they are skipped</div>}
                  {plan.unparsed > 0 && <div><span className="warn">!</span>{plan.unparsed} file(s) have no season/episode number and are left alone</div>}
                </div>
              </div>
            )}

            <details className="card form">
              <summary className="strong">Find and replace</summary>
              {rules.map((r, i) => (
                <div className="rule" key={i}>
                  <input placeholder="Find" value={r.find} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, find: e.target.value } : x)))} />
                  <input placeholder="Replace with" value={r.replace} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))} />
                  <label className="check small"><input type="checkbox" checked={r.regex} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, regex: e.target.checked } : x)))} />Pattern</label>
                  <button onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">×</button>
                </div>
              ))}
              <button className="link" onClick={() => setRules([...rules, { find: "", replace: "", regex: false }])}>+ Add rule</button>
            </details>
          </aside>
        </div>
      )}

      {history.length > 0 && (
        <section className="card history">
          <h2>History</h2>
          {history.slice(0, 10).map((b) => (
            <div className="batch" key={b.batch}>
              <div>
                <div>{b.files} file{b.files === 1 ? "" : "s"} · {new Date(b.at * 1000).toLocaleString()}</div>
                <div className="muted small mono">{b.example}</div>
              </div>
              <div className="spacer" />
              {b.undone >= b.files ? <span className="muted small">Undone</span> : <button onClick={() => void undo(b)}>Undo</button>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
