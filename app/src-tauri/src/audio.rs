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
    /// Bite length + effects (see `RenderSpec`).
    #[serde(default, flatten)]
    pub spec: RenderSpec,
    /// Path/name of the ffmpeg binary; defaults to `ffmpeg` (on PATH).
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
}

/// How long the finished bite is. `Base` (default) = the base clip's trim
/// window, layers are cut to it; `Longest` = whoever ends last (a long
/// original layered under a short hit rings out); `Custom` = exactly
/// `bite_seconds` (padded with silence or cut).
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BiteMode {
    #[default]
    Base,
    Longest,
    Custom,
}

/// The effect chain of one track or layer. Every field is optional; unset =
/// the effect is off. Applied in a fixed order (reverse, pitch, eq, crush,
/// modulation, compressor, reverb) before the track's volume, so results
/// don't depend on the order the user toggled them. `limiter` / `loudness`
/// run on the finished bite (song level only).
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fx {
    #[serde(default)]
    pub reverse: bool,
    #[serde(default)]
    pub pitch: Option<FxPitch>,
    #[serde(default)]
    pub eq: Option<FxEq>,
    #[serde(default)]
    pub compress: Option<FxCompress>,
    #[serde(default)]
    pub reverb: Option<FxReverb>,
    #[serde(default)]
    pub crush: Option<FxCrush>,
    #[serde(default)]
    pub modulation: Option<FxMod>,
    #[serde(default)]
    pub limiter: bool,
    /// Target loudness for the finished bite - "match the original's
    /// loudness" measures the stock clip and stores it here. Applied as a
    /// measure-then-gain second pass (see `render_spec_to`), so it works on
    /// clips far too short for ffmpeg's integrated LUFS meter.
    #[serde(default)]
    pub loudness: Option<f64>,
    /// "lufs" (EBU R128 integrated) or "rms" (mean level; the fallback for
    /// short clips). The target and our measurement always use the same one.
    #[serde(default)]
    pub loudness_method: String,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPitch {
    /// Semitones, -24..24.
    pub semitones: f64,
    /// Tempo scale, 0.5..2.0 (1 = unchanged).
    #[serde(default = "one")]
    pub tempo: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxEq {
    /// radio | telephone | muffled | bass | bright | custom
    #[serde(default)]
    pub preset: String,
    #[serde(default)]
    pub bass: f64,
    #[serde(default)]
    pub treble: f64,
    /// Hz, 0 = off.
    #[serde(default)]
    pub lowpass: f64,
    #[serde(default)]
    pub highpass: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxCompress {
    /// 0..100
    pub amount: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxReverb {
    /// room | hall | cave | slap
    #[serde(default)]
    pub preset: String,
    /// 0..100
    #[serde(default)]
    pub wet: f64,
    /// Seconds, 0.1..6 (0 = the preset's own).
    #[serde(default)]
    pub decay: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxCrush {
    /// 2..16
    pub bits: f64,
    /// 0..100
    #[serde(default)]
    pub mix: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FxMod {
    /// chorus | flanger | tremolo
    #[serde(default)]
    pub kind: String,
    /// 0..100
    #[serde(default)]
    pub depth: f64,
    /// Hz
    #[serde(default)]
    pub rate: f64,
}

fn one() -> f64 {
    1.0
}

/// Song-level render options beyond trim/gain/fades: the bite length and the
/// track's effect chain. Flattened into `ProcessReq` / `SongCompile` so old
/// JSON (without them) keeps deserializing.
#[derive(Debug, Clone, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSpec {
    #[serde(default)]
    pub bite_mode: BiteMode,
    #[serde(default)]
    pub bite_seconds: f64,
    #[serde(default)]
    pub fx: Option<Fx>,
    /// Seconds of silence before the BASE track (so it can start later than
    /// a layer - e.g. the original plays first, then yours). Layer offsets
    /// stay relative to the bite start.
    #[serde(default)]
    pub start_offset: f64,
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
    /// The layer's own fades (seconds), on its clip window.
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// Lower the BASE track by this many dB while this layer plays (ramped in
    /// and out over ~80ms) - "duck my track under the original". 0 = off.
    #[serde(default)]
    pub duck_db: f64,
    /// Left out of the mix entirely.
    #[serde(default)]
    pub muted: bool,
    /// The layer's own effect chain.
    #[serde(default)]
    pub fx: Option<Fx>,
}

fn staging_dir() -> PathBuf {
    let d = std::env::temp_dir().join("deadlock-intro-tool");
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Which audio filters this ffmpeg build has (`ffmpeg -filters`, read once
/// per binary). Minimal static builds can lack `rubberband` / `afir`; the
/// chain falls back to simpler filters for those.
fn filter_set(ffmpeg: &str) -> std::sync::Arc<std::collections::HashSet<String>> {
    use std::collections::{HashMap, HashSet};
    use std::sync::{Arc, Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<HashSet<String>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(set) = cache.lock().ok().and_then(|m| m.get(ffmpeg).cloned()) {
        return set;
    }
    let mut set = HashSet::new();
    if let Ok(out) = crate::procutil::quiet(ffmpeg).args(["-hide_banner", "-filters"]).output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            // " T.. afir  A->A  ..." : flags, name, io, description
            let mut it = line.split_whitespace();
            let flags = it.next().unwrap_or("");
            if let Some(name) = it.next() {
                if flags.len() <= 4 && !flags.contains('=') {
                    set.insert(name.to_string());
                }
            }
        }
    }
    let arc = Arc::new(set);
    if let Ok(mut m) = cache.lock() {
        m.insert(ffmpeg.to_string(), arc.clone());
    }
    arc
}

/// Map an fx "amount" 0..100 onto a range.
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

/// The filter chain for one track's effects, as `,`-prefixed filters to
/// append after the input's format normalization (empty when nothing is on).
/// `reverb` needs a second stream (the impulse response), so it's returned
/// separately as a source-filter graph snippet the caller wires in.
struct FxChain {
    pre: String,
    /// `Some((ir_graph, afir_args))`: generate the IR from this source-filter
    /// chain and convolve with these args. None = no reverb / aecho in `pre`.
    reverb: Option<(String, String)>,
}

fn fx_chain(fx: &Fx, ffmpeg: &str) -> FxChain {
    let have = filter_set(ffmpeg);
    let has = |n: &str| have.is_empty() || have.contains(n);
    let mut pre = String::new();
    if fx.reverse {
        pre.push_str(",areverse");
    }
    if let Some(p) = &fx.pitch {
        let scale = 2f64.powf(p.semitones.clamp(-24.0, 24.0) / 12.0);
        let tempo = if p.tempo > 0.0 { p.tempo.clamp(0.5, 2.0) } else { 1.0 };
        if (scale - 1.0).abs() > 1e-4 || (tempo - 1.0).abs() > 1e-4 {
            if has("rubberband") {
                pre.push_str(&format!(",rubberband=pitch={}:tempo={}", fmt(scale), fmt(tempo)));
            } else {
                // Tape-style fallback: resample shifts pitch AND speed, atempo
                // corrects the speed back to the requested tempo.
                let corr = (tempo / scale).clamp(0.5, 100.0);
                pre.push_str(&format!(
                    ",asetrate=48000*{},aresample=48000,atempo={}",
                    fmt(scale),
                    fmt(corr)
                ));
            }
        }
    }
    if let Some(eq) = &fx.eq {
        match eq.preset.as_str() {
            "radio" => pre.push_str(",highpass=f=300,lowpass=f=3000,volume=1.4"),
            "telephone" => pre.push_str(",highpass=f=400,lowpass=f=3400,acrusher=bits=12:mix=0.25:mode=log"),
            "muffled" => pre.push_str(",lowpass=f=700"),
            "bass" => pre.push_str(",bass=g=8:f=110"),
            "bright" => pre.push_str(",treble=g=6:f=3000"),
            _ => {
                if eq.highpass > 0.0 {
                    pre.push_str(&format!(",highpass=f={}", fmt(eq.highpass)));
                }
                if eq.lowpass > 0.0 {
                    pre.push_str(&format!(",lowpass=f={}", fmt(eq.lowpass)));
                }
                if eq.bass.abs() > 0.01 {
                    pre.push_str(&format!(",bass=g={}:f=110", fmt(eq.bass.clamp(-20.0, 20.0))));
                }
                if eq.treble.abs() > 0.01 {
                    pre.push_str(&format!(",treble=g={}:f=3000", fmt(eq.treble.clamp(-20.0, 20.0))));
                }
            }
        }
    }
    if let Some(c) = &fx.crush {
        let bits = c.bits.clamp(2.0, 16.0);
        let mix = (c.mix / 100.0).clamp(0.0, 1.0);
        pre.push_str(&format!(",acrusher=bits={}:mix={}:mode=log", fmt(bits), fmt(mix)));
    }
    if let Some(m) = &fx.modulation {
        let depth = (m.depth / 100.0).clamp(0.0, 1.0);
        let rate = if m.rate > 0.0 { m.rate.clamp(0.1, 20.0) } else { 1.0 };
        match m.kind.as_str() {
            "flanger" => pre.push_str(&format!(
                ",flanger=delay=2:depth={}:speed={}",
                fmt(lerp(1.0, 10.0, depth)),
                fmt(rate)
            )),
            "tremolo" => pre.push_str(&format!(",tremolo=f={}:d={}", fmt(rate), fmt(depth))),
            _ => pre.push_str(&format!(
                ",chorus=0.7:0.9:55:0.4:{}:{}",
                fmt(rate),
                fmt(lerp(1.0, 8.0, depth))
            )),
        }
    }
    if let Some(c) = &fx.compress {
        let t = (c.amount / 100.0).clamp(0.0, 1.0);
        if t > 0.0 {
            let threshold = lerp(-10.0, -28.0, t);
            let ratio = lerp(1.5, 8.0, t);
            let makeup = 10f64.powf(lerp(0.0, 8.0, t) / 20.0);
            pre.push_str(&format!(
                ",acompressor=threshold={}dB:ratio={}:attack=5:release=120:makeup={}",
                fmt(threshold),
                fmt(ratio),
                fmt(makeup)
            ));
        }
    }
    let mut reverb = None;
    if let Some(r) = &fx.reverb {
        let wet = (r.wet / 100.0).clamp(0.0, 1.0);
        if wet > 0.0 {
            let (decay, damp) = match r.preset.as_str() {
                "hall" => (1.8, 4500.0),
                "cave" => (3.5, 2500.0),
                "slap" => (0.0, 0.0),
                _ => (0.45, 6000.0), // room
            };
            if r.preset == "slap" || !has("afir") || !has("anoisesrc") {
                // Echo-based: a slapback, or the fallback when convolution
                // isn't available in this build.
                let delay = if r.preset == "slap" { 110.0 } else { lerp(40.0, 90.0, wet) };
                let decay_g = if r.preset == "slap" { lerp(0.2, 0.6, wet) } else { lerp(0.2, 0.7, wet) };
                pre.push_str(&format!(
                    ",aecho=0.8:{}:{}|{}:{}|{}",
                    fmt(lerp(0.5, 0.9, wet)),
                    fmt(delay),
                    fmt(delay * 1.9),
                    fmt(decay_g),
                    fmt(decay_g * 0.6)
                ));
            } else {
                // Convolution with a synthetic impulse response: decaying
                // pink noise, darkened (lowpass) so long tails don't fizz.
                let d = if r.decay > 0.0 { r.decay.clamp(0.1, 6.0) } else { decay };
                let ir = format!(
                    "anoisesrc=d={}:c=pink:r=48000:a=0.6:s=7,afade=t=out:st=0:d={}:curve=exp,lowpass=f={},aformat=sample_fmts=fltp:channel_layouts=mono",
                    fmt(d),
                    fmt(d),
                    fmt(damp)
                );
                let args = format!(
                    "afir=dry={}:wet={}:irfmt=mono:gtype=peak",
                    fmt(lerp(1.0, 0.55, wet)),
                    fmt(lerp(0.0, 1.3, wet))
                );
                reverb = Some((ir, args));
            }
        }
    }
    FxChain { pre, reverb }
}

/// Duck envelope expression for `volume=volume='...':eval=frame`: the base
/// sits at 1 except while a ducking layer plays, where it ramps (80ms) down
/// to the layer's duck gain. Several ducking layers multiply.
fn duck_expr(windows: &[(f64, f64, f64)]) -> String {
    let r = 0.08;
    let mut e = String::from("1");
    for (a, b, db) in windows {
        let g = 10f64.powf(-db.abs() / 20.0);
        e.push_str(&format!(
            "*(1-{}*clip((t-{})/{r},0,1)*clip(({}-t)/{r},0,1))",
            fmt(1.0 - g),
            fmt(*a),
            fmt(*b)
        ));
    }
    e
}

/// Source duration, cached per path for the session (layer windows without an
/// explicit end need it for fades, ducking and the bite length).
fn cached_duration(ffmpeg_path: Option<&str>, path: &str) -> Option<f64> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(d) = cache.lock().ok().and_then(|m| m.get(path).copied()) {
        return Some(d);
    }
    let d = probe_duration(ffmpeg_path, path).ok()?;
    if let Ok(mut m) = cache.lock() {
        m.insert(path.to_string(), d);
    }
    Some(d)
}

/// A layer's clip length in seconds (explicit window, else file length minus
/// the in-point).
fn layer_len(ffmpeg_path: Option<&str>, l: &Layer) -> f64 {
    if l.trim_end > l.trim_start {
        l.trim_end - l.trim_start
    } else {
        (cached_duration(ffmpeg_path, &l.source_audio).unwrap_or(0.0) - l.trim_start).max(0.05)
    }
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
/// One track's processing: format normalization, its effect chain (with the
/// reverb convolution wired in as a generated IR stream), then volume.
/// Returns the graph text ending in `[<label>]`.
fn track_graph(
    input_pad: &str,
    label: &str,
    gain_db: f64,
    fx: Option<&Fx>,
    ffmpeg: &str,
    extra: &str,
    delay: f64,
) -> String {
    let fmt_in = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
    let chain = fx.map(|f| fx_chain(f, ffmpeg)).unwrap_or(FxChain { pre: String::new(), reverb: None });
    // Timeline position: leading silence CONCATENATED in front of the track.
    // (`adelay` after a whole-buffer filter such as areverse or the afir
    // reverb silently drops the delay - the silence never reaches the mix.)
    let (body_label, delay_graph) = if delay > 0.0005 {
        (
            format!("{label}_t"),
            format!(
                "aevalsrc=0:d={}:s=48000:c=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo[{label}_sil];[{label}_sil][{label}_t]concat=n=2:v=0:a=1[{label}];",
                fmt(delay)
            ),
        )
    } else {
        (label.to_string(), String::new())
    };
    let main = match chain.reverb {
        Some((ir, afir)) => format!(
            "{input_pad}{fmt_in}{}[{label}_dry];{ir}[{label}_ir];[{label}_dry][{label}_ir]{afir},volume={gain_db}dB{extra}[{body_label}];",
            chain.pre
        ),
        None => format!("{input_pad}{fmt_in}{},volume={gain_db}dB{extra}[{body_label}];", chain.pre),
    };
    format!("{main}{delay_graph}")
}

/// The whole bite as a `-filter_complex` graph: base + layers (each with its
/// own window, fades, volume, fx and timeline position), ducking of the base
/// under layers that ask for it, the mix cut/padded to the bite length, then
/// the bite-level fades, limiter and loudness. `duration` is the base clip's
/// length; `lens` the layers' clip lengths (parallel to `layers`).
fn mix_graph(
    gain_db: f64,
    duration: f64,
    fade_in: f64,
    fade_out: f64,
    layers: &[Layer],
    lens: &[f64],
    spec: &RenderSpec,
    ffmpeg: &str,
) -> (String, f64) {
    let start = spec.start_offset.max(0.0);
    let base_end = start + duration;
    let bite = match spec.bite_mode {
        BiteMode::Base => base_end,
        BiteMode::Longest => layers
            .iter()
            .zip(lens)
            .filter(|(l, _)| !l.muted)
            .fold(base_end, |m, (l, len)| m.max(l.offset.max(0.0) + len)),
        BiteMode::Custom => {
            if spec.bite_seconds > 0.0 {
                spec.bite_seconds
            } else {
                base_end
            }
        }
    };
    // Base: its start delay first (so the duck envelope's `t` is bite time),
    // then the duck envelope from the layers.
    let ducks: Vec<(f64, f64, f64)> = layers
        .iter()
        .zip(lens)
        .filter(|(l, _)| !l.muted && l.duck_db.abs() > 0.01)
        .map(|(l, len)| (l.offset.max(0.0), l.offset.max(0.0) + len, l.duck_db))
        .collect();
    // The duck envelope is in bite time; the base's own start delay sits in
    // front of it, so shift the windows back by `start` for the base-local
    // expression.
    let shifted: Vec<(f64, f64, f64)> = ducks.iter().map(|(a, b, db)| (a - start, b - start, *db)).collect();
    let base_extra = if shifted.is_empty() {
        String::new()
    } else {
        format!(",volume=volume='{}':eval=frame", duck_expr(&shifted))
    };
    // The song's effects apply to the finished BITE (post-mix, below), not
    // to the base alone - that's what the live preview chain does too.
    let mut graph = track_graph("[0:a]", "a0", gain_db, None, ffmpeg, &base_extra, start);
    let mut pads = String::from("[a0]");
    let mut n = 1;
    for (i, (l, len)) in layers.iter().zip(lens).enumerate() {
        if l.muted {
            continue;
        }
        let extra = fades_af(*len, l.fade_in, l.fade_out);
        let label = format!("a{}", i + 1);
        graph.push_str(&track_graph(
            &format!("[{}:a]", i + 1),
            &label,
            l.gain_db,
            l.fx.as_ref(),
            ffmpeg,
            &extra,
            l.offset.max(0.0),
        ));
        pads.push_str(&format!("[{label}]"));
        n += 1;
    }
    // The mix (or the lone base) -> the song's effect chain -> cut/pad to the
    // bite -> the bite fades -> limiter.
    let mix_pad = if n == 1 {
        "[a0]".to_string()
    } else {
        graph.push_str(&format!("{pads}amix=inputs={n}:duration=longest:normalize=0[mix];"));
        "[mix]".to_string()
    };
    let mut post = String::new();
    post.push_str(&format!(",apad=whole_dur={},atrim=end={}", fmt(bite), fmt(bite)));
    post.push_str(&fades_af(bite, fade_in, fade_out));
    // Loudness matching is a second pass (measure, then gain) - see
    // `render_spec_to`; the limiter then runs in that pass, after the gain.
    if let Some(fx) = &spec.fx {
        if fx.limiter && fx.loudness.is_none() {
            post.push_str(",alimiter=limit=0.95:level=0");
        }
    }
    graph.push_str(&track_graph(&mix_pad, "out", 0.0, spec.fx.as_ref(), ffmpeg, &post, 0.0));
    (graph, bite)
}

fn hash_key(key: &str) -> String {
    let mut h = DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Derive the ffprobe binary path from the ffmpeg path (same directory).
pub(crate) fn ffprobe_from(ffmpeg: &str) -> String {
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

/// Spawn failures for ffmpeg/ffprobe: "program not found" means the tool was
/// never set up on this machine - say so, and say the fix, instead of the
/// raw OS error (a real support case opened with just "running ffprobe:
/// program not found").
fn spawn_err(tool: &str, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        format!(
            "ffmpeg isn't set up on this PC ({tool} not found). Open Setup (the cog, top right) and hit \"Auto detect\" - or if you haven't yet, use the setup wizard's \"Download the compile tools\" button, the bundle includes ffmpeg. Without it the app can't read or convert audio."
        )
    } else {
        format!("running {tool}: {e}")
    }
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
        .map_err(|e| spawn_err(&ffprobe, &e))?;
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
    render_spec_to(
        ffmpeg_path,
        source,
        trim_start,
        trim_end,
        gain_db,
        fade_in,
        fade_out,
        layers,
        &RenderSpec::default(),
        out_path,
    )
}

/// `render_to` with the bite length + effects. The plain trim/gain/fade case
/// (no layers, default spec) keeps the simple `-af` invocation so existing
/// renders stay byte-identical; anything richer goes through the graph.
pub fn render_spec_to(
    ffmpeg_path: Option<&str>,
    source: &str,
    trim_start: f64,
    trim_end: f64,
    gain_db: f64,
    fade_in: f64,
    fade_out: f64,
    layers: &[Layer],
    spec: &RenderSpec,
    out_path: &str,
) -> Result<(), String> {
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    require_input(source)?;
    for l in layers {
        require_input(&l.source_audio)?;
    }
    let duration = (trim_end - trim_start).max(0.01);
    let simple = layers.is_empty() && *spec == RenderSpec::default();
    // `-ss` MUST come before `-i` (input seeking): it resets timestamps to 0 so
    // the fade filters see the TRIMMED timeline. As an output option the fades
    // land on the original timeline instead — a trimmed track's fade-out fires
    // before/at the segment start (silent or fading from the beginning).
    let mut cmd = crate::procutil::quiet(ffmpeg);
    cmd.args(["-y", "-ss", &fmt(trim_start)]);
    if simple {
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
        // only apply to the -i that follows them). Muted layers still take an
        // input slot (the graph skips them) so pad numbering stays simple.
        let mut lens = Vec::with_capacity(layers.len());
        for l in layers {
            if l.trim_start > 0.0 {
                cmd.args(["-ss", &fmt(l.trim_start)]);
            }
            if l.trim_end > l.trim_start {
                cmd.args(["-t", &fmt(l.trim_end - l.trim_start)]);
            }
            cmd.args(["-i", &l.source_audio]);
            lens.push(layer_len(ffmpeg_path, l));
        }
        let (graph, _bite) = mix_graph(gain_db, duration, fade_in, fade_out, layers, &lens, spec, ffmpeg);
        if std::env::var_os("EIM_DEBUG_GRAPH").is_some() {
            eprintln!("ffmpeg graph: {graph}");
        }
        cmd.args(["-filter_complex", &graph, "-map", "[out]"]);
        // Loudness match: render to a temp file, measure it the same way the
        // target was measured, and write the final file through a plain gain
        // (+ the limiter). Works on any clip length, unlike a loudnorm pass.
        let loud = spec.fx.as_ref().and_then(|f| f.loudness.map(|t| (t, f.loudness_method.clone(), f.limiter)));
        if let Some((target, method, limiter)) = loud {
            let tmp = staging_dir().join(format!("loud_{}.wav", hash_key(out_path)));
            let tmp_s = tmp.to_string_lossy().into_owned();
            cmd.arg(&tmp_s);
            let r1 = cmd.output().map_err(|e| spawn_err(ffmpeg, &e))?;
            if !r1.status.success() {
                return Err(String::from_utf8_lossy(&r1.stderr).trim().to_string());
            }
            let m = measure_loudness(ffmpeg_path, &tmp_s)?;
            let ours = if method == "rms" { m.rms } else { m.lufs.unwrap_or(m.rms) };
            let delta = (target - ours).clamp(-40.0, 40.0);
            let mut af = format!("volume={}dB", fmt(delta));
            if limiter {
                af.push_str(",alimiter=limit=0.95:level=0");
            }
            let r2 = crate::procutil::quiet(ffmpeg)
                .args(["-y", "-i", &tmp_s, "-af", &af, out_path])
                .output()
                .map_err(|e| spawn_err(ffmpeg, &e))?;
            let _ = std::fs::remove_file(&tmp);
            return if r2.status.success() {
                Ok(())
            } else {
                Err(String::from_utf8_lossy(&r2.stderr).trim().to_string())
            };
        }
        cmd.arg(out_path);
    }
    let result = cmd
        .output()
        .map_err(|e| spawn_err(ffmpeg, &e))?;
    if result.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
}

/// A clip's loudness two ways: EBU R128 integrated (LUFS, `None` when the
/// clip is too short for the meter - it reports -inf under ~0.4s) and the
/// plain mean level (dB, always available). "Match loudness" compares target
/// and render with the same one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Loudness {
    pub lufs: Option<f64>,
    pub rms: f64,
}

pub fn measure_loudness(ffmpeg_path: Option<&str>, path: &str) -> Result<Loudness, String> {
    require_input(path)?;
    let ffmpeg = ffmpeg_path.unwrap_or("ffmpeg");
    let out = crate::procutil::quiet(ffmpeg)
        .args([
            "-hide_banner",
            "-nostats",
            "-i",
            path,
            "-af",
            "volumedetect,loudnorm=print_format=json",
            "-f",
            "null",
            "-",
        ])
        .output()
        .map_err(|e| spawn_err(ffmpeg, &e))?;
    let text = String::from_utf8_lossy(&out.stderr);
    // loudnorm: `"input_i" : "-23.45",` (or "-inf"); volumedetect: `mean_volume: -24.1 dB`.
    let lufs = (|| {
        let key = "\"input_i\"";
        let pos = text.find(key)?;
        let rest = &text[pos + key.len()..];
        let q1 = rest.find('"')?;
        let q2 = rest[q1 + 1..].find('"')?;
        rest[q1 + 1..q1 + 1 + q2].trim().parse::<f64>().ok()
    })()
    .filter(|v| v.is_finite());
    let rms = (|| {
        let key = "mean_volume:";
        let pos = text.find(key)?;
        let rest = text[pos + key.len()..].trim_start();
        let end = rest.find(" dB")?;
        rest[..end].trim().parse::<f64>().ok()
    })()
    .filter(|v| v.is_finite())
    .ok_or("no level in ffmpeg output")?;
    Ok(Loudness { lufs, rms })
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
                "{}@{}@{}@{}@{}@{}@{}@{}@{}@{}",
                l.source_audio,
                l.gain_db,
                l.offset,
                l.trim_start,
                l.trim_end,
                l.fade_in,
                l.fade_out,
                l.duck_db,
                l.muted,
                serde_json::to_string(&l.fx).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    // The spec only salts the key when it's non-default, so every preview
    // rendered before fx/bite existed is still reused.
    let spec_key = if req.spec == RenderSpec::default() {
        String::new()
    } else {
        format!("|{}", serde_json::to_string(&req.spec).unwrap_or_default())
    };
    let key = format!(
        "v2|{}|{}|{}|{}|{}|{}|{layers_key}{spec_key}",
        req.source_path, req.trim_start, req.trim_end, req.gain_db, req.fade_in, req.fade_out
    );
    let out = staging_dir().join(format!("preview_{}.wav", hash_key(&key)));
    if out.exists() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let out_str = out.to_string_lossy().into_owned();
    render_spec_to(
        req.ffmpeg_path.as_deref(),
        &req.source_path,
        req.trim_start,
        req.trim_end,
        req.gain_db,
        req.fade_in,
        req.fade_out,
        &req.layers,
        &req.spec,
        &out_str,
    )?;
    Ok(out_str)
}

#[cfg(test)]
mod fx_tests {
    use super::*;

    fn layer(offset: f64, fade_out: f64, duck: f64, muted: bool) -> Layer {
        Layer {
            source_audio: "l.wav".into(),
            gain_db: -3.0,
            offset,
            trim_start: 0.0,
            trim_end: 1.5,
            fade_in: 0.0,
            fade_out,
            duck_db: duck,
            muted,
            fx: None,
        }
    }

    #[test]
    fn plain_render_keeps_the_simple_af_chain() {
        // No layers + default spec = the historical `-af` path (byte-identical renders).
        assert_eq!(build_af(6.0, 2.0, 0.5, 0.25), "volume=6dB,afade=t=in:st=0:d=0.500000,afade=t=out:st=1.750000:d=0.250000");
        assert!(RenderSpec::default() == RenderSpec::default());
    }

    #[test]
    fn mix_graph_base_mode_matches_the_old_shape() {
        let layers = [layer(0.25, 0.0, 0.0, false)];
        let (g, bite) = mix_graph(6.0, 2.0, 0.0, 0.0, &layers, &[1.5], &RenderSpec::default(), "ffmpeg-not-here");
        assert_eq!(bite, 2.0);
        assert!(g.contains("[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=6dB[a0];"), "{g}");
        // The layer's timeline position is leading silence concatenated on.
        assert!(g.contains("volume=-3dB[a1_t];aevalsrc=0:d=0.250000:s=48000:c=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo[a1_sil];[a1_sil][a1_t]concat=n=2:v=0:a=1[a1];"), "{g}");
        assert!(g.ends_with("[a0][a1]amix=inputs=2:duration=longest:normalize=0[mix];[mix]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0dB,apad=whole_dur=2.000000,atrim=end=2.000000[out];"), "{g}");
    }

    #[test]
    fn longest_bite_pads_to_the_last_layer_and_fades_the_bite() {
        let layers = [layer(1.0, 0.3, 0.0, false)];
        let spec = RenderSpec { bite_mode: BiteMode::Longest, bite_seconds: 0.0, fx: None, start_offset: 0.0 };
        let (g, bite) = mix_graph(0.0, 2.0, 0.0, 0.5, &layers, &[1.5], &spec, "ffmpeg-not-here");
        assert_eq!(bite, 2.5);
        // Layer fade-out on ITS clip (1.5s), before the delay.
        assert!(g.contains("afade=t=out:st=1.200000:d=0.300000[a1_t];aevalsrc=0:d=1.000000"), "{g}");
        assert!(g.contains("amix=inputs=2:duration=longest:normalize=0[mix];[mix]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0dB,apad=whole_dur=2.500000,atrim=end=2.500000,afade=t=out:st=2.000000:d=0.500000[out];"), "{g}");
    }

    #[test]
    fn custom_bite_muted_layer_and_duck_envelope() {
        let layers = [layer(0.5, 0.0, 6.0, false), layer(0.0, 0.0, 0.0, true)];
        let spec = RenderSpec { bite_mode: BiteMode::Custom, bite_seconds: 4.0, fx: None, start_offset: 0.0 };
        let (g, bite) = mix_graph(0.0, 2.0, 0.0, 0.0, &layers, &[1.5, 1.5], &spec, "ffmpeg-not-here");
        assert_eq!(bite, 4.0);
        // The muted layer takes no pad; the duck envelope rides on the base.
        assert!(g.contains("amix=inputs=2:"), "{g}");
        assert!(!g.contains("[2:a]"), "{g}");
        assert!(g.contains("volume=volume='1*(1-0.498813*clip((t-0.500000)/0.08,0,1)*clip((2.000000-t)/0.08,0,1))':eval=frame[a0]"), "{g}");
        assert!(g.contains("apad=whole_dur=4.000000,atrim=end=4.000000"), "{g}");
    }

    #[test]
    fn no_unmuted_layers_still_applies_the_bite_chain() {
        let layers = [layer(0.0, 0.0, 0.0, true)];
        let fx = Fx { limiter: true, ..Default::default() };
        let spec = RenderSpec { bite_mode: BiteMode::Custom, bite_seconds: 3.0, fx: Some(fx), start_offset: 0.0 };
        let (g, _) = mix_graph(0.0, 2.0, 0.0, 0.0, &layers, &[1.5], &spec, "ffmpeg-not-here");
        assert!(g.ends_with("[a0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0dB,apad=whole_dur=3.000000,atrim=end=3.000000,alimiter=limit=0.95:level=0[out];"), "{g}");
        // Song effects run on the finished bite, after the mix.
        let fx3 = Fx { reverb: Some(FxReverb { preset: "slap".into(), wet: 50.0, decay: 0.0 }), ..Default::default() };
        let spec3 = RenderSpec { bite_mode: BiteMode::Base, bite_seconds: 0.0, fx: Some(fx3), start_offset: 0.0 };
        let (g3, _) = mix_graph(0.0, 2.0, 0.0, 0.0, &[layer(0.0, 0.0, 0.0, false)], &[1.5], &spec3, "ffmpeg-not-here");
        let mix_at = g3.find("[mix];[mix]").unwrap();
        let echo_at = g3.find(",aecho=").unwrap();
        assert!(echo_at > mix_at, "{g3}");
        assert!(!g3[..mix_at].contains("aecho"), "{g3}");
        // With a loudness target the limiter leaves the graph (it runs in the
        // gain pass) and the base can start late: delay first, bite grows.
        let fx2 = Fx { limiter: true, loudness: Some(-20.0), ..Default::default() };
        let spec2 = RenderSpec { bite_mode: BiteMode::Base, bite_seconds: 0.0, fx: Some(fx2), start_offset: 0.5 };
        let (g2, bite2) = mix_graph(0.0, 2.0, 0.0, 0.0, &[], &[], &spec2, "ffmpeg-not-here");
        assert_eq!(bite2, 2.5);
        assert!(g2.contains("volume=0dB[a0_t];aevalsrc=0:d=0.500000:s=48000:c=stereo"), "{g2}");
        assert!(g2.contains("[a0_sil][a0_t]concat=n=2:v=0:a=1[a0];"), "{g2}");
        assert!(!g2.contains("alimiter") && !g2.contains("loudnorm"), "{g2}");
    }

    #[test]
    fn fx_chain_orders_effects_and_wires_reverb_as_an_ir_stream() {
        // An ffmpeg that doesn't exist: the filter set is empty, which `has`
        // treats as "assume everything" (the real binary is probed at render).
        let fx = Fx {
            reverse: true,
            pitch: Some(FxPitch { semitones: 12.0, tempo: 1.0 }),
            eq: Some(FxEq { preset: "radio".into(), ..Default::default() }),
            compress: Some(FxCompress { amount: 50.0 }),
            reverb: Some(FxReverb { preset: "hall".into(), wet: 50.0, decay: 0.0 }),
            crush: Some(FxCrush { bits: 8.0, mix: 50.0 }),
            modulation: Some(FxMod { kind: "tremolo".into(), depth: 50.0, rate: 4.0 }),
            limiter: false,
            loudness: None,
            loudness_method: String::new(),
        };
        let g = track_graph("[0:a]", "a0", 0.0, Some(&fx), "ffmpeg-not-here", "", 0.0);
        let order = ["areverse", "rubberband=pitch=2.000000", "highpass=f=300", "acrusher=bits=8.000000", "tremolo=f=4.000000:d=0.500000", "acompressor=", "[a0_dry];anoisesrc=d=1.800000", "[a0_ir];[a0_dry][a0_ir]afir=dry=", "irfmt=mono:gtype=peak,volume=0dB[a0];"];
        let mut last = 0;
        for o in order {
            let i = g.find(o).unwrap_or_else(|| panic!("{o} missing in {g}"));
            assert!(i >= last, "{o} out of order in {g}");
            last = i;
        }
        // Slapback is echo-based (no IR stream).
        let slap = Fx { reverb: Some(FxReverb { preset: "slap".into(), wet: 40.0, decay: 0.0 }), ..Default::default() };
        let g2 = track_graph("[0:a]", "a0", 0.0, Some(&slap), "ffmpeg-not-here", "", 0.0);
        assert!(g2.contains(",aecho=0.8:") && !g2.contains("afir"), "{g2}");
        // A delayed base with a duck window: the window shifts to base-local time.
        let spec = RenderSpec { bite_mode: BiteMode::Base, bite_seconds: 0.0, fx: None, start_offset: 0.5 };
        let layers = [Layer { source_audio: "l.wav".into(), gain_db: 0.0, offset: 1.0, trim_start: 0.0, trim_end: 1.0, fade_in: 0.0, fade_out: 0.0, duck_db: 6.0, muted: false, fx: None }];
        let (g3, bite3) = mix_graph(0.0, 2.0, 0.0, 0.0, &layers, &[1.0], &spec, "ffmpeg-not-here");
        assert_eq!(bite3, 2.5);
        assert!(g3.contains("clip((t-0.500000)/0.08,0,1)*clip((1.500000-t)/0.08,0,1))':eval=frame[a0_t];"), "{g3}");
    }

    /// Real ffmpeg: every effect + layer feature in one render, checked by
    /// output duration. Needs ffmpeg on PATH (or the bundle).
    ///   cargo test -p app --lib -- --ignored e2e_fx_render --nocapture
    #[test]
    #[ignore]
    fn e2e_fx_render_real_ffmpeg() {
        let ffmpeg = "ffmpeg";
        if crate::procutil::quiet(ffmpeg).arg("-version").output().map(|o| !o.status.success()).unwrap_or(true) {
            eprintln!("skipping: no ffmpeg");
            return;
        }
        let dir = std::env::temp_dir().join("eim_fx_e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let tone = |name: &str, secs: f64, hz: u32| {
            let p = dir.join(name);
            let ok = crate::procutil::quiet(ffmpeg)
                .args(["-y", "-f", "lavfi", "-i", &format!("sine=frequency={hz}:duration={secs}"), "-ac", "2"])
                .arg(&p)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            assert!(ok, "tone {name}");
            p.to_string_lossy().into_owned()
        };
        let base = tone("base.wav", 1.0, 440);
        let orig = tone("orig.wav", 3.0, 220);
        let fx = Fx {
            reverse: true,
            pitch: Some(FxPitch { semitones: -5.0, tempo: 1.0 }),
            eq: Some(FxEq { preset: "custom".into(), bass: 4.0, treble: -3.0, lowpass: 8000.0, highpass: 60.0 }),
            compress: Some(FxCompress { amount: 40.0 }),
            reverb: Some(FxReverb { preset: "hall".into(), wet: 60.0, decay: 0.0 }),
            crush: Some(FxCrush { bits: 10.0, mix: 30.0 }),
            modulation: Some(FxMod { kind: "chorus".into(), depth: 40.0, rate: 1.5 }),
            limiter: true,
            loudness: Some(-18.0),
            loudness_method: "lufs".into(),
        };
        let layers = vec![Layer {
            source_audio: orig,
            gain_db: -4.0,
            offset: 0.2,
            trim_start: 0.0,
            trim_end: 0.0, // to the end (probed)
            fade_in: 0.1,
            fade_out: 0.5,
            duck_db: 8.0,
            muted: false,
            fx: Some(Fx { reverb: Some(FxReverb { preset: "slap".into(), wet: 50.0, decay: 0.0 }), ..Default::default() }),
        }];
        let spec = RenderSpec { bite_mode: BiteMode::Longest, bite_seconds: 0.0, fx: Some(fx), start_offset: 0.3 };
        let out = dir.join("out.wav");
        render_spec_to(Some(ffmpeg), &base, 0.0, 1.0, 3.0, 0.05, 0.2, &layers, &spec, &out.to_string_lossy()).expect("render");
        let d = probe_duration(Some(ffmpeg), &out.to_string_lossy()).unwrap();
        // Longest: the 3s original at 0.2s -> 3.2s bite (the base starting at 0.3s ends at 1.3s).
        assert!((d - 3.2).abs() < 0.1, "duration {d}");
        // Custom bite shorter than the content, no layers, pitch fallback path.
        let spec2 = RenderSpec { bite_mode: BiteMode::Custom, bite_seconds: 0.4, fx: Some(Fx { pitch: Some(FxPitch { semitones: 7.0, tempo: 1.2 }), ..Default::default() }), start_offset: 0.0 };
        let out2 = dir.join("out2.wav");
        render_spec_to(Some(ffmpeg), &base, 0.0, 1.0, 0.0, 0.0, 0.0, &[], &spec2, &out2.to_string_lossy()).expect("render 2");
        let d2 = probe_duration(Some(ffmpeg), &out2.to_string_lossy()).unwrap();
        assert!((d2 - 0.4).abs() < 0.05, "duration {d2}");
        let m = measure_loudness(Some(ffmpeg), &out.to_string_lossy()).unwrap();
        let lufs = m.lufs.unwrap_or(f64::NAN);
        eprintln!("fx render OK: {d:.2}s (target -18 LUFS, measured {lufs:.1} / rms {:.1}), custom bite {d2:.2}s", m.rms);
        assert!((lufs + 18.0).abs() < 1.5, "loudness target missed: {lufs}");
        // Short clips: LUFS is unavailable, the mean level still is, and an
        // RMS-method match lands on target.
        let short = tone("short.wav", 0.2, 440);
        let ms = measure_loudness(Some(ffmpeg), &short).unwrap();
        assert!(ms.lufs.is_none() && ms.rms.is_finite(), "{ms:?}");
        let spec3 = RenderSpec { bite_mode: BiteMode::Base, bite_seconds: 0.0, fx: Some(Fx { loudness: Some(-30.0), loudness_method: "rms".into(), ..Default::default() }), start_offset: 0.0 };
        let out3 = dir.join("out3.wav");
        render_spec_to(Some(ffmpeg), &short, 0.0, 0.2, 0.0, 0.0, 0.0, &[], &spec3, &out3.to_string_lossy()).expect("render 3");
        let m3 = measure_loudness(Some(ffmpeg), &out3.to_string_lossy()).unwrap();
        assert!((m3.rms + 30.0).abs() < 1.0, "rms target missed: {m3:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn spec_round_trips_through_json_with_old_payloads() {
        // An old request (no spec fields) still deserializes to the default.
        let req: ProcessReq = serde_json::from_str(r#"{"sourcePath":"a.mp3","trimStart":0,"trimEnd":1,"gainDb":0}"#).unwrap();
        assert_eq!(req.spec, RenderSpec::default());
        let req2: ProcessReq = serde_json::from_str(r#"{"sourcePath":"a.mp3","trimStart":0,"trimEnd":1,"gainDb":0,"biteMode":"longest","fx":{"reverse":true,"reverb":{"preset":"cave","wet":30}}}"#).unwrap();
        assert_eq!(req2.spec.bite_mode, BiteMode::Longest);
        assert!(req2.spec.fx.as_ref().unwrap().reverse);
        assert_eq!(req2.spec.fx.as_ref().unwrap().reverb.as_ref().unwrap().preset, "cave");
        let req3: ProcessReq = serde_json::from_str(r#"{"sourcePath":"a.mp3","trimStart":0,"trimEnd":1,"gainDb":0,"startOffset":0.25,"fx":{"loudness":-20,"loudnessMethod":"rms"}}"#).unwrap();
        assert_eq!(req3.spec.start_offset, 0.25);
        assert_eq!(req3.spec.fx.as_ref().unwrap().loudness_method, "rms");
    }
}
