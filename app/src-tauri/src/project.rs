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
    #[serde(default)]
    pub hue: f32,
    /// Saturation multiplier (1.0 = unchanged).
    #[serde(default = "one")]
    pub saturation: f32,
    /// Hash recorded after the last successful compile (null = never compiled).
    #[serde(default)]
    pub last_compiled_hash: Option<String>,
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
                    "sounds/music/music_idol_carry_lp.vsnd",
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
            ],
            icon_mods: vec![],
            sound_overrides: vec![],
            effect_overrides: vec![],
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
        assert_eq!(back.events.len(), 31);
        assert_eq!(back.events[0].id, "intro_king");
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
