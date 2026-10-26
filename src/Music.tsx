// Music: albums, artists and songs from Jellyfin, with a player bar. Lives under the hub
// switcher next to the media manager and the video player.
import { useCallback, useEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, errorText, imageUrl, MusicItem, Status } from "./api";
import { HubSwitcher } from "./Sidebar";
import { fmt } from "./Intros";
import { Icon, openMenu, type MenuItem } from "./ui";
import { followEvent, logProblem, track } from "./activity";
import { listen } from "@tauri-apps/api/event";

type Tab = "recent" | "albums" | "artists" | "favorites";

interface Open {
  kind: "album" | "artist";
  item: MusicItem;
}

/* ------------------------------------------------------------ player engine */

interface PlayerState {
  queue: MusicItem[];
  index: number;
  playing: boolean;
  loading: boolean;
  time: number;
  duration: number;
  shuffle: boolean;
  volume: number;
  error: string | null;
}

function useMusicPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const cache = useRef(new Map<string, string>()); // track id -> blob url
  const tokens = useRef<string[]>([]);
  const [st, setSt] = useState<PlayerState>({ queue: [], index: -1, playing: false, loading: false, time: 0, duration: 0, shuffle: false, volume: 0.9, error: null });

  useEffect(() => {
    const a = new Audio();
    a.preload = "auto";
    audio.current = a;
    const on = (ev: string, f: () => void) => a.addEventListener(ev, f);
    on("timeupdate", () => setSt((s) => ({ ...s, time: a.currentTime, duration: Number.isFinite(a.duration) ? a.duration : s.duration })));
    on("play", () => setSt((s) => ({ ...s, playing: true })));
    on("pause", () => setSt((s) => ({ ...s, playing: false })));
    on("waiting", () => setSt((s) => ({ ...s, loading: true })));
    on("playing", () => setSt((s) => ({ ...s, loading: false })));
    on("ended", () => setSt((s) => ({ ...s, index: s.index + 1 < s.queue.length ? s.index + 1 : s.index, playing: s.index + 1 < s.queue.length })));
    return () => {
      a.pause();
      cache.current.forEach((u) => URL.revokeObjectURL(u));
      tokens.current.forEach((t) => void api.musicStop(t).catch(() => undefined));
    };
  }, []);

  const fetchTrack = useCallback(async (t: MusicItem): Promise<string> => {
    const hit = cache.current.get(t.id);
    if (hit) return hit;
    const url = await api.musicPlay(t.id);
    tokens.current.push(url.split("/s/")[1]?.split("/")[0] ?? "");
    const blob = await (await fetch(url)).blob();
    const u = URL.createObjectURL(blob);
    cache.current.set(t.id, u);
    // Keep memory small: only the last few songs.
    if (cache.current.size > 6) {
      const [k, v] = cache.current.entries().next().value as [string, string];
      URL.revokeObjectURL(v);
      cache.current.delete(k);
    }
    return u;
  }, []);

  // Load the current song; fetch the next one in the background.
  const current = st.queue[st.index];
  useEffect(() => {
    const a = audio.current;
    if (!a || !current) return;
    let alive = true;
    setSt((s) => ({ ...s, loading: true, error: null, time: 0, duration: current.duration }));
    fetchTrack(current)
      .then((u) => {
        if (!alive) return;
        a.src = u;
        return a.play();
      })
      .then(() => {
        const next = st.queue[st.index + 1];
        if (next) void fetchTrack(next).catch(() => undefined);
      })
      .catch((e) => {
        if (!alive) return;
        const msg = errorText(e);
        logProblem("Music", msg);
        setSt((s) => ({ ...s, loading: false, error: msg }));
      });
    return () => {
      alive = false;
    };
  }, [current?.id, st.index]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (audio.current) audio.current.volume = st.volume;
  }, [st.volume]);

  return {
    st,
    current,
    playList(list: MusicItem[], start = 0, shuffle = false) {
      let q = list.filter((t) => t.kind === "track");
      let i = Math.max(0, Math.min(start, q.length - 1));
      if (shuffle) {
        q = [...q].sort(() => Math.random() - 0.5);
        i = 0;
      }
      setSt((s) => ({ ...s, queue: q, index: q.length ? i : -1, shuffle }));
    },
    toggle() {
      const a = audio.current;
      if (!a || !current) return;
      if (a.paused) void a.play();
      else a.pause();
    },
    next() {
      setSt((s) => (s.index + 1 < s.queue.length ? { ...s, index: s.index + 1 } : s));
    },
    prev() {
      const a = audio.current;
      if (a && a.currentTime > 4) {
        a.currentTime = 0;
        return;
      }
      setSt((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
    },
    seek(t: number) {
      if (audio.current) audio.current.currentTime = t;
    },
    setVolume(v: number) {
      setSt((s) => ({ ...s, volume: v }));
    },
    jump(i: number) {
      setSt((s) => ({ ...s, index: i }));
    },
    /** Adds songs at the end of the queue (starts playing if nothing is). */
    addToQueue(list: MusicItem[]) {
      const add = list.filter((t) => t.kind === "track");
      setSt((s) => ({ ...s, queue: [...s.queue, ...add], index: s.index < 0 && add.length ? s.queue.length : s.index }));
    },
    /** Puts songs right after the one playing. */
    playNext(list: MusicItem[]) {
      const add = list.filter((t) => t.kind === "track");
      setSt((s) => {
        if (s.index < 0) return { ...s, queue: add, index: add.length ? 0 : -1 };
        const q = [...s.queue];
        q.splice(s.index + 1, 0, ...add);
        return { ...s, queue: q };
      });
    },
    removeAt(i: number) {
      setSt((s) => {
        if (i === s.index) return s;
        const q = s.queue.filter((_, n) => n !== i);
        return { ...s, queue: q, index: i < s.index ? s.index - 1 : s.index };
      });
    },
    move(from: number, to: number) {
      setSt((s) => {
        if (from === to || from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length) return s;
        const q = [...s.queue];
        const [x] = q.splice(from, 1);
        q.splice(to, 0, x);
        let index = s.index;
        if (from === s.index) index = to;
        else if (from < s.index && to >= s.index) index--;
        else if (from > s.index && to <= s.index) index++;
        return { ...s, queue: q, index };
      });
    },
    /** Empties "up next" (the song playing stays). */
    clearUpNext() {
      setSt((s) => ({ ...s, queue: s.index >= 0 ? [s.queue[s.index]] : [], index: s.index >= 0 ? 0 : -1 }));
    },
    /** Sorts the songs after the one playing. */
    sortUpNext(by: "artist" | "album" | "title" | "shuffle") {
      setSt((s) => {
        const head = s.queue.slice(0, s.index + 1);
        let rest = s.queue.slice(s.index + 1);
        const k = (t: MusicItem) => by === "artist" ? `${t.artist}\u0000${t.album}\u0000${String(t.disc ?? 0).padStart(2, "0")}${String(t.index ?? 0).padStart(3, "0")}` : by === "album" ? `${t.album}\u0000${String(t.disc ?? 0).padStart(2, "0")}${String(t.index ?? 0).padStart(3, "0")}` : t.name;
        rest = by === "shuffle" ? [...rest].sort(() => Math.random() - 0.5) : [...rest].sort((a, b) => k(a).localeCompare(k(b), undefined, { numeric: true, sensitivity: "base" }));
        return { ...s, queue: [...head, ...rest] };
      });
    },
  };
}

type Player = ReturnType<typeof useMusicPlayer>;

/** Right-click menu for a song, album or artist: play, play next, add to the queue. */
async function songsOf(m: MusicItem): Promise<MusicItem[]> {
  return m.kind === "track" ? [m] : api.musicList("tracks", m.id, null, 0, 2000);
}
function queueMenu(e: React.MouseEvent, m: MusicItem, player: Player) {
  const items: MenuItem[] = [
    { label: "Play", run: () => void songsOf(m).then((l) => player.playList(l, 0)) },
    { label: "Play next", run: () => void songsOf(m).then((l) => player.playNext(l)) },
    { label: "Add to queue", run: () => void songsOf(m).then((l) => player.addToQueue(l)) },
  ];
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

function Art({ item, size, round }: { item: MusicItem; size: number; round?: boolean }) {
  const [ok, setOk] = useState(item.hasArt);
  return (
    <div className={`m-art ${round ? "round" : ""}`}>
      {ok ? <img src={item.artUrl ?? imageUrl(item.artId, "Primary", size)} alt="" loading="lazy" onError={() => setOk(false)} /> : <div className="m-noart"><Icon name="music" size={28} /></div>}
    </div>
  );
}

function Grid({ items, onOpen, round, player }: { items: MusicItem[]; onOpen: (m: MusicItem) => void; round?: boolean; player: Player }) {
  return (
    <div className="m-grid">
      {items.map((m) => (
        <button key={m.id} className="m-tile" onClick={() => onOpen(m)} onContextMenu={(e) => queueMenu(e, m, player)}>
          <Art item={m} size={360} round={round} />
          <div className="title">{m.name}</div>
          <div className="sub">{m.kind === "artist" ? (m.count ? `${m.count} albums` : "Artist") : [m.artist, m.year].filter(Boolean).join(" · ")}</div>
        </button>
      ))}
    </div>
  );
}

function TrackList({ tracks, current, onPlay, showAlbum, player }: { tracks: MusicItem[]; current?: MusicItem; onPlay: (i: number) => void; showAlbum?: boolean; player: Player }) {
  return (
    <div className="m-tracks">
      {tracks.map((t, i) => (
        <div key={t.id} className={`m-track ${current?.id === t.id ? "on" : ""}`} onContextMenu={(e) => queueMenu(e, t, player)}>
          <button className="m-track-main link-plain" onClick={() => onPlay(i)}>
            <span className="m-num muted">{current?.id === t.id ? <Icon name="volume" size={14} /> : t.index ?? i + 1}</span>
            <span className="m-name"><span className="ellipsis">{t.name}</span><span className="muted small ellipsis">{showAlbum ? `${t.artist} · ${t.album}` : t.artist}</span></span>
          </button>
          <button className="icon-btn sm m-track-add" onClick={() => player.addToQueue([t])} title="Add to queue" aria-label={`Add ${t.name} to queue`}><Icon name="queue" size={14} /></button>
          <span className="muted small mono m-dur">{t.duration ? fmt(t.duration) : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default function Music({ status }: { status: Status }) {
  void status;
  const player = useMusicPlayer();
  const [tab, setTab] = usePageState<Tab>("music.tab", "recent");
  const [items, setItems] = useState<MusicItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(null);
  const [tracks, setTracks] = useState<MusicItem[]>([]);
  const [albums, setAlbums] = useState<MusicItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{ folder: string | null; source: "jellyfin" | "folder" } | null>(null);
  const [srcN, setSrcN] = useState(0);
  useEffect(() => void api.musicSource().then(setSource).catch(() => setSource(null)), [srcN]);
  async function useFolder(pick: boolean) {
    setError(null);
    try {
      if (pick || !source?.folder) {
        const f = await api.pickMusicFolder();
        if (!f) return;
      } else {
        await api.setMusicSource(true);
      }
      setOpen(null);
      setSrcN((n) => n + 1);
    } catch (e) {
      setError(errorText(e));
    }
  }
  const useJellyfin = () => void api.setMusicSource(false).then(() => { setOpen(null); setSrcN((n) => n + 1); });
  const [showQueue, setShowQueue] = useState(false);
  const [quiet, setQuiet] = useState(0);
  // The music folder's tags are read in the background; show the result when it's done.
  useEffect(() => {
    const un = listen("music-updated", () => setQuiet((n) => n + 1));
    return () => void un.then((f) => f());
  }, []);
  /** Album covers and artist pictures: online for a music folder, through Jellyfin's own sources otherwise. */
  function findArt() {
    if (source?.source === "folder") {
      void track("Finding album covers and artist pictures", async (job) => {
        const un = await followEvent(job, "music-art-progress");
        try {
          const r = await api.musicFetchArt();
          job.update(`${r.covers} covers, ${r.artists} artist pictures found${r.missingCovers ? ` · ${r.missingCovers} albums have none online` : ""}`, 1);
        } finally {
          un();
        }
        setSrcN((x) => x + 1);
      }, { reload: false, stop: "musicart" }).catch((e) => setError(errorText(e)));
      return;
    }
    void track("Finding missing album and artist art in Jellyfin", async (job) => {
      const albums = (await api.musicList("albums", null, null, 0, 5000)).filter((a) => !a.hasArt);
      const artists = (await api.musicList("artists", null, null, 0, 5000)).filter((a) => !a.hasArt);
      const all = [...albums, ...artists];
      let n = 0;
      for (const [i, m] of all.entries()) {
        if (job.cancelled) break;
        job.update(m.name, i / Math.max(1, all.length));
        n += (await api.fillMissingArt(m.id, ["Primary"]).catch(() => [])).length;
      }
      job.update(`${n} pictures added (Jellyfin uses MusicBrainz and TheAudioDB)`, 1);
      setSrcN((x) => x + 1);
    }, { reload: false, cancellable: true }).catch((e) => setError(errorText(e)));
  }

  function refresh() {
    if (source?.source === "folder") {
      void track("Reading the music folder", async (job) => {
        const n = await api.musicRescan();
        job.update(`${n.toLocaleString()} songs`, 1);
        setSrcN((x) => x + 1);
      }, { reload: false }).catch((e) => setError(errorText(e)));
    } else setSrcN((x) => x + 1);
  }

  useEffect(() => {
    if (!quiet) return;
    const view = query ? "search" : tab;
    api.musicList(view, null, query || null, 0, 600).then(setItems).catch(() => undefined);
  }, [quiet]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setItems(null);
    setError(null);
    const t = setTimeout(() => {
      const view = query ? "search" : tab;
      api.musicList(view, null, query || null, 0, 600).then(setItems).catch((e) => setError(errorText(e)));
    }, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [tab, query, srcN]);

  useEffect(() => {
    setTracks([]);
    setAlbums([]);
    if (!open) return;
    api.musicList("tracks", open.item.id, null, 0, 1000).then(setTracks).catch((e) => setError(errorText(e)));
    if (open.kind === "artist") api.musicList("artist_albums", open.item.id, null, 0, 200).then(setAlbums).catch(() => undefined);
  }, [open]);

  const openItem = (m: MusicItem) => {
    if (m.kind === "track") return player.playList([m], 0);
    setOpen({ kind: m.kind === "artist" ? "artist" : "album", item: m });
  };

  // Space plays/pauses (unless typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
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

  return (
    <div className="music">
      <header className="w-top">
        <HubSwitcher />
        <nav className="w-tabs">
          {([["recent", "New"], ["albums", "Albums"], ["artists", "Artists"], ["favorites", "Favourites"]] as [Tab, string][]).map(([t, l]) => (
            <button key={t} className={tab === t && !open && !query ? "on" : ""} onClick={() => { setTab(t); setOpen(null); setQuery(""); }}>{l}</button>
          ))}
        </nav>
        <div className="spacer" />
        <div className="seg m-source" title={source?.folder ?? ""}>
          <button className={source?.source !== "folder" ? "on" : ""} onClick={useJellyfin}>Jellyfin</button>
          <button className={source?.source === "folder" ? "on" : ""} onClick={() => void useFolder(false)}>Music folder</button>
        </div>
        {source?.source === "folder" && <button className="icon-btn" title={`Music folder: ${source.folder}. Click to choose another.`} aria-label="Choose music folder" onClick={() => void useFolder(true)}><Icon name="folder" /></button>}
        <button className="icon-btn" title="Find missing album covers and artist pictures online (MusicBrainz, Deezer)" aria-label="Find covers" onClick={findArt}><Icon name="image" /></button>
        <button className="icon-btn" title={source?.source === "folder" ? "Read the music folder again (new songs, tags, covers)" : "Reload"} aria-label="Refresh music" onClick={refresh}><Icon name="reload" /></button>
        <label className="searchbox w-search"><Icon name="search" /><input placeholder="Search music" value={query} onChange={(e) => { setQuery(e.target.value); setOpen(null); }} /></label>
      </header>

      <div className="w-page m-page">
        {error && <p className="error pad">{error}</p>}
        {open ? (
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
                </div>
              </div>
            </section>
            {open.kind === "artist" && albums.length > 0 && (
              <section className="stack-s">
                <h2>Albums</h2>
                <Grid items={albums} onOpen={openItem} player={player} />
              </section>
            )}
            <section className="stack-s">
              {open.kind === "artist" && <h2>Songs</h2>}
              {!tracks.length && <p className="muted">Loading songs…</p>}
              <TrackList tracks={tracks} current={cur} onPlay={(i) => player.playList(tracks, i)} showAlbum={open.kind === "artist"} player={player} />
            </section>
          </div>
        ) : (
          <div className="pg">
            <div className="pg-head">
              <h1>{query ? `“${query}”` : tab === "recent" ? "New music" : tab === "albums" ? "Albums" : tab === "artists" ? "Artists" : "Favourites"}</h1>
              {loose.length > 0 && <div className="pg-actions"><button className="primary" onClick={() => player.playList(loose, 0, true)}><Icon name="shuffle" /> Shuffle songs</button></div>}
            </div>
            {items === null && !error && <div className="m-loading"><span className="spinner big" /> Loading music…</div>}
            {items && items.length === 0 && (
              <div className="m-empty">
                <Icon name="music" size={36} />
                {source?.source === "folder" ? <p>No music found in {source.folder}. Folders like Artist / Album / 01 - Song.mp3 work best.</p> : <p>No music in Jellyfin. Music doesn't need Jellyfin: play it straight from a folder on this computer or the NAS.</p>}
                <button className="primary" onClick={() => void useFolder(true)}><Icon name="folder" /> Choose a music folder</button>
              </div>
            )}
            <Grid items={tiles} onOpen={openItem} round={tab === "artists" && !query} player={player} />
            {loose.length > 0 && <TrackList tracks={loose} current={cur} onPlay={(i) => player.playList(loose, i)} showAlbum player={player} />}
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
