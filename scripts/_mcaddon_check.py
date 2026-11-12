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
    python scripts/_mcaddon_check.py --release pack.mcaddon   # + the sell-side rules (alias --marketplace)

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

def pack_root(manifest):
    """The folder prefix a manifest's pack occupies ('' when it sits at the archive root)."""
    return manifest.rsplit('manifest.json', 1)[0]

def owned_by(name, root, roots):
    """True when `name` belongs to the pack at `root`: the DEEPEST pack root that
    prefixes it. A plain startswith(root) is wrong for a pack at the archive
    root (root ''), which would also claim every file of the other pack."""
    if not name.startswith(root):
        return False
    return not any(len(other) > len(root) and name.startswith(other) for other in roots)

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
    # Check the emitted assets, not the exporter's prediction of which actor
    # branches use PBR. Coaster-only packs previously shipped all their maps
    # but omitted this flag because their actors were compiled later.
    roots = [pack_root(m) for m in manifests]
    for manifest in rp:
        root = pack_root(manifest)
        sets = [n for n in names if n.endswith('.texture_set.json') and owned_by(n, root, roots)]
        if sets and 'pbr' not in mans[manifest][2].get('capabilities', []):
            problems.append(f'{manifest}: {len(sets)} texture sets but no pbr capability')
        for texture_set in sets:
            channels = json.loads(z.read(texture_set).decode('utf-8-sig')).get('minecraft:texture_set', {})
            folder = texture_set.rsplit('/', 1)[0] + '/'
            for channel in ('color', 'metalness_emissive_roughness', 'normal', 'heightmap'):
                value = channels.get(channel)
                # Uniform channel values are valid; image references are
                # relative to the texture set's folder, without an extension.
                if isinstance(value, str) and not any(folder + value + ext in names for ext in ('.png', '.tga')):
                    problems.append(f'{texture_set}: {channel} image {value!r} has no file')
        if sets: notes.append(f'{len(sets)} PBR texture sets, capability and image references checked')
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
            # A tap / interact box (`minecraft:custom_hit_test`, VEH-17: every
            # rideable's drawn hull, every interactive's leaf): a square `width`
            # x `height` about a 3-number `pivot`. A box with no size or a
            # malformed pivot is nothing a finger can land on, silently.
            hit = comps.get('minecraft:custom_hit_test')
            if hit is not None:
                boxes = hit.get('hitboxes') if isinstance(hit, dict) else None
                if not isinstance(boxes, list) or not boxes:
                    problems.append(f'{n}: {where} custom_hit_test has no hitboxes')
                for i, b in enumerate(boxes or []):
                    ok = (isinstance(b, dict) and isinstance(b.get('width'), (int, float)) and b['width'] > 0
                          and isinstance(b.get('height'), (int, float)) and b['height'] > 0
                          and isinstance(b.get('pivot'), list) and len(b['pivot']) == 3
                          and all(isinstance(v, (int, float)) for v in b['pivot']))
                    if not ok:
                        problems.append(f'{n}: {where} custom_hit_test hitbox {i} is not a positive width x height about a 3-number pivot: {b!r}')
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
    # Any entity moved through the air (a flyer, a rotor, a ride car carried along
    # its path, a figure) makes the client log `[Sound][verbose] No sound found for
    # block type 'normal' and event type 'fly'` - 355 lines in a minute of flight on
    # the Saga. The line is resolved through the block-MATERIAL table: the RP
    # sounds.json's `interactive_sounds.block_sounds.normal.events.fly: ""` silenced
    # every window of the Saga A/B (2026-09-29/30, output/fly-sound-ab-0929/saga/),
    # while per-entity entries (`entity_sounds` or `interactive_sounds.entity_sounds`)
    # changed nothing. The entry must also carry vanilla's own `normal` events
    # (step/jump/land/fall) in case a pack's key REPLACES vanilla's (unknown,
    # playable-addon.ts `flySoundEvents`, TODO(fly-sound)): without them footsteps on
    # stone could go silent. A log symptom, not a load failure, but gated so no pack
    # with an entity ships without it.
    VANILLA_NORMAL_EVENTS = ('default', 'fall', 'jump', 'land', 'step')
    if n_server:
        sound_files = [x for x in names if re.search(r'_RP/sounds\.json$', x)]
        normal = None
        for sf in sound_files:
            normal = ((((json.loads(z.read(sf).decode('utf-8-sig')).get('interactive_sounds') or {}).get('block_sounds') or {}).get('normal')) or normal)
        events = normal.get('events') if isinstance(normal, dict) else None
        if not isinstance(events, dict) or events.get('fly') != '':
            problems.append(f'{n_server} entities but no silent interactive_sounds.block_sounds.normal.events.fly in {sound_files or "an RP sounds.json"}: the content log fills with "event type \'fly\'" lines')
        else:
            lost = [e for e in VANILLA_NORMAL_EVENTS if e not in events]
            if lost:
                problems.append(f'interactive_sounds.block_sounds.normal lacks vanilla\'s {", ".join(lost)} event(s): if the key replaces vanilla\'s, those sounds go silent')
            else:
                notes.append('RP silences the block-material fly sound (block_sounds.normal carries vanilla\'s events + fly "")')
    # geometries the pack defines
    geo_ids = set()
    # Bedrock floors a box-UV cube's DECLARED size and does not draw a side face whose
    # height floors to 0 (Pixel probe 2026-09-29, output/fig-faces-0929/probe/): every
    # entity geometry must declare every box-UV cube at least 1 unit on each axis
    # (`boxUvSafeCube`: size + 2 with inflate -1). Figures since 2026-09-29; shells,
    # vehicles and props since 2026-10-01 (42172's body showed its wheels through it).
    thin_by_file = {}
    for n in [x for x in names if x.endswith('.geo.json')]:
        d = json.loads(z.read(n).decode('utf-8-sig'))
        for g in d.get('minecraft:geometry', []):
            gid = (g.get('description') or {}).get('identifier')
            if gid: geo_ids.add(gid)
            for b in g.get('bones') or []:
                for c in b.get('cubes') or []:
                    if not isinstance(c.get('uv'), list): continue
                    if any(s < 1 for s in c.get('size', [1, 1, 1])):
                        thin_by_file[n] = thin_by_file.get(n, 0) + 1
    if thin_by_file:
        worst = sorted(thin_by_file.items(), key=lambda kv: -kv[1])[:3]
        problems.append(f'{sum(thin_by_file.values())} box-UV cubes in {len(thin_by_file)} geometr{"y" if len(thin_by_file) == 1 else "ies"} declare a size under 1 unit: the device drops their faces (declare size + 2 with inflate -1); worst: ' + ', '.join(f'{k.rsplit("/", 1)[-1]} {v}' for k, v in worst))
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
        # The namespace is the pack's own: the dev pack's `craftmatic`, or a rewritten product's (X-03).
        ns = next((b.rsplit(':', 1)[0] for b in sorted(block_ids) if b.endswith(':collider')), 'craftmatic')
        ids = {0: f'{ns}:collider'}
        for v in used:
            if v == 0: continue
            kind, shape = (v - 1) // 14, (v - 1) % 14 + 1
            ids[v] = f'{ns}:collider_{"wfc"[kind]}{shape}'
        for v in sorted(used):
            if ids[v] not in block_ids: problems.append(f'the collider runs use {ids[v]!r} (variant {v}) but the pack defines no such block')
        if len(used) > 1: notes.append(f'{len(used) - 1} collider forms in use')
    return problems, notes

# ---------------------------------------------------------------------------
# --release: the rules a pack must meet to be SOLD (Marketplace, CurseForge,
# MCPEDL). BIZ-24 / BIZ-54, docs/plans/README.md X-06. These are ADDITIONAL to
# check(): the dev-mode rules above are unchanged (dev keeps 65,536 permutations
# and the `craftmatic:` namespace; a release may use neither).
# ---------------------------------------------------------------------------

RELEASE_MAX_PERMUTATIONS = 10_000          # registered block permutations, whole pack
RELEASE_MAX_BYTES = 25 * 1024 * 1024       # uncompressed (25 MiB)
RELEASE_MAX_FILES = 3_500
RELEASE_MAX_TEXTURE_PX = {'blocks': 256, 'items': 256}   # every other texture folder: the default
RELEASE_DEFAULT_TEXTURE_PX = 2048
RELEASE_FORBIDDEN_NAMESPACES = ('craftmatic', 'minecraft')
RELEASE_EXAMPLES = 4                       # how many offending paths one message names

# Content-type folders: a file inside one must sit at <folder>/<creator>/<pack>/...
# `models` and `textures` nest one level further (models/entity, textures/blocks).
RELEASE_CONTENT_FOLDERS = (
    'entities', 'blocks', 'items', 'structures', 'functions', 'animations', 'animation_controllers',
    'loot_tables', 'recipes', 'trading', 'spawn_rules', 'features', 'feature_rules', 'biomes',
    'entity', 'render_controllers', 'particles', 'attachables', 'materials', 'fogs',
    'models/entity', 'models/blocks', 'textures/blocks', 'textures/items', 'textures/entity',
    'textures/ui', 'textures/particle', 'textures/environment', 'textures/colormap',
)
# Vanilla texture paths a pack must not overwrite. A pattern list, not a full
# resource-pack inventory. TODO(vanilla-list): regenerate from the vanilla
# resource pack once the Marketplace review confirms the exact set.
RELEASE_VANILLA_TEXTURE_PATTERNS = (
    re.compile(r'^textures/blocks/(concrete|concrete_powder|wool_colored|stained_glass|glazed_terracotta|hardened_clay_stained)_[a-z_]+\.(png|tga)$'),
    re.compile(r'^textures/blocks/(stone|dirt|grass_(top|side|side_carried)|cobblestone|sand|gravel|bedrock|glass|brick|bookshelf|obsidian|netherrack|'
               r'iron_block|gold_block|diamond_block|emerald_block|coal_block|planks_[a-z_]+|log_[a-z_]+|leaves_[a-z_]+|sandstone_[a-z_]+|water_still|lava_still)\.(png|tga)$'),
    re.compile(r'^textures/items/(apple|stick|diamond|iron_ingot|gold_ingot|coal|bread|bucket_[a-z]+)\.(png|tga)$'),
    re.compile(r'^textures/entity/(steve|alex|creeper|zombie|skeleton|pig|cow|sheep|chicken|villager|enderman|horse|wolf|cat|boat)(/.*|\.(png|tga))$'),
)
# The atlas files (terrain_texture / item_texture / flipbook_textures) are NOT listed by path: a resource pack ships its
# own `textures/terrain_texture.json` to give its custom blocks their textures (Microsoft's custom-block tutorials do
# exactly this; the game merges it with vanilla's). They are judged by CONTENT, `_atlas_vanilla` below.
RELEASE_ATLAS_FILES = {
    'terrain_texture.json': 'textures/blocks/{}.png',
    'item_texture.json': 'textures/items/{}.png',
    'flipbook_textures.json': None,
}
# Download hosts / words that make a link an "external download" (CurseForge, MCPEDL).
RELEASE_DOWNLOAD_LINK = re.compile(
    r'https?://\S*(mediafire|mega\.nz|dropbox|drive\.google|1drv\.ms|adf\.ly|linkvertise|anonfiles|gofile|sharemods)\S*|https?://\S*download\S*',
    re.I)
RELEASE_TEXT_SUFFIXES = ('.txt', '.md', '.lang')


def _image_size(head):
    """(width, height) from the first bytes of a PNG or TGA, or None when neither."""
    if head[:8] == b'\x89PNG\r\n\x1a\n' and len(head) >= 24:
        return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')
    if len(head) >= 16 and head[2] in (2, 3, 10, 11):               # uncompressed/RLE true-colour or grey TGA
        return int.from_bytes(head[12:14], 'little'), int.from_bytes(head[14:16], 'little')
    return None


def _is_vanilla_texture(path):
    """True when `path` (with or without an extension) is one of the vanilla texture paths a pack must not overwrite."""
    candidates = [path] if re.search(r'\.(png|tga)$', path) else [path + '.png']
    return any(p.match(c) for p in RELEASE_VANILLA_TEXTURE_PATTERNS for c in candidates)


def _atlas_texture_paths(node):
    """Every texture path an atlas entry names: a string, a {path} / {variations: [...]} object, or a list of them."""
    if isinstance(node, str):
        yield node
    elif isinstance(node, list):
        for x in node:
            yield from _atlas_texture_paths(x)
    elif isinstance(node, dict):
        for k in ('path', 'textures', 'variations'):
            if k in node:
                yield from _atlas_texture_paths(node[k])


def _atlas_vanilla(name, data):
    """Vanilla short names and vanilla texture paths an atlas file redefines (a pack's own keys and paths are fine)."""
    key_template = RELEASE_ATLAS_FILES[name.rsplit('/', 1)[-1]]
    hits = []
    if name.endswith('flipbook_textures.json'):
        for entry in data if isinstance(data, list) else []:
            if isinstance(entry, dict):
                ref = entry.get('flipbook_texture')
                if isinstance(ref, str) and _is_vanilla_texture(ref):
                    hits.append(ref)
        return hits
    for key, entry in ((data.get('texture_data') if isinstance(data, dict) else None) or {}).items():
        if key_template and _is_vanilla_texture(key_template.format(key)):
            hits.append(key)
        hits.extend(p for p in _atlas_texture_paths((entry or {}).get('textures') if isinstance(entry, dict) else None) if _is_vanilla_texture(p))
    return hits


def _brief(items, limit=RELEASE_EXAMPLES):
    """'a, b, c, d (+N more)' for a message."""
    items = sorted(items)
    more = f' (+{len(items) - limit} more)' if len(items) > limit else ''
    return ', '.join(items[:limit]) + more


def _json(z, name):
    return json.loads(z.read(name).decode('utf-8-sig'))


def _pack_namespaces(z, names):
    """{namespace: [file, ...]} over every entity/block/item/geometry/animation/render-controller id."""
    found = {}
    def add(ns, where):
        found.setdefault(ns, []).append(where)
    for n in names:
        if not n.endswith('.json'):
            continue
        try:
            d = _json(z, n)
        except ValueError:
            continue
        if not isinstance(d, dict):
            continue
        for key in ('minecraft:entity', 'minecraft:client_entity', 'minecraft:block', 'minecraft:item'):
            body = d.get(key)
            desc = body.get('description') if isinstance(body, dict) else None
            ident = desc.get('identifier') if isinstance(desc, dict) else None
            if isinstance(ident, str) and ':' in ident:
                add(ident.split(':', 1)[0], n)
        for g in d.get('minecraft:geometry') or []:
            gid = (g.get('description') or {}).get('identifier', '') if isinstance(g, dict) else ''
            if gid.startswith('geometry.') and gid.count('.') >= 2:
                add(gid.split('.')[1], n)
        for key, prefix in (('animations', 'animation.'), ('animation_controllers', 'controller.animation.'),
                            ('render_controllers', 'controller.render.')):
            table = d.get(key)
            for ident in (table if isinstance(table, dict) else ()):
                if ident.startswith(prefix) and '.' in ident[len(prefix):]:
                    add(ident[len(prefix):].split('.')[0], n)
    return found


def _owner(name, roots):
    """The pack root (deepest) that prefixes `name`, or None."""
    hits = [r for r in roots if name.startswith(r)]
    return max(hits, key=len) if hits else None


def check_release(path):
    """The release-only rules over one archive -> (problems, notes)."""
    z = zipfile.ZipFile(path)
    infos = [i for i in z.infolist() if not i.filename.endswith('/')]
    names = [i.filename for i in infos]
    problems, notes = [], []
    manifests = [n for n in names if n.endswith('manifest.json')]
    roots = [pack_root(m) for m in manifests]
    mans = {}
    for m in manifests:
        try:
            mans[m] = _json(z, m)
        except ValueError:
            problems.append(f'{m}: manifest is not JSON')
    kind = lambda d: {mo.get('type') for mo in d.get('modules', [])}
    bp = next((m for m, d in mans.items() if kind(d) & {'data', 'script'}), None)
    rp = next((m for m, d in mans.items() if 'resources' in kind(d)), None)

    # 1. pack_scope, 2. mutual dependencies.
    if rp:
        scope = (mans[rp].get('header') or {}).get('pack_scope')
        if scope != 'world':
            problems.append(f'{rp}: header.pack_scope is {scope!r}, a release resource pack must declare "world"')
    deps_of = lambda d: {str(x.get('uuid')) for x in d.get('dependencies', []) if isinstance(x, dict) and 'uuid' in x}
    if bp and rp:
        bp_uuid, rp_uuid = (mans[bp].get('header') or {}).get('uuid'), (mans[rp].get('header') or {}).get('uuid')
        if bp_uuid not in deps_of(mans[rp]):
            problems.append(f'{rp}: resource pack does not depend on the behaviour pack header uuid {bp_uuid}')
        if rp_uuid not in deps_of(mans[bp]):
            problems.append(f'{bp}: behaviour pack does not depend on the resource pack header uuid {rp_uuid}')
    elif manifests:
        problems.append('release needs one behaviour pack (data/script module) and one resource pack (resources module)')

    # 3. one namespace, not craftmatic / minecraft.
    spaces = _pack_namespaces(z, names)
    if len(spaces) > 1:
        problems.append('more than one namespace across entity/block/item/geometry/animation/render-controller ids: '
                        + '; '.join(f'{ns!r} in {len(set(w))} file(s)' for ns, w in sorted(spaces.items())))
    for ns in RELEASE_FORBIDDEN_NAMESPACES:
        if ns in spaces:
            why = 'redefines vanilla content' if ns == 'minecraft' else 'is the development namespace'
            problems.append(f'namespace {ns!r} {why} ({len(set(spaces[ns]))} file(s), e.g. {_brief(set(spaces[ns]), 2)}); a release uses its own')
    if len(spaces) == 1:
        notes.append(f'namespace {next(iter(spaces))!r}')

    # 4. <type>/<creator>/<pack>/ folders, no loose files, one creator/pack pair.
    loose, pairs = [], set()
    for n in names:
        owner = _owner(n, roots)
        if owner is None:
            continue
        rel = n[len(owner):]
        folder = next((f for f in RELEASE_CONTENT_FOLDERS if rel.startswith(f + '/')), None)
        if folder is None:
            continue
        parts = rel[len(folder) + 1:].split('/')
        if len(parts) < 3:
            loose.append(rel)
        else:
            pairs.add((parts[0], parts[1]))
    if loose:
        problems.append(f'{len(loose)} file(s) not under <type>/<creator>/<pack>/: {_brief(loose)}')
    if len(pairs) > 1:
        problems.append(f'content folders use {len(pairs)} different <creator>/<pack> pairs: {_brief({"/".join(p) for p in pairs})}')

    # 5. vanilla texture paths.
    vanilla = []
    for n in names:
        owner = _owner(n, roots)
        rel = n[len(owner):] if owner is not None else n
        if any(p.match(rel) for p in RELEASE_VANILLA_TEXTURE_PATTERNS):
            vanilla.append(rel)
    if vanilla:
        problems.append(f'{len(vanilla)} file(s) at a vanilla texture path: {_brief(vanilla)}')
    for n in names:
        owner = _owner(n, roots)
        rel = n[len(owner):] if owner is not None else n
        if rel in ('textures/' + f for f in RELEASE_ATLAS_FILES):
            try:
                redefined = _atlas_vanilla(rel, _json(z, n))
            except (ValueError, AttributeError):
                problems.append(f'{rel} is not a readable texture atlas')
                continue
            if redefined:
                problems.append(f'{rel} redefines vanilla texture(s): {_brief(set(redefined))}')

    # 6. registered permutations (dev mode allows 65,536).
    registered = 0
    for n in [x for x in names if '/blocks/' in x and x.endswith('.json')]:
        try:
            blk = _json(z, n).get('minecraft:block')
        except ValueError:
            continue
        if not isinstance(blk, dict):
            continue
        perms = 1
        for sdef in ((blk.get('description') or {}).get('states') or {}).values():
            vals = sdef.get('values') if isinstance(sdef, dict) else sdef
            count = (vals['max'] - vals['min'] + 1) if isinstance(vals, dict) else len(vals or [])
            perms *= max(1, count)
        registered += perms
    if registered > RELEASE_MAX_PERMUTATIONS:
        problems.append(f'{registered} registered block permutations (a release allows {RELEASE_MAX_PERMUTATIONS:,})')
    notes.append(f'{registered} permutations')

    # 7. size and file count.
    total = sum(i.file_size for i in infos)
    if total > RELEASE_MAX_BYTES:
        problems.append(f'{total / 1048576:.1f} MiB uncompressed (a release allows {RELEASE_MAX_BYTES // 1048576} MiB)')
    if len(infos) > RELEASE_MAX_FILES:
        problems.append(f'{len(infos)} files (a release allows {RELEASE_MAX_FILES:,})')
    notes.append(f'{total / 1048576:.1f} MiB, {len(infos)} files')

    # 8. texture dimensions.
    oversize = []
    for i in infos:
        if not i.filename.endswith(('.png', '.tga')):
            continue
        rel = i.filename[len(_owner(i.filename, roots) or ''):]
        if not rel.startswith('textures/') or rel.count('/') < 2:
            continue
        with z.open(i) as fh:
            size = _image_size(fh.read(32))
        if size is None:
            problems.append(f'{rel}: not a readable PNG/TGA')
            continue
        limit = RELEASE_MAX_TEXTURE_PX.get(rel.split('/')[1], RELEASE_DEFAULT_TEXTURE_PX)
        if max(size) > limit:
            oversize.append(f'{rel} {size[0]}x{size[1]} > {limit}')
    if oversize:
        problems.append(f'{len(oversize)} texture(s) over the size limit (block/item {RELEASE_MAX_TEXTURE_PX["blocks"]} px, others {RELEASE_DEFAULT_TEXTURE_PX}): {_brief(oversize)}')

    # 9. no -beta script modules.
    for m, d in mans.items():
        beta = [f'{x.get("module_name")}@{x.get("version")}' for x in d.get('dependencies', [])
                if isinstance(x, dict) and 'beta' in str(x.get('version', '')).lower()]
        if beta:
            problems.append(f'{m}: beta script module(s) {", ".join(beta)} (a release uses stable modules only)')

    # 10. no minecraft: definitions (the namespace rule names the ids; this names the files).
    overrides = sorted(set(spaces.get('minecraft', [])))
    if overrides:
        problems.append(f'{len(overrides)} file(s) define minecraft: ids: {_brief(overrides)}')

    # 11. no diagnostics file.
    diag = [n for n in names if n.rsplit('/', 1)[-1].endswith('-diagnostics.json')]
    if diag:
        problems.append(f'dev diagnostics shipped: {_brief(diag)}')

    # 12. zip without root (CurseForge / MCPEDL): a .zip must not wrap everything in one folder.
    if str(path).lower().endswith('.zip'):
        tops = {n.split('/', 1)[0] for n in names}
        if names and all('/' in n for n in names) and len(tops) == 1:
            problems.append(f'zip is wrapped in one root folder {next(iter(tops))!r}; zip the pack folders themselves')

    # 13. no external download links (BIZ-54).
    links = []
    for n in names:
        if n.endswith(RELEASE_TEXT_SUFFIXES) or n.endswith('manifest.json'):
            for ln in z.read(n).decode('utf-8-sig', 'replace').splitlines():
                if RELEASE_DOWNLOAD_LINK.search(ln):
                    links.append(f'{n.rsplit("/", 1)[-1]}: {ln.strip()[:60]}')
    if links:
        problems.append(f'{len(links)} external download link(s): {_brief(links)}')
    return problems, notes


def main() -> int:
    # `--release` (alias `--marketplace`) adds the sell-side rules; without it the
    # run is exactly the dev-mode gate it always was.
    args = sys.argv[1:]
    release = any(a in ('--release', '--marketplace') for a in args)
    packs = [a for a in args if a not in ('--release', '--marketplace')]
    if not packs:
        print(__doc__)
        return 2
    bad = 0
    for p in packs:
        try:
            probs, notes = check(p)
            if release:
                rprobs, rnotes = check_release(p)
                probs, notes = probs + [f'[release] {x}' for x in rprobs], notes + rnotes
        except Exception as exc:                       # a corrupt archive is a failure too
            print(f'FAIL {Path(p).name:28s} unreadable: {type(exc).__name__}: {exc}')
            bad += 1
            continue
        print(f'{"OK  " if not probs else "FAIL"} {Path(p).name:28s} {"; ".join(notes)}')
        for x in probs:
            print(f'       !! {x}')
        bad += bool(probs)
    print()
    print(f'{len(packs) - bad}/{len(packs)} packs structurally valid{" (release rules)" if release else ""}')
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
