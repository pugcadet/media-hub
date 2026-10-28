// Building blocks every screen uses, so they all look and behave the same: the page header,
// the folder tabs (the Library's style), a search box with a clear button, icon buttons,
// the toolbar row and the status icons in lists.
import { useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./ui";
import { moveFolder, orderFolders, usePrefs } from "./prefs";

/** Title on the left, a short line under it, actions on the right. Same height everywhere. */
export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="k-head">
      <div className="k-head-text">
        <h1>{title}</h1>
        <div className="muted small k-sub">{sub ?? " "}</div>
      </div>
      {actions && <div className="k-actions">{actions}</div>}
    </div>
  );
}

export interface KTab {
  id: string;
  label: ReactNode;
  icon?: IconName;
  count?: number | string | null;
  /** Amber count (something to do). */
  warn?: boolean;
}

/**
 * The tab row used everywhere (the Library's look). With `folders`, the folder tabs follow
 * your folder order and can be dragged into a new order (it applies to every screen).
 */
export function KTabs({ tabs, active, onChange, folders = false, after }: {
  tabs: KTab[]; active: string; onChange: (id: string) => void; folders?: boolean; after?: ReactNode;
}) {
  usePrefs(); // re-render when the folder order changes
  const fixed = folders ? tabs.filter((t) => t.id.startsWith("@")) : tabs;
  const movable = folders ? orderFolders(tabs.filter((t) => !t.id.startsWith("@")), (t) => t.id) : [];
  const names = movable.map((t) => t.id);
  const dragged = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const tab = (t: KTab, drag: boolean) => (
    <button
      key={t.id}
      role="tab"
      aria-selected={active === t.id}
      className={`${active === t.id ? "on" : ""} ${over === t.id ? "drop" : ""}`}
      onClick={() => onChange(t.id)}
      draggable={drag}
      onDragStart={drag ? (e) => { dragged.current = t.id; e.dataTransfer.effectAllowed = "move"; } : undefined}
      onDragOver={drag ? (e) => { if (dragged.current && dragged.current !== t.id) { e.preventDefault(); setOver(t.id); } } : undefined}
      onDragLeave={drag ? () => setOver(null) : undefined}
      onDrop={drag ? (e) => { e.preventDefault(); setOver(null); if (dragged.current) moveFolder(names, dragged.current, t.id); dragged.current = null; } : undefined}
      onDragEnd={() => { dragged.current = null; setOver(null); }}
      title={drag ? "Drag to change the order of your folders" : undefined}
    >
      {t.icon && <Icon name={t.icon} size={14} />}
      <span>{t.label}</span>
      {t.count != null && t.count !== "" && <span className={`count ${t.warn ? "warn" : ""}`}>{t.count}</span>}
    </button>
  );
  return (
    <div className="k-tabs-row">
      <div className="lib-tabs k-tabs" role="tablist">
        {fixed.filter((t) => t.id === "@all").map((t) => tab(t, false))}
        {movable.map((t) => tab(t, true))}
        {fixed.filter((t) => t.id !== "@all").map((t) => tab(t, false))}
      </div>
      {after}
    </div>
  );
}

/** Icon for a library folder by its name. */
export function folderIcon(name: string): IconName {
  return /youtube/i.test(name) ? "play" : /movie|film/i.test(name) ? "film" : /tv|show|serie|kids|anime/i.test(name) ? "tv" : /music/i.test(name) ? "music" : "folder";
}

/** "All" plus one tab per folder, with counts. */
export function folderTabs(names: string[], count: (name: string | null) => number | null, allLabel = "All"): KTab[] {
  return [
    { id: "@all", label: allLabel, icon: "stack", count: count(null) },
    ...names.map((n) => ({ id: n, label: n, icon: folderIcon(n), count: count(n) })),
  ];
}

/** Search box with an X to clear it. */
export function SearchBox({ value, onChange, placeholder = "Search", autoFocus, wide }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <label className={`searchbox k-search ${wide ? "wide" : ""}`}>
      <Icon name="search" />
      <input ref={ref} placeholder={placeholder} value={value} autoFocus={autoFocus} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape" && value) { e.stopPropagation(); onChange(""); } }} />
      {value && (
        <button type="button" className="k-clear" aria-label="Clear the search" title="Clear (Esc)" onClick={() => { onChange(""); ref.current?.focus(); }}>
          <Icon name="x" size={12} />
        </button>
      )}
    </label>
  );
}

/** A square button with just an icon (the name shows on hover). */
export function IconBtn({ icon, title, onClick, disabled, on, size = 16 }: { icon: IconName; title: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; on?: boolean; size?: number }) {
  return (
    <button className={`icon-btn k-icon ${on ? "on" : ""}`} title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={size} />
    </button>
  );
}

/** One row of controls under the tabs: search and filters left, layout switches right. */
export function Toolbar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="k-toolbar">
      <div className="k-toolbar-left">{children}</div>
      {right && <div className="k-toolbar-right">{right}</div>}
    </div>
  );
}

/** A segmented switch (All · Needs work · Complete). */
export function Seg<T extends string>({ value, onChange, options, icons }: { value: T; onChange: (v: T) => void; options: { id: T; label: ReactNode; title?: string; icon?: IconName }[]; icons?: boolean }) {
  return (
    <div className={`seg-ctl ${icons ? "icons" : ""}`} role="group">
      {options.map((o) => (
        <button key={o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)} title={o.title} aria-label={typeof o.label === "string" ? o.label : o.title}>
          {o.icon && <Icon name={o.icon} size={15} />}
          {!icons && o.label}
        </button>
      ))}
    </div>
  );
}

export interface StatusIcon {
  icon: IconName;
  label: string;
  /** true fine, false missing, null unknown / doesn't apply */
  ok: boolean | null;
  onClick?: () => void;
}

/** What's right and what's missing for a title, as the same icons and order as the filters above. */
export function StatusIcons({ items }: { items: StatusIcon[] }) {
  return (
    <span className="k-status" onClick={(e) => e.stopPropagation()}>
      {items.map((s) => (
        <button
          key={s.label}
          className={`k-st ${s.ok === null ? "unknown" : s.ok ? "ok" : "no"}`}
          title={`${s.label}: ${s.ok === null ? "not checked or not needed" : s.ok ? "fine" : "missing (click to fix)"}`}
          aria-label={`${s.label}: ${s.ok === null ? "unknown" : s.ok ? "fine" : "missing"}`}
          disabled={!s.onClick || s.ok !== false}
          onClick={s.onClick}
        >
          <Icon name={s.icon} size={13} />
        </button>
      ))}
    </span>
  );
}

/** A labelled checkbox that never wraps its text. */
export function Check({ checked, onChange, children, title }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; title?: string }) {
  return (
    <label className="check k-check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}
