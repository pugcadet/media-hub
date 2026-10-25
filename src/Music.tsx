// Music: albums, artists and songs from Jellyfin, with a player bar. Lives under the hub
// switcher next to the media manager and the video player.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, imageUrl, MusicItem, Status } from "./api";
import { HubSwitcher } from "./Sidebar";
import { fmt } from "./Intros";
import { Icon } from "./ui";
import { logProblem } from "./activity";

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
  };
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

function Grid({ items, onOpen, round }: { items: MusicItem[]; onOpen: (m: MusicItem) => void; round?: boolean }) {
  return (
    <div className="m-grid">
      {items.map((m) => (
        <button key={m.id} className="m-tile" onClick={() => onOpen(m)}>
          <Art item={m} size={360} round={round} />
          <div className="title">{m.name}</div>
          <div className="sub">{m.kind === "artist" ? (m.count ? `${m.count} albums` : "Artist") : [m.artist, m.year].filter(Boolean).join(" · ")}</div>
        </button>
      ))}
    </div>
  );
}

function TrackList({ tracks, current, onPlay, showAlbum }: { tracks: MusicItem[]; current?: MusicItem; onPlay: (i: number) => void; showAlbum?: boolean }) {
  return (
    <div className="m-tracks">
      {tracks.map((t, i) => (
        <button key={t.id} className={`m-track ${current?.id === t.id ? "on" : ""}`} onClick={() => onPlay(i)}>
          <span className="m-num muted">{current?.id === t.id ? <Icon name="volume" size={14} /> : t.index ?? i + 1}</span>
          <span className="m-name"><span className="ellipsis">{t.name}</span><span className="muted small ellipsis">{showAlbum ? `${t.artist} · ${t.album}` : t.artist}</span></span>
          <span className="muted small mono">{t.duration ? fmt(t.duration) : ""}</span>
        </button>
      ))}
    </div>
  );
}

export default function Music({ status }: { status: Status }) {
  void status;
  const player = useMusicPlayer();
  const [tab, setTab] = useState<Tab>("recent");
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
        {source?.source === "folder" && <button className="icon-btn" title={`Music folder: ${source.folder}. Click to choose another.`} onClick={() => void useFolder(true)}><Icon name="folder" /></button>}
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
                </div>
              </div>
            </section>
            {open.kind === "artist" && albums.length > 0 && (
              <section className="stack-s">
                <h2>Albums</h2>
                <Grid items={albums} onOpen={openItem} />
              </section>
            )}
            <section className="stack-s">
              {open.kind === "artist" && <h2>Songs</h2>}
              {!tracks.length && <p className="muted">Loading songs…</p>}
              <TrackList tracks={tracks} current={cur} onPlay={(i) => player.playList(tracks, i)} showAlbum={open.kind === "artist"} />
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
            <Grid items={tiles} onOpen={openItem} round={tab === "artists" && !query} />
            {loose.length > 0 && <TrackList tracks={loose} current={cur} onPlay={(i) => player.playList(loose, i)} showAlbum />}
          </div>
        )}
      </div>

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
