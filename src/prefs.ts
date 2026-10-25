// Window-side preferences (player look, skipping, schedules). Kept in this computer's app
// storage; nothing here is secret and nothing here changes Jellyfin.
import { useSyncExternalStore, type CSSProperties } from "react";

export interface SubStyle {
  size: number; // % of the normal size
  font: "sans" | "serif" | "rounded" | "mono";
  color: string;
  background: number; // 0..1 opacity of the box behind the text
  shadow: "none" | "soft" | "outline";
  bottom: number; // % from the bottom of the picture
  bold: boolean;
}

export interface Schedule {
  enabled: boolean;
  hour: number; // runs once a day from this hour on (when the app is open)
  subtitles: boolean;
  art: boolean;
  picks: boolean;
  scan: boolean;
}

export interface Prefs {
  mode: "manage" | "watch";
  subStyle: SubStyle;
  /** Language C switches on (3-letter code). */
  subLang: string;
  autoSkipIntro: boolean;
  autoSkipCredits: boolean;
  /** Recaps are ignored everywhere: no skip button, skipped automatically if marked. */
  recapsOff: boolean;
  /** Seconds before the end of the credits/at the outro to show "up next". */
  upNextAutoplay: boolean;
  minSubScore: number;
  schedule: Schedule;
  lastRun: Record<string, string>;
  /** Shows (series ids) hidden from "Next up" in Media Hub. */
  hiddenNextUp: string[];
  /** Library folders (names or path parts) the subtitle downloader leaves alone. */
  subSkipFolders: string[];
  /** Run intro detection in the background when you play a season without markers. */
  autoDetectIntros: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  mode: "manage",
  subStyle: { size: 100, font: "sans", color: "#ffffff", background: 0, shadow: "outline", bottom: 8, bold: false },
  subLang: "eng",
  autoSkipIntro: false,
  autoSkipCredits: false,
  recapsOff: false,
  upNextAutoplay: true,
  minSubScore: 100,
  schedule: { enabled: false, hour: 4, subtitles: true, art: true, picks: true, scan: true },
  lastRun: {},
  hiddenNextUp: [],
  subSkipFolders: [],
  autoDetectIntros: true,
};

const KEY = "mediahub.prefs.v1";

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULT_PREFS,
      ...p,
      subStyle: { ...DEFAULT_PREFS.subStyle, ...(p.subStyle ?? {}) },
      schedule: { ...DEFAULT_PREFS.schedule, ...(p.schedule ?? {}) },
      lastRun: { ...(p.lastRun ?? {}) },
      hiddenNextUp: p.hiddenNextUp ?? [],
      subSkipFolders: p.subSkipFolders ?? [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: Prefs = load();
const subs = new Set<() => void>();

export function prefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)): void {
  const next = typeof patch === "function" ? patch(current) : patch;
  current = { ...current, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep in memory */
  }
  subs.forEach((f) => f());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => current,
  );
}

const FONTS: Record<SubStyle["font"], string> = {
  sans: '"Manrope", -apple-system, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  rounded: '"SF Pro Rounded", "Arial Rounded MT Bold", "Manrope", sans-serif',
  mono: '"JetBrains Mono", Menlo, monospace',
};

/** CSS for the subtitle text, used by the player and the preview in Settings. */
export function subCss(s: SubStyle): CSSProperties {
  const shadow =
    s.shadow === "outline"
      ? "0 0 2px #000, 0 0 2px #000, 1px 1px 2px #000, -1px -1px 2px #000"
      : s.shadow === "soft"
        ? "0 2px 6px rgba(0,0,0,.85)"
        : "none";
  return {
    fontFamily: FONTS[s.font],
    fontSize: `calc(clamp(16px, 2.6vw, 44px) * ${s.size / 100})`,
    color: s.color,
    background: s.background > 0 ? `rgba(0,0,0,${s.background})` : "transparent",
    textShadow: shadow,
    fontWeight: s.bold ? 700 : 500,
  };
}

/** True when a server path is inside one of the folders the subtitle downloader skips. */
export function subSkipped(path: string | undefined): boolean {
  if (!path) return false;
  const p = "/" + path.replace(/\\/g, "/").toLowerCase() + "/";
  return prefs().subSkipFolders.some((f) => {
    const x = f.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();
    return !!x && p.includes(`/${x}/`);
  });
}
