import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  ACTOR_CULL_FLOOR_BLOCKS, COLLIDER_BLOCK_ID, COLLIDER_BLOCK_IDS, SHELL_BOX_WIDTH, SHELL_FRAME, actorCullDistance, actorCullFit, buildColliderGrid, clipParallelepiped, colliderBlockDefinition, colliderCellIndex, colliderState, gridParallelepiped, isSceneBlock, isTiltedBox, shellBehavior, shellCollisionBox, yawStepKept, YAW_STEP_MAX_BLOCKS,
} from '../web/src/engine/bedrock-building-shell.js';
import { SIZE_STEPS } from '../web/src/engine/bedrock-placement-pack.js';
import { BlockTypes } from '../web/src/sim/world/block-types.js';
import { ACTOR_DRAW_CEILING_BLOCKS } from '../web/src/engine/bedrock-lod-hull.js';
import { toBedrockBlock } from '../web/src/engine/bedrock-blocks.js';
import { buildPlayableAddon } from '../web/src/engine/playable-addon.js';
import { compileLdrawEntityGeometry } from '../web/src/engine/ldraw-entity-compiler.js';
import { createPartGeometryProvider } from '../web/src/engine/ldraw-part-geometry.js';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { SceneGridFrame } from '../web/src/engine/bedrock-scene-actors.js';

/** A grid frame with the cell origin at LDraw 0 and minifig-scale cells. */
const frame: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: LDU_PER_BLOCK, cellY: LDU_PER_BLOCK };
const C = LDU_PER_BLOCK;

describe('buildColliderGrid', () => {
  it('collides a baseplate cell only as high as the plate, a wall fully, keeps doors, and lays nothing where nothing is seen', () => {
    const grid = new BlockGrid(3, 3, 3);
    grid.set(0, 0, 0, 'minecraft:white_concrete'); // a plate 8 LDU thick at the cell floor
    grid.set(1, 0, 0, 'minecraft:white_concrete'); // a full-height wall
    grid.set(2, 0, 0, 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    grid.set(0, 1, 0, 'minecraft:white_concrete'); // a voxel no part's geometry reaches: an invisible wall until 2026-09-24
    grid.set(1, 2, 0, 'minecraft:white_concrete'); // a ceiling slab at the TOP of its cell
    // LDraw Y down: the plate spans y −8..0 (top at −8), the wall −C..0, the slab sits at the top of cell y=2: y −3C..−3C+8.
    // Grid z 0 is LDraw z −C..0: the grid is a half turn about X, so grid +Z is LDraw −Z.
    const boxes = [
      { min: [0, -8, -C] as [number, number, number], max: [C, 0, 0] as [number, number, number] },
      { min: [C, -C, -C] as [number, number, number], max: [2 * C, 0, 0] as [number, number, number] },
      { min: [C, -3 * C, -C] as [number, number, number], max: [2 * C, -3 * C + 8, 0] as [number, number, number] },
    ];
    const { grid: out, stats } = buildColliderGrid(grid, boxes, frame);
    expect(out.get(0, 0, 0)).toBe(colliderState(0, 3));
    expect(out.get(1, 0, 0)).toBe(colliderState(0, 16));
    expect(out.get(2, 0, 0)).toBe('minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    expect(out.get(0, 1, 0)).toBe('minecraft:air');
    expect(out.get(1, 2, 0)).toBe(colliderState(13, 16));
    expect(out.get(2, 2, 2)).toBe('minecraft:air');
    expect(stats).toEqual({ colliders: 3, partial: 2, kept: 1, emptyVoxelsDropped: 1, geometryBlocksAdded: 0, turnedBoxes: 0, turnedCellsSpared: 0, yawBoxes: 0, yawRunsKept: 0, yawRunsDropped: 0, yawCellsSpared: 0 });
  });

  it('lays a collider wherever the shell draws geometry, even where the centred voxel grid left the block air', () => {
    // The voxelizer centres cell i on i (it holds [i − ½, i + ½)); the world
    // block the structure lays it in is [i, i + 1). A plate whose top sits in
    // the upper half of block 0 is voxel 1's content - here the grid has
    // nothing in block 0 at all - and was walked through, while voxel 1 stood
    // as a full invisible block over it (76417's bank floor, 2026-09-24).
    const grid = new BlockGrid(2, 3, 2);
    grid.set(0, 1, 0, 'minecraft:white_concrete');
    const plate = [{ min: [0, -0.75 * C, -C] as [number, number, number], max: [C, -0.6 * C, 0] as [number, number, number] }];
    const { grid: out, stats } = buildColliderGrid(grid, plate, frame);
    expect(out.get(0, 0, 0)).toBe(colliderState(9, 12));
    expect(out.get(0, 1, 0)).toBe('minecraft:air');
    expect(stats).toMatchObject({ colliders: 1, emptyVoxelsDropped: 1, geometryBlocksAdded: 1 });
  });

  it('keeps a cell the door pass opened clear, whatever geometry reaches it', () => {
    const grid = new BlockGrid(2, 2, 2);
    const wall = [{ min: [0, -C, -C] as [number, number, number], max: [C, 0, 0] as [number, number, number] }];
    const keepClear = new Set([colliderCellIndex(grid, 0, 0, 0)]);
    expect(buildColliderGrid(grid, wall, frame, keepClear).grid.get(0, 0, 0)).toBe('minecraft:air');
    expect(buildColliderGrid(grid, wall, frame).grid.get(0, 0, 0)).toBe(colliderState(0, 16));
  });

  it('lays a TURNED cuboid from its own box: a bar tilted 45 degrees leaves the cells under it open', () => {
    // A 4 LDU bar climbing from grid (0, 0) to (4, 4) in x/y (LDraw y is down, so it climbs toward -y),
    // centred in grid z cell 0. Its bounding box is the whole 4 x 4 square; the bar crosses only the diagonal.
    // TODO(tilted-colliders) 10326: the museum's handrail laid exactly that square as an invisible band.
    const grid = new BlockGrid(5, 5, 1);
    const k = Math.SQRT1_2, L = 4 * C * Math.SQRT2;
    const R = [k, k, 0, -k, k, 0, 0, 0, 1]; // +X -> (k, -k, 0): up and along x
    const obb = { R, t: [0, 0, -C / 2] as [number, number, number], min: [0, -2, -2] as [number, number, number], max: [L, 2, 2] as [number, number, number] };
    const corners = [0, 1].flatMap(a => [0, 1].flatMap(b => [0, 1].map(c => {
      const v = [a ? L : 0, b ? 2 : -2, c ? 2 : -2];
      return [R[0]! * v[0]! + R[1]! * v[1]! + R[2]! * v[2]!, R[3]! * v[0]! + R[4]! * v[1]! + R[5]! * v[2]!, R[6]! * v[0]! + R[7]! * v[1]! + R[8]! * v[2]! - C / 2];
    })));
    const min = [0, 1, 2].map(i => Math.min(...corners.map(q => q[i]!))) as [number, number, number];
    const max = [0, 1, 2].map(i => Math.max(...corners.map(q => q[i]!))) as [number, number, number];
    const turned = buildColliderGrid(grid, [{ min, max, obb }], frame);
    const flat = buildColliderGrid(grid, [{ min, max }], frame);
    // The old rule: every cell of the 4 x 4 square.
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) expect(flat.grid.get(x, y, 0)).not.toBe('minecraft:air');
    // The bar's diagonal collides; the corner under the bar and the corner over it are open.
    for (let d = 0; d < 4; d++) expect(turned.grid.get(d, d, 0)).not.toBe('minecraft:air');
    expect(turned.grid.get(3, 0, 0)).toBe('minecraft:air');
    expect(turned.grid.get(2, 0, 0)).toBe('minecraft:air');
    expect(turned.grid.get(0, 3, 0)).toBe('minecraft:air');
    expect(turned.stats.turnedBoxes).toBe(1);
    expect(turned.stats.turnedCellsSpared).toBeGreaterThanOrEqual(4);
    // No cell the bar does not reach; every cell it does is laid (a 4 LDU bar is 0.12 block thick:
    // its diagonal and the cells beside it that the thickness reaches into).
    let laid = 0;
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) if (turned.grid.get(x, y, 0) !== 'minecraft:air') laid++;
    expect(laid).toBeLessThanOrEqual(12);
    // The cell's layers follow the bar: cell (1, 1) holds it rising across the cell, so its lowest layer's
    // footprint sits at the cell's low-x side and its highest at the high-x side.
    const cell = turned.layers.get(colliderCellIndex(grid, 1, 1, 0))!;
    const levels = [...Array(16).keys()].filter(l => cell[4 * l] !== 255);
    const first = levels[0]!, last = levels[levels.length - 1]!;
    expect(cell[4 * first]!).toBeLessThan(cell[4 * last]!);
    expect(cell[4 * first + 1]!).toBeLessThan(cell[4 * last + 1]!);
  });

  it('keeps a ramp walkable: a plate turned up 0.5 block per block has a top in every column, rising with it', () => {
    const grid = new BlockGrid(5, 4, 1);
    const angle = Math.atan(0.5), cs = Math.cos(angle), sn = Math.sin(angle);
    const R = [cs, sn, 0, -sn, cs, 0, 0, 0, 1];
    const L = 4 * C / cs;
    const obb = { R, t: [0, 0, 0] as [number, number, number], min: [0, -8, -C] as [number, number, number], max: [L, 0, 0] as [number, number, number] };
    const pts = [0, 1].flatMap(a => [0, 1].flatMap(b => [0, 1].map(c => {
      const v = [a ? L : 0, b ? 0 : -8, c ? 0 : -C];
      return [R[0]! * v[0]! + R[1]! * v[1]!, R[3]! * v[0]! + R[4]! * v[1]!, v[2]!];
    })));
    const min = [0, 1, 2].map(i => Math.min(...pts.map(q => q[i]!))) as [number, number, number];
    const max = [0, 1, 2].map(i => Math.max(...pts.map(q => q[i]!))) as [number, number, number];
    const { grid: out } = buildColliderGrid(grid, [{ min, max, obb }], frame);
    const topOf = (x: number): number => {
      let top = -1;
      for (let y = 0; y < 4; y++) {
        const m = /\[lo=(\d+),hi=(\d+)\]/.exec(out.get(x, y, 0));
        if (m) top = y + Number(m[2]) / 16;
      }
      return top;
    };
    const tops = [0, 1, 2, 3].map(topOf);
    // The plate's top surface rises 0.5 per block from 8 LDU over the floor; each column's collider top
    // is the plate's highest point in that column (rounded up to a sixteenth), never the ramp's summit.
    // (The far column ends at the plate's top corner, which the thickness pulls back by 8·sin/C.)
    const surface = (x: number): number => 8 / C / cs + 0.5 * Math.min(x, 4 - 8 * sn / C);
    tops.forEach((top, x) => {
      expect(top).toBeGreaterThanOrEqual(surface(x + 1) - 1e-6);
      expect(top).toBeLessThanOrEqual(surface(x + 1) + 1 / 16 + 1e-6);
    });
  });

  it('lays a box turned a quarter about X (tilted, yet axis-aligned) exactly as its AABB: the exact path rounds as the AABB path does', () => {
    const grid = new BlockGrid(3, 3, 3);
    const box = { min: [3, -1.3 * C, -2.2 * C] as [number, number, number], max: [1.7 * C, -0.2 * C, -0.4 * C] as [number, number, number] };
    // R = a quarter turn about X; the local box is the world box taken back through R^T (world = R·local).
    const R = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const back = (v: readonly number[]): number[] => [v[0]!, v[2]!, -v[1]!];
    const c0 = back(box.min), c1 = back(box.max);
    const local = { min: [0, 1, 2].map(i => Math.min(c0[i]!, c1[i]!)) as [number, number, number], max: [0, 1, 2].map(i => Math.max(c0[i]!, c1[i]!)) as [number, number, number] };
    expect(isTiltedBox({ R, t: [0, 0, 0], ...local })).toBe(true);
    const a = buildColliderGrid(grid, [box], frame);
    const b = buildColliderGrid(grid, [{ ...box, obb: { R, t: [0, 0, 0] as [number, number, number], ...local } }], frame);
    expect(b.stats.turnedBoxes).toBe(1);
    for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) expect(b.grid.get(x, y, z)).toBe(a.grid.get(x, y, z));
    expect([...b.layers.keys()].sort()).toEqual([...a.layers.keys()].sort());
    for (const [i, l] of a.layers) expect([...b.layers.get(i)!]).toEqual([...l]);
  });

  describe('a cuboid turned about the VERTICAL only (a yaw)', () => {
    // A plate turned 45 degrees about Y: a diamond in its 4 x 4 square, centred on grid (2, 2) in x/z.
    // Its half-diagonal is 1.98 blocks, so it never reaches the corner cells (0, 0), (3, 0), (0, 3), (3, 3).
    const k = Math.SQRT1_2, R = [k, 0, k, 0, 1, 0, -k, 0, k];
    const half = 1.4 * C * Math.SQRT2;
    type V3 = [number, number, number];
    /** The plate with its top `up` blocks over the grid floor (`thick` LDU thick), with its oriented box. */
    const plate = (up: number, thick = 8): { min: V3; max: V3; obb: { R: number[]; t: V3; min: V3; max: V3 } } => ({
      min: [2 * C - half, -up * C, -2 * C - half], max: [2 * C + half, -up * C + thick, -2 * C + half],
      obb: { R, t: [2 * C, -up * C, -2 * C], min: [-1.4 * C, 0, -1.4 * C], max: [1.4 * C, thick, 1.4 * C] },
    });
    /** A floor drawn axis-aligned under the whole square, its top `up` blocks over the grid floor. */
    const floorAt = (up: number): { min: V3; max: V3 } => ({ min: [0, -up * C, -4 * C], max: [4 * C, -up * C + 0.5 * C, 0] });
    const yOf = (up: number): number => Math.floor(up - 1e-6);
    const corners = [[0, 0], [3, 0], [0, 3], [3, 3]] as const;

    it('keeps its bounding box where its corners are a step over the ground (76435\'s first riser)', () => {
      const grid = new BlockGrid(4, 2, 4);
      const b = plate(8 / C);
      expect(isTiltedBox(b.obb)).toBe(false);
      const a = buildColliderGrid(grid, [{ min: b.min, max: b.max }], frame), t = buildColliderGrid(grid, [b], frame);
      expect(t.stats.turnedBoxes).toBe(0);
      expect(t.stats.yawBoxes).toBe(1);
      expect(t.stats.yawRunsDropped).toBe(0);
      for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) expect(t.grid.get(x, 0, z)).toBe(a.grid.get(x, 0, z));
    });

    it('drops the corners of a plate over a drop: no invisible floor in open air (76417 Gate 1)', () => {
      const grid = new BlockGrid(4, 12, 4);
      const t = buildColliderGrid(grid, [plate(10)], frame), y = yOf(10);
      for (const [x, z] of corners) expect(t.grid.get(x, y, z)).toBe('minecraft:air');
      for (const [x, z] of [[1, 1], [2, 2], [1, 2], [2, 1]] as const) expect(t.grid.get(x, y, z)).not.toBe('minecraft:air');
      expect(t.stats.yawRunsDropped).toBeGreaterThanOrEqual(4);
      expect(t.stats.yawCellsSpared).toBe(4);
    });

    it('keeps the corners a jump over a floor drawn under them (a stair of turned treads), not over a deeper one', () => {
      const grid = new BlockGrid(4, 12, 4), y = yOf(10);
      const t = buildColliderGrid(grid, [floorAt(9.5), plate(10)], frame);
      for (const [x, z] of corners) expect(t.grid.get(x, y, z)).not.toBe('minecraft:air');
      expect(t.stats.yawRunsDropped).toBe(0);
      const d = buildColliderGrid(grid, [floorAt(8), plate(10)], frame);
      for (const [x, z] of corners) expect(d.grid.get(x, y, z)).toBe('minecraft:air');
    });

    it('drops the corners of a wall taller than a jump: no invisible pillar beside a doorway', () => {
      const grid = new BlockGrid(4, 3, 4);
      const t = buildColliderGrid(grid, [plate(2, 2 * C)], frame);
      for (const [x, z] of corners) for (let y = 0; y < 2; y++) expect(t.grid.get(x, y, z)).toBe('minecraft:air');
      expect(t.grid.get(2, 1, 2)).not.toBe('minecraft:air');
      expect(yawStepKept(2, 0)).toBe(false);
      expect(yawStepKept(YAW_STEP_MAX_BLOCKS, 0)).toBe(true);
    });
  });

  it('clips a parallelepiped against a box exactly (against dense sampling)', () => {
    let seed = 7;
    const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let trial = 0; trial < 40; trial++) {
      // A random rotation (two axis turns) of a random cuboid, against the unit cell.
      const ax = rand() * Math.PI, ay = rand() * Math.PI;
      const Rx = [1, 0, 0, 0, Math.cos(ax), -Math.sin(ax), 0, Math.sin(ax), Math.cos(ax)];
      const Ry = [Math.cos(ay), 0, Math.sin(ay), 0, 1, 0, -Math.sin(ay), 0, Math.cos(ay)];
      const R = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => Rx[r * 3]! * Ry[c]! + Rx[r * 3 + 1]! * Ry[3 + c]! + Rx[r * 3 + 2]! * Ry[6 + c]!));
      const size: [number, number, number] = [0.1 + rand() * 1.5, 0.05 + rand() * 0.8, 0.1 + rand() * 1.2];
      const t: [number, number, number] = [rand() * 1.4 - 0.2, -(rand() * 1.4 - 0.2), -(rand() * 1.4 - 0.2)];
      const unit: SceneGridFrame = { x: 0, y: 0, z: 0, scale: 1, cellXZ: 1, cellY: 1 };
      const pp = gridParallelepiped(unit, { R, t, min: [0, 0, 0], max: size })!;
      const lo: [number, number, number] = [0, 0, 0], hi: [number, number, number] = [1, 1, 1];
      const got = clipParallelepiped(pp, lo, hi);
      const smin = [Infinity, Infinity, Infinity], smax = [-Infinity, -Infinity, -Infinity];
      const N = 24;
      for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) for (let k = 0; k <= N; k++) {
        const q = [0, 1, 2].map(r => pp.o[r]! + i / N * pp.e[0][r]! + j / N * pp.e[1][r]! + k / N * pp.e[2][r]!);
        if (q.some((v, r) => v < lo[r]! || v > hi[r]!)) continue;
        for (let r = 0; r < 3; r++) { smin[r] = Math.min(smin[r]!, q[r]!); smax[r] = Math.max(smax[r]!, q[r]!); }
      }
      if (smin[0] === Infinity) continue; // the sampling saw nothing; nothing to compare
      expect(got).not.toBeNull();
      // Exact bounds contain every sample, and no sample is farther than the sampling step inside them.
      const step = Math.max(...pp.e.map(e => Math.hypot(...e))) / N * 1.8;
      for (let r = 0; r < 3; r++) {
        expect(got!.min[r]!).toBeLessThanOrEqual(smin[r]! + 1e-9);
        expect(got!.max[r]!).toBeGreaterThanOrEqual(smax[r]! - 1e-9);
        expect(smin[r]! - got!.min[r]!).toBeLessThanOrEqual(step);
        expect(got!.max[r]! - smax[r]!).toBeLessThanOrEqual(step);
      }
    }
    // Disjoint: a box beside the unit cell.
    const pp = gridParallelepiped({ x: 0, y: 0, z: 0, scale: 1, cellXZ: 1, cellY: 1 }, { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [2, 0, 0], min: [0, -1, -1], max: [1, 0, 0] })!;
    expect(clipParallelepiped(pp, [0, 0, 0], [1, 1, 1])).toBeNull();
  });

  it('falls back to the voxel grid when the shell reported no boxes', () => {
    const grid = new BlockGrid(1, 1, 1);
    grid.set(0, 0, 0, 'minecraft:white_concrete');
    expect(buildColliderGrid(grid, [], frame).grid.get(0, 0, 0)).toBe(colliderState(0, 16));
  });

  it('keeps the blocks the scene made live and light sources', () => {
    expect(isSceneBlock('minecraft:spruce_door[facing=south]')).toBe(true);
    expect(isSceneBlock('minecraft:sea_lantern')).toBe(true);
    expect(isSceneBlock('minecraft:white_concrete')).toBe(false);
    expect(isSceneBlock('minecraft:glass_pane[north=true]')).toBe(false);
  });
});

/**
 * The shell's collision box only sets how far Bedrock draws the actor
 * (`64 × max(1, |box diagonal|)`, measured on the Pixel 8 Pro 2026-09-21: the
 * 0.1 × 0.1 box culled 10303 at ~64 blocks). The box must be a thin needle
 * sized from the model's own extent, scale with the wand's size groups, and
 * stand entirely above the model so it intercepts nothing.
 */
describe('the shell collision box and its cull distance', () => {
  const box = (largest: number) => shellCollisionBox({ width: largest, height: largest / 2, length: largest / 3 });
  const fit = (largest: number, f = 1) => Math.round(actorCullFit(box(largest), f));

  it('is a needle sized so the box fit is four times the largest dimension, never under the 64-block floor', () => {
    // A small vehicle-sized model (5 blocks) keeps the floor; 10303 (44 blocks tall) fits 176;
    // a 100-block castle 400. The old 0.1 × 0.1 box gave 64 for every model.
    expect(box(5).width).toBe(SHELL_BOX_WIDTH);
    expect(fit(5)).toBe(ACTOR_CULL_FLOOR_BLOCKS);
    expect(fit(44)).toBe(176);
    expect(fit(100)).toBe(400);
    expect(box(44).height).toBeCloseTo(2.75, 1);
    expect(actorCullFit({ width: 0.1, height: 0.1 })).toBe(64);
  });

  it('draws no actor past the ceiling measured on 26.51/26.52, whatever its box (round 2026-09-26a)', () => {
    // The 76417 needle (2.115, fit 135), a door (0.25 × 2.5, fit 160) and a figure all vanished at 71-73 blocks.
    expect(actorCullDistance({ width: SHELL_BOX_WIDTH, height: 2.115 })).toBe(ACTOR_DRAW_CEILING_BLOCKS);
    expect(actorCullDistance({ width: 0.25, height: 2.5 })).toBe(ACTOR_DRAW_CEILING_BLOCKS);
    expect(actorCullDistance({ width: 0.6, height: 1.8 })).toBe(ACTOR_DRAW_CEILING_BLOCKS);
    expect(ACTOR_DRAW_CEILING_BLOCKS).toBeLessThan(71.6); // the earliest "gone" measured (a vanilla armor stand)
    // Under the ceiling the fit still answers (a small box keeps the 64-block floor).
    expect(actorCullDistance({ width: 0.1, height: 0.1 })).toBe(64);
  });

  it('scales the box with the wand size (fit x4 at 400 %, the floor at 25 %)', () => {
    expect(fit(44, 4)).toBe(704);
    expect(fit(44, 0.25)).toBe(ACTOR_CULL_FLOOR_BLOCKS);
    const behavior = shellBehavior('shell', { width: 30, height: 44, length: 20 }) as { 'minecraft:entity': { components: Record<string, any>; component_groups: Record<string, any> } };
    const e = behavior['minecraft:entity'];
    expect(e.components['minecraft:collision_box']).toEqual(box(44));
    for (const pct of SIZE_STEPS.filter(p => p !== 100)) {
      const g = e.component_groups[`craftmatic:size_${pct}`]['minecraft:collision_box'];
      expect(g.width).toBeCloseTo(SHELL_BOX_WIDTH * pct / 100, 3);
      expect(g.height).toBeCloseTo(box(44).height * pct / 100, 2);
    }
    // Without an extent the fallback (10303's height) still sizes the needle off the floor.
    expect(actorCullFit((shellBehavior('shell') as any)['minecraft:entity'].components['minecraft:collision_box'])).toBeCloseTo(176, 0);
  });
});

describe('the collider block', () => {
  it('passes through the Bedrock encoder as a namespaced block with integer states', () => {
    expect(toBedrockBlock(colliderState(3, 16))).toEqual({ name: COLLIDER_BLOCK_ID, states: { 'craftmatic:lo': 3, 'craftmatic:hi': 16 } });
    expect(toBedrockBlock('craftmatic:collider')).toEqual({ name: COLLIDER_BLOCK_ID, states: {} });
  });

  it('defines every lo < hi permutation with a matching collision box and dampens no light', () => {
    const def = colliderBlockDefinition() as { 'minecraft:block': { description: { states: Record<string, { values: { min: number; max: number } }> }; components: Record<string, unknown>; permutations: Array<{ condition: string; components: { 'minecraft:collision_box': { origin: number[]; size: number[] } } }> } };
    const block = def['minecraft:block'];
    expect(block.permutations).toHaveLength(136);
    expect(block.description.states['craftmatic:lo']!.values).toEqual({ min: 0, max: 15 });
    expect(block.description.states['craftmatic:hi']!.values).toEqual({ min: 1, max: 16 });
    const p = block.permutations.find(x => x.condition.includes('== 3 &&') && x.condition.endsWith('== 16'))!;
    expect(p.components['minecraft:collision_box']).toEqual({ origin: [-8, 3, -8], size: [16, 13, 16] });
    expect(block.components['minecraft:light_dampening']).toBe(0);
    expect(block.components['minecraft:selection_box']).toBe(false);
  });

  it('declares an x band at the MIRRORED origin the device reads (quirk block-collision-x-mirrored), and the simulator reads it back where the kit meant', () => {
    // collider_w2 is the kit's x 0..8 band. Pixel GameTest 2026-09-30: a box declared at origin x -8 stood on x 0.5-1.
    const v = COLLIDER_BLOCK_IDS.indexOf('craftmatic:collider_w2');
    const def = colliderBlockDefinition(v) as { 'minecraft:block': { components: { 'minecraft:collision_box': { origin: number[]; size: number[] } } } };
    expect(def['minecraft:block'].components['minecraft:collision_box']).toEqual({ origin: [0, 0, -8], size: [8, 16, 16] });
    // z is not mirrored: collider_w9 is the z 0..8 band and keeps origin z -8.
    const z = colliderBlockDefinition(COLLIDER_BLOCK_IDS.indexOf('craftmatic:collider_w9')) as typeof def;
    expect(z['minecraft:block'].components['minecraft:collision_box']).toEqual({ origin: [-8, 0, -8], size: [16, 16, 8] });
    const types = new BlockTypes();
    types.addDefinition('w2.json', def);
    expect(types.shape('craftmatic:collider_w2', { 'craftmatic:lo': 0, 'craftmatic:hi': 16 }).collision).toEqual([{ x0: 0, y0: 0, z0: 0, x1: 0.5, y1: 1, z1: 1 }]);
  });
});

// ─── The shell through the compiler and the add-on ───────────────────────────

const box6 = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string[] => {
  const q = (a: number[], b: number[], c: number[], d: number[]): string => `4 16 ${[...a, ...b, ...c, ...d].join(' ')}`;
  return [
    q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]), q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
    q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]), q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]),
  ];
};
const LIBRARY: Record<string, string> = {
  '3001': ['0 Brick 2 x 4', ...box6(-40, 40, -24, 0, -20, 20)].join('\n'),
  '3005': ['0 Brick 1 x 1', ...box6(-10, 10, -24, 0, -10, 10)].join('\n'),
  'door': ['0 Door 1 x 2 x 2', ...box6(-10, 10, -48, 0, -3, 3)].join('\n'),
};
const provider = () => createPartGeometryProvider({ fetchPartText: async id => LIBRARY[id.replace(/^.*\//, '')] ?? null });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];

describe('the building shell', () => {
  it('compiles on the grid frame: an LDraw +X, +Z brick lands at +X and, in the world at yaw 0, −Z (grid +Z is LDraw −Z), and every loose piece stays', async () => {
    // Two separate pieces (no clustering may drop the small one): a 2×4 at the origin and a 1×1 far along +X/+Z.
    const bricks: ParsedBrick[] = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0, rot: I },
      { part: '3005.dat', color: 1, x: 300, y: -24, z: 200, rot: I },
    ];
    const geo = await compileLdrawEntityGeometry('shell', 'prop', bricks, { partGeometry: provider(), frame: [...SHELL_FRAME], wholeModel: true, quality: { studFacets: 1 } });
    expect(geo.diagnostics.detached.placements).toBe(0);
    expect(geo.partBoxesLdu).toHaveLength(2);
    const cubes = (geo.value as { 'minecraft:geometry': Array<{ bones: Array<{ cubes: Array<{ origin: number[]; size: number[] }> }> }> })['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes));
    const small = cubes.find(c => Math.abs(c.size[0]! - 6) < 0.01)!;
    const big = cubes.find(c => Math.abs(c.size[0]! - 24) < 0.01)!;
    // SHELL_FRAME is the −Z-nose rotation diag(−1, −1, 1), so render = (−x, −y, z). The JSON mirrors X
    // (Bedrock's left-handed model frame): JSON x = −render x = LDraw x, JSON z = render z = LDraw z.
    // The world at yaw 0 sees render (−x, y, −z) (extraPlacement, Pixel-proven) = LDraw (x, −y, −z):
    // the grid's frame, a proper rotation (det +1). So in the JSON the small brick (LDraw +300, +200)
    // is at LARGER x and LARGER z than the big one; the old −I frame put it at smaller z, which was
    // the mirror the grid used to carry.
    expect(small.origin[0]!).toBeGreaterThan(big.origin[0]!);
    expect(small.origin[2]!).toBeGreaterThan(big.origin[2]!);
    // Higher in LDraw (−24) is higher in the model.
    expect(small.origin[1]!).toBeGreaterThan(big.origin[1]!);
    // Whole-model: no facing warning, no stand rules.
    expect(geo.warnings.some(w => /front\/rear/.test(w))).toBe(false);
    expect(geo.diagnostics.displayDropped.placements).toBe(0);
  });

  it('ships the shell entity, the collider block and collider structure tiles, and keeps the coloured grid for the preview', async () => {
    const grid = new BlockGrid(4, 3, 4);
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) grid.set(x, 0, z, 'minecraft:red_concrete');
    grid.set(1, 1, 1, 'minecraft:oak_door[facing=south,half=lower,hinge=left,open=false,powered=false]');
    grid.set(1, 2, 1, 'minecraft:oak_door[facing=south,half=upper,hinge=left,open=false,powered=false]');
    // On the grid: grid +Z is LDraw −Z, so cell z 2 is LDraw z −2C (colliders are laid from this brick's geometry).
    const bricks: ParsedBrick[] = [{ part: '3001.dat', color: 4, x: 2 * C, y: 0, z: -2 * C, rot: I }];
    const pack = await buildPlayableAddon(grid, { stem: 'shed', label: 'Shed', partGeometry: provider(), shell: { bricks, frame }, pbr: false });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_shed_BP/blocks/collider.json');
    expect(entries).toContain('Craftmatic_shed_RP/blocks.json');
    expect(entries).toContain('Craftmatic_shed_RP/textures/blocks/craftmatic_collider.png');
    expect(entries).toContain('Craftmatic_shed_BP/entities/shed_shell.json');
    expect(entries).toContain('Craftmatic_shed_RP/models/entity/shed_shell.geo.json');
    // The manual-chair tool exists even with no inferred mould seats.
    expect(entries).toContain('Craftmatic_shed_RP/entity/shed_manual_seat.entity.json');
    expect(entries).toContain('Craftmatic_shed_RP/models/entity/craftmatic_seat.geo.json');
    expect(entries).toContain('Craftmatic_shed_RP/textures/entity/craftmatic_seat.png');
    expect(pack.components.some(c => c.kind === 'shell')).toBe(true);
    expect(pack.warnings.some(w => /brick-accurate building/.test(w))).toBe(true);
    // The terrain atlas carries the clear tile.
    const terrain = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/textures/terrain_texture.json'))) as { texture_data: Record<string, unknown> };
    expect(terrain.texture_data['craftmatic_collider']).toEqual({ textures: 'textures/blocks/craftmatic_collider' });
    // The structure tile's palette is colliders plus the door, no concrete.
    const tile = entries.find(e => /structures\/craftmatic\/.*\.mcstructure$/.test(e))!;
    const raw = new TextDecoder('latin1').decode(await extractFile(buffer, tile));
    expect(raw).toContain('craftmatic:collider');
    expect(raw).toContain('minecraft:wooden_door');
    expect(raw).not.toContain('red_concrete');
    // The shell behaviour: static, unhurt, not selectable.
    const behavior = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_BP/entities/shed_shell.json'))) as { 'minecraft:entity': { components: Record<string, any> } };
    expect(behavior['minecraft:entity'].components['minecraft:physics']).toEqual({ has_gravity: false, has_collision: false });
    // The collision box (a needle extending UP from the origin) stands above every drawn cube: the geometry
    // is authored entirely below the origin (its tops are negative, asserted below), so the box can touch
    // nothing a player stands on and its only effect is the cull distance.
    const shellBox = behavior['minecraft:entity'].components['minecraft:collision_box'] as { width: number; height: number };
    expect(shellBox.width).toBe(SHELL_BOX_WIDTH);
    expect(actorCullDistance(shellBox)).toBeGreaterThanOrEqual(ACTOR_CULL_FLOOR_BLOCKS);
    // The placement script spawns it as an actor at yaw 0, its origin lifted one block over the roof
    // (a 24 LDU brick is 0.45 blocks tall → lift 2) so the block that lights it is open sky;
    // the geometry is authored that far below the origin.
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_BP/scripts/placement.js'));
    const shellActor = /\{"typeId":"craftmatic:shed_shell"[^}]*\}/.exec(placement)![0];
    expect(shellActor).toContain('"yaw":0');
    expect(JSON.parse(shellActor).y).toBeCloseTo(2, 5);
    const geo = JSON.parse(new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_shed_RP/models/entity/shed_shell.geo.json'))) as { 'minecraft:geometry': Array<{ description: { visible_bounds_offset: number[] }; bones: Array<{ cubes: Array<{ origin: number[]; size: number[] }> }> }> };
    const tops = geo['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => c.origin[1]! + c.size[1]!)));
    expect(Math.max(...tops)).toBeLessThan(0);
    expect(Math.min(...geo['minecraft:geometry'].flatMap(m => m.bones.flatMap(b => b.cubes.map(c => c.origin[1]!))))).toBeCloseTo(-32, 5);
    expect(geo['minecraft:geometry'][0]!.description.visible_bounds_offset[1]).toBeLessThan(0);
  });

  it('archives an undersized leaf as separate exact geometry at its source-frame origin', async () => {
    const grid = new BlockGrid(5, 4, 5);
    grid.set(2, 0, 2, 'minecraft:red_concrete');
    // Grid +Z is LDraw −Z (the frame is a half turn about X), so cell z 2 is LDraw z −2C.
    const shellBrick: ParsedBrick = { part: '3001.dat', color: 4, x: 2 * C, y: 0, z: -2 * C, rot: I };
    // This non-zero archive placement freezes the source-origin mapping: the
    // leaf floor is one cell up at x=2,z=3 before its open-sky light lift.
    const leaf: ParsedBrick = { part: 'door.dat', color: 6, x: 2 * C, y: -C, z: -3 * C, rot: I };
    const pack = await buildPlayableAddon(grid, {
      stem: 'micro-door', label: 'Micro door', partGeometry: provider(), pbr: false,
      shell: { bricks: [shellBrick], frame },
      leafActors: [{ bricks: [leaf], frame, maxSizeExclusive: 300, doorCandidateIndex: 0, hideAt100: false }],
    });
    const buffer = pack.bytes.buffer.slice(pack.bytes.byteOffset, pack.bytes.byteOffset + pack.bytes.byteLength) as ArrayBuffer;
    const entries = listZipEntries(buffer);
    expect(entries).toContain('Craftmatic_micro_door_BP/entities/micro_door_door_leaf_1.json');
    expect(entries).toContain('Craftmatic_micro_door_RP/models/entity/micro_door_door_leaf_1.geo.json');
    const placement = new TextDecoder().decode(await extractFile(buffer, 'Craftmatic_micro_door_BP/scripts/placement.js'));
    const actor = JSON.parse(/\{"typeId":"craftmatic:micro_door_door_leaf_1"[^}]*\}/.exec(placement)![0]);
    expect(actor).toMatchObject({ x: 2, y: 3, yaw: 0, maxSizeExclusive: 300, doorCandidateIndex: 0, hideAt100: false });
    expect(actor.z).toBeCloseTo(3, 8);
    expect(pack.components.find(c => c.id === 'micro_door_door_leaf_1')?.provenance).toContain('exact source door placement');
  });
});
