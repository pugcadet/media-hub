// Storage: every video as Jellyfin knows it (fast, no file is opened), with what's unusually
// big for its picture size, what could shrink to H.265, and audio or subtitle tracks in
// languages you don't use. Jobs run ffmpeg on this computer; originals go to a trash folder
// in the library, so every job can be undone.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Change, errorText, OverviewRow, Status } from "./api";
import { askConfirm } from "./confirm";
import { fmt } from "./Intros";
import { cancel, clearDone, enqueue, useQueue } from "./storageStore";
import type { View } from "./nav";
import { Icon } from "./ui";
import { savePart, shrinkEstimate, storageSummary } from "./scan";
import { usePageState } from "./saved";

const gb = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`);
const ENCODER_LABEL: Record<string, string> = {
  hevc_videotoolbox: "Apple graphics (fast)",
  hevc_nvenc: "NVIDIA graphics (fast)",
  hevc_amf: "AMD graphics (fast)",
  hevc_qsv: "Intel graphics (fast)",
  libx265: "Processor (slow, smallest files)",
};
type Filter = "all" | "big" | "shrink" | "audio" | "subs";
const res = (h: number) => (h >= 1600 ? "4K" : h >= 900 ? "1080p" : h >= 600 ? "720p" : h ? `${h}p` : "");
const extraOf = (r: OverviewRow, kind: "audio" | "subtitle") => r.tracks.filter((t) => t.kind === kind && t.extra);

export default function Storage({ status }: { status: Status; onNav: (v: View) => void }) {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [filter, setFilter] = usePageState<Filter>("storage.filter", "big");
  const [folder, setFolder] = usePageState("storage.folder", "");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(200);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [encoders, setEncoders] = useState<string[]>([]);
  const [encoder, setEncoder] = useState("");
  const [quality, setQuality] = useState(3);
  const [target, setTarget] = useState(-20);
  const [stripAudio, setStripAudio] = useState(true);
  const [stripSubs, setStripSubs] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [trash, setTrash] = useState<{ files: number; bytes: number } | null>(null);
  const [trashFiles, setTrashFiles] = useState<{ rel: string; bytes: number; at: number }[] | null>(null);
  const [history, setHistory] = useState<Change[]>([]);
  const queue = useQueue();

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const r = await api.storageOverview(status.subLangs);
      setRows(r);
      savePart("storage", storageSummary(r));
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setLoading(false);
    }
  }, [status.subLangs]);

  const refreshSide = useCallback(() => {
    api.trashInfo().then(setTrash).catch(() => setTrash(null));
    api.storageHistory().then(setHistory).catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    void load();
    api.hevcEncoders()
      .then((e) => {
        setEncoders(e);
        setEncoder(e[0] ?? "");
      })
      .catch(() => setEncoders([]));
    refreshSide();
  }, [load, refreshSide]);

  // When a job finishes: trash size, history and the list (sizes changed).
  const finished = queue.filter((q) => q.state === "done").length;
  useEffect(() => {
    refreshSide();
    if (finished) void load();
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = rows ?? [];
  const folders = useMemo(() => [...new Set(all.map((r) => r.folder).filter(Boolean))].sort(), [all]);
  const inFolder = all.filter((r) => !folder || r.folder === folder);
  const match: Record<Filter, (r: OverviewRow) => boolean> = {
    all: () => true,
    big: (r) => r.big,
    shrink: (r) => r.canShrink && r.size > 1e9,
    audio: (r) => extraOf(r, "audio").length > 0,
    subs: (r) => extraOf(r, "subtitle").length > 0,
  };
  const shown = inFolder.filter(match[filter]).filter((r) => !query || r.name.toLowerCase().includes(query.toLowerCase()) || r.rel.toLowerCase().includes(query.toLowerCase()));
  const sum = (list: OverviewRow[]) => list.reduce((n, r) => n + r.size, 0);
  const tiles: { id: Filter; label: string; count: number; detail: string }[] = [
    { id: "big", label: "Unusually big", count: inFolder.filter(match.big).length, detail: gb(sum(inFolder.filter(match.big))) },
    { id: "shrink", label: "Could shrink (H.264 → H.265)", count: inFolder.filter(match.shrink).length, detail: `save ~${gb(inFolder.filter(match.shrink).reduce((n, r) => n + shrinkEstimate(r), 0))}` },
    { id: "audio", label: "Extra audio tracks", count: inFolder.filter(match.audio).length, detail: "other languages" },
    { id: "subs", label: "Extra built-in subtitles", count: inFolder.filter(match.subs).length, detail: "other languages" },
    { id: "all", label: "All videos", count: inFolder.length, detail: gb(sum(inFolder)) },
  ];
  const pickedRows = all.filter((r) => picked.has(r.id));
  const saving = pickedRows.reduce((n, r) => n + shrinkEstimate(r), 0);
  const canEdit = !status.readOnly;

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function start(mode: "hevc" | "loudness" | "strip") {
    const list = pickedRows.filter((r) => r.rel);
    if (!list.length) return;
    const what =
      mode === "hevc" ? `Shrink ${list.length} file(s) to H.265 with ${ENCODER_LABEL[encoder] ?? encoder}?`
      : mode === "strip" ? `Take ${[stripAudio && "audio tracks", stripSubs && "built-in subtitles"].filter(Boolean).join(" and ")} in other languages out of ${list.length} file(s)? The original audio and tracks without a language always stay. Nothing is re-encoded.`
      : `Even out the loudness of ${list.length} file(s) to ${target} LUFS?`;
    const ok = await askConfirm(`${what} Each original moves to the trash folder in your library when the new file checks out, so you can undo it.`, { okLabel: "Start" });
    if (!ok) return;
    enqueue(list.map((r) => ({
      rel: r.rel, mode,
      encoder: mode === "hevc" ? encoder : null,
      quality: mode === "hevc" ? quality : null,
      targetLufs: mode === "loudness" ? target : null,
      keepLangs: status.subLangs, stripAudio, stripSubs,
    })));
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
    const ok = await askConfirm(`Permanently delete these ${trash.files} file(s) (${gb(trash.bytes)}) from the trash folder? This cannot be undone.`, { okLabel: "Delete forever", danger: true, requireText: "DELETE" });
    if (!ok) return;
    try {
      await api.trashEmpty("DELETE");
      setTrashFiles(null);
      refreshSide();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    }
  }

  if (!status.libraryRoot) return <p className="muted">Choose your library folder first (Renamer or Settings).</p>;

  return (
    <div className="stack storage-page">
      {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

      <div className="storage-tiles">
        {tiles.map((t) => (
          <button key={t.id} className={`storage-tile ${filter === t.id ? "on" : ""} ${t.id !== "all" && t.count ? "has" : ""}`} onClick={() => { setFilter(t.id); setPicked(new Set()); setLimit(200); }}>
            <span className="small muted">{t.label}</span>
            <span className="storage-tile-n">{rows ? t.count.toLocaleString() : "–"}</span>
            <span className="small muted">{rows ? t.detail : ""}</span>
          </button>
        ))}
      </div>

      <section className="card form">
        <div className="toolbar">
          <div className="row">
            {folders.length > 1 && (
              <select className="chip-select" value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">All folders</option>
                {folders.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            <label className="searchbox"><Icon name="search" /><input placeholder="Find a video" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <button disabled={loading} onClick={() => void load()}>{loading ? <span className="spinner" /> : <Icon name="reload" />} Read again</button>
          </div>
          <div className="row">
            <span className="muted small">{shown.length} videos · {gb(sum(shown))}</span>
            <button className="link" onClick={() => setPicked(new Set(shown.filter((r) => r.rel).map((r) => r.id)))}>Select all</button>
            <button className="link" onClick={() => setPicked(new Set())}>Select none</button>
          </div>
        </div>
        {rows && !rows.some((r) => r.rel) && <p className="note small">Media Hub can't place Jellyfin's file paths in your library folder yet, so jobs can't start. Open a title once (or set the folder mapping in Settings) to fix that.</p>}
        {!rows && loading && <p className="muted"><span className="spinner" /> Reading every video from Jellyfin…</p>}
        <div className="table">
          {shown.slice(0, limit).map((r) => {
            const xa = extraOf(r, "audio");
            const xs = extraOf(r, "subtitle");
            return (
              <label className={`op filerow ${r.big ? "big" : ""}`} key={r.id}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} disabled={!r.rel} />
                <div className="names">
                  <div className="ellipsis">{r.name}</div>
                  <div className="small muted">
                    {[`${r.codec.toUpperCase()} ${res(r.height)}${r.hdr ? " HDR" : ""}`, r.duration ? fmt(r.duration) : "", gb(r.size), r.gbPerHour ? `${r.gbPerHour.toFixed(1)} GB/h` : ""].filter(Boolean).join(" · ")}
                  </div>
                  {(xa.length > 0 || xs.length > 0) && (
                    <div className="small muted">
                      Could go: {[...xa.map((t) => `${t.language || "?"} audio`), ...xs.map((t) => `${t.language || "?"} subtitles`)].join(", ")}
                    </div>
                  )}
                  <div className="mono small muted ellipsis">{r.rel || "(not in your library folder)"}</div>
                </div>
                {r.big && <span className="chip static need" title="Much bigger per hour than other videos of this picture size">unusually big</span>}
                {shrinkEstimate(r) > 0 && r.size > 1e9 && <span className="chip static">save ~{gb(shrinkEstimate(r))}</span>}
              </label>
            );
          })}
        </div>
        {shown.length > limit && <button className="link" onClick={() => setLimit(limit + 400)}>Show {Math.min(400, shown.length - limit)} more</button>}
        {rows && shown.length === 0 && <p className="muted">Nothing here.</p>}
      </section>

      <section className="card form storage-actions">
        <div className="section-head"><h2>With the {picked.size || "selected"} video{picked.size === 1 ? "" : "s"}</h2>{!canEdit && <span className="muted small">Changes are switched off in Settings.</span>}</div>
        <div className="row">
          <label className="narrow wide-label">Encoder
            <select value={encoder} onChange={(e) => setEncoder(e.target.value)}>
              {encoders.map((e) => <option key={e} value={e}>{ENCODER_LABEL[e] ?? e}</option>)}
              {!encoders.length && <option value="">No H.265 encoder found</option>}
            </select>
          </label>
          <label className="narrow wide-label">Quality
            <select value={quality} onChange={(e) => setQuality(Number(e.target.value))}>
              <option value={1}>1 · smallest</option><option value={2}>2</option><option value={3}>3 · balanced</option><option value={4}>4</option><option value={5}>5 · best</option>
            </select>
          </label>
          <button className="primary" disabled={!canEdit || !picked.size || !encoder} onClick={() => void start("hevc")}>
            <Icon name="disk" /> Shrink to H.265{saving ? ` (save ~${gb(saving)})` : ""}
          </button>
        </div>
        <div className="row">
          <label className="check"><input type="checkbox" checked={stripAudio} onChange={(e) => setStripAudio(e.target.checked)} />Audio tracks in other languages</label>
          <label className="check"><input type="checkbox" checked={stripSubs} onChange={(e) => setStripSubs(e.target.checked)} />Built-in subtitles in other languages</label>
          <button disabled={!canEdit || !picked.size || (!stripAudio && !stripSubs)} onClick={() => void start("strip")}><Icon name="trash" /> Take them out</button>
        </div>
        <div className="row">
          <label className="narrow wide-label">Loudness target
            <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              <option value={-16}>−16 LUFS (louder)</option><option value={-20}>−20 LUFS (TV at home)</option><option value={-23}>−23 LUFS (broadcast)</option><option value={-27}>−27 LUFS (cinema-like)</option>
            </select>
          </label>
          <button disabled={!canEdit || !picked.size} onClick={() => void start("loudness")}><Icon name="volume" /> Even out loudness</button>
        </div>
        <p className="muted small">Your languages: {status.subLangs.join(", ")} (from Subtitles settings). HDR and H.265 files are skipped when shrinking. Loudness only changes the volume, peaks stay below −1 dB.</p>
      </section>

      {queue.length > 0 && (
        <section className="card history">
          <div className="row"><h2>Jobs</h2><div className="spacer" /><button className="link" onClick={clearDone}>Clear finished</button></div>
          {queue.map((q) => (
            <div className="batch job" key={q.key}>
              <div className="job-main">
                <div className="mono small">{q.job.mode === "hevc" ? "H.265 · " : q.job.mode === "strip" ? "Tracks · " : "Loudness · "}{q.job.rel}</div>
                <div className="progress"><span style={{ width: `${Math.max(2, q.percent)}%` }} className={q.state} /></div>
                <div className="muted small">{q.state === "running" ? `${q.percent.toFixed(0)}% · ` : ""}{q.text}</div>
              </div>
              {(q.state === "running" || q.state === "waiting") && <button onClick={() => cancel(q.key)}>Cancel</button>}
            </div>
          ))}
        </section>
      )}

      <section className="card form">
        <div className="section-head">
          <h2>Trash folder</h2>
          <span className="muted small">{trash ? `${trash.files} file${trash.files === 1 ? "" : "s"} · ${gb(trash.bytes)}` : "…"} · originals and removed files wait here until you empty it</span>
        </div>
        <div className="row">
          <button disabled={!trash?.files} onClick={() => void api.trashList().then(setTrashFiles).catch((e) => setMessage({ text: errorText(e), error: true }))}>
            <Icon name="list" /> {trashFiles ? "Refresh list" : "Show what's in it"}
          </button>
          {trashFiles && <button className="danger-outline" disabled={!canEdit || !trash?.files} onClick={() => void emptyTrash()}><Icon name="trash" /> Empty trash ({gb(trash?.bytes ?? 0)})</button>}
        </div>
        {trashFiles && (
          <div className="table trash-list">
            {trashFiles.map((f, i) => (
              <div className="op" key={i}>
                <div className="names"><div className="mono small ellipsis">{f.rel}</div><div className="muted small">{f.at ? new Date(f.at * 1000).toLocaleString() : ""}</div></div>
                <span className="chip static">{gb(f.bytes)}</span>
              </div>
            ))}
            {trashFiles.length === 0 && <p className="muted small">The trash folder is empty.</p>}
          </div>
        )}
      </section>

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
    </div>
  );
}
