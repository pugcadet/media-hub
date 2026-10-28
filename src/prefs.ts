// Window-side preferences (player look, skipping, schedules). Kept in this computer's app
// storage; nothing here is secret and nothing here changes Jellyfin.
import { useSyncExternalStore, type CSSProperties } from "react";
import type { Pick } from "./api";

export interface SubStyle {
  size: number; // % of the normal size
  font: string;
  color: string;
  background: number; // 0..1 opacity of the box behind the text
  shadow: "none" | "soft" | "outline";
  bottom: number; // % from the bottom of the picture
  bold: boolean;
  italic: boolean;
  /** Outline thickness in px (with the "outline" edge). */
  stroke: number;
  /** Widest the text block may get, % of the picture width. */
  maxWidth: number;
  /** 0.3..1 */
  textOpacity: number;
  /** Extra space between letters, in 1/100 em. */
  letterSpacing: number;
  /** 1.0..1.8 */
  lineHeight: number;
  /** Box colour behind the text (with "background" > 0). */
  boxColor: string;
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
  mode: "manage" | "watch" | "music";
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
  /** Shows (series ids) hidden from "Watching". */
  hiddenNextUp: string[];
  /** Series id → episode Media Hub marked as watched to take the show off Jellyfin's Next Up. */
  nextUpMarks: Record<string, string>;
  /** Also mark today's picks as favourites (they show on Infuse's home screen). */
  picksAsFavorites: boolean;
  /** Picks Media Hub made a favourite (only these are unmarked again). */
  pickFavs: string[];
  /** Subtitle languages that must be there; the others are only fetched when a perfect match exists. */
  subRequired: string[];
  /** The first-run checklist on Home was closed. */
  setupDone: boolean;
  /** Library folders (names or path parts) the subtitle downloader leaves alone. */
  subSkipFolders: string[];
  /** Run intro detection in the background when you play a season without markers. */
  autoDetectIntros: boolean;
  /**
   * Year in show names. "folder": "Bluey (2018)/Season 01/Bluey - S01E01.mkv" (what Jellyfin
   * recommends; existing names are never changed just for a year). "everywhere": also in
   * every episode file. "never": no year for shows at all. Movies always get the year.
   */
  showYear: "folder" | "everywhere" | "never";
  /** Tabs you closed, per screen ("intros" → library ids). */
  hiddenTabs: Record<string, string[]>;
  /** Pictures you gave up on per title ("id" → ["Logo", …]): they don't count as missing. */
  artSkipped: Record<string, string[]>;
  /** Shows left out of the missing-episodes list, and whether specials count. */
  missingIgnored: string[];
  missingSpecials: boolean;
  /** Folders (top level under the library folder) "Play something" picks from; empty = all. */
  randomFolders: string[];
  /** Your changes to today's picks: date → ids added / removed. */
  pickEdits: Record<string, { add: Pick[]; remove: string[] }>;
  /** A folder with music on this computer or the NAS (played without Jellyfin). */
  musicFolder: string | null;
  /** Subtitle languages to keep (others can be removed in one go). */
  keepSubLangs: string[];
  /** The app's highlight colour (buttons, selection, focus). Status colours stay green/amber/red. */
  accent: string;
  /** Folders (top level under the library folder) picks of the day come from; empty = all. */
  picksFolders: string[];
  /** Folder tabs you added per screen ("intros" → ["Kids", "Anime"]). */
  folderTabs: Record<string, string[]>;
  /**
   * What the library check renames. "messy": only names with release tags or dots (what
   * Jellyfin might misread); "style": everything that differs from the naming style.
   */
  tidy: "messy" | "style";
  /** The left menu shows icons only. */
  sidebarSmall: boolean;
  /** Size of the whole interface (1 = normal). */
  uiScale: number;
  /** Library: tiles or a list, and how big the tiles are. */
  libraryView: "list" | "tiles";
  tileSize: number;
  /** What auto-detect looks for. */
  detectIntro: boolean;
  detectCredits: boolean;
  /** Screens' own settings (filters, sorts, tabs), so they open the way you left them. */
  pageState: Record<string, unknown>;
  /** Your order of the library folders, used in every folder tab row and list. */
  folderOrder: string[];
  /** Checks that don't apply to a title ("id" → ["subtitles", "intros"]): they count as fine. */
  checksOff: Record<string, string[]>;
  /** Order of the buttons at the top of the player. */
  playerMenu: string[];
  /** Order of the music tabs. */
  musicTabs: string[];
}

export const DEFAULT_PREFS: Prefs = {
  mode: "manage",
  subStyle: { size: 100, font: "sans", color: "#ffffff", background: 0, shadow: "outline", bottom: 8, bold: false, italic: false, stroke: 2, maxWidth: 80, textOpacity: 1, letterSpacing: 0, lineHeight: 1.3, boxColor: "#000000" },
  subLang: "eng",
  autoSkipIntro: false,
  autoSkipCredits: false,
  recapsOff: false,
  upNextAutoplay: true,
  minSubScore: 100,
  schedule: { enabled: false, hour: 4, subtitles: true, art: true, picks: true, scan: true },
  lastRun: {},
  hiddenNextUp: [],
  nextUpMarks: {},
  picksAsFavorites: false,
  pickFavs: [],
  subRequired: ["eng"],
  setupDone: false,
  subSkipFolders: [],
  autoDetectIntros: true,
  showYear: "folder",
  hiddenTabs: {},
  artSkipped: {},
  missingIgnored: [],
  missingSpecials: false,
  randomFolders: [],
  pickEdits: {},
  musicFolder: null,
  keepSubLangs: ["eng", "dut"],
  accent: "#6d66f0",
  picksFolders: [],
  folderTabs: {},
  tidy: "messy",
  sidebarSmall: false,
  uiScale: 1,
  libraryView: "list",
  tileSize: 150,
  detectIntro: true,
  detectCredits: true,
  pageState: {},
  folderOrder: [],
  checksOff: {},
  playerMenu: [],
  musicTabs: [],
};

/** Ready-made highlight colours for Settings → Look. */
export const ACCENTS: { name: string; hex: string }[] = [
  { name: "Indigo", hex: "#6d66f0" }, { name: "Blue", hex: "#3b82f6" }, { name: "Teal", hex: "#14b8a6" },
  { name: "Green", hex: "#22c55e" }, { name: "Amber", hex: "#f59e0b" }, { name: "Orange", hex: "#f97316" },
  { name: "Red", hex: "#e5484d" }, { name: "Pink", hex: "#ec4899" }, { name: "Slate", hex: "#94a3b8" },
];

function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Sets the highlight colour and the shades derived from it on the whole app. */
export function applyAccent(hex: string): void {
  const rgb = hexRgb(hex) ?? hexRgb(DEFAULT_PREFS.accent)!;
  const [r, g, b] = rgb;
  const mix = (t: number) => rgb.map((c) => Math.round(c + (255 - c) * t));
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const st = document.documentElement.style;
  st.setProperty("--accent", `rgb(${r},${g},${b})`);
  st.setProperty("--accent-rgb", `${r},${g},${b}`);
  st.setProperty("--accent-hover", `rgb(${mix(0.14).join(",")})`);
  st.setProperty("--accent-on", `rgb(${mix(0.45).join(",")})`);
  st.setProperty("--accent-soft", `rgba(${r},${g},${b},.16)`);
  st.setProperty("--nav-on", `rgba(${r},${g},${b},.18)`);
  st.setProperty("--accent-ink", lum > 0.6 ? "#111827" : "#ffffff");
}

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
      nextUpMarks: p.nextUpMarks ?? {},
      pickFavs: p.pickFavs ?? [],
      subRequired: p.subRequired ?? ["eng"],
      subSkipFolders: p.subSkipFolders ?? [],
      hiddenTabs: p.hiddenTabs ?? {},
      artSkipped: p.artSkipped ?? {},
      missingIgnored: p.missingIgnored ?? [],
      randomFolders: p.randomFolders ?? [],
      pickEdits: p.pickEdits ?? {},
      keepSubLangs: p.keepSubLangs ?? ["eng", "dut"],
      picksFolders: p.picksFolders ?? [],
      folderTabs: p.folderTabs ?? {},
      pageState: p.pageState ?? {},
      folderOrder: p.folderOrder ?? [],
      checksOff: p.checksOff ?? {},
      playerMenu: p.playerMenu ?? [],
      musicTabs: p.musicTabs ?? [],
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let current: Prefs = load();
const subs = new Set<() => void>();
if (typeof document !== "undefined") applyAccent(current.accent);

export function prefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs> | ((p: Prefs) => Partial<Prefs>)): void {
  const next = typeof patch === "function" ? patch(current) : patch;
  const accentBefore = current.accent;
  current = { ...current, ...next };
  if (current.accent !== accentBefore) applyAccent(current.accent);
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

/** A TV naming pattern with the year where the "show year" setting wants it. */
export function withShowYear(template: string, mode: Prefs["showYear"] = current.showYear): string {
  if (mode === "everywhere") return template;
  if (mode === "never") return template.split("< ({year})>").join("");
  const i = template.indexOf("/");
  if (i < 0) return template.split("< ({year})>").join("");
  return template.slice(0, i) + template.slice(i).split("< ({year})>").join("");
}

/** Shows: leave names that only differ by a year alone (all modes but "everywhere"). */
/** Only messy names get renamed by the library check (see `Prefs.tidy`). */
export function minimalNames(): boolean {
  return current.tidy !== "style";
}

export function yearOptional(): boolean {
  return current.showYear !== "everywhere";
}

/** Subtitle fonts: the app's own, plus fonts every Mac has. */
export const SUB_FONTS: { id: string; label: string; css: string }[] = [
  { id: "sans", label: "Clean (Inter)", css: '"Inter Variable", -apple-system, "Helvetica Neue", Arial, sans-serif' },
  { id: "helvetica", label: "Helvetica Neue", css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: "sf", label: "San Francisco (system)", css: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' },
  { id: "rounded", label: "Rounded", css: '"SF Pro Rounded", ui-rounded, "Arial Rounded MT Bold", "Manrope", sans-serif' },
  { id: "manrope", label: "Manrope", css: '"Manrope", sans-serif' },
  { id: "avenir", label: "Avenir Next", css: '"Avenir Next", Avenir, sans-serif' },
  { id: "futura", label: "Futura", css: 'Futura, "Century Gothic", sans-serif' },
  { id: "gill", label: "Gill Sans", css: '"Gill Sans", "Gill Sans MT", sans-serif' },
  { id: "optima", label: "Optima", css: 'Optima, Candara, sans-serif' },
  { id: "verdana", label: "Verdana (very readable)", css: 'Verdana, Geneva, sans-serif' },
  { id: "trebuchet", label: "Trebuchet", css: '"Trebuchet MS", sans-serif' },
  { id: "black", label: "Heavy (Arial Black)", css: '"Arial Black", "Helvetica Neue", sans-serif' },
  { id: "serif", label: "Classic (Georgia)", css: 'Georgia, "Times New Roman", serif' },
  { id: "palatino", label: "Palatino", css: 'Palatino, "Palatino Linotype", serif' },
  { id: "baskerville", label: "Baskerville", css: 'Baskerville, "Baskerville Old Face", serif' },
  { id: "mono", label: "Typewriter", css: '"JetBrains Mono", Menlo, monospace' },
  { id: "marker", label: "Marker Felt", css: '"Marker Felt", "Comic Sans MS", cursive' },
  { id: "chalk", label: "Chalkboard", css: '"Chalkboard SE", "Comic Sans MS", cursive' },
];
const FONTS: Record<string, string> = Object.fromEntries(SUB_FONTS.map((f) => [f.id, f.css]));

/** CSS for the subtitle text, used by the player and the preview in Settings. */
function hexToRgb(h: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return "0,0,0";
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

export function subCss(s: SubStyle): CSSProperties {
  const w = Math.max(0, Math.min(6, s.stroke ?? 2));
  // An outline made of shadows in eight directions (sharper than one blurred shadow).
  const ring = w > 0
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]].map(([x, y]) => `${(x * w).toFixed(1)}px ${(y * w).toFixed(1)}px 0 #000`).join(", ") + ", 0 0 3px #000"
    : "none";
  const shadow = s.shadow === "outline" ? ring : s.shadow === "soft" ? "0 2px 6px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.7)" : "none";
  return {
    fontFamily: FONTS[s.font] ?? FONTS.sans,
    fontSize: `calc(clamp(16px, 2.6vw, 44px) * ${s.size / 100})`,
    color: s.color,
    opacity: s.textOpacity ?? 1,
    background: s.background > 0 ? `rgba(${hexToRgb(s.boxColor ?? "#000000")},${s.background})` : "transparent",
    textShadow: shadow,
    fontWeight: s.bold ? 700 : 500,
    fontStyle: s.italic ? "italic" : "normal",
    letterSpacing: `${(s.letterSpacing ?? 0) / 100}em`,
    lineHeight: s.lineHeight ?? 1.3,
    maxWidth: `${s.maxWidth ?? 80}vw`,
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

/** Languages to fetch for, with the lowest score each may have: needed ones use your
 * minimum score, "if available" ones only a perfect match. */
export function subPlan(subLangs: string[]): { lang: string; minScore: number; needed: boolean }[] {
  const p = prefs();
  return subLangs.map((l) => {
    const needed = p.subRequired.includes(l);
    return { lang: l, minScore: needed ? p.minSubScore : 100, needed };
  });
}

/** Sorts folder names the way you ordered them (Settings or by dragging a tab); new ones go last, A to Z. */
export function orderFolders<T>(list: T[], name: (t: T) => string = (t) => String(t)): T[] {
  const order = current.folderOrder;
  const rank = (n: string) => {
    const i = order.findIndex((o) => o.toLowerCase() === n.toLowerCase());
    return i < 0 ? 10_000 : i;
  };
  return [...list].sort((a, b) => rank(name(a)) - rank(name(b)) || name(a).localeCompare(name(b)));
}

/** Moves `name` to just before `before` (or to the end) in your folder order. */
export function moveFolder(all: string[], name: string, before: string | null): void {
  const cur = orderFolders(all).filter((n) => n !== name);
  const i = before ? cur.indexOf(before) : -1;
  if (i < 0) cur.push(name);
  else cur.splice(i, 0, name);
  setPrefs({ folderOrder: cur });
}
