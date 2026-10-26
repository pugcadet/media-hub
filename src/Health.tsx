import { useEffect, useMemo, useRef, useState } from "react";
import { usePageState } from "./saved";
import { applyArt, askArt } from "./ArtPicker";
import { api, CheckRow, Details, errorText, HealthRow, imageUrl, Status } from "./api";
import { followEvent, track, useEpoch } from "./activity";
import { nav } from "./nav";
import { artSkipped, fixTitles, FixKind, noSubsOf, targetOf } from "./fixers";
import { askFixes } from "./FixDialog";
import { Studio, StudioItem } from "./Studio";
import ItemPage from "./ItemPage";
import { CheckMenu, Icon, itemMenu, openMenu, SettingsLink, useUndoableSet } from "./ui";

type Check = "name" | "identified" | "poster" | "backdrop" | "logo" | "thumb" | "banner" | "subs";

const LABEL: Record<Check, string> = {
  name: "Names", identified: "Identified", poster: "Poster", backdrop: "Backdrop", logo: "Logo", thumb: "Thumb", banner: "Banner", subs: "Subtitles",
};
// Banner, clear art and disc pictures are optional: Infuse doesn't show them, so they don't count.
const ART: Check[] = ["poster", "backdrop", "logo", "thumb"];
const KIND_OF: Record<string, string> = { poster: "Primary", backdrop: "Backdrop", logo: "Logo", thumb: "Thumb", banner: "Banner" };

interface Row extends HealthRow {
  check: CheckRow | null;
}

function status(r: Row, c: Check): boolean | null {
  if (KIND_OF[c] && artSkipped(r.id).includes(KIND_OF[c])) return true; // you said: can't be found, fine
  switch (c) {
    case "name": return r.check ? !r.check.error && r.check.toRename + r.check.folders + r.check.problems === 0 : null;
    case "identified": return r.identified;
    case "poster": return r.poster;
    case "backdrop": return r.backdrop;
    case "logo": return r.logo;
    case "thumb": return r.thumb;
    case "banner": return r.banner;
    case "subs": return noSubsOf(r) === 0;
  }
}

/**
 * Library health: every show and movie with a tick or a gap per check. Click a gap to fix
 * it, or let Media Hub fix everything that's safe in one go. With focus "art" it's the
 * Metadata and art screen: identification and pictures only, every title listed.
 */
export default function Health({ status: st, focus }: { status: Status; focus: "all" | "art" }) {
  const epoch = useEpoch();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = usePageState<"todo" | "all" | "ok">(`health.${focus}.filter`, focus === "art" ? "all" : "todo");
  const folderSel = useUndoableSet<string>();
  const seenFolders = useRef<Set<string>>(new Set());
  const [query, setQuery] = usePageState(`health.${focus}.query`, "");
  const [kind, setKind] = usePageState<"" | "series" | "movie">(`health.${focus}.kind`, "");
  // Click a column total ("Logo · 12 missing") to see only those titles.
  const [only, setOnly] = usePageState<Check | "">(`health.${focus}.only`, "");
  const [offFolders, setOffFolders] = usePageState<string[]>(`health.${focus}.offFolders`, []);
  const checks: Check[] = focus === "art" ? ["identified", ...ART] : ["name", "identified", "poster", "backdrop", "logo", "subs"];
  const canEdit = !st.readOnly;

  const [at, setAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const load = async (fresh: boolean) => {
    try {
      const nc = await api.namingCheckLast().catch(() => null);
      const byId = new Map((nc?.rows ?? []).map((r) => [r.id, r]));
      const run = () => api.libraryHealth(fresh);
      const h = fresh
        ? await track("Checking the whole library", async (job) => {
            setChecking(true);
            const un = await followEvent(job, "health-progress");
            try {
              return await run();
            } finally {
              un();
              setChecking(false);
            }
          }, { reload: false, stop: "health" })
        : await run();
      setRows(h.rows.map((r) => ({ ...r, check: byId.get(r.id) ?? null })));
      setAt(h.at);
      // Older than a day: refresh in the background, the old list stays meanwhile.
      if (!fresh && Date.now() / 1000 - h.at > 86_400) void load(true);
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    void load(false);
  }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const score = (r: Row) => {
    const s = checks.map((c) => status(r, c)).filter((x) => x !== null) as boolean[];
    return s.length ? s.filter(Boolean).length / s.length : 1;
  };
  const folders = useMemo(() => [...new Set((rows ?? []).map((r) => r.libraryFolder || "Other"))].sort(), [rows]);
  // New folders start ticked; what you unticked stays unticked.
  useEffect(() => {
    const fresh = folders.filter((f) => !seenFolders.current.has(f));
    if (!fresh.length) return;
    fresh.forEach((f) => seenFolders.current.add(f));
    folderSel.reset([...folderSel.set, ...fresh.filter((f) => !offFolders.includes(f))]);
  }, [folders.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  // Folders you untick stay unticked next time.
  useEffect(() => {
    if (folders.length) setOffFolders(folders.filter((f) => !folderSel.has(f)));
  }, [folderSel.set]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = (rows ?? [])
    .filter((r) => folderSel.has(r.libraryFolder || "Other") && (!kind || r.kind === kind) && (!query || r.name.toLowerCase().includes(query.toLowerCase())))
    .filter((r) => !only || status(r, only) === false)
    .filter((r) => only || (filter === "all" ? true : filter === "ok" ? score(r) === 1 : score(r) < 1))
    .sort((a, b) => (filter === "todo" ? score(a) - score(b) : 0) || a.name.localeCompare(b.name));
  const total = rows?.length ?? 0;
  const perfect = (rows ?? []).filter((r) => score(r) === 1).length;
  const gaps = (c: Check) => (rows ?? []).filter((r) => status(r, c) === false).length;

  function fixCell(r: Row, c: Check) {
    if (c === "identified") return nav.open(r.id, { tab: "identify" });
    if (c === "name") return nav.open(r.id, { tab: "rename" });
    if (c === "subs") return nav.open(r.id, { tab: r.kind === "movie" ? "subs" : "main" });
    if (!canEdit) return nav.open(r.id, { tab: "art" });
    const kindMap: Record<string, "Primary" | "Backdrop" | "Logo" | "Thumb" | "Banner"> = { poster: "Primary", backdrop: "Backdrop", logo: "Logo", thumb: "Thumb", banner: "Banner" };
    // Shows what's online for this picture (recommended picked) and lets you choose.
    void askArt(r.id, r.name, [kindMap[c]]).then((choice) => {
      if (!choice) return;
      void track(`${LABEL[c]} for ${r.name}`, async (job) => {
        const n = await applyArt(r.id, choice);
        job.update(n ? "Added" : "Skipped", 1);
        if (n) setRows((rs) => rs?.map((x) => (x.id === r.id ? { ...x, [c]: true } : x)) ?? null);
      }, { reload: false }).catch(() => undefined);
    });
  }

  async function fixAll() {
    const list = shown.filter((r) => score(r) < 1);
    if (!list.length) return;
    const what: FixKind[] = focus === "art" ? ["art"] : ["art", "subs", "rename"];
    const plan = await askFixes("Fix what's safe", list.map((r) => targetOf(r, r.check, focus === "art")), what);
    if (!plan) return;
    await track(`Fixing ${plan.list.length} titles`, (job) => fixTitles(plan.list, plan.what, st.subLangs, job).then(() => undefined), { cancellable: true, reload: false }).catch(() => undefined);
    void load(true);
  }

  // Metadata and art: list on the left, the title's own page (artwork tab) on the right.
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    if (focus === "art" && !sel && shown.length) setSel(shown[0].id);
  }, [focus, sel, shown.length]); // eslint-disable-line react-hooks/exhaustive-deps
  /** The inspector loaded fresh details: update that title's dots right away. */
  const patchFrom = (d: Details) => {
    const has = (k: string) => d.images.some((i) => i.ImageType === k);
    const ids = d.item.ProviderIds ?? {};
    setRows((rs) => rs?.map((x) => (x.id === d.item.Id.replace(/-/g, "") || x.id === d.item.Id
      ? { ...x, identified: !!(ids.Tmdb || ids.Tvdb), poster: has("Primary"), backdrop: has("Backdrop"), logo: has("Logo"), thumb: has("Thumb"), banner: has("Banner") }
      : x)) ?? null);
  };
  if (focus === "art") {
    const items: StudioItem[] = shown.map((r) => ({
      id: r.id,
      title: `${r.name}${r.year ? ` (${r.year})` : ""}`,
      sub: `${r.kind === "series" ? "Show" : "Movie"}${r.libraryFolder ? ` · ${r.libraryFolder}` : ""}`,
      thumb: imageUrl(r.id, "Primary", 80),
      dots: checks.map((c) => ({ ok: status(r, c), label: LABEL[c] })),
      warn: checks.some((c) => c !== "identified" && status(r, c) === false),
    }));
    return (
      <div className="pg studio-page">
        <div className="pg-head">
          <div>
            <h1>Metadata and art</h1>
            <div className="muted small">{rows ? `${perfect} of ${total} titles have a match and every kind of picture.` : "Checking…"} Dots: {checks.map((c) => LABEL[c]).join(" · ")}.</div>
          </div>
          <div className="pg-actions">
            <button disabled={checking} onClick={() => void load(true)}><Icon name="reload" /> {checking ? "Checking…" : "Check again"}</button>
            <button className="primary" disabled={!canEdit || !rows} onClick={() => void fixAll()}>Fill in missing art ({shown.filter((r) => score(r) < 1).length})</button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <Studio
          items={items}
          selected={sel}
          onSelect={setSel}
          empty={!rows ? "Reading the library…" : filter === "todo" ? "Nothing to fix here." : "Nothing here."}
          head={
            <>
              <label className="searchbox"><Icon name="search" /><input placeholder="Find a title" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
              <div className="chips">
                <button className={`chip ${filter === "todo" ? "on" : ""}`} onClick={() => setFilter("todo")}>Needs work ({total - perfect})</button>
                <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All</button>
                <select value={kind} onChange={(e) => setKind(e.target.value as "" | "series" | "movie")} className="chip-select">
                  <option value="">Shows and movies</option><option value="series">Shows</option><option value="movie">Movies</option>
                </select>
                {folders.length > 1 && <CheckMenu label="Folders" options={folders.map((f) => ({ id: f, label: f, count: (rows ?? []).filter((r) => (r.libraryFolder || "Other") === f).length }))} sel={folderSel} allLabel="All folders" />}
              </div>
            </>
          }
        >
          {sel && (
            <ItemPage key={sel} id={sel} initialTab="art" embedded onBack={() => undefined} onOpen={(i) => nav.open(i)} onNav={(v) => nav.route({ view: v })}
              subLangs={st.subLangs} titleLang={st.titleLang} status={st} onLoaded={patchFrom} />
          )}
        </Studio>
      </div>
    );
  }

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Library health</h1>
          <div className="muted small">{rows ? `${perfect} of ${total} titles are complete (names, match, artwork, subtitles).` : "Checking…"}{at ? ` Checked ${new Date(at * 1000).toLocaleString()}.` : ""}</div>
        </div>
        <div className="pg-actions">
          <button disabled={checking} onClick={() => void load(true)}><Icon name="reload" /> {checking ? "Checking…" : "Check again"}</button>
          <button className="primary" disabled={!canEdit || !rows} onClick={() => void fixAll()}>Fix what's safe ({shown.filter((r) => score(r) < 1).length})</button>
        </div>
      </div>
      {!canEdit && <p className="note">Fixing needs changes switched on (<SettingsLink section="changes">turn them on</SettingsLink>). You can still look around.</p>}
      {error && <p className="error">{error}</p>}
      {focus === "all" && rows && !rows.some((r) => r.check) && (
        <p className="note small">Names haven't been checked yet. <button className="link" onClick={() => nav.route({ view: "renamer" })}>Run the library check in the Renamer</button> to fill that column.</p>
      )}

      {rows && (
        <div className="health-sum">
          {checks.map((c) => (
            <button key={c} className={`health-stat ${only === c ? "on" : ""}`} disabled={!gaps(c) && only !== c} onClick={() => setOnly(only === c ? "" : c)} title={gaps(c) ? `Show only the ${gaps(c)} titles missing this` : "Nothing missing"}>
              <div className="small muted">{LABEL[c]}</div>
              <div className={`strong ${gaps(c) ? "warn" : "ok"}`}>{gaps(c) ? `${gaps(c)} missing` : "✓ all"}</div>
            </button>
          ))}
          {only && <button className="link small health-clear" onClick={() => setOnly("")}><Icon name="x" size={12} /> Show all again</button>}
        </div>
      )}

      <div className="toolbar">
        <div className="chips">
          <button className={`chip ${filter === "todo" ? "on" : ""}`} onClick={() => setFilter("todo")}>Needs work ({total - perfect})</button>
          <button className={`chip ${filter === "ok" ? "on" : ""}`} onClick={() => setFilter("ok")}>Complete ({perfect})</button>
          <button className={`chip ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>All ({total})</button>
          <select value={kind} onChange={(e) => setKind(e.target.value as "" | "series" | "movie")} className="chip-select">
            <option value="">Shows and movies</option><option value="series">Shows</option><option value="movie">Movies</option>
          </select>
          {folders.length > 1 && <CheckMenu label="Folders" options={folders.map((f) => ({ id: f, label: f, count: (rows ?? []).filter((r) => (r.libraryFolder || "Other") === f).length }))} sel={folderSel} allLabel="All folders" />}
        </div>
        <label className="searchbox"><Icon name="search" /><input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>

      {!rows && !error && <p className="muted">Reading the whole library…</p>}
      {rows && (
        <div className="card health-table">
          <div className="h-row head" style={{ gridTemplateColumns: `minmax(220px, 2fr) repeat(${checks.length}, minmax(70px, 1fr)) 70px` }}>
            <span>Title</span>
            {checks.map((c) => <span key={c}>{LABEL[c]}</span>)}
            <span>Score</span>
          </div>
          {shown.slice(0, 600).map((r) => {
            const sc = score(r);
            return (
              <div key={r.id} className="h-row" style={{ gridTemplateColumns: `minmax(220px, 2fr) repeat(${checks.length}, minmax(70px, 1fr)) 70px` }}
                onContextMenu={(e) => openMenu(e, itemMenu({ id: r.id, kind: r.kind, title: r.name }, canEdit))}>
                <button className="h-title link-plain" onClick={() => nav.open(r.id)}>
                  <span className="thumb"><img src={imageUrl(r.id, "Primary", 80)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></span>
                  <span className="names">
                    <span className="title">{r.name}{r.year ? <span className="muted"> ({r.year})</span> : null}</span>
                    <span className="muted small">{r.kind === "series" ? `Show · ${r.videos} episodes` : "Movie"}{r.libraryFolder ? ` · ${r.libraryFolder}` : ""}</span>
                  </span>
                </button>
                {checks.map((c) => {
                  const v = status(r, c);
                  const label = c === "subs" && v === false ? `${r.noSubs} missing` : c === "name" && v === false ? (r.check?.sure ? "100% fix" : "fix") : "";
                  return (
                    <button key={c} className={`h-cell ${v === null ? "unknown" : v ? "yes" : "no"}`} disabled={v !== false}
                      title={v === null ? "Not checked yet" : v ? "OK" : `Fix ${LABEL[c].toLowerCase()}`} onClick={() => fixCell(r, c)}>
                      {v === null ? "–" : v ? "✓" : label || "Add"}
                    </button>
                  );
                })}
                <span className="h-score"><span className="h-bar"><span style={{ width: `${sc * 100}%` }} className={sc === 1 ? "ok" : sc > 0.6 ? "warn" : "bad"} /></span></span>
              </div>
            );
          })}
          {shown.length === 0 && <p className="muted pad">{filter === "todo" ? "Nothing to fix here." : "Nothing here."}</p>}
          {shown.length > 600 && <p className="muted small pad">Showing the first 600. Use the filter to narrow it down.</p>}
        </div>
      )}
    </div>
  );
}

