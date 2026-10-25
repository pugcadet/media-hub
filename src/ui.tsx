// Shared pieces: right-click menus, picture viewer, choice dialog, cards and rows,
// and the activity bar at the top of the window.
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, api, bumpArt, Card, errorText, imageUrl } from "./api";
import { clearDataCaches, dismiss, followEvent, isStopped, track, useEpoch, useJobs } from "./activity";
import { nav } from "./nav";
import { setPrefs as setPrefsLite, usePrefs as usePrefsLite } from "./prefs";

/* ------------------------------------------------------------------ store */

function makeStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set: (v: T) => {
      value = v;
      subs.forEach((f) => f());
    },
    use: () =>
      useSyncExternalStore(
        (f) => {
          subs.add(f);
          return () => subs.delete(f);
        },
        () => value,
      ),
  };
}

/* ----------------------------------------------------------- context menu */

export interface MenuItem {
  label?: string;
  run?: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
  sep?: boolean;
}

const menuStore = makeStore<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]): void {
  e.preventDefault();
  e.stopPropagation();
  const clean = items.filter((it, i, all) => !(it.sep && (i === 0 || all[i - 1]?.sep || i === all.length - 1)));
  if (clean.length) menuStore.set({ x: e.clientX, y: e.clientY, items: clean });
}

function MenuHost() {
  const m = menuStore.use();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) });
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const close = () => menuStore.set(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [m]);
  if (!m) return null;
  return (
    <div className="menu-layer" onMouseDown={() => menuStore.set(null)} onContextMenu={(e) => { e.preventDefault(); menuStore.set(null); }}>
      <div ref={ref} className="ctx-menu" role="menu" style={{ left: pos.x || m.x, top: pos.y || m.y }} onMouseDown={(e) => e.stopPropagation()}>
        {m.items.map((it, i) =>
          it.sep ? <div key={i} className="ctx-sep" /> : (
            <button key={i} role="menuitem" className={`ctx-item ${it.danger ? "bad" : ""}`} disabled={it.disabled} onClick={() => { menuStore.set(null); it.run?.(); }}>
              <span>{it.label}</span>{it.hint && <span className="muted small">{it.hint}</span>}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * Plays a title: a movie or episode directly; a show from where you are (the episode you
 * started, else the first one you haven't watched); a season from its first unwatched episode.
 */
export async function playTitle(id: string): Promise<void> {
  try {
    const d = await api.details(id);
    const t = d.item.Type;
    if (t === "Movie" || t === "Episode") return nav.play(id);
    const seasons = t === "Series" ? d.seasons.filter((s) => (s.IndexNumber ?? 0) > 0).concat(d.seasons.filter((s) => (s.IndexNumber ?? 0) === 0)) : t === "Season" ? [d.item] : [];
    for (const s of seasons) {
      if (s.UserData?.Played && s !== seasons[seasons.length - 1]) continue;
      const eps = (await api.children(s.Id)).filter((e) => e.Type === "Episode");
      const e = eps.find((x) => (x.UserData?.PlaybackPositionTicks ?? 0) > 0) ?? eps.find((x) => !x.UserData?.Played);
      if (e) return nav.play(e.Id);
    }
    nav.open(id);
  } catch (e) {
    void track("Play", () => Promise.reject(errorText(e)));
  }
}

/** What a right-click on a title offers. */
export interface MenuTarget {
  id: string;
  kind: string; // movie | series | season | episode | collection | person | other (any case)
  title?: string;
  seriesId?: string | null;
  seasonId?: string | null;
  played?: boolean;
  /** collection the target is shown in (offers "Remove from collection") */
  inCollection?: string;
}

export function itemMenu(t: MenuTarget, canEdit = true): MenuItem[] {
  const k = t.kind.toLowerCase();
  const playable = k === "movie" || k === "episode";
  const titled = k === "movie" || k === "series";
  const items: MenuItem[] = [
    { label: "Open", run: () => (k === "collection" ? nav.route({ view: "collections", collection: t.id }) : nav.open(t.id)) },
    ...(playable ? [{ label: "Play", run: () => nav.play(t.id) }] : k === "series" || k === "season" ? [{ label: "Play", run: () => void playTitle(t.id) }] : []),
    ...(t.seriesId && (k === "episode" || k === "season") ? [{ label: "Go to show", run: () => nav.open(t.seriesId!) }] : []),
    ...(t.seasonId && k === "episode" ? [{ label: "Go to season", run: () => nav.open(t.seriesId ?? t.seasonId!, { tab: t.seasonId! }) }] : []),
    { sep: true },
  ];
  if (k !== "collection" && k !== "person") {
    items.push({
      label: t.played ? "Mark as not watched" : "Mark as watched",
      run: () => void track(t.played ? "Marking as not watched" : "Marking as watched", () => api.setPlayed(t.id, !t.played)),
    });
  }
  if (titled) {
    items.push({ label: "Add to collection…", disabled: !canEdit, run: () => void addToCollection([t.id], t.title) });
  }
  if (t.inCollection) {
    const cid = t.inCollection;
    items.push({ label: "Remove from this collection", disabled: !canEdit, run: () => void track("Removing from collection", () => api.collectionRemove(cid, [t.id])) });
  }
  items.push({ sep: true });
  if (titled) {
    items.push({ label: "Identify…", run: () => nav.open(t.id, { tab: "identify" }) });
    items.push({ label: "Rename files…", run: () => nav.open(t.id, { tab: "rename" }) });
  }
  if (titled || k === "season") {
    items.push({
      label: "Fill in missing artwork", disabled: !canEdit,
      run: () => void track(`Artwork for ${t.title ?? "title"}`, async (j) => {
        const added = await api.fillMissingArt(t.id, ["Primary", "Backdrop", "Logo", "Thumb", "Banner", "Art", "Disc"]);
        j.update(added.length ? `Added ${added.join(", ")}` : "Nothing missing that could be found");
      }),
    });
  }
  if (k !== "collection" && k !== "person") {
    items.push({ label: "Refresh from internet", disabled: !canEdit, run: () => void track("Refreshing metadata", () => api.refreshItem(t.id, false)) });
    items.push({ sep: true });
    items.push({ label: navigator.userAgent.includes("Windows") ? "Show in Explorer" : "Show in Finder", run: () => void api.revealItem(t.id).catch((e) => void track("Show in Finder", () => Promise.reject(e))) });
  }
  return items;
}

/* --------------------------------------------------------- choice dialog */

interface Choice {
  title: string;
  options: { value: string; label: string; hint?: string }[];
  input?: { label: string; placeholder?: string; okLabel: string };
  resolve: (v: { value: string } | { text: string } | null) => void;
}

const choiceStore = makeStore<Choice | null>(null);

export function askChoice(title: string, options: Choice["options"], input?: Choice["input"]): Promise<{ value: string } | { text: string } | null> {
  return new Promise((resolve) => choiceStore.set({ title, options, input, resolve }));
}

function ChoiceHost() {
  const c = choiceStore.use();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState("");
  useEffect(() => { setText(""); setFilter(""); }, [c]);
  if (!c) return null;
  const done = (v: { value: string } | { text: string } | null) => {
    choiceStore.set(null);
    c.resolve(v);
  };
  const shown = c.options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="overlay confirm-layer" onClick={() => done(null)}>
      <div className="card confirm" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && done(null)}>
        <h2>{c.title}</h2>
        {c.options.length > 8 && <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus />}
        <div className="choice-list">
          {shown.map((o) => (
            <button key={o.value} className="choice" onClick={() => done({ value: o.value })}>
              <span>{o.label}</span>{o.hint && <span className="muted small">{o.hint}</span>}
            </button>
          ))}
        </div>
        {c.input && (
          <div className="row">
            <label>{c.input.label}<input value={text} placeholder={c.input.placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && done({ text: text.trim() })} autoFocus={c.options.length <= 8} /></label>
            <button className="primary" disabled={!text.trim()} onClick={() => done({ text: text.trim() })}>{c.input.okLabel}</button>
          </div>
        )}
        <div className="row end"><button onClick={() => done(null)}>Cancel</button></div>
      </div>
    </div>
  );
}

export async function addToCollection(ids: string[], title?: string): Promise<void> {
  let list: Card[] = [];
  try {
    list = await api.collections();
  } catch (e) {
    await track("Collections", () => Promise.reject(errorText(e)));
    return;
  }
  const pick = await askChoice(
    `Add ${title ? `“${title}”` : `${ids.length} titles`} to a collection`,
    list.map((c) => ({ value: c.id, label: c.title, hint: c.subtitle })),
    { label: "Or make a new collection", placeholder: "Name", okLabel: "Create" },
  );
  if (!pick) return;
  if ("text" in pick) {
    await track(`Creating “${pick.text}”`, () => api.collectionCreate(pick.text, ids));
  } else {
    const name = list.find((c) => c.id === pick.value)?.title ?? "collection";
    await track(`Adding to ${name}`, () => api.collectionAdd(pick.value, ids));
  }
}

/* ---------------------------------------------------------- picture viewer */

const lightStore = makeStore<{ src: string; caption?: string } | null>(null);

export function showPicture(src: string, caption?: string): void {
  lightStore.set({ src, caption });
}

function LightboxHost() {
  const l = lightStore.use();
  useEffect(() => {
    if (!l) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && lightStore.set(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [l]);
  if (!l) return null;
  return (
    <div className="lightbox" onClick={() => lightStore.set(null)}>
      <img src={l.src} alt="" />
      {l.caption && <div className="lightbox-cap">{l.caption}</div>}
      <button className="p-round lightbox-x" aria-label="Close">✕</button>
    </div>
  );
}

export function Hosts() {
  return (
    <>
      <MenuHost />
      <ChoiceHost />
      <LightboxHost />
    </>
  );
}

/* -------------------------------------------------------------- images */

/** Pictures this window already showed: they appear at once next time, without a fade. */
const loadedUrls = new Set<string>();

/** Loads pictures in the background so they're there when a page needs them. */
export function preloadImages(urls: string[]): void {
  for (const u of urls) {
    if (!u || loadedUrls.has(u)) continue;
    const im = new Image();
    im.decoding = "async";
    im.onload = () => loadedUrls.add(u);
    im.src = u;
  }
}

export function imageLoaded(url: string): boolean {
  return loadedUrls.has(url);
}

/** An <img> that fades in once loaded (or shows straight away if it was loaded before). */
export function Img({ src, className = "", alt = "", lazy, onFail, onReady }: {
  src: string; className?: string; alt?: string; lazy?: boolean; onFail?: () => void; onReady?: () => void;
}) {
  const [ok, setOk] = useState(() => loadedUrls.has(src));
  const [failed, setFailed] = useState(false);
  useEffect(() => { setOk(loadedUrls.has(src)); setFailed(false); }, [src]);
  useEffect(() => { if (ok) onReady?.(); }, [ok]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return null;
  return (
    <img
      className={`${className} fade-img ${ok ? "in" : ""}`}
      src={src}
      alt={alt}
      loading={lazy ? "lazy" : undefined}
      decoding="async"
      onLoad={() => { loadedUrls.add(src); setOk(true); }}
      onError={() => { setFailed(true); onFail?.(); onReady?.(); }}
    />
  );
}

/* -------------------------------------------------------------- icons */

export type IconName =
  | "reload" | "expand" | "folder" | "play" | "plus" | "check" | "x" | "search" | "more" | "bell"
  | "home" | "tv" | "film" | "stack" | "heart" | "inbox" | "rename" | "image" | "subtitles" | "skip"
  | "missing" | "copy" | "tag" | "disk" | "history" | "settings" | "music" | "info" | "warn" | "pause"
  | "next" | "prev" | "shuffle" | "volume" | "clock" | "wand" | "download" | "list" | "grid" | "trash" | "external"
  | "undo" | "lock" | "server" | "stop" | "chevron" | "infuse" | "wrench" | "queue" | "sort" | "grip";

const ICONS: Record<IconName, ReactNode> = {
  reload: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
  expand: <><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-7 7" /><path d="M4 20l7-7" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  check: <path d="M5 12l5 5 9-10" />,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  more: <><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></>,
  bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  home: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>,
  tv: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M8 3l4 3 4-3" /></>,
  film: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></>,
  stack: <><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></>,
  heart: <path d="M12 20s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z" />,
  inbox: <><path d="M3 13l3-8h12l3 8" /><path d="M3 13v6h18v-6h-5l-1 2h-6l-1-2z" /></>,
  rename: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 17l-5-5-9 8" /></>,
  subtitles: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 14h4M13 14h4M7 10h10" /></>,
  skip: <><path d="M5 5l9 7-9 7z" fill="currentColor" /><path d="M18 5v14" /></>,
  missing: <><circle cx="12" cy="12" r="9" /><path d="M9 9h.01M15 9h.01M8 16c2-2 6-2 8 0" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M4 16V6a2 2 0 0 1 2-2h10" /></>,
  tag: <><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1.5" /></>,
  disk: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  warn: <><path d="M12 3l10 18H2z" /><path d="M12 10v5M12 18v.5" /></>,
  next: <><path d="M5 5l10 7-10 7z" fill="currentColor" /><path d="M19 5v14" /></>,
  prev: <><path d="M19 5L9 12l10 7z" fill="currentColor" /><path d="M5 5v14" /></>,
  shuffle: <><path d="M3 6h4l10 12h4" /><path d="M3 18h4l3-3.6M14 9.6L17 6h4" /><path d="M19 4l2 2-2 2M19 16l2 2-2 2" /></>,
  volume: <><path d="M4 9v6h4l5 4V5L8 9z" /><path d="M16 9a4 4 0 0 1 0 6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  wand: <><path d="M4 20L16 8" /><path d="M15 4v3M18 6h3M19 9v2M13 7h-2" /></>,
  wrench: <path d="M14.7 6.3a4 4 0 0 0 5 5L21 13a6 6 0 0 1-7.6 1.6l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9A6 6 0 0 1 12 4l1.3 1.3a4 4 0 0 0 1.4 1z" />,
  queue: <><path d="M3 6h12M3 12h12M3 18h7" /><path d="M18 14v6M15 17h6" /></>,
  sort: <><path d="M7 4v16M4 17l3 3 3-3" /><path d="M14 6h7M14 12h5M14 18h3" /></>,
  grip: <><circle cx="9" cy="6" r="1.3" fill="currentColor" /><circle cx="15" cy="6" r="1.3" fill="currentColor" /><circle cx="9" cy="12" r="1.3" fill="currentColor" /><circle cx="15" cy="12" r="1.3" fill="currentColor" /><circle cx="9" cy="18" r="1.3" fill="currentColor" /><circle cx="15" cy="18" r="1.3" fill="currentColor" /></>,
  download: <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  grid: <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  trash: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  server: <><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  infuse: <><path d="M4 18l8-13 8 13z" /><path d="M9 14h6" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ico-svg">{ICONS[name]}</svg>
  );
}

/** A link to one section of Settings, e.g. <SettingsLink section="subtitles">Subtitle settings</SettingsLink>. */
export function SettingsLink({ section, children }: { section: string; children: ReactNode }) {
  return <button className="link settings-link" onClick={() => nav.route({ view: "settings", section })}><Icon name="settings" size={12} /> {children}</button>;
}

/** Scans the Jellyfin library into Media Hub's list, with progress. */
/**
 * "Reload data" (top right, or R): asks Jellyfin again for everything the pages show — the
 * library list, which videos have subtitles and art, watch progress, pictures — instead of
 * what Media Hub remembered.
 */
let reloading = false;
export function reloadData(): Promise<void> {
  if (reloading) return Promise.resolve();
  reloading = true;
  return track("Reloading data from Jellyfin", async (job) => {
    job.update("Library list", 0.1);
    const un = await followEvent(job, "sync-progress");
    try { await api.sync(); } finally { un(); }
    job.update("Subtitles, art and names", 0.6);
    const un2 = await followEvent(job, "health-progress");
    try { await api.libraryHealth(true); } finally { un2(); }
    await api.imagesRevalidate().catch(() => undefined);
    bumpArt();
    clearDataCaches();
    job.update("Up to date", 1);
  }, { stop: "sync" }).catch((e) => {
    if (!isStopped(e)) throw e;
  }).finally(() => { reloading = false; });
}

export function scanLibrary(): Promise<void> {
  return track("Scanning the library", async (job) => {
    const un = await followEvent(job, "sync-progress");
    try {
      const r = await api.sync();
      job.update(`${r.movies} movies · ${r.series} shows`, 1);
    } finally {
      un();
    }
  }, { stop: "sync" }).catch((e) => {
    if (!isStopped(e)) throw e;
  });
}

/* --------------------------------------------------------- cards & rows */

/** Plays what a card stands for: the video itself, or a show from where you are. */
export function playCard(c: Card): void {
  if (c.kind === "movie" || c.kind === "episode") nav.play(c.id);
  else if (c.kind === "series" || c.kind === "season") void playTitle(c.id);
  else if (c.kind === "collection") nav.route({ view: "collections", collection: c.id });
  else nav.open(c.id);
}

/**
 * A poster (or wide thumbnail for episodes). Clicking the picture plays it; clicking the
 * text opens the page with info, cast and seasons. Right-click for everything else.
 */
export function CardTile({ c, wide, canEdit = true, inCollection, onOpen, menuExtra }: {
  c: Card; wide?: boolean; canEdit?: boolean; inCollection?: string; onOpen?: (c: Card) => void; menuExtra?: (c: Card) => MenuItem[];
}) {
  const isWide = wide ?? (c.kind === "episode");
  const art = isWide
    ? c.kind === "episode" ? imageUrl(c.id, "Primary", 480) : imageUrl(c.artId, "Thumb", 480)
    : imageUrl(c.artId, "Primary", 300);
  const fallback = isWide ? imageUrl(c.artId, "Backdrop", 480) : null;
  const [broken, setBroken] = useState(false);
  const [broken2, setBroken2] = useState(false);
  const open = () => (onOpen ? onOpen(c) : c.kind === "person" ? undefined : nav.open(c.kind === "episode" && c.seriesId ? c.id : c.id));
  const playable = !onOpen && c.kind !== "person" && c.kind !== "other";
  const menu = (e: React.MouseEvent) => openMenu(e, [
    ...(menuExtra ? [...menuExtra(c), { sep: true }] : []),
    ...itemMenu({ id: c.id, kind: c.kind, title: c.title, seriesId: c.seriesId, played: c.played, inCollection }, canEdit),
  ]);
  return (
    <div className={`tile ${isWide ? "wide" : ""}`} onContextMenu={menu} title={c.title}>
      <button className={`art ${isWide ? "wide cover" : ""} tile-art`} onClick={playable ? () => playCard(c) : open} aria-label={playable ? `Play ${c.title}` : `Open ${c.title}`}>
        {!broken ? (
          <img src={art} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : fallback && !broken2 ? (
          <img src={fallback} alt="" loading="lazy" decoding="async" onError={() => setBroken2(true)} />
        ) : (
          <div className="noart">{c.title}</div>
        )}
        {playable && <span className="tile-play"><Icon name="play" size={20} /></span>}
        {c.played && <span className="played" title="Watched">✓</span>}
        {c.progress != null && c.progress > 0.01 && c.progress < 0.99 && <span className="tile-progress"><span style={{ width: `${c.progress * 100}%` }} /></span>}
      </button>
      <button className="tile-text" onClick={open}>
        <div className="title">{c.title}</div>
        <div className="sub">{c.subtitle}</div>
      </button>
    </div>
  );
}

/**
 * A titled, horizontally scrolling row of cards. Like Netflix: the arrows sit on the row's
 * edges and show on hover; `ranked` puts big numbers in front of the first ten.
 */
export function Row({ title, cards, wide, action, canEdit, inCollection, menuExtra, ranked }: { title: string; cards: Card[]; wide?: boolean; action?: ReactNode; canEdit?: boolean; inCollection?: string; menuExtra?: (c: Card) => MenuItem[]; ranked?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: true });
  if (ranked) cards = cards.slice(0, 10);
  const update = () => {
    const el = ref.current;
    if (el) setEdge({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  };
  useEffect(update, [cards.length]);
  if (!cards.length) return null;
  const scroll = (d: number) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className={`hrow ${ranked ? "ranked" : ""}`}>
      <div className="section-head">
        <h2>{title}</h2>
        <div className="row end">{action}</div>
      </div>
      <div className="hrow-wrap">
        {edge.left && <button className="hrow-arrow left" onClick={() => scroll(-1)} aria-label="Scroll left"><Icon name="chevron" size={22} /></button>}
        <div ref={ref} className={`hrow-scroll ${wide ? "wide" : ""}`} onScroll={update}>
          {cards.map((c, i) => (
            ranked && i < 10 ? (
              <div key={`${c.id}-${c.kind}`} className="rank-tile"><span className="rank-num" aria-hidden="true">{i + 1}</span><CardTile c={c} wide={wide} canEdit={canEdit} inCollection={inCollection} menuExtra={menuExtra} /></div>
            ) : <CardTile key={`${c.id}-${c.kind}`} c={c} wide={wide} canEdit={canEdit} inCollection={inCollection} menuExtra={menuExtra} />
          ))}
        </div>
        {edge.right && <button className="hrow-arrow right" onClick={() => scroll(1)} aria-label="Scroll right"><Icon name="chevron" size={22} /></button>}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ activity */

function goFix(fix: string) {
  if (!fix) return;
  if (fix.startsWith("settings:")) nav.route({ view: "settings", section: fix.slice(9) });
  else nav.route({ view: fix as "settings" });
}

function Alerts() {
  const epoch = useEpoch();
  const [list, setList] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const load = () => api.healthAlerts().then(setList).catch(() => setList([]));
    void load();
    const t = window.setInterval(load, 10 * 60_000);
    return () => window.clearInterval(t);
  }, [epoch]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const serious = list.filter((a) => a.level !== "info").length;
  return (
    <div className="alerts" ref={ref}>
      <button className={`icon-btn ${serious ? "has-alerts" : ""}`} title="Alerts" aria-label="Alerts" onClick={() => setOpen(!open)}>
        <Icon name="bell" />{list.length > 0 && <span className={`alert-count ${serious ? "" : "info"}`}>{list.length}</span>}
      </button>
      {open && (
        <div className="alert-menu">
          <div className="strong">Alerts</div>
          {list.length === 0 && <div className="muted small">All good.</div>}
          {list.map((a, i) => (
            <button key={i} className={`alert-row ${a.level}`} disabled={!a.fix} onClick={() => { setOpen(false); goFix(a.fix); }}>
              <span className={a.level === "error" ? "bad" : a.level === "warn" ? "warn" : "muted"}><Icon name={a.level === "info" ? "info" : "warn"} /></span>
              <div className="grow"><div className="strong small">{a.title}</div><div className="muted small">{a.detail}</div></div>
              {a.fix && <span className="accent small">Fix ›</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ActivityBar() {
  const jobs = useJobs();
  const [spin, setSpin] = useState(false);
  const running = jobs.filter((j) => !j.done);
  return (
    <div className="topbar">
      <div className="jobs">
        {jobs.length === 0 && <span className="muted small">Ready</span>}
        {jobs.slice(-3).map((j) => (
          <div key={j.id} className={`job ${j.done ? (j.error ? "failed" : "done") : ""}`} title={j.error ?? j.detail}>
            {!j.done && <span className="spinner" />}
            {j.done && !j.error && <span className="ok"><Icon name="check" size={14} /></span>}
            <span className="strong small">{j.label}</span>
            <span className={`small ellipsis ${j.error ? "bad" : "muted"}`}>{j.error ?? j.detail}</span>
            {!j.done && j.progress != null && <span className="job-pct mono small">{Math.round(j.progress * 100)}%</span>}
            {!j.done && <span className={`job-bar ${j.progress == null ? "busy" : ""}`}><span style={{ width: j.progress == null ? undefined : `${Math.round(j.progress * 100)}%` }} /></span>}
            {j.cancel && !j.done && <button className="job-stop" onClick={j.cancel} title="Stop" aria-label="Stop"><Icon name="stop" size={10} /> Stop</button>}
            {j.error && <button className="link-plain small" onClick={() => dismiss(j.id)} aria-label="Dismiss"><Icon name="x" size={12} /></button>}
          </div>
        ))}
        {running.length > 3 && <span className="muted small">+{running.length - 3} more</span>}
      </div>
      <Alerts />
      <button
        className={`icon-btn ${spin ? "spinning" : ""}`}
        title="Reload data from Jellyfin: subtitles, art, watch progress, new titles (R)"
        aria-label="Reload data"
        onClick={() => {
          setSpin(true);
          void reloadData().finally(() => setSpin(false));
        }}
      >
        <Icon name="reload" />
      </button>
    </div>
  );
}

/* --------------------------------------------------- tri-state selection */

export type TriState = "all" | "some" | "none";

export function triOf(total: number, picked: number): TriState {
  return picked === 0 || total === 0 ? "none" : picked >= total ? "all" : "some";
}

/** A checkbox that shows a stripe when only part of what it stands for is selected. */
export function TriCheck({ state, onChange, label, disabled, title }: { state: TriState; onChange: (on: boolean) => void; label?: ReactNode; disabled?: boolean; title?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  const box = (
    <input
      ref={ref}
      type="checkbox"
      className={`tri ${state}`}
      checked={state === "all"}
      disabled={disabled}
      title={title}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      // A striped box becomes fully checked on click (like Finder and Gmail).
      onChange={() => onChange(state !== "all")}
      onClick={(e) => e.stopPropagation()}
    />
  );
  return label == null ? box : <label className="check tri-label">{box}<span>{label}</span></label>;
}

/** A set of selected keys with Undo for bulk changes (select all / none / a folder). */
export function useUndoableSet<K>(initial: Iterable<K> = []) {
  const [set, setSet] = useState<Set<K>>(() => new Set(initial));
  const [history, setHistory] = useState<Set<K>[]>([]);
  const push = (next: Set<K>) => {
    setHistory((h) => [...h.slice(-19), set]);
    setSet(next);
  };
  return {
    set,
    has: (k: K) => set.has(k),
    size: set.size,
    toggle: (k: K) => {
      const n = new Set(set);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      setSet(n);
    },
    /** Turns many on or off at once (can be undone). */
    setMany: (keys: Iterable<K>, on: boolean) => {
      const n = new Set(set);
      for (const k of keys) {
        if (on) n.add(k);
        else n.delete(k);
      }
      push(n);
    },
    /** Replaces the whole selection (can be undone). */
    replace: (keys: Iterable<K>) => push(new Set(keys)),
    /** Starts over without an undo step (new data loaded). */
    reset: (keys: Iterable<K> = []) => {
      setHistory([]);
      setSet(new Set(keys));
    },
    canUndo: history.length > 0,
    undo: () => {
      const prev = history[history.length - 1];
      if (!prev) return;
      setHistory(history.slice(0, -1));
      setSet(prev);
    },
    state: (keys: K[]): TriState => triOf(keys.length, keys.filter((k) => set.has(k)).length),
  };
}

/** "Select all · Select none · Undo" for a list. */
export function BulkSelect<K>({ sel, keys, noun = "" }: { sel: ReturnType<typeof useUndoableSet<K>>; keys: K[]; noun?: string }) {
  const picked = keys.filter((k) => sel.has(k)).length;
  return (
    <span className="bulk-select">
      <TriCheck state={triOf(keys.length, picked)} onChange={(on) => sel.setMany(keys, on)} title={picked === keys.length ? "Select none" : "Select all"} />
      <span className="muted small">{picked} of {keys.length}{noun ? ` ${noun}` : ""} selected</span>
      <button className="link small" disabled={picked === keys.length} onClick={() => sel.setMany(keys, true)}>All</button>
      <button className="link small" disabled={picked === 0} onClick={() => sel.setMany(keys, false)}>None</button>
      {sel.canUndo && <button className="link small" onClick={sel.undo} title="Undo the last bulk change"><Icon name="undo" size={12} /> Undo</button>}
    </span>
  );
}

/* ------------------------------------------------------------- tabs */

export interface TabDef {
  id: string;
  label: ReactNode;
  count?: number | string;
}

/**
 * Tabs. With `screen` set, every tab but the `fixed` ones has an X to hide it, and the + at
 * the end (always there) shows hidden tabs again and, with `folders`, adds a tab per library
 * folder ("folder:<name>" ids; see `tabFolder`).
 */
export function Tabs({ tabs, active, onChange, screen, fixed = [], folders }: {
  tabs: TabDef[]; active: string; onChange: (id: string) => void; screen?: string; fixed?: string[];
  /** Folder names that can be added as tabs, with an optional count each. */
  folders?: { name: string; count?: number }[];
}) {
  const { hiddenTabs, folderTabs } = usePrefsLite();
  const hidden = screen ? hiddenTabs[screen] ?? [] : [];
  const added = screen && folders ? (folderTabs[screen] ?? []).filter((f) => folders.some((x) => x.name === f)) : [];
  const all: TabDef[] = [...tabs, ...added.map((f) => ({ id: `folder:${f}`, label: f, count: folders?.find((x) => x.name === f)?.count }))];
  const shown = all.filter((t) => !hidden.includes(t.id) || fixed.includes(t.id));
  const closed = tabs.filter((t) => hidden.includes(t.id) && !fixed.includes(t.id));
  const addable = (folders ?? []).filter((f) => !added.includes(f.name));
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!adding) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setAdding(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [adding]);
  const hide = (id: string) => {
    if (!screen) return;
    if (id.startsWith("folder:")) {
      const f = id.slice(7);
      setPrefsLite((p) => ({ folderTabs: { ...p.folderTabs, [screen]: (p.folderTabs[screen] ?? []).filter((x) => x !== f) } }));
    } else {
      setPrefsLite((p) => ({ hiddenTabs: { ...p.hiddenTabs, [screen]: [...new Set([...(p.hiddenTabs[screen] ?? []), id])] } }));
    }
    if (active === id) onChange(shown.find((t) => t.id !== id)?.id ?? fixed[0] ?? "");
  };
  const show = (id: string) => {
    if (!screen) return;
    setPrefsLite((p) => ({ hiddenTabs: { ...p.hiddenTabs, [screen]: (p.hiddenTabs[screen] ?? []).filter((x) => x !== id) } }));
    setAdding(false);
    onChange(id);
  };
  const addFolder = (f: string) => {
    if (!screen) return;
    setPrefsLite((p) => ({ folderTabs: { ...p.folderTabs, [screen]: [...new Set([...(p.folderTabs[screen] ?? []), f])] } }));
    setAdding(false);
    onChange(`folder:${f}`);
  };
  return (
    <div className="tabs ui-tabs">
      {shown.map((t) => (
        <span key={t.id} className={`ui-tab ${active === t.id ? "on" : ""} ${screen && !fixed.includes(t.id) ? "closable" : ""}`}>
          <button onClick={() => onChange(t.id)}>{t.id.startsWith("folder:") && <Icon name="folder" size={13} />}{t.label}{t.count != null && t.count !== "" && <span className="tab-count">{t.count}</span>}</button>
          {screen && !fixed.includes(t.id) && <button className="tab-x" onClick={() => hide(t.id)} aria-label={`Close ${String(t.label)}`} title="Close this tab"><Icon name="x" size={11} /></button>}
        </span>
      ))}
      {screen && (
        <span className="tab-add" ref={ref}>
          <button className="tab-plus" onClick={() => setAdding(!adding)} title={folders ? "Add a folder tab" : "Show a closed tab"} aria-label="Add a tab" disabled={!closed.length && !addable.length}><Icon name="plus" size={14} /></button>
          {adding && (
            <span className="tab-menu">
              {closed.length > 0 && <span className="tab-menu-head">Closed tabs</span>}
              {closed.map((t) => <button key={t.id} onClick={() => show(t.id)}>{t.label}</button>)}
              {addable.length > 0 && <span className="tab-menu-head">Folders</span>}
              {addable.map((f) => <button key={f.name} onClick={() => addFolder(f.name)}><Icon name="folder" size={13} /> {f.name}{f.count != null && <span className="muted small"> {f.count}</span>}</button>)}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------- check menu */

/**
 * A compact dropdown of checkboxes ("Folders: TV, Kids ▾"). The box on the button is
 * striped when only some are ticked; All / None / Undo inside.
 */
export function CheckMenu({ label, options, sel, allLabel = "All" }: {
  label: string;
  options: { id: string; label: ReactNode; count?: number }[];
  sel: ReturnType<typeof useUndoableSet<string>>;
  allLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const ids = options.map((o) => o.id);
  const on = options.filter((o) => sel.has(o.id));
  const summary = on.length === options.length ? allLabel : on.length === 0 ? "None" : on.length <= 2 ? on.map((o) => o.label).join(", ") : `${on.length} of ${options.length}`;
  return (
    <div className="scope" ref={ref}>
      <button className={`scope-btn ${open ? "on" : ""}`} onClick={() => setOpen(!open)}>
        <TriCheck state={sel.state(ids)} onChange={(v) => sel.setMany(ids, v)} />
        <span className="muted small">{label}</span>
        <span className="ellipsis">{summary}</span>
        <span className={`chev down ${open ? "open" : ""}`}><Icon name="chevron" size={12} /></span>
      </button>
      {open && (
        <div className="scope-pop">
          <div className="scope-head"><BulkSelect sel={sel} keys={ids} /></div>
          <div className="scope-list">
            {options.map((o) => (
              <label key={o.id} className="scope-row">
                <input type="checkbox" checked={sel.has(o.id)} onChange={() => sel.toggle(o.id)} />
                <span className="grow ellipsis">{o.label}</span>
                {o.count != null && <span className="muted small">{o.count}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
