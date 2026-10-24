mod commands;
mod config;
mod error;
mod images;
mod jellyfin;
mod picks;
mod secrets;
mod state;
mod store;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Media Hub");
}
