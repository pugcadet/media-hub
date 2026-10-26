// Artwork helpers shown as popups: cropping one picture into another kind (a poster from a
// background, a thumbnail from a poster …) and a preview of how the artwork looks in the apps.
import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from "react";
import type { ImageKind } from "./api";
import { Icon } from "./ui";

/** Width ÷ height of each kind of picture, and the size it's saved at. */
export const ART_SHAPE: Partial<Record<ImageKind, { aspect: number; width: number }>> = {
  Primary: { aspect: 2 / 3, width: 1000 },
  Backdrop: { aspect: 16 / 9, width: 1920 },
  Thumb: { aspect: 16 / 9, width: 1280 },
  Banner: { aspect: 1000 / 185, width: 1000 },
  Art: { aspect: 1000 / 562, width: 1000 },
  Disc: { aspect: 1, width: 1000 },
};

const NAMES: Record<string, string> = { Primary: "poster", Backdrop: "background", Logo: "logo", Thumb: "thumbnail", Banner: "banner", Art: "clear art", Disc: "disc" };

function makeStore<T>(init: T) {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set: (n: T) => { v = n; subs.forEach((f) => f()); },
    use: () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => v),
  };
}

/* ------------------------------------------------------------------ crop */

export interface CropSource { label: string; src: string }
interface CropReq { title: string; kind: ImageKind; sources: CropSource[]; resolve: (dataUrl: string | null) => void }
const cropStore = makeStore<CropReq | null>(null);

/** Pick one of `sources` and cut it to the shape of `kind`. Resolves with a JPEG data URL. */
export function askCrop(title: string, kind: ImageKind, sources: CropSource[]): Promise<string | null> {
  return new Promise((resolve) => cropStore.set({ title, kind, sources, resolve }));
}

function endCrop(v: string | null) {
  const c = cropStore.get();
  cropStore.set(null);
  c?.resolve(v);
}

interface Frame { x: number; y: number; w: number }

function CropDialog({ req }: { req: CropReq }) {
  const shape = ART_SHAPE[req.kind] ?? { aspect: 16 / 9, width: 1280 };
  const [src, setSrc] = useState(req.sources[0]?.src ?? "");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [size, setSize] = useState(1);
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; f: Frame } | null>(null);

  useEffect(() => {
    setImg(null);
    setFailed(false);
    if (!src) return;
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => setImg(i);
    i.onerror = () => setFailed(true);
    i.src = src;
  }, [src]);

  const maxW = img ? Math.min(img.naturalWidth, img.naturalHeight * shape.aspect) : 0;
  // A new picture: the biggest frame that fits, in the middle (top third for posters from a background).
  useEffect(() => {
    if (!img) return;
    const w = maxW;
    const h = w / shape.aspect;
    setSize(1);
    setFrame({ x: (img.naturalWidth - w) / 2, y: Math.max(0, (img.naturalHeight - h) / (shape.aspect < 1 ? 2 : 3)), w });
  }, [img]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && endCrop(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clamp = (f: Frame): Frame => {
    if (!img) return f;
    const h = f.w / shape.aspect;
    return { w: f.w, x: Math.min(Math.max(0, f.x), img.naturalWidth - f.w), y: Math.min(Math.max(0, f.y), img.naturalHeight - h) };
  };
  const resize = (s: number) => {
    if (!frame) return;
    setSize(s);
    const w = Math.max(40, maxW * s);
    const cx = frame.x + frame.w / 2, cy = frame.y + frame.w / shape.aspect / 2;
    setFrame(clamp({ w, x: cx - w / 2, y: cy - w / shape.aspect / 2 }));
  };
  const scale = img && boxRef.current ? boxRef.current.clientWidth / img.naturalWidth : 1;
  const down = (e: RPointerEvent) => {
    if (!frame) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, f: frame };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setFrame(clamp({ w: d.f.w, x: d.f.x + (e.clientX - d.px) / scale, y: d.f.y + (e.clientY - d.py) / scale }));
  };

  function done() {
    if (!img || !frame) return;
    const outW = Math.round(Math.min(frame.w, shape.width));
    const outH = Math.round(outW / shape.aspect);
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, frame.x, frame.y, frame.w, frame.w / shape.aspect, 0, 0, outW, outH);
    try {
      endCrop(c.toDataURL("image/jpeg", 0.92));
    } catch {
      setFailed(true);
    }
  }

  const small = frame && frame.w < shape.width * 0.5;
  return (
    <div className="overlay confirm-layer" onClick={() => endCrop(null)}>
      <div className="card crop-dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>Make a {NAMES[req.kind] ?? req.kind} for {req.title}</h2>
            <div className="muted small">Pick a picture, then drag the frame to the part you want.</div>
          </div>
          <button className="link-plain" onClick={() => endCrop(null)} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="crop-sources">
          {req.sources.map((s) => (
            <button key={s.src} className={`crop-src ${s.src === src ? "on" : ""}`} onClick={() => setSrc(s.src)} title={s.label}>
              <img src={s.src} alt="" loading="lazy" crossOrigin="anonymous" />
              <span>{s.label}</span>
            </button>
          ))}
          {req.sources.length === 0 && <span className="muted small">No other pictures of this title yet.</span>}
        </div>
        <div className="crop-stage">
          {!img && !failed && src && <div className="pg-loading"><span className="spinner" /> Loading the picture…</div>}
          {failed && <p className="error">This picture can't be cut here. Try another one.</p>}
          {img && frame && (
            <div className="crop-box" ref={boxRef} style={{ aspectRatio: `${img.naturalWidth} / ${img.naturalHeight}` }}>
              <img src={src} alt="" crossOrigin="anonymous" draggable={false} />
              <div
                className="crop-frame"
                style={{ left: `${(frame.x / img.naturalWidth) * 100}%`, top: `${(frame.y / img.naturalHeight) * 100}%`, width: `${(frame.w / img.naturalWidth) * 100}%`, height: `${(frame.w / shape.aspect / img.naturalHeight) * 100}%` }}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={() => (drag.current = null)}
              />
            </div>
          )}
        </div>
        <div className="row">
          <label className="row grow small">Size <input type="range" min={0.2} max={1} step={0.01} value={size} onChange={(e) => resize(Number(e.target.value))} disabled={!frame} /></label>
          {small && <span className="warn small">Small: it may look soft on a big screen.</span>}
          <button onClick={() => endCrop(null)}>Cancel</button>
          <button className="primary" disabled={!frame} onClick={done}>Use this</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- preview */

export interface PreviewReq {
  title: string;
  overview?: string;
  meta?: string;
  /** Picture address per kind (what's there now, or what you're about to pick). */
  urls: Partial<Record<ImageKind, string>>;
}
const previewStore = makeStore<PreviewReq | null>(null);

/** Shows mock-ups of a list, "continue watching" and the title page with this artwork. */
export function showPreview(req: PreviewReq): void {
  previewStore.set(req);
}

function PreviewDialog({ req }: { req: PreviewReq }) {
  const u = req.urls;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && previewStore.set(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const missing = (["Primary", "Backdrop", "Logo", "Thumb"] as ImageKind[]).filter((k) => !u[k]);
  return (
    <div className="overlay confirm-layer" onClick={() => previewStore.set(null)}>
      <div className="card preview-dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>How {req.title} looks</h2>
            <div className="muted small">Mock-ups of where Infuse and Media Hub use each picture.{missing.length ? ` Missing: ${missing.map((k) => NAMES[k]).join(", ")} (shown as what apps fall back to).` : ""}</div>
          </div>
          <button className="link-plain" onClick={() => previewStore.set(null)} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="mock-grid">
          <figure className="mock">
            <figcaption>Title page · background and logo</figcaption>
            <div className="mock-detail">
              {u.Backdrop ? <img className="mock-bg" src={u.Backdrop} alt="" /> : <div className="mock-bg empty" />}
              <div className="mock-shade" />
              <div className="mock-detail-body">
                {u.Primary && <img className="mock-poster" src={u.Primary} alt="" />}
                <div className="mock-detail-text">
                  {u.Logo ? <img className="mock-logo" src={u.Logo} alt="" /> : <div className="mock-title">{req.title}</div>}
                  {req.meta && <div className="mock-meta">{req.meta}</div>}
                  <div className="mock-btns"><span className="mock-play"><Icon name="play" size={12} /> Play</span><span className="mock-ghost" /></div>
                  <div className="mock-lines">{req.overview ? <p>{req.overview.slice(0, 160)}{req.overview.length > 160 ? "…" : ""}</p> : <><i /><i /><i /></>}</div>
                </div>
              </div>
            </div>
          </figure>
          <figure className="mock">
            <figcaption>Library · poster</figcaption>
            <div className="mock-shelf">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className={`mock-tile ${i === 2 ? "me" : ""}`}>
                  {i === 2 ? (u.Primary ? <img src={u.Primary} alt="" /> : <div className="mock-noart">{req.title}</div>) : null}
                </div>
              ))}
            </div>
            <div className="mock-label">{req.title}</div>
          </figure>
          <figure className="mock">
            <figcaption>Continue watching · thumbnail</figcaption>
            <div className="mock-wide-row">
              <div className="mock-wide">
                {u.Thumb ? <img src={u.Thumb} alt="" /> : u.Backdrop ? <><img src={u.Backdrop} alt="" />{u.Logo && <img className="mock-wide-logo" src={u.Logo} alt="" />}</> : <div className="mock-noart">{req.title}</div>}
                <span className="mock-progress"><span /></span>
              </div>
              <div className="mock-wide ghost" />
            </div>
            <div className="mock-label">{req.title}{!u.Thumb && u.Backdrop ? <span className="muted"> · no thumbnail: apps use the background</span> : null}</div>
          </figure>
          {u.Banner && (
            <figure className="mock">
              <figcaption>Banner (optional)</figcaption>
              <img className="mock-banner" src={u.Banner} alt="" />
            </figure>
          )}
        </div>
      </div>
    </div>
  );
}

export function ArtToolsHost() {
  const crop = cropStore.use();
  const preview = previewStore.use();
  return (
    <>
      {crop && <CropDialog key={crop.sources.map((s) => s.src).join("|") + crop.kind} req={crop} />}
      {preview && <PreviewDialog req={preview} />}
    </>
  );
}

/** A pasted picture (from the clipboard) as a data URL, or a pasted https link. */
export async function readPaste(e: ClipboardEvent): Promise<{ data?: string; link?: string } | null> {
  const items = e.clipboardData?.items;
  if (items) {
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (!f) continue;
        const data = await new Promise<string>((res, rej) => {
          const r = new FileReader();
          r.onload = () => res(String(r.result));
          r.onerror = () => rej(r.error);
          r.readAsDataURL(f);
        });
        return { data };
      }
    }
  }
  const text = e.clipboardData?.getData("text/plain")?.trim() ?? "";
  if (/^https:\/\/\S+$/i.test(text)) return { link: text };
  return null;
}
