mod commands;
mod config;
mod error;
mod fsops;
mod images;
mod jellyfin;
mod naming;
mod picks;
mod planner;
mod rename_cmds;
mod secrets;
mod state;
mod store;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("hubimg", |ctx, request, responder| {
            images::handle(ctx.app_handle().clone(), request, responder);
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = state::AppState::new(dir)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            commands::connect,
            commands::disconnect,
            commands::sync_library,
            commands::list_items,
            commands::todays_picks,
            rename_cmds::pick_library_root,
            rename_cmds::list_folders,
            rename_cmds::plan_rename,
            rename_cmds::apply_plan,
            rename_cmds::rename_history,
            rename_cmds::undo_rename,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Media Hub");
}
