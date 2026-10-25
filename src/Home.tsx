import { useEffect, useState, type ReactNode } from "react";
import { Alert, api, Card, cleanTitle, HomeFeed, imageUrl, Item, localDate, Pick, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { CardTile, Icon, itemMenu, openMenu, playTitle, Row, scanLibrary, SettingsLink } from "./ui";
import { prefs, setPrefs, usePrefs } from "./prefs";
import { syncPicks } from "./scheduler";
import { getPicks, PicksEditor } from "./Picks";
import { askConfirm } from "./confirm";

export function itemToCard(i: Item): Card {
  const sub = i.kind === "series"
    ? [i.year, i.seasons ? `${i.seasons} season${i.seasons === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
    : [i.year, i.runtime ? `${Math.round(i.runtime)} min` : ""].filter(Boolean).join(" · ");
  return { id: i.id, kind: i.kind, title: cleanTitle(i.name, i.year), subtitle: sub, artId: i.id, seriesId: null, year: i.year, progress: null, played: i.played, hasPoster: i.hasPoster };
}

/**
 * Jellyfin has no "hide from Next Up". It does leave a show out once its very last episode
 * is marked watched, so that's what this does (and remembers, to undo it later).
 */
async function hideInJellyfin(seriesIds: string[]): Promise<void> {
  const marks = { ...prefs().nextUpMarks };
  for (const sid of seriesIds) {
    if (marks[sid]) continue;
    const d = await api.details(sid).catch(() => null);
    const seasons = (d?.seasons ?? []).filter((x) => (x.IndexNumber ?? 0) > 0).sort((a, b) => (b.IndexNumber ?? 0) - (a.IndexNumber ?? 0));
    if (!seasons[0]) continue;
    const eps = (await api.children(seasons[0].Id).catch(() => [])).filter((e) => e.Type === "Episode").sort((a, b) => (b.IndexNumber ?? 0) - (a.IndexNumber ?? 0));
    const last = eps[0];
    if (!last || last.UserData?.Played) continue;
    await api.setPlayed(last.Id, true);
    marks[sid] = last.Id;
  }
  setPrefs({ nextUpMarks: marks });
}

async function unhideInJellyfin(): Promise<void> {
  for (const ep of Object.values(prefs().nextUpMarks)) await api.setPlayed(ep, false).catch(() => undefined);
  setPrefs({ nextUpMarks: {} });
}

/** Today's featured title from a list (same all day): something good you haven't seen. */
export function featured(items: Item[], why: string): Pick | null {
  const pool = items.filter((i) => i.hasPoster && !i.played && (i.rating ?? 0) >= 6.5);
  const list = pool.length ? pool : items.filter((i) => i.hasPoster);
  if (!list.length) return null;
  const day = Math.floor(Date.now() / 86_400_000);
  const it = list[(day * 7919 + list.length) % list.length];
  const meta = [it.year, it.kind === "series" ? (it.seasons ? `${it.seasons} season${it.seasons === 1 ? "" : "s"}` : "Show") : it.runtime ? `${Math.round(it.runtime)} min` : "Movie", it.rating ? `★ ${it.rating.toFixed(1)}` : ""].filter(Boolean).join(" · ");
  return { id: it.id, artId: it.id, title: cleanTitle(it.name, it.year), why, meta };
}

/** The big picture at the top: one of today's picks, with its logo when there is one. */
export function Billboard({ pick, onPlay, full, children }: { pick: Pick; onPlay?: () => void; full?: boolean; children?: ReactNode }) {
  const [logo, setLogo] = useState(true);
  const [overview, setOverview] = useState<string | null>(null);
  useEffect(() => {
    setLogo(true);
    setOverview(null);
    let live = true;
    api.details(pick.id).then((d) => live && setOverview(d.item.Overview ?? null)).catch(() => undefined);
    return () => { live = false; };
  }, [pick.id, pick.artId]);
  return (
    <section className={`billboard ${full ? "full" : ""}`} onContextMenu={(e) => openMenu(e, itemMenu({ id: pick.id, kind: "other", title: pick.title }))}>
      <img key={pick.artId} className="bb-art" src={imageUrl(pick.artId, "Backdrop", 1920)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
      <div className="bb-shade" />
      <div className="bb-text" key={pick.id}>
        <div className="bb-why">{pick.why}</div>
        {logo ? (
          <img className="bb-logo" src={imageUrl(pick.artId, "Logo", 700)} alt={pick.title} onError={() => setLogo(false)} />
        ) : (
          <div className="bb-title">{pick.title}</div>
        )}
        <div className="bb-meta">{pick.meta}</div>
        {overview && <p className="bb-overview">{overview}</p>}
        <div className="row bb-actions">
          {onPlay && <button className="bb-play" onClick={onPlay}><Icon name="play" size={20} /> Play</button>}
          <button className="bb-more" onClick={() => nav.open(pick.id)}><Icon name="info" size={20} /> More info</button>
        </div>
      </div>
      {children}
    </section>
  );
}

/** Netflix-style hero: today's top picks take turns every 12 seconds (paused while you point at it). */
export function HeroCarousel({ picks, full }: { picks: Pick[]; full?: boolean }) {
  const list = picks.slice(0, 5);
  const [i, setI] = useState(0);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover || list.length < 2) return;
    const t = window.setInterval(() => setI((x) => (x + 1) % list.length), 12_000);
    return () => window.clearInterval(t);
  }, [hover, list.length]);
  const pick = list[i % Math.max(1, list.length)];
  if (!pick) return null;
  return (
    <div className="hero-carousel" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Billboard pick={pick} full={full} onPlay={() => void playTitle(pick.id)}>
        {list.length > 1 && (
          <div className="bb-dots">
            {list.map((p, n) => <button key={p.id} className={n === i ? "on" : ""} onClick={() => setI(n)} aria-label={`Show ${p.title}`} />)}
          </div>
        )}
      </Billboard>
    </div>
  );
}

function PickTile({ p, canEdit }: { p: Pick; canEdit: boolean }) {
  return (
    <button className="pick-card" onClick={() => nav.open(p.id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: p.id, kind: "other", title: p.title }, canEdit))}>
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

/** Home: everything in one place — continue, watching, picks, new, collections, movies and shows. */
export default function Home({ status, canEdit, variant = "manage" }: { status: Status; canEdit: boolean; variant?: "manage" | "watch" }) {
  const epoch = useEpoch();
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [movies, setMovies] = useState<Card[]>([]);
  const [shows, setShows] = useState<Card[]>([]);
  const [top, setTop] = useState<Card[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.homeFeed().then(setFeed).catch((e) => setError(String(e)));
    getPicks(localDate()).then(setPicks).catch(() => setPicks([]));
    api.list("movie", "", "added", 0, 30).then((r) => setMovies(r.map(itemToCard))).catch(() => setMovies([]));
    api.list("series", "", "added", 0, 30).then((r) => setShows(r.map(itemToCard))).catch(() => setShows([]));
    api.list(null, "", "rating", 0, 30).then((r) => setTop(r.map(itemToCard))).catch(() => setTop([]));
  }, [epoch, status.lastSync]);

  const { hiddenNextUp } = usePrefs();
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const hero = picks[0];
  const resume = (feed?.resume ?? []).filter((r) => !cleared.has(r.id));
  const nextUp = (feed?.nextUp ?? []).filter((n) => !resume.some((r) => r.id === n.id) && !hiddenNextUp.includes(n.seriesId ?? n.id));
  const removeResume = (ids: string[]) => {
    setCleared((s) => new Set([...s, ...ids]));
    void track(ids.length > 1 ? "Clearing Continue watching" : "Removing from Continue watching", async () => {
      for (const id of ids) await api.clearResume(id);
    });
  };
  const hideNext = (ids: string[]) => {
    setPrefs((p) => ({ hiddenNextUp: [...new Set([...p.hiddenNextUp, ...ids])] }));
    if (canEdit) void track(ids.length > 1 ? "Clearing Watching in Jellyfin" : "Taking the show off Next Up in Jellyfin", () => hideInJellyfin(ids), { reload: false });
  };
  const showHidden = () => {
    setPrefs({ hiddenNextUp: [] });
    void track("Putting shows back in Watching", () => unhideInJellyfin());
  };
  const syncNow = () => void syncPicks();
  const [editing, setEditing] = useState(false);

  return (
    <div className={`pg home ${variant}`}>
      {variant === "manage" && (
        <div className="pg-head">
          <h1>Home</h1>
          <div className="pg-actions">
            <button onClick={() => nav.route({ view: "add" })}>+ Add show or movie</button>
            <button onClick={() => void scanLibrary()}><Icon name="reload" /> Scan library</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {variant === "manage" && <SetupChecklist status={status} />}
      {hero && (variant === "watch" ? <HeroCarousel picks={picks} full /> : <Billboard pick={hero} onPlay={() => void playTitle(hero.id)} />)}

      <Row title="Continue watching" cards={resume} wide canEdit={canEdit}
        menuExtra={(c) => [{ label: "Remove from Continue watching", run: () => removeResume([c.id]) }]}
        action={resume.length > 0 && <button className="link small" onClick={() => void askConfirm("Clear Continue watching? Where you stopped is forgotten (also in Infuse).", { okLabel: "Clear" }).then((ok) => { if (ok) removeResume(resume.map((r) => r.id)); })}>Clear</button>} />
      <Row title="Watching" cards={nextUp} wide canEdit={canEdit}
        menuExtra={(c) => [{ label: "Stop watching this show (hide)", run: () => hideNext([c.seriesId ?? c.id]) }]}
        action={<>
          {hiddenNextUp.length > 0 && <button className="link small" onClick={showHidden}>Show {hiddenNextUp.length} hidden</button>}
          {nextUp.length > 0 && <button className="link small" onClick={() => hideNext(nextUp.map((c) => c.seriesId ?? c.id))}>Clear</button>}
        </>} />

      {picks.length > 1 && (
        <section className="hrow">
          <div className="section-head">
            <h2>Picks of the day</h2>
            <div className="row end">
              <span className="muted small">New ones at midnight · also in Jellyfin as a playlist and collection · <SettingsLink section="picks">where to find them in Infuse</SettingsLink></span>
              <button className="link small" onClick={() => setEditing(true)}>Edit</button>
              {canEdit && <button className="link small" onClick={syncNow}>Update in Jellyfin now</button>}
            </div>
          </div>
          <div className="picks-row">{picks.slice(variant === "watch" ? 0 : 1).map((p) => <PickTile key={p.id} p={p} canEdit={canEdit} />)}</div>
        </section>
      )}

      <Row title="Recently added" cards={feed?.recent ?? []} wide canEdit={canEdit} />
      <Row title="New movies" cards={movies} canEdit={canEdit} />
      <Row title="New shows" cards={shows} canEdit={canEdit} />
      <Row title="Top 10 in your library" cards={top} canEdit={canEdit} ranked={variant === "watch"} />
      {(feed?.collections.length ?? 0) > 0 && (
        <section className="hrow">
          <div className="section-head">
            <h2>Collections</h2>
            <button className="link small" onClick={() => nav.route({ view: "collections" })}>See all</button>
          </div>
          <div className="hrow-scroll">
            {feed!.collections.map((c) => <CardTile key={c.id} c={c} canEdit={canEdit} onOpen={() => nav.route({ view: "collections", collection: c.id })} />)}
          </div>
        </section>
      )}
      {editing && <PicksEditor onClose={() => setEditing(false)} />}
      {!feed && !error && <p className="muted">Loading…</p>}
      {feed && !hero && !resume.length && !movies.length && !shows.length && (
        <p className="muted">Nothing here yet. Scan the library or add a show.</p>
      )}
    </div>
  );
}

/** First-run checklist: the few things that make everything else work. Closes for good. */
export function SetupChecklist({ status }: { status: Status }) {
  const p = usePrefs();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [inbox, setInbox] = useState<string | null>(null);
  useEffect(() => {
    if (p.setupDone) return;
    api.healthAlerts().then(setAlerts).catch(() => setAlerts([]));
    api.inboxList().then(([d]) => setInbox(d)).catch(() => setInbox(null));
  }, [p.setupDone]);
  if (p.setupDone || !alerts) return null;
  const plugins = !alerts.some((a) => a.fix === "settings:plugins" && a.level !== "info");
  const steps: { done: boolean; label: string; hint: string; go: () => void }[] = [
    { done: !!status.libraryRoot, label: "Choose your library folder", hint: "The NAS share on this computer", go: () => nav.route({ view: "settings", section: "folder" }) },
    { done: !status.readOnly, label: "Allow changes to Jellyfin", hint: "Everything stays undoable", go: () => nav.route({ view: "settings", section: "changes" }) },
    { done: plugins, label: "Install the Jellyfin plugins", hint: "Skip markers and subtitles", go: () => nav.route({ view: "settings", section: "plugins" }) },
    { done: status.hasTmdb, label: "Add a TMDB key", hint: "Better matching, missing episodes", go: () => nav.route({ view: "settings", section: "metadata" }) },
    { done: !!inbox, label: "Watch your downloads folder", hint: "New titles ready to add", go: () => nav.route({ view: "add" }) },
    { done: p.schedule.enabled, label: "Turn on daily tasks", hint: "Art, subtitles, picks by themselves", go: () => nav.route({ view: "settings", section: "schedule" }) },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card form setup-card">
      <div className="section-head">
        <div>
          <h2>Get Media Hub set up · {done} of {steps.length}</h2>
          <div className="muted small">A few one-time steps; each opens the right place.</div>
        </div>
        <button className="link small" onClick={() => setPrefs({ setupDone: true })}>Hide this</button>
      </div>
      <div className="setup-steps">
        {steps.map((x) => (
          <button key={x.label} className={`setup-step ${x.done ? "done" : ""}`} onClick={x.go} disabled={x.done}>
            <span className="setup-dot">{x.done ? <Icon name="check" size={14} /> : null}</span>
            <span className="grow"><span className="strong small">{x.label}</span><br /><span className="muted small">{x.hint}</span></span>
            {!x.done && <span className="accent">›</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
