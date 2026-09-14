import os, sys

ldraw_root = 'C:/git/clego/extracted/studio_release/app/ldraw'

def parse_dat(filepath, stack=None):
    if stack is None: stack = set()
    if filepath in stack: return []
    stack.add(filepath)
    coords = []
    try:
        with open(filepath) as f:
            for line in f:
                p = line.strip().split()
                if not p: continue
                ltype = p[0]
                if ltype == '3' and len(p) >= 11:
                    for i in [2,3,4,5,6,7,8,9,10]:
                        coords.append(float(p[i]))
                elif ltype == '4' and len(p) >= 14:
                    for i in [2,3,4,5,6,7,8,9,10,11,12,13]:
                        coords.append(float(p[i]))
                elif ltype == '1' and len(p) >= 15:
                    sub = ' '.join(p[14:]).lower()
                    # normalize path separators
                    sub = sub.replace('\\', '/').strip()
                    basename = sub.split('/')[-1]
                    for base in [
                        os.path.join(ldraw_root, 'parts', sub.replace('/', os.sep)),
                        os.path.join(ldraw_root, 'parts', basename),
                        os.path.join(ldraw_root, 'parts', 's', basename),
                        os.path.join(ldraw_root, 'p', sub.replace('/', os.sep)),
                        os.path.join(ldraw_root, 'p', basename),
                    ]:
                        if os.path.exists(base):
                            coords.extend(parse_dat(base, stack))
                            break
    except Exception as e:
        pass
    return coords

parts = sys.argv[1:] if len(sys.argv) > 1 else ['2742', '32019', '86652', '87616']
for part_id in parts:
    filepath = os.path.join(ldraw_root, 'parts', part_id + '.dat')
    if not os.path.exists(filepath):
        print(f'{part_id}: file not found at {filepath}')
        continue
    coords = parse_dat(filepath)
    if coords:
        xs = coords[0::3]; ys = coords[1::3]; zs = coords[2::3]
        xspan = max(xs)-min(xs); yspan = max(ys)-min(ys); zspan = max(zs)-min(zs)
        sL = max(1, round(xspan/20))
        sH = max(1, round(yspan/8))
        sW = max(1, round(zspan/20))
        print(f'{part_id}: X={min(xs):.0f}..{max(xs):.0f} ({xspan:.0f} LDU, sL={sL}), '
              f'Y={min(ys):.0f}..{max(ys):.0f} ({yspan:.0f} LDU, sH={sH}), '
              f'Z={min(zs):.0f}..{max(zs):.0f} ({zspan:.0f} LDU, sW={sW})')
        print(f'  -> correct dims = [{sW},{sH},{sL}]')
    else:
        print(f'{part_id}: no geometry parsed')
