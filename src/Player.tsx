import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, PlayInfo, ScoredSub, Status } from "./api";
import { fmt } from "./Intros";

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

export default function Player({ id, onClose, status }: { id: string; onClose: () => void; status?: Status }) {
  const video = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState<Session>({ start: 0, audio: null, n: 0 });
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sub, setSub] = useState<number>(-1);
  const [subUrls, setSubUrls] = useState<Record<number, string>>({});
  const [controls, setControls] = useState(true);
  const [panel, setPanel] = useState<"none" | "subs" | "audio">("none");
  const [offset, setOffset] = useState(0);
  const [leveling, setLeveling] = useState(false);
  const [online, setOnline] = useState<ScoredSub[] | null>(null);
  const [onlineBusy, setOnlineBusy] = useState<string | null>(null);
  const idle = useRef<number | undefined>(undefined);
  const audioGraph = useRef<{ ctx: AudioContext; src: MediaElementAudioSourceNode; comp: DynamicsCompressorNode; gain: GainNode } | null>(null);
  const appliedOffset = useRef(0);

  // Start (or restart, e.g. after choosing another audio track) the stream.
  useEffect(() => {
    let hls: Hls | null = null;
    let token: string | null = null;
    let cancelled = false;
    const urls: string[] = [];
    setError(null);
    api
      .playStart(id, session.start, session.audio)
      .then(async (p) => {
        token = p.token;
        if (cancelled) return;
        setInfo(p);
        const v = video.current!;
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: false, backBufferLength: 60 });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(`Playback stopped (${data.details}). The file may need converting that the server can't do quickly.`);
          });
          hls.loadSource(p.url);
          hls.attachMedia(v);
        } else {
          v.src = p.url;
        }
        v.play().catch(() => undefined);
        const loaded: Record<number, string> = {};
        for (const t of p.subtitles) {
          try {
            const text = await (await fetch(t.url)).text();
            const u = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
            urls.push(u);
            loaded[t.index] = u;
          } catch {
            /* subtitle unavailable */
          }
        }
        if (!cancelled) {
          setSubUrls(loaded);
          appliedOffset.current = 0;
          setOffset(0);
          const def = p.subtitles.find((t) => t.default && loaded[t.index]);
          setSub((cur) => (cur >= 0 && loaded[cur] ? cur : def ? def.index : -1));
        }
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
      hls?.destroy();
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (token) void api.playStop(token).catch(() => undefined);
    };
  }, [id, session]);

  useEffect(() => () => void getCurrentWindow().setFullscreen(false).catch(() => undefined), []);

  // Show the chosen subtitle track.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const tt = v.textTracks[i];
      tt.mode = tt.label === String(sub) ? "showing" : "disabled";
    }
  }, [sub, subUrls]);

  // Subtitle timing: move every cue of the shown track.
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

  const marks: Mark[] = (info?.segments ?? [])
    .filter((s) => s.Type === "Intro" || s.Type === "Outro" || s.Type === "Recap")
    .map((s) => ({ kind: s.Type, start: s.StartTicks / TICKS, end: s.EndTicks / TICKS }));
  const current = marks.find((m) => time >= m.start && time < m.end - 1);
  const duration = info?.duration || video.current?.duration || 0;

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "SELECT") return;
      wake();
      if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
      else if (e.key === "ArrowRight") seek(time + 10);
      else if (e.key === "ArrowLeft") seek(time - 10);
      else if (e.key === "f") void fullscreen();
      else if (e.key === "s" && current) seek(current.end);
      else if (e.key === "Escape") { if (panel !== "none") setPanel("none"); else onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function searchOnline() {
    setOnline(null);
    setOnlineBusy("search");
    try {
      const lang = status?.subLangs[0] ?? "eng";
      const r = await api.subtitleOptions(id, lang);
      setOnline(r.results.slice(0, 6));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOnlineBusy(null);
    }
  }

  async function downloadOnline(s: ScoredSub) {
    if (!s.sub.Id) return;
    setOnlineBusy(s.sub.Id);
    try {
      const lang = status?.subLangs[0] ?? "eng";
      await api.subtitleDownload(id, s.sub.Id, lang, [lang]);
      // Give Jellyfin a moment to register the file, then restart where we are.
      await new Promise((r) => setTimeout(r, 2500));
      setSession((x) => ({ start: video.current?.currentTime ?? 0, audio: x.audio, n: x.n + 1 }));
      setOnline(null);
      setPanel("none");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setOnlineBusy(null);
    }
  }

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const skipLabel = current?.kind === "Intro" ? "Skip intro" : current?.kind === "Recap" ? "Skip recap" : "Skip credits";
  const subTitle = sub >= 0 ? info?.subtitles.find((t) => t.index === sub)?.title ?? "On" : "Off";
  const audioTitle = info?.audio.find((a) => a.selected)?.title ?? info?.audio[0]?.title ?? "Default";

  return (
    <div className={`player ${controls ? "" : "hide"}`} onMouseMove={wake}>
      <video
        ref={video}
        onClick={toggle}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onClose}
        crossOrigin="anonymous"
      >
        {Object.entries(subUrls).map(([idx, u]) => <track key={`${session.n}-${idx}`} kind="subtitles" src={u} label={idx} />)}
      </video>

      <div className="p-top">
        <button className="p-round" onClick={onClose} aria-label="Back">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div>
          <div className="p-title">{info?.title ?? "Starting…"}</div>
          <div className="p-sub">{info?.subtitle}</div>
        </div>
      </div>

      {error && <div className="p-error">{error}</div>}
      {current && <button className="p-skip" onClick={() => seek(current.end)}>{skipLabel}</button>}

      {panel === "subs" && (
        <div className="p-panel" onClick={(e) => e.stopPropagation()}>
          <div className="strong">Subtitles</div>
          <button className={`p-opt ${sub === -1 ? "on" : ""}`} onClick={() => setSub(-1)}><span>Off</span></button>
          {(info?.subtitles ?? []).filter((t) => subUrls[t.index]).map((t) => (
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
        <div className="p-bar">
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
          <button className={`p-chip ${leveling ? "on" : ""}`} onClick={() => setLeveling((l) => !l)}>Volume leveling {leveling ? "on" : "off"}</button>
          <button className={`p-chip ${panel === "audio" ? "on" : ""}`} onClick={() => setPanel(panel === "audio" ? "none" : "audio")}>Audio: {audioTitle}</button>
          <button className={`p-chip ${sub >= 0 || panel === "subs" ? "on" : ""}`} onClick={() => setPanel(panel === "subs" ? "none" : "subs")}>Subtitles: {subTitle}</button>
          <button className="p-chip" onClick={() => void fullscreen()} aria-label="Full screen">⛶</button>
        </div>
      </div>
    </div>
  );
}
