// One set of rules for "does this title need work", used by every count in the app: the
// Library's chips and rows, the menu badges and Home's blocks. Change a rule here and every
// place follows.
import type { CheckRow, HealthRow, SegSummary } from "./api";
import { artSkipped, namingStatus, noSubsOf } from "./fixers";
import { prefs } from "./prefs";

export type Check = "naming" | "identified" | "artwork" | "subtitles" | "intros";

/** The pictures every title should have. */
export const TITLE_ART: { key: "poster" | "backdrop" | "logo" | "thumb"; kind: string }[] = [
  { key: "poster", kind: "Primary" }, { key: "backdrop", kind: "Backdrop" }, { key: "logo", kind: "Logo" }, { key: "thumb", kind: "Thumb" },
];

const clean = (id: string) => id.replace(/-/g, "").toLowerCase();

/** true = fine, false = needs work, null = doesn't apply (switched off, or not checked yet). */
export function titleState(r: HealthRow & { check?: CheckRow | null; seg?: SegSummary | null }, c: Check): boolean | null {
  if ((prefs().checksOff[clean(r.id)] ?? []).includes(c)) return null;
  switch (c) {
    case "naming": return namingStatus(r.check).ok;
    case "identified": return r.identified;
    case "artwork": return TITLE_ART.every((a) => r[a.key] || artSkipped(r.id).includes(a.kind));
    case "subtitles": return noSubsOf(r) === 0;
    case "intros": return r.kind !== "series" ? null : r.seg ? r.seg.episodes === 0 || Math.max(r.seg.intro, r.seg.credits) >= r.seg.episodes * 0.8 : null;
  }
}

/** Videos without subtitles in a title, unless subtitles are switched off for it. */
export function subsMissing(r: HealthRow): number {
  return titleState(r, "subtitles") === false ? noSubsOf(r) : 0;
}
