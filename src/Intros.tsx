import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, openMenu, SettingsLink, type MenuItem } from "./ui";
import { listen } from "@tauri-apps/api/event";
import Hls from "hls.js";
import { api, errorText, SegEpisode, SegOverview, Span } from "./api";
import { track, type JobHandle } from "./activity";
import { askConfirm } from "./confirm";
import { prefs, setPrefs, usePrefs } from "./prefs";


/* ------------------------------------------------------------ saving with a progress list */

/** One line of the Progress list: what happened to one episode. */
export interface SaveLine { ep: string; mark: "ok" | "warn" | "bad" | "busy"; text: string }
export interface SaveItem { id: string; label: string; intro: Span | null; credits: Span | null; recap: Span | null; clear: string[] }
export interface SaveResult { ok: number; hidden: number; failed: number; stopped: boolean }

const busyErr = (t: string) => /busy|500|timed? ?out|network|connection/i.test(t);
const fatalErr = (t: string) => /install|plugin|switched off|read-only|Unauthorized|key/i.test(t);
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Saves episodes one by one the Segment Editor's way. Every episode is read back from Jellyfin;
 * a busy server gets one more try. Nothing is hidden: each episode gets a line.
 */
export async function saveMany(items: SaveItem[], opts: { job?: JobHandle; onLine?: (l: SaveLine, done: number, total: number) => void } = {}): Promise<SaveResult> {
  const res: SaveResult = { ok: 0, hidden: 0, failed: 0, stopped: false };
  const started = Date.now();
  const total = items.length;
  for (const [i, it] of items.entries()) {
    if (opts.job?.cancelled) { res.stopped = true; break; }
    void started;
    opts.job?.update(`Saving to Jellyfin: ${i} of ${total} episodes done`, total ? i / total : null);
    opts.onLine?.({ ep: it.label, mark: "busy", text: "Saving now…" }, i, total);
    let line: SaveLine;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await api.saveSegments(it.id, it.intro, it.credits, it.recap, it.clear);
        if (r.confirmed) { res.ok++; line = { ep: it.label, mark: "ok", text: r.message === "Nothing to change" ? "Already right, nothing to change" : "Saved and confirmed" }; }
        else { res.hidden++; line = { ep: it.label, mark: "warn", text: r.message }; }
        break;
      } catch (e) {
        const t = errorText(e);
        if (attempt === 0 && busyErr(t)) {
          opts.onLine?.({ ep: it.label, mark: "warn", text: "Jellyfin was busy, trying again" }, i, total);
          await sleep(1500);
          continue;
        }
        res.failed++;
        line = { ep: it.label, mark: "bad", text: t };
        if (fatalErr(t)) res.stopped = true;
        break;
      }
    }
    opts.onLine?.(line, i + 1, total);
    if (res.stopped) break;
  }
  const parts = [`${res.ok} saved and confirmed`];
  if (res.hidden) parts.push(`${res.hidden} saved but not shown to players`);
  if (res.failed) parts.push(`${res.failed} failed`);
  opts.job?.update(parts.join(", "), 1);
  return res;
}

const epLabel = (e: { index: number | null; name: string }) => (e.index != null ? `E${String(e.index).padStart(2, "0")}` : e.name.slice(0, 12));

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
    try {
      const { detectIntro, detectCredits } = prefs();
      const res = await api.detectSeason(seasonId, 6 * 60, 5 * 60, detectIntro, detectCredits);
      const names = new Map(ov.episodes.map((e) => [e.id, epLabel(e)]));
      const items = res.filter((r) => !r.problem && (r.intro || r.credits)).map((r) => ({ id: r.id, label: names.get(r.id) ?? "", intro: r.intro, credits: r.credits, recap: null, clear: [] }));
      if (!items.length) job.update("Nothing sure enough to save", 1);
      else await saveMany(items, { job });
    } finally {
      un();
    }
  }, { reload: false, stop: "detect" }).catch(() => undefined);
}

/** Finds markers in the given seasons and saves the sure ones (no problem reported). */
export async function detectAndSave(seasonIds: string[], job?: JobHandle, only?: Set<string>, onLine?: (l: SaveLine, done: number, total: number) => void, keep?: boolean): Promise<number> {
  const { detectIntro, detectCredits } = prefs();
  let saved = 0;
  const listenNow = () => (job ? listen<{ done: number; total: number; label: string }>("detect-progress", (e) => job.update(`Listening: ${e.payload.label}`, e.payload.total ? e.payload.done / e.payload.total : null)) : Promise.resolve(() => undefined));
  for (const sid of seasonIds) {
    if (job?.cancelled) break;
    const ov = await api.segmentsOverview(sid);
    const names = new Map(ov.episodes.map((e) => [e.id, epLabel(e)]));
    const had = new Set(ov.episodes.filter((e) => e.segments.some((x) => x.kind === "Intro" || x.kind === "Outro")).map((e) => e.id));
    const un = await listenNow();
    let res;
    try {
      res = await api.detectSeason(sid, 6 * 60, 5 * 60, detectIntro, detectCredits, only ? ov.episodes.filter((e) => only.has(e.id)).map((e) => e.id) : null);
    } finally {
      un();
    }
    const items: SaveItem[] = [];
    for (const r of res) {
      if (only && !only.has(r.id)) continue;
      if (keep && had.has(r.id)) { onLine?.({ ep: names.get(r.id) ?? "", mark: "ok", text: "Had markers already, kept" }, 0, 0); continue; }
      if (r.problem || (!r.intro && !r.credits)) { onLine?.({ ep: names.get(r.id) ?? "", mark: "warn", text: r.problem ?? "Nothing found for sure; set it by hand" }, 0, 0); continue; }
      items.push({ id: r.id, label: names.get(r.id) ?? "", intro: r.intro, credits: r.credits, recap: null, clear: [] });
    }
    const out = await saveMany(items, { job, onLine });
    saved += out.ok;
    if (out.stopped) break;
  }
  return saved;
}

/** Removes every marker of `kinds` ("Intro" | "Outro" | "Recap") in the given seasons. */
export async function removeSegments(seasonIds: string[], kinds: string[], job?: JobHandle): Promise<number> {
  let n = 0;
  for (const sid of seasonIds) {
    if (job?.cancelled) break;
    const ov = await api.segmentsOverview(sid);
    const eps = ov.episodes.filter((e) => e.segments.some((x) => kinds.includes(x.kind)));
    const out = await saveMany(eps.map((e) => ({ id: e.id, label: epLabel(e), intro: null, credits: null, recap: null, clear: kinds })), { job });
    n += out.ok;
    if (out.stopped) break;
  }
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
  const [ignored] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The Progress list: one line per episode, newest at the bottom.
  const [lines, setLines] = useState<SaveLine[]>([]);
  const [status, setStatus] = useState<{ text: string; pct: number | null; done: boolean } | null>(null);
  const [keep, setKeep] = useState(true);
  const [view, setView] = useState<"all" | "look" | "nointro" | "changed">("all");
  const [setOpenPanel, setSetOpenPanel] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const stopRef = useRef<{ cancelled: boolean }>({ cancelled: false });
  const onLine = (l: SaveLine, done: number, total: number) => {
    setLines((old) => {
      const i = old.findIndex((x) => x.ep === l.ep && x.mark === "busy");
      const next = i >= 0 ? [...old.slice(0, i), l, ...old.slice(i + 1)] : [...old, l];
      return next.slice(-200);
    });
    if (total) setStatus({ text: `Saving to Jellyfin: ${done} of ${total} episodes done`, pct: done / total, done: false });
  };
  /** Runs a save with the Progress list and the activity list both showing it. */
  async function withProgress(label: string, work: (job: JobHandle) => Promise<SaveResult | number>) {
    setLines([]);
    stopRef.current = { cancelled: false };
    setStatus({ text: "Starting…", pct: null, done: false });
    try {
      const r = await track(label, async (job) => {
        const both: JobHandle = { update: (d, pr) => { job.update(d, pr); setStatus({ text: d, pct: pr ?? null, done: false }); }, get cancelled() { return job.cancelled || stopRef.current.cancelled; } };
        return work(both);
      }, { cancellable: true, reload: false, stop: "detect" });
      const sum = typeof r === "number" ? `${r} saved and confirmed` : [`${r.ok} saved and confirmed`, r.hidden ? `${r.hidden} not shown to players` : "", r.failed ? `${r.failed} failed` : "", r.stopped ? "stopped" : ""].filter(Boolean).join(" · ");
      setStatus({ text: `Done: ${sum}`, pct: 1, done: true });
    } catch (e) {
      setStatus({ text: errorText(e), pct: null, done: true });
    }
  }
  // whole-season tool
  const [part, setPart] = useState<Part>("credits");
  const [mode, setMode] = useState<"fixed" | "end" | "percent">("end");
  const [v1, setV1] = useState("3:00");
  const [v2, setV2] = useState("");
  // Sensible starting values: an intro from 0:00, credits from a few minutes before the end to the end.
  useEffect(() => {
    if (part === "credits") { setMode("end"); setV1("3:00"); setV2(""); }
    else { setMode("fixed"); setV1("0:00"); setV2(""); }
  }, [part]);
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

  // An episode without a known length gets the season's usual length (a bad marker from Intro
  // Skipper can run far past the end, so its last marker isn't used).
  const known = (ov?.episodes ?? []).map((e) => e.duration).filter((d) => d > 0);
  const usual = median(known) ?? Math.max(60, ...(ov?.episodes ?? []).flatMap((e) => e.segments.map((x) => x.end)));
  const eps = (ov?.episodes ?? []).map((e) => (e.duration > 0 ? e : { ...e, duration: usual }));
  // The scale fits normal episodes; one with a length far off (a wrong length in Jellyfin) is
  // cut off at the edge instead of squeezing all the others.
  const maxDur = Math.max(60, ...eps.map((e) => e.duration).filter((d) => d <= usual * 1.6), Math.min(usual * 1.6, Math.max(...eps.map((e) => e.duration), 60)));
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
          return await api.detectSeason(seasonId, 6 * 60, 5 * 60, detectIntro, detectCredits, scope === "season" ? null : [...only]);
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
    // Empty start: the intro starts at 0:00. Empty end: credits run to the end of the episode.
    const a = v1.trim() ? parseTime(v1) : mode === "fixed" && pt !== "credits" ? 0 : null;
    const b = v2.trim() ? parseTime(v2) : null;
    if (a === null) return "bad";
    let span: Span;
    if (mode === "fixed") span = { start: a, end: b ?? (pt === "credits" ? dur : Math.min(dur, a + 60)) };
    else if (mode === "end") span = pt === "credits" ? { start: Math.max(0, dur - a), end: dur } : { start: Math.max(0, dur - a), end: Math.max(0, dur - (b ?? 0)) };
    else span = { start: (dur * a) / 100, end: b != null ? (dur * b) / 100 : pt === "credits" ? dur : (dur * a) / 100 + 60 };
    return span.end > span.start ? span : null;
  }

  async function applyRule(scope: Scope = applyTo) {
    if (ruleSpan(3600, part) === "bad") return setError("Type a time like 3:00 or 1:30.");
    setError(null);
    if (scope === "show" && show) {
      if (!(await askConfirm(`Set the ${LABEL[part].toLowerCase()} in every season of ${show.name}${keep ? " (episodes that already have one keep theirs)" : ""}? Saved straight to Jellyfin; each one can be undone.`, { okLabel: "Set them" }))) return;
      await withProgress(`${LABEL[part]} for ${show.name}`, async (job) => {
        const items: SaveItem[] = [];
        for (const sid of show.seasonIds) {
          const o = await api.segmentsOverview(sid);
          for (const e of o.episodes) {
            const lab = `${o.episodes.length && show.seasonIds.length > 1 ? `S${String(show.seasonIds.indexOf(sid) + 1).padStart(2, "0")}` : ""}${epLabel(e)}`;
            if (keep && saved(e, part)) { onLine({ ep: lab, mark: "ok", text: "Had one already, kept" }, 0, 0); continue; }
            const sp = ruleSpan(e.duration, part);
            if (!sp || sp === "bad" || e.duration <= 0) { onLine({ ep: lab, mark: "warn", text: "Length unknown, skipped" }, 0, 0); continue; }
            items.push({ id: e.id, label: lab, intro: part === "intro" ? sp : null, credits: part === "credits" ? sp : null, recap: part === "recap" ? sp : null, clear: [] });
          }
        }
        return saveMany(items, { job, onLine });
      });
      show.onChanged?.();
      return load();
    }
    const list = targetsOf(scope);
    if (!list.length) return setError("Select one or more episodes first.");
    setDrafts((d) => {
      const next = { ...d };
      for (const e of list) {
        if (keep && saved(e, part)) continue;
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
      await withProgress(`Removing ${label}`, (job) => removeSegments(show.seasonIds, [KIND[pt]], job));
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
    if (!(await askConfirm(`Listen to every episode of ${show.name} and save the intros and credits that are found for sure${keep ? " (episodes with markers keep theirs)" : ""}? Each one can be undone.`, { okLabel: "Find them" }))) return;
    await withProgress(`Finding intros: ${show.name}`, (job) => detectAndSave(show.seasonIds, job, undefined, onLine, keep));
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
    eps.forEach((e) => {
      const d = drafts[e.id];
      if (!d) return;
      // Where an intro starts differs (a cold open before it is normal); its length hardly does.
      if (d.intro && introStart !== null && introLen !== null) {
        const len = d.intro.end - d.intro.start;
        const late = d.intro.start > Math.min(900, e.duration * 0.5);
        const off = withIntro.length >= 3 && Math.abs(len - introLen) > 25;
        if (late || off) {
          const from = late ? introStart : d.intro.start;
          out.push({
            id: `intro-${e.id}`, ep: e, title: `${epName(e)} · Intro ${fmt(d.intro.start)}–${fmt(d.intro.end)}`,
            why: late ? `It starts very late; the others start around ${fmt(introStart)}.` : `It's ${fmt(len)} long; the others are about ${fmt(introLen)}.`,
            actions: [
              { label: "Fix to median", run: () => set(e.id, "intro", { start: from, end: Math.min(e.duration || from + introLen, from + introLen) }) },
              { label: "Remove", danger: true, run: () => set(e.id, "intro", null) },
            ],
          });
        }
      }
      // No intro is fine: some episodes don't have one.
      if (d.credits && fromEnd !== null && Math.abs(e.duration - d.credits.start - fromEnd) > 90) {
        out.push({
          id: `credits-${e.id}`, ep: e, title: `${epName(e)} · Credits start at ${fmt(d.credits.start)}`,
          why: `Starts ${fmt(e.duration - d.credits.start)} before the end; usually ${fmt(fromEnd)}.`,
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
    const byEp = new Map<string, SegEpisode>();
    changes.forEach((c) => byEp.set(c.ep.id, c.ep));
    const items: SaveItem[] = [...byEp.values()].map((e) => {
      const d = drafts[e.id];
      const pick = (p: Part) => (same(d[p], saved(e, p)) ? null : d[p]);
      const clear = (["intro", "recap", "credits"] as Part[]).filter((p) => !d[p] && saved(e, p)).map((p) => KIND[p]);
      return { id: e.id, label: epLabel(e), intro: pick("intro"), credits: pick("credits"), recap: pick("recap"), clear };
    });
    await withProgress(`Saving ${items.length} episode${items.length === 1 ? "" : "s"}`, (job) => saveMany(items, { job, onLine }));
    setSaving(false);
    await load();
  }

  if (error && !ov) return <p className="error">{error}</p>;
  if (!ov) return <p className="muted">Loading episodes…</p>;
  const ticks: number[] = [];
  const step = maxDur > 3600 ? 1200 : maxDur > 1200 ? 600 : 300;
  for (let t = 0; t <= maxDur; t += step) ticks.push(t);

  const fixable = flags.filter((f) => f.actions.some((a) => a.label === "Fix to median"));
  const flagged = new Set(flags.map((f) => f.ep.id));
  const changedIds = new Set(changes.map((c) => c.ep.id));
  const shownEps = eps.filter((e) => view === "all" || (view === "look" ? flagged.has(e.id) : view === "nointro" ? !drafts[e.id]?.intro : changedIds.has(e.id)));
  const withIntroN = eps.filter((e) => drafts[e.id]?.intro).length;
  const withCreditsN = eps.filter((e) => drafts[e.id]?.credits).length;
  const span = (x: Span | null | undefined) => (x ? `${fmt(x.start)}–${fmt(x.end)}` : null);
  const scopeLabel = applyTo === "show" ? "whole show" : applyTo === "selected" ? `${selected.size} selected` : "season";

  return (
    <div className="sx">
      <div className="sx-head">
        <div className="sx-head-l">
          <h2 className="sx-title" onContextMenu={(e) => openMenu(e, menuFor("season"))}>
            {seasonName ?? "Season"} · Intros and credits
            <button className="icon-btn" aria-label="Season actions" onClick={(e) => openMenu(e, menuFor("season"))}><Icon name="more" /></button>
          </h2>
          <div className="sx-chips">
            <span className="sx-chip"><span className="key intro" />Intro on {withIntroN} of {eps.length}</span>
            <span className="sx-chip"><span className="key credits" />Credits on {withCreditsN} of {eps.length}</span>
            {flags.length > 0 && <span className="sx-chip warn"><span className="sx-dot" />{flags.length} need{flags.length === 1 ? "s" : ""} a look</span>}
          </div>
        </div>
        <div className="sx-head-r">
          <button disabled={!!progress || !ov.ffmpeg || (!p.detectIntro && !p.detectCredits) || (applyTo === "selected" && !selected.size)} onClick={() => void detect()} title={!ov.ffmpeg ? "Needs ffmpeg (Settings → Tools)" : undefined}>
            <Icon name="search" /> {progress ? "Listening…" : applyTo === "show" ? "Analyze the whole show" : applyTo === "selected" ? `Analyze ${selected.size} selected` : "Analyze season"}
          </button>
          <button className={setOpenPanel ? "on" : ""} onClick={() => setSetOpenPanel((x) => !x)}>Set times for {scopeLabel}…</button>
        </div>
      </div>

      {setOpenPanel && (
        <div className="card form sx-set">
          <div className="sx-set-grid">
            <div className="sx-field">
              <span className="muted small">For</span>
              <div className="seg">
                <button className={applyTo === "selected" ? "on" : ""} onClick={() => setApplyTo("selected")} title="The episodes you ticked in the list">{selected.size ? `${selected.size} ticked` : "Ticked episodes"}</button>
                <button className={applyTo === "season" ? "on" : ""} onClick={() => setApplyTo("season")}>{seasonName ?? "Season"}</button>
                {show && <button className={applyTo === "show" ? "on" : ""} onClick={() => setApplyTo("show")}>Whole show</button>}
              </div>
            </div>
            <div className="sx-field">
              <span className="muted small">Part</span>
              <div className="seg">
                {(["intro", "recap", "credits"] as Part[]).map((x) => (
                  <button key={x} className={part === x ? "on" : ""} disabled={x === "recap" && recapsOff} onClick={() => setPart(x)}>{LABEL[x]}</button>
                ))}
              </div>
            </div>
            <div className="sx-field">
              <span className="muted small">How</span>
              <div className="seg">
                <button className={mode === "fixed" ? "on" : ""} onClick={() => setMode("fixed")}>Fixed time</button>
                <button className={mode === "end" ? "on" : ""} onClick={() => setMode("end")}>From the end</button>
                <button className={mode === "percent" ? "on" : ""} onClick={() => setMode("percent")}>Percent</button>
              </div>
            </div>
          </div>
          <div className="sx-set-grid">
            {mode === "fixed" && <>
              <label>{LABEL[part]} starts at<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="0:45" /></label>
              <label>and ends at<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder={part === "credits" ? "end of the episode" : "1:45"} /></label>
            </>}
            {mode === "end" && <label>{LABEL[part]} start{part === "credits" ? "s" : ""} this long before the end<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="3:00" /></label>}
            {mode === "percent" && <>
              <label>Starts at (%)<input ref={firstInput} className="mono" value={v1} onChange={(e) => setV1(e.target.value)} placeholder="95" /></label>
              <label>Ends at (%)<input className="mono" value={v2} onChange={(e) => setV2(e.target.value)} placeholder={part === "credits" ? "100" : ""} /></label>
            </>}
          </div>
          {applyTo === "selected" && !selected.size && <span className="muted small">Tick episodes in the list below first.</span>}
          <div className="row wrap">
            <button className="primary" disabled={applyTo === "show" && !canEdit} onClick={() => void applyRule()}>Set {LABEL[part].toLowerCase()} times</button>
            <button className="danger-outline" disabled={applyTo === "show" && !canEdit} onClick={() => void clearPart(part)} title={applyTo === "show" ? "Saved straight to Jellyfin; can be undone" : "Clears it in the episodes; review, then save"}>Clear {part === "credits" ? "credits" : LABEL[part].toLowerCase()}</button>
            <span className="spacer" />
            <span className="muted small">Analyze finds</span>
            <label className="check small"><input type="checkbox" checked={p.detectIntro} onChange={(e) => setPrefs({ detectIntro: e.target.checked })} />Intros</label>
            <label className="check small"><input type="checkbox" checked={p.detectCredits} onChange={(e) => setPrefs({ detectCredits: e.target.checked })} />Credits</label>
            <label className="check small"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep existing markers</label>
          </div>
          {applyTo === "show" && <p className="muted small">Whole-show changes are saved straight away.</p>}
          {!ov.ffmpeg && <p className="muted small">Analyze needs ffmpeg. <SettingsLink section="tools">How to install</SettingsLink></p>}
        </div>
      )}

      {progress && <p className="muted small">{progress}. This reads the start and end of each episode from your NAS.</p>}
      {note && <p className="note">{note}</p>}
      {error && <p className="error">{error}</p>}

      {flags.length > 0 && (
        <div className="sx-banner">
          <span className="sx-banner-i">!</span>
          <div className="sx-banner-t">
            <strong>{flags.length === 1 ? "1 episode looks" : `${flags.length} episodes look`} different from the rest of the season</strong>
            <span className="small">{flags.slice(0, 3).map((f) => f.title).join(" · ")}{flags.length > 3 ? " …" : ""}</span>
          </div>
          <button className="ghost" onClick={() => setView(view === "look" ? "all" : "look")}>{view === "look" ? "Show all" : "Show only these"}</button>
          {canEdit && fixable.length > 0 && <button className="warn-btn" onClick={() => fixable.forEach((f) => f.actions.find((a) => a.label === "Fix to median")?.run())}>{fixable.length === 1 ? "Fix to median" : `Fix all ${fixable.length} to median`}</button>}
        </div>
      )}

      <div className="sx-bar">
        <div className="seg">
          <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>All {eps.length}</button>
          <button className={view === "look" ? "on" : ""} onClick={() => setView("look")}>Need a look {flags.length}</button>
          <button className={view === "nointro" ? "on" : ""} onClick={() => setView("nointro")}>No intro {eps.length - withIntroN}</button>
          <button className={view === "changed" ? "on" : ""} onClick={() => setView("changed")}>Changed {changedIds.size}</button>
        </div>
        <div className="sx-legend small muted">
          <span>Drag on a bar to draw</span>
          <div className="seg small">
            {parts.map((x) => <button key={x} className={drawing === x ? "on" : ""} onClick={() => setDrawing(x)}><span className={`key ${x}`} />{LABEL[x]}</button>)}
          </div>
          <span title="The dashed outline is what Jellyfin (and Infuse) have right now. Filled bars are your version; Save sends it."><span className="key saved" />In Jellyfin now</span>
        </div>
      </div>

      <div className="card sx-table">
        <div className="sx-row sx-th">
          <span />
          <span>Episode</span>
          <span>Intro</span>
          <span>Credits</span>
          <div className="tl-track ticks">{ticks.map((t) => <span key={t} style={{ left: `${(t / maxDur) * 100}%` }}>{fmt(t)}</span>)}</div>
          <span />
        </div>
        {shownEps.length === 0 && <p className="muted small sx-empty">Nothing here.</p>}
        {shownEps.map((e) => {
          const d0 = drafts[e.id];
          if (!d0) return null;
          const d = recapsOff ? { ...d0, recap: null } : d0;
          const mine = flags.filter((x) => x.ep.id === e.id);
          const isOpen = open === e.id;
          return (
            <div key={e.id} className={`sx-ep ${mine.length ? "sx-flagged" : ""} ${isOpen ? "sx-opened" : ""}`} onContextMenu={(ev) => openMenu(ev, selected.size > 1 && selected.has(e.id) ? menuFor("selected") : menuFor("episode", e.id))}>
              <div className="sx-row">
                <label className="sx-check"><input type="checkbox" checked={selected.has(e.id)} onChange={() => setSelected((s0) => { const n = new Set(s0); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} aria-label={`Select ${epName(e)}`} /></label>
                <button className="sx-name link-plain" onClick={() => { setOpen(isOpen ? null : e.id); setPreview(isOpen ? null : e.id); }} title="Open: times and preview">
                  <span className="sx-ep-t ellipsis"><span className="muted">{e.index != null ? `E${e.index}` : ""}</span> {e.name}</span>
                  {mine.length > 0 && <span className="small warn-t ellipsis">{mine.map((f) => f.why).join(" ")}</span>}
                  {!mine.length && d.problem && <span className="small warn-t ellipsis">{d.problem}</span>}
                </button>
                <span className={`mono small ${d.intro ? (wrong(e.id, "intro") ? "warn-t" : "intro-t") : "muted"}`}>{span(d.intro) ?? "No intro"}</span>
                <span className={`mono small ${d.credits ? (wrong(e.id, "credits") ? "warn-t" : "credits-t") : "muted"}`}>{span(d.credits) ?? "–"}</span>
                <Bars ep={e} draft={d} maxDur={maxDur} drawing={drawing} wrong={wrong} onDraw={(x, s2) => set(e.id, x, s2)} />
                <button className="icon-btn" aria-label={`More for ${epName(e)}`} onClick={(ev) => openMenu(ev, menuFor("episode", e.id))}><Icon name="more" /></button>
              </div>
              {mine.length > 0 && canEdit && (
                <div className="sx-fixes">
                  {mine.flatMap((f) => f.actions.map((a) => <button key={f.id + a.label} className={`small-btn show ${a.danger ? "danger-outline" : ""}`} onClick={a.run}>{a.label}{mine.length > 1 ? ` (${f.id.split("-")[0]})` : ""}</button>))}
                </div>
              )}
              {isOpen && (
                <div className="sx-detail">
                  <div className="sx-times">
                    {parts.map((x) => (
                      <span key={x} className="tl-times">
                        <span className={`key ${x}`} />{LABEL[x]}
                        <TimeInput value={d[x]?.start} onChange={(v) => v === null ? set(e.id, x, null) : set(e.id, x, { start: v, end: Math.max(v + 1, d[x]?.end ?? Math.min(e.duration, v + 60)) })} />
                        –
                        <TimeInput value={d[x]?.end} onChange={(v) => v !== null && v > (d[x]?.start ?? 0) && set(e.id, x, { start: d[x]?.start ?? 0, end: v })} />
                      </span>
                    ))}
                    <span className="muted small">Episode length {fmt(e.duration)}</span>
                  </div>
                  {preview === e.id && <SegPreview ep={e} draft={d} parts={parts} first={drawing} onSet={(x, s2) => set(e.id, x, s2)} />}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {(changes.length > 0 || status) && (
        <div className="sx-save" aria-live="polite">
          {status && showLines && (
            <div className="sx-lines">
              {lines.slice(-60).map((l, i) => (
                <div key={i} className={`seg-line ${l.mark}`}><span className="seg-line-m">{l.mark === "ok" ? "✓" : l.mark === "warn" ? "!" : l.mark === "bad" ? "✗" : "…"}</span><span className="mono seg-line-ep">{l.ep}</span><span className="grow">{l.text}</span></div>
              ))}
              <span className="muted small">“Saved and confirmed” means Media Hub read it back from Jellyfin, so Infuse and Jellyfin show the Skip button.</span>
            </div>
          )}
          <div className="sx-save-row">
            {status ? (
              <div className="sx-save-l">
                <div className="seg-progress-bar sx-prog"><span style={{ width: `${Math.round((status.pct ?? 0) * 100)}%` }} className={status.pct == null && !status.done ? "busy" : ""} /></div>
                <span className="small">{status.text}</span>
                <button className="link small" onClick={() => setShowLines((x) => !x)}>{showLines ? "Hide details" : "Details"}</button>
              </div>
            ) : (
              <div className="sx-save-l">
                <span className="sx-count">{changes.length}</span>
                <div className="sx-save-t">
                  <strong>{changes.length} change{changes.length === 1 ? "" : "s"} ready to save</strong>
                  <span className="small muted ellipsis">{changes.slice(0, 4).map((c) => `${c.ep.index != null ? `E${c.ep.index}` : c.ep.name} ${LABEL[c.part].toLowerCase()} ${c.to ? `${fmt(c.to.start)}–${fmt(c.to.end)}` : "removed"}`).join(" · ")}{changes.length > 4 ? " …" : ""}</span>
                </div>
              </div>
            )}
            <div className="row">
              {status && !status.done && <button onClick={() => (stopRef.current.cancelled = true)}>Stop</button>}
              {status?.done && <button className="ghost" onClick={() => { setStatus(null); setLines([]); setShowLines(false); }}>Close</button>}
              {changes.length > 0 && !saving && <button className="ghost" onClick={() => void load()} title="Go back to what's in Jellyfin">Undo all</button>}
              {changes.length > 0 && (
                <button className="primary" disabled={saving || !canEdit || !ov.canWriteSegments} onClick={() => void saveAll()} title={!canEdit ? "Saving needs changes to Jellyfin switched on (Settings)" : !ov.canWriteSegments ? "Install the Intro Skipper plugin in Jellyfin first" : undefined}>
                  {saving ? "Saving…" : "Save to Jellyfin"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
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

  // Fast path: a window of the episode read straight from the NAS (start, or the end for
  // credits). If that can't be done (other video formats), Jellyfin's stream is used.
  // Only the part around the marker is copied from the NAS (a minute or three, not 8), so it
  // starts quickly; seeking elsewhere fetches that piece. Whole seconds, so a piece made before is reused.
  const winFor = (p: Part): [number, number] => {
    const d = ep.duration || 480;
    const sp = draft[p];
    if (sp && sp.end > sp.start && sp.end <= d + 1 && sp.end - sp.start < d * 0.5) {
      const b0 = Math.max(0, Math.floor(sp.start - 20));
      return [b0, Math.max(60, Math.min(300, Math.ceil(sp.end + 25 - b0)))];
    }
    return p === "credits" ? [Math.max(0, Math.floor(d - 240)), Math.min(Math.ceil(d), 240)] : [0, Math.min(Math.ceil(d), 240)];
  };
  const [win, setWin] = useState<{ base: number; len: number; url: string } | null>(null);
  const [useHls, setUseHls] = useState(false);
  const base = useHls ? 0 : win?.base ?? 0;
  useEffect(() => {
    if (useHls) return;
    const [b0, len] = winFor(part);
    if (win && win.base === b0) return;
    let alive = true;
    setReady(false);
    api.previewWindow(ep.id, b0, len)
      .then((url) => {
        if (!alive) return;
        setWin({ base: b0, len, url });
        const v = video.current;
        if (v) {
          const target = (draft[part]?.start ?? b0) - b0 - 3;
          v.src = url;
          v.currentTime = Math.max(0, target);
        }
        setReady(true);
      })
      .catch(() => alive && setUseHls(true));
    return () => { alive = false; };
  }, [ep.id, part, useHls]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!useHls) return;
    let hls: Hls | null = null;
    let token: string | null = null;
    let cancelled = false;
    const startAt = draft.intro?.start ?? 0;
    setReady(false);
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
  }, [ep.id, useHls]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = () => base + (video.current?.currentTime ?? 0);
  const seek = (t: number) => {
    const v = video.current;
    if (!v) return;
    const want = Math.max(0, Math.min(ep.duration, t));
    if (!useHls && win && (want < win.base || want > win.base + win.len)) {
      // Outside the piece that's loaded: fetch the piece around it.
      const b0 = Math.max(0, Math.floor(want - 30));
      void api.previewWindow(ep.id, b0, 150).then((url) => { setWin({ base: b0, len: 150, url }); v.src = url; v.currentTime = want - b0; }).catch(() => setUseHls(true));
      return;
    }
    v.currentTime = want - base;
  };
  const setIn = () => {
    const t = now();
    const cur = draft[part];
    onSet(part, { start: t, end: cur && cur.end > t + 1 ? cur.end : Math.min(ep.duration, t + (part === "credits" ? ep.duration : 60)) });
  };
  const setOut = () => {
    const t = now();
    const cur = draft[part];
    // Without a start yet: an intro (or recap) starts at 0:00.
    const start = cur && cur.start < t - 1 ? cur.start : part === "credits" ? Math.max(0, t - 60) : 0;
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
        <video ref={video} controls onTimeUpdate={(e) => setTime(base + e.currentTarget.currentTime)} onError={() => { if (!useHls && win) setUseHls(true); }} />
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
        <p className="muted small">Changes wait in the bar at the bottom until you press Save to Jellyfin.</p>
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
        <button onClick={() => void load()}><Icon name="reload" /> Refresh</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
