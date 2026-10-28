// Music: fix a song's, album's or artist's info, and choose its picture.
// Music from a folder: the changes are kept by Media Hub (the music files are never written to)
// and can be reset. Music from Jellyfin: saved in Jellyfin like any other edit (History can undo).
import { useEffect, useState } from "react";
import { api, ArtOption, errorText, MusicItem, remoteImageUrl } from "./api";
import { track } from "./activity";
import { Icon, makeStore } from "./ui";

/** Changes when a folder picture was replaced (its address stays the same). */
export const artVersion = makeStore(0);

const isLocal = (m: MusicItem) => /^[LAR][0-9a-f]{16}$/.test(m.id);

/* ------------------------------------------------------------------ edit info */

interface EditAsk { item: MusicItem; resolve: (saved: boolean) => void }
const editStore = makeStore<EditAsk | null>(null);

/** Opens the edit form; resolves true when something was saved. */
export function editMusicInfo(item: MusicItem): Promise<boolean> {
  return new Promise((resolve) => editStore.set({ item, resolve }));
}

function EditHost() {
  const ask = editStore.use();
  const [f, setF] = useState({ title: "", artist: "", album: "", year: "", index: "", disc: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ask) return;
    const m = ask.item;
    setF({ title: m.name, artist: m.artist, album: m.album, year: m.year ? String(m.year) : "", index: m.index ? String(m.index) : "", disc: m.disc ? String(m.disc) : "" });
    setError(null);
  }, [ask]);
  if (!ask) return null;
  const m = ask.item;
  const close = (saved: boolean) => {
    ask.resolve(saved);
    editStore.set(null);
  };
  const n = (s: string) => (s.trim() === "" ? 0 : Number(s));
  async function save() {
    if ([f.year, f.index, f.disc].some((x) => x.trim() !== "" && !/^\d+$/.test(x.trim()))) return setError("Numbers only for year, track and disc.");
    if (!f.title.trim()) return setError("The name can't be empty.");
    setBusy(true);
    setError(null);
    try {
      await track(`Saving “${f.title.trim()}”`, async () => {
        if (isLocal(m)) {
          if (m.kind === "track") await api.musicLocalEdit(m.id, { title: f.title, artist: f.artist, index: n(f.index), disc: n(f.disc) });
          else if (m.kind === "album") await api.musicLocalEdit(m.id, { album: f.title, artist: f.artist, year: n(f.year) });
          else await api.musicLocalEdit(m.id, { title: f.title });
        } else if (m.kind === "track") {
          await api.saveMetadata(m.id, { name: f.title, artists: f.artist.split(/\s*[,;]\s*/).filter(Boolean), indexNumber: f.index ? n(f.index) : null, parentIndexNumber: f.disc ? n(f.disc) : null });
        } else if (m.kind === "album") {
          await api.saveMetadata(m.id, { name: f.title, albumArtist: f.artist, productionYear: f.year ? n(f.year) : null });
        } else {
          await api.saveMetadata(m.id, { name: f.title });
        }
      }, { reload: false });
      close(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function reset() {
    setBusy(true);
    try {
      await api.musicLocalReset(m.id);
      close(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const field = (key: keyof typeof f, label: string, opts: { num?: boolean; hint?: string } = {}) => (
    <label className="field">
      <span>{label}</span>
      <input value={f[key]} inputMode={opts.num ? "numeric" : undefined} placeholder={opts.hint} onChange={(e) => setF({ ...f, [key]: e.target.value })} onKeyDown={(e) => e.key === "Enter" && void save()} />
    </label>
  );
  const what = m.kind === "track" ? "song" : m.kind;
  return (
    <div className="overlay confirm-layer" onClick={() => close(false)}>
      <div className="card confirm m-edit" onClick={(e) => e.stopPropagation()}>
        <h2>Edit {what}</h2>
        <p className="muted small">
          {isLocal(m)
            ? "Media Hub keeps your changes itself; your music files are not changed. “Back to the files” undoes them."
            : "Saved in Jellyfin. History can undo it."}
        </p>
        <div className="m-edit-grid">
          {field("title", m.kind === "track" ? "Title" : "Name")}
          {m.kind !== "artist" && field("artist", m.kind === "album" ? "Album artist" : "Artist", { hint: m.kind === "track" && !isLocal(m) ? "Several? Separate with commas" : undefined })}
          {m.kind === "album" && field("year", "Year", { num: true })}
          {m.kind === "track" && <div className="m-edit-nums">{field("index", "Track", { num: true })}{field("disc", "Disc", { num: true })}</div>}
        </div>
        {error && <p className="error small">{error}</p>}
        <div className="row confirm-actions">
          {isLocal(m) && <button className="link small" disabled={busy} onClick={() => void reset()}>Back to the files</button>}
          <span className="spacer" />
          <button onClick={() => close(false)} disabled={busy}>Cancel</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>{busy ? <span className="spinner" /> : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ choose picture */

interface ArtAsk { item: MusicItem; resolve: (saved: boolean) => void }
const artStore = makeStore<ArtAsk | null>(null);

/** Opens the picture chooser for an album or artist (a song uses its album). */
export function chooseMusicArt(item: MusicItem): Promise<boolean> {
  return new Promise((resolve) => artStore.set({ item, resolve }));
}

function ArtHost() {
  const ask = artStore.use();
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState<ArtOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const m = ask?.item;
  const kind: "album" | "artist" = m?.kind === "artist" ? "artist" : "album";
  const target = m && m.kind === "track" ? { ...m, id: m.albumId ?? "", kind: "album" as const, name: m.album } : m;
  useEffect(() => {
    if (!m) return;
    setQuery(m.kind === "track" ? m.album : m.name);
    setError(null);
  }, [m]);
  useEffect(() => {
    if (!m || !query.trim()) return;
    setOpts(null);
    const t = setTimeout(() => {
      api.musicArtOptions(kind, query, kind === "album" ? m.artist : null).then(setOpts).catch((e) => { setOpts([]); setError(errorText(e)); });
    }, 350);
    return () => clearTimeout(t);
  }, [m, query, kind]);
  if (!ask || !m || !target) return null;
  const close = (saved: boolean) => {
    ask.resolve(saved);
    artStore.set(null);
  };
  async function use(url: string | null) {
    if (!target!.id) return setError("This song has no album to put a picture on.");
    setBusy(url ?? "file");
    setError(null);
    try {
      const done = await track(`New picture for “${target!.name}”`, async () => {
        if (isLocal(target!)) {
          const ok = await api.musicLocalSetArt(target!.id, url);
          if (ok) artVersion.set(Date.now());
          return ok;
        }
        if (url) {
          await api.setImageFromLink(target!.id, "Primary", url);
          return true;
        }
        return api.uploadImageFile(target!.id, "Primary");
      }, { reload: false });
      if (done) close(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="overlay confirm-layer" onClick={() => close(false)}>
      <div className="card confirm m-artpick" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h2 className="grow">Picture for {kind === "artist" ? "artist" : "album"} “{target.name}”</h2>
          <button className="icon-btn" onClick={() => close(false)} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="row">
          <label className="searchbox grow"><Icon name="search" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={kind === "artist" ? "Artist name" : "Album name"} /></label>
          <button onClick={() => void use(null)} disabled={!!busy}><Icon name="folder" /> From a file…</button>
        </div>
        <p className="muted small">{kind === "artist" ? "From Deezer. The best known artist with exactly this name is first." : "From Deezer and MusicBrainz."} Click one to use it.</p>
        {error && <p className="error small">{error}</p>}
        <div className={`m-artpick-grid ${kind === "artist" ? "round" : ""}`}>
          {opts === null && <div className="pg-loading"><span className="spinner" /> Looking…</div>}
          {opts?.length === 0 && <p className="muted">Nothing found. Try another spelling, or choose a picture file.</p>}
          {opts?.map((o) => (
            <button key={o.url} className="m-artpick-tile" disabled={!!busy} onClick={() => void use(o.url)} title={`${o.label} (${o.source})`}>
              <img src={remoteImageUrl(o.url)} alt="" loading="lazy" />
              {busy === o.url && <span className="m-artpick-busy"><span className="spinner" /></span>}
              <span className="small ellipsis">{o.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function MusicEditHost() {
  return (
    <>
      <EditHost />
      <ArtHost />
    </>
  );
}
