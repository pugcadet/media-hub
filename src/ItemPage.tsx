import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Details, errorText, imageUrl, ImageKind, ItemEdits, JfItem, remoteImageUrl, RemoteImage, SearchResult } from "./api";
import Nav from "./Nav";
import { EpisodesTab, SubtitlesTab } from "./Subtitles";
import { IntrosTab } from "./Intros";
import type { View } from "./App";

type Tab = "details" | "art" | "identify" | "seasons" | "subs" | "episodes" | "intros";
const KINDS: { kind: ImageKind; label: string; wide: boolean }[] = [
  { kind: "Primary", label: "Poster", wide: false },
  { kind: "Backdrop", label: "Backdrop", wide: true },
  { kind: "Logo", label: "Logo", wide: true },
  { kind: "Thumb", label: "Thumbnail", wide: true },
  { kind: "Banner", label: "Banner", wide: true },
];

const ACTION_LABEL: Record<string, string> = {
  item_update: "Edited details",
  identify: "Identified",
  image: "Changed picture",
  subtitle: "Downloaded subtitle",
  segment: "Changed intro/credits",
};

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

interface Form {
  name: string;
  originalTitle: string;
  sortName: string;
  year: string;
  overview: string;
  genres: string;
  tags: string;
  rating: string;
  officialRating: string;
  tmdb: string;
  tvdb: string;
  imdb: string;
  lock: boolean;
}

function toForm(i: JfItem): Form {
  return {
    name: i.Name ?? "",
    originalTitle: i.OriginalTitle ?? "",
    sortName: i.ForcedSortName ?? "",
    year: i.ProductionYear ? String(i.ProductionYear) : "",
    overview: i.Overview ?? "",
    genres: (i.Genres ?? []).join(", "),
    tags: (i.Tags ?? []).join(", "),
    rating: i.CommunityRating != null ? String(i.CommunityRating) : "",
    officialRating: i.OfficialRating ?? "",
    tmdb: i.ProviderIds?.Tmdb ?? "",
    tvdb: i.ProviderIds?.Tvdb ?? "",
    imdb: i.ProviderIds?.Imdb ?? "",
    lock: !!i.LockData,
  };
}

/** Only the fields that differ from what Jellyfin has are sent. */
function diff(a: Form, b: Form): ItemEdits {
  const e: ItemEdits = {};
  if (a.name !== b.name) e.name = b.name;
  if (a.originalTitle !== b.originalTitle) e.originalTitle = b.originalTitle;
  if (a.sortName !== b.sortName) e.sortName = b.sortName;
  if (a.year !== b.year) e.productionYear = b.year.trim() ? Number(b.year) : null;
  if (a.overview !== b.overview) e.overview = b.overview;
  if (a.genres !== b.genres) e.genres = list(b.genres);
  if (a.tags !== b.tags) e.tags = list(b.tags);
  if (a.rating !== b.rating) e.communityRating = b.rating.trim() ? Number(b.rating.replace(",", ".")) : null;
  if (a.officialRating !== b.officialRating) e.officialRating = b.officialRating;
  const ids: Record<string, string> = {};
  if (a.tmdb !== b.tmdb) ids.tmdb = b.tmdb;
  if (a.tvdb !== b.tvdb) ids.tvdb = b.tvdb;
  if (a.imdb !== b.imdb) ids.imdb = b.imdb;
  if (Object.keys(ids).length) e.providerIds = ids;
  if (a.lock !== b.lock) e.lockData = b.lock;
  return e;
}

export default function ItemPage({ id, onBack, onOpen, onNav, subLangs }: { id: string; onBack: () => void; onOpen: (id: string) => void; onNav: (v: View) => void; subLangs: string[] }) {
  const [d, setD] = useState<Details | null>(null);
  const [tab, setTab] = useState<Tab>("details");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [stamp, setStamp] = useState(""); // cache-buster after picture changes

  const load = useCallback(async () => {
    try {
      const det = await api.details(id);
      setD(det);
      setForm(toForm(det.item));
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }, [id]);

  useEffect(() => void load(), [load]);

  async function run(label: string, f: () => Promise<void>, done: string) {
    setBusy(label);
    setMessage(null);
    try {
      await f();
      setMessage({ text: done, error: false });
      await load();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  if (!d || !form) {
    return (
      <div className="app">
        <header>
          <button onClick={onBack}>← Back</button>
          <Nav current="library" onNav={onNav} />
        </header>
        <main>{message ? <p className="error">{message.text}</p> : <p className="muted">Loading…</p>}</main>
      </div>
    );
  }

  const item = d.item;
  const isSeason = item.Type === "Season";
  const kind: "series" | "movie" | null = item.Type === "Series" ? "series" : item.Type === "Movie" ? "movie" : null;
  const edits = diff(toForm(item), form);
  const dirty = Object.keys(edits).length > 0;
  const hasImage = (k: ImageKind) => d.images.some((i) => i.ImageType === k);
  const tabs: [Tab, string][] = [
    ["details", "Details"],
    ["art", "Artwork"],
    ...(kind ? ([["identify", "Identify"]] as [Tab, string][]) : []),
    ...(d.seasons.length ? ([["seasons", `Seasons (${d.seasons.length})`]] as [Tab, string][]) : []),
    ...(isSeason ? ([["episodes", "Episodes"], ["intros", "Intros & credits"]] as [Tab, string][]) : []),
    ...(item.Type === "Movie" || item.Type === "Episode" ? ([["subs", "Subtitles"]] as [Tab, string][]) : []),
  ];

  return (
    <div className="app">
      <header>
        <button onClick={onBack}>← Back</button>
        <Nav current="library" onNav={onNav} />
        <div className="spacer" />
        {d.canEdit && (
          <button disabled={!!busy} onClick={() => void run("Refreshing…", () => api.refreshItem(id, false), "Jellyfin is refreshing this item. Reload in a moment to see the result.")}>
            Refresh from internet
          </button>
        )}
      </header>

      <div className="hero">
        {hasImage("Backdrop") && <img className="backdrop" src={imageUrl(id, "Backdrop", 1280, 0, stamp)} alt="" />}
        <div className="hero-inner">
          <div className="art hero-poster">
            {hasImage("Primary") ? <img src={imageUrl(id, "Primary", 400, 0, stamp)} alt="" /> : <div className="noart">{item.Name}</div>}
          </div>
          <div className="hero-text">
            {hasImage("Logo") ? <img className="logo-img" src={imageUrl(id, "Logo", 600, 0, stamp)} alt={item.Name} /> : <h1>{item.Name}</h1>}
            <div className="muted">
              {isSeason ? item.SeriesName : item.Type}
              {item.ProductionYear ? ` · ${item.ProductionYear}` : ""}
              {item.OfficialRating ? ` · ${item.OfficialRating}` : ""}
            </div>
            <div className="ratings">
              {item.CommunityRating != null && <span className="chip static">★ {item.CommunityRating.toFixed(1)} community</span>}
              {item.CriticRating != null && <span className="chip static">{item.CriticRating}% critics</span>}
              {item.ProviderIds?.Imdb && <span className="chip static mono">{item.ProviderIds.Imdb}</span>}
              {item.ProviderIds?.Tmdb && <span className="chip static mono">TMDB {item.ProviderIds.Tmdb}</span>}
              {item.ProviderIds?.Tvdb && <span className="chip static mono">TVDB {item.ProviderIds.Tvdb}</span>}
            </div>
          </div>
        </div>
      </div>

      <main>
        {!d.canEdit && (
          <p className="note">
            Viewing only: changes to Jellyfin are switched off. <button className="link" onClick={() => onNav("settings")}>Turn them on in Settings</button>.
          </p>
        )}
        {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

        <div className="seg">
          {tabs.map(([t, label]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>

        {tab === "details" && (
          <section className="card form">
            <div className="row">
              <label>Title<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label>Original title<input value={form.originalTitle} onChange={(e) => setForm({ ...form, originalTitle: e.target.value })} /></label>
              <label>Sort as<input value={form.sortName} placeholder={item.SortName} onChange={(e) => setForm({ ...form, sortName: e.target.value })} /></label>
            </div>
            <div className="row">
              <label className="narrow">Year<input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></label>
              <label className="narrow">Rating<input value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value.replace(/[^\d.,]/g, "").slice(0, 4) })} /></label>
              <label className="narrow">Age rating<input value={form.officialRating} onChange={(e) => setForm({ ...form, officialRating: e.target.value })} /></label>
              <label>Genres (comma separated)<input value={form.genres} onChange={(e) => setForm({ ...form, genres: e.target.value })} /></label>
            </div>
            <label>Description<textarea rows={5} value={form.overview} onChange={(e) => setForm({ ...form, overview: e.target.value })} /></label>
            <label>Tags (comma separated)<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
            {!isSeason && (
              <div className="row">
                <label>TMDB id<input className="mono" value={form.tmdb} onChange={(e) => setForm({ ...form, tmdb: e.target.value.trim() })} /></label>
                <label>TVDB id<input className="mono" value={form.tvdb} onChange={(e) => setForm({ ...form, tvdb: e.target.value.trim() })} /></label>
                <label>IMDb id<input className="mono" value={form.imdb} onChange={(e) => setForm({ ...form, imdb: e.target.value.trim() })} /></label>
              </div>
            )}
            <label className="check"><input type="checkbox" checked={form.lock} onChange={(e) => setForm({ ...form, lock: e.target.checked })} />Lock these details (Jellyfin will not overwrite them when it refreshes)</label>
            <div className="row end">
              <button disabled={!dirty || !!busy} onClick={() => setForm(toForm(item))}>Reset</button>
              <button className="primary" disabled={!dirty || !d.canEdit || !!busy} onClick={() => void run("Saving…", () => api.saveMetadata(id, edits), "Saved.")}>
                {busy ?? "Save"}
              </button>
            </div>
          </section>
        )}

        {tab === "art" && (
          <ArtTab
            id={id}
            canEdit={d.canEdit}
            busy={!!busy}
            has={hasImage}
            stamp={stamp}
            onPick={(k, url) =>
              void run("Saving picture…", async () => {
                await api.setImage(id, k, url);
                setStamp(String(Date.now()));
              }, "Picture saved.")
            }
          />
        )}

        {tab === "identify" && kind && (
          <IdentifyTab
            item={item}
            kind={kind}
            canEdit={d.canEdit}
            busy={!!busy}
            onApply={(r, replace) =>
              void run("Applying…", async () => {
                await api.identifyApply(id, r, replace);
                setStamp(String(Date.now()));
              }, "Applied. Jellyfin is loading the new details; reload in a moment if something still looks old.")
            }
          />
        )}

        {tab === "subs" && <SubtitlesTab id={id} canEdit={d.canEdit} subLangs={subLangs} />}

        {tab === "intros" && <IntrosTab seasonId={id} canEdit={d.canEdit} onSettings={() => onNav("settings")} />}

        {tab === "episodes" && <EpisodesTab id={id} canEdit={d.canEdit} subLangs={subLangs} onOpen={onOpen} />}

        {tab === "seasons" && (
          <section className="grid">
            {d.seasons.map((s) => (
              <button className="poster" key={s.Id} onClick={() => onOpen(s.Id)}>
                <div className="art">
                  {s.ImageTags?.Primary ? <img src={imageUrl(s.Id, "Primary", 300, 0, s.ImageTags.Primary)} alt="" loading="lazy" /> : <div className="noart">{s.Name}</div>}
                </div>
                <div className="title">{s.Name}</div>
                <div className="sub">{s.ImageTags?.Primary ? "Has poster" : "No poster"}</div>
              </button>
            ))}
          </section>
        )}

        {d.changes.length > 0 && (
          <section className="card history">
            <h2>Changes made here</h2>
            {d.changes.map((c) => (
              <div className="batch" key={c.id}>
                <div>
                  <div>{ACTION_LABEL[c.action] ?? c.action}{c.action === "image" ? ` (${c.target.split("|")[1]})` : ""}</div>
                  <div className="muted small">{new Date(c.at * 1000).toLocaleString()}</div>
                </div>
                <div className="spacer" />
                {c.undone ? <span className="muted small">Undone</span> : (
                  <button disabled={!d.canEdit || !!busy} onClick={() => void run("Undoing…", async () => {
                    await api.undoChange(c.id);
                    setStamp(String(Date.now()));
                  }, "Undone.")}>Undo</button>
                )}
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function ArtTab({ id, canEdit, busy, has, stamp, onPick }: {
  id: string; canEdit: boolean; busy: boolean; has: (k: ImageKind) => boolean; stamp: string;
  onPick: (k: ImageKind, url: string) => void;
}) {
  const [kind, setKind] = useState<ImageKind>("Primary");
  const [candidates, setCandidates] = useState<RemoteImage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState("all");
  const wide = KINDS.find((k) => k.kind === kind)?.wide ?? false;

  useEffect(() => {
    setCandidates(null);
    setError(null);
    api.remoteImages(id, kind).then(setCandidates).catch((e) => setError(errorText(e)));
  }, [id, kind]);

  const langs = useMemo(() => [...new Set((candidates ?? []).map((c) => c.Language || "none"))], [candidates]);
  const shown = (candidates ?? []).filter((c) => c.Url && (lang === "all" || (c.Language || "none") === lang));

  return (
    <section className="card form">
      <div className="chips">
        {KINDS.map((k) => (
          <button key={k.kind} className={`chip ${kind === k.kind ? "on" : ""}`} onClick={() => setKind(k.kind)}>
            {k.label}{has(k.kind) ? " ✓" : ""}
          </button>
        ))}
      </div>
      <div className="row">
        <div>
          <div className="muted small">Current</div>
          <div className={`art current ${wide ? "wide" : ""}`}>
            {has(kind) ? <img src={imageUrl(id, kind, 500, 0, stamp)} alt="" /> : <div className="noart">None</div>}
          </div>
        </div>
      </div>
      <div className="toolbar">
        <div className="muted small">{candidates ? `${shown.length} options from Jellyfin's providers` : "Looking for options…"}</div>
        {langs.length > 1 && (
          <label className="sort">Language
            <select value={lang} onChange={(e) => setLang(e.target.value)}>
              <option value="all">All</option>
              {langs.map((l) => <option key={l} value={l}>{l === "none" ? "No text" : l}</option>)}
            </select>
          </label>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <div className={`candidates ${wide ? "wide" : ""}`}>
        {shown.map((c) => (
          <div className="cand" key={c.Url}>
            <div className={`art ${wide ? "wide" : ""}`}><img src={remoteImageUrl(c.ThumbnailUrl || c.Url!)} alt="" loading="lazy" /></div>
            <div className="small muted">
              {c.ProviderName}{c.Width ? ` · ${c.Width}×${c.Height}` : ""}{c.Language ? ` · ${c.Language}` : ""}
              {c.CommunityRating ? ` · ★ ${c.CommunityRating.toFixed(1)}` : ""}
            </div>
            <button disabled={!canEdit || busy} onClick={() => onPick(kind, c.Url!)}>Use this</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function IdentifyTab({ item, kind, canEdit, busy, onApply }: {
  item: JfItem; kind: "series" | "movie"; canEdit: boolean; busy: boolean;
  onApply: (r: SearchResult, replaceImages: boolean) => void;
}) {
  const [name, setName] = useState(item.Name);
  const [year, setYear] = useState(item.ProductionYear ? String(item.ProductionYear) : "");
  const [idType, setIdType] = useState("tmdb");
  const [idValue, setIdValue] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [replaceImages, setReplaceImages] = useState(false);

  async function search() {
    setSearching(true);
    setError(null);
    try {
      const ids = idValue.trim() ? { [idType]: idValue.trim() } : {};
      setResults(await api.identifySearch(kind, name, year ? Number(year) : null, ids));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSearching(false);
    }
  }

  return (
    <section className="card form">
      <p className="muted">Search TMDB, TVDB and the other providers set up in Jellyfin, then pick the right match.</p>
      <div className="row">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
        <label className="narrow">Id type
          <select value={idType} onChange={(e) => setIdType(e.target.value)}>
            <option value="tmdb">TMDB</option><option value="tvdb">TVDB</option><option value="imdb">IMDb</option>
          </select>
        </label>
        <label>Id (optional)<input className="mono" value={idValue} onChange={(e) => setIdValue(e.target.value)} /></label>
        <button className="primary" disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search"}</button>
      </div>
      <label className="check"><input type="checkbox" checked={replaceImages} onChange={(e) => setReplaceImages(e.target.checked)} />Also replace all pictures with the match's pictures</label>
      {error && <p className="error">{error}</p>}
      {results && results.length === 0 && <p className="muted">No matches. Try another spelling or an id.</p>}
      <div className="results-list">
        {(results ?? []).map((r, i) => (
          <div className="match" key={i}>
            <div className="art">{r.ImageUrl ? <img src={remoteImageUrl(r.ImageUrl)} alt="" loading="lazy" /> : <div className="noart">{r.Name}</div>}</div>
            <div className="match-text">
              <div className="title">{r.Name}{r.ProductionYear ? ` (${r.ProductionYear})` : ""}</div>
              <div className="muted small">
                {r.SearchProviderName}
                {Object.entries(r.ProviderIds ?? {}).map(([k, v]) => ` · ${k} ${v}`).join("")}
              </div>
              {r.Overview && <p className="small">{r.Overview.slice(0, 280)}{r.Overview.length > 280 ? "…" : ""}</p>}
              <button disabled={!canEdit || busy} onClick={() => {
                if (window.confirm(`Use “${r.Name}” for this item? You can undo this afterwards.`)) onApply(r, replaceImages);
              }}>This is it</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
