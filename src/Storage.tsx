import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Change, errorText, FileRow, Status } from "./api";
import { askConfirm } from "./confirm";
import { fmt } from "./Intros";
import { cancel, clearDone, enqueue, useQueue } from "./storageStore";
import type { View } from "./App";

const gb = (b: number) => `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`;
const ENCODER_LABEL: Record<string, string> = {
  hevc_videotoolbox: "Apple graphics (fast)",
  hevc_nvenc: "NVIDIA graphics (fast)",
  hevc_amf: "AMD graphics (fast)",
  hevc_qsv: "Intel graphics (fast)",
  libx265: "Processor (slow, smallest files)",
};

/** Rough guess: H.265 needs about 55% of H.264's size at similar quality. */
function estimate(r: FileRow): number {
  if (!r.info || r.info.videoCodec === "hevc" || r.info.hdr) return 0;
  const factor = r.info.videoCodec === "h264" ? 0.45 : 0.6;
  return r.info.size * factor;
}

export default function Storage({ status }: { status: Status; onNav: (v: View) => void }) {
  const [base, setBase] = useState("");
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [rows, setRows] = useState<FileRow[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [encoders, setEncoders] = useState<string[]>([]);
  const [encoder, setEncoder] = useState("");
  const [quality, setQuality] = useState(3);
  const [target, setTarget] = useState(-20);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [trash, setTrash] = useState<{ files: number; bytes: number } | null>(null);
  const [history, setHistory] = useState<Change[]>([]);
  const queue = useQueue();

  const refreshSide = useCallback(() => {
    api.trashInfo().then(setTrash).catch(() => setTrash(null));
    api.storageHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!status.libraryRoot) return;
    api.folders(base).then(setFolders).catch((e) => setMessage({ text: errorText(e), error: true }));
  }, [base, status.libraryRoot]);

  useEffect(() => {
    api.hevcEncoders()
      .then((e) => {
        setEncoders(e);
        setEncoder(e[0] ?? "");
      })
      .catch(() => setEncoders([]));
    refreshSide();
  }, [refreshSide]);

  // Refresh the trash size when a job finishes.
  const finished = queue.filter((q) => q.state === "done").length;
  useEffect(() => refreshSide(), [finished, refreshSide]);

  async function scan() {
    setBusy("Reading files…");
    setMessage(null);
    setPicked(new Set());
    try {
      setRows(await api.storageScan(base));
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  const totals = useMemo(() => {
    const list = rows ?? [];
    return {
      size: list.reduce((a, r) => a + (r.info?.size ?? 0), 0),
      saving: list.filter((r) => picked.has(r.rel)).reduce((a, r) => a + estimate(r), 0),
    };
  }, [rows, picked]);

  const toggle = (rel: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });

  async function start(mode: "hevc" | "loudness") {
    const list = [...picked];
    if (!list.length) return;
    const what = mode === "hevc" ? `Shrink ${list.length} file(s) to H.265 with ${ENCODER_LABEL[encoder] ?? encoder}?` : `Even out the loudness of ${list.length} file(s) to ${target} LUFS?`;
    const ok = await askConfirm(
      `${what} Each original moves to a hidden trash folder on the NAS when the new file checks out, so you can undo it. This takes a while and reads every file in full.`,
      { okLabel: "Start" },
    );
    if (!ok) return;
    enqueue(list.map((rel) => ({ rel, mode, encoder: mode === "hevc" ? encoder : null, quality: mode === "hevc" ? quality : null, targetLufs: mode === "loudness" ? target : null })));
    setPicked(new Set());
  }

  async function undo(c: Change) {
    if (!(await askConfirm(`Put the original of “${c.target}” back?`, { okLabel: "Undo" }))) return;
    try {
      await api.undoChange(c.id);
      setMessage({ text: "Original restored. The new file was moved into the trash folder.", error: false });
      refreshSide();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  async function emptyTrash() {
    if (!trash?.files) return;
    const ok = await askConfirm(`Permanently delete ${trash.files} original file(s) (${gb(trash.bytes)}) from the trash folder? This cannot be undone.`, {
      okLabel: "Delete forever",
      danger: true,
      requireText: "DELETE",
    });
    if (!ok) return;
    try {
      await api.trashEmpty("DELETE");
      refreshSide();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  const crumbs = base ? base.split("/") : [];

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />Media Hub</div>
      </header>
      {!status.libraryRoot ? (
        <main><p className="muted">Choose your library folder first (Renamer or Settings).</p></main>
      ) : (
        <div className="split">
          <aside className="card side">
            <div className="crumbs">
              <button className="link" onClick={() => setBase("")}>Library</button>
              {crumbs.map((c, i) => (
                <span key={i}> / <button className="link" onClick={() => setBase(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>
              ))}
            </div>
            <button className="primary" disabled={!!busy} onClick={() => void scan()}>{busy ?? "Scan this folder"}</button>
            <ul className="folders">
              {folders.map((f) => (
                <li key={f.name}>
                  <button className="pick" onClick={() => { setBase(base ? `${base}/${f.name}` : f.name); setRows(null); }}>{f.name}</button>
                </li>
              ))}
            </ul>
            {trash && (
              <div className="small">
                <div className="muted">Trash folder: {trash.files} file(s), {gb(trash.bytes)}</div>
                <button className="link" disabled={!trash.files} onClick={() => void emptyTrash()}>Empty trash…</button>
              </div>
            )}
          </aside>

          <main className="work">
            {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

            {rows && (
              <section className="card form">
                <div className="toolbar">
                  <div className="muted small">{rows.length} videos · {gb(totals.size)}</div>
                  <div className="row">
                    <button className="link" onClick={() => setPicked(new Set(rows.filter((r) => estimate(r) > 0).map((r) => r.rel)))}>Select all that can shrink</button>
                    <button className="link" onClick={() => setPicked(new Set())}>Select none</button>
                  </div>
                </div>
                <div className="table">
                  {rows.map((r) => (
                    <label className="op filerow" key={r.rel}>
                      <input type="checkbox" checked={picked.has(r.rel)} onChange={() => toggle(r.rel)} disabled={!r.info} />
                      <div className="names">
                        <div className="mono small">{r.rel}</div>
                        <div className="small muted">
                          {r.info
                            ? `${r.info.videoCodec.toUpperCase()} ${r.info.width}×${r.info.height}${r.info.hdr ? " HDR" : ""} · ${r.info.audioCodec} ${r.info.audioChannels}ch · ${fmt(r.info.duration)} · ${gb(r.info.size)} · ${(r.info.bitrate / 1e6).toFixed(1)} Mb/s`
                            : r.problem}
                        </div>
                      </div>
                      {estimate(r) > 0 && <span className="chip static">save ~{gb(estimate(r))}</span>}
                    </label>
                  ))}
                </div>

                <div className="row">
                  <label className="narrow wide-label">Encoder
                    <select value={encoder} onChange={(e) => setEncoder(e.target.value)}>
                      {encoders.map((e) => <option key={e} value={e}>{ENCODER_LABEL[e] ?? e}</option>)}
                      {!encoders.length && <option value="">No H.265 encoder found</option>}
                    </select>
                  </label>
                  <label className="narrow wide-label">Quality
                    <select value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
                      <option value={1}>1 · smallest</option>
                      <option value={2}>2</option>
                      <option value={3}>3 · balanced</option>
                      <option value={4}>4</option>
                      <option value={5}>5 · best</option>
                    </select>
                  </label>
                  <button className="primary" disabled={!picked.size || !encoder} onClick={() => void start("hevc")}>
                    Shrink {picked.size || ""} to H.265{totals.saving ? ` (save ~${gb(totals.saving)})` : ""}
                  </button>
                </div>
                <div className="row">
                  <label className="narrow wide-label">Loudness target
                    <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                      <option value={-16}>−16 LUFS (louder, like streaming music)</option>
                      <option value={-20}>−20 LUFS (good for TV at home)</option>
                      <option value={-23}>−23 LUFS (broadcast standard)</option>
                      <option value={-27}>−27 LUFS (cinema-like, quiet)</option>
                    </select>
                  </label>
                  <button disabled={!picked.size} onClick={() => void start("loudness")}>Even out loudness of {picked.size || ""}</button>
                </div>
                <p className="muted small">Loudness only changes the volume (no compression), and peaks are kept below −1 dB so nothing clips. HDR and already-H.265 files are skipped.</p>
              </section>
            )}

            {queue.length > 0 && (
              <section className="card history">
                <div className="row"><h2>Jobs</h2><div className="spacer" /><button className="link" onClick={clearDone}>Clear finished</button></div>
                {queue.map((q) => (
                  <div className="batch job" key={q.key}>
                    <div className="job-main">
                      <div className="mono small">{q.job.mode === "hevc" ? "H.265 · " : "Loudness · "}{q.job.rel}</div>
                      <div className="progress"><span style={{ width: `${Math.max(2, q.percent)}%` }} className={q.state} /></div>
                      <div className="muted small">{q.state === "running" ? `${q.percent.toFixed(0)}% · ` : ""}{q.text}</div>
                    </div>
                    {(q.state === "running" || q.state === "waiting") && <button onClick={() => cancel(q.key)}>Cancel</button>}
                  </div>
                ))}
              </section>
            )}

            {history.length > 0 && (
              <section className="card history">
                <h2>Replaced files</h2>
                {history.map((c) => (
                  <div className="batch" key={c.id}>
                    <div>
                      <div className="mono small">{c.target}</div>
                      <div className="muted small">{new Date(c.at * 1000).toLocaleString()}</div>
                    </div>
                    <div className="spacer" />
                    {c.undone ? <span className="muted small">Restored</span> : <button onClick={() => void undo(c)}>Put original back</button>}
                  </div>
                ))}
              </section>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
