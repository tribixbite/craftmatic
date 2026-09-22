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
 * textures. (The table above predates exclusive cell ownership, below, which
 * removes the duplicate cubes those counts included: 10303's hull went from
 * 1,143 to 753 cuboids, 2026-09-21.)
 *
 * EVERY SKIN CELL BELONGS TO EXACTLY ONE COLOUR. A block cell is 53 LDU at
 * minifig scale and a brick is 20 LDU wide, so most cells hold cubes of several
 * colours. The first version let every colour that touched a skin cell emit its
 * own full-cell cube there, so up to nine coplanar cubes sat on one cell (10303,
 * 2026-09-21: 1,523 of the 3,189 skin cells were claimed by two to nine colour
 * geometries). Coplanar faces of different colours are resolved by the depth
 * test, which on the phone's GPU reads as diagonal hatching that flickers
 * between the colours as the camera moves — the user's "seizure-inducing"
 * report. The cell now goes to the one colour with the most cube volume inside
 * it (`claimVolumes`); a tie keeps the earlier colour in draw order.
 *
 * The hull is computed from the entity's FINAL emitted cube list (after the
 * cull, the merge and the studs), i.e. from the geometry document itself, so it
 * can never disagree with what ships: every cube is reduced to its world AABB
 * (bone-chain and per-cube rotations applied), voxelised on the block cell,
 * reduced to SURFACE voxels only (a voxel with an empty 6-neighbour) and
 * greedy-merged into axis-aligned cuboids.
 *
 * The same cube list gives the entity's REACH from its root (`radiusBlocks`):
 * `query.distance_from_camera` measures the camera to the entity's root, not to
 * its nearest cube, and a shell's root sits above the model
 * (`originAboveModel` in `ldraw-entity-compiler.ts`). On 10303 the root is 45
 * blocks over the ground and 68.7 % of the model's own skin is farther than 32
 * blocks from it, so a switch at a bare 32 put the hull in front of a camera
 * standing at the tracks. The switch has to be `lodDistance + radiusBlocks`.
 *
 * THE HULL IS THE SAME ACTOR AS THE MODEL, SO IT CULLS WHEN THE MODEL CULLS.
 * Bedrock stops drawing an actor at a camera distance that follows its
 * `minecraft:collision_box`, not its geometry or `visible_bounds_*`
 * (`entityRenderCullBlocks`). A shell's box is 0.1 x 0.1 and it culls ~64
 * blocks from its root: 10303 (round921, 2026-09-21) was drawn whole at the
 * 60-block stop and absent at 70, 86, 100 and 168, while its 0.6 x 1.8 figures
 * were still drawn at 100. The switch this morning was 146.3 (96 + 50.3 reach),
 * so its 760 hull cuboids were resident and never drawn once. `planLodSwitch`
 * now derives the switch from the cull and drops the hull when the actor culls
 * before the hull could be anything but a blob in plain sight.
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

export type Vec3 = [number, number, number];

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
  /**
   * World AABB of the entity's cubes in BLOCKS, relative to the entity root
   * (rotations applied) — the point `query.distance_from_camera` measures from.
   */
  extentBlocks: { min: Vec3; max: Vec3 };
  /**
   * Farthest corner of `extentBlocks` from the root, in blocks. A render
   * controller that switches at a bare distance D shows the hull to a camera
   * standing at any cube more than D from the root; switching at
   * `D + radiusBlocks` guarantees the camera is at least D from EVERY cube.
   */
  radiusBlocks: number;
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
 * The inclusive cell range a box touches. The span is treated as HALF-OPEN: a
 * cube whose max face lies exactly on a cell boundary (every unrotated LEGO
 * cuboid on a block-aligned grid) must not claim the cell beyond it, or a 1x1x1
 * block would rasterise as 2x2x2 and one colour's hull would paint over its
 * neighbour's. Shared by the solid mask and the ownership volumes so the two
 * can never disagree about which cells a cube is in.
 */
function cellRange(grid: VoxelGrid, b: Aabb): CellBox {
  const clamp = (i: number, n: number): number => Math.min(n - 1, Math.max(0, i));
  const lo = (v: number, axis: number, n: number): number => clamp(Math.floor((v - grid.origin[axis]!) / grid.cell), n);
  const hi = (v: number, axis: number, n: number, low: number): number => Math.max(low, clamp(Math.ceil((v - grid.origin[axis]!) / grid.cell) - 1, n));
  const x0 = lo(b.min[0], 0, grid.nx), x1 = hi(b.max[0], 0, grid.nx, x0);
  const y0 = lo(b.min[1], 1, grid.ny), y1 = hi(b.max[1], 1, grid.ny, y0);
  const z0 = lo(b.min[2], 2, grid.nz), z1 = hi(b.max[2], 2, grid.nz, z0);
  return { x0, y0, z0, x1, y1, z1 };
}

/** Mark every cell a box touches (see `cellRange` for the half-open rule). */
function rasterise(grid: VoxelGrid, boxes: Aabb[], into: Uint8Array): void {
  for (const b of boxes) {
    const { x0, y0, z0, x1, y1, z1 } = cellRange(grid, b);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) into[grid.at(x, y, z)] = 1;
  }
}

/**
 * A degenerate cube (zero size on an axis) still occupies the cells `cellRange`
 * gives it but has no volume; it claims this much so a cell nothing else
 * touches is not left unowned. Far below any real cube's volume (the smallest
 * compiler microcell is 4 LDU ≈ 1.2 units on a side, ~1.7 units³).
 */
const DEGENERATE_CLAIM = 1e-9;

/**
 * Accumulate, per cell, the volume (in model units³) the given boxes put inside
 * it — the clipped intersection of each box with each cell it touches. This is
 * the basis of exclusive cell ownership: the colour with the most volume in a
 * skin cell is the one a viewer would see there.
 */
function claimVolumes(grid: VoxelGrid, boxes: Aabb[], into: Float32Array): void {
  const { origin, cell } = grid;
  for (const b of boxes) {
    const { x0, y0, z0, x1, y1, z1 } = cellRange(grid, b);
    const span = (axis: number, i: number): number => {
      const lo = origin[axis]! + i * cell, hi = lo + cell;
      return Math.max(0, Math.min(b.max[axis]!, hi) - Math.max(b.min[axis]!, lo));
    };
    for (let x = x0; x <= x1; x++) {
      const sx = span(0, x);
      for (let y = y0; y <= y1; y++) {
        const sy = span(1, y);
        for (let z = z0; z <= z1; z++) into[grid.at(x, y, z)] += Math.max(DEGENERATE_CLAIM, sx * sy * span(2, z));
      }
    }
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

  // EXCLUSIVE ownership of every skin cell (see the module comment): the colour
  // with the most cube volume inside the cell takes it, a tie keeps the earlier
  // colour in draw order (colours are visited in that order and only a STRICTLY
  // larger volume displaces the holder). Without this, every colour touching a
  // cell emitted a full-cell cube on it and the coplanar faces z-fought.
  const colours = [...byColour.entries()].sort((a, b) => a[1].order - b[1].order);
  const owner = new Int32Array(solid.length).fill(-1);
  const best = new Float32Array(solid.length);
  const volume = new Float32Array(solid.length);
  colours.forEach(([colorId], ci) => {
    volume.fill(0);
    claimVolumes(grid, boxes.filter(b => b.colorId === colorId), volume);
    for (let i = 0; i < volume.length; i++) {
      if (!surface[i] || !volume[i]) continue;
      if (owner[i] < 0 || volume[i]! > best[i]!) { owner[i] = ci; best[i] = volume[i]!; }
    }
  });

  // Reach from the root, for the render controllers' switch distance.
  const extentMin: Vec3 = [Infinity, Infinity, Infinity], extentMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let i = 0; i < 3; i++) { if (b.min[i]! < extentMin[i]!) extentMin[i] = b.min[i]!; if (b.max[i]! > extentMax[i]!) extentMax[i] = b.max[i]!; }
  let radius = 0;
  for (const x of [extentMin[0], extentMax[0]]) for (const y of [extentMin[1], extentMax[1]]) for (const z of [extentMin[2], extentMax[2]])
    radius = Math.max(radius, Math.hypot(x, y, z));
  const toBlocks = (v: Vec3): Vec3 => [v[0] / UNITS_PER_BLOCK, v[1] / UNITS_PER_BLOCK, v[2] / UNITS_PER_BLOCK];

  const geometries: GeoMesh[] = [];
  const meshes: LodHullMesh[] = [];
  const template = doc['minecraft:geometry'][0]?.description;
  let cuboids = 0;
  colours.forEach(([, info], ci) => {
    // `owner` is only ever set on skin cells, so this mask is already the colour's share of the skin.
    const mask = new Uint8Array(solid.length);
    for (let i = 0; i < owner.length; i++) if (owner[i] === ci) mask[i] = 1;
    const cells = greedyBoxes(grid, mask);
    if (!cells.length) return;
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
  });
  if (!meshes.length) return null;
  return {
    value: { format_version: '1.12.0', 'minecraft:geometry': geometries }, meshes, cuboids,
    colours: new Set(meshes.map(m => m.material.colorId)).size, cellBlocks,
    extentBlocks: { min: toBlocks(extentMin), max: toBlocks(extentMax) },
    radiusBlocks: radius / UNITS_PER_BLOCK,
  };
}

// ─── Where the actor stops drawing, and the switch that fits under it ────────

/** `minecraft:collision_box` as a behaviour file declares it (blocks). */
export interface CollisionBox { width: number; height: number }

/**
 * Blocks of camera distance the Bedrock client keeps drawing an actor, per unit
 * of its collision-box diagonal. Java's `Entity.shouldRenderAtSqrDistance`
 * draws to 64 x the bounding-box diagonal; Bedrock's counterpart is
 * undocumented, and this constant is what three Pixel 8 Pro observations
 * (Bedrock 1.26.51) fit:
 *
 *   - 10303's shell, box 0.1 x 0.1, root 45 blocks above the track: drawn
 *     whole at the 60-block camera stop, absent at 70, 86, 100 and 168
 *     (`output/bedrock-entity-qa/round921/round921-53-d60.jpg` … `-49-far160`).
 *   - its figures, box 0.6 x 1.8 (diagonal 1.99 -> 127 blocks): drawn at 70,
 *     86 and 100, gone by 168 (`-50-d100.jpg`, `-49-far160.jpg`).
 *   - the Milano 76286, a vehicle with a metre-scale box: drawn at 92-128
 *     (`output/device-919/lod/LOD-RESULT.md`; the "128" there was the SHIP,
 *     the Hogwarts shell was only ever confirmed to 48).
 *
 * Neither the geometry's extent nor its `visible_bounds_*` enter into it:
 * 10303 declares a 177 x 189-block culling box and still vanished.
 */
export const RENDER_CULL_BLOCKS_PER_UNIT = 64;

/**
 * The diagonal below which the cull stops shrinking. A 0.1-block box has a
 * 0.17-block diagonal and would cull at 11 blocks under the bare rule; the
 * shell was drawn at 60, so the client clamps small actors to one unit
 * (64 blocks). Inferred, not documented; the lower end is what a device
 * round should walk out from a placed shell to pin down.
 */
export const RENDER_CULL_MIN_UNITS = 1;

/**
 * Camera-to-root distance past which the client stops drawing an actor with
 * this collision box at 100 %. The size groups scale the box with the model
 * (a 25 % shell has a 0.025 box), which changes nothing under the clamp for a
 * shell and shortens a vehicle's cull; the plan is made at 100 %.
 */
export function entityRenderCullBlocks(box: CollisionBox | undefined): number {
  const width = Math.max(0, box?.width ?? 0), height = Math.max(0, box?.height ?? 0);
  return RENDER_CULL_BLOCKS_PER_UNIT * Math.max(RENDER_CULL_MIN_UNITS, Math.hypot(width, height, width));
}

/**
 * Blocks of camera travel the hull must be on screen for before the actor
 * culls, or it never shows in practice: the 09-19 round measured the switch
 * landing 4-6 blocks before its nominal value (26-28 for 32), and one chunk
 * of margin covers that with room for the camera sitting ahead of the player.
 */
export const LOD_CULL_MARGIN_BLOCKS = 16;

/**
 * The closest the camera may be to the model's nearest cube when the hull
 * takes over. The 09-19 round accepted the 1-block hull from 28 blocks
 * (silhouette and colours kept, brick texture gone); the point-blank blob the
 * user reported on 10303 was a switch that let the camera stand AT the
 * cubes. Below this the hull is degradation in plain sight, and shipping it
 * is worse than the pop the cull already causes.
 */
export const MIN_LOD_NEAREST_CUBE_BLOCKS = 32;

export interface LodSwitchInput {
  /** Camera-to-nearest-cube distance the pack asks for (`PlayableAddonOptions.lodDistance`). */
  lodDistance: number;
  /** The entity's reach from its root (`LodHull.radiusBlocks`). */
  radiusBlocks: number;
  /** The entity's `minecraft:collision_box` at 100 %; absent means the clamp (64 blocks). */
  collisionBox?: CollisionBox;
  /**
   * `lodDistance` was set by the operator (`--lod-distance`), so the switch is
   * honoured as asked — the device A/B ships packs that never or always hull
   * — and an unreachable switch is only reported. The derived rule applies to
   * the pipeline default.
   */
  explicit?: boolean;
}

export interface LodSwitchPlan {
  ship: true;
  /** Camera-to-ROOT distance the render controllers test. */
  switchDistance: number;
  /** `lodDistance + radiusBlocks`: the switch the option alone would give. */
  requestedSwitchDistance: number;
  /** Camera-to-root distance past which this actor is not drawn at all. */
  renderCullBlocks: number;
  /** Guaranteed camera-to-nearest-cube distance when the hull takes over (`switchDistance - radiusBlocks`). */
  nearestCubeBlocks: number;
  /** Blocks of camera travel between the switch and the cull; negative means the hull is never drawn. */
  hullWindowBlocks: number;
  /** Which bound set the switch. */
  switchSource: 'requested' | 'render-cull';
}

export interface LodSwitchSkip {
  ship: false;
  reason: string;
  requestedSwitchDistance: number;
  renderCullBlocks: number;
  /** What the switch would have had to be to sit under the cull, and how close to the cubes that puts the camera. */
  latestSwitchDistance: number;
  nearestCubeBlocks: number;
}

export type LodSwitchDecision = LodSwitchPlan | LodSwitchSkip;

const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The rule for one entity's switch, derived rather than set:
 *
 *   requested = lodDistance + radiusBlocks        (the camera is `lodDistance` from every cube)
 *   cull      = entityRenderCullBlocks(box)       (past this the actor is not drawn at all)
 *   latest    = cull - LOD_CULL_MARGIN_BLOCKS     (the hull must be seen for a chunk of travel)
 *   switch    = min(requested, latest)
 *   ship only if switch - radiusBlocks >= MIN_LOD_NEAREST_CUBE_BLOCKS
 *
 * 10303 (reach 50.3, box 0.1): requested 146.3, cull 64, latest 48, so the
 * camera would be 2.3 blocks INSIDE the model's reach at the switch — the hull
 * is dropped and its 760 cuboids are not shipped. A vehicle with a 3.5 x 2.5
 * box culls at 358, so its requested switch stands.
 */
export function planLodSwitch(input: LodSwitchInput): LodSwitchDecision {
  const requestedSwitchDistance = round1(input.lodDistance + input.radiusBlocks);
  const renderCullBlocks = round1(entityRenderCullBlocks(input.collisionBox));
  const latestSwitchDistance = round1(renderCullBlocks - LOD_CULL_MARGIN_BLOCKS);
  if (input.explicit) {
    // The operator's number, as asked; reachability is reported, not enforced.
    return {
      ship: true, switchDistance: requestedSwitchDistance, requestedSwitchDistance, renderCullBlocks,
      nearestCubeBlocks: round1(input.lodDistance), hullWindowBlocks: round1(renderCullBlocks - requestedSwitchDistance), switchSource: 'requested',
    };
  }
  const switchDistance = Math.min(requestedSwitchDistance, latestSwitchDistance);
  const nearestCubeBlocks = round1(switchDistance - input.radiusBlocks);
  if (nearestCubeBlocks < MIN_LOD_NEAREST_CUBE_BLOCKS) {
    return {
      ship: false, requestedSwitchDistance, renderCullBlocks, latestSwitchDistance, nearestCubeBlocks,
      reason: `the actor is not drawn past ${renderCullBlocks} blocks from its root (collision box ${input.collisionBox ? `${input.collisionBox.width} x ${input.collisionBox.height}` : 'absent'}), so the hull could only take over by ${latestSwitchDistance}; with a reach of ${round1(input.radiusBlocks)} that puts the camera ${nearestCubeBlocks} blocks from the nearest cube, under the ${MIN_LOD_NEAREST_CUBE_BLOCKS} at which the 1-block hull is acceptable`,
    };
  }
  return {
    ship: true, switchDistance, requestedSwitchDistance, renderCullBlocks, nearestCubeBlocks,
    hullWindowBlocks: round1(renderCullBlocks - switchDistance),
    switchSource: switchDistance < requestedSwitchDistance ? 'render-cull' : 'requested',
  };
}
