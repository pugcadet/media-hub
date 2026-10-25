// The manager's home: what needs doing in your library, with a shortcut for each.
// (Watching lives on the Player side.)
import { useEffect, useState, type ReactNode } from "react";
import { Alert, api, CheckResult, HealthRow, imageUrl, InboxEntry, JournalRow, Pick, Status, Tuning, localDate } from "./api";
import { useEpoch } from "./activity";
import { nav, type Route } from "./nav";
import { Icon, scanLibrary, type IconName } from "./ui";
import { artSkipped, CORE_ART, namesToFix, noSubsOf } from "./fixers";
import { KIND } from "./History";
import { getPicks, PicksEditor } from "./Picks";
import { SetupChecklist } from "./Home";

interface Action {
  key: string;
  icon: IconName;
  count: number;
  title: string;
  detail: string;
  tone: "warn" | "bad" | "info" | "ok";
  go: Route;
  cta: string;
}

function hour(): string {
  const h = new Date().getHours();
  return h < 6 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ago(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

export default function Dashboard({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [health, setHealth] = useState<{ at: number; rows: HealthRow[] } | null>(null);
  const [names, setNames] = useState<CheckResult | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [tuning, setTuning] = useState<Tuning | null>(null);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [editPicks, setEditPicks] = useState(false);

  useEffect(() => {
    api.libraryHealth(false).then(setHealth).catch(() => setHealth(null));
    api.namingCheckLast().then(setNames).catch(() => setNames(null));
    api.healthAlerts().then(setAlerts).catch(() => setAlerts([]));
    api.inboxList().then(([, l]) => setInbox(l)).catch(() => setInbox([]));
    api.backendTuning().then(setTuning).catch(() => setTuning(null));
    api.journalAll(6).then(setJournal).catch(() => setJournal([]));
    getPicks(localDate()).then(setPicks).catch(() => setPicks([]));
  }, [epoch]);

  const rows = health?.rows ?? [];
  const unidentified = rows.filter((r) => !r.identified).length;
  const noArt = rows.filter((r) => r.identified && CORE_ART.some((a) => !r[a.key] && !artSkipped(r.id).includes(a.kind))).length;
  const subsTitles = rows.filter((r) => noSubsOf(r) > 0);
  const subsVideos = subsTitles.reduce((n, r) => n + noSubsOf(r), 0);
  const nameRows = (names?.rows ?? []).filter((r) => namesToFix(r));
  const sure = nameRows.filter((r) => r.sure).length;
  const tuneTodo = tuning?.rows.filter((r) => r.scope === "library" && !r.ok).length ?? 0;
  const complete = rows.filter((r) => r.identified && CORE_ART.every((a) => r[a.key] || artSkipped(r.id).includes(a.kind)) && noSubsOf(r) === 0).length;
  const pct = rows.length ? Math.round((complete / rows.length) * 100) : 0;

  const actions: Action[] = [
    { key: "id", icon: "search", count: unidentified, title: "Not identified", detail: "No match with TMDB or TVDB yet, so names, art and episodes can't be checked.", tone: "bad", go: { view: "metadata" }, cta: "Identify" },
    { key: "art", icon: "image", count: noArt, title: "Missing artwork", detail: "A poster, background or logo is missing. Fill it in, or skip what can't be found.", tone: "warn", go: { view: "metadata" }, cta: "Fill in art" },
    { key: "subs", icon: "subtitles", count: subsVideos, title: "Videos without subtitles", detail: `In ${subsTitles.length} title${subsTitles.length === 1 ? "" : "s"}, leaving out folders you don't check.`, tone: "warn", go: { view: "subtitles" }, cta: "Get subtitles" },
    { key: "names", icon: "rename", count: nameRows.length, title: "Names to fix", detail: names ? `${sure} are a 100% match and can be renamed in one go.` : "Run the library check in the Renamer to find them.", tone: "info", go: { view: "renamer" }, cta: "Open Renamer" },
    { key: "inbox", icon: "inbox", count: inbox.length, title: "New downloads", detail: "Ready to add to the library with the right names.", tone: "info", go: { view: "add" }, cta: "Add them" },
    { key: "tune", icon: "server", count: tuneTodo, title: "Jellyfin settings", detail: "Settings that let Jellyfin overwrite your edits or slow down scans.", tone: "warn", go: { view: "settings", section: "backend" }, cta: "Review" },
  ];
  const todo = actions.filter((a) => a.count > 0);
  const done = actions.filter((a) => a.count === 0 && (a.key !== "names" || names));
  const serious = alerts.filter((a) => a.level !== "info");

  return (
    <div className="pg dash">
      <div className="dash-head">
        <div>
          <div className="dash-hello">{hour()}</div>
          <h1>Your library</h1>
          <div className="muted">{status.series} shows · {status.movies} movies{health ? ` · checked ${ago(health.at)}` : ""}</div>
        </div>
        <div className="dash-score" title="Titles with a match, every picture Infuse uses and subtitles">
          <svg viewBox="0 0 36 36" width="92" height="92" aria-hidden="true">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--line)" strokeWidth="3" />
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${pct} 100`} transform="rotate(-90 18 18)" />
          </svg>
          <div><div className="dash-pct">{health ? `${pct}%` : "–"}</div><div className="muted small">complete</div></div>
        </div>
        <div className="row end">
          <button onClick={() => void scanLibrary()}><Icon name="reload" /> Scan library</button>
          <button className="primary" onClick={() => nav.route({ view: "health" })}><Icon name="check" /> Library health</button>
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

      <section className="dash-grid">
        {todo.map((a) => (
          <button key={a.key} className={`dash-card ${a.tone}`} onClick={() => nav.route(a.go)}>
            <span className="dash-ico"><Icon name={a.icon} size={20} /></span>
            <span className="dash-count">{a.count.toLocaleString()}</span>
            <span className="dash-title">{a.title}</span>
            <span className="muted small">{a.detail}</span>
            <span className="dash-cta">{a.cta} <Icon name="chevron" size={12} /></span>
          </button>
        ))}
        {todo.length === 0 && health && (
          <div className="dash-card ok"><span className="dash-ico"><Icon name="check" size={20} /></span><span className="dash-title">Nothing to fix</span><span className="muted small">Everything that was checked is in order.</span></div>
        )}
      </section>
      {done.length > 0 && (
        <div className="dash-done">{done.map((a) => <span key={a.key} className="chip static on"><Icon name="check" size={12} /> {a.title.replace("Not identified", "All identified").replace("Missing artwork", "Artwork complete").replace("Videos without subtitles", "Subtitles").replace("Names to fix", "Names right").replace("New downloads", "Inbox empty").replace("Jellyfin settings", "Jellyfin set up")}</span>)}</div>
      )}

      <div className="dash-cols">
        <Panel title="Shortcuts">
          <div className="dash-shortcuts">
            {([
              ["Intros and credits", "skip", { view: "intros" }],
              ["Duplicates", "copy", { view: "cleanup", section: "duplicates" }],
              ["Missing episodes", "missing", { view: "cleanup", section: "missing" }],
              ["Extra subtitles", "subtitles", { view: "cleanup", section: "subs" }],
              ["Genres and tags", "tag", { view: "cleanup", section: "tags" }],
              ["Collections", "stack", { view: "collections" }],
            ] as [string, IconName, Route][]).map(([label, icon, r]) => (
              <button key={label} className="dash-short" onClick={() => nav.route(r)}><Icon name={icon} /> {label}</button>
            ))}
          </div>
        </Panel>
        <Panel title="Picks of the day" action={<button className="link small" onClick={() => setEditPicks(true)}>Edit</button>}>
          <div className="dash-picks">
            {picks.slice(0, 6).map((p) => (
              <button key={p.id} className="dash-pick" onClick={() => nav.open(p.id)} title={`${p.title} · ${p.why}`}>
                <img src={imageUrl(p.artId, "Primary", 160)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
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

function Panel({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card dash-panel">
      <div className="row between"><h2>{title}</h2>{action}</div>
      {children}
    </section>
  );
}
