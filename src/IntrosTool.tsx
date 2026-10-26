import { useEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, cleanTitle, errorText, imageUrl, Item, JfItem, Library, SegSummary, Status } from "./api";
import { IntrosTab } from "./Intros";
import { track, useEpoch } from "./activity";
import type { View } from "./nav";
import { Icon, Tabs } from "./ui";
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
export default function IntrosTool({ status, onNav }: { status: Status; onNav: (v: View) => void }) {
  const epoch = useEpoch();
  const [query, setQuery] = usePageState("intros.query", "");
  const [libs, setLibs] = useState<Library[]>([]);
  const [lib, setLib] = useState<string | null>(null);
  const [shows, setShows] = useState<Item[]>([]);
  const [show, setShow] = useState<Item | null>(null);
  const [seasons, setSeasons] = useState<JfItem[]>([]);
  const [season, setSeason] = useState<JfItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyGaps, setOnlyGaps] = usePageState("intros.onlyGaps", false);
  const [tab, setTab] = usePageState("intros.tab", "all");
  const [skipper, setSkipper] = useState(false);
  useEffect(() => void api.pluginsInstalled().then((l) => setSkipper(l.some((p) => /intro ?skipper/i.test(p.name)))).catch(() => undefined), []);
  const folderMap = useFolderMap();

  useEffect(() => {
    api.libraries().then((l) => {
      const tv = l.filter((x) => x.kind === "tvshows" || x.kind === "mixed" || x.kind === "");
      setLibs(tv);
    }).catch(() => setLibs([]));
  }, []);

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

  useEffect(() => {
    setSeasons([]);
    setSeason(null);
    if (!show) return;
    api.details(show.id).then((d) => {
      const list = d.seasons.filter((s) => s.Id);
      setSeasons(list);
      setSeason(list.find((s) => (s.IndexNumber ?? 0) > 0) ?? list[0] ?? null);
    }).catch((e) => setError(errorText(e)));
  }, [show]);

  const inFolder = tabFolder(tab);
  const visible = shows.filter((s) => {
    if (inFolder && folderMap.get(s.id) !== inFolder) return false;
    if (!onlyGaps) return true;
    const x = summaries.get(s.id);
    return !x || x.intro < x.episodes || x.credits < x.episodes;
  });

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>{show ? cleanTitle(show.name, show.year) : "Intros and credits"}</h1>
          {!show && <div className="muted small">Media Hub listens to the start and end of each episode, finds the parts that repeat, and saves them to Jellyfin as “Skip intro” and “Skip credits” markers. The counts below are read the same way Infuse reads them (Jellyfin 10.10+, Infuse 8.0.4+), so a marker shown here is a skip button in Infuse.</div>}
        </div>
        {show && <div className="pg-actions"><button onClick={() => setShow(null)}>← All shows</button></div>}
      </div>
      {error && <p className="error">{error}</p>}

      {!show && (
        <>
          {libs.length > 0 && (
            <Tabs screen="intros" fixed={["all"]} active={tab} onChange={(id) => { setTab(id); setLib(id === "all" || id.startsWith("folder:") ? null : id); }}
              tabs={[{ id: "all", label: "All shown" }, ...libs.map((l) => ({ id: l.id, label: l.name, count: l.count }))]}
              folders={foldersOf(folderMap).map((f) => ({ name: f, count: shows.filter((s) => folderMap.get(s.id) === f).length || undefined }))} />
          )}
          <div className="toolbar">
            <label className="check small"><input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />Only shows with missing markers</label>
            {skipper && (
              <button className="mini-btn" onClick={() => void track("Starting Intro Skipper in Jellyfin", async (job) => { const n = await api.runIntroSkipper(); job.update(`“${n}” runs in Jellyfin now; markers appear as it goes`, 1); }, { reload: false }).catch(() => undefined)} title="Jellyfin's Intro Skipper plugin finds intros and credits on the server">
                Let Intro Skipper scan everything
              </button>
            )}
            <label className="searchbox wide"><Icon name="search" /><input placeholder="Search shows" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
          </div>
          <div className="card list-card">
            {visible.map((s) => <ShowRow key={s.id} s={s} onPick={() => setShow(s)} />)}
            {visible.length === 0 && <p className="muted pad">No shows.</p>}
          </div>
        </>
      )}

      {show && (
        <>
          <Tabs active={season?.Id ?? ""} onChange={(id) => setSeason(seasons.find((x) => x.Id === id) ?? null)} tabs={seasons.map((x) => ({ id: x.Id, label: x.Name }))} />
          {season && (
            <IntrosTab key={season.Id} seasonId={season.Id} seasonName={season.Name} canEdit={!status.readOnly} onSettings={() => onNav("settings")}
              show={{ name: show.name, seasonIds: seasons.map((s) => s.Id), onChanged: () => summaries.delete(show.id) }} />
          )}
        </>
      )}
    </div>
  );
}
