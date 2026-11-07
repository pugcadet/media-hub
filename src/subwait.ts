// English subtitles for things just placed from the Inbox. Jellyfin has to add a new title
// before its subtitle search works, and that can take minutes. So the Inbox doesn't wait: the
// request is kept here (it survives a restart) and checked every minute for up to 6 hours.
// As soon as Jellyfin shows the title, the subtitles are looked up and saved next to the video.
import { api } from "./api";
import { logProblem, track } from "./activity";
import { getSubtitles } from "./fixers";
import { prefs, setPrefs, type SubWait } from "./prefs";

const GIVE_UP = 6 * 3600_000;
/** A title Jellyfin already had: give it a minute to read the new episodes first. */
const SETTLE = 60_000;

const same = (a: SubWait, b: SubWait) => a.folder.toLowerCase() === b.folder.toLowerCase();

function drop(w: SubWait) {
  setPrefs((cur) => ({ subWait: cur.subWait.filter((x) => !same(x, w)) }));
}

/** Look up English subtitles for these as soon as Jellyfin has them. */
export function queueSubtitles(list: SubWait[]): void {
  if (!list.length) return;
  setPrefs((cur) => ({ subWait: [...cur.subWait.filter((x) => !list.some((l) => same(l, x))), ...list] }));
  window.setTimeout(() => void checkSubWait(), 15_000);
}

let busy = false;

export async function checkSubWait(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (const w of [...prefs().subWait]) {
      const age = Date.now() - w.at;
      if (w.id && age < SETTLE) continue;
      const id = w.id ?? (await api.inboxFindItem(w.folder, w.kind, w.title).catch(() => null));
      if (!id) {
        if (age > GIVE_UP) {
          drop(w);
          logProblem(`Subtitles for ${w.title}`, "Jellyfin didn't show this title within 6 hours, so no subtitles were looked up. You can find them from the Library.");
        }
        continue;
      }
      drop(w);
      await track(`English subtitles for ${w.title}`, async (job) => {
        const got = await getSubtitles({ id, kind: w.kind === "tv" ? "series" : "movie" }, ["eng"], job);
        job.update(got ? `${got} English subtitle${got === 1 ? "" : "s"} added` : "No English subtitles found yet", 1);
      }, { items: [id] }).catch(() => undefined);
    }
  } finally {
    busy = false;
  }
}

/** Checks the waiting list every minute. Returns a stop function. */
export function startSubWait(): () => void {
  const first = window.setTimeout(() => void checkSubWait(), 20_000);
  const t = window.setInterval(() => void checkSubWait(), 60_000);
  return () => {
    window.clearTimeout(first);
    window.clearInterval(t);
  };
}
