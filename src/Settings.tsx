import { useState } from "react";
import { api, errorText, Status } from "./api";
import Nav from "./Nav";
import { askConfirm } from "./confirm";
import { SubLangSettings } from "./Subtitles";
import { ToolsSettings } from "./Intros";
import type { View } from "./App";

export default function Settings({ status, onChanged, onNav }: { status: Status; onChanged: () => void; onNav: (v: View) => void }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  async function toggleChanges(allow: boolean) {
    if (allow && !(await askConfirm(
      "Allow Media Hub to change metadata, pictures, subtitles and skip markers in Jellyfin? Every change is saved first, so you can undo it from the item's page. Your video files are not touched by this setting.",
      { okLabel: "Allow changes" },
    ))) return;
    try {
      await api.setReadOnly(!allow);
      onChanged();
      setMessage({ text: allow ? "Changes to Jellyfin are now allowed." : "Media Hub is read-only again.", error: false });
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  async function chooseRoot() {
    try {
      if (await api.pickRoot()) onChanged();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  async function disconnect() {
    if (!(await askConfirm("Disconnect from this server? The saved key and the local list are removed from this computer. Your server is not touched.", { okLabel: "Disconnect" }))) return;
    try {
      await api.disconnect();
      onChanged();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />Media Hub</div>
        <Nav current="settings" onNav={onNav} />
      </header>
      <main className="settings">
        {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

        <section className="card form">
          <h2>Jellyfin</h2>
          <div className="kv"><span className="muted">Server</span><span>{status.serverName ?? "—"}</span></div>
          <div className="kv"><span className="muted">Address</span><span className="mono">{status.serverUrl ?? "—"}</span></div>
          <div className="kv"><span className="muted">Library</span><span>{status.movies} movies · {status.series} shows</span></div>
          <div className="row"><button onClick={() => void disconnect()}>Disconnect</button></div>
        </section>

        <section className="card form">
          <h2>Changes to Jellyfin</h2>
          <p className="muted">
            {status.readOnly
              ? "Off. Media Hub only reads from Jellyfin. Turn this on to edit metadata, pick artwork and identify titles."
              : "On. Media Hub may change metadata and pictures in Jellyfin. Each change can be undone on the item's page."}
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
          <h2>Library folder (for renaming)</h2>
          <p className="mono">{status.libraryRoot ?? "Not chosen yet"}</p>
          <div className="row"><button onClick={() => void chooseRoot()}>{status.libraryRoot ? "Change folder" : "Choose folder"}</button></div>
        </section>

        <SubLangSettings subLangs={status.subLangs} onChanged={onChanged} />

        <ToolsSettings />

        <p className="muted small">Media Hub 0.5 · your API key is kept in this computer's secure storage.</p>
      </main>
    </div>
  );
}
