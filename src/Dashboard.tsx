// The manager's home: how healthy the library is, what the last scan found, and one button
// that scans everything again (only the parts that changed). Watching lives on the Player side.
import { useEffect, useState, type ReactNode } from "react";
import { Alert, api, imageUrl, InboxEntry, JournalRow, Pick, Status, Tuning, localDate } from "./api";
import { useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { Icon, scanLibrary, type IconName } from "./ui";
import { KIND } from "./History";
import { getPicks, PicksEditor } from "./Picks";
import { SetupChecklist } from "./Home";
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

export default function Dashboard({ status }: { status: Status }) {
  const epoch = useEpoch();
  const sum = useScanSummary();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [tuning, setTuning] = useState<Tuning | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [editPicks, setEditPicks] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [last, setLast] = useState<ScanResult | null>(null);

  useEffect(() => {
    api.healthAlerts().then(setAlerts).catch(() => setAlerts([]));
    api.inboxList().then(([, l]) => setInbox(l)).catch(() => setInbox([]));
    api.backendTuning().then(setTuning).catch(() => setTuning(null));
    api.journalAll(6).then(setJournal).catch(() => setJournal([]));
    getPicks(localDate()).then(setPicks).catch(() => setPicks([]));
  }, [epoch]);

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
  const pct = h && titles ? Math.round((h.complete / titles) * 100) : 0;
  const series = status.series;

  const health: Block[] = [
    { key: "names", icon: "rename", count: sum.names?.toFix ?? null, ok: share(sum.names?.toFix, titles), title: "Names to fix", okTitle: "Names right", detail: sum.names ? `${sum.names.sure} are a 100% match and can be renamed in one go.` : "Not checked yet: Scan everything checks them.", tone: "info", go: { view: "library", flag: "names" }, at: sum.names?.at },
    { key: "identified", icon: "search", count: h?.unidentified ?? null, ok: share(h?.unidentified, titles), title: "Not identified", okTitle: "All identified", detail: "No match with TMDB or TVDB yet, so names, art and episodes can't be checked.", tone: "bad", go: { view: "library", flag: "identified" }, at: h?.at },
    { key: "artwork", icon: "image", count: h?.noArt ?? null, ok: share(h?.noArt, titles), title: "Missing artwork", okTitle: "Artwork complete", detail: "A poster, background or logo is missing.", tone: "warn", go: { view: "library", flag: "artwork" }, at: h?.at },
    { key: "subtitles", icon: "subtitles", count: h?.subsVideos ?? null, ok: share(h?.subsTitles, titles), title: "Videos without subtitles", okTitle: "Subtitles", detail: h ? `In ${h.subsTitles} title${h.subsTitles === 1 ? "" : "s"}, leaving out folders you don't check.` : "", tone: "warn", go: { view: "library", flag: "subtitles" }, at: h?.at },
    { key: "intros", icon: "skip", count: sum.intros?.withoutIntro ?? null, ok: share(sum.intros?.withoutIntro, sum.intros?.known ?? 0), title: "Shows without intro markers", okTitle: "Intro markers", detail: sum.intros ? `${sum.intros.known} of ${sum.intros.shows} shows read. Markers let Infuse skip intros and credits.` : "Not read yet: Scan everything reads them.", tone: "info", go: { view: "library", flag: "intros" }, at: sum.intros?.at },
  ];
  const cleanup = cleanupBlocks(sum, series);
  const tuneTodo = tuning?.rows.filter((r) => r.scope === "library" && !r.ok).length ?? 0;
  const other: Block[] = [
    { key: "inbox", icon: "inbox", count: inbox.length, title: "New downloads", okTitle: "", detail: "Ready to add to the library with the right names.", tone: "info", go: { view: "add" } },
    { key: "tune", icon: "server", count: tuneTodo, title: "Jellyfin settings", okTitle: "", detail: "Settings that let Jellyfin overwrite your edits or slow down scans.", tone: "warn", go: { view: "settings", section: "backend" } },
  ].filter((b) => (b.count ?? 0) > 0) as Block[];
  const serious = alerts.filter((a) => a.level !== "info");
  const lastScan = Math.max(0, ...[...health, ...cleanup].map((b) => b.at ?? 0));

  return (
    <div className="pg dash">
      <div className="dash-head">
        <div>
          <div className="dash-hello">{hour()}</div>
          <h1>Your library</h1>
          <div className="muted">{status.series} shows · {status.movies} movies{lastScan ? ` · scanned ${agoText(lastScan)}` : ""}</div>
          {last && <div className="small muted dash-lastscan">{last.changed ? `${last.changed} title${last.changed === 1 ? "" : "s"} changed since the scan before.` : "Nothing changed since the scan before."}{last.skipped.length ? ` Skipped (no changes): ${last.skipped.join(", ")}.` : ""}{last.problems.length ? ` Problems: ${last.problems.join(" · ")}` : ""}</div>}
        </div>
        <div className="dash-score" title="Titles with a match, every picture Infuse uses and subtitles">
          <svg viewBox="0 0 36 36" width="92" height="92" aria-hidden="true">
            <defs>
              <linearGradient id="dash-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--green)" />
              </linearGradient>
            </defs>
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--line)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="url(#dash-ring)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${pct} 100`} transform="rotate(-90 18 18)" />
          </svg>
          <div><div className="dash-pct">{h ? `${pct}%` : "–"}</div><div className="muted small">complete</div></div>
        </div>
        <div className="dash-scan">
          <button className="primary dash-scan-btn" disabled={scanning} onClick={() => void scan(false)} title="Checks names, artwork, subtitles, intros, missing episodes, duplicates, folders and storage. Only what changed since the last scan is read again.">
            {scanning ? <span className="spinner" /> : <Icon name="reload" size={18} />} {scanning ? "Scanning…" : "Scan everything"}
          </button>
          <div className="row">
            <button className="link small" disabled={scanning} onClick={() => void scan(true)}>Full rescan</button>
            <span className="muted small">·</span>
            <button className="link small" onClick={() => void scanLibrary()}>Ask Jellyfin to look for new files</button>
          </div>
        </div>
      </div>

      <SetupChecklist status={status} />

      {serious.length > 0 && (
        <section className="dash-alerts">
          {serious.map((a) => (
            <button key={a.title} className={`dash-alert ${a.level}`} onClick={() => nav.route(a.fix.startsWith("settings:") ? { view: "settings", section: a.fix.slice(9) } : { view: a.fix as Route["view"] })}>
              <Icon name="warn" /> <span className="grow"><span className="strong">{a.title}</span> <span className="muted small">{a.detail}</span></span> <Icon name="chevron" size={14} />
            </button>
          ))}
        </section>
      )}

      <BlockRow title="Library health" hint="Open the Library with that filter on" blocks={health} />
      <BlockRow title="Clean-up" hint="What the last scan found" blocks={cleanup} />
      {other.length > 0 && <BlockRow title="Waiting for you" blocks={other} />}

      <div className="dash-cols">
        <Panel title="Picks of the day" action={<button className="link small" onClick={() => setEditPicks(true)}>Edit</button>}>
          <div className="dash-picks">
            {picks.slice(0, 6).map((p) => (
              <button key={p.id} className="dash-pick" onClick={() => nav.open(p.id)} title={`${p.title} · ${p.why}`}>
                <img src={imageUrl(p.artId, "Primary", 160)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
              </button>
            ))}
            {picks.length === 0 && <span className="muted small">No picks today.</span>}
          </div>
        </Panel>
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
      {editPicks && <PicksEditor onClose={() => setEditPicks(false)} />}
    </div>
  );
}

/** The Clean-up results as blocks (Home and Clean-up show the same ones). */
export function cleanupBlocks(sum: ScanSummary, series: number): Block[] {
  const cleanup: Block[] = [
    { key: "duplicates", icon: "copy", count: sum.duplicates?.files ?? null, title: "Duplicate files", okTitle: "No duplicates", detail: sum.duplicates ? `${sum.duplicates.groups} title${sum.duplicates.groups === 1 ? "" : "s"} with more than one file.` : "Not checked yet.", tone: "warn", go: { view: "cleanup", section: "duplicates" }, at: sum.duplicates?.at },
    { key: "missing", icon: "missing", count: sum.missing?.episodes ?? null, title: "Missing episodes", okTitle: "No missing episodes", detail: sum.missing ? `In ${sum.missing.shows} of ${series} shows (aired episodes only).` : "Not checked yet.", tone: "info", go: { view: "cleanup", section: "missing" }, at: sum.missing?.at },
    { key: "folders", icon: "folder", count: sum.folders?.fixes ?? null, title: "Folder fixes", okTitle: "Folders tidy", detail: sum.folders ? `${sum.folders.shows} show${sum.folders.shows === 1 ? "" : "s"} without season folders, ${sum.folders.movies} loose movie${sum.folders.movies === 1 ? "" : "s"}.` : "Not checked yet.", tone: "info", go: { view: "cleanup", section: "folders" }, at: sum.folders?.at },
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
