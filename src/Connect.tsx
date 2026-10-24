import { FormEvent, useState } from "react";
import { api, errorText, Status } from "./api";

export default function Connect({ status, onConnected }: { status: Status; onConnected: () => void }) {
  const [url, setUrl] = useState(status.serverUrl ?? "");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(status.problem);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.connect(url, key);
      setKey("");
      onConnected();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card connect" onSubmit={submit} autoComplete="off">
        <div className="brand"><span className="logo" />Media Hub</div>
        <h1>Connect to Jellyfin</h1>
        <p className="muted">
          This app only reads your library for now. It cannot change anything on the server.
        </p>

        <label>
          Server address
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://192.168.1.20:8096"
            spellCheck={false}
            autoFocus
          />
        </label>

        <label>
          API key
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste the key here"
            spellCheck={false}
          />
        </label>

        <details>
          <summary>Where do I get an API key?</summary>
          <ol>
            <li>Open Jellyfin in your browser and sign in as the admin.</li>
            <li>Dashboard → Advanced → API Keys → the + button.</li>
            <li>Name it “Media Hub”, then copy the key it shows.</li>
          </ol>
          <p className="muted">
            The key is stored in your computer’s own secure storage (Keychain on Mac, Credential
            Manager on Windows), never in a file, and is only ever sent to the address above.
          </p>
        </details>

        {error && <p className="error" role="alert">{error}</p>}

        <button className="primary" disabled={busy || !url.trim() || !key.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}
