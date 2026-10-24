import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, SegEpisode, SegOverview, Span } from "./api";

type Part = "intro" | "recap" | "credits";
const KIND: Record<Part, string> = { intro: "Intro", recap: "Recap", credits: "Outro" };
const LABEL: Record<Part, string> = { intro: "Intro", recap: "Recap", credits: "Credits" };

interface Draft {
  intro: Span | null;
  recap: Span | null;
  credits: Span | null;
  source: string;
  problem: string | null;
}

export function fmt(t: number): string {
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round(t));
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

function saved(ep: SegEpisode, part: Part): Span | null {
  const s = ep.segments.find((x) => x.kind === KIND[part]);
  return s ? { start: s.start, end: s.end } : null;
}

const same = (a: Span | null, b: Span | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.start - b.start) < 0.5 && Math.abs(a.end - b.end) < 0.5);

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const epName = (e: SegEpisode) => `${e.index != null ? `E${e.index} ` : ""}${e.name}`;

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

interface Flag {
  id: string;
  ep: SegEpisode;
  title: string;
  why: string;
  actions: { label: string; danger?: boolean; run: () => void }[];
}

export function IntrosTab({ seasonId, seasonName, canEdit, onSettings }: { seasonId: string; seasonName?: string; canEdit: boolean; onSettings: () => void }) {
  const [ov, setOv] = useState<SegOverview | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // whole-season tool
  const [part, setPart] = useState<Part>("credits");
  const [mode, setMode] = useState<"fixed" | "end" | "percent">("end");
  const [v1, setV1] = useState("3:00");
  const [v2, setV2] = useState("");
  const [applyTo, setApplyTo] = useState<"season" | "selected">("season");
  const [shiftBy, setShiftBy] = useState(2);
  const [drawing, setDrawing] = useState<Part>("intro");

  async function load() {
    try {
      const o = await api.segmentsOverview(seasonId);
      setOv(o);
      const d: Record<string, Draft> = {};
      for (const e of o.episodes) d[e.id] = { intro: saved(e, "intro"), recap: saved(e, "recap"), credits: saved(e, "credits"), source: "", problem: null };
      setDrafts(d);
      setSelected(new Set());
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

  const eps = ov?.episodes ?? [];
  const maxDur = Math.max(60, ...eps.map((e) => e.duration));
  const set = (id: string, p: Part, s: Span | null) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [p]: s, source: "manual" } }));
  const targets = () => eps.filter((e) => applyTo === "season" || selected.has(e.id));

  async function detect() {
    setError(null);
    setNote(null);
    setProgress("Starting…");
    try {
      const res = await api.detectSeason(seasonId, 6 * 60, 5 * 60);
      setDrafts((old) => {
        const next = { ...old };
        for (const r of res) {
          next[r.id] = {
            ...next[r.id],
            intro: r.intro ?? old[r.id]?.intro ?? null,
            credits: r.credits ?? old[r.id]?.credits ?? null,
            source: [r.introSource, r.creditsSource].filter(Boolean).join(" / "),
            problem: r.problem,
          };
        }
        return next;
      });
      setNote(`Found an intro in ${res.filter((r) => r.intro).length} of ${res.length} episodes and credits in ${res.filter((r) => r.credits).length}. Review below, then save.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  function applyRule() {
    const a = parseTime(v1);
    const b = v2.trim() ? parseTime(v2) : null;
    if (a === null) return setError("Type a time like 3:00 or 1:30.");
    setError(null);
    setDrafts((d) => {
      const next = { ...d };
      for (const e of targets()) {
        let span: Span | null = null;
        if (mode === "fixed") span = { start: a, end: b ?? Math.min(e.duration, a + 60) };
        else if (mode === "end") span = part === "credits" ? { start: Math.max(0, e.duration - a), end: e.duration } : { start: Math.max(0, e.duration - a), end: Math.max(0, e.duration - (b ?? 0)) };
        else span = { start: (e.duration * a) / 100, end: b != null ? (e.duration * b) / 100 : part === "credits" ? e.duration : (e.duration * a) / 100 + 60 };
        if (span.end > span.start) next[e.id] = { ...next[e.id], [part]: span, source: "manual" };
      }
      return next;
    });
  }

  function shift(sign: number) {
    setDrafts((d) => {
      const next = { ...d };
      for (const e of targets()) {
        const cur = next[e.id]?.[part];
        if (cur) next[e.id] = { ...next[e.id], [part]: { start: Math.max(0, cur.start + sign * shiftBy), end: Math.min(e.duration, cur.end + sign * shiftBy) }, source: "manual" };
      }
      return next;
    });
  }

  // "Looks wrong": compared with the rest of the season.
  const flags = useMemo<Flag[]>(() => {
    const out: Flag[] = [];
    const withIntro = eps.filter((e) => drafts[e.id]?.intro);
    const introStart = median(withIntro.map((e) => drafts[e.id].intro!.start));
    const introLen = median(withIntro.map((e) => drafts[e.id].intro!.end - drafts[e.id].intro!.start));
    const withCredits = eps.filter((e) => drafts[e.id]?.credits);
    const fromEnd = median(withCredits.map((e) => e.duration - drafts[e.id].credits!.start));
    eps.forEach((e, i) => {
      const d = drafts[e.id];
      if (!d) return;
      if (d.intro && introStart !== null && introLen !== null && Math.abs(d.intro.start - introStart) > 45) {
        out.push({
          id: `intro-${e.id}`, ep: e, title: `${epName(e)} · Intro starts at ${fmt(d.intro.start)}`,
          why: `The other episodes start around ${fmt(introStart)}. A cold open may be the reason.`,
          actions: [
            { label: "Fix to median", run: () => set(e.id, "intro", { start: introStart, end: introStart + introLen }) },
            { label: "Remove", danger: true, run: () => set(e.id, "intro", null) },
          ],
        });
      }
      if (!d.intro && withIntro.length >= Math.max(2, eps.length * 0.6)) {
        const prev = [...eps.slice(0, i)].reverse().find((p) => drafts[p.id]?.intro) ?? eps.slice(i + 1).find((p) => drafts[p.id]?.intro);
        out.push({
          id: `nointro-${e.id}`, ep: e, title: `${epName(e)} · No intro found`, why: "Most other episodes have one.",
          actions: [
            ...(prev ? [{ label: `Copy from ${prev.index != null ? `E${prev.index}` : prev.name}`, run: () => set(e.id, "intro", { ...drafts[prev.id].intro! }) }] : []),
            { label: "Ignore", run: () => setIgnored((s) => new Set(s).add(`nointro-${e.id}`)) },
          ],
        });
      }
      if (d.credits && fromEnd !== null && Math.abs(e.duration - d.credits.start - fromEnd) > 90) {
        out.push({
          id: `credits-${e.id}`, ep: e, title: `${epName(e)} · Credits start at ${fmt(d.credits.start)}`,
          why: `Most episodes have credits from ${fmt(fromEnd)} before the end; this one has ${fmt(e.duration - d.credits.start)}.`,
          actions: [
            { label: "Fix to median", run: () => set(e.id, "credits", { start: Math.max(0, e.duration - fromEnd), end: e.duration }) },
            { label: "Remove", danger: true, run: () => set(e.id, "credits", null) },
          ],
        });
      }
    });
    return out.filter((f) => !ignored.has(f.id));
  }, [eps, drafts, ignored]); // eslint-disable-line react-hooks/exhaustive-deps

  const wrong = (id: string, p: Part) => flags.some((f) => f.ep.id === id && f.id.startsWith(p === "intro" ? "intro-" : p === "credits" ? "credits-" : "x"));

  const changes = useMemo(() => {
    const out: { ep: SegEpisode; part: Part; from: Span | null; to: Span | null }[] = [];
    for (const e of eps) {
      const d = drafts[e.id];
      if (!d) continue;
      (["intro", "recap", "credits"] as Part[]).forEach((p) => {
        if (!same(d[p], saved(e, p))) out.push({ ep: e, part: p, from: saved(e, p), to: d[p] });
      });
    }
    return out;
  }, [eps, drafts]);

  async function saveAll() {
    setSaving(true);
    setError(null);
    let ok = 0;
    const failed: string[] = [];
    const byEp = new Map<string, SegEpisode>();
    changes.forEach((c) => byEp.set(c.ep.id, c.ep));
    for (const e of byEp.values()) {
      const d = drafts[e.id];
      const pick = (p: Part) => (same(d[p], saved(e, p)) ? null : d[p]);
      const clear = (["intro", "recap", "credits"] as Part[]).filter((p) => !d[p] && saved(e, p)).map((p) => KIND[p]);
      try {
        await api.saveSegments(e.id, pick("intro"), pick("credits"), pick("recap"), clear);
        ok++;
      } catch (err) {
        failed.push(`${e.name}: ${errorText(err)}`);
        if (/plugin|switched off/i.test(errorText(err))) break;
      }
    }
    setSaving(false);
    setNote(`Saved ${ok} episode${ok === 1 ? "" : "s"}. Every change is in the undo list on the episode's page.`);
    if (failed.length) setError(failed.slice(0, 3).join(" · "));
    await load();
  }

  if (error && !ov) return <p className="error">{error}</p>;
  if (!ov) return <p className="muted">Loading episodes…</p>;
  const ticks: number[] = [];
  const step = maxDur > 3600 ? 1200 : maxDur > 1200 ? 600 : 300;
  for (let t = 0; t <= maxDur; t += step) ticks.push(t);

  return (
    <div className="seg-layout">
      <aside className="seg-side">
        <div className="card form">
          <h2>Set for the whole season</h2>
          <div className="seg wide3">
            {(["intro", "recap", "credits"] as Part[]).map((p) => (
              <button key={p} className={part === p ? "on" : ""} onClick={() => setPart(p)}>{LABEL[p]}</button>
            ))}
          </div>
          <div className="seg wide3">
            <button className={mode === "fixed" ? "on" : ""} onClick={() => setMode("fixed")}>Fixed time</button>
            <button className={mode === "end" ? "on" : ""} onClick={() => setMode("end")}>From the end</button>
            <button className={mode === "percent" ? "on" : ""} onClick={() => setMode("percent")}>Percent</button>
          </div>
          {mode === "fixed" && (
            <div className="row">
              <label>{LABEL[part]} starts at<input className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="0:45" /></label>
              <label>and ends at<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder="1:45" /></label>
            </div>
          )}
          {mode === "end" && (
            <label>{LABEL[part]} start{part === "credits" ? "s" : ""} this long before the end<input className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="3:00" /></label>
          )}
          {mode === "percent" && (
            <div className="row">
              <label>Starts at (%)<input className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="95" /></label>
              <label>Ends at (%)<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder={part === "credits" ? "100" : ""} /></label>
            </div>
          )}
          <label>Apply to
            <select value={applyTo} onChange={(e) => setApplyTo(e.target.value as "season" | "selected")}>
              <option value="season">{seasonName ?? "This season"} ({eps.length} episodes)</option>
              <option value="selected">Selected episodes only ({selected.size})</option>
            </select>
          </label>
          <button onClick={applyRule}>Apply {LABEL[part].toLowerCase()} times</button>
          <div className="shift">
            <span className="muted small">Shift {LABEL[part].toLowerCase()} by</span>
            <button onClick={() => shift(-1)} aria-label="Earlier">−</button>
            <input className="mono num" value={shiftBy} onChange={(e) => setShiftBy(Math.max(0, Math.min(600, Number(e.target.value) || 0)))} />
            <span className="muted small">s</span>
            <button onClick={() => shift(1)} aria-label="Later">+</button>
          </div>
          <button className="outline" disabled={!!progress || !ov.ffmpeg} onClick={() => void detect()}>{progress ? "Listening…" : "Auto-detect this season"}</button>
          {!ov.ffmpeg && <p className="muted small">Auto-detect needs ffmpeg. <button className="link" onClick={onSettings}>How to install</button></p>}
          <button className="primary" disabled={!changes.length || saving || !canEdit || !ov.canWriteSegments} onClick={() => void saveAll()}>
            {saving ? "Saving…" : `Save ${changes.length || ""} change${changes.length === 1 ? "" : "s"} to Jellyfin`}
          </button>
          {!canEdit && <p className="muted small">Saving needs changes to Jellyfin switched on in Settings.</p>}
          {canEdit && !ov.canWriteSegments && <p className="muted small">To save, install the “MediaSegments API” plugin in Jellyfin (Dashboard → Plugins → Catalog) and restart Jellyfin.</p>}
        </div>

        <div className="card form">
          <h2>Changes to review</h2>
          {changes.length === 0 && <p className="muted small">No changes yet.</p>}
          {changes.slice(0, 40).map((c, i) => (
            <div className="diff" key={i}>
              <span className="diff-ep">{epName(c.ep)} · {LABEL[c.part]}</span>
              <span className="mono small muted">{c.from ? fmt(c.from.start) : "none"} <span className="accent">→ {c.to ? `${fmt(c.to.start)}–${fmt(c.to.end)}` : "removed"}</span></span>
            </div>
          ))}
          {changes.length > 0 && <button className="link small" onClick={() => void load()}>Discard all changes</button>}
          <p className="muted small">Every saved change goes into the undo list, so you can put it back.</p>
        </div>
      </aside>

      <section className="seg-main">
        <div className="section-head">
          <h2 className="big">{seasonName ?? "Season"} timeline</h2>
          <div className="legend small muted">
            <span><span className="key intro" />Intro</span>
            <span><span className="key recap" />Recap</span>
            <span><span className="key credits" />Credits</span>
            <span><span className="key wrong" />Looks wrong</span>
            <span><span className="key saved" />Saved</span>
          </div>
        </div>
        {progress && <p className="muted small">{progress}. This reads the start and end of each episode from your NAS.</p>}
        {note && <p className="note">{note}</p>}
        {error && <p className="error">{error}</p>}

        <div className="card timeline-card">
          <div className="seg-draw small muted">
            Drag on a bar to draw:
            <div className="seg">
              {(["intro", "recap", "credits"] as Part[]).map((p) => (
                <button key={p} className={drawing === p ? "on" : ""} onClick={() => setDrawing(p)}>{LABEL[p]}</button>
              ))}
            </div>
          </div>
          <div className="tl-row tl-ticks">
            <div className="tl-name" />
            <div className="tl-track ticks">
              {ticks.map((t) => <span key={t} style={{ left: `${(t / maxDur) * 100}%` }}>{fmt(t)}</span>)}
            </div>
          </div>
          {eps.map((e) => {
            const d = drafts[e.id];
            if (!d) return null;
            const f = flags.find((x) => x.ep.id === e.id);
            return (
              <div key={e.id}>
                <div className="tl-row">
                  <div className="tl-name">
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} aria-label="Select episode" />
                    <button className="link-plain" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <span className="tl-title">{epName(e)}</span>
                      <span className={`small ${f ? "bad" : d.problem ? "warn" : "muted"}`}>{f ? f.title.split(" · ")[1] : d.problem ?? (d.source ? `from ${d.source}` : "OK")}</span>
                    </button>
                  </div>
                  <Bars ep={e} draft={d} maxDur={maxDur} drawing={drawing} wrong={wrong} onDraw={(p, s) => set(e.id, p, s)} />
                </div>
                {open === e.id && (
                  <div className="tl-detail">
                    {(["intro", "recap", "credits"] as Part[]).map((p) => (
                      <span key={p} className="tl-times">
                        <span className={`key ${p}`} />{LABEL[p]}
                        <TimeInput value={d[p]?.start} onChange={(v) => v === null ? set(e.id, p, null) : set(e.id, p, { start: v, end: Math.max(v + 1, d[p]?.end ?? Math.min(e.duration, v + 60)) })} />
                        –
                        <TimeInput value={d[p]?.end} onChange={(v) => v !== null && v > (d[p]?.start ?? 0) && set(e.id, p, { start: d[p]?.start ?? 0, end: v })} />
                      </span>
                    ))}
                    <span className="muted small">length {fmt(e.duration)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="card form">
          <div className="section-head"><h2>Suspicious segments</h2><span className="muted small">Compared with the season median</span></div>
          {flags.length === 0 && <p className="muted small">Nothing looks off.</p>}
          {flags.map((f) => (
            <div className="flag-row" key={f.id}>
              <div>
                <div className="title">{f.title}</div>
                <div className="muted small">{f.why}</div>
              </div>
              <div className="row">
                {f.actions.map((a) => <button key={a.label} className={a.danger ? "danger-outline" : ""} onClick={a.run}>{a.label}</button>)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Bars({ ep, draft, maxDur, drawing, wrong, onDraw }: {
  ep: SegEpisode; draft: Draft; maxDur: number; drawing: Part; wrong: (id: string, p: Part) => boolean; onDraw: (p: Part, s: Span) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / maxDur) * 100))}%`;
  const at = (x: number) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(ep.duration, ((x - r.left) / r.width) * maxDur));
  };
  const bar = (s: Span | null, cls: string, key: string) =>
    s && <div key={key} className={`seg-bar ${cls}`} style={{ left: pct(s.start), width: `calc(${pct(s.end)} - ${pct(s.start)})` }} />;
  return (
    <div
      ref={ref}
      className="tl-track"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        const t = at(e.clientX);
        setDrag({ from: t, to: t });
      }}
      onPointerMove={(e) => drag && setDrag({ ...drag, to: at(e.clientX) })}
      onPointerUp={() => {
        if (drag && Math.abs(drag.to - drag.from) > 2) onDraw(drawing, { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) });
        setDrag(null);
      }}
    >
      <div className="tl-length" style={{ width: pct(ep.duration) }} />
      {(["intro", "recap", "credits"] as Part[]).map((p) => bar(saved(ep, p), "saved", `s-${p}`))}
      {(["intro", "recap", "credits"] as Part[]).map((p) => bar(draft[p], `${p}${wrong(ep.id, p) ? " wrong" : ""}`, `d-${p}`))}
      {drag && bar({ start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }, `drawing ${drawing}`, "drag")}
    </div>
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
          ffmpeg is used to listen for intros and credits and by the storage tools. Install it once:{" "}
          {mac ? <>in Terminal run <span className="mono">brew install ffmpeg</span> (needs Homebrew from brew.sh)</> : <>in PowerShell run <span className="mono">winget install Gyan.FFmpeg</span></>}
          , then press Check again. Or choose an ffmpeg file you already have.
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
