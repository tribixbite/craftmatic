/**
 * A LEGO BUILDING at the vehicle pipeline's fidelity: the block structure
 * becomes an INVISIBLE collider the player walks on, and a static entity
 * compiled from the real part geometry (ldraw-entity-compiler.ts: exact part
 * boxes, round studs, LDraw colours, Vibrant Visuals maps) stands on the same
 * footprint - the "shell". Doors, seats and figures keep working exactly as
 * before: they live on the block grid and the actor list, the shell is only
 * what the eye sees.
 *
 * Colliders are a custom block, `craftmatic:collider`, with two integer
 * states `lo` / `hi` (sixteenths of a block): the cell's collision box spans
 * lo..hi, measured from the part boxes that fall in the cell. A 53 LDU cell
 * whose only content is an 8 LDU baseplate collides 0..3/16, so the player
 * stands ON the plate the shell draws, not a block above it. The block is
 * fully transparent (alpha-tested clear texture), dampens no light (the
 * interior stays lit by daylight) and has no selection box, so a tap reaches
 * the vanilla door behind it.
 *
 * Frame: the block grid maps LDraw (x, y, z) to cells as (x, −y, −z) - a half
 * turn about X, the proper rotation between two right-handed frames
 * (`sceneGridPoint`). The shell must land on the same cells: at yaw 0 the
 * world sees the render frame as (−x, y, −z) (extraPlacement, proven on the
 * Pixel), so the shell is compiled like a vehicle whose nose is LDraw −Z,
 * `ldrawToRenderRotation('-z')` = diag(−1, −1, 1), which composes to exactly
 * (x, −y, −z) - the grid's frame. Until 2026-09-22 the grid was the MIRROR
 * (x, −y, z) and the shell used the point reflection −I to land on it: a
 * compensation for the mirror, not a frame of its own, and it made every
 * building read backwards. The shell's actor position is its floor centre
 * mapped through the voxelizer's grid origin like every figure and seat.
 */

import { withSizeGroups } from './bedrock-placement-pack.js';
import { BlockGrid } from '@craft/schem/types.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';
import { ldrawToRenderRotation } from './ldraw-entity-compiler.js';
import { PACK_NAMESPACE } from './mcpack.js';
import type { LegoEntityQuality } from './ldraw-part-prototype.js';
import { COLLIDER_KIT } from './collider-form.js';
import { addLayerBox, newCellLayers, type CellLayers } from './collider-clearance.js';

/** The custom collider block and its two sixteenth states. */
export const COLLIDER_BLOCK_ID = `${PACK_NAMESPACE}:collider`;
export const COLLIDER_LO_STATE = `${PACK_NAMESPACE}:lo`;
export const COLLIDER_HI_STATE = `${PACK_NAMESPACE}:hi`;
/** The block-state string the grid carries for a collider spanning lo..hi sixteenths. */
export const colliderState = (lo: number, hi: number): string => `${COLLIDER_BLOCK_ID}[lo=${lo},hi=${hi}]`;

/** The LDraw → render matrix for a building shell at yaw 0: a −Z nose, det +1 (see the header). */
export const SHELL_FRAME: readonly number[] = ldrawToRenderRotation('-z');

/**
 * Cuboid budgets for a building shell - a whole building is many times a
 * vehicle. Bricks are single boxes at any grain, so the grain only decides
 * slopes, curves and holes.
 *
 * `microcellLdu` is where every part STARTS; `maxModelCubes` is what the
 * entity must fit, and the compiler's per-part planner (`planPartGrains`)
 * coarsens individual parts, least visible loss per cuboid first, until it
 * does. Retuned 2026-09-21 from a table that had `balanced` at 8 LDU with a
 * 64-cuboid part cap: on 10303 (3,808 parts) that shipped 13.9k cuboids at an
 * area-weighted six-view silhouette IoU of 0.930, with the four coaster track
 * moulds - the set's whole point - pushed to 16 LDU by the part cap; `high`
 * asked for 4 LDU but its 32,768 cap sent the whole model back to 8. Measured
 * on the same set: uniform 4 LDU is 50.9k cuboids / 0.949, uniform 2 LDU
 * 142k / 0.967, 1 LDU 316k / 0.977 (and 68 s of compile). The device limits
 * (guide): ~480k resident cuboids over every active pack, ~50k DRAWN for
 * 60 fps, ~100k for 30. So:
 *
 *   balanced  48k total: one set fully in view stays at 60 fps, 10 % of the
 *             device; 10303 plans to IoU 0.957 with its track at 2-4 LDU.
 *   high      96k: a 30 fps scene when the whole set is near, 20 %.
 *   ultra    160k: everything at 2 LDU for a set this size (10303 is 157k),
 *             a third of the device. 1 LDU is not offered for a shell: 2.2x
 *             the cuboids again for +0.010 IoU, and a minute of compile.
 *
 * `maxPartCubes` is only a guard against a pathological mould now; the
 * planner, not the cap, decides what a detailed part may cost.
 */
export const LEGO_SHELL_QUALITY: Record<'balanced' | 'high' | 'ultra', LegoEntityQuality> = {
  balanced: { maxModelCubes: 49152, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 12288, studFacets: 4 },
  high: { maxModelCubes: 98304, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 16384, studFacets: 4 },
  ultra: { maxModelCubes: 163840, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 24576, studFacets: 4 },
};

/** Blocks that stay VISIBLE under the shell: what the scene made live, and light sources. */
export function isSceneBlock(state: string): boolean {
  const id = state.replace(/\[.*$/, '');
  return /_door$|trapdoor$|glowstone|sea_lantern|lantern$|torch$|_light$|light_block|shroomlight|froglight|_bed$|_sign$/.test(id) || id.startsWith(`${PACK_NAMESPACE}:`);
}

export interface ColliderGridStats {
  /** Cells turned into colliders. */
  colliders: number;
  /** Of those, cells whose collision box is not the full block (a floor plate, a ceiling slab). */
  partial: number;
  /** Visible scene blocks left as they are (doors, lights). */
  kept: number;
  /**
   * Solid voxel cells with NO visible geometry in their world block, which are
   * therefore NOT colliders (see `buildColliderGrid`). 0 when no boxes were given.
   */
  emptyVoxelsDropped: number;
  /** Blocks the visible geometry occupies that the voxel grid had left air, made colliders. */
  geometryBlocksAdded: number;
}

/**
 * The shell's invisible walkable blocks: a collider wherever the shell's own
 * part geometry is, at the height that geometry spans in the block. `boxes`
 * are LDraw AABBs (source frame) of every body cuboid the shell was compiled
 * from (`CompiledLdrawGeometry.partBoxesLdu`) — what the player SEES.
 *
 * Occupancy comes from those boxes, not from the voxel grid, because the two
 * are half a block apart. The voxelizer centres its cells on multiples of the
 * cell size (`parityFill`: a surface on a lattice line must not collapse), so
 * voxel `i` holds the geometry of grid coordinates [i − ½, i + ½); the
 * structure lays voxel `i` at world block [i, i + 1), and the shell entity is
 * drawn at `sceneGridPoint` — the same world the doors, figures and seats use.
 * Read as colliders, the voxel grid sat half a block off the model in every
 * axis. On 76417 Gringotts (2026-09-24, measured over the shipped cells) 1,070
 * of 3,535 collider blocks held no geometry at all — 138 of them one layer
 * over the bank floor, an invisible plane a player walked on a block above
 * the floor — and 614 blocks holding geometry had no collider. The old rule
 * "a solid cell no box reaches collides fully" is what turned the half-block
 * offset into full invisible blocks.
 *
 * The voxel grid still decides two things: the blocks the scene made live
 * (doors, lights), which stay as they are, and `keepClear` — cells the door
 * pass opened (the leaf and the passage to it, `applySceneDoors`), which stay
 * air even where a wall's geometry reaches them. With no boxes at all (the
 * shell did not report them) the voxel grid is used as before.
 */
export function buildColliderGrid(grid: BlockGrid, boxes: ReadonlyArray<{ min: Vec3; max: Vec3 }>, frame: SceneGridFrame, keepClear?: ReadonlySet<number>): { grid: BlockGrid; stats: ColliderGridStats; layers: CellLayers } {
  const out = new BlockGrid(grid.width, grid.height, grid.length);
  const lo = new Float32Array(grid.width * grid.height * grid.length).fill(1);
  const hi = new Float32Array(grid.width * grid.height * grid.length).fill(0);
  const idx = (x: number, y: number, z: number): number => (x * grid.height + y) * grid.length + z;
  // The geometry each cell holds, as sixteen layer footprints (sixteenths, rounded outward): what
  // clearance (collider-clearance.ts) trims a cell's collider back to. Same membership and rounding
  // as the cell's own lo/hi below, so a cell's layers span exactly its collider's lo..hi.
  const layers: CellLayers = new Map();
  for (const b of boxes) {
    // LDraw Y is down: the box's max y is its lowest point, so the grid span runs from max→min.
    const a = sceneGridPoint(frame, [b.min[0], b.max[1], b.min[2]]);
    const c = sceneGridPoint(frame, [b.max[0], b.min[1], b.max[2]]);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], c[0]) + 0.02)), x1 = Math.min(grid.width - 1, Math.floor(Math.max(a[0], c[0]) - 0.02));
    const z0 = Math.max(0, Math.floor(Math.min(a[2], c[2]) + 0.02)), z1 = Math.min(grid.length - 1, Math.floor(Math.max(a[2], c[2]) - 0.02));
    const yLo = Math.min(a[1], c[1]), yHi = Math.max(a[1], c[1]);
    const y0 = Math.max(0, Math.floor(yLo + 0.001)), y1 = Math.min(grid.height - 1, Math.ceil(yHi - 0.001) - 1);
    const bx0 = Math.min(a[0], c[0]), bx1 = Math.max(a[0], c[0]), bz0 = Math.min(a[2], c[2]), bz1 = Math.max(a[2], c[2]);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const i = idx(x, y, z);
      const cellLo = Math.max(0, yLo - y), cellHi = Math.min(1, yHi - y);
      if (cellHi <= cellLo) continue;
      if (cellLo < lo[i]!) lo[i] = cellLo;
      if (cellHi > hi[i]!) hi[i] = cellHi;
      let cell = layers.get(i);
      if (!cell) layers.set(i, cell = newCellLayers());
      const l = Math.max(0, Math.min(15, Math.floor(cellLo * 16)));
      addLayerBox(cell,
        Math.max(0, Math.min(15, Math.floor((Math.max(bx0, x) - x) * 16))), Math.max(1, Math.min(16, Math.ceil((Math.min(bx1, x + 1) - x) * 16))),
        l, Math.max(l + 1, Math.min(16, Math.ceil(cellHi * 16))),
        Math.max(0, Math.min(15, Math.floor((Math.max(bz0, z) - z) * 16))), Math.max(1, Math.min(16, Math.ceil((Math.min(bz1, z + 1) - z) * 16))));
    }
  }
  const stats: ColliderGridStats = { colliders: 0, partial: 0, kept: 0, emptyVoxelsDropped: 0, geometryBlocksAdded: 0 };
  const fromGeometry = boxes.length > 0;
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const state = grid.get(x, y, z);
    if (state !== 'minecraft:air' && isSceneBlock(state)) { out.set(x, y, z, state); stats.kept++; continue; }
    const i = idx(x, y, z);
    const seen = hi[i]! > lo[i]!;
    if (fromGeometry) {
      // Geometry decides; a cell the door pass opened stays open.
      if (!seen) { if (state !== 'minecraft:air') stats.emptyVoxelsDropped++; continue; }
      if (keepClear?.has(i)) continue;
      if (state === 'minecraft:air') stats.geometryBlocksAdded++;
    } else if (state === 'minecraft:air') continue;
    let l = 0, h = 16;
    if (seen) {
      l = Math.max(0, Math.min(15, Math.floor(lo[i]! * 16)));
      h = Math.max(l + 1, Math.min(16, Math.ceil(hi[i]! * 16)));
    }
    if (l !== 0 || h !== 16) stats.partial++;
    out.set(x, y, z, colliderState(l, h));
    stats.colliders++;
  }
  // Only cells that became colliders keep their geometry (a door-cleared or scene cell is not trimmed).
  for (const i of [...layers.keys()]) {
    const z = i % grid.length, y = Math.floor(i / grid.length) % grid.height, x = Math.floor(i / (grid.length * grid.height));
    if (!out.get(x, y, z).startsWith(COLLIDER_BLOCK_ID)) layers.delete(i);
  }
  return { grid: out, stats, layers };
}

/** The cell index `buildColliderGrid`'s `keepClear` uses: `(x·height + y)·length + z`. */
export const colliderCellIndex = (grid: { height: number; length: number }, x: number, y: number, z: number): number => (x * grid.height + y) * grid.length + z;

/** A form box (sixteenths) as a Bedrock collision box: origin from the block's bottom centre, pixels. */
const collisionBox = (b: readonly number[]): { origin: number[]; size: number[] } => ({ origin: [b[0]! - 8, b[2]!, b[4]! - 8], size: [b[1]! - b[0]!, b[3]! - b[2]!, b[5]! - b[4]!] });

/** Every (lo, hi) pair with lo < hi: 136 permutations, each laying variant `v`'s boxes (collider-form.ts). */
const COLLIDER_PERMUTATIONS = (v = 0): unknown[] => {
  const out: unknown[] = [];
  for (let l = 0; l < 16; l++) for (let h = l + 1; h <= 16; h++) {
    const boxes = COLLIDER_KIT.formBoxes(v, l, h).map(collisionBox);
    out.push({
      condition: `q.block_state('${COLLIDER_LO_STATE}') == ${l} && q.block_state('${COLLIDER_HI_STATE}') == ${h}`,
      components: { 'minecraft:collision_box': boxes.length === 1 ? boxes[0] : boxes },
    });
  }
  return out;
};

/**
 * The behaviour-pack block definition of collider variant `v` (0: the
 * full-footprint `craftmatic:collider`; the others are the clearance forms,
 * collider-form.ts). A floor + wall or wall + ceiling form is two boxes, which
 * Bedrock accepts as an array from format 1.26.0 (Microsoft Learn,
 * minecraft:collision_box), so those blocks declare it; the others keep the
 * format the collider has always had.
 */
export function colliderBlockDefinition(v = 0): unknown {
  const variant = COLLIDER_KIT.VARIANTS[v]!;
  const base = COLLIDER_KIT.formBoxes(v, 0, 16).map(collisionBox);
  return {
    format_version: variant.kind === 0 ? '1.21.40' : '1.26.0',
    'minecraft:block': {
      description: {
        identifier: variant.id,
        menu_category: { category: 'none' },
        states: {
          [COLLIDER_LO_STATE]: { values: { min: 0, max: 15 } },
          [COLLIDER_HI_STATE]: { values: { min: 1, max: 16 } },
        },
      },
      components: {
        'minecraft:geometry': 'minecraft:geometry.full_block',
        'minecraft:material_instances': { '*': { texture: 'craftmatic_collider', render_method: 'alpha_test', face_dimming: false, ambient_occlusion: false } },
        'minecraft:collision_box': base.length === 1 ? base[0] : base,
        'minecraft:selection_box': false,
        'minecraft:light_dampening': 0,
        'minecraft:destructible_by_mining': { seconds_to_destroy: 0.5 },
        'minecraft:destructible_by_explosion': false,
        'minecraft:friction': 0.6,
      },
      permutations: COLLIDER_PERMUTATIONS(v),
    },
  };
}

/** Every collider block id the pack defines (43: the full form and the clearance forms), for fills and type checks. */
export const COLLIDER_BLOCK_IDS: readonly string[] = COLLIDER_KIT.VARIANTS.map(d => d.id);
/** The pack file name of variant `v`'s block definition. */
export const colliderBlockFile = (v: number): string => v === 0 ? 'collider.json' : `${COLLIDER_KIT.VARIANTS[v]!.id.replace(/^.*:/, '')}.json`;

/** The resource-pack `blocks.json` entry: sound and the transparent texture. */
export const COLLIDER_BLOCKS_JSON = {
  format_version: '1.21.40',
  [COLLIDER_BLOCK_ID]: { sound: 'stone', textures: 'craftmatic_collider' },
} as const;
/** Terrain texture entry for the clear tile. */
export const COLLIDER_TERRAIN_TEXTURE = { craftmatic_collider: { textures: 'textures/blocks/craftmatic_collider' } } as const;

/**
 * Bedrock stops DRAWING an actor beyond a distance that scales with its
 * collision box: measured on the Pixel 8 Pro (2026-09-21, 10303 photographed
 * in full at 60 blocks and absent at 70, 86, 100 and 168 with the old
 * 0.1 × 0.1 shell box; the 0.6 × 1.8 figures still drawn at 100 and gone by
 * 168), the fit is `64 × max(1, |box diagonal|)` blocks. It is not the
 * geometry's `visible_bounds` (frustum culling; the shell declared 177 × 189)
 * and not the LOD hull (same actor, same cull). So the shell's box is sized
 * for the cull distance the model deserves: `SHELL_CULL_PER_MODEL_BLOCK`
 * times its largest dimension, never under the 64-block floor.
 *
 * The box is a NEEDLE: `SHELL_BOX_WIDTH` wide and as tall as the diagonal
 * needs. Width barely moves the diagonal, and a thin box intercepts no taps.
 * It stands above the model: the shell's origin is lifted a block over its
 * roof (`originAboveModel`, every cube's top is below the origin) and a
 * collision box extends UP from the origin, so the needle is in the sky over
 * the model's centre column and touches nothing the player stands on
 * (asserted in test/bedrock-building-shell.test.ts). The wand's size groups
 * scale it with the model (`withSizeGroups`), so the cull distance scales
 * too: a 400 % placement is drawn four times as far, a 25 % one keeps the floor.
 *
 * TODO(cull): the LONGER reach a tall needle buys is extrapolated from the
 * three-point fit above, never measured. On the Saga (Minecraft 26.52,
 * 2026-09-26) the 76417 shell (needle 2.115, predicted ~135 blocks), a door
 * (0.25 x 2.5), a figure and vanilla pigs all stopped drawing TOGETHER between
 * 71.5 and 73 blocks, with render distance 192 and simulation distance 8
 * chunks: there the box size set nothing. Re-measure on the Pixel (26.51)
 * before relying on the needle; `output/saga-followup-0925/`.
 *
 * TODO(playable-addon.ts, not this file): pass `sgeo.sizeBlocks` as the
 * second argument of `shellBehavior` so the box derives from the model;
 * until then `SHELL_FALLBACK_EXTENT_BLOCKS` (10303's height, the largest set
 * measured) stands in.
 */
export const ACTOR_CULL_FLOOR_BLOCKS = 64;
export const SHELL_CULL_PER_MODEL_BLOCK = 4;
export const SHELL_BOX_WIDTH = 0.1;
export const SHELL_FALLBACK_EXTENT_BLOCKS = 44;

/** The distance at which Bedrock stops drawing an actor with this collision box at wand factor `f` (the measured fit above). */
export function actorCullDistance(box: { width: number; height: number }, f = 1): number {
  return ACTOR_CULL_FLOOR_BLOCKS * Math.max(1, f * Math.hypot(box.width, box.width, box.height));
}

/** The shell's collision box for a model of this extent (blocks at 100 %): a needle tall enough for its cull distance. */
export function shellCollisionBox(extent?: { width: number; height: number; length: number }): { width: number; height: number } {
  const largest = extent ? Math.max(extent.width, extent.height, extent.length) : SHELL_FALLBACK_EXTENT_BLOCKS;
  const wanted = Math.max(ACTOR_CULL_FLOOR_BLOCKS, SHELL_CULL_PER_MODEL_BLOCK * largest);
  const diagonal = wanted / ACTOR_CULL_FLOOR_BLOCKS;
  const height = Math.max(SHELL_BOX_WIDTH, Math.sqrt(Math.max(0, diagonal * diagonal - 2 * SHELL_BOX_WIDTH * SHELL_BOX_WIDTH)));
  return { width: SHELL_BOX_WIDTH, height: Math.ceil(height * 1000) / 1000 };
}

/** The static shell entity: no gravity, no collision, cannot be selected, hurt or pushed; its collision box only sets how far it is drawn. */
export function shellBehavior(id: string, extentBlocks?: { width: number; height: number; length: number }): unknown {
  const box = shellCollisionBox(extentBlocks);
  return withSizeGroups({
    format_version: '1.26.30',
    'minecraft:entity': {
      description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: false, is_summonable: true },
      components: {
        'minecraft:type_family': { family: ['craftmatic_shell'] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': box,
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 120, max_dropped_ticks: 20, use_motion_prediction_hints: false } },
      },
    },
  }, box);
}
