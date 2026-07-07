//! Shells out to the bundled C# `vpk-helper` (ValvePak) to pack/extract VPKs.
//!
//! `helper_path` may point at either a native `.exe` (published self-contained)
//! or the `.dll` (framework-dependent), in which case we invoke it via `dotnet`.
//!
//! Every read-side function here also transparently accepts a DIRECTORY as the
//! "vpk" source: imported packs are cached once into an app-managed folder so
//! later compiles/previews never need the original `.vpk` again. A dir source
//! is listed/copied/decoded straight from loose files.

use crate::procutil::quiet;
use std::path::Path;
use std::process::Command;

/// Recursively list a cached-pack directory as vpk-style internal paths
/// (forward slashes, relative to `root`), optionally filtered by substring
/// (matching the helper's `list` filter semantics).
fn list_dir(root: &Path, filter: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if let Ok(rel) = p.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                if filter.map(|f| rel.contains(f)).unwrap_or(true) {
                    out.push(rel);
                }
            }
        }
    }
    out.sort();
    out
}

fn helper_command(helper_path: &str) -> Command {
    if helper_path.to_ascii_lowercase().ends_with(".dll") {
        let mut c = quiet("dotnet");
        c.arg(helper_path);
        c
    } else {
        quiet(helper_path)
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

/// Standard zlib CRC32 (matches the checksums stored in vpk indexes).
fn crc32(data: &[u8]) -> u32 {
    use std::sync::OnceLock;
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        let mut t = [0u32; 256];
        for (i, slot) in t.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        t
    });
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ u32::from(b)) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// `(crc32, internal_path)` for every entry in a vpk (read from its index —
/// fast) or a cached-pack dir (hashed from disk; `only` restricts which rel
/// paths get hashed so a big cache isn't read wholesale).
pub fn crcs(
    helper_path: &str,
    source: &str,
    only: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<(u32, String)>, String> {
    let src = Path::new(source);
    if src.is_dir() {
        let mut out = Vec::new();
        for rel in list_dir(src, None) {
            if let Some(set) = only {
                if !set.contains(&rel) {
                    continue;
                }
            }
            let Ok(bytes) = std::fs::read(src.join(&rel)) else { continue };
            out.push((crc32(&bytes), rel));
        }
        return Ok(out);
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["crcs", source]);
    let text = run(cmd, "crcs")?;
    Ok(text
        .lines()
        .filter_map(|l| {
            let (crc, path) = l.split_once('\t')?;
            Some((u32::from_str_radix(crc.trim(), 16).ok()?, path.trim().to_string()))
        })
        .collect())
}

/// Decompile EVERYTHING in a vpk into `dest_dir`, preserving the folder
/// structure: sounds → audio files, textures → png, other compiled resources →
/// decompiled text; anything undecompilable is copied raw. Returns the
/// helper's summary line.
pub fn decompile_all(helper_path: &str, vpk: &str, dest_dir: &str) -> Result<String, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["decompileall", vpk, dest_dir]);
    run(cmd, "decompileall")
}

/// Pack `folder` into `out_vpk` (a single-file `pak01_dir.vpk`).
pub fn pack(helper_path: &str, folder: &str, out_vpk: &str) -> Result<String, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["pack", folder, out_vpk]);
    run(cmd, "pack")
}

/// List entry paths in a vpk or cached-pack dir (optionally filtered by
/// substring). One per line.
pub fn list(helper_path: &str, vpk: &str, filter: Option<&str>) -> Result<Vec<String>, String> {
    let p = Path::new(vpk);
    if p.is_dir() {
        return Ok(list_dir(p, filter));
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["list", vpk]);
    if let Some(f) = filter {
        cmd.arg(f);
    }
    let out = run(cmd, "list")?;
    Ok(out.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
}

/// Extract every file (optionally under `prefix`) from `vpk` (or copy from a
/// cached-pack dir) into `dest_dir`, preserving the content-relative layout.
pub fn extract_all(
    helper_path: &str,
    vpk: &str,
    dest_dir: &str,
    prefix: Option<&str>,
) -> Result<String, String> {
    let src = Path::new(vpk);
    if src.is_dir() {
        let dest_root = Path::new(dest_dir);
        let mut copied = 0usize;
        for rel in list_dir(src, None) {
            if let Some(p) = prefix {
                if !rel.starts_with(p) {
                    continue;
                }
            }
            let to = dest_root.join(&rel);
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(src.join(&rel), &to).map_err(|e| format!("copy {rel}: {e}"))?;
            copied += 1;
        }
        return Ok(format!("copied {copied} file(s) from cache"));
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["extractall", vpk, dest_dir]);
    if let Some(p) = prefix {
        cmd.arg(p);
    }
    run(cmd, "extractall")
}

/// Decompile a compiled resource (e.g. `.vsndevts_c`) inside `vpk` to its KV3
/// text source at `out_file`. For a cached-pack dir, an already-decompiled
/// text sibling (the cache stores soundevents as text) is copied directly;
/// a loose compiled file is decompiled via the helper's loose-file mode.
pub fn decompile_from_vpk(
    helper_path: &str,
    vpk: &str,
    internal_path: &str,
    out_file: &str,
) -> Result<String, String> {
    let src = Path::new(vpk);
    if src.is_dir() {
        let text = src.join(internal_path.trim_end_matches("_c"));
        if text.exists() {
            if let Some(parent) = Path::new(out_file).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::copy(&text, out_file).map_err(|e| e.to_string())?;
            return Ok(format!("copied {} from cache", text.display()));
        }
        let compiled = src.join(internal_path);
        if !compiled.exists() {
            return Err(format!("not in cache: {internal_path}"));
        }
        let mut cmd = helper_command(helper_path);
        cmd.args(["decompile", &compiled.to_string_lossy(), out_file]);
        return run(cmd, "decompile");
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["decompile", vpk, internal_path, out_file]);
    run(cmd, "decompile")
}

/// Decode a compiled `.vsnd_c` (inside `vpk`, or a loose file in a cached-pack
/// dir) to playable audio. Returns the written file path (the helper picks the
/// correct extension).
pub fn decode(
    helper_path: &str,
    vpk: &str,
    internal_path: &str,
    out_base_no_ext: &str,
) -> Result<String, String> {
    let src = Path::new(vpk);
    if src.is_dir() {
        let file = src.join(internal_path);
        if !file.exists() {
            return Err(format!("not in cache: {internal_path}"));
        }
        let mut cmd = helper_command(helper_path);
        cmd.args(["decode", &file.to_string_lossy(), out_base_no_ext]);
        return run(cmd, "decode");
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["decode", vpk, internal_path, out_base_no_ext]);
    run(cmd, "decode")
}

/// Decode several textures from `vpk` into `dest_dir` in one pass. Returns
/// `(stem, png_path)` for each decoded `.vtex_c`.
pub fn texture_batch(
    helper_path: &str,
    vpk: &str,
    dest_dir: &str,
    internal_paths: &[String],
) -> Result<Vec<(String, String)>, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["texturebatch", vpk, dest_dir]);
    cmd.args(internal_paths);
    let out = run(cmd, "texturebatch")?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(2, '\t');
            Some((it.next()?.trim().to_string(), it.next()?.trim().to_string()))
        })
        .collect())
}

/// Batch-decode each hero's card portrait from `vpk` into `dest_dir`. Returns
/// `(codename, png_path)` pairs (one Package.Read for the whole roster).
pub fn heroes(helper_path: &str, vpk: &str, dest_dir: &str) -> Result<Vec<(String, String)>, String> {
    let mut cmd = helper_command(helper_path);
    cmd.args(["heroes", vpk, dest_dir]);
    let out = run(cmd, "heroes")?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut it = l.splitn(2, '\t');
            Some((it.next()?.trim().to_string(), it.next()?.trim().to_string()))
        })
        .collect())
}

/// Extract one entry (`internal_path`) from `vpk` (or copy it from a
/// cached-pack dir) to `out_file`.
pub fn extract(
    helper_path: &str,
    vpk: &str,
    internal_path: &str,
    out_file: &str,
) -> Result<String, String> {
    let src = Path::new(vpk);
    if src.is_dir() {
        let file = src.join(internal_path);
        if !file.exists() {
            return Err(format!("not in cache: {internal_path}"));
        }
        if let Some(parent) = Path::new(out_file).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::copy(&file, out_file).map_err(|e| e.to_string())?;
        return Ok(format!("copied {internal_path} from cache"));
    }
    let mut cmd = helper_command(helper_path);
    cmd.args(["extract", vpk, internal_path, out_file]);
    run(cmd, "extract")
}
