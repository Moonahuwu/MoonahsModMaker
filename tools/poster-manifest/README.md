# poster-manifest

Generates `app/src/data/posterManifest.json` — the map of every in-game poster's
pixel rectangle inside the `materials/overlays/` atlas sheets (the "sprite sheets"
used by the world's poster/label overlay materials).

## How posters work in Deadlock

The map geometry carries baked UVs pointing each poster quad at a rectangle of a
2048x2048 atlas texture (e.g. `labels_posters_default_03_color`). There is no
index file in the game — the rectangles below were recovered from the trans
(translucency) masks + connected-component analysis + hand curation. Replacing a
poster = painting new art over exactly that rectangle in the color texture and
recompiling the `.vmat` (addon model, same recipe as audio compiles).

## Regenerating after a game patch (v2: from the maps' UVs)

Manifest v2 regions come from the compiled maps themselves, not from mask
guessing: every poster quad's UV rect is read out of the world geometry.

```sh
# 1. mine every map (seconds each; needs the helper built: dotnet build in tools/vpk-helper)
for m in dl_streets dl_midtown dl_hideout street_test hero_testing 1v1_test new_player_basics; do
  dotnet tools/vpk-helper/bin/Release/net10.0/vpk-helper.dll worldrects     "<Deadlock>/game/citadel/maps/$m.vpk" "<Deadlock>/game/citadel/pak01_dir.vpk" out/uv/${m}_rects.json
done
# 2. curate into the manifest (+ review overlays: green = placed region, grey = unused old one)
python curate_uv.py out/uv --overlays out/uv_overlays        # add --dry to preview only
```

`worldrects` walks the world nodes (world geometry + baked static props) and
entity models, and for every draw call on a `materials/overlays/*` (or
`models/hideout/materials/*`) material clusters the triangles into UV islands
with their model-space bounds. `curate_uv.py` then merges the pieces of one
decal split by wall seams (adjacent in UV AND in the world - the world test is
what keeps two signs stacked in a gutterless atlas apart), folds clipped
partial placements into their full region, unions trim bands sampled in
stretches, drops sub-32px slivers, keeps each region's old id when it overlaps
the old rect (IoU >= 0.5; users' overrides reference `sheet::id`), assigns
`item_NN` to the rest, flags old regions no map places as `unused: true`
(the app hides them by default), and recomputes `alphaCoverage` from the trans
mask. Regions carry `placements` = how many quads sample them across the maps.
The old mask pipeline below still exists for sheets no map references.

## Regenerating with the mask detector (v1, legacy)

Requires Python with `numpy` + `Pillow`. The decompiled overlay textures must be
present (helper `decompileall` / `refresh_vanilla` output) — default location is
`<repo>/VanillaFiles/materials/overlays`, or pass a dir as argv[1].

```sh
python detect_rects.py   # auto-detect used regions -> out/rects_raw.json + debug overlays
python curate.py         # merge auto + hand rects -> manifest + out/curated/*_overlay.png
```

`curate.py` writes the manifest straight to `app/src/data/posterManifest.json`.
Verify visually with the `out/curated/*_overlay.png` / `*_contact.png` images.
If Valve adds a new sheet, add it to `SHEETS` in both scripts; hand-split any
rects that the detector merges (adjacent posters with no background gutter).

## Manifest schema

```json
{
  "version": 1,
  "sheets": [{
    "id": "posters_bodega_comp1",
    "material": "materials/overlays/posters_bodega_comp1.vmat",
    "colorTexture": "posters_bodega_comp1.png",
    "transTexture": "posters_bodega_comp1_214d167e_trans.png",
    "width": 2048, "height": 2048,
    "posters": [{ "id": "black_cauldron", "x": 1081, "y": 1555, "w": 967, "h": 493,
                  "alphaCoverage": 0.998 }]
  }]
}
```

`alphaCoverage` = fraction of the rect that is opaque in the trans mask. ~1.0
means a solid rectangular poster; low values mean the trans mask is shaped
(cut-out letters/stickers) — when replacing those with full-frame art, the trans
texture's rect must also be filled white or the new art will be cut to the old
silhouette.
