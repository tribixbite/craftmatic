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
 * Frame: the block grid maps LDraw (x, y, z) to cells as (x, −y, z) - a
 * MIRROR of the model (LDraw and Minecraft are both right-handed; only Y
 * flips). The shell must land on the same cells, so it is compiled with the
 * point reflection −I as its LDraw→render matrix: at yaw 0 the world sees the
 * render frame as (−x, y, −z) (extraPlacement, proven on the Pixel), which
 * composes to exactly (x, −y, z) - the grid's frame. The shell's actor
 * position is its floor centre mapped through the voxelizer's grid origin
 * like every figure and seat.
 */

import { withSizeGroups } from './bedrock-placement-pack.js';
import { BlockGrid } from '@craft/schem/types.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';
import { PACK_NAMESPACE } from './mcpack.js';
import type { LegoEntityQuality } from './ldraw-part-prototype.js';

/** The custom collider block and its two sixteenth states. */
export const COLLIDER_BLOCK_ID = `${PACK_NAMESPACE}:collider`;
export const COLLIDER_LO_STATE = `${PACK_NAMESPACE}:lo`;
export const COLLIDER_HI_STATE = `${PACK_NAMESPACE}:hi`;
/** The block-state string the grid carries for a collider spanning lo..hi sixteenths. */
export const colliderState = (lo: number, hi: number): string => `${COLLIDER_BLOCK_ID}[lo=${lo},hi=${hi}]`;

/** The LDraw → render matrix for a building shell: the point reflection (see the header). */
export const SHELL_FRAME: readonly number[] = [-1, 0, 0, 0, -1, 0, 0, 0, -1];

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
}

/**
 * Replace the solid scenery with colliders whose height matches the part
 * geometry in each cell. `boxes` are LDraw AABBs (source frame) of every body
 * cuboid the shell was compiled from (`CompiledLdrawGeometry.partBoxesLdu`).
 * A solid cell no box reaches (gap fill, a bridged hole) collides fully.
 */
export function buildColliderGrid(grid: BlockGrid, boxes: ReadonlyArray<{ min: Vec3; max: Vec3 }>, frame: SceneGridFrame): { grid: BlockGrid; stats: ColliderGridStats } {
  const out = new BlockGrid(grid.width, grid.height, grid.length);
  const lo = new Float32Array(grid.width * grid.height * grid.length).fill(1);
  const hi = new Float32Array(grid.width * grid.height * grid.length).fill(0);
  const idx = (x: number, y: number, z: number): number => (x * grid.height + y) * grid.length + z;
  for (const b of boxes) {
    // LDraw Y is down: the box's max y is its lowest point, so the grid span runs from max→min.
    const a = sceneGridPoint(frame, [b.min[0], b.max[1], b.min[2]]);
    const c = sceneGridPoint(frame, [b.max[0], b.min[1], b.max[2]]);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], c[0]) + 0.02)), x1 = Math.min(grid.width - 1, Math.floor(Math.max(a[0], c[0]) - 0.02));
    const z0 = Math.max(0, Math.floor(Math.min(a[2], c[2]) + 0.02)), z1 = Math.min(grid.length - 1, Math.floor(Math.max(a[2], c[2]) - 0.02));
    const yLo = Math.min(a[1], c[1]), yHi = Math.max(a[1], c[1]);
    const y0 = Math.max(0, Math.floor(yLo + 0.001)), y1 = Math.min(grid.height - 1, Math.ceil(yHi - 0.001) - 1);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) {
      const i = idx(x, y, z);
      const cellLo = Math.max(0, yLo - y), cellHi = Math.min(1, yHi - y);
      if (cellHi <= cellLo) continue;
      if (cellLo < lo[i]!) lo[i] = cellLo;
      if (cellHi > hi[i]!) hi[i] = cellHi;
    }
  }
  const stats: ColliderGridStats = { colliders: 0, partial: 0, kept: 0 };
  for (let x = 0; x < grid.width; x++) for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) {
    const state = grid.get(x, y, z);
    if (state === 'minecraft:air') continue;
    if (isSceneBlock(state)) { out.set(x, y, z, state); stats.kept++; continue; }
    const i = idx(x, y, z);
    let l = 0, h = 16;
    if (hi[i]! > lo[i]!) {
      l = Math.max(0, Math.min(15, Math.floor(lo[i]! * 16)));
      h = Math.max(l + 1, Math.min(16, Math.ceil(hi[i]! * 16)));
    }
    if (l !== 0 || h !== 16) stats.partial++;
    out.set(x, y, z, colliderState(l, h));
    stats.colliders++;
  }
  return { grid: out, stats };
}

/** Every (lo, hi) pair with lo < hi: 136 permutations. */
const COLLIDER_PERMUTATIONS = (): unknown[] => {
  const out: unknown[] = [];
  for (let l = 0; l < 16; l++) for (let h = l + 1; h <= 16; h++) {
    out.push({
      condition: `q.block_state('${COLLIDER_LO_STATE}') == ${l} && q.block_state('${COLLIDER_HI_STATE}') == ${h}`,
      components: { 'minecraft:collision_box': { origin: [-8, l, -8], size: [16, h - l, 16] } },
    });
  }
  return out;
};

/** The behaviour-pack block definition. */
export function colliderBlockDefinition(): unknown {
  return {
    format_version: '1.21.40',
    'minecraft:block': {
      description: {
        identifier: COLLIDER_BLOCK_ID,
        menu_category: { category: 'none' },
        states: {
          [COLLIDER_LO_STATE]: { values: { min: 0, max: 15 } },
          [COLLIDER_HI_STATE]: { values: { min: 1, max: 16 } },
        },
      },
      components: {
        'minecraft:geometry': 'minecraft:geometry.full_block',
        'minecraft:material_instances': { '*': { texture: 'craftmatic_collider', render_method: 'alpha_test', face_dimming: false, ambient_occlusion: false } },
        'minecraft:collision_box': { origin: [-8, 0, -8], size: [16, 16, 16] },
        'minecraft:selection_box': false,
        'minecraft:light_dampening': 0,
        'minecraft:destructible_by_mining': { seconds_to_destroy: 0.5 },
        'minecraft:destructible_by_explosion': false,
        'minecraft:friction': 0.6,
      },
      permutations: COLLIDER_PERMUTATIONS(),
    },
  };
}

/** The resource-pack `blocks.json` entry: sound and the transparent texture. */
export const COLLIDER_BLOCKS_JSON = {
  format_version: '1.21.40',
  [COLLIDER_BLOCK_ID]: { sound: 'stone', textures: 'craftmatic_collider' },
} as const;
/** Terrain texture entry for the clear tile. */
export const COLLIDER_TERRAIN_TEXTURE = { craftmatic_collider: { textures: 'textures/blocks/craftmatic_collider' } } as const;

/** The static shell entity: no gravity, no collision, cannot be selected, hurt or pushed. */
export function shellBehavior(id: string): unknown {
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
        'minecraft:collision_box': { width: 0.1, height: 0.1 },
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 120, max_dropped_ticks: 20, use_motion_prediction_hints: false } },
      },
    },
  }, { width: 0.1, height: 0.1 });
}
