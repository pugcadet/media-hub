// "Fix" for pictures: shows each missing picture with the options found online, the
// recommended one picked already. Choose others, skip some, or take every recommendation.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, imageUrl, ImageKind, JfImage, RemoteImage, remoteImageUrl } from "./api";
import { Icon } from "./ui";
import { askCrop, showPreview, type CropSource } from "./ArtTools";

const NAMES: Record<string, string> = { Primary: "Poster", Backdrop: "Background", Logo: "Logo", Thumb: "Thumbnail", Banner: "Banner", Art: "Clear art", Disc: "Disc" };
/** Chosen per kind: an image address, "from-backdrop" (thumbnail made from the background) or "skip". */
export type ArtChoice = Record<string, string>;

interface Req {
  id: string;
  title: string;
  kinds: ImageKind[];
  lang: string;
  resolve: (r: ArtChoice | null) => void;
}

let current: Req | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export function askArt(id: string, title: string, kinds: ImageKind[], lang = "en"): Promise<ArtChoice | null> {
  return new Promise((resolve) => {
    current = { id, title, kinds, lang, resolve };
    notify();
  });
}

function close(r: ArtChoice | null) {
  const c = current;
  current = null;
  notify();
  c?.resolve(r);
}

/** Same order as Media Hub's own pick: your language (no text for backgrounds), rating, votes, size. */
export function rankImages(options: RemoteImage[], kind: string, lang: string): RemoteImage[] {
  const l2 = lang.slice(0, 2).toLowerCase();
  const score = (o: RemoteImage) => {
    const l = (o.Language ?? "").toLowerCase();
    const ls = kind === "Backdrop" ? (!l ? 3 : l === l2 ? 2 : 0) : l === l2 ? 3 : l === "en" ? 2 : !l ? 1 : 0;
    return ls * 100 + (o.CommunityRating ?? 0) * 5 + Math.min(o.VoteCount ?? 0, 50) * 0.2 + Math.min((o.Width ?? 0) / 1000, 4);
  };
  return options.filter((o) => o.Url).sort((a, b) => score(b) - score(a));
}

export function ArtPickerHost() {
  const req = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
  const [options, setOptions] = useState<Record<string, RemoteImage[] | null>>({});
  const [pick, setPick] = useState<ArtChoice>({});
  const [have, setHave] = useState<JfImage[]>([]);
  useEffect(() => {
    if (!req) return;
    setOptions({});
    setPick({});
    setHave([]);
    api.details(req.id).then((d) => setHave(d.images)).catch(() => setHave([]));
    for (const k of req.kinds) {
      api.remoteImages(req.id, k).then((list) => {
        const ranked = rankImages(list, k, req.lang).slice(0, 18);
        setOptions((o) => ({ ...o, [k]: ranked }));
        setPick((p) => (p[k] ? p : { ...p, [k]: ranked[0]?.Url ?? (k === "Thumb" ? "from-backdrop" : "skip") }));
      }).catch(() => {
        setOptions((o) => ({ ...o, [k]: [] }));
        setPick((p) => ({ ...p, [k]: k === "Thumb" ? "from-backdrop" : "skip" }));
      });
    }
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  const loading = req.kinds.some((k) => options[k] === undefined);
  /** Pictures this title has, or that were found online, to cut into another shape. */
  async function cropFor(k: ImageKind) {
    if (!req) return;
    const sources: CropSource[] = [];
    const seen = new Set<string>();
    const add = (label: string, src: string) => { if (!seen.has(src)) { seen.add(src); sources.push({ label, src }); } };
    for (const img of have) {
      if (img.ImageType === k || img.ImageType === "Logo" || !["Primary", "Backdrop", "Thumb", "Banner", "Art"].includes(img.ImageType)) continue;
      add(`${NAMES[img.ImageType] ?? img.ImageType} (now)`, imageUrl(req.id, img.ImageType as ImageKind, 1920, img.ImageIndex ?? 0, img.ImageTag ?? ""));
    }
    const more: ImageKind[] = (["Backdrop", "Primary", "Thumb"] as ImageKind[]).filter((x) => x !== k);
    for (const x of more) {
      const list = options[x] ?? rankImages(await api.remoteImages(req.id, x).catch(() => []), x, req.lang).slice(0, 6);
      list.slice(0, 6).forEach((o) => o.Url && add(`${NAMES[x]} · ${o.ProviderName?.replace("TheMovieDb", "TMDB") ?? "online"}`, remoteImageUrl(o.Url)));
    }
    const data = await askCrop(req.title, k, sources);
    if (data) setPick((p) => ({ ...p, [k]: data }));
  }
  function preview() {
    if (!req) return;
    const urls: Partial<Record<ImageKind, string>> = {};
    for (const img of have) {
      if ((img.ImageIndex ?? 0) === 0) urls[img.ImageType as ImageKind] = imageUrl(req.id, img.ImageType as ImageKind, 1280, 0, img.ImageTag ?? "");
    }
    for (const [k, v] of Object.entries(pick)) {
      if (v === "skip") continue;
      if (v === "from-backdrop") { if (urls.Backdrop) urls.Thumb = urls.Backdrop; continue; }
      urls[k as ImageKind] = v.startsWith("data:") ? v : remoteImageUrl(v);
    }
    showPreview({ title: req.title, urls });
  }
  const recommended = (): ArtChoice => Object.fromEntries(req.kinds.map((k) => [k, options[k]?.[0]?.Url ?? (k === "Thumb" ? "from-backdrop" : "skip")]));
  const count = Object.values(pick).filter((v) => v !== "skip").length;
  return (
    <div className="overlay confirm-layer" onClick={() => close(null)}>
      <div className="card art-picker" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div>
            <h2>Artwork for {req.title}</h2>
            <div className="muted small">The recommended picture is chosen already. Click another to use it, or skip one.</div>
          </div>
          <button className="link-plain" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="art-picker-body">
          {req.kinds.map((k) => {
            const list = options[k];
            const chosen = pick[k];
            return (
              <section key={k} className="ap-kind">
                <div className="row between">
                  <span className="strong">{NAMES[k] ?? k}</span>
                  <button className={`link small ${chosen === "skip" ? "on" : ""}`} onClick={() => setPick((p) => ({ ...p, [k]: "skip" }))}>{chosen === "skip" ? "Skipped" : "Skip this one"}</button>
                </div>
                {list === undefined && <div className="muted small"><span className="spinner" /> Looking online…</div>}
                {list && list.length === 0 && k !== "Thumb" && <div className="muted small">Nothing found online. Cut one from another picture, or upload or paste one on the Artwork tab.</div>}
                <div className={`ap-strip ${k === "Primary" ? "tall" : k === "Logo" ? "logo" : ""}`}>
                  {k === "Thumb" && (
                    <button className={`ap-opt make ${chosen === "from-backdrop" ? "on" : ""}`} onClick={() => setPick((p) => ({ ...p, [k]: "from-backdrop" }))}>
                      <Icon name="image" size={20} /><span className="small">Use the background picture</span>{!list?.length && <span className="ap-rec">Recommended</span>}
                    </button>
                  )}
                  {chosen?.startsWith("data:") && (
                    <button className="ap-opt on" title="Cut from another picture">
                      <img src={chosen} alt="" />
                      <span className="ap-check"><Icon name="check" size={14} /></span>
                    </button>
                  )}
                  {k !== "Logo" && (
                    <button className="ap-opt make" onClick={() => void cropFor(k)} title="Cut it from the poster, background or another picture">
                      <Icon name="expand" size={20} /><span className="small">Cut from another picture…</span>
                    </button>
                  )}
                  {(list ?? []).map((o, i) => (
                    <button key={o.Url} className={`ap-opt ${chosen === o.Url ? "on" : ""}`} onClick={() => setPick((p) => ({ ...p, [k]: o.Url! }))} title={`${o.ProviderName ?? ""} ${o.Width ? `${o.Width}×${o.Height}` : ""} ${o.Language ?? ""}`}>
                      <img src={remoteImageUrl(o.ThumbnailUrl || o.Url!)} alt="" loading="lazy" />
                      {i === 0 && <span className="ap-rec">Recommended</span>}
                      {chosen === o.Url && <span className="ap-check"><Icon name="check" size={14} /></span>}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <div className="row end">
          <button className="link" onClick={preview}><Icon name="eye" /> Preview</button>
          <div className="spacer" />
          <button onClick={() => close(null)}>Cancel</button>
          <button disabled={loading} onClick={() => close(recommended())}>Use recommended for all</button>
          <button className="primary" disabled={loading || !count} onClick={() => close(pick)}>Use {count} picture{count === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}

/** Applies the choices; returns how many pictures changed. Optional kinds (banner, clear
 * art, disc) that can be found online are added too, without asking. */
export async function applyArt(id: string, choice: ArtChoice): Promise<number> {
  let n = 0;
  for (const [kind, v] of Object.entries(choice)) {
    if (v === "skip") continue;
    if (v === "from-backdrop") {
      if (await api.makeThumb(id)) n++;
    } else if (v.startsWith("data:")) {
      await api.uploadImageBytes(id, kind as ImageKind, v, "cropped");
      n++;
    } else {
      await api.setImage(id, kind as ImageKind, v);
      n++;
    }
  }
  await fillOptional(id);
  return n;
}

/** Banner, clear art and disc: added when they can be found, never asked about. */
export async function fillOptional(id: string): Promise<void> {
  await api.fillMissingArt(id, ["Banner", "Art", "Disc"]).catch(() => undefined);
}
