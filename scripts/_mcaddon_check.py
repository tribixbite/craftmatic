#!/usr/bin/env python3
"""_mcaddon_check.py — structural validation of a built `.mcaddon`.

WHY. `scripts/_playable_ref.ts` and the LEGO tab both report component counts and
warnings, and a pack can satisfy every one of them and still fail to appear in
Minecraft: a geometry an entity names but the pack never defines, a texture path
with no file, a behaviour pack that does not depend on its resource pack, a
script `entry` that is not in the archive, an entity identifier the game
refuses to parse. Those are load-time failures with no
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

# Entity components Bedrock's current format rejects (see check()).
DROPPED_COMPONENTS = ('minecraft:pushable',)
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
    # Actor identifiers Bedrock will accept. A name beginning with a digit is
    # rejected outright ("identifier cannot begin with a number") and the entity
    # then does not exist in world, with nothing in logcat and only two quiet
    # content-log lines to show for it. Most LEGO set stems are numeric, so this
    # cost a whole device round on 10303 (2026-09-21): its ride cart and manual
    # seat were rejected while the 13 prefixed entities loaded normally.
    ident_ok = re.compile(r'^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$')
    n_server = 0
    rideables = []
    for n in [x for x in names if '/entities/' in x and x.endswith('.json')]:
        d = json.loads(z.read(n).decode('utf-8-sig'))
        ident = ((d.get('minecraft:entity') or {}).get('description') or {}).get('identifier')
        if not ident:
            problems.append(f'{n}: no entity identifier')
            continue
        n_server += 1
        if not ident_ok.match(ident):
            problems.append(f'{n}: Bedrock rejects the identifier {ident!r}')
        # Components format 1.26.30 no longer has: the WHOLE entity then fails
        # to parse and every spawn reports "not a valid entity type". Pinball's
        # flippers, ball and tap zones shipped twice with `minecraft:pushable`
        # and nothing on the table moved (device 2026-09-24).
        ent = d.get('minecraft:entity') or {}
        for where, comps in [('components', ent.get('components') or {})] + [(f'group {g}', c) for g, c in (ent.get('component_groups') or {}).items()]:
            for dropped in DROPPED_COMPONENTS:
                if dropped in comps:
                    problems.append(f'{n}: {where} uses {dropped!r}, which format 1.26.30 dropped (the entity fails to load)')
            if 'minecraft:rideable' in comps and ident not in rideables:
                rideables.append(ident)
        # An int/float actor property whose range is not wider than one value:
        # Bedrock refuses it ("range max is less than range min" for [0, 0],
        # Pixel 2026-09-25) and with it the entity's WHOLE property component,
        # so every q.property errors and setProperty throws (the Minifig
        # Creator's figure shipped like that).
        for pname, prop in ((ent.get('description') or {}).get('properties') or {}).items():
            rng = prop.get('range') if isinstance(prop, dict) else None
            if prop.get('type') in ('int', 'float') and isinstance(rng, list) and len(rng) == 2 and not rng[1] > rng[0]:
                problems.append(f'{n}: property {pname!r} range {rng} is not wider than one value (Bedrock drops every property of the entity)')
    notes.append(f'{n_server} server entities')
    # Every rideable needs its dismount hint in EVERY language file the pack
    # ships: while a player rides it Bedrock draws `action.hint.exit.<identifier>`
    # translated, or the raw key when the .lang has no such line (the Saga showed
    # `action.hint.exit.craftmatic:hogsmeade_76457_seat`, device round 2026-09-26a).
    langs = [x for x in names if re.search(r'/texts/[^/]+\.lang$', x)]
    if rideables and not langs:
        problems.append(f'{len(rideables)} rideable entities but no texts/*.lang (every dismount hint shows its raw key)')
    for lf in langs:
        keys = {ln.split('=', 1)[0].strip() for ln in z.read(lf).decode('utf-8-sig').splitlines() if '=' in ln and not ln.lstrip().startswith('#')}
        missing = [r for r in rideables if f'action.hint.exit.{r}' not in keys]
        if missing:
            problems.append(f'{lf}: no action.hint.exit line for {len(missing)} rideable entit{"y" if len(missing) == 1 else "ies"} ({", ".join(missing[:4])}{", ..." if len(missing) > 4 else ""}): the raw key shows while riding')
    if rideables: notes.append(f'{len(rideables)} rideable entities, dismount hints checked in {len(langs)} language file(s)')
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
    # Custom blocks: the collider and its clearance forms (web/src/engine/collider-form.ts).
    # A block definition Bedrock cannot parse leaves the id unknown, and every
    # setPermutation of it then throws inside the Brick Wand's re-lay: a wall
    # silently missing. Checked against Microsoft Learn's minecraft:collision_box
    # rules (a box inside -8,0,-8 .. 8,24,8 pixels; an ARRAY of at most 16 boxes
    # from format 1.26.0) and bedrock.dev's state limits (16 values a state,
    # 65,536 permutations a block).
    block_ids = set()
    registered = 0
    fmt = lambda v: tuple(int(x) for x in str(v).split('.')[:3])
    for n in [x for x in names if '/blocks/' in x and x.endswith('.json')]:
        d = json.loads(z.read(n).decode('utf-8-sig'))
        blk = d.get('minecraft:block')
        if not blk: continue
        ident = (blk.get('description') or {}).get('identifier')
        if not ident or not ident_ok.match(ident):
            problems.append(f'{n}: Bedrock rejects the block identifier {ident!r}')
            continue
        block_ids.add(ident)
        perms = 1
        for sname, sdef in ((blk.get('description') or {}).get('states') or {}).items():
            vals = sdef.get('values') if isinstance(sdef, dict) else sdef
            count = (vals['max'] - vals['min'] + 1) if isinstance(vals, dict) else len(vals or [])
            if count > 16: problems.append(f'{n}: state {sname!r} has {count} values (Bedrock allows 16)')
            perms *= max(1, count)
        registered += perms
        if perms > 65536: problems.append(f'{n}: {perms} registered permutations (a block may have 65,536)')
        boxes_sets = [('components', (blk.get('components') or {}).get('minecraft:collision_box'))]
        boxes_sets += [(f'permutation {i}', (p.get('components') or {}).get('minecraft:collision_box')) for i, p in enumerate(blk.get('permutations') or [])]
        for where, cb in boxes_sets:
            if cb is None or isinstance(cb, bool): continue
            boxes = cb if isinstance(cb, list) else [cb]
            if isinstance(cb, list) and (fmt(d.get('format_version', '0')) < (1, 26, 0) or len(cb) > 16):
                problems.append(f'{n}: {where} collision_box is an array of {len(cb)} (needs format 1.26.0+ and at most 16), format {d.get("format_version")}')
            for b in boxes:
                o, s = b.get('origin', [-8, 0, -8]), b.get('size', [16, 16, 16])
                lo, hi = [-8, 0, -8], [8, 24, 8]
                if any(o[k] < lo[k] or o[k] + s[k] > hi[k] or s[k] < 0 for k in range(3)):
                    problems.append(f'{n}: {where} collision box {b} leaves the block')
    if registered: notes.append(f'{len(block_ids)} custom blocks, {registered} registered permutations')
    if registered > 65536: problems.append(f'{registered} custom block permutations (a world should stay under 65,536)')
    # Every collider form the shipped runs reference has its block (run value = v*136 + pair).
    for n in [x for x in names if x.endswith('scripts/placement.js')]:
        m = re.search(r'^const CONFIG = (\{.*\});$', z.read(n).decode('utf-8'), re.M)
        cols = json.loads(m.group(1)).get('colliders') if m else None
        if not cols: continue
        runs = cols.get('runs', '')
        used = {(ord(runs[k]) - 40 - 1) // 136 for k in range(0, len(runs) - 1, 2) if ord(runs[k]) - 40 > 0}
        ids = {0: 'craftmatic:collider'}
        for v in used:
            if v == 0: continue
            kind, shape = (v - 1) // 14, (v - 1) % 14 + 1
            ids[v] = f'craftmatic:collider_{"wfc"[kind]}{shape}'
        for v in sorted(used):
            if ids[v] not in block_ids: problems.append(f'the collider runs use {ids[v]!r} (variant {v}) but the pack defines no such block')
        if len(used) > 1: notes.append(f'{len(used) - 1} collider forms in use')
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
