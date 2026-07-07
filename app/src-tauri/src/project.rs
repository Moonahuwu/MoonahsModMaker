//! `project.json` data model — the source of truth for OUR entries. The on-disk
//! events file is the source of truth for everyone else's. Compile = splice
//! ours into theirs.

use serde::{Deserialize, Serialize};
use std::path::Path;

pub const PROJECT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub version: u32,
    /// Absolute base for the recreated structure + `.vsnd_c` output.
    #[serde(default)]
    pub game_content_root: String,
    /// Content-relative folder for references & files,
    /// e.g. `sounds/music/match_intro`.
    #[serde(default = "default_sound_folder")]
    pub sound_folder: String,
    pub events_file: EventsFile,
    pub tools: Tools,
    pub output: Output,
    pub events: Vec<EventProject>,
    /// Custom item/UI icon overrides (PNG/JPG → compiled `.vtex_c`).
    #[serde(default)]
    pub icon_mods: Vec<IconMod>,
    /// Loose-file sound overrides: replace ANY game sound by staging a compiled
    /// `.vsnd_c` at its vanilla path (no soundevent editing). Complements `events`.
    #[serde(default)]
    pub sound_overrides: Vec<SoundOverride>,
    /// VFX recolor overrides: re-tint a game particle and stage the recompiled
    /// `.vpcf_c` at its vanilla path. Same whole-file override trick.
    #[serde(default)]
    pub effect_overrides: Vec<EffectOverride>,
    /// Gameplay config overrides (Custom Server tab): edits to ability properties
    /// in `scripts/abilities.vdata`, compiled into a single `abilities.vdata_c`
    /// override. Keyed by (abilityKey, propKey).
    #[serde(default)]
    pub vdata_overrides: Vec<VdataOverride>,
    /// Global match-wide edits (Custom Server → Global stats): values in
    /// `scripts/generic_data.vdata`, compiled into a `generic_data.vdata_c` override.
    #[serde(default)]
    pub global_overrides: Vec<GlobalOverride>,
    /// World-entity edits (Custom Server → Minions/Boxes/Powerups): flat scalar
    /// fields in `scripts/npc_units.vdata` / `scripts/misc.vdata`.
    #[serde(default)]
    pub world_overrides: Vec<WorldOverride>,
}

/// One edited field on a flat-scalar world entity (minion / box / powerup),
/// scoped by file + entity + field name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldOverride {
    /// e.g. `scripts/npc_units.vdata`.
    pub file: String,
    /// Entity key, e.g. `trooper_normal`.
    pub entity: String,
    /// Field name, e.g. `m_nMaxHealth`.
    pub field: String,
    /// New value.
    pub value: String,
}

/// One edited global field in `generic_data.vdata`, matched by its (unique) name.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalOverride {
    /// Field name, e.g. `m_nTier1GoldKill`.
    pub key: String,
    /// New value (string; bare number, no quotes in the file).
    pub value: String,
}

/// One edited ability property in `abilities.vdata`. The compile step decompiles
/// the vanilla file, rewrites this property's `m_strValue`, strips the `_include`
/// block, recompiles, and stages `scripts/abilities.vdata_c`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VdataOverride {
    /// Ability entity key, e.g. `ability_incendiary_projectile`.
    pub ability_key: String,
    /// Property key inside `m_mapAbilityProperties`, e.g. `AbilityCooldownBetweenCharge`.
    pub prop_key: String,
    /// New value to store (kept as a string so unit suffixes like `20m` survive).
    pub value: String,
}

/// A particle (VFX) recolor: decompile the vanilla `.vpcf`, hue/sat-shift every
/// color literal, recompile, and stage the `.vpcf_c` at `target_ref`'s path so it
/// shadows the game's own particle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectOverride {
    /// Stable id (e.g. `fx_particles_abilities_aoe_silence_cast`).
    pub id: String,
    /// The vanilla `.vpcf` reference to shadow, e.g.
    /// `particles/abilities/aoe_silence_cast.vpcf`.
    pub target_ref: String,
    /// Friendly label (defaults to the file stem).
    pub label: String,
    /// Hue rotation in degrees applied to every color literal (-180..180).
    /// For `rainbow`/`pulse` this is a phase/base-hue offset.
    #[serde(default)]
    pub hue: f32,
    /// Saturation multiplier (1.0 = unchanged).
    #[serde(default = "one")]
    pub saturation: f32,
    /// Color mode: "static" (hue/sat shift) | "rainbow" | "pulse" (animated over
    /// particle lifetime).
    #[serde(default = "static_mode")]
    pub mode: String,
    /// Hash recorded after the last successful compile (null = never compiled).
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

fn static_mode() -> String {
    "static".to_string()
}

fn one() -> f32 {
    1.0
}

/// A loose-file sound replacement: the user's audio, processed and compiled to a
/// `.vsnd_c`, staged at `target_ref`'s path so it shadows the game's own file.
/// No soundevents are touched (the "named the same as vanilla" override trick).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SoundOverride {
    /// Stable id (e.g. `snd_sounds_vo_atlas_x`).
    pub id: String,
    /// The vanilla `.vsnd` reference to shadow, e.g.
    /// `sounds/vo/atlas/atlas_ally_x.vsnd`. Drives both the compiled output path
    /// and the in-VPK staging path.
    pub target_ref: String,
    /// Friendly label (defaults to the file stem).
    pub label: String,
    /// Absolute path to the user's source audio.
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
    /// Hash recorded after the last successful compile (null = never compiled).
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
}

/// One custom icon: a user image that, on compile, is scaled + compiled to a
/// `.vtex_c` and staged at `target_vtexc` so it overrides the game's icon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconMod {
    pub id: String,
    /// Display label (e.g. the item name).
    pub name: String,
    /// The compiled vtex_c path the game references — the override target inside
    /// the VPK, e.g. `panorama/images/items/weapon/alchemical_fire_psd.vtex_c`.
    pub target_vtexc: String,
    /// Absolute path to the user's source PNG/JPG.
    pub source_image: String,
    /// Native icon size to scale the source to.
    pub width: u32,
    pub height: u32,
    /// Hue rotation applied on compile, in degrees (-180..180). 0 = unchanged.
    #[serde(default)]
    pub hue: f32,
}

fn default_sound_folder() -> String {
    "sounds/music/match_intro".to_string()
}

fn default_array_key() -> String {
    "vsnd_files".to_string()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsFile {
    /// Preferred source if present: a KV3 text `.vsndevts` on disk.
    #[serde(default)]
    pub source_vsndevts_path: Option<String>,
    /// Fallback: extract + decompile the events file from this pak.
    #[serde(default)]
    pub from_pak_path: Option<String>,
    /// Path of the events file inside that pak.
    #[serde(default)]
    pub internal_events_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    #[serde(default = "default_ffmpeg")]
    pub ffmpeg_path: String,
    #[serde(default)]
    pub resource_compiler_path: Option<String>,
    #[serde(default)]
    pub vpk_helper_path: Option<String>,
}

fn default_ffmpeg() -> String {
    "ffmpeg".to_string()
}

impl Default for Tools {
    fn default() -> Self {
        Tools {
            ffmpeg_path: default_ffmpeg(),
            resource_compiler_path: None,
            vpk_helper_path: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputMode {
    Folder,
    Vpk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub mode: OutputMode,
    #[serde(default = "default_vpk_name")]
    pub vpk_name: String,
    #[serde(default)]
    pub output_dir: String,
}

fn default_vpk_name() -> String {
    "pak01_dir.vpk".to_string()
}

impl Default for Output {
    fn default() -> Self {
        Output {
            mode: OutputMode::Folder,
            vpk_name: default_vpk_name(),
            output_dir: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DurationMode {
    Auto,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventProject {
    /// Stable unique slot id (e.g. `intro_king`, `urn_contest_enemy`).
    #[serde(default)]
    pub id: String,
    /// Tab/group this slot belongs to (e.g. `intro`, `urn`).
    #[serde(default)]
    pub group: String,
    /// UI label for the slot, e.g. `"King"`, `"Carrying urn"`.
    pub side: String,
    /// Top-level event key in the `.vsndevts`.
    pub event_name: String,
    /// Which array within the event to manage (default `vsnd_files`).
    #[serde(default = "default_array_key")]
    pub array_key: String,
    /// Valve's stock entry (full reference string); always kept first.
    pub stock_entry: String,
    pub vsnd_duration_mode: DurationMode,
    #[serde(default)]
    pub vsnd_duration_manual: Option<f64>,
    #[serde(default)]
    pub songs: Vec<Song>,
    /// Reference strings (full `.vsnd` refs) we owned last compile, so renames /
    /// removals clean up correctly.
    #[serde(default)]
    pub previous_owned_names: Vec<String>,
    /// Stock/foreign reference strings the user has DISABLED (excluded from the
    /// compiled array). Empty = keep everything (default safe behavior).
    #[serde(default)]
    pub excluded_entries: Vec<String>,
    /// Stock/foreign reference strings the user has REMOVED from the pool (hidden
    /// from the UI and excluded from the array; restorable).
    #[serde(default)]
    pub removed_entries: Vec<String>,
    /// Entries adopted from other mods into this slot (shown in the pool; their
    /// compiled audio is bundled from `source_vpk`). Part of the project.
    #[serde(default)]
    pub adopted: Vec<AdoptedEntry>,
    /// Which soundevent file this slot's event lives in, relative to the
    /// soundevents root (e.g. `soundevents/music.vsndevts` or
    /// `soundevents/hero/punkgoat.vsndevts`).
    #[serde(default = "default_events_relpath")]
    pub events_relpath: String,
}

fn default_events_relpath() -> String {
    "soundevents/music.vsndevts".to_string()
}

/// An entry adopted from another mod into a slot (kept at the mod's original
/// compiled quality; convertible to an editable Song via the UI's Edit button).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedEntry {
    /// Full `.vsnd` reference written into the array.
    pub reference: String,
    /// The mod vpk the compiled `.vsnd_c` is extracted from on compile.
    pub source_vpk: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub label: String,
    /// Absolute path to the user's original audio file.
    pub source_mp3: String,
    /// Base name; drives the reference + `.vsnd_c` path (already sanitized).
    pub sound_name: String,
    pub trim_start: f64,
    pub trim_end: f64,
    pub gain_db: f64,
    /// Fade-in duration in seconds (0 = none).
    #[serde(default)]
    pub fade_in: f64,
    /// Fade-out duration in seconds (0 = none).
    #[serde(default)]
    pub fade_out: f64,
    /// Whether this track should loop (writes a loop block to encoding.txt).
    #[serde(default)]
    pub looping: bool,
    pub order: u32,
    /// Hash of `{trim, gain, sourceMp3}`; null until first compile.
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
    /// When this track was converted from a mod pack ("absorb" / edit-adopted):
    /// the original `.vsnd` reference. Lets a re-import of the same pack skip
    /// tracks that were already converted instead of doubling them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub imported_ref: Option<String>,
}

/// Build an empty slot (no songs) with sensible defaults.
#[allow(clippy::too_many_arguments)]
fn slot(
    id: &str,
    group: &str,
    label: &str,
    event_name: &str,
    array_key: &str,
    stock_entry: &str,
    events_relpath: &str,
) -> EventProject {
    EventProject {
        id: id.into(),
        group: group.into(),
        side: label.into(),
        event_name: event_name.into(),
        array_key: array_key.into(),
        stock_entry: stock_entry.into(),
        vsnd_duration_mode: DurationMode::Auto,
        vsnd_duration_manual: None,
        songs: vec![],
        previous_owned_names: vec![],
        excluded_entries: vec![],
        removed_entries: vec![],
        adopted: vec![],
        events_relpath: events_relpath.into(),
    }
}

impl Project {
    /// A fresh project pre-populated with the match-intro and urn (Idol) slots.
    pub fn default_for_match_intro() -> Self {
        Project {
            version: PROJECT_VERSION,
            game_content_root: String::new(),
            sound_folder: default_sound_folder(),
            events_file: EventsFile::default(),
            tools: Tools::default(),
            output: Output::default(),
            events: vec![
                // --- Tab: Deadlock Intro ---
                slot(
                    "intro_king",
                    "intro",
                    "King",
                    "Music.MatchIntro.MatchStart.King",
                    "vsnd_files",
                    "sounds/music/match_intro/music_match_intro_king_160bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "intro_mother",
                    "intro",
                    "Mother",
                    "Music.MatchIntro.MatchStart.Mother",
                    "vsnd_files",
                    "sounds/music/match_intro/music_match_intro_mother_160bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab: Urn Music (the game calls the urn the "Idol") ---
                slot(
                    "urn_carry",
                    "urn",
                    "Carrying urn",
                    "Music.Idol.Pickup.Lp",
                    "vsnd_files",
                    // Reworked patch: the carry loop is now the 141bpm track (the
                    // old music_idol_carry_lp.vsnd was retired). Refresh self-heals
                    // a drifted pin, but this keeps fresh projects accurate.
                    "sounds/music/music_idol_carry_lp_141bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // The rework added a separate distant-distance crossfade layer of
                // the carry loop (plays when far from the carrier). Same event, a
                // different array key — mod it to match your carry track up close.
                slot(
                    "urn_carry_distant",
                    "urn",
                    "Carrying urn (distant mix)",
                    "Music.Idol.Pickup.Lp",
                    "vsnd_files_distance_xfade",
                    "sounds/music/music_idol_carry_distant_lp_141bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "urn_contest_team",
                    "urn",
                    "Contest (your team)",
                    "Music.Idol.Timer.Lp",
                    "vsnd_files",
                    "sounds/music/music_idol_timer_lp_team_160bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "urn_contest_enemy",
                    "urn",
                    "Contest (enemy team)",
                    "Music.Idol.Timer.Lp",
                    "vsnd_files_opponent_control",
                    "sounds/music/music_idol_timer_lp_opponent_160bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // NOTE: Stinger.Idol.PickedUp and the bare Stinger.Idol.Returned
                // existed in older builds but were removed from the live game (only
                // the .Team/.Opponent variants remain), so they're not slots here.
                slot(
                    "urn_stinger_returned_team",
                    "urn",
                    "Stinger: returned (your team)",
                    "Stinger.Idol.Returned.Team",
                    "vsnd_files",
                    "sounds/music/music_idol_return_team.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "urn_stinger_returned_enemy",
                    "urn",
                    "Stinger: returned (enemy)",
                    "Stinger.Idol.Returned.Opponent",
                    "vsnd_files",
                    "sounds/music/music_idol_return_opponent.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "urn_stinger_announce",
                    "urn",
                    "Stinger: drop announced",
                    "Stinger.Idol.AnnounceDrop",
                    "vsnd_files",
                    "sounds/music/music_idol_announce.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab (Map): Rift (the new King-of-the-Hill objective; the
                //     game names these events "Koth"). These are the musical
                //     stingers from music.vsndevts. NOTE: the capture LOOP music
                //     (Music.Koth.Capture.Lp) is driven by a soundstack
                //     (soundstack_citadel_music_koth_capture) with no vsnd_files
                //     array, so it can't be merged with the current tooling and is
                //     intentionally not a slot here. ---
                slot(
                    "rift_announce",
                    "rift",
                    "Rift announced",
                    "Stinger.Koth.Announce",
                    "vsnd_files",
                    "sounds/music/music_koth_announce.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "rift_win",
                    "rift",
                    "Rift captured (your team)",
                    "Stinger.Koth.Win",
                    "vsnd_files",
                    "sounds/music/music_koth_win.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "rift_lose",
                    "rift",
                    "Rift captured (enemy)",
                    "Stinger.Koth.Lose",
                    "vsnd_files",
                    "sounds/music/music_koth_lose.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "rift_expire",
                    "rift",
                    "Rift expired",
                    "Stinger.Koth.Expire",
                    "vsnd_files",
                    "sounds/music/music_koth_expire.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab (Map): Midboss (arrival stinger + the Rejuvenator drop) ---
                slot(
                    "midboss_arrived",
                    "midboss",
                    "Mid-boss arrived",
                    "Stinger.MidBoss.Arrived",
                    "vsnd_files",
                    "sounds/music/music_stinger_mid_boss_arrived.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "midboss_rejuv_descent",
                    "midboss",
                    "Rejuvenator descending",
                    "Stinger.Rejuvinator.Descent",
                    "vsnd_files",
                    "sounds/music/music_stinger_rejuv_drop_6s.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "midboss_rejuv_claim_team",
                    "midboss",
                    "Rejuvenator claimed (your team)",
                    "Stinger.Rejuvinator.Claimed.Friendly",
                    "vsnd_files",
                    "sounds/music/music_stinger_rejuv_won.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "midboss_rejuv_claim_enemy",
                    "midboss",
                    "Rejuvenator claimed (enemy)",
                    "Stinger.Rejuvinator.Claimed.Enemy",
                    "vsnd_files",
                    "sounds/music/music_stinger_rejuv_lost.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "midboss_rejuv_respawn",
                    "midboss",
                    "Rejuvenator respawn",
                    "Stinger.Respawn.Rejuvinator",
                    "vsnd_files",
                    "sounds/music/music_stinger_rejuv_won.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "midboss_rejuv_expired",
                    "midboss",
                    "Rejuvenator expired",
                    "Stinger.Rejuvinator.Expired",
                    "vsnd_files",
                    "sounds/music/music_stinger_rejuv_lost.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // The midboss's own in-world SFX (the horn etc.) live in
                // gameplay.vsndevts, separate from the music stingers above.
                slot(
                    "midboss_horn",
                    "midboss",
                    "Arrival horn (in-world)",
                    "MidBoss.Arrive",
                    "vsnd_files",
                    "sounds/gameplay/midboss_arrive.vsnd",
                    "soundevents/gameplay.vsndevts",
                ),
                slot(
                    "midboss_lowhealth",
                    "midboss",
                    "Low health",
                    "MidBoss.LowHealth",
                    "vsnd_files",
                    "sounds/gameplay/midboss_lowhealth.vsnd",
                    "soundevents/gameplay.vsndevts",
                ),
                slot(
                    "midboss_death",
                    "midboss",
                    "Death",
                    "MidBoss.Death",
                    "vsnd_files",
                    "sounds/gameplay/midboss_death.vsnd",
                    "soundevents/gameplay.vsndevts",
                ),
                // --- Tab (Map): Powerups (world powerup category loops, in
                //     soundevents/world.vsndevts). The game ships 4 looping
                //     category tracks; there is no Spirit loop event (the
                //     powerup_spirit_lp file is unreferenced). ---
                slot(
                    "powerup_casting",
                    "powerups",
                    "Casting",
                    "Powerup.Casting_Lp",
                    "vsnd_files",
                    "sounds/world/powerup/powerup_casting_lp.vsnd",
                    "soundevents/world.vsndevts",
                ),
                slot(
                    "powerup_gun",
                    "powerups",
                    "Gun",
                    "Powerup.Gun_Lp",
                    "vsnd_files",
                    "sounds/world/powerup/powerup_gun_lp.vsnd",
                    "soundevents/world.vsndevts",
                ),
                slot(
                    "powerup_movement",
                    "powerups",
                    "Movement",
                    "Powerup.Movement_Lp",
                    "vsnd_files",
                    "sounds/world/powerup/powerup_movement_lp.vsnd",
                    "soundevents/world.vsndevts",
                ),
                slot(
                    "powerup_survival",
                    "powerups",
                    "Survival",
                    "Powerup.Survival_Lp",
                    "vsnd_files",
                    "sounds/world/powerup/powerup_survival_lp.vsnd",
                    "soundevents/world.vsndevts",
                ),
                // --- Tab (Map): Team Objectives (tower / guardian / patron kills) ---
                slot(
                    "obj_guardian_team",
                    "teamobj",
                    "Guardian killed (your team)",
                    "Stinger.Tier1.Killed.Friendly",
                    "vsnd_files",
                    "sounds/music/music_stinger_t1_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_guardian_enemy",
                    "teamobj",
                    "Guardian killed (enemy)",
                    "Stinger.Tier1.Killed.Enemy",
                    "vsnd_files",
                    "sounds/music/music_stinger_t1_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_walker_team",
                    "teamobj",
                    "Walker killed (your team)",
                    "Stinger.Tier2.Killed.Friendly",
                    "vsnd_files",
                    "sounds/music/music_stinger_t1_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_walker_enemy",
                    "teamobj",
                    "Walker killed (enemy)",
                    "Stinger.Tier2.Killed.Enemy",
                    "vsnd_files",
                    "sounds/music/music_stinger_t1_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_shrine_team",
                    "teamobj",
                    "Patron shield killed (your team)",
                    "Stinger.TitanShield1.Killed.Friendly",
                    "vsnd_files",
                    "sounds/music/music_stinger_generator_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_shrine_enemy",
                    "teamobj",
                    "Patron shield killed (enemy)",
                    "Stinger.TitanShield1.Killed.Enemy",
                    "vsnd_files",
                    "sounds/music/music_stinger_generator_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_patron_team",
                    "teamobj",
                    "Patron killed (your team)",
                    "Stinger.Titan.Killed.Friendly",
                    "vsnd_files",
                    "sounds/music/music_stinger_t3_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "obj_patron_enemy",
                    "teamobj",
                    "Patron killed (enemy)",
                    "Stinger.Titan.Killed.Enemy",
                    "vsnd_files",
                    "sounds/music/music_stinger_t3_killed.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab: Heroes (Billy = "PunkGoat") ---
                slot(
                    "hero_billy_blasted",
                    "heroes",
                    "Billy — Blasted (E)",
                    "Punkgoat.Blasted.Lp",
                    "vsnd_files",
                    "sounds/abilities/punkgoat/a3/punkgoat_blasted_lp.vsnd",
                    "soundevents/hero/punkgoat.vsndevts",
                ),
                // --- Tab: Shop Music (the in-game "Curio"/shop ambience) ---
                slot(
                    "shop_main",
                    "shop",
                    "Shop",
                    "Music.Shop",
                    "vsnd_files",
                    "sounds/music/menu/curio_music.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "shop_secret",
                    "shop",
                    "Shop (secret)",
                    "Music.Shop.Secret",
                    "vsnd_files",
                    "sounds/music/menu/curio_music_02.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab: UI (menu / pause music) ---
                slot(
                    "ui_pause",
                    "ui",
                    "Pause menu",
                    "Gameplay.Pause.Music.Lp",
                    "vsnd_files",
                    "sounds/common/null.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "ui_main_menu",
                    "ui",
                    "Main menu",
                    "Music.MainMenu",
                    "vsnd_files",
                    "sounds/music/music_menu_lp.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // Loading / connecting screen music (the long 60bpm track that
                // plays while the match map loads).
                slot(
                    "ui_loading_screen",
                    "ui",
                    "Loading screen",
                    "Music.MatchIntro.Connecting",
                    "vsnd_files",
                    "sounds/music/match_intro/music_match_intro_connecting_60bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // Matchmaking SFX (single-sound events in ui.vsndevts — the merger
                // promotes the scalar to an array when our entries are added).
                slot(
                    "ui_match_found",
                    "ui",
                    "Match found",
                    "UI.Matchmake.Made",
                    "vsnd_files",
                    "sounds/ui/ui_game_matchmake_made.vsnd",
                    "soundevents/ui.vsndevts",
                ),
                slot(
                    "ui_match_searching",
                    "ui",
                    "Searching for match",
                    "UI.Matchmake.Find",
                    "vsnd_files",
                    "sounds/ui/ui_game_matchmake_find.vsnd",
                    "soundevents/ui.vsndevts",
                ),
                // --- Tab (Match): Match Music (match-flow music outside the intro) ---
                slot(
                    "match_title",
                    "match",
                    "Title screen",
                    "Music.Title",
                    "vsnd_files",
                    "sounds/music/music_title_155bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_formed",
                    "match",
                    "Match formed",
                    "Music.Match.Formed",
                    "vsnd_files",
                    "sounds/common/null.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_gamestart",
                    "match",
                    "Game start announce",
                    "Map.Broadcast.GameStart",
                    "vsnd_files",
                    "sounds/ui/match_start_01.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_win",
                    "match",
                    "Match won",
                    "Music.Match.Win",
                    "vsnd_files",
                    "sounds/music/music_stinger_game_over_win.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_lose",
                    "match",
                    "Match lost",
                    "Music.Match.Lose",
                    "vsnd_files",
                    "sounds/music/music_stinger_game_over_lose.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_postgame",
                    "match",
                    "Post-game",
                    "Music.PostGame",
                    "vsnd_files",
                    "sounds/music/music_postgame_155bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_base_attack",
                    "match",
                    "Base under attack",
                    "Music.Base.Attack",
                    "vsnd_files",
                    "sounds/music/music_core_exposed_lp.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "match_zipline",
                    "match",
                    "Riding zipline",
                    "Music.Zipline.Lp",
                    "vsnd_files",
                    "sounds/music/music_silence_1s_loop.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab (Match): Stingers (death/respawn + the kill-streak ladder) ---
                slot(
                    "stinger_death",
                    "stingers",
                    "Your death",
                    "Stinger.Death",
                    "vsnd_files",
                    "sounds/music/music_stinger_player_death.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_respawn",
                    "stingers",
                    "Respawn",
                    "Stinger.Respawn",
                    "vsnd_files",
                    "sounds/music/music_stinger_player_respawn.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_respawn_countdown",
                    "stingers",
                    "Respawn countdown",
                    "Stinger.Respawn.Countdown",
                    "vsnd_files",
                    "sounds/music/music_stinger_player_respawn_countdown.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_core_exposed",
                    "stingers",
                    "Core exposed",
                    "Stinger.CoreExposed",
                    "vsnd_files",
                    "sounds/common/null.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_first_blood",
                    "stingers",
                    "First blood",
                    "Stinger.KillStreak.FirstBlood",
                    "vsnd_files",
                    "sounds/music/music_stinger_first_blood.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // NOTE: "stringer" typo below is Valve's, in the live game data.
                slot(
                    "stinger_killstreak",
                    "stingers",
                    "Kill streak (generic)",
                    "Stinger.KillStreak",
                    "vsnd_files",
                    "sounds/music/music_stringer_kill_streak.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_01",
                    "stingers",
                    "Kill streak 1",
                    "Stinger.KillStreak_01",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_01.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_02",
                    "stingers",
                    "Kill streak 2",
                    "Stinger.KillStreak_02",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_02.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_03",
                    "stingers",
                    "Kill streak 3",
                    "Stinger.KillStreak_03",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_03.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_04",
                    "stingers",
                    "Kill streak 4",
                    "Stinger.KillStreak_04",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_04.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_05",
                    "stingers",
                    "Kill streak 5",
                    "Stinger.KillStreak_05",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_05.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_06",
                    "stingers",
                    "Kill streak 6",
                    "Stinger.KillStreak_06",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_06.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_07",
                    "stingers",
                    "Kill streak 7",
                    "Stinger.KillStreak_07",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_07.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_08",
                    "stingers",
                    "Kill streak 8",
                    "Stinger.KillStreak_08",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_08.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_09",
                    "stingers",
                    "Kill streak 9",
                    "Stinger.KillStreak_09",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_09.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "stinger_ks_10",
                    "stingers",
                    "Kill streak 10",
                    "Stinger.KillStreak_10",
                    "vsnd_files",
                    "sounds/music/music_stinger_ks_10.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab (Match): Brawl mode music ---
                slot(
                    "brawl_titles",
                    "brawl",
                    "Titles",
                    "Music.Brawl.Titles",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_titles_117bpm-95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round1",
                    "brawl",
                    "Round 1 start",
                    "Music.Brawl.RoundStart1",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_1_start_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round2",
                    "brawl",
                    "Round 2 start",
                    "Music.Brawl.RoundStart2",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_2_start_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round3",
                    "brawl",
                    "Round 3 start",
                    "Music.Brawl.RoundStart3",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_3_start_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round4",
                    "brawl",
                    "Round 4 start",
                    "Music.Brawl.RoundStart4",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_4_start_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round5",
                    "brawl",
                    "Round 5 start",
                    "Music.Brawl.RoundStart5",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_5_start_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round_won",
                    "brawl",
                    "Round won",
                    "Music.Brawl.Round.Won",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_won_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_round_lost",
                    "brawl",
                    "Round lost",
                    "Music.Brawl.Round.Lost",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_round_lost_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_match_won",
                    "brawl",
                    "Match won",
                    "Music.Brawl.Match.Won",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_match_won_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_match_lost",
                    "brawl",
                    "Match lost",
                    "Music.Brawl.Match.Lost",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_match_lost_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                slot(
                    "brawl_overtime",
                    "brawl",
                    "Overtime announce",
                    "Stinger.Brawl.Overtime.Announce",
                    "vsnd_files",
                    "sounds/music/brawl/music_brawl_overtime_95bpm.vsnd",
                    "soundevents/music.vsndevts",
                ),
                // --- Tab (Game SFX): Gameplay (hit feedback: crits, last hits) ---
                slot(
                    "gameplay_crit_send",
                    "gameplay",
                    "Crit (you deal)",
                    "Damage.Send.Crit",
                    "vsnd_files",
                    "sounds/hit_indicators/damage_send_crit_01.vsnd",
                    "soundevents/damage.vsndevts",
                ),
                slot(
                    "gameplay_crit_receive",
                    "gameplay",
                    "Crit (you receive)",
                    "Damage.Receive.Crit",
                    "vsnd_files",
                    "sounds/hit_indicators/damage_send_crit_01.vsnd",
                    "soundevents/damage.vsndevts",
                ),
                slot(
                    "gameplay_lasthit",
                    "gameplay",
                    "Last hit",
                    "LastHit.Default",
                    "vsnd_files",
                    "sounds/hit_indicators/damage_send_lethal_01.vsnd",
                    "soundevents/gameplay.vsndevts",
                ),
                slot(
                    "gameplay_deny",
                    "gameplay",
                    "Deny",
                    "Player.Deny",
                    "vsnd_files",
                    "sounds/gameplay/orbs/xp_orbs_local_player_deny_01.vsnd",
                    "soundevents/gameplay.vsndevts",
                ),
            ],
            icon_mods: vec![],
            sound_overrides: vec![],
            effect_overrides: vec![],
            vdata_overrides: vec![],
            global_overrides: vec![],
            world_overrides: vec![],
        }
    }

    pub fn load(path: &Path) -> std::io::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        serde_json::from_str(&text)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_project_roundtrips_through_json() {
        let p = Project::default_for_match_intro();
        let json = serde_json::to_string_pretty(&p).unwrap();
        let back: Project = serde_json::from_str(&json).unwrap();
        assert_eq!(back.events.len(), 81);
        assert_eq!(back.events[0].id, "intro_king");
        // The match-flow / stinger / brawl groups are present.
        assert!(back.events.iter().any(|e| e.id == "match_win"
            && e.event_name == "Music.Match.Win"
            && e.group == "match"));
        assert!(back.events.iter().any(|e| e.id == "stinger_ks_10"
            && e.event_name == "Stinger.KillStreak_10"
            && e.group == "stingers"));
        assert!(back.events.iter().any(|e| e.id == "brawl_overtime"
            && e.event_name == "Stinger.Brawl.Overtime.Announce"
            && e.group == "brawl"));
        // The new Rift (KotH) objective slots are present.
        assert!(back.events.iter().any(|e| e.id == "rift_win"
            && e.event_name == "Stinger.Koth.Win"
            && e.group == "rift"));
        assert_eq!(back.events[0].event_name, "Music.MatchIntro.MatchStart.King");
        // The enemy-contest slot targets the opponent-control array.
        let enemy = back.events.iter().find(|e| e.id == "urn_contest_enemy").unwrap();
        assert_eq!(enemy.array_key, "vsnd_files_opponent_control");
        // Billy lives in a different events file.
        let billy = back.events.iter().find(|e| e.id == "hero_billy_blasted").unwrap();
        assert_eq!(billy.events_relpath, "soundevents/hero/punkgoat.vsndevts");
        assert!(matches!(back.output.mode, OutputMode::Folder));
    }
}
