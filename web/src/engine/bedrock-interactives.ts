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
 * A doorway smaller than a minifig at the placed size (`passSizeFor`: 0.75 x
 * 1.8 blocks at minifig scale, which holds the 0.6 x 1.8 player) still OPENS
 * (the leaf swings) but keeps its colliders, and says at which wand size it
 * becomes passable (`passSize`).
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { withClassifiedDescriptions, type LdrawPartMesh, type Vec3 } from './ldraw-part-geometry.js';
import type { EntityRig } from './minifig-rig.js';
import { BlockGrid } from '@craft/schem/types.js';
import { isDoorLeafDescription, sceneGridPoint, type SceneGridFrame } from './bedrock-scene-actors.js';
import { cleanPartId } from './ldraw-entity-compiler.js';
import { floatActorProperty } from './bedrock-json.js';
import { SIZE_EVENT_PREFIX, SIZE_STEPS } from './bedrock-placement-pack.js';
import { LDU_PER_BLOCK } from './lego-scale.js';
import { relayRounding } from './bedrock-collider-scale.js';
import { DOORWAY_PASS_HEIGHT_LDU, DOORWAY_PASS_WIDTH_LDU, PASSAGE_WIDTH_BLOCKS } from './addon-scale.js';
import { COLLIDER_BLOCK_ID, colliderState } from './bedrock-building-shell.js';
import { COLLIDER_KIT, colliderBodyProbe, colliderFormKit, type ColliderFormKit } from './collider-form.js';
import { LANDING_REACH, LANDING_RISE, LeakFlood, layerBoxes, parseFormState, type CellLayers } from './collider-clearance.js';

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
export type InteractiveKind = 'door' | 'gate' | 'cabinet' | 'window' | 'hatch' | 'lever' | 'turnable' | 'lid' | 'drawer';

/** Kinds whose closed state is a wall (door, gate) or a floor (hatch) the player collides with, toggled with the state. */
export const PASSAGE_KINDS: ReadonlySet<InteractiveKind> = new Set(['door', 'gate', 'hatch']);

/** A door leaf this tall (3 bricks) is a doorway; shorter is a cupboard / car door. */
export const DOORWAY_MIN_HEIGHT_LDU = 72;
/** Open angles, degrees. A turnable's value is its step per tap. */
export const OPEN_DEG: Readonly<Record<InteractiveKind, number>> = { door: 90, gate: 90, cabinet: 100, window: 60, hatch: 90, lever: 35, turnable: 90, lid: 100, drawer: 1 };
/** How far a drawer slides out, as a share of its depth. */
export const DRAWER_OUT = 0.6;
/** Seconds the client takes to swing (or turn) through the full angle. */
export const SWING_SECONDS = 0.4;
/**
 * Where to stand to tap a moving part. Minecraft hands a tap on an entity to
 * the script only within the player's reach: on the Pixel (device
 * 2026-09-24e) taps engaged from 2-3 blocks and did nothing from 3.5 blocks
 * or more (a door from 6.5 blocks, a turned door from 3.5). Shown in the wand
 * menu of every pack with moving parts.
 */
export const INTERACTIVE_REACH_NOTE = 'Stand next to a door, window or lever to tap it: Minecraft only takes a tap on it from about 3 blocks or closer.';
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
/** Bone the animation spins (`interactiveRig`), and the root that carries the placement's turn and size. */
const SPIN_BONE = 'ix_spin';
const ROOT_BONE = 'ix_root';
/** The placement's quarter turn (degrees) and wand size factor, as actor properties the root bone follows. */
export const INTERACTIVE_TURN_PROPERTY = 'craftmatic:turn';
export const INTERACTIVE_SIZE_PROPERTY = 'craftmatic:size';

/**
 * The class of a part from its LDraw description, or null. Glass inserts that
 * ride in a leaf are NOT classes of their own (they are gathered into their
 * leaf's assembly); frames never move.
 */
export function interactiveKindOf(description: string): InteractiveKind | null {
  const d = description.replace(/^[~=_]+\s*/, '');
  if (/^Glass for Window\b.*\bOpening\b/i.test(d)) return 'window';
  // A container's hinged lid (a treasure chest's, a coffin's, a crate's) and a cupboard's drawer.
  if (/^(Container|Minifig Coffin|Container Minifig Coffin)\b.*\bLid\b/i.test(d) || /^CHEST LID\b/i.test(d)) return 'lid';
  if (/^Container\b.*\bDrawer\b/i.test(d) && !/\bDrawers\b/i.test(d)) return 'drawer';
  // A canopy hinged on its own handle bar (18990: 11204's bubble dome on its
  // clip) lifts like a lid; a vehicle's canopy stays its vehicle's.
  if (/^Windscreen\b.*\bCanopy\b.*\b(Handle|Bar)\b/i.test(d)) return 'lid';
  // A garage roller door's segments (grouped into one door that slides up) and a sliding door leaf.
  if (/^Roller Door\b/i.test(d)) return 'door';
  if (/^Door\b.*\bSliding\b/i.test(d) || /^Door Sliding\b/i.test(d)) return 'door';
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
export function interactiveRig(count: number, pivotLdu: Vec3, axisLdu: Vec3, rootLdu: Vec3 = pivotLdu): EntityRig {
  const tilt = rotationBetween([0, -1, 0], norm(axisLdu)); // LDraw up is -Y
  return {
    bones: [
      // The placement's turn and size, about the entity origin (`interactiveAnimation`).
      { name: ROOT_BONE, pivotLdu: rootLdu },
      { name: 'ix_tilt', parent: ROOT_BONE, pivotLdu, rotation: tilt },
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
  /**
   * Open angle, degrees, right-handed about `axisLdu` (signed: the side chosen
   * by the sweep); a turnable's step per tap. For a part that SLIDES (`slide`)
   * it is the distance in LDU along `axisLdu`.
   */
  angleDeg: number;
  /** It slides along `axisLdu` instead of turning about it: a drawer, a roller or sliding door. */
  slide?: boolean;
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
  /** Its tap boxes, when the caller has already shaped and separated them (`interactiveHitboxes` + `separateHitboxes`). */
  hit?: InteractiveHitboxes;
  /** Degrees each sign of the swing was obstructed in the sweep (samples inside other parts), for diagnostics. */
  sweep?: { chosen: number; other: number };
  /** A BRICK-BUILT assembly on a joint (`brick-hinges.ts`): what it is and what it hangs on, for the report. */
  builtFrom?: string;
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
export function discoverInteractives(bricks: readonly ParsedBrick[], sourceMeshes: ReadonlyMap<string, LdrawPartMesh | null>, options: DiscoverInteractivesOptions = {}): InteractiveDiscovery {
  // A retired mould (`~Moved to 3068b`) is classified by the wording of the part it moved to.
  const meshes = withClassifiedDescriptions(sourceMeshes);
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

  // A roller door is a stack of segments: one door per stack, sliding up by its height.
  for (const stack of rollerStacks(candidates.filter(c => /^Roller Door\b/i.test(c.mesh.description.replace(/^[~=_]+\s*/, ''))).map(c => c.brick), boxes)) {
    for (const b of stack) taken.add(b);
    const bounds = unionBox(stack.map(b => boxes.get(b)!));
    const first = stack[0]!, m = meshOf(first)!;
    const R = first.rot ?? IDENTITY;
    // The segment's long local axis is the door's width; its thin one the normal.
    const ext = [m.bounds.max[0] - m.bounds.min[0], m.bounds.max[1] - m.bounds.min[1], m.bounds.max[2] - m.bounds.min[2]];
    const wideAxis = ext[0]! >= ext[2]! ? 0 : 2, thinAxis = wideAxis === 0 ? 2 : 0;
    const widthDir = norm(apply(R, unit(wideAxis))), normal = norm(apply(R, unit(thinAxis)));
    const height = bounds.max[1] - bounds.min[1], width = ext[wideAxis]!;
    const centre: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, bounds.max[1], (bounds.min[2] + bounds.max[2]) / 2];
    const corner = sub(centre, scale(widthDir, width / 2));
    const leaf: LeafPlane = { corner, along: scale(widthDir, width), up: [0, -height, 0], normal, thicknessLdu: ext[thinAxis]! };
    found.push({
      kind: 'door', part: cleanPartId(first.part), description: m.description, bricks: stack, pivotLdu: corner, axisLdu: [0, -1, 0], angleDeg: Math.round(height * 10) / 10, slide: true, leaf,
      anchorLdu: bottomCentre(bounds), boundsLdu: bounds, openingLdu: { width, height }, offGridDeg: offGridOf(leaf.along),
    });
  }
  for (const { brick, mesh, kind: rawKind } of candidates) {
    if (taken.has(brick)) continue;
    const part = cleanPartId(brick.part);
    if (/^Roller Door\b/i.test(mesh.description.replace(/^[~=_]+\s*/, ''))) {
      skipped.push({ part, kind: rawKind, reason: Math.abs((brick.rot ?? IDENTITY)[4]!) >= 0.9 ? 'roller-door segments too few for a doorway (trim, not a door)' : 'a roller-door segment laid flat (a slatted roof or deck), not a door' });
      continue;
    }
    let kind = rawKind;
    const R = brick.rot ?? IDENTITY;
    const box = boxes.get(brick)!;
    if (kind === 'drawer') {
      // Out along its depth (local Z), whichever way is free of the cupboard around it.
      const { min: lmin, max: lmax } = mesh.bounds;
      const depth = lmax[2]! - lmin[2]!, dist = Math.round(depth * DRAWER_OUT * 10) / 10;
      const zDir = norm(apply(R, unit(2)));
      const others = [...boxes].filter(([b]) => b !== brick && !exclude.has(b)).map(([, bb]) => bb);
      const blocked = (dir: Vec3): number => { const moved: Box = { min: add(box.min, scale(dir, dist)), max: add(box.max, scale(dir, dist)) }; return others.filter(o => o.min[0] < moved.max[0] - 1 && o.max[0] > moved.min[0] + 1 && o.min[1] < moved.max[1] - 1 && o.max[1] > moved.min[1] + 1 && o.min[2] < moved.max[2] - 1 && o.max[2] > moved.min[2] + 1).length; };
      const dir = blocked(scale(zDir, -1)) <= blocked(zDir) ? scale(zDir, -1) : zDir;
      taken.add(brick);
      found.push({ kind, part, description: mesh.description, bricks: [brick], pivotLdu: toWorld(brick, [0, 0, 0]), axisLdu: dir, angleDeg: dist, slide: true, anchorLdu: bottomCentre(box), boundsLdu: box, offGridDeg: 0 });
      continue;
    }
    if (kind === 'lid') {
      const lid = lidHinge(brick, mesh, bricks, boxes, exclude, meshOf);
      taken.add(brick);
      // The free edge rises.
      const free = add(lid.leaf.corner, add(lid.leaf.along, scale(lid.leaf.up, 0.5)));
      const sign = rotateAbout(free, lid.pivot, lid.axis, OPEN_DEG.lid)[1] <= rotateAbout(free, lid.pivot, lid.axis, -OPEN_DEG.lid)[1] ? 1 : -1;
      found.push({ kind, part, description: mesh.description, bricks: [brick], pivotLdu: lid.pivot, axisLdu: lid.axis, angleDeg: sign * OPEN_DEG.lid, leaf: lid.leaf, anchorLdu: bottomCentre(box), boundsLdu: box, offGridDeg: offGridOf(lid.leaf.up) });
      continue;
    }
    if (kind === 'lever' || kind === 'turnable') {
      const axisLocal = kind === 'lever' ? 0 : turnAxisOf(mesh.description, mesh);
      const axisLdu = norm(apply(R, unit(axisLocal)));
      const localCentre: Vec3 = kind === 'lever' ? [0, 0, 0] : scale(add(mesh.bounds.min, mesh.bounds.max), 0.5);
      const pivotLdu = toWorld(brick, localCentre);
      const assembly = kind === 'turnable' && /\bTurntable\b/i.test(mesh.description)
        ? turntableLoad(brick, mesh, pivotLdu, axisLdu, bricks, boxes, exclude, primaries, taken)
        : [brick];
      if (kind === 'turnable' && /\b(Rotor|Propeller)\b/i.test(mesh.description)) {
        // A rotor or propeller only turns if its rim is free: turned 45 and 90
        // degrees, the rim may not pass through other parts. Rotors set into a
        // castle's tracery (71043: 17 of them, 21061: 4) are decoration and
        // stay static. A steering or ship's wheel is always meant to turn and
        // is not tested (a wheel used as an ornament still turns - harmless).
        const { min: lmin, max: lmax } = mesh.bounds;
        const rim: Vec3[] = [];
        const [a, b] = [0, 1, 2].filter(k => k !== axisLocal) as [number, number];
        for (const sa of [0, 0.5, 1]) for (const sb of [0, 0.5, 1]) {
          if (sa === 0.5 && sb === 0.5) continue;
          const p: Vec3 = [...localCentre] as Vec3;
          p[a] = lmin[a]! + (lmax[a]! - lmin[a]!) * sa; p[b] = lmin[b]! + (lmax[b]! - lmin[b]!) * sb;
          rim.push(toWorld(brick, p));
        }
        // What it turns ON (its hub, axle or mount: a box holding the pivot) is not in the way.
        const others = [...boxes].filter(([o, bb]) => o !== brick && !exclude.has(o) && !inBox(pivotLdu, bb, -1)).map(([, bb]) => bb);
        const hits = [45, 90].reduce((n, deg) => n + rim.filter(p => { const q = rotateAbout(p, pivotLdu, axisLdu, deg); return others.some(bb => inBox(q, bb, 1)); }).length, 0);
        if (hits >= 4) {
          skipped.push({ part, kind, reason: 'turning it would sweep through the parts around it (decoration, not a wheel)' });
          continue;
        }
      }
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
    if (/\bSliding\b/i.test(mesh.description)) {
      // A sliding door runs along its own width, the way that is free (the sweep's obstacles).
      const w = Math.hypot(...along), dirOut = norm(along);
      const blockedAt = (dir: Vec3): number => samples.reduce((n, pnt) => n + (near.some(bb => inBox(add(pnt, scale(dir, w)), bb, 1)) ? 1 : 0), 0);
      const dir = blockedAt(scale(dirOut, -1)) < blockedAt(dirOut) ? scale(dirOut, -1) : dirOut;
      found.push({ kind, part, description: mesh.description, bricks: assembly, pivotLdu: corner, axisLdu: dir, angleDeg: Math.round(w * 10) / 10, slide: true, leaf, anchorLdu: bottomCentre(bounds), boundsLdu: bounds, ...(opening ? { openingLdu: opening } : {}), offGridDeg });
      continue;
    }
    found.push({
      kind, part, description: mesh.description, bricks: assembly, pivotLdu, axisLdu, angleDeg: sign * magnitude, leaf,
      anchorLdu: bottomCentre(bounds), boundsLdu: bounds, ...(opening ? { openingLdu: opening } : {}), offGridDeg,
      sweep: { chosen: sign > 0 ? plus : minus, other: sign > 0 ? minus : plus },
    });
  }
  const capped = capInteractives(found, options.max ?? MAX_INTERACTIVES);
  return { items: capped.items, skipped: [...skipped, ...capped.skipped], warnings: [...warnings, ...capped.warnings] };
}

/**
 * The cap on shipped moving parts: doorways first, then mechanisms, then
 * cabinets and windows; within a rank, the order found. What is over the cap
 * stays static in the building, and says so.
 */
export function capInteractives(found: readonly SceneInteractive[], cap: number): { items: SceneInteractive[]; skipped: InteractiveDiscovery['skipped']; warnings: string[] } {
  const rank: Record<InteractiveKind, number> = { door: 0, gate: 0, hatch: 1, turnable: 2, lever: 2, cabinet: 3, lid: 3, drawer: 3, window: 4 };
  const ordered = found.map((it, i) => ({ it, i })).sort((a, b) => rank[a.it.kind] - rank[b.it.kind] || a.i - b.i);
  const items = ordered.slice(0, cap).sort((a, b) => a.i - b.i).map(o => o.it);
  const skipped = ordered.slice(cap).map(({ it }) => ({ part: it.part, kind: it.kind, reason: `over the ${cap}-part cap (it stays static in the building)` }));
  const warnings = ordered.length > cap ? [`${ordered.length - cap} interactive part${ordered.length - cap === 1 ? '' : 's'} over the ${cap}-part cap stay static (doorways are kept first).`] : [];
  return { items, skipped, warnings };
}

function unionBox(list: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let i = 0; i < 3; i++) { if (b.min[i]! < min[i]!) min[i] = b.min[i]!; if (b.max[i]! > max[i]!) max[i] = b.max[i]!; }
  return { min, max };
}
/** LDraw Y is down: the bottom is the largest y. */
const bottomCentre = (b: Box): Vec3 => [(b.min[0] + b.max[0]) / 2, b.max[1], (b.min[2] + b.max[2]) / 2];
/** How far a horizontal direction is turned off the nearest grid axis, degrees. */
const offGridOf = (v: Vec3): number => { const fromX = Math.atan2(Math.abs(v[2]), Math.abs(v[0])) * 180 / Math.PI; return Math.round(Math.min(fromX, 90 - fromX) * 10) / 10; };

/**
 * Stacks of roller-door segments: same rotation, the same column (centres
 * within 4 LDU horizontally) and each within 32 LDU of the next vertically.
 * One stack is one door (42639's garage: twelve segments, two doors).
 */
function rollerStacks(segments: readonly ParsedBrick[], boxes: ReadonlyMap<ParsedBrick, Box>): ParsedBrick[][] {
  // Only an UPRIGHT segment is part of a door: its local up axis is world up. Segments
  // laid flat side by side are a slatted roof or deck (42639's sun deck) and stay static.
  const upright = (b: ParsedBrick): boolean => Math.abs((b.rot ?? IDENTITY)[4]!) >= 0.9;
  const left = segments.filter(upright).sort((a, b) => a.y - b.y);
  const out: ParsedBrick[][] = [];
  while (left.length) {
    const stack = [left.shift()!];
    for (let i = 0; i < left.length; i++) {
      const b = left[i]!, top = stack[stack.length - 1]!;
      // Studio curls a stack a degree or two per segment (42670: 0.2 to 1.8 degrees): the same door.
      const same = (b.rot ?? IDENTITY).every((v, k) => Math.abs(v - (top.rot ?? IDENTITY)[k]!) < 0.05);
      if (same && Math.hypot(b.x - top.x, b.z - top.z) <= 4 && Math.abs(b.y - top.y) <= 32 && boxes.has(b)) { stack.push(b); left.splice(i, 1); i--; }
    }
    // A doorway's worth of segments; one or two on their own (42670's lone handle segment) are trim, not a door.
    const lo = Math.min(...stack.map(b => boxes.get(b)?.min[1] ?? Infinity)), hi = Math.max(...stack.map(b => boxes.get(b)?.max[1] ?? -Infinity));
    if (stack.every(b => boxes.has(b)) && hi - lo >= DOORWAY_MIN_HEIGHT_LDU) out.push(stack);
  }
  return out;
}

/**
 * A lid's hinge. A treasure chest's body carries its hinge pins at its back
 * top edge (4738a/b: pins at local (+-40, 3, 18)), so a lid sitting on a chest
 * body hinges along the body's local X at that edge; a lid with no body under
 * it hinges along its own long axis at its +Z edge. The leaf is the lid's top
 * face, from the hinge edge to the free edge.
 */
function lidHinge(brick: ParsedBrick, mesh: LdrawPartMesh, bricks: readonly ParsedBrick[], boxes: ReadonlyMap<ParsedBrick, Box>, exclude: ReadonlySet<ParsedBrick>, meshOf: (b: ParsedBrick) => LdrawPartMesh | null): { pivot: Vec3; axis: Vec3; leaf: LeafPlane } {
  const box = boxes.get(brick)!;
  const { min, max } = mesh.bounds;
  const body = bricks.find(b => {
    if (b === brick || exclude.has(b)) return false;
    const m = meshOf(b);
    if (!m || !/\bTreasure Chest\b/i.test(m.description) || /\bLid\b/i.test(m.description)) return false;
    const bb = boxes.get(b);
    return !!bb && Math.abs((bb.min[0] + bb.max[0]) / 2 - (box.min[0] + box.max[0]) / 2) < 12 && Math.abs((bb.min[2] + bb.max[2]) / 2 - (box.min[2] + box.max[2]) / 2) < 12 && Math.abs(bb.min[1] - box.max[1]) < 16;
  });
  const hinge = body ? toWorld(body, [0, 3, 18]) : toWorld(brick, [0, max[1], max[2]]);
  const lineDir = norm(apply((body ?? brick).rot ?? IDENTITY, [1, 0, 0]));
  const backDir = norm(apply((body ?? brick).rot ?? IDENTITY, [0, 0, 1]));
  const width = max[0] - min[0], depth = max[2] - min[2];
  // The leaf: from one end of the hinge edge, running forward (-back) to the free edge, and along the hinge.
  const corner = sub(add(hinge, [0, -(max[1] - min[1]), 0]), scale(lineDir, width / 2));
  return {
    pivot: hinge, axis: lineDir,
    leaf: { corner, along: scale(backDir, -depth), up: scale(lineDir, width), normal: [0, -1, 0], thicknessLdu: max[1] - min[1] },
  };
}

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

/**
 * A collider cell: `[x, y, z, lo, hi]` in the 100 % grid (lo/hi sixteenths),
 * with a sixth element when the cell is a clearance form (its variant,
 * collider-form.ts; absent or 0 = the full-footprint collider).
 */
export type IxCell = [number, number, number, number, number, number?];

/**
 * The world blocks a set of grid cells lays at wand factor `f` and quarter
 * turn `r`, relative to the placement's anchor: `"x,y,z" -> [lo, hi]`, or
 * `[lo, hi, v]` for a block that is a clearance form (collider-form.ts).
 * EXACTLY the arithmetic `placeColliders` (bedrock-placement-pack.ts) uses for
 * a re-lay and the structure's own turn at 100 %: the turned cell, the world
 * columns it owns (`cellColumns`: the centre rule at f >= 1, any overlap
 * below), the rows its sixteenth span crosses - all in the collider form kit's
 * `cellPieces` - and a block two cells share takes the form that covers both
 * (for full cells: the lowest lo and highest hi). Plain JavaScript: it is
 * serialised into the pack's runtime with the kit and used by the walk
 * preview and the tests unchanged.
 */
export function ixWorldBlocks(cells: ReadonlyArray<readonly (number | undefined)[]>, dims: { width: number; length: number }, f: number, r: number, kit: ColliderFormKit): Map<string, [number, number, number?]> {
  const pieces = new Map<string, number[][]>();
  for (const c of cells) {
    kit.cellPieces(c[0]!, c[1]!, c[2]!, c[5] || 0, c[3]!, c[4]!, dims, f, r, (wx, wy, wz, b) => {
      const key = `${wx},${wy},${wz}`;
      const list = pieces.get(key);
      if (list) list.push(b); else pieces.set(key, [b]);
    });
  }
  const out = new Map<string, [number, number, number?]>();
  for (const [key, list] of pieces) {
    const form = kit.cover(list);
    // A full block stays `[lo, hi]`; a clearance form adds its variant.
    if (form) out.set(key, form.v ? [form.lo, form.hi, form.v] : [form.lo, form.hi]);
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
  /** Half-way treads laid beside a raised threshold (a rise past the auto-step), both sides. */
  treads: number;
  /** Collider cells of the invisible stairs up to a threshold higher than two auto-steps (`planThresholdStairs`). */
  stairTreads: number;
  /** Every stair considered for this doorway: the leaf column, the side, and what happened (`laid N` or the refusal). */
  stairs: string[];
  /** The columns (x, z) its access stairs were laid in: the pipeline asks whether any lies in the margin it widened. */
  stairColumns?: Array<[number, number]>;
  /** The guard cells laid where a side opens onto a drop (`planDropGuards`): full-width colliders with no geometry. */
  guardCells?: IxCell[];
  /**
   * The doorway's APPROACH: the columns in front of and behind its leaf, along
   * the leaf's normal up to `PASSAGE_REACH_CELLS`, where a player stands to
   * walk through (a door or gate; empty for a hatch). Clearance lets a phantom
   * top at the approach's body height go (collider-clearance.ts, rule 4).
   */
  approach: Array<[number, number]>;
  /** The doorway's floor, absolute sixteenths of the collider grid (the lowest closed cell's bottom). */
  floor16: number;
}

/** Cells either side (and above / below) of a leaf whose static state the runtime must know: a block at 25 % holds four cells. */
export const NEIGHBOUR_REACH = 3;
const LEAF_SAMPLE_FROM = 0.15, LEAF_SAMPLE_TO = 0.85;
/**
 * The passage: how far past the leaf (cells) it may be cut; the highest floor
 * a player steps onto over the doorway's floor (sixteenths, the walk's 9/16
 * step); and the clear height the passage keeps over the doorway's floor
 * (sixteenths: 2.5 blocks - a player standing on that step, and a margin;
 * before 2026-09-29 this was "row y0+2 free below its middle", the same 40/16
 * for a leaf standing at a row boundary).
 */
const PASSAGE_REACH_CELLS = 3;
const PASSAGE_STEP16 = 9;
const PASSAGE_CLEAR16 = 40;

/**
 * The top of a collider cell as a surface a player STANDS on (absolute
 * sixteenths), or null: no collider there, or a cell whose geometry is only a
 * WALL band (`COLLIDER_KIT.cover` kind 0) - a rim clearance pulls back to the
 * band. A cell with no geometry record (a tread or stair laid earlier, or no
 * `layers` given) stands on its whole span, as every caller did before.
 *
 * Treads and stairs are planned BEFORE clearance over full cells, and a full
 * cell's top is not always a floor: 10326's Door 1 got a half-way tread on the
 * base's front wall (a 4/16 band with a 2/16 plate at its foot, cover f13)
 * whose rim clearance then trimmed away, leaving the tread 0.9 block over the
 * plate - a step from nowhere that the passability walk stood on and called
 * the doorway OK while the device player fell 2.6 blocks into the pit in the
 * leaf's other column (Saga round 2026-09-29c). A floor + wall form stands on
 * its floor, a wall + ceiling form on its slab; a cell the doorway cut
 * shortened keeps the lower of its span and its geometry.
 */
export function standingTop16(grid: BlockGrid, layers: CellLayers | undefined, x: number, y: number, z: number): number | null {
  if (x < 0 || y < 0 || z < 0 || x >= grid.width || y >= grid.height || z >= grid.length) return null;
  const f = parseFormState(grid.get(x, y, z));
  if (!f) return null;
  const a = layers?.get((x * grid.height + y) * grid.length + z);
  if (!a) return y * 16 + f.hi;
  const cover = COLLIDER_KIT.cover(layerBoxes(a));
  if (!cover) return y * 16 + f.hi;
  if (cover.v !== 0 && COLLIDER_KIT.VARIANTS[cover.v]!.kind === 0) return null;
  return y * 16 + Math.min(f.hi, cover.hi);
}

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
 *
 * `layers` (the part geometry per cell, `buildColliderGrid`) lets the tread
 * and stair planners tell a floor from a wall's rim (`standingTop16`); without
 * it every collider top counts as a floor, as before. `avoid` holds the cells
 * ("x,y,z") an access stair may not take (`accessAvoidCells`: the pack's rides,
 * track, vehicles, figures and seats).
 */
export function planInteractiveColliders(grid: BlockGrid, items: readonly SceneInteractive[], frame: SceneGridFrame, layers?: CellLayers, avoid?: ReadonlySet<string>): Array<InteractiveColliderPlan | null> {
  const isCollider = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < grid.width && y < grid.height && z < grid.length && grid.get(x, y, z).startsWith(COLLIDER_BLOCK_ID);
  const inGrid = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < grid.width && y < grid.height && z < grid.length;
  const plans: Array<InteractiveColliderPlan | null> = [];
  const blockingAll: IxCell[][] = [];
  const stairCandidates: StairCandidate[] = [];
  const leafColumnsAll = new Map<string, number>();
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
    for (const key of columns.keys()) leafColumnsAll.set(key, plans.length);
    const blocking: IxCell[] = [];
    let cleared = 0, passageCleared = 0, treads = 0;
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
    /** Each leaf column's doorway floor (grid blocks): where the closed leaf's cells start. */
    const columnFloor = new Map<string, number>();
    for (const [cx, cz] of columns.values()) {
      const bottom = it.kind === 'hatch' ? yLo : floorUnder(cx, cz);
      columnFloor.set(`${cx},${cz}`, bottom);
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
      // column a player can stand in at the doorway's floor ends it; the
      // columns between are opened to that shape.
      //
      // Measured from the DOORWAY's floor, not from the row the leaf's bottom
      // is in: the player's band runs from a step (`PASSAGE_STEP16`) over
      // that floor up to `PASSAGE_CLEAR16` over it, a column is standable when
      // no collider box reaches into the band, and opening a column trims each
      // cell to what lies outside the band - a floor under it, a lintel over
      // it (one span per cell, the larger). The row-based rule ("row y0 at
      // most a step high") read a floor LEVEL with a leaf hung 14/16 up its
      // row as an obstacle and cleared it whole: 41732's stoop in front of
      // Door 3 became a 2.7-block pit to the street and the museum's floor
      // behind 10326's Door 1 a 1-block pit (Saga round 2026-09-29c). For a
      // leaf standing at a row boundary the two rules agree exactly.
      const n = it.leaf.normal;
      const gn = norm([g(add(corner, n))[0] - g(corner)[0], 0, g(add(corner, n))[2] - g(corner)[2]]);
      const y0 = rowFrom;
      const spanAt = (x: number, y: number, z: number): [number, number] | null => {
        if (!isCollider(x, y, z)) return null;
        const m = /\[lo=(\d+),hi=(\d+)\]$/.exec(grid.get(x, y, z));
        return m ? [Number(m[1]), Number(m[2])] : [0, 16];
      };
      /** The collider spans of column (x, z) reaching into the band (lo16, hi16), absolute sixteenths, with their rows. */
      const inBand = (x: number, z: number, lo16: number, hi16: number): Array<{ y: number; s: [number, number] }> => {
        const out: Array<{ y: number; s: [number, number] }> = [];
        for (let y = Math.max(0, Math.floor(lo16 / 16)); y < grid.height && y * 16 < hi16; y++) {
          const s = spanAt(x, y, z);
          if (s && y * 16 + s[0] < hi16 && y * 16 + s[1] > lo16) out.push({ y, s });
        }
        return out;
      };
      const band = (door16: number): [number, number] => [door16 + PASSAGE_STEP16, door16 + PASSAGE_CLEAR16];
      const standable = (x: number, z: number, door16: number): boolean => inBand(x, z, ...band(door16)).length === 0;
      const openUp = (x: number, z: number, door16: number): void => {
        const [lo16, hi16] = band(door16);
        // Every cell from the doorway's floor up: one at or under the step line stays as a step
        // unless it holds a FLOOR with something on it (a post, a seat back - 41732's Door 4 has
        // a lamp post on the floor plate inside it, which clearance would cover as a knee-high
        // band across the doorway), which is trimmed to the floor.
        for (const { y, s } of inBand(x, z, door16, hi16)) {
          const floor16 = standingTop16(grid, layers, x, y, z);
          if (y * 16 + s[1] <= lo16 && (floor16 === null || floor16 >= y * 16 + s[1])) continue;
          // The part under the band stays only where the cell's geometry has a FLOOR there
          // (`standingTop16` at or under the step line: a floor with a post or rail on it); a
          // wall's foot is not kept as a step - at 400 % a 9/16 ledge is a 2.25-block wall.
          const below = floor16 !== null && floor16 <= lo16 && floor16 - y * 16 > s[0] ? [s[0], Math.min(16, floor16 - y * 16)] as const : null;
          const above = hi16 - y * 16 < s[1] ? [Math.max(0, hi16 - y * 16), s[1]] as const : null;
          const keep = above && below ? (above[1] - above[0] >= below[1] - below[0] ? above : below) : above ?? below;
          if (keep && keep[1] > keep[0]) grid.set(x, y, z, colliderState(keep[0], keep[1]));
          else grid.set(x, y, z, 'minecraft:air');
          passageCleared++;
        }
      };
      // A player moves between columns that share a FACE: a step along a
      // diagonal normal (a 45-degree leaf) that changes both x and z also
      // opens the connector column between them (the less solid of the two),
      // or the passage is a chain of corners no 0.6-wide box fits through.
      const solidity = (x: number, z: number, door16: number): number => inBand(x, z, ...band(door16)).length;
      for (const [cx, cz] of columns.values()) for (const dir of [1, -1]) {
        const door16 = Math.round((columnFloor.get(`${cx},${cz}`) ?? y0) * 16);
        const cells: Array<[number, number]> = [];
        let open = false, px = cx, pz = cz;
        const visit = (x: number, z: number): 'open' | 'go' => {
          if (x < 0 || z < 0 || x >= grid.width || z >= grid.length) return 'open';
          // The leaf's own columns are the doorway, already cut to its span: the
          // passage never widens them (it would clear the floor or the lintel
          // the closed leaf merges with).
          if (columns.has(`${x},${z}`)) return 'go';
          if (!cells.some(([a, b]) => a === x && b === z)) {
            if (standable(x, z, door16)) return 'open';
            cells.push([x, z]);
          }
          return 'go';
        };
        for (let k = 0.25; k <= PASSAGE_REACH_CELLS + 0.01; k += 0.25) {
          const x = Math.floor(cx + 0.5 + gn[0] * dir * k), z = Math.floor(cz + 0.5 + gn[2] * dir * k);
          if ((x === px && z === pz) || (x === cx && z === cz)) continue;
          if (x !== px && z !== pz) {
            const [ax, az] = solidity(x, pz, door16) <= solidity(px, z, door16) ? [x, pz] : [px, z];
            if (visit(ax, az) === 'open') { open = true; break; }
          }
          px = x; pz = z;
          if (visit(x, z) === 'open') { open = true; break; }
        }
        if (!open) continue;
        for (const [x, z] of cells) openUp(x, z, door16);
      }
      // A raised threshold (a leaf standing on a plate or two over the floor
      // either side) is a rise past the 9/16 auto-step: walking at it, the
      // player stops short (41732's shop door, 0.69 block, device 2026-09-24d).
      // Lay a half-way tread on the floor beside it, both ways, so it is two
      // steps a player walks up without jumping.
      for (const [cx, cz] of columns.values()) for (const dir of [1, -1]) {
        const door = floorUnder(cx, cz);
        // Every side is also a staircase candidate, planned once every doorway
        // is cut and its single tread laid (`planThresholdStairs`).
        stairCandidates.push({ item: plans.length, cx, cz, gn: [gn[0], gn[2]], dir, door });
        const x = Math.floor(cx + 0.5 + gn[0] * dir), z = Math.floor(cz + 0.5 + gn[2] * dir);
        if (!inGrid(x, 0, z) || columns.has(`${x},${z}`)) continue;
        let top = -Infinity;
        for (let y = Math.min(grid.height - 1, Math.floor(door + 1e-6)); y >= Math.max(0, Math.floor(door) - 2); y--) {
          // The floor beside the door is a surface a player stands on, never a wall's rim (`standingTop16`).
          const st = standingTop16(grid, layers, x, y, z);
          if (st !== null && st / 16 <= door + 1e-6) { top = st / 16; break; }
        }
        if (!Number.isFinite(top)) top = 0;
        const rise = door - top;
        if (rise <= PASSAGE_STEP16 / 16 + 1e-6 || rise > 2 * PASSAGE_STEP16 / 16 + 1e-6) continue;
        const tread = top + rise / 2, row = Math.floor(tread - 1e-6);
        if (!inGrid(x, row, z)) continue;
        const s = staticSpan(x, row, z);
        const hi = Math.min(16, Math.ceil((tread - row) * 16 - 1e-6)), lo = Math.max(0, Math.floor((top - row) * 16 + 1e-6));
        grid.set(x, row, z, colliderState(Math.min(s ? s[0] : lo, lo, hi - 1), Math.max(s ? s[1] : hi, hi)));
        treads++;
      }
    }
    blockingAll.push(blocking);
    // The approach: every column the leaf's normal crosses within the passage's reach, both ways.
    const approach = new Map<string, [number, number]>();
    if (it.kind !== 'hatch') {
      const n = it.leaf.normal;
      const gn = norm([g(add(corner, n))[0] - g(corner)[0], 0, g(add(corner, n))[2] - g(corner)[2]]);
      for (const [cx, cz] of columns.values()) for (const dir of [1, -1]) for (let k = 0.25; k <= PASSAGE_REACH_CELLS + 0.01; k += 0.25) {
        const x = Math.floor(cx + 0.5 + gn[0] * dir * k), z = Math.floor(cz + 0.5 + gn[2] * dir * k);
        if (!columns.has(`${x},${z}`) && inGrid(x, 0, z)) approach.set(`${x},${z}`, [x, z]);
      }
    }
    const floor16 = blocking.length ? Math.min(...blocking.map(c => c[1] * 16 + c[3])) : 0;
    plans.push({ blocking, neighbours: [], cleared, passageCleared, treads, stairTreads: 0, stairs: [], approach: [...approach.values()], floor16 });
  }
  if (stairCandidates.length) planThresholdStairs(grid, plans, stairCandidates, leafColumnsAll, layers, avoid);
  // After the stairs: a side a stair now serves walks down it, and only a drop nothing serves is guarded.
  if (stairCandidates.length) planDropGuards(grid, plans, stairCandidates, leafColumnsAll, avoid);
  captureDoorwayNeighbours(grid, plans);
  return plans;
}

/** A doorway side whose threshold is more than two auto-steps above the floor in front (see `planThresholdStairs`). */
export interface StairCandidate {
  /** Index into the plans. */
  item: number;
  /** The leaf column the stair starts beside. */
  cx: number; cz: number;
  /** The leaf's horizontal normal on the grid (x, z) and the side (+1 / -1). */
  gn: [number, number]; dir: number;
  /** The doorway's floor (grid blocks) at that column. */
  door: number;
}

/**
 * One riser of an access stair (sixteenths): half a block, a slab's height,
 * which a player walks up without jumping (Bedrock's auto-step is 9/16, so a
 * half block leaves a sixteenth to spare). A stair also walks onto the model's
 * own floors (a landing, a porch, the model's own steps) within the 9/16
 * auto-step (`PASSAGE_STEP16`) of the level it is at, so where a run meets such
 * a floor, or the ground, that one riser may be the auto-step.
 */
export const STAIR_RISE16 = 8;
/**
 * Longest invisible staircase: its rise (sixteenths, 4 blocks - a door on the
 * second storey of a minifig building is ~3 blocks up) and its treads, one per
 * riser below the top (4 blocks at half a block a riser: 7 treads).
 */
export const STAIR_MAX_RISE16 = 64;
export const STAIR_MAX_TREADS = 7;
/** Cells (Chebyshev) a tread keeps from another doorway's leaf standing lower than the tread's top. */
const STAIR_DOOR_CLEAR = 2;
/** How many columns a stair may take out from its leaf column, landings, treads and the ground it ends on included. */
const STAIR_MAX_RUN = 12;
/**
 * A stair runs straight out along the leaf's normal when it can; where that
 * is blocked (another doorway, the model's edge, geometry) it may turn - along
 * the facade, then away from it again - at most `STAIR_MAX_TURNS` times, each
 * turn costing `STAIR_TURN_COST` columns in the search (a straight stair is
 * preferred over a turning one up to that many columns longer).
 */
const STAIR_MAX_TURNS = 2;
const STAIR_TURN_COST = 4;
/** Search states a candidate may expand (a bound on a pathological grid; a real facade needs a few hundred). */
const STAIR_MAX_EXPANSIONS = 20_000;
/** A stair runs along a grid axis only: the leaf's normal within ~20 degrees of one (cos 20° = 0.94). */
const STAIR_AXIS_COS = 0.94;
/** Headroom kept clear over the level a player walks at on every stair column (a standing player, sixteenths). */
const STAIR_HEAD16 = 29;
/** The flood over a stair's world is skipped (the stair refused) past this many quarter-block voxels. */
const STAIR_MAX_FLOOD_VOXELS = 64_000_000;
/** A player's jump (sixteenths, 1.25 blocks): a doorway floor more than this over the ground is out of reach. */
export const ACCESS_JUMP16 = 20;
/** The most the grid is widened on one side (cells) so a stair from a raised door can run out past the model's edge. */
export const ACCESS_MARGIN_MAX = 7;
/** A door leaf turned further than this off the grid (degrees) widens nothing: its stair would be refused `off-axis` (`STAIR_AXIS_COS`). */
export const ACCESS_DOOR_MAX_OFF_GRID_DEG = 20;

/**
 * Invisible access stairs up to a raised door (clearance's "certain test"
 * discipline; docs/bedrock-interactivity.md "Access steps").
 *
 * A door hung on a raised base over open ground (41395's, 60380's, 42670's
 * Door 6: 1.3-2 blocks up; 10326's Door 1: 2.9 blocks over the plate at the
 * model's front edge) reads SEALED or ONE-WAY: the floor in front is more than
 * a jump below the doorway's floor, so nobody can walk up to it (the single
 * half-way tread covers only a rise of two auto-steps). For such a side this
 * lays a run of treads, each `STAIR_RISE16` below the last, until the floor in
 * front is within one riser of the ground plane - a staircase walked up
 * without a jump, invisible like every collider. The run goes straight out
 * along the leaf's normal where it can and turns along the facade where that
 * is blocked (`STAIR_MAX_TURNS`), and walks onto the model's own floors on the
 * way (a porch, a planter). Only when EVERY condition holds (otherwise the
 * side keeps what it had, and `stairs` says why):
 *
 * - the rise from the ground to the doorway's floor is at most
 *   `STAIR_MAX_RISE16` in at most `STAIR_MAX_TREADS` treads;
 * - the leaf's normal is within ~20 degrees of a grid axis (a player walks
 *   between face-sharing columns);
 * - every stair column is AIR from its floor to a standing player's head over
 *   the level the player walks in at - a tread only fills open air on a
 *   floor, never a hole under a floor, never a cell of the model - and a floor
 *   it stands on is a surface a player stands on (`standingTop16`), never a
 *   wall's rim;
 * - no tread column is any doorway's leaf column or blocking cell (a stair is
 *   never laid in a doorway or in a leaf's swing), nor another stair's; no
 *   tread stands within `STAIR_DOOR_CLEAR` of a lower doorway's leaf or in
 *   another doorway's approach above that doorway's floor (a stair never
 *   blocks another door's line); and no tread or the head room over it takes a
 *   cell of `avoid` (the pack's ride paths, slide chutes, coaster track,
 *   vehicles, figures and seats, `accessAvoidCells`);
 * - it stays inside the grid - the model's placement footprint and the margin
 *   the pipeline widened it by for this (`accessMarginFor`); only the ground it
 *   ends on may lie past the grid;
 * - **outside only**: every filled cell is reached by the leak flood
 *   (`LeakFlood`: a flying, sneaking player from outside the model) through the
 *   collider world with EVERY doorway closed. A tread can only make walkable a
 *   space a player already reaches from outside with the doors shut, so it
 *   never opens an enclosed room and never leads past a closed leaf. (A raised
 *   door INSIDE a room keeps its verdict: stricter than needed, never wrong.)
 *   TODO(access-steps): an inside stair (a door whose inside floor is out of
 *   reach) needs its own proof that it blocks no furniture, seat or figure
 *   path in the room before the flood rule can be relaxed for it.
 *
 * Stairs are laid on the COLLIDER grid before clearance, like the doorway cut
 * and the single tread, so they scale with the wand like every collider (a
 * half-block riser is a jump at 200 %, and past that the scaled-grid planner,
 * bedrock-collider-scale.ts, restores it as it restores every riser the model
 * climbs at 100 %); `stairTreads` counts the cells laid. With `layers` a
 * column's floor is a surface a player stands on (`standingTop16`).
 */
export function planThresholdStairs(grid: BlockGrid, plans: Array<InteractiveColliderPlan | null>, candidates: readonly StairCandidate[], leafColumns: ReadonlyMap<string, number>, layers?: CellLayers, avoid?: ReadonlySet<string>): void {
  const W = grid.width, H = grid.height, L = grid.length;
  const inGrid = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < L;
  const isCollider = (x: number, y: number, z: number): boolean => inGrid(x, y, z) && grid.get(x, y, z).startsWith(COLLIDER_BLOCK_ID);
  const spanOf = (x: number, y: number, z: number): [number, number] | null => {
    if (!isCollider(x, y, z)) return null;
    const f = parseFormState(grid.get(x, y, z));
    return f ? [f.lo, f.hi] : [0, 16];
  };
  const blockingKeys = new Set<string>();
  for (const plan of plans) for (const c of plan?.blocking ?? []) blockingKeys.add(`${c[0]},${c[1]},${c[2]}`);
  /** Each doorway's floor (sixteenths): the lowest closed cell's bottom. */
  const doorFloor16 = plans.map(plan => plan?.blocking.length ? Math.min(...plan.blocking.map(c => c[1] * 16 + c[3])) : Infinity);
  /** Each column in some doorway's approach: the doorways (index) whose approach it is. */
  const approachOf = new Map<string, number[]>();
  plans.forEach((plan, i) => { for (const [x, z] of plan?.approach ?? []) { const k = `${x},${z}`; const list = approachOf.get(k); if (list) list.push(i); else approachOf.set(k, [i]); } });
  /**
   * Why a tread whose top is `top16` may not stand in column (x, z) for
   * doorway `item`, or '' when it may: another doorway's leaf within
   * `STAIR_DOOR_CLEAR` cells standing lower than the tread (a door at street
   * level beside a raised one), another doorway's approach where the tread
   * would stand over that doorway's floor, a doorway's closed cell, or a cell
   * of `avoid` from the tread's floor to the head room over its top.
   */
  const treadRefusal = (item: number, x: number, z: number, floor16: number, top16: number): string => {
    for (let dx = -STAIR_DOOR_CLEAR; dx <= STAIR_DOOR_CLEAR; dx++) for (let dz = -STAIR_DOOR_CLEAR; dz <= STAIR_DOOR_CLEAR; dz++) {
      const other = leafColumns.get(`${x + dx},${z + dz}`);
      if (other !== undefined && other !== item && doorFloor16[other]! < top16) return 'in front of another doorway';
    }
    for (const other of approachOf.get(`${x},${z}`) ?? []) if (other !== item && top16 > doorFloor16[other]! + STAIR_RISE16) return 'in another doorway\'s approach';
    for (let y = Math.floor(floor16 / 16); y * 16 < top16; y++) if (blockingKeys.has(`${x},${y},${z}`)) return 'a doorway cell';
    if (avoid) for (let y = Math.floor(floor16 / 16); y * 16 < top16 + STAIR_HEAD16; y++) if (avoid.has(`${x},${y},${z}`)) return 'in the way of a ride, a vehicle or a figure';
    return '';
  };

  /**
   * What a player walking at `cur16` finds on entering column (x, z) of a
   * stair for candidate `c`, moving up or down at most `step16` without a
   * tread (the 9/16 auto-step for a stair's route; the 1.25-block jump when
   * asking whether the side is reached without one).
   */
  type Entry = { kind: 'landing' | 'ground'; floor16: number } | { kind: 'tread'; floor16: number; top16: number } | { kind: 'refused'; why: string };
  const enter = (c: StairCandidate, x: number, z: number, cur16: number, step16: number): Entry => {
    const item = c.item;
    if (leafColumns.has(`${x},${z}`)) return { kind: 'refused', why: 'a leaf column' };
    // Past the grid is the world's ground plane: a stair may END there, never lay a tread there.
    if (x < 0 || z < 0 || x >= W || z >= L) return cur16 <= step16 ? { kind: 'ground', floor16: 0 } : { kind: 'refused', why: 'the grid\'s edge' };
    // The column's floor under the player: the highest collider span that reaches no higher than an
    // auto-step over `cur16`; anything reaching into the body band above that is in the way.
    let floor16 = 0;
    for (let y = Math.min(H - 1, Math.floor((cur16 + STAIR_HEAD16 - 1) / 16)); y >= 0; y--) {
      const s = spanOf(x, y, z);
      if (!s) continue;
      const top = y * 16 + s[1], bottom = y * 16 + s[0];
      if (bottom >= cur16 + STAIR_HEAD16) continue; // over the head
      if (top > cur16 + step16) return { kind: 'refused', why: 'not open air' };
      // The floor is a surface a player stands on; a wall's rim here is not open air beside the door -
      // unless it is this doorway's LANDING, a rim clearance never narrows (collider-clearance.ts:
      // within `LANDING_REACH` of the leaf and `LANDING_RISE` of its foot; 10326 Door 1's lip).
      const st = standingTop16(grid, layers, x, y, z);
      const landing = Math.hypot(Math.max(0, Math.abs(x - c.cx) - 1), Math.max(0, Math.abs(z - c.cz) - 1)) <= LANDING_REACH && Math.abs(top - Math.round(c.door * 16)) <= LANDING_RISE * 16;
      if (st === null && !landing) return { kind: 'refused', why: 'a wall\'s rim' };
      floor16 = st ?? top;
      break;
    }
    // A floor within an auto-step is walked onto (a landing, the model's own steps, a threshold tread).
    if (floor16 >= cur16 - step16) return { kind: floor16 <= PASSAGE_STEP16 ? 'ground' : 'landing', floor16 };
    const top16 = cur16 - STAIR_RISE16;
    const why = treadRefusal(item, x, z, floor16, top16);
    return why ? { kind: 'refused', why } : { kind: 'tread', floor16, top16 };
  };

  // One proposal per candidate: the treads (column, floor, top in absolute sixteenths).
  interface Tread { x: number; z: number; floor16: number; top16: number }
  interface Node { x: number; z: number; cur16: number; hx: number; hz: number; turns: number; cols: number; cost: number; steps: Array<Tread & { landing: boolean }>; treads: number; ground: boolean }
  const proposals: Array<{ c: StairCandidate; treads: Tread[]; rise16: number; turns: number }> = [];
  const note = (c: StairCandidate, verdict: string): void => { plans[c.item]?.stairs.push(`${c.cx},${c.cz} side ${c.dir > 0 ? '+' : '-'}: ${verdict}`); };
  /**
   * Uniform-cost search from candidate `c`'s leaf column over (column, level,
   * heading): straight out along the normal (`sx`, `sz`) first, a turn costs
   * `STAIR_TURN_COST` columns. The first node popped that stands on the ground
   * is the route; `allowTreads` false walks the model's own floors only, a
   * jump (`ACCESS_JUMP16`) at a time.
   * `straightWhy`/`straightStep` say where the straight line out stopped.
   */
  const route = (c: StairCandidate, sx: number, sz: number, door16: number, allowTreads: boolean): { found: Node | null; straightWhy: string; straightStep: number; bounded: boolean } => {
    const open: Node[] = [{ x: c.cx, z: c.cz, cur16: door16, hx: sx, hz: sz, turns: 0, cols: 0, cost: 0, steps: [], treads: 0, ground: false }];
    const seen = new Map<string, number>();
    let found: Node | null = null, straightWhy = '', straightStep = 0, expansions = 0;
    const stop = (n: Node, turn: boolean, why: string): void => { if (n.turns === 0 && !turn && !straightWhy) { straightWhy = why; straightStep = n.cols + 1; } };
    while (open.length && !found && expansions++ < STAIR_MAX_EXPANSIONS) {
      let best = 0;
      for (let i = 1; i < open.length; i++) if (open[i]!.cost < open[best]!.cost) best = i;
      const n = open.splice(best, 1)[0]!;
      // A node on the ground is popped only when no cheaper route is still open: the cheapest route.
      if (n.ground) { found = n; break; }
      // The first move leaves the doorway along its normal; later ones go on, or turn left or right.
      const moves: Array<[number, number]> = n.cols === 0 ? [[n.hx, n.hz]] : [[n.hx, n.hz], [n.hz, -n.hx], [-n.hz, n.hx]];
      for (const [dx, dz] of moves) {
        const turn = dx !== n.hx || dz !== n.hz;
        if (turn && n.turns >= STAIR_MAX_TURNS) continue;
        if (n.cols + 1 > STAIR_MAX_RUN) { stop(n, turn, 'no ground within reach'); continue; }
        const x = n.x + dx, z = n.z + dz;
        if ((x === c.cx && z === c.cz) || n.steps.some(st => st.x === x && st.z === z)) continue;
        const e = enter(c, x, z, n.cur16, allowTreads ? PASSAGE_STEP16 : ACCESS_JUMP16);
        if (e.kind === 'refused') { stop(n, turn, e.why); continue; }
        if (e.kind === 'tread' && !allowTreads) { stop(n, turn, 'a drop past the auto-step'); continue; }
        if (e.kind === 'tread' && n.treads >= STAIR_MAX_TREADS) { stop(n, turn, `more than ${STAIR_MAX_TREADS} treads`); continue; }
        const tread = e.kind === 'tread', top16 = e.kind === 'tread' ? e.top16 : e.floor16;
        const next: Node = {
          x, z, cur16: top16, hx: dx, hz: dz, turns: n.turns + (turn ? 1 : 0), cols: n.cols + 1,
          cost: n.cost + 1 + (turn ? STAIR_TURN_COST : 0), treads: n.treads + (tread ? 1 : 0), ground: e.kind === 'ground',
          steps: [...n.steps, { x, z, floor16: e.floor16, top16, landing: !tread }],
        };
        const key = `${x},${z},${next.cur16},${dx},${dz}`;
        if ((seen.get(key) ?? Infinity) <= next.cost) continue;
        seen.set(key, next.cost);
        open.push(next);
      }
    }
    return { found, straightWhy, straightStep, bounded: expansions > STAIR_MAX_EXPANSIONS };
  };
  for (const c of candidates) {
    const [ax, az] = c.gn;
    if (Math.max(Math.abs(ax), Math.abs(az)) < STAIR_AXIS_COS) { note(c, 'off-axis'); continue; }
    const sx = Math.abs(ax) >= Math.abs(az) ? Math.sign(ax) * c.dir : 0, sz = sx === 0 ? Math.sign(az) * c.dir : 0;
    const door16 = Math.round(c.door * 16);
    // A side a player already reaches from the ground on the model's own floors (a porch, its own
    // steps, a threshold tread), jumping where a jump is enough, needs no stair: the same search with
    // no tread and the jump as its step decides it (the brief: a doorway floor more than a jump over
    // the reachable floor in front).
    if (route(c, sx, sz, door16, false).found) continue;
    const { found, straightWhy, straightStep, bounded } = route(c, sx, sz, door16, true);
    if (!found) {
      // The side has no route. A side whose first column is the model's own wall or another leaf
      // (a door into a wall, a double door's other half) is not a stair side at all: silent, as before.
      if (straightStep === 1 && (straightWhy === 'not open air' || straightWhy === 'a leaf column' || straightWhy === 'a wall\'s rim')) continue;
      note(c, `no stair: straight out, ${straightWhy || 'no ground within reach'} at step ${straightStep || 1}${bounded ? ' (search bound reached)' : ', and no turn along the facade finds the ground'}`);
      continue;
    }
    // The treads in walking order, and the level the first one is stepped down from.
    const treads: Tread[] = [];
    let runStart = door16, oneRun = true, level = door16;
    for (const s of found.steps) {
      if (s.landing) {
        // A landing after treads (a planter, a porch edge) is walked onto; the steps are then not one even run.
        if (treads.length && s.floor16 > PASSAGE_STEP16) oneRun = false;
        level = s.floor16;
        continue;
      }
      if (!treads.length) runStart = level;
      treads.push({ x: s.x, z: s.z, floor16: s.floor16, top16: s.top16 });
      level = s.top16;
    }
    const end = found.steps[found.steps.length - 1]!.floor16;
    if (door16 - end > STAIR_MAX_RISE16) { note(c, `rise ${door16 - end}/16 over the limit`); continue; }
    // Even steps over the run when the floors allow it (a half-block then a 2/16 step reads as a glitch).
    // An even tread may stand higher than the greedy one: its column must still be clear from its floor
    // to a player's head over the level stepped down from (`enter` checked the greedy levels).
    const clear = (x: number, z: number, floor16: number, upTo16: number): boolean => {
      for (let y = Math.max(0, Math.floor(floor16 / 16)); y < H && y * 16 < upTo16; y++) {
        const sp = spanOf(x, y, z);
        if (sp && y * 16 + sp[0] < upTo16 && y * 16 + sp[1] > floor16) return false;
      }
      return true;
    };
    const nT = treads.length, even = treads.map((_t, j) => runStart - Math.round((j + 1) * (runStart - end) / (nT + 1)));
    if (oneRun && treads.every((t, j) => even[j]! > t.floor16 && clear(t.x, t.z, t.floor16, (j ? even[j - 1]! : runStart) + STAIR_HEAD16))) treads.forEach((t, j) => { t.top16 = even[j]!; });
    // Re-spacing moves tops: re-check the doorways and avoided cells at the tops laid.
    const late = treads.map(t => treadRefusal(c.item, t.x, t.z, t.floor16, t.top16)).find(w => w);
    if (late) { note(c, late); continue; }
    proposals.push({ c, treads, rise16: door16 - end, turns: found.turns });
  }
  if (!proposals.length) return;

  // Outside only: flood the collider world with every doorway closed.
  if ((W + 2) * (H + 2) * (L + 2) * 64 > STAIR_MAX_FLOOD_VOXELS) { for (const { c } of proposals) note(c, 'unverifiable (grid too large to flood)'); return; }
  const flood = new LeakFlood(W, H, L);
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
    const s = grid.get(x, y, z);
    if (s === 'minecraft:air') continue;
    const f = parseFormState(s);
    if (!f) { flood.solid16(x, y, z, [0, 16, 0, 16, 0, 16]); continue; }
    for (const b of COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi)) flood.solid16(x, y, z, b);
  }
  for (const plan of plans) for (const c of plan?.blocking ?? []) flood.solid16(c[0], c[1], c[2], [0, 16, c[3], c[4], 0, 16]);
  const reached = flood.reach();
  const PH = H + 2, PL = L + 2;
  const outside = (x: number, y: number, z: number): boolean => y >= 0 && y < PH && reached[((x + 1) * PH + y) * PL + (z + 1)] === 1;
  const taken = new Set<string>();
  for (const { c, treads, rise16, turns } of proposals) {
    const cells = treads.flatMap(t => {
      const rows: Array<[number, number, number]> = [];
      // The rows the tread fills, from the row the flood's feet stand in on this
      // floor (it moves in quarter blocks); the head room above is air (`enter`).
      for (let y = Math.floor(Math.ceil(t.floor16 / 4) * 4 / 16); y * 16 < t.top16; y++) rows.push([t.x, y, t.z]);
      return rows;
    });
    if (!cells.every(([x, y, z]) => outside(x, y, z))) { note(c, 'not outside (the flood with every door closed does not reach it)'); continue; }
    if (treads.some(t => taken.has(`${t.x},${t.z}`))) { note(c, 'another stair'); continue; }
    for (const t of treads) taken.add(`${t.x},${t.z}`);
    let laid = 0;
    for (const t of treads) {
      for (let y = Math.floor(t.floor16 / 16); y * 16 < t.top16; y++) {
        const lo = Math.max(0, t.floor16 - y * 16), hi = Math.min(16, t.top16 - y * 16);
        const s = spanOf(t.x, y, t.z);
        // The floor's own span shares the bottom row: the union stays one span (they meet at `floor16`).
        grid.set(t.x, y, t.z, colliderState(Math.min(lo, s ? s[0] : lo), Math.max(hi, s ? s[1] : hi)));
        laid++;
      }
    }
    const plan = plans[c.item];
    if (plan) { plan.stairTreads += laid; (plan.stairColumns ??= []).push(...treads.map(t => [t.x, t.z] as [number, number])); }
    note(c, `laid ${treads.length} treads over a rise of ${rise16}/16${turns ? ` (${turns} turn${turns === 1 ? '' : 's'} along the facade)` : ''}`);
  }
}

/**
 * A drop a doorway side is guarded against (sixteenths): more than the
 * tallest access stair (`STAIR_MAX_RISE16`, 4 blocks) - a fall that hurts and
 * that no stair serves.
 */
export const GUARD_DROP16 = STAIR_MAX_RISE16;
/** A guard's height over the floor it stands beside (sixteenths, 1.5 blocks: over a jump, so it is never hopped). */
export const GUARD_HEIGHT16 = 24;
/** How far (cells, Chebyshev) from its leaf column a doorway side's landing is followed and guarded. */
export const GUARD_REACH = PASSAGE_REACH_CELLS;

/**
 * Invisible guards where a doorway opens onto a drop (docs/bedrock-interactivity.md
 * "A doorway over a drop"). 76417's Gate 1 is a barred gate in the bank's
 * outer wall, 17 blocks over the grass with nothing drawn outside it: opened,
 * it led a child onto an invisible floor (the bounding box of a turned
 * baseplate) and off its edge (Saga round 2026-09-30i), and with that floor
 * gone it opened straight onto the drop. A drop that deep has no access stair
 * (`STAIR_MAX_RISE16`), so the gate leads nowhere - but it may not lead into
 * the air.
 *
 * For each doorway side (a stair candidate: leaf column, normal, side) the
 * LANDING is followed from the leaf column out, column to face-sharing
 * column on that side within `GUARD_REACH`: a column is part of it when its
 * floor (the highest collider top within a jump over the level walked at, the
 * ground when none) is within a jump of the column it is reached from and its
 * body band is clear. A column on the side whose floor lies more than
 * `GUARD_DROP16` under the landing beside it is a drop: a guard fills its
 * empty cells from that landing's floor to `GUARD_HEIGHT16` over it - a full
 * collider with no geometry, which clearance leaves alone. A stair laid down
 * from the doorway is walked like any floor (its risers are within a jump),
 * so a side with a stair gets no guard where the stair runs.
 *
 * Never guarded: a column past the grid's edge (the margin is widened for
 * stairs only - `TODO(drop-guards)` if a door at the edge needs one), a leaf
 * column, a doorway's closed cell, a cell of `avoid` (rides, track, vehicles,
 * figures, seats), or a cell that is not air. Every guard is reported in the
 * doorway's `stairs` notes and its cells in `guardCells`.
 */
export function planDropGuards(grid: BlockGrid, plans: Array<InteractiveColliderPlan | null>, candidates: readonly StairCandidate[], leafColumns: ReadonlyMap<string, number>, avoid?: ReadonlySet<string>): void {
  const W = grid.width, H = grid.height, L = grid.length;
  const blockingKeys = new Set<string>();
  for (const plan of plans) for (const c of plan?.blocking ?? []) blockingKeys.add(`${c[0]},${c[1]},${c[2]}`);
  const spanOf = (x: number, y: number, z: number): [number, number] | null => {
    const s = grid.get(x, y, z);
    if (!s.startsWith(COLLIDER_BLOCK_ID)) return s === 'minecraft:air' ? null : [0, 16];
    const f = parseFormState(s);
    return f ? [f.lo, f.hi] : [0, 16];
  };
  /**
   * Column (x, z) seen from a player walking at `level16`: 'wall' when a solid reaches into its body band
   * (a step over the level up to a standing player's head), else its floor - the highest top within a jump
   * over the level, the ground (0) when nothing is under it.
   */
  const columnAt = (x: number, z: number, level16: number): 'wall' | number => {
    for (let y = Math.min(H - 1, Math.floor((level16 + STAIR_HEAD16 - 1) / 16)); y >= 0; y--) {
      const s = spanOf(x, y, z);
      if (!s) continue;
      const top = y * 16 + s[1], bottom = y * 16 + s[0];
      if (bottom >= level16 + STAIR_HEAD16) continue; // over the head
      if (top > level16 + ACCESS_JUMP16) return 'wall';
      return top;
    }
    return 0;
  };
  const guarded = new Set<string>();
  for (const c of candidates) {
    const plan = plans[c.item];
    if (!plan) continue;
    const [gx, gz] = c.gn;
    // On the side: the column's centre lies past the leaf column's centre along the side's normal.
    const onSide = (x: number, z: number): boolean => ((x - c.cx) * gx + (z - c.cz) * gz) * c.dir > 0.25;
    const door16 = Math.round(c.door * 16);
    const level = new Map<string, number>([[`${c.cx},${c.cz}`, door16]]);
    const queue: Array<[number, number]> = [[c.cx, c.cz]];
    const drops: Array<{ x: number; z: number; from16: number }> = [];
    let pastEdge = 0;
    for (let h = 0; h < queue.length; h++) {
      const [px, pz] = queue[h]!, at16 = level.get(`${px},${pz}`)!;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = px + dx, z = pz + dz, key = `${x},${z}`;
        if (level.has(key) || !onSide(x, z) || Math.max(Math.abs(x - c.cx), Math.abs(z - c.cz)) > GUARD_REACH || leafColumns.has(key)) continue;
        if (x < 0 || z < 0 || x >= W || z >= L) { if (at16 > GUARD_DROP16) pastEdge++; continue; }
        const col = columnAt(x, z, at16);
        if (col === 'wall') continue;
        if (at16 - col > GUARD_DROP16) { drops.push({ x, z, from16: at16 }); continue; }
        if (Math.abs(at16 - col) > ACCESS_JUMP16) continue; // a fall a stair could serve, or a rise: not this landing
        level.set(key, col);
        queue.push([x, z]);
      }
    }
    if (!drops.length && !pastEdge) continue;
    let laid = 0;
    for (const { x, z, from16 } of drops) {
      const top16 = from16 + GUARD_HEIGHT16;
      const rows: number[] = [];
      for (let y = Math.max(0, Math.floor(from16 / 16)); y < H && y * 16 < top16; y++) rows.push(y);
      if (rows.some(y => blockingKeys.has(`${x},${y},${z}`) || avoid?.has(`${x},${y},${z}`))) continue;
      for (const y of rows) {
        if (grid.get(x, y, z) !== 'minecraft:air' || guarded.has(`${x},${y},${z}`)) continue;
        const lo = Math.max(0, from16 - y * 16), hi = Math.min(16, top16 - y * 16);
        if (hi <= lo) continue;
        grid.set(x, y, z, colliderState(lo, hi));
        guarded.add(`${x},${y},${z}`);
        (plan.guardCells ??= []).push([x, y, z, lo, hi]);
        laid++;
      }
    }
    plan.stairs.push(`${c.cx},${c.cz} side ${c.dir > 0 ? '+' : '-'}: ${laid ? `guarded a drop of more than ${GUARD_DROP16 / 16} blocks (${laid} cell${laid === 1 ? '' : 's'} over ${drops.length} column${drops.length === 1 ? '' : 's'})` : 'a drop it could not guard'}${pastEdge ? `; ${pastEdge} column${pastEdge === 1 ? '' : 's'} past the grid's edge unguarded` : ''}`);
  }
}

/**
 * How far (cells) to widen the grid on each horizontal side so an access stair
 * from a raised door can run straight out past the model's edge
 * (`planThresholdStairs`). A door whose leaf's foot stands more than a jump
 * (`ACCESS_JUMP16`) over the grid's floor needs `n` treads for a straight run
 * down (`STAIR_RISE16` a riser, from its floor plus one riser - a lip or a
 * threshold a step over the leaf's foot - to the ground). On each side of it
 * along its normal that FACES OUT - `solid(x, y, z)` (the voxel grid) holds
 * nothing between the leaf and that side at a standing player's chest over the
 * leaf's foot (an interior door has the facade there) - the grid is widened
 * until that many treads and a landing fit between the leaf and the side, at
 * most `ACCESS_MARGIN_MAX`.
 *
 * `doors` are grid boxes (the leaf's AABB in grid cells at 100 %) with the
 * grid axis the leaf's normal runs along. Nothing else is decided here: the
 * planner still lays a stair only past its every test, and a side widened for
 * a stair it then refuses is air the placement lays and nothing stands on.
 */
export function accessMarginFor(doors: ReadonlyArray<{ min: Vec3; max: Vec3; normal: 'x' | 'z' }>, dims: { width: number; height: number; length: number }, solid: (x: number, y: number, z: number) => boolean): { x0: number; x1: number; z0: number; z1: number } {
  const m = { x0: 0, x1: 0, z0: 0, z1: 0 };
  for (const d of doors) {
    const foot16 = Math.round(d.min[1] * 16);
    if (foot16 <= ACCESS_JUMP16) continue;
    const treads = Math.min(STAIR_MAX_TREADS, Math.ceil((foot16 + STAIR_RISE16) / STAIR_RISE16) - 1);
    const need = treads + 1;
    // The chest row over the leaf's foot (1.5 blocks up), and the leaf's span along its width.
    const row = Math.floor((foot16 + 24) / 16);
    const along = d.normal === 'z' ? [Math.floor(d.min[0]), Math.ceil(d.max[0])] : [Math.floor(d.min[2]), Math.ceil(d.max[2])];
    /** Nothing of the model stands at chest height between the leaf and the side, over the leaf's width. */
    const facesOut = (from: number, to: number): boolean => {
      if (row < 0 || row >= dims.height) return true;
      for (let n = from; n < to; n++) for (let t = along[0]!; t < along[1]!; t++) {
        const [x, z] = d.normal === 'z' ? [t, n] : [n, t];
        if (solid(x, row, z)) return false;
      }
      return true;
    };
    const lo = d.normal === 'z' ? Math.floor(d.min[2]) : Math.floor(d.min[0]);
    const hi = d.normal === 'z' ? Math.ceil(d.max[2]) : Math.ceil(d.max[0]);
    const size = d.normal === 'z' ? dims.length : dims.width;
    const low = facesOut(0, lo) ? Math.min(ACCESS_MARGIN_MAX, need - lo) : 0;
    const high = facesOut(hi, size) ? Math.min(ACCESS_MARGIN_MAX, need - (size - hi)) : 0;
    if (d.normal === 'z') { m.z0 = Math.max(m.z0, low); m.z1 = Math.max(m.z1, high); }
    else { m.x0 = Math.max(m.x0, low); m.x1 = Math.max(m.x1, high); }
  }
  return m;
}

/**
 * The grid cells ("x,y,z") an access stair may not take (`planThresholdStairs`
 * `avoid`): what the pack puts in the open air around the model. Points (a
 * figure's feet, a seat, a mount's top) keep a 3 x 3 x 3 box of cells round
 * them; paths (a slide chute, a lift, a coaster track, a mount's orbit) the
 * cells within a block of every quarter-block sample along them, from a block
 * under to two over (the car and its rider); boxes (a vehicle's footprint)
 * every cell they touch.
 */
export function accessAvoidCells(sources: { points?: ReadonlyArray<readonly [number, number, number]>; paths?: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>>; boxes?: ReadonlyArray<{ min: readonly [number, number, number]; max: readonly [number, number, number] }> }): Set<string> {
  const out = new Set<string>();
  const around = (p: readonly [number, number, number], below: number, above: number): void => {
    const cx = Math.floor(p[0]), cy = Math.floor(p[1]), cz = Math.floor(p[2]);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -below; dy <= above; dy++) for (let dz = -1; dz <= 1; dz++) out.add(`${cx + dx},${cy + dy},${cz + dz}`);
  };
  for (const p of sources.points ?? []) around(p, 1, 1);
  for (const path of sources.paths ?? []) {
    for (let i = 0; i < path.length; i++) {
      const a = path[i]!, b = path[i + 1] ?? a;
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 4));
      for (let k = 0; k <= n; k++) around([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n, a[2] + (b[2] - a[2]) * k / n], 1, 2);
    }
  }
  for (const b of sources.boxes ?? []) {
    for (let x = Math.floor(b.min[0]); x < Math.ceil(b.max[0]); x++) for (let y = Math.floor(b.min[1]); y < Math.ceil(b.max[1]); y++) for (let z = Math.floor(b.min[2]); z < Math.ceil(b.max[2]); z++) out.add(`${x},${y},${z}`);
  }
  return out;
}

/**
 * Record each doorway's static neighbour cells (within `NEIGHBOUR_REACH` of
 * its blocking cells) from the grid as it stands, with their form: run after
 * every cut so a double door's two leaves see each other's cells as air, and
 * again after clearance (collider-clearance.ts) so a trimmed neighbour is
 * restored trimmed where it shares a world block with a leaf.
 *
 * A leaf's OWN cells are recorded too when the cut left part of them static
 * (the sill under a leaf hung a plate up, the lintel over it): the runtime
 * lays an opened doorway's own blocks from these cells, and skipping them
 * cleared the sill when the door opened - on the Pixel (GameTest 2026-09-25,
 * 80049's Gate 1) the walker dropped into the 1/4-block pit the offline walk,
 * which keeps the static grid, never saw.
 */
export function captureDoorwayNeighbours(grid: BlockGrid, plans: ReadonlyArray<InteractiveColliderPlan | null>): void {
  const inGrid = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < grid.width && y < grid.height && z < grid.length;
  for (const plan of plans) {
    if (!plan || !plan.blocking.length) continue;
    plan.neighbours = [];
    const xs = plan.blocking.map(c => c[0]), ys = plan.blocking.map(c => c[1]), zs = plan.blocking.map(c => c[2]);
    for (let x = Math.min(...xs) - NEIGHBOUR_REACH; x <= Math.max(...xs) + NEIGHBOUR_REACH; x++)
      for (let y = Math.min(...ys) - NEIGHBOUR_REACH; y <= Math.max(...ys) + NEIGHBOUR_REACH; y++)
        for (let z = Math.min(...zs) - NEIGHBOUR_REACH; z <= Math.max(...zs) + NEIGHBOUR_REACH; z++) {
          if (!inGrid(x, y, z)) continue;
          const form = parseFormState(grid.get(x, y, z));
          if (form) plan.neighbours.push(form.v ? [x, y, z, form.lo, form.hi, form.v] : [x, y, z, form.lo, form.hi]);
        }
  }
}

/**
 * The first wand size (percent, 100…400) at which an opening of `width` x
 * `height` LDU is passable; 0 when none does. A door or gate needs a
 * minifig's envelope (`DOORWAY_PASS_WIDTH_LDU` x `DOORWAY_PASS_HEIGHT_LDU`
 * at minifig scale, 0.75 x 1.8 blocks, which holds the 0.6 x 1.8 player; a
 * gate has no lintel); a hatch, a hole dropped through, keeps the 1 x 1-block
 * rule. `blocksPerLdu` is the model's scale (1 / 53.33 at minifig scale).
 */
export function passSizeFor(kind: InteractiveKind, opening: { width: number; height: number } | undefined, steps: readonly number[] = [100, 150, 200, 300, 400], blocksPerLdu = 1 / LDU_PER_BLOCK): number {
  if (!opening) return 0;
  const w = opening.width * blocksPerLdu, h = opening.height * blocksPerLdu;
  const minifig = 1 / LDU_PER_BLOCK;
  const needW = kind === 'hatch' ? PASSAGE_WIDTH_BLOCKS : DOORWAY_PASS_WIDTH_LDU * minifig;
  const needH = kind === 'hatch' ? PASSAGE_WIDTH_BLOCKS : kind === 'gate' ? 0 : DOORWAY_PASS_HEIGHT_LDU * minifig;
  return steps.find(pct => w * pct / 100 + 1e-9 >= needW && h * pct / 100 + 1e-9 >= needH) ?? 0;
}

// ─── Entities ────────────────────────────────────────────────────────────────

/**
 * The actor properties (float: Bedrock drops an integer-literal default):
 * the part's own angle, and the placement's quarter turn and wand size. The
 * last two turn and scale the whole rig from its root bone (`ix_root`) instead
 * of the entity's yaw and `minecraft:scale`, so the entity itself always faces
 * yaw 0 at scale 1 and its world-aligned tap boxes (`minecraft:custom_hit_test`,
 * which Bedrock never rotates) mean exactly what the pack wrote.
 */
export function interactiveProperties(): Record<string, unknown> {
  return {
    [INTERACTIVE_PROPERTY]: floatActorProperty(ANGLE_RANGE, 0),
    [INTERACTIVE_TURN_PROPERTY]: floatActorProperty([0, 360], 0),
    [INTERACTIVE_SIZE_PROPERTY]: floatActorProperty([0.1, 8], 1),
  };
}

/**
 * The client animation: the spin bone follows `v.ix_angle`, which the
 * client's own pre-animation script eases toward the property at
 * `rateDegPerSecond` (the whole swing takes `SWING_SECONDS`), so one property
 * write per toggle gives a smooth per-frame swing. The geometry writer negates
 * X and Y rotations into Bedrock's convention (`jsonBone`), so the animation
 * does too: a positive property is a right-handed turn about the axis.
 *
 * The root bone carries the placement: a Bedrock body yaw of θ is a
 * right-handed turn of −θ about world up, which under the same convention is a
 * channel value of +θ; and the wand size as a uniform scale about the entity
 * origin (the root's pivot).
 */
export function interactiveAnimation(typeId: string, rateDegPerSecond: number, slideUnitsPerLdu?: number): { id: string; file: unknown; initialize: string[]; preAnimation: string[] } {
  const id = `animation.${typeId.replace(':', '.')}.turn`;
  const rate = Math.round(rateDegPerSecond * 10) / 10;
  const size = `q.property('${INTERACTIVE_SIZE_PROPERTY}')`;
  // A sliding part moves its spin bone along the rig's axis (the tilt maps the
  // bone's up onto it): the property is the distance in LDU, the bone moves in
  // geometry units. TODO: the slide direction is derived, not yet seen on a device.
  const spin = slideUnitsPerLdu !== undefined
    ? { position: [0, `v.ix_angle * ${Math.round(slideUnitsPerLdu * 1e5) / 1e5}`, 0] }
    : { rotation: [0, '-v.ix_angle', 0] };
  return {
    id,
    file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones: {
      [ROOT_BONE]: { rotation: [0, `q.property('${INTERACTIVE_TURN_PROPERTY}')`, 0], scale: [size, size, size] },
      [SPIN_BONE]: spin,
    } } } },
    initialize: [`v.ix_angle = q.property('${INTERACTIVE_PROPERTY}');`],
    preAnimation: [`v.ix_angle = v.ix_angle + math.clamp(q.property('${INTERACTIVE_PROPERTY}') - v.ix_angle, -q.delta_time * ${rate}, q.delta_time * ${rate});`],
  };
}

/**
 * What a part is called in game (its label, the Walk add-on, the pack
 * warnings): a barred door or a portcullis is a GATE (76457's "Door 1 x 4 x 6
 * Barred" read as "door 1" on the device), a short leaf a cupboard.
 */
export function interactiveNoun(it: Pick<SceneInteractive, 'kind' | 'description'>): string {
  // A brick-built assembly names itself (`brick-hinges.ts`): "Brick-built drop-down flap (…)" is a Drop-down flap.
  const built = /^Brick-built ([a-z -]+?) \(/i.exec(it.description);
  if (built) return `${built[1]![0]!.toUpperCase()}${built[1]!.slice(1)}`;
  if (it.kind === 'gate' || (it.kind === 'door' && /\b(Barred|Bars|Gate|Portcullis)\b/i.test(it.description))) return 'Gate';
  if (it.kind === 'cabinet') return 'Cupboard';
  if (it.kind === 'door' && /^Roller Door\b/i.test(it.description.replace(/^[~=_]+\s*/, ''))) return 'Garage door';
  return `${it.kind[0]!.toUpperCase()}${it.kind.slice(1)}`;
}

/** The interact prompt a touch screen shows for each class (lang keys; `interactiveLangLines`). */
export const INTERACT_TEXT: Readonly<Record<InteractiveKind, string>> = {
  door: 'action.interact.craftmatic_open', gate: 'action.interact.craftmatic_open', cabinet: 'action.interact.craftmatic_open',
  window: 'action.interact.craftmatic_open', hatch: 'action.interact.craftmatic_open', lever: 'action.interact.craftmatic_use', turnable: 'action.interact.craftmatic_turn',
  lid: 'action.interact.craftmatic_open', drawer: 'action.interact.craftmatic_open',
};
export const interactiveLangLines = (): string[] => [
  'action.interact.craftmatic_open=Open / close',
  'action.interact.craftmatic_use=Use',
  'action.interact.craftmatic_turn=Turn',
];

/** One `minecraft:custom_hit_test` box: a square footprint `width` wide, `height` tall, centred on `pivot` (blocks from the entity origin, world axes). */
export interface HitBox { width: number; height: number; pivot: [number, number, number] }

/** The tap boxes of a part, closed and open, relative to its entity origin (model blocks at 100 %, placement turn 0). */
export interface InteractiveHitboxes { closed: HitBox[]; open: HitBox[] }

/** Longest side of one tap box along a leaf, blocks: a long leaf is several small boxes, so no box reaches past its own stretch of leaf. */
export const HITBOX_SEGMENT_BLOCKS = 0.45;
const HITBOX_MIN_BLOCKS = 0.2;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The AABB of model points as a square-footprint tap box relative to `origin`. */
function boxOf(points: Vec3[], origin: Vec3): HitBox {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { if (p[i]! < min[i]!) min[i] = p[i]!; if (p[i]! > max[i]!) max[i] = p[i]!; }
  return {
    width: r3(Math.max(HITBOX_MIN_BLOCKS, max[0] - min[0], max[2] - min[2])),
    height: r3(Math.max(HITBOX_MIN_BLOCKS, max[1] - min[1])),
    pivot: [r3((min[0] + max[0]) / 2 - origin[0]), r3((min[1] + max[1]) / 2 - origin[1]), r3((min[2] + max[2]) / 2 - origin[2])],
  };
}

/**
 * The part's tap boxes, following its actual shape: a leaf is cut into
 * stretches of at most `HITBOX_SEGMENT_BLOCKS` along its width (full height
 * each; a hatch or a top-hung casement into a grid), each boxed by its own
 * extent, so a tall narrow door is a row of narrow boxes and a box never
 * reaches a chair or a window a hand's width beside it. `open` is the same
 * leaf swung to its open angle - the runtime swaps the boxes with the state,
 * so a finger on the swung leaf closes it. Turnables and levers are one box
 * each (their swing stays inside it). `toModel` maps LDraw to model blocks.
 */
export function interactiveHitboxes(it: SceneInteractive, toModel: (p: Vec3) => Vec3): InteractiveHitboxes {
  const origin = toModel(it.anchorLdu);
  if (!it.leaf) {
    const box = (open: boolean): HitBox => boxOf(cornersOf(it.boundsLdu.min, it.boundsLdu.max).map(p => toModel(open ? movedOpen(it, p, 1) : p)), origin);
    // A drawer's boxes follow it out; a turnable's or a lever's swing stays inside its one box.
    return { closed: [box(false)], open: [it.slide ? box(true) : box(false)] };
  }
  const leaf = it.leaf;
  const shape = (deg: number): HitBox[] => {
    const P = (s: number, t: number, n: number): Vec3 => toModel(movedOpen(it, add(add(add(leaf.corner, scale(leaf.along, s)), scale(leaf.up, t)), scale(leaf.normal, n * leaf.thicknessLdu / 2)), deg ? 1 : 0));
    const A = sub(P(1, 0, 0), P(0, 0, 0)), U = sub(P(0, 1, 0), P(0, 0, 0));
    const vertical = Math.abs(U[1]) >= 0.7 * Math.hypot(...U);
    const nS = Math.max(1, Math.ceil(Math.hypot(A[0], A[2]) / HITBOX_SEGMENT_BLOCKS - 1e-9));
    const nT = vertical ? 1 : Math.max(1, Math.ceil(Math.hypot(U[0], U[2]) / HITBOX_SEGMENT_BLOCKS - 1e-9));
    const out: HitBox[] = [];
    for (let i = 0; i < nS; i++) for (let j = 0; j < nT; j++) {
      const pts: Vec3[] = [];
      for (const s of [i / nS, (i + 1) / nS]) for (const t of [j / nT, (j + 1) / nT]) for (const n of [-1, 1]) pts.push(P(s, t, n));
      out.push(boxOf(pts, origin));
    }
    return out;
  };
  return { closed: shape(0), open: shape(it.angleDeg) };
}

/**
 * Where a point of the part is at `fraction` of the way open: slid along the
 * axis for a sliding part, turned about the hinge otherwise (LDraw).
 */
export function movedOpen(it: Pick<SceneInteractive, 'slide' | 'pivotLdu' | 'axisLdu' | 'angleDeg'>, p: Vec3, fraction: number): Vec3 {
  if (!fraction) return p;
  return it.slide ? add(p, scale(it.axisLdu, it.angleDeg * fraction)) : rotateAbout(p, it.pivotLdu, it.axisLdu, it.angleDeg * fraction);
}

/** A tap box in the model frame: its footprint and vertical span, blocks at 100 %. */
export interface WorldHitBox { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }
export const worldHitBox = (origin: Vec3 | readonly number[], b: HitBox): WorldHitBox => ({
  x0: origin[0]! + b.pivot[0] - b.width / 2, x1: origin[0]! + b.pivot[0] + b.width / 2,
  y0: origin[1]! + b.pivot[1] - b.height / 2, y1: origin[1]! + b.pivot[1] + b.height / 2,
  z0: origin[2]! + b.pivot[2] - b.width / 2, z1: origin[2]! + b.pivot[2] + b.width / 2,
});
/** Whether two boxes overlap by more than `eps` on every axis (touching is not overlapping). */
export const hitBoxesOverlap = (a: WorldHitBox, b: WorldHitBox, eps = 0.01): boolean =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > eps && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > eps && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > eps;
/** A seat entity's own tap box (`seatBehavior`: a 0.5 x 0.5 collision box standing on the seat point). */
export const seatHitBox = (p: readonly number[]): WorldHitBox => ({ x0: p[0]! - 0.25, x1: p[0]! + 0.25, y0: p[1]!, y1: p[1]! + 0.5, z0: p[2]! - 0.25, z1: p[2]! + 0.25 });
const SHRINK = 0.8, SHRINK_MIN = 0.08;

/**
 * Keep every part's tap boxes to itself (device 2026-09-24d: a window's box
 * took three taps meant for the chair beside it, a tap at a window opened the
 * door next to it). Boxes are in the model frame at 100 % (`origin` + pivot).
 * A box that overlaps a seat's box, or another part's box in either of their
 * states, is shrunk about its own centre (x 0.8 per round, footprint and
 * height) until it does not; one that still does at `SHRINK_MIN` is dropped,
 * even the part's last: a part left with no boxes in either state cannot keep
 * a tap to itself (a turntable under a seat, two coincident rotors) and the
 * caller leaves it static. Returns how many boxes changed.
 */
export function separateHitboxes(parts: Array<{ origin: Vec3; hit: InteractiveHitboxes }>, seats: ReadonlyArray<readonly number[]> = []): { shrunk: number; dropped: number } {
  let shrunk = 0, dropped = 0;
  const seatBoxes = seats.map(seatHitBox);
  const others = (i: number): WorldHitBox[] => parts.flatMap((p, j) => j === i ? [] : [...p.hit.closed, ...p.hit.open].map(b => worldHitBox(p.origin, b)));
  for (let round = 0; round < 40; round++) {
    let changed = false;
    parts.forEach((p, i) => {
      const blockers = [...seatBoxes, ...others(i)];
      for (const list of [p.hit.closed, p.hit.open]) for (let k = list.length - 1; k >= 0; k--) {
        const b = list[k]!;
        if (!blockers.some(o => hitBoxesOverlap(worldHitBox(p.origin, b), o))) continue;
        if (Math.min(b.width, b.height) * SHRINK >= SHRINK_MIN) {
          list[k] = { ...b, width: r3(b.width * SHRINK), height: r3(b.height * SHRINK) };
          shrunk++;
        } else { list.splice(k, 1); dropped++; }
        changed = true;
      }
    });
    if (!changed) break;
  }
  return { shrunk, dropped };
}

/** A tap box turned by the placement's quarter turn (the `pointAt` turn, as a direction) and scaled by the wand size. */
export function placeHitBox(b: HitBox, rotation: number, f: number): HitBox {
  const [x, y, z] = b.pivot;
  const [tx, tz] = rotation === 90 ? [-z, x] : rotation === 180 ? [-x, -z] : rotation === 270 ? [z, -x] : [x, z];
  return { width: r3(b.width * f), height: r3(b.height * f), pivot: [r3(tx * f), r3(y * f), r3(tz * f)] };
}

/** The component group / event that sets a part's tap boxes for a turn, a size and a state. */
export const hitGroupName = (rotation: number, pct: number, open: boolean): string => `craftmatic:ixh_${rotation}_${pct}_${open ? 'o' : 'c'}`;

/**
 * The collision box: a thin needle at the entity origin, as tall as the
 * highest tap box. It no longer takes taps (the hit boxes do) and a wide one
 * picked a chair beside a window (device 2026-09-24d); it still sets the
 * render cull (64 x its diagonal, at least 64 blocks - far enough for a door).
 */
export function interactiveCollision(hit: InteractiveHitboxes, f = 1): { width: number; height: number } {
  const top = Math.max(HITBOX_MIN_BLOCKS, ...[...hit.closed, ...hit.open].map(b => b.pivot[1] + b.height / 2));
  return { width: r3(0.25 * f), height: r3(top * f) };
}

/**
 * The behaviour: static, unhurt, not pushed, tap- and interact-able, keeps its
 * state across reloads. Its tap boxes are a component group per placement
 * turn x wand size x state (`hitGroupName`), which the runtime selects; the
 * wand's own `craftmatic:size_<pct>` events (fired by the placement on every
 * actor) select the turn-0 closed boxes until the runtime's first sync.
 */
export function interactiveBehavior(typeId: string, it: SceneInteractive, hit: InteractiveHitboxes): unknown {
  const groups: Record<string, unknown> = {}, events: Record<string, unknown> = {};
  const all: string[] = [];
  for (const r of [0, 90, 180, 270]) for (const pct of SIZE_STEPS) for (const open of [false, true]) all.push(hitGroupName(r, pct, open));
  for (const r of [0, 90, 180, 270]) for (const pct of SIZE_STEPS) for (const open of [false, true]) {
    const name = hitGroupName(r, pct, open), f = pct / 100;
    groups[name] = {
      'minecraft:custom_hit_test': { hitboxes: (open ? hit.open : hit.closed).map(b => placeHitBox(b, r, f)) },
      'minecraft:collision_box': interactiveCollision(hit, f),
    };
    events[name] = { remove: { component_groups: all.filter(n => n !== name) }, add: { component_groups: [name] } };
  }
  for (const pct of SIZE_STEPS) events[`${SIZE_EVENT_PREFIX}${pct}`] = { remove: { component_groups: all.filter(n => n !== hitGroupName(0, pct, false)) }, add: { component_groups: [hitGroupName(0, pct, false)] } };
  return { format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true, properties: interactiveProperties() },
    components: {
      'minecraft:type_family': { family: [INTERACTIVE_FAMILY, `craftmatic_ix_${it.kind}`] },
      'minecraft:persistent': {}, 'minecraft:nameable': {},
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
      'minecraft:fire_immune': {},
      'minecraft:knockback_resistance': { value: 1 },
      'minecraft:collision_box': interactiveCollision(hit),
      'minecraft:custom_hit_test': { hitboxes: hit.closed },
      'minecraft:physics': { has_gravity: false, has_collision: false },
      // NOT `minecraft:pushable`: format 1.26.30 dropped it and the whole entity then fails to load.
      'minecraft:pushable_by_block': {},
      'minecraft:interact': { interactions: [{ interact_text: INTERACT_TEXT[it.kind], swing: true }] },
    },
    component_groups: groups, events,
  } };
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
  /**
   * Doorways whose closed cells share or touch this one's: a shared cell stays
   * laid while any of them is closed. Touching is not enough to move together
   * (76457's Door 1 and Door 2 are two doors side by side, device 2026-09-24e);
   * `pairs` says which leaves are one double door.
   */
  shares: number[];
  /** The other leaf of a DOUBLE door (`pairDoubleDoors`): hinged at the far end, free ends meeting. They open and close together. */
  pairs?: number[];
  /** The part's tap boxes at turn 0 and 100 %, closed and open, about the entity's origin (`interactiveHitboxes`): the runtime's line-of-sight test. */
  hit?: { c: HitBox[]; o: HitBox[] };
  /** A sliding part: model blocks (100 %) it moves per unit of `angle` (which is then a distance in LDU) along `axis`. */
  slide?: number;
  sounds: { open: string; close: string };
  /** The hinge point and unit axis in model blocks at 100 % (the placement's frame). The walk preview swings the part about it; the runtime does not need it. */
  pivot?: [number, number, number];
  axis?: [number, number, number];
  /** A leaf's unit normal (across its thickness) in model blocks: the way a player walks through its doorway. */
  normal?: [number, number, number];
  /** A leaf's closed mid-plane in model blocks at 100 % (corner, along, up, normal, thickness): what the runtime checks occupants against. */
  leaf?: { c: number[]; a: number[]; u: number[]; n: number[]; t: number };
}

export interface InteractiveRuntimeConfig {
  family: string;
  property: string;
  label: string;
  /** The 100 % grid (the placement's own dims). */
  dims: { width: number; height: number; length: number };
  colliders: { block: string; loState: string; hiState: string };
  items: InteractiveRuntimeItem[];
  /** The actor properties the rig's root follows: the placement's quarter turn and wand size. */
  turnProperty: string;
  sizeProperty: string;
}

/** The dynamic properties the placement writes on a spawned interactive and the runtime keeps its state in. */
export const IX_KEYS = {
  index: 'craftmatic:ix', anchor: 'craftmatic:ix_anchor', rotation: 'craftmatic:ix_rotation', scale: 'craftmatic:ix_scale',
  open: 'craftmatic:ix_open', angle: 'craftmatic:ix_angle', ready: 'craftmatic:ix_ready',
} as const;

/** Round an open angle for the config (tenths). */
const r1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * The runtime record of one moving part. `blocksPerLdu` is the model's scale
 * (its collider frame's `scale / cellXZ`; 1 / 53.33 at minifig scale): the
 * opening and its passable size are in blocks of THIS model, not of a
 * minifig-scale one.
 */
export function interactiveRuntimeItem(it: SceneInteractive, type: string, label: string, plan: InteractiveColliderPlan | null, blocksPerLdu = 1 / LDU_PER_BLOCK): InteractiveRuntimeItem {
  const doorway = PASSAGE_KINDS.has(it.kind);
  const opening = it.openingLdu ? { width: r1(it.openingLdu.width * blocksPerLdu), height: r1(it.openingLdu.height * blocksPerLdu) } : undefined;
  const leafSounds = { open: 'random.door_open', close: 'random.door_close' };
  return {
    type, kind: it.kind, label, angle: r1(it.angleDeg),
    ...(doorway ? { passSize: passSizeFor(it.kind, it.openingLdu, undefined, blocksPerLdu) } : {}),
    ...(opening && doorway ? { opening } : {}),
    blocking: plan?.blocking ?? [], neighbours: plan?.neighbours ?? [], shares: [],
    sounds: it.kind === 'turnable' || it.kind === 'lever' ? { open: 'random.click', close: 'random.click' } : leafSounds,
  };
}

/** Fill `shares`: doorways whose blocking cells overlap or touch. */
export function linkSharedDoorways(items: InteractiveRuntimeItem[]): void {
  // Doorways whose closed cells share a cell or touch (a column apart, rows
  // overlapping) lay a shared cell while either is closed. Whether they MOVE
  // together is `pairDoubleDoors`'s question, answered from the leaves.
  const touch = (a: IxCell, b: IxCell): boolean => Math.abs(a[0] - b[0]) <= 1 && Math.abs(a[2] - b[2]) <= 1 && a[1] === b[1];
  items.forEach((a, i) => items.forEach((b, j) => {
    if (i >= j || a.kind !== b.kind || !a.blocking.length || !b.blocking.length) return;
    if (!a.blocking.some(ca => b.blocking.some(cb => touch(ca, cb)))) return;
    if (!a.shares.includes(j)) a.shares.push(j);
    if (!b.shares.includes(i)) b.shares.push(i);
  }));
}

/** How close two leaves' free edges must be (blocks at 100 %) to be the two halves of one double door. */
export const DOUBLE_DOOR_GAP_BLOCKS = 0.35;

/**
 * Fill `pairs`: the two leaves of a double door, which open and close on one
 * tap. Needs `leaf` (the closed mid-plane). Two leaves pair when they are the
 * same kind, their doorways touch (`shares`), their heights overlap, and
 * either their planes are parallel (within 30 degrees) with their FREE edges
 * meeting (within `DOUBLE_DOOR_GAP_BLOCKS`) while their hinges stand apart, or
 * their hinges stand exactly the two leaves' widths apart (within the same
 * gap) - a door hinged at each jamb, which the second test still finds when
 * the source left both leaves open (76269's). Two doors hung side by side,
 * each hinged on the same side, touch but do not pair: 76457's Door 1 swung
 * whenever Door 2 was tapped. Leaves also pair when one's closed cells stand
 * a step along the other's normal from its own (10326's two leaves meeting at
 * a corner: neither doorway passes unless both open).
 */
export function pairDoubleDoors(items: InteractiveRuntimeItem[]): void {
  const flat = (v: readonly number[]): [number, number] => [v[0]!, v[2]!];
  items.forEach((a, i) => items.forEach((b, j) => {
    if (i >= j || a.kind !== b.kind || !a.leaf || !b.leaf || !a.shares.includes(j)) return;
    const ha = flat(a.leaf.c), hb = flat(b.leaf.c);
    const fa: [number, number] = [ha[0] + a.leaf.a[0]!, ha[1] + a.leaf.a[2]!], fb: [number, number] = [hb[0] + b.leaf.a[0]!, hb[1] + b.leaf.a[2]!];
    const gap = Math.hypot(fa[0] - fb[0], fa[1] - fb[1]), span = Math.hypot(ha[0] - hb[0], ha[1] - hb[1]);
    const na = flat(a.leaf.n), nb = flat(b.leaf.n);
    const cos = Math.abs(na[0] * nb[0] + na[1] * nb[1]) / ((Math.hypot(...na) * Math.hypot(...nb)) || 1);
    const ya: [number, number] = [a.leaf.c[1]!, a.leaf.c[1]! + a.leaf.u[1]!], yb: [number, number] = [b.leaf.c[1]!, b.leaf.c[1]! + b.leaf.u[1]!];
    const overlapY = Math.min(Math.max(...ya), Math.max(...yb)) - Math.max(Math.min(...ya), Math.min(...yb));
    if (overlapY <= 0) return;
    const wa = Math.hypot(a.leaf.a[0]!, a.leaf.a[2]!), wb = Math.hypot(b.leaf.a[0]!, b.leaf.a[2]!);
    const meeting = gap <= DOUBLE_DOOR_GAP_BLOCKS && span > gap + 0.5 && cos >= Math.cos(Math.PI / 6);
    const jambs = Math.abs(span - (wa + wb)) <= DOUBLE_DOOR_GAP_BLOCKS;
    // One leaf's closed cells stand right in front of or behind the other's
    // (a step along its normal): neither doorway passes unless both open, so
    // they are one entrance - 10326's two leaves meeting at a corner.
    const inPath = (p: InteractiveRuntimeItem, q: InteractiveRuntimeItem): boolean => {
      const n = flat(p.leaf!.n), axis = Math.abs(n[0]) >= Math.abs(n[1]) ? 0 : 2;
      const cells = new Set(q.blocking.map(c => `${c[0]},${c[1]},${c[2]}`));
      return p.blocking.some(c => [-1, 1].some(d => cells.has(axis === 0 ? `${c[0] + d},${c[1]},${c[2]}` : `${c[0]},${c[1]},${c[2] + d}`)));
    };
    const oneEntrance = inPath(a, b) || inPath(b, a);
    if (!meeting && !jambs && !oneEntrance) return;
    a.pairs = [...(a.pairs ?? []), j];
    b.pairs = [...(b.pairs ?? []), i];
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
function interactivesRuntime(config: InteractiveRuntimeConfig, worldBlocks: typeof ixWorldBlocks, kit: ColliderFormKit, relayShift: typeof relayRounding, bodyProbe: typeof colliderBodyProbe): void {
  const K = { index: 'craftmatic:ix', anchor: 'craftmatic:ix_anchor', rotation: 'craftmatic:ix_rotation', scale: 'craftmatic:ix_scale', open: 'craftmatic:ix_open', angle: 'craftmatic:ix_angle', ready: 'craftmatic:ix_ready' };
  const C = config.colliders;
  // Where a body fits over this pack's colliders (a step-out lands only there).
  const body = bodyProbe(kit, C.loState, C.hiState);
  const byType = new Map<string, number>();
  config.items.forEach((it, i) => byType.set(it.type, i));
  const lastUse = new Map<string, number>();
  const synced = new Set<string>();
  const percent = (n: number): string => `${n} percent`;
  const say = (p: any, s: string): void => { try { p.onScreenDisplay.setActionBar(s); } catch { /* player left */ } };
  /**
   * A refused tap: tell the player, and keep the reason on the part
   * (`craftmatic:ix_refused`, "<tick> <text>") so a GameTest can log WHY a
   * device refused what the offline host accepted (31141's Window 2 and
   * 71040's Door 1 closing hits, 2026-09-25: the action bar is not logged).
   */
  /** The collider cell that last cut a sight line (`sightClear`), for the refusal record. */
  let lastWall = '';
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  /**
   * The refusal record also carries where the eyes and the part were and the
   * cell that cut the sight line: the device refused 31141's Window 2 and
   * 80049's Window 3 from spots the offline host accepts (GameTest
   * 2026-09-26), and only the device can say which wall it saw.
   */
  const refuse = (e: any, p: any, s: string): void => {
    say(p, s);
    let where = '';
    try {
      const h = p.getHeadLocation(), l = e.location;
      where = ` | eyes ${r2(h.x)},${r2(h.y)},${r2(h.z)} part ${r2(l.x)},${r2(l.y)},${r2(l.z)}${lastWall ? ` wall ${lastWall}` : ''}`;
    } catch { /* player or part gone */ }
    try { e.setDynamicProperty('craftmatic:ix_refused', `${system.currentTick} ${s}${where}`); } catch { /* entity gone */ }
  };
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
  /** The sibling doorway entities of item `i` at this placement, by item index: those sharing cells (`shares`) or the other leaf of a double door (`pairs`). */
  const siblings = (e: any, i: number, pl: any, which: 'shares' | 'pairs' = 'shares'): Map<number, any> => {
    const out = new Map<number, any>();
    const shares: number[] = (config.items[i] as any)[which] || [];
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
    const cells: IxCell[] = [...it.neighbours];
    if (blocksClosed(it, pl, open)) cells.push(...it.blocking);
    for (const [j, s] of siblings(e, i, pl)) if (blocksClosed(config.items[j]!, pl, isOpen(s))) cells.push(...config.items[j]!.blocking);
    const want = worldBlocks(cells, config.dims, pl.f, pl.r, kit);
    const own = worldBlocks(it.blocking, config.dims, pl.f, pl.r, kit);
    let ok = true;
    for (const key of own.keys()) {
      const [x, y, z] = key.split(',').map(Number);
      const pos = { x: pl.anchor.x + x!, y: pl.anchor.y + y!, z: pl.anchor.z + z! };
      let b: any;
      try { b = e.dimension.getBlock(pos); } catch { b = undefined; }
      if (!b) { ok = false; continue; }
      // Any collider form is ours (collider-form.ts); the full one is `C.block`.
      const ours = kit.variantOf(b.typeId) >= 0, air = b.isAir === true || b.typeId === 'minecraft:air';
      const st = want.get(key);
      try {
        if (st) {
          // Never overwrite a block that is not ours (the player built there).
          if (!ours && !air) continue;
          const id = kit.VARIANTS[st[2] || 0]!.id;
          if (ours && b.typeId === id && Number(b.permutation.getState(C.loState)) === st[0] && Number(b.permutation.getState(C.hiState)) === st[1]) continue;
          kit.lay(b, { v: st[2] || 0, lo: st[0], hi: st[1] }, C.loState, C.hiState, (rid: string, rst: any) => BlockPermutation.resolve(rid, rst));
        } else if (ours) b.setPermutation(BlockPermutation.resolve('minecraft:air'));
      } catch { ok = false; }
    }
    return ok;
  };
  /** A player or a figure standing where the closed leaf would go (never close a door on someone). */
  /** A model point (blocks at 100 %, the placement's frame) in the world, for this placement's anchor, turn and size (the wand's `worldPoint`). */
  const toWorld = (pl: any, v: number[]): { x: number; y: number; z: number } => {
    const W = config.dims.width, L = config.dims.length, x = v[0]!, z = v[2]!;
    const q = pl.r === 90 ? [L - z, x] : pl.r === 180 ? [W - x, L - z] : pl.r === 270 ? [z, W - x] : [x, z];
    return { x: pl.anchor.x + q[0]! * pl.f, y: pl.anchor.y + v[1]! * pl.f, z: pl.anchor.z + q[1]! * pl.f };
  };
  /** A model direction turned by the placement (no translation). */
  const turnDir = (pl: any, d: number[]): { x: number; z: number } => pl.r === 90 ? { x: -d[2]!, z: d[0]! } : pl.r === 180 ? { x: -d[0]!, z: -d[2]! } : pl.r === 270 ? { x: d[2]!, z: -d[0]! } : { x: d[0]!, z: d[2]! };
  /** Players and figures near a point (anything else - the shell, the seats, the parts - is not an occupant). */
  const occupants = (e: any, at: any, reach: number): any[] => {
    let near: any[] = [];
    try { near = e.dimension.getEntities({ location: at, maxDistance: reach }); } catch { return []; }
    return near.filter(o => {
      const t = String(o.typeId || '');
      return t === 'minecraft:player' || !t.startsWith('craftmatic:') || !!(o.getComponent && o.getComponent('minecraft:type_family')?.hasTypeFamily?.('craftmatic_figure'));
    });
  };
  /**
   * Someone standing where the CLOSED LEAF itself goes (its slab: the leaf's
   * rectangle, sampled every ~0.15 block, against the 0.6 x 1.8 body). Not
   * the doorway's whole blocks: a player just outside the leaf was told
   * "something is standing in the door" at 76417's entrance (device
   * 2026-09-24d) and the doors stayed open. A player inside the doorway's
   * blocks but clear of the leaf is stepped out of them instead (`stepOut`).
   */
  const obstructed = (e: any, i: number, pl: any): boolean => {
    const it = config.items[i]!;
    const lf = it.leaf;
    // Only a DOORWAY refuses to close on someone: a window, a lid or a cupboard door
    // shuts past a player beside it (GameTest 2026-09-25: a player standing at a chest
    // could open its lid but never close it again).
    if (!lf || !it.blocking.length) return false;
    const c = toWorld(pl, lf.c), a = toWorld(pl, [lf.c[0]! + lf.a[0]!, lf.c[1]! + lf.a[1]!, lf.c[2]! + lf.a[2]!]), u = toWorld(pl, [lf.c[0]! + lf.u[0]!, lf.c[1]! + lf.u[1]!, lf.c[2]! + lf.u[2]!]);
    const A = { x: a.x - c.x, y: a.y - c.y, z: a.z - c.z }, U = { x: u.x - c.x, y: u.y - c.y, z: u.z - c.z };
    const nA = Math.max(2, Math.ceil(Math.hypot(A.x, A.y, A.z) / 0.15) + 1), nU = Math.max(2, Math.ceil(Math.hypot(U.x, U.y, U.z) / 0.15) + 1);
    const half = lf.t * pl.f / 2 + 0.02;
    const mid = { x: c.x + A.x / 2 + U.x / 2, y: c.y + A.y / 2 + U.y / 2, z: c.z + A.z / 2 + U.z / 2 };
    for (const o of occupants(e, mid, Math.hypot(A.x, A.y, A.z) + Math.hypot(U.x, U.y, U.z) + 2)) {
      const l = o.location, w = 0.3 + half;
      for (let s = 0; s < nA; s++) for (let t = 0; t < nU; t++) {
        const px = c.x + A.x * s / (nA - 1) + U.x * t / (nU - 1), py = c.y + A.y * s / (nA - 1) + U.y * t / (nU - 1), pz = c.z + A.z * s / (nA - 1) + U.z * t / (nU - 1);
        if (px > l.x - w && px < l.x + w && pz > l.z - w && pz < l.z + w && py > l.y - half && py < l.y + 1.8 + half) return true;
      }
    }
    return false;
  };
  /**
   * After closing: a player or figure standing in the doorway's laid blocks (not on the leaf) is stepped out
   * along the leaf's normal to the side it stands on - to the first point out of the doorway's blocks where its
   * body is FREE of colliders, else the other side's, else (nowhere free within reach) the first point out of the
   * doorway as before. Until 2026-09-30 it took the first point out of the doorway whatever stood there: at
   * 150 % 76417's Door 3 stepped a player 0.29 block into the wall beside it (simulator triage).
   */
  const stepOut = (e: any, i: number, pl: any): void => {
    const it = config.items[i]!;
    if (!it.blocking.length || !it.leaf) return;
    const own = [...worldBlocks(it.blocking, config.dims, pl.f, pl.r, kit).entries()].map(([key, span]) => { const [x, y, z] = key.split(',').map(Number); return { x: pl.anchor.x + x!, y: pl.anchor.y + y! + span[0] / 16, z: pl.anchor.z + z!, top: pl.anchor.y + y! + span[1] / 16 }; });
    const inside = (l: any): boolean => own.some(bk => l.x + 0.3 > bk.x && l.x - 0.3 < bk.x + 1 && l.z + 0.3 > bk.z && l.z - 0.3 < bk.z + 1 && l.y + 1.8 > bk.y && l.y < bk.top);
    const n = turnDir(pl, it.leaf.n), centre = toWorld(pl, [it.leaf.c[0]! + it.leaf.a[0]! / 2, it.leaf.c[1]!, it.leaf.c[2]! + it.leaf.a[2]! / 2]);
    const reach = 3 * Math.max(1, pl.f);
    for (const o of occupants(e, centre, 4 * Math.max(1, pl.f))) {
      const l = o.location;
      if (!inside(l)) continue;
      const side = (l.x - centre.x) * n.x + (l.z - centre.z) * n.z >= 0 ? 1 : -1;
      const along = (sd: number, free: boolean): any => {
        for (let d = 0.1; d <= reach; d += 0.1) {
          const q = { x: l.x + n.x * sd * d, y: l.y, z: l.z + n.z * sd * d };
          if (inside(q)) continue;
          if (!free || body.bodyFree(e.dimension, q)) return q;
        }
        return undefined;
      };
      const q = along(side, true) ?? along(-side, true) ?? along(side, false);
      if (q) { try { o.teleport(q); } catch { /* not movable */ } }
    }
  };
  /** Select the tap boxes for this placement's turn and size and the part's state (`hitGroupName`), and turn/scale the rig's root to match. */
  const place = (e: any, pl: any, open: boolean): void => {
    const pct = [25, 50, 75, 100, 150, 200, 300, 400].includes(Math.round(pl.f * 100)) ? Math.round(pl.f * 100) : 100;
    try { e.setProperty(config.turnProperty, pl.r); e.setProperty(config.sizeProperty, pl.f); } catch { /* property component missing */ }
    try { e.triggerEvent(`craftmatic:ixh_${pl.r}_${pct}_${open ? 'o' : 'c'}`); } catch { /* event missing: an older pack */ }
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
    // A double door's leaves move together: the tapped one and its other leaf at this placement.
    const group: Array<{ e: any; i: number }> = [{ e, i }, ...[...siblings(e, i, pl, 'pairs')].map(([j, s]) => ({ e: s, i: j }))];
    if (!open && group.some(g => obstructed(g.e, g.i, pl))) { refuse(e, player, `Something is standing in the ${it.label.toLowerCase()} - step out to close it.`); return; }
    const before = group.map(g => isOpen(g.e));
    for (const g of group) { try { g.e.setDynamicProperty(K.open, open); } catch { /* keep going */ } }
    if (!group.every(g => layDoorway(g.e, g.i, pl, open))) {
      group.forEach((g, k) => { try { g.e.setDynamicProperty(K.open, before[k]); } catch { /* keep going */ } layDoorway(g.e, g.i, pl, before[k]!); });
      refuse(e, player, `The ${it.label.toLowerCase()} is not loaded - come closer.`);
      return;
    }
    for (const g of group) { setAngle(g.e, open ? config.items[g.i]!.angle : 0); place(g.e, pl, open); }
    if (!open) for (const g of group) stepOut(g.e, g.i, pl);
    sound(e, open ? it.sounds.open : it.sounds.close);
    if (open && it.passSize !== undefined && !passable(it, pl)) {
      const size = it.opening ? `${it.opening.width} x ${it.opening.height} blocks at 100 percent` : 'too small';
      say(player, it.passSize > 0
        ? `This opening is ${size}: too small to walk through at ${percent(Math.round(pl.f * 100))}. Place the build at ${percent(it.passSize)} or larger to pass.`
        : `This opening is ${size}: too small to walk through at any wand size.`);
    }
  };
  /** The part's tap boxes for its state, placed at the entity for this placement's turn and size (`placeHitBox`), as world AABBs. */
  const placedBoxes = (e: any, it: any, pl: any): Array<{ x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }> => {
    const list: any[] = (it.hit && (isOpen(e) && it.kind !== 'turnable' ? it.hit.o : it.hit.c)) || [];
    const l = e.location;
    return list.map((b: any) => {
      const x = b.pivot[0], y = b.pivot[1], z = b.pivot[2];
      const t = pl.r === 90 ? [-z, x] : pl.r === 180 ? [-x, -z] : pl.r === 270 ? [z, -x] : [x, z];
      const cx = l.x + t[0]! * pl.f, cy = l.y + y * pl.f, cz = l.z + t[1]! * pl.f, w = b.width * pl.f / 2, h = b.height * pl.f / 2;
      return { x0: cx - w, x1: cx + w, y0: cy - h, y1: cy + h, z0: cz - w, z1: cz + w };
    });
  };
  /**
   * Whether a wall of this pack's colliders stands between the player's eyes
   * and EVERY visible point of the part. Collider blocks have no selection box
   * (a tap passes through them), so without this a tap on a wall reached a
   * door in the next room (76417's shop door through the bank-hall wall,
   * device 2026-09-24d). The test is a line of sight from the eyes to each tap
   * box (its centre and the point nearest the eyes), NOT the view direction:
   * on a touch screen the finger is not where the camera looks, and a view-ray
   * test refused 76457's Door 1 from the spot a player stood at to tap it
   * (device 2026-09-24e). A collider cell within `PART_MARGIN` of the part's tap boxes
   * (a window in its wall cell, a leaf 9 degrees off the grid poking into its
   * frame's cell) and the doorway's own closed cells are not a wall; nor is
   * the last `WALL_MARGIN` of each line.
   */
  /** The last stretch of a sight line that is never a wall (the part's own frame, blocks). */
  const WALL_MARGIN = 0.3;
  /** A player's collision box (Bedrock's 0.6 x 1.8) at its feet, world blocks. */
  const bodyBox = (player: any): any => {
    let l: any;
    try { l = player.location; } catch { return undefined; }
    return l ? { x0: l.x - 0.3, x1: l.x + 0.3, y0: l.y, y1: l.y + 1.8, z0: l.z - 0.3, z1: l.z + 0.3 } : undefined;
  };
  /**
   * Whether the line from `head` to `to` crosses no collider FORM box (a
   * clearance form blocks only where it is), sampled every 0.1 block from 0.3
   * out to `WALL_MARGIN` short of the end; `skip(cell)` names cells that are
   * the target's own and never a wall. A form box the player's own `body`
   * overlaps is not a wall either: it stands AROUND the player, not between
   * the player and the part. Round 30h (Saga, 10326 Door 3 from 1.9 blocks,
   * leaf in plain view): the player stood in the invisible collider band a
   * tilted handrail's bounding box leaves at head height (`collider_w10`),
   * every line of sight started inside it, and the tap was refused "behind a
   * wall". A player's box cannot enter a collider it walks into, so this
   * only answers for one the device let it stand in (a teleport, a form laid
   * round it); a wall the player stands clear of still refuses.
   */
  const sightClear = (dim: any, head: any, to: any, skip: (p: any) => boolean, body?: any): boolean => {
    const d = { x: to.x - head.x, y: to.y - head.y, z: to.z - head.z }, n = Math.hypot(d.x, d.y, d.z);
    if (n < 1e-6) return true;
    let last = '';
    for (let s = 0.3; s < n - WALL_MARGIN; s += 0.1) {
      const q = { x: head.x + d.x * s / n, y: head.y + d.y * s / n, z: head.z + d.z * s / n };
      const p = { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) };
      const key = `${p.x},${p.y},${p.z}`;
      if (key === last) continue;
      last = key;
      if (skip(p)) continue;
      let b: any;
      try { b = dim.getBlock(p); } catch { b = undefined; }
      const v = b ? kit.variantOf(b.typeId) : -1;
      if (v < 0) continue;
      const lo = Number(b.permutation.getState(C.loState)), hi = Number(b.permutation.getState(C.hiState));
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      const fx = (q.x - p.x) * 16, fy = (q.y - p.y) * 16, fz = (q.z - p.z) * 16;
      // Overlap past a sliver (1/64 block): a player standing against a wall touches its face without entering it.
      const around = (w: readonly number[]): boolean => !!body
        && p.x + w[1]! / 16 > body.x0 + 0.016 && p.x + w[0]! / 16 < body.x1 - 0.016
        && p.y + w[3]! / 16 > body.y0 + 0.016 && p.y + w[2]! / 16 < body.y1 - 0.016
        && p.z + w[5]! / 16 > body.z0 + 0.016 && p.z + w[4]! / 16 < body.z1 - 0.016;
      if (kit.formBoxes(v, lo, hi).some(w => fx >= w[0] && fx <= w[1] && fy >= w[2] && fy <= w[3] && fz >= w[4] && fz <= w[5] && !around(w))) {
        lastWall = `${key} ${b.typeId}[${lo},${hi}]`;
        return false;
      }
    }
    return true;
  };
  const behindWall = (player: any, target: any): boolean => {
    lastWall = '';
    let head: any;
    try { head = player.getHeadLocation(); } catch { return false; }
    if (!head) return false;
    const i = itemOf(target), pl = placementOf(target);
    if (i === undefined || !pl) return false;
    const it = config.items[i]!;
    const boxes = placedBoxes(target, it, pl);
    if (!boxes.length) return false;
    // Cells within this of a tap box are the part's own frame: a pane set back in a
    // deep frame whose cell the collider grid fills whole (76417's tower windows).
    // Above 100 % the re-lay moves a wall by up to `relayShift(f)` (half a block at
    // 150 %: a column belongs to the cell holding its centre), so the frame's cell
    // can land that much further out: at 150 % a sill 1.1 blocks from 11371's
    // Lever 1 and a wall 1.05 from 910032's Turnable 2 refused every tap that
    // reached them, with nothing DRAWN on the line (simulator triage 2026-09-30).
    const PART_MARGIN = 0.75 + relayShift(pl.f);
    const own = new Set<string>();
    for (const j of [i, ...(it.shares || [])]) {
      for (const key of worldBlocks(config.items[j]!.blocking, config.dims, pl.f, pl.r, kit).keys()) {
        const [x, y, z] = key.split(',').map(Number);
        own.add(`${pl.anchor.x + x!},${pl.anchor.y + y!},${pl.anchor.z + z!}`);
      }
    }
    const inPart = (p: any): boolean => boxes.some(b => p.x + 1 > b.x0 - PART_MARGIN && p.x < b.x1 + PART_MARGIN && p.y + 1 > b.y0 - PART_MARGIN && p.y < b.y1 + PART_MARGIN && p.z + 1 > b.z0 - PART_MARGIN && p.z < b.z1 + PART_MARGIN);
    const body = bodyBox(player);
    const clear = (to: any): boolean => sightClear(target.dimension, head, to, (p: any) => own.has(`${p.x},${p.y},${p.z}`) || inPart(p), body);
    for (const b of boxes) {
      const centre = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, z: (b.z0 + b.z1) / 2 };
      const near = { x: Math.max(b.x0, Math.min(head.x, b.x1)), y: Math.max(b.y0, Math.min(head.y, b.y1)), z: Math.max(b.z0, Math.min(head.z, b.z1)) };
      if (clear(centre) || clear(near)) return false;
    }
    return true;
  };
  /** The ray's entry distance into a world box, or Infinity. */
  const rayEntry = (o: any, d: any, b: any): number => {
    let t0 = -Infinity, t1 = Infinity;
    for (const [oo, dd, lo, hi] of [[o.x, d.x, b.x0, b.x1], [o.y, d.y, b.y0, b.y1], [o.z, d.z, b.z0, b.z1]] as number[][]) {
      if (Math.abs(dd!) < 1e-12) { if (oo! < lo! || oo! > hi!) return Infinity; continue; }
      const a = (lo! - oo!) / dd!, c = (hi! - oo!) / dd!;
      t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
    }
    return t1 >= Math.max(t0, 0) ? Math.max(t0, 0) : Infinity;
  };
  /**
   * A tap Bedrock handed to a part BEHIND a wall, when the player aimed past
   * it at something in plain sight: on the Pixel a long press on 76457's Bed
   * picked Door 4's tap box ("behind a wall") - collider walls have no
   * selection box, so the door's box beyond the wall was the first on the
   * ray. The nearest other moving part or seat on the player's view ray, in
   * reach, with a clear line of sight, takes the tap instead: a part is
   * toggled, a seat is mounted. Nothing else does: then the refusal stands.
   */
  const forward = (player: any, from: any): boolean => {
    let head: any, view: any;
    try { head = player.getHeadLocation(); view = player.getViewDirection(); } catch { return false; }
    if (!head || !view) return false;
    const REACH = 6;
    let near: any[] = [];
    try { near = from.dimension.getEntities({ location: head, maxDistance: REACH + 2 }); } catch { return false; }
    let best: { e: any; t: number; seat: boolean } | null = null;
    for (const e of near) {
      if (!e || e.id === from.id) continue;
      const i = itemOf(e), pl = i !== undefined ? placementOf(e) : undefined;
      let seat = false;
      try { seat = i === undefined && /_seat(_\d+)?$/.test(e.typeId || '') && !!e.getComponent('minecraft:rideable'); } catch { seat = false; }
      if (!(i !== undefined && pl) && !seat) continue;
      const l = e.location;
      const boxes = seat ? [{ x0: l.x - 0.3, x1: l.x + 0.3, y0: l.y, y1: l.y + 0.6, z0: l.z - 0.3, z1: l.z + 0.3 }] : placedBoxes(e, config.items[i!]!, pl);
      const t = Math.min(...boxes.map((b: any) => rayEntry(head, view, b)));
      if (!(t <= REACH) || (best && t >= best.t)) continue;
      if (seat) {
        const c = { x: l.x, y: l.y + 0.3, z: l.z };
        const cell = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) };
        if (!sightClear(e.dimension, head, c, (p: any) => Math.abs(p.x - cell.x) + Math.abs(p.y - cell.y) + Math.abs(p.z - cell.z) === 0, bodyBox(player))) continue;
      } else if (behindWall(player, e)) continue;
      best = { e, t, seat };
    }
    if (!best) return false;
    if (best.seat) {
      try { return !!best.e.getComponent('minecraft:rideable')?.addRider(player); } catch { return false; }
    }
    const now = system.currentTick;
    if (now - (lastUse.get(best.e.id) ?? -100) < 6) return true;
    lastUse.set(best.e.id, now);
    const target = best.e;
    system.run(() => toggle(target, player));
    return true;
  };
  const use = (player: any, target: any): void => {
    if (!target || !target.typeId || itemOf(target) === undefined) return;
    if (behindWall(player, target)) {
      if (forward(player, target)) return;
      // Never refuse silently: a tap that does nothing reads as a broken part (device 2026-09-24e).
      refuse(target, player, `The ${config.items[itemOf(target)!]!.label.toLowerCase()} is behind a wall from here - step in front of it.`);
      return;
    }
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
        place(e, pl, it.kind !== 'turnable' && isOpen(e));
        synced.add(e.id);
      }
    }
  }, 10);
  console.warn(`CRAFTMATIC_INTERACTIVES_READY ${config.label} ${config.items.length}`);
}

/** The behaviour pack's `scripts/interactives.js`. */
export function interactivesScript(config: InteractiveRuntimeConfig): string {
  return `import { world, system, BlockPermutation } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${interactivesRuntime.toString()})(CONFIG, ${ixWorldBlocks.toString()}, (${colliderFormKit.toString()})(), ${relayRounding.toString()}, ${colliderBodyProbe.toString()});\n`;
}


/**
 * The world blocks every CLOSED doorway lays at wand factor `f` and turn `r`,
 * with the exact merged state the runtime writes (`layDoorway`): the closed
 * leaves' cells over the static neighbours, keyed `"x,y,z"` from the anchor.
 * An open doorway that is passable at this size adds nothing (its blocks are
 * the static grid's); an open one too small to pass stays closed here, as in
 * the runtime. For the walk preview and the passability test.
 */
export function ixClosedBlocks(items: readonly InteractiveRuntimeItem[], dims: { width: number; length: number }, f: number, r: number, isOpen: (index: number) => boolean): Map<string, [number, number, number?]> {
  const pct = Math.round(f * 100);
  const blocksAt = (i: number): boolean => {
    const it = items[i]!;
    if (!it.blocking.length) return false;
    return !(isOpen(i) && it.passSize !== undefined && it.passSize > 0 && pct >= it.passSize);
  };
  const closed = items.map((_, i) => i).filter(blocksAt);
  if (!closed.length) return new Map();
  const cells: IxCell[] = [];
  for (const i of closed) cells.push(...items[i]!.neighbours, ...items[i]!.blocking);
  const merged = ixWorldBlocks(cells, dims, f, r, COLLIDER_KIT);
  const own = ixWorldBlocks(closed.flatMap(i => items[i]!.blocking), dims, f, r, COLLIDER_KIT);
  const out = new Map<string, [number, number, number?]>();
  for (const key of own.keys()) { const st = merged.get(key); if (st) out.set(key, st); }
  return out;
}
