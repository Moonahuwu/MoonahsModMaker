"""Ground-truth poster rects from the compiled maps' UVs.

Reads the JSON emitted by `vpk-helper worldrects <map.vpk> <pak01_dir.vpk> out.json`
(one per map), merges each decal's UV fragments back into whole poster rects,
and prints/plots them against the shipped manifest.

  python uv_rects.py <rects_dir> [--overlays <out_dir>] [--write-manifest]
"""
import json, os, sys, glob
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, '..', '..', 'app', 'src', 'data', 'posterManifest.json')
TEX_DIR = os.path.join(HERE, '..', '..', 'VanillaFiles', 'materials', 'overlays')

def load_maps(rects_dir):
    """material -> list of (map, model, u0, v0, u1, v1, quads)"""
    out = defaultdict(list)
    for f in sorted(glob.glob(os.path.join(rects_dir, '*_rects.json'))):
        d = json.load(open(f, encoding='utf-8'))
        mp = os.path.basename(f).replace('_rects.json', '')
        for mat, rs in d['materials'].items():
            for r in rs:
                # Wrapped UVs: geometry often addresses the atlas at v -2..-1 etc.
                # Shift the rect into its own period; a rect spanning a period
                # boundary is a tiling decal, not a poster - skip it.
                import math
                du, dv = math.floor(r['u0']), math.floor(r['v0'])
                u0, u1, v0, v1 = r['u0'] - du, r['u1'] - du, r['v0'] - dv, r['v1'] - dv
                if u1 > 1.001 or v1 > 1.001:
                    continue
                pos = r.get('pos')  # model-space bounds [x0,y0,z0,x1,y1,z1] or None
                for m in (r.get('models') or ['?']):
                    out[mat.lower()].append((mp, m, u0, v0, u1, v1, r['quads'], pos))
    return out

def merge_touching(rects, eps, world_eps=4.0):
    """Iteratively merge pieces (x0,y0,x1,y1,n,pos) that touch/overlap in UV
    space AND (when both carry world bounds) touch/overlap in world space too.
    Pieces of one decal split by a wall seam satisfy both; two different signs
    that merely sit next to each other in a gutterless atlas satisfy only the
    first and stay apart."""
    def world_touch(pa, pb):
        if pa is None or pb is None:
            return True
        return all(pa[i] <= pb[i + 3] + world_eps and pb[i] <= pa[i + 3] + world_eps for i in range(3))
    rects = [list(r) for r in rects]
    changed = True
    while changed:
        changed = False
        out = []
        while rects:
            a = rects.pop()
            merged = False
            for b in out:
                if (a[0] <= b[2] + eps and b[0] <= a[2] + eps and a[1] <= b[3] + eps and b[1] <= a[3] + eps
                        and world_touch(a[5], b[5])):
                    b[0] = min(a[0], b[0]); b[1] = min(a[1], b[1]); b[2] = max(a[2], b[2]); b[3] = max(a[3], b[3]); b[4] += a[4]
                    if a[5] is not None and b[5] is not None:
                        b[5] = [min(a[5][i], b[5][i]) for i in range(3)] + [max(a[5][i + 3], b[5][i + 3]) for i in range(3)]
                    merged = True; changed = True; break
            if not merged: out.append(a)
        rects = out
    return rects

def sheet_rects(uv, sheet, frag_eps_px=1.5, dedupe_px=3.0):
    """Pixel rects for one manifest sheet from all maps: fragments merged per
    (map, model) placement, then identical placements collapsed."""
    W, H = sheet['width'], sheet['height']
    mats = [m.lower() for m in sheet['materials']]
    per_place = defaultdict(list)
    for mat in mats:
        for (mp, model, u0, v0, u1, v1, q, pos) in uv.get(mat, []):
            per_place[(mp, model)].append((u0 * W, v0 * H, u1 * W, v1 * H, q, pos))
    cands = []
    for k, frs in per_place.items():
        for r in merge_touching(frs, frag_eps_px):
            cands.append(r[:5])
    # Collapse near-identical rects across placements (same atlas region).
    final = []
    for r in sorted(cands, key=lambda r: (r[1], r[0])):
        hit = None
        for f in final:
            if abs(f[0]-r[0]) <= dedupe_px and abs(f[1]-r[1]) <= dedupe_px and abs(f[2]-r[2]) <= dedupe_px and abs(f[3]-r[3]) <= dedupe_px:
                hit = f; break
        if hit: hit[4] += r[4]
        else: final.append(list(r))
    # Clamp + round to pixels; drop degenerate/tiling (bigger than the sheet).
    out = []
    for x0, y0, x1, y1, n in final:
        x0 = max(0.0, x0); y0 = max(0.0, y0); x1 = min(float(W), x1); y1 = min(float(H), y1)
        w, h = x1 - x0, y1 - y0
        if w < 4 or h < 4: continue
        out.append({'x': int(round(x0)), 'y': int(round(y0)), 'w': int(round(w)), 'h': int(round(h)), 'quads': n})
    return out

if __name__ == '__main__':
    rects_dir = sys.argv[1]
    uv = load_maps(rects_dir)
    man = json.load(open(MANIFEST, encoding='utf-8'))
    overlays = None
    if '--overlays' in sys.argv:
        overlays = sys.argv[sys.argv.index('--overlays') + 1]; os.makedirs(overlays, exist_ok=True)
        from PIL import Image, ImageDraw, ImageFont
        try: font = ImageFont.truetype("arial.ttf", 20)
        except: font = ImageFont.load_default()
    for s in man['sheets']:
        got = sheet_rects(uv, s)
        print(f"{s['category']:10} {s['id']:38} manifest={len(s['posters']):3}  uv={len(got):3}  quads={sum(r['quads'] for r in got)}")
        if overlays:
            p = os.path.join(TEX_DIR, s['colorTexture'].replace('/', os.sep))
            if not os.path.exists(p): continue
            im = Image.open(p).convert('RGBA'); d = ImageDraw.Draw(im)
            for r in s['posters']:
                d.rectangle([r['x'], r['y'], r['x']+r['w']-1, r['y']+r['h']-1], outline=(255,60,60,255), width=3)
            for r in got:
                d.rectangle([r['x'], r['y'], r['x']+r['w']-1, r['y']+r['h']-1], outline=(60,255,90,255), width=5)
                d.text((r['x']+6, r['y']+r['h']-28), str(r['quads']), fill=(60,255,90,255), font=font, stroke_width=2, stroke_fill=(0,0,0,255))
            sc = 1200 / max(im.size); im = im.resize((int(im.size[0]*sc), int(im.size[1]*sc)), Image.LANCZOS)
            im.convert('RGB').save(os.path.join(overlays, f"{s['category']}__{s['id'].replace('/','__')}.jpg"), quality=82)
