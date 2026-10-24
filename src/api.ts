import { invoke } from "@tauri-apps/api/core";

export interface Status {
  connected: boolean;
  serverUrl: string | null;
  serverName: string | null;
  libraryRoot: string | null;
  readOnly: boolean;
  movies: number;
  series: number;
  lastSync: number | null;
  problem: string | null;
}

export interface Item {
  id: string;
  kind: "movie" | "series";
  name: string;
  year: number | null;
  rating: number | null;
  genres: string[];
  overview: string;
  hasPoster: boolean;
}

export interface PlanOp {
  from: string;
  to: string;
  kind: "video" | "sidecar";
  status: "ok" | "unchanged" | "conflict" | "unparsed";
  note: string | null;
  season: number | null;
  episodes: number[];
  verified: boolean;
}

export interface PlanResult {
  planId: string;
  ops: PlanOp[];
  ok: number;
  unchanged: number;
  conflict: number;
  unparsed: number;
  titlesFound: number;
  warning: string | null;
}

export interface FindReplace {
  find: string;
  replace: string;
  regex: boolean;
}

export interface PlanArgs {
  mode: "tv" | "movie";
  folder: string;
  template: string;
  show: string | null;
  year: number | null;
  findReplace: FindReplace[];
  seriesId: string | null;
  recursive: boolean;
}

export interface Batch {
  batch: string;
  at: number;
  files: number;
  undone: number;
  example: string;
}

export type Sort = "name" | "rating" | "year" | "added";
export type Kind = "movie" | "series" | null;

export const api = {
  status: () => invoke<Status>("status"),
  connect: (url: string, apiKey: string) =>
    invoke<{ serverName: string; version: string }>("connect", { url, apiKey }),
  disconnect: () => invoke<void>("disconnect"),
  sync: () => invoke<{ movies: number; series: number }>("sync_library"),
  list: (kind: Kind, query: string, sort: Sort, offset: number, limit: number) =>
    invoke<Item[]>("list_items", { kind, query, sort, offset, limit }),
  picks: (date: string) => invoke<Item[]>("todays_picks", { date }),
  pickRoot: () => invoke<string | null>("pick_library_root"),
  folders: (folder: string) => invoke<{ name: string }[]>("list_folders", { folder }),
  plan: (args: PlanArgs) => invoke<PlanResult>("plan_rename", { args }),
  apply: (planId: string, removeEmpty: boolean) =>
    invoke<{ batch: string; done: number; failed: string[] }>("apply_plan", { planId, removeEmpty }),
  history: () => invoke<Batch[]>("rename_history"),
  undo: (batch: string) => invoke<{ restored: number; skipped: string[] }>("undo_rename", { batch }),
};

/** Tauri reports errors from Rust as plain strings. */
export function errorText(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong.";
}

export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Pictures come through a private address handled by the app itself, so the window
// never sees the server address or the API key. Windows serves it under http://*.localhost.
const IMG_BASE = navigator.userAgent.includes("Windows")
  ? "http://hubimg.localhost"
  : "hubimg://localhost";

export function imageUrl(id: string, kind: "Primary" | "Backdrop", width: number): string {
  return `${IMG_BASE}/${id}/${kind}?w=${width}`;
}
