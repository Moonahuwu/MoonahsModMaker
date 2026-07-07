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
        for p in [Some(e.source_media.as_str()), e.source_audio.as_deref()].into_iter().flatten() {
            key.push_str(&file_identity(p));
        }
        key.push_str(&format!("{}|{}|{}|{:.2}|{:.2}\n", e.id, e.kind, e.preset, e.show, e.volume));
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
        if e.source_audio.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
            rels.push(format!("sounds/digi/{}.vsnd_c", sanitize_id(&e.id)));
        }
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

#[cfg(test)]
mod tests {
    use super::inject_hooks;

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
