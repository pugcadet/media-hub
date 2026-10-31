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
    plugins: Vec<ServerPlugin>,
    tasks: Vec<ServerTask>,
    events: Vec<ServerEvent>,
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
    let http = reqwest::Client::builder().user_agent("Media Hub").timeout(std::time::Duration::from_secs(8)).build().ok()?;
    let v: Value = http.get("https://api.github.com/repos/jellyfin/jellyfin/releases/latest").send().await.ok()?.json().await.ok()?;
    let tag = s(&v, "tag_name").trim_start_matches('v').to_string();
    (!tag.is_empty()).then_some(tag)
}

#[tauri::command]
pub async fn server_overview(state: State<'_, AppState>) -> Result<ServerOverview> {
    let c = state.reader().await?;
    use tauri::async_runtime::spawn;
    let (c1, c2, c3, c4) = (c.clone(), c.clone(), c.clone(), c.clone());
    let tasks = spawn(async move { c1.scheduled_tasks().await });
    let plugins = spawn(async move { c2.plugins().await });
    let packages = spawn(async move { c3.packages().await });
    let events = spawn(async move { c4.activity(30).await });
    let latest = spawn(latest_release());
    let info = c.system_info_raw().await?;
    let flat = |r: std::result::Result<Result<Vec<Value>>, tauri::Error>| r.ok().and_then(|x| x.ok());
    let tasks = flat(tasks.await);
    let packages = flat(packages.await);
    let events = flat(events.await);
    let plugins = plugins.await.ok().and_then(|x| x.ok());
    let latest = latest.await.ok().flatten();
    let version = s(&info, "Version").to_string();
    let packages = packages.unwrap_or_default();
    let plugins = plugins
        .unwrap_or_default()
        .into_iter()
        .map(|(name, v, status)| ServerPlugin { update: best_update(&packages, &name, &v, &version), name, version: v, status })
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
    let events = events
        .unwrap_or_default()
        .iter()
        .map(|e| ServerEvent {
            name: s(e, "Name").into(),
            overview: if s(e, "ShortOverview").is_empty() { s(e, "Overview") } else { s(e, "ShortOverview") }.chars().take(400).collect(),
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
        version,
        plugins,
        tasks,
        events,
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
