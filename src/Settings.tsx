import { useEffect, useState } from "react";
import { api, errorText, Status } from "./api";
import { askConfirm } from "./confirm";
import { SubLangSettings } from "./Subtitles";
import { ToolsSettings } from "./Intros";
import { UpdateSettings } from "./Updates";
import type { View } from "./App";

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

      <SubLangSettings subLangs={status.subLangs} onChanged={onChanged} />
      <ToolsSettings />
      <UpdateSettings />

      <p className="muted small">Your Jellyfin API key and TMDB key are kept in this computer's secure storage, never in a file.</p>
    </div>
  );
}
