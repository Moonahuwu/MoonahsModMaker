mod audio;
mod commands;
mod compile;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::HostState::default());

    // Global hotkey (F8) to toggle the in-game mod-menu overlay. Desktop only.
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
        let overlay_key = Shortcut::new(None, Code::F8);
        builder = builder
            .plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            toggle_overlay(app);
                        }
                    })
                    .build(),
            )
            .setup(move |app| {
                // Best-effort: if the hotkey is already taken we just skip it
                // (the overlay can still be opened from the app's button).
                let _ = app.global_shortcut().register(overlay_key);
                Ok(())
            });
    }

    builder
        .invoke_handler(tauri::generate_handler![
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
            commands::pack_unchanged_files,
            commands::decompile_vpk_all,
            commands::browse_particles,
            commands::effect_preview,
            commands::poster_sheet,
            commands::open_in_viewer,
            commands::item_particles,
            commands::item_roster,
            commands::item_detail,
            commands::compile_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
