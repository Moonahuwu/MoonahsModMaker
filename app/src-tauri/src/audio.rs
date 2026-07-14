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
    /// Extra tracks mixed UNDER the clip (see `render_to`'s layer notes).
    #[serde(default)]
    pub layers: Vec<Layer>,
    /// Path/name of the ffmpeg binary; defaults to `ffmpeg` (on PATH).
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

/// One extra track mixed into a clip, timeline-style: its own clip window
/// (`trim_start`..`trim_end` within the source), placed `offset` seconds into
/// the bite, at its own volume - all cut to the base clip's length. The
/// events file never sees layers; they're baked into the single rendered
/// audio file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub source_audio: String,
    #[serde(default)]
    pub gain_db: f64,
    /// Seconds into the bite where this layer starts playing.
    #[serde(default)]
    pub offset: f64,
    /// Clip window within the layer's source. `trim_end <= trim_start` means
    /// "to the end of the file".
    #[serde(default)]
    pub trim_start: f64,
    #[serde(default)]
    pub trim_end: f64,
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
    format!(
        "volume={gain_db}dB{}",
        fades_af(duration, fade_in, fade_out)
    )
}

/// Just the fade filters (leading commas), or "" when no fades. Split out so
/// the layered path can apply fades AFTER the mix - a fade-out describes the
/// whole sound bite, not only the base track.
fn fades_af(duration: f64, fade_in: f64, fade_out: f64) -> String {
    let mut af = String::new();
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

/// The `-filter_complex` graph for a layered clip. Every input is normalized
/// to one format first (amix does NOT resample mismatched inputs), given its
/// own volume, shifted to its timeline position (`adelay` - ms are exact
/// because the resample to 48k comes first), then mixed cut to the BASE
/// clip's length (`duration=first`; input 0 is trimmed by `-ss`/`-t`, each
/// layer's clip window by its own input `-ss`/`-t`). `normalize=0` keeps
/// levels as-is instead of amix's default divide-by-N ducking; fades run on
/// the finished mix.
fn mix_graph(gain_db: f64, duration: f64, fade_in: f64, fade_out: f64, layers: &[Layer]) -> String {
    let fmt_in = "aresample=48000,aformat=channel_layouts=stereo";
    let mut graph = String::new();
    let mut pads = String::new();
    graph.push_str(&format!("[0:a]{fmt_in},volume={gain_db}dB[a0];"));
    pads.push_str("[a0]");
    for (i, l) in layers.iter().enumerate() {
        let delay = if l.offset > 0.0 {
            format!(",adelay={}:all=1", (l.offset * 1000.0).round() as i64)
        } else {
            String::new()
        };
        graph.push_str(&format!(
            "[{}:a]{fmt_in},volume={}dB{delay}[a{}];",
            i + 1,
            l.gain_db,
            i + 1
        ));
        pads.push_str(&format!("[a{}]", i + 1));
    }
    graph.push_str(&format!(
        "{pads}amix=inputs={}:duration=first:normalize=0{}[out]",
        layers.len() + 1,
        fades_af(duration, fade_in, fade_out)
    ));
    graph
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

/// A missing input would surface as a raw ffmpeg dump ("Error opening input:
/// No such file or directory") - catch it first with a message that says what
/// happened and what to do.
fn require_input(path: &str) -> Result<(), String> {
    if std::path::Path::new(path).exists() {
        return Ok(());
    }
    Err(format!(
        "source audio is missing on disk: {path}. If this track or layer came from a decoded game sound, the app auto-repairs it when the profile loads - restart the app or switch to this profile again. If it still fails, remove the track and re-add it."
    ))
}

pub fn probe_duration(ffmpeg_path: Option<&str>, path: &str) -> Result<f64, String> {
    require_input(path)?;
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
/// compile pipeline to place the source clip in the content tree). `layers`
/// mix extra tracks under the clip - the output is still ONE audio file.
pub fn render_to(
    ffmpeg_path: Option<&str>,
    source: &str,
    trim_start: f64,
    trim_end: f64,
    gain_db: f64,
    fade_in: f64,
    fade_out: f64,
    layers: &[Layer],
    out_path: &str,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    require_input(source)?;
    for l in layers {
        require_input(&l.source_audio)?;
    }
    let duration = (trim_end - trim_start).max(0.01);
    // `-ss` MUST come before `-i` (input seeking): it resets timestamps to 0 so
    // the fade filters see the TRIMMED timeline. As an output option the fades
    // land on the original timeline instead — a trimmed track's fade-out fires
    // before/at the segment start (silent or fading from the beginning).
    let mut cmd = crate::procutil::quiet(ffmpeg);
    cmd.args(["-y", "-ss", &fmt(trim_start)]);
    if layers.is_empty() {
        cmd.args([
            "-i",
            source,
            "-t",
            &fmt(duration),
            "-af",
            &build_af(gain_db, duration, fade_in, fade_out),
            out_path,
        ]);
    } else {
        // Input-side `-t` on the base: amix's `duration=first` measures the
        // first INPUT stream, so the base must already be cut to the trim
        // window or the mix would run to the file's end.
        cmd.args(["-t", &fmt(duration), "-i", source]);
        // Each layer's clip window rides as ITS input's options (input options
        // only apply to the -i that follows them).
        for l in layers {
            if l.trim_start > 0.0 {
                cmd.args(["-ss", &fmt(l.trim_start)]);
            }
            if l.trim_end > l.trim_start {
                cmd.args(["-t", &fmt(l.trim_end - l.trim_start)]);
            }
            cmd.args(["-i", &l.source_audio]);
        }
        cmd.args([
            "-filter_complex",
            &mix_graph(gain_db, duration, fade_in, fade_out, layers),
            "-map",
            "[out]",
            out_path,
        ]);
    }
    let result = cmd
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
/// Previews go through `render_to` so a layered clip previews EXACTLY as it
/// compiles.
pub fn process(req: &ProcessReq) -> Result<String, String> {
    // "v2" salts the cache past the -ss placement fix (fades on the trimmed
    // timeline) so previews rendered with the old broken order aren't reused.
    let layers_key: String = req
        .layers
        .iter()
        .map(|l| {
            format!(
                "{}@{}@{}@{}@{}",
                l.source_audio, l.gain_db, l.offset, l.trim_start, l.trim_end
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    let key = format!(
        "v2|{}|{}|{}|{}|{}|{}|{layers_key}",
        req.source_path, req.trim_start, req.trim_end, req.gain_db, req.fade_in, req.fade_out
    );
    let out = staging_dir().join(format!("preview_{}.wav", hash_key(&key)));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let out_str = out.to_string_lossy().into_owned();
    render_to(
        req.ffmpeg_path.as_deref(),
        &req.source_path,
        req.trim_start,
        req.trim_end,
        req.gain_db,
        req.fade_in,
        req.fade_out,
        &req.layers,
        &out_str,
    )?;
    Ok(out_str)
}
