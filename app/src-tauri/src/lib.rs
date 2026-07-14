mod audio;
mod commands;
mod compile;
mod digimod;
mod host;
mod install;
mod paths;
mod procutil;
mod project;
mod rcon;
mod vpk;

/// Toggle the always-on-top mod-menu overlay window's visibility.
#[cfg(desktop)]
fn toggle_overlay(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(win) = app.get_webview_window("overlay") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Register/unregister the F8 overlay hotkey. The frontend calls this with the
/// Custom Server toggle's value (on settings load and every change), so F8
/// only exists while that tab is enabled - a mystery mod-menu popping over the
/// game would scare anyone who never opted into the server feature.
#[tauri::command]
fn set_overlay_hotkey(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri::Manager;
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
        let key = Shortcut::new(None, Code::F8);
        let gs = app.global_shortcut();
        if enabled {
            if !gs.is_registered(key) {
                // Best-effort: if another app owns F8 we just skip it (the
                // overlay can still be opened from the app's button).
                let _ = gs.register(key);
            }
        } else {
            if gs.is_registered(key) {
                let _ = gs.unregister(key);
            }
            // Also tuck the overlay away if it was open.
            if let Some(win) = app.get_webview_window("overlay") {
                let _ = win.hide();
            }
        }
    }
    #[cfg(not(desktop))]
    let _ = (app, enabled);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::HostState::default());

    // Global hotkey (F8) to toggle the in-game mod-menu overlay. Desktop only.
    // NOT registered at startup: the frontend enables it via set_overlay_hotkey
    // only while the Custom Server tab is on.
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        toggle_overlay(app);
                    }
                })
                .build(),
        );
    }

    builder
        .invoke_handler(tauri::generate_handler![
            set_overlay_hotkey,
            commands::read_event_pool,
            commands::read_event_pools,
            commands::derive_paths,
            commands::sanitize_name,
            commands::new_project,
            commands::check_paths,
            commands::read_mod_arrays,
            commands::download_entry,
            commands::copy_to_downloads,
            commands::load_project,
            commands::save_project,
            commands::save_state,
            commands::load_state,
            commands::save_settings,
            commands::load_settings,
            commands::list_profiles,
            commands::save_profile,
            commands::load_profile,
            commands::delete_profile,
            commands::rename_profile,
            commands::probe_audio,
            commands::process_audio,
            commands::pack_vpk,
            commands::extract_vpk,
            commands::decode_stock,
            commands::heal_missing_sources,
            commands::refresh_vanilla,
            commands::list_editable_events,
            commands::list_soundevent_files,
            commands::download_tools,
            commands::import_pack_events,
            commands::item_sound_index,
            commands::autodetect_paths,
            commands::scan_addon_slots,
            commands::install_to_game,
            commands::host_status,
            commands::setup_hosting,
            commands::revert_hosting,
            commands::launch_host,
            commands::launch_game,
            commands::rcon_exec,
            commands::rcon_ready,
            commands::host_info,
            commands::read_server_log,
            commands::host_connect_id,
            commands::hero_roster,
            commands::hero_detail,
            commands::hero_config,
            commands::item_config,
            commands::global_config,
            commands::world_config,
            commands::randomize_config,
            commands::hero_voicelines,
            commands::hero_sounds,
            commands::browse_game_sounds,
            commands::check_sound_refs,
            commands::scan_pack_contents,
            commands::events_for_refs,
            commands::cache_pack,
            commands::pack_cache_lookup,
            commands::pack_unchanged_files,
            commands::decompile_vpk_all,
            commands::browse_particles,
            commands::effect_preview,
            commands::poster_sheet,
            commands::pack_icons,
            commands::hero_images,
            commands::running_processes,
            commands::digimod_detected,
            commands::list_ui_mods,
            commands::import_digimod,
            commands::media_thumb,
            commands::extract_video_audio,
            commands::list_ui_files,
            commands::read_ui_file,
            commands::push_ui_files,
            commands::clear_pushed_ui,
            commands::install_app_update,
            commands::check_app_update,
            commands::gamebanana_mod_info,
            commands::gamebanana_search,
            commands::gamebanana_files,
            commands::gamebanana_download,
            commands::library_add,
            commands::library_remove,
            commands::easy_compile,
            commands::vpk_extract_audio,
            commands::open_in_viewer,
            commands::item_particles,
            commands::item_roster,
            commands::item_detail,
            commands::compile_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
