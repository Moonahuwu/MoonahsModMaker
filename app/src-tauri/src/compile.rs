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
    /// Hash of the current {source,trim,gain,fades,looping,name}. When this equals
    /// `last_compiled_hash` and the `.vsnd_c` already exists, render+compile are
    /// skipped. `None` disables the skip (always (re)compile).
    #[serde(default)]
    pub current_hash: Option<String>,
    /// Hash recorded after this song's last successful compile.
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCompile {
    pub event_name: String,
    #[serde(default = "default_array_key")]
    pub array_key: String,
    pub stock_entry: String,
    /// Where this event's tracks live in the content tree (and thus what their
    /// `.vsnd` refs start with) — each event's "respective" directory, usually
    /// derived from its stock sound. None/empty = the global `sound_folder`.
    #[serde(default)]
    pub sound_folder: Option<String>,
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
    /// The live game pak. Used to auto-decompile a missing vanilla events file
    /// (e.g. a soundevents file not pulled by an earlier refresh) on demand.
    #[serde(default)]
    pub pak_path: Option<String>,
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
    /// Per-mod files the user DESELECTED in the import review: mod vpk path →
    /// raw internal paths (e.g. `sounds/x.vsnd_c`) to drop from the combined
    /// stage after the pack's asset dirs are extracted.
    #[serde(default)]
    pub imported_mod_excludes: std::collections::HashMap<String, Vec<String>>,
    pub events: Vec<EventCompile>,
    /// Custom icon overrides: scaled + compiled to `.vtex_c` and staged so they
    /// override the game's icons.
    #[serde(default)]
    pub icon_mods: Vec<IconCompile>,
    /// Loose-file sound overrides: render + compile the user's audio to a
    /// `.vsnd_c` staged at the game's own path (no soundevent merge).
    #[serde(default)]
    pub sound_overrides: Vec<SoundOverrideCompile>,
    /// VFX recolor overrides: decompile a game particle, hue/sat-shift its colors,
    /// recompile to `.vpcf_c` and stage at the game's own path (whole-file override).
    #[serde(default)]
    pub effect_overrides: Vec<EffectCompile>,
    /// Gameplay config edits: rewrite ability property values in
    /// `scripts/abilities.vdata`, recompile to `abilities.vdata_c`, and stage it
    /// at the game's own path (whole-file override). Custom Server tab.
    #[serde(default)]
    pub vdata_overrides: Vec<VdataCompile>,
    /// Global match-wide edits: rewrite fields in `scripts/generic_data.vdata`,
    /// recompile, and stage. Custom Server → Global stats.
    #[serde(default)]
    pub global_overrides: Vec<GlobalCompile>,
    /// World-entity edits (minions/boxes/powerups): rewrite flat fields in
    /// npc_units.vdata / misc.vdata, recompile, and stage.
    #[serde(default)]
    pub world_overrides: Vec<WorldCompile>,
    /// Poster art replacements: decompile the atlas material from the pak,
    /// composite user art into pixel rects, recompile the `.vmat`, and stage
    /// the `.vmat_c` + `.vtex_c` at the vanilla paths (whole-material override).
    #[serde(default)]
    pub poster_overrides: Vec<PosterCompile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalCompile {
    /// Field name in generic_data.vdata, e.g. `m_nTier1GoldKill`.
    pub key: String,
    /// New value (bare number).
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldCompile {
    /// Source file, e.g. `scripts/npc_units.vdata`.
    pub file: String,
    /// Entity key, e.g. `trooper_normal`.
    pub entity: String,
    /// Field name, e.g. `m_nMaxHealth`.
    pub field: String,
    /// New value.
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdataCompile {
    /// Ability entity key, e.g. `ability_incendiary_projectile`.
    pub ability_key: String,
    /// Property key inside `m_mapAbilityProperties`.
    pub prop_key: String,
    /// New value (string; keeps unit suffixes like `20m`).
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOverrideCompile {
    /// The vanilla `.vsnd` path to shadow (drives output + staging paths).
    pub target_ref: String,
    pub source_audio: String,
    #[serde(default)]
    pub trim_start: f64,
    #[serde(default)]
    pub trim_end: f64,
    #[serde(default)]
    pub gain_db: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    #[serde(default)]
    pub looping: bool,
    #[serde(default)]
    pub current_hash: Option<String>,
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

impl SoundOverrideCompile {
    /// content/game-relative folder + stem the compiled file lands at, derived
    /// from `target_ref` (e.g. `sounds/vo/atlas/x.vsnd` -> `("sounds/vo/atlas", "x")`).
    fn folder_stem(&self) -> (String, String) {
        let rel = self.target_ref.trim_matches('/');
        let rel = rel.strip_suffix(".vsnd").unwrap_or(rel);
        match rel.rsplit_once('/') {
            Some((dir, stem)) => (dir.to_string(), stem.to_string()),
            None => (String::new(), rel.to_string()),
        }
    }
    /// content-relative `.vsnd_c` path (the staging + override target).
    fn vsnd_c_rel(&self) -> String {
        let (dir, stem) = self.folder_stem();
        if dir.is_empty() {
            format!("{stem}.vsnd_c")
        } else {
            format!("{dir}/{stem}.vsnd_c")
        }
    }
    fn up_to_date(&self, skip_compile: bool, compiled_exists: bool) -> bool {
        !skip_compile
            && self.current_hash.is_some()
            && self.current_hash == self.last_compiled_hash
            && compiled_exists
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectCompile {
    /// The vanilla `.vpcf` path to shadow (drives output + staging paths).
    pub target_ref: String,
    /// Hue rotation in degrees applied to every color literal (phase for animated).
    #[serde(default)]
    pub hue: f32,
    /// Saturation multiplier (1.0 = unchanged).
    #[serde(default = "default_one")]
    pub saturation: f32,
    /// "static" | "rainbow" | "pulse".
    #[serde(default = "default_static")]
    pub mode: String,
    #[serde(default)]
    pub current_hash: Option<String>,
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

fn default_one() -> f32 {
    1.0
}

fn default_static() -> String {
    "static".to_string()
}

impl EffectCompile {
    /// content-relative `.vpcf` source path (where we write the recolored source).
    fn vpcf_rel(&self) -> String {
        self.target_ref.trim_matches('/').to_string()
    }
    /// content-relative `.vpcf_c` path (the staging + override target).
    fn vpcf_c_rel(&self) -> String {
        format!("{}_c", self.vpcf_rel())
    }
    fn stem(&self) -> String {
        let r = self.vpcf_rel();
        r.rsplit('/').next().unwrap_or(&r).trim_end_matches(".vpcf").to_string()
    }
    fn up_to_date(&self, skip_compile: bool, compiled_exists: bool) -> bool {
        !skip_compile
            && self.current_hash.is_some()
            && self.current_hash == self.last_compiled_hash
            && compiled_exists
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PosterCompile {
    /// Manifest sheet id (unique per color texture), e.g. `posters_bodega_comp1`.
    pub sheet_id: String,
    /// Every `.vmat` sampling this sheet (all are decompiled + recompiled so no
    /// surface keeps the vanilla art), e.g.
    /// `["materials/overlays/posters_bodega_comp1.vmat"]`.
    pub materials: Vec<String>,
    /// Friendly label for report steps.
    pub label: String,
    /// Pixel rect inside the sheet's color texture.
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    /// Opaque fraction of the vanilla trans mask inside the rect; below ~0.98
    /// the trans texture gets the rect painted white so full-frame art isn't
    /// clipped to the old cut-out silhouette.
    #[serde(default = "default_one")]
    pub alpha_coverage: f32,
    /// Absolute path to the user's source image.
    pub source_image: String,
    /// "cover" | "contain" | "stretch".
    #[serde(default = "default_cover")]
    pub fit: String,
    #[serde(default)]
    pub current_hash: Option<String>,
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

fn default_cover() -> String {
    "cover".to_string()
}

impl PosterCompile {
    fn up_to_date(&self, skip_compile: bool, compiled_exists: bool) -> bool {
        !skip_compile
            && self.current_hash.is_some()
            && self.current_hash == self.last_compiled_hash
            && compiled_exists
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconCompile {
    /// Absolute path to the user's source PNG/JPG.
    pub source_image: String,
    /// The compiled `.vtex_c` path the game references (override target in VPK),
    /// e.g. `panorama/images/items/weapon/alchemical_fire_psd.vtex_c`.
    pub target_vtexc: String,
    pub width: u32,
    pub height: u32,
    /// Hue rotation in degrees applied during the ffmpeg scale pass (0 = none).
    #[serde(default)]
    pub hue: f32,
}

fn default_true() -> bool {
    true
}

const ENCODING_HEADER: &str = "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n";

/// Build one folder's `encoding.txt`: an mp3 `compress` block plus a `loop`
/// block per song that should loop (required for `_lp` tracks to loop in-game).
/// `songs` are the songs whose wavs land in that folder.
fn build_encoding_txt(songs: &[&SongCompile]) -> String {
    let mut s = String::from(ENCODING_HEADER);
    s.push_str("{\n\tcompress = \n\t{\n\t\tformat = \"mp3\"\n\t\tminbitrate = 128\n\t\tmaxbitrate = 320\n\t\tvbr = 1\n\t}\n");

    let mut files = String::new();
    for song in songs {
        if song.looping {
            let dur = (song.trim_end - song.trim_start).max(0.01);
            files.push_str(&format!(
                "\t\t{{ fileName = \"{}.wav\" loop = {{ loop_start_time = 0.0 loop_end_time = {:.6} }} }},\n",
                song.sound_name, dur,
            ));
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

/// Same as `build_encoding_txt` but for loose-file sound overrides (keyed by the
/// target file stem, since overrides aren't grouped into events).
fn build_override_encoding_txt(overrides: &[&SoundOverrideCompile]) -> String {
    let mut s = String::from(ENCODING_HEADER);
    s.push_str("{\n\tcompress = \n\t{\n\t\tformat = \"mp3\"\n\t\tminbitrate = 128\n\t\tmaxbitrate = 320\n\t\tvbr = 1\n\t}\n");
    let mut files = String::new();
    for ov in overrides {
        if ov.looping {
            let dur = (ov.trim_end - ov.trim_start).max(0.01);
            let stem = ov.folder_stem().1;
            files.push_str(&format!(
                "\t\t{{ fileName = \"{stem}.wav\" loop = {{ loop_start_time = 0.0 loop_end_time = {dur:.6} }} }},\n",
            ));
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
    /// Live-progress sink: every recorded step is also sent here as it happens
    /// (the command layer forwards them to the UI as `compile://progress`
    /// events). Deliberately a plain channel, NOT a tauri::AppHandle — pulling
    /// tauri's event system into this module links the whole windowing stack
    /// (comctl32 v6's TaskDialogIndirect) into the cargo TEST binary, which has
    /// no v6 manifest and then fails to even load (STATUS_ENTRYPOINT_NOT_FOUND).
    #[serde(skip)]
    pub(crate) progress: Option<std::sync::mpsc::Sender<StepResult>>,
}

impl CompileReport {
    fn new() -> Self {
        CompileReport { ok: true, steps: vec![], output_path: None, progress: None }
    }
    fn emit_last(&self) {
        if let (Some(tx), Some(step)) = (&self.progress, self.steps.last()) {
            let _ = tx.send(step.clone());
        }
    }
    fn ok_step(&mut self, name: impl Into<String>, detail: impl Into<String>) {
        self.steps.push(StepResult { name: name.into(), ok: true, detail: detail.into() });
        self.emit_last();
    }
    /// Record a failure and return Err to short-circuit the pipeline.
    fn fail(&mut self, name: impl Into<String>, detail: impl Into<String>) -> Result<(), ()> {
        self.ok = false;
        self.steps.push(StepResult { name: name.into(), ok: false, detail: detail.into() });
        self.emit_last();
        Err(())
    }
}

/// Whether a song's compile can be skipped: its params are unchanged since the
/// last successful compile AND the compiled `.vsnd_c` is still present. A `None`
/// `current_hash` (or global `skip_compile`) never qualifies.
fn is_up_to_date(song: &SongCompile, skip_compile: bool, compiled_exists: bool) -> bool {
    !skip_compile
        && song.current_hash.is_some()
        && song.current_hash == song.last_compiled_hash
        && compiled_exists
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

/// The folder an event's tracks compile into: its own `sound_folder` when set
/// (the event's "respective" directory), else the global one.
fn folder_for<'a>(cfg: &'a CompileConfig, ev: &'a EventCompile) -> &'a str {
    ev.sound_folder
        .as_deref()
        .filter(|s| !s.trim_matches('/').is_empty())
        .unwrap_or(&cfg.sound_folder)
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
    run_resource_compiler_multi(cfg, std::slice::from_ref(&input_abs.to_string()))
}

/// One resourcecompiler invocation over several inputs (repeated `-i`). Process
/// startup dominates audio compiles, so batching N files into one call is far
/// faster than N calls — verified against the real CSDK ("OK: 2 compiled").
fn run_resource_compiler_multi(cfg: &CompileConfig, inputs: &[String]) -> Result<String, String> {
    let exe = Path::new(&cfg.resource_compiler);
    let mut cmd = crate::procutil::quiet(exe);
    if let Some(dir) = exe.parent() {
        if !dir.as_os_str().is_empty() {
            cmd.current_dir(dir); // binlaunch needs to run from the bin dir
        }
    }
    // `-danger_mode_ignore_schema_mismatches` is required for headless compiles
    // against a CSDK whose tool DLLs differ from the live game build (a benign
    // particle-schema mismatch that otherwise aborts). This is how the community
    // tools (e.g. DeadPacker) drive resourcecompiler.
    for input in inputs {
        cmd.args(["-i", input]);
    }
    cmd.args([
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

/// Stable content fingerprint (FNV-1a 64) for the compile-skip stamps. Written
/// only AFTER a step succeeds, so a stamp mismatch (or absence) means the last
/// run didn't finish that step from this exact input — never skip then.
fn fingerprint(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// True when `stamp_path` holds exactly `want` (the success stamp matches).
fn stamp_matches(stamp_path: &Path, want: &str) -> bool {
    std::fs::read_to_string(stamp_path)
        .map(|s| s.trim() == want)
        .unwrap_or(false)
}

fn copy_into(src: &Path, dest_root: &Path, relpath: &str) -> std::io::Result<PathBuf> {
    let dest = dest_root.join(relpath);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, &dest)?;
    Ok(dest)
}

/// The CSS `hue-rotate(deg)` color matrix as an ffmpeg `colorchannelmixer`
/// filter, so the compiled icon matches the in-app CSS preview exactly. Uses the
/// W3C luma-preserving rotation (Rec.709 weights 0.213/0.715/0.072) — NOT ffmpeg's
/// `hue` filter, which rotates in YUV and diverges on saturated colors.
fn hue_rotate_mixer(hue_deg: f32) -> String {
    let a = hue_deg.to_radians();
    let (c, s) = (a.cos(), a.sin());
    let rr = 0.213 + c * 0.787 - s * 0.213;
    let rg = 0.715 - c * 0.715 - s * 0.715;
    let rb = 0.072 - c * 0.072 + s * 0.928;
    let gr = 0.213 - c * 0.213 + s * 0.143;
    let gg = 0.715 + c * 0.285 + s * 0.140;
    let gb = 0.072 - c * 0.072 - s * 0.283;
    let br = 0.213 - c * 0.213 - s * 0.787;
    let bg = 0.715 - c * 0.715 + s * 0.715;
    let bb = 0.072 + c * 0.928 + s * 0.072;
    // alpha row left at default (aa=1), so transparency is preserved.
    format!("colorchannelmixer=rr={rr}:rg={rg}:rb={rb}:gr={gr}:gg={gg}:gb={gb}:br={br}:bg={bg}:bb={bb}")
}

/// Scale a source image to `w`x`h` PNG via ffmpeg (preserves alpha). `hue` is a
/// rotation in degrees applied after scaling (0 = leave colors untouched).
fn render_icon(ffmpeg: Option<&str>, src: &str, w: u32, h: u32, hue: f32, out_png: &str) -> Result<(), String> {
    let exe = ffmpeg.unwrap_or("ffmpeg");
    let mut vf = format!("scale={w}:{h}:flags=lanczos");
    if hue.abs() > 0.01 {
        vf.push(',');
        vf.push_str(&hue_rotate_mixer(hue));
    }
    let out = crate::procutil::quiet(exe)
        .args([
            "-y",
            "-i",
            src,
            "-vf",
            &vf,
            "-frames:v",
            "1",
            out_png,
        ])
        .output()
        .map_err(|e| format!("launching ffmpeg: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" | "))
    }
}

// ---- Particle (VFX) recolor -------------------------------------------------

fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let (r, g, b) = (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if (max - min).abs() < 1e-6 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    (h * 60.0, s, l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> (u8, u8, u8) {
    if s.abs() < 1e-6 {
        let v = (l * 255.0).round() as u8;
        return (v, v, v);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let hk = (h / 360.0).rem_euclid(1.0);
    let t = |mut t: f32| {
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    (
        (t(hk + 1.0 / 3.0) * 255.0).round() as u8,
        (t(hk) * 255.0).round() as u8,
        (t(hk - 1.0 / 3.0) * 255.0).round() as u8,
    )
}

/// Apply a hue rotation + saturation multiply to one RGB triple.
fn recolor_rgb(r: u8, g: u8, b: u8, hue_deg: f32, sat: f32) -> (u8, u8, u8) {
    let (h, s, l) = rgb_to_hsl(r, g, b);
    hsl_to_rgb(h + hue_deg, (s * sat).clamp(0.0, 1.0), l)
}

/// A vpcf key that holds a recolorable RGB(A) color literal.
fn is_particle_color_key(key: &str) -> bool {
    key.starts_with("m_") && key.contains("Color") && !key.contains("Scale") && !key.contains("Blend")
}

/// Recolor a single `m_*Color* = [ r, g, b(, a) ]` line in place, preserving its
/// indentation, key, and bracket style. Returns None for non-color lines.
fn recolor_line(line: &str, hue: f32, sat: f32) -> Option<String> {
    let eq = line.find('=')?;
    let key = line[..eq].trim();
    if !is_particle_color_key(key) {
        return None;
    }
    let open = line[eq..].find('[')? + eq;
    let close = line.rfind(']')?;
    if close <= open {
        return None;
    }
    let nums: Vec<u32> = line[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u32>())
        .collect::<Result<_, _>>()
        .ok()?;
    if nums.len() < 3 || nums.len() > 4 || nums.iter().any(|n| *n > 255) {
        return None;
    }
    let (r, g, b) = recolor_rgb(nums[0] as u8, nums[1] as u8, nums[2] as u8, hue, sat);
    let inner = if nums.len() == 4 {
        format!(" {r}, {g}, {b}, {} ", nums[3])
    } else {
        format!(" {r}, {g}, {b} ")
    };
    Some(format!("{}[{}]{}", &line[..open], inner, &line[close + 1..]))
}

/// Build a chain of `C_OP_ColorInterpolate` operators that animate a particle's
/// color over its lifetime: `rainbow` cycles the full hue wheel, `pulse`
/// oscillates a hue's brightness. Each op fades to its target over a time window.
fn color_animation_ops(mode: &str, hue: f32, sat: f32) -> String {
    let s = sat.clamp(0.0, 1.0);
    // (r,g,b) targets for the cycle, tiled across particle age [0,1].
    let stops: Vec<(u8, u8, u8)> = if mode == "pulse" {
        let bright = hsl_to_rgb(hue, s.max(0.2), 0.6);
        let dim = hsl_to_rgb(hue, s.max(0.2), 0.12);
        vec![bright, dim, bright, dim, bright]
    } else {
        // rainbow: 6 hue steps around the wheel (+ closing the loop = 7 targets).
        (0..=6).map(|i| hsl_to_rgb(hue + i as f32 * 60.0, s.max(0.6), 0.5)).collect()
    };
    let n = stops.len();
    let mut out = String::new();
    for (i, (r, g, b)) in stops.iter().enumerate() {
        // First target snaps in fast; the rest tile the remaining lifetime.
        let (start, end) = if i == 0 {
            (0.0_f32, 0.02_f32)
        } else {
            ((i - 1) as f32 / (n - 1) as f32, i as f32 / (n - 1) as f32)
        };
        out.push_str(&format!(
            "\t\t{{\n\t\t\t_class = \"C_OP_ColorInterpolate\"\n\t\t\tm_ColorFade = [ {r}, {g}, {b}, 255 ]\n\t\t\tm_flFadeStartTime = {start}\n\t\t\tm_flFadeEndTime = {end}\n\t\t}},\n"
        ));
    }
    out
}

/// Inject color-animation operators into a vpcf's `m_Operators` array. Falls back
/// to a static recolor when the particle has no operators array to extend.
fn animate_particle_source(text: &str, mode: &str, hue: f32, sat: f32) -> String {
    let ops = color_animation_ops(mode, hue, sat);
    // Find the `m_Operators = ` key, then its opening `[` + newline, insert after.
    if let Some(k) = text.find("m_Operators") {
        if let Some(rel) = text[k..].find('[') {
            let bracket = k + rel;
            // advance past the newline following '['
            if let Some(nl) = text[bracket..].find('\n') {
                let insert_at = bracket + nl + 1;
                let mut out = String::with_capacity(text.len() + ops.len());
                out.push_str(&text[..insert_at]);
                out.push_str(&ops);
                out.push_str(&text[insert_at..]);
                return out;
            }
        }
    }
    // No operators array — animation can't be injected; recolor statically.
    recolor_particle_source(text, hue, sat)
}

/// Hue/sat-shift every color literal in a vpcf source, leaving all else intact.
fn recolor_particle_source(text: &str, hue: f32, sat: f32) -> String {
    if hue.abs() < 0.01 && (sat - 1.0).abs() < 0.01 {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let nl = line.ends_with('\n');
        let body = line.strip_suffix('\n').unwrap_or(line);
        match recolor_line(body, hue, sat) {
            Some(new) => out.push_str(&new),
            None => out.push_str(body),
        }
        if nl {
            out.push('\n');
        }
    }
    out
}

/// Decompile each VFX override's vanilla particle, hue/sat-shift its colors,
/// and recompile to a `.vpcf_c` that shadows the game's own particle.
fn compile_effect_overrides(
    cfg: &CompileConfig,
    content_root: &Path,
    compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<(), ()> {
    if cfg.effect_overrides.is_empty() {
        return Ok(());
    }
    let helper = match cfg.vpk_helper_path.as_deref() {
        Some(h) => h,
        None => return report.fail("recolor effects", "vpkHelperPath not set"),
    };
    let pak = match cfg.pak_path.as_deref() {
        Some(p) => p,
        None => return report.fail("recolor effects", "pakPath not set (needed to read the vanilla particle)"),
    };
    for ov in &cfg.effect_overrides {
        let rel = ov.vpcf_rel();
        let rel_c = ov.vpcf_c_rel();
        let stem = ov.stem();
        let compiled = compiled_root.join(&rel_c);
        if ov.up_to_date(cfg.skip_compile, compiled.exists()) {
            report.ok_step(format!("up to date: {stem}"), "unchanged — skipped");
            continue;
        }
        // Decompile the vanilla particle source into the content tree.
        let content_vpcf = content_root.join(&rel);
        if let Some(parent) = content_vpcf.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return report.fail("prepare effect dir", e.to_string());
            }
        }
        if let Err(e) =
            crate::vpk::decompile_from_vpk(helper, pak, &rel_c, &content_vpcf.to_string_lossy())
        {
            return report.fail(format!("decompile particle: {stem}"), e);
        }
        // Recolor in place.
        let text = match std::fs::read_to_string(&content_vpcf) {
            Ok(t) => t,
            Err(e) => return report.fail(format!("read particle: {stem}"), e.to_string()),
        };
        let transformed = match ov.mode.as_str() {
            "rainbow" | "pulse" => animate_particle_source(&text, &ov.mode, ov.hue, ov.saturation),
            _ => recolor_particle_source(&text, ov.hue, ov.saturation),
        };
        if let Err(e) = std::fs::write(&content_vpcf, transformed) {
            return report.fail(format!("write particle: {stem}"), e.to_string());
        }
        let detail = match ov.mode.as_str() {
            "rainbow" => "rainbow".to_string(),
            "pulse" => "pulse".to_string(),
            _ => format!("hue {:+.0}° sat {:.2}", ov.hue, ov.saturation),
        };
        report.ok_step(format!("recolor: {stem}"), detail);
        if cfg.skip_compile {
            continue;
        }
        match run_resource_compiler(cfg, &content_vpcf.to_string_lossy()) {
            Ok(detail) => report.ok_step(format!("compile (effect): {stem}"), detail),
            Err(e) => return report.fail(format!("compile (effect): {stem}"), e),
        }
    }
    Ok(())
}

// ---- Poster art replacement -------------------------------------------------

/// Parse `"Texture<Param>" "materials/....png|tga"` references out of a
/// decompiled `.vmat` (layered params like `TextureColor1` included). Returns
/// (param, content-relative path) pairs in file order.
fn vmat_texture_refs(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix("\"Texture") else { continue };
        let Some(q) = rest.find('"') else { continue };
        let param = format!("Texture{}", &rest[..q]);
        let Some(vstart) = rest[q + 1..].find('"') else { continue };
        let vrest = &rest[q + 1 + vstart + 1..];
        let Some(vend) = vrest.find('"') else { continue };
        let val = &vrest[..vend];
        if val.starts_with("materials/") {
            out.push((param, val.to_string()));
        }
    }
    out
}

/// Strip the VRF-emitted `"Compiled Textures" { ... }` block from a decompiled
/// vmat so resourcecompiler only sees source parameters.
fn strip_compiled_textures(text: &str) -> String {
    let Some(start) = text.find("\"Compiled Textures\"") else {
        return text.to_string();
    };
    let Some(open_off) = text[start..].find('{') else {
        return text.to_string();
    };
    let open = start + open_off;
    let mut depth = 0usize;
    for (i, ch) in text[open..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = open + i + 1;
                    let mut s = String::with_capacity(text.len());
                    s.push_str(text[..start].trim_end_matches([' ', '\t']));
                    s.push_str(text[end..].trim_start_matches(['\r', '\n']));
                    return s;
                }
            }
            _ => {}
        }
    }
    text.to_string()
}

/// Composite `src` into the `(x,y,w,h)` rect of `sheet_png` (in place) via
/// ffmpeg. `fit`: "cover" scale+crop (default) | "contain" letterbox over the
/// original art | "stretch".
fn composite_poster(
    ffmpeg: Option<&str>,
    sheet_png: &Path,
    src: &str,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    fit: &str,
) -> Result<(), String> {
    let exe = ffmpeg.unwrap_or("ffmpeg");
    let filter = match fit {
        "stretch" => format!("[1:v]scale={w}:{h}:flags=lanczos[a];[0:v][a]overlay={x}:{y}"),
        "contain" => format!(
            "[1:v]scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos[a];[0:v][a]overlay={x}+({w}-w)/2:{y}+({h}-h)/2"
        ),
        _ => format!(
            "[1:v]scale={w}:{h}:force_original_aspect_ratio=increase:flags=lanczos,crop={w}:{h}[a];[0:v][a]overlay={x}:{y}"
        ),
    };
    let tmp = sheet_png.with_extension("eim_tmp.png");
    let out = crate::procutil::quiet(exe)
        .args([
            "-y",
            "-i",
            &sheet_png.to_string_lossy(),
            "-i",
            src,
            "-filter_complex",
            &filter,
            "-frames:v",
            "1",
            &tmp.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("launching ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(String::from_utf8_lossy(&out.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" | "));
    }
    std::fs::rename(&tmp, sheet_png).map_err(|e| e.to_string())
}

/// Paint the rect solid white in the trans mask (in place) so full-frame
/// replacement art isn't clipped to the vanilla cut-out silhouette.
fn fill_trans_rect(
    ffmpeg: Option<&str>,
    trans_png: &Path,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let exe = ffmpeg.unwrap_or("ffmpeg");
    let tmp = trans_png.with_extension("eim_tmp.png");
    let vf = format!("drawbox=x={x}:y={y}:w={w}:h={h}:color=white@1:t=fill");
    let out = crate::procutil::quiet(exe)
        .args([
            "-y",
            "-i",
            &trans_png.to_string_lossy(),
            "-vf",
            &vf,
            "-frames:v",
            "1",
            &tmp.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("launching ffmpeg: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(String::from_utf8_lossy(&out.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" | "));
    }
    std::fs::rename(&tmp, trans_png).map_err(|e| e.to_string())
}

/// Compiled-root-relative `_c` files produced for one poster material: the
/// `.vmat_c` plus, for every source texture the vmat references, the
/// `<stem>_<ext>_<hash>.vtex_c` files the compiler emitted next to it.
fn poster_staged_rels(compiled_root: &Path, vmat_rel: &str, texture_refs: &[(String, String)]) -> Vec<String> {
    let mut rels = Vec::new();
    let vmat_c = format!("{vmat_rel}_c");
    if compiled_root.join(&vmat_c).exists() {
        rels.push(vmat_c);
    }
    for (_, tex_rel) in texture_refs {
        let (dir, file) = match tex_rel.rsplit_once('/') {
            Some((d, f)) => (d, f),
            None => ("", tex_rel.as_str()),
        };
        let (stem, ext) = match file.rsplit_once('.') {
            Some((s, e)) => (s, e),
            None => (file, ""),
        };
        let prefix = format!("{stem}_{ext}_");
        let abs_dir = compiled_root.join(dir);
        let Ok(entries) = std::fs::read_dir(&abs_dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(".vtex_c") {
                let rel = if dir.is_empty() { name } else { format!("{dir}/{name}") };
                if !rels.contains(&rel) {
                    rels.push(rel);
                }
            }
        }
    }
    rels
}

/// Composite every poster override into its atlas sheet and recompile the
/// sheet's material(s). Returns compiled-root-relative `_c` paths to stage.
fn compile_posters(
    cfg: &CompileConfig,
    content_root: &Path,
    compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<Vec<String>, ()> {
    let mut staged: Vec<String> = Vec::new();
    if cfg.poster_overrides.is_empty() {
        return Ok(staged);
    }
    let helper = match cfg.vpk_helper_path.as_deref() {
        Some(h) => h,
        None => {
            let _ = report.fail("posters", "vpkHelperPath not set");
            return Err(());
        }
    };
    let pak = match cfg.pak_path.as_deref() {
        Some(p) => p,
        None => {
            let _ = report.fail("posters", "pakPath not set (needed to read the vanilla atlas)");
            return Err(());
        }
    };
    let ffmpeg = cfg.ffmpeg_path.as_deref();

    let mut by_sheet: std::collections::BTreeMap<&str, Vec<&PosterCompile>> = Default::default();
    for ov in &cfg.poster_overrides {
        by_sheet.entry(ov.sheet_id.as_str()).or_default().push(ov);
    }

    for (sheet_id, ovs) in by_sheet {
        let materials: Vec<String> = ovs[0]
            .materials
            .iter()
            .map(|m| m.trim_matches('/').to_string())
            .collect();
        if materials.is_empty() {
            let _ = report.fail(format!("posters: {sheet_id}"), "no materials listed");
            return Err(());
        }
        let primary_rel = &materials[0];
        let primary_vmat = content_root.join(primary_rel);
        let compiled_ok = compiled_root.join(format!("{primary_rel}_c")).exists();
        // The content vmat is the staging source of truth for texture stems, so
        // its absence forces a fresh decompile even when hashes match.
        if primary_vmat.exists()
            && ovs.iter().all(|o| o.up_to_date(cfg.skip_compile, compiled_ok))
        {
            if let Ok(text) = std::fs::read_to_string(&primary_vmat) {
                for mat in &materials {
                    let refs = vmat_texture_refs(&text);
                    staged.extend(poster_staged_rels(compiled_root, mat, &refs));
                }
                report.ok_step(format!("posters up to date: {sheet_id}"), "unchanged — skipped");
                continue;
            }
        }

        // Fresh vanilla decompile of every material sampling this sheet (also
        // resets the sheet textures so removed overrides don't linger).
        for mat in &materials {
            let mat_c = format!("{mat}_c");
            if let Err(e) =
                crate::vpk::material_from_vpk(helper, pak, &mat_c, &content_root.to_string_lossy())
            {
                let _ = report.fail(format!("decompile material: {mat}"), e);
                return Err(());
            }
        }
        let text = match std::fs::read_to_string(&primary_vmat) {
            Ok(t) => t,
            Err(e) => {
                let _ = report.fail(format!("read material: {primary_rel}"), e.to_string());
                return Err(());
            }
        };
        let refs = vmat_texture_refs(&text);
        let color_rel = refs
            .iter()
            .find(|(p, _)| p.starts_with("TextureColor"))
            .map(|(_, v)| v.clone());
        let trans_rel = refs
            .iter()
            .find(|(p, _)| p.starts_with("TextureTranslucency"))
            .map(|(_, v)| v.clone());
        let Some(color_rel) = color_rel else {
            let _ = report.fail(format!("posters: {sheet_id}"), "material has no color texture");
            return Err(());
        };
        // resourcecompiler must only see source params.
        for mat in &materials {
            let p = content_root.join(mat);
            if let Ok(t) = std::fs::read_to_string(&p) {
                let _ = std::fs::write(&p, strip_compiled_textures(&t));
            }
        }

        let color_abs = content_root.join(&color_rel);
        for ov in ovs.iter() {
            if let Err(e) = composite_poster(
                ffmpeg, &color_abs, &ov.source_image, ov.x, ov.y, ov.w, ov.h, &ov.fit,
            ) {
                let _ = report.fail(format!("poster art: {}", ov.label), e);
                return Err(());
            }
            if ov.alpha_coverage < 0.98 {
                if let Some(trans) = &trans_rel {
                    let trans_abs = content_root.join(trans);
                    if trans_abs.exists() {
                        if let Err(e) = fill_trans_rect(ffmpeg, &trans_abs, ov.x, ov.y, ov.w, ov.h) {
                            let _ = report.fail(format!("poster trans: {}", ov.label), e);
                            return Err(());
                        }
                    }
                }
            }
            report.ok_step(
                format!("poster: {}", ov.label),
                format!("{}x{} at ({},{}) {}", ov.w, ov.h, ov.x, ov.y, ov.fit),
            );
        }
        if cfg.skip_compile {
            continue;
        }
        for mat in &materials {
            let p = content_root.join(mat);
            match run_resource_compiler(cfg, &p.to_string_lossy()) {
                Ok(detail) => report.ok_step(format!("compile (poster): {mat}"), detail),
                Err(e) => {
                    let _ = report.fail(format!("compile (poster): {mat}"), e);
                    return Err(());
                }
            }
            staged.extend(poster_staged_rels(compiled_root, mat, &refs));
        }
    }
    staged.sort();
    staged.dedup();
    Ok(staged)
}

/// Path inside the game tree that `abilities.vdata` compiles/stages to.
const ABILITIES_VDATA_REL: &str = "scripts/abilities.vdata";
const ABILITIES_VDATA_C_REL: &str = "scripts/abilities.vdata_c";

/// A value safe to emit UNQUOTED in vdata: a plain number. Anything with a unit
/// or other characters (e.g. `34m`, `1.5s`, `50%`) MUST be quoted or the
/// resourcecompiler rejects it ("Invalid value"). Vanilla stores unit-bearing
/// bonuses quoted already (`m_strBonus = "10m"`), so quoting matches its style.
fn is_bare_number(v: &str) -> bool {
    let v = v.trim();
    !v.is_empty()
        && v.chars().any(|c| c.is_ascii_digit())
        && v
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
}

/// Rewrite each override in the decompiled `abilities.vdata`, leaving every other
/// byte intact. A normal `prop_key` rewrites the matching `m_mapAbilityProperties`
/// `m_strValue`; a `@upgrade:N` key rewrites the Nth `m_strBonus` (T1/T2/T3 ability
/// upgrade) within that ability. Quote style is preserved for numeric values, but
/// a non-numeric value (a unit like `34m`) is always quoted so the compile
/// doesn't choke when it lands on a bare-number field (e.g. after a patch shifts
/// the layout the randomizer cached).
fn apply_vdata_overrides(text: &str, overrides: &[VdataCompile]) -> String {
    use std::collections::HashMap;
    let mut want: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
    let mut want_upg: HashMap<&str, HashMap<usize, &str>> = HashMap::new();
    // `@weapon:<field>` → rewrite a flat numeric field inside the entry's
    // `m_WeaponInfo` block (gun stats: bullet damage, clip size, cycle time…).
    let mut want_weapon: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
    // `@tier` → rewrite an item's `m_iItemTier` (`EModTier_N`). The game derives
    // shop cost from the tier, so this re-tiers and re-prices the item.
    let mut want_tier: HashMap<&str, &str> = HashMap::new();
    for ov in overrides {
        if let Some(field) = ov.prop_key.strip_prefix("@weapon:") {
            want_weapon.entry(ov.ability_key.as_str()).or_default().insert(field, ov.value.as_str());
        } else if ov.prop_key == "@tier" {
            want_tier.insert(ov.ability_key.as_str(), ov.value.as_str());
        } else if let Some(idx) = ov.prop_key.strip_prefix("@upgrade:").and_then(|s| s.parse::<usize>().ok()) {
            want_upg.entry(ov.ability_key.as_str()).or_default().insert(idx, ov.value.as_str());
        } else {
            want.entry(ov.ability_key.as_str()).or_default().insert(ov.prop_key.as_str(), ov.value.as_str());
        }
    }
    let mut out = String::with_capacity(text.len() + 64);
    let mut in_wanted = false;
    let mut in_wanted_upg = false;
    let mut in_wanted_weapon = false;
    let mut in_wanted_tier = false;
    let mut weapon_info_depth: Option<usize> = None; // depth of the m_WeaponInfo block
    let mut cur_ability: Option<&str> = None;
    let mut props_depth: Option<usize> = None;
    let mut pending: Option<&str> = None; // value to write at the next m_strValue
    let mut bonus_idx: usize = 0; // m_strBonus occurrence counter within the ability
    for line in text.split_inclusive('\n') {
        let nl = line.ends_with('\n');
        let body = line.strip_suffix('\n').unwrap_or(line);
        let depth = body.chars().take_while(|&c| c == '\t').count();
        let t = body.trim();
        let top_level = body.starts_with('\t') && !body.starts_with("\t\t");

        // Top-level ability block opener resets all per-block state.
        if top_level {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur_ability = Some(k);
                    in_wanted = want.contains_key(k);
                    in_wanted_upg = want_upg.contains_key(k);
                    in_wanted_weapon = want_weapon.contains_key(k);
                    in_wanted_tier = want_tier.contains_key(k);
                    props_depth = None;
                    weapon_info_depth = None;
                    pending = None;
                    bonus_idx = 0;
                    out.push_str(line);
                    continue;
                }
            }
        }

        // Rewrite a base property value when one is pending.
        if pending.is_some() && t.starts_with("m_strValue") {
            if let (Some(a), Some(b)) = (body.find('"'), body.rfind('"')) {
                if b > a {
                    out.push_str(&body[..=a]);
                    out.push_str(pending.unwrap());
                    out.push_str(&body[b..]);
                    if nl {
                        out.push('\n');
                    }
                    pending = None;
                    continue;
                }
            }
        }

        // Rewrite an upgrade bonus by occurrence index (preserve quote style).
        if in_wanted_upg && t.starts_with("m_strBonus") {
            let this = bonus_idx;
            bonus_idx += 1;
            if let Some(v) = cur_ability.and_then(|a| want_upg.get(a)).and_then(|m| m.get(&this)) {
                if let Some(eq) = body.find(" = ") {
                    // Quote if the original was quoted OR the value isn't a plain
                    // number (a unit like `34m` must be quoted to be valid).
                    let quoted = body[eq + 3..].trim_start().starts_with('"') || !is_bare_number(v);
                    out.push_str(&body[..eq + 3]);
                    if quoted {
                        out.push('"');
                        out.push_str(v);
                        out.push('"');
                    } else {
                        out.push_str(v);
                    }
                    if nl {
                        out.push('\n');
                    }
                    continue;
                }
            }
        }

        // Rewrite a weapon-info field (gun stats) — flat `field = value` at one
        // level inside the entry's m_WeaponInfo block, preserving quote style.
        if in_wanted_weapon {
            if let Some(wd) = weapon_info_depth {
                if depth <= wd && t == "}" {
                    weapon_info_depth = None;
                } else if depth == wd + 1 {
                    if let Some(eq) = t.find(" = ") {
                        let field = &t[..eq];
                        if let Some(v) = cur_ability.and_then(|a| want_weapon.get(a)).and_then(|m| m.get(field)) {
                            if let Some(beq) = body.find(" = ") {
                                let quoted = body[beq + 3..].trim_start().starts_with('"') || !is_bare_number(v);
                                out.push_str(&body[..beq + 3]);
                                if quoted {
                                    out.push('"');
                                    out.push_str(v);
                                    out.push('"');
                                } else {
                                    out.push_str(v);
                                }
                                if nl {
                                    out.push('\n');
                                }
                                continue;
                            }
                        }
                    }
                }
            } else if t.starts_with("m_WeaponInfo") && t.ends_with('=') {
                weapon_info_depth = Some(depth);
            }
        }

        // Rewrite an item's tier token (`m_iItemTier = "EModTier_N"`) in place,
        // preserving the quotes. A direct field of the item block (not nested).
        if in_wanted_tier && t.starts_with("m_iItemTier") {
            if let (Some(a), Some(b)) = (body.find('"'), body.rfind('"')) {
                if b > a {
                    if let Some(v) = cur_ability.and_then(|c| want_tier.get(c)) {
                        out.push_str(&body[..=a]);
                        out.push_str(v);
                        out.push_str(&body[b..]);
                        if nl {
                            out.push('\n');
                        }
                        continue;
                    }
                }
            }
        }

        if in_wanted {
            if let Some(pd) = props_depth {
                if depth <= pd && t == "}" {
                    props_depth = None;
                    pending = None;
                } else if depth == pd + 1 {
                    if let Some(k) = t.strip_suffix('=').map(str::trim) {
                        if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                            pending = cur_ability
                                .and_then(|a| want.get(a))
                                .and_then(|m| m.get(k))
                                .copied();
                        }
                    }
                }
            } else if t.starts_with("m_mapAbilityProperties") && t.ends_with('=') {
                props_depth = Some(depth);
            }
        }
        out.push_str(line);
    }
    out
}

/// Drop the top-level `_include = [ … ]` array. The decompiled file already
/// inlines the resolved data, so the includes are redundant — and the
/// resourcecompiler aborts on the missing `.vdata_inc` source files if they
/// remain. (See the vdata spike: stripping this is what makes the recompile work.)
fn strip_vdata_includes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut skipping = false;
    for line in text.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let depth = body.chars().take_while(|&c| c == '\t').count();
        let t = body.trim();
        if skipping {
            if depth == 1 && t == "]" {
                skipping = false;
            }
            continue; // drop every line of the include block, brackets included
        }
        if depth == 1 && t == "_include =" {
            skipping = true;
            continue;
        }
        out.push_str(line);
    }
    out
}

/// Apply all gameplay-config edits: decompile the vanilla `abilities.vdata`,
/// rewrite the edited property values, strip `_include`, and recompile to
/// `abilities.vdata_c`. Returns Ok(()) (the produced `_c` is staged in the
/// per-variant loop, like icons/effects).
fn compile_vdata_overrides(
    cfg: &CompileConfig,
    content_root: &Path,
    _compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<(), ()> {
    if cfg.vdata_overrides.is_empty() {
        return Ok(());
    }
    let helper = match cfg.vpk_helper_path.as_deref() {
        Some(h) => h,
        None => return report.fail("config edits", "vpkHelperPath not set"),
    };
    let pak = match cfg.pak_path.as_deref() {
        Some(p) => p,
        None => return report.fail("config edits", "pakPath not set (needed to read vanilla abilities.vdata)"),
    };
    let content_vdata = content_root.join(ABILITIES_VDATA_REL);
    if let Some(parent) = content_vdata.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return report.fail("prepare config dir", e.to_string());
        }
    }
    if let Err(e) =
        crate::vpk::decompile_from_vpk(helper, pak, ABILITIES_VDATA_C_REL, &content_vdata.to_string_lossy())
    {
        return report.fail("decompile abilities.vdata", e);
    }
    let text = match std::fs::read_to_string(&content_vdata) {
        Ok(t) => t,
        Err(e) => return report.fail("read abilities.vdata", e.to_string()),
    };
    let edited = apply_vdata_overrides(&text, &cfg.vdata_overrides);
    let stripped = strip_vdata_includes(&edited);
    if let Err(e) = std::fs::write(&content_vdata, stripped) {
        return report.fail("write abilities.vdata", e.to_string());
    }
    report.ok_step("config edits", format!("{} value(s)", cfg.vdata_overrides.len()));
    if cfg.skip_compile {
        return Ok(());
    }
    match run_resource_compiler(cfg, &content_vdata.to_string_lossy()) {
        Ok(detail) => report.ok_step("compile (config)", detail),
        Err(e) => return report.fail("compile (config)", e),
    }
    Ok(())
}

const GENERIC_DATA_REL: &str = "scripts/generic_data.vdata";
const GENERIC_DATA_C_REL: &str = "scripts/generic_data.vdata_c";

/// Rewrite the first `<key> = <value>` occurrence for each global override,
/// preserving indentation and every other byte.
fn apply_global_overrides(text: &str, overrides: &[GlobalCompile]) -> String {
    use std::collections::HashMap;
    let mut want: HashMap<&str, &str> = HashMap::new();
    for ov in overrides {
        want.entry(ov.key.as_str()).or_insert(ov.value.as_str());
    }
    let mut done: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let nl = line.ends_with('\n');
        let body = line.strip_suffix('\n').unwrap_or(line);
        let t = body.trim_start();
        let indent = &body[..body.len() - t.len()];
        if let Some((k, _)) = t.split_once(" = ") {
            if !done.contains(k) {
                if let Some(v) = want.get(k) {
                    out.push_str(indent);
                    out.push_str(k);
                    out.push_str(" = ");
                    out.push_str(v);
                    if nl {
                        out.push('\n');
                    }
                    done.insert(k);
                    continue;
                }
            }
        }
        out.push_str(line);
    }
    out
}

/// Decompile `generic_data.vdata`, rewrite the edited global fields, and
/// recompile to `generic_data.vdata_c` (no `_include` block in this file).
fn compile_global_overrides(
    cfg: &CompileConfig,
    content_root: &Path,
    _compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<(), ()> {
    if cfg.global_overrides.is_empty() {
        return Ok(());
    }
    let helper = match cfg.vpk_helper_path.as_deref() {
        Some(h) => h,
        None => return report.fail("global stats", "vpkHelperPath not set"),
    };
    let pak = match cfg.pak_path.as_deref() {
        Some(p) => p,
        None => return report.fail("global stats", "pakPath not set (needed to read vanilla generic_data.vdata)"),
    };
    let content_gd = content_root.join(GENERIC_DATA_REL);
    if let Some(parent) = content_gd.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return report.fail("prepare global dir", e.to_string());
        }
    }
    if let Err(e) =
        crate::vpk::decompile_from_vpk(helper, pak, GENERIC_DATA_C_REL, &content_gd.to_string_lossy())
    {
        return report.fail("decompile generic_data.vdata", e);
    }
    let text = match std::fs::read_to_string(&content_gd) {
        Ok(t) => t,
        Err(e) => return report.fail("read generic_data.vdata", e.to_string()),
    };
    let edited = apply_global_overrides(&text, &cfg.global_overrides);
    if let Err(e) = std::fs::write(&content_gd, edited) {
        return report.fail("write generic_data.vdata", e.to_string());
    }
    report.ok_step("global stats", format!("{} value(s)", cfg.global_overrides.len()));
    if cfg.skip_compile {
        return Ok(());
    }
    match run_resource_compiler(cfg, &content_gd.to_string_lossy()) {
        Ok(detail) => report.ok_step("compile (global)", detail),
        Err(e) => return report.fail("compile (global)", e),
    }
    Ok(())
}

/// Rewrite each `(entity, field)` override's value within its entity block,
/// matching the field at the entity's top level (depth 2). Preserves quote style.
fn apply_world_overrides(text: &str, overrides: &[WorldCompile]) -> String {
    use std::collections::HashMap;
    // entity -> {field -> value}
    let mut want: HashMap<&str, HashMap<&str, &str>> = HashMap::new();
    for ov in overrides {
        want.entry(ov.entity.as_str()).or_default().insert(ov.field.as_str(), ov.value.as_str());
    }
    let mut out = String::with_capacity(text.len() + 64);
    let mut cur_fields: Option<&HashMap<&str, &str>> = None;
    // Name of the depth-2 sub-map we're currently inside (e.g. `m_mapStartingStats`),
    // so a field key written as `m_mapStartingStats::EMaxHealth` can be rewritten at
    // depth 3 without colliding with same-named keys in other sub-maps.
    let mut cur_submap: Option<&str> = None;
    // Rewrite the value portion of `body` (after ` = `) with `v`, preserving the
    // original quote style and trailing newline.
    let rewrite = |out: &mut String, body: &str, v: &str, nl: bool| -> bool {
        if let Some(eq) = body.find(" = ") {
            let quoted = body[eq + 3..].trim_start().starts_with('"');
            out.push_str(&body[..eq + 3]);
            if quoted {
                out.push('"');
                out.push_str(v);
                out.push('"');
            } else {
                out.push_str(v);
            }
            if nl {
                out.push('\n');
            }
            return true;
        }
        false
    };
    for line in text.split_inclusive('\n') {
        let nl = line.ends_with('\n');
        let body = line.strip_suffix('\n').unwrap_or(line);
        let depth = body.chars().take_while(|&c| c == '\t').count();
        let t = body.trim();
        let top_level = body.starts_with('\t') && !body.starts_with("\t\t");
        if top_level {
            if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur_fields = want.get(k);
                    cur_submap = None;
                    out.push_str(line);
                    continue;
                }
            }
        }
        if depth == 2 {
            // Track entering/leaving a depth-2 sub-map block.
            if t == "}" {
                cur_submap = None;
            } else if let Some(k) = t.strip_suffix('=').map(str::trim) {
                if !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    cur_submap = Some(k);
                }
            }
            // Rewrite a direct field (depth 2) of a wanted entity. Field names are
            // unique at the entity's top level, so this hits each at most once.
            if let (Some(fields), Some((k, _))) = (cur_fields, t.split_once(" = ")) {
                if let Some(v) = fields.get(k) {
                    if rewrite(&mut out, body, v, nl) {
                        continue;
                    }
                }
            }
        } else if depth == 3 {
            // Rewrite a sub-map-scoped field (`<submap>::<leaf>`) of a wanted entity.
            if let (Some(fields), Some(sm), Some((leaf, _))) = (cur_fields, cur_submap, t.split_once(" = ")) {
                let key = format!("{sm}::{leaf}");
                if let Some(v) = fields.get(key.as_str()) {
                    if rewrite(&mut out, body, v, nl) {
                        continue;
                    }
                }
            }
        }
        out.push_str(line);
    }
    out
}

/// Apply world-entity edits: group overrides by source file, then per file
/// decompile → rewrite fields → strip `_include` (no-op if absent) → recompile.
/// Returns the list of produced `<file>_c` rels to stage.
fn compile_world_overrides(
    cfg: &CompileConfig,
    content_root: &Path,
    _compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<Vec<String>, ()> {
    if cfg.world_overrides.is_empty() {
        return Ok(vec![]);
    }
    let helper = match cfg.vpk_helper_path.as_deref() {
        Some(h) => h,
        None => return report.fail("world entities", "vpkHelperPath not set").map(|_| vec![]),
    };
    let pak = match cfg.pak_path.as_deref() {
        Some(p) => p,
        None => return report.fail("world entities", "pakPath not set").map(|_| vec![]),
    };
    use std::collections::BTreeMap;
    let mut by_file: BTreeMap<&str, Vec<&WorldCompile>> = BTreeMap::new();
    for ov in &cfg.world_overrides {
        by_file.entry(ov.file.as_str()).or_default().push(ov);
    }
    let mut produced = Vec::new();
    for (file, ovs) in by_file {
        let rel_c = format!("{file}_c");
        let content_src = content_root.join(file);
        if let Some(parent) = content_src.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return report.fail("prepare world dir", e.to_string()).map(|_| vec![]);
            }
        }
        if let Err(e) = crate::vpk::decompile_from_vpk(helper, pak, &rel_c, &content_src.to_string_lossy()) {
            return report.fail(format!("decompile {file}"), e).map(|_| vec![]);
        }
        let text = match std::fs::read_to_string(&content_src) {
            Ok(t) => t,
            Err(e) => return report.fail(format!("read {file}"), e.to_string()).map(|_| vec![]),
        };
        let owned: Vec<WorldCompile> = ovs.iter().map(|o| (*o).clone()).collect();
        let edited = apply_world_overrides(&text, &owned);
        let stripped = strip_vdata_includes(&edited);
        if let Err(e) = std::fs::write(&content_src, stripped) {
            return report.fail(format!("write {file}"), e.to_string()).map(|_| vec![]);
        }
        report.ok_step(format!("world edits: {}", file.rsplit('/').next().unwrap_or(file)), format!("{} value(s)", ovs.len()));
        if !cfg.skip_compile {
            match run_resource_compiler(cfg, &content_src.to_string_lossy()) {
                Ok(detail) => report.ok_step(format!("compile (world): {}", file.rsplit('/').next().unwrap_or(file)), detail),
                Err(e) => return report.fail(format!("compile (world): {file}"), e).map(|_| vec![]),
            }
        }
        produced.push(rel_c);
    }
    Ok(produced)
}

/// Scale + compile all icon mods in one resourcecompiler pass. Returns
/// `(target_vtexc, produced_vtex_c_abs_path)` pairs for staging. Sources are
/// written under `panorama/images/eim_icons/` in the content tree and listed in a
/// `panorama_image_list` vdata (the headless equivalent of the Asset Browser's
/// "Recompile"); the compiler emits `<n>_png.vtex_c`, which we stage at the
/// game's `_psd.vtex_c` path so it overrides (the suffix is just naming).
fn compile_icon_mods(
    cfg: &CompileConfig,
    content_root: &Path,
    compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<Vec<(String, PathBuf)>, ()> {
    if cfg.icon_mods.is_empty() {
        return Ok(vec![]);
    }
    let icons_dir = content_root.join("panorama/images/eim_icons");
    if let Err(e) = std::fs::create_dir_all(&icons_dir) {
        report.fail("prepare icons dir", e.to_string())?;
    }
    let mut list = String::new();
    let mut produced: Vec<(String, PathBuf)> = Vec::new();
    for (i, m) in cfg.icon_mods.iter().enumerate() {
        let w = m.width.clamp(1, 4096);
        let h = m.height.clamp(1, 4096);
        let png = icons_dir.join(format!("icon_{i}.png"));
        let label = m.target_vtexc.rsplit('/').next().unwrap_or(&m.target_vtexc);
        if let Err(e) = render_icon(cfg.ffmpeg_path.as_deref(), &m.source_image, w, h, m.hue, &png.to_string_lossy()) {
            return report.fail(format!("scale icon: {label}"), e).map(|_| vec![]);
        }
        list.push_str(&format!("\t\tpanorama:\"file://{{images}}/eim_icons/icon_{i}.png\",\n"));
        let out_c = compiled_root.join(format!("panorama/images/eim_icons/icon_{i}_png.vtex_c"));
        produced.push((m.target_vtexc.trim_matches('/').to_string(), out_c));
    }
    report.ok_step("scale icons", format!("{} icon(s)", cfg.icon_mods.len()));

    if cfg.skip_compile {
        return Ok(produced);
    }

    let vdata = content_root.join("eim_icons.vdata");
    let body = format!(
        "{ENCODING_HEADER}{{\n\tgeneric_data_type = \"panorama_image_list\"\n\timage_list =\n\t[\n{list}\t]\n}}\n"
    );
    if let Err(e) = std::fs::write(&vdata, body) {
        return report.fail("write icon vdata", e.to_string()).map(|_| vec![]);
    }
    match run_resource_compiler(cfg, &vdata.to_string_lossy()) {
        Ok(detail) => report.ok_step("compile icons", detail),
        Err(e) => return report.fail("compile icons", e).map(|_| vec![]),
    }
    Ok(produced)
}

/// Run the full pipeline. Returns a per-step report (never panics; failures are
/// recorded and stop subsequent steps). Kept for tests/headless use — the app
/// itself goes through [`run_with_progress`].
#[cfg_attr(not(test), allow(dead_code))]
pub fn run(cfg: &CompileConfig) -> CompileReport {
    run_with_progress(cfg, None)
}

/// Like [`run`], but each step is also sent to `progress` as it happens
/// (drives the UI's live compile feed via the command layer).
pub fn run_with_progress(
    cfg: &CompileConfig,
    progress: Option<std::sync::mpsc::Sender<StepResult>>,
) -> CompileReport {
    let mut report = CompileReport::new();
    report.progress = progress;
    if internal_run(cfg, &mut report).is_err() {
        report.ok = false;
    }
    report
}

fn internal_run(cfg: &CompileConfig, report: &mut CompileReport) -> Result<(), ()> {
    let content_root = Path::new(&cfg.content_root);
    let compiled_root = Path::new(&cfg.compiled_root);
    let ffmpeg = cfg.ffmpeg_path.as_deref();

    // Names become game file paths + soundevent refs — enforce the rule up
    // front with a clear error instead of a cryptic compiler/in-game failure.
    // (The UI sanitizes on entry and migrates old data; this is the backstop.)
    for ev in &cfg.events {
        for song in &ev.songs {
            let valid = !song.sound_name.is_empty()
                && song
                    .sound_name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_');
            if !valid {
                return report.fail(
                    "validate track names",
                    format!(
                        "'{}' — track names must be lowercase letters, numbers or _ only; rename the track and recompile",
                        song.sound_name
                    ),
                );
            }
        }
    }

    // 0. Write an encoding.txt alongside the source wavs of EVERY folder songs
    //    compile into, so the compiler picks up mp3 compression AND per-file
    //    loop points (_lp tracks) everywhere.
    if cfg.write_encoding_txt {
        use std::collections::BTreeMap;
        let mut songs_by_folder: BTreeMap<&str, Vec<&SongCompile>> = BTreeMap::new();
        for ev in &cfg.events {
            for song in &ev.songs {
                songs_by_folder.entry(folder_for(cfg, ev)).or_default().push(song);
            }
        }
        for (folder, songs) in &songs_by_folder {
            let enc = content_root.join(folder.trim_matches('/')).join("encoding.txt");
            if let Some(parent) = enc.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&enc, build_encoding_txt(songs)) {
                return report.fail("write encoding.txt", e.to_string());
            }
        }
        report.ok_step(
            "write encoding.txt",
            format!("{} folder(s)", songs_by_folder.len()),
        );
    }

    // Tracks whether any real compile work happened this run (a song or override
    // was (re)rendered/compiled, or an events file was recompiled). Drives the
    // per-variant "nothing changed → skip stage+pack" short-circuit below.
    let mut compiled_any = false;

    // 1+2. Audio pipeline (songs + loose-file overrides): render every pending
    // clip with ffmpeg IN PARALLEL, then compile them all with a few batched
    // resourcecompiler invocations — process startup dominates per-file audio
    // compiles, so batching is the big win. Every expected output is verified;
    // stragglers are retried one-by-one so a bad clip gets a precise error.
    struct AudioJob {
        label: String,
        /// Step-name suffix: "" for songs, " (override)" for loose overrides.
        kind: &'static str,
        source: String,
        trim_start: f64,
        trim_end: f64,
        gain_db: f64,
        fade_in: f64,
        fade_out: f64,
        wav: PathBuf,
        compiled: PathBuf,
    }
    let mut jobs: Vec<AudioJob> = Vec::new();
    for ev in &cfg.events {
        for song in &ev.songs {
            // Skip-unchanged: if the song's params match its last successful
            // compile AND the compiled `.vsnd_c` is still on disk, reuse it
            // (avoids the expensive ffmpeg + resourcecompiler round-trip).
            let folder = folder_for(cfg, ev);
            let compiled = compiled_root.join(vsnd_c_relpath(folder, &song.sound_name));
            if is_up_to_date(song, cfg.skip_compile, compiled.exists()) {
                report.ok_step(format!("up to date: {}", song.sound_name), "unchanged — skipped");
                continue;
            }
            jobs.push(AudioJob {
                label: song.sound_name.clone(),
                kind: "",
                source: song.source_audio.clone(),
                trim_start: song.trim_start,
                trim_end: song.trim_end,
                gain_db: song.gain_db,
                fade_in: song.fade_in,
                fade_out: song.fade_out,
                wav: content_root
                    .join(folder.trim_matches('/'))
                    .join(format!("{}.wav", song.sound_name)),
                compiled,
            });
        }
    }

    // Loose-file sound overrides join the same pipeline: rendered at the game's
    // OWN path (their compiled .vsnd_c shadows the vanilla file — no
    // soundevents), with a per-folder encoding.txt (mp3 + loop) written first.
    if !cfg.sound_overrides.is_empty() {
        use std::collections::BTreeMap;
        // Group by folder so each folder gets one encoding.txt covering its files.
        let mut by_folder: BTreeMap<String, Vec<&SoundOverrideCompile>> = BTreeMap::new();
        for ov in &cfg.sound_overrides {
            by_folder.entry(ov.folder_stem().0).or_default().push(ov);
        }
        if cfg.write_encoding_txt {
            for (folder, ovs) in &by_folder {
                let enc = content_root.join(folder.trim_matches('/')).join("encoding.txt");
                if let Some(parent) = enc.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::write(&enc, build_override_encoding_txt(ovs)) {
                    return report.fail("write encoding.txt (overrides)", e.to_string());
                }
            }
        }
        for ov in &cfg.sound_overrides {
            let (folder, stem) = ov.folder_stem();
            let compiled = compiled_root.join(ov.vsnd_c_rel());
            if ov.up_to_date(cfg.skip_compile, compiled.exists()) {
                report.ok_step(format!("up to date: {stem}"), "unchanged — skipped");
                continue;
            }
            jobs.push(AudioJob {
                label: stem.clone(),
                kind: " (override)",
                source: ov.source_audio.clone(),
                trim_start: ov.trim_start,
                trim_end: ov.trim_end,
                gain_db: ov.gain_db,
                fade_in: ov.fade_in,
                fade_out: ov.fade_out,
                wav: content_root
                    .join(folder.trim_matches('/'))
                    .join(format!("{stem}.wav")),
                compiled,
            });
        }
    }

    if !jobs.is_empty() {
        for j in &jobs {
            if let Some(parent) = j.wav.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    return report.fail("prepare content dir", e.to_string());
                }
            }
        }

        // Parallel ffmpeg renders: a small worker pool over the job list.
        // Workers stream their step to the live feed directly; the report
        // records the same steps (quietly) after the join, in job order.
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 4)
            .min(jobs.len());
        let next = std::sync::atomic::AtomicUsize::new(0);
        let results: Vec<std::sync::Mutex<Option<Result<(), String>>>> =
            jobs.iter().map(|_| std::sync::Mutex::new(None)).collect();
        let live = report.progress.clone();
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| loop {
                    let i = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if i >= jobs.len() {
                        break;
                    }
                    let j = &jobs[i];
                    let r = crate::audio::render_to(
                        ffmpeg,
                        &j.source,
                        j.trim_start,
                        j.trim_end,
                        j.gain_db,
                        j.fade_in,
                        j.fade_out,
                        &j.wav.to_string_lossy(),
                    );
                    if let Some(tx) = &live {
                        let _ = tx.send(StepResult {
                            name: format!("ffmpeg{}: {}", j.kind, j.label),
                            ok: r.is_ok(),
                            detail: match &r {
                                Ok(()) => j.wav.to_string_lossy().into_owned(),
                                Err(e) => e.clone(),
                            },
                        });
                    }
                    *results[i].lock().unwrap() = Some(r);
                });
            }
        });
        for (i, j) in jobs.iter().enumerate() {
            let r = results[i]
                .lock()
                .unwrap()
                .take()
                .unwrap_or_else(|| Err("render did not run".into()));
            match r {
                // Recorded directly (not via ok_step) — the worker already
                // emitted this step to the live feed.
                Ok(()) => report.steps.push(StepResult {
                    name: format!("ffmpeg{}: {}", j.kind, j.label),
                    ok: true,
                    detail: j.wav.to_string_lossy().into_owned(),
                }),
                Err(e) => {
                    report.ok = false;
                    report.steps.push(StepResult {
                        name: format!("ffmpeg{}: {}", j.kind, j.label),
                        ok: false,
                        detail: e,
                    });
                    return Err(());
                }
            }
        }

        if cfg.skip_compile {
            for j in &jobs {
                report.ok_step(format!("compile (skipped): {}", j.label), "skipCompile");
            }
        } else {
            // Freshness check: the wav was JUST rendered, so a compiled output
            // older than it is stale (e.g. left over from an earlier run).
            let fresh = |j: &AudioJob| -> bool {
                let (Ok(cm), Ok(wm)) = (
                    std::fs::metadata(&j.compiled).and_then(|m| m.modified()),
                    std::fs::metadata(&j.wav).and_then(|m| m.modified()),
                ) else {
                    return false;
                };
                cm >= wm
            };
            for chunk in jobs.chunks(48) {
                let inputs: Vec<String> =
                    chunk.iter().map(|j| j.wav.to_string_lossy().into_owned()).collect();
                match run_resource_compiler_multi(cfg, &inputs) {
                    Ok(detail) => {
                        compiled_any = true;
                        report.ok_step(format!("compile audio ×{}", chunk.len()), detail);
                    }
                    Err(e) => {
                        report.ok_step(
                            "compile audio (batch)",
                            format!("batch failed — retrying per file: {e}"),
                        );
                    }
                }
                for j in chunk {
                    if fresh(j) {
                        continue;
                    }
                    match run_resource_compiler(cfg, &j.wav.to_string_lossy()) {
                        Ok(detail) => {
                            compiled_any = true;
                            report.ok_step(format!("compile{}: {}", j.kind, j.label), detail);
                        }
                        Err(e) => {
                            return report.fail(format!("compile{}: {}", j.kind, j.label), e)
                        }
                    }
                    if !fresh(j) {
                        return report.fail(
                            format!("compile{}: {}", j.kind, j.label),
                            "resourcecompiler reported success but produced no output",
                        );
                    }
                }
            }
        }
    }

    // VFX recolor overrides: decompile + recolor + recompile once (staged into
    // every variant, like icons).
    compile_effect_overrides(cfg, content_root, compiled_root, report)?;

    // Poster art replacements: decompile atlas materials, composite user art,
    // recompile once (staged into every variant, like icons).
    let poster_outputs = compile_posters(cfg, content_root, compiled_root, report)?;

    // Gameplay config edits: rewrite abilities.vdata once (staged into every
    // variant). Custom Server tab.
    compile_vdata_overrides(cfg, content_root, compiled_root, report)?;

    // Global match-wide edits: rewrite generic_data.vdata once. Custom Server.
    compile_global_overrides(cfg, content_root, compiled_root, report)?;

    // World entities (minions/boxes/powerups): rewrite npc_units/misc once.
    let world_outputs = compile_world_overrides(cfg, content_root, compiled_root, report)?;

    // Custom icon overrides: scale + compile once (staged into every variant).
    let icon_outputs = compile_icon_mods(cfg, content_root, compiled_root, report)?;

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
            let src_dir = Path::new(mod_vpk);
            let cached = src_dir.is_dir();
            for f in files.iter() {
                // ONLY true top-level soundevents files. The listing is a
                // substring match, so a pack's working copies (NEWSoundevents/,
                // MERGEDSoundevents/, backups) would otherwise be merged,
                // compiled and STAGED — junk folders in the output vpk.
                let lower = f.to_lowercase();
                if !lower.starts_with("soundevents/")
                    || lower.contains("backup")
                    || lower.contains("newsoundevents")
                    || lower.contains("merged")
                {
                    continue;
                }
                let relpath = f.trim_end_matches("_c").to_string();
                if cached && f.ends_with(".vsndevts") {
                    // Cached packs store soundevents as decompiled text — read direct.
                    if let Ok(text) = std::fs::read_to_string(src_dir.join(f.as_str())) {
                        imported_texts.entry(relpath).or_default().push(text);
                    }
                    continue;
                }
                if !f.ends_with(".vsndevts_c") {
                    continue;
                }
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

    // Any override category present forces a rebuild of every variant: these
    // paths lack full hash-skip tracking, so we conservatively never skip them.
    let overrides_present = !cfg.icon_mods.is_empty()
        || !cfg.sound_overrides.is_empty()
        || !cfg.effect_overrides.is_empty()
        || !cfg.vdata_overrides.is_empty()
        || !cfg.global_overrides.is_empty()
        || !cfg.world_overrides.is_empty()
        || !cfg.poster_overrides.is_empty();

    for v in &variants {
        let stage = output_dir.join(v.name).join("_staging");
        let mut events_c_rels: Vec<String> = Vec::new();
        // Set once any events file for this variant is actually (re)written +
        // compiled this run (i.e. Opt A below did NOT skip it). Combined with the
        // run-level `compiled_any`, this drives the whole-variant skip.
        let mut events_dirty = false;

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

            // If the vanilla base is missing this events file (e.g. a soundevents
            // file referenced by a slot but not pulled by an earlier refresh),
            // decompile it straight from the live pak so compile self-heals.
            if !vanilla.exists() {
                if let (Some(helper), Some(pak)) =
                    (helper_opt, cfg.pak_path.as_deref().filter(|p| !p.is_empty()))
                {
                    if let Some(parent) = vanilla.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let internal = format!("{rel}_c");
                    if vpk::decompile_from_vpk(helper, pak, &internal, &vanilla.to_string_lossy())
                        .is_ok()
                    {
                        report.ok_step(
                            format!("[{}] fetch vanilla {rel}", v.name),
                            "from game pak".to_string(),
                        );
                    }
                }
            }

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
                let mut applied = 0;
                let mut skipped: Vec<String> = Vec::new();
                for ev in slots {
                    let current = kv3_core::read_event_array(&text, &ev.event_name, &ev.array_key)
                        .ok()
                        .and_then(|x| x.vsnd_duration);
                    let merge = event_merge(ev, folder_for(cfg, ev), current);
                    match kv3_core::apply_merge(&text, &merge) {
                        Ok(t) => {
                            text = t;
                            applied += 1;
                        }
                        // The game drifts between patches — an event/array we own may
                        // have been removed or renamed. We can't merge into what's
                        // gone, so skip that slot with a note instead of aborting the
                        // whole compile (MERGE, NEVER REPLACE).
                        Err(kv3_core::Kv3Error::EventNotFound(_))
                        | Err(kv3_core::Kv3Error::ArrayNotFound(_)) => {
                            let label = if ev.array_key == "vsnd_files" {
                                ev.event_name.clone()
                            } else {
                                format!("{}.{}", ev.event_name, ev.array_key)
                            };
                            skipped.push(label);
                        }
                        Err(e) => {
                            return report.fail(format!("[{}] merge {rel}", v.name), e.to_string())
                        }
                    }
                }
                let detail = if skipped.is_empty() {
                    format!("{applied} slot(s)")
                } else {
                    format!(
                        "{applied} slot(s); skipped {} not in game: {}",
                        skipped.len(),
                        skipped.join(", ")
                    )
                };
                report.ok_step(format!("[{}] merge {rel}", v.name), detail);
            }

            let events_dest = content_root.join(rel);
            let events_c_abs = compiled_root.join(events_c_relpath(rel));
            // Success stamp: fingerprint of the text the last SUCCESSFUL compile
            // ran on. The text is written to the content tree before the
            // compiler runs, so text-equality alone can't prove the existing
            // `.vsndevts_c` is current — a failed run leaves the new text with
            // the old `_c`. The stamp is only written after the compiler
            // succeeds, closing that gap.
            let events_stamp = events_dest.with_extension("vsndevts.eimstamp");
            // Opt A: if the freshly-merged text is byte-identical to what the
            // last successful compile ran on AND the compiled `.vsndevts_c`
            // still exists, the resourcecompiler pass would just reproduce the
            // same output — skip its multi-second cold start. (Won't fire for
            // the combined variant, which shares this content path with `mine`
            // and so always differs; combined is the rare case, so that's
            // acceptable.)
            let unchanged = !cfg.skip_compile
                && events_c_abs.exists()
                && std::fs::read_to_string(&events_dest).map(|d| d == text).unwrap_or(false)
                && stamp_matches(&events_stamp, &fingerprint(&text));
            if unchanged {
                report.ok_step(format!("[{}] up to date {rel}", v.name), "unchanged — skipped");
                events_c_rels.push(events_c_relpath(rel));
                continue;
            }
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
                // A stale stamp must never survive into a failed run: clear it
                // before compiling, write it back only on success.
                let _ = std::fs::remove_file(&events_stamp);
                match run_resource_compiler(cfg, &events_dest.to_string_lossy()) {
                    Ok(detail) => {
                        events_dirty = true;
                        let _ = std::fs::write(&events_stamp, fingerprint(&text));
                        report.ok_step(format!("[{}] compile {rel}", v.name), detail);
                    }
                    Err(e) => return report.fail(format!("[{}] compile {rel}", v.name), e),
                }
            } else {
                events_dirty = true;
            }
            events_c_rels.push(events_c_relpath(rel));
        }

        // Whole-variant skip: if nothing was (re)compiled this run, every
        // events file was unchanged, AND the existing output was built from
        // this exact config (the build stamp matches), the output already
        // reflects the current project — skip the wipe → stage → pack entirely
        // (the slow part). The stamp fingerprints the whole config + variant,
        // so changes that never dirty an events file — a removed override, a
        // dropped events file, toggles, changed imports — still rebuild.
        let build_stamp = fingerprint(&format!("{cfg:?}|imported:{}", v.with_imported));
        let stamp_file = output_dir.join(v.name).join(".eim_buildstamp");
        let out_artifact = if cfg.output_mode == "vpk" {
            output_dir.join(v.name).join(&cfg.vpk_name)
        } else {
            stage.clone()
        };
        if !compiled_any
            && !events_dirty
            && !overrides_present
            && out_artifact.exists()
            && stamp_matches(&stamp_file, &build_stamp)
        {
            report.ok_step(format!("[{}] up to date", v.name), "nothing changed — skipped");
            continue;
        }
        // Building (or rebuilding) below: drop the old stamp now so a failed
        // run can't leave a stamp claiming the partial output is current.
        let _ = std::fs::remove_file(&stamp_file);

        // (Re)build: reset staging fresh, then extract imported assets + stage.
        let _ = std::fs::remove_dir_all(&stage);
        if let Err(e) = std::fs::create_dir_all(&stage) {
            return report.fail("prepare staging", e.to_string());
        }
        let mut staged = 0;

        // Imported assets go only into the combined variant. Full vpk merge:
        // stage every real asset tree (not just sounds), so models/particles/etc.
        // come along too. We extract a fixed set of game-content dirs so the
        // pack's working/junk folders (MYSoundevents, NEWSoundevents, *_BACKUP,
        // scripts, readmes) are skipped. Soundevents are NOT staged wholesale —
        // they're merged via array-union (above), since clobbering the live
        // shared events files would revert other mods + the current patch.
        const ASSET_DIRS: [&str; 5] =
            ["sounds/", "models/", "particles/", "materials/", "panorama/"];
        if v.with_imported {
            if let Some(helper) = helper_opt {
                for mod_vpk in &cfg.imported_mods {
                    for dir in ASSET_DIRS {
                        let _ = vpk::extract_all(helper, mod_vpk, &stage.to_string_lossy(), Some(dir));
                    }
                }
                // Drop the files the user deselected in this pack's import
                // review (they were just extracted wholesale above).
                let mut excluded = 0;
                for mod_vpk in &cfg.imported_mods {
                    if let Some(excludes) = cfg.imported_mod_excludes.get(mod_vpk) {
                        for rel in excludes {
                            if std::fs::remove_file(stage.join(rel)).is_ok() {
                                excluded += 1;
                            }
                        }
                    }
                }
                if excluded > 0 {
                    report.ok_step(
                        format!("[{}] exclude deselected", v.name),
                        format!("{excluded} file(s) dropped"),
                    );
                }
            }
        }

        // Stage our song .vsnd_c + each events .vsndevts_c into this variant.
        for ev in &cfg.events {
            for song in &ev.songs {
                let rel = vsnd_c_relpath(folder_for(cfg, ev), &song.sound_name);
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
        // Stage custom icon overrides (the compiled vtex_c staged at the game's
        // referenced `_psd.vtex_c` path).
        for (target, src) in &icon_outputs {
            if cfg.skip_compile && !src.exists() {
                continue;
            }
            match copy_into(src, &stage, target) {
                Ok(_) => staged += 1,
                Err(e) => return report.fail(format!("stage icon: {target}"), e.to_string()),
            }
        }
        // Stage loose-file sound overrides (compiled .vsnd_c at the game's path).
        for ov in &cfg.sound_overrides {
            let rel = ov.vsnd_c_rel();
            let src = compiled_root.join(&rel);
            if cfg.skip_compile && !src.exists() {
                continue;
            }
            match copy_into(&src, &stage, &rel) {
                Ok(_) => staged += 1,
                Err(e) => return report.fail(format!("stage override: {rel}"), e.to_string()),
            }
        }
        // Stage VFX recolor overrides (recompiled .vpcf_c at the game's path).
        for ov in &cfg.effect_overrides {
            let rel = ov.vpcf_c_rel();
            let src = compiled_root.join(&rel);
            if cfg.skip_compile && !src.exists() {
                continue;
            }
            match copy_into(&src, &stage, &rel) {
                Ok(_) => staged += 1,
                Err(e) => return report.fail(format!("stage effect: {rel}"), e.to_string()),
            }
        }
        // Stage poster overrides (recompiled .vmat_c + .vtex_c at the game's paths).
        for rel in &poster_outputs {
            let src = compiled_root.join(rel);
            if cfg.skip_compile && !src.exists() {
                continue;
            }
            match copy_into(&src, &stage, rel) {
                Ok(_) => staged += 1,
                Err(e) => return report.fail(format!("stage poster: {rel}"), e.to_string()),
            }
        }
        // Stage the gameplay-config override (recompiled abilities.vdata_c).
        if !cfg.vdata_overrides.is_empty() {
            let src = compiled_root.join(ABILITIES_VDATA_C_REL);
            if !(cfg.skip_compile && !src.exists()) {
                match copy_into(&src, &stage, ABILITIES_VDATA_C_REL) {
                    Ok(_) => staged += 1,
                    Err(e) => return report.fail("stage config", e.to_string()),
                }
            }
        }
        // Stage the global-stats override (recompiled generic_data.vdata_c).
        if !cfg.global_overrides.is_empty() {
            let src = compiled_root.join(GENERIC_DATA_C_REL);
            if !(cfg.skip_compile && !src.exists()) {
                match copy_into(&src, &stage, GENERIC_DATA_C_REL) {
                    Ok(_) => staged += 1,
                    Err(e) => return report.fail("stage global", e.to_string()),
                }
            }
        }
        // Stage world-entity overrides (recompiled npc_units/misc .vdata_c).
        for rel_c in &world_outputs {
            let src = compiled_root.join(rel_c);
            if cfg.skip_compile && !src.exists() {
                continue;
            }
            match copy_into(&src, &stage, rel_c) {
                Ok(_) => staged += 1,
                Err(e) => return report.fail(format!("stage world: {rel_c}"), e.to_string()),
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
        // Variant fully built — record what it was built from so the next
        // run's whole-variant skip can trust it.
        let _ = std::fs::write(&stamp_file, &build_stamp);
    }

    // Report the output dir (contains mine/ and, if combined, combined/).
    report.output_path = Some(output_dir.to_string_lossy().into_owned());

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const VDATA_SAMPLE: &str = "\
<!-- kv3 -->
{
\tgeneric_data_type = \"CitadelAbilityVData\"
\t_include =
\t[
\t\tresource_name:\"scripts/abilities/inferno.vdata_inc\",
\t\tresource_name:\"scripts/abilities/haze.vdata_inc\",
\t]
\tability_incendiary_projectile =
\t{
\t\t_class = \"citadel_ability\"
\t\tm_mapAbilityProperties =
\t\t{
\t\t\tAbilityCooldownBetweenCharge =
\t\t\t{
\t\t\t\tm_strValue = \"6\"
\t\t\t\tm_strDisableValue = \"0\"
\t\t\t}
\t\t\tAbilityCastRange =
\t\t\t{
\t\t\t\tm_strValue = \"20m\"
\t\t\t}
\t\t}
\t}
\tability_other =
\t{
\t\tm_mapAbilityProperties =
\t\t{
\t\t\tAbilityCastRange =
\t\t\t{
\t\t\t\tm_strValue = \"99\"
\t\t\t}
\t\t}
\t}
}
";

    #[test]
    fn vdata_override_rewrites_only_target_prop() {
        let ovs = vec![
            VdataCompile {
                ability_key: "ability_incendiary_projectile".into(),
                prop_key: "AbilityCooldownBetweenCharge".into(),
                value: "2.5".into(),
            },
            VdataCompile {
                ability_key: "ability_incendiary_projectile".into(),
                prop_key: "AbilityCastRange".into(),
                value: "30m".into(),
            },
        ];
        let out = apply_vdata_overrides(VDATA_SAMPLE, &ovs);
        // Targeted values changed.
        assert!(out.contains("m_strValue = \"2.5\""));
        assert!(out.contains("m_strValue = \"30m\""));
        // The disable value sitting right after the cooldown is untouched.
        assert!(out.contains("m_strDisableValue = \"0\""));
        // The SAME prop name on a different ability is NOT touched.
        assert!(out.contains("m_strValue = \"99\""));
        // The original cooldown value is gone.
        assert!(!out.contains("m_strValue = \"6\""));
    }

    #[test]
    fn vdata_strip_includes_removes_block() {
        let out = strip_vdata_includes(VDATA_SAMPLE);
        assert!(!out.contains("_include"));
        assert!(!out.contains("vdata_inc"));
        // Real data survives.
        assert!(out.contains("ability_incendiary_projectile"));
        assert!(out.contains("m_strValue = \"20m\""));
        // generic_data_type line before the include is kept.
        assert!(out.contains("CitadelAbilityVData"));
    }

    #[test]
    fn world_override_rewrites_field_in_entity_only() {
        let src = "\
\ttrooper_normal =
\t{
\t\tm_nMaxHealth = 300
\t\tm_flWalkSpeed = 248
\t}
\ttrooper_medic =
\t{
\t\tm_nMaxHealth = 300
\t}
";
        let ovs = vec![
            WorldCompile { file: "scripts/npc_units.vdata".into(), entity: "trooper_normal".into(), field: "m_nMaxHealth".into(), value: "9000".into() },
            WorldCompile { file: "scripts/npc_units.vdata".into(), entity: "trooper_normal".into(), field: "m_flWalkSpeed".into(), value: "600".into() },
        ];
        let out = apply_world_overrides(src, &ovs);
        assert!(out.contains("\t\tm_nMaxHealth = 9000"));
        assert!(out.contains("\t\tm_flWalkSpeed = 600"));
        // The SAME field on a different entity is untouched.
        assert!(out.contains("\ttrooper_medic =\n\t{\n\t\tm_nMaxHealth = 300"));
    }

    #[test]
    fn world_override_rewrites_submap_scoped_field() {
        // Hero stats live one level deep, inside named sub-maps. Same leaf name
        // (`EWeaponPower`) appears in two sub-maps; the `submap::leaf` key must
        // only hit the targeted one.
        let src = "\
\thero_inferno =
\t{
\t\tm_strUIShoppingMap = \"x.vmap\"
\t\tm_mapStartingStats =
\t\t{
\t\t\tEMaxHealth = 830.0
\t\t\tEWeaponPower = 0
\t\t}
\t\tm_mapStandardLevelUpUpgrades =
\t\t{
\t\t\tMODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL = 41.0
\t\t\tEWeaponPower = 5
\t\t}
\t}
";
        let ovs = vec![
            WorldCompile { file: "scripts/heroes.vdata".into(), entity: "hero_inferno".into(), field: "m_mapStartingStats::EMaxHealth".into(), value: "2500".into() },
            WorldCompile { file: "scripts/heroes.vdata".into(), entity: "hero_inferno".into(), field: "m_mapStandardLevelUpUpgrades::MODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL".into(), value: "120".into() },
            WorldCompile { file: "scripts/heroes.vdata".into(), entity: "hero_inferno".into(), field: "m_mapStartingStats::EWeaponPower".into(), value: "99".into() },
        ];
        let out = apply_world_overrides(src, &ovs);
        assert!(out.contains("\t\t\tEMaxHealth = 2500"));
        assert!(out.contains("\t\t\tMODIFIER_VALUE_BASE_HEALTH_FROM_LEVEL = 120"));
        // Only the StartingStats EWeaponPower is rewritten; the level-up one stays.
        assert!(out.contains("m_mapStartingStats =\n\t{") || out.contains("EWeaponPower = 99"));
        assert!(out.contains("\t\t\tEWeaponPower = 99"));
        assert!(out.contains("\t\t\tEWeaponPower = 5"));
        // The plain direct field is untouched (no flat override for it).
        assert!(out.contains("m_strUIShoppingMap = \"x.vmap\""));
    }

    #[test]
    fn global_override_rewrites_first_match_only() {
        let src = "{\n\tm_nTier1GoldKill = 1500\n\tnested =\n\t{\n\t\tm_flScoringTime = 6\n\t}\n\tm_nTier1GoldKill = 9999\n}\n";
        let ovs = vec![
            GlobalCompile { key: "m_nTier1GoldKill".into(), value: "4242".into() },
            GlobalCompile { key: "m_flScoringTime".into(), value: "12".into() },
        ];
        let out = apply_global_overrides(src, &ovs);
        // First occurrence rewritten, indentation preserved.
        assert!(out.contains("\tm_nTier1GoldKill = 4242"));
        // Nested value rewritten with its deeper indent intact.
        assert!(out.contains("\t\tm_flScoringTime = 12"));
        // The SECOND occurrence of the same key is left as-is.
        assert!(out.contains("\tm_nTier1GoldKill = 9999"));
    }

    #[test]
    fn vdata_override_rewrites_upgrade_bonus_by_index() {
        let src = "\
\tability_x =
\t{
\t\tm_mapAbilityProperties =
\t\t{
\t\t\tAbilityCooldown =
\t\t\t{
\t\t\t\tm_strValue = \"6\"
\t\t\t}
\t\t}
\t\tm_vecAbilityUpgrades =
\t\t[
\t\t\t{
\t\t\t\tm_vecPropertyUpgrades =
\t\t\t\t[
\t\t\t\t\t{
\t\t\t\t\t\tm_strPropertyName = \"AbilityCooldown\"
\t\t\t\t\t\tm_strBonus = -12.0
\t\t\t\t\t},
\t\t\t\t]
\t\t\t},
\t\t\t{
\t\t\t\tm_vecPropertyUpgrades =
\t\t\t\t[
\t\t\t\t\t{
\t\t\t\t\t\tm_strPropertyName = \"AbilityCharges\"
\t\t\t\t\t\tm_strBonus = \"2\"
\t\t\t\t\t},
\t\t\t\t]
\t\t\t},
\t\t]
\t}
";
        let ovs = vec![
            VdataCompile { ability_key: "ability_x".into(), prop_key: "@upgrade:0".into(), value: "-30".into() },
            VdataCompile { ability_key: "ability_x".into(), prop_key: "@upgrade:1".into(), value: "5".into() },
            VdataCompile { ability_key: "ability_x".into(), prop_key: "AbilityCooldown".into(), value: "3".into() },
        ];
        let out = apply_vdata_overrides(src, &ovs);
        // Bare bonus stays bare; quoted bonus stays quoted.
        assert!(out.contains("m_strBonus = -30"));
        assert!(out.contains("m_strBonus = \"5\""));
        // Base prop still edited independently.
        assert!(out.contains("m_strValue = \"3\""));
        // Originals gone.
        assert!(!out.contains("-12.0"));
        assert!(!out.contains("m_strBonus = \"2\""));
    }

    #[test]
    fn vdata_override_quotes_unit_value_on_bare_field() {
        // A unit-bearing value (e.g. "34m" from a stale randomizer cache) landing
        // on a bare-number bonus must be QUOTED, else the compile fails on `34m`.
        let src = "\
\tability_x =
\t{
\t\tm_vecAbilityUpgrades =
\t\t[
\t\t\t{
\t\t\t\tm_vecPropertyUpgrades =
\t\t\t\t[
\t\t\t\t\t{
\t\t\t\t\t\tm_strPropertyName = \"DPS\"
\t\t\t\t\t\tm_strBonus = 65.0
\t\t\t\t\t},
\t\t\t\t]
\t\t\t},
\t\t]
\t}
";
        let ovs = vec![VdataCompile {
            ability_key: "ability_x".into(),
            prop_key: "@upgrade:0".into(),
            value: "34m".into(),
        }];
        let out = apply_vdata_overrides(src, &ovs);
        assert!(out.contains("m_strBonus = \"34m\""), "unit value must be quoted:\n{out}");
        assert!(!out.contains("m_strBonus = 34m"), "must not emit a bare unit value");
    }

    #[test]
    fn vdata_override_rewrites_weapon_info_field() {
        let src = "\
\tcitadel_weapon_bull_set =
\t{
\t\tm_WeaponInfo =
\t\t{
\t\t\tm_flBulletSpeed = 24000.0
\t\t\tm_VerticallRecoil =
\t\t\t{
\t\t\t\tm_flBulletDamage = 999
\t\t\t}
\t\t\tm_iClipSize = 9
\t\t\tm_flBulletDamage = 3.6
\t\t\tm_flReloadMoveSpeed = \"10000\"
\t\t}
\t}
";
        let ovs = vec![
            VdataCompile { ability_key: "citadel_weapon_bull_set".into(), prop_key: "@weapon:m_flBulletDamage".into(), value: "50".into() },
            VdataCompile { ability_key: "citadel_weapon_bull_set".into(), prop_key: "@weapon:m_iClipSize".into(), value: "30".into() },
            VdataCompile { ability_key: "citadel_weapon_bull_set".into(), prop_key: "@weapon:m_flReloadMoveSpeed".into(), value: "5000".into() },
        ];
        let out = apply_vdata_overrides(src, &ovs);
        // Direct m_WeaponInfo child is rewritten; the value style is preserved.
        assert!(out.contains("\t\t\tm_flBulletDamage = 50"));
        assert!(out.contains("\t\t\tm_iClipSize = 30"));
        assert!(out.contains("m_flReloadMoveSpeed = \"5000\"")); // quoted stays quoted
        // The same-named field nested in the recoil sub-block is NOT touched.
        assert!(out.contains("m_flBulletDamage = 999"));
        assert!(!out.contains("m_flBulletDamage = 3.6"));
    }

    #[test]
    fn vdata_override_rewrites_item_tier() {
        let src = "\
\tupgrade_clip_size =
\t{
\t\tm_mapAbilityProperties =
\t\t{
\t\t\tBonusClipSizePercent =
\t\t\t{
\t\t\t\tm_strValue = \"30\"
\t\t\t}
\t\t}
\t\tm_eItemSlotType = \"EItemSlotType_WeaponMod\"
\t\tm_iItemTier = \"EModTier_1\"
\t}
";
        let ovs = vec![
            VdataCompile { ability_key: "upgrade_clip_size".into(), prop_key: "@tier".into(), value: "EModTier_4".into() },
            VdataCompile { ability_key: "upgrade_clip_size".into(), prop_key: "BonusClipSizePercent".into(), value: "120".into() },
        ];
        let out = apply_vdata_overrides(src, &ovs);
        // Tier token swapped, quotes preserved; the slot-type line is untouched.
        assert!(out.contains("m_iItemTier = \"EModTier_4\""));
        assert!(!out.contains("EModTier_1"));
        assert!(out.contains("m_eItemSlotType = \"EItemSlotType_WeaponMod\""));
        // The item's stat got scaled in the same pass.
        assert!(out.contains("m_strValue = \"120\""));
    }

    #[test]
    fn vdata_override_noop_for_unknown_keys() {
        let ovs = vec![VdataCompile {
            ability_key: "nope".into(),
            prop_key: "AbilityCastRange".into(),
            value: "1".into(),
        }];
        let out = apply_vdata_overrides(VDATA_SAMPLE, &ovs);
        assert_eq!(out, VDATA_SAMPLE);
    }

    #[test]
    fn recolor_shifts_color_lines_only() {
        let src = "\
\tm_ConstantColor = [ 255, 0, 0, 255 ]
\t\tm_LiteralColor = [ 93, 135, 187 ]
\t\tm_flConstantRadius = 0.9
\t\tm_ColorFade = [ 60, 60, 60, 255 ]
\t\tm_vecColorScale = \n";
        let out = recolor_particle_source(src, 120.0, 1.0);
        let lines: Vec<&str> = out.lines().collect();
        // Pure red rotated +120° -> pure green; alpha + style preserved.
        assert_eq!(lines[0], "\tm_ConstantColor = [ 0, 255, 0, 255 ]");
        // The blue literal shifts hue but stays a 3-tuple.
        assert!(lines[1].starts_with("\t\tm_LiteralColor = [ ") && lines[1].matches(',').count() == 2);
        // Non-color line untouched.
        assert_eq!(lines[2], "\t\tm_flConstantRadius = 0.9");
        // Grayscale (s=0) is unchanged by a hue rotation.
        assert_eq!(lines[3], "\t\tm_ColorFade = [ 60, 60, 60, 255 ]");
        // A color-ish key whose value isn't a literal array is left alone.
        assert_eq!(lines[4], "\t\tm_vecColorScale = ");
    }

    #[test]
    fn recolor_noop_when_neutral() {
        let src = "\tm_ConstantColor = [ 10, 20, 30, 255 ]\n";
        assert_eq!(recolor_particle_source(src, 0.0, 1.0), src);
    }

    #[test]
    fn rainbow_injects_color_ops_into_operators() {
        let src = "{\n\tm_Operators = \n\t[\n\t\t{\n\t\t\t_class = \"C_OP_BasicMovement\"\n\t\t},\n\t]\n}\n";
        let out = animate_particle_source(src, "rainbow", 0.0, 1.0);
        // Injected several ColorInterpolate ops with fade windows, before the existing op.
        assert!(out.matches("C_OP_ColorInterpolate").count() >= 6);
        assert!(out.contains("m_flFadeEndTime"));
        let ci = out.find("C_OP_ColorInterpolate").unwrap();
        let bm = out.find("C_OP_BasicMovement").unwrap();
        assert!(ci < bm, "animation ops must be inside m_Operators, before existing ops");
    }

    #[test]
    fn animate_falls_back_to_recolor_without_operators() {
        // No m_Operators array → static recolor instead of a broken injection.
        let src = "\tm_ConstantColor = [ 255, 0, 0, 255 ]\n";
        let out = animate_particle_source(src, "rainbow", 120.0, 1.0);
        assert_eq!(out, "\tm_ConstantColor = [ 0, 255, 0, 255 ]\n");
    }

    #[test]
    fn auto_duration_never_shrinks_below_current() {
        let ev = EventCompile {
            event_name: "E".into(),
            array_key: "vsnd_files".into(),
            stock_entry: "a/stock.vsnd".into(),
            sound_folder: None,
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
                current_hash: None,
                last_compiled_hash: None,
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
            sound_folder: None,
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
            pak_path: None,
            output_dir: out.to_string_lossy().into_owned(),
            output_mode: "vpk".into(),
            vpk_name: "pak01_dir.vpk".into(),
            write_encoding_txt: true,
            skip_compile: false,
            imported_mods: vec![],
            imported_mod_excludes: Default::default(),
            events: vec![EventCompile {
                event_name: "Music.MatchIntro.MatchStart.King".into(),
                array_key: "vsnd_files".into(),
                stock_entry: "sounds/music/match_intro/music_match_intro_king_160bpm.vsnd".into(),
                sound_folder: None,
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
                    current_hash: None,
                    last_compiled_hash: None,
                }],
            }],
            icon_mods: vec![],
            sound_overrides: vec![],
            effect_overrides: vec![],
            vdata_overrides: vec![],
            global_overrides: vec![],
            world_overrides: vec![],
            poster_overrides: vec![],
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

    /// Real VFX-recolor pipeline: decompile Curse's particle from the pak,
    /// hue-shift it, recompile, pack. Run with:
    ///   cargo test -p app --lib -- --ignored e2e_recolor_particle --nocapture
    #[test]
    #[ignore]
    fn e2e_recolor_particle() {
        let csdk = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let addon = "eim_fx_e2e_addon";
        let content_root = format!(r"{csdk}\content\citadel_addons\{addon}");
        let compiled_root = format!(r"{csdk}\game\citadel_addons\{addon}");
        let out = std::env::temp_dir().join("eim_fx_e2e_out");
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);

        let mut cfg = CompileConfig {
            content_root: content_root.clone(),
            compiled_root: compiled_root.clone(),
            game_info_dir: format!(r"{csdk}\game\citadel"),
            sound_folder: "sounds/music/match_intro".into(),
            resource_compiler: format!(r"{csdk}\game\bin_tools\win64\resourcecompiler.exe"),
            ffmpeg_path: None,
            vpk_helper_path: Some(
                r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe".into(),
            ),
            vanilla_root: r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\ModFiles".into(),
            pak_path: Some(
                r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk".into(),
            ),
            output_dir: out.to_string_lossy().into_owned(),
            output_mode: "vpk".into(),
            vpk_name: "pak01_dir.vpk".into(),
            write_encoding_txt: true,
            skip_compile: false,
            imported_mods: vec![],
            imported_mod_excludes: Default::default(),
            events: vec![],
            icon_mods: vec![],
            sound_overrides: vec![],
            effect_overrides: vec![EffectCompile {
                target_ref: "particles/abilities/aoe_silence_cast_energy.vpcf".into(),
                hue: 150.0,
                saturation: 1.0,
                mode: "static".into(),
                current_hash: Some("h1".into()),
                last_compiled_hash: None,
            }],
            vdata_overrides: vec![],
            global_overrides: vec![],
            world_overrides: vec![],
            poster_overrides: vec![],
        };

        let report = run(&cfg);
        for s in &report.steps {
            println!("[{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }
        assert!(report.ok, "effect pipeline failed");

        let vpcf_c = Path::new(&compiled_root)
            .join("particles/abilities/aoe_silence_cast_energy.vpcf_c");
        assert!(vpcf_c.exists(), "recolored vpcf_c not produced");
        // The recolored source must differ from vanilla purple at the color lines.
        let src = std::fs::read_to_string(
            Path::new(&content_root).join("particles/abilities/aoe_silence_cast_energy.vpcf"),
        )
        .unwrap();
        assert!(!src.contains("[ 198, 141, 227, 255 ]"), "color was not recolored");
        let vpk = out.join("mine").join("pak01_dir.vpk");
        assert!(vpk.exists(), "vpk not produced");

        // Second run with matching hashes should skip the recompile (up-to-date).
        cfg.effect_overrides[0].last_compiled_hash = Some("h1".into());
        let report2 = run(&cfg);
        assert!(report2.steps.iter().any(|s| s.detail.contains("unchanged")));

        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn vmat_texture_refs_parses_layered_and_plain() {
        let text = "\"Layer0\"\n{\n\t\"shader\"\t\"citadel_overlay.vfx\"\n\t\"TextureColor\"\t\"materials/overlays/a_color.png\"\n\t\"TextureColor1\"\t\"materials/overlays/b_color.png\"\n\t\"TextureTranslucency\"\t\"materials/overlays/a_trans.png\"\n\t\"TextureTintMask\"\t\"[1.000000 1.000000 1.000000 0.000000]\"\n}\n";
        let refs = vmat_texture_refs(text);
        assert_eq!(
            refs,
            vec![
                ("TextureColor".to_string(), "materials/overlays/a_color.png".to_string()),
                ("TextureColor1".to_string(), "materials/overlays/b_color.png".to_string()),
                ("TextureTranslucency".to_string(), "materials/overlays/a_trans.png".to_string()),
            ]
        );
    }

    #[test]
    fn strip_compiled_textures_removes_block_only() {
        let text = "\"Layer0\"\n{\n\t\"TextureColor\"\t\"materials/x.png\"\n\t\"Compiled Textures\"\n\t{\n\t\t\"g_tColor\"\t\"materials/x_psd_1234.vtex\"\n\t}\n}\n";
        let out = strip_compiled_textures(text);
        assert!(!out.contains("Compiled Textures"));
        assert!(!out.contains("g_tColor"));
        assert!(out.contains("\"TextureColor\"\t\"materials/x.png\""));
        assert!(out.trim_end().ends_with('}'));
    }

    /// Real poster-replacement pipeline: decompile the bodega atlas material
    /// from the pak, composite a generated test image into the Black Cauldron
    /// rect, recompile, pack. Run with:
    ///   cargo test -p app --lib -- --ignored e2e_poster_replace --nocapture
    #[test]
    #[ignore]
    fn e2e_poster_replace() {
        let csdk = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let addon = "eim_poster_e2e_addon";
        let content_root = format!(r"{csdk}\content\citadel_addons\{addon}");
        let compiled_root = format!(r"{csdk}\game\citadel_addons\{addon}");
        let out = std::env::temp_dir().join("eim_poster_e2e_out");
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);

        // Generate a small test source image with ffmpeg.
        let art = std::env::temp_dir().join("eim_poster_e2e_art.png");
        let ok = crate::procutil::quiet("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "color=red:size=400x300", "-frames:v", "1"])
            .arg(&art)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "ffmpeg not available to generate test art");

        let mut cfg = CompileConfig {
            content_root: content_root.clone(),
            compiled_root: compiled_root.clone(),
            game_info_dir: format!(r"{csdk}\game\citadel"),
            sound_folder: "sounds/music/match_intro".into(),
            resource_compiler: format!(r"{csdk}\game\bin_tools\win64\resourcecompiler.exe"),
            ffmpeg_path: None,
            vpk_helper_path: Some(
                r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\bin\Release\net10.0\vpk-helper.dll".into(),
            ),
            vanilla_root: r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\ModFiles".into(),
            pak_path: Some(
                r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk".into(),
            ),
            output_dir: out.to_string_lossy().into_owned(),
            output_mode: "vpk".into(),
            vpk_name: "pak01_dir.vpk".into(),
            write_encoding_txt: true,
            skip_compile: false,
            imported_mods: vec![],
            imported_mod_excludes: Default::default(),
            events: vec![],
            icon_mods: vec![],
            sound_overrides: vec![],
            effect_overrides: vec![],
            vdata_overrides: vec![],
            global_overrides: vec![],
            world_overrides: vec![],
            poster_overrides: vec![PosterCompile {
                sheet_id: "posters_bodega_comp1".into(),
                materials: vec!["materials/overlays/posters_bodega_comp1.vmat".into()],
                label: "black cauldron (e2e)".into(),
                x: 1081,
                y: 1555,
                w: 967,
                h: 493,
                alpha_coverage: 1.0,
                source_image: art.to_string_lossy().into_owned(),
                fit: "cover".into(),
                current_hash: Some("p1".into()),
                last_compiled_hash: None,
            }],
        };

        let report = run(&cfg);
        for s in &report.steps {
            println!("[{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }
        assert!(report.ok, "poster pipeline failed");

        let vmat_c = Path::new(&compiled_root).join("materials/overlays/posters_bodega_comp1.vmat_c");
        assert!(vmat_c.exists(), "vmat_c not produced");
        let overlays = Path::new(&compiled_root).join("materials/overlays");
        let has_vtex = std::fs::read_dir(&overlays).unwrap().flatten().any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.starts_with("posters_bodega_comp1") && n.ends_with(".vtex_c")
        });
        assert!(has_vtex, "sheet vtex_c not produced");
        // The stripped source vmat must have no Compiled Textures block left.
        let src = std::fs::read_to_string(
            Path::new(&content_root).join("materials/overlays/posters_bodega_comp1.vmat"),
        )
        .unwrap();
        assert!(!src.contains("Compiled Textures"));
        let vpk = out.join("mine").join("pak01_dir.vpk");
        assert!(vpk.exists(), "vpk not produced");

        // Second run with matching hashes should skip (up-to-date) but still
        // stage the previously produced files.
        cfg.poster_overrides[0].last_compiled_hash = Some("p1".into());
        let report2 = run(&cfg);
        assert!(report2.ok, "second run failed");
        assert!(report2
            .steps
            .iter()
            .any(|s| s.name.contains("posters up to date")));

        let _ = std::fs::remove_dir_all(&content_root);
        let _ = std::fs::remove_dir_all(&compiled_root);
        let _ = std::fs::remove_dir_all(&out);
        let _ = std::fs::remove_file(&art);
    }

    fn song_with(current: Option<&str>, last: Option<&str>) -> SongCompile {
        SongCompile {
            sound_name: "x".into(),
            source_audio: "x.mp3".into(),
            trim_start: 0.0,
            trim_end: 1.0,
            gain_db: 0.0,
            fade_in: 0.0,
            fade_out: 0.0,
            looping: false,
            current_hash: current.map(String::from),
            last_compiled_hash: last.map(String::from),
        }
    }

    #[test]
    fn skip_only_when_hashes_match_and_file_present() {
        // Unchanged + file present -> skip.
        assert!(is_up_to_date(&song_with(Some("h"), Some("h")), false, true));
        // Unchanged but compiled file missing -> must recompile.
        assert!(!is_up_to_date(&song_with(Some("h"), Some("h")), false, false));
        // Params changed -> recompile.
        assert!(!is_up_to_date(&song_with(Some("h2"), Some("h")), false, true));
        // Never compiled (no last hash) -> compile.
        assert!(!is_up_to_date(&song_with(Some("h"), None), false, true));
        // No current hash (skip disabled for this song) -> compile.
        assert!(!is_up_to_date(&song_with(None, None), false, true));
        // Global skip_compile bypasses the optimization entirely.
        assert!(!is_up_to_date(&song_with(Some("h"), Some("h")), true, true));
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
