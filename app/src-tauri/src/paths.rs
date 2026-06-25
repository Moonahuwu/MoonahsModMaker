//! The single source of truth for path derivation (spec: "The path-derivation
//! rule"). Nothing else in the app may construct these strings by hand.
//!
//! The single easiest bug to introduce is mixing the `.vsnd` (reference) and
//! `.vsnd_c` (compiled file) extensions. One function generates both so they
//! can only ever differ by extension.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DerivedPaths {
    /// Written into the `vsnd_files` array, e.g.
    /// `"sounds/music/match_intro/mysong.vsnd"`. NOTE the `.vsnd` extension.
    pub reference_string: String,
    /// Absolute path of the compiled file placed on disk, e.g.
    /// `"<gameContentRoot>/sounds/music/match_intro/mysong.vsnd_c"`.
    pub compiled_output_path: String,
    /// Path key used when adding the compiled file into a VPK, e.g.
    /// `"sounds/music/match_intro/mysong.vsnd_c"` (content-relative).
    pub vpk_internal_path: String,
}

/// Derive every path for a song from its `sound_name` plus the project's
/// `sound_folder` (content-relative) and `game_content_root` (absolute base).
///
/// `sound_name` must already be sanitized (see [`sanitize_sound_name`]).
pub fn derive(game_content_root: &str, sound_folder: &str, sound_name: &str) -> DerivedPaths {
    let folder = sound_folder.trim_matches('/');
    let root = game_content_root.trim_end_matches(['/', '\\']);
    DerivedPaths {
        reference_string: format!("{folder}/{sound_name}.vsnd"),
        compiled_output_path: format!("{root}/{folder}/{sound_name}.vsnd_c"),
        vpk_internal_path: format!("{folder}/{sound_name}.vsnd_c"),
    }
}

/// Sanitize a raw name (typically from a dropped filename) into a valid
/// `sound_name`: lowercase, ASCII alphanumerics + `_`, spaces/dashes/dots
/// collapsed to `_`. Returns `"track"` if nothing usable remains.
pub fn sanitize_sound_name(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_underscore = false;
    for ch in input.trim().chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_underscore = false;
        } else if matches!(c, ' ' | '-' | '.' | '_') {
            if !last_underscore && !out.is_empty() {
                out.push('_');
                last_underscore = true;
            }
        }
        // any other character (unicode, punctuation) is dropped
    }
    while out.ends_with('_') {
        out.pop();
    }
    if out.is_empty() {
        "track".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_and_compiled_differ_only_by_extension() {
        let d = derive("/game/content", "sounds/music/match_intro", "mysong");
        assert_eq!(d.reference_string, "sounds/music/match_intro/mysong.vsnd");
        assert_eq!(
            d.compiled_output_path,
            "/game/content/sounds/music/match_intro/mysong.vsnd_c"
        );
        assert_eq!(d.vpk_internal_path, "sounds/music/match_intro/mysong.vsnd_c");
    }

    #[test]
    fn trailing_slashes_normalized() {
        let d = derive("/game/content/", "/sounds/music/match_intro/", "x");
        assert_eq!(
            d.compiled_output_path,
            "/game/content/sounds/music/match_intro/x.vsnd_c"
        );
    }

    #[test]
    fn sanitize_examples() {
        assert_eq!(sanitize_sound_name("My Cool Song.mp3"), "my_cool_song_mp3");
        assert_eq!(sanitize_sound_name("  Hello---World  "), "hello_world");
        assert_eq!(sanitize_sound_name("ünîcödé!!!"), "ncd");
        assert_eq!(sanitize_sound_name("???"), "track");
    }
}
