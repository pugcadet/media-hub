import type { View } from "./App";

/** Navigation now lives in the sidebar (see Sidebar.tsx). Kept so older screens still compile. */
export default function Nav(_props: { current: View; onNav: (v: View) => void }) {
  return null;
}
