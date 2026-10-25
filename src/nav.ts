// App-wide navigation, so menus and cards anywhere can open an item, play it or switch
// screens without passing callbacks through every component.
export type View =
  | "home" | "library" | "collections" | "renamer" | "metadata" | "subtitles" | "intros" | "add"
  | "storage" | "downloads" | "settings" | "health" | "missing" | "duplicates" | "tags" | "history" | "cleanup";

export interface Route {
  view: View;
  /** library id when view is "library" */
  library?: string;
  /** "unmatched" | "noposter" filter for the library */
  flag?: string;
  /** collection id when view is "collections" */
  collection?: string;
  /** renamer: start on this folder / item */
  folder?: string;
  item?: string;
  /** settings: section to scroll to */
  section?: string;
  /** Changes on every menu click, so the screen starts fresh. */
  n?: number;
}

export interface OpenOpts {
  /** Tab to show on the item page ("rename", "identify", "cast", a season id …). */
  tab?: string;
}

interface Nav {
  open: (id: string, opts?: OpenOpts) => void;
  play: (id: string) => void;
  route: (r: Route) => void;
}

let impl: Nav = { open: () => undefined, play: () => undefined, route: () => undefined };

export function setNav(n: Nav): void {
  impl = n;
}

export const nav: Nav = {
  open: (id, opts) => impl.open(id, opts),
  play: (id) => impl.play(id),
  route: (r) => impl.route(r),
};
