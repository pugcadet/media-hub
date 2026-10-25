// Daily jobs that run by themselves while Media Hub is open: scan the library, update the
// "Picks of the day" collection, fill in missing artwork and fetch missing subtitles.
import { api, localDate, Status } from "./api";
import { track } from "./activity";
import { prefs, setPrefs, subSkipped } from "./prefs";

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
      await track("Daily: scanning the library", () => api.sync().then(() => undefined)).catch(() => undefined);
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
        const lang = p.subLang || status.subLangs[0] || "eng";
        let got = 0;
        for (const [i, e] of (r.Items ?? []).entries()) {
          if (job.cancelled) break;
          if (subSkipped(e.Path)) continue;
          job.update(e.SeriesName ? `${e.SeriesName} · ${e.Name}` : e.Name, i / (r.Items?.length || 1));
          try {
            const res = await api.subtitleAuto(e.Id, lang, [lang], p.minSubScore);
            if (res.outcome === "downloaded") got++;
          } catch (err) {
            if (/rate|limit|quota|plugin/i.test(String(err))) break; // the site says stop for today
          }
        }
        job.update(`${got} subtitle${got === 1 ? "" : "s"} downloaded`, 1);
      }, { cancellable: true }).catch(() => undefined);
    }
  } finally {
    running = false;
  }
}

/** Today's picks as a Jellyfin collection and playlist, so Infuse and other apps see them. */
async function syncPicks(today: string): Promise<void> {
  await track("“Picks of the day” in Jellyfin", async (job) => {
    const picks = await api.picks(today);
    if (!picks.length) return;
    const ids = picks.map((x) => x.id);
    await api.syncPicksCollection(ids).catch(() => undefined);
    const n = await api.syncPicksPlaylist(ids);
    job.update(`${n} videos in the playlist`);
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
