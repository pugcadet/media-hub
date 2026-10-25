// Shared pieces: right-click menus, picture viewer, choice dialog, cards and rows,
// and the activity bar at the top of the window.
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, api, Card, errorText, imageUrl } from "./api";
import { dismiss, reloadAll, track, useEpoch, useJobs } from "./activity";
import { nav } from "./nav";

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

/* -------------------------------------------------------------- icons */

export function Icon({ name, size = 16 }: { name: "reload" | "expand" | "folder" | "play" | "plus" | "check" | "x" | "search" | "more" | "bell"; size?: number }) {
  const p: Record<string, ReactNode> = {
    reload: <><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></>,
    expand: <><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-7 7" /><path d="M4 20l7-7" /></>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    play: <path d="M7 4.5v15l13-7.5z" fill="currentColor" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    check: <path d="M5 12l5 5 9-10" />,
    x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
    bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
    more: <><circle cx="5" cy="12" r="1.5" fill="currentColor" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><circle cx="19" cy="12" r="1.5" fill="currentColor" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name]}</svg>
  );
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

/** A titled, horizontally scrolling row of cards. */
export function Row({ title, cards, wide, action, canEdit, inCollection, menuExtra }: { title: string; cards: Card[]; wide?: boolean; action?: ReactNode; canEdit?: boolean; inCollection?: string; menuExtra?: (c: Card) => MenuItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  if (!cards.length) return null;
  const scroll = (d: number) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.85, behavior: "smooth" });
  return (
    <section className="hrow">
      <div className="section-head">
        <h2>{title}</h2>
        <div className="row end">
          {action}
          <button className="p-round sm" onClick={() => scroll(-1)} aria-label="Scroll left">‹</button>
          <button className="p-round sm" onClick={() => scroll(1)} aria-label="Scroll right">›</button>
        </div>
      </div>
      <div ref={ref} className={`hrow-scroll ${wide ? "wide" : ""}`}>
        {cards.map((c) => <CardTile key={`${c.id}-${c.kind}`} c={c} wide={wide} canEdit={canEdit} inCollection={inCollection} menuExtra={menuExtra} />)}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ activity */

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
            <div key={i} className={`alert-row ${a.level}`}>
              <span className={`dot ${a.level === "error" ? "bad" : a.level === "warn" ? "warn" : ""}`} />
              <div><div className="strong small">{a.title}</div><div className="muted small">{a.detail}</div></div>
            </div>
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
            {j.progress != null && !j.done && <span className="job-bar"><span style={{ width: `${Math.round(j.progress * 100)}%` }} /></span>}
            {j.cancel && !j.done && <button className="link small" onClick={j.cancel}>Stop</button>}
            {j.error && <button className="link-plain small" onClick={() => dismiss(j.id)} aria-label="Dismiss"><Icon name="x" size={12} /></button>}
          </div>
        ))}
        {running.length > 3 && <span className="muted small">+{running.length - 3} more</span>}
      </div>
      <Alerts />
      <button
        className={`icon-btn ${spin ? "spinning" : ""}`}
        title="Reload everything (R)"
        aria-label="Reload"
        onClick={() => {
          setSpin(true);
          reloadAll();
          window.setTimeout(() => setSpin(false), 700);
        }}
      >
        <Icon name="reload" />
      </button>
    </div>
  );
}
