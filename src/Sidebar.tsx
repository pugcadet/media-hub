import { useEffect, useState } from "react";
import { api, type Attention, type Library, type Status } from "./api";
import type { Route, View } from "./nav";
import { UpdateBadge } from "./Updates";
import { setPrefs, usePrefs } from "./prefs";
import { Icon, type IconName } from "./ui";
import { noSubsOf } from "./fixers";

interface Props {
  status: Status;
  libraries: Library[];
  attention: Attention | null;
  route: Route;
  onRoute: (r: Route) => void;
}

/** The main menu: one place per job. */
const MENU: { view: View; label: string; icon: IconName; also?: View[] }[] = [
  { view: "home", label: "Home", icon: "home" },
  { view: "add", label: "Inbox", icon: "inbox" },
  { view: "library", label: "Library", icon: "film", also: ["metadata", "health", "collections"] },
  { view: "renamer", label: "Renamer", icon: "rename" },
  { view: "subtitles", label: "Subtitles", icon: "subtitles" },
  { view: "intros", label: "Intros and credits", icon: "skip" },
  { view: "cleanup", label: "Clean-up", icon: "wrench", also: ["missing", "duplicates", "tags", "storage"] },
  { view: "jellyfin", label: "Jellyfin", icon: "server" },
  { view: "history", label: "History and undo", icon: "history" },
];

/** The name in the top-left corner. */
function Brand({ compact }: { compact?: boolean }) {
  return (
    <div className="hub">
      <div className="hub-btn static">
        <span className="logo big"><Icon name="wrench" size={16} /></span>
        {!compact && <span className="hub-text"><span className="hub-name">Media Hub</span><span className="hub-mode">Jellyfin companion</span></span>}
      </div>
    </div>
  );
}

export default function Sidebar({ status, attention, route, onRoute }: Props) {
  const [inbox, setInbox] = useState(0);
  const { subSkipFolders } = usePrefs();
  const [subsTodo, setSubsTodo] = useState<number | null>(null);
  useEffect(() => {
    // Leaves out the folders you don't want subtitles for (what the Subtitles page lists).
    api.libraryHealth(false).then((h) => setSubsTodo(h.rows.reduce((n, r) => n + noSubsOf(r), 0))).catch(() => setSubsTodo(null));
  }, [route.view, subSkipFolders.join("|")]);
  useEffect(() => {
    const load = () => api.inboxList().then(([, l]) => setInbox(l.length)).catch(() => setInbox(0));
    void load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, [route.view]);
  const badge = (v: View): string => {
    if (!attention) return "";
    if (v === "subtitles") return subsTodo ? String(subsTodo) : subsTodo === 0 ? "" : attention.noSubtitles ? String(attention.noSubtitles) : "";
    if (v === "library" && attention.unmatched + attention.noPoster) return String(attention.unmatched + attention.noPoster);
    if (v === "add" && inbox) return String(inbox);
    return "";
  };

  const { sidebarSmall } = usePrefs();
  const item = (view: View, label: string, icon: IconName, on: boolean, extra?: string) => (
    <button key={view + label} className={`sb-item ${on ? "on" : ""}`} onClick={() => onRoute({ view })} title={sidebarSmall ? label : undefined}>
      <span><Icon name={icon} />{!sidebarSmall && label}</span>
      {!sidebarSmall && extra ? <span className="sb-badge">{extra}</span> : null}
    </button>
  );
  return (
    <nav className={`sidebar ${sidebarSmall ? "small" : ""}`}>
      <div className="sb-top">
        <Brand compact={sidebarSmall} />
        <button className="icon-btn sb-collapse" onClick={() => setPrefs({ sidebarSmall: !sidebarSmall })} title={sidebarSmall ? "Show the menu" : "Make the menu small"} aria-label={sidebarSmall ? "Expand menu" : "Collapse menu"}>
          <span className={sidebarSmall ? "" : "flip"}><Icon name="chevron" size={14} /></span>
        </button>
      </div>
      {MENU.map((t) => item(t.view, t.label, t.icon, route.view === t.view || !!t.also?.includes(route.view), badge(t.view)))}
      <div className="spacer" />
      {!sidebarSmall && <UpdateBadge />}
      {item("settings", "Settings", "settings", route.view === "settings", status.readOnly ? "read-only" : "")}
      {!sidebarSmall && (
        <button className="sb-conn" onClick={() => onRoute({ view: "settings" })}>
          <div className="sb-conn-title"><span className="dot ok" />{status.serverName ?? "Jellyfin"} connected</div>
          <div className="mono sb-conn-path">{status.libraryRoot ?? "No library folder yet"}</div>
        </button>
      )}
    </nav>
  );
}
