import { useEffect, useState } from "react";
import { Icon, SettingsLink } from "./ui";
import { PageHead, Seg } from "./kit";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, ImportSource, InboxEntry, remoteImageUrl, SearchResult, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { withShowYear, yearOptional } from "./prefs";

const STYLE = {
  tv: "{show}< ({year})>/{seasondir}/{show}< ({year})> - {sxe}< - {title}>.{ext}",
  movie: "{title}< ({year})>/{title}< ({year})>.{ext}",
};
const DEST_KEY = "mediahub.add.dest";

function size(b: number): string {
  if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b > 1e6) return `${Math.round(b / 1e6)} MB`;
  return `${Math.max(1, Math.round(b / 1e3))} KB`;
}

function loadDest(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DEST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Add a new show or movie: pick it, say what it is, choose where it goes. Media Hub puts it in
 * the right folder with the right name, names the files, asks Jellyfin to scan, links the
 * match and fetches the artwork.
 */
export default function AddMedia({ status, onChanged }: { status: Status; onChanged: () => void }) {
  const [src, setSrc] = useState<ImportSource | null>(null);
  const [kind, setKind] = useState<"tv" | "movie" | "music">("tv");
  const [review, setReview] = useState<{ folder: string; n: number } | null>(null);
  const [title, setTitle] = useState("");
  const [year, setYear] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [chosen, setChosen] = useState<SearchResult | null>(null);
  const [folders, setFolders] = useState<{ name: string }[]>([]);
  const [dest, setDest] = useState<string>("");
  const [mode, setMode] = useState<"move" | "copy">("move");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [inbox, setInbox] = useState<{ dir: string | null; list: InboxEntry[] } | null>(null);
  const [fromInbox, setFromInbox] = useState<string | null>(null);
  const epoch = useEpoch();

  useEffect(() => {
    api.inboxList().then(([dir, list]) => setInbox({ dir, list })).catch((e) => { setInbox({ dir: null, list: [] }); setError(errorText(e)); });
  }, [epoch]);

  function chooseSource(s: ImportSource, inboxName: string | null) {
    setSrc(s);
    setFromInbox(inboxName);
    setKind(s.kind);
    setTitle(s.title);
    setYear(s.year ? String(s.year) : "");
    setChosen(null);
    setDone(null);
    setReview(null);
    if (s.kind !== "music") void search(s.kind, s.title, s.year ? String(s.year) : "");
    else setResults([]);
  }

  useEffect(() => {
    if (status.libraryRoot) api.folders("").then(setFolders).catch(() => setFolders([]));
  }, [status.libraryRoot]);
  useEffect(() => {
    const saved = loadDest()[kind];
    if (saved && folders.some((f) => f.name === saved)) setDest(saved);
    else {
      const guess = folders.find((f) => (kind === "tv" ? /tv|show|serie/i : kind === "music" ? /music|muziek|audio/i : /movie|film/i).test(f.name));
      setDest(guess?.name ?? folders[0]?.name ?? "");
    }
  }, [kind, folders]);

  async function pick(folder: boolean) {
    setError(null);
    setDone(null);
    try {
      const s = await api.importPick(folder);
      if (!s) return;
      chooseSource(s, null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function search(k = kind, t = title, y = year) {
    if (!t.trim() || k === "music") return;
    setResults(null);
    try {
      const r = await api.identifySearch(k === "tv" ? "series" : "movie", t.trim(), y ? Number(y) : null, {});
      setResults(r);
      if (r[0]) choose(r[0]);
    } catch (e) {
      setResults([]);
      setError(errorText(e));
    }
  }

  function choose(r: SearchResult) {
    setChosen(r);
    if (r.Name) setTitle(r.Name);
    if (r.ProductionYear) setYear(String(r.ProductionYear));
  }

  async function run() {
    if (!src || !title.trim() || !dest) return;
    setError(null);
    setDone(null);
    setBusy("Adding…");
    try {
      localStorage.setItem(DEST_KEY, JSON.stringify({ ...loadDest(), [kind]: dest }));
    } catch {
      /* ignore */
    }
    const y = year ? Number(year) : null;
    const name = title.trim();
    try {
      await track(`Adding ${name}`, async (job) => {
        const un = await listen<{ done: number; total: number; file: string }>("import-progress", (e) =>
          job.update(e.payload.file ? `Putting ${e.payload.file} in place` : "Files in place", e.payload.total ? e.payload.done / e.payload.total : null),
        );
        let folder: string;
        try {
          const r = await api.importRun(dest, name, y, mode);
          folder = r.folder;
          if (r.skipped.length) job.update(`${r.skipped.length} skipped: ${r.skipped[0]}`);
          if (mode === "move" && r.copied > 0) job.update(`Copied ${r.copied} file(s) to the NAS; the originals are still where they were.`);
        } finally {
          un();
        }
        if (kind === "music") {
          job.update("Asking Jellyfin to scan", null);
          await api.scanFolders([folder]).catch(() => undefined);
          setDone(`Added to ${folder}. Jellyfin adds it to your music after its scan.`);
          return;
        }
        // Name the files inside, like the renamer would. Only names it's sure about are
        // done right away; the rest you check one by one in the Renamer.
        job.update("Naming the files", null);
        const plan = await api.plan({
          mode: kind, folder, template: kind === "tv" ? withShowYear(STYLE.tv) : STYLE.movie, show: kind === "tv" ? name : null, year: y, yearOptional: yearOptional(),
          findReplace: [], recursive: true, source: "auto", matchId: null, renameFolder: false, seasonFolders: true,
        });
        const sure = (o: (typeof plan.ops)[number]) => o.kind !== "video" || (o.verified && (o.score == null || o.score >= 100));
        const ok = plan.ops.filter((o) => o.status === "ok" && sure(o)).map((o) => o.from);
        const unsure = plan.ops.filter((o) => (o.status === "ok" && !sure(o)) || o.status === "unparsed").length;
        if (ok.length) await api.apply(plan.planId, true, ok);
        if (unsure) setReview({ folder, n: unsure });
        // Tell Jellyfin, then wait for it to show up.
        job.update("Asking Jellyfin to scan", null);
        await api.scanFolders([folder]).catch(() => undefined);
        let found: string | null = null;
        for (let i = 0; i < 24 && !found && !job.cancelled; i++) {
          await sleep(i === 0 ? 4000 : 5000);
          job.update(`Waiting for Jellyfin to find it (${(i + 1) * 5} s)`);
          await api.sync().catch(() => undefined);
          const hits = await api.list(kind === "tv" ? "series" : "movie", name, "added", 0, 10).catch(() => []);
          found = hits.find((h) => h.name.toLowerCase().replace(/\s*\(\d{4}\)$/, "") === name.toLowerCase() && (!y || !h.year || h.year === y))?.id ?? hits[0]?.id ?? null;
        }
        if (!found) {
          setDone(`Added to ${folder}. Jellyfin hasn't listed it yet; it will appear after its next scan.`);
          return;
        }
        if (!status.readOnly) {
          if (chosen) {
            job.update("Linking the match and its artwork");
            await api.identifyApply(found, chosen, true).catch(() => undefined);
          }
          job.update("Filling in missing artwork");
          await api.fillMissingArt(found, ["Primary", "Backdrop", "Logo", "Thumb", "Banner", "Art"]).catch(() => undefined);
        }
        setDone(null);
        onChanged();
        nav.open(found);
      }, { stop: "import" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  if (!status.libraryRoot) {
    return (
      <div className="pg">
        <PageHead title="Add" sub="Shows, movies and music, put in the right place with the right names." />
        <div className="card form narrow-card">
          <p className="muted">First choose your library folder (the NAS share as this computer sees it).</p>
          <button className="primary" onClick={() => void api.pickRoot().then(onChanged)}>Choose library folder</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pg">
      <PageHead title="Add" sub="Shows, movies and music: put in the right folder with the right names, linked and with artwork, so Jellyfin and Infuse show them properly." />
      {error && <p className="error">{error}</p>}
      {done && <p className="note">{done}</p>}
      {review && (
        <div className="note-bar">
          <Icon name="rename" />
          <span className="grow small">{review.n} file name{review.n === 1 ? "" : "s"} weren't certain, so they were left as they are. Check them one by one:</span>
          <button className="primary" onClick={() => nav.route({ view: "renamer", folder: review.folder })}>Review names</button>
        </div>
      )}

      <section className="card form">
        <div className="section-head">
          <h2>Inbox{inbox?.list.length ? ` (${inbox.list.length})` : ""}</h2>
          <div className="row end">
            {inbox?.dir && <span className="muted small mono">{inbox.dir}</span>}
            <button className="link small" onClick={() => void api.inboxPick().then(() => api.inboxList()).then(([dir, list]) => setInbox({ dir, list })).catch((e) => setError(errorText(e)))}>{inbox?.dir ? "Change folder" : "Watch a folder…"}</button>
          </div>
        </div>
        {!inbox?.dir && <p className="muted small">Point Media Hub at your downloads folder: new shows and movies show up here, ready to add with one click.</p>}
        {inbox?.dir && inbox.list.length === 0 && <p className="muted small">Nothing new in the inbox.</p>}
        {inbox?.list.map((e) => (
          <div key={e.name} className={`inbox-row ${fromInbox === e.name ? "on" : ""}`}>
            <span className="ico">{e.source.isFolder ? "📁" : "🎞"}</span>
            <div className="names">
              <div className="strong ellipsis">{e.name}</div>
              <div className="muted small">
                Looks like {e.source.kind === "tv" ? "a show" : e.source.kind === "music" ? "music" : "a movie"}: {e.source.title}{e.source.year ? ` (${e.source.year})` : ""} · {e.source.files.filter((f) => f.video).length} video{e.source.files.filter((f) => f.video).length === 1 ? "" : "s"} · {size(e.source.totalBytes)}
              </div>
            </div>
            <button className={fromInbox === e.name ? "primary" : ""} onClick={() => void api.inboxSelect(e.name).then((s) => chooseSource(s, e.name)).catch((err) => setError(errorText(err)))}>{fromInbox === e.name ? "Selected" : "Add…"}</button>
          </div>
        ))}
      </section>

      <section className="card form">
        <div className="picker-head"><span className="step-dot">1</span><div className="strong grow">What do you want to add?</div></div>
        <div className="row">
          <button className={src?.isFolder === true ? "primary" : ""} onClick={() => void pick(true)}>Choose a folder…</button>
          <button className={src?.isFolder === false ? "primary" : ""} onClick={() => void pick(false)}>Choose a video file…</button>
          <span className="muted small">A show folder (all seasons), a season, a movie folder or one movie file. From your Downloads, an external drive, anywhere.</span>
        </div>
        {src && (
          <div className="add-src">
            <span className="ico">{src.isFolder ? "📁" : "🎞"}</span>
            <div className="grow">
              <div className="strong">{src.name}</div>
              <div className="muted small">{src.files.filter((f) => f.video).length} video{src.files.filter((f) => f.video).length === 1 ? "" : "s"}{src.files.some((f) => !f.video) ? ` + ${src.files.filter((f) => !f.video).length} subtitle/extra files` : ""} · {size(src.totalBytes)}</div>
            </div>
          </div>
        )}
      </section>

      {src && (
        <section className="card form">
          <div className="picker-head">
            <span className="step-dot">2</span>
            <div className="strong grow">{kind === "music" ? "Which album or artist is it?" : `Which ${kind === "tv" ? "show" : "movie"} is it?`} <span className="muted small thin">(detected automatically, change it if it's wrong)</span></div>
            <Seg value={kind} onChange={(k) => { setKind(k); void search(k); }} options={[{ id: "tv", label: "Show" }, { id: "movie", label: "Movie" }, { id: "music", label: "Music" }]} />
          </div>
          <div className="row">
            <label>Title<input value={title} onChange={(e) => { setTitle(e.target.value); setChosen(null); }} onKeyDown={(e) => e.key === "Enter" && void search()} /></label>
            <label className="narrow">Year<input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} /></label>
            <button onClick={() => void search()}>Search</button>
          </div>
          {results === null && title && <p className="muted small">Looking it up…</p>}
          {results && results.length === 0 && <p className="muted small">No match found online. It will be added with the name as typed; you can identify it later.</p>}
          <div className="add-results">
            {(results ?? []).slice(0, 8).map((r, i) => {
              const on = chosen === r;
              return (
                <button key={i} className={`add-result ${on ? "on" : ""}`} onClick={() => choose(r)}>
                  <div className="art">{r.ImageUrl ? <img src={remoteImageUrl(r.ImageUrl)} alt="" loading="lazy" /> : <div className="noart">{r.Name}</div>}</div>
                  <div className="small strong ellipsis">{r.Name}</div>
                  <div className="small muted">{r.ProductionYear ?? ""} {r.SearchProviderName ? `· ${r.SearchProviderName}` : ""}</div>
                </button>
              );
            })}
          </div>
          {chosen?.Overview && <p className="muted small">{chosen.Overview.slice(0, 320)}{chosen.Overview.length > 320 ? "…" : ""}</p>}
        </section>
      )}

      {src && (
        <section className="card form">
          <div className="picker-head"><span className="step-dot">3</span><div className="strong grow">Where does it go?</div></div>
          <div className="row">
            <label>Library folder
              <select value={dest} onChange={(e) => setDest(e.target.value)}>
                {folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </select>
            </label>
            <label>How
              <select value={mode} onChange={(e) => setMode(e.target.value as "move" | "copy")}>
                <option value="move">Move (copies when it's on another drive)</option>
                <option value="copy">Copy, keep the original</option>
              </select>
            </label>
          </div>
          <div className="add-preview mono small">
            <div className="muted">{status.libraryRoot}/{dest}/</div>
            <div className="ok">{title.trim() || "…"}{year ? ` (${year})` : ""}/</div>
            <div className="muted">{kind === "music" ? "  (the files as they are)" : kind === "tv" ? "  Season 01/  …  S01E01 - Episode title.mkv" : `  ${title.trim() || "…"}${year ? ` (${year})` : ""}.mkv`}</div>
          </div>
          <div className="applybar">
            <div className="grow muted small">
              Nothing is overwritten; files that are already there are skipped.
              {status.readOnly ? <> Linking and artwork need changes switched on (<SettingsLink section="changes">turn them on</SettingsLink>); the files are still put in place.</> : " After Jellyfin finds it, the match is linked and missing artwork is filled in."}
            </div>
            <button className="primary" disabled={!!busy || !title.trim() || !dest} onClick={() => void run()}>{busy ?? `Add ${kind === "tv" ? "show" : kind === "music" ? "music" : "movie"}`}</button>
          </div>
        </section>
      )}
    </div>
  );
}
