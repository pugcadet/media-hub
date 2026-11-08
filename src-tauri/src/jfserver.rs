//! The Jellyfin page: server version and updates, plugins, scheduled tasks and recent problems.
//! Everything here only reads, except running/stopping a task and restarting (both asked first in the window).

use crate::error::{Error, Result};
use crate::state::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

/// "10.10.3" → [10, 10, 3]; anything that isn't a number counts as 0.
pub(crate) fn ver(v: &str) -> Vec<u64> {
    v.trim_start_matches('v').split('.').map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0)).collect()
}

pub(crate) fn newer(a: &str, b: &str) -> bool {
    let (mut x, mut y) = (ver(a), ver(b));
    let n = x.len().max(y.len());
    x.resize(n, 0);
    y.resize(n, 0);
    x > y
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerPlugin {
    name: String,
    version: String,
    status: String,
    /// A newer version that works with this server, when the catalogue has one.
    update: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerTask {
    id: String,
    name: String,
    category: String,
    key: String,
    state: String,
    progress: Option<f64>,
    last_status: Option<String>,
    last_end: Option<String>,
    last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerEvent {
    name: String,
    overview: String,
    severity: String,
    date: String,
}

/// Someone watching something now.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playing {
    title: String,
    /// Item to show the poster of (the show for an episode).
    art_id: String,
    user: String,
    device: String,
    /// "Direct play" or "Transcoding: HEVC → H.264 (reason)".
    how: String,
    transcoding: bool,
    paused: bool,
    progress: Option<f64>,
}

/// Something watched lately (from Jellyfin's activity log).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Watched {
    title: String,
    user: String,
    date: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    path: String,
    free: u64,
    total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerOverview {
    name: String,
    version: String,
    os: String,
    pending_restart: bool,
    /// Newest Jellyfin release on GitHub, when it could be looked up.
    latest: Option<String>,
    update_available: bool,
    /// Jellyfin could read its plugin catalogue (needs internet; fails when its DNS is broken).
    catalog_ok: bool,
    plugins: Vec<ServerPlugin>,
    tasks: Vec<ServerTask>,
    events: Vec<ServerEvent>,
    playing: Vec<Playing>,
    watched: Vec<Watched>,
    disks: Vec<Disk>,
}

fn playing_of(v: &Value) -> Option<Playing> {
    let it = v.get("NowPlayingItem")?;
    let ps = v.get("PlayState");
    let series = s(it, "SeriesName");
    let title = if !series.is_empty() {
        match (it.get("ParentIndexNumber").and_then(|x| x.as_i64()), it.get("IndexNumber").and_then(|x| x.as_i64())) {
            (Some(a), Some(b)) => format!("{series} · S{a:02}E{b:02}"),
            _ => format!("{series} · {}", s(it, "Name")),
        }
    } else {
        match it.get("ProductionYear").and_then(|y| y.as_i64()) {
            Some(y) => format!("{} ({y})", s(it, "Name")),
            None => s(it, "Name").to_string(),
        }
    };
    let art = if s(it, "SeriesId").is_empty() { s(it, "Id") } else { s(it, "SeriesId") }.replace('-', "");
    let method = ps.map(|p| s(p, "PlayMethod")).unwrap_or("");
    let ti = v.get("TranscodingInfo");
    let transcoding = method == "Transcode";
    let how = if transcoding {
        let src = it.get("MediaStreams").and_then(|m| m.as_array()).and_then(|a| a.iter().find(|x| s(x, "Type") == "Video")).map(|x| s(x, "Codec").to_uppercase()).unwrap_or_default();
        let to = ti.map(|t| s(t, "VideoCodec").to_uppercase()).unwrap_or_default();
        let why: Vec<String> = ti
            .and_then(|t| t.get("TranscodeReasons"))
            .and_then(|r| r.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str()).map(|x| x.replace("NotSupported", " not supported")).collect())
            .unwrap_or_default();
        let codecs = if !src.is_empty() && !to.is_empty() && src != to { format!(": {src} → {to}") } else { String::new() };
        format!("Transcoding{codecs}{}", if why.is_empty() { String::new() } else { format!(" ({})", why.join(", ")) })
    } else if method == "DirectStream" {
        "Direct stream".into()
    } else {
        "Direct play".into()
    };
    let pos = ps.and_then(|p| p.get("PositionTicks")).and_then(|x| x.as_f64());
    let total = it.get("RunTimeTicks").and_then(|x| x.as_f64()).filter(|t| *t > 0.0);
    Some(Playing {
        title,
        art_id: art,
        user: s(v, "UserName").into(),
        device: [s(v, "Client"), s(v, "DeviceName")].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join(" · "),
        how,
        transcoding,
        paused: ps.and_then(|p| p.get("IsPaused")).and_then(|b| b.as_bool()).unwrap_or(false),
        progress: pos.zip(total).map(|(p, t)| (p / t).clamp(0.0, 1.0)),
    })
}

/// "Anna has finished playing Heat on Apple TV" → ("Heat", "Anna").
fn watched_of(e: &Value) -> Option<Watched> {
    let kind = s(e, "Type");
    if kind != "VideoPlaybackStopped" && kind != "VideoPlayback" {
        return None;
    }
    let name = s(e, "Name");
    let (user, rest) = name.split_once(" has finished playing ").or_else(|| name.split_once(" is playing "))?;
    let title = rest.rsplit_once(" on ").map(|x| x.0).unwrap_or(rest);
    Some(Watched { title: title.trim().to_string(), user: user.trim().to_string(), date: s(e, "Date").into() })
}

fn disks_of(v: &Value) -> Vec<Disk> {
    let mut out: Vec<Disk> = Vec::new();
    for lib in v.get("Libraries").and_then(|l| l.as_array()).into_iter().flatten() {
        for f in lib.get("Folders").and_then(|l| l.as_array()).into_iter().flatten() {
            let free = f.get("FreeSpace").and_then(|x| x.as_u64()).unwrap_or(0);
            let used = f.get("UsedSpace").and_then(|x| x.as_u64()).unwrap_or(0);
            let dev = s(f, "DeviceId");
            if free == 0 && used == 0 {
                continue;
            }
            // One line per drive.
            if out.iter().any(|d| d.free == free && (dev.is_empty() || d.path == dev || d.total == free + used)) {
                continue;
            }
            out.push(Disk { path: s(f, "Path").into(), free, total: free + used });
        }
    }
    out
}

/// Picks the newest catalogue version of `name` that this server can run.
pub(crate) fn best_update(packages: &[Value], name: &str, installed: &str, server: &str) -> Option<String> {
    let pkg = packages.iter().find(|p| s(p, "name").eq_ignore_ascii_case(name))?;
    let mut best: Option<String> = None;
    for v in pkg.get("versions").and_then(|v| v.as_array()).into_iter().flatten() {
        let version = s(v, "version");
        let abi = s(v, "targetAbi");
        if version.is_empty() || (!abi.is_empty() && newer(abi, server)) {
            continue;
        }
        if newer(version, installed) && best.as_deref().map_or(true, |b| newer(version, b)) {
            best = Some(version.to_string());
        }
    }
    best
}

async fn latest_release() -> Option<String> {
    // Asked at most twice a day (GitHub limits how often it can be asked).
    let v = crate::updater::github_latest("jellyfin/jellyfin", std::time::Duration::from_secs(12 * 3600)).await.ok()?;
    let tag = s(&v, "tag_name").trim_start_matches('v').to_string();
    (!tag.is_empty()).then_some(tag)
}

#[tauri::command]
pub async fn server_overview(state: State<'_, AppState>) -> Result<ServerOverview> {
    let c = state.reader().await?;
    use tauri::async_runtime::spawn;
    let (c1, c2, c3, c4, c5, c6) = (c.clone(), c.clone(), c.clone(), c.clone(), c.clone(), c.clone());
    let tasks = spawn(async move { c1.scheduled_tasks().await });
    let plugins = spawn(async move { c2.plugins().await });
    let packages = spawn(async move { c3.packages().await });
    let events = spawn(async move { c4.activity(100).await });
    let sessions = spawn(async move { c5.sessions_playing().await });
    let storage = spawn(async move { c6.storage_info().await });
    let latest = spawn(latest_release());
    let info = c.system_info_raw().await?;
    let flat = |r: std::result::Result<Result<Vec<Value>>, tauri::Error>| r.ok().and_then(|x| x.ok());
    let tasks = flat(tasks.await);
    let packages = flat(packages.await);
    let events = flat(events.await);
    let plugins = plugins.await.ok().and_then(|x| x.ok());
    let latest = latest.await.ok().flatten();
    let version = s(&info, "Version").to_string();
    let catalog_ok = packages.as_ref().map(|p| !p.is_empty()).unwrap_or(false);
    let packages = packages.unwrap_or_default();
    // A newer version already installed and waiting for a restart: no update to offer for it.
    let all = plugins.unwrap_or_default();
    let newest = |name: &str| all.iter().filter(|(n, _, _)| n.eq_ignore_ascii_case(name)).map(|(_, v, _)| v.clone()).fold(String::new(), |a, b| if a.is_empty() || newer(&b, &a) { b } else { a });
    let mut seen = std::collections::HashSet::new();
    let plugins = all
        .iter()
        .filter(|(name, _, _)| seen.insert(name.to_lowercase()))
        .map(|(name, _, _)| {
            let v = newest(name);
            let status = all.iter().find(|(n, x, _)| n.eq_ignore_ascii_case(name) && *x == v).map(|t| t.2.clone()).unwrap_or_default();
            ServerPlugin { update: best_update(&packages, name, &v, &version), name: name.clone(), version: v, status }
        })
        .collect();
    let tasks = tasks
        .unwrap_or_default()
        .iter()
        .map(|t| {
            let last = t.get("LastExecutionResult");
            let ls = |k: &str| last.map(|l| s(l, k).to_string()).filter(|x| !x.is_empty());
            ServerTask {
                id: s(t, "Id").into(),
                name: s(t, "Name").into(),
                category: s(t, "Category").into(),
                key: s(t, "Key").into(),
                state: s(t, "State").into(),
                progress: t.get("CurrentProgressPercentage").and_then(|p| p.as_f64()),
                last_status: ls("Status"),
                last_end: ls("EndTimeUtc"),
                last_error: ls("ErrorMessage"),
            }
        })
        .collect();
    let all_events = events.unwrap_or_default();
    let watched: Vec<Watched> = {
        let mut w: Vec<Watched> = Vec::new();
        for x in all_events.iter().filter_map(watched_of) {
            // "is playing" and "has finished playing" of the same thing: once.
            if !w.iter().any(|y| y.title == x.title && y.user == x.user) {
                w.push(x);
            }
        }
        w.truncate(12);
        w
    };
    let playing: Vec<Playing> = sessions.await.ok().and_then(|x| x.ok()).unwrap_or_default().iter().filter_map(playing_of).collect();
    let disks = storage.await.ok().and_then(|x| x.ok()).map(|v| disks_of(&v)).unwrap_or_default();
    let events = all_events
        .iter()
        .filter(|e| !s(e, "Type").starts_with("VideoPlayback") && !s(e, "Type").starts_with("AudioPlayback") && s(e, "Type") != "SessionStarted" && s(e, "Type") != "SessionEnded" && s(e, "Type") != "AuthenticationSucceeded")
        .take(30)
        .map(|e| ServerEvent {
            name: s(e, "Name").into(),
            overview: (if s(e, "ShortOverview").is_empty() { s(e, "Overview") } else { s(e, "ShortOverview") }).chars().take(400).collect(),
            severity: s(e, "Severity").into(),
            date: s(e, "Date").into(),
        })
        .collect();
    Ok(ServerOverview {
        name: s(&info, "ServerName").into(),
        os: s(&info, "OperatingSystemDisplayName").into(),
        pending_restart: info.get("HasPendingRestart").and_then(|b| b.as_bool()).unwrap_or(false),
        update_available: latest.as_deref().map_or(false, |l| newer(l, &version)) || info.get("HasUpdateAvailable").and_then(|b| b.as_bool()).unwrap_or(false),
        latest,
        catalog_ok,
        version,
        plugins,
        tasks,
        events,
        playing,
        watched,
        disks,
    })
}

#[tauri::command]
pub async fn server_task_run(state: State<'_, AppState>, id: String) -> Result<()> {
    state.writer().await?.run_task(&id).await
}

#[tauri::command]
pub async fn server_task_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    state.writer().await?.stop_task(&id).await
}

/// Installs the newest version this server can run of every plugin that has one. Returns
/// "Name version" for each; they work after Jellyfin restarts.
#[tauri::command]
pub async fn server_update_plugins(state: State<'_, AppState>) -> Result<Vec<String>> {
    let w = state.writer().await?;
    let c = w.reader();
    let version = s(&c.system_info_raw().await?, "Version").to_string();
    let packages = c.packages().await?;
    let mut done = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let installed = c.plugins().await?;
    for (name, v, _) in &installed {
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        let newest = installed.iter().filter(|(n, _, _)| n.eq_ignore_ascii_case(name)).map(|(_, x, _)| x.clone()).fold(v.clone(), |a, b| if newer(&b, &a) { b } else { a });
        let Some(up) = best_update(&packages, name, &newest, &version) else { continue };
        let Some(pkg) = packages.iter().find(|p| s(p, "name").eq_ignore_ascii_case(name)) else { continue };
        let repo = pkg.get("versions").and_then(|x| x.as_array()).into_iter().flatten().find(|x| s(x, "version") == up).map(|x| s(x, "repositoryUrl").to_string()).unwrap_or_default();
        w.install_package(s(pkg, "name"), s(pkg, "guid"), &up, &repo).await?;
        done.push(format!("{name} {up}"));
    }
    Ok(done)
}

/// Runs the task with this key ("RefreshLibrary", "PluginUpdates" …).
#[tauri::command]
pub async fn server_task_run_key(state: State<'_, AppState>, key: String) -> Result<()> {
    let w = state.writer().await?;
    let tasks = w.reader().scheduled_tasks().await?;
    let t = tasks.iter().find(|t| s(t, "Key") == key).ok_or_else(|| Error::msg("Jellyfin doesn't have that task."))?;
    w.run_task(s(t, "Id")).await
}

#[tauri::command]
pub async fn server_restart(state: State<'_, AppState>) -> Result<()> {
    state.writer().await?.restart_server().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn playing_and_watched_read_plainly() {
        let v = json!({"UserName":"Anna","Client":"Infuse","DeviceName":"Apple TV","PlayState":{"PlayMethod":"Transcode","PositionTicks":300,"IsPaused":false},
            "TranscodingInfo":{"VideoCodec":"h264","TranscodeReasons":["VideoCodecNotSupported"]},
            "NowPlayingItem":{"Name":"Hotel","SeriesName":"Bluey","SeriesId":"aa-bb","ParentIndexNumber":3,"IndexNumber":12,"RunTimeTicks":1000,"MediaStreams":[{"Type":"Video","Codec":"hevc"}]}});
        let p = playing_of(&v).unwrap();
        assert_eq!(p.title, "Bluey · S03E12");
        assert_eq!(p.art_id, "aabb");
        assert_eq!(p.how, "Transcoding: HEVC → H264 (VideoCodec not supported)");
        assert_eq!(p.device, "Infuse · Apple TV");
        assert!((p.progress.unwrap() - 0.3).abs() < 1e-9);
        let w = watched_of(&json!({"Type":"VideoPlaybackStopped","Name":"Anna has finished playing Heat on Apple TV","Date":"2026-11-05T21:40:00Z"})).unwrap();
        assert_eq!((w.title.as_str(), w.user.as_str()), ("Heat", "Anna"));
        assert!(watched_of(&json!({"Type":"SessionStarted","Name":"Anna is online"})).is_none());
    }

    #[test]
    fn versions_compare() {
        assert!(newer("10.10.3", "10.9.11"));
        assert!(!newer("10.9", "10.9.0"));
        assert!(newer("v10.11.0", "10.10.7"));
    }

    #[test]
    fn update_respects_server_version() {
        let p = vec![json!({"name":"Intro Skipper","versions":[
            {"version":"1.10.11.0","targetAbi":"10.11.0.0"},
            {"version":"1.10.10.5","targetAbi":"10.10.0.0"},
            {"version":"1.10.10.1","targetAbi":"10.10.0.0"}]})];
        assert_eq!(best_update(&p, "intro skipper", "1.10.10.1", "10.10.7").as_deref(), Some("1.10.10.5"));
        assert_eq!(best_update(&p, "Intro Skipper", "1.10.10.5", "10.10.7"), None);
        assert_eq!(best_update(&p, "Other", "1", "10.10.7"), None);
    }
}
