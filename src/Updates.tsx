import { useEffect, useState } from "react";
import { api, errorText } from "./api";
import { askConfirm } from "./confirm";

type Info = { current: string; latest: string | null; available: boolean; notes: string };

async function install(info: Info): Promise<void> {
  const mac = navigator.userAgent.includes("Mac");
  const ok = await askConfirm(
    `Update Media Hub from ${info.current} to ${info.latest}? ${mac ? "The app downloads the new version, checks it, replaces itself and restarts." : "The app downloads the installer, checks it and starts it; Media Hub closes while it installs."}`,
    { okLabel: "Update now" },
  );
  if (ok) await api.installUpdate();
}

/** Settings block: current version and a manual check. */
export function UpdateSettings() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = () => {
    setBusy("Checking…");
    setError(null);
    api.checkUpdate().then(setInfo).catch((e) => setError(errorText(e))).finally(() => setBusy(null));
  };
  useEffect(check, []);
  return (
    <section className="card form">
      <h2>Updates</h2>
      <div className="kv"><span className="muted">This version</span><span>{info?.current ?? "—"}</span></div>
      {info && <div className="kv"><span className="muted">Newest</span><span>{info.latest ?? "—"}{info.available ? " · update available" : " · you're up to date"}</span></div>}
      {info?.available && info.notes && <p className="muted small" style={{ whiteSpace: "pre-wrap" }}>{info.notes.slice(0, 600)}</p>}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={!!busy} onClick={check}>{busy === "Checking…" ? "Checking…" : "Check for updates"}</button>
        {info?.available && (
          <button className="primary" disabled={!!busy} onClick={() => {
            setBusy("Updating…");
            install(info).catch((e) => setError(errorText(e))).finally(() => setBusy(null));
          }}>{busy === "Updating…" ? "Downloading…" : `Update to ${info.latest}`}</button>
        )}
      </div>
    </section>
  );
}

/** Small card in the sidebar when a new version is out. */
export function UpdateBadge() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.checkUpdate().then(setInfo).catch(() => setInfo(null));
  }, []);
  if (!info?.available) return null;
  return (
    <div className="update-card">
      <div className="strong small">Update available · {info.latest}</div>
      {error && <div className="error small">{error}</div>}
      <button className="primary" disabled={busy} onClick={() => {
        setBusy(true);
        install(info).catch((e) => setError(errorText(e))).finally(() => setBusy(false));
      }}>{busy ? "Updating…" : "Update now"}</button>
    </div>
  );
}

/** Shown once after start when a new version is out (bottom right, every part of the app). */
export function UpdateToast() {
  const [info, setInfo] = useState<Info | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => api.checkUpdate().then(setInfo).catch(() => setInfo(null)), 4000);
    return () => window.clearTimeout(t);
  }, []);
  if (!info?.available || hidden) return null;
  return (
    <div className="update-toast" role="status">
      <div className="strong">Media Hub {info.latest} is out</div>
      <div className="muted small">You have {info.current}.{info.notes ? <> <button className="link small" onClick={() => setNotes(!notes)}>{notes ? "Hide" : "What's new"}</button></> : null}</div>
      {notes && <div className="small update-notes">{info.notes.slice(0, 800)}</div>}
      {error && <div className="error small">{error}</div>}
      <div className="row end">
        <button onClick={() => setHidden(true)}>Later</button>
        <button className="primary" disabled={busy} onClick={() => {
          setBusy(true);
          install(info).catch((e) => setError(errorText(e))).finally(() => setBusy(false));
        }}>{busy ? "Updating…" : "Update now"}</button>
      </div>
    </div>
  );
}
