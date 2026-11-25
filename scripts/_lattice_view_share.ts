/**
 * What a shell lattice lets a child SEE at 400 % (cull-400): re-bins a built pack's shell cubes on several lattice
 * cell sizes and measures, against the 70-block actor draw ceiling (camera-to-ROOT, `ACTOR_DRAW_CEILING_BLOCKS`):
 *
 *   outside   the share of the shell's cubes drawn from a camera on the ground at 8 bearings, d blocks off the
 *             model's footprint (worst bearing / mean);
 *   near      the guarantee: the largest G such that every cube within G blocks of ANY camera (round it, in it,
 *             over it) is drawn - the ceiling less the lattice's worst root-to-cube reach;
 *   chunks    the shell entities the lattice spawns.
 *
 * It reads the pack's own chunks (their geometry and placed roots), so the cubes are exactly the shipped ones. The
 * re-binned lattices place each cube by its drawn centre and root each cell at its centre like `splitStaticShell`,
 * but neither cut a straddling cube (A-18) nor lift an under-floor root: an estimate for choosing a cell size, never
 * a substitute for the simulator's walk-away on a pack built at that size. Chunk loading is not modelled.
 *
 * Usage: bun scripts/_lattice_view_share.ts <pack.mcaddon>... [--cells=13,11,9,7] [--size=400]
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { boneTransforms, cubeCorners, type Vec3 } from '../web/src/engine/bedrock-geometry-faces.ts';
import { ACTOR_DRAW_CEILING_BLOCKS } from '../web/src/engine/bedrock-lod-hull.ts';
import { LANDMARK_SHELL_CELL_BLOCKS, STATIC_SHELL_CELL_BLOCKS, shellChunkCell } from '../web/src/engine/bedrock-building-shell.ts';

interface GeoCube { origin: [number, number, number]; size: [number, number, number]; rotation?: [number, number, number]; pivot?: [number, number, number] }
interface GeoBone { name: string; parent?: string; pivot?: [number, number, number]; rotation?: [number, number, number]; cubes?: GeoCube[] }

/** One shipped shell cube: its drawn centre in the shell's JSON frame (blocks), and its farthest corner offset. */
interface ShellCube { c: Vec3; corners: Vec3[] }

const args = process.argv.slice(2);
const files = args.filter(a => !a.startsWith('--'));
const cells = (args.find(a => a.startsWith('--cells='))?.slice(8) ?? `${STATIC_SHELL_CELL_BLOCKS},11,${LANDMARK_SHELL_CELL_BLOCKS},7`).split(',').map(Number);
const f = Number(args.find(a => a.startsWith('--size='))?.slice(7) ?? 400) / 100;
if (!files.length) { console.error('usage: bun scripts/_lattice_view_share.ts <pack.mcaddon>... [--cells=13,11,9,7] [--size=400]'); process.exit(2); }

const hyp = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

for (const file of files) {
  const addon = await readAddon(new Uint8Array(readFileSync(file)));
  const pack = readCraftmaticPack(addon);
  if (!pack) { console.log(`${basename(file)}: not a craftmatic pack`); continue; }
  const rp = addon.packs.find(p => p.kind === 'resource')!;
  const shells = pack.placement.actors.filter(a => /_shell(_|$)/.test(a.typeId));
  // The shell's JSON frame: each chunk's root sits at its offset from the whole-shell root (world z mirrored).
  // A standard chunk's cell gives the floor plane: root y = floorY + (iy + 0.5) S for a cell at or over the floor.
  const cubes: ShellCube[] = [];
  let base: Vec3 | undefined, floorY = 0;
  for (const a of shells) {
    const bare = a.typeId.replace(/^[^:]*:/, '');
    const geoFile = [...rp.files.keys()].find(k => k.endsWith(`models/entity/${bare}.geo.json`));
    if (!geoFile) continue;
    const cell = shellChunkCell(a.typeId);
    const S = /_shell_f/.test(bare) ? LANDMARK_SHELL_CELL_BLOCKS : STATIC_SHELL_CELL_BLOCKS;
    // The chunk root in the JSON frame: its cell's centre (x, z); y from the placement (relative to the first chunk).
    const rootJson: Vec3 = cell ? [(cell[0] + 0.5) * S, 0, (cell[2] + 0.5) * S] : [0, 0, 0];
    if (!base) {
      base = [a.x - rootJson[0], a.y, a.z + rootJson[2]];
      if (cell) floorY = -(cell[1] + 0.5) * S;
    }
    rootJson[1] = a.y - base[1];
    const doc = JSON.parse(new TextDecoder().decode(rp.files.get(geoFile)!)) as { 'minecraft:geometry': Array<{ bones: GeoBone[] }> };
    for (const g of doc['minecraft:geometry']) {
      const bones = g.bones.map(b => ({ name: b.name, pivot: b.pivot ?? [0, 0, 0], ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) })) as Parameters<typeof boneTransforms>[0];
      const tf = boneTransforms(bones);
      for (const b of g.bones) for (const cube of b.cubes ?? []) {
        const corners = cubeCorners({ bone: b.name, origin: cube.origin, size: cube.size, ...(cube.rotation ? { rotation: cube.rotation } : {}), ...(cube.pivot ? { pivot: cube.pivot } : {}) } as Parameters<typeof cubeCorners>[0], tf.get(b.name)!)
          .map(p => [rootJson[0] + p[0] / 16, rootJson[1] + p[1] / 16, rootJson[2] + p[2] / 16] as Vec3);
        const c = [0, 1, 2].map(k => corners.reduce((s, p) => s + p[k]!, 0) / 8) as Vec3;
        cubes.push({ c, corners });
      }
    }
  }
  // World at the wand factor about the whole-shell root (yaw 0: x, y as is, z mirrored).
  const world = (p: Vec3): Vec3 => [p[0] * f, p[1] * f, -p[2] * f];
  const wc = cubes.map(q => world(q.c));
  const lo = [0, 1, 2].map(k => Math.min(...wc.map(p => p[k]!))), hi = [0, 1, 2].map(k => Math.max(...wc.map(p => p[k]!)));
  const mid: Vec3 = [(lo[0]! + hi[0]!) / 2, lo[1]!, (lo[2]! + hi[2]!) / 2];
  const half = [(hi[0]! - lo[0]!) / 2, (hi[2]! - lo[2]!) / 2];
  console.log(`${basename(file)}: ${cubes.length} shell cubes in ${shells.length} chunks; at ${f * 100} percent ${(hi[0]! - lo[0]!).toFixed(0)} x ${(hi[1]! - lo[1]!).toFixed(0)} x ${(hi[2]! - lo[2]!).toFixed(0)} blocks`);
  for (const S of cells) {
    const rootOf = (c: Vec3): Vec3 => world([(Math.floor(c[0] / S) + 0.5) * S, floorY + (Math.floor((c[1] - floorY) / S) + 0.5) * S, (Math.floor(c[2] / S) + 0.5) * S]);
    const roots = cubes.map(q => rootOf(q.c));
    const chunks = new Set(roots.map(r => r.map(v => v.toFixed(3)).join())).size;
    let reach = 0;
    cubes.forEach((q, i) => { for (const p of q.corners) reach = Math.max(reach, hyp(world(p), roots[i]!)); });
    const out: string[] = [];
    for (const d of [10, 20, 30, 40, 50]) {
      const shares: number[] = [];
      for (let b = 0; b < 8; b++) {
        const a = Math.PI * 5 / 4 + b * Math.PI / 4, ux = Math.cos(a), uz = Math.sin(a);
        const edge = Math.min(Math.abs(ux) > 1e-9 ? half[0]! / Math.abs(ux) : Infinity, Math.abs(uz) > 1e-9 ? half[1]! / Math.abs(uz) : Infinity);
        const cam: Vec3 = [mid[0] + ux * (edge + d), lo[1]! + 1.62, mid[2] + uz * (edge + d)];
        shares.push(roots.filter(r => hyp(r, cam) <= ACTOR_DRAW_CEILING_BLOCKS).length / roots.length);
      }
      out.push(`${d}: ${Math.round(Math.min(...shares) * 100)}/${Math.round(shares.reduce((s, v) => s + v, 0) / shares.length * 100)}`);
    }
    console.log(`  ${String(S).padStart(2)}-block cells: ${String(chunks).padStart(4)} chunks, worst reach ${reach.toFixed(1)} at ${f * 100} percent -> near guarantee ${(ACTOR_DRAW_CEILING_BLOCKS - reach).toFixed(1)} blocks; outside share percent (worst/mean) ${out.join('  ')}`);
  }
}
