"""Rebuild posterManifest.json regions from the maps' real UV rects.

  python curate_uv.py <rects_dir> [--overlays <dir>] [--dry]

rects_dir holds `<map>_rects.json` files from `vpk-helper worldrects`. For every
sheet, the placed UV rects (fragments merged, partial placements folded into
their full region) become the poster list; each keeps its old id when it
overlaps an old region well enough (users' overrides reference sheet::id),
otherwise it gets the next free item_NN. Old regions no map places anywhere are
kept but flagged `unused: true` (the app hides them by default). alphaCoverage is
recomputed from the sheet's trans mask.
"""
import json, os, sys
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uv_rects import load_maps, sheet_rects, MANIFEST, TEX_DIR

# Sheets the maps use that the manifest never had (paintable = has a color png).
EXTRA_SHEETS = [
    {"id": "signs_bodega01a", "category": "signage", "curated": False,
     "materials": ["materials/overlays/signs_bodega01a.vmat"],
     "colorTexture": "signs_bodega01a_color.png", "transTexture": "signs_bodega01a_93bba988_trans.png",
     "width": 2048, "height": 2048, "posters": []},
]


def fold_partials(regions):
    """Drop rects that sit (>= 90%) INSIDE a clearly bigger rect - a clipped
    placement covers only part of its poster's rect and must not show up as a
    separate region. Containment-only on purpose: never unions/grows rects, so
    two real neighbours that overlap by a few pixels both survive and nothing
    can chain across the sheet."""
    rs = sorted((dict(r) for r in regions), key=lambda r: -(r['w'] * r['h']))
    keep = []
    for a in rs:
        area = a['w'] * a['h']
        host = None
        for b in keep:
            ox = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
            oy = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
            if ox > 0 and oy > 0 and ox * oy >= 0.9 * area and b['w'] * b['h'] >= 1.1 * area:
                host = b
                break
        if host:
            host['quads'] += a['quads']
        else:
            keep.append(a)
    return keep


def union_bands(regions, edge_eps=3):
    """Pieces of one continuous band - a wall trim whose segments each sample
    a different stretch of the same atlas row (or column) - share their
    cross-axis extent and overlap heavily along the band. Union those. Two
    real neighbours never overlap by more than a rounding pixel, so the 25%
    overlap requirement keeps them apart."""
    rs = [dict(r) for r in regions]
    changed = True
    while changed:
        changed = False
        out = []
        while rs:
            a = rs.pop()
            hit = None
            for b in out:
                same_row = abs(a['y'] - b['y']) <= edge_eps and abs(a['y'] + a['h'] - b['y'] - b['h']) <= edge_eps
                same_col = abs(a['x'] - b['x']) <= edge_eps and abs(a['x'] + a['w'] - b['x'] - b['w']) <= edge_eps
                ox = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
                oy = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
                if (same_row and ox >= 0.25 * min(a['w'], b['w'])) or (same_col and oy >= 0.25 * min(a['h'], b['h'])):
                    hit = b
                    break
            if hit:
                x0 = min(a['x'], hit['x']); y0 = min(a['y'], hit['y'])
                x1 = max(a['x'] + a['w'], hit['x'] + hit['w']); y1 = max(a['y'] + a['h'], hit['y'] + hit['h'])
                hit.update(x=x0, y=y0, w=x1 - x0, h=y1 - y0, quads=hit['quads'] + a['quads'])
                changed = True
            else:
                out.append(a)
        rs = out
    return rs


def iou(a, b):
    ox = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
    oy = min(a['y'] + a['h'], b['y'] + b['h']) - max(a['y'], b['y'])
    if ox <= 0 or oy <= 0:
        return 0.0
    inter = ox * oy
    return inter / (a['w'] * a['h'] + b['w'] * b['h'] - inter)


def alpha_coverage(trans_img, r):
    if trans_img is None:
        return 1.0
    box = trans_img.crop((r['x'], r['y'], r['x'] + r['w'], r['y'] + r['h']))
    px = box.getdata()
    if len(px) == 0:
        return 1.0
    return round(sum(1 for v in px if v > 127) / len(px), 3)


def main():
    rects_dir = sys.argv[1]
    dry = '--dry' in sys.argv
    overlays = sys.argv[sys.argv.index('--overlays') + 1] if '--overlays' in sys.argv else None
    if overlays:
        os.makedirs(overlays, exist_ok=True)
    uv = load_maps(rects_dir)
    man = json.load(open(MANIFEST, encoding='utf-8'))
    have = {s['id'] for s in man['sheets']}
    for s in EXTRA_SHEETS:
        if s['id'] not in have:
            man['sheets'].append(s)
    total_changed = 0; total_new = 0; total_unused = 0; total_kept = 0
    for s in man['sheets']:
        regions = fold_partials(union_bands(sheet_rects(uv, s)))
        # Trim slivers (cornice lines, window details sampled from the strip
        # above a poster) are real placements but not posters: 32px floor.
        regions = [r for r in regions if min(r['w'], r['h']) >= 32]
        trans_img = None
        tp = os.path.join(TEX_DIR, (s.get('transTexture') or '').replace('/', os.sep))
        if s.get('transTexture') and os.path.exists(tp):
            trans_img = Image.open(tp).convert('L')
        old = list(s['posters'])
        used_old = set()
        new_posters = []
        # Greedy best-IoU matching, highest first.
        pairs = sorted(((iou(r, o), i, j) for i, r in enumerate(regions) for j, o in enumerate(old)), reverse=True)
        match = {}
        for score, i, j in pairs:
            if score < 0.5 or i in match or j in used_old:
                continue
            match[i] = j
            used_old.add(j)
        nums = [int(o['id'][5:]) for o in old if o['id'].startswith('item_') and o['id'][5:].isdigit()]
        next_n = (max(nums) + 1) if nums else 0
        for i, r in enumerate(regions):
            rect = {'x': r['x'], 'y': r['y'], 'w': r['w'], 'h': r['h']}
            if i in match:
                o = old[match[i]]
                changed = (o['x'], o['y'], o['w'], o['h']) != (rect['x'], rect['y'], rect['w'], rect['h'])
                total_changed += changed
                total_kept += (not changed)
                p = dict(o)
                p.update(rect)
                p['alphaCoverage'] = alpha_coverage(trans_img, rect)
                p['placements'] = r['quads']
                p.pop('unused', None)
            else:
                total_new += 1
                p = {'id': f'item_{next_n:02d}', **rect,
                     'alphaCoverage': alpha_coverage(trans_img, rect), 'placements': r['quads']}
                next_n += 1
            new_posters.append(p)
        for j, o in enumerate(old):
            if j not in used_old:
                p = dict(o)
                p['unused'] = True
                p.pop('placements', None)
                new_posters.append(p)
                total_unused += 1
        new_posters.sort(key=lambda p: (p.get('unused', False), p['y'], p['x']))
        s['posters'] = new_posters
        print(f"{s['category']:10} {s['id']:38} regions={len(regions):3} (kept-id {len(match):3}, new {len(regions) - len(match):3})  unused-old {len(old) - len(used_old):3}")
        if overlays:
            from PIL import ImageDraw, ImageFont
            try:
                font = ImageFont.truetype("arial.ttf", 20)
            except Exception:
                font = ImageFont.load_default()
            cp = os.path.join(TEX_DIR, s['colorTexture'].replace('/', os.sep))
            if os.path.exists(cp):
                im = Image.open(cp).convert('RGBA')
                d = ImageDraw.Draw(im)
                for p in new_posters:
                    un = p.get('unused', False)
                    col = (120, 120, 120, 255) if un else (60, 255, 90, 255)
                    d.rectangle([p['x'], p['y'], p['x'] + p['w'] - 1, p['y'] + p['h'] - 1], outline=col, width=2 if un else 4)
                    d.text((p['x'] + 6, p['y'] + 4), p['id'] + (' (unused)' if un else ''), fill=col, font=font, stroke_width=2, stroke_fill=(0, 0, 0, 255))
                sc = 1200 / max(im.size)
                im = im.resize((int(im.size[0] * sc), int(im.size[1] * sc)), Image.LANCZOS)
                im.convert('RGB').save(os.path.join(overlays, f"{s['category']}__{s['id'].replace('/', '__')}.jpg"), quality=82)
    man['version'] = 2
    print(f"\nTOTAL regions kept-as-is {total_kept}, rect-changed {total_changed}, new {total_new}, old-unused {total_unused}")
    if not dry:
        with open(MANIFEST, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(man, f, indent=1)
            f.write('\n')
        print('wrote', MANIFEST)


if __name__ == '__main__':
    main()
