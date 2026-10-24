// Keeps the download queue alive while you move between screens.
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";

export interface Job {
  id: number;
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  percent: number;
  speed: string;
  eta: string;
  text: string;
  /** Playlists: "3/12". */
  item: string;
  /** Files saved so far (full paths). */
  files: string[];
}

// Same events as the standalone Goblin app (downloads.rs is shared).
interface DlEvent {
  id: number;
  kind: "progress" | "status" | "title" | "file" | "done" | "failed" | "cancelled";
  percent: number | null;
  speed: string | null;
  eta: string | null;
  item: string | null;
  text: string | null;
}

let jobs: Job[] = [];
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

function update(id: number, f: (j: Job) => Job) {
  jobs = jobs.map((j) => (j.id === id ? f(j) : j));
  notify();
}

let listening = false;
function ensureListening() {
  if (listening) return;
  listening = true;
  void listen<DlEvent>("dl-event", ({ payload: e }) => {
    update(e.id, (j) => {
      switch (e.kind) {
        case "progress":
          // A playlist restarts at 0% for each video; keep the bar moving forward per item.
          return { ...j, percent: e.percent ?? j.percent, speed: e.speed ?? "", eta: e.eta ?? "", item: e.item ?? j.item };
        case "status":
          return { ...j, text: e.text ?? j.text };
        case "title":
          return { ...j, text: e.text ?? j.text };
        case "file":
          return e.text ? { ...j, files: [...j.files, e.text] } : j;
        case "done":
          return { ...j, state: "done", percent: 100, eta: "", speed: "", text: e.text ?? "Finished" };
        case "failed":
          return { ...j, state: "failed", text: e.text ?? "Failed" };
        case "cancelled":
          return { ...j, state: "cancelled", text: "Cancelled" };
        default:
          return j;
      }
    });
  });
}

export function addJob(id: number, title: string) {
  ensureListening();
  jobs = [{ id, title, state: "running", percent: 0, speed: "", eta: "", text: "Starting…", item: "", files: [] }, ...jobs];
  notify();
}

export function clearFinished() {
  jobs = jobs.filter((j) => j.state === "running");
  notify();
}

export function useJobs(): Job[] {
  ensureListening();
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => jobs,
  );
}
