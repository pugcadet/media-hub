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
  Logo: { aspect: 800 / 310, width: 800 },
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

/**
 * The picture editor: the frame has the exact shape of the picture you're making; drag the
 * picture to move it, use the slider or the scroll wheel to make it bigger or smaller. When it's
 * smaller than the frame, the rest is filled with a blurred copy or a colour of your choice.
 */
function CropDialog({ req }: { req: CropReq }) {
  const shape = ART_SHAPE[req.kind] ?? { aspect: 16 / 9, width: 1280 };
  const logo = req.kind === "Logo";
  const outW = shape.width;
  const outH = Math.round(outW / shape.aspect);
  const [src, setSrc] = useState(req.sources[0]?.src ?? "");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  // Picture centre (in output pixels) and size (1 = just covers the frame).
  const [cx, setCx] = useState(outW / 2);
  const [cy, setCy] = useState(outH / 2);
  const [zoom, setZoom] = useState(1);
  const [fill, setFill] = useState<"blur" | "color">("blur");
  const [color, setColor] = useState("#000000");
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ px: number; py: number; cx: number; cy: number } | null>(null);

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

  const cover = img ? Math.max(outW / img.naturalWidth, outH / img.naturalHeight) : 1;
  const contain = img ? Math.min(outW / img.naturalWidth, outH / img.naturalHeight) : 1;
  const minZoom = Math.max(0.1, (contain / cover) * 0.5);
  // A new picture starts covering the frame, centred (a bit higher for a poster from a background).
  useEffect(() => {
    if (!img) return;
    setZoom(1);
    setCx(outW / 2);
    const h = img.naturalHeight * cover;
    setCy(shape.aspect < 1 ? outH / 2 : Math.min(h / 2, outH / 2 + (h - outH) / 6));
  }, [img]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && endCrop(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const k = () => (stageRef.current ? stageRef.current.clientWidth / outW : 1);
  const w = img ? img.naturalWidth * cover * zoom : 0;
  const h = img ? img.naturalHeight * cover * zoom : 0;
  const down = (e: RPointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, cx, cy };
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setCx(d.cx + (e.clientX - d.px) / k());
    setCy(d.cy + (e.clientY - d.py) / k());
  };
  const setZ = (z: number) => setZoom(Math.min(4, Math.max(minZoom, z)));
  const wheel = (e: React.WheelEvent) => setZ(zoom * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
  const fitWhole = () => { setZ(contain / cover); setCx(outW / 2); setCy(outH / 2); };
  const fillFrame = () => { setZoom(1); setCx(outW / 2); setCy(outH / 2); };

  function done() {
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    if (!logo) {
      if (fill === "color") {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, outW, outH);
      } else {
        // A blurred, darkened copy that covers the frame.
        ctx.filter = "blur(40px) brightness(.7)";
        const bw = img.naturalWidth * cover * 1.15, bh = img.naturalHeight * cover * 1.15;
        ctx.drawImage(img, (outW - bw) / 2, (outH - bh) / 2, bw, bh);
        ctx.filter = "none";
      }
    }
    ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
    try {
      endCrop(logo ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.92));
    } catch {
      setFailed(true);
    }
  }

  const gaps = img && (w < outW - 1 || h < outH - 1 || cx - w / 2 > 1 || cy - h / 2 > 1 || cx + w / 2 < outW - 1 || cy + h / 2 < outH - 1);
  const soft = img && img.naturalWidth * cover * zoom > img.naturalWidth * 2;
  return (
    <div className="overlay confirm-layer" onClick={() => endCrop(null)}>
      <div className="card crop-dlg" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>Make a {NAMES[req.kind] ?? req.kind} for {req.title}</h2>
            <div className="muted small">Drag the picture to move it; scroll or use the slider to make it bigger or smaller.</div>
          </div>
          <button className="link-plain" onClick={() => endCrop(null)} aria-label="Close"><Icon name="x" /></button>
        </div>
        {req.sources.length > 1 && (
          <div className="crop-sources">
            {req.sources.map((s) => (
              <button key={s.src} className={`crop-src ${s.src === src ? "on" : ""}`} onClick={() => setSrc(s.src)} title={s.label}>
                <img src={s.src} alt="" loading="lazy" crossOrigin="anonymous" />
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className="crop-stage">
          {!img && !failed && src && <div className="pg-loading"><span className="spinner" /> Loading the picture…</div>}
          {failed && <p className="error">This picture can't be edited here. Try another one.</p>}
          {img && (
            <div
              className={`crop-frame2 ${logo ? "checker" : ""}`}
              ref={stageRef}
              style={{ aspectRatio: `${outW} / ${outH}`, ["--ar" as string]: outW / outH, background: logo ? undefined : fill === "color" ? color : undefined }}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={() => (drag.current = null)}
              onWheel={wheel}
            >
              {!logo && fill === "blur" && <img className="crop-blur" src={src} alt="" crossOrigin="anonymous" draggable={false} />}
              <img
                className="crop-img"
                src={src}
                alt=""
                crossOrigin="anonymous"
                draggable={false}
                style={{ left: `${((cx - w / 2) / outW) * 100}%`, top: `${((cy - h / 2) / outH) * 100}%`, width: `${(w / outW) * 100}%`, height: `${(h / outH) * 100}%` }}
              />
              <div className="crop-guides" />
            </div>
          )}
        </div>
        <div className="row crop-controls">
          <label className="row grow small">Size <input type="range" min={minZoom} max={4} step={0.01} value={zoom} onChange={(e) => setZ(Number(e.target.value))} disabled={!img} /></label>
          <button className="mini-btn" disabled={!img} onClick={fitWhole} title="Shrink so the whole picture fits">Whole picture</button>
          <button className="mini-btn" disabled={!img} onClick={fillFrame} title="Fill the frame, centred">Fill frame</button>
          {!logo && (
            <>
              <div className="seg-ctl">
                <button className={fill === "blur" ? "on" : ""} onClick={() => setFill("blur")} title="Empty space gets a blurred copy of the picture">Blur</button>
                <button className={fill === "color" ? "on" : ""} onClick={() => setFill("color")} title="Empty space gets a plain colour">Colour</button>
              </div>
              {fill === "color" && <input type="color" value={color} onChange={(e) => setColor(e.target.value)} aria-label="Fill colour" />}
            </>
          )}
        </div>
        <div className="row">
          <span className="muted small grow">{outW}×{outH}{gaps ? (logo ? " · the empty part stays see-through" : ` · empty space is filled with ${fill === "blur" ? "a blurred copy" : "the colour"}`) : ""}</span>
          {soft && <span className="warn small">Zoomed in a lot: it may look soft on a big screen.</span>}
          <button onClick={() => endCrop(null)}>Cancel</button>
          <button className="primary" disabled={!img} onClick={done}>Use this</button>
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
