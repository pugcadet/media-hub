// Home: new downloads waiting in the Inbox, what needs doing in the library, what was just
// added and what changed. One button checks everything again (only what changed).
import { useEffect, useState } from "react";
import { Alert, api, Card, imageUrl, InboxItem, ServerOverview, Status } from "./api";
import { useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { Icon, type IconName } from "./ui";
import { setPrefs, usePrefs } from "./prefs";
import { namesToFix } from "./fixers";
import { scanEverything, useScanSummary, type ScanSummary } from "./scan";
import { agoText } from "./saved";

function hour(): string {
  const h = new Date().getHours();
  return h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export const gbText = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`);

export interface Block {
  key: string;
  icon: IconName;
  /** null = not checked yet */
  count: number | null;
  /** Share that's fine (0–1), for the bar; null = no bar. */
  ok?: number | null;
  title: string;
  okTitle: string;
  detail: string;
  tone: "warn" | "bad" | "info";
  go: Route;
  at?: number | null;
}

/** One-time setup steps, until they're done (or hidden). */
function SetupChecklist({ status, inboxDir }: { status: Status; inboxDir: string | null | undefined }) {
  const p = usePrefs();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  useEffect(() => {
    if (p.setupDone) return;
    api.healthAlerts().then(setAlerts).catch(() => setAlerts([]));
  }, [p.setupDone]);
  if (p.setupDone || !alerts || inboxDir === undefined) return null;
  const plugins = !alerts.some((a) => a.fix === "settings:plugins" && a.level !== "info");
  const steps: { done: boolean; label: string; hint: string; go: () => void }[] = [
    { done: !!status.libraryRoot, label: "Choose your library folder", hint: "The NAS share on this computer", go: () => nav.route({ view: "settings", section: "folder" }) },
    { done: !status.readOnly, label: "Allow changes to Jellyfin", hint: "Everything stays undoable", go: () => nav.route({ view: "settings", section: "changes" }) },
    { done: plugins, label: "Install the Jellyfin plugins", hint: "Skip markers and subtitles", go: () => nav.route({ view: "jellyfin" }) },
    { done: status.hasTmdb, label: "Add a TMDB key", hint: "Better matching, missing episodes", go: () => nav.route({ view: "settings", section: "metadata" }) },
    { done: !!inboxDir, label: "Choose your downloads folder", hint: "New downloads show up in the Inbox", go: () => nav.route({ view: "add" }) },
  ];
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  return (
    <section className="card form setup-card">
      <div className="section-head">
        <div>
          <h2>Get Media Hub set up · {done} of {steps.length}</h2>
          <div className="muted small">A few one-time steps; each opens the right place.</div>
        </div>
        <button className="link small" onClick={() => setPrefs({ setupDone: true })}>Hide this</button>
      </div>
      <div className="setup-steps">
        {steps.map((x) => (
          <button key={x.label} className={`setup-step ${x.done ? "done" : ""}`} onClick={x.go} disabled={x.done}>
            <span className="setup-dot">{x.done ? <Icon name="check" size={14} /> : null}</span>
            <span className="grow"><span className="strong small">{x.label}</span><br /><span className="muted small">{x.hint}</span></span>
            {!x.done && <span className="accent">›</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Episodes of the same show added together become one tile ("Mr. Bean · 20 new episodes"). */
export interface Added {
  id: string;
  artId: string;
  title: string;
  sub: string;
}
export function groupAdded(cards: Card[], max = 7): Added[] {
  const out: (Added & { eps: Card[] })[] = [];
  for (const c of cards) {
    const show = c.kind === "episode" && c.seriesId ? c.seriesId : null;
    const g = show ? out.find((x) => x.id === show) : null;
    if (g) {
      g.eps.push(c);
      continue;
    }
    if (out.length >= max) continue;
    out.push({ id: show ?? c.id, artId: c.artId, title: c.kind === "movie" && c.year ? `${c.title} (${c.year})` : c.title, sub: "", eps: [c] });
  }
  return out.map(({ eps, ...g }) => {
    const first = eps[0];
    let sub = first.kind === "movie" ? "Movie" : first.subtitle;
    if (eps.length > 1) {
      const seasons = [...new Set(eps.map((e) => /^S(\d+)/.exec(e.subtitle)?.[1]).filter(Boolean))];
      sub = `${eps.length} new episodes${seasons.length === 1 ? ` · Season ${Number(seasons[0])}` : ""}`;
    } else if (first.kind === "episode") {
      sub = first.subtitle.split(" · ")[0] || "New episode";
    }
    return { ...g, sub };
  });
}

/** What Home showed last, kept while the app runs. */
const HOME: { epoch: number; at: number; data: Record<string, unknown> } = { epoch: -1, at: 0, data: {} };
function useCached<T>(key: string, first: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(key in HOME.data ? (HOME.data[key] as T) : first);
  return [v, (x: T) => { HOME.data[key] = x; setV(x); }];
}

export default function Dashboard({ status }: { status: Status }) {
  const epoch = useEpoch();
  const sum = useScanSummary();
  const p = usePrefs();
  // Home keeps what it showed last time: switching away and back shows it at once, and it only
  // asks again (quietly, in the background) after a minute or when data changed.
  const [inbox, setInbox] = useCached<{ dir: string | null; items: InboxItem[] } | undefined>("inbox", undefined);
  const [recent, setRecent] = useCached<Card[]>("recent", []);
  const [names, setNames] = useCached<number | null>("names", null);
  const [server, setServer] = useCached<ServerOverview | null | undefined>("server", undefined);
  const [alerts, setAlerts] = useCached<Alert[]>("alerts", []);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (HOME.epoch === epoch && Date.now() - HOME.at < 60_000) return;
    HOME.epoch = epoch;
    HOME.at = Date.now();
    api.inboxScan().then(([dir, items]) => setInbox({ dir, items })).catch(() => setInbox({ dir: null, items: [] }));
    api.homeFeed().then((f) => setRecent(f.recent)).catch(() => undefined);
    api.serverOverview().then(setServer).catch(() => setServer(null));
    api.healthAlerts().then(setAlerts).catch(() => undefined);
  }, [epoch]);
  useEffect(() => {
    api.namingCheckLast().then((r) => setNames(r ? r.rows.filter((x) => namesToFix(x)).length : null)).catch(() => undefined);
  }, [epoch, p.renameSkip.length, p.renameOff.join("|")]);

  async function scan() {
    setScanning(true);
    try {
      await scanEverything(status, { force: false });
    } catch {
      /* shown in the activity list */
    } finally {
      setScanning(false);
    }
  }

  const h = sum.health;
  const titles = h?.titles ?? 0;
  const lastScan = Math.max(0, h?.at ?? 0, sum.names?.at ?? 0, sum.intros?.at ?? 0);
  const steps: { n: string; label: string; count: number | null; what: string; okWhat: string; go: Route }[] = [
    { n: "1", label: "Identify", count: h?.unidentified ?? null, what: "titles without a match", okWhat: "every title matched", go: { view: "library", flag: "identified" } },
    { n: "2", label: "Artwork", count: h?.noArt ?? null, what: "titles missing a picture", okWhat: "every poster, background, logo", go: { view: "library", flag: "artwork" } },
    { n: "3", label: "Naming", count: names ?? sum.names?.toFix ?? null, what: "titles with names or folders to fix", okWhat: "every name and folder right", go: { view: "library", flag: "naming" } },
    { n: "4", label: "Subtitles", count: h?.subsTitles ?? null, what: "titles missing your language", okWhat: "subtitles everywhere", go: { view: "library", flag: "subtitles" } },
    { n: "5", label: "Intros", count: sum.intros?.withoutIntro ?? null, what: "shows without skip markers", okWhat: "every show can skip its intro", go: { view: "library", flag: "intros" } },
  ];
  const complete = h ? Math.max(0, titles - (h.libraryTodo ?? 0)) : null;
  const waiting = inbox?.items.length ?? 0;
  const dupKey = sum.duplicates ? `${sum.duplicates.groups}:${sum.duplicates.files}` : "";
  const showDup = !!sum.duplicates?.groups && p.dupDismissed !== dupKey;
  const folderFixes = sum.folders?.fixes ?? 0;
  const folderKey = sum.folders ? `${sum.folders.shows}:${sum.folders.movies}` : "";
  const added = groupAdded(recent);
  const serious = alerts.filter((a) => a.level !== "info");
  const plugUpdates = server?.plugins.filter((x) => x.update).length ?? 0;
  const lastLibScan = server?.tasks.find((t) => t.key === "RefreshLibrary")?.lastEnd ?? null;

  return (
    <div className="pg home">
      <div className="home-head">
        <div className="stack-xs">
          <h1>{hour()}</h1>
          <div className="muted">
            {titles ? `${titles.toLocaleString()} titles${complete != null ? ` · ${complete.toLocaleString()} complete` : ""}` : `${status.movies.toLocaleString()} movies · ${status.series.toLocaleString()} shows`}
            {lastScan ? ` · last refreshed ${agoText(lastScan)}` : ""}
          </div>
        </div>
        <button className="primary" disabled={scanning} onClick={() => void scan()} title="Checks names, artwork, subtitles, intros, duplicates and folders. Only what changed since last time is read again.">
          {scanning ? <span className="spinner" /> : <Icon name="reload" size={16} />} {scanning ? "Refreshing…" : "Refresh everything"}
        </button>
      </div>

      <SetupChecklist status={status} inboxDir={inbox ? inbox.dir : undefined} />

      {waiting > 0 && (
        <button className="home-inbox" onClick={() => nav.route({ view: "add" })}>
          <span className="home-inbox-ico"><Icon name="inbox" size={22} /></span>
          <span className="grow stack-xs">
            <b>{waiting} download{waiting === 1 ? " is" : "s are"} waiting</b>
            <span className="muted ellipsis">{inbox!.items.slice(0, 4).map((i) => i.title || i.key).join(" · ")}{waiting > 4 ? " …" : ""}</span>
          </span>
          <span className="home-link">Open Inbox</span>
        </button>
      )}

      {showDup && (
        <div className="home-notice" role="status">
          <b>Duplicate found:</b>
          <span className="grow">{sum.duplicates!.groups} title{sum.duplicates!.groups === 1 ? " has" : "s have"} more than one video file ({sum.duplicates!.files} files).</span>
          <button className="link" onClick={() => nav.route({ view: "cleanup", section: "duplicates" })}>Show</button>
          <button className="link muted-link" onClick={() => setPrefs({ dupDismissed: dupKey })}>Dismiss</button>
        </div>
      )}
      {folderFixes > 0 && p.foldersDismissed !== folderKey && (
        <div className="home-notice" role="status">
          <b>Clean up folders:</b>
          <span className="grow">{[sum.folders!.shows ? `${sum.folders!.shows} show${sum.folders!.shows === 1 ? "" : "s"} without season folders` : "", sum.folders!.movies ? `${sum.folders!.movies} movie${sum.folders!.movies === 1 ? "" : "s"} not in a folder of their own` : ""].filter(Boolean).join(", ")}.</span>
          <button className="link" onClick={() => nav.route({ view: "library", section: "folders" })}>Show</button>
          <button className="link muted-link" onClick={() => setPrefs({ foldersDismissed: folderKey })}>Dismiss</button>
        </div>
      )}
      {serious.map((a) => (
        <button key={a.title} className="home-notice bad" onClick={() => nav.route(a.fix.startsWith("settings:plugins") ? { view: "jellyfin" } : a.fix.startsWith("settings:") ? { view: "settings", section: a.fix.slice(9) } : { view: a.fix as Route["view"] })}>
          <b>{a.title}</b><span className="grow muted">{a.detail}</span><span className="home-link">Fix</span>
        </button>
      ))}

      <section className="home-steps" aria-label="Library">
        <h2 className="home-cap">Library: what's left</h2>
        <div className="home-step-grid">
          {steps.map((x) => (
            <button key={x.n} className="home-step" onClick={() => nav.route({ ...x.go, n: Date.now() })}>
              <span className="muted">{x.label}</span>
              <b className={x.count === null ? "muted" : x.count ? "warn" : "good"}>{x.count === null ? "–" : x.count ? x.count.toLocaleString() : "✓"}</b>
              <span className="muted small">{x.count === null ? "not checked yet" : x.count ? x.what : x.okWhat}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="home-split">
        <section className="home-card" aria-label="Just added">
          <h2>Just added</h2>
          {added.length === 0 && <span className="muted small">Nothing new in Jellyfin lately.</span>}
          <div className="home-added">
            {added.map((c) => (
              <button key={c.id} className="home-added-tile" onClick={() => nav.open(c.id)} title={c.title}>
                <span className="home-added-art">
                  <img src={imageUrl(c.artId, "Primary", 300)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
                  <span className="home-added-name">{c.title}</span>
                </span>
                <span className="small muted ellipsis">{c.sub}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="home-card" aria-label="Jellyfin">
          <h2>Jellyfin</h2>
          {server === undefined && <span className="muted small"><span className="spinner small-spin" /> Asking the server…</span>}
          {server === null && <span className="bad small">The server didn't answer.</span>}
          {server && (
            <>
              <div className="kv-line"><span className="muted">Server</span><span>{server.version}{server.updateAvailable ? <span className="warn"> · {server.latest} is out</span> : " · up to date"}</span></div>
              <div className="kv-line"><span className="muted">Internet (DNS)</span>{server.catalogOk ? <span className="good">Works</span> : <span className="bad">Not working</span>}</div>
              <div className="kv-line"><span className="muted">Last library scan</span><span>{lastLibScan ? agoText(Date.parse(lastLibScan)) : "–"}</span></div>
              <div className="kv-line"><span className="muted">Plugins</span>{plugUpdates ? <span className="warn">{plugUpdates} update{plugUpdates === 1 ? "" : "s"}</span> : <span>{server.plugins.length} · up to date</span>}</div>
              {server.pendingRestart && <div className="kv-line"><span className="muted">Restart</span><span className="warn">needed</span></div>}
            </>
          )}
          <span className="spacer" />
          <button className="link home-link" onClick={() => nav.route({ view: "jellyfin" })}>Open Jellyfin page</button>
        </section>
      </div>
    </div>
  );
}

/** The Clean-up results as blocks (Home and Clean-up show the same ones). */
export function cleanupBlocks(sum: ScanSummary, _series: number): Block[] {
  const cleanup: Block[] = [
    { key: "duplicates", icon: "copy", count: sum.duplicates?.files ?? null, title: "Duplicate files", okTitle: "No duplicates", detail: sum.duplicates ? `${sum.duplicates.groups} title${sum.duplicates.groups === 1 ? "" : "s"} with more than one file.` : "Not checked yet.", tone: "warn", go: { view: "cleanup", section: "duplicates" }, at: sum.duplicates?.at },
    { key: "folders", icon: "folder", count: sum.folders?.fixes ?? null, title: "Folder fixes", okTitle: "Folders tidy", detail: sum.folders ? `${sum.folders.shows} show${sum.folders.shows === 1 ? "" : "s"} without season folders, ${sum.folders.movies} loose movie${sum.folders.movies === 1 ? "" : "s"}.` : "Not checked yet.", tone: "info", go: { view: "library", section: "folders" }, at: sum.folders?.at },
    { key: "storage", icon: "disk", count: sum.storage ? sum.storage.big : null, title: "Unusually big files", okTitle: "No oversized files", detail: sum.storage ? `${gbText(sum.storage.bytes)} in ${sum.storage.videos.toLocaleString()} videos · H.265 could save ~${gbText(sum.storage.shrinkSave)}.` : "Not checked yet.", tone: "info", go: { view: "cleanup", section: "storage" }, at: sum.storage?.at },
    { key: "pictures", icon: "image", count: sum.pictures?.episodes ?? null, title: "Episodes without a picture", okTitle: "Every episode has a picture", detail: "From TMDB first, otherwise a frame from the video.", tone: "info", go: { view: "cleanup", section: "pictures" }, at: sum.pictures?.at },
  ];
  return cleanup;
}

/** A row of result blocks: count, a bar of what's fine, and where to fix it. */
export function BlockRow({ title, hint, blocks, active, onPick, compact }: { title?: string; hint?: string; blocks: Block[]; active?: string; onPick?: (key: string) => void; compact?: boolean }) {
  return (
    <section className="dash-section">
      {title && <div className="dash-section-head"><h2>{title}</h2>{hint && <span className="muted small">{hint}</span>}</div>}
      <div className={`dash-grid ${compact ? "compact" : ""}`}>
        {blocks.map((b) => <ResultBlock key={b.key} b={b} on={active === b.key} onClick={onPick ? () => onPick(b.key) : undefined} />)}
      </div>
    </section>
  );
}

function ResultBlock({ b, on, onClick }: { b: Block; on?: boolean; onClick?: () => void }) {
  const fine = b.count === 0;
  const tone = b.count === null ? "unknown" : fine ? "ok" : b.tone;
  return (
    <button className={`dash-card ${tone} ${on ? "on" : ""}`} aria-pressed={on} onClick={onClick ?? (() => nav.route(b.go))}>
      <span className="row between">
        <span className="dash-ico"><Icon name={fine ? "check" : b.icon} size={20} /></span>
        {b.at ? <span className="muted small">{agoText(b.at)}</span> : null}
      </span>
      <span className="dash-count">{b.count === null ? "–" : fine ? <Icon name="check" size={26} /> : b.count.toLocaleString()}</span>
      <span className="dash-title">{fine && b.okTitle ? b.okTitle : b.title}</span>
      <span className="muted small">{b.detail}</span>
      {b.ok != null && <span className="dash-bar"><span style={{ width: `${Math.round(b.ok * 100)}%` }} /></span>}
      <span className="dash-cta">{fine ? "Open" : b.count === null ? "Check" : "Fix"} <Icon name="chevron" size={12} /></span>
    </button>
  );
}
