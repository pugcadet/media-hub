import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorText, PlayInfo } from "./api";
import { fmt } from "./Intros";

const TICKS = 10_000_000;

interface Mark {
  kind: string;
  start: number;
  end: number;
}

export default function Player({ id, onClose }: { id: string; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sub, setSub] = useState<number>(-1);
  const [subUrls, setSubUrls] = useState<Record<number, string>>({});
  const [controls, setControls] = useState(true);
  const [volume, setVolume] = useState(1);
  const idle = useRef<number | undefined>(undefined);

  // Start the stream.
  useEffect(() => {
    let hls: Hls | null = null;
    let token: string | null = null;
    let cancelled = false;
    const urls: string[] = [];
    api
      .playStart(id, 0)
      .then(async (p) => {
        token = p.token;
        if (cancelled) return;
        setInfo(p);
        const v = video.current!;
        if (Hls.isSupported()) {
          hls = new Hls({ enableWorker: false, backBufferLength: 60 });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(`Playback stopped (${data.details}). The file may need converting that this server can't do quickly.`);
          });
          hls.loadSource(p.url);
          hls.attachMedia(v);
        } else {
          v.src = p.url;
        }
        v.play().catch(() => undefined);
        // Subtitles: load each as a local blob so the player can show it.
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
          const def = p.subtitles.find((t) => t.default && loaded[t.index]);
          if (def) setSub(def.index);
        }
      })
      .catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
      hls?.destroy();
      urls.forEach((u) => URL.revokeObjectURL(u));
      if (token) void api.playStop(token).catch(() => undefined);
      void getCurrentWindow().setFullscreen(false).catch(() => undefined);
    };
  }, [id]);

  // Show the chosen subtitle track.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    for (let i = 0; i < v.textTracks.length; i++) {
      const tt = v.textTracks[i];
      tt.mode = tt.label === String(sub) ? "showing" : "disabled";
    }
  }, [sub, subUrls]);

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
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const pct = (t: number) => `${duration ? (t / duration) * 100 : 0}%`;
  const skipLabel = current?.kind === "Intro" ? "Skip intro" : current?.kind === "Recap" ? "Skip recap" : "Skip credits";

  return (
    <div ref={box} className={`player ${controls ? "" : "hide"}`} onMouseMove={wake} onClick={wake}>
      <video
        ref={video}
        onClick={toggle}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={onClose}
        crossOrigin="anonymous"
      >
        {Object.entries(subUrls).map(([idx, u]) => (
          <track key={idx} kind="subtitles" src={u} label={idx} />
        ))}
      </video>

      <div className="p-top">
        <button onClick={onClose}>← Back</button>
        <span className="p-title">{info?.title ?? "Starting…"}</span>
      </div>

      {error && <div className="p-error">{error}</div>}

      {current && (
        <button className="p-skip primary" onClick={() => seek(current.end)}>{skipLabel}</button>
      )}

      <div className="p-bottom">
        <div className="p-bar">
          {marks.map((m, i) => (
            <span key={i} className={`p-mark ${m.kind.toLowerCase()}`} style={{ left: pct(m.start), width: `calc(${pct(m.end)} - ${pct(m.start)})` }} />
          ))}
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={1}
            value={time}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Position"
          />
        </div>
        <div className="p-row">
          <button onClick={toggle} aria-label={playing ? "Pause" : "Play"}>{playing ? "❚❚" : "▶"}</button>
          <button onClick={() => seek(time - 10)} aria-label="Back 10 seconds">−10</button>
          <button onClick={() => seek(time + 10)} aria-label="Forward 10 seconds">+10</button>
          <span className="mono small">{fmt(time)} / {fmt(duration)}</span>
          <div className="spacer" />
          <input
            className="p-vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              if (video.current) video.current.volume = v;
            }}
            aria-label="Volume"
          />
          <select value={sub} onChange={(e) => setSub(Number(e.target.value))} aria-label="Subtitles">
            <option value={-1}>Subtitles off</option>
            {(info?.subtitles ?? []).filter((t) => subUrls[t.index]).map((t) => (
              <option key={t.index} value={t.index}>{t.title}</option>
            ))}
          </select>
          <button onClick={() => void fullscreen()} aria-label="Full screen">⛶</button>
        </div>
      </div>
    </div>
  );
}
