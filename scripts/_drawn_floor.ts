/**
 * Where an entity's geometry is DRAWN relative to its origin, rotations applied.
 *
 * For every `*.geo.json` in a pack whose name matches a filter, this rotates
 * each cube's corners by its own rotation and by every bone rotation up its
 * parent chain (both about their pivots: `pivotRotation` and
 * `boneTransforms` from `bedrock-geometry-faces.ts`, the one convention the
 * Walk preview and the LOD hull use) and prints the lowest and highest drawn point in blocks. A
 * lowest point well above 0 means the entity's origin sits under empty space:
 * 10365's did, 2.86 blocks, so its boat draft sank nothing (Saga probe
 * 2026-09-28).
 *
 * Usage: bun scripts/_drawn_floor.ts <pack.mcaddon> [name-filter] [--world]
 *
 * `--world` adds each placed actor's position (`scripts/placement.js`) to its
 * drawn box: the world span it covers when placed at 100 % (the JSON frame is
 * the world mirrored in Z). Two builds that only move geometry against its
 * origin, with the origin moved to match, print the same world spans.
 */
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { apply, boneTransforms, mul, pivotRotation, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';

interface Bone { name: string; parent?: string; pivot?: Vec3; rotation?: Vec3; cubes?: Array<{ origin: Vec3; size: Vec3; pivot?: Vec3; rotation?: Vec3 }> }

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const [packPath, filter = ''] = positional;
const worldMode = process.argv.includes('--world');
if (!packPath) throw new Error('usage: <pack.mcaddon> [name-filter]');

/** Every file inside the pack, descending into nested .mcpack archives. */
function files(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    if (name.endsWith('.mcpack')) for (const [n, d] of files(data)) out.set(`${name}/${n}`, d);
    else out.set(name, data);
  }
  return out;
}

const all = files(new Uint8Array(readFileSync(packPath)));
/** Actor positions and yaw by type id, from the placement script's actor table. */
const actors = new Map<string, Array<{ x: number; y: number; z: number; yaw: number }>>();
for (const [name, data] of all) {
  if (!name.endsWith('scripts/placement.js')) continue;
  const text = strFromU8(data);
  const re = /"typeId":"craftmatic:([^"]+)","label":"[^"]*","x":(-?[\d.e-]+),"y":(-?[\d.e-]+),"z":(-?[\d.e-]+),"yaw":(-?[\d.e-]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const list = actors.get(m[1]!) ?? [];
    list.push({ x: Number(m[2]), y: Number(m[3]), z: Number(m[4]), yaw: Number(m[5]) });
    actors.set(m[1]!, list);
  }
}

for (const [name, data] of all) {
  if (!name.endsWith('.geo.json') || !name.includes(filter)) continue;
  const doc = JSON.parse(strFromU8(data)) as { 'minecraft:geometry': Array<{ bones: Bone[] }> };
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let rawLo = Infinity;
  for (const geo of doc['minecraft:geometry']) {
    const world = boneTransforms(geo.bones.map(b => ({ name: b.name, pivot: b.pivot ?? [0, 0, 0], ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) })));
    for (const bone of geo.bones) {
      const m = world.get(bone.name)!;
      for (const c of bone.cubes ?? []) {
        rawLo = Math.min(rawLo, c.origin[1]);
        const toWorld = c.rotation ? mul(m, pivotRotation(c.rotation, c.pivot ?? [0, 0, 0])) : m;
        for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
          const p = apply(toWorld, [c.origin[0] + dx * c.size[0], c.origin[1] + dy * c.size[1], c.origin[2] + dz * c.size[2]]);
          for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, p[i]!); hi[i] = Math.max(hi[i]!, p[i]!); }
        }
      }
    }
  }
  if (lo[1] === Infinity) continue;
  const file = name.split('/').pop()!;
  if (!worldMode) {
    console.log(`${file}: drawn y ${(lo[1] / 16).toFixed(2)} .. ${(hi[1] / 16).toFixed(2)} blocks (raw cube origins from ${(rawLo / 16).toFixed(2)})`);
    continue;
  }
  const type = file.replace(/\.geo\.json$/, '').replace(/_mesh_\d+$/, '');
  for (const a of actors.get(type) ?? []) {
    if (a.yaw !== 0) { console.log(`${file} @yaw ${a.yaw}: skipped (only yaw 0 is compared)`); continue; }
    // JSON frame -> world: blocks, Z mirrored.
    const f = (v: number): string => v.toFixed(2);
    console.log(`${file}: world x ${f(a.x + lo[0]! / 16)} .. ${f(a.x + hi[0]! / 16)}  y ${f(a.y + lo[1]! / 16)} .. ${f(a.y + hi[1]! / 16)}  z ${f(a.z - hi[2]! / 16)} .. ${f(a.z - lo[2]! / 16)}`);
  }
}
