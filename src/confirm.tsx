// In-app confirmation dialog. Browser pop-ups (window.confirm) are not reliable inside
// the app window on every system, so the app shows its own.
import { useEffect, useState, useSyncExternalStore } from "react";

interface Request {
  text: string;
  okLabel: string;
  danger: boolean;
  requireText?: string;
  resolve: (ok: boolean) => void;
}

let queue: Request[] = [];
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export function askConfirm(text: string, opts: { okLabel?: string; danger?: boolean; requireText?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { text, okLabel: opts.okLabel ?? "OK", danger: !!opts.danger, requireText: opts.requireText, resolve }];
    notify();
  });
}

function answer(ok: boolean) {
  const [first, ...rest] = queue;
  queue = rest;
  notify();
  first?.resolve(ok);
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => queue[0],
  );
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [current]);
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]);
  if (!current) return null;
  const blocked = !!current.requireText && typed !== current.requireText;
  return (
    <div className="overlay confirm-layer" onClick={() => answer(false)}>
      <div className="card confirm" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-text">{current.text}</p>
        {current.requireText && (
          <label className="small muted">
            Type {current.requireText} to confirm
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        <div className="row end">
          <button onClick={() => answer(false)}>Cancel</button>
          <button className={current.danger ? "danger" : "primary"} disabled={blocked} autoFocus={!current.requireText} onClick={() => answer(true)}>
            {current.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
