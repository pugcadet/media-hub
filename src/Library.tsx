import { useCallback, useEffect, useRef, useState } from "react";
import { api, Attention, errorText, imageUrl, Item, Kind, Library as Lib, localDate, Pick, Sort, Status } from "./api";
import Poster from "./Poster";
import type { Route } from "./App";

const PAGE = 120;

function ago(ts: number | null): string {
  if (!ts) return "never";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 60 / 24)} d ago`;
}

const FLAG_TITLE: Record<string, string> = { unmatched: "Unmatched titles", noposter: "Titles without a poster", unwatched: "Not watched yet" };

interface Props {
  status: Status;
  libraries: Lib[];
  attention: Attention | null;
  route: Route;
  onRoute: (r: Route) => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
}

function PickCard({ p, onOpen }: { p: Pick; onOpen: (id: string) => void }) {
  return (
    <button className="pick-card" onClick={() => onOpen(p.id)}>
      <img src={imageUrl(p.artId, "Backdrop", 640)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      <div className="pick-shade" />
      <div className="pick-text">
        <div className="pick-why">{p.why}</div>
        <div className="pick-title">{p.title}</div>
        <div className="pick-meta">{p.meta}</div>
      </div>
    </button>
  );
}

export default function Library({ status, libraries, attention, route, onRoute, onChanged, onOpen }: Props) {
  const lib = libraries.find((l) => l.id === route.library) ?? null;
  const [kind, setKind] = useState<Kind>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const flag = route.flag ?? null;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const loadPage = useCallback(
    async (offset: number) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const rows = await api.list(kind, debounced, sort, offset, PAGE, route.library ?? null, flag);
        setItems((prev) => (offset === 0 ? rows : [...prev, ...rows]));
        setMore(rows.length === PAGE);
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        loading.current = false;
      }
    },
    [kind, debounced, sort, route.library, flag],
  );

  const total = status.movies + status.series;
  useEffect(() => {
    loading.current = false;
    void loadPage(0);
  }, [loadPage, total, status.lastSync]);

  useEffect(() => {
    api.picks(localDate()).then(setPicks).catch(() => setPicks([]));
  }, [status.lastSync]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadPage(items.length);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, items.length, loadPage]);

  const autoSynced = useRef(false);
  const sync = useCallback(async () => {
    setSyncing(true);
    setMessage(null);
    try {
      await api.sync();
      onChanged();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setSyncing(false);
    }
  }, [onChanged]);

  useEffect(() => {
    // First run, or the library list predates library support: fetch everything once.
    if (!autoSynced.current && (status.lastSync === null || (libraries.length === 0 && total > 0))) {
      autoSynced.current = true;
      void sync();
    }
  }, [status.lastSync, libraries.length, total, sync]);

  const title = flag ? FLAG_TITLE[flag] ?? "Library" : lib?.name ?? "Library";
  const mixed = !lib || lib.kind === "mixed";
  const showPicks = !flag && !debounced && picks.length > 0 && (!route.library || route.library === libraries[0]?.id);

  return (
    <div className="pg">
      <div className="pg-head">
        <h1>{title}</h1>
        <div className="pg-actions">
          <label className="searchbox">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input aria-label="Search library" placeholder="Search titles, files, IDs" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <button className="primary" onClick={() => void sync()} disabled={syncing}>{syncing ? "Scanning…" : "Scan library"}</button>
        </div>
      </div>
      <div className="muted small sync-line">{status.serverName} · {syncing ? "updating…" : `updated ${ago(status.lastSync)}`}</div>

      {message && <p className="error" role="alert">{message}</p>}

      {showPicks && (
        <section className="section">
          <div className="section-head"><h2>Picks of the day</h2><span className="muted small">Refreshes at midnight</span></div>
          <div className="picks-row">{picks.map((p) => <PickCard key={p.id} p={p} onOpen={onOpen} />)}</div>
        </section>
      )}

      {!flag && attention && (attention.unmatched > 0 || attention.noPoster > 0 || (attention.noSubtitles ?? 0) > 0) && (
        <section className="attention">
          <span className="muted small">Needs attention</span>
          {attention.unmatched > 0 && (
            <button className="att amber" onClick={() => onRoute({ view: "library", flag: "unmatched" })}>{attention.unmatched} unmatched titles</button>
          )}
          {attention.noPoster > 0 && (
            <button className="att" onClick={() => onRoute({ view: "library", flag: "noposter" })}>{attention.noPoster} without a poster</button>
          )}
          {(attention.noSubtitles ?? 0) > 0 && (
            <button className="att" onClick={() => onRoute({ view: "subtitles" })}>{attention.noSubtitles} videos without subtitles</button>
          )}
          <button className="att" onClick={() => onRoute({ view: "intros" })}>Check intros and credits</button>
        </section>
      )}
      {flag && (
        <p className="muted small">
          <button className="link" onClick={() => onRoute({ view: "library" })}>← Back to the whole library</button>
        </p>
      )}

      <div className="toolbar">
        <div className="chips">
          {mixed && (
            <>
              <button className={`chip ${kind === null ? "on" : ""}`} onClick={() => setKind(null)}>All</button>
              <button className={`chip ${kind === "series" ? "on" : ""}`} onClick={() => setKind("series")}>Shows</button>
              <button className={`chip ${kind === "movie" ? "on" : ""}`} onClick={() => setKind("movie")}>Movies</button>
            </>
          )}
        </div>
        <label className="sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="name">Name</option>
            <option value="added">Recently added</option>
            <option value="rating">Rating</option>
            <option value="year">Year</option>
          </select>
        </label>
      </div>

      {items.length === 0 && !syncing && <p className="muted">{total === 0 ? "Nothing here yet. Press Scan library." : "Nothing matches."}</p>}
      <div className="grid">
        {items.map((i) => <Poster key={i.id} item={i} onOpen={(x) => onOpen(x.id)} />)}
      </div>
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}
