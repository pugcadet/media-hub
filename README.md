# Media Hub

A companion app for Jellyfin + Infuse, for Mac and Windows. It does the heavy work on your
computer, talks to your Jellyfin server over your home network, and treats the NAS as a plain
file share. Infuse keeps reading everything from Jellyfin, so whatever you fix here shows up there.

## What it does

| Screen | What you can do |
| --- | --- |
| **Library** | Browse movies and shows from Jellyfin, search, sort, picks of the day. |
| **Item page** | Edit details, ratings and ids · identify via TMDB/TVDB · pick or upload poster, backdrop, logo, thumbnail and banner (per show and per season) · play. |
| **Subtitles** (movie/episode) | Candidates with a match score (100 = made for exactly this file) · per-season "get missing subtitles". |
| **Intros & credits** (season) | Auto-detect by listening to the audio (plus chapter names) · timeline to check or draw times · save as skip markers in Jellyfin. |
| **Renamer** | Jellyfin/Infuse-style names with a preview, episode titles from Jellyfin, find & replace, subtitles move along. |
| **Storage** | Shrink movies to H.265 with the graphics chip · even out loudness (volume only) · originals kept in a trash folder until you empty it. |
| **Downloads** | yt-dlp for videos and music · save a channel or playlist as a series (Show / Season 01 / S01E01). |
| **Player** | Plays through Jellyfin with skip intro/credits and subtitles. |

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
