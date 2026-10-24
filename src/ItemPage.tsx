import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api, codesFor, cultures, Culture, Details, errorText, imageUrl, ImageKind, ItemEdits, JfChild, JfItem,
  languageName, remoteImageUrl, RemoteImage, SearchResult, Status,
} from "./api";
import { EpisodesTab, SubtitlesTab } from "./Subtitles";
import { IntrosTab } from "./Intros";
import Player from "./Player";
import { askConfirm } from "./confirm";
import type { View } from "./App";

const KINDS: { kind: ImageKind; label: string; wide: boolean }[] = [
  { kind: "Primary", label: "Poster", wide: false },
  { kind: "Thumb", label: "Thumbnail", wide: true },
  { kind: "Banner", label: "Banner", wide: true },
  { kind: "Logo", label: "Logo", wide: true },
  { kind: "Backdrop", label: "Backdrop", wide: true },
];

const ACTION_LABEL: Record<string, string> = {
  item_update: "Edited details",
  identify: "Identified",
  image: "Changed picture",
  subtitle: "Downloaded subtitle",
  segment: "Changed intro/credits",
};

const LANGS: [string, string][] = [["", "Library default"], ["en", "English"], ["nl", "Nederlands"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"], ["it", "Italiano"]];

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

interface Form {
  name: string; originalTitle: string; sortName: string; year: string; overview: string; genres: string; tags: string;
  rating: string; officialRating: string; tmdb: string; tvdb: string; imdb: string; lock: boolean; lang: string;
}

function toForm(i: JfItem): Form {
  return {
    name: i.Name ?? "", originalTitle: i.OriginalTitle ?? "", sortName: i.ForcedSortName ?? "",
    year: i.ProductionYear ? String(i.ProductionYear) : "", overview: i.Overview ?? "",
    genres: (i.Genres ?? []).join(", "), tags: (i.Tags ?? []).join(", "),
    rating: i.CommunityRating != null ? String(i.CommunityRating) : "", officialRating: i.OfficialRating ?? "",
    tmdb: i.ProviderIds?.Tmdb ?? "", tvdb: i.ProviderIds?.Tvdb ?? "", imdb: i.ProviderIds?.Imdb ?? "",
    lock: !!i.LockData, lang: i.PreferredMetadataLanguage ?? "",
  };
}

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
  if (a.lang !== b.lang) e.preferredLanguage = b.lang;
  return e;
}

interface Props {
  id: string;
  onBack: () => void;
  onOpen: (id: string) => void;
  onNav: (v: View) => void;
  subLangs: string[];
  titleLang: string;
  status: Status;
}

export default function ItemPage({ id, onBack, onOpen, onNav, subLangs, status }: Props) {
  const [d, setD] = useState<Details | null>(null);
  const [tab, setTab] = useState<string>("main"); // "main" | season id | "subs" | "identify"
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [stamp, setStamp] = useState("");
  const [playId, setPlayId] = useState<string | null>(null);

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
      <div className="pg">
        <div className="item-top"><button onClick={onBack}>← Back</button></div>
        {message ? <p className="error">{message.text}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const item = d.item;
  const isSeries = item.Type === "Series";
  const isSeason = item.Type === "Season";
  const playable = item.Type === "Movie" || item.Type === "Episode";
  const kind: "series" | "movie" | null = isSeries ? "series" : item.Type === "Movie" ? "movie" : null;
  const season = isSeries ? d.seasons.find((s) => s.Id === tab) ?? null : null;
  const artTarget = season ? season.Id : id;
  const edits = diff(toForm(item), form);
  const dirty = Object.keys(edits).length > 0;
  const linked = (k: string) => !!item.ProviderIds?.[k];

  const tabs: [string, string][] = isSeries
    ? [["main", "Series"], ...d.seasons.map((s) => [s.Id, s.Name] as [string, string])]
    : isSeason
      ? [["main", "Season"], ["season", "Episodes"], ["intros", "Intros & credits"]]
      : [["main", item.Type === "Movie" ? "Movie" : "Episode"], ["subs", "Subtitles"]];
  if (kind) tabs.push(["identify", "Identify"]);

  const save = () => void run("Saving…", () => api.saveMetadata(id, edits), "Saved.");

  return (
    <div className="pg item">
      <div className="item-top">
        <button onClick={onBack}>← Back</button>
        <span className="muted small crumbs">{item.SeriesName ? `${item.SeriesName} · ` : ""}{item.Type}</span>
        <div className="spacer" />
        {playable && <button className="primary" onClick={() => setPlayId(id)}>▶ {item.UserData?.PlaybackPositionTicks ? "Resume" : "Play"}</button>}
        {d.canEdit && (
          <button disabled={!!busy} onClick={() => void run("Refreshing…", () => api.refreshItem(id, false), "Jellyfin is refreshing this item from the internet. Reload in a moment.")}>Refresh from internet</button>
        )}
      </div>

      <div className="item-cols">
        <ArtColumn
          key={artTarget}
          id={artTarget}
          title={season ? season.Name : isSeason ? item.Name : item.Name}
          subtitle={season ? item.Name : undefined}
          canEdit={d.canEdit}
          busy={!!busy}
          stamp={stamp}
          onChanged={(msg) => { setStamp(String(Date.now())); setMessage({ text: msg, error: false }); void load(); }}
          onError={(msg) => setMessage({ text: msg, error: true })}
        />

        <section className="item-main">
          <div className="item-head">
            <div className="stack-s">
              <h1>{item.Name}{item.ProductionYear && !isSeason ? <span className="muted year"> ({item.ProductionYear})</span> : null}</h1>
              <div className="badges">
                {!isSeason && item.Type !== "Episode" && (
                  <>
                    <span className={`badge ${linked("Tmdb") ? "on" : ""}`}>{linked("Tmdb") ? "TMDB linked" : "No TMDB"}</span>
                    <span className={`badge ${linked("Tvdb") ? "on" : ""}`}>{linked("Tvdb") ? "TVDB linked" : "No TVDB"}</span>
                    <span className={`badge ${linked("Imdb") ? "on" : ""}`}>{linked("Imdb") ? "IMDb linked" : "No IMDb"}</span>
                  </>
                )}
                {item.CommunityRating != null && <span className="badge solid">★ {item.CommunityRating.toFixed(1)}</span>}
                {item.CriticRating != null && <span className="badge solid">Critics {item.CriticRating}%</span>}
                {item.OfficialRating && <span className="badge solid">{item.OfficialRating}</span>}
              </div>
            </div>
            <div className="row">
              {kind && <button onClick={() => setTab("identify")}>Auto-detect again</button>}
              <button className="primary" disabled={!dirty || !d.canEdit || !!busy} onClick={save}>{busy === "Saving…" ? "Saving…" : "Save"}</button>
            </div>
          </div>

          {!d.canEdit && (
            <p className="note">Viewing only: changes to Jellyfin are switched off. <button className="link" onClick={() => onNav("settings")}>Turn them on in Settings</button>.</p>
          )}
          {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

          <div className="tabs">
            {tabs.map(([t, label]) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>)}
          </div>

          {tab === "main" && (
            <div className="stack">
              <div className="fields2">
                <label>Title<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                <label>Language of titles and summaries
                  <select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value })}>
                    {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
              </div>
              <label>Overview<textarea rows={4} value={form.overview} onChange={(e) => setForm({ ...form, overview: e.target.value })} /></label>
              <details className="more">
                <summary>More details</summary>
                <div className="fields3">
                  <label>Original title<input value={form.originalTitle} onChange={(e) => setForm({ ...form, originalTitle: e.target.value })} /></label>
                  <label>Sort as<input value={form.sortName} placeholder={item.SortName} onChange={(e) => setForm({ ...form, sortName: e.target.value })} /></label>
                  <label>Year<input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></label>
                  <label>Rating<input value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value.replace(/[^\d.,]/g, "").slice(0, 4) })} /></label>
                  <label>Age rating<input value={form.officialRating} onChange={(e) => setForm({ ...form, officialRating: e.target.value })} /></label>
                  <label>Genres<input value={form.genres} onChange={(e) => setForm({ ...form, genres: e.target.value })} /></label>
                  <label>Tags<input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></label>
                  {!isSeason && <label>TMDB id<input className="mono" value={form.tmdb} onChange={(e) => setForm({ ...form, tmdb: e.target.value.trim() })} /></label>}
                  {!isSeason && <label>TVDB id<input className="mono" value={form.tvdb} onChange={(e) => setForm({ ...form, tvdb: e.target.value.trim() })} /></label>}
                  {!isSeason && <label>IMDb id<input className="mono" value={form.imdb} onChange={(e) => setForm({ ...form, imdb: e.target.value.trim() })} /></label>}
                </div>
                <label className="check"><input type="checkbox" checked={form.lock} onChange={(e) => setForm({ ...form, lock: e.target.checked })} />Lock these details (Jellyfin will not overwrite them)</label>
              </details>
              {dirty && <div className="row end"><button onClick={() => setForm(toForm(item))}>Reset</button><button className="primary" disabled={!d.canEdit || !!busy} onClick={save}>Save</button></div>}
              {isSeries && d.seasons.length > 0 && (
                <p className="muted small">Open a season tab to see its episodes, artwork, subtitles and intros.</p>
              )}
            </div>
          )}

          {season && <SeasonPanel key={season.Id} season={season} canEdit={d.canEdit} subLangs={subLangs} onOpen={onOpen} onNav={onNav} />}
          {isSeason && tab === "season" && <SeasonPanel season={item} canEdit={d.canEdit} subLangs={subLangs} onOpen={onOpen} onNav={onNav} />}
          {isSeason && tab === "intros" && <IntrosTab seasonId={id} seasonName={item.Name} canEdit={d.canEdit} onSettings={() => onNav("settings")} />}
          {tab === "subs" && <SubtitlesTab id={id} canEdit={d.canEdit} subLangs={subLangs} />}
          {tab === "identify" && kind && (
            <IdentifyTab item={item} kind={kind} canEdit={d.canEdit} busy={!!busy}
              onApply={(r, replace) => void run("Applying…", async () => { await api.identifyApply(id, r, replace); setStamp(String(Date.now())); }, "Applied. Jellyfin is loading the new details; reload in a moment if something still looks old.")} />
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
                    <button disabled={!d.canEdit || !!busy} onClick={() => void run("Undoing…", async () => { await api.undoChange(c.id); setStamp(String(Date.now())); }, "Undone.")}>Undo</button>
                  )}
                </div>
              ))}
            </section>
          )}
        </section>
      </div>
      {playId && <Player key={playId} id={playId} status={status} onClose={() => { setPlayId(null); void load(); }} onNext={(n) => setPlayId(n)} />}
    </div>
  );
}

/** Left column: the picture, its kind, and options to pick from (mockup: "Season 1 artwork"). */
function ArtColumn({ id, title, subtitle, canEdit, busy, stamp, onChanged, onError }: {
  id: string; title: string; subtitle?: string; canEdit: boolean; busy: boolean; stamp: string;
  onChanged: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [kind, setKind] = useState<ImageKind>("Primary");
  const [has, setHas] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState<RemoteImage[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const wide = KINDS.find((k) => k.kind === kind)?.wide ?? false;

  useEffect(() => {
    api.details(id).then((d) => setHas(new Set(d.images.map((i) => i.ImageType)))).catch(() => setHas(new Set()));
  }, [id, stamp]);
  useEffect(() => {
    setOptions(null);
    setShowAll(false);
    api.remoteImages(id, kind).then(setOptions).catch(() => setOptions([]));
  }, [id, kind]);

  async function use(url: string) {
    setSaving(true);
    try {
      await api.setImage(id, kind, url);
      onChanged("Picture saved.");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }
  async function upload() {
    setSaving(true);
    try {
      if (await api.uploadImageFile(id, kind)) onChanged("Picture saved.");
    } catch (e) {
      onError(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const shown = (options ?? []).filter((o) => o.Url).slice(0, showAll ? 60 : 8);
  return (
    <section className="art-col">
      <div className={`art big ${wide ? "wide" : ""}`}>
        {has.has(kind) ? <img src={imageUrl(id, kind, 700, 0, stamp)} alt="" /> : (
          <div className="noart big-title">{title}{subtitle && <div className="small muted">{subtitle}</div>}</div>
        )}
      </div>
      <div className="stack-s">
        <h2>{title} artwork</h2>
        <div className="chips">
          {KINDS.map((k) => (
            <button key={k.kind} className={`chip ${kind === k.kind ? "on" : ""}`} onClick={() => setKind(k.kind)}>{k.label}{has.has(k.kind) ? "" : " ·"}</button>
          ))}
        </div>
      </div>
      <div className="muted small">{options === null ? "Looking for options…" : `${(options ?? []).filter((o) => o.Url).length} options`}</div>
      <div className={`art-options ${wide ? "wide" : ""}`}>
        {shown.map((o) => (
          <button key={o.Url} className={`art-opt ${wide ? "wide" : ""}`} disabled={!canEdit || busy || saving} onClick={() => void use(o.Url!)} title={`${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""} ${o.Language ?? ""}`}>
            <img src={remoteImageUrl(o.ThumbnailUrl || o.Url!)} alt="" loading="lazy" />
            <span className="src">{o.ProviderName?.replace("TheMovieDb", "TMDB").replace("TheTVDB", "TVDB") ?? ""}{o.Language ? ` · ${o.Language}` : ""}</span>
          </button>
        ))}
      </div>
      {(options?.length ?? 0) > 8 && !showAll && <button className="link small" onClick={() => setShowAll(true)}>Show all options</button>}
      <div className="row">
        <button className="grow" disabled={!canEdit || busy || saving} onClick={() => void upload()}>Upload image</button>
      </div>
      {!canEdit && <p className="muted small">Picking pictures needs changes switched on in Settings.</p>}
    </section>
  );
}

/** A season inside the show page: episode table (mockup) + subtitles and intros tools. */
function SeasonPanel({ season, canEdit, subLangs, onOpen, onNav }: {
  season: JfItem; canEdit: boolean; subLangs: string[]; onOpen: (id: string) => void; onNav: (v: View) => void;
}) {
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [langs, setLangs] = useState<Culture[]>([]);
  const [tool, setTool] = useState<"none" | "subs" | "intros">("none");
  useEffect(() => {
    api.children(season.Id).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch(() => setEps([]));
    cultures().then(setLangs).catch(() => setLangs([]));
  }, [season.Id]);
  const want = useMemo(() => subLangs.map((l) => codesFor(l, langs)), [subLangs, langs]);

  const subsCell = (e: JfChild) => {
    const streams = (e.MediaStreams ?? []).filter((s) => s.Type === "Subtitle" && !s.IsForced);
    const have = (codes: string[]) => streams.some((s) => s.Language && codes.includes(s.Language.toLowerCase()));
    const parts = subLangs.map((l, i) => `${languageName(l, langs).slice(0, 2).toUpperCase()} ${have(want[i] ?? [l]) ? "✓" : "none"}`);
    const all = subLangs.every((_, i) => have(want[i] ?? []));
    const any = subLangs.some((_, i) => have(want[i] ?? []));
    return <span className={all ? "ok" : any ? "warn" : "bad"}>{parts.join(" · ")}</span>;
  };

  return (
    <div className="stack">
      <div className="card table-card">
        <div className="ep-row head"><span>#</span><span>Episode title</span><span>Aired</span><span>Subtitles</span><span /></div>
        {eps === null && <p className="muted small pad">Loading episodes…</p>}
        {eps?.map((e) => (
          <button className="ep-row" key={e.Id} onClick={() => onOpen(e.Id)}>
            <span className="muted">{e.IndexNumber ?? ""}</span>
            <span className="title">{e.Name}</span>
            <span className="muted small">{e.PremiereDate ? new Date(e.PremiereDate).toLocaleDateString() : ""}</span>
            <span className="small">{subsCell(e)}</span>
            <span className="muted small">{e.UserData?.Played ? "Watched" : ""}</span>
          </button>
        ))}
        {eps && eps.length === 0 && <p className="muted small pad">No episodes.</p>}
      </div>
      <div className="row">
        <button className={tool === "subs" ? "primary" : ""} onClick={() => setTool(tool === "subs" ? "none" : "subs")}>Get missing subtitles…</button>
        <button className={tool === "intros" ? "primary" : ""} onClick={() => setTool(tool === "intros" ? "none" : "intros")}>Intros and credits…</button>
      </div>
      {tool === "subs" && <EpisodesTab id={season.Id} canEdit={canEdit} subLangs={subLangs} onOpen={onOpen} />}
      {tool === "intros" && <IntrosTab seasonId={season.Id} seasonName={season.Name} canEdit={canEdit} onSettings={() => onNav("settings")} />}
    </div>
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

  const search = useCallback(async () => {
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
  }, [idType, idValue, kind, name, year]);

  // Search straight away with what we know.
  useEffect(() => { void search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card form">
      <p className="muted small">Matches come from the providers set up in Jellyfin (TMDB, TVDB, …). Pick the right one.</p>
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
              <div className="muted small">{r.SearchProviderName}{Object.entries(r.ProviderIds ?? {}).map(([k, v]) => ` · ${k} ${v}`).join("")}</div>
              {r.Overview && <p className="small">{r.Overview.slice(0, 280)}{r.Overview.length > 280 ? "…" : ""}</p>}
              <button disabled={!canEdit || busy} onClick={() => {
                void askConfirm(`Use “${r.Name}” for this item? You can undo this afterwards.`, { okLabel: "Use it" }).then((ok) => ok && onApply(r, replaceImages));
              }}>This is it</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
