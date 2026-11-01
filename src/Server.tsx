// The Jellyfin page: is the server up to date, are the plugins Media Hub needs there, which
// scheduled jobs ran (and which failed), and what went wrong lately. Run a scan or a job from here.
import { useEffect, useState } from "react";
import { api, errorText, ServerOverview, ServerTask, Status } from "./api";
import { track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { agoText } from "./saved";
import { Icon } from "./ui";
import { PageHead } from "./kit";

const NEEDED: { names: string[]; label: string; why: string; need: boolean }[] = [
  { names: ["MediaSegments"], label: "MediaSegments API", why: "Saving intro, credits and recap markers (Infuse's Skip buttons).", need: true },
  { names: ["Open Subtitles", "OpenSubtitles"], label: "Open Subtitles", why: "Subtitles. Sign in in the plugin's settings; free accounts get a few downloads a day.", need: true },
  { names: ["subbuzz"], label: "SubBuzz", why: "More free subtitle sites in one plugin, so you're not stuck at one site's daily limit.", need: false },
  { names: ["Intro Skipper"], label: "Intro Skipper", why: "Lets Jellyfin find intros and credits itself. Media Hub can start it from Intros and credits.", need: false },
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

  return (
    <div className="pg jf-page">
      <PageHead
        title="Jellyfin"
        sub={data ? `${data.name} · version ${data.version}${data.os ? ` · ${data.os}` : ""}` : "Your server at a glance"}
        actions={<>
          <button onClick={() => setTick((n) => n + 1)}><Icon name="reload" /> Refresh</button>
          <button className="primary" disabled={readOnly || busy === "scan"} onClick={() => void act("scan", "Scanning all libraries", () => api.serverTaskRunKey("RefreshLibrary"))}>
            {busy === "scan" ? <span className="spinner small-spin" /> : <Icon name="reload" />} Scan all libraries
          </button>
        </>}
      />
      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="pg-loading"><span className="spinner" /> Asking Jellyfin…</div>}
      {data && (
        <div className="jf-grid">
          <section className="card jf-card">
            <h2>Server</h2>
            <div className={`jf-state ${data.updateAvailable ? "warn" : "ok"}`}>
              <Icon name={data.updateAvailable ? "warn" : "check"} />
              <div className="grow">
                <div className="strong">{data.updateAvailable ? `Jellyfin ${data.latest ?? "update"} is out` : "Jellyfin is up to date"}</div>
                <div className="muted small">
                  {data.updateAvailable
                    ? "You have " + data.version + ". Update it where Jellyfin is installed (on a NAS: its app centre or Docker image). Media Hub can't do that part for you."
                    : `Version ${data.version}${data.latest ? ` is the newest` : ""}.`}
                </div>
              </div>
            </div>
            {!data.catalogOk && (
              <div className="jf-state warn">
                <Icon name="warn" />
                <div className="grow"><div className="strong">Jellyfin can't reach the internet</div><div className="muted small">Its plugin catalogue doesn't load, so Identify finds no artwork and plugin updates fail too. Usually the container's DNS setting: on a Synology, set DSM's DNS (Control Panel → Network) to 1.1.1.1, or add a dns: line to Jellyfin's compose file, then restart the container.</div></div>
              </div>
            )}
            {data.pendingRestart && (
              <div className="jf-state warn">
                <Icon name="warn" />
                <div className="grow"><div className="strong">Jellyfin wants a restart</div><div className="muted small">Usually after plugin updates. They only start working after it.</div></div>
                <button disabled={readOnly || busy === "restart"} onClick={() => void restart()}>Restart</button>
              </div>
            )}
            {failed.length + broken.length + problems.length === 0 && !data.pendingRestart && data.catalogOk && (
              <div className="jf-state ok"><Icon name="check" /><div className="grow"><div className="strong">Nothing's wrong</div><div className="muted small">No failed jobs, broken plugins or recent errors.</div></div></div>
            )}
          </section>

          <section className="card jf-card">
            <div className="row between">
              <h2>Plugins</h2>
              {updates.length > 0 && (
                <button disabled={readOnly || busy === "plugins"} onClick={() => void act("plugins", "Updating plugins", () => api.serverTaskRunKey("PluginUpdates"))}>
                  {busy === "plugins" ? <span className="spinner small-spin" /> : <Icon name="download" />} Update {updates.length}
                </button>
              )}
            </div>
            {updates.length > 0 && <p className="muted small">After updating, Jellyfin needs a restart for the new versions to work.</p>}
            {NEEDED.map((r) => {
              const p = has(r.names);
              return (
                <div key={r.label} className="plugin-row">
                  <span className={p ? "ok" : r.need ? "warn" : "muted"}><Icon name={p ? "check" : r.need ? "warn" : "plus"} /></span>
                  <div className="grow"><div className="strong small">{r.label}{!r.need && <span className="muted"> · optional</span>}</div><div className="muted small">{r.why}</div></div>
                  <span className={`small ${p ? (p.update ? "warn" : "ok") : r.need ? "warn" : "muted"}`}>
                    {p ? (p.update ? `${p.version} → ${p.update}` : p.version) : "Not installed"}
                  </span>
                </div>
              );
            })}
            {broken.map((p) => (
              <div key={p.name} className="plugin-row"><span className="bad"><Icon name="warn" /></span><div className="grow strong small">{p.name}</div><span className="small bad">{p.status === "Restart" ? "Needs a restart" : "Not working"}</span></div>
            ))}
            <details className="small">
              <summary className="muted">All {data.plugins.length} installed plugins</summary>
              <div className="plugin-all">
                {data.plugins.map((p) => <span key={p.name} className="chip static">{p.name} <span className="muted">{p.version}{p.update ? ` → ${p.update}` : ""}</span></span>)}
              </div>
            </details>
            <p className="muted small">Install new ones in Jellyfin: Dashboard → Plugins → Catalog, then restart.</p>
          </section>

          <section className="card jf-card jf-wide">
            <h2>Jobs</h2>
            <p className="muted small">Jellyfin runs these on its own schedule. Start one now if you don't want to wait.</p>
            <div className="jf-tasks">
              {main.map((t) => <TaskRow key={t.id} t={t} busy={busy} readOnly={readOnly} act={act} />)}
            </div>
            {rest.length > 0 && (
              <details className="small">
                <summary className="muted">{rest.length} more jobs</summary>
                <div className="jf-tasks">{rest.map((t) => <TaskRow key={t.id} t={t} busy={busy} readOnly={readOnly} act={act} />)}</div>
              </details>
            )}
          </section>

          <section className="card jf-card jf-wide">
            <h2>Lately</h2>
            {data.events.length === 0 && <p className="muted small">Nothing happened lately.</p>}
            <div className="jf-events">
              {data.events.slice(0, 20).map((e, i) => (
                <div key={i} className={`jf-event ${/error|fatal|critical/i.test(e.severity) ? "bad" : /warn/i.test(e.severity) ? "warn" : ""}`}>
                  <span className="muted small mono">{when(e.date)}</span>
                  <div className="grow"><div className="small strong">{e.name}</div>{e.overview && <div className="muted small">{e.overview}</div>}</div>
                </div>
              ))}
            </div>
          </section>
          <PicksLeftovers readOnly={readOnly} />
        </div>
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
          {busy === t.id ? <span className="spinner small-spin" /> : <Icon name="play" />} Run
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
