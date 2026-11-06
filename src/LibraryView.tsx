// The Library: every show and movie, per NAS folder, with what's right and what still
// needs work (names, match, artwork, subtitles, intros). The main place to fix things:
// pick a title on the left and its page opens on the right, or switch to tiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageState } from "./saved";
import { applyArt, askArt } from "./ArtPicker";
import { api, titleYear, Card, CheckRow, Details, errorText, HealthRow, imageUrl, SegSummary, Status } from "./api";
import { followEvent, onItemsChanged, track, useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { artSkipped, fixTitles, FixKind, targetOf } from "./fixers";
import { askFixes } from "./FixDialog";
import { Studio, StudioItem } from "./Studio";
import ItemPage from "./ItemPage";
import { askChoice, Icon, type IconName, Img, itemMenu, openMenu, reloadData, type MenuItem } from "./ui";
import { askIdentify } from "./IdentifyDialog";
import { namingLeftAlone, prefs, setPrefs, usePrefs } from "./prefs";
import { folderTabs, KTabs, SearchBox, Seg, StatusIcons } from "./kit";
import MusicManage from "./MusicManage";
import { TITLE_ART, titleState, type Check } from "./checks";

/** The library steps, in the order they're best done. */
export const CHECKS: { id: Check; label: string; icon: IconName; hint: string }[] = [
  { id: "identified", label: "Identify", icon: "search", hint: "Matched to TMDB or TVDB" },
  { id: "artwork", label: "Artwork", icon: "image", hint: "Poster, background, logo and thumbnail" },
  { id: "naming", label: "Naming", icon: "rename", hint: "File and folder names the way Infuse and Jellyfin want them" },
  { id: "subtitles", label: "Subtitles", icon: "subtitles", hint: "Subtitles in your languages" },
  { id: "intros", label: "Intros", icon: "skip", hint: "Skip markers for shows (Skip intro in Infuse and Jellyfin)" },
];
type Sort = "name" | "year" | "added" | "todo";
const SORTS: { id: Sort; label: string }[] = [{ id: "name", label: "A–Z" }, { id: "year", label: "Year" }, { id: "added", label: "Recently added" }, { id: "todo", label: "Needs most work" }];
/** "The Matrix" files under M, "A Bug's Life" under B, digits under #. */
export function letterOf(name: string): string {
  const n = name.replace(/^(the|a|an)\s+/i, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const c = n.charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}
const sortName = (name: string) => name.replace(/^(the|a|an)\s+/i, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
/** Home's blocks link here with these names. */
const FLAG: Record<string, Check> = { names: "naming", naming: "naming", identified: "identified", unmatched: "identified", artwork: "artwork", noposter: "artwork", subtitles: "subtitles", intros: "intros" };

interface Row extends HealthRow {
  check: CheckRow | null;
  seg: SegSummary | null;
}

const state = (r: Row, c: Check): boolean | null => titleState(r, c);
const ART = TITLE_ART;

const clean = (id: string) => id.replace(/-/g, "").toLowerCase();

export default function LibraryView({ status: st, route }: { status: Status; route: Route }) {
  const epoch = useEpoch();
  const { libraryView, tileSize } = usePrefs();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = usePageState<string>("library.folder", route.view === "collections" ? "@collections" : "@all");
  const [filter, setFilter] = usePageState<"todo" | "all" | "ok">("library.filter", "all");
  const [only, setOnly] = usePageState<Check | "">("library.only", "");
  const [query, setQuery] = usePageState("library.query", "");
  const [sort, setSort] = usePageState<Sort>("library.sort", "name");
  const [sel, setSel] = usePageState<string | null>("library.sel", null);
  const [checking, setChecking] = useState(false);
  const canEdit = !st.readOnly;

  // Arriving from Home ("12 without artwork"): show just those.
  useEffect(() => {
    const f = route.flag ? FLAG[route.flag] : undefined;
    if (f) {
      setOnly(f);
      setFilter("all");
      setFolder("@all");
    }
    if (route.view === "collections") setFolder("@collections");
    if (route.collection) nav.open(route.collection);
  }, [route.flag, route.view, route.n, route.collection]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async (fresh: boolean) => {
    try {
      const nc = await api.namingCheckLast().catch(() => null);
      const byId = new Map((nc?.rows ?? []).map((r) => [clean(r.id), r]));
      const h = fresh
        ? await track("Checking the whole library", async (job) => {
            setChecking(true);
            const un = await followEvent(job, "health-progress");
            try {
              return await api.libraryHealth(true);
            } finally {
              un();
              setChecking(false);
            }
          }, { reload: false, stop: "health" })
        : await api.libraryHealth(false);
      const seg = await api.segmentCoverage(h.rows.filter((r) => r.kind === "series").map((r) => r.id), false).catch(() => ({} as Record<string, SegSummary>));
      setRows(h.rows.map((r) => ({ ...r, check: byId.get(clean(r.id)) ?? null, seg: seg[clean(r.id)] ?? null })));
      // Titles renamed since their naming check (Inbox, Identify, Folders …): checked again quietly.
      const stale = (nc?.rows ?? []).filter((x) => x.stale && !namingLeftAlone(x)).map((x) => x.id);
      if (stale.length) {
        void import("./Renamer").then((m) => {
          const args = m.namingArgs();
          return api.namingCheck(args[0], args[1], stale.slice(0, 40), args[2], args[3]);
        }).then((res) => {
          const fresh = new Map(res.rows.map((x) => [clean(x.id), x]));
          setRows((rs) => rs?.map((x) => (fresh.has(clean(x.id)) ? { ...x, check: fresh.get(clean(x.id)) ?? x.check } : x)) ?? null);
        }).catch(() => undefined);
      }
      if (!fresh && Date.now() / 1000 - h.at > 86_400) void load(true);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => void load(false), [epoch, load]);

  // A title changed (artwork, match, subtitles …): read just that row again.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => onItemsChanged((ids) => {
    const known = new Set((rowsRef.current ?? []).map((r) => clean(r.id)));
    for (const id of ids.filter((i) => known.has(i))) {
      void api.healthRow(id).then((r) => {
        if (!r) return;
        void api.segmentSummary(r.id).catch(() => null).then((seg) => {
          setRows((rs) => rs?.map((x) => (clean(x.id) === clean(r.id) ? { ...x, ...r, seg: r.kind === "series" ? seg ?? x.seg : null } : x)) ?? null);
        });
      }).catch(() => undefined);
    }
  }), []);

  const folders = useMemo(() => [...new Set((rows ?? []).map((r) => r.libraryFolder).filter(Boolean))].sort(), [rows]);
  const inFolder = (rows ?? []).filter((r) => folder === "@all" || folder === "@collections" || r.libraryFolder === folder);
  const score = (r: Row) => {
    const s = CHECKS.map((c) => state(r, c.id)).filter((x) => x !== null) as boolean[];
    return s.length ? s.filter(Boolean).length / s.length : 1;
  };
  const gaps = (c: Check) => inFolder.filter((r) => state(r, c) === false).length;
  // The title you are working on stays in the list until you pick another one, even when it
  // no longer matches the filter (because you just fixed it).
  const stick = (r: Row) => r.id === sel;
  const shown = inFolder
    .filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()))
    .filter((r) => !only || state(r, only) === false || stick(r))
    .filter((r) => (filter === "all" ? true : filter === "ok" ? score(r) === 1 || stick(r) : score(r) < 1 || stick(r)))
    .sort((a, b) =>
      (sort === "todo" ? score(a) - score(b) : sort === "year" ? (b.year ?? 0) - (a.year ?? 0) : sort === "added" ? (b.added ?? "").localeCompare(a.added ?? "") : 0)
      || sortName(a.name).localeCompare(sortName(b.name)));
  const perfect = inFolder.filter((r) => score(r) === 1).length;
  const unknownSeg = (rows ?? []).filter((r) => r.kind === "series" && !r.seg).length;

  async function readIntros() {
    const ids = (rows ?? []).filter((r) => r.kind === "series").map((r) => r.id);
    await track("Reading intro and credits markers", async (job) => {
      const un = await followEvent(job, "health-progress");
      try {
        const seg = await api.segmentCoverage(ids, true);
        setRows((rs) => rs?.map((r) => ({ ...r, seg: seg[clean(r.id)] ?? r.seg })) ?? null);
      } finally {
        un();
      }
    }, { reload: false, stop: "health" }).catch(() => undefined);
  }

  async function fixAll() {
    const list = shown.filter((r) => score(r) < 1);
    if (!list.length) return;
    const what: FixKind[] = ["identify", "art", "subs", "rename"];
    const plan = await askFixes("Fix what's safe", list.map((r) => targetOf(r, r.check)), what);
    if (!plan) return;
    await track(`Fixing ${plan.list.length} titles`, (job) => fixTitles(plan.list, plan.what, st.subLangs, job).then(() => undefined), { cancellable: true, items: plan.list.map((t) => t.id) }).catch(() => undefined);
  }

  /** A dot in the list: click it to fix that thing right there. */
  function fixDot(r: Row, c: Check) {
    if (c === "identified") return void askIdentify(r.id, r.name, r.year, r.kind);
    if (c === "naming") return nav.route({ view: "renamer", item: r.id });
    if (c === "subtitles") return nav.open(r.id, { tab: "subs" });
    if (c === "intros") return nav.open(r.id, { tab: "intros" });
    const missing = ART.filter((a) => !r[a.key] && !artSkipped(r.id).includes(a.kind)).map((a) => a.kind) as ("Primary" | "Backdrop" | "Logo" | "Thumb")[];
    if (!canEdit || !missing.length) return nav.open(r.id, { tab: "art" });
    void askArt(r.id, r.name, missing).then((choice) => choice && track(`Artwork for ${r.name}`, async (job) => {
      const n = await applyArt(r.id, choice);
      job.update(n ? "Added" : "Skipped", 1);
    }, { items: [r.id] }).catch(() => undefined));
  }

  // A tab you click starts at its first title; a list that updates by itself (after new
  // artwork, a rename …) keeps the title you had selected.
  const lastFolder = useRef(folder);
  useEffect(() => {
    if (libraryView !== "list" || folder.startsWith("@c") || folder === "@music" || !shown.length) return;
    const switched = lastFolder.current !== folder;
    lastFolder.current = folder;
    if (switched || !sel || !shown.some((r) => r.id === sel)) setSel(shown[0].id);
  }, [libraryView, folder, shown.length, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The open title's page loaded fresh details: update its dots right away. */
  const patchFrom = (d: Details) => {
    const has = (k: string) => d.images.some((i) => i.ImageType === k);
    const ids = d.item.ProviderIds ?? {};
    setRows((rs) => rs?.map((x) => (clean(x.id) === clean(d.item.Id)
      ? { ...x, name: d.item.Name, identified: !!(ids.Tmdb || ids.Tvdb), poster: has("Primary"), backdrop: has("Backdrop"), logo: has("Logo"), thumb: has("Thumb"), banner: has("Banner") }
      : x)) ?? null);
  };

  // Same icons and order as the filter buttons above; movies keep an empty place for intros
  // so the icons line up in columns.
  const statusOf = (r: Row) => (
    <StatusIcons items={CHECKS.map((c) => ({ icon: c.icon, label: c.label, ok: c.id === "intros" && r.kind !== "series" ? null : state(r, c.id), onClick: canEdit || c.id !== "artwork" ? () => fixDot(r, c.id) : undefined }))} />
  );
  const sub = (r: Row) => `${r.kind === "series" ? `Show · ${r.videos} episodes` : "Movie"}${folder === "@all" && r.libraryFolder ? ` · ${r.libraryFolder}` : ""}`;

  const tabs = (
    <KTabs
      folders
      active={folder}
      onChange={setFolder}
      tabs={[
        ...folderTabs(folders, (f) => (f === null ? rows?.length ?? null : (rows ?? []).filter((r) => r.libraryFolder === f).length)),
        { id: "@collections", label: "Collections", icon: "heart" },
        { id: "@music", label: "Music", icon: "music" },
      ]}
    />
  );
  /** The whole-library tools, by step, so nothing needs its own page in the menu. */
  const toolsMenu = (): MenuItem[] => [
    { label: "Naming", disabled: true },
    { label: "Rename a whole folder…", run: () => nav.route({ view: "renamer" }) },
    { label: "Tidy folders (seasons, loose movies)…", run: () => nav.route({ view: "renamer", section: "folders" }) },
    { label: "Names and years…", run: () => nav.route({ view: "cleanup", section: "names" }) },
    { sep: true },
    { label: "Subtitles", disabled: true },
    { label: "Subtitles for many titles…", run: () => nav.route({ view: "subtitles" }) },
    { sep: true },
    { label: "Intros", disabled: true },
    { label: "Intros and credits for many shows…", run: () => nav.route({ view: "intros" }) },
    { sep: true },
    { label: "Clean-up", disabled: true },
    { label: "Duplicates…", run: () => nav.route({ view: "cleanup", section: "duplicates" }) },
    { label: "Missing episodes…", run: () => nav.route({ view: "cleanup", section: "missing" }) },
    { label: "Big files and storage…", run: () => nav.route({ view: "cleanup", section: "storage" }) },
    { label: "Episodes without a picture…", run: () => nav.route({ view: "cleanup", section: "pictures" }) },
    { label: "Genres and tags…", run: () => nav.route({ view: "tags" }) },
  ];
  const viewToggle = <Seg icons value={libraryView} onChange={(v) => setPrefs({ libraryView: v })} options={[{ id: "list", label: "List", title: "List", icon: "list" }, { id: "tiles", label: "Grid", title: "Grid", icon: "grid" }]} />;
  const todoCount = shown.filter((r) => score(r) < 1).length;
  const barTop = (
    <div className="lib-bar-row">
      {tabs}
      <span className="spacer" />
      {folder !== "@music" && folder !== "@collections" && (
        <>
          <span className="muted small lib-summary">{checking ? "Checking…" : rows ? `${perfect} of ${inFolder.length} complete` : ""}</span>
          <button onClick={(e) => openMenu(e, toolsMenu())} title="Whole-library tools">More tools <Icon name="chevron" size={12} /></button>
          <button disabled={checking} onClick={() => void reloadData().then(() => load(true)).catch(() => undefined)} title="Reads the library again from Jellyfin and your folders">{checking ? <span className="spinner small-spin" /> : <Icon name="reload" />} Refresh</button>
          <button className="primary" disabled={!canEdit || !rows || !todoCount} onClick={() => void fixAll()} title="Identifies exact matches, adds missing artwork and subtitles, and renames what's certain. Everything can be undone in History."><Icon name="wand" /> Fix what's safe ({todoCount})</button>
        </>
      )}
    </div>
  );

  if (folder === "@music") {
    return (
      <div className="pg lib-page lib2">
        <div className="lib-bar">{barTop}</div>
        <div className="lib-body pad">
          <MusicManage embedded onChanged={() => undefined} />
        </div>
      </div>
    );
  }

  if (folder === "@collections") {
    return (
      <div className="pg lib-page lib2">
        <CollectionsView canEdit={canEdit} top={barTop} view={libraryView} toggle={viewToggle} />
      </div>
    );
  }

  const filters = (
    <div className="lib-bar-row">
      <div className="lib-checks">
        {CHECKS.map((c, i) => {
          const n = gaps(c.id);
          const unread = c.id === "intros" && unknownSeg > 0;
          return (
            <button key={c.id} className={`lib-check ${only === c.id ? "on" : ""} ${n ? "warn" : "ok"}`} aria-pressed={only === c.id}
              title={unread ? "Skip markers not read yet: click to read them, then filter" : `${c.hint}. Click to show only the titles that still need this.`}
              onClick={() => { if (unread) void readIntros().then(() => setOnly(c.id)); else setOnly(only === c.id ? "" : c.id); }}>
              <span className="lib-check-n">{i + 1}</span>{c.label} <span className="count">{unread ? "?" : n ? n : <Icon name="check" size={12} />}</span>
            </button>
          );
        })}
        {only && <button className="link small" onClick={() => setOnly("")}><Icon name="x" size={12} /> Show all</button>}
      </div>
      <span className="spacer" />
      <SearchBox value={query} onChange={setQuery} placeholder="Find a title" />
      <Seg value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "todo", label: "Needs work" }, { id: "ok", label: "Complete" }]} />
      <label className="lib-sort">Sort
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          {SORTS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      {viewToggle}
    </div>
  );
  const bar = <div className="lib-bar">{barTop}{filters}</div>;

  /** Right-click: the usual menu plus switching checks off for titles that don't need them. */
  const rowMenu = (r: Row): MenuItem[] => {
    const off = prefs().checksOff[clean(r.id)] ?? [];
    const toggle = (c: Check) => setPrefs((p) => {
      const cur = p.checksOff[clean(r.id)] ?? [];
      return { checksOff: { ...p.checksOff, [clean(r.id)]: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] } };
    });
    return [
      ...itemMenu({ id: r.id, kind: r.kind, title: r.name }, canEdit),
      { sep: true },
      { label: off.includes("subtitles") ? "Needs subtitles again" : "Doesn't need subtitles", run: () => toggle("subtitles") },
      ...(r.kind === "series" ? [{ label: off.includes("intros") ? "Needs intro markers again" : "Doesn't need intro markers", run: () => toggle("intros") }] : []),
    ];
  };

  if (libraryView === "tiles") {
    return (
      <div className="pg lib-page lib2">
        {bar}
        <LibraryGrid rows={shown} loading={!rows && !error} error={error} grouped={sort === "name"} tileSize={tileSize}
          empty={only ? "Nothing left to do here." : "Nothing here."} onMenu={(r, e) => openMenu(e, rowMenu(r))} />
      </div>
    );
  }

  const items: StudioItem[] = shown.map((r) => ({
    id: r.id,
    title: titleYear(r.name, r.year),
    sub: sub(r),
    thumb: imageUrl(r.id, "Primary", 80),
    status: statusOf(r),
    warn: state(r, "artwork") === false,
  }));
  return (
    <div className="pg studio-page lib-page lib2">
      {bar}
      {error && <p className="error">{error}</p>}
      <div className="lib-body">
        <Studio
          items={items}
          selected={sel}
          onSelect={setSel}
          onOpen={(id) => nav.open(id)}
          onMenu={(id, e) => { const r = shown.find((x) => x.id === id); if (r) openMenu(e, rowMenu(r)); }}
          empty={!rows ? <span><span className="spinner" /> Reading the library…</span> : only ? "Nothing left to do here." : "Nothing here."}
        >
          {sel && (
            <ItemPage key={sel} id={sel} embedded onBack={() => undefined} onOpen={(i) => nav.open(i)} onNav={(v) => nav.route({ view: v })}
              subLangs={st.subLangs} titleLang={st.titleLang} status={st} onLoaded={patchFrom} />
          )}
        </Studio>
      </div>
    </div>
  );
}

/** The five steps as dots: green done, orange to do, grey doesn't apply. */
function Dots({ r }: { r: Row }) {
  return (
    <span className="tile-dots" aria-label={CHECKS.map((c) => `${c.label}: ${dotState(r, c.id)}`).join(", ")}>
      {CHECKS.map((c) => { const d = dotState(r, c.id); return <span key={c.id} className={`tile-dot ${d === "done" ? "done" : d === "to do" ? "todo" : "na"}`} title={`${c.label}: ${d}`} />; })}
    </span>
  );
}
function dotState(r: Row, c: Check): "done" | "to do" | "doesn't apply" {
  if (c === "intros" && r.kind !== "series") return "doesn't apply";
  const v = state(r, c);
  return v === null ? "doesn't apply" : v ? "done" : "to do";
}

/** Posters with the five dots, in letter groups with an A–Z rail on the right. */
function LibraryGrid({ rows, loading, error, grouped, tileSize, empty, onMenu }: {
  rows: Row[]; loading: boolean; error: string | null; grouped: boolean; tileSize: number; empty: string; onMenu: (r: Row, e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState("");
  const groups = useMemo(() => {
    if (!grouped) return [{ letter: "", rows: rows.slice(0, 1500) }];
    const m = new Map<string, Row[]>();
    for (const r of rows.slice(0, 3000)) {
      const l = letterOf(r.name);
      m.set(l, [...(m.get(l) ?? []), r]);
    }
    return LETTERS.filter((l) => m.has(l)).map((l) => ({ letter: l, rows: m.get(l)! }));
  }, [rows, grouped]);
  const have = new Set(groups.map((g) => g.letter));
  const jump = (l: string) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-letter="${l}"]`);
    if (el && ref.current) ref.current.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
  };
  const onScroll = () => {
    const box = ref.current;
    if (!box || !grouped) return;
    let cur = "";
    for (const h of box.querySelectorAll<HTMLElement>("[data-letter]")) if (h.offsetTop - box.scrollTop <= 40) cur = h.dataset.letter ?? "";
    setAt(cur);
  };
  return (
    <div className="lib-body lib-gridwrap">
      <div className="lib-gridscroll" ref={ref} onScroll={onScroll}>
        {error && <p className="error">{error}</p>}
        {loading && <div className="lib-grid" style={{ ["--tile" as string]: `${tileSize}px` }}>{Array.from({ length: 18 }, (_, i) => <div key={i} className="skeleton tile" />)}</div>}
        {!loading && rows.length === 0 && <p className="muted">{empty}</p>}
        {groups.map((g) => (
          <section key={g.letter || "all"} className="lib-letter">
            {g.letter && <div className="lib-letter-head" data-letter={g.letter}><b>{g.letter}</b><span className="muted small">{g.rows.length} title{g.rows.length === 1 ? "" : "s"}</span></div>}
            <div className="lib-grid" style={{ ["--tile" as string]: `${tileSize}px` }}>
              {g.rows.map((r) => (
                <button key={r.id} className="lib-tile" onClick={() => nav.open(r.id)} onContextMenu={(e) => onMenu(r, e)} title={titleYear(r.name, r.year)}>
                  <span className="lib-tile-art">
                    <Img src={imageUrl(r.id, "Primary", 480)} alt="" />
                    {!r.poster && <span className="lib-tile-name">{r.name}</span>}
                    <Dots r={r} />
                  </span>
                  <span className="lib-tile-title ellipsis">{r.name}</span>
                  <span className="lib-tile-year muted small">{r.year ?? ""}{r.kind === "series" ? `${r.year ? " · " : ""}${r.videos} episodes` : ""}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      {grouped && rows.length > 0 && (
        <nav className="az-rail2" aria-label="Jump to letter">
          {LETTERS.map((l) => (
            <button key={l} className={`${at === l ? "on" : ""}`} disabled={!have.has(l)} onClick={() => jump(l)}>{l}</button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** Collections: find one by its name or by a movie in it; list or grid. */
function CollectionsView({ canEdit, top, view, toggle }: { canEdit: boolean; top: React.ReactNode; view: "list" | "tiles"; toggle: React.ReactNode }) {
  const epoch = useEpoch();
  const [list, setList] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = usePageState("collections.query", "");
  const [members, setMembers] = useState<Record<string, string[]>>({});
  const [reading, setReading] = useState(false);
  useEffect(() => {
    api.collections().then(setList).catch((e) => setError(errorText(e)));
  }, [epoch]);
  // Searching for a movie: read what's in each collection once (a few at a time).
  useEffect(() => {
    if (!query.trim() || !list || reading) return;
    const todo = list.filter((c) => !(c.id in members));
    if (!todo.length) return;
    setReading(true);
    void (async () => {
      const got: Record<string, string[]> = {};
      for (let i = 0; i < todo.length; i += 6) {
        await Promise.all(todo.slice(i, i + 6).map((c) => api.collectionItems(c.id).then((l) => { got[c.id] = l.map((x) => x.title.toLowerCase()); }).catch(() => { got[c.id] = []; })));
        setMembers((m) => ({ ...m, ...got }));
      }
      setReading(false);
    })();
  }, [query, list]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    const r = await askChoice("New collection", [], { label: "Name", placeholder: "e.g. Pixar, Christmas, Marvel", okLabel: "Create" });
    if (r && "text" in r && r.text.trim()) {
      const id = await track(`Creating “${r.text}”`, () => api.collectionCreate(r.text.trim(), []));
      nav.open(id);
    }
  }
  const noArt = (list ?? []).filter((c) => !c.hasPoster);
  async function fillArt() {
    await track(`Artwork for ${noArt.length} collection${noArt.length === 1 ? "" : "s"}`, async (job) => {
      let n = 0;
      for (const [i, c] of noArt.entries()) {
        if (job.cancelled) break;
        job.update(c.title, i / noArt.length);
        n += (await api.fillMissingArt(c.id, ["Primary", "Backdrop", "Logo", "Thumb"]).catch(() => [])).length;
      }
      job.update(`${n} picture${n === 1 ? "" : "s"} added`, 1);
    }, { cancellable: true, items: noArt.map((c) => c.id) }).catch(() => undefined);
  }
  const q = query.trim().toLowerCase();
  const hit = (c: Card): string | null => {
    if (!q) return "";
    if (c.title.toLowerCase().includes(q)) return "";
    const m = (members[c.id] ?? []).find((t) => t.includes(q));
    return m ? m : null;
  };
  const shown = (list ?? []).map((c) => ({ c, why: hit(c) })).filter((x) => x.why !== null);
  return (
    <>
      <div className="lib-bar">
        {top}
        <div className="lib-bar-row">
          <span className="muted small">{list ? `${list.length} collection${list.length === 1 ? "" : "s"}${noArt.length ? ` · ${noArt.length} without a poster` : ""}` : "Loading…"}</span>
          <span className="spacer" />
          {noArt.length > 0 && <button disabled={!canEdit} onClick={() => void fillArt()}><Icon name="image" /> Fill missing artwork ({noArt.length})</button>}
          <button disabled={!canEdit} onClick={() => void create()}><Icon name="plus" /> New collection</button>
          <SearchBox value={query} onChange={setQuery} placeholder="Find a collection or movie" />
          {toggle}
        </div>
      </div>
      <div className="lib-body pad">
        {error && <p className="error">{error}</p>}
        {reading && q && <p className="muted small"><span className="spinner small-spin" /> Looking inside the collections…</p>}
        {list && list.length === 0 && <p className="muted">No collections yet. Make one here, or use the Collection tab of a movie.</p>}
        {list && list.length > 0 && shown.length === 0 && !reading && <p className="muted">No collection has “{query}” in its name or among its movies.</p>}
        {view === "tiles" ? (
          <div className="lib-grid" style={{ ["--tile" as string]: "160px" }}>
            {shown.map(({ c, why }) => (
              <button key={c.id} className="lib-tile" onClick={() => nav.open(c.id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: c.id, kind: "collection", title: c.title }, canEdit))}>
                <span className={`lib-tile-art ${c.hasPoster ? "" : "warn"}`}>
                  {c.hasPoster && <Img src={imageUrl(c.id, "Primary", 480)} alt="" />}
                  {!c.hasPoster && <span className="lib-tile-name">{c.title}<br /><span className="small warn">No poster: click to add</span></span>}
                </span>
                <span className="lib-tile-title ellipsis">{c.title}</span>
                <span className="muted small ellipsis">{why ? `Has “${why}”` : c.subtitle}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="coll-list">
            {shown.map(({ c, why }) => (
              <button key={c.id} className="coll-row" onClick={() => nav.open(c.id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: c.id, kind: "collection", title: c.title }, canEdit))}>
                <span className="coll-thumb">{c.hasPoster ? <Img src={imageUrl(c.id, "Primary", 120)} alt="" /> : null}</span>
                <span className="grow stack-xs"><b className="ellipsis">{c.title}</b><span className="muted small ellipsis">{why ? `Has “${why}”` : c.subtitle}</span></span>
                {!c.hasPoster && <span className="warn small">No poster</span>}
                <Icon name="chevron" size={14} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
