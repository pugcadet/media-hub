// Fake Tauri backend for UI screenshots (CI only). Injected before the app loads.
// window.__KINDS__ (command -> "array" | "object" | …) is set by shoot.mjs.
(() => {
  const hex = (n) => n.toString(16).padStart(32, "0");
  const shows = ["Bluey", "Nijntje", "The Office", "Severance", "Planet Earth", "Peppa Pig", "Gomorra", "Kurzgesagt", "Dark", "Fargo", "Arcane", "Paw Patrol"];
  const movies = ["The Matrix", "Dune", "Inception", "Up", "Coco", "Heat", "Alien", "Arrival", "Her", "Jaws", "Klaus", "Soul"];
  const items = [];
  shows.forEach((n, i) => items.push({ id: hex(i + 1), kind: "series", name: i === 1 ? "Nijntje (2003)" : n, year: 2000 + i, rating: 7.5, genres: ["Animation"], overview: "A show.", hasPoster: i % 4 !== 3, library: hex(900), matched: i % 5 !== 2, seasons: 2 + (i % 3), episodes: 20 + i, runtime: 22, played: i % 2 === 0 }));
  movies.forEach((n, i) => items.push({ id: hex(i + 100), kind: "movie", name: n, year: 1990 + i * 2, rating: 7.1, genres: ["Drama"], overview: "A movie.", hasPoster: i % 5 !== 4, library: hex(901), matched: true, seasons: null, episodes: null, runtime: 90 + i * 5, played: i % 3 === 0 }));
  const card = (it, kind) => ({ id: it.id, kind: kind || it.kind, title: it.name, subtitle: it.kind === "series" ? "S01E02 · Hotel" : String(it.year), artId: it.id, seriesId: it.kind === "series" ? it.id : null, year: it.year, progress: 0.4, played: false, hasPoster: true });
  const health = items.map((it, i) => ({ id: it.id, kind: it.kind, name: it.name, year: it.year, identified: it.matched, poster: it.hasPoster, backdrop: i % 3 !== 0, logo: i % 2 === 0, thumb: i % 4 !== 1, banner: i % 5 === 0, videos: it.kind === "series" ? 24 : 1, noSubs: i % 3, libraryFolder: it.kind === "series" ? (i % 2 ? "TV" : "Kids") : "Movies", path: `/data/${it.kind === "series" ? "TV" : "Movies"}/${it.name}` }));
  const episodes = Array.from({ length: 8 }, (_, i) => ({ Id: hex(500 + i), Name: i === 2 ? "Nijntje - boris is gebroken!" : `Episode title number ${i + 1}`, Type: "Episode", IndexNumber: i === 3 ? undefined : i + 1, ParentIndexNumber: 1, SeriesId: hex(2), SeriesName: "Nijntje", PremiereDate: "2019-03-0" + (i + 1), RunTimeTicks: 13200000000, UserData: { Played: i < 3 }, MediaStreams: i % 2 ? [{ Type: "Subtitle", Language: "eng" }] : [] }));
  const fixtures = {
    status: { connected: true, serverUrl: "http://nas:8096", serverName: "Jellyfin", libraryRoot: "/Volumes/media", subLangs: ["eng", "dut"], titleLang: "en-US", hasTmdb: true, syncWatched: true, userId: hex(7), readOnly: false, movies: movies.length, series: shows.length, lastSync: Math.floor(Date.now() / 1000) - 600, problem: null },
    libraries: [{ id: hex(900), name: "TV", kind: "tvshows", count: 12 }, { id: hex(901), name: "Movies", kind: "movies", count: 12 }, { id: hex(902), name: "Kids", kind: "tvshows", count: 6 }],
    attention: { unmatched: 3, noPoster: 5, noSubtitles: 42 },
    list_items: items,
    library_health: { at: Math.floor(Date.now() / 1000), rows: health },
    home_feed: { resume: items.slice(0, 5).map((i) => card(i, i.kind === "series" ? "episode" : "movie")), nextUp: items.slice(2, 8).map((i) => card(i, "episode")), recent: items.slice(10, 18).map((i) => card(i)), collections: [{ id: hex(800), kind: "collection", title: "Picks of the day", subtitle: "6 titles", artId: hex(800), seriesId: null, year: null, progress: null, played: false, hasPoster: false }] },
    todays_picks: items.slice(0, 8).map((it, i) => ({ id: it.id, artId: it.id, title: it.name, why: ["Unwatched", "Top rated", "Quick movie", "New to you"][i % 4], meta: "2019 · 24 episodes" })),
    collections_list: [{ id: hex(800), kind: "collection", title: "Picks of the day", subtitle: "6 titles", artId: hex(800), seriesId: null, year: null, progress: null, played: false, hasPoster: false }, { id: hex(801), kind: "collection", title: "Pixar", subtitle: "4 titles", artId: hex(801), seriesId: null, year: null, progress: null, played: false, hasPoster: true }],
    collection_items: items.slice(12, 16).map((i) => card(i)),
    item_children: episodes,
    item_details: { item: { Id: hex(2), Name: "Nijntje", Type: "Series", ProductionYear: 2003, Overview: "Miffy and her friends.", Genres: ["Kids"], CommunityRating: 7.2, ProviderIds: { Tmdb: "1" }, ImageTags: { Primary: "x" }, People: [{ Id: hex(600), Name: "Some Actor", Role: "Miffy" }] }, images: [{ ImageType: "Primary" }, { ImageType: "Backdrop", ImageIndex: 0 }], seasons: [{ Id: hex(700), Name: "Season 1", Type: "Season", IndexNumber: 1 }, { Id: hex(701), Name: "Specials", Type: "Season", IndexNumber: 0 }], changes: [], canEdit: true },
    naming_check_last: { at: Math.floor(Date.now() / 1000), rows: items.map((it, i) => ({ id: it.id, kind: it.kind, name: it.name, year: it.year, folder: `TV/${it.name}`, file: null, toRename: i % 3 ? 4 : 0, folders: i % 4 === 0 ? 1 : 0, problems: i % 5 === 0 ? 2 : 0, right: 10, sure: i % 3 === 1, reasons: i % 3 ? ["4 episode names to fix", "Folder “x” should be “X (2019)”"] : [], example: i % 3 ? [`${it.name}.S01E01.1080p.mkv`, `${it.name} - S01E01 - Pilot.mkv`] : null, error: null })) },
    rename_history: [{ batch: "1", at: Math.floor(Date.now() / 1000) - 3600, files: 12, undone: 0, example: "Bluey/Season 01/Bluey - S01E01.mkv" }],
    journal_all: [{ id: 1, at: Math.floor(Date.now() / 1000) - 60, action: "image", target: hex(1) + "|Primary|0", title: "Bluey", undone: false }],
    missing_episodes: { source: "TMDB", have: 20, known: 24, missing: [{ season: 1, episode: 3, title: "Hotel", airDate: "2019-01-01" }, { season: 0, episode: 1, title: "Special", airDate: null }], upcoming: [], specialsMissing: 1 },
    segment_summary: { episodes: 24, intro: 20, credits: 18, recap: 0 },
    segments_overview: { episodes: episodes.map((e) => ({ id: e.Id, name: e.Name, index: e.IndexNumber ?? null, duration: 1320, segments: [{ id: "a", kind: "Intro", start: 5, end: 40 }] })), ffmpeg: "/opt/homebrew/bin/ffmpeg", canWriteSegments: true },
    inbox_list: ["/Users/me/Downloads", []],
    music_source: { folder: null, source: "jellyfin" },
    music_list: Array.from({ length: 10 }, (_, i) => ({ id: hex(300 + i), kind: "album", name: `Album ${i + 1}`, artist: `Artist ${i % 4}`, album: `Album ${i + 1}`, albumId: hex(300 + i), year: 2010 + i, index: null, disc: null, duration: 2400, artId: hex(300 + i), hasArt: true, count: 12, favorite: false })),
    backend_tuning: { rows: [], version: "10.10.3", markersOk: true, lockEdits: false },
    ffmpeg_info: { path: "/opt/homebrew/bin/ffmpeg", version: "7.1" },
    check_update: { current: "0.19.0", latest: "0.19.0", available: false, notes: "" },
    list_users: [{ id: hex(7), name: "me", admin: true }],
    languages: [{ DisplayName: "English", Name: "English", ThreeLetterISOLanguageName: "eng" }, { DisplayName: "Dutch", Name: "Dutch", ThreeLetterISOLanguageName: "dut", ThreeLetterISOLanguageNames: ["nld"] }],
    list_folders: [{ name: "Kids" }, { name: "Movies" }, { name: "TV" }, { name: "YouTube" }],
    tag_stats: [{ kind: "genre", name: "Animation", count: 12 }, { kind: "tag", name: "kids", count: 4 }],
    storage_overview: [],
    trash_info: { files: 0, bytes: 0 },
    plugins_installed: [{ name: "Intro Skipper", version: "1.0", status: "Active" }, { name: "subbuzz", version: "1.0", status: "Active" }],
    scan_folders: "all",
    missing_language: { TotalRecordCount: 8, Items: episodes.map((e) => ({ ...e, SeriesName: "Nijntje" })) },
    missing_subtitles: { TotalRecordCount: 8, Items: episodes },
  };
  const kinds = window.__KINDS__ || {};
  const fallback = (cmd) => {
    const k = kinds[cmd];
    if (k === "array") return [];
    if (k === "number") return 0;
    if (k === "bool") return false;
    if (k === "string") return "";
    if (k === "object") return {};
    return null;
  };
  let cb = 1;
  const callbacks = {};
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (f) => { const id = cb++; callbacks[id] = f; return id; },
    unregisterCallback: (id) => delete callbacks[id],
    convertFileSrc: (p) => p,
    invoke: async (cmd, args) => {
      window.__CALLS__ = (window.__CALLS__ || []).concat(cmd);
      if (cmd.startsWith("plugin:")) return cmd.includes("listen") ? cb++ : null;
      if (cmd in fixtures) return JSON.parse(JSON.stringify(fixtures[cmd]));
      return fallback(cmd);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
