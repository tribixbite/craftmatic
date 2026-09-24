/**
 * The moving parts of a LEGO model, made to WORK in Minecraft: doors and gates
 * that swing open and let the player through, windows and cupboard doors that
 * open, trap-door hatches, levers that flip and turntables / steering wheels /
 * rotors that turn. Design and the rules each class follows:
 * `docs/bedrock-interactivity.md`.
 *
 * ONE MODEL FOR EVERY CLASS. An interactive part is:
 *   - its exact LEGO geometry (the part plus what rides on it: a door's glass
 *     insert, a turntable's load), compiled as its own entity with a three-bone
 *     rig at its hinge (`interactiveRig`: tilt -> spin -> un-tilt, the pinball
 *     flipper's proven chain) so ONE float actor property turns it about any
 *     axis through the pivot;
 *   - a hinge (pivot + unit axis, LDraw) measured from the part's own frame:
 *     every LDraw leaf puts its origin at the hinge end (measured 2026-09-16
 *     on the door moulds; `leafHinge` states the per-class rule);
 *   - an angle: the open angle (signed, right-handed about the axis; the side
 *     is chosen by sweeping the leaf both ways against the model's parts) or,
 *     for a turnable, the step per tap;
 *   - for a doorway (door, gate, hatch): the collider CELLS its closed leaf
 *     fills (`blocking`) and the static collider cells around them
 *     (`neighbours`), so the runtime can lay the closed state and restore the
 *     exact static state when it opens - at any wand size and quarter turn,
 *     with the same arithmetic the collider re-lay uses (`ixWorldBlocks`).
 *
 * The runtime (`interactivesRuntime`, serialised into `scripts/interactives.js`)
 * toggles on a tap (`entityHitEntity`) or an interact (`playerInteractWithEntity`),
 * writes the target angle to the property (the client eases to it over 0.4 s in
 * Molang), lays or clears the doorway's colliders, plays the vanilla door sound
 * and persists the state in the entity's dynamic properties.
 *
 * A doorway smaller than the player's 1 x 2-block passage at the placed size
 * still OPENS (the leaf swings) but keeps its colliders, and says at which wand
 * size it becomes passable (`passSize`).
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import type { EntityRig } from './minifig-rig.js';
import { BlockGrid } from '@craft/schem/types.js';
import { isDoorLeafDescription, sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';
import { cleanPartId } from './ldraw-entity-compiler.js';
import { floatActorProperty } from './bedrock-json.js';
import { withSizeGroups } from './bedrock-placement-pack.js';
import { LDU_PER_BLOCK } from './lego-scale.js';
import { PASSAGE_HEIGHT_BLOCKS, PASSAGE_WIDTH_BLOCKS } from './addon-scale.js';
import { COLLIDER_BLOCK_ID, colliderState } from './bedrock-building-shell.js';

declare const world: any;
declare const system: any;
declare const BlockPermutation: any;

// ─── Classes ─────────────────────────────────────────────────────────────────

/**
 * - `door`: a door leaf at least `DOORWAY_MIN_HEIGHT_LDU` tall - a doorway a figure walks through.
 * - `gate`: a fence / castle gate leaf; a doorway with no lintel.
 * - `cabinet`: a door leaf too short to be a doorway (cupboard, 1 x 3 x 1 car door, container box).
 * - `window`: an opening casement (`Glass for Window … Opening`), a shutter or a hinged pane.
 * - `hatch`: a trap door lying in a floor.
 * - `lever`: a control stick that flips between two angles.
 * - `turnable`: a turntable top, a steering / ship's wheel, a rotor - turns a step per tap.
 */
export type InteractiveKind = 'door' | 'gate' | 'cabinet' | 'window' | 'hatch' | 'lever' | 'turnable';

/** Kinds whose closed state is a wall (door, gate) or a floor (hatch) the player collides with, toggled with the state. */
export const PASSAGE_KINDS: ReadonlySet<InteractiveKind> = new Set(['door', 'gate', 'hatch']);

/** A door leaf this tall (3 bricks) is a doorway; shorter is a cupboard / car door. */
export const DOORWAY_MIN_HEIGHT_LDU = 72;
/** Open angles, degrees. A turnable's value is its step per tap. */
export const OPEN_DEG: Readonly<Record<InteractiveKind, number>> = { door: 90, gate: 90, cabinet: 100, window: 60, hatch: 90, lever: 35, turnable: 90 };
/** Seconds the client takes to swing (or turn) through the full angle. */
export const SWING_SECONDS = 0.4;
/**
 * How many interactives one pack ships. Each is an actor (31-48 kB idle on the
 * Pixel, docs/bedrock-addon-guide.md) and an entity type; doorways first, then
 * mechanisms, then windows. Past the cap a part stays in the static shell.
 */
export const MAX_INTERACTIVES = 40;
/** The actor property the client eases the part's rotation to, degrees. */
export const INTERACTIVE_PROPERTY = 'craftmatic:angle';
export const INTERACTIVE_FAMILY = 'craftmatic_interactive';
/** Range of the angle property: a turnable accumulates steps and wraps well inside it. */
const ANGLE_RANGE: [number, number] = [-40000, 40000];
/** Bone the animation spins (`interactiveRig`). */
const SPIN_BONE = 'ix_spin';

/**
 * The class of a part from its LDraw description, or null. Glass inserts that
 * ride in a leaf are NOT classes of their own (they are gathered into their
 * leaf's assembly); frames never move.
 */
export function interactiveKindOf(description: string): InteractiveKind | null {
  const d = description.replace(/^[~=_]+\s*/, '');
  if (/^Glass for Window\b.*\bOpening\b/i.test(d)) return 'window';
  // 60616's unofficial file is described "GLASS DOOR FOR FRAME 1X4X6": a leaf, not a frame or an insert.
  if (/^GLASS DOOR\b/i.test(d)) return 'door';
  if (/\bGlass\b/i.test(d)) return null;
  if (/\bFrame\b/i.test(d)) return null;
  if (/^(Fabuland )?Window\b.*\bShutter\b/i.test(d) && !/\bwithout Shutter\b/i.test(d)) return 'window';
  if (/^Window\b.*\bPane\b/i.test(d)) return 'window';
  if (/\bTrap ?Door\b/i.test(d) || /^Hatch\b/i.test(d)) return 'hatch';
  if (/^(Fence )?Gate\b/i.test(d) || /^Door\b.*\bGate\b/i.test(d)) return 'gate';
  if (isDoorLeafDescription(d) || /^Train Door\b/i.test(d)) return 'door';
  if (/^Container (Cupboard|Box)\b.*\bDoor\b/i.test(d)) return 'cabinet';
  if (/^Hinge Control Stick\b/i.test(d) && !/\bBase$/i.test(d)) return 'lever';
  if (/\bLever\b/i.test(d) && !/\b(Base|Pattern|Sticker|Holder)\b/i.test(d)) return 'lever';
  if (/^(Technic )?Turntable\b.*\bTop\b/i.test(d)) return 'turnable';
  if (/\bSteering Wheel\b/i.test(d) && !/\b(Bearing|Holder|Hub|Stand|Yoke|Arm|Link)\b/i.test(d)) return 'turnable';
  if (/^Technic,? (Plate )?Rotor\b/i.test(d) || /^Propeller\b/i.test(d) || /\bShip'?s? Wheel\b/i.test(d)) return 'turnable';
  return null;
}

// ─── Geometry ────────────────────────────────────────────────────────────────

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const apply = (m: readonly number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const unit = (axis: number): Vec3 => [axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0];
const toWorld = (b: ParsedBrick, v: Vec3): Vec3 => add([b.x, b.y, b.z], apply(b.rot ?? IDENTITY, v));
/** A world vector into the brick's local frame (the rotation's transpose; Studio's 0.99999 scale is immaterial here). */
const toLocal = (b: ParsedBrick, w: Vec3): Vec3 => {
  const m = b.rot ?? IDENTITY, v = sub(w, [b.x, b.y, b.z]);
  return [m[0]! * v[0] + m[3]! * v[1] + m[6]! * v[2], m[1]! * v[0] + m[4]! * v[1] + m[7]! * v[2], m[2]! * v[0] + m[5]! * v[1] + m[8]! * v[2]];
};

/** Right-handed rotation of `p` by `deg` about the line through `pivot` along unit `axis` (Rodrigues). */
export function rotateAbout(p: Vec3, pivot: Vec3, axis: Vec3, deg: number): Vec3 {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const v = sub(p, pivot);
  const r = add(add(scale(v, c), scale(cross(axis, v), s)), scale(axis, dot(axis, v) * (1 - c)));
  return add(pivot, r);
}

interface Box { min: Vec3; max: Vec3 }
function cornersOf(lo: Vec3, hi: Vec3): Vec3[] {
  return [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]],
  ];
}
function worldBox(b: ParsedBrick, mesh: LdrawPartMesh): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of cornersOf(mesh.bounds.min, mesh.bounds.max)) {
    const w = toWorld(b, c);
    for (let i = 0; i < 3; i++) { if (w[i]! < min[i]!) min[i] = w[i]!; if (w[i]! > max[i]!) max[i] = w[i]!; }
  }
  return { min, max };
}
const inBox = (p: Vec3, b: Box, pad = 0): boolean =>
  p[0] > b.min[0] + pad && p[0] < b.max[0] - pad && p[1] > b.min[1] + pad && p[1] < b.max[1] - pad && p[2] > b.min[2] + pad && p[2] < b.max[2] - pad;

/** A rotation (row-major) taking unit `a` onto unit `b`. */
function rotationBetween(a: Vec3, b: Vec3): number[] {
  const v = cross(a, b), c = dot(a, b);
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-12) {
    // Opposite: a half turn about any axis perpendicular to `a`.
    const p = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 0, 1]));
    return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2], 2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2], 2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1];
  }
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}
const transpose = (m: number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

/**
 * The hinge rig: every placement hangs on `ix_untilt`, which un-tilts about the
 * pivot, spins (`ix_spin`, animated about its own Y) and re-tilts. At zero spin
 * the three cancel and the part is exactly where the model put it; any spin
 * turns it about `axisLdu` through the pivot. The chain is the pinball
 * flipper's (bedrock-pinball.ts `flipperRig`), whose sign convention was
 * proven on the Pixel (2026-09-24): a positive property is a right-handed turn
 * about the axis in the LDraw frame (the grid frame is a proper rotation of it).
 */
export function interactiveRig(count: number, pivotLdu: Vec3, axisLdu: Vec3): EntityRig {
  const tilt = rotationBetween([0, -1, 0], norm(axisLdu)); // LDraw up is -Y
  return {
    bones: [
      { name: 'ix_tilt', pivotLdu, rotation: tilt },
      { name: SPIN_BONE, parent: 'ix_tilt', pivotLdu },
      { name: 'ix_untilt', parent: SPIN_BONE, pivotLdu, rotation: transpose(tilt) },
    ],
    boneOf: new Array(count).fill('ix_untilt'),
  };
}

/** The closed leaf's mid-plane, LDraw: `corner + s*along + t*up`, s, t in [0, 1]; `along` runs from the hinge edge to the free edge. */
export interface LeafPlane { corner: Vec3; along: Vec3; up: Vec3; normal: Vec3; thicknessLdu: number }

export interface SceneInteractive {
  kind: InteractiveKind;
  /** The moving part's mould id and description. */
  part: string;
  description: string;
  /** Every placement that moves with it (the part first). */
  bricks: ParsedBrick[];
  /** The hinge (or spin) line: a point on it and its unit direction, LDraw. */
  pivotLdu: Vec3;
  axisLdu: Vec3;
  /** Open angle, degrees, right-handed about `axisLdu` (signed: the side chosen by the sweep); a turnable's step per tap. */
  angleDeg: number;
  /** A leaf-like part's closed mid-plane (doors, gates, cabinets, windows, hatches). */
  leaf?: LeafPlane;
  /** The entity origin: the closed assembly's bottom centre, LDraw. */
  anchorLdu: Vec3;
  /** The closed assembly's world AABB, LDraw. */
  boundsLdu: Box;
  /** The opening a player passes when it is open: width x height for a door or gate, width x depth for a hatch, LDU. */
  openingLdu?: { width: number; height: number };
  /** How far the leaf's width axis is turned off the nearest grid axis, degrees (a 45-degree bank door stays a working door). */
  offGridDeg: number;
  /** Degrees each sign of the swing was obstructed in the sweep (samples inside other parts), for diagnostics. */
  sweep?: { chosen: number; other: number };
}

export interface InteractiveDiscovery {
  items: SceneInteractive[];
  /** Parts matched but left static, and why (a symmetric origin gives no hinge, over the cap, lying on its side). */
  skipped: Array<{ part: string; kind: InteractiveKind; reason: string }>;
  warnings: string[];
}

/** Where a leaf's hinge is, in its part frame, and the axis the hinge line runs along. */
interface LeafHinge {
  /** Local axis index of the hinge line, and of the direction hinge edge -> free edge, and the thin axis. */
  lineAxis: number; swingAxis: number; thinAxis: number;
  /** The hinge edge's coordinate on `swingAxis` (the end nearest the mould's origin). */
  hingeAt: number; freeAt: number;
  /** How far off-centre the origin sits along `swingAxis`, 0..0.5: near 0 there is no hinge end to read. */
  offCentre: number;
}

/** The fraction along [lo, hi] where the mould's origin sits, measured from the nearer end (0 = at an end, 0.5 = centred). */
const originOffCentre = (lo: number, hi: number): { atMin: boolean; offCentre: number } => {
  const t = hi - lo > 1e-9 ? (0 - lo) / (hi - lo) : 0.5;
  return { atMin: t <= 0.5, offCentre: Math.abs(Math.max(0, Math.min(1, t)) - 0.5) };
};

/**
 * The hinge of a leaf in its own frame. Every LDraw leaf mould puts its origin
 * on the hinge line (doors: the pin end; 30042's trap door: the clip edge;
 * 60603's opening casement: the top clips), so:
 *   - door / gate / cabinet / shutter / pane: the hinge line is the part's
 *     up axis (local Y); it swings along the wider horizontal axis, from the
 *     end the origin is at;
 *   - hatch: lies flat (local Y thin); the hinge edge is the horizontal end
 *     the origin is at, the line runs along the other horizontal axis;
 *   - opening casement (`Glass for Window … Opening`): hung from whichever
 *     in-plane edge the origin marks (the top, on 60603).
 */
function leafHinge(kind: InteractiveKind, description: string, mesh: LdrawPartMesh): LeafHinge {
  const { min, max } = mesh.bounds;
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const hingeOn = (swingAxis: number, lineAxis: number, thinAxis: number): LeafHinge => {
    const o = originOffCentre(min[swingAxis]!, max[swingAxis]!);
    return { lineAxis, swingAxis, thinAxis, hingeAt: o.atMin ? min[swingAxis]! : max[swingAxis]!, freeAt: o.atMin ? max[swingAxis]! : min[swingAxis]!, offCentre: o.offCentre };
  };
  if (kind === 'hatch') {
    const x = originOffCentre(min[0]!, max[0]!), z = originOffCentre(min[2]!, max[2]!);
    return x.offCentre >= z.offCentre ? hingeOn(0, 2, 1) : hingeOn(2, 0, 1);
  }
  if (kind === 'window' && /\bOpening\b/i.test(description)) {
    const thin = ext.indexOf(Math.min(...ext));
    const [a, b] = [0, 1, 2].filter(i => i !== thin) as [number, number];
    const oa = originOffCentre(min[a]!, max[a]!), ob = originOffCentre(min[b]!, max[b]!);
    return oa.offCentre >= ob.offCentre ? hingeOn(a, b, thin) : hingeOn(b, a, thin);
  }
  const swing = ext[0]! >= ext[2]! ? 0 : 2;
  return hingeOn(swing, 1, swing === 0 ? 2 : 0);
}

/** How far off a leaf's face (LDU) a part may stand and still ride with it: a handle or knocker, not the wall. */
const LEAF_ATTACH_LDU = 16;

/** The origin must sit at least this far off-centre along the swing axis for its end to name the hinge (0.5 = at an end). */
const MIN_HINGE_OFF_CENTRE = 0.25;

/** A turnable's spin axis in its part frame: a turntable's up axis; otherwise the axis about which the part is most round, the thinnest on a tie. */
function turnAxisOf(description: string, mesh: LdrawPartMesh): number {
  if (/\bTurntable\b/i.test(description)) return 1;
  const { min, max } = mesh.bounds;
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let best = 1, bestScore = -Infinity;
  for (let k = 0; k < 3; k++) {
    const [a, b] = [0, 1, 2].filter(i => i !== k).map(i => ext[i]!) as [number, number];
    const roundness = Math.min(a, b) / Math.max(a, b, 1e-9);
    // Round about k (roundness near 1) wins; among equally round axes, the thinnest.
    const score = roundness * 10 - ext[k]! / Math.max(...ext, 1e-9);
    if (score > bestScore) { bestScore = score; best = k; }
  }
  return best;
}

export interface DiscoverInteractivesOptions {
  /** Placements that are not static scenery (figures, vehicles, coaster cars, pinball parts). */
  exclude?: ReadonlySet<ParsedBrick>;
  /** Cap on shipped interactives (default `MAX_INTERACTIVES`). */
  max?: number;
}

/**
 * Find every interactive part among the scenery's placements, with its moving
 * assembly, hinge and open angle. Pure given the meshes (`discoverSceneActors`
 * already loads one per part).
 */
export function discoverInteractives(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, options: DiscoverInteractivesOptions = {}): InteractiveDiscovery {
  const exclude = options.exclude ?? new Set<ParsedBrick>();
  const skipped: InteractiveDiscovery['skipped'] = [];
  const warnings: string[] = [];
  const meshOf = (b: ParsedBrick): LdrawPartMesh | null => { const m = meshes.get(b.part); return m && m.triangles.length ? m : null; };
  const candidates: Array<{ brick: ParsedBrick; mesh: LdrawPartMesh; kind: InteractiveKind }> = [];
  for (const b of bricks) {
    if (exclude.has(b)) continue;
    const m = meshOf(b);
    if (!m) continue;
    const kind = interactiveKindOf(m.description);
    if (kind) candidates.push({ brick: b, mesh: m, kind });
  }
  const primaries = new Set(candidates.map(c => c.brick));
  // Every static placement's world box, for attachments and for the sweep.
  const boxes = new Map<ParsedBrick, Box>();
  for (const b of bricks) { if (exclude.has(b)) continue; const m = meshOf(b); if (m) boxes.set(b, worldBox(b, m)); }
  const taken = new Set<ParsedBrick>();
  const found: SceneInteractive[] = [];

  for (const { brick, mesh, kind: rawKind } of candidates) {
    const part = cleanPartId(brick.part);
    let kind = rawKind;
    const R = brick.rot ?? IDENTITY;
    const box = boxes.get(brick)!;
    if (kind === 'lever' || kind === 'turnable') {
      const axisLocal = kind === 'lever' ? 0 : turnAxisOf(mesh.description, mesh);
      const axisLdu = norm(apply(R, unit(axisLocal)));
      const localCentre: Vec3 = kind === 'lever' ? [0, 0, 0] : scale(add(mesh.bounds.min, mesh.bounds.max), 0.5);
      const pivotLdu = toWorld(brick, localCentre);
      const assembly = kind === 'turnable' && /\bTurntable\b/i.test(mesh.description)
        ? turntableLoad(brick, mesh, pivotLdu, axisLdu, bricks, boxes, exclude, primaries, taken)
        : [brick];
      for (const b of assembly) taken.add(b);
      const bounds = unionBox(assembly.map(b => boxes.get(b)!));
      found.push({ kind, part, description: mesh.description, bricks: assembly, pivotLdu, axisLdu, angleDeg: OPEN_DEG[kind], anchorLdu: bottomCentre(bounds), boundsLdu: bounds, offGridDeg: 0 });
      continue;
    }
    // Leaf-like: door, gate, cabinet, window, hatch.
    const h = leafHinge(kind, mesh.description, mesh);
    if (h.offCentre < MIN_HINGE_OFF_CENTRE) {
      skipped.push({ part, kind, reason: 'the mould origin is centred, so it names no hinge edge (a frame, an archway or a fixed pane)' });
      continue;
    }
    const lineWorld = norm(apply(R, unit(h.lineAxis)));
    const vertical = Math.abs(lineWorld[1]);
    if ((kind === 'hatch' ? vertical > 0.5 : kind === 'window' && h.lineAxis !== 1 ? false : vertical < 0.8)) {
      skipped.push({ part, kind, reason: kind === 'hatch' ? 'a hatch standing on edge' : 'a leaf lying on its side' });
      continue;
    }
    // Door leaves too short to be a doorway are cupboards.
    const { min: lmin, max: lmax } = mesh.bounds;
    const lineLen = lmax[h.lineAxis]! - lmin[h.lineAxis]!, swingLen = Math.abs(h.freeAt - h.hingeAt);
    if (kind === 'door' && lineLen < DOORWAY_MIN_HEIGHT_LDU) kind = 'cabinet';
    const thinMid = (lmin[h.thinAxis]! + lmax[h.thinAxis]!) / 2;
    const localPoint = (swing: number, line: number, thin: number): Vec3 => {
      const p: Vec3 = [0, 0, 0]; p[h.swingAxis] = swing; p[h.lineAxis] = line; p[h.thinAxis] = thin; return p;
    };
    // LDraw Y is down: a door's plane runs from its bottom (local max Y) up.
    const lineFrom = h.lineAxis === 1 ? lmax[1]! : lmin[h.lineAxis]!, lineTo = h.lineAxis === 1 ? lmin[1]! : lmax[h.lineAxis]!;
    const corner = toWorld(brick, localPoint(h.hingeAt, lineFrom, thinMid));
    const along = sub(toWorld(brick, localPoint(h.freeAt, lineFrom, thinMid)), corner);
    const up = sub(toWorld(brick, localPoint(h.hingeAt, lineTo, thinMid)), corner);
    const normal = norm(apply(R, unit(h.thinAxis)));
    const leaf: LeafPlane = { corner, along, up, normal, thicknessLdu: lmax[h.thinAxis]! - lmin[h.thinAxis]! };
    const pivotLdu = toWorld(brick, localPoint(h.hingeAt, (lmin[h.lineAxis]! + lmax[h.lineAxis]!) / 2, thinMid));
    const axisLdu = lineWorld;
    // What rides on the leaf: placements inside its own outline (glass inserts,
    // stickers) or standing off its face within LEAF_ATTACH_LDU (a handle, a
    // knocker, a letterbox) - within the leaf's width and height either way,
    // so the wall around the doorway never swings with it.
    const assembly = [brick];
    for (const [b, bb] of boxes) {
      if (b === brick || primaries.has(b) || taken.has(b)) continue;
      const pad = LEAF_ATTACH_LDU + 4;
      if (bb.max[0] < box.min[0] - pad || bb.min[0] > box.max[0] + pad || bb.max[1] < box.min[1] - pad || bb.min[1] > box.max[1] + pad || bb.max[2] < box.min[2] - pad || bb.min[2] > box.max[2] + pad) continue;
      const m = meshOf(b);
      if (!m || /\bFrame\b/i.test(m.description)) continue;
      const inside = cornersOf(m.bounds.min, m.bounds.max).every(c => {
        const l = toLocal(brick, toWorld(b, c));
        return [0, 1, 2].every(i => l[i]! >= lmin[i]! - (i === h.thinAxis ? LEAF_ATTACH_LDU : 3) && l[i]! <= lmax[i]! + (i === h.thinAxis ? LEAF_ATTACH_LDU : 3));
      });
      if (inside) assembly.push(b);
    }
    for (const b of assembly) taken.add(b);
    const bounds = unionBox(assembly.map(b => boxes.get(b)!));
    // Which way it swings: sample the leaf, turn it both ways, count samples
    // inside other parts. A hatch swings its free edge UP.
    const magnitude = OPEN_DEG[kind];
    const samples: Vec3[] = [];
    for (const s of [0.35, 0.65, 0.95]) for (const t of [0.2, 0.5, 0.8]) samples.push(add(add(corner, scale(along, s)), scale(up, t)));
    const obstacles = [...boxes].filter(([b]) => !assembly.includes(b)).map(([, bb]) => bb);
    const reach = Math.hypot(...along) + Math.hypot(...up);
    const near = obstacles.filter(bb => bb.max[0] > pivotLdu[0] - reach && bb.min[0] < pivotLdu[0] + reach && bb.max[1] > pivotLdu[1] - reach && bb.min[1] < pivotLdu[1] + reach && bb.max[2] > pivotLdu[2] - reach && bb.min[2] < pivotLdu[2] + reach);
    const hits = (deg: number): number => samples.reduce((n, p) => { const q = rotateAbout(p, pivotLdu, axisLdu, deg); return n + (near.some(bb => inBox(q, bb, 1)) ? 1 : 0); }, 0);
    let sign = 1;
    const plus = hits(magnitude), minus = hits(-magnitude);
    if (kind === 'hatch') {
      const free = add(corner, add(along, scale(up, 0.5)));
      sign = rotateAbout(free, pivotLdu, axisLdu, magnitude)[1] <= rotateAbout(free, pivotLdu, axisLdu, -magnitude)[1] ? 1 : -1;
    } else sign = minus < plus ? -1 : 1;
    // Off-grid: the width direction's angle from the nearest horizontal grid axis.
    const fromX = Math.atan2(Math.abs(along[2]), Math.abs(along[0])) * 180 / Math.PI;
    const offGridDeg = Math.round(Math.min(fromX, 90 - fromX) * 10) / 10;
    const opening = kind === 'door' || kind === 'gate' ? { width: swingLen, height: lineLen } : kind === 'hatch' ? { width: lineLen, height: swingLen } : undefined;
    found.push({
      kind, part, description: mesh.description, bricks: assembly, pivotLdu, axisLdu, angleDeg: sign * magnitude, leaf,
      anchorLdu: bottomCentre(bounds), boundsLdu: bounds, ...(opening ? { openingLdu: opening } : {}), offGridDeg,
      sweep: { chosen: sign > 0 ? plus : minus, other: sign > 0 ? minus : plus },
    });
  }
  // The cap: doorways first, then mechanisms, then cabinets and windows.
  const rank: Record<InteractiveKind, number> = { door: 0, gate: 0, hatch: 1, turnable: 2, lever: 2, cabinet: 3, window: 4 };
  const cap = options.max ?? MAX_INTERACTIVES;
  const ordered = found.map((it, i) => ({ it, i })).sort((a, b) => rank[a.it.kind] - rank[b.it.kind] || a.i - b.i);
  const items = ordered.slice(0, cap).sort((a, b) => a.i - b.i).map(o => o.it);
  for (const { it } of ordered.slice(cap)) skipped.push({ part: it.part, kind: it.kind, reason: `over the ${cap}-part cap (it stays static in the building)` });
  if (ordered.length > cap) warnings.push(`${ordered.length - cap} interactive part${ordered.length - cap === 1 ? '' : 's'} over the ${cap}-part cap stay static (doorways are kept first).`);
  return { items, skipped, warnings };
}

function unionBox(list: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let i = 0; i < 3; i++) { if (b.min[i]! < min[i]!) min[i] = b.min[i]!; if (b.max[i]! > max[i]!) max[i] = b.max[i]!; }
  return { min, max };
}
/** LDraw Y is down: the bottom is the largest y. */
const bottomCentre = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];

/** Parts carried by a turntable top: stacked on it (above its top face along the axis), near the axis, touching the load, at most `TURNTABLE_LOAD_MAX`. */
const TURNTABLE_LOAD_MAX = 60;
function turntableLoad(top: ParsedBrick, mesh: LdrawPartMesh, pivot: Vec3, axis: Vec3, bricks: readonly ParsedBrick[], boxes: ReadonlyMap<ParsedBrick, Box>, exclude: ReadonlySet<ParsedBrick>, primaries: ReadonlySet<ParsedBrick>, taken: ReadonlySet<ParsedBrick>): ParsedBrick[] {
  // "Up" along the axis is LDraw -Y turned by the placement; the top face is the part's extreme along it.
  const upDir: Vec3 = dot(axis, [0, -1, 0]) >= 0 ? axis : scale(axis, -1);
  const topBox = boxes.get(top)!;
  const topFace = Math.max(...cornersOf(topBox.min, topBox.max).map(c => dot(sub(c, pivot), upDir)));
  const radius = Math.max(mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[2] - mesh.bounds.min[2]) * 1.5;
  const radial = (p: Vec3): number => { const v = sub(p, pivot); const along = dot(v, upDir); return Math.hypot(...sub(v, scale(upDir, along))); };
  const load = [top];
  const loadBoxes = [topBox];
  const touches = (a: Box, b: Box): boolean => a.min[0] <= b.max[0] + 1 && a.max[0] >= b.min[0] - 1 && a.min[1] <= b.max[1] + 1 && a.max[1] >= b.min[1] - 1 && a.min[2] <= b.max[2] + 1 && a.max[2] >= b.min[2] - 1;
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of bricks) {
      if (load.includes(b) || exclude.has(b) || primaries.has(b) || taken.has(b)) continue;
      const bb = boxes.get(b);
      if (!bb) continue;
      const corners = cornersOf(bb.min, bb.max);
      if (corners.some(c => dot(sub(c, pivot), upDir) < topFace - 2 || radial(c) > radius)) continue;
      if (!loadBoxes.some(l => touches(l, bb))) continue;
      load.push(b); loadBoxes.push(bb); grew = true;
      if (load.length > TURNTABLE_LOAD_MAX) return [top];
    }
  }
  return load;
}

// ─── Collider cells ──────────────────────────────────────────────────────────

/** A collider cell: `[x, y, z, lo, hi]` in the 100 % grid (lo/hi sixteenths). */
export type IxCell = [number, number, number, number, number];

/**
 * The world blocks a set of grid cells lays at wand factor `f` and quarter
 * turn `r`, relative to the placement's anchor: `"x,y,z" -> [lo, hi]`. EXACTLY
 * the arithmetic `placeColliders` (bedrock-placement-pack.ts) uses for a
 * re-lay and the structure's own turn at 100 %: the turned cell, the world
 * columns it owns (`cellColumns`: the centre rule at f >= 1, any overlap
 * below), the rows its sixteenth span crosses, and a block two cells share
 * keeps the lowest lo and highest hi. Plain JavaScript: it is serialised into
 * the pack's runtime and used by the walk preview and the tests unchanged.
 */
export function ixWorldBlocks(cells: ReadonlyArray<readonly number[]>, dims: { width: number; length: number }, f: number, r: number): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const cols = (i: number): [number, number] => {
    const a = i * f, b = (i + 1) * f;
    if (f < 1) return [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)];
    return [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)];
  };
  const turn = (x: number, z: number): { x: number; z: number } => r === 90 ? { x: dims.length - 1 - z, z: x } : r === 180 ? { x: dims.width - 1 - x, z: dims.length - 1 - z } : r === 270 ? { x: z, z: dims.width - 1 - x } : { x, z };
  for (const c of cells) {
    const x = c[0]!, y = c[1]!, z = c[2]!, lo = c[3]!, hi = c[4]!;
    const rc = turn(x, z);
    const cx = cols(rc.x), cz = cols(rc.z);
    const wy0 = (y + lo / 16) * f, wy1 = (y + hi / 16) * f;
    for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
      const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
      const h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
      for (let wx = cx[0]; wx <= cx[1]; wx++) for (let wz = cz[0]; wz <= cz[1]; wz++) {
        const key = `${wx},${wy},${wz}`;
        const prev = out.get(key);
        if (prev) { prev[0] = Math.min(prev[0], l); prev[1] = Math.max(prev[1], h); }
        else out.set(key, [l, h]);
      }
    }
  }
  return out;
}

/** What the doorway cut did to one passage interactive, and what its runtime needs. */
export interface InteractiveColliderPlan {
  /** Cells the closed leaf fills (air in the static grid; the runtime lays them while closed). */
  blocking: IxCell[];
  /** Static collider cells within `NEIGHBOUR_REACH` of them: restored exactly when the leaf opens. */
  neighbours: IxCell[];
  /** Static cells the cut turned to air: the leaf's own cells and the passage to the rooms either side. */
  cleared: number;
  passageCleared: number;
}

/** Cells either side (and above / below) of a leaf whose static state the runtime must know: a block at 25 % holds four cells. */
const NEIGHBOUR_REACH = 3;
const LEAF_SAMPLE_FROM = 0.15, LEAF_SAMPLE_TO = 0.85;
/** The passage: how far past the leaf (cells) it may be cut, the highest floor a player steps onto (sixteenths, the walk's 9/16 step) and the lowest ceiling in the row above head height (sixteenths). */
const PASSAGE_REACH_CELLS = 3;
const PASSAGE_STEP16 = 9;
const PASSAGE_HEAD16 = 8;

/**
 * Cut every passage interactive's doorway into the COLLIDER grid (not the
 * voxel grid, which is half a block off the entity world - CLAUDE.md) and
 * record what the runtime lays while it is closed.
 *
 * A leaf's cells are the columns its mid-plane crosses between 15 % and 85 %
 * of its width (a 1.5-block door clears two columns, a 1.1-block one clears
 * one: the sliver past the leaf stays wall) and the rows its box spans; they
 * become air here and are the closed-state `blocking` cells, lo/hi from the
 * leaf's own height. A door or gate also opens a PASSAGE: from each leaf
 * column, along the leaf's normal both ways, the solid cells between the leaf
 * and the first two-row air within three cells (a frame 20 LDU thick
 * straddling a cell boundary is two blocks deep). A hatch opens only its own
 * cells: below it is whatever the model put there.
 */
export function planInteractiveColliders(grid: BlockGrid, items: readonly SceneInteractive[], frame: SceneGridFrame): Array<InteractiveColliderPlan | null> {
  const isCollider = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < grid.width && y < grid.height && z < grid.length && grid.get(x, y, z).startsWith(COLLIDER_BLOCK_ID);
  const inGrid = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < grid.width && y < grid.height && z < grid.length;
  const plans: Array<InteractiveColliderPlan | null> = [];
  const blockingAll: IxCell[][] = [];
  for (const it of items) {
    if (!PASSAGE_KINDS.has(it.kind) || !it.leaf) { plans.push(null); blockingAll.push([]); continue; }
    const g = (p: Vec3): Vec3 => sceneGridPoint(frame, p);
    const { corner, along, up } = it.leaf;
    // The leaf box's vertical span in grid rows (the leaf's thickness included, from its own AABB).
    const ys = cornersOf(it.boundsLdu.min, it.boundsLdu.max).map(c => g(c)[1]);
    const yLo = Math.min(...ys), yHi = Math.max(...ys);
    const rowFrom = Math.max(0, Math.floor(yLo + 0.02)), rowTo = Math.min(grid.height - 1, Math.ceil(yHi - 0.02) - 1);
    // Columns: the mid-plane sampled over the leaf, every quarter cell.
    const gAlong = sub(g(add(corner, along)), g(corner)), gUp = sub(g(add(corner, up)), g(corner));
    const nS = Math.max(2, Math.ceil(Math.hypot(gAlong[0], gAlong[2]) * 4) + 1), nT = it.kind === 'hatch' ? Math.max(2, Math.ceil(Math.hypot(gUp[0], gUp[2]) * 4) + 1) : 1;
    const columns = new Map<string, [number, number]>();
    for (let i = 0; i < nS; i++) for (let j = 0; j < nT; j++) {
      const s = LEAF_SAMPLE_FROM + (LEAF_SAMPLE_TO - LEAF_SAMPLE_FROM) * i / (nS - 1);
      const t = nT === 1 ? 0.5 : LEAF_SAMPLE_FROM + (LEAF_SAMPLE_TO - LEAF_SAMPLE_FROM) * j / (nT - 1);
      const p = g(add(add(corner, scale(along, s)), scale(up, t)));
      const cx = Math.floor(p[0]), cz = Math.floor(p[2]);
      columns.set(`${cx},${cz}`, [cx, cz]);
    }
    const blocking: IxCell[] = [];
    let cleared = 0, passageCleared = 0;
    /** A static collider cell's span, or null. */
    const staticSpan = (x: number, y: number, z: number): [number, number] | null => {
      if (!isCollider(x, y, z)) return null;
      const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(grid.get(x, y, z));
      return m ? [Number(m[1]), Number(m[2])] : [0, 16];
    };
    /**
     * A closed door must reach the floor it stands over: a leaf hung a plate
     * or two above it (a threshold, a frame's sill, a raised step) leaves a
     * gap that the wand's size multiplies - 0.7 block under 31141's corner
     * door at 100 % is 2.1 at 300 %, taller than the player, who walked
     * under the closed door. So the closed cells run down to the top of the
     * static floor below the leaf, within two rows.
     */
    const floorUnder = (x: number, z: number): number => {
      for (let y = rowFrom; y >= Math.max(0, rowFrom - 2); y--) {
        const span = staticSpan(x, y, z);
        if (span && y + span[0] / 16 < yLo - 1e-6) return Math.min(yLo, y + span[1] / 16);
      }
      return yLo;
    };
    for (const [cx, cz] of columns.values()) {
      const bottom = it.kind === 'hatch' ? yLo : floorUnder(cx, cz);
      for (let y = Math.max(0, Math.floor(bottom + 0.02)); y <= rowTo; y++) {
      if (!inGrid(cx, y, cz)) continue;
      const lo = Math.max(0, Math.min(15, Math.floor((bottom - y) * 16 + 1e-6)));
      const hi = Math.max(lo + 1, Math.min(16, Math.ceil((yHi - y) * 16 - 1e-6)));
      blocking.push([cx, y, cz, lo, hi]);
      if (!isCollider(cx, y, cz)) continue;
      // Only the leaf's own span is opened. What the cell holds ABOVE the
      // leaf (the lintel over a door, the part of a floor slab above a hatch)
      // or BELOW it (a threshold, the floor under a leaf that starts a plate
      // up) stays static: cleared whole, a lintel's share of the top row
      // becomes a gap over the closed leaf, and at 400 % that gap is taller
      // than the player - the door is walked over.
      const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(grid.get(cx, y, cz));
      const [slo, shi] = m ? [Number(m[1]), Number(m[2])] : [0, 16];
      const above = shi > hi ? [Math.max(slo, hi), shi] as const : null;
      const below = slo < lo ? [slo, Math.min(shi, lo)] as const : null;
      // One span per cell: keep the larger of the two when a leaf sits inside a single row.
      const keep = above && below ? (above[1] - above[0] >= below[1] - below[0] ? above : below) : above ?? below;
      if (keep && keep[1] > keep[0]) grid.set(cx, y, cz, colliderState(keep[0], keep[1]));
      else grid.set(cx, y, cz, 'minecraft:air');
      cleared++;
      }
    }
    if (it.kind !== 'hatch') {
      // The passage, along the leaf's horizontal normal, both ways: a
      // column a player can stand in at the doorway's floor (row y0 at most a
      // step high, row y0+1 free, row y0+2 free below its middle) ends it;
      // the columns between are opened to that shape.
      const n = it.leaf.normal;
      const gn = norm([g(add(corner, n))[0] - g(corner)[0], 0, g(add(corner, n))[2] - g(corner)[2]]);
      const y0 = rowFrom;
      const spanAt = (x: number, y: number, z: number): [number, number] | null => {
        if (!isCollider(x, y, z)) return null;
        const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(grid.get(x, y, z));
        return m ? [Number(m[1]), Number(m[2])] : [0, 16];
      };
      const standable = (x: number, z: number): boolean => {
        const a = spanAt(x, y0, z), b = spanAt(x, y0 + 1, z), c = spanAt(x, y0 + 2, z);
        return (!a || a[1] <= PASSAGE_STEP16) && !b && (!c || c[0] >= PASSAGE_HEAD16);
      };
      const openUp = (x: number, z: number): void => {
        const a = spanAt(x, y0, z), c = spanAt(x, y0 + 2, z);
        if (a && a[1] > PASSAGE_STEP16) { grid.set(x, y0, z, 'minecraft:air'); passageCleared++; }
        if (spanAt(x, y0 + 1, z)) { grid.set(x, y0 + 1, z, 'minecraft:air'); passageCleared++; }
        if (c && c[0] < PASSAGE_HEAD16) { grid.set(x, y0 + 2, z, 'minecraft:air'); passageCleared++; }
      };
      // A player moves between columns that share a FACE: a step along a
      // diagonal normal (a 45-degree leaf) that changes both x and z also
      // opens the connector column between them (the less solid of the two),
      // or the passage is a chain of corners no 0.6-wide box fits through.
      const solidity = (x: number, z: number): number => [y0, y0 + 1, y0 + 2].reduce((n, y) => n + (spanAt(x, y, z) ? 1 : 0), 0);
      for (const [cx, cz] of columns.values()) for (const dir of [1, -1]) {
        const cells: Array<[number, number]> = [];
        let open = false, px = cx, pz = cz;
        const visit = (x: number, z: number): 'open' | 'go' => {
          if (x < 0 || z < 0 || x >= grid.width || z >= grid.length) return 'open';
          // The leaf's own columns are the doorway, already cut to its span: the
          // passage never widens them (it would clear the floor or the lintel
          // the closed leaf merges with).
          if (columns.has(`${x},${z}`)) return 'go';
          if (!cells.some(([a, b]) => a === x && b === z)) {
            if (standable(x, z)) return 'open';
            cells.push([x, z]);
          }
          return 'go';
        };
        for (let k = 0.25; k <= PASSAGE_REACH_CELLS + 0.01; k += 0.25) {
          const x = Math.floor(cx + 0.5 + gn[0] * dir * k), z = Math.floor(cz + 0.5 + gn[2] * dir * k);
          if ((x === px && z === pz) || (x === cx && z === cz)) continue;
          if (x !== px && z !== pz) {
            const [ax, az] = solidity(x, pz) <= solidity(px, z) ? [x, pz] : [px, z];
            if (visit(ax, az) === 'open') { open = true; break; }
          }
          px = x; pz = z;
          if (visit(x, z) === 'open') { open = true; break; }
        }
        if (!open) continue;
        for (const [x, z] of cells) openUp(x, z);
      }
    }
    blockingAll.push(blocking);
    plans.push({ blocking, neighbours: [], cleared, passageCleared });
  }
  // Neighbours from the FINAL grid (after every cut), so a double door's two
  // leaves see each other's cells as air, never as a wall.
  plans.forEach((plan, i) => {
    if (!plan || !plan.blocking.length) return;
    const xs = plan.blocking.map(c => c[0]), ys = plan.blocking.map(c => c[1]), zs = plan.blocking.map(c => c[2]);
    const own = new Set(plan.blocking.map(c => `${c[0]},${c[1]},${c[2]}`));
    for (let x = Math.min(...xs) - NEIGHBOUR_REACH; x <= Math.max(...xs) + NEIGHBOUR_REACH; x++)
      for (let y = Math.min(...ys) - NEIGHBOUR_REACH; y <= Math.max(...ys) + NEIGHBOUR_REACH; y++)
        for (let z = Math.min(...zs) - NEIGHBOUR_REACH; z <= Math.max(...zs) + NEIGHBOUR_REACH; z++) {
          if (!inGrid(x, y, z) || own.has(`${x},${y},${z}`)) continue;
          const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(grid.get(x, y, z));
          if (m && grid.get(x, y, z).startsWith(COLLIDER_BLOCK_ID)) plan.neighbours.push([x, y, z, Number(m[1]), Number(m[2])]);
        }
    void i;
  });
  return plans;
}

/**
 * The first wand size (percent, 100…400) at which an opening of `widthLdu` x
 * `heightLdu` clears the player's 1 x 2-block passage (a hatch: 1 x 1, it is a
 * hole to drop through); 0 when none does.
 */
export function passSizeFor(kind: InteractiveKind, opening: { width: number; height: number } | undefined, steps: readonly number[] = [100, 150, 200, 300, 400]): number {
  if (!opening) return 0;
  const w = opening.width / LDU_PER_BLOCK, h = opening.height / LDU_PER_BLOCK;
  const needH = kind === 'hatch' ? PASSAGE_WIDTH_BLOCKS : kind === 'gate' ? 0 : PASSAGE_HEIGHT_BLOCKS;
  return steps.find(pct => w * pct / 100 + 1e-9 >= PASSAGE_WIDTH_BLOCKS && h * pct / 100 + 1e-9 >= needH) ?? 0;
}

// ─── Entities ────────────────────────────────────────────────────────────────

/** The actor property (float: Bedrock drops an integer-literal default). */
export function interactiveProperties(): Record<string, unknown> {
  return { [INTERACTIVE_PROPERTY]: floatActorProperty(ANGLE_RANGE, 0) };
}

/**
 * The client animation: the spin bone follows `v.ix_angle`, which the
 * client's own pre-animation script eases toward the property at
 * `rateDegPerSecond` (the whole swing takes `SWING_SECONDS`), so one property
 * write per toggle gives a smooth per-frame swing. The geometry writer negates
 * X and Y rotations into Bedrock's convention (`jsonBone`), so the animation
 * does too: a positive property is a right-handed turn about the axis.
 */
export function interactiveAnimation(typeId: string, rateDegPerSecond: number): { id: string; file: unknown; initialize: string[]; preAnimation: string[] } {
  const id = `animation.${typeId.replace(':', '.')}.turn`;
  const rate = Math.round(rateDegPerSecond * 10) / 10;
  return {
    id,
    file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones: { [SPIN_BONE]: { rotation: [0, '-v.ix_angle', 0] } } } } },
    initialize: [`v.ix_angle = q.property('${INTERACTIVE_PROPERTY}');`],
    preAnimation: [`v.ix_angle = v.ix_angle + math.clamp(q.property('${INTERACTIVE_PROPERTY}') - v.ix_angle, -q.delta_time * ${rate}, q.delta_time * ${rate});`],
  };
}

/** The interact prompt a touch screen shows for each class (lang keys; `interactiveLangLines`). */
export const INTERACT_TEXT: Readonly<Record<InteractiveKind, string>> = {
  door: 'action.interact.craftmatic_open', gate: 'action.interact.craftmatic_open', cabinet: 'action.interact.craftmatic_open',
  window: 'action.interact.craftmatic_open', hatch: 'action.interact.craftmatic_open', lever: 'action.interact.craftmatic_use', turnable: 'action.interact.craftmatic_turn',
};
export const interactiveLangLines = (): string[] => [
  'action.interact.craftmatic_open=Open / close',
  'action.interact.craftmatic_use=Use',
  'action.interact.craftmatic_turn=Turn',
];

/**
 * The tap box: centred on the entity (the closed part's bottom centre), wide
 * enough that a leaf swung open about its edge is still under a finger, as
 * tall as the part (a hatch: as tall as it stands when open). Bedrock picks a
 * tap by this box AND only on an entity that renders cubes (device 2026-09-24);
 * the part's own cubes are that.
 */
export function interactiveCollision(it: SceneInteractive): { width: number; height: number } {
  const ext = sub(it.boundsLdu.max, it.boundsLdu.min).map(v => v / LDU_PER_BLOCK);
  const horizontal = Math.max(ext[0]!, ext[2]!);
  const leafLike = it.kind !== 'turnable' && it.kind !== 'lever';
  const width = Math.max(0.4, leafLike ? 1.5 * horizontal : horizontal);
  const height = Math.max(0.4, it.kind === 'hatch' ? horizontal : ext[1]!);
  return { width: Math.round(width * 1000) / 1000, height: Math.round(height * 1000) / 1000 };
}

/** The behaviour: static, unhurt, not pushed, tap- and interact-able, keeps its state across reloads. */
export function interactiveBehavior(typeId: string, it: SceneInteractive): unknown {
  const collision = interactiveCollision(it);
  return withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true, properties: interactiveProperties() },
    components: {
      'minecraft:type_family': { family: [INTERACTIVE_FAMILY, `craftmatic_ix_${it.kind}`] },
      'minecraft:persistent': {}, 'minecraft:nameable': {},
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
      'minecraft:fire_immune': {},
      'minecraft:knockback_resistance': { value: 1 },
      'minecraft:collision_box': collision,
      'minecraft:physics': { has_gravity: false, has_collision: false },
      // NOT `minecraft:pushable`: format 1.26.30 dropped it and the whole entity then fails to load.
      'minecraft:pushable_by_block': {},
      'minecraft:interact': { interactions: [{ interact_text: INTERACT_TEXT[it.kind], swing: true }] },
    },
  } }, collision);
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface InteractiveRuntimeItem {
  type: string;
  kind: InteractiveKind;
  label: string;
  /** Open angle (signed) or a turnable's step, degrees. */
  angle: number;
  /** Doorways: the smallest wand size (percent) at which the opening is passable; 0 = at no size. Absent: not a doorway. */
  passSize?: number;
  /** The opening at 100 %, blocks (doorways). */
  opening?: { width: number; height: number };
  /** Closed-state cells and the static cells around them (doorways). */
  blocking: IxCell[];
  neighbours: IxCell[];
  /** The other leaves of the same doorway (a double door): their closed cells share or touch this one's. They open and close together. */
  shares: number[];
  sounds: { open: string; close: string };
  /** The hinge point and unit axis in model blocks at 100 % (the placement's frame). The walk preview swings the part about it; the runtime does not need it. */
  pivot?: [number, number, number];
  axis?: [number, number, number];
  /** A leaf's unit normal (across its thickness) in model blocks: the way a player walks through its doorway. */
  normal?: [number, number, number];
}

export interface InteractiveRuntimeConfig {
  family: string;
  property: string;
  label: string;
  /** The 100 % grid (the placement's own dims). */
  dims: { width: number; height: number; length: number };
  colliders: { block: string; loState: string; hiState: string };
  items: InteractiveRuntimeItem[];
}

/** The dynamic properties the placement writes on a spawned interactive and the runtime keeps its state in. */
export const IX_KEYS = {
  index: 'craftmatic:ix', anchor: 'craftmatic:ix_anchor', rotation: 'craftmatic:ix_rotation', scale: 'craftmatic:ix_scale',
  open: 'craftmatic:ix_open', angle: 'craftmatic:ix_angle', ready: 'craftmatic:ix_ready',
} as const;

/** Round an open angle for the config (tenths). */
const r1 = (v: number): number => Math.round(v * 10) / 10;

export function interactiveRuntimeItem(it: SceneInteractive, type: string, label: string, plan: InteractiveColliderPlan | null): InteractiveRuntimeItem {
  const doorway = PASSAGE_KINDS.has(it.kind);
  const opening = it.openingLdu ? { width: r1(it.openingLdu.width / LDU_PER_BLOCK), height: r1(it.openingLdu.height / LDU_PER_BLOCK) } : undefined;
  const leafSounds = { open: 'random.door_open', close: 'random.door_close' };
  return {
    type, kind: it.kind, label, angle: r1(it.angleDeg),
    ...(doorway ? { passSize: passSizeFor(it.kind, it.openingLdu) } : {}),
    ...(opening && doorway ? { opening } : {}),
    blocking: plan?.blocking ?? [], neighbours: plan?.neighbours ?? [], shares: [],
    sounds: it.kind === 'turnable' || it.kind === 'lever' ? { open: 'random.click', close: 'random.click' } : leafSounds,
  };
}

/** Fill `shares`: doorways whose blocking cells overlap. */
export function linkSharedDoorways(items: InteractiveRuntimeItem[]): void {
  // Two leaves are one doorway when their closed cells share a cell or touch
  // (a column apart, rows overlapping): a double door, whose leaves open and
  // close together and whose shared cells stay laid while either is closed.
  const touch = (a: IxCell, b: IxCell): boolean => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[2] - b[2]) <= 1 && a[1] === b[1];
  items.forEach((a, i) => items.forEach((b, j) => {
    if (i >= j || a.kind !== b.kind || !a.blocking.length || !b.blocking.length) return;
    if (!a.blocking.some(ca => b.blocking.some(cb => touch(ca, cb)))) return;
    if (!a.shares.includes(j)) a.shares.push(j);
    if (!b.shares.includes(i)) b.shares.push(i);
  }));
}

/**
 * The runtime, serialised into `scripts/interactives.js` with `.toString()`:
 * it may not reference anything outside itself and `worldBlocks` (which is
 * `ixWorldBlocks`, handed in the same way).
 *
 * - A tap (`entityHitEntity`) or an interact (`playerInteractWithEntity`) on an
 *   interactive toggles it (a turnable turns a step); a second event within
 *   6 ticks is the same tap reported twice and is ignored.
 * - A doorway lays its closed cells as colliders while closed, and restores
 *   the static state (its neighbours) when opened - but only when the opening
 *   is passable at the placed size (`passSize`); smaller, it swings open and
 *   stays blocked, and says at which size it can be walked through.
 * - It refuses to close on a player or a figure standing in the doorway.
 * - State lives in the entity's dynamic properties and its actor property, so
 *   it survives a reload; a freshly placed part (no `ready` flag) is laid
 *   closed on the next sync pass.
 */
function interactivesRuntime(config: InteractiveRuntimeConfig, worldBlocks: typeof ixWorldBlocks): void {
  const K = { index: 'craftmatic:ix', anchor: 'craftmatic:ix_anchor', rotation: 'craftmatic:ix_rotation', scale: 'craftmatic:ix_scale', open: 'craftmatic:ix_open', angle: 'craftmatic:ix_angle', ready: 'craftmatic:ix_ready' };
  const C = config.colliders;
  const byType = new Map<string, number>();
  config.items.forEach((it, i) => byType.set(it.type, i));
  const lastUse = new Map<string, number>();
  const synced = new Set<string>();
  const percent = (n: number): string => `${n} percent`;
  const say = (p: any, s: string): void => { try { p.onScreenDisplay.setActionBar(s); } catch { /* player left */ } };
  const itemOf = (e: any): number | undefined => {
    let i: any; try { i = e.getDynamicProperty(K.index); } catch { return undefined; }
    if (typeof i === 'number' && config.items[i] && config.items[i]!.type === e.typeId) return i;
    return byType.get(e.typeId);
  };
  const placementOf = (e: any): { anchor: any; r: number; f: number } | undefined => {
    let a: any, r: any, f: any;
    try { a = e.getDynamicProperty(K.anchor); r = e.getDynamicProperty(K.rotation); f = e.getDynamicProperty(K.scale); } catch { return undefined; }
    if (!a || typeof a.x !== 'number') return undefined;
    return { anchor: a, r: [0, 90, 180, 270].includes(r) ? r : 0, f: typeof f === 'number' && f > 0 ? f : 1 };
  };
  const passable = (it: any, pl: any): boolean => it.passSize !== undefined && it.passSize > 0 && Math.round(pl.f * 100) + 1e-9 >= it.passSize;
  const isOpen = (e: any): boolean => { try { return e.getDynamicProperty(K.open) === true; } catch { return false; } };
  const sameAnchor = (a: any, b: any): boolean => !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
  /** The sibling doorway entities sharing cells with item `i` at this placement, by item index. */
  const siblings = (e: any, i: number, pl: any): Map<number, any> => {
    const out = new Map<number, any>();
    const shares: number[] = config.items[i]!.shares || [];
    if (!shares.length) return out;
    let near: any[] = [];
    try { near = e.dimension.getEntities({ families: [config.family], location: e.location, maxDistance: 12 * Math.max(1, pl.f) }); } catch { /* unloaded */ }
    for (const s of near) {
      if (s.id === e.id) continue;
      const j = itemOf(s), sp = placementOf(s);
      if (j !== undefined && shares.includes(j) && sp && sameAnchor(sp.anchor, pl.anchor) && sp.r === pl.r && sp.f === pl.f) out.set(j, s);
    }
    return out;
  };
  const blocksClosed = (it: any, pl: any, open: boolean): boolean => !(open && passable(it, pl));
  /** Lay item `i`'s doorway for its state; siblings that are closed keep their shared cells. Returns false when a block was not loaded. */
  const layDoorway = (e: any, i: number, pl: any, open: boolean): boolean => {
    const it = config.items[i]!;
    if (!it.blocking.length) return true;
    const cells: number[][] = [...it.neighbours];
    if (blocksClosed(it, pl, open)) cells.push(...it.blocking);
    for (const [j, s] of siblings(e, i, pl)) if (blocksClosed(config.items[j]!, pl, isOpen(s))) cells.push(...config.items[j]!.blocking);
    const want = worldBlocks(cells, config.dims, pl.f, pl.r);
    const own = worldBlocks(it.blocking, config.dims, pl.f, pl.r);
    let ok = true;
    for (const key of own.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      const pos = { x: pl.anchor.x + x!, y: pl.anchor.y + y!, z: pl.anchor.z + z! };
      let b: any;
      try { b = e.dimension.getBlock(pos); } catch { b = undefined; }
      if (!b) { ok = false; continue; }
      const ours = b.typeId === C.block, air = b.isAir === true || b.typeId === 'minecraft:air';
      const st = want.get(key);
      try {
        if (st) {
          // Never overwrite a block that is not ours (the player built there).
          if (!ours && !air) continue;
          if (ours && Number(b.permutation.getState(C.loState)) === st[0] && Number(b.permutation.getState(C.hiState)) === st[1]) continue;
          b.setPermutation(BlockPermutation.resolve(C.block, { [C.loState]: st[0], [C.hiState]: st[1] }));
        } else if (ours) b.setPermutation(BlockPermutation.resolve('minecraft:air'));
      } catch { ok = false; }
    }
    return ok;
  };
  /** A player or a figure standing where the closed leaf would go (never close a door on someone). */
  const obstructed = (e: any, i: number, pl: any): boolean => {
    const it = config.items[i]!;
    if (!it.blocking.length) return false;
    const own = [...worldBlocks(it.blocking, config.dims, pl.f, pl.r).entries()].map(([key, span]) => { const [x, y, z] = key.split(',').map(Number); return { x: pl.anchor.x + x!, y: pl.anchor.y + y! + span[0] / 16, z: pl.anchor.z + z!, top: pl.anchor.y + y! + span[1] / 16 }; });
    if (!own.length) return false;
    // Search around the doorway's own blocks (the entity stands at the leaf's foot, but a wide double door reaches further).
    const cx = own.reduce((a, b) => a + b.x + 0.5, 0) / own.length, cy = own.reduce((a, b) => a + b.y, 0) / own.length, cz = own.reduce((a, b) => a + b.z + 0.5, 0) / own.length;
    const reach = Math.max(...own.map(b => Math.hypot(b.x + 0.5 - cx, b.y - cy, b.z + 0.5 - cz))) + 3;
    let near: any[] = [];
    try { near = e.dimension.getEntities({ location: { x: cx, y: cy, z: cz }, maxDistance: reach }); } catch { return false; }
    for (const o of near) {
      const t = String(o.typeId || '');
      if (t !== 'minecraft:player' && t.startsWith('craftmatic:') && !(o.getComponent && o.getComponent('minecraft:type_family')?.hasTypeFamily?.('craftmatic_figure'))) continue;
      const w = t === 'minecraft:player' ? 0.3 : 0.3, h = 1.8, l = o.location;
      if (own.some(bk => l.x + w > bk.x && l.x - w < bk.x + 1 && l.z + w > bk.z && l.z - w < bk.z + 1 && l.y + h > bk.y && l.y < bk.top)) return true;
    }
    return false;
  };
  const setAngle = (e: any, deg: number): void => { try { e.setProperty(config.property, deg); } catch { /* property component missing: the content log says why */ } };
  const sound = (e: any, id: string): void => { try { e.dimension.playSound(id, e.location, { volume: 1, pitch: 1 }); } catch { /* sound unknown */ } };
  const toggle = (e: any, player: any): void => {
    const i = itemOf(e), pl = placementOf(e);
    if (i === undefined || !pl) return;
    const it = config.items[i]!;
    if (it.kind === 'turnable') {
      let a = 0; try { a = Number(e.getDynamicProperty(K.angle)) || 0; } catch { /* fresh */ }
      a += it.angle;
      if (Math.abs(a) >= 36000) a -= Math.sign(a) * 36000;
      try { e.setDynamicProperty(K.angle, a); } catch { /* keep going */ }
      setAngle(e, a); sound(e, it.sounds.open);
      return;
    }
    const open = !isOpen(e);
    // A double door's leaves move together: the tapped one and its partners at this placement.
    const group: Array<{ e: any; i: number }> = [{ e, i }, ...[...siblings(e, i, pl)].map(([j, s]) => ({ e: s, i: j }))];
    if (!open && group.some(g => obstructed(g.e, g.i, pl))) { say(player, `Something is standing in the ${it.label.toLowerCase()} - step out to close it.`); return; }
    const before = group.map(g => isOpen(g.e));
    for (const g of group) { try { g.e.setDynamicProperty(K.open, open); } catch { /* keep going */ } }
    if (!group.every(g => layDoorway(g.e, g.i, pl, open))) {
      group.forEach((g, k) => { try { g.e.setDynamicProperty(K.open, before[k]); } catch { /* keep going */ } layDoorway(g.e, g.i, pl, before[k]!); });
      say(player, `The ${it.label.toLowerCase()} is not loaded - come closer.`);
      return;
    }
    for (const g of group) setAngle(g.e, open ? config.items[g.i]!.angle : 0);
    sound(e, open ? it.sounds.open : it.sounds.close);
    if (open && it.passSize !== undefined && !passable(it, pl)) {
      const size = it.opening ? `${it.opening.width} x ${it.opening.height} blocks at 100 percent` : 'too small';
      say(player, it.passSize > 0
        ? `This opening is ${size}: too small to walk through at ${percent(Math.round(pl.f * 100))}. Place the build at ${percent(it.passSize)} or larger to pass.`
        : `This opening is ${size}: too small to walk through at any wand size.`);
    }
  };
  const use = (player: any, target: any): void => {
    if (!target || !target.typeId || itemOf(target) === undefined) return;
    const now = system.currentTick;
    if (now - (lastUse.get(target.id) ?? -100) < 6) return;
    lastUse.set(target.id, now);
    system.run(() => toggle(target, player));
  };
  world.afterEvents.playerInteractWithEntity.subscribe((ev: any) => use(ev.player, ev.target));
  world.afterEvents.entityHitEntity.subscribe((ev: any) => { if (ev.damagingEntity && ev.damagingEntity.typeId === 'minecraft:player') use(ev.damagingEntity, ev.hitEntity); });
  // Sync: a freshly placed part is laid closed; a reloaded one gets its angle re-asserted once per session.
  system.runInterval(() => {
    for (const id of ['overworld', 'nether', 'the_end']) {
      let dim: any, list: any[] = [];
      try { dim = world.getDimension(id); list = dim.getEntities({ families: [config.family] }); } catch { continue; }
      for (const e of list) {
        if (synced.has(e.id)) continue;
        const i = itemOf(e), pl = placementOf(e);
        if (i === undefined || !pl) continue;
        const it = config.items[i]!;
        let ready = false; try { ready = e.getDynamicProperty(K.ready) === true; } catch { /* fresh */ }
        if (!ready) {
          if (it.blocking.length && !layDoorway(e, i, pl, isOpen(e))) continue; // not loaded yet: next pass
          try { e.setDynamicProperty(K.ready, true); } catch { /* next pass */ }
        }
        let a = 0;
        try { a = it.kind === 'turnable' ? Number(e.getDynamicProperty(K.angle)) || 0 : isOpen(e) ? it.angle : 0; } catch { /* default */ }
        setAngle(e, a);
        synced.add(e.id);
      }
    }
  }, 10);
  console.warn(`CRAFTMATIC_INTERACTIVES_READY ${config.label} ${config.items.length}`);
}

/** The behaviour pack's `scripts/interactives.js`. */
export function interactivesScript(config: InteractiveRuntimeConfig): string {
  return `import { world, system, BlockPermutation } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${interactivesRuntime.toString()})(CONFIG, ${ixWorldBlocks.toString()});\n`;
}

export { interactivesRuntime as _interactivesRuntimeForTests };

/**
 * The world blocks every CLOSED doorway lays at wand factor `f` and turn `r`,
 * with the exact merged state the runtime writes (`layDoorway`): the closed
 * leaves' cells over the static neighbours, keyed `"x,y,z"` from the anchor.
 * An open doorway that is passable at this size adds nothing (its blocks are
 * the static grid's); an open one too small to pass stays closed here, as in
 * the runtime. For the walk preview and the passability test.
 */
export function ixClosedBlocks(items: readonly InteractiveRuntimeItem[], dims: { width: number; length: number }, f: number, r: number, isOpen: (index: number) => boolean): Map<string, [number, number]> {
  const pct = Math.round(f * 100);
  const blocksAt = (i: number): boolean => {
    const it = items[i]!;
    if (!it.blocking.length) return false;
    return !(isOpen(i) && it.passSize !== undefined && it.passSize > 0 && pct >= it.passSize);
  };
  const closed = items.map((_, i) => i).filter(blocksAt);
  if (!closed.length) return new Map();
  const cells: number[][] = [];
  for (const i of closed) cells.push(...items[i]!.neighbours, ...items[i]!.blocking);
  const merged = ixWorldBlocks(cells, dims, f, r);
  const own = ixWorldBlocks(closed.flatMap(i => items[i]!.blocking), dims, f, r);
  const out = new Map<string, [number, number]>();
  for (const key of own.keys()) { const st = merged.get(key); if (st) out.set(key, st); }
  return out;
}
