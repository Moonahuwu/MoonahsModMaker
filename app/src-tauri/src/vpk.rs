//! Shells out to the bundled C# `vpk-helper` (ValvePak) to pack/extract VPKs.
//!
//! `helper_path` may point at either a native `.exe` (published self-contained)
//! or the `.dll` (framework-dependent), in which case we invoke it via `dotnet`.

use std::process::Command;

fn helper_command(helper_path: &str) -> Command {
    if helper_path.to_ascii_lowercase().ends_with(".dll") {
        let mut c = Command::new("dotnet");
        c.arg(helper_path);
        c
    } else {
        Command::new(helper_path)
    }
}

fn run(mut cmd: Command, what: &str) -> Result<String, String> {
    let out = cmd.output().map_err(|e| format!("running vpk-helper ({what}): {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        Err(if err.is_empty() { stdout } else { err })
    }
}

/// Pack `folder` into `out_vpk` (a single-file `pak01_dir.vpk`).
pub fn pack(helper_path: &str, folder: &str, out_vpk: &str) -> Result<String, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["pack", folder, out_vpk]);
    run(cmd, "pack")
}

/// Decode a compiled `.vsnd_c` (inside `vpk`) to playable audio. Returns the
/// written file path (the helper picks the correct extension).
pub fn decode(
    helper_path: &str,
    vpk: &str,
    internal_path: &str,
    out_base_no_ext: &str,
) -> Result<String, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["decode", vpk, internal_path, out_base_no_ext]);
    run(cmd, "decode")
}

/// Extract one entry (`internal_path`) from `vpk` to `out_file`.
pub fn extract(
    helper_path: &str,
    vpk: &str,
    internal_path: &str,
    out_file: &str,
) -> Result<String, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["extract", vpk, internal_path, out_file]);
    run(cmd, "extract")
}
