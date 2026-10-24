import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, Item, Kind, localDate, Sort, Status } from "./api";
import Detail from "./Detail";
import Poster from "./Poster";
import Nav from "./Nav";
import type { View } from "./App";

const PAGE = 120;

function ago(ts: number | null): string {
  if (!ts) return "never";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 60 / 24)} d ago`;
}

export default function Library({ status, onChanged, onNav }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
  const [kind, setKind] = useState<Kind>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [picks, setPicks] = useState<Item[]>([]);
  const [open, setOpen] = useState<Item | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const loading = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(t);
  }, [query]);

  const loadPage = useCallback(
    async (offset: number) => {
      if (loading.current) return;
      loading.current = true;
      try {
        const rows = await api.list(kind, debounced, sort, offset, PAGE);
        setItems((prev) => (offset === 0 ? rows : [...prev, ...rows]));
        setMore(rows.length === PAGE);
      } catch (e) {
        setMessage(errorText(e));
      } finally {
        loading.current = false;
      }
    },
    [kind, debounced, sort],
  );

  const total = status.movies + status.series;
  const lastSync = status.lastSync;

  // Reload from the top when a filter changes or after a sync.
  useEffect(() => {
    loading.current = false;
    void loadPage(0);
  }, [loadPage, total, lastSync]);

  useEffect(() => {
    api.picks(localDate()).then(setPicks).catch(() => setPicks([]));
  }, [total, lastSync]);

  // Infinite scroll
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadPage(items.length);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, items.length, loadPage]);

  // First run: pull the library automatically.
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
    if (!autoSynced.current && status.lastSync === null) {
      autoSynced.current = true;
      void sync();
    }
  }, [status.lastSync, sync]);

  async function disconnect() {
    if (!window.confirm("Disconnect from this server? The saved key and the local list are removed from this computer. Your server is not touched.")) return;
    try {
      await api.disconnect();
      onChanged();
    } catch (e) {
      setMessage(errorText(e));
    }
  }

  const chip = (label: string, value: Kind) => (
    <button className={`chip ${kind === value ? "on" : ""}`} onClick={() => setKind(value)}>{label}</button>
  );

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />Media Hub</div>
        <Nav current="library" onNav={onNav} />
        <input
          className="search"
          type="search"
          placeholder="Search your library"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="spacer" />
        <span className="muted small">
          {status.serverName} · {syncing ? "syncing…" : `updated ${ago(status.lastSync)}`}
        </span>
        <button onClick={() => void sync()} disabled={syncing}>{syncing ? "Syncing…" : "Sync"}</button>
        <button onClick={() => void disconnect()}>Disconnect</button>
      </header>

      <main>
        {message && <p className="error" role="alert">{message}</p>}

        {picks.length > 0 && !debounced && kind === null && (
          <section>
            <h2>Picks of the day</h2>
            <div className="picks">
              {picks.map((p) => <Poster key={p.id} item={p} onOpen={setOpen} width={360} />)}
            </div>
          </section>
        )}

        <section>
          <div className="toolbar">
            <div className="chips">
              {chip(`All ${total}`, null)}
              {chip(`Movies ${status.movies}`, "movie")}
              {chip(`Shows ${status.series}`, "series")}
            </div>
            <label className="sort">
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                <option value="name">Name</option>
                <option value="rating">Rating</option>
                <option value="year">Year</option>
                <option value="added">Recently added</option>
              </select>
            </label>
          </div>

          {items.length === 0 && !syncing && (
            <p className="muted">{total === 0 ? "Nothing here yet. Press Sync." : "No matches."}</p>
          )}
          <div className="grid">
            {items.map((i) => <Poster key={i.id} item={i} onOpen={setOpen} />)}
          </div>
          <div ref={sentinel} style={{ height: 1 }} />
        </section>
      </main>

      <footer className="muted small">
        Read-only mode{status.readOnly ? " is on" : " is off"} · Pictures and details come from your Jellyfin server.
      </footer>

      {open && <Detail item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
