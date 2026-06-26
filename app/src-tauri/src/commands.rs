//! Tauri commands exposed to the frontend. Thin wrappers over `kv3-core`, the
//! path-derivation rule, and the project model. Errors are returned as strings
//! so they surface cleanly in the UI.

use crate::audio::{self, AudioInfo, ProcessReq};
use crate::compile::{self, CompileConfig, CompileReport};
use crate::paths::{self, DerivedPaths};
use crate::project::Project;
use kv3_core::EventView;
use std::path::PathBuf;

/// Probe a source audio file's duration (seconds) via ffprobe.
#[tauri::command]
pub fn probe_audio(path: String, ffmpeg_path: Option<String>) -> Result<AudioInfo, String> {
    let duration = audio::probe_duration(ffmpeg_path.as_deref(), &path)?;
    Ok(AudioInfo { duration })
}

/// Render the processed (trimmed + gain-boosted) preview; returns the WAV path.
#[tauri::command]
pub fn process_audio(req: ProcessReq) -> Result<String, String> {
    audio::process(&req)
}

/// Pack a folder into a single `pak01_dir.vpk` via the bundled ValvePak helper.
#[tauri::command]
pub fn pack_vpk(helper_path: String, folder: String, out_vpk: String) -> Result<String, String> {
    crate::vpk::pack(&helper_path, &folder, &out_vpk)
}

/// Run the full compile pipeline. Returns a per-step report (never throws for
/// pipeline failures — inspect `report.ok` and the steps).
#[tauri::command]
pub fn compile_project(config: CompileConfig) -> CompileReport {
    compile::run(&config)
}

/// Read every `vsnd_files*` array in a mod's soundevents (decompiled from its
/// vpk). Used by "Merge into project" to find what the mod added.
#[tauri::command]
pub fn read_mod_arrays(
    helper_path: String,
    vpk: String,
) -> Result<Vec<kv3_core::ArrayInfo>, String> {
    let files = crate::vpk::list(&helper_path, &vpk, Some("soundevents/"))?;
    let tmp = std::env::temp_dir().join("deadlock-intro-tool").join("modread");
    let _ = std::fs::create_dir_all(&tmp);
    let mut out = Vec::new();
    for f in files.iter().filter(|f| f.ends_with(".vsndevts_c")) {
        let dest = tmp.join(f.replace('/', "_"));
        if crate::vpk::decompile_from_vpk(&helper_path, &vpk, f, &dest.to_string_lossy()).is_ok() {
            if let Ok(text) = std::fs::read_to_string(&dest) {
                if let Ok(arrays) = kv3_core::list_arrays(&text) {
                    out.extend(arrays);
                }
            }
        }
    }
    Ok(out)
}

/// Decode a stock track's compiled `.vsnd_c` (from the game's pak) to playable
/// audio for the waveform comparison. `stock_ref` is the `.vsnd` reference; the
/// result is cached in the staging dir and the audio file path is returned.
#[tauri::command]
pub fn decode_stock(
    helper_path: String,
    pak_path: String,
    stock_ref: String,
) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let internal = if let Some(stripped) = stock_ref.strip_suffix(".vsnd") {
        format!("{stripped}.vsnd_c")
    } else {
        stock_ref.clone()
    };

    let mut h = DefaultHasher::new();
    pak_path.hash(&mut h);
    internal.hash(&mut h);
    let dir = std::env::temp_dir().join("deadlock-intro-tool");
    let _ = std::fs::create_dir_all(&dir);
    let out_base = dir.join(format!("stock_{:016x}", h.finish()));

    // Reuse a cached decode if present (any extension).
    for ext in ["mp3", "wav", "aac"] {
        let cached = out_base.with_extension(ext);
        if cached.exists() {
            return Ok(cached.to_string_lossy().into_owned());
        }
    }

    crate::vpk::decode(
        &helper_path,
        &pak_path,
        &internal,
        &out_base.to_string_lossy(),
    )
}

/// Extract one entry from a VPK via the bundled ValvePak helper.
#[tauri::command]
pub fn extract_vpk(
    helper_path: String,
    vpk: String,
    internal_path: String,
    out_file: String,
) -> Result<String, String> {
    crate::vpk::extract(&helper_path, &vpk, &internal_path, &out_file)
}

/// Read one event's current pool (entries + duration) from a KV3 `.vsndevts`.
#[tauri::command]
pub fn read_event_pool(events_path: String, event_name: String) -> Result<EventView, String> {
    let text = std::fs::read_to_string(&events_path)
        .map_err(|e| format!("reading {events_path}: {e}"))?;
    kv3_core::read_event(&text, &event_name).map_err(|e| e.to_string())
}

/// One slot to read: its events file, the event, and which array within it.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotRef {
    pub events_path: String,
    pub event_name: String,
    #[serde(default)]
    pub array_key: Option<String>,
}

/// Read several slots at once (each from its own events file). Returns an
/// EventView per slot, in order; missing entries become `None` so one bad slot
/// doesn't fail the whole load.
#[tauri::command]
pub fn read_event_pools(slots: Vec<SlotRef>) -> Result<Vec<Option<EventView>>, String> {
    use std::collections::HashMap;
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut out = Vec::new();
    for slot in slots {
        let text = match cache.get(&slot.events_path) {
            Some(t) => t,
            None => {
                let t = std::fs::read_to_string(&slot.events_path)
                    .map_err(|e| format!("reading {}: {e}", slot.events_path))?;
                cache.entry(slot.events_path.clone()).or_insert(t)
            }
        };
        let key = slot.array_key.as_deref().unwrap_or("vsnd_files");
        out.push(kv3_core::read_event_array(text, &slot.event_name, key).ok());
    }
    Ok(out)
}

/// Derive all paths for a song name (the single source of truth).
#[tauri::command]
pub fn derive_paths(
    game_content_root: String,
    sound_folder: String,
    sound_name: String,
) -> DerivedPaths {
    paths::derive(&game_content_root, &sound_folder, &sound_name)
}

/// Sanitize a raw name into a valid `sound_name`.
#[tauri::command]
pub fn sanitize_name(input: String) -> String {
    paths::sanitize_sound_name(&input)
}

/// Create a fresh project pre-populated with the two match-intro events.
#[tauri::command]
pub fn new_project() -> Project {
    Project::default_for_match_intro()
}

/// Check existence of each path (for Setup validation chips). Returns a bool per
/// input path, in order.
#[tauri::command]
pub fn check_paths(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .collect()
}

#[tauri::command]
pub fn load_project(path: String) -> Result<Project, String> {
    Project::load(&PathBuf::from(path)).map_err(|e| e.to_string())
}

/// Path of the autosaved project in the OS app-data dir.
fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("project.json"))
}

/// Autosave the current project state (no compile).
#[tauri::command]
pub fn save_state(app: tauri::AppHandle, project: Project) -> Result<(), String> {
    project.save(&state_path(&app)?).map_err(|e| e.to_string())
}

/// Load the autosaved project, or None if there isn't one yet.
#[tauri::command]
pub fn load_state(app: tauri::AppHandle) -> Result<Option<Project>, String> {
    let path = state_path(&app)?;
    if path.exists() {
        Project::load(&path).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn save_project(path: String, project: Project) -> Result<(), String> {
    project
        .save(&PathBuf::from(path))
        .map_err(|e| e.to_string())
}
