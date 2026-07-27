// Shared Pack: make a profile portable so two people can sync one mod build
// through an ordinary shared folder (a GitHub repo clone, a Dropbox folder...).
//
// A profile blob is machine-independent EXCEPT for absolute media paths (song
// sources, icon/poster art, digimod media, adopted-entry source vpks, imported
// mod vpks / cache dirs). Export walks the JSON generically: every string that
// is an absolute path to something that exists gets copied into the pack
// folder's `assets/` and rewritten to a portable `pack://` reference; import
// reverses the rewrite against the reader's own pack folder, so their profile
// points straight into their clone (pulling updates needs no re-copy).
//
// The walk is deliberately schema-blind: new path-bearing fields added to the
// project later are picked up automatically. Non-path strings can't collide
// because a candidate must actually exist on disk to be packed.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

pub const PACK_FILE: &str = "pack.json";
const PACK_PREFIX: &str = "pack://";
const PACK_FORMAT: u64 = 1;

#[derive(serde::Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Distinct files/dirs referenced by the profile (copied or already there).
    pub packed: usize,
    /// Bytes actually written this run (0 = everything was already up to date).
    pub copied_bytes: u64,
    /// String references rewritten to pack:// form.
    pub rewritten: usize,
    pub warnings: Vec<String>,
    pub pack_json: String,
}

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub name: String,
    pub data: serde_json::Value,
    pub warnings: Vec<String>,
}

/// Normalize a Windows path string for identity comparisons (case-insensitive,
/// one separator style).
fn norm(s: &str) -> String {
    s.replace('/', "\\").to_lowercase()
}

/// Absolute path candidate: `C:\...`, `C:/...` or a `\\server\share` UNC.
/// Composite strings that merely EMBED a path (`C:\x.mp3|stem|0|21`, the
/// compile-hash cache keys) contain characters Windows forbids in paths, so
/// they're rejected here instead of warning as "missing".
fn looks_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    let shaped = (b.len() > 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/'))
        || s.starts_with("\\\\");
    shaped && !s[2..].contains(['<', '>', '"', '|', '?', '*', ':'])
}

fn short_hash(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:08x}", (h.finish() & 0xffff_ffff) as u32)
}

/// Copy `src` to `dst` unless `dst` already exists with the same length
/// (media edits virtually always change size; a same-size skip keeps repeated
/// "Save to pack" runs from rewriting gigabytes and churning git). Returns
/// bytes actually written.
fn copy_file_if_changed(src: &Path, dst: &Path) -> Result<u64, String> {
    let src_len = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?.len();
    if let Ok(m) = std::fs::metadata(dst) {
        if m.is_file() && m.len() == src_len {
            return Ok(0);
        }
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::copy(src, dst).map_err(|e| format!("copy {} -> {}: {e}", src.display(), dst.display()))
}

fn copy_tree_if_changed(src: &Path, dst: &Path) -> Result<u64, String> {
    let mut written = 0u64;
    std::fs::create_dir_all(dst).map_err(|e| format!("{}: {e}", dst.display()))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            written += copy_tree_if_changed(&entry.path(), &to)?;
        } else if ty.is_file() {
            written += copy_file_if_changed(&entry.path(), &to)?;
        }
    }
    Ok(written)
}

struct Packer<'a> {
    dir: &'a Path,
    dir_norm: String,
    app_data_norm: String,
    /// source path (normalized) -> pack:// reference already assigned.
    seen: HashMap<String, String>,
    /// destination relpath (normalized) -> source path (normalized), to
    /// uniquify same-named files from different folders.
    dest_taken: HashMap<String, String>,
    report: ExportReport,
}

impl Packer<'_> {
    /// Decide the stable in-pack home for a source path. Files that live under
    /// app-data keep their app-data-relative layout (stable across saves, so
    /// git sees updates, not renames); anything else lands flat under
    /// `assets/files/` (or `assets/dirs/<name>` for directories).
    fn dest_rel_for(&mut self, src: &str, is_dir: bool) -> String {
        let n = norm(src);
        let rel = if !self.app_data_norm.is_empty() && n.starts_with(&self.app_data_norm) {
            format!("assets/appdata/{}", src[self.app_data_norm.len()..].trim_start_matches(['\\', '/']).replace('\\', "/"))
        } else {
            let name = Path::new(src)
                .file_name()
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into());
            if is_dir { format!("assets/dirs/{name}") } else { format!("assets/files/{name}") }
        };
        // Same destination claimed by a different source: salt with a hash of
        // the source path so both survive.
        match self.dest_taken.get(&norm(&rel)) {
            Some(owner) if *owner != n => {
                let p = Path::new(&rel);
                let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                let parent = p.parent().map(|d| d.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                let salted = format!("{parent}/{stem}_{}{ext}", short_hash(&n));
                self.dest_taken.insert(norm(&salted), n);
                salted
            }
            _ => {
                self.dest_taken.insert(norm(&rel), n);
                rel
            }
        }
    }

    /// Map one absolute path string to its pack:// form, copying it into the
    /// pack folder if needed. None = leave the string untouched.
    fn pack_path(&mut self, s: &str) -> Option<String> {
        let n = norm(s);
        if let Some(existing) = self.seen.get(&n) {
            return Some(existing.clone());
        }
        // Already inside the pack folder (a profile previously loaded FROM
        // this pack): just re-relativize, nothing to copy.
        if n.starts_with(&self.dir_norm) {
            let rel = s[self.dir_norm.len()..].trim_start_matches(['\\', '/']).replace('\\', "/");
            let r = format!("{PACK_PREFIX}{rel}");
            self.seen.insert(n, r.clone());
            self.report.packed += 1;
            return Some(r);
        }
        let src = Path::new(s);
        let meta = match std::fs::metadata(src) {
            Ok(m) => m,
            Err(_) => {
                let w = format!("missing on this machine, kept as-is: {s}");
                if !self.report.warnings.contains(&w) {
                    self.report.warnings.push(w);
                }
                return None;
            }
        };
        let rel = self.dest_rel_for(s, meta.is_dir());
        let dst = self.dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        let copied = if meta.is_dir() {
            copy_tree_if_changed(src, &dst)
        } else {
            copy_file_if_changed(src, &dst)
        };
        match copied {
            Ok(bytes) => {
                self.report.copied_bytes += bytes;
                self.report.packed += 1;
                let r = format!("{PACK_PREFIX}{rel}");
                self.seen.insert(n, r.clone());
                Some(r)
            }
            Err(e) => {
                self.report.warnings.push(format!("couldn't pack {s}: {e}"));
                None
            }
        }
    }

    fn walk(&mut self, v: &mut serde_json::Value) {
        match v {
            serde_json::Value::String(s) => {
                if looks_absolute(s) {
                    if let Some(r) = self.pack_path(s) {
                        *s = r;
                        self.report.rewritten += 1;
                    }
                }
            }
            serde_json::Value::Array(a) => a.iter_mut().for_each(|x| self.walk(x)),
            serde_json::Value::Object(o) => o.values_mut().for_each(|x| self.walk(x)),
            _ => {}
        }
    }
}

/// Starter repo files, written only when absent so user edits stick.
fn write_starter_files(dir: &Path, name: &str) {
    let attrs = dir.join(".gitattributes");
    if !attrs.exists() {
        let _ = std::fs::write(
            &attrs,
            "# Large media via Git LFS (GitHub rejects files over 100 MB without it).\n\
             # Needs `git lfs install` once per machine.\n\
             *.vpk filter=lfs diff=lfs merge=lfs -text\n\
             *.wav filter=lfs diff=lfs merge=lfs -text\n\
             *.webm filter=lfs diff=lfs merge=lfs -text\n\
             *.mp4 filter=lfs diff=lfs merge=lfs -text\n\
             *.mov filter=lfs diff=lfs merge=lfs -text\n\
             *.mkv filter=lfs diff=lfs merge=lfs -text\n\
             *.flac filter=lfs diff=lfs merge=lfs -text\n",
        );
    }
    let readme = dir.join("README.md");
    if !readme.exists() {
        let _ = std::fs::write(
            &readme,
            format!(
                "# {name}\n\nA Moonahs Mod Maker shared pack. In the app: Settings > Shared Pack,\n\
                 point it at this folder, then \"Load profile from pack\".\n\n\
                 `pack.json` is the profile; `assets/` holds every referenced file.\n"
            ),
        );
    }
}

pub fn export_pack(
    dir: &Path,
    app_data: &Path,
    name: &str,
    mut data: serde_json::Value,
) -> Result<ExportReport, String> {
    if dir.as_os_str().is_empty() {
        return Err("no pack folder set".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let mut p = Packer {
        dir,
        dir_norm: format!("{}\\", norm(&dir.to_string_lossy()).trim_end_matches('\\')),
        app_data_norm: {
            let n = norm(&app_data.to_string_lossy());
            if n.is_empty() { n } else { format!("{}\\", n.trim_end_matches('\\')) }
        },
        seen: HashMap::new(),
        dest_taken: HashMap::new(),
        report: ExportReport::default(),
    };
    p.walk(&mut data);

    let saved_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let envelope = serde_json::json!({
        "eimPack": PACK_FORMAT,
        "name": name,
        "savedAtUnix": saved_at_unix,
        "data": data,
    });
    let path = dir.join(PACK_FILE);
    let text = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    write_starter_files(dir, name);

    let mut report = p.report;
    report.pack_json = path.to_string_lossy().into_owned();
    Ok(report)
}

fn unpack_strings(v: &mut serde_json::Value, dir: &Path, warnings: &mut Vec<String>) {
    match v {
        serde_json::Value::String(s) => {
            if let Some(rel) = s.strip_prefix(PACK_PREFIX) {
                if rel.split(['/', '\\']).any(|seg| seg == "..") {
                    warnings.push(format!("ignored unsafe reference: {s}"));
                    return;
                }
                let abs = dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                if !abs.exists() {
                    let w = format!("referenced file not in the pack folder (pull incomplete?): {rel}");
                    if !warnings.contains(&w) {
                        warnings.push(w);
                    }
                }
                *s = abs.to_string_lossy().into_owned();
            }
        }
        serde_json::Value::Array(a) => a.iter_mut().for_each(|x| unpack_strings(x, dir, warnings)),
        serde_json::Value::Object(o) => o.values_mut().for_each(|x| unpack_strings(x, dir, warnings)),
        _ => {}
    }
}

pub fn import_pack(dir: &Path) -> Result<ImportResult, String> {
    let path = dir.join(PACK_FILE);
    let text = std::fs::read_to_string(&path)
        .map_err(|_| format!("no {PACK_FILE} in {} - is this the pack folder (the repo clone)?", dir.display()))?;
    let envelope: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{PACK_FILE} is not valid JSON: {e}"))?;
    if envelope.get("eimPack").and_then(|v| v.as_u64()) != Some(PACK_FORMAT) {
        return Err(format!("{PACK_FILE} isn't a Moonahs Mod Maker pack (or is from a newer app version)"));
    }
    let name = envelope
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Shared Pack")
        .to_string();
    let mut data = envelope.get("data").cloned().unwrap_or(serde_json::Value::Null);
    if data.is_null() {
        return Err(format!("{PACK_FILE} has no profile data"));
    }
    let mut warnings = Vec::new();
    unpack_strings(&mut data, dir, &mut warnings);
    Ok(ImportResult { name, data, warnings })
}

// ---- Pack Builder release packaging ----------------------------------------
// Phase 3 of the module workflow: wrap an exported module vpk into a
// ready-to-upload release zip (vpk + README with the generated description)
// and drop the description next to it for easy copy-paste into GameBanana.

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReleasePackage {
    pub zip_path: String,
    pub zip_bytes: u64,
    pub description_path: String,
}

pub fn package_release(
    vpk: &Path,
    out_dir: &Path,
    zip_stem: &str,
    description: &str,
) -> Result<ReleasePackage, String> {
    use std::io::Write;
    if !vpk.is_file() {
        return Err(format!("compiled vpk not found: {}", vpk.display()));
    }
    std::fs::create_dir_all(out_dir).map_err(|e| format!("{}: {e}", out_dir.display()))?;
    let zip_path = out_dir.join(format!("{zip_stem}.zip"));
    let file = std::fs::File::create(&zip_path).map_err(|e| format!("{}: {e}", zip_path.display()))?;
    let mut z = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let vpk_name = vpk
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_else(|| "pak01_dir.vpk".into());
    z.start_file(&vpk_name, opts).map_err(|e| e.to_string())?;
    let mut src = std::fs::File::open(vpk).map_err(|e| e.to_string())?;
    std::io::copy(&mut src, &mut z).map_err(|e| e.to_string())?;
    z.start_file("README.txt", opts).map_err(|e| e.to_string())?;
    z.write_all(description.as_bytes()).map_err(|e| e.to_string())?;
    z.finish().map_err(|e| e.to_string())?;
    let description_path = out_dir.join("description.txt");
    std::fs::write(&description_path, description).map_err(|e| e.to_string())?;
    let zip_bytes = std::fs::metadata(&zip_path).map(|m| m.len()).unwrap_or(0);
    Ok(ReleasePackage {
        zip_path: zip_path.to_string_lossy().into_owned(),
        zip_bytes,
        description_path: description_path.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("eim_packsync_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn export_import_round_trip() {
        let root = temp_root("rt");
        let app_data = root.join("appdata");
        std::fs::create_dir_all(app_data.join("pack_icons").join("ab12")).unwrap();
        std::fs::write(app_data.join("pack_icons").join("ab12").join("icon.png"), b"png-bytes").unwrap();
        let loose = root.join("loose");
        std::fs::create_dir_all(&loose).unwrap();
        std::fs::write(loose.join("song.mp3"), b"mp3-bytes").unwrap();
        let cache_dir = root.join("modcache");
        std::fs::create_dir_all(cache_dir.join("sub")).unwrap();
        std::fs::write(cache_dir.join("sub").join("a.vsnd_c"), b"snd").unwrap();

        let pack = root.join("pack");
        let icon = app_data.join("pack_icons").join("ab12").join("icon.png");
        let song = loose.join("song.mp3");
        let missing = root.join("gone.wav");
        let blob = serde_json::json!({
            "project": {
                "sourceMp3": song.to_string_lossy(),
                "sourceImage": icon.to_string_lossy(),
                "dup": song.to_string_lossy(),
                "lastCompiledHash": format!("{}|stem|0|21", song.to_string_lossy()),
                "eventName": "s89142_hero_intro",
                "missing": missing.to_string_lossy(),
            },
            "importedMods": [cache_dir.to_string_lossy()],
        });

        let rep = export_pack(&pack, &app_data, "TestPack", blob).unwrap();
        assert_eq!(rep.packed, 3, "icon + song + cache dir (dup dedupes): {rep:?}");
        assert_eq!(rep.rewritten, 4, "sourceMp3 + sourceImage + dup + importedMods[0]");
        assert_eq!(rep.warnings.len(), 1, "only the missing file warns: {:?}", rep.warnings);
        assert!(pack.join("assets").join("appdata").join("pack_icons").join("ab12").join("icon.png").is_file());
        assert!(pack.join("assets").join("files").join("song.mp3").is_file());
        assert!(pack.join("assets").join("dirs").join("modcache").join("sub").join("a.vsnd_c").is_file());
        assert!(pack.join(".gitattributes").is_file());

        let text = std::fs::read_to_string(pack.join(PACK_FILE)).unwrap();
        // The composite hash string and non-path strings ride through untouched.
        assert!(text.contains("|stem|0|21"));
        assert!(text.contains("s89142_hero_intro"));
        assert!(text.contains("pack://assets/files/song.mp3"));

        let imp = import_pack(&pack).unwrap();
        assert_eq!(imp.name, "TestPack");
        assert_eq!(imp.warnings.len(), 0, "{:?}", imp.warnings);
        let got = imp.data["project"]["sourceMp3"].as_str().unwrap();
        assert!(Path::new(got).is_file(), "rewritten ref must exist: {got}");
        assert!(norm(got).starts_with(&norm(&pack.to_string_lossy())));

        // Re-export of an imported profile: refs already live in the pack, so
        // nothing copies and everything still round-trips to pack:// form.
        let rep2 = export_pack(&pack, &app_data, "TestPack", imp.data).unwrap();
        assert_eq!(rep2.copied_bytes, 0, "{rep2:?}");
        let text2 = std::fs::read_to_string(pack.join(PACK_FILE)).unwrap();
        assert!(text2.contains("pack://assets/files/song.mp3"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn same_name_different_sources_both_survive() {
        let root = temp_root("dup");
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("track.mp3"), b"aaaa").unwrap();
        std::fs::write(b.join("track.mp3"), b"bbbbbb").unwrap();
        let pack = root.join("pack");
        let blob = serde_json::json!({
            "one": a.join("track.mp3").to_string_lossy(),
            "two": b.join("track.mp3").to_string_lossy(),
        });
        let rep = export_pack(&pack, &root.join("no_appdata"), "X", blob).unwrap();
        assert_eq!(rep.packed, 2);
        let text = std::fs::read_to_string(pack.join(PACK_FILE)).unwrap();
        let one = text.matches("pack://assets/files/track").count();
        assert_eq!(one, 2);
        // Two distinct destinations on disk.
        let files: Vec<_> = std::fs::read_dir(pack.join("assets").join("files")).unwrap().collect();
        assert_eq!(files.len(), 2, "{files:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn package_release_zips_vpk_and_readme() {
        let root = temp_root("rel");
        let vpk = root.join("pak01_dir.vpk");
        std::fs::write(&vpk, vec![0u8; 4096]).unwrap();
        let out = root.join("release");
        let pkg = package_release(&vpk, &out, "Hero Music", "My module.\nCredits: none.").unwrap();
        assert!(Path::new(&pkg.zip_path).is_file());
        assert!(pkg.zip_path.ends_with("Hero Music.zip"));
        assert!(pkg.zip_bytes > 0);
        assert_eq!(
            std::fs::read_to_string(&pkg.description_path).unwrap(),
            "My module.\nCredits: none."
        );
        // The zip must contain exactly the vpk + README.
        let mut ar = zip::ZipArchive::new(std::fs::File::open(&pkg.zip_path).unwrap()).unwrap();
        let names: Vec<String> = (0..ar.len()).map(|i| ar.by_index(i).unwrap().name().to_string()).collect();
        assert_eq!(names, vec!["pak01_dir.vpk".to_string(), "README.txt".to_string()]);
        assert!(package_release(&root.join("missing.vpk"), &out, "x", "d").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn import_rejects_traversal_and_bad_envelopes() {
        let root = temp_root("bad");
        assert!(import_pack(&root.join("nope")).is_err());
        let pack = root.join("pack");
        std::fs::create_dir_all(&pack).unwrap();
        std::fs::write(pack.join(PACK_FILE), "{\"eimPack\": 99, \"data\": {}}").unwrap();
        assert!(import_pack(&pack).unwrap_err().contains("newer app version"));
        std::fs::write(
            pack.join(PACK_FILE),
            "{\"eimPack\": 1, \"name\": \"T\", \"data\": {\"x\": \"pack://../../escape.txt\"}}",
        )
        .unwrap();
        let imp = import_pack(&pack).unwrap();
        assert_eq!(imp.data["x"].as_str().unwrap(), "pack://../../escape.txt", "unsafe ref left untouched");
        assert_eq!(imp.warnings.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
