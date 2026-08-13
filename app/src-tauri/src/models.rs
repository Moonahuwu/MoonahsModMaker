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

/// Material names out of a binary DMX (Blender Source 2 Tools export).
/// DMX stores NO texture paths at all - just material names on DmeMaterial
/// elements - so this feeds the same My Textures matching the FBX path uses.
/// Layout (binary 9): header line + NUL, int32 prefix, int32 string count,
/// N NUL-terminated strings, int32 element count, then per element:
/// int32 type-string index, int32 name-string index, 16-byte GUID.
pub fn scan_dmx_materials(bytes: &[u8]) -> Vec<String> {
    fn parse(bytes: &[u8]) -> Option<Vec<String>> {
        let header_end = bytes.windows(4).position(|w| w == b"-->\n")? + 4;
        if *bytes.get(header_end)? != 0 {
            return None;
        }
        let mut o = header_end + 1;
        let read_i32 = |o: &mut usize| -> Option<i32> {
            let v = i32::from_le_bytes(bytes.get(*o..*o + 4)?.try_into().ok()?);
            *o += 4;
            Some(v)
        };
        let _prefix = read_i32(&mut o)?;
        let nstr = read_i32(&mut o)?;
        if !(0..1_000_000).contains(&nstr) {
            return None;
        }
        let mut strings = Vec::with_capacity(nstr as usize);
        for _ in 0..nstr {
            let end = bytes[o..].iter().position(|b| *b == 0)? + o;
            strings.push(String::from_utf8_lossy(&bytes[o..end]).into_owned());
            o = end + 1;
        }
        let nelem = read_i32(&mut o)?;
        if !(0..10_000_000).contains(&nelem) {
            return None;
        }
        let mut mats = Vec::new();
        for _ in 0..nelem {
            let t = read_i32(&mut o)?;
            let n = read_i32(&mut o)?;
            o += 16; // GUID
            if strings.get(t as usize).map(|s| s == "DmeMaterial").unwrap_or(false) {
                if let Some(name) = strings.get(n as usize) {
                    if !name.is_empty() && !mats.contains(name) {
                        mats.push(name.clone());
                    }
                }
            }
        }
        Some(mats)
    }
    parse(bytes).unwrap_or_default()
}

/// Combined material list of several mesh files (FBX or DMX), deduped in
/// encounter order - drives the My Textures rows for multi-file exports.
pub fn scan_mesh_materials(paths: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        let lower = p.to_lowercase();
        let names: Vec<String> = if lower.ends_with(".dmx") {
            std::fs::read(p).map(|b| scan_dmx_materials(&b)).unwrap_or_default()
        } else if lower.ends_with(".fbx") {
            std::fs::read(p)
                .ok()
                .and_then(|b| parse_fbx(&b).ok())
                .map(|roots| {
                    let mut m = Vec::new();
                    if let Some(objects) = roots.iter().find(|n| n.name == "Objects") {
                        for node in &objects.children {
                            if node.name == "Material" {
                                if let Some((name, _)) = fbx_obj_name(&node.props) {
                                    if !m.contains(&name) {
                                        m.push(name);
                                    }
                                }
                            }
                        }
                    }
                    m
                })
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        for n in names {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// Name-level preflight of a Blender FBX export against the target's bone
/// list. `require_rig` is false for objects (crates, the urn, ...): those
/// meshes are not skinned, so missing bones are normal, not an error.
pub fn preflight_fbx_kind(
    path: &Path,
    hero_bones: &[String],
    require_rig: bool,
) -> Result<Preflight, String> {
    let mut rep = preflight_fbx(path, hero_bones)?;
    if !require_rig {
        // Drop the rigging complaints; keep every other finding.
        rep.errors.retain(|e| !(e.contains("isn't rigged") || e.contains("armature")));
        rep.info.retain(|i| !i.contains("extra bone(s) beyond the hero's armature"));
        rep.warnings.retain(|w| !w.contains("carry no skin weights"));
    }
    Ok(rep)
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
    // One "Skin" deformer per skinned mesh - fewer skins than meshes means
    // some meshes carry no weights at all (ported physics helpers, usually).
    let mut skin_count: usize = 0;

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
            "Deformer" => {
                if let Some((_, class)) = fbx_obj_name(&node.props) {
                    if class == "Skin" {
                        skin_count += 1;
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
            // Proven vs the real CS2 compiler (e2e_extra_bone_fbx_builds_via
            // _cs2): unknown bones compile fine and join the model skeleton -
            // they just aren't driven by the hero's animations.
            out.info.push(format!(
                "{} extra bone(s) beyond the hero's armature ({}{}) - fine: they build in and ride with their parent bone, the hero's animations just won't move them",
                extra.len(),
                shown.join(", "),
                if extra.len() > 6 { ", ..." } else { "" }
            ));
        }
        if skin_count > 0 && skin_count < mesh_names.len() {
            out.warnings.push(format!(
                "{} of {} mesh(es) carry no skin weights (ported physics or collision helpers?) - they won't follow the hero. 'Fix model automatically' binds them to the nearest bone; delete them in Blender if they're not meant to be visible",
                mesh_names.len() - skin_count,
                mesh_names.len()
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

/// Non-destructive twin of `remove_node`: the byte span of the first
/// `_class = "X"` node's `{ ... }` block.
fn find_node_block(text: &str, class_name: &str) -> Option<(usize, usize)> {
    let anchor = text.find(&format!("_class = \"{class_name}\""))?;
    let open = text[..anchor].rfind('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_str = false;
    for (i, &b) in bytes[open..].iter().enumerate() {
        match b {
            b'"' => in_str = !in_str,
            b'{' if !in_str => depth += 1,
            b'}' if !in_str => {
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

/// The modern anim-graph list nodes the CSDK's ModelDoc cannot LOAD ("Failed
/// to allocate an instance of class 'NmSkeletonList'/'AnimGraph2List'" - the
/// same missing-DLL-classes gap that forces hero COMPILES through CS2).
/// They're runtime hookups, nothing ModelDoc-editable, so the mirror opened
/// for editing goes without them and they're restored on pull-back.
const MODELDOC_UNLOADABLE: [&str; 2] = ["NmSkeletonList", "AnimGraph2List"];

/// Strip the unloadable nodes so the CSDK's ModelDoc can open the file.
fn strip_modeldoc_unloadables(text: &mut String) -> usize {
    let mut n = 0;
    for class in MODELDOC_UNLOADABLE {
        while remove_node(text, class) {
            n += 1;
        }
    }
    n
}

/// Splice any unloadable node the (ModelDoc-edited) text lacks back into its
/// RootNode children, taking each block verbatim from the pristine vmdl.
fn restore_modeldoc_unloadables(edited: &mut String, pristine: &str) -> Result<usize, String> {
    let mut restored = 0;
    for class in MODELDOC_UNLOADABLE {
        if edited.contains(&format!("_class = \"{class}\"")) {
            continue;
        }
        let Some((s, e)) = find_node_block(pristine, class) else {
            continue; // the vanilla model never had this one
        };
        // Carry the block's leading indentation over for readable output.
        let line_start = pristine[..s].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let prefix = &pristine[line_start..s];
        let prefix = if prefix.trim().is_empty() { prefix } else { "" };
        let (_, kids_end) = children_span(edited, "RootNode", 0)
            .ok_or("the edited model lost its node list - run a normal Build instead")?;
        let close = kids_end - 1; // the children array's `]`
        let mut insert = String::new();
        let before = edited[..close].trim_end();
        if !before.ends_with('[') && !before.ends_with(',') {
            insert.push(',');
        }
        insert.push('\n');
        insert.push_str(prefix);
        insert.push_str(&pristine[s..e]);
        insert.push_str(",\n");
        edited.insert_str(close, &insert);
        restored += 1;
    }
    Ok(restored)
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
    mesh_rels: &[String],
    material_override: Option<&str>,
    material_remaps: &[(String, String)],
    import_scale: f32,
) -> Result<String, String> {
    let mut text = src.to_string();

    if mesh_rels.is_empty() {
        return Err("no mesh files given".into());
    }
    let scale_line = if (import_scale - 1.0).abs() > 1e-6 {
        format!("\n\t\t\t\t\t\t\timport_scale = {import_scale}")
    } else {
        String::new()
    };
    // One RenderMeshFile per mesh, named after its stem (the Blender Source
    // 2 Tools DMX flow exports one file per collection).
    let entries: String = mesh_rels
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
                "\n\t\t\t\t\t\t{{\n\t\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\t\tname = \"{stem}\"\n\t\t\t\t\t\t\tfilename = \"{rel}\"{scale_line}\n\t\t\t\t\t\t}},"
            )
        })
        .collect();
    let mesh_block = format!("[{entries}\n\t\t\t\t\t]");
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
    /// Optional look applied on top: "space" (glowing drifting starfield),
    /// "cosmic" (Valve's parallax deep-space), "pulse" (breathing glow),
    /// "glass", "ghost" (cloak refraction), "sheen" (fabric), "unlit"
    /// (flat toon).
    #[serde(default)]
    pub effect: Option<String>,
    /// Pulse only: seconds per pulse (default 2).
    #[serde(default)]
    pub fx_period: Option<f64>,
    /// Glow presets: peak self-illum brightness (defaults per preset).
    #[serde(default)]
    pub fx_intensity: Option<f64>,
    /// Space only: drift speed multiplier (default 1).
    #[serde(default)]
    pub fx_speed: Option<f64>,
    /// Space only: which star set - None/"classic" = our procedural art,
    /// "hubble" = real NASA Hubble imagery (public domain).
    #[serde(default)]
    pub fx_variant: Option<String>,
    /// Space only: glow hue in degrees (0-360). None = the warm white the
    /// community mod uses. Textures are grayscale, so this is the color.
    #[serde(default)]
    pub fx_hue: Option<f64>,
    /// Map this material to an EXISTING game vmat path instead of compiling
    /// one - the vmdl gets a material-group remap. This is how kit meshes
    /// kept from the decompile (SourceIO names them after the real vmats,
    /// e.g. `doorman_door`) get their vanilla look back.
    #[serde(default)]
    pub game_vmat: Option<String>,
}

/// Width/height from a PNG's IHDR (bytes 16..24).
pub fn png_size(path: &Path) -> Option<(u32, u32)> {
    let mut head = [0u8; 24];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(path).ok()?;
        f.read_exact(&mut head).ok()?;
    }
    if &head[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(head[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(head[20..24].try_into().ok()?);
    (w > 0 && h > 0).then_some((w, h))
}

/// Nearest power of two, clamped to sane texture sizes.
pub fn nearest_pow2(v: u32) -> u32 {
    let v = v.clamp(4, 4096);
    let lower = 1u32 << (31 - v.leading_zeros());
    let upper = lower.saturating_mul(2).min(4096);
    // Round to whichever is closer (in log space this is the usual choice).
    if v - lower <= upper.saturating_sub(v) { lower } else { upper }
}

fn resize_png(ffmpeg: Option<&str>, file: &Path, w: u32, h: u32) -> Result<(), String> {
    let tmp = file.with_extension("resized.png");
    let exe = ffmpeg.unwrap_or("ffmpeg");
    let out = crate::procutil::quiet(exe)
        .args(["-y", "-i"])
        .arg(file)
        .args(["-vf", &format!("scale={w}:{h}"), "-frames:v", "1"])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("running ffmpeg: {e}"))?;
    if !out.status.success() || !tmp.is_file() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "couldn't resize {} to {w}x{h} (textures must be power-of-two)",
            file.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    std::fs::rename(&tmp, file).map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaterialArtifact {
    /// VPK-internal path (matches what the compiled vmdl references).
    pub target_rel: String,
    /// Cached compiled file, absolute.
    pub artifact: String,
}

/// Upsert `"key" "value"` lines into a decompiled vmat (replace an existing
/// key's value, else insert before the final closing brace). `raw_blocks`
/// (e.g. a DynamicParams block) are appended verbatim when their first line
/// isn't already present.
fn splice_vmat_params(text: &str, pairs: &[(String, String)], raw_blocks: &[String]) -> String {
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    // The material body's final `}` - insert new lines just before it.
    let close = lines.iter().rposition(|l| l.trim() == "}").unwrap_or(lines.len());
    let mut insert_at = close;
    for (key, value) in pairs {
        let needle = format!("\"{key}\"");
        if let Some(line) = lines.iter_mut().find(|l| l.trim_start().starts_with(&needle)) {
            *line = format!("\t\"{key}\"\t\"{value}\"");
        } else {
            lines.insert(insert_at, format!("\t\"{key}\"\t\"{value}\""));
            insert_at += 1;
        }
    }
    for block in raw_blocks {
        let first = block.lines().next().unwrap_or("").trim().to_string();
        if !first.is_empty() && !lines.iter().any(|l| l.trim() == first) {
            for b in block.lines() {
                lines.insert(insert_at, b.to_string());
                insert_at += 1;
            }
        }
    }
    lines.join("\n") + "\n"
}

/// The fx recipe as (key, value) pairs + raw blocks, for splicing into an
/// EXISTING (decompiled game) material. `illum_mask` is what glow presets
/// mask with - the material's own color map when it has one.
fn fx_splice_parts(spec: &MaterialSpec, illum_mask: &str) -> (Vec<(String, String)>, Vec<String>) {
    let fx = spec.effect.as_deref().unwrap_or("");
    let glow = |d: f64| spec.fx_intensity.unwrap_or(d).clamp(0.1, 50.0);
    let s = |v: &str| v.to_string();
    match fx {
        // On a game material the garment's own albedo stays PUT (scrolling
        // it would make the fabric crawl) - the starlight mask drifts over
        // it instead, glowing independently of the albedo (factor 0: dark
        // suits still get bright stars), plus the normal shimmer.
        "space" => {
            let speed = spec.fx_speed.unwrap_or(1.0).clamp(0.0, 20.0);
            (
                vec![
                    (s("F_SELF_ILLUM"), s("1")),
                    (s("F_ENABLE_TEXTURE_TRANSFORMS"), s("1")),
                    (s("TextureSelfIllumMask1"), illum_mask.to_string()),
                    (s("g_flSelfIllumScale1"), format!("{}", glow(10.0))),
                    (s("g_flSelfIllumAlbedoFactor1"), s("0")),
                    (s("g_vSelfIllumTint1"), space_glow_tint(spec.fx_hue)),
                    (s("g_vSelfIllumScrollSpeed1"), format!("[{:.6} {:.6} 0.000000 0.000000]", 0.1 * speed, 0.05 * speed)),
                    (s("g_vNormalAndRoughnessScrollSpeed1"), format!("[{:.6} {:.6} 0.000000 0.000000]", 0.4 * speed, 0.2 * speed)),
                ],
                vec![],
            )
        }
        "cosmic" => (
            vec![
                (s("F_COSMIC_VEIL"), s("1")),
                (s("F_SELF_ILLUM"), s("1")),
                (s("TextureSelfIllumMask1"), illum_mask.to_string()),
                (s("g_flSelfIllumScale1"), format!("{}", glow(4.0))),
                (s("g_flSelfIllumAlbedoFactor1"), s("1")),
            ],
            vec![],
        ),
        "pulse" => {
            let period = spec.fx_period.unwrap_or(2.0).clamp(0.1, 60.0);
            let peak = glow(6.0).max(1.2);
            let w = std::f64::consts::TAU / period;
            let amp = (peak - 1.0) / 2.0;
            let base = (peak + 1.0) / 2.0;
            (
                vec![
                    (s("F_SELF_ILLUM"), s("1")),
                    (s("TextureSelfIllumMask1"), illum_mask.to_string()),
                    (s("g_flSelfIllumAlbedoFactor1"), s("1")),
                ],
                vec![format!(
                    "\t\"DynamicParams\"\n\t{{\n\t\t\"g_flSelfIllumScale1\"\t\"( sin( Time * {w:.4} ) * {amp:.3} ) + {base:.3}\"\n\t}}"
                )],
            )
        }
        "glass" => (vec![(s("F_GLASS"), s("1"))], vec![]),
        "ghost" => (
            vec![(s("F_CLOAK"), s("1")), (s("g_flCloakFactor1"), s("0.85"))],
            vec![],
        ),
        "sheen" => (vec![(s("F_SHEEN"), s("1"))], vec![]),
        "unlit" => (vec![(s("F_UNLIT"), s("1"))], vec![]),
        _ => (vec![], vec![]),
    }
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
    ffmpeg: Option<&str>,
    helper: Option<&str>,
    pak: Option<&str>,
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
        let fx = spec.effect.as_deref().unwrap_or("");
        let space = fx == "space";
        let has_fx = matches!(fx, "space" | "cosmic" | "pulse" | "glass" | "ghost" | "sheen" | "unlit");
        // Fx ON a game material: decompile the vanilla vmat (source + its
        // textures land at their vanilla-rel paths under `content`), strip
        // VRF's "Compiled Textures" block, splice the fx params in, and
        // recompile it AT THE BARE MESH-MATERIAL NAME. The spec is excluded
        // from the vmdl's remap list, so only THIS model gets the look - the
        // real game material is untouched for everything else.
        if let Some(gv) = spec.game_vmat.as_deref() {
            if !has_fx {
                continue; // pure remap - nothing to compile
            }
            let (Some(helper), Some(pak)) = (helper, pak) else {
                return Err(
                    "applying an effect to a game material needs the game install + vpk helper - re-run path autodetect in Settings".into(),
                );
            };
            let gv_norm = gv.replace('\\', "/");
            crate::vpk::material_from_vpk(helper, pak, &format!("{gv_norm}_c"), &content.to_string_lossy())
                .map_err(|e| format!("decompile {gv_norm}: {e}"))?;
            let src_abs = content.join(gv_norm.replace('/', std::path::MAIN_SEPARATOR_STR));
            let text = std::fs::read_to_string(&src_abs)
                .map_err(|e| format!("read decompiled {gv_norm}: {e}"))?;
            let text = crate::compile::strip_compiled_textures(&text);
            // Space: the drifting starlight layer IS the point - it becomes
            // the mask, scrolled over the untouched garment. Other glow
            // presets keep the material's OWN selfillum mask when it's a
            // real one (authored glow spots stay authored), else mask by
            // its color map, else glow everything evenly.
            let tex_param = |prefix: &str| {
                text.lines().find_map(|l| {
                    let parts: Vec<&str> = l.split('"').collect();
                    (parts.len() >= 4
                        && parts[1].starts_with(prefix)
                        && !parts[3].is_empty()
                        && !parts[3].starts_with('[')
                        && !parts[3].starts_with("materials/default/"))
                    .then(|| parts[3].to_string())
                })
            };
            let mask = if fx == "space" {
                let (name, bytes): (&str, &[u8]) =
                    if spec.fx_variant.as_deref() == Some("hubble") {
                        ("eim_hubble_light.png", HUBBLE_LIGHT_PNG)
                    } else {
                        ("eim_starlight.png", STARLIGHT_PNG)
                    };
                let dest = tex_dir.join(name);
                if !dest.exists() {
                    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
                }
                format!("{tex_dir_rel}/{name}")
            } else {
                tex_param("TextureSelfIllumMask")
                    .or_else(|| tex_param("TextureColor"))
                    .unwrap_or_else(|| "[1.000000 1.000000 1.000000 0.000000]".to_string())
            };
            let (pairs, blocks) = fx_splice_parts(spec, &mask);
            let spliced = splice_vmat_params(&text, &pairs, &blocks);
            let vmat_name = format!("{}.vmat", spec.name.to_lowercase());
            let vmat_abs = content.join(&vmat_name);
            std::fs::write(&vmat_abs, spliced).map_err(|e| e.to_string())?;
            inputs.push(vmat_abs.to_string_lossy().into_owned());
            rep.steps.push(format!("fx '{fx}' spliced into {gv_norm}"));
            continue;
        }
        // Any effect with no texture: fall back to the bundled starfield,
        // so one dropdown pick is the whole setup.
        let starfield_path;
        let color_src = match spec.color.as_deref() {
            Some(c) => c,
            None if has_fx => {
                let (name, bytes): (&str, &[u8]) =
                    if spec.fx_variant.as_deref() == Some("hubble") {
                        ("eim_hubble_field.png", HUBBLE_FIELD_PNG)
                    } else {
                        ("eim_starfield.png", STARFIELD_PNG)
                    };
                let dest = tex_dir.join(name);
                if !dest.exists() {
                    std::fs::write(&dest, bytes).map_err(|e| e.to_string())?;
                }
                starfield_path = dest.to_string_lossy().into_owned();
                &starfield_path
            }
            None => continue,
        };
        let stage_tex = |src: &str| -> Result<String, String> {
            // ALWAYS land as a real .png: resourcecompiler rejects other
            // extensions outright ("Unknown file type" on .jpeg) and also
            // chokes on a file merely NAMED .png that isn't one. stage_as_png
            // sniffs the magic bytes and routes everything else via ffmpeg.
            let stem = Path::new(src)
                .file_stem()
                .map(|f| f.to_string_lossy().to_lowercase())
                .ok_or_else(|| format!("texture has no file name: {src}"))?;
            let safe: String = stem
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            // Same filename from a different folder: salt with a path hash so
            // two materials' `color.png`s can't silently share one file.
            let mut h: u32 = 2166136261;
            for b in src.to_lowercase().bytes() {
                h = (h ^ b as u32).wrapping_mul(16777619);
            }
            let name = format!("{safe}_{h:08x}.png");
            let dest = tex_dir.join(&name);
            if !dest.exists() {
                crate::compile::stage_as_png(ffmpeg, src, &dest)
                    .map_err(|e| format!("{}: {e}", Path::new(src).file_name().unwrap_or_default().to_string_lossy()))?;
                // Source 2 can't mip a non-power-of-two texture ("Cannot
                // filter non-power-of-two texture 595x441"), which kills the
                // whole material compile - so snap the size here.
                if let Some((w, h)) = png_size(&dest) {
                    let (tw, th) = (nearest_pow2(w), nearest_pow2(h));
                    if (tw, th) != (w, h) {
                        resize_png(ffmpeg, &dest, tw, th)?;
                    }
                }
            }
            Ok(format!("{tex_dir_rel}/{name}"))
        };
        let color = stage_tex(color_src)?;
        let normal = match &spec.normal {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            // Space needs a REAL normal texture: the drifting shimmer comes
            // from scrolling it, and scrolling a flat literal shows nothing.
            None if space => {
                let dest = tex_dir.join("eim_space_normal.png");
                if !dest.exists() {
                    std::fs::write(&dest, SPACE_NORMAL_PNG).map_err(|e| e.to_string())?;
                }
                format!("\"{tex_dir_rel}/eim_space_normal.png\"")
            }
            None => format!("\"{FLAT_NORMAL}\""),
        };
        let rough = match &spec.roughness {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            // Space is mirror-smooth (the mod ships roughness 0) - with
            // F_GLASS that's the wet specular sparkle.
            None if space => "\"[0.000000 0.000000 0.000000 0.000000]\"".to_string(),
            None => format!("\"{MATTE}\""),
        };
        let metal = match &spec.metalness {
            Some(p) => format!("\"{}\"", stage_tex(p)?),
            None => format!("\"{NON_METAL}\""),
        };
        // Source 2 normalizes resource paths to lowercase - the compiled vmdl
        // references the lowercased material name, so the vmat file must match.
        // g_fVertexColorStrength 0 neutralizes baked vertex colors (a classic
        // cause of black models on FBX exports). NPR lighting + depth-before-
        // alpha are the community's "must enable for Deadlock-style" flags -
        // without NPR a custom material reads photoreal next to the game's
        // toon shading.
        //
        // "space": the community void-skin recipe, decoded IN FULL from the
        // void-space-viscous mod. Three stages in relative motion make the
        // depth: the albedo star field drifts one way, a SEPARATE pinpoint
        // "star light" texture in the self-illum mask slot scrolls at its
        // own speed (glints wander across the field), and the noise normal
        // scrolls fastest for shimmer. Glow scale 10 with the mod's warm
        // tint, plus F_GLASS for the wet sparkle.
        // Glow presets honor fx_intensity (peak self-illum brightness).
        let glow = |default: f64| spec.fx_intensity.unwrap_or(default).clamp(0.1, 50.0);
        let effect_block = match fx {
            "space" => {
                // Drift speed multiplier scales all three motions together.
                let speed = spec.fx_speed.unwrap_or(1.0).clamp(0.0, 20.0);
                let hubble = spec.fx_variant.as_deref() == Some("hubble");
                let (light_name, light_bytes): (&str, &[u8]) = if hubble {
                    ("eim_hubble_light.png", HUBBLE_LIGHT_PNG)
                } else {
                    ("eim_starlight.png", STARLIGHT_PNG)
                };
                let starlight = {
                    let dest = tex_dir.join(light_name);
                    if !dest.exists() {
                        std::fs::write(&dest, light_bytes).map_err(|e| e.to_string())?;
                    }
                    format!("{tex_dir_rel}/{light_name}")
                };
                // Hue colors BOTH layers (the shipped fields are grayscale);
                // untouched it stays the mod's warm-white: peach glow over
                // an untinted field.
                let albedo_tint = match spec.fx_hue {
                    Some(h) => {
                        let (r, g, b) = hue_rgb(h, 0.45);
                        format!("[{r:.6} {g:.6} {b:.6} 1.000000]")
                    }
                    None => "[1.000000 1.000000 1.000000 1.000000]".to_string(),
                };
                format!(
                    "\t\"F_SELF_ILLUM\"\t\"1\"\n\t\"F_ENABLE_TEXTURE_TRANSFORMS\"\t\"1\"\n\t\"F_GLASS\"\t\"1\"\n\t\"TextureSelfIllumMask1\"\t\"{starlight}\"\n\t\"g_flSelfIllumScale1\"\t\"{}\"\n\t\"g_flSelfIllumAlbedoFactor1\"\t\"1\"\n\t\"g_vSelfIllumTint1\"\t\"{}\"\n\t\"g_vColorTint1\"\t\"{albedo_tint}\"\n\t\"g_vAlbedoScrollSpeed1\"\t\"[0.000000 {:.6} 0.000000 0.000000]\"\n\t\"g_vSelfIllumScrollSpeed1\"\t\"[{:.6} {:.6} 0.000000 0.000000]\"\n\t\"g_vNormalAndRoughnessScrollSpeed1\"\t\"[{:.6} {:.6} 0.000000 0.000000]\"\n",
                    glow(10.0),
                    space_glow_tint(spec.fx_hue),
                    -0.1 * speed,
                    0.1 * speed,
                    0.05 * speed,
                    0.4 * speed,
                    0.2 * speed
                )
            }
            // Valve's own parallax deep-space (the Pocket briefcase look):
            // view-dependent depth from the shader, no scroll needed.
            "cosmic" => format!(
                "\t\"F_COSMIC_VEIL\"\t\"1\"\n\t\"F_SELF_ILLUM\"\t\"1\"\n\t\"TextureSelfIllumMask1\"\t\"{color}\"\n\t\"g_flSelfIllumScale1\"\t\"{}\"\n\t\"g_flSelfIllumAlbedoFactor1\"\t\"1\"\n",
                glow(4.0)
            ),
            // A dynamic expression breathes the glow at runtime
            // (probe-verified: the CSDK compiles DynamicParams to bytecode).
            // sin period P seconds -> w = 2*pi/P; glow swings 1..peak.
            "pulse" => {
                let period = spec.fx_period.unwrap_or(2.0).clamp(0.1, 60.0);
                let peak = glow(6.0).max(1.2);
                let w = std::f64::consts::TAU / period;
                let amp = (peak - 1.0) / 2.0;
                let base = (peak + 1.0) / 2.0;
                format!(
                    "\t\"F_SELF_ILLUM\"\t\"1\"\n\t\"TextureSelfIllumMask1\"\t\"{color}\"\n\t\"g_flSelfIllumAlbedoFactor1\"\t\"1\"\n\t\"DynamicParams\"\n\t{{\n\t\t\"g_flSelfIllumScale1\"\t\"( sin( Time * {w:.4} ) * {amp:.3} ) + {base:.3}\"\n\t}}\n"
                )
            }
            // Probe-verified simple looks (all compile clean via the CSDK).
            "glass" => "\t\"F_GLASS\"\t\"1\"\n".to_string(),
            "ghost" => "\t\"F_CLOAK\"\t\"1\"\n\t\"g_flCloakFactor1\"\t\"0.85\"\n".to_string(),
            "sheen" => "\t\"F_SHEEN\"\t\"1\"\n".to_string(),
            "unlit" => "\t\"F_UNLIT\"\t\"1\"\n".to_string(),
            _ => String::new(),
        };
        let vmat = format!(
            "\"Layer0\"\n{{\n\t\"shader\"\t\"pbr.vfx\"\n\t\"F_RENDER_BACKFACES\"\t\"1\"\n\t\"F_USE_STATUS_EFFECTS_PROXY\"\t\"1\"\n\t\"F_USE_NPR_LIGHTING\"\t\"1\"\n\t\"F_WRITE_DEPTH_BEFORE_ALPHA_BLENDING\"\t\"1\"\n{effect_block}\t\"g_fVertexColorStrength1\"\t\"0\"\n\t\"TextureColor1\"\t\"{color}\"\n\t\"TextureNormal1\"\t{normal}\n\t\"TextureRoughness1\"\t{rough}\n\t\"TextureMetalness1\"\t{metal}\n\t\"TextureAmbientOcclusion1\"\t\"{NO_AO}\"\n}}\n"
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

/// Image files an FBX points at (Blender writes the texture names into
/// RelativeFilename/Filename properties). Byte-scanned: FBX strings are
/// stored plainly whatever the version, so this needs no format knowledge.
pub fn scan_fbx_texture_refs(bytes: &[u8]) -> Vec<String> {
    const EXTS: [&str; 8] = [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".psd"];
    let mut out: Vec<String> = Vec::new();
    let mut run_start: Option<usize> = None;
    for i in 0..=bytes.len() {
        let printable = i < bytes.len() && (0x20..0x7f).contains(&bytes[i]);
        match (printable, run_start) {
            (true, None) => run_start = Some(i),
            (false, Some(s)) => {
                if let Ok(run) = std::str::from_utf8(&bytes[s..i]) {
                    let lower = run.to_lowercase();
                    // A property may hold exactly one path; take the run only
                    // when it ENDS in an image extension.
                    if EXTS.iter().any(|e| lower.ends_with(e)) && run.len() >= 5 {
                        let cleaned = run.trim().to_string();
                        if !out.contains(&cleaned) {
                            out.push(cleaned);
                        }
                    }
                }
                run_start = None;
            }
            _ => {}
        }
    }
    out
}

/// Resolve an FBX's texture references to real files: absolute paths as-is,
/// otherwise by base name next to the FBX (and one level down, e.g. a
/// `textures/` folder Blender exported alongside).
pub fn resolve_fbx_textures(fbx: &Path) -> Vec<String> {
    let Ok(bytes) = std::fs::read(fbx) else { return Vec::new() };
    let refs = scan_fbx_texture_refs(&bytes);
    if refs.is_empty() {
        return Vec::new();
    }
    let dir = fbx.parent().unwrap_or(Path::new("."));
    // Index every image near the FBX by lowercased base name.
    let mut near: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    fn index(dir: &Path, depth: usize, near: &mut std::collections::HashMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if depth < 2 {
                    index(&p, depth + 1, near);
                }
            } else if let Some(name) = p.file_name() {
                let lower = name.to_string_lossy().to_lowercase();
                if [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".psd"]
                    .iter()
                    .any(|e| lower.ends_with(e))
                {
                    near.entry(lower).or_insert_with(|| p.to_string_lossy().into_owned());
                }
            }
        }
    }
    index(dir, 0, &mut near);

    let mut out: Vec<String> = Vec::new();
    for r in refs {
        let norm = r.replace('\\', "/");
        let base = norm.rsplit('/').next().unwrap_or(&norm).to_lowercase();
        let hit = if Path::new(&r).is_absolute() && Path::new(&r).exists() {
            Some(r.clone())
        } else {
            near.get(&base).cloned()
        };
        if let Some(h) = hit {
            if !out.contains(&h) {
                out.push(h);
            }
        }
    }

    // Whatever folders those landed in are this model's texture folders -
    // pull in every image there. Blender projects keep maps together, so a
    // reference that went stale (renamed file, moved project) still gets
    // picked up as long as one of its siblings resolved.
    let folders: Vec<std::path::PathBuf> = out
        .iter()
        .filter_map(|p| Path::new(p).parent().map(|d| d.to_path_buf()))
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    for folder in folders {
        let Ok(rd) = std::fs::read_dir(&folder) else { continue };
        for e in rd.flatten().take(400) {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let lower = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            if [".png", ".jpg", ".jpeg", ".tga", ".bmp", ".tif", ".tiff", ".psd"]
                .iter()
                .any(|x| lower.ends_with(x))
            {
                let s = p.to_string_lossy().into_owned();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
    }
    out
}

/// Assign a list of texture FILES to material names (the shared core of the
/// folder picker and the FBX auto-detect).
pub fn match_texture_files(files: &[String], materials: &[String]) -> Vec<MatchedMaterial> {
    let pairs: Vec<(String, String)> = files
        .iter()
        .filter_map(|p| {
            let name = Path::new(p).file_name()?.to_string_lossy().to_lowercase();
            let trimmed = match name.rsplit_once('.') {
                Some((rest, tail)) if tail.chars().all(|c| c.is_ascii_digit()) => rest.to_string(),
                _ => name,
            };
            let stem = trimmed.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or(trimmed);
            Some((stem, p.clone()))
        })
        .collect();
    assign_textures(pairs, materials)
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
    assign_textures(files, materials)
}

/// Prefix-assign (stem, path) pairs to material names.
fn assign_textures(mut files: Vec<(String, String)>, materials: &[String]) -> Vec<MatchedMaterial> {
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

/// Which toolchain compiles a model. Heroes carry modern AnimGraph2 /
/// NmSkeleton nodes that ONLY CS2's Workshop Tools can compile; static props
/// (urn, crates, soul container, ...) compile in the Deadlock CSDK itself -
/// proven 2026-08-04 - so object swaps need no CS2 install at all.
#[derive(serde::Deserialize, Debug, Default, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ModelKind {
    #[default]
    Hero,
    Prop,
}

/// The CSDK content addon prop builds stage into.
pub const CSDK_PROP_ADDON: &str = "eim_props";

/// Bundled procedural starfield (our own generated art) - the automatic
/// color texture for "space glow" materials when the user supplies none.
pub const STARFIELD_PNG: &[u8] = include_bytes!("../resources_src/eim_starfield.png");

/// Companion glow layer: near-black pinpoint-star field used as the
/// self-illum mask, scrolled at its OWN speed so glints wander across the
/// albedo field (the community void skin's depth trick - two star layers
/// in relative motion, plus the drifting normal, make "3 layers").
pub const STARLIGHT_PNG: &[u8] = include_bytes!("../resources_src/eim_starlight.png");

/// The "hubble" star set: real NASA Hubble Space Telescope imagery
/// (public domain; the same source the community void skin credits),
/// grayscaled so the hue tint can color it. Field = albedo, light = the
/// scrolling glow mask.
pub const HUBBLE_FIELD_PNG: &[u8] = include_bytes!("../resources_src/eim_hubble_field.png");
pub const HUBBLE_LIGHT_PNG: &[u8] = include_bytes!("../resources_src/eim_hubble_light.png");

/// The bundled Blender auto-rig script: binds a custom model to a hero's
/// skeleton headlessly (weight transfer from the hero's own body, or a rigid
/// one-bone bind), normalizes scale/transforms/names, exports a build-ready
/// FBX. Proven e2e: its output preflights clean and compiles via CS2.
pub const AUTORIG_PY: &str = include_str!("../resources_src/eim_autorig.py");

/// Run the auto-rig script through a headless Blender. Returns the script's
/// success marker line (mesh/bone counts) for the UI toast.
/// A configured "Blender path" that's really the install FOLDER resolves to
/// the blender.exe inside it (top level, else the newest version subfolder,
/// e.g. `Blender Foundation` -> `Blender 4.2\blender.exe`). Spawning a
/// directory is Windows' cryptic "Access is denied" (os error 5) - the top
/// real-world auto-rig failure.
fn resolve_blender_exe(p: &Path) -> std::path::PathBuf {
    if !p.is_dir() {
        return p.to_path_buf();
    }
    let direct = p.join("blender.exe");
    if direct.is_file() {
        return direct;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        let mut dirs: Vec<_> = rd.flatten().map(|e| e.path()).filter(|d| d.is_dir()).collect();
        dirs.sort(); // version-named folders - the last sorts newest
        for d in dirs.into_iter().rev() {
            let exe = d.join("blender.exe");
            if exe.is_file() {
                return exe;
            }
        }
    }
    p.to_path_buf()
}

pub fn autorig(
    blender: &Path,
    hero_glb: &Path,
    model: &Path,
    out_fbx: &Path,
    mode: &str,
    rigid_bone: Option<&str>,
) -> Result<String, String> {
    let blender = &resolve_blender_exe(blender);
    if !blender.exists() {
        return Err(format!("Blender not found at {}", blender.display()));
    }
    if !hero_glb.exists() {
        return Err("the hero's Blender model isn't exported yet - open its 3D preview or Download for Blender once".into());
    }
    if !model.exists() {
        return Err(format!("model file not found: {}", model.display()));
    }
    let script = std::env::temp_dir().join("eim_autorig.py");
    std::fs::write(&script, AUTORIG_PY).map_err(|e| format!("writing the rig script: {e}"))?;
    let mut cmd = std::process::Command::new(blender);
    cmd.args(["--background", "--factory-startup", "--python"])
        .arg(&script)
        .arg("--")
        .arg("--hero-glb")
        .arg(hero_glb)
        .arg("--model")
        .arg(model)
        .arg("--out")
        .arg(out_fbx)
        .args(["--mode", mode]);
    if let Some(b) = rigid_bone.filter(|b| !b.trim().is_empty()) {
        cmd.args(["--rigid-bone", b]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::PermissionDenied {
            format!(
                "Windows refused to launch Blender at {} (access denied). Point the Blender path in Settings at blender.exe itself. Note: the Microsoft Store version of Blender can't be launched by other apps - install Blender from blender.org or Steam (both free) and use that path instead.",
                blender.display()
            )
        } else {
            format!("launching Blender: {e}")
        }
    })?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if let Some(line) = text.lines().find(|l| l.starts_with("EIM_AUTORIG_OK")) {
        if out_fbx.exists() {
            return Ok(line.trim().to_string());
        }
    }
    if let Some(line) = text.lines().find(|l| l.starts_with("EIM_AUTORIG_ERR")) {
        return Err(line.trim_start_matches("EIM_AUTORIG_ERR").trim().to_string());
    }
    let tail: String = text.lines().rev().take(6).collect::<Vec<_>>().join(" | ");
    Err(format!("Blender auto-rig failed: {tail}"))
}

/// Hue (degrees) -> RGB at the given saturation, value 1 - the space
/// preset's tint math (textures ship grayscale, color is a material param).
fn hue_rgb(hue: f64, sat: f64) -> (f64, f64, f64) {
    let h = hue.rem_euclid(360.0) / 60.0;
    let c = sat;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r, g, b) = match h as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + 1.0 - sat, g + 1.0 - sat, b + 1.0 - sat)
}

/// The space glow tint: the community mod's warm peach unless a hue is
/// picked (peach = hue 14 at half saturation, so the slider's default
/// position reproduces it).
fn space_glow_tint(fx_hue: Option<f64>) -> String {
    let (r, g, b) = hue_rgb(fx_hue.unwrap_or(14.0), 0.50);
    format!("[{r:.6} {g:.6} {b:.6} 1.000000]")
}

/// Bundled tileable noise normal map. Scrolling a normal makes a surface
/// shimmer and flow - but generated materials default to a FLAT normal
/// literal, and scrolling a constant is invisible (why the first space
/// builds didn't move). Space materials get this unless the user supplied
/// a real normal map.
pub const SPACE_NORMAL_PNG: &[u8] = include_bytes!("../resources_src/eim_space_normal.png");

impl ModelKind {
    /// (content root, game dir, addon name) for this kind's toolchain root.
    fn layout(self, root: &Path) -> (std::path::PathBuf, std::path::PathBuf, &'static str) {
        match self {
            ModelKind::Hero => (
                root.join("content/csgo_addons").join(CS2_ADDON),
                root.join("game/csgo"),
                CS2_ADDON,
            ),
            ModelKind::Prop => (
                root.join("content/citadel_addons").join(CSDK_PROP_ADDON),
                root.join("game/citadel"),
                CSDK_PROP_ADDON,
            ),
        }
    }
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelBuildReq {
    /// Hero builds: the CS2 install root. Prop builds ignore this and use
    /// `tools_root` (the Deadlock CSDK) instead.
    #[serde(default)]
    pub cs2_root: String,
    /// Hero (CS2) or Prop (CSDK). Defaults to Hero for older saved configs.
    #[serde(default)]
    pub kind: ModelKind,
    /// The hero workspace dir from `workspace`.
    pub workspace_dir: String,
    /// Internal vmdl path (no `_c`), e.g. `models/heroes_staging/haze/haze.vmdl`.
    pub vmdl_internal: String,
    /// The user's mesh file (fbx/dmx), absolute.
    #[serde(default)]
    pub mesh_file: String,
    /// Several mesh files (the Blender Source 2 Tools DMX flow exports one
    /// DMX per collection). When non-empty this wins over `mesh_file`; each
    /// file becomes its own RenderMeshFile named after its stem.
    #[serde(default)]
    pub mesh_files: Vec<String>,
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
    /// ffmpeg, used to normalize textures to real PNGs before compiling.
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    /// vpk helper + game pak - lets fx-on-a-game-material decompile the
    /// vanilla vmat to splice effects into it.
    #[serde(default)]
    pub helper_path: Option<String>,
    #[serde(default)]
    pub pak_path: Option<String>,
    /// Compile the STAGED vmdl as it currently is instead of re-staging and
    /// regenerating - preserves manual ModelDoc edits made after the last
    /// build/inspect (bodygroups, ragdoll tweaks, anything the app doesn't
    /// automate). Meshes and textures from earlier staging stay in place.
    #[serde(default)]
    pub use_staged: bool,
    /// Skip compiling the embedded legacy animation list (the community
    /// standard: heroes animate through the external AnimGraph2/NmSkeleton
    /// graphs, which we keep - the baked list is what makes hero builds take
    /// 10+ minutes). Rarely, an ability's echo/clone uses a baked anim (the
    /// known case is Haze's ult shadow) - rebuild with this off if one
    /// T-poses.
    #[serde(default)]
    pub skip_anims: bool,
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
/// A game material WITH an effect is not remapped: the build compiles a
/// spliced copy at the bare name instead, scoped to this model only.
fn remap_pairs(req: &ModelBuildReq) -> Vec<(String, String)> {
    req.materials
        .iter()
        .filter(|s| s.effect.is_none())
        .filter_map(|s| {
            s.game_vmat
                .as_ref()
                .map(|v| (format!("{}.vmat", s.name.to_lowercase()), v.clone()))
        })
        .collect()
}

/// The toolchain root a build compiles in: CS2 for heroes, the Deadlock
/// CSDK for props.
fn toolchain_root(req: &ModelBuildReq) -> Result<std::path::PathBuf, String> {
    match req.kind {
        ModelKind::Hero => {
            if req.cs2_root.trim().is_empty() {
                return Err("hero models need CS2 Workshop Tools - set the CS2 folder in Settings".into());
            }
            Ok(Path::new(&req.cs2_root).to_path_buf())
        }
        ModelKind::Prop => req
            .tools_root
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .map(|t| Path::new(t).to_path_buf())
            .ok_or_else(|| "object models need the Deadlock compile tools - set them up in Settings".into()),
    }
}

/// CS2's tools expect every addon to carry an `addoninfo.txt` on BOTH sides
/// (the stock `addon_template` has one). Without it the tools can sit on the
/// splash screen instead of opening. Compiling never needed it, so our addon
/// went without until ModelDoc was wired up.
fn ensure_cs2_addoninfo(root: &Path, addon: &str) {
    const INFO: &str = "\"AddonInfo\"\n{\n\t\"IsPlayable\"\t\"0\"\n}\n";
    for side in ["content/csgo_addons", "game/csgo_addons"] {
        let dir = root.join(side).join(addon);
        if std::fs::create_dir_all(&dir).is_err() {
            continue;
        }
        let info = dir.join("addoninfo.txt");
        if !info.exists() {
            let _ = std::fs::write(&info, INFO);
        }
    }
}

/// Stage the decompiled source tree + the user's mesh into the toolchain's
/// content addon and write the generated vmdl (mesh splice, remaps, camera
/// edits). Shared by the compile path and "Open in ModelDoc". Returns the
/// staged vmdl's absolute path plus human-readable step notes.
fn stage_sources(req: &ModelBuildReq) -> Result<(std::path::PathBuf, Vec<String>), String> {
    let root = toolchain_root(req)?;
    let (content, _, addon) = req.kind.layout(&root);
    if req.kind == ModelKind::Hero {
        ensure_cs2_addoninfo(&root, addon);
    }
    let vmdl_internal = req.vmdl_internal.replace('\\', "/");
    let vmdl_dir_internal = vmdl_internal.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let mut notes = Vec::new();

    // Fresh content stage: the whole decompiled tree (anims included - the
    // legacy AnimationList compiles from them) + the user's mesh.
    let stage_dir = content.join(vmdl_dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let _ = std::fs::remove_dir_all(&stage_dir);
    copy_tree(Path::new(&req.workspace_dir), &content)?;
    notes.push(format!("staged sources into the {addon} addon"));

    // One or many mesh files (the DMX flow exports one per collection).
    let mesh_files: Vec<&str> = if req.mesh_files.is_empty() {
        vec![req.mesh_file.as_str()]
    } else {
        req.mesh_files.iter().map(|s| s.as_str()).collect()
    };
    let mut mesh_rels: Vec<String> = Vec::new();
    for mf in &mesh_files {
        let mesh_name = Path::new(mf)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .ok_or("mesh file has no name")?;
        std::fs::copy(mf, stage_dir.join(&mesh_name))
            .map_err(|e| format!("copy mesh into the addon: {e}"))?;
        mesh_rels.push(format!("{vmdl_dir_internal}/{mesh_name}"));
    }
    notes.push(if mesh_rels.len() == 1 {
        format!("mesh: {}", mesh_rels[0].rsplit('/').next().unwrap_or(""))
    } else {
        format!("{} mesh files staged", mesh_rels.len())
    });

    // Generate the vmdl over the staged copy. Materials mapped to game
    // vmats become DefaultMaterialGroup remaps (bare mesh name -> path).
    let remaps = remap_pairs(req);
    let vmdl_abs = content.join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let src = std::fs::read_to_string(&vmdl_abs).map_err(|e| e.to_string())?;
    let mut generated = generate_vmdl(
        &src,
        &mesh_rels,
        req.material_override.as_deref(),
        &remaps,
        req.import_scale,
    )?;
    if req.skip_anims {
        let mut stripped = 0;
        while remove_node(&mut generated, "AnimationList") {
            stripped += 1;
        }
        if stripped > 0 {
            notes.push("fast build: baked animation list skipped (the hero animates via its animation graphs)".into());
        }
    }
    // Restore the EXACT vanilla attachment transforms (decompiled ones are
    // lossy - the cause of the classic centered-camera-after-swap bug).
    // Models with no attachments at all (most props) skip this silently.
    let has_attachments = generated.contains("_class = \"Attachment\"");
    if has_attachments {
        let vanilla_atts = load_attachments_cache(Path::new(&req.workspace_dir));
        if vanilla_atts.is_empty() {
            notes.push("attachment data not cached - re-pick this model once to refresh its kit".into());
        } else {
            let (corrected, fixed) = correct_attachments(&generated, &vanilla_atts);
            generated = corrected;
            notes.push(format!(
                "{fixed} attachment(s) restored to exact vanilla transforms (aim/camera anchors)"
            ));
        }
    }
    if !req.camera.is_empty() {
        generated = apply_camera_overrides(&generated, &req.camera)?;
        notes.push(format!("camera: {} value(s) adjusted", req.camera.len()));
    }
    std::fs::write(&vmdl_abs, generated).map_err(|e| e.to_string())?;
    notes.push(match req.kind {
        ModelKind::Hero => format!(
            "generated vmdl (your mesh at scale {}, the hero's skeleton, cameras and animation refs)",
            req.import_scale
        ),
        ModelKind::Prop => format!(
            "generated vmdl (your mesh at scale {}, the object's physics and setup kept)",
            req.import_scale
        ),
    });
    Ok((vmdl_abs, notes))
}

/// Stage everything exactly as a build would, then open the result in CS2's
/// ModelDoc so the model (weights, skeleton, camera) can be inspected by
/// hand. Same launch pattern as the particle-editor inspector.
pub fn open_in_modeldoc(req: &ModelBuildReq) -> Result<String, String> {
    let vmdl_internal = req.vmdl_internal.replace('\\', "/");
    let vmdl_dir_internal = vmdl_internal.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let (_, _notes) = stage_sources(req)?;

    // ModelDoc runs in the DEADLOCK CSDK for BOTH kinds - it is the stable
    // one (CS2's tools crash-prone for editing, and its `-asset` launch
    // hangs on the splash; the CSDK opens straight into the model, same
    // launch the particle inspector uses). Heroes therefore get their CS2
    // stage MIRRORED into the CSDK model addon for editing; a "Build
    // keeping ModelDoc edits" pulls the edits back before compiling.
    let tools = req
        .tools_root
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .ok_or("ModelDoc needs the Deadlock compile tools - set them up in Settings")?;
    let tools = Path::new(tools);
    if req.kind == ModelKind::Hero {
        let cs2 = Path::new(&req.cs2_root);
        let src_dir = cs2
            .join("content/csgo_addons")
            .join(CS2_ADDON)
            .join(vmdl_dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
        let dest_dir = tools
            .join("content/citadel_addons")
            .join(CSDK_PROP_ADDON)
            .join(vmdl_dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
        let _ = std::fs::remove_dir_all(&dest_dir);
        copy_tree(&src_dir, &dest_dir)?;
        // The CSDK's ModelDoc refuses to LOAD hero vmdls carrying the modern
        // anim-graph nodes (its DLLs lack those classes) - strip them from
        // the editing mirror; the pull-back restores them before compiling.
        let mirror_vmdl = tools
            .join("content/citadel_addons")
            .join(CSDK_PROP_ADDON)
            .join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
        let mut text = std::fs::read_to_string(&mirror_vmdl)
            .map_err(|e| format!("read the mirrored vmdl: {e}"))?;
        if strip_modeldoc_unloadables(&mut text) > 0 {
            std::fs::write(&mirror_vmdl, text).map_err(|e| e.to_string())?;
        }
    }
    let exe = ["bin_tools", "bin"]
        .iter()
        .map(|b| tools.join("game").join(b).join("win64").join("deadlock.exe"))
        .find(|p| p.exists())
        .ok_or("deadlock.exe not found in the compile tools - re-run the tools setup in Settings")?;
    let mut cmd = std::process::Command::new(&exe);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    cmd.args([
        "-tools",
        "-danger_mode_ignore_schema_mismatches",
        "-addon",
        CSDK_PROP_ADDON,
        "-asset",
        &vmdl_internal,
    ]);
    // Fire and forget - the tools outlive us.
    cmd.spawn().map_err(|e| format!("launching the tools: {e}"))?;
    Ok("ModelDoc is opening in the Deadlock tools (takes a bit). Edit and save there, then use \"Build keeping ModelDoc edits\"".into())
}

fn build_inner(req: &ModelBuildReq, rep: &mut ModelBuildReport) -> Result<String, String> {
    let root = toolchain_root(req)?;
    // Heroes compile in CS2 (`game/bin`); the CSDK ships its compiler under
    // `bin_tools` (full installs also have `bin`).
    let compiler = match req.kind {
        ModelKind::Hero => Some(root.join("game/bin/win64/resourcecompiler.exe"))
            .filter(|p| p.exists())
            .ok_or_else(|| format!(
                "CS2 Workshop Tools compiler not found under {} - install Counter-Strike 2 and check the Workshop Tools box in its Steam install options",
                root.display()
            ))?,
        ModelKind::Prop => ["game/bin_tools/win64/resourcecompiler.exe", "game/bin/win64/resourcecompiler.exe"]
            .iter()
            .map(|r| root.join(r))
            .find(|p| p.exists())
            .ok_or_else(|| format!(
                "compile tools not found under {} - set up the compile tools in Settings",
                root.display()
            ))?,
    };
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
        if req.materials.iter().any(|s| s.color.is_some() || s.effect.is_some()) {
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
                req.ffmpeg_path.as_deref().filter(|p| !p.trim().is_empty()),
                req.helper_path.as_deref().filter(|p| !p.trim().is_empty()),
                req.pak_path.as_deref().filter(|p| !p.trim().is_empty()),
                rep,
            )?;
        }
    }

    // 1+2. Shared with "Open in ModelDoc": stage the tree + generate the vmdl.
    // With `use_staged`, the staged copy IS the source of truth (the user
    // edited it in ModelDoc) - compile it untouched.
    let vmdl_abs = if req.use_staged {
        let root = toolchain_root(req)?;
        let (content, _, _) = req.kind.layout(&root);
        let staged = content.join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
        // Heroes EDIT in the CSDK's ModelDoc but COMPILE in CS2 - when the
        // CSDK mirror is newer, pull it back over the CS2 stage first
        // (whole model dir: ModelDoc may have added meshes alongside).
        if req.kind == ModelKind::Hero {
            if let Some(tools) = req.tools_root.as_deref().filter(|t| !t.trim().is_empty()) {
                let dir_internal = vmdl_internal.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                let csdk_dir = Path::new(tools)
                    .join("content/citadel_addons")
                    .join(CSDK_PROP_ADDON)
                    .join(dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
                let csdk_vmdl = Path::new(tools)
                    .join("content/citadel_addons")
                    .join(CSDK_PROP_ADDON)
                    .join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
                let newer = match (csdk_vmdl.metadata().and_then(|m| m.modified()), staged.metadata().and_then(|m| m.modified())) {
                    (Ok(a), Ok(b)) => a > b,
                    (Ok(_), Err(_)) => true,
                    _ => false,
                };
                if newer {
                    let cs2_dir = content
                        .join(dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
                    copy_tree(&csdk_dir, &cs2_dir)?;
                    rep.steps.push("pulled your ModelDoc edits from the Deadlock tools".into());
                    // The editing mirror went WITHOUT the modern anim-graph
                    // nodes (the CSDK's ModelDoc can't load them) - splice
                    // them back from the pristine kit before compiling, or
                    // the hero would lose its runtime animation graphs.
                    let pristine = Path::new(&req.workspace_dir)
                        .join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
                    let pristine_text = std::fs::read_to_string(&pristine).unwrap_or_default();
                    if let Ok(mut edited) = std::fs::read_to_string(&staged) {
                        let n = restore_modeldoc_unloadables(&mut edited, &pristine_text)?;
                        if n > 0 {
                            std::fs::write(&staged, edited).map_err(|e| e.to_string())?;
                            rep.steps.push(format!(
                                "{n} runtime animation hookup(s) restored (set aside while ModelDoc had the file)"
                            ));
                        } else if pristine_text.is_empty()
                            && !edited.contains("_class = \"NmSkeletonList\"")
                        {
                            rep.steps.push(
                                "WARNING: couldn't read the model kit to restore its animation hookups - if animations break in-game, re-pick the model and run a normal Build".into(),
                            );
                        }
                    }
                }
            }
        }
        if !staged.exists() {
            return Err(
                "no staged model to compile - run a normal Build (or Inspect in ModelDoc) first, then edit and rebuild".into(),
            );
        }
        rep.steps.push("compiling your ModelDoc-edited model as is (no restaging)".into());
        staged
    } else {
        let (vmdl_abs, notes) = stage_sources(req)?;
        rep.steps.extend(notes);
        vmdl_abs
    };
    let (content, game_dir, addon) = req.kind.layout(&root);
    let remaps = remap_pairs(req);

    // 3. Compile, auto-stubbing missing materials (they live in Deadlock's
    //    pak, not CS2's content - stubs satisfy the compiler and leave no
    //    trace in the artifact, which records the real paths).
    let mut last_out = String::new();
    for round in 1..=4 {
        let out = run_model_compiler(&game_dir, &compiler, &vmdl_abs)?;
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
    let compiled = game_dir
        .parent()
        .map(|p| p.join(format!("{}_addons", game_dir.file_name().unwrap_or_default().to_string_lossy())))
        .unwrap_or_default()
        .join(addon)
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

fn run_model_compiler(game_dir: &Path, compiler: &Path, vmdl: &Path) -> Result<String, String> {
    let game = game_dir.to_string_lossy().into_owned();
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
            generate_vmdl(MINI_VMDL, &["models/x/custom.fbx".to_string()], Some("models/a/b.vmat"), &[], 0.01).unwrap();
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
        let out = generate_vmdl(MINI_VMDL, &["m.fbx".to_string()], None, &[], 1.0).unwrap();
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

    /// The whole auto-rig chain, end to end on real installs: headless
    /// Blender runs the SHIPPED script (weight transfer from the hero's own
    /// body onto a de-rigged copy of it, standing in for a downloaded
    /// unrigged humanoid), and the produced FBX must sail through the same
    /// gates a hand-rigged export does - preflight clean against the hero's
    /// real skeleton, then a full CS2 hero build. Ignored: local-only.
    #[test]
    #[ignore]
    fn e2e_autorigged_fbx_preflights_and_builds() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let blender = Path::new(r"D:\SteamLibrary\steamapps\common\Blender\blender.exe");
        let glb = Path::new(
            r"C:\Users\ethob\AppData\Roaming\com.digiphoenix.deadlock-intro-tool\model_gltf\models_heroes_wip_doorman_v2_doorman\doorman.glb",
        );
        if !blender.exists() || !glb.exists() {
            eprintln!("blender or the cached doorman glb missing - skipping");
            return;
        }
        let scratch = std::env::temp_dir().join("eim_autorig_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        let out = scratch.join("autorigged.fbx");
        let note = autorig(blender, glb, glb, &out, "transfer", None).expect("autorig");
        eprintln!("AUTORIG {note}");
        let fbx = out.to_string_lossy().into_owned();
        let fbx = fbx.as_str();
        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");

        let pf = preflight_fbx(Path::new(fbx), &ws.bones).expect("preflight");
        for e in &pf.errors {
            eprintln!("PF ERR {e}");
        }
        for w in &pf.warnings {
            eprintln!("PF WARN {w}");
        }
        assert!(pf.errors.is_empty(), "auto-rigged fbx must preflight clean: {:?}", pf.errors);

        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);
        assert!(Path::new(&req.artifact_out).exists());
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// What the CS2 compiler ACTUALLY does with an FBX bone that isn't in
    /// the hero's skeleton (GameBanana report: ported models with physics
    /// bones "demand removal"): auto-rig a known-good doorman FBX, inject an
    /// extra bone with ~120 verts weighted 100% to it, then run the real
    /// build and check whether the bone survives into the vmdl_c skeleton.
    #[test]
    #[ignore]
    fn e2e_extra_bone_fbx_builds_via_cs2() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let blender = Path::new(r"D:\SteamLibrary\steamapps\common\Blender\blender.exe");
        let glb = Path::new(
            r"C:\Users\ethob\AppData\Roaming\com.digiphoenix.deadlock-intro-tool\model_gltf\models_heroes_wip_doorman_v2_doorman\doorman.glb",
        );
        if !blender.exists() || !glb.exists() || !Path::new(cs2).exists() {
            eprintln!("blender, the doorman glb or CS2 missing - skipping");
            return;
        }
        let scratch = std::env::temp_dir().join("eim_extrabone_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        // 1) A known-good rigged FBX via the shipped auto-rig.
        let rigged = scratch.join("rigged.fbx");
        autorig(blender, glb, glb, &rigged, "transfer", None).expect("autorig");
        // 2) Inject the extra bone + 100%-weighted verts.
        let injected = scratch.join("extra_bone.fbx");
        let py = r#"
import bpy, sys
from mathutils import Vector
argv = sys.argv
argv = argv[argv.index("--") + 1 :]
src, out = argv[0], argv[1]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=src)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
eb = arm.data.edit_bones
root = next(b for b in eb if b.parent is None)
nb = eb.new("eim_extra_tail")
nb.head = root.head + Vector((0.0, -10.0, 20.0))
nb.tail = nb.head + Vector((0.0, -20.0, 0.0))
nb.parent = root
bpy.ops.object.mode_set(mode="OBJECT")
m = max(meshes, key=lambda o: len(o.data.vertices))
n = len(m.data.vertices)
idx = list(range(max(0, n - 120), n))
for vg in list(m.vertex_groups):
    vg.remove(idx)
vg = m.vertex_groups.new(name="eim_extra_tail")
vg.add(idx, 1.0, "REPLACE")
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(
    filepath=out,
    use_selection=True,
    object_types={"ARMATURE", "MESH"},
    add_leaf_bones=False,
    bake_anim=False,
    mesh_smooth_type="FACE",
)
print("EIM_INJECT_OK verts=%d mesh=%s" % (len(idx), m.name), flush=True)
"#;
        let script = scratch.join("inject.py");
        std::fs::write(&script, py).unwrap();
        let out = std::process::Command::new(blender)
            .args(["--background", "--factory-startup", "--python"])
            .arg(&script)
            .arg("--")
            .arg(&rigged)
            .arg(&injected)
            .output()
            .expect("blender");
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(text.contains("EIM_INJECT_OK"), "inject failed:\n{text}");
        // 3) Preflight: today extra bones are a warning, never an error.
        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        let pf = preflight_fbx(&injected, &ws.bones).expect("preflight");
        for e in &pf.errors {
            eprintln!("PF ERR  {e}");
        }
        for w in &pf.warnings {
            eprintln!("PF WARN {w}");
        }
        for i in &pf.info {
            eprintln!("PF INFO {i}");
        }
        assert!(pf.errors.is_empty(), "extra bones must not block preflight: {:?}", pf.errors);
        assert!(
            pf.info.iter().any(|i| i.contains("extra bone(s) beyond")),
            "the extra bone should be reported as info: {:?}",
            pf.info
        );
        // 4) The real CS2 build.
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: injected.to_string_lossy().into_owned(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "extra-bone fbx must build: {:?}", rep.steps);
        // 5) The unknown bone joins the compiled skeleton (rides with its
        //    parent in game) - the behavior the preflight copy promises.
        let bytes = std::fs::read(&req.artifact_out).unwrap();
        let needle = b"eim_extra_tail";
        let found = bytes.windows(needle.len()).any(|w| w == needle);
        eprintln!("EXTRA BONE IN VMDL_C = {found}");
        assert!(found, "the extra bone should survive into the compiled skeleton");
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The "Fix model automatically" path end to end: fabricate the junk a
    /// ported model ships with (un-applied scale, vertex colors, an unskinned
    /// physics hull, .001 names) and prove preflight rejects it, the clean
    /// mode repairs it WITHOUT re-rigging, and the result builds via CS2.
    #[test]
    #[ignore]
    fn e2e_clean_mode_fixes_junk_fbx() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let blender = Path::new(r"D:\SteamLibrary\steamapps\common\Blender\blender.exe");
        let glb = Path::new(
            r"C:\Users\ethob\AppData\Roaming\com.digiphoenix.deadlock-intro-tool\model_gltf\models_heroes_wip_doorman_v2_doorman\doorman.glb",
        );
        if !blender.exists() || !glb.exists() || !Path::new(cs2).exists() {
            eprintln!("blender, the doorman glb or CS2 missing - skipping");
            return;
        }
        let scratch = std::env::temp_dir().join("eim_cleanmode_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        std::fs::create_dir_all(&scratch).unwrap();
        // A known-good rigged base, then junk it up like a ported model.
        let rigged = scratch.join("rigged.fbx");
        autorig(blender, glb, glb, &rigged, "transfer", None).expect("autorig");
        let junk = scratch.join("junk.fbx");
        let py = r#"
import bpy, sys
argv = sys.argv
argv = argv[argv.index("--") + 1 :]
src, out = argv[0], argv[1]
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=src)
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
m = max(meshes, key=lambda o: len(o.data.vertices))
m.scale = (2.0, 2.0, 2.0)
m.data.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
bpy.ops.mesh.primitive_cube_add(size=10.0)
cube = bpy.context.active_object
cube.name = "PhysHull.001"
mat = bpy.data.materials.new("Bad Mat.001")
cube.data.materials.append(mat)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.export_scene.fbx(
    filepath=out,
    use_selection=True,
    object_types={"ARMATURE", "MESH"},
    add_leaf_bones=False,
    bake_anim=False,
    mesh_smooth_type="FACE",
)
print("EIM_JUNK_OK", flush=True)
"#;
        let script = scratch.join("junk.py");
        std::fs::write(&script, py).unwrap();
        let out = std::process::Command::new(blender)
            .args(["--background", "--factory-startup", "--python"])
            .arg(&script)
            .arg("--")
            .arg(&rigged)
            .arg(&junk)
            .output()
            .expect("blender");
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(text.contains("EIM_JUNK_OK"), "junk fabrication failed:\n{text}");

        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        // The junk must trip preflight the way the ported-model reports do.
        let pf = preflight_fbx(&junk, &ws.bones).expect("preflight junk");
        for e in &pf.errors {
            eprintln!("JUNK ERR  {e}");
        }
        for w in &pf.warnings {
            eprintln!("JUNK WARN {w}");
        }
        assert!(
            pf.errors.iter().any(|e| e.contains("transforms not applied")),
            "expected the transforms error: {:?}",
            pf.errors
        );
        assert!(pf.warnings.iter().any(|w| w.contains("carry no skin weights")));
        assert!(pf.warnings.iter().any(|w| w.contains("vertex colors")));

        // One-click fix: rig-preserving cleanup.
        let fixed = scratch.join("fixed.fbx");
        let note = autorig(blender, glb, &junk, &fixed, "clean", None).expect("clean");
        eprintln!("CLEAN {note}");
        let pf2 = preflight_fbx(&fixed, &ws.bones).expect("preflight fixed");
        for e in &pf2.errors {
            eprintln!("FIXED ERR  {e}");
        }
        for w in &pf2.warnings {
            eprintln!("FIXED WARN {w}");
        }
        assert!(pf2.errors.is_empty(), "clean must clear the errors: {:?}", pf2.errors);
        assert!(
            !pf2.warnings.iter().any(|w| w.contains("carry no skin weights")),
            "the hull should be bound now: {:?}",
            pf2.warnings
        );
        assert!(!pf2.warnings.iter().any(|w| w.contains("vertex colors")));

        // And the cleaned model must actually build.
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: fixed.to_string_lossy().into_owned(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "cleaned fbx must build: {:?}", rep.steps);
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The "use a model from a mod / pick a glb" path: a helper-exported glb
    /// (the cached doorman one stands in for a mod's extracted model) must
    /// convert to FBX via the clean pass with its rig intact and preflight
    /// clean - texture references from the glb's sibling PNGs ride along.
    #[test]
    #[ignore]
    fn e2e_glb_input_converts_via_clean() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let blender = Path::new(r"D:\SteamLibrary\steamapps\common\Blender\blender.exe");
        let glb = Path::new(
            r"C:\Users\ethob\AppData\Roaming\com.digiphoenix.deadlock-intro-tool\model_gltf\models_heroes_wip_doorman_v2_doorman\doorman.glb",
        );
        if !blender.exists() || !glb.exists() {
            eprintln!("blender or the cached doorman glb missing - skipping");
            return;
        }
        let scratch = std::env::temp_dir().join("eim_glbconvert_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        let out = scratch.join("converted.fbx");
        let note = autorig(blender, glb, glb, &out, "clean", None).expect("clean convert");
        eprintln!("CONVERT {note}");
        assert!(out.exists());

        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        let pf = preflight_fbx(&out, &ws.bones).expect("preflight");
        for e in &pf.errors {
            eprintln!("PF ERR  {e}");
        }
        for w in &pf.warnings {
            eprintln!("PF WARN {w}");
        }
        // The glb's armature survives the conversion: rigged, no errors.
        assert!(pf.errors.is_empty(), "converted glb must preflight clean: {:?}", pf.errors);
        // Texture refs from the glb's sibling PNGs should ride into the FBX
        // (feeds the auto-texture scan). Informational - glbs without
        // textures are legitimate.
        let bytes = std::fs::read(&out).unwrap();
        let has_png = bytes.windows(4).any(|w| w.eq_ignore_ascii_case(b".png"));
        eprintln!("TEXTURE REFS IN FBX = {has_png}");
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn resolve_blender_exe_heals_folder_paths() {
        let root = std::env::temp_dir().join(format!("eim_blender_resolve_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        // Blender Foundation layout: version folders, newest wins.
        let old = root.join("Blender 3.6");
        let new = root.join("Blender 4.2");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(old.join("blender.exe"), b"x").unwrap();
        std::fs::write(new.join("blender.exe"), b"x").unwrap();
        // The vendor folder resolves to the newest version's exe.
        assert_eq!(super::resolve_blender_exe(&root), new.join("blender.exe"));
        // A version folder resolves to its direct exe.
        assert_eq!(super::resolve_blender_exe(&old), old.join("blender.exe"));
        // A real exe path passes through untouched.
        let exe = new.join("blender.exe");
        assert_eq!(super::resolve_blender_exe(&exe), exe);
        // A folder with no blender.exe anywhere returns as-is (the caller's
        // not-found error then names what the user actually typed).
        let empty = root.join("Blender 4.2").join("datafiles");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(super::resolve_blender_exe(&empty), empty);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn space_hue_tint_math() {
        // Default = the community mod's warm peach (hue 14, half sat).
        let d = space_glow_tint(None);
        assert!(d.starts_with("[1.000000 0.6"), "{d}");
        // Pure hues at sat 0.5: red keeps R at 1, blue keeps B at 1.
        let (r, g, b) = hue_rgb(0.0, 0.5);
        assert!((r - 1.0).abs() < 1e-6 && (g - 0.5).abs() < 1e-6 && (b - 0.5).abs() < 1e-6);
        let (r, g, b) = hue_rgb(240.0, 0.5);
        assert!((b - 1.0).abs() < 1e-6 && (r - 0.5).abs() < 1e-6 && (g - 0.5).abs() < 1e-6);
        // Wraps: 360 == 0, negatives fold in.
        assert_eq!(hue_rgb(360.0, 0.5), hue_rgb(0.0, 0.5));
        assert_eq!(hue_rgb(-120.0, 0.5), hue_rgb(240.0, 0.5));
    }

    #[test]
    fn modeldoc_unloadables_strip_and_restore_roundtrip() {
        let vmdl = "{\n\trootNode =\n\t{\n\t\t_class = \"RootNode\"\n\t\tchildren =\n\t\t[\n\t\t\t{\n\t\t\t\t_class = \"MaterialGroupList\"\n\t\t\t\tchildren = [ ]\n\t\t\t},\n\t\t\t{\n\t\t\t\t_class = \"NmSkeletonList\"\n\t\t\t\tchildren =\n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\t_class = \"NmSkeletonFile\"\n\t\t\t\t\t\tskeleton_file = \"models/x/x.vnmskel\"\n\t\t\t\t\t},\n\t\t\t\t]\n\t\t\t},\n\t\t\t{\n\t\t\t\t_class = \"AnimGraph2List\"\n\t\t\t\tchildren =\n\t\t\t\t[\n\t\t\t\t\t{\n\t\t\t\t\t\t_class = \"AnimGraph2File\"\n\t\t\t\t\t\tgraph_file = \"models/x/hero.vnmgraph\"\n\t\t\t\t\t},\n\t\t\t\t]\n\t\t\t},\n\t\t]\n\t}\n}\n";
        let pristine = vmdl.to_string();
        let mut mirror = vmdl.to_string();
        assert_eq!(strip_modeldoc_unloadables(&mut mirror), 2);
        assert!(!mirror.contains("NmSkeletonList") && !mirror.contains("AnimGraph2List"));
        assert!(mirror.contains("MaterialGroupList"), "other nodes stay");

        // "ModelDoc" saves the stripped file (formatting churn simulated by
        // an extra key), then the pull-back restores both nodes.
        let mut edited = mirror.replace(
            "_class = \"MaterialGroupList\"",
            "_class = \"MaterialGroupList\"\n\t\t\t\tnote = \"edited\"",
        );
        let n = restore_modeldoc_unloadables(&mut edited, &pristine).expect("restore");
        assert_eq!(n, 2, "{edited}");
        assert!(edited.contains("_class = \"NmSkeletonList\""));
        assert!(edited.contains("_class = \"AnimGraph2List\""));
        assert!(edited.contains("note = \"edited\""), "the manual edit survives");
        // Both landed INSIDE the RootNode children array.
        let (open, close) = children_span(&edited, "RootNode", 0).expect("children parse");
        let inside = &edited[open..close];
        assert!(inside.contains("NmSkeletonList") && inside.contains("AnimGraph2List"));
        // Restoring again is a no-op (both present already).
        let again = restore_modeldoc_unloadables(&mut edited, &pristine).expect("restore 2");
        assert_eq!(again, 0);
        assert_eq!(edited.matches("NmSkeletonList").count(), 1);
    }

    /// Against the REAL mirrored doorman vmdl (the exact file the user's
    /// ModelDoc refused to load): strip must remove both modern nodes and
    /// restore must bring them back intact. Ignored: needs the local stage.
    #[test]
    #[ignore]
    fn e2e_strip_restore_on_real_doorman() {
        let p = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12\content\citadel_addons\eim_props\models\heroes_wip\doorman_v2\doorman.vmdl");
        if !p.exists() {
            eprintln!("no staged doorman - skipping");
            return;
        }
        let pristine = std::fs::read_to_string(p).unwrap();
        assert!(pristine.contains("_class = \"NmSkeletonList\""), "stage predates the strip fix");
        let mut mirror = pristine.clone();
        let stripped = strip_modeldoc_unloadables(&mut mirror);
        assert_eq!(stripped, 2, "doorman carries exactly the two unloadable nodes");
        let mut edited = mirror.clone();
        let n = restore_modeldoc_unloadables(&mut edited, &pristine).expect("restore");
        assert_eq!(n, 2);
        for class in MODELDOC_UNLOADABLE {
            let (s, e) = find_node_block(&pristine, class).unwrap();
            assert!(
                edited.contains(&pristine[s..e]),
                "{class} must come back byte-identical"
            );
        }
    }

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
        let out = generate_vmdl(MINI_VMDL, &["m.fbx".to_string()], None, &remaps, 1.0).unwrap();
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
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_staging/haze/haze.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("haze.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![MaterialSpec {
                name: "eim_test".into(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
                effect: None,
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: Some(game_vmat.clone()),
            }],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: false,
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
    fn pow2_snapping_picks_the_closer_size() {
        assert_eq!(nearest_pow2(595), 512);
        assert_eq!(nearest_pow2(441), 512);
        assert_eq!(nearest_pow2(1024), 1024);
        assert_eq!(nearest_pow2(1023), 1024);
        assert_eq!(nearest_pow2(3), 4); // clamped floor
        assert_eq!(nearest_pow2(9000), 4096); // clamped ceiling
    }

    #[test]
    fn fbx_texture_refs_scan_finds_image_names() {
        // Printable runs ending in an image extension, nothing else.
        let bytes = b"\x00\x05junkAce Of Spades_back_Normal.png\x00\x0bnot_a_path\x00Body5F_Base_color.PNG\x00mesh.fbx\x00";
        let refs = scan_fbx_texture_refs(bytes);
        assert!(refs.iter().any(|r| r.ends_with("Ace Of Spades_back_Normal.png")), "{refs:?}");
        assert!(refs.iter().any(|r| r.ends_with("Body5F_Base_color.PNG")), "{refs:?}");
        assert!(!refs.iter().any(|r| r.contains("mesh.fbx")), "{refs:?}");
    }

    /// The user's real sona export links 30+ textures by name.
    #[test]
    fn fbx_texture_refs_on_the_real_export_if_present() {
        let p = Path::new(concat!(
            r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder",
            r"\ReferenceFiles\deadlock_moonah_doormanv4Test.fbx"
        ));
        if !p.exists() {
            return;
        }
        let refs = scan_fbx_texture_refs(&std::fs::read(p).unwrap());
        assert!(refs.len() > 20, "expected many texture refs, got {}", refs.len());
        assert!(refs.iter().any(|r| r.to_lowercase().contains("normal")), "{refs:?}");
    }

    #[test]
    fn match_texture_files_assigns_from_a_list() {
        let files = vec![
            r"C:\art\Body5F_Base_color.png".to_string(),
            r"C:\art\Body5F_Normal.png".to_string(),
            r"C:\art\Eyes_Base_color.png".to_string(),
        ];
        let out = match_texture_files(&files, &["Body5F".into(), "Eyes".into(), "Fluff".into()]);
        let get = |n: &str| out.iter().find(|m| m.name == n).unwrap();
        assert!(get("Body5F").color.as_deref().unwrap().ends_with("Body5F_Base_color.png"));
        assert!(get("Body5F").normal.is_some());
        assert!(get("Eyes").color.is_some());
        assert!(get("Fluff").color.is_none());
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

    #[test]
    fn splice_vmat_params_replaces_and_inserts() {
        let vmat = "\"Layer0\"\n{\n\t\"shader\"\t\"pbr.vfx\"\n\t\"F_SELF_ILLUM\"\t\"1\"\n\t\"F_SELF_ILLUM_FRESNEL\"\t\"1\"\n\t\"g_flSelfIllumScale1\"\t\"0\"\n\t\"TextureColor1\"\t\"models/x/door_color.png\"\n}\n";
        let spec = MaterialSpec {
            name: "door".into(),
            color: None, normal: None, roughness: None, metalness: None,
            effect: Some("space".into()),
            fx_period: None,
            fx_intensity: Some(9.0),
            fx_speed: Some(2.0),
            fx_variant: None,
            fx_hue: None,
            game_vmat: Some("models/x/door.vmat".into()),
        };
        let (pairs, blocks) = fx_splice_parts(&spec, "models/x/door_color.png");
        let out = splice_vmat_params(vmat, &pairs, &blocks);
        // Existing keys replaced in place, not duplicated.
        assert_eq!(out.matches("\"g_flSelfIllumScale1\"").count(), 1, "{out}");
        assert!(out.contains("\t\"g_flSelfIllumScale1\"\t\"9\""), "{out}");
        // The closing-quote needle must NOT swallow the FRESNEL variant.
        assert!(out.contains("\"F_SELF_ILLUM_FRESNEL\"\t\"1\""), "{out}");
        // New keys land inside the block, speed-scaled (0.1*2, 0.4*2). The
        // garment albedo is NOT scrolled on game materials.
        assert!(!out.contains("g_vAlbedoScrollSpeed1"), "{out}");
        assert!(out.contains("\"g_vSelfIllumScrollSpeed1\"\t\"[0.200000 0.100000 0.000000 0.000000]\""), "{out}");
        assert!(out.contains("\"g_vNormalAndRoughnessScrollSpeed1\"\t\"[0.800000 0.400000 0.000000 0.000000]\""), "{out}");
        assert!(out.contains("\"g_flSelfIllumAlbedoFactor1\"\t\"0\""), "dark suits still get bright stars: {out}");
        assert!(out.contains("\"TextureSelfIllumMask1\"\t\"models/x/door_color.png\""), "{out}");
        let close = out.rfind('}').unwrap();
        let last_key = out.rfind("ScrollSpeed1").unwrap();
        assert!(last_key < close, "inserted keys must sit inside the braces");

        // Pulse: the DynamicParams block appends verbatim, once.
        let pulse = MaterialSpec { effect: Some("pulse".into()), ..spec };
        let (pairs, blocks) = fx_splice_parts(&pulse, "[1.000000 1.000000 1.000000 0.000000]");
        let out = splice_vmat_params(vmat, &pairs, &blocks);
        assert_eq!(out.matches("\"DynamicParams\"").count(), 1, "{out}");
        assert!(out.contains("sin( Time"), "{out}");
        let out2 = splice_vmat_params(&out, &pairs, &blocks);
        assert_eq!(out2.matches("\"DynamicParams\"").count(), 1, "resplice must not duplicate");
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
                // The void-skin recipe must compile too.
                effect: Some("space".into()),
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: None,
            },
            MaterialSpec {
                name: "Ace Of Spades_back".into(),
                color: Some(png.into()),
                normal: None,
                roughness: None,
                metalness: None,
                effect: None,
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: None,
            },
            // Fully automatic effects: NO texture given - the bundled
            // starfield must kick in and every preset must compile.
            MaterialSpec {
                name: "auto_space".into(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
                effect: Some("space".into()),
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: None,
            },
            MaterialSpec {
                name: "auto_cosmic".into(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
                effect: Some("cosmic".into()),
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: None,
            },
            MaterialSpec {
                name: "auto_pulse".into(),
                color: None,
                normal: None,
                roughness: None,
                metalness: None,
                effect: Some("pulse".into()),
                // Tuned: slow 4s pulse peaking at 10.
                fx_period: Some(4.0),
                fx_intensity: Some(10.0),
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                game_vmat: None,
            },
            MaterialSpec {
                name: "auto_glass".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("glass".into()), fx_period: None, fx_intensity: None, fx_speed: None, fx_variant: None, fx_hue: None, game_vmat: None,
            },
            MaterialSpec {
                name: "auto_ghost".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("ghost".into()), fx_period: None, fx_intensity: None, fx_speed: None, fx_variant: None, fx_hue: None, game_vmat: None,
            },
            MaterialSpec {
                name: "auto_sheen".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("sheen".into()), fx_period: None, fx_intensity: None, fx_speed: None, fx_variant: None, fx_hue: None, game_vmat: None,
            },
            MaterialSpec {
                name: "auto_unlit".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("unlit".into()), fx_period: None, fx_intensity: None, fx_speed: None, fx_variant: None, fx_hue: None, game_vmat: None,
            },
            // Tuned starfield: 3x drift speed, brighter glow.
            MaterialSpec {
                name: "speedy_space".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("space".into()), fx_period: None, fx_intensity: Some(12.0), fx_speed: Some(3.0), fx_variant: None, fx_hue: None, game_vmat: None,
            },
            // Fx ON a real game material: decompile doorman's door vmat,
            // splice the space recipe in, recompile at the bare mesh name.
            // Hubble star set + a blue hue while at it.
            MaterialSpec {
                name: "door_fx".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("space".into()), fx_period: None, fx_intensity: None, fx_speed: None,
                fx_variant: Some("hubble".into()), fx_hue: Some(220.0),
                game_vmat: Some("models/heroes_wip/doorman/materials/doorman_door.vmat".into()),
            },
            // The NASA set must also work as the textureless fallback.
            MaterialSpec {
                name: "auto_hubble".into(),
                color: None, normal: None, roughness: None, metalness: None,
                effect: Some("space".into()), fx_period: None, fx_intensity: None, fx_speed: None,
                fx_variant: Some("hubble".into()), fx_hue: Some(300.0), game_vmat: None,
            },
        ];
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let mut rep = ModelBuildReport::default();
        let arts = compile_materials(tools, "haze", &specs, &out_cache, None, Some(helper), Some(pak), &mut rep).expect("compile");
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        for a in &arts {
            eprintln!("ART {} <- {}", a.target_rel, a.artifact);
        }
        // Root-level vmat_c per spec, lowercased, spaces preserved.
        assert!(arts.iter().any(|a| a.target_rel == "eim_test.vmat_c"));
        assert!(arts.iter().any(|a| a.target_rel == "ace of spades_back.vmat_c"));
        for name in [
            "auto_space.vmat_c", "auto_cosmic.vmat_c", "auto_pulse.vmat_c",
            "auto_glass.vmat_c", "auto_ghost.vmat_c", "auto_sheen.vmat_c", "auto_unlit.vmat_c",
            "speedy_space.vmat_c",
        ] {
            assert!(
                arts.iter().any(|a| a.target_rel == name),
                "textureless {name} must compile from the bundled starfield: {arts:?}"
            );
        }
        // The game-material splice compiled at the bare mesh-material name,
        // and the NASA fallback field compiled too.
        assert!(
            arts.iter().any(|a| a.target_rel == "door_fx.vmat_c"),
            "fx-on-game-material must produce a bare-name vmat_c: {arts:?}"
        );
        assert!(
            arts.iter().any(|a| a.target_rel == "auto_hubble.vmat_c"),
            "hubble star set must compile from the bundled NASA field: {arts:?}"
        );
        assert!(
            rep.steps.iter().any(|s| s.contains("spliced into models/heroes_wip/doorman")),
            "{:?}",
            rep.steps
        );
        // The color texture compiled somewhere under materials/.
        assert!(arts.iter().any(|a| a.target_rel.starts_with("materials/") && a.target_rel.ends_with(".vtex_c")));
        assert!(arts.iter().all(|a| Path::new(&a.artifact).exists()));
        let _ = std::fs::remove_dir_all(&out_cache);
    }

    /// ModelDoc-edit preservation: build once, hand-edit the STAGED vmdl
    /// (as ModelDoc saving does), rebuild with `use_staged` - the edit must
    /// reach the artifact instead of being wiped by restaging. Ignored:
    /// needs this machine's installs.
    #[test]
    #[ignore]
    fn e2e_use_staged_preserves_manual_edits() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let fbx = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx");
        let scratch = std::env::temp_dir().join("eim_staged_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        let ws = workspace(helper, pak, "models/heroes_staging/haze/haze.vmdl_c", &scratch.join("ws"), false)
            .expect("workspace");
        let mut req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_staging/haze/haze.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: ws.materials.first().cloned(),
            import_scale: 0.01,
            artifact_out: scratch.join("haze.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        assert!(build(&req).ok, "normal build first");

        // "ModelDoc" edits the staged copy: change a camera value by hand.
        let staged = Path::new(cs2)
            .join("content/csgo_addons")
            .join(CS2_ADDON)
            .join("models/heroes_staging/haze/haze.vmdl");
        let text = std::fs::read_to_string(&staged).unwrap();
        let edited = apply_camera_overrides(
            &text,
            &[CameraKey { key: "m_flCameraSideOffset".into(), value: -77.5 }],
        )
        .unwrap();
        std::fs::write(&staged, edited).unwrap();

        req.use_staged = true;
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);
        let s2v = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\_s2vcli\Source2Viewer-CLI.exe");
        if s2v.exists() {
            let out = std::process::Command::new(s2v)
                .args(["-i", &req.artifact_out, "-b", "DATA"])
                .output()
                .expect("run S2V");
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(
                text.contains("m_flCameraSideOffset = -77.5"),
                "the hand edit must survive into the artifact"
            );
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// DMX scanner against the user's REAL Blender Source 2 Tools export.
    #[test]
    #[ignore]
    fn e2e_dmx_materials_on_the_real_export() {
        let p = Path::new(concat!(
            r"C:\Users\ethob\Desktop\PhilFolio\Projects\Moonah\DoormanNardo",
            r"\MoonahDoormanREMASTER\Export\doorman_body_default.dmx"
        ));
        if !p.exists() {
            eprintln!("skipping: DMX missing");
            return;
        }
        let mats = scan_dmx_materials(&std::fs::read(p).unwrap());
        eprintln!("DMX MATERIALS {mats:?}");
        assert!(mats.contains(&"Body5F".to_string()), "{mats:?}");
        assert!(mats.contains(&"doorman_body".to_string()), "{mats:?}");
        assert!(mats.len() >= 4, "{mats:?}");
    }

    /// The community DMX flow end to end: doorman rebuilt from the user's
    /// real multi-DMX export (one file per Blender collection), fast build,
    /// via CS2. Ignored: needs that machine's files + installs.
    #[test]
    #[ignore]
    fn e2e_doorman_multi_dmx_build() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let exp = Path::new(concat!(
            r"C:\Users\ethob\Desktop\PhilFolio\Projects\Moonah\DoormanNardo",
            r"\MoonahDoormanREMASTER\Export"
        ));
        if !exp.exists() {
            eprintln!("skipping: export folder missing");
            return;
        }
        // Every root-level DMX; the anims/ subfolder is animation data, not
        // meshes.
        let mut meshes: Vec<String> = std::fs::read_dir(exp)
            .unwrap()
            .flatten()
            .filter(|e| e.path().is_file())
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("dmx")))
            .map(|e| e.path().to_string_lossy().into_owned())
            .collect();
        meshes.sort();
        eprintln!("MESHES {}: {meshes:#?}", meshes.len());
        assert!(meshes.len() >= 5);
        let all_mats = scan_mesh_materials(&meshes);
        eprintln!("ALL MATERIALS {all_mats:?}");

        let scratch = std::env::temp_dir().join("eim_dmx_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        let ws = workspace(
            helper,
            pak,
            "models/heroes_wip/doorman_v2/doorman.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        let t0 = std::time::Instant::now();
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: String::new(),
            mesh_files: meshes,
            material_override: ws.materials.first().cloned(),
            import_scale: 1.0, // DMX via the community 39.37 flow is 1:1
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        eprintln!("DMX BUILD took {:.1}s", t0.elapsed().as_secs_f32());
        assert!(rep.ok, "{:?}", rep.steps);
        assert!(std::path::Path::new(&req.artifact_out).exists());
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// Fast build: stripping the baked AnimationList (community standard)
    /// must still produce a valid artifact with exact attachments, much
    /// faster. Ignored: needs this machine's installs.
    #[test]
    #[ignore]
    fn e2e_fast_build_skips_anims() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let cs2 = r"D:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive";
        let fbx = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx");
        let scratch = std::env::temp_dir().join("eim_fastbuild_e2e");
        let _ = std::fs::remove_dir_all(&scratch);
        let ws = workspace(helper, pak, "models/heroes_staging/haze/haze.vmdl_c", &scratch.join("ws"), false)
            .expect("workspace");
        let t0 = std::time::Instant::now();
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_staging/haze/haze.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: ws.materials.first().cloned(),
            import_scale: 0.01,
            artifact_out: scratch.join("haze.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: None,
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: true,
            camera: vec![],
        };
        let rep = build(&req);
        let secs = t0.elapsed().as_secs_f32();
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        eprintln!("FAST BUILD took {secs:.1}s");
        assert!(rep.ok, "{:?}", rep.steps);
        assert!(rep.steps.iter().any(|s| s.contains("fast build")), "{:?}", rep.steps);
        // Attachments still exact (they live in MDAT, independent of anims).
        let s2v = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\_s2vcli\Source2Viewer-CLI.exe");
        if s2v.exists() {
            let out = std::process::Command::new(s2v)
                .args(["-i", &req.artifact_out, "-b", "MDAT"])
                .output()
                .expect("run S2V");
            let ours: std::collections::HashMap<String, VanillaAttachment> =
                parse_mdat_attachments(&String::from_utf8_lossy(&out.stdout)).into_iter().collect();
            let root_aim = ours.get("root_aim").expect("root_aim survives");
            assert!((root_aim.angles[0] + 90.0).abs() < 0.05, "{root_aim:?}");
            assert!((root_aim.angles[1] + 90.0).abs() < 0.05, "{root_aim:?}");
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    /// The "import the FBX and you're done" path, on the user's real sona
    /// export: its materials must come back with color maps resolved from
    /// the paths Blender baked into the file. Ignored: needs that machine's
    /// files.
    #[test]
    #[ignore]
    fn e2e_fbx_auto_textures_on_the_real_export() {
        let fbx = Path::new(
            r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\ReferenceFiles\deadlock_moonah_doormanv4Test.fbx",
        );
        if !fbx.exists() {
            eprintln!("skipping: FBX missing");
            return;
        }
        let pf = preflight_fbx_kind(fbx, &[], false).expect("preflight");
        let resolved = resolve_fbx_textures(fbx);
        eprintln!("RESOLVED {} of {} refs", resolved.len(), scan_fbx_texture_refs(&std::fs::read(fbx).unwrap()).len());
        for r in resolved.iter().take(4) {
            eprintln!("  {r}");
        }
        let matched = match_texture_files(&resolved, &pf.materials);
        let with_color: Vec<&MatchedMaterial> = matched.iter().filter(|m| m.color.is_some()).collect();
        for m in &matched {
            eprintln!(
                "  {} -> color {} normal {} rough {}",
                m.name,
                m.color.is_some(),
                m.normal.is_some(),
                m.roughness.is_some()
            );
        }
        // Only 4 of the sona's 7 materials CAN resolve on this machine: the
        // rest were exported from an E: drive that isn't attached, so their
        // files genuinely do not exist. This asserts the ceiling, not a wish.
        assert!(
            with_color.len() >= 4,
            "expected the on-disk textures to auto-resolve, got {}",
            with_color.len()
        );
        assert!(
            matched.iter().any(|m| m.name == "Body5F" && m.color.is_some()),
            "Body5F's texture is on disk and must be found"
        );
    }

    /// What a bare mesh (nothing textured in Blender) yields - the
    /// steamhappy test file. Ignored: needs that machine's download.
    #[test]
    #[ignore]
    fn e2e_fbx_auto_textures_on_a_bare_mesh() {
        let fbx = Path::new(concat!(r"C:\Users\ethob", r"\Downloads\steamhappy.fbx"));
        if !fbx.exists() {
            eprintln!("skipping: FBX missing");
            return;
        }
        let bytes = std::fs::read(fbx).unwrap();
        let refs = scan_fbx_texture_refs(&bytes);
        let resolved = resolve_fbx_textures(fbx);
        let pf = preflight_fbx_kind(fbx, &[], false).expect("preflight");
        eprintln!("MATERIALS {:?}", pf.materials);
        eprintln!("TEXTURE REFS {refs:?}");
        eprintln!("RESOLVED {resolved:?}");
        eprintln!("MESH INFO {:?}", pf.info);
    }

    /// A `.jpeg` texture must compile: resourcecompiler rejects the extension
    /// outright ("Unknown file type"), so staging has to normalize it to a
    /// real PNG first. Reproduces the user's steamhappy build failure.
    #[test]
    #[ignore]
    fn e2e_jpeg_texture_normalizes_and_compiles() {
        let tools = Path::new(r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12");
        let jpeg = Path::new(
            r"C:\Users\ethob\AppData\Local\Temp\claude\C--Users-ethob-Desktop-DeadlockModding-EasyIntroModder\1f5318c3-f88e-405a-8761-0959a6b52035\scratchpad\jpegtest\steamhappy_roughness.jpeg",
        );
        if !tools.exists() || !jpeg.exists() {
            eprintln!("skipping: tools or fixture missing");
            return;
        }
        let out_cache = std::env::temp_dir().join("eim_jpeg_e2e");
        let _ = std::fs::remove_dir_all(&out_cache);
        let specs = vec![MaterialSpec {
            name: "steamhappy".into(),
            color: Some(jpeg.to_string_lossy().into_owned()),
            normal: None,
            roughness: Some(jpeg.to_string_lossy().into_owned()),
            metalness: None,
                effect: None,
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
            game_vmat: None,
        }];
        let mut rep = ModelBuildReport::default();
        let arts = compile_materials(tools, "idol_urn", &specs, &out_cache, None, None, None, &mut rep)
            .expect("a .jpeg texture must compile after normalization");
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(arts.iter().any(|a| a.target_rel == "steamhappy.vmat_c"), "{arts:?}");
        // And the staged source really became a PNG.
        let staged = tools.join("content/citadel_addons/eim_models/materials/eim_models/idol_urn");
        let names: Vec<String> = std::fs::read_dir(&staged)
            .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
            .unwrap_or_default();
        assert!(names.iter().all(|n| !n.to_lowercase().ends_with(".jpeg")), "{names:?}");
        assert!(names.iter().any(|n| n.to_lowercase().ends_with(".png")), "{names:?}");
        let _ = std::fs::remove_dir_all(&out_cache);
    }

    /// Object (non-hero) replacement end to end through the DEADLOCK CSDK -
    /// no CS2 involved: decompile the soul container, swap in the test cube,
    /// compile, and confirm the artifact carries the new mesh's material.
    /// Ignored: needs this machine's game + tools installs.
    #[test]
    #[ignore]
    fn e2e_prop_build_via_csdk() {
        let helper = r"C:\Users\ethob\Desktop\DeadlockModding\EasyIntroModder\tools\vpk-helper\dist\vpk-helper.exe";
        let pak = r"D:\SteamLibrary\steamapps\common\Deadlock\game\citadel\pak01_dir.vpk";
        let tools = r"C:\Users\ethob\Desktop\DeadlockModding\Reduced_CSDK_12";
        let fbx = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/eim_testcube.fbx");
        let scratch = std::env::temp_dir().join("eim_prop_e2e");
        let _ = std::fs::remove_dir_all(&scratch);

        let ws = workspace(
            helper,
            pak,
            "models/props_gameplay/soul_container/soul_container.vmdl_c",
            &scratch.join("ws"),
            false,
        )
        .expect("workspace");
        assert!(ws.files >= 2, "vmdl + mesh dmx: {}", ws.files);

        let req = ModelBuildReq {
            cs2_root: String::new(), // props never touch CS2
            kind: ModelKind::Prop,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/props_gameplay/soul_container/soul_container.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("soul_container.vmdl_c").to_string_lossy().into_owned(),
            materials: vec![],
            tools_root: Some(tools.into()),
            materials_out: None,
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: false,
            camera: vec![],
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);
        let bytes = std::fs::read(&req.artifact_out).expect("artifact");
        let refs = scan_vmdl_material_refs(&bytes);
        eprintln!("REFS {refs:?}");
        assert!(
            refs.iter().any(|r| r.contains("eim_test")),
            "the swapped mesh's material must be referenced: {refs:?}"
        );
        let _ = std::fs::remove_dir_all(&scratch);
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
                effect: None,
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                        game_vmat: Some(path.clone()),
                    },
                    None => MaterialSpec {
                        name: m.clone(),
                        color: Some(png.into()),
                        normal: None,
                        roughness: None,
                        metalness: None,
                effect: None,
                fx_period: None,
                fx_intensity: None,
                fx_speed: None,
                fx_variant: None,
                fx_hue: None,
                        game_vmat: None,
                    },
                }
            })
            .collect();
        let remapped = specs.iter().filter(|s| s.game_vmat.is_some()).count();
        eprintln!("SPECS {} textured, {remapped} remapped to game vmats", specs.len() - remapped);
        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            kind: ModelKind::Hero,
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_wip/doorman_v2/doorman.vmdl".into(),
            mesh_file: fbx.into(),
            mesh_files: vec![],
            material_override: None,
            import_scale: 0.01,
            artifact_out: scratch.join("doorman.vmdl_c").to_string_lossy().into_owned(),
            materials: specs.clone(),
            tools_root: Some(tools.into()),
            materials_out: Some(scratch.join("doorman_mats").to_string_lossy().into_owned()),
            ffmpeg_path: None,
            helper_path: None,
            pak_path: None,
            use_staged: false,
            skip_anims: false,
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
