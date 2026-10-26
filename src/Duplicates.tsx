import { useState } from "react";
import { api, DupGroup, DupItem, errorText, Status } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { nav } from "./nav";
import { Icon } from "./ui";
import { agoText, useSaved } from "./saved";
import { duplicatesSummary, savePart } from "./scan";

function size(b: number): string {
  if (!b) return "";
  return b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
}

function res(d: DupItem): string {
  if (!d.height) return "";
  return d.height >= 2000 ? "4K" : d.height >= 1000 ? "1080p" : d.height >= 700 ? "720p" : `${d.height}p`;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** The same movie or episode more than once: keep the best, trash the rest, or group as versions. */
export default function Duplicates({ status }: { status: Status }) {
  // The last search is kept (also when it found nothing), with when it ran.
  const [saved, save] = useSaved<DupGroup[]>("duplicates");
  const groups = saved?.data ?? null;
  const setGroups = (f: DupGroup[] | null | ((g: DupGroup[] | null) => DupGroup[] | null)) => {
    const next = typeof f === "function" ? f(groups) : f;
    if (next) {
      save(next);
      savePart("duplicates", duplicatesSummary(next, Date.now()));
    }
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = !status.readOnly;
  const real = groups?.filter((g) => g.kind !== "mixed") ?? null;
  const mixed = groups?.filter((g) => g.kind === "mixed") ?? [];

  async function find() {
    setBusy(true);
    setError(null);
    try {
      setGroups(await track("Looking for duplicates", () => api.findDuplicates(), { reload: false, cancellable: true }));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function trash(items: DupItem[], label: string) {
    if (!(await askConfirm(`Move ${items.length} file${items.length === 1 ? "" : "s"} (with their subtitles) to the trash folder in your library? Nothing is deleted; you can undo it in History.`, { okLabel: "Move to trash", danger: true }))) return;
    await track(label, async (job) => {
      for (const d of items) await api.trashItemFile(d.id);
      // Let Jellyfin notice, then update Media Hub's own list so the titles disappear everywhere.
      job.update("Updating the library", null);
      await new Promise((r) => window.setTimeout(r, 4000));
      await api.sync().catch(() => undefined);
    });
    setGroups((g) => g?.map((x) => ({ ...x, items: x.items.filter((i) => !items.includes(i)) })).filter((x) => x.items.length > 1) ?? null);
  }

  async function merge(g: DupGroup) {
    await track(`Grouping ${g.title} as versions`, () => api.mergeVersions(g.items.map((i) => i.id)));
    setGroups((gs) => gs?.filter((x) => x !== g) ?? null);
  }

  return (
    <div className="pg">
      <div className="pg-head">
        <div>
          <h1>Duplicates</h1>
          <div className="muted small">The same movie (same TMDB/IMDb id, or name and year) or the same episode more than once. The best copy is marked: highest resolution, then HDR, then the newer codec.</div>
        </div>
        <div className="pg-actions">
          {saved && <span className="muted small">Checked {agoText(saved.at)}</span>}
          <button className="primary" disabled={busy} onClick={() => void find()}>{groups ? "Look again" : "Find duplicates"}</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {real && real.length === 0 && <p className="ok strong">No duplicates.</p>}
      {real && real.length > 0 && (
        <div className="row">
          <span className="muted small">{real.length} titles have more than one copy · {size(real.reduce((n, g) => n + g.items.filter((i) => !i.best).reduce((m, i) => m + i.size, 0), 0))} in extra copies.</span>
          <button className="danger-outline" disabled={!canEdit} onClick={() => void trash(real.flatMap((g) => g.items.filter((i) => !i.best)), "Keeping the best copies")}>Keep the best of every title</button>
        </div>
      )}
      {mixed.length > 0 && (
        <section className="card form">
          <div className="section-head">
            <div>
              <h2>Two shows mixed up ({mixed.length})</h2>
              <div className="muted small">Different episodes with the same number in one show, like “Planet Earth” and “Planet Earth III”. Not duplicates: Jellyfin has put two shows together. Give each show its own folder (with the year), or identify them separately.</div>
            </div>
          </div>
          {mixed.map((g) => (
            <div key={g.title + g.items[0]?.id} className="dup-row">
              <div className="names">
                <div className="strong small">{g.title}</div>
                {g.items.map((d) => <div key={d.id} className="mono small ellipsis muted" title={d.path}>{d.name} · {fileName(d.path)}</div>)}
              </div>
              <div className="row end">
                <button className="icon-btn" title="Show in Finder" onClick={() => void api.revealItem(g.items[0].id).catch(() => undefined)}><Icon name="folder" /></button>
                <button onClick={() => nav.open(g.items[0].id)}>Open</button>
              </div>
            </div>
          ))}
        </section>
      )}
      {(real ?? []).map((g) => (
        <section key={g.title + g.items[0]?.id} className="card form">
          <div className="section-head">
            <h2>{g.title}</h2>
            <div className="row end">
              {g.kind === "movie" && <button disabled={!canEdit} onClick={() => void merge(g)} title="One entry in Jellyfin and Infuse; you choose the version when you play">Group as versions</button>}
              <button className="danger-outline" disabled={!canEdit} onClick={() => void trash(g.items.filter((i) => !i.best), `Keeping the best copy of ${g.title}`)}>Keep the best, trash the rest</button>
            </div>
          </div>
          {g.items.map((d) => (
            <div key={d.id} className={`dup-row ${d.best ? "best" : ""}`}>
              <div className="names">
                <div className="mono small ellipsis" title={d.path}>{fileName(d.path)}</div>
                <div className="chips">
                  {d.best && <span className="chip static on">Best</span>}
                  {res(d) && <span className="chip static">{res(d)}</span>}
                  {d.hdr && <span className="chip static">HDR</span>}
                  {d.codec && <span className="chip static">{d.codec.toUpperCase()}</span>}
                  {size(d.size) && <span className="chip static">{size(d.size)}</span>}
                  {d.versions > 1 && <span className="chip static">{d.versions} versions already</span>}
                </div>
              </div>
              <div className="row end">
                <button className="icon-btn" title="Show in Finder" onClick={() => void api.revealItem(d.id).catch(() => undefined)}><Icon name="folder" /></button>
                <button onClick={() => nav.play(d.id)}>Play</button>
                <button className="danger-outline" disabled={!canEdit} onClick={() => void trash([d], "Moving to trash")}>Trash</button>
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
