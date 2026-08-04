//! Validation helpers for anything that comes off the network (or off the
//! frontend, which in turn got it off the network).
//!
//! Two problems this closes:
//!
//! 1. **curl argument injection.** The downloads shell out to `curl.exe` with
//!    the URL as the last argument. Rust spawns via `CreateProcessW`, so there
//!    is no shell and no `& | ;` injection — but curl itself still parses a
//!    leading `-` as an option, and short options take an attached value
//!    (`-KC:\evil.txt` is one valid token). With `_sDownloadUrl` coming
//!    straight from the GameBanana API, a mod uploader controls that token.
//!    Fixed by requiring `https://` + an allow-listed host *and* passing `--`
//!    before the URL so curl can never read it as an option.
//!
//! 2. **Path traversal through remote file names.** `_sFile` is attacker
//!    controlled too, and only had `/` and `\` replaced — `..`, a drive
//!    prefix (`C:evil.exe`) or an ADS suffix still got through. `safe_file_name`
//!    reduces the value to a single, plain file-name component.

/// Reject anything that isn't a plain `https://host/...` URL on one of
/// `allowed_hosts` (exact match or subdomain of). Returns the URL back so call
/// sites can chain it.
pub fn check_https_url<'a>(url: &'a str, allowed_hosts: &[&str]) -> Result<&'a str, String> {
    // Belt and braces: even with `--` in place, never let a `-` lead.
    if url.starts_with('-') {
        return Err("refusing a download URL that starts with '-'".into());
    }
    // No control characters / whitespace — those only ever show up in
    // smuggling attempts, never in a real download link.
    if url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("refusing a download URL containing whitespace or control characters".into());
    }
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("refusing a non-https download URL: {url}"))?;
    // Strip userinfo-style trickery outright rather than trying to parse it.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') {
        return Err("refusing a download URL with embedded credentials".into());
    }
    let host = authority.split(':').next().unwrap_or("").to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("refusing a download URL with no host: {url}"));
    }
    let ok = allowed_hosts.iter().any(|allowed| {
        let allowed = allowed.to_ascii_lowercase();
        host == allowed || host.ends_with(&format!(".{allowed}"))
    });
    if !ok {
        return Err(format!(
            "refusing a download from an unexpected host: {host} (expected {})",
            allowed_hosts.join(", ")
        ));
    }
    Ok(url)
}

/// Hosts GameBanana serves mod files from.
pub const GB_HOSTS: &[&str] = &["gamebanana.com"];

/// Hosts our own releases and tool bundles live on. `objects.githubusercontent`
/// is where `github.com/.../releases/download/...` redirects to.
pub const GH_HOSTS: &[&str] = &["github.com", "githubusercontent.com"];

/// Reduce a remote-supplied name to a single safe file-name component.
/// Falls back to `fallback` when nothing usable survives.
pub fn safe_file_name(name: &str, fallback: &str) -> String {
    // Take the last path segment first (split by hand: on Linux dev builds
    // `Path` doesn't treat `\` as a separator, and this must behave the same
    // everywhere), then strip anything Windows treats specially - drive
    // prefixes, ADS colons, wildcards, control characters.
    let last = name
        .split(['/', '\\'])
        .filter(|s| !s.trim().is_empty())
        .next_back()
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| match c {
            ':' | '<' | '>' | '"' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    cleaned
}

/// SHA-256 of a file via Windows' built-in certutil — same trick `file_md5`
/// uses, so no hash crate is needed for update verification.
pub fn file_sha256(path: &std::path::Path) -> Option<String> {
    let out = crate::procutil::quiet(r"C:\Windows\System32\certutil.exe")
        .arg("-hashfile")
        .arg(path)
        .arg("SHA256")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .nth(1)
        .map(|l| l.replace(' ', "").trim().to_lowercase())
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_curl_option_smuggling() {
        assert!(check_https_url("-KC:\\evil.conf", GB_HOSTS).is_err());
        assert!(check_https_url("--config=C:\\evil.conf", GB_HOSTS).is_err());
        assert!(check_https_url("file:///C:/windows", GB_HOSTS).is_err());
        assert!(check_https_url("http://gamebanana.com/x.zip", GB_HOSTS).is_err());
    }

    #[test]
    fn rejects_off_host_and_lookalike_hosts() {
        assert!(check_https_url("https://evil.com/x.zip", GB_HOSTS).is_err());
        assert!(check_https_url("https://gamebanana.com.evil.com/x", GB_HOSTS).is_err());
        assert!(check_https_url("https://evil.com@gamebanana.com/x", GB_HOSTS).is_err());
    }

    #[test]
    fn accepts_real_urls() {
        assert!(check_https_url("https://gamebanana.com/dl/123", GB_HOSTS).is_ok());
        assert!(check_https_url("https://files.gamebanana.com/mods/a.zip", GB_HOSTS).is_ok());
        assert!(check_https_url(
            "https://objects.githubusercontent.com/x/y.zip",
            GH_HOSTS
        )
        .is_ok());
    }

    #[test]
    fn file_names_cannot_escape() {
        assert_eq!(safe_file_name("../../evil.exe", "mod.zip"), "evil.exe");
        assert_eq!(safe_file_name(r"C:\windows\system32\a.dll", "mod.zip"), "a.dll");
        assert_eq!(safe_file_name("..", "mod.zip"), "mod.zip");
        assert_eq!(safe_file_name("   ", "mod.zip"), "mod.zip");
        assert_eq!(safe_file_name("good name.zip", "mod.zip"), "good name.zip");
    }
}
