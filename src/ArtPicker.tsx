// "Fix" for pictures: shows each missing picture with the options found online, the
// recommended one picked already. Choose others, skip some, or take every recommendation.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ImageKind, RemoteImage, remoteImageUrl } from "./api";
import { Icon } from "./ui";

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
  useEffect(() => {
    if (!req) return;
    setOptions({});
    setPick({});
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
                {list && list.length === 0 && k !== "Thumb" && <div className="muted small">Nothing found online. Upload one on the Artwork tab, or mark it as not needed there.</div>}
                <div className={`ap-strip ${k === "Primary" ? "tall" : k === "Logo" ? "logo" : ""}`}>
                  {k === "Thumb" && (
                    <button className={`ap-opt make ${chosen === "from-backdrop" ? "on" : ""}`} onClick={() => setPick((p) => ({ ...p, [k]: "from-backdrop" }))}>
                      <Icon name="image" size={20} /><span className="small">Use the background picture</span>{!list?.length && <span className="ap-rec">Recommended</span>}
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
          <button onClick={() => close(null)}>Cancel</button>
          <button disabled={loading} onClick={() => close(recommended())}>Use recommended for all</button>
          <button className="primary" disabled={loading || !count} onClick={() => close(pick)}>Use {count} picture{count === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}

/** Applies the choices; returns how many pictures changed. */
export async function applyArt(id: string, choice: ArtChoice): Promise<number> {
  let n = 0;
  for (const [kind, v] of Object.entries(choice)) {
    if (v === "skip") continue;
    if (v === "from-backdrop") {
      if (await api.makeThumb(id)) n++;
    } else {
      await api.setImage(id, kind as ImageKind, v);
      n++;
    }
  }
  return n;
}
