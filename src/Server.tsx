// The Jellyfin page: is the server up to date, are the plugins Media Hub needs there, which
// scheduled jobs ran (and which failed), and what went wrong lately. Run a scan or a job from here.
import { useEffect, useState } from "react";
import { api, errorText, imageUrl, ServerOverview, ServerTask, Status } from "./api";
import { track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { agoText } from "./saved";
import { Icon } from "./ui";

const NEEDED: { names: string[]; label: string; why: string; need: boolean }[] = [
  { names: ["Intro Skipper"], label: "Intro Skipper", why: "Skip markers: Media Hub saves intros and credits through it (like the Segment Editor), and it can find them itself.", need: true },
  { names: ["Segment Editor"], label: "Segment Editor", why: "Edit skip markers in Jellyfin's own web page.", need: false },
  { names: ["Open Subtitles", "OpenSubtitles"], label: "Open Subtitles", why: "Subtitles. Sign in in the plugin's settings; free accounts get a few downloads a day.", need: true },
  { names: ["subbuzz"], label: "SubBuzz", why: "More free subtitle sites in one plugin, so you're not stuck at one site's daily limit.", need: false },
  { names: ["Playback Reporting"], label: "Playback Reporting", why: "A longer watch history.", need: false },
  { names: ["Fanart"], label: "Fanart", why: "Logos, banners, clear art and disc pictures.", need: true },
  { names: ["TheTVDB", "TVDB"], label: "TheTVDB", why: "Banners and episode data for shows.", need: true },
];

const squash = (s: string) => s.toLowerCase().replace(/\s/g, "");
const when = (iso: string | null) => (iso ? agoText(new Date(iso).getTime()) : "never");

/** The jobs most people care about, first; the rest fold away. */
const MAIN_TASKS = ["RefreshLibrary", "PluginUpdates", "RefreshChapterImages", "RefreshTrickplayImages", "DeleteCacheFiles", "CleanActivityLog"];

export default function Server({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [data, setData] = useState<ServerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.serverOverview().then((d) => { if (live) { setData(d); setError(null); } }).catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [epoch, tick]);

  // While a job runs, look again every few seconds so its progress moves.
  const running = data?.tasks.some((t) => t.state === "Running") ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 4000);
    return () => window.clearInterval(t);
  }, [running]);

  async function act(key: string, what: string, f: () => Promise<unknown>) {
    setBusy(key);
    try {
      await track(what, () => f());
      window.setTimeout(() => setTick((n) => n + 1), 1200);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const readOnly = status.readOnly;
  const updates = data?.plugins.filter((p) => p.update) ?? [];
  const broken = data?.plugins.filter((p) => /malfunction|notsupported|superceded|superseded/i.test(p.status)) ?? [];
  const failed = data?.tasks.filter((t) => t.lastStatus && !/completed|cancelled|aborted/i.test(t.lastStatus)) ?? [];
  const problems = data?.events.filter((e) => /error|warn|fatal|critical/i.test(e.severity)) ?? [];
  const has = (names: string[]) => data?.plugins.find((p) => names.some((n) => squash(p.name).includes(squash(n))));
  const main = (data?.tasks ?? []).filter((t) => MAIN_TASKS.includes(t.key)).sort((a, b) => MAIN_TASKS.indexOf(a.key) - MAIN_TASKS.indexOf(b.key));
  const rest = (data?.tasks ?? []).filter((t) => !MAIN_TASKS.includes(t.key));

  const restart = async () => {
    if (!(await askConfirm("Restart Jellyfin now?\n\nAnyone watching gets cut off for about a minute. Nothing is lost.", { okLabel: "Restart" }))) return;
    await act("restart", "Restarting Jellyfin", () => api.serverRestart());
  };

  const gbs = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${Math.round(b / 1e9)} GB`);
  const transcoding = data?.playing.filter((x) => x.transcoding) ?? [];

  return (
    <div className="pg jf-page jf2">
      <div className="jf-head">
        <div className="stack-xs">
          <h1>Jellyfin</h1>
          <span className="muted">{data ? `${data.name} · version ${data.version} · ${data.updateAvailable ? `${data.latest ?? "a newer version"} is out` : "up to date"}` : "Your server at a glance"}</span>
        </div>
        <span className="spacer" />
        <button onClick={() => setTick((n) => n + 1)}><Icon name="reload" /> Refresh</button>
        <button disabled={readOnly || busy === "scan"} onClick={() => void act("scan", "Scanning all libraries", () => api.serverTaskRunKey("RefreshLibrary"))}>
          {busy === "scan" ? <span className="spinner small-spin" /> : null} Scan all libraries
        </button>
        <button className="danger-outline" disabled={readOnly || busy === "restart"} onClick={() => void restart()}>Restart Jellyfin</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="pg-loading"><span className="spinner" /> Asking Jellyfin…</div>}
      {data && (
        <>
          {!data.catalogOk && (
            <div className="home-notice bad"><b>Jellyfin can't reach the internet.</b><span className="grow">Its plugin catalogue doesn't load, so Identify finds no artwork and plugin updates fail. Usually the container's DNS: on a Synology set DSM's DNS (Control Panel → Network) to 1.1.1.1, or add a dns: line to Jellyfin's compose file, then restart the container.</span></div>
          )}
          {data.pendingRestart && (
            <div className="home-notice"><b>Jellyfin wants a restart</b><span className="grow">Usually after plugin updates; they only start working after it.</span><button className="link" disabled={readOnly} onClick={() => void restart()}>Restart</button></div>
          )}
          <div className="jf-cols">
            <section className="jf-col" aria-label="Playing now">
              <h2>Playing now{data.playing.length ? ` · ${data.playing.length}` : ""}</h2>
              {data.playing.length === 0 && <p className="muted small">Nobody is watching right now.</p>}
              {data.playing.map((x, i) => (
                <div key={i} className="jf-play">
                  <img src={imageUrl(x.artId, "Primary", 120)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                  <div className="grow stack-xs">
                    <b className="ellipsis">{x.title}</b>
                    <span className="muted small ellipsis">{x.user}{x.device ? ` · ${x.device}` : ""}{x.paused ? " · paused" : ""}</span>
                    <span className={`small ${x.transcoding ? "warn" : "good"}`}>{x.how}</span>
                    {x.progress != null && <div className="jf-bar"><span style={{ width: `${Math.round(x.progress * 100)}%` }} /></div>}
                  </div>
                </div>
              ))}
              <h2 className="jf-sub">Watched lately</h2>
              {data.watched.length === 0 && <p className="muted small">Nothing in Jellyfin's activity list yet.</p>}
              {data.watched.map((w, i) => (
                <div key={i} className="jf-watched"><span className="muted">{when(w.date)}</span><span className="grow ellipsis">{w.title}</span><span className="muted">{w.user}</span></div>
              ))}
            </section>

            <section className="jf-col" aria-label="Plugins">
              <div className="row between">
                <h2>Plugins</h2>
                {updates.length > 0 && (
                  <button className="primary" disabled={readOnly || busy === "plugins"} onClick={() => void act("plugins", "Updating plugins", () => api.serverTaskRunKey("PluginUpdates"))}>
                    {busy === "plugins" ? <span className="spinner small-spin" /> : null} Update {updates.length}
                  </button>
                )}
              </div>
              {updates.length > 0 && <p className="muted small">After updating, Jellyfin needs a restart for the new versions to work.</p>}
              {NEEDED.map((r) => {
                const p = has(r.names);
                return (
                  <div key={r.label} className="plugin-row">
                    <span className={`plugin-mark ${p ? (p.update ? "warn" : "good") : r.need ? "warn" : "muted"}`}>{p ? (p.update ? "↑" : "✓") : r.need ? "!" : "+"}</span>
                    <div className="grow"><div className="strong small">{r.label}{!r.need && <span className="muted"> · optional</span>}</div><div className="muted small">{r.why}</div></div>
                    <span className={`small ${p ? (p.update ? "warn" : "good") : r.need ? "warn" : "muted"}`}>{p ? (p.update ? `${p.version} → ${p.update}` : p.version) : "Not installed"}</span>
                  </div>
                );
              })}
              {broken.map((p) => (
                <div key={p.name} className="plugin-row"><span className="plugin-mark bad">!</span><div className="grow strong small">{p.name}</div><span className="small bad">{p.status === "Restart" ? "Needs a restart" : "Not working"}</span></div>
              ))}
              <details className="small">
                <summary className="muted">All {data.plugins.length} installed plugins</summary>
                <div className="plugin-all">
                  {data.plugins.map((p) => <span key={p.name} className="chip static">{p.name} <span className="muted">{p.version}{p.update ? ` → ${p.update}` : ""}</span></span>)}
                </div>
              </details>
              <p className="muted small jf-foot">Add new ones in Jellyfin: Dashboard → Plugins → Catalog, then restart.</p>
            </section>

            <section className="jf-col" aria-label="Health and jobs">
              <h2>Server health</h2>
              <div className="kv-line"><span className="muted">Internet (DNS)</span>{data.catalogOk ? <span className="good">Works</span> : <span className="bad">Not working</span>}</div>
              {data.disks.map((d, i) => (
                <div key={i} className="kv-line" title={d.path}><span className="muted">Disk free{data.disks.length > 1 ? ` (${d.path.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? ""})` : " on the NAS"}</span><span className={d.free / Math.max(1, d.total) < 0.1 ? "warn" : ""}>{gbs(d.free)} of {gbs(d.total)}</span></div>
              ))}
              <div className="kv-line"><span className="muted">Transcoding now</span><span>{transcoding.length ? `${transcoding.length} stream${transcoding.length === 1 ? "" : "s"}` : "none"}</span></div>
              {(failed.length > 0 || problems.length > 0) && <div className="kv-line"><span className="muted">Problems lately</span><span className="warn">{failed.length + problems.length}</span></div>}
              <h2 className="jf-sub">Jobs</h2>
              <div className="jf-tasks">
                {main.map((t) => <TaskRow key={t.id} t={t} busy={busy} readOnly={readOnly} act={act} />)}
              </div>
              {rest.length > 0 && (
                <details className="small">
                  <summary className="muted">{rest.length} more jobs</summary>
                  <div className="jf-tasks">{rest.map((t) => <TaskRow key={t.id} t={t} busy={busy} readOnly={readOnly} act={act} />)}</div>
                </details>
              )}
              {data.events.length > 0 && (
                <details className="small">
                  <summary className="muted">What happened lately ({data.events.length})</summary>
                  <div className="jf-events">
                    {data.events.slice(0, 20).map((e, i) => (
                      <div key={i} className={`jf-event ${/error|fatal|critical/i.test(e.severity) ? "bad" : /warn/i.test(e.severity) ? "warn" : ""}`}>
                        <span className="muted small mono">{when(e.date)}</span>
                        <div className="grow"><div className="small strong">{e.name}</div>{e.overview && <div className="muted small">{e.overview}</div>}</div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </section>
          </div>
          <PicksLeftovers readOnly={readOnly} />
        </>
      )}
    </div>
  );
}

function TaskRow({ t, busy, readOnly, act }: { t: ServerTask; busy: string | null; readOnly: boolean; act: (key: string, what: string, f: () => Promise<unknown>) => Promise<void> }) {
  const run = t.state === "Running";
  const bad = t.lastStatus && !/completed|cancelled|aborted/i.test(t.lastStatus);
  return (
    <div className={`jf-task ${bad ? "bad" : ""}`}>
      <div className="grow">
        <div className="small strong">{t.name}</div>
        <div className="muted small">
          {run ? `Running${t.progress != null ? ` · ${Math.round(t.progress)}%` : "…"}` : `Last ran ${when(t.lastEnd)}${t.lastStatus && t.lastStatus !== "Completed" ? ` · ${t.lastStatus}` : ""}`}
        </div>
        {bad && t.lastError && <div className="small bad">{t.lastError}</div>}
        {run && <div className="struct-bar"><span style={{ width: `${Math.max(2, t.progress ?? 0)}%` }} /></div>}
      </div>
      {run ? (
        <button disabled={readOnly || busy === t.id} onClick={() => void act(t.id, `Stopping ${t.name}`, () => api.serverTaskStop(t.id))}>Stop</button>
      ) : (
        <button disabled={readOnly || busy === t.id} onClick={() => void act(t.id, t.name, () => api.serverTaskRun(t.id))}>
          {busy === t.id ? <span className="spinner small-spin" /> : null} Run
        </button>
      )}
    </div>
  );
}

/** The old "Picks of the day" collection and playlist, if Media Hub ever made them. */
function PicksLeftovers({ readOnly }: { readOnly: boolean }) {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { api.picksLeftovers().then(setN).catch(() => setN(0)); }, []);
  if (!n) return null;
  return (
    <section className="card jf-card jf-wide">
      <div className="jf-state warn">
        <Icon name="warn" />
        <div className="grow"><div className="strong">“Picks of the day” is still in Jellyfin</div><div className="muted small">Media Hub doesn't make picks anymore. Removing the collection/playlist leaves every movie and show where it is.</div></div>
        <button disabled={readOnly} onClick={async () => {
          if (!(await askConfirm("Remove the “Picks of the day” collection and playlist from Jellyfin?\n\nOnly the list goes; the videos in it stay.", { okLabel: "Remove" }))) return;
          await track("Removing Picks of the day", () => api.picksRemove()).catch(() => undefined);
          setN(0);
        }}>Remove</button>
      </div>
    </section>
  );
}
