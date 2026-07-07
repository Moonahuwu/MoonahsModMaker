"""Detect poster/sign/graffiti rectangles in Deadlock overlay atlas sheets.

Auto-discovers sheets by scanning the decompiled materials/overlays tree for
.vmat files in the wall-art families (posters, signage, ghost signs, graffiti,
sigils) and parsing their TextureColor / TextureTranslucency references.

Foreground = trans mask when present (ground truth for used regions), else
non-background color (flat filler sampled from corners). Foreground runs per
row are labeled with union-find across rows -> components -> bounding boxes.
Outputs out/rects_raw.json + debug overlay PNGs with indices.
"""
import json
import os
import re
import sys
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
OVERLAYS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    _REPO, "VanillaFiles", "materials", "overlays")
OUT = os.path.join(_HERE, "out")
os.makedirs(OUT, exist_ok=True)

# family pattern -> manifest category (first match wins, tested on the
# overlays-relative material path with forward slashes)
FAMILIES = [
    (r"^labels_posters", "posters"),
    (r"^posters_", "posters"),
    (r"^poster_", "posters"),
    (r"^signage_", "signage"),
    (r"^signs_", "signage"),
    (r"^street_signage", "signage"),
    (r"^subway_(signage|map)", "signage"),
    (r"^overlay_(ghostsign|bodega\d+a_ghostsign|store_stamp)", "ghostsigns"),
    (r"^(graffiti_|midboss_graffiti|graff/)", "graffiti"),
    (r"^(sigil_|museum/)", "sigils"),
]

# Sheets where the trans mask does NOT outline the art (opaque filler) — fall
# back to color-based background detection or hand curation.
TRANS_UNRELIABLE = {"labels_posters_default_04"}

TOL = 6          # per-channel tolerance around background color
MIN_AREA = 900   # ignore specks smaller than ~30x30
PAD_MERGE = 1    # merge rects whose expanded bounds overlap


class DSU:
    def __init__(self):
        self.p = []

    def make(self):
        self.p.append(len(self.p))
        return len(self.p) - 1

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def detect_background(rgb):
    h, w, _ = rgb.shape
    corners = [rgb[0, 0], rgb[0, w - 1], rgb[h - 1, 0], rgb[h - 1, w - 1]]
    votes = Counter(tuple(int(v) for v in c) for c in corners)
    color, n = votes.most_common(1)[0]
    return np.array(color, dtype=np.int16), n


def row_runs(mask_row):
    idx = np.flatnonzero(np.diff(np.concatenate(([0], mask_row.view(np.int8), [0]))))
    return list(zip(idx[0::2], idx[1::2]))


def components(mask):
    h, w = mask.shape
    dsu = DSU()
    prev = []
    boxes = {}
    all_runs = []
    for y in range(h):
        runs = row_runs(mask[y])
        cur = []
        for s, e in runs:
            lbl = dsu.make()
            for ps, pe, plbl in prev:
                if ps < e and s < pe:
                    dsu.union(plbl, lbl)
            cur.append((s, e, lbl))
            all_runs.append((y, s, e, lbl))
        prev = cur
    for y, s, e, lbl in all_runs:
        r = dsu.find(lbl)
        b = boxes.get(r)
        if b is None:
            boxes[r] = [int(s), y, int(e), y + 1, int(e - s)]
        else:
            b[0] = min(b[0], int(s))
            b[2] = max(b[2], int(e))
            b[3] = y + 1
            b[4] += int(e - s)
    return [b for b in boxes.values() if b[4] >= MIN_AREA]


def merge_overlapping(rects):
    changed = True
    rects = [list(r) for r in rects]
    while changed:
        changed = False
        out = []
        while rects:
            a = rects.pop()
            merged = False
            for b in out:
                if (a[0] - PAD_MERGE < b[2] and b[0] - PAD_MERGE < a[2]
                        and a[1] - PAD_MERGE < b[3] and b[1] - PAD_MERGE < a[3]):
                    b[0] = min(a[0], b[0]); b[1] = min(a[1], b[1])
                    b[2] = max(a[2], b[2]); b[3] = max(a[3], b[3])
                    b[4] += a[4]
                    merged = changed = True
                    break
            if not merged:
                out.append(a)
        rects = out
    return rects


# matches TextureColor / TextureColor1 / TextureTranslucency...; only real
# texture paths (some vmats use constant color vectors instead)
_TEX_RE = re.compile(r'"Texture(Color|Translucency)\d*"\s+"(materials/[^"]+)"')


def discover_sheets():
    """Scan overlays tree for wall-art vmats -> [(id, category, color_rel, trans_rel)]."""
    sheets = []
    for root, _, files in os.walk(OVERLAYS):
        for fn in files:
            if not fn.endswith(".vmat"):
                continue
            rel = os.path.relpath(os.path.join(root, fn), OVERLAYS).replace("\\", "/")
            sheet_id = rel[:-5]
            category = None
            for pat, cat in FAMILIES:
                if re.search(pat, sheet_id):
                    category = cat
                    break
            if category is None:
                continue
            text = open(os.path.join(root, fn), encoding="utf-8", errors="replace").read()
            tex = dict(_TEX_RE.findall(text))
            color = tex.get("Color", "")
            prefix = "materials/overlays/"
            if not color.startswith(prefix):
                print(f"SKIP {sheet_id}: no overlay color texture ({color or 'none'})")
                continue
            color_rel = color[len(prefix):]
            trans = tex.get("Translucency", "")
            trans_rel = trans[len(prefix):] if trans.startswith(prefix) else None
            if sheet_id in TRANS_UNRELIABLE:
                trans_rel_detect = None
            else:
                trans_rel_detect = trans_rel
            sheets.append((sheet_id, category, color_rel, trans_rel, trans_rel_detect))
    sheets.sort()
    return sheets


def main():
    result = {}
    try:
        font = ImageFont.truetype("arial.ttf", 44)
    except OSError:
        font = ImageFont.load_default()
    # one sheet entry per color texture; extra materials sharing it are recorded
    by_color = {}
    for sheet_id, category, color_rel, trans_rel, trans_detect in discover_sheets():
        if color_rel in by_color:
            by_color[color_rel]["materials"].append(f"materials/overlays/{sheet_id}.vmat")
            continue
        path = os.path.join(OVERLAYS, color_rel)
        if not os.path.exists(path):
            print(f"SKIP {sheet_id}: missing color texture {color_rel}")
            continue
        img = Image.open(path).convert("RGB")
        rgb = np.asarray(img, dtype=np.int16)
        h, w, _ = rgb.shape
        entry = {
            "id": sheet_id, "category": category,
            "materials": [f"materials/overlays/{sheet_id}.vmat"],
            "colorTexture": color_rel, "transTexture": trans_rel,
            "width": w, "height": h, "rects": [],
        }
        fg = None
        if trans_detect:
            tpath = os.path.join(OVERLAYS, trans_detect)
            if os.path.exists(tpath):
                tr = np.asarray(Image.open(tpath).convert("L").resize((w, h), Image.NEAREST))
                fg = tr > 128
                entry["source"] = "trans"
                entry["used_fraction"] = round(float(fg.mean()), 4)
        if fg is None:
            bg, corner_votes = detect_background(rgb)
            mask_bg = (np.abs(rgb - bg) <= TOL).all(axis=2)
            fg = ~mask_bg
            entry["source"] = "color"
            entry["background"] = [int(v) for v in bg]
            if float(mask_bg.mean()) < 0.05:
                entry["full_bleed"] = True
        rects = merge_overlapping(components(fg))
        if not rects and entry["source"] == "trans":
            # selfillum-only sheets (neon signs) have an all-black trans mask;
            # retry on the color texture
            bg, _ = detect_background(rgb)
            mask_bg = (np.abs(rgb - bg) <= TOL).all(axis=2)
            entry["source"] = "color-fallback"
            entry["background"] = [int(v) for v in bg]
            rects = merge_overlapping(components(~mask_bg))
        if not rects:
            # last resort: expose the whole sheet as one editable region
            entry["source"] += "+whole"
            rects = [[0, 0, w, h, w * h]]
        rects.sort(key=lambda r: (r[1] // 128, r[0]))
        dbg = img.copy()
        draw = ImageDraw.Draw(dbg)
        for i, (x0, y0, x1, y1, area) in enumerate(rects):
            entry["rects"].append({"index": i, "x": x0, "y": y0,
                                   "w": x1 - x0, "h": y1 - y0, "area": area})
            draw.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 0, 0), width=5)
            draw.text((x0 + 10, y0 + 8), str(i), fill=(255, 0, 0), font=font,
                      stroke_width=3, stroke_fill=(255, 255, 255))
        dbg.save(os.path.join(OUT, sheet_id.replace("/", "__") + "_rects.png"))
        print(f"{sheet_id}: {len(rects)} rects (source {entry['source']}, {w}x{h})")
        by_color[color_rel] = entry
        result[sheet_id] = entry
    with open(os.path.join(OUT, "rects_raw.json"), "w") as f:
        json.dump(result, f, indent=2)
    print(f"{len(result)} sheets ->", os.path.join(OUT, "rects_raw.json"))


if __name__ == "__main__":
    main()
