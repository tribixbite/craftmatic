"""Build the per-Actor cost probe add-on used to price entity instancing on a device.

    python scripts/_bedrock_probe_pack.py <outdir>

Writes <outdir>/probe-pack/ (the two loose pack folders) and <outdir>/CraftmaticProbe.mcaddon.

Why this exists: the entity-instancing design (ship each part SHAPE once, express a set as
transforms, one entity per placement) lives or dies on what ONE idle part actor costs. This
pack is the smallest honest stand-in for such a part: a 12-cube 2x4 brick at minifig scale,
one client-synced int property for orientation and one for a colour slot, no AI, no physics,
no gravity. `functions/p_a|p_b|p_c` spawn a nearest-first lattice around the player at
2-block spacing (500, then +1,500, then +4,000); `p_kill` removes them all.

Installing it (measured 2026-09-19 on a Pixel 8 Pro, Bedrock 1.26.51.1):
  * `adb push` CANNOT create a directory under Android/data (`secure_mkdirs() failed`), and
    `rm` there is denied - so the only way in is to let the game import the .mcaddon
    (push it to /sdcard/Download, then the VIEW intent in docs/bedrock-addon-guide.md),
    and there is no way back out over adb.
  * A freshly imported pack is invisible to world loads until the app restarts: the world's
    `world_*_packs.json` entry for it is silently dropped. force-stop + relaunch FIRST, then
    write the pack list.
  * `adb push` does not truncate: a shorter file leaves the old tail behind. Pad any shorter
    replacement to the on-device byte length (trailing whitespace is valid JSON).
"""
from __future__ import annotations

import json
import os
import sys
import uuid
import zipfile

NS = uuid.uuid5(uuid.NAMESPACE_URL, 'https://craftmatic.local/probe-2026-09-19')
VERSION = [1, 0, 1]
# 1 block = 53.33 LDU and 1 stud = 6 geometry units (engine/lego-scale.ts), so a 2x4 brick
# is 12 x 11 x 24 units. One body + eight studs + three ribs = the 12 cubes.
BODY = {"origin": [-6, 0, -12], "size": [12, 11, 24], "uv": [0, 0]}


def _uuid(tag: str) -> str:
    return str(uuid.uuid5(NS, tag))


def _write(path: str, obj: object) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, indent=2)


def _cubes() -> list[dict]:
    cubes = [dict(BODY)]
    for i in range(2):
        for j in range(4):
            cubes.append({"origin": [-6 + i * 6 + 1.5, 11, -12 + j * 6 + 1.5],
                          "size": [3, 1.8, 3], "uv": [0, 0]})
    for k in range(3):
        cubes.append({"origin": [-4.5, 1, -9 + k * 8], "size": [9, 2, 2], "uv": [0, 0]})
    assert len(cubes) == 12, len(cubes)
    return cubes


def _lattice() -> list[tuple[int, int, int]]:
    """6,000 points, nearest-first, so every batch stays one contiguous cloud."""
    pts = [(x, y, z)
           for x in range(-20, 20, 2)
           for z in range(-20, 20, 2)
           for y in range(1, 31, 2)]
    assert len(pts) == 6000, len(pts)
    pts.sort(key=lambda p: p[0] ** 2 + (p[1] - 8) ** 2 + p[2] ** 2)
    return pts


def build(outdir: str) -> str:
    src = os.path.join(outdir, 'probe-pack')
    bp, rp = os.path.join(src, 'CraftmaticProbe_BP'), os.path.join(src, 'CraftmaticProbe_RP')
    ids = {k: _uuid(k) for k in ('bp', 'bpmod', 'rp', 'rpmod')}

    _write(bp + '/manifest.json', {
        "format_version": 2,
        "header": {"name": "Craftmatic Probe (per-Actor cost probe)",
                   "description": "Throwaway measurement pack: one 12-cube part entity.",
                   "uuid": ids['bp'], "version": VERSION, "min_engine_version": [1, 21, 0]},
        "modules": [{"type": "data", "uuid": ids['bpmod'], "version": VERSION}]})
    _write(rp + '/manifest.json', {
        "format_version": 2,
        "header": {"name": "Craftmatic Probe Resources",
                   "description": "Throwaway measurement pack: one 12-cube part geometry.",
                   "uuid": ids['rp'], "version": VERSION, "min_engine_version": [1, 21, 0]},
        "modules": [{"type": "resources", "uuid": ids['rpmod'], "version": VERSION}]})

    _write(bp + '/entities/probe_part.json', {
        "format_version": "1.26.30",
        "minecraft:entity": {
            "description": {
                "identifier": "craftmatic:probe_part",
                "is_spawnable": False,
                "is_summonable": True,
                # The two per-instance values an instancing design would have to carry.
                "properties": {
                    "craftmatic:ori": {"type": "int", "range": [0, 23], "default": 0,
                                       "client_sync": True},
                    "craftmatic:tint": {"type": "int", "range": [0, 63], "default": 0,
                                        "client_sync": True}}},
            "components": {
                "minecraft:type_family": {"family": ["craftmatic_probe"]},
                "minecraft:health": {"value": 1, "max": 1},
                "minecraft:damage_sensor": {"triggers": [{"cause": "all", "deals_damage": "no"}]},
                "minecraft:fire_immune": {},
                "minecraft:collision_box": {"width": 0.1, "height": 0.1},
                "minecraft:physics": {"has_gravity": False, "has_collision": False},
                "minecraft:knockback_resistance": {"value": 1},
                "minecraft:persistent": {},
                "minecraft:conditional_bandwidth_optimization": {
                    "default_values": {"max_optimized_distance": 120, "max_dropped_ticks": 20,
                                       "use_motion_prediction_hints": False}}}}})

    _write(rp + '/models/entity/probe_part.geo.json', {
        "format_version": "1.12.0",
        "minecraft:geometry": [{
            "description": {"identifier": "geometry.craftmatic_probe_part",
                            "texture_width": 16, "texture_height": 16,
                            "visible_bounds_width": 3, "visible_bounds_height": 3,
                            "visible_bounds_offset": [0, 0.5, 0]},
            "bones": [{"name": "root", "pivot": [0, 0, 0], "cubes": _cubes()}]}]})
    _write(rp + '/animations/probe_part.animation.json', {
        "format_version": "1.8.0",
        "animations": {"animation.craftmatic_probe_part.pose": {
            "loop": True,
            "bones": {"root": {"rotation": [0, "q.property('craftmatic:ori') * 15", 0]}}}}})
    _write(rp + '/render_controllers/probe_part.render_controllers.json', {
        "format_version": "1.10.0",
        "render_controllers": {"controller.render.craftmatic_probe_part": {
            "geometry": "Geometry.default",
            "materials": [{"*": "Material.default"}],
            "textures": ["Texture.default"]}}})
    _write(rp + '/entity/probe_part.entity.json', {
        "format_version": "1.10.0",
        "minecraft:client_entity": {"description": {
            "identifier": "craftmatic:probe_part",
            "materials": {"default": "entity_alphatest"},
            "textures": {"default": "textures/entity/probe_part"},
            "geometry": {"default": "geometry.craftmatic_probe_part"},
            "animations": {"pose": "animation.craftmatic_probe_part.pose"},
            "scripts": {"animate": ["pose"]},
            "render_controllers": ["controller.render.craftmatic_probe_part"]}}})

    pts = _lattice()
    os.makedirs(bp + '/functions', exist_ok=True)
    for name, sub in (('p_a', pts[:500]), ('p_b', pts[500:2000]), ('p_c', pts[2000:6000])):
        with open(f'{bp}/functions/{name}.mcfunction', 'w', encoding='utf-8', newline='\n') as f:
            f.write(f'# generated probe spawner - {len(sub)} entities\n')
            for x, y, z in sub:
                f.write(f'summon craftmatic:probe_part ~{x} ~{y} ~{z}\n')
    with open(f'{bp}/functions/p_kill.mcfunction', 'w', encoding='utf-8', newline='\n') as f:
        f.write('kill @e[type=craftmatic:probe_part]\n')

    # A 16x16 two-tone swatch; the probe never needs a real atlas.
    tex = rp + '/textures/entity/probe_part.png'
    os.makedirs(os.path.dirname(tex), exist_ok=True)
    if not os.path.exists(tex):
        os.system(f'magick -size 16x16 xc:"#c8342a" -fill "#e8e8e8" -draw "rectangle 0,0 7,7" "{tex}"')

    out = os.path.join(outdir, 'CraftmaticProbe.mcaddon')
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(src):
            for name in sorted(files):
                p = os.path.join(root, name)
                z.write(p, os.path.relpath(p, src).replace(os.sep, '/'))
    return out


if __name__ == '__main__':
    print(build(sys.argv[1] if len(sys.argv) > 1 else 'output/bedrock-entity-qa/probe'))
