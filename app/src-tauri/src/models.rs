//! Model Replacement: custom skinned HERO models, compiled through CS2's
//! Workshop Tools (the only current-schema Source 2 compiler users can get:
//! CSDK12 cannot even allocate the modern NmSkeletonList/AnimGraph2List
//! classes - proven 2026-07-29). The flow:
//!
//! 1. `workspace`: decompile the hero's vmdl_c (helper `model` cmd) into an
//!    app-data workspace - the Blender kit (vmdl + every mesh/anim DMX) plus
//!    the parsed bone + material lists.
//! 2. user models in Blender (community rules: rig to the hero armature,
//!    apply transforms, no `.001` names) and exports FBX/DMX.
//! 3. `preflight_fbx`: a name/props-level binary-FBX scan (no vertex-array
//!    decompression) that catches the classic mistakes with human errors.
//! 4. `build`: stage the decompiled tree into a CS2 content addon, generate a
//!    vmdl whose meshes are the user's file (keeping the skeleton, cameras,
//!    attachments and the NmSkeleton/AnimGraph2 references intact), compile
//!    headlessly with auto-stubbed materials, and cache the vmdl_c artifact.
//!    The app's normal compile then ships the artifact at the vanilla path.

use std::path::Path;

/// The CS2 content addon all model builds stage into.
pub const CS2_ADDON: &str = "eim_models";

// ---------------------------------------------------------------------------
// Workspace (decompile + parse)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelWorkspace {
    /// Absolute workspace dir holding the decompiled tree.
    pub dir: String,
    /// Absolute path of the decompiled .vmdl source.
    pub vmdl: String,
    /// Bone names parsed from the vmdl (the armature the user must rig to).
    pub bones: Vec<String>,
    /// Game material paths referenced by the hero (for the material picker).
    pub materials: Vec<String>,
    /// The hero's gameplay-camera settings (CitadelCameraSettings_t scalars,
    /// stock values) - the tab shows them as editable fields so nobody has
    /// to open ModelDoc just to nudge the camera.
    pub camera: Vec<CameraKey>,
    /// File count of the decompiled tree.
    pub files: usize,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CameraKey {
    pub key: String,
    pub value: f64,
}

/// Decompile `hero_vmdl_internal` (e.g. `models/heroes_staging/haze/haze.vmdl_c`)
/// into `<workspace_root>/<hero stem>/` unless already present (refresh forces).
pub fn workspace(
    helper: &str,
    pak: &str,
    hero_vmdl_internal: &str,
    workspace_root: &Path,
    refresh: bool,
) -> Result<ModelWorkspace, String> {
    let internal = hero_vmdl_internal.replace('\\', "/");
    let internal_c = if internal.ends_with(".vmdl_c") {
        internal.clone()
    } else {
        format!("{}_c", internal.trim_end_matches(".vmdl").to_string() + ".vmdl")
    };
    let stem = internal_c
        .rsplit('/')
        .next()
        .unwrap_or("model")
        .trim_end_matches(".vmdl_c")
        .to_string();
    let dir = workspace_root.join(&stem);
    let vmdl_rel = internal_c.trim_end_matches("_c").replace('/', std::path::MAIN_SEPARATOR_STR);
    let vmdl_abs = dir.join(&vmdl_rel);

    if refresh && dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    if !vmdl_abs.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::vpk::model_from_vpk(helper, pak, &internal_c, &dir.to_string_lossy())?;
    }
    if !vmdl_abs.exists() {
        return Err(format!("decompile produced no vmdl at {}", vmdl_abs.display()));
    }
    // The TRUE attachment transforms live in the compiled model's MDAT - the
    // decompiled Attachment angles are lossy (breaks aim/camera anchors).
    // Cache them so every build can restore the exact values. Also fills in
    // for kits decompiled before this existed.
    if !dir.join(ATTACHMENTS_CACHE).exists() {
        if let Ok(mdat) = crate::vpk::model_block_from_vpk(helper, pak, &internal_c, "MDAT") {
            let atts = parse_mdat_attachments(&mdat);
            if !atts.is_empty() {
                let _ = save_attachments_cache(&dir, &atts);
            }
        }
    }

    let text = std::fs::read_to_string(&vmdl_abs).map_err(|e| e.to_string())?;
    let bones = parse_bone_names(&text);
    // Material paths live inside the mesh DMX files (binary, but the paths
    // are plain ASCII runs), not in the vmdl.
    let materials = scan_material_refs(&dir);
    let camera = parse_camera_keys(&text);
    let files = walk_count(&dir);
    Ok(ModelWorkspace {
        dir: dir.to_string_lossy().into_owned(),
        vmdl: vmdl_abs.to_string_lossy().into_owned(),
        bones,
        materials,
        camera,
        files,
    })
}

/// The span of the CitadelCameraSettings_t node's `game_keys` block body
/// (between its braces, exclusive) inside a decompiled vmdl.
fn camera_keys_span(text: &str) -> Option<(usize, usize)> {
    let anchor = text.find("game_class = \"CitadelCameraSettings_t\"")?;
    let rel = text[anchor..].find("game_keys")?;
    let open_rel = text[anchor + rel..].find('{')?;
    let start = anchor + rel + open_rel + 1;
    let mut depth = 1usize;
    for (i, c) in text[start..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some((start, start + i));
                }
            }
            _ => {}
        }
    }
    None
}

/// Scalar camera settings from the hero vmdl's CitadelCameraSettings_t node
/// (vector keys like m_vCameraParrotOffset are left alone).
pub fn parse_camera_keys(text: &str) -> Vec<CameraKey> {
    let Some((a, b)) = camera_keys_span(text) else { return Vec::new() };
    let mut out = Vec::new();
    for line in text[a..b].lines() {
        let t = line.trim();
        if let Some((k, v)) = t.split_once(" = ") {
            if let Ok(value) = v.trim().parse::<f64>() {
                out.push(CameraKey { key: k.trim().to_string(), value });
            }
        }
    }
    out
}

/// Rewrite scalar values inside the vmdl's CitadelCameraSettings_t block.
/// Keys not present are appended to the block so a future patch adding new
/// fields can't silently drop a user's override.
pub fn apply_camera_overrides(text: &str, overrides: &[CameraKey]) -> Result<String, String> {
    if overrides.is_empty() {
        return Ok(text.to_string());
    }
    let (a, b) = camera_keys_span(text)
        .ok_or("the hero vmdl has no CitadelCameraSettings_t block - refresh the kit")?;
    let block = &text[a..b];
    // Indentation of the existing key lines (for appended keys).
    let indent = block
        .lines()
        .find(|l| l.contains(" = "))
        .map(|l| l[..l.len() - l.trim_start().len()].to_string())
        .unwrap_or_else(|| "\t".repeat(8));
    let mut new_block = block.to_string();
    for ov in overrides {
        let needle = format!("{} = ", ov.key);
        let mut replaced = false;
        let lines: Vec<String> = new_block
            .lines()
            .map(|l| {
                if !replaced && l.trim_start().starts_with(&needle) {
                    replaced = true;
                    let ind = &l[..l.len() - l.trim_start().len()];
                    format!("{ind}{} = {}", ov.key, ov.value)
                } else {
                    l.to_string()
                }
            })
            .collect();
        new_block = lines.join("\n");
        if !replaced {
            // Block body ends with the closing brace's leading whitespace -
            // append before it, keeping the trailing shape intact.
            let trailing_ws = new_block.len() - new_block.trim_end().len();
            let cut = new_block.len() - trailing_ws;
            new_block = format!(
                "{}\n{indent}{} = {}{}",
                &new_block[..cut],
                ov.key,
                ov.value,
                &new_block[cut..]
            );
        }
    }
    Ok(format!("{}{}{}", &text[..a], new_block, &text[b..]))
}

fn walk_count(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                n += walk_count(&p);
            } else {
                n += 1;
            }
        }
    }
    n
}

/// Bone names: every `_class = "Bone"` node's `name = "..."` (order kept).
pub fn parse_bone_names(vmdl: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = vmdl;
    while let Some(i) = rest.find("_class = \"Bone\"") {
        rest = &rest[i..];
        if let Some(j) = rest.find("name = \"") {
            let after = &rest[j + 8..];
            if let Some(k) = after.find('"') {
                out.push(after[..k].to_string());
            }
            rest = after;
        } else {
            break;
        }
    }
    out
}

/// Material refs used by the meshes: ASCII `.../*.vmat` runs inside the
/// workspace's DMX files (binary, but paths are plain bytes). Reads at most
/// the first few MB of each file - material tables sit near the front.
pub fn scan_material_refs(dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, out: &mut Vec<String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("dmx")) {
                if let Ok(bytes) = std::fs::read(&p) {
                    scan_bytes(&bytes[..bytes.len().min(4 << 20)], out);
                }
            }
        }
    }
    fn scan_bytes(bytes: &[u8], out: &mut Vec<String>) {
        let needle = b".vmat";
        let mut i = 0;
        while let Some(j) = bytes[i..].windows(needle.len()).position(|w| w == needle) {
            let end = i + j + needle.len();
            // Walk back over path-ish ASCII to the run's start.
            let mut start = i + j;
            while start > 0 {
                let c = bytes[start - 1];
                let ok = c.is_ascii_alphanumeric() || matches!(c, b'/' | b'\\' | b'_' | b'-' | b'.' | b' ');
                if !ok {
                    break;
                }
                start -= 1;
            }
            if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                let s = s.trim_start().replace('\\', "/");
                if s.contains('/') && !out.iter().any(|o| *o == s) {
                    out.push(s);
                }
            }
            i = end;
        }
    }
    let mut out = Vec::new();
    walk(dir, &mut out);
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// FBX preflight (name/props level - no vertex data decompression)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Preflight {
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub info: Vec<String>,
    /// FBX material names, verbatim - the "My textures" UI assigns a texture
    /// set to each and the build ships a real pbr.vfx vmat per name.
    pub materials: Vec<String>,
}

struct FbxNode {
    name: String,
    /// Scalar/string props only; arrays are recorded as `Array(len)`.
    props: Vec<FbxProp>,
    children: Vec<FbxNode>,
}

enum FbxProp {
    Num(f64),
    Str(String),
    Array(u64),
    Other,
}

fn read_u32(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()) as u64)
}
fn read_u64(b: &[u8], o: usize) -> Option<u64> {
    b.get(o..o + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()))
}

fn parse_fbx(bytes: &[u8]) -> Result<Vec<FbxNode>, String> {
    if !bytes.starts_with(b"Kaydara FBX Binary") {
        return Err("not a binary FBX file (re-export from Blender as FBX)".into());
    }
    let version = read_u32(bytes, 23).ok_or("truncated FBX header")?;
    let wide = version >= 7500;
    let mut roots = Vec::new();
    let mut off = 27usize;
    while let Some(node) = parse_node(bytes, &mut off, wide)? {
        roots.push(node);
    }
    Ok(roots)
}

fn parse_node(bytes: &[u8], off: &mut usize, wide: bool) -> Result<Option<FbxNode>, String> {
    let (end, num_props, _plen, name_len, header) = if wide {
        (
            read_u64(bytes, *off).ok_or("eof")?,
            read_u64(bytes, *off + 8).ok_or("eof")?,
            read_u64(bytes, *off + 16).ok_or("eof")?,
            *bytes.get(*off + 24).ok_or("eof")? as usize,
            25usize,
        )
    } else {
        (
            read_u32(bytes, *off).ok_or("eof")?,
            read_u32(bytes, *off + 4).ok_or("eof")?,
            read_u32(bytes, *off + 8).ok_or("eof")?,
            *bytes.get(*off + 12).ok_or("eof")? as usize,
            13usize,
        )
    };
    if end == 0 {
        // Null terminator record.
        *off += header + name_len;
        return Ok(None);
    }
    let name_start = *off + header;
    let name = String::from_utf8_lossy(
        bytes.get(name_start..name_start + name_len).ok_or("eof")?,
    )
    .into_owned();
    let mut p = name_start + name_len;
    let mut props = Vec::new();
    for _ in 0..num_props {
        let t = *bytes.get(p).ok_or("eof")? as char;
        p += 1;
        let prop = match t {
            'Y' => { let v = i16::from_le_bytes(bytes[p..p + 2].try_into().unwrap()); p += 2; FbxProp::Num(v as f64) }
            'C' => { let v = bytes[p]; p += 1; FbxProp::Num(v as f64) }
            'I' => { let v = i32::from_le_bytes(bytes[p..p + 4].try_into().unwrap()); p += 4; FbxProp::Num(v as f64) }
            'F' => { let v = f32::from_le_bytes(bytes[p..p + 4].try_into().unwrap()); p += 4; FbxProp::Num(v as f64) }
            'D' => { let v = f64::from_le_bytes(bytes[p..p + 8].try_into().unwrap()); p += 8; FbxProp::Num(v) }
            'L' => { let v = i64::from_le_bytes(bytes[p..p + 8].try_into().unwrap()); p += 8; FbxProp::Num(v as f64) }
            'S' | 'R' => {
                let len = read_u32(bytes, p).ok_or("eof")? as usize;
                p += 4;
                let s = String::from_utf8_lossy(bytes.get(p..p + len).ok_or("eof")?).into_owned();
                p += len;
                if t == 'S' { FbxProp::Str(s) } else { FbxProp::Other }
            }
            'f' | 'd' | 'i' | 'l' | 'b' => {
                let arr_len = read_u32(bytes, p).ok_or("eof")?;
                let encoding = read_u32(bytes, p + 4).ok_or("eof")?;
                let comp_len = read_u32(bytes, p + 8).ok_or("eof")? as usize;
                p += 12;
                let elem = match t { 'f' | 'i' => 4, 'd' | 'l' => 8, _ => 1 };
                p += if encoding == 1 { comp_len } else { arr_len as usize * elem };
                FbxProp::Array(arr_len)
            }
            other => return Err(format!("unknown FBX property type '{other}'")),
        };
        props.push(prop);
    }
    let mut children = Vec::new();
    let mut cp = p;
    while cp < end as usize {
        let mut o = cp;
        match parse_node(bytes, &mut o, wide)? {
            Some(c) => children.push(c),
            // A null record terminates the child list; nothing reads the
            // cursor after the loop.
            None => break,
        }
        cp = o;
    }
    *off = end as usize;
    Ok(Some(FbxNode { name, props, children }))
}

fn fbx_obj_name(props: &[FbxProp]) -> Option<(String, String)> {
    // FBX object name strings are "ObjectName\x00\x01Class"; the class is also
    // usually prop[2] as a plain string.
    let raw = props.iter().find_map(|p| match p {
        FbxProp::Str(s) if s.contains('\u{0}') => Some(s.clone()),
        _ => None,
    })?;
    let mut it = raw.split('\u{0}');
    let name = it.next().unwrap_or("").to_string();
    let class = props
        .iter()
        .filter_map(|p| match p {
            FbxProp::Str(s) if !s.contains('\u{0}') => Some(s.clone()),
            _ => None,
        })
        .last()
        .unwrap_or_default();
    Some((name, class))
}

/// Name-level preflight of a Blender FBX export against the hero's bone list.
pub fn preflight_fbx(path: &Path, hero_bones: &[String]) -> Result<Preflight, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let roots = parse_fbx(&bytes)?;
    let mut out = Preflight::default();

    let objects = roots.iter().find(|n| n.name == "Objects");
    let Some(objects) = objects else {
        out.errors.push("FBX has no Objects section - export from Blender with default settings".into());
        return Ok(out);
    };

    let bone_set: std::collections::HashSet<&str> =
        hero_bones.iter().map(|s| s.as_str()).collect();
    let mut mesh_names: Vec<String> = Vec::new();
    let mut limb_names: Vec<String> = Vec::new();
    let mut vert_total: u64 = 0;
    let mut has_vertex_colors = false;
    let mut bad_transform: Vec<String> = Vec::new();
    let mut dot001: Vec<String> = Vec::new();
    let mut spaced: Vec<String> = Vec::new();
    let mut material_names: Vec<String> = Vec::new();

    for node in &objects.children {
        match node.name.as_str() {
            "Model" => {
                let Some((name, class)) = fbx_obj_name(&node.props) else { continue };
                if name.contains(".0") && name.rsplit('.').next().map_or(false, |t| t.chars().all(|c| c.is_ascii_digit())) {
                    dot001.push(name.clone());
                }
                match class.as_str() {
                    "Mesh" => {
                        mesh_names.push(name.clone());
                        // Non-identity local transforms = user forgot
                        // Object > Apply > All Transforms.
                        if let Some(p70) = node.children.iter().find(|c| c.name == "Properties70") {
                            for p in &p70.children {
                                let mut label = None;
                                let mut nums: Vec<f64> = Vec::new();
                                for prop in &p.props {
                                    match prop {
                                        FbxProp::Str(s) if label.is_none() => label = Some(s.clone()),
                                        FbxProp::Num(v) => nums.push(*v),
                                        _ => {}
                                    }
                                }
                                let Some(label) = label else { continue };
                                let v3: Vec<f64> = nums.iter().rev().take(3).rev().copied().collect();
                                let close = |a: f64, b: f64| (a - b).abs() < 0.01;
                                // Blender's exporter stamps its unit/axis
                                // conversion on every object (scale 100 or
                                // 0.01, X-rotation +-90) - those are NORMAL.
                                // Flag only genuinely un-applied transforms.
                                let bad = match (label.as_str(), v3.as_slice()) {
                                    ("Lcl Translation", [x, y, z]) => {
                                        x.abs() > 0.01 || y.abs() > 0.01 || z.abs() > 0.01
                                    }
                                    ("Lcl Rotation", [x, y, z]) => {
                                        !(close(*x, 0.0) || close(x.abs(), 90.0))
                                            || y.abs() > 0.01
                                            || z.abs() > 0.01
                                    }
                                    ("Lcl Scaling", [x, y, z]) => {
                                        let uniform = close(*x, *y) && close(*y, *z);
                                        !(uniform
                                            && (close(*x, 1.0) || close(*x, 100.0) || close(*x, 0.01)))
                                    }
                                    _ => false,
                                };
                                if bad && !bad_transform.contains(&name) {
                                    bad_transform.push(name.clone());
                                }
                            }
                        }
                    }
                    "LimbNode" => limb_names.push(name.clone()),
                    _ => {}
                }
            }
            "Geometry" => {
                for c in &node.children {
                    if c.name == "Vertices" {
                        if let Some(FbxProp::Array(n)) = c.props.first() {
                            vert_total += n / 3;
                        }
                    }
                    if c.name == "LayerElementColor" {
                        has_vertex_colors = true;
                    }
                }
            }
            "Material" => {
                if let Some((name, _)) = fbx_obj_name(&node.props) {
                    if name.contains(".0") && name.rsplit('.').next().map_or(false, |t| t.chars().all(|c| c.is_ascii_digit())) {
                        dot001.push(name.clone());
                    }
                    if name.contains(' ') {
                        spaced.push(name.clone());
                    }
                    if !material_names.contains(&name) {
                        material_names.push(name);
                    }
                }
            }
            _ => {}
        }
    }

    if mesh_names.is_empty() {
        out.errors.push("no meshes in the FBX - did you export an empty selection?".into());
    } else {
        out.info.push(format!(
            "{} mesh(es), {} vertices total: {}",
            mesh_names.len(),
            vert_total,
            mesh_names.join(", ")
        ));
    }
    let matched = limb_names.iter().filter(|b| bone_set.contains(b.as_str())).count();
    let extra: Vec<&String> = limb_names.iter().filter(|b| !bone_set.contains(b.as_str())).collect();
    if limb_names.is_empty() {
        out.errors.push("no armature bones in the FBX - the model isn't rigged (parent it to the hero's armature and export the armature too)".into());
    } else if matched == 0 {
        out.errors.push(format!(
            "none of the {} FBX bones match this hero's armature - rig to the decompiled hero's bones (kit folder)",
            limb_names.len()
        ));
    } else {
        out.info.push(format!("{matched} of {} hero bones present", hero_bones.len()));
        if !extra.is_empty() {
            let shown: Vec<&str> = extra.iter().take(6).map(|s| s.as_str()).collect();
            out.warnings.push(format!(
                "{} bone(s) aren't part of the hero's armature ({}{}) - fine for added cloth bones, otherwise remove them",
                extra.len(),
                shown.join(", "),
                if extra.len() > 6 { ", ..." } else { "" }
            ));
        }
    }
    if !bad_transform.is_empty() {
        out.errors.push(format!(
            "transforms not applied on: {} - in Blender select all, then Object > Apply > All Transforms",
            bad_transform.join(", ")
        ));
    }
    if !dot001.is_empty() {
        dot001.sort();
        dot001.dedup();
        out.warnings.push(format!(
            ".001-style numbered names are flaky in the tools: {} - if the build fails or a part misbehaves, rename them in Blender",
            dot001.join(", ")
        ));
    }
    if !spaced.is_empty() {
        spaced.sort();
        spaced.dedup();
        out.warnings.push(format!(
            "material names with spaces: {} - fine with My Textures mode, but rename them (use _) if a part won't texture",
            spaced.join(", ")
        ));
    }
    if has_vertex_colors {
        out.warnings.push(
            "the mesh carries vertex colors - without custom textures these can render the model BLACK. Use My Textures mode (it neutralizes them) or delete the Color Attributes in Blender's Object Data tab".into(),
        );
    }
    material_names.sort();
    out.materials = material_names;
    Ok(out)
}

// ---------------------------------------------------------------------------
// vmdl generation
// ---------------------------------------------------------------------------

/// Remove the ENTIRE first node of `class_name` (its enclosing `{ ... }` plus
/// a trailing comma/newline). Returns whether a node was removed.
fn remove_node(text: &mut String, class_name: &str) -> bool {
    let Some(anchor) = text.find(&format!("_class = \"{class_name}\"")) else {
        return false;
    };
    let Some(open) = text[..anchor].rfind('{') else { return false };
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    let mut end = None;
    for (i, &b) in bytes[open..].iter().enumerate() {
        match b {
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + i + 1);
                    break;
                }
            }
            _ => {}
        }
    }
    let Some(mut end) = end else { return false };
    // Swallow the trailing comma + line break so the list stays tidy.
    while end < text.len() && matches!(text.as_bytes()[end], b',' | b' ' | b'\t') {
        end += 1;
    }
    if end < text.len() && text.as_bytes()[end] == b'\n' {
        end += 1;
    }
    text.replace_range(open..end, "");
    true
}

/// Find the `children = [ ... ]` span (bracket-balanced) of the first node of
/// `class_name` at or after `from`. Returns (start_of_open_bracket, end_after_close).
fn children_span(text: &str, class_name: &str, from: usize) -> Option<(usize, usize)> {
    let anchor = text[from..].find(&format!("_class = \"{class_name}\""))? + from;
    let kids = text[anchor..].find("children")? + anchor;
    let open = text[kids..].find('[')? + kids;
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    for (i, &b) in bytes[open..].iter().enumerate() {
        match b {
            b'"' => in_str = !in_str,
            b'[' if !in_str => depth += 1,
            b']' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some((open, open + i + 1));
                }
            }
            _ => {}
        }
    }
    None
}

/// Rewrite a decompiled hero vmdl so its render meshes are the user's file:
/// - RenderMeshList children -> one RenderMeshFile ("body" -> mesh_rel)
/// - LODGroupList + BodyGroupList nodes REMOVED entirely (they referenced the
///   old meshes; a model with a bare RenderMeshList renders everything - the
///   proven static-swap shape)
/// - optional MaterialGroupList override (whole model uses one game material)
/// Everything else (skeleton, attachments, cameras, hitboxes, cloth, anim
/// lists, NmSkeleton/AnimGraph2 references) rides through untouched.
pub fn generate_vmdl(
    src: &str,
    mesh_rel: &str,
    material_override: Option<&str>,
    material_remaps: &[(String, String)],
    import_scale: f32,
) -> Result<String, String> {
    let mut text = src.to_string();

    let scale_line = if (import_scale - 1.0).abs() > 1e-6 {
        format!("\n\t\t\t\t\t\t\timport_scale = {import_scale}")
    } else {
        String::new()
    };
    let mesh_block = format!(
        "[\n\t\t\t\t\t\t{{\n\t\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\t\tname = \"body\"\n\t\t\t\t\t\t\tfilename = \"{mesh_rel}\"{scale_line}\n\t\t\t\t\t\t}},\n\t\t\t\t\t]"
    );
    let (a, b) = children_span(&text, "RenderMeshList", 0)
        .ok_or("vmdl has no RenderMeshList - refresh the hero kit")?;
    text.replace_range(a..b, &mesh_block);

    remove_node(&mut text, "LODGroupList");
    remove_node(&mut text, "BodyGroupList");

    // A DefaultMaterialGroup either forces ONE material over the whole model
    // (`material_override`) or remaps individual mesh material names onto
    // real game vmat paths (`material_remaps` - how kept kit meshes get
    // their vanilla materials back).
    let group_body = if let Some(vmat) = material_override {
        Some(format!(
            "remaps = [  ]\n\t\t\t\t\t\tuse_global_default = true\n\t\t\t\t\t\tglobal_default_material = \"{vmat}\""
        ))
    } else if !material_remaps.is_empty() {
        let entries: String = material_remaps
            .iter()
            .map(|(from, to)| {
                format!(
                    "\n\t\t\t\t\t\t\t{{\n\t\t\t\t\t\t\t\tfrom = \"{from}\"\n\t\t\t\t\t\t\t\tto = \"{to}\"\n\t\t\t\t\t\t\t}},"
                )
            })
            .collect();
        Some(format!(
            "remaps = \n\t\t\t\t\t\t[{entries}\n\t\t\t\t\t\t]\n\t\t\t\t\t\tuse_global_default = false"
        ))
    } else {
        None
    };
    if let Some(body) = group_body {
        // Insert a MaterialGroupList right before the RenderMeshList node's
        // enclosing block - proven pattern from the static model swaps.
        let group = format!(
            "{{\n\t\t\t\t_class = \"MaterialGroupList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{{\n\t\t\t\t\t\t_class = \"DefaultMaterialGroup\"\n\t\t\t\t\t\t{body}\n\t\t\t\t\t}},\n\t\t\t\t]\n\t\t\t}},\n\t\t\t"
        );
        let anchor = text
            .find("_class = \"RenderMeshList\"")
            .ok_or("vmdl lost its RenderMeshList")?;
        // Back up to the opening `{` of the RenderMeshList node.
        let open = text[..anchor].rfind('{').ok_or("malformed vmdl")?;
        text.insert_str(open, &group);
    }
    Ok(text)
}

// ---------------------------------------------------------------------------
// Attachment correction (the community's "fix the attachments" step)
// ---------------------------------------------------------------------------
//
// The decompiler's Attachment reconstruction is LOSSY: converting the
// compiled quaternion to Euler angles drops the yaw entirely on
// gimbal-locked attachments (e.g. root_aim, pitch -90: true angles are
// [-90, -90, 0], the decompile writes [-89.972, 0, 0]). The game hangs its
// aim/camera transforms off these attachments, which is exactly why every
// naive model swap ends up with a centered camera and the community fixes
// attachment values by hand in ModelDoc. We read the TRUE transforms from
// the vanilla compiled model's MDAT block and rewrite every Attachment
// node in the generated vmdl.

#[derive(Debug, Clone, PartialEq)]
pub struct VanillaAttachment {
    pub parent: String,
    pub origin: [f64; 3],
    /// Source QAngle degrees (pitch, yaw, roll), converted exactly.
    pub angles: [f64; 3],
    pub weight: f64,
    pub ignore_rotation: bool,
}

/// Quaternion -> Source QAngle (degrees), the exact MatrixAngles convention
/// (including the gimbal-locked branch) so ModelDoc's AngleQuaternion
/// round-trips back to the original quaternion.
pub fn quat_to_qangle(x: f64, y: f64, z: f64, w: f64) -> [f64; 3] {
    // Rotation matrix columns in Source layout: forward, left, up.
    let forward = [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + w * z),
        2.0 * (x * z - w * y),
    ];
    let left = [
        2.0 * (x * y - w * z),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + w * x),
    ];
    let up_z = 1.0 - 2.0 * (x * x + y * y);
    let xy_dist = (forward[0] * forward[0] + forward[1] * forward[1]).sqrt();
    let deg = 180.0 / std::f64::consts::PI;
    if xy_dist > 0.001 {
        [
            (-forward[2]).atan2(xy_dist) * deg,
            forward[1].atan2(forward[0]) * deg,
            left[2].atan2(up_z) * deg,
        ]
    } else {
        // Straight up/down: yaw carries the remaining rotation, roll is 0.
        [
            (-forward[2]).atan2(xy_dist) * deg,
            (-left[0]).atan2(left[1]) * deg,
            0.0,
        ]
    }
}

/// Parse the FIRST `m_attachments` list of a model's MDAT block text (the
/// per-mesh repeats are identical copies).
pub fn parse_mdat_attachments(text: &str) -> Vec<(String, VanillaAttachment)> {
    let mut out = Vec::new();
    let Some(list_at) = text.find("m_attachments =") else { return out };
    let Some(open_rel) = text[list_at..].find('[') else { return out };
    let start = list_at + open_rel + 1;
    let mut depth = 1i32;
    let mut end = text.len();
    for (i, c) in text[start..].char_indices() {
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    end = start + i;
                    break;
                }
            }
            _ => {}
        }
    }
    let span = &text[start..end];

    let quoted = |s: &str| -> Option<String> {
        let a = s.find('"')? + 1;
        let b = a + s[a..].find('"')?;
        Some(s[a..b].to_string())
    };
    let first_vec = |s: &str, key: &str, n: usize| -> Option<Vec<f64>> {
        let at = s.find(key)?;
        let a = at + s[at..].find('[')? + 1;
        // The value arrays are lists of vectors - take the first inner [ ... ].
        let a = a + s[a..].find('[')? + 1;
        let b = a + s[a..].find(']')?;
        let vals: Vec<f64> = s[a..b]
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        (vals.len() == n).then_some(vals)
    };
    let first_num_list = |s: &str, key: &str| -> Option<f64> {
        let at = s.find(key)?;
        let a = at + s[at..].find('[')? + 1;
        let b = a + s[a..].find(|c| c == ',' || c == ']')?;
        s[a..b].trim().parse().ok()
    };

    // Entries follow as `key = "name"` blocks.
    let mut rest = span;
    while let Some(k) = rest.find("key = \"") {
        let entry = &rest[k..];
        let next = entry[7..].find("key = \"").map(|i| i + 7).unwrap_or(entry.len());
        let entry_text = &entry[..next];
        rest = &entry[next..];
        let Some(name) = quoted(&entry_text[6..]) else { continue };
        let parent = entry_text
            .find("m_influenceNames")
            .and_then(|i| quoted(&entry_text[i..]))
            .unwrap_or_default();
        let Some(rot) = first_vec(entry_text, "m_vInfluenceRotations", 4) else { continue };
        let Some(off) = first_vec(entry_text, "m_vInfluenceOffsets", 3) else { continue };
        let weight = first_num_list(entry_text, "m_influenceWeights").unwrap_or(1.0);
        let ignore_rotation = entry_text
            .find("m_bIgnoreRotation")
            .map(|i| entry_text[i..].starts_with("m_bIgnoreRotation = true"))
            .unwrap_or(false);
        out.push((
            name,
            VanillaAttachment {
                parent,
                origin: [off[0], off[1], off[2]],
                angles: quat_to_qangle(rot[0], rot[1], rot[2], rot[3]),
                weight,
                ignore_rotation,
            },
        ));
    }
    out
}

/// Rewrite every `_class = "Attachment"` node whose name appears in the
/// vanilla map with the exact compiled transform. Returns the corrected
/// text and how many attachments were fixed.
pub fn correct_attachments(text: &str, vanilla: &[(String, VanillaAttachment)]) -> (String, usize) {
    let map: std::collections::HashMap<&str, &VanillaAttachment> =
        vanilla.iter().map(|(n, a)| (n.as_str(), a)).collect();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    let mut fixed = 0usize;
    while let Some(anchor) = rest.find("_class = \"Attachment\"") {
        // Node span: back up to the opening brace, balance forward.
        let Some(open) = rest[..anchor].rfind('{') else { break };
        let mut depth = 1i32;
        let mut close = rest.len();
        for (i, c) in rest[open + 1..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = open + 1 + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let node = &rest[open..=close.min(rest.len() - 1)];
        let name = node
            .find("name = \"")
            .and_then(|i| node[i + 8..].find('"').map(|j| &node[i + 8..i + 8 + j]));
        let rewritten = match name.and_then(|n| map.get(n)) {
            Some(v) => {
                fixed += 1;
                let fixed_node: String = node
                    .lines()
                    .map(|l| {
                        let t = l.trim_start();
                        let ind = &l[..l.len() - t.len()];
                        if t.starts_with("parent_bone = ") {
                            format!("{ind}parent_bone = \"{}\"", v.parent)
                        } else if t.starts_with("relative_origin = ") {
                            format!(
                                "{ind}relative_origin = [ {}, {}, {} ]",
                                v.origin[0], v.origin[1], v.origin[2]
                            )
                        } else if t.starts_with("relative_angles = ") {
                            format!(
                                "{ind}relative_angles = [ {}, {}, {} ]",
                                v.angles[0], v.angles[1], v.angles[2]
                            )
                        } else if t.starts_with("weight = ") {
                            format!("{ind}weight = {}", v.weight)
                        } else if t.starts_with("ignore_rotation = ") {
                            format!("{ind}ignore_rotation = {}", v.ignore_rotation)
                        } else {
                            l.to_string()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                fixed_node
            }
            None => node.to_string(),
        };
        out.push_str(&rest[..open]);
        out.push_str(&rewritten);
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    (out, fixed)
}

/// The workspace-cached vanilla attachment table (fetched from the compiled
/// model's MDAT at kit-prep time; tab-separated for easy round-tripping).
pub const ATTACHMENTS_CACHE: &str = "eim_attachments.tsv";

pub fn save_attachments_cache(dir: &Path, list: &[(String, VanillaAttachment)]) -> std::io::Result<()> {
    let mut s = String::new();
    for (n, a) in list {
        s.push_str(&format!(
            "{n}\t{}\t{} {} {}\t{} {} {}\t{}\t{}\n",
            a.parent,
            a.origin[0], a.origin[1], a.origin[2],
            a.angles[0], a.angles[1], a.angles[2],
            a.weight,
            a.ignore_rotation
        ));
    }
    std::fs::write(dir.join(ATTACHMENTS_CACHE), s)
}

pub fn load_attachments_cache(dir: &Path) -> Vec<(String, VanillaAttachment)> {
    let Ok(text) = std::fs::read_to_string(dir.join(ATTACHMENTS_CACHE)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() != 6 {
            continue;
        }
        let vec3 = |s: &str| -> Option<[f64; 3]> {
            let v: Vec<f64> = s.split(' ').filter_map(|x| x.parse().ok()).collect();
            (v.len() == 3).then(|| [v[0], v[1], v[2]])
        };
        let (Some(origin), Some(angles)) = (vec3(cols[2]), vec3(cols[3])) else { continue };
        out.push((
            cols[0].to_string(),
            VanillaAttachment {
                parent: cols[1].to_string(),
                origin,
                angles,
                weight: cols[4].parse().unwrap_or(1.0),
                ignore_rotation: cols[5] == "true",
            },
        ));
    }
    out
}

// ---------------------------------------------------------------------------
// Custom materials (user PNGs -> real pbr.vfx vmats via the Deadlock CSDK)
// ---------------------------------------------------------------------------
//
// The community recipe, proven by working mods (e.g. the Miku pak): keep the
// Blender material names in the vmdl (the compiled model then references
// `<name>.vmat` at the VPK ROOT) and ship a real compiled vmat_c at exactly
// that root path for each name. The vmats use Deadlock's generic `pbr.vfx`
// shader - which only the CSDK has (CS2's toolchain lacks it), so materials
// compile through the normal compile-tools root while the vmdl itself still
// compiles through CS2.

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialSpec {
    /// FBX material name, verbatim (case and spaces preserved).
    pub name: String,
    /// Absolute path of the basecolor image (png/jpg/tga). Required unless
    /// `game_vmat` maps this material to an existing game material instead.
    #[serde(default)]
    pub color: Option<String>,
    pub normal: Option<String>,
    pub roughness: Option<String>,
    pub metalness: Option<String>,
    /// Map this material to an EXISTING game vmat path instead of compiling
    /// one - the vmdl gets a material-group remap. This is how kit meshes
    /// kept from the decompile (SourceIO names them after the real vmats,
    /// e.g. `doorman_door`) get their vanilla look back.
    #[serde(default)]
    pub game_vmat: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialArtifact {
    /// VPK-internal path (matches what the compiled vmdl references).
    pub target_rel: String,
    /// Cached compiled file, absolute.
    pub artifact: String,
}

/// Compile one pbr.vfx vmat per spec in the CSDK's `eim_models` addon and cache
/// every produced file (vmat_c + generated vtex_c) under `out_cache`, keyed by
/// its VPK-internal path. The whole game-side addon tree is collected: child
/// texture compiles land at generated hashed names the vmat_c references.
fn compile_materials(
    tools_root: &Path,
    hero_stem: &str,
    specs: &[MaterialSpec],
    out_cache: &Path,
    rep: &mut ModelBuildReport,
) -> Result<Vec<MaterialArtifact>, String> {
    // The downloadable tools bundle ships the compiler under `bin_tools`; a
    // full CSDK install has it under `bin`.
    let rc = ["game/bin_tools/win64/resourcecompiler.exe", "game/bin/win64/resourcecompiler.exe"]
        .iter()
        .map(|r| tools_root.join(r))
        .find(|p| p.exists())
        .ok_or_else(|| {
            format!(
                "compile tools not found under {} - set up the compile tools in Settings first",
                tools_root.display()
            )
        })?;
    let content = tools_root.join("content/citadel_addons").join(CS2_ADDON);
    let game_out = tools_root.join("game/citadel_addons").join(CS2_ADDON);
    let _ = std::fs::remove_dir_all(&content);
    let _ = std::fs::remove_dir_all(&game_out);
    let tex_dir_rel = format!("materials/eim_models/{hero_stem}");
    let tex_dir = content.join(tex_dir_rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    std::fs::create_dir_all(&tex_dir).map_err(|e| e.to_string())?;

    // Vector fallbacks when a map wasn't provided: flat normal, matte
    // roughness, non-metal, no AO.
    const FLAT_NORMAL: &str = "[0.500000 0.500000 1.000000 0.000000]";
    const MATTE: &str = "[1.000000 1.000000 1.000000 1.000000]";
    const NON_METAL: &str = "[0.000000 0.000000 0.000000 0.000000]";
    const NO_AO: &str = "[1.000000 1.000000 1.000000 1.000000]";

    let mut inputs: Vec<String> = Vec::new();
    for spec in specs {
        let Some(color_src) = spec.color.as_deref() else { continue };
        let stage_tex = |src: &str| -> Result<String, String> {
            let mut name = Path::new(src)
                .file_name()
                .map(|f| f.to_string_lossy().to_lowercase())
                .ok_or_else(|| format!("texture has no file name: {src}"))?;
            let mut dest = tex_dir.join(&name);
            // Same filename from a different folder: salt with a path hash so
            // two materials' `color.png`s can't silently share one file.
            if dest.exists() && std::fs::metadata(&dest).map(|m| m.len()).ok()
                != std::fs::metadata(src).map(|m| m.len()).ok()
            {
                let mut h: u32 = 2166136261;
                for b in src.to_lowercase().bytes() {
                    h = (h ^ b as u32).wrapping_mul(16777619);
                }
                name = format!("{h:08x}_{name}");
                dest = tex_dir.join(&name);
            }
            if !dest.exists() {
                std::fs::copy(src, &dest).map_err(|e| format!("copy {src}: {e}"))?;
            }
            Ok(format!("{tex_dir_rel}/{name}"))
        };
        let color = stage_tex(color_src)?;
        let normal = match &spec.normal {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            None => format!("\"{FLAT_NORMAL}\""),
        };
        let rough = match &spec.roughness {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            None => format!("\"{MATTE}\""),
        };
        let metal = match &spec.metalness {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            None => format!("\"{NON_METAL}\""),
        };
        // Source 2 normalizes resource paths to lowercase - the compiled vmdl
        // references the lowercased material name, so the vmat file must match.
        // g_fVertexColorStrength 0 neutralizes baked vertex colors (a classic
        // cause of black models on FBX exports).
        let vmat = format!(
            "\"Layer0\"\n{{\n\t\"shader\"\t\"pbr.vfx\"\n\t\"F_RENDER_BACKFACES\"\t\"1\"\n\t\"F_USE_STATUS_EFFECTS_PROXY\"\t\"1\"\n\t\"g_fVertexColorStrength1\"\t\"0\"\n\t\"TextureColor1\"\t\"{color}\"\n\t\"TextureNormal1\"\t{normal}\n\t\"TextureRoughness1\"\t{rough}\n\t\"TextureMetalness1\"\t{metal}\n\t\"TextureAmbientOcclusion1\"\t\"{NO_AO}\"\n}}\n"
        );
        let vmat_name = format!("{}.vmat", spec.name.to_lowercase());
        let vmat_abs = content.join(&vmat_name);
        std::fs::write(&vmat_abs, vmat).map_err(|e| e.to_string())?;
        inputs.push(vmat_abs.to_string_lossy().into_owned());
    }

    if inputs.is_empty() {
        // Every spec maps to an existing game material - nothing to compile.
        return Ok(Vec::new());
    }
    let game_dir = tools_root.join("game/citadel").to_string_lossy().into_owned();
    let out = crate::compile::run_compiler_raw(&rc.to_string_lossy(), &game_dir, &inputs)
        .map_err(|e| format!("material compile: {e}"))?;
    rep.steps.push(format!("materials compiled: {out}"));

    // Collect EVERYTHING the compile produced - rel path below the game addon
    // root is the VPK-internal path.
    let mut arts: Vec<MaterialArtifact> = Vec::new();
    fn walk(root: &Path, dir: &Path, cache: &Path, arts: &mut Vec<MaterialArtifact>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, cache, arts);
            } else if let Ok(rel) = p.strip_prefix(root) {
                let rel_s = rel.to_string_lossy().replace('\\', "/");
                let dest = cache.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if std::fs::copy(&p, &dest).is_ok() {
                    arts.push(MaterialArtifact {
                        target_rel: rel_s,
                        artifact: dest.to_string_lossy().into_owned(),
                    });
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(out_cache);
    std::fs::create_dir_all(out_cache).map_err(|e| e.to_string())?;
    walk(&game_out, &game_out, out_cache, &mut arts);
    if !arts.iter().any(|a| a.target_rel.ends_with(".vmat_c")) {
        return Err("material compile produced no vmat_c files".into());
    }
    arts.sort_by(|a, b| a.target_rel.cmp(&b.target_rel));
    rep.steps.push(format!(
        "{} material file(s) cached ({} vmats)",
        arts.len(),
        arts.iter().filter(|a| a.target_rel.ends_with(".vmat_c")).count()
    ));
    Ok(arts)
}

/// ASCII `.vmat` references inside a compiled model - used to verify which
/// material names the artifact actually asks for (root-level bare names for
/// kept Blender materials, `models/...` paths for game materials).
pub fn scan_vmdl_material_refs(bytes: &[u8]) -> Vec<String> {
    let needle = b".vmat";
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while let Some(j) = bytes[i..].windows(needle.len()).position(|w| w == needle) {
        let end = i + j + needle.len();
        // A real reference is followed by a non-path byte (usually NUL) - a
        // `.vmat_c` run or a longer word means this wasn't the string's end.
        let tail_ok = bytes.get(end).map_or(true, |c| !c.is_ascii_alphanumeric() && *c != b'_');
        let mut start = i + j;
        while start > 0 {
            let c = bytes[start - 1];
            let ok = c.is_ascii_alphanumeric() || matches!(c, b'/' | b'\\' | b'_' | b'-' | b'.' | b' ');
            if !ok {
                break;
            }
            start -= 1;
        }
        if tail_ok {
            if let Ok(s) = std::str::from_utf8(&bytes[start..end]) {
                let s = s.trim_start().replace('\\', "/");
                if s.len() > ".vmat".len() && !out.iter().any(|o| *o == s) {
                    out.push(s);
                }
            }
        }
        i = end;
    }
    out.sort();
    out
}

/// Auto-match texture files in `folder` (recursive) to FBX material names.
/// Longest material name wins when several prefix-match the same file.
#[derive(serde::Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MatchedMaterial {
    pub name: String,
    pub color: Option<String>,
    pub normal: Option<String>,
    pub roughness: Option<String>,
    pub metalness: Option<String>,
}

pub fn match_textures(folder: &Path, materials: &[String]) -> Vec<MatchedMaterial> {
    let mut files: Vec<(String, String)> = Vec::new(); // (lowercased stem, abs path)
    fn walk(dir: &Path, depth: usize, files: &mut Vec<(String, String)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 3 {
                    walk(&p, depth + 1, files);
                }
                continue;
            }
            let name = p.file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
            // Accept png/jpg/jpeg/tga, tolerating a trailing `.001`-style copy
            // suffix after the extension.
            let trimmed = match name.rsplit_once('.') {
                Some((rest, tail)) if tail.chars().all(|c| c.is_ascii_digit()) => rest.to_string(),
                _ => name.clone(),
            };
            let ok = [".png", ".jpg", ".jpeg", ".tga"].iter().any(|x| trimmed.ends_with(x));
            if ok {
                let stem = trimmed.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(trimmed);
                files.push((stem, p.to_string_lossy().into_owned()));
            }
        }
    }
    walk(folder, 0, &mut files);
    files.sort();

    // Longest names first so "Body5F" beats "Body" for "body5f_base_color".
    let mut order: Vec<&String> = materials.iter().collect();
    order.sort_by_key(|m| std::cmp::Reverse(m.len()));
    let mut taken: std::collections::HashSet<usize> = std::collections::HashSet::new();
    let mut by_name: std::collections::HashMap<&str, MatchedMaterial> = materials
        .iter()
        .map(|m| {
            (m.as_str(), MatchedMaterial {
                name: m.clone(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
            })
        })
        .collect();

    for mat in order {
        // The FBX name, its space->underscore form, and its `.001`-stripped
        // form all count as the same prefix.
        let base = mat.to_lowercase();
        let un_numbered = match base.rsplit_once('.') {
            Some((rest, tail)) if tail.chars().all(|c| c.is_ascii_digit()) => rest.to_string(),
            _ => base.clone(),
        };
        let prefixes = [base.clone(), base.replace(' ', "_"), un_numbered.clone(), un_numbered.replace(' ', "_")];
        let entry = by_name.get_mut(mat.as_str()).unwrap();
        for (idx, (stem, path)) in files.iter().enumerate() {
            if taken.contains(&idx) {
                continue;
            }
            if !prefixes.iter().any(|p| stem.starts_with(p.as_str())) {
                continue;
            }
            let rest = &stem[prefixes.iter().filter(|p| stem.starts_with(p.as_str())).map(|p| p.len()).max().unwrap_or(0)..];
            let slot: &mut Option<String> = if rest.contains("normal") {
                &mut entry.normal
            } else if rest.contains("rough") {
                &mut entry.roughness
            } else if rest.contains("metal") {
                &mut entry.metalness
            } else if rest.contains("color") || rest.contains("albedo") || rest.contains("diffuse") || rest.is_empty() || rest.chars().all(|c| !c.is_ascii_alphanumeric()) {
                &mut entry.color
            } else {
                continue;
            };
            if slot.is_none() {
                *slot = Some(path.clone());
                taken.insert(idx);
            }
        }
    }
    materials
        .iter()
        .filter_map(|m| by_name.remove(m.as_str()))
        .collect()
}

// ---------------------------------------------------------------------------
// Build (CS2 stage + compile + artifact)
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelBuildReq {
    /// CS2 install root (the dir containing `game/` and `content/`).
    pub cs2_root: String,
    /// The hero workspace dir from `workspace`.
    pub workspace_dir: String,
    /// Internal vmdl path (no `_c`), e.g. `models/heroes_staging/haze/haze.vmdl`.
    pub vmdl_internal: String,
    /// The user's mesh file (fbx/dmx), absolute.
    pub mesh_file: String,
    /// Game material to apply to the whole model, or None to keep the mesh's
    /// own Blender material names.
    pub material_override: Option<String>,
    /// Mesh import scale. Blender's default FBX export is in centimeters
    /// (everything lands x100 in ModelDoc) - 0.01 corrects it. DMX exported
    /// via Blender Source 2 Tools with the community 39.37 convention is 1.0.
    #[serde(default = "default_import_scale")]
    pub import_scale: f32,
    /// Where the compiled artifact is cached (absolute .vmdl_c path).
    pub artifact_out: String,
    /// Custom texture sets - one real pbr.vfx vmat per FBX material name.
    /// Requires `tools_root` + `materials_out`; mutually exclusive with
    /// `material_override` (the tab enforces the mode).
    #[serde(default)]
    pub materials: Vec<MaterialSpec>,
    /// Deadlock compile-tools root (the CSDK - has pbr.vfx; CS2 doesn't).
    #[serde(default)]
    pub tools_root: Option<String>,
    /// Cache dir for compiled material files (vmat_c + vtex_c tree).
    #[serde(default)]
    pub materials_out: Option<String>,
    /// Gameplay-camera value overrides spliced into the generated vmdl's
    /// CitadelCameraSettings_t (the community's "fix the camera in ModelDoc"
    /// step, without ModelDoc).
    #[serde(default)]
    pub camera: Vec<CameraKey>,
}

fn default_import_scale() -> f32 {
    1.0
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelBuildReport {
    pub ok: bool,
    pub steps: Vec<String>,
    pub artifact: Option<String>,
    /// Compiled custom-material files to ship with the model (empty when no
    /// custom textures were requested).
    pub materials: Vec<MaterialArtifact>,
}

pub fn build(req: &ModelBuildReq) -> ModelBuildReport {
    let mut rep = ModelBuildReport::default();
    match build_inner(req, &mut rep) {
        Ok(artifact) => {
            rep.ok = true;
            rep.artifact = Some(artifact);
        }
        Err(e) => rep.steps.push(format!("FAILED: {e}")),
    }
    rep
}

/// Game-vmat material remaps (bare lowercased mesh material name -> path).
fn remap_pairs(req: &ModelBuildReq) -> Vec<(String, String)> {
    req.materials
        .iter()
        .filter_map(|s| {
            s.game_vmat
                .as_ref()
                .map(|v| (format!("{}.vmat", s.name.to_lowercase()), v.clone()))
        })
        .collect()
}

/// Stage the decompiled hero tree + the user's mesh into the CS2 content
/// addon and write the generated vmdl (mesh splice, remaps, camera edits).
/// Shared by the compile path and "Open in ModelDoc". Returns the staged
/// vmdl's absolute path plus human-readable step notes.
fn stage_into_cs2(req: &ModelBuildReq) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let cs2 = Path::new(&req.cs2_root);
    let vmdl_internal = req.vmdl_internal.replace('\\', "/");
    let vmdl_dir_internal = vmdl_internal.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut notes = Vec::new();

    // Fresh CS2 content stage: the whole decompiled tree (anims included -
    // the legacy AnimationList compiles from them) + the user's mesh.
    let content = cs2.join("content/csgo_addons").join(CS2_ADDON);
    let stage_dir = content.join(vmdl_dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let _ = std::fs::remove_dir_all(&stage_dir);
    copy_tree(Path::new(&req.workspace_dir), &content)?;
    notes.push(format!("staged hero sources into CS2 addon {CS2_ADDON}"));

    let mesh_name = Path::new(&req.mesh_file)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .ok_or("mesh file has no name")?;
    let mesh_dest = stage_dir.join(&mesh_name);
    std::fs::copy(&req.mesh_file, &mesh_dest)
        .map_err(|e| format!("copy mesh into CS2 addon: {e}"))?;
    notes.push(format!("mesh: {mesh_name}"));

    // Generate the vmdl over the staged copy. Materials mapped to game
    // vmats become DefaultMaterialGroup remaps (bare mesh name -> path).
    let remaps = remap_pairs(req);
    let vmdl_abs = content.join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let src = std::fs::read_to_string(&vmdl_abs).map_err(|e| e.to_string())?;
    let mesh_rel = format!("{vmdl_dir_internal}/{mesh_name}");
    let mut generated = generate_vmdl(
        &src,
        &mesh_rel,
        req.material_override.as_deref(),
        &remaps,
        req.import_scale,
    )?;
    // Restore the EXACT vanilla attachment transforms (decompiled ones are
    // lossy - the cause of the classic centered-camera-after-swap bug).
    let vanilla_atts = load_attachments_cache(Path::new(&req.workspace_dir));
    if vanilla_atts.is_empty() {
        notes.push("attachment data not cached - re-pick the hero once to refresh the kit".into());
    } else {
        let (corrected, fixed) = correct_attachments(&generated, &vanilla_atts);
        generated = corrected;
        notes.push(format!("{fixed} attachment(s) restored to exact vanilla transforms (aim/camera anchors)"));
    }
    if !req.camera.is_empty() {
        generated = apply_camera_overrides(&generated, &req.camera)?;
        notes.push(format!("camera: {} value(s) adjusted", req.camera.len()));
    }
    std::fs::write(&vmdl_abs, generated).map_err(|e| e.to_string())?;
    notes.push(format!(
        "generated vmdl (your mesh at scale {}, the hero's skeleton, cameras and animation refs)",
        req.import_scale
    ));
    Ok((vmdl_abs, notes))
}

/// Stage everything exactly as a build would, then open the result in CS2's
/// ModelDoc so the model (weights, skeleton, camera) can be inspected by
/// hand. Same launch pattern as the particle-editor inspector.
pub fn open_in_modeldoc(req: &ModelBuildReq) -> Result<String, String> {
    let cs2 = Path::new(&req.cs2_root);
    let (_, _notes) = stage_into_cs2(req)?;
    let vmdl_internal = req.vmdl_internal.replace('\\', "/");
    let exe = cs2.join("game/bin/win64/cs2.exe");
    if !exe.exists() {
        return Err(format!("CS2 not found at {}", exe.display()));
    }
    let mut cmd = std::process::Command::new(&exe);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.args(["-steam", "-tools", "-addon", CS2_ADDON, "-asset", &vmdl_internal]);
    // Fire and forget - the tools outlive us.
    cmd.spawn().map_err(|e| format!("launching CS2 Workshop Tools: {e}"))?;
    Ok(format!(
        "staged your model into the {CS2_ADDON} addon - CS2's ModelDoc is opening (first launch takes a minute)"
    ))
}

fn build_inner(req: &ModelBuildReq, rep: &mut ModelBuildReport) -> Result<String, String> {
    let cs2 = Path::new(&req.cs2_root);
    let compiler = cs2.join("game/bin/win64/resourcecompiler.exe");
    if !compiler.exists() {
        return Err(format!(
            "CS2 Workshop Tools compiler not found at {} - install Counter-Strike 2 and check the Workshop Tools box in its Steam install options",
            compiler.display()
        ));
    }
    let vmdl_internal = req.vmdl_internal.replace('\\', "/");
    let hero_stem = vmdl_internal
        .rsplit('/')
        .next()
        .unwrap_or("model")
        .trim_end_matches(".vmdl")
        .to_string();

    // 0. Custom materials first (fail fast - they compile in ~1s via the
    //    Deadlock CSDK, the model itself takes ~10s via CS2). Specs that only
    //    map onto existing game vmats need no compile at all.
    if !req.materials.is_empty() {
        if req.material_override.is_some() {
            return Err("custom textures and a game material override can't be combined - pick one".into());
        }
        if req.materials.iter().any(|s| s.color.is_some()) {
            let tools = req
                .tools_root
                .as_deref()
                .ok_or("custom textures need the Deadlock compile tools - set them up in Settings")?;
            let out_cache = req
                .materials_out
                .as_deref()
                .ok_or("internal: materials_out not set")?;
            rep.materials = compile_materials(
                Path::new(tools),
                &hero_stem,
                &req.materials,
                Path::new(out_cache),
                rep,
            )?;
        }
    }

    // 1+2. Shared with "Open in ModelDoc": stage the tree + generate the vmdl.
    let (vmdl_abs, notes) = stage_into_cs2(req)?;
    rep.steps.extend(notes);
    let content = cs2.join("content/csgo_addons").join(CS2_ADDON);
    let remaps = remap_pairs(req);

    // 3. Compile, auto-stubbing missing materials (they live in Deadlock's
    //    pak, not CS2's content - stubs satisfy the compiler and leave no
    //    trace in the artifact, which records the real paths).
    let mut last_out = String::new();
    for round in 1..=4 {
        let out = run_cs2_compiler(cs2, &compiler, &vmdl_abs)?;
        // Success summary reads "OK: 1 compiled, 0 failed" - or "WARNING: 1
        // compiled, 0 failed" when benign warnings fired (unresolved bare FBX
        // material names warn but compile fine).
        if out.lines().any(|l| {
            let l = l.trim();
            (l.starts_with("OK:") || l.starts_with("WARNING:")) && l.contains(" compiled, 0 failed")
        }) {
            rep.steps.push(format!("compiled (round {round})"));
            last_out.clear();
            break;
        }
        last_out = out.clone();
        let mut missing: Vec<String> = out
            .lines()
            .filter_map(|l| {
                let i = l.find("referencing missing material '")?;
                let rest = &l[i + 30..];
                rest.find('\'').map(|j| rest[..j].to_string())
            })
            .collect();
        // NOTE: "GetFbxMaterialPath Failed" lines are WARNINGS (bare Blender
        // material names) - the compile succeeds despite them, and a material
        // override group papers over the visuals. Only DMX-side "missing
        // material '<path>'" is a hard error worth stubbing.
        missing.sort();
        missing.dedup();
        if missing.is_empty() {
            let errs: Vec<&str> = out
                .lines()
                .filter(|l| l.contains("RESOURCE COMPILE ERROR") || l.contains("Failed"))
                .take(6)
                .collect();
            return Err(if errs.is_empty() {
                format!("compile failed:\n{}", tail(&out, 12))
            } else {
                format!("compile failed:\n{}", errs.join("\n"))
            });
        }
        for m in &missing {
            let dest = content.join(m.replace('/', std::path::MAIN_SEPARATOR_STR));
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&dest, "Layer0\n{\n\tshader \"csgo_unlitgeneric.vfx\"\n}\n");
        }
        rep.steps.push(format!("round {round}: stubbed {} material(s)", missing.len()));
    }
    if !last_out.is_empty() {
        return Err(format!("compile did not converge:\n{}", tail(&last_out, 12)));
    }

    // 4. Cache the artifact.
    let compiled = cs2
        .join("game/csgo_addons")
        .join(CS2_ADDON)
        .join(format!("{vmdl_internal}_c").replace('/', std::path::MAIN_SEPARATOR_STR));
    if !compiled.exists() {
        return Err(format!("compiler reported OK but no artifact at {}", compiled.display()));
    }
    if let Some(parent) = Path::new(&req.artifact_out).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::copy(&compiled, &req.artifact_out).map_err(|e| e.to_string())?;
    let size = std::fs::metadata(&req.artifact_out).map(|m| m.len()).unwrap_or(0);
    rep.steps.push(format!("artifact cached ({} KB)", size / 1024));

    // 5. Verify material coverage: which vmats does the artifact actually
    //    reference, and does each have a shipped file (custom vmat), a game
    //    remap, or a real game path?
    if let Ok(bytes) = std::fs::read(&req.artifact_out) {
        let refs = scan_vmdl_material_refs(&bytes);
        // A bare name that's a suffix of a pathed ref is a scan artifact of
        // adjacent string encoding (e.g. `_backpack.vmat` inside
        // `.../haze_backpack.vmat`), not a real material.
        let bare: Vec<&String> = refs
            .iter()
            .filter(|r| !r.contains('/'))
            .filter(|r| !refs.iter().any(|p| p.contains('/') && p.ends_with(r.as_str())))
            .collect();
        if !bare.is_empty() {
            let mut covered_names: std::collections::HashSet<String> = rep
                .materials
                .iter()
                .filter(|a| a.target_rel.ends_with(".vmat_c"))
                .map(|a| a.target_rel.trim_end_matches("_c").to_string())
                .collect();
            for (from, _) in &remaps {
                covered_names.insert(from.clone());
            }
            let missing: Vec<&str> = bare
                .iter()
                .filter(|r| !covered_names.contains(r.as_str()))
                .map(|r| r.as_str())
                .collect();
            let covered = bare.len() - missing.len();
            if covered > 0 {
                rep.steps.push(format!("{covered} of {} model material(s) covered", bare.len()));
            }
            if !missing.is_empty() {
                rep.steps.push(format!(
                    "WARNING: no textures assigned for {} - those parts will be invisible or untextured in game",
                    missing.join(", ")
                ));
            }
        }
    }
    Ok(req.artifact_out.clone())
}

fn tail(s: &str, n: usize) -> String {
    let lines: Vec<&str> = s.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

fn run_cs2_compiler(cs2: &Path, compiler: &Path, vmdl: &Path) -> Result<String, String> {
    let game = cs2.join("game/csgo").to_string_lossy().into_owned();
    let input = vmdl.to_string_lossy().into_owned();
    let mut cmd = crate::procutil::quiet(compiler);
    if let Some(dir) = compiler.parent() {
        cmd.current_dir(dir);
    }
    cmd.args(["-i", &input, "-game", &game, "-f", "-danger_mode_ignore_schema_mismatches"]);
    let out = cmd
        .output()
        .map_err(|e| format!("launch CS2 resourcecompiler: {e}"))?;
    // Full output regardless of exit code - the stub loop parses failures.
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    ))
}

fn copy_tree(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("{}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const MINI_VMDL: &str = r#"<!-- kv3 -->
{
	rootNode =
	{
		_class = "RootNode"
		children =
		[
			{
				_class = "Skeleton"
				children =
				[
					{
						_class = "Bone"
						name = "pelvis"
					},
					{
						_class = "Bone"
						name = "spine_1"
					},
				]
			},
			{
				_class = "RenderMeshList"
				children =
				[
					{
						_class = "RenderMeshFile"
						name = "body"
						filename = "models/x/x_body.dmx"
					},
					{
						_class = "RenderMeshFile"
						name = "gun"
						filename = "models/x/x_gun.dmx"
					},
				]
			},
			{
				_class = "LODGroupList"
				children =
				[
					{
						_class = "LODGroup"
						switch_threshold = 0.0
						mesh_references =
						[
							{
								mesh_name = "body"
							},
							{
								mesh_name = "gun"
							},
						]
					},
				]
			},
			{
				_class = "BodyGroupList"
				children =
				[
					{
						_class = "BodyGroup"
						name = "guns"
					},
				]
			},
		]
	}
}
"#;

    #[test]
    fn bones_and_materials_parse() {
        let bones = parse_bone_names(MINI_VMDL);
        assert_eq!(bones, vec!["pelvis".to_string(), "spine_1".to_string()]);
        // Binary-ish DMX bytes: a vanilla path, a slashless stub, a duplicate.
        let dir = std::env::temp_dir().join(format!("eim_matscan_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("mesh.dmx"),
            b"\x00\x01models/a/b.vmat\x00junk\xffstub.vmat\x00models/a/b.vmat\x00".to_vec(),
        )
        .unwrap();
        let mats = scan_material_refs(&dir);
        assert_eq!(mats, vec!["models/a/b.vmat".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn generate_replaces_meshes_lods_and_bodygroups() {
        let out =
            generate_vmdl(MINI_VMDL, "models/x/custom.fbx", Some("models/a/b.vmat"), &[], 0.01).unwrap();
        assert!(out.contains("import_scale = 0.01"), "scale line present");
        assert!(out.contains("custom.fbx"), "user mesh referenced");
        assert!(!out.contains("x_gun.dmx"), "old meshes gone");
        // LOD and bodygroup nodes are REMOVED wholesale (the proven shape).
        assert!(!out.contains("LODGroupList"), "{out}");
        assert!(!out.contains("BodyGroupList"), "{out}");
        assert!(out.contains("global_default_material = \"models/a/b.vmat\""));
        // Skeleton untouched.
        assert!(out.contains("name = \"pelvis\""));
        // Still balanced kv3-ish (same brace count parity).
        assert_eq!(out.matches('[').count(), out.matches(']').count());
        assert_eq!(out.matches('{').count(), out.matches('}').count());
    }

    #[test]
    fn generate_without_material_override_keeps_materials_out() {
        let out = generate_vmdl(MINI_VMDL, "m.fbx", None, &[], 1.0).unwrap();
        assert!(!out.contains("MaterialGroupList"));
        assert!(!out.contains("import_scale"), "scale 1.0 emits no line");
    }

    #[test]
    fn quat_to_qangle_handles_gimbal_lock_exactly() {
        // root_aim's real transform: the decompiler writes [-89.972, 0, 0]
        // for this, silently dropping the -90 yaw - the centered-camera bug.
        let a = quat_to_qangle(-0.5, -0.5, -0.5, 0.5);
        assert!((a[0] + 90.0).abs() < 1e-9, "{a:?}");
        assert!((a[1] + 90.0).abs() < 1e-9, "{a:?}");
        assert!(a[2].abs() < 1e-9, "{a:?}");
        let id = quat_to_qangle(0.0, 0.0, 0.0, 1.0);
        assert!(id.iter().all(|v| v.abs() < 1e-9), "{id:?}");
    }

    const MDAT_SNIPPET: &str = r#"
	m_attachments =
	[
		{
			key = "root_aim"
			value =
			{
				m_name = "root_aim"
				m_influenceNames =
				[
					"root_motion",
					"",
					"",
				]
				m_vInfluenceRotations =
				[
					[ -0.5, -0.5, -0.5, 0.5 ],
					[ 0.0, 0.0, 0.0, 1.0 ],
					[ 0.0, 0.0, 0.0, 1.0 ],
				]
				m_vInfluenceOffsets =
				[
					[ 0.000015, 83.999977, 0.0 ],
					[ 0.0, 0.0, 0.0 ],
					[ 0.0, 0.0, 0.0 ],
				]
				m_influenceWeights = [ 1.0, 0.0, 0.0 ]
				m_bInfluenceRootTransform = [ false, false, false ]
				m_nInfluences = 1
				m_bIgnoreRotation = false
			}
		},
		{
			key = "muzzle"
			value =
			{
				m_name = "muzzle"
				m_influenceNames =
				[
					"hand_R",
					"",
					"",
				]
				m_vInfluenceRotations =
				[
					[ 0.0, 0.0, 0.0, 1.0 ],
					[ 0.0, 0.0, 0.0, 1.0 ],
					[ 0.0, 0.0, 0.0, 1.0 ],
				]
				m_vInfluenceOffsets =
				[
					[ 1.5, 2.5, 3.5 ],
					[ 0.0, 0.0, 0.0 ],
					[ 0.0, 0.0, 0.0 ],
				]
				m_influenceWeights = [ 0.75, 0.0, 0.0 ]
				m_bInfluenceRootTransform = [ false, false, false ]
				m_nInfluences = 1
				m_bIgnoreRotation = true
			}
		},
	]
	m_other = 1
"#;

    #[test]
    fn mdat_attachments_parse() {
        let atts = parse_mdat_attachments(MDAT_SNIPPET);
        assert_eq!(atts.len(), 2, "{atts:?}");
        let (n0, a0) = &atts[0];
        assert_eq!(n0, "root_aim");
        assert_eq!(a0.parent, "root_motion");
        assert_eq!(a0.origin, [0.000015, 83.999977, 0.0]);
        assert!((a0.angles[0] + 90.0).abs() < 1e-9 && (a0.angles[1] + 90.0).abs() < 1e-9);
        assert!(!a0.ignore_rotation);
        let (n1, a1) = &atts[1];
        assert_eq!(n1, "muzzle");
        assert_eq!(a1.parent, "hand_R");
        assert_eq!(a1.weight, 0.75);
        assert!(a1.ignore_rotation);
    }

    #[test]
    fn attachments_correct_the_vmdl_nodes() {
        let vmdl = "{\n\tchildren =\n\t[\n\t\t{\n\t\t\t_class = \"Attachment\"\n\t\t\tname = \"root_aim\"\n\t\t\tignore_rotation = false\n\t\t\tparent_bone = \"root_motion\"\n\t\t\trelative_origin = [ 0.000015, 83.999977, 0.0 ]\n\t\t\trelative_angles = [ -89.972015, 0.0, 0.0 ]\n\t\t\tweight = 1.0\n\t\t},\n\t\t{\n\t\t\t_class = \"Attachment\"\n\t\t\tname = \"unknown_att\"\n\t\t\trelative_angles = [ 1.0, 2.0, 3.0 ]\n\t\t},\n\t]\n}\n";
        let atts = parse_mdat_attachments(MDAT_SNIPPET);
        let (out, fixed) = correct_attachments(vmdl, &atts);
        assert_eq!(fixed, 1);
        assert!(out.contains("relative_angles = [ -90, -90, 0 ]"), "{out}");
        assert!(!out.contains("-89.972015"), "{out}");
        // Unknown attachments and everything else stay untouched.
        assert!(out.contains("relative_angles = [ 1.0, 2.0, 3.0 ]"));
        assert_eq!(out.matches('{').count(), out.matches('}').count());
    }

    #[test]
    fn attachments_cache_round_trips() {
        let dir = std::env::temp_dir().join("eim_att_cache_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let atts = parse_mdat_attachments(MDAT_SNIPPET);
        save_attachments_cache(&dir, &atts).unwrap();
        let loaded = load_attachments_cache(&dir);
        assert_eq!(atts, loaded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    const CAM_VMDL: &str ="{\n\trootNode =\n\t{\n\t\t_class = \"RootNode\"\n\t\tchildren =\n\t\t[\n\t\t\t{\n\t\t\t\t_class = \"GameDataList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\t_class = \"GenericGameData\"\n\t\t\t\t\t\tgame_class = \"CitadelCameraSettings_t\"\n\t\t\t\t\t\tgame_keys = \n\t\t\t\t\t\t{\n\t\t\t\t\t\t\tm_flCameraSideOffset = -39.9\n\t\t\t\t\t\t\tm_flCameraBackOffset = 102.9\n\t\t\t\t\t\t\tm_vCameraParrotOffset = [ -10.0, -10.0, 10.0 ]\n\t\t\t\t\t\t}\n\t\t\t\t\t},\n\t\t\t\t]\n\t\t\t},\n\t\t]\n\t}\n}\n";

    #[test]
    fn camera_keys_parse_scalars_only() {
        let keys = parse_camera_keys(CAM_VMDL);
        assert_eq!(keys.len(), 2, "{keys:?}");
        assert_eq!(keys[0].key, "m_flCameraSideOffset");
        assert_eq!(keys[0].value, -39.9);
        assert_eq!(keys[1].key, "m_flCameraBackOffset");
    }

    #[test]
    fn camera_overrides_replace_and_append() {
        let out = apply_camera_overrides(
            CAM_VMDL,
            &[
                CameraKey { key: "m_flCameraSideOffset".into(), value: 0.0 },
                CameraKey { key: "m_flCameraHeightStanding".into(), value: 77.5 },
            ],
        )
        .unwrap();
        assert!(out.contains("m_flCameraSideOffset = 0"), "{out}");
        assert!(!out.contains("-39.9"), "{out}");
        assert!(out.contains("m_flCameraBackOffset = 102.9"), "untouched key survives");
        assert!(out.contains("m_flCameraHeightStanding = 77.5"), "missing key appended: {out}");
        assert!(out.contains("m_vCameraParrotOffset = [ -10.0, -10.0, 10.0 ]"), "vector untouched");
        // Structure stays balanced.
        assert_eq!(out.matches('{').count(), out.matches('}').count());
        // The appended key landed INSIDE the game_keys block.
        let (a, b) = camera_keys_span(&out).unwrap();
        assert!(out[a..b].contains("m_flCameraHeightStanding"), "{}", &out[a..b]);
    }

    #[test]
    fn camera_overrides_noop_without_entries() {
        assert_eq!(apply_camera_overrides(CAM_VMDL, &[]).unwrap(), CAM_VMDL);
    }

    /// The real doorman kit vmdl parses to the full scalar camera set.
    #[test]
    fn camera_keys_parse_real_doorman_kit_if_present() {
        let p = Path::new(r"C:\Users\ethob\AppData\Roaming\com.digiphoenix.deadlock-intro-tool\model_swap\doorman\models\heroes_wip\doorman_v2\doorman.vmdl");
        if !p.exists() {
            return;
        }
        let keys = parse_camera_keys(&std::fs::read_to_string(p).unwrap());
        assert!(keys.iter().any(|k| k.key == "m_flCameraSideOffset" && k.value == -39.9), "{keys:?}");
        assert!(keys.len() >= 7, "{keys:?}");
    }

    #[test]
    fn generate_with_remaps_emits_material_group() {
        let remaps = vec![
            ("doorman_door.vmat".to_string(), "models/heroes_wip/doorman/materials/doorman_door.vmat".to_string()),
            ("eyes.vmat".to_string(), "models/x/eyes.vmat".to_string()),
        ];
        let out = generate_vmdl(MINI_VMDL, "m.fbx", None, &remaps, 1.0).unwrap();
        assert!(out.contains("DefaultMaterialGroup"), "{out}");
        assert!(out.contains("from = \"doorman_door.vmat\""), "{out}");
        assert!(out.contains("to = \"models/heroes_wip/doorman/materials/doorman_door.vmat\""));
        assert!(out.contains("use_global_default = false"));
        assert!(!out.contains("global_default_material"));
        assert_eq!(out.matches('[').count(), out.matches(']').count());
        assert_eq!(out.matches('{').count(), out.matches('}').count());
    }

    /// Full pipeline against the real local game + CS2 Workshop Tools:
    /// decompile a hero via the helper, generate the vmdl around a real FBX,
    /// compile with CS2's resourcecompiler (auto-stub loop), cache artifact.
    /// Ignored: needs this machine's game installs.
    #[test]
    #[ignore]
    fn e2e_model_build_via_cs2() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let fbx = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx");
        let scratch = std::env::temp_dir().join("eim_model_e2e");
        let _ = std::fs::remove_dir_all(&scratch);

        let ws = workspace(
            helper,
            pak,
            "models/heroes_staging/haze/haze.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        assert!(ws.bones.len() > 50, "haze has a real skeleton: {}", ws.bones.len());
        assert!(!ws.materials.is_empty());

        // The cube's material maps onto a REAL haze vmat via a
        // DefaultMaterialGroup remap - the compiled artifact must reference
        // the game path (proves the remap syntax the compiler accepts).
        let game_vmat = ws.materials.first().cloned().expect("haze has materials");
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_staging/haze/haze.vmdl".into(),
            mesh_file: fbx.into(),
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("haze.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![MaterialSpec {
                name: "eim_test".into(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
                game_vmat: Some(game_vmat.clone()),
            }],
            tools_root: None,
            materials_out: None,
            // A distinctive camera edit - keyvalues embed as TEXT in the
            // artifact, so the exact string must survive the compile.
            camera: vec![CameraKey { key: "m_flCameraSideOffset".into(), value: -12.25 }],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);
        assert!(std::path::Path::new(&req.artifact_out).exists());
        let bytes = std::fs::read(&req.artifact_out).unwrap();
        let refs = scan_vmdl_material_refs(&bytes);
        eprintln!("REFS {refs:?}");
        assert!(
            refs.iter().any(|r| r == &game_vmat),
            "remap target must appear in the artifact: {refs:?}"
        );
        // Keyvalues compile to BINARY kv3 - decode the DATA block to verify
        // the camera override rode through (S2V CLI, machine-local like the
        // rest of this test's paths).
        let s2v = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\_s2vcli\Source2Viewer-CLI.exe");
        if s2v.exists() {
            let out = std::process::Command::new(s2v)
                .args(["-i", &req.artifact_out, "-b", "DATA"])
                .output()
                .expect("run S2V");
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(
                text.contains("m_flCameraSideOffset = -12.25"),
                "camera override must ride into the artifact's keyvalues"
            );

            // Attachment correction: every attachment in OUR artifact must
            // carry the vanilla compiled transform (the decompiled values
            // are lossy - root_aim is the famous centered-camera case).
            let vanilla_mdat = crate::vpk::model_block_from_vpk(
                helper,
                pak,
                "models/heroes_staging/haze/haze.vmdl_c",
                "MDAT",
            )
            .expect("vanilla MDAT");
            let ours_mdat = std::process::Command::new(s2v)
                .args(["-i", &req.artifact_out, "-b", "MDAT"])
                .output()
                .expect("run S2V for MDAT");
            let ours_mdat = String::from_utf8_lossy(&ours_mdat.stdout).into_owned();
            let vanilla_atts = parse_mdat_attachments(&vanilla_mdat);
            let our_atts: std::collections::HashMap<String, VanillaAttachment> =
                parse_mdat_attachments(&ours_mdat).into_iter().collect();
            assert!(!vanilla_atts.is_empty() && !our_atts.is_empty());
            let mut checked = 0;
            for (name, v) in &vanilla_atts {
                let Some(o) = our_atts.get(name) else { continue };
                checked += 1;
                for i in 0..3 {
                    assert!(
                        (v.origin[i] - o.origin[i]).abs() < 0.01,
                        "{name} origin[{i}]: vanilla {} vs ours {}",
                        v.origin[i],
                        o.origin[i]
                    );
                    assert!(
                        (v.angles[i] - o.angles[i]).abs() < 0.05,
                        "{name} angles[{i}]: vanilla {} vs ours {}",
                        v.angles[i],
                        o.angles[i]
                    );
                }
            }
            eprintln!("ATTACHMENTS VERIFIED {checked}/{}", vanilla_atts.len());
            assert!(
                vanilla_atts.iter().any(|(n, _)| n == "root_aim"),
                "haze must have root_aim"
            );
            assert!(our_atts.contains_key("root_aim"), "our artifact must keep root_aim");
            assert!(checked >= vanilla_atts.len() / 2, "most attachments must survive");
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The committed rigged-cube fixture must preflight CLEAN against an
    /// armature containing its one bone.
    #[test]
    fn preflight_passes_the_test_cube() {
        let p = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx"));
        let rep = preflight_fbx(p, &["pelvis".into(), "spine_1".into()]).unwrap();
        assert!(rep.errors.is_empty(), "{rep:?}");
        assert!(rep.info.iter().any(|i| i.contains("1 mesh")), "{rep:?}");
        assert!(rep.info.iter().any(|i| i.contains("1 of 2 hero bones")), "{rep:?}");
    }

    /// The cube fixture's material name must surface for the My Textures UI.
    #[test]
    fn preflight_lists_fbx_materials() {
        let p = Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx"));
        let rep = preflight_fbx(p, &["pelvis".into()]).unwrap();
        assert_eq!(rep.materials, vec!["eim_test".to_string()], "{rep:?}");
    }

    #[test]
    fn match_textures_by_prefix_longest_name_wins() {
        let dir = std::env::temp_dir().join("eim_match_tex_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for f in [
            "Body_Base_color.png",
            "Body_Normal.png",
            "Body5F_Base_color.png",
            "Body5F_Roughness.png",
            "Ace Of Spades_back_Metalness.png",
            "Ace Of Spades_back_Base_color.png",
            "unrelated.txt",
        ] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        let mats = vec![
            "Body".to_string(),
            "Body5F".to_string(),
            "Ace Of Spades_back".to_string(),
            "NoTextures".to_string(),
        ];
        let out = match_textures(&dir, &mats);
        let get = |n: &str| out.iter().find(|m| m.name == n).unwrap();
        // Longest prefix wins: Body5F files never leak into Body.
        assert!(get("Body").color.as_deref().unwrap().ends_with("Body_Base_color.png"));
        assert!(get("Body").normal.as_deref().unwrap().ends_with("Body_Normal.png"));
        assert!(get("Body5F").color.as_deref().unwrap().ends_with("Body5F_Base_color.png"));
        assert!(get("Body5F").roughness.is_some());
        assert!(get("Ace Of Spades_back").color.is_some());
        assert!(get("Ace Of Spades_back").metalness.is_some());
        assert!(get("NoTextures").color.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_vmdl_refs_finds_bare_and_pathed_materials() {
        let mut bytes = b"junk\x00eim_test.vmat\x00more\x00models/heroes/haze/materials/haze_body.vmat\x00".to_vec();
        bytes.extend_from_slice(b"x.vmat_c\x00"); // compiled ref, not a source ref
        let refs = scan_vmdl_material_refs(&bytes);
        assert!(refs.contains(&"eim_test.vmat".to_string()), "{refs:?}");
        assert!(refs.contains(&"models/heroes/haze/materials/haze_body.vmat".to_string()));
        assert!(!refs.iter().any(|r| r.contains(".vmat_c")), "{refs:?}");
    }

    /// Custom materials end to end against the real local CSDK: two specs
    /// (one full PBR set, one color-only) compile into vmat_c + vtex_c files
    /// cached with VPK-ready rel paths. Ignored: needs this machine's tools.
    #[test]
    #[ignore]
    fn e2e_custom_materials_via_csdk() {
        let tools = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12");
        let png = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png");
        let out_cache = std::env::temp_dir().join("eim_mats_e2e");
        let _ = std::fs::remove_dir_all(&out_cache);
        let specs = vec![
            MaterialSpec {
                name: "eim_test".into(),
                color: Some(png.into()),
                normal: Some(png.into()),
                roughness: Some(png.into()),
                metalness: None,
                game_vmat: None,
            },
            MaterialSpec {
                name: "Ace Of Spades_back".into(),
                color: Some(png.into()),
                normal: None,
                roughness: None,
                metalness: None,
                game_vmat: None,
            },
        ];
        let mut rep = ModelBuildReport::default();
        let arts = compile_materials(tools, "haze", &specs, &out_cache, &mut rep).expect("compile");
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        for a in &arts {
            eprintln!("ART {} <- {}", a.target_rel, a.artifact);
        }
        // Root-level vmat_c per spec, lowercased, spaces preserved.
        assert!(arts.iter().any(|a| a.target_rel == "eim_test.vmat_c"));
        assert!(arts.iter().any(|a| a.target_rel == "ace of spades_back.vmat_c"));
        // The color texture compiled somewhere under materials/.
        assert!(arts.iter().any(|a| a.target_rel.starts_with("materials/") && a.target_rel.ends_with(".vtex_c")));
        assert!(arts.iter().all(|a| Path::new(&a.artifact).exists()));
        let _ = std::fs::remove_dir_all(&out_cache);
    }

    /// The whole My Textures pipeline against the user's REAL sona-doorman
    /// FBX: decompile doorman, preflight lists its materials, every material
    /// gets a stand-in color texture, model compiles via CS2 + materials via
    /// CSDK, and the artifact's bare vmat refs are fully covered by the
    /// shipped vmat_c set. Ignored: needs this machine's installs + the FBX.
    #[test]
    #[ignore]
    fn e2e_doorman_v4_full_build() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let tools = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let fbx = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\ReferenceFiles\deadlock_moonah_doormanv4Test.fbx";
        if !Path::new(fbx).exists() {
            eprintln!("skipping: user FBX not present");
            return;
        }
        let png = concat!(env!("CARGO_MANIFEST_DIR"), "/icons/icon.png");
        let scratch = std::env::temp_dir().join("eim_doorman_e2e");
        let _ = std::fs::remove_dir_all(&scratch);

        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        let pf = preflight_fbx(Path::new(fbx), &ws.bones).expect("preflight");
        eprintln!("MATERIALS {:?}", pf.materials);
        assert!(!pf.materials.is_empty(), "the sona FBX has materials");

        // Kit materials (SourceIO names them after the real vmats) map back
        // to the game paths; the sona's own materials get stand-in textures.
        let specs: Vec<MaterialSpec> = pf
            .materials
            .iter()
            .map(|m| {
                let stem = m.to_lowercase();
                let game = ws
                    .materials
                    .iter()
                    .find(|p| p.rsplit('/').next().map(|f| f.trim_end_matches(".vmat")) == Some(stem.as_str()));
                match game {
                    Some(path) => MaterialSpec {
                        name: m.clone(),
                        color: None,
                        normal: None,
                        roughness: None,
                        metalness: None,
                        game_vmat: Some(path.clone()),
                    },
                    None => MaterialSpec {
                        name: m.clone(),
                        color: Some(png.into()),
                        normal: None,
                        roughness: None,
                        metalness: None,
                        game_vmat: None,
                    },
                }
            })
            .collect();
        let remapped = specs.iter().filter(|s| s.game_vmat.is_some()).count();
        eprintln!("SPECS {} textured, {remapped} remapped to game vmats", specs.len() - remapped);
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: fbx.into(),
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: specs.clone(),
            tools_root: Some(tools.into()),
            materials_out: Some(scratch.join("doorman_mats").to_string_lossy().into_owned()),
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);

        // Every bare material the artifact references is either a shipped
        // vmat_c or a game-vmat remap.
        let bytes = std::fs::read(&req.artifact_out).unwrap();
        let refs = scan_vmdl_material_refs(&bytes);
        let bare: Vec<&String> = refs
            .iter()
            .filter(|r| !r.contains('/'))
            .filter(|r| !refs.iter().any(|p| p.contains('/') && p.ends_with(r.as_str())))
            .collect();
        eprintln!("BARE REFS {bare:?}");
        eprintln!("ALL REFS {refs:?}");
        let mut covered: std::collections::HashSet<String> = rep
            .materials
            .iter()
            .filter(|a| a.target_rel.ends_with(".vmat_c"))
            .map(|a| a.target_rel.trim_end_matches("_c").to_string())
            .collect();
        for s in &specs {
            if s.game_vmat.is_some() {
                covered.insert(format!("{}.vmat", s.name.to_lowercase()));
            }
        }
        for r in &bare {
            assert!(covered.contains(r.as_str()), "no coverage for {r}: {covered:?}");
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Parses a real Blender FBX when one is around (the Twingo export);
    /// silently skipped elsewhere so CI machines don't need game rips.
    #[test]
    fn preflight_reads_a_real_fbx_if_present() {
        let p = Path::new(
            r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12\content\citadel_addons\claude_particles\models\mods\twingo.fbx",
        );
        if !p.exists() {
            return;
        }
        let rep = preflight_fbx(p, &["pelvis".into()]).unwrap();
        // The Twingo is an unrigged prop: mesh info present, bone error raised.
        assert!(rep.info.iter().any(|i| i.contains("mesh")), "{rep:?}");
        assert!(
            rep.errors.iter().any(|e| e.contains("isn't rigged") || e.contains("armature")),
            "{rep:?}"
        );
    }
}
