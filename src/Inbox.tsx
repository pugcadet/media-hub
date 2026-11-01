// The Inbox: new downloads in your downloads folder. Each one is recognised (episodes of a
// show you have, a new show, a movie, an album, something else), gets its place and name, and
// what you already have is skipped. Nothing moves until you press "Put … in place": then the
// files go to the NAS (checked), get the right names, Jellyfin looks at the folder, and the
// download goes to the Trash.
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, remoteImageUrl, HealthRow, InboxItem, InboxPlan, InboxTarget, scanAround, SearchResult, Status, stripEditions } from "./api";
import { track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { IconBtn, PageHead, SearchBox, Seg } from "./kit";
import { Icon } from "./ui";
import { nav } from "./nav";
import { prefs, setPrefs, usePrefs } from "./prefs";

type State = "checking" | "ready" | "look" | "have" | "placing" | "done" | "failed";

interface Row {
  item: InboxItem;
  target: InboxTarget | null;
  plan: InboxPlan | null;
  state: State;
  /** One line on what it is and why it goes there. */
  why: string;
  /** Online match ids (for the names afterwards). */
  ids: Record<string, string>;
  /** What happened when it was put in place. */
  result?: string;
  /** Online candidates with their posters, to pick from when it needs a look. */
  pics?: SearchResult[];
}

/* ------------------------------------------------------------------ matching */

const norm = (s: string) => s.toLowerCase().replace(/\(\d{4}\)/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "").replace(/^the/, "");
function likeness(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => { const g = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const ga = grams(x), gb = grams(y);
  let same = 0;
  ga.forEach((n, k) => { same += Math.min(n, gb.get(k) ?? 0); });
  return (2 * same) / Math.max(1, x.length - 1 + y.length - 1);
}

interface Ctx {
  shows: HealthRow[];
  movies: HealthRow[];
  tops: string[];
}

/** The main folder new things of a kind go to: your choice, else where most of them are. */
function defaultTop(kind: InboxTarget["kind"], ctx: Ctx): string {
  const chosen = prefs().inboxTop[kind];
  if (chosen && ctx.tops.includes(chosen)) return chosen;
  const most = (rows: HealthRow[]) => {
    const n = new Map<string, number>();
    rows.forEach((r) => r.libraryFolder && n.set(r.libraryFolder, (n.get(r.libraryFolder) ?? 0) + 1));
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const named = (re: RegExp) => ctx.tops.find((t) => re.test(t));
  if (kind === "tv") return most(ctx.shows) ?? named(/tv|series|show/i) ?? ctx.tops[0] ?? "";
  if (kind === "movie") return most(ctx.movies) ?? named(/movie|film/i) ?? ctx.tops[0] ?? "";
  if (kind === "music") return named(/music|muziek/i) ?? ctx.tops[0] ?? "";
  return named(/youtube|other|home|video/i) ?? ctx.tops[0] ?? "";
}

/** Library titles that look like this name, best first. */
function libraryMatches(rows: HealthRow[], title: string, year: number | null): { row: HealthRow; score: number }[] {
  return rows
    .map((row) => ({ row, score: likeness(row.name, title) - (year && row.year && row.year !== year ? 0.3 : 0) }))
    .filter((x) => x.score >= 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4);
}

async function detect(item: InboxItem, ctx: Ctx): Promise<Row> {
  const base: Row = { item, target: null, plan: null, state: "look", why: "", ids: {} };
  const t = (p: Partial<InboxTarget>): InboxTarget => ({ kind: item.kind, itemId: null, top: defaultTop(item.kind, ctx), title: item.title, year: item.year, season: null, artist: null, album: null, ...p });
  let row: Row;
  if (item.kind === "music") {
    const m = item.music;
    row = m
      ? { ...base, state: "ready", target: t({ kind: "music", artist: m.artist, album: m.album, year: m.year, title: m.album }), why: `Album by ${m.artist}` }
      : { ...base, target: t({ kind: "music" }), why: "No artist and album in the songs' tags: fill them in" };
  } else if (item.kind === "tv") {
    const noSeason = item.files.some((f) => f.video && f.season == null);
    const hit = libraryMatches(ctx.shows, item.title, item.year)[0];
    if (hit && hit.score >= 0.92) {
      row = { ...base, state: noSeason && !hit.row.libraryFolder ? "look" : "ready", target: t({ itemId: hit.row.id, title: hit.row.name, year: hit.row.year, top: hit.row.libraryFolder }), why: `Adds to your show ${hit.row.name}${hit.row.libraryFolder ? ` in ${hit.row.libraryFolder}` : ""}` };
    } else {
      const found = await api.identifySearch("series", item.title, item.year, {}).catch(() => [] as SearchResult[]);
      const best = found.find((r) => likeness(r.Name ?? "", item.title) >= 0.92 && (!item.year || !r.ProductionYear || r.ProductionYear === item.year));
      const remembered = prefs().inboxShowTop[norm(best?.Name ?? item.title)];
      if (best) {
        row = { ...base, state: noSeason ? "look" : "ready", ids: best.ProviderIds ?? {}, target: t({ title: best.Name ?? item.title, year: best.ProductionYear ?? item.year, top: remembered ?? defaultTop("tv", ctx) }), why: noSeason ? "New show; some files have no season or episode number" : `New show (${best.SearchProviderName ?? "online"} match)` };
      } else {
        row = { ...base, pics: found.slice(0, 4), target: t({ top: remembered ?? defaultTop("tv", ctx) }), why: noSeason ? "No show found and no season or episode in the name" : "No sure match online: pick the show" };
      }
    }
  } else {
    const have = libraryMatches(ctx.movies, item.title, item.year).find((x) => x.score >= 0.95 && (!item.year || !x.row.year || x.row.year === item.year));
    if (have) {
      row = { ...base, state: "have", target: t({ itemId: have.row.id, title: have.row.name, year: have.row.year, top: have.row.libraryFolder }), why: `Already in your library: ${have.row.name}${have.row.year ? ` (${have.row.year})` : ""}` };
    } else {
      const found = await api.identifySearch("movie", item.title, item.year, {}).catch(() => [] as SearchResult[]);
      const sure = found.filter((r) => likeness(r.Name ?? "", item.title) >= 0.92 && (!item.year || r.ProductionYear === item.year));
      const best = sure[0];
      row = best && (sure.length === 1 || item.year)
        ? { ...base, state: "ready", ids: best.ProviderIds ?? {}, target: t({ title: best.Name ?? item.title, year: best.ProductionYear ?? item.year }), why: "New movie" }
        : { ...base, pics: (sure.length ? sure : found).slice(0, 4), target: t({}), ids: best?.ProviderIds ?? {}, why: sure.length > 1 ? `${sure.length} movies with this name: pick the right one` : "No sure match online: pick the movie" };
    }
  }
  if (row.target) {
    try {
      row.plan = await api.inboxResolve(item.key, row.target);
      const vids = row.plan.moves.filter((m) => /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg|flac|mp3|m4a|ogg|opus|wav|aac|alac|aiff|aif)$/i.test(m.from));
      if (vids.length && vids.every((m) => m.have)) {
        row.state = "have";
        row.why = row.plan.existing ? "Already in your library" : "Already there";
      } else if (vids.some((m) => m.have) && row.state === "ready") {
        row.why += ` · ${vids.filter((m) => m.have).length} already there (skipped)`;
      }
    } catch (e) {
      row.state = "look";
      row.why = errorText(e);
    }
  }
  return row;
}

/* ------------------------------------------------------------------ the page */

const STATE_LABEL: Record<State, string> = { checking: "Looking…", ready: "Ready", look: "Needs a look", have: "Already have it", placing: "Putting in place…", done: "Done", failed: "Didn't work" };
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export default function Inbox({ status }: { status: Status }) {
  const epoch = useEpoch();
  usePrefs();
  const [dir, setDir] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | State>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [n, setN] = useState(0);
  const doneRows = useRef<Row[]>([]);

  useEffect(() => {
    let alive = true;
    setError(null);
    (async () => {
      const [[d, items], h, tops] = await Promise.all([
        api.inboxScan(),
        api.libraryHealth(false).catch(() => ({ at: 0, rows: [] as HealthRow[] })),
        api.folders("").then((f) => f.map((x) => x.name)).catch(() => [] as string[]),
      ]);
      if (!alive) return;
      setDir(d);
      const c: Ctx = { shows: h.rows.filter((r) => r.kind === "series"), movies: h.rows.filter((r) => r.kind === "movie"), tops };
      setCtx(c);
      setRows(items.map((item) => ({ item, target: null, plan: null, state: "checking", why: "", ids: {} })));
      // Three at a time, each row filling in as it's done.
      let k = 0;
      const out: Row[] = [];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (k < items.length && alive) {
          const i = k++;
          out[i] = await detect(items[i], c).catch((e) => ({ item: items[i], target: null, plan: null, state: "look" as State, why: errorText(e), ids: {} }));
          if (alive) setRows((rs) => rs?.map((r) => (r.item.key === items[i].key ? out[i] : r)) ?? null);
        }
      }));
      if (alive) setPicked(new Set(out.filter((r) => r?.state === "ready").map((r) => r.item.key)));
    })().catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [n, epoch]);

  const all = [...(rows ?? []), ...doneRows.current.filter((d) => !(rows ?? []).some((r) => r.item.key === d.item.key))];
  const count = (s: State) => all.filter((r) => r.state === s).length;
  const q = query.trim().toLowerCase();
  const shown = all.filter((r) => (filter === "all" || r.state === filter) && (!q || r.item.key.toLowerCase().includes(q) || (r.target?.title ?? "").toLowerCase().includes(q)));
  const ready = all.filter((r) => r.state === "ready" && picked.has(r.item.key));
  const update = (key: string, p: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.item.key === key ? { ...r, ...p } : r)) ?? null);

  async function place(list: Row[]) {
    if (!list.length) return;
    const files = list.reduce((a, r) => a + (r.plan?.moves.filter((m) => !m.have).length ?? 0), 0);
    if (!(await askConfirm(`Put ${list.length} download${list.length === 1 ? "" : "s"} in place (${files} file${files === 1 ? "" : "s"})?\n\nThey go to the NAS with the right names. Once a file has arrived and its size checks out, the download goes to the Trash (you can put it back from there). Anything already in your library is skipped.`, { okLabel: "Put in place" }))) return;
    setBusy(true);
    const args = (await import("./Renamer")).namingArgs();
    for (const r of list) {
      if (!r.plan || !r.target) continue;
      update(r.item.key, { state: "placing" });
      try {
        await track(`Putting ${r.target.title} in place`, async (job) => {
          const un = await listen<{ key: string; done: number; total: number; file: string }>("inbox-progress", (e) => {
            if (e.payload.key === r.item.key) job.update(e.payload.file ? e.payload.file.split("/").pop() ?? "" : "Checking", e.payload.total ? (e.payload.done / e.payload.total) * 0.8 : null);
          });
          let res;
          try {
            res = await api.inboxPlace(r.item.key, r.plan!.moves);
          } finally {
            un();
          }
          // The right names, the way the Renamer names things (only names it's sure about).
          if (res.placed.length && (r.target!.kind === "tv" || r.target!.kind === "movie")) {
            job.update("Naming the files", 0.85);
            const tv = r.target!.kind === "tv";
            const matchId = r.target!.itemId ? `jellyfin:${r.target!.itemId}` : r.ids.Tmdb ? `tmdb:${r.ids.Tmdb}` : null;
            const plan = await api.plan({
              mode: tv ? "tv" : "movie", folder: r.plan!.folder, template: tv ? args[0] : args[1], show: tv && !r.target!.itemId ? r.target!.title : null, year: tv && !r.target!.itemId ? r.target!.year : null,
              yearOptional: args[2], minimal: false, findReplace: [], recursive: true, source: "auto", matchId: tv ? matchId : null, renameFolder: false, seasonFolders: false,
            }).catch(() => null);
            const placed = new Set(res.placed);
            const sure = (o: { kind: string; verified: boolean; score: number | null }) => o.kind !== "video" || (o.verified && (o.score == null || o.score >= 100));
            const ops = plan?.ops.filter((o) => o.status === "ok" && placed.has(o.from) && sure(o)).map((o) => o.from) ?? [];
            if (plan && ops.length) await api.apply(plan.planId, true, ops).catch(() => undefined);
          }
          job.update("Asking Jellyfin to look", 0.95);
          await scanAround([...new Set(res.placed.map((p) => p.split("/").slice(0, -1).join("/")))]);
          const msg = `${res.placed.length} placed${res.skipped ? ` · ${res.skipped} already there` : ""}${res.trashed ? " · download in the Trash" : ""}`;
          if (res.failed.length) throw `${msg} · ${res.failed.length} didn't work: ${res.failed[0]}`;
          job.update(msg, 1);
          const done = { ...r, state: "done" as State, result: msg };
          doneRows.current = [done, ...doneRows.current.filter((d) => d.item.key !== r.item.key)];
          update(r.item.key, done);
        }, { reload: false, stop: "inbox" });
      } catch (e) {
        update(r.item.key, { state: "failed", result: errorText(e) });
      }
    }
    setBusy(false);
    setPicked(new Set());
  }

  async function choose(r: Row, c: SearchResult) {
    if (!r.target) return;
    const target = { ...r.target, itemId: null, title: c.Name ?? r.target.title, year: c.ProductionYear ?? r.target.year };
    update(r.item.key, { state: "checking" });
    try {
      const plan = await api.inboxResolve(r.item.key, target);
      update(r.item.key, { target, plan, ids: c.ProviderIds ?? {}, state: "ready", why: `Your choice: ${c.Name}${c.ProductionYear ? ` (${c.ProductionYear})` : ""}` });
      setPicked((s) => new Set(s).add(r.item.key));
    } catch (e) {
      update(r.item.key, { state: "look", why: errorText(e) });
    }
  }

  async function removeDownload(r: Row) {
    if (!(await askConfirm(`Move “${r.item.key}” to the Trash? It's already in your library. You can put it back from the Trash.`, { okLabel: "Move to Trash" }))) return;
    try {
      await api.inboxTrash(r.item.key);
      const done = { ...r, state: "done" as State, result: "Download moved to the Trash" };
      doneRows.current = [done, ...doneRows.current];
      update(r.item.key, done);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const editRow = all.find((r) => r.item.key === editing) ?? null;
  const chips: { id: "all" | State; label: string; n: number; tone: string }[] = [
    { id: "all", label: "All", n: all.length, tone: "" },
    { id: "ready", label: "Ready", n: count("ready"), tone: "ok" },
    { id: "look", label: "Needs a look", n: count("look"), tone: "warn" },
    { id: "have", label: "Already have", n: count("have"), tone: "" },
    { id: "done", label: "Done", n: count("done"), tone: "" },
  ];

  return (
    <div className="pg inbox">
      <PageHead
        title="Inbox"
        sub="New downloads, recognised and named for you. Nothing moves until you say so."
        actions={<>
          <button className="inbox-dir" onClick={() => void api.inboxPick().then((d) => d && setN((x) => x + 1))} title="Choose another downloads folder">
            <Icon name="folder" size={14} /> {dir ? <span className="mono ellipsis">{dir}</span> : "Choose your downloads folder"}
          </button>
          {dir && <IconBtn icon="external" title="Open the downloads folder" onClick={() => void api.inboxReveal().catch((e) => setError(errorText(e)))} />}
          <IconBtn icon="reload" title="Look again" onClick={() => setN((x) => x + 1)} />
          <button className="primary" disabled={busy || !ready.length || status.readOnly} onClick={() => void place(ready)}>
            {busy ? <span className="spinner" /> : <Icon name="check" />} Put {ready.length || ""} in place
          </button>
        </>}
      />
      {error && <p className="error">{error}</p>}
      {!dir && rows && (
        <div className="inbox-empty card">
          <Icon name="inbox" size={30} />
          <h2>Where do your downloads land?</h2>
          <p className="muted">Choose the folder your downloads end up in (for example Downloads/Complete). Media Hub looks there and shows what it found.</p>
          <button className="primary" onClick={() => void api.inboxPick().then((d) => d && setN((x) => x + 1))}><Icon name="folder" /> Choose the folder</button>
        </div>
      )}
      {dir && (
        <>
          <div className="inbox-chips">
            {chips.filter((c) => c.id === "all" || c.n > 0).map((c) => (
              <button key={c.id} className={`inbox-chip ${c.tone} ${filter === c.id ? "on" : ""}`} onClick={() => setFilter(c.id)}>{c.label} {c.n}</button>
            ))}
            <span className="spacer" />
            <SearchBox value={query} onChange={setQuery} placeholder="Find a download" />
          </div>
          <div className="inbox-list card">
            <div className="inbox-row head"><span /><span>Found</span><span>Goes to</span><span>Status</span><span /></div>
            {!rows && <div className="pg-loading"><span className="spinner" /> Looking in the downloads folder…</div>}
            {rows && shown.length === 0 && <p className="muted pad">{all.length ? "Nothing here." : "The downloads folder is empty."}</p>}
            {shown.map((r) => <InboxRowView key={r.item.key} r={r} onChoose={(c) => void choose(r, c)} picked={picked.has(r.item.key)} onPick={(on) => setPicked((s) => { const x = new Set(s); if (on) x.add(r.item.key); else x.delete(r.item.key); return x; })} onEdit={() => setEditing(r.item.key)} onRemove={() => void removeDownload(r)} onPlaceOne={() => void place([r])} busy={busy} />)}
          </div>
          <div className="inbox-note small muted"><Icon name="check" size={14} /> Files are moved (or copied and checked when the NAS is another drive). Only after that does the download go to the Trash. Jellyfin is asked to look at just those folders.</div>
        </>
      )}
      {editRow && ctx && (
        <FixPanel row={editRow} ctx={ctx} onClose={() => setEditing(null)} onUse={(next) => { update(editRow.item.key, next); if (next.state === "ready") setPicked((s) => new Set(s).add(editRow.item.key)); setEditing(null); }} />
      )}
    </div>
  );
}

function InboxRowView({ r, picked, onPick, onEdit, onRemove, onPlaceOne, busy, onChoose }: { r: Row; onChoose: (c: SearchResult) => void; picked: boolean; onPick: (on: boolean) => void; onEdit: () => void; onRemove: () => void; onPlaceOne: () => void; busy: boolean }) {
  const moving = r.plan?.moves.filter((m) => !m.have) ?? [];
  const first = moving.find((m) => /\.[a-z0-9]{2,4}$/i.test(m.to))?.to ?? r.plan?.folder ?? "";
  const dest = r.state === "have" ? r.plan?.folder ?? "" : moving.length > 1 ? `${r.plan?.folder}/ (${moving.length} files)` : first;
  const what = r.target ? `${r.target.title}${r.target.year ? ` (${r.target.year})` : ""}` : r.item.title || r.item.key;
  return (
    <div className={`inbox-row ${r.state}`}>
      <input type="checkbox" aria-label={`Select ${r.item.key}`} disabled={r.state !== "ready" || busy} checked={picked && r.state === "ready"} onChange={(e) => onPick(e.target.checked)} />
      <div className="inbox-found">
        <span className="strong ellipsis">{what}</span>
        <span className="mono small muted ellipsis" title={r.item.key}>{r.item.key} · {gb(r.item.size)}</span>
      </div>
      <div className="inbox-dest">
        {r.state === "checking" ? <span className="muted small"><span className="spinner small-spin" /> Recognising…</span> : <>
          <span className="mono small accent ellipsis" title={dest}>{dest || "—"}</span>
          <span className="small muted ellipsis">{r.result ?? r.why}</span>
          {r.state === "look" && !!r.pics?.length && (
            <div className="inbox-pics">
              {r.pics.map((c, i) => (
                <button key={i} className="inbox-pic" title={`${c.Name}${c.ProductionYear ? ` (${c.ProductionYear})` : ""}: use this`} onClick={() => onChoose(c)}>
                  {c.ImageUrl ? <img src={remoteImageUrl(c.ImageUrl)} alt="" loading="lazy" /> : <span className="noart">{c.Name}</span>}
                  <span className="small ellipsis">{c.Name}{c.ProductionYear ? ` (${c.ProductionYear})` : ""}</span>
                </button>
              ))}
            </div>
          )}
        </>}
      </div>
      <span className={`inbox-state ${r.state}`}>{STATE_LABEL[r.state]}</span>
      <div className="inbox-act">
        {r.state === "have" && <button className="link small" onClick={onRemove}>Remove download</button>}
        {(r.state === "ready" || r.state === "look" || r.state === "failed") && <button className="link small" onClick={onEdit}>{r.state === "look" ? "Fix" : "Change"}</button>}
        {r.state === "ready" && <button className="link small" disabled={busy} onClick={onPlaceOne}>Put in place</button>}
        {r.state === "done" && r.plan?.folder && <button className="link small" onClick={() => void api.revealRel(r.plan!.folder)}>Open folder</button>}
        {r.state === "done" && r.target?.itemId && <button className="link small" onClick={() => nav.open(r.target!.itemId!)}>Open</button>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fix by hand */

function FixPanel({ row, ctx, onClose, onUse }: { row: Row; ctx: Ctx; onClose: () => void; onUse: (r: Partial<Row>) => void }) {
  const it = row.item;
  const [t, setT] = useState<InboxTarget>(row.target ?? { kind: it.kind, itemId: null, top: defaultTop(it.kind, ctx), title: it.title, year: it.year, season: null, artist: it.music?.artist ?? null, album: it.music?.album ?? null });
  const [ids, setIds] = useState<Record<string, string>>(row.ids);
  const [q, setQ] = useState(t.title);
  const [online, setOnline] = useState<SearchResult[] | null>(null);
  const [plan, setPlan] = useState<InboxPlan | null>(row.plan);
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);
  const noSeason = it.files.some((f) => f.video && f.season == null);
  const lib = useMemo(() => (t.kind === "tv" ? libraryMatches(ctx.shows, q, null) : t.kind === "movie" ? libraryMatches(ctx.movies, q, null) : []), [t.kind, q, ctx]);

  useEffect(() => {
    if (t.kind !== "tv" && t.kind !== "movie") return setOnline([]);
    setOnline(null);
    const h = setTimeout(() => void api.identifySearch(t.kind === "tv" ? "series" : "movie", q, null, {}).then((r) => setOnline(r.slice(0, 6))).catch(() => setOnline([])), 400);
    return () => clearTimeout(h);
  }, [q, t.kind]);
  useEffect(() => {
    setError(null);
    const h = setTimeout(() => void api.inboxResolve(it.key, t).then(setPlan).catch((e) => { setPlan(null); setError(errorText(e)); }), 250);
    return () => clearTimeout(h);
  }, [t, it.key]);

  const set = (p: Partial<InboxTarget>) => setT((x) => ({ ...x, ...p }));
  const moving = plan?.moves.filter((m) => !m.have) ?? [];
  const haveAll = !!plan && plan.moves.length > 0 && moving.length === 0;
  function use() {
    if (!plan) return;
    if (remember && t.kind === "tv" && !t.itemId) setPrefs((p) => ({ inboxShowTop: { ...p.inboxShowTop, [norm(t.title)]: t.top } }));
    if (!t.itemId) setPrefs((p) => ({ inboxTop: { ...p.inboxTop, [t.kind]: t.top } }));
    onUse({ target: t, plan, ids, state: haveAll ? "have" : "ready", why: t.itemId ? "Adds to what you have" : `Your choice: ${t.kind === "tv" ? "show" : t.kind}` });
  }
  return (
    <div className="overlay" onClick={onClose}>
      <aside className="inbox-panel" aria-label="Change what this is" onClick={(e) => e.stopPropagation()}>
        <div className="row between">
          <div className="stack-xs">
            <span className="muted small upper">Change what this is</span>
            <b className="big ellipsis">{it.key}</b>
            <span className="mono small muted">{it.files.filter((f) => f.video).length} video{it.files.filter((f) => f.video).length === 1 ? "" : "s"} · {it.files.length} files · {gb(it.size)}</span>
          </div>
          <IconBtn icon="x" title="Close" onClick={onClose} />
        </div>

        <div className="stack-s">
          <span className="small strong">It's a</span>
          <Seg value={t.kind} onChange={(k) => { set({ kind: k, itemId: null, top: defaultTop(k, ctx) }); }} options={[{ id: "tv", label: "Show" }, { id: "movie", label: "Movie" }, { id: "music", label: "Music" }, { id: "other", label: "Other (YouTube…)" }]} />
        </div>

        {(t.kind === "tv" || t.kind === "movie") && (
          <div className="stack-s">
            <span className="small strong">Which {t.kind === "tv" ? "show" : "movie"}</span>
            <SearchBox value={q} onChange={setQ} placeholder="Search a title" />
            <div className="inbox-choices">
              {lib.map(({ row: l }) => (
                <button key={l.id} className={`inbox-choice ${t.itemId === l.id ? "on" : ""}`} onClick={() => { set({ itemId: l.id, title: l.name, year: l.year, top: l.libraryFolder }); setIds({}); }}>
                  <b>{l.name}{l.year ? ` (${l.year})` : ""}</b>
                  <span className="small muted">In your library · {l.libraryFolder}</span>
                </button>
              ))}
              {online === null && <span className="muted small"><span className="spinner small-spin" /> Searching…</span>}
              {online?.map((o, i) => (
                <button key={`${o.Name}-${i}`} className={`inbox-choice ${!t.itemId && t.title === o.Name && t.year === (o.ProductionYear ?? null) ? "on" : ""}`} onClick={() => { set({ itemId: null, title: o.Name ?? q, year: o.ProductionYear ?? null }); setIds(o.ProviderIds ?? {}); }}>
                  {o.ImageUrl ? <img className="inbox-choice-pic" src={remoteImageUrl(o.ImageUrl)} alt="" loading="lazy" /> : <span className="inbox-choice-pic" />}
                  <span className="inbox-choice-text">
                    <b>{o.Name}{o.ProductionYear ? ` (${o.ProductionYear})` : ""}</b>
                    <span className="small muted">New · {o.SearchProviderName ?? "online"}{o.Overview ? ` · ${o.Overview.slice(0, 90)}…` : ""}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {t.kind === "music" && (
          <div className="fields2">
            <label>Album artist<input value={t.artist ?? ""} onChange={(e) => set({ artist: e.target.value })} /></label>
            <label>Album<input value={t.album ?? ""} onChange={(e) => set({ album: e.target.value, title: e.target.value })} /></label>
            <label>Year<input value={t.year ?? ""} inputMode="numeric" onChange={(e) => set({ year: e.target.value ? Number(e.target.value) || null : null })} /></label>
          </div>
        )}
        {t.kind === "other" && (
          <label>Folder name<input value={t.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. the channel's name" /></label>
        )}

        <div className="fields2">
          {!t.itemId && (
            <label>Main folder
              <select value={t.top} onChange={(e) => set({ top: e.target.value })}>
                {ctx.tops.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </label>
          )}
          {t.kind === "tv" && noSeason && (
            <label>Season for files without one
              <input value={t.season ?? ""} inputMode="numeric" placeholder="none: straight in the show folder" onChange={(e) => set({ season: e.target.value === "" ? null : Number(e.target.value) })} />
            </label>
          )}
        </div>

        <div className="inbox-preview">
          <span className="small muted">Goes to</span>
          {error && <span className="error small">{error}</span>}
          {!plan && !error && <span className="muted small"><span className="spinner small-spin" /> Working it out…</span>}
          {plan && (
            <div className="inbox-moves">
              {plan.moves.slice(0, 8).map((m) => (
                <div key={m.from} className={`mono small ${m.have ? "muted" : "accent"}`}>{m.to}{m.have ? "  · already there, skipped" : ""}</div>
              ))}
              {plan.moves.length > 8 && <div className="muted small">… and {plan.moves.length - 8} more</div>}
            </div>
          )}
          {plan && (t.kind === "tv" || t.kind === "movie") && <span className="muted small">Only the video and subtitles in your languages go; samples, .nfo and other files go to the Trash with the download. Episode titles are added afterwards when they're 100% sure.</span>}
        </div>

        <div className="spacer" />
        <div className="row">
          {t.kind === "tv" && !t.itemId && <label className="check small grow"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />Remember: {t.title || "this show"} goes to {t.top}</label>}
          <span className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!plan} onClick={use}>Use this</button>
        </div>
      </aside>
    </div>
  );
}
