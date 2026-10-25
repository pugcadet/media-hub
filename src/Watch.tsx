// The Player side of Media Hub: browse and watch, like Infuse or Netflix. No editing here;
// the hub switcher (top left) goes back to the media manager.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, Card, cleanTitle, Details, imageUrl, JfChild, Library, Sort, Status } from "./api";
import { useEpoch } from "./activity";
import { nav } from "./nav";
import { HubSwitcher } from "./Sidebar";
import Home, { itemToCard } from "./Home";
import Collections from "./Collections";
import { CardTile, Icon, itemMenu, openMenu, Row } from "./ui";

type Tab = "home" | "movies" | "shows" | "collections";

export default function Watch({ status, item, onBack }: { status: Status; libraries: Library[]; item: { id: string; tab?: string; n: number } | null; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("home");
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [item?.id, tab]);

  // Collections open inside the player instead of switching to the manager.
  useEffect(() => {
    const prev = nav.route;
    nav.route = (r) => {
      if (r.view === "collections") {
        setTab("collections");
        setCollection(r.collection ?? null);
        if (item) onBack();
      } else prev(r);
    };
    return () => {
      nav.route = prev;
    };
  }, [item, onBack]);

  const go = (t: Tab) => {
    setTab(t);
    setCollection(null);
    setQuery("");
    if (item) onBack();
  };

  return (
    <div className="watch">
      <header className="w-top">
        <HubSwitcher />
        <nav className="w-tabs">
          {(["home", "movies", "shows", "collections"] as Tab[]).map((t) => (
            <button key={t} className={tab === t && !item && !query ? "on" : ""} onClick={() => go(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
          ))}
        </nav>
        <div className="spacer" />
        <label className="searchbox w-search">
          <Icon name="search" />
          <input placeholder="Search" value={query} onChange={(e) => { setQuery(e.target.value); if (item && e.target.value) onBack(); }} />
        </label>
      </header>
      <div className="w-page" ref={scroller}>
        {item ? (
          <WatchItem key={item.id} id={item.id} onBack={onBack} />
        ) : query ? (
          <Browse kind={null} query={query} />
        ) : tab === "home" ? (
          <Home status={status} canEdit={false} variant="watch" />
        ) : tab === "movies" ? (
          <Browse kind="movie" query="" />
        ) : tab === "shows" ? (
          <Browse kind="series" query="" />
        ) : (
          <Collections status={{ ...status, readOnly: true }} selected={collection} />
        )}
      </div>
    </div>
  );
}

function Browse({ kind, query }: { kind: "movie" | "series" | null; query: string }) {
  const epoch = useEpoch();
  const [sort, setSort] = useState<Sort>("added");
  const [items, setItems] = useState<Card[]>([]);
  const [more, setMore] = useState(true);
  const [genre, setGenre] = useState<string | null>(null);
  const [genres, setGenres] = useState<string[]>([]);
  const [onlyNew, setOnlyNew] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const all = useRef<{ card: Card; genres: string[] }[]>([]);

  const load = useCallback(async (offset: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const rows = await api.list(kind, query, sort, offset, 120);
      if (offset === 0) {
        const g = new Map<string, number>();
        rows.forEach((r) => r.genres.forEach((x) => g.set(x, (g.get(x) ?? 0) + 1)));
        setGenres([...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([x]) => x));
      }
      const cards = rows.map((r) => ({ card: itemToCard(r), genres: r.genres }));
      const next = offset === 0 ? cards : [...all.current, ...cards];
      all.current = next;
      setItems(next.filter((c) => (!genre || c.genres.includes(genre)) && (!onlyNew || !c.card.played)).map((c) => c.card));
      setMore(rows.length === 120);
    } finally {
      busy.current = false;
    }
  }, [kind, query, sort, genre, onlyNew]);

  useEffect(() => {
    void load(0);
  }, [load, epoch]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && void load(all.current.length), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, load]);

  return (
    <div className="pg">
      <div className="pg-head">
        <h1>{query ? `Results for “${query}”` : kind === "movie" ? "Movies" : "Shows"}</h1>
        <div className="pg-actions">
          <label className="check small"><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />Not watched yet</label>
          <label className="sort">Sort
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="added">Recently added</option><option value="name">Name</option><option value="rating">Rating</option><option value="year">Year</option>
            </select>
          </label>
        </div>
      </div>
      {genres.length > 0 && !query && (
        <div className="chips">
          <button className={`chip ${genre === null ? "on" : ""}`} onClick={() => setGenre(null)}>All</button>
          {genres.map((g) => <button key={g} className={`chip ${genre === g ? "on" : ""}`} onClick={() => setGenre(genre === g ? null : g)}>{g}</button>)}
        </div>
      )}
      <div className="grid">{items.map((c) => <CardTile key={c.id} c={c} canEdit={false} />)}</div>
      {items.length === 0 && <p className="muted">Nothing here.</p>}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}

function WatchItem({ id, onBack }: { id: string; onBack: () => void }) {
  const epoch = useEpoch();
  const [d, setD] = useState<Details | null>(null);
  const [season, setSeason] = useState<string | null>(null);
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [similar, setSimilar] = useState<Card[]>([]);
  const [logo, setLogo] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.details(id).then((x) => {
      setD(x);
      if (x.item.Type === "Series") {
        // Start on the season you're in (first one not fully watched).
        const s = x.seasons.find((s) => !s.UserData?.Played && (s.IndexNumber ?? 0) > 0) ?? x.seasons.find((s) => (s.IndexNumber ?? 0) > 0) ?? x.seasons[0];
        setSeason((cur) => cur ?? s?.Id ?? null);
      } else if (x.item.Type === "Season") {
        setSeason(x.item.Id);
      }
    }).catch((e) => setError(String(e)));
    api.similar(id).then(setSimilar).catch(() => setSimilar([]));
  }, [id, epoch]);
  useEffect(() => {
    setEps(null);
    if (season) api.children(season).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch(() => setEps([]));
  }, [season, epoch]);

  if (error) return <div className="pg"><button onClick={onBack}>← Back</button><p className="error">{error}</p></div>;
  if (!d) return <div className="pg"><p className="muted">Loading…</p></div>;
  const it = d.item;
  const isEpisode = it.Type === "Episode";
  const artId = (isEpisode || it.Type === "Season") && it.SeriesId ? it.SeriesId : id;
  const title = cleanTitle(it.Name, it.ProductionYear);
  const next = eps?.find((e) => !e.UserData?.Played) ?? eps?.[0];
  const playId = it.Type === "Movie" || isEpisode ? id : next?.Id;
  const resumeAt = (it.Type === "Movie" || isEpisode ? it.UserData?.PlaybackPositionTicks : next?.UserData?.PlaybackPositionTicks) ?? 0;
  const people = (it.People ?? []).filter((p) => p.Type === "Actor" || !p.Type).slice(0, 20);
  const runtime = it.RunTimeTicks ? Math.round(it.RunTimeTicks / 600_000_000) : 0;

  return (
    <div className="w-item">
      <section className="w-hero" onContextMenu={(e) => openMenu(e, itemMenu({ id, kind: it.Type, title, seriesId: it.SeriesId, played: it.UserData?.Played }, false))}>
        <img className="w-hero-art" src={isEpisode ? imageUrl(id, "Primary", 1920) : imageUrl(artId, "Backdrop", 1920)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
        <div className="w-hero-shade" />
        <div className="w-hero-body">
          <button className="link small" onClick={onBack}>← Back</button>
          {logo && !isEpisode ? <img className="w-logo" src={imageUrl(artId, "Logo", 800)} alt={title} onError={() => setLogo(false)} /> : <h1 className="w-title">{isEpisode && it.SeriesName ? cleanTitle(it.SeriesName) : title}</h1>}
          {isEpisode && <div className="w-epname">{epCode(it.ParentIndexNumber, it.IndexNumber).trim()}{epCode(it.ParentIndexNumber, it.IndexNumber) ? " — " : ""}{it.Name}</div>}
          <div className="hero-meta">
            {it.ProductionYear && <span>{it.ProductionYear}</span>}
            {it.OfficialRating && <span>{it.OfficialRating}</span>}
            {runtime > 0 && <span>{runtime >= 60 ? `${Math.floor(runtime / 60)} h ${runtime % 60} min` : `${runtime} min`}</span>}
            {it.CommunityRating != null && <span>★ {it.CommunityRating.toFixed(1)}</span>}
            {(it.Genres ?? []).length > 0 && <span>{it.Genres!.slice(0, 3).join(", ")}</span>}
          </div>
          {it.Overview && <p className="w-overview">{it.Overview}</p>}
          <div className="row">
            {playId && (
              <button className="primary bb-btn" onClick={() => nav.play(playId)}>
                ▶ {resumeAt > 0 ? "Resume" : "Play"}{it.Type === "Series" && next ? epCode(next.ParentIndexNumber ?? d.seasons.find((x) => x.Id === season)?.IndexNumber, next.IndexNumber) : ""}
              </button>
            )}
            <button className="bb-btn ghost" onClick={() => void api.setPlayed(id, !it.UserData?.Played).then(() => api.details(id).then(setD)).catch(() => undefined)}>
              {it.UserData?.Played ? "✓ Watched" : "Mark as watched"}
            </button>
            {isEpisode && it.SeriesId && <button className="bb-btn ghost" onClick={() => nav.open(it.SeriesId!)}>Go to show</button>}
          </div>
          {people.length > 0 && <div className="muted small w-cast-line">With {people.slice(0, 5).map((p) => p.Name).join(", ")}</div>}
        </div>
      </section>

      <div className="pg">
        {(it.Type === "Series") && d.seasons.length > 0 && (
          <section className="stack">
            <div className="chips">
              {d.seasons.map((s) => <button key={s.Id} className={`chip ${season === s.Id ? "on" : ""}`} onClick={() => setSeason(s.Id)}>{cleanTitle(s.Name)}</button>)}
            </div>
            <div className="w-eps">
              {eps === null && <p className="muted">Loading episodes…</p>}
              {eps?.map((e) => {
                const pos = e.UserData?.PlaybackPositionTicks ?? 0;
                return (
                  <div key={e.Id} className="w-ep" onContextMenu={(ev) => openMenu(ev, itemMenu({ id: e.Id, kind: "episode", title: e.Name, seriesId: id, seasonId: season, played: e.UserData?.Played }, false))}>
                    <button className="art wide cover tile-art" onClick={() => nav.play(e.Id)} aria-label={`Play ${e.Name}`}>
                      {e.ImageTags?.Primary ? <img src={imageUrl(e.Id, "Primary", 480, 0, e.ImageTags.Primary)} alt="" loading="lazy" /> : <div className="noart">E{e.IndexNumber}</div>}
                      <span className="tile-play"><Icon name="play" size={20} /></span>
                      {e.UserData?.Played && <span className="played">✓</span>}
                      {pos > 0 && e.RunTimeTicks ? <span className="tile-progress"><span style={{ width: `${Math.min(100, (pos / e.RunTimeTicks) * 100)}%` }} /></span> : null}
                    </button>
                    <button className="w-ep-text tile-text" onClick={() => nav.open(e.Id)}>
                      <div className="strong">{e.IndexNumber}. {e.Name}</div>
                      <div className="muted small">{e.RunTimeTicks ? `${Math.round(e.RunTimeTicks / 600_000_000)} min` : ""}{e.PremiereDate ? ` · ${new Date(e.PremiereDate).toLocaleDateString()}` : ""}</div>
                      {e.Overview && <div className="small muted w-ep-ov">{e.Overview}</div>}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {people.length > 0 && (
          <section className="hrow">
            <div className="section-head"><h2>Cast</h2></div>
            <div className="cast">
              {people.map((p) => (
                <div key={`${p.Id}-${p.Role}`} className="person">
                  <div className="face">{p.PrimaryImageTag ? <img src={imageUrl(p.Id.replace(/-/g, ""), "Primary", 200, 0, p.PrimaryImageTag)} alt="" loading="lazy" /> : <span>{p.Name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>}</div>
                  <div className="small strong ellipsis">{p.Name}</div>
                  <div className="small muted ellipsis">{p.Role}</div>
                </div>
              ))}
            </div>
          </section>
        )}
        <Row title="More like this" cards={similar} canEdit={false} />
      </div>
    </div>
  );
}

/** " S1 E3", or "" when the numbers aren't known. */
function epCode(season: number | null | undefined, ep: number | null | undefined): string {
  if (season == null && ep == null) return "";
  if (season == null) return ` E${ep}`;
  if (ep == null) return ` S${season}`;
  return ` S${season} E${ep}`;
}
