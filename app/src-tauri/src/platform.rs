//! Platform seams for the Linux port.
//!
//! The app's external tools fall in two camps:
//! - Native tools we can get per-platform: curl, tar, md5, ps/tasklist,
//!   ffmpeg, the vpk-helper (cross-platform .NET).
//! - Valve's Windows-only binaries (resourcecompiler.exe and friends), which
//!   on Linux run through Wine. Their PATH ARGUMENTS must then be spelled the
//!   way a Windows program sees them (Wine maps the unix root as drive Z:).
//!
//! Everything platform-specific that isn't a one-liner lives here so the rest
//! of the codebase stays single-source.

use std::path::Path;
use std::process::Command;

/// Command for a Windows tool exe: run directly on Windows, through Wine
/// elsewhere. The exe path itself can stay in native form (Wine resolves it).
pub fn windows_tool(exe: &Path) -> Command {
    #[cfg(windows)]
    {
        crate::procutil::quiet(exe)
    }
    #[cfg(not(windows))]
    {
        let mut cmd = crate::procutil::quiet("wine");
        cmd.arg(exe);
        cmd
    }
}

/// A path argument as the (possibly Wine-hosted) Windows tool expects it.
/// On Windows this is a no-op; under Wine, absolute unix paths become
/// `Z:\...` (Wine's default mapping of the filesystem root).
pub fn tool_path(p: &str) -> String {
    #[cfg(windows)]
    {
        p.to_string()
    }
    #[cfg(not(windows))]
    {
        if p.starts_with('/') {
            format!("Z:{}", p.replace('/', "\\"))
        } else {
            p.replace('/', "\\")
        }
    }
}

/// Wine availability (always true on Windows, where no Wine is needed) - lets
/// the compile pipeline fail with a clear message instead of "No such file".
pub fn wine_available() -> bool {
    #[cfg(windows)]
    {
        true
    }
    #[cfg(not(windows))]
    {
        crate::procutil::quiet("wine")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
}

/// The system curl: Windows prefers the System32-native one (a bare name
/// could hit an MSYS build); elsewhere plain `curl` from PATH.
pub fn curl_exe() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        system32("curl.exe")
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from("curl")
    }
}

/// The system tar (bsdtar on Windows reads zips; GNU tar on Linux does too
/// via libarchive-free `-xf` on .zip only when built with it - so on unix we
/// fall back to `unzip`-compatible behavior by still calling tar, which
/// handles zip on all mainstream distros' bsdtar/GNU tar >= 1.35).
pub fn tar_exe() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        system32("tar.exe")
    }
    #[cfg(not(windows))]
    {
        std::path::PathBuf::from("tar")
    }
}

#[cfg(windows)]
fn system32(name: &str) -> std::path::PathBuf {
    std::env::var("WINDIR")
        .map(|w| std::path::PathBuf::from(w).join("System32"))
        .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Windows\System32"))
        .join(name)
}

/// MD5 of a file: certutil on Windows (no hash crate needed), md5sum on unix.
pub fn file_md5(path: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let out = crate::procutil::quiet(system32("certutil.exe"))
            .args(["-hashfile", path, "MD5"])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        // Line 2 is the bare hex digest.
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .nth(1)
            .map(|l| l.trim().replace(' ', "").to_lowercase())
            .filter(|h| h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit()))
    }
    #[cfg(not(windows))]
    {
        let out = crate::procutil::quiet("md5sum").arg(path).output().ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .next()
            .map(|h| h.to_lowercase())
            .filter(|h| h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit()))
    }
}

/// Lowercased names of all running processes, for the lock-risk warnings.
/// (On Linux, Proton games still show their Windows exe name in `ps`.)
pub fn process_list_lowercase() -> String {
    #[cfg(windows)]
    {
        crate::procutil::quiet("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
            .unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        crate::procutil::quiet("ps")
            .args(["-e", "-o", "comm="])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_path_is_identity_on_windows_and_z_mapped_on_unix() {
        #[cfg(windows)]
        assert_eq!(tool_path(r"C:\foo\bar"), r"C:\foo\bar");
        #[cfg(not(windows))]
        assert_eq!(tool_path("/home/u/x.wav"), r"Z:\home\u\x.wav");
    }

    #[test]
    fn md5_of_a_real_file_works() {
        let p = std::env::temp_dir().join("eim_platform_md5_test.txt");
        std::fs::write(&p, b"hello").unwrap();
        assert_eq!(
            file_md5(&p.to_string_lossy()).as_deref(),
            Some("5d41402abc4b2a76b9719d911017c592")
        );
    }
}
