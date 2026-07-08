//! Jumpscares/Deaths mod generator ("DigiMaster").
//!
//! The user's proven HUD-overlay mod, productized: the static engine
//! (base_hud hook + runtime-panel JS + CSS + the Anita-UI in-game menu) is
//! embedded as templates; the app's Jumpscares tab supplies CONFIG (chances,
//! interval) and the media LIBRARY. Compile converts any video to panorama's
//! required VP9 .webm via ffmpeg, compiles PNGs to .vtex and sounds to
//! .vsnd_c, injects CONFIG/LIBRARY into the JS, compiles the panorama files,
//! and returns everything to stage into the output vpk.
//!
//! NOTE: like the original mod, `soundevents/world_ambient_emitters.vsndevts`
//! is overridden wholesale with only the Digi.* events (proven in the user's
//! mod for months).

use std::path::{Path, PathBuf};

use crate::compile::{CompileConfig, CompileReport, DigiEntry, DigimodCompile, DigiSound};

const TPL_JS: &str = include_str!("../templates/digimod/digi_master.js");
const TPL_XML: &str = include_str!("../templates/digimod/base_hud.xml");
const TPL_CSS: &str = include_str!("../templates/digimod/jumpscare_overlay.css");
const TPL_ANITA_JS: &str = include_str!("../templates/digimod/anita_ui_core.js");
const TPL_ANITA_CSS: &str = include_str!("../templates/digimod/anita_ui.css");

/// Lowercase alnum/underscore id — used for file stems and event names.
fn sanitize_id(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() { "entry".into() } else { trimmed }
}

fn sound_event(sound_id: &str) -> String {
    format!("Digi.{}", sanitize_id(sound_id))
}

fn media_rel(e: &DigiEntry) -> String {
    if e.kind == "image" {
        format!("panorama/images/digi/{}.vtex", sanitize_id(&e.id))
    } else {
        format!("panorama/videos/digi/{}.webm", sanitize_id(&e.id))
    }
}

/// A sound library entry is usable when it has a source file.
fn valid_sound<'a>(dm: &'a DigimodCompile, id: &Option<String>) -> Option<&'a DigiSound> {
    let id = id.as_deref().filter(|s| !s.is_empty())?;
    dm.sounds.iter().find(|s| s.id == id && !s.source_audio.is_empty())
}

/// JSON-ish JS literal for one library entry.
fn entry_js(dm: &DigimodCompile, e: &DigiEntry) -> String {
    let sound = match valid_sound(dm, &e.sound_id) {
        Some(s) => format!("\"{}\"", sound_event(&s.id)),
        None => "null".into(),
    };
    format!(
        "{{ name: \"{}\", type: \"{}\", src: \"s2r://{}\", show: {:.2}, sound: {}, preset: \"{}\" }}",
        sanitize_id(&e.id),
        if e.kind == "image" { "image" } else { "video" },
        media_rel(e),
        e.show.max(0.1),
        sound,
        if e.preset == "banner" { "banner" } else { "fullscreen" },
    )
}

/// path|len|mtime identity line for one source file (0s when unreadable).
fn file_identity(p: &str) -> String {
    let meta = std::fs::metadata(p).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{p}|{len}|{mtime}|")
}

/// Fingerprint of the whole digimod config + every source file's identity.
fn digimod_fingerprint(dm: &DigimodCompile) -> String {
    let mut key = format!(
        "v1|{}|{}|{}\n",
        dm.rng_interval, dm.scare_chance, dm.death_chance
    );
    for e in dm.scares.iter().chain(dm.deaths.iter()) {
        key.push_str(&file_identity(&e.source_media));
        key.push_str(&format!(
            "{}|{}|{}|{:.2}|{}\n",
            e.id,
            e.kind,
            e.preset,
            e.show,
            e.sound_id.as_deref().unwrap_or("")
        ));
    }
    for s in &dm.sounds {
        key.push_str(&file_identity(&s.source_audio));
        key.push_str(&format!(
            "sound|{}|{:.2}|{:.3}|{:.3}|{:.2}|{:.3}|{:.3}\n",
            s.id, s.volume, s.trim_start, s.trim_end, s.gain_db, s.fade_in, s.fade_out
        ));
    }
    for v in &dm.merge_vpks {
        key.push_str("merge|");
        key.push_str(&file_identity(v));
        key.push('\n');
    }
    crate::compile::fingerprint(&key)
}

/// Splice the digi engine's hooks into a foreign mod's base_hud source: the
/// two style includes, the two script includes, and the overlay anchor
/// panels. Substring guards make it idempotent (anything already present is
/// left alone), so re-merging or merging a hud that partially matches ours
/// can't double-inject.
fn inject_hooks(xml: &str) -> Result<String, String> {
    let mut out = xml.to_string();
    let styles = [
        ("jumpscare_overlay", "\t\t<include src=\"s2r://panorama/styles/jumpscare_overlay.vcss_c\" />\n"),
        ("anita_ui.vcss", "\t\t<include src=\"s2r://panorama/styles/anita_ui.vcss_c\" />\n"),
    ];
    let add: String = styles.iter().filter(|(k, _)| !out.contains(k)).map(|(_, l)| *l).collect();
    if !add.is_empty() {
        let pos = out
            .find("</styles>")
            .ok_or("no </styles> block in the mod's base_hud")?;
        out.insert_str(pos, &add);
    }
    let scripts = [
        ("digi_master", "\t\t<include src=\"s2r://panorama/scripts/digi_master.vjs_c\" />\n"),
        ("anita_ui_core", "\t\t<include src=\"s2r://panorama/scripts/anita_ui_core.vjs_c\" />\n"),
    ];
    let add: String = scripts.iter().filter(|(k, _)| !out.contains(k)).map(|(_, l)| *l).collect();
    if !add.is_empty() {
        match out.find("</scripts>") {
            Some(pos) => out.insert_str(pos, &add),
            None => {
                // A hud with no scripts block at all: add one after </styles>.
                let pos = out
                    .find("</styles>")
                    .map(|p| p + "</styles>".len())
                    .ok_or("no </styles> block in the mod's base_hud")?;
                out.insert_str(pos, &format!("\n\n\t<scripts>\n{add}\t</scripts>"));
            }
        }
    }
    if !out.contains("MediaOverlayContainer") {
        let panels = "\t\t<Panel id=\"MediaOverlayContainer\" hittest=\"false\" />\n\t\t<Panel id=\"AnitaUI_Anchor\" hittest=\"false\" style=\"width: 100%; height: 100%; z-index: 10000;\" />\n";
        // The last </Panel> closes the WindowRoot panel — land just inside it.
        let pos = out
            .rfind("</Panel>")
            .ok_or("no root <Panel> in the mod's base_hud")?;
        out.insert_str(pos, panels);
    }
    Ok(out)
}

/// Convert (or copy) a user video into panorama's required VP9 webm.
fn to_webm(ffmpeg: Option<&str>, src: &str, dest: &Path) -> Result<String, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if src.to_lowercase().ends_with(".webm") {
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
        return Ok("webm — copied as-is".into());
    }
    let exe = ffmpeg.unwrap_or("ffmpeg");
    let out = crate::procutil::quiet(exe)
        .args([
            "-y",
            "-i",
            src,
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            "34",
            "-row-mt",
            "1",
            "-cpu-used",
            "4",
            "-an",
        ])
        .arg(dest)
        .output()
        .map_err(|e| format!("launching ffmpeg: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .lines()
            .rev()
            .take(2)
            .collect::<Vec<_>>()
            .join(" | "));
    }
    Ok("converted to VP9 webm".into())
}

/// Generate the soundevents file: one Digi.* event per library sound.
fn gen_soundevents(dm: &DigimodCompile) -> String {
    let mut out = String::from(
        "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n{\n",
    );
    for s in dm.sounds.iter().filter(|s| !s.source_audio.is_empty()) {
        out.push_str(&format!(
            "\t{} = \n\t{{\n\t\tbase = \"Base.UI\"\n\t\tvolume = {:.6}\n\t\tpitch = 1.000000\n\t\tvsnd_files = \"sounds/digi/{}.vsnd\"\n\t}}\n",
            sound_event(&s.id),
            s.volume.clamp(0.0, 10.0),
            sanitize_id(&s.id),
        ));
    }
    out.push_str("}\n");
    out
}

/// Generate digi_master.js from the template + this config.
fn gen_js(dm: &DigimodCompile) -> String {
    let config = format!(
        "{{ IS_ENABLED: true, RNG_INTERVAL: {}, SCARE_CHANCE: {}, DEATH_CHANCE: {} }}",
        dm.rng_interval.clamp(5, 600),
        dm.scare_chance.min(100),
        dm.death_chance.min(100),
    );
    let scares: Vec<String> = dm.scares.iter().map(|e| entry_js(dm, e)).collect();
    let deaths: Vec<String> = dm.deaths.iter().map(|e| entry_js(dm, e)).collect();
    let library = format!(
        "{{\n    SCARES: [\n        {}\n    ],\n    DEATHS: [\n        {}\n    ],\n}}",
        scares.join(",\n        "),
        deaths.join(",\n        "),
    );
    TPL_JS
        .replace("/*__DIGI_CONFIG__*/{}/*__END__*/", &config)
        .replace("/*__DIGI_LIBRARY__*/{ SCARES: [], DEATHS: [] }/*__END__*/", &library)
}

/// Run the whole digimod build. Returns (compiled-root-relative rels to
/// stage, dirty flag).
pub fn compile_digimod(
    cfg: &CompileConfig,
    content_root: &Path,
    compiled_root: &Path,
    report: &mut CompileReport,
) -> Result<(Vec<String>, bool), ()> {
    let Some(dm) = &cfg.digimod else {
        return Ok((vec![], false));
    };
    if dm.scares.is_empty() && dm.deaths.is_empty() && dm.merge_vpks.is_empty() {
        return Ok((vec![], false));
    }
    let ffmpeg = cfg.ffmpeg_path.as_deref();
    let mut all_ok = true;

    // Merged UI mods: list each vpk's panorama files up front (index-only,
    // cheap) — the rels feed the up-to-date skip, and the last vpk shipping a
    // base_hud donates the hud source our hooks get injected into.
    let helper = cfg.vpk_helper_path.as_deref().filter(|h| !h.is_empty());
    let mut merge_files: Vec<(String, Vec<String>)> = Vec::new();
    let mut base_hud_donor: Option<String> = None;
    for vpk in &dm.merge_vpks {
        let Some(h) = helper else {
            report.soft_fail("jumpscares: merge UI mods", "vpk helper not configured".to_string());
            all_ok = false;
            break;
        };
        let name = Path::new(vpk).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| vpk.clone());
        match crate::vpk::list(h, vpk, Some("panorama/")) {
            Ok(entries) => {
                let mut keep: Vec<String> = Vec::new();
                for e in entries {
                    if e == "panorama/layout/base_hud.vxml_c" {
                        base_hud_donor = Some(vpk.clone());
                    } else if e.starts_with("panorama/") {
                        keep.push(e);
                    }
                }
                merge_files.push((vpk.clone(), keep));
            }
            Err(e) => {
                report.soft_fail(format!("jumpscares: read UI mod {name}"), e);
                all_ok = false;
            }
        }
    }

    // Expected staging list (computable without building — used by the skip).
    let mut rels: Vec<String> = vec![
        "panorama/layout/base_hud.vxml_c".into(),
        "panorama/scripts/digi_master.vjs_c".into(),
        "panorama/scripts/anita_ui_core.vjs_c".into(),
        "panorama/styles/jumpscare_overlay.vcss_c".into(),
        "panorama/styles/anita_ui.vcss_c".into(),
        "soundevents/world_ambient_emitters.vsndevts_c".into(),
    ];
    for e in dm.scares.iter().chain(dm.deaths.iter()) {
        if e.kind == "image" {
            rels.push(format!("panorama/images/digi/{}.vtex_c", sanitize_id(&e.id)));
        } else {
            rels.push(format!("panorama/videos/digi/{}.webm", sanitize_id(&e.id)));
        }
    }
    for s in dm.sounds.iter().filter(|s| !s.source_audio.is_empty()) {
        rels.push(format!("sounds/digi/{}.vsnd_c", sanitize_id(&s.id)));
    }
    for (_, keep) in &merge_files {
        for rel in keep {
            if !rels.contains(rel) {
                rels.push(rel.clone());
            }
        }
    }

    // Up-to-date skip (never on a merge-list read failure — the rels would
    // be incomplete and staging would drop the merged files).
    let stamp = content_root.join(".eim_digimod_stamp");
    let key = digimod_fingerprint(dm);
    if !cfg.skip_compile
        && all_ok
        && crate::compile::stamp_matches(&stamp, &key)
        && rels.iter().all(|r| compiled_root.join(r).exists())
    {
        report.ok_step("jumpscares up to date", "unchanged — skipped");
        return Ok((rels, false));
    }
    let _ = std::fs::remove_file(&stamp);

    let write = |rel: &str, text: &str| -> Result<PathBuf, String> {
        let p = content_root.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&p, text).map_err(|e| e.to_string())?;
        Ok(p)
    };

    // 0) Merged UI mods: their panorama tree lands in the compiled root as-is
    //    (already-compiled files ride along raw). This runs FIRST so anything
    //    we produce below — engine scripts, media, and above all base_hud —
    //    wins on collision.
    if !cfg.skip_compile {
        for (vpk, keep) in &merge_files {
            let name = Path::new(vpk).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| vpk.clone());
            match crate::vpk::extract_all(helper.unwrap_or(""), vpk, &compiled_root.to_string_lossy(), Some("panorama")) {
                Ok(_) => report.ok_step(
                    format!("merge UI mod: {name}"),
                    format!("{} panorama file(s) carried over", keep.len()),
                ),
                Err(e) => {
                    report.soft_fail(format!("merge UI mod: {name}"), e);
                    all_ok = false;
                }
            }
        }
    }

    // 1) Static engine + generated JS/soundevents into the content tree.
    let mut to_compile: Vec<PathBuf> = Vec::new();
    for (rel, text) in [
        ("panorama/scripts/digi_master.js", gen_js(dm)),
        ("panorama/scripts/anita_ui_core.js", TPL_ANITA_JS.to_string()),
        ("panorama/styles/jumpscare_overlay.css", TPL_CSS.to_string()),
        ("panorama/styles/anita_ui.css", TPL_ANITA_CSS.to_string()),
        ("soundevents/world_ambient_emitters.vsndevts", gen_soundevents(dm)),
    ] {
        match write(rel, &text) {
            Ok(p) => to_compile.push(p),
            Err(e) => {
                report.soft_fail(format!("jumpscares: write {rel}"), e);
                return Ok((vec![], true));
            }
        }
    }

    // 2) Media: videos convert/copy straight into the compiled tree (webms
    //    ship raw); images + sounds become sources for the compiler.
    let mut image_pngs: Vec<(String, PathBuf)> = Vec::new(); // (id, content png)
    for e in dm.scares.iter().chain(dm.deaths.iter()) {
        let id = sanitize_id(&e.id);
        if e.kind == "image" {
            let png = content_root.join(format!("panorama/images/digi/{id}.png"));
            if let Some(parent) = png.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(err) = std::fs::copy(&e.source_media, &png) {
                report.soft_fail(format!("jumpscare image: {}", e.name), err.to_string());
                all_ok = false;
                continue;
            }
            image_pngs.push((id.clone(), png));
        } else {
            let dest = compiled_root.join(format!("panorama/videos/digi/{id}.webm"));
            match to_webm(ffmpeg, &e.source_media, &dest) {
                Ok(detail) => report.ok_step(format!("jumpscare video: {}", e.name), detail),
                Err(err) => {
                    report.soft_fail(format!("jumpscare video: {}", e.name), err);
                    all_ok = false;
                }
            }
        }
    }
    // Sound library: any audio format -> wav source; the compiler makes the
    // vsnd_c. One file per library sound, shared by every entry using it.
    // Trim/gain/fades ride the same render path the song pipeline uses.
    for s in dm.sounds.iter().filter(|s| !s.source_audio.is_empty()) {
        let id = sanitize_id(&s.id);
        let wav = content_root.join(format!("sounds/digi/{id}.wav"));
        if let Some(parent) = wav.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let has_edit = s.trim_start > 0.0
            || s.trim_end > s.trim_start
            || s.gain_db != 0.0
            || s.fade_in > 0.0
            || s.fade_out > 0.0;
        let result = if has_edit {
            // Fades anchor to the clip end, so an open-ended trim needs the
            // real source duration.
            let end = if s.trim_end > s.trim_start {
                s.trim_end
            } else {
                crate::audio::probe_duration(ffmpeg, &s.source_audio).unwrap_or(600.0)
            };
            crate::audio::render_to(
                ffmpeg,
                &s.source_audio,
                s.trim_start,
                end,
                s.gain_db,
                s.fade_in,
                s.fade_out,
                &wav.to_string_lossy(),
            )
        } else {
            let exe = ffmpeg.unwrap_or("ffmpeg");
            match crate::procutil::quiet(exe).args(["-y", "-i", &s.source_audio]).arg(&wav).output()
            {
                Ok(o) if o.status.success() => Ok(()),
                Ok(o) => Err(String::from_utf8_lossy(&o.stderr)
                    .lines()
                    .rev()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" | ")),
                Err(err) => Err(err.to_string()),
            }
        };
        match result {
            Ok(()) => to_compile.push(wav),
            Err(err) => {
                report.soft_fail(format!("jumpscare sound: {id}"), err);
                all_ok = false;
            }
        }
    }

    if cfg.skip_compile {
        return Ok((rels, true));
    }

    // 3) Compile sources (js/css/vsndevts/wavs), then images, then the hud xml
    //    (which references the compiled anita vjs).
    let inputs: Vec<String> = to_compile.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    if let Err(e) = crate::compile::run_resource_compiler_multi(cfg, &inputs) {
        report.soft_fail("jumpscares: compile sources", e);
        return Ok((vec![], true));
    }
    // Images ride the panorama_image_list mechanism (same as icon mods), then
    // land at the exact .vtex_c path the generated JS references.
    if !image_pngs.is_empty() {
        let mut list = String::new();
        for (id, _) in &image_pngs {
            list.push_str(&format!("\t\tpanorama:\"file://{{images}}/digi/{id}.png\",\n"));
        }
        let vdata = content_root.join("digi_images.vdata");
        let body = format!(
            "<!-- kv3 encoding:text:version{{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d}} format:generic:version{{7412167c-06e9-4698-aff2-e63eb59037e7}} -->\n{{\n\tgeneric_data_type = \"panorama_image_list\"\n\timage_list =\n\t[\n{list}\t]\n}}\n"
        );
        if std::fs::write(&vdata, body).is_ok() {
            match crate::compile::run_resource_compiler(cfg, &vdata.to_string_lossy()) {
                Ok(_) => {
                    for (id, _) in &image_pngs {
                        let produced =
                            compiled_root.join(format!("panorama/images/digi/{id}_png.vtex_c"));
                        let target = compiled_root.join(format!("panorama/images/digi/{id}.vtex_c"));
                        if let Err(e) = std::fs::copy(&produced, &target) {
                            report.soft_fail(format!("jumpscare image stage: {id}"), e.to_string());
                            all_ok = false;
                        }
                    }
                }
                Err(e) => {
                    report.soft_fail("jumpscares: compile images", e);
                    all_ok = false;
                }
            }
        }
    }
    // The hud itself: with a merged UI mod that ships its own base_hud, THAT
    // becomes the base (VRF recovers clean source from the vxml_c) and the
    // digi hooks are spliced into it; otherwise our stock template.
    let hud_xml: String = if let (Some(vpk), Some(h)) = (&base_hud_donor, helper) {
        let name = Path::new(vpk).file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| vpk.clone());
        let tmp = content_root.join(".digi_merge_base_hud.xml");
        let recovered = crate::vpk::decompile_from_vpk(h, vpk, "panorama/layout/base_hud.vxml_c", &tmp.to_string_lossy())
            .and_then(|_| std::fs::read_to_string(&tmp).map_err(|e| e.to_string()))
            .and_then(|src| inject_hooks(&src));
        let _ = std::fs::remove_file(&tmp);
        match recovered {
            Ok(xml) => {
                report.ok_step(format!("merge base_hud: {name}"), "digi hooks injected into the mod's hud");
                xml
            }
            Err(e) => {
                report.soft_fail(
                    format!("merge base_hud: {name}"),
                    format!("{e} — falling back to the stock digi hud (that mod's hud edits won't apply)"),
                );
                all_ok = false;
                TPL_XML.to_string()
            }
        }
    } else {
        TPL_XML.to_string()
    };
    match write("panorama/layout/base_hud.xml", &hud_xml) {
        Ok(p) => {
            if let Err(e) = crate::compile::run_resource_compiler(cfg, &p.to_string_lossy()) {
                report.soft_fail("jumpscares: compile base_hud", e);
                return Ok((vec![], true));
            }
        }
        Err(e) => {
            report.soft_fail("jumpscares: write base_hud", e);
            return Ok((vec![], true));
        }
    }

    let merged_note = if merge_files.is_empty() {
        String::new()
    } else {
        format!(", {} UI mod(s) merged", merge_files.len())
    };
    report.ok_step(
        "jumpscares mod",
        format!("{} scare(s), {} death(s){merged_note}", dm.scares.len(), dm.deaths.len()),
    );
    if all_ok {
        let _ = std::fs::write(&stamp, &key);
    }
    Ok((rels, true))
}

// ==========================================================================
// IMPORT — adopt an existing DigiMaster pak into the tab: parse CONFIG +
// LIBRARY out of the compiled digi_master.vjs_c (panorama resources embed
// the source verbatim; VRF's FileExtract chokes on vjs_c, so raw extract +
// text scan), pull each webm/vtex/vsnd out to real files, and hand back a
// ready-to-edit config.
// ==========================================================================

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DigimodImport {
    pub rng_interval: u32,
    pub scare_chance: u32,
    pub death_chance: u32,
    pub scares: Vec<ImportedEntry>,
    pub deaths: Vec<ImportedEntry>,
    /// The recovered sound library: one per Digi.* event, deduped — entries
    /// sharing an event in the pak share a sound here too.
    pub sounds: Vec<ImportedSound>,
    /// Non-fatal per-entry problems (media missing from the pak etc.).
    pub warnings: Vec<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub source_media: String,
    pub show: f64,
    pub preset: String,
    pub sound_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedSound {
    pub id: String,
    pub name: String,
    pub source_audio: String,
    pub volume: f64,
}

/// First number after `key` (skipping the separator), e.g. `SCARE_CHANCE: 3`.
fn num_after(hay: &str, key: &str) -> Option<f64> {
    let at = hay.find(key)? + key.len();
    let rest = &hay[at..];
    let start = rest.find(|c: char| c.is_ascii_digit() || c == '-' || c == '.')?;
    // Numbers here are always within a few chars of the key; a far-away hit
    // means the key had no value and we matched something unrelated.
    if start > 8 {
        return None;
    }
    let rest = &rest[start..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// First quoted string after `key`, e.g. `src: "s2r://…"`. None for `null`.
fn str_after(hay: &str, key: &str) -> Option<String> {
    let at = hay.find(key)? + key.len();
    let rest = &hay[at..];
    let q1 = rest.find('"')?;
    // `sound: null` — a null (or next field) before any quote means no value.
    if rest[..q1].contains("null") || rest[..q1].contains(',') {
        return None;
    }
    let rest = &rest[q1 + 1..];
    let q2 = rest.find('"')?;
    Some(rest[..q2].to_string())
}

/// Slice the `[ … ]` array following `key`, bracket-depth aware.
fn array_after<'a>(hay: &'a str, key: &str) -> Option<&'a str> {
    let at = hay.find(key)?;
    let open = at + hay[at..].find('[')?;
    let mut depth = 0usize;
    for (i, c) in hay[open..].char_indices() {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&hay[open..=open + i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Split an array slice into its top-level `{ … }` object slices.
fn objects_in(array: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0usize;
    for (i, c) in array.char_indices() {
        match c {
            '{' => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    out.push(&array[start..=i]);
                }
            }
            _ => {}
        }
    }
    out
}

/// `s2r://panorama/videos/x.webm` → the path stored in the vpk index.
fn src_to_internal(src: &str) -> String {
    let p = src
        .trim_start_matches("s2r://")
        .trim_start_matches("file://{resources}/")
        .trim_start_matches("file://");
    let p = if p.starts_with("panorama/") || p.starts_with("sounds/") {
        p.to_string()
    } else {
        format!("panorama/{p}")
    };
    // Compiled resources carry the _c suffix in the index (webms ship raw).
    if p.ends_with(".vtex") || p.ends_with(".vsnd") { format!("{p}_c") } else { p }
}

/// One soundevent's (volume, first vsnd path) from decompiled KV3 text.
fn event_info(kv3: &str, event: &str) -> Option<(f64, String)> {
    let at = kv3.find(&format!("{event} = "))?;
    let block = &kv3[at..kv3.len().min(at + 600)];
    let volume = num_after(block, "volume").unwrap_or(3.0);
    let vsnd = str_after(block, "vsnd_files")
        .or_else(|| block.find("sounds/").map(|i| {
            let rest = &block[i..];
            rest[..rest.find(['"', '\n']).unwrap_or(rest.len())].to_string()
        }))?;
    Some((volume, vsnd))
}

/// Parse + extract a DigiMaster pak into an editable config. `dest_dir`
/// receives the media files (webm/png/audio), one per entry.
pub fn import_from_vpk(helper: &str, vpk: &str, dest_dir: &Path) -> Result<DigimodImport, String> {
    std::fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
    let tmp = dest_dir.join(".import_tmp");
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    // The JS source rides verbatim inside the compiled resource.
    let raw_js = tmp.join("digi_master.raw");
    crate::vpk::extract(helper, vpk, "panorama/scripts/digi_master.vjs_c", &raw_js.to_string_lossy())
        .map_err(|e| format!("no DigiMaster engine in this pak ({e})"))?;
    let js = String::from_utf8_lossy(&std::fs::read(&raw_js).map_err(|e| e.to_string())?).into_owned();

    // Sound events (volumes + vsnd paths) — optional, the pak may ship none.
    let kv3 = {
        let out = tmp.join("world_ambient_emitters.kv3");
        crate::vpk::decompile_from_vpk(
            helper,
            vpk,
            "soundevents/world_ambient_emitters.vsndevts_c",
            &out.to_string_lossy(),
        )
        .ok()
        .and_then(|_| std::fs::read_to_string(&out).ok())
        .unwrap_or_default()
    };

    let mut warnings: Vec<String> = Vec::new();
    let mut used_ids: Vec<String> = Vec::new();
    // Sound library: one entry per Digi.* event — decoded once, shared by
    // every media entry that references it (mirrors the pak's structure).
    let mut sounds: Vec<ImportedSound> = Vec::new();
    let mut sound_fail: Vec<String> = Vec::new(); // events that didn't decode
    let mut sound_for_event = |event: &str, warnings: &mut Vec<String>| -> Option<String> {
        let id = sanitize_id(event.trim_start_matches("Digi."));
        if let Some(s) = sounds.iter().find(|s| s.id == id) {
            return Some(s.id.clone());
        }
        if sound_fail.iter().any(|e| e == event) {
            return None;
        }
        let Some((volume, vsnd)) = event_info(&kv3, event) else {
            warnings.push(format!("sound event {event} not found in the pak"));
            sound_fail.push(event.to_string());
            return None;
        };
        let base = dest_dir.join(format!("{id}_sound"));
        match crate::vpk::decode(helper, vpk, &format!("{vsnd}_c"), &base.to_string_lossy()) {
            Ok(written) => {
                let path = written.lines().last().map(|l| l.trim().to_string())?;
                sounds.push(ImportedSound {
                    id: id.clone(),
                    name: event.trim_start_matches("Digi.").to_string(),
                    source_audio: path,
                    volume,
                });
                Some(id)
            }
            Err(e) => {
                warnings.push(format!("sound {vsnd} not recovered ({e})"));
                sound_fail.push(event.to_string());
                None
            }
        }
    };
    let mut parse_list = |key: &str| -> Vec<ImportedEntry> {
        let Some(array) = array_after(&js, key) else { return vec![] };
        let mut out = Vec::new();
        for obj in objects_in(array) {
            let Some(src) = str_after(obj, "src") else { continue };
            let name = str_after(obj, "name").unwrap_or_else(|| "entry".into());
            let kind = if str_after(obj, "type").as_deref() == Some("image")
                || src.ends_with(".vtex")
                || src.ends_with(".png")
            {
                "image"
            } else {
                "video"
            };
            let mut id = sanitize_id(&name);
            let mut n = 2;
            while used_ids.contains(&id) {
                id = format!("{}_{n}", sanitize_id(&name));
                n += 1;
            }
            used_ids.push(id.clone());

            // Media out of the pak: webms come out raw, vtex decodes to png.
            let internal = src_to_internal(&src);
            let source_media = if kind == "image" {
                let png = dest_dir.join(format!("{id}.png"));
                let raw = tmp.join(format!("{id}.vtex_c"));
                crate::vpk::extract(helper, vpk, &internal, &raw.to_string_lossy())
                    .and_then(|_| crate::vpk::texture_file(helper, &raw.to_string_lossy(), &png.to_string_lossy()))
                    .map(|_| png)
            } else {
                let webm = dest_dir.join(format!("{id}.webm"));
                crate::vpk::extract(helper, vpk, &internal, &webm.to_string_lossy()).map(|_| webm)
            };
            let source_media = match source_media {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(e) => {
                    warnings.push(format!("{name}: media {internal} not recovered ({e})"));
                    continue;
                }
            };

            // Sound: event name -> shared library sound (decoded once).
            let sound_id =
                str_after(obj, "sound").and_then(|event| sound_for_event(&event, &mut warnings));

            out.push(ImportedEntry {
                id,
                name,
                kind: kind.into(),
                source_media,
                show: num_after(obj, "show").unwrap_or(1.0).max(0.1),
                preset: match str_after(obj, "preset").as_deref() {
                    Some("banner") => "banner".into(),
                    _ => "fullscreen".into(),
                },
                sound_id,
            });
        }
        out
    };

    let scares = parse_list("SCARES");
    let deaths = parse_list("DEATHS");
    drop(parse_list);
    drop(sound_for_event);
    let _ = std::fs::remove_dir_all(&tmp);
    if scares.is_empty() && deaths.is_empty() {
        return Err("no media entries found in this pak's DigiMaster library".into());
    }
    Ok(DigimodImport {
        rng_interval: num_after(&js, "RNG_INTERVAL").unwrap_or(60.0) as u32,
        scare_chance: num_after(&js, "SCARE_CHANCE").unwrap_or(3.0) as u32,
        death_chance: num_after(&js, "DEATH_CHANCE").unwrap_or(100.0) as u32,
        scares,
        deaths,
        sounds,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::{array_after, event_info, inject_hooks, num_after, objects_in, src_to_internal, str_after};

    // Exact shape of the user's real pak03 JS (and of gen_js output).
    const JS: &str = r#"var CONFIG = {
    IS_ENABLED: true,
    RNG_INTERVAL: 60,
    SCARE_CHANCE: 3,
    DEATH_CHANCE: 100,
};
var LIBRARY = {
    SCARES: [
        { name: "scare_1",  type: "video", src: "s2r://panorama/videos/scare_1.webm",  show: 0.8, sound: "Digi.Scare1", preset: "fullscreen" },
        { name: "scare_img", type: "image", src: "s2r://panorama/images/digi/scare_1.vtex", show: 0.3, sound: null, preset: "fullscreen" },
    ],
    DEATHS: [
        { name: "death_1",   type: "video", src: "s2r://panorama/videos/death_screen.webm",   show: 5.5, sound: "Digi.Death",    preset: "banner" },
    ],
};"#;

    #[test]
    fn config_numbers_parse() {
        assert_eq!(num_after(JS, "RNG_INTERVAL"), Some(60.0));
        assert_eq!(num_after(JS, "SCARE_CHANCE"), Some(3.0));
        assert_eq!(num_after(JS, "DEATH_CHANCE"), Some(100.0));
    }

    #[test]
    fn library_arrays_and_fields_parse() {
        let scares = objects_in(array_after(JS, "SCARES").unwrap());
        assert_eq!(scares.len(), 2);
        assert_eq!(str_after(scares[0], "name").as_deref(), Some("scare_1"));
        assert_eq!(str_after(scares[0], "sound").as_deref(), Some("Digi.Scare1"));
        assert_eq!(num_after(scares[0], "show"), Some(0.8));
        assert_eq!(str_after(scares[1], "sound"), None); // null sound
        assert_eq!(str_after(scares[1], "type").as_deref(), Some("image"));
        let deaths = objects_in(array_after(JS, "DEATHS").unwrap());
        assert_eq!(deaths.len(), 1);
        assert_eq!(str_after(deaths[0], "preset").as_deref(), Some("banner"));
    }

    #[test]
    fn src_paths_map_to_vpk_internals() {
        assert_eq!(src_to_internal("s2r://panorama/videos/scare_1.webm"), "panorama/videos/scare_1.webm");
        assert_eq!(src_to_internal("s2r://panorama/images/digi/fuck.vtex"), "panorama/images/digi/fuck.vtex_c");
        assert_eq!(src_to_internal("file://{resources}/videos/v.webm"), "panorama/videos/v.webm");
    }

    /// Real import against the user's installed v2 pak (needs the helper +
    /// the pak on disk): cargo test -p app --lib -- --ignored e2e_import_digimod --nocapture
    #[test]
    #[ignore]
    fn e2e_import_digimod_from_real_pak() {
        let helper = concat!(env!("CARGO_MANIFEST_DIR"), "/../../tools/vpk-helper/dist/vpk-helper.exe");
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\addons\pak03_dir.vpk";
        if !std::path::Path::new(helper).exists() || !std::path::Path::new(pak).exists() {
            eprintln!("skipping: helper or pak missing");
            return;
        }
        let dest = std::env::temp_dir().join("eim_digimod_import_test");
        let _ = std::fs::remove_dir_all(&dest);
        let imp = super::import_from_vpk(helper, pak, &dest).expect("import failed");
        eprintln!(
            "interval={} scare%={} death%={} | {} scares, {} deaths, {} sounds, {} warnings",
            imp.rng_interval, imp.scare_chance, imp.death_chance,
            imp.scares.len(), imp.deaths.len(), imp.sounds.len(), imp.warnings.len()
        );
        for w in &imp.warnings {
            eprintln!("  warn: {w}");
        }
        for s in &imp.sounds {
            let ok = std::path::Path::new(&s.source_audio).exists();
            eprintln!("  sound {} vol={} ok={ok}", s.id, s.volume);
            assert!(ok, "sound audio missing for {}", s.id);
        }
        for e in imp.scares.iter().chain(imp.deaths.iter()) {
            let media_ok = std::path::Path::new(&e.source_media).exists();
            let sound_ok = e
                .sound_id
                .as_deref()
                .map(|id| imp.sounds.iter().any(|s| s.id == id));
            eprintln!(
                "  {} [{}] show={} preset={} sound={:?} media_ok={media_ok} sound_in_library={sound_ok:?}",
                e.id, e.kind, e.show, e.preset, e.sound_id
            );
            assert!(media_ok, "media missing for {}", e.id);
            assert_ne!(sound_ok, Some(false), "dangling sound id on {}", e.id);
        }
        assert!(!imp.scares.is_empty() && !imp.deaths.is_empty());
        // The pak reuses events across entries — the library must be deduped
        // (fewer sounds than entries proves sharing survived the import).
        assert!(imp.sounds.len() < imp.scares.len() + imp.deaths.len());
    }

    #[test]
    fn event_info_reads_volume_and_first_vsnd() {
        let kv3 = "{\n\tDigi.Scare1 = \n\t{\n\t\tbase = \"Base.UI\"\n\t\tvolume = 5.0\n\t\tvsnd_files = \"sounds/scare_1.vsnd\"\n\t}\n\tDigi.Scare3 = \n\t{\n\t\tvolume = 2.5\n\t\tvsnd_files = \n\t\t[\n\t\t\t\"sounds/scare_3.vsnd\",\n\t\t\t\"sounds/scare_5.vsnd\",\n\t\t]\n\t}\n}";
        assert_eq!(event_info(kv3, "Digi.Scare1"), Some((5.0, "sounds/scare_1.vsnd".into())));
        assert_eq!(event_info(kv3, "Digi.Scare3"), Some((2.5, "sounds/scare_3.vsnd".into())));
        assert_eq!(event_info(kv3, "Digi.Nope"), None);
    }


    // Shape of a VRF-recovered foreign hud mod's base_hud (a vanilla copy
    // plus that mod's own include + panel).
    const FOREIGN: &str = "<root>\n\t<styles>\n\t\t<include src=\"s2r://panorama/styles/base.vcss_c\" />\n\t\t<include src=\"s2r://panorama/styles/cool_hud.vcss_c\" />\n\t</styles>\n\t<scripts>\n\t\t<include src=\"s2r://panorama/scripts/cool_hud.vjs_c\" />\n\t</scripts>\n\t<Panel class=\"WindowRoot\" hittest=\"false\">\n\t\t<CitadelHud id=\"Hud\" hittest=\"false\" />\n\t\t<Panel id=\"CoolHudExtra\" hittest=\"false\" />\n\t</Panel>\n</root>\n";

    #[test]
    fn injects_styles_scripts_and_panels() {
        let out = inject_hooks(FOREIGN).unwrap();
        // Theirs survive…
        assert!(out.contains("cool_hud.vcss_c"));
        assert!(out.contains("cool_hud.vjs_c"));
        assert!(out.contains("CoolHudExtra"));
        // …ours arrive…
        assert!(out.contains("jumpscare_overlay.vcss_c"));
        assert!(out.contains("digi_master.vjs_c"));
        assert!(out.contains("anita_ui_core.vjs_c"));
        assert!(out.contains("MediaOverlayContainer"));
        // …inside the WindowRoot panel, before its closing tag.
        assert!(out.rfind("MediaOverlayContainer").unwrap() < out.rfind("</Panel>").unwrap());
        assert!(out.rfind("MediaOverlayContainer").unwrap() > out.find("CitadelHud").unwrap());
    }

    #[test]
    fn idempotent_on_reinjection() {
        let once = inject_hooks(FOREIGN).unwrap();
        let twice = inject_hooks(&once).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn adds_scripts_block_when_missing() {
        let no_scripts = FOREIGN.replace("\t<scripts>\n\t\t<include src=\"s2r://panorama/scripts/cool_hud.vjs_c\" />\n\t</scripts>\n", "");
        let out = inject_hooks(&no_scripts).unwrap();
        assert!(out.contains("<scripts>"));
        assert!(out.contains("digi_master.vjs_c"));
        // The synthesized block sits between styles and the root panel.
        assert!(out.find("<scripts>").unwrap() > out.find("</styles>").unwrap());
        assert!(out.find("</scripts>").unwrap() < out.find("WindowRoot").unwrap());
    }

    #[test]
    fn errors_without_styles_or_root_panel() {
        assert!(inject_hooks("<root></root>").is_err());
    }
}
