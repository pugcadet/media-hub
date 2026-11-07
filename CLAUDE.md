# Media Hub — notes for Claude

Media Hub is a Tauri 2 desktop app (Rust in `src-tauri/`, React + TypeScript in `src/`) for Mac and
Windows: a local companion for a Jellyfin server (library on a Synology NAS) and Infuse.

## How the owner wants to work
- They're a beginner: explain simply, in plain words, no jargon.
- Fix things everywhere they apply, not just the one spot reported. Know the end goal and deliver
  working results; don't leave in-between bugs for them to find.
- Test before showing: build, run the tests, and look at the real app before saying it's done.
- Show a concept first for bigger UI changes, and ask questions when unsure. Offer options.
- Pushing (and releasing) is allowed without asking, once the build, tests and screenshots
  check out. Work-in-progress may go to a `check/...` branch first.
- Always fetch and rebase before pushing.

## Safety rules (never break these)
- Never delete or overwrite their files: everything is undoable, journaled (History), or moved to the Trash.
- Never ask for or handle the Jellyfin address, the API key, or a TMDB key.
- Confirmations use the app's own confirm dialog (`askConfirm`), never browser alerts.

## Look
- Jellyfin colours: background #101010, gradient #AA5CC3 → #00A4DC, primary #00A4DC.
- Top bar: Home, Library, Jellyfin; "+ Inbox" (with count), History, Settings on the right.
- Library steps in this order: Identify, Artwork, Naming, Subtitles, Intros.

## Building and checking
- `npm install`, then `npm run tauri dev` to run the app; `npx tsc --noEmit` for types.
- `cargo test --manifest-path src-tauri/Cargo.toml` for the Rust tests.
- Screenshots of every screen with test data: `screens/shoot.mjs` (uses `screens/mock.js`).

## Releasing (only when asked)
1. Bump the version in: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
   `package-lock.json` (lines 3 and 9) and the `media-hub` entry in `src-tauri/Cargo.lock`.
2. Commit as: `git -c user.name="Media Hub" -c user.email="noreply@users.noreply.github.com" commit`
3. Push to `main`: GitHub Actions builds the Mac and Windows installers and publishes release `v<version>`.

## Intros (skip markers)
Saving works the way Jellyfin's Segment Editor does: read `MediaSegmentsApi/{id}` with its ETag,
replace the set with `PUT` + `If-Match`, fall back to delete + `POST ?providerId=IntroSkipper`,
then read back `MediaSegments/{id}` and only report "Saved and confirmed" when it's there.
