import { useEffect, useState } from "react";
import { api, errorText, imageUrl, Item, MissingReport, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { Icon } from "./ui";
import { Check, IconBtn, SearchBox, Seg, Toolbar } from "./kit";
import { askRenumber } from "./Renumber";
import { setPrefs, usePrefs } from "./prefs";
import { readSaved, usePageState, writeSaved } from "./saved";
import { missingSummary, savePart } from "./scan";

// Results are kept on this computer (also "nothing missing"), so a check isn't lost when you
// leave the page or close the app.
const cache = new Map<string, MissingReport | string>(Object.entries(readSaved<Record<string, MissingReport | string>>("missing")?.data ?? {}));
const persist = () => {
  const s = writeSaved("missing", Object.fromEntries(cache));
  savePart("missing", missingSummary(s.data, s.at));
};
/** "Scan everything" may have checked shows meanwhile: start from what's saved. */
const reload = () => {
  cache.clear();
  for (const [k, v] of Object.entries(readSaved<Record<string, MissingReport | string>>("missing")?.data ?? {})) cache.set(k, v);
};

/** Missing episodes: each show compared with TMDB (or TVmaze). Unaired episodes don't count. */
export default function Missing({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [shows, setShows] = useState<Item[]>([]);
  const [, force] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = usePageState("missing.query", "");
  const [onlyGaps, setOnlyGaps] = usePageState("missing.onlyGaps", false);
  const { missingIgnored, missingSpecials } = usePrefs();
  const [showIgnored, setShowIgnored] = useState(false);
  const ignore = (id: string, on: boolean) => setPrefs((p) => ({ missingIgnored: on ? [...new Set([...p.missingIgnored, id])] : p.missingIgnored.filter((x) => x !== id) }));

  useEffect(() => {
    reload();
    api.list("series", "", "name", 0, 5000).then(setShows).catch(() => setShows([]));
  }, [epoch]);

  async function check(list: Item[]) {
    await track(list.length > 1 ? `Checking ${list.length} shows for missing episodes` : `Missing episodes: ${list[0].name}`, async (job) => {
      for (const [i, s] of list.entries()) {
        if (job.cancelled) break;
        job.update(s.name, i / list.length);
        try {
          cache.set(s.id, await api.missingEpisodes(s.id));
        } catch (e) {
          cache.set(s.id, errorText(e));
        }
        force((n) => n + 1);
      }
      persist();
    }, { cancellable: true, reload: false });
  }

  const active = shows.filter((s) => showIgnored ? missingIgnored.includes(s.id) : !missingIgnored.includes(s.id));
  const visible = active.filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
    .filter((s) => !onlyGaps || (typeof cache.get(s.id) === "object" && (cache.get(s.id) as MissingReport).missing.length > 0));
  const checked = shows.filter((s) => cache.has(s.id)).length;
  const totalMissing = shows.reduce((n, s) => n + (typeof cache.get(s.id) === "object" ? (cache.get(s.id) as MissingReport).missing.length : 0), 0);

  const unchecked = active.filter((s) => !cache.has(s.id));
  const view = showIgnored ? "out" : onlyGaps ? "gaps" : "all";
  return (
    <div className="stack">
      <Toolbar
        right={<>
          <span className="muted small">{checked > 0 ? `${checked} of ${shows.length} checked · ${totalMissing} missing` : `Compares your files with ${status.hasTmdb ? "TMDB" : "TVmaze"}; unaired episodes don't count`}</span>
          {unchecked.length > 0
            ? <button className="primary" disabled={!active.length} onClick={() => void check(unchecked)} title="Only the shows that haven't been checked yet">Check {unchecked.length === active.length ? `all ${active.length} shows` : `${unchecked.length} not checked yet`}</button>
            : <button className="primary" disabled={!active.length} onClick={() => void check(active)} title="Checks every show again (takes a while)">Check all {active.length} again</button>}
        </>}
      >
        <SearchBox value={query} onChange={setQuery} placeholder="Find a show" />
        <Seg value={view} onChange={(v) => { setOnlyGaps(v === "gaps"); setShowIgnored(v === "out"); }} options={[
          { id: "all", label: "All" }, { id: "gaps", label: "With gaps" },
          ...(missingIgnored.length > 0 ? [{ id: "out" as const, label: `Left out ${missingIgnored.length}` }] : []),
        ]} />
        <Check checked={missingSpecials} onChange={(v) => setPrefs({ missingSpecials: v })}>Count specials</Check>
      </Toolbar>
      <div className="card list-card">
        {visible.map((s) => {
          const r = cache.get(s.id);
          const report = typeof r === "object" ? r : null;
          const seasons = report ? [...new Set(report.missing.map((m) => m.season))] : [];
          return (
            <div key={s.id} className="miss-row">
              <div className="miss-head">
                <button className="link-plain miss-chev" disabled={!report?.missing.length} onClick={() => setOpen(open === s.id ? null : s.id)} aria-label="Show the missing episodes">
                  <span className={`chev ${open === s.id ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                </button>
                <button className="thumb" onClick={() => nav.open(s.id, { tab: "episodes" })} title="Open the show's episodes"><img src={imageUrl(s.id, "Primary", 80)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></button>
                <button className="names link-plain" onClick={() => nav.open(s.id, { tab: "episodes" })} title="Open the show's episodes (missing ones are marked)">
                  <div className="title">{s.name}{s.year ? <span className="muted"> ({s.year})</span> : null}</div>
                  <div className="small">
                    {!r && <span className="muted">Not checked</span>}
                    {typeof r === "string" && <span className="warn">{r}</span>}
                    {report && (report.missing.length === 0
                      ? <span className="ok">Complete · {report.have} of {report.known} episodes{report.upcoming.length ? ` · ${report.upcoming.length} still to air` : ""}</span>
                      : <span className="warn">{report.missing.length} missing{seasons.length ? ` (season ${seasons.join(", ")})` : ""} · you have {report.have} of {report.known}{report.specialsMissing && missingSpecials ? ` · ${report.specialsMissing} specials` : ""}</span>)}
                  </div>
                </button>
                <IconBtn icon={r ? "reload" : "search"} title={r ? "Check this show again" : "Check this show"} onClick={() => void check([s])} />
                <IconBtn icon={missingIgnored.includes(s.id) ? "undo" : "x"} title={missingIgnored.includes(s.id) ? "Put it back in the list" : "Leave this show out of the list"} onClick={() => ignore(s.id, !missingIgnored.includes(s.id))} />
              </div>
              {open === s.id && report && (
                <div className="miss-list">
                  {seasons.map((sn) => (
                    <div key={sn} className="miss-season">
                      <div className="strong small">Season {sn}</div>
                      {report.missing.filter((m) => m.season === sn).map((m) => (
                        <div key={m.episode} className="small miss-ep">
                          <span className="mono">S{String(sn).padStart(2, "0")}E{String(m.episode).padStart(2, "0")}</span> {m.title}<span className="muted">{m.airDate ? ` · ${m.airDate}` : ""}</span>
                          {!status.readOnly && <button className="link small" onClick={() => void askRenumber(s.id, sn, m.episode, m.title).then((done) => done && void check([s]))}>It's there under another number…</button>}
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className="muted small">Episode list from {report.source}. Got the files? Use “Add show or movie”, or drop them in the show's folder and scan.</div>
                </div>
              )}
            </div>
          );
        })}
        {visible.length === 0 && <p className="muted pad">No shows.</p>}
      </div>
    </div>
  );
}
