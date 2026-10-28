import { clearCache } from "./api";
// What the app is busy with right now (shown in the bar at the top), and a global "reload"
// counter: when a job finishes, every screen that reads data refreshes itself.
import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

/** What a stopped job rejects with. Shown quietly, never as a problem. */
export const STOPPED = "Stopped.";

export function isStopped(e: unknown): boolean {
  return e === STOPPED || (e instanceof Error && e.message === STOPPED);
}

export interface Job {
  id: number;
  label: string;
  detail: string;
  /** 0..1, or null when unknown */
  progress: number | null;
  done: boolean;
  error: string | null;
  cancel?: () => void;
}

let jobs: Job[] = [];
let epoch = 0;
let nextId = 1;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}

export function useJobs(): Job[] {
  return useSyncExternalStore(subscribe, () => jobs);
}

/** Changes after every finished job and on "Reload". Use it as an effect dependency. */
export function useEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch);
}

export function reloadAll(): void {
  clearCache();
  epoch++;
  notify();
}

/* Per-title reloads: a change to one title reloads only the screens showing that title. */
const itemEpochs = new Map<string, number>();
const itemSubs = new Set<(ids: string[]) => void>();
const norm = (id: string) => id.replace(/-/g, "").toLowerCase();

/** Reload only these titles (their pages, and their rows in lists). */
export function reloadItems(ids: (string | null | undefined)[]): void {
  clearCache();
  const list = [...new Set(ids.filter((x): x is string => !!x).map(norm))];
  if (!list.length) return;
  list.forEach((i) => itemEpochs.set(i, (itemEpochs.get(i) ?? 0) + 1));
  notify();
  itemSubs.forEach((f) => f(list));
}

/** Changes when this title changed (after a job about it). */
export function useItemEpoch(id: string): number {
  return useSyncExternalStore(subscribe, () => itemEpochs.get(norm(id)) ?? 0);
}

/** Called with the ids of titles that changed (lists update those rows only). */
export function onItemsChanged(f: (ids: string[]) => void): () => void {
  itemSubs.add(f);
  return () => itemSubs.delete(f);
}

/** Things kept in memory to show pages instantly; "Reload data" empties them. */
const caches = new Set<() => void>();
export function onDataReload(clear: () => void): void {
  caches.add(clear);
}
export function clearDataCaches(): void {
  caches.forEach((f) => { try { f(); } catch { /* ignore */ } });
}

export interface JobHandle {
  update: (detail: string, progress?: number | null) => void;
  readonly cancelled: boolean;
}

/**
 * Runs `work` as a visible job. When it ends, screens reload (unless `reload` is false);
 * with `items`, only the screens and rows of those titles reload.
 * Errors are shown in the bar and re-thrown.
 *
 * Stop: `stop` names the backend job to stop ("health", "sync", "bulk", "detect",
 * "import"); `cancellable` lets `work` check `job.cancelled` between its own steps.
 * Either way the screen stops waiting right away and the job rejects with STOPPED.
 */
export async function track<T>(label: string, work: (job: JobHandle) => Promise<T>, opts: { reload?: boolean; cancellable?: boolean; stop?: string; items?: (string | null | undefined)[] } = {}): Promise<T> {
  const id = nextId++;
  let cancelled = false;
  let abort: (e: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = reject;
  });
  aborted.catch(() => undefined);
  const job: Job = {
    id, label, detail: "", progress: null, done: false, error: null,
    cancel: opts.cancellable || opts.stop
      ? () => {
          cancelled = true;
          if (opts.stop) void invoke("cancel_job", { kind: opts.stop }).catch(() => undefined);
          abort(STOPPED);
        }
      : undefined,
  };
  jobs = [...jobs, job];
  logStart(id, label);
  notify();
  function patch(p: Partial<Job>) {
    jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
    logPatch(id, p);
    notify();
  }
  const handle: JobHandle = {
    update: (detail, progress = null) => {
      if (!cancelled) patch({ detail, progress });
    },
    get cancelled() {
      return cancelled;
    },
  };
  let failed = false;
  try {
    const running = work(handle);
    // After Stop, the work may still fail on its own; that's not worth a problem entry.
    running.catch(() => undefined);
    const out = await Promise.race([running, aborted]);
    patch({ done: true, progress: 1 });
    return out;
  } catch (e) {
    if (isStopped(e) || cancelled) {
      patch({ done: true, detail: "Stopped. What was finished stays done.", progress: null });
      throw STOPPED;
    }
    failed = true;
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "Failed";
    patch({ done: true, error: msg });
    logProblem(label, msg);
    throw e;
  } finally {
    if (opts.items) reloadItems(opts.items);
    else if (opts.reload !== false) reloadAll();
    // Finished jobs stay visible for a moment so you can see they're done.
    window.setTimeout(() => {
      jobs = jobs.filter((j) => j.id !== id);
      notify();
    }, failed ? 9000 : 2500);
  }
}

/* ------------------------------------------------------------ processes */

/** What every job did (newest first), for the processes view behind the top bar. */
export interface JobRecord {
  id: number;
  label: string;
  started: number;
  ended: number | null;
  state: "running" | "done" | "failed" | "stopped";
  detail: string;
  progress: number | null;
  /** The steps it went through (its last 60 messages). */
  steps: { at: number; text: string }[];
  error: string | null;
}
let jobLog: JobRecord[] = [];
const jobLogSubs = new Set<() => void>();
function logStart(id: number, label: string) {
  jobLog = [{ id, label, started: Date.now(), ended: null, state: "running" as const, detail: "", progress: null, steps: [], error: null }, ...jobLog].slice(0, 100);
  jobLogSubs.forEach((f) => f());
}
function logPatch(id: number, p: Partial<Job>) {
  jobLog = jobLog.map((r) => {
    if (r.id !== id) return r;
    const steps = p.detail && p.detail !== r.detail ? [...r.steps, { at: Date.now(), text: p.detail }].slice(-60) : r.steps;
    const state: JobRecord["state"] = p.error ? "failed" : p.done ? (/^Stopped/.test(p.detail ?? "") ? "stopped" : "done") : r.state;
    return { ...r, detail: p.detail ?? r.detail, progress: p.progress ?? r.progress, error: p.error ?? r.error, steps, state, ended: p.done ? Date.now() : r.ended };
  });
  jobLogSubs.forEach((f) => f());
}
export function useJobLog(): JobRecord[] {
  return useSyncExternalStore(
    (f) => {
      jobLogSubs.add(f);
      return () => jobLogSubs.delete(f);
    },
    () => jobLog,
  );
}
/** The Stop button of a running job, if it has one. */
export function stopJob(id: number): void {
  jobs.find((j) => j.id === id)?.cancel?.();
}

export function dismiss(id: number): void {
  jobs = jobs.filter((j) => j.id !== id);
  notify();
}

/* --------------------------------------------------------------- problems */

export interface Problem {
  at: number;
  what: string;
  message: string;
}

const LOG_KEY = "mediahub.problems.v1";
let problems: Problem[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as Problem[];
  } catch {
    return [];
  }
})();
const logSubs = new Set<() => void>();

/** Keeps the last 200 problems (failed jobs, errors) for the log in Settings. */
export function logProblem(what: string, message: string): void {
  problems = [{ at: Date.now(), what, message: message.slice(0, 2000) }, ...problems].slice(0, 200);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(problems));
  } catch {
    /* storage unavailable */
  }
  logSubs.forEach((f) => f());
}

export function clearProblems(): void {
  problems = [];
  try {
    localStorage.removeItem(LOG_KEY);
  } catch {
    /* ignore */
  }
  logSubs.forEach((f) => f());
}

export function useProblems(): Problem[] {
  return useSyncExternalStore(
    (f) => {
      logSubs.add(f);
      return () => logSubs.delete(f);
    },
    () => problems,
  );
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => logProblem("Window", e.message || "Script error"));
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (isStopped(r)) return;
    logProblem("Background task", typeof r === "string" ? r : r instanceof Error ? r.message : "Unknown error");
  });
}

/** Feeds a backend progress event ({progress} or {done,total}, plus {label}) into a job. */
export async function followEvent(job: JobHandle, event: string): Promise<() => void> {
  return listen<{ progress?: number; done?: number; total?: number; label?: string; name?: string; file?: string }>(event, (e) => {
    const p = e.payload;
    const frac = p.progress ?? (p.total ? (p.done ?? 0) / p.total : null);
    job.update(p.label ?? p.name ?? p.file ?? "", frac);
  });
}

/* Live progress of a rename batch, file by file ("rename-step" from the backend). */
export type StepState = "working" | "done" | "failed";
let steps = new Map<string, StepState>();
const stepSubs = new Set<() => void>();
let stepsListening = false;
function listenSteps() {
  if (stepsListening) return;
  stepsListening = true;
  void listen<{ index: number; from: string; state: StepState }>("rename-step", (e) => {
    if (e.payload.index === 0 && e.payload.state === "working") steps = new Map();
    steps = new Map(steps).set(e.payload.from, e.payload.state);
    stepSubs.forEach((f) => f());
  }).catch(() => { stepsListening = false; });
}

/** From-path → how its rename went, for the batch running now (or the last one). */
export function useRenameSteps(): Map<string, StepState> {
  listenSteps();
  return useSyncExternalStore(
    (f) => {
      stepSubs.add(f);
      return () => stepSubs.delete(f);
    },
    () => steps,
  );
}
