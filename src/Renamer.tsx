import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Batch, errorText, FindReplace, Item, PlanOp, PlanResult, Status } from "./api";
import Nav from "./Nav";
import { askConfirm } from "./confirm";
import type { View } from "./App";

type Mode = "tv" | "movie";

const PRESETS: Record<Mode, { label: string; value: string }[]> = {
  tv: [
    { label: "Standard (Jellyfin & Infuse)", value: "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}" },
    { label: "Short file names", value: "{show}< ({year})>/{seasondir}/{sxe}< - {title}>.{ext}" },
    { label: "Season 1 instead of Season 01", value: "{show}< ({year})>/Season {s}/{show}< ({year})> - {sxe}< - {title}>.{ext}" },
  ],
  movie: [
    { label: "Standard (own folder per movie)", value: "{title}< ({year})>/{title}< ({year})>.{ext}" },
    { label: "Standard + TMDB id tag", value: "{title}< ({year})>< {tmdbtag}>/{title}< ({year})>< {tmdbtag}>.{ext}" },
    { label: "No folders", value: "{title}< ({year})>.{ext}" },
  ],
};

const TOKENS: Record<Mode, string> = {
  tv: "{show} {year} {s} {s:00} {e} {e:00} {sxe} {seasondir} {title} {ext} {tmdbtag} {tvdbtag}",
  movie: "{title} {year} {ext} {tmdbtag} {imdbtag}",
};

const STATUS_LABEL: Record<PlanOp["status"], string> = {
  ok: "Will rename",
  unchanged: "Already right",
  conflict: "Blocked",
  unparsed: "Not understood",
};

/** "Bluey (2018) {tmdb-1}" -> { name: "Bluey", year: 2018 } (only used to suggest a Jellyfin match). */
function guessName(folder: string): { name: string; year: number | null } {
  const noTags = folder.replace(/[{[][a-z]+-?[a-z0-9]+[}\]]/gi, "").trim();
  const m = noTags.match(/^(.*?)[\s.(]*((?:19|20)\d{2})\)?\s*$/);
  return m ? { name: m[1].trim(), year: Number(m[2]) } : { name: noTags, year: null };
}

function join(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function when(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

export default function Renamer({ status, onChanged, onNav }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
  const [mode, setMode] = useState<Mode>("tv");
  const [base, setBase] = useState(""); // folder being browsed, relative to the root
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [target, setTarget] = useState<string | null>(null); // selected show folder / movie folder
  const [template, setTemplate] = useState(PRESETS.tv[0].value);
  const [show, setShow] = useState("");
  const [year, setYear] = useState("");
  const [series, setSeries] = useState<Item[]>([]);
  const [seriesId, setSeriesId] = useState<string>("");
  const [ready, setReady] = useState(false); // series suggestion finished, first preview may run
  const [rules, setRules] = useState<FindReplace[]>([]);
  const [recursive, setRecursive] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [view, setView] = useState<"files" | "infuse">("files");
  const [showAll, setShowAll] = useState(false);
  const [removeEmpty, setRemoveEmpty] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [history, setHistory] = useState<Batch[]>([]);

  const root = status.libraryRoot;

  const loadFolders = useCallback(async () => {
    if (!root) return;
    try {
      setFolders(await api.folders(base));
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
      setFolders([]);
    }
  }, [root, base]);

  const loadHistory = useCallback(() => {
    api.history().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => void loadFolders(), [loadFolders]);
  useEffect(() => loadHistory(), [loadHistory]);

  function switchMode(m: Mode) {
    setMode(m);
    setTemplate(PRESETS[m][0].value);
    setTarget(null);
    setPlan(null);
  }

  async function chooseRoot() {
    try {
      const r = await api.pickRoot();
      if (r) {
        setBase("");
        setTarget(null);
        setPlan(null);
        onChanged();
      }
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  // When a show folder is chosen, suggest the matching Jellyfin series (for episode titles).
  useEffect(() => {
    setPlan(null);
    setShow("");
    setYear("");
    setSeries([]);
    setSeriesId("");
    setReady(false);
    if (target === null) return;
    if (mode !== "tv" || !target) {
      setReady(true);
      return;
    }
    const g = guessName(target.split("/").pop() ?? "");
    api
      .list("series", g.name, "name", 0, 8)
      .then((found) => {
        setSeries(found);
        const exact =
          found.find((s) => s.name.toLowerCase() === g.name.toLowerCase() && (g.year === null || s.year === g.year)) ??
          found.find((s) => s.name.toLowerCase() === g.name.toLowerCase());
        setSeriesId(exact?.id ?? "");
      })
      .catch(() => setSeries([]))
      .finally(() => setReady(true));
  }, [target, mode]);

  async function preview() {
    if (target === null) return;
    setBusy("Reading the folder…");
    setMessage(null);
    try {
      const y = year.trim() ? Number(year) : null;
      const result = await api.plan({
        mode,
        folder: target,
        template,
        show: show.trim() || null,
        year: y !== null && Number.isFinite(y) ? y : null,
        findReplace: rules.filter((r) => r.find),
        seriesId: mode === "tv" ? seriesId || null : null,
        recursive,
      });
      setPlan(result);
      if (result.warning) setMessage({ text: result.warning, error: false });
    } catch (e) {
      setPlan(null);
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  // First preview runs by itself once the series suggestion has settled.
  useEffect(() => {
    if (target === null || !ready) return;
    void preview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, ready]);

  async function apply() {
    if (!plan || plan.ok === 0) return;
    const ok = await askConfirm(
      `Rename ${plan.ok} file${plan.ok === 1 ? "" : "s"}? Nothing is deleted or overwritten, and you can undo this from the history below.`,
      { okLabel: "Rename" },
    );
    if (!ok) return;
    setBusy("Renaming…");
    try {
      const rep = await api.apply(plan.planId, removeEmpty);
      setMessage({
        text:
          `Renamed ${rep.done} file${rep.done === 1 ? "" : "s"}.` +
          (rep.failed.length ? ` ${rep.failed.length} skipped: ${rep.failed.slice(0, 3).join("; ")}` : ""),
        error: rep.failed.length > 0,
      });
      setPlan(null);
      setTarget(null);
      loadHistory();
      void loadFolders();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function undo(b: Batch) {
    if (!(await askConfirm(`Put ${b.files - b.undone} file(s) back to their old names?`, { okLabel: "Undo" }))) return;
    setBusy("Undoing…");
    try {
      const rep = await api.undo(b.batch);
      setMessage({
        text: `Restored ${rep.restored} file(s).` + (rep.skipped.length ? ` Skipped: ${rep.skipped.slice(0, 3).join("; ")}` : ""),
        error: rep.skipped.length > 0,
      });
      setPlan(null);
      loadHistory();
      void loadFolders();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  const visibleFolders = useMemo(
    () => folders.filter((f) => f.name.toLowerCase().includes(filter.toLowerCase())),
    [folders, filter],
  );

  const rows = useMemo(
    () => (plan ? plan.ops.filter((o) => showAll || o.status !== "unchanged") : []),
    [plan, showAll],
  );

  // "As Infuse will show it": show -> season -> episodes, built from the NEW names.
  const tree = useMemo(() => {
    if (!plan) return [];
    const shows = new Map<string, Map<string, PlanOp[]>>();
    for (const o of plan.ops) {
      if (o.kind !== "video" || o.status === "unparsed") continue;
      const parts = o.to.split("/");
      const showName = mode === "tv" ? parts[0] : "Movies";
      const season = mode === "tv" ? (o.season === 0 ? "Specials" : `Season ${o.season}`) : "";
      if (!shows.has(showName)) shows.set(showName, new Map());
      const seasons = shows.get(showName)!;
      if (!seasons.has(season)) seasons.set(season, []);
      seasons.get(season)!.push(o);
    }
    return [...shows.entries()].map(([name, seasons]) => ({
      name,
      seasons: [...seasons.entries()]
        .sort((a, b) => (a[1][0]?.season ?? 0) - (b[1][0]?.season ?? 0))
        .map(([label, eps]) => ({
          label,
          eps: [...eps].sort((a, b) => (a.episodes[0] ?? 0) - (b.episodes[0] ?? 0)),
        })),
    }));
  }, [plan, mode]);

  const crumbs = base ? base.split("/") : [];

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />Media Hub</div>
        <Nav current="renamer" onNav={onNav} />
        <div className="spacer" />
        <span className="muted small path" title={root ?? ""}>{root ?? "No library folder chosen"}</span>
        <button onClick={() => void chooseRoot()}>{root ? "Change folder" : "Choose library folder"}</button>
      </header>

      {!root ? (
        <div className="center">
          <div className="card connect">
            <h1>Choose your library folder</h1>
            <p className="muted">
              Pick the NAS share as it appears on this computer (for example /Volumes/media on a Mac,
              or a mapped drive like M:\ on Windows). The renamer only works inside this folder.
            </p>
            <button className="primary" onClick={() => void chooseRoot()}>Choose folder</button>
          </div>
        </div>
      ) : (
        <div className="split">
          <aside className="card side">
            <div className="seg">
              <button className={mode === "tv" ? "on" : ""} onClick={() => switchMode("tv")}>Shows</button>
              <button className={mode === "movie" ? "on" : ""} onClick={() => switchMode("movie")}>Movies</button>
            </div>
            <div className="crumbs">
              <button className="link" onClick={() => { setBase(""); setTarget(null); }}>Library</button>
              {crumbs.map((c, i) => (
                <span key={i}>
                  {" / "}
                  <button className="link" onClick={() => { setBase(crumbs.slice(0, i + 1).join("/")); setTarget(null); }}>{c}</button>
                </span>
              ))}
            </div>
            <p className="muted small">
              {mode === "tv"
                ? "Open the folder that holds your shows, then click a show."
                : "Open the folder that holds your movies, then click Use this folder."}
            </p>
            {mode === "movie" && (
              <button className={target === base ? "primary" : ""} onClick={() => setTarget(base)}>Use this folder</button>
            )}
            <input type="search" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <ul className="folders">
              {visibleFolders.map((f) => {
                const rel = join(base, f.name);
                return (
                  <li key={f.name} className={target === rel ? "on" : ""}>
                    <button className="pick" onClick={() => setTarget(rel)} title="Select">
                      {f.name}
                    </button>
                    <button className="open" onClick={() => { setBase(rel); setTarget(null); setFilter(""); }} title="Open folder">›</button>
                  </li>
                );
              })}
              {visibleFolders.length === 0 && <li className="muted small">No folders here.</li>}
            </ul>
          </aside>

          <main className="work">
            {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

            {target === null ? (
              <p className="muted">Select a {mode === "tv" ? "show" : "folder"} on the left to see what would change.</p>
            ) : (
              <>
                <section className="card form">
                  <h2>{target || "Library folder"}</h2>
                  <div className="row">
                    {mode === "tv" && (
                      <>
                        <label>Show name<input value={show} onChange={(e) => setShow(e.target.value)} placeholder="From the folder name" /></label>
                        <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Auto" /></label>
                        <label>Episode titles from Jellyfin
                          <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)}>
                            <option value="">Don't use (keep titles from file names)</option>
                            {series.map((s) => <option key={s.id} value={s.id}>{s.name}{s.year ? ` (${s.year})` : ""}</option>)}
                          </select>
                        </label>
                      </>
                    )}
                    {mode === "movie" && (
                      <label className="check"><input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />Include sub-folders</label>
                    )}
                  </div>

                  <label>Name pattern
                    <select value={PRESETS[mode].some((p) => p.value === template) ? template : ""} onChange={(e) => e.target.value && setTemplate(e.target.value)}>
                      {PRESETS[mode].map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                      <option value="">Custom</option>
                    </select>
                  </label>
                  <input className="mono" value={template} onChange={(e) => setTemplate(e.target.value)} spellCheck={false} />
                  <p className="muted small">
                    Items: <span className="mono">{TOKENS[mode]}</span>. Put optional parts in &lt; &gt;, e.g. <span className="mono">&lt; - {"{title}"}&gt;</span>.
                  </p>

                  <div className="rules">
                    <div className="muted small">Find and replace (file names only)</div>
                    {rules.map((r, i) => (
                      <div className="rule" key={i}>
                        <input placeholder="Find" value={r.find} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, find: e.target.value } : x)))} />
                        <input placeholder="Replace with" value={r.replace} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, replace: e.target.value } : x)))} />
                        <label className="check small"><input type="checkbox" checked={r.regex} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, regex: e.target.checked } : x)))} />Pattern</label>
                        <button onClick={() => setRules(rules.filter((_, j) => j !== i))} aria-label="Remove rule">×</button>
                      </div>
                    ))}
                    <button className="link" onClick={() => setRules([...rules, { find: "", replace: "", regex: false }])}>+ Add rule</button>
                  </div>

                  <div className="row end">
                    <button className="primary" onClick={() => void preview()} disabled={!!busy}>{busy ?? "Preview"}</button>
                  </div>
                </section>

                {plan && (
                  <section className="card results">
                    <div className="toolbar">
                      <div className="chips">
                        <span className="chip static ok">{plan.ok} to rename</span>
                        <span className="chip static">{plan.unchanged} already right</span>
                        {plan.conflict > 0 && <span className="chip static bad">{plan.conflict} blocked</span>}
                        {plan.unparsed > 0 && <span className="chip static warn">{plan.unparsed} not understood</span>}
                        {mode === "tv" && <span className="chip static">{plan.titlesFound} titles from Jellyfin</span>}
                      </div>
                      <div className="seg">
                        <button className={view === "files" ? "on" : ""} onClick={() => setView("files")}>Files</button>
                        <button className={view === "infuse" ? "on" : ""} onClick={() => setView("infuse")}>As Infuse shows it</button>
                      </div>
                    </div>

                    {view === "files" ? (
                      <>
                        <label className="check small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />Show files that are already right</label>
                        <div className="table">
                          {rows.map((o) => (
                            <div className={`op ${o.status}`} key={o.from}>
                              <span className={`dot ${o.status}`} title={STATUS_LABEL[o.status]} />
                              <div className="names">
                                <div className="from mono">{o.from}</div>
                                {o.from !== o.to && <div className="to mono">→ {o.to}</div>}
                                {o.note && <div className="small muted">{o.note}</div>}
                              </div>
                              {o.kind === "sidecar" && <span className="chip static">subtitle</span>}
                            </div>
                          ))}
                          {rows.length === 0 && <p className="muted">Nothing to change.</p>}
                        </div>
                      </>
                    ) : (
                      <div className="tree">
                        {tree.map((s) => (
                          <div key={s.name}>
                            <h3>{s.name}</h3>
                            {s.seasons.map((se) => (
                              <div key={se.label} className="season">
                                {se.label && <div className="muted small">{se.label}</div>}
                                {se.eps.map((o) => (
                                  <div className="ep" key={o.from}>
                                    <span className="mono">{mode === "tv" ? `E${String(o.episodes[0]).padStart(2, "0")}` : ""}</span>
                                    <span>{o.to.split("/").pop()}</span>
                                    <span className={o.verified ? "okmark" : "warnmark"} title={o.verified ? "Reads back correctly" : "Check this name"}>{o.verified ? "✓" : "!"}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                        ))}
                        <p className="muted small">Built from the new names, the way Jellyfin reads them. Infuse shows what Jellyfin shows.</p>
                      </div>
                    )}

                    <div className="applybar">
                      <label className="check small"><input type="checkbox" checked={removeEmpty} onChange={(e) => setRemoveEmpty(e.target.checked)} />Remove folders left empty</label>
                      <div className="spacer" />
                      <button className="primary" disabled={plan.ok === 0 || !!busy} onClick={() => void apply()}>
                        {plan.ok === 0 ? "Nothing to rename" : `Rename ${plan.ok} file${plan.ok === 1 ? "" : "s"}`}
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}

            {history.length > 0 && (
              <section className="card history">
                <h2>History</h2>
                {history.map((b) => (
                  <div className="batch" key={b.batch}>
                    <div>
                      <div>{b.files} file{b.files === 1 ? "" : "s"} · {when(b.at)}</div>
                      <div className="muted small mono">{b.example}</div>
                    </div>
                    <div className="spacer" />
                    {b.undone >= b.files ? (
                      <span className="muted small">Undone</span>
                    ) : (
                      <button disabled={!!busy} onClick={() => void undo(b)}>Undo</button>
                    )}
                  </div>
                ))}
              </section>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
