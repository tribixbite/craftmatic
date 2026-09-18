#!/usr/bin/env python3
"""_mcaddon_check.py — structural validation of a built `.mcaddon`.

WHY. `scripts/_playable_ref.ts` and the LEGO tab both report component counts and
warnings, and a pack can satisfy every one of them and still fail to appear in
Minecraft: a geometry an entity names but the pack never defines, a texture path
with no file, a behaviour pack that does not depend on its resource pack, a
script `entry` that is not in the archive. Those are load-time failures with no
in-game symptom beyond "nothing is there", and they cost a device round to find.

This is not a substitute for loading the pack. It is the cheap gate that catches
the malformed-archive class offline, so a device round only ever sees content
problems.

    python scripts/_mcaddon_check.py output/**/*.mcaddon

Exits non-zero if any pack fails. Verified 2026-09-18 over the seven packs of
the named-set round (71043, 76435, 910004, 10326, 31201, 76405): all OK.
"""

import json
import re
import sys
import zipfile
from pathlib import Path

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

def check(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    problems, notes = [], []
    manifests = [n for n in names if n.endswith('manifest.json')]
    if len(manifests) != 2:
        problems.append(f'expected 2 manifests, found {len(manifests)}: {manifests}')
    mans = {}
    for m in manifests:
        d = json.loads(z.read(m).decode('utf-8-sig'))
        h = d.get('header', {})
        if not UUID.match(str(h.get('uuid', ''))): problems.append(f'{m}: bad header uuid {h.get("uuid")!r}')
        if not isinstance(h.get('version'), list): problems.append(f'{m}: bad header version')
        kinds = {mo.get('type') for mo in d.get('modules', [])}
        for mo in d.get('modules', []):
            if not UUID.match(str(mo.get('uuid', ''))): problems.append(f'{m}: bad module uuid')
        mans[m] = (h.get('uuid'), kinds, d)
        notes.append(f'{m.split("/")[0]}: modules={sorted(kinds)}')
    bp = [k for k, v in mans.items() if v[1] & {'data', 'script'}]
    rp = [k for k, v in mans.items() if 'resources' in v[1]]
    if bp and rp:
        deps = [str(x.get('uuid')) for x in mans[bp[0]][2].get('dependencies', [])]
        if mans[rp[0]][0] not in deps:
            problems.append('behaviour pack does not depend on the resource pack uuid')
    # scripts
    for m, (_u, kinds, d) in mans.items():
        for mo in d.get('modules', []):
            if mo.get('type') == 'script':
                ep = mo.get('entry')
                full = m.rsplit('manifest.json', 1)[0] + ep
                if full not in names: problems.append(f'script entry missing: {full}')
                else: notes.append(f'script entry ok: {ep}')
    # geometries the pack defines
    geo_ids = set()
    for n in [x for x in names if x.endswith('.geo.json')]:
        d = json.loads(z.read(n).decode('utf-8-sig'))
        for g in d.get('minecraft:geometry', []):
            gid = (g.get('description') or {}).get('identifier')
            if gid: geo_ids.add(gid)
    tex_files = {x.rsplit('.', 1)[0] for x in names if x.endswith(('.png', '.tga'))}
    ents = [x for x in names if '/entity/' in x and x.endswith('.json')]
    n_client = 0
    for n in ents:
        d = json.loads(z.read(n).decode('utf-8-sig'))
        ce = d.get('minecraft:client_entity')
        if not ce: continue
        n_client += 1
        desc = ce.get('description', {})
        for gname, gid in (desc.get('geometry') or {}).items():
            if gid not in geo_ids: problems.append(f'{n}: geometry {gid!r} is not defined in the pack')
        for tname, tpath in (desc.get('textures') or {}).items():
            cand = [t for t in tex_files if t.endswith(tpath)]
            if not cand: problems.append(f'{n}: texture {tpath!r} has no file')
        if not desc.get('materials'): problems.append(f'{n}: no materials')
    notes.append(f'{n_client} client entities, {len(geo_ids)} geometries, {len(tex_files)} textures')
    return problems, notes

def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    bad = 0
    for p in sys.argv[1:]:
        try:
            probs, notes = check(p)
        except Exception as exc:                       # a corrupt archive is a failure too
            print(f'FAIL {Path(p).name:28s} unreadable: {type(exc).__name__}: {exc}')
            bad += 1
            continue
        print(f'{"OK  " if not probs else "FAIL"} {Path(p).name:28s} {"; ".join(notes)}')
        for x in probs:
            print(f'       !! {x}')
        bad += bool(probs)
    print()
    print(f'{len(sys.argv) - 1 - bad}/{len(sys.argv) - 1} packs structurally valid')
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
