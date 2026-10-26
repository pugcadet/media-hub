import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, isTitleGone, Card, CheckRow, cleanTitle, HealthRow, SegSummary, codesFor, cultures, Culture, Details, errorText, imageUrl, ImageKind, ItemEdits, JfChild, JfImage, JfItem,
  languageName, remoteImageUrl, RemoteImage, Status,
} from "./api";
import { SubtitlesTab, EpisodesTab } from "./Subtitles";
import { IntrosTab, ShowIntros } from "./Intros";
import { askConfirm } from "./confirm";
import { reloadItems, track, useEpoch, useItemEpoch } from "./activity";
import { nav, type View } from "./nav";
import { askChoice, CardTile, Icon, type IconName, itemMenu, openMenu, playTitle, scanLibrary, showPicture, SettingsLink } from "./ui";
import { subSkipped, usePrefs } from "./prefs";
import { artSkipped, CORE_ART, fixTitles, FixTarget, namesToFix, noSubsOf, safeFixes } from "./fixers";
import { askFixes } from "./FixDialog";
import { applyArt, askArt, fillOptional, rankImages } from "./ArtPicker";
import { askIdentify } from "./IdentifyDialog";
import { askCrop, readPaste, showPreview, type CropSource } from "./ArtTools";
import { numberYouTube } from "./youtube";

export const ART_KINDS: { kind: ImageKind; label: string; wide: boolean; hint: string }[] = [
  { kind: "Primary", label: "Poster", wide: false, hint: "The main picture in every app." },
  { kind: "Backdrop", label: "Backdrop", wide: true, hint: "Big picture behind the title. A title can have several; the first is the main one." },
  { kind: "Logo", label: "Logo", wide: true, hint: "The title as artwork, shown over the backdrop (Infuse uses it a lot)." },
  { kind: "Thumb", label: "Thumbnail", wide: true, hint: "Landscape picture used for rows like “Continue watching”." },
  { kind: "Banner", label: "Banner", wide: true, hint: "Optional: Infuse and Media Hub don't show banners. Some other Jellyfin apps do." },
  { kind: "Art", label: "Clear art", wide: true, hint: "Optional: not shown by Infuse or Media Hub." },
  { kind: "Disc", label: "Disc", wide: false, hint: "Optional: not shown anywhere you use." },
];

const ACTION_LABEL: Record<string, string> = {
  item_update: "Edited details",
  identify: "Identified",
  image: "Changed picture",
  image_removed: "Removed picture",
  collection: "Changed collection",
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

const runtime = (ticks?: number) => {
  if (!ticks) return "";
  const m = Math.round(ticks / 600_000_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};

/** Picture of a kind/index with the tag Jellyfin gave it, so a new picture is fetched at once. */
function artSrc(id: string, kind: ImageKind, w: number, images: JfImage[], index = 0) {
  const tag = images.find((i) => i.ImageType === kind && (i.ImageIndex ?? 0) === index)?.ImageTag ?? "";
  return imageUrl(id, kind, w, index, tag);
}

interface Props {
  id: string;
  initialTab?: string;
  tabNonce?: number;
  onBack: () => void;
  onOpen: (id: string) => void;
  onNav: (v: View) => void;
  subLangs: string[];
  titleLang: string;
  status: Status;
  /** Inside another screen (the Library list): no back button, small header. */
  embedded?: boolean;
  /** Called with the details each time they load (the list updates its row). */
  onLoaded?: (d: Details) => void;
}

type TabId = "main" | "episodes" | "art" | "subs" | "intros" | "collection";

/** Old tab names (and a season id) still work: they map to the tab that has it now. */
function tabFor(t: string | undefined): { tab: TabId; season?: string; action?: "identify" | "rename" } {
  switch (t) {
    case undefined: case "": case "main": case "cast": return { tab: "main" };
    case "identify": return { tab: "main", action: "identify" };
    case "rename": return { tab: "main", action: "rename" };
    case "art": case "subs": case "intros": case "collection": case "episodes": return { tab: t };
    case "season": return { tab: "episodes" };
    default: return { tab: "episodes", season: t };
  }
}

export default function ItemPage({ id, initialTab, tabNonce, onBack, onNav, subLangs, embedded, onLoaded }: Props) {
  const epoch = useEpoch();
  const itemEpoch = useItemEpoch(id);
  const [d, setD] = useState<Details | null>(null);
  const start = tabFor(initialTab);
  const [tab, setTab] = useState<TabId>(start.tab);
  const [season, setSeason] = useState<string | null>(start.season ?? null);
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [logoOk, setLogoOk] = useState(true);
  const dirtyRef = useRef(false);
  const pending = useRef<"identify" | "rename" | undefined>(start.action);

  useEffect(() => {
    if (!initialTab) return;
    const t = tabFor(initialTab);
    setTab(t.tab);
    if (t.season) setSeason(t.season);
    pending.current = t.action;
  }, [initialTab, tabNonce]);

  const load = useCallback(async () => {
    try {
      const det = await api.details(id);
      setD(det);
      onLoaded?.(det);
      // Keep what you are typing when the page reloads in the background.
      if (!dirtyRef.current) setForm(toForm(det.item));
    } catch (e) {
      if (isTitleGone(e)) {
        // Usually renamed: Jellyfin found it again under a new id. Look it up and go there.
        setMessage({ text: "This title moved in Jellyfin. Looking it up…", error: false });
        const moved = await api.findMoved(id).catch(() => null);
        if (moved) {
          void scanLibrary();
          nav.open(moved);
          return;
        }
      }
      setMessage({ text: errorText(e), error: true });
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [load, epoch, itemEpoch]);

  const identify = useCallback((det: Details) => {
    const it = det.item;
    const kind = it.Type === "Series" ? "series" : it.Type === "Movie" ? "movie" : null;
    if (!kind) return;
    void askIdentify(it.Id, it.Name, it.ProductionYear ?? null, kind, it.ProviderIds ?? {});
  }, []);

  // "Identify" and "Rename" asked from elsewhere: the popup / the Renamer, once loaded.
  useEffect(() => {
    if (!d || !pending.current) return;
    const a = pending.current;
    pending.current = undefined;
    if (a === "identify") identify(d);
    if (a === "rename") nav.route({ view: "renamer", item: id });
  }, [d, id, identify]);

  async function run(label: string, f: () => Promise<void>, done: string) {
    setBusy(label);
    setMessage(null);
    try {
      await track(label.replace(/…$/, ""), f, { items: [id, d?.item.SeriesId] });
      setMessage({ text: done, error: false });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  if (!d || !form) {
    return (
      <div className="pg">
        {!embedded && <div className="item-top"><button onClick={onBack}>← Back</button></div>}
        {message ? (
          <div className="stack-s">
            <p className={message.error ? "error" : "muted"}>{message.text}</p>
            {/no longer in Jellyfin/.test(message.text) && <div className="row"><button className="primary" onClick={() => void scanLibrary().then(onBack)}>Scan the library</button><button onClick={onBack}>Back</button></div>}
          </div>
        ) : <div className="pg-loading"><span className="spinner" /> Loading…</div>}
      </div>
    );
  }

  const item = d.item;
  const isSeries = item.Type === "Series";
  const isSeason = item.Type === "Season";
  const isEpisode = item.Type === "Episode";
  const isMovie = item.Type === "Movie";
  const isBoxSet = item.Type === "BoxSet";
  const playable = isMovie || isEpisode;
  const kind: "series" | "movie" | null = isSeries ? "series" : isMovie ? "movie" : null;
  const edits = diff(toForm(item), form);
  const dirty = Object.keys(edits).length > 0;
  dirtyRef.current = dirty;
  const heroId = (isEpisode || isSeason) && item.SeriesId ? item.SeriesId : id;
  const title = cleanTitle(item.Name, item.ProductionYear);
  const hasBackdrop = isEpisode || isSeason ? true : d.images.some((i) => i.ImageType === "Backdrop");
  const meta = [
    isEpisode && item.ParentIndexNumber != null ? `S${item.ParentIndexNumber} · E${item.IndexNumber ?? "?"}` : "",
    isBoxSet ? "Collection" : "",
    item.ProductionYear ? String(item.ProductionYear) : "",
    item.OfficialRating ?? "",
    runtime(item.RunTimeTicks),
    isSeries && d.seasons.length ? `${d.seasons.length} season${d.seasons.length === 1 ? "" : "s"}` : "",
    (item.Genres ?? []).slice(0, 3).join(", "),
  ].filter(Boolean);

  const tabs: { id: TabId; label: string; icon: IconName }[] = [{ id: "main", label: isSeason ? "Episodes" : isBoxSet ? "Titles" : "Overview", icon: isSeason ? "list" : "info" }];
  if (isSeries) tabs.push({ id: "episodes", label: "Episodes", icon: "list" });
  tabs.push({ id: "art", label: "Artwork", icon: "image" });
  if (playable || isSeries || isSeason) tabs.push({ id: "subs", label: "Subtitles", icon: "subtitles" });
  if (isSeries || isSeason) tabs.push({ id: "intros", label: "Intros & credits", icon: "skip" });
  if (kind) tabs.push({ id: "collection", label: "Collection", icon: "stack" });
  const shownTab: TabId = tabs.some((t) => t.id === tab) ? tab : "main";

  const save = () => void run("Saving…", () => api.saveMetadata(id, edits), "Saved.");
  const crumb = (label: string, to: () => void) => <button className="link" onClick={to}>{label}</button>;
  const menu = () => itemMenu({ id, kind: item.Type, title, seriesId: item.SeriesId, seasonId: item.SeasonId, played: item.UserData?.Played }, d.canEdit);

  return (
    <div className={`pg item ${embedded ? "embedded" : ""}`}>
      <section className={`cine ${hasBackdrop ? "" : "flat"} ${shownTab === "main" && !embedded ? "" : "compact"}`} onContextMenu={(e) => openMenu(e, menu())}>
        {hasBackdrop && <img className="cine-art" key={heroId} src={isEpisode ? imageUrl(id, "Primary", 1920, 0, item.ImageTags?.Primary ?? "") : artSrc(heroId, "Backdrop", 1920, heroId === id ? d.images : [])} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />}
        <div className="cine-shade" />
        <div className="cine-top">
          {!embedded && <button className="cine-back" onClick={onBack}><span className="flip"><Icon name="chevron" size={16} /></span> Back</button>}
          {!embedded && (
            <span className="small crumbs">
              {item.SeriesName && item.SeriesId ? crumb(cleanTitle(item.SeriesName), () => nav.open(item.SeriesId!)) : null}
              {isEpisode && item.SeasonId && item.SeriesId ? <> › {crumb(item.SeasonName ?? `Season ${item.ParentIndexNumber ?? ""}`, () => nav.open(item.SeriesId!, { tab: item.SeasonId }))}</> : null}
            </span>
          )}
          <div className="spacer" />
          {!isBoxSet && <button className="cine-ghost" title="Show in Finder" onClick={() => void api.revealItem(id).catch((e) => setMessage({ text: errorText(e), error: true }))}><Icon name="folder" /> Finder</button>}
          {d.canEdit && (
            <button className="cine-ghost" disabled={!!busy} title="Fetch details and pictures again (unlocks the title)" onClick={() => void run("Refreshing…", () => api.refreshItem(id, false), "Jellyfin is refreshing this item from the internet; this page updates by itself.")}><Icon name="reload" /> Refresh</button>
          )}
          <button className="cine-ghost icon-only" aria-label="More" onClick={(e) => openMenu(e, menu())}><Icon name="more" /></button>
        </div>
        <div className="cine-body">
          {embedded && !isEpisode && !isSeason && (
            <button className="hero-poster" onClick={() => showPicture(artSrc(id, "Primary", 1400, d.images), `${title} · poster`)} title="Show big">
              {d.images.some((i) => i.ImageType === "Primary") ? <img src={artSrc(id, "Primary", 300, d.images)} alt="" /> : <div className="noart">{title}</div>}
            </button>
          )}
          <div className="cine-text">
            {item.LockData && <span className="cine-lock" title="Locked: Jellyfin won't change these details by itself"><Icon name="lock" size={12} /> Locked</span>}
            {logoOk && !isEpisode && !isSeason && d.images.some((i) => i.ImageType === "Logo") ? (
              <img className="cine-logo" src={artSrc(id, "Logo", 800, d.images)} alt={title} onError={() => setLogoOk(false)} />
            ) : (
              <h1 className="cine-title">{isSeason && item.SeriesName ? `${cleanTitle(item.SeriesName)} · ` : ""}{isEpisode ? item.Name : title}</h1>
            )}
            <div className="hero-meta">
              {meta.map((m, i) => <span key={i}>{m}</span>)}
              {item.CommunityRating != null && <span>★ {item.CommunityRating.toFixed(1)}</span>}
              {item.UserData?.Played && <span className="ok">Watched</span>}
            </div>
            {item.Overview && !embedded && <p className="cine-overview">{item.Overview}</p>}
            {kind && <TitleHealth d={d} kind={kind} canEdit={d.canEdit} subLangs={subLangs} onTab={setTab} onIdentify={() => identify(d)} />}
            {!kind && !isBoxSet && (
              <div className="row bb-actions">
                {playable && <button className="bb-play" onClick={() => nav.play(id)}><Icon name="play" size={20} /> {item.UserData?.PlaybackPositionTicks ? "Resume" : "Play"}</button>}
                {isSeason && <button className="bb-play" onClick={() => void playTitle(id)}><Icon name="play" size={20} /> Play</button>}
              </div>
            )}
          </div>
        </div>
      </section>

      {!d.canEdit && (
        <p className="note">Viewing only: changes to Jellyfin are switched off. <SettingsLink section="changes">Turn them on</SettingsLink></p>
      )}
      {message && <p className={message.error ? "error" : "note"} role="status">{message.text}</p>}

      <div className="tabs item-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={shownTab === t.id} className={shownTab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} /> {t.label}
          </button>
        ))}
      </div>

      {shownTab === "main" && isSeason && <SeasonPanel season={item} canEdit={d.canEdit} subLangs={subLangs} />}
      {shownTab === "main" && isBoxSet && <BoxSetTitles id={id} canEdit={d.canEdit} />}
      {shownTab === "main" && !isSeason && (
        <div className="stack">
          {kind && <StatusCards d={d} kind={kind} onTab={setTab} onIdentify={() => identify(d)} />}
          <div className="card form">
            <div className="section-head"><h2><Icon name="info" /> Details</h2>{kind && <button className="link small" onClick={() => identify(d)}>Identify again…</button>}</div>
            <div className="fields2">
              <label>Title<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label>Language of titles and summaries
                <select value={form.lang} onChange={(e) => setForm({ ...form, lang: e.target.value })}>
                  {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            {/\(\d{4}\)\s*$/.test(form.name) && (
              <p className="note small">
                The year is in the title itself. It's already shown next to it, and the folder keeps it for Jellyfin, so the title doesn't need it.{" "}
                <button className="link" onClick={() => setForm({ ...form, name: cleanTitle(form.name) })}>Remove it from the title</button>
              </p>
            )}
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
                {!isEpisode && !isBoxSet && <label>TMDB id<input className="mono" value={form.tmdb} onChange={(e) => setForm({ ...form, tmdb: e.target.value.trim() })} /></label>}
                {!isEpisode && !isBoxSet && <label>TVDB id<input className="mono" value={form.tvdb} onChange={(e) => setForm({ ...form, tvdb: e.target.value.trim() })} /></label>}
                {!isEpisode && !isBoxSet && <label>IMDb id<input className="mono" value={form.imdb} onChange={(e) => setForm({ ...form, imdb: e.target.value.trim() })} /></label>}
              </div>
              <label className="check"><input type="checkbox" checked={form.lock} onChange={(e) => setForm({ ...form, lock: e.target.checked })} />Lock these details (Jellyfin will not overwrite them)</label>
            </details>
            <div className="row end">
              {dirty && <button onClick={() => setForm(toForm(item))}>Reset</button>}
              <button className="primary" disabled={!dirty || !d.canEdit || !!busy} onClick={save}>{busy === "Saving…" ? "Saving…" : "Save"}</button>
            </div>
          </div>
          {playable && <MediaInfo item={item} />}
          {isSeries && <ShowTools series={item} seasons={d.seasons} canEdit={d.canEdit} />}
          {d.changes.length > 0 && (
            <section className="card history">
              <h2><Icon name="history" /> Changes made here</h2>
              {d.changes.map((c) => (
                <div className="batch" key={c.id}>
                  <div>
                    <div>{ACTION_LABEL[c.action] ?? c.action}{c.action === "image" || c.action === "image_removed" ? ` (${c.target.split("|")[1]})` : ""}</div>
                    <div className="muted small">{new Date(c.at * 1000).toLocaleString()}</div>
                  </div>
                  <div className="spacer" />
                  {c.undone ? <span className="muted small">Undone</span> : (
                    <button disabled={!d.canEdit || !!busy} onClick={() => void run("Undoing…", () => api.undoChange(c.id), "Undone.")}>Undo</button>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      )}

      {shownTab === "episodes" && isSeries && <EpisodesView series={item} seasons={d.seasons} season={season} onSeason={setSeason} canEdit={d.canEdit} subLangs={subLangs} />}
      {shownTab === "art" && <ArtworkTab d={d} title={title} />}
      {shownTab === "subs" && (playable
        ? <SubtitlesTab id={id} canEdit={d.canEdit} subLangs={subLangs} />
        : isSeason
          ? <EpisodesTab id={id} canEdit={d.canEdit} subLangs={subLangs} onOpen={(x) => nav.open(x)} />
          : <SeasonPicker seasons={d.seasons} season={season} onSeason={setSeason}>{(s) => <EpisodesTab key={s} id={s} canEdit={d.canEdit} subLangs={subLangs} onOpen={(x) => nav.open(x)} />}</SeasonPicker>)}
      {shownTab === "intros" && (isSeries
        ? <ShowIntros seriesId={id} canEdit={d.canEdit} />
        : isSeason && <IntrosTab seasonId={id} seasonName={item.Name} canEdit={d.canEdit} onSettings={() => onNav("settings")} />)}
      {shownTab === "collection" && kind && <CollectionTab item={item} canEdit={d.canEdit} />}
    </div>
  );
}

/* --------------------------------------------------------- title health */

interface Chip {
  ok: boolean | null;
  label: string;
  go?: () => void;
}

/** Health of a show or movie that the chips, cards and Fix button share. */
function useTitleState(d: Details, kind: "series" | "movie") {
  const epoch = useEpoch();
  const itemEpoch = useItemEpoch(d.item.Id);
  const item = d.item;
  const [check, setCheck] = useState<CheckRow | null>(null);
  const [row, setRow] = useState<HealthRow | null>(null);
  const [seg, setSeg] = useState<SegSummary | null>(null);
  useEffect(() => {
    const clean = item.Id.replace(/-/g, "");
    api.namingCheckLast().then((r) => setCheck(r?.rows.find((x) => x.id === item.Id || x.id === clean) ?? null)).catch(() => setCheck(null));
    api.libraryHealth(false).then((h) => setRow(h.rows.find((x) => x.id === item.Id || x.id === clean) ?? null)).catch(() => setRow(null));
    if (kind === "series") api.segmentSummary(item.Id).then(setSeg).catch(() => setSeg(null));
  }, [item.Id, kind, epoch, itemEpoch]);
  const has = (k: ImageKind) => d.images.some((i) => i.ImageType === k);
  const identified = ["Tmdb", "Tvdb"].some((k) => !!item.ProviderIds?.[k]);
  const missingArt = CORE_ART.filter((a) => !has(a.kind) && !artSkipped(item.Id.replace(/-/g, "")).includes(a.kind));
  const streams = item.MediaSources?.[0]?.MediaStreams ?? item.MediaStreams ?? [];
  const noSubs = kind === "movie" ? (streams.some((m) => m.Type === "Subtitle") || subSkipped(item.Path) ? 0 : 1) : row ? noSubsOf(row) : 0;
  const target: FixTarget = { id: item.Id, name: cleanTitle(item.Name, item.ProductionYear), kind, identified, missingArt: missingArt.map((a) => a.kind), noSubs, check };
  return { check, row, seg, identified, missingArt, noSubs, target, has };
}

/**
 * What's right and what's missing for a show or movie, as chips on the picture, with Play
 * and "Fix N things" (artwork, subtitles and 100%-sure names, done for you; the rest opens
 * the right place).
 */
function TitleHealth({ d, kind, canEdit, subLangs, onTab, onIdentify }: { d: Details; kind: "series" | "movie"; canEdit: boolean; subLangs: string[]; onTab: (t: TabId) => void; onIdentify: () => void }) {
  const item = d.item;
  const st = useTitleState(d, kind);
  const { check, seg, identified, missingArt, noSubs, target, row } = st;
  const chips: Chip[] = [
    { ok: identified, label: identified ? "Identified" : "Not identified", go: onIdentify },
    { ok: missingArt.length === 0, label: missingArt.length ? `No ${missingArt.map((a) => a.label).join(", ")}` : "Artwork complete", go: () => onTab("art") },
    kind === "movie"
      ? { ok: noSubs === 0, label: noSubs ? "No subtitles" : "Subtitles", go: () => onTab("subs") }
      : { ok: row ? noSubs === 0 : null, label: row ? (noSubs ? `${noSubs} episode${noSubs === 1 ? "" : "s"} without subtitles` : "Subtitles") : "Subtitles not checked", go: () => onTab("subs") },
    { ok: check ? !namesToFix(check) : null, label: !check ? "Names not checked" : namesToFix(check) ? `${check.toRename + check.folders} name${check.toRename + check.folders === 1 ? "" : "s"} to fix` : "Names right", go: () => nav.route({ view: "renamer", item: item.Id }) },
  ];
  if (kind === "series" && seg && seg.episodes > 0) {
    chips.push({ ok: seg.intro >= seg.episodes * 0.8, label: seg.intro === 0 ? "No intro markers" : seg.intro >= seg.episodes ? "Intro markers" : `Intros in ${seg.intro} of ${seg.episodes}`, go: () => onTab("intros") });
  }
  const auto = safeFixes(target);
  const todo = chips.filter((c) => c.ok === false).length;

  async function fix() {
    // Pictures first: you see the options and pick (or take the recommended ones).
    if (auto.includes("art")) {
      const choice = await askArt(item.Id, target.name, target.missingArt);
      if (choice) {
        await track(`Artwork for ${target.name}`, async (job) => {
          const n = await applyArt(item.Id, choice);
          job.update(`${n} picture${n === 1 ? "" : "s"} added`, 1);
        }, { items: [item.Id] }).catch(() => undefined);
      }
    }
    const rest = auto.filter((k) => k !== "art");
    if (!rest.length) return;
    const plan = await askFixes(`Fix ${target.name}`, [target], rest);
    if (!plan) return;
    void track(`Fixing ${target.name}`, (job) => fixTitles(plan.list, plan.what, subLangs, job).then(() => undefined), { cancellable: true, items: [item.Id] }).catch(() => undefined);
  }

  return (
    <>
      <div className="cine-chips">
        {chips.map((c) => (
          <button key={c.label} className={`hchip ${c.ok === null ? "" : c.ok ? "ok" : "warn"}`} onClick={c.go}>
            {c.ok ? <Icon name="check" size={12} /> : c.ok === false ? <Icon name="warn" size={12} /> : null} {c.label}
          </button>
        ))}
      </div>
      <div className="row bb-actions">
        <button className="bb-play" onClick={() => (kind === "movie" ? nav.play(item.Id) : void playTitle(item.Id))}>
          <Icon name="play" size={20} /> {item.UserData?.PlaybackPositionTicks ? "Resume" : "Play"}
        </button>
        {auto.length > 0 && canEdit && (
          <button className="bb-more" onClick={() => void fix()} title={`Does it for you: ${auto.map((a) => (a === "art" ? "artwork" : a === "subs" ? "subtitles" : "100% sure names")).join(", ")}. Can be undone.`}>
            <Icon name="wrench" size={18} /> Fix {auto.length} thing{auto.length === 1 ? "" : "s"}
          </button>
        )}
        {todo > auto.length && <span className="muted small">{todo - auto.length} need{todo - auto.length === 1 ? "s" : ""} you: click the yellow chip</span>}
      </div>
    </>
  );
}

/** The Overview's at-a-glance cards: match, artwork, subtitles, intros, names. */
function StatusCards({ d, kind, onTab, onIdentify }: { d: Details; kind: "series" | "movie"; onTab: (t: TabId) => void; onIdentify: () => void }) {
  const item = d.item;
  const { check, seg, identified, noSubs, row, has } = useTitleState(d, kind);
  const ids = Object.entries(item.ProviderIds ?? {}).filter(([k, v]) => v && ["Tmdb", "Tvdb", "Imdb"].includes(k));
  const artKinds: ImageKind[] = ["Primary", "Backdrop", "Logo", "Thumb"];
  const artHave = artKinds.filter((k) => has(k)).length;
  const names = check ? check.toRename + check.folders : null;
  const card = (key: string, icon: IconName, title: string, ok: boolean | null, line: React.ReactNode, action: React.ReactNode) => (
    <div key={key} className={`stat-card ${ok === null ? "" : ok ? "ok" : "warn"}`}>
      <div className="stat-card-head"><span className="stat-ico"><Icon name={icon} size={16} /></span><span className="strong">{title}</span>{ok !== null && <Icon name={ok ? "check" : "warn"} size={14} />}</div>
      <div className="small muted stat-line">{line}</div>
      <div className="stat-act">{action}</div>
    </div>
  );
  return (
    <div className="stat-cards">
      {card("match", "search", "Match", identified, identified ? ids.map(([k, v]) => `${k} ${v}`).join(" · ") || "Identified" : "Not identified yet", <button className="link small" onClick={onIdentify}>{identified ? "Identify again…" : "Identify…"}</button>)}
      {card("art", "image", "Artwork", artHave === artKinds.length, (
        <span className="mini-art">
          {artKinds.map((k) => <span key={k} className={`mini-art-k ${has(k) ? "on" : ""}`} title={k}>{has(k) ? <img src={artSrc(item.Id, k, 120, d.images)} alt="" loading="lazy" /> : null}</span>)}
        </span>
      ), <button className="link small" onClick={() => onTab("art")}>{artHave === artKinds.length ? "Change…" : `${artKinds.length - artHave} missing · fix…`}</button>)}
      {card("subs", "subtitles", "Subtitles", kind === "series" && !row ? null : noSubs === 0, kind === "movie" ? (noSubs ? "None yet" : "There") : row ? (noSubs ? `${noSubs} of ${row.videos} episodes without` : `All ${row.videos} episodes`) : "Not checked yet", <button className="link small" onClick={() => onTab("subs")}>Open…</button>)}
      {kind === "series" && card("intros", "skip", "Intros & credits", seg ? seg.episodes > 0 && seg.intro >= seg.episodes * 0.8 : null, seg ? `Intro in ${seg.intro}, credits in ${seg.credits} of ${seg.episodes}` : "Not checked yet", <button className="link small" onClick={() => onTab("intros")}>Open…</button>)}
      {card("names", "rename", "File names", names === null ? null : names === 0, names === null ? "Not checked yet" : names ? `${names} to fix` : "Named right", <button className="link small" onClick={() => nav.route({ view: "renamer", item: item.Id })}>Open in the Renamer…</button>)}
    </div>
  );
}
/* ------------------------------------------------------------- media info */

function size(b?: number): string {
  if (!b) return "";
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

/** What Jellyfin knows about the file: streams, size, chapters (with their pictures). */
export function MediaInfo({ item }: { item: JfItem }) {
  const src = item.MediaSources?.[0];
  const streams = src?.MediaStreams ?? item.MediaStreams ?? [];
  const video = streams.find((s) => s.Type === "Video");
  const audio = streams.filter((s) => s.Type === "Audio");
  const subs = streams.filter((s) => s.Type === "Subtitle");
  const chapters = (item.Chapters ?? []).filter((c) => c.StartPositionTicks >= 0);
  if (!src && !streams.length) return null;
  const res = video?.Height ? (video.Height >= 2000 ? "4K" : video.Height >= 1000 ? "1080p" : video.Height >= 700 ? "720p" : `${video.Height}p`) : "";
  return (
    <section className="card form">
      <div className="section-head"><h2>File and streams</h2><span className="muted small mono ellipsis">{src?.Path ?? item.Path ?? ""}</span></div>
      <div className="chips">
        {src?.Container && <span className="chip static">{src.Container.toUpperCase()}</span>}
        {size(src?.Size) && <span className="chip static">{size(src?.Size)}</span>}
        {src?.Bitrate ? <span className="chip static">{(src.Bitrate / 1e6).toFixed(1)} Mb/s</span> : null}
        {video && <span className="chip static">{[res, video.Codec?.toUpperCase(), video.VideoRange && video.VideoRange !== "SDR" ? video.VideoRange : ""].filter(Boolean).join(" ")}</span>}
      </div>
      <div className="stream-cols">
        <div><div className="small strong">Audio</div>{audio.map((a, i) => <div key={i} className="small muted">{a.DisplayTitle ?? a.Language ?? "Audio"}</div>)}{!audio.length && <div className="small muted">None</div>}</div>
        <div><div className="small strong">Subtitles</div>{subs.map((x, i) => <div key={i} className="small muted">{x.DisplayTitle ?? x.Language ?? "Subtitle"}{x.IsExternal ? " · file" : " · built in"}</div>)}{!subs.length && <div className="small muted">None</div>}</div>
      </div>
      {chapters.length > 1 && (
        <>
          <div className="small strong">Chapters ({chapters.length})</div>
          <div className="chapters">
            {chapters.map((c, i) => (
              <div key={i} className="chapter">
                <div className="art wide cover">{c.ImageTag ? <img src={imageUrl(item.Id, "Chapter", 320, i, c.ImageTag)} alt="" loading="lazy" /> : <div className="noart small">{i + 1}</div>}</div>
                <div className="small ellipsis">{c.Name || `Chapter ${i + 1}`}</div>
                <div className="small muted mono">{fmtTicks(c.StartPositionTicks)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function fmtTicks(t: number): string {
  const s = Math.round(t / 10_000_000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------- artwork */

const OPTIONAL = ["Banner", "Art", "Disc"];

function ArtworkTab({ d, title }: { d: Details; title: string }) {
  const { item, images, canEdit } = d;
  const id = item.Id;
  const isEpisode = item.Type === "Episode";
  const isSeries = item.Type === "Series";
  const kinds = isEpisode ? ART_KINDS.filter((k) => k.kind === "Primary" || k.kind === "Thumb") : ART_KINDS;
  const [kind, setKind] = useState<ImageKind>(isEpisode ? "Primary" : "Backdrop");
  const [options, setOptions] = useState<RemoteImage[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [avail, setAvail] = useState<Record<string, number>>({});
  const info = ART_KINDS.find((k) => k.kind === kind)!;
  const have = (k: ImageKind) => images.filter((i) => i.ImageType === k);
  const missing = kinds.filter((k) => have(k.kind).length === 0 && !OPTIONAL.includes(k.kind));
  const current = have(kind).sort((a, b) => (a.ImageIndex ?? 0) - (b.ImageIndex ?? 0));

  useEffect(() => {
    setOptions(null);
    setShowAll(false);
    api.remoteImages(id, kind).then(setOptions).catch(() => setOptions([]));
  }, [id, kind]);
  // For each missing picture: how many can be found online (the cloud badge).
  const missingKey = missing.map((k) => k.kind).join(",");
  useEffect(() => {
    for (const k of missing) {
      api.remoteImages(id, k.kind).then((l) => setAvail((a) => ({ ...a, [k.kind]: l.filter((o) => o.Url).length }))).catch(() => undefined);
    }
  }, [id, missingKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(label: string, f: () => Promise<unknown>) {
    setSaving(label);
    setError(null);
    try {
      await track(label, async () => { await f(); }, { items: [id] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(null);
    }
  }

  // Paste a picture or a link anywhere on this tab: it becomes the chosen kind.
  const kindRef = useRef(kind);
  kindRef.current = kind;
  useEffect(() => {
    if (!canEdit) return;
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      void readPaste(e).then(async (p) => {
        if (!p) return;
        const k = kindRef.current;
        const label = ART_KINDS.find((a) => a.kind === k)?.label.toLowerCase() ?? "picture";
        if (!(await askConfirm(`Use the pasted ${p.data ? "picture" : "link"} as the ${label} of ${title}?`, { okLabel: "Use it" }))) return;
        void act(`Pasted ${label}`, () => (p.data ? api.uploadImageBytes(id, k, p.data, "pasted") : api.setImageFromLink(id, k, p.link!)));
      });
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [id, canEdit, title]); // eslint-disable-line react-hooks/exhaustive-deps

  async function cropInto(k: ImageKind) {
    const sources: CropSource[] = [];
    const seen = new Set<string>();
    const add = (label: string, src: string) => { if (!seen.has(src)) { seen.add(src); sources.push({ label, src }); } };
    for (const img of images) {
      if (img.ImageType === k || img.ImageType === "Logo" || !["Primary", "Backdrop", "Thumb", "Banner", "Art"].includes(img.ImageType)) continue;
      add(`${ART_KINDS.find((a) => a.kind === img.ImageType)?.label ?? img.ImageType} (now)`, artSrc(id, img.ImageType as ImageKind, 1920, images, img.ImageIndex ?? 0));
    }
    for (const x of (["Backdrop", "Primary", "Thumb"] as ImageKind[]).filter((x) => x !== k)) {
      const list = rankImages(await api.remoteImages(id, x).catch(() => []), x, "en").slice(0, 6);
      list.forEach((o) => o.Url && add(`${ART_KINDS.find((a) => a.kind === x)?.label} · ${o.ProviderName?.replace("TheMovieDb", "TMDB") ?? "online"}`, remoteImageUrl(o.Url)));
    }
    const data = await askCrop(title, k, sources);
    if (data) void act(`New ${ART_KINDS.find((a) => a.kind === k)?.label.toLowerCase()}`, () => api.uploadImageBytes(id, k, data, "cropped"));
  }

  function preview() {
    const urls: Partial<Record<ImageKind, string>> = {};
    for (const k of ART_KINDS) if (have(k.kind).length) urls[k.kind] = artSrc(id, k.kind, 1280, images);
    showPreview({ title, overview: item.Overview, meta: [item.ProductionYear, item.OfficialRating, (item.Genres ?? []).slice(0, 2).join(", ")].filter(Boolean).join(" · "), urls });
  }

  const opts = (options ?? []).filter((o) => o.Url);
  const shown = opts.slice(0, showAll ? 80 : 12);
  return (
    <div className="stack">
      <div className="row between art-bar">
        <div className="muted small">{missing.length ? `Missing: ${missing.map((k) => k.label).join(", ")}` : "Every picture Infuse uses is there."} Optional pictures are added by themselves when they can be found.</div>
        <div className="row end">
          {!isEpisode && <button onClick={preview}><Icon name="eye" /> Preview</button>}
          <button className="primary" disabled={!canEdit || !!saving || !missing.length} onClick={() => void askArt(id, title, missing.map((k) => k.kind)).then((c) => c && act(`Artwork for ${title}`, () => applyArt(id, c)))}><Icon name="wand" /> Fill in missing…</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="art-kinds">
        {kinds.map((k) => {
          const cur = have(k.kind);
          const isMissing = !cur.length && !OPTIONAL.includes(k.kind);
          const online = avail[k.kind] ?? 0;
          return (
            <button key={k.kind} className={`art-kind ${kind === k.kind ? "on" : ""} ${isMissing ? "missing" : ""}`} onClick={() => setKind(k.kind)}>
              <div className={`art ${k.wide ? "wide" : ""}`}>
                {cur.length ? <img src={artSrc(id, k.kind, 400, images)} alt="" loading="lazy" /> : <div className="noart small muted">{OPTIONAL.includes(k.kind) ? "Optional" : "Missing"}</div>}
                {isMissing && online > 0 && <span className="avail-badge" title={`${online} found online: click to pick one`}><Icon name="download" size={12} /> {online}</span>}
              </div>
              <span className="small strong">{k.label}{cur.length > 1 ? ` · ${cur.length}` : ""}{OPTIONAL.includes(k.kind) && <span className="muted thin"> · optional</span>}</span>
            </button>
          );
        })}
      </div>

      <section className="card form">
        <div className="section-head"><h2>{info.label}</h2><span className="muted small">{info.hint}</span></div>
        {current.length === 0 && <p className="muted small">None yet. Pick one below, cut one from another picture, upload one, or paste a picture or link here (⌘V).</p>}
        <div className={`art-current ${info.wide ? "wide" : ""}`}>
          {current.map((img) => {
            const idx = img.ImageIndex ?? 0;
            const src = artSrc(id, kind, 1600, images, idx);
            return (
              <div key={`${idx}-${img.ImageTag}`} className="art-have">
                <button className={`art ${info.wide ? "wide" : ""}`} onClick={() => showPicture(src, `${title} · ${info.label}${current.length > 1 ? ` ${idx + 1}` : ""}${img.Width ? ` · ${img.Width}×${img.Height}` : ""}`)} title="Show big">
                  <img src={artSrc(id, kind, 600, images, idx)} alt="" loading="lazy" />
                  <span className="expand"><Icon name="expand" size={14} /></span>
                  {kind === "Backdrop" && idx === 0 && current.length > 1 && <span className="flag ok">Main</span>}
                </button>
                <div className="row">
                  <span className="muted small grow">{img.Width ? `${img.Width}×${img.Height}` : ""}</span>
                  {kind === "Backdrop" && idx > 0 && <button className="mini-btn" disabled={!canEdit || !!saving} onClick={() => void act("Making it the main backdrop", () => api.mainBackdrop(id, idx))}>Make main</button>}
                  <button className="mini-btn danger-outline" disabled={!canEdit || !!saving} onClick={() => void askConfirm(`Remove this ${info.label.toLowerCase()}? A copy is kept so you can undo it.`, { okLabel: "Remove", danger: true }).then((ok) => { if (ok) void act(`Removing ${info.label.toLowerCase()}`, () => api.removeImage(id, kind, idx)); })}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="row art-add">
          <button disabled={!canEdit || !!saving} onClick={() => void act("Uploading picture", () => api.uploadImageFile(id, kind))}><Icon name="plus" /> Upload…</button>
          {kind !== "Logo" && <button disabled={!canEdit || !!saving} onClick={() => void cropInto(kind)}><Icon name="expand" /> Cut from another picture…</button>}
          <label className="link-paste grow">
            <input placeholder="…or paste a picture link (https://…)" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && link.trim()) void act("Picture from a link", () => api.setImageFromLink(id, kind, link.trim())).then(() => setLink("")); }} />
          </label>
          <button disabled={!canEdit || !!saving || !/^https:\/\//i.test(link.trim())} onClick={() => void act("Picture from a link", () => api.setImageFromLink(id, kind, link.trim())).then(() => setLink(""))}>Use link</button>
        </div>
      </section>

      <section className="card form">
        <div className="section-head">
          <h2>Options online</h2>
          <span className="muted small">{options === null ? "Looking…" : `${opts.length} found · click to use${kind === "Backdrop" ? " (becomes the main backdrop, the others stay)" : ""}`}</span>
        </div>
        {options === null && <div className="art-options skeleton-row">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className={`skeleton ${info.wide ? "wide" : ""}`} />)}</div>}
        {options && opts.length === 0 && (
          <p className="muted small">
            Nothing found for this kind.{" "}
            {OPTIONAL.includes(kind)
              ? "Banners, clear art and disc pictures come from Fanart.tv and TheTVDB. In Jellyfin: Dashboard → Plugins → Catalog → install “Fanart” (and “TheTVDB” for shows), then turn them on under the library's image fetchers."
              : "Check that the title is identified, cut one from another picture, or paste one."}
          </p>
        )}
        <div className={`art-options ${info.wide ? "wide" : ""}`}>
          {shown.map((o) => (
            <div key={o.Url} className="art-opt-wrap">
              <button className={`art-opt ${info.wide ? "wide" : ""}`} disabled={!canEdit || !!saving} onClick={() => void act(`Using new ${info.label.toLowerCase()}`, async () => { await api.setImage(id, kind, o.Url!); await fillOptional(id); })} title={`${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""} ${o.Language ?? ""}`}>
                <img src={remoteImageUrl(o.ThumbnailUrl || o.Url!)} alt="" loading="lazy" />
                <span className="src">{o.ProviderName?.replace("TheMovieDb", "TMDB").replace("TheTVDB", "TVDB") ?? ""}{o.Language ? ` · ${o.Language}` : ""}{o.Width ? ` · ${o.Width}` : ""}</span>
              </button>
              <button className="expand on-opt" aria-label="Show big" onClick={() => showPicture(remoteImageUrl(o.Url!), `${title} · ${info.label} · ${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""}`)}><Icon name="expand" size={14} /></button>
            </div>
          ))}
        </div>
        {opts.length > 12 && !showAll && <button className="link small" onClick={() => setShowAll(true)}>Show all {opts.length}</button>}
        {!canEdit && <p className="muted small">Picking pictures needs changes switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      </section>

      {isSeries && <SeasonArt seasons={d.seasons} canEdit={canEdit} />}
      {isSeries && <EpisodePictures series={item} seasons={d.seasons} canEdit={canEdit} />}
    </div>
  );
}

/** Season posters (S1, S2 …): what each season has, pick per season or fill them all. */
function SeasonArt({ seasons, canEdit }: { seasons: JfItem[]; canEdit: boolean }) {
  if (!seasons.length) return null;
  const pick = (s: JfItem) => void askArt(s.Id, cleanTitle(s.Name), ["Primary", "Backdrop", "Thumb"]).then((c) => c && track(`Artwork for ${s.Name}`, () => applyArt(s.Id, c).then(() => undefined), { items: [s.Id, s.SeriesId] }).catch(() => undefined));
  const fillAll = () => void track("Artwork for every season", async (job) => {
    for (const [i, s] of seasons.entries()) {
      if (job.cancelled) break;
      job.update(s.Name, i / seasons.length);
      await api.fillMissingArt(s.Id, ["Primary", "Backdrop", "Thumb", "Banner"]).catch(() => undefined);
    }
  }, { cancellable: true, items: seasons.map((s) => s.Id).concat(seasons[0]?.SeriesId ?? "") }).catch(() => undefined);
  return (
    <section className="card form">
      <div className="section-head">
        <h2><Icon name="stack" /> Season artwork</h2>
        <button disabled={!canEdit} onClick={fillAll}><Icon name="wand" /> Fill in for every season</button>
      </div>
      <div className="season-art">
        {seasons.map((s) => {
          const has = !!s.ImageTags?.Primary;
          return (
            <button key={s.Id} className={`season-art-card ${has ? "" : "missing"}`} disabled={!canEdit} onClick={() => pick(s)} title={has ? "Change" : "Missing: pick one"}>
              <div className="art">{has ? <img src={imageUrl(s.Id, "Primary", 240, 0, s.ImageTags!.Primary)} alt="" loading="lazy" /> : <div className="noart small">{cleanTitle(s.Name)}</div>}</div>
              <span className="small strong">{(s.IndexNumber ?? 0) === 0 ? "Specials" : `S${s.IndexNumber}`}</span>
              <span className="small muted">{has ? "Poster ✓" : "No poster"}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Episodes without a picture: TMDB stills first, a frame from the video when there's none. */
export async function fillEpisodePictures(name: string, eps: { id: string; name: string; seasonId: string }[], frames: boolean, lang = "en"): Promise<void> {
  await track(`Episode pictures for ${name}`, async (job) => {
    let tmdb = 0;
    const left = new Set<string>();
    for (const [i, e] of eps.entries()) {
      if (job.cancelled) break;
      job.update(`TMDB · ${e.name}`, (i / eps.length) * (frames ? 0.7 : 1));
      try {
        const best = rankImages(await api.remoteImages(e.id, "Primary"), "Primary", lang)[0];
        if (best?.Url) {
          await api.setImage(e.id, "Primary", best.Url);
          tmdb++;
          continue;
        }
      } catch {
        /* a frame instead */
      }
      left.add(e.seasonId);
    }
    let made = 0;
    if (frames && left.size && !job.cancelled) {
      for (const sid of left) made += await api.makeEpisodeStills(sid).catch(() => 0);
    }
    job.update(`${tmdb} from TMDB${frames ? `, ${made} from the video` : ""}`, 1);
  }, { cancellable: true, items: eps.map((e) => e.id) });
}

function EpisodePictures({ series, seasons, canEdit }: { series: JfItem; seasons: JfItem[]; canEdit: boolean }) {
  const itemEpoch = useItemEpoch(series.Id);
  const [eps, setEps] = useState<{ id: string; name: string; seasonId: string }[] | null>(null);
  const [frames, setFrames] = useState(true);
  useEffect(() => {
    let live = true;
    Promise.all(seasons.map((s) => api.children(s.Id).then((c) => c.filter((x) => x.Type === "Episode" && !x.ImageTags?.Primary).map((x) => ({ id: x.Id, name: `S${s.IndexNumber ?? 0}E${x.IndexNumber ?? "?"} ${x.Name}`, seasonId: s.Id }))).catch(() => [])))
      .then((all) => live && setEps(all.flat()))
      .catch(() => live && setEps([]));
    return () => { live = false; };
  }, [seasons, itemEpoch]);
  if (!eps || eps.length === 0) return null;
  return (
    <section className="card form">
      <div className="section-head">
        <h2><Icon name="image" /> Episode pictures</h2>
        <span className="muted small">{eps.length} episode{eps.length === 1 ? "" : "s"} without a picture</span>
      </div>
      <div className="row">
        <label className="check"><input type="checkbox" checked={frames} onChange={(e) => setFrames(e.target.checked)} />When TMDB has none, take a frame from the video (needs ffmpeg)</label>
        <div className="spacer" />
        <button className="primary" disabled={!canEdit} onClick={() => void fillEpisodePictures(cleanTitle(series.Name), eps, frames).then(() => reloadItems([series.Id])).catch(() => undefined)}><Icon name="wand" /> Get them</button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- seasons */

/** Whole-show tools on the Overview. */
function ShowTools({ series, seasons, canEdit }: { series: JfItem; seasons: JfItem[]; canEdit: boolean }) {
  const oneFolder = seasons.filter((s) => (s.IndexNumber ?? 0) > 0).length <= 1;
  return (
    <details className="more card form">
      <summary><Icon name="wrench" /> Whole-show tools</summary>
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={!canEdit} onClick={() => void track("Artwork for every season", async (job) => {
          for (const [i, s] of seasons.entries()) {
            if (job.cancelled) break;
            job.update(s.Name, i / seasons.length);
            await api.fillMissingArt(s.Id, ["Primary", "Backdrop", "Thumb", "Banner"]).catch(() => undefined);
          }
        }, { cancellable: true, items: [series.Id] }).catch(() => undefined)}>Fill in missing season artwork</button>
        {oneFolder && (
          <button disabled={!canEdit} title="For YouTube channels and other shows in one folder: numbers the videos 1, 2, 3 … by date in Jellyfin (files stay as they are), so Infuse doesn't show “0.”" onClick={() => void numberYouTube(series.Id, cleanTitle(series.Name)).catch(() => undefined)}>Number the videos by date</button>
        )}
      </div>
    </details>
  );
}

/** Seasons as a row of cards; the chosen one's episodes below. */
function EpisodesView({ series, seasons, season, onSeason, canEdit, subLangs }: { series: JfItem; seasons: JfItem[]; season: string | null; onSeason: (id: string) => void; canEdit: boolean; subLangs: string[] }) {
  const first = seasons.find((x) => (x.IndexNumber ?? 0) > 0) ?? seasons[0];
  const sel = seasons.find((s) => s.Id === season) ?? first;
  if (!seasons.length) return <p className="muted">No seasons yet.</p>;
  return (
    <div className="stack">
      {seasons.length > 1 && (
        <div className="season-strip">
          {seasons.map((s) => (
            <button key={s.Id} className={`season-card ${sel?.Id === s.Id ? "on" : ""}`} onClick={() => onSeason(s.Id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: s.Id, kind: "season", title: s.Name, seriesId: series.Id, played: s.UserData?.Played }, canEdit))}>
              <div className="art">
                {s.ImageTags?.Primary ? <img src={imageUrl(s.Id, "Primary", 300, 0, s.ImageTags.Primary)} alt="" loading="lazy" /> : <div className="noart">{s.Name}</div>}
                {s.UserData?.Played && <span className="played">✓</span>}
              </div>
              <div className="title small">{cleanTitle(s.Name)}</div>
              <div className="sub">{s.ChildCount ? `${s.ChildCount} episodes` : ""}</div>
            </button>
          ))}
        </div>
      )}
      {sel && <SeasonPanel key={sel.Id} season={sel} canEdit={canEdit} subLangs={subLangs} />}
    </div>
  );
}

/** A small row of season chips above a per-season tool (subtitles). */
function SeasonPicker({ seasons, season, onSeason, children }: { seasons: JfItem[]; season: string | null; onSeason: (id: string) => void; children: (seasonId: string) => React.ReactNode }) {
  const first = seasons.find((x) => (x.IndexNumber ?? 0) > 0) ?? seasons[0];
  const sel = seasons.find((s) => s.Id === season) ?? first;
  if (!sel) return <p className="muted">No seasons yet.</p>;
  return (
    <div className="stack">
      {seasons.length > 1 && (
        <div className="chips season-chips">
          {seasons.map((s) => <button key={s.Id} className={`chip ${s.Id === sel.Id ? "on" : ""}`} onClick={() => onSeason(s.Id)}>{(s.IndexNumber ?? 0) === 0 ? "Specials" : cleanTitle(s.Name)}</button>)}
        </div>
      )}
      {children(sel.Id)}
    </div>
  );
}

/** A season: its episodes, with subtitles per language. */
function SeasonPanel({ season, canEdit, subLangs }: { season: JfItem; canEdit: boolean; subLangs: string[] }) {
  const epoch = useEpoch();
  const itemEpoch = useItemEpoch(season.Id);
  const { recapsOff, subRequired } = usePrefs();
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [langs, setLangs] = useState<Culture[]>([]);
  useEffect(() => {
    api.children(season.Id).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch(() => setEps([]));
    cultures().then(setLangs).catch(() => setLangs([]));
  }, [season.Id, epoch, itemEpoch]);
  const want = useMemo(() => subLangs.map((l) => codesFor(l, langs)), [subLangs, langs]);

  const subsCell = (e: JfChild) => {
    const streams = (e.MediaStreams ?? []).filter((s) => s.Type === "Subtitle" && !s.IsForced);
    const have = (codes: string[]) => streams.some((s) => s.Language && codes.includes(s.Language.toLowerCase()));
    return subLangs.map((l, i) => {
      const ok = have(want[i] ?? [l]);
      const needed = subRequired.includes(l);
      return <span key={l} className={`chip static ${ok ? "on" : needed ? "need" : ""}`} title={ok ? "Has subtitles" : needed ? "Missing (needed)" : "Missing (only if available)"}>{languageName(l, langs).slice(0, 3)} {ok ? "✓" : "–"}</span>;
    });
  };

  return (
    <div className="stack">
      <div className="row">
        <button disabled={!canEdit} onClick={() => void track(`Artwork for ${season.Name}`, () => api.fillMissingArt(season.Id, ["Primary", "Backdrop", "Thumb", "Banner"]).then(() => undefined), { items: [season.Id, season.SeriesId] })}><Icon name="image" /> Fill in season artwork</button>
        {recapsOff && <span className="muted small">Recaps are off (Settings → Player)</span>}
      </div>
      <div className="ep-list">
        {eps === null && <div className="ep-skeleton">{[0, 1, 2].map((i) => <div key={i} className="skeleton ep" />)}</div>}
        {eps?.map((e) => {
          const pos = e.UserData?.PlaybackPositionTicks ?? 0;
          return (
            <div
              key={e.Id}
              className="ep-card"
              role="button"
              tabIndex={0}
              onClick={() => nav.open(e.Id)}
              onKeyDown={(k) => k.key === "Enter" && nav.open(e.Id)}
              onContextMenu={(ev) => openMenu(ev, itemMenu({ id: e.Id, kind: "episode", title: e.Name, seriesId: e.SeriesId ?? season.SeriesId, seasonId: season.Id, played: e.UserData?.Played }, canEdit))}
            >
              <div className="ep-thumb art wide cover" title="Play" onClick={(ev) => { ev.stopPropagation(); nav.play(e.Id); }}>
                {e.ImageTags?.Primary ? <img src={imageUrl(e.Id, "Primary", 400, 0, e.ImageTags.Primary)} alt="" loading="lazy" /> : <div className="noart small">E{e.IndexNumber ?? "?"}</div>}
                <button className="ep-play" aria-label="Play" onClick={(ev) => { ev.stopPropagation(); nav.play(e.Id); }}><Icon name="play" size={18} /></button>
                {pos > 0 && e.RunTimeTicks ? <span className="tile-progress"><span style={{ width: `${Math.min(100, (pos / e.RunTimeTicks) * 100)}%` }} /></span> : null}
              </div>
              <div className="ep-text">
                <div className="ep-title"><span className="muted">{e.IndexNumber ?? ""}.</span> {e.Name}</div>
                <div className="muted small">
                  {[e.PremiereDate ? new Date(e.PremiereDate).toLocaleDateString() : "", runtime(e.RunTimeTicks), e.UserData?.Played ? "Watched" : ""].filter(Boolean).join(" · ")}
                </div>
                {e.Overview && <div className="ep-overview small muted">{e.Overview}</div>}
                <div className="chips">{subsCell(e)}</div>
              </div>
            </div>
          );
        })}
        {eps && eps.length === 0 && <p className="muted small pad">No episodes.</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- collections */

/** The collections a title is in: open one, add it to another, take it out. */
function CollectionTab({ item, canEdit }: { item: JfItem; canEdit: boolean }) {
  const itemEpoch = useItemEpoch(item.Id);
  const [list, setList] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.collectionsOf(item.Id).then(setList).catch((e) => setError(errorText(e))), [item.Id]);
  useEffect(() => void load(), [load, itemEpoch]);

  async function add() {
    const all = await api.collections().catch(() => [] as Card[]);
    const have = new Set((list ?? []).map((c) => c.id));
    const r = await askChoice(`Add ${cleanTitle(item.Name)} to a collection`, all.filter((c) => !have.has(c.id)).map((c) => ({ value: c.id, label: c.title, hint: c.subtitle })), { label: "Or make a new one", placeholder: "e.g. Pixar, Christmas", okLabel: "Create" });
    if (!r) return;
    await track("Adding to collection", async () => {
      if ("value" in r) await api.collectionAdd(r.value, [item.Id]);
      else if (r.text.trim()) await api.collectionCreate(r.text.trim(), [item.Id]);
    }, { items: [item.Id] }).catch((e) => setError(errorText(e)));
    void load();
  }

  async function remove(c: Card) {
    if (!(await askConfirm(`Take ${cleanTitle(item.Name)} out of “${c.title}”?`, { okLabel: "Take out" }))) return;
    await track("Removing from collection", () => api.collectionRemove(c.id, [item.Id]), { items: [item.Id, c.id] }).catch((e) => setError(errorText(e)));
    void load();
  }

  return (
    <div className="stack">
      <div className="row between">
        <span className="muted small">{list === null ? "Looking…" : list.length ? `In ${list.length} collection${list.length === 1 ? "" : "s"}. Collections show up in Infuse too.` : "Not in a collection."}</span>
        <button className="primary" disabled={!canEdit} onClick={() => void add()}><Icon name="plus" /> Add to a collection…</button>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        {(list ?? []).map((c) => (
          <div key={c.id} className="coll-member">
            <CardTile c={c} canEdit={canEdit} onOpen={() => nav.open(c.id)} />
            {canEdit && <button className="mini-btn danger-outline" onClick={() => void remove(c)}>Take out</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** A collection's own page: the titles in it. */
function BoxSetTitles({ id, canEdit }: { id: string; canEdit: boolean }) {
  const epoch = useEpoch();
  const itemEpoch = useItemEpoch(id);
  const [items, setItems] = useState<Card[] | null>(null);
  useEffect(() => {
    api.collectionItems(id).then(setItems).catch(() => setItems([]));
  }, [id, epoch, itemEpoch]);
  async function addTitles() {
    const all = await api.list(null, "", "name", 0, 2000);
    const have = new Set((items ?? []).map((i) => i.id));
    const pick = await askChoice("Add a title", all.filter((i) => !have.has(i.id)).map((i) => ({ value: i.id, label: `${i.name}${i.year ? ` (${i.year})` : ""}`, hint: i.kind === "series" ? "Show" : "Movie" })));
    if (pick && "value" in pick) await track("Adding to collection", () => api.collectionAdd(id, [pick.value]), { items: [id, pick.value] }).catch(() => undefined);
  }
  return (
    <div className="stack">
      <div className="row between">
        <span className="muted small">{items ? `${items.length} title${items.length === 1 ? "" : "s"} · right-click one to take it out` : "Loading…"}</span>
        <button className="primary" disabled={!canEdit} onClick={() => void addTitles()}><Icon name="plus" /> Add a title…</button>
      </div>
      <div className="grid">
        {(items ?? []).map((c) => <CardTile key={c.id} c={c} canEdit={canEdit} inCollection={id} onOpen={() => nav.open(c.id)} />)}
      </div>
      {items && items.length === 0 && <p className="muted">Empty. Add titles here, or use the Collection tab of any movie or show.</p>}
    </div>
  );
}
