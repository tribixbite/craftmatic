/**
 * What a LEGO BUILDING contains that Minecraft can make live: the figures
 * standing in it (minifig NPCs that walk about), the seats (an invisible
 * rideable entity, so a chair can be sat on) and the door leaves (vanilla
 * doors that open, in the opening the leaf occupied).
 *
 * Runs on the placements that are NOT a vehicle component (those carry their
 * own figures through the entity compiler's `extras`). Detection is by the
 * LDraw library's own description line, the same rule part-elements.ts uses
 * for panes and fences: a hand-written id list is stale the day it is written.
 *
 * Doors were REFUSED by the block-element pass (part-elements.ts header) at
 * the old resolutions because a 1×4×6 leaf covered ~5×8 cells. At minifig
 * scale (lego-scale.ts, 53.33 LDU per block) the same leaf is 1.5 × 2.7
 * cells: the leaf's cells become air and a vanilla door (two blocks tall)
 * stands at the bottom of that opening, hinged on the side the mould's
 * origin marks, one door per cell of width. What is left above the door is
 * the transom of a tall LEGO doorway, open. Leaves under two cells tall
 * (cupboard doors, 1×3×1) are left as blocks.
 *
 * Positions come back in LDraw; the pipeline maps them into grid cells with
 * the voxelizer's own `gridOrigin` (`sceneGridPoint`), so an actor lands on
 * the block its part became.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { createPartGeometryProvider, type LdrawPartMesh, type PartGeometryProvider, type Vec3 } from './ldraw-part-geometry.js';
import { groupFigures, isSeat, isTorso, cleanPartId } from './ldraw-entity-compiler.js';
import type { BlockGrid } from '@craft/schem/types.js';

export interface SceneFigure {
  bricks: ParsedBrick[];
  /** Centre of the figure's real bounds, LDraw. */
  centreLdu: Vec3;
  /** Its lowest point (LDraw Y down: the largest y) - the floor it stands on. */
  floorLdu: number;
  /** Torso's local −Z through its placement, horizontal unit (x, z). */
  facingLdu: [number, number];
  /** True when the figure sits on a seat (the seat is then not offered as free). */
  seated: boolean;
}

export interface SceneSeat {
  part: string;
  /** The sitting surface's centre, LDraw. */
  surfaceLdu: Vec3;
  /** Which way a sitter faces: the seat's local −Z (the backrest is at +Z), horizontal unit (x, z). */
  facingLdu: [number, number];
}

export interface SceneDoor {
  part: string;
  description: string;
  color: number;
  /** World AABB of the leaf, LDraw. */
  minLdu: Vec3;
  maxLdu: Vec3;
  /** The horizontal axis the leaf runs along, and which end of it the hinge is on. */
  alongAxis: 'x' | 'z';
  hingeAtMin: boolean;
}

export interface SceneActors {
  figures: SceneFigure[];
  seats: SceneSeat[];
  doors: SceneDoor[];
  /** Every placement that belongs to a figure (to leave out of the block scenery). */
  figureBricks: Set<ParsedBrick>;
  meshes: Map<string, LdrawPartMesh | null>;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const apply = (m: readonly number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
const local = (b: ParsedBrick, v: Vec3): Vec3 => { const r = apply(b.rot ?? IDENTITY, v); return [b.x + r[0], b.y + r[1], b.z + r[2]]; };
const horizontal = (b: ParsedBrick, v: Vec3): [number, number] | null => {
  const r = apply(b.rot ?? IDENTITY, v);
  const h = Math.hypot(r[0], r[2]);
  return h > 0.5 ? [r[0] / h, r[2] / h] : null;
};
function worldBounds(b: ParsedBrick, mesh: LdrawPartMesh): { min: Vec3; max: Vec3 } {
  const { min: lo, max: hi } = mesh.bounds;
  const corners: Vec3[] = [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]],
  ];
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) { const w = local(b, c); for (let i = 0; i < 3; i++) { if (w[i]! < min[i]!) min[i] = w[i]!; if (w[i]! > max[i]!) max[i] = w[i]!; } }
  return { min, max };
}

/** A door LEAF (not a frame, not the glass insert, not a sticker). */
export function isDoorLeafDescription(description: string): boolean {
  const d = description.replace(/^[~=_]+\s*/, '');
  return /^Door\b/i.test(d) && !/\b(Frame|Glass|Sticker|Sliding|Revolving)\b/i.test(d);
}

export async function discoverSceneActors(bricks: ParsedBrick[], provider: PartGeometryProvider = createPartGeometryProvider()): Promise<SceneActors> {
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';

  // Figures: a torso with at least a head or legs beside it.
  const figures: SceneFigure[] = [];
  const figureBricks = new Set<ParsedBrick>();
  for (const g of groupFigures(bricks, meshes)) {
    if (g.parts.length < 3) continue;
    const parts = g.parts.map(i => bricks[i]!);
    const torso = bricks[g.torso]!;
    const facing = horizontal(torso, [0, 0, -1]) ?? [0, -1];
    let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of parts) {
      const m = meshes.get(b.part);
      const box = m && m.triangles.length ? worldBounds(b, m) : { min: [b.x - 10, b.y - 24, b.z - 10] as Vec3, max: [b.x + 10, b.y, b.z + 10] as Vec3 };
      min = [Math.min(min[0], box.min[0]), Math.min(min[1], box.min[1]), Math.min(min[2], box.min[2])];
      max = [Math.max(max[0], box.max[0]), Math.max(max[1], box.max[1]), Math.max(max[2], box.max[2])];
    }
    for (const b of parts) figureBricks.add(b);
    figures.push({ bricks: parts, centreLdu: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], floorLdu: max[1], facingLdu: facing, seated: false });
  }

  // Seats: the sitting surface is one plate above the mould's origin (4079: the
  // origin is under the seat pan). A seat with a figure's torso over it is taken.
  const seats: SceneSeat[] = [];
  for (const b of bricks) {
    if (!isSeat(b.part, desc(b))) continue;
    const surface = local(b, [0, -8, 0]);
    const facing = horizontal(b, [0, 0, -1]) ?? [0, -1];
    const sitter = figures.find(f => { const t = f.bricks.find(p => isTorso(p.part, desc(p)))!; return Math.hypot(t.x - surface[0], t.z - surface[2]) <= 30 && t.y <= surface[1] && t.y >= surface[1] - 60; });
    if (sitter) { sitter.seated = true; continue; }
    seats.push({ part: cleanPartId(b.part), surfaceLdu: surface, facingLdu: facing });
  }

  // Door leaves.
  const doors: SceneDoor[] = [];
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (!m || !m.triangles.length || !isDoorLeafDescription(m.description)) continue;
    const box = worldBounds(b, m);
    const dx = box.max[0] - box.min[0], dz = box.max[2] - box.min[2];
    const alongAxis: 'x' | 'z' = dx >= dz ? 'x' : 'z';
    // The hinge is the end of the leaf nearest the mould's origin (every LDraw door leaf: measured 2026-09-16).
    const o = alongAxis === 'x' ? b.x : b.z;
    const lo = alongAxis === 'x' ? box.min[0] : box.min[2], hi = alongAxis === 'x' ? box.max[0] : box.max[2];
    doors.push({ part: cleanPartId(b.part), description: m.description, color: b.color, minLdu: box.min, maxLdu: box.max, alongAxis, hingeAtMin: Math.abs(o - lo) <= Math.abs(o - hi) });
  }
  return { figures, seats, doors, figureBricks, meshes };
}

/** The voxelizer's grid frame (`VoxelizeResult.gridOrigin`). */
export interface SceneGridFrame { x: number; y: number; z: number; scale: number; cellXZ: number; cellY: number }

/** An LDraw point in grid coordinates (fractional cells; LDraw Y down → grid Y up). */
export function sceneGridPoint(frame: SceneGridFrame, p: Vec3): Vec3 {
  return [(p[0] / frame.cellXZ - frame.x) * frame.scale, (-p[1] / frame.cellY - frame.y) * frame.scale, (p[2] / frame.cellXZ - frame.z) * frame.scale];
}

/** Bedrock yaw (degrees; 0 faces +Z, forward = (−sin, cos)) for a horizontal LDraw direction. Grid axes are LDraw's. */
export function yawForFacing(f: [number, number]): number {
  return normaliseYaw(Math.atan2(-f[0] || 0, f[1]) * 180 / Math.PI);
}

/** Round to a tenth of a degree in (−180, 180], never −0. */
export function normaliseYaw(deg: number): number {
  let yaw = Math.round(deg * 10) / 10;
  while (yaw <= -180) yaw += 360;
  while (yaw > 180) yaw -= 360;
  return yaw === 0 ? 0 : yaw;
}

/** Door wood by the leaf's LDraw colour: the nearest vanilla door in tone. */
export function doorBlockForColor(color: number): string {
  if ([0, 8, 72, 308, 26].includes(color)) return 'minecraft:dark_oak_door';
  if ([6, 70, 89, 84].includes(color)) return 'minecraft:spruce_door';
  if ([15, 1, 73, 212, 9].includes(color)) return 'minecraft:birch_door';
  if ([19, 28, 14, 191, 226, 78].includes(color)) return 'minecraft:bamboo_door';
  if ([4, 320, 216, 27].includes(color)) return 'minecraft:mangrove_door';
  if ([25, 182, 462].includes(color)) return 'minecraft:acacia_door';
  if ([2, 288, 10, 27, 378].includes(color)) return 'minecraft:warped_door';
  if ([5, 13, 29, 30, 322].includes(color)) return 'minecraft:cherry_door';
  if ([7, 71, 135, 179, 80].includes(color)) return 'minecraft:iron_door';
  return 'minecraft:oak_door';
}

export interface DoorPlacementStats { doors: number; leavesCleared: number; skippedSmall: number; skippedOutside: number }

/**
 * Cut each door leaf out of the block scenery and stand vanilla doors in the
 * opening. Facing is the leaf's thin axis toward the positive side; `hinge`
 * is judged the way Minecraft does, from the side the door faces: for a door
 * facing south (viewer south of it looking north) the viewer's left is west.
 * A leaf two or more cells wide gets one door per cell, outer hinges, so the
 * pair opens like double doors.
 */
export function applySceneDoors(grid: BlockGrid, doors: SceneDoor[], frame: SceneGridFrame): DoorPlacementStats {
  const stats: DoorPlacementStats = { doors: 0, leavesCleared: 0, skippedSmall: 0, skippedOutside: 0 };
  for (const d of doors) {
    const a = sceneGridPoint(frame, d.minLdu), b = sceneGridPoint(frame, d.maxLdu);
    // Along the leaf and up: every cell it straddles. Across its thickness (6 LDU,
    // often astride a cell boundary): the one cell its centre line is in.
    const span = (lo: number, hi: number): [number, number] => [Math.floor(Math.min(lo, hi) + 0.02), Math.floor(Math.max(lo, hi) - 0.02)];
    const thin = (lo: number, hi: number): [number, number] => { const c = Math.floor((lo + hi) / 2); return [c, c]; };
    /**
     * Along the leaf: as many cells as the leaf is wide (a 1.5-cell leaf is
     * two doors, a 1.1-cell leaf one), taken where it covers the most. A leaf
     * that straddles three cells does NOT get three doors: the sliver it
     * leaves in the third cell stays wall.
     */
    const along = (lo: number, hi: number): [number, number] => {
      const min = Math.min(lo, hi), max = Math.max(lo, hi);
      // A 1×4 LEGO door is 80 LDU = 1.5 cells: two doors (the float lands a hair under 1.5).
      const count = Math.max(1, Math.round(max - min + 0.05));
      const first = Math.floor(min), last = Math.floor(max - 0.02);
      let best = first, bestCover = -1;
      for (let start = first; start + count - 1 <= last; start++) {
        const cover = Math.min(max, start + count) - Math.max(min, start);
        if (cover > bestCover) { bestCover = cover; best = start; }
      }
      return [best, best + count - 1];
    };
    const [x0, x1] = d.alongAxis === 'x' ? along(a[0], b[0]) : thin(a[0], b[0]);
    const [y0, y1] = span(a[1], b[1]);
    const [z0, z1] = d.alongAxis === 'z' ? along(a[2], b[2]) : thin(a[2], b[2]);
    if (y1 - y0 + 1 < 2) { stats.skippedSmall++; continue; }
    if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= grid.width || y1 >= grid.height || z1 >= grid.length) { stats.skippedOutside++; continue; }
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { grid.set(x, y, z, 'minecraft:air'); stats.leavesCleared++; }
    const block = doorBlockForColor(d.color);
    // Thin axis = the one the leaf does NOT run along; the door faces its positive side.
    const facing = d.alongAxis === 'x' ? 'south' : 'east';
    // Cells across the opening, ordered from the viewer's LEFT (facing south: west→east; facing east: south→north).
    const cells: Array<{ x: number; z: number }> = [];
    if (d.alongAxis === 'x') for (let x = x0; x <= x1; x++) cells.push({ x, z: z0 });
    else for (let z = z1; z >= z0; z--) cells.push({ x: x0, z });
    const hingeLeft = (i: number): boolean => {
      if (cells.length >= 2) return i < cells.length / 2; // double doors: outer hinges
      // Single door: the hinge end the mould marks, seen from the facing side.
      const hingeAtLeftEnd = d.alongAxis === 'x' ? d.hingeAtMin : !d.hingeAtMin;
      return hingeAtLeftEnd;
    };
    cells.forEach((c, i) => {
      const hinge = hingeLeft(i) ? 'left' : 'right';
      grid.set(c.x, y0, c.z, `${block}[facing=${facing},half=lower,hinge=${hinge},open=false,powered=false]`);
      grid.set(c.x, y0 + 1, c.z, `${block}[facing=${facing},half=upper,hinge=${hinge},open=false,powered=false]`);
      stats.doors++;
    });
  }
  return stats;
}
