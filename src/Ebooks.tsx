// Ebooks: the books in the library's Ebooks folder, matched with Open Library (free, no key).
// Saving a match gives a book its own folder with a metadata.opf and cover.jpg next to it, the
// way Jellyfin reads books. The book file itself is never changed; History can undo it all.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorText, remoteImageUrl, type Book, type BookMatch } from "./api";
import { track } from "./activity";
import { askConfirm } from "./confirm";
import { usePageState } from "./saved";
import { SearchBox, Seg, Toolbar } from "./kit";
import { Studio, type StudioItem } from "./Studio";
import { Icon } from "./ui";

/** The list as last read, so coming back shows it at once. */
let LAST: { folder: string | null; books: Book[] } | null = null;

const cover = (id: number, size: "M" | "L" = "M") => remoteImageUrl(`https://covers.openlibrary.org/b/id/${id}-${size}.jpg`);
const byLine = (m: { authors: string[]; year: number | null }) => [m.authors.slice(0, 2).join(", "), m.year].filter(Boolean).join(" · ");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Ebooks({ canEdit }: { canEdit: boolean }) {
  const [list, setList] = useState(LAST);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = usePageState<"todo" | "done" | "all">("books.filter", "all");
  const [sel, setSel] = usePageState<string | null>("books.sel", null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    return api.booksList().then((l) => { LAST = l; setList(l); }).catch((e) => setError(errorText(e)));
  }, []);
  useEffect(() => void load(), [load]);

  const books = list?.books ?? [];
  const todo = books.filter((b) => !b.done).length;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return books.filter((b) => (filter === "all" || (filter === "done") === b.done)
      && (!q || `${b.meta.title} ${b.meta.authors.join(" ")} ${b.file}`.toLowerCase().includes(q)));
  }, [books, query, filter]);
  useEffect(() => { if (shown.length && !shown.some((b) => b.rel === sel)) setSel(shown[0].rel); }, [shown, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: StudioItem[] = shown.map((b) => ({
    id: b.rel,
    title: b.meta.title || b.file,
    sub: b.from === "name" ? `${b.ext} · only the file name to go on` : `${byLine(b.meta) || b.ext}`,
    pic: <span className="bk-thumb"><Icon name="book" size={18} /></span>,
    tail: <span className={`small strong ${b.done ? "ok" : "warn-t"}`}>{b.done ? "Matched" : "Check"}</span>,
  }));
  const selected = books.find((b) => b.rel === sel) ?? null;

  async function matchSure() {
    const cands = books.filter((b) => !b.done && b.from !== "name");
    if (!cands.length) return setNote("Nothing to match by itself: the books left only have a file name to go on. Pick their match one by one.");
    if (!(await askConfirm(`Look up ${cands.length} book${cands.length === 1 ? "" : "s"} on Open Library and save the ones whose title and author match exactly?\n\nEach gets its own folder with its details and cover next to it. The book files themselves aren't changed, and History can undo every one.`, { okLabel: "Match them" }))) return;
    let saved = 0;
    let unsure = 0;
    await track("Matching books", async (job) => {
      for (const [i, b] of cands.entries()) {
        if (job.cancelled) break;
        job.update(b.meta.title, i / cands.length);
        const found = await api.booksSearch(b.meta).catch(() => []);
        const best = found[0];
        if (best?.sure) {
          const desc = await api.booksDescription(best.key).catch(() => null);
          if (await api.booksSave(b.rel, best, desc).then(() => true).catch(() => false)) saved++;
        } else unsure++;
        // Open Library is free: ask it gently.
        await sleep(400);
      }
    }, { cancellable: true }).catch(() => undefined);
    setNote(`${saved} book${saved === 1 ? "" : "s"} matched and saved.${unsure ? ` ${unsure} need you to pick: they're under “To check”.` : ""}`);
    await load();
  }

  if (list && !list.folder) {
    return (
      <div className="card stack-s">
        <div className="strong">No Ebooks folder yet</div>
        <p className="muted small">Make a folder called “Ebooks” in your library folder and put your books in it (EPUB, PDF, MOBI, AZW3, CBZ …). Media Hub then finds their details and covers here.</p>
        <div><button onClick={() => void load()}><Icon name="reload" /> Look again</button></div>
      </div>
    );
  }

  return (
    <>
      <div className="lib-filters">
        <div className="row">
          <span className="muted small">{list ? `${books.length} book${books.length === 1 ? "" : "s"} in ${list.folder} · ${books.length - todo} matched · ${todo} to check` : ""}</span>
          <span className="spacer" />
          <button onClick={() => void load()} title="Reads the Ebooks folder again"><Icon name="reload" /> Refresh</button>
          <button className="primary" disabled={!canEdit || !todo} onClick={() => void matchSure()} title="Saves the books whose title and author match Open Library exactly"><Icon name="wand" /> Match the sure ones</button>
        </div>
        <Toolbar>
          <SearchBox value={query} onChange={setQuery} placeholder="Find a book or author" />
          <Seg value={filter} onChange={setFilter} options={[{ id: "all", label: "All" }, { id: "todo", label: `To check${todo ? ` ${todo}` : ""}` }, { id: "done", label: "Matched" }]} />
        </Toolbar>
      </div>
      {error && <p className="error">{error} <button className="link" onClick={() => void load()}>Try again</button></p>}
      {note && <p className="note bk-note" role="status">{note}</p>}
      {!canEdit && <p className="note small bk-note">Viewing only: changes are switched off in Settings, so matches can't be saved.</p>}
      <Studio items={items} selected={sel} onSelect={setSel} empty={list ? (filter === "all" && !query ? "No books in the Ebooks folder yet." : "Nothing here.") : <span><span className="spinner" /> Reading your books…</span>}>
        {selected && <BookDetail key={selected.rel} book={selected} canEdit={canEdit} onSaved={(rel, text) => { setNote(text); setSel(rel); void load(); }} />}
      </Studio>
    </>
  );
}

function BookDetail({ book, canEdit, onSaved }: { book: Book; canEdit: boolean; onSaved: (rel: string, note: string) => void }) {
  const [found, setFound] = useState<BookMatch[] | null>(null);
  const [pick, setPick] = useState(0);
  const [desc, setDesc] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [others, setOthers] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback((t?: string) => {
    setFound(null); setError(null); setPick(0); setOthers(false);
    api.booksSearch(book.meta, t).then(setFound).catch((e) => { setError(errorText(e)); setFound([]); });
  }, [book.meta]);
  useEffect(() => search(), [search]);

  const m = found?.[pick] ?? null;
  useEffect(() => {
    setDesc(null); setMore(false);
    if (m) api.booksDescription(m.key).then(setDesc).catch(() => setDesc(null));
  }, [m?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = m ? `${m.authors[0] ? `${m.authors[0]} - ` : ""}${m.title}${m.year ? ` (${m.year})` : ""}` : "";
  async function save() {
    if (!m) return;
    setBusy(true); setError(null);
    try {
      const rel = await track(`Saving ${m.title}`, () => api.booksSave(book.rel, m, desc));
      onSaved(rel, `Saved “${m.title}”${m.coverId ? " with its cover" : ""}. Jellyfin picks it up with its next library scan; History can undo it.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack bk-detail">
      <section className="card stack-xs">
        <div className="muted small">In your Ebooks folder</div>
        <div className="mono small">{book.rel}</div>
        {book.from === "name" && <div className="small warn-t">The file itself says nothing about the book, only its name: check the match below.</div>}
        {book.from === "file" && <div className="small muted">The details below the file name came from inside the book.</div>}
        {book.done && <div className="small ok">Matched: its own folder, details and cover are there.</div>}
      </section>

      <section className="card bk-match">
        {!found && <div className="muted"><span className="spinner small-spin" /> Looking it up on Open Library…</div>}
        {found && !m && <div className="stack-s"><div className="strong">Nothing found on Open Library</div><div className="muted small">Search by its title, the author, or the ISBN (on the back of the book or in its first pages).</div></div>}
        {m && (
          <div className="bk-row">
            <div className="bk-cover">
              {m.coverId ? <img src={cover(m.coverId)} alt={`Cover of ${m.title}`} /> : <div className="bk-nocover"><Icon name="book" size={28} /><span className="small">No cover on Open Library</span></div>}
            </div>
            <div className="grow stack-s">
              <div className="row">
                <span className={`chip static ${m.sure ? "ok" : ""}`}>{m.sure ? "Best match · sure" : pick === 0 ? "Best guess · check it" : "Your pick"}</span>
                <span className="muted small">from Open Library</span>
              </div>
              <h2 className="bk-title">{m.title}</h2>
              <div className="muted">{[m.authors.join(", "), m.year, m.publisher].filter(Boolean).join(" · ")}</div>
              <div className="bk-facts small">
                {m.isbn && <span><span className="muted">ISBN</span> <span className="mono">{m.isbn}</span></span>}
                {m.pages && <span><span className="muted">Pages</span> {m.pages}</span>}
                {m.editions > 0 && <span><span className="muted">Editions</span> {m.editions}</span>}
                {m.subjects.length > 0 && <span><span className="muted">Subjects</span> {m.subjects.slice(0, 3).join(", ")}</span>}
              </div>
              {desc && <p className={`small bk-desc ${more ? "" : "short"}`}>{desc} </p>}
              {desc && desc.length > 280 && <button className="link small" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button>}
              <div className="bk-does small">
                <div className="strong">Saving it does this</div>
                <div>{book.ownFolder ? "Puts its details (title, author, year, description) in a metadata.opf next to it, so Jellyfin shows them." : `Gives it a folder of its own, “${name}”, with its details in a metadata.opf, so Jellyfin shows them.`}</div>
                <div>{m.coverId ? "Saves the cover as cover.jpg next to it." : "There's no cover to add."}{book.hasCover || book.hasOpf ? " What's there now goes to the trash folder." : ""}</div>
                <div className="muted">The book file itself isn't changed. Undo in History.</div>
              </div>
              {error && <p className="error">{error}</p>}
              <div className="row">
                <button className="primary" disabled={!canEdit || busy} onClick={() => void save()}>{busy ? <span className="spinner small-spin" /> : <Icon name="check" />} Save this match</button>
                {found && found.length > 1 && <button onClick={() => setOthers(!others)}>Other matches ({found.length - 1})</button>}
              </div>
            </div>
          </div>
        )}
        {others && found && (
          <div className="bk-others">
            {found.map((x, i) => (
              <button key={x.key} className={`bk-other ${i === pick ? "on" : ""}`} onClick={() => { setPick(i); setOthers(false); }}>
                <span className="bk-mini">{x.coverId ? <img src={cover(x.coverId)} alt="" loading="lazy" /> : <Icon name="book" size={16} />}</span>
                <span className="grow stack-xs"><span className="strong small">{x.title}</span><span className="muted small">{byLine(x)}{x.editions ? ` · ${x.editions} editions` : ""}</span></span>
                {x.sure && <span className="small ok">sure</span>}
              </button>
            ))}
          </div>
        )}
        {error && !m && <p className="error">{error}</p>}
        <form className="row bk-search" onSubmit={(e) => { e.preventDefault(); if (text.trim()) search(text); }}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by title, author or ISBN" aria-label="Search Open Library" />
          <button type="submit" disabled={!text.trim()}><Icon name="search" /> Search</button>
        </form>
      </section>
    </div>
  );
}
