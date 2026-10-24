import { FormEvent, useState } from "react";
import { api, errorText, Status } from "./api";

const STEPS = ["Connect to Jellyfin", "Library folder", "Data and safety", "Done"];

export default function Setup({ status, onDone }: { status: Status; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [url, setUrl] = useState(status.serverUrl ?? "");
  const [key, setKey] = useState("");
  const [server, setServer] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(status.libraryRoot);
  const [tmdb, setTmdb] = useState("");
  const [tmdbOk, setTmdbOk] = useState(false);
  const [lang, setLang] = useState("en-US");
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(status.problem);

  async function run(f: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const info = await api.connect(url, key);
      setKey("");
      setServer(`${info.serverName} · Jellyfin ${info.version}`);
      setStep(1);
    });
  };

  const finish = () =>
    run(async () => {
      await api.setTitleLang(lang);
      if (allow) await api.setReadOnly(false);
      setStep(3);
    });

  return (
    <div className="setup">
      <header className="setup-head"><div className="sb-brand"><span className="logo big" />Media Hub</div><span className="muted">· Set up</span></header>
      <div className="setup-body">
        <ol className="steps-list">
          {STEPS.map((s, i) => (
            <li key={s} className={i === step ? "on" : i < step ? "done" : ""}>
              <span className="step-dot">{i < step ? "✓" : i + 1}</span>{s}
            </li>
          ))}
        </ol>

        <section className="setup-main">
          {step === 0 && (
            <form className="stack" onSubmit={connect} autoComplete="off">
              <div>
                <h1>Connect to Jellyfin</h1>
                <p className="muted">Media Hub works next to your Jellyfin server. Infuse keeps reading from Jellyfin, so whatever you fix here shows up there.</p>
              </div>
              <div className="card form">
                <label>Server address
                  <input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.20:8096" spellCheck={false} autoFocus />
                </label>
                <label>API key
                  <input className="mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key here" spellCheck={false} />
                </label>
                <details>
                  <summary>Where do I get an API key?</summary>
                  <ol>
                    <li>Open Jellyfin in your browser and sign in as the admin.</li>
                    <li>Dashboard → Advanced → API Keys → the + button.</li>
                    <li>Name it “Media Hub” and copy the key it shows.</li>
                  </ol>
                  <p className="muted">The key is kept in this computer's secure storage (Keychain on Mac, Credential Manager on Windows), never in a file, and only sent to the address above.</p>
                </details>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="row end"><button className="primary" disabled={busy || !url.trim() || !key.trim()}>{busy ? "Connecting…" : "Connect"}</button></div>
            </form>
          )}

          {step === 1 && (
            <div className="stack">
              <div>
                <h1>Your library folder</h1>
                <p className="muted">Choose the NAS share as this computer sees it (for example /Volumes/media on a Mac, or a drive like M:\ on Windows). It's used by the renamer, intro detection and storage tools. Your NAS only stores files; the work happens on this computer.</p>
              </div>
              {server && <p className="note">Connected to {server}.</p>}
              <div className="card form">
                <div className="kv"><span className="muted">Folder</span><span className="mono">{root ?? "Not chosen yet"}</span></div>
                <div className="row"><button onClick={() => void run(async () => setRoot(await api.pickRoot()))}>{root ? "Choose another folder" : "Choose folder"}</button></div>
              </div>
              <div className="where">
                <div><div className="muted small">On the NAS</div><b>Your videos, nothing else</b></div>
                <div><div className="muted small">On this computer</div><b>Settings, cache and the undo list</b></div>
                <div><div className="muted small">In Jellyfin</div><b>Metadata, art and skip markers</b></div>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="row between">
                <span />
                <button className="primary" onClick={() => setStep(2)}>{root ? "Continue" : "Skip for now"}</button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="stack">
              <div>
                <h1>Data and safety</h1>
                <p className="muted">Both can be changed later in Settings.</p>
              </div>
              <div className="card form">
                <h2>TMDB (optional)</h2>
                <p className="muted small">With your own free TMDB key the renamer can match shows and movies in any language. Without it, Media Hub uses Jellyfin's lookups and TVmaze. Get a key at themoviedb.org → Settings → API.</p>
                <div className="row">
                  <label>TMDB API key or read access token<input className="mono" type="password" value={tmdb} onChange={(e) => { setTmdb(e.target.value); setTmdbOk(false); }} /></label>
                  <button disabled={!tmdb.trim() || busy} onClick={() => void run(async () => { await api.setTmdbKey(tmdb); setTmdbOk(true); setTmdb(""); })}>Check and save</button>
                </div>
                {tmdbOk && <p className="note">TMDB key saved.</p>}
                <label className="narrow wide-label">Language of titles and summaries
                  <select value={lang} onChange={(e) => setLang(e.target.value)}>
                    <option value="en-US">English</option>
                    <option value="nl-NL">Nederlands</option>
                    <option value="de-DE">Deutsch</option>
                    <option value="fr-FR">Français</option>
                    <option value="es-ES">Español</option>
                  </select>
                </label>
              </div>
              <div className="card form">
                <h2>Changes to Jellyfin</h2>
                <label className="check"><input type="radio" checked={!allow} onChange={() => setAllow(false)} /><span><b>Read-only for now</b> · look around first; nothing in Jellyfin changes</span></label>
                <label className="check"><input type="radio" checked={allow} onChange={() => setAllow(true)} /><span><b>Allow changes</b> · edit metadata, art, subtitles and skip markers; every change can be undone</span></label>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="row between">
                <button onClick={() => setStep(1)}>Back</button>
                <button className="primary" disabled={busy} onClick={() => void finish()}>Continue</button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="stack">
              <div>
                <h1>All set</h1>
                <p className="muted">Media Hub will now read your library from Jellyfin. That takes a moment the first time.</p>
              </div>
              <div className="row end"><button className="primary" onClick={onDone}>Open my library</button></div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
