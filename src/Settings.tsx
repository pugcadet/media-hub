import { useEffect, useState } from "react";
import { api, errorText, Status } from "./api";
import { askConfirm } from "./confirm";
import { SubLangSettings } from "./Subtitles";
import { ToolsSettings } from "./Intros";
import { UpdateSettings } from "./Updates";
import type { View } from "./nav";
import { setPrefs, usePrefs } from "./prefs";
import { SubStyleEditor } from "./Player";
import { runDaily } from "./scheduler";

const TITLE_LANGS: [string, string][] = [["en-US", "English"], ["nl-NL", "Nederlands"], ["de-DE", "Deutsch"], ["fr-FR", "Français"], ["es-ES", "Español"], ["it-IT", "Italiano"]];

export default function Settings({ status, onChanged }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [users, setUsers] = useState<{ id: string; name: string; admin: boolean }[]>([]);
  const [tmdb, setTmdb] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

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
    if (!(await askConfirm("Disconnect from this server? The saved key and the local list are removed from this computer. Your server is not touched.", { okLabel: "Disconnect" }))) return;
    void run(() => api.disconnect());
  }

  return (
    <div className="pg settings">
      <div className="pg-head"><h1>Settings</h1></div>
      {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

      <section className="card form">
        <h2>Jellyfin</h2>
        <div className="kv"><span className="muted">Server</span><span>{status.serverName ?? "—"}</span></div>
        <div className="kv"><span className="muted">Address</span><span className="mono">{status.serverUrl ?? "—"}</span></div>
        <div className="kv"><span className="muted">Library</span><span>{status.movies} movies · {status.series} shows</span></div>
        <label className="wide-label">Watch as this user (resume points, watched status, picks)
          <select value={status.userId ?? ""} onChange={(e) => void run(() => api.setUser(e.target.value), "User changed. Press Scan library to refresh watched status.")} disabled={!users.length || busy}>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.admin ? " (admin)" : ""}</option>)}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={status.syncWatched} onChange={(e) => void run(() => api.setSyncWatched(e.target.checked))} />
          <span>Send where I stopped and what I watched back to Jellyfin, so Infuse continues at the same spot</span>
        </label>
        <div className="row"><button onClick={() => void disconnect()}>Disconnect</button></div>
      </section>

      <section className="card form">
        <h2>Changes to Jellyfin</h2>
        <p className="muted">
          {status.readOnly
            ? "Off. Media Hub only reads from Jellyfin. Turn this on to fix metadata, pick artwork, manage collections, download subtitles and save intro/credits markers."
            : "On. Media Hub may change metadata, pictures, collections, subtitles and skip markers in Jellyfin. Each change can be undone."}
        </p>
        <div className="row">
          {status.readOnly ? (
            <button className="primary" onClick={() => void toggleChanges(true)}>Allow changes</button>
          ) : (
            <button onClick={() => void toggleChanges(false)}>Switch back to read-only</button>
          )}
        </div>
      </section>

      <section className="card form">
        <h2>Library folder</h2>
        <p className="muted small">The NAS share as this computer sees it. Used by the renamer and intro detection.</p>
        <p className="mono">{status.libraryRoot ?? "Not chosen yet"}</p>
        <div className="row"><button onClick={() => void run(async () => { await api.pickRoot(); })}>{status.libraryRoot ? "Change folder" : "Choose folder"}</button></div>
      </section>

      <section className="card form">
        <h2>Online metadata</h2>
        <p className="muted small">
          {status.hasTmdb ? "A TMDB key is saved. The renamer matches with TMDB in the language below." : "Without a TMDB key, the renamer uses your Jellyfin library, Jellyfin's own lookups and TVmaze. With a free key (themoviedb.org → Settings → API) it matches with TMDB in any language."}
        </p>
        <div className="row">
          <label>{status.hasTmdb ? "Replace TMDB key" : "TMDB API key or read access token"}<input className="mono" type="password" value={tmdb} onChange={(e) => setTmdb(e.target.value)} /></label>
          <button disabled={!tmdb.trim() || busy} onClick={() => void run(async () => { await api.setTmdbKey(tmdb); setTmdb(""); }, "TMDB key checked and saved.")}>Check and save</button>
          {status.hasTmdb && <button disabled={busy} onClick={() => void run(() => api.setTmdbKey(""), "TMDB key removed.")}>Remove key</button>}
        </div>
        <label className="wide-label">Language of titles and summaries
          <select value={status.titleLang} onChange={(e) => void run(() => api.setTitleLang(e.target.value))}>
            {TITLE_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </section>

      <PlayerSettings status={status} />
      <SubSkipSettings status={status} />
      <ScheduleSettings status={status} />
      <SubLangSettings subLangs={status.subLangs} onChanged={onChanged} />
      <ToolsSettings />
      <UpdateSettings />

      <p className="muted small">Your Jellyfin API key and TMDB key are kept in this computer's secure storage, never in a file.</p>
    </div>
  );
}

function PlayerSettings({ status }: { status: Status }) {
  const p = usePrefs();
  return (
    <section className="card form">
      <h2>Player</h2>
      <label className="check"><input type="checkbox" checked={p.autoSkipIntro} onChange={(e) => setPrefs({ autoSkipIntro: e.target.checked })} /><span>Skip intros by themselves (a 3-second countdown on the button, press “Watch it” to stay)</span></label>
      <label className="check"><input type="checkbox" checked={p.autoSkipCredits} onChange={(e) => setPrefs({ autoSkipCredits: e.target.checked })} /><span>Skip credits: go to the next episode after 5 seconds (or skip to the end of a movie's credits)</span></label>
      <label className="check"><input type="checkbox" checked={p.upNextAutoplay} onChange={(e) => setPrefs({ upNextAutoplay: e.target.checked })} /><span>Play the next episode by itself when the credits start</span></label>
      <label className="check"><input type="checkbox" checked={p.autoDetectIntros} onChange={(e) => setPrefs({ autoDetectIntros: e.target.checked })} /><span>When I play a season without intro markers, find them in the background (needs ffmpeg; only sure finds are saved)</span></label>
      <label className="check"><input type="checkbox" checked={p.recapsOff} onChange={(e) => setPrefs({ recapsOff: e.target.checked })} /><span>Turn recaps off completely (no recap markers in the player or the intros tool). Remove saved ones with “Remove recaps” on a season or show.</span></label>
      <label className="wide-label">Language that C switches on (and fetches when missing)
        <select value={p.subLang} onChange={(e) => setPrefs({ subLang: e.target.value })}>
          {[...new Set(["eng", ...status.subLangs])].map((l) => <option key={l} value={l}>{l === "eng" ? "English" : l === "dut" || l === "nld" ? "Dutch" : l}</option>)}
        </select>
      </label>
      <div className="strong small">Subtitle look</div>
      <SubStyleEditor />
    </section>
  );
}

function ScheduleSettings({ status }: { status: Status }) {
  const p = usePrefs();
  const s = p.schedule;
  const set = (patch: Partial<typeof s>) => setPrefs({ schedule: { ...s, ...patch } });
  return (
    <section className="card form">
      <h2>Scheduled tasks</h2>
      <p className="muted small">Runs once a day while Media Hub is open. {p.lastRun.daily ? `Last run: ${p.lastRun.daily}.` : "Not run yet."}</p>
      <label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => set({ enabled: e.target.checked })} /><span>Run these every day from</span>
        <select value={s.hour} onChange={(e) => set({ hour: Number(e.target.value) })} style={{ width: 100 }} disabled={!s.enabled}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
        </select>
      </label>
      <div className="fields2">
        <label className="check small"><input type="checkbox" checked={s.scan} onChange={(e) => set({ scan: e.target.checked })} />Scan the library</label>
        <label className="check small"><input type="checkbox" checked={s.picks} onChange={(e) => set({ picks: e.target.checked })} />Update “Picks of the day” in Jellyfin</label>
        <label className="check small"><input type="checkbox" checked={s.art} onChange={(e) => set({ art: e.target.checked })} />Fill in missing artwork (newest titles first)</label>
        <label className="check small"><input type="checkbox" checked={s.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} />Get missing subtitles (only score {p.minSubScore}+)</label>
      </div>
      <div className="row">
        <label className="narrow wide-label">Minimum subtitle score
          <input type="number" min={1} max={100} value={p.minSubScore} onChange={(e) => setPrefs({ minSubScore: Math.max(1, Math.min(100, Number(e.target.value) || 100)) })} />
        </label>
        <button onClick={() => void runDaily(status, true)}>Run now</button>
      </div>
      {status.readOnly && <p className="muted small">Artwork, subtitles and picks need changes switched on (above).</p>}
    </section>
  );
}

function SubSkipSettings({ status }: { status: Status }) {
  const p = usePrefs();
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [base, setBase] = useState("");
  const [custom, setCustom] = useState("");
  useEffect(() => {
    if (status.libraryRoot) api.folders(base).then(setFolders).catch(() => setFolders([]));
  }, [status.libraryRoot, base]);
  const toggle = (f: string) =>
    setPrefs({ subSkipFolders: p.subSkipFolders.includes(f) ? p.subSkipFolders.filter((x) => x !== f) : [...p.subSkipFolders, f] });
  const rel = (n: string) => (base ? `${base}/${n}` : n);
  return (
    <section className="card form">
      <h2>Subtitle downloads</h2>
      <p className="muted small">Folders the subtitle downloader leaves alone (the Subtitles screen, “Get missing subtitles” and the daily task). Handy for kids' shows, home videos or foreign-language folders.</p>
      {p.subSkipFolders.length > 0 && (
        <div className="chips">
          {p.subSkipFolders.map((f) => <span key={f} className="chip static on">{f}<button className="link x" onClick={() => toggle(f)} aria-label="Remove">×</button></span>)}
        </div>
      )}
      {status.libraryRoot && (
        <div className="skip-picker">
          <div className="small muted">
            <button className="link" onClick={() => setBase("")}>Library folder</button>
            {base && base.split("/").map((part, i, all) => <span key={i}> › <button className="link" onClick={() => setBase(all.slice(0, i + 1).join("/"))}>{part}</button></span>)}
          </div>
          {folders.map((f) => (
            <div key={f.name} className="skip-row">
              <label className="check small"><input type="checkbox" checked={p.subSkipFolders.includes(rel(f.name))} onChange={() => toggle(rel(f.name))} />{f.name}</label>
              <button className="link small" onClick={() => setBase(rel(f.name))}>open ›</button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <label>Or type part of a path<input value={custom} placeholder="e.g. Kids or Anime" onChange={(e) => setCustom(e.target.value)} /></label>
        <button disabled={!custom.trim()} onClick={() => { toggle(custom.trim()); setCustom(""); }}>Add</button>
      </div>
    </section>
  );
}
