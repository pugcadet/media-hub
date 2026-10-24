import { useEffect, useMemo, useState } from "react";
import { api, AutoResult, codesFor, cultures, Culture, errorText, JfChild, languageName, SubOptions } from "./api";

function useCultures(): Culture[] {
  const [list, setList] = useState<Culture[]>([]);
  useEffect(() => {
    cultures().then(setList).catch(() => setList([]));
  }, []);
  return list;
}

function LangPicker({ langs, value, onChange, list }: { langs: string[]; value: string; onChange: (v: string) => void; list: Culture[] }) {
  return (
    <label className="narrow wide-label">Language
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {langs.map((l) => <option key={l} value={l}>{languageName(l, list)}</option>)}
      </select>
    </label>
  );
}

function scoreClass(s: number) {
  return s >= 85 ? "good" : s >= 60 ? "fair" : "poor";
}

/** Subtitles for one movie or episode. */
export function SubtitlesTab({ id, canEdit, subLangs }: { id: string; canEdit: boolean; subLangs: string[] }) {
  const list = useCultures();
  const [lang, setLang] = useState(subLangs[0] ?? "eng");
  const [opts, setOpts] = useState<SubOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    setOpts(null);
    setError(null);
    try {
      setOpts(await api.subtitleOptions(id, lang));
    } catch (e) {
      setError(errorText(e));
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, lang]);

  async function download(subId: string) {
    setBusy(subId);
    setNote(null);
    try {
      await api.subtitleDownload(id, subId, lang, codesFor(lang, list));
      setNote("Downloaded. Jellyfin saves it next to the video; it can take a few seconds to show up. You can undo it under Changes made here (reload the page).");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card form">
      <div className="row">
        <LangPicker langs={subLangs} value={lang} onChange={setLang} list={list} />
        <button onClick={() => void load()}>Search again</button>
      </div>
      {opts && (
        <>
          <div className="muted small">File: <span className="mono">{opts.file}</span></div>
          <div className="chips">
            {opts.current.length === 0 && <span className="muted small">No subtitles yet.</span>}
            {opts.current.map((s) => (
              <span className="chip static" key={s.index}>
                {languageName(s.language, list) || "Unknown"}{s.forced ? " (forced)" : ""}{s.external ? "" : " · built in"}
              </span>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}
      {!opts && !error && <p className="muted">Searching…</p>}
      {opts && opts.results.length === 0 && <p className="muted">No subtitles found in this language.</p>}
      <div className="table">
        {opts?.results.map((r) => (
          <div className="op subrow" key={r.sub.Id}>
            <span className={`score ${scoreClass(r.score)}`} title="Match score">{r.score}</span>
            <div className="names">
              <div className="mono">{r.sub.Name}</div>
              <div className="small muted">
                {r.sub.ProviderName}
                {r.sub.DownloadCount != null ? ` · ${r.sub.DownloadCount.toLocaleString()} downloads` : ""}
                {r.sub.Format ? ` · ${r.sub.Format}` : ""}
                {r.reasons.length ? ` · ${r.reasons.join(", ")}` : ""}
              </div>
            </div>
            <button disabled={!canEdit || !!busy} onClick={() => void download(r.sub.Id!)}>{busy === r.sub.Id ? "…" : "Download"}</button>
          </div>
        ))}
      </div>
      {!canEdit && <p className="muted small">Downloading needs changes to Jellyfin switched on in Settings.</p>}
    </section>
  );
}

const OUTCOME: Record<AutoResult["outcome"], string> = {
  has: "already has it",
  downloaded: "downloaded",
  low: "best match too weak",
  none: "nothing found",
};

/** Episodes of a season, with a bulk "fill in missing subtitles" action. */
export function EpisodesTab({ id, canEdit, subLangs, onOpen }: { id: string; canEdit: boolean; subLangs: string[]; onOpen: (id: string) => void }) {
  const list = useCultures();
  const [eps, setEps] = useState<JfChild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState(subLangs[0] ?? "eng");
  const [minScore, setMinScore] = useState(70);
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = () =>
    api.children(id).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch((e) => setError(errorText(e)));

  useEffect(() => void load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const codes = useMemo(() => codesFor(lang, list), [lang, list]);
  const has = (e: JfChild) =>
    (e.MediaStreams ?? []).some((s) => s.Type === "Subtitle" && !s.IsForced && s.Language && codes.includes(s.Language.toLowerCase()));
  const missing = (eps ?? []).filter((e) => !has(e));

  // A ref-like flag read inside the loop.
  const stopRef = useMemo(() => ({ current: false }), []);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop, stopRef]);

  async function fill() {
    setRunning(true);
    setStop(false);
    stopRef.current = false;
    for (const e of missing) {
      if (stopRef.current) break;
      setResults((r) => ({ ...r, [e.Id]: "working…" }));
      try {
        const res = await api.subtitleAuto(e.Id, lang, codes, minScore);
        setResults((r) => ({ ...r, [e.Id]: OUTCOME[res.outcome] + (res.score != null ? ` (${res.score})` : "") }));
      } catch (err) {
        setResults((r) => ({ ...r, [e.Id]: errorText(err) }));
        if (/rate|limit|quota/i.test(errorText(err))) break; // provider says stop for today
      }
    }
    setRunning(false);
    void load();
  }

  return (
    <section className="card form">
      <div className="row">
        <LangPicker langs={subLangs} value={lang} onChange={setLang} list={list} />
        <label className="narrow wide-label">Minimum score
          <input type="number" min={1} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(1, Math.min(100, Number(e.target.value) || 70)))} />
        </label>
        {running ? (
          <button onClick={() => setStop(true)}>Stop</button>
        ) : (
          <button className="primary" disabled={!canEdit || missing.length === 0} onClick={() => void fill()}>
            Get missing subtitles ({missing.length})
          </button>
        )}
      </div>
      <p className="muted small">
        Takes the best match per episode only when it scores at least {minScore}. Subtitle sites limit downloads per day, so large batches may stop early.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table">
        {(eps ?? []).map((e) => (
          <div className="op" key={e.Id}>
            <span className={`dot ${has(e) ? "ok" : "unparsed"}`} />
            <div className="names">
              <button className="link" onClick={() => onOpen(e.Id)}>
                {e.IndexNumber != null ? `E${String(e.IndexNumber).padStart(2, "0")} · ` : ""}{e.Name}
              </button>
              <div className="small muted">
                {(e.MediaStreams ?? []).filter((s) => s.Type === "Subtitle").map((s) => languageName(s.Language ?? "", list) || "?").join(", ") || "No subtitles"}
                {results[e.Id] ? ` · ${results[e.Id]}` : ""}
              </div>
            </div>
          </div>
        ))}
        {eps && eps.length === 0 && <p className="muted">No episodes.</p>}
      </div>
    </section>
  );
}

/** Settings block: which languages to offer, in order. */
export function SubLangSettings({ subLangs, onChanged }: { subLangs: string[]; onChanged: () => void }) {
  const list = useCultures();
  const [add, setAdd] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(next: string[]) {
    try {
      await api.setSubLangs(next);
      onChanged();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const options = list.filter((c) => c.ThreeLetterISOLanguageName && !subLangs.includes(c.ThreeLetterISOLanguageName));
  return (
    <section className="card form">
      <h2>Subtitle languages</h2>
      <div className="chips">
        {subLangs.map((l) => (
          <span className="chip static" key={l}>
            {languageName(l, list)}
            {subLangs.length > 1 && <button className="link x" onClick={() => void save(subLangs.filter((x) => x !== l))} aria-label="Remove">×</button>}
          </span>
        ))}
      </div>
      <div className="row">
        <label>Add a language
          <select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((c) => <option key={c.ThreeLetterISOLanguageName} value={c.ThreeLetterISOLanguageName}>{c.DisplayName}</option>)}
          </select>
        </label>
        <button disabled={!add} onClick={() => { void save([...subLangs, add]); setAdd(""); }}>Add</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
