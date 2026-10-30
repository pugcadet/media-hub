// "Identify" as a popup: search the providers set up in Jellyfin, pick the right match.
// Opened from anywhere with askIdentify(); applying it reloads only that title.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api, cleanTitle, errorText, ImageKind, remoteImageUrl, SearchResult } from "./api";
import { track } from "./activity";
import { Icon } from "./ui";
import { setPrefs, usePrefs } from "./prefs";

interface Req {
  id: string;
  name: string;
  year: number | null;
  kind: "series" | "movie";
  /** Ids it's matched to now (shown, so you can see what changes). */
  current: Record<string, string>;
  resolve: (done: boolean) => void;
}

let current: Req | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

/** Opens the identify popup; resolves true when a match was applied. */
export function askIdentify(id: string, name: string, year: number | null, kind: "series" | "movie", ids: Record<string, string> = {}): Promise<boolean> {
  return new Promise((resolve) => {
    current = { id, name, year, kind, current: ids, resolve };
    notify();
  });
}

function close(done: boolean) {
  const c = current;
  current = null;
  notify();
  c?.resolve(done);
}

const ALL_ART: ImageKind[] = ["Primary", "Backdrop", "Logo", "Thumb", "Banner", "Art", "Disc"];

export function IdentifyHost() {
  const req = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
  return req ? <IdentifyDialog key={req.id} req={req} /> : null;
}

function IdentifyDialog({ req }: { req: Req }) {
  const [name, setName] = useState(cleanTitle(req.name, req.year ?? undefined));
  const [year, setYear] = useState(req.year ? String(req.year) : "");
  const [idType, setIdType] = useState("tmdb");
  const [idValue, setIdValue] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replaceImages, setReplaceImages] = useState(true);
  const [fillArt, setFillArt] = useState(true);
  const { pinIds: pin } = usePrefs();

  const search = useCallback(async () => {
    setSearching(true);
    setError(null);
    try {
      const ids = idValue.trim() ? { [idType]: idValue.trim() } : {};
      setResults(await api.identifySearch(req.kind, name, year ? Number(year) : null, ids));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  }, [idType, idValue, req.kind, name, year]);

  useEffect(() => {
    void search();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function use(r: SearchResult) {
    setBusy(true);
    setError(null);
    try {
      await track(`Identifying ${r.Name}`, async (job) => {
        await api.identifyApply(req.id, r, replaceImages);
        if (fillArt) {
          job.update("Filling in missing artwork", null);
          await api.fillMissingArt(req.id, ALL_ART).catch(() => undefined);
        }
        if (pin) {
          // The match into the folder name, so Jellyfin finds it the same way every time.
          job.update("Putting the match in the folder name", null);
          const p = await api.pinIdentity(req.id).catch((e) => ({ name: "", changed: false, note: errorText(e) }));
          job.update(p.changed ? `Folder now “${p.name}”. Jellyfin picks it up on its scan.` : p.note ? `Folder name left as it is: ${p.note}` : "The folder name already has the match.", 1);
        }
      }, { items: [req.id] });
      close(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const isNow = (r: SearchResult) => Object.entries(r.ProviderIds ?? {}).some(([k, v]) => v && req.current[k] === v);
  const nowIds = Object.entries(req.current).filter(([k, v]) => v && ["Tmdb", "Tvdb", "Imdb"].includes(k));
  return (
    <div className="overlay confirm-layer" onClick={() => !busy && close(false)}>
      <div className="card identify-dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>{nowIds.length ? "Identify again" : "Identify"}: {cleanTitle(req.name, req.year ?? undefined)}</h2>
            <div className="muted small">
              {nowIds.length ? <>Matched now to {nowIds.map(([k, v]) => `${k} ${v}`).join(" · ")}. Pick another match to change it.</> : "Not matched yet. Pick the right one below."}
            </div>
          </div>
          <button className="link-plain" disabled={busy} onClick={() => close(false)} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="row id-search">
          <label className="grow">Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} /></label>
          <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} onKeyDown={(e) => e.key === "Enter" && void search()} /></label>
          <label className="narrow">Id type
            <select value={idType} onChange={(e) => setIdType(e.target.value)}>
              <option value="tmdb">TMDB</option><option value="tvdb">TVDB</option><option value="imdb">IMDb</option>
            </select>
          </label>
          <label>Id (optional)<input className="mono" value={idValue} onChange={(e) => setIdValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} /></label>
          <button className="primary" disabled={searching} onClick={() => void search()}><Icon name="search" /> {searching ? "Searching…" : "Search"}</button>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={replaceImages} onChange={(e) => setReplaceImages(e.target.checked)} />Use the match's artwork</label>
          <label className="check"><input type="checkbox" checked={fillArt} onChange={(e) => setFillArt(e.target.checked)} />Then fill in artwork that's still missing</label>
          <label className="check" title="Renames the folder to e.g. “Heat (1995) [tmdbid-949]”. Jellyfin then always matches it the same way, also after a reset. History can undo it."><input type="checkbox" checked={pin} onChange={(e) => setPrefs({ pinIds: e.target.checked })} />Make it stick: put the match in the folder name</label>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="id-results">
          {searching && !results && <div className="pg-loading"><span className="spinner" /> Searching…</div>}
          {results && results.length === 0 && <p className="muted">No matches. Try another spelling, the year, or an id from TMDB/IMDb.</p>}
          {(results ?? []).map((r, i) => (
            <div className={`match ${isNow(r) ? "now" : ""}`} key={i}>
              <div className="art">{r.ImageUrl ? <img src={remoteImageUrl(r.ImageUrl)} alt="" loading="lazy" /> : <div className="noart">{r.Name}</div>}</div>
              <div className="match-text">
                <div className="title">{r.Name}{r.ProductionYear ? ` (${r.ProductionYear})` : ""}{isNow(r) && <span className="flag ok">Current match</span>}</div>
                <div className="muted small">{r.SearchProviderName}{Object.entries(r.ProviderIds ?? {}).map(([k, v]) => ` · ${k} ${v}`).join("")}</div>
                {r.Overview && <p className="small">{r.Overview.slice(0, 240)}{r.Overview.length > 240 ? "…" : ""}</p>}
              </div>
              <button className={i === 0 && !isNow(r) ? "primary" : ""} disabled={busy} onClick={() => void use(r)}>{isNow(r) ? "Use again" : "This is it"}</button>
            </div>
          ))}
        </div>
        <div className="muted small">You can undo this in History.</div>
      </div>
    </div>
  );
}
