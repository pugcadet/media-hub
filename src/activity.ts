// What the app is busy with right now (shown in the bar at the top), and a global "reload"
// counter: when a job finishes, every screen that reads data refreshes itself.
import { useSyncExternalStore } from "react";

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

export interface JobHandle {
  update: (detail: string, progress?: number | null) => void;
  readonly cancelled: boolean;
}

/**
 * Runs `work` as a visible job. When it ends, screens reload (unless `reload` is false).
 * Errors are shown in the bar and re-thrown.
 */
export async function track<T>(label: string, work: (job: JobHandle) => Promise<T>, opts: { reload?: boolean; cancellable?: boolean } = {}): Promise<T> {
  const id = nextId++;
  let cancelled = false;
  const job: Job = {
    id, label, detail: "", progress: null, done: false, error: null,
    cancel: opts.cancellable ? () => { cancelled = true; patch({ detail: "Stopping…" }); } : undefined,
  };
  jobs = [...jobs, job];
  notify();
  function patch(p: Partial<Job>) {
    jobs = jobs.map((j) => (j.id === id ? { ...j, ...p } : j));
    notify();
  }
  const handle: JobHandle = {
    update: (detail, progress = null) => patch({ detail, progress }),
    get cancelled() {
      return cancelled;
    },
  };
  try {
    const out = await work(handle);
    patch({ done: true, progress: 1 });
    return out;
  } catch (e) {
    patch({ done: true, error: typeof e === "string" ? e : e instanceof Error ? e.message : "Failed" });
    throw e;
  } finally {
    if (opts.reload !== false) reloadAll();
    // Finished jobs stay visible for a moment so you can see they're done.
    window.setTimeout(() => {
      jobs = jobs.filter((j) => j.id !== id);
      notify();
    }, jobs.find((j) => j.id === id)?.error ? 9000 : 2500);
  }
}

export function dismiss(id: number): void {
  jobs = jobs.filter((j) => j.id !== id);
  notify();
}
