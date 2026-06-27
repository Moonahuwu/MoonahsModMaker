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

    // 1. Decode every hero card portrait (one pass), keyed by portrait code.
    let have_pngs = std::fs::read_dir(&dir)
        .map(|r| r.flatten().any(|e| e.path().extension().is_some_and(|x| x == "png")))
        .unwrap_or(false);
    if refresh || !have_pngs {
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
        let display_name = h
            .name
            .as_deref()
            .map(prettify_words)
            .unwrap_or_else(|| prettify_words(&h.code));
        out.push(HeroPortrait {
            codename: h.code,
            display_name,
            portrait_path: png.to_string_lossy().into_owned(),
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
