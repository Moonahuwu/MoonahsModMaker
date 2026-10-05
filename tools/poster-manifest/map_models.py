"""List every model a compiled map can show, for `vpk-helper worldrects`.

  python map_models.py <Deadlock>/game/citadel <helper exe|dll> <out_dir> [map ...]

`worldrects` walks the world nodes and the entities' `model` keys, but a lot of
what a map shows comes from routes that walk cannot follow:

  * prop classes whose model is defined in game data (vdata subclasses -
    breakable props, sign props, banners), so the entity carries no model key;
  * the models stored INSIDE the map package (`maps/<map>/entities/*.vmdl`,
    brush and mesh entities);
  * skins: a poster case ships one material in its mesh and swaps the art
    through a material group (worldrects reads those itself).

The map package names every model it needs as a plain string, so this mines
`models/**.vmdl` out of the package bytes, adds the package's own `.vmdl_c`
entries, and writes `<out_dir>/<map>_models.txt` - pass that file as the last
`worldrects` argument. Without it the subway advert posters, the campus and
museum banners and other prop-shown art are reported "unused" (2026-10-04).
"""
import mmap, os, re, subprocess, sys


def helper_cmd(helper):
    return ['dotnet', helper] if helper.lower().endswith('.dll') else [helper]


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    citadel, helper, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    maps_dir = os.path.join(citadel, 'maps')
    maps = sys.argv[4:] or sorted(f[:-4] for f in os.listdir(maps_dir) if f.endswith('.vpk'))
    os.makedirs(out_dir, exist_ok=True)
    rx = re.compile(rb'models/[A-Za-z0-9_/\-]+\.vmdl')
    for name in maps:
        vpk = os.path.join(maps_dir, name + '.vpk')
        with open(vpk, 'rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
            referenced = {m.group(0).decode() for m in rx.finditer(mm)}
        listing = subprocess.run(helper_cmd(helper) + ['list', vpk], capture_output=True, text=True).stdout
        local = {l.strip()[:-2] for l in listing.splitlines() if l.strip().endswith('.vmdl_c')}
        models = sorted(referenced | local)
        out = os.path.join(out_dir, name + '_models.txt')
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(models) + '\n')
        print(f'{name}: {len(referenced)} referenced + {len(local)} in-package -> {len(models)} models -> {out}')


if __name__ == '__main__':
    main()
