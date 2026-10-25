// The safe, automatic fixes shared by Library health, the library wall and a title's page:
// fill in missing artwork, get missing subtitles, rename 100%-sure names. Everything they do
// is journaled by the backend, so it can be undone in History.
import { api, CheckRow, HealthRow, ImageKind, scanAround } from "./api";
import type { JobHandle } from "./activity";
import { prefs, subPlan, subSkipped, withShowYear, yearOptional } from "./prefs";

export type FixKind = "art" | "subs" | "rename";

export interface FixTarget {
  id: string;
  name: string;
  kind: "series" | "movie";
  identified: boolean;
  /** Pictures to look for online. */
  missingArt: ImageKind[];
  /** Videos without subtitles (episodes for a show). */
  noSubs: number;
  /** The renamer's verdict, when the library check has run. */
  check: CheckRow | null;
}

/** Pictures every title should have (thumb and banner are nice to have, not "missing"). */
export const CORE_ART: { key: "poster" | "backdrop" | "logo"; kind: ImageKind; label: string }[] = [
  { key: "poster", kind: "Primary", label: "poster" },
  { key: "backdrop", kind: "Backdrop", label: "background" },
  { key: "logo", kind: "Logo", label: "logo" },
];

/** Pictures you said can't be found for this title (they don't count as missing). */
export function artSkipped(id: string): string[] {
  return prefs().artSkipped[id] ?? [];
}

/** Videos without subtitles, unless the title sits in a folder you don't want subtitles for. */
export function noSubsOf(r: HealthRow): number {
  return r.path && subSkipped(r.path) ? 0 : r.noSubs;
}

export function targetOf(r: HealthRow, check: CheckRow | null, extraArt = false): FixTarget {
  const skip = artSkipped(r.id);
  const missingArt = CORE_ART.filter((a) => !r[a.key] && !skip.includes(a.kind)).map((a) => a.kind);
  if (extraArt && !r.thumb && !skip.includes("Thumb")) missingArt.push("Thumb");
  return { id: r.id, name: r.name, kind: r.kind, identified: r.identified, missingArt, noSubs: noSubsOf(r), check };
}

/** In words, what the safe fixes will do for one title ("poster, logo · subtitles · 52 files renamed"). */
export function describeFixes(t: FixTarget, what: FixKind[]): string[] {
  const out: string[] = [];
  const names: Record<string, string> = { Primary: "poster", Backdrop: "background", Logo: "logo", Thumb: "thumbnail", Banner: "banner" };
  if (what.includes("art") && t.identified && t.missingArt.length) out.push(`look for ${t.missingArt.map((k) => names[k] ?? k).join(", ")}`);
  if (what.includes("art") && !t.identified && t.missingArt.length) out.push("artwork skipped: identify it first");
  if (what.includes("subs") && t.noSubs > 0) out.push(t.kind === "series" ? `subtitles for ${t.noSubs} episode${t.noSubs === 1 ? "" : "s"}` : "subtitles");
  if (what.includes("rename") && t.check?.sure) out.push(`rename ${t.check.toRename + t.check.folders} file${t.check.toRename + t.check.folders === 1 ? "" : "s"} and folders`);
  return out;
}

/** True when the names need changing (and the check knows it). */
export function namesToFix(c: CheckRow | null): boolean {
  return !!c && !c.error && c.toRename + c.folders + c.problems > 0;
}

/** What `fixTitles` would do for this title, in words ("2 pictures", "subtitles", "names"). */
export function safeFixes(t: FixTarget): FixKind[] {
  const out: FixKind[] = [];
  if (t.identified && t.missingArt.length) out.push("art");
  if (t.noSubs > 0) out.push("subs");
  if (t.check?.sure) out.push("rename");
  return out;
}

/** Subtitles for one movie or every episode of a show that has none (your Subtitles settings). */
export async function getSubtitles(t: { id: string; kind: "series" | "movie" }, subLangs: string[], job?: JobHandle): Promise<number> {
  let n = 0;
  const plan = subPlan(subLangs);
  if (t.kind === "movie") {
    for (const x of plan) {
      const res = await api.subtitleAuto(t.id, x.lang, [x.lang], x.minScore).catch(() => null);
      if (res?.outcome === "downloaded") n++;
    }
    return n;
  }
  const seasons = (await api.details(t.id).catch(() => null))?.seasons ?? [];
  for (const s of seasons) {
    if (job?.cancelled) break;
    const eps = (await api.children(s.Id).catch(() => [])).filter((e) => e.Type === "Episode" && !subSkipped(e.Path) && !(e.MediaStreams ?? []).some((m) => m.Type === "Subtitle"));
    for (const e of eps) {
      if (job?.cancelled) break;
      for (const x of plan) {
        const res = await api.subtitleAuto(e.Id, x.lang, [x.lang], x.minScore).catch(() => null);
        if (res?.outcome === "downloaded") n++;
      }
    }
  }
  return n;
}

/** Renames a 100%-sure title like the renamer's library check does. Returns files renamed. */
export async function renameSure(r: CheckRow): Promise<number> {
  const series = r.kind === "series";
  const plan = await api.plan({
    mode: series ? "tv" : "movie", folder: r.folder,
    template: series ? withShowYear("{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}") : "{title}< ({year})>/{title}< ({year})>.{ext}",
    show: null, year: null, yearOptional: yearOptional(), findReplace: [], recursive: series, source: series ? "jellyfin" : "none",
    matchId: series ? `jellyfin:${r.id}` : null, renameFolder: null, seasonFolders: false,
    onlyFile: series ? null : r.file, itemId: series ? null : r.id,
  });
  const ok = plan.ops.filter((o) => o.status === "ok").map((o) => o.from);
  if (!ok.length) return 0;
  return (await api.apply(plan.planId, true, ok)).done;
}

export interface FixResult {
  art: number;
  subs: number;
  renamed: number;
}

export function fixSummary(r: FixResult): string {
  const parts = [r.art ? `${r.art} picture${r.art === 1 ? "" : "s"}` : "", r.subs ? `${r.subs} subtitle${r.subs === 1 ? "" : "s"}` : "", r.renamed ? `${r.renamed} file${r.renamed === 1 ? "" : "s"} renamed` : ""].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing could be fixed automatically";
}

/** Runs the chosen safe fixes over a list of titles, with progress on `job`. */
export async function fixTitles(list: FixTarget[], what: FixKind[], subLangs: string[], job: JobHandle): Promise<FixResult> {
  const r: FixResult = { art: 0, subs: 0, renamed: 0 };
  const renamedFolders: string[] = [];
  for (const [i, t] of list.entries()) {
    if (job.cancelled) break;
    job.update(t.name, i / list.length);
    if (what.includes("art") && t.identified && t.missingArt.length) {
      r.art += (await api.fillMissingArt(t.id, t.missingArt).catch(() => [])).length;
    }
    if (what.includes("subs") && t.noSubs > 0) {
      r.subs += await getSubtitles(t, subLangs, job);
    }
    if (what.includes("rename") && t.check?.sure) {
      const n = await renameSure(t.check).catch(() => 0);
      if (n) renamedFolders.push(t.check.folder);
      r.renamed += n;
    }
  }
  if (renamedFolders.length) await scanAround(renamedFolders);
  job.update(fixSummary(r), 1);
  return r;
}
