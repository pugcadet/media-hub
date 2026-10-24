import { useEffect } from "react";
import { imageUrl, Item } from "./api";

export default function Detail({ item, onClose }: { item: Item; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card detail" role="dialog" aria-label={item.name} onClick={(e) => e.stopPropagation()}>
        <div className="art">
          {item.hasPoster ? <img src={imageUrl(item.id, "Primary", 500)} alt="" /> : <div className="noart">{item.name}</div>}
        </div>
        <div className="info">
          <h2>{item.name}</h2>
          <div className="muted">
            {item.kind === "movie" ? "Movie" : "Show"}
            {item.year ? ` · ${item.year}` : ""}
            {item.rating != null ? ` · ★ ${item.rating.toFixed(1)}` : ""}
          </div>
          {item.genres.length > 0 && (
            <div className="chips">{item.genres.map((g) => <span className="chip static" key={g}>{g}</span>)}</div>
          )}
          <p>{item.overview || "No description."}</p>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
