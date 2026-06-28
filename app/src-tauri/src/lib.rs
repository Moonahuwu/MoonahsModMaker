mod audio;
mod commands;
mod compile;
mod install;
mod paths;
mod project;
mod vpk;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::autodetect_paths,
            commands::scan_addon_slots,
            commands::install_to_game,
            commands::hero_roster,
            commands::hero_detail,
            commands::hero_config,
            commands::item_config,
            commands::global_config,
            commands::randomize_config,
            commands::hero_voicelines,
            commands::hero_sounds,
            commands::browse_game_sounds,
            commands::browse_particles,
            commands::effect_preview,
            commands::open_in_viewer,
            commands::item_particles,
            commands::item_roster,
            commands::item_detail,
            commands::compile_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
