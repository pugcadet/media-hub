import { useEffect, useMemo, useState } from "react";
import { api, AutoResult, codesFor, cultures, Culture, errorText, JfChild, languageName, SubOptions } from "./api";
import { track } from "./activity";
import { prefs, setPrefs, subSkipped } from "./prefs";

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
      const idx = await track("Downloading subtitle", () => api.subtitleDownload(id, subId, lang, codesFor(lang, list)));
      setNote(idx != null
        ? "Downloaded and ready. It's saved next to the video; you can undo it under Changes made here."
        : "Downloaded. Jellyfin hasn't listed it yet; it shows up after its next look at the folder (Refresh from internet speeds that up).");
      await load();
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
  const [minScore, setMinScoreState] = useState(prefs().minSubScore);
  const setMinScore = (n: number) => { setMinScoreState(n); setPrefs({ minSubScore: n }); };
  const [running, setRunning] = useState(false);
  const [stop, setStop] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});

  const load = () =>
    api.children(id).then((c) => setEps(c.filter((x) => x.Type === "Episode"))).catch((e) => setError(errorText(e)));

  useEffect(() => void load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const codes = useMemo(() => codesFor(lang, list), [lang, list]);
  const has = (e: JfChild) =>
    (e.MediaStreams ?? []).some((s) => s.Type === "Subtitle" && !s.IsForced && s.Language && codes.includes(s.Language.toLowerCase()));
  const missing = (eps ?? []).filter((e) => !has(e) && !subSkipped(e.Path));
  const skippedHere = (eps ?? []).filter((e) => !has(e) && subSkipped(e.Path)).length;

  // A ref-like flag read inside the loop.
  const stopRef = useMemo(() => ({ current: false }), []);
  useEffect(() => {
    stopRef.current = stop;
  }, [stop, stopRef]);

  async function fill() {
    setRunning(true);
    setStop(false);
    stopRef.current = false;
    await track(`Subtitles for ${missing.length} episode${missing.length === 1 ? "" : "s"}`, async (job) => {
    for (const [i, e] of missing.entries()) {
      if (stopRef.current || job.cancelled) break;
      job.update(e.Name, i / missing.length);
      setResults((r) => ({ ...r, [e.Id]: "working…" }));
      try {
        const res = await api.subtitleAuto(e.Id, lang, codes, minScore);
        setResults((r) => ({ ...r, [e.Id]: OUTCOME[res.outcome] + (res.score != null ? ` (${res.score})` : "") }));
      } catch (err) {
        setResults((r) => ({ ...r, [e.Id]: errorText(err) }));
        if (/rate|limit|quota/i.test(errorText(err))) break; // provider says stop for today
      }
    }
    }, { cancellable: true }).catch(() => undefined);
    setRunning(false);
    void load();
  }

  return (
    <section className="card form">
      <div className="row">
        <LangPicker langs={subLangs} value={lang} onChange={setLang} list={list} />
        <label className="narrow wide-label">Minimum score
          <input type="number" min={1} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(1, Math.min(100, Number(e.target.value) || 100)))} />
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
        Takes the best match per episode only when it scores at least {minScore} (100 = made for exactly this file). Episodes with built-in subtitles in this language are skipped. Subtitle sites limit downloads per day, so large batches may stop early.{skippedHere ? ` This season is in a folder you skip (Settings), so ${skippedHere} are left out.` : ""}
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
