# Media Hub

A companion app for Jellyfin + Infuse. It runs on your Mac or Windows PC, talks to your
Jellyfin server over your home network, and keeps your NAS as a plain file share.

**Module 1 (this version):** connect to Jellyfin, browse the library, picks of the day.
Read-only: it cannot change anything on your server.

## Install

1. Open the **Releases** page of this repository and download the newest file for your computer
   (`.dmg` for Mac, `.exe` for Windows).
2. The app is not signed with a paid developer certificate, so the first start needs one extra click:
   - **Mac:** drag Media Hub to Applications, then right-click it and choose **Open**, then **Open** again.
     If macOS says the app is damaged, run this once in Terminal:
     `xattr -dr com.apple.quarantine "/Applications/Media Hub.app"`
   - **Windows:** if SmartScreen appears, choose **More info**, then **Run anyway**.
3. Enter your Jellyfin address (for example `http://192.168.1.20:8096`) and an API key
   (Jellyfin Dashboard → Advanced → API Keys → +).

## Where things live

| What | Where |
| --- | --- |
| Videos | On the NAS, untouched |
| API key | macOS Keychain / Windows Credential Manager. Never in a file. |
| Library cache, settings | The app's data folder on this computer |

## How the code is organised

- `src-tauri/src/jellyfin.rs` – the Jellyfin client. It can only send GET requests.
- `src-tauri/src/store.rs` – local SQLite cache, including an empty undo journal for later modules.
- `src-tauri/src/picks.rs` – deterministic picks of the day (pure logic, unit tested).
- `src-tauri/src/images.rs` – serves pictures to the window so it never sees the key.
- `src/` – the window (React + TypeScript).

Tests: `cargo test --manifest-path src-tauri/Cargo.toml`
