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
#[tauri::command]
pub fn compile_project(config: CompileConfig) -> CompileReport {
    compile::run(&config)
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
    let mut refreshed = Vec::new();
    let mut failed = Vec::new();
    for rel in &relpaths {
        let rel_trim = rel.trim_matches('/');
        let internal = format!("{rel_trim}_c");
        let dest = dest_root.join(rel_trim);
        if let Some(parent) = dest.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                failed.push(format!("{rel}: {e}"));
                continue;
            }
        }
        match crate::vpk::decompile_from_vpk(
            &helper_path,
            &pak_path,
            &internal,
            &dest.to_string_lossy(),
        ) {
            Ok(_) => refreshed.push(rel.clone()),
            Err(e) => failed.push(format!("{rel}: {e}")),
        }
    }
    if refreshed.is_empty() && !failed.is_empty() {
        return Err(failed.join("; "));
    }
    Ok(RefreshResult {
        vanilla_root: dest_root.to_string_lossy().into_owned(),
        refreshed,
        failed,
    })
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
    let out = std::process::Command::new("reg")
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
    std::process::Command::new("ffmpeg")
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
#[tauri::command]
pub fn hero_roster(
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
    let mut cur = AbilityDef { icon_internal: None, sounds: vec![] };
    for line in vdata.lines() {
        let top_level = line.starts_with('\t') && !line.starts_with("\t\t");
        let t = line.trim();
        // Top-level block opener: `<name> =` (the `{` is on the next line).
        if top_level {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    if let Some(name) = cur_name.take() {
                        map.insert(name, std::mem::replace(&mut cur, AbilityDef { icon_internal: None, sounds: vec![] }));
                    }
                    cur_name = Some(k.to_string());
                    continue;
                }
            }
        }
        if cur_name.is_none() {
            continue;
        }
        if cur.icon_internal.is_none() && t.starts_with("m_strAbilityImage") {
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
#[tauri::command]
pub fn hero_detail(
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

    // Serve the cached per-hero detail unless a refresh was requested. The `v3`
    // marker invalidates caches built before event→file index resolution.
    let detail_cache = base.join(format!("detail_v3_{codename}.json"));
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

    let mut out = Vec::new();
    for (slot, ability) in bound {
        let def = ability_map.get(&ability);
        let icon_path = def
            .and_then(|d| d.icon_internal.as_deref())
            .map(|i| icon_dir.join(format!("{}.png", stem_of(i))))
            .filter(|p| p.exists())
            .map(|p| p.to_string_lossy().into_owned());

        // Distinct sound events (keep first label per event). Resolve each event
        // to the file that actually defines it via the index; events not in any
        // hero file (shared/global like `Player.Barrier.Activate`, or stale
        // references the file no longer defines) are dropped — they'd otherwise be
        // broken/empty slots.
        let mut seen = std::collections::HashSet::new();
        let mut sounds = Vec::new();
        if let Some(d) = def {
            for (label, event) in &d.sounds {
                let stem = match event_index.get(event) {
                    Some(s) => s,
                    None => continue,
                };
                if seen.insert(event.clone()) {
                    sounds.push(HeroAbilitySound {
                        event_name: event.clone(),
                        array_key: "vsnd_files".to_string(),
                        events_relpath: format!("soundevents/hero/{stem}.vsndevts"),
                        label: label.clone(),
                    });
                }
            }
        }
        out.push(HeroAbility { slot, ability, icon_path, sounds });
    }

    // Cache the static detail for instant subsequent opens.
    if let Ok(json) = serde_json::to_string(&out) {
        let _ = std::fs::write(&detail_cache, json);
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
