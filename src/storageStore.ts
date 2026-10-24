// Runs storage jobs one at a time (they are heavy on the NAS and the computer) and keeps
// the queue while you move between screens.
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { api, errorText, StorageJob } from "./api";

export interface QueueItem {
  key: number;
  job: StorageJob;
  id: number | null;
  state: "waiting" | "running" | "done" | "failed" | "cancelled";
  percent: number;
  text: string;
}

interface Ev {
  id: number;
  kind: "progress" | "status" | "done" | "failed" | "cancelled";
  percent: number | null;
  text: string | null;
}

let items: QueueItem[] = [];
let nextKey = 1;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const set = (key: number, f: (q: QueueItem) => QueueItem) => {
  items = items.map((q) => (q.key === key ? f(q) : q));
  notify();
};

let listening = false;
function ensure() {
  if (listening) return;
  listening = true;
  void listen<Ev>("storage-event", ({ payload: e }) => {
    const q = items.find((x) => x.id === e.id);
    if (!q) return;
    if (e.kind === "progress") set(q.key, (x) => ({ ...x, percent: e.percent ?? x.percent }));
    else if (e.kind === "status") set(q.key, (x) => ({ ...x, text: e.text ?? x.text }));
    else {
      set(q.key, (x) => ({ ...x, state: e.kind as QueueItem["state"], percent: e.kind === "done" ? 100 : x.percent, text: e.text ?? "" }));
      void pump();
    }
  });
}

async function pump() {
  if (items.some((q) => q.state === "running")) return;
  const next = items.find((q) => q.state === "waiting");
  if (!next) return;
  set(next.key, (x) => ({ ...x, state: "running", text: "Starting…" }));
  try {
    const id = await api.storageStart(next.job);
    set(next.key, (x) => ({ ...x, id }));
  } catch (e) {
    set(next.key, (x) => ({ ...x, state: "failed", text: errorText(e) }));
    void pump();
  }
}

export function enqueue(jobs: StorageJob[]) {
  ensure();
  items = [...items, ...jobs.map((job) => ({ key: nextKey++, job, id: null, state: "waiting" as const, percent: 0, text: "Waiting" }))];
  notify();
  void pump();
}

export function cancel(key: number) {
  const q = items.find((x) => x.key === key);
  if (!q) return;
  if (q.state === "waiting") set(key, (x) => ({ ...x, state: "cancelled", text: "Cancelled" }));
  else if (q.state === "running" && q.id !== null) void api.storageCancel(q.id);
}

export function clearDone() {
  items = items.filter((q) => q.state === "waiting" || q.state === "running");
  notify();
}

export function useQueue(): QueueItem[] {
  ensure();
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => items,
  );
}
