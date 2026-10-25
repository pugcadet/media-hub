import { useEffect, useState } from "react";
import { api, errorText, imageUrl, Item, MissingReport, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { Icon } from "./ui";
import { setPrefs, usePrefs } from "./prefs";

// Results stay while the app is open, so going back and forth doesn't recheck everything.
const cache = new Map<string, MissingReport | string>();

/** Missing episodes: each show compared with TMDB (or TVmaze). Unaired episodes don't count. */
export default function Missing({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [shows, setShows] = useState<Item[]>([]);
  const [, force] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyGaps, setOnlyGaps] = useState(false);
  const { missingIgnored, missingSpecials } = usePrefs();
  const [showIgnored, setShowIgnored] = useState(false);
  const ignore = (id: string, on: boolean) => setPrefs((p) => ({ missingIgnored: on ? [...new Set([...p.missingIgnored, id])] : p.missingIgnored.filter((x) => x !== id) }));

  useEffect(() => {
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
    }, { cancellable: true, reload: false });
  }

  const active = shows.filter((s) => showIgnored ? missingIgnored.includes(s.id) : !missingIgnored.includes(s.id));
  const visible = active.filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
    .filter((s) => !onlyGaps || (typeof cache.get(s.id) === "object" && (cache.get(s.id) as MissingReport).missing.length > 0));
  const checked = shows.filter((s) => cache.has(s.id)).length;
  const totalMissing = shows.reduce((n, s) => n + (typeof cache.get(s.id) === "object" ? (cache.get(s.id) as MissingReport).missing.length : 0), 0);

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Missing episodes</h1>
          <div className="muted small">Compares your files with {status.hasTmdb ? "TMDB" : "TVmaze (add a TMDB key for better results)"}. Episodes that haven't aired yet don't count; specials are counted separately.</div>
        </div>
        <div className="pg-actions">
          <button className="primary" onClick={() => void check(active.filter((s) => !cache.has(s.id)))} disabled={!active.length || active.every((s) => cache.has(s.id))}>
            {checked ? `Check the other ${active.filter((s) => !cache.has(s.id)).length}` : `Check all ${active.length} shows`}
          </button>
        </div>
      </div>
      {checked > 0 && <p className="muted small">{checked} checked · {totalMissing} episodes missing in total.</p>}
      <div className="toolbar">
        <div className="row">
          <label className="check small"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />Only shows with gaps</label>
          <label className="check small"><input type="checkbox" checked={missingSpecials} onChange={(e) => setPrefs({ missingSpecials: e.target.checked })} />Count specials</label>
          {missingIgnored.length > 0 && <label className="check small"><input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} />Show the {missingIgnored.length} left out</label>}
        </div>
        <label className="searchbox"><Icon name="search" /><input placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      </div>
      <div className="card list-card">
        {visible.map((s) => {
          const r = cache.get(s.id);
          const report = typeof r === "object" ? r : null;
          const seasons = report ? [...new Set(report.missing.map((m) => m.season))] : [];
          return (
            <div key={s.id} className="miss-row">
              <div className="miss-head">
                <button className="thumb" onClick={() => nav.open(s.id)}><img src={imageUrl(s.id, "Primary", 80)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></button>
                <button className="names link-plain" onClick={() => report && report.missing.length ? setOpen(open === s.id ? null : s.id) : nav.open(s.id)}>
                  <div className="title">{s.name}{s.year ? <span className="muted"> ({s.year})</span> : null}</div>
                  <div className="small">
                    {!r && <span className="muted">Not checked</span>}
                    {typeof r === "string" && <span className="warn">{r}</span>}
                    {report && (report.missing.length === 0
                      ? <span className="ok">Complete · {report.have} of {report.known} episodes{report.upcoming.length ? ` · ${report.upcoming.length} still to air` : ""}</span>
                      : <span className="warn">{report.missing.length} missing{seasons.length ? ` (season ${seasons.join(", ")})` : ""} · you have {report.have} of {report.known}{report.specialsMissing && missingSpecials ? ` · ${report.specialsMissing} specials` : ""} · {open === s.id ? "hide" : "show"} list</span>)}
                  </div>
                </button>
                <button onClick={() => void check([s])}>{r ? "Check again" : "Check"}</button>
                <button className="icon-btn" title={missingIgnored.includes(s.id) ? "Put it back in the list" : "Leave this show out of the list"} aria-label="Leave out" onClick={() => ignore(s.id, !missingIgnored.includes(s.id))}><Icon name={missingIgnored.includes(s.id) ? "undo" : "x"} /></button>
              </div>
              {open === s.id && report && (
                <div className="miss-list">
                  {seasons.map((sn) => (
                    <div key={sn} className="miss-season">
                      <div className="strong small">Season {sn}</div>
                      {report.missing.filter((m) => m.season === sn).map((m) => (
                        <div key={m.episode} className="small miss-ep"><span className="mono">S{String(sn).padStart(2, "0")}E{String(m.episode).padStart(2, "0")}</span> {m.title}<span className="muted">{m.airDate ? ` · ${m.airDate}` : ""}</span></div>
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
