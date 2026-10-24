import { useCallback, useEffect, useState } from "react";
import { api, Attention, errorText, Library as Lib, Status } from "./api";
import Setup from "./Setup";
import Library from "./Library";
import Renamer from "./Renamer";
import Settings from "./Settings";
import Downloads from "./Downloads";
import Storage from "./Storage";
import ItemPage from "./ItemPage";
import Sidebar from "./Sidebar";
import { MetadataTool, SubtitlesTool } from "./Tools";
import IntrosTool from "./IntrosTool";

export type View = "library" | "renamer" | "metadata" | "subtitles" | "intros" | "storage" | "downloads" | "settings";

export interface Route {
  view: View;
  /** library id when view is "library" */
  library?: string;
  /** "unmatched" | "noposter" filter for the library */
  flag?: string;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ view: "library" });
  const [itemStack, setItemStack] = useState<string[]>([]);
  const [libraries, setLibraries] = useState<Lib[]>([]);
  const [attention, setAttention] = useState<Attention | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.status();
      setStatus(s);
      if (s.connected) {
        api.libraries().then(setLibraries).catch(() => setLibraries([]));
        api.attention().then(setAttention).catch(() => setAttention(null));
      }
    } catch (e) {
      setFatal(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const go = useCallback((r: Route) => {
    setItemStack([]);
    setRoute(r);
  }, []);
  const nav = useCallback((v: View) => go({ view: v }), [go]);
  const open = useCallback((id: string) => setItemStack((s) => [...s, id]), []);

  if (fatal) return <div className="center"><p className="error">{fatal}</p></div>;
  if (!status) return <div className="center"><p className="muted">Starting…</p></div>;
  if (!status.connected) return <Setup status={status} onDone={refresh} />;

  const top = itemStack[itemStack.length - 1];
  let page;
  if (top) {
    page = (
      <ItemPage
        key={top}
        id={top}
        onBack={() => setItemStack((s) => s.slice(0, -1))}
        onOpen={open}
        onNav={nav}
        subLangs={status.subLangs}
        titleLang={status.titleLang}
        status={status}
      />
    );
  } else {
    switch (route.view) {
      case "renamer":
        page = <Renamer status={status} onChanged={refresh} onNav={nav} />;
        break;
      case "metadata":
        page = <MetadataTool onOpen={open} onRoute={go} />;
        break;
      case "subtitles":
        page = <SubtitlesTool status={status} onOpen={open} />;
        break;
      case "intros":
        page = <IntrosTool status={status} onNav={nav} />;
        break;
      case "storage":
        page = <Storage status={status} onNav={nav} />;
        break;
      case "downloads":
        page = <Downloads onNav={nav} />;
        break;
      case "settings":
        page = <Settings status={status} onChanged={refresh} onNav={nav} />;
        break;
      default:
        page = (
          <Library
            key={`${route.library ?? "all"}-${route.flag ?? ""}`}
            status={status}
            libraries={libraries}
            attention={attention}
            route={route}
            onRoute={go}
            onChanged={refresh}
            onOpen={open}
          />
        );
    }
  }

  return (
    <div className="shell">
      <Sidebar status={status} libraries={libraries} attention={attention} route={route} onRoute={go} />
      <div className="page">{page}</div>
    </div>
  );
}
