// The small music player at the bottom of every screen while music plays and you're not in Music.
import { useEffect, useState } from "react";
import { imageUrl } from "./api";
import { useMusicPlayer } from "./musicPlayer";
import { setPrefs, usePrefs } from "./prefs";
import { fmt } from "./Intros";
import { Icon } from "./ui";

export function MiniPlayer() {
  const { mode } = usePrefs();
  const p = useMusicPlayer();
  const cur = p.current;
  const show = !!cur && mode !== "music";
  const [bad, setBad] = useState(false);
  useEffect(() => setBad(false), [cur?.id]);
  useEffect(() => {
    document.body.classList.toggle("has-mini", show);
  }, [show]);
  if (!show || !cur) return null;
  const st = p.st;
  const dur = st.duration || cur.duration || 0;
  const art = cur.artUrl ?? (cur.hasArt ? imageUrl(cur.artId, "Primary", 120) : null);
  return (
    <div className="mini" role="region" aria-label="Music playing">
      <div className="mini-progress" style={{ width: dur ? `${Math.min(100, (st.time / dur) * 100)}%` : "0%" }} />
      <button className="mini-art" onClick={() => setPrefs({ mode: "music" })} title="Open Music">
        {art && !bad ? <img src={art} alt="" onError={() => setBad(true)} /> : <Icon name="music" size={18} />}
      </button>
      <button className="mini-names link-plain" onClick={() => setPrefs({ mode: "music" })} title="Open Music">
        <span className="strong ellipsis small">{cur.name}</span>
        <span className="muted ellipsis small">{cur.artist}{dur ? ` · ${fmt(st.time)} / ${fmt(dur)}` : ""}</span>
      </button>
      <div className="mini-ctl">
        <button className="icon-btn" onClick={p.prev} aria-label="Previous" title="Previous"><Icon name="prev" size={14} /></button>
        <button className="mini-play" onClick={p.toggle} aria-label={st.playing ? "Pause" : "Play"} title={st.playing ? "Pause" : "Play"}>
          {st.loading ? <span className="spinner" /> : <Icon name={st.playing ? "pause" : "play"} size={16} />}
        </button>
        <button className="icon-btn" onClick={p.next} aria-label="Next" title="Next" disabled={st.index + 1 >= st.queue.length}><Icon name="next" size={14} /></button>
        <button className="icon-btn" onClick={p.stop} aria-label="Stop and close" title="Stop and close"><Icon name="x" size={14} /></button>
      </div>
    </div>
  );
}
