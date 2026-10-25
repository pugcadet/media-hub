// Which top-level library folder ("TV", "Kids", "Anime" …) each title is in, from the last
// library health check. Shared by every screen that filters or groups by folder.
import { useEffect, useState } from "react";
import { api } from "./api";
import { useEpoch } from "./activity";

let cache: { epoch: number; map: Map<string, string> } | null = null;
let pending: Promise<Map<string, string>> | null = null;

function load(epoch: number): Promise<Map<string, string>> {
  if (cache && cache.epoch === epoch) return Promise.resolve(cache.map);
  pending ??= api.libraryHealth(false)
    .then((h) => new Map(h.rows.map((r) => [r.id, r.libraryFolder || "Other"])))
    .catch(() => new Map<string, string>())
    .then((map) => { cache = { epoch, map }; pending = null; return map; });
  return pending;
}

/** The folder map without a component (for background work). */
export function folderMap(epoch = 0): Promise<Map<string, string>> {
  return cache ? Promise.resolve(cache.map) : load(epoch);
}

/** id → folder name (movies and shows; for an episode look up its SeriesId). */
export function useFolderMap(): Map<string, string> {
  const epoch = useEpoch();
  const [map, setMap] = useState<Map<string, string>>(cache?.map ?? new Map());
  useEffect(() => { let alive = true; void load(epoch).then((m) => alive && setMap(m)); return () => { alive = false; }; }, [epoch]);
  return map;
}

/** Every folder name, sorted. */
export function foldersOf(map: Map<string, string>): string[] {
  return [...new Set(map.values())].sort((a, b) => a.localeCompare(b));
}

/** "folder:Kids" → "Kids" (the id a folder tab gets), otherwise null. */
export function tabFolder(tabId: string | null | undefined): string | null {
  return tabId?.startsWith("folder:") ? tabId.slice(7) : null;
}
