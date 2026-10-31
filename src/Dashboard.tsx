// Home: new downloads waiting in the Inbox, what needs doing in the library, what was just
// added and what changed. One button checks everything again (only what changed).
import { useEffect, useState, type ReactNode } from "react";
import { Alert, api, Card, imageUrl, InboxItem, JournalRow, Status, Tuning } from "./api";
import { useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { Icon, scanLibrary, type IconName } from "./ui";
import { KIND } from "./History";
import { setPrefs, usePrefs } from "./prefs";
import { namesToFix } from "./fixers";
import { scanEverything, useScanSummary, type ScanResult, type ScanSummary } from "./scan";
import { agoText } from "./saved";

function hour(): string {
  const h = new Date().getHours();
  return h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
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

export default function Dashboard({ status }: { status: Status }) {
  const epoch = useEpoch();
  const sum = useScanSummary();
  const p = usePrefs();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [inbox, setInbox] = useState<{ dir: string | null; items: InboxItem[] } | undefined>(undefined);
  const [tuning, setTuning] = useState<Tuning | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [recent, setRecent] = useState<Card[]>([]);
  const [names, setNames] = useState<{ toFix: number; sure: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [last, setLast] = useState<ScanResult | null>(null);

  useEffect(() => {
    api.healthAlerts().then(setAlerts).catch(() => setAlerts([]));
    api.inboxScan().then(([dir, items]) => setInbox({ dir, items })).catch(() => setInbox({ dir: null, items: [] }));
    api.backendTuning().then(setTuning).catch(() => setTuning(null));
    api.journalAll(6).then(setJournal).catch(() => setJournal([]));
    api.homeFeed().then((f) => setRecent(f.recent.slice(0, 16))).catch(() => setRecent([]));
  }, [epoch]);
  // Names to fix, leaving out what you skipped and folders you switched off.
  useEffect(() => {
    api.namingCheckLast().then((r) => {
      if (!r) return setNames(null);
      const todo = r.rows.filter((x) => namesToFix(x));
      setNames({ toFix: todo.length, sure: todo.filter((x) => x.sure).length });
    }).catch(() => setNames(null));
  }, [epoch, p.renameSkip.length, p.renameOff.join("|")]);

  async function scan(force = false) {
    setScanning(true);
    try {
      setLast(await scanEverything(status, { force }));
    } catch {
      /* shown in the activity bar */
    } finally {
      setScanning(false);
    }
  }

  const h = sum.health;
  const titles = h?.titles ?? 0;
  const share = (bad: number | null | undefined, of: number) => (bad == null || !of ? null : Math.max(0, 1 - bad / of));
  const series = status.series;

  const todo: Block[] = [
    { key: "names", icon: "rename", count: names?.toFix ?? sum.names?.toFix ?? null, ok: share(names?.toFix, titles), title: "Names to fix", okTitle: "Names right", detail: names ? `${names.sure} can be renamed in one go.` : "Not checked yet: Check everything checks them.", tone: "info", go: { view: "renamer" }, at: sum.names?.at },
    { key: "identified", icon: "search", count: h?.unidentified ?? null, ok: share(h?.unidentified, titles), title: "Not identified", okTitle: "All identified", detail: "No match with TMDB or TVDB yet.", tone: "bad", go: { view: "library", flag: "identified" }, at: h?.at },
    { key: "artwork", icon: "image", count: h?.noArt ?? null, ok: share(h?.noArt, titles), title: "Missing artwork", okTitle: "Artwork complete", detail: "A poster, background or logo is missing.", tone: "warn", go: { view: "library", flag: "artwork" }, at: h?.at },
    { key: "subtitles", icon: "subtitles", count: h?.subsVideos ?? null, ok: share(h?.subsTitles, titles), title: "No subtitles", okTitle: "Subtitles", detail: h ? `In ${h.subsTitles} title${h.subsTitles === 1 ? "" : "s"}, in your first language.` : "", tone: "warn", go: { view: "subtitles" }, at: h?.at },
    { key: "intros", icon: "skip", count: sum.intros?.withoutIntro ?? null, ok: share(sum.intros?.withoutIntro, sum.intros?.known ?? 0), title: "No intro markers", okTitle: "Intro markers", detail: sum.intros ? `${sum.intros.known} of ${sum.intros.shows} shows read.` : "Not read yet.", tone: "info", go: { view: "intros" }, at: sum.intros?.at },
    ...cleanupBlocks(sum, series),
  ];
  const tuneTodo = tuning?.rows.filter((r) => r.scope === "library" && !r.ok).length ?? 0;
  const serious = alerts.filter((a) => a.level !== "info");
  const lastScan = Math.max(0, ...todo.map((b) => b.at ?? 0));
  const waiting = inbox?.items.length ?? 0;

  return (
    <div className="pg dash">
      <div className="dash-top">
        <div className="stack-xs">
          <div className="dash-hello">{hour()}</div>
          <h1>Your library</h1>
          <div className="muted">{status.movies.toLocaleString()} movies · {status.series.toLocaleString()} shows{lastScan ? ` · checked ${agoText(lastScan)}` : ""}</div>
          {last && <div className="small muted dash-lastscan">{last.changed ? `${last.changed} title${last.changed === 1 ? "" : "s"} changed since the check before.` : "Nothing changed since the check before."}{last.problems.length ? ` Problems: ${last.problems.join(" · ")}` : ""}</div>}
        </div>
        <div className="dash-scan">
          <button className="primary" disabled={scanning} onClick={() => void scan(false)} title="Checks names, artwork, subtitles, intros, missing episodes, duplicates, folders and storage. Only what changed since the last check is read again.">
            {scanning ? <span className="spinner" /> : <Icon name="reload" size={16} />} {scanning ? "Checking…" : "Check everything"}
          </button>
          <div className="row">
            <button className="link small" disabled={scanning} onClick={() => void scan(true)}>Check all again</button>
            <span className="muted small">·</span>
            <button className="link small" onClick={() => void scanLibrary()}>Ask Jellyfin to look for new files</button>
          </div>
        </div>
      </div>

      <SetupChecklist status={status} inboxDir={inbox ? inbox.dir : undefined} />

      {waiting > 0 && (
        <button className="dash-inbox" onClick={() => nav.route({ view: "add" })}>
          <span className="dash-inbox-ico"><Icon name="inbox" size={22} /></span>
          <span className="grow stack-xs">
            <span className="strong">{waiting} new download{waiting === 1 ? "" : "s"} in your Inbox</span>
            <span className="muted small ellipsis">{inbox!.items.slice(0, 4).map((i) => i.title || i.key).join(" · ")}{waiting > 4 ? " …" : ""}</span>
          </span>
          <span className="dash-inbox-go">Open the Inbox <Icon name="chevron" size={12} /></span>
        </button>
      )}

      {(serious.length > 0 || tuneTodo > 0) && (
        <section className="dash-alerts">
          {serious.map((a) => (
            <button key={a.title} className={`dash-alert ${a.level}`} onClick={() => nav.route(a.fix.startsWith("settings:plugins") ? { view: "jellyfin" } : a.fix.startsWith("settings:") ? { view: "settings", section: a.fix.slice(9) } : { view: a.fix as Route["view"] })}>
              <Icon name="warn" /> <span className="grow"><span className="strong">{a.title}</span> <span className="muted small">{a.detail}</span></span> <Icon name="chevron" size={14} />
            </button>
          ))}
          {tuneTodo > 0 && (
            <button className="dash-alert" onClick={() => nav.route({ view: "settings", section: "backend" })}>
              <Icon name="warn" /> <span className="grow"><span className="strong">{tuneTodo} Jellyfin setting{tuneTodo === 1 ? "" : "s"} to look at</span> <span className="muted small">They let Jellyfin overwrite your edits or slow down scans.</span></span> <Icon name="chevron" size={14} />
            </button>
          )}
        </section>
      )}

      <BlockRow title="What needs doing" hint="Click one to fix it" blocks={todo} />

      {recent.length > 0 && (
        <section className="dash-section">
          <div className="dash-section-head"><h2>Just added to Jellyfin</h2></div>
          <div className="dash-recent">
            {recent.map((c) => (
              <button key={c.id} className="dash-recent-tile" onClick={() => nav.open(c.seriesId ?? c.id)} title={c.title}>
                <span className="dash-recent-art"><img src={imageUrl(c.artId, "Primary", 240)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /></span>
                <span className="small strong ellipsis">{c.title}</span>
                <span className="small muted ellipsis">{c.subtitle}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <Panel title="Recent changes" action={<button className="link small" onClick={() => nav.route({ view: "history" })}>History and undo</button>}>
        {journal.length === 0 && <span className="muted small">Nothing changed yet.</span>}
        {journal.map((j) => (
          <div key={j.id} className={`dash-change ${j.undone ? "undone" : ""}`}>
            <span className="strong small">{KIND[j.action] ?? j.action}</span>
            <span className="small ellipsis grow">{j.title || "—"}</span>
            <span className="muted small">{ago(j.at)}</span>
          </div>
        ))}
      </Panel>
    </div>
  );
}

/** The Clean-up results as blocks (Home and Clean-up show the same ones). */
export function cleanupBlocks(sum: ScanSummary, series: number): Block[] {
  const cleanup: Block[] = [
    { key: "duplicates", icon: "copy", count: sum.duplicates?.files ?? null, title: "Duplicate files", okTitle: "No duplicates", detail: sum.duplicates ? `${sum.duplicates.groups} title${sum.duplicates.groups === 1 ? "" : "s"} with more than one file.` : "Not checked yet.", tone: "warn", go: { view: "cleanup", section: "duplicates" }, at: sum.duplicates?.at },
    { key: "missing", icon: "missing", count: sum.missing?.episodes ?? null, title: "Missing episodes", okTitle: "No missing episodes", detail: sum.missing ? `In ${sum.missing.shows} of ${series} shows (aired episodes only).` : "Not checked yet.", tone: "info", go: { view: "cleanup", section: "missing" }, at: sum.missing?.at },
    { key: "folders", icon: "folder", count: sum.folders?.fixes ?? null, title: "Folder fixes", okTitle: "Folders tidy", detail: sum.folders ? `${sum.folders.shows} show${sum.folders.shows === 1 ? "" : "s"} without season folders, ${sum.folders.movies} loose movie${sum.folders.movies === 1 ? "" : "s"}.` : "Not checked yet.", tone: "info", go: { view: "renamer", section: "folders" }, at: sum.folders?.at },
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

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card dash-panel">
      <div className="row between"><h2>{title}</h2>{action}</div>
      {children}
    </section>
  );
}
