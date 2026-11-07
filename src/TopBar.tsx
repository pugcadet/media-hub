// The menu along the top: Home, Library and Jellyfin on the left; the Inbox (with how many
// downloads are waiting), History and Settings on the right. Same look as Jellyfin.
import { useEffect, useState } from "react";
import { api, type Status } from "./api";
import type { Route, View } from "./nav";
import { ActivityBar, Icon } from "./ui";
import { UpdateBadge } from "./Updates";

/** Which top item a screen belongs to: everything about your files lives in the Library. */
export function section(v: View): "home" | "library" | "jellyfin" | "add" | "history" | "settings" {
  if (v === "home" || v === "jellyfin" || v === "add" || v === "history" || v === "settings") return v;
  return "library";
}

/** Media Hub's own mark (the app icon): a play shape in Jellyfin's purple-to-blue. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="100 100 824 824" aria-hidden="true">
      <defs>
        <linearGradient id="mh-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#AA5CC3" />
          <stop offset="1" stopColor="#00A4DC" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#222" />
      <path d="M402 318 C402 286 436 266 464 282 L716 470 C742 488 742 536 716 554 L464 742 C436 758 402 738 402 706 Z" fill="url(#mh-logo)" />
    </svg>
  );
}

export default function TopBar({ status, route, onRoute }: { status: Status; route: Route; onRoute: (r: Route) => void }) {
  const [inbox, setInbox] = useState(0);
  useEffect(() => {
    const load = () => api.inboxList().then(([, l]) => setInbox(l.length)).catch(() => setInbox(0));
    void load();
    const t = window.setInterval(load, 2 * 60_000);
    return () => window.clearInterval(t);
  }, [route.view, route.n]);
  const on = section(route.view);
  const tab = (v: View, label: string) => (
    <button key={v} className={`tb-nav ${on === v ? "on" : ""}`} aria-current={on === v ? "page" : undefined} onClick={() => onRoute({ view: v })}>{label}</button>
  );
  return (
    <header className="tb">
      <button className="tb-brand" onClick={() => onRoute({ view: "home" })} title={status.serverName ? `Connected to ${status.serverName}` : "Home"}>
        <Logo />
        <span className="tb-name">Media Hub</span>
      </button>
      <nav className="tb-menu" aria-label="Main">
        {tab("home", "Home")}
        {tab("library", "Library")}
        {tab("jellyfin", "Jellyfin")}
      </nav>
      <div className="tb-activity"><ActivityBar /></div>
      <UpdateBadge compact />
      <button className={`tb-inbox ${on === "add" ? "on" : ""}`} aria-label={`Inbox${inbox ? `: ${inbox} downloads` : ""}`} onClick={() => onRoute({ view: "add" })}>
        <span className="tb-plus">+</span>Inbox{inbox > 0 && <span className="tb-count">{inbox}</span>}
      </button>
      <button className={`tb-btn ${on === "history" ? "on" : ""}`} onClick={() => onRoute({ view: "history" })}>History</button>
      <button className={`tb-btn icon ${on === "settings" ? "on" : ""}`} aria-label="Settings" title={status.readOnly ? "Settings (read-only mode)" : "Settings"} onClick={() => onRoute({ view: "settings" })}>
        <Icon name="settings" size={16} />
      </button>
    </header>
  );
}
