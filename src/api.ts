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

export type ImageKind = "Primary" | "Backdrop" | "Logo" | "Thumb" | "Banner";

export interface Change {
  id: number;
  at: number;
  action: "item_update" | "identify" | "image";
  target: string;
  undone: boolean;
}

/** Jellyfin's own JSON for an item. Only the fields this app reads are typed. */
export interface JfItem {
  Id: string;
  Name: string;
  Type: string;
  OriginalTitle?: string;
  ForcedSortName?: string;
  SortName?: string;
  ProductionYear?: number | null;
  PremiereDate?: string;
  Overview?: string;
  Genres?: string[];
  Tags?: string[];
  CommunityRating?: number | null;
  CriticRating?: number | null;
  OfficialRating?: string;
  ProviderIds?: Record<string, string>;
  LockData?: boolean;
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  IndexNumber?: number;
  SeriesId?: string;
  SeriesName?: string;
}

export interface JfImage {
  ImageType: string;
  ImageIndex?: number;
  ImageTag?: string;
  Width?: number;
  Height?: number;
}

export interface Details {
  item: JfItem;
  images: JfImage[];
  seasons: JfItem[];
  changes: Change[];
  canEdit: boolean;
}

export interface RemoteImage {
  ProviderName?: string;
  Url?: string;
  ThumbnailUrl?: string;
  Width?: number;
  Height?: number;
  CommunityRating?: number;
  VoteCount?: number;
  Language?: string;
}

export interface SearchResult {
  Name?: string;
  ProductionYear?: number;
  ProviderIds?: Record<string, string>;
  ImageUrl?: string;
  SearchProviderName?: string;
  Overview?: string;
  [key: string]: unknown;
}

export interface ItemEdits {
  name?: string;
  originalTitle?: string;
  sortName?: string;
  productionYear?: number | null;
  overview?: string;
  genres?: string[];
  tags?: string[];
  communityRating?: number | null;
  officialRating?: string;
  providerIds?: Record<string, string>;
  lockData?: boolean;
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
  details: (id: string) => invoke<Details>("item_details", { id }),
  saveMetadata: (id: string, edits: ItemEdits) => invoke<void>("save_metadata", { id, edits }),
  identifySearch: (kind: "series" | "movie", name: string, year: number | null, ids: Record<string, string>) =>
    invoke<SearchResult[]>("identify_search", { kind, name, year, ids }),
  identifyApply: (id: string, result: SearchResult, replaceImages: boolean) =>
    invoke<void>("identify_apply", { id, result, replaceImages }),
  remoteImages: (id: string, kind: ImageKind) => invoke<RemoteImage[]>("remote_images", { id, kind }),
  setImage: (id: string, kind: ImageKind, url: string) => invoke<void>("set_image", { id, kind, url }),
  undoChange: (changeId: number) => invoke<void>("undo_change", { changeId }),
  refreshItem: (id: string, replaceAll: boolean) => invoke<void>("refresh_item", { id, replaceAll }),
  setReadOnly: (value: boolean) => invoke<void>("set_read_only", { value }),
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

/** `tag` changes when the picture changes, so the window fetches the new one. */
export function imageUrl(id: string, kind: ImageKind, width: number, index = 0, tag = ""): string {
  const idx = index > 0 ? `/${index}` : "";
  return `${IMG_BASE}/${id}/${kind}${idx}?w=${width}${tag ? `&t=${encodeURIComponent(tag)}` : ""}`;
}

/** Candidate pictures from TMDB/TVDB/fanart, fetched by the app (only from known image sites). */
export function remoteImageUrl(url: string): string {
  return `${IMG_BASE}/remote?u=${encodeURIComponent(url)}`;
}
