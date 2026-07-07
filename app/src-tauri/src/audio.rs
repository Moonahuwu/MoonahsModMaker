//! ffmpeg/ffprobe integration: probe source duration and render the processed
//! (trimmed + gain-boosted) preview clip. Output goes to a staging dir; the
//! frontend plays it via the Tauri asset protocol (convertFileSrc).

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub duration: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReq {
    pub source_path: String,
    pub trim_start: f64,
    pub trim_end: f64,
    pub gain_db: f64,
    /// Fade-in duration in seconds applied at the start of the trimmed clip.
    #[serde(default)]
    pub fade_in: f64,
    /// Fade-out duration in seconds applied at the end of the trimmed clip.
    /// 0 = no fade.
    #[serde(default)]
    pub fade_out: f64,
    /// Path/name of the ffmpeg binary; defaults to `ffmpeg` (on PATH).
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

fn staging_dir() -> PathBuf {
    let d = std::env::temp_dir().join("deadlock-intro-tool");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Format a float for an ffmpeg time/value arg (avoid scientific notation).
fn fmt(v: f64) -> String {
    format!("{v:.6}")
}

/// Build the ffmpeg `-af` filter chain: gain, optional fade-in at the start, and
/// optional fade-out anchored to the end of the (trimmed) clip of `duration`.
fn build_af(gain_db: f64, duration: f64, fade_in: f64, fade_out: f64) -> String {
    let mut af = format!("volume={gain_db}dB");
    if fade_in > 0.0 {
        let d = fade_in.min(duration).max(0.0);
        af.push_str(&format!(",afade=t=in:st=0:d={}", fmt(d)));
    }
    if fade_out > 0.0 {
        let d = fade_out.min(duration).max(0.0);
        let st = (duration - d).max(0.0);
        af.push_str(&format!(",afade=t=out:st={}:d={}", fmt(st), fmt(d)));
    }
    af
}

fn hash_key(key: &str) -> String {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Derive the ffprobe binary path from the ffmpeg path (same directory).
fn ffprobe_from(ffmpeg: &str) -> String {
    let p = std::path::Path::new(ffmpeg);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            let exe = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
            return parent.join(exe).to_string_lossy().into_owned();
        }
    }
    "ffprobe".to_string()
}

pub fn probe_duration(ffmpeg_path: Option<&str>, path: &str) -> Result<f64, String> {
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    let ffprobe = ffprobe_from(ffmpeg);
    let out = crate::procutil::quiet(&ffprobe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            path,
        ])
        .output()
        .map_err(|e| format!("running {ffprobe}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    s.trim()
        .parse::<f64>()
        .map_err(|e| format!("parsing duration '{}': {e}", s.trim()))
}

/// Render trimmed + gain-boosted audio to a specific output path (used by the
/// compile pipeline to place the source clip in the content tree).
pub fn render_to(
    ffmpeg_path: Option<&str>,
    source: &str,
    trim_start: f64,
    trim_end: f64,
    gain_db: f64,
    fade_in: f64,
    fade_out: f64,
    out_path: &str,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    let duration = (trim_end - trim_start).max(0.01);
    // `-ss` MUST come before `-i` (input seeking): it resets timestamps to 0 so
    // the fade filters see the TRIMMED timeline. As an output option the fades
    // land on the original timeline instead — a trimmed track's fade-out fires
    // before/at the segment start (silent or fading from the beginning).
    let result = crate::procutil::quiet(ffmpeg)
        .args([
            "-y",
            "-ss",
            &fmt(trim_start),
            "-i",
            source,
            "-t",
            &fmt(duration),
            "-af",
            &build_af(gain_db, duration, fade_in, fade_out),
            out_path,
        ])
        .output()
        .map_err(|e| format!("running {ffmpeg}: {e}"))?;
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
}

/// Render the processed preview. Returns the absolute path of the cached WAV.
/// Identical requests reuse the cached file (same hash → skip re-render).
pub fn process(req: &ProcessReq) -> Result<String, String> {
    let ffmpeg = req.ffmpeg_path.as_deref().unwrap_or("ffmpeg");
    // "v2" salts the cache past the -ss placement fix (fades on the trimmed
    // timeline) so previews rendered with the old broken order aren't reused.
    let key = format!(
        "v2|{}|{}|{}|{}|{}|{}",
        req.source_path, req.trim_start, req.trim_end, req.gain_db, req.fade_in, req.fade_out
    );
    let out = staging_dir().join(format!("preview_{}.wav", hash_key(&key)));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }

    let duration = (req.trim_end - req.trim_start).max(0.01);
    let out_str = out.to_string_lossy().into_owned();
    // `-ss` before `-i` — see render_to: fades must run on the trimmed timeline.
    let result = crate::procutil::quiet(ffmpeg)
        .args([
            "-y",
            "-ss",
            &fmt(req.trim_start),
            "-i",
            &req.source_path,
            "-t",
            &fmt(duration),
            "-af",
            &build_af(req.gain_db, duration, req.fade_in, req.fade_out),
            &out_str,
        ])
        .output()
        .map_err(|e| format!("running {ffmpeg}: {e}"))?;

    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    Ok(out_str)
}
