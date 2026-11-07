import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, cultures, Culture, errorText, LibraryLang, Status, Tuning, TuneRow } from "./api";
import { askConfirm } from "./confirm";
import { ToolsSettings } from "./Intros";
import { UpdateSettings } from "./Updates";
import { nav, type View } from "./nav";
import { ACCENTS, DEFAULT_PREFS, setPrefs, usePrefs } from "./prefs";
import { runDaily } from "./scheduler";
import { clearProblems, followEvent, track, useEpoch, useProblems } from "./activity";
import { Icon, TriCheck, type IconName, type TriState } from "./ui";
import { foldersOf, useFolderMap } from "./folders";

const TITLE_LANGS: [string, string][] = [["en-US", "English"], ["nl-NL", "Nederlands"], ["de-DE", "Deutsch"], ["fr-FR", "Français"], ["es-ES", "Español"], ["it-IT", "Italiano"]];
const META_LANGS: [string, string, string][] = [["", "", "Server default"], ["en", "US", "English"], ["nl", "NL", "Nederlands"], ["de", "DE", "Deutsch"], ["fr", "FR", "Français"], ["es", "ES", "Español"], ["it", "IT", "Italiano"]];

const SECTIONS: { id: string; label: string; icon: IconName }[] = [
  { id: "jellyfin", label: "Jellyfin", icon: "tv" },
  { id: "changes", label: "Changes", icon: "rename" },
  { id: "look", label: "Look", icon: "image" },
  { id: "backend", label: "Jellyfin & Infuse", icon: "server" },
  { id: "folder", label: "Library folder", icon: "folder" },
  { id: "folderorder", label: "Folder order", icon: "sort" },
  { id: "intros", label: "Intros", icon: "skip" },
  { id: "subtitles", label: "Subtitles", icon: "subtitles" },
  { id: "metadata", label: "Titles and art", icon: "image" },
  { id: "schedule", label: "Daily tasks", icon: "clock" },
  { id: "tools", label: "Tools", icon: "wrench" },
  { id: "updates", label: "Updates", icon: "download" },
  { id: "problems", label: "Problems log", icon: "warn" },
];

function Section({ id, title, icon, children, hint }: { id: string; title: string; icon: IconName; hint?: string; children: ReactNode }) {
  return (
    <section className="card form set-section" id={`set-${id}`}>
      <div className="set-head"><span className="set-ico"><Icon name={icon} /></span><div><h2>{title}</h2>{hint && <div className="muted small">{hint}</div>}</div></div>
      {children}
    </section>
  );
}

function Switch({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`switch-row ${disabled ? "off" : ""}`}>
      <span className="grow">{children}</span>
      <input type="checkbox" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export default function Settings({ status, onChanged, section }: { status: Status; onChanged: () => void; onNav: (v: View) => void; section?: string }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string; admin: boolean }[]>([]);
  const [tmdb, setTmdb] = useState("");
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(section ?? "jellyfin");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  useEffect(() => {
    if (!section) return;
    const t = window.setTimeout(() => {
      const el = document.getElementById(`set-${section}`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1600);
    }, 60);
    return () => window.clearTimeout(t);
  }, [section]);

  async function run(f: () => Promise<void>, done?: string) {
    setBusy(true);
    setMessage(null);
    try {
      await f();
      onChanged();
      if (done) setMessage({ text: done, error: false });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function toggleChanges(allow: boolean) {
    if (allow && !(await askConfirm(
      "Allow Media Hub to change metadata, pictures, subtitles, collections and skip markers in Jellyfin? Every change is saved first, so you can undo it. Your video files are not touched by this setting.",
      { okLabel: "Allow changes" },
    ))) return;
    void run(() => api.setReadOnly(!allow), allow ? "Changes to Jellyfin are now allowed." : "Media Hub is read-only again.");
  }

  async function disconnect() {
    if (!(await askConfirm("Disconnect from this server? The saved key and the local list are removed from this computer. Your server is not touched.", { okLabel: "Disconnect", danger: true }))) return;
    void run(() => api.disconnect());
  }

  const clicked = useRef(0);
  const go = (id: string) => {
    setActive(id);
    clicked.current = Date.now();
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // The menu on the left follows what you scroll to.
  useEffect(() => {
    const page = scroller.current?.closest(".page");
    if (!page) return;
    const onScroll = () => {
      if (Date.now() - clicked.current < 900) return;
      const top = page.getBoundingClientRect().top + 80;
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const el = document.getElementById(`set-${s.id}`);
        if (el && el.getBoundingClientRect().top <= top) current = s.id;
      }
      // At the very bottom the last section counts, even when it's short.
      if (page.scrollTop + page.clientHeight >= page.scrollHeight - 4) current = SECTIONS[SECTIONS.length - 1].id;
      setActive(current);
    };
    page.addEventListener("scroll", onScroll, { passive: true });
    return () => page.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="pg settings-page" ref={scroller}>
      <div className="pg-head"><h1>Settings</h1></div>
      {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}
      <div className="set-layout">
        <nav className="set-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`set-link ${active === s.id ? "on" : ""}`} onClick={() => go(s.id)}><Icon name={s.icon} />{s.label}</button>
          ))}
        </nav>
        <div className="set-body">
          <Section id="jellyfin" title="Jellyfin" icon="tv" hint="The server Media Hub works with.">
            <div className="kv"><span className="muted">Server</span><span>{status.serverName ?? "—"}</span></div>
            <div className="kv"><span className="muted">Address</span><span className="mono">{status.serverUrl ?? "—"}</span></div>
            <div className="kv"><span className="muted">Library</span><span>{status.movies} movies · {status.series} shows</span></div>
            <label className="wide-label">Watch as this user (resume points, watched status)
              <select value={status.userId ?? ""} onChange={(e) => void run(() => api.setUser(e.target.value), "User changed. Scan the library to refresh watched status.")} disabled={!users.length || busy}>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.admin ? " (admin)" : ""}</option>)}
              </select>
            </label>
            <Switch checked={status.syncWatched} onChange={(v) => void run(() => api.setSyncWatched(v))}>Send where I stopped and what I watched back to Jellyfin, so Infuse continues at the same spot</Switch>
            {status.syncWatched && <WatchSyncTest />}
            <div className="row"><button className="danger-outline" onClick={() => void disconnect()}>Disconnect</button></div>
          </Section>

          <Section id="changes" title="Changes to Jellyfin" icon="rename" hint={status.readOnly ? "Off: Media Hub only reads." : "On: every change can be undone in History."}>
            <p className="muted small">With changes on, Media Hub may fix metadata, pick artwork, manage collections and playlists, download subtitles and save intro/credits markers.</p>
            <div className="row">
              {status.readOnly ? <button className="primary" onClick={() => void toggleChanges(true)}>Allow changes</button> : <button onClick={() => void toggleChanges(false)}>Switch back to read-only</button>}
            </div>
          </Section>

          <LookSettings />

          <BackendSettings status={status} />

          <Section id="folder" title="Library folder" icon="folder" hint="The NAS share as this computer sees it. Used by the renamer, adding titles, intros and subtitle timing.">
            <p className="mono">{status.libraryRoot ?? "Not chosen yet"}</p>
            <div className="row"><button onClick={() => void run(async () => { await api.pickRoot(); })}><Icon name="folder" /> {status.libraryRoot ? "Change folder" : "Choose folder"}</button></div>
          </Section>

          <FolderOrderSettings />
          <IntroSettings status={status} />
          <SubtitleSettings status={status} onChanged={onChanged} />

          <Section id="metadata" title="Titles and art" icon="image" hint="Where names, summaries and pictures come from.">
            <p className="muted small">
              {status.hasTmdb ? "A TMDB key is saved; matching and missing-episode checks use TMDB." : "Without a TMDB key, matching uses your Jellyfin library, Jellyfin's own lookups and TVmaze. A free key (themoviedb.org → Settings → API) works better."}
            </p>
            <div className="row">
              <label>{status.hasTmdb ? "Replace TMDB key" : "TMDB API key or read access token"}<input className="mono" type="password" value={tmdb} onChange={(e) => setTmdb(e.target.value)} /></label>
              <button disabled={!tmdb.trim() || busy} onClick={() => void run(async () => { await api.setTmdbKey(tmdb); setTmdb(""); }, "TMDB key checked and saved.")}>Check and save</button>
              {status.hasTmdb && <button disabled={busy} onClick={() => void run(() => api.setTmdbKey(""), "TMDB key removed.")}>Remove key</button>}
            </div>
            <label className="wide-label">Language the renamer uses for episode titles
              <select value={status.titleLang} onChange={(e) => void run(() => api.setTitleLang(e.target.value))}>
                {TITLE_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <LibraryLanguages canEdit={!status.readOnly} />
          </Section>

          <ScheduleSettings status={status} />
          <div id="set-tools"><ToolsSettings /></div>
          <div id="set-updates"><UpdateSettings /></div>
          <ProblemsLog />
          <p className="muted small">Your Jellyfin API key and TMDB key are kept in this computer's secure storage, never in a file.</p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- folder order */

/** The order of your library folders, used by every tab row and list in the app. */
function FolderOrderSettings() {
  usePrefs();
  const map = useFolderMap();
  const names = foldersOf(map);
  const move = (n: string, d: number) => {
    const i = names.indexOf(n);
    const j = i + d;
    if (j < 0 || j >= names.length) return;
    const next = [...names];
    [next[i], next[j]] = [next[j], next[i]];
    setPrefs({ folderOrder: next });
  };
  return (
    <Section id="folderorder" title="Folder order" icon="sort" hint="The order your library folders appear in, everywhere in the app. You can also drag the folder tabs on any screen.">
      {names.length === 0 && <p className="muted small">Folders appear here after the library check.</p>}
      <div className="order-list">
        {names.map((n, i) => (
          <div key={n} className="order-row">
            <span className="muted mono small">{i + 1}</span>
            <Icon name="folder" />
            <span className="grow">{n}</span>
            <button className="icon-btn" disabled={i === 0} onClick={() => move(n, -1)} aria-label="Up" title="Move up"><span className="rot-up"><Icon name="chevron" size={14} /></span></button>
            <button className="icon-btn" disabled={i === names.length - 1} onClick={() => move(n, 1)} aria-label="Down" title="Move down"><span className="rot-down"><Icon name="chevron" size={14} /></span></button>
          </div>
        ))}
      </div>
      {names.length > 1 && <div className="row"><button className="link small" onClick={() => setPrefs({ folderOrder: [] })}>A to Z again</button></div>}
    </Section>
  );
}

/* ------------------------------------------------------------- intros */

/** Which libraries Jellyfin's Intro Skipper plugin looks at. */
function IntroSettings({ status }: { status: Status }) {
  const [info, setInfo] = useState<{ installed: boolean; available: string[]; selected: string[]; all: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => void api.introSkipperLibraries().then(setInfo).catch((e) => setError(errorText(e)));
  useEffect(load, []);
  async function save(names: string[]) {
    setError(null);
    try {
      await track("Saving Intro Skipper's folders", () => api.setIntroSkipperLibraries(names));
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }
  const on = (n: string) => !!info && (info.all || info.selected.includes(n));
  const p = usePrefs();
  return (
    <Section id="intros" title="Intros" icon="skip" hint="Which libraries Jellyfin's Intro Skipper scans for intros and credits. Media Hub's own detection works on any show you open.">
      {error && <p className="error">{error}</p>}
      <Switch checked={p.recapsOff} onChange={(v) => setPrefs({ recapsOff: v })}>Leave recaps out (no recap markers in the intros tool)</Switch>
      {!info && !error && <p className="muted small">Reading Intro Skipper's settings…</p>}
      {info && !info.installed && <p className="muted small">The Intro Skipper plugin isn't installed in Jellyfin. Media Hub can still find intros itself (Intros and credits).</p>}
      {info?.installed && (
        <>
          <div className="stack-s">
            {info.available.map((n) => (
              <Switch key={n} disabled={status.readOnly} checked={on(n)} onChange={(v) => {
                const cur = info.all ? info.available : info.selected;
                const next = v ? [...new Set([...cur, n])] : cur.filter((x) => x !== n);
                void save(next.length === info.available.length ? [] : next);
              }}>{n}</Switch>
            ))}
          </div>
          <p className="muted small">{info.all ? "All libraries are scanned." : `Only ${info.selected.join(", ") || "none"}.`}{status.readOnly ? " Turn on changes to choose." : ""}</p>
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------- player */

function LookSettings() {
  const p = usePrefs();
  const valid = /^#[0-9a-f]{6}$/i.test(p.accent);
  return (
    <Section id="look" title="Look" icon="image" hint="Your highlight colour, used for buttons, selection and focus all through the app.">
      <div className="accent-row">
        {ACCENTS.map((a) => (
          <button key={a.hex} className={`accent-swatch ${p.accent.toLowerCase() === a.hex ? "on" : ""}`} style={{ background: a.hex }} title={a.name} aria-label={a.name} onClick={() => setPrefs({ accent: a.hex })} />
        ))}
        <label className="accent-custom" title="Any colour">
          <input type="color" value={valid ? p.accent : DEFAULT_PREFS.accent} onChange={(e) => setPrefs({ accent: e.target.value })} />
          <span>Custom</span>
        </label>
        <input className="mono accent-hex" value={p.accent} maxLength={7} onChange={(e) => { const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`; setPrefs({ accent: v }); }} aria-label="Colour code" />
        {p.accent !== DEFAULT_PREFS.accent && <button className="link small" onClick={() => setPrefs({ accent: DEFAULT_PREFS.accent })}>Reset</button>}
      </div>
      <p className="muted small">Status colours don't change: green is fine, amber needs a look, red is a problem.</p>
      <label className="wide-label">Size of everything · {Math.round((p.uiScale || 0.9) * 100)}%
        <div className="row">
          <button className="icon-btn" onClick={() => setPrefs({ uiScale: Math.max(0.75, Math.round((p.uiScale - 0.05) * 100) / 100) })} aria-label="Smaller">−</button>
          <input type="range" min={0.75} max={1.4} step={0.05} value={p.uiScale || 0.9} onChange={(e) => setPrefs({ uiScale: Number(e.target.value) })} className="grow" />
          <button className="icon-btn" onClick={() => setPrefs({ uiScale: Math.min(1.4, Math.round((p.uiScale + 0.05) * 100) / 100) })} aria-label="Bigger">+</button>
          <button className="link small" onClick={() => setPrefs({ uiScale: 0.9 })}>Reset</button>
        </div>
        <span className="muted small">Shortcut: ⌘+ and ⌘− (⌘0 for normal).</span>
      </label>
    </Section>
  );
}

function WatchSyncTest() {
  const [res, setRes] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="row wrap">
      <button disabled={busy} onClick={() => { setBusy(true); setRes(null); api.watchSyncTest().then((t) => setRes({ text: t, ok: true })).catch((e) => setRes({ text: errorText(e), ok: false })).finally(() => setBusy(false)); }}>
        <Icon name="check" /> {busy ? "Testing…" : "Test watch sync"}
      </button>
      {res && <span className={`small ${res.ok ? "ok-text" : "error-text"}`}>{res.text}</span>}
    </div>
  );
}

/* ---------------------------------------------------------- subtitles */

function SubtitleSettings({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const p = usePrefs();
  const [list, setList] = useState<Culture[]>([]);
  const [add, setAdd] = useState("");
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [base, setBase] = useState("");
  const [custom, setCustom] = useState("");
  useEffect(() => {
    cultures().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    if (status.libraryRoot) api.folders(base).then(setFolders).catch(() => setFolders([]));
  }, [status.libraryRoot, base]);
  const name = (c: string) => list.find((x) => x.ThreeLetterISOLanguageName === c || x.ThreeLetterISOLanguageNames?.includes(c))?.DisplayName ?? c;
  const langs = status.subLangs;
  const saveLangs = (next: string[]) => void api.setSubLangs(next).then(onChanged);
  const [skipUndo, setSkipUndo] = useState<string[][]>([]);
  /** Saves a new skip list, keeping the old one for Undo. */
  const saveSkip = (next: string[]) => {
    setSkipUndo((u) => [...u.slice(-19), p.subSkipFolders]);
    setPrefs({ subSkipFolders: [...new Set(next)] });
  };
  const toggleSkip = (f: string) => saveSkip(p.subSkipFolders.includes(f) ? p.subSkipFolders.filter((x) => x !== f) : [...p.subSkipFolders, f]);
  /** Folder state: ticked = subtitles everywhere in it, stripe = some folders inside are left alone. */
  const folderState = (f: string): TriState => {
    if (p.subSkipFolders.some((x) => x === f || f.startsWith(`${x}/`))) return "none";
    return p.subSkipFolders.some((x) => x.startsWith(`${f}/`)) ? "some" : "all";
  };
  /** On: the folder and everything in it gets subtitles. Off: the whole folder is left alone. */
  const setFolder = (fs: string[], on: boolean) => {
    const inside = (x: string) => fs.some((f) => x === f || x.startsWith(`${f}/`));
    const rest = p.subSkipFolders.filter((x) => !inside(x));
    saveSkip(on ? rest : [...rest, ...fs]);
  };
  const rel = (n: string) => (base ? `${base}/${n}` : n);
  const options = list.filter((c) => c.ThreeLetterISOLanguageName && !langs.includes(c.ThreeLetterISOLanguageName));

  return (
    <Section id="subtitles" title="Subtitles" icon="subtitles" hint="Which subtitles to get, and where.">
      <div className="strong small">Languages</div>
      <p className="muted small">“Needed” languages are fetched when missing. “If available” ones are only fetched when there's a perfect match (made for exactly that file). Subtitles built into the video count, so nothing is downloaded twice. Plain subtitles are preferred over ones with sound descriptions (SDH).</p>
      <div className="lang-list">
        {langs.map((l, i) => {
          const needed = p.subRequired.includes(l);
          return (
            <div key={l} className="lang-row">
              <span className="strong">{name(l)}</span>
              <div className="seg">
                <button className={needed ? "on" : ""} onClick={() => setPrefs({ subRequired: [...new Set([...p.subRequired, l])] })}>Needed</button>
                <button className={!needed ? "on" : ""} onClick={() => setPrefs({ subRequired: p.subRequired.filter((x) => x !== l) })}>If available</button>
              </div>
              <label className="check small"><input type="radio" name="clang" checked={p.subLang === l} onChange={() => setPrefs({ subLang: l })} />C key turns this on</label>
              {langs.length > 1 && <button className="link small" onClick={() => saveLangs(langs.filter((x) => x !== l))}>Remove</button>}
              {i > 0 && <button className="link small" onClick={() => saveLangs([l, ...langs.filter((x) => x !== l)])}>Make first</button>}
            </div>
          );
        })}
      </div>
      <div className="row">
        <label>Add a language
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((c) => <option key={c.ThreeLetterISOLanguageName} value={c.ThreeLetterISOLanguageName}>{c.DisplayName}</option>)}
          </select>
        </label>
        <button disabled={!add} onClick={() => { saveLangs([...langs, add]); setAdd(""); }}>Add</button>
      </div>
      <label className="narrow wide-label">Lowest match score to download (100 = made for exactly this file)
        <input type="number" min={1} max={100} value={p.minSubScore} onChange={(e) => setPrefs({ minSubScore: Math.max(1, Math.min(100, Number(e.target.value) || 100)) })} />
      </label>

      <div className="strong small" id="set-subfolders">Folders</div>
      <p className="muted small">Tick a folder to check it for subtitles. A stripe means only some folders inside it are ticked.</p>
      {status.libraryRoot ? (
        <div className="skip-picker">
          <div className="small muted">
            <button className="link" onClick={() => setBase("")}>Library folder</button>
            {base && base.split("/").map((part, i, all) => <span key={i}> › <button className="link" onClick={() => setBase(all.slice(0, i + 1).join("/"))}>{part}</button></span>)}
          </div>
          {folders.length > 1 && (
            <div className="skip-row skip-head">
              <span className="row">
                <TriCheck state={folders.every((f) => folderState(rel(f.name)) === "all") ? "all" : folders.every((f) => folderState(rel(f.name)) === "none") ? "none" : "some"} onChange={(on) => setFolder(folders.map((f) => rel(f.name)), on)} disabled={!!base && folderState(base) === "none"} />
                <span className="small strong">Every folder here</span>
              </span>
              {skipUndo.length > 0 && <button className="link small" onClick={() => { setPrefs({ subSkipFolders: skipUndo[skipUndo.length - 1] }); setSkipUndo(skipUndo.slice(0, -1)); }}><Icon name="undo" size={12} /> Undo</button>}
            </div>
          )}
          {folders.map((f) => {
            const st = folderState(rel(f.name));
            const parentOff = p.subSkipFolders.some((x) => rel(f.name).startsWith(`${x}/`));
            return (
              <div key={f.name} className="skip-row">
                <span className="row">
                  <TriCheck state={st} disabled={parentOff} title={st === "some" ? "Some folders inside are not checked" : st === "all" ? "Checked for subtitles" : "Not checked for subtitles"} onChange={(on) => setFolder([rel(f.name)], on)} />
                  <button className={`link-plain ${st === "none" ? "muted" : ""}`} onClick={() => setBase(rel(f.name))}><Icon name="folder" size={14} /> {f.name}</button>
                  {st === "some" && <span className="muted small">only some folders inside</span>}
                </span>
                <button className="link small" onClick={() => setBase(rel(f.name))}>open ›</button>
              </div>
            );
          })}
        </div>
      ) : <p className="muted small">Choose your library folder first.</p>}
      <div className="row">
        <label>Never check folders named<input value={custom} placeholder="e.g. Anime" onChange={(e) => setCustom(e.target.value)} /></label>
        <button disabled={!custom.trim()} onClick={() => { toggleSkip(custom.trim()); setCustom(""); }}>Add</button>
      </div>
    </Section>
  );
}

/* ------------------------------------------------- Jellyfin as backend */

/** Whether a library option is "on", and the value that switches it on or off. */
const TUNE_SWITCH: Record<string, { on: (v: unknown) => boolean; value: (on: boolean, s: Status) => unknown; recommendedOn: boolean }> = {
  AutomaticRefreshIntervalDays: { on: (v) => Number(v ?? 0) > 0, value: (on) => (on ? 30 : 0), recommendedOn: false },
  EnableRealtimeMonitor: { on: (v) => v === true, value: (on) => on, recommendedOn: true },
  ExtractChapterImagesDuringLibraryScan: { on: (v) => v !== false, value: (on) => on, recommendedOn: false },
  ExtractTrickplayImagesDuringLibraryScan: { on: (v) => v !== false, value: (on) => on, recommendedOn: false },
  SaveLocalMetadata: { on: (v) => v === true, value: (on) => on, recommendedOn: true },
  MetadataSavers: { on: (v) => Array.isArray(v) && v.includes("Nfo"), value: (on) => (on ? ["Nfo"] : []), recommendedOn: true },
  SubtitleDownloadLanguages: { on: (v) => Array.isArray(v) && v.length > 0, value: (on, s) => (on ? s.subLangs : []), recommendedOn: false },
};

function BackendSettings({ status }: { status: Status }) {
  const epoch = useEpoch();
  const [t, setT] = useState<Tuning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openLib, setOpenLib] = useState<string | null>(null);
  const canEdit = !status.readOnly;
  const load = () => api.backendTuning().then((x) => { setT(x); setError(null); }).catch((e) => setError(errorText(e)));
  useEffect(() => void load(), [epoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const libs = new Map<string, TuneRow[]>();
  for (const r of t?.rows.filter((x) => x.scope === "library") ?? []) libs.set(r.target, [...(libs.get(r.target) ?? []), r]);
  const tasks = t?.rows.filter((x) => x.scope === "task") ?? [];
  const todo = t?.rows.filter((x) => x.scope === "library" && !x.ok).length ?? 0;
  const set = (r: TuneRow, value: unknown, what: string) => void track(what, () => api.backendSet(r.scope, r.target, r.key, value)).catch((e) => setError(errorText(e)));

  return (
    <Section id="backend" title="Jellyfin as the backend" icon="server" hint="Media Hub decides details, art and skip markers. Jellyfin keeps them and hands them to Infuse.">
      {error && <p className="error">{error}</p>}
      {!canEdit && <p className="note">Changing Jellyfin's settings needs changes switched on (above).</p>}

      <KeepInPlace t={t} canEdit={canEdit} onChanged={load} />

      <div className="strong small">Your edits stay</div>
      <Switch checked={t?.lockEdits ?? true} onChange={(v) => void api.setLockEdits(v).then(load)}>
        Lock a title once I change its details or pictures, so Jellyfin's own refreshes never undo it (Refresh from internet and Identify unlock it again)
      </Switch>
      <div className="row">
        <button disabled={!canEdit} onClick={() => void askConfirm("Lock every show and movie? Jellyfin then never changes their details or pictures by itself. Each title can be undone in History.", { okLabel: "Lock all" }).then((ok) => { if (ok) void track("Locking every title", async (job) => { const un = await followEvent(job, "bulk-progress"); try { const n = await api.lockAll(true); job.update(`${n} titles locked`, 1); } finally { un(); } }, { stop: "bulk" }).catch((e) => setError(errorText(e))); })}><Icon name="lock" /> Lock every title</button>
        <button disabled={!canEdit} onClick={() => void track("Unlocking every title", async (job) => { const un = await followEvent(job, "bulk-progress"); try { const n = await api.lockAll(false); job.update(`${n} titles unlocked`, 1); } finally { un(); } }, { stop: "bulk" }).catch((e) => setError(errorText(e)))}>Unlock every title</button>
      </div>

      <div className="row between">
        <div>
          <div className="strong small">Library settings</div>
          <div className="muted small">{t ? (todo ? `${todo} setting${todo === 1 ? "" : "s"} differ from what works best with Media Hub and Infuse.` : "Every library is set up the way Media Hub works best.") : "Reading Jellyfin's settings…"}</div>
        </div>
        {todo > 0 && <button className="primary" disabled={!canEdit} onClick={() => void track("Setting up Jellyfin", () => api.backendApplyRecommended().then(() => undefined)).catch((e) => setError(errorText(e)))}>Use the recommended settings</button>}
      </div>
      <div className="tune-libs">
        {[...libs.entries()].map(([id, rows]) => {
          const off = rows.filter((r) => !r.ok).length;
          const open = openLib === id;
          return (
            <div key={id} className={`tune-lib ${open ? "open" : ""}`}>
              <button className="tune-lib-head link-plain" onClick={() => setOpenLib(open ? null : id)}>
                <span className={`chev ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
                <span className="strong">{rows[0].targetName}</span>
                <span className={`small ${off ? "warn" : "ok"}`}>{off ? `${off} to change` : "✓ all good"}</span>
              </button>
              {open && rows.map((r) => {
                const sw = TUNE_SWITCH[r.key];
                const on = sw ? sw.on(r.current) : false;
                return (
                  <div key={r.key} className={`tune-row ${r.ok ? "" : "differs"}`}>
                    <div className="grow">
                      <div>{r.label} <span className="muted small">· recommended {sw?.recommendedOn ? "on" : "off"}</span></div>
                      <div className="muted small">{r.detail}</div>
                    </div>
                    {sw && <input type="checkbox" className="switch" checked={on} disabled={!canEdit} onChange={(e) => set(r, sw.value(e.target.checked, status), `${r.targetName}: ${r.label.toLowerCase()} ${e.target.checked ? "on" : "off"}`)} />}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {tasks.length > 0 && (
        <>
          <div className="strong small">Jellyfin's scheduled tasks</div>
          <p className="muted small">Heavy tasks slow down the NAS and Infuse's library sync while they run. Best at night, or off when you don't need them.</p>
          <div className="tune-libs">
            {tasks.map((r) => {
              const isOff = Array.isArray(r.current) && r.current.length === 0;
              return (
                <div key={r.target} className="tune-row">
                  <div className="grow">
                    <div>{r.targetName} <span className={`small ${isOff ? "muted" : ""}`}>· {r.label}</span></div>
                    <div className="muted small">{r.detail}</div>
                  </div>
                  <button className="link small" disabled={!canEdit} onClick={() => void track(`Running “${r.targetName}”`, () => api.backendRunTask(r.target), { reload: false })}>Run now</button>
                  <input type="checkbox" className="switch" title={isOff ? "Off" : "On a schedule"} checked={!isOff} disabled={!canEdit} onChange={(e) => set(r, e.target.checked, `${r.targetName} ${e.target.checked ? "on" : "off"}`)} />
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="strong small">Infuse</div>
      <div className={`why-box ${t?.markersOk ? "sure" : ""}`}>
        <ul>
          <li className={t?.markersOk ? "ok" : "warn"}>
            {t ? (t.markersOk ? `Skip intro, credits and recap: Jellyfin ${t.version} hands Media Hub's markers to Infuse (Infuse 8.0.4 or newer).` : `Jellyfin ${t.version || "(unknown)"} is older than 10.10, so Infuse can't read skip markers from it. Update Jellyfin.`) : "Checking the Jellyfin version…"}
          </li>
          <li>Add the server in Infuse under Settings → Shares → Add → Jellyfin, signed in as the same user Media Hub watches as.</li>
          <li><b>Direct mode</b> is the fast one: Infuse browses Jellyfin live, nothing to sync. Library mode copies everything into Infuse first.</li>
          <li>Your collections and playlists: pin them to Infuse's home screen under Settings → Shares → your Jellyfin server → Add Favorite.</li>
          <li>Infuse shows what Media Hub set: titles, summaries, posters, backgrounds and logos come from Jellyfin, so edit them here, not in Infuse.</li>
          <li>Watched status and where you stopped sync both ways through Jellyfin.</li>
        </ul>
      </div>
    </Section>
  );
}

/* ---------------------------------------------------- library languages */

function LibraryLanguages({ canEdit }: { canEdit: boolean }) {
  const epoch = useEpoch();
  const [libs, setLibs] = useState<LibraryLang[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.libraryLanguages().then(setLibs).catch((e) => setError(errorText(e)));
  }, [epoch]);
  if (error) return <p className="muted small">Library languages: {error}</p>;
  if (!libs) return null;
  return (
    <div className="stack-s">
      <div className="strong small">Language per library</div>
      <p className="muted small">For example Dutch titles and summaries for Kids, English for the rest. Changing it fetches the texts again for that library (pictures stay).</p>
      {libs.filter((l) => l.kind !== "music" && l.kind !== "boxsets" && l.kind !== "playlists").map((l) => {
        const cur = META_LANGS.find(([lang]) => lang === l.language)?.[0] ?? l.language;
        return (
          <div key={l.id} className="lang-row">
            <span className="strong">{l.name}</span>
            <select value={cur} disabled={!canEdit} onChange={(e) => {
              const pick = META_LANGS.find(([lang]) => lang === e.target.value);
              if (!pick) return;
              void askConfirm(`Use ${pick[2]} for titles and summaries in “${l.name}” and fetch them again now? This can take a while on a big library.`, { okLabel: "Change and refresh" }).then((ok) => {
                if (ok) void track(`${l.name}: ${pick[2]} titles`, () => api.setLibraryLanguage(l.id, pick[0], pick[1], true));
              });
            }}>
              {META_LANGS.map(([lang, , label]) => <option key={lang} value={lang}>{label}</option>)}
              {!META_LANGS.some(([lang]) => lang === l.language) && <option value={l.language}>{l.language}</option>}
            </select>
          </div>
        );
      })}
    </div>
  );
}

function ScheduleSettings({ status }: { status: Status }) {
  const p = usePrefs();
  const s = p.schedule;
  const set = (patch: Partial<typeof s>) => setPrefs({ schedule: { ...s, ...patch } });
  return (
    <Section id="schedule" title="Daily tasks" icon="clock" hint={`Runs once a day while Media Hub is open. ${p.lastRun.daily ? `Last run: ${p.lastRun.daily}.` : "Not run yet."}`}>
      <div className="row">
        <Switch checked={s.enabled} onChange={(v) => set({ enabled: v })}>Run every day from</Switch>
        <select value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} style={{ width: 110 }} disabled={!s.enabled}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
        </select>
      </div>
      <div className="fields2">
        <label className="check small"><input type="checkbox" checked={s.scan} onChange={(e) => set({ scan: e.target.checked })} />Scan the library</label>
        <label className="check small"><input type="checkbox" checked={s.art} onChange={(e) => set({ art: e.target.checked })} />Fill in missing artwork (newest titles first)</label>
        <label className="check small"><input type="checkbox" checked={s.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} />Get missing subtitles (your Subtitles settings)</label>
      </div>
      <div className="row"><button onClick={() => void runDaily(status, true)}><Icon name="play" /> Run now</button></div>
      {status.readOnly && <p className="muted small">Artwork and subtitles need changes switched on.</p>}
    </Section>
  );
}

/* ------------------------------------------------------------ problems */

function ProblemsLog() {
  const list = useProblems();
  const [copied, setCopied] = useState(false);
  const text = () => list.map((p) => `${new Date(p.at).toISOString()}  ${p.what}: ${p.message}`).join("\n");
  return (
    <Section id="problems" title="Problems log" icon="warn" hint="The last 200 things that went wrong. Copy it into a message to get help.">
      <div className="row">
        <button disabled={!list.length} onClick={() => { void navigator.clipboard.writeText(`Media Hub problems log\n${navigator.userAgent}\n\n${text()}`).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); }); }}><Icon name="copy" /> {copied ? "Copied" : "Copy for Claude"}</button>
        <button disabled={!list.length} onClick={clearProblems}>Clear</button>
      </div>
      <div className="problem-list">
        {list.length === 0 && <p className="muted small">Nothing went wrong.</p>}
        {list.slice(0, 60).map((p, i) => (
          <div key={i} className="problem">
            <span className="muted small mono">{new Date(p.at).toLocaleString()}</span>
            <span className="strong small">{p.what}</span>
            <span className="small bad">{p.message}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

/**
 * "Keep it like this everywhere": the three things that make Jellyfin and Infuse show your
 * library the same way, now and after a reset. Names Jellyfin and Infuse both read, your
 * edits locked in Jellyfin, and details and pictures saved next to the video files (Infuse
 * reads those .nfo files too when it opens the share directly).
 */
function KeepInPlace({ t, canEdit, onChanged }: { t: { rows: TuneRow[]; lockEdits: boolean } | null; canEdit: boolean; onChanged: () => void }) {
  const [names, setNames] = useState<number | null>(null);
  useEffect(() => {
    api.namingCheckLast().then((r) => setNames(r ? r.rows.filter((x) => x.toRename + x.folders > 0).length : null)).catch(() => setNames(null));
  }, []);
  const files = t?.rows.filter((r) => r.scope === "library" && (r.key === "SaveLocalMetadata" || r.key === "MetadataSavers")) ?? [];
  const filesOk = !!t && files.every((r) => r.ok);
  const row = (ok: boolean | null, title: string, hint: string, action?: ReactNode) => (
    <div className={`keep-row ${ok === null ? "" : ok ? "ok" : "warn"}`}>
      <span className="keep-mark">{ok === null ? "–" : ok ? <Icon name="check" size={14} /> : "!"}</span>
      <div className="grow"><div className="strong small">{title}</div><div className="muted small">{hint}</div></div>
      {action}
    </div>
  );
  return (
    <div className="keep card-inner stack-s">
      <div className="strong">Keep it like this everywhere</div>
      <div className="muted small">So Jellyfin and Infuse show the same names, details and pictures, also after Jellyfin is reset or Infuse reads the folders directly.</div>
      {row(names === null ? null : names === 0, "Names Jellyfin and Infuse both read", names === null ? "Not checked yet." : names === 0 ? "Every file and folder follows the standard names." : `${names} title${names === 1 ? "" : "s"} still have names to fix.`,
        names !== 0 && <button onClick={() => nav.route({ view: "renamer" })}>Open the Renamer</button>)}
      {row(t ? t.lockEdits : null, "Your edits are locked in Jellyfin", "Jellyfin's own refreshes never undo what you changed.",
        t && !t.lockEdits && <button disabled={!canEdit} onClick={() => void api.setLockEdits(true).then(onChanged)}>Turn on</button>)}
      {row(t ? filesOk : null, "Details and pictures saved next to the files", "Jellyfin writes .nfo files and pictures beside each video. They survive a reset, and Infuse uses them when it opens the share directly.",
        t && !filesOk && <button className="primary" disabled={!canEdit} onClick={() => void track("Saving details next to the files", async () => {
          for (const r of files.filter((x) => !x.ok)) await api.backendSet(r.scope, r.target, r.key, r.recommended);
        }).then(onChanged).catch(() => undefined)}>Turn on</button>)}
      {t && filesOk && <div className="muted small">Titles get their files the next time Jellyfin refreshes them or you edit them here.</div>}
    </div>
  );
}
