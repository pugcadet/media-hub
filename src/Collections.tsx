import { useEffect, useState } from "react";
import { api, Card, errorText, imageUrl, scanAround, Status } from "./api";
import { askConfirm } from "./confirm";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { askChoice, CardTile, Icon, Img, SettingsLink } from "./ui";

/** Jellyfin collections (box sets): browse, make new ones, add and remove titles. */
export default function Collections({ status, selected, variant = "manage" }: { status: Status; selected: string | null ; variant?: "manage" | "watch" }) {
  const epoch = useEpoch();
  const [list, setList] = useState<Card[] | null>(null);
  const [items, setItems] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = !status.readOnly;
  const current = list?.find((c) => c.id === selected) ?? null;

  useEffect(() => {
    api.collections().then(setList).catch((e) => setError(errorText(e)));
  }, [epoch]);
  useEffect(() => {
    setItems(null);
    if (selected) api.collectionItems(selected).then(setItems).catch((e) => setError(errorText(e)));
  }, [selected, epoch]);

  async function create() {
    const r = await askChoice("New collection", [], { label: "Name", placeholder: "e.g. Pixar, Christmas, Marvel", okLabel: "Create" });
    if (r && "text" in r) {
      const id = await track(`Creating “${r.text}”`, () => api.collectionCreate(r.text, []));
      nav.route({ view: "collections", collection: id });
    }
  }

  async function addTitles() {
    if (!selected) return;
    const all = await api.list(null, "", "name", 0, 2000);
    const have = new Set((items ?? []).map((i) => i.id));
    const pick = await askChoice(
      `Add a title to ${current?.title ?? "this collection"}`,
      all.filter((i) => !have.has(i.id)).map((i) => ({ value: i.id, label: `${i.name}${i.year ? ` (${i.year})` : ""}`, hint: i.kind === "series" ? "Show" : "Movie" })),
    );
    if (pick && "value" in pick) await track("Adding to collection", () => api.collectionAdd(selected, [pick.value]));
  }

  /** Moves every movie of this collection into one folder on the NAS (one undoable batch). */
  async function oneFolder() {
    if (!selected) return;
    const suggested = (current?.title ?? "Collection").replace(/ Collection$/i, "");
    const r = await askChoice(`Put the movies of ${current?.title ?? "this collection"} in one folder`, [], { label: "Folder name", placeholder: suggested, okLabel: "Show what moves" });
    if (!r || !("text" in r)) return;
    try {
      const plan = await api.collectionFolderPlan(selected, r.text.trim() || suggested);
      const ok = plan.ops.filter((o) => o.status === "ok");
      if (!ok.length) {
        setError(plan.skipped.length ? `Nothing to move. ${plan.skipped.join(" · ")}` : `Every movie is already in “${plan.folder}”.`);
        return;
      }
      const list = ok.slice(0, 6).map((o) => `• ${o.from.split("/").pop()}`).join("\n");
      const more = ok.length > 6 ? `\n…and ${ok.length - 6} more` : "";
      const skip = plan.skipped.length ? `\n\nLeft where they are: ${plan.skipped.join("; ")}` : "";
      if (!(await askConfirm(`Move ${ok.length} movie folder${ok.length === 1 ? "" : "s"} into “${plan.folder}”?\n\n${list}${more}${skip}\n\nJellyfin sees them as new (watched status stays); Media Hub adds them back to this collection once Jellyfin has found them. You can undo the move in History.`, { okLabel: "Move" }))) return;
      const movies = (items ?? []).filter((i) => i.kind === "movie").map((i) => [i.title, i.year ?? null] as [string, number | null]);
      await track(`Moving ${ok.length} movies into ${plan.folder}`, async (job) => {
        const rep = await api.apply(plan.planId, true, ok.map((o) => o.from));
        job.update("Asking Jellyfin to look at the new folder", null);
        await scanAround([plan.folder, ...ok.map((o) => o.from)]);
        await api.collectionRelink(selected, movies).catch(() => undefined);
        if (rep.failed.length) throw `${rep.done} moved; ${rep.failed.length} failed: ${rep.failed[0]}`;
        job.update(`${rep.done} moved · re-adding to the collection in the background`, 1);
      });
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (selected) {
    return (
      <div className="pg">
        <div className="item-top">
          <button onClick={() => nav.route({ view: "collections" })}>← All collections</button>
        </div>
        {variant === "manage" ? (
          <div className="pg-head coll-head">
            <div className="coll-art"><Img src={imageUrl(selected, "Primary", 240)} /></div>
            <div className="grow"><h1>{current?.title ?? "Collection"}</h1><div className="muted small">{items ? `${items.length} title${items.length === 1 ? "" : "s"}` : "Loading…"}</div></div>
          </div>
        ) : <div className="coll-hero">
          <Img src={imageUrl(selected, "Backdrop", 1400)} />
          <div className="bb-shade" />
          <div className="coll-hero-text">
            <h1>{current?.title ?? "Collection"}</h1>
            <div className="muted">{items ? `${items.length} title${items.length === 1 ? "" : "s"}` : "Loading…"}</div>
          </div>
        </div>}
        <div className="row">
          <button className="primary" disabled={!canEdit} onClick={() => void addTitles()}>+ Add a title</button>
          <button disabled={!canEdit} onClick={() => nav.open(selected, { tab: "art" })}><Icon name="image" /> Change artwork</button>
          <button disabled={!canEdit || !status.libraryRoot} onClick={() => void oneFolder()} title="Move the movies into one folder on the NAS, named after the collection"><Icon name="folder" /> Put the movies in one folder…</button>
          <span className="muted small">Right-click a title to remove it. Collections show up in Infuse too.</span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="grid">
          {(items ?? []).map((c) => <CardTile key={c.id} c={c} canEdit={canEdit} inCollection={selected} />)}
        </div>
        {items && items.length === 0 && <p className="muted">Empty. Add titles here, or right-click any movie or show and choose “Add to collection…”.</p>}
      </div>
    );
  }

  const day = Math.floor(Date.now() / 86_400_000);
  const spot = list && list.length ? list[day % list.length] : null;
  return (
    <div className="pg">
      {spot && variant === "watch" && (
        <section className="billboard" onClick={() => nav.route({ view: "collections", collection: spot.id })}>
          <Img className="bb-art" src={imageUrl(spot.artId, "Backdrop", 1600)} />
          <div className="bb-shade" />
          <div className="bb-text">
            <div className="bb-why">Collection of the day</div>
            <div className="bb-title">{spot.title}</div>
            <div className="bb-meta">{spot.subtitle}</div>
            <div className="row"><button className="primary bb-btn">Open collection</button></div>
          </div>
        </section>
      )}
      <div className="pg-head">
        <h1>Collections</h1>
        <div className="pg-actions"><button className="primary" disabled={!canEdit} onClick={() => void create()}>+ New collection</button></div>
      </div>
      {!canEdit && <p className="note">Making and changing collections needs changes switched on. <SettingsLink section="changes">Turn them on</SettingsLink></p>}
      {error && <p className="error">{error}</p>}
      {list === null && !error && <p className="muted">Loading…</p>}
      {list && list.length === 0 && (
        <p className="muted">No collections yet. Make one here, or right-click a movie or show and choose “Add to collection…”. Jellyfin can also make movie collections by itself (Library settings → “Automatically add to collection”).</p>
      )}
      <div className="grid">
        {(list ?? []).map((c) => (
          <CardTile key={c.id} c={c} canEdit={canEdit} onOpen={() => nav.route({ view: "collections", collection: c.id })} />
        ))}
      </div>
    </div>
  );
}
