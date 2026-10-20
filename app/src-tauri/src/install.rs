//! One-click install into Deadlock's `game/citadel/addons` folder.
//!
//! Deadlock mounts addon VPKs named `pakNN_dir.vpk` (NN = 01..99). Mod managers
//! and manual installs share that 1..99 slot space — a file is "in" a slot if its
//! name ends with `pak<NN>_dir.vpk`, whether plain (`pak07_dir.vpk`) or prefixed
//! (`600744_pak07_dir.vpk`, `..._cool-mod-pak20_dir.vpk`). We pick a free slot (or
//! a caller-chosen one to replace), copy our compiled VPK in, and make sure
//! `gameinfo.gi` actually mounts `citadel/addons`.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Highest addon slot Deadlock will load.
pub const MAX_SLOT: u32 = 99;

/// The slot number a filename occupies, if any. Matches the trailing
/// `pak<digits>_dir.vpk` of the name regardless of any prefix, so plain and
/// workshop-/manager-prefixed files share the same slot space.
fn slot_of(filename: &str) -> Option<u32> {
    let lower = filename.to_lowercase();
    let stem = lower.strip_suffix("_dir.vpk")?;
    let pak_idx = stem.rfind("pak")?;
    let digits = &stem[pak_idx + 3..];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok()
}

/// Every slot 1..=99 currently occupied by some file in `addons_dir` (sorted).
pub fn used_slots(addons_dir: &Path) -> Vec<u32> {
    let mut used: Vec<u32> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(addons_dir) {
        for entry in rd.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if let Some(n) = slot_of(name) {
                    if (1..=MAX_SLOT).contains(&n) && !used.contains(&n) {
                        used.push(n);
                    }
                }
            }
        }
    }
    used.sort_unstable();
    used
}

/// Lowest free slot in 1..=99, or None if every slot is taken.
fn next_free_slot(used: &[u32]) -> Option<u32> {
    (1..=MAX_SLOT).find(|n| !used.contains(n))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotFile {
    pub slot: u32,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotScan {
    pub used: Vec<u32>,
    pub next_free: Option<u32>,
    pub max_slot: u32,
    /// Size of the PLAIN `pakNN_dir.vpk` in each used slot (the file our own
    /// installs write) - lets the UI tell "still my last install" from "someone
    /// else took this slot".
    pub files: Vec<SlotFile>,
}

/// `Game` values in gameinfo's SearchPaths that mount an addons folder
/// (`citadel/addons`, `citadel/addons/profile_x`, `citadel/addons2/profile_x`),
/// lowercased, in priority order. Comments are ignored.
fn addons_mounts(gameinfo_text: &str) -> Vec<String> {
    let lower = gameinfo_text.to_lowercase();
    let Some(sp) = lower.find("searchpaths") else { return vec![] };
    let Some(open) = lower[sp..].find('{').map(|i| sp + i) else { return vec![] };
    let close = lower[open..].find('}').map_or(lower.len(), |i| open + i);
    lower[open + 1..close]
        .lines()
        .filter_map(|l| {
            let l = l.split("//").next().unwrap_or("");
            let t: Vec<&str> = l.split_whitespace().collect();
            (t.len() >= 2 && t[0] == "game" && t[1].starts_with("citadel/addons"))
                .then(|| t[1].trim_end_matches('/').to_string())
        })
        .collect()
}

/// The folder the game actually loads addon paks from. Normally the given
/// `game/citadel/addons`, but Deadlock Mod Manager mounts a PROFILE subfolder
/// instead (`Game citadel/addons/profile_default`, its own `Mod`/`Write citadel`
/// lines between "// Deadlock Mod Manager" markers) and never the addons root,
/// so a pak dropped in the root silently never loads (support report
/// 2026-10-20: "compile + install, nothing changes in game"). When gameinfo has
/// no plain `citadel/addons` mount but does mount a folder below/beside it, that
/// folder (the top-priority one) is where paks belong. Returns
/// `(dir, Some(mount))` when redirected.
pub fn mounted_addons_dir(addons_dir: &Path) -> (PathBuf, Option<String>) {
    let unchanged = (addons_dir.to_path_buf(), None);
    let Some(citadel) = addons_dir.parent() else { return unchanged };
    let Ok(text) = std::fs::read_to_string(citadel.join("gameinfo.gi")) else { return unchanged };
    let mounts = addons_mounts(&text);
    if mounts.is_empty() || mounts.iter().any(|m| m == "citadel/addons") {
        return unchanged;
    }
    let rel = mounts[0].trim_start_matches("citadel/");
    if rel.split('/').any(|seg| seg.is_empty() || seg == "..") {
        return unchanged;
    }
    (citadel.join(rel), Some(mounts[0].clone()))
}

/// Scan the addons folder for occupied slots + the next free one (for the UI).
/// Scans the folder installs actually go to (see `mounted_addons_dir`).
pub fn scan_slots(addons_dir: &Path) -> SlotScan {
    let (addons_dir, _) = mounted_addons_dir(addons_dir);
    let addons_dir = addons_dir.as_path();
    let used = used_slots(addons_dir);
    let next_free = next_free_slot(&used);
    let files = used
        .iter()
        .filter_map(|&slot| {
            std::fs::metadata(addons_dir.join(format!("pak{slot:02}_dir.vpk")))
                .ok()
                .map(|m| SlotFile { slot, bytes: m.len() })
        })
        .collect();
    SlotScan { used, next_free, max_slot: MAX_SLOT, files }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    /// The slot we installed into.
    pub slot: u32,
    /// Absolute path of the installed `pakNN_dir.vpk`.
    pub target: String,
    /// We overwrote an existing file in that slot.
    pub replaced: bool,
    /// Backup path of the file we overwrote, if any.
    pub backup: Option<String>,
    /// We added the `citadel/addons` search path to gameinfo.gi.
    pub gameinfo_patched: bool,
    /// Human note about the gameinfo step (already present / patched / skipped).
    pub gameinfo_note: String,
    /// Size of the installed file - remembered by the UI so the NEXT auto
    /// install can prove the slot still holds this exact install.
    pub bytes: u64,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Install `src_vpk` into `addons_dir`.
///
/// - `slot: Some(n)` installs into (and overwrites) slot `n`; `None` auto-picks
///   a slot: the remembered `reuse` slot when it still holds our previous
///   install (exact size match on the plain `pakNN_dir.vpk`), else the lowest
///   free slot. That keeps "Auto" replacing YOUR OWN pak on recompiles instead
///   of stacking new slots, without ever clobbering a slot another mod took.
/// - An existing file in the chosen slot is backed up under
///   `addons_dir/.eim_backups/` before being overwritten (install aborts rather
///   than destroy a file it can't back up).
/// - `patch_gameinfo` adds the `citadel/addons` search path to the sibling
///   `gameinfo.gi` if it's missing (with its own backup).
pub fn install(
    src_vpk: &Path,
    addons_dir: &Path,
    slot: Option<u32>,
    reuse: Option<(u32, u64)>,
    patch_gameinfo: bool,
) -> Result<InstallResult, String> {
    if !src_vpk.exists() {
        return Err(format!("source vpk not found: {}", src_vpk.display()));
    }
    // Another manager's mounted folder (Deadlock Mod Manager profile) wins over
    // the configured root; that manager owns gameinfo, so leave it alone.
    let (mounted, redirect) = mounted_addons_dir(addons_dir);
    if let Some(m) = &redirect {
        if !mounted.is_dir() {
            return Err(format!(
                "gameinfo.gi loads mods from {m}, but that folder doesn't exist: {}",
                mounted.display()
            ));
        }
    }
    let addons_dir = mounted.as_path();
    if !addons_dir.is_dir() {
        // A fresh Deadlock install has no addons folder yet - create it when
        // the path is the real game/citadel/addons (its parent holds
        // gameinfo.gi); anything else is a wrong path, not a missing one.
        let parent_ok = addons_dir.parent().map_or(false, |p| p.join("gameinfo.gi").is_file());
        if !parent_ok {
            return Err(format!("addons folder not found: {}", addons_dir.display()));
        }
        std::fs::create_dir_all(addons_dir)
            .map_err(|e| format!("creating addons folder {}: {e}", addons_dir.display()))?;
    }

    let used = used_slots(addons_dir);
    let slot = match slot {
        Some(n) => {
            if !(1..=MAX_SLOT).contains(&n) {
                return Err(format!("slot must be 1..={MAX_SLOT} (got {n})"));
            }
            n
        }
        None => {
            // Reuse the remembered slot only while the file there is still the
            // exact one we wrote (checked NOW, not against a stale UI scan).
            let reused = reuse.filter(|(rs, rb)| {
                (1..=MAX_SLOT).contains(rs)
                    && std::fs::metadata(addons_dir.join(format!("pak{rs:02}_dir.vpk")))
                        .map(|m| m.len() == *rb)
                        .unwrap_or(false)
            });
            match reused {
                Some((rs, _)) => rs,
                None => next_free_slot(&used)
                    .ok_or_else(|| format!("no free addon slots - all {MAX_SLOT} are in use"))?,
            }
        }
    };

    let target = addons_dir.join(format!("pak{slot:02}_dir.vpk"));

    // Back up an existing occupant before overwriting it.
    let (replaced, backup) = if target.exists() {
        let bak_dir = addons_dir.join(".eim_backups");
        std::fs::create_dir_all(&bak_dir)
            .map_err(|e| format!("creating backup dir: {e}"))?;
        let bak = bak_dir.join(format!("pak{slot:02}_dir.vpk.{}.bak", timestamp()));
        std::fs::copy(&target, &bak)
            .map_err(|e| format!("backing up existing pak{slot:02}_dir.vpk: {e}"))?;
        (true, Some(bak.to_string_lossy().into_owned()))
    } else {
        (false, None)
    };

    let bytes =
        std::fs::copy(src_vpk, &target).map_err(|e| format!("copying vpk into addons: {e}"))?;

    let (gameinfo_patched, gameinfo_note) = if let Some(m) = redirect {
        (
            false,
            format!("installed into {m}, the folder gameinfo.gi loads mods from (managed by another mod manager)"),
        )
    } else if patch_gameinfo {
        match ensure_addons_searchpath(addons_dir) {
            Ok((patched, note)) => (patched, note),
            // A gameinfo failure shouldn't undo a successful copy — surface as a note.
            Err(e) => (false, format!("gameinfo not patched: {e}")),
        }
    } else {
        (false, "skipped".into())
    };

    Ok(InstallResult {
        slot,
        target: target.to_string_lossy().into_owned(),
        replaced,
        backup,
        gameinfo_patched,
        gameinfo_note,
        bytes,
    })
}

/// Ensure `gameinfo.gi` (sibling of the addons dir) mounts `citadel/addons`.
/// Returns `(patched, note)`. Non-destructive: only inserts the search path when
/// it's genuinely absent, and backs the file up first.
fn ensure_addons_searchpath(addons_dir: &Path) -> Result<(bool, String), String> {
    let gameinfo = addons_dir
        .parent()
        .map(|p| p.join("gameinfo.gi"))
        .ok_or("can't locate gameinfo.gi (addons has no parent)")?;
    let text = std::fs::read_to_string(&gameinfo)
        .map_err(|e| format!("reading {}: {e}", gameinfo.display()))?;

    let (patched, note) = if addons_mounts(&text).iter().any(|m| m == "citadel/addons") {
        // Already mounted - but a bare mount from before the 2026-10-16 fix
        // (or another tool) makes the game refuse to start: repair it.
        match pin_mod_write(&text, "citadel/addons") {
            Some(p) => (p, "repaired the citadel/addons search path (game said user_keys_default)"),
            None => return Ok((false, "already enabled".into())),
        }
    } else {
        let p = add_top_game_path(&text, "citadel/addons")?;
        (
            pin_mod_write(&p, "citadel/addons").unwrap_or(p),
            "added citadel/addons search path",
        )
    };

    let bak = gameinfo.with_extension("gi.eim.bak");
    std::fs::copy(&gameinfo, &bak).map_err(|e| format!("backing up gameinfo.gi: {e}"))?;
    std::fs::write(&gameinfo, patched).map_err(|e| format!("writing gameinfo.gi: {e}"))?;
    Ok((true, note.into()))
}

/// `text` with `Game  <needle>` inserted right after the SearchPaths `{`,
/// i.e. TOP priority.
fn add_top_game_path(text: &str, needle: &str) -> Result<String, String> {
    let lower = text.to_lowercase();
    let sp = lower.find("searchpaths").ok_or("no SearchPaths block in gameinfo.gi")?;
    let brace = text[sp..]
        .find('{')
        .map(|i| sp + i)
        .ok_or("malformed SearchPaths block (no '{')")?;
    let insert_at = brace + 1;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut patched = String::with_capacity(text.len() + 48);
    patched.push_str(&text[..insert_at]);
    patched.push_str(&format!("{nl}\t\t\tGame\t\t\t\t{needle}"));
    patched.push_str(&text[insert_at..]);
    Ok(patched)
}

/// Keep `citadel` the MOD and WRITE path once a folder is mounted above it.
/// The engine takes both from the FIRST `Game` entry unless `Mod` / `Write`
/// lines say otherwise, so a bare `Game citadel/addons` on top makes the
/// addons folder the mod root. Since the 2026-10-16 patch the game then reads
/// its default config from there and stops at "FATAL ERROR: Unable to read
/// default keybinding configuration (user_keys_default)!" (reproduced on the
/// live game, no addons loaded). Other mod managers write the same pair.
/// Inserts whichever of the two lines is missing right after the line holding
/// `after_needle`; None when both are already there.
fn pin_mod_write(text: &str, after_needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let sp = lower.find("searchpaths")?;
    let open = sp + lower[sp..].find('{')?;
    let close = open + lower[open..].find('}')?;
    let has = |key: &str| {
        lower[open..close].lines().any(|l| {
            let t: Vec<&str> = l.split_whitespace().collect();
            t.len() >= 2 && t[0] == key && t[1] == "citadel"
        })
    };
    let missing: Vec<&str> = [("mod", "Mod"), ("write", "Write")]
        .iter()
        .filter(|(k, _)| !has(k))
        .map(|(_, name)| *name)
        .collect();
    if missing.is_empty() {
        return None;
    }
    let at = open + lower[open..close].find(&after_needle.to_lowercase())?;
    let eol = at + text[at..].find('\n').unwrap_or(text.len() - at);
    // Insert BEFORE the line break (keeps a `\r\n` file's endings intact).
    let eol = if eol > 0 && text.as_bytes().get(eol - 1) == Some(&b'\r') { eol - 1 } else { eol };
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::with_capacity(text.len() + 48);
    out.push_str(&text[..eol]);
    for name in missing {
        out.push_str(&format!("{nl}\t\t\t{name}\t\t\t\tcitadel"));
    }
    out.push_str(&text[eol..]);
    Some(out)
}

/// Ensure `gameinfo.gi` (inside `citadel_dir`) mounts `citadel/<rel>` as a
/// loose search path, inserted right after the SearchPaths `{` — i.e. TOP
/// priority, above addons and the paks. Idempotent, backs gameinfo up first.
/// Used by the UI Master dev push (`citadel/eim_dev`) — deliberately OUR own
/// dir: other launchers (e.g. GRIMOIRE) inject their own the same way, and
/// we stay out of theirs.
pub(crate) fn ensure_citadel_searchpath(citadel_dir: &Path, rel: &str) -> Result<bool, String> {
    let gameinfo = citadel_dir.join("gameinfo.gi");
    let text = std::fs::read_to_string(&gameinfo)
        .map_err(|e| format!("reading {}: {e}", gameinfo.display()))?;
    let needle = format!("citadel/{rel}");
    let patched = if text.to_lowercase().contains(&needle.to_lowercase()) {
        // Mounted already; repair a bare mount (see `pin_mod_write`).
        match pin_mod_write(&text, &needle) {
            Some(p) => p,
            None => return Ok(false),
        }
    } else {
        let p = add_top_game_path(&text, &needle)?;
        pin_mod_write(&p, &needle).unwrap_or(p)
    };
    let bak = gameinfo.with_extension("gi.eim.bak");
    if !bak.exists() {
        std::fs::copy(&gameinfo, &bak).map_err(|e| format!("backing up gameinfo.gi: {e}"))?;
    }
    std::fs::write(&gameinfo, patched).map_err(|e| format!("writing gameinfo.gi: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_of_handles_plain_and_prefixed() {
        assert_eq!(slot_of("pak01_dir.vpk"), Some(1));
        assert_eq!(slot_of("pak83_dir.vpk"), Some(83));
        assert_eq!(slot_of("600744_pak07_dir.vpk"), Some(7));
        assert_eq!(slot_of("618178_sts_gifted-pak20_dir.vpk"), Some(20));
        assert_eq!(slot_of("83329_pak98_dir.vpk"), Some(98));
        // Not addon paks.
        assert_eq!(slot_of("pak01_000.vpk"), None);
        assert_eq!(slot_of("readme.txt"), None);
        assert_eq!(slot_of("pak_dir.vpk"), None);
    }

    const VANILLA_SP: &str = "\t\tSearchPaths\r\n\t\t{\r\n\t\t\tGame_LowViolence\tcitadel_lv\r\n\r\n\t\t\tGame\t\t\t\tcitadel\r\n\t\t\tGame\t\t\t\tcore\r\n\t\t}\r\n";

    fn sp_lines(t: &str) -> Vec<String> {
        t.lines()
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|l| !l.is_empty())
            .collect()
    }

    #[test]
    fn addons_mount_keeps_citadel_the_mod_and_write_path() {
        let p = add_top_game_path(VANILLA_SP, "citadel/addons").unwrap();
        let p = pin_mod_write(&p, "citadel/addons").unwrap();
        assert_eq!(
            sp_lines(&p),
            [
                "SearchPaths", "{", "Game citadel/addons", "Mod citadel", "Write citadel",
                "Game_LowViolence citadel_lv", "Game citadel", "Game core", "}",
            ]
        );
        // CRLF file stays CRLF (no bare \n introduced).
        assert_eq!(p.matches('\n').count(), p.matches("\r\n").count());
        // Idempotent.
        assert!(pin_mod_write(&p, "citadel/addons").is_none());
    }

    #[test]
    fn bare_addons_mount_from_older_versions_is_repaired() {
        // What 1.5.2 and earlier wrote: the game refuses to start with it.
        let bare = add_top_game_path(VANILLA_SP, "citadel/addons").unwrap();
        let fixed = pin_mod_write(&bare, "citadel/addons").expect("needs repair");
        assert!(sp_lines(&fixed).contains(&"Mod citadel".to_string()));
        // Another manager's full block (Mod + Write already there): untouched.
        let grimoire = "SearchPaths\n{\n Game citadel/addons\n Mod citadel\n Write citadel\n Game citadel\n Game core\n}\n";
        assert!(pin_mod_write(grimoire, "citadel/addons").is_none());
        // Only the missing one is added.
        let half = "SearchPaths\n{\n Game citadel/addons\n Mod citadel\n Game citadel\n}\n";
        let out = pin_mod_write(half, "citadel/addons").unwrap();
        assert_eq!(out.matches("Mod").count(), 1);
        assert_eq!(out.matches("Write\t\t\t\tcitadel").count(), 1);
    }

    /// What Deadlock Mod Manager writes with a profile active
    /// (game_config_manager.rs: markers AROUND a rebuilt SearchPaths block).
    const DMM_PROFILE_GI: &str = "\"GameInfo\"\r\n{\r\n\tFileSystem\r\n\t{\r\n\
        // Deadlock Mod Manager - Start\r\n\
        \t\tSearchPaths\r\n        {  \r\n\
        \x20           Game_UILanguage     citadel_*LANGUAGE*\r\n\
        \x20           Game_LowViolence    citadel_lv\r\n\
        \x20           Game                citadel/addons/profile_default\r\n\
        \x20           Game                citadel/addons2/profile_default\r\n\
        \x20           Mod                 citadel\r\n\
        \x20           Write               citadel          \r\n\
        \x20           Game                citadel\r\n\
        \x20           Mod                 core\r\n\
        \x20           Write               core\r\n\
        \x20           Game                core        \r\n\
        \x20       }\r\n\
        // Deadlock Mod Manager - End\r\n\t}\r\n}\r\n";

    #[test]
    fn dmm_profile_mount_redirects_installs_into_the_profile_folder() {
        assert_eq!(
            addons_mounts(DMM_PROFILE_GI),
            ["citadel/addons/profile_default", "citadel/addons2/profile_default"]
        );
        // The old substring check called this "already enabled" and the pak
        // went to the never-mounted addons root.
        assert!(!addons_mounts(DMM_PROFILE_GI).iter().any(|m| m == "citadel/addons"));

        let root = std::env::temp_dir().join(format!("eim_dmm_redirect_{}", timestamp()));
        let citadel = root.join("game").join("citadel");
        let profile = citadel.join("addons").join("profile_default");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(citadel.join("gameinfo.gi"), DMM_PROFILE_GI).unwrap();
        // DMM's own enabled mod already holds pak01.
        std::fs::write(profile.join("pak01_dir.vpk"), b"dmm mod").unwrap();
        let src = root.join("mine.vpk");
        std::fs::write(&src, b"our mod").unwrap();

        let addons = citadel.join("addons");
        let (dir, mount) = mounted_addons_dir(&addons);
        assert_eq!(dir, profile);
        assert_eq!(mount.as_deref(), Some("citadel/addons/profile_default"));
        assert_eq!(scan_slots(&addons).used, [1]);

        let r = install(&src, &addons, None, None, true).unwrap();
        assert_eq!(r.slot, 2, "next free slot inside the PROFILE folder");
        assert_eq!(std::fs::read(profile.join("pak02_dir.vpk")).unwrap(), b"our mod");
        assert!(!addons.join("pak01_dir.vpk").exists(), "nothing lands in the unmounted root");
        // DMM owns gameinfo (rewrites it on every Launch Modded): untouched.
        assert!(!r.gameinfo_patched);
        assert_eq!(std::fs::read_to_string(citadel.join("gameinfo.gi")).unwrap(), DMM_PROFILE_GI);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plain_addons_mount_is_not_redirected() {
        let p = add_top_game_path(VANILLA_SP, "citadel/addons").unwrap();
        assert_eq!(addons_mounts(&p), ["citadel/addons"]);
        // DMM without profiles writes the plain root too.
        let dmm_root = DMM_PROFILE_GI
            .replace("citadel/addons/profile_default", "citadel/addons")
            .replace("            Game                citadel/addons2/profile_default\r\n", "");
        assert_eq!(addons_mounts(&dmm_root), ["citadel/addons"]);
        // Commented-out lines and vanilla files mount nothing.
        assert!(addons_mounts("SearchPaths\n{\n // Game citadel/addons\n Game citadel\n}\n").is_empty());
        assert!(addons_mounts(VANILLA_SP).is_empty());
        let missing = std::env::temp_dir().join("eim_no_such_game").join("citadel").join("addons");
        assert_eq!(mounted_addons_dir(&missing), (missing.clone(), None));
    }

    #[test]
    fn next_free_finds_lowest_gap() {
        assert_eq!(next_free_slot(&[1, 2, 4]), Some(3));
        assert_eq!(next_free_slot(&[]), Some(1));
        assert_eq!(next_free_slot(&(1..=MAX_SLOT).collect::<Vec<_>>()), None);
    }

    #[test]
    fn auto_install_reuses_own_slot_by_size_only() {
        let dir = std::env::temp_dir().join(format!("eim_reuse_test_{}", timestamp()));
        std::fs::create_dir_all(&dir).unwrap();
        let src1 = dir.join("build1.vpk");
        let src2 = dir.join("build2.vpk");
        std::fs::write(&src1, b"12345").unwrap(); // 5 bytes
        std::fs::write(&src2, b"1234567").unwrap(); // 7 bytes

        // First auto install: next free = slot 1.
        let r1 = install(&src1, &dir, None, None, false).expect("install 1");
        assert_eq!((r1.slot, r1.bytes, r1.replaced), (1, 5, false));

        // Recompile + auto install with the remembered (slot, bytes): the slot
        // still holds our 5-byte file, so it's REPLACED, not stacked.
        let r2 = install(&src2, &dir, None, Some((1, 5)), false).expect("install 2");
        assert_eq!((r2.slot, r2.bytes, r2.replaced), (1, 7, true));

        // Stale memory (file there is 7 bytes now, we remember 5 = not ours
        // anymore): auto falls back to the next free slot instead of clobbering.
        let r3 = install(&src1, &dir, None, Some((1, 5)), false).expect("install 3");
        assert_eq!((r3.slot, r3.replaced), (2, false));

        // Remembered slot's file deleted: fine, it's free again anyway.
        std::fs::remove_file(dir.join("pak02_dir.vpk")).unwrap();
        let r4 = install(&src1, &dir, None, Some((2, 5)), false).expect("install 4");
        assert_eq!((r4.slot, r4.replaced), (2, false));

        // The scan reports plain-file sizes for the ownership hint.
        let scan = scan_slots(&dir);
        assert!(scan.files.iter().any(|f| f.slot == 1 && f.bytes == 7), "{:?}", scan.files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn used_slots_dedupes_across_prefixes() {
        let dir = std::env::temp_dir().join(format!("eim_slot_test_{}", timestamp()));
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["pak01_dir.vpk", "600744_pak01_dir.vpk", "pak05_dir.vpk", "junk.txt"] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let used = used_slots(&dir);
        assert_eq!(used, vec![1, 5]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
