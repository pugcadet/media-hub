import { imageUrl, Item } from "./api";

export default function Poster({ item, onOpen, width = 300 }: { item: Item; onOpen: (i: Item) => void; width?: number }) {
  return (
    <button className="poster" onClick={() => onOpen(item)} title={item.name}>
      <div className="art">
        {item.hasPoster ? (
          <img src={imageUrl(item.id, "Primary", width)} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="noart">{item.name}</div>
        )}
        {item.rating != null && <span className="badge">★ {item.rating.toFixed(1)}</span>}
      </div>
      <div className="title">{item.name}</div>
      <div className="sub">
        {item.kind === "movie" ? "Movie" : "Show"}
        {item.year ? ` · ${item.year}` : ""}
      </div>
    </button>
  );
}
