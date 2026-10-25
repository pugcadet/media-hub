import { useState } from "react";
import { api, DupGroup, DupItem, errorText, Status } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { nav } from "./nav";
import { Icon } from "./ui";

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
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canEdit = !status.readOnly;

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
    await track(label, async () => {
      for (const d of items) await api.trashItemFile(d.id);
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
        <div className="pg-actions"><button className="primary" disabled={busy} onClick={() => void find()}>{groups ? "Look again" : "Find duplicates"}</button></div>
      </div>
      {error && <p className="error">{error}</p>}
      {groups && groups.length === 0 && <p className="ok strong">No duplicates.</p>}
      {groups && groups.length > 0 && (
        <div className="row">
          <span className="muted small">{groups.length} titles have more than one copy · {size(groups.reduce((n, g) => n + g.items.filter((i) => !i.best).reduce((m, i) => m + i.size, 0), 0))} in extra copies.</span>
          <button className="danger-outline" disabled={!canEdit} onClick={() => void trash(groups.flatMap((g) => g.items.filter((i) => !i.best)), "Keeping the best copies")}>Keep the best of every title</button>
        </div>
      )}
      {(groups ?? []).map((g) => (
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
