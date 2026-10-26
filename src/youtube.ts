// YouTube channels live in one folder without seasons. Infuse then shows "0." in front of
// every video; numbering them (by date, in Jellyfin's details only) fixes that.
import { api } from "./api";
import { track } from "./activity";

/** Numbers the videos of a YouTube-style show 1…n by date. Returns how many changed. */
export function numberYouTube(seriesId: string, name: string): Promise<number> {
  return track(`Numbering the videos of ${name}`, async (job) => {
    const n = await api.youtubeNumber(seriesId);
    job.update(n ? `${n} video${n === 1 ? "" : "s"} numbered` : "Already numbered", 1);
    return n;
  });
}
