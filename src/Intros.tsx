import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, openMenu, SettingsLink, type MenuItem } from "./ui";
import { listen } from "@tauri-apps/api/event";
import Hls from "hls.js";
import { api, errorText, SegEpisode, SegOverview, Span } from "./api";
import { track, type JobHandle } from "./activity";
import { askConfirm } from "./confirm";
import { prefs, setPrefs, usePrefs } from "./prefs";

const autoTried = new Set<string>();

/**
 * Finds intros and credits for a season in the background when it has no markers yet, and
 * saves only the sure ones (found by listening, or by chapter names, without a problem).
 */
export async function autoDetectSeason(seasonId: string, seasonLabel: string): Promise<void> {
  if (autoTried.has(seasonId)) return;
  autoTried.add(seasonId);
  const ov = await api.segmentsOverview(seasonId).catch(() => null);
  if (!ov || !ov.ffmpeg || !ov.canWriteSegments || ov.episodes.length < 2) return;
  if (ov.episodes.some((e) => e.segments.some((x) => x.kind === "Intro" || x.kind === "Outro"))) return;
  await track(`Finding intros: ${seasonLabel}`, async (job) => {
    const un = await listen<{ done: number; total: number; label: string }>("detect-progress", (e) => job.update(e.payload.label, e.payload.total ? e.payload.done / e.payload.total : null));
    let saved = 0;
    try {
      const { detectIntro, detectCredits } = prefs();
      const res = await api.detectSeason(seasonId, 6 * 60, 5 * 60, detectIntro, detectCredits);
      for (const r of res) {
        if (r.problem || (!r.intro && !r.credits)) continue;
        await api.saveSegments(r.id, r.intro, r.credits, null, []).then(() => saved++).catch(() => undefined);
      }
    } finally {
      un();
    }
    job.update(saved ? `Markers saved for ${saved} episodes` : "Nothing sure enough to save", 1);
  }, { reload: false, stop: "detect" }).catch(() => undefined);
}

/** Finds markers in the given seasons and saves the sure ones (no problem reported). */
export async function detectAndSave(seasonIds: string[], job?: JobHandle, only?: Set<string>): Promise<number> {
  const { detectIntro, detectCredits } = prefs();
  let saved = 0;
  const un = job ? await listen<{ done: number; total: number; label: string }>("detect-progress", (e) => job.update(e.payload.label, e.payload.total ? e.payload.done / e.payload.total : null)) : null;
  try {
    for (const sid of seasonIds) {
      if (job?.cancelled) break;
      const res = await api.detectSeason(sid, 6 * 60, 5 * 60, detectIntro, detectCredits);
      for (const r of res) {
        if (only && !only.has(r.id)) continue;
        if (r.problem || (!r.intro && !r.credits)) continue;
        await api.saveSegments(r.id, r.intro, r.credits, null, []).then(() => saved++).catch(() => undefined);
      }
    }
  } finally {
    un?.();
  }
  job?.update(saved ? `Markers saved for ${saved} episodes` : "Nothing sure enough to save", 1);
  return saved;
}

/** Removes every marker of `kinds` ("Intro" | "Outro" | "Recap") in the given seasons. */
export async function removeSegments(seasonIds: string[], kinds: string[], job?: JobHandle): Promise<number> {
  let n = 0;
  for (const [si, sid] of seasonIds.entries()) {
    if (job?.cancelled) break;
    const ov = await api.segmentsOverview(sid);
    const eps = ov.episodes.filter((e) => e.segments.some((x) => kinds.includes(x.kind)));
    for (const [i, e] of eps.entries()) {
      if (job?.cancelled) break;
      job?.update(e.name, (si + i / Math.max(1, eps.length)) / seasonIds.length);
      await api.saveSegments(e.id, null, null, null, kinds);
      n++;
    }
  }
  job?.update(`${n} episode${n === 1 ? "" : "s"} cleaned`, 1);
  return n;
}

export type Part = "intro" | "recap" | "credits";
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

/** "Intro 0:05–0:35 · Credits 19:40" or "No markers yet". */
function summary(d: Draft, parts: Part[]): string {
  const bits = parts.filter((p) => d[p]).map((p) => `${LABEL[p]} ${fmt(d[p]!.start)}–${fmt(d[p]!.end)}`);
  return bits.length ? bits.join(" · ") + (d.source && d.source !== "manual" ? ` (${d.source})` : "") : "No markers yet";
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

/** What an action works on. */
export type Scope = "episode" | "selected" | "season" | "show";
/** Asks the editor to get ready to set a part for a scope (from a right-click "Set intro…"). */
export interface SetCommand { part: Part; scope: Scope; n: number }

interface Flag {
  id: string;
  ep: SegEpisode;
  title: string;
  why: string;
  actions: { label: string; danger?: boolean; run: () => void }[];
}

export function IntrosTab({ seasonId, seasonName, canEdit, show, command }: {
  seasonId: string; seasonName?: string; canEdit: boolean; onSettings?: () => void;
  /** When opened for a whole show: offers removing markers in every season. */
  show?: { name: string; seasonIds: string[]; onChanged?: () => void };
  /** A right-click "Set intro…" from the show above: set the part and scope in the top box. */
  command?: SetCommand | null;
}) {
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
  const [applyTo, setApplyTo] = useState<Scope>("season");
  const firstInput = useRef<HTMLInputElement>(null);
  const [drawing, setDrawing] = useState<Part>("intro");
  const [preview, setPreview] = useState<string | null>(null);
  const p = usePrefs();
  const { recapsOff } = p;
  const parts: Part[] = recapsOff ? ["intro", "credits"] : ["intro", "recap", "credits"];

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

  // An episode without a known length is drawn as long as its last marker (plus a minute).
  const eps = (ov?.episodes ?? []).map((e) => (e.duration > 0 ? e : { ...e, duration: Math.max(60, ...e.segments.map((x) => x.end + 60)) }));
  const maxDur = Math.max(60, ...eps.map((e) => e.duration));
  const set = (id: string, p: Part, s: Span | null) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [p]: s, source: "manual" } }));
  const targetsOf = (scope: Scope, epId?: string) => eps.filter((e) => (scope === "episode" ? e.id === epId : scope === "selected" ? selected.has(e.id) : true));

  useEffect(() => {
    if (!command) return;
    setPart(command.part);
    setApplyTo(command.scope === "show" && !show ? "season" : command.scope);
    window.setTimeout(() => firstInput.current?.focus(), 50);
  }, [command]); // eslint-disable-line react-hooks/exhaustive-deps

  async function detect(scope: Scope = applyTo, epId?: string) {
    if (scope === "show" && show) return detectShow();
    const only = new Set(targetsOf(scope, epId).map((e) => e.id));
    if (!only.size) return setError("Select one or more episodes first.");
    setError(null);
    setNote(null);
    setProgress("Starting…");
    try {
      const { detectIntro, detectCredits } = prefs();
      const what = detectIntro && detectCredits ? "intros and credits" : detectIntro ? "intros" : "credits";
      // Shown in the top bar too, with a progress bar and Stop.
      const res = await track(`Finding ${what}`, async (job) => {
        const un = await listen<{ done: number; total: number; label: string }>("detect-progress", (e) => job.update(e.payload.label, e.payload.total ? e.payload.done / e.payload.total : null));
        try {
          return await api.detectSeason(seasonId, 6 * 60, 5 * 60, detectIntro, detectCredits);
        } finally {
          un();
        }
      }, { reload: false, stop: "detect" });
      setDrafts((old) => {
        const next = { ...old };
        for (const r of res) {
          if (!only.has(r.id)) continue;
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
      const got = res.filter((r) => only.has(r.id));
      setNote(`Found an intro in ${got.filter((r) => r.intro).length} of ${got.length} episode${got.length === 1 ? "" : "s"} and credits in ${got.filter((r) => r.credits).length}. Review below, then save.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  /** The span the top box describes for an episode of this length (null: times don't fit). */
  function ruleSpan(dur: number, pt: Part): Span | null | "bad" {
    const a = parseTime(v1);
    const b = v2.trim() ? parseTime(v2) : null;
    if (a === null) return "bad";
    let span: Span;
    if (mode === "fixed") span = { start: a, end: b ?? Math.min(dur, a + 60) };
    else if (mode === "end") span = pt === "credits" ? { start: Math.max(0, dur - a), end: dur } : { start: Math.max(0, dur - a), end: Math.max(0, dur - (b ?? 0)) };
    else span = { start: (dur * a) / 100, end: b != null ? (dur * b) / 100 : pt === "credits" ? dur : (dur * a) / 100 + 60 };
    return span.end > span.start ? span : null;
  }

  async function applyRule(scope: Scope = applyTo) {
    if (ruleSpan(3600, part) === "bad") return setError("Type a time like 3:00 or 1:30.");
    setError(null);
    if (scope === "show" && show) {
      if (!(await askConfirm(`Set the ${LABEL[part].toLowerCase()} times in every season of ${show.name}? Saved straight to Jellyfin; each one can be undone.`, { okLabel: "Set them" }))) return;
      await track(`${LABEL[part]} times for ${show.name}`, async (job) => {
        let n = 0;
        for (const [si, sid] of show.seasonIds.entries()) {
          if (job.cancelled) break;
          const o = await api.segmentsOverview(sid);
          for (const e of o.episodes) {
            if (job.cancelled) break;
            job.update(e.name, si / show.seasonIds.length);
            const sp = ruleSpan(e.duration, part);
            if (!sp || sp === "bad" || e.duration <= 0) continue;
            await api.saveSegments(e.id, part === "intro" ? sp : null, part === "credits" ? sp : null, part === "recap" ? sp : null, []);
            n++;
          }
        }
        job.update(`${n} episodes set`, 1);
      }, { cancellable: true, reload: false }).catch((e) => setError(errorText(e)));
      show.onChanged?.();
      return load();
    }
    const list = targetsOf(scope);
    if (!list.length) return setError("Select one or more episodes first.");
    setDrafts((d) => {
      const next = { ...d };
      for (const e of list) {
        const sp = ruleSpan(e.duration, part);
        if (sp && sp !== "bad") next[e.id] = { ...next[e.id], [part]: sp, source: "manual" };
      }
      return next;
    });
  }

  /** Clears a part in the scope: in your draft (review, then save), or straight away for the whole show. */
  async function clearPart(pt: Part, scope: Scope = applyTo, epId?: string) {
    if (scope === "show" && show) {
      const label = pt === "credits" ? "credits" : `${LABEL[pt].toLowerCase()}s`;
      if (!(await askConfirm(`Remove all ${label} in every season of ${show.name}?`, { okLabel: `Remove ${label}`, danger: true }))) return;
      await track(`Removing ${label}`, (job) => removeSegments(show.seasonIds, [KIND[pt]], job), { cancellable: true, reload: false }).catch(() => undefined);
      show.onChanged?.();
      return load();
    }
    setDrafts((d) => {
      const next = { ...d };
      for (const e of targetsOf(scope, epId)) if (next[e.id]?.[pt]) next[e.id] = { ...next[e.id], [pt]: null, source: "manual" };
      return next;
    });
  }

  async function detectShow() {
    if (!show) return;
    if (!(await askConfirm(`Listen to every episode of ${show.name} and save the intros and credits that are found for sure? Each one can be undone.`, { okLabel: "Find them" }))) return;
    await track(`Finding intros: ${show.name}`, (job) => detectAndSave(show.seasonIds, job).then(() => undefined), { cancellable: true, reload: false, stop: "detect" }).catch((e) => setError(errorText(e)));
    show.onChanged?.();
    await load();
  }

  /** Right-click menu for an episode, the selected episodes, this season or the whole show. */
  function menuFor(scope: Scope, epId?: string): MenuItem[] {
    const what = scope === "episode" ? "this episode" : scope === "selected" ? `${selected.size} selected` : scope === "season" ? "this season" : "the whole show";
    const setItem = (pt: Part): MenuItem => ({
      label: `Set ${LABEL[pt].toLowerCase()}…`,
      disabled: pt === "recap" && recapsOff,
      run: () => {
        if (scope === "episode" && epId) { setOpen(epId); setPreview(epId); setDrawing(pt); return; }
        setPart(pt);
        setApplyTo(scope);
        window.setTimeout(() => firstInput.current?.focus(), 50);
      },
    });
    return [
      { label: `Analyze ${what}`, disabled: !ov?.ffmpeg || (!p.detectIntro && !p.detectCredits), run: () => void detect(scope, epId) },
      { sep: true },
      setItem("intro"), setItem("recap"), setItem("credits"),
      { sep: true },
      { label: "Clear intro", danger: true, run: () => void clearPart("intro", scope, epId) },
      { label: "Clear recap", danger: true, run: () => void clearPart("recap", scope, epId) },
      { label: "Clear credits", danger: true, run: () => void clearPart("credits", scope, epId) },
    ];
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
          <h2>Set, clear or find</h2>
          <label>Works on
            <select value={applyTo} onChange={(e) => setApplyTo(e.target.value as Scope)}>
              <option value="selected">Selected episodes ({selected.size})</option>
              <option value="season">{seasonName ?? "This season"} ({eps.length} episodes)</option>
              {show && <option value="show">The whole show ({show.seasonIds.length} seasons)</option>}
            </select>
          </label>
          <div className="seg wide3">
            {(["intro", "recap", "credits"] as Part[]).map((x) => (
              <button key={x} className={part === x ? "on" : ""} disabled={x === "recap" && recapsOff} onClick={() => setPart(x)}>{LABEL[x]}</button>
            ))}
          </div>
          <div className="seg wide3">
            <button className={mode === "fixed" ? "on" : ""} onClick={() => setMode("fixed")}>Fixed time</button>
            <button className={mode === "end" ? "on" : ""} onClick={() => setMode("end")}>From the end</button>
            <button className={mode === "percent" ? "on" : ""} onClick={() => setMode("percent")}>Percent</button>
          </div>
          {mode === "fixed" && (
            <div className="row">
              <label>{LABEL[part]} starts at<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="0:45" /></label>
              <label>and ends at<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder="1:45" /></label>
            </div>
          )}
          {mode === "end" && (
            <label>{LABEL[part]} start{part === "credits" ? "s" : ""} this long before the end<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="3:00" /></label>
          )}
          {mode === "percent" && (
            <div className="row">
              <label>Starts at (%)<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="95" /></label>
              <label>Ends at (%)<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder={part === "credits" ? "100" : ""} /></label>
            </div>
          )}
          <div className="row">
            <button className="grow" disabled={applyTo === "show" && !canEdit} onClick={() => void applyRule()}>Set {LABEL[part].toLowerCase()} times</button>
            <button className="danger-outline" disabled={applyTo === "show" && !canEdit} onClick={() => void clearPart(part)} title={applyTo === "show" ? "Saved straight to Jellyfin; can be undone" : "Clears it in the episodes; review, then save"}>Clear {part === "credits" ? "credits" : LABEL[part].toLowerCase()}</button>
          </div>
          <div className="detect-what">
            <span className="muted small">Auto-detect finds</span>
            <label className="check small"><input type="checkbox" checked={p.detectIntro} onChange={(e) => setPrefs({ detectIntro: e.target.checked })} />Intros</label>
            <label className="check small"><input type="checkbox" checked={p.detectCredits} onChange={(e) => setPrefs({ detectCredits: e.target.checked })} />Credits</label>
          </div>
          <button className="outline" disabled={!!progress || !ov.ffmpeg || (!p.detectIntro && !p.detectCredits) || (applyTo === "selected" && !selected.size)} onClick={() => void detect()}>
            {progress ? "Listening…" : applyTo === "show" ? "Auto-detect the whole show" : applyTo === "selected" ? `Auto-detect ${selected.size} selected` : "Auto-detect this season"}
          </button>
          <p className="muted small">{applyTo === "show" ? "Whole-show changes are saved straight away." : "Right-click an episode, the season or the show for more."}</p>
          {!ov.ffmpeg && <p className="muted small">Auto-detect needs ffmpeg. <SettingsLink section="tools">How to install</SettingsLink></p>}
          <button className="primary" disabled={!changes.length || saving || !canEdit || !ov.canWriteSegments} onClick={() => void saveAll()}>
            {saving ? "Saving…" : `Save ${changes.length || ""} change${changes.length === 1 ? "" : "s"} to Jellyfin`}
          </button>
          {!canEdit && <p className="muted small">Saving needs changes to Jellyfin switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
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
          {changes.length > 0 && <button className="link small" onClick={() => void load()}>Go back to what's in Jellyfin</button>}
          <p className="muted small">Every saved change goes into the undo list, so you can put it back.</p>
        </div>

      </aside>

      <section className="seg-main">
        <div className="section-head" onContextMenu={(e) => openMenu(e, menuFor("season"))}>
          <h2 className="big">{seasonName ?? "Season"} timeline <button className="icon-btn" aria-label="Season actions" onClick={(e) => openMenu(e, menuFor("season"))}><Icon name="more" /></button></h2>
          <div className="legend small muted">
            <span><span className="key intro" />Intro</span>
            <span><span className="key recap" />Recap</span>
            <span><span className="key credits" />Credits</span>
            <span><span className="key wrong" />Looks wrong</span>
            <span title="The dashed outline is what Jellyfin (and Infuse) have right now. Coloured bars are your version; Save sends it."><span className="key saved" />In Jellyfin now</span>
          </div>
        </div>
        {progress && <p className="muted small">{progress}. This reads the start and end of each episode from your NAS.</p>}
        {note && <p className="note">{note}</p>}
        {error && <p className="error">{error}</p>}

        <div className="card timeline-card">
          <div className="seg-draw small muted">
            Drag on a bar to draw, or open an episode and press Preview to set the points while watching:
            <div className="seg">
              {parts.map((p) => (
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
            const d0 = drafts[e.id];
            if (!d0) return null;
            const d = recapsOff ? { ...d0, recap: null } : d0;
            const f = flags.find((x) => x.ep.id === e.id);
            return (
              <div key={e.id}>
                <div className="tl-row" onContextMenu={(ev) => openMenu(ev, selected.size > 1 && selected.has(e.id) ? menuFor("selected") : menuFor("episode", e.id))}>
                  <div className="tl-name">
                    <input type="checkbox" checked={selected.has(e.id)} onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} aria-label="Select episode" />
                    <button className="link-plain" onClick={() => setOpen(open === e.id ? null : e.id)}>
                      <span className="tl-title">{epName(e)}</span>
                      <span className={`small ${f ? "bad" : d.problem ? "warn" : !d.intro && !d.credits ? "muted" : "ok"}`}>{f ? f.title.split(" · ")[1] : d.problem ?? summary(d, parts)}</span>
                    </button>
                  </div>
                  <Bars ep={e} draft={d} maxDur={maxDur} drawing={drawing} wrong={wrong} onDraw={(p, s) => set(e.id, p, s)} />
                </div>
                {open === e.id && (
                  <div className="tl-detail">
                    {parts.map((p) => (
                      <span key={p} className="tl-times">
                        <span className={`key ${p}`} />{LABEL[p]}
                        <TimeInput value={d[p]?.start} onChange={(v) => v === null ? set(e.id, p, null) : set(e.id, p, { start: v, end: Math.max(v + 1, d[p]?.end ?? Math.min(e.duration, v + 60)) })} />
                        –
                        <TimeInput value={d[p]?.end} onChange={(v) => v !== null && v > (d[p]?.start ?? 0) && set(e.id, p, { start: d[p]?.start ?? 0, end: v })} />
                      </span>
                    ))}
                    <span className="muted small">length {fmt(e.duration)}</span>
                    <button className="small-btn show" onClick={() => setPreview(preview === e.id ? null : e.id)}>{preview === e.id ? "Close preview" : "▶ Preview"}</button>
                  </div>
                )}
                {open === e.id && preview === e.id && (
                  <SegPreview ep={e} draft={d} parts={parts} first={drawing} onSet={(p, s2) => set(e.id, p, s2)} />
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

/**
 * Watch an episode inside the intros tool and set the start and end of each part at the
 * current moment (keys: I = start, O = end, J/L = back/forward 5 s, space = play/pause).
 */
function SegPreview({ ep, draft, parts, first, onSet }: { ep: SegEpisode; draft: Draft; parts: Part[]; first?: Part; onSet: (p: Part, s: Span | null) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [part, setPart] = useState<Part>(first ?? "intro");
  useEffect(() => { if (first) setPart(first); }, [first]);
  const [time, setTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let hls: Hls | null = null;
    let token: string | null = null;
    let cancelled = false;
    const startAt = draft.intro?.start ?? 0;
    api.playStart(ep.id, 0).then((p) => {
      token = p.token;
      if (cancelled) { void api.playStop(p.token).catch(() => undefined); return; }
      const v = video.current!;
      if (Hls.isSupported()) {
        hls = new Hls({ enableWorker: true, maxBufferLength: 60, startPosition: Math.max(0, startAt - 5) });
        hls.on(Hls.Events.ERROR, (_e, data) => data.fatal && setError(`Preview stopped (${data.details}).`));
        hls.loadSource(p.url);
        hls.attachMedia(v);
      } else {
        v.src = p.url;
      }
      setReady(true);
    }).catch((e) => setError(errorText(e)));
    return () => {
      cancelled = true;
      hls?.destroy();
      if (token) void api.playStop(token).catch(() => undefined);
    };
  }, [ep.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = () => video.current?.currentTime ?? 0;
  const seek = (t: number) => { if (video.current) video.current.currentTime = Math.max(0, Math.min(ep.duration, t)); };
  const setIn = () => {
    const t = now();
    const cur = draft[part];
    onSet(part, { start: t, end: cur && cur.end > t + 1 ? cur.end : Math.min(ep.duration, t + (part === "credits" ? ep.duration : 60)) });
  };
  const setOut = () => {
    const t = now();
    const cur = draft[part];
    const start = cur && cur.start < t - 1 ? cur.start : Math.max(0, t - 60);
    onSet(part, { start, end: t });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "i") { e.preventDefault(); setIn(); }
      else if (k === "o") { e.preventDefault(); setOut(); }
      else if (k === "j") seek(now() - 5);
      else if (k === "l") seek(now() + 5);
      else if (e.key === " ") { e.preventDefault(); const v = video.current; if (v) { if (v.paused) void v.play(); else v.pause(); } }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cur = draft[part];
  return (
    <div className="seg-preview">
      <div className="seg-video">
        <video ref={video} controls onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
        {!ready && !error && <div className="muted small seg-video-note">Starting…</div>}
        {error && <div className="error small seg-video-note">{error}</div>}
      </div>
      <div className="seg-preview-side">
        <div className="seg wide3">
          {parts.map((p) => <button key={p} className={part === p ? "on" : ""} onClick={() => setPart(p)}>{LABEL[p]}</button>)}
        </div>
        <div className="mono big-text">{fmt(time)}</div>
        <div className="row">
          <button className="primary grow" onClick={setIn}>{LABEL[part]} starts here <span className="kbd">I</span></button>
          <button className="primary grow" onClick={setOut}>{LABEL[part]} ends here <span className="kbd">O</span></button>
        </div>
        <div className="muted small">{LABEL[part]}: {cur ? `${fmt(cur.start)} – ${fmt(cur.end)}` : "not set"}</div>
        <div className="row">
          <button onClick={() => seek(now() - 5)}>−5 s <span className="kbd">J</span></button>
          <button onClick={() => seek(now() + 5)}>+5 s <span className="kbd">L</span></button>
          {cur && <button onClick={() => seek(cur.start - 3)}>Go to start</button>}
          {cur && <button onClick={() => seek(cur.end - 3)}>Go to end</button>}
          {cur && <button className="danger-outline" onClick={() => onSet(part, null)}>Clear</button>}
        </div>
        <p className="muted small">Changes appear in “Changes to review”; press Save to send them to Jellyfin.</p>
      </div>
    </div>
  );
}

/**
 * The intros editor for a whole show: pick a season (right-click a season or the show for
 * quick actions), then edit its timeline. Changes for the whole show are in the top box.
 */
export function ShowIntros({ seriesId, canEdit, onChanged }: { seriesId: string; canEdit: boolean; onChanged?: () => void }) {
  const [name, setName] = useState("");
  const [seasons, setSeasons] = useState<{ id: string; name: string; count: number }[]>([]);
  const [season, setSeason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [command, setCommand] = useState<SetCommand | null>(null);
  const [nonce, setNonce] = useState(0);
  const { detectIntro, detectCredits } = usePrefs();

  useEffect(() => {
    api.details(seriesId).then((d) => {
      setName(d.item.Name);
      const list = d.seasons.filter((x) => x.Id).map((x) => ({ id: x.Id, name: x.Name, count: x.ChildCount ?? 0 }));
      setSeasons(list);
      setSeason((cur) => cur && list.some((x) => x.id === cur) ? cur : (d.seasons.find((x) => (x.IndexNumber ?? 0) > 0) ?? d.seasons[0])?.Id ?? null);
    }).catch((e) => setError(errorText(e)));
  }, [seriesId]);

  const ids = seasons.map((x) => x.id);
  const changed = () => { onChanged?.(); setNonce((n) => n + 1); };
  const label = (k: string) => (k === "Outro" ? "credits" : `${k.toLowerCase()}s`);

  function menu(scope: "season" | "show", sid?: string): MenuItem[] {
    const where = scope === "show" ? ids : sid ? [sid] : [];
    const what = scope === "show" ? `every season of ${name}` : seasons.find((x) => x.id === sid)?.name ?? "this season";
    const set = (part: Part): MenuItem => ({
      label: `Set ${part === "credits" ? "credits" : part}…`,
      run: () => {
        if (sid) setSeason(sid);
        setCommand({ part, scope, n: Date.now() });
      },
    });
    return [
      {
        label: `Analyze ${scope === "show" ? "the whole show" : what}`, disabled: !canEdit || (!detectIntro && !detectCredits),
        run: () => void track(`Finding intros: ${what}`, (job) => detectAndSave(where, job).then(() => undefined), { cancellable: true, reload: false, stop: "detect" }).catch(() => undefined).then(changed),
      },
      { sep: true },
      set("intro"), set("recap"), set("credits"),
      { sep: true },
      ...(["Intro", "Recap", "Outro"] as const).map((k): MenuItem => ({
        label: `Clear ${k === "Outro" ? "credits" : k.toLowerCase()}`, danger: true, disabled: !canEdit,
        run: () => void askConfirm(`Remove all ${label(k)} in ${what}? Each one can be undone.`, { okLabel: `Remove ${label(k)}`, danger: true }).then((ok) => {
          if (ok) void track(`Removing ${label(k)}`, (job) => removeSegments(where, [k], job), { cancellable: true, reload: false }).catch(() => undefined).then(changed);
        }),
      })),
    ];
  }

  if (error) return <p className="error">{error}</p>;
  return (
    <div className="stack show-intros">
      <div className="si-seasons" onContextMenu={(e) => openMenu(e, menu("show"))}>
        {seasons.map((x) => (
          <button key={x.id} className={`chip ${season === x.id ? "on" : ""}`} onClick={() => setSeason(x.id)} onContextMenu={(e) => openMenu(e, menu("season", x.id))}>
            {x.name}{x.count ? <span className="muted"> · {x.count}</span> : null}
          </button>
        ))}
        <button className="icon-btn" title="Actions for the whole show" aria-label="Show actions" onClick={(e) => openMenu(e, menu("show"))}><Icon name="more" /></button>
        {seasons.length === 0 && <span className="muted small">Loading seasons…</span>}
      </div>
      {season && (
        <IntrosTab key={`${season}-${nonce}`} seasonId={season} seasonName={seasons.find((x) => x.id === season)?.name} canEdit={canEdit}
          command={command} show={{ name, seasonIds: ids, onChanged }} />
      )}
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
