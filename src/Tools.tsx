import { useEffect, useMemo, useRef, useState } from "react";
import { api, AutoResult, codesFor, cultures, Culture, errorText, imageUrl, Item, JfChild, languageName, Status } from "./api";
import type { Route } from "./App";
import { track, useEpoch } from "./activity";
import { prefs, setPrefs, subSkipped, usePrefs } from "./prefs";
import { itemMenu, openMenu, SettingsLink } from "./ui";

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
  const load = () =>
    api.missingSubtitles(0, 300).then((r) => {
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

  async function fill() {
    setRunning(true);
    stop.current = false;
    await track(`Subtitles for ${items.length} videos`, async (job) => {
    for (const [i, e] of items.entries()) {
      if (stop.current || job.cancelled) break;
      job.update(label(e), i / items.length);
      if (results[e.Id]) continue;
      setResults((r) => ({ ...r, [e.Id]: "working…" }));
      try {
        const res = await api.subtitleAuto(e.Id, lang, codes, minScore);
        setResults((r) => ({ ...r, [e.Id]: OUTCOME[res.outcome] + (res.score != null ? ` (${res.score})` : "") }));
      } catch (err) {
        const t = errorText(err);
        setResults((r) => ({ ...r, [e.Id]: t }));
        if (/rate|limit|quota|switched off|plugin/i.test(t)) break;
      }
    }
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
            <button className="primary" disabled={!items.length || status.readOnly} onClick={() => void fill()}>Get the best match for all</button>
          )}
        </div>
      </div>
      <p className="muted">{total} videos have no subtitles at all{total > items.length ? ` (showing the first ${items.length})` : ""}. Only matches scoring at least {minScore} are downloaded; 100 means made for exactly that file. Subtitle sites limit downloads per day.{skipped > 0 ? ` ${skipped} in folders you switched off are left out.` : ""} <SettingsLink section="subtitles">Subtitle settings (languages, folders, score)</SettingsLink></p>
      {status.readOnly && <p className="note">Downloading needs changes to Jellyfin switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      {error && <p className="error">{error}</p>}
      <div className="card list-card">
        {items.map((e) => (
          <button className="tool-row" key={e.Id} onClick={() => onOpen(e.Id)}>
            <div className="names">
              <div className="title">{label(e)}</div>
              <div className="muted small">{results[e.Id] ?? "No subtitles"}</div>
            </div>
            <span className="muted">›</span>
          </button>
        ))}
        {items.length === 0 && !error && <p className="muted small">Every video has subtitles.</p>}
      </div>
    </div>
  );
}
