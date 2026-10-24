import type { View } from "./App";

const ITEMS: { id: View; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "renamer", label: "Renamer" },
  { id: "downloads", label: "Downloads" },
  { id: "settings", label: "Settings" },
];

export default function Nav({ current, onNav }: { current: View; onNav: (v: View) => void }) {
  return (
    <nav className="nav">
      {ITEMS.map((i) => (
        <button key={i.id} className={current === i.id ? "on" : ""} onClick={() => onNav(i.id)}>
          {i.label}
        </button>
      ))}
    </nav>
  );
}
