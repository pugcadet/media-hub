import { useCallback, useEffect, useState } from "react";
import { api, errorText, Status } from "./api";
import Connect from "./Connect";
import Library from "./Library";

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

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
  return <Library status={status} onChanged={refresh} />;
}
