// "Scan everything": one job that checks the whole library (health, names, missing episodes,
// duplicates, folders, storage, intro markers, episode pictures) and only redoes the parts
// whose titles changed since the last run. Each part's result is kept on this computer, so
// Home and Clean-up show the numbers at once.
import { useEffect, useState, useSyncExternalStore } from "react";
import { api, DupGroup, HealthRow, MissingReport, OverviewRow, Status, errorText } from "./api";
import { track, useEpoch, type JobHandle } from "./activity";
import { prefs } from "./prefs";
import { readSaved, writeSaved } from "./saved";
import type { TopFolder } from "./Structure";
import { artSkipped, CORE_ART, namesToFix, noSubsOf } from "./fixers";

/** Counts per part, with when each part last ran (ms). */
export interface ScanSummary {
  health: { at: number; titles: number; unidentified: number; noArt: number; subsVideos: number; subsTitles: number; complete: number } | null;
  names: { at: number; toFix: number; sure: number } | null;
  missing: { at: number; shows: number; episodes: number } | null;
  duplicates: { at: number; groups: number; files: number } | null;
  folders: { at: number; fixes: number; shows: number; movies: number } | null;
  storage: StorageSummary | null;
  intros: { at: number; shows: number; withoutIntro: number; known: number } | null;
  pictures: { at: number; episodes: number } | null;
}

export interface StorageSummary {
  at: number;
  videos: number;
  bytes: number;
  big: number;
  bigBytes: number;
  shrink: number;
  /** Rough saving if every H.264 file became H.265. */
  shrinkSave: number;
  extraAudio: number;
  extraSubs: number;
}

const KEY = "summary";
let version = 0;
const subs = new Set<() => void>();
const bump = () => {
  version++;
  subs.forEach((f) => f());
};

/** Saved part results (each part is updated by its own page too). */
export function savePart<K extends keyof ScanSummary>(part: K, value: NonNullable<ScanSummary[K]>): void {
  const cur = readSaved<Partial<ScanSummary>>(KEY)?.data ?? {};
  writeSaved(KEY, { ...cur, [part]: value });
  bump();
}

function readParts(): Partial<ScanSummary> {
  return readSaved<Partial<ScanSummary>>(KEY)?.data ?? {};
}

/** Rough guess: H.265 needs about 55% of H.264's size at similar quality. */
export function shrinkEstimate(r: { codec: string; hdr: boolean; size: number; canShrink: boolean }): number {
  if (!r.canShrink) return 0;
  return r.size * (r.codec === "h264" ? 0.45 : 0.3);
}

export function storageSummary(rows: OverviewRow[]): StorageSummary {
  const big = rows.filter((r) => r.big);
  const shrink = rows.filter((r) => r.canShrink && r.size > 1e9);
  return {
    at: Date.now(),
    videos: rows.length,
    bytes: rows.reduce((n, r) => n + r.size, 0),
    big: big.length,
    bigBytes: big.reduce((n, r) => n + r.size, 0),
    shrink: shrink.length,
    shrinkSave: shrink.reduce((n, r) => n + shrinkEstimate(r), 0),
    extraAudio: rows.filter((r) => r.tracks.some((t) => t.kind === "audio" && t.extra)).length,
    extraSubs: rows.filter((r) => r.tracks.some((t) => t.kind === "subtitle" && t.extra)).length,
  };
}

export function healthSummary(at: number, rows: HealthRow[]): NonNullable<ScanSummary["health"]> {
  const subsTitles = rows.filter((r) => noSubsOf(r) > 0);
  return {
    at: at * 1000,
    titles: rows.length,
    unidentified: rows.filter((r) => !r.identified).length,
    noArt: rows.filter((r) => r.identified && CORE_ART.some((a) => !r[a.key] && !artSkipped(r.id).includes(a.kind))).length,
    subsVideos: subsTitles.reduce((n, r) => n + noSubsOf(r), 0),
    subsTitles: subsTitles.length,
    complete: rows.filter((r) => r.identified && CORE_ART.every((a) => r[a.key] || artSkipped(r.id).includes(a.kind)) && noSubsOf(r) === 0).length,
  };
}

export function missingSummary(cache: Record<string, MissingReport | string>, at: number): NonNullable<ScanSummary["missing"]> {
  const ignored = new Set(prefs().missingIgnored);
  const reps = Object.entries(cache).filter(([id, r]) => typeof r === "object" && !ignored.has(id)).map(([, r]) => r as MissingReport);
  return { at, shows: reps.filter((r) => r.missing.length > 0).length, episodes: reps.reduce((n, r) => n + r.missing.length, 0) };
}

export function duplicatesSummary(groups: DupGroup[], at: number): NonNullable<ScanSummary["duplicates"]> {
  return { at, groups: groups.length, files: groups.reduce((n, g) => n + g.items.length - 1, 0) };
}

export function foldersSummary(top: TopFolder[], at: number): NonNullable<ScanSummary["folders"]> {
  const shows = top.reduce((n, t) => n + t.shows.length, 0);
  const movies = top.reduce((n, t) => n + t.looseMovies.length, 0);
  return { at, fixes: shows + movies, shows, movies };
}

/**
 * Every part's numbers. The health and names parts come from what the backend saved last;
 * the others from this computer. Updates when a scan or a page saves a part.
 */
export function useScanSummary(): ScanSummary {
  const epoch = useEpoch();
  const v = useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
  const [live, setLive] = useState<Pick<ScanSummary, "health" | "names">>({ health: null, names: null });
  useEffect(() => {
    let alive = true;
    void Promise.all([api.libraryHealth(false).catch(() => null), api.namingCheckLast().catch(() => null)]).then(([h, n]) => {
      if (!alive) return;
      const rows = (n?.rows ?? []).filter((r) => namesToFix(r));
      setLive({
        health: h ? healthSummary(h.at, h.rows) : null,
        names: n ? { at: n.at * 1000, toFix: rows.length, sure: rows.filter((r) => r.sure).length } : null,
      });
    });
    return () => {
      alive = false;
    };
  }, [epoch, v]);
  const p = readParts();
  return {
    health: live.health,
    names: live.names,
    missing: p.missing ?? null,
    duplicates: p.duplicates ?? null,
    folders: p.folders ?? null,
    storage: p.storage ?? null,
    intros: p.intros ?? null,
    pictures: p.pictures ?? null,
  };
}

/* ------------------------------------------------------------------ the scan */

const WEEK = 7 * 86_400_000;
const sigOf = (r: HealthRow) => `${r.videos}|${r.name}|${r.path ?? ""}|${r.year ?? ""}`;

/** The Renamer's naming settings, when it offers them (otherwise names are left out). */
async function namingArgs(): Promise<[string, string, boolean, boolean] | null> {
  try {
    const m = (await import("./Renamer")) as unknown as Record<string, unknown>;
    const f = m.namingArgs as (() => [string, string, boolean, boolean]) | undefined;
    return f ? f() : null;
  } catch {
    return null;
  }
}

export interface ScanResult {
  changed: number;
  ran: string[];
  skipped: string[];
  problems: string[];
}

/** Runs every check; parts whose titles didn't change are skipped unless `force`. */
export async function scanEverything(status: Status, opts: { force?: boolean } = {}): Promise<ScanResult> {
  return track("Scanning everything", async (job: JobHandle) => {
    const out: ScanResult = { changed: 0, ran: [], skipped: [], problems: [] };
    const steps = 8;
    let step = 0;
    const next = (label: string) => job.update(label, step++ / steps);
    const attempt = async (name: string, f: () => Promise<void>) => {
      if (job.cancelled) return;
      try {
        await f();
        out.ran.push(name);
      } catch (e) {
        out.problems.push(`${name}: ${errorText(e)}`);
      }
    };

    // 1. Health is the base: which titles exist and which changed since the last scan.
    next("Library health");
    const h = await api.libraryHealth(true);
    savePart("health", healthSummary(h.at, h.rows));
    const oldSigs = readSaved<Record<string, string>>("scan.sigs")?.data ?? null;
    const sigs = Object.fromEntries(h.rows.map((r) => [r.id, sigOf(r)]));
    const changed = opts.force || !oldSigs ? h.rows.map((r) => r.id) : h.rows.filter((r) => oldSigs[r.id] !== sigs[r.id]).map((r) => r.id);
    const removed = oldSigs ? Object.keys(oldSigs).filter((id) => !(id in sigs)).length : 0;
    const anyChange = changed.length > 0 || removed > 0;
    out.changed = changed.length + removed;
    const stale = (at: number | undefined) => !at || Date.now() - at > WEEK;
    const parts = readParts();

    // 2. Names: only the changed titles (a partial check updates the saved full list).
    next("Names");
    await attempt("names", async () => {
      const args = await namingArgs();
      if (!args) throw new Error("open the Renamer once to check names");
      const last = await api.namingCheckLast().catch(() => null);
      if (last && !changed.length && !opts.force) {
        out.skipped.push("names");
        return;
      }
      const ids = !last || opts.force ? null : changed;
      await api.namingCheck(args[0], args[1], ids, args[2], args[3]);
    });

    // 3. Missing episodes: changed shows, shows never checked, everything once a week.
    next("Missing episodes");
    await attempt("missing", async () => {
      const saved = readSaved<Record<string, MissingReport | string>>("missing");
      const cache = { ...(saved?.data ?? {}) };
      const ignored = new Set(prefs().missingIgnored);
      const shows = h.rows.filter((r) => r.kind === "series" && !ignored.has(r.id));
      const weekly = stale(saved?.at);
      const todo = shows.filter((r) => weekly || opts.force || changed.includes(r.id) || !(r.id in cache));
      for (const [i, s] of todo.entries()) {
        if (job.cancelled) break;
        job.update(`Missing episodes · ${s.name}`, (step - 1 + i / Math.max(1, todo.length)) / steps);
        try {
          cache[s.id] = await api.missingEpisodes(s.id);
        } catch (e) {
          cache[s.id] = errorText(e);
        }
      }
      const at = writeSaved("missing", cache).at;
      savePart("missing", missingSummary(cache, at));
    });

    // 4–6. Whole-library checks: again only when something changed (or once a week).
    const whole = async (name: "duplicates" | "folders" | "storage", f: () => Promise<void>) => {
      if (!anyChange && !opts.force && !stale(parts[name]?.at)) {
        out.skipped.push(name);
        return;
      }
      await attempt(name, f);
    };
    next("Duplicates");
    await whole("duplicates", async () => {
      const g = await api.findDuplicates();
      const s = writeSaved("duplicates", g);
      savePart("duplicates", duplicatesSummary(g, s.at));
    });
    next("Folders");
    await whole("folders", async () => {
      if (!status.libraryRoot) throw new Error("no library folder chosen");
      const t = await api.structureScan();
      const s = writeSaved("structure", t);
      savePart("folders", foldersSummary(t, s.at));
    });
    next("Storage");
    await whole("storage", async () => {
      savePart("storage", storageSummary(await api.storageOverview(status.subLangs)));
    });

    // 7. Intro markers: shows not known yet, plus changed shows read again.
    next("Intros and credits");
    await attempt("intros", async () => {
      const series = h.rows.filter((r) => r.kind === "series");
      for (const id of changed.filter((id) => series.some((r) => r.id === id))) {
        if (job.cancelled) break;
        await api.segmentSummary(id, true).catch(() => undefined);
      }
      const cov = await api.segmentCoverage(series.map((r) => r.id), true);
      const known = Object.values(cov);
      savePart("intros", { at: Date.now(), shows: series.length, known: known.length, withoutIntro: known.filter((c) => c.episodes > 0 && c.intro < c.episodes * 0.8).length });
    });

    // 8. Episodes without a picture.
    next("Episode pictures");
    await attempt("pictures", async () => {
      const eps = await api.episodesWithoutPicture();
      savePart("pictures", { at: Date.now(), episodes: eps.length });
    });

    if (!job.cancelled) writeSaved("scan.sigs", sigs);
    job.update(out.problems.length ? `Done, ${out.problems.length} part${out.problems.length === 1 ? "" : "s"} failed` : "Done", 1);
    return out;
  }, { cancellable: true, stop: "health", reload: false }).finally(bump);
}
