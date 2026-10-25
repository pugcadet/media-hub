// Daily jobs that run by themselves while Media Hub is open: scan the library, update the
// "Picks of the day" collection, fill in missing artwork and fetch missing subtitles.
import { api, localDate, Status } from "./api";
import { track } from "./activity";
import { getPicks } from "./Picks";
import { scanLibrary } from "./ui";
import { prefs, setPrefs, subPlan, subSkipped } from "./prefs";

let running = false;

export async function runDaily(status: Status, force = false): Promise<void> {
  if (running) return;
  const p = prefs();
  const today = localDate();
  if (!force && p.lastRun.daily === today) return;
  running = true;
  setPrefs((cur) => ({ lastRun: { ...cur.lastRun, daily: today } }));
  const s = p.schedule;
  const canEdit = !status.readOnly;
  try {
    if (s.scan) {
      await scanLibrary().catch(() => undefined);
    }
    if (s.picks && canEdit) {
      await syncPicks(today);
    }
    if (s.art && canEdit) {
      await track("Daily: missing artwork", async (job) => {
        const list = [
          ...(await api.list(null, "", "added", 0, 60, null, "noposter")),
          ...(await api.list(null, "", "added", 0, 40)),
        ];
        const seen = new Set<string>();
        let added = 0;
        for (const [i, it] of list.entries()) {
          if (job.cancelled) break;
          if (seen.has(it.id)) continue;
          seen.add(it.id);
          job.update(it.name, i / list.length);
          const got = await api.fillMissingArt(it.id, ["Primary", "Backdrop", "Logo", "Thumb", "Banner"]).catch(() => []);
          added += got.length;
        }
        job.update(`${added} picture${added === 1 ? "" : "s"} added`, 1);
      }, { cancellable: true }).catch(() => undefined);
    }
    if (s.subtitles && canEdit) {
      await track("Daily: missing subtitles", async (job) => {
        const r = await api.missingSubtitles(0, 80);
        const plan = subPlan(status.subLangs);
        let got = 0;
        let stop = false;
        for (const [i, e] of (r.Items ?? []).entries()) {
          if (job.cancelled || stop) break;
          if (subSkipped(e.Path)) continue;
          job.update(e.SeriesName ? `${e.SeriesName} · ${e.Name}` : e.Name, i / (r.Items?.length || 1));
          for (const x of plan) {
            try {
              const res = await api.subtitleAuto(e.Id, x.lang, [x.lang], x.minScore);
              if (res.outcome === "downloaded") got++;
            } catch (err) {
              if (/rate|limit|quota|plugin/i.test(String(err))) { stop = true; break; } // the site says stop for today
            }
          }
        }
        job.update(`${got} subtitle${got === 1 ? "" : "s"} downloaded`, 1);
      }, { cancellable: true }).catch(() => undefined);
    }
  } finally {
    running = false;
  }
}

/**
 * Today's picks as a Jellyfin collection and playlist (and, if you like, as favourites, which
 * Infuse shows on its home screen), so Infuse and other apps see them.
 */
export async function syncPicks(today: string = localDate()): Promise<void> {
  await track("“Picks of the day” in Jellyfin", async (job) => {
    const picks = await getPicks(today);
    if (!picks.length) return;
    const ids = picks.map((x) => x.id);
    await api.syncPicksCollection(ids).catch(() => undefined);
    const n = await api.syncPicksPlaylist(ids);
    let favs = 0;
    if (prefs().picksAsFavorites) {
      // Unmark yesterday's picks that Media Hub marked, then mark today's (not ones you had already).
      for (const id of prefs().pickFavs.filter((x) => !ids.includes(x))) await api.setFavorite(id, false).catch(() => undefined);
      const mine = prefs().pickFavs.filter((x) => ids.includes(x));
      for (const id of ids) {
        if (mine.includes(id)) continue;
        const d = await api.details(id).catch(() => null);
        if (!d || d.item.UserData?.IsFavorite) continue;
        await api.setFavorite(id, true).then(() => { mine.push(id); favs++; }).catch(() => undefined);
      }
      setPrefs({ pickFavs: mine });
    } else if (prefs().pickFavs.length) {
      for (const id of prefs().pickFavs) await api.setFavorite(id, false).catch(() => undefined);
      setPrefs({ pickFavs: [] });
    }
    job.update(`${n} videos in the playlist${favs ? ` · ${favs} favourites` : ""}`, 1);
  }, { reload: false }).catch(() => undefined);
  setPrefs((cur) => ({ lastRun: { ...cur.lastRun, picks: today } }));
}

/** Checks every few minutes whether today's run is due. Returns a stop function. */
export function startScheduler(status: Status): () => void {
  // Picks change every day: keep them in Jellyfin even without the daily schedule.
  const picksTimer = window.setTimeout(() => {
    const today = localDate();
    if (!status.readOnly && prefs().lastRun.picks !== today) void syncPicks(today);
  }, 20_000);
  const tick = () => {
    const p = prefs();
    if (!p.schedule.enabled) return;
    if (new Date().getHours() < p.schedule.hour) return;
    void runDaily(status);
  };
  const first = window.setTimeout(tick, 60_000); // give the app a minute to settle
  const t = window.setInterval(tick, 10 * 60_000);
  return () => {
    window.clearTimeout(picksTimer);
    window.clearTimeout(first);
    window.clearInterval(t);
  };
}
