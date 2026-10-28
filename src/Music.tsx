// Music: albums, artists and songs (from Jellyfin or a music folder), with a player bar.
// Lives under the hub switcher next to the media manager and the video player. The player
// itself is app-wide (musicPlayer.ts): leaving Music shows a small player at the bottom.
import { useEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, clearCache, errorText, imageUrl, MusicItem, Status } from "./api";
import { HubSwitcher } from "./Sidebar";
import { fmt } from "./Intros";
import { Icon, openMenu, type IconName, type MenuItem } from "./ui";
import { listen } from "@tauri-apps/api/event";
import { useMusicPlayer, type Player } from "./musicPlayer";
import { chooseMusicArt, editMusicInfo, artVersion } from "./MusicEdit";
import { SearchBox, Seg } from "./kit";
import { setPrefs, usePrefs } from "./prefs";
import MusicManage from "./MusicManage";

type Tab = "recent" | "albums" | "artists" | "songs" | "favorites";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "recent", label: "New", icon: "clock" },
  { id: "albums", label: "Albums", icon: "stack" },
  { id: "artists", label: "Artists", icon: "music" },
  { id: "songs", label: "Songs", icon: "list" },
  { id: "favorites", label: "Favourites", icon: "heart" },
];
const TITLE: Record<Tab, string> = { recent: "New music", albums: "Albums", artists: "Artists", songs: "Songs", favorites: "Favourites" };

interface Open {
  kind: "album" | "artist";
  item: MusicItem;
}

/** Right-click menu for a song, album or artist: play, queue, edit, picture. */
async function songsOf(m: MusicItem): Promise<MusicItem[]> {
  return m.kind === "track" ? [m] : api.musicList("tracks", m.id, null, 0, 2000);
}
function musicMenu(e: React.MouseEvent, m: MusicItem, player: Player, changed: () => void, go?: (o: Open) => void) {
  const items: MenuItem[] = [
    { label: "Play", run: () => void songsOf(m).then((l) => player.playList(l, 0)) },
    { label: "Play next", run: () => void songsOf(m).then((l) => player.playNext(l)) },
    { label: "Add to queue", run: () => void songsOf(m).then((l) => player.addToQueue(l)) },
    { sep: true },
    { label: m.kind === "track" ? "Edit song info…" : m.kind === "album" ? "Edit album info…" : "Rename artist…", run: () => void editMusicInfo(m).then((ok) => ok && changed()) },
    { label: m.kind === "artist" ? "Choose artist picture…" : "Choose album cover…", run: () => void chooseMusicArt(m).then((ok) => ok && changed()) },
  ];
  if (m.kind === "track" && m.albumId && go) {
    items.push({ sep: true }, { label: "Go to the album", run: () => go({ kind: "album", item: { ...m, id: m.albumId!, kind: "album", name: m.album } }) });
  }
  openMenu(e, items);
}

/** The queue: what's playing, what comes next. Drag to reorder, sort, remove, clear. */
function QueuePanel({ player, onClose }: { player: Player; onClose: () => void }) {
  const { st } = player;
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const upNext = st.queue.map((t, i) => ({ t, i })).filter(({ i }) => i > st.index);
  const played = st.queue.map((t, i) => ({ t, i })).filter(({ i }) => i < st.index);
  const row = ({ t, i }: { t: MusicItem; i: number }, canMove: boolean) => (
    <div
      key={`${t.id}-${i}`}
      className={`m-q-row ${i === st.index ? "on" : ""} ${over === i && drag !== null ? "over" : ""}`}
      draggable={canMove}
      onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = "move"; }}
      onDragOver={(e) => { if (drag !== null) { e.preventDefault(); setOver(i); } }}
      onDragEnd={() => { setDrag(null); setOver(null); }}
      onDrop={(e) => { e.preventDefault(); if (drag !== null && i > st.index) player.move(drag, i); setDrag(null); setOver(null); }}
    >
      {canMove ? <span className="m-q-grip" title="Drag to move"><Icon name="grip" size={14} /></span> : <span className="m-q-grip" />}
      <button className="m-q-name link-plain" onClick={() => player.jump(i)} title="Play this">
        <span className="ellipsis strong small">{t.name}</span>
        <span className="ellipsis muted small">{t.artist}{t.album ? ` · ${t.album}` : ""}</span>
      </button>
      <span className="muted small mono">{t.duration ? fmt(t.duration) : ""}</span>
      {canMove && (
        <span className="m-q-actions">
          <button className="icon-btn sm" disabled={i <= st.index + 1} onClick={() => player.move(i, i - 1)} title="Move up" aria-label="Move up"><span className="rot-up"><Icon name="chevron" size={12} /></span></button>
          <button className="icon-btn sm" disabled={i >= st.queue.length - 1} onClick={() => player.move(i, i + 1)} title="Move down" aria-label="Move down"><span className="rot-down"><Icon name="chevron" size={12} /></span></button>
          <button className="icon-btn sm" onClick={() => player.removeAt(i)} title="Remove from queue" aria-label="Remove from queue"><Icon name="x" size={12} /></button>
        </span>
      )}
    </div>
  );
  return (
    <aside className="m-queue" aria-label="Queue">
      <div className="m-q-head">
        <h2>Queue</h2>
        <span className="muted small">{st.queue.length} song{st.queue.length === 1 ? "" : "s"}</span>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} title="Close" aria-label="Close queue"><Icon name="x" /></button>
      </div>
      <div className="m-q-tools">
        <label className="sort small">Sort up next
          <select value="" onChange={(e) => { if (e.target.value) player.sortUpNext(e.target.value as "artist"); }}>
            <option value="">Choose…</option>
            <option value="artist">By artist</option>
            <option value="album">By album</option>
            <option value="title">By title</option>
            <option value="shuffle">Shuffle</option>
          </select>
        </label>
        <span className="spacer" />
        <button className="link small" disabled={!upNext.length} onClick={player.clearUpNext}>Clear up next</button>
      </div>
      <div className="m-q-list">
        {st.index >= 0 && st.queue[st.index] && <><div className="m-q-label">Now playing</div>{row({ t: st.queue[st.index], i: st.index }, false)}</>}
        <div className="m-q-label">Up next</div>
        {upNext.length ? upNext.map((x) => row(x, true)) : <p className="muted small pad">Nothing queued. Right-click a song or album → Add to queue.</p>}
        {played.length > 0 && <><div className="m-q-label">Played</div>{played.map((x) => row(x, false))}</>}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------- views */

export function Art({ item, size, round }: { item: MusicItem; size: number; round?: boolean }) {
  const v = artVersion.use();
  const [ok, setOk] = useState(item.hasArt);
  useEffect(() => setOk(item.hasArt), [item.hasArt, item.artUrl, v]);
  const src = item.artUrl ? `${item.artUrl}${v ? `?v=${v}` : ""}` : imageUrl(item.artId, "Primary", size);
  return (
    <div className={`m-art ${round ? "round" : ""}`}>
      {ok ? <img src={src} alt="" loading="lazy" onError={() => setOk(false)} /> : <div className="m-noart"><Icon name="music" size={28} /></div>}
    </div>
  );
}

const subOf = (m: MusicItem) => (m.kind === "artist" ? (m.count ? `${m.count} album${m.count === 1 ? "" : "s"}` : "Artist") : [m.artist, m.year].filter(Boolean).join(" · "));

function Grid({ items, onOpen, round, onMenu }: { items: MusicItem[]; onOpen: (m: MusicItem) => void; round?: boolean; onMenu: (e: React.MouseEvent, m: MusicItem) => void }) {
  return (
    <div className="m-grid">
      {items.map((m) => (
        <button key={m.id} className="m-tile" onClick={() => onOpen(m)} onContextMenu={(e) => onMenu(e, m)}>
          <Art item={m} size={360} round={round} />
          <div className="title">{m.name}</div>
          <div className="sub">{subOf(m)}</div>
        </button>
      ))}
    </div>
  );
}

/** Albums or artists as a list: picture, name, who, year, songs. */
function Rows({ items, onOpen, round, onMenu }: { items: MusicItem[]; onOpen: (m: MusicItem) => void; round?: boolean; onMenu: (e: React.MouseEvent, m: MusicItem) => void }) {
  return (
    <div className="m-rows">
      {items.map((m) => (
        <button key={m.id} className="m-row" onClick={() => onOpen(m)} onContextMenu={(e) => onMenu(e, m)}>
          <span className="m-row-art"><Art item={m} size={120} round={round} /></span>
          <span className="m-row-name ellipsis strong">{m.name}</span>
          <span className="m-row-who ellipsis muted">{m.kind === "artist" ? "" : m.artist}</span>
          <span className="m-row-year muted small mono">{m.year ?? ""}</span>
          <span className="m-row-count muted small">{m.kind === "artist" ? subOf(m) : m.count ? `${m.count} songs` : ""}</span>
          <span className="m-row-more" onClick={(e) => { e.stopPropagation(); onMenu(e, m); }} title="More"><Icon name="more" size={16} /></span>
        </button>
      ))}
    </div>
  );
}

function TrackList({ tracks, current, onPlay, showAlbum, player, onMenu }: { tracks: MusicItem[]; current?: MusicItem; onPlay: (i: number) => void; showAlbum?: boolean; player: Player; onMenu: (e: React.MouseEvent, m: MusicItem) => void }) {
  return (
    <div className="m-tracks">
      {tracks.map((t, i) => (
        <div key={t.id} className={`m-track ${current?.id === t.id ? "on" : ""}`} onContextMenu={(e) => onMenu(e, t)}>
          <button className="m-track-main link-plain" onClick={() => onPlay(i)}>
            <span className="m-num muted">{current?.id === t.id ? <Icon name="volume" size={14} /> : t.index ?? i + 1}</span>
            <span className="m-name"><span className="ellipsis">{t.name}</span><span className="muted small ellipsis">{showAlbum ? `${t.artist} · ${t.album}` : t.artist}</span></span>
          </button>
          <button className="icon-btn sm m-track-add" onClick={() => player.addToQueue([t])} title="Add to queue" aria-label={`Add ${t.name} to queue`}><Icon name="queue" size={14} /></button>
          <button className="icon-btn sm m-track-add" onClick={(e) => onMenu(e, t)} title="More" aria-label={`More for ${t.name}`}><Icon name="more" size={14} /></button>
          <span className="muted small mono m-dur">{t.duration ? fmt(t.duration) : ""}</span>
        </div>
      ))}
    </div>
  );
}

/** The tabs at the top, in your order (drag to change it), and Manage at the end. */
function MusicTabs({ active, onChange }: { active: Tab | "manage" | null; onChange: (t: Tab | "manage") => void }) {
  const { musicTabs } = usePrefs();
  const rank = (id: string) => { const i = musicTabs.indexOf(id); return i < 0 ? 100 + TABS.findIndex((t) => t.id === id) : i; };
  const tabs = [...TABS].sort((a, b) => rank(a.id) - rank(b.id));
  const dragged = useRef<Tab | null>(null);
  const [over, setOver] = useState<Tab | null>(null);
  const drop = (to: Tab) => {
    const from = dragged.current;
    dragged.current = null;
    setOver(null);
    if (!from || from === to) return;
    const ids = tabs.map((t) => t.id).filter((x) => x !== from);
    const fromI = tabs.findIndex((t) => t.id === from), toI = tabs.findIndex((t) => t.id === to);
    ids.splice(ids.indexOf(to) + (fromI < toI ? 1 : 0), 0, from);
    setPrefs({ musicTabs: ids });
  };
  return (
    <nav className="w-tabs m-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={active === t.id} className={`${active === t.id ? "on" : ""} ${over === t.id ? "drop" : ""}`}
          onClick={() => onChange(t.id)} draggable title="Drag to change the order"
          onDragStart={(e) => { dragged.current = t.id; e.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(e) => { if (dragged.current && dragged.current !== t.id) { e.preventDefault(); setOver(t.id); } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); drop(t.id); }}
          onDragEnd={() => { dragged.current = null; setOver(null); }}>
          <Icon name={t.icon} size={15} /> {t.label}
        </button>
      ))}
      <span className="m-tabs-sep" />
      <button role="tab" aria-selected={active === "manage"} className={active === "manage" ? "on" : ""} onClick={() => onChange("manage")} title="Fix names and pictures, choose where your music comes from">
        <Icon name="wrench" size={15} /> Manage
      </button>
    </nav>
  );
}

export default function Music({ status }: { status: Status }) {
  void status;
  const player = useMusicPlayer();
  const [tab, setTab] = usePageState<Tab | "manage">("music.tab", "recent");
  const [view, setView] = usePageState<"grid" | "list">("music.view", "grid");
  const [items, setItems] = useState<MusicItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [tracks, setTracks] = useState<MusicItem[]>([]);
  const [albums, setAlbums] = useState<MusicItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [srcN, setSrcN] = useState(0);
  const [showQueue, setShowQueue] = useState(false);
  const [quiet, setQuiet] = useState(0);
  const changed = () => {
    clearCache();
    setSrcN((n) => n + 1);
  };
  // The music folder's tags are read in the background (and edits saved); show the result.
  useEffect(() => {
    const un = listen("music-updated", () => { clearCache(); setQuiet((n) => n + 1); });
    return () => void un.then((f) => f());
  }, []);

  const listTab: Tab = tab === "manage" ? "recent" : tab;
  const load = (quietly: boolean) => {
    const v = query ? "search" : listTab;
    if (!quietly) setItems(null);
    api.musicList(v, null, query || null, 0, v === "songs" ? 3000 : 1000).then(setItems).catch((e) => !quietly && setError(errorText(e)));
  };
  useEffect(() => {
    if (quiet) load(true);
  }, [quiet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === "manage" && !query) return;
    setError(null);
    const t = setTimeout(() => load(false), query ? 250 : 0);
    return () => clearTimeout(t);
  }, [tab, query, srcN]); // eslint-disable-line react-hooks/exhaustive-deps

  // The album or artist that's open, again after a change (names may have changed).
  useEffect(() => {
    if (!open) return;
    api.musicList("tracks", open.item.id, null, 0, 2000).then((t) => {
      setTracks(t);
      player.refreshItems(t);
      if (open.kind === "album" && t[0] && (t[0].album !== open.item.name || t[0].artist !== open.item.artist || t[0].year !== open.item.year)) {
        setOpen({ ...open, item: { ...open.item, name: t[0].album, artist: t[0].artist, year: t[0].year } });
      }
    }).catch((e) => setError(errorText(e)));
    if (open.kind === "artist") api.musicList("artist_albums", open.item.id, null, 0, 300).then(setAlbums).catch(() => undefined);
  }, [open?.item.id, srcN, quiet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setTracks([]);
    setAlbums([]);
  }, [open?.item.id]);

  const openItem = (m: MusicItem) => {
    if (m.kind === "track") return player.playList([m], 0);
    setOpen({ kind: m.kind === "artist" ? "artist" : "album", item: m });
  };
  const menu = (e: React.MouseEvent, m: MusicItem) => musicMenu(e, m, player, () => {
    // A renamed artist gets a new id: back to the list.
    if (open?.kind === "artist" && m.id === open.item.id) setOpen(null);
    changed();
  }, (o) => setOpen(o));

  // Space plays/pauses (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === " ") { e.preventDefault(); player.toggle(); }
      else if (e.key === "ArrowRight" && e.shiftKey) player.next();
      else if (e.key === "ArrowLeft" && e.shiftKey) player.prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cur = player.current;
  const st = player.st;
  const loose = (items ?? []).filter((m) => m.kind === "track");
  const tiles = (items ?? []).filter((m) => m.kind !== "track");
  const round = listTab === "artists" && !query;
  const manage = tab === "manage" && !open && !query;

  return (
    <div className="music">
      <header className="w-top">
        <HubSwitcher />
        <MusicTabs active={open || query ? null : tab} onChange={(t) => { setTab(t); setOpen(null); setQuery(""); }} />
        <div className="spacer" />
        {!manage && <Seg icons value={view} onChange={setView} options={[{ id: "grid", label: "Tiles", title: "Tiles", icon: "grid" }, { id: "list", label: "List", title: "List", icon: "list" }]} />}
        <div className="w-search"><SearchBox value={query} onChange={(v) => { setQuery(v); setOpen(null); }} placeholder="Search music" /></div>
      </header>

      <div className="w-page m-page">
        {error && <p className="error pad">{error}</p>}
        {manage ? (
          <MusicManage onChanged={changed} />
        ) : open ? (
          <div className="pg">
            <button className="link small" onClick={() => setOpen(null)}>← Back</button>
            <section className="m-hero">
              <Art item={open.item} size={600} round={open.kind === "artist"} />
              <div className="stack-s">
                <div className="muted small">{open.kind === "artist" ? "Artist" : "Album"}</div>
                <h1>{open.item.name}</h1>
                <div className="muted">{open.kind === "album" ? [open.item.artist, open.item.year, `${tracks.length} songs`].filter(Boolean).join(" · ") : `${albums.length} albums · ${tracks.length} songs`}</div>
                <div className="row">
                  <button className="primary bb-btn" disabled={!tracks.length} onClick={() => player.playList(tracks, 0)}><Icon name="play" /> Play</button>
                  <button className="bb-btn ghost" disabled={!tracks.length} onClick={() => player.playList(tracks, 0, true)}><Icon name="shuffle" /> Shuffle</button>
                  <button className="bb-btn ghost" disabled={!tracks.length} onClick={() => player.playNext(tracks)}>Play next</button>
                  <button className="bb-btn ghost" disabled={!tracks.length} onClick={() => player.addToQueue(tracks)}><Icon name="queue" /> Add to queue</button>
                  <button className="icon-btn" title={open.kind === "artist" ? "Rename artist" : "Edit album info"} aria-label="Edit" onClick={() => void editMusicInfo(open.item).then((ok) => { if (!ok) return; if (open.kind === "artist") setOpen(null); changed(); })}><Icon name="rename" /></button>
                  <button className="icon-btn" title={open.kind === "artist" ? "Choose artist picture" : "Choose album cover"} aria-label="Picture" onClick={() => void chooseMusicArt(open.item).then((ok) => ok && changed())}><Icon name="image" /></button>
                </div>
              </div>
            </section>
            {open.kind === "artist" && albums.length > 0 && (
              <section className="stack-s">
                <h2>Albums</h2>
                {view === "list" ? <Rows items={albums} onOpen={openItem} onMenu={menu} /> : <Grid items={albums} onOpen={openItem} onMenu={menu} />}
              </section>
            )}
            <section className="stack-s">
              {open.kind === "artist" && <h2>Songs</h2>}
              {!tracks.length && <p className="muted">Loading songs…</p>}
              <TrackList tracks={tracks} current={cur} onPlay={(i) => player.playList(tracks, i)} showAlbum={open.kind === "artist"} player={player} onMenu={menu} />
            </section>
          </div>
        ) : (
          <div className="pg">
            <div className="pg-head">
              <h1>{query ? `“${query}”` : TITLE[listTab]}</h1>
              {loose.length > 0 && <div className="pg-actions">
                <button onClick={() => player.playList(loose, 0)}><Icon name="play" /> Play all</button>
                <button className="primary" onClick={() => player.playList(loose, 0, true)}><Icon name="shuffle" /> Shuffle</button>
              </div>}
            </div>
            {items === null && !error && <div className="m-loading"><span className="spinner big" /> Loading music…</div>}
            {items && items.length === 0 && (
              <div className="m-empty">
                <Icon name="music" size={36} />
                <p>{query ? "Nothing found." : "No music here yet. Choose where your music comes from under Manage."}</p>
                {!query && <button className="primary" onClick={() => setTab("manage")}><Icon name="wrench" /> Manage</button>}
              </div>
            )}
            {view === "list" ? <Rows items={tiles} onOpen={openItem} round={round} onMenu={menu} /> : <Grid items={tiles} onOpen={openItem} round={round} onMenu={menu} />}
            {loose.length > 0 && <TrackList tracks={loose} current={cur} onPlay={(i) => player.playList(loose, i)} showAlbum player={player} onMenu={menu} />}
          </div>
        )}
      </div>

      {showQueue && <QueuePanel player={player} onClose={() => setShowQueue(false)} />}
      <footer className={`m-bar ${cur ? "" : "empty"}`}>
        {cur ? (
          <>
            <div className="m-now">
              <Art item={cur} size={120} />
              <div className="names">
                <div className="strong ellipsis">{cur.name}</div>
                <div className="muted small ellipsis">{cur.artist}{cur.album ? ` · ${cur.album}` : ""}</div>
              </div>
            </div>
            <div className="m-controls">
              <div className="row">
                <button className="p-round sm" onClick={player.prev} aria-label="Previous"><Icon name="prev" size={14} /></button>
                <button className="p-play" onClick={player.toggle} aria-label={st.playing ? "Pause" : "Play"}>
                  {st.loading ? <span className="spinner" /> : <Icon name={st.playing ? "pause" : "play"} size={18} />}
                </button>
                <button className="p-round sm" onClick={player.next} aria-label="Next" disabled={st.index + 1 >= st.queue.length}><Icon name="next" size={14} /></button>
              </div>
              <div className="m-seek">
                <span className="mono small muted">{fmt(st.time)}</span>
                <input type="range" min={0} max={st.duration || cur.duration || 1} step={1} value={st.time} onChange={(e) => player.seek(Number(e.target.value))} aria-label="Position" />
                <span className="mono small muted">{fmt(st.duration || cur.duration)}</span>
              </div>
              {st.error && <div className="error small">{st.error}</div>}
            </div>
            <div className="m-right">
              <button className={`icon-btn ${showQueue ? "on" : ""}`} onClick={() => setShowQueue(!showQueue)} title="Queue" aria-label="Queue"><Icon name="queue" /></button>
              <span className="muted small">{st.index + 1} of {st.queue.length}</span>
              <Icon name="volume" />
              <input type="range" min={0} max={1} step={0.05} value={st.volume} onChange={(e) => player.setVolume(Number(e.target.value))} aria-label="Volume" className="p-vol" />
            </div>
          </>
        ) : <span className="muted small">Pick an album or a song to start.</span>}
      </footer>
    </div>
  );
}
