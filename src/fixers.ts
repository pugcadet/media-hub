// The safe, automatic fixes shared by Library health, the library wall and a title's page:
// fill in missing artwork, get missing subtitles, rename 100%-sure names. Everything they do
// is journaled by the backend, so it can be undone in History.
import { api, applyPlan, CheckRow, errorText, HealthRow, ImageKind, PlanOp, scanAround } from "./api";
import type { JobHandle } from "./activity";
import { namingLeftAlone, prefs, subPlan, subSkipped, withShowYear, yearOptional, minimalNames } from "./prefs";

export type FixKind = "identify" | "art" | "subs" | "rename";

export interface FixTarget {
  id: string;
  name: string;
  year?: number | null;
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
  return { id: r.id, name: r.name, year: r.year, kind: r.kind, identified: r.identified, missingArt, noSubs: noSubsOf(r), check };
}

/** In words, what the safe fixes will do for one title ("poster, logo · subtitles · 52 files renamed"). */
export function describeFixes(t: FixTarget, what: FixKind[]): string[] {
  const out: string[] = [];
  const names: Record<string, string> = { Primary: "poster", Backdrop: "background", Logo: "logo", Thumb: "thumbnail", Banner: "banner" };
  if (what.includes("identify") && !t.identified) out.push("identify it when there's one exact match (same name and year)");
  if (what.includes("art") && t.identified && t.missingArt.length) out.push(`look for ${t.missingArt.map((k) => names[k] ?? k).join(", ")}`);
  if (what.includes("art") && !t.identified && t.missingArt.length) out.push("artwork skipped: identify it first");
  if (what.includes("subs") && t.noSubs > 0) out.push(t.kind === "series" ? `subtitles for ${t.noSubs} episode${t.noSubs === 1 ? "" : "s"}` : "subtitles");
  if (what.includes("rename") && t.check?.sure) out.push(`rename ${t.check.toRename + t.check.folders} file${t.check.toRename + t.check.folders === 1 ? "" : "s"} and folders`);
  return out;
}

/** True when the names need changing (and the check knows it). */
export function namesToFix(c: CheckRow | null): boolean {
  return !!c && !c.error && !c.stale && !namingLeftAlone(c) && c.toRename + c.folders + c.problems > 0;
}

/** What `fixTitles` would do for this title, in words ("2 pictures", "subtitles", "names"). */
export function safeFixes(t: FixTarget): FixKind[] {
  const out: FixKind[] = [];
  if (!t.identified) out.push("identify");
  if (t.identified && t.missingArt.length) out.push("art");
  if (t.noSubs > 0) out.push("subs");
  if (t.check?.sure) out.push("rename");
  return out;
}

/** "The Little Mermaid (1989) Remastered 1080p" → words to compare ("little mermaid"). */
export function titleKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/\(?(19|20)\d{2}\)?.*$/, " ")
    .replace(/\b(the|a|an|and|directors?'?s?|extended|special|theatrical|final|ultimate|edition|cut|version|remaster(ed)?|restored|remake|unrated|uncut)\b/g, " ")
    .replace(/&/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The one search result with exactly this name and year, if there is exactly one. */
export function exactMatch<T extends { Name?: string; ProductionYear?: number }>(results: T[], name: string, year: number | null | undefined): T | null {
  const key = titleKey(name);
  const found = name.match(/\b(?:19|20)\d{2}\b/);
  const y = year ?? (found ? Number(found[0]) : null);
  if (!key || !y) return null;
  const hits = results.filter((r) => r.Name && titleKey(r.Name) === key && r.ProductionYear === y);
  const ids = new Set(hits.map((h) => JSON.stringify((h as unknown as { ProviderIds?: unknown }).ProviderIds ?? h.Name)));
  return hits.length > 0 && ids.size === 1 ? hits[0] : null;
}

/** Identifies a title when the search finds exactly one result with the same name and year. */
export async function identifyExact(t: { id: string; kind: "series" | "movie"; name: string; year?: number | null }): Promise<boolean> {
  const plain = t.name.replace(/\[[^\]]*\]/g, "").replace(/\(?(19|20)\d{2}\)?.*$/, "").replace(/[._]/g, " ").trim();
  const results = await api.identifySearch(t.kind, plain || t.name, t.year ?? null, {});
  const hit = exactMatch(results, t.name, t.year);
  if (!hit) return false;
  await api.identifyApply(t.id, hit, false);
  return true;
}

/** One video's subtitle failing is skipped; a limit or login problem stops the whole run. */
function stopOnLimit(e: unknown): null {
  if (/limit|stopped|login|plugin|refused/i.test(errorText(e))) throw e;
  return null;
}

/** Subtitles for one movie or every episode of a show that has none (your Subtitles settings). */
export async function getSubtitles(t: { id: string; kind: "series" | "movie" }, subLangs: string[], job?: JobHandle): Promise<number> {
  let n = 0;
  const plan = subPlan(subLangs);
  if (t.kind === "movie") {
    for (const x of plan) {
      const res = await api.subtitleAuto(t.id, x.lang, [x.lang], x.minScore).catch(stopOnLimit);
      if (res?.outcome === "downloaded" || res?.outcome === "found") n++;
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
        const res = await api.subtitleAuto(e.Id, x.lang, [x.lang], x.minScore).catch(stopOnLimit);
        if (res?.outcome === "downloaded" || res?.outcome === "found") n++;
      }
    }
  }
  return n;
}

/** The rename plan for a 100%-sure title (the same one `renameSure` applies). */
function surePlan(r: CheckRow) {
  const series = r.kind === "series";
  return api.plan({
    mode: series ? "tv" : "movie", folder: r.folder,
    template: series ? withShowYear("{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}") : "{title}< ({year})>/{title}< ({year})>.{ext}",
    show: null, year: null, yearOptional: yearOptional(), minimal: minimalNames(), findReplace: [], recursive: series, source: series ? "jellyfin" : "none",
    matchId: series ? `jellyfin:${r.id}` : null, renameFolder: series ? true : null, seasonFolders: false,
    onlyFile: series ? null : r.file, itemId: series ? null : r.id,
  });
}

/** What renaming a 100%-sure title would change, without changing anything (for the Fix dialog). */
export async function previewRename(r: CheckRow): Promise<PlanOp[]> {
  return (await surePlan(r)).ops.filter((o) => o.status === "ok");
}

/** Renames a 100%-sure title like the renamer's library check does. Returns files renamed. */
export async function renameSure(r: CheckRow): Promise<number> {
  const series = r.kind === "series";
  const plan = await surePlan(r);
  const ok = plan.ops.filter((o) => o.status === "ok").map((o) => o.from);
  if (!ok.length) return 0;
  return (await applyPlan(plan, true, ok, series ? r.id : null, r.folder)).done;
}

export interface FixResult {
  identified?: number;
  art: number;
  subs: number;
  renamed: number;
  /** What went wrong (first few), shown instead of a silent "nothing fixed". */
  errors: string[];
}

export function fixSummary(r: FixResult): string {
  const parts = [r.identified ? `${r.identified} identified` : "", r.art ? `${r.art} picture${r.art === 1 ? "" : "s"}` : "", r.subs ? `${r.subs} subtitle${r.subs === 1 ? "" : "s"}` : "", r.renamed ? `${r.renamed} file${r.renamed === 1 ? "" : "s"} renamed` : ""].filter(Boolean);
  const err = r.errors[0] ? ` · Problem: ${r.errors[0]}` : "";
  return (parts.length ? parts.join(", ") : "Nothing could be fixed automatically") + err;
}

/** Runs the chosen safe fixes over a list of titles, with progress on `job`. */
export async function fixTitles(list: FixTarget[], what: FixKind[], subLangs: string[], job: JobHandle): Promise<FixResult> {
  const r: FixResult = { art: 0, subs: 0, renamed: 0, errors: [] };
  const fail = (e: unknown) => { const t = errorText(e); if (!r.errors.includes(t)) r.errors.push(t); };
  const renamedFolders: string[] = [];
  for (let [i, t] of list.entries()) {
    if (job.cancelled) break;
    job.update(t.name, i / list.length);
    if (what.includes("identify") && !t.identified) {
      if (await identifyExact(t).catch((e) => { fail(e); return false; })) {
        r.identified = (r.identified ?? 0) + 1;
        t = { ...t, identified: true };
      }
    }
    if (what.includes("art") && t.identified && t.missingArt.length) {
      r.art += (await api.fillMissingArt(t.id, t.missingArt).catch((e) => { fail(e); return [] as string[]; })).length;
      await api.fillMissingArt(t.id, ["Banner", "Art", "Disc"]).catch(() => undefined); // optional ones: just add them when found
      // The same save problem on three titles in a row won't fix itself: stop and say so.
      if (r.art === 0 && r.errors.length && i >= 2 && /couldn't save the picture/.test(r.errors[0])) break;
    }
    if (what.includes("subs") && t.noSubs > 0) {
      r.subs += await getSubtitles(t, subLangs, job);
    }
    if (what.includes("rename") && t.check?.sure) {
      const n = await renameSure(t.check).catch((e) => { fail(e); return 0; });
      if (n) renamedFolders.push(t.check.folder);
      r.renamed += n;
    }
  }
  if (renamedFolders.length) await scanAround(renamedFolders);
  job.update(fixSummary(r), 1);
  return r;
}
