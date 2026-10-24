import { useEffect, useState } from "react";
import { api, errorText, imageUrl, Item, JfItem, Status } from "./api";
import { IntrosTab } from "./Intros";
import type { View } from "./App";

/** Intros and credits: pick a show, then a season, then work on its timeline. */
export default function IntrosTool({ status, onNav }: { status: Status; onNav: (v: View) => void }) {
  const [query, setQuery] = useState("");
  const [shows, setShows] = useState<Item[]>([]);
  const [show, setShow] = useState<Item | null>(null);
  const [seasons, setSeasons] = useState<JfItem[]>([]);
  const [season, setSeason] = useState<JfItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api.list("series", query, "name", 0, 200).then(setShows).catch((e) => setError(errorText(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    setSeasons([]);
    setSeason(null);
    if (!show) return;
    api
      .details(show.id)
      .then((d) => {
        const list = d.seasons.filter((s) => s.Id);
        setSeasons(list);
        setSeason(list.find((s) => (s.IndexNumber ?? 0) > 0) ?? list[0] ?? null);
      })
      .catch((e) => setError(errorText(e)));
  }, [show]);

  return (
    <div className="pg">
      <div className="pg-head">
        <h1>{show ? show.name : "Intros and credits"}</h1>
        {show && <div className="pg-actions"><button onClick={() => setShow(null)}>Choose another show</button></div>}
      </div>
      {error && <p className="error">{error}</p>}

      {!show && (
        <>
          <p className="muted">Pick a show. Media Hub listens to the start and end of each episode on this computer, finds the parts that repeat, and saves them to Jellyfin as “Skip intro” and “Skip credits” markers that Infuse uses.</p>
          <label className="searchbox wide">
            <input placeholder="Search shows" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
          </label>
          <div className="show-picker">
            {shows.map((s) => (
              <button key={s.id} className="tool-row" onClick={() => setShow(s)}>
                <div className="thumb">{s.hasPoster ? <img src={imageUrl(s.id, "Primary", 120)} alt="" loading="lazy" /> : null}</div>
                <div className="names">
                  <div className="title">{s.name}{s.year ? ` (${s.year})` : ""}</div>
                  <div className="muted small">{s.seasons ? `${s.seasons} seasons · ` : ""}{s.episodes ? `${s.episodes} episodes` : ""}</div>
                </div>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
        </>
      )}

      {show && (
        <>
          <div className="tabs">
            {seasons.map((s) => (
              <button key={s.Id} className={season?.Id === s.Id ? "on" : ""} onClick={() => setSeason(s)}>{s.Name}</button>
            ))}
          </div>
          {season && <IntrosTab key={season.Id} seasonId={season.Id} seasonName={season.Name} canEdit={!status.readOnly} onSettings={() => onNav("settings")} />}
        </>
      )}
    </div>
  );
}
