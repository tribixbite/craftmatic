/**
 * Distance LOD for brick-compiled Bedrock entities: a coarse HULL geometry the
 * client draws in place of the full model once the camera is far away.
 *
 * Why a hull and not fewer cuboids: add-on memory is DEFINITION-side
 * (`DEVICE_CUBOID_BUDGET` in `playable-addon.ts` — native heap = 739 MB +
 * ~3.08 kB per cuboid, measured on a Pixel 8 Pro), so both geometries stay
 * resident whatever the camera does and a hull BUYS NOTHING in memory. What it
 * can buy is draw/vertex work at distance, where a 48,000-cuboid castle is a
 * handful of pixels. That is why the option is opt-in and off by default: the
 * cuboid cost is real and the frame-time win is not yet measured on a device.
 *
 * Measured cost of the hull this module builds, over the three golden packs at
 * a 1-block cell (`scripts/_probe-hull-lod.ts`, 2026-09-19):
 *
 *   | pack             | entity cuboids | per-colour hull | single-colour hull |
 *   |------------------|----------------|-----------------|--------------------|
 *   | 71043 ultra      | 48,093         | 1,946 (4.0 %)   | 573                |
 *   | 76286 ultra      | 18,501         |   456 (2.5 %)   | 185                |
 *   | 76435 balanced   |  9,011         |   710 (7.9 %)   | 215                |
 *
 * PER-COLOUR is the default: a single-colour hull is three times cheaper but
 * renders the model as one flat blob at distance, which is a visible regression
 * rather than an LOD. Box UV means a geometry carries exactly ONE colour
 * (`ldraw-entity-compiler.ts`), so "keep the colours" means one hull geometry
 * per colour, each bound to that colour's existing 16x16 swatch — no new
 * textures.
 *
 * The hull is computed from the entity's FINAL emitted cube list (after the
 * cull, the merge and the studs), i.e. from the geometry document itself, so it
 * can never disagree with what ships: every cube is reduced to its world AABB
 * (bone-chain and per-cube rotations applied), voxelised on the block cell,
 * reduced to SURFACE voxels only (a voxel with an empty 6-neighbour) and
 * greedy-merged into axis-aligned cuboids.
 */

import type { CompiledMesh } from './ldraw-entity-compiler.js';
import type { LdrawEntityMaterial } from './ldraw-entity-materials.js';

/** Model units in one block, the unit a geometry cube's origin/size is in. */
export const UNITS_PER_BLOCK = 16;

/** Default hull cell: one block. Coarser reads as a blob; finer costs cuboids for detail nobody sees at `lodDistance`. */
export const DEFAULT_HULL_CELL_BLOCKS = 1;

/** The shared do-nothing geometry a render controller selects when its own geometry must not draw. */
export const LOD_EMPTY_GEOMETRY_ID = 'geometry.craftmatic.lod_empty';

/**
 * One bone, no cubes. Bedrock accepts a bone without a `cubes` array (the
 * compiler already relies on empty bones for a rig's parent chain), so this
 * needs no zero-size cube. Declared once per pack and bound in every client
 * entity that ships an LOD.
 */
export const LOD_EMPTY_GEOMETRY = {
  format_version: '1.12.0',
  'minecraft:geometry': [{
    description: { identifier: LOD_EMPTY_GEOMETRY_ID, texture_width: 16, texture_height: 16, visible_bounds_width: 0, visible_bounds_height: 0, visible_bounds_offset: [0, 0, 0] },
    bones: [{ name: 'empty', pivot: [0, 0, 0] }],
  }],
} as const;

type Vec3 = [number, number, number];

/** A cube as a geometry document carries it. */
interface GeoCube { origin: number[]; size: number[]; rotation?: number[]; pivot?: number[] }
interface GeoBone { name: string; parent?: string; pivot: number[]; rotation?: number[]; cubes?: GeoCube[] }
interface GeoMesh { description: { identifier: string; texture_width?: number; texture_height?: number; visible_bounds_width?: number; visible_bounds_height?: number; visible_bounds_offset?: number[] }; bones: GeoBone[] }
interface GeoDocument { format_version: string; 'minecraft:geometry': GeoMesh[] }

/** What the hull needs from a compiled entity: its geometry document and the colour of each geometry in it. */
export interface LodHullInput {
  /** `CompiledLdrawGeometry.value` — the geometry document as emitted. */
  value: unknown;
  /** `CompiledLdrawGeometry.meshes` — geometry id → the one LDraw colour it carries. */
  meshes: readonly CompiledMesh[];
}

export interface LodHullMesh {
  id: string;
  material: LdrawEntityMaterial;
  translucent: boolean;
  /** Cuboids in this hull geometry. */
  cuboids: number;
}

export interface LodHull {
  /** The hull geometry document, to ship beside the full-detail one. */
  value: GeoDocument;
  /** One geometry per colour that has any surface voxel, in the source's draw order (translucent last). */
  meshes: LodHullMesh[];
  /** Hull cuboids in total. These are RESIDENT and count against the pack's cuboid budget. */
  cuboids: number;
  /** Distinct colours the hull kept. */
  colours: number;
  /** The cell the hull was voxelised on, in blocks. */
  cellBlocks: number;
}

export interface BuildLodHullOptions {
  /** Voxel cell in blocks (default `DEFAULT_HULL_CELL_BLOCKS`). */
  cellBlocks?: number;
  /** Cubes per emitted hull geometry, matching the compiler's chunking (default 1024). */
  chunkCubes?: number;
}

const DEG = Math.PI / 180;

/** Rotate a point by an XYZ Euler triple in degrees, the order a Bedrock geometry applies. */
function rotate(p: Vec3, r: readonly number[]): Vec3 {
  const rx = (r[0] ?? 0) * DEG, ry = (r[1] ?? 0) * DEG, rz = (r[2] ?? 0) * DEG;
  let [x, y, z] = p;
  let t = y * Math.cos(rx) - z * Math.sin(rx); z = y * Math.sin(rx) + z * Math.cos(rx); y = t;
  t = x * Math.cos(ry) + z * Math.sin(ry); z = -x * Math.sin(ry) + z * Math.cos(ry); x = t;
  t = x * Math.cos(rz) - y * Math.sin(rz); y = x * Math.sin(rz) + y * Math.cos(rz); x = t;
  return [x, y, z];
}

interface Aabb { min: Vec3; max: Vec3 }

/**
 * Every cube of a geometry document as a world-space AABB, tagged with the
 * colour id of the geometry it came from. A rotated cube or a cube under a
 * rotated bone contributes the AABB of its eight rotated corners, which is the
 * right call for a coarse silhouette.
 */
function cubeBoxes(doc: GeoDocument, colourOf: Map<string, number>): Array<Aabb & { colorId: number }> {
  const out: Array<Aabb & { colorId: number }> = [];
  for (const mesh of doc['minecraft:geometry']) {
    const colorId = colourOf.get(mesh.description.identifier);
    if (colorId === undefined) continue; // a geometry with no declared colour cannot be hulled per colour
    const rotationOf = new Map<string, number[] | undefined>(), pivotOf = new Map<string, number[]>(), parentOf = new Map<string, string | undefined>();
    for (const bone of mesh.bones) { rotationOf.set(bone.name, bone.rotation); pivotOf.set(bone.name, bone.pivot); parentOf.set(bone.name, bone.parent); }
    for (const bone of mesh.bones) for (const cube of bone.cubes ?? []) {
      let points: Vec3[] = [];
      for (const x of [cube.origin[0]!, cube.origin[0]! + cube.size[0]!])
        for (const y of [cube.origin[1]!, cube.origin[1]! + cube.size[1]!])
          for (const z of [cube.origin[2]!, cube.origin[2]! + cube.size[2]!]) points.push([x, y, z]);
      const spin = (r: readonly number[] | undefined, pivot: readonly number[] | undefined): void => {
        if (!r || !pivot) return;
        points = points.map(q => {
          const v = rotate([q[0] - pivot[0]!, q[1] - pivot[1]!, q[2] - pivot[2]!], r);
          return [v[0] + pivot[0]!, v[1] + pivot[1]!, v[2] + pivot[2]!] as Vec3;
        });
      };
      spin(cube.rotation, cube.pivot);
      for (let name: string | undefined = bone.name; name; name = parentOf.get(name)) spin(rotationOf.get(name), pivotOf.get(name));
      const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const q of points) for (let i = 0; i < 3; i++) { if (q[i]! < min[i]!) min[i] = q[i]!; if (q[i]! > max[i]!) max[i] = q[i]!; }
      out.push({ min, max, colorId });
    }
  }
  return out;
}

/** Grid geometry shared by the whole-model mask and each colour's mask. */
interface VoxelGrid { nx: number; ny: number; nz: number; origin: Vec3; cell: number; at: (x: number, y: number, z: number) => number }

function voxelGrid(boxes: Aabb[], cell: number): VoxelGrid {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let i = 0; i < 3; i++) { if (b.min[i]! < min[i]!) min[i] = b.min[i]!; if (b.max[i]! > max[i]!) max[i] = b.max[i]!; }
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1, ny = Math.ceil((max[1] - min[1]) / cell) + 1, nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  return { nx, ny, nz, origin: min, cell, at: (x, y, z) => (x * ny + y) * nz + z };
}

/**
 * Mark every cell a box touches. The span is treated as HALF-OPEN: a cube whose
 * max face lies exactly on a cell boundary (every unrotated LEGO cuboid on a
 * block-aligned grid) must not claim the cell beyond it, or a 1x1x1 block would
 * rasterise as 2x2x2 and one colour's hull would paint over its neighbour's.
 */
function rasterise(grid: VoxelGrid, boxes: Aabb[], into: Uint8Array): void {
  for (const b of boxes) {
    const clamp = (i: number, n: number): number => Math.min(n - 1, Math.max(0, i));
    const lo = (v: number, axis: number, n: number): number => clamp(Math.floor((v - grid.origin[axis]!) / grid.cell), n);
    const hi = (v: number, axis: number, n: number, low: number): number => Math.max(low, clamp(Math.ceil((v - grid.origin[axis]!) / grid.cell) - 1, n));
    const x0 = lo(b.min[0], 0, grid.nx), x1 = hi(b.max[0], 0, grid.nx, x0);
    const y0 = lo(b.min[1], 1, grid.ny), y1 = hi(b.max[1], 1, grid.ny, y0);
    const z0 = lo(b.min[2], 2, grid.nz), z1 = hi(b.max[2], 2, grid.nz, z0);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) into[grid.at(x, y, z)] = 1;
  }
}

/** Solid cells with at least one empty (or out-of-grid) 6-neighbour: the model's skin. */
function surfaceMask(grid: VoxelGrid, solid: Uint8Array): Uint8Array {
  const { nx, ny, nz, at } = grid;
  const surface = new Uint8Array(solid.length);
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (!solid[at(x, y, z)]) continue;
    const open = x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1
      || !solid[at(x - 1, y, z)] || !solid[at(x + 1, y, z)] || !solid[at(x, y - 1, z)]
      || !solid[at(x, y + 1, z)] || !solid[at(x, y, z - 1)] || !solid[at(x, y, z + 1)];
    if (open) surface[at(x, y, z)] = 1;
  }
  return surface;
}

/** Cell-space box, inclusive of both ends. */
interface CellBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/**
 * Greedy 3-D merge over a mask: grow along x, then y, then z, first-fit in
 * (x, y, z) order. Deterministic, and every cell is covered exactly once.
 */
function greedyBoxes(grid: VoxelGrid, mask: Uint8Array): CellBox[] {
  const { nx, ny, nz, at } = grid;
  const used = new Uint8Array(mask.length);
  const boxes: CellBox[] = [];
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (!mask[at(x, y, z)] || used[at(x, y, z)]) continue;
    let ex = x;
    while (ex + 1 < nx && mask[at(ex + 1, y, z)] && !used[at(ex + 1, y, z)]) ex++;
    let ey = y;
    growY: while (ey + 1 < ny) {
      for (let xx = x; xx <= ex; xx++) if (!mask[at(xx, ey + 1, z)] || used[at(xx, ey + 1, z)]) break growY;
      ey++;
    }
    let ez = z;
    growZ: while (ez + 1 < nz) {
      for (let xx = x; xx <= ex; xx++) for (let yy = y; yy <= ey; yy++) if (!mask[at(xx, yy, ez + 1)] || used[at(xx, yy, ez + 1)]) break growZ;
      ez++;
    }
    for (let xx = x; xx <= ex; xx++) for (let yy = y; yy <= ey; yy++) for (let zz = z; zz <= ez; zz++) used[at(xx, yy, zz)] = 1;
    boxes.push({ x0: x, y0: y, z0: z, x1: ex, y1: ey, z1: ez });
  }
  return boxes;
}

/**
 * Build the per-colour hull of one compiled entity. Returns `null` when the
 * entity has no cubes at all (a placeholder geometry), in which case there is
 * nothing to switch to.
 *
 * `entityId` is the compiled entity id, so the hull geometry ids sit in the
 * same namespace as the full-detail ones (`geometry.craftmatic.<id>_lod_<n>`).
 */
export function buildLodHull(entityId: string, input: LodHullInput, options: BuildLodHullOptions = {}): LodHull | null {
  const doc = input.value as GeoDocument;
  if (!doc || !Array.isArray(doc['minecraft:geometry'])) return null;
  const cellBlocks = options.cellBlocks ?? DEFAULT_HULL_CELL_BLOCKS;
  const chunk = options.chunkCubes ?? 1024;
  const cell = cellBlocks * UNITS_PER_BLOCK;
  const colourOf = new Map<string, number>();
  /** Draw order and appearance per colour, taken from the source geometries (translucent colours come last there). */
  const byColour = new Map<number, { material: LdrawEntityMaterial; translucent: boolean; order: number }>();
  input.meshes.forEach((m, i) => {
    colourOf.set(m.id, m.material.colorId);
    if (!byColour.has(m.material.colorId)) byColour.set(m.material.colorId, { material: m.material, translucent: m.translucent, order: i });
  });
  const boxes = cubeBoxes(doc, colourOf);
  if (!boxes.length) return null;

  const grid = voxelGrid(boxes, cell);
  const solid = new Uint8Array(grid.nx * grid.ny * grid.nz);
  rasterise(grid, boxes, solid);
  // The skin is taken over the WHOLE model, then each colour keeps the skin
  // cells it occupies: a colour buried inside the model contributes nothing,
  // and no colour paints over a neighbour's outside face.
  const surface = surfaceMask(grid, solid);

  const geometries: GeoMesh[] = [];
  const meshes: LodHullMesh[] = [];
  const template = doc['minecraft:geometry'][0]?.description;
  let cuboids = 0;
  const colours = [...byColour.entries()].sort((a, b) => a[1].order - b[1].order);
  for (const [colorId, info] of colours) {
    const mask = new Uint8Array(solid.length);
    rasterise(grid, boxes.filter(b => b.colorId === colorId), mask);
    for (let i = 0; i < mask.length; i++) if (mask[i] && !surface[i]) mask[i] = 0;
    const cells = greedyBoxes(grid, mask);
    if (!cells.length) continue;
    const cubes: GeoCube[] = cells.map(b => ({
      origin: [grid.origin[0] + b.x0 * cell, grid.origin[1] + b.y0 * cell, grid.origin[2] + b.z0 * cell],
      size: [(b.x1 - b.x0 + 1) * cell, (b.y1 - b.y0 + 1) * cell, (b.z1 - b.z0 + 1) * cell],
      // Box UV into the colour's flat swatch, exactly as the full-detail cubes do.
      uv: [0, 0],
    }) as GeoCube & { uv: [number, number] });
    cuboids += cubes.length;
    for (let offset = 0; offset < cubes.length; offset += chunk) {
      const id = `geometry.craftmatic.${entityId}_lod_${meshes.length}`;
      meshes.push({ id, material: info.material, translucent: info.translucent, cuboids: Math.min(chunk, cubes.length - offset) });
      geometries.push({
        // The culling box is the full model's: the hull covers the same volume,
        // and a chunk of it can sit anywhere inside that volume.
        description: { ...(template ?? { texture_width: 16, texture_height: 16 }), identifier: id },
        bones: [{ name: 'body', pivot: [0, 0, 0], cubes: cubes.slice(offset, offset + chunk) }],
      });
    }
  }
  if (!meshes.length) return null;
  return { value: { format_version: '1.12.0', 'minecraft:geometry': geometries }, meshes, cuboids, colours: new Set(meshes.map(m => m.material.colorId)).size, cellBlocks };
}
