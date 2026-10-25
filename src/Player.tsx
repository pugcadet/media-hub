import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, cleanTitle, errorText, imageUrl, PlayInfo, ScoredSub, Status, SubTrack, toVtt } from "./api";
import { autoDetectSeason, fmt } from "./Intros";
import { DEFAULT_PREFS, prefs, setPrefs, subCss, usePrefs, type SubStyle } from "./prefs";
import { nav } from "./nav";
import { Icon, SettingsLink } from "./ui";
import { logProblem } from "./activity";

/** Reports a failed position save once per playback (not every 15 seconds). */
let reportedProgress = false;
function progressFailed(e: unknown) {
  if (reportedProgress) return;
  reportedProgress = true;
  logProblem("Saving where you are in Jellyfin", errorText(e));
}

type Panel = "none" | "subs" | "audio" | "style" | "speed" | "chapters";
const SPEEDS = [0.75, 1, 1.1, 1.25, 1.5, 2];

const TICKS = 10_000_000;

interface Mark {
  kind: string;
  start: number;
  end: number;
}

interface Session {
  start: number;
  audio: number | null;
  n: number;
}

const LANG_WORDS: Record<string, string[]> = {
  eng: ["eng", "en", "english"],
  dut: ["dut", "nld", "nl", "dutch", "nederlands"],
  ger: ["ger", "deu", "de", "german", "deutsch"],
  fre: ["fre", "fra", "fr", "french", "français"],
  spa: ["spa", "es", "spanish", "español"],
};

function isLang(t: SubTrack, code: string): boolean {
  const words = LANG_WORDS[code] ?? [code];
  const l = (t.language || "").toLowerCase();
  if (words.includes(l)) return true;
  const title = t.title.toLowerCase();
  return words.some((w) => w.length > 3 && title.includes(w));
}

/** Cue text → safe HTML (only <i>, <b>, <u> and line breaks survive). */
function cueHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc
    .replace(/&lt;(\/?)(i|b|u)&gt;/g, "<$1$2>")
    .replace(/&lt;[^&]*?&gt;/g, "")
    .replace(/\n/g, "<br>");
}

export default function Player({ id, onClose, status, onNext }: { id: string; onClose: () => void; status?: Status; onNext?: (id: string) => void }) {
  const p = usePrefs();
  const video = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<Session>({ start: 0, audio: null, n: 0 });
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [tracks, setTracks] = useState<SubTrack[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // "start": stream not ready yet (show the title card); "buffer": waiting for data while playing.
  const [loadState, setLoadState] = useState<"start" | "buffer" | "ok">("start");
  const [pausedLong, setPausedLong] = useState(false);
  const [sub, setSub] = useState<number>(-1);
  const [subUrls, setSubUrls] = useState<Record<number, string>>({});
  const [cue, setCue] = useState<string>("");
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<Panel>("none");
  const [speed, setSpeed] = useState(1);
  const [buffered, setBuffered] = useState(0);
  const [flash, setFlash] = useState<{ icon: "play" | "pause"; n: number } | null>(null);
  const [offset, setOffset] = useState(0);
  const [leveling, setLeveling] = useState(false);
  const [online, setOnline] = useState<ScoredSub[] | null>(null);
  const [onlineBusy, setOnlineBusy] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const idle = useRef<number | undefined>(undefined);
  const audioGraph = useRef<{ ctx: AudioContext; src: MediaElementAudioSourceNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
  const appliedOffset = useRef(0);
  const tokenRef = useRef<string | null>(null);
  // Last known position: on close the video element is already gone, so this is what gets saved.
  const lastPos = useRef(0);
  const blobUrls = useRef<string[]>([]);
  const [askResume, setAskResume] = useState<number | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [volume, setVolume] = useState(1);
  const [upNextDismissed, setUpNextDismissed] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [countdown, setCountdown] = useState<{ key: string; left: number } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const say = (t: string, ms = 1600) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };
  const subLang = p.subLang || status?.subLangs[0] || "eng";

  async function loadTrack(t: SubTrack): Promise<string | null> {
    try {
      const text = await (await fetch(t.url)).text();
      const u = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
      blobUrls.current.push(u);
      return u;
    } catch {
      return null;
    }
  }

  // Start (or restart, e.g. after choosing another audio track) the stream.
  useEffect(() => {
    let hls: Hls | null = null;
    let token: string | null = null;
    let cancelled = false;
    setError(null);
    setLoadState((s) => (s === "start" ? s : "buffer"));
    api
      .playStart(id, 0, session.audio)
      .then(async (pi) => {
        token = pi.token;
        tokenRef.current = pi.token;
        if (cancelled) return;
        setInfo(pi);
        setTracks(pi.subtitles);
        if (session.n === 0 && prefs().autoDetectIntros && !status?.readOnly && !pi.segments.some((x) => x.Type === "Intro")) {
          void api.details(id).then((d) => {
            if (d.item.Type === "Episode" && d.item.SeasonId) void autoDetectSeason(d.item.SeasonId, `${d.item.SeriesName ?? ""} ${d.item.SeasonName ?? ""}`.trim());
          }).catch(() => undefined);
        }
        const v = video.current!;
        // First start: continue where you stopped, without asking ("Start over" is offered).
        let startAt = session.start;
        const offerResume = false;
        if (session.n === 0 && pi.resume > 30 && pi.resume < pi.duration * 0.95) {
          startAt = pi.resume;
          setAskResume(pi.resume);
          window.setTimeout(() => setAskResume(null), 9000);
        }
        if (Hls.isSupported()) {
          // A big buffer ahead (minutes, not seconds) so a slow moment on the NAS or the
          // server never cuts the sound or freezes the picture.
          hls = new Hls({
            enableWorker: true,
            startPosition: startAt > 0 ? startAt : -1,
            maxBufferLength: 120,
            maxMaxBufferLength: 600,
            maxBufferSize: 500 * 1000 * 1000,
            backBufferLength: 90,
            maxBufferHole: 0.7,
            nudgeMaxRetry: 10,
            startFragPrefetch: true,
            fragLoadingMaxRetry: 6,
            manifestLoadingMaxRetry: 4,
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            // Recover from hiccups instead of stopping.
            if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
            else if (data.fatal && data.type === Hls.ErrorTypes.MEDIA_ERROR) hls?.recoverMediaError();
          });
          let fatal = 0;
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal && ++fatal > 3) setError(`Playback stopped (${data.details}). The file may need converting that the server can't do quickly.`);
          });
          hls.loadSource(pi.url);
          hls.attachMedia(v);
        } else {
          v.src = pi.url;
          if (startAt > 0) v.currentTime = startAt;
        }
        if (!offerResume) v.play().catch(() => undefined);
        const loaded: Record<number, string> = {};
        for (const t of pi.subtitles) {
          const u = await loadTrack(t);
          if (u) loaded[t.index] = u;
        }
        if (!cancelled) {
          setSubUrls(loaded);
          appliedOffset.current = 0;
          setOffset(0);
          const def = pi.subtitles.find((t) => t.default && loaded[t.index]);
          setSub((cur) => (cur >= 0 && loaded[cur] ? cur : def ? def.index : -1));
        }
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
      hls?.destroy();
      if (token) {
        const pos = video.current?.currentTime || lastPos.current;
        const t = token;
        void api.playProgress(t, pos, false).catch(progressFailed).finally(() => void api.playStop(t).catch(() => undefined));
      }
    };
  }, [id, session]);

  useEffect(() => () => blobUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // Nothing behind the player scrolls while it's open.
  useEffect(() => {
    const els = [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>(".page")].filter(Boolean) as HTMLElement[];
    const before = els.map((e) => e.style.overflow);
    els.forEach((e) => (e.style.overflow = "hidden"));
    return () => els.forEach((e, i) => (e.style.overflow = before[i]));
  }, []);

  // Tell Jellyfin where we are every 15 seconds while playing (and when pausing, below).
  useEffect(() => {
    reportedProgress = false;
    const t = window.setInterval(() => {
      const v = video.current;
      if (v && !v.paused && tokenRef.current) void api.playProgress(tokenRef.current, v.currentTime, false).catch(progressFailed);
    }, 15000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => () => void getCurrentWindow().setFullscreen(false).catch(() => undefined), []);

  // The chosen track is read by the app (hidden), and drawn by us so it can be styled freely.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const handlers: [TextTrack, () => void][] = [];
    for (let i = 0; i < v.textTracks.length; i++) {
      const tt = v.textTracks[i];
      const on = tt.label === String(sub);
      tt.mode = on ? "hidden" : "disabled";
      if (on) {
        const h = () => {
          const active = tt.activeCues;
          const parts: string[] = [];
          for (let j = 0; active && j < active.length; j++) parts.push(cueHtml((active[j] as VTTCue).text));
          setCue(parts.join("<br>"));
        };
        tt.addEventListener("cuechange", h);
        handlers.push([tt, h]);
        h();
      }
    }
    if (sub < 0) setCue("");
    return () => handlers.forEach(([tt, h]) => tt.removeEventListener("cuechange", h));
  }, [sub, subUrls]);

  // Subtitle timing: move every cue of every track.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const delta = offset - appliedOffset.current;
    if (!delta) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const cues = v.textTracks[i].cues;
      if (!cues) continue;
      for (let j = 0; j < cues.length; j++) {
        cues[j].startTime = Math.max(0, cues[j].startTime + delta);
        cues[j].endTime = Math.max(0, cues[j].endTime + delta);
      }
    }
    appliedOffset.current = offset;
  }, [offset]);

  // Volume leveling: a gentle compressor so quiet talk and loud scenes come closer together.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (leveling && !audioGraph.current) {
      try {
        const ctx = new AudioContext();
        const src = ctx.createMediaElementSource(v);
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -30;
        comp.knee.value = 20;
        comp.ratio.value = 5;
        comp.attack.value = 0.005;
        comp.release.value = 0.3;
        const gain = ctx.createGain();
        gain.gain.value = 1.6;
        audioGraph.current = { ctx, src, comp, gain };
      } catch {
        setLeveling(false);
        return;
      }
    }
    const g = audioGraph.current;
    if (!g) return;
    g.src.disconnect();
    g.comp.disconnect();
    g.gain.disconnect();
    if (leveling) {
      g.src.connect(g.comp);
      g.comp.connect(g.gain);
      g.gain.connect(g.ctx.destination);
    } else {
      g.src.connect(g.ctx.destination);
    }
  }, [leveling]);

  // Pause screen after a moment.
  useEffect(() => {
    if (playing || !info) {
      setPausedLong(false);
      return;
    }
    // Show the picture right away (a short delay so a quick tap doesn't flash it).
    const t = window.setTimeout(() => setPausedLong(true), 250);
    return () => window.clearTimeout(t);
  }, [playing, info]);

  const marks: Mark[] = useMemo(() => (info?.segments ?? [])
    .filter((s) => s.Type === "Intro" || s.Type === "Outro" || (s.Type === "Recap" && !p.recapsOff))
    .map((s) => ({ kind: s.Type, start: s.StartTicks / TICKS, end: s.EndTicks / TICKS })), [info, p.recapsOff]);
  const current = marks.find((m) => time >= m.start && time < m.end - 1);
  const duration = info?.duration || video.current?.duration || 0;
  const outro = marks.find((m) => m.kind === "Outro");
  const hasNext = !!info?.next && !!onNext;
  const upNext = hasNext && duration > 0 && (outro ? time >= outro.start : time >= duration - 30);

  const seek = (t: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.max(0, Math.min(duration || t, t));
  };
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
    setFlash((f) => ({ icon: v.paused ? "pause" : "play", n: (f?.n ?? 0) + 1 }));
  };
  const fullscreen = async () => {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen())).catch(() => undefined);
  };
  const wake = () => {
    setControls(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setControls(false), 3000);
  };

  // Automatic skipping (Settings → Player): a short countdown on the button, then skip.
  const autoFor = (m: Mark | undefined) =>
    !!m && ((m.kind === "Intro" && p.autoSkipIntro) || (m.kind === "Recap" && p.autoSkipIntro) || (m.kind === "Outro" && p.autoSkipCredits && !hasNext));
  const markKey = current ? `${current.kind}-${current.start}` : "";
  const autoNow = !!current && autoFor(current) && !skipped.has(markKey) && playing;
  useEffect(() => {
    if (!autoNow) {
      setCountdown(null);
      return;
    }
    setCountdown({ key: markKey, left: 3 });
    const t = window.setInterval(() => setCountdown((c) => (c && c.key === markKey ? { ...c, left: c.left - 1 } : c)), 1000);
    return () => window.clearInterval(t);
  }, [autoNow, markKey]);
  useEffect(() => {
    if (!countdown || countdown.left > 0 || !current || countdown.key !== markKey) return;
    seek(current.end);
    setSkipped((s) => new Set(s).add(markKey));
    setCountdown(null);
    say(current.kind === "Intro" ? "Skipped the intro" : current.kind === "Recap" ? "Skipped the recap" : "Skipped the credits");
  }, [countdown]); // eslint-disable-line react-hooks/exhaustive-deps

  // Up next: count down and play the next episode (unless switched off or dismissed).
  const [nextLeft, setNextLeft] = useState<number | null>(null);
  const nextTotal = p.autoSkipCredits ? 5 : 10;
  const autoNext = upNext && !upNextDismissed && p.upNextAutoplay && playing;
  useEffect(() => {
    if (!autoNext) {
      setNextLeft(null);
      return;
    }
    setNextLeft(nextTotal);
    const t = window.setInterval(() => setNextLeft((n) => (n === null ? n : n - 1)), 1000);
    return () => window.clearInterval(t);
  }, [autoNext, nextTotal]);
  useEffect(() => {
    if (nextLeft !== null && nextLeft <= 0) playNext();
  }, [nextLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "SELECT" || tag === "INPUT") return;
      wake();
      const k = e.key.toLowerCase();
      if (e.key === " " || k === "k") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); seek(time + (e.shiftKey ? 30 : 10)); say(e.shiftKey ? "+30 s" : "+10 s"); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); seek(time - (e.shiftKey ? 30 : 10)); say(e.shiftKey ? "−30 s" : "−10 s"); }
      else if (e.key === "ArrowUp") { e.preventDefault(); changeVolume(0.1); }
      else if (e.key === "ArrowDown") { e.preventDefault(); changeVolume(-0.1); }
      else if (k === "m") { const v = video.current; if (v) { v.muted = !v.muted; say(v.muted ? "Muted" : "Sound on"); } }
      else if (k === "c") { if (e.shiftKey) cycleSubtitles(); else void toggleMainSubs(); }
      else if (k === "n" && info?.next) playNext();
      else if (e.key === "]" || e.key === "PageDown") { e.preventDefault(); jumpChapter(1); }
      else if (e.key === "[" || e.key === "PageUp") { e.preventDefault(); jumpChapter(-1); }
      else if (k === "f") void fullscreen();
      else if (k === "s" && current) skipCurrent();
      else if (e.key === "Escape") { if (panel !== "none") setPanel("none"); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const chapters = (info?.chapters ?? []).filter((c) => c.start >= 0 && (!duration || c.start < duration));
  function jumpChapter(dir: number) {
    if (!chapters.length) return say("No chapters");
    const t = video.current?.currentTime ?? time;
    const target = dir > 0 ? chapters.find((c) => c.start > t + 1) : [...chapters].reverse().find((c) => c.start < t - 3);
    if (!target) return say(dir > 0 ? "Last chapter" : "First chapter");
    seek(target.start);
    say(target.name || `Chapter ${chapters.indexOf(target) + 1}`);
  }
  const chapterAt = (t: number) => [...chapters].reverse().find((c) => c.start <= t);

  function changeVolume(d: number) {
    const v = video.current;
    if (!v) return;
    const nv = Math.round(Math.max(0, Math.min(1, v.volume + d)) * 100) / 100;
    v.volume = nv;
    v.muted = false;
    setVolume(nv);
    say(`Volume ${Math.round(nv * 100)}%`);
  }

  function skipCurrent() {
    if (!current) return;
    if (current.kind === "Outro" && hasNext) return playNext();
    seek(current.end);
    setSkipped((s) => new Set(s).add(markKey));
    setCountdown(null);
  }

  const loadedTracks = tracks.filter((t) => subUrls[t.index]);

  /** C: your subtitle language on/off. Not there yet? Get the best match online, without stopping. */
  async function toggleMainSubs() {
    if (sub >= 0) {
      setSub(-1);
      say("Subtitles off");
      return;
    }
    const mine = loadedTracks.find((t) => isLang(t, subLang) && !/forced/i.test(t.title)) ?? loadedTracks.find((t) => isLang(t, subLang));
    if (mine) {
      setSub(mine.index);
      say(`Subtitles: ${mine.title}`);
      return;
    }
    if (status?.readOnly) {
      if (loadedTracks[0]) { setSub(loadedTracks[0].index); say(`Subtitles: ${loadedTracks[0].title}`); }
      else { setPanel("subs"); say("No subtitles. Downloading needs changes switched on in Settings.", 2600); }
      return;
    }
    say("Looking for subtitles online…", 8000);
    try {
      const r = await api.subtitleOptions(id, subLang);
      const best = r.results[0];
      if (!best?.sub.Id) {
        say("No subtitles found online", 2400);
        setOnline([]);
        setPanel("subs");
        return;
      }
      await downloadOnline(best, true);
    } catch (e) {
      say(errorText(e), 3000);
    }
  }

  /** Lines the shown subtitle up with the speech, fixes the file, and reloads it here. */
  async function autoTiming() {
    if (sub < 0) return;
    setOnlineBusy("timing");
    try {
      const d = await api.details(id);
      const stream = (d.item.MediaStreams ?? []).find((m) => m.Type === "Subtitle" && m.Index === sub);
      if (!stream?.IsExternal) {
        say("This subtitle is built into the video; use − and + to shift it.", 3000);
        return;
      }
      say("Listening to the audio…", 20000);
      const r = await api.subtitleSync(id, sub, true);
      if (!r.applied) {
        say(r.fit.after - r.fit.before < 0.02 ? "Timing already looks right" : "Not sure enough to change it; use − and +", 3000);
        return;
      }
      const t = tracks.find((x) => x.index === sub);
      if (t) {
        const u = await loadTrack(t);
        if (u) setSubUrls((m) => ({ ...m, [sub]: u }));
      }
      say(`Timing fixed (${r.fit.offset > 0 ? "+" : ""}${r.fit.offset.toFixed(1)} s)`, 2500);
    } catch (e) {
      say(errorText(e), 3500);
    } finally {
      setOnlineBusy(null);
    }
  }

  /** Shift+C: Off → each subtitle → Off. */
  function cycleSubtitles() {
    if (!loadedTracks.length) return void toggleMainSubs();
    const order = [-1, ...loadedTracks.map((t) => t.index)];
    const next = order[(order.indexOf(sub) + 1) % order.length];
    setSub(next);
    say(next === -1 ? "Subtitles off" : `Subtitles: ${loadedTracks.find((t) => t.index === next)?.title ?? "on"}`);
  }

  function playNext() {
    if (!info?.next || !onNext) return;
    const t = tokenRef.current;
    if (t) void api.playProgress(t, 0, true).catch(() => undefined);
    onNext(info.next.id);
  }

  async function searchOnline() {
    setOnline(null);
    setOnlineBusy("search");
    try {
      const r = await api.subtitleOptions(id, subLang);
      setOnline(r.results.slice(0, 8));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOnlineBusy(null);
    }
  }

  /** Downloads a subtitle and adds it to the running playback, then shows it. */
  async function downloadOnline(s: ScoredSub, quietly = false) {
    if (!s.sub.Id) return;
    setOnlineBusy(s.sub.Id);
    try {
      const d = await api.subtitleDownload(id, s.sub.Id, subLang, LANG_WORDS[subLang]?.filter((w) => w.length === 3) ?? [subLang], s.sub.Format ?? null);
      const done = (pick: number) => {
        setSub(pick);
        say(`Subtitles on (match ${s.score})`);
        setPanel("none");
        setOnline(null);
      };
      // Saved by Media Hub: show it straight away; Jellyfin lists it on its next look.
      if (d.text && (d.format === "srt" || d.format === "vtt")) {
        const idx = 100000 + Object.keys(subUrls).length;
        const u = URL.createObjectURL(new Blob([toVtt(d.text)], { type: "text/vtt" }));
        blobUrls.current.push(u);
        setTracks((l) => [...l, { index: idx, language: subLang, title: `${s.sub.Name ?? subLang} (downloaded)`.slice(0, 60), url: u, default: false }]);
        setSubUrls((m) => ({ ...m, [idx]: u }));
        done(idx);
        return;
      }
      const token = tokenRef.current;
      if (!token) return;
      // Jellyfin needs a moment to notice the new file: ask again for up to ~20 seconds.
      let list = await api.playSubtitles(token);
      for (let i = 0; i < 10 && !list.some((t) => !subUrls[t.index]); i++) {
        say("Adding the subtitle…", 3000);
        await new Promise((r) => window.setTimeout(r, 2000));
        list = await api.playSubtitles(token);
      }
      setTracks(list);
      const fresh = list.filter((t) => !subUrls[t.index]);
      const loaded: Record<number, string> = { ...subUrls };
      for (const t of fresh) {
        const u = await loadTrack(t);
        if (u) loaded[t.index] = u;
      }
      setSubUrls(loaded);
      const pick = d.index != null && loaded[d.index] ? d.index : fresh.find((t) => loaded[t.index] && isLang(t, subLang))?.index ?? fresh[0]?.index;
      if (pick != null) done(pick);
      else say(quietly ? "Downloaded; it appears once Jellyfin lists it." : "Downloaded, but Jellyfin hasn't listed it yet. Press C again in a moment.", 3500);
    } catch (e) {
      say(errorText(e), 3000);
    } finally {
      setOnlineBusy(null);
    }
  }

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const skipLabel = current?.kind === "Intro" ? "Skip intro" : current?.kind === "Recap" ? "Skip recap" : hasNext ? "Next episode" : "Skip credits";
  const subTitle = sub >= 0 ? tracks.find((t) => t.index === sub)?.title ?? "On" : "Off";
  const about = info?.about;
  const tp = info?.trickplay;
  const thumb = (() => {
    if (!tp || !hover) return null;
    const idx = Math.min(tp.count - 1, Math.floor((hover.t * 1000) / tp.interval));
    const per = tp.tileWidth * tp.tileHeight;
    const sheet = Math.floor(idx / per);
    const inSheet = idx % per;
    const col = inSheet % tp.tileWidth;
    const row = Math.floor(inSheet / tp.tileWidth);
    const scale = 220 / tp.width;
    return {
      width: 220, height: Math.round(tp.height * scale),
      backgroundImage: `url("${tp.base}/${sheet}.jpg")`,
      backgroundSize: `${tp.width * tp.tileWidth * scale}px ${tp.height * tp.tileHeight * scale}px`,
      backgroundPosition: `-${col * tp.width * scale}px -${row * tp.height * scale}px`,
    };
  })();
  const subBottom = controls || !playing ? Math.max(p.subStyle.bottom, 19) : p.subStyle.bottom;

  return (
    <div className={`player ${controls && loadState !== "start" ? "" : "hide"} ${loadState === "start" ? "starting" : ""}`} onMouseMove={wake}>
      <video
        ref={video}
        onClick={toggle}
        onTimeUpdate={(e) => {
          const v = e.currentTarget;
          setTime(v.currentTime);
          if (v.currentTime > 0) lastPos.current = v.currentTime;
          // How far ahead it has loaded (the range that contains the playhead).
          for (let i = 0; i < v.buffered.length; i++) {
            if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) { setBuffered(v.buffered.end(i)); break; }
          }
        }}
        onDoubleClick={() => void fullscreen()}
        onLoadedMetadata={(e) => { e.currentTarget.playbackRate = speed; }}
        onPlay={() => setPlaying(true)}
        onWaiting={() => setLoadState((s) => (s === "start" ? s : "buffer"))}
        onPlaying={() => setLoadState("ok")}
        onCanPlay={() => setLoadState((s) => (s === "start" ? "ok" : s))}
        onSeeking={() => setLoadState((s) => (s === "start" ? s : "buffer"))}
        onSeeked={() => setLoadState((s) => (s === "buffer" ? "ok" : s))}
        onPause={(e) => {
          setPlaying(false);
          if (tokenRef.current && e.currentTarget.currentTime > 5) void api.playProgress(tokenRef.current, e.currentTarget.currentTime, false).catch(progressFailed);
        }}
        onEnded={() => {
          if (tokenRef.current) void api.playProgress(tokenRef.current, 0, true).catch(() => undefined);
          if (info?.next && onNext) playNext();
          else onClose();
        }}
        crossOrigin="anonymous"
      >
        {Object.entries(subUrls).map(([idx, u]) => <track key={`${session.n}-${idx}-${u}`} kind="subtitles" src={u} label={idx} />)}
      </video>

      {cue && (
        <div className="p-subs" style={{ bottom: `${subBottom}%` }}>
          <span className="p-cue" style={subCss(p.subStyle)} dangerouslySetInnerHTML={{ __html: cue }} />
        </div>
      )}

      {pausedLong && about && panel === "none" && !error && (
        <div className="p-pause" onClick={toggle}>
          <img className="p-pause-art" src={imageUrl(about.artId, "Backdrop", 1600)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
          <div className="p-pause-shade" />
          <div className="p-pause-text" onClick={(e) => e.stopPropagation()}>
            <div className="muted small">You're watching</div>
            <PauseLogo artId={about.artId} title={info?.title ?? ""} />
            {info?.subtitle && <div className="p-pause-sub">{info.subtitle}</div>}
            <div className="hero-meta">
              {about.year && <span>{about.year}</span>}
              {about.officialRating && <span>{about.officialRating}</span>}
              {about.rating != null && <span>★ {about.rating.toFixed(1)}</span>}
              {about.genres.length > 0 && <span>{about.genres.join(", ")}</span>}
              <span>{fmt(time)} of {fmt(duration)}</span>
            </div>
            {about.overview && <p className="p-pause-overview">{about.overview}</p>}
            {about.people.length > 0 && (
              <div className="p-cast">
                {about.people.slice(0, 8).map((x) => (
                  <div key={x.id} className="p-person" title={x.role}>
                    <div className="face">{x.hasImage ? <img src={imageUrl(x.id, "Primary", 120)} alt="" /> : <span>{x.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</span>}</div>
                    <div className="small ellipsis">{x.name}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <button className="primary" onClick={toggle}>▶ Resume</button>
              <button onClick={() => { onClose(); nav.open(about.artId); }}>Go to {about.artId !== about.itemId ? "show" : "details"}</button>
            </div>
          </div>
        </div>
      )}

      <div className="p-top">
        <button className="p-round" onClick={onClose} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div className="p-title">{info ? cleanTitle(info.title) : "Starting…"}</div>
          <div className="p-sub">{info?.subtitle}</div>
        </div>
      </div>

      {loadState === "start" && !error && (
        <div className="p-starting">
          {info?.about && <img className="p-pause-art" src={imageUrl(info.about.artId, "Backdrop", 1600)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />}
          <div className="p-pause-shade" />
          <div className="p-starting-body">
            {info?.about ? <PauseLogo artId={info.about.artId} title={info.title} /> : null}
            {info?.subtitle && <div className="p-pause-sub">{info.subtitle}</div>}
            <div className="p-loader"><span className="spinner big" /> {info ? "Starting the stream…" : "Getting ready…"}</div>
            <button className="link small" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
      {loadState === "buffer" && !error && <div className="p-buffer"><span className="spinner big" /></div>}
      {error && <div className="p-error">{error}</div>}
      {toast && <div className="p-toast">{toast}</div>}
      {askResume !== null && (
        <div className="p-resumed" onClick={(e) => e.stopPropagation()}>
          <span>Continuing from {fmt(askResume)}</span>
          <button onClick={() => { setAskResume(null); seek(0); void video.current?.play(); }}>Start over</button>
        </div>
      )}
      {upNext && !upNextDismissed ? (
        <div className="p-upnext" onClick={(e) => e.stopPropagation()}>
          <div className="small muted">Up next{nextLeft != null ? ` · plays in ${nextLeft} s` : ""}</div>
          <div className="strong">{info?.next?.label}</div>
          {nextLeft != null && <span className="p-count"><span style={{ width: `${(nextLeft / nextTotal) * 100}%` }} /></span>}
          <div className="row">
            <button className="primary" onClick={playNext}>▶ Play now</button>
            <button onClick={() => { setUpNextDismissed(true); setNextLeft(null); }}>Keep watching</button>
          </div>
        </div>
      ) : current && !(current.kind === "Outro" && hasNext) && (
        <div className="p-skipwrap" onClick={(e) => e.stopPropagation()}>
          <button className="p-skip" onClick={skipCurrent}>
            {skipLabel}
            {countdown && countdown.key === markKey && <span className="p-skipbar" style={{ width: `${(countdown.left / 3) * 100}%` }} />}
          </button>
          {countdown && countdown.key === markKey && <button className="link small" onClick={() => { setSkipped((s) => new Set(s).add(markKey)); setCountdown(null); }}>Watch it</button>}
        </div>
      )}

      {panel !== "none" && (
        <div className="p-settings" onClick={(e) => e.stopPropagation()}>
          <div className="p-tabs">
            {([["subs", "Subtitles"], ["style", "Look"], ["audio", "Audio"], ["speed", "Speed"], ...(chapters.length ? [["chapters", "Chapters"]] : [])] as [Panel, string][]).map(([k, label]) => (
              <button key={k} className={panel === k ? "on" : ""} onClick={() => setPanel(k)}>{label}</button>
            ))}
            <span className="spacer" />
            <button className="p-x" onClick={() => setPanel("none")} aria-label="Close"><Icon name="x" size={14} /></button>
          </div>
          <div className="p-settings-body">
            {panel === "subs" && (
              <>
                <button className={`p-opt ${sub === -1 ? "on" : ""}`} onClick={() => setSub(-1)}><span>Off</span>{sub === -1 && <Icon name="check" size={14} />}</button>
                {loadedTracks.map((t) => (
                  <button key={t.index} className={`p-opt ${sub === t.index ? "on" : ""}`} onClick={() => setSub(t.index)}>
                    <span>{t.title}</span>{sub === t.index ? <Icon name="check" size={14} /> : <span className="small muted">{t.default ? "Default" : ""}</span>}
                  </button>
                ))}
                {online === null ? (
                  <button className="p-opt" disabled={!!onlineBusy} onClick={() => void searchOnline()}><span><Icon name="search" size={14} /> {onlineBusy === "search" ? "Searching…" : "Find more online"}</span></button>
                ) : (
                  <>
                    {online.length === 0 && <div className="small muted">Nothing found online.</div>}
                    {online.map((o) => (
                      <button key={o.sub.Id} className="p-opt" disabled={!!onlineBusy || status?.readOnly} onClick={() => void downloadOnline(o)} title={o.sub.Name}>
                        <span className="ellipsis">{o.sub.Name}</span>
                        <span className={`small strong ${o.score >= 85 ? "ok" : o.score >= 60 ? "warn" : "bad"}`}>{onlineBusy === o.sub.Id ? "…" : `${o.score}${o.score === 100 ? " · Best" : ""}`}</span>
                      </button>
                    ))}
                    {status?.readOnly && <div className="small muted">Downloading needs changes switched on. <SettingsLink section="changes">Turn them on</SettingsLink></div>}
                  </>
                )}
                {sub >= 0 && !status?.readOnly && (
                  <button className="p-opt" disabled={!!onlineBusy} onClick={() => void autoTiming()}><span><Icon name="wand" size={14} /> Fix timing automatically</span><span className="small muted">{onlineBusy === "timing" ? "Listening…" : ""}</span></button>
                )}
                <div className="p-timing">
                  <span className="muted small">Timing</span>
                  <span className="row">
                    <button onClick={() => setOffset((o) => Math.round((o - 0.5) * 10) / 10)} aria-label="Earlier">−</button>
                    <span className="mono">{offset.toFixed(1)} s</span>
                    <button onClick={() => setOffset((o) => Math.round((o + 0.5) * 10) / 10)} aria-label="Later">+</button>
                  </span>
                </div>
                <div className="muted small">C: {subLang === "eng" ? "English" : subLang} on/off · Shift+C: all tracks</div>
              </>
            )}
            {panel === "style" && <SubStyleEditor compact />}
            {panel === "audio" && (
              <>
                {(info?.audio ?? []).map((a) => (
                  <button key={a.index} className={`p-opt ${a.selected ? "on" : ""}`} onClick={() => {
                    if (!a.selected) setSession((x) => ({ start: video.current?.currentTime ?? 0, audio: a.index, n: x.n + 1 }));
                  }}><span>{a.title}</span>{a.selected && <Icon name="check" size={14} />}</button>
                ))}
                <label className="p-opt p-switch"><span>Volume leveling<br /><span className="small muted">Quiet talk louder, loud scenes softer</span></span>
                  <input type="checkbox" className="switch" checked={leveling} onChange={(e) => setLeveling(e.target.checked)} /></label>
              </>
            )}
            {panel === "speed" && SPEEDS.map((x) => (
              <button key={x} className={`p-opt ${speed === x ? "on" : ""}`} onClick={() => { setSpeed(x); if (video.current) video.current.playbackRate = x; }}>
                <span>{x === 1 ? "Normal" : `${x}×`}</span>{speed === x && <Icon name="check" size={14} />}
              </button>
            ))}
            {panel === "chapters" && chapters.map((c, i) => {
              const on = chapterAt(time) === c;
              return (
                <button key={i} className={`p-opt ${on ? "on" : ""}`} onClick={() => seek(c.start)}>
                  <span className="ellipsis">{c.name || `Chapter ${i + 1}`}</span><span className="mono small muted">{fmt(c.start)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {flash && <div key={flash.n} className="p-flash"><Icon name={flash.icon} size={34} /></div>}

      <div className="p-bottom">
        <div
          className="p-bar"
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
            setHover({ x, t: duration ? (x / r.width) * duration : 0 });
          }}
          onMouseLeave={() => setHover(null)}
        >
          {hover && duration > 0 && (
            <div className="p-preview" style={{ left: Math.max(110, Math.min(hover.x, (video.current?.clientWidth ?? 1000) - 166)) }}>
              {thumb && <div className="p-thumb" style={thumb} />}
              {chapterAt(hover.t)?.name && <span className="small p-chapname">{chapterAt(hover.t)!.name}</span>}
              <span className="mono small">{fmt(hover.t)}{marks.find((m) => hover.t >= m.start && hover.t < m.end) ? ` · ${marks.find((m) => hover.t >= m.start && hover.t < m.end)!.kind === "Outro" ? "Credits" : marks.find((m) => hover.t >= m.start && hover.t < m.end)!.kind}` : ""}</span>
            </div>
          )}
          <div className="p-rail">
            <span className="p-buffered" style={{ width: pct(buffered) }} />
            {marks.map((m, i) => <span key={i} className={`p-mark ${m.kind.toLowerCase()}`} style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }} />)}
            <span className="p-fill" style={{ width: pct(time) }}><span className="p-knob" /></span>
            {chapters.filter((c) => c.start > 1).map((c, i) => <span key={`c${i}`} className="p-chapter" style={{ left: pct(c.start) }} title={c.name} />)}
            {hover && <span className="p-hoverline" style={{ left: hover.x }} />}
          </div>
          <input type="range" min={0} max={duration || 1} step={1} value={time} onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
        </div>
        <div className="p-row">
          <button className="p-ic big" onClick={toggle} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
            <Icon name={playing ? "pause" : "play"} size={26} />
          </button>
          <button className="p-ic" onClick={() => seek(time - 10)} aria-label="Back 10 seconds" title="Back 10 s (←)"><span className="p-skipnum">10</span><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /></svg></button>
          <button className="p-ic" onClick={() => seek(time + 10)} aria-label="Forward 10 seconds" title="Forward 10 s (→)"><span className="p-skipnum">10</span><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4h-4" /></svg></button>
          <div className="p-volwrap">
            <button className="p-ic" onClick={() => { const v = video.current; if (v) { v.muted = !v.muted; setVolume(v.muted ? 0 : v.volume); } }} aria-label="Mute" title="Mute (M)"><Icon name="volume" size={22} /></button>
            <input className="p-vol" type="range" min={0} max={1} step={0.05} value={volume} aria-label="Volume"
              onChange={(e) => { const nv = Number(e.target.value); setVolume(nv); if (video.current) { video.current.volume = nv; video.current.muted = false; } }} />
          </div>
          <span className="mono small p-time">{fmt(time)} <span className="muted">/ {fmt(duration)}</span></span>
          <div className="p-center-title" />
          {info?.next && onNext && <button className="p-ic" onClick={playNext} title={`Next: ${info.next.label} (N)`} aria-label="Next episode"><Icon name="next" size={22} /></button>}
          <button className={`p-ic ${sub >= 0 ? "on" : ""}`} onClick={() => setPanel(panel === "subs" ? "none" : "subs")} title={`Subtitles: ${subTitle} (C)`} aria-label="Subtitles"><Icon name="subtitles" size={22} /></button>
          <button className={`p-ic ${panel !== "none" && panel !== "subs" ? "on" : ""}`} onClick={() => setPanel(panel === "none" || panel === "subs" ? "audio" : "none")} title="Audio, speed, chapters" aria-label="Settings"><Icon name="settings" size={22} /></button>
          <button className="p-ic" onClick={() => void fullscreen()} aria-label="Full screen" title="Full screen (F)"><Icon name="expand" size={20} /></button>
        </div>
      </div>
    </div>
  );
}

function PauseLogo({ artId, title }: { artId: string; title: string }) {
  const [ok, setOk] = useState(true);
  return ok ? <img className="p-pause-logo" src={imageUrl(artId, "Logo", 700)} alt={title} onError={() => setOk(false)} /> : <div className="p-pause-title">{cleanTitle(title)}</div>;
}

/** Everything about how subtitles look. Used in the player (compact) and in Settings. */
export function SubStyleEditor({ compact }: { compact?: boolean }) {
  const { subStyle: s } = usePrefs();
  const set = (patch: Partial<SubStyle>) => setPrefs({ subStyle: { ...prefs().subStyle, ...patch } });
  const slider = (label: string, value: number, min: number, max: number, step: number, show: string, f: (v: number) => void) => (
    <label>{label} · {show}<input type="range" min={min} max={max} step={step} value={value} onChange={(e) => f(Number(e.target.value))} /></label>
  );
  return (
    <div className={`stack-s sub-editor ${compact ? "compact" : ""}`}>
      {!compact && <div className="sub-sample"><span style={{ ...subCss(s), fontSize: `${Math.round(22 * s.size / 100)}px`, maxWidth: "90%" }}>The quick brown fox jumps over the lazy dog.</span></div>}
      <div className="fields2">
        {slider("Size", s.size, 60, 200, 5, `${s.size}%`, (v) => set({ size: v }))}
        {slider("Height from the bottom", s.bottom, 2, 40, 1, `${s.bottom}%`, (v) => set({ bottom: v }))}
        {slider("Outline thickness", s.stroke, 0, 6, 0.5, `${s.stroke}px`, (v) => set({ stroke: v, shadow: v > 0 && s.shadow === "none" ? "outline" : s.shadow }))}
        {slider("Widest line", s.maxWidth, 40, 100, 5, `${s.maxWidth}%`, (v) => set({ maxWidth: v }))}
        {slider("Text opacity", s.textOpacity, 0.3, 1, 0.05, `${Math.round(s.textOpacity * 100)}%`, (v) => set({ textOpacity: v }))}
        {slider("Box behind the text", s.background, 0, 1, 0.05, `${Math.round(s.background * 100)}%`, (v) => set({ background: v }))}
        {slider("Letter spacing", s.letterSpacing, -4, 12, 1, `${s.letterSpacing}`, (v) => set({ letterSpacing: v }))}
        {slider("Line height", s.lineHeight, 1, 1.8, 0.05, s.lineHeight.toFixed(2), (v) => set({ lineHeight: v }))}
      </div>
      <div className="fields3">
        <label>Font
          <select value={s.font} onChange={(e) => set({ font: e.target.value as SubStyle["font"] })}>
            <option value="sans">Clean (sans)</option><option value="rounded">Rounded</option><option value="serif">Classic (serif)</option><option value="mono">Typewriter</option>
          </select>
        </label>
        <label>Edge
          <select value={s.shadow} onChange={(e) => set({ shadow: e.target.value as SubStyle["shadow"] })}>
            <option value="outline">Outline</option><option value="soft">Drop shadow</option><option value="none">None</option>
          </select>
        </label>
        <label>Colour
          <select value={s.color} onChange={(e) => set({ color: e.target.value })}>
            <option value="#ffffff">White</option><option value="#fff6a8">Yellow</option><option value="#cfe9ff">Light blue</option><option value="#d9d9d9">Grey</option><option value="#b9f5c8">Light green</option>
          </select>
        </label>
        <label>Box colour
          <select value={s.boxColor} onChange={(e) => set({ boxColor: e.target.value })}>
            <option value="#000000">Black</option><option value="#1c1f26">Dark grey</option><option value="#0b1d3a">Navy</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label className="check small"><input type="checkbox" checked={s.bold} onChange={(e) => set({ bold: e.target.checked })} />Bold</label>
        <label className="check small"><input type="checkbox" checked={s.italic} onChange={(e) => set({ italic: e.target.checked })} />Italic</label>
        <button className="link small" onClick={() => set(DEFAULT_PREFS.subStyle)}>Back to the standard look</button>
      </div>
    </div>
  );
}
