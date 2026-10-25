# Media Hub

A companion app for Jellyfin + Infuse, for Mac and Windows. It does the heavy work on your
computer, talks to your Jellyfin server over your home network, and treats the NAS as a plain
file share. Infuse keeps reading everything from Jellyfin, so whatever you fix here shows up there.

## What it does

The hub in the top-left corner switches between the **Media manager** (fix things) and the
**Player** (browse and watch). Music and downloads will get their own place there later.

| Screen | What you can do |
| --- | --- |
| **Home** | Continue watching, next up, picks of the day (also kept in Jellyfin as a collection, so Infuse shows them), recently added, collections. |
| **Library / Collections** | Browse, search, sort. Right-click any title: play, go to the show or season, mark watched, add to a collection, identify, rename, fill in artwork, show in Finder. |
| **Item page** | Edit details · identify (updates the artwork too) · artwork tab with every kind of picture, all backdrops (make main, remove, undo), click to enlarge · cast and “more like this” · rename the files of just this title · per-season episodes with subtitle status, subtitle and intro tools on top. |
| **Add show or movie** | Pick a folder or file from anywhere, say what it is, choose the library folder: it is put in place with the right name, the files are named, Jellyfin scans, the match is linked and the artwork is filled in. |
| **Renamer** | *Library check*: every show and movie that is named wrong, and why; 100% matches rename in bulk; open any row to fix it by hand. *Pick a folder*: the detailed renamer with a preview of how Infuse will show it. |
| **Subtitles** | Candidates with a match score (100 = made for exactly this file, the default minimum) · built-in subtitles count, so nothing is downloaded twice. |
| **Intros & credits** | Auto-detect by listening to the audio · timeline to draw or type times · preview an episode and press I / O to set the start and end while watching · remove recaps, intros or credits for a season or a whole show. |
| **Player** | Resume, up next with autoplay, skip intro/credits buttons (optionally automatic), C for your subtitle language (fetched online without stopping if missing), subtitle size/font/box/shadow/height, preview pictures while scrubbing, a pause screen with the title's art, info and cast, ↑/↓ volume. |
| **Settings** | Player and subtitle look, recaps on/off, daily scheduled tasks (scan, picks, artwork, subtitles). |
| **Storage / Downloads** | Parked for now (code kept). |

The bar at the top shows what Media Hub is doing; screens reload by themselves when a job finishes,
and the round arrow reloads everything.

## Safety

- **Read-only by default.** Nothing in Jellyfin changes until you switch on *Allow changes* in Settings.
- **Everything can be undone.** Every Jellyfin change, rename and file swap is written to an undo journal first.
- **Nothing is deleted.** Renames never overwrite; replaced originals go to a hidden `.mediahub-trash` folder
  that only you can empty (you have to type DELETE).
- **Your key stays secret.** The Jellyfin API key lives in the macOS Keychain / Windows Credential Manager and
  is only ever sent to your server. The app window never sees it.
- **No shell, no surprises.** ffmpeg and yt-dlp are started directly with a fixed set of options; yt-dlp
  downloads are checked against their published checksum.

## Install

1. Open the **Releases** page of this repository and download the newest file for your computer
   (`.dmg` for Mac, `-setup.exe` for Windows).
2. The app is not signed with a paid developer certificate, so the first start needs one extra click:
   - **Mac:** drag Media Hub to Applications, right-click it, choose **Open**, then **Open** again.
     If macOS says the app is damaged, run once in Terminal:
     `xattr -dr com.apple.quarantine "/Applications/Media Hub.app"`
   - **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
3. Enter your Jellyfin address (e.g. `http://192.168.1.20:8096`) and an API key
   (Jellyfin Dashboard → Advanced → API Keys → +).

### Optional one-time extras

| For | Install |
| --- | --- |
| Intro detection, Storage tools | ffmpeg — Mac: `brew install ffmpeg` · Windows: `winget install Gyan.FFmpeg` |
| Saving intros/credits to Jellyfin | Jellyfin plugin **MediaSegments API** (Dashboard → Plugins → Catalog), then restart Jellyfin |
| Subtitle downloads | Jellyfin plugin **Open Subtitles** (signed in) |
| Downloads | Press **Install yt-dlp** on the Downloads screen |

## Where things live

| What | Where |
| --- | --- |
| Videos | On the NAS |
| API key | macOS Keychain / Windows Credential Manager |
| Library cache, settings, undo journal, picture backups | The app's data folder on this computer |
| Replaced originals (Storage) | `.mediahub-trash` in your library folder |

## Code

- `src-tauri/src/` – Rust core. Pure logic is unit tested (`cargo test --manifest-path src-tauri/Cargo.toml`):
  `naming.rs`, `planner.rs` (renamer), `fingerprint.rs`, `detect.rs` (intros), `subs.rs` (scores),
  `picks.rs`, `storage.rs`, `downloads.rs`, `player.rs`.
  `downloads.rs` (the Goblin module) is shared with the standalone [Goblin](https://github.com/pugcadet/goblin) app: keep both copies identical.
  `jellyfin.rs` holds the read-only `Client` and the separate `Writer`, which only exists when changes are allowed.
- `src/` – the window (React + TypeScript).
- `.github/workflows/build.yml` – builds and tests on Mac and Windows, then publishes the installers.
