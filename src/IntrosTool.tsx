import { useEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, cleanTitle, errorText, imageUrl, Item, SegSummary, Status } from "./api";
import { ShowIntros } from "./Intros";
import { track, useEpoch } from "./activity";
import type { View } from "./nav";
import { Icon } from "./ui";
import { folderTabs, KTabs, PageHead, SearchBox, Seg, Toolbar } from "./kit";
import { usePrefs } from "./prefs";
import { foldersOf, tabFolder, useFolderMap } from "./folders";

// Marker counts per show, kept while the app is open.
const summaries = new Map<string, SegSummary>();
let queue: Promise<void> = Promise.resolve();

/** Loads a show's marker counts one at a time (each needs a call per episode). */
function useSummary(id: string, visible: boolean, fresh: number): SegSummary | null {
  const [s, setS] = useState<SegSummary | null>(summaries.get(id) ?? null);
  useEffect(() => {
    if (!visible || (summaries.has(id) && !fresh)) return;
    let alive = true;
    queue = queue.then(() =>
      api.segmentSummary(id, fresh > 0).then((x) => {
        summaries.set(id, x);
        if (alive) setS(x);
      }).catch(() => undefined),
    );
    return () => {
      alive = false;
    };
  }, [id, visible, fresh]);
  return s;
}

function ShowRow({ s, onPick }: { s: Item; onPick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setVisible(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const sum = useSummary(s.id, visible, 0);
  const pct = (n: number) => (sum && sum.episodes ? n / sum.episodes : 0);
  const cls = (n: number) => (!sum ? "muted" : pct(n) >= 0.9 ? "ok" : pct(n) > 0 ? "warn" : "bad");
  return (
    <button ref={ref} className="intro-row" onClick={onPick}>
      <div className="thumb">{s.hasPoster ? <img src={imageUrl(s.id, "Primary", 120)} alt="" loading="lazy" /> : null}</div>
      <div className="names">
        <div className="title">{cleanTitle(s.name, s.year)}{s.year && !/\(\d{4}\)/.test(cleanTitle(s.name, s.year)) ? <span className="muted"> ({s.year})</span> : null}</div>
        <div className="muted small">{[s.seasons ? `${s.seasons} season${s.seasons === 1 ? "" : "s"}` : "", s.episodes ? `${s.episodes} episodes` : ""].filter(Boolean).join(" · ")}</div>
        <div className="intro-cov small">
          {!sum ? <span className="muted">Counting markers…</span> : (
            <>
              <span className={cls(sum.intro)}>Intro {sum.intro}/{sum.episodes}</span>
              <span className={cls(sum.credits)}>Credits {sum.credits}/{sum.episodes}</span>
              {sum.recap > 0 && <span className="muted">Recap {sum.recap}</span>}
            </>
          )}
        </div>
      </div>
      {sum && <span className="intro-bar"><span style={{ width: `${pct(sum.intro) * 100}%` }} /></span>}
      <span className="muted">›</span>
    </button>
  );
}

/** Intros and credits: shows per library, then a season's timeline. */
export default function IntrosTool({ status }: { status: Status; onNav?: (v: View) => void }) {
  const epoch = useEpoch();
  const [query, setQuery] = usePageState("intros.query", "");
  const [lib, setLib] = useState<string | null>(null);
  const [shows, setShows] = useState<Item[]>([]);
  const [show, setShow] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyGaps, setOnlyGaps] = usePageState("intros.onlyGaps", false);
  const [tab, setTab] = usePageState("intros.tab", "all");
  const [skipper, setSkipper] = useState(false);
  useEffect(() => void api.pluginsInstalled().then((l) => setSkipper(l.some((p) => /intro ?skipper/i.test(p.name)))).catch(() => undefined), []);
  const folderMap = useFolderMap();

  const hidden = usePrefs().hiddenTabs.intros ?? [];
  useEffect(() => {
    const t = setTimeout(() => {
      api.list("series", query, "name", 0, 3000, lib)
        // "All shown" leaves out the libraries whose tab you closed.
        .then((rows) => setShows(lib ? rows : rows.filter((r) => !hidden.includes(r.library))))
        .catch((e) => setError(errorText(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [query, lib, epoch, hidden.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  const inFolder = tabFolder(tab);
  const visible = shows.filter((s) => {
    if (inFolder && folderMap.get(s.id) !== inFolder) return false;
    if (!onlyGaps) return true;
    const x = summaries.get(s.id);
    return !x || x.intro < x.episodes || x.credits < x.episodes;
  });

  return (
    <div className="pg">
      <PageHead
        title={show ? cleanTitle(show.name, show.year) : "Intros and credits"}
        sub={show ? "Skip intro and skip credits markers, season by season." : "Finds the intro and credits of every episode and saves them as skip markers in Jellyfin. Infuse shows them as Skip buttons."}
        actions={show ? <button onClick={() => setShow(null)}><span className="flip"><Icon name="chevron" size={14} /></span> All shows</button>
          : skipper ? (
            <button onClick={() => void track("Starting Intro Skipper in Jellyfin", async (job) => { const n = await api.runIntroSkipper(); job.update(`“${n}” runs in Jellyfin now; markers appear as it goes`, 1); }, { reload: false }).catch(() => undefined)} title="Jellyfin's Intro Skipper plugin finds intros and credits on the server (for the folders chosen in Settings → Intros)">
              <Icon name="skip" /> Run Intro Skipper in Jellyfin
            </button>
          ) : undefined}
      />
      {error && <p className="error">{error}</p>}
      {!show && (
        <>
          <KTabs folders active={inFolder ?? "@all"} onChange={(id) => { setTab(id === "@all" ? "all" : `folder:${id}`); setLib(null); }}
            tabs={folderTabs(foldersOf(folderMap).filter((f) => shows.some((x) => folderMap.get(x.id) === f)), (f) => (f === null ? shows.length : shows.filter((x) => folderMap.get(x.id) === f).length))} />
          <Toolbar right={<span className="muted small">{visible.length} show{visible.length === 1 ? "" : "s"}</span>}>
            <SearchBox value={query} onChange={setQuery} placeholder="Search shows" />
            <Seg value={onlyGaps ? "gaps" : "all"} onChange={(v) => setOnlyGaps(v === "gaps")} options={[{ id: "all", label: "All" }, { id: "gaps", label: "Missing markers" }]} />
          </Toolbar>
          <div className="card list-card">
            {visible.map((s) => <ShowRow key={s.id} s={s} onPick={() => setShow(s)} />)}
            {visible.length === 0 && <p className="muted pad">No shows.</p>}
          </div>
        </>
      )}

      {show && <ShowIntros key={show.id} seriesId={show.id} canEdit={!status.readOnly} onChanged={() => summaries.delete(show.id)} />}
    </div>
  );
}
