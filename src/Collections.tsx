import { useEffect, useState } from "react";
import { api, Card, errorText, imageUrl, Status } from "./api";
import { track, useEpoch } from "./activity";
import { nav } from "./nav";
import { askChoice, CardTile } from "./ui";

/** Jellyfin collections (box sets): browse, make new ones, add and remove titles. */
export default function Collections({ status, selected }: { status: Status; selected: string | null }) {
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

  if (selected) {
    return (
      <div className="pg">
        <div className="item-top">
          <button onClick={() => nav.route({ view: "collections" })}>← All collections</button>
        </div>
        <div className="coll-hero">
          <img src={imageUrl(selected, "Backdrop", 1400)} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
          <div className="bb-shade" />
          <div className="coll-hero-text">
            <h1>{current?.title ?? "Collection"}</h1>
            <div className="muted">{items ? `${items.length} title${items.length === 1 ? "" : "s"}` : "Loading…"}</div>
          </div>
        </div>
        <div className="row">
          <button className="primary" disabled={!canEdit} onClick={() => void addTitles()}>+ Add a title</button>
          <button onClick={() => void api.revealItem(selected).catch(() => undefined)}>Show in Finder</button>
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

  return (
    <div className="pg">
      <div className="pg-head">
        <h1>Collections</h1>
        <div className="pg-actions"><button className="primary" disabled={!canEdit} onClick={() => void create()}>+ New collection</button></div>
      </div>
      {!canEdit && <p className="note">Making and changing collections needs changes switched on in Settings.</p>}
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
