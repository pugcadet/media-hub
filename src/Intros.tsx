import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, SegEpisode, SegOverview, Span } from "./api";

type Kind = "intro" | "credits";

interface Draft {
  intro: Span | null;
  credits: Span | null;
  introSource: string;
  creditsSource: string;
  problem: string | null;
}

export function fmt(t: number): string {
  if (!Number.isFinite(t)) return "";
  const s = Math.round(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "1:23", "1:02:03" or "83" -> seconds. */
export function parseTime(v: string): number | null {
  const parts = v.trim().split(":").map((p) => p.trim());
  if (!parts.length || parts.some((p) => p === "" || !/^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

function saved(ep: SegEpisode, kind: "Intro" | "Outro"): Span | null {
  const s = ep.segments.find((x) => x.kind === kind);
  return s ? { start: s.start, end: s.end } : null;
}

const same = (a: Span | null, b: Span | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.start - b.start) < 0.5 && Math.abs(a.end - b.end) < 0.5);

function TimeInput({ value, onChange }: { value: number | undefined; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value != null ? fmt(value) : "");
  useEffect(() => setText(value != null ? fmt(value) : ""), [value]);
  return (
    <input
      className="mono time"
      value={text}
      placeholder="–"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.trim() ? parseTime(text) : null)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function Timeline({ ep, draft, drawing, onDraw }: { ep: SegEpisode; draft: Draft; drawing: Kind; onDraw: (k: Kind, s: Span) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const d = ep.duration || 1;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / d) * 100))}%`;
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(d, ((clientX - r.left) / r.width) * d));
  };
  const bar = (s: Span | null, cls: string) =>
    s && <div className={`seg-bar ${cls}`} style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }} />;
  return (
    <div
      ref={ref}
      className="timeline"
      title="Drag to draw the selected part"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const t = at(e.clientX);
        setDrag({ from: t, to: t });
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, to: at(e.clientX) })}
      onPointerUp={() => {
        if (drag && Math.abs(drag.to - drag.from) > 2) {
          onDraw(drawing, { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) });
        }
        setDrag(null);
      }}
    >
      {bar(saved(ep, "Intro"), "saved intro")}
      {bar(saved(ep, "Outro"), "saved credits")}
      {bar(draft.intro, "intro")}
      {bar(draft.credits, "credits")}
      {drag && bar({ start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }, `drawing ${drawing}`)}
    </div>
  );
}

export function IntrosTab({ seasonId, canEdit, onSettings }: { seasonId: string; canEdit: boolean; onSettings: () => void }) {
  const [ov, setOv] = useState<SegOverview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Kind>("intro");
  const [introMax, setIntroMax] = useState(6);
  const [creditsMax, setCreditsMax] = useState(4);
  const [saving, setSaving] = useState(false);

  async function load() {
    try {
      const o = await api.segmentsOverview(seasonId);
      setOv(o);
      const d: Record<string, Draft> = {};
      for (const e of o.episodes) {
        d[e.id] = { intro: saved(e, "Intro"), credits: saved(e, "Outro"), introSource: "", creditsSource: "", problem: null };
      }
      setDrafts(d);
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => void load(), [seasonId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const un = listen<{ done: number; total: number; label: string }>("detect-progress", (e) =>
      setProgress(`${e.payload.label} (${Math.min(e.payload.done + 1, e.payload.total)}/${e.payload.total})`),
    );
    return () => void un.then((f) => f());
  }, []);

  async function detect() {
    setError(null);
    setNote(null);
    setProgress("Starting…");
    try {
      const res = await api.detectSeason(seasonId, introMax * 60, creditsMax * 60);
      setDrafts((old) => {
        const next = { ...old };
        for (const r of res) {
          next[r.id] = {
            intro: r.intro ?? old[r.id]?.intro ?? null,
            credits: r.credits ?? old[r.id]?.credits ?? null,
            introSource: r.introSource,
            creditsSource: r.creditsSource,
            problem: r.problem,
          };
        }
        return next;
      });
      const found = res.filter((r) => r.intro).length;
      setNote(`Found an intro in ${found} of ${res.length} episodes and credits in ${res.filter((r) => r.credits).length}. Check them, then save.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  const changed = useMemo(
    () => (ov?.episodes ?? []).filter((e) => drafts[e.id] && (!same(drafts[e.id].intro, saved(e, "Intro")) || !same(drafts[e.id].credits, saved(e, "Outro")))),
    [ov, drafts],
  );

  function set(id: string, k: Kind, s: Span | null) {
    setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: s, [`${k}Source`]: "manual" } }));
  }

  function setPart(ep: SegEpisode, k: Kind, part: "start" | "end", v: number | null) {
    const cur = drafts[ep.id]?.[k];
    if (v === null) {
      if (part === "start") set(ep.id, k, null);
      return;
    }
    const next = { start: cur?.start ?? 0, end: cur?.end ?? Math.min(ep.duration, v + 30), [part]: v };
    if (next.end > next.start) set(ep.id, k, next);
  }

  function copyToAll(from: SegEpisode, k: Kind) {
    const s = drafts[from.id]?.[k];
    if (!s || !ov) return;
    setDrafts((d) => {
      const next = { ...d };
      for (const e of ov.episodes) {
        if (k === "intro") next[e.id] = { ...next[e.id], intro: { ...s }, introSource: "manual" };
        else {
          // Credits are copied as "the same distance from the end".
          const len = s.end - s.start;
          const fromEnd = from.duration - s.end;
          const end = Math.max(0, e.duration - fromEnd);
          next[e.id] = { ...next[e.id], credits: { start: Math.max(0, end - len), end }, creditsSource: "manual" };
        }
      }
      return next;
    });
  }

  async function saveAll() {
    if (!ov) return;
    setSaving(true);
    setError(null);
    let ok = 0;
    const failed: string[] = [];
    for (const e of changed) {
      const d = drafts[e.id];
      const clear: string[] = [];
      if (!d.intro && saved(e, "Intro")) clear.push("Intro");
      if (!d.credits && saved(e, "Outro")) clear.push("Outro");
      try {
        await api.saveSegments(
          e.id,
          same(d.intro, saved(e, "Intro")) ? null : d.intro,
          same(d.credits, saved(e, "Outro")) ? null : d.credits,
          clear,
        );
        ok++;
      } catch (err) {
        failed.push(`${e.name}: ${errorText(err)}`);
        if (/plugin/i.test(errorText(err))) break;
      }
    }
    setSaving(false);
    setNote(`Saved ${ok} episode${ok === 1 ? "" : "s"}.`);
    if (failed.length) setError(failed.slice(0, 3).join(" · "));
    await load();
  }

  if (error && !ov) return <p className="error">{error}</p>;
  if (!ov) return <p className="muted">Loading episodes…</p>;

  return (
    <section className="card form">
      {!ov.ffmpeg && (
        <p className="note">
          Auto-detect needs ffmpeg on this computer. <button className="link" onClick={onSettings}>See Settings → Tools</button>.
        </p>
      )}
      {!ov.canWriteSegments && (
        <p className="note">
          To save, install the “MediaSegments API” plugin in Jellyfin (Dashboard → Plugins → Catalog) and restart Jellyfin. Detecting works without it.
        </p>
      )}
      <div className="row">
        <label className="narrow wide-label">Look for intro in first (min)
          <input type="number" min={1} max={20} value={introMax} onChange={(e) => setIntroMax(Math.max(1, Math.min(20, Number(e.target.value) || 6)))} />
        </label>
        <label className="narrow wide-label">Credits in last (min)
          <input type="number" min={1} max={15} value={creditsMax} onChange={(e) => setCreditsMax(Math.max(1, Math.min(15, Number(e.target.value) || 4)))} />
        </label>
        <button className="primary" disabled={!!progress || !ov.ffmpeg} onClick={() => void detect()}>
          {progress ? "Detecting…" : "Auto-detect this season"}
        </button>
        <div className="spacer" />
        <div className="seg">
          <button className={drawing === "intro" ? "on" : ""} onClick={() => setDrawing("intro")}>Draw intro</button>
          <button className={drawing === "credits" ? "on" : ""} onClick={() => setDrawing("credits")}>Draw credits</button>
        </div>
      </div>
      {progress && <p className="muted small">{progress}. This reads the start and end of each episode from your NAS.</p>}
      {note && <p className="note">{note}</p>}
      {error && <p className="error">{error}</p>}
      <div className="legend small muted">
        <span className="key intro" /> intro <span className="key credits" /> credits <span className="key saved" /> saved in Jellyfin
      </div>

      <div className="seg-table">
        {ov.episodes.map((e) => {
          const d = drafts[e.id];
          if (!d) return null;
          return (
            <div className="seg-row" key={e.id}>
              <div className="seg-name">
                <div>{e.index != null ? `E${String(e.index).padStart(2, "0")} ` : ""}{e.name}</div>
                <div className="small muted">
                  {fmt(e.duration)}
                  {d.introSource && d.introSource !== "manual" ? ` · intro from ${d.introSource}` : ""}
                  {d.creditsSource && d.creditsSource !== "manual" ? ` · credits from ${d.creditsSource}` : ""}
                  {d.problem ? ` · ${d.problem}` : ""}
                </div>
              </div>
              <Timeline ep={e} draft={d} drawing={drawing} onDraw={(k, s) => set(e.id, k, s)} />
              <div className="seg-times">
                <span className="key intro" />
                <TimeInput value={d.intro?.start} onChange={(v) => setPart(e, "intro", "start", v)} />
                <TimeInput value={d.intro?.end} onChange={(v) => setPart(e, "intro", "end", v)} />
                <button className="link small" title="Use these intro times for every episode" onClick={() => copyToAll(e, "intro")}>all</button>
                <span className="key credits" />
                <TimeInput value={d.credits?.start} onChange={(v) => setPart(e, "credits", "start", v)} />
                <TimeInput value={d.credits?.end} onChange={(v) => setPart(e, "credits", "end", v)} />
                <button className="link small" title="Same distance from the end for every episode" onClick={() => copyToAll(e, "credits")}>all</button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="applybar">
        <span className="muted small">{changed.length} episode{changed.length === 1 ? "" : "s"} changed</span>
        <div className="spacer" />
        <button disabled={!changed.length || saving} onClick={() => void load()}>Discard changes</button>
        <button className="primary" disabled={!changed.length || saving || !canEdit || !ov.canWriteSegments} onClick={() => void saveAll()}>
          {saving ? "Saving…" : "Save to Jellyfin"}
        </button>
      </div>
      {!canEdit && <p className="muted small">Saving needs changes to Jellyfin switched on in Settings.</p>}
    </section>
  );
}

/** Settings block for ffmpeg. */
export function ToolsSettings() {
  const [info, setInfo] = useState<{ path: string | null; version: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api.ffmpegInfo().then(setInfo).catch((e) => setError(errorText(e)));
  useEffect(() => void load(), []);
  const mac = navigator.userAgent.includes("Mac");
  return (
    <section className="card form">
      <h2>Tools</h2>
      <div className="kv"><span className="muted">ffmpeg</span><span className="mono">{info ? info.version ?? "Not found" : "Checking…"}</span></div>
      {info?.path && <div className="kv"><span className="muted">Location</span><span className="mono small">{info.path}</span></div>}
      {info && !info.path && (
        <p className="muted small">
          ffmpeg is used to listen for intros and credits. Install it once:{" "}
          {mac ? <>in Terminal run <span className="mono">brew install ffmpeg</span> (needs Homebrew from brew.sh)</> : <>in PowerShell run <span className="mono">winget install Gyan.FFmpeg</span></>}
          , then reopen this page. Or choose an ffmpeg file you already have.
        </p>
      )}
      <div className="row">
        <button onClick={() => void api.pickFfmpeg().then(() => load()).catch((e) => setError(errorText(e)))}>Choose ffmpeg…</button>
        <button onClick={() => void load()}>Check again</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
