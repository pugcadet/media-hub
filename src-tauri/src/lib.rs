mod commands;
mod config;
mod detect;
mod downloads;
mod error;
mod fingerprint;
mod fsops;
mod images;
mod jellyfin;
mod media_tools;
mod meta_cmds;
mod naming;
mod picks;
mod planner;
mod player;
mod rename_cmds;
mod secrets;
mod seg_cmds;
mod sources;
mod state;
mod storage;
mod store;
mod sub_cmds;
mod subs;
mod updater;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("hubimg", |ctx, request, responder| {
            images::handle(ctx.app_handle().clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("hubmedia", |ctx, request, responder| {
            player::handle(ctx.app_handle().clone(), request, responder);
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
            commands::libraries,
            commands::attention,
            commands::missing_subtitles,
            commands::set_tmdb_key,
            commands::set_title_lang,
            commands::list_users,
            commands::set_user,
            commands::set_sync_watched,
            updater::check_update,
            updater::install_update,
            rename_cmds::pick_library_root,
            rename_cmds::list_folders,
            rename_cmds::plan_rename,
            rename_cmds::apply_plan,
            rename_cmds::rename_history,
            rename_cmds::undo_rename,
            meta_cmds::item_details,
            meta_cmds::save_metadata,
            meta_cmds::identify_search,
            meta_cmds::identify_apply,
            meta_cmds::remote_images,
            meta_cmds::set_image,
            meta_cmds::upload_image_file,
            meta_cmds::undo_change,
            meta_cmds::refresh_item,
            meta_cmds::set_read_only,
            sub_cmds::languages,
            sub_cmds::set_sub_langs,
            sub_cmds::item_children,
            sub_cmds::subtitle_options,
            sub_cmds::subtitle_download,
            sub_cmds::subtitle_auto,
            seg_cmds::segments_overview,
            seg_cmds::detect_season,
            seg_cmds::save_segments,
            seg_cmds::ffmpeg_info,
            seg_cmds::pick_ffmpeg,
            player::play_start,
            player::play_stop,
            downloads::ytdlp_info,
            downloads::ytdlp_install,
            downloads::pick_download_folder,
            downloads::dl_probe,
            downloads::dl_start,
            downloads::dl_cancel,
            downloads::dl_search,
            downloads::dl_reveal,
            downloads::dl_set_cookies,
            storage::storage_scan,
            storage::hevc_encoders,
            storage::storage_start,
            storage::storage_cancel,
            storage::storage_history,
            storage::trash_info,
            storage::trash_empty,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Media Hub")
        .run(|_app, event| {
            // Quitting stops every download (and the ffmpeg it started).
            if let tauri::RunEvent::Exit = event {
                downloads::kill_all();
            }
        });
}
