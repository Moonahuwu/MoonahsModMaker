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
    /// File count of the decompiled tree.
    pub files: usize,
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

    let text = std::fs::read_to_string(&vmdl_abs).map_err(|e| e.to_string())?;
    let bones = parse_bone_names(&text);
    // Material paths live inside the mesh DMX files (binary, but the paths
    // are plain ASCII runs), not in the vmdl.
    let materials = scan_material_refs(&dir);
    let files = walk_count(&dir);
    Ok(ModelWorkspace {
        dir: dir.to_string_lossy().into_owned(),
        vmdl: vmdl_abs.to_string_lossy().into_owned(),
        bones,
        materials,
        files,
    })
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
            None => { cp = o; break; }
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
                        spaced.push(name);
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
        out.errors.push(format!(
            "names ending in .001-style numbers break the compile: {} - rename them in Blender",
            dot001.join(", ")
        ));
    }
    if !spaced.is_empty() {
        spaced.sort();
        spaced.dedup();
        out.errors.push(format!(
            "names with spaces break the FBX material lookup: {} - rename them in Blender (use _ instead)",
            spaced.join(", ")
        ));
    }
    if has_vertex_colors {
        out.warnings.push(
            "the mesh carries vertex colors - if the model looks glitchy in game, remove the Color Attributes in Blender's Object Data tab".into(),
        );
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// vmdl generation
// ---------------------------------------------------------------------------

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
/// - LODGroupList children   -> one LOD level referencing "body"
/// - BodyGroupList children  -> emptied (choices referenced the old meshes)
/// - optional MaterialGroupList override (whole model uses one game material)
/// Everything else (skeleton, attachments, cameras, hitboxes, cloth, anim
/// lists, NmSkeleton/AnimGraph2 references) rides through untouched.
pub fn generate_vmdl(src: &str, mesh_rel: &str, material_override: Option<&str>) -> Result<String, String> {
    let mut text = src.to_string();

    let mesh_block = format!(
        "[\n\t\t\t\t\t\t{{\n\t\t\t\t\t\t\t_class = \"RenderMeshFile\"\n\t\t\t\t\t\t\tname = \"body\"\n\t\t\t\t\t\t\tfilename = \"{mesh_rel}\"\n\t\t\t\t\t\t}},\n\t\t\t\t\t]"
    );
    let (a, b) = children_span(&text, "RenderMeshList", 0)
        .ok_or("vmdl has no RenderMeshList - refresh the hero kit")?;
    text.replace_range(a..b, &mesh_block);

    if let Some((a, b)) = children_span(&text, "LODGroupList", 0) {
        let lod_block = "[\n\t\t\t\t\t\t{\n\t\t\t\t\t\t\t_class = \"LODGroup\"\n\t\t\t\t\t\t\tswitch_threshold = 0.0\n\t\t\t\t\t\t\tmesh_references = \n\t\t\t\t\t\t\t[\n\t\t\t\t\t\t\t\t{\n\t\t\t\t\t\t\t\t\tmesh_name = \"body\"\n\t\t\t\t\t\t\t\t},\n\t\t\t\t\t\t\t]\n\t\t\t\t\t\t},\n\t\t\t\t\t]";
        text.replace_range(a..b, lod_block);
    }
    if let Some((a, b)) = children_span(&text, "BodyGroupList", 0) {
        text.replace_range(a..b, "[  ]");
    }

    if let Some(vmat) = material_override {
        // Insert a MaterialGroupList right before the RenderMeshList node's
        // enclosing block - proven pattern from the static model swaps.
        let group = format!(
            "{{\n\t\t\t\t_class = \"MaterialGroupList\"\n\t\t\t\tchildren = \n\t\t\t\t[\n\t\t\t\t\t{{\n\t\t\t\t\t\t_class = \"DefaultMaterialGroup\"\n\t\t\t\t\t\tremaps = [  ]\n\t\t\t\t\t\tuse_global_default = true\n\t\t\t\t\t\tglobal_default_material = \"{vmat}\"\n\t\t\t\t\t}},\n\t\t\t\t]\n\t\t\t}},\n\t\t\t"
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
    /// Where the compiled artifact is cached (absolute .vmdl_c path).
    pub artifact_out: String,
}

#[derive(serde::Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelBuildReport {
    pub ok: bool,
    pub steps: Vec<String>,
    pub artifact: Option<String>,
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
    let vmdl_dir_internal = vmdl_internal.rsplit_once('/').map(|(d, _)| d).unwrap_or("");

    // 1. Fresh CS2 content stage: the whole decompiled tree (anims included -
    //    the legacy AnimationList compiles from them) + the user's mesh.
    let content = cs2.join("content/csgo_addons").join(CS2_ADDON);
    let stage_dir = content.join(vmdl_dir_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let _ = std::fs::remove_dir_all(&stage_dir);
    copy_tree(Path::new(&req.workspace_dir), &content)?;
    rep.steps.push(format!("staged hero sources into CS2 addon {CS2_ADDON}"));

    let mesh_name = Path::new(&req.mesh_file)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned())
        .ok_or("mesh file has no name")?;
    let mesh_dest = stage_dir.join(&mesh_name);
    std::fs::copy(&req.mesh_file, &mesh_dest)
        .map_err(|e| format!("copy mesh into CS2 addon: {e}"))?;
    rep.steps.push(format!("mesh: {mesh_name}"));

    // 2. Generate the vmdl over the staged copy.
    let vmdl_abs = content.join(vmdl_internal.replace('/', std::path::MAIN_SEPARATOR_STR));
    let src = std::fs::read_to_string(&vmdl_abs).map_err(|e| e.to_string())?;
    let mesh_rel = format!("{vmdl_dir_internal}/{mesh_name}");
    let generated = generate_vmdl(&src, &mesh_rel, req.material_override.as_deref())?;
    std::fs::write(&vmdl_abs, generated).map_err(|e| e.to_string())?;
    rep.steps.push("generated vmdl (your mesh + the hero's skeleton, cameras and animation refs)".into());

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
        let out = generate_vmdl(MINI_VMDL, "models/x/custom.fbx", Some("models/a/b.vmat")).unwrap();
        assert!(out.contains("custom.fbx"), "user mesh referenced");
        assert!(!out.contains("x_gun.dmx"), "old meshes gone");
        assert!(!out.contains("mesh_name = \"gun\""), "old LOD refs gone");
        assert!(!out.contains("BodyGroup\""), "bodygroup choices emptied: {out}");
        assert!(out.contains("global_default_material = \"models/a/b.vmat\""));
        // Skeleton untouched.
        assert!(out.contains("name = \"pelvis\""));
        // Still balanced kv3-ish (same brace count parity).
        assert_eq!(out.matches('[').count(), out.matches(']').count());
        assert_eq!(out.matches('{').count(), out.matches('}').count());
    }

    #[test]
    fn generate_without_material_override_keeps_materials_out() {
        let out = generate_vmdl(MINI_VMDL, "m.fbx", None).unwrap();
        assert!(!out.contains("MaterialGroupList"));
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

        let req = ModelBuildReq {
            cs2_root: cs2.into(),
            workspace_dir: ws.dir.clone(),
            vmdl_internal: "models/heroes_staging/haze/haze.vmdl".into(),
            mesh_file: fbx.into(),
            material_override: ws.materials.first().cloned(),
            artifact_out: scratch.join("haze.vmdl_c").to_string_lossy().into_owned(),
        };
        let rep = build(&req);
        for s in &rep.steps {
            eprintln!("STEP {s}");
        }
        assert!(rep.ok, "{:?}", rep.steps);
        assert!(std::path::Path::new(&req.artifact_out).exists());
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
