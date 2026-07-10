//! Tauri commands exposed to the frontend. Thin wrappers over `kv3-core`, the
//! path-derivation rule, and the project model. Errors are returned as strings
//! so they surface cleanly in the UI.

use crate::audio::{self, AudioInfo, ProcessReq};
use crate::compile::{self, CompileConfig, CompileReport};
use crate::install::{self, InstallResult, SlotScan};
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
///
/// `async` + `spawn_blocking` is load-bearing: a *sync* Tauri command runs on the
/// main/UI thread, so the whole window freezes ("Not Responding") for the several
/// seconds a real compile takes (ffmpeg + resourcecompiler launches + VPK packing).
/// Moving the blocking work onto a worker thread keeps the UI responsive.
#[tauri::command]
pub async fn compile_project(app: tauri::AppHandle, config: CompileConfig) -> CompileReport {
    // Forward pipeline steps to the UI live. The channel indirection keeps
    // tauri's event system out of compile.rs (see CompileReport::progress).
    let (tx, rx) = std::sync::mpsc::channel::<compile::StepResult>();
    std::thread::spawn(move || {
        use tauri::Emitter;
        for step in rx {
            let _ = app.emit("compile://progress", &step);
        }
    });
    tauri::async_runtime::spawn_blocking(move || compile::run_with_progress(&config, Some(tx)))
        .await
        .unwrap_or_else(|e| CompileReport {
            ok: false,
            steps: vec![compile::StepResult {
                name: "compile task".into(),
                ok: false,
                detail: format!("compile worker panicked: {e}"),
                pct: None,
            }],
            output_path: None,
            progress: None,
            est_total: 0,
        })
}

fn downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().download_dir().map_err(|e| e.to_string())
}

/// A non-colliding path `<dir>/<stem>.<ext>` (appends " (2)", " (3)", …).
fn unique_path(dir: &std::path::Path, stem: &str, ext: &str) -> PathBuf {
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut i = 2;
    while p.exists() {
        p = dir.join(format!("{stem} ({i}).{ext}"));
        i += 1;
    }
    p
}

fn ref_stem(reference: &str) -> String {
    reference
        .rsplit('/')
        .next()
        .unwrap_or(reference)
        .trim_end_matches(".vsnd")
        .to_string()
}

/// Decode a compiled entry (from `vpk`) and save a playable copy into the user's
/// Downloads folder. Returns the saved path.
#[tauri::command]
pub fn download_entry(
    app: tauri::AppHandle,
    helper_path: String,
    vpk: String,
    reference: String,
) -> Result<String, String> {
    let internal = reference
        .strip_suffix(".vsnd")
        .map(|s| format!("{s}.vsnd_c"))
        .unwrap_or_else(|| reference.clone());
    let tmp_base = std::env::temp_dir()
        .join("deadlock-intro-tool")
        .join("dl_tmp");
    if let Some(parent) = tmp_base.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let decoded = crate::vpk::decode(&helper_path, &vpk, &internal, &tmp_base.to_string_lossy())?;
    let ext = std::path::Path::new(&decoded)
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_else(|| "wav".into());
    let dest = unique_path(&downloads_dir(&app)?, &ref_stem(&reference), &ext);
    std::fs::copy(&decoded, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Copy an existing audio file (e.g. one of your source mp3s) into Downloads.
#[tauri::command]
pub fn copy_to_downloads(app: tauri::AppHandle, src_path: String) -> Result<String, String> {
    let src = std::path::Path::new(&src_path);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "track".into());
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mp3".into());
    let dest = unique_path(&downloads_dir(&app)?, &stem, &ext);
    std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
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

/// One event's worth of entries to import from a mod pack: the entries that
/// reference audio actually shipped *inside* the pack (i.e. the author's own
/// sounds), so they can be adopted into a project.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEvent {
    pub events_relpath: String,
    pub event_name: String,
    pub array_key: String,
    pub refs: Vec<String>,
}

/// Canonicalize a packed soundevents path to `soundevents/<rel>` regardless of
/// the pack's wrapper folder (`MYSoundevents/`, `.../soundevents/`, …) and strip
/// a trailing `_c`.
fn canon_events_relpath(path: &str) -> String {
    let p = path.strip_suffix("_c").unwrap_or(path);
    let rel = if let Some(idx) = p.rfind("soundevents/") {
        &p[idx + "soundevents/".len()..]
    } else {
        // e.g. "MYSoundevents/hero/abrams.vsndevts" -> drop the first segment.
        p.splitn(2, '/').nth(1).unwrap_or(p)
    };
    format!("soundevents/{rel}")
}

/// Scan a mod pack vpk and return, per event, the entries that point at audio
/// shipped inside the pack (the author's own sounds) — i.e. what to adopt when
/// importing the pack. `exclude_prefixes` drops references under those internal
/// paths (e.g. `sounds/gordon/`). Authored soundevents only: vanilla snapshots /
/// backups / merged copies the pack happens to bundle are skipped, and remaining
/// duplicates are merged by (relpath, event, array).
#[tauri::command]
pub fn import_pack_events(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    pack_vpk: String,
    exclude_prefixes: Vec<String>,
) -> Result<Vec<ImportEvent>, String> {
    use std::collections::{BTreeSet, HashMap, HashSet};
    let files = crate::vpk::list(&helper_path, &pack_vpk, None)?;
    let excluded = |r: &str| exclude_prefixes.iter().any(|p| r.starts_with(p.as_str()));
    // A pack file at a STOCK game path is a bundled copy of a vanilla sound or
    // a rename-to-original replacement — NOT the author's own track. Adopting
    // those would list vanilla sounds as "from the mod" (they ride along via
    // the bundle instead). Best-effort: an empty/unavailable index skips the
    // filter rather than failing the scan.
    let stock: HashSet<String> = if pak_path.is_empty() {
        HashSet::new()
    } else {
        game_sound_index(&app, &helper_path, &pak_path, false)
            .map(|v| v.into_iter().collect())
            .unwrap_or_default()
    };
    // Audio the pack ships (sounds/x.vsnd, derived from x.vsnd_c), minus
    // exclusions and stock-path files.
    let audio: HashSet<String> = files
        .iter()
        .filter(|f| f.starts_with("sounds/") && f.ends_with(".vsnd_c"))
        .map(|f| f.trim_end_matches("_c").to_string())
        .filter(|r| !excluded(r) && !stock.contains(r))
        .collect();
    let tmp = std::env::temp_dir()
        .join("deadlock-intro-tool")
        .join("packimport");
    let _ = std::fs::create_dir_all(&tmp);
    // Old packs bundle TEXT .vsndevts; properly-built mods ship only the
    // compiled .vsndevts_c — read both (decompiling the compiled ones), but
    // prefer the text twin when a pack ships both.
    let text_files: HashSet<&str> = files
        .iter()
        .filter(|f| f.ends_with(".vsndevts"))
        .map(|s| s.as_str())
        .collect();
    let mut map: HashMap<(String, String, String), BTreeSet<String>> = HashMap::new();
    for f in &files {
        let is_text = f.ends_with(".vsndevts");
        let is_compiled = f.ends_with(".vsndevts_c");
        if !is_text && !is_compiled {
            continue;
        }
        if is_compiled && text_files.contains(f.trim_end_matches("_c")) {
            continue; // the text twin covers it
        }
        let lower = f.to_lowercase();
        // Skip the pack's bundled vanilla snapshots / backups / merged copies —
        // we only want the author's edited soundevents.
        if lower.contains("backup") || lower.contains("newsoundevents") || lower.contains("merged") {
            continue;
        }
        let dest = tmp.join(format!("{}.vsndevts", f.replace('/', "_").trim_end_matches("_c")));
        let extracted = if is_text {
            crate::vpk::extract(&helper_path, &pack_vpk, f, &dest.to_string_lossy()).is_ok()
        } else {
            crate::vpk::decompile_from_vpk(&helper_path, &pack_vpk, f, &dest.to_string_lossy()).is_ok()
        };
        if !extracted {
            continue;
        }
        let text = match std::fs::read_to_string(&dest) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let arrays = match kv3_core::list_arrays(&text) {
            Ok(a) => a,
            Err(_) => continue,
        };
        let relpath = canon_events_relpath(f);
        for a in arrays {
            let refs: Vec<String> = a
                .entries
                .into_iter()
                .filter(|e| audio.contains(e) && !excluded(e))
                .collect();
            if refs.is_empty() {
                continue;
            }
            map.entry((relpath.clone(), a.event_name, a.array_key))
                .or_default()
                .extend(refs);
        }
    }
    let mut out: Vec<ImportEvent> = map
        .into_iter()
        .map(|((events_relpath, event_name, array_key), refs)| ImportEvent {
            events_relpath,
            event_name,
            array_key,
            refs: refs.into_iter().collect(),
        })
        .collect();
    out.sort_by(|a, b| {
        (
            a.events_relpath.as_str(),
            a.event_name.as_str(),
            a.array_key.as_str(),
        )
            .cmp(&(
                b.events_relpath.as_str(),
                b.event_name.as_str(),
                b.array_key.as_str(),
            ))
    });
    Ok(out)
}

/// What's inside a mod pack, classified for the import review UI. Every list
/// holds the pack's raw internal paths (compiled `_c` names), so a deselected
/// entry can be excluded from staging verbatim.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackContents {
    /// Pack sound files whose path matches a REAL stock game sound — the
    /// "rename your file to the original's name" replacement trick. These
    /// override the original purely by being bundled.
    pub overwrites: Vec<String>,
    /// Pack sounds that are the author's own files (new paths, referenced by
    /// the pack's sound events).
    pub own_sounds: Vec<String>,
    pub models: Vec<String>,
    pub particles: Vec<String>,
    pub materials: Vec<String>,
    pub panorama: Vec<String>,
    pub other: Vec<String>,
}

/// Classify a mod pack's contents against the live game: which of its sound
/// files shadow stock files by name (silent overwrites), plus every other file
/// it bundles by category. Cheap — one pack listing + the cached game sound
/// index.
#[tauri::command]
pub fn scan_pack_contents(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    pack_vpk: String,
) -> Result<PackContents, String> {
    use std::collections::HashSet;
    let files = crate::vpk::list(&helper_path, &pack_vpk, None)?;
    let index: HashSet<String> =
        game_sound_index(&app, &helper_path, &pak_path, false)?.into_iter().collect();
    let mut out = PackContents {
        overwrites: vec![],
        own_sounds: vec![],
        models: vec![],
        particles: vec![],
        materials: vec![],
        panorama: vec![],
        other: vec![],
    };
    for f in files {
        if f.starts_with("sounds/") && f.ends_with(".vsnd_c") {
            if index.contains(f.trim_end_matches("_c")) {
                out.overwrites.push(f);
            } else {
                out.own_sounds.push(f);
            }
        } else if f.starts_with("models/") {
            out.models.push(f);
        } else if f.starts_with("particles/") {
            out.particles.push(f);
        } else if f.starts_with("materials/") {
            out.materials.push(f);
        } else if f.starts_with("panorama/") {
            out.panorama.push(f);
        } else if !f.starts_with("soundevents/") {
            out.other.push(f);
        }
    }
    for list in [
        &mut out.overwrites,
        &mut out.own_sounds,
        &mut out.models,
        &mut out.particles,
        &mut out.materials,
        &mut out.panorama,
        &mut out.other,
    ] {
        list.sort();
    }
    Ok(out)
}

/// Extract an imported pack ONCE into an app-managed cache dir, so compiles,
/// previews and adopted-track staging never need the original `.vpk` again
/// (the whole vpk layer accepts the cache dir as a source). Asset trees are
/// copied verbatim; soundevents are stored as decompiled TEXT. Returns the
/// cache dir (already-cached dir inputs are returned as-is).
#[tauri::command]
pub fn cache_pack(
    app: tauri::AppHandle,
    helper_path: String,
    pack_vpk: String,
) -> Result<String, String> {
    use tauri::Manager;
    if std::path::Path::new(&pack_vpk).is_dir() {
        return Ok(pack_vpk); // re-import of an already-cached pack
    }
    // Friendly name (the vpk stem, or its folder for generic pakNN_dir.vpk)
    // plus a short hash of the full path for uniqueness.
    let norm = pack_vpk.replace('\\', "/");
    let mut parts: Vec<&str> = norm.split('/').filter(|s| !s.is_empty()).collect();
    let file = parts.pop().unwrap_or("pack");
    let stem = file.trim_end_matches(".vpk");
    let is_generic = stem.starts_with("pak")
        && stem.ends_with("_dir")
        && stem[3..stem.len() - 4].chars().all(|c| c.is_ascii_digit());
    let raw_name = if is_generic { parts.pop().unwrap_or(stem) } else { stem };
    let name: String = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in norm.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("packs")
        .join(format!("{name}_{:08x}", h as u32));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    for d in ["sounds/", "models/", "particles/", "materials/", "panorama/"] {
        let _ = crate::vpk::extract_all(&helper_path, &pack_vpk, &dir.to_string_lossy(), Some(d));
    }
    // Soundevents land as decompiled text (what the import + combine steps
    // read). True top-level files only — the listing is a substring match, so
    // working copies (NEWSoundevents/, MERGEDsoundevents/, backups) would
    // otherwise be cached as junk.
    for f in crate::vpk::list(&helper_path, &pack_vpk, Some("soundevents/"))? {
        let lower = f.to_lowercase();
        if !lower.starts_with("soundevents/")
            || lower.contains("backup")
            || lower.contains("newsoundevents")
            || lower.contains("merged")
        {
            continue;
        }
        let out = dir.join(f.trim_end_matches("_c"));
        if let Some(p) = out.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if f.ends_with(".vsndevts") {
            let _ = crate::vpk::extract(&helper_path, &pack_vpk, &f, &out.to_string_lossy());
        } else if f.ends_with(".vsndevts_c") {
            let _ = crate::vpk::decompile_from_vpk(&helper_path, &pack_vpk, &f, &out.to_string_lossy());
        }
    }
    // Record where this cache came from (for the curious / future tooling).
    let _ = std::fs::write(dir.join("eim_source.txt"), &pack_vpk);
    Ok(dir.to_string_lossy().replace('\\', "/"))
}

/// Which of a pack's files are byte-identical (CRC32, from the vpk indexes) to
/// the game's file at the same path — i.e. bundled-but-UNCHANGED vanilla
/// copies old packs ship. Drives the build preview's changed-only filter.
#[tauri::command]
pub fn pack_unchanged_files(
    helper_path: String,
    pak_path: String,
    source: String,
) -> Result<Vec<String>, String> {
    use std::collections::{HashMap, HashSet};
    let game: HashMap<String, u32> = crate::vpk::crcs(&helper_path, &pak_path, None)?
        .into_iter()
        .map(|(c, p)| (p, c))
        .collect();
    // Only pack paths that shadow a game path can be "unchanged" — restrict
    // hashing (relevant for cached-pack dirs) to those.
    let candidates: HashSet<String> = crate::vpk::list(&helper_path, &source, None)?
        .into_iter()
        .filter(|p| game.contains_key(p))
        .collect();
    if candidates.is_empty() {
        return Ok(vec![]);
    }
    let mut out: Vec<String> = crate::vpk::crcs(&helper_path, &source, Some(&candidates))?
        .into_iter()
        .filter(|(c, p)| candidates.contains(p) && game.get(p) == Some(c))
        .map(|(_, p)| p)
        .collect();
    out.sort();
    Ok(out)
}

/// Decompile a whole vpk into source form at `dest_dir` (structure preserved):
/// sounds → audio, textures → png, other resources → text, the rest copied
/// raw. Async + spawn_blocking — big paks take a while and the UI must stay
/// responsive.
#[tauri::command]
pub async fn decompile_vpk_all(
    helper_path: String,
    vpk: String,
    dest_dir: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::vpk::decompile_all(&helper_path, &vpk, &dest_dir)
    })
    .await
    .map_err(|e| format!("decompile task panicked: {e}"))?
}

/// Which sound event(s) reference a given `.vsnd`: one hit per (file, event,
/// array) that contains the ref in its entries.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefEventHit {
    pub reference: String,
    pub events_relpath: String,
    pub event_name: String,
    pub array_key: String,
}

/// Reverse-lookup: which events (in the local vanilla merge base) reference
/// each of `refs`. Used by the import review to turn a pack's stock-path
/// replacement files into proper array entries on their owning events instead
/// of raw file overwrites. Best-effort: only soundevents files already
/// decompiled under `vanilla_root` are scanned.
#[tauri::command]
pub fn events_for_refs(vanilla_root: String, refs: Vec<String>) -> Result<Vec<RefEventHit>, String> {
    use std::collections::HashSet;
    let want: HashSet<&str> = refs.iter().map(|s| s.as_str()).collect();
    if want.is_empty() {
        return Ok(vec![]);
    }
    let root = std::path::Path::new(&vanilla_root).join("soundevents");
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("vsndevts") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(arrays) = kv3_core::list_arrays(&text) else { continue };
            let rel = match p.strip_prefix(&root) {
                Ok(r) => format!("soundevents/{}", r.to_string_lossy().replace('\\', "/")),
                Err(_) => continue,
            };
            for a in arrays {
                for r in &a.entries {
                    if want.contains(r.as_str()) {
                        out.push(RefEventHit {
                            reference: r.clone(),
                            events_relpath: rel.clone(),
                            event_name: a.event_name.clone(),
                            array_key: a.array_key.clone(),
                        });
                    }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    /// The app-managed dir the fresh `soundevents/` tree was written into. The
    /// frontend points `vanillaRoot` here so merges read the current game data.
    pub vanilla_root: String,
    /// Relative events paths successfully refreshed.
    pub refreshed: Vec<String>,
    /// `"<relpath>: <error>"` for any that couldn't be decompiled.
    pub failed: Vec<String>,
}

/// Refresh the merge base from the live game pak: decompile each `<relpath>_c`
/// out of `pak_path` into an app-managed `vanilla/` dir, so compile merges into
/// the CURRENT game data instead of a stale snapshot (fixes drifted stock refs).
/// Non-destructive — never touches the user's own files.
#[tauri::command]
pub fn refresh_vanilla(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    relpaths: Vec<String>,
) -> Result<RefreshResult, String> {
    use tauri::Manager;
    let dest_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("vanilla");
    // Decompile in parallel: the full-pak sweep refreshes ~50 files and every
    // decompile is a helper-process spawn costing a few hundred ms, so serial
    // would make a "Fix for new patch" run take tens of seconds.
    let next = std::sync::atomic::AtomicUsize::new(0);
    let refreshed_m = std::sync::Mutex::new(Vec::new());
    let failed_m = std::sync::Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..relpaths.len().clamp(1, 8) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let Some(rel) = relpaths.get(i) else { break };
                let rel_trim = rel.trim_matches('/');
                let internal = format!("{rel_trim}_c");
                let dest = dest_root.join(rel_trim);
                if let Some(parent) = dest.parent() {
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        failed_m.lock().unwrap().push(format!("{rel}: {e}"));
                        continue;
                    }
                }
                match crate::vpk::decompile_from_vpk(
                    &helper_path,
                    &pak_path,
                    &internal,
                    &dest.to_string_lossy(),
                ) {
                    Ok(_) => refreshed_m.lock().unwrap().push(rel.clone()),
                    Err(e) => failed_m.lock().unwrap().push(format!("{rel}: {e}")),
                }
            });
        }
    });
    let refreshed = refreshed_m.into_inner().unwrap();
    let failed = failed_m.into_inner().unwrap();
    if refreshed.is_empty() && !failed.is_empty() {
        return Err(failed.join("; "));
    }
    Ok(RefreshResult {
        vanilla_root: dest_root.to_string_lossy().into_owned(),
        refreshed,
        failed,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsPaths {
    pub csdk_root: String,
    pub ffmpeg_path: String,
}

/// One-stop tools setup: download the prebuilt tools bundle (trimmed CSDK
/// compiler + static ffmpeg, ~434 MB zipped / ~1.1 GB on disk) and unpack it
/// into app-data `tools/`, returning the resulting paths for settings. Uses
/// Windows' bundled `curl.exe` + `tar.exe` (bsdtar reads zip) so no extra
/// crates are needed. Blocking work runs on a background thread.
#[tauri::command]
pub async fn download_tools(app: tauri::AppHandle, url: String) -> Result<ToolsPaths, String> {
    use tauri::Manager;
    let tools_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tools");
    tauri::async_runtime::spawn_blocking(move || {
        // Prefer the Windows-native curl/tar in System32: a bare name could
        // resolve to MSYS/GNU builds on PATH, and GNU tar treats `C:` in a
        // path as a remote host ("Cannot connect to C: resolve failed").
        let sys32 = std::env::var("WINDIR")
            .map(|w| std::path::PathBuf::from(w).join("System32"))
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Windows\System32"));
        let pick = |name: &str| -> String {
            let native = sys32.join(format!("{name}.exe"));
            if native.exists() {
                native.to_string_lossy().into_owned()
            } else {
                name.to_string()
            }
        };
        std::fs::create_dir_all(&tools_root).map_err(|e| e.to_string())?;
        let zip = tools_root.join("eim_tools_download.zip");
        let out = crate::procutil::quiet(pick("curl"))
            .args(["-L", "--fail", "-sS", "-o", &zip.to_string_lossy(), &url])
            .output()
            .map_err(|e| format!("launching curl: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "download failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let out = crate::procutil::quiet(pick("tar"))
            .args(["-xf", &zip.to_string_lossy(), "-C", &tools_root.to_string_lossy()])
            .output()
            .map_err(|e| format!("launching tar: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "extract failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        let _ = std::fs::remove_file(&zip);
        // The bundle unpacks to <tools>/EIM_Tools/{csdk,ffmpeg}.
        let root = tools_root.join("EIM_Tools");
        let csdk = root.join("csdk");
        let compiler = csdk
            .join("game")
            .join("bin_tools")
            .join("win64")
            .join("resourcecompiler.exe");
        if !compiler.exists() {
            return Err(format!(
                "bundle unpacked but resourcecompiler.exe not found at {}",
                compiler.display()
            ));
        }
        let ffmpeg = root.join("ffmpeg").join("ffmpeg.exe");
        Ok(ToolsPaths {
            csdk_root: csdk.to_string_lossy().into_owned(),
            ffmpeg_path: if ffmpeg.exists() {
                ffmpeg.to_string_lossy().into_owned()
            } else {
                String::new()
            },
        })
    })
    .await
    .map_err(|e| format!("download task panicked: {e}"))?
}

/// Enumerate every `.vsndevts` file in the game pak (relpaths with the compiled
/// `_c` suffix stripped), so the "Fix for new patch" sweep can account for every
/// sound-event file instead of a hardcoded few. The frontend filters out hero
/// files (browsed live by the Heroes tab) and voiceline/vo files.
#[tauri::command]
pub fn list_soundevent_files(
    helper_path: String,
    pak_path: String,
) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = crate::vpk::list(&helper_path, &pak_path, Some("soundevents/"))?
        .into_iter()
        .filter(|e| e.ends_with(".vsndevts_c"))
        .map(|e| e[..e.len() - 2].to_string())
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

/// Scan the Deadlock addons folder for occupied `pakNN_dir.vpk` slots + the next
/// free one (drives the install slot picker UI).
#[tauri::command]
pub fn scan_addon_slots(addons_dir: String) -> SlotScan {
    install::scan_slots(std::path::Path::new(&addons_dir))
}

/// Install a compiled `.vpk` into Deadlock's `game/citadel/addons` folder.
/// `slot = None` auto-picks the lowest free slot; `Some(n)` overwrites slot `n`
/// (backing up any existing occupant). `patch_gameinfo` adds the addons search
/// path to `gameinfo.gi` if missing.
#[tauri::command]
pub fn install_to_game(
    src_vpk: String,
    addons_dir: String,
    slot: Option<u32>,
    patch_gameinfo: bool,
) -> Result<InstallResult, String> {
    install::install(
        std::path::Path::new(&src_vpk),
        std::path::Path::new(&addons_dir),
        slot,
        patch_gameinfo,
    )
}

// --- Custom-game hosting (Custom Server tab) ---------------------------------

/// Report whether the install is ready to host (exe present + both gameinfo edits).
#[tauri::command]
pub fn host_status(deadlock_root: String) -> crate::host::HostStatus {
    crate::host::status(std::path::Path::new(&deadlock_root))
}

/// Apply the two `gameinfo.gi` edits that enable dedicated P2P hosting (backed up).
#[tauri::command]
pub fn setup_hosting(deadlock_root: String) -> Result<crate::host::HostStatus, String> {
    crate::host::setup(std::path::Path::new(&deadlock_root))
}

/// Remove the hosting edits (leaves the addons search path intact).
#[tauri::command]
pub fn revert_hosting(deadlock_root: String) -> Result<crate::host::HostStatus, String> {
    crate::host::revert(std::path::Path::new(&deadlock_root))
}

/// Shared host state: the RCON password of the server this app most recently
/// launched. Lives in Tauri-managed state so *any* window (main UI or the F8
/// mod-menu overlay) can drive the same server without passing the password
/// around. Cleared to None until a host is launched from the app.
#[derive(Default)]
pub struct HostState {
    pub rcon_password: std::sync::Mutex<Option<String>>,
}

/// Launch the installed client as a dedicated host on `map`. Stores the RCON
/// password in shared state and also returns it (with the PID) for display.
#[tauri::command]
pub fn launch_host(
    state: tauri::State<'_, HostState>,
    deadlock_root: String,
    map: String,
    max_players: Option<u32>,
) -> Result<crate::host::LaunchInfo, String> {
    let info = crate::host::launch(std::path::Path::new(&deadlock_root), &map, max_players)?;
    *state.rcon_password.lock().unwrap() = Some(info.rcon_password.clone());
    Ok(info)
}

/// Launch Deadlock (normal client, via Steam) to test an installed mod in a real
/// match. `deadlock_root` is only used as an exe fallback if Steam can't start.
#[tauri::command]
pub fn launch_game(deadlock_root: Option<String>) -> Result<(), String> {
    let root = deadlock_root.filter(|s| !s.is_empty());
    crate::host::launch_game(root.as_deref().map(std::path::Path::new))
}

/// Send a single RCON command to the server launched from this app and return
/// its console output. Uses the password stashed by `launch_host`.
#[tauri::command]
pub fn rcon_exec(state: tauri::State<'_, HostState>, command: String) -> Result<String, String> {
    let pw = state
        .rcon_password
        .lock()
        .unwrap()
        .clone()
        .ok_or("No host running from this app yet - click \"Host game now\" first.")?;
    crate::rcon::exec_auto(&pw, &command)
}

/// Whether a host has been launched from this app (so the admin/overlay knows
/// it can send commands).
#[tauri::command]
pub fn rcon_ready(state: tauri::State<'_, HostState>) -> bool {
    state.rcon_password.lock().unwrap().is_some()
}

/// Tail the dedicated server's `console.log` (written by `-condebug`). Reads only
/// the last `max_bytes` (default 96 KiB) so polling stays cheap even as the log
/// grows, and drops a partial leading line. This is the in-app replacement for
/// the server console window (which is blank under `tauri dev`).
#[tauri::command]
pub fn read_server_log(deadlock_root: String, max_bytes: Option<u64>) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = std::path::Path::new(&deadlock_root)
        .join("game")
        .join("citadel")
        .join("console.log");
    let mut f = match std::fs::File::open(&path) {
        Ok(f) => f,
        // No log yet (server never started) — empty, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(format!("opening console.log: {e}")),
    };
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let cap = max_bytes.unwrap_or(96 * 1024).max(1024);
    let start = len.saturating_sub(cap);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // If we seeked into the middle of the file, drop the partial first line.
    let trimmed = if start > 0 {
        text.find('\n').map(|i| &text[i + 1..]).unwrap_or(&text)
    } else {
        &text
    };
    Ok(trimmed.to_string())
}

/// The server's P2P connect id ([A:1:…]) from console.log, once it's up.
#[tauri::command]
pub fn host_connect_id(deadlock_root: String) -> Option<String> {
    crate::host::connect_id(std::path::Path::new(&deadlock_root))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedPaths {
    pub csdk_root: Option<String>,
    pub resource_compiler: Option<String>,
    pub deadlock_pak: Option<String>,
    pub addons_dir: Option<String>,
    pub ffmpeg: Option<String>,
    pub vpk_helper: Option<String>,
}

fn exists(p: &std::path::Path) -> bool {
    p.exists()
}

/// Read Steam's install path from the registry (`HKCU\Software\Valve\Steam`).
fn steam_path() -> Option<std::path::PathBuf> {
    let out = crate::procutil::quiet("reg")
        .args(["query", r"HKCU\SOFTWARE\Valve\Steam", "/v", "SteamPath"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    // Line looks like: `    SteamPath    REG_SZ    c:/program files (x86)/steam`
    for line in text.lines() {
        if let Some(idx) = line.find("REG_SZ") {
            let val = line[idx + "REG_SZ".len()..].trim();
            if !val.is_empty() {
                return Some(std::path::PathBuf::from(val));
            }
        }
    }
    None
}

/// All Steam library roots: the base install plus every `path` in
/// `libraryfolders.vdf`.
fn steam_libraries() -> Vec<std::path::PathBuf> {
    let mut libs = Vec::new();
    let Some(steam) = steam_path() else { return libs };
    libs.push(steam.clone());
    let vdf = steam.join("steamapps").join("libraryfolders.vdf");
    if let Ok(text) = std::fs::read_to_string(&vdf) {
        // Grab each `"path"   "<value>"` (value may contain escaped backslashes).
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("\"path\"") {
                if let Some(start) = rest.find('"') {
                    if let Some(end) = rest[start + 1..].find('"') {
                        let raw = &rest[start + 1..start + 1 + end];
                        libs.push(std::path::PathBuf::from(raw.replace("\\\\", "\\")));
                    }
                }
            }
        }
    }
    libs
}

/// Locate the Deadlock install (the dir containing `game/citadel`) across Steam
/// libraries.
fn deadlock_root() -> Option<std::path::PathBuf> {
    for lib in steam_libraries() {
        let root = lib.join("steamapps").join("common").join("Deadlock");
        if root.join("game").join("citadel").is_dir() {
            return Some(root);
        }
    }
    None
}

/// Look for a Reduced/Citadel SDK (a dir with `game/bin_tools/win64/
/// resourcecompiler.exe`) under a few likely parents.
fn find_csdk(home: &std::path::Path, exe_dir: Option<&std::path::Path>) -> Option<std::path::PathBuf> {
    let rc_rel = std::path::Path::new("game/bin_tools/win64/resourcecompiler.exe");
    let mut bases: Vec<std::path::PathBuf> = vec![
        home.join("Desktop").join("DeadlockModding"),
        home.join("Desktop"),
        home.join("Documents"),
        home.to_path_buf(),
    ];
    // Walk a few parents up from the running exe too (dev checkout layout).
    if let Some(mut d) = exe_dir.map(|p| p.to_path_buf()) {
        for _ in 0..6 {
            bases.push(d.clone());
            if !d.pop() {
                break;
            }
        }
    }
    for base in bases {
        // The base itself might be a CSDK.
        if base.join(rc_rel).exists() {
            return Some(base);
        }
        if let Ok(rd) = std::fs::read_dir(&base) {
            for entry in rd.flatten() {
                let p = entry.path();
                if !p.is_dir() {
                    continue;
                }
                let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
                if name.contains("csdk") || name.contains("sdk") {
                    if p.join(rc_rel).exists() {
                        return Some(p);
                    }
                }
            }
        }
    }
    None
}

/// Locate the bundled/dev vpk-helper relative to the running exe.
fn find_vpk_helper(exe_dir: Option<&std::path::Path>, resource_dir: Option<&std::path::Path>) -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    for base in [exe_dir, resource_dir].into_iter().flatten() {
        candidates.push(base.join("vpk-helper.exe"));
        candidates.push(base.join("vpk-helper").join("vpk-helper.exe"));
        candidates.push(base.join("vpk-helper.dll"));
    }
    // Dev checkout: walk parents looking for the helper. Prefer the self-contained
    // `dist/vpk-helper.exe` (no .NET runtime needed) over the framework-dependent
    // `bin/Release/*.dll` (needs `dotnet` on PATH).
    if let Some(mut d) = exe_dir.map(|p| p.to_path_buf()) {
        for _ in 0..6 {
            for rel in [
                "tools/vpk-helper/dist/vpk-helper.exe",
                "tools/vpk-helper/bin/Release/net10.0/win-x64/vpk-helper.exe",
                "tools/vpk-helper/bin/Release/net10.0/vpk-helper.exe",
                "tools/vpk-helper/bin/Release/net10.0/vpk-helper.dll",
            ] {
                let cand = d.join(rel);
                if cand.exists() {
                    return Some(cand.to_string_lossy().into_owned());
                }
            }
            if !d.pop() {
                break;
            }
        }
    }
    candidates.into_iter().find(|p| exists(p)).map(|p| p.to_string_lossy().into_owned())
}

/// True if a bare `ffmpeg` runs (i.e. it's on PATH).
fn ffmpeg_on_path() -> bool {
    crate::procutil::quiet("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Best-effort auto-detection of the tool/game paths the user would otherwise
/// type into Setup. Everything is optional — missing items come back as `null`.
#[tauri::command]
pub fn autodetect_paths(app: tauri::AppHandle) -> DetectedPaths {
    use tauri::Manager;
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(|p| p.parent()).map(|p| p.to_path_buf());
    let resource_dir = app.path().resource_dir().ok();
    let home = app
        .path()
        .home_dir()
        .ok()
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let deadlock = deadlock_root();
    let deadlock_pak = deadlock.as_ref().map(|r| {
        r.join("game/citadel/pak01_dir.vpk").to_string_lossy().replace('\\', "/")
    });
    let deadlock_pak = deadlock_pak.filter(|p| std::path::Path::new(p).exists());

    let addons_dir = deadlock.as_ref().map(|r| {
        r.join("game/citadel/addons").to_string_lossy().replace('\\', "/")
    });
    let addons_dir = addons_dir.filter(|p| std::path::Path::new(p).is_dir());

    let csdk = find_csdk(&home, exe_dir.as_deref());
    let resource_compiler = csdk.as_ref().map(|c| {
        c.join("game/bin_tools/win64/resourcecompiler.exe").to_string_lossy().replace('\\', "/")
    });

    DetectedPaths {
        csdk_root: csdk.map(|c| c.to_string_lossy().replace('\\', "/")),
        resource_compiler,
        deadlock_pak,
        addons_dir,
        ffmpeg: if ffmpeg_on_path() { Some("ffmpeg".into()) } else { None },
        vpk_helper: find_vpk_helper(exe_dir.as_deref(), resource_dir.as_deref())
            .map(|p| p.replace('\\', "/")),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroPortrait {
    /// Hero codename from the game data (e.g. `orion`, `punkgoat`).
    pub codename: String,
    /// The in-game display name (e.g. "Grey Talon", "Billy").
    pub display_name: String,
    /// Absolute path to the decoded card PNG (frontend wraps with convertFileSrc).
    pub portrait_path: String,
    /// Absolute path to the decoded "gloat" card PNG (hover state), if it exists.
    pub gloat_path: Option<String>,
    /// Disabled or still in development — hidden unless "show experimental" is on.
    pub experimental: bool,
    /// The hero's in-game UI theme colors (`#RRGGBB` from `m_colorUI`), if any.
    pub color: Option<String>,
    pub color_secondary: Option<String>,
}

/// Template / dummy / placeholder hero keys that are never real playable heroes
/// (and would otherwise show as duplicates, e.g. `testhero` == Calico's art).
const HERO_CODE_DENYLIST: &[&str] = &[
    "base",
    "testhero",
    "targetdummy",
    "genericperson",
    "generic",
    "dummy",
];

fn prettify_words(raw: &str) -> String {
    // Hand-fixes where the asset name isn't quite the in-game display name.
    match raw {
        "mo_krill" => return "Mo & Krill".to_string(),
        "mcginnis" => return "McGinnis".to_string(),
        // Recent heroes whose logo asset still uses the old codename.
        "familiar" => return "Rem".to_string(),
        "fencer" => return "Apollo".to_string(),
        "necro" => return "Graves".to_string(),
        "priest" => return "Venator".to_string(),
        "unicorn" => return "Celeste".to_string(),
        "werewolf" => return "Silver".to_string(),
        _ => {}
    }
    raw.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Default)]
struct HeroInfo {
    /// vdata key minus the `hero_` prefix (e.g. `orion`).
    code: String,
    /// In-game name from the logo SVG (e.g. `grey_talon`), if any.
    name: Option<String>,
    /// Portrait image code from `m_strIconHeroCard` (e.g. `archer`), if any.
    card_code: Option<String>,
    disabled: bool,
    in_dev: bool,
    /// The hero's `m_colorUI` theme colors as `#RRGGBB` (primary, then secondary).
    /// The in-game hero cards use both as a gradient.
    color: Option<String>,
    color_secondary: Option<String>,
}

/// `m_colorUI = [ 32, 146, 174 ]` -> `#2092ae`.
fn parse_color_ui(line: &str) -> Option<String> {
    let inner = between(line, "[", "]")?;
    let parts: Vec<u8> = inner
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .map(|n| n.min(255) as u8)
        .collect();
    if parts.len() >= 3 {
        Some(format!("#{:02x}{:02x}{:02x}", parts[0], parts[1], parts[2]))
    } else {
        None
    }
}

/// Substring of `line` between `start` and `end` markers (first occurrence).
fn between<'a>(line: &'a str, start: &str, end: &str) -> Option<&'a str> {
    let s = line.find(start)? + start.len();
    let rest = &line[s..];
    let e = rest.find(end)?;
    Some(&rest[..e])
}

/// Parse `heroes.vdata` (KV3 text) into per-hero name/portrait/flags. Line-based:
/// a `hero_<code> =` line opens a hero; its `m_bDisabled`, `m_bInDevelopment`,
/// `m_strLogoImageEnglish` (real name) and `m_strIconHeroCard` (portrait code)
/// follow within the block.
fn parse_heroes_vdata(text: &str) -> Vec<HeroInfo> {
    let mut out: Vec<HeroInfo> = Vec::new();
    let mut cur: Option<HeroInfo> = None;
    for line in text.lines() {
        let t = line.trim();
        let key = t.strip_suffix('=').map(str::trim);
        if let Some(k) = key {
            if let Some(code) = k.strip_prefix("hero_") {
                if !code.is_empty()
                    && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                {
                    if let Some(h) = cur.take() {
                        out.push(h);
                    }
                    cur = Some(HeroInfo { code: code.to_string(), ..Default::default() });
                    continue;
                }
            }
        }
        let Some(h) = cur.as_mut() else { continue };
        if t.starts_with("m_bDisabled") {
            h.disabled = t.contains("true");
        } else if t.starts_with("m_bInDevelopment") {
            h.in_dev = t.contains("true");
        } else if h.name.is_none() && t.starts_with("m_strLogoImageEnglish") {
            if let Some(n) = between(t, "hero_names/", ".svg") {
                h.name = Some(n.trim_end_matches("_localized").to_string());
            }
        } else if h.card_code.is_none() && t.starts_with("m_strIconHeroCard") {
            if let Some(c) = between(t, "heroes/", "_card.psd") {
                h.card_code = Some(c.to_string());
            }
        } else if t.starts_with("m_colorUI") {
            // First m_colorUI = primary, second = secondary.
            if h.color.is_none() {
                h.color = parse_color_ui(t);
            } else if h.color_secondary.is_none() {
                h.color_secondary = parse_color_ui(t);
            }
        }
    }
    if let Some(h) = cur.take() {
        out.push(h);
    }
    out
}

/// Decode (and cache) hero card portraits and resolve the real roster from the
/// game's `heroes.vdata`: in-game names, portrait join, and an experimental flag
/// (disabled / in-development). Cache lives in app-data/hero_portraits; pass
/// `refresh = true` to re-pull after a game update.
fn hero_roster_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    refresh: Option<bool>,
) -> Result<Vec<HeroPortrait>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let refresh = refresh.unwrap_or(false);

    // 1. Decode every hero card portrait (one pass), keyed by portrait code. Also
    //    require the gloat (hover) cards — re-decode if the cache predates them.
    let mut have_pngs = false;
    let mut have_gloat = false;
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if name.ends_with("_gloat.png") {
                have_gloat = true;
            } else if name.ends_with(".png") {
                have_pngs = true;
            }
        }
    }
    if refresh || !have_pngs || !have_gloat {
        crate::vpk::heroes(&helper_path, &pak_path, &dir.to_string_lossy())?;
    }

    // 2. Decompile the hero data (authoritative names + flags + portrait codes).
    let vdata = dir.join("heroes.vdata");
    if refresh || !vdata.exists() {
        crate::vpk::decompile_from_vpk(
            &helper_path,
            &pak_path,
            "scripts/heroes.vdata_c",
            &vdata.to_string_lossy(),
        )?;
    }
    // A refresh re-pulls game data, so the cached vdata + per-hero ability detail
    // may be stale — drop them so they rebuild on next open.
    if refresh {
        let _ = std::fs::remove_file(dir.join("abilities.vdata"));
        let _ = std::fs::remove_file(dir.join("hero_sound_files.txt"));
        let _ = std::fs::remove_file(dir.join("event_index.json"));
        let _ = std::fs::remove_dir_all(dir.join("heroevents"));
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("detail_") && name.ends_with(".json") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let text = std::fs::read_to_string(&vdata).map_err(|e| e.to_string())?;

    // 3. Join each hero to its decoded portrait.
    let mut out = Vec::new();
    for h in parse_heroes_vdata(&text) {
        if HERO_CODE_DENYLIST.contains(&h.code.as_str()) {
            continue;
        }
        // The portrait file is keyed by the card code (e.g. orion -> archer);
        // fall back to the hero code if there's no explicit card image.
        let png = h
            .card_code
            .as_deref()
            .map(|c| dir.join(format!("{c}.png")))
            .filter(|p| p.exists())
            .or_else(|| {
                let p = dir.join(format!("{}.png", h.code));
                p.exists().then_some(p)
            });
        let Some(png) = png else { continue };
        // Skip blank/placeholder cards (tiny PNGs).
        if std::fs::metadata(&png).map(|m| m.len()).unwrap_or(0) < 4000 {
            continue;
        }
        // The matching gloat (hover) card, if one was decoded.
        let gloat_path = png
            .file_stem()
            .and_then(|s| s.to_str())
            .map(|stem| dir.join(format!("{stem}_gloat.png")))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned());
        let display_name = h
            .name
            .as_deref()
            .map(prettify_words)
            .unwrap_or_else(|| prettify_words(&h.code));
        out.push(HeroPortrait {
            codename: h.code,
            display_name,
            portrait_path: png.to_string_lossy().into_owned(),
            gloat_path,
            experimental: h.disabled || h.in_dev,
            color: h.color,
            color_secondary: h.color_secondary,
        });
    }
    out.sort_by(|a, b| {
        a.experimental
            .cmp(&b.experimental)
            .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
    });
    Ok(out)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeroAbilitySound {
    /// Soundevent name, e.g. `Doorman.CallBell.Cast`.
    pub event_name: String,
    /// Which array within the event (always `vsnd_files` here).
    pub array_key: String,
    /// The soundevents file the event lives in (relative).
    pub events_relpath: String,
    /// Friendly label from the ability field, e.g. "Cast", "Impact".
    pub label: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeroAbility {
    /// Signature slot 1..4.
    pub slot: u32,
    /// Ability entity name (e.g. `ability_doorman_bomb`).
    pub ability: String,
    /// Decoded icon PNG path (frontend wraps with convertFileSrc).
    pub icon_path: Option<String>,
    /// The compiled `.vtex_c` the game references — the override target for
    /// a custom ability icon (IconMod), when known.
    #[serde(default)]
    pub icon_target: Option<String>,
    /// The distinct sound events this ability triggers.
    pub sounds: Vec<HeroAbilitySound>,
}

/// The 4 signature abilities bound to `hero_<code>` (slot -> ability name).
fn hero_bound_abilities(vdata: &str, code: &str) -> Vec<(u32, String)> {
    let open = format!("hero_{code}");
    let mut in_hero = false;
    let mut out = Vec::new();
    for line in vdata.lines() {
        let t = line.trim();
        if let Some(k) = t.strip_suffix('=').map(str::trim) {
            if let Some(c) = k.strip_prefix("hero_") {
                if c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                    if in_hero {
                        break; // reached the next hero
                    }
                    in_hero = k == open;
                    continue;
                }
            }
        }
        if !in_hero {
            continue;
        }
        if let Some(rest) = t.strip_prefix("ESlot_Signature_") {
            // `N = "ability_x"`
            let mut it = rest.splitn(2, '=');
            let n: u32 = it.next().unwrap_or("").trim().parse().unwrap_or(0);
            if let Some(v) = it.next().and_then(|s| between(s, "\"", "\"")) {
                if n >= 1 && !v.is_empty() {
                    out.push((n, v.to_string()));
                }
            }
        }
    }
    out.sort_by_key(|(n, _)| *n);
    out
}

struct AbilityDef {
    icon_internal: Option<String>,
    /// (label, event) pairs in declaration order.
    sounds: Vec<(String, String)>,
    /// (propKey, value) pairs from `m_mapAbilityProperties` that carry an
    /// `m_strValue` — the editable designer-facing numbers (cooldown, range,
    /// damage, …). Declaration order preserved.
    props: Vec<(String, String)>,
    /// T1/T2/T3 ability-upgrade bonuses from `m_vecAbilityUpgrades`:
    /// (tier, propertyName, bonus). Declaration order = the `m_strBonus`
    /// occurrence index used to address them on rewrite (`@upgrade:N`).
    upgrades: Vec<(u32, String, String)>,
}

/// Count leading tab characters (block depth in the decompiled KV3).
fn tab_depth(line: &str) -> usize {
    line.chars().take_while(|&c| c == '\t').count()
}

/// Turn an ability sound field key into a label, e.g. `m_strCastSound` -> "Cast",
/// `m_HitConfirmSound` -> "Hit Confirm".
fn clean_sound_label(key: &str) -> String {
    let k = key.trim().strip_prefix("m_").unwrap_or(key);
    // Drop the leading lowercase run (str / s / vec ...) before the first cap.
    let k = k.trim_start_matches(|c: char| c.is_ascii_lowercase());
    let k = k.strip_suffix("Sound").unwrap_or(k);
    // camelCase -> spaced words.
    let mut out = String::new();
    for (i, ch) in k.chars().enumerate() {
        if ch.is_ascii_uppercase() && i > 0 {
            out.push(' ');
        }
        out.push(ch);
    }
    out
}

/// Parse `abilities.vdata` into `ability_name -> {icon, sounds}` in one pass.
/// Ability entity names vary wildly (`ability_*`, `citadel_ability_*`, and bare
/// names like `viscous_goo_grenade`), so top-level blocks are detected by
/// indentation (exactly one leading tab), not by a name prefix.
fn parse_abilities(vdata: &str) -> std::collections::HashMap<String, AbilityDef> {
    let mut map = std::collections::HashMap::new();
    let mut cur_name: Option<String> = None;
    let mut cur = AbilityDef { icon_internal: None, sounds: vec![], props: vec![], upgrades: vec![] };
    // Tab depth of the `m_mapAbilityProperties` key while we're inside its block
    // (None when outside). Property openers sit at `props_depth + 1`, their
    // `m_strValue` at `props_depth + 2`.
    let mut props_depth: Option<usize> = None;
    let mut cur_prop: Option<String> = None;
    // Tab depth of `m_vecAbilityUpgrades` while inside it. Tier objects open at
    // `up_depth + 1`; property/bonus pairs sit at `up_depth + 4`.
    let mut up_depth: Option<usize> = None;
    let mut up_tier: u32 = 0;
    let mut up_prop: Option<String> = None;
    for line in vdata.lines() {
        let top_level = line.starts_with('\t') && !line.starts_with("\t\t");
        let depth = tab_depth(line);
        let t = line.trim();
        // Top-level block opener: `<name> =` (the `{` is on the next line).
        if top_level {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    if let Some(name) = cur_name.take() {
                        map.insert(name, std::mem::replace(&mut cur, AbilityDef { icon_internal: None, sounds: vec![], props: vec![], upgrades: vec![] }));
                    }
                    cur_name = Some(k.to_string());
                    props_depth = None;
                    cur_prop = None;
                    up_depth = None;
                    up_tier = 0;
                    up_prop = None;
                    continue;
                }
            }
        }
        if cur_name.is_none() {
            continue;
        }
        // Track the m_mapAbilityProperties sub-block to harvest editable numbers.
        if let Some(pd) = props_depth {
            // The map's own closing brace sits at its own depth.
            if depth <= pd && t == "}" {
                props_depth = None;
                cur_prop = None;
            } else if depth == pd + 1 {
                // A property opener: `PropName =`.
                if let Some(k) = t.strip_suffix('=').map(str::trim) {
                    if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                        cur_prop = Some(k.to_string());
                    }
                }
            } else if depth == pd + 2 && t.starts_with("m_strValue") {
                if let (Some(name), Some(v)) = (cur_prop.as_ref(), between(t, "\"", "\"")) {
                    cur.props.push((name.clone(), v.to_string()));
                    cur_prop = None; // first value only; ignore deeper nested ones
                }
            }
            continue;
        }
        // Track the m_vecAbilityUpgrades vector to harvest per-tier bonuses.
        if let Some(ud) = up_depth {
            if depth <= ud && t == "]" {
                up_depth = None;
            } else if depth == ud + 1 && t == "{" {
                up_tier += 1; // each direct child object is the next upgrade tier
            } else if depth == ud + 4 && t.starts_with("m_strPropertyName") {
                up_prop = between(t, "\"", "\"").map(str::to_string);
            } else if depth == ud + 4 && t.starts_with("m_strBonus") {
                // value may be quoted ("2") or bare (-12.0).
                let raw = t.split_once('=').map(|(_, v)| v.trim().trim_matches('"').to_string());
                if let (Some(prop), Some(v)) = (up_prop.take(), raw) {
                    cur.upgrades.push((up_tier, prop, v));
                }
            }
            continue;
        }
        if t.starts_with("m_mapAbilityProperties") && t.ends_with('=') {
            props_depth = Some(depth);
            cur_prop = None;
        } else if t.starts_with("m_vecAbilityUpgrades") && t.ends_with('=') {
            up_depth = Some(depth);
            up_tier = 0;
            up_prop = None;
        } else if cur.icon_internal.is_none() && t.starts_with("m_strAbilityImage") {
            if let Some(p) = between(t, "{images}/", ".psd") {
                cur.icon_internal = Some(format!("panorama/images/{p}_psd.vtex_c"));
            }
        } else if let Some(ev) = between(t, "soundevent:\"", "\"") {
            if !ev.is_empty() {
                let key = t.split('=').next().unwrap_or("");
                cur.sounds.push((clean_sound_label(key), ev.to_string()));
            }
        }
    }
    if let Some(name) = cur_name.take() {
        map.insert(name, cur);
    }
    map
}

// ---------------------------------------------------------------------------
// Gameplay config editor (Custom Server tab): read a hero's signature abilities
// and their editable numeric properties out of abilities.vdata.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AbilityProp {
    /// Raw property key, e.g. `AbilityCooldownBetweenCharge`.
    pub key: String,
    /// Friendly label, e.g. "Cooldown Between Charge".
    pub label: String,
    /// Raw stored value (may carry a unit suffix, e.g. `20m`).
    pub value: String,
    /// Numeric part parsed out of `value` (0 if not numeric).
    pub number: f64,
    /// Unit suffix stripped from `value` (e.g. `m`), empty if none.
    pub unit: String,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AbilityConfig {
    /// Ability entity key, e.g. `ability_incendiary_projectile` (the override target).
    pub key: String,
    /// Signature slot (1..4).
    pub slot: u32,
    /// Friendly ability name.
    pub name: String,
    /// Decoded icon PNG path (frontend wraps with convertFileSrc), or "".
    pub icon_path: String,
    pub props: Vec<AbilityProp>,
}

/// Split a stored value like `20m` / `4.5m` / `-1.0` into (number, unit).
fn split_value_unit(v: &str) -> (f64, String) {
    let v = v.trim();
    let end = v
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_digit() || *c == '.' || *c == '-' || *c == '+')
        .map(|(i, c)| i + c.len_utf8())
        .last()
        .unwrap_or(0);
    let (num, unit) = v.split_at(end);
    (num.parse().unwrap_or(0.0), unit.trim().to_string())
}

/// `AbilityCooldownBetweenCharge` -> "Cooldown Between Charge" (drops a leading
/// `Ability` prefix, splits camelCase into words).
fn prettify_prop_key(key: &str) -> String {
    let k = key.strip_prefix("Ability").filter(|s| !s.is_empty()).unwrap_or(key);
    let mut out = String::new();
    for (i, ch) in k.chars().enumerate() {
        if ch.is_ascii_uppercase() && i > 0 && !out.ends_with(' ') {
            out.push(' ');
        }
        out.push(ch);
    }
    out
}

/// Build the full editable-prop list for one ability/item: its base
/// `m_mapAbilityProperties` followed by its T1/T2/T3 upgrade bonuses. Upgrades
/// are keyed `@upgrade:<index>` so the same override pipeline can rewrite the
/// matching `m_strBonus`.
fn ability_props(def: &AbilityDef) -> Vec<AbilityProp> {
    let mut out: Vec<AbilityProp> = def
        .props
        .iter()
        .map(|(k, v)| {
            let (number, unit) = split_value_unit(v);
            AbilityProp { key: k.clone(), label: prettify_prop_key(k), value: v.clone(), number, unit }
        })
        .collect();
    for (i, (tier, prop, bonus)) in def.upgrades.iter().enumerate() {
        let (number, unit) = split_value_unit(bonus);
        out.push(AbilityProp {
            key: format!("@upgrade:{i}"),
            label: format!("T{tier} upgrade · {}", prettify_prop_key(prop)),
            value: bonus.clone(),
            number,
            unit,
        });
    }
    out
}

/// `ability_incendiary_projectile` / `citadel_ability_x` -> "Incendiary Projectile".
fn prettify_ability_name(key: &str) -> String {
    let k = key
        .strip_prefix("citadel_ability_")
        .or_else(|| key.strip_prefix("ability_"))
        .unwrap_or(key);
    k.split('_')
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Read a hero's four signature abilities and their editable properties out of
/// the live `abilities.vdata` (decompiled + cached alongside the hero portraits).
/// Icons are decoded once and cached. Static game data → safe to cache.
#[tauri::command]
pub fn hero_config(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    codename: String,
) -> Result<Vec<AbilityConfig>, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let heroes = base.join("heroes.vdata");
    if !heroes.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/heroes.vdata_c", &heroes.to_string_lossy())?;
    }
    let abilities = base.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let heroes_text = std::fs::read_to_string(&heroes).map_err(|e| e.to_string())?;
    let abilities_text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;

    let bound = hero_bound_abilities(&heroes_text, &codename);
    if bound.is_empty() {
        return Err(format!("no signature abilities for hero '{codename}'"));
    }
    let ability_map = parse_abilities(&abilities_text);

    // Decode the ability icons (one batch), reusing the hero_detail icon cache.
    let icon_dir = base.join("ability_icons").join(&codename);
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;
    let stem_of = |internal: &str| -> String {
        internal.rsplit('/').next().unwrap_or(internal).trim_end_matches(".vtex_c").to_string()
    };
    let need: Vec<String> = bound
        .iter()
        .filter_map(|(_, a)| ability_map.get(a).and_then(|d| d.icon_internal.clone()))
        .filter(|i| !icon_dir.join(format!("{}.png", stem_of(i))).exists())
        .collect();
    if !need.is_empty() {
        let _ = crate::vpk::texture_batch(&helper_path, &pak_path, &icon_dir.to_string_lossy(), &need);
    }

    let mut out = Vec::new();
    for (slot, key) in bound {
        let def = ability_map.get(&key);
        let icon_path = def
            .and_then(|d| d.icon_internal.as_deref())
            .map(|i| icon_dir.join(format!("{}.png", stem_of(i))))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let props = def.map(ability_props).unwrap_or_default();
        out.push(AbilityConfig {
            name: prettify_ability_name(&key),
            key,
            slot,
            icon_path,
            props,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Global stats (Custom Server tab): curated match-wide values from
// scripts/generic_data.vdata (gold, bonus health, durations). Flat nested
// scalars, matched by their (unique) field name.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalStat {
    /// Field name as it appears in generic_data.vdata, e.g. `m_nTier1GoldKill`.
    pub key: String,
    /// Friendly label.
    pub label: String,
    /// Grouping header (Gold / Health / Timers …).
    pub group: String,
    /// Current value string.
    pub value: String,
    pub number: f64,
    pub unit: String,
}

/// Curated, uniquely-named global fields: (key, group, label). Only fields whose
/// name occurs exactly once in the file are safe to edit by name match.
const GLOBAL_FIELDS: &[(&str, &str, &str)] = &[
    ("m_GoldPerOrb", "Gold", "Gold per Orb"),
    ("m_nTier1GoldKill", "Gold", "Tier 1 Boss Gold (kill)"),
    ("m_nTier2GoldKill", "Gold", "Tier 2 Boss Gold (kill)"),
    ("m_nBaseGuardiansGoldKill", "Gold", "Guardian Gold (kill)"),
    ("m_nShrinesGoldKill", "Gold", "Shrine Gold (kill)"),
    ("m_nTier2BonusHealth", "Health", "Tier 2 Bonus Health"),
    ("m_nComebackBonusHealth", "Health", "Comeback Bonus Health"),
    ("m_nComebackBonusHealthCritical", "Health", "Comeback Bonus Health (critical)"),
    ("m_flIdolDropDuration", "Timers", "Idol Drop Duration"),
    ("m_flRejuvinatorBuffDuration", "Timers", "Rejuvenator Buff Duration"),
    ("m_flRejuvinatorDropDuration", "Timers", "Rejuvenator Drop Duration"),
    ("m_flBuyTimeGracePeriod", "Timers", "Buy Time Grace Period"),
    ("m_flScoringTime", "Timers", "Scoring Time"),
];

/// Read the current values of the curated global fields out of the live
/// `generic_data.vdata`. Fields not present in the file are skipped.
#[tauri::command]
pub fn global_config(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
) -> Result<Vec<GlobalStat>, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let gd = base.join("generic_data.vdata");
    if !gd.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/generic_data.vdata_c", &gd.to_string_lossy())?;
    }
    let text = std::fs::read_to_string(&gd).map_err(|e| e.to_string())?;
    // key -> current value (first occurrence).
    let mut found: std::collections::HashMap<&str, String> = std::collections::HashMap::new();
    for line in text.lines() {
        let t = line.trim();
        if let Some((k, v)) = t.split_once(" = ") {
            for (key, _, _) in GLOBAL_FIELDS {
                if k == *key && !found.contains_key(key) {
                    found.insert(key, v.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    let mut out = Vec::new();
    for (key, group, label) in GLOBAL_FIELDS {
        if let Some(v) = found.get(key) {
            let (number, unit) = split_value_unit(v);
            out.push(GlobalStat {
                key: key.to_string(),
                label: label.to_string(),
                group: group.to_string(),
                value: v.clone(),
                number,
                unit,
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Randomize mode (Custom Server): roll a random factor over every positive
// gameplay number — abilities, items, and curated global stats.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RandomConfig {
    pub vdata: Vec<crate::project::VdataOverride>,
    pub global: Vec<crate::project::GlobalOverride>,
    pub world: Vec<crate::project::WorldOverride>,
}

/// Curated gun stats to randomize, harvested from a weapon entry's
/// `m_WeaponInfo` block. Kept to the meaningful, uniquely-named fields.
const GUN_FIELDS: &[&str] = &[
    "m_flBulletDamage",
    "m_iBullets",
    "m_flCycleTime",
    "m_iClipSize",
    "m_reloadDuration",
    "m_flRange",
    "m_flBulletSpeed",
    "m_flBulletRadius",
];

/// Harvest gun stats from `citadel_weapon_*` entries: returns
/// (weaponKey, field, value) for each curated `m_WeaponInfo` field. Scoped to the
/// direct children of `m_WeaponInfo` (one level), so recoil sub-blocks are ignored.
fn parse_weapon_stats(vdata: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    let mut is_weapon = false;
    let mut wi_depth: Option<usize> = None;
    for line in vdata.lines() {
        let depth = line.chars().take_while(|&c| c == '\t').count();
        let t = line.trim();
        if depth == 1 {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur = Some(k.to_string());
                    is_weapon = k.starts_with("citadel_weapon");
                    wi_depth = None;
                    continue;
                }
            }
        }
        if !is_weapon {
            continue;
        }
        match wi_depth {
            None => {
                if t.starts_with("m_WeaponInfo") && t.ends_with('=') {
                    wi_depth = Some(depth);
                }
            }
            Some(wd) => {
                if depth <= wd && t == "}" {
                    wi_depth = None;
                } else if depth == wd + 1 {
                    if let Some(eq) = t.find(" = ") {
                        let field = &t[..eq];
                        if GUN_FIELDS.contains(&field) {
                            let val = t[eq + 3..].trim().trim_matches('"');
                            if let Some(c) = &cur {
                                out.push((c.clone(), field.to_string(), val.to_string()));
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

/// Harvest flat `leaf = value` fields from a named depth-2 sub-map (e.g.
/// `m_mapStartingStats`) inside each top-level block. Returns (entity, leaf,
/// value). Used to randomize hero base stats / per-level "investment" scaling,
/// which live one level deep in heroes.vdata.
fn parse_submap_stats(vdata: &str, submap: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    let mut in_submap: Option<usize> = None;
    for line in vdata.lines() {
        let depth = line.chars().take_while(|&c| c == '\t').count();
        let t = line.trim();
        if depth == 1 {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur = Some(k.to_string());
                    in_submap = None;
                    continue;
                }
            }
        }
        match in_submap {
            None => {
                if depth == 2 && t.strip_suffix('=').map(str::trim) == Some(submap) {
                    in_submap = Some(2);
                }
            }
            Some(sd) => {
                if depth <= sd && t == "}" {
                    in_submap = None;
                } else if depth == sd + 1 {
                    if let Some((leaf, val)) = t.split_once(" = ") {
                        if let Some(c) = &cur {
                            out.push((c.clone(), leaf.to_string(), val.trim().trim_matches('"').to_string()));
                        }
                    }
                }
            }
        }
    }
    out
}

/// True if `s` is a bare scalar number (int/float, optional unit suffix like
/// `m`). Rejects arrays (`[ … ]`), booleans, GUIDs and resource/soundevent
/// strings — used to gate the catch-all "unsorted" sweep to real numbers.
fn looks_numeric(s: &str) -> bool {
    let s = s.trim();
    match s.chars().next() {
        Some(c) if c.is_ascii_digit() || c == '-' || c == '.' => !s.contains(',') && !s.contains(' '),
        _ => false,
    }
}

/// Generic numeric harvest for the "unsorted" catch-all: every bare-number field
/// at depth 2 (direct field of a top-level block) or depth 3 (a leaf inside a
/// depth-2 sub-map). Returns (entity, field, value) where `field` is the bare
/// key for depth-2 fields and `submap::leaf` for depth-3 leaves — exactly the two
/// address forms `apply_world_overrides` understands. Deeper nesting is skipped.
fn parse_numeric_tree(vdata: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut cur: Option<String> = None;
    let mut submap: Option<String> = None;
    for line in vdata.lines() {
        let depth = line.chars().take_while(|&c| c == '\t').count();
        let t = line.trim();
        if depth == 1 {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur = Some(k.to_string());
                    submap = None;
                    continue;
                }
            }
        }
        let Some(c) = cur.as_ref() else { continue };
        if depth == 2 {
            if t == "}" {
                submap = None;
            } else if let Some((k, v)) = t.split_once(" = ") {
                let raw = v.trim().trim_matches('"');
                if looks_numeric(raw) {
                    out.push((c.clone(), k.to_string(), raw.to_string()));
                }
            } else if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    submap = Some(k.to_string());
                }
            }
        } else if depth == 3 {
            if let (Some(sm), Some((k, v))) = (submap.as_ref(), t.split_once(" = ")) {
                let raw = v.trim().trim_matches('"');
                if looks_numeric(raw) {
                    out.push((c.clone(), format!("{sm}::{k}"), raw.to_string()));
                }
            }
        }
    }
    out
}

/// xorshift64 — small deterministic RNG so we don't pull in the `rand` crate.
fn xorshift(state: &mut u64) -> f64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    (x >> 11) as f64 / (1u64 << 53) as f64 // [0, 1)
}

/// Format a randomized number, matching the vanilla value's int/float style and
/// re-appending its unit suffix.
fn fmt_random(n: f64, is_float: bool, unit: &str) -> String {
    if is_float {
        let mut s = format!("{:.2}", (n * 100.0).round() / 100.0);
        while s.contains('.') && s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
        format!("{s}{unit}")
    } else {
        format!("{}{}", n.round() as i64, unit)
    }
}

/// Randomize every positive gameplay number. `temperature` (0..1) sets the
/// intensity: each value is multiplied by `exp(uniform(-k, +k))` where
/// `k = 0.1 + t*3.4 + t^5*4.0`. The `t^5` term stays near-zero through the low/mid
/// range (so tame..wild feels the same as before) then ramps hard at the very top:
/// temp 0 → ×0.9..1.1, temp 0.5 → ×0.16..6, temp 1 → ×0.0005..1800 (apocalyptic).
/// The exponential keeps the spread symmetric. Non-positive values (0 / -1
/// sentinels) are left alone so we don't break "disabled" flags.
#[tauri::command]
pub fn randomize_config(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    temperature: Option<f64>,
    skip_movement: Option<bool>,
    skip_cast: Option<bool>,
    skip_scale: Option<bool>,
    include_guns: Option<bool>,
    no_negative: Option<bool>,
    randomize_item_tiers: Option<bool>,
    hero_stats: Option<bool>,
    hero_investment: Option<bool>,
    unsorted: Option<bool>,
) -> Result<RandomConfig, String> {
    let t = temperature.unwrap_or(0.5).clamp(0.0, 1.0);
    let k = 0.1 + t * 3.4 + t.powi(5) * 4.0;
    let skip_move = skip_movement.unwrap_or(false);
    let skip_cast = skip_cast.unwrap_or(false);
    let skip_scale = skip_scale.unwrap_or(true);
    let include_guns = include_guns.unwrap_or(false);
    let no_neg = no_negative.unwrap_or(true);
    let rand_tiers = randomize_item_tiers.unwrap_or(false);
    let rand_hero_stats = hero_stats.unwrap_or(false);
    let rand_hero_invest = hero_investment.unwrap_or(false);
    let unsorted = unsorted.unwrap_or(false);
    // Skip a stat by key/field name when the matching category is disabled, so
    // randomize leaves e.g. jump height / cast times alone (they break feel fast).
    let should_skip = |key: &str| -> bool {
        let k = key.to_ascii_lowercase();
        (skip_move
            && (k.contains("jump")
                || k.contains("stamina")
                || k.contains("dash")
                || k.contains("sprint")
                || k.contains("movespeed")
                || k.contains("move_speed")))
            || (skip_cast
                && (k.contains("cast") || k.contains("channel") || k.contains("windup") || k.contains("wind_up")))
    };
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // Seed from the clock (randomize doesn't need to be reproducible).
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x9E3779B97F4A7C15)
        | 1;

    // Base props: skip 0/-1 sentinels (only randomize positive values).
    let roll = |seed: &mut u64, val: &str| -> Option<String> {
        let (num, unit) = split_value_unit(val);
        if num <= 0.0 {
            return None;
        }
        let factor = ((xorshift(seed) * 2.0 - 1.0) * k).exp();
        Some(fmt_random(num * factor, val.contains('.'), &unit))
    };
    // Upgrade bonuses: sign-preserving (negatives like -12 cooldown are real
    // bonuses, not sentinels). Skip exact zero, and — when "no negatives" is on —
    // leave originally-negative bonuses untouched so nothing randomizes negative.
    let roll_signed = |seed: &mut u64, val: &str| -> Option<String> {
        let (num, unit) = split_value_unit(val);
        if num == 0.0 || (no_neg && num < 0.0) {
            return None;
        }
        let factor = ((xorshift(seed) * 2.0 - 1.0) * k).exp();
        Some(fmt_random(num * factor, val.contains('.'), &unit))
    };

    // Abilities + items (every entity in abilities.vdata).
    let abilities = base.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let atext = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;
    let map = parse_abilities(&atext);
    let mut vdata = Vec::new();
    // When tier-shuffle is on, items are handled entirely by the dedicated tier
    // loop below (tier + proportional stat scale), so keep them out of the random
    // roll — otherwise their stats would get rolled and then overwritten.
    let items = parse_items(&atext);
    let item_names: std::collections::HashSet<&str> = if rand_tiers {
        items.iter().filter(|i| !i.disabled).map(|i| i.name.as_str()).collect()
    } else {
        std::collections::HashSet::new()
    };
    for (entity, def) in &map {
        if item_names.contains(entity.as_str()) {
            continue;
        }
        for (prop_key, val) in &def.props {
            if should_skip(prop_key) {
                continue;
            }
            if let Some(value) = roll(&mut seed, val) {
                vdata.push(crate::project::VdataOverride {
                    ability_key: entity.clone(),
                    prop_key: prop_key.clone(),
                    value,
                });
            }
        }
        // T1/T2/T3 upgrade bonuses, addressed by occurrence index.
        for (i, (_, prop, bonus)) in def.upgrades.iter().enumerate() {
            if should_skip(prop) {
                continue;
            }
            if let Some(value) = roll_signed(&mut seed, bonus) {
                vdata.push(crate::project::VdataOverride {
                    ability_key: entity.clone(),
                    prop_key: format!("@upgrade:{i}"),
                    value,
                });
            }
        }
    }

    // Hero guns (m_WeaponInfo of citadel_weapon_* entries) — opt-in.
    if include_guns {
        for (weapon, field, val) in parse_weapon_stats(&atext) {
            if let Some(value) = roll(&mut seed, &val) {
                vdata.push(crate::project::VdataOverride {
                    ability_key: weapon,
                    prop_key: format!("@weapon:{field}"),
                    value,
                });
            }
        }
    }

    // Item tier shuffle (opt-in "gamemode"): give each shop item a random tier
    // (1..4) and scale its stats to match that tier. The game derives shop cost
    // from the tier, so a re-tiered item is re-priced too. Scaling is proportional
    // to the tier's soul value — a T1 item bumped to T4 gets ~12× its stats; one
    // dropped to T1 gets ~1/12×. Stats are NOT rolled here (deterministic scale),
    // so the item lands at coherent tier-appropriate strength, not random noise.
    if rand_tiers {
        // Approx. souls per tier (cost is tier-derived in-game); T5 is a guess but
        // new tiers only ever land in 1..4 (the purchasable shop range).
        const TIER_SOULS: [f64; 6] = [0.0, 500.0, 1250.0, 3000.0, 6200.0, 10000.0];
        // Scale a stat by `factor`. Positive-only for base props (so 0 / -1 "unset"
        // sentinels are left intact); sign-preserving for upgrade bonuses (a -12
        // cooldown bonus scales to a bigger reduction, never flips sign).
        let scale_prop = |val: &str, factor: f64| -> Option<String> {
            let (num, unit) = split_value_unit(val);
            if num <= 0.0 {
                return None;
            }
            Some(fmt_random(num * factor, val.contains('.'), &unit))
        };
        let scale_up = |val: &str, factor: f64| -> Option<String> {
            let (num, unit) = split_value_unit(val);
            if num == 0.0 {
                return None;
            }
            Some(fmt_random(num * factor, val.contains('.'), &unit))
        };
        for it in &items {
            if it.disabled || it.tier < 1 || it.tier > 5 {
                continue;
            }
            let new_tier = (1 + (xorshift(&mut seed) * 4.0) as u32).clamp(1, 4);
            vdata.push(crate::project::VdataOverride {
                ability_key: it.name.clone(),
                prop_key: "@tier".to_string(),
                value: format!("EModTier_{new_tier}"),
            });
            let factor = TIER_SOULS[new_tier as usize] / TIER_SOULS[it.tier.clamp(1, 5) as usize];
            if let Some(def) = map.get(&it.name) {
                for (prop_key, val) in &def.props {
                    if should_skip(prop_key) {
                        continue;
                    }
                    if let Some(value) = scale_prop(val, factor) {
                        vdata.push(crate::project::VdataOverride {
                            ability_key: it.name.clone(),
                            prop_key: prop_key.clone(),
                            value,
                        });
                    }
                }
                for (i, (_, prop, bonus)) in def.upgrades.iter().enumerate() {
                    if should_skip(prop) {
                        continue;
                    }
                    if let Some(value) = scale_up(bonus, factor) {
                        vdata.push(crate::project::VdataOverride {
                            ability_key: it.name.clone(),
                            prop_key: format!("@upgrade:{i}"),
                            value,
                        });
                    }
                }
            }
        }
    }

    // Curated global stats.
    let gd = base.join("generic_data.vdata");
    if !gd.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/generic_data.vdata_c", &gd.to_string_lossy())?;
    }
    let gtext = std::fs::read_to_string(&gd).map_err(|e| e.to_string())?;
    let mut seen = std::collections::HashSet::new();
    let mut global = Vec::new();
    for line in gtext.lines() {
        let t = line.trim();
        if let Some((k, v)) = t.split_once(" = ") {
            if seen.contains(k) {
                continue;
            }
            let raw = v.trim().trim_matches('"');
            let curated = GLOBAL_FIELDS.iter().any(|(key, _, _)| *key == k);
            // Curated keys always roll; with "unsorted" on, every other numeric
            // global rolls too. First occurrence only (apply rewrites first match
            // per key), so mark the key seen either way.
            if curated || (unsorted && looks_numeric(raw)) {
                seen.insert(k.to_string());
                if should_skip(k) {
                    continue;
                }
                if let Some(value) = roll(&mut seed, raw) {
                    global.push(crate::project::GlobalOverride { key: k.to_string(), value });
                }
            }
        }
    }

    // World entities: minions (all of npc_units) + boxes/powerups (filtered misc).
    let mut world = Vec::new();
    let world_files: [(&str, fn(&str) -> bool); 2] = [
        ("scripts/npc_units.vdata", |_| true),
        ("scripts/misc.vdata", |n: &str| {
            n.contains("breakable") || n.contains("powerup") || n.contains("pickup")
        }),
    ];
    for (rel, want) in world_files {
        let stem = rel.rsplit('/').next().unwrap_or(rel);
        let path = base.join(stem);
        if !path.exists() {
            crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &format!("{rel}_c"), &path.to_string_lossy())?;
        }
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        for (entity, fields) in parse_entities(&text) {
            if !want(&entity) {
                continue;
            }
            for (field, val) in fields {
                // Optionally leave model scale on world entities alone — giant/tiny
                // minions, turrets, guardians and bosses break hitboxes + visuals.
                if skip_scale && field.to_ascii_lowercase().contains("scale") {
                    continue;
                }
                if should_skip(&field) {
                    continue;
                }
                if let Some(value) = roll(&mut seed, &val) {
                    world.push(crate::project::WorldOverride {
                        file: rel.to_string(),
                        entity: entity.clone(),
                        field,
                        value,
                    });
                }
            }
        }
    }

    // Hero base stats (m_mapStartingStats) + per-level "investment" scaling
    // (m_mapStandardLevelUpUpgrades) — both opt-in, both in heroes.vdata. Routed
    // through the world-override pipeline with `submap::leaf` field keys.
    if rand_hero_stats || rand_hero_invest {
        let heroes = base.join("heroes.vdata");
        if !heroes.exists() {
            crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/heroes.vdata_c", &heroes.to_string_lossy())?;
        }
        let htext = std::fs::read_to_string(&heroes).map_err(|e| e.to_string())?;
        let mut submaps: Vec<&str> = Vec::new();
        if rand_hero_stats {
            submaps.push("m_mapStartingStats");
        }
        if rand_hero_invest {
            submaps.push("m_mapStandardLevelUpUpgrades");
        }
        for submap in submaps {
            for (hero, leaf, val) in parse_submap_stats(&htext, submap) {
                // hero_base is a template you never play — leave it vanilla.
                if hero == "hero_base" || should_skip(&leaf) {
                    continue;
                }
                if let Some(value) = roll(&mut seed, &val) {
                    world.push(crate::project::WorldOverride {
                        file: "scripts/heroes.vdata".to_string(),
                        entity: hero,
                        field: format!("{submap}::{leaf}"),
                        value,
                    });
                }
            }
        }
    }

    // Catch-all "unsorted": sweep every remaining bare-number field across the
    // world-tree files (minions, boxes/powerups, heroes) that no specific
    // category already owns. Routed through the same per-file world pass — no new
    // compile step, so no decompile/recompile conflict on a shared file. Abilities
    // internals (mostly animation/particle noise, already covered where it matters)
    // are deliberately left for later.
    if unsorted {
        use std::collections::HashSet;
        let mut emitted: HashSet<(String, String)> =
            world.iter().map(|w| (w.entity.clone(), w.field.clone())).collect();
        for rel in ["scripts/npc_units.vdata", "scripts/misc.vdata", "scripts/heroes.vdata"] {
            let stem = rel.rsplit('/').next().unwrap_or(rel);
            let path = base.join(stem);
            if !path.exists() {
                crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &format!("{rel}_c"), &path.to_string_lossy())?;
            }
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let is_heroes = rel.ends_with("heroes.vdata");
            for (entity, field, val) in parse_numeric_tree(&text) {
                if is_heroes {
                    // hero_base is a template; the two stat sub-maps are their own
                    // categories (skip so this only grabs the leftovers).
                    if entity == "hero_base"
                        || field.starts_with("m_mapStartingStats::")
                        || field.starts_with("m_mapStandardLevelUpUpgrades::")
                    {
                        continue;
                    }
                }
                if skip_scale && field.to_ascii_lowercase().contains("scale") {
                    continue;
                }
                if should_skip(&field) {
                    continue;
                }
                let key = (entity.clone(), field.clone());
                if emitted.contains(&key) {
                    continue;
                }
                if let Some(value) = roll(&mut seed, &val) {
                    emitted.insert(key);
                    world.push(crate::project::WorldOverride { file: rel.to_string(), entity, field, value });
                }
            }
        }
    }

    Ok(RandomConfig { vdata, global, world })
}

/// Read one item's editable properties (`m_mapAbilityProperties`) out of the live
/// `abilities.vdata`. Items live in the same file as abilities, so they share the
/// override pipeline — `item_name` is the entity key (e.g. `upgrade_base`).
#[tauri::command]
pub fn item_config(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    item_name: String,
) -> Result<Vec<AbilityProp>, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let abilities = base.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;
    let map = parse_abilities(&text);
    let def = map.get(&item_name).ok_or_else(|| format!("item '{item_name}' not found"))?;
    Ok(ability_props(def))
}

// ---------------------------------------------------------------------------
// World entities (Custom Server): minions (npc_units.vdata) + boxes/powerups
// (misc.vdata). These are flat-scalar entities (m_nMaxHealth = 300, …), not
// the m_mapAbilityProperties shape, so they get their own parse + override path.
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EntityConfig {
    /// Entity key, e.g. `trooper_normal` / `citadel_breakable_prop_drop_gold`.
    pub key: String,
    /// Friendly name.
    pub name: String,
    /// Source file the edit targets, e.g. `scripts/npc_units.vdata`.
    pub file: String,
    /// Editable direct numeric fields.
    pub fields: Vec<AbilityProp>,
}

/// Parse a flat-scalar vdata file into `entity -> direct numeric fields`. Only
/// depth-2 scalar `m_X = <number>` lines (the entity's own fields) are kept;
/// nested sub-objects, vectors and flag strings are skipped so edits are
/// unambiguous (one field name occurs at most once at the entity's top level).
fn parse_entities(vdata: &str) -> std::collections::HashMap<String, Vec<(String, String)>> {
    let mut map = std::collections::HashMap::new();
    let mut cur: Option<String> = None;
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in vdata.lines() {
        let depth = tab_depth(line);
        let t = line.trim();
        let top = line.starts_with('\t') && !line.starts_with("\t\t");
        if top {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    if let Some(name) = cur.take() {
                        map.insert(name, std::mem::take(&mut fields));
                    }
                    cur = Some(k.to_string());
                    continue;
                }
            }
        }
        if cur.is_none() {
            continue;
        }
        if depth == 2 {
            if let Some((k, v)) = t.split_once(" = ") {
                let vv = v.trim().trim_matches('"');
                // single bare number only (skip vectors, flags, enums, objects).
                if k.starts_with("m_") && vv.split_whitespace().count() == 1 && vv.parse::<f64>().is_ok() {
                    fields.push((k.to_string(), vv.to_string()));
                }
            }
        }
    }
    if let Some(name) = cur.take() {
        map.insert(name, fields);
    }
    map
}

/// `m_nMaxHealth` -> "Max Health" (drops `m_` + the hungarian type prefix).
fn prettify_field(key: &str) -> String {
    let k = key.strip_prefix("m_").unwrap_or(key);
    let k = k.trim_start_matches(|c: char| c.is_ascii_lowercase());
    let mut out = String::new();
    for (i, ch) in k.chars().enumerate() {
        if ch.is_ascii_uppercase() && i > 0 && !out.ends_with(' ') {
            out.push(' ');
        }
        out.push(ch);
    }
    out
}

/// `citadel_breakable_prop_drop_gold` -> "Breakable Prop Drop Gold".
fn prettify_entity_name(key: &str) -> String {
    let k = key.strip_prefix("citadel_").unwrap_or(key);
    k.split('_')
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Read editable world entities for one `kind`: "minions" (all of
/// npc_units.vdata), "boxes" (breakable props in misc.vdata) or "powerups"
/// (powerup/pickup entities in misc.vdata).
#[tauri::command]
pub fn world_config(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    kind: String,
) -> Result<Vec<EntityConfig>, String> {
    use tauri::Manager;
    let (rel, want): (&str, fn(&str) -> bool) = match kind.as_str() {
        "minions" => ("scripts/npc_units.vdata", |_| true),
        "boxes" => ("scripts/misc.vdata", |n: &str| n.contains("breakable")),
        "powerups" => ("scripts/misc.vdata", |n: &str| n.contains("powerup") || n.contains("pickup")),
        other => return Err(format!("unknown world kind '{other}'")),
    };
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let stem = rel.rsplit('/').next().unwrap_or(rel);
    let path = base.join(stem);
    if !path.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &format!("{rel}_c"), &path.to_string_lossy())?;
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let map = parse_entities(&text);
    let mut out: Vec<EntityConfig> = map
        .into_iter()
        .filter(|(k, f)| want(k) && !f.is_empty())
        .map(|(key, fields)| EntityConfig {
            name: prettify_entity_name(&key),
            file: rel.to_string(),
            key,
            fields: fields
                .iter()
                .map(|(k, v)| {
                    let (number, unit) = split_value_unit(v);
                    AbilityProp { key: k.clone(), label: prettify_field(k), value: v.clone(), number, unit }
                })
                .collect(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// The set of hero soundevent file stems that actually exist in the pak
/// (e.g. `abrams`, `viper`, `magician`). Cached to a text file so abilities that
/// reference shared/global events (`Player.Barrier.Activate`, `Ability.*`, …)
/// can be filtered out — those don't live in a per-hero file and aren't editable
/// here. Refreshed when the cache is missing.
fn valid_hero_stems(
    helper_path: &str,
    pak_path: &str,
    cache: &std::path::Path,
) -> std::collections::HashSet<String> {
    let text = if cache.exists() {
        std::fs::read_to_string(cache).unwrap_or_default()
    } else {
        let listed = crate::vpk::list(helper_path, pak_path, Some("soundevents/hero/"))
            .unwrap_or_default();
        let joined = listed.join("\n");
        let _ = std::fs::write(cache, &joined);
        joined
    };
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let name = l.rsplit('/').next().unwrap_or(l);
            let stem = name
                .strip_suffix(".vsndevts_c")
                .or_else(|| name.strip_suffix(".vsndevts"))?;
            if stem.starts_with('_') {
                None // skip `_shared.vsndevts`
            } else {
                Some(stem.to_string())
            }
        })
        .collect()
}

/// Event names in a `.vsndevts` text that actually define a `vsnd_files`
/// (scalar or array) — i.e. real, editable sound events. Used to drop stale
/// ability references that name an event the soundevents file no longer defines
/// (e.g. an ability points at `Warden.LockDown.Explode` but the file only has
/// `Warden.LockDown.Hit/Expire/...`).
fn events_with_vsnd(text: &str) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    let mut cur: Option<String> = None;
    for line in text.lines() {
        let top = line.starts_with('\t') && !line.starts_with("\t\t");
        let t = line.trim();
        if top {
            // Event opener: `Name.With.Dots =` (the `{` is on the next line).
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty()
                    && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                {
                    cur = Some(k.to_string());
                    continue;
                }
            }
        }
        if let Some(name) = &cur {
            if t.starts_with("vsnd_files") {
                out.insert(name.clone());
            }
        }
    }
    out
}

/// The set of real (vsnd-bearing) event names in a hero's soundevents file,
/// decompiling + caching it under `dir` on first use.
fn hero_event_set(
    helper: &str,
    pak: &str,
    dir: &std::path::Path,
    stem: &str,
) -> std::collections::HashSet<String> {
    let path = dir.join(format!("{stem}.vsndevts"));
    if !path.exists() {
        let _ = crate::vpk::decompile_from_vpk(
            helper,
            pak,
            &format!("soundevents/hero/{stem}.vsndevts_c"),
            &path.to_string_lossy(),
        );
    }
    std::fs::read_to_string(&path)
        .map(|t| events_with_vsnd(&t))
        .unwrap_or_default()
}

/// `event_name -> hero file stem` for every vsnd-bearing event across all hero
/// soundevents files. Built once (decompiling each file) and cached to
/// `event_index.json`, so an event's file is resolved by where it's actually
/// defined rather than guessed from its name prefix — the prefix often differs
/// from the file (e.g. `MoKrill.*` lives in `krill.vsndevts`, `Calico.*` in
/// `nano.vsndevts`, `Archer.*` in `orion.vsndevts`, many `Ability.*` events in
/// their owner's file). That mismatch was the "beep / no filepath" on those heroes.
fn hero_event_index(
    helper: &str,
    pak: &str,
    base: &std::path::Path,
    hero_stems: &std::collections::HashSet<String>,
) -> std::collections::HashMap<String, String> {
    let cache = base.join("event_index.json");
    if let Ok(t) = std::fs::read_to_string(&cache) {
        if let Ok(m) = serde_json::from_str::<std::collections::HashMap<String, String>>(&t) {
            if !m.is_empty() {
                return m;
            }
        }
    }
    let events_dir = base.join("heroevents");
    let _ = std::fs::create_dir_all(&events_dir);
    let mut idx = std::collections::HashMap::new();
    let mut stems: Vec<&String> = hero_stems.iter().collect();
    stems.sort(); // deterministic winner when an event name appears in two files
    for stem in stems {
        for ev in hero_event_set(helper, pak, &events_dir, stem) {
            idx.entry(ev).or_insert_with(|| stem.clone());
        }
    }
    let _ = std::fs::write(&cache, serde_json::to_string(&idx).unwrap_or_default());
    idx
}

/// A hero's 4 abilities with icons + the distinct sounds each triggers, parsed
/// from `heroes.vdata` + `abilities.vdata`. The result (abilities + icon paths +
/// which sound events exist) is **static** game data, so it's cached per-hero to
/// `detail_<code>.json` — the frontend reads the live sound *pools* separately,
/// so only sounds you actually edit ever change. Pass `refresh: true` to rebuild.
fn hero_detail_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    codename: String,
    refresh: Option<bool>,
) -> Result<Vec<HeroAbility>, String> {
    use tauri::Manager;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    // Serve the cached per-hero detail unless a refresh was requested. The `v6`
    // marker invalidates caches built before ability folding + own-file
    // ownership filtering.
    let detail_cache = base.join(format!("detail_v7_{codename}.json"));
    if !refresh.unwrap_or(false) {
        if let Ok(text) = std::fs::read_to_string(&detail_cache) {
            if let Ok(cached) = serde_json::from_str::<Vec<HeroAbility>>(&text) {
                if !cached.is_empty() {
                    return Ok(cached);
                }
            }
        }
    }

    // Ensure the two data files are cached (decompiled from the pak).
    let heroes = base.join("heroes.vdata");
    if !heroes.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/heroes.vdata_c", &heroes.to_string_lossy())?;
    }
    let abilities = base.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let heroes_text = std::fs::read_to_string(&heroes).map_err(|e| e.to_string())?;
    let abilities_text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;

    let bound = hero_bound_abilities(&heroes_text, &codename);
    if bound.is_empty() {
        return Err(format!("no bound abilities for hero '{codename}'"));
    }
    let ability_map = parse_abilities(&abilities_text);
    let hero_stems = valid_hero_stems(&helper_path, &pak_path, &base.join("hero_sound_files.txt"));
    // event_name -> the file that actually defines it (handles prefix/file name
    // mismatches and drops shared/stale events that no file defines).
    let event_index = hero_event_index(&helper_path, &pak_path, &base, &hero_stems);

    // Decode the ability icons (one batch).
    let icon_dir = base.join("ability_icons").join(&codename);
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;
    let icon_internals: Vec<String> = bound
        .iter()
        .filter_map(|(_, a)| ability_map.get(a).and_then(|d| d.icon_internal.clone()))
        .collect();
    let stem_of = |internal: &str| -> String {
        internal
            .rsplit('/')
            .next()
            .unwrap_or(internal)
            .trim_end_matches(".vtex_c")
            .to_string()
    };
    // Decode any icons not already cached.
    let need: Vec<String> = icon_internals
        .iter()
        .filter(|i| !icon_dir.join(format!("{}.png", stem_of(i))).exists())
        .cloned()
        .collect();
    if !need.is_empty() {
        let _ = crate::vpk::texture_batch(&helper_path, &pak_path, &icon_dir.to_string_lossy(), &need);
    }

    // Pass 1: resolve every ability's vdata sounds to their owning file stem.
    // (Distinct events per ability, first label wins; events no file defines —
    // shared/global or stale refs — are dropped.)
    struct RawSound {
        label: String,
        event: String,
        stem: String,
    }
    let mut raw: Vec<(u32, String, Option<String>, Option<String>, Vec<RawSound>)> = Vec::new();
    let mut stem_freq: std::collections::BTreeMap<String, usize> = Default::default();
    for (slot, ability) in bound {
        let def = ability_map.get(&ability);
        let icon_path = def
            .and_then(|d| d.icon_internal.as_deref())
            .map(|i| icon_dir.join(format!("{}.png", stem_of(i))))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned());
        let icon_target = def.and_then(|d| d.icon_internal.clone());
        let mut seen = std::collections::HashSet::new();
        let mut sounds = Vec::new();
        if let Some(d) = def {
            for (label, event) in &d.sounds {
                let Some(stem) = event_index.get(event) else { continue };
                if seen.insert(event.clone()) {
                    *stem_freq.entry(stem.clone()).or_insert(0) += 1;
                    sounds.push(RawSound {
                        label: label.clone(),
                        event: event.clone(),
                        stem: stem.clone(),
                    });
                }
            }
        }
        raw.push((slot, ability, icon_path, icon_target, sounds));
    }

    // Ownership: the hero's own file(s) = the codename's file plus the stem
    // the MAJORITY of their vdata sounds resolve to (codename and file differ
    // for older heroes). Valve's vdata sometimes borrows ANOTHER hero's events
    // (Drifter's shadow mark plays Synth/Pocket cloak sounds) — those don't
    // belong on this hero's cards and stay editable under their real owner.
    let mut own_stems: std::collections::BTreeSet<String> = Default::default();
    if hero_stems.contains(&codename) {
        own_stems.insert(codename.clone());
    }
    if let Some((s, _)) = stem_freq.iter().max_by_key(|(_, n)| **n) {
        own_stems.insert(s.clone());
    }

    let mut out = Vec::new();
    for (slot, ability, icon_path, icon_target, sounds) in raw {
        let sounds = sounds
            .into_iter()
            .filter(|s| own_stems.contains(&s.stem))
            .map(|s| HeroAbilitySound {
                event_name: s.event,
                array_key: "vsnd_files".to_string(),
                events_relpath: format!("soundevents/hero/{}.vsndevts", s.stem),
                label: s.label,
            })
            .collect();
        out.push(HeroAbility { slot, ability, icon_path, icon_target, sounds });
    }

    // The vdata only references a handful of events per ability (cast, hit
    // confirm…) — the hero's soundevents FILE carries the full set (projectile
    // loops, teleports, impacts…). Fold every remaining event into its ability
    // card. The game encodes the ability slot in three conventions, tried in
    // order per event:
    //   1. ref folder `sounds/abilities/<stem>/a<N>/…` or `…/a<N>_name/…`
    //   2. an `A<N>` segment in the event name (`Abrams.A1.SiphonLife.Cast`)
    //   3. the ability's name as a prefix of the event name (hero prefix and
    //      generic "Ability" segments stripped from both sides first)
    let norm = |s: &str| -> String {
        s.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    let code_n = norm(&codename);
    // Fold ONLY over the hero's own file(s) — scanning a borrowed hero's file
    // would drag foreign events (e.g. Synth.A2.*) onto these cards.
    let stems = own_stems.clone();
    // Per-ability normalized name candidates (full core + core minus its
    // leading dev-name segment), longest first so specific abilities win.
    let mut keys: Vec<(usize, String)> = Vec::new();
    for (i, ha) in out.iter().enumerate() {
        let mut k = ha.ability.to_ascii_lowercase();
        for p in ["citadel_ability_", "ability_"] {
            if let Some(s) = k.strip_prefix(p) {
                k = s.to_string();
            }
        }
        let full = norm(&k);
        if full.len() >= 4 {
            keys.push((i, full.clone()));
        }
        if let Some(stripped) = full.strip_prefix(code_n.as_str()) {
            if stripped.len() >= 4 {
                keys.push((i, stripped.to_string()));
            }
        }
        // Drop the first underscore segment (usually the hero's dev name,
        // which may differ from the codename: `ability_bull_charge` → charge).
        if let Some((_, rest)) = k.split_once('_') {
            let r = norm(rest);
            if r.len() >= 4 {
                keys.push((i, r));
            }
        }
    }
    keys.sort_by_key(|(_, k)| std::cmp::Reverse(k.len()));
    // Event-name FAMILIES from the vdata-known events: an ability whose cast
    // sound is `Necro.Skull.Cast` owns every other `Necro.Skull.*` event —
    // this bridges vocabulary gaps the name heuristic can't (gravestone ↔
    // Gravedigging). Requires ≥2 segments so a bare hero prefix never claims.
    let mut fams: Vec<(usize, String)> = Vec::new();
    for (i, ha) in out.iter().enumerate() {
        for s in &ha.sounds {
            if let Some(pos) = s.event_name.rfind('.') {
                let fam = &s.event_name[..pos];
                if fam.contains('.') && !fams.iter().any(|(fi, f)| *fi == i && f == fam) {
                    fams.push((i, fam.to_string()));
                }
            }
        }
    }
    fams.sort_by_key(|(_, f)| std::cmp::Reverse(f.len()));
    let mut claimed: std::collections::HashSet<String> = out
        .iter()
        .flat_map(|a| a.sounds.iter().map(|s| s.event_name.clone()))
        .collect();
    let snd_dir = base.join("heroevents");
    let _ = std::fs::create_dir_all(&snd_dir);
    for stem in &stems {
        let snd_file = snd_dir.join(format!("{stem}.vsndevts"));
        if !snd_file.exists() {
            let _ = crate::vpk::decompile_from_vpk(
                &helper_path,
                &pak_path,
                &format!("soundevents/hero/{stem}.vsndevts_c"),
                &snd_file.to_string_lossy(),
            );
        }
        let Ok(text) = std::fs::read_to_string(&snd_file) else { continue };
        let Ok(arrays) = kv3_core::list_arrays(&text) else { continue };
        let relpath = format!("soundevents/hero/{stem}.vsndevts");
        let slot_prefix = format!("sounds/abilities/{stem}/a");
        for a in arrays {
            if a.array_key != "vsnd_files" || claimed.contains(&a.event_name) {
                continue;
            }
            // Signal 1: any entry under the hero's aN / aN_name ability folder.
            let mut target: Option<usize> = None;
            for r in &a.entries {
                if let Some(rest) = r.strip_prefix(&slot_prefix) {
                    let mut ch = rest.chars();
                    if let (Some(n), Some(sep)) = (
                        ch.next().and_then(|c| c.to_digit(10)),
                        ch.next(),
                    ) {
                        if sep == '/' || sep == '_' {
                            target = out.iter().position(|ha| ha.slot == n);
                            if target.is_some() {
                                break;
                            }
                        }
                    }
                }
            }
            // Signal 2: an `A<N>` dot-segment in the event name.
            let segments: Vec<&str> = a.event_name.split('.').collect();
            if target.is_none() {
                for seg in &segments {
                    let s = seg.to_ascii_lowercase();
                    if s.len() == 2 && s.starts_with('a') {
                        if let Some(n) = s[1..].chars().next().and_then(|c| c.to_digit(10)) {
                            target = out.iter().position(|ha| ha.slot == n);
                            if target.is_some() {
                                break;
                            }
                        }
                    }
                }
            }
            // Signal 3: the event belongs to a family established by one of
            // the ability's vdata-known events.
            if target.is_none() {
                for (i, fam) in &fams {
                    if a.event_name.len() > fam.len()
                        && a.event_name.starts_with(fam.as_str())
                        && a.event_name.as_bytes()[fam.len()] == b'.'
                    {
                        target = Some(*i);
                        break;
                    }
                }
            }
            // Signal 4: an ability name prefixes the event (hero dev-name
            // first segment + generic "Ability" segments dropped).
            if target.is_none() && segments.len() >= 2 {
                let mut idx = 1; // segment 0 is the hero/dev name
                while idx < segments.len() && segments[idx].eq_ignore_ascii_case("ability") {
                    idx += 1;
                }
                let ev_core = norm(&segments[idx..].join(""));
                for (i, core) in &keys {
                    if ev_core.starts_with(core.as_str()) {
                        target = Some(*i);
                        break;
                    }
                }
            }
            let Some(i) = target else { continue };
            claimed.insert(a.event_name.clone());
            out[i].sounds.push(HeroAbilitySound {
                label: prettify_hero_sound(&a.event_name, &codename),
                event_name: a.event_name,
                array_key: "vsnd_files".to_string(),
                events_relpath: relpath.clone(),
            });
        }
    }

    // Cache the static detail for instant subsequent opens.
    if let Ok(json) = serde_json::to_string(&out) {
        let _ = std::fs::write(&detail_cache, json);
    }
    Ok(out)
}

// ---- Hero voicelines -------------------------------------------------------
// Each hero has a big `soundevents/vo/generated_vo_hero_<code>.vsndevts` (often
// 1000+ single-clip events). The Voicelines view lists them compactly; editor
// slots are only materialized for the few a user actually changes.

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLine {
    pub event_name: String,
    pub array_key: String,
    pub events_relpath: String,
    pub label: String,
    /// The first stock clip reference (for preview), if any.
    pub stock_ref: Option<String>,
}

/// `atlas_ally_astro_bounce_pad_01_hero_3d` -> "Ally Astro Bounce Pad 01".
fn prettify_voiceline(event: &str, code: &str) -> String {
    let mut s = event.strip_prefix(&format!("{code}_")).unwrap_or(event);
    for suf in ["_hero_3d", "_hero_2d", "_world_3d", "_3d", "_2d"] {
        if let Some(t) = s.strip_suffix(suf) {
            s = t;
            break;
        }
    }
    s.split('_')
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse a VO `.vsndevts` into `(event, first vsnd ref)` pairs.
fn parse_vo_events(text: &str) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    let mut cur: Option<String> = None;
    let mut cur_ref: Option<String> = None;
    let mut in_vsnd = false;
    for line in text.lines() {
        let top = line.starts_with('\t') && !line.starts_with("\t\t");
        let t = line.trim();
        if top {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty()
                    && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.')
                {
                    if let Some(name) = cur.take() {
                        out.push((name, cur_ref.take()));
                    }
                    cur = Some(k.to_string());
                    cur_ref = None;
                    in_vsnd = false;
                    continue;
                }
            }
        }
        if cur.is_none() {
            continue;
        }
        if t.starts_with("vsnd_files") {
            in_vsnd = true;
        }
        if in_vsnd && cur_ref.is_none() {
            if let Some(r) = between(t, "\"", ".vsnd\"") {
                cur_ref = Some(format!("{r}.vsnd"));
            }
        }
    }
    if let Some(name) = cur.take() {
        out.push((name, cur_ref.take()));
    }
    out
}

/// A hero's voicelines (from `soundevents/vo/generated_vo_hero_<code>.vsndevts`).
/// Cached per hero. Returns an empty list if the hero has no VO file.
fn hero_voicelines_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    codename: String,
    refresh: Option<bool>,
) -> Result<Vec<VoiceLine>, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let cache = base.join(format!("vo_{codename}.json"));
    if !refresh.unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&cache) {
            if let Ok(v) = serde_json::from_str::<Vec<VoiceLine>>(&t) {
                return Ok(v);
            }
        }
    }

    let relpath = format!("soundevents/vo/generated_vo_hero_{codename}.vsndevts");
    let vo_dir = base.join("voevents");
    std::fs::create_dir_all(&vo_dir).map_err(|e| e.to_string())?;
    let vo_file = vo_dir.join(format!("{codename}.vsndevts"));
    if refresh.unwrap_or(false) || !vo_file.exists() {
        // Missing file = hero has no VO; return empty rather than erroring.
        if crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &format!("{relpath}_c"), &vo_file.to_string_lossy()).is_err() {
            let _ = std::fs::write(&cache, "[]");
            return Ok(vec![]);
        }
    }
    let text = std::fs::read_to_string(&vo_file).map_err(|e| e.to_string())?;
    let lines: Vec<VoiceLine> = parse_vo_events(&text)
        .into_iter()
        .filter(|(_, r)| r.is_some())
        .map(|(event, stock_ref)| VoiceLine {
            label: prettify_voiceline(&event, &codename),
            event_name: event,
            array_key: "vsnd_files".to_string(),
            events_relpath: relpath.clone(),
            stock_ref,
        })
        .collect();
    if let Ok(json) = serde_json::to_string(&lines) {
        let _ = std::fs::write(&cache, json);
    }
    Ok(lines)
}

/// One non-VO hero sound event (gunfire, ability, movement…) from
/// `soundevents/hero/<code>.vsndevts`, tagged with a coarse `category` so the UI
/// can group it. Shaped like `VoiceLine` (+ `category`) so it reuses the exact
/// same lazy slot-materialization path on the frontend.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeroSound {
    pub event_name: String,
    pub array_key: String,
    pub events_relpath: String,
    pub label: String,
    /// The first stock clip reference (for preview), if any.
    pub stock_ref: Option<String>,
    /// "gunfire" | "abilities" | "movement" | "other".
    pub category: String,
}

/// Coarse bucket for a hero sound event, by name convention. Order matters:
/// weapon first, then abilities, then movement/melee, else "other".
fn hero_sound_category(event: &str) -> &'static str {
    let segs: Vec<&str> = event.split('.').collect();
    let has = |names: &[&str]| {
        segs.iter()
            .any(|s| names.iter().any(|n| s.eq_ignore_ascii_case(n)))
    };
    // Weapon / bullet: Abrams.Wpn.Fire.Main, *.Whizby, *.Reload.*
    if has(&["Wpn", "Weapon", "Gun", "Bullet", "Whizby", "Reload"]) {
        return "gunfire";
    }
    // Abilities: `Ability.*`, an `A1`..`A4` segment, or common ability verbs.
    let has_slot_seg = segs.iter().any(|s| {
        let b = s.as_bytes();
        b.len() == 2 && b[0] == b'A' && b[1].is_ascii_digit()
    });
    if event.starts_with("Ability.") || has_slot_seg || has(&["Charge", "Leap", "Cast", "Ultimate"]) {
        return "abilities";
    }
    // Movement & melee foley.
    if has(&[
        "Footstep", "Footsteps", "Movement", "Jump", "JumpLand", "Land", "Mantle", "Melee", "Slide",
        "Dash", "Sprint", "Step", "Zipline", "Roll",
    ]) {
        return "movement";
    }
    "other"
}

/// `Abrams.Wpn.Fire.Main` -> "Wpn Fire Main" (drop a leading hero-code or
/// `Ability` segment; the full event name stays available as a tooltip).
fn prettify_hero_sound(event: &str, code: &str) -> String {
    let mut parts: Vec<&str> = event.split('.').collect();
    while let Some(first) = parts.first() {
        if first.eq_ignore_ascii_case(code) || first.eq_ignore_ascii_case("Ability") {
            parts.remove(0);
        } else {
            break;
        }
    }
    if parts.is_empty() {
        return event.to_string();
    }
    parts.join(" ")
}

/// A hero's non-VO sound events (gunfire, abilities, movement) from
/// `soundevents/hero/<code>.vsndevts`. Cached per hero. Empty if no file.
fn hero_sounds_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    codename: String,
    refresh: Option<bool>,
) -> Result<Vec<HeroSound>, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let cache = base.join(format!("herosnd_{codename}.json"));
    if !refresh.unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&cache) {
            if let Ok(v) = serde_json::from_str::<Vec<HeroSound>>(&t) {
                return Ok(v);
            }
        }
    }

    let relpath = format!("soundevents/hero/{codename}.vsndevts");
    let snd_dir = base.join("heroevents");
    std::fs::create_dir_all(&snd_dir).map_err(|e| e.to_string())?;
    let snd_file = snd_dir.join(format!("{codename}.vsndevts"));
    if refresh.unwrap_or(false) || !snd_file.exists() {
        if crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &format!("{relpath}_c"), &snd_file.to_string_lossy()).is_err() {
            let _ = std::fs::write(&cache, "[]");
            return Ok(vec![]);
        }
    }
    let text = std::fs::read_to_string(&snd_file).map_err(|e| e.to_string())?;
    let sounds: Vec<HeroSound> = parse_vo_events(&text)
        .into_iter()
        .filter(|(_, r)| r.is_some())
        .map(|(event, stock_ref)| HeroSound {
            label: prettify_hero_sound(&event, &codename),
            category: hero_sound_category(&event).to_string(),
            event_name: event,
            array_key: "vsnd_files".to_string(),
            events_relpath: relpath.clone(),
            stock_ref,
        })
        .collect();
    if let Ok(json) = serde_json::to_string(&sounds) {
        let _ = std::fs::write(&cache, json);
    }
    Ok(sounds)
}

/// Open a game particle in an external viewer (VRF's Source2Viewer). Extracts
/// the compiled `.vpcf_c` from the pak to a temp file and launches `viewer_path`
/// on it. The viewer renders the real particle simulation (separate window).
#[tauri::command]
pub fn open_in_viewer(
    app: tauri::AppHandle,
    viewer_path: String,
    helper_path: String,
    pak_path: String,
    particle_path: String,
) -> Result<(), String> {
    use tauri::Manager;
    if viewer_path.trim().is_empty() {
        return Err("No Source2Viewer path configured".into());
    }
    // Tolerate a folder path: resolve it to the Source2Viewer.exe inside.
    let mut viewer = std::path::PathBuf::from(viewer_path.trim());
    if viewer.is_dir() {
        let candidate = viewer.join("Source2Viewer.exe");
        if candidate.is_file() {
            viewer = candidate;
        } else {
            return Err(format!(
                "'{}' is a folder with no Source2Viewer.exe - point this at the .exe in Setup",
                viewer.display()
            ));
        }
    }
    if !viewer.is_file() {
        return Err(format!("Source2Viewer.exe not found at {}", viewer.display()));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("viewer");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = particle_path.trim_end_matches(".vpcf").replace(['/', '\\'], "_");
    let out = dir.join(format!("{stem}.vpcf_c"));
    // Extract the compiled resource straight from the pak (no decompile).
    crate::vpk::extract(&helper_path, &pak_path, &format!("{particle_path}_c"), &out.to_string_lossy())
        .map_err(|e| format!("extract particle: {e}"))?;
    std::process::Command::new(&viewer)
        .arg(&out)
        .spawn()
        .map_err(|e| format!("launch viewer: {e}"))?;
    Ok(())
}

/// Particle effects belonging to an item, by name convention. Item effects live
/// under `particles/upgrades/<item_name>_*` (e.g. Cursed Relic = `upgrade_glitch`
/// → `particles/upgrades/upgrade_glitch_*`); some also reuse `particles/abilities`.
#[tauri::command]
pub fn item_particles(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    item_name: String,
) -> Result<Vec<String>, String> {
    let index = game_particle_index(&app, &helper_path, &pak_path, false)?;
    let name = item_name.to_lowercase();
    let stripped = name.strip_prefix("upgrade_").unwrap_or(&name);
    let mut out: Vec<String> = index
        .into_iter()
        .filter(|p| {
            let pl = p.to_lowercase();
            pl.contains(&name)
                || (pl.starts_with("particles/upgrades/") && !stripped.is_empty() && pl.contains(stripped))
        })
        .collect();
    out.sort();
    out.dedup();
    Ok(out)
}

// ---- Items (shop) ----------------------------------------------------------
// Items are abilities too (in abilities.vdata) with `m_strShopIconLarge`. The
// Items tab recreates the shop: grouped by category (slot type) and tier, each
// item drilling into its sound events for editing — same model as heroes.

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemCard {
    /// Entity name (e.g. `upgrade_clip_size`) — also the slot-id seed + loc key.
    pub name: String,
    pub display_name: String,
    /// `weapon` | `vitality` | `spirit` | `other` (from `m_eItemSlotType`).
    pub category: String,
    /// 1..5 (from `m_iItemTier` `EModTier_N`); 0 if unknown.
    pub tier: u32,
    pub icon_path: Option<String>,
    /// The compiled `.vtex_c` path the game references — the override target for
    /// a custom icon, e.g. `panorama/images/items/weapon/alchemical_fire_psd.vtex_c`.
    pub icon_internal: Option<String>,
}

struct ItemDef {
    name: String,
    category: String,
    tier: u32,
    icon_internal: Option<String>,
    disabled: bool,
    /// (label, event) sound fields in declaration order.
    sounds: Vec<(String, String)>,
}

fn item_category(slot_type: &str) -> &'static str {
    match slot_type {
        "EItemSlotType_WeaponMod" => "weapon",
        "EItemSlotType_Armor" => "vitality",
        "EItemSlotType_Tech" => "spirit",
        _ => "other",
    }
}

/// Parse every shop item (block with `m_strShopIconLarge`) out of abilities.vdata
/// in one pass: category, tier, icon, disabled flag, and sound events.
fn parse_items(vdata: &str) -> Vec<ItemDef> {
    let mut out: Vec<ItemDef> = Vec::new();
    let mut cur: Option<ItemDef> = None;
    let mut has_icon = false;
    for line in vdata.lines() {
        let top_level = line.starts_with('\t') && !line.starts_with("\t\t");
        let t = line.trim();
        if top_level {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    // Flush the previous block if it was a real shop item.
                    if let Some(def) = cur.take() {
                        if has_icon {
                            out.push(def);
                        }
                    }
                    cur = Some(ItemDef {
                        name: k.to_string(),
                        category: "other".to_string(),
                        tier: 0,
                        icon_internal: None,
                        disabled: false,
                        sounds: vec![],
                    });
                    has_icon = false;
                    continue;
                }
            }
        }
        let Some(def) = cur.as_mut() else { continue };
        if t.starts_with("m_eItemSlotType") {
            if let Some(v) = between(t, "\"", "\"").or_else(|| t.rsplit('=').next().map(str::trim)) {
                def.category = item_category(v.trim()).to_string();
            }
        } else if t.starts_with("m_iItemTier") {
            if let Some(v) = t.rsplit("EModTier_").next() {
                def.tier = v.trim().trim_matches('"').parse().unwrap_or(0);
            }
        } else if t.starts_with("m_bDisabled ") || t == "m_bDisabled = true" {
            if t.contains("true") {
                def.disabled = true;
            }
        } else if t.starts_with("m_strShopIconLarge") {
            has_icon = true;
            if let Some(p) = between(t, "{images}/", ".psd") {
                def.icon_internal = Some(format!("panorama/images/{p}_psd.vtex_c"));
            }
        } else if def.icon_internal.is_none() && t.starts_with("m_strAbilityImage") {
            if let Some(p) = between(t, "{images}/", ".psd") {
                def.icon_internal = Some(format!("panorama/images/{p}_psd.vtex_c"));
            }
        } else if let Some(ev) = between(t, "soundevent:\"", "\"") {
            if !ev.is_empty() {
                let key = t.split('=').next().unwrap_or("");
                def.sounds.push((clean_sound_label(key), ev.to_string()));
            }
        }
    }
    if let Some(def) = cur.take() {
        if has_icon {
            out.push(def);
        }
    }
    out
}

/// Load item display names from the game's loose localization file (UTF-16),
/// derived from the pak path: `<game/citadel>/resource/localization/
/// citadel_gc_mod_names/citadel_gc_mod_names_english.txt`. Maps entity name -> name.
fn load_mod_names(pak_path: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let citadel = match std::path::Path::new(pak_path).parent() {
        Some(p) => p,
        None => return map,
    };
    let loc = citadel
        .join("resource/localization/citadel_gc_mod_names/citadel_gc_mod_names_english.txt");
    let bytes = match std::fs::read(&loc) {
        Ok(b) => b,
        Err(_) => return map,
    };
    let text = if bytes.starts_with(&[0xFF, 0xFE]) {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    for line in text.lines() {
        // `"key"   "Value"` — grab the first two quoted tokens.
        let mut it = line.split('"').skip(1).step_by(2);
        if let (Some(k), Some(v)) = (it.next(), it.next()) {
            if k.is_empty() || k.ends_with("_search") || k == "Language" {
                continue;
            }
            map.entry(k.to_string()).or_insert_with(|| v.to_string());
        }
    }
    map
}

/// `Title Case` from an entity name, dropping a leading `upgrade_`.
fn prettify_item(name: &str) -> String {
    let n = name.strip_prefix("upgrade_").unwrap_or(name);
    n.split('_')
        .filter(|s| !s.is_empty())
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().chain(c).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `event_name -> soundevents/mods/<cat>.vsndevts` across the three item sound
/// files, decompiled + cached once (mirrors `hero_event_index`).
fn mods_event_index(
    helper: &str,
    pak: &str,
    base: &std::path::Path,
) -> std::collections::HashMap<String, String> {
    let cache = base.join("mods_event_index.json");
    if let Ok(t) = std::fs::read_to_string(&cache) {
        if let Ok(m) = serde_json::from_str::<std::collections::HashMap<String, String>>(&t) {
            if !m.is_empty() {
                return m;
            }
        }
    }
    let dir = base.join("modevents");
    let _ = std::fs::create_dir_all(&dir);
    let mut idx = std::collections::HashMap::new();
    for stem in ["weapon", "armor", "tech"] {
        let path = dir.join(format!("{stem}.vsndevts"));
        if !path.exists() {
            let _ = crate::vpk::decompile_from_vpk(
                helper,
                pak,
                &format!("soundevents/mods/{stem}.vsndevts_c"),
                &path.to_string_lossy(),
            );
        }
        if let Ok(t) = std::fs::read_to_string(&path) {
            let relpath = format!("soundevents/mods/{stem}.vsndevts");
            for ev in events_with_vsnd(&t) {
                idx.entry(ev).or_insert_with(|| relpath.clone());
            }
        }
    }
    let _ = std::fs::write(&cache, serde_json::to_string(&idx).unwrap_or_default());
    idx
}

/// The shop item roster: every enabled shop item with category, tier, decoded
/// icon, and display name. Cached to `items/roster.json`; `refresh` rebuilds.
fn item_roster_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    refresh: Option<bool>,
) -> Result<Vec<ItemCard>, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("items");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let refresh = refresh.unwrap_or(false);

    // `_v2` adds iconInternal (override target) — invalidate pre-field caches.
    let roster_cache = base.join("roster_v2.json");
    if refresh {
        let _ = std::fs::remove_file(&roster_cache);
        let _ = std::fs::remove_file(base.join("mods_event_index.json"));
        let _ = std::fs::remove_dir_all(base.join("modevents"));
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() {
                if e.file_name().to_string_lossy().starts_with("detail_") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    } else if let Ok(t) = std::fs::read_to_string(&roster_cache) {
        if let Ok(cards) = serde_json::from_str::<Vec<ItemCard>>(&t) {
            if !cards.is_empty() {
                return Ok(cards);
            }
        }
    }

    // abilities.vdata is cached under hero_portraits (shared with hero detail).
    let hp = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    std::fs::create_dir_all(&hp).map_err(|e| e.to_string())?;
    let abilities = hp.join("abilities.vdata");
    if refresh || !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;
    let names = load_mod_names(&pak_path);

    let defs: Vec<ItemDef> = parse_items(&text)
        .into_iter()
        .filter(|d| {
            !d.disabled
                && d.icon_internal.is_some()
                && !d.name.starts_with("item_projectile_test")
                && !d.name.ends_with("_base")
                && !d.name.starts_with("cosmetic_")
        })
        .collect();

    // Decode icons (one batch of those not already cached).
    let icon_dir = base.join("icons");
    std::fs::create_dir_all(&icon_dir).map_err(|e| e.to_string())?;
    let stem_of = |internal: &str| -> String {
        internal.rsplit('/').next().unwrap_or(internal).trim_end_matches(".vtex_c").to_string()
    };
    let need: Vec<String> = defs
        .iter()
        .filter_map(|d| d.icon_internal.clone())
        .filter(|i| !icon_dir.join(format!("{}.png", stem_of(i))).exists())
        .collect();
    if !need.is_empty() {
        let _ = crate::vpk::texture_batch(&helper_path, &pak_path, &icon_dir.to_string_lossy(), &need);
    }

    let mut cards: Vec<ItemCard> = defs
        .iter()
        .map(|d| {
            let icon_path = d
                .icon_internal
                .as_deref()
                .map(|i| icon_dir.join(format!("{}.png", stem_of(i))))
                .filter(|p| p.exists())
                .map(|p| p.to_string_lossy().into_owned());
            ItemCard {
                name: d.name.clone(),
                display_name: names.get(&d.name).cloned().unwrap_or_else(|| prettify_item(&d.name)),
                category: d.category.clone(),
                tier: d.tier,
                icon_path,
                icon_internal: d.icon_internal.clone(),
            }
        })
        .collect();
    cards.sort_by(|a, b| {
        a.category.cmp(&b.category).then(a.tier.cmp(&b.tier)).then(a.display_name.cmp(&b.display_name))
    });

    if let Ok(json) = serde_json::to_string(&cards) {
        let _ = std::fs::write(&roster_cache, json);
    }
    Ok(cards)
}

/// One item's editable sound events (resolved to their `soundevents/mods/*` file
/// via the index; shared/stale events dropped). Cached per item.
fn item_detail_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    item_name: String,
    refresh: Option<bool>,
) -> Result<Vec<HeroAbilitySound>, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("items");
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;

    let detail_cache = base.join(format!("detail_{item_name}.json"));
    if !refresh.unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&detail_cache) {
            if let Ok(cached) = serde_json::from_str::<Vec<HeroAbilitySound>>(&t) {
                return Ok(cached);
            }
        }
    }

    let hp = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    let abilities = hp.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, "scripts/abilities.vdata_c", &abilities.to_string_lossy())?;
    }
    let text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;
    let index = mods_event_index(&helper_path, &pak_path, &base);

    let def = parse_items(&text).into_iter().find(|d| d.name == item_name);
    let mut sounds = Vec::new();
    if let Some(d) = def {
        let mut seen = std::collections::HashSet::new();
        for (label, event) in &d.sounds {
            let relpath = match index.get(event) {
                Some(r) => r,
                None => continue,
            };
            if seen.insert(event.clone()) {
                sounds.push(HeroAbilitySound {
                    event_name: event.clone(),
                    array_key: "vsnd_files".to_string(),
                    events_relpath: relpath.clone(),
                    label: label.clone(),
                });
            }
        }
    }
    if let Ok(json) = serde_json::to_string(&sounds) {
        let _ = std::fs::write(&detail_cache, json);
    }
    Ok(sounds)
}

/// One shop item's reference to a sound event (from abilities.vdata).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSoundRef {
    pub item_name: String,
    pub event_name: String,
    pub label: String,
}

/// Flat index of every enabled shop item's sound events, so the importer can
/// route an imported `mods/*` sound event to the item(s) that use it.
fn item_sound_index_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
) -> Result<Vec<ItemSoundRef>, String> {
    use tauri::Manager;
    let hp = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits");
    std::fs::create_dir_all(&hp).map_err(|e| e.to_string())?;
    let abilities = hp.join("abilities.vdata");
    if !abilities.exists() {
        crate::vpk::decompile_from_vpk(
            &helper_path,
            &pak_path,
            "scripts/abilities.vdata_c",
            &abilities.to_string_lossy(),
        )?;
    }
    let text = std::fs::read_to_string(&abilities).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for d in parse_items(&text) {
        if d.disabled {
            continue;
        }
        for (label, event) in d.sounds {
            out.push(ItemSoundRef {
                item_name: d.name.clone(),
                event_name: event,
                label,
            });
        }
    }
    Ok(out)
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
        // A missing/unreadable events file yields `None` for that slot only — one
        // absent file (e.g. a hero events file not present in a refresh) must not
        // fail the whole load.
        if !cache.contains_key(&slot.events_path) {
            if let Ok(t) = std::fs::read_to_string(&slot.events_path) {
                cache.insert(slot.events_path.clone(), t);
            }
        }
        let key = slot.array_key.as_deref().unwrap_or("vsnd_files");
        let view = cache
            .get(&slot.events_path)
            .and_then(|text| kv3_core::read_event_array(text, &slot.event_name, key).ok());
        out.push(view);
    }
    Ok(out)
}

/// A moddable sound event discovered in the live (refreshed) soundevents tree.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredEvent {
    pub events_relpath: String,
    pub event_name: String,
    pub array_key: String,
    pub stock_entry: String,
}

/// Enumerate every primary-`vsnd_files` event across the given soundevents files
/// (read from the app's refreshed `vanilla_root`). Secondary arrays
/// (`vsnd_files_opponent_control`, `vsnd_files_distance_xfade`, …) are skipped so
/// discovery yields one slot per event. Missing files are silently skipped — one
/// absent file must not fail the sweep. Drives auto-discovery of events a new
/// patch added (the frontend diffs this against a stored baseline).
#[tauri::command]
pub fn list_editable_events(
    vanilla_root: String,
    relpaths: Vec<String>,
) -> Result<Vec<DiscoveredEvent>, String> {
    let root = std::path::Path::new(&vanilla_root);
    let mut out = Vec::new();
    for rel in &relpaths {
        let rel_trim = rel.trim_matches('/');
        let path = root.join(rel_trim);
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if let Ok(arrays) = kv3_core::list_arrays(&text) {
            for a in arrays {
                if a.array_key != "vsnd_files" {
                    continue;
                }
                out.push(DiscoveredEvent {
                    events_relpath: rel.clone(),
                    event_name: a.event_name,
                    array_key: a.array_key,
                    stock_entry: a.entries.into_iter().next().unwrap_or_default(),
                });
            }
        }
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

/// Path of the persisted user settings in the OS app-data dir. Settings are
/// machine-specific (tool/game paths) so they live here, not in a shareable
/// project file — durable across restarts and localStorage clears.
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

/// Persist the settings blob (shape is owned by the frontend) to app-data.
#[tauri::command]
pub fn save_settings(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(settings_path(&app)?, text).map_err(|e| e.to_string())
}

/// Load the persisted settings blob, or None if none saved yet.
#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = settings_path(&app)?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let v = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(Some(v))
    } else {
        Ok(None)
    }
}

// ---- Profiles --------------------------------------------------------------
// A profile is a named, self-contained build config (the project + imported
// mods) stored as one JSON file under app-data/profiles. Machine paths stay in
// settings.json (global), so switching profiles never disturbs setup.

fn profiles_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("profiles");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A profile name reduced to a safe file stem (no path separators or chars
/// Windows forbids). The sanitized form is the profile's canonical identity.
fn sanitize_profile(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() { "profile".to_string() } else { cleaned.to_string() }
}

fn profile_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(profiles_dir(app)?.join(format!("{}.json", sanitize_profile(name))))
}

/// List saved profile names (sorted), e.g. `["Superpack", "Vanilla"]`.
#[tauri::command]
pub fn list_profiles(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(profiles_dir(&app)?) {
        for e in rd.flatten() {
            let name = e.file_name();
            let name = name.to_string_lossy();
            if let Some(stem) = name.strip_suffix(".json") {
                out.push(stem.to_string());
            }
        }
    }
    out.sort_by_key(|s| s.to_lowercase());
    Ok(out)
}

/// Save a profile's blob (frontend-owned shape: `{ project, importedMods }`).
#[tauri::command]
pub fn save_profile(
    app: tauri::AppHandle,
    name: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(profile_path(&app, &name)?, text).map_err(|e| e.to_string())
}

/// Load a profile's blob, or None if it doesn't exist.
#[tauri::command]
pub fn load_profile(
    app: tauri::AppHandle,
    name: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = profile_path(&app, &name)?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let v = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        Ok(Some(v))
    } else {
        Ok(None)
    }
}

/// Delete a profile.
#[tauri::command]
pub fn delete_profile(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = profile_path(&app, &name)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Rename a profile (overwrites any existing profile at the new name).
#[tauri::command]
pub fn rename_profile(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    let src = profile_path(&app, &from)?;
    let dst = profile_path(&app, &to)?;
    if src == dst {
        return Ok(());
    }
    if !src.exists() {
        return Err(format!("profile '{from}' not found"));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())
}

// ---- Loose-file sound browser ---------------------------------------------
// The game pak has ~79k `sounds/**.vsnd_c`. We cache the full path index once,
// then serve it as a lazy folder tree (immediate subfolders + files) or a
// recursive search under a prefix — so the UI never loads the whole list.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFolder {
    pub name: String,
    /// Full prefix to drill into (e.g. `sounds/vo/atlas`).
    pub prefix: String,
    /// Number of sound files anywhere under this folder.
    pub count: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundFile {
    /// The `.vsnd` reference (override target), e.g. `sounds/vo/atlas/x.vsnd`.
    pub reference: String,
    /// Friendly label (the file stem).
    pub label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundBrowse {
    pub folders: Vec<SoundFolder>,
    pub files: Vec<SoundFile>,
    /// True when the result was capped (refine with search).
    pub truncated: bool,
    /// Total sound files in the index (for display).
    pub total: usize,
}

/// Build (and cache) the index of every `sounds/**.vsnd_c` path in the pak.
fn game_sound_index(
    app: &tauri::AppHandle,
    helper_path: &str,
    pak_path: &str,
    refresh: bool,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cache = dir.join("game_sounds.txt");
    if !refresh {
        if let Ok(t) = std::fs::read_to_string(&cache) {
            if !t.trim().is_empty() {
                return Ok(t.lines().map(|s| s.to_string()).collect());
            }
        }
    }
    // List + keep only sound references, stored as `.vsnd` (strip the `_c`).
    let mut refs: Vec<String> = crate::vpk::list(helper_path, pak_path, Some("sounds/"))?
        .into_iter()
        .filter(|p| p.ends_with(".vsnd_c"))
        .map(|p| p.trim_end_matches("_c").to_string())
        .collect();
    refs.sort();
    refs.dedup();
    let _ = std::fs::write(&cache, refs.join("\n"));
    Ok(refs)
}

/// Browse the game's sound tree under `prefix` (lazy). With `query`, returns a
/// flat recursive search (capped); without, returns immediate subfolders + the
/// files directly at this level.
fn browse_game_sounds_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    prefix: String,
    query: Option<String>,
    refresh: Option<bool>,
) -> Result<SoundBrowse, String> {
    const CAP: usize = 500;
    let index = game_sound_index(&app, &helper_path, &pak_path, refresh.unwrap_or(false))?;
    let total = index.len();
    let pre = prefix.trim_matches('/');
    let pre_slash = if pre.is_empty() { String::new() } else { format!("{pre}/") };

    let q = query.unwrap_or_default().trim().to_lowercase();
    if !q.is_empty() {
        // Recursive search under the prefix.
        let mut files: Vec<SoundFile> = Vec::new();
        let mut truncated = false;
        for r in &index {
            if !pre_slash.is_empty() && !r.starts_with(&pre_slash) {
                continue;
            }
            if !r.to_lowercase().contains(&q) {
                continue;
            }
            if files.len() >= CAP {
                truncated = true;
                break;
            }
            files.push(SoundFile {
                label: sound_stem(r),
                reference: r.clone(),
            });
        }
        return Ok(SoundBrowse { folders: vec![], files, truncated, total });
    }

    // Folder view: immediate subfolders (with recursive counts) + direct files.
    use std::collections::BTreeMap;
    let mut folder_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut files: Vec<SoundFile> = Vec::new();
    for r in &index {
        let rest = if pre_slash.is_empty() {
            r.as_str()
        } else if let Some(s) = r.strip_prefix(&pre_slash) {
            s
        } else {
            continue;
        };
        match rest.split_once('/') {
            Some((sub, _)) => {
                *folder_counts.entry(sub.to_string()).or_insert(0) += 1;
            }
            None => {
                files.push(SoundFile { label: sound_stem(r), reference: r.clone() });
            }
        }
    }
    let folders = folder_counts
        .into_iter()
        .map(|(name, count)| SoundFolder {
            prefix: if pre.is_empty() { name.clone() } else { format!("{pre}/{name}") },
            name,
            count,
        })
        .collect();
    let truncated = files.len() > CAP;
    files.truncate(CAP);
    Ok(SoundBrowse { folders, files, truncated, total })
}

/// Which of `refs` do NOT exist as real sound files in the pak. Used to gray
/// out stock entries whose preview would otherwise play a wrong/beep sound —
/// vanilla data contains both placeholder refs (`sounds/common/null.vsnd`) and
/// legacy refs to files Deadlock never shipped (`sounds/ui/beep07.vsnd`…).
/// If anything looks missing against the cached index, the index is rebuilt
/// once and rechecked, so a stale cache never reports a freshly-patched-in
/// file as missing.
#[tauri::command]
pub fn check_sound_refs(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    refs: Vec<String>,
) -> Result<Vec<String>, String> {
    use std::collections::HashSet;
    let missing_against = |index: &[String]| -> Vec<String> {
        let set: HashSet<&str> = index.iter().map(|s| s.as_str()).collect();
        refs.iter().filter(|r| !set.contains(r.as_str())).cloned().collect()
    };
    let index = game_sound_index(&app, &helper_path, &pak_path, false)?;
    let missing = missing_against(&index);
    if missing.is_empty() {
        return Ok(missing);
    }
    // Could be a stale cache (a patch added the file) — rebuild and recheck,
    // but only once per app run: vanilla data has refs that are GENUINELY
    // missing (legacy files Deadlock never shipped), so without this guard
    // every pool load would re-list the whole pak.
    static REBUILT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if REBUILT.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(missing);
    }
    let index = game_sound_index(&app, &helper_path, &pak_path, true)?;
    Ok(missing_against(&index))
}

/// `sounds/vo/atlas/atlas_ally_x.vsnd` -> `atlas_ally_x`.
fn sound_stem(reference: &str) -> String {
    reference
        .rsplit('/')
        .next()
        .unwrap_or(reference)
        .trim_end_matches(".vsnd")
        .to_string()
}

// ---- Effects: particle browser + recolor preview ---------------------------
// Hero/item ability VFX are particle systems (`particles/**.vpcf_c`). We browse
// the pak's particle tree exactly like sounds, and for a chosen particle we
// decompile it, pull its color params + sprite textures, and decode those
// sprites to PNG so the UI can render an approximate (recolorable) preview.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticleFolder {
    pub name: String,
    pub prefix: String,
    pub count: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticleFile {
    /// The `.vpcf` reference (override target), e.g. `particles/abilities/x.vpcf`.
    pub reference: String,
    pub label: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticleBrowse {
    pub folders: Vec<ParticleFolder>,
    pub files: Vec<ParticleFile>,
    pub truncated: bool,
    pub total: usize,
}

/// Build (and cache) the index of every `particles/**.vpcf_c` path in the pak,
/// stored as `.vpcf` references (the `_c` stripped).
fn game_particle_index(
    app: &tauri::AppHandle,
    helper_path: &str,
    pak_path: &str,
    refresh: bool,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cache = dir.join("game_particles.txt");
    if !refresh {
        if let Ok(t) = std::fs::read_to_string(&cache) {
            if !t.trim().is_empty() {
                return Ok(t.lines().map(|s| s.to_string()).collect());
            }
        }
    }
    let mut refs: Vec<String> = crate::vpk::list(helper_path, pak_path, Some("particles/"))?
        .into_iter()
        .filter(|p| p.ends_with(".vpcf_c"))
        .map(|p| p.trim_end_matches("_c").to_string())
        .collect();
    refs.sort();
    refs.dedup();
    let _ = std::fs::write(&cache, refs.join("\n"));
    Ok(refs)
}

/// Browse the game's particle tree under `prefix` (lazy folders) or search by
/// `query` (recursive, capped). Mirrors `browse_game_sounds`.
#[tauri::command]
pub fn browse_particles(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    prefix: String,
    query: Option<String>,
    refresh: Option<bool>,
) -> Result<ParticleBrowse, String> {
    const CAP: usize = 500;
    let index = game_particle_index(&app, &helper_path, &pak_path, refresh.unwrap_or(false))?;
    let total = index.len();
    let pre = prefix.trim_matches('/');
    let pre_slash = if pre.is_empty() { String::new() } else { format!("{pre}/") };

    let q = query.unwrap_or_default().trim().to_lowercase();
    if !q.is_empty() {
        let mut files: Vec<ParticleFile> = Vec::new();
        let mut truncated = false;
        for r in &index {
            if !pre_slash.is_empty() && !r.starts_with(&pre_slash) {
                continue;
            }
            if !r.to_lowercase().contains(&q) {
                continue;
            }
            if files.len() >= CAP {
                truncated = true;
                break;
            }
            files.push(ParticleFile { label: particle_stem(r), reference: r.clone() });
        }
        return Ok(ParticleBrowse { folders: vec![], files, truncated, total });
    }

    use std::collections::BTreeMap;
    let mut folder_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut files: Vec<ParticleFile> = Vec::new();
    for r in &index {
        let rest = if pre_slash.is_empty() {
            r.as_str()
        } else if let Some(s) = r.strip_prefix(&pre_slash) {
            s
        } else {
            continue;
        };
        match rest.split_once('/') {
            Some((sub, _)) => {
                *folder_counts.entry(sub.to_string()).or_insert(0) += 1;
            }
            None => files.push(ParticleFile { label: particle_stem(r), reference: r.clone() }),
        }
    }
    let folders = folder_counts
        .into_iter()
        .map(|(name, count)| ParticleFolder {
            prefix: if pre.is_empty() { name.clone() } else { format!("{pre}/{name}") },
            name,
            count,
        })
        .collect();
    let truncated = files.len() > CAP;
    files.truncate(CAP);
    Ok(ParticleBrowse { folders, files, truncated, total })
}

/// `particles/abilities/abrams/abrams_charge.vpcf` -> `abrams_charge`.
fn particle_stem(reference: &str) -> String {
    reference.rsplit('/').next().unwrap_or(reference).trim_end_matches(".vpcf").to_string()
}

/// One RGBA color found in a particle source.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy, PartialEq)]
pub struct RgbaColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectPreview {
    /// The `.vpcf` reference this preview is for.
    pub particle_path: String,
    /// Absolute paths to decoded sprite PNGs the particle uses.
    pub sprites: Vec<String>,
    /// Distinct colors found (for the base tint / dominant color).
    pub colors: Vec<RgbaColor>,
}

/// True for a vpcf key that holds an RGB(A) color literal we can recolor.
fn is_color_key(key: &str) -> bool {
    key.contains("Color") && !key.contains("Scale") && !key.contains("Blend")
}

/// Pull every `m_*Color* = [ r, g, b(, a) ]` literal out of a vpcf source.
fn parse_particle_colors(text: &str) -> Vec<RgbaColor> {
    let mut out: Vec<RgbaColor> = Vec::new();
    for line in text.lines() {
        if let Some(c) = parse_color_line(line) {
            if !out.contains(&c) {
                out.push(c);
            }
        }
    }
    out
}

/// If `line` is a recolorable color literal, return its parsed color.
fn parse_color_line(line: &str) -> Option<RgbaColor> {
    let t = line.trim();
    let (key, rest) = t.split_once('=')?;
    let key = key.trim();
    if !key.starts_with("m_") || !is_color_key(key) {
        return None;
    }
    let inner = rest.trim().strip_prefix('[')?.strip_suffix(']')?;
    let nums: Vec<u32> = inner
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .filter_map(|s| s.parse::<u32>().ok())
        .collect();
    if nums.len() < 3 || nums.len() > 4 || nums.iter().any(|n| *n > 255) {
        return None;
    }
    Some(RgbaColor {
        r: nums[0] as u8,
        g: nums[1] as u8,
        b: nums[2] as u8,
        a: if nums.len() == 4 { nums[3] as u8 } else { 255 },
    })
}

/// Pull unique `m_hTexture = resource:"...vtex"` references from a vpcf source.
fn parse_texture_refs(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if !t.contains("m_hTexture") {
            continue;
        }
        if let Some(p) = between(t, "resource:\"", "\"") {
            let p = p.to_string();
            if p.ends_with(".vtex") && !out.contains(&p) {
                out.push(p);
            }
        }
    }
    out
}

/// Decompile a particle + decode its sprites for an approximate recolor preview.
/// Cached per particle (decoded sprites are reused).
#[tauri::command]
pub fn effect_preview(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    particle_path: String,
    refresh: Option<bool>,
) -> Result<EffectPreview, String> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?.join("hero_portraits");
    let pdir = base.join("effects");
    let sdir = base.join("effectsprites");
    std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&sdir).map_err(|e| e.to_string())?;

    let stem = particle_path.trim_end_matches(".vpcf").replace(['/', '\\'], "_");
    let vpcf = pdir.join(format!("{stem}.vpcf"));
    if refresh.unwrap_or(false) || !vpcf.exists() {
        crate::vpk::decompile_from_vpk(
            &helper_path,
            &pak_path,
            &format!("{particle_path}_c"),
            &vpcf.to_string_lossy(),
        )?;
    }
    let text = std::fs::read_to_string(&vpcf).map_err(|e| e.to_string())?;
    let colors = parse_particle_colors(&text);

    // Decode the referenced sprite textures (as `.vtex_c`) to PNG, one batch.
    let tex_c: Vec<String> = parse_texture_refs(&text).into_iter().map(|p| format!("{p}_c")).collect();
    let mut sprites: Vec<String> = Vec::new();
    if !tex_c.is_empty() {
        match crate::vpk::texture_batch(&helper_path, &pak_path, &sdir.to_string_lossy(), &tex_c) {
            Ok(pairs) => sprites = pairs.into_iter().map(|(_, png)| png).collect(),
            Err(e) => eprintln!("effect_preview: sprite decode failed: {e}"),
        }
    }
    Ok(EffectPreview { particle_path, sprites, colors })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterSheet {
    /// Absolute path of the decoded sheet color texture (PNG) for display.
    pub color_png: String,
    pub width: u32,
    pub height: u32,
}

/// Read a PNG's pixel dimensions from its IHDR chunk.
fn png_dimensions(path: &std::path::Path) -> Result<(u32, u32), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("not a png".into());
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Ok((w, h))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackIcon {
    /// The pack-internal `.vtex_c` path (the override target).
    pub target_vtexc: String,
    /// Decoded PNG in the app-data cache (usable as an IconMod source).
    pub png_path: String,
    pub width: u32,
    pub height: u32,
}

/// Decode every panorama image (item icons etc.) a mod pack ships, so an
/// import can adopt them as editable Icon Mods instead of leaving them
/// invisible inside the pack.
#[tauri::command]
pub fn pack_icons(
    app: tauri::AppHandle,
    helper_path: String,
    source: String,
) -> Result<Vec<PackIcon>, String> {
    use tauri::Manager;
    let targets: Vec<String> = crate::vpk::list(&helper_path, &source, Some("panorama/images/"))?
        .into_iter()
        .filter(|e| e.ends_with(".vtex_c"))
        .collect();
    if targets.is_empty() {
        return Ok(vec![]);
    }
    let mut hash: u32 = 2166136261;
    for b in source.bytes() {
        hash = (hash ^ u32::from(b)).wrapping_mul(16777619);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pack_icons")
        .join(format!("{hash:08x}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let src_is_dir = std::path::Path::new(&source).is_dir();
    for target in targets {
        let stem = target
            .rsplit('/')
            .next()
            .unwrap_or(&target)
            .trim_end_matches(".vtex_c");
        let png = dir.join(format!("{stem}.png"));
        if !png.exists() {
            let r = if src_is_dir {
                let loose = std::path::Path::new(&source).join(&target);
                crate::vpk::texture_file(&helper_path, &loose.to_string_lossy(), &png.to_string_lossy())
            } else {
                crate::vpk::texture_batch(&helper_path, &source, &dir.to_string_lossy(), &[target.clone()])
                    .map(|_| String::new())
            };
            if r.is_err() || !png.exists() {
                continue; // not a decodable 2D texture — skip it
            }
        }
        let Ok((width, height)) = png_dimensions(&png) else { continue };
        out.push(PackIcon {
            target_vtexc: target,
            png_path: png.to_string_lossy().to_string(),
            width,
            height,
        });
    }
    Ok(out)
}

/// Helper-free vpk index sniff: the directory tree (plain strings) lives at
/// the head of a `_dir.vpk` — 4MB covers any addon's index without reading
/// multi-GB paks into memory. NOTE the tree stores extension, directory, and
/// file stem as SEPARATE strings ("vjs_c" … "panorama/scripts" …
/// "digi_master"), so needles must be bare stems or directory paths — a
/// joined "digi_master.vjs" never appears contiguously.
fn vpk_head(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut head = Vec::with_capacity(4 << 20);
    f.take(4 << 20).read_to_end(&mut head).ok()?;
    Some(head)
}

fn head_contains(head: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && head.windows(needle.len()).any(|w| w == needle)
}

fn addon_dir_vpks(addons_dir: &str) -> Vec<std::path::PathBuf> {
    let Ok(entries) = std::fs::read_dir(addons_dir) else {
        return vec![];
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|s| s.to_string_lossy().to_lowercase().ends_with("_dir.vpk"))
                .unwrap_or(false)
        })
        .collect()
}

/// True when any installed addon pak ships the DigiMaster jumpscare engine
/// (signature: a compiled digi_master script). Gates the Jumpscares tab.
/// Async is load-bearing: this reads the head of every installed pak (tens
/// of MB of disk) — a sync command would do that on the UI thread.
#[tauri::command]
pub async fn digimod_detected(addons_dir: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        addon_dir_vpks(&addons_dir).iter().any(|p| {
            vpk_head(p).map(|h| head_contains(&h, b"digi_master")).unwrap_or(false)
        })
    })
    .await
    .unwrap_or(false)
}

/// An installed addon pak that overrides the base HUD layout (a panorama UI
/// mod). `has_digi` marks paks that ARE the DigiMaster engine — the
/// Jumpscares tab replaces those rather than merging them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiModVpk {
    pub path: String,
    pub file_name: String,
    pub has_digi: bool,
}

/// Scan the addons dir for base_hud-overriding paks — merge candidates for
/// the Jumpscares tab (two HUD mods can't coexist; merging ships both in one).
/// Async for the same reason as `digimod_detected`.
#[tauri::command]
pub async fn list_ui_mods(addons_dir: String) -> Vec<UiModVpk> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for path in addon_dir_vpks(&addons_dir) {
            let Some(head) = vpk_head(&path) else { continue };
            if !(head_contains(&head, b"panorama/layout") && head_contains(&head, b"base_hud")) {
                continue;
            }
            out.push(UiModVpk {
                path: path.to_string_lossy().to_string(),
                file_name: path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                has_digi: head_contains(&head, b"digi_master"),
            });
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Adopt an existing DigiMaster pak: parse its CONFIG + LIBRARY, pull every
/// webm/image/sound out into app-data `digimod_media/`, and return an
/// editable config for the Jumpscares tab. Async — extraction + decode of a
/// dozen media files takes seconds.
#[tauri::command]
pub async fn import_digimod(
    app: tauri::AppHandle,
    helper_path: String,
    vpk: String,
) -> Result<crate::digimod::DigimodImport, String> {
    use tauri::Manager;
    let dest = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("digimod_media");
    tauri::async_runtime::spawn_blocking(move || {
        crate::digimod::import_from_vpk(&helper_path, &vpk, &dest)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// First-frame thumbnail for a local video, cached on disk (app-data
/// `digimod_media/.thumbs/<identity>.jpg`). The webview never decodes video
/// just to draw a card — ffmpeg renders one small jpeg per file identity,
/// once ever; later sessions hit the disk cache.
#[tauri::command]
pub async fn media_thumb(
    app: tauri::AppHandle,
    ffmpeg_path: Option<String>,
    media_path: String,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("digimod_media")
        .join(".thumbs");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&media_path).map_err(|e| e.to_string())?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let key = crate::compile::fingerprint(&format!("{media_path}|{}|{mtime}", meta.len()));
        let out = dir.join(format!("{key}.jpg"));
        if out.exists() {
            return Ok(out.to_string_lossy().into_owned());
        }
        let exe = ffmpeg_path.as_deref().filter(|s| !s.is_empty()).unwrap_or("ffmpeg");
        let grab = |seek: &str| {
            crate::procutil::quiet(exe)
                .args(["-y", "-ss", seek, "-i", &media_path, "-frames:v", "1", "-vf", "scale=320:-2"])
                .arg(&out)
                .output()
        };
        // Frame 0 is often black — grab a beat in; clips shorter than that
        // produce no frame, so fall back to the very start.
        let ok = match grab("0.4") {
            Ok(o) if o.status.success() && out.exists() => true,
            _ => matches!(grab("0"), Ok(o) if o.status.success()) && out.exists(),
        };
        if !ok {
            return Err("ffmpeg could not extract a frame".into());
        }
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pull the audio track out of a video into an mp3 under app-data
/// `digimod_media/` — used to auto-pair a jumpscare video with its own
/// sound (the webm conversion strips audio; panorama plays it via a
/// soundevent instead). Ok(None) when the video has no usable audio.
/// Output is keyed by file identity, so re-adding the same video reuses it.
#[tauri::command]
pub async fn extract_video_audio(
    app: tauri::AppHandle,
    ffmpeg_path: Option<String>,
    media_path: String,
) -> Result<Option<String>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("digimod_media");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let meta = std::fs::metadata(&media_path).map_err(|e| e.to_string())?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let key = crate::compile::fingerprint(&format!("{media_path}|{}|{mtime}", meta.len()));
        let stem = std::path::Path::new(&media_path)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "video".into());
        let out = dir.join(format!("{stem}_{}.mp3", &key[..8]));
        if out.exists() {
            return Ok(Some(out.to_string_lossy().into_owned()));
        }
        let exe = ffmpeg_path.as_deref().filter(|s| !s.is_empty()).unwrap_or("ffmpeg");
        let result = crate::procutil::quiet(exe)
            .args(["-y", "-i", &media_path, "-vn", "-acodec", "libmp3lame", "-q:a", "4"])
            .arg(&out)
            .output()
            .map_err(|e| e.to_string())?;
        // Silent/no-audio videos either fail outright or write a header-only
        // file — both mean "no sound to pair".
        let ok = result.status.success()
            && out.metadata().map(|m| m.len() > 1024).unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_file(&out);
            return Ok(None);
        }
        Ok(Some(out.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List the game's panorama layout/style files — the UI Master tab's browse
/// tree. Scripts (`.vjs_c`) are excluded for now: VRF can't decompile them
/// to clean source, so they aren't editable yet.
#[tauri::command]
pub async fn list_ui_files(helper_path: String, pak_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = crate::vpk::list(&helper_path, &pak_path, Some("panorama/"))?;
        out.retain(|p| p.ends_with(".vcss_c") || p.ends_with(".vxml_c"));
        out.sort();
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Decompile one panorama layout/style from the pak to editable source text
/// (UI Master's "open file"). VRF reconstructs clean XML/CSS — proven by the
/// base_hud merge pipeline.
#[tauri::command]
pub async fn read_ui_file(
    helper_path: String,
    pak_path: String,
    internal_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!(
            "eim_ui_{}.txt",
            crate::compile::fingerprint(&internal_path)
        ));
        crate::vpk::decompile_from_vpk(&helper_path, &pak_path, &internal_path, &tmp.to_string_lossy())?;
        let text = std::fs::read_to_string(&tmp).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// UI Master phase-2 spike: compile the current UI edits and copy them LOOSE
/// into our own `game/citadel/eim_dev/` dir, mounted as a TOP-priority
/// search path in gameinfo.gi (above addons and pak01) — so a running/
/// next-boot game reads our files instead of the pak's. No vpk build, no
/// install: the fastest possible iteration loop. A manifest records every
/// pushed file so `clear_pushed_ui` can cleanly undo the whole experiment.
/// (Same search-path trick other launchers use — but in OUR dir, not theirs.)
#[tauri::command]
pub async fn push_ui_files(
    config: CompileConfig,
    citadel_dir: String,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if config.ui_overrides.is_empty() {
            return Err("no edited UI files to push".to_string());
        }
        let mut report = compile::CompileReport::new();
        let (rels, _dirty) = compile::compile_ui_overrides(
            &config,
            std::path::Path::new(&config.content_root),
            std::path::Path::new(&config.compiled_root),
            &mut report,
        )
        .map_err(|_| "UI compile failed".to_string())?;
        if !report.ok {
            let why = report
                .steps
                .iter()
                .filter(|s| !s.ok)
                .map(|s| format!("{}: {}", s.name, s.detail))
                .collect::<Vec<_>>()
                .join(" | ");
            return Err(why);
        }
        let citadel = std::path::Path::new(&citadel_dir);
        crate::install::ensure_citadel_searchpath(citadel, "eim_dev")?;
        let dev_dir = citadel.join("eim_dev");
        let manifest_path = dev_dir.join(".eim_pushed.json");
        // Union with anything pushed earlier so removal cleans everything.
        let mut pushed: Vec<String> = std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        for rel in &rels {
            let src = std::path::Path::new(&config.compiled_root).join(rel);
            let dest = dev_dir.join(rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&src, &dest).map_err(|e| format!("push {rel}: {e}"))?;
            if !pushed.contains(rel) {
                pushed.push(rel.clone());
            }
        }
        std::fs::write(&manifest_path, serde_json::to_string_pretty(&pushed).unwrap_or_default())
            .map_err(|e| e.to_string())?;
        Ok(rels)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove every UI file `push_ui_files` placed in eim_dev (manifest-driven;
/// nothing else in there is touched). The search-path entry stays — an empty
/// dir is inert. Returns how many files were removed.
#[tauri::command]
pub async fn clear_pushed_ui(citadel_dir: String) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dev_dir = std::path::Path::new(&citadel_dir).join("eim_dev");
        let manifest_path = dev_dir.join(".eim_pushed.json");
        let pushed: Vec<String> = std::fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let mut removed = 0u32;
        for rel in &pushed {
            let p = dev_dir.join(rel);
            if std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
            // Prune now-empty dirs up to eim_dev itself (best-effort).
            let mut dir = p.parent().map(|d| d.to_path_buf());
            while let Some(d) = dir {
                if d == dev_dir || std::fs::remove_dir(&d).is_err() {
                    break;
                }
                dir = d.parent().map(|x| x.to_path_buf());
            }
        }
        let _ = std::fs::remove_file(&manifest_path);
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Which of `names` (case-insensitive exe names) are currently running.
/// Powers the compile bar's "Deadlock / Source 2 Viewer is open" warning —
/// both hold locks on the pak/addons that make compiles and installs fail
/// in confusing ways.
#[tauri::command]
pub fn running_processes(names: Vec<String>) -> Vec<String> {
    let out = match crate::procutil::quiet("tasklist").args(["/FO", "CSV", "/NH"]).output() {
        Ok(o) => o,
        Err(_) => return vec![],
    };
    let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
    names
        .into_iter()
        .filter(|n| text.contains(&format!("\"{}\"", n.to_lowercase())))
        .collect()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub url: String,
    /// Direct download URL of the release's NSIS installer asset, when one is
    /// attached — enables one-click "Install now" (else fall back to `url`).
    pub setup_asset: Option<String>,
}

/// Check GitHub for a newer release. Returns None when up to date (or the
/// check fails — never nag on network errors). Async is load-bearing: the
/// curl can block up to 10s and must never sit on the UI thread at launch.
#[tauri::command]
pub async fn check_app_update() -> Option<AppUpdate> {
    tauri::async_runtime::spawn_blocking(|| {
        let current = env!("CARGO_PKG_VERSION").to_string();
        let out = crate::procutil::quiet(r"C:\Windows\System32\curl.exe")
            .args([
                "-s",
                "-m",
                "10",
                "-H",
                "User-Agent: MoonahsModMaker",
                "https://api.github.com/repos/Moonahuwu/MoonahsModMaker/releases/latest",
            ])
            .output()
            .ok()?;
        let body: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
        let tag = body.get("tag_name")?.as_str()?;
        let latest = tag.trim_start_matches('v').to_string();
        // Tool releases (tools-v2 etc.) aren't app versions — require digits+dots.
        if latest.is_empty() || !latest.chars().all(|c| c.is_ascii_digit() || c == '.') {
            return None;
        }
        if latest == current {
            return None;
        }
        let url = body
            .get("html_url")
            .and_then(|u| u.as_str())
            .unwrap_or("https://github.com/Moonahuwu/MoonahsModMaker/releases")
            .to_string();
        // Prefer the NSIS setup exe among the release assets (one-click path).
        let setup_asset = body
            .get("assets")
            .and_then(|a| a.as_array())
            .and_then(|assets| {
                assets.iter().find_map(|a| {
                    let name = a.get("name")?.as_str()?.to_lowercase();
                    if name.ends_with(".exe") && name.contains("setup") {
                        Some(a.get("browser_download_url")?.as_str()?.to_string())
                    } else {
                        None
                    }
                })
            });
        Some(AppUpdate { current, latest, url, setup_asset })
    })
    .await
    .ok()
    .flatten()
}

/// One-click update: download the release's installer to temp, launch it,
/// and exit the app (NSIS can't replace a running exe). The installer takes
/// it from there.
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle, setup_url: String) -> Result<(), String> {
    let dest = std::env::temp_dir().join("moonahs_mod_maker_update_setup.exe");
    let dest2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let out = crate::procutil::quiet(r"C:\Windows\System32\curl.exe")
            .args(["-sL", "-m", "300", "-H", "User-Agent: MoonahsModMaker", "-o"])
            .arg(&dest2)
            .arg(&setup_url)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() || dest2.metadata().map(|m| m.len() < 1_000_000).unwrap_or(true) {
            return Err("download failed (or the file looks too small to be the installer)".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    std::process::Command::new(&dest)
        .spawn()
        .map_err(|e| format!("launching installer: {e}"))?;
    app.exit(0);
    Ok(())
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbCredit {
    pub name: String,
    /// Their contribution ("Objective damage + base"); may be empty.
    pub role: String,
    /// GameBanana profile or external URL; may be empty.
    pub url: String,
}

/// A GameBanana mod page's attribution info, fetched for a bundled mod so a
/// released combined pack can credit everyone (Mod Combiner tab).
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbModInfo {
    pub mod_id: u64,
    pub page_url: String,
    pub name: String,
    pub author: String,
    pub author_url: String,
    pub credits: Vec<GbCredit>,
    /// True when the local vpk's MD5 matches one of the page's release files.
    /// Best effort: most downloads are zips around the vpk, so a non-match
    /// proves nothing and stays a quiet false.
    pub md5_verified: bool,
}

/// Fetch a GameBanana mod page's name/author/credits via the site's own JSON
/// API (apiv11, same one Deadlock Mod Manager uses). `vpk_path`, when given,
/// is hashed and checked against the page's release-file MD5s.
#[tauri::command]
pub async fn gamebanana_mod_info(
    page_url: String,
    vpk_path: Option<String>,
) -> Result<GbModInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (model, id) = parse_gamebanana_ref(&page_url).ok_or(
            "that doesn't look like a GameBanana link (expected gamebanana.com/mods/<number> or /sounds/<number>)",
        )?;
        gb_mod_info_blocking(&model, id, vpk_path.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// GET a GameBanana apiv11 URL and parse the JSON.
fn gb_fetch_json(url: &str) -> Result<serde_json::Value, String> {
    let out = crate::procutil::quiet(r"C:\Windows\System32\curl.exe")
        .args(["-s", "-m", "15", "-H", "User-Agent: MoonahsModMaker", url])
        .output()
        .map_err(|e| format!("launching curl: {e}"))?;
    serde_json::from_slice(&out.stdout)
        .map_err(|_| "GameBanana didn't answer (no internet, or the API changed)".to_string())
}

fn gb_str(v: &serde_json::Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string()
}

/// `model` is a GameBanana submission type: "Mod" or "Sound" (Deadlock's sound
/// mods are their own model on the site, ~as many as all Mods combined).
fn gb_mod_info_blocking(model: &str, mod_id: u64, vpk_path: Option<&str>) -> Result<GbModInfo, String> {
    let body = gb_fetch_json(&format!(
        "https://gamebanana.com/apiv11/{model}/{mod_id}/ProfilePage"
    ))?;
    let name = gb_str(&body, "_sName");
    if name.is_empty() {
        return Err("GameBanana didn't return mod data (bad link, hidden page, or no internet)".into());
    }
    let submitter = body.get("_aSubmitter").cloned().unwrap_or_default();
    // _aCredits comes grouped: [{_sGroupName, _aAuthors: [{_sName, _sRole,
    // _sProfileUrl (members) | _sUrl (external)}]}]. Handle a flat author
    // entry too in case the API serves ungrouped shapes.
    let mut credits: Vec<GbCredit> = Vec::new();
    let mut push_author = |a: &serde_json::Value, group: &str| {
        let n = gb_str(a, "_sName");
        if n.is_empty() {
            return;
        }
        let role = match gb_str(a, "_sRole") {
            r if r.is_empty() => group.to_string(),
            r => r,
        };
        let url = match gb_str(a, "_sProfileUrl") {
            u if u.is_empty() => gb_str(a, "_sUrl"),
            u => u,
        };
        credits.push(GbCredit { name: n, role, url });
    };
    if let Some(groups) = body.get("_aCredits").and_then(|c| c.as_array()) {
        for g in groups {
            if let Some(authors) = g.get("_aAuthors").and_then(|a| a.as_array()) {
                let group = gb_str(g, "_sGroupName");
                for a in authors {
                    push_author(a, &group);
                }
            } else {
                push_author(g, "");
            }
        }
    }
    let md5_verified = vpk_path
        .filter(|p| !p.is_empty())
        .and_then(file_md5)
        .map(|local| {
            body.get("_aFiles")
                .and_then(|f| f.as_array())
                .is_some_and(|files| {
                    files
                        .iter()
                        .any(|f| gb_str(f, "_sMd5Checksum").eq_ignore_ascii_case(&local))
                })
        })
        .unwrap_or(false);
    Ok(GbModInfo {
        mod_id,
        page_url: format!(
            "https://gamebanana.com/{}/{mod_id}",
            if model == "Sound" { "sounds" } else { "mods" }
        ),
        name,
        author: gb_str(&submitter, "_sName"),
        author_url: gb_str(&submitter, "_sProfileUrl"),
        credits,
        md5_verified,
    })
}

/// Accepts a full GameBanana URL (`https://gamebanana.com/mods/623518` or
/// `/sounds/87058`, extra path or query tolerated) or a bare numeric id
/// (treated as a Mod). Returns the (model, id) pair.
fn parse_gamebanana_ref(input: &str) -> Option<(String, u64)> {
    let t = input.trim();
    if let Ok(n) = t.parse::<u64>() {
        return Some(("Mod".into(), n));
    }
    let (model, marker) = if t.contains("/sounds/") {
        ("Sound", "/sounds/")
    } else {
        ("Mod", "/mods/")
    };
    let rest = &t[t.find(marker)? + marker.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok().map(|n| (model.into(), n))
}

/// MD5 of a file via Windows' built-in certutil (no hash crate needed). The
/// hash is on the second output line; older Windows spaces the hex pairs.
fn file_md5(path: &str) -> Option<String> {
    let out = crate::procutil::quiet(r"C:\Windows\System32\certutil.exe")
        .args(["-hashfile", path, "MD5"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .nth(1)
        .map(|l| l.replace(' ', "").trim().to_lowercase())
        .filter(|h| h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

const GB_DEADLOCK_GAME_ID: u32 = 20948;

/// Minimal percent-encoding for a search string in a query param.
fn gb_urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbSearchItem {
    pub mod_id: u64,
    /// The submission type this item belongs to ("Mod" | "Sound") - files and
    /// downloads must be fetched against the same model.
    pub model: String,
    pub name: String,
    pub author: String,
    pub category: String,
    pub page_url: String,
    /// 220px preview image on GameBanana's CDN; "" when the mod has none.
    pub thumb_url: String,
    pub likes: u64,
    pub views: u64,
    /// The page carries content ratings (nudity etc.) - hidden by default.
    pub nsfw: bool,
    /// Sound submissions host a preview MP3 on GameBanana's CDN (CORS-open) -
    /// streamed for the in-card listen-before-you-install player. "" = none.
    pub audio_url: String,
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbSearchPage {
    pub items: Vec<GbSearchItem>,
    /// False while more pages exist (drives "Load more").
    pub is_complete: bool,
}

/// Browse Deadlock mods on GameBanana: the game's submission feed when the
/// query is empty, the site search scoped to Deadlock otherwise. `sort`
/// ("downloads" | "likes" | "new") reorders the BROWSE feed via {model}/Index;
/// query searches are always relevance-ranked by the site. `model` picks the
/// submission type: "Mod" (default) or "Sound" (sound mods only).
#[tauri::command]
pub async fn gamebanana_search(
    query: String,
    page: u32,
    sort: Option<String>,
    model: Option<String>,
) -> Result<GbSearchPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let q = query.trim().to_string();
        let page = page.max(1);
        let model = match model.as_deref() {
            Some("Sound") => "Sound",
            _ => "Mod",
        };
        let index_sort = match sort.as_deref() {
            Some("downloads") => Some("Generic_MostDownloaded"),
            Some("likes") => Some("Generic_MostLiked"),
            Some("new") => Some("Generic_Newest"),
            _ => None,
        };
        let url = if !q.is_empty() {
            // The search endpoint's own orders: best_match, popularity, date.
            // No downloads order exists, so "downloads" rides popularity (the
            // closest ranking the site offers while searching).
            let order = match sort.as_deref() {
                Some("downloads") | Some("likes") => "popularity",
                Some("new") => "date",
                _ => "best_match",
            };
            format!(
                "https://gamebanana.com/apiv11/Util/Search/Results?_sModelName={model}&_sOrder={order}&_idGameRow={GB_DEADLOCK_GAME_ID}&_sSearchString={}&_nPage={page}",
                gb_urlencode(&q)
            )
        } else if let Some(s) = index_sort {
            // %5B/%5D = literal [] (curl would otherwise glob them).
            format!(
                "https://gamebanana.com/apiv11/{model}/Index?_nPerpage=15&_aFilters%5BGeneric_Game%5D={GB_DEADLOCK_GAME_ID}&_sSort={s}&_nPage={page}"
            )
        } else {
            format!(
                "https://gamebanana.com/apiv11/Game/{GB_DEADLOCK_GAME_ID}/Subfeed?_nPage={page}&_sSort=default&_csvModelInclusions={model}"
            )
        };
        let body = gb_fetch_json(&url)?;
        let empty = vec![];
        let records = body.get("_aRecords").and_then(|r| r.as_array()).unwrap_or(&empty);
        let items = records
            .iter()
            .filter_map(|r| {
                let mod_id = r.get("_idRow")?.as_u64()?;
                let name = gb_str(r, "_sName");
                if name.is_empty() {
                    return None;
                }
                let rec_model = match gb_str(r, "_sModelName") {
                    m if m.is_empty() => model.to_string(),
                    m => m,
                };
                let thumb_url = r
                    .pointer("/_aPreviewMedia/_aImages/0")
                    .map(|i| {
                        let base = gb_str(i, "_sBaseUrl");
                        let f = match gb_str(i, "_sFile220") {
                            t if t.is_empty() => gb_str(i, "_sFile"),
                            t => t,
                        };
                        if base.is_empty() || f.is_empty() {
                            String::new()
                        } else {
                            format!("{base}/{f}")
                        }
                    })
                    .unwrap_or_default();
                Some(GbSearchItem {
                    mod_id,
                    name,
                    author: r.get("_aSubmitter").map(|s| gb_str(s, "_sName")).unwrap_or_default(),
                    category: r
                        .get("_aRootCategory")
                        .map(|c| gb_str(c, "_sName"))
                        .unwrap_or_default(),
                    page_url: match gb_str(r, "_sProfileUrl") {
                        u if u.is_empty() => format!(
                            "https://gamebanana.com/{}/{mod_id}",
                            if rec_model == "Sound" { "sounds" } else { "mods" }
                        ),
                        u => u,
                    },
                    model: rec_model,
                    thumb_url,
                    likes: r.get("_nLikeCount").and_then(|v| v.as_u64()).unwrap_or(0),
                    views: r.get("_nViewCount").and_then(|v| v.as_u64()).unwrap_or(0),
                    nsfw: r
                        .get("_bHasContentRatings")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    audio_url: r
                        .pointer("/_aPreviewMedia/_aMetadata/_sAudioUrl")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                })
            })
            .collect();
        Ok(GbSearchPage {
            items,
            is_complete: body
                .pointer("/_aMetadata/_bIsComplete")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbFile {
    pub name: String,
    pub size: u64,
    pub download_url: String,
    pub download_count: u64,
    pub description: String,
}

/// The downloadable files on a mod page (a page can ship several variants).
#[tauri::command]
pub async fn gamebanana_files(mod_id: u64, model: Option<String>) -> Result<Vec<GbFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let model = match model.as_deref() {
            Some("Sound") => "Sound",
            _ => "Mod",
        };
        let body = gb_fetch_json(&format!(
            "https://gamebanana.com/apiv11/{model}/{mod_id}/ProfilePage"
        ))?;
        let empty = vec![];
        Ok(body
            .get("_aFiles")
            .and_then(|f| f.as_array())
            .unwrap_or(&empty)
            .iter()
            .filter_map(|f| {
                let download_url = gb_str(f, "_sDownloadUrl");
                if download_url.is_empty() {
                    return None;
                }
                Some(GbFile {
                    name: gb_str(f, "_sFile"),
                    size: f.get("_nFilesize").and_then(|v| v.as_u64()).unwrap_or(0),
                    download_url,
                    download_count: f.get("_nDownloadCount").and_then(|v| v.as_u64()).unwrap_or(0),
                    description: gb_str(f, "_sDescription"),
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GbDownloadResult {
    /// Mountable `_dir.vpk`s found in the download (multi-part `_NNN.vpk`
    /// archives are data-only and skipped).
    pub vpks: Vec<String>,
    /// The mod page's attribution info - the archive we just pulled is hashed
    /// against the page's MD5s, so `md5_verified` is true on a clean download.
    pub info: GbModInfo,
}

/// Download a mod file through GameBanana's own download URL (counts on the
/// author's download stats), unpack it, and return the vpk(s) inside.
#[tauri::command]
pub async fn gamebanana_download(
    app: tauri::AppHandle,
    mod_id: u64,
    download_url: String,
    file_name: String,
    model: Option<String>,
) -> Result<GbDownloadResult, String> {
    use tauri::Manager;
    let dest_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("gb_downloads");
    tauri::async_runtime::spawn_blocking(move || {
        let model = match model.as_deref() {
            Some("Sound") => "Sound",
            _ => "Mod",
        };
        let safe_name = file_name.replace(['/', '\\'], "_");
        let lower = safe_name.to_lowercase();
        if lower.ends_with(".rar") || lower.ends_with(".7z") {
            return Err(
                "that file is a .rar/.7z archive - download it from the mod page and drop the .vpk onto this window instead".into(),
            );
        }
        // Fresh dir per mod so an older version's files can't mix in.
        let dir = dest_root.join(format!("{}{mod_id}", if model == "Sound" { "s" } else { "" }));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // Windows-native curl/tar (see download_tools for why not bare names).
        let sys32 = std::env::var("WINDIR")
            .map(|w| std::path::PathBuf::from(w).join("System32"))
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Windows\System32"));
        let pick = |name: &str| -> String {
            let native = sys32.join(format!("{name}.exe"));
            if native.exists() {
                native.to_string_lossy().into_owned()
            } else {
                name.to_string()
            }
        };
        let dest = dir.join(&safe_name);
        let out = crate::procutil::quiet(pick("curl"))
            .args([
                "-L",
                "--fail",
                "-sS",
                "-m",
                "600",
                "-H",
                "User-Agent: MoonahsModMaker",
                "-o",
                &dest.to_string_lossy(),
                &download_url,
            ])
            .output()
            .map_err(|e| format!("launching curl: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "download failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        // Verify the pull against the page BEFORE unpacking.
        let info = gb_mod_info_blocking(model, mod_id, Some(&dest.to_string_lossy()))?;
        if lower.ends_with(".zip") {
            let out = crate::procutil::quiet(pick("tar"))
                .args(["-xf", &dest.to_string_lossy(), "-C", &dir.to_string_lossy()])
                .output()
                .map_err(|e| format!("launching tar: {e}"))?;
            if !out.status.success() {
                return Err(format!(
                    "unpack failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ));
            }
            let _ = std::fs::remove_file(&dest);
        }
        let mut vpks: Vec<String> = Vec::new();
        find_dir_vpks(&dir, &mut vpks);
        vpks.sort();
        if vpks.is_empty() {
            return Err(
                "downloaded fine, but there's no .vpk inside - this doesn't look like a pak mod".into(),
            );
        }
        Ok(GbDownloadResult { vpks, info })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibraryFile {
    pub path: String,
    pub name: String,
}

/// Copy an audio file into the app-data sound library (`library/`) so it
/// stays usable after the original moves/deletes. Collision-safe naming.
#[tauri::command]
pub async fn library_add(app: tauri::AppHandle, source_path: String) -> Result<LibraryFile, String> {
    use tauri::Manager;
    let lib = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&lib).map_err(|e| e.to_string())?;
        let src = std::path::Path::new(&source_path);
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .ok_or("that path has no file name")?;
        let ext = src
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "mp3".into());
        let mut dest = lib.join(format!("{stem}.{ext}"));
        let mut n = 2;
        while dest.exists() {
            dest = lib.join(format!("{stem}_{n}.{ext}"));
            n += 1;
        }
        std::fs::copy(src, &dest).map_err(|e| format!("copying into the library: {e}"))?;
        Ok(LibraryFile {
            path: dest.to_string_lossy().into_owned(),
            name: stem,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a library copy. Refuses paths outside app-data `library/` so a bad
/// caller can't delete arbitrary files.
#[tauri::command]
pub async fn library_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let lib = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library");
    let p = std::path::PathBuf::from(&path);
    if !p.starts_with(&lib) {
        return Err("not a library file".into());
    }
    tauri::async_runtime::spawn_blocking(move || std::fs::remove_file(&p).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedAudio {
    pub path: String,
    /// The vpk-internal ref it came from (`sounds/x.vsnd_c`).
    pub source_ref: String,
}

/// Pull the sounds out of a mod vpk as playable audio files (the GameBanana
/// slot flow wants the mp3s, not the pack). Capped so a giant music pack
/// can't sit decoding for minutes; sounds that fail to decode are skipped.
#[tauri::command]
pub async fn vpk_extract_audio(
    app: tauri::AppHandle,
    helper_path: String,
    vpk: String,
) -> Result<Vec<ExtractedAudio>, String> {
    use tauri::Manager;
    let dest_root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("gb_audio");
    tauri::async_runtime::spawn_blocking(move || {
        let entries = crate::vpk::list(&helper_path, &vpk, None)?;
        let sounds: Vec<String> = entries
            .into_iter()
            .filter(|e| e.to_lowercase().ends_with(".vsnd_c"))
            .collect();
        if sounds.is_empty() {
            return Err("that pack has no sounds inside".into());
        }
        // Keyed by vpk name + size so re-adds reuse the same folder.
        let stem = std::path::Path::new(&vpk)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "pack".into());
        let size = std::fs::metadata(&vpk).map(|m| m.len()).unwrap_or(0);
        let dir = dest_root.join(format!("{stem}_{size:x}"));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        const CAP: usize = 64;
        let mut out = Vec::new();
        for s in sounds.iter().take(CAP) {
            let name = std::path::Path::new(s)
                .file_stem()
                .map(|x| x.to_string_lossy().into_owned())
                .unwrap_or_default();
            let name = name.trim_end_matches(".vsnd");
            let base = dir.join(format!("{:02}_{name}", out.len()));
            if let Ok(written) =
                crate::vpk::decode(&helper_path, &vpk, s, &base.to_string_lossy())
            {
                out.push(ExtractedAudio {
                    path: written.trim().to_string(),
                    source_ref: s.clone(),
                });
            }
        }
        if out.is_empty() {
            return Err("couldn't decode any sounds from that pack".into());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Easy Compile (experimental): auto-detect each file and compile it to its
/// `_c` form, dropping results in a folder of the user's choice.
#[tauri::command]
pub async fn easy_compile(
    req: crate::compile::EasyCompileReq,
) -> Result<Vec<crate::compile::EasyCompiled>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::compile::easy_compile_blocking(&req))
        .await
        .map_err(|e| e.to_string())?
}

/// Collect mountable vpks under `dir`: `*_dir.vpk`, or plain `*.vpk` that
/// aren't numbered data parts (`_NNN.vpk`).
fn find_dir_vpks(dir: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            find_dir_vpks(&p, out);
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
        if !name.ends_with(".vpk") {
            continue;
        }
        let is_numbered_part = name
            .strip_suffix(".vpk")
            .and_then(|s| s.rsplit_once('_'))
            .map(|(_, tail)| tail.len() == 3 && tail.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if name.ends_with("_dir.vpk") || !is_numbered_part {
            out.push(p.to_string_lossy().into_owned());
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeroImage {
    /// Slot kind: card | card_critical | card_gloat | vertical | sm | mm | background | logo.
    pub kind: String,
    /// The compiled path the game references (IconMod override target).
    pub target: String,
    /// Decoded preview in the app-data cache (PNG, or SVG for the logo).
    pub preview: String,
    pub width: u32,
    pub height: u32,
    /// SVG assets (the hero-name logo) can't be replaced by the PNG icon
    /// pipeline yet — display only.
    pub svg: bool,
}

/// Decode a hero's replaceable panorama images (portrait cards, vertical,
/// small + minimap icons, menu background, name logo) into the app-data cache.
/// `display_stem` is the display-name file stem (abrams, grey_talon, ...) used
/// by backgrounds + hero_names; `codename` is the internal one (atlas, ...).
fn hero_images_impl(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    codename: String,
    display_stem: String,
) -> Result<Vec<HeroImage>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("hero_portraits")
        .join("hero_images")
        .join(&codename);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let kinds: Vec<(&str, String)> = vec![
        ("card", format!("panorama/images/heroes/{codename}_card_psd.vtex_c")),
        ("card_critical", format!("panorama/images/heroes/{codename}_card_critical_psd.vtex_c")),
        ("card_gloat", format!("panorama/images/heroes/{codename}_card_gloat_psd.vtex_c")),
        ("vertical", format!("panorama/images/heroes/{codename}_vertical_psd.vtex_c")),
        ("sm", format!("panorama/images/heroes/{codename}_sm_psd.vtex_c")),
        ("mm", format!("panorama/images/heroes/{codename}_mm_psd.vtex_c")),
        ("background", format!("panorama/images/heroes/backgrounds/{display_stem}_bg_psd.vtex_c")),
    ];
    // Decode any not-yet-cached textures in one helper pass.
    let missing: Vec<String> = kinds
        .iter()
        .filter(|(kind, _)| !dir.join(format!("{kind}.png")).exists())
        .map(|(_, t)| t.clone())
        .collect();
    if !missing.is_empty() {
        if let Ok(pairs) = crate::vpk::texture_batch(&helper_path, &pak_path, &dir.to_string_lossy(), &missing) {
            for (stem, png) in pairs {
                // stem is the vtex file stem — map it back to its kind slot.
                if let Some((kind, _)) = kinds.iter().find(|(_, t)| {
                    t.rsplit('/').next().unwrap_or("").trim_end_matches(".vtex_c") == stem
                }) {
                    let _ = std::fs::rename(&png, dir.join(format!("{kind}.png")));
                }
            }
        }
    }

    let mut out = Vec::new();
    for (kind, target) in &kinds {
        let png = dir.join(format!("{kind}.png"));
        if !png.exists() {
            continue; // hero lacks this asset (e.g. no gloat card yet)
        }
        let (width, height) = png_dimensions(&png).unwrap_or((0, 0));
        out.push(HeroImage {
            kind: (*kind).to_string(),
            target: target.clone(),
            preview: png.to_string_lossy().to_string(),
            width,
            height,
            svg: false,
        });
    }
    // The hero-name logo is a compiled SVG: decompile for display.
    let svg_path = dir.join("logo.svg");
    if !svg_path.exists() {
        let _ = crate::vpk::decompile_from_vpk(
            &helper_path,
            &pak_path,
            &format!("panorama/images/heroes/hero_names/{display_stem}.vsvg_c"),
            &svg_path.to_string_lossy(),
        );
    }
    if svg_path.exists() {
        out.push(HeroImage {
            kind: "logo".into(),
            target: format!("panorama/images/heroes/hero_names/{display_stem}.vsvg_c"),
            preview: svg_path.to_string_lossy().to_string(),
            width: 0,
            height: 0,
            svg: true,
        });
    }
    Ok(out)
}

/// Decompile a poster atlas material from the game pak into the app-data cache
/// (once) and return its color texture as a viewable PNG. Powers the Posters
/// tab sheet display.
#[tauri::command]
pub fn poster_sheet(
    app: tauri::AppHandle,
    helper_path: String,
    pak_path: String,
    material: String,
    refresh: Option<bool>,
) -> Result<PosterSheet, String> {
    use tauri::Manager;
    let material = material.trim_matches('/').to_string();
    if !material.starts_with("materials/") || !material.ends_with(".vmat") {
        return Err(format!("not a material path: {material}"));
    }
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("posters").join("sheets");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let vmat = root.join(&material);
    if refresh.unwrap_or(false) || !vmat.exists() {
        crate::vpk::material_from_vpk(
            &helper_path,
            &pak_path,
            &format!("{material}_c"),
            &root.to_string_lossy(),
        )?;
    }
    let text = std::fs::read_to_string(&vmat).map_err(|e| e.to_string())?;
    let color_rel = text
        .lines()
        .filter_map(|l| {
            let t = l.trim();
            let rest = t.strip_prefix("\"TextureColor")?;
            let v = rest.split('"').nth(2)?;
            v.starts_with("materials/").then(|| v.to_string())
        })
        .next()
        .ok_or_else(|| format!("no color texture in {material}"))?;
    let color_abs = root.join(&color_rel);
    if !color_abs.exists() {
        return Err(format!("decoded color texture missing: {color_rel}"));
    }
    let (width, height) = png_dimensions(&color_abs)?;
    Ok(PosterSheet { color_png: color_abs.to_string_lossy().to_string(), width, height })
}

// ---------------------------------------------------------------------------
// Async wrappers: the game-data derivations above are heavy (vpk-helper
// subprocesses, texture decodes) — as sync commands they'd run ON THE UI
// THREAD and freeze the window for seconds. Each wrapper hops to a worker.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn hero_roster(app: tauri::AppHandle, helper_path: String, pak_path: String, refresh: Option<bool>) -> Result<Vec<HeroPortrait>, String> {
    tauri::async_runtime::spawn_blocking(move || hero_roster_impl(app, helper_path, pak_path, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hero_detail(app: tauri::AppHandle, helper_path: String, pak_path: String, codename: String, refresh: Option<bool>) -> Result<Vec<HeroAbility>, String> {
    tauri::async_runtime::spawn_blocking(move || hero_detail_impl(app, helper_path, pak_path, codename, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hero_voicelines(app: tauri::AppHandle, helper_path: String, pak_path: String, codename: String, refresh: Option<bool>) -> Result<Vec<VoiceLine>, String> {
    tauri::async_runtime::spawn_blocking(move || hero_voicelines_impl(app, helper_path, pak_path, codename, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hero_sounds(app: tauri::AppHandle, helper_path: String, pak_path: String, codename: String, refresh: Option<bool>) -> Result<Vec<HeroSound>, String> {
    tauri::async_runtime::spawn_blocking(move || hero_sounds_impl(app, helper_path, pak_path, codename, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn item_roster(app: tauri::AppHandle, helper_path: String, pak_path: String, refresh: Option<bool>) -> Result<Vec<ItemCard>, String> {
    tauri::async_runtime::spawn_blocking(move || item_roster_impl(app, helper_path, pak_path, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn item_detail(app: tauri::AppHandle, helper_path: String, pak_path: String, item_name: String, refresh: Option<bool>) -> Result<Vec<HeroAbilitySound>, String> {
    tauri::async_runtime::spawn_blocking(move || item_detail_impl(app, helper_path, pak_path, item_name, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn item_sound_index(app: tauri::AppHandle, helper_path: String, pak_path: String) -> Result<Vec<ItemSoundRef>, String> {
    tauri::async_runtime::spawn_blocking(move || item_sound_index_impl(app, helper_path, pak_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn browse_game_sounds(app: tauri::AppHandle, helper_path: String, pak_path: String, prefix: String, query: Option<String>, refresh: Option<bool>) -> Result<SoundBrowse, String> {
    tauri::async_runtime::spawn_blocking(move || browse_game_sounds_impl(app, helper_path, pak_path, prefix, query, refresh))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hero_images(app: tauri::AppHandle, helper_path: String, pak_path: String, codename: String, display_stem: String) -> Result<Vec<HeroImage>, String> {
    tauri::async_runtime::spawn_blocking(move || hero_images_impl(app, helper_path, pak_path, codename, display_stem))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gamebanana_ref_parsing() {
        assert_eq!(parse_gamebanana_ref("623518"), Some(("Mod".into(), 623518)));
        assert_eq!(
            parse_gamebanana_ref("https://gamebanana.com/mods/623518"),
            Some(("Mod".into(), 623518))
        );
        assert_eq!(
            parse_gamebanana_ref("  gamebanana.com/mods/623518?tab=files  "),
            Some(("Mod".into(), 623518))
        );
        assert_eq!(
            parse_gamebanana_ref("https://gamebanana.com/sounds/87058"),
            Some(("Sound".into(), 87058))
        );
        assert_eq!(parse_gamebanana_ref("https://gamebanana.com/tools/20646"), None);
        assert_eq!(parse_gamebanana_ref("not a url"), None);
        assert_eq!(parse_gamebanana_ref("https://gamebanana.com/mods/"), None);
    }

    #[test]
    fn file_md5_via_certutil() {
        let tmp = std::env::temp_dir().join("eim_md5_test.txt");
        std::fs::write(&tmp, "hello").unwrap();
        assert_eq!(
            file_md5(&tmp.to_string_lossy()),
            Some("5d41402abc4b2a76b9719d911017c592".into())
        );
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(file_md5("C:/nope/does_not_exist.vpk"), None);
    }

    /// Live API hit (network): `cargo test -p app --lib -- --ignored live_gamebanana`.
    #[test]
    #[ignore]
    fn live_gamebanana_mod_info() {
        let info = tauri::async_runtime::block_on(gamebanana_mod_info(
            "https://gamebanana.com/mods/623518".into(),
            None,
        ))
        .expect("fetch should succeed");
        assert_eq!(info.mod_id, 623518);
        assert!(!info.name.is_empty());
        assert!(!info.author.is_empty());
        assert!(!info.credits.is_empty(), "this mod's page lists credits");
        assert!(!info.md5_verified);
    }

    /// Live API hit (network): feed browse + scoped search + file listing.
    #[test]
    #[ignore]
    fn live_gamebanana_search_and_files() {
        let feed = tauri::async_runtime::block_on(gamebanana_search(String::new(), 1, None, None))
            .expect("feed should load");
        assert!(feed.items.len() >= 10, "the Deadlock feed has pages of mods");
        assert!(!feed.is_complete);
        assert!(feed.items.iter().any(|i| !i.thumb_url.is_empty()));

        let by_dl = tauri::async_runtime::block_on(gamebanana_search(
            String::new(),
            1,
            Some("downloads".into()),
            None,
        ))
        .expect("sorted feed should load");
        assert!(by_dl.items.len() >= 10);
        assert_ne!(
            by_dl.items[0].mod_id, feed.items[0].mod_id,
            "most-downloaded should differ from the default feed's first item"
        );

        let hits = tauri::async_runtime::block_on(gamebanana_search("music".into(), 1, None, None))
            .expect("search should load");
        assert!(!hits.items.is_empty(), "searching music finds sound mods");

        // The Sound submission type: Deadlock's dedicated sound-mod section.
        let sounds = tauri::async_runtime::block_on(gamebanana_search(
            "abrams".into(),
            1,
            None,
            Some("Sound".into()),
        ))
        .expect("sound search should load");
        assert!(!sounds.items.is_empty(), "hero-name sound search finds sounds");
        assert!(sounds.items.iter().all(|i| i.model == "Sound"));
        assert!(sounds.items[0].page_url.contains("/sounds/"));
        assert!(
            sounds.items.iter().any(|i| i.audio_url.starts_with("https://")),
            "sound submissions host preview MP3s"
        );

        // Search-time sorts ride the endpoint's own orders (popularity/date).
        let by_new = tauri::async_runtime::block_on(gamebanana_search(
            "abrams".into(),
            1,
            Some("new".into()),
            Some("Sound".into()),
        ))
        .expect("date-ordered search should load");
        assert!(!by_new.items.is_empty());

        let files = tauri::async_runtime::block_on(gamebanana_files(623518, None))
            .expect("files should load");
        assert!(!files.is_empty());
        assert!(files[0].download_url.starts_with("https://"));

        let sfiles = tauri::async_runtime::block_on(gamebanana_files(
            sounds.items[0].mod_id,
            Some("Sound".into()),
        ))
        .expect("sound files should load");
        assert!(!sfiles.is_empty(), "sound submissions ship files too");
    }

    #[test]
    fn urlencode_and_vpk_part_filter() {
        assert_eq!(gb_urlencode("crazy frog + rem"), "crazy%20frog%20%2B%20rem");
        let dir = std::env::temp_dir().join("eim_vpk_scan_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        for f in ["pak01_dir.vpk", "pak01_000.vpk", "sub/loose.vpk", "readme.txt"] {
            std::fs::write(dir.join(f), "x").unwrap();
        }
        let mut found = Vec::new();
        find_dir_vpks(&dir, &mut found);
        found.sort();
        assert_eq!(found.len(), 2, "dir vpk + loose vpk, no numbered part: {found:?}");
        assert!(found[0].ends_with("pak01_dir.vpk"));
        assert!(found[1].ends_with("loose.vpk"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
