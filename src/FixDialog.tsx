// "Fix" always shows first what it is going to do, title by title, and lets you leave
// out kinds of fixes or single titles.
import { useEffect, useState, useSyncExternalStore } from "react";
import { describeFixes, FixKind, FixTarget } from "./fixers";
import { Icon } from "./ui";

interface Req {
  title: string;
  list: FixTarget[];
  what: FixKind[];
  resolve: (r: { list: FixTarget[]; what: FixKind[] } | null) => void;
}

let current: Req | null = null;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

/** Shows the plan; resolves with what you kept, or null when cancelled. */
export function askFixes(title: string, list: FixTarget[], what: FixKind[]): Promise<{ list: FixTarget[]; what: FixKind[] } | null> {
  return new Promise((resolve) => {
    current = { title, list, what, resolve };
    notify();
  });
}

function close(r: { list: FixTarget[]; what: FixKind[] } | null) {
  const c = current;
  current = null;
  notify();
  c?.resolve(r);
}

const KIND_LABEL: Record<FixKind, string> = { art: "Artwork", subs: "Subtitles", rename: "Rename (100% sure only)" };

export function FixDialogHost() {
  const req = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => current);
  const [what, setWhat] = useState<FixKind[]>([]);
  const [off, setOff] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!req) return;
    setWhat(req.what);
    setOff(new Set());
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  const rows = req.list.map((t) => ({ t, parts: describeFixes(t, what) })).filter((r) => r.parts.length);
  const kept = rows.filter((r) => !off.has(r.t.id));
  const kinds = req.what;
  return (
    <div className="overlay confirm-layer" onClick={() => close(null)}>
      <div className="card fix-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><h2>{req.title}</h2><button className="link-plain" onClick={() => close(null)} aria-label="Close"><Icon name="x" /></button></div>
        {kinds.length > 1 && (
          <div className="chips">
            {kinds.map((k) => (
              <label key={k} className={`chip ${what.includes(k) ? "on" : ""}`}>
                <input type="checkbox" checked={what.includes(k)} onChange={() => setWhat((w) => (w.includes(k) ? w.filter((x) => x !== k) : [...w, k]))} /> {KIND_LABEL[k]}
              </label>
            ))}
          </div>
        )}
        <div className="fix-list">
          {rows.length === 0 && <p className="muted">Nothing to do with these choices.</p>}
          {rows.map(({ t, parts }) => (
            <label key={t.id} className={`fix-row ${off.has(t.id) ? "off" : ""}`}>
              <input type="checkbox" checked={!off.has(t.id)} onChange={() => setOff((o) => { const n = new Set(o); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} />
              <span className="grow"><span className="strong">{t.name}</span><span className="muted small"> · {parts.join(" · ")}</span></span>
            </label>
          ))}
        </div>
        <p className="muted small">Everything can be undone in History. Titles that need a decision (not identified, unsure names) are never changed here.</p>
        <div className="row end">
          <button onClick={() => close(null)}>Cancel</button>
          <button className="primary" disabled={!kept.length || !what.length} onClick={() => close({ list: kept.map((r) => r.t), what })}>Fix {kept.length} title{kept.length === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}
