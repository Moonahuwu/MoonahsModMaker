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

## Regenerating after a game patch

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
