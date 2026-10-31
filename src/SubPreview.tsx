// Check a subtitle against the video: short clips with sound at four moments, the subtitle's
// line drawn over them, timing − / +, "fix automatically", and "Lock it in" (saves the timing
// into the file, removes the other files in this language, names it after the video).
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { Icon } from "./ui";

const CLIP = 10;
const LEAD = 2;
const clock = (t: number) => {
  const s = Math.max(0, Math.round(t));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};
const SPOT_NAMES = ["Start", "Early", "Middle", "Late"];

export default function SubPreview({ id, path, lang, label, others, canEdit, onClose, onDone }: {
  id: string; path: string; lang: string; label: string;
  /** How many other files in this language would go to the trash. */
  others: number;
  canEdit: boolean; onClose: () => void; onDone: (note: string) => void;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.subtitlePreview>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spot, setSpot] = useState(0);
  const [offset, setOffset] = useState(0);
  const [clips, setClips] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(0);
  const [auto, setAuto] = useState<{ before: number; after: number; sure: boolean; scale: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    setData(null); setError(null); setOffset(0); setClips({}); setSpot(0); setAuto(null);
    api.subtitlePreview(id, path).then(setData).catch((e) => setError(errorText(e)));
  }, [id, path]);

  // Free the clips when leaving.
  useEffect(() => () => { Object.values(clips).forEach((u) => URL.revokeObjectURL(u)); }, [clips]);

  const at = data?.spots[spot] ?? null;
  const start = at === null ? 0 : Math.max(0, at - LEAD);
  useEffect(() => {
    if (at === null || clips[spot]) return;
    let live = true;
    setLoading(true);
    api.videoClip(id, start, CLIP)
      .then((b64) => {
        if (!live) return;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));
        setClips((c) => ({ ...c, [spot]: url }));
      })
      .catch((e) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [at, spot, id, start, clips]);

  // The line on screen: shifted by the chosen timing.
  const line = useMemo(() => {
    if (!data) return "";
    const t = start + now - offset;
    return data.lines.filter((l) => l.s <= t && t <= l.e).map((l) => l.t).join("\n");
  }, [data, start, now, offset]);

  const step = (d: number) => setOffset((o) => Math.round((o + d) * 10) / 10);

  async function fixAuto() {
    setBusy("auto");
    setError(null);
    try {
      const r = await track("Listening for speech", () => api.subtitleSync(id, -1, false, path), { reload: false });
      setAuto({ before: r.fit.before, after: r.fit.after, sure: r.sure, scale: r.fit.scale });
      if (r.fit.after - r.fit.before >= 0.02) setOffset(Math.round(r.fit.offset * 10) / 10);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function lock() {
    const shift = offset ? `${offset > 0 ? "+" : ""}${offset.toFixed(1)} s` : null;
    const parts = [
      shift ? `Saves the ${shift} timing into the file (the original is kept, so you can undo it).` : "Keeps the timing as it is.",
      others ? `Moves the other ${others} ${label} file${others === 1 ? "" : "s"} to the trash.` : null,
      "Names it after the video so Jellyfin and Infuse always pick it.",
    ].filter(Boolean);
    if (!(await askConfirm(`This ${label} subtitle is the right one?\n\n${parts.join("\n")}`, { okLabel: "Lock it in" }))) return;
    setBusy("lock");
    try {
      const r = await track("Locking in the subtitle", () => api.subtitleLock(id, path, lang, offset, true), { items: [id] });
      onDone(`Locked in as ${r.file}${r.shifted ? `, shifted ${r.shifted > 0 ? "+" : ""}${r.shifted.toFixed(1)} s` : ""}${r.removed ? `; ${r.removed} other file${r.removed === 1 ? "" : "s"} moved to the trash` : ""}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card sp">
      <div className="row between">
        <div className="strong">Preview · <span className="mono small">{data?.file ?? label}</span></div>
        <button className="link small" onClick={onClose}>Close</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!data && !error && <div className="muted small"><span className="spinner small-spin" /> Reading the subtitle…</div>}
      {data && (
        <>
          <div className="sp-stage">
            {clips[spot] ? (
              <video ref={video} key={clips[spot]} src={clips[spot]} controls autoPlay onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onSeeked={(e) => setNow(e.currentTarget.currentTime)} />
            ) : (
              <div className="sp-wait">{loading ? <><span className="spinner" /> Cutting a {CLIP} s clip…</> : "No clip"}</div>
            )}
            {line && <div className="sp-line">{line}</div>}
            {at !== null && <span className="sp-time mono">{clock(start + now)} · {CLIP} s clip</span>}
          </div>
          <div className="sp-spots">
            {data.spots.map((t, i) => (
              <button key={t} className={i === spot ? "on" : ""} onClick={() => { setSpot(i); setNow(0); }}>{SPOT_NAMES[i] ?? `Spot ${i + 1}`} · {clock(t)}</button>
            ))}
          </div>
          <div className="sp-timing">
            <span className="muted small">Timing</span>
            <button aria-label="Earlier by a second" onClick={() => step(-1)}>−1</button>
            <button aria-label="Earlier" onClick={() => step(-0.1)}>−</button>
            <span className="mono sp-off">{offset > 0 ? "+" : ""}{offset.toFixed(1)} s</span>
            <button aria-label="Later" onClick={() => step(0.1)}>+</button>
            <button aria-label="Later by a second" onClick={() => step(1)}>+1</button>
            <button disabled={busy === "auto"} onClick={() => void fixAuto()}>{busy === "auto" ? <span className="spinner small-spin" /> : <Icon name="wand" />} Fix automatically</button>
            <span className="grow" />
            {auto && <span className="muted small">Speech under the text: {Math.round(auto.before * 100)}% → {Math.round(auto.after * 100)}%{Math.abs(auto.scale - 1) > 0.001 ? " (it also runs at a different speed; Fix timing handles that)" : ""}</span>}
          </div>
          <div className="sp-lock">
            <div className="grow">
              <div className="strong">This one is right</div>
              <div className="muted small">
                {offset ? `Saves the ${offset > 0 ? "+" : ""}${offset.toFixed(1)} s into the file, ` : ""}{others ? `removes the other ${label} file${others === 1 ? "" : "s"}, ` : ""}names it after the video. Undo in History.
              </div>
            </div>
            <button className="primary" disabled={!canEdit || busy === "lock"} onClick={() => void lock()}>{busy === "lock" ? <span className="spinner small-spin" /> : <Icon name="lock" />} Lock it in</button>
          </div>
        </>
      )}
    </div>
  );
}
