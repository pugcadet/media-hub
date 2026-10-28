// The music player, for the whole app: it keeps playing when you leave Music (a small player
// shows at the bottom of every screen) and answers the keyboard's media keys and the system's
// "Now playing" controls.
import { useSyncExternalStore } from "react";
import { api, errorText, imageUrl, MusicItem } from "./api";
import { logProblem } from "./activity";

export interface PlayerState {
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

let st: PlayerState = { queue: [], index: -1, playing: false, loading: false, time: 0, duration: 0, shuffle: false, volume: 0.9, error: null };
const subs = new Set<() => void>();
const cache = new Map<string, string>(); // track id -> blob url
const tokens: string[] = [];
let audio: HTMLAudioElement | null = null;
let loadedId: string | null = null;
let loadSeq = 0;

function emit() {
  subs.forEach((f) => f());
}

function set(p: Partial<PlayerState> | ((s: PlayerState) => PlayerState)) {
  st = typeof p === "function" ? p(st) : { ...st, ...p };
  emit();
  const cur = st.queue[st.index];
  if ((cur?.id ?? null) !== loadedId) void load(cur);
}

function el(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "auto";
  a.volume = st.volume;
  const on = (ev: string, f: () => void) => a.addEventListener(ev, f);
  // Time updates often; only tell the screens about whole seconds.
  on("timeupdate", () => {
    const d = Number.isFinite(a.duration) ? a.duration : st.duration;
    if (Math.floor(a.currentTime) !== Math.floor(st.time) || d !== st.duration) {
      st = { ...st, time: a.currentTime, duration: d };
      emit();
      positionState();
    }
  });
  on("play", () => { set({ playing: true }); playbackState(); });
  on("pause", () => { set({ playing: false }); playbackState(); });
  on("waiting", () => set({ loading: true }));
  on("playing", () => set({ loading: false }));
  on("ended", () => set((s) => ({ ...s, index: s.index + 1 < s.queue.length ? s.index + 1 : s.index, playing: s.index + 1 < s.queue.length })));
  audio = a;
  setupMediaSession();
  return a;
}

async function fetchTrack(t: MusicItem): Promise<string> {
  const hit = cache.get(t.id);
  if (hit) return hit;
  const url = await api.musicPlay(t.id);
  tokens.push(url.split("/s/")[1]?.split("/")[0] ?? "");
  const blob = await (await fetch(url)).blob();
  const u = URL.createObjectURL(blob);
  cache.set(t.id, u);
  // Keep memory small: only the last few songs.
  if (cache.size > 6) {
    const [k, v] = cache.entries().next().value as [string, string];
    if (k !== loadedId) {
      URL.revokeObjectURL(v);
      cache.delete(k);
    }
  }
  return u;
}

/** Loads the current song; fetches the next one in the background. */
async function load(cur: MusicItem | undefined) {
  const a = el();
  loadedId = cur?.id ?? null;
  const seq = ++loadSeq;
  if (!cur) {
    a.pause();
    a.removeAttribute("src");
    metadata();
    return;
  }
  st = { ...st, loading: true, error: null, time: 0, duration: cur.duration };
  emit();
  metadata();
  try {
    const u = await fetchTrack(cur);
    if (seq !== loadSeq) return;
    a.src = u;
    await a.play();
    const next = st.queue[st.index + 1];
    if (next) void fetchTrack(next).catch(() => undefined);
  } catch (e) {
    if (seq !== loadSeq) return;
    const msg = errorText(e);
    logProblem("Music", msg);
    set({ loading: false, error: msg });
  }
}

/* ---------------------------------------------------- media keys / now playing */

function artOf(t: MusicItem): string | null {
  return t.artUrl ?? (t.hasArt ? imageUrl(t.artId, "Primary", 512) : null);
}

function metadata() {
  if (!("mediaSession" in navigator)) return;
  const cur = st.queue[st.index];
  try {
    navigator.mediaSession.metadata = cur
      ? new MediaMetadata({ title: cur.name, artist: cur.artist, album: cur.album, artwork: artOf(cur) ? [{ src: artOf(cur)!, sizes: "512x512" }] : [] })
      : null;
  } catch { /* not supported here */ }
}

function playbackState() {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = st.queue[st.index] ? (audio?.paused ? "paused" : "playing") : "none";
}

function positionState() {
  if (!("mediaSession" in navigator) || !audio || !Number.isFinite(audio.duration)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: 1 });
  } catch { /* ignore */ }
}

function setupMediaSession() {
  if ("mediaSession" in navigator) {
    const h = (a: MediaSessionAction, f: MediaSessionActionHandler) => {
      try { navigator.mediaSession.setActionHandler(a, f); } catch { /* not supported */ }
    };
    h("play", () => void audio?.play());
    h("pause", () => audio?.pause());
    h("nexttrack", () => music.next());
    h("previoustrack", () => music.prev());
    h("seekto", (d) => { if (d.seekTime != null) music.seek(d.seekTime); });
    h("seekforward", () => music.seek((audio?.currentTime ?? 0) + 10));
    h("seekbackward", () => music.seek((audio?.currentTime ?? 0) - 10));
    h("stop", () => music.stop());
  }
  // Some systems hand the media keys to the window as key presses instead.
  window.addEventListener("keydown", (e) => {
    if (!st.queue.length) return;
    if (e.key === "MediaPlayPause") { e.preventDefault(); music.toggle(); }
    else if (e.key === "MediaTrackNext") { e.preventDefault(); music.next(); }
    else if (e.key === "MediaTrackPrevious") { e.preventDefault(); music.prev(); }
    else if (e.key === "MediaStop") { e.preventDefault(); music.stop(); }
  });
}

/* ------------------------------------------------------------------- actions */

export const music = {
  playList(list: MusicItem[], start = 0, shuffle = false) {
    let q = list.filter((t) => t.kind === "track");
    let i = Math.max(0, Math.min(start, q.length - 1));
    if (shuffle) {
      q = [...q].sort(() => Math.random() - 0.5);
      i = 0;
    }
    el();
    loadedId = null; // the same song again starts over
    set((s) => ({ ...s, queue: q, index: q.length ? i : -1, shuffle }));
  },
  toggle() {
    const a = el();
    if (!st.queue[st.index]) return;
    if (a.paused) void a.play();
    else a.pause();
  },
  pause() {
    audio?.pause();
  },
  next() {
    set((s) => (s.index + 1 < s.queue.length ? { ...s, index: s.index + 1 } : s));
  },
  prev() {
    const a = el();
    if (a.currentTime > 4) {
      a.currentTime = 0;
      return;
    }
    set((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  },
  seek(t: number) {
    const a = el();
    a.currentTime = Math.max(0, t);
  },
  setVolume(v: number) {
    el().volume = v;
    set({ volume: v });
  },
  jump(i: number) {
    set({ index: i });
  },
  /** Stops and empties the queue (the small player goes away). */
  stop() {
    audio?.pause();
    set({ queue: [], index: -1, playing: false, loading: false, time: 0, error: null });
    playbackState();
  },
  /** Adds songs at the end of the queue (starts playing if nothing is). */
  addToQueue(list: MusicItem[]) {
    const add = list.filter((t) => t.kind === "track");
    el();
    set((s) => ({ ...s, queue: [...s.queue, ...add], index: s.index < 0 && add.length ? s.queue.length : s.index }));
  },
  /** Puts songs right after the one playing. */
  playNext(list: MusicItem[]) {
    const add = list.filter((t) => t.kind === "track");
    el();
    set((s) => {
      if (s.index < 0) return { ...s, queue: add, index: add.length ? 0 : -1 };
      const q = [...s.queue];
      q.splice(s.index + 1, 0, ...add);
      return { ...s, queue: q };
    });
  },
  removeAt(i: number) {
    set((s) => {
      if (i === s.index) return s;
      const q = s.queue.filter((_, n) => n !== i);
      return { ...s, queue: q, index: i < s.index ? s.index - 1 : s.index };
    });
  },
  move(from: number, to: number) {
    set((s) => {
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
    set((s) => ({ ...s, queue: s.index >= 0 ? [s.queue[s.index]] : [], index: s.index >= 0 ? 0 : -1 }));
  },
  /** Sorts the songs after the one playing. */
  sortUpNext(by: "artist" | "album" | "title" | "shuffle") {
    set((s) => {
      const head = s.queue.slice(0, s.index + 1);
      let rest = s.queue.slice(s.index + 1);
      const k = (t: MusicItem) => by === "artist" ? `${t.artist}\u0000${t.album}\u0000${String(t.disc ?? 0).padStart(2, "0")}${String(t.index ?? 0).padStart(3, "0")}` : by === "album" ? `${t.album}\u0000${String(t.disc ?? 0).padStart(2, "0")}${String(t.index ?? 0).padStart(3, "0")}` : t.name;
      rest = by === "shuffle" ? [...rest].sort(() => Math.random() - 0.5) : [...rest].sort((a, b) => k(a).localeCompare(k(b), undefined, { numeric: true, sensitivity: "base" }));
      return { ...s, queue: [...head, ...rest] };
    });
  },
  /** After an edit: the queue shows the new names. */
  refreshItems(fresh: MusicItem[]) {
    const by = new Map(fresh.map((t) => [t.id, t]));
    if (!st.queue.some((t) => by.has(t.id))) return;
    set((s) => ({ ...s, queue: s.queue.map((t) => by.get(t.id) ?? t) }));
    metadata();
  },
};

export type Player = typeof music & { st: PlayerState; current: MusicItem | undefined };

/** The player, for screens: its state (re-renders on change) plus the actions. */
export function useMusicPlayer(): Player {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => st);
  return { ...music, st: s, current: s.queue[s.index] };
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    cache.forEach((u) => URL.revokeObjectURL(u));
    tokens.forEach((t) => void api.musicStop(t).catch(() => undefined));
  });
}
