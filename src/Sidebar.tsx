import { useEffect, useRef, useState } from "react";
import { api, type Attention, type Library, type Status } from "./api";
import type { Route, View } from "./nav";
import { UpdateBadge } from "./Updates";
import { setPrefs, usePrefs } from "./prefs";

interface Props {
  status: Status;
  libraries: Library[];
  attention: Attention | null;
  route: Route;
  onRoute: (r: Route) => void;
}

const TOOLS: { view: View; label: string }[] = [
  { view: "health", label: "Library health" },
  { view: "add", label: "Add show or movie" },
  { view: "renamer", label: "Renamer" },
  { view: "metadata", label: "Metadata and art" },
  { view: "subtitles", label: "Subtitles" },
  { view: "intros", label: "Intros and credits" },
  { view: "missing", label: "Missing episodes" },
  { view: "duplicates", label: "Duplicates" },
  { view: "tags", label: "Genres and tags" },
  { view: "storage", label: "Storage" },
  // Downloads is parked for now (code kept, hidden from the menu).
];

/** The "hub" in the top-left corner: switches between the parts of Media Hub. */
export function HubSwitcher() {
  const { mode } = usePrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const items: { id: "manage" | "watch" | null; label: string; hint: string }[] = [
    { id: "manage", label: "Media manager", hint: "Fix names, art, subtitles, intros" },
    { id: "watch", label: "Player", hint: "Browse and watch" },
    { id: null, label: "Music", hint: "Later" },
    { id: null, label: "Downloads", hint: "Later" },
  ];
  return (
    <div className="hub" ref={ref}>
      <button className="hub-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="logo big" />
        <span className="hub-text">
          <span className="hub-name">Media Hub</span>
          <span className="hub-mode">{mode === "watch" ? "Player" : "Media manager"} ▾</span>
        </span>
      </button>
      {open && (
        <div className="hub-menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={`hub-opt ${it.id === mode ? "on" : ""}`}
              disabled={!it.id}
              onClick={() => { if (it.id) setPrefs({ mode: it.id }); setOpen(false); }}
            >
              <span className="strong">{it.label}</span>
              <span className="muted small">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ status, libraries, attention, route, onRoute }: Props) {
  const [inbox, setInbox] = useState(0);
  useEffect(() => {
    const load = () => api.inboxList().then(([, l]) => setInbox(l.length)).catch(() => setInbox(0));
    void load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, [route.view]);
  const libs: { id: string | null; label: string; count: number }[] = libraries.length
    ? libraries.map((l) => ({ id: l.id, label: l.name, count: l.count }))
    : [{ id: null, label: "Everything", count: status.movies + status.series }];
  const badge = (v: View): string => {
    if (!attention) return "";
    if (v === "subtitles" && attention.noSubtitles) return String(attention.noSubtitles);
    if (v === "metadata" && attention.unmatched + attention.noPoster) return String(attention.unmatched + attention.noPoster);
    if (v === "add" && inbox) return String(inbox);
    return "";
  };

  return (
    <nav className="sidebar">
      <HubSwitcher />
      <button className={`sb-item ${route.view === "home" ? "on" : ""}`} onClick={() => onRoute({ view: "home" })}><span>Home</span></button>
      <div className="sb-head">Library</div>
      {libs.map((l) => (
        <button
          key={l.id ?? "all"}
          className={`sb-item ${route.view === "library" && (route.library === (l.id ?? undefined) || (l.id === null && !route.library)) && !route.flag ? "on" : ""}`}
          onClick={() => onRoute({ view: "library", library: l.id ?? undefined })}
        >
          <span>{l.label}</span>
          <span className="sb-badge">{l.count}</span>
        </button>
      ))}
      <button className={`sb-item ${route.view === "collections" ? "on" : ""}`} onClick={() => onRoute({ view: "collections" })}><span>Collections</span></button>
      <div className="sb-head">Tools</div>
      {TOOLS.map((t) => (
        <button key={t.view} className={`sb-item ${route.view === t.view ? "on" : ""}`} onClick={() => onRoute({ view: t.view })}>
          <span>{t.label}</span>
          <span className="sb-badge">{badge(t.view)}</span>
        </button>
      ))}
      <button className={`sb-item ${route.view === "history" ? "on" : ""}`} onClick={() => onRoute({ view: "history" })}><span>History and undo</span></button>
      <div className="spacer" />
      <UpdateBadge />
      <button className={`sb-item ${route.view === "settings" ? "on" : ""}`} onClick={() => onRoute({ view: "settings" })}>
        <span>Settings</span>
        <span className="sb-badge">{status.readOnly ? "read-only" : ""}</span>
      </button>
      <button className="sb-conn" onClick={() => onRoute({ view: "settings" })}>
        <div className="sb-conn-title"><span className="dot ok" />{status.serverName ?? "Jellyfin"} connected</div>
        <div className="mono sb-conn-path">{status.libraryRoot ?? "No library folder yet"}</div>
      </button>
    </nav>
  );
}
