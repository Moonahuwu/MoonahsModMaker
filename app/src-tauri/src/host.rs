//! One-click custom-game hosting. Deadlock doesn't need a separate dedicated
//! server download — the installed client relaunches in `-dedicated` mode. All
//! we automate is:
//!   1. the two `gameinfo.gi` edits that enable P2P dedicated listening
//!      (`CreateListenSocketP2P` in NetworkSystem, `net_p2p_listen_dedicated` in
//!      ConVars — the rate convars ship correct already), and
//!   2. launching `game/bin/win64/deadlock.exe` with the hosting flags.
//! The gameinfo edits are backed up and fully reversible.

use std::path::{Path, PathBuf};

fn gameinfo_path(root: &Path) -> PathBuf {
    root.join("game").join("citadel").join("gameinfo.gi")
}
fn exe_path(root: &Path) -> PathBuf {
    root.join("game").join("bin").join("win64").join("deadlock.exe")
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub deadlock_root: String,
    pub exe_found: bool,
    pub gameinfo_found: bool,
    /// `CreateListenSocketP2P` present (NetworkSystem).
    pub p2p_patched: bool,
    /// `net_p2p_listen_dedicated` present (ConVars).
    pub dedicated_patched: bool,
    /// Everything needed to host is in place.
    pub ready: bool,
}

pub fn status(root: &Path) -> HostStatus {
    let gi = gameinfo_path(root);
    let text = std::fs::read_to_string(&gi).unwrap_or_default();
    let p2p = text.contains("CreateListenSocketP2P");
    let ded = text.contains("net_p2p_listen_dedicated");
    let exe = exe_path(root).exists();
    HostStatus {
        deadlock_root: root.display().to_string(),
        exe_found: exe,
        gameinfo_found: gi.exists(),
        p2p_patched: p2p,
        dedicated_patched: ded,
        ready: exe && p2p && ded,
    }
}

/// Insert `insertion` immediately after the opening `{` of the named block.
fn insert_after_block(text: &str, block: &str, insertion: &str) -> Result<String, String> {
    let pos = text.find(block).ok_or_else(|| format!("no {block} block in gameinfo.gi"))?;
    let brace = text[pos..]
        .find('{')
        .map(|i| pos + i)
        .ok_or_else(|| format!("malformed {block} block (no '{{')"))?;
    let at = brace + 1;
    Ok(format!("{}{}{}", &text[..at], insertion, &text[at..]))
}

/// Apply the two hosting edits (idempotent). Backs up `gameinfo.gi` once to
/// `gameinfo.gi.host.bak` before the first change.
pub fn setup(root: &Path) -> Result<HostStatus, String> {
    let gi = gameinfo_path(root);
    let mut text = std::fs::read_to_string(&gi).map_err(|e| format!("reading gameinfo.gi: {e}"))?;
    let mut changed = false;
    if !text.contains("CreateListenSocketP2P") {
        text = insert_after_block(&text, "NetworkSystem", "\n\t\t\"CreateListenSocketP2P\"\t\"2\"")?;
        changed = true;
    }
    if !text.contains("net_p2p_listen_dedicated") {
        text = insert_after_block(&text, "ConVars", "\n\t\t\"net_p2p_listen_dedicated\"\t\"1\"")?;
        changed = true;
    }
    if changed {
        let bak = gi.with_extension("gi.host.bak");
        if !bak.exists() {
            std::fs::copy(&gi, &bak).map_err(|e| format!("backing up gameinfo.gi: {e}"))?;
        }
        std::fs::write(&gi, &text).map_err(|e| format!("writing gameinfo.gi: {e}"))?;
    }
    Ok(status(root))
}

/// Remove the two hosting edits (leaves every other line, e.g. the addons search
/// path, intact — so it doesn't clobber the install patch).
pub fn revert(root: &Path) -> Result<HostStatus, String> {
    let gi = gameinfo_path(root);
    let text = std::fs::read_to_string(&gi).map_err(|e| format!("reading gameinfo.gi: {e}"))?;
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !l.contains("CreateListenSocketP2P") && !l.contains("net_p2p_listen_dedicated"))
        .collect();
    std::fs::write(&gi, kept.join("\n")).map_err(|e| format!("writing gameinfo.gi: {e}"))?;
    Ok(status(root))
}

/// Launch the installed client as a dedicated host on `map` (default
/// `dl_midtown`). Detached — returns the child PID.
pub fn launch(root: &Path, map: &str) -> Result<u32, String> {
    let exe = exe_path(root);
    if !exe.exists() {
        return Err(format!("deadlock.exe not found at {}", exe.display()));
    }
    let map = if map.trim().is_empty() { "dl_midtown" } else { map.trim() };
    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(root).args([
        "-dedicated",
        "-insecure",
        "-condebug",
        "-allow_no_lobby_connect",
        "+tv_citadel_auto_record",
        "0",
        "+map",
        map,
    ]);
    // The dedicated server runs a text console that reads stdin. Launched from a
    // windowed app it would inherit a dead stdin handle and spam
    // `!GetNumberOfConsoleInputEvents`, with no way to type commands. Give it its
    // own fresh, interactive console window instead.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    let child = cmd.spawn().map_err(|e| format!("launching dedicated server: {e}"))?;
    Ok(child.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
\"GameInfo\"
{
\tNetworkSystem
\t{
\t\t\"SkipRedundantChangeCallbacks\"\t\"1\"
\t}
\tConVars
\t{
\t\t\"rate\"
\t\t{
\t\t\t\"min\"\t\"98304\"
\t\t}
\t}
}
";

    fn write_tmp(name: &str, body: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("eim_host_test_{name}"));
        let gi = root.join("game").join("citadel");
        std::fs::create_dir_all(&gi).unwrap();
        std::fs::write(gi.join("gameinfo.gi"), body).unwrap();
        root
    }

    #[test]
    fn setup_inserts_both_edits_idempotently() {
        let root = write_tmp("setup", SAMPLE);
        let s = setup(&root).unwrap();
        assert!(s.p2p_patched && s.dedicated_patched);
        let text = std::fs::read_to_string(gameinfo_path(&root)).unwrap();
        assert_eq!(text.matches("CreateListenSocketP2P").count(), 1);
        assert_eq!(text.matches("net_p2p_listen_dedicated").count(), 1);
        // Running again doesn't duplicate.
        setup(&root).unwrap();
        let text2 = std::fs::read_to_string(gameinfo_path(&root)).unwrap();
        assert_eq!(text2.matches("CreateListenSocketP2P").count(), 1);
    }

    #[test]
    fn revert_removes_both_edits() {
        let root = write_tmp("revert", SAMPLE);
        setup(&root).unwrap();
        let s = revert(&root).unwrap();
        assert!(!s.p2p_patched && !s.dedicated_patched);
        // Untouched content survives.
        let text = std::fs::read_to_string(gameinfo_path(&root)).unwrap();
        assert!(text.contains("SkipRedundantChangeCallbacks"));
    }
}
