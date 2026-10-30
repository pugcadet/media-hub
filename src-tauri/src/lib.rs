mod backend;
mod bulk;
mod cancel;
mod cleanup;
mod collections;
mod commands;
mod config;
mod detect;
mod downloads;
mod error;
mod fingerprint;
mod fsops;
mod images;
#[cfg(test)]
mod fake_jellyfin;
mod import;
mod jellyfin;
mod library;
mod localmusic;
mod music;
mod subsync;
mod local;
mod media_tools;
mod meta_cmds;
mod naming;
mod naming_check;
mod picks;
mod planner;
mod player;
mod rename_cmds;
mod renumber;
mod sublock;
mod pin;
mod secrets;
mod seg_cmds;
mod sources;
mod state;
mod storage;
mod store;
mod sub_cmds;
mod structure;
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
            let prune_dir = dir.clone();
            std::thread::spawn(move || images::prune(&prune_dir));
            let state = state::AppState::new(dir)?;
            app.manage(state);
            // A rename batch cut short (app force-quit, crash): make the journal match the disk.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let st = handle.state::<state::AppState>();
                let _ = fsops::recover(&*st);
            });
            #[cfg(target_os = "macos")]
            uncap_frame_rate(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status,
            images::images_revalidate,
            library::find_moved,
            structure::structure_scan,
            structure::structure_plan,
            bulk::bulk_plan,
            meta_cmds::make_thumb,
            backend::plugins_installed,
            backend::run_intro_skipper,
            collections::collection_folder_plan,
            collections::collection_relink,
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
            commands::set_played,
            import::import_pick,
            import::import_run,
            import::inbox_pick,
            import::inbox_list,
            import::inbox_select,
            commands::clear_resume,
            library::library_health,
            library::missing_episodes,
            library::find_duplicates,
            library::merge_versions,
            library::trash_item_file,
            library::tag_stats,
            library::tags_merge,
            library::make_episode_stills,
            library::health_alerts,
            library::sync_picks_playlist,
            library::journal_all,
            library::segment_summary,
            library::segment_coverage,
            library::health_row,
            library::set_favorite,
            library::library_languages,
            library::set_library_language,
            subsync::subtitle_sync,
            music::music_list,
            music::music_play,
            music::music_stop,
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
            meta_cmds::youtube_number,
            meta_cmds::identify_search,
            meta_cmds::identify_apply,
            meta_cmds::remote_images,
            meta_cmds::set_image,
            meta_cmds::upload_image_file,
            meta_cmds::upload_image_bytes,
            meta_cmds::set_image_from_link,
            meta_cmds::save_picture,
            meta_cmds::undo_change,
            meta_cmds::refresh_item,
            meta_cmds::set_read_only,
            meta_cmds::main_backdrop,
            meta_cmds::remove_image,
            meta_cmds::fill_missing_art,
            meta_cmds::art_search,
            collections::home_feed,
            collections::collections_list,
            collections::collection_items,
            collections::collections_of,
            collections::similar_items,
            collections::person_items,
            collections::collection_create,
            collections::collection_add,
            collections::collection_remove,
            collections::sync_picks_collection,
            local::reveal_item,
            local::reveal_rel,
            local::item_folder,
            local::library_scan,
            backend::backend_tuning,
            backend::backend_set,
            backend::backend_apply_recommended,
            backend::backend_run_task,
            backend::set_lock_edits,
            backend::lock_all,
            backend::scan_folders,
            cancel::cancel_job,
            cleanup::extra_subtitles,
            localmusic::music_source,
            localmusic::set_music_source,
            localmusic::pick_music_folder,
            localmusic::music_rescan,
            localmusic::music_fetch_art,
            localmusic::music_local_edit,
            localmusic::music_local_reset,
            localmusic::music_art_options,
            localmusic::music_local_set_art,
            cleanup::remove_subtitle_files,
            cleanup::episodes_without_picture,
            naming_check::naming_check,
            naming_check::naming_check_last,
            naming_check::naming_check_cancel,
            sub_cmds::languages,
            sub_cmds::set_sub_langs,
            sub_cmds::item_children,
            sub_cmds::subtitle_options,
            sub_cmds::subtitle_download,
            sub_cmds::subtitle_auto,
            sub_cmds::missing_language,
            renumber::episode_renumber,
            sublock::subtitle_lock,
            pin::pin_identity,
            backend::intro_skipper_libraries,
            backend::set_intro_skipper_libraries,
            sub_cmds::local_subtitles,
            sub_cmds::adopt_subtitles,
            seg_cmds::segments_overview,
            seg_cmds::detect_season,
            seg_cmds::save_segments,
            seg_cmds::segments_snapshot,
            seg_cmds::segments_carry,
            seg_cmds::ffmpeg_info,
            seg_cmds::pick_ffmpeg,
            player::play_start,
            player::play_stop,
            player::play_progress,
            player::watch_sync_test,
            player::play_subtitles,
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
            storage::storage_overview,
            storage::hevc_encoders,
            storage::storage_start,
            storage::storage_cancel,
            storage::storage_history,
            storage::trash_info,
            storage::trash_list,
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

/// Safari's web view draws at most 60 frames a second unless told otherwise; this asks it to
/// follow the screen (120 Hz on ProMotion Macs). Skipped quietly on macOS versions without it.
#[cfg(target_os = "macos")]
fn uncap_frame_rate(app: &tauri::App) {
    use tauri::Manager;
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.with_webview(|wv| unsafe {
        use objc2::runtime::AnyObject;
        use objc2::{msg_send, sel};
        let view = wv.inner() as *mut AnyObject;
        if view.is_null() {
            return;
        }
        let config: *mut AnyObject = msg_send![view, configuration];
        if config.is_null() {
            return;
        }
        let prefs: *mut AnyObject = msg_send![config, preferences];
        if prefs.is_null() {
            return;
        }
        let s = sel!(_setPreferPageRenderingUpdatesNear60FPSEnabled:);
        let can: bool = msg_send![prefs, respondsToSelector: s];
        if can {
            let _: () = msg_send![prefs, _setPreferPageRenderingUpdatesNear60FPSEnabled: false];
        }
    });
}
