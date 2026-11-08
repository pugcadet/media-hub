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
    collection_members: { [hex(801)]: ["toy story", "up", "cars", "coco"] },
    collection_items: items.slice(12, 16).map((i) => card(i)),
    item_children: episodes,
    subtitle_peek: () => "/tmp/mediahub/tmp/peek-x-1.srt",
    video_clip: () => fetch("./clip.b64").then((r) => r.text()).catch(() => ""),
    item_details: (a) => a?.id === hex(950) ? { item: { Id: hex(950), Name: "Moana", Type: "Movie", ProductionYear: 2016, RunTimeTicks: 64000000000, Path: "/data/Movies/Moana (2016)/Moana (2016).mkv", ImageTags: { Primary: "x" }, ProviderIds: { Tmdb: "2" } }, images: [{ ImageType: "Primary" }], seasons: [], changes: [], canEdit: true } : { item: { Id: hex(2), Name: "Nijntje", Type: "Series", ProductionYear: 2003, Overview: "Miffy and her friends.", Genres: ["Kids"], CommunityRating: 7.2, ProviderIds: { Tmdb: "1" }, ImageTags: { Primary: "x" }, People: [{ Id: hex(600), Name: "Some Actor", Role: "Miffy" }] }, images: [{ ImageType: "Primary" }, { ImageType: "Backdrop", ImageIndex: 0 }], seasons: [{ Id: hex(700), Name: "Season 1", Type: "Season", IndexNumber: 1 }, { Id: hex(701), Name: "Specials", Type: "Season", IndexNumber: 0 }], changes: [], canEdit: true },
    naming_check_last: { at: Math.floor(Date.now() / 1000), rows: items.map((it, i) => ({ id: it.id, kind: it.kind, name: it.name, year: it.year, folder: `TV/${it.name}`, file: null, toRename: i % 3 ? 4 : 0, folders: i % 4 === 0 && i > 0 ? 1 : 0, problems: i % 5 === 0 ? 2 : 0, right: 10, sure: i % 3 === 1, reasons: i % 3 ? ["4 episode names to fix", "Folder “x” should be “X (2019)”"] : i % 5 === 0 ? ["2 would clash with a file that already exists"] : [], example: i % 3 ? [`${it.name}.S01E01.1080p.mkv`, `${it.name} - S01E01 - Pilot.mkv`] : null, error: null })) },
    rename_history: [{ batch: "1", at: Math.floor(Date.now() / 1000) - 3600, files: 12, undone: 0, example: "Bluey/Season 01/Bluey - S01E01.mkv" }],
    journal_all: [{ id: 1, at: Math.floor(Date.now() / 1000) - 60, action: "image", target: hex(1) + "|Primary|0", title: "Bluey", undone: false }],
    missing_episodes: { source: "TMDB", have: 20, known: 24, missing: [{ season: 1, episode: 3, title: "Hotel", airDate: "2019-01-01" }, { season: 0, episode: 1, title: "Special", airDate: null }], upcoming: [], specialsMissing: 1 },
    segment_summary: { episodes: 24, intro: 20, credits: 18, recap: 0 },
    save_segments: { confirmed: true, message: "Saved and confirmed" },
    segments_overview: { episodes: episodes.map((e, i) => ({ id: e.Id, name: e.Name, index: e.IndexNumber ?? null, duration: 1474, segments: i === episodes.length - 1 ? [{ id: "c" + i, kind: "Outro", start: 0, end: 1474 }] : [{ id: "a" + i, kind: "Intro", start: [120, 175, 308, 283, 160, 276][i % 6], end: [120, 175, 308, 283, 160, 276][i % 6] + 63 }, { id: "b" + i, kind: "Outro", start: 1427, end: 1474 }] })), ffmpeg: "/opt/homebrew/bin/ffmpeg", canWriteSegments: true },
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
    plan_rename: { planId: "p1", ok: 3, unchanged: 1, conflict: 0, unparsed: 0, titlesFound: 24, warning: null, guess: "Nijntje", candidates: [], chosen: { source: "jellyfin", id: hex(2), name: "Nijntje", year: 2003, poster: null, score: 100, ids: {} }, matchedMovies: 0, mode: "tv",
      ops: [1, 2, 3].map((n) => ({ from: `TV/nijntje/S01E0${n}.1080p.WEB.mkv`, to: `TV/Nijntje (2003)/Season 01/Nijntje - S01E0${n} - Title ${n}.mkv`, kind: "video", status: "ok", note: null, season: 1, episodes: [n], verified: true, score: 100, title: `Title ${n}` })).concat([{ from: "TV/nijntje", to: "TV/Nijntje (2003)", kind: "folder", status: "ok", note: null, season: null, episodes: [], verified: true, score: null, title: null }]) },
    movie_folders: [
      { id: hex(100), title: "The Matrix", year: 1999, video: "Movies/The.Matrix.1999.1080p/The.Matrix.1999.1080p.mkv", folder: "Movies/The.Matrix.1999.1080p", top: "Movies", kind: "own", group: null, expected: "The Matrix (1999)", ok: false, collection: null },
      { id: hex(101), title: "Dune", year: 1992, video: "Movies/Dune.1992.mkv", folder: "Movies", top: "Movies", kind: "loose", group: null, expected: "Dune (1992)", ok: false, collection: null },
      { id: hex(106), title: "Alien", year: 2002, video: "Movies/Alien Collection/Alien.1979/Alien.1979.mkv", folder: "Movies/Alien Collection/Alien.1979", top: "Movies", kind: "own", group: "Movies/Alien Collection", expected: "Alien (1979)", ok: false, collection: "Alien Collection" },
      { id: hex(107), title: "Aliens", year: 1986, video: "Movies/Alien Collection/Aliens (1986)/Aliens (1986).mkv", folder: "Movies/Alien Collection/Aliens (1986)", top: "Movies", kind: "own", group: "Movies/Alien Collection", expected: "Aliens (1986)", ok: true, collection: "Alien Collection" },
      { id: hex(103), title: "Up", year: 2009, video: "Movies/Pixar/Up.mkv", folder: "Movies/Pixar", top: "Movies", kind: "shared", group: "Movies/Pixar", expected: "Up (2009)", ok: false, collection: null },
      { id: hex(104), title: "Coco", year: 2017, video: "Movies/Pixar/Coco.mkv", folder: "Movies/Pixar", top: "Movies", kind: "shared", group: "Movies/Pixar", expected: "Coco (2017)", ok: false, collection: null },
    ],
    server_overview: { name: "Jellyfin", version: "10.10.3", os: "Linux", catalogOk: true, pendingRestart: true, latest: "10.10.7", updateAvailable: true,
      playing: [{ title: "Severance · S02E04", artId: hex(3), user: "You", device: "Infuse · Apple TV", how: "Direct play", transcoding: false, paused: false, progress: 0.62 }, { title: "Bluey · S03E12", artId: hex(4), user: "Kids", device: "Jellyfin Web · iPad", how: "Transcoding: HEVC → H264 (VideoCodec not supported)", transcoding: true, paused: false, progress: 0.18 }],
      watched: [{ title: "Heat", user: "You", date: new Date(Date.now() - 3e6).toISOString() }, { title: "Bluey - S03E11", user: "Kids", date: new Date(Date.now() - 9e6).toISOString() }, { title: "Alien: Romulus", user: "You", date: new Date(Date.now() - 9e7).toISOString() }],
      disks: [{ path: "/data", free: 2.1e12, total: 8e12 }],
      plugins: [{ name: "Intro Skipper", version: "1.10.10.1", status: "Active", update: "1.10.10.5" }, { name: "MediaSegments API", version: "1.0", status: "Active", update: null }, { name: "Open Subtitles", version: "20.0", status: "Malfunctioned", update: null }],
      tasks: [
        { id: "a1", name: "Scan media library", category: "Library", key: "RefreshLibrary", state: "Running", progress: 42, lastStatus: "Completed", lastEnd: new Date(Date.now() - 3600e3).toISOString(), lastError: null },
        { id: "a2", name: "Update plugins", category: "Application", key: "PluginUpdates", state: "Idle", progress: null, lastStatus: "Completed", lastEnd: new Date(Date.now() - 86400e3).toISOString(), lastError: null },
        { id: "a3", name: "Extract chapter images", category: "Library", key: "RefreshChapterImages", state: "Idle", progress: null, lastStatus: "Failed", lastEnd: new Date(Date.now() - 7200e3).toISOString(), lastError: "ffmpeg exited with code 1" },
        { id: "a4", name: "Clean up collections and playlists", category: "Maintenance", key: "CleanCollectionsAndPlaylists", state: "Idle", progress: null, lastStatus: "Completed", lastEnd: new Date(Date.now() - 86400e3).toISOString(), lastError: null },
      ],
      events: [{ name: "Severance S02E04 added", overview: "", severity: "Information", date: new Date(Date.now() - 600e3).toISOString() }, { name: "Subtitle download failed", overview: "Open Subtitles: daily limit reached", severity: "Error", date: new Date(Date.now() - 1800e3).toISOString() }] },
    picks_leftovers: 1,
    inbox_scan: ["/Users/me/Downloads", [
      { key: "Severance.S02E05.1080p.WEB.h264-ETHEL.mkv", isFolder: false, size: 2.1e9, modified: Math.floor(Date.now() / 1000) - 600, kind: "tv", title: "Severance", year: null, files: [{ rel: "Severance.S02E05.1080p.WEB.h264-ETHEL.mkv", size: 2.1e9, video: true, season: 2, episodes: [5] }], music: null },
      { key: "Police Academy - The Complete Collection (1984-1994) 1080p", isFolder: true, size: 30e9, modified: Math.floor(Date.now() / 1000) - 1800, kind: "pack", title: "Police Academy Collection", year: null, files: [1, 2, 3].map((n) => ({ rel: `Police Academy ${n} (${1983 + n})/Police.Academy.${n}.mkv`, size: 10e9, video: true, season: null, episodes: [] })), music: null },
      { key: "Dune.Part.Two.2024.2160p", isFolder: true, size: 18e9, modified: Math.floor(Date.now() / 1000) - 3600, kind: "movie", title: "Dune Part Two", year: 2024, files: [{ rel: "Dune.Part.Two.2024.2160p/Dune.Part.Two.2024.2160p.mkv", size: 18e9, video: true, season: null, episodes: [] }, { rel: "Dune.Part.Two.2024.2160p/Dune.Part.Two.2024.2160p.srt", size: 9e4, video: false, season: null, episodes: [] }], music: null },
      { key: "Drake feat. Rihanna - Take Care", isFolder: true, size: 9e7, modified: Math.floor(Date.now() / 1000) - 7200, kind: "music", title: "Take Care", year: 2011, files: [], music: { artist: "Drake", album: "Take Care", year: 2011 } },
    ]],
    structure_scan: [
      { folder: "Movies", kind: "movies", shows: [], looseMovies: ["Dune.1992.mkv"], folderedMovies: ["The Matrix (1999)"] },
      { folder: "TV", kind: "tv", shows: [{ folder: "TV/Bluey", name: "Bluey", loose: 12, seasons: 0 }], looseMovies: [], folderedMovies: [] },
      { folder: "YouTube", kind: "tv", shows: [], looseMovies: [], folderedMovies: [] },
    ],
    inbox_compare: (a) => a?.key?.startsWith("Dune") ? [{ from: "Dune.Part.Two.2024.2160p/Dune.Part.Two.2024.2160p.mkv", old: "Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv", newQuality: "4K HDR · 18.0 GB", oldQuality: "1080p · 6.2 GB", better: true }]
      : a?.key?.startsWith("Police") ? [{ from: "Police Academy 1 (1984)/Police.Academy.1.mkv", old: "Movies/Police Academy Collection/Police Academy (1984)/Police Academy (1984).mkv", newQuality: "1080p · 10.0 GB", oldQuality: "1080p · 9.1 GB", better: false }] : [],
    inbox_resolve: (a) => a?.target?.kind === "movie" ? { movies: [], folder: "Movies/Dune Part Two (2024)", existing: true, moves: [{ from: "Dune.Part.Two.2024.2160p/Dune.Part.Two.2024.2160p.mkv", to: "Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv", have: true }, { from: "Dune.Part.Two.2024.2160p/Dune.Part.Two.2024.2160p.srt", to: "Movies/Dune Part Two (2024)/Dune Part Two (2024).srt", have: true }], leftovers: [], note: "You already have this movie.", collection: null }
      : a?.target?.kind === "pack" ? { folder: "Movies/Police Academy Collection", existing: true, moves: [
      { from: "Police Academy 1 (1984)/Police.Academy.1.mkv", to: "Movies/Police Academy Collection/Police Academy (1984)/Police Academy (1984).mkv", have: true },
      { from: "Police Academy 2 (1985)/Police.Academy.2.mkv", to: "Movies/Police Academy Collection/Police Academy 2: Their First Assignment (1985)/Police Academy 2: Their First Assignment (1985).mkv", have: false },
      { from: "Police Academy 2 (1985)/Subs/English.srt", to: "Movies/Police Academy Collection/Police Academy 2: Their First Assignment (1985)/Police Academy 2: Their First Assignment (1985).eng.srt", have: false },
      { from: "Police Academy 3 (1986)/Police.Academy.3.mkv", to: "Movies/Police Academy Collection/Police Academy 3: Back in Training (1986)/Police Academy 3: Back in Training (1986).mkv", have: false }],
      leftovers: ["Police Academy 2 (1985)/Subs/French.srt", "RARBG.txt"], note: "3 movies in this download: 1 you already have (those copies go to the Trash with the download); the 2 new go into your folder “Police Academy Collection”, each in its own folder and join “Police Academy Collection” in Jellyfin.",
      collection: { name: "Police Academy Collection", id: "c1", folder: "Movies/Police Academy Collection" },
      movies: [["Movies/Police Academy Collection/Police Academy (1984)", "Police Academy", false], ["Movies/Police Academy Collection/Police Academy 2: Their First Assignment (1985)", "Police Academy 2: Their First Assignment", true], ["Movies/Police Academy Collection/Police Academy 3: Back in Training (1986)", "Police Academy 3: Back in Training", true]] } : { movies: [], folder: "TV/Severance (2022)", existing: true, moves: [{ from: "Severance.S02E05.1080p.WEB.h264-ETHEL.mkv", to: "TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.mkv", have: false }, { from: "Subs/2_English.srt", to: "TV/Severance (2022)/Season 02/Severance - S02E05 - Trojan's Horse.eng.srt", have: false }], leftovers: ["Sample/sample.mkv", "Subs/3_French.srt", "Subs/4_Dutch.srt", "RARBG.txt", "poster.jpg", "Severance.S02E05.nfo"], note: "Into your folder “Severance (2022)”.", collection: null },
    inbox_list: ["/Users/me/Downloads", [{}, {}, {}]],
    subtitle_options: { file: "Severance (2022) - S02E04.mkv", current: [{ index: 3, language: "eng", title: "", external: true, forced: false, path: "/data/TV/Severance (2022)/Season 02/Severance (2022) - S02E04.eng.srt" }],
      results: [{ sub: { Id: "s1", Name: "Severance.S02E04.1080p.WEB.h264-ETHEL", ProviderName: "Open Subtitles", DownloadCount: 18402, Format: "srt" }, score: 100, reasons: ["matches your file"] }, { sub: { Id: "s2", Name: "Severance.2x04.WEBRip", ProviderName: "subbuzz", DownloadCount: 9113, Format: "srt" }, score: 82, reasons: [] }] },
    local_subtitles: [{ name: "Severance (2022) - S02E04.eng.srt", path: "/data/TV/Severance (2022)/Season 02/Severance (2022) - S02E04.eng.srt", lang: "eng", linked: true }, { name: "Severance (2022) - S02E04.en.2.srt", path: "/data/TV/Severance (2022)/Season 02/Severance (2022) - S02E04.en.2.srt", lang: "eng", linked: true }],
    subtitle_preview: { duration: 2900, file: "Severance (2022) - S02E04.eng.srt", spots: [45, 761, 1450, 2461], lines: Array.from({ length: 960 }, (_, i) => ({ s: i * 3, e: i % 2 ? i * 3 + 900 : i * 3 + 2.5, t: `Line ${i + 1} at ${Math.floor(i * 3 / 60)}:${String((i * 3) % 60).padStart(2, "0")}` })) },
    music_artist_merges: [{ from: "Drake feat. Rihanna", to: "Drake", albums: ["Take Care"] }],
    missing_language: { TotalRecordCount: 8, Items: episodes.map((e) => ({ ...e, SeriesName: "Nijntje" })) },
    missing_subtitles: { TotalRecordCount: 8, Items: episodes },
    server_update_plugins: ["Intro Skipper 1.10.10.5"],
    collections_remove_empty: 1,
    music_album_files: Array.from({ length: 10 }, (_, i) => [hex(300 + i), `/Volumes/media/Music/Album/${String(i + 1).padStart(2, "0")} Song.flac`]),
    music_tags_apply: 10,
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
      if (cmd in fixtures) return JSON.parse(JSON.stringify(typeof fixtures[cmd] === "function" ? await fixtures[cmd](args) : fixtures[cmd]));
      return fallback(cmd);
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
})();
