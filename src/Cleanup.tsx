// Clean-up: one block per thing the scan looks at (duplicates, missing episodes, folders,
// storage, episode pictures). Click a block to see the details and fix them below it.
import { useEffect, useState } from "react";
import { api, errorText, ImageKind, Status } from "./api";
import { nav, type View } from "./nav";
import { track } from "./activity";
import { Icon } from "./ui";
import Duplicates from "./Duplicates";
import Missing from "./Missing";
import Storage from "./Storage";
import { cleanupBlocks } from "./Dashboard";
import { KTabs, PageHead } from "./kit";
import { savePart, scanEverything, useScanSummary } from "./scan";
import { rankImages } from "./ArtPicker";
import { usePageState } from "./saved";

export type CleanupTab = "duplicates" | "missing" | "folders" | "storage" | "pictures";
// Folder tidying lives in the Renamer (Renamer → Folders).
const TABS: CleanupTab[] = ["duplicates", "missing", "storage", "pictures"];
const asTab = (t?: string): CleanupTab | "" => (TABS.includes(t as CleanupTab) ? (t as CleanupTab) : "");

export default function Cleanup({ status, tab, onNav }: { status: Status; tab?: string; onNav: (v: View) => void }) {
  const [saved, setSaved] = usePageState<CleanupTab | "">("cleanup.open", "");
  const [t, setT] = useState<CleanupTab>(asTab(tab) || asTab(saved) || "duplicates");
  useEffect(() => {
    if (asTab(tab)) setT(asTab(tab) as CleanupTab);
  }, [tab]);
  const pick = (k: string) => {
    setT(k as CleanupTab);
    setSaved(k as CleanupTab);
  };
  useEffect(() => {
    if (tab === "folders") nav.route({ view: "renamer", section: "folders" });
  }, [tab]);
  const sum = useScanSummary();
  const [scanning, setScanning] = useState(false);
  return (
    <div className="pg cleanup">
      <PageHead
        title="Clean-up"
        sub="Duplicates, missing episodes, big files and episodes without a picture. The numbers come from the last scan."
        actions={
          <button className="primary" disabled={scanning} title="Runs every check on this page (and the library check) in one go" onClick={() => { setScanning(true); void scanEverything(status).catch(() => undefined).finally(() => setScanning(false)); }}>
            {scanning ? <span className="spinner" /> : <Icon name="search" />} {scanning ? "Scanning…" : "Run all checks"}
          </button>
        }
      />
      <KTabs active={t} onChange={pick} tabs={cleanupBlocks(sum, status.series).filter((b) => b.key !== "folders").map((b) => ({ id: b.key, label: b.title, icon: b.icon, count: b.count === null ? "–" : b.count === 0 ? "✓" : b.count.toLocaleString(), warn: !!b.count }))} />
      <div className="cleanup-body" key={t}>
        {t === "duplicates" && <Duplicates status={status} />}
        {t === "missing" && <Missing status={status} />}
        {t === "storage" && <Storage status={status} onNav={onNav} />}
        {t === "pictures" && <EpisodePictures status={status} />}
      </div>
    </div>
  );
}

type Bare = { id: string; name: string; seriesId: string; series: string };

/**
 * Episodes without a picture: TMDB's still first (what Infuse would show), and when there's
 * none, a frame from the video. Shows are listed so you can do one or all.
 */
function EpisodePictures({ status }: { status: Status }) {
  const [eps, setEps] = useState<Bare[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useFrames, setUseFrames] = usePageState("cleanup.pictures.frames", true);
  const load = () => {
    setError(null);
    api.episodesWithoutPicture()
      .then((l) => {
        setEps(l);
        savePart("pictures", { at: Date.now(), episodes: l.length });
      })
      .catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  const shows = new Map<string, { name: string; eps: Bare[] }>();
  for (const e of eps ?? []) {
    const s = shows.get(e.seriesId) ?? { name: e.series || "Other", eps: [] };
    s.eps.push(e);
    shows.set(e.seriesId, s);
  }
  const list = [...shows.entries()].sort((a, b) => b[1].eps.length - a[1].eps.length);

  async function fill(items: Bare[]) {
    if (!items.length) return;
    await track(`Pictures for ${items.length} episode${items.length === 1 ? "" : "s"}`, async (job) => {
      let fromTmdb = 0;
      const left = new Set<string>();
      for (const [i, e] of items.entries()) {
        if (job.cancelled) break;
        job.update(`TMDB · ${e.name}`, (i / items.length) * (useFrames ? 0.7 : 1));
        try {
          const best = rankImages(await api.remoteImages(e.id, "Primary" as ImageKind), "Primary", status.titleLang || "en")[0];
          if (best?.Url) {
            await api.setImage(e.id, "Primary", best.Url);
            fromTmdb++;
            continue;
          }
        } catch {
          /* falls back to a frame */
        }
        left.add(e.seriesId);
      }
      let frames = 0;
      if (useFrames && left.size && !job.cancelled) {
        const ids = [...left];
        for (const [i, sid] of ids.entries()) {
          if (job.cancelled) break;
          job.update(`Frames from the video · ${shows.get(sid)?.name ?? ""}`, 0.7 + (i / ids.length) * 0.3);
          frames += await api.makeEpisodeStills(sid).catch(() => 0);
        }
      }
      job.update(`${fromTmdb} from TMDB${useFrames ? `, ${frames} from the video` : ""}`, 1);
    }, { cancellable: true, reload: false }).catch(() => undefined);
    load();
  }

  return (
    <section className="card form">
      <div className="section-head">
        <h2>Episode pictures</h2>
        <span className="muted small">{eps === null ? "Looking…" : `${eps.length} episode${eps.length === 1 ? "" : "s"} in ${shows.size} show${shows.size === 1 ? "" : "s"} have no picture.`}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <label className="check"><input type="checkbox" checked={useFrames} onChange={(e) => setUseFrames(e.target.checked)} />When TMDB has none, use a frame from the video (needs ffmpeg)</label>
        <div className="spacer" />
        <button onClick={load}><Icon name="reload" /> Look again</button>
        <button className="primary" disabled={status.readOnly || !eps?.length} onClick={() => void fill(eps ?? [])}>Fill in all {eps?.length || ""}</button>
      </div>
      {list.length > 0 && (
        <div className="table">
          {list.map(([sid, s]) => (
            <div className="op" key={sid}>
              <div className="names">
                <div className="strong">{s.name}</div>
                <div className="small muted ellipsis">{s.eps.slice(0, 4).map((e) => e.name.split(" · ").slice(1).join(" · ")).join(" · ")}{s.eps.length > 4 ? ` · +${s.eps.length - 4} more` : ""}</div>
              </div>
              <span className="chip static">{s.eps.length}</span>
              <button disabled={status.readOnly} onClick={() => void fill(s.eps)}>Fill in</button>
            </div>
          ))}
        </div>
      )}
      {eps && eps.length === 0 && <p className="muted">Every episode has a picture.</p>}
    </section>
  );
}
