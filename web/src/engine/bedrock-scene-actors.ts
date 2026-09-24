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
 *
 * A figure becomes an NPC only when the source stood it (near) upright. A
 * Bedrock entity has a yaw and a head pitch and no roll: the rig re-poses
 * every figure standing, so a torso the source pitched or laid over cannot be
 * reproduced by an actor at all. 10303's three drop-track riders sit
 * nose-down at 90° in a vertical train; as NPCs they stood bolt upright,
 * anchored at their cluster's lowest point (their hanging hands), straddling
 * the car in mid-air (Pixel 8 Pro, 2026-09-21). Such a figure now stays in
 * the build's geometry at its exact source pose (`posedFigures`), reported in
 * `warnings`, never silently dropped.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { createPartGeometryProvider, type LdrawPartMesh, type PartGeometryProvider, type Vec3 } from './ldraw-part-geometry.js';
import { figureRole, groupFigures, isSeat, cleanPartId } from './ldraw-entity-compiler.js';
import { assembleMinifig, figureAnchor } from './minifig-rig.js';
import type { BlockGrid } from '@craft/schem/types.js';
import { LDU_PER_BLOCK, PLAYER_HEIGHT_BLOCKS } from './lego-scale.js';
import { toBedrockBlock } from './bedrock-blocks.js';
import { ACCESS_SCALE_STEPS, JUMP_HEIGHT_BLOCKS, PASSAGE_HEIGHT_BLOCKS, PASSAGE_WIDTH_BLOCKS, accessStepFor, passageRequiredScale } from './addon-scale.js';

export interface SceneFigure {
  bricks: ParsedBrick[];
  /** Centre of the figure's real bounds, LDraw. */
  centreLdu: Vec3;
  /**
   * The lowest point of its BODY (torso, head, hips, legs; LDraw Y down: the
   * largest y) - the floor it stands on. Held and worn parts are left out: a
   * pushbroom reaching 12 LDU under the feet would otherwise hang the figure.
   */
  floorLdu: number;
  /** Torso's local −Z through its placement, horizontal unit (x, z). */
  facingLdu: [number, number];
  /** Angle between the torso's up axis and world up, degrees (0 = standing straight). */
  tiltDeg: number;
  /** True when the figure sits on a seat. */
  seated: boolean;
  /** Index into `seats` of the seat it sits on: it spawns riding that seat's entity. */
  seatIndex?: number;
}

/**
 * The widest lean an upright NPC can stand in for. The rig discards the
 * torso's lean anyway, so a figure within this angle reads as standing;
 * beyond it the source posed something an actor cannot show (lying, hanging,
 * riding a vertical drop) and the figure keeps its exact pose in the geometry.
 */
export const FIGURE_UPRIGHT_MAX_TILT_DEG = 30;

/** A figure the source posed off upright: kept in the build's geometry, not spawned. */
export interface ScenePosedFigure {
  bricks: ParsedBrick[];
  /** Angle between the torso's up axis and world up, degrees. */
  tiltDeg: number;
  /** Centre of the figure's real bounds, LDraw. */
  centreLdu: Vec3;
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
  /** Source placement, retained so only viable leaves are removed from the shell. */
  brick?: ParsedBrick;
  /** World AABB of the leaf, LDraw. */
  minLdu: Vec3;
  maxLdu: Vec3;
  /** The horizontal axis the leaf runs along, and which end of it (in LDRAW coordinates) the hinge is on. */
  alongAxis: 'x' | 'z';
  hingeAtMin: boolean;
  /**
   * Across the leaf (its thin axis), the extent of the frame it hangs in - a
   * 20 LDU wall straddling a cell boundary is TWO blocks thick, and a door
   * cut only from the leaf's own cell sat entombed in the other half (every
   * museum door on the Pixel, 2026-09-16). Absent when no frame encloses it.
   */
  frameAcrossLdu?: [number, number];
  /**
   * How far the leaf's own width axis is turned off the nearest grid axis,
   * degrees (0 = square to the grid, 45 = diagonal). A vanilla door can only
   * stand square, so a leaf past `DOOR_MAX_OFF_GRID_DEG` is not hung (see there).
   */
  offGridDeg?: number;
}

/**
 * The most a door leaf may be turned off the grid and still be replaced by a
 * vanilla door. 76417 Gringotts' bank sits on its rock at a 44.8 degree turn
 * (the set's own final page), so two of its leaves stand at 45 degrees: a
 * square vanilla door cut into a diagonal wall faced along neither, sat half
 * out of the wall and read as a door "turned wrong" (device report
 * 2026-09-24). Such a leaf now stays the exact LEGO geometry of the shell. The
 * bank's front doors, 8.1 degrees off, still hang: 20 degrees is where a
 * block-wide door stops overlapping its own leaf by most of its width.
 */
export const DOOR_MAX_OFF_GRID_DEG = 20;

export interface SceneActors {
  figures: SceneFigure[];
  /** Figures beyond `FIGURE_UPRIGHT_MAX_TILT_DEG`: they stay in the geometry (their bricks are NOT in `figureBricks`). */
  posedFigures: ScenePosedFigure[];
  seats: SceneSeat[];
  doors: SceneDoor[];
  /** Every placement that belongs to a spawned figure (to leave out of the block scenery). */
  figureBricks: Set<ParsedBrick>;
  /** What the scene could not make live and why, for the export's warning list. */
  warnings: string[];
  /** Every door LEAF placement (a vanilla door stands in for it, so a brick shell leaves it out). */
  doorBricks: Set<ParsedBrick>;
  meshes: Map<string, LdrawPartMesh | null>;
  /**
   * The model's underside, LDraw (the largest world y over every placement
   * that is not a spawned figure): the plane the brick shell is grounded on
   * and the wand pins to. Heights the pack ships (figures, seats) are measured
   * up from it (`sceneFloorPoint`), NOT from the voxel grid's row 0, whose
   * bottom the voxelizer's surface pass rounds up to half a cell above a thin
   * baseplate (the chalet's 7 figures spawned at −0.15 blocks, one plate under
   * the pin plane, 2026-09-21). NaN when the model has no placements.
   */
  groundLdu: number;
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
/**
 * How far a placement's up axis (local −Y, LDraw Y down) leans from world up,
 * degrees. The cosine is the matrix's middle element, normalised so Studio's
 * 0.999988-scaled rotations and a mirrored axis still give a real angle.
 */
export function tiltDegOf(rot: readonly number[] | undefined): number {
  const m = rot ?? IDENTITY;
  const len = Math.hypot(m[1]!, m[4]!, m[7]!) || 1;
  const cos = Math.max(-1, Math.min(1, m[4]! / len));
  return Math.round(Math.acos(cos) * 180 / Math.PI * 10) / 10;
}
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

/**
 * A piece of furniture a figure sits on that is not a minifig seat mould: the
 * library's own chairs, benches, stools, thrones and sofas (Fabuland's among
 * them). LEGO's modern chairs are brick-built and have no such mould; the
 * Brick Wand's "Add seat here" marks those by hand.
 */
export function isFurnitureSeat(description: string): boolean {
  const d = description.replace(/^[~=_]+\s*/, '');
  return /^(Minifig |Fabuland |Duplo )?(Chair|Bench|Stool|Toilet|Throne|Sofa|Couch|Armchair)\b/i.test(d) && !/\b(Holder|Sticker|Pattern)\b/i.test(d);
}

/** A door LEAF (not a frame, not the glass insert, not a sticker). */
export function isDoorLeafDescription(description: string): boolean {
  const d = description.replace(/^[~=_]+\s*/, '');
  // 60616's unofficial file is described "GLASS DOOR FOR FRAME 1X4X6 (Needs Work)": a leaf, not the glass insert.
  if (/^GLASS DOOR\b/i.test(d)) return true;
  return /^Door\b/i.test(d) && !/\b(Frame|Glass|Sticker|Sliding|Revolving)\b/i.test(d);
}

export async function discoverSceneActors(bricks: ParsedBrick[], provider: PartGeometryProvider = createPartGeometryProvider()): Promise<SceneActors> {
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';

  // Figures: a torso with at least a head or legs beside it.
  const figures: SceneFigure[] = [];
  const posedFigures: ScenePosedFigure[] = [];
  const figureBricks = new Set<ParsedBrick>();
  const warnings: string[] = [];
  for (const g of groupFigures(bricks, meshes)) {
    if (g.parts.length < 3) continue;
    const parts = g.parts.map(i => bricks[i]!);
    // Statues and busts stay in the blocks (figureRole).
    if (figureRole(parts, meshes) !== 'npc') continue;
    const torso = bricks[g.torso]!;
    const facing = horizontal(torso, [0, 0, -1]) ?? [0, -1];
    let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const b of parts) {
      const m = meshes.get(b.part);
      const box = m && m.triangles.length ? worldBounds(b, m) : { min: [b.x - 10, b.y - 24, b.z - 10] as Vec3, max: [b.x + 10, b.y, b.z + 10] as Vec3 };
      min = [Math.min(min[0], box.min[0]), Math.min(min[1], box.min[1]), Math.min(min[2], box.min[2])];
      max = [Math.max(max[0], box.max[0]), Math.max(max[1], box.max[1]), Math.max(max[2], box.max[2])];
    }
    let centreLdu: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const tiltDeg = tiltDegOf(torso.rot);
    // An actor stands upright whatever the source did: a figure posed past the
    // limit keeps its whole cluster (legs, hair, held items) in the geometry.
    if (tiltDeg > FIGURE_UPRIGHT_MAX_TILT_DEG) { posedFigures.push({ bricks: parts, tiltDeg, centreLdu }); continue; }
    for (const b of parts) figureBricks.add(b);
    // The floor is where the ASSEMBLED figure's feet are — the rig's own feet
    // level under the frame it settled on — not the lowest source body part:
    // a converted source can put the torso itself at a raw origin (76417's
    // big-fig, 70 LDU low), and its bounds would have sunk Hagrid to his
    // shoulders. The rig re-anchors the frame on the limbs' consensus, so the
    // centre follows the same move.
    const assembled = assembleMinifig(parts, meshes);
    const feet = local(torso, [0, assembled.feetY, 0]);
    const floorLdu = assembled.torso.position[1] + (feet[1] - torso.y);
    if (assembled.reanchoredLdu) {
      const shift = local(torso, assembled.reanchoredLdu);
      centreLdu = [centreLdu[0] + shift[0] - torso.x, centreLdu[1] + shift[1] - torso.y, centreLdu[2] + shift[2] - torso.z];
    }
    figures.push({ bricks: parts, centreLdu, floorLdu, facingLdu: facing, tiltDeg, seated: false });
  }
  if (posedFigures.length) {
    const tilts = posedFigures.map(p => `${p.tiltDeg}°`).join(', ');
    warnings.push(`${posedFigures.length} figure${posedFigures.length === 1 ? '' : 's'} the source posed off upright (torso tilt ${tilts}, over ${FIGURE_UPRIGHT_MAX_TILT_DEG}°) stay${posedFigures.length === 1 ? 's' : ''} in the build's geometry at the exact source pose instead of walking: a Bedrock entity stands upright (yaw only, no roll), so a pitched or lying rider cannot be an NPC.`);
  }

  // Seats: the sitting surface is one plate above the mould's origin (4079: the
  // origin is under the seat pan). Other furniture moulds (a Fabuland chair or
  // bench, a stool, a throne) sit on the top of their own box. A seat with a
  // figure's torso over it is taken.
  const seats: SceneSeat[] = [];
  for (const b of bricks) {
    const isMouldSeat = isSeat(b.part, desc(b));
    if (!isMouldSeat && !isFurnitureSeat(desc(b))) continue;
    const bm = meshes.get(b.part);
    const surface = isMouldSeat || !bm || !bm.triangles.length
      ? local(b, [0, -8, 0])
      : local(b, [(bm.bounds.min[0] + bm.bounds.max[0]) / 2, bm.bounds.min[1], (bm.bounds.min[2] + bm.bounds.max[2]) / 2]);
    const facing = horizontal(b, [0, 0, -1]) ?? [0, -1];
    // The figure's torso, or the head standing in for a lost one (`figureAnchor`), at the head's offset.
    const sitter = figures.find(f => f.seatIndex === undefined && (() => {
      const root = figureAnchor(f.bricks, meshes);
      if (!root) return false;
      const t = f.bricks[root.index]!;
      const y = root.headless ? t.y + (root.system === 'minidoll' ? 33.2 : 24) : t.y;
      return Math.hypot(t.x - surface[0], t.z - surface[2]) <= 30 && y <= surface[1] && y >= surface[1] - 60;
    })());
    seats.push({ part: cleanPartId(b.part), surfaceLdu: surface, facingLdu: facing });
    // A figure the source sat here rides this seat's entity (the seat stays, occupied).
    if (sitter) { sitter.seated = true; sitter.seatIndex = seats.length - 1; }
  }

  // Door leaves, and the frames they hang in.
  const frames: Array<{ min: Vec3; max: Vec3 }> = [];
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (m && m.triangles.length && /^[~=_]*\s*Door\b.*\bFrame\b/i.test(m.description)) frames.push(worldBounds(b, m));
  }
  const doors: SceneDoor[] = [];
  const doorBricks = new Set<ParsedBrick>();
  for (const b of bricks) {
    const m = meshes.get(b.part);
    if (!m || !m.triangles.length || !isDoorLeafDescription(m.description)) continue;
    doorBricks.add(b);
    const box = worldBounds(b, m);
    // The leaf's WIDTH axis is its longer local horizontal axis, turned by the
    // placement: judged from the part's own frame, not from its world AABB,
    // which is square for a leaf at 45 degrees and says nothing about it.
    const R = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const localX = m.bounds.max[0] - m.bounds.min[0], localZ = m.bounds.max[2] - m.bounds.min[2];
    const col = localX >= localZ ? 0 : 2;
    const wx = R[col]!, wz = R[6 + col]!;
    const fromX = Math.atan2(Math.abs(wz), Math.abs(wx)) * 180 / Math.PI;
    const offGridDeg = Math.round(Math.min(fromX, 90 - fromX) * 10) / 10;
    const alongAxis: 'x' | 'z' = Math.hypot(wx, wz) > 1e-6 ? (fromX <= 45 ? 'x' : 'z') : (box.max[0] - box.min[0] >= box.max[2] - box.min[2] ? 'x' : 'z');
    // The hinge is the end of the leaf nearest the mould's origin (every LDraw door leaf: measured 2026-09-16).
    const o = alongAxis === 'x' ? b.x : b.z;
    const lo = alongAxis === 'x' ? box.min[0] : box.min[2], hi = alongAxis === 'x' ? box.max[0] : box.max[2];
    const centre: Vec3 = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
    const frame = frames.find(f => centre[0] >= f.min[0] - 4 && centre[0] <= f.max[0] + 4 && centre[1] >= f.min[1] - 4 && centre[1] <= f.max[1] + 4 && centre[2] >= f.min[2] - 4 && centre[2] <= f.max[2] + 4);
    const across: [number, number] | undefined = frame ? (alongAxis === 'x' ? [frame.min[2], frame.max[2]] : [frame.min[0], frame.max[0]]) : undefined;
    doors.push({ part: cleanPartId(b.part), description: m.description, color: b.color, brick: b, minLdu: box.min, maxLdu: box.max, alongAxis, hingeAtMin: Math.abs(o - lo) <= Math.abs(o - hi), ...(across ? { frameAcrossLdu: across } : {}), offGridDeg });
  }
  let groundLdu = -Infinity;
  for (const b of bricks) {
    if (figureBricks.has(b)) continue;
    const m = meshes.get(b.part);
    const bottom = m && m.triangles.length ? worldBounds(b, m).max[1] : b.y;
    if (bottom > groundLdu) groundLdu = bottom;
  }
  return { figures, posedFigures, seats, doors, figureBricks, doorBricks, meshes, warnings, groundLdu: Number.isFinite(groundLdu) ? groundLdu : NaN };
}

/** The voxelizer's grid frame (`VoxelizeResult.gridOrigin`). */
export interface SceneGridFrame { x: number; y: number; z: number; scale: number; cellXZ: number; cellY: number }

/**
 * An LDraw point in grid coordinates (fractional cells). The grid is LDraw
 * turned half a turn about X: `(x, −y, −z)` per cell size, then the grid
 * origin — the SAME frame `ldraw-geometry.ts` `rasterizeTriangles` fills the
 * blocks in, so an actor lands on the block its part became. LDraw Y down is
 * grid Y up, and LDraw −Z (the model's front) is grid +Z (south). A Y-only
 * flip would be a mirror (det −1): that was the grid until 2026-09-22.
 */
export function sceneGridPoint(frame: SceneGridFrame, p: Vec3): Vec3 {
  return [(p[0] / frame.cellXZ - frame.x) * frame.scale, (-p[1] / frame.cellY - frame.y) * frame.scale, (-p[2] / frame.cellXZ - frame.z) * frame.scale];
}

/**
 * An LDraw point in grid coordinates whose HEIGHT is measured up from the
 * model's underside (`SceneActors.groundLdu`, the pin plane the shell and the
 * colliders stand on) instead of the voxel grid's row-0 bottom. Use it for
 * anything an actor stands or sits on: feet on a baseplate's top land at
 * +0.15 blocks (one plate), feet on the ground beside the model at 0.
 * Doors keep `sceneGridPoint`: they are cut into the block grid itself.
 */
export function sceneFloorPoint(frame: SceneGridFrame, groundLdu: number, p: Vec3): Vec3 {
  const g = sceneGridPoint(frame, p);
  return [g[0], Number.isFinite(groundLdu) ? (groundLdu - p[1]) / frame.cellY * frame.scale : g[1], g[2]];
}

/**
 * Bedrock yaw (degrees; 0 faces +Z, forward = (−sin, cos)) for a horizontal
 * LDraw direction (x, z). World Z is LDraw −Z (`sceneGridPoint`), so the
 * world direction is (x, −z): a figure facing LDraw −Z (the front) faces
 * world +Z, yaw 0.
 */
export function yawForFacing(f: [number, number]): number {
  return normaliseYaw(Math.atan2(-f[0] || 0, -f[1]) * 180 / Math.PI);
}

/**
 * Whether a door leaf's hinge is at the grid-MIN end of its axis. `hingeAtMin`
 * is measured in LDraw; along X the axes agree, along Z the grid runs the
 * other way (`sceneGridPoint`), so the LDraw-min end is the grid-max end.
 */
const hingeAtGridMin = (d: Pick<SceneDoor, 'alongAxis' | 'hingeAtMin'>): boolean => d.alongAxis === 'x' ? d.hingeAtMin : !d.hingeAtMin;

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

export interface DoorPlacementStats {
  doors: number; leavesCleared: number; skippedSmall: number; skippedOutside: number;
  /** Solid cells opened across the doorway so a door can be reached from a room within three cells. */
  passageCleared: number;
  /** Doors with no air within three cells on either side (deep inside a solid mass): left as they are. */
  unreachable: number;
}

/** A measured export-scale recommendation for real, semantic LDraw door leaves. */
export interface DoorScaleRecommendation {
  /** The smallest leaf height found, before the model-scale multiplier. */
  shortestLeafLdu: number;
  /** The smallest multiplier that gives a player-height, two-block vanilla opening. */
  requiredScale: number;
  /** The first supported export scale at or above `requiredScale`, if any. */
  recommendedScale?: number;
  /** Why the wand must not promise that its runtime Size button can fix this. */
  note: string;
}

const EXPORT_SCALE_STEPS = ACCESS_SCALE_STEPS;
export const WAND_SIZE_STEPS = [25, 50, 75, 100, 150, 200, 300, 400] as const;

/** A semantic leaf retained for the wand when it is too small at 100%. */
export interface RuntimeDoorCandidate {
  /** Model-local lower-door point in the exported block grid. */
  x: number; y: number; z: number;
  /** First supported wand factor that gives the leaf a two-block opening. */
  requiredSize: number;
  lower: { id: string; states: Record<string, string | number | boolean> };
  upper: { id: string; states: Record<string, string | number | boolean> };
}

/**
 * Retain a real leaf's measured opening for runtime resizing. This is deliberately
 * leaf-only: an arbitrary brick gap is not enough evidence to add a door.
 */
export function runtimeDoorCandidates(doors: readonly SceneDoor[], frame: SceneGridFrame): RuntimeDoorCandidate[] {
  const out: RuntimeDoorCandidate[] = [];
  const seen = new Set<string>();
  for (const d of doors) {
    const a = sceneGridPoint(frame, d.minLdu), b = sceneGridPoint(frame, d.maxLdu);
    const height = Math.abs(b[1] - a[1]);
    const width = d.alongAxis === 'x' ? Math.abs(b[0] - a[0]) : Math.abs(b[2] - a[2]);
    // A usable vanilla leaf needs both its two-block headroom and a full
    // block across; height-only scaling can otherwise hang a door through a
    // sub-block slit. The remaining leaf cell is deliberately the only block
    // cleared: source door bricks were excluded from the collider shell.
    const requiredSize = WAND_SIZE_STEPS.find(size => size >= 100 && height * size / 100 >= 2 && width * size / 100 >= 1);
    if (!requiredSize) continue;
    const x = (a[0] + b[0]) / 2, z = (a[2] + b[2]) / 2;
    // LDraw Y is down; the lower edge maps to the smaller grid Y.
    // Keep the physical edge fractional until worldPoint applies the wand
    // factor. Flooring here magnifies the error (1.8 × 3 must land at 5.4,
    // not floor(1.8) × 3 = 3) and moves upper-storey doors off their floors.
    const y = Math.min(a[1], b[1]);
    const key = `${x.toFixed(3)}:${y}:${z.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const facing = d.alongAxis === 'x' ? 'south' : 'east';
    const hinge = hingeAtGridMin(d) === (d.alongAxis === 'x') ? 'left' : 'right';
    const block = doorBlockForColor(d.color);
    const lower = toBedrockBlock(`${block}[facing=${facing},half=lower,hinge=${hinge},open=false,powered=false]`);
    const upper = toBedrockBlock(`${block}[facing=${facing},half=upper,hinge=${hinge},open=false,powered=false]`);
    if (!lower || !upper) continue;
    out.push({ x, y, z, requiredSize, lower: { id: lower.name, states: lower.states }, upper: { id: upper.name, states: upper.states } });
  }
  return out;
}

/**
 * Measure whether genuine LDraw door leaves can become usable vanilla doors.
 *
 * A Minecraft player is 1.8 blocks high, but a vanilla door always needs a
 * two-block opening. This recommends an export scale for doors at 100%; the
 * separate runtime candidates measure each leaf against the exported grid
 * and allow the wand to replace leaf actors at an eligible larger size.
 */
export function recommendDoorExportScale(doors: readonly SceneDoor[]): DoorScaleRecommendation | null {
  if (!doors.length) return null;
  const shortestLeafLdu = Math.min(...doors.map(d => Math.abs(d.maxLdu[1] - d.minLdu[1])));
  const openingBlocks = Math.max(2, PLAYER_HEIGHT_BLOCKS);
  const requiredScale = Math.max(...doors.map(d => Math.max(
    openingBlocks * LDU_PER_BLOCK / Math.abs(d.maxLdu[1] - d.minLdu[1]),
    LDU_PER_BLOCK / Math.abs(d.maxLdu[d.alongAxis === 'x' ? 0 : 2] - d.minLdu[d.alongAxis === 'x' ? 0 : 2]),
  )));
  const recommendedScale = EXPORT_SCALE_STEPS.find(scale => scale + 1e-9 >= requiredScale);
  const roundedRequired = Math.ceil(requiredScale * 100) / 100;
  if (!recommendedScale) return {
    shortestLeafLdu, requiredScale,
    note: `Shortest real door leaf is ${shortestLeafLdu} LDU: it needs ${roundedRequired}× minifig export scale for a ${openingBlocks}-block player opening, above the supported 4× export scale. No usable door is claimed.`,
  };
  return {
    shortestLeafLdu, requiredScale, recommendedScale,
    note: `Shortest real door leaf is ${shortestLeafLdu} LDU: export at ${recommendedScale}× minifig scale if every door must work at 100% (requires ${roundedRequired}×). Brick Wand sizes can otherwise swap exact semantic leaf geometry for vanilla doors at measured thresholds up to 400%.`,
  };
}

/**
 * Cut each door leaf out of the block scenery and stand vanilla doors in the
 * opening. Facing is the leaf's thin axis toward the positive side; `hinge`
 * is judged the way Minecraft does, from the side the door faces: for a door
 * facing south (viewer south of it looking north) the viewer's left is west.
 * A leaf two or more cells wide gets one door per cell, outer hinges, so the
 * pair opens like double doors.
 */
export function applySceneDoors(grid: BlockGrid, doors: SceneDoor[], frame: SceneGridFrame, hungDoors?: Set<SceneDoor>, clearedCells?: Set<number>): DoorPlacementStats {
  // Every cell this pass opens (leaf and passage), so the collider builder
  // (bedrock-building-shell.ts `keepClear`) does not wall it up again from
  // the frame's or the facade's geometry.
  const clear = (x: number, y: number, z: number): void => { grid.set(x, y, z, 'minecraft:air'); clearedCells?.add((x * grid.height + y) * grid.length + z); };
  const stats: DoorPlacementStats = { doors: 0, leavesCleared: 0, skippedSmall: 0, skippedOutside: 0, passageCleared: 0, unreachable: 0 };
  // Converted sources sometimes retain an overlapping leaf placement beside
  // the visible one. A Bedrock door occupies one lower-cell coordinate, so
  // placing both used to count two doors while silently overwriting the first
  // block state (and could turn a double doorway into a duplicate single one).
  const hungCells = new Set<string>();
  for (const d of doors) {
    const a = sceneGridPoint(frame, d.minLdu), b = sceneGridPoint(frame, d.maxLdu);
    const physicalHeight = Math.abs(b[1] - a[1]);
    const physicalWidth = d.alongAxis === 'x' ? Math.abs(b[0] - a[0]) : Math.abs(b[2] - a[2]);
    // Cell straddling is not physical clearance. A narrow/tiny leaf can touch
    // two voxel cells while remaining less than one block wide or two high;
    // that leaf stays exact source geometry until a measured wand threshold.
    if (physicalHeight + 1e-9 < 2 || physicalWidth + 1e-9 < 1) { stats.skippedSmall++; continue; }
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
    let [y0, y1] = span(a[1], b[1]);
    const [z0, z1] = d.alongAxis === 'z' ? along(a[2], b[2]) : thin(a[2], b[2]);
    if (y1 - y0 + 1 < 2) { stats.skippedSmall++; continue; }
    if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= grid.width || y1 >= grid.height || z1 >= grid.length) { stats.skippedOutside++; continue; }
    // Outside the model is the open world: a door on the outer wall opens onto it.
    const cellAt = (x: number, y: number, z: number): string => (x < 0 || z < 0 || y < 0 || x >= grid.width || z >= grid.length || y >= grid.height) ? 'minecraft:air' : grid.get(x, y, z);
    const acrossAt = (k: number): [number, number] => d.alongAxis === 'x' ? [x0, z0 + k] : [x0 + k, z0];
    const airAcross = (y: number): number => { let n = 0; for (const k of [-3, -2, -1, 1, 2, 3]) { const [x, z] = acrossAt(k); if (cellAt(x, y, z) === 'minecraft:air') n++; } return n; };
    // Floor-ness is judged on cells INSIDE the grid only (an exterior door's outside is air by definition).
    const solidAcrossInGrid = (y: number): boolean => { for (const k of [-3, -2, -1, 1, 2, 3]) { const [x, z] = acrossAt(k); if (x < 0 || z < 0 || x >= grid.width || z >= grid.length) continue; if (grid.get(x, y, z) === 'minecraft:air') return false; } return true; };
    // A leaf that starts inside the FLOOR's cell (an 8 LDU baseplate makes its
    // whole 53 LDU cell solid, and the leaf sits on that plate) reads its
    // bottom cell as the floor row: every neighbour across is solid there and
    // air begins one cell up. The door then hangs one cell up, on the floor,
    // instead of replacing the floor and popping off - the museum on the Pixel.
    if (solidAcrossInGrid(y0) && airAcross(y0 + 1) > 0 && y1 > y0 + 1) y0 += 1;
    // The door must rest on a block: a leaf whose bottom edge reads just above the
    // floor cell sits one cell up, and a Bedrock door over air pops off (3 of 6
    // museum doors on the Pixel). Step down onto the first solid cell, at most one.
    const solidBelow = (y: number): boolean => y - 1 < 0 || cellAt(x0, y - 1, z0) !== 'minecraft:air';
    if (!solidBelow(y0) && y0 - 1 >= 0 && solidBelow(y0 - 1)) { y0 -= 1; y1 = Math.max(y1, y0 + 1); }
    if (!solidBelow(y0)) { stats.skippedOutside++; continue; }
    // The passage across the doorway: every cell the FRAME straddles across the
    // leaf's thin axis (a 20 LDU wall on a cell boundary is two blocks thick).
    const acrossCells = (): [number, number] => {
      if (!d.frameAcrossLdu) return d.alongAxis === 'x' ? [z0, z1] : [x0, x1];
      const f = d.alongAxis === 'x'
        ? [sceneGridPoint(frame, [0, 0, d.frameAcrossLdu[0]])[2], sceneGridPoint(frame, [0, 0, d.frameAcrossLdu[1]])[2]]
        : [sceneGridPoint(frame, [d.frameAcrossLdu[0], 0, 0])[0], sceneGridPoint(frame, [d.frameAcrossLdu[1], 0, 0])[0]];
      const [lo, hi] = span(f[0]!, f[1]!);
      const limit = d.alongAxis === 'x' ? grid.length : grid.width;
      return [Math.max(0, Math.min(lo, d.alongAxis === 'x' ? z0 : x0)), Math.min(limit - 1, Math.max(hi, d.alongAxis === 'x' ? z1 : x1))];
    };
    const [c0, c1] = acrossCells();
    const [px0, px1] = d.alongAxis === 'x' ? [x0, x1] : [c0, c1];
    const [pz0, pz1] = d.alongAxis === 'x' ? [c0, c1] : [z0, z1];
    // Cells across the opening, ordered from the viewer's LEFT (facing south: west→east; facing east: south→north).
    const cells: Array<{ x: number; z: number }> = [];
    if (d.alongAxis === 'x') for (let x = x0; x <= x1; x++) cells.push({ x, z: z0 });
    else for (let z = z1; z >= z0; z--) cells.push({ x: x0, z });
    // Do not let an overlapping duplicate leaf erase the already-hung vanilla door.
    if (cells.every(c => hungCells.has(`${c.x},${y0},${c.z}`))) continue;
    for (let y = y0; y <= y1; y++) for (let z = pz0; z <= pz1; z++) for (let x = px0; x <= px1; x++) { clear(x, y, z); stats.leavesCleared++; }
    const block = doorBlockForColor(d.color);
    // Thin axis = the one the leaf does NOT run along; the door faces its positive side.
    const facing = d.alongAxis === 'x' ? 'south' : 'east';
    const hingeLeft = (i: number): boolean => {
      if (cells.length >= 2) return i < cells.length / 2; // double doors: outer hinges
      // Single door: the hinge end the mould marks, seen from the facing side
      // (facing south, the viewer's left is grid −X; facing east, it is grid +Z).
      const hingeAtLeftEnd = d.alongAxis === 'x' ? hingeAtGridMin(d) : !hingeAtGridMin(d);
      return hingeAtLeftEnd;
    };
    // A door implies a passage: across its thin axis, on each side, open the
    // solid cells between the door and the nearest air within three cells
    // (a facade two studs deep, a straddled wall the frame did not cover).
    // Five of the museum's six doors were entombed this way on the Pixel.
    let reachable = false;
    for (const c of cells) for (const dir of [-1, 1]) {
      const at = (k: number): [number, number] => d.alongAxis === 'x' ? [c.x, c.z + dir * k] : [c.x + dir * k, c.z];
      let airAt = -1;
      for (let k = 1; k <= 3; k++) { const [x, z] = at(k); if (cellAt(x, y0, z) === 'minecraft:air' && cellAt(x, y0 + 1, z) === 'minecraft:air') { airAt = k; break; } }
      if (airAt < 0) continue;
      reachable = true;
      for (let k = 1; k < airAt; k++) { const [x, z] = at(k); for (const y of [y0, y0 + 1]) if (cellAt(x, y, z) !== 'minecraft:air') { clear(x, y, z); stats.passageCleared++; } }
      // The whole passage, the air it reaches included, stays open in the
      // colliders too (they are laid from geometry, which may reach a cell
      // the voxel grid left air).
      if (clearedCells) for (let k = 1; k <= airAt; k++) {
        const [x, z] = at(k);
        if (x < 0 || z < 0 || x >= grid.width || z >= grid.length) continue;
        for (const y of [y0, y0 + 1]) if (y < grid.height) clearedCells.add((x * grid.height + y) * grid.length + z);
      }
    }
    if (!reachable) stats.unreachable++;
    const doorsBefore = stats.doors;
    cells.forEach((c, i) => {
      const key = `${c.x},${y0},${c.z}`;
      if (hungCells.has(key)) return;
      const hinge = hingeLeft(i) ? 'left' : 'right';
      grid.set(c.x, y0, c.z, `${block}[facing=${facing},half=lower,hinge=${hinge},open=false,powered=false]`);
      grid.set(c.x, y0 + 1, c.z, `${block}[facing=${facing},half=upper,hinge=${hinge},open=false,powered=false]`);
      hungCells.add(key);
      stats.doors++;
    });
    if (stats.doors > doorsBefore) hungDoors?.add(d);
  }
  return stats;
}

// ─── Access: doorways, headroom and the walk-through size recommendation ─────
//
// A player needs a clear opening one block wide and two high to pass, and two
// blocks of headroom to stand (addon-scale.ts, `PASSAGE_*`). Whether a set has
// such openings is a property of its GEOMETRY, not of its theme: a modular's
// 1×4×6 doors clear it at 1×, an Architecture landmark's one-stud gateways
// need 300-400 %, a sculpture has nothing to walk through at any size. The
// measurement below therefore reads the model itself, in two tiers:
//
//  1. Semantic door LEAVES (the library's own "Door …" descriptions, the same
//     rule `discoverSceneActors` hangs vanilla doors by): the leaf's extent is
//     the opening. Strong evidence when present - a set with door moulds was
//     built for its figures to walk through them.
//  2. APERTURES in an occupancy grid of the whole model: every part's box
//     (moulds with a hole - doors, windows, arches - are rasterised from their
//     triangles so the hole stays open) at a plate-sized cell, then every
//     floor-level air run that is walled on both sides, has a lintel, and opens
//     into a wider space (or the outside) within a wall's thickness on BOTH
//     sides. That is a doorway however it was built: a door frame, a brick
//     arch, or the one-stud gap in a microscale gatehouse.
//
// The recommendation is the smallest supported step (100/150/200/300/400 %) at
// which the model's representative doorway clears the passage AND its floors
// clear standing headroom; it is DATA for the caller to show ("doorways are
// 0.4 blocks wide at 100 %; 300 % makes them 1.2"), never an applied size.

/** Moulds with an aperture: their triangles are rasterised into the occupancy, not their bounding box. */
const APERTURE_MOULD = /^[~=_]*\s*(?:Half\s+|Duplo\s+)?(?:Door|Window|Arch)\b/i;

/**
 * Occupancy cells for the access grid, LDU, and the grid is aligned to world
 * multiples of them. LEGO geometry sits on half-stud (10 LDU) multiples
 * horizontally and plate (8 LDU) multiples vertically - a door frame's jambs
 * are at ±30, a brick is 24 tall - so with a 5 × 4 cell an axis-aligned
 * opening is measured exactly. A plate-sized cell under-read a 104 LDU
 * (1.95-block) doorway by up to a cell, enough to push a 100 % doorway to
 * 150 %. Coarsened (×1.5 steps) for very large models (`maxCells`).
 */
export const ACCESS_CELL_LDU: Readonly<{ xz: number; y: number }> = { xz: 5, y: 4 };
/** The cells an access grid may hold before its cells are coarsened (48 MB; a 71043 goes to 7.5 × 6 LDU). */
const ACCESS_MAX_CELLS = 48_000_000;
/** A wall's thickness, LDU: how far past a doorway's throat the space must widen for it to be a doorway. */
const WALL_DEPTH_LDU = 100;
/** The smallest aperture counted, LDU: a brick tall (below that it is the gap between two plates). */
const MIN_APERTURE_HEIGHT_LDU = 24;
const MIN_APERTURE_WIDTH_LDU = 16;
/**
 * A doorway is not a slot: an opening wider than this many times its height
 * is the gap under a car, between a plate and the ground, under eaves. A
 * garage door (3 wide × 2.5 high) stays in; a 5.3 × 0.6 undercarriage does not.
 */
const MAX_APERTURE_ASPECT = 2.5;

export interface SceneOpening {
  /** How it was found: a door-shaped semantic leaf's own extent, a leaf wider than tall (a hatch), or an aperture in the occupancy grid. */
  source: 'door-leaf' | 'hatch-leaf' | 'aperture';
  /** The horizontal axis a player travels along to pass through it. */
  axis: 'x' | 'z';
  /** Clear width across the opening and clear height under its lintel, LDU. */
  widthLdu: number;
  heightLdu: number;
  /** Centre of the opening's threshold, LDraw. */
  centreLdu: Vec3;
  /** Smallest multiplier of the minifig scale at which a 1×2-block passage clears it. */
  requiredScale: number;
}

export interface SceneAccessMeasurement {
  /** Occupancy cells used, LDU (horizontal, vertical). */
  cell: { xz: number; y: number };
  /** The occupancy grid's cells and how many are solid. */
  grid: { x: number; y: number; z: number; solid: number };
  /** Every opening found, by ascending `requiredScale` (the easiest to pass first). */
  openings: SceneOpening[];
  /** Interior floor-to-ceiling: the median finite headroom over floor cells at least a brick high, LDU; null when the model has no interior. */
  headroomLdu: number | null;
  /** Floor cells behind that median. */
  interiorFloorCells: number;
  /**
   * The highest floor surface a player could stand on anywhere in the model
   * (at least a brick of headroom), LDU above the model's ground; null when
   * there is none. The reach walk's ceiling.
   */
  topFloorLdu: number | null;
  /**
   * The walk: at each supported step, how far into and UP the model a player
   * gets from the outside. Columns one block wide at that step (the collider
   * re-lay claims a column by its centre), standing surfaces with player
   * headroom, moves to a neighbouring column's surface up to one jump higher
   * (and any drop). Rises grow with the model while the player does not, so
   * a brick riser (0.45 blocks) that is a step at 100 % is a wall at 300 %:
   * `highestReachedLdu` then falls to the ground floor.
   */
  reach: SceneReach[];
}

export interface SceneReach {
  scale: number;
  /** Standing surfaces (column × floor) the walk reached. */
  reachedSurfaces: number;
  /** Highest reached surface, LDU above the model's ground. */
  highestReachedLdu: number;
}

export interface SceneAccessOptions {
  /** Placements left out of the occupancy (a scene's spawned figures: an NPC standing in a doorway is not a wall). */
  exclude?: ReadonlySet<ParsedBrick>;
  /** Force the cells, LDU (default `ACCESS_CELL_LDU`, coarsened to fit `maxCells`). */
  cell?: { xz: number; y: number };
  maxCells?: number;
}

/**
 * Measure what a player could walk through: the model's doorways (semantic
 * leaves and geometric apertures) and its interior headroom. Pure and
 * synchronous given the part meshes (`discoverSceneActors` already loads
 * them); the pipeline calls it once per export and ships the result as data.
 */
export function measureSceneAccess(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, options: SceneAccessOptions = {}): SceneAccessMeasurement {
  type Box = { min: Vec3; max: Vec3 };
  const boxes: Box[] = [];
  const rasterised: Array<{ brick: ParsedBrick; mesh: LdrawPartMesh }> = [];
  const leaves: Array<Box & { alongAxis: 'x' | 'z' }> = [];
  for (const b of bricks) {
    if (options.exclude?.has(b)) continue;
    const m = meshes.get(b.part);
    const box: Box = m && m.triangles.length ? worldBounds(b, m) : { min: [b.x - 10, b.y - 24, b.z - 10], max: [b.x + 10, b.y, b.z + 10] };
    if (m && m.triangles.length && isDoorLeafDescription(m.description)) {
      // A leaf opens: it is the doorway, not a wall.
      leaves.push({ ...box, alongAxis: box.max[0] - box.min[0] >= box.max[2] - box.min[2] ? 'x' : 'z' });
      continue;
    }
    if (m && m.triangles.length && APERTURE_MOULD.test(m.description)) rasterised.push({ brick: b, mesh: m });
    else boxes.push(box);
  }
  const all = [...boxes, ...rasterised.map(r => worldBounds(r.brick, r.mesh)), ...leaves];
  if (!all.length) return { cell: { ...(options.cell ?? ACCESS_CELL_LDU) }, grid: { x: 0, y: 0, z: 0, solid: 0 }, openings: [], headroomLdu: null, interiorFloorCells: 0, topFloorLdu: null, reach: [] };
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of all) for (let i = 0; i < 3; i++) { if (b.min[i]! < min[i]!) min[i] = b.min[i]!; if (b.max[i]! > max[i]!) max[i] = b.max[i]!; }

  // Cells: half a stud by half a plate, coarsened until the grid fits the budget.
  const maxCells = options.maxCells ?? ACCESS_MAX_CELLS;
  let cell = options.cell ?? ACCESS_CELL_LDU, cellXZ = cell.xz, cellY = cell.y;
  const cellsAt = (): number => (Math.floor((max[0] - min[0]) / cellXZ) + 2 * Math.ceil(LDU_PER_BLOCK / cellXZ) + 3) * (Math.floor((max[1] - min[1]) / cellY) + 3) * (Math.floor((max[2] - min[2]) / cellXZ) + 2 * Math.ceil(LDU_PER_BLOCK / cellXZ) + 3);
  if (options.cell === undefined) while (cellsAt() > maxCells) { cellXZ *= 1.5; cellY *= 1.5; }
  cell = { xz: cellXZ, y: cellY };
  // Grid frame, aligned to world multiples of the cell: one air cell of padding
  // around, a SOLID ground row under the model (it stands on the world), LDraw
  // Y down mapped to grid Y up.
  // The horizontal padding is a whole block at 1×, so the outermost column of
  // the reach walk stands on open ground at every step.
  const pad = Math.ceil(LDU_PER_BLOCK / cellXZ) + 1;
  const ox = Math.floor(min[0] / cellXZ) * cellXZ - pad * cellXZ, oz = Math.floor(min[2] / cellXZ) * cellXZ - pad * cellXZ;
  const bottom = Math.ceil(max[1] / cellY) * cellY + cellY; // LDraw y of the ground row's underside
  const gx = (x: number): number => Math.floor((x - ox) / cellXZ);
  const gz = (z: number): number => Math.floor((z - oz) / cellXZ);
  const gy = (y: number): number => Math.floor((bottom - y) / cellY);
  const sx = gx(max[0]) + pad + 1, sz = gz(max[2]) + pad + 1, sy = gy(min[1]) + 2;
  const solid = new Uint8Array(sx * sy * sz);
  const idx = (x: number, y: number, z: number): number => (y * sz + z) * sx + x;
  const mark = (x: number, y: number, z: number): void => { if (x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz) solid[idx(x, y, z)] = 1; };
  for (let x = 0; x < sx; x++) for (let z = 0; z < sz; z++) solid[idx(x, 0, z)] = 1;
  // A face exactly on a cell boundary claims only its own side (the 0.05-cell
  // tolerance); a part thinner than that still claims the cell it lies in.
  const lo = (v: number): number => Math.floor(v + 0.05), hi = (v: number, from: number): number => Math.max(Math.ceil(v - 0.05) - 1, from);
  for (const b of boxes) {
    const x0 = lo((b.min[0] - ox) / cellXZ), x1 = hi((b.max[0] - ox) / cellXZ, x0);
    const z0 = lo((b.min[2] - oz) / cellXZ), z1 = hi((b.max[2] - oz) / cellXZ, z0);
    const y0 = lo((bottom - b.max[1]) / cellY), y1 = hi((bottom - b.min[1]) / cellY, y0);
    for (let y = Math.max(0, y0); y <= Math.min(sy - 1, y1); y++) for (let z = Math.max(0, z0); z <= Math.min(sz - 1, z1); z++) {
      const row = idx(0, y, z);
      for (let x = Math.max(0, x0); x <= Math.min(sx - 1, x1); x++) solid[row + x] = 1;
    }
  }
  // Aperture moulds: a solid voxelization of the mould's own triangles (ray
  // parity along all three axes at cell centres, unioned - the voxelizer's
  // own method), so the jambs and the lintel are solid and the hole between
  // them is air. Sampling the surface cannot do this: an axis-aligned face on
  // a cell boundary does not know which side is solid, and a 60 LDU frame
  // opening read 56 or 80.
  const centreX = (i: number): number => ox + (i + 0.5) * cellXZ;
  const centreZ = (i: number): number => oz + (i + 0.5) * cellXZ;
  const centreY = (i: number): number => bottom - (i + 0.5) * cellY;
  /** Where the axis-`w` ray through (u, v) crosses a triangle, or null. `p` = the vertex components picked per axis. */
  const cross = (u: number, v: number, a: [number, number, number], b: [number, number, number], c: [number, number, number]): number | null => {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) return null; // edge-on to the ray
    const l0 = ((b[1] - c[1]) * (u - c[0]) + (c[0] - b[0]) * (v - c[1])) / d;
    const l1 = ((c[1] - a[1]) * (u - c[0]) + (a[0] - c[0]) * (v - c[1])) / d;
    const l2 = 1 - l0 - l1;
    if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) return null;
    return l0 * a[2] + l1 * b[2] + l2 * c[2];
  };
  for (const { brick, mesh } of rasterised) {
    const tris = mesh.triangles.map(t => [local(brick, t.a), local(brick, t.b), local(brick, t.c)] as [Vec3, Vec3, Vec3]);
    const box = worldBounds(brick, mesh);
    const x0 = Math.max(0, gx(box.min[0])), x1 = Math.min(sx - 1, gx(box.max[0]));
    const z0 = Math.max(0, gz(box.min[2])), z1 = Math.min(sz - 1, gz(box.max[2]));
    const y0 = Math.max(0, gy(box.max[1])), y1 = Math.min(sy - 1, gy(box.min[1]));
    const hits: number[] = [];
    /** Sorted, de-duplicated crossings paired into solid spans; cells whose centre lies in a span are marked by `markSpan`. */
    const fill = (markSpan: (w0: number, w1: number) => void): void => {
      hits.sort((p, q) => p - q);
      let n = 0;
      for (const h of hits) if (n === 0 || h - hits[n - 1]! > 1e-4) hits[n++] = h;
      for (let k = 0; k + 1 < n; k += 2) markSpan(hits[k]!, hits[k + 1]!);
      hits.length = 0;
    };
    // Rays along Y (LDraw down) through each (x, z) column.
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const u = centreX(ix), v = centreZ(iz);
      for (const [a, b, c] of tris) { const w = cross(u, v, [a[0], a[2], a[1]], [b[0], b[2], b[1]], [c[0], c[2], c[1]]); if (w !== null) hits.push(w); }
      fill((w0, w1) => { for (let iy = Math.max(y0, Math.ceil((bottom - w1) / cellY - 0.5)); iy <= Math.min(y1, Math.floor((bottom - w0) / cellY - 0.5)); iy++) mark(ix, iy, iz); });
    }
    // Rays along X through each (y, z).
    for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const u = centreY(iy), v = centreZ(iz);
      for (const [a, b, c] of tris) { const w = cross(u, v, [a[1], a[2], a[0]], [b[1], b[2], b[0]], [c[1], c[2], c[0]]); if (w !== null) hits.push(w); }
      fill((w0, w1) => { for (let ix = Math.max(x0, Math.ceil((w0 - ox) / cellXZ - 0.5)); ix <= Math.min(x1, Math.floor((w1 - ox) / cellXZ - 0.5)); ix++) mark(ix, iy, iz); });
    }
    // Rays along Z through each (x, y).
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) {
      const u = centreX(ix), v = centreY(iy);
      for (const [a, b, c] of tris) { const w = cross(u, v, [a[0], a[1], a[2]], [b[0], b[1], b[2]], [c[0], c[1], c[2]]); if (w !== null) hits.push(w); }
      fill((w0, w1) => { for (let iz = Math.max(z0, Math.ceil((w0 - oz) / cellXZ - 0.5)); iz <= Math.min(z1, Math.floor((w1 - oz) / cellXZ - 0.5)); iz++) mark(ix, iy, iz); });
    }
  }
  let solidCount = 0;
  for (let i = sx * sz; i < solid.length; i++) solidCount += solid[i]!;

  const isSolid = (x: number, y: number, z: number): boolean => solid[idx(x, y, z)] === 1;
  /** Air cells from (x,y,z) upward until a solid; Infinity when the sky is reached. */
  const headroom = (x: number, y: number, z: number): number => {
    let h = 0;
    for (let yy = y; yy < sy; yy++) { if (isSolid(x, yy, z)) return h; h++; }
    return Infinity;
  };
  const minWidthCells = Math.max(1, Math.round(MIN_APERTURE_WIDTH_LDU / cellXZ));
  const minHeightCells = Math.max(1, Math.round(MIN_APERTURE_HEIGHT_LDU / cellY));
  const wallDepthCells = Math.max(2, Math.ceil(WALL_DEPTH_LDU / cellXZ));

  // ── Apertures: floor-level air runs across a wall, walled both sides, with a lintel, open beyond both faces.
  interface Run { y: number; d: number; w0: number; w1: number; h: number }
  interface Aperture { y: number; w0: number; w1: number; d0: number; d1: number; throat: Run; minH: number }
  const openings: SceneOpening[] = [];
  for (const axis of ['x', 'z'] as const) {
    const depthN = axis === 'x' ? sx : sz, widthN = axis === 'x' ? sz : sx;
    const at = (d: number, y: number, w: number): boolean => axis === 'x' ? isSolid(d, y, w) : isSolid(w, y, d);
    const head = (d: number, y: number, w: number): number => axis === 'x' ? headroom(d, y, w) : headroom(w, y, d);
    const floorAir = (d: number, y: number, w: number): boolean => !at(d, y, w) && at(d, y - 1, w);
    /** Length of the air run along the width axis through w at (d, y); Infinity when it reaches the grid edge. */
    const runThrough = (d: number, y: number, w: number): number => {
      let a = w, b = w;
      while (a - 1 >= 0 && !at(d, y, a - 1)) a--;
      while (b + 1 < widthN && !at(d, y, b + 1)) b++;
      return a === 0 || b === widthN - 1 ? Infinity : b - a + 1;
    };
    /** From the throat, along `dir`: does the space open up (a room, the outside, a drop, the sky) within a wall's depth, unobstructed? */
    const opensBeyond = (d: number, y: number, w: number, dir: 1 | -1, n: number): boolean => {
      for (let k = 1; k <= wallDepthCells; k++) {
        const dd = d + dir * k;
        if (dd < 0 || dd >= depthN) return true;
        if (at(dd, y, w)) return false;
        if (!at(dd, y - 1, w)) return true;
        if (runThrough(dd, y, w) >= 2 * n || head(dd, y, w) === Infinity) return true;
      }
      return false;
    };
    const runs: Run[] = [];
    for (let y = 1; y < sy; y++) for (let d = 0; d < depthN; d++) {
      for (let w = 0; w < widthN;) {
        if (!floorAir(d, y, w)) { w++; continue; }
        const w0 = w;
        while (w < widthN && floorAir(d, y, w)) w++;
        const w1 = w - 1;
        if (w0 - 1 < 0 || w1 + 1 >= widthN || !at(d, y, w0 - 1) || !at(d, y, w1 + 1)) continue;
        const n = w1 - w0 + 1;
        if (n < minWidthCells) continue;
        const wc = (w0 + w1) >> 1;
        const h = head(d, y, wc);
        if (!Number.isFinite(h) || h < minHeightCells) continue;
        if (!opensBeyond(d, y, wc, 1, n) || !opensBeyond(d, y, wc, -1, n)) continue;
        runs.push({ y, d, w0, w1, h });
      }
    }
    // A wall several cells thick yields the same aperture once per cell of depth: merge
    // depth-adjacent, overlapping runs and keep the narrowest run as the throat.
    const apertures: Aperture[] = [];
    runs.sort((p, q) => p.y - q.y || p.d - q.d || p.w0 - q.w0);
    for (const r of runs) {
      const width = r.w1 - r.w0 + 1;
      const home = apertures.find(a => a.y === r.y && a.d1 === r.d - 1 && r.w0 <= a.w1 && r.w1 >= a.w0);
      if (home) {
        home.d1 = r.d;
        home.w0 = Math.min(home.w0, r.w0); home.w1 = Math.max(home.w1, r.w1);
        home.minH = Math.min(home.minH, r.h);
        const throatWidth = home.throat.w1 - home.throat.w0 + 1;
        if (width < throatWidth || (width === throatWidth && r.h < home.throat.h)) home.throat = r;
      } else apertures.push({ y: r.y, w0: r.w0, w1: r.w1, d0: r.d, d1: r.d, throat: r, minH: r.h });
    }
    for (const a of apertures) {
      const widthLdu = (a.throat.w1 - a.throat.w0 + 1) * cellXZ, heightLdu = a.minH * cellY;
      if (widthLdu > MAX_APERTURE_ASPECT * heightLdu) continue;
      const dc = (a.d0 + a.d1 + 1) / 2 * cellXZ, wc = (a.throat.w0 + a.throat.w1 + 1) / 2 * cellXZ;
      const centreLdu: Vec3 = axis === 'x' ? [ox + dc, bottom - a.y * cellY, oz + wc] : [ox + wc, bottom - a.y * cellY, oz + dc];
      openings.push({ source: 'aperture', axis, widthLdu, heightLdu, centreLdu, requiredScale: passageRequiredScale(widthLdu, heightLdu) });
    }
  }
  // Semantic leaves are the doorway they hang in: drop the aperture measured
  // through their frame. A leaf wider than it is tall (1×3×1 cupboard doors,
  // the Titanic's 44 hull hatches) is a hatch, not a doorway: it counts as an
  // opening like any aperture, never as door evidence.
  const leafOpenings: SceneOpening[] = leaves.map(l => {
    const widthLdu = l.alongAxis === 'x' ? l.max[0] - l.min[0] : l.max[2] - l.min[2];
    const heightLdu = l.max[1] - l.min[1];
    const centreLdu: Vec3 = [(l.min[0] + l.max[0]) / 2, l.max[1], (l.min[2] + l.max[2]) / 2];
    return { source: heightLdu >= widthLdu ? 'door-leaf' : 'hatch-leaf', axis: l.alongAxis === 'x' ? 'z' : 'x', widthLdu, heightLdu, centreLdu, requiredScale: passageRequiredScale(widthLdu, heightLdu) };
  });
  const inLeaf = (o: SceneOpening): boolean => leaves.some(l =>
    o.centreLdu[0] >= l.min[0] - cellXZ && o.centreLdu[0] <= l.max[0] + cellXZ &&
    o.centreLdu[1] >= l.min[1] - cellY && o.centreLdu[1] <= l.max[1] + cellY &&
    o.centreLdu[2] >= l.min[2] - cellXZ && o.centreLdu[2] <= l.max[2] + cellXZ);
  const merged = [...leafOpenings, ...openings.filter(o => !inLeaf(o))].sort((p, q) => p.requiredScale - q.requiredScale);

  // ── Headroom: the median floor-to-ceiling over interior floor cells (finite, at least a brick).
  const hist = new Map<number, number>();
  let floorCells = 0;
  for (let y = 1; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    if (isSolid(x, y, z) || !isSolid(x, y - 1, z)) continue;
    const h = headroom(x, y, z);
    if (!Number.isFinite(h) || h < minHeightCells) continue;
    hist.set(h, (hist.get(h) ?? 0) + 1);
    floorCells++;
  }
  let headroomLdu: number | null = null;
  if (floorCells) {
    let seen = 0;
    for (const h of [...hist.keys()].sort((p, q) => p - q)) { seen += hist.get(h)!; if (seen * 2 >= floorCells) { headroomLdu = h * cellY; break; } }
  }

  // ── The reach walk, once per supported step: a breadth-first walk over the
  // fine grid's standing cells from the outside ring. A cell is standable at a
  // step when it is a floor with player headroom and a player-wide clear run
  // through it along one horizontal axis (checked at foot, waist and head
  // height); a move to a neighbouring standing cell may rise at most one jump.
  const isFloor = (x: number, y: number, z: number): boolean => y >= 1 && !isSolid(x, y, z) && isSolid(x, y - 1, z);
  let topFloorLdu: number | null = null;
  for (let y = sy - 1; y >= 1 && topFloorLdu === null; y--) for (let z = 0; z < sz && topFloorLdu === null; z++) for (let x = 0; x < sx; x++) {
    if (isFloor(x, y, z) && headroom(x, y, z) >= minHeightCells) { topFloorLdu = (y - 1) * cellY; break; }
  }
  const reach: SceneReach[] = [];
  const visited = new Uint8Array(Math.ceil(solid.length / 8));
  const airAt = (x: number, y: number, z: number): boolean => y >= sy || !isSolid(x, y, z);
  for (const scale of ACCESS_SCALE_STEPS) {
    const blockLdu = LDU_PER_BLOCK / scale;
    const needCells = Math.ceil(PLAYER_HEIGHT_BLOCKS * blockLdu / cellY - 1e-9);
    const wideCells = Math.ceil(PASSAGE_WIDTH_BLOCKS * blockLdu / cellXZ - 1e-9);
    const jumpCells = JUMP_HEIGHT_BLOCKS * blockLdu / cellY;
    const rows = (y: number): [number, number, number] => [y, y + (needCells >> 1), y + needCells - 1];
    /** Contiguous cells through (x, z) along `axis` that are air at all three body rows, capped at `wideCells`. */
    const clearRun = (x: number, y: number, z: number, axis: 'x' | 'z'): number => {
      const [r0, r1, r2] = rows(y);
      const open = (i: number): boolean => axis === 'x' ? (i >= 0 && i < sx && airAt(i, r0, z) && airAt(i, r1, z) && airAt(i, r2, z)) : (i >= 0 && i < sz && airAt(x, r0, i) && airAt(x, r1, i) && airAt(x, r2, i));
      const at = axis === 'x' ? x : z;
      let n = 1;
      for (let i = at - 1; n < wideCells && open(i); i--) n++;
      for (let i = at + 1; n < wideCells && open(i); i++) n++;
      return n;
    };
    const standable = (x: number, y: number, z: number): boolean =>
      isFloor(x, y, z) && headroom(x, y, z) >= needCells && (clearRun(x, y, z, 'x') >= wideCells || clearRun(x, y, z, 'z') >= wideCells);
    visited.fill(0);
    const queue: number[] = [];
    const push = (x: number, y: number, z: number): void => {
      const k = idx(x, y, z);
      if (visited[k >> 3]! & (1 << (k & 7))) return;
      visited[k >> 3]! |= 1 << (k & 7);
      queue.push(k);
    };
    // The outside: the padding ring's ground (and any surface standing on it there).
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (x !== 0 && z !== 0 && x !== sx - 1 && z !== sz - 1) continue;
      for (let y = 1; y < sy; y++) if (standable(x, y, z)) push(x, y, z);
    }
    let highest = 0;
    for (let h = 0; h < queue.length; h++) {
      const k = queue[h]!, x = k % sx, rest = (k - x) / sx, z = rest % sz, y = (rest - z) / sz;
      if (y - 1 > highest) highest = y - 1;
      for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
        if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue;
        // The neighbour column's floors within a jump up (or any drop): scan from the ceiling of this cell down.
        const top = Math.min(sy - 1, y + Math.floor(jumpCells + 1e-9));
        for (let ny = top; ny >= 1; ny--) if (standable(nx, ny, nz)) push(nx, ny, nz);
      }
    }
    reach.push({ scale, reachedSurfaces: queue.length, highestReachedLdu: highest * cellY });
  }
  return { cell, grid: { x: sx, y: sy, z: sz, solid: solidCount }, openings: merged, headroomLdu, interiorFloorCells: floorCells, topFloorLdu, reach };
}

/**
 * Which doorway the recommendation is measured on. Semantic leaves are all
 * real doorways, so their MEDIAN speaks for the set. Apertures include every
 * gap the geometry happens to form (between a chair and a wall, under a
 * shelf), which are small; the doorways proper are the larger ones, so the
 * aperture at the 25th percentile of required scale (among the easiest
 * quarter to pass) stands for them.
 */
const LEAF_PERCENTILE = 0.5;
const APERTURE_PERCENTILE = 0.25;

export interface AccessScaleRecommendation {
  /** Recommended multiplier of the minifig scale (1, 1.5, 2, 3 or 4); absent when no step makes the model walkable. */
  scale?: number;
  /** The same step as the Brick Wand's size percentage (100…400). */
  sizePct?: number;
  /** What the recommendation was measured on. */
  basis: 'door-leaves' | 'apertures' | 'none';
  /** The representative doorway at 100 %, blocks, and how many of its kind clear the passage at the recommended step. */
  doorway?: { widthBlocks: number; heightBlocks: number; requiredScale: number; count: number; passable: number };
  /** Interior floor-to-ceiling at 100 %, blocks, and the first step that gives standing room (absent: none does). */
  headroom?: { blocks: number; requiredScale: number; scale?: number };
  /**
   * How far UP the model the reach walk gets at the recommended step, as a
   * fraction of the model's top floor (`topFloorLdu`), against the best any
   * step manages. A doorway step that loses the upper floors hands the user a
   * building they can enter and not climb - `reason` names that tension and
   * the step that keeps the floors, instead of choosing silently.
   */
  climb?: { fraction: number; bestFraction: number; bestStep: number; climbableAtScale: boolean };
  /** One sentence for the UI, with the measured numbers. */
  reason: string;
}

const blocks1 = (ldu: number, scale = 1): string => (Math.round(ldu * scale / LDU_PER_BLOCK * 10) / 10).toFixed(1);
/** A step must lose at least this much of the model's height against another step before the reason calls it a tension. */
const CLIMB_LOSS_FRACTION = 0.25;
const pctOf = (scale: number): string => `${Math.round(scale * 100)} %`;

/** The smallest supported size at which a player can walk through the measured model, as data with its reason. */
export function recommendAccessScale(m: SceneAccessMeasurement): AccessScaleRecommendation {
  const leaves = m.openings.filter(o => o.source === 'door-leaf');
  const pool = leaves.length ? leaves : m.openings;
  const basis: AccessScaleRecommendation['basis'] = leaves.length ? 'door-leaves' : pool.length ? 'apertures' : 'none';
  const need = `a player needs ${PASSAGE_WIDTH_BLOCKS}×${PASSAGE_HEIGHT_BLOCKS}`;
  const headroom = m.headroomLdu !== null ? (() => {
    const requiredScale = PASSAGE_HEIGHT_BLOCKS * LDU_PER_BLOCK / m.headroomLdu!;
    const scale = accessStepFor(requiredScale);
    return { blocks: Number(blocks1(m.headroomLdu!)), requiredScale, ...(scale !== undefined ? { scale } : {}) };
  })() : undefined;
  /** The walk's verdict at `scale`: what fraction of the model's height it reaches, against the best step. */
  const climbAt = (scale: number) => {
    if (m.topFloorLdu === null || m.topFloorLdu <= 0 || !m.reach.length) return undefined;
    const fractionAt = (s: number): number => Math.min(1, (m.reach.find(r => r.scale === s)?.highestReachedLdu ?? 0) / m.topFloorLdu!);
    const best = m.reach.reduce((b, r) => fractionAt(r.scale) > fractionAt(b.scale) + 1e-9 ? r : b, m.reach[0]!);
    const fraction = fractionAt(scale), bestFraction = fractionAt(best.scale);
    return { fraction, bestFraction, bestStep: best.scale, climbableAtScale: fraction + CLIMB_LOSS_FRACTION >= bestFraction };
  };
  if (!pool.length) {
    const reason = headroom
      ? `No doorway found; interior floors are ${blocks1(m.headroomLdu!)} blocks under the ceiling at 100 %${headroom.scale ? ` (${pctOf(headroom.scale)} gives standing room)` : ''}, but nothing leads into them.`
      : 'No doorway or interior floor found: a solid model with nothing to walk through at any size.';
    return { basis, ...(headroom ? { headroom } : {}), reason };
  }
  // `pool` is sorted by ascending required scale: the percentile picks the representative doorway.
  const pick = pool[Math.min(pool.length - 1, Math.floor((pool.length - 1) * (leaves.length ? LEAF_PERCENTILE : APERTURE_PERCENTILE)))]!;
  const doorStep = accessStepFor(pick.requiredScale);
  const kind = leaves.length ? 'Door leaves' : 'Wall openings';
  const size = (o: SceneOpening, s = 1): string => `${blocks1(o.widthLdu, s)}×${blocks1(o.heightLdu, s)}`;
  if (doorStep === undefined) {
    const easiest = pool[0]!;
    const top = ACCESS_SCALE_STEPS[ACCESS_SCALE_STEPS.length - 1]!;
    return {
      basis, doorway: { widthBlocks: Number(blocks1(pick.widthLdu)), heightBlocks: Number(blocks1(pick.heightLdu)), requiredScale: pick.requiredScale, count: pool.length, passable: 0 }, ...(headroom ? { headroom } : {}),
      reason: `No size step makes the model walkable: its largest doorway is ${size(easiest)} blocks at 100 % and ${size(easiest, top)} at ${pctOf(top)} (${need}).`,
    };
  }
  // Floors must clear standing headroom too, when a step can give it; a model
  // whose rooms stay low at every step still gets its doorway step, said plainly.
  const scale = headroom?.scale !== undefined ? Math.max(doorStep, headroom.scale) : doorStep;
  const passable = pool.filter(o => o.requiredScale <= scale + 1e-9).length;
  let reason = scale === 1
    ? `${kind} are ${size(pick)} blocks at 100 %: a player walks through as exported (${passable}/${pool.length} clear the ${PASSAGE_WIDTH_BLOCKS}×${PASSAGE_HEIGHT_BLOCKS} passage)`
    : `${kind} are ${size(pick)} blocks at 100 %; ${pctOf(scale)} makes them ${size(pick, scale)} (${need}; ${passable}/${pool.length} clear it)`;
  if (headroom) {
    if (headroom.scale !== undefined && headroom.scale > doorStep) reason += `; floors are ${blocks1(m.headroomLdu!)} blocks under the ceiling at 100 %, so ${pctOf(scale)} is what gives standing room (${blocks1(m.headroomLdu!, scale)})`;
    else if (headroom.scale === undefined) reason += `; floors are only ${blocks1(m.headroomLdu!)} blocks under the ceiling at 100 % and ${blocks1(m.headroomLdu!, scale)} at ${pctOf(scale)} - stooping room, not standing`;
    else reason += `; floors are ${blocks1(m.headroomLdu!, scale)} blocks under the ceiling at ${pctOf(scale)}`;
  }
  // The floors must still be reachable at that size: a rise the player could
  // jump at 100 % grows with the model while the player does not.
  const climb = climbAt(scale);
  const pctFloors = (f: number): string => `${Math.round(f * 100)} %`;
  if (climb && !climb.climbableAtScale) {
    const alt = climb.bestStep;
    reason += `. But at ${pctOf(scale)} a player reaches only ${pctFloors(climb.fraction)} of the model's height (its top floor is ${blocks1(m.topFloorLdu!)} blocks up at 100 %), against ${pctFloors(climb.bestFraction)} at ${pctOf(alt)}: rises the player jumped at ${pctOf(alt)} are above the ${JUMP_HEIGHT_BLOCKS}-block jump at ${pctOf(scale)}`;
    reason += `. ${pctOf(alt)} keeps the floors but leaves doorways at ${size(pick, alt)}${alt < doorStep ? ` - under the ${PASSAGE_WIDTH_BLOCKS}×${PASSAGE_HEIGHT_BLOCKS} passage` : ''}; the choice is between the doors and the stairs`;
  } else if (climb && scale > 1 && climb.bestFraction > 0) {
    reason += `; a player still reaches ${pctFloors(climb.fraction)} of the model's height at ${pctOf(scale)}`;
  }
  return {
    scale, sizePct: Math.round(scale * 100), basis,
    doorway: { widthBlocks: Number(blocks1(pick.widthLdu)), heightBlocks: Number(blocks1(pick.heightLdu)), requiredScale: pick.requiredScale, count: pool.length, passable },
    ...(headroom ? { headroom } : {}),
    ...(climb ? { climb } : {}),
    reason: `${reason}.`,
  };
}
