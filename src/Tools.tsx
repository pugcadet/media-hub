import { useEffect, useMemo, useRef, useState } from "react";
import { api, AutoResult, codesFor, cultures, Culture, errorText, ExtraSub, imageUrl, Item, JfChild, languageName, Status } from "./api";
import type { Route } from "./App";
import { followEvent, track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { prefs, setPrefs, subSkipped, usePrefs } from "./prefs";
import { BulkSelect, Icon, itemMenu, openMenu, SettingsLink, Tabs, TriCheck, useUndoableSet } from "./ui";
import { foldersOf, tabFolder, useFolderMap } from "./folders";
import { agoText, usePageState, useSaved } from "./saved";

/** Metadata and art: titles that need a match or a poster. */
export function MetadataTool({ onOpen, onRoute }: { onOpen: (id: string) => void; onRoute: (r: Route) => void }) {
  const [unmatched, setUnmatched] = useState<Item[]>([]);
  const [noPoster, setNoPoster] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const epoch = useEpoch();
  useEffect(() => {
    // Reloads after every change (e.g. identifying a title takes it off the list).
    api.list(null, "", "name", 0, 200, null, "unmatched").then(setUnmatched).catch((e) => setError(errorText(e)));
    api.list(null, "", "name", 0, 200, null, "noposter").then(setNoPoster).catch((e) => setError(errorText(e)));
  }, [epoch]);
  const fillAll = (items: Item[]) => void track(`Artwork for ${items.length} titles`, async (job) => {
    let added = 0;
    for (const [i, it] of items.entries()) {
      if (job.cancelled) break;
      job.update(it.name, i / items.length);
      added += (await api.fillMissingArt(it.id, ["Primary", "Backdrop", "Logo", "Thumb", "Banner"]).catch(() => [])).length;
    }
    job.update(`${added} pictures added`, 1);
  }, { cancellable: true });
  const row = (i: Item, why: string) => (
    <button className="tool-row" key={`${why}-${i.id}`} onClick={() => onOpen(i.id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: i.id, kind: i.kind, title: i.name, played: i.played }))}>
      <div className="thumb">{i.hasPoster ? <img src={imageUrl(i.id, "Primary", 120)} alt="" loading="lazy" /> : null}</div>
      <div className="names">
        <div className="title">{i.name}{i.year ? ` (${i.year})` : ""}</div>
        <div className="muted small">{i.kind === "series" ? "Show" : "Movie"} · {why}</div>
      </div>
      <span className="muted">›</span>
    </button>
  );
  return (
    <div className="pg">
      <div className="pg-head"><h1>Metadata and art</h1></div>
      <p className="muted">Open any title from the library to edit its details and artwork. These need a look first:</p>
      {error && <p className="error">{error}</p>}
      <section className="card list-card">
        <div className="section-head"><h2>Not matched to TMDB, TVDB or IMDb ({unmatched.length})</h2>
          {unmatched.length > 0 && <button className="link" onClick={() => onRoute({ view: "library", flag: "unmatched" })}>Show as posters</button>}</div>
        {unmatched.length === 0 ? <p className="muted small">Everything is matched.</p> : unmatched.map((i) => row(i, "no match yet: open it and use Identify"))}
      </section>
      <section className="card list-card">
        <div className="section-head"><h2>Without a poster ({noPoster.length})</h2>
          {noPoster.length > 0 && <button className="link" onClick={() => fillAll(noPoster)}>Fill in all missing artwork</button>}</div>
        {noPoster.length === 0 ? <p className="muted small">Every title has a poster.</p> : noPoster.map((i) => row(i, "pick or upload a poster"))}
      </section>
    </div>
  );
}

interface ShowGroup { key: string; name: string; movie: boolean; items: JfChild[] }

/** Videos as shows (episodes by their show, movies together). */
function showsOf(list: JfChild[]): ShowGroup[] {
  const m = new Map<string, ShowGroup>();
  for (const e of list) {
    const movie = e.Type !== "Episode";
    const key = movie ? "__movies" : e.SeriesId ?? e.SeriesName ?? "?";
    const g = m.get(key) ?? { key, name: movie ? "Movies" : e.SeriesName ?? "Show", movie, items: [] };
    g.items.push(e);
    m.set(key, g);
  }
  return [...m.values()];
}

function seasonsOf(list: JfChild[]): { key: string; name: string; items: JfChild[] }[] {
  const m = new Map<number, JfChild[]>();
  for (const e of list) m.set(e.ParentIndexNumber ?? 0, [...(m.get(e.ParentIndexNumber ?? 0) ?? []), e]);
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([n, items]) => ({ key: String(n), name: n === 0 ? "Specials" : `Season ${n}`, items }));
}

const OUTCOME: Record<AutoResult["outcome"], string> = { has: "already has it", downloaded: "downloaded", low: "best match too weak", none: "nothing found" };

/** Subtitles: every movie and episode without subtitles, with a bulk "get the best match". */
export function SubtitlesTool({ status, onOpen }: { status: Status; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<JfChild[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<Culture[]>([]);
  const [lang, setLang] = useState(status.subLangs[0] ?? "eng");
  const [minScore, setMinScoreState] = useState(prefs().minSubScore);
  const setMinScore = (n: number) => { setMinScoreState(n); setPrefs({ minSubScore: n }); };
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const [results, setResults] = useState<Record<string, string>>({});

  const { subSkipFolders } = usePrefs();
  const [skipped, setSkipped] = useState(0);
  const [query, setQuery] = usePageState("subs.query", "");
  const [sort, setSort] = usePageState<"folder" | "name">("subs.sort", "folder");
  const [tab, setTab] = usePageState("subs.tab", "all");
  // Shows and seasons start folded; the ones you open stay open.
  const [openKeys, setOpenKeys] = usePageState<string[]>("subs.open", []);
  const isOpenKey = (k: string) => openKeys.includes(k);
  const toggleKey = (k: string) => setOpenKeys((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k]));
  const [stopReason, setStopReason] = useState<string | null>(null);
  const folderMap = useFolderMap();
  const folderOf = (e: JfChild) => folderMap.get(e.SeriesId ?? e.Id) ?? "Other";
  const load = () =>
    api.missingSubtitles(0, 3000).then((r) => {
      const all = r.Items ?? [];
      const keep = all.filter((e) => !subSkipped(e.Path));
      setItems(keep);
      setSkipped(all.length - keep.length);
      setTotal(r.TotalRecordCount ?? 0);
    }).catch((e) => setError(errorText(e)));
  useEffect(() => {
    void load();
    cultures().then(setList).catch(() => setList([]));
  }, [subSkipFolders.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const codes = useMemo(() => codesFor(lang, list), [lang, list]);
  const inFolder = tabFolder(tab);
  const shownItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const l = items.filter((e) => (!inFolder || folderOf(e) === inFolder) && (!q || `${e.SeriesName ?? ""} ${e.Name}`.toLowerCase().includes(q)));
    const key = (e: JfChild) => `${e.SeriesName ?? e.Name} ${String(e.ParentIndexNumber ?? 0).padStart(3, "0")} ${String(e.IndexNumber ?? 0).padStart(4, "0")}`;
    return l.sort((a, b) => (sort === "folder" ? folderOf(a).localeCompare(folderOf(b)) : 0) || key(a).localeCompare(key(b)));
  }, [items, query, sort, inFolder, folderMap]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => {
    const g = new Map<string, JfChild[]>();
    for (const e of shownItems) { const k = sort === "folder" ? folderOf(e) : ""; g.set(k, [...(g.get(k) ?? []), e]); }
    return [...g.entries()];
  }, [shownItems, sort]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fill(items: JfChild[] = shownItems, what = `${items.length} videos`) {
    setRunning(true);
    setStopReason(null);
    stop.current = false;
    let downloaded = 0;
    await track(`Subtitles for ${what}`, async (job) => {
    for (const [i, e] of items.entries()) {
      if (stop.current || job.cancelled) break;
      job.update(label(e), i / items.length);
      if (results[e.Id]) continue;
      setResults((r) => ({ ...r, [e.Id]: "working…" }));
      try {
        const res = await api.subtitleAuto(e.Id, lang, codes, minScore);
        if (res.outcome === "downloaded") downloaded++;
        setResults((r) => ({ ...r, [e.Id]: OUTCOME[res.outcome] + (res.score != null ? ` (${res.score})` : "") }));
      } catch (err) {
        const t = errorText(err);
        setResults((r) => ({ ...r, [e.Id]: t }));
        // A limit or a missing plugin won't fix itself on the next video: stop and say why.
        if (/rate|limit|quota|switched off|plugin|stopped|login/i.test(t)) {
          setStopReason(t);
          throw t;
        }
      }
    }
    job.update(`${downloaded} downloaded`, 1);
    }, { cancellable: true, reload: false }).catch(() => undefined);
    setRunning(false);
    void load();
  }

  const label = (e: JfChild) =>
    e.Type === "Episode"
      ? `${e.SeriesName ?? ""} · S${String(e.ParentIndexNumber ?? 0).padStart(2, "0")}E${String(e.IndexNumber ?? 0).padStart(2, "0")} · ${e.Name}`
      : e.Name;

  return (
    <div className="pg">
      <div className="pg-head">
        <h1>Subtitles</h1>
        <div className="pg-actions">
          <label className="sort">Language
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              {status.subLangs.map((l) => <option key={l} value={l}>{languageName(l, list)}</option>)}
            </select>
          </label>
          <label className="sort">Minimum score
            <input type="number" className="num" min={1} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(1, Math.min(100, Number(e.target.value) || 100)))} />
          </label>
          {running ? <button onClick={() => (stop.current = true)}>Stop</button> : (
            <button className="primary" disabled={!shownItems.length || status.readOnly} onClick={() => void fill()}>Get the best match for {shownItems.length === items.length ? "all" : `these ${shownItems.length}`}</button>
          )}
        </div>
      </div>
      <p className="muted">{total} videos have no subtitles at all{total > items.length ? ` (showing the first ${items.length})` : ""}. Only matches scoring at least {minScore} are downloaded; 100 means made for exactly that file. Subtitle sites limit downloads per day.{skipped > 0 ? ` ${skipped} in folders you switched off are left out.` : ""} <SettingsLink section="subtitles">Subtitle settings (languages, folders, score)</SettingsLink></p>
      {status.readOnly && <p className="note">Downloading needs changes to Jellyfin switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      {error && <p className="error">{error}</p>}
      <Tabs screen="subtitles" fixed={["all"]} active={tab} onChange={setTab} tabs={[{ id: "all", label: "Everything", count: items.length }]}
        folders={foldersOf(folderMap).map((f) => ({ name: f, count: items.filter((e) => folderOf(e) === f).length || undefined }))} />
      <div className="toolbar">
        <label className="searchbox wide"><Icon name="search" /><input placeholder="Search shows, movies and episodes" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        <span className="spacer" />
        <label className="sort">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as "folder" | "name")}>
            <option value="folder">By folder</option>
            <option value="name">By name</option>
          </select>
        </label>
        <span className="muted small">{shownItems.length} videos</span>
      </div>
      {stopReason && <p className="error">{stopReason}</p>}
      <div className="card list-card sub-tree">
        {groups.map(([g, list]) => (
          <div key={g || "all"}>
            {g && <div className="change-group"><Icon name="folder" size={14} /><span className="strong small">{g}</span><span className="muted small">{list.length} videos</span></div>}
            {showsOf(list).map((sh) => {
              const k = `show:${sh.key}`;
              const open = isOpenKey(k);
              return (
                <div key={sh.key} className="sub-show">
                  <div className="sub-head">
                    <button className="link-plain sub-toggle" onClick={() => toggleKey(k)} aria-expanded={open}>
                      <span className={`chev ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                      <span className="strong">{sh.name}</span>
                      <span className="muted small">{sh.items.length} {sh.movie ? (sh.items.length === 1 ? "movie" : "movies") : `episode${sh.items.length === 1 ? "" : "s"}`}</span>
                    </button>
                    <span className="muted small sub-done">{sh.items.filter((e) => results[e.Id]).length ? `${sh.items.filter((e) => /downloaded/.test(results[e.Id] ?? "")).length} downloaded` : ""}</span>
                    <button className="small-btn" disabled={running || status.readOnly} onClick={() => void fill(sh.items, sh.name)}>Get subtitles</button>
                  </div>
                  {open && (sh.movie ? [{ key: "m", name: "", items: sh.items }] : seasonsOf(sh.items)).map((se) => {
                    const sk = `${k}|${se.key}`;
                    const sopen = sh.movie || isOpenKey(sk);
                    return (
                      <div key={se.key} className="sub-season">
                        {!sh.movie && (
                          <div className="sub-head sub-head2">
                            <button className="link-plain sub-toggle" onClick={() => toggleKey(sk)} aria-expanded={sopen}>
                              <span className={`chev ${sopen ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                              <span className="small strong">{se.name}</span>
                              <span className="muted small">{se.items.length}</span>
                            </button>
                            <button className="small-btn" disabled={running || status.readOnly} onClick={() => void fill(se.items, `${sh.name} ${se.name}`)}>Get subtitles</button>
                          </div>
                        )}
                        {sopen && se.items.map((e) => (
                          <button className="tool-row sub-ep" key={e.Id} onClick={() => onOpen(e.Id)} onContextMenu={(ev) => openMenu(ev, itemMenu({ id: e.Id, kind: e.Type === "Episode" ? "Episode" : "Movie", title: label(e), played: false }))}>
                            <div className="names">
                              <div className="title small">{e.Type === "Episode" ? `E${String(e.IndexNumber ?? 0).padStart(2, "0")} · ${e.Name}` : e.Name}</div>
                              <div className={`small ${/limit|stopped|couldn't|refused/i.test(results[e.Id] ?? "") ? "bad" : "muted"}`}>{results[e.Id] ?? "No subtitles"}</div>
                            </div>
                            <span className="muted">›</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
        {shownItems.length === 0 && !error && <p className="muted small pad">{items.length ? "Nothing matches." : "Every video has subtitles."}</p>}
      </div>
    </div>
  );
}

/** Extra subtitles: subtitle files in languages you never use, removed in one go (to the trash, undoable). */
export function SubtitleCleanup({ status }: { status: Status }) {
  const p = usePrefs();
  const [list, setList] = useState<Culture[]>([]);
  // The last search is kept (also when nothing was found), with when it ran.
  const [savedRows, saveRows] = useSaved<ExtraSub[]>("extraSubs");
  const rows = savedRows?.data ?? null;
  const setRows = (f: ExtraSub[] | null | ((r: ExtraSub[] | null) => ExtraSub[] | null)) => {
    const next = typeof f === "function" ? f(rows) : f;
    if (next) saveRows(next);
  };
  const [error, setError] = useState<string | null>(null);
  const sel = useUndoableSet<string>();
  const key = (r: ExtraSub) => `${r.id}|${r.path}`;
  useEffect(() => void cultures().then(setList).catch(() => setList([])), []);

  async function scan() {
    setError(null);
    try {
      const r = await track("Looking for subtitles in other languages", async (job) => {
        const un = await followEvent(job, "bulk-progress");
        try { return await api.extraSubtitles(p.keepSubLangs); } finally { un(); }
      }, { reload: false, cancellable: true });
      setRows(r);
      sel.reset(r.map(key));
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function remove() {
    const files = (rows ?? []).filter((r) => sel.has(key(r))).map((r) => ({ id: r.id, path: r.path }));
    if (!files.length) return;
    if (!(await askConfirm(`Move ${files.length} subtitle file${files.length === 1 ? "" : "s"} to the trash folder in your library? Nothing is deleted; History can put them back.`, { okLabel: "Remove" }))) return;
    try {
      await track(`Removing ${files.length} subtitle files`, async (job) => {
        const un = await followEvent(job, "bulk-progress");
        try { job.update(`${await api.removeSubtitleFiles(files)} removed`, 1); } finally { un(); }
      }, { stop: "bulk" });
      setRows((r) => r?.filter((x) => !sel.has(key(x))) ?? null);
      sel.reset();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const toggleKeep = (l: string) => setPrefs({ keepSubLangs: p.keepSubLangs.includes(l) ? p.keepSubLangs.filter((x) => x !== l) : [...p.keepSubLangs, l] });
  const name = (c: string) => languageName(c, list);
  const byLang = new Map<string, ExtraSub[]>();
  for (const r of rows ?? []) byLang.set(r.language || "?", [...(byLang.get(r.language || "?") ?? []), r]);

  return (
    <div className="stack">
      <section className="card form">
        <div className="strong">Languages to keep</div>
        <div className="chips">
          {[...new Set([...p.keepSubLangs, ...status.subLangs, "eng", "dut"])].map((l) => (
            <label key={l} className={`chip ${p.keepSubLangs.includes(l) ? "on" : ""}`}><input type="checkbox" checked={p.keepSubLangs.includes(l)} onChange={() => toggleKeep(l)} /> {name(l)}</label>
          ))}
        </div>
        <p className="muted small">Subtitle files in every other language can go. Subtitles built into the video file stay (they can't be taken out without changing the video), and files without a language tag are left alone.</p>
        <div className="row"><button className="primary" onClick={() => void scan()}>Find subtitles in other languages</button></div>
        {error && <p className="error">{error}</p>}
      </section>
      {rows && (
        <section className="card list-card">
          <div className="section-head pad">
            <h2>{rows.length ? `${rows.length} subtitle files in other languages` : "No subtitle files in other languages"} <span className="muted small">· checked {agoText(savedRows!.at)}</span></h2>
            {rows.length > 0 && (
              <div className="row end">
                <BulkSelect sel={sel} keys={rows.map(key)} noun="files" />
                <button className="danger-outline" disabled={!sel.size || status.readOnly} onClick={() => void remove()}>Remove {sel.size || ""}</button>
              </div>
            )}
          </div>
          {[...byLang.entries()].sort((a, b) => b[1].length - a[1].length).map(([lang, list]) => (
            <div key={lang}>
              <div className="change-group">
                <TriCheck state={sel.state(list.map(key))} onChange={(on) => sel.setMany(list.map(key), on)} />
                <span className="strong small">{name(lang)}</span><span className="muted small">{list.length} files</span>
              </div>
              {list.slice(0, 300).map((r) => (
                <label key={key(r)} className="tool-row">
                  <input type="checkbox" checked={sel.has(key(r))} onChange={() => sel.toggle(key(r))} />
                  <div className="names"><div className="title">{r.name}</div><div className="muted small mono ellipsis">{r.path.split(/[\\/]/).pop()}</div></div>
                </label>
              ))}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
