import { useEffect, useRef, useState } from "react";
import { usePageState } from "./saved";
import { api, cleanTitle, errorText, imageUrl, Item, SegSummary, Status } from "./api";
import { detectAndSave, ShowIntros } from "./Intros";
import { askConfirm } from "./confirm";
import { track, useEpoch } from "./activity";
import type { View } from "./nav";
import { Icon, reloadData } from "./ui";
import { folderTabs, KTabs, PageHead, SearchBox, Seg, Toolbar } from "./kit";
import { orderFolders, setPrefs, usePrefs } from "./prefs";
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

  const pr = usePrefs();
  const hidden = pr.hiddenTabs.intros ?? [];
  const [allTops, setAllTops] = useState<string[]>([]);
  useEffect(() => void api.folders("").then((f) => setAllTops(f.map((x) => x.name))).catch(() => undefined), []);
  const withShows = foldersOf(folderMap).filter((f) => shows.some((x) => folderMap.get(x.id) === f));
  const chosen = pr.introsFolders;
  const tabsFolders = chosen ? orderFolders([...new Set([...chosen])]) : withShows;
  const toggleFolder = (f: string, on: boolean) => {
    const base = chosen ?? withShows;
    setPrefs({ introsFolders: on ? [...new Set([...base, f])] : base.filter((x) => x !== f) });
  };
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
    if (!inFolder && chosen && !chosen.includes(folderMap.get(s.id) ?? "")) return false;
    if (!onlyGaps) return true;
    const x = summaries.get(s.id);
    return !x || x.intro < x.episodes || x.credits < x.episodes;
  });

  async function findAll() {
    const list = visible.slice();
    if (!(await askConfirm(`Find intros and credits for ${list.length} show${list.length === 1 ? "" : "s"}?\n\nMedia Hub listens to every episode that's missing markers and saves the ones it's sure about. Episodes that already have markers are skipped. This can take a while; you can stop it any time, and every saved marker can be undone.`, { okLabel: "Find them" }))) return;
    await track(`Finding intros and credits (${list.length} shows)`, async (job) => {
      let saved = 0;
      for (const [i, sh] of list.entries()) {
        if (job.cancelled) break;
        const sum = await api.segmentSummary(sh.id).catch(() => null);
        if (sum && sum.episodes > 0 && sum.intro >= sum.episodes && sum.credits >= sum.episodes) continue; // already complete
        job.update(`${cleanTitle(sh.name, sh.year)} · show ${i + 1} of ${list.length}`, i / list.length);
        const d = await api.details(sh.id).catch(() => null);
        const seasons = (d?.seasons ?? []).filter((x) => x.Id).map((x) => x.Id);
        if (!seasons.length) continue;
        const sub = {
          update: (detail: string, p: number | null = null) => job.update(`${cleanTitle(sh.name, sh.year)} (${i + 1}/${list.length}) · ${detail}`, (i + (p ?? 0)) / list.length),
          get cancelled() { return job.cancelled; },
        };
        saved += await detectAndSave(seasons, sub).catch(() => 0);
        summaries.delete(sh.id);
      }
      job.update(`Markers saved for ${saved} episodes`, 1);
    }, { cancellable: true, reload: true, stop: "detect" }).catch((e) => setError(errorText(e)));
  }

  return (
    <div className="pg">
      <PageHead
        title={show ? cleanTitle(show.name, show.year) : "Intros and credits"}
        sub={show ? "Skip intro and skip credits markers, season by season." : "Finds the intro and credits of every episode and saves them as skip markers in Jellyfin. Infuse shows them as Skip buttons."}
        actions={show ? <button onClick={() => setShow(null)}><span className="flip"><Icon name="chevron" size={14} /></span> All shows</button>
          : <>
          <button onClick={() => void reloadData()}><Icon name="reload" /> Refresh</button>
          <button className="primary" disabled={status.readOnly || !visible.length} onClick={() => void findAll()} title="Media Hub listens to each episode (with ffmpeg, straight from the NAS) and saves the intros and credits it's sure about">
            <Icon name="wand" /> Find intros and credits for {visible.length === shows.length ? "all" : visible.length} shows
          </button>
          {skipper && (
            <button onClick={() => void track("Starting Intro Skipper in Jellyfin", async (job) => { const n = await api.runIntroSkipper(); job.update(`“${n}” runs in Jellyfin now; markers appear as it goes`, 1); }, { reload: false }).catch(() => undefined)} title="Jellyfin's Intro Skipper plugin finds intros and credits on the server (for the folders chosen in Settings → Intros)">
              <Icon name="skip" /> Run Intro Skipper in Jellyfin
            </button>
          )}
          </>}
      />
      {error && <p className="error">{error}</p>}
      {!show && (
        <>
          <KTabs folders active={inFolder ?? "@all"} onChange={(id) => { setTab(id === "@all" ? "all" : `folder:${id}`); setLib(null); }}
            tabs={folderTabs(tabsFolders, (f) => (f === null ? shows.filter((x) => !chosen || chosen.includes(folderMap.get(x.id) ?? "")).length : shows.filter((x) => folderMap.get(x.id) === f).length))} />
          <details className="folders-options small">
            <summary className="muted">Which folders show here</summary>
            <div className="chips">
              {allTops.map((f) => {
                const on = tabsFolders.includes(f);
                return <label key={f} className={`chip ${on ? "on" : ""}`}><input type="checkbox" checked={on} onChange={(e) => toggleFolder(f, e.target.checked)} /> {f}</label>;
              })}
              {chosen && <button className="link small" onClick={() => setPrefs({ introsFolders: null })}>Back to automatic</button>}
            </div>
            <span className="muted">Only shows (with seasons and episodes) appear in a folder; a folder Jellyfin keeps as movies shows no shows here.</span>
          </details>
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
