import { useEffect, useState } from "react";
import { api, DlRequest, errorText, Probe, remoteImageUrl } from "./api";
import { addJob, clearFinished, useJobs } from "./downloadsStore";
import { fmt } from "./Intros";
import Nav from "./Nav";
import type { View } from "./App";

type Tool = { path: string | null; version: string | null; managed: boolean; folder: string | null };

const DEFAULTS: Omit<DlRequest, "url"> = {
  kind: "video",
  maxHeight: 1080,
  format: "mp4",
  subtitles: true,
  subLangs: ["en"],
  sponsorblock: false,
  playlist: true,
  naming: "title",
  seriesName: null,
  season: 1,
};

function loadPrefs(): Omit<DlRequest, "url"> {
  try {
    const raw = localStorage.getItem("dl-prefs");
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export default function Downloads({ onNav }: { onNav: (v: View) => void }) {
  const [tool, setTool] = useState<Tool | null>(null);
  const [url, setUrl] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);
  const [opts, setOpts] = useState(loadPrefs);
  const [langText, setLangText] = useState(() => loadPrefs().subLangs.join(", "));
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const jobs = useJobs();

  const loadTool = () => api.ytdlpInfo().then(setTool).catch((e) => setMessage({ text: errorText(e), error: true }));
  useEffect(() => void loadTool(), []);

  useEffect(() => {
    try {
      localStorage.setItem("dl-prefs", JSON.stringify({ ...opts, seriesName: null }));
    } catch {
      /* not essential */
    }
  }, [opts]);

  async function run(label: string, f: () => Promise<void>) {
    setBusy(label);
    setMessage(null);
    try {
      await f();
    } catch (e) {
      setMessage({ text: errorText(e), error: true });
    } finally {
      setBusy(null);
    }
  }

  const check = () =>
    run("Checking…", async () => {
      setProbe(null);
      const p = await api.dlProbe(url.trim());
      setProbe(p);
      if (p.isPlaylist && opts.naming === "series" && !opts.seriesName) setOpts((o) => ({ ...o, seriesName: p.channel || p.title }));
    });

  const start = () =>
    run("Starting…", async () => {
      const req: DlRequest = {
        ...opts,
        url: url.trim(),
        subLangs: langText.split(/[\s,]+/).map((l) => l.trim().toLowerCase()).filter(Boolean),
      };
      const id = await api.dlStart(req);
      addJob(id, probe?.title || url.trim());
      setUrl("");
      setProbe(null);
    });

  const set = <K extends keyof typeof opts>(k: K, v: (typeof opts)[K]) => setOpts((o) => ({ ...o, [k]: v }));

  return (
    <div className="app">
      <header>
        <div className="brand"><span className="logo" />Media Hub</div>
        <Nav current="downloads" onNav={onNav} />
      </header>
      <main className="settings">
        {message && <p className={message.error ? "error" : "note"}>{message.text}</p>}

        <section className="card form">
          <div className="row">
            <div className="kv"><span className="muted">yt-dlp</span><span className="mono">{tool ? tool.version ?? "Not installed" : "Checking…"}</span></div>
            <div className="spacer" />
            <button disabled={!!busy} onClick={() => void run("Installing…", async () => {
              const v = await api.ytdlpInstall();
              setMessage({ text: `yt-dlp ${v} is ready (checked against its published checksum).`, error: false });
              await loadTool();
            })}>
              {busy === "Installing…" ? "Installing…" : tool?.version && tool.managed ? "Update yt-dlp" : "Install yt-dlp"}
            </button>
          </div>
          <div className="row">
            <div className="kv"><span className="muted">Save to</span><span className="mono small">{tool?.folder ?? "No folder chosen"}</span></div>
            <div className="spacer" />
            <button onClick={() => void run("", async () => {
              await api.pickDownloadFolder();
              await loadTool();
            })}>Choose folder</button>
          </div>
        </section>

        <section className="card form">
          <div className="row">
            <label>Web address
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && url.trim() && void check()} />
            </label>
            <button disabled={!url.trim() || !!busy || !tool?.version} onClick={() => void check()}>{busy === "Checking…" ? "Checking…" : "Check"}</button>
          </div>

          {probe && (
            <div className="match">
              <div className="art wide" style={{ width: 200, flex: "0 0 200px" }}>
                {probe.thumbnail ? <img src={remoteImageUrl(probe.thumbnail)} alt="" /> : <div className="noart">No picture</div>}
              </div>
              <div className="match-text">
                <div className="title">{probe.title}</div>
                <div className="muted small">
                  {probe.channel}{probe.duration ? ` · ${fmt(probe.duration)}` : ""}{probe.isPlaylist ? ` · ${probe.entryCount} videos` : ""}
                </div>
                {probe.isPlaylist && (
                  <div className="small muted">{probe.entries.slice(0, 5).join(" · ")}{probe.entryCount > 5 ? " · …" : ""}</div>
                )}
              </div>
            </div>
          )}

          <div className="row">
            <div className="seg">
              <button className={opts.kind === "video" ? "on" : ""} onClick={() => setOpts((o) => ({ ...o, kind: "video", format: "mp4" }))}>Video</button>
              <button className={opts.kind === "audio" ? "on" : ""} onClick={() => setOpts((o) => ({ ...o, kind: "audio", format: "m4a" }))}>Music / audio</button>
            </div>
          </div>
          <div className="row">
            {opts.kind === "video" ? (
              <>
                <label className="narrow wide-label">Quality
                  <select value={opts.maxHeight} onChange={(e) => set("maxHeight", Number(e.target.value))}>
                    {[2160, 1440, 1080, 720, 480].map((h) => <option key={h} value={h}>Up to {h}p</option>)}
                  </select>
                </label>
                <label className="narrow wide-label">File type
                  <select value={opts.format} onChange={(e) => set("format", e.target.value)}>
                    <option value="mp4">MP4 (plays everywhere)</option>
                    <option value="mkv">MKV</option>
                  </select>
                </label>
                <label className="check"><input type="checkbox" checked={opts.subtitles} onChange={(e) => set("subtitles", e.target.checked)} />Subtitles</label>
                {opts.subtitles && (
                  <label className="narrow wide-label">Languages
                    <input value={langText} onChange={(e) => setLangText(e.target.value)} placeholder="en, nl" />
                  </label>
                )}
              </>
            ) : (
              <label className="narrow wide-label">File type
                <select value={opts.format} onChange={(e) => set("format", e.target.value)}>
                  <option value="m4a">M4A (best for Apple)</option>
                  <option value="mp3">MP3</option>
                  <option value="opus">Opus</option>
                  <option value="flac">FLAC</option>
                </select>
              </label>
            )}
            <label className="check"><input type="checkbox" checked={opts.sponsorblock} onChange={(e) => set("sponsorblock", e.target.checked)} />Cut sponsor segments</label>
            <label className="check"><input type="checkbox" checked={opts.playlist} onChange={(e) => set("playlist", e.target.checked)} />Whole playlist</label>
          </div>
          <div className="row">
            <label className="narrow wide-label">File names
              <select value={opts.naming} onChange={(e) => set("naming", e.target.value as DlRequest["naming"])}>
                <option value="title">Title [id]</option>
                <option value="channel">Channel folder / Title</option>
                <option value="series">As a series (Show / Season / S01E01)</option>
              </select>
            </label>
            {opts.naming === "series" && (
              <>
                <label>Series name<input value={opts.seriesName ?? ""} onChange={(e) => set("seriesName", e.target.value)} placeholder={probe?.channel ?? "Name of the show"} /></label>
                <label className="narrow">Season<input value={opts.season ?? 1} onChange={(e) => set("season", Math.max(0, Math.min(99, Number(e.target.value.replace(/\D/g, "")) || 0)))} /></label>
              </>
            )}
          </div>
          {opts.naming === "series" && (
            <p className="muted small">
              Episodes are numbered in playlist order, so Jellyfin and Infuse see a normal show. Afterwards you can fix titles or
              numbering in the Renamer and add a poster on the show's page.
            </p>
          )}
          <div className="row end">
            <button className="primary" disabled={!url.trim() || !!busy || !tool?.version || !tool?.folder || (opts.naming === "series" && !opts.seriesName?.trim())} onClick={() => void start()}>
              Download
            </button>
          </div>
        </section>

        {jobs.length > 0 && (
          <section className="card history">
            <div className="row">
              <h2>Queue</h2>
              <div className="spacer" />
              <button className="link" onClick={clearFinished}>Clear finished</button>
            </div>
            {jobs.map((j) => (
              <div className="batch job" key={j.id}>
                <div className="job-main">
                  <div>{j.title}</div>
                  <div className="progress"><span style={{ width: `${Math.max(2, Math.min(100, j.percent))}%` }} className={j.state} /></div>
                  <div className="muted small mono">
                    {j.state === "running" ? `${j.percent.toFixed(0)}% ${j.speed} ${j.eta ? `· ${j.eta} left` : ""} · ` : ""}{j.text}
                  </div>
                </div>
                {j.state === "running" && <button onClick={() => void api.dlCancel(j.id)}>Cancel</button>}
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
