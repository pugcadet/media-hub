import { cleanTitle, imageUrl, Item } from "./api";
import { itemMenu, openMenu } from "./ui";

function meta(item: Item): string {
  if (item.kind === "series") {
    const parts = [];
    if (item.seasons) parts.push(`${item.seasons} season${item.seasons === 1 ? "" : "s"}`);
    if (item.episodes) parts.push(`${item.episodes} episodes`);
    return parts.join(" · ") || (item.year ? String(item.year) : "Show");
  }
  const m = item.runtime ? Math.round(item.runtime) : 0;
  const len = m ? (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`) : "";
  return ["Movie", item.year ? String(item.year) : "", len].filter(Boolean).join(" · ");
}

function flag(item: Item): { text: string; cls: string } {
  if (!item.matched) return { text: "No match", cls: "bad" };
  if (!item.hasPoster) return { text: "No poster", cls: "warn" };
  return { text: "OK", cls: "ok" };
}

export default function Poster({ item, onOpen, width = 300, canEdit = true }: { item: Item; onOpen: (i: Item) => void; width?: number; canEdit?: boolean }) {
  const f = flag(item);
  const name = cleanTitle(item.name, item.year);
  return (
    <button className="poster" onClick={() => onOpen(item)} title={name} onContextMenu={(e) => openMenu(e, itemMenu({ id: item.id, kind: item.kind, title: name, played: item.played }, canEdit))}>
      <div className="art">
        {item.hasPoster ? (
          <img src={imageUrl(item.id, "Primary", width)} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="noart">{name}</div>
        )}
        <span className={`flag ${f.cls}`}>{f.text}</span>
        {item.played && <span className="played" title="Watched">✓</span>}
      </div>
      <div className="title">{name}</div>
      <div className="sub">{meta(item)}</div>
    </button>
  );
}
