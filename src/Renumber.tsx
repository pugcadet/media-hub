// "It's there under another number": pick the episode that is really the missing one (often a
// special, S00), and Media Hub renames its file to the right season and episode.
import { useEffect, useState } from "react";
import { api, errorText, JfChild } from "./api";
import { track } from "./activity";
import { makeStore } from "./ui";

interface Ask {
  seriesId: string;
  season: number;
  episode: number;
  title: string;
  resolve: (done: boolean) => void;
}
const store = makeStore<Ask | null>(null);

/** Resolves true when an episode was renamed. */
export function askRenumber(seriesId: string, season: number, episode: number, title: string): Promise<boolean> {
  return new Promise((resolve) => store.set({ seriesId, season, episode, title, resolve }));
}

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
const alike = (a: string, b: string) => {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  x.forEach((w) => y.has(w) && n++);
  return n / Math.max(x.size, y.size);
};

export function RenumberHost() {
  const ask = store.use();
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!ask) return;
    setEps(null);
    setError(null);
    (async () => {
      const d = await api.details(ask.seriesId);
      const lists = await Promise.all(d.seasons.map((s) => api.children(s.Id).catch(() => [] as JfChild[])));
      const all = lists.flat().filter((e) => e.Type === "Episode" && !(e.ParentIndexNumber === ask.season && e.IndexNumber === ask.episode));
      // Most likely first: same title, then specials, then the rest.
      all.sort((a, b) => alike(b.Name, ask.title) - alike(a.Name, ask.title) || (a.ParentIndexNumber === 0 ? -1 : 0) - (b.ParentIndexNumber === 0 ? -1 : 0));
      setEps(all);
    })().catch((e) => setError(errorText(e)));
  }, [ask]);
  if (!ask) return null;
  const close = (done: boolean) => {
    ask.resolve(done);
    store.set(null);
  };
  const code = (s?: number | null, e?: number | null) => `S${String(s ?? 0).padStart(2, "0")}E${String(e ?? 0).padStart(2, "0")}`;
  async function pick(e: JfChild) {
    try {
      await track(`Renaming to ${code(ask!.season, ask!.episode)}`, () => api.episodeRenumber(e.Id, ask!.season, ask!.episode).then((r) => {
        if (r.failed.length) throw r.failed[0];
      }));
      close(true);
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <div className="overlay confirm-layer" onClick={() => close(false)}>
      <div className="card confirm renumber" onClick={(e) => e.stopPropagation()}>
        <h2>Which file is {code(ask.season, ask.episode)} “{ask.title}”?</h2>
        <p className="muted small">Pick the episode that is really this one. Its file (and subtitles) get the right number{ask.season > 0 ? " and move to that season's folder" : ""}. Jellyfin scans it right after; History can undo it.</p>
        {error && <p className="error">{error}</p>}
        <div className="renumber-list">
          {!eps && !error && <div className="pg-loading"><span className="spinner" /> Loading the episodes…</div>}
          {eps?.map((e) => (
            <button key={e.Id} className={`tool-row ${alike(e.Name, ask.title) > 0.5 ? "likely" : ""}`} onClick={() => void pick(e)}>
              <span className="mono small">{code(e.ParentIndexNumber, e.IndexNumber)}</span>
              <span className="grow ellipsis">{e.Name}</span>
              {alike(e.Name, ask.title) > 0.5 && <span className="pill ok small">Same title</span>}
              {e.ParentIndexNumber === 0 && <span className="muted small">Special</span>}
            </button>
          ))}
        </div>
        <div className="row end"><button onClick={() => close(false)}>Cancel</button></div>
      </div>
    </div>
  );
}
