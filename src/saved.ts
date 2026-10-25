// What a scan found (even nothing), kept on this computer with when it ran, and each
// screen's own settings (filters, sorts, tabs) so it opens the way you left it.
import { useCallback, useState } from "react";
import { prefs, setPrefs } from "./prefs";

const PREFIX = "mediahub.scan.";

export interface Saved<T> {
  at: number;
  data: T;
}

export function readSaved<T>(key: string): Saved<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as Saved<T>) : null;
  } catch {
    return null;
  }
}

export function writeSaved<T>(key: string, data: T): Saved<T> {
  const v = { at: Date.now(), data };
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(v));
  } catch {
    /* too big or storage off: keep it for this session only */
  }
  return v;
}

/** A scan result that survives closing the app. `null` = never ran. */
export function useSaved<T>(key: string): [Saved<T> | null, (data: T) => void] {
  const [v, setV] = useState<Saved<T> | null>(() => readSaved<T>(key));
  const save = useCallback((data: T) => setV(writeSaved(key, data)), [key]);
  return [v, save];
}

/** "Checked 5 min ago" style text. */
export function agoText(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(ms).toLocaleDateString();
}

/** A screen setting that is remembered (per `key`), like useState. */
export function usePageState<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [v, setV] = useState<T>(() => {
    const saved = prefs().pageState[key];
    return saved === undefined ? initial : (saved as T);
  });
  const set = useCallback((next: T | ((old: T) => T)) => {
    setV((old) => {
      const value = typeof next === "function" ? (next as (o: T) => T)(old) : next;
      setPrefs((p) => ({ pageState: { ...p.pageState, [key]: value } }));
      return value;
    });
  }, [key]);
  return [v, set];
}
