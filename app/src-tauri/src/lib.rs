mod audio;
mod commands;
mod compile;
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
            commands::probe_audio,
            commands::process_audio,
            commands::pack_vpk,
            commands::extract_vpk,
            commands::decode_stock,
            commands::compile_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
