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
  kind: "video" | "sidecar" | "folder";
  status: "ok" | "unchanged" | "conflict" | "unparsed";
  note: string | null;
  season: number | null;
  episodes: number[];
  verified: boolean;
  score: number | null;
  title: string | null;
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
  mode: "tv" | "movie";
}

export interface FindReplace {
  find: string;
  replace: string;
  regex: boolean;
}

export interface PlanArgs {
  mode: "auto" | "tv" | "movie";
  folder: string;
  template: string;
  show: string | null;
  year: number | null;
  findReplace: FindReplace[];
  recursive: boolean;
  source: "auto" | "jellyfin" | "tmdb" | "tvmaze" | "none";
  matchId: string | null;
  renameFolder: boolean | null;
  seasonFolders: boolean;
  /** Shows: names that differ only by a "(2018)" year are left as they are. */
  yearOptional?: boolean;
  /** Only tidy messy names (release tags, dots); leave names Jellyfin reads fine. */
  minimal?: boolean;
  /** Movies: only this file (and its subtitles), matched to the Jellyfin item `itemId`. */
  onlyFile?: string | null;
  itemId?: string | null;
}

export interface ExtraSub {
  id: string;
  name: string;
  index: number;
  language: string;
  title: string;
  path: string;
}

export interface TuneRow {
  scope: "library" | "task";
  target: string;
  targetName: string;
  key: string;
  label: string;
  detail: string;
  current: unknown;
  recommended: unknown;
  ok: boolean;
}

export interface Tuning {
  rows: TuneRow[];
  version: string;
  markersOk: boolean;
  lockEdits: boolean;
}

/**
 * After renaming: tells Jellyfin to look at the folders around these (their parents, so
 * renamed folders are seen too). Falls back to a full scan for top-level folders.
 */
/**
 * Renames like `api.apply`, but when a show's own folder gets a new name its skip markers are
 * read first and put back on the same episodes once Jellyfin has found the show again (its
 * id changes with the folder name).
 */
export async function applyPlan(plan: PlanResult, removeEmpty: boolean, selected: string[], seriesId: string | null, showFolder: string | null) {
  const top = seriesId && showFolder != null ? plan.ops.find((o) => o.kind === "folder" && o.status === "ok" && o.from === showFolder && selected.includes(o.from)) : undefined;
  const snap = top && seriesId ? await api.segmentsSnapshot(seriesId).catch(() => [] as SegSnap[]) : [];
  const rep = await api.apply(plan.planId, removeEmpty, selected);
  if (top && seriesId && snap.length && rep.done) {
    void api.segmentsCarry(snap, top.to.split("/").pop() ?? "", seriesId).catch(() => undefined);
  }
  return rep;
}

export interface SegSnap { season: number; episode: number; kind: string; start: number; end: number }

export async function scanAround(folders: string[]): Promise<void> {
  const parents = [...new Set(folders.map((f) => f.split("/").slice(0, -1).join("/")))];
  const list = parents.some((p) => p === "") ? [] : parents;
  await api.scanFolders(list).catch(() => api.libraryScan().catch(() => undefined));
}

export interface Batch {
  batch: string;
  at: number;
  files: number;
  undone: number;
  example: string;
}

export type ImageKind = "Primary" | "Backdrop" | "Logo" | "Thumb" | "Banner" | "Art" | "Disc" | "Chapter";

export interface Change {
  id: number;
  at: number;
  action: "item_update" | "identify" | "image" | "image_removed" | "collection" | "subtitle" | "segment" | "storage";
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
  UserData?: { Played?: boolean; PlaybackPositionTicks?: number; IsFavorite?: boolean };
  MediaSources?: { Container?: string; Size?: number; Bitrate?: number; Path?: string; MediaStreams?: JfStream[] }[];
  MediaStreams?: JfStream[];
  Chapters?: { Name?: string; StartPositionTicks: number; ImageTag?: string }[];
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  Taglines?: string[];
  Studios?: { Name: string }[];
  People?: { Id: string; Name: string; Role?: string; Type?: string; PrimaryImageTag?: string }[];
  DateCreated?: string;
  EndDate?: string;
  Status?: string;
}

export interface JfStream {
  Type: string;
  Index?: number;
  Language?: string;
  IsForced?: boolean;
  IsExternal?: boolean;
  IsHearingImpaired?: boolean;
  Codec?: string;
  DisplayTitle?: string;
  Title?: string;
  Width?: number;
  Height?: number;
  VideoRange?: string;
  Channels?: number;
  BitRate?: number;
  Path?: string;
}

export interface JfChild extends JfItem {
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

export interface Card {
  id: string;
  kind: "movie" | "series" | "episode" | "season" | "collection" | "person" | "other";
  title: string;
  subtitle: string;
  artId: string;
  seriesId: string | null;
  year: number | null;
  progress: number | null;
  played: boolean;
  hasPoster: boolean;
}

export interface HomeFeed {
  resume: Card[];
  nextUp: Card[];
  recent: Card[];
  collections: Card[];
}

export interface CheckRow {
  id: string;
  kind: "series" | "movie";
  name: string;
  year: number | null;
  folder: string;
  file: string | null;
  toRename: number;
  folders: number;
  problems: number;
  right: number;
  sure: boolean;
  reasons: string[];
  example: [string, string] | null;
  error: string | null;
}

export interface CheckResult {
  at: number;
  rows: CheckRow[];
}

export interface Trickplay {
  base: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  count: number;
  interval: number;
}

export interface About {
  itemId: string;
  artId: string;
  overview: string;
  year: number | null;
  rating: number | null;
  officialRating: string;
  genres: string[];
  people: { id: string; name: string; role: string; hasImage: boolean }[];
}

export interface Downloaded {
  /** Stream index once Jellyfin lists it. */
  index: number | null;
  /** The subtitle text when Media Hub saved the file itself. */
  text: string | null;
  format: string;
  /** Where it was saved on this computer ("" when Jellyfin downloaded it). */
  file: string;
}

/** SRT (or VTT) text as WebVTT the video element can read. */
export function toVtt(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (t.startsWith("WEBVTT")) return t;
  const body = t
    .split(/\n{2,}/)
    .map((block) => block.replace(/^\d+\n(?=\d\d:)/, "").replace(/(\d\d:\d\d:\d\d),(\d{3})/g, "$1.$2"))
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}

export interface SubTrack {
  index: number;
  language: string;
  title: string;
  url: string;
  default: boolean;
}

export interface ImportSource {
  name: string;
  isFolder: boolean;
  files: { rel: string; size: number; video: boolean }[];
  totalBytes: number;
  kind: "tv" | "movie";
  title: string;
  year: number | null;
}

export interface HealthRow {
  id: string;
  kind: "series" | "movie";
  name: string;
  year: number | null;
  identified: boolean;
  poster: boolean;
  backdrop: boolean;
  logo: boolean;
  thumb: boolean;
  banner: boolean;
  videos: number;
  noSubs: number;
  libraryFolder: string;
  /** Server path (older checks: empty). */
  path?: string;
}

export interface EpInfo {
  season: number;
  episode: number;
  title: string;
  airDate: string | null;
}

export interface MissingReport {
  source: string;
  have: number;
  known: number;
  missing: EpInfo[];
  upcoming: EpInfo[];
  specialsMissing: number;
}

export interface DupItem {
  id: string;
  name: string;
  path: string;
  size: number;
  width: number;
  height: number;
  codec: string;
  hdr: boolean;
  bitrate: number;
  versions: number;
  best: boolean;
}

export interface DupGroup {
  title: string;
  kind: "movie" | "episode" | "mixed";
  items: DupItem[];
}

export interface TagStat {
  kind: "genre" | "tag";
  name: string;
  count: number;
}

export interface Alert {
  level: "error" | "warn" | "info";
  title: string;
  detail: string;
  /** "settings:<section>" or a screen name */
  fix: string;
}

export interface MusicItem {
  id: string;
  kind: "album" | "artist" | "track" | "playlist";
  name: string;
  artist: string;
  album: string;
  albumId: string | null;
  year: number | null;
  index: number | null;
  disc: number | null;
  duration: number;
  artId: string;
  hasArt: boolean;
  count: number | null;
  favorite: boolean;
  /** Picture for music from a folder. */
  artUrl?: string;
}

export interface LibraryLang {
  id: string;
  name: string;
  kind: string;
  language: string;
  country: string;
}

export interface SyncFit {
  offset: number;
  scale: number;
  before: number;
  after: number;
}

export interface JournalRow {
  id: number;
  at: number;
  action: string;
  target: string;
  title: string;
  undone: boolean;
}

export interface SegSummary {
  episodes: number;
  intro: number;
  credits: number;
  recap: number;
}

export interface InboxEntry {
  name: string;
  source: ImportSource;
  modified: number;
}

export interface PlayInfo {
  token: string;
  url: string;
  title: string;
  subtitle: string;
  audio: { index: number; title: string; selected: boolean }[];
  duration: number;
  start: number;
  subtitles: SubTrack[];
  segments: { Type: string; StartTicks: number; EndTicks: number }[];
  resume: number;
  next: { id: string; label: string } | null;
  about?: About;
  trickplay?: Trickplay | null;
  chapters?: { name: string; start: number }[];
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
  picks: (date: string, only?: string[] | null) => invoke<Pick[]>("todays_picks", { date, only: only ?? null }),
  libraries: () => invoke<Library[]>("libraries"),
  attention: () => invoke<Attention>("attention"),
  missingSubtitles: (start: number, limit: number) =>
    invoke<{ Items: JfChild[]; TotalRecordCount: number }>("missing_subtitles", { start, limit }),
  setTmdbKey: (key: string) => invoke<void>("set_tmdb_key", { key }),
  setTitleLang: (lang: string) => invoke<void>("set_title_lang", { lang }),
  listUsers: () => invoke<{ id: string; name: string; admin: boolean }[]>("list_users"),
  setUser: (id: string) => invoke<void>("set_user", { id }),
  setSyncWatched: (value: boolean) => invoke<void>("set_sync_watched", { value }),
  watchSyncTest: () => invoke<string>("watch_sync_test"),
  checkUpdate: () => invoke<{ current: string; latest: string | null; available: boolean; notes: string }>("check_update"),
  installUpdate: () => invoke<void>("install_update"),
  pickRoot: () => invoke<string | null>("pick_library_root"),
  folders: (folder: string) => invoke<{ name: string }[]>("list_folders", { folder }),
  plan: (args: PlanArgs) => invoke<PlanResult>("plan_rename", { args }),
  segmentsSnapshot: (seriesId: string) => invoke<SegSnap[]>("segments_snapshot", { seriesId }),
  segmentsCarry: (snapshot: SegSnap[], folderName: string, oldSeriesId: string) => invoke<void>("segments_carry", { snapshot, folderName, oldSeriesId }),
  apply: (planId: string, removeEmpty: boolean, selected: string[] | null = null) =>
    invoke<{ batch: string; done: number; failed: string[] }>("apply_plan", { planId, removeEmpty, selected }),
  history: () => invoke<Batch[]>("rename_history"),
  details: (id: string) => invoke<Details>("item_details", { id }),
  saveMetadata: (id: string, edits: ItemEdits) => invoke<void>("save_metadata", { id, edits }),
  identifySearch: (kind: "series" | "movie", name: string, year: number | null, ids: Record<string, string>) =>
    invoke<SearchResult[]>("identify_search", { kind, name, year, ids }),
  identifyApply: (id: string, result: SearchResult, replaceImages: boolean) =>
    artChange(id, invoke<void>("identify_apply", { id, result, replaceImages })),
  remoteImages: (id: string, kind: ImageKind) => invoke<RemoteImage[]>("remote_images", { id, kind }),
  setImage: (id: string, kind: ImageKind, url: string) => artChange(id, invoke<void>("set_image", { id, kind, url })),
  uploadImageFile: (id: string, kind: ImageKind) => artChange(id, invoke<boolean>("upload_image_file", { id, kind })),
  undoChange: (changeId: number) => invoke<void>("undo_change", { changeId }).finally(() => bumpArt()),
  refreshItem: (id: string, replaceAll: boolean) => artChange(id, invoke<void>("refresh_item", { id, replaceAll })),
  setReadOnly: (value: boolean) => invoke<void>("set_read_only", { value }),
  languages: () => invoke<Culture[]>("languages"),
  setSubLangs: (langs: string[]) => invoke<void>("set_sub_langs", { langs }),
  children: (id: string) => invoke<JfChild[]>("item_children", { id }),
  subtitleOptions: (id: string, lang: string) => invoke<SubOptions>("subtitle_options", { id, lang }),
  /** Saves the subtitle next to the video (text comes back to show it at once), or has Jellyfin download it. */
  subtitleDownload: (id: string, subtitleId: string, lang: string, codes: string[], format?: string | null) =>
    invoke<Downloaded>("subtitle_download", { id, subtitleId, lang, codes, format: format ?? null }),
  subtitleAuto: (id: string, lang: string, codes: string[], minScore: number) =>
    invoke<AutoResult>("subtitle_auto", { id, lang, codes, minScore }),
  segmentsOverview: (seasonId: string) => invoke<SegOverview>("segments_overview", { seasonId }),
  detectSeason: (seasonId: string, introMax: number, creditsMax: number, findIntro = true, findCredits = true) =>
    invoke<Suggestion[]>("detect_season", { seasonId, introMax, creditsMax, findIntro, findCredits }),
  saveSegments: (itemId: string, intro: Span | null, credits: Span | null, recap: Span | null, clear: string[]) =>
    invoke<void>("save_segments", { itemId, intro, credits, recap, clear }),
  ffmpegInfo: () => invoke<{ path: string | null; version: string | null }>("ffmpeg_info"),
  pickFfmpeg: () => invoke<string | null>("pick_ffmpeg"),
  playStart: (id: string, start: number, audioIndex: number | null = null) => invoke<PlayInfo>("play_start", { id, start, audioIndex }),
  playStop: (token: string) => invoke<void>("play_stop", { token }),
  playProgress: (token: string, position: number, finished: boolean) => invoke<void>("play_progress", { token, position, finished }),
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
  mainBackdrop: (id: string, index: number) => artChange(id, invoke<void>("main_backdrop", { id, index })),
  removeImage: (id: string, kind: ImageKind, index: number) => artChange(id, invoke<void>("remove_image", { id, kind, index })),
  fillMissingArt: (id: string, kinds: ImageKind[], lang: string | null = null) => artChange(id, invoke<string[]>("fill_missing_art", { id, kinds, lang })),
  imagesRevalidate: () => invoke<void>("images_revalidate"),
  /** A title whose id changed (folder renamed): its new id, found by name and year. */
  findMoved: (id: string) => invoke<string | null>("find_moved", { id }),
  collectionFolderPlan: (id: string, name: string | null) => invoke<{ planId: string; folder: string; ops: PlanOp[]; skipped: string[] }>("collection_folder_plan", { id, name }),
  collectionRelink: (id: string, movies: [string, number | null][]) => invoke<void>("collection_relink", { id, movies }),
  homeFeed: () => invoke<HomeFeed>("home_feed"),
  collections: () => invoke<Card[]>("collections_list"),
  collectionItems: (id: string) => invoke<Card[]>("collection_items", { id }),
  similar: (id: string) => invoke<Card[]>("similar_items", { id }),
  personItems: (id: string) => invoke<Card[]>("person_items", { id }),
  collectionCreate: (name: string, ids: string[]) => invoke<string>("collection_create", { name, ids }),
  collectionAdd: (id: string, ids: string[]) => invoke<void>("collection_add", { id, ids }),
  collectionRemove: (id: string, ids: string[]) => invoke<void>("collection_remove", { id, ids }),
  syncPicksCollection: (ids: string[]) => invoke<string>("sync_picks_collection", { ids }),
  revealItem: (id: string) => invoke<void>("reveal_item", { id }),
  revealRel: (rel: string) => invoke<void>("reveal_rel", { rel }),
  itemFolder: (id: string) => invoke<string>("item_folder", { id }),
  libraryScan: () => invoke<void>("library_scan"),
  namingCheck: (tvTemplate: string, movieTemplate: string, ids: string[] | null = null, yearOptional = true, minimal = true) =>
    invoke<CheckResult>("naming_check", { tvTemplate, movieTemplate, ids, yearOptional, minimal }),
  backendTuning: () => invoke<Tuning>("backend_tuning"),
  backendSet: (scope: "library" | "task", target: string, key: string, value: unknown) => invoke<void>("backend_set", { scope, target, key, value }),
  backendApplyRecommended: () => invoke<number>("backend_apply_recommended"),
  backendRunTask: (taskId: string) => invoke<void>("backend_run_task", { taskId }),
  setLockEdits: (value: boolean) => invoke<void>("set_lock_edits", { value }),
  lockAll: (lock: boolean, ids: string[] | null = null) => invoke<number>("lock_all", { lock, ids }),
  /** Asks Jellyfin to look only at these folders (relative to the library folder); "" or none = everything. */
  scanFolders: (folders: string[]) => invoke<"folders" | "all">("scan_folders", { folders }),
  cancelJob: (kind: string) => invoke<void>("cancel_job", { kind }),
  extraSubtitles: (keep: string[]) => invoke<ExtraSub[]>("extra_subtitles", { keep }),
  removeSubtitleFiles: (files: { id: string; path: string }[]) => invoke<number>("remove_subtitle_files", { files }),
  namingCheckLast: () => invoke<CheckResult | null>("naming_check_last"),
  namingCheckCancel: () => invoke<void>("naming_check_cancel"),
  playSubtitles: (token: string) => invoke<SubTrack[]>("play_subtitles", { token }),
  setPlayed: (id: string, played: boolean) => invoke<void>("set_played", { id, played }),
  importPick: (folder: boolean) => invoke<ImportSource | null>("import_pick", { folder }),
  importRun: (dest: string, title: string, year: number | null, mode: "move" | "copy") =>
    invoke<{ folder: string; moved: number; copied: number; skipped: string[] }>("import_run", { dest, title, year, mode }),
  clearResume: (id: string) => invoke<void>("clear_resume", { id }),
  inboxPick: () => invoke<string | null>("inbox_pick"),
  inboxList: () => invoke<[string | null, InboxEntry[]]>("inbox_list"),
  inboxSelect: (name: string) => invoke<ImportSource>("inbox_select", { name }),
  libraryHealth: (fresh: boolean) => invoke<{ at: number; rows: HealthRow[] }>("library_health", { fresh }),
  setFavorite: (id: string, favorite: boolean) => invoke<void>("set_favorite", { id, favorite }),
  libraryLanguages: () => invoke<LibraryLang[]>("library_languages"),
  setLibraryLanguage: (id: string, language: string, country: string, refresh: boolean) =>
    invoke<void>("set_library_language", { id, language, country, refresh }),
  subtitleSync: (id: string, index: number, apply: boolean) =>
    invoke<{ fit: SyncFit; sure: boolean; applied: boolean; file: string }>("subtitle_sync", { id, index, apply }),
  musicRescan: () => invoke<number>("music_rescan"),
  musicList: (view: string, parent: string | null, query: string | null, start: number, limit: number) =>
    invoke<MusicItem[]>("music_list", { view, parent, query, start, limit }),
  musicPlay: (id: string) => invoke<string>("music_play", { id }),
  musicStop: (token: string) => invoke<void>("music_stop", { token }),
  musicSource: () => invoke<{ folder: string | null; source: "jellyfin" | "folder" }>("music_source"),
  setMusicSource: (folder: boolean) => invoke<void>("set_music_source", { folder }),
  pickMusicFolder: () => invoke<string | null>("pick_music_folder"),
  missingEpisodes: (seriesId: string) => invoke<MissingReport>("missing_episodes", { seriesId }),
  findDuplicates: () => invoke<DupGroup[]>("find_duplicates"),
  mergeVersions: (ids: string[]) => invoke<void>("merge_versions", { ids }),
  trashItemFile: (id: string) => invoke<number>("trash_item_file", { id }),
  tagStats: () => invoke<TagStat[]>("tag_stats"),
  tagsMerge: (kind: "genre" | "tag", from: string[], to: string | null) => invoke<number>("tags_merge", { kind, from, to }),
  makeEpisodeStills: (parentId: string) => invoke<number>("make_episode_stills", { parentId }),
  healthAlerts: () => invoke<Alert[]>("health_alerts"),
  syncPicksPlaylist: (ids: string[]) => invoke<number>("sync_picks_playlist", { ids }),
  journalAll: (limit: number) => invoke<JournalRow[]>("journal_all", { limit }),
  segmentSummary: (seriesId: string, fresh = false) => invoke<SegSummary>("segment_summary", { seriesId, fresh }),
  undo: (batch: string) => invoke<{ restored: number; skipped: string[] }>("undo_rename", { batch }),
};

/** Tauri reports errors from Rust as plain strings. */
export function errorText(e: unknown): string {
  // Stopping a job isn't a problem: nothing to show.
  if (e === "Stopped." || (e instanceof Error && e.message === "Stopped.")) return "";
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
/**
 * Picture versions: when art changes (here, or after "Reload data"), the address changes too,
 * so the window never shows a picture it remembered from before.
 */
const artVersions = new Map<string, number>();
let artGlobal = 0;
export function bumpArt(id?: string): void {
  if (id) artVersions.set(id, (artVersions.get(id) ?? 0) + 1);
  else artGlobal++;
}
function artChange<T>(id: string, p: Promise<T>): Promise<T> {
  return p.finally(() => bumpArt(id));
}

/** True for the "title is gone from Jellyfin" error (and only that one). */
export function isTitleGone(e: unknown): boolean {
  return /no longer in Jellyfin/.test(errorText(e));
}

export function imageUrl(id: string, kind: ImageKind, width: number, index = 0, tag = ""): string {
  const idx = index > 0 ? `/${index}` : "";
  const v = artGlobal * 1000 + (artVersions.get(id) ?? 0);
  return `${IMG_BASE}/${id}/${kind}${idx}?w=${width}${tag ? `&t=${encodeURIComponent(tag)}` : ""}${v ? `&v=${v}` : ""}`;
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

/** "Bluey (2018)" → "Bluey" when the year is shown separately anyway. */
export function cleanTitle(name: string, year?: number | null): string {
  const m = name.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (m && (!year || Number(m[2]) === year)) return m[1];
  return name;
}

/** Wraps a promise so the "open in Finder" style one-liners don't need their own error handling. */
export function quiet(p: Promise<unknown>): void {
  p.catch(() => undefined);
}
