import { useEffect, useRef, useState } from "react";
import { api, type Attention, type Library, type Status } from "./api";
import type { Route, View } from "./nav";
import { UpdateBadge } from "./Updates";
import { setPrefs, usePrefs } from "./prefs";
import { Icon, type IconName } from "./ui";

interface Props {
  status: Status;
  libraries: Library[];
  attention: Attention | null;
  route: Route;
  onRoute: (r: Route) => void;
}

const TOOLS: { view: View; label: string; icon: IconName; also?: View[] }[] = [
  { view: "health", label: "Library health", icon: "check" },
  { view: "metadata", label: "Metadata and art", icon: "image" },
  { view: "subtitles", label: "Subtitles", icon: "subtitles" },
  { view: "intros", label: "Intros and credits", icon: "skip" },
  { view: "renamer", label: "Renamer", icon: "rename" },
  { view: "cleanup", label: "Clean-up", icon: "wand", also: ["missing", "duplicates", "tags", "storage"] },
  // Downloads is parked for now (code kept, hidden from the menu).
];

function libIcon(kind: string): IconName {
  return kind === "movies" ? "film" : kind === "tvshows" ? "tv" : "stack";
}

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
  const items: { id: "manage" | "watch" | "music" | null; label: string; hint: string; icon: IconName }[] = [
    { id: "manage", label: "Media manager", hint: "Fix names, art, subtitles, intros", icon: "wand" },
    { id: "watch", label: "Player", hint: "Browse and watch", icon: "play" },
    { id: "music", label: "Music", hint: "Albums, artists, songs", icon: "music" },
    { id: null, label: "Downloads", hint: "Later", icon: "download" },
  ];
  return (
    <div className="hub" ref={ref}>
      <button className="hub-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="logo big" />
        <span className="hub-text">
          <span className="hub-name">Media Hub</span>
          <span className="hub-mode">{mode === "watch" ? "Player" : mode === "music" ? "Music" : "Media manager"} ▾</span>
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
              <span className="hub-opt-ico"><Icon name={it.icon} /></span>
              <span className="grow"><span className="strong">{it.label}</span><br /><span className="muted small">{it.hint}</span></span>
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
  const libs: { id: string | null; label: string; count: number; kind: string }[] = libraries.length
    ? libraries.map((l) => ({ id: l.id, label: l.name, count: l.count, kind: l.kind }))
    : [{ id: null, label: "Everything", count: status.movies + status.series, kind: "mixed" }];
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
      <button className={`sb-item ${route.view === "home" ? "on" : ""}`} onClick={() => onRoute({ view: "home" })}><span><Icon name="home" />Home</span></button>
      <div className="sb-head">Library</div>
      {libs.map((l) => (
        <button
          key={l.id ?? "all"}
          className={`sb-item ${route.view === "library" && (route.library === (l.id ?? undefined) || (l.id === null && !route.library)) && !route.flag ? "on" : ""}`}
          onClick={() => onRoute({ view: "library", library: l.id ?? undefined })}
        >
          <span><Icon name={libIcon(l.kind)} />{l.label}</span>
          <span className="sb-badge">{l.count}</span>
        </button>
      ))}
      <button className={`sb-item ${route.view === "collections" ? "on" : ""}`} onClick={() => onRoute({ view: "collections" })}><span><Icon name="stack" />Collections</span></button>
      <div className="sb-head">Fix</div>
      {TOOLS.map((t) => (
        <button key={t.view} className={`sb-item ${route.view === t.view || t.also?.includes(route.view) ? "on" : ""}`} onClick={() => onRoute({ view: t.view })}>
          <span><Icon name={t.icon} />{t.label}</span>
          <span className="sb-badge">{badge(t.view)}</span>
        </button>
      ))}
      <button className={`sb-item ${route.view === "history" ? "on" : ""}`} onClick={() => onRoute({ view: "history" })}><span><Icon name="history" />History and undo</span></button>
      <div className="spacer" />
      <UpdateBadge />
      <button className={`sb-item ${route.view === "add" ? "on" : ""}`} onClick={() => onRoute({ view: "add" })}>
        <span><Icon name="plus" />Add show or movie</span>
        <span className="sb-badge">{badge("add")}</span>
      </button>
      <button className={`sb-item ${route.view === "settings" ? "on" : ""}`} onClick={() => onRoute({ view: "settings" })}>
        <span><Icon name="settings" />Settings</span>
        <span className="sb-badge">{status.readOnly ? "read-only" : ""}</span>
      </button>
      <button className="sb-conn" onClick={() => onRoute({ view: "settings" })}>
        <div className="sb-conn-title"><span className="dot ok" />{status.serverName ?? "Jellyfin"} connected</div>
        <div className="mono sb-conn-path">{status.libraryRoot ?? "No library folder yet"}</div>
      </button>
    </nav>
  );
}
