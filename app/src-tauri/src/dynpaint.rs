//! Dynamic Paintings: animated art on in-world paintings and signs.
//!
//! Technique and painting registry by goldenboy44 (leonyarov), used with
//! permission - https://gamebanana.com/tools/23828 and
//! https://github.com/leonyarov/deadlock-dynamic-paintings.
//!
//! How it works: the color texture is a grid of frames; the material windows
//! one cell (`F_ENABLE_TEXTURE_TRANSFORMS` + `g_vAlbedoTexcoordScale`) and a
//! `DynamicParams` expression steps the window off `$ent_age`. Expressions do
//! NOT evaluate on baked world geometry (one frozen frame - he tried), so the
//! art rides flat quads that OVERRIDE a prop's model (his map-mined host
//! choice + pre-built quads, bundled with permission); the hideout's stock
//! painting is blacked out behind its quad. Unlike his web tool - which ships
//! 115 pre-compiled material templates and writes BC7 in the browser because
//! a website can't run resourcecompiler - we compile the EXACT material per
//! animation with the CSDK (spike-proven: the `$ent_age` expression compiles
//! and rides into the vmat_c verbatim).
//!
//! Multi-surface hosts: his shipped models carry ONE quad each (all panels
//! override the same model path), but each card's mesh is the stock geometry
//! + its quad as a face set of one DMX. So to animate several signs at once
//! we rebuild the host model at compile time: decompile the bundled card
//! models into kits (cached), split the quads out by material (the helper's
//! `dmxsplit`, Datamodel-level - the base card keeps its stock mesh), give
//! every quad its OWN per-panel material, and compile a combo vmdl. Proven
//! vs the CSDK: a 2-panel combo compiles to ~the single-card size (the
//! compiler strips unreferenced vertices) and references both materials.
//!
//! Re-hosted quads (`Rehost`): a map update can bake a host prop into the
//! scenery (no entity = nothing ticks the expression = dead quads) while the
//! surfaces it served stay put. The quads then move to another prop: the
//! bundled card models still supply the geometry, each quad is moved rigidly
//! from the old host's model space into the new one's, and the new host's own
//! mesh + collision come out of the game pak at compile time.

use crate::compile::{
    fingerprint, poster_staged_rels, run_resource_compiler_multi, vmat_texture_refs,
    CompileConfig, CompileReport,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One selectable surface of a host: the quad's real proportions (map-mined
/// by goldenboy44) plus the pre-built model carrying exactly that quad,
/// bundled with permission.
pub(crate) struct DynPanel {
    pub(crate) id: &'static str,
    cell: (u32, u32),
    model: &'static [u8],
}

macro_rules! panel {
    ($id:literal, $w:literal x $h:literal, $file:literal) => {
        DynPanel {
            id: $id,
            cell: ($w, $h),
            model: include_bytes!(concat!("../templates/dynpaint/", $file)),
        }
    };
}

/// Where a host prop stands in its map: the entity's origin and yaw (every
/// Midtown host is a yaw-only prop at scale 1).
#[derive(Clone, Copy)]
pub(crate) struct HostPose {
    origin: [f64; 3],
    yaw: f64,
}

/// Quads authored in one prop's model space, carried by another prop. The
/// 2026-09-29 Midtown rebuild baked the church archway into the map's scenery
/// (no entity any more, so nothing draws a model override), while five of the
/// surfaces it served stayed exactly where they were. The bundled card models
/// keep supplying the quad geometry; each quad is moved rigidly from the old
/// host's space into the new one's: world = R(from.yaw) p + from.origin, then
/// new-local = R(-to.yaw) (world - to.origin). Measured vs the CSDK: the quads
/// land within 0.01 units of their old world positions (the e2e re-measures
/// it on every run).
pub(crate) struct Rehost {
    /// The model path the bundled card models were built at - their kits
    /// decompile under it.
    card_model_rel: &'static str,
    /// The original host's placement (goldenboy44's registry).
    from: HostPose,
    /// The new host's placement in today's map (its entity lump).
    to: HostPose,
}

impl Rehost {
    /// The rigid move old-host-local -> new-host-local: (yaw in degrees
    /// about Z, translation applied after the rotation).
    pub(crate) fn delta(&self) -> (f64, [f64; 3]) {
        let (s, c) = (-self.to.yaw).to_radians().sin_cos();
        let d = [
            self.from.origin[0] - self.to.origin[0],
            self.from.origin[1] - self.to.origin[1],
            self.from.origin[2] - self.to.origin[2],
        ];
        (self.from.yaw - self.to.yaw, [d[0] * c - d[1] * s, d[0] * s + d[1] * c, d[2]])
    }
}

/// One animated-painting host: the material/texture paths our compile owns,
/// the prop model the quads override, and the surfaces to choose from.
pub(crate) struct DynTarget {
    /// Base material path. Single-surface hosts use it as-is (the bundled
    /// quad references it); combo hosts derive per-panel twins from it.
    vmat_rel: &'static str,
    /// Base frame-grid texture path (per-panel twins for combo hosts).
    texture_rel: &'static str,
    /// The prop model the quads override, at its vanilla path.
    host_model_rel: &'static str,
    /// Multi-surface host: rebuild the model from kits so EVERY active
    /// panel gets its own quad + material. Single-surface hosts ship the
    /// bundled model verbatim.
    combo: bool,
    /// Stock textures blanked behind the quad (staged as our black texture
    /// under these exact vanilla names). Hideout only: its quad letterboxes
    /// over the stock portrait; the midtown quads are opaque and exact.
    blackout: &'static [&'static str],
    /// Params after the flipbook block: goldenboy44's measured values. All
    /// quads are unlit (baked light samples at the host's position, not the
    /// quad's) with volume fog zeroed (scene lights lit the fog along the
    /// view ray and washed the quad); the hideout additionally bakes the
    /// room's dimming in as a tint (~R x0.31 G x0.16 B x0.08, measured off
    /// an in-game shot). Midtown is daylight: full albedo, no tint.
    extra_params: &'static str,
    /// Set when the quads ride a DIFFERENT prop than the one their bundled
    /// models were authored for.
    rehost: Option<Rehost>,
    panels: &'static [DynPanel],
}

const UNLIT_TINTED: &str = "\t\"F_UNLIT\"\t\"1\"\n\t\"g_bMaskColorTint1\"\t\"1\"\n\t\"g_nTextureColorTintMode1\"\t\"0\"\n\t\"g_vColorTint1\"\t\"[0.314700 0.162600 0.080800 0.000000]\"\n\t\"g_flVolumeFogAmount\"\t\"0\"\n";
const UNLIT_PLAIN: &str = "\t\"F_UNLIT\"\t\"1\"\n\t\"g_flVolumeFogAmount\"\t\"0\"\n";

const HIDEOUT_PORTRAIT: DynTarget = DynTarget {
    vmat_rel: "models/hideout/materials/dynpaint_canvas.vmat",
    texture_rel: "models/hideout/materials/dynpaint_hideout_portrait_canvas.png",
    host_model_rel: "models/hideout/hideout_ghost_pianist.vmdl_c",
    combo: false,
    blackout: &[
        "models/hideout/materials/hideout_portrait_large_color_psd_bc05d6c1.vtex_c",
        "models/hideout/materials/hideout_portrait_large_selfillum_psd_e2306db2.vtex_c",
    ],
    extra_params: UNLIT_TINTED,
    rehost: None,
    panels: &[panel!("card1", 512 x 764, "hideout_card1.vmdl_c")],
};

/// Midtown, library + T2 camp (Amber side): the five painting surfaces that
/// survived the 2026-09-29 map rebuild, riding the plaza gate - the one
/// single-instance, this-map-only, un-animated `prop_dynamic` left in the map
/// (found 2026-10-04 by sweeping every entity lump). Its stock mesh +
/// collision are rebuilt into the replacement from the game pak: the server
/// keeps stock physics, so a client model without collision rubber-bands. The
/// quads still come from the church-archway card models, moved into the
/// gate's space (`Rehost`). The other six old surfaces (ad frames, standee)
/// are gone from the map and were dropped.
const HIDDEN_KING: DynTarget = DynTarget {
    vmat_rel: "models/architecture/arch_plaza_01/materials/dynpaint_hidden_king.vmat",
    texture_rel: "models/architecture/arch_plaza_01/materials/dynpaint_midtown_hidden_king.png",
    host_model_rel: "models/architecture/arch_plaza_01/arch_plaza_01_gate_structure_01.vmdl_c",
    combo: true,
    blackout: &[],
    extra_params: UNLIT_PLAIN,
    rehost: Some(Rehost {
        card_model_rel: "models/architecture/arch_church/arch_church_door_large.vmdl_c",
        from: HostPose { origin: [8107.992676, -1564.999756, 256.0], yaw: 89.999916 },
        to: HostPose { origin: [5984.0, -2392.0, 256.0], yaw: 180.03302 },
    }),
    panels: &[
        panel!("card1", 364 x 720, "hidden_king_card1.vmdl_c"),
        panel!("card2", 364 x 720, "hidden_king_card2.vmdl_c"),
        panel!("card5", 368 x 708, "hidden_king_card5.vmdl_c"),
        panel!("card7", 364 x 720, "hidden_king_card7.vmdl_c"),
        panel!("card10", 756 x 348, "hidden_king_card10.vmdl_c"),
    ],
};

/// Midtown, bodega corner: 5 sign surfaces riding (of all things) a trash
/// can lid - the one single-instance clutter model on that side of the map.
/// DEAD since the 2026-09-29 rebuild (the lid is baked scenery now and that
/// side has no usable host prop); the frontend registry holds it offline.
const ARCHMOTHER: DynTarget = DynTarget {
    vmat_rel: "models/clutter/materials/dynpaint_archmother.vmat",
    texture_rel: "models/clutter/materials/dynpaint_midtown_archmother.png",
    host_model_rel: "models/clutter/trash_can_lid_01.vmdl_c",
    combo: true,
    blackout: &[],
    extra_params: UNLIT_PLAIN,
    rehost: None,
    panels: &[
        panel!("card1", 1028 x 256, "archmother_card1.vmdl_c"),
        panel!("card2", 1028 x 256, "archmother_card2.vmdl_c"),
        panel!("card3", 556 x 472, "archmother_card3.vmdl_c"),
        panel!("card4", 512 x 512, "archmother_card4.vmdl_c"),
        panel!("card5", 884 x 296, "archmother_card5.vmdl_c"),
    ],
};

pub(crate) fn dyn_target(id: &str) -> Option<&'static DynTarget> {
    match id {
        "hideout_portrait_canvas" => Some(&HIDEOUT_PORTRAIT),
        "midtown_hidden_king" => Some(&HIDDEN_KING),
        "midtown_archmother" => Some(&ARCHMOTHER),
        _ => None,
    }
}

/// Per-panel material/texture path: the base with the panel id spliced in
/// before the extension (combo hosts only - single hosts keep the base, the
/// bundled quad references it verbatim).
pub(crate) fn panel_rel(base: &str, t: &DynTarget, panel_id: &str) -> String {
    if !t.combo {
        return base.to_string();
    }
    match base.rsplit_once('.') {
        Some((stem, ext)) => format!("{stem}_{panel_id}.{ext}"),
        None => format!("{base}_{panel_id}"),
    }
}

/// One animated surface to build (mirrors the TS type; camelCase like every
/// backend type).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DynpaintCompile {
    /// Registry id, e.g. `hideout_portrait_canvas`.
    pub id: String,
    /// The image/gif/video the frames come from.
    pub source_media: String,
    /// Seconds per frame; 0 (or absent) = follow the source's frame rate.
    #[serde(default)]
    pub dwell: f64,
    /// Frame cap - keeps the atlas (and VRAM) sane. 240 covers ~10s at 25fps.
    #[serde(default = "default_max_frames")]
    pub max_frames: u32,
    /// Which surface of the host (see DynTarget.panels).
    #[serde(default = "default_panel")]
    pub panel: String,
    /// cover (fill, crop the overflow), contain (letterbox), stretch.
    #[serde(default = "default_fit")]
    pub fit: String,
    /// Where the visible window sits on the overflowing axis (cover) or
    /// where the image sits in the letterbox (contain), 0..1, 0.5 = center.
    #[serde(default = "default_crop")]
    pub crop_x: f64,
    #[serde(default = "default_crop")]
    pub crop_y: f64,
}

fn default_max_frames() -> u32 {
    240
}

fn default_panel() -> String {
    "card1".into()
}

fn default_fit() -> String {
    "cover".into()
}

fn default_crop() -> f64 {
    0.5
}

/// The per-frame ffmpeg fit filter: how the source lands on the cell. Same
/// modes the regular poster regions offer, plus goldenboy44's crop position
/// (it only bites on the axis with something to spare).
pub(crate) fn fit_filter(fit: &str, cw: u32, ch: u32, crop_x: f64, crop_y: f64) -> String {
    let cx = crop_x.clamp(0.0, 1.0);
    let cy = crop_y.clamp(0.0, 1.0);
    match fit {
        "stretch" => format!("scale={cw}:{ch}"),
        "contain" => format!(
            "scale={cw}:{ch}:force_original_aspect_ratio=decrease,pad={cw}:{ch}:x=(ow-iw)*{cx:.3}:y=(oh-ih)*{cy:.3}:color=black"
        ),
        _ => format!(
            "scale={cw}:{ch}:force_original_aspect_ratio=increase,crop={cw}:{ch}:x=(iw-ow)*{cx:.3}:y=(ih-oh)*{cy:.3}"
        ),
    }
}

/// Nearest power of two (ties round down).
fn pow2_near(x: u32) -> u32 {
    let x = x.max(1);
    let up = x.next_power_of_two();
    let down = (up / 2).max(1);
    if x == up || up - x < x - down {
        up
    } else {
        down
    }
}

/// Grid shape for `n` frames: POWER-OF-TWO cell counts and cell sizes, so
/// the texture and every cell boundary are power-of-two - GenerateMips
/// rejects npot textures and fails the whole material compile (e2e-caught).
/// Frames are fitted to the quad's REAL aspect first and stretched into the
/// pow2 cell; the quad stretches them back, so net distortion is zero - only
/// the sampling resolution is anisotropic. `max_tex` caps the texture side
/// (smaller when many surfaces of a host animate at once, or VRAM adds up).
pub(crate) fn grid_dims(n: u32, cell: (u32, u32), max_tex: u32) -> (u32, u32, u32, u32) {
    let n = n.max(1);
    let want = ((n as f64) * cell.1 as f64 / cell.0 as f64).sqrt().round().max(1.0) as u32;
    let cols = pow2_near(want).min(n.next_power_of_two());
    let rows = n.div_ceil(cols).next_power_of_two();
    let mut cw2 = cell.0.next_power_of_two().min(1024);
    let mut ch2 = cell.1.next_power_of_two().min(1024);
    while cols * cw2 > max_tex && cw2 > 4 {
        cw2 /= 2;
    }
    while rows * ch2 > max_tex && ch2 > 4 {
        ch2 /= 2;
    }
    (cols, rows, cw2, ch2)
}

/// Per-surface texture ceiling for a host, graduated by how many of its
/// surfaces animate at once. Compiled grids are BC-compressed (~1 byte per
/// texel plus a third for mips), so one full 8192 grid is ~85MB of VRAM -
/// fine for a painting or two, not for eleven signs at once. The ceiling
/// only bites when the frame count actually asks for it (grid_dims grows
/// the texture on demand), so short loops cost the same at every tier.
pub(crate) fn host_max_tex(active_surfaces: usize) -> u32 {
    match active_surfaces {
        0..=2 => 8192,
        3..=4 => 4096,
        _ => 2048,
    }
}

/// goldenboy44's frame-step expression, generated for the EXACT frame count
/// and dwell (his web tool had to snap to a pre-compiled matrix). `$ent_age`
/// is the host entity's age; `frac(age/period)*n` is the current frame,
/// decomposed into the cell's column and row; the returned offset centers
/// the UV window on that cell. The `\n` stay as literal backslash-n in the
/// vmat - that is the form the compiler accepts (spike-proven).
pub(crate) fn flipbook_expr(n: u32, dwell: f64, cols: u32, rows: u32) -> String {
    let period = n as f64 * dwell;
    format!(
        "v0 = frac($ent_age/{period:.4})*{n};\\nv1 = v0-frac(v0);\\nv2 = v1/{cols};\\nv3 = v2-frac(v2);\\nv4 = v1-({cols}*v3);\\nreturn float2(((v4+.5)/{cols})-.5,((v3+.5)/{rows})-.5);"
    )
}

/// Content path of a generated helper texture, next to the base texture.
fn aux_rel(t: &DynTarget, name: &str) -> String {
    let dir = t.texture_rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    format!("{dir}/{name}")
}

/// The complete source vmat for one surface - or a still picture when the
/// media has a single frame: same quad, no expression (the period would be a
/// division by zero), the window just sits on the one cell.
pub(crate) fn vmat_text(
    t: &DynTarget,
    texture_rel: &str,
    n: u32,
    dwell: f64,
    cols: u32,
    rows: u32,
) -> String {
    let sx = 1.0 / cols as f64;
    let sy = 1.0 / rows as f64;
    let white = aux_rel(t, "dynpaint_white.png");
    let black = aux_rel(t, "dynpaint_black.png");
    let normal = aux_rel(t, "dynpaint_flatnormal.png");
    let dynamic = if n > 1 {
        format!(
            "\t\"DynamicParams\"\n\t{{\n\t\t\"g_vAlbedoTexcoordOffset1\"\t\"{}\"\n\t}}\n",
            flipbook_expr(n, dwell, cols, rows)
        )
    } else {
        String::new()
    };
    format!(
        "\"Layer0\"\n{{\n\t\"shader\"\t\"pbr.vfx\"\n\t\"F_ENABLE_TEXTURE_TRANSFORMS\"\t\"1\"\n{extra}\t\"g_flAlbedoTexcoordRotation1\"\t\"0\"\n\t\"g_vAlbedoTexcoordOffset1\"\t\"[0.000000 0.000000 0.000000 0.000000]\"\n\t\"g_vAlbedoTexcoordScale1\"\t\"[{sx:.6} {sy:.6} 0.000000 0.000000]\"\n\t\"TextureColor1\"\t\"{texture_rel}\"\n\t\"TextureAmbientOcclusion1\"\t\"{white}\"\n\t\"TextureNormal1\"\t\"{normal}\"\n\t\"TextureSelfIllumMask1\"\t\"{black}\"\n\t\"TextureTintMask1\"\t\"{white}\"\n{dynamic}}}\n",
        extra = t.extra_params,
    )
}

fn run_ffmpeg(ffmpeg: &str, args: &[&str]) -> Result<(), String> {
    let out = crate::procutil::quiet(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("launching ffmpeg ({ffmpeg}): {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        // The last lines of ffmpeg's stderr are progress/summary noise; the
        // real cause sits above them. Keep enough tail to include it, skip
        // pure progress lines, and name the exact invocation so a report
        // line is reproducible as-is.
        let text = String::from_utf8_lossy(&out.stderr);
        let mut lines: Vec<&str> = text
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with("frame=") && !t.starts_with("size=")
            })
            .collect();
        let keep = lines.split_off(lines.len().saturating_sub(8));
        Err(format!("{} | cmd: {ffmpeg} {}", keep.join(" | "), args.join(" ")))
    }
}

/// Animated WebP sniff: RIFF/WEBP magic with an ANIM chunk in the header
/// region. Twitter/Discord serve these constantly (often named .gif);
/// ffmpeg builds broadly cannot decode them, so they route via the helper.
pub(crate) fn is_animated_webp(path: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 256];
    let n = f.read(&mut buf).unwrap_or(0);
    let b = &buf[..n];
    b.len() >= 16
        && &b[0..4] == b"RIFF"
        && &b[8..12] == b"WEBP"
        && b.windows(4).any(|w| w == b"ANIM")
}

/// The source's frames-per-second, via ffprobe next to ffmpeg.
fn probe_fps(ffmpeg: &str, media: &str) -> Option<f64> {
    let ffprobe = crate::audio::ffprobe_from(ffmpeg);
    let out = crate::procutil::quiet(&ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate",
            "-of",
            "default=nw=1:nk=1",
            media,
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let rate = text.trim();
    let (num, den) = rate.split_once('/').unwrap_or((rate, "1"));
    let (num, den): (f64, f64) = (num.trim().parse().ok()?, den.trim().parse().ok()?);
    (den > 0.0 && num > 0.0).then(|| num / den)
}

/// Bump when the kit/combo pipeline changes shape, so stale caches refill.
const KIT_VERSION: &str = "k1";

/// The model path a target's bundled card models were built at.
fn card_model_rel(t: &DynTarget) -> &'static str {
    t.rehost.as_ref().map(|r| r.card_model_rel).unwrap_or(t.host_model_rel)
}

fn model_stem(model_rel: &str) -> String {
    Path::new(model_rel)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn model_dir(model_rel: &str) -> String {
    Path::new(model_rel)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

/// `len|mtime` of a file, "" when unreadable (cache identity).
fn file_ident(path: &str) -> String {
    std::fs::metadata(path)
        .ok()
        .map(|m| {
            let secs = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}|{secs}", m.len())
        })
        .unwrap_or_default()
}

/// A panel's decompiled kit (its fused mesh DMX + the physics DMX), built
/// once from the bundled card model and cached under the content tree (a
/// dot-dir the compiler never touches). The helper's `model` needs a real
/// vpk, so the card model is packed into a scratch vpk first.
fn ensure_kit(
    helper: &str,
    content_root: &Path,
    t: &DynTarget,
    p: &DynPanel,
    host_stem: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let dir = content_root.join(".eim_dynpaint_kits").join(host_stem).join(p.id);
    let card_rel = card_model_rel(t);
    let internal = card_rel.trim_end_matches("_c");
    let find_parts = |dir: &Path| -> Option<(PathBuf, PathBuf)> {
        let model_dir = dir.join(Path::new(internal).parent()?);
        let mut fused = None;
        let mut phys = None;
        for e in std::fs::read_dir(&model_dir).ok()?.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with("_phys.dmx") {
                phys = Some(e.path());
            } else if name.ends_with(".dmx") {
                fused = Some(e.path());
            }
        }
        Some((fused?, phys?))
    };
    if std::fs::read_to_string(dir.join(".v")).map(|v| v.trim() == KIT_VERSION).unwrap_or(false) {
        if let Some(parts) = find_parts(&dir) {
            return Ok(parts);
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
    // Scratch pack: the bundled card model at its real internal path.
    let scratch = std::env::temp_dir().join("eim_dynpaint_pack").join(host_stem).join(p.id);
    let _ = std::fs::remove_dir_all(&scratch);
    let model_abs = scratch.join("tree").join(card_rel);
    if let Some(parent) = model_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&model_abs, p.model).map_err(|e| e.to_string())?;
    let vpk = scratch.join("pack.vpk");
    crate::vpk::pack(helper, &scratch.join("tree").to_string_lossy(), &vpk.to_string_lossy())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::vpk::model_from_vpk(helper, &vpk.to_string_lossy(), card_rel, &dir.to_string_lossy())?;
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::write(dir.join(".v"), KIT_VERSION).map_err(|e| e.to_string())?;
    find_parts(&dir).ok_or_else(|| format!("kit for {host_stem}/{} has no mesh DMX", p.id))
}

/// A re-hosted target's NEW host model, decompiled from the game pak into a
/// kit (its vmdl + mesh/physics DMX) and cached per game-pak build - a patch
/// that touches the prop re-kits it. Returns the kit's vmdl.
fn ensure_stock_kit(
    helper: &str,
    pak: &str,
    content_root: &Path,
    t: &DynTarget,
) -> Result<PathBuf, String> {
    let internal = t.host_model_rel.trim_end_matches("_c");
    let dir = content_root
        .join(".eim_dynpaint_kits")
        .join(model_stem(t.host_model_rel))
        .join("_stock");
    let want = format!("{KIT_VERSION}|{}", file_ident(pak));
    let vmdl = dir.join(internal);
    if vmdl.is_file()
        && std::fs::read_to_string(dir.join(".v")).map(|v| v.trim() == want).unwrap_or(false)
    {
        return Ok(vmdl);
    }
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    crate::vpk::model_from_vpk(helper, pak, t.host_model_rel, &dir.to_string_lossy())?;
    if !vmdl.is_file() {
        return Err(format!(
            "the game no longer has {} - the map's host prop changed, update the app",
            t.host_model_rel
        ));
    }
    std::fs::write(dir.join(".v"), want).map_err(|e| e.to_string())?;
    Ok(vmdl)
}

/// Add RenderMeshFile nodes to the end of a decompiled vmdl's RenderMeshList,
/// leaving every other node (the stock mesh, the physics shape with its
/// surface property) exactly as the game's model has it.
pub(crate) fn splice_render_meshes(vmdl: &str, mesh_rels: &[String]) -> Option<String> {
    let list = vmdl.find("\"RenderMeshList\"")?;
    let children = list + vmdl[list..].find("children")?;
    let open = children + vmdl[children..].find('[')?;
    let mut depth = 0usize;
    let mut close = None;
    for (i, ch) in vmdl[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    // Back up over the bracket's own indentation so the nodes sit on their
    // own lines above it.
    let line_start = vmdl[..close].rfind('\n').map(|i| i + 1).unwrap_or(close);
    let nodes: String = mesh_rels
        .iter()
        .map(|rel| {
            let stem = model_stem(rel);
            format!(
                "\t\t\t\t\t{{\n\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\tname = \"{stem}\"\n\t\t\t\t\t\tfilename = \"{rel}\"\n\t\t\t\t\t}},\n"
            )
        })
        .collect();
    Some(format!("{}{}{}", &vmdl[..line_start], nodes, &vmdl[line_start..]))
}

/// A re-hosted combo model's sources: the new host's stock kit copied in,
/// one moved quad DMX per built surface (each on its own per-panel
/// material), and the kit's vmdl with the quads spliced in. Returns the
/// vmdl's absolute path.
fn stage_rehosted_model(
    helper: &str,
    cfg: &CompileConfig,
    content_root: &Path,
    t: &DynTarget,
    rh: &Rehost,
    built: &[(&DynpaintCompile, &DynPanel)],
) -> Result<String, String> {
    let pak = cfg.pak_path.as_deref().filter(|p| !p.is_empty()).ok_or_else(|| {
        "the game pak is not set in Settings - it is needed to rebuild the host prop".to_string()
    })?;
    let kit_vmdl = ensure_stock_kit(helper, pak, content_root, t)?;
    let model_dir_rel = model_dir(t.host_model_rel);
    let out_dir = content_root.join(&model_dir_rel);
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    // The kit's DMX files, at the paths its vmdl names.
    let kit_dir = kit_vmdl.parent().ok_or_else(|| "host kit has no folder".to_string())?;
    for e in std::fs::read_dir(kit_dir).map_err(|e| e.to_string())?.flatten() {
        if e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("dmx")) {
            std::fs::copy(e.path(), out_dir.join(e.file_name())).map_err(|e| e.to_string())?;
        }
    }
    let (yaw, translation) = rh.delta();
    let card_stem = model_stem(card_model_rel(t));
    let mut quad_rels: Vec<String> = Vec::new();
    for (_, p) in built {
        let (fused, _) = ensure_kit(helper, content_root, t, p, &card_stem)
            .map_err(|e| format!("{}: {e}", p.id))?;
        let rel = format!("{model_dir_rel}/dynpaint_quad_{}.dmx", p.id);
        crate::vpk::dmx_split_moved(
            helper,
            &fused.to_string_lossy(),
            &content_root.join(&rel).to_string_lossy(),
            "keep",
            "dynpaint",
            &panel_rel(t.vmat_rel, t, p.id),
            yaw,
            translation,
        )
        .map_err(|e| format!("{}: {e}", p.id))?;
        quad_rels.push(rel);
    }
    let text = std::fs::read_to_string(&kit_vmdl).map_err(|e| e.to_string())?;
    let vmdl = splice_render_meshes(&text, &quad_rels)
        .ok_or_else(|| "the host prop's model has no render mesh list".to_string())?;
    let vmdl_abs = content_root.join(t.host_model_rel.trim_end_matches("_c"));
    std::fs::write(&vmdl_abs, vmdl).map_err(|e| e.to_string())?;
    Ok(vmdl_abs.to_string_lossy().into_owned())
}

/// The classic combo sources (quads riding the prop they were authored for):
/// the base panel's full mesh + quad-only meshes for the rest, every quad on
/// its own per-panel material. Returns the vmdl's absolute path.
fn stage_combo_model(
    helper: &str,
    content_root: &Path,
    t: &DynTarget,
    built: &[(&DynpaintCompile, &DynPanel)],
) -> Result<String, String> {
    let host_stem = model_stem(t.host_model_rel);
    let model_dir_rel = model_dir(t.host_model_rel);
    let mut mesh_rels: Vec<String> = Vec::new();
    let mut phys_src: Option<PathBuf> = None;
    for (i, (_, p)) in built.iter().enumerate() {
        let (fused, phys) = ensure_kit(helper, content_root, t, p, &host_stem)
            .map_err(|e| format!("{}: {e}", p.id))?;
        phys_src.get_or_insert(phys);
        let (mode, out_name) = if i == 0 {
            ("rename", format!("dynpaint_base_{}.dmx", p.id))
        } else {
            ("keep", format!("dynpaint_quad_{}.dmx", p.id))
        };
        let out_rel = format!("{model_dir_rel}/{out_name}");
        crate::vpk::dmx_split(
            helper,
            &fused.to_string_lossy(),
            &content_root.join(&out_rel).to_string_lossy(),
            mode,
            "dynpaint",
            &panel_rel(t.vmat_rel, t, p.id),
        )
        .map_err(|e| format!("{}: {e}", p.id))?;
        mesh_rels.push(out_rel);
    }
    let phys_rel = format!("{model_dir_rel}/dynpaint_phys.dmx");
    let phys_src = phys_src.ok_or_else(|| "no surface kit to build from".to_string())?;
    std::fs::copy(&phys_src, content_root.join(&phys_rel)).map_err(|e| e.to_string())?;
    let vmdl_abs = content_root.join(t.host_model_rel.trim_end_matches("_c"));
    if let Some(parent) = vmdl_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&vmdl_abs, combo_vmdl(&mesh_rels, &phys_rel)).map_err(|e| e.to_string())?;
    Ok(vmdl_abs.to_string_lossy().into_owned())
}

/// The combo model source: the base panel's full mesh (stock geometry + its
/// quad) plus quad-only meshes for every other active panel, physics kept.
fn combo_vmdl(mesh_rels: &[String], phys_rel: &str) -> String {
    let meshes: String = mesh_rels
        .iter()
        .map(|rel| {
            let stem = rel
                .rsplit('/')
                .next()
                .unwrap_or("mesh")
                .rsplit_once('.')
                .map(|(s, _)| s)
                .unwrap_or("mesh");
            format!(
                "\n\t\t\t\t\t{{\n\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\tname = \"{stem}\"\n\t\t\t\t\t\tfilename = \"{rel}\"\n\t\t\t\t\t}},"
            )
        })
        .collect();
    format!(
        "<!-- kv3 encoding:text:version{{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d}} format:modeldoc28:version{{fb63b6ca-f435-4aa0-a2c7-c66ddc651dca}} -->\n{{\n\trootNode = \n\t{{\n\t\t_class = \"RootNode\"\n\t\tchildren = \n\t\t[\n\t\t\t{{\n\t\t\t\t_class = \"BoneMarkupList\"\n\t\t\t\tchildren = [  ]\n\t\t\t\tbone_cull_type = \"None\"\n\t\t\t}},\n\t\t\t{{\n\t\t\t\t_class = \"RenderMeshList\"\n\t\t\t\tchildren = \n\t\t\t\t[{meshes}\n\t\t\t\t]\n\t\t\t}},\n\t\t\t{{\n\t\t\t\t_class = \"PhysicsShapeList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{{\n\t\t\t\t\t\t_class = \"PhysicsMeshFile\"\n\t\t\t\t\t\tfilename = \"{phys_rel}\"\n\t\t\t\t\t\tparent_bone = \"\"\n\t\t\t\t\t\tsurface_prop = \"default\"\n\t\t\t\t\t\tcollision_tags = \"\"\n\t\t\t\t\t\tname = \"\"\n\t\t\t\t\t}},\n\t\t\t\t]\n\t\t\t}},\n\t\t]\n\t}}\n}}\n"
    )
}

/// Everything one compiled surface material stages: the vmat_c + every
/// texture the compiled material references.
fn material_rels(content_root: &Path, compiled_root: &Path, vmat_rel: &str) -> Vec<String> {
    match std::fs::read_to_string(content_root.join(vmat_rel)) {
        Ok(text) => poster_staged_rels(compiled_root, vmat_rel, &vmat_texture_refs(&text)),
        Err(_) => Vec::new(),
    }
}

/// Frames -> grid texture + exact material for one surface. Returns the
/// vmat rel it wrote (materials compile in one batch afterwards) plus a
/// human line for the report.
fn build_surface(
    content_root: &Path,
    t: &DynTarget,
    dp: &DynpaintCompile,
    p: &DynPanel,
    ffmpeg: &str,
    helper: Option<&str>,
    max_tex: u32,
    report: &mut CompileReport,
) -> Result<(String, String), ()> {
    let step = format!("animated: {} {}", dp.id, p.id);
    // Seconds per frame: the knob, else the source's own rate (filled in per
    // extraction path below), clamped to goldenboy44's sane range (60fps ..
    // one frame a minute).
    let explicit_dwell = dp.dwell > 0.0;
    let mut dwell = if explicit_dwell { dp.dwell.clamp(0.0167, 60.0) } else { 0.04 };
    let max_frames = dp.max_frames.clamp(1, 2000);

    // Pass 1: frames at full cell size, fitted to the quad's aspect.
    let frames_dir = std::env::temp_dir().join("eim_dynpaint").join(&dp.id).join(p.id);
    let _ = std::fs::remove_dir_all(&frames_dir);
    // A leftover frame from an earlier run would silently pad this run's
    // count (the grid pass reads the whole dir) - refuse instead.
    if frames_dir.exists() && std::fs::read_dir(&frames_dir).map(|r| r.count() > 0).unwrap_or(false)
    {
        report.soft_fail(
            step,
            format!(
                "stale frames could not be cleared from {} (file locked by another program?)",
                frames_dir.display()
            ),
        );
        return Err(());
    }
    if let Err(e) = std::fs::create_dir_all(&frames_dir) {
        report.soft_fail(step, e.to_string());
        return Err(());
    }
    let (cw, ch) = p.cell;
    let pattern = frames_dir.join("f_%05d.png");
    if is_animated_webp(&dp.source_media) {
        // ffmpeg builds broadly fail on Twitter/Discord-style animated WebP
        // ("Cannot determine format of input after EOF" - reproduced on
        // 7.1.1, 8.0.1 AND a 2026 master build), so the helper's Skia does
        // the decode (it reads exactly what Chrome reads) and ffmpeg only
        // fits the resulting plain PNGs onto the cell.
        let Some(helper) = helper.filter(|h| !h.is_empty()) else {
            report.soft_fail(
                step,
                "animated WebP needs the vpk helper - set it in Settings".to_string(),
            );
            return Err(());
        };
        let raw_dir = frames_dir.with_file_name(format!("{}_raw", p.id));
        let _ = std::fs::remove_dir_all(&raw_dir);
        let decoded = match crate::vpk::webp_frames(
            helper,
            &dp.source_media,
            &raw_dir.to_string_lossy(),
            max_frames,
        ) {
            Ok(out) => out,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&raw_dir);
                report.soft_fail(step, format!("decoding animated WebP: {e}"));
                return Err(());
            }
        };
        if !explicit_dwell {
            if let Some(ms) = decoded
                .split_whitespace()
                .find_map(|w| w.strip_prefix("avg_ms="))
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|ms| *ms > 0.0)
            {
                dwell = (ms / 1000.0).clamp(0.0167, 60.0);
            }
        }
        let raw_pattern = raw_dir.join("f_%05d.png");
        let fit = fit_filter(&dp.fit, cw, ch, dp.crop_x, dp.crop_y);
        let fitted = run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-framerate",
                "25",
                "-i",
                &raw_pattern.to_string_lossy(),
                "-vf",
                &fit,
                &pattern.to_string_lossy(),
            ],
        );
        let _ = std::fs::remove_dir_all(&raw_dir);
        if let Err(e) = fitted {
            report.soft_fail(step, e);
            return Err(());
        }
    } else {
        if !explicit_dwell {
            dwell = probe_fps(ffmpeg, &dp.source_media)
                .map(|fps| (1.0 / fps).clamp(0.0167, 60.0))
                .unwrap_or(0.04);
        }
        let vf = format!(
            "fps={:.6},{}",
            1.0 / dwell,
            fit_filter(&dp.fit, cw, ch, dp.crop_x, dp.crop_y)
        );
        if let Err(e) = run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-i",
                &dp.source_media,
                "-vf",
                &vf,
                "-frames:v",
                &max_frames.to_string(),
                &pattern.to_string_lossy(),
            ],
        ) {
            report.soft_fail(step, e);
            return Err(());
        }
    }
    let n = std::fs::read_dir(&frames_dir).map(|rd| rd.count()).unwrap_or(0) as u32;
    if n == 0 {
        report.soft_fail(step, "no frames could be read from the file".to_string());
        return Err(());
    }

    // Pass 2: tile into the pow2 grid (the stretch cancels on the quad).
    let (cols, rows, sw, sh) = grid_dims(n, p.cell, max_tex);
    let texture_rel = panel_rel(t.texture_rel, t, p.id);
    let grid_abs = content_root.join(&texture_rel);
    if let Some(parent) = grid_abs.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tile_vf = format!("scale={sw}:{sh},tile={cols}x{rows}");
    if let Err(e) = run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-framerate",
            "25",
            "-i",
            &pattern.to_string_lossy(),
            "-vf",
            &tile_vf,
            "-frames:v",
            "1",
            &grid_abs.to_string_lossy(),
        ],
    ) {
        report.soft_fail(step, e);
        return Err(());
    }
    let _ = std::fs::remove_dir_all(&frames_dir);

    // Tiny generated helper textures (white AO/tint mask, black self-illum -
    // it doubles as the hideout blackout - and a flat normal).
    for (name, color) in [
        ("dynpaint_white.png", "white"),
        ("dynpaint_black.png", "black"),
        ("dynpaint_flatnormal.png", "0x8080ff"),
    ] {
        let abs = content_root.join(aux_rel(t, name));
        if abs.exists() {
            continue;
        }
        let src = format!("color={color}:size=8x8");
        if let Err(e) = run_ffmpeg(
            ffmpeg,
            &["-y", "-f", "lavfi", "-i", &src, "-frames:v", "1", &abs.to_string_lossy()],
        ) {
            report.soft_fail(step, e);
            return Err(());
        }
    }

    let vmat_rel = panel_rel(t.vmat_rel, t, p.id);
    let vmat_abs = content_root.join(&vmat_rel);
    if let Err(e) = std::fs::write(&vmat_abs, vmat_text(t, &texture_rel, n, dwell, cols, rows)) {
        report.soft_fail(step, e.to_string());
        return Err(());
    }
    let detail = if n > 1 {
        format!("{n} frame(s) at {dwell:.3}s each, {cols}x{rows} grid, cell {sw}x{sh}")
    } else {
        format!("still image, cell {sw}x{sh}")
    };
    Ok((vmat_rel, detail))
}

/// Compile every configured animated surface, grouped by host: per-surface
/// grid textures + exact materials, and - for multi-surface hosts - a combo
/// model rebuilt so every active panel carries its own quad and material.
/// Returns compiled-root-relative rels (staged into every variant, like
/// posters) + whether anything rebuilt. Never hard-fails: every problem
/// soft-fails into the report.
pub fn compile_dynpaints(
    cfg: &CompileConfig,
    content_root: &Path,
    compiled_root: &Path,
    report: &mut CompileReport,
) -> (Vec<String>, bool) {
    let mut rels: Vec<String> = Vec::new();
    let mut dirty = false;
    if cfg.dynpaints.is_empty() {
        return (rels, false);
    }
    let ffmpeg = cfg.ffmpeg_path.as_deref().filter(|s| !s.is_empty()).unwrap_or("ffmpeg");

    // Group by host, keeping order stable and dropping duplicate surfaces
    // (two entries on one surface would fight over one material).
    let mut by_target: BTreeMap<&str, Vec<&DynpaintCompile>> = BTreeMap::new();
    for dp in &cfg.dynpaints {
        let list = by_target.entry(dp.id.as_str()).or_default();
        if list.iter().any(|e| e.panel == dp.panel) {
            report.soft_fail(
                format!("animated: {} {}", dp.id, dp.panel),
                "this surface is configured twice - keeping the first".to_string(),
            );
            continue;
        }
        list.push(dp);
    }

    'targets: for (target_id, entries) in &by_target {
        let Some(t) = dyn_target(target_id) else {
            report.soft_fail(
                format!("animated: {target_id}"),
                "unknown target - update the app".to_string(),
            );
            continue;
        };
        if !t.combo && entries.len() > 1 {
            report.soft_fail(
                format!("animated: {target_id}"),
                "this host has a single surface - keeping the first entry".to_string(),
            );
        }
        let take = if t.combo { entries.len() } else { 1 };

        // Resolve panels + media up front; a broken entry drops its host so
        // a partial (wrong) model can never ship.
        let mut active: Vec<(&DynpaintCompile, &DynPanel)> = Vec::new();
        for dp in entries.iter().take(take) {
            let Some(p) = t.panels.iter().find(|p| p.id == dp.panel) else {
                report.soft_fail(
                    format!("animated: {} {}", dp.id, dp.panel),
                    "unknown surface - update the app".to_string(),
                );
                continue 'targets;
            };
            if !Path::new(&dp.source_media).is_file() {
                report.soft_fail(
                    format!("animated: {} {}", dp.id, dp.panel),
                    format!("media file not found: {}", dp.source_media),
                );
                continue 'targets;
            }
            active.push((dp, p));
        }
        if active.is_empty() {
            continue;
        }

        // Host identity: every entry's media + knobs + the pipeline version.
        let mut ident_parts = vec![format!("dp3|{KIT_VERSION}|{target_id}")];
        if let Some(rh) = &t.rehost {
            // The host's own mesh comes out of the game pak: a game update
            // (or a corrected placement) rebuilds the model.
            let (yaw, tr) = rh.delta();
            ident_parts.push(format!(
                "rehost|{yaw:.6}|{:.4}|{:.4}|{:.4}|{}",
                tr[0],
                tr[1],
                tr[2],
                file_ident(cfg.pak_path.as_deref().unwrap_or(""))
            ));
        }
        for (dp, p) in &active {
            let meta = std::fs::metadata(&dp.source_media).ok();
            ident_parts.push(format!(
                "{}|{}|{:.3}|{:.3}|{}|{}|{}|{:.4}|{}",
                p.id,
                dp.fit,
                dp.crop_x,
                dp.crop_y,
                dp.source_media,
                meta.as_ref().map(|m| m.len()).unwrap_or(0),
                meta.and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                dp.dwell,
                dp.max_frames
            ));
        }
        let ident = fingerprint(&ident_parts.join("\n"));
        let stamp = compiled_root.join(format!("{}.eim_dynpaint_stamp", t.host_model_rel));
        let model_c = compiled_root.join(t.host_model_rel);

        let host_rels = |active: &[(&DynpaintCompile, &DynPanel)]| -> Vec<String> {
            let mut out = vec![t.host_model_rel.to_string()];
            for (_, p) in active {
                out.extend(material_rels(
                    content_root,
                    compiled_root,
                    &panel_rel(t.vmat_rel, t, p.id),
                ));
            }
            for b in t.blackout {
                out.push((*b).to_string());
            }
            out
        };
        if model_c.exists()
            && std::fs::read_to_string(&stamp).map(|s| s.trim() == ident).unwrap_or(false)
        {
            let prior = host_rels(&active);
            if prior.len() > 1 + t.blackout.len() {
                rels.extend(prior);
                report.ok_step(format!("animated: {target_id}"), "unchanged - skipped".to_string());
                continue;
            }
        }
        dirty = true;

        // Per-surface textures + materials. Many surfaces on one host add
        // up in VRAM, so the per-surface texture cap shrinks with count
        // (adding/removing a surface changes the host ident, so every grid
        // re-renders at the tier that matches the new count).
        let max_tex = host_max_tex(active.len());
        let mut built: Vec<(&DynpaintCompile, &DynPanel)> = Vec::new();
        let mut vmat_rels: Vec<String> = Vec::new();
        let mut details: Vec<String> = Vec::new();
        for &(dp, p) in &active {
            match build_surface(
                content_root,
                t,
                dp,
                p,
                ffmpeg,
                cfg.vpk_helper_path.as_deref(),
                max_tex,
                report,
            ) {
                Ok((vmat_rel, detail)) => {
                    built.push((dp, p));
                    vmat_rels.push(vmat_rel);
                    details.push(format!("{}: {detail}", p.id));
                }
                // Its soft_fail is already in the report: drop just this
                // surface and keep building the rest of the wall.
                Err(()) => {}
            }
        }
        if built.is_empty() {
            continue;
        }
        let vmat_abs: Vec<String> = vmat_rels
            .iter()
            .map(|r| content_root.join(r).to_string_lossy().into_owned())
            .collect();
        match run_resource_compiler_multi(cfg, &vmat_abs) {
            Ok(detail) => {
                report.ok_step(format!("compile (animated materials): {target_id}"), detail)
            }
            Err(e) => {
                report.soft_fail(format!("compile (animated materials): {target_id}"), e);
                continue;
            }
        }

        // The host model.
        if t.combo {
            // Rebuild the host with a quad per surface, each on its own
            // per-panel material (re-hosted targets: on the new prop).
            let Some(helper) = cfg.vpk_helper_path.as_deref().filter(|h| !h.is_empty()) else {
                report.soft_fail(
                    format!("animated: {target_id}"),
                    "vpkHelperPath not set - needed to build the multi-surface model".to_string(),
                );
                continue;
            };
            let staged = match &t.rehost {
                Some(rh) => stage_rehosted_model(helper, cfg, content_root, t, rh, &built),
                None => stage_combo_model(helper, content_root, t, &built),
            };
            let vmdl_abs = match staged {
                Ok(v) => v,
                Err(e) => {
                    report.soft_fail(format!("animated: {target_id}"), e);
                    continue;
                }
            };
            match run_resource_compiler_multi(cfg, &[vmdl_abs]) {
                Ok(detail) => {
                    report.ok_step(format!("compile (animated model): {target_id}"), detail)
                }
                Err(e) => {
                    report.soft_fail(format!("compile (animated model): {target_id}"), e);
                    continue;
                }
            }
        } else {
            // Single surface: ship the bundled quad model verbatim.
            let host_abs = compiled_root.join(t.host_model_rel);
            if let Some(parent) = host_abs.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = std::fs::write(&host_abs, built[0].1.model) {
                report.soft_fail(format!("animated: {target_id}"), e.to_string());
                continue;
            }
        }

        // Hideout blackout: the compiled black texture at the stock
        // portrait's exact hashed names (rename-at-staging, like digimod).
        if !t.blackout.is_empty() {
            let black_dir = compiled_root.join(
                aux_rel(t, "").trim_end_matches('/').replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            let black_vtex: Option<PathBuf> = std::fs::read_dir(&black_dir).ok().and_then(|rd| {
                rd.flatten().map(|e| e.path()).find(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().to_string());
                    name.map_or(false, |n| {
                        n.starts_with("dynpaint_black_png_") && n.ends_with(".vtex_c")
                    })
                })
            });
            let Some(black_vtex) = black_vtex else {
                report.soft_fail(
                    format!("animated: {target_id}"),
                    "compiled black texture not found - the material compile likely failed"
                        .to_string(),
                );
                continue;
            };
            for b in t.blackout {
                let dest = compiled_root.join(b);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Err(e) = std::fs::copy(&black_vtex, &dest) {
                    report.soft_fail(format!("animated: {target_id}"), e.to_string());
                    continue 'targets;
                }
            }
        }

        rels.extend(host_rels(&built));
        if built.len() == active.len() {
            let _ = std::fs::write(&stamp, &ident);
        } else {
            // Partial wall: never stamp, so the next compile retries the
            // failed surface(s) instead of skipping the host as done.
            let _ = std::fs::remove_file(&stamp);
            details.push(format!("{} surface(s) failed, built without them", active.len() - built.len()));
        }
        report.ok_step(format!("animated: {target_id}"), details.join(" · "));
    }
    rels.sort();
    rels.dedup();
    (rels, dirty)
}

#[cfg(test)]
mod dynpaint_tests {
    use super::*;

    #[test]
    fn registry_targets_are_sound() {
        for id in ["hideout_portrait_canvas", "midtown_hidden_king", "midtown_archmother"] {
            let t = dyn_target(id).unwrap();
            assert!(!t.panels.is_empty());
            let mut seen = std::collections::HashSet::new();
            for p in t.panels {
                assert!(seen.insert(p.id), "{id}: duplicate panel {}", p.id);
                assert!(p.cell.0 >= 128 && p.cell.1 >= 128, "{id}/{}", p.id);
                // Bundled compiled models carry headerVersion 12 at offset 4
                // (the engine hard-rejects anything else).
                assert!(p.model.len() > 1000, "{id}/{} model too small", p.id);
                assert_eq!(u16::from_le_bytes([p.model[4], p.model[5]]), 12, "{id}/{}", p.id);
            }
        }
        // Hidden King: the five surfaces the rebuilt Midtown still has,
        // carried by the plaza gate.
        let hk = dyn_target("midtown_hidden_king").unwrap();
        assert_eq!(hk.panels.iter().map(|p| p.id).collect::<Vec<_>>(), ["card1", "card2", "card5", "card7", "card10"]);
        assert!(hk.rehost.is_some() && hk.host_model_rel.contains("arch_plaza_01_gate_structure_01"));
        assert_eq!(card_model_rel(hk), "models/architecture/arch_church/arch_church_door_large.vmdl_c");
        let hideout = dyn_target("hideout_portrait_canvas").unwrap();
        assert_eq!(card_model_rel(hideout), hideout.host_model_rel);
        assert_eq!(dyn_target("midtown_archmother").unwrap().panels.len(), 5);
        assert!(dyn_target("midtown_archmother").unwrap().blackout.is_empty());
        assert_eq!(dyn_target("nope").map(|_| ()), None);
    }

    /// Combo hosts get per-panel material/texture paths; single hosts keep
    /// the base (the bundled quad references it verbatim).
    #[test]
    fn panel_paths_split_only_for_combo_hosts() {
        let hk = dyn_target("midtown_hidden_king").unwrap();
        assert_eq!(
            panel_rel(hk.vmat_rel, hk, "card5"),
            "models/architecture/arch_plaza_01/materials/dynpaint_hidden_king_card5.vmat"
        );
        assert_eq!(
            panel_rel(hk.texture_rel, hk, "card10"),
            "models/architecture/arch_plaza_01/materials/dynpaint_midtown_hidden_king_card10.png"
        );
        let hideout = dyn_target("hideout_portrait_canvas").unwrap();
        assert_eq!(panel_rel(hideout.vmat_rel, hideout, "card1"), hideout.vmat_rel);
    }

    #[test]
    fn fit_filters_cover_the_three_modes() {
        assert_eq!(fit_filter("stretch", 100, 200, 0.5, 0.5), "scale=100:200");
        let cover = fit_filter("cover", 100, 200, 0.0, 1.0);
        assert!(
            cover.contains("force_original_aspect_ratio=increase")
                && cover.contains("crop=100:200:x=(iw-ow)*0.000:y=(ih-oh)*1.000"),
            "{cover}"
        );
        let contain = fit_filter("contain", 100, 200, 0.5, 0.5);
        assert!(contain.contains("decrease") && contain.contains("pad=100:200"), "{contain}");
        // Out-of-range crop positions clamp instead of escaping the frame.
        assert!(fit_filter("cover", 10, 10, 7.0, -3.0).contains("x=(iw-ow)*1.000:y=(ih-oh)*0.000"));
    }

    #[test]
    fn grid_shapes_are_pow2_and_bounded() {
        for (n, max_tex) in
            [(2u32, 8192u32), (6, 8192), (24, 8192), (240, 8192), (240, 4096), (900, 4096)]
        {
            let (c, r, w, h) = grid_dims(n, (512, 764), max_tex);
            assert!(c * r >= n, "n={n}: {c}x{r}");
            for v in [c, r, w, h] {
                assert!(v.is_power_of_two(), "n={n}: {c}x{r} cell {w}x{h}");
            }
            assert!(
                c * w <= max_tex && r * h <= max_tex,
                "n={n} max={max_tex}: tex {}x{}",
                c * w,
                r * h
            );
        }
        // The e2e shape: 6 frames stay a compact grid with full-size cells.
        let (c, r, w, h) = grid_dims(6, (512, 764), 8192);
        assert!(c * r >= 6 && c * r <= 16);
        assert!(w >= 256 && h >= 512, "{c}x{r} cell {w}x{h}");
    }

    #[test]
    fn animated_webp_sniff() {
        let dir = std::env::temp_dir().join("eim_webp_sniff_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, bytes: &[u8]| {
            let p = dir.join(name);
            std::fs::write(&p, bytes).unwrap();
            p.to_string_lossy().into_owned()
        };
        // Animated: RIFF/WEBP with VP8X + ANIM chunk (the Twitter shape).
        let mut anim = b"RIFF\x82\x85\x43\x00WEBPVP8X\x0a\x00\x00\x00\x12\x00\x00\x00\xff\x04\x00\xcf\x02\x00".to_vec();
        anim.extend_from_slice(b"ANIM\x06\x00\x00\x00\xff\xff\x00\x00\x00\x00");
        assert!(is_animated_webp(&write("anim.webp", &anim)));
        // Still webp: no ANIM chunk anywhere in the header.
        assert!(!is_animated_webp(&write(
            "still.webp",
            b"RIFF\x24\x00\x00\x00WEBPVP8 \x18\x00\x00\x00\x30\x01\x00\x9d\x01\x2a\x01\x00\x01\x00"
        )));
        // A real gif (extension lies are irrelevant - bytes decide).
        assert!(!is_animated_webp(&write("a.gif", b"GIF89a\x01\x00\x01\x00\x00\x00\x00\x00\x00\x00\x00")));
        assert!(!is_animated_webp(&dir.join("missing.webp").to_string_lossy()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn max_tex_tiers_bound_host_vram() {
        // Tiers are monotonic (more surfaces never get a BIGGER cap) and the
        // worst-case host VRAM stays bounded: n * cap^2 texels ~= n * cap^2
        // bytes of BC data. 11 surfaces (the biggest host) at their tier must
        // cost less than two full 8192 grids.
        let mut prev = u32::MAX;
        for n in 1..=17usize {
            let cap = host_max_tex(n);
            assert!(cap <= prev, "cap grew at n={n}");
            prev = cap;
            assert!(cap.is_power_of_two() && (2048..=8192).contains(&cap));
        }
        let worst_11 = 11u64 * (host_max_tex(11) as u64).pow(2);
        assert!(worst_11 < 2 * 8192u64.pow(2), "11-surface host too heavy: {worst_11}");
    }

    /// The generated expression must match the form the CSDK spike compiled
    /// (n=8, dwell 0.2s, 2x4 grid -> period 1.6).
    #[test]
    fn expression_matches_the_proven_form() {
        let e = flipbook_expr(8, 0.2, 2, 4);
        assert!(e.starts_with("v0 = frac($ent_age/1.6000)*8;"), "{e}");
        assert!(e.contains("v2 = v1/2;"));
        assert!(e.ends_with("return float2(((v4+.5)/2)-.5,((v3+.5)/4)-.5);"), "{e}");
        assert!(!e.contains('\n'), "newlines must be literal backslash-n");
    }

    #[test]
    fn vmat_carries_window_tint_and_expression() {
        let t = dyn_target("hideout_portrait_canvas").unwrap();
        let v = vmat_text(t, t.texture_rel, 8, 0.2, 2, 4);
        for needle in [
            "\"F_ENABLE_TEXTURE_TRANSFORMS\"\t\"1\"",
            "\"g_vAlbedoTexcoordScale1\"\t\"[0.500000 0.250000 0.000000 0.000000]\"",
            "\"g_vColorTint1\"\t\"[0.314700 0.162600 0.080800 0.000000]\"",
            "\"TextureColor1\"\t\"models/hideout/materials/dynpaint_hideout_portrait_canvas.png\"",
            "\"DynamicParams\"",
            "frac($ent_age/1.6000)*8",
        ] {
            assert!(v.contains(needle), "missing {needle} in:\n{v}");
        }
        // A single frame is a still: no expression, full-texture window.
        let still = vmat_text(t, t.texture_rel, 1, 0.2, 1, 1);
        assert!(!still.contains("DynamicParams"), "{still}");
        assert!(!still.contains("$ent_age"), "{still}");
        assert!(
            still.contains("\"g_vAlbedoTexcoordScale1\"\t\"[1.000000 1.000000 0.000000 0.000000]\""),
            "{still}"
        );
        // Midtown materials skip the hideout tint but keep unlit + fog fix.
        let hk = dyn_target("midtown_hidden_king").unwrap();
        let mv = vmat_text(hk, "x.png", 4, 0.1, 2, 2);
        assert!(!mv.contains("g_vColorTint1"), "{mv}");
        assert!(mv.contains("\"F_UNLIT\"\t\"1\"") && mv.contains("g_flVolumeFogAmount"), "{mv}");
    }

    /// The move that carries the church-archway quads onto the plaza gate,
    /// pinned to the values the CSDK proof compiled with (0.01u placement).
    #[test]
    fn rehost_delta_is_the_measured_move() {
        let rh = dyn_target("midtown_hidden_king").unwrap().rehost.as_ref().unwrap();
        let (yaw, t) = rh.delta();
        assert!((yaw - -90.033104).abs() < 1e-6, "{yaw}");
        assert!((t[0] - -2124.46893).abs() < 1e-3 && (t[1] - -825.776033).abs() < 1e-3, "{t:?}");
        assert_eq!(t[2], 0.0);
        // Round trip one point: Library Painting #3's centre, old-host-local
        // -> world must equal new-host-local -> world.
        let p = [-419.5f64, 2662.6, 191.4];
        let rot = |yaw: f64, v: [f64; 3]| {
            let (s, c) = yaw.to_radians().sin_cos();
            [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
        };
        let old_world = {
            let r = rot(rh.from.yaw, p);
            [r[0] + rh.from.origin[0], r[1] + rh.from.origin[1], r[2] + rh.from.origin[2]]
        };
        let q = {
            let r = rot(yaw, p);
            [r[0] + t[0], r[1] + t[1], r[2] + t[2]]
        };
        let new_world = {
            let r = rot(rh.to.yaw, q);
            [r[0] + rh.to.origin[0], r[1] + rh.to.origin[1], r[2] + rh.to.origin[2]]
        };
        for i in 0..3 {
            assert!((old_world[i] - new_world[i]).abs() < 1e-6, "{old_world:?} vs {new_world:?}");
        }
    }

    #[test]
    fn splice_adds_quads_and_keeps_the_stock_nodes() {
        let kit = "{\n\trootNode = \n\t{\n\t\tchildren = \n\t\t[\n\t\t\t{\n\t\t\t\t_class = \"RenderMeshList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\tname = \"gate\"\n\t\t\t\t\t\tfilename = \"models/x/gate.dmx\"\n\t\t\t\t\t\timport_filter = \n\t\t\t\t\t\t{\n\t\t\t\t\t\t\texception_list = [ \"a\" ]\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\t\t\t\t]\n\t\t\t},\n\t\t\t{\n\t\t\t\t_class = \"PhysicsShapeList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\t_class = \"PhysicsMeshFile\"\n\t\t\t\t\t\tsurface_prop = \"rock\"\n\t\t\t\t\t},\n\t\t\t\t]\n\t\t\t},\n\t\t]\n\t}\n}\n";
        let out = splice_render_meshes(
            kit,
            &["models/x/dynpaint_quad_card5.dmx".into(), "models/x/dynpaint_quad_card10.dmx".into()],
        )
        .unwrap();
        assert_eq!(out.matches("RenderMeshFile").count(), 3, "{out}");
        // The quads sit INSIDE the render list, after the stock mesh (and
        // its nested exception list) and before the physics shapes.
        let stock = out.find("models/x/gate.dmx").unwrap();
        let q5 = out.find("name = \"dynpaint_quad_card5\"").unwrap();
        let q10 = out.find("filename = \"models/x/dynpaint_quad_card10.dmx\"").unwrap();
        let phys = out.find("PhysicsShapeList").unwrap();
        assert!(stock < q5 && q5 < q10 && q10 < phys, "{out}");
        assert!(out.contains("surface_prop = \"rock\""));
        assert_eq!(out.matches('[').count(), out.matches(']').count());
        assert!(splice_render_meshes("{ }", &[]).is_none());
    }

    #[test]
    fn combo_vmdl_lists_every_mesh_and_the_physics() {
        let v = combo_vmdl(
            &[
                "models/x/dynpaint_base_card1.dmx".into(),
                "models/x/dynpaint_quad_card4.dmx".into(),
            ],
            "models/x/dynpaint_phys.dmx",
        );
        assert_eq!(v.matches("RenderMeshFile").count(), 2, "{v}");
        assert!(v.contains("name = \"dynpaint_base_card1\""));
        assert!(v.contains("filename = \"models/x/dynpaint_quad_card4.dmx\""));
        assert!(v.contains("PhysicsMeshFile") && v.contains("models/x/dynpaint_phys.dmx"));
        assert!(v.starts_with("<!-- kv3 "));
    }

    /// Full pipeline vs the real CSDK + helper + live game pak: the hideout
    /// (cover fit) plus TWO Hidden King surfaces at once - the plaza gate must
    /// rebuild with its stock mesh, a quad and material per surface, and each
    /// quad must sit ON the map's painting (measured from the compiled model).
    /// Run with:
    ///   cargo test -p app --lib -- --ignored e2e_dynpaint --nocapture
    #[test]
    #[ignore]
    fn e2e_dynpaint_hideout_compiles() {
        let csdk = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\bin\Release\net10.0\vpk-helper.dll";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let content = format!(r"{csdk}\content\citadel_addons\eim_dynpaint_e2e");
        let compiled = format!(r"{csdk}\game\citadel_addons\eim_dynpaint_e2e");
        let _ = std::fs::remove_dir_all(&content);
        let _ = std::fs::remove_dir_all(&compiled);
        std::fs::create_dir_all(&content).unwrap();
        let gif = std::env::temp_dir().join("eim_dynpaint_e2e.gif");
        let ok = crate::procutil::quiet("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=256x382:rate=5",
                "-frames:v",
                "6",
                &gif.to_string_lossy(),
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "test gif");

        let entry = |id: &str, panel: &str, fit: &str, dwell: f64| DynpaintCompile {
            id: id.into(),
            source_media: gif.to_string_lossy().into_owned(),
            dwell,
            max_frames: 240,
            panel: panel.into(),
            fit: fit.into(),
            crop_x: 0.5,
            crop_y: 0.5,
        };
        let cfg = CompileConfig {
            content_root: content.clone(),
            compiled_root: compiled.clone(),
            game_info_dir: format!(r"{csdk}\game\citadel"),
            resource_compiler: format!(r"{csdk}\game\bin_tools\win64\resourcecompiler.exe"),
            vpk_helper_path: Some(helper.into()),
            pak_path: Some(pak.into()),
            dynpaints: vec![
                entry("hideout_portrait_canvas", "card1", "cover", 0.0),
                entry("midtown_hidden_king", "card5", "contain", 0.1),
                entry("midtown_hidden_king", "card10", "cover", 0.2),
            ],
            ..Default::default()
        };
        let mut report = CompileReport::new();
        let (rels, dirty) =
            compile_dynpaints(&cfg, Path::new(&content), Path::new(&compiled), &mut report);
        for s in &report.steps {
            eprintln!("STEP [{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }
        assert!(report.ok, "{:?}", report.steps.iter().map(|s| &s.name).collect::<Vec<_>>());
        assert!(dirty);
        assert!(rels.contains(&"models/hideout/materials/dynpaint_canvas.vmat_c".to_string()));
        assert!(rels.contains(&"models/hideout/hideout_ghost_pianist.vmdl_c".to_string()));
        for b in HIDEOUT_PORTRAIT.blackout {
            assert!(rels.contains(&b.to_string()), "blackout missing: {b}");
            assert!(Path::new(&compiled).join(b).is_file());
        }
        // The combo model (the plaza gate) + BOTH per-card materials.
        let combo = HIDDEN_KING.host_model_rel;
        assert!(combo.contains("arch_plaza_01_gate_structure_01"));
        assert!(rels.contains(&combo.to_string()), "{rels:?}");
        for card in ["card5", "card10"] {
            assert!(
                rels.contains(&format!(
                    "models/architecture/arch_plaza_01/materials/dynpaint_hidden_king_{card}.vmat_c"
                )),
                "{card} material missing: {rels:?}"
            );
            assert!(
                rels.iter().any(|r| r
                    .contains(&format!("dynpaint_midtown_hidden_king_{card}"))
                    && r.ends_with(".vtex_c")),
                "{card} grid texture missing: {rels:?}"
            );
        }
        // The compiled combo must reference both per-card materials AND
        // still carry the gate's own (stock) material, and the hideout
        // material must carry the expression.
        let combo_bytes = std::fs::read(Path::new(&compiled).join(combo)).unwrap();
        let refs = crate::models::scan_vmdl_material_refs(&combo_bytes);
        for card in ["card5", "card10"] {
            assert!(
                refs.iter().any(|r| r.contains(&format!("dynpaint_hidden_king_{card}"))),
                "combo model must reference {card}: {refs:?}"
            );
        }
        assert!(
            refs.iter().any(|r| !r.contains("dynpaint")),
            "the gate's stock mesh must survive the rebuild: {refs:?}"
        );

        // Placement: scan the compiled model's quads (helper `worldrects` on
        // a pack holding just this model), carry their centres into world
        // space with the gate's pose, and compare with where today's Midtown
        // has the paintings (mined from the map 2026-10-04).
        let scan_dir = std::env::temp_dir().join("eim_dynpaint_e2e_scan");
        let _ = std::fs::remove_dir_all(&scan_dir);
        let dest = scan_dir.join("tree").join(combo);
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(Path::new(&compiled).join(combo), &dest).unwrap();
        let pack = scan_dir.join("pack_dir.vpk");
        crate::vpk::pack(helper, &scan_dir.join("tree").to_string_lossy(), &pack.to_string_lossy())
            .unwrap();
        let list = scan_dir.join("models.txt");
        std::fs::write(&list, combo.trim_end_matches("_c")).unwrap();
        let out_json = scan_dir.join("rects.json");
        let scanned = crate::procutil::quiet("dotnet")
            .args([
                helper,
                "worldrects",
                &pack.to_string_lossy(),
                pak,
                &out_json.to_string_lossy(),
                "models/",
                &list.to_string_lossy(),
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(scanned, "worldrects scan of the compiled host model");
        let scan: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&out_json).unwrap()).unwrap();
        let to = HIDDEN_KING.rehost.as_ref().unwrap().to;
        let (sin, cos) = to.yaw.to_radians().sin_cos();
        for (card, want) in
            [("card5", [5445.35, -1984.52, 447.36]), ("card10", [4925.99, -2173.37, 489.45])]
        {
            let rects = scan["materials"]
                .as_object()
                .unwrap()
                .iter()
                .find(|(k, _)| k.contains(&format!("dynpaint_hidden_king_{card}")))
                .map(|(_, v)| v)
                .unwrap_or_else(|| panic!("{card}: no quad in the compiled model"));
            let b: Vec<f64> =
                rects[0]["pos"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
            let l = [(b[0] + b[3]) / 2.0, (b[1] + b[4]) / 2.0, (b[2] + b[5]) / 2.0];
            let w = [
                l[0] * cos - l[1] * sin + to.origin[0],
                l[0] * sin + l[1] * cos + to.origin[1],
                l[2] + to.origin[2],
            ];
            let err = ((w[0] - want[0]).powi(2) + (w[1] - want[1]).powi(2) + (w[2] - want[2]).powi(2))
                .sqrt();
            eprintln!("PLACEMENT {card}: [{:.2} {:.2} {:.2}] - {err:.3}u from the map's painting", w[0], w[1], w[2]);
            assert!(err < 1.0, "{card} lands {err:.2}u off: {w:?} vs {want:?}");
        }
        let _ = std::fs::remove_dir_all(&scan_dir);
        let out = std::env::temp_dir().join("eim_dynpaint_e2e_rt.vmat");
        crate::vpk::decompile_from_vpk(
            helper,
            &compiled,
            "models/hideout/materials/dynpaint_canvas.vmat_c",
            &out.to_string_lossy(),
        )
        .unwrap();
        let text = std::fs::read_to_string(&out).unwrap();
        assert!(text.contains("DynamicParams"), "{text}");
        assert!(text.contains("$ent_age"), "{text}");

        // Second run with nothing changed: every host skips.
        let mut report2 = CompileReport::new();
        let (rels2, dirty2) =
            compile_dynpaints(&cfg, Path::new(&content), Path::new(&compiled), &mut report2);
        assert!(!dirty2, "unchanged media must skip");
        assert_eq!(rels, rels2, "skip must stage the same set");
        let _ = std::fs::remove_dir_all(&content);
        let _ = std::fs::remove_dir_all(&compiled);
        let _ = std::fs::remove_file(&gif);
    }

    /// Builds a ready-to-install test pak: a moving test pattern on all five
    /// re-hosted Hidden King surfaces - the in-game check that the plaza gate
    /// really carries them. Output: <repo>/output/midtown_gate_test/pak01_dir.vpk
    ///   cargo test -p app --lib -- --ignored build_midtown_gate_test_pak --nocapture
    #[test]
    #[ignore]
    fn build_midtown_gate_test_pak() {
        let csdk = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\bin\Release\net10.0\vpk-helper.dll";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let content = format!(r"{csdk}\content\citadel_addons\eim_dynpaint_gate_test");
        let compiled = format!(r"{csdk}\game\citadel_addons\eim_dynpaint_gate_test");
        let _ = std::fs::remove_dir_all(&content);
        let _ = std::fs::remove_dir_all(&compiled);
        std::fs::create_dir_all(&content).unwrap();
        let gif = std::env::temp_dir().join("eim_gate_test.gif");
        let ok = crate::procutil::quiet("ffmpeg")
            .args(["-y", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=8", "-frames:v", "24"])
            .arg(&gif)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert!(ok, "test pattern");
        let cfg = CompileConfig {
            content_root: content.clone(),
            compiled_root: compiled.clone(),
            game_info_dir: format!(r"{csdk}\game\citadel"),
            resource_compiler: format!(r"{csdk}\game\bin_tools\win64\resourcecompiler.exe"),
            vpk_helper_path: Some(helper.into()),
            pak_path: Some(pak.into()),
            dynpaints: HIDDEN_KING
                .panels
                .iter()
                .map(|p| DynpaintCompile {
                    id: "midtown_hidden_king".into(),
                    source_media: gif.to_string_lossy().into_owned(),
                    dwell: 0.0,
                    max_frames: 240,
                    panel: p.id.into(),
                    fit: "cover".into(),
                    crop_x: 0.5,
                    crop_y: 0.5,
                })
                .collect(),
            ..Default::default()
        };
        let mut report = CompileReport::new();
        let (rels, _) =
            compile_dynpaints(&cfg, Path::new(&content), Path::new(&compiled), &mut report);
        for s in &report.steps {
            eprintln!("STEP [{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }
        assert!(report.ok, "compile failed");
        let out = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../output/midtown_gate_test"));
        let stage = out.join("_staging");
        let _ = std::fs::remove_dir_all(out);
        for rel in &rels {
            let dest = stage.join(rel);
            std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
            std::fs::copy(Path::new(&compiled).join(rel), &dest)
                .unwrap_or_else(|e| panic!("stage {rel}: {e}"));
        }
        let vpk = out.join("pak01_dir.vpk");
        crate::vpk::pack(helper, &stage.to_string_lossy(), &vpk.to_string_lossy()).unwrap();
        eprintln!(
            "TEST PAK: {} ({} files, {} bytes)",
            vpk.display(),
            rels.len(),
            std::fs::metadata(&vpk).map(|m| m.len()).unwrap_or(0)
        );
        let _ = std::fs::remove_dir_all(&content);
        let _ = std::fs::remove_dir_all(&compiled);
        let _ = std::fs::remove_file(&gif);
    }

    /// Repro harness for a user-reported zero-frame extraction (2026-09-03):
    /// runs the real build_surface on the exact local files that failed in
    /// the app. Machine-local paths, so ignored; run by hand while debugging.
    #[test]
    #[ignore]
    fn repro_user_gif_zero_frames() {
        let content = std::env::temp_dir().join("eim_dynpaint_repro");
        let _ = std::fs::remove_dir_all(&content);
        std::fs::create_dir_all(&content).unwrap();
        let mut report = CompileReport::new();
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\bin\Release\net10.0\vpk-helper.dll";
        let cases: [(&DynTarget, &str, &str, &str); 3] = [
            (&ARCHMOTHER, "card1", r"D:\Downloads 2.0\yuta-jjk.gif", "stretch"),
            (
                &HIDDEN_KING,
                "card10",
                r"D:\Downloads 2.0\RyukiriDragon-2070886693905834479-1.gif",
                "cover",
            ),
            // The 2026-09-03 report: a Twitter animated WebP every local
            // ffmpeg build refuses - must route through the helper's Skia.
            (
                &HIDDEN_KING,
                "card7",
                r"C:\Users\ethob\Downloads\HIY3jAwWQAEBmzt.webp",
                "cover",
            ),
        ];
        for (t, panel, media, fit) in cases {
            let p = t.panels.iter().find(|p| p.id == panel).unwrap();
            let dp = DynpaintCompile {
                id: if t.combo { "midtown".into() } else { "hideout".into() },
                source_media: media.into(),
                dwell: 0.0,
                max_frames: 240,
                panel: panel.into(),
                fit: fit.into(),
                crop_x: 0.5,
                crop_y: 0.5,
            };
            match build_surface(&content, t, &dp, p, "ffmpeg", Some(helper), 2048, &mut report) {
                Ok((rel, detail)) => eprintln!("OK {panel}: {detail} ({rel})"),
                Err(()) => {}
            }
        }
        for s in &report.steps {
            eprintln!("STEP [{}] {} :: {}", if s.ok { "OK" } else { "FAIL" }, s.name, s.detail);
        }
        let _ = std::fs::remove_dir_all(&content);
        assert!(report.ok, "reproduced the zero-frame failure - see steps above");
    }
}
