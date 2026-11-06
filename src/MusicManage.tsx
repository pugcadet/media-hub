// Music → Manage: like the Library for films and shows. Albums and artists with what's missing
// (cover, year, artist), fix names and numbers right there, choose pictures, and choose where
// your music comes from.
import { useEffect, useMemo, useState } from "react";
import { api, ArtOption, errorText, MusicItem, TagCheck } from "./api";
import { askConfirm } from "./confirm";
import { followEvent, track } from "./activity";
import { usePageState } from "./saved";
import { KTabs, SearchBox, Seg, StatusIcons, Toolbar, type StatusIcon } from "./kit";
import { Studio, type StudioItem } from "./Studio";
import { Icon } from "./ui";
import { Art, artSrc, artVersion, chooseMusicArt, editMusicInfo } from "./MusicEdit";
import { fmt } from "./Intros";

type MTab = "albums" | "artists" | "source";
type Check = "cover" | "year" | "artist";
const isLocal = (id: string) => /^[LAR][0-9a-f]{16}$/.test(id);
const unknownArtist = (a: string) => !a.trim() || /^(unknown artist|various( artists)?|va)$/i.test(a.trim());

const CHECKS: { id: Check; label: string; icon: "image" | "clock" | "music" }[] = [
  { id: "cover", label: "Cover", icon: "image" },
  { id: "year", label: "Year", icon: "clock" },
  { id: "artist", label: "Artist", icon: "music" },
];
const ok = (a: MusicItem, c: Check) => (c === "cover" ? a.hasArt : c === "year" ? !!a.year : !unknownArtist(a.artist));

export default function MusicManage({ onChanged, embedded }: { onChanged: () => void; embedded?: boolean }) {
  const [tab, setTab] = usePageState<MTab>("music.manage", "albums");
  const [source, setSource] = useState<{ folder: string | null; source: "jellyfin" | "folder" } | null>(null);
  const [albums, setAlbums] = useState<MusicItem[] | null>(null);
  const [artists, setArtists] = useState<MusicItem[] | null>(null);
  const [n, setN] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const reload = () => {
    setN((x) => x + 1);
    onChanged();
  };
  useEffect(() => void api.musicSource().then(setSource).catch(() => setSource(null)), [n]);
  useEffect(() => {
    setError(null);
    api.musicList("albums", null, null, 0, 5000).then(setAlbums).catch((e) => { setAlbums([]); setError(errorText(e)); });
    api.musicList("artists", null, null, 0, 5000).then(setArtists).catch(() => setArtists([]));
  }, [n]);
  const todo = (albums ?? []).filter((a) => CHECKS.some((c) => !ok(a, c.id))).length;
  return (
    <div className={embedded ? "m-manage m-embedded grow-col" : "pg studio-page m-manage"}>
      {!embedded && (
        <div className="pg-head">
          <h1>Music</h1>
          <span className="muted">{source?.source === "folder" ? `From your music folder${source.folder ? `: ${source.folder}` : ""}` : "From Jellyfin"}</span>
        </div>
      )}
      <KTabs
        tabs={[
          { id: "albums", label: "Albums", icon: "stack", count: todo || null, warn: todo > 0 },
          { id: "artists", label: "Artists", icon: "music", count: artists?.length ?? null },
          { id: "source", label: "Pictures", icon: "image" },
        ]}
        active={tab}
        onChange={(t) => setTab(t as MTab)}
      />
      {error && <p className="error">{error}</p>}
      {tab === "albums" && <AlbumsPane albums={albums} changed={reload} />}
      {tab === "artists" && <ArtistsPane artists={artists} changed={reload} />}
      {tab === "source" && <SourcePane source={source} changed={reload} />}
    </div>
  );
}

/* --------------------------------------------------------------------- albums */

function AlbumsPane({ albums, changed }: { albums: MusicItem[] | null; changed: () => void }) {
  const [query, setQuery] = useState("");
  const [only, setOnly] = usePageState<Check | "">("music.manage.only", "");
  const [filter, setFilter] = usePageState<"all" | "todo">("music.manage.filter", "all");
  const [sel, setSel] = usePageState<string | null>("music.manage.album", null);
  const list = albums ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return list.filter((a) => (!q || a.name.toLowerCase().includes(q) || a.artist.toLowerCase().includes(q))
      && (!only || !ok(a, only))
      && (filter === "all" || CHECKS.some((c) => !ok(a, c.id))));
  }, [list, query, only, filter]);
  const gaps = (c: Check) => list.filter((a) => !ok(a, c)).length;
  const status = (a: MusicItem): StatusIcon[] => CHECKS.map((c) => ({
    icon: c.icon, label: c.label, ok: ok(a, c.id),
    onClick: () => void (c.id === "cover" ? chooseMusicArt(a) : editMusicInfo(a)).then((done) => done && changed()),
  }));
  const items: StudioItem[] = shown.map((a) => ({
    id: a.id,
    title: a.name,
    sub: [a.artist, a.year, a.count ? `${a.count} songs` : null].filter(Boolean).join(" · "),
    pic: <span className="m-manage-thumb"><Art item={a} size={120} /></span>,
    status: <StatusIcons items={status(a)} />,
    warn: !a.hasArt,
  }));
  const selected = list.find((a) => a.id === sel) ?? null;
  // Like the other Library tabs: the first one is open when nothing (that still shows) is picked.
  useEffect(() => { if (shown.length && !shown.some((a) => a.id === sel)) setSel(shown[0].id); }, [shown, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="lib-filters">
        <div className="lib-checks">
          {CHECKS.map((c) => {
            const k = gaps(c.id);
            return (
              <button key={c.id} className={`lib-check ${only === c.id ? "on" : ""} ${k ? "warn" : "ok"}`} onClick={() => setOnly(only === c.id ? "" : c.id)} title={`Show only albums without ${c.label.toLowerCase()}`}>
                <Icon name={c.icon} size={14} /> {c.label} <span className="count">{k ? k : <Icon name="check" size={12} />}</span>
              </button>
            );
          })}
          {only && <button className="link small" onClick={() => setOnly("")}><Icon name="x" size={12} /> Show all</button>}
        </div>
        <Toolbar>
          <SearchBox value={query} onChange={setQuery} placeholder="Find an album or artist" />
          <Seg value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "todo", label: "Needs work" }]} />
        </Toolbar>
      </div>
      <Studio items={items} selected={sel} onSelect={setSel} empty={albums ? (only || filter === "todo" ? "Nothing missing here." : "No albums.") : <span><span className="spinner" /> Reading your music…</span>}>
        {selected && <AlbumDetail key={selected.id} album={selected} changed={changed} />}
      </Studio>
    </>
  );
}

interface Draft { name: string; artist: string; index: string; disc: string }

function AlbumDetail({ album, changed }: { album: MusicItem; changed: () => void }) {
  const [f, setF] = useState({ name: album.name, artist: album.artist, year: album.year ? String(album.year) : "" });
  const [tracks, setTracks] = useState<MusicItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    api.musicList("tracks", album.id, null, 0, 1000).then((t) => {
      setTracks(t);
      setDrafts(Object.fromEntries(t.map((x) => [x.id, { name: x.name, artist: x.artist, index: x.index ? String(x.index) : "", disc: x.disc ? String(x.disc) : "" }])));
    }).catch((e) => setError(errorText(e)));
  }, [album.id, n]);
  const num = (s: string) => (s.trim() === "" ? 0 : Number(s));
  const albumDirty = f.name !== album.name || f.artist !== album.artist || f.year !== (album.year ? String(album.year) : "");
  const changedTracks = (tracks ?? []).filter((t) => {
    const d = drafts[t.id];
    return d && (d.name !== t.name || d.artist !== t.artist || d.index !== (t.index ? String(t.index) : "") || d.disc !== (t.disc ? String(t.disc) : ""));
  });
  async function save() {
    const bad = [f.year, ...changedTracks.flatMap((t) => [drafts[t.id].index, drafts[t.id].disc])].some((x) => x.trim() !== "" && !/^\d+$/.test(x.trim()));
    if (bad) return setError("Numbers only for year, track and disc.");
    if (!f.name.trim() || changedTracks.some((t) => !drafts[t.id].name.trim())) return setError("Names can't be empty.");
    setBusy(true);
    setError(null);
    try {
      await track(`Saving “${f.name.trim()}”`, async (job) => {
        if (albumDirty) {
          if (isLocal(album.id)) await api.musicLocalEdit(album.id, { album: f.name, artist: f.artist, year: num(f.year) });
          else await api.saveMetadata(album.id, { name: f.name, albumArtist: f.artist, productionYear: f.year ? num(f.year) : null });
        }
        for (const [i, t] of changedTracks.entries()) {
          job.update(t.name, i / Math.max(1, changedTracks.length));
          const d = drafts[t.id];
          if (isLocal(t.id)) await api.musicLocalEdit(t.id, { title: d.name, artist: d.artist, index: num(d.index), disc: num(d.disc) });
          else await api.saveMetadata(t.id, { name: d.name, artists: d.artist.split(/\s*[,;]\s*/).filter(Boolean), indexNumber: d.index ? num(d.index) : null, parentIndexNumber: d.disc ? num(d.disc) : null });
        }
      }, { reload: false });
      setN((x) => x + 1);
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      await api.musicLocalReset(album.id);
      for (const t of tracks ?? []) await api.musicLocalReset(t.id).catch(() => undefined);
      setN((x) => x + 1);
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const set = (id: string, k: keyof Draft, v: string) => setDrafts((d) => ({ ...d, [id]: { ...d[id], [k]: v } }));
  const dirty = albumDirty || changedTracks.length > 0;
  return (
    <div className="m-detail">
      <div className="m-detail-head">
        <button className="m-detail-art" onClick={() => void chooseMusicArt(album).then((x) => x && changed())} title="Choose another cover">
          <Art item={album} size={400} />
          <span className="m-detail-art-btn"><Icon name="image" size={14} /> {album.hasArt ? "Change cover" : "Add a cover"}</span>
        </button>
        <div className="stack-s grow">
          <label className="field"><span>Album</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <div className="m-edit-nums">
            <label className="field grow"><span>Album artist</span><input value={f.artist} onChange={(e) => setF({ ...f, artist: e.target.value })} /></label>
            <label className="field m-year"><span>Year</span><input value={f.year} inputMode="numeric" onChange={(e) => setF({ ...f, year: e.target.value })} /></label>
          </div>
          <div className="row">
            <button className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? <span className="spinner" /> : dirty ? `Save${changedTracks.length ? ` (${changedTracks.length} song${changedTracks.length === 1 ? "" : "s"})` : ""}` : "Saved"}</button>
            {dirty && <button disabled={busy} onClick={() => { setF({ name: album.name, artist: album.artist, year: album.year ? String(album.year) : "" }); setN((x) => x + 1); }}>Cancel</button>}
            <span className="spacer" />
            {isLocal(album.id) && <button className="link small" disabled={busy} onClick={() => void reset()} title="Forget your changes to this album and its songs">Back to the files</button>}
          </div>
          <p className="muted small">{isLocal(album.id) ? "Changes here are kept by Media Hub; the files only change with “Song details” below." : "Saved in Jellyfin; History can undo it."}</p>
        </div>
      </div>
      {error && <p className="error small">{error}</p>}
      {!album.hasArt && <CoverChoices album={album} changed={changed} />}
      <SongInfo album={album} changed={() => { setN((x) => x + 1); changed(); }} />
      <div className="m-edit-tracks">
        <div className="m-et-head muted small"><span>Disc</span><span>#</span><span>Title</span><span>Artist</span><span /></div>
        {!tracks && <div className="pg-loading"><span className="spinner" /> Loading songs…</div>}
        {tracks?.map((t) => {
          const d = drafts[t.id];
          if (!d) return null;
          return (
            <div key={t.id} className={`m-et-row ${changedTracks.includes(t) ? "dirty" : ""}`}>
              <input className="m-et-num" value={d.disc} inputMode="numeric" onChange={(e) => set(t.id, "disc", e.target.value)} aria-label="Disc" />
              <input className="m-et-num" value={d.index} inputMode="numeric" onChange={(e) => set(t.id, "index", e.target.value)} aria-label="Track number" />
              <input value={d.name} onChange={(e) => set(t.id, "name", e.target.value)} aria-label="Title" />
              <input value={d.artist} onChange={(e) => set(t.id, "artist", e.target.value)} aria-label="Artist" />
              <span className="muted small mono">{t.duration ? fmt(t.duration) : ""}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A missing cover: the choices right here, from the files and online. */
function CoverChoices({ album, changed }: { album: MusicItem; changed: () => void }) {
  const [opts, setOpts] = useState<ArtOption[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.musicArtOptions("album", album.name, album.artist, isLocal(album.id) ? album.id : null).then((o) => setOpts(o.slice(0, 6))).catch(() => setOpts([]));
  }, [album.id, album.name, album.artist]);
  async function use(url: string | null) {
    setBusy(url ?? "file");
    setError(null);
    try {
      const ok = await track(`Cover for “${album.name}”`, async () => {
        if (isLocal(album.id)) return api.musicLocalSetArt(album.id, url);
        if (url) { await api.setImageFromLink(album.id, "Primary", url); return true; }
        return api.uploadImageFile(album.id, "Primary");
      }, { reload: false });
      if (ok) { artVersion.set(Date.now()); changed(); }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="m-covers">
      <div className="m-covers-head">
        <b>Cover for “{album.name}”</b>
        <span className="muted small">{opts === null ? "Looking…" : opts.length ? "Found · pick one" : "Nothing found online"}</span>
        <button className="link small" disabled={!!busy} onClick={() => void use(null)}>Use my own file…</button>
      </div>
      {error && <p className="error small">{error}</p>}
      <div className="m-covers-row">
        {opts === null && <span className="spinner" />}
        {opts?.map((o) => (
          <button key={o.url} className="m-cover-opt" disabled={!!busy} onClick={() => void use(o.url)} title={o.label}>
            <img src={artSrc(o.url)} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            {busy === o.url && <span className="m-artpick-busy"><span className="spinner" /></span>}
            <span className="small ellipsis">{o.source}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const FIELD: Record<string, string> = { title: "title", artist: "artist", albumArtist: "album artist", album: "album", track: "track", disc: "disc", year: "year", genre: "genre" };

/** Song names, artists and tags checked against MusicBrainz; you pick what to write into the files. */
function SongInfo({ album, changed }: { album: MusicItem; changed: () => void }) {
  const [check, setCheck] = useState<TagCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [off, setOff] = useState<Set<number>>(new Set());
  async function run(release: string | null = null) {
    setBusy(true);
    setError(null);
    try {
      const c = await api.musicTagsCheck(album.id, release);
      setCheck(c);
      setOff(new Set());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!check) return;
    const list = check.changes.filter((_, i) => !off.has(i));
    if (!list.length) return;
    if (!(await askConfirm(`Write ${list.length} change${list.length === 1 ? "" : "s"} into the song files of “${album.name}”?\n\nThe old values are kept: History can put them back.`, { okLabel: "Write them" }))) return;
    setBusy(true);
    try {
      const n = await track(`Song details for “${album.name}”`, () => api.musicTagsApply(album.id, list.map((c) => [c.rel, c.field, c.to])), { reload: false });
      setCheck({ ...check, changes: [] });
      setError(null);
      if (n) changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const on = check ? check.changes.length - off.size : 0;
  return (
    <div className={`m-songinfo ${check?.changes.length ? "warn" : ""}`}>
      <div className="m-songinfo-head">
        <div className="grow stack-xs">
          <b>{!check ? "Song details" : check.release ? `Song details for “${check.release.title}” · ${check.changes.length ? `${check.changes.length} fix${check.changes.length === 1 ? "" : "es"} found` : "all correct"}` : "Not found on MusicBrainz"}</b>
          <span className="muted small">
            {!check ? "Checks song names, artists, featured artists, track numbers, year and genre against MusicBrainz. Nothing changes until you press Apply; History can undo it." : check.release ? `${check.release.artist}${check.release.date ? ` · ${check.release.date}` : ""}${check.release.country ? ` · ${check.release.country}` : ""} · ${check.release.tracks} songs${check.unmatched.length ? ` · ${check.unmatched.length} of your songs didn't match a track` : ""}` : "Try fixing the album or artist name above, then check again."}
          </span>
        </div>
        {check && check.others.length > 1 && (
          <select value={check.release?.id ?? ""} disabled={busy} onChange={(e) => void run(e.target.value)} title="Another edition of this album">
            {check.others.map((o) => <option key={o.id} value={o.id}>{o.title} · {o.date || "?"}{o.country ? ` · ${o.country}` : ""} · {o.tracks} songs</option>)}
          </select>
        )}
        {!check || !check.changes.length ? (
          <button disabled={busy} onClick={() => void run()}>{busy ? <span className="spinner small-spin" /> : null} {check ? "Check again" : "Check with MusicBrainz"}</button>
        ) : (
          <button className="primary" disabled={busy || !on} onClick={() => void apply()}>{busy ? <span className="spinner small-spin" /> : null} Apply {on}</button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
      {check && check.changes.length > 0 && (
        <div className="m-tagdiff">
          {check.changes.map((c, i) => (
            <label key={i} className={`m-tagdiff-row ${off.has(i) ? "off" : ""}`}>
              <input type="checkbox" checked={!off.has(i)} onChange={() => setOff((s) => { const x = new Set(s); if (x.has(i)) x.delete(i); else x.add(i); return x; })} />
              <span className="muted ellipsis">{c.song}</span>
              <span className="muted">{FIELD[c.field] ?? c.field}</span>
              <span className="m-tag-from ellipsis" title={c.from ?? ""}>{c.from ?? "empty"}</span>
              <span className="muted">→</span>
              <span className="ellipsis" title={c.to ?? ""}>{c.to ?? "empty"}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- artists */

function ArtistsPane({ artists, changed }: { artists: MusicItem[] | null; changed: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = usePageState<string | null>("music.manage.artist", null);
  const list = artists ?? [];
  const q = query.trim().toLowerCase();
  const shown = list.filter((a) => !q || a.name.toLowerCase().includes(q));
  const items: StudioItem[] = shown.map((a) => ({
    id: a.id,
    title: a.name,
    sub: a.count ? `${a.count} album${a.count === 1 ? "" : "s"}` : "",
    pic: <span className="m-manage-thumb round"><Art item={a} size={120} round /></span>,
    status: <StatusIcons items={[{ icon: "image", label: "Picture", ok: a.hasArt, onClick: () => void chooseMusicArt(a).then((x) => x && changed()) }]} />,
    warn: !a.hasArt,
  }));
  const selected = list.find((a) => a.id === sel) ?? null;
  useEffect(() => { if (shown.length && !shown.some((a) => a.id === sel)) setSel(shown[0].id); }, [shown.length, shown[0]?.id, sel]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="lib-filters">
        <Toolbar>
          <SearchBox value={query} onChange={setQuery} placeholder="Find an artist" />
        </Toolbar>
      </div>
      <Studio items={items} selected={sel} onSelect={setSel} empty={artists ? "No artists." : <span><span className="spinner" /> Reading your music…</span>}>
        {selected && <ArtistDetail key={selected.id} artist={selected} changed={() => { setSel(null); changed(); }} />}
      </Studio>
    </>
  );
}

function ArtistDetail({ artist, changed }: { artist: MusicItem; changed: () => void }) {
  const [name, setName] = useState(artist.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!name.trim()) return setError("The name can't be empty.");
    setBusy(true);
    try {
      if (isLocal(artist.id)) await api.musicLocalEdit(artist.id, { title: name });
      else await api.saveMetadata(artist.id, { name });
      changed();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="m-detail">
      <div className="m-detail-head">
        <button className="m-detail-art round" onClick={() => void chooseMusicArt(artist).then((x) => x && changed())} title="Choose another picture">
          <Art item={artist} size={400} round />
          <span className="m-detail-art-btn"><Icon name="image" size={14} /> Change picture</span>
        </button>
        <div className="stack-s grow">
          <label className="field"><span>Artist name</span><input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} /></label>
          <div className="row">
            <button className="primary" disabled={busy || name === artist.name} onClick={() => void save()}>{busy ? <span className="spinner" /> : "Save"}</button>
            {isLocal(artist.id) && <button className="link small" disabled={busy} onClick={() => void api.musicLocalReset(artist.id).then(changed).catch((e) => setError(errorText(e)))}>Back to the files</button>}
          </div>
          <p className="muted small">A wrong picture? “Change picture” shows the artists with this name, best known first, or use a picture file.</p>
          {error && <p className="error small">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- source */

function SourcePane({ source, changed }: { source: { folder: string | null; source: "jellyfin" | "folder" } | null; changed: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const folder = source?.source === "folder";
  const run = (p: Promise<unknown>) => void p.then(changed).catch((e) => setError(errorText(e)));
  async function useFolder(pick: boolean) {
    if (pick || !source?.folder) {
      const f = await api.pickMusicFolder();
      if (!f) return;
    } else await api.setMusicSource(true);
  }
  function findArt(again: boolean) {
    if (!folder) {
      run(track("Finding missing album and artist art in Jellyfin", async (job) => {
        const albums = (await api.musicList("albums", null, null, 0, 5000)).filter((a) => !a.hasArt);
        const artists = (await api.musicList("artists", null, null, 0, 5000)).filter((a) => !a.hasArt);
        const all = [...albums, ...artists];
        let n = 0;
        for (const [i, m] of all.entries()) {
          if (job.cancelled) break;
          job.update(m.name, i / Math.max(1, all.length));
          n += (await api.fillMissingArt(m.id, ["Primary"]).catch(() => [])).length;
        }
        job.update(`${n} pictures added (Jellyfin uses MusicBrainz and TheAudioDB)`, 1);
      }, { reload: false, cancellable: true }));
      return;
    }
    run(track(again ? "Checking artist pictures again" : "Finding album covers and artist pictures", async (job) => {
      const un = await followEvent(job, "music-art-progress");
      try {
        const r = await api.musicFetchArt(again);
        job.update(`${r.covers} covers, ${r.artists} artist pictures${r.missingCovers ? ` · ${r.missingCovers} albums have none online` : ""}`, 1);
      } finally {
        un();
      }
    }, { reload: false, stop: "musicart" }));
  }
  return (
    <div className="m-source-pane stack">
      {error && <p className="error">{error}</p>}
      <section className="card stack-s">
        <h2>Where your music comes from</h2>
        {folder ? (
          <>
            <p className="small">Playing straight from a music folder{source?.folder ? <> (<span className="mono">{source.folder}</span>)</> : null}.</p>
            <div className="row">
              <button className="primary" onClick={() => run(api.setMusicSource(false))}><Icon name="server" /> Use my Jellyfin music instead</button>
              <button onClick={() => run(useFolder(true))}><Icon name="folder" /> Choose another folder</button>
              <button onClick={() => run(track("Reading the music folder", async (job) => { const n = await api.musicRescan(); job.update(`${n.toLocaleString()} songs`, 1); }, { reload: false }))}><Icon name="reload" /> Read it again</button>
            </div>
          </>
        ) : (
          <>
            <p className="small">Your Jellyfin music library.</p>
            <details className="more">
              <summary className="muted small">Play from a folder instead (without Jellyfin)</summary>
              <p className="muted small">Plays straight from a folder on this computer or the NAS (Artist / Album / 01 - Song.mp3 works best).</p>
              <button onClick={() => run(useFolder(false))}><Icon name="folder" /> Use a music folder</button>
            </details>
          </>
        )}
      </section>
      <section className="card stack-s">
        <h2>Pictures</h2>
        <p className="muted small">{folder
          ? "Looks online (MusicBrainz, Deezer) for album covers and artist pictures the folder doesn't have. They're kept in Media Hub's own folder; your music folders aren't changed."
          : "Asks Jellyfin to look for the album covers and artist pictures it's missing."}</p>
        <div className="row">
          <button className="primary" onClick={() => findArt(false)}><Icon name="image" /> Find missing pictures</button>
          {folder && <button onClick={() => findArt(true)} title="Looks up every artist picture again with a stricter match (pictures you chose yourself stay)"><Icon name="reload" /> Check artist pictures again</button>}
        </div>
      </section>
    </div>
  );
}
