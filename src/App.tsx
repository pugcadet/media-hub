import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Attention, errorText, Library as Lib, Status } from "./api";
import Setup from "./Setup";
import Library from "./Library";
import Renamer from "./Renamer";
import Settings from "./Settings";
import Downloads from "./Downloads";
import ItemPage from "./ItemPage";
import Sidebar from "./Sidebar";
import { SubtitlesTool } from "./Tools";
import IntrosTool from "./IntrosTool";
import Dashboard from "./Dashboard";
import Collections from "./Collections";
import AddMedia from "./AddMedia";
import Watch from "./Watch";
import Player from "./Player";
import { ActivityBar } from "./ui";
import { UpdateToast } from "./Updates";
import Music from "./Music";
import { setNav, type OpenOpts, type Route, type View } from "./nav";
import { useEpoch } from "./activity";
import { prefs, setPrefs, usePrefs } from "./prefs";
import { startScheduler } from "./scheduler";
import Health from "./Health";
import Cleanup from "./Cleanup";
import History from "./History";

export type { Route, View } from "./nav";

interface Open {
  id: string;
  tab?: string;
  n: number;
}

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>({ view: "home" });
  const [itemStack, setItemStack] = useState<Open[]>([]);
  const [libraries, setLibraries] = useState<Lib[]>([]);
  const [attention, setAttention] = useState<Attention | null>(null);
  const [playId, setPlayId] = useState<string | null>(null);
  const epoch = useEpoch();
  const { mode } = usePrefs();

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
  }, [refresh, epoch]);

  const go = useCallback((r: Route) => {
    setItemStack([]);
    setRoute({ ...r, n: Date.now() });
    // A link to a manager screen (e.g. "Turn them on" in the player) switches to the manager.
    if (prefs().mode !== "manage") setPrefs({ mode: "manage" });
  }, []);

  // ⌘, (Ctrl+, on Windows) opens Settings, like every Mac app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        go({ view: "settings" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);
  const navTo = useCallback((v: View) => go({ view: v }), [go]);
  const open = useCallback((id: string, opts?: OpenOpts) => {
    setItemStack((s) => {
      const top = s[s.length - 1];
      // Same item again (e.g. "Rename files…" from its own page): switch the tab only.
      if (top && top.id === id) return [...s.slice(0, -1), { id, tab: opts?.tab, n: top.n + 1 }];
      return [...s, { id, tab: opts?.tab, n: 0 }];
    });
  }, []);

  useEffect(() => {
    setNav({ open, play: (id) => setPlayId(id), route: go });
  }, [open, go]);

  useEffect(() => {
    if (status?.connected) return startScheduler(status);
  }, [status?.connected, status?.readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const top = itemStack[itemStack.length - 1];
  const back = useCallback(() => setItemStack((s) => s.slice(0, -1)), []);

  const player = useMemo(
    () => playId && status ? <Player key={playId} id={playId} status={status} onClose={() => setPlayId(null)} onNext={(n) => setPlayId(n)} /> : null,
    [playId, status],
  );

  if (fatal) return <div className="center"><p className="error">{fatal}</p></div>;
  if (!status) return <div className="center"><p className="muted">Starting…</p></div>;
  if (!status.connected) return <Setup status={status} onDone={refresh} />;

  if (mode === "watch") {
    return (
      <>
        <Watch status={status} libraries={libraries} item={top ?? null} onBack={back} />
        {player}
        <UpdateToast />
      </>
    );
  }
  if (mode === "music") {
    return (
      <>
        <Music status={status} />
        <UpdateToast />
      </>
    );
  }

  let page;
  if (top) {
    page = (
      <ItemPage
        key={top.id}
        id={top.id}
        initialTab={top.tab}
        tabNonce={top.n}
        onBack={back}
        onOpen={(id) => open(id)}
        onNav={navTo}
        subLangs={status.subLangs}
        titleLang={status.titleLang}
        status={status}
      />
    );
  } else {
    switch (route.view) {
      case "home":
        page = <Dashboard status={status} />;
        break;
      case "health":
        page = <Health status={status} focus="all" />;
        break;
      case "cleanup":
      case "missing":
      case "duplicates":
      case "tags":
        page = <Cleanup status={status} tab={route.view === "cleanup" ? route.section : route.view} onNav={navTo} />;
        break;
      case "history":
        page = <History status={status} />;
        break;
      case "collections":
        page = <Collections status={status} selected={route.collection ?? null} />;
        break;
      case "add":
        page = <AddMedia status={status} onChanged={refresh} />;
        break;
      case "renamer":
        page = <Renamer key={`${route.folder ?? ""}-${route.item ?? ""}`} status={status} onChanged={refresh} onNav={navTo} start={route.folder !== undefined ? { folder: route.folder, item: route.item } : undefined} />;
        break;
      case "metadata":
        page = <Health status={status} focus="art" />;
        break;
      case "subtitles":
        page = <SubtitlesTool status={status} onOpen={(id) => open(id)} />;
        break;
      case "intros":
        page = <IntrosTool status={status} onNav={navTo} />;
        break;
      case "storage":
        page = <Cleanup status={status} tab="storage" onNav={navTo} />;
        break;
      case "downloads":
        page = <Downloads onNav={navTo} />;
        break;
      case "settings":
        page = <Settings status={status} onChanged={refresh} onNav={navTo} section={route.section} />;
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
            onOpen={(id) => open(id)}
          />
        );
    }
  }

  return (
    <div className="shell">
      <Sidebar status={status} libraries={libraries} attention={attention} route={route} onRoute={go} />
      <div className="main-col">
        <ActivityBar />
        <div className="page" key={`${route.view}-${route.n ?? 0}-${top?.id ?? ""}`}>{page}</div>
      </div>
      {player}
      <UpdateToast />
    </div>
  );
}
