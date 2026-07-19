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

/// Overwrite `path` atomically: write a sibling temp file, then rename over the
/// target (on Windows std's rename replaces existing files via MoveFileEx). A
/// crash mid-write can no longer leave a truncated gameinfo.gi - which would
/// stop the game launching at all, not just hosting.
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("gi.eim.tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("replacing {}: {e}", path.display())
    })
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
        write_atomic(&gi, &text)?;
    }
    Ok(status(root))
}

/// Remove the two hosting edits (leaves every other line, e.g. the addons search
/// path, intact — so it doesn't clobber the install patch). Preserves the file's
/// original line endings and trailing newline instead of normalizing to LF.
pub fn revert(root: &Path) -> Result<HostStatus, String> {
    let gi = gameinfo_path(root);
    let text = std::fs::read_to_string(&gi).map_err(|e| format!("reading gameinfo.gi: {e}"))?;
    let nl = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| !l.contains("CreateListenSocketP2P") && !l.contains("net_p2p_listen_dedicated"))
        .collect();
    let mut out = kept.join(nl);
    if text.ends_with('\n') {
        out.push_str(nl);
    }
    if out != text {
        write_atomic(&gi, &out)?;
    }
    Ok(status(root))
}

/// Parse the server's P2P connect identity from `console.log` — the most recent
/// `ServerSteamID=[A:1:…]` line the dedicated server logs once it's up. Players
/// join with `connect <id>` from their client's dev console. None until logged.
pub fn connect_id(root: &Path) -> Option<String> {
    let log = root.join("game").join("citadel").join("console.log");
    let text = std::fs::read_to_string(&log).ok()?;
    let mut found = None;
    for line in text.lines() {
        if let Some(i) = line.find("ServerSteamID=[") {
            let rest = &line[i + "ServerSteamID=".len()..];
            if let Some(end) = rest.find(']') {
                found = Some(rest[..=end].to_string()); // keep the [brackets]
            }
        }
    }
    found
}

/// Generate a throwaway RCON password for this launch. Lowercase + digits only
/// (no look-alikes) so it's safe to pass on a command line and easy to read.
/// Seeded from OS entropy (RandomState draws from the system CSPRNG) - the old
/// clock seed could be brute-forced by anyone on the LAN who knew roughly when
/// the server launched, and RCON binds to the LAN address.
fn gen_rcon_password() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut x = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish()
        | 1;
    let alphabet = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut s = String::with_capacity(16);
    for _ in 0..16 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17; // xorshift64
        s.push(alphabet[(x % alphabet.len() as u64) as usize] as char);
    }
    s
}

/// Result of launching the dedicated host.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub pid: u32,
    /// The RCON password this server was started with — the admin panel uses it
    /// to send commands. Only valid for the lifetime of this server process.
    pub rcon_password: String,
}

/// Launch the installed client as a dedicated host on `map` (default
/// `dl_midtown`). Detached. Sets a fresh RCON password and returns it with the
/// PID so the app's admin panel can drive the server.
pub fn launch(root: &Path, map: &str, max_players: Option<u32>) -> Result<LaunchInfo, String> {
    let exe = exe_path(root);
    if !exe.exists() {
        return Err(format!("deadlock.exe not found at {}", exe.display()));
    }
    let map = if map.trim().is_empty() { "dl_midtown" } else { map.trim() };
    let rcon_password = gen_rcon_password();
    // Server slot count. Deadlock is a 6v6 game (12), so going higher to fit more
    // bots is experimental — the engine may not honor it. Clamp to a sane ceiling.
    let slots = max_players.filter(|&n| n > 0).map(|n| n.clamp(1, 64).to_string());

    // Direct spawn of the dedicated server, given its own console window
    // (CREATE_NEW_CONSOLE). We deliberately do NOT override stdio: in the packaged
    // app (a windowless GUI process with no stdout) the new console's buffers
    // become the server's std handles, so its console shows output and accepts
    // typed commands. Under `npm run tauri dev` the harness pipes the app's
    // stdout, so the server inherits that pipe and its output goes to the dev log
    // instead of the console window (window looks blank) — a dev-only cosmetic
    // quirk; the server still runs and is driven via RCON / console.log / the F8
    // overlay regardless. (Going through `cmd /c start` to fix the dev cosmetics
    // proved fragile — the server failed to launch from the windowless parent.)
    let mut cmd = std::process::Command::new(&exe);
    cmd.current_dir(root)
        .args(["-dedicated", "-insecure", "-condebug", "-allow_no_lobby_connect"]);
    if let Some(slots) = &slots {
        cmd.args(["-maxplayers", slots]);
    }
    cmd.args([
        "+tv_citadel_auto_record",
        "0",
        // Enable RCON admin: setting a password makes the server accept
        // authenticated commands on its TCP socket (port 27015).
        "+rcon_password",
        &rcon_password,
        "+map",
        map,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    let child = cmd.spawn().map_err(|e| format!("launching dedicated server: {e}"))?;
    Ok(LaunchInfo { pid: child.id(), rcon_password })
}

/// Deadlock's Steam AppID — used to launch the normal client to test a mod.
const STEAM_APP_ID: &str = "1422450";

/// Launch Deadlock normally (NOT as a dedicated host) so a freshly installed
/// mod can be tested in a real match. Prefers the Steam protocol handler — it
/// starts Steam if needed, applies the user's launch options, and reloads
/// addons from disk. Falls back to the client exe directly if a Deadlock root
/// is provided and the Steam handoff can't be started.
pub fn launch_game(root: Option<&Path>) -> Result<(), String> {
    let url = format!("steam://rungameid/{STEAM_APP_ID}");
    // Hand the URL to the OS protocol handler (starts Steam if needed) without
    // flashing a console window, then exit once Steam takes over. Windows:
    // `explorer <url>`; elsewhere `xdg-open`.
    #[cfg(windows)]
    let opener = "explorer";
    #[cfg(not(windows))]
    let opener = "xdg-open";
    if std::process::Command::new(opener).arg(&url).spawn().is_ok() {
        return Ok(());
    }
    // Fallback: launch the client exe directly (needs Steam already running).
    let exe = root.map(exe_path).filter(|e| e.exists()).ok_or_else(|| {
        "Couldn't start Steam, and no installed deadlock.exe to fall back to".to_string()
    })?;
    std::process::Command::new(&exe)
        .current_dir(exe.parent().unwrap())
        .spawn()
        .map_err(|e| format!("launching deadlock.exe: {e}"))?;
    Ok(())
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
    fn connect_id_parses_last_serversteamid() {
        let root = std::env::temp_dir().join("eim_host_test_connid");
        let cit = root.join("game").join("citadel");
        std::fs::create_dir_all(&cit).unwrap();
        std::fs::write(
            cit.join("console.log"),
            "noise\n[Server] SV:  ServerSteamID=[A:1:111:222] (90).\nmore\n[Server] SV:  ServerSteamID=[A:1:2291896339:50255] (90287838420766739).\n",
        )
        .unwrap();
        assert_eq!(connect_id(&root).as_deref(), Some("[A:1:2291896339:50255]"));
    }

    #[test]
    fn revert_preserves_crlf_and_trailing_newline() {
        let crlf = SAMPLE.replace('\n', "\r\n");
        let root = write_tmp("revert_crlf", &crlf);
        setup(&root).unwrap();
        revert(&root).unwrap();
        let text = std::fs::read_to_string(gameinfo_path(&root)).unwrap();
        assert!(!text.contains("CreateListenSocketP2P"));
        assert!(text.contains("\r\n"), "CRLF endings must survive a revert");
        assert!(text.ends_with("\r\n"), "trailing newline must survive");
        assert!(!text.contains("\n\n\n"), "no blank-line growth");
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
