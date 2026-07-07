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

use crate::compile::{CompileConfig, CompileReport, DigiEntry, DigimodCompile};

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

fn event_name(e: &DigiEntry) -> String {
    format!("Digi.{}", sanitize_id(&e.id))
}

fn media_rel(e: &DigiEntry) -> String {
    if e.kind == "image" {
        format!("panorama/images/digi/{}.vtex", sanitize_id(&e.id))
    } else {
        format!("panorama/videos/digi/{}.webm", sanitize_id(&e.id))
    }
}

/// JSON-ish JS literal for one library entry.
fn entry_js(e: &DigiEntry) -> String {
    let sound = if e.source_audio.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        format!("\"{}\"", event_name(e))
    } else {
        "null".into()
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

/// Fingerprint of the whole digimod config + every source file's identity.
fn digimod_fingerprint(dm: &DigimodCompile) -> String {
    let mut key = format!(
        "v1|{}|{}|{}\n",
        dm.rng_interval, dm.scare_chance, dm.death_chance
    );
    for e in dm.scares.iter().chain(dm.deaths.iter()) {
        for p in [Some(e.source_media.as_str()), e.source_audio.as_deref()].into_iter().flatten() {
            let meta = std::fs::metadata(p).ok();
            let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            key.push_str(&format!("{p}|{len}|{mtime}|"));
        }
        key.push_str(&format!("{}|{}|{}|{:.2}|{:.2}\n", e.id, e.kind, e.preset, e.show, e.volume));
    }
    crate::compile::fingerprint(&key)
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

/// Generate the soundevents file (Digi.* events only, like the original mod).
fn gen_soundevents(dm: &DigimodCompile) -> String {
    let mut out = String::from(
        "<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:generic:version{7412167c-06e9-4698-aff2-e63eb59037e7} -->\n{\n",
    );
    for e in dm.scares.iter().chain(dm.deaths.iter()) {
        if e.source_audio.as_deref().map(|s| s.is_empty()).unwrap_or(true) {
            continue;
        }
        out.push_str(&format!(
            "\t{} = \n\t{{\n\t\tbase = \"Base.UI\"\n\t\tvolume = {:.6}\n\t\tpitch = 1.000000\n\t\tvsnd_files = \"sounds/digi/{}.vsnd\"\n\t}}\n",
            event_name(e),
            e.volume.clamp(0.0, 10.0),
            sanitize_id(&e.id),
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
    let scares: Vec<String> = dm.scares.iter().map(entry_js).collect();
    let deaths: Vec<String> = dm.deaths.iter().map(entry_js).collect();
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
    if dm.scares.is_empty() && dm.deaths.is_empty() {
        return Ok((vec![], false));
    }
    let ffmpeg = cfg.ffmpeg_path.as_deref();

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
        if e.source_audio.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
            rels.push(format!("sounds/digi/{}.vsnd_c", sanitize_id(&e.id)));
        }
    }

    // Up-to-date skip.
    let stamp = content_root.join(".eim_digimod_stamp");
    let key = digimod_fingerprint(dm);
    if !cfg.skip_compile
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

    // 1) Static engine + generated JS/soundevents into the content tree.
    let mut to_compile: Vec<PathBuf> = Vec::new();
    let mut all_ok = true;
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
        if let Some(audio) = e.source_audio.as_deref().filter(|s| !s.is_empty()) {
            // Any audio format -> wav source; the compiler makes the vsnd_c.
            let wav = content_root.join(format!("sounds/digi/{id}.wav"));
            if let Some(parent) = wav.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let exe = ffmpeg.unwrap_or("ffmpeg");
            let out = crate::procutil::quiet(exe)
                .args(["-y", "-i", audio])
                .arg(&wav)
                .output();
            match out {
                Ok(o) if o.status.success() => to_compile.push(wav),
                Ok(o) => {
                    report.soft_fail(
                        format!("jumpscare sound: {}", e.name),
                        String::from_utf8_lossy(&o.stderr).lines().rev().take(2).collect::<Vec<_>>().join(" | "),
                    );
                    all_ok = false;
                }
                Err(err) => {
                    report.soft_fail(format!("jumpscare sound: {}", e.name), err.to_string());
                    all_ok = false;
                }
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
    match write("panorama/layout/base_hud.xml", TPL_XML) {
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

    report.ok_step(
        "jumpscares mod",
        format!("{} scare(s), {} death(s)", dm.scares.len(), dm.deaths.len()),
    );
    if all_ok {
        let _ = std::fs::write(&stamp, &key);
    }
    Ok((rels, true))
}
