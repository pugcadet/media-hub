import { useEffect, useMemo, useState } from "react";
import { api, CheckRow, errorText, HealthRow, imageUrl, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { prefs, subSkipped } from "./prefs";
import { Icon, itemMenu, openMenu } from "./ui";
import { askConfirm } from "./confirm";

type Check = "name" | "identified" | "poster" | "backdrop" | "logo" | "thumb" | "banner" | "subs";

const LABEL: Record<Check, string> = {
  name: "Names", identified: "Identified", poster: "Poster", backdrop: "Backdrop", logo: "Logo", thumb: "Thumb", banner: "Banner", subs: "Subtitles",
};
const ART: Check[] = ["poster", "backdrop", "logo", "thumb", "banner"];

interface Row extends HealthRow {
  check: CheckRow | null;
}

function status(r: Row, c: Check): boolean | null {
  switch (c) {
    case "name": return r.check ? !r.check.error && r.check.toRename + r.check.folders + r.check.problems === 0 : null;
    case "identified": return r.identified;
    case "poster": return r.poster;
    case "backdrop": return r.backdrop;
    case "logo": return r.logo;
    case "thumb": return r.thumb;
    case "banner": return r.banner;
    case "subs": return r.noSubs === 0;
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
  const [filter, setFilter] = useState<"todo" | "all" | "ok">(focus === "art" ? "all" : "todo");
  const [folder, setFolder] = useState<string>("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"" | "series" | "movie">("");
  const checks: Check[] = focus === "art" ? ["identified", ...ART] : ["name", "identified", "poster", "backdrop", "logo", "subs"];
  const canEdit = !st.readOnly;

  useEffect(() => {
    Promise.all([api.libraryHealth(), api.namingCheckLast().catch(() => null)])
      .then(([h, nc]) => {
        const byId = new Map((nc?.rows ?? []).map((r) => [r.id, r]));
        setRows(h.map((r) => ({ ...r, check: byId.get(r.id) ?? null })));
      })
      .catch((e) => setError(errorText(e)));
  }, [epoch]);

  const score = (r: Row) => {
    const s = checks.map((c) => status(r, c)).filter((x) => x !== null) as boolean[];
    return s.length ? s.filter(Boolean).length / s.length : 1;
  };
  const folders = useMemo(() => [...new Set((rows ?? []).map((r) => r.libraryFolder).filter(Boolean))].sort(), [rows]);
  const shown = (rows ?? [])
    .filter((r) => (!folder || r.libraryFolder === folder) && (!kind || r.kind === kind) && (!query || r.name.toLowerCase().includes(query.toLowerCase())))
    .filter((r) => (filter === "all" ? true : filter === "ok" ? score(r) === 1 : score(r) < 1))
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
    void track(`${LABEL[c]} for ${r.name}`, async (job) => {
      const added = await api.fillMissingArt(r.id, [kindMap[c]]);
      job.update(added.length ? "Added" : "Nothing found online; pick or upload one on the Artwork tab");
    });
  }

  async function fixAll() {
    const list = shown.filter((r) => score(r) < 1);
    if (!list.length) return;
    const parts = [
      "fill in missing artwork (identified titles only)",
      focus === "all" ? `get missing subtitles that score ${prefs().minSubScore}` : "",
      focus === "all" ? "rename titles that are a 100% match" : "",
    ].filter(Boolean);
    if (!(await askConfirm(`For ${list.length} titles: ${parts.join(", ")}? Titles that need a decision (not identified, unsure names) are left for you. Everything can be undone.`, { okLabel: "Fix what's safe" }))) return;
    await track(`Fixing ${list.length} titles`, async (job) => {
      let art = 0, subs = 0, renamed = 0;
      for (const [i, r] of list.entries()) {
        if (job.cancelled) break;
        job.update(r.name, i / list.length);
        if (r.identified) {
          const missing = (focus === "art" ? ART : (["poster", "backdrop", "logo"] as Check[])).filter((c) => status(r, c) === false);
          if (missing.length) {
            const map: Record<string, "Primary" | "Backdrop" | "Logo" | "Thumb" | "Banner"> = { poster: "Primary", backdrop: "Backdrop", logo: "Logo", thumb: "Thumb", banner: "Banner" };
            art += (await api.fillMissingArt(r.id, missing.map((c) => map[c])).catch(() => [])).length;
          }
        }
        if (focus === "all" && r.noSubs > 0 && r.kind === "movie") {
          const lang = prefs().subLang || st.subLangs[0] || "eng";
          const res = await api.subtitleAuto(r.id, lang, [lang], prefs().minSubScore).catch(() => null);
          if (res?.outcome === "downloaded") subs++;
        }
        if (focus === "all" && r.noSubs > 0 && r.kind === "series") {
          const lang = prefs().subLang || st.subLangs[0] || "eng";
          const seasons = (await api.details(r.id).catch(() => null))?.seasons ?? [];
          for (const s of seasons) {
            if (job.cancelled) break;
            const eps = (await api.children(s.Id).catch(() => [])).filter((e) => e.Type === "Episode" && !subSkipped(e.Path) && !(e.MediaStreams ?? []).some((m) => m.Type === "Subtitle"));
            for (const e of eps) {
              const res = await api.subtitleAuto(e.Id, lang, [lang], prefs().minSubScore).catch(() => null);
              if (res?.outcome === "downloaded") subs++;
            }
          }
        }
        if (focus === "all" && r.check?.sure) {
          renamed += await renameSure(r.check).catch(() => 0);
        }
      }
      if (renamed) await api.libraryScan().catch(() => undefined);
      job.update(`${art} pictures, ${subs} subtitles, ${renamed} files renamed`, 1);
    }, { cancellable: true });
  }

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>{focus === "art" ? "Metadata and art" : "Library health"}</h1>
          <div className="muted small">{rows ? `${perfect} of ${total} titles are complete${focus === "all" ? " (names, match, artwork, subtitles)" : " (match and every kind of picture)"}.` : "Checking…"}</div>
        </div>
        <div className="pg-actions">
          <button className="primary" disabled={!canEdit || !rows} onClick={() => void fixAll()}>Fix what's safe ({shown.filter((r) => score(r) < 1).length})</button>
        </div>
      </div>
      {!canEdit && <p className="note">Fixing needs changes switched on in Settings. You can still look around.</p>}
      {error && <p className="error">{error}</p>}
      {focus === "all" && rows && !rows.some((r) => r.check) && (
        <p className="note small">Names haven't been checked yet. <button className="link" onClick={() => nav.route({ view: "renamer" })}>Run the library check in the Renamer</button> to fill that column.</p>
      )}

      {rows && (
        <div className="health-sum">
          {checks.map((c) => (
            <div key={c} className="health-stat">
              <div className="small muted">{LABEL[c]}</div>
              <div className={`strong ${gaps(c) ? "warn" : "ok"}`}>{gaps(c) ? `${gaps(c)} missing` : "✓ all"}</div>
            </div>
          ))}
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
          {folders.length > 1 && (
            <select value={folder} onChange={(e) => setFolder(e.target.value)} className="chip-select">
              <option value="">Every folder</option>
              {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          )}
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

/** Renames a 100%-sure title like the renamer's library check does. */
export async function renameSure(r: CheckRow): Promise<number> {
  const series = r.kind === "series";
  const plan = await api.plan({
    mode: series ? "tv" : "movie", folder: r.folder,
    template: series ? "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}" : "{title}< ({year})>/{title}< ({year})>.{ext}",
    show: null, year: null, findReplace: [], recursive: series, source: series ? "jellyfin" : "none",
    matchId: series ? `jellyfin:${r.id}` : null, renameFolder: null, seasonFolders: false,
    onlyFile: series ? null : r.file, itemId: series ? null : r.id,
  });
  const ok = plan.ops.filter((o) => o.status === "ok").map((o) => o.from);
  if (!ok.length) return 0;
  return (await api.apply(plan.planId, true, ok)).done;
}
