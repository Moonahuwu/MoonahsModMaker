"""Build the curated poster manifest from detect_rects.py output.

Every discovered sheet ships with auto-detected rects; the sheets in HAND below
additionally carry hand-authored splits/names for regions the detector merges
(adjacent posters with no background gutter) or misses (full-bleed sheets).
Hand rects may be refined by snapping each edge to the strongest nearby image
gradient (snap flag). Outputs:
  - out/curated/poster_manifest.json  and  app/src/data/posterManifest.json
  - out/curated/<sheet>_overlay.png   (full sheet with labeled rects)
  - out/curated/<sheet>_contact.png   (grid of crops for visual verification)
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))
OVERLAYS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    _REPO, "VanillaFiles", "materials", "overlays")
OUT = os.path.join(_HERE, "out", "curated")
MANIFEST_DEST = os.path.join(_REPO, "app", "src", "data", "posterManifest.json")
os.makedirs(OUT, exist_ok=True)

RAW = json.load(open(os.path.join(_HERE, "out", "rects_raw.json")))

SNAP_WINDOW = 16

# Hand-curated layer, keyed by sheet id.
#   manual: (id, x, y, w, h, snap?)   authored rect, optionally edge-snapped
#   auto: (raw_index, id)             import one detected rect, named
#   auto_all / auto_names / auto_merge: import every detected rect, with
#       friendly names for some and fragment groups merged into one rect
HAND = {
    "labels_posters_default_01": {
        "manual": [("iron_steel_banner", 11, 38, 1480, 176, False)],
    },
    "labels_posters_default_02": {
        "manual": [
            ("kanji_banner_tan", 0, 0, 246, 763, False),
            ("skater_green", 0, 720, 380, 420, False),
            ("white_glyph_1", 288, 8, 182, 240, True),
            ("burbo_portrait", 492, 494, 245, 914, True),
            ("tribal_tower", 737, 494, 251, 914, True),
        ],
        "auto": [(1, "white_glyph_2"), (2, "white_glyph_3"), (4, "orange_abstract")],
    },
    "labels_posters_default_03": {
        "manual": [
            ("graffiti_blue_skues", 10, 261, 460, 276, False),
            ("funpo_vertical", 534, 82, 88, 402, False),
            ("onigiri_circle", 668, 75, 356, 390, False),
            ("dark_window", 1085, 10, 368, 527, False),
            ("graffiti_white_alo", 1370, 297, 335, 240, False),
            ("yellow_kanji_right", 1738, 60, 116, 402, False),
            ("next500_girl", 0, 522, 927, 455, True),
            ("purple_diamond", 1060, 599, 318, 415, False),
            ("yellow_kanji_mid", 1248, 556, 86, 402, False),
            ("prom_game_poster", 1393, 543, 312, 445, False),
            ("mega_vertical", 1705, 517, 220, 1000, False),
            ("tsumo_tsoda_sign", 0, 978, 1157, 522, True),
            ("king_game_poster", 1393, 988, 312, 466, False),
            ("gamt_7000k_strip", 0, 1500, 1418, 97, True),
            ("atlas_sign", 277, 1618, 548, 113, True),
            ("blue_kanji_panel", 0, 1597, 277, 451, True),
            ("yellow_bar", 1101, 1633, 312, 70, False),
            ("white_kanji_logo", 1444, 1705, 532, 343, False),
        ],
    },
    "labels_posters_default_04": {
        "manual": [
            ("band_1874", 0, 0, 993, 497, True),
            ("maj_flav_drink", 8, 507, 475, 990, True),
            ("boss_sticker", 499, 500, 122, 243, False),
            ("grip_sticker", 622, 499, 366, 115, False),
            ("pink_j_sticker", 742, 628, 241, 112, False),
            ("ova_supermega_sticker", 502, 750, 115, 125, False),
            ("purple_squiggle_sticker", 620, 750, 115, 108, False),
            ("drop_sticker", 742, 750, 244, 102, False),
            ("twak_go_sticker", 499, 865, 121, 374, False),
            ("brown_face_sticker", 742, 876, 246, 112, False),
            ("lightning_sticker", 635, 1009, 107, 230, False),
            ("bird_excl_sticker", 748, 1009, 240, 97, False),
            ("boom_graffiti", 538, 1244, 420, 118, False),
        ],
    },
    "posters_bodega_comp1": {
        "manual": [
            ("fresh_eggs", 111, 41, 432, 614, True),
            ("bread_daily", 545, 39, 436, 627, True),
            ("more_less_sticker", 10, 558, 121, 121, True),
            ("life_beer", 12, 640, 500, 335, True),
            ("atm", 517, 729, 358, 249, False),
            ("canned_spirits", 1008, 8, 376, 647, True),
            ("newspaper_top_right", 1418, 8, 621, 637, True),
            ("plaza_classy_fridge", 1560, 445, 479, 580, False),
            ("liberty_beef_franks", 1008, 671, 548, 328, False),
            ("newspapers_mid_left", 4, 1009, 1010, 466, True),
            ("brosef_100k", 517, 1321, 420, 520, False),
            ("obituaries_page", 0, 1490, 529, 558, True),
            ("red_white_sticker", 835, 1797, 138, 79, False),
        ],
        "auto": [(3, "newspapers_mid_right"), (4, "black_cauldron")],
    },
    "posters_bodega_comp2": {
        "manual": [
            ("np_foreigners_moon", 0, 8, 285, 473, True),
            ("np_columns_1", 285, 15, 258, 476, True),
            ("np_rich_battle_1", 543, 8, 289, 473, True),
            ("np_map_page", 832, 15, 154, 476, True),
            ("np_oracle_gas_leaks", 985, 8, 280, 458, True),
            ("np_obituaries_1", 1265, 8, 364, 473, True),
            ("np_cite_societe_1", 1628, 8, 323, 473, True),
            ("np_edge_partial", 1950, 8, 98, 473, False),
            ("np_today_1", 0, 489, 279, 485, True),
            ("np_soap_societe", 287, 502, 274, 471, True),
            ("np_obituaries_2", 568, 497, 290, 478, True),
            ("np_oracle_partial", 858, 497, 115, 478, True),
            ("np_today_2", 998, 489, 133, 483, True),
            ("np_foreigners_2", 1132, 495, 287, 478, True),
            ("np_columns_2", 1418, 495, 282, 478, True),
            ("np_rich_battle_2", 1700, 495, 297, 478, True),
        ],
        "auto": [(1, "read_oracle_sign"), (2, "oracle_paper_sign")],
    },
    "labels_posters_windows_01": {
        "auto_all": True,
        "auto_names": {6: "wolf_mural", 7: "sumo_knife_mural", 27: "ncjiro_sign",
                       35: "neon_u", 36: "neon_s", 51: "graffiti_hcko"},
        "auto_merge": [("blue_graffiti_column", [37, 42, 43, 44, 45, 46, 48])],
    },
    "poster_test": {
        "manual": [
            ("prime_neon_sold_here", 64, 64, 640, 1152, False),
            ("hotel_vertical", 800, 32, 192, 800, False),
            ("drugs_vertical", 1056, 32, 192, 800, False),
            ("sad_panda_coffee", 1344, 64, 640, 1152, False),
            ("caldera_vertical", 800, 896, 192, 1120, False),
            ("great_taste", 1024, 864, 256, 416, False),
            ("daily_news", 32, 1280, 448, 480, False),
            ("fresh_supply_daily", 480, 1248, 256, 544, False),
            ("affordable_prices", 0, 1760, 480, 288, False),
            ("delicious_refreshing", 1056, 1312, 960, 704, False),
        ],
    },
}


def lum(rgb):
    return rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114


def cluster_merge(rects, pad):
    """Merge rects whose pad-expanded bounds overlap ([x,y,w,h] dicts -> tuples)."""
    boxes = [[r["x"], r["y"], r["x"] + r["w"], r["y"] + r["h"]] for r in rects]
    changed = True
    while changed:
        changed = False
        out = []
        while boxes:
            a = boxes.pop()
            merged = False
            for b in out:
                if (a[0] - pad < b[2] and b[0] - pad < a[2]
                        and a[1] - pad < b[3] and b[1] - pad < a[3]):
                    b[0] = min(a[0], b[0]); b[1] = min(a[1], b[1])
                    b[2] = max(a[2], b[2]); b[3] = max(a[3], b[3])
                    merged = changed = True
                    break
            if not merged:
                out.append(a)
        boxes = out
    boxes.sort(key=lambda b: (b[1] // 128, b[0]))
    return boxes


def snap_edge(L, fixed_lo, fixed_hi, pos, axis, w, h):
    limit = (w if axis == 0 else h) - 2
    lo = max(1, pos - SNAP_WINDOW)
    hi = min(limit, pos + SNAP_WINDOW)
    if hi <= lo:
        return pos
    best, best_score = pos, -1.0
    span = slice(max(0, fixed_lo), min(fixed_hi, h if axis == 0 else w))
    for c in range(lo, hi + 1):
        if axis == 0:
            score = float(np.abs(L[span, c + 1] - L[span, c - 1]).mean())
        else:
            score = float(np.abs(L[c + 1, span] - L[c - 1, span]).mean())
        if score > best_score:
            best_score, best = score, c
    return best


def snap_rect(L, x, y, w, h, W, H):
    x0, y0, x1, y1 = x, y, x + w, y + h
    x0 = snap_edge(L, y0, y1, x0, 0, W, H)
    x1 = snap_edge(L, y0, y1, x1, 0, W, H)
    y0 = snap_edge(L, x0, x1, y0, 1, H, W)
    y1 = snap_edge(L, x0, x1, y1, 1, H, W)
    if x1 <= x0 or y1 <= y0:
        return x, y, w, h
    return x0, y0, x1 - x0, y1 - y0


def main():
    try:
        small = ImageFont.truetype("arial.ttf", 22)
    except OSError:
        small = ImageFont.load_default()
    manifest = {"version": 2, "sheets": []}
    for sheet_id in sorted(RAW):
        raw = RAW[sheet_id]
        W, H = raw["width"], raw["height"]
        img = Image.open(os.path.join(OVERLAYS, raw["colorTexture"])).convert("RGB")
        L = lum(np.asarray(img, dtype=np.float32))
        trans = None
        if raw.get("transTexture"):
            tp = os.path.join(OVERLAYS, raw["transTexture"])
            if os.path.exists(tp):
                trans = np.asarray(Image.open(tp).convert("L").resize((W, H), Image.NEAREST))
        raw_rects = {r["index"]: r for r in raw["rects"]}
        hand = HAND.get(sheet_id)
        posters = []

        def add(pid, x, y, w, h):
            x, y = max(0, x), max(0, y)
            w, h = min(w, W - x), min(h, H - y)
            entry = {"id": pid, "x": int(x), "y": int(y), "w": int(w), "h": int(h)}
            if trans is not None:
                cov = float((trans[y:y + h, x:x + w] > 128).mean())
                entry["alphaCoverage"] = round(cov, 3)
            posters.append(entry)

        if hand is None:
            # letter-heavy signage fragments into hundreds of glyph components;
            # cluster with growing padding until the count is workable
            boxes = cluster_merge(list(raw_rects.values()), 1)
            for pad in (8, 16, 32, 64):
                if len(boxes) <= 60:
                    break
                boxes = cluster_merge(
                    [{"x": b[0], "y": b[1], "w": b[2] - b[0], "h": b[3] - b[1]}
                     for b in boxes], pad)
            for i, b in enumerate(boxes):
                add(f"item_{i:02d}", b[0], b[1], b[2] - b[0], b[3] - b[1])
        else:
            if hand.get("auto_all"):
                merged_idx = set()
                merges = hand.get("auto_merge", [])
                for _, idxs in merges:
                    merged_idx.update(idxs)
                for pid, idxs in merges:
                    xs0 = min(raw_rects[i]["x"] for i in idxs)
                    ys0 = min(raw_rects[i]["y"] for i in idxs)
                    xs1 = max(raw_rects[i]["x"] + raw_rects[i]["w"] for i in idxs)
                    ys1 = max(raw_rects[i]["y"] + raw_rects[i]["h"] for i in idxs)
                    add(pid, xs0, ys0, xs1 - xs0, ys1 - ys0)
                names = hand.get("auto_names", {})
                for i, r in sorted(raw_rects.items()):
                    if i in merged_idx:
                        continue
                    add(names.get(i, f"item_{i:02d}"), r["x"], r["y"], r["w"], r["h"])
            for pid, x, y, w, h, do_snap in hand.get("manual", []):
                if do_snap:
                    x, y, w, h = snap_rect(L, x, y, w, h, W, H)
                add(pid, x, y, w, h)
            for idx, pid in hand.get("auto", []):
                r = raw_rects[idx]
                add(pid, r["x"], r["y"], r["w"], r["h"])

        safe = sheet_id.replace("/", "__")
        dbg = img.copy()
        draw = ImageDraw.Draw(dbg)
        for p in posters:
            draw.rectangle([p["x"], p["y"], p["x"] + p["w"] - 1, p["y"] + p["h"] - 1],
                           outline=(255, 0, 0), width=4)
            draw.text((p["x"] + 8, p["y"] + 6), p["id"], fill=(255, 255, 0), font=small,
                      stroke_width=2, stroke_fill=(0, 0, 0))
        dbg.save(os.path.join(OUT, safe + "_overlay.png"))

        cell = 300
        cols = 6
        rows = max(1, (len(posters) + cols - 1) // cols)
        cs = Image.new("RGB", (cols * cell, rows * (cell + 34)), (24, 24, 24))
        cdraw = ImageDraw.Draw(cs)
        for i, p in enumerate(posters):
            crop = img.crop((p["x"], p["y"], p["x"] + p["w"], p["y"] + p["h"]))
            crop.thumbnail((cell - 8, cell - 8))
            cx, cy = (i % cols) * cell, (i // cols) * (cell + 34)
            cs.paste(crop, (cx + (cell - crop.width) // 2, cy + (cell - crop.height) // 2))
            cdraw.text((cx + 6, cy + cell + 4), f"{p['id']} {p['w']}x{p['h']}",
                       fill=(255, 255, 255), font=small)
        cs.save(os.path.join(OUT, safe + "_contact.png"))

        manifest["sheets"].append({
            "id": sheet_id,
            "category": raw["category"],
            "curated": hand is not None,
            "materials": raw["materials"],
            "colorTexture": raw["colorTexture"],
            "transTexture": raw.get("transTexture"),
            "width": W, "height": H,
            "posters": posters,
        })
        print(f"{sheet_id}: {len(posters)} posters ({'curated' if hand else 'auto'})")
    for dest in (os.path.join(OUT, "poster_manifest.json"), MANIFEST_DEST):
        with open(dest, "w") as f:
            json.dump(manifest, f, indent=2)
        print("wrote", dest)


if __name__ == "__main__":
    main()
