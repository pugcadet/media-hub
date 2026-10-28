// "Studio" layout for tool pages: a list of titles on the left (with coloured dots for what's
// right and what's missing), everything about the chosen one on the right.
import { useEffect, useRef, type ReactNode } from "react";

export interface Dot {
  /** true = fine, false = missing, null = not known */
  ok: boolean | null;
  label: string;
}

export interface StudioItem {
  id: string;
  title: string;
  sub?: string;
  thumb?: string;
  dots?: Dot[];
  /** Section the item is listed under ("Sure matches", "Needs a look" …). */
  group?: string;
  /** Something in front (a checkbox). */
  lead?: ReactNode;
  /** Something at the end (a chip). */
  tail?: ReactNode;
  /** Missing artwork: an amber outline around the picture. */
  warn?: boolean;
  /** Status icons (instead of dots). */
  status?: ReactNode;
}

export function Dots({ dots }: { dots: Dot[] }) {
  return (
    <span className="dots" aria-label={dots.map((d) => `${d.label}: ${d.ok === null ? "unknown" : d.ok ? "fine" : "missing"}`).join(", ")}>
      {dots.map((d, i) => <span key={i} className={`dot ${d.ok === null ? "unknown" : d.ok ? "ok" : "no"}`} title={`${d.label}: ${d.ok === null ? "not checked" : d.ok ? "fine" : "missing"}`} />)}
    </span>
  );
}

export function Studio({ items, selected, onSelect, onMenu, onOpen, head, empty, children, limit = 800 }: {
  items: StudioItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Right-click on a row. */
  onMenu?: (id: string, e: React.MouseEvent) => void;
  /** Double-click on a row (open it full size). */
  onOpen?: (id: string) => void;
  /** Filters, search and bulk actions above the list. */
  head?: ReactNode;
  /** Shown in the list when it's empty. */
  empty?: ReactNode;
  /** The inspector for the selected item. */
  children?: ReactNode;
  limit?: number;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const shown = items.slice(0, limit);

  // ↑ / ↓ move through the list (when not typing somewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const i = shown.findIndex((x) => x.id === selected);
      const next = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        onSelect(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selected, onSelect]);

  useEffect(() => {
    listRef.current?.querySelector(".studio-item.on")?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  let lastGroup: string | undefined;
  return (
    <div className="studio">
      <div className="studio-list">
        {head && <div className="studio-head">{head}</div>}
        <div className="studio-items" ref={listRef}>
          {shown.map((it) => {
            const header = it.group && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="studio-group">{header}</div>}
                <div className={`studio-item ${selected === it.id ? "on" : ""}`} onClick={() => onSelect(it.id)} onDoubleClick={onOpen && (() => onOpen(it.id))} onContextMenu={onMenu && ((e) => onMenu(it.id, e))} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(it.id)}>
                  {it.lead && <span className="studio-lead" onClick={(e) => e.stopPropagation()}>{it.lead}</span>}
                  {it.thumb !== undefined && (
                    <span className={`studio-thumb ${it.warn ? "warn" : ""}`}>{it.thumb ? <img src={it.thumb} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : null}</span>
                  )}
                  <span className="studio-text">
                    <span className="studio-title ellipsis">{it.title}</span>
                    {it.sub && <span className="muted small ellipsis">{it.sub}</span>}
                  </span>
                  {it.tail}
                  {it.status ?? (it.dots && <Dots dots={it.dots} />)}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="muted small pad">{empty ?? "Nothing here."}</div>}
          {items.length > limit && <div className="muted small pad">Showing the first {limit}. Use the filter to narrow it down.</div>}
        </div>
      </div>
      <div className="studio-pane">{children ?? <div className="studio-blank muted">Pick a title on the left.</div>}</div>
    </div>
  );
}
