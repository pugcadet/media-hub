import { useCallback, useEffect, useRef, useState } from "react";
import { api, Attention, errorText, Item, Kind, Library as Lib, Sort, Status } from "./api";
import Wall, { type Problem } from "./Wall";
import type { Route } from "./App";
import { useEpoch } from "./activity";
import { scanLibrary } from "./ui";

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

export default function Library({ status, libraries, route, onChanged }: Props) {
  const lib = libraries.find((l) => l.id === route.library) ?? null;
  const [kind, setKind] = useState<Kind>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const flag = route.flag ?? null;
  const epoch = useEpoch();
  // The old "unmatched" / "no poster" links open the wall with that problem picked.
  const [problem, setProblem] = useState<Problem>(flag === "unmatched" ? "id" : flag === "noposter" ? "art" : "");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const loadPage = useCallback(
    async (offset: number) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const rows = await api.list(kind, debounced, sort, offset, PAGE, route.library ?? null, flag === "unwatched" ? flag : null);
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
  }, [loadPage, total, status.lastSync, epoch]);

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
      await scanLibrary();
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
      <Wall items={items} status={status} problem={problem} onProblem={setProblem} query={debounced} kind={kind} />
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}
