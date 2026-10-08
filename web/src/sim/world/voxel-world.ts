/**
 * The voxel world of one dimension: a sparse chunked block store over a
 * terrain generator, the loaded area, and the collision query the physics
 * runs against.
 *
 * STORAGE. 16³ sections, each a `Uint32Array` of palette ids, created on the
 * first write from the generator (a flat world by default: bedrock, dirt and
 * grass under `groundY`, the phones' QA worlds' superflat). Permutations are
 * interned once (`BlockPalette`), so a block read is two lookups.
 *
 * LOADED AREA (quirk `unloaded-block-undefined`, `simulation-distance`). A
 * chunk column is loaded when it lies within the simulation distance of a
 * player or inside a ticking area. `getBlock` of an unloaded block returns
 * undefined, never air; the physics treats an unloaded block as solid (a body
 * never walks into the void the device would not let it reach).
 */

import type { Box } from '../core/vec.js';
import { quirkValue } from '../quirks/registry.js';
import { permutationKey, type BlockStates, type BlockShape, type BlockTypes } from './block-types.js';
import { submersion } from './liquids.js';
import { WriteLog } from './write-log.js';

/** An interned permutation. */
export interface Permutation { readonly id: number; readonly typeId: string; readonly states: Readonly<BlockStates> }

/** Interns permutations: one id per (type, states). Id 0 is air. */
export class BlockPalette {
  private readonly byKey = new Map<string, Permutation>();
  private readonly byId: Permutation[] = [];
  constructor() { this.intern('minecraft:air', {}); }
  intern(typeId: string, states: BlockStates): Permutation {
    const key = permutationKey(typeId, states);
    let p = this.byKey.get(key);
    if (!p) { p = { id: this.byId.length, typeId, states: { ...states } }; this.byId.push(p); this.byKey.set(key, p); }
    return p;
  }
  get(id: number): Permutation { return this.byId[id]!; }
}

/**
 * What fills fresh terrain: the block at a position. `verticalOnly` generators depend on y alone and are
 * cached per height. `materialiseOnRead` generators (a position-dependent world read from another model -
 * the walk worlds' re-laid collider grid) fill a whole section on its FIRST READ and are never asked about
 * that section again, so a block read is two lookups however costly the generator is.
 */
export type TerrainGenerator = ((x: number, y: number, z: number) => { typeId: string; states?: BlockStates }) & { verticalOnly?: boolean; materialiseOnRead?: boolean };

/** The phones' QA worlds: superflat, bedrock at -64, dirt -63..-62, grass -61, standing height -60. */
export const FLAT_GROUND_Y = -60;
export const flatTerrain = (groundY = FLAT_GROUND_Y): TerrainGenerator => Object.assign((_x: number, y: number) => {
  if (y >= groundY) return { typeId: 'minecraft:air' };
  if (y === groundY - 1) return { typeId: 'minecraft:grass_block' };
  if (y <= -64) return { typeId: 'minecraft:bedrock' };
  return { typeId: 'minecraft:dirt' };
}, { verticalOnly: true });

/** A solid box the physics collides with, with the block it belongs to. */
export interface WorldSolid extends Box {
  /** The world block, or undefined for an unloaded column's stand-in wall. */
  block?: { x: number; y: number; z: number; typeId: string };
  /** An unloaded block (treated as solid). */
  unloaded?: boolean;
  /** The id of the ENTITY this box is (a `minecraft:is_collidable` mob, physics/body-systems.ts), not a block. */
  entity?: string;
}

/** One dimension's blocks. */
export class VoxelWorld {
  readonly heightRange: { min: number; max: number };
  /** Sections by `sectionKey` (a number: a string key per block read was the walk harness's hot spot). */
  private readonly sections = new Map<number, Uint32Array>();
  /** Shapes by permutation id (`BlockTypes.shape` builds a string key per call). */
  private readonly shapeById: Array<BlockShape | undefined> = [];
  private readonly generatorCache = new Map<number, number>();
  /** Loaded chunk columns, `cx,cz`. Recomputed by the engine each tick. */
  private loaded = new Set<string>();
  /** Every column loaded (`setAllLoaded`). */
  private allLoaded = false;
  /** Every block ever written (undo checks, the test hosts), one bit per block (world/write-log.ts). */
  readonly writes = new WriteLog();
  /** Called after every write (a recorder, a test host). */
  onWrite: ((x: number, y: number, z: number, p: Permutation) => void) | undefined;
  /** Solid boxes that are ENTITIES near a region (collidable mobs; physics/body-systems.ts installs it), joined to `solidsNear`. */
  entitySolids: ((region: Box) => WorldSolid[]) | undefined;

  constructor(readonly id: string, readonly palette: BlockPalette, readonly types: BlockTypes, private readonly generator: TerrainGenerator = flatTerrain(), heightRange = { min: -64, max: 320 }) {
    this.heightRange = heightRange;
  }

  /** Mark the loaded chunk columns (the engine calls this each tick from players and ticking areas). */
  setLoaded(columns: Set<string>): void { this.loaded = columns; this.allLoaded = false; }
  /**
   * Load every column, for good: a world with no players and no loading rule
   * (the walk preview's and the doorway harness's collider world, which a
   * walk may leave in any direction). An engine never calls this.
   */
  setAllLoaded(): void { this.allLoaded = true; }
  /** Whether the block's chunk column is loaded. */
  isLoaded(x: number, z: number): boolean { return this.allLoaded || this.loaded.has(`${Math.floor(x) >> 4},${Math.floor(z) >> 4}`); }
  /** The loaded chunk columns. */
  loadedColumns(): ReadonlySet<string> { return this.loaded; }

  private generated(x: number, y: number, z: number): number {
    const g = this.generator(x, y, z);
    return this.palette.intern(g.typeId, g.states ?? {}).id;
  }

  private section(x: number, y: number, z: number, create: boolean): Uint32Array | undefined {
    const key = sectionKey(x >> 4, y >> 4, z >> 4);
    let s = this.sections.get(key);
    if (!s && create) {
      s = new Uint32Array(4096);
      const bx = (x >> 4) << 4, by = (y >> 4) << 4, bz = (z >> 4) << 4;
      for (let dx = 0; dx < 16; dx++) for (let dy = 0; dy < 16; dy++) for (let dz = 0; dz < 16; dz++) s[(dx * 16 + dy) * 16 + dz] = this.generated(bx + dx, by + dy, bz + dz);
      this.sections.set(key, s);
    }
    return s;
  }

  /** The permutation id at a block, loaded or not (the engine's own view; the API applies the loaded check). */
  rawId(x: number, y: number, z: number): number {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < this.heightRange.min || y >= this.heightRange.max) return 0;
    const s = this.section(x, y, z, this.generator.materialiseOnRead === true);
    if (s) return s[((x & 15) * 16 + (y & 15)) * 16 + (z & 15)]!;
    if (!this.generator.verticalOnly) return this.generated(x, y, z);
    let id = this.generatorCache.get(y);
    if (id === undefined) this.generatorCache.set(y, id = this.generated(x, y, z));
    return id;
  }

  /** The permutation at a block. */
  permutationAt(x: number, y: number, z: number): Permutation { return this.palette.get(this.rawId(x, y, z)); }

  /** Write a permutation (the engine does not check loading here; the script API does). */
  setPermutation(x: number, y: number, z: number, p: Permutation): void {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    if (y < this.heightRange.min || y >= this.heightRange.max) return;
    const s = this.section(x, y, z, true)!;
    s[((x & 15) * 16 + (y & 15)) * 16 + (z & 15)] = p.id;
    this.writes.add(x, y, z);
    this.onWrite?.(x, y, z, p);
  }

  /** The shape of a permutation id (memoised per id). */
  shapeOf(id: number): BlockShape {
    let s = this.shapeById[id];
    if (!s) { const p = this.palette.get(id); this.shapeById[id] = s = this.types.shape(p.typeId, p.states); }
    return s;
  }

  /** The shape of the block at a position. */
  shapeAt(x: number, y: number, z: number): BlockShape { return this.shapeOf(this.rawId(x, y, z)); }

  /**
   * The solid boxes a box moving by `(dx, dy, dz)` could meet (the physics'
   * `SolidQuery`). An unloaded column is one solid wall.
   */
  solidsNear(box: Box, dx: number, dy: number, dz: number): WorldSolid[] {
    const e = 1e-7;
    const x0 = Math.floor(Math.min(box.x0, box.x0 + dx) - e), x1 = Math.floor(Math.max(box.x1, box.x1 + dx) + e);
    const y0 = Math.floor(Math.min(box.y0, box.y0 + dy) - e) - 1, y1 = Math.floor(Math.max(box.y1, box.y1 + dy) + e);
    const z0 = Math.floor(Math.min(box.z0, box.z0 + dz) - e), z1 = Math.floor(Math.max(box.z1, box.z1 + dz) + e);
    const out: WorldSolid[] = [];
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (!this.isLoaded(x, z)) { out.push({ x0: x, y0: y0, z0: z, x1: x + 1, y1: y1 + 1, z1: z + 1, unloaded: true }); continue; }
      for (let y = y0; y <= y1; y++) {
        const id = this.rawId(x, y, z);
        if (id === 0) continue;
        const shape = this.shapeOf(id);
        if (!shape.collision.length) continue;
        const typeId = this.palette.get(id).typeId;
        for (const b of shape.collision) out.push({ x0: x + b.x0, y0: y + b.y0, z0: z + b.z0, x1: x + b.x1, y1: y + b.y1, z1: z + b.z1, block: { x, y, z, typeId } });
      }
    }
    if (this.entitySolids) out.push(...this.entitySolids({ x0, y0, z0, x1: x1 + 1, y1: y1 + 1, z1: z1 + 1 }));
    return out;
  }

  /** How much of a box's height is under a liquid surface, 0..1 (world/liquids.ts; the physics' water test). */
  submersion(box: Box): number { return submersion(this, box); }

  /** Whether a box overlaps any solid (the "player inside a wall" test). Returns the first solid it overlaps. */
  overlapping(box: Box, eps = 1e-3): WorldSolid | undefined {
    for (const s of this.solidsNear(box, 0, 0, 0)) {
      if (s.unloaded) continue;
      if (box.x1 > s.x0 + eps && box.x0 < s.x1 - eps && box.y1 > s.y0 + eps && box.y0 < s.y1 - eps && box.z1 > s.z0 + eps && box.z0 < s.z1 - eps) return s;
    }
    return undefined;
  }

  /** The highest collision top at or below `y` under the point (x, z), or -Infinity: where a body dropped there lands. */
  supportBelow(x: number, y: number, z: number, maxDepth = 400): number {
    for (let by = Math.floor(y); by >= Math.max(this.heightRange.min, Math.floor(y) - maxDepth); by--) {
      const id = this.rawId(x, by, z);
      if (id === 0) continue;
      const shape = this.shapeOf(id);
      let top = -Infinity;
      const fx = x - Math.floor(x), fz = z - Math.floor(z);
      for (const b of shape.collision) if (fx >= b.x0 && fx <= b.x1 && fz >= b.z0 && fz <= b.z1 && by + b.y1 <= y + 1e-6) top = Math.max(top, by + b.y1);
      if (top > -Infinity) return top;
    }
    return -Infinity;
  }
}

/**
 * A section's map key from its section coordinates, as one number: x and z
 * sections within ±2^21 (±33 M blocks, past the world border) and y sections
 * within ±32 (±512 blocks), packed into 49 bits.
 */
function sectionKey(sx: number, sy: number, sz: number): number {
  return ((sx + 2097152) * 64 + (sy + 32)) * 4194304 + (sz + 2097152);
}

/** The chunk columns within `radius` chunks of a point. */
export function columnsAround(x: number, z: number, radius = quirkValue('simulation-distance', 'chunks')): string[] {
  const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4, out: string[] = [];
  for (let i = -radius; i <= radius; i++) for (let j = -radius; j <= radius; j++) out.push(`${cx + i},${cz + j}`);
  return out;
}
