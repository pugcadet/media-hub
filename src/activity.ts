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
  epoch++;
  notify();
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
 * Runs `work` as a visible job. When it ends, screens reload (unless `reload` is false).
 * Errors are shown in the bar and re-thrown.
 *
 * Stop: `stop` names the backend job to stop ("health", "sync", "bulk", "detect",
 * "import"); `cancellable` lets `work` check `job.cancelled` between its own steps.
 * Either way the screen stops waiting right away and the job rejects with STOPPED.
 */
export async function track<T>(label: string, work: (job: JobHandle) => Promise<T>, opts: { reload?: boolean; cancellable?: boolean; stop?: string } = {}): Promise<T> {
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
  notify();
  function patch(p: Partial<Job>) {
    jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
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
    if (opts.reload !== false) reloadAll();
    // Finished jobs stay visible for a moment so you can see they're done.
    window.setTimeout(() => {
      jobs = jobs.filter((j) => j.id !== id);
      notify();
    }, failed ? 9000 : 2500);
  }
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
