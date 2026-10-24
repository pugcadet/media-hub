import { useCallback, useEffect, useState } from "react";
import { api, errorText, Status } from "./api";
import Connect from "./Connect";
import Library from "./Library";
import Renamer from "./Renamer";
import Settings from "./Settings";
import ItemPage from "./ItemPage";

export type View = "library" | "renamer" | "settings";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<View>("library");
  const [itemStack, setItemStack] = useState<string[]>([]); // open item pages, last is on top
  const nav = useCallback((v: View) => {
    setItemStack([]);
    setView(v);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch (e) {
      setFatal(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (fatal) return <div className="center"><p className="error">{fatal}</p></div>;
  if (!status) return <div className="center"><p className="muted">Starting…</p></div>;
  if (!status.connected) return <Connect status={status} onConnected={refresh} />;
  const top = itemStack[itemStack.length - 1];
  if (top)
    return (
      <ItemPage
        key={top}
        id={top}
        onBack={() => setItemStack((s) => s.slice(0, -1))}
        onOpen={(id) => setItemStack((s) => [...s, id])}
        onNav={nav}
      />
    );
  if (view === "renamer") return <Renamer status={status} onChanged={refresh} onNav={nav} />;
  if (view === "settings") return <Settings status={status} onChanged={refresh} onNav={nav} />;
  return <Library status={status} onChanged={refresh} onNav={nav} onOpen={(id) => setItemStack([id])} />;
}
