// The Inbox: new downloads in your downloads folder. Each one is recognised (episodes of a
// show you have, a new show, a movie, an album, something else), gets its place and name, and
// what you already have is skipped. Nothing moves until you press "Put … in place": then the
// files go to the NAS (checked), get the right names, Jellyfin looks at the folder, and the
// download goes to the Trash.
import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, errorText, imageUrl, remoteImageUrl, HealthRow, InboxItem, InboxMove, InboxPlan, InboxTarget, InboxUpgrade, scanAround, SearchResult, Status, stripEditions } from "./api";
import { track, useEpoch } from "./activity";
import { askConfirm } from "./confirm";
import { IconBtn, PageHead, SearchBox, Seg } from "./kit";
import { Icon } from "./ui";
import { nav } from "./nav";
import { queueSubtitles } from "./subwait";
import { prefs, setPrefs, usePrefs } from "./prefs";

type State = "checking" | "ready" | "look" | "offline" | "have" | "placing" | "done" | "failed";

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
  /** A poster for the card (online match). */
  art?: string | null;
  /** Look up English subtitles after uploading (ticked when the download has none). */
  look?: boolean;
  /** The videos you already have, and how they compare to the download (null = being checked). */
  upgrades?: InboxUpgrade[] | null;
  /** Replace the copies you have with the better ones from the download. */
  replace?: boolean;
}

const VIDEO = /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i;
const better = (r: Row) => (r.upgrades ?? []).filter((u) => u.better);
const stemOf = (p: string) => p.replace(/\.[^./]+$/, "");

/** The moves to make: with "replace" on, the better videos (and their subtitles) go in too. */
function movesFor(r: Row): InboxMove[] {
  const moves = r.plan?.moves ?? [];
  if (!r.replace) return moves;
  const up = new Set(better(r).map((u) => u.from));
  const stems = moves.filter((m) => up.has(m.from)).map((m) => stemOf(m.to) + ".");
  return moves.map((m) => (m.have && (up.has(m.from) || (!VIDEO.test(m.to) && stems.some((st) => m.to.startsWith(st)))) ? { ...m, have: false } : m));
}

/* ------------------------------------------------------------------ matching */

const norm = (s: string) => stripEditions(s).toLowerCase().replace(/\(\d{4}\)/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "").replace(/^the/, "");
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
  if (kind === "pack") kind = "movie";
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
  } else if (item.kind === "pack") {
    row = { ...base, state: "ready", target: t({ kind: "pack", year: null }), why: "Several movies in one download" };
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
        row = { ...base, state: noSeason ? "look" : "ready", ids: best.ProviderIds ?? {}, target: t({ title: best.Name ?? item.title, year: best.ProductionYear ?? item.year, top: remembered ?? defaultTop("tv", ctx) }), art: best.ImageUrl ?? null, why: noSeason ? "New show; some files have no season or episode number" : `New show (${best.SearchProviderName ?? "online"} match)` };
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
        ? { ...base, state: "ready", ids: best.ProviderIds ?? {}, art: best.ImageUrl ?? null, target: t({ title: best.Name ?? item.title, year: best.ProductionYear ?? item.year }), why: "New movie" }
        : { ...base, pics: (sure.length ? sure : found).slice(0, 4), target: t({}), ids: best?.ProviderIds ?? {}, why: sure.length > 1 ? `${sure.length} movies with this name: pick the right one` : "No sure match online: pick the movie" };
    }
  }
  if (row.target) {
    try {
      row.plan = await api.inboxResolve(item.key, { ...row.target, tmdb: row.ids?.Tmdb ?? null });
      row.look = defaultLook(row.target.kind, row.plan);
      const vids = row.plan.moves.filter((m) => /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg|flac|mp3|m4a|ogg|opus|wav|aac|alac|aiff|aif)$/i.test(m.from));
      if (vids.length && vids.every((m) => m.have)) {
        row.state = "have";
        row.why = row.plan.existing ? "Already in your library" : "Already there";
      } else if (vids.some((m) => m.have) && row.state === "ready") {
        row.why += ` · ${vids.filter((m) => m.have).length} already there (skipped)`;
      }
    } catch (e) {
      row.why = errorText(e);
      // The NAS isn't there: not something to fix here; it's looked at again once it's back.
      row.state = /isn't reachable|NAS/i.test(row.why) ? "offline" : "look";
    }
  }
  return row;
}

/** The Inbox as you left it, so opening it again shows it at once instead of checking it all again. */
let KEPT: { dir: string | null; rows: Row[]; ctx: Ctx | null; picked: string[]; done: Row[] } | null = null;

/** What's being placed, for the activity list: "Twin Peaks S02", "Twin Peaks S01–S03", "3 movies". */
function placeLabel(t: InboxTarget, p: InboxPlan | null): string {
  if (t.kind === "pack") {
    const n = p?.movies.filter(([, , isNew]) => isNew).length ?? 0;
    return `${t.title}${n ? ` (${n} movie${n === 1 ? "" : "s"})` : ""}`;
  }
  if (t.kind !== "tv") return t.title;
  const seasons = [...new Set((p?.moves ?? []).filter((m) => !m.have).map((m) => m.to.match(/S(\d{2,3})E\d/i)?.[1]).filter((x): x is string => !!x).map(Number))].sort((a, b) => a - b);
  if (!seasons.length) return t.title;
  const s2 = (n: number) => `S${String(n).padStart(2, "0")}`;
  const run = seasons.length > 1 && seasons[seasons.length - 1] - seasons[0] === seasons.length - 1;
  return `${t.title} ${seasons.length === 1 ? s2(seasons[0]) : run ? `${s2(seasons[0])}–${s2(seasons[seasons.length - 1])}` : seasons.map(s2).join(", ")}`;
}

/** The download brings an English subtitle along. */
/** A subtitle that comes along with a video: an English one, or one named just like its video
 * ("Heat (1995).srt", no language in the name; that's the one made for it). Forced-only ones don't count. */
function englishSubs(p: InboxPlan | null): string[] {
  const moves = p?.moves ?? [];
  const stems = new Set(moves.filter((m) => /\.(mkv|mp4|m4v|avi|mov|wmv|ts|m2ts|webm|mpg|mpeg)$/i.test(m.to)).map((m) => m.to.replace(/\.[^./]+$/, "").toLowerCase()));
  return moves.map((m) => m.to).filter((to) => {
    if (!/\.(srt|ass|ssa|vtt|sub|sup)$/i.test(to)) return false;
    let st = to.replace(/\.[^./]+$/, "");
    if (/\.forced$/i.test(st)) return false;
    st = st.replace(/\.sdh$/i, "");
    return /\.(eng|en)$/i.test(st) || stems.has(st.toLowerCase());
  });
}
const hasEnglish = (p: InboxPlan | null) => englishSubs(p).length > 0;
/** Subtitle lookup after placing: on for a movie without English ones, off for shows (you tick it). */
const defaultLook = (kind: string, p: InboxPlan | null) => (kind === "movie" && !hasEnglish(p)) || (kind === "pack" && newWithoutEnglish(p).length > 0);
/** The new movies of a pack that bring no English subtitle along. */
const newWithoutEnglish = (p: InboxPlan | null) =>
  (p?.movies ?? []).filter(([dir, , isNew]) => isNew && !englishSubs(p).some((to) => to.startsWith(`${dir}/`)));
const SUB_EXT = /\.(srt|ass|ssa|vtt|sub|idx|sup)$/i;
const IMG_EXT = /\.(jpe?g|png|gif|webp|bmp|tbn)$/i;
/** "Sample/sample.mkv, 6 other-language subtitles, RARBG.txt, poster.jpg, .nfo" */
function trashText(left: string[]): string {
  if (!left.length) return "nothing";
  const name = (f: string) => f.split("/").pop() ?? f;
  const subs = left.filter((f) => SUB_EXT.test(f));
  const imgs = left.filter((f) => IMG_EXT.test(f));
  const nfo = left.filter((f) => /\.nfo$/i.test(f));
  const rest = left.filter((f) => !subs.includes(f) && !imgs.includes(f) && !nfo.includes(f));
  const parts = [
    ...rest.slice(0, 3).map(name), rest.length > 3 ? `${rest.length - 3} more files` : "",
    subs.length ? `${subs.length} other-language subtitle${subs.length === 1 ? "" : "s"}` : "",
    imgs.length === 1 ? name(imgs[0]) : imgs.length ? `${imgs.length} pictures` : "",
    nfo.length ? ".nfo" : "",
  ].filter(Boolean);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ the page */

const STATE_LABEL: Record<State, string> = { checking: "Looking…", ready: "Ready", look: "Needs a look", offline: "NAS not connected", have: "Duplicate", placing: "Uploading…", done: "Done", failed: "Didn't work" };
const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

export default function Inbox({ status }: { status: Status }) {
  const epoch = useEpoch();
  usePrefs();
  const [dir, setDir] = useState<string | null>(KEPT?.dir ?? null);
  const [rows, setRows] = useState<Row[] | null>(KEPT?.rows ?? null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | State>("all");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set(KEPT?.picked ?? []));
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState<Ctx | null>(KEPT?.ctx ?? null);
  const [n, setN] = useState(0);
  const [again, setAgain] = useState(0);
  const doneRows = useRef<Row[]>(KEPT?.done ?? []);
  const rowsRef = useRef<Row[] | null>(null);
  rowsRef.current = rows;
  const firstRun = useRef(true);

  // Keep what's on screen for the next time the Inbox is opened.
  useEffect(() => {
    if (rows) KEPT = { dir, rows, ctx, picked: [...picked], done: doneRows.current };
  }, [dir, rows, ctx, picked]);

  // Opening the Inbox: what was already checked stays; only new downloads are checked (and
  // the ones that waited for the NAS). Refresh checks everything again.
  useEffect(() => {
    let alive = true;
    const full = n > 0 || !KEPT;
    const quiet = firstRun.current && !!KEPT;
    firstRun.current = false;
    setError(null);
    (async () => {
      const [[d, items], h, tops] = await Promise.all([
        api.inboxScan(),
        full || !ctx ? api.libraryHealth(false).catch(() => ({ at: 0, rows: [] as HealthRow[] })) : Promise.resolve(null),
        full || !ctx ? api.folders("").then((f) => f.map((x) => x.name)).catch(() => [] as string[]) : Promise.resolve(null),
      ]);
      if (!alive) return;
      setDir(d);
      const c: Ctx = h && tops ? { shows: h.rows.filter((r) => r.kind === "series"), movies: h.rows.filter((r) => r.kind === "movie"), tops } : ctx!;
      setCtx(c);
      const before = new Map((rowsRef.current ?? []).map((r) => [r.item.key, r]));
      const same = (a: InboxItem, b: InboxItem) => a.size === b.size && a.modified === b.modified;
      const keep = (it: InboxItem) => {
        const old = before.get(it.key);
        return !full && old && same(old.item, it) && old.state !== "offline" && old.state !== "checking" ? old : null;
      };
      const todo = items.filter((it) => !keep(it));
      if (quiet && !todo.length && items.length === before.size) return;
      setRows(items.map((item) => keep(item) ?? { item, target: null, plan: null, state: "checking", why: "", ids: {} }));
      // Three at a time, each row filling in as it's done.
      let k = 0;
      const out: Row[] = [];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (k < todo.length && alive) {
          const i = k++;
          // Never stuck on "Looking…": after 90 seconds it says so and you can try again.
          const slow = new Promise<Row>((ok) => window.setTimeout(() => ok({ item: todo[i], target: null, plan: null, state: "look", why: "Took too long to check (the NAS or Jellyfin is slow right now): press Refresh, or Fix to choose yourself", ids: {} }), 90_000));
          out[i] = await Promise.race([detect(todo[i], c), slow]).catch((e) => ({ item: todo[i], target: null, plan: null, state: "look" as State, why: errorText(e), ids: {} }));
          if (alive) setRows((rs) => rs?.map((r) => (r.item.key === todo[i].key ? out[i] : r)) ?? null);
        }
      }));
      if (alive) setPicked((p) => {
        const next = full ? new Set<string>() : new Set([...p].filter((key) => items.some((it) => it.key === key)));
        out.filter((r) => r?.state === "ready").forEach((r) => next.add(r.item.key));
        return next;
      });
    })().catch((e) => alive && setError(errorText(e)));
    return () => { alive = false; };
  }, [n, epoch, again]); // eslint-disable-line react-hooks/exhaustive-deps

  // Downloads waiting for the NAS: looked at again every 20 seconds until it's back.
  const waiting = (rows ?? []).some((r) => r.state === "offline");
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => void api.libraryReachable().then((ok) => ok && setAgain((x) => x + 1)).catch(() => undefined), 20_000);
    return () => window.clearInterval(t);
  }, [waiting]);

  const all = [...(rows ?? []), ...doneRows.current.filter((d) => !(rows ?? []).some((r) => r.item.key === d.item.key))];
  const count = (s: State) => all.filter((r) => r.state === s).length;
  const q = query.trim().toLowerCase();
  const shown = all.filter((r) => (filter === "all" || r.state === filter) && (!q || r.item.key.toLowerCase().includes(q) || (r.target?.title ?? "").toLowerCase().includes(q)));
  const ready = all.filter((r) => r.state === "ready" && picked.has(r.item.key));
  const update = (key: string, p: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.item.key === key ? { ...r, ...p } : r)) ?? null);

  // Downloads with videos you already have: compare the quality (one at a time, it reads the NAS).
  useEffect(() => {
    const next = rows?.find((r) => r.upgrades === undefined && r.plan && (r.state === "have" || r.state === "ready") && r.plan.moves.some((m) => m.have && VIDEO.test(m.from)));
    if (!next || !next.plan) return;
    update(next.item.key, { upgrades: null });
    api.inboxCompare(next.item.key, next.plan.moves, next.target?.kind === "tv")
      .then((u) => update(next.item.key, { upgrades: u }))
      .catch(() => update(next.item.key, { upgrades: [] }));
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps

  async function place(list: Row[]) {
    if (!list.length) return;
    const files = list.reduce((a, r) => a + movesFor(r).filter((m) => !m.have).length, 0);
    const replacing = list.reduce((a, r) => a + (r.replace ? better(r).length : 0), 0);
    const swap = replacing ? `\n\n${replacing} cop${replacing === 1 ? "y" : "ies"} you have in lower quality move${replacing === 1 ? "s" : ""} to the hidden trash folder on the NAS first (with ${replacing === 1 ? "its" : "their"} subtitles). You can put ${replacing === 1 ? "it" : "them"} back from History.` : "";
    if (!(await askConfirm(`Upload ${list.length} download${list.length === 1 ? "" : "s"} (${files} file${files === 1 ? "" : "s"})?\n\nThey go to the NAS with the right names. Once a file has arrived and its size checks out, the download goes to the Trash (you can put it back from there). ${replacing ? "Anything else" : "Anything"} already in your library is skipped.${swap}`, { okLabel: replacing ? "Replace and upload" : "Upload" }))) return;
    setBusy(true);
    const args = (await import("./Renamer")).namingArgs();
    for (const r of list) {
      if (!r.plan || !r.target) continue;
      update(r.item.key, { state: "placing" });
      try {
        await track(`Uploading ${placeLabel(r.target, r.plan)}`, async (job) => {
          const un = await listen<{ key: string; done: number; total: number; file: string; fileDone: number; fileSize: number; n: number; of: number }>("inbox-progress", (e) => {
            const x = e.payload;
            if (x.key !== r.item.key) return;
            const name = x.file ? x.file.split("/").pop() ?? "" : "Checking";
            const count = x.of > 0 ? `${x.n}/${x.of} · ` : "";
            const pct = x.fileSize > 0 && x.file ? ` · ${Math.min(100, Math.floor((x.fileDone / x.fileSize) * 100))}%` : "";
            job.update(`${count}${name}${pct}`, x.total ? (x.done / x.total) * 0.8 : null);
          });
          let res;
          const moves = movesFor(r);
          if (r.replace && better(r).length) {
            job.update("Moving the lower-quality copies to the trash folder", 0);
            await api.inboxReplaceOld(better(r).map((u) => u.old), r.target!.itemId ?? null);
          }
          try {
            res = await api.inboxPlace(r.item.key, moves);
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
          job.update("Asking Jellyfin to look", 0.9);
          await scanAround([...new Set(res.placed.map((p) => p.split("/").slice(0, -1).join("/")))]);
          // Once Jellyfin has the title: English subtitles (when ticked) and its collection.
          let subMsg = "";
          const cur = rowsRef.current?.find((x) => x.item.key === r.item.key) ?? r;
          const wantSubs = !!cur.look && res.placed.length > 0;
          const coll = r.plan?.collection?.id ? r.plan.collection : null;
          // English subtitles: kept on a list and looked up the moment Jellyfin shows the title,
          // so nothing here waits for Jellyfin.
          if (wantSubs) {
            const k = r.target!.kind;
            if (k === "pack") {
              const list = newWithoutEnglish(r.plan).map(([folder, title]) => ({ folder, kind: "movie" as const, title, at: Date.now() }));
              queueSubtitles(list);
              if (list.length) subMsg += ` · English subtitles for ${list.length} movie${list.length === 1 ? "" : "s"} come as soon as Jellyfin shows ${list.length === 1 ? "it" : "them"}`;
            } else if (k === "tv" || k === "movie") {
              queueSubtitles([{ folder: r.plan!.folder, kind: k, title: r.target!.title, at: Date.now(), id: r.target!.itemId ?? null }]);
              subMsg += " · English subtitles come as soon as Jellyfin shows it";
            }
          }
          if (r.target!.kind === "pack" && r.plan?.collection && res.placed.length) {
            // Every movie of the pack into the collection (made when it doesn't exist yet).
            const ids: string[] = [];
            for (const [i, [folder, title]] of r.plan.movies.entries()) {
              let id: string | null = null;
              for (let n = 0; !id && n < 10 && !job.cancelled; n++) {
                job.update(`Waiting for Jellyfin to add ${title}`, 0.9 + (0.08 * i) / Math.max(1, r.plan.movies.length));
                id = await api.inboxFindItem(folder, "movie", title).catch(() => null);
                if (!id) await new Promise((ok) => setTimeout(ok, 6000));
              }
              if (id) ids.push(id);
            }
            const c = r.plan.collection;
            if (ids.length) {
              const ok = c.id
                ? await api.collectionAdd(c.id, ids).then(() => true).catch(() => false)
                : await api.collectionCreate(c.name, ids).then(() => true).catch(() => false);
              subMsg += ok ? ` · ${c.id ? "added to" : "made the collection"} “${c.name}”` : ` · couldn't update “${c.name}” in Jellyfin`;
            } else subMsg += ` · Jellyfin hasn't added them yet: make “${c.name}” later`;
          } else if (coll && res.placed.length) {
            let id = r.target!.itemId ?? null;
            for (let i = 0; !id && i < 20 && !job.cancelled; i++) {
              job.update("Waiting for Jellyfin to add it", 0.92);
              await new Promise((ok) => setTimeout(ok, 6000));
              id = await api.inboxFindItem(r.plan!.folder, r.target!.kind, r.target!.title).catch(() => null);
            }
            if (id) {
              job.update(`Adding it to “${coll.name}”`, 0.93);
              const ok = await api.collectionAdd(coll.id!, [id]).then(() => true).catch(() => false);
              subMsg += ok ? ` · added to “${coll.name}”` : ` · couldn't add it to “${coll.name}”`;
            } else subMsg += ` · Jellyfin hasn't added it yet: add it to “${coll.name}” later`;
          }
          const msg = `${res.placed.length} uploaded${res.skipped ? ` · ${res.skipped} already there` : ""}${res.trashed ? " · download in the Trash" : ""}${subMsg}`;
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
      const plan = await api.inboxResolve(r.item.key, { ...target, tmdb: c.ProviderIds?.Tmdb ?? null });
      update(r.item.key, { target, plan, ids: c.ProviderIds ?? {}, art: c.ImageUrl ?? null, look: defaultLook(target.kind, plan), state: "ready", why: `Your choice: ${c.Name}${c.ProductionYear ? ` (${c.ProductionYear})` : ""}` });
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
    { id: "offline", label: "NAS not connected", n: count("offline"), tone: "warn" },
    { id: "have", label: "Duplicates", n: count("have"), tone: "" },
    { id: "done", label: "Done", n: count("done"), tone: "" },
  ];

  return (
    <div className="pg inbox">
      <PageHead
        title="Inbox"
        sub={dir ? `Watching ${dir} · nothing moves until you press the button` : "New downloads, recognised and named for you. Nothing moves until you say so."}
        actions={<>
          <button className="inbox-dir" onClick={() => void api.inboxPick().then((d) => d && setN((x) => x + 1))} title="Choose another downloads folder">
            <Icon name="folder" size={14} /> {dir ? <span className="mono ellipsis">{dir}</span> : "Choose your downloads folder"}
          </button>
          {dir && <IconBtn icon="external" title="Open the downloads folder" onClick={() => void api.inboxReveal().catch((e) => setError(errorText(e)))} />}
          <button onClick={() => setN((x) => x + 1)}><Icon name="reload" /> Refresh</button>
          <button className="primary" disabled={busy || !ready.length || status.readOnly} onClick={() => void place(ready)}>
            {busy ? <span className="spinner" /> : <Icon name="check" />} Upload {ready.length || ""}
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
          <div className="ibx-list">
            {!rows && <div className="pg-loading"><span className="spinner" /> Looking in the downloads folder…</div>}
            {rows && shown.length === 0 && <p className="muted pad">{all.length ? "Nothing here." : "The downloads folder is empty."}</p>}
            {shown.map((r) => <InboxRowView key={r.item.key} r={r} onChoose={(c) => void choose(r, c)} picked={picked.has(r.item.key)} onPick={(on) => setPicked((s) => { const x = new Set(s); if (on) x.add(r.item.key); else x.delete(r.item.key); return x; })} onEdit={() => setEditing(r.item.key)} onRemove={() => void removeDownload(r)} onPlaceOne={() => void place([r])} busy={busy} onLook={(on) => update(r.item.key, { look: on })} onReplace={(on, now) => { update(r.item.key, { replace: on }); if (now) void place([{ ...r, replace: true }]); }} />)}
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

function InboxRowView({ r, picked, onPick, onEdit, onRemove, onPlaceOne, busy, onChoose, onLook, onReplace }: { r: Row; onChoose: (c: SearchResult) => void; picked: boolean; onPick: (on: boolean) => void; onEdit: () => void; onRemove: () => void; onPlaceOne: () => void; busy: boolean; onLook: (on: boolean) => void; onReplace: (on: boolean, now: boolean) => void }) {
  const ups = r.upgrades ?? [];
  const better = ups.filter((u) => u.better);
  const one = ups.length === 1 ? ups[0] : null;
  const onNas = (r.state === "have" || r.state === "done") && !!r.plan?.folder;
  const moving = r.plan?.moves.filter((m) => !m.have) ?? [];
  const firstVideo = moving.find((m) => !SUB_EXT.test(m.to))?.to ?? moving[0]?.to;
  const dest = r.state === "have" ? r.plan?.folder ?? "" : moving.length > 2 ? `${r.plan?.folder}/ (${moving.length} files)` : firstVideo ?? r.plan?.folder ?? "";
  const what = r.target ? `${r.target.title}${r.target.year ? ` (${r.target.year})` : ""}` : r.item.title || r.item.key;
  const packCount = r.target?.kind === "pack" ? r.plan?.movies.length ?? 0 : 0;
  const label = r.state === "ready" ? (packCount ? `${packCount} movies` : r.plan?.existing ? "Into your existing folder" : "New folder") : STATE_LABEL[r.state];
  const tone = r.state === "ready" ? (r.plan?.existing ? "ok" : "new") : r.state === "look" || r.state === "offline" || r.state === "failed" ? "warn" : r.state === "done" ? "ok" : "";
  const poster = r.target?.itemId ? imageUrl(r.target.itemId, "Primary", 160) : r.art ? remoteImageUrl(r.art) : null;
  const keeps = moving.map((m) => m.to.split("/").pop() ?? m.to);
  const media = r.target?.kind === "tv" || r.target?.kind === "movie" || r.target?.kind === "pack";
  return (
    <div className={`ibx-card s-${r.state} t-${tone}`}>
      <input type="checkbox" aria-label={`Select ${r.item.key}`} disabled={r.state !== "ready" || busy} checked={picked && r.state === "ready"} onChange={(e) => onPick(e.target.checked)} />
      <div className="ibx-poster">{poster ? <img src={poster} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <span>{(r.target?.title ?? r.item.title ?? "?").slice(0, 1)}</span>}</div>
      <div className="ibx-body">
        <div className="ibx-head">
          <b className="ellipsis">{what}</b>
          <span className={`ibx-state t-${tone}`}>{r.state === "checking" ? <><span className="spinner small-spin" /> Looking…</> : label}</span>
          <span className="spacer" />
          {r.state === "have" && better.length > 0 && <button className="link small strong" disabled={busy} onClick={() => onReplace(true, true)}>Replace{better.length > 1 ? ` (${better.length})` : ""}</button>}
          {r.state === "have" && <button className="link small" onClick={onRemove}>Remove download</button>}
          {onNas && <IconBtn icon="folder" size={14} title="Show the folder on the NAS" onClick={() => void api.revealRel(r.plan!.folder)} />}
          {(r.state === "ready" || r.state === "look" || r.state === "failed") && <button className="link small" onClick={onEdit}>{r.state === "look" ? "Fix" : "Change"}</button>}
          {r.state === "ready" && <button className="link small" disabled={busy} onClick={onPlaceOne}>Upload</button>}
          {r.state === "done" && r.target?.itemId && <button className="link small" onClick={() => nav.open(r.target!.itemId!)}>Open</button>}
        </div>
        <span className="mono small muted ellipsis" title={r.item.key}>{r.item.key} · {gb(r.item.size)}</span>
        {r.state !== "checking" && dest && <span className="ibx-dest mono ellipsis" title={dest}>→ {dest}</span>}
        {r.state === "have" && r.upgrades === null && <span className="small muted"><span className="spinner small-spin" /> Comparing the quality with yours…</span>}
        {r.state === "have" && one && <span className={`small ${one.better ? "ok" : "muted"}`}>Yours: {one.oldQuality} · This download: {one.newQuality}{one.better ? " · better" : ""}</span>}
        {r.state === "have" && ups.length > 1 && <span className={`small ${better.length ? "ok" : "muted"}`}>{better.length ? `${better.length} of ${ups.length} are better than yours (${better[0].oldQuality} → ${better[0].newQuality})` : `Not better than yours (${ups[0].oldQuality})`}</span>}
        {r.plan && media && r.state !== "done" && r.state !== "have" && (
          <div className="ibx-grid">
            <span className="ibx-k good">Keeps</span><span className="ibx-v">{keeps.length ? keeps.slice(0, 3).join(", ") + (keeps.length > 3 ? ` and ${keeps.length - 3} more` : "") : "nothing new"}</span>
            <span className="ibx-k warn">Trash</span><span className="ibx-v muted">{trashText(r.plan.leftovers)}{r.plan.leftovers.length ? " (with the download)" : ""}</span>
            {better.length > 0 && <>
              <span className="ibx-k good">Better</span>
              <label className="check small ibx-look"><input type="checkbox" checked={!!r.replace} disabled={busy || r.state === "placing"} onChange={(e) => onReplace(e.target.checked, false)} />Replace {better.length} cop{better.length === 1 ? "y" : "ies"} you have<span className="muted"> · {better[0].oldQuality} → {better[0].newQuality}{better.length > 1 ? " …" : ""}</span></label>
            </>}
            <span className="ibx-k muted">Subtitles</span>
            <label className="check small ibx-look"><input type="checkbox" checked={!!r.look} disabled={busy || r.state === "placing"} onChange={(e) => onLook(e.target.checked)} />Look up English subtitles after uploading<span className="muted"> · {r.target?.kind === "pack" ? (newWithoutEnglish(r.plan).length ? `${newWithoutEnglish(r.plan).length} new movie${newWithoutEnglish(r.plan).length === 1 ? "" : "s"} without English` : "English is included") : hasEnglish(r.plan) ? "English is included" : "none in the download"}</span></label>
          </div>
        )}
        <span className="small muted">{r.result ?? (r.plan?.note && r.state === "ready" ? `${r.plan.note}${r.why.includes("already there") ? ` · ${r.why.split(" · ").slice(1).join(" · ")}` : ""}` : r.why)}</span>
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
    const h = setTimeout(() => void api.inboxResolve(it.key, { ...t, tmdb: ids?.Tmdb ?? null }).then(setPlan).catch((e) => { setPlan(null); setError(errorText(e)); }), 250);
    return () => clearTimeout(h);
  }, [t, it.key, ids]);

  const set = (p: Partial<InboxTarget>) => setT((x) => ({ ...x, ...p }));
  const moving = plan?.moves.filter((m) => !m.have) ?? [];
  const haveAll = !!plan && plan.moves.length > 0 && moving.length === 0;
  function use() {
    if (!plan) return;
    if (remember && t.kind === "tv" && !t.itemId) setPrefs((p) => ({ inboxShowTop: { ...p.inboxShowTop, [norm(t.title)]: t.top } }));
    if (!t.itemId) setPrefs((p) => ({ inboxTop: { ...p.inboxTop, [t.kind]: t.top } }));
    onUse({ target: t, plan, ids, look: defaultLook(t.kind, plan), state: haveAll ? "have" : "ready", why: t.itemId ? "Adds to what you have" : `Your choice: ${t.kind === "tv" ? "show" : t.kind}` });
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
          {plan && (t.kind === "tv" || t.kind === "movie") && <span className="muted small">Only the video and English subtitles go; samples, .nfo, .txt, pictures and other languages go to the Trash with the download.</span>}
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
