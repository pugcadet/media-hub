import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api, Card, CheckRow, cleanTitle, HealthRow, SegSummary, codesFor, cultures, Culture, Details, errorText, imageUrl, ImageKind, ItemEdits, JfChild, JfImage, JfItem,
  languageName, remoteImageUrl, RemoteImage, SearchResult, Status,
} from "./api";
import { SubtitlesTab, EpisodesTab } from "./Subtitles";
import { IntrosTab } from "./Intros";
import { listen } from "@tauri-apps/api/event";
import Renamer from "./Renamer";
import { askConfirm } from "./confirm";
import { track, useEpoch } from "./activity";
import { nav, type View } from "./nav";
import { Icon, itemMenu, openMenu, playTitle, Row, showPicture, SettingsLink } from "./ui";
import { usePrefs } from "./prefs";
import { CORE_ART, fixTitles, FixTarget, namesToFix, safeFixes } from "./fixers";

export const ART_KINDS: { kind: ImageKind; label: string; wide: boolean; hint: string }[] = [
  { kind: "Primary", label: "Poster", wide: false, hint: "The main picture in every app." },
  { kind: "Backdrop", label: "Backdrop", wide: true, hint: "Big picture behind the title. A title can have several; the first is the main one." },
  { kind: "Logo", label: "Logo", wide: true, hint: "The title as artwork, shown over the backdrop (Infuse uses it a lot)." },
  { kind: "Thumb", label: "Thumbnail", wide: true, hint: "Landscape picture used for rows like “Continue watching”." },
  { kind: "Banner", label: "Banner", wide: true, hint: "Wide strip. Mostly from TheTVDB or Fanart.tv." },
  { kind: "Art", label: "Clear art", wide: true, hint: "Characters with a see-through background (Fanart.tv)." },
  { kind: "Disc", label: "Disc", wide: false, hint: "Disc picture (Fanart.tv, movies)." },
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
  /** Inside another screen (Metadata and art): no back button, small header. */
  embedded?: boolean;
  /** Called with the details each time they load (the studio list updates its dots). */
  onLoaded?: (d: Details) => void;
}

export default function ItemPage({ id, initialTab, tabNonce, onBack, onNav, subLangs, status, embedded, onLoaded }: Props) {
  const epoch = useEpoch();
  const [d, setD] = useState<Details | null>(null);
  const [tab, setTab] = useState<string>(initialTab ?? "main");
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [logoOk, setLogoOk] = useState(true);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab, tabNonce]);

  const load = useCallback(async () => {
    try {
      const det = await api.details(id);
      setD(det);
      onLoaded?.(det);
      // Keep what you are typing when the page reloads in the background.
      if (!dirtyRef.current) setForm(toForm(det.item));
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void load(), [load, epoch]);

  async function run(label: string, f: () => Promise<void>, done: string) {
    setBusy(label);
    setMessage(null);
    try {
      await track(label.replace(/…$/, ""), f);
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
        <div className="item-top"><button onClick={onBack}>← Back</button></div>
        {message ? <p className="error">{message.text}</p> : <p className="muted">Loading…</p>}
      </div>
    );
  }

  const item = d.item;
  const isSeries = item.Type === "Series";
  const isSeason = item.Type === "Season";
  const isEpisode = item.Type === "Episode";
  const isMovie = item.Type === "Movie";
  const playable = isMovie || isEpisode;
  const kind: "series" | "movie" | null = isSeries ? "series" : isMovie ? "movie" : null;
  const season = isSeries ? d.seasons.find((s) => s.Id === tab) ?? null : null;
  const edits = diff(toForm(item), form);
  const dirty = Object.keys(edits).length > 0;
  dirtyRef.current = dirty;
  const heroId = (isEpisode || isSeason) && item.SeriesId ? item.SeriesId : id;
  const title = cleanTitle(item.Name, item.ProductionYear);
  const hasBackdrop = isEpisode || isSeason ? true : d.images.some((i) => i.ImageType === "Backdrop");
  const meta = [
    isEpisode && item.ParentIndexNumber != null ? `S${item.ParentIndexNumber} · E${item.IndexNumber ?? "?"}` : "",
    item.ProductionYear ? String(item.ProductionYear) : "",
    item.OfficialRating ?? "",
    runtime(item.RunTimeTicks),
    isSeries && d.seasons.length ? `${d.seasons.length} season${d.seasons.length === 1 ? "" : "s"}` : "",
    (item.Genres ?? []).slice(0, 3).join(", "),
  ].filter(Boolean);

  const tabs: [string, string][] = [["main", isSeason ? "Season" : "Details"]];
  if (isSeries) d.seasons.forEach((s) => tabs.push([s.Id, cleanTitle(s.Name)]));
  if (isSeason) tabs.push(["season", "Episodes"], ["intros", "Intros & credits"]);
  if (playable) tabs.push(["subs", "Subtitles"]);
  tabs.push(["art", "Artwork"]);
  if (!isSeason) tabs.push(["cast", isEpisode ? "Cast" : "Cast & more like this"]);
  if (kind) tabs.push(["rename", "Rename files"], ["identify", "Identify"]);

  const save = () => void run("Saving…", () => api.saveMetadata(id, edits), "Saved.");
  const crumb = (label: string, to: () => void) => <button className="link" onClick={to}>{label}</button>;

  return (
    <div className={`pg item ${embedded ? "embedded" : ""}`}>
      <section className={`cine ${hasBackdrop ? "" : "flat"} ${tab === "main" && !embedded ? "" : "compact"}`} onContextMenu={(e) => openMenu(e, itemMenu({ id, kind: item.Type, title, seriesId: item.SeriesId, seasonId: item.SeasonId, played: item.UserData?.Played }, d.canEdit))}>
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
          <button className="cine-ghost" title="Show in Finder" onClick={() => void api.revealItem(id).catch((e) => setMessage({ text: errorText(e), error: true }))}><Icon name="folder" /> Finder</button>
          {d.canEdit && (
            <button className="cine-ghost" disabled={!!busy} title="Fetch details and pictures again (unlocks the title)" onClick={() => void run("Refreshing…", () => api.refreshItem(id, false), "Jellyfin is refreshing this item from the internet; this page updates by itself.")}><Icon name="reload" /> Refresh</button>
          )}
          <button className="cine-ghost icon-only" aria-label="More" onClick={(e) => openMenu(e, itemMenu({ id, kind: item.Type, title, seriesId: item.SeriesId, seasonId: item.SeasonId, played: item.UserData?.Played }, d.canEdit))}><Icon name="more" /></button>
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
            {item.Overview && <p className="cine-overview">{item.Overview}</p>}
            {kind && <TitleHealth d={d} kind={kind} canEdit={d.canEdit} subLangs={subLangs} onTab={setTab} />}
            {!kind && (
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

      <div className="tabs">
        {tabs.map(([t, label]) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>)}
      </div>

      {tab === "main" && (
        <div className="stack">
          {isSeason && <SeasonPanel season={item} canEdit={d.canEdit} subLangs={subLangs} onNav={onNav} />}
          {!isSeason && (
            <div className="card form">
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
                  {!isEpisode && <label>TMDB id<input className="mono" value={form.tmdb} onChange={(e) => setForm({ ...form, tmdb: e.target.value.trim() })} /></label>}
                  {!isEpisode && <label>TVDB id<input className="mono" value={form.tvdb} onChange={(e) => setForm({ ...form, tvdb: e.target.value.trim() })} /></label>}
                  {!isEpisode && <label>IMDb id<input className="mono" value={form.imdb} onChange={(e) => setForm({ ...form, imdb: e.target.value.trim() })} /></label>}
                </div>
                <label className="check"><input type="checkbox" checked={form.lock} onChange={(e) => setForm({ ...form, lock: e.target.checked })} />Lock these details (Jellyfin will not overwrite them)</label>
              </details>
              <div className="row end">
                {kind && <button onClick={() => setTab("identify")}>Identify again…</button>}
                {dirty && <button onClick={() => setForm(toForm(item))}>Reset</button>}
                <button className="primary" disabled={!dirty || !d.canEdit || !!busy} onClick={save}>{busy === "Saving…" ? "Saving…" : "Save"}</button>
              </div>
            </div>
          )}
          {playable && <MediaInfo item={item} />}
          {isSeries && d.seasons.length > 0 && (
            <div className="season-strip">
              {d.seasons.map((s) => (
                <button key={s.Id} className="season-card" onClick={() => setTab(s.Id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: s.Id, kind: "season", title: s.Name, seriesId: id, played: s.UserData?.Played }, d.canEdit))}>
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
          {isSeries && <ShowTools seriesId={id} seasons={d.seasons} canEdit={d.canEdit} />}
          {d.changes.length > 0 && (
            <section className="card history">
              <h2>Changes made here</h2>
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

      {season && <SeasonPanel key={season.Id} season={season} canEdit={d.canEdit} subLangs={subLangs} onNav={onNav} />}
      {isSeason && tab === "season" && <SeasonPanel season={item} canEdit={d.canEdit} subLangs={subLangs} onNav={onNav} />}
      {isSeason && tab === "intros" && <IntrosTab seasonId={id} seasonName={item.Name} canEdit={d.canEdit} onSettings={() => onNav("settings")} />}
      {tab === "subs" && <SubtitlesTab id={id} canEdit={d.canEdit} subLangs={subLangs} />}
      {tab === "art" && <ArtworkTab id={id} title={title} images={d.images} canEdit={d.canEdit} isEpisode={isEpisode} />}
      {tab === "cast" && <CastTab item={item} canEdit={d.canEdit} />}
      {tab === "rename" && kind && <Renamer status={status} onChanged={() => undefined} onNav={onNav} embedded start={{ item: id }} />}
      {tab === "identify" && kind && (
        <IdentifyTab item={item} kind={kind} canEdit={d.canEdit} busy={!!busy}
          onApply={(r, replace, fill) => void run("Linking the match…", async () => {
            await api.identifyApply(id, r, replace);
            if (fill) await api.fillMissingArt(id, ART_KINDS.map((k) => k.kind)).catch(() => undefined);
            setTab("main");
          }, fill ? "Linked. The details and artwork are updated." : "Linked. The details are updated.")} />
      )}
    </div>
  );
}

/* --------------------------------------------------------- title health */

interface Chip {
  ok: boolean | null;
  label: string;
  go?: () => void;
}

/**
 * What's right and what's missing for a show or movie, as chips on the picture, with Play
 * and "Fix N things" (artwork, subtitles and 100%-sure names, done for you; the rest opens
 * the right tab).
 */
function TitleHealth({ d, kind, canEdit, subLangs, onTab }: { d: Details; kind: "series" | "movie"; canEdit: boolean; subLangs: string[]; onTab: (t: string) => void }) {
  const epoch = useEpoch();
  const item = d.item;
  const [check, setCheck] = useState<CheckRow | null>(null);
  const [row, setRow] = useState<HealthRow | null>(null);
  const [seg, setSeg] = useState<SegSummary | null>(null);
  useEffect(() => {
    api.namingCheckLast().then((r) => setCheck(r?.rows.find((x) => x.id === item.Id) ?? null)).catch(() => setCheck(null));
    api.libraryHealth(false).then((h) => setRow(h.rows.find((x) => x.id === item.Id) ?? null)).catch(() => setRow(null));
    if (kind === "series") api.segmentSummary(item.Id).then(setSeg).catch(() => setSeg(null));
  }, [item.Id, kind, epoch]);

  const has = (k: ImageKind) => d.images.some((i) => i.ImageType === k);
  const identified = ["Tmdb", "Tvdb", "Imdb"].some((k) => !!item.ProviderIds?.[k]);
  const missingArt = CORE_ART.filter((a) => !has(a.kind));
  const streams = item.MediaSources?.[0]?.MediaStreams ?? item.MediaStreams ?? [];
  const noSubs = kind === "movie" ? (streams.some((m) => m.Type === "Subtitle") ? 0 : 1) : row?.noSubs ?? 0;
  const firstSeason = d.seasons.find((x) => (x.IndexNumber ?? 0) > 0) ?? d.seasons[0];
  const chips: Chip[] = [
    { ok: identified, label: identified ? "Identified" : "Not identified", go: () => onTab("identify") },
    { ok: missingArt.length === 0, label: missingArt.length ? `No ${missingArt.map((a) => a.label).join(", ")}` : "Artwork complete", go: () => onTab("art") },
    kind === "movie"
      ? { ok: noSubs === 0, label: noSubs ? "No subtitles" : "Subtitles", go: () => onTab("subs") }
      : { ok: row ? noSubs === 0 : null, label: row ? (noSubs ? `${noSubs} episode${noSubs === 1 ? "" : "s"} without subtitles` : "Subtitles") : "Subtitles not checked", go: () => firstSeason && onTab(firstSeason.Id) },
    { ok: check ? !namesToFix(check) : null, label: !check ? "Names not checked" : namesToFix(check) ? `${check.toRename + check.folders} name${check.toRename + check.folders === 1 ? "" : "s"} to fix` : "Names right", go: () => onTab("rename") },
  ];
  if (kind === "series" && seg && seg.episodes > 0) {
    chips.push({ ok: seg.intro >= seg.episodes * 0.8, label: seg.intro === 0 ? "No intro markers" : seg.intro >= seg.episodes ? "Intro markers" : `Intros in ${seg.intro} of ${seg.episodes}`, go: () => firstSeason && onTab(firstSeason.Id) });
  }
  const target: FixTarget = { id: item.Id, name: cleanTitle(item.Name, item.ProductionYear), kind, identified, missingArt: missingArt.map((a) => a.kind), noSubs, check };
  const auto = safeFixes(target);
  const todo = chips.filter((c) => c.ok === false).length;

  function fix() {
    void track(`Fixing ${target.name}`, (job) => fixTitles([target], auto, subLangs, job).then(() => undefined), { cancellable: true }).catch(() => undefined);
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
          <button className="bb-more" onClick={fix} title={`Does it for you: ${auto.map((a) => (a === "art" ? "artwork" : a === "subs" ? "subtitles" : "100% sure names")).join(", ")}. Can be undone.`}>
            <Icon name="wand" size={18} /> Fix {auto.length} thing{auto.length === 1 ? "" : "s"}
          </button>
        )}
        {todo > auto.length && <span className="muted small">{todo - auto.length} need{todo - auto.length === 1 ? "s" : ""} you: click the yellow chip</span>}
      </div>
    </>
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

function ArtworkTab({ id, title, images, canEdit, isEpisode }: { id: string; title: string; images: JfImage[]; canEdit: boolean; isEpisode: boolean }) {
  const kinds = isEpisode ? ART_KINDS.filter((k) => k.kind === "Primary" || k.kind === "Thumb") : ART_KINDS;
  const [kind, setKind] = useState<ImageKind>(isEpisode ? "Primary" : "Backdrop");
  const [options, setOptions] = useState<RemoteImage[] | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const info = ART_KINDS.find((k) => k.kind === kind)!;
  const have = (k: ImageKind) => images.filter((i) => i.ImageType === k);
  const missing = kinds.filter((k) => have(k.kind).length === 0);
  const current = have(kind).sort((a, b) => (a.ImageIndex ?? 0) - (b.ImageIndex ?? 0));

  useEffect(() => {
    setOptions(null);
    setShowAll(false);
    api.remoteImages(id, kind).then(setOptions).catch(() => setOptions([]));
  }, [id, kind]);

  async function act(label: string, f: () => Promise<unknown>) {
    setSaving(label);
    setError(null);
    try {
      await track(label, async () => { await f(); });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(null);
    }
  }

  const opts = (options ?? []).filter((o) => o.Url);
  const shown = opts.slice(0, showAll ? 80 : 12);
  return (
    <div className="stack">
      <div className="row between">
        <div className="muted small">{missing.length ? `Missing: ${missing.map((k) => k.label).join(", ")}` : "Every kind of artwork is there."}</div>
        <div className="row end">
          <button disabled={!canEdit || !!saving || !missing.length} onClick={() => void act(`Filling in artwork for ${title}`, () => api.fillMissingArt(id, missing.map((k) => k.kind)))}>Fill in missing artwork</button>
          <button disabled={!canEdit || !!saving} onClick={() => void act("Uploading picture", () => api.uploadImageFile(id, kind))}>Upload {info.label.toLowerCase()}…</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="art-kinds">
        {kinds.map((k) => {
          const cur = have(k.kind);
          return (
            <button key={k.kind} className={`art-kind ${kind === k.kind ? "on" : ""}`} onClick={() => setKind(k.kind)}>
              <div className={`art ${k.wide ? "wide" : ""}`}>
                {cur.length ? <img src={artSrc(id, k.kind, 400, images)} alt="" loading="lazy" /> : <div className="noart small muted">Missing</div>}
              </div>
              <span className="small strong">{k.label}{cur.length > 1 ? ` · ${cur.length}` : ""}</span>
            </button>
          );
        })}
      </div>

      <section className="card form">
        <div className="section-head"><h2>{info.label}</h2><span className="muted small">{info.hint}</span></div>
        {current.length === 0 && <p className="muted small">None yet. Pick one below, upload one, or use “Fill in missing artwork”.</p>}
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
                  {kind === "Backdrop" && idx > 0 && <button className="small-btn show" disabled={!canEdit || !!saving} onClick={() => void act("Making it the main backdrop", () => api.mainBackdrop(id, idx))}>Make main</button>}
                  <button className="small-btn show danger-outline" disabled={!canEdit || !!saving} onClick={() => void askConfirm(`Remove this ${info.label.toLowerCase()}? A copy is kept so you can undo it.`, { okLabel: "Remove", danger: true }).then((ok) => { if (ok) void act(`Removing ${info.label.toLowerCase()}`, () => api.removeImage(id, kind, idx)); })}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card form">
        <div className="section-head">
          <h2>Options online</h2>
          <span className="muted small">{options === null ? "Looking…" : `${opts.length} found · click to use${kind === "Backdrop" ? " (becomes the main backdrop, the others stay)" : ""}`}</span>
        </div>
        {options && opts.length === 0 && (
          <p className="muted small">
            Nothing found for this kind.{" "}
            {kind === "Banner" || kind === "Art" || kind === "Disc"
              ? "Banners, clear art and disc pictures come from Fanart.tv and TheTVDB. In Jellyfin: Dashboard → Plugins → Catalog → install “Fanart” (and “TheTVDB” for shows), then turn them on under the library's image fetchers."
              : "Check that the title is identified (Identify tab), or upload a picture."}
          </p>
        )}
        <div className={`art-options ${info.wide ? "wide" : ""}`}>
          {shown.map((o) => (
            <div key={o.Url} className="art-opt-wrap">
              <button className={`art-opt ${info.wide ? "wide" : ""}`} disabled={!canEdit || !!saving} onClick={() => void act(`Using new ${info.label.toLowerCase()}`, () => api.setImage(id, kind, o.Url!))} title={`${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""} ${o.Language ?? ""}`}>
                <img src={remoteImageUrl(o.ThumbnailUrl || o.Url!)} alt="" loading="lazy" />
                <span className="src">{o.ProviderName?.replace("TheMovieDb", "TMDB").replace("TheTVDB", "TVDB") ?? ""}{o.Language ? ` · ${o.Language}` : ""}{o.Width ? ` · ${o.Width}` : ""}</span>
              </button>
              <button className="expand on-opt" aria-label="Show big" onClick={() => showPicture(remoteImageUrl(o.Url!), `${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""}`)}><Icon name="expand" size={14} /></button>
            </div>
          ))}
        </div>
        {opts.length > 12 && !showAll && <button className="link small" onClick={() => setShowAll(true)}>Show all {opts.length}</button>}
        {!canEdit && <p className="muted small">Picking pictures needs changes switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------- cast */

function CastTab({ item, canEdit }: { item: JfItem; canEdit: boolean }) {
  const [similar, setSimilar] = useState<Card[]>([]);
  const [person, setPerson] = useState<{ id: string; name: string } | null>(null);
  const [personItems, setPersonItems] = useState<Card[] | null>(null);
  const people = (item.People ?? []).filter((p) => p.Type === "Actor" || p.Type === "GuestStar" || !p.Type).slice(0, 40);
  const crew = (item.People ?? []).filter((p) => p.Type === "Director" || p.Type === "Writer" || p.Type === "Producer").slice(0, 8);
  useEffect(() => {
    if (item.Type !== "Episode") api.similar(item.Id).then(setSimilar).catch(() => setSimilar([]));
  }, [item.Id, item.Type]);
  useEffect(() => {
    setPersonItems(null);
    if (person) api.personItems(person.id).then(setPersonItems).catch(() => setPersonItems([]));
  }, [person]);
  return (
    <div className="stack">
      {crew.length > 0 && <div className="muted small">{crew.map((p) => `${p.Type}: ${p.Name}`).join(" · ")}</div>}
      {people.length === 0 && <p className="muted">No cast listed. Refresh from the internet or identify the title.</p>}
      <div className="cast">
        {people.map((p) => (
          <button key={`${p.Id}-${p.Role}`} className={`person ${person?.id === p.Id ? "on" : ""}`} onClick={() => setPerson(person?.id === p.Id ? null : { id: p.Id, name: p.Name })}>
            <div className="face">{p.PrimaryImageTag ? <img src={imageUrl(p.Id.replace(/-/g, ""), "Primary", 200, 0, p.PrimaryImageTag)} alt="" loading="lazy" /> : <span>{p.Name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>}</div>
            <div className="small strong ellipsis">{p.Name}</div>
            <div className="small muted ellipsis">{p.Role}</div>
          </button>
        ))}
      </div>
      {person && (
        <Row title={`More with ${person.name}`} cards={(personItems ?? []).filter((c) => c.id !== item.Id)} canEdit={canEdit} />
      )}
      {person && personItems && personItems.filter((c) => c.id !== item.Id).length === 0 && <p className="muted small">Nothing else with {person.name} in your library.</p>}
      <Row title="More like this" cards={similar} canEdit={canEdit} />
    </div>
  );
}

/* --------------------------------------------------------------- seasons */

/** Whole-show tools: artwork for every season, stills for episodes without one. */
function ShowTools({ seriesId, seasons, canEdit }: { seriesId: string; seasons: JfItem[]; canEdit: boolean }) {
  return (
    <details className="more">
      <summary>Whole-show tools</summary>
      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={!canEdit} onClick={() => void track("Artwork for every season", async (job) => {
          for (const [i, s] of seasons.entries()) {
            if (job.cancelled) break;
            job.update(s.Name, i / seasons.length);
            await api.fillMissingArt(s.Id, ["Primary", "Backdrop", "Thumb", "Banner"]).catch(() => undefined);
          }
        }, { cancellable: true }).catch(() => undefined)}>Fill in missing season artwork</button>
        <button disabled={!canEdit} title="Takes a frame from the video for every episode without a picture (needs ffmpeg)" onClick={() => void stills(seriesId)}>Make episode stills from the video</button>
        <span className="muted small">Removing recaps, intros or credits for the whole show: Intros and credits → this show.</span>
      </div>
    </details>
  );
}

/** Stills for episodes without a picture, with progress in the top bar. */
async function stills(parentId: string) {
  await track("Episode stills from the video", async (job) => {
    const un = await listen<{ done: number; total: number; label?: string }>("bulk-progress", (e) => job.update(e.payload.label ?? "", e.payload.total ? e.payload.done / e.payload.total : null));
    try {
      const n = await api.makeEpisodeStills(parentId);
      job.update(n ? `${n} stills added` : "Every episode already has a picture", 1);
    } finally {
      un();
    }
  }, { stop: "bulk" }).catch(() => undefined);
}

/** A season: subtitle and intro tools on top, then the episodes. */
function SeasonPanel({ season, canEdit, subLangs, onNav }: { season: JfItem; canEdit: boolean; subLangs: string[]; onNav: (v: View) => void }) {
  const epoch = useEpoch();
  const { recapsOff, subRequired } = usePrefs();
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [langs, setLangs] = useState<Culture[]>([]);
  const [tool, setTool] = useState<"none" | "subs" | "intros">("none");
  useEffect(() => {
    api.children(season.Id).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch(() => setEps([]));
    cultures().then(setLangs).catch(() => setLangs([]));
  }, [season.Id, epoch]);
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
        <button className={tool === "subs" ? "primary" : ""} onClick={() => setTool(tool === "subs" ? "none" : "subs")}>Get missing subtitles…</button>
        <button className={tool === "intros" ? "primary" : ""} onClick={() => setTool(tool === "intros" ? "none" : "intros")}>Intros and credits…</button>
        <button disabled={!canEdit} onClick={() => void track(`Artwork for ${season.Name}`, () => api.fillMissingArt(season.Id, ["Primary", "Backdrop", "Thumb", "Banner"]).then(() => undefined))}>Fill in season artwork</button>
        <button disabled={!canEdit} title="Takes a frame from the video for every episode without a picture (needs ffmpeg)" onClick={() => void stills(season.Id)}>Make episode stills</button>
        {recapsOff && <span className="muted small">Recaps are off (Settings → Player)</span>}
      </div>
      {tool === "subs" && <EpisodesTab id={season.Id} canEdit={canEdit} subLangs={subLangs} onOpen={(id) => nav.open(id)} />}
      {tool === "intros" && <IntrosTab seasonId={season.Id} seasonName={season.Name} canEdit={canEdit} onSettings={() => onNav("settings")} />}

      <div className="ep-list">
        {eps === null && <p className="muted small pad">Loading episodes…</p>}
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

/* --------------------------------------------------------------- identify */

function IdentifyTab({ item, kind, canEdit, busy, onApply }: {
  item: JfItem; kind: "series" | "movie"; canEdit: boolean; busy: boolean;
  onApply: (r: SearchResult, replaceImages: boolean, fillArt: boolean) => void;
}) {
  const [name, setName] = useState(cleanTitle(item.Name, item.ProductionYear));
  const [year, setYear] = useState(item.ProductionYear ? String(item.ProductionYear) : "");
  const [idType, setIdType] = useState("tmdb");
  const [idValue, setIdValue] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [replaceImages, setReplaceImages] = useState(true);
  const [fillArt, setFillArt] = useState(true);

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

  useEffect(() => { void search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card form">
      <p className="muted small">Matches come from the providers set up in Jellyfin (TMDB, TVDB, …). Pick the right one; the title then leaves the “unmatched” list.</p>
      <div className="row">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void search()} /></label>
        <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
        <label className="narrow">Id type
          <select value={idType} onChange={(e) => setIdType(e.target.value)}>
            <option value="tmdb">TMDB</option><option value="tvdb">TVDB</option><option value="imdb">IMDb</option>
          </select>
        </label>
        <label>Id (optional)<input className="mono" value={idValue} onChange={(e) => setIdValue(e.target.value)} /></label>
        <button className="primary" disabled={searching} onClick={() => void search()}>{searching ? "Searching…" : "Search"}</button>
      </div>
      <label className="check"><input type="checkbox" checked={replaceImages} onChange={(e) => setReplaceImages(e.target.checked)} />Update the artwork to the match's artwork</label>
      <label className="check"><input type="checkbox" checked={fillArt} onChange={(e) => setFillArt(e.target.checked)} />Then fill in any artwork that's still missing (logo, banner, …)</label>
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
              <button className={i === 0 ? "primary" : ""} disabled={!canEdit || busy} onClick={() => {
                void askConfirm(`Use “${r.Name}” for this ${kind === "series" ? "show" : "movie"}? You can undo this afterwards.`, { okLabel: "Use it" }).then((ok) => { if (ok) void onApply(r, replaceImages, fillArt); });
              }}>This is it</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
