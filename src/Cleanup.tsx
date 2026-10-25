// Clean-up: the tools you need now and then, together under one menu item with tabs.
import { useState } from "react";
import type { Status } from "./api";
import type { View } from "./nav";
import { Tabs } from "./ui";
import Duplicates from "./Duplicates";
import Missing from "./Missing";
import Tags from "./Tags";
import Storage from "./Storage";
import { SubtitleCleanup } from "./Tools";

export type CleanupTab = "duplicates" | "missing" | "tags" | "subs" | "storage";

const TABS: { id: CleanupTab; label: string }[] = [
  { id: "duplicates", label: "Duplicates" },
  { id: "missing", label: "Missing episodes" },
  { id: "tags", label: "Genres and tags" },
  { id: "subs", label: "Extra subtitles" },
  { id: "storage", label: "Storage" },
];

export default function Cleanup({ status, tab, onNav }: { status: Status; tab?: string; onNav: (v: View) => void }) {
  const [t, setT] = useState<CleanupTab>((TABS.find((x) => x.id === tab)?.id ?? "duplicates") as CleanupTab);
  return (
    <div className="pg cleanup">
      <div className="pg-head compact-head">
        <h1>Clean-up</h1>
        <Tabs tabs={TABS} active={t} onChange={(id) => setT(id as CleanupTab)} />
      </div>
      <div className="cleanup-body" key={t}>
        {t === "duplicates" && <Duplicates status={status} />}
        {t === "missing" && <Missing status={status} />}
        {t === "tags" && <Tags status={status} />}
        {t === "subs" && <SubtitleCleanup status={status} />}
        {t === "storage" && <Storage status={status} onNav={onNav} />}
      </div>
    </div>
  );
}
