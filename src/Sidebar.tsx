import type { Attention, Library, Status } from "./api";
import type { Route, View } from "./App";
import { UpdateBadge } from "./Updates";

interface Props {
  status: Status;
  libraries: Library[];
  attention: Attention | null;
  route: Route;
  onRoute: (r: Route) => void;
}

const TOOLS: { view: View; label: string }[] = [
  { view: "renamer", label: "Renamer" },
  { view: "metadata", label: "Metadata and art" },
  { view: "subtitles", label: "Subtitles" },
  { view: "intros", label: "Intros and credits" },
  // Storage and Downloads are parked for now (code kept, hidden from the menu).
];

export default function Sidebar({ status, libraries, attention, route, onRoute }: Props) {
  const libs: { id: string | null; label: string; count: number }[] = libraries.length
    ? libraries.map((l) => ({ id: l.id, label: l.name, count: l.count }))
    : [
        { id: null, label: "Everything", count: status.movies + status.series },
      ];
  const badge = (v: View): string => {
    if (!attention) return "";
    if (v === "subtitles" && attention.noSubtitles) return String(attention.noSubtitles);
    if (v === "metadata" && attention.unmatched + attention.noPoster) return String(attention.unmatched + attention.noPoster);
    return "";
  };
  const isOn = (r: Partial<Route>) => route.view === r.view && (r.library === undefined || route.library === r.library);

  return (
    <nav className="sidebar">
      <div className="sb-brand"><span className="logo big" />Media Hub</div>
      <div className="sb-head">Library</div>
      {libs.map((l) => (
        <button
          key={l.id ?? "all"}
          className={`sb-item ${isOn({ view: "library", library: l.id ?? undefined }) || (l.id === null && route.view === "library") ? "on" : ""}`}
          onClick={() => onRoute({ view: "library", library: l.id ?? undefined })}
        >
          <span>{l.label}</span>
          <span className="sb-badge">{l.count}</span>
        </button>
      ))}
      <div className="sb-head">Tools</div>
      {TOOLS.map((t) => (
        <button key={t.view} className={`sb-item ${route.view === t.view ? "on" : ""}`} onClick={() => onRoute({ view: t.view })}>
          <span>{t.label}</span>
          <span className="sb-badge">{badge(t.view)}</span>
        </button>
      ))}
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
