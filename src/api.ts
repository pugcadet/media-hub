import { invoke } from "@tauri-apps/api/core";

export interface Status {
  connected: boolean;
  serverUrl: string | null;
  serverName: string | null;
  libraryRoot: string | null;
  subLangs: string[];
  titleLang: string;
  hasTmdb: boolean;
  syncWatched: boolean;
  userId: string | null;
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
  library: string;
  matched: boolean;
  seasons: number | null;
  episodes: number | null;
  runtime: number | null;
  played: boolean;
}

export interface Library {
  id: string;
  name: string;
  kind: string;
  count: number;
}

export interface Attention {
  unmatched: number;
  noPoster: number;
  noSubtitles: number | null;
}

export interface Pick {
  id: string;
  artId: string;
  title: string;
  why: string;
  meta: string;
}

export interface Candidate {
  source: "tmdb" | "tvmaze" | "jellyfin";
  id: string;
  name: string;
  year: number | null;
  poster: string | null;
  score: number;
  ids: Record<string, string>;
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
  score: number | null;
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
  guess: string;
  candidates: Candidate[];
  chosen: Candidate | null;
  matchedMovies: number;
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
  recursive: boolean;
  source: "auto" | "jellyfin" | "tmdb" | "tvmaze" | "none";
  matchId: string | null;
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
  action: "item_update" | "identify" | "image" | "subtitle" | "segment" | "storage";
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
  ParentIndexNumber?: number;
  RunTimeTicks?: number;
  Path?: string;
  ChildCount?: number;
  PreferredMetadataLanguage?: string;
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number };
  SeriesId?: string;
  SeriesName?: string;
}

export interface JfChild extends JfItem {
  MediaStreams?: { Type: string; Language?: string; IsForced?: boolean }[];
  SeriesId?: string;
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
  preferredLanguage?: string;
}

export interface Culture {
  DisplayName: string;
  Name: string;
  ThreeLetterISOLanguageName: string;
  ThreeLetterISOLanguageNames?: string[];
}

export interface SubStream {
  index: number;
  language: string;
  title: string;
  external: boolean;
  forced: boolean;
  path: string;
}

export interface SubInfo {
  Id?: string;
  Name?: string;
  ProviderName?: string;
  Format?: string;
  Author?: string;
  Comment?: string;
  DownloadCount?: number;
  CommunityRating?: number;
  IsHashMatch?: boolean;
  HearingImpaired?: boolean;
  Forced?: boolean;
  MachineTranslated?: boolean;
  AiTranslated?: boolean;
}

export interface ScoredSub {
  sub: SubInfo;
  score: number;
  reasons: string[];
}

export interface SubOptions {
  file: string;
  current: SubStream[];
  results: ScoredSub[];
}

export interface AutoResult {
  outcome: "has" | "downloaded" | "low" | "none";
  score: number | null;
  name: string | null;
}

export interface Span {
  start: number;
  end: number;
}

export interface Seg {
  id: string;
  kind: string;
  start: number;
  end: number;
}

export interface SegEpisode {
  id: string;
  name: string;
  index: number | null;
  duration: number;
  segments: Seg[];
}

export interface SegOverview {
  episodes: SegEpisode[];
  ffmpeg: string | null;
  canWriteSegments: boolean;
}

export interface Suggestion {
  id: string;
  intro: Span | null;
  credits: Span | null;
  introSource: string;
  creditsSource: string;
  problem: string | null;
}

export interface PlayInfo {
  token: string;
  url: string;
  title: string;
  subtitle: string;
  audio: { index: number; title: string; selected: boolean }[];
  duration: number;
  start: number;
  subtitles: { index: number; language: string; title: string; url: string; default: boolean }[];
  segments: { Type: string; StartTicks: number; EndTicks: number }[];
}

export interface DlRequest {
  url: string;
  kind: "video" | "audio";
  maxHeight: number;
  format: string;
  subtitles: boolean;
  subLangs: string[];
  sponsorblock: boolean;
  playlist: boolean;
  naming: "title" | "channel" | "series";
  seriesName: string | null;
  season: number | null;
}

export interface Probe {
  title: string;
  channel: string;
  duration: number | null;
  thumbnail: string | null;
  isPlaylist: boolean;
  entries: string[];
  entryCount: number;
}

export interface MediaInfo {
  duration: number;
  size: number;
  bitrate: number;
  videoCodec: string;
  width: number;
  height: number;
  hdr: boolean;
  audioCodec: string;
  audioChannels: number;
  audioStreams: number;
}

export interface FileRow {
  rel: string;
  info: MediaInfo | null;
  problem: string | null;
}

export interface StorageJob {
  rel: string;
  mode: "hevc" | "loudness";
  encoder: string | null;
  quality: number | null;
  targetLufs: number | null;
}

export type Sort = "name" | "rating" | "year" | "added";
export type Kind = "movie" | "series" | null;

export const api = {
  status: () => invoke<Status>("status"),
  connect: (url: string, apiKey: string) =>
    invoke<{ serverName: string; version: string }>("connect", { url, apiKey }),
  disconnect: () => invoke<void>("disconnect"),
  sync: () => invoke<{ movies: number; series: number }>("sync_library"),
  list: (kind: Kind, query: string, sort: Sort, offset: number, limit: number, library: string | null = null, flag: string | null = null) =>
    invoke<Item[]>("list_items", { kind, library, flag, query, sort, offset, limit }),
  picks: (date: string) => invoke<Pick[]>("todays_picks", { date }),
  libraries: () => invoke<Library[]>("libraries"),
  attention: () => invoke<Attention>("attention"),
  missingSubtitles: (start: number, limit: number) =>
    invoke<{ Items: JfChild[]; TotalRecordCount: number }>("missing_subtitles", { start, limit }),
  setTmdbKey: (key: string) => invoke<void>("set_tmdb_key", { key }),
  setTitleLang: (lang: string) => invoke<void>("set_title_lang", { lang }),
  listUsers: () => invoke<{ id: string; name: string; admin: boolean }[]>("list_users"),
  setUser: (id: string) => invoke<void>("set_user", { id }),
  setSyncWatched: (value: boolean) => invoke<void>("set_sync_watched", { value }),
  checkUpdate: () => invoke<{ current: string; latest: string | null; available: boolean; notes: string }>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  pickRoot: () => invoke<string | null>("pick_library_root"),
  folders: (folder: string) => invoke<{ name: string }[]>("list_folders", { folder }),
  plan: (args: PlanArgs) => invoke<PlanResult>("plan_rename", { args }),
  apply: (planId: string, removeEmpty: boolean, selected: string[] | null = null) =>
    invoke<{ batch: string; done: number; failed: string[] }>("apply_plan", { planId, removeEmpty, selected }),
  history: () => invoke<Batch[]>("rename_history"),
  details: (id: string) => invoke<Details>("item_details", { id }),
  saveMetadata: (id: string, edits: ItemEdits) => invoke<void>("save_metadata", { id, edits }),
  identifySearch: (kind: "series" | "movie", name: string, year: number | null, ids: Record<string, string>) =>
    invoke<SearchResult[]>("identify_search", { kind, name, year, ids }),
  identifyApply: (id: string, result: SearchResult, replaceImages: boolean) =>
    invoke<void>("identify_apply", { id, result, replaceImages }),
  remoteImages: (id: string, kind: ImageKind) => invoke<RemoteImage[]>("remote_images", { id, kind }),
  setImage: (id: string, kind: ImageKind, url: string) => invoke<void>("set_image", { id, kind, url }),
  uploadImageFile: (id: string, kind: ImageKind) => invoke<boolean>("upload_image_file", { id, kind }),
  undoChange: (changeId: number) => invoke<void>("undo_change", { changeId }),
  refreshItem: (id: string, replaceAll: boolean) => invoke<void>("refresh_item", { id, replaceAll }),
  setReadOnly: (value: boolean) => invoke<void>("set_read_only", { value }),
  languages: () => invoke<Culture[]>("languages"),
  setSubLangs: (langs: string[]) => invoke<void>("set_sub_langs", { langs }),
  children: (id: string) => invoke<JfChild[]>("item_children", { id }),
  subtitleOptions: (id: string, lang: string) => invoke<SubOptions>("subtitle_options", { id, lang }),
  subtitleDownload: (id: string, subtitleId: string, lang: string, codes: string[]) =>
    invoke<void>("subtitle_download", { id, subtitleId, lang, codes }),
  subtitleAuto: (id: string, lang: string, codes: string[], minScore: number) =>
    invoke<AutoResult>("subtitle_auto", { id, lang, codes, minScore }),
  segmentsOverview: (seasonId: string) => invoke<SegOverview>("segments_overview", { seasonId }),
  detectSeason: (seasonId: string, introMax: number, creditsMax: number) =>
    invoke<Suggestion[]>("detect_season", { seasonId, introMax, creditsMax }),
  saveSegments: (itemId: string, intro: Span | null, credits: Span | null, recap: Span | null, clear: string[]) =>
    invoke<void>("save_segments", { itemId, intro, credits, recap, clear }),
  ffmpegInfo: () => invoke<{ path: string | null; version: string | null }>("ffmpeg_info"),
  pickFfmpeg: () => invoke<string | null>("pick_ffmpeg"),
  playStart: (id: string, start: number, audioIndex: number | null = null) => invoke<PlayInfo>("play_start", { id, start, audioIndex }),
  playStop: (token: string) => invoke<void>("play_stop", { token }),
  ytdlpInfo: () => invoke<{ path: string | null; version: string | null; managed: boolean; folder: string | null }>("ytdlp_info"),
  ytdlpInstall: () => invoke<string>("ytdlp_install"),
  pickDownloadFolder: () => invoke<string | null>("pick_download_folder"),
  dlProbe: (url: string) => invoke<Probe>("dl_probe", { url }),
  dlStart: (req: DlRequest) => invoke<number>("dl_start", { req }),
  dlCancel: (id: number) => invoke<void>("dl_cancel", { id }),
  /** Shows a downloaded file (or with null, the download folder) in Finder / Explorer. */
  dlReveal: (path: string | null) => invoke<void>("dl_reveal", { path }),
  storageScan: (folder: string) => invoke<FileRow[]>("storage_scan", { folder }),
  hevcEncoders: () => invoke<string[]>("hevc_encoders"),
  storageStart: (req: StorageJob) => invoke<number>("storage_start", { req }),
  storageCancel: (id: number) => invoke<void>("storage_cancel", { id }),
  storageHistory: () => invoke<Change[]>("storage_history"),
  trashInfo: () => invoke<{ files: number; bytes: number }>("trash_info"),
  trashEmpty: (confirm: string) => invoke<void>("trash_empty", { confirm }),
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

// Language list from Jellyfin, loaded once.
let culturesCache: Promise<Culture[]> | null = null;
export function cultures(): Promise<Culture[]> {
  if (!culturesCache) {
    culturesCache = api.languages().catch((e) => {
      culturesCache = null;
      throw e;
    });
  }
  return culturesCache;
}

/** All 3-letter codes Jellyfin may use for a language ("dut" and "nld" for Dutch). */
export function codesFor(code: string, list: Culture[]): string[] {
  const c = list.find((x) => x.ThreeLetterISOLanguageName === code || x.ThreeLetterISOLanguageNames?.includes(code));
  return [...new Set([code, ...(c ? [c.ThreeLetterISOLanguageName, ...(c.ThreeLetterISOLanguageNames ?? [])] : [])])];
}

export function languageName(code: string, list: Culture[]): string {
  const c = list.find((x) => x.ThreeLetterISOLanguageName === code || x.ThreeLetterISOLanguageNames?.includes(code));
  return c ? c.DisplayName : code;
}
