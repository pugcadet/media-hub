// The Library: every show and movie, per NAS folder, with what's right and what still
// needs work (names, match, artwork, subtitles, intros). The main place to fix things:
// pick a title on the left and its page opens on the right, or switch to tiles.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePageState } from "./saved";
import { applyArt, askArt } from "./ArtPicker";
import { api, Card, CheckRow, Details, errorText, HealthRow, imageUrl, SegSummary, Status } from "./api";
import { followEvent, onItemsChanged, track, useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { artSkipped, fixTitles, FixKind, noSubsOf, targetOf } from "./fixers";
import { askFixes } from "./FixDialog";
import { Studio, StudioItem } from "./Studio";
import ItemPage from "./ItemPage";
import { askChoice, Icon, type IconName, Img, itemMenu, openMenu, SettingsLink, type MenuItem } from "./ui";
import { askIdentify } from "./IdentifyDialog";
import { prefs, setPrefs, usePrefs } from "./prefs";
import { folderTabs, IconBtn, KTabs, PageHead, SearchBox, Seg, StatusIcons, Toolbar } from "./kit";

type Check = "naming" | "identified" | "artwork" | "subtitles" | "intros";

const CHECKS: { id: Check; label: string; icon: IconName; hint: string }[] = [
  { id: "naming", label: "Naming", icon: "rename", hint: "File and folder names the way Infuse and Jellyfin want them" },
  { id: "identified", label: "Identified", icon: "search", hint: "Matched to TMDB/TVDB" },
  { id: "artwork", label: "Artwork", icon: "image", hint: "Poster, background, logo and thumbnail" },
  { id: "subtitles", label: "Subtitles", icon: "subtitles", hint: "Subtitles in your languages" },
  { id: "intros", label: "Intros", icon: "skip", hint: "Intro markers for shows (skip intro in Infuse)" },
];
/** Home's blocks link here with these names. */
const FLAG: Record<string, Check> = { names: "naming", naming: "naming", identified: "identified", unmatched: "identified", artwork: "artwork", noposter: "artwork", subtitles: "subtitles", intros: "intros" };
const ART: { key: "poster" | "backdrop" | "logo" | "thumb"; kind: string }[] = [
  { key: "poster", kind: "Primary" }, { key: "backdrop", kind: "Backdrop" }, { key: "logo", kind: "Logo" }, { key: "thumb", kind: "Thumb" },
];

interface Row extends HealthRow {
  check: CheckRow | null;
  seg: SegSummary | null;
}

function state(r: Row, c: Check): boolean | null {
  // Checks you switched off for this title (no subtitles or intros needed) count as fine.
  if ((prefs().checksOff[clean(r.id)] ?? []).includes(c)) return null;
  switch (c) {
    case "naming": return r.check ? !r.check.error && r.check.toRename + r.check.folders + r.check.problems === 0 : null;
    case "identified": return r.identified;
    case "artwork": return ART.every((a) => r[a.key] || artSkipped(r.id).includes(a.kind));
    case "subtitles": return noSubsOf(r) === 0;
    case "intros": return r.kind !== "series" ? null : r.seg ? r.seg.episodes === 0 || r.seg.intro >= r.seg.episodes * 0.8 : null;
  }
}

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
  const [sort, setSort] = usePageState<"name" | "todo">("library.sort", "name");
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
    .sort((a, b) => (sort === "todo" ? score(a) - score(b) : 0) || a.name.localeCompare(b.name));
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
    const what: FixKind[] = ["art", "subs", "rename"];
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

  // Selecting in the list keeps the first title selected when nothing is.
  useEffect(() => {
    if (libraryView === "list" && folder !== "@collections" && shown.length && (!sel || !shown.some((r) => r.id === sel))) setSel(shown[0].id);
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
      ]}
    />
  );

  const head = (
    <PageHead
      title="Library"
      sub={<>
        {checking ? "Checking the library…" : rows ? `${perfect} of ${inFolder.length} titles complete.` : "Reading the library…"}
        {folders.length === 0 && rows && <> Folder tabs appear once your library folder is set (<SettingsLink section="library">Settings</SettingsLink>).</>}
      </>}
      actions={<button className="primary" disabled={!canEdit || !rows} onClick={() => void fixAll()}><Icon name="wand" /> Fix what's safe ({shown.filter((r) => score(r) < 1).length})</button>}
    />
  );

  if (folder === "@collections") {
    return (
      <div className="pg lib-page">
        {head}
        {tabs}
        <CollectionsGrid canEdit={canEdit} />
      </div>
    );
  }

  const filters = (
    <div className="lib-filters">
      <div className="lib-checks">
        {CHECKS.map((c) => {
          const n = gaps(c.id);
          const unread = c.id === "intros" && unknownSeg > 0;
          return (
            <button key={c.id} className={`lib-check ${only === c.id ? "on" : ""} ${n ? "warn" : "ok"}`}
              title={unread ? "Intro markers not read yet: click to read them, then filter" : `${c.hint}. Click to show only the titles missing this.`}
              onClick={() => { if (unread) void readIntros().then(() => setOnly(c.id)); else setOnly(only === c.id ? "" : c.id); }}>
              <Icon name={c.icon} size={14} /> {c.label} <span className="count">{unread ? "?" : n ? n : <Icon name="check" size={12} />}</span>
            </button>
          );
        })}
        {only && <button className="link small" onClick={() => setOnly("")}><Icon name="x" size={12} /> Show all</button>}
      </div>
      <Toolbar
        right={<>
          {libraryView === "tiles" && (
            <label className="tile-size" title="Tile size"><Icon name="grid" size={13} /><input type="range" min={110} max={240} step={10} value={tileSize} onChange={(e) => setPrefs({ tileSize: Number(e.target.value) })} /></label>
          )}
          <IconBtn icon="sort" on={sort === "todo"} title={sort === "todo" ? "Sorted: most to fix first (click for A to Z)" : "Sorted A to Z (click for most to fix first)"} onClick={() => setSort(sort === "todo" ? "name" : "todo")} />
        </>}
      >
        <Seg icons value={libraryView} onChange={(v) => setPrefs({ libraryView: v })} options={[{ id: "list", label: "List", title: "List with the title next to it", icon: "list" }, { id: "tiles", label: "Tiles", title: "Tiles", icon: "grid" }]} />
        <SearchBox value={query} onChange={setQuery} placeholder="Find a title" />
        <Seg value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "todo", label: "Needs work" }, { id: "ok", label: "Complete" }]} />
      </Toolbar>
    </div>
  );

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
      <div className="pg lib-page">
        {head}
        {tabs}
        {filters}
        {error && <p className="error">{error}</p>}
        {!rows && !error && <div className="lib-grid" style={{ ["--tile" as string]: `${tileSize}px` }}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton tile" />)}</div>}
        <div className="lib-grid" style={{ ["--tile" as string]: `${tileSize}px` }}>
          {shown.slice(0, 800).map((r) => {
            const warn = state(r, "artwork") === false;
            return (
              <button key={r.id} className="lib-tile" onClick={() => nav.open(r.id)} onContextMenu={(e) => openMenu(e, rowMenu(r))}>
                <span className={`lib-tile-art ${warn ? "warn" : ""}`}>
                  <Img src={imageUrl(r.id, "Primary", 480)} alt="" />
                  {!r.poster && <span className="lib-tile-name">{r.name}</span>}
                </span>
                <span className="lib-tile-title ellipsis">{r.name}{r.year ? <span className="muted"> {r.year}</span> : null}</span>
                {statusOf(r)}
              </button>
            );
          })}
        </div>
        {rows && shown.length === 0 && <p className="muted">{only ? "Nothing missing here." : "Nothing here."}</p>}
      </div>
    );
  }

  const items: StudioItem[] = shown.map((r) => ({
    id: r.id,
    title: `${r.name}${r.year ? ` (${r.year})` : ""}`,
    sub: sub(r),
    thumb: imageUrl(r.id, "Primary", 80),
    status: statusOf(r),
    warn: state(r, "artwork") === false,
  }));
  const selRow = shown.find((r) => r.id === sel) ?? null;
  return (
    <div className="pg studio-page lib-page">
      {head}
      {tabs}
      {filters}
      {error && <p className="error">{error}</p>}
      <Studio
        items={items}
        selected={sel}
        onSelect={setSel}
        onOpen={(id) => nav.open(id)}
        onMenu={(id, e) => { const r = shown.find((x) => x.id === id); if (r) openMenu(e, rowMenu(r)); }}
        empty={!rows ? <span><span className="spinner" /> Reading the library…</span> : only ? "Nothing missing here." : "Nothing here."}
      >
        {sel && (
          <>
            {selRow && (
              <div className="lib-quick">
                {CHECKS.filter((c) => state(selRow, c.id) === false).map((c) => (
                  <button key={c.id} className="hchip warn" onClick={() => fixDot(selRow, c.id)}><Icon name={c.icon} size={12} /> Fix {c.label.toLowerCase()}</button>
                ))}
              </div>
            )}
            <ItemPage key={sel} id={sel} embedded onBack={() => undefined} onOpen={(i) => nav.open(i)} onNav={(v) => nav.route({ view: v })}
              subLangs={st.subLangs} titleLang={st.titleLang} status={st} onLoaded={patchFrom} />
          </>
        )}
      </Studio>
    </div>
  );
}

/** Collections as tiles; one opens as its own page (titles and artwork). */
function CollectionsGrid({ canEdit }: { canEdit: boolean }) {
  const epoch = useEpoch();
  const [list, setList] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.collections().then(setList).catch((e) => setError(errorText(e)));
  }, [epoch]);
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
  return (
    <div className="stack">
      <Toolbar right={<>
        {noArt.length > 0 && <button disabled={!canEdit} onClick={() => void fillArt()}><Icon name="image" /> Fill missing artwork ({noArt.length})</button>}
        <button className="primary" disabled={!canEdit} onClick={() => void create()}><Icon name="plus" /> New collection</button>
      </>}>
        <span className="muted small">{list ? `${list.length} collection${list.length === 1 ? "" : "s"} · they show up in Infuse too${noArt.length ? ` · ${noArt.length} without a poster` : ""}` : "Loading…"}</span>
      </Toolbar>
      {error && <p className="error">{error}</p>}
      {list && list.length === 0 && <p className="muted">No collections yet. Make one here, or use the Collection tab of a movie or show.</p>}
      <div className="lib-grid" style={{ ["--tile" as string]: "160px" }}>
        {(list ?? []).map((c) => (
          <button key={c.id} className="lib-tile" onClick={() => nav.open(c.id)} onContextMenu={(e) => openMenu(e, itemMenu({ id: c.id, kind: "collection", title: c.title }, canEdit))}>
            <span className={`lib-tile-art ${c.hasPoster ? "" : "warn"}`}>
              {c.hasPoster && <Img src={imageUrl(c.id, "Primary", 480)} alt="" />}
              {!c.hasPoster && <span className="lib-tile-name">{c.title}<br /><span className="small warn">No poster: click to add</span></span>}
            </span>
            <span className="lib-tile-title ellipsis">{c.title}</span>
            <span className="muted small">{c.subtitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
