// The Player side of Media Hub: browse and watch, like Infuse or Netflix. No editing here;
// the hub switcher (top left) goes back to the media manager.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, Card, cleanTitle, codesFor, cultures, Details, imageUrl, Item, JfChild, Library, Pick, Sort, Status } from "./api";
import { onDataReload, useEpoch } from "./activity";
import { nav } from "./nav";
import { HubSwitcher } from "./Sidebar";
import Home, { Billboard, featured, itemToCard } from "./Home";
import Collections from "./Collections";
import { MediaInfo } from "./ItemPage";
import { CardTile, Icon, Img, itemMenu, openMenu, playTitle, preloadImages, Row, Tabs } from "./ui";
import { prefs } from "./prefs";
import { foldersOf, folderMap, tabFolder, useFolderMap } from "./folders";
import { track } from "./activity";

/** "home", "collections", "movies"/"shows" (no folders known) or "folder:<name>" (one per NAS folder). */
type Tab = string;

const cleanId = (id: string) => id.replace(/-/g, "");

/** Every show and movie, newest first (shared by the folder tabs and the background preload). */
let allItems: Promise<Item[]> | null = null;
onDataReload(() => { allItems = null; });
function everything(): Promise<Item[]> {
  allItems ??= api.list(null, "", "added", 0, 10000).catch(() => { allItems = null; return []; });
  return allItems;
}

/** The titles in one library folder, in the given order. */
async function inFolder(folder: string, sort: Sort): Promise<Item[]> {
  const [all, map] = await Promise.all([sort === "added" ? everything() : api.list(null, "", sort, 0, 10000), folderMap()]);
  return all.filter((i) => (map.get(cleanId(i.id)) ?? "Other") === folder);
}

export default function Watch({ status, item, onBack }: { status: Status; libraries: Library[]; item: { id: string; tab?: string; n: number } | null; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("home");
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Like Netflix: the top bar floats over the picture and turns solid once you scroll.
  const [solid, setSolid] = useState(false);

  // Each tab remembers where you were; a title opens at the top, Back returns to the spot.
  const tabScroll = useRef<Record<string, number>>({});
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const y = item ? 0 : query ? 0 : tabScroll.current[tab] ?? 0;
    el.scrollTo({ top: y });
    setSolid(y > 40);
  }, [item?.id, tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasHero = !!item || (!query && tab !== "collections");
  const [seen, setSeen] = useState<Tab[]>(["home"]);
  useEffect(() => setSeen((s) => (s.includes(tab) ? s : [...s, tab])), [tab]);

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

  const fmap = useFolderMap();
  const folders = foldersOf(fmap);
  const tabList: Tab[] = folders.length ? ["home", ...folders.map((f) => `folder:${f}`), "collections"] : ["home", "movies", "shows", "collections"];
  const label = (t: Tab) => tabFolder(t) ?? t[0].toUpperCase() + t.slice(1);

  // Once the first screen is up, the other tabs' first pictures load quietly in the background.
  useEffect(() => {
    if (!folders.length) return;
    let cancelled = false;
    const idle = (f: () => void) => ((window as unknown as { requestIdleCallback?: (f: () => void) => number }).requestIdleCallback ?? ((g: () => void) => window.setTimeout(g, 200)))(f);
    const t = window.setTimeout(() => idle(() => void (async () => {
      for (const f of folders) {
        if (cancelled) return;
        const list = await inFolder(f, "added").catch(() => []);
        preloadImages(list.slice(0, 30).map((i) => imageUrl(itemToCard(i).artId, "Primary", 300)));
        await new Promise((r) => window.setTimeout(r, 400));
      }
    })()), 1500);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [folders.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (t: Tab) => {
    setTab(t);
    setCollection(null);
    setQuery("");
    if (item) onBack();
  };

  return (
    <div className="watch">
      <header className={`w-top ${solid || !hasHero ? "solid" : ""}`}>
        <HubSwitcher />
        <nav className="w-tabs">
          {tabList.map((t) => (
            <button key={t} className={tab === t && !item && !query ? "on" : ""} onClick={() => go(t)}>{label(t)}</button>
          ))}
        </nav>
        <div className="spacer" />
        <button className="w-random" onClick={() => void playRandom()} title="Play something you haven't seen (folders: Settings → Player)"><Icon name="shuffle" /><span className="w-random-label"> Play something</span></button>
        <label className="searchbox w-search">
          <Icon name="search" />
          <input placeholder="Search" value={query} onChange={(e) => { setQuery(e.target.value); if (item && e.target.value) onBack(); }} />
        </label>
      </header>
      <div className={`w-page ${hasHero ? "has-hero" : ""}`} ref={scroller} onScroll={(e) => { const y = (e.target as HTMLDivElement).scrollTop; setSolid(y > 40); if (!item && !query) tabScroll.current[tab] = y; }}>
        {item && <WatchItem key={item.id} id={item.id} onBack={onBack} />}
        {!item && query && <Browse kind={null} query={query} />}
        {/* The tabs stay loaded once opened, so switching back shows them at once. */}
        {seen.map((t) => (
          <div key={t} className="w-tab-body" hidden={!!item || !!query || tab !== t}>
            {t === "home" ? <Home status={status} canEdit={false} variant="watch" />
              : t === "movies" ? <Browse kind="movie" query="" />
              : t === "shows" ? <Browse kind="series" query="" />
              : tabFolder(t) ? <Browse kind={null} query="" folder={tabFolder(t)!} />
              : <Collections status={{ ...status, readOnly: true }} selected={collection} variant="watch" />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Plays a random title you haven't watched, from the folders chosen in Settings → Player. */
export async function playRandom(): Promise<void> {
  const all = await api.list(null, "", "name", 0, 5000).catch(() => []);
  let pool = all.filter((i) => !i.played);
  const folders = prefs().randomFolders;
  if (folders.length) {
    const h = await api.libraryHealth(false).catch(() => null);
    const where = new Map((h?.rows ?? []).map((r) => [r.id, r.libraryFolder || "Other"]));
    pool = pool.filter((i) => folders.includes(where.get(i.id) ?? "Other"));
  }
  if (!pool.length) pool = all;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  if (pick) await playTitle(pick.id);
}

const LETTERS = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
const letterOf = (name: string) => {
  const c = cleanTitle(name).replace(/^(the|a|an|de|het)\s+/i, "").charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
};

const browseCache = new Map<string, { items: Card[]; hero: Pick | null }>();
const detailsCache = new Map<string, Details>();
const epsCache = new Map<string, JfChild[]>();
onDataReload(() => { browseCache.clear(); detailsCache.clear(); epsCache.clear(); });

function Browse({ kind, query, folder }: { kind: "movie" | "series" | null; query: string; folder?: string }) {
  const epoch = useEpoch();
  const key = folder ? `folder:${folder}` : kind ?? "search";
  const cacheKey = folder ? `folder:${folder}` : kind ?? "all";
  const [sort, setSort] = usePageState<Sort>(`watch.${key}.sort`, "added");
  const [items, setItems] = useState<Card[]>(() => (query ? [] : browseCache.get(cacheKey)?.items ?? []));
  const [more, setMore] = useState(true);
  const [genre, setGenre] = usePageState<string | null>(`watch.${key}.genre`, null);
  const [genres, setGenres] = useState<string[]>([]);
  const [onlyNew, setOnlyNew] = usePageState(`watch.${key}.onlyNew`, false);
  const [hero, setHero] = useState<Pick | null>(() => (query ? null : browseCache.get(cacheKey)?.hero ?? null));
  const sentinel = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  // The A–Z rail shows once the big picture has scrolled away.
  const [pastHero, setPastHero] = useState(false);
  useEffect(() => {
    const sc = root.current?.closest(".w-page");
    if (!sc) return;
    const on = () => {
      const bb = root.current?.querySelector(".billboard");
      setPastHero(!bb || sc.scrollTop > (bb as HTMLElement).offsetHeight * 0.75);
    };
    on();
    sc.addEventListener("scroll", on, { passive: true });
    return () => sc.removeEventListener("scroll", on);
  }, [hero]);
  const all = useRef<{ card: Card; genres: string[] }[]>([]);

  const load = useCallback(async (offset: number) => {
    if (busy.current) return;
    busy.current = true;
    try {
      // A folder tab shows everything in it at once (no paging).
      const rows = folder ? (offset === 0 ? await inFolder(folder, sort) : []) : await api.list(kind, query, sort, offset, 120);
      if (offset === 0) {
        if (!query) (folder ? inFolder(folder, "rating").then((r) => r.slice(0, 200)) : api.list(kind, "", "rating", 0, 200)).then((top) => {
          const h = featured(top, folder ? `Pick from ${folder}` : kind === "movie" ? "Movie of the day" : "Show of the day");
          setHero(h);
          browseCache.set(cacheKey, { items: browseCache.get(cacheKey)?.items ?? [], hero: h });
        }).catch(() => setHero(null));
        const g = new Map<string, number>();
        rows.forEach((r) => r.genres.forEach((x) => g.set(x, (g.get(x) ?? 0) + 1)));
        setGenres([...g.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([x]) => x));
      }
      const cards = rows.map((r) => ({ card: itemToCard(r), genres: r.genres }));
      const next = offset === 0 ? cards : [...all.current, ...cards];
      all.current = next;
      const shown = next.filter((c) => (!genre || c.genres.includes(genre)) && (!onlyNew || !c.card.played)).map((c) => c.card);
      setItems(shown);
      if (!query && offset === 0 && !genre && !onlyNew) browseCache.set(cacheKey, { items: shown, hero: browseCache.get(cacheKey)?.hero ?? null });
      setMore(!folder && rows.length === 120);
    } finally {
      busy.current = false;
    }
  }, [kind, query, sort, genre, onlyNew, folder]);

  useEffect(() => {
    void load(0);
  }, [load, epoch]);

  /** A–Z: everything sorted by name, then scroll to the first title with that letter. */
  async function jump(l: string) {
    if (sort !== "name" || more) {
      const rows = folder ? await inFolder(folder, "name") : await api.list(kind, "", "name", 0, 10000);
      all.current = rows.map((r) => ({ card: itemToCard(r), genres: r.genres }));
      setItems(all.current.filter((c) => (!genre || c.genres.includes(genre)) && (!onlyNew || !c.card.played)).map((c) => c.card));
      setMore(false);
      if (sort !== "name") { busy.current = true; setSort("name"); window.setTimeout(() => { busy.current = false; }, 600); }
      await new Promise((r) => window.setTimeout(r, 80));
    }
    const letters = LETTERS.slice(LETTERS.indexOf(l));
    for (const x of letters) {
      const el = document.querySelector(`.w-cell[data-letter="${x}"]`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    }
  }

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && void load(all.current.length), { rootMargin: "800px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, load]);

  return (
    <div className={`pg w-browse ${hero && !query ? "layered" : ""}`} ref={root}>
      {hero && !query && <Billboard pick={hero} full onPlay={() => void playTitle(hero.id)} />}
      <div className="pg-head">
        <h1>{query ? `Results for “${query}”` : folder ?? (kind === "movie" ? "Movies" : "Shows")}</h1>
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
      <div className="grid w-grid">
        {items.map((c, i) => {
          const l = letterOf(c.title);
          const first = sort === "name" && (i === 0 || letterOf(items[i - 1].title) !== l);
          return <div key={c.id} data-letter={first ? l : undefined} className="w-cell"><CardTile c={c} canEdit={false} /></div>;
        })}
      </div>
      {!query && items.length > 30 && (
        <nav className={`az-rail ${pastHero ? "" : "away"}`} aria-label="Jump to a letter">
          {LETTERS.map((l) => <button key={l} onClick={() => void jump(l)}>{l}</button>)}
        </nav>
      )}
      {items.length === 0 && <p className="muted">Nothing here.</p>}
      <div ref={sentinel} style={{ height: 1 }} />
    </div>
  );
}

function WatchItem({ id, onBack }: { id: string; onBack: () => void }) {
  const epoch = useEpoch();
  const [d, setDS] = useState<Details | null>(() => detailsCache.get(id) ?? null);
  const setD = (x: Details) => { detailsCache.set(id, x); setDS(x); };
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
    setEps(season ? epsCache.get(season) ?? null : null);
    if (season) api.children(season).then((c) => { const e = c.filter((x) => x.Type === "Episode"); epsCache.set(season, e); setEps(e); }).catch(() => setEps([]));
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
      <button className="w-backfix" onClick={onBack} aria-label="Back" title="Back"><span className="flip"><Icon name="chevron" size={22} /></span></button>
      <section className="w-hero" onContextMenu={(e) => openMenu(e, itemMenu({ id, kind: it.Type, title, seriesId: it.SeriesId, played: it.UserData?.Played }, false))}>
        <Img className="w-hero-art" src={isEpisode ? imageUrl(id, "Primary", 1920) : imageUrl(artId, "Backdrop", 1920)} />
        <div className="w-hero-shade" />
        <div className="w-hero-body">
          {logo && !isEpisode ? <Img className="w-logo" src={imageUrl(artId, "Logo", 800)} alt={title} onFail={() => setLogo(false)} /> : <h1 className="w-title">{isEpisode && it.SeriesName ? cleanTitle(it.SeriesName) : title}</h1>}
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
              <button className="bb-play" onClick={() => nav.play(playId)}>
                <Icon name="play" size={20} /> {resumeAt > 0 ? "Resume" : "Play"}{it.Type === "Series" && next ? epCode(next.ParentIndexNumber ?? d.seasons.find((x) => x.Id === season)?.IndexNumber, next.IndexNumber) : ""}
              </button>
            )}
            <button className={`bb-round eye ${it.UserData?.Played ? "on" : ""}`} title={it.UserData?.Played ? "Watched (click to undo)" : "Mark as watched"} aria-label={it.UserData?.Played ? "Watched" : "Mark as watched"} aria-pressed={!!it.UserData?.Played} onClick={() => void api.setPlayed(id, !it.UserData?.Played).then(() => api.details(id).then(setD)).catch(() => undefined)}>
              <Icon name="eye" size={20} />
            </button>
            {isEpisode && it.SeriesId && <button className="bb-more" onClick={() => nav.open(it.SeriesId!)}>Go to show</button>}
          </div>
          {people.length > 0 && <div className="muted small w-cast-line">With {people.slice(0, 5).map((p) => p.Name).join(", ")}</div>}
        </div>
      </section>

      <div className="pg">
        {(it.Type === "Series") && d.seasons.length > 0 && (
          <section className="stack">
            <div className="w-eps-head">
              <h2 className="big">Episodes</h2>
              <Tabs active={season ?? ""} onChange={setSeason} tabs={d.seasons.map((s) => ({ id: s.Id, label: cleanTitle(s.Name), count: s.ChildCount ?? undefined }))} />
            </div>
            <div className="w-eps list">
              {eps === null && <p className="muted">Loading episodes…</p>}
              {eps?.map((e) => {
                const pos = e.UserData?.PlaybackPositionTicks ?? 0;
                return (
                  <div key={e.Id} className={`w-ep ${e.Id === next?.Id ? "next" : ""}`} onContextMenu={(ev) => openMenu(ev, itemMenu({ id: e.Id, kind: "episode", title: e.Name, seriesId: id, seasonId: season, played: e.UserData?.Played }, false))}>
                    <span className="w-ep-num">{e.IndexNumber}</span>
                    <button className="art wide cover tile-art" onClick={() => nav.play(e.Id)} aria-label={`Play ${e.Name}`}>
                      {e.ImageTags?.Primary ? <img src={imageUrl(e.Id, "Primary", 480, 0, e.ImageTags.Primary)} alt="" loading="lazy" /> : <div className="noart">E{e.IndexNumber}</div>}
                      <span className="tile-play"><Icon name="play" size={20} /></span>
                      {e.UserData?.Played && <span className="played">✓</span>}
                      {pos > 0 && e.RunTimeTicks ? <span className="tile-progress"><span style={{ width: `${Math.min(100, (pos / e.RunTimeTicks) * 100)}%` }} /></span> : null}
                    </button>
                    <button className="w-ep-text tile-text" onClick={() => nav.open(e.Id)}>
                      <div className="row between w-ep-title"><span className="strong">{e.Name}</span><span className="muted small">{e.RunTimeTicks ? `${Math.round(e.RunTimeTicks / 600_000_000)} min` : ""}</span></div>
                      {e.Overview && <div className="small muted w-ep-ov">{e.Overview}</div>}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        {(it.Type === "Movie" || isEpisode) && <NoSubs item={it} onDone={() => void api.details(id).then(setD)} />}
        {(it.Type === "Movie" || isEpisode) && <MediaInfo item={it} />}
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

/** No subtitles on this movie or episode: offer to fetch the best match in your languages. */
function NoSubs({ item, onDone }: { item: Details["item"]; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | string>("idle");
  const streams = item.MediaSources?.[0]?.MediaStreams ?? item.MediaStreams ?? [];
  if (streams.some((m) => m.Type === "Subtitle") && state === "idle") return null;
  async function get() {
    setState("busy");
    try {
      const langs = (await api.status()).subLangs;
      const list = await cultures().catch(() => []);
      let got = 0;
      await track(`Subtitles for ${item.Name}`, async (job) => {
        for (const l of langs) {
          const r = await api.subtitleAuto(item.Id, l, codesFor(l, list), 60);
          if (r.outcome === "downloaded" || r.outcome === "has" || r.outcome === "found") got++;
          job.update(r.outcome === "downloaded" ? `Downloaded (${l})` : r.outcome === "none" ? `Nothing found (${l})` : r.outcome === "low" ? `No good match (${l})` : `Already there (${l})`, null);
        }
      }, { reload: false });
      setState(got ? "Downloaded. It shows up once Jellyfin has looked at the folder." : "Nothing good enough found online.");
      if (got) window.setTimeout(onDone, 2500);
    } catch (e) {
      setState(String(e));
    }
  }
  return (
    <div className="w-nosubs">
      <Icon name="subtitles" />
      <span className="grow">{state === "idle" || state === "busy" ? "No subtitles yet." : state}</span>
      {(state === "idle" || state === "busy") && <button disabled={state === "busy"} onClick={() => void get()}><Icon name="download" /> {state === "busy" ? "Looking…" : "Download subtitles"}</button>}
    </div>
  );
}
