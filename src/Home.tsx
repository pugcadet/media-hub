import { useEffect, useState } from "react";
import { api, Card, cleanTitle, HomeFeed, imageUrl, Item, localDate, Pick, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { CardTile, itemMenu, openMenu, playTitle, Row } from "./ui";

export function itemToCard(i: Item): Card {
  const sub = i.kind === "series"
    ? [i.year, i.seasons ? `${i.seasons} season${i.seasons === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
    : [i.year, i.runtime ? `${Math.round(i.runtime)} min` : ""].filter(Boolean).join(" · ");
  return { id: i.id, kind: i.kind, title: cleanTitle(i.name, i.year), subtitle: sub, artId: i.id, seriesId: null, year: i.year, progress: null, played: i.played, hasPoster: i.hasPoster };
}

/** The big picture at the top: one of today's picks, with its logo when there is one. */
export function Billboard({ pick, onPlay }: { pick: Pick; onPlay?: () => void }) {
  const [logo, setLogo] = useState(true);
  useEffect(() => setLogo(true), [pick.artId]);
  return (
    <section className="billboard" onContextMenu={(e) => openMenu(e, itemMenu({ id: pick.id, kind: "other", title: pick.title }))}>
      <img className="bb-art" src={imageUrl(pick.artId, "Backdrop", 1600)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
      <div className="bb-shade" />
      <div className="bb-text">
        <div className="bb-why">{pick.why}</div>
        {logo ? (
          <img className="bb-logo" src={imageUrl(pick.artId, "Logo", 700)} alt={pick.title} onError={() => setLogo(false)} />
        ) : (
          <div className="bb-title">{pick.title}</div>
        )}
        <div className="bb-meta">{pick.meta}</div>
        <div className="row">
          {onPlay && <button className="primary bb-btn" onClick={onPlay}>▶ Play</button>}
          <button className="bb-btn ghost" onClick={() => nav.open(pick.id)}>More info</button>
        </div>
      </div>
    </section>
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

/** Home: everything in one place — continue, next up, picks, new, collections, movies and shows. */
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
    api.picks(localDate()).then(setPicks).catch(() => setPicks([]));
    api.list("movie", "", "added", 0, 30).then((r) => setMovies(r.map(itemToCard))).catch(() => setMovies([]));
    api.list("series", "", "added", 0, 30).then((r) => setShows(r.map(itemToCard))).catch(() => setShows([]));
    api.list(null, "", "rating", 0, 30).then((r) => setTop(r.map(itemToCard))).catch(() => setTop([]));
  }, [epoch, status.lastSync]);

  const hero = picks[0];
  const resume = feed?.resume ?? [];
  const nextUp = (feed?.nextUp ?? []).filter((n) => !resume.some((r) => r.id === n.id));

  return (
    <div className={`pg home ${variant}`}>
      {variant === "manage" && (
        <div className="pg-head">
          <h1>Home</h1>
          <div className="pg-actions">
            <button onClick={() => nav.route({ view: "add" })}>+ Add show or movie</button>
            <button onClick={() => void track("Scanning the library", () => api.sync().then(() => undefined))}>Scan library</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {hero && <Billboard pick={hero} onPlay={() => void playTitle(hero.id)} />}

      <Row title="Continue watching" cards={resume} wide canEdit={canEdit} />
      <Row title="Next up" cards={nextUp} wide canEdit={canEdit} />

      {picks.length > 1 && (
        <section className="hrow">
          <div className="section-head">
            <h2>Picks of the day</h2>
            <div className="row end">
              <span className="muted small">New ones at midnight · also in Jellyfin as “Picks of the day”</span>
              {canEdit && (
                <button className="link small" onClick={() => void track("Updating “Picks of the day” in Jellyfin", () => api.syncPicksCollection(picks.map((p) => p.id)).then(() => undefined))}>Update in Jellyfin</button>
              )}
            </div>
          </div>
          <div className="picks-row">{picks.slice(1).map((p) => <PickTile key={p.id} p={p} canEdit={canEdit} />)}</div>
        </section>
      )}

      <Row title="Recently added" cards={feed?.recent ?? []} wide canEdit={canEdit} />
      <Row title="New movies" cards={movies} canEdit={canEdit} />
      <Row title="New shows" cards={shows} canEdit={canEdit} />
      <Row title="Top rated" cards={top} canEdit={canEdit} />
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
      {!feed && !error && <p className="muted">Loading…</p>}
      {feed && !hero && !resume.length && !movies.length && !shows.length && (
        <p className="muted">Nothing here yet. Scan the library or add a show.</p>
      )}
    </div>
  );
}
