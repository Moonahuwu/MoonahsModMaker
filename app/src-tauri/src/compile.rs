//! The one-button compile pipeline.
//!
//! Per the confirmed CSDK invocation, audio compiles DIRECTLY (mp3/wav ->
//! `.vsnd_c`) via `resourcecompiler -i <src> -game <gameDir> -f`, run from the
//! compiler's bin dir, with output mirroring the content path under the game
//! root. The events file is merged with kv3-core (owned entries only), backed
//! up, written into the game tree, compiled, then everything is staged and
//! optionally packed into a VPK.
//!
//! `skipCompile` lets the merge/backup/stage/pack path run without a working
//! resourcecompiler (used in tests and while the toolchain is being matched).

use crate::vpk;
use kv3_core::EventMerge;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongCompile {
    pub sound_name: String,
    pub source_audio: String,
    pub trim_start: f64,
    pub trim_end: f64,
    pub gain_db: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub looping: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCompile {
    pub event_name: String,
    #[serde(default = "default_array_key")]
    pub array_key: String,
    pub stock_entry: String,
    /// "auto" or "manual"
    pub duration_mode: String,
    #[serde(default)]
    pub duration_manual: Option<f64>,
    #[serde(default)]
    pub previous_owned: Vec<String>,
    /// Stock/foreign reference strings the user disabled (dropped from output).
    #[serde(default)]
    pub excluded: Vec<String>,
    /// Which soundevent file this slot's event lives in (relative).
    #[serde(default = "default_events_relpath")]
    pub events_relpath: String,
    /// Entries adopted from other mods (kept at original quality): their refs go
    /// into the array and their `.vsnd_c` is extracted from `source_vpk`.
    #[serde(default)]
    pub adopted: Vec<AdoptedRef>,
    pub songs: Vec<SongCompile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedRef {
    pub reference: String,
    pub source_vpk: String,
}

fn default_events_relpath() -> String {
    "soundevents/music.vsndevts".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileConfig {
    /// Addon CONTENT root where sources are written, e.g.
    /// `<csdk>/content/citadel_addons/<addon>`.
    pub content_root: String,
    /// Addon GAME root where resourcecompiler emits `_c` files (derived from the
    /// content path), e.g. `<csdk>/game/citadel_addons/<addon>`. Used to locate
    /// compiled outputs for staging.
    pub compiled_root: String,
    /// The `-game` argument: directory containing `gameinfo.gi` (the base mod),
    /// e.g. `<csdk>/game/citadel`. NOTE: distinct from `compiled_root`.
    pub game_info_dir: String,
    pub sound_folder: String,
    pub resource_compiler: String,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub vpk_helper_path: Option<String>,
    /// Root dir containing the live vanilla/community `soundevents/` tree to read
    /// & merge into (has all other mods' entries). Each slot's events file is
    /// `<vanilla_root>/<events_relpath>`.
    pub vanilla_root: String,
    pub output_dir: String,
    /// "folder" or "vpk"
    pub output_mode: String,
    #[serde(default = "default_vpk_name")]
    pub vpk_name: String,
    /// Write a `sounds/encoding.txt` (mp3 compress) into the content tree so the
    /// compiled audio is compressed like the community templates.
    #[serde(default = "default_true")]
    pub write_encoding_txt: bool,
    #[serde(default)]
    pub skip_compile: bool,
    /// Other mods' `pak01_dir.vpk` paths to merge in (their sounds + soundevents
    /// are unioned with ours; nothing of ours is removed).
    #[serde(default)]
    pub imported_mods: Vec<String>,
    pub events: Vec<EventCompile>,
}

fn default_true() -> bool {
    true
}

const ENCODING_HEADER: &str = "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n";

/// Build `encoding.txt`: an mp3 `compress` block plus a `loop` block per song
/// that should loop (required for `_lp` tracks to actually loop in-game).
fn build_encoding_txt(events: &[EventCompile]) -> String {
    let mut s = String::from(ENCODING_HEADER);
    s.push_str("{\n\tcompress = \n\t{\n\t\tformat = \"mp3\"\n\t\tminbitrate = 128\n\t\tmaxbitrate = 320\n\t\tvbr = 1\n\t}\n");

    let mut files = String::new();
    for ev in events {
        for song in &ev.songs {
            if song.looping {
                let dur = (song.trim_end - song.trim_start).max(0.01);
                files.push_str(&format!(
                    "\t\t{{ fileName = \"{}.wav\" loop = {{ loop_start_time = 0.0 loop_end_time = {:.6} }} }},\n",
                    song.sound_name, dur,
                ));
            }
        }
    }
    if !files.is_empty() {
        s.push_str("\tfiles = \n\t[\n");
        s.push_str(&files);
        s.push_str("\t]\n");
    }
    s.push_str("}\n");
    s
}

fn default_vpk_name() -> String {
    "pak01_dir.vpk".to_string()
}

fn default_array_key() -> String {
    "vsnd_files".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    pub ok: bool,
    pub steps: Vec<StepResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
}

impl CompileReport {
    fn new() -> Self {
        CompileReport { ok: true, steps: vec![], output_path: None }
    }
    fn ok_step(&mut self, name: impl Into<String>, detail: impl Into<String>) {
        self.steps.push(StepResult { name: name.into(), ok: true, detail: detail.into() });
    }
    /// Record a failure and return Err to short-circuit the pipeline.
    fn fail(&mut self, name: impl Into<String>, detail: impl Into<String>) -> Result<(), ()> {
        self.ok = false;
        self.steps.push(StepResult { name: name.into(), ok: false, detail: detail.into() });
        Err(())
    }
}

/// content-relative path for a song's compiled file, e.g.
/// `sounds/music/match_intro/mysong.vsnd_c`.
fn vsnd_c_relpath(sound_folder: &str, sound_name: &str) -> String {
    format!("{}/{}.vsnd_c", sound_folder.trim_matches('/'), sound_name)
}

/// The `.vsnd` reference string written into the array.
fn vsnd_ref(sound_folder: &str, sound_name: &str) -> String {
    format!("{}/{}.vsnd", sound_folder.trim_matches('/'), sound_name)
}

fn events_c_relpath(events_game_relpath: &str) -> String {
    format!("{}_c", events_game_relpath.trim_matches('/'))
}

/// Build the kv3-core merge for one event, and the new auto/manual duration.
fn event_merge(ev: &EventCompile, sound_folder: &str, current_duration: Option<f64>) -> EventMerge {
    let mut owned_in_order: Vec<String> = ev
        .songs
        .iter()
        .map(|s| vsnd_ref(sound_folder, &s.sound_name))
        .collect();
    // Adopted entries (from other mods) are also "ours" — include their refs.
    owned_in_order.extend(ev.adopted.iter().map(|a| a.reference.clone()));

    // vsnd_duration is per-event (shared by all its arrays), so only the primary
    // `vsnd_files` slot manages it — secondary arrays (e.g. opponent control)
    // never rewrite it, avoiding two slots fighting over one value.
    let new_duration = if ev.array_key != "vsnd_files" {
        None
    } else if ev.duration_mode == "manual" {
        ev.duration_manual
    } else {
        // auto: cover the longest of our trimmed clips, but never shrink below
        // the file's existing duration (we can't measure foreign clips).
        let our_max = ev
            .songs
            .iter()
            .map(|s| (s.trim_end - s.trim_start).max(0.0))
            .fold(0.0_f64, f64::max);
        Some(current_duration.unwrap_or(0.0).max(our_max))
    };

    EventMerge {
        event_name: ev.event_name.clone(),
        array_key: ev.array_key.clone(),
        stock_entry: ev.stock_entry.clone(),
        owned_in_order,
        previous_owned: ev.previous_owned.clone(),
        new_duration,
        excluded: ev.excluded.clone(),
    }
}

fn run_resource_compiler(cfg: &CompileConfig, input_abs: &str) -> Result<String, String> {
    let exe = Path::new(&cfg.resource_compiler);
    let mut cmd = Command::new(exe);
    if let Some(dir) = exe.parent() {
        if !dir.as_os_str().is_empty() {
            cmd.current_dir(dir); // binlaunch needs to run from the bin dir
        }
    }
    // `-danger_mode_ignore_schema_mismatches` is required for headless compiles
    // against a CSDK whose tool DLLs differ from the live game build (a benign
    // particle-schema mismatch that otherwise aborts). This is how the community
    // tools (e.g. DeadPacker) drive resourcecompiler.
    cmd.args([
        "-i",
        input_abs,
        "-game",
        &cfg.game_info_dir,
        "-f",
        "-danger_mode_ignore_schema_mismatches",
    ]);
    let out = cmd
        .output()
        .map_err(|e| format!("launching resourcecompiler: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        Ok(stdout.lines().rev().take(3).collect::<Vec<_>>().join(" | "))
    } else {
        Err(format!(
            "resourcecompiler exit {}: {}",
            out.status.code().unwrap_or(-1),
            // Prefer the most informative tail.
            [stderr.trim(), stdout.trim()]
                .iter()
                .filter(|s| !s.is_empty())
                .next()
                .copied()
                .unwrap_or("(no output)")
        ))
    }
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn copy_into(src: &Path, dest_root: &Path, relpath: &str) -> std::io::Result<PathBuf> {
    let dest = dest_root.join(relpath);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// Run the full pipeline. Returns a per-step report (never panics; failures are
/// recorded and stop subsequent steps).
pub fn run(cfg: &CompileConfig) -> CompileReport {
    let mut report = CompileReport::new();
    if internal_run(cfg, &mut report).is_err() {
        report.ok = false;
    }
    report
}

fn internal_run(cfg: &CompileConfig, report: &mut CompileReport) -> Result<(), ()> {
    let content_root = Path::new(&cfg.content_root);
    let compiled_root = Path::new(&cfg.compiled_root);
    let ffmpeg = cfg.ffmpeg_path.as_deref();

    // 0. Write encoding.txt alongside the source wavs (same folder) so the
    //    compiler picks up mp3 compression AND per-file loop points (_lp tracks).
    if cfg.write_encoding_txt {
        let enc = content_root
            .join(cfg.sound_folder.trim_matches('/'))
            .join("encoding.txt");
        if let Some(parent) = enc.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&enc, build_encoding_txt(&cfg.events)) {
            return report.fail("write encoding.txt", e.to_string());
        }
        report.ok_step("write encoding.txt", enc.to_string_lossy().into_owned());
    }

    // 1+2. Per song: ffmpeg -> content/<folder>/<name>.wav, then compile -> vsnd_c.
    for ev in &cfg.events {
        for song in &ev.songs {
            let content_audio = content_root
                .join(cfg.sound_folder.trim_matches('/'))
                .join(format!("{}.wav", song.sound_name));
            if let Some(parent) = content_audio.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return report.fail("prepare content dir", e.to_string());
                }
            }
            let audio_path = content_audio.to_string_lossy().into_owned();

            if let Err(e) = crate::audio::render_to(
                ffmpeg,
                &song.source_audio,
                song.trim_start,
                song.trim_end,
                song.gain_db,
                song.fade_in,
                song.fade_out,
                &audio_path,
            ) {
                return report.fail(format!("ffmpeg: {}", song.sound_name), e);
            }
            report.ok_step(format!("ffmpeg: {}", song.sound_name), audio_path.clone());

            if cfg.skip_compile {
                report.ok_step(format!("compile (skipped): {}", song.sound_name), "skipCompile");
                continue;
            }
            match run_resource_compiler(cfg, &audio_path) {
                Ok(detail) => report.ok_step(format!("compile: {}", song.sound_name), detail),
                Err(e) => return report.fail(format!("compile: {}", song.sound_name), e),
            }
        }
    }

    // Group our slots by their events file.
    use std::collections::{BTreeMap, BTreeSet};
    let mut by_file: BTreeMap<&str, Vec<&EventCompile>> = BTreeMap::new();
    for ev in &cfg.events {
        by_file.entry(ev.events_relpath.as_str()).or_default().push(ev);
    }
    let output_dir = Path::new(&cfg.output_dir);
    let helper_opt = cfg.vpk_helper_path.as_deref().filter(|h| !h.is_empty());

    // 3. Read imported mods' soundevents (decompiled) once, keyed by relpath.
    let mut imported_texts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if !cfg.imported_mods.is_empty() {
        let helper = match helper_opt {
            Some(h) => h,
            None => return report.fail("import mods", "vpkHelperPath not set"),
        };
        let tmp_dir = std::env::temp_dir().join("deadlock-intro-tool").join("import");
        let _ = std::fs::create_dir_all(&tmp_dir);
        for (mi, mod_vpk) in cfg.imported_mods.iter().enumerate() {
            let files = vpk::list(helper, mod_vpk, Some("soundevents/")).unwrap_or_default();
            for f in files.iter().filter(|f| f.ends_with(".vsndevts_c")) {
                let relpath = f.trim_end_matches("_c").to_string();
                let tmp = tmp_dir.join(format!("m{mi}_{}", f.replace('/', "_")));
                if vpk::decompile_from_vpk(helper, mod_vpk, f, &tmp.to_string_lossy()).is_ok() {
                    if let Ok(text) = std::fs::read_to_string(&tmp) {
                        imported_texts.entry(relpath).or_default().push(text);
                    }
                }
            }
        }
        report.ok_step("read imported mods", format!("{} mod(s)", cfg.imported_mods.len()));
    }

    // 4. Produce variants in their own folders under output_dir:
    //    - "mine"     = your tracks only (a clean backup of just your mod)
    //    - "combined" = yours + the imported mods (only when mods are imported)
    struct Variant {
        name: &'static str,
        with_imported: bool,
    }
    let mut variants = vec![Variant { name: "mine", with_imported: false }];
    if !cfg.imported_mods.is_empty() {
        variants.push(Variant { name: "combined", with_imported: true });
    }

    for v in &variants {
        let stage = output_dir.join(v.name).join("_staging");
        let _ = std::fs::remove_dir_all(&stage);
        if let Err(e) = std::fs::create_dir_all(&stage) {
            return report.fail("prepare staging", e.to_string());
        }
        let mut staged = 0;
        let mut events_c_rels: Vec<String> = Vec::new();

        // Imported audio goes only into the combined variant.
        if v.with_imported {
            if let Some(helper) = helper_opt {
                for mod_vpk in &cfg.imported_mods {
                    let _ = vpk::extract_all(helper, mod_vpk, &stage.to_string_lossy(), Some("sounds/"));
                }
            }
        }

        let mut relpaths: BTreeSet<String> = by_file.keys().map(|s| s.to_string()).collect();
        if v.with_imported {
            for k in imported_texts.keys() {
                relpaths.insert(k.clone());
            }
        }

        for relpath in &relpaths {
            let rel = relpath.trim_matches('/');
            let vanilla = Path::new(&cfg.vanilla_root).join(rel);
            let mod_texts = if v.with_imported { imported_texts.get(rel) } else { None };

            let (mut text, additions): (String, &[String]) = if vanilla.exists() {
                match std::fs::read_to_string(&vanilla) {
                    Ok(t) => (t, mod_texts.map(|v| v.as_slice()).unwrap_or(&[])),
                    Err(e) => return report.fail(format!("read {rel}"), e.to_string()),
                }
            } else if let Some(mt) = mod_texts {
                (mt[0].clone(), &mt[1..])
            } else {
                return report.fail(format!("read {rel}"), "no vanilla base or imported source");
            };

            let mut added = 0;
            for mt in additions {
                if let Ok(arrays) = kv3_core::list_arrays(mt) {
                    for a in arrays {
                        if let Ok(t) =
                            kv3_core::add_entries(&text, &a.event_name, &a.array_key, &a.entries)
                        {
                            text = t;
                            added += 1;
                        }
                    }
                }
            }
            if v.with_imported && !additions.is_empty() {
                report.ok_step(format!("[{}] combine {rel}", v.name), format!("{added} array(s)"));
            }

            if let Some(slots) = by_file.get(rel) {
                let merges: Vec<EventMerge> = slots
                    .iter()
                    .map(|ev| {
                        let current =
                            kv3_core::read_event_array(&text, &ev.event_name, &ev.array_key)
                                .ok()
                                .and_then(|x| x.vsnd_duration);
                        event_merge(ev, &cfg.sound_folder, current)
                    })
                    .collect();
                match kv3_core::apply_merges(&text, &merges) {
                    Ok(t) => {
                        text = t;
                        report.ok_step(
                            format!("[{}] merge {rel}", v.name),
                            format!("{} slot(s)", merges.len()),
                        );
                    }
                    Err(e) => return report.fail(format!("[{}] merge {rel}", v.name), e.to_string()),
                }
            }

            let events_dest = content_root.join(rel);
            if let Some(parent) = events_dest.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return report.fail("prepare events dir", e.to_string());
                }
            }
            if events_dest.exists() {
                if let Some(parent) = events_dest.parent() {
                    let bak_dir = parent.join(".bak");
                    let _ = std::fs::create_dir_all(&bak_dir);
                    let stem = events_dest
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "events".into());
                    let bak = bak_dir.join(format!("{stem}.{}.bak", timestamp()));
                    let _ = std::fs::copy(&events_dest, &bak);
                }
            }
            if let Err(e) = std::fs::write(&events_dest, &text) {
                return report.fail(format!("write {rel}"), e.to_string());
            }
            if !cfg.skip_compile {
                match run_resource_compiler(cfg, &events_dest.to_string_lossy()) {
                    Ok(detail) => report.ok_step(format!("[{}] compile {rel}", v.name), detail),
                    Err(e) => return report.fail(format!("[{}] compile {rel}", v.name), e),
                }
            }
            events_c_rels.push(events_c_relpath(rel));
        }

        // Stage our song .vsnd_c + each events .vsndevts_c into this variant.
        for ev in &cfg.events {
            for song in &ev.songs {
                let rel = vsnd_c_relpath(&cfg.sound_folder, &song.sound_name);
                let src = compiled_root.join(&rel);
                if cfg.skip_compile && !src.exists() {
                    continue;
                }
                match copy_into(&src, &stage, &rel) {
                    Ok(_) => staged += 1,
                    Err(e) => return report.fail(format!("stage: {rel}"), e.to_string()),
                }
            }
            // Adopted entries: extract their compiled .vsnd_c from the source mod.
            for a in &ev.adopted {
                if ev.excluded.contains(&a.reference) {
                    continue;
                }
                let internal = a
                    .reference
                    .strip_suffix(".vsnd")
                    .map(|s| format!("{s}.vsnd_c"))
                    .unwrap_or_else(|| a.reference.clone());
                let dest = stage.join(&internal);
                if let Some(helper) = helper_opt {
                    match vpk::extract(helper, &a.source_vpk, &internal, &dest.to_string_lossy()) {
                        Ok(_) => staged += 1,
                        Err(e) => {
                            report.ok_step(format!("adopt {internal} (skipped)"), e);
                        }
                    }
                }
            }
        }
        for rel in &events_c_rels {
            let src = compiled_root.join(rel);
            if src.exists() {
                match copy_into(&src, &stage, rel) {
                    Ok(_) => staged += 1,
                    Err(e) => return report.fail(format!("stage: {rel}"), e.to_string()),
                }
            }
        }
        report.ok_step(format!("[{}] stage", v.name), format!("{staged} file(s)"));

        if cfg.output_mode == "vpk" {
            let helper = match helper_opt {
                Some(h) => h,
                None => return report.fail("pack vpk", "vpkHelperPath not set"),
            };
            let out_vpk = output_dir.join(v.name).join(&cfg.vpk_name);
            match vpk::pack(helper, &stage.to_string_lossy(), &out_vpk.to_string_lossy()) {
                Ok(detail) => report.ok_step(format!("[{}] pack vpk", v.name), detail),
                Err(e) => return report.fail(format!("[{}] pack vpk", v.name), e),
            }
        }
    }

    // Report the output dir (contains mine/ and, if combined, combined/).
    report.output_path = Some(output_dir.to_string_lossy().into_owned());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_duration_never_shrinks_below_current() {
        let ev = EventCompile {
            event_name: "E".into(),
            array_key: "vsnd_files".into(),
            stock_entry: "a/stock.vsnd".into(),
            duration_mode: "auto".into(),
            duration_manual: None,
            previous_owned: vec![],
            excluded: vec![],
            events_relpath: "soundevents/music.vsndevts".into(),
            adopted: vec![],
            songs: vec![SongCompile {
                sound_name: "x".into(),
                source_audio: "x.mp3".into(),
                trim_start: 0.0,
                trim_end: 10.0,
                gain_db: 0.0,
                fade_in: 0.0,
                fade_out: 0.0,
                looping: false,
            }],
        };
        // current 27 -> stays 27 (our clip is shorter)
        let m = event_merge(&ev, "sounds/music/match_intro", Some(27.0));
        assert_eq!(m.new_duration, Some(27.0));
        assert_eq!(m.owned_in_order, vec!["sounds/music/match_intro/x.vsnd"]);
    }

    #[test]
    fn manual_duration_used_verbatim() {
        let ev = EventCompile {
            event_name: "E".into(),
            array_key: "vsnd_files".into(),
            stock_entry: "a/stock.vsnd".into(),
            duration_mode: "manual".into(),
            duration_manual: Some(42.5),
            previous_owned: vec![],
            excluded: vec![],
            events_relpath: "soundevents/music.vsndevts".into(),
            adopted: vec![],
            songs: vec![],
        };
        let m = event_merge(&ev, "sounds/music/match_intro", Some(27.0));
        assert_eq!(m.new_duration, Some(42.5));
    }

    /// Full end-to-end pipeline against the local CSDK + ffmpeg + ValvePak.
    /// Ignored by default (needs the machine-specific toolchain). Run with:
    ///   cargo test -p app --lib -- --ignored e2e_real_compile_to_vpk --nocapture
    #[test]
    #[ignore]
    fn e2e_real_compile_to_vpk() {
        let csdk = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let addon = "eim_e2e_addon";
        let content_root = format!(r"{csdk}\content\citadel_addons\{addon}");
        let compiled_root = format!(r"{csdk}\game\citadel_addons\{addon}");
        let out = std::env::temp_dir().join("eim_e2e_out");
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);

        let cfg = CompileConfig {
            content_root: content_root.clone(),
            compiled_root: compiled_root.clone(),
            game_info_dir: format!(r"{csdk}\game\citadel"),
            sound_folder: "sounds/music/match_intro".into(),
            resource_compiler: format!(r"{csdk}\game\bin_tools\win64\resourcecompiler.exe"),
            ffmpeg_path: None,
            vpk_helper_path: Some(
                r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\bin\Release\net10.0\vpk-helper.dll".into(),
            ),
            vanilla_root:
                r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\ModFiles".into(),
            output_dir: out.to_string_lossy().into_owned(),
            output_mode: "vpk".into(),
            vpk_name: "pak01_dir.vpk".into(),
            write_encoding_txt: true,
            skip_compile: false,
            imported_mods: vec![],
            events: vec![EventCompile {
                event_name: "Music.MatchIntro.MatchStart.King".into(),
                array_key: "vsnd_files".into(),
                stock_entry: "sounds/music/match_intro/music_match_intro_king_160bpm.vsnd".into(),
                duration_mode: "auto".into(),
                duration_manual: None,
                previous_owned: vec![],
                excluded: vec![],
                events_relpath: "soundevents/music.vsndevts".into(),
                adopted: vec![],
                songs: vec![SongCompile {
                    sound_name: "eim_e2e".into(),
                    source_audio: format!(r"{csdk}\content\citadel\wunderwaffe\wunderwaffeshoot1.mp3"),
                    trim_start: 0.0,
                    trim_end: 2.0,
                    gain_db: 6.0,
                    fade_in: 0.0,
                    fade_out: 1.0,
                    looping: true,
                }],
            }],
        };

        let report = run(&cfg);
        for s in &report.steps {
            println!("[{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }

        // Assertions
        assert!(report.ok, "pipeline failed");
        let vpk = out.join("mine").join("pak01_dir.vpk");
        assert!(vpk.exists(), "vpk not produced");
        let vsnd_c = compiled_root_path(&cfg).join("sounds/music/match_intro/eim_e2e.vsnd_c");
        assert!(vsnd_c.exists(), "vsnd_c not produced");
        let events_c = compiled_root_path(&cfg).join("soundevents/music.vsndevts_c");
        assert!(events_c.exists(), "vsndevts_c not produced");
        let merged = std::fs::read_to_string(
            Path::new(&cfg.content_root).join("soundevents/music.vsndevts"),
        )
        .unwrap();
        assert!(merged.contains("sounds/music/match_intro/eim_e2e.vsnd"));

        // Cleanup test artifacts (whole addon dirs + temp).
        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);
        let _ = std::fs::remove_dir_all(&out);
    }

    fn compiled_root_path(cfg: &CompileConfig) -> std::path::PathBuf {
        std::path::PathBuf::from(&cfg.compiled_root)
    }

    #[test]
    fn relpaths_use_vsnd_c_and_forward_slashes() {
        assert_eq!(
            vsnd_c_relpath("sounds/music/match_intro", "song"),
            "sounds/music/match_intro/song.vsnd_c"
        );
        assert_eq!(events_c_relpath("soundevents/music.vsndevts"), "soundevents/music.vsndevts_c");
    }
}
