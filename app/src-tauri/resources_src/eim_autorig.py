# EIM auto-rig: bind a custom model to a hero's skeleton, headlessly.
#
#   blender --background --factory-startup --python autorig.py -- \
#     --hero-glb <hero .glb from the app's Blender download> \
#     --model <user model: .fbx/.obj/.glb/.gltf> \
#     --out <output .fbx> \
#     [--mode transfer|rigid] [--rigid-bone <bone>] [--no-fit]
#
# transfer: copy skin weights from the hero's own body mesh onto the user
#           mesh by nearest-surface interpolation (the community's manual
#           "transfer weights" recipe, automated). Works best on humanoid-ish
#           models standing roughly like the hero.
# rigid:    bind every vertex 100% to one bone - the model follows the hero
#           as one solid piece (cars, blocks, props).
#
# Prints EIM_AUTORIG_OK / EIM_AUTORIG_ERR markers for the app to parse.
import bpy, sys, os, math

def die(msg):
    print(f"EIM_AUTORIG_ERR {msg}", flush=True)
    sys.exit(1)

def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    opts = {"mode": "transfer", "rigid_bone": "", "fit": True}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--hero-glb":
            opts["hero_glb"] = argv[i + 1]; i += 2
        elif a == "--model":
            opts["model"] = argv[i + 1]; i += 2
        elif a == "--out":
            opts["out"] = argv[i + 1]; i += 2
        elif a == "--mode":
            opts["mode"] = argv[i + 1]; i += 2
        elif a == "--rigid-bone":
            opts["rigid_bone"] = argv[i + 1]; i += 2
        elif a == "--no-fit":
            opts["fit"] = False; i += 1
        else:
            i += 1
    for k in ("hero_glb", "model", "out"):
        if k not in opts:
            die(f"missing --{k.replace('_', '-')}")
    return opts

def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.armatures, bpy.data.materials, bpy.data.images):
        for d in list(block):
            if d.users == 0:
                block.remove(d)

def import_any(path):
    """Import a model file; returns the set of objects it added."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    else:
        die(f"unsupported model type {ext} (use fbx, obj, glb or gltf)")
    return [o for o in bpy.data.objects if o not in before]

def world_bbox(objs):
    pts = []
    for o in objs:
        for c in o.bound_box:
            pts.append(o.matrix_world @ __import__("mathutils").Vector(c))
    if not pts:
        return None
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    return (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))

opts = parse_args()
clear_scene()

GAME_UNITS_PER_METER = 39.3701  # the community's Source 2 export convention

def apply_all(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# --- clean: fix what blocks a build WITHOUT touching the rigging ------------
# For hand-rigged or ported models that preflight rejects: bake un-applied
# object transforms, strip vertex colors, fix .001/dotted names, sanitize
# material names, and rigid-bind weightless meshes (physics helpers) to
# their nearest bone. Weights, bones and meshes are all KEPT - extra bones
# beyond the hero's compile fine and ride with their parent (proven vs the
# real CS2 compiler). --hero-glb is accepted but unused here.
if opts["mode"] == "clean":
    import re
    from mathutils import Vector

    user_objs = import_any(opts["model"])
    meshes = [o for o in user_objs if o.type == "MESH"]
    if not meshes:
        die("no meshes found in the model file")
    arm = next((o for o in user_objs if o.type == "ARMATURE"), None)

    # Un-parent keep-transform, then bake EVERYTHING to identity. Baking the
    # armature moves its rest pose to world space right alongside the baked
    # mesh data, so the bind is preserved.
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    apply_all(meshes + ([arm] if arm else []))

    for i, o in enumerate(meshes):
        # Vertex colors can render the model black in game - drop them.
        if hasattr(o.data, "color_attributes"):
            for ca in list(o.data.color_attributes):
                o.data.color_attributes.remove(ca)
        # .001 suffixes / dots upset the model tools; keep names recognizable.
        base = re.sub(r"\.\d+$", "", o.name).replace(".", "_") or f"part_{i + 1}"
        if base != o.name:
            o.name = base  # Blender re-suffixes on collision; rare and harmless
        o.data.name = o.name

    # Material names travel into the game build - same cleanup as auto-rig.
    for o in meshes:
        for slot in o.material_slots:
            if slot.material:
                clean = re.sub(r"\.\d+$", "", slot.material.name).replace(" ", "_")
                if clean and clean != slot.material.name:
                    existing = bpy.data.materials.get(clean)
                    if existing is not None:
                        slot.material = existing
                    else:
                        slot.material.name = clean

    # Weightless meshes (ported physics/collision helpers) ride their nearest
    # bone solid instead of floating detached from the hero.
    bound = 0
    if arm is not None:
        def nearest_bone(point):
            best, best_d = None, None
            for b in arm.data.bones:
                d = (b.head_local - point).length
                if best_d is None or d < best_d:
                    best, best_d = b.name, d
            return best

        for o in meshes:
            has_weights = bool(o.vertex_groups) and any(len(v.groups) for v in o.data.vertices)
            if not has_weights:
                center = sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / max(
                    1, len(o.data.vertices)
                )
                bone = nearest_bone(center)
                if bone:
                    vg = o.vertex_groups.get(bone) or o.vertex_groups.new(name=bone)
                    vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")
                    bound += 1

        # Re-bind: every deforming mesh gets the armature modifier + parent
        # (transforms are identity now, so a plain parent set is exact).
        for o in meshes:
            if o.vertex_groups:
                mod = next((m for m in o.modifiers if m.type == "ARMATURE"), None)
                if mod is None:
                    mod = o.modifiers.new(name="Armature", type="ARMATURE")
                mod.object = arm
                o.parent = arm

    bpy.ops.object.select_all(action="SELECT")
    os.makedirs(os.path.dirname(opts["out"]), exist_ok=True)
    bpy.ops.export_scene.fbx(
        filepath=opts["out"],
        use_selection=True,
        object_types={"ARMATURE", "MESH"},
        add_leaf_bones=False,
        bake_anim=False,
        mesh_smooth_type="FACE",
    )
    print(
        f"EIM_AUTORIG_OK meshes={len(meshes)} rigged={sum(1 for o in meshes if o.vertex_groups)} bound={bound} out={opts['out']}",
        flush=True,
    )
    sys.exit(0)

# --- Hero kit: armature + its skinned body (the weight source) --------------
hero_objs = import_any(opts["hero_glb"])
armature = next((o for o in hero_objs if o.type == "ARMATURE"), None)
if armature is None:
    die("hero glb has no armature - re-download the hero's Blender model in the app")
hero_meshes = [o for o in hero_objs if o.type == "MESH"]
skinned = [o for o in hero_meshes if o.vertex_groups]
if opts["mode"] == "transfer" and not skinned:
    die("hero glb has no skinned meshes to copy weights from")
# The body = the biggest skinned mesh.
source = max(skinned, key=lambda o: len(o.data.vertices)) if skinned else None
bone_names = {b.name for b in armature.data.bones}

# Normalize the kit: the glb carries an inch->meter scale + axis rotation on
# the armature that everything inherits. Un-parent, blow the whole scene up
# to game units, and bake EVERYTHING to identity - the exported FBX must not
# carry any object transform (the app's preflight rejects those).
from mathutils import Matrix
bpy.ops.object.select_all(action="DESELECT")
for o in hero_meshes:
    o.select_set(True)
if hero_meshes:
    bpy.context.view_layer.objects.active = hero_meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
S = Matrix.Scale(GAME_UNITS_PER_METER, 4)
for o in [armature] + hero_meshes:
    o.matrix_world = S @ o.matrix_world
apply_all([armature] + hero_meshes)
# The glb names the armature after the vmdl path - dots in names upset the
# model tools, and only BONE names matter for binding.
armature.name = "skeleton"
armature.data.name = "skeleton"
hero_bb = world_bbox([o for o in hero_meshes if o.vertex_groups] or hero_meshes or [armature])

# --- User model -------------------------------------------------------------
user_objs = import_any(opts["model"])
user_meshes = [o for o in user_objs if o.type == "MESH"]
if not user_meshes:
    die("no meshes found in the model file")
# Their own rig (if any) is replaced by the hero's.
for o in user_objs:
    if o.type == "ARMATURE":
        bpy.data.objects.remove(o, do_unlink=True)
for i, o in enumerate(user_meshes):
    o.parent = None
    o.vertex_groups.clear()
    for m in list(o.modifiers):
        o.modifiers.remove(m)
    # Clean names: dots / path junk / .001 suffixes upset the model tools.
    o.name = "part" if i == 0 else f"part_{i + 1}"
    o.data.name = o.name
    # Vertex colors can render a model black in game - drop them.
    if hasattr(o.data, "color_attributes"):
        for ca in list(o.data.color_attributes):
            o.data.color_attributes.remove(ca)

# Material names travel into the game build - Blender's .001 suffixes and
# spaces break the compiler's material handling. Same-name slots after the
# cleanup simply share one material, which is what the compiler does anyway.
import re
for o in user_meshes:
    for slot in o.material_slots:
        if slot.material:
            clean = re.sub(r"\.\d+$", "", slot.material.name).replace(" ", "_")
            if clean and clean != slot.material.name:
                existing = bpy.data.materials.get(clean)
                if existing is not None:
                    slot.material = existing
                else:
                    slot.material.name = clean

# --- Fit: match the hero's height, feet on the ground, centered -------------
if opts["fit"] and hero_bb:
    ub = world_bbox(user_meshes)
    hero_h = hero_bb[5] - hero_bb[2]
    user_h = ub[5] - ub[2]
    if user_h > 1e-6 and hero_h > 1e-6:
        s = hero_h / user_h
        ucx, ucy = (ub[0] + ub[3]) / 2, (ub[1] + ub[4]) / 2
        hcx, hcy = (hero_bb[0] + hero_bb[3]) / 2, (hero_bb[1] + hero_bb[4]) / 2
        from mathutils import Matrix, Vector
        pivot = Vector((ucx, ucy, ub[2]))
        target = Vector((hcx, hcy, hero_bb[2]))
        xform = (
            Matrix.Translation(target)
            @ Matrix.Scale(s, 4)
            @ Matrix.Translation(-pivot)
        )
        for o in user_meshes:
            o.matrix_world = xform @ o.matrix_world

# Bake transforms into the meshes (the community checklist's "Apply All").
bpy.ops.object.select_all(action="DESELECT")
for o in user_meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = user_meshes[0]
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# --- Rig --------------------------------------------------------------------
if opts["mode"] == "rigid":
    bone = opts["rigid_bone"] or (armature.data.bones[0].name if armature.data.bones else "")
    if bone not in bone_names:
        die(f"bone '{bone}' not in the hero's skeleton")
    for o in user_meshes:
        vg = o.vertex_groups.new(name=bone)
        vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")
else:
    def nearest_bone(point):
        """Closest deform-ish bone to a world point (armature is at identity)."""
        best, best_d = None, None
        for b in armature.data.bones:
            d = (b.head_local - point).length
            if best_d is None or d < best_d:
                best, best_d = b.name, d
        return best

    # Nearest-face-interpolated weight transfer from the hero's body.
    for o in user_meshes:
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        source.select_set(True)
        bpy.context.view_layer.objects.active = source
        bpy.ops.object.data_transfer(
            data_type="VGROUP_WEIGHTS",
            use_create=True,
            vert_mapping="POLYINTERP_NEAREST",
            layers_select_src="ALL",
            layers_select_dst="NAME",
        )
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        if o.vertex_groups:
            # Game-safe influences: at most 4 bones per vertex, normalized.
            bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
            bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL", lock_active=False)
            bpy.ops.object.vertex_group_clean(group_select_mode="ALL", limit=0.001)
        if not o.vertex_groups:
            # Nothing transferred (a floater far off the body, or everything
            # cleaned away): bind the piece solid to its nearest bone so it
            # still rides the hero instead of breaking the export.
            from mathutils import Vector
            center = sum((o.matrix_world @ v.co for v in o.data.vertices), Vector()) / max(
                1, len(o.data.vertices)
            )
            bone = nearest_bone(center)
            if bone:
                vg = o.vertex_groups.new(name=bone)
                vg.add(range(len(o.data.vertices)), 1.0, "REPLACE")

# Groups that don't name a hero bone would fail the app's preflight.
for o in user_meshes:
    for vg in list(o.vertex_groups):
        if vg.name not in bone_names:
            o.vertex_groups.remove(vg)

# Bind: armature modifier + parent (keeps transforms; armature sits at origin).
for o in user_meshes:
    mod = o.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = armature
    o.parent = armature

# --- Strip the hero's own meshes; export mesh + skeleton --------------------
for o in hero_meshes:
    bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.object.select_all(action="SELECT")
os.makedirs(os.path.dirname(opts["out"]), exist_ok=True)
bpy.ops.export_scene.fbx(
    filepath=opts["out"],
    use_selection=True,
    object_types={"ARMATURE", "MESH"},
    add_leaf_bones=False,  # "_end" bones would be unknown to the game rig
    bake_anim=False,
    mesh_smooth_type="FACE",
)

rigged = sum(1 for o in user_meshes if o.vertex_groups)
groups = sorted({vg.name for o in user_meshes for vg in o.vertex_groups})
print(
    f"EIM_AUTORIG_OK meshes={len(user_meshes)} rigged={rigged} bones_used={len(groups)} out={opts['out']}",
    flush=True,
)
