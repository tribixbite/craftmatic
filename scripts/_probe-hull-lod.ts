#!/usr/bin/env bun
/**
 * THROWAWAY PROBE (no shipped code changed) — Q3(b): how many cuboids a
 * hull-only LOD geometry would cost.
 *
 *   bun scripts/_probe-hull-lod.ts <extracted-pack-dir>...
 *
 * Voxelises the SHIPPED cube set of a pack's heaviest entity on the compiler's
 * own block cell (1 block = `LDU_PER_BLOCK` LDU = 16 model units at 1x model
 * scale) and at 2 blocks, keeps only SURFACE voxels (a voxel with at least one
 * empty 6-neighbour), greedy-merges them into axis-aligned cuboids, and prices
 * the result at the mean per-cuboid JSON size of the pack's own emitted form.
 *
 * A rotated cube contributes its world AABB, which is the right call for a
 * hull: it is a coarse silhouette, not the model.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';

type Vec3 = [number, number, number];
const deg = Math.PI / 180;
function rot(p: Vec3, r: Vec3): Vec3 {
  const [rx, ry, rz] = [r[0] * deg, r[1] * deg, r[2] * deg];
  let [x, y, z] = p;
  let t = y * Math.cos(rx) - z * Math.sin(rx); z = y * Math.sin(rx) + z * Math.cos(rx); y = t;
  t = x * Math.cos(ry) + z * Math.sin(ry); z = -x * Math.sin(ry) + z * Math.cos(ry); x = t;
  t = x * Math.cos(rz) - y * Math.sin(rz); y = x * Math.sin(rz) + y * Math.cos(rz); x = t;
  return [x, y, z];
}

interface Box { min: Vec3; max: Vec3 }

function boxesOf(path: string, colourOfGeo?: (identifier: string) => string): { boxes: Box[]; cubeBytes: number; cubes: number; colours: string[] } {
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  const colours: string[] = [];
  const geos = doc['minecraft:geometry'] as Array<{ description: { identifier: string }; bones: Array<{ name: string; parent?: string; pivot: Vec3; rotation?: Vec3; cubes?: Array<{ origin: Vec3; size: Vec3; rotation?: Vec3; pivot?: Vec3 }> }> }>;
  const boxes: Box[] = [];
  let cubeBytes = 0, cubes = 0;
  for (const g of geos) {
    const colour = colourOfGeo ? colourOfGeo(g.description.identifier) : 'all';
    const bRot = new Map<string, Vec3 | undefined>(), bPiv = new Map<string, Vec3>(), bPar = new Map<string, string | undefined>();
    for (const b of g.bones) { bRot.set(b.name, b.rotation); bPiv.set(b.name, b.pivot); bPar.set(b.name, b.parent); }
    for (const b of g.bones) for (const c of b.cubes ?? []) {
      cubes++; cubeBytes += JSON.stringify(c).length;
      let pts: Vec3[] = [];
      for (const x of [c.origin[0], c.origin[0] + c.size[0]]) for (const y of [c.origin[1], c.origin[1] + c.size[1]]) for (const z of [c.origin[2], c.origin[2] + c.size[2]]) pts.push([x, y, z]);
      if (c.rotation && c.pivot) { const p = c.pivot; pts = pts.map(q => { const r = rot([q[0] - p[0], q[1] - p[1], q[2] - p[2]], c.rotation!); return [r[0] + p[0], r[1] + p[1], r[2] + p[2]] as Vec3; }); }
      for (let n: string | undefined = b.name; n; n = bPar.get(n)) {
        const r = bRot.get(n); if (!r) continue;
        const p = bPiv.get(n)!;
        pts = pts.map(q => { const t = rot([q[0] - p[0], q[1] - p[1], q[2] - p[2]], r); return [t[0] + p[0], t[1] + p[1], t[2] + p[2]] as Vec3; });
      }
      const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const q of pts) for (let i = 0; i < 3; i++) { if (q[i]! < min[i]!) min[i] = q[i]!; if (q[i]! > max[i]!) max[i] = q[i]!; }
      boxes.push({ min, max });
      colours.push(colour);
    }
  }
  return { boxes, cubeBytes, cubes, colours };
}

/** Greedy 3-D box merge over a solid mask: x first, then y, then z. */
function greedyBoxes(solid: Uint8Array, nx: number, ny: number, nz: number): number {
  const at = (x: number, y: number, z: number): number => (x * ny + y) * nz + z;
  const used = new Uint8Array(solid.length);
  let n = 0;
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (!solid[at(x, y, z)] || used[at(x, y, z)]) continue;
    let ex = x; while (ex + 1 < nx && solid[at(ex + 1, y, z)] && !used[at(ex + 1, y, z)]) ex++;
    let ey = y;
    grow: while (ey + 1 < ny) {
      for (let xx = x; xx <= ex; xx++) if (!solid[at(xx, ey + 1, z)] || used[at(xx, ey + 1, z)]) break grow;
      ey++;
    }
    let ez = z;
    growz: while (ez + 1 < nz) {
      for (let xx = x; xx <= ex; xx++) for (let yy = y; yy <= ey; yy++) if (!solid[at(xx, yy, ez + 1)] || used[at(xx, yy, ez + 1)]) break growz;
      ez++;
    }
    for (let xx = x; xx <= ex; xx++) for (let yy = y; yy <= ey; yy++) for (let zz = z; zz <= ez; zz++) used[at(xx, yy, zz)] = 1;
    n++;
  }
  return n;
}

const UNITS_PER_BLOCK = 16;
for (const dir of process.argv.slice(2)) {
  const rpName = readdirSync(dir).find(n => /_RP$/.test(n))!;
  const modelDir = join(dir, rpName, 'models', 'entity');
  const files = readdirSync(modelDir).filter(f => f.endsWith('.geo.json') && !/_preview\./.test(f));
  const colourOfGeoFor = (entityId: string): ((id: string) => string) => {
    const ePath = join(dir, rpName, 'entity', `${entityId}.entity.json`);
    const rPath = join(dir, rpName, 'render_controllers', `${entityId}.render_controllers.json`);
    if (!existsSync(ePath) || !existsSync(rPath)) return (): string => 'all';
    const ce = JSON.parse(readFileSync(join(dir, rpName, 'entity', `${entityId}.entity.json`), 'utf8'))['minecraft:client_entity'].description;
    const rc = JSON.parse(readFileSync(join(dir, rpName, 'render_controllers', `${entityId}.render_controllers.json`), 'utf8')).render_controllers as Record<string, { geometry: string; textures: string[] }>;
    const byGeoId = new Map<string, string>();
    for (const ctrl of Object.values(rc)) {
      const gid = (ce.geometry as Record<string, string>)[ctrl.geometry.replace(/^Geometry\./, '')];
      const tex = (ce.textures as Record<string, string>)[(ctrl.textures[0] ?? 'Texture.default').replace(/^Texture\./, '')] ?? '?';
      if (gid) byGeoId.set(gid, basename(tex));
    }
    return (id: string): string => byGeoId.get(id) ?? '?';
  };
  const loaded = files.map(f => ({ f, ...boxesOf(join(modelDir, f), colourOfGeoFor(f.replace(/\.geo\.json$/, ''))) })).sort((a, b) => b.cubes - a.cubes);
  const e = loaded[0]!;
  const packCubes = loaded.reduce((a, x) => a + x.cubes, 0);
  const bytesPerCube = e.cubeBytes / e.cubes;
  console.log(`\n══ ${basename(dir)} · ${e.f.replace(/\.geo\.json$/, '')} · ${e.cubes} cubes (pack ${packCubes}) · ${bytesPerCube.toFixed(1)} B/cube shipped`);
  const all = e.boxes.reduce((acc, b) => { for (let i = 0; i < 3; i++) { acc.min[i] = Math.min(acc.min[i]!, b.min[i]!); acc.max[i] = Math.max(acc.max[i]!, b.max[i]!); } return acc; },
    { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 });
  for (const blocks of [1, 2]) {
    const cell = UNITS_PER_BLOCK * blocks;
    const nx = Math.ceil((all.max[0]! - all.min[0]!) / cell) + 1, ny = Math.ceil((all.max[1]! - all.min[1]!) / cell) + 1, nz = Math.ceil((all.max[2]! - all.min[2]!) / cell) + 1;
    const at = (x: number, y: number, z: number): number => (x * ny + y) * nz + z;
    const solid = new Uint8Array(nx * ny * nz);
    for (const b of e.boxes) {
      const x0 = Math.max(0, Math.floor((b.min[0]! - all.min[0]!) / cell)), x1 = Math.min(nx - 1, Math.floor((b.max[0]! - all.min[0]!) / cell));
      const y0 = Math.max(0, Math.floor((b.min[1]! - all.min[1]!) / cell)), y1 = Math.min(ny - 1, Math.floor((b.max[1]! - all.min[1]!) / cell));
      const z0 = Math.max(0, Math.floor((b.min[2]! - all.min[2]!) / cell)), z1 = Math.min(nz - 1, Math.floor((b.max[2]! - all.min[2]!) / cell));
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) solid[at(x, y, z)] = 1;
    }
    let filled = 0;
    for (const v of solid) if (v) filled++;
    const surface = new Uint8Array(solid.length);
    let nSurface = 0;
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      if (!solid[at(x, y, z)]) continue;
      const open = x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1
        || !solid[at(x - 1, y, z)] || !solid[at(x + 1, y, z)] || !solid[at(x, y - 1, z)] || !solid[at(x, y + 1, z)] || !solid[at(x, y, z - 1)] || !solid[at(x, y, z + 1)];
      if (open) { surface[at(x, y, z)] = 1; nSurface++; }
    }
    const merged = greedyBoxes(surface, nx, ny, nz);
    const solidMerged = greedyBoxes(solid, nx, ny, nz);
    console.log(`  ${blocks}-block cell (${cell} units): grid ${nx}x${ny}x${nz}; solid voxels ${filled}; surface ${nSurface}`
      + ` -> greedy cuboids: hull ${merged}, full solid ${solidMerged}`);
    console.log(`     hull is ${(merged / e.cubes * 100).toFixed(1)} % of the entity's ${e.cubes} cuboids; +${(merged * bytesPerCube / 1024).toFixed(0)} kB of cube JSON`);
    // Per-colour hull: box UV means one geometry carries one colour, so a hull
    // that keeps the model's colours is one hull PER colour.
    const byColour = new Map<string, Box[]>();
    e.boxes.forEach((b, i) => { const c = e.colours[i]!; const l = byColour.get(c); if (l) l.push(b); else byColour.set(c, [b]); });
    let perColour = 0;
    for (const list of byColour.values()) {
      const s2 = new Uint8Array(nx * ny * nz);
      for (const b of list) {
        const x0 = Math.max(0, Math.floor((b.min[0]! - all.min[0]!) / cell)), x1 = Math.min(nx - 1, Math.floor((b.max[0]! - all.min[0]!) / cell));
        const y0 = Math.max(0, Math.floor((b.min[1]! - all.min[1]!) / cell)), y1 = Math.min(ny - 1, Math.floor((b.max[1]! - all.min[1]!) / cell));
        const z0 = Math.max(0, Math.floor((b.min[2]! - all.min[2]!) / cell)), z1 = Math.min(nz - 1, Math.floor((b.max[2]! - all.min[2]!) / cell));
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) s2[at(x, y, z)] = 1;
      }
      // keep only the cells of this colour that are on the WHOLE model's surface
      for (let i = 0; i < s2.length; i++) if (s2[i] && !surface[i]) s2[i] = 0;
      perColour += greedyBoxes(s2, nx, ny, nz);
    }
    console.log(`     per-COLOUR hull (box UV keeps one colour per geometry): ${perColour} cuboids over ${byColour.size} colours = ${(perColour / e.cubes * 100).toFixed(1)} % of the entity`);
  }
}
