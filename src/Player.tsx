import { useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, cleanTitle, errorText, imageUrl, PlayInfo, ScoredSub, Status, SubTrack } from "./api";
import { fmt } from "./Intros";
import { prefs, setPrefs, subCss, usePrefs, type SubStyle } from "./prefs";
import { nav } from "./nav";

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
  const [pausedLong, setPausedLong] = useState(false);
  const [sub, setSub] = useState<number>(-1);
  const [subUrls, setSubUrls] = useState<Record<number, string>>({});
  const [cue, setCue] = useState<string>("");
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<"none" | "subs" | "audio" | "style">("none");
  const [offset, setOffset] = useState(0);
  const [leveling, setLeveling] = useState(false);
  const [online, setOnline] = useState<ScoredSub[] | null>(null);
  const [onlineBusy, setOnlineBusy] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const idle = useRef<number | undefined>(undefined);
  const audioGraph = useRef<{ ctx: AudioContext; src: MediaElementAudioSourceNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
  const appliedOffset = useRef(0);
  const tokenRef = useRef<string | null>(null);
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
    api
      .playStart(id, 0, session.audio)
      .then(async (pi) => {
        token = pi.token;
        tokenRef.current = pi.token;
        if (cancelled) return;
        setInfo(pi);
        setTracks(pi.subtitles);
        const v = video.current!;
        // First start: offer to continue where you stopped (Infuse-style).
        let startAt = session.start;
        const offerResume = session.n === 0 && pi.resume > 30 && pi.resume < pi.duration * 0.95;
        if (offerResume) {
          setAskResume(pi.resume);
          startAt = 0;
        }
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: false, backBufferLength: 60, startPosition: startAt > 0 ? startAt : -1 });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(`Playback stopped (${data.details}). The file may need converting that the server can't do quickly.`);
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
        const pos = video.current?.currentTime ?? 0;
        const t = token;
        void api.playProgress(t, pos, false).catch(() => undefined).finally(() => void api.playStop(t).catch(() => undefined));
      }
    };
  }, [id, session]);

  useEffect(() => () => blobUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  // Tell Jellyfin where we are every 30 seconds while playing.
  useEffect(() => {
    const t = window.setInterval(() => {
      const v = video.current;
      if (v && !v.paused && tokenRef.current) void api.playProgress(tokenRef.current, v.currentTime, false).catch(() => undefined);
    }, 30000);
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
    if (playing || askResume !== null || !info) {
      setPausedLong(false);
      return;
    }
    const t = window.setTimeout(() => setPausedLong(true), 1800);
    return () => window.clearTimeout(t);
  }, [playing, askResume, info]);

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
      else if (k === "f") void fullscreen();
      else if (k === "s" && current) skipCurrent();
      else if (e.key === "Escape") { if (panel !== "none") setPanel("none"); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
      const idx = await api.subtitleDownload(id, s.sub.Id, subLang, LANG_WORDS[subLang]?.filter((w) => w.length === 3) ?? [subLang]);
      const token = tokenRef.current;
      if (!token) return;
      const list = await api.playSubtitles(token);
      setTracks(list);
      const fresh = list.filter((t) => !subUrls[t.index]);
      const loaded: Record<number, string> = { ...subUrls };
      for (const t of fresh) {
        const u = await loadTrack(t);
        if (u) loaded[t.index] = u;
      }
      setSubUrls(loaded);
      const pick = idx != null && loaded[idx] ? idx : fresh.find((t) => loaded[t.index] && isLang(t, subLang))?.index ?? fresh[0]?.index;
      if (pick != null) {
        setSub(pick);
        say(`Subtitles on (match ${s.score})`);
        setPanel("none");
        setOnline(null);
      } else if (!quietly) {
        say("Downloaded; Jellyfin is still adding it. Try C again in a moment.", 3000);
      } else {
        say("Downloaded; it will show up in a moment. Press C again.", 3000);
      }
    } catch (e) {
      say(errorText(e), 3000);
    } finally {
      setOnlineBusy(null);
    }
  }

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const skipLabel = current?.kind === "Intro" ? "Skip intro" : current?.kind === "Recap" ? "Skip recap" : hasNext ? "Next episode" : "Skip credits";
  const subTitle = sub >= 0 ? tracks.find((t) => t.index === sub)?.title ?? "On" : "Off";
  const audioTitle = info?.audio.find((a) => a.selected)?.title ?? info?.audio[0]?.title ?? "Default";
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
    <div className={`player ${controls ? "" : "hide"}`} onMouseMove={wake}>
      <video
        ref={video}
        onClick={toggle}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          if (tokenRef.current) void api.playProgress(tokenRef.current, 0, true).catch(() => undefined);
          if (info?.next && onNext) playNext();
          else onClose();
        }}
        crossOrigin="anonymous"
      >
        {Object.entries(subUrls).map(([idx, u]) => <track key={`${session.n}-${idx}`} kind="subtitles" src={u} label={idx} />)}
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

      {error && <div className="p-error">{error}</div>}
      {toast && <div className="p-toast">{toast}</div>}
      {askResume !== null && (
        <div className="p-resume" onClick={(e) => e.stopPropagation()}>
          <button className="primary" autoFocus onClick={() => { const r = askResume; setAskResume(null); seek(r); void video.current?.play(); }}>Resume from {fmt(askResume)}</button>
          <button onClick={() => { setAskResume(null); seek(0); void video.current?.play(); }}>Start from the beginning</button>
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

      {panel === "subs" && (
        <div className="p-panel" onClick={(e) => e.stopPropagation()}>
          <div className="row between"><span className="strong">Subtitles</span><button className="link small" onClick={() => setPanel("style")}>Look and position…</button></div>
          <button className={`p-opt ${sub === -1 ? "on" : ""}`} onClick={() => setSub(-1)}><span>Off</span></button>
          {loadedTracks.map((t) => (
            <button key={t.index} className={`p-opt ${sub === t.index ? "on" : ""}`} onClick={() => setSub(t.index)}>
              <span>{t.title}</span><span className="small muted">{t.default ? "Default" : ""}</span>
            </button>
          ))}
          {online === null ? (
            <button className="p-opt" disabled={!!onlineBusy} onClick={() => void searchOnline()}><span>{onlineBusy === "search" ? "Searching…" : "Search more online"}</span></button>
          ) : (
            <>
              {online.length === 0 && <div className="small muted">Nothing found online.</div>}
              {online.map((o) => (
                <button key={o.sub.Id} className="p-opt" disabled={!!onlineBusy || status?.readOnly} onClick={() => void downloadOnline(o)} title={o.sub.Name}>
                  <span className="ellipsis">{o.sub.Name}</span>
                  <span className={`small strong ${o.score >= 85 ? "ok" : o.score >= 60 ? "warn" : "bad"}`}>{onlineBusy === o.sub.Id ? "…" : `${o.score}${o.score === 100 ? " · Best match" : ""}`}</span>
                </button>
              ))}
              {status?.readOnly && <div className="small muted">Downloading needs changes switched on in Settings.</div>}
            </>
          )}
          <div className="p-timing">
            <span className="muted small">Timing</span>
            <span className="row">
              <button onClick={() => setOffset((o) => Math.round((o - 0.5) * 10) / 10)} aria-label="Earlier">−</button>
              <span className="mono">{offset.toFixed(1)} s</span>
              <button onClick={() => setOffset((o) => Math.round((o + 0.5) * 10) / 10)} aria-label="Later">+</button>
            </span>
          </div>
          <div className="muted small">C turns {subLang === "eng" ? "English" : subLang} subtitles on and off · Shift+C goes through all</div>
        </div>
      )}
      {panel === "style" && (
        <div className="p-panel" onClick={(e) => e.stopPropagation()}>
          <div className="row between"><span className="strong">Subtitle look</span><button className="link small" onClick={() => setPanel("subs")}>← Tracks</button></div>
          <SubStyleEditor />
        </div>
      )}
      {panel === "audio" && (
        <div className="p-panel" onClick={(e) => e.stopPropagation()}>
          <div className="strong">Audio</div>
          {(info?.audio ?? []).map((a) => (
            <button key={a.index} className={`p-opt ${a.selected ? "on" : ""}`} onClick={() => {
              setPanel("none");
              if (!a.selected) setSession((x) => ({ start: video.current?.currentTime ?? 0, audio: a.index, n: x.n + 1 }));
            }}><span>{a.title}</span></button>
          ))}
        </div>
      )}

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
              <span className="mono small">{fmt(hover.t)}{marks.find((m) => hover.t >= m.start && hover.t < m.end) ? ` · ${marks.find((m) => hover.t >= m.start && hover.t < m.end)!.kind === "Outro" ? "Credits" : marks.find((m) => hover.t >= m.start && hover.t < m.end)!.kind}` : ""}</span>
            </div>
          )}
          <div className="p-rail">
            {marks.map((m, i) => <span key={i} className={`p-mark ${m.kind.toLowerCase()}`} style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }} />)}
            <span className="p-fill" style={{ width: pct(time) }} />
          </div>
          <input type="range" min={0} max={duration || 1} step={1} value={time} onChange={(e) => seek(Number(e.target.value))} aria-label="Position" />
        </div>
        <div className="p-row">
          <button className="p-play" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
            )}
          </button>
          <button className="p-chip" onClick={() => seek(time - 10)} aria-label="Back 10 seconds">−10</button>
          <button className="p-chip" onClick={() => seek(time + 10)} aria-label="Forward 10 seconds">+10</button>
          <span className="mono small p-time">{fmt(time)} / {fmt(duration)}</span>
          <div className="spacer" />
          <input className="p-vol" type="range" min={0} max={1} step={0.05} value={volume} aria-label="Volume"
            onChange={(e) => { const nv = Number(e.target.value); setVolume(nv); if (video.current) { video.current.volume = nv; video.current.muted = false; } }} />
          {info?.next && onNext && <button className="p-chip" onClick={playNext} title="Next episode (N)">Next ▸</button>}
          <button className={`p-chip ${leveling ? "on" : ""}`} onClick={() => setLeveling((l) => !l)}>Volume leveling {leveling ? "on" : "off"}</button>
          <button className={`p-chip ${panel === "audio" ? "on" : ""}`} onClick={() => setPanel(panel === "audio" ? "none" : "audio")}>Audio: {audioTitle}</button>
          <button className={`p-chip ${sub >= 0 || panel === "subs" || panel === "style" ? "on" : ""}`} onClick={() => setPanel(panel === "subs" || panel === "style" ? "none" : "subs")}>Subtitles: {subTitle}</button>
          <button className="p-chip" onClick={() => void fullscreen()} aria-label="Full screen">⛶</button>
        </div>
      </div>
    </div>
  );
}

function PauseLogo({ artId, title }: { artId: string; title: string }) {
  const [ok, setOk] = useState(true);
  return ok ? <img className="p-pause-logo" src={imageUrl(artId, "Logo", 700)} alt={title} onError={() => setOk(false)} /> : <div className="p-pause-title">{cleanTitle(title)}</div>;
}

/** Size, font, colour, box, shadow and height of subtitles. Used in the player and in Settings. */
export function SubStyleEditor() {
  const { subStyle: s } = usePrefs();
  const set = (patch: Partial<SubStyle>) => setPrefs({ subStyle: { ...prefs().subStyle, ...patch } });
  return (
    <div className="stack-s sub-editor">
      <div className="sub-sample"><span style={{ ...subCss(s), fontSize: `${Math.round(22 * s.size / 100)}px` }}>The quick brown fox jumps.</span></div>
      <label>Size · {s.size}%<input type="range" min={60} max={200} step={5} value={s.size} onChange={(e) => set({ size: Number(e.target.value) })} /></label>
      <label>Height from the bottom · {s.bottom}%<input type="range" min={2} max={40} step={1} value={s.bottom} onChange={(e) => set({ bottom: Number(e.target.value) })} /></label>
      <label>Background box · {Math.round(s.background * 100)}%<input type="range" min={0} max={1} step={0.05} value={s.background} onChange={(e) => set({ background: Number(e.target.value) })} /></label>
      <div className="row">
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
      </div>
      <div className="row">
        <label>Colour
          <select value={s.color} onChange={(e) => set({ color: e.target.value })}>
            <option value="#ffffff">White</option><option value="#fff6a8">Yellow</option><option value="#cfe9ff">Light blue</option><option value="#d9d9d9">Grey</option>
          </select>
        </label>
        <label className="check small" style={{ alignSelf: "flex-end", height: 40 }}><input type="checkbox" checked={s.bold} onChange={(e) => set({ bold: e.target.checked })} />Bold</label>
      </div>
    </div>
  );
}
