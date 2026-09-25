/**
 * A PLAYABLE PINBALL in a Bedrock add-on, built from a LEGO pinball machine's
 * own geometry (engine/pinball-table.ts) and simulated by the same code the
 * tests run (engine/pinball-physics.ts).
 *
 * WHAT SHIPS:
 *   - the machine as the usual brick shell, minus its flippers, its plunger,
 *     its spare balls and loose accessories (a brick separator);
 *   - each FLIPPER as its own entity compiled from its exact parts, rigged
 *     with three bones at its pivot (tilt -> spin -> un-tilt) so a single
 *     float property swings it about the tilted playfield's normal;
 *   - the PLUNGER as its own entity (the set's tow-ball tip, rod and knob),
 *     drawn back along the lane by a `pull` property;
 *   - the BALL as an entity compiled from the set's own ball part. It stands
 *     at the serve point and the client draws it where the simulation says:
 *     the runtime sends the plane position AND velocity as actor properties
 *     every tick and the ball's animation extrapolates between ticks
 *     (`BALL_PRE_ANIMATION`), so it moves at the frame rate, not in 20 Hz
 *     jumps. The older per-tick teleport stays as a live option;
 *   - a CONSOLE: a yellow pad in front of the machine ("Play pinball"). Sitting
 *     on it lifts the player's head to a viewpoint just behind the table's
 *     front edge, with a free camera there looking down the table;
 *   - three TAP TARGETS the runtime spawns in front of the seated head, each
 *     on the line of sight to what it works: one over each flipper and one
 *     over the plunger. Each is a small box drawn as a faint outline, so the
 *     player sees where to tap; tapping it hits the entity (the phone picks
 *     the entity under the finger). Hotbar slots left / right of the middle
 *     and the stick work the flippers too; pulling the stick back draws the
 *     plunger. Sneak leaves.
 *
 * THE PLUNGER works like a real one: tap its target to take hold and draw it
 * back (it pulls further the longer you wait, full in `PULL_TICKS`), tap
 * again to let go; if the phone repeats the event while a finger stays down,
 * lifting the finger lets go. The ball leaves at a speed proportional to the
 * pull (pinball-physics.ts), so a weak pull does not climb the lane.
 *
 * The runtime is serialised with `.toString()` like the coaster's, so it and
 * the functions it is handed may not reference anything outside themselves.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { LdrawPartMesh, Vec3 } from './ldraw-part-geometry.js';
import type { EntityRig } from './minifig-rig.js';
import { pinballSimTable, type PinballTable } from './pinball-table.js';
import { createPinballSim, type PinballSimTable } from './pinball-physics.js';
import { floatActorProperty } from './bedrock-json.js';
import { withSizeGroups } from './bedrock-placement-pack.js';

declare const world: any;
declare const system: any;

// ─── Constants ───────────────────────────────────────────────────────────────

export const PINBALL_FAMILY = 'craftmatic_pinball';
export const PINBALL_INTERACT_TEXT = 'Play pinball';
/** Flipper swing, degrees about the playfield normal (render convention). */
export const PROP_FLIP = 'craftmatic:flip';
/** Plunger pull-back, 0 (rest) .. 1 (full stroke). */
export const PROP_PULL = 'craftmatic:pull';
/** Ball plane offset from the serve point (LDU along u and w) and its velocity (LDU/s). */
export const PROP_BALL_U = 'craftmatic:bu';
export const PROP_BALL_W = 'craftmatic:bw';
export const PROP_BALL_VU = 'craftmatic:bvu';
export const PROP_BALL_VW = 'craftmatic:bvw';
/** Bumped every tick the ball's properties change; the client times its extrapolation from it. */
export const PROP_BALL_SEQ = 'craftmatic:seq';
/** Signs applied to model X and Z in a bone translation (see `PinballRuntimeConfig.axisSigns`). */
export const PROP_SX = 'craftmatic:sx';
export const PROP_SZ = 'craftmatic:sz';
const SPIN_BONE = 'pb_spin';
/** The bone a translated part (ball, plunger) hangs on. */
const MOVE_BONE = 'pb_move';

// ─── Plan ────────────────────────────────────────────────────────────────────

/** Plane (u, w, h) -> model blocks: `p0 + u*U + w*W + h*N`. */
export interface PinballMap { p0: Vec3; u: Vec3; w: Vec3; n: Vec3 }

export interface PinballFlipperPlan {
  side: 'left' | 'right';
  bricks: ParsedBrick[];
  rig: EntityRig;
  restAngle: number;
}

export interface PinballPlungerPlan {
  bricks: ParsedBrick[];
  rig: EntityRig;
  /** Full pull-back, LDU along +u. */
  strokeLdu: number;
}

/** What a tap target works, and the playfield rectangle (u0, u1, w0, w1; LDU) it must cover on screen. */
export interface PinballZoneSpec {
  role: 'left' | 'right' | 'plunger';
  rect: [number, number, number, number];
  /** Height above the model origin along the normal where the target's parts are, LDU. */
  h: number;
}

/** Tap-target geometry: how far in front of the head, and the box each kind of target is. */
export interface PinballZonePlan {
  /** Distance from the head to a target's centre line, blocks (a phone tap reaches ~2-3). */
  reach: number;
  specs: PinballZoneSpec[];
  /** Collision (= pick) box of a flipper target and of the plunger target, blocks. */
  flipperBox: { width: number; height: number };
  plungerBox: { width: number; height: number };
  /** The fitted box per spec from the planned eye, model blocks (for tests and the build report). */
  fits: Array<{ role: string; centre: number[]; lo: number[]; hi: number[] }>;
}

export interface PinballPlan {
  table: PinballTable;
  sim: PinballSimTable;
  map: PinballMap;
  /** Height along N of the ball's centre, LDU. */
  ballH: number;
  flippers: PinballFlipperPlan[];
  plunger: PinballPlungerPlan | null;
  /** The ball the runtime moves: the set's own part, re-placed at the serve point with its centre on it. */
  ballBrick: ParsedBrick;
  /** One bone at the ball's centre, which the ball's animation translates. */
  ballRig: EntityRig;
  /** Its centre in model blocks (where the sim's serve point lands). */
  ballCentreModel: Vec3;
  /** Console seat and camera, model blocks. */
  consoleModel: Vec3;
  consoleYaw: number;
  cameraEyeModel: Vec3;
  cameraLookModel: Vec3;
  zones: PinballZonePlan;
  /** Every brick that leaves the static shell: flippers, plunger, spare balls and loose accessories. */
  moved: Set<ParsedBrick>;
  warnings: string[];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (...vs: Vec3[]): Vec3 => vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0] as Vec3);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Rotation (row-major, LDraw frame) carrying unit `a` onto unit `b` (Rodrigues). */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const v = cross(a, b);
  const c = dot(a, b);
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}
const transpose = (m: number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

/**
 * The flipper rig: every part hangs on `pb_untilt`, which un-tilts about the
 * pivot, spins (`pb_spin`, animated about its own Y) and re-tilts. At zero spin
 * the three cancel and the flipper is exactly where the model put it; any spin
 * turns it about the playfield normal through the pivot.
 */
export function flipperRig(count: number, pivotLdu: Vec3, axisN: Vec3): EntityRig {
  const tilt = rotationBetween([0, -1, 0], axisN); // LDraw up is -Y
  return {
    bones: [
      { name: 'pb_tilt', pivotLdu, rotation: tilt },
      { name: SPIN_BONE, parent: 'pb_tilt', pivotLdu },
      { name: 'pb_untilt', parent: SPIN_BONE, pivotLdu, rotation: transpose(tilt) },
    ],
    boneOf: new Array(count).fill('pb_untilt'),
  };
}

/** A single un-rotated bone every part hangs on; its animation translates the whole entity's geometry. */
export function moveRig(count: number, pivotLdu: Vec3): EntityRig {
  return { bones: [{ name: MOVE_BONE, pivotLdu }], boneOf: new Array(count).fill(MOVE_BONE) };
}

/**
 * Where a tap target must stand so a tap on the screen over `targets` hits it.
 *
 * A tap picks along a ray from the player's HEAD (`origin`); the picture is
 * drawn by a free camera at `cam` looking at `look`. Two models of the ray's
 * direction are supported, because the phone's is not documented:
 *   - `camera`: the ray through the tapped pixel of the camera's picture
 *     (parallel to the camera's line of sight to that point);
 *   - `level`: the same screen position, but mapped through the PLAYER's own
 *     view (same yaw, pitch `levelPitchDeg`), which is what a client that
 *     ignores the camera for picking would do.
 * Every target point's ray is followed `reach` blocks from the origin; the
 * returned box (`lo`..`hi`, axis-aligned) contains all those points, so a box
 * at least that size, centred on `centre`, is crossed by every one of the rays.
 *
 * SELF-CONTAINED: the runtime receives it via `.toString()`.
 */
export function fitPinballZone(
  origin: number[], cam: number[], look: number[], targets: number[][],
  reach: number, model: 'camera' | 'level', levelPitchDeg: number,
): { centre: number[]; lo: number[]; hi: number[] } {
  const subv = (a: number[], b: number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
  const dotv = (a: number[], b: number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const normv = (a: number[]): number[] => { const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1; return [a[0]! / l, a[1]! / l, a[2]! / l]; };
  const crossv = (a: number[], b: number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const f = normv(subv(look, cam));
  let r = crossv(f, [0, 1, 0]);
  r = Math.hypot(r[0]!, r[1]!, r[2]!) < 1e-9 ? [1, 0, 0] : normv(r);
  const u = crossv(r, f);
  const hl = Math.hypot(f[0]!, f[2]!) || 1, hx = f[0]! / hl, hz = f[2]! / hl;
  const pp = levelPitchDeg * Math.PI / 180; // Minecraft pitch: + looks down
  const f2 = [Math.cos(pp) * hx, -Math.sin(pp), Math.cos(pp) * hz];
  const u2 = [Math.sin(pp) * hx, Math.cos(pp), Math.sin(pp) * hz];
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of targets) {
    const d = subv(t, cam);
    let dir: number[];
    if (model === 'camera') dir = normv(d);
    else {
      const z = dotv(d, f);
      if (z <= 1e-6) continue;
      const tx = dotv(d, r) / z, ty = dotv(d, u) / z;
      dir = normv([f2[0]! + tx * r[0]! + ty * u2[0]!, f2[1]! + tx * r[1]! + ty * u2[1]!, f2[2]! + tx * r[2]! + ty * u2[2]!]);
    }
    for (let k = 0; k < 3; k++) {
      const p = origin[k]! + dir[k]! * reach;
      lo[k] = Math.min(lo[k]!, p); hi[k] = Math.max(hi[k]!, p);
    }
  }
  return { centre: [0, 1, 2].map(k => (lo[k]! + hi[k]!) / 2), lo, hi };
}

/** A 5 x 5 grid over a plane rectangle at height `h`, mapped by `toPoint`. */
function rectSamples(rect: [number, number, number, number], h: number, toPoint: (u: number, w: number, h: number) => number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
    out.push(toPoint(rect[0] + (rect[1] - rect[0]) * i / 4, rect[2] + (rect[3] - rect[2]) * j / 4, h));
  }
  return out;
}

/** Tap-target reach: close enough for any phone tap, far enough that the box is not inside the head. */
export const PINBALL_TAP_REACH = 1.2;

/**
 * The tap targets: over each flipper, the playfield from its hinge's outer
 * edge to just short of the table's centre line and from above the raised
 * tip to below the resting one; over the plunger, the bottom of the lane
 * where the ball waits and the plunger's tip. Sized from the planned eye
 * (angles do not change with the placement's size; the reach is fixed in
 * blocks, so neither do the boxes).
 */
export function planPinballZones(table: PinballTable, map: PinballMap, eye: Vec3, look: Vec3, hasPlunger: boolean): PinballZonePlan {
  const R = table.ballRadius;
  const [lf, rf] = [table.flippers.find(f => f.side === 'left')!, table.flippers.find(f => f.side === 'right')!];
  const centreW = (lf.pivot[1] + rf.pivot[1]) / 2;
  const h = table.floorH + R * 0.5;
  const gap = R * 0.25;
  const uSpan = (f: typeof lf): [number, number] => [f.pivot[0] - R * 2.2, f.pivot[0] + R * 1.6];
  const specs: PinballZoneSpec[] = [
    { role: 'left', rect: [...uSpan(lf), lf.pivot[1] - lf.pivotRadius - R * 0.8, centreW - gap], h },
    { role: 'right', rect: [...uSpan(rf), centreW + gap, rf.pivot[1] + rf.pivotRadius + R * 0.8], h },
  ];
  if (hasPlunger) {
    const [lu, lw] = table.launch.at;
    specs.push({ role: 'plunger', rect: [lu - R * 1.5, lu + R * 4, lw - R * 1.2, lw + R * 1.2], h });
  }
  const toModel = (u: number, w: number, hh: number): number[] => [0, 1, 2].map(k => map.p0[k]! + u * map.u[k]! + w * map.w[k]! + hh * map.n[k]!);
  const fits = specs.map(s => ({ role: s.role, ...fitPinballZone(eye, eye, look, rectSamples(s.rect, s.h, toModel), PINBALL_TAP_REACH, 'camera', 0) }));
  // A box is square across (one width for X and Z) - it has to cover the
  // larger of the two horizontal extents - and is padded a little so a tap on
  // the very edge of the covered area still lands.
  const PAD = 0.03;
  const box = (fs: typeof fits): { width: number; height: number } => ({
    width: Math.round((Math.max(...fs.map(f => Math.max(f.hi[0]! - f.lo[0]!, f.hi[2]! - f.lo[2]!))) + 2 * PAD) * 100) / 100,
    height: Math.round((Math.max(...fs.map(f => f.hi[1]! - f.lo[1]!)) + 2 * PAD) * 100) / 100,
  });
  const flipperFits = fits.filter(f => f.role !== 'plunger');
  const plungerFits = fits.filter(f => f.role === 'plunger');
  const flipperBox = box(flipperFits);
  const plungerBox = plungerFits.length ? box(plungerFits) : { width: 0.2, height: 0.2 };
  // Neighbouring targets must not overlap, or a tap between them picks
  // whichever is nearer the head. The flipper targets sit side by side across
  // the table, so their shared width is capped at the distance between their
  // centres; the plunger target then gets whatever room is left beside the
  // right flipper's, along the axis that leaves it the most (measured on
  // 11374: the square boxes overlapped 0.04 and 0.05 blocks before this).
  const GAP = 0.01;
  const sep = (a: { centre: number[] }, b: { centre: number[] }): number => Math.max(Math.abs(a.centre[0]! - b.centre[0]!), Math.abs(a.centre[2]! - b.centre[2]!));
  const [lFit, rFit] = [flipperFits.find(f => f.role === 'left'), flipperFits.find(f => f.role === 'right')];
  if (lFit && rFit) flipperBox.width = Math.min(flipperBox.width, Math.floor((sep(lFit, rFit) - GAP) * 100) / 100);
  for (const p of plungerFits) for (const f of flipperFits) {
    const room = 2 * sep(p, f) - flipperBox.width - GAP;
    if (room < plungerBox.width) plungerBox.width = Math.max(0.05, Math.floor(room * 100) / 100);
  }
  return { reach: PINBALL_TAP_REACH, specs, flipperBox, plungerBox, fits };
}

/**
 * Turn a detected table into what the add-on ships. `toModel` is the scene's
 * LDU -> model-block map (`sceneGridPoint` on the export frame).
 */
export function planPinball(
  bricks: readonly ParsedBrick[],
  table: PinballTable,
  meshes: ReadonlyMap<string, LdrawPartMesh | null>,
  toModel: (ldu: Vec3) => Vec3,
): PinballPlan {
  const { axisU: U, axisW: W, axisN: N } = table;
  const warnings = [...table.warnings];
  const ldu = (u: number, w: number, h: number): Vec3 => add(scale(U, u), scale(W, w), scale(N, h));
  const p0 = toModel([0, 0, 0]);
  const map: PinballMap = { p0, u: sub(toModel(U), p0), w: sub(toModel(W), p0), n: sub(toModel(N), p0) };
  const sim = pinballSimTable(table);
  const ballH = table.floorH + table.ballRadius;

  const moved = new Set<ParsedBrick>();
  const flippers: PinballFlipperPlan[] = table.flippers.map(f => {
    const fb = f.bricks.map(i => bricks[i]!);
    for (const b of fb) moved.add(b);
    return { side: f.side, bricks: fb, rig: flipperRig(fb.length, ldu(f.pivot[0], f.pivot[1], table.floorH), N), restAngle: f.restAngle };
  });
  for (const i of table.ballBricks) moved.add(bricks[i]!);
  for (const i of table.looseBricks) moved.add(bricks[i]!);
  let plunger: PinballPlungerPlan | null = null;
  if (table.plungerBricks.length) {
    const pb = table.plungerBricks.map(i => bricks[i]!);
    for (const b of pb) moved.add(b);
    plunger = { bricks: pb, rig: moveRig(pb.length, ldu(table.launch.at[0], table.launch.at[1], table.floorH)), strokeLdu: table.plungerStroke };
  } else warnings.push('no plunger parts were found behind the serve; the ball is launched without a moving plunger');

  // The runtime's ball: the set's own ball part (19 mm Technic ball on 11374),
  // or a plain 2 x 2 round brick-sized stand-in when the set has none.
  const source = table.ballBricks.length ? bricks[table.ballBricks[0]!]! : undefined;
  const part = source?.part ?? '52629.dat';
  const mesh = meshes.get(source?.part ?? '') ?? null;
  const centreLocal: Vec3 = mesh ? scale(add(mesh.bounds.min, mesh.bounds.max), 0.5) : [0, -table.ballRadius, 0];
  const serveCentre = ldu(sim.launch[0], sim.launch[1], ballH);
  const ballBrick: ParsedBrick = {
    color: source?.color ?? 71, part, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    x: serveCentre[0] - centreLocal[0], y: serveCentre[1] - centreLocal[1], z: serveCentre[2] - centreLocal[2],
  };
  if (!source) warnings.push('the set has no ball part; a 52629 Technic ball stands in');

  // Console in front of the table, on the ground; camera behind and above the
  // player's end, looking up the table.
  const { grid } = table;
  const front = grid.u0 + grid.rows * grid.cell;
  const centreW = grid.w0 + grid.cols * grid.cell / 2;
  const length = grid.rows * grid.cell;
  const consoleLdu = ldu(front + 60, centreW, table.floorH);
  const consoleModel = toModel(consoleLdu);
  consoleModel[1] = 0; // on the pin plane, beside the machine
  // The seated player's EYE: the runtime lifts the seat so the rider's head is
  // here and puts the camera on it, so the picture and the player's own tap
  // ray start at the same point. 0.1 L out and 0.8 L up keeps the whole
  // playfield in a 60 degree vertical view with the table filling it (the
  // user asked for "slightly closer" than 0.15 / 1.1 on 2026-09-24).
  const cameraEyeModel = toModel(add(ldu(front + length * 0.1, centreW, table.floorH), scale([0, -1, 0], length * 0.8)));
  const cameraLookModel = toModel(ldu(grid.u0 + length * 0.5, centreW, table.floorH));
  // The seat faces up the table (-U) in the world.
  const upTable = sub(toModel(ldu(front - 100, centreW, table.floorH)), toModel(ldu(front, centreW, table.floorH)));
  const consoleYaw = Math.round(Math.atan2(-upTable[0], upTable[2]) * 180 / Math.PI);
  const zones = planPinballZones(table, map, cameraEyeModel, cameraLookModel, !!plunger);

  return {
    table, sim, map, ballH, flippers, plunger, ballBrick, ballRig: moveRig(1, serveCentre), ballCentreModel: toModel(serveCentre),
    consoleModel, consoleYaw, cameraEyeModel, cameraLookModel, zones, moved, warnings,
  };
}

// ─── Behaviours, animation, console ─────────────────────────────────────────

/** A moving prop: no gravity, no collision, cannot be hurt, keeps its place across reloads. */
export function pinballPropBehavior(typeId: string, collision: { width: number; height: number }, properties?: Record<string, unknown>): unknown {
  return withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
    description: { identifier: typeId, is_spawnable: false, is_summonable: true, ...(properties ? { properties } : {}) },
    components: {
      'minecraft:type_family': { family: [PINBALL_FAMILY] },
      'minecraft:persistent': {}, 'minecraft:nameable': {},
      'minecraft:health': { value: 20, max: 20 },
      'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
      'minecraft:fire_immune': {},
      'minecraft:collision_box': collision,
      'minecraft:physics': { has_gravity: false, has_collision: false },
      // NOT `minecraft:pushable`: format 1.26.30 dropped it and the WHOLE entity
      // then fails to load (device 2026-09-24: flippers, ball and tap zones were
      // "not a valid entity type", so nothing on the table ever moved).
      'minecraft:pushable_by_block': {},
    },
  } }, collision);
}

/** The flipper's swing property (float: Bedrock drops an integer-literal default). */
export function flipperProperties(): Record<string, unknown> {
  return { [PROP_FLIP]: floatActorProperty([-180, 180], 0) };
}

/**
 * The spin animation. The geometry writer negates X and Y rotations into
 * Bedrock's convention (ldraw-entity-compiler `jsonBone`), so the animation
 * does the same: a positive property is a right-handed turn about the render
 * frame's playfield normal.
 */
export function flipperAnimation(typeId: string): { id: string; file: unknown } {
  const id = `animation.${typeId.replace(':', '.')}.flip`;
  return { id, file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones: { [SPIN_BONE]: { rotation: [0, `-query.property('${PROP_FLIP}')`, 0] } } } } } };
}

/** Axis-sign properties shared by every translated part (set once by the runtime). */
const signProperties = (): Record<string, unknown> => ({ [PROP_SX]: floatActorProperty([-1, 1], -1), [PROP_SZ]: floatActorProperty([-1, 1], 1) });

/** The ball's properties: plane offset and velocity from the serve point, and the update counter. */
export function ballProperties(): Record<string, unknown> {
  return {
    [PROP_BALL_U]: floatActorProperty([-4000, 4000], 0), [PROP_BALL_W]: floatActorProperty([-4000, 4000], 0),
    [PROP_BALL_VU]: floatActorProperty([-4000, 4000], 0), [PROP_BALL_VW]: floatActorProperty([-4000, 4000], 0),
    [PROP_BALL_SEQ]: floatActorProperty([0, 1000], 0), ...signProperties(),
  };
}

/** The plunger's properties: its pull-back and the axis signs. */
export function plungerProperties(): Record<string, unknown> {
  return { [PROP_PULL]: floatActorProperty([0, 1], 0), ...signProperties() };
}

/**
 * Client-side extrapolation clock: `v.dt` is the time since the ball's
 * properties last changed (the server bumps `seq` whenever it writes them),
 * capped at two ticks so a stalled server never flings the ball.
 */
export const BALL_PRE_ANIMATION = [
  `v.seq_now = q.property('${PROP_BALL_SEQ}');`,
  'v.t0 = (v.seq_now != v.seq_last) ? q.life_time : v.t0;',
  'v.seq_last = v.seq_now;',
  'v.dt = math.clamp(q.life_time - v.t0, 0, 0.1);',
];

/** A number for a Molang expression: plain, never exponent notation. */
const molangNumber = (v: number): string => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));

/**
 * A bone translation in model PIXELS from a plane offset (du, dw in LDU;
 * Molang expressions): `16 * (du * map.u + dw * map.w)` per axis, with X and Z
 * multiplied by the entity's own sign properties. The geometry JSON mirrors X
 * (ldraw-entity-compiler), and whether a bone's animated POSITION follows the
 * same convention is decided on the device: the runtime writes the signs
 * (`axisSigns`, tunable live), so a wrong guess costs a `/scriptevent`, not a
 * rebuild.
 */
function planeTranslation(map: PinballMap, du: string, dw: string): string[] {
  return [0, 1, 2].map(k => {
    const a = molangNumber(16 * map.u[k]!), b = molangNumber(16 * map.w[k]!);
    const expr = `(${a} * (${du}) + ${b} * (${dw}))`;
    return k === 0 ? `q.property('${PROP_SX}') * ${expr}` : k === 2 ? `q.property('${PROP_SZ}') * ${expr}` : expr;
  });
}

/** The ball's move animation: its plane offset plus velocity times the time since the last update. */
export function ballAnimation(typeId: string, map: PinballMap): { id: string; file: unknown } {
  const id = `animation.${typeId.replace(':', '.')}.move`;
  const du = `q.property('${PROP_BALL_U}') + q.property('${PROP_BALL_VU}') * v.dt`;
  const dw = `q.property('${PROP_BALL_W}') + q.property('${PROP_BALL_VW}') * v.dt`;
  return { id, file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones: { [MOVE_BONE]: { position: planeTranslation(map, du, dw) } } } } } };
}

/** The plunger's pull animation: back along +u (toward the player) by `pull` x the stroke. */
export function plungerAnimation(typeId: string, map: PinballMap, strokeLdu: number): { id: string; file: unknown } {
  const id = `animation.${typeId.replace(':', '.')}.pull`;
  return { id, file: { format_version: '1.8.0', animations: { [id]: { loop: true, bones: { [MOVE_BONE]: { position: planeTranslation(map, `q.property('${PROP_PULL}') * ${molangNumber(strokeLdu)}`, '0') } } } } } };
}

/** The console seat: a rideable with no visible geometry. */
export function consoleAssets(typeId: string): { behavior: unknown; client: unknown; geometry: unknown } {
  const collision = { width: 1.2, height: 1.0 };
  // The rider's yaw is locked to the seat (0 degrees of freedom): the runtime
  // turns the seat to face up the table.
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: PINBALL_INTERACT_TEXT,
    crouching_skip_interact: true, seats: { position: [0, 0.2, 0], lock_rider_rotation: 0 } };
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  return {
    behavior: withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true },
      components: {
        'minecraft:type_family': { family: [PINBALL_FAMILY] },
        // The label ("... - Play pinball") floats above the pad at all times:
        // an unmarked seat in front of a 20-block machine is not findable
        // (device report 2026-09-24: "couldn't activate pinball controls").
        'minecraft:persistent': {}, 'minecraft:nameable': { always_show: true, allow_name_tag_renaming: false },
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': collision,
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:rideable': rideable,
      },
    } }, collision, rideable, { playerSized: true }),
    client: { format_version: '1.10.0', 'minecraft:client_entity': { description: {
      identifier: typeId, materials: { default: 'entity_alphatest' },
      textures: { default: 'textures/entity/craftmatic_pinball_console' }, geometry: { default: geometryId },
      render_controllers: ['controller.render.default'],
    } } },
    geometry: { format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: geometryId, texture_width: 2, texture_height: 2, visible_bounds_width: 2, visible_bounds_height: 2, visible_bounds_offset: [0, 0.5, 0] },
      // A visible pad (a flat yellow slab with a raised rim) marks the seat.
      bones: [{ name: 'root', pivot: [0, 0, 0], cubes: [
        { origin: [-8, 0, -8], size: [16, 1, 16], uv: [0, 0] },
        { origin: [-8, 1, -8], size: [16, 2, 1], uv: [0, 0] },
        { origin: [-8, 1, 7], size: [16, 2, 1], uv: [0, 0] },
      ] }],
    }] },
  };
}

export const PINBALL_BUTTON_FAMILY = 'craftmatic_pinball_button';
/**
 * The tap targets' texture, 32 x 32: an outline tile for the flipper targets
 * (0,0)-(16,16), one for the plunger target (0,16)-(16,32), and a fully
 * transparent tile (16,0)-(32,16) for every face but the top.
 */
export const PINBALL_ZONE_TEXTURE = 'craftmatic_pinball_zone';

/** RGBA of `PINBALL_ZONE_TEXTURE`: a faint frame with a fainter fill, white-cyan (flippers) and yellow (plunger). */
export function pinballZoneTexture(): { width: number; height: number; rgba: Uint8Array } {
  const W = 32, H = 32, px = new Uint8Array(W * H * 4);
  const tile = (x0: number, y0: number, rgb: [number, number, number]): void => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      // Corner brackets a little stronger, so the target reads as a frame.
      const corner = edge && (x < 4 || x > 11) && (y < 4 || y > 11);
      const k = ((y0 + y) * W + x0 + x) * 4;
      px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2];
      px[k + 3] = corner ? 200 : edge ? 130 : 26;
    }
  };
  tile(0, 0, [190, 240, 255]);
  tile(0, 16, [255, 214, 70]);
  // (16..32, 0..16) stays alpha 0.
  return { width: W, height: H, rgba: px };
}

/**
 * A TAP TARGET: a box the runtime spawns in front of a seated player's head,
 * on the line of sight to a flipper or the plunger. Bedrock gives a script no
 * touch position, but a tap on a touch screen hits the entity under the
 * finger (`entityHitEntity`, or `playerInteractWithEntity` for a long press).
 * The client only picks an entity it RENDERS (device runs 3-5, 2026-09-24:
 * a zone with no cubes was never hit), so the box is a real cube: its top face
 * carries the outline tile (seen from above, it frames the part on screen),
 * every other face the transparent one. The collision box is the pick box.
 * No size groups: it is sized to the player's reach, not the model.
 */
export function zoneAssets(typeId: string, box: { width: number; height: number }, role: 'flipper' | 'plunger'): { behavior: unknown; client: unknown; geometry: unknown } {
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  const w = box.width * 16, h = box.height * 16;
  const clear = { uv: [16, 0], uv_size: [16, 16] };
  const top = { uv: role === 'flipper' ? [0, 0] : [0, 16], uv_size: [16, 16] };
  return {
    behavior: { format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true },
      components: {
        'minecraft:type_family': { family: [PINBALL_BUTTON_FAMILY] },
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': { width: box.width, height: box.height },
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
      },
    } },
    client: { format_version: '1.10.0', 'minecraft:client_entity': { description: {
      identifier: typeId, materials: { default: 'entity_alphablend' },
      textures: { default: `textures/entity/${PINBALL_ZONE_TEXTURE}` }, geometry: { default: geometryId },
      render_controllers: ['controller.render.default'],
    } } },
    geometry: { format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: geometryId, texture_width: 32, texture_height: 32, visible_bounds_width: Math.max(1, box.width * 2), visible_bounds_height: Math.max(1, box.height * 2), visible_bounds_offset: [0, box.height / 2, 0] },
      bones: [{ name: 'root', pivot: [0, 0, 0], cubes: [{
        origin: [-w / 2, 0, -w / 2], size: [w, h, w],
        uv: { north: clear, south: clear, east: clear, west: clear, down: clear, up: top },
      }] }],
    }] },
  };
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface PinballRuntimeConfig {
  family: string;
  consoleType: string;
  ballType: string;
  /** Flipper entity types, in `sim.flippers` order. */
  flipperTypes: string[];
  /** The plunger entity, when the set has one. */
  plungerType?: string | undefined;
  /** Tap-target entity types (flipper, plunger) the runtime spawns in front of a seated player's head, and their family. */
  buttonType: string;
  plungerButtonType?: string | undefined;
  buttonFamily: string;
  zones: { reach: number; specs: PinballZoneSpec[]; flipperBox: { width: number; height: number }; plungerBox: { width: number; height: number } };
  sim: PinballSimTable;
  map: PinballMap;
  ballH: number;
  /** Model-block vector from the ball's centre to its entity's position. */
  ballOffset: Vec3;
  /** Rest angle per flipper and the sign that turns a plane swing into the property (render handedness). */
  restAngles: number[];
  spinSign: number;
  /** Plunger stroke (LDU along +u), when there is a plunger. */
  plungerStroke: number;
  /** How the ball is drawn: `animate` (properties + client extrapolation) or `teleport` (per tick). */
  ballMode: 'animate' | 'teleport';
  /** Signs for model X and Z in a bone translation (`PROP_SX`/`PROP_SZ`); see `planeTranslation`. */
  axisSigns: [number, number];
  /** The seated player's eye and the point it looks at, model blocks. */
  cameraEye: Vec3;
  cameraLook: Vec3;
  /** Where the console pad was planned, model blocks, and its yaw: the fallback home when none was recorded. */
  consoleHome: Vec3;
  consoleYaw: number;
  label: string;
}

export function pinballRuntimeConfig(
  plan: PinballPlan,
  types: { console: string; ball: string; flippers: string[]; button: string; plunger?: string | undefined; plungerButton?: string | undefined },
  ballEntityModel: Vec3, spinSign: number, label: string,
): PinballRuntimeConfig {
  return {
    family: PINBALL_FAMILY, consoleType: types.console, ballType: types.ball, flipperTypes: types.flippers,
    plungerType: types.plunger, buttonType: types.button, plungerButtonType: types.plungerButton, buttonFamily: PINBALL_BUTTON_FAMILY,
    zones: { reach: plan.zones.reach, specs: plan.zones.specs, flipperBox: plan.zones.flipperBox, plungerBox: plan.zones.plungerBox },
    sim: plan.sim, map: plan.map, ballH: plan.ballH,
    ballOffset: sub(ballEntityModel, plan.ballCentreModel),
    restAngles: plan.flippers.map(f => f.restAngle), spinSign,
    plungerStroke: plan.plunger?.strokeLdu ?? 0,
    ballMode: 'animate', axisSigns: [-1, 1],
    cameraEye: plan.cameraEyeModel, cameraLook: plan.cameraLookModel,
    consoleHome: plan.consoleModel, consoleYaw: plan.consoleYaw, label,
  };
}

/** Dynamic-property prefix the placement writes on every pinball actor (bedrock-placement-pack.ts). */
export const PINBALL_KEY = 'craftmatic:pinball_';

/**
 * The per-tick game. Serialised with `.toString()`; `createSim` is
 * `createPinballSim` and `fitZone` is `fitPinballZone`, passed in the same way.
 *
 * Seating: the pad lifts its rider (a teleported vehicle keeps its rider, as
 * every coaster car does) until the rider's HEAD is at `cameraEye`, turned to
 * face up the table, and a free camera sits on that head. The picture and
 * the player's own pick ray then start from the same place, so a target on
 * the line of sight to a flipper is under the finger that taps the flipper.
 * Standing up puts the player back on the ground behind the pad (with a
 * moment of slow falling) and the pad home.
 *
 * Live tuning on a device, `/scriptevent craftmatic:pinball <json>`:
 *   {"fwd":0,"left":0,"up":0}  move every target (blocks, seated frame)
 *   {"reach":1.2}              target distance from the head
 *   {"pick":"camera"|"level","pitch":0}  pick-ray model (fitPinballZone)
 *   {"cam":0}                  camera distance ahead of the head
 *   {"ball":"animate"|"teleport"}, {"axes":[-1,1]}  ball / plunger drawing
 *   {"perf":1}                 log script time every 100 ticks (content log)
 *   {"cache":0}, {"fixed":1}   the old per-tick world scan / fixed 12 substeps, to measure against
 *   {"log":1}                  log every tap on a target
 *   {"probe":[[yawDeg,pitchDeg],...],"d":1.5}  spawn probe targets along
 *                              those view directions and log which is hit
 *   {}                         defaults
 * TODO: drop the probe and fold measured settings into the defaults once the
 * pick model is settled on the device.
 */
function pinballRuntime(config: PinballRuntimeConfig, createSim: typeof createPinballSim, fitZone: typeof fitPinballZone): void {
  const KEY = 'craftmatic:pinball_';
  /** A tap holds its flipper up this many ticks (0.3 s); repeated taps extend it. */
  const TAP_TICKS = 6;
  /** A plunger held this long is fully drawn (1.2 s). */
  const PULL_TICKS = 24;
  /** Plunger events closer than this are one held finger; a later one is a second tap (0.4 s). */
  const HOLD_GAP = 8;
  /** Head-to-eye tolerance when lifting the seat, blocks, and the most corrections tried. */
  const SEAT_TOLERANCE = 0.08, SEAT_TRIES = 8;
  /** Ticks between rescans of the world for pinball actors (cached in between). */
  const RESCAN = 20;
  const games = new Map<string, any>();
  /** Tap-target entity id -> the game it belongs to and what it works. */
  const zones = new Map<string, { key: string; role: string }>();
  let now = 0;
  const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const toWorld = (g: any, p: number[]): { x: number; y: number; z: number } => {
    const a = g.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: g.origin.x + (p[0]! * c - p[2]! * s) * g.scale, y: g.origin.y + p[1]! * g.scale, z: g.origin.z + (p[0]! * s + p[2]! * c) * g.scale };
  };
  const m = config.map;
  const planePoint = (u: number, w: number, h: number): number[] =>
    [m.p0[0]! + u * m.u[0]! + w * m.w[0]! + h * m.n[0]!, m.p0[1]! + u * m.u[1]! + w * m.w[1]! + h * m.n[1]!, m.p0[2]! + u * m.u[2]! + w * m.w[2]! + h * m.n[2]!];
  const sound = (dim: any, id: string, at: any, pitch = 1): void => { try { dim.playSound(id, at, { volume: 0.8, pitch }); } catch {} };
  const dist = (a: any, b: any): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const valid = (e: any): boolean => { try { return typeof e.isValid === 'function' ? e.isValid() : e.isValid !== false; } catch { return false; } };
  const launchU = config.sim.launch[0], launchW = config.sim.launch[1];

  /** The seated view in world space: eye, look point, horizontal forward/left and the facing yaw. */
  const viewOf = (g: any) => {
    const eye = toWorld(g, config.cameraEye), look = toWorld(g, config.cameraLook);
    const dx = look.x - eye.x, dz = look.z - eye.z, h = Math.hypot(dx, dz) || 1;
    const fwd = { x: dx / h, z: dz / h };
    // Facing +z (yaw 0), a player's left is +x.
    const left = { x: fwd.z, z: -fwd.x };
    return { eye, look, fwd, left, yaw: Math.atan2(-fwd.x, fwd.z) * 180 / Math.PI };
  };
  const wrapDeg = (d: number): number => ((d + 540) % 360) - 180;

  const DEFAULT_TUNE = { fwd: 0, left: 0, up: 0, reach: config.zones.reach, pick: 'camera' as 'camera' | 'level', pitch: 0, cam: 0, view: 'free' as 'first' | 'free', perf: false, log: false, cache: true, fixed: false };
  const tune: typeof DEFAULT_TUNE = { ...DEFAULT_TUNE };
  let ballMode: 'animate' | 'teleport' = config.ballMode;
  let axisSigns: number[] = [...config.axisSigns];
  let probe: { dirs: number[][]; d: number } | null = null;
  const num = (v: unknown, dflt: number): number => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : dflt);
  try {
    system.afterEvents.scriptEventReceive.subscribe((ev: any) => {
      if (ev.id !== 'craftmatic:pinball') return;
      let t: any = {};
      try { t = JSON.parse(ev.message || '{}'); } catch { return; }
      const reset = Object.keys(t).length === 0;
      if (reset) {
        if (tune.fixed) for (const game of games.values()) game.sim = createSim(config.sim);
        Object.assign(tune, DEFAULT_TUNE); ballMode = config.ballMode; axisSigns = [...config.axisSigns]; probe = null;
      }
      for (const k of ['fwd', 'left', 'up', 'reach', 'pitch', 'cam'] as const) if (k in t) tune[k] = num(t[k], DEFAULT_TUNE[k]);
      if ('pick' in t) tune.pick = t.pick === 'level' ? 'level' : 'camera';
      // A new view mode ("first" / "free") takes effect at the next seating.
      if ('view' in t) tune.view = t.view === 'first' ? 'first' : 'free';
      if ('perf' in t) tune.perf = !!t.perf;
      if ('log' in t) tune.log = !!t.log;
      // Measurement switches: {"cache":0} rescans the world every tick and
      // {"fixed":1} runs 12 substeps every tick, as the runtime did before
      // 2026-09-25 (a fresh game starts so the sim picks the setting up).
      if ('cache' in t) tune.cache = !!t.cache;
      if ('fixed' in t && !!t.fixed !== tune.fixed) { tune.fixed = !!t.fixed; for (const game of games.values()) game.sim = createSim(config.sim, { adaptiveSubsteps: !tune.fixed }); }
      if ('ball' in t) ballMode = t.ball === 'teleport' ? 'teleport' : 'animate';
      if (Array.isArray(t.axes) && t.axes.length === 2) axisSigns = [Math.sign(num(t.axes[0], -1)) || -1, Math.sign(num(t.axes[1], 1)) || 1];
      if ('probe' in t) probe = Array.isArray(t.probe) && t.probe.length ? { dirs: t.probe.map((p: any) => [num(p?.[0], 0), num(p?.[1], 0)]), d: num(t.d, 1.5) } : null;
      for (const game of games.values()) { game.retune = true; game.signsAt = -1; }
    });
  } catch {}

  /** Where each target's box stands (its entity position: bottom centre), from the head and the camera. */
  const zoneAt = (g: any, game: any, role: string): { x: number; y: number; z: number } => {
    const spec = config.zones.specs.find(s => s.role === role)!;
    const a = game.aim;
    const samples: number[][] = [];
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const p = toWorld(g, planePoint(spec.rect[0] + (spec.rect[1] - spec.rect[0]) * i / 4, spec.rect[2] + (spec.rect[3] - spec.rect[2]) * j / 4, spec.h));
      samples.push([p.x, p.y, p.z]);
    }
    const fit = fitZone([a.eye.x, a.eye.y, a.eye.z], [a.cam.x, a.cam.y, a.cam.z], [a.facing.x, a.facing.y, a.facing.z], samples, tune.reach, tune.pick, tune.pick === 'level' ? tune.pitch : 0);
    const box = role === 'plunger' ? config.zones.plungerBox : config.zones.flipperBox;
    return {
      x: fit.centre[0]! + a.fwd.x * tune.fwd + a.left.x * tune.left,
      y: fit.centre[1]! - box.height / 2 + tune.up,
      z: fit.centre[2]! + a.fwd.z * tune.fwd + a.left.z * tune.left,
    };
  };
  /** A probe target along a view direction (yaw offset from the seated heading, absolute pitch; + is down). */
  const probeAt = (game: any, yawOff: number, pitch: number, d: number): { x: number; y: number; z: number } => {
    const a = game.aim, yaw = (a.yaw + yawOff) * Math.PI / 180, p = pitch * Math.PI / 180;
    return { x: a.eye.x - Math.sin(yaw) * Math.cos(p) * d, y: a.eye.y - Math.sin(p) * d - config.zones.flipperBox.height / 2, z: a.eye.z + Math.cos(yaw) * Math.cos(p) * d };
  };

  // ── Input ──
  const press = (game: any, side: 'left' | 'right'): void => {
    game.tapUntil[side] = now + TAP_TICKS;
    game.taps[side]++;
    if (game.sim.state.phase === 'over') game.sim.reset();
  };
  /** A tap (or a repeated event from a held finger) on the plunger target. */
  const plungerTouch = (game: any): void => {
    const pl = game.plunger, st = game.sim.state;
    game.taps.plunger++;
    if (st.phase === 'over') { game.sim.reset(); return; }
    if (st.phase !== 'ready') return;
    if (pl.grabbed && now - pl.last < 2) { pl.last = now; return; } // the same tap reported twice
    if (!pl.grabbed) { pl.grabbed = true; pl.since = now; pl.last = now; pl.repeats = 0; }
    else if (now - pl.last <= HOLD_GAP) { pl.repeats++; pl.last = now; }
    else { pl.release = true; pl.last = now; }
  };
  const tap = (zone: any, player: any): void => {
    const z = zones.get(zone.id);
    if (!z) return;
    const game = games.get(z.key);
    if (!game || !game.rider || !player || game.rider.id !== player.id) return;
    if (tune.log || z.role.startsWith('probe')) {
      try { console.warn(`[pinball] tap ${z.role} at tick ${now}`); } catch {}
      game.lastTap = z.role;
    }
    if (z.role === 'left' || z.role === 'right') press(game, z.role);
    else if (z.role === 'plunger') plungerTouch(game);
  };
  /** The hotbar slot a seated player is parked on; a tap on a slot left / right of it is that flipper. */
  const PARK_SLOT = 4;
  /** Seated players carry this tag, so the Brick Wands do not open when a hotbar tap lands on theirs. */
  const SEATED_TAG = 'craftmatic_pinball';
  try { world.afterEvents.entityHitEntity.subscribe((ev: any) => { try { if (ev.hitEntity?.typeId === config.buttonType || ev.hitEntity?.typeId === config.plungerButtonType) tap(ev.hitEntity, ev.damagingEntity); } catch {} }); } catch {}
  try {
    world.beforeEvents.playerInteractWithEntity.subscribe((ev: any) => {
      try { if (ev.target?.typeId === config.buttonType || ev.target?.typeId === config.plungerButtonType) { ev.cancel = true; tap(ev.target, ev.player); } } catch {}
    });
  } catch {}

  const removeZones = (game: any): void => {
    for (const e of Object.values(game.zones ?? {}) as any[]) { if (e) { zones.delete(e.id); try { e.remove(); } catch {} } }
    game.zones = undefined;
    for (const e of game.probes ?? []) { zones.delete(e.id); try { e.remove(); } catch {} }
    game.probes = undefined;
  };
  const homeOf = (g: any, console_: any): { at: any; yaw: number } => {
    let at: any, yaw = NaN;
    try { at = console_.getDynamicProperty(KEY + 'home'); yaw = Number(console_.getDynamicProperty(KEY + 'home_yaw')); } catch {}
    if (at && [at.x, at.y, at.z, yaw].every(Number.isFinite)) return { at, yaw };
    // Never recorded (first sight already seated): the planned pad position.
    const p = toWorld(g, config.consoleHome);
    return { at: { x: p.x, y: g.origin.y + config.consoleHome[1]! * g.scale, z: p.z }, yaw: config.consoleYaw + g.rotation };
  };
  /** Set an actor property only when it changed (each write is a network update). */
  const setProp = (e: any, cache: Record<string, number>, k: string, v: number, eps = 1e-4): void => {
    if (cache[k] !== undefined && Math.abs(cache[k]! - v) < eps) return;
    cache[k] = v;
    try { e.setProperty(k, v); } catch {}
  };

  const tickGame = (key: string, g: any, dim: any): void => {
    const console_ = g.parts[config.consoleType];
    if (!console_) return;
    let game = games.get(key);
    if (!game) {
      game = {
        sim: createSim(config.sim, { adaptiveSubsteps: !tune.fixed }), rider: undefined as any, flip: config.flipperTypes.map(() => NaN),
        best: Number(console_.getDynamicProperty(KEY + 'best')) || 0, hud: 0, hint: 0,
        tapUntil: { left: -1, right: -1 }, taps: { left: 0, right: 0, plunger: 0 },
        plunger: { grabbed: false, since: 0, last: -99, repeats: 0, release: false, pull: 0, stick: 0 },
        seatTries: 0, seatAt: -99, seated: false, aim: undefined as any, aimError: NaN, zones: undefined as any, probes: undefined as any,
        props: { ball: {}, plunger: {} } as Record<string, Record<string, number>>, seq: 0, signsAt: -1, lastTap: '',
      };
      games.set(key, game);
    }
    let rider: any;
    try { rider = console_.getComponent('minecraft:rideable')?.getRiders?.()?.[0]; } catch {}
    if (rider && rider.typeId !== 'minecraft:player') rider = undefined;
    const view = viewOf(g);

    // The pad's home: recorded the first time it is seen empty (where the
    // placement put it, on the ground), so a lifted seat can always go back.
    if (!rider && !game.homeKnown) {
      let recorded: any;
      try { recorded = console_.getDynamicProperty(KEY + 'home'); } catch {}
      if (!recorded && !game.rider) {
        try {
          console_.setDynamicProperty(KEY + 'home', console_.location);
          console_.setDynamicProperty(KEY + 'home_yaw', console_.getRotation?.().y ?? config.consoleYaw + g.rotation);
        } catch {}
      }
      game.homeKnown = true;
    }

    // Boarding: lift the seat toward the eye, camera on it.
    if (rider && game.rider?.id !== rider.id) {
      game.seatTries = 0; game.seatAt = -99; game.seated = false; game.aim = undefined;
      game.tapUntil = { left: -1, right: -1 }; game.taps = { left: 0, right: 0, plunger: 0 };
      game.plunger = { grabbed: false, since: 0, last: -99, repeats: 0, release: false, pull: 0, stick: 0 };
      game.view = tune.view; game.firstPerson = false;
      if (game.view === 'free') {
        try { rider.camera.setCamera('minecraft:free', { location: { ...view.eye }, facingLocation: view.look, easeOptions: { easeTime: 0.6, easeType: 'InOutSine' } }); } catch {}
      }
      // Park the hotbar on the middle slot (the old one comes back on leaving).
      try { game.slot0 = rider.selectedSlotIndex; rider.selectedSlotIndex = PARK_SLOT; } catch {}
      try { rider.addTag(SEATED_TAG); } catch {}
      // The seated player is drawn by the free camera, and every tap swung
      // their arm across the lower right of the table (device run 7).
      try { rider.addEffect('invisibility', 20 * 60 * 60, { showParticles: false }); } catch {}
      if (game.sim.state.phase === 'over') game.sim.reset();
    }
    // Standing up: camera back, the player down on the ground behind the pad
    // (the seat was up at eye height), the targets gone, the pad home.
    if (!rider && game.rider) {
      const p = game.rider;
      const home = homeOf(g, console_);
      try { p.camera.clear(); } catch {}
      try { p.inputPermissions.setPermissionCategory(1, true); } catch {} // InputPermissionCategory.Camera
      try { if (Number.isInteger(game.slot0)) p.selectedSlotIndex = game.slot0; } catch {}
      try { p.removeTag(SEATED_TAG); } catch {}
      try { p.removeEffect('invisibility'); } catch {}
      try { p.onScreenDisplay.setActionBar(''); } catch {}
      try { p.addEffect('slow_falling', 60, { showParticles: false }); } catch {}
      try { p.teleport({ x: home.at.x - view.fwd.x * 1.6, y: home.at.y + 0.05, z: home.at.z - view.fwd.z * 1.6 }, { rotation: { x: 20, y: view.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      removeZones(game);
      try { console_.tryTeleport(home.at, { rotation: { x: 0, y: home.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      game.seated = false;
      game.plunger.grabbed = false; game.plunger.pull = 0; game.plunger.stick = 0;
    }
    game.rider = rider;

    if (rider) {
      // Close the loop on the rider's HEAD, not a guessed seat height: the
      // seat offset and the sitting pose are the engine's, not ours.
      // The seat's yaw is SET, never chased: chasing the rider's reported yaw
      // (which trails the seat by a tick) overshot every correction and the
      // seat - and a camera hung from the rider's yaw - orbited the machine
      // without end (device run 6, 1c6af4b2). The rider is turned instead.
      if (!game.seated && now - game.seatAt >= 2) {
        let head: any;
        try { head = rider.getHeadLocation(); } catch {}
        const err = head ? { x: view.eye.x - head.x, y: view.eye.y - head.y, z: view.eye.z - head.z } : undefined;
        if (err && Math.hypot(err.x, err.y, err.z) <= SEAT_TOLERANCE) game.seated = true;
        else if (game.seatTries >= SEAT_TRIES) game.seated = true; // as close as it gets; the aim below uses what it got
        else {
          const at = console_.location;
          // First try without a head reading: the pad plus a seated eye height.
          const to = err ? { x: at.x + err.x, y: at.y + err.y, z: at.z + err.z } : { x: view.eye.x, y: view.eye.y - 1.8, z: view.eye.z };
          try { console_.tryTeleport(to, { rotation: { x: 0, y: view.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
          game.seatTries++; game.seatAt = now;
        }
        if (game.seated) {
          // The targets and the camera hang from where the head really is,
          // along the PLANNED heading (fixed: nothing the rider does moves them).
          const eye = head ?? view.eye;
          const reach = Math.hypot(view.look.x - eye.x, view.look.z - eye.z);
          const cam = { x: eye.x + view.fwd.x * tune.cam, y: eye.y, z: eye.z + view.fwd.z * tune.cam };
          const facing = { x: eye.x + view.fwd.x * reach, y: view.look.y, z: eye.z + view.fwd.z * reach };
          game.aim = { eye, cam, facing, fwd: view.fwd, left: view.left, yaw: view.yaw };
          game.pitch = Math.atan2(eye.y - view.look.y, reach) * 180 / Math.PI; // Minecraft pitch: + is down
          // The rider faces the same way with head turning locked, so a tap's
          // pick ray (which starts at the head) has a fixed heading. The phone
          // applies setRotation's yaw (device run 5); its pitch did not take.
          try { rider.setRotation({ x: game.pitch, y: view.yaw }); } catch {}
          try { rider.inputPermissions.setPermissionCategory(1, false); } catch {} // InputPermissionCategory.Camera
          // FIRST PERSON is a tuning option only ({"view":"first"}): with the
          // pitch ignored the player looked at the horizon (device run 5).
          if (game.view === 'first') {
            try { rider.camera.clear(); } catch {}
            let r: any;
            try { r = rider.getRotation(); } catch {}
            game.firstPerson = !!r && Math.abs(Number(r.x) - game.pitch) <= 3 && Math.abs(wrapDeg(Number(r.y) - view.yaw)) <= 3;
          }
          if (!game.firstPerson) {
            try { rider.camera.setCamera('minecraft:free', { location: cam, facingLocation: facing }); } catch {}
          }
        }
      }
      if (game.seated) {
        // A rider whose heading drifted (4 of ~20 device seatings sat 90-130
        // degrees off) is turned back; the seat and camera stay put.
        let ry = NaN;
        try { ry = Number(rider.getRotation().y); } catch {}
        game.aimError = Number.isFinite(ry) ? Math.abs(wrapDeg(view.yaw - ry)) : NaN;
        if (game.aim && Number.isFinite(ry) && game.aimError > 5 && now % 5 === 0) {
          try { rider.setRotation({ x: game.pitch, y: game.aim.yaw }); } catch {}
        }
        // Hotbar taps: a slot left of the parked one is the left flipper, right of it the right.
        let slot = PARK_SLOT;
        try { slot = rider.selectedSlotIndex; } catch {}
        if (Number.isInteger(slot) && slot !== PARK_SLOT) {
          press(game, slot < PARK_SLOT ? 'left' : 'right');
          try { rider.selectedSlotIndex = PARK_SLOT; } catch {}
        }
        // The targets: spawned once seated, re-placed when retuned.
        const roles = config.zones.specs.map(s => s.role).filter(r => r !== 'plunger' || config.plungerButtonType);
        if (!game.zones) {
          game.zones = {};
          for (const role of roles) {
            try {
              const e = dim.spawnEntity(role === 'plunger' ? config.plungerButtonType : config.buttonType, zoneAt(g, game, role));
              game.zones[role] = e;
              zones.set(e.id, { key, role });
            } catch {}
          }
        } else if (now % 20 === 0 || game.retune) {
          for (const role of roles) {
            const e = game.zones[role];
            if (!e) continue;
            const want = zoneAt(g, game, role);
            try { if (dist(e.location, want) > 0.02) e.teleport(want, { keepVelocity: false, checkForBlocks: false }); } catch {}
          }
        }
        if (game.retune) {
          game.retune = false;
          for (const e of game.probes ?? []) { zones.delete(e.id); try { e.remove(); } catch {} }
          game.probes = undefined;
          if (probe) {
            game.probes = [];
            probe.dirs.forEach((d, i) => {
              try {
                const e = dim.spawnEntity(config.buttonType, probeAt(game, d[0]!, d[1]!, probe!.d));
                game.probes.push(e);
                zones.set(e.id, { key, role: `probe ${i} (yaw ${d[0]}, pitch ${d[1]})` });
              } catch {}
            });
          }
        }
      }
    } else if (now % 20 === 0) {
      // An empty pad away from home (the world closed with a player seated) goes back.
      const home = homeOf(g, console_);
      try { if (dist(console_.location, home.at) > 0.3) console_.tryTeleport(home.at, { rotation: { x: 0, y: home.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      if (game.zones || game.probes) removeZones(game);
    }
    // A player tagged seated who rides no pad (the world closed mid-game)
    // gets the tag, head turning and camera back.
    if (now % 40 === 0) {
      try {
        for (const pl of world.getPlayers({ tags: [SEATED_TAG] }).filter(Boolean)) {
          if ([...games.values()].some(gm => gm.rider?.id === pl.id)) continue;
          try { pl.removeTag(SEATED_TAG); } catch {}
          try { pl.removeEffect('invisibility'); } catch {}
          try { pl.inputPermissions.setPermissionCategory(1, true); } catch {}
          try { pl.camera.clear(); } catch {}
        }
      } catch {}
    }

    // ── Controls for this tick ──
    let left = false, right = false;
    const pl = game.plunger;
    let st = game.sim.state;
    if (rider) {
      left = game.tapUntil.left > now;
      right = game.tapUntil.right > now;
      let stickPull = 0;
      try {
        const mv = rider.inputInfo?.getMovementVector?.();
        const x = mv?.x ?? 0, y = mv?.y ?? 0;
        // x > 0 is a left strafe in Minecraft's convention; forward works both.
        if (x > 0.3 || y > 0.3) left = true;
        if (x < -0.3 || y > 0.3) right = true;
        // The stick pulled BACK draws the plunger as far as it is pulled.
        if (y < -0.1) stickPull = Math.min(1, (-y - 0.1) / 0.8);
      } catch {}
      if (st.phase === 'ready') {
        // The plunger moves toward where the stick holds it at most 0.1 of
        // its stroke a tick (half a second from rest to full), so the pull a
        // release fires with is where the plunger actually got to.
        pl.stick = stickPull > pl.stick ? Math.min(stickPull, pl.stick + 0.1) : stickPull > 0 ? stickPull : 0;
        if (pl.grabbed) {
          pl.pull = Math.min(1, (now - pl.since) / PULL_TICKS);
          // A held finger that stopped repeating has been lifted.
          if (pl.repeats > 0 && now - pl.last > HOLD_GAP) pl.release = true;
        }
        if (pl.release) { pl.grabbed = false; pl.release = false; pl.repeats = 0; pl.pull = 0; }
      } else { pl.grabbed = false; pl.release = false; pl.pull = 0; pl.stick = 0; }
    }
    const pullNow = Math.max(pl.grabbed ? pl.pull : 0, pl.stick);
    const events = game.sim.step({ left, right, launch: false, pull: pullNow }, 0.05);
    st = game.sim.state;
    const inPlay = st.phase === 'play';

    // ── Ball ──
    const ball = g.parts[config.ballType];
    if (ball) {
      // Waiting on the plunger, the ball follows the plunger's tip back.
      const du = st.u - launchU + (inPlay ? 0 : pullNow * config.plungerStroke), dw = st.w - launchW;
      const vu = inPlay ? st.vu : 0, vw = inPlay ? st.vw : 0;
      const bp = game.props.ball;
      if (game.signsAt !== g.stamp) {
        setProp(ball, bp, 'craftmatic:sx', axisSigns[0]!); setProp(ball, bp, 'craftmatic:sz', axisSigns[1]!);
        const plunger = config.plungerType ? g.parts[config.plungerType] : undefined;
        if (plunger) { setProp(plunger, game.props.plunger, 'craftmatic:sx', axisSigns[0]!); setProp(plunger, game.props.plunger, 'craftmatic:sz', axisSigns[1]!); }
        game.signsAt = g.stamp;
      }
      if (ballMode === 'animate') {
        // The entity stays on the serve point; the client draws the ball at
        // offset + velocity x time since this update.
        if (game.ballMode !== 'animate' || now % 20 === 0) {
          const c = planePoint(launchU, launchW, config.ballH);
          const home = toWorld(g, [c[0]! + config.ballOffset[0]!, c[1]! + config.ballOffset[1]!, c[2]! + config.ballOffset[2]!]);
          try { if (dist(ball.location, home) > 0.01) ball.teleport(home, { keepVelocity: false, checkForBlocks: false }); } catch {}
        }
        const changed = bp['craftmatic:bu'] === undefined || Math.abs(bp['craftmatic:bu']! - du) > 0.05 || Math.abs(bp['craftmatic:bw']! - dw) > 0.05
          || Math.abs(bp['craftmatic:bvu']! - vu) > 0.5 || Math.abs(bp['craftmatic:bvw']! - vw) > 0.5;
        if (changed) {
          setProp(ball, bp, 'craftmatic:bu', du, 0); setProp(ball, bp, 'craftmatic:bw', dw, 0);
          setProp(ball, bp, 'craftmatic:bvu', vu, 0); setProp(ball, bp, 'craftmatic:bvw', vw, 0);
          game.seq = (game.seq + 1) % 1000;
          setProp(ball, bp, 'craftmatic:seq', game.seq, 0);
        }
      } else {
        if (game.ballMode !== 'teleport') {
          for (const k of ['craftmatic:bu', 'craftmatic:bw', 'craftmatic:bvu', 'craftmatic:bvw']) setProp(ball, bp, k, 0, 0);
        }
        const c = planePoint(launchU + du, launchW + dw, config.ballH);
        const p = toWorld(g, [c[0]! + config.ballOffset[0]!, c[1]! + config.ballOffset[1]!, c[2]! + config.ballOffset[2]!]);
        if (!game.lastBall || dist(game.lastBall, p) > 0.001) {
          try { ball.teleport(p, { keepVelocity: false, checkForBlocks: false }); } catch {}
          game.lastBall = p;
        }
      }
      game.ballMode = ballMode;
    }
    // ── Plunger ──
    const plunger = config.plungerType ? g.parts[config.plungerType] : undefined;
    if (plunger) setProp(plunger, game.props.plunger, 'craftmatic:pull', inPlay ? 0 : pullNow, 0.005);
    // ── Flippers: the swing in degrees about the normal, only when it changed ──
    for (let i = 0; i < config.flipperTypes.length; i++) {
      const e = g.parts[config.flipperTypes[i]!];
      if (!e) continue;
      // The swing the short way round: a flipper whose rest angle sits near
      // +-180 degrees (11374's right one rests at 162.5) crosses the seam, and
      // the unwrapped difference read 324 -> clamped to a 180 degree half-turn
      // at the top of every swing (GameTest on the Pixel, 2026-09-24).
      let swing = config.restAngles[i]! - st.flipperAngles[i]!;
      while (swing > Math.PI) swing -= 2 * Math.PI;
      while (swing < -Math.PI) swing += 2 * Math.PI;
      const deg = swing * 180 / Math.PI * config.spinSign;
      if (Math.abs(deg - game.flip[i]) < 0.25) continue;
      game.flip[i] = deg;
      try { e.setProperty('craftmatic:flip', Math.max(-180, Math.min(180, deg))); } catch {}
    }

    // Sound and score.
    const at = console_.location;
    for (const ev of events) {
      if (ev.kind === 'bumper') sound(dim, 'note.pling', at, 1.2 + Math.random() * 0.4);
      else if (ev.kind === 'flipper') sound(dim, 'random.click', at, 1.4);
      else if (ev.kind === 'launch') sound(dim, 'random.bow', at, 1.2);
      else if (ev.kind === 'kickout') sound(dim, 'note.bell', at, 1.0);
      else if (ev.kind === 'drain') sound(dim, 'note.bass', at, 0.6);
      else if (ev.kind === 'over') {
        if (st.score > game.best) { game.best = st.score; try { console_.setDynamicProperty(KEY + 'best', game.best); } catch {} sound(dim, 'random.levelup', at, 1); }
      }
    }
    // A player standing near the pad but not seated gets told how to start.
    if (!rider && ++game.hint % 20 === 0) {
      try {
        const c = console_.location;
        for (const p of world.getPlayers().filter(Boolean)) {
          const l = p.location;
          if (p.dimension?.id && dim.id && p.dimension.id !== dim.id) continue;
          if (Math.hypot(l.x - c.x, l.z - c.z) < 5 * Math.max(1, g.scale) && Math.abs(l.y - c.y) < 4) {
            p.onScreenDisplay.setActionBar(`§e${config.label}§r - tap the yellow pad to play pinball`);
          }
        }
      } catch {}
    }
    if (rider && (++game.hud % 4 === 0 || events.length)) {
      // The held flippers show as << >> so a player (and a device check) can
      // see which input arrived.
      const held = `${left ? '§a<<§r' : '  '} ${right ? '§a>>§r' : '  '}`;
      const bar = (v: number): string => `§e${'|'.repeat(Math.round(v * 12))}§8${'|'.repeat(12 - Math.round(v * 12))}§r`;
      const note = tune.log || probe ? `  (taps ${game.taps.left}/${game.taps.right}/${game.taps.plunger}${game.lastTap ? `, last ${game.lastTap}` : ''})` : '';
      let line: string;
      if (st.phase === 'over') line = `§eGAME OVER§r  ${fmt(st.score)} points  (best ${fmt(game.best)})  - tap a flipper or the plunger for a new game${note}`;
      else if (st.phase === 'ready') {
        line = pullNow > 0
          ? `§bBall ${st.ball}/${st.balls}§r  plunger ${bar(pullNow)}  - ${pl.grabbed ? 'tap it again to let go' : 'let the stick go to fire'}${note}`
          : `§bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  - tap the yellow box on the plunger to pull it back, tap again to fire (or pull the stick back)${note}`;
      } else line = `${held} §bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  (best ${fmt(game.best)})  - tap the boxes on the flippers; sneak to leave${note}`;
      try { rider.onScreenDisplay.setActionBar(line); } catch {}
    }
  };

  // ── The world scan, cached: pinball actors are found every RESCAN ticks,
  // and between scans the same entity handles are reused (each scan reads
  // three dynamic properties per actor, which dominated an idle tick). ──
  const cache = new Map<string, { groups: Map<string, any>; at: number }>();
  let stamp = 0;
  const scan = (dimId: string, dim: any): Map<string, any> => {
    const groups = new Map<string, any>();
    let list: any[] = [];
    try { list = dim.getEntities({ families: [config.family] }); } catch { return groups; }
    for (const e of list) {
      let origin: any, rotation = NaN, scale = NaN;
      try { origin = e.getDynamicProperty(KEY + 'origin'); rotation = Number(e.getDynamicProperty(KEY + 'rotation')); scale = Number(e.getDynamicProperty(KEY + 'scale')); } catch { continue; }
      if (!origin || ![origin.x, origin.y, origin.z, rotation, scale].every(Number.isFinite) || scale <= 0) continue;
      const key = `${dimId}@${origin.x},${origin.y},${origin.z}/${rotation}/${scale}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { origin, rotation, scale, parts: {} as Record<string, any>, stamp: ++stamp });
      g.parts[e.typeId] = e;
    }
    return groups;
  };
  const perf = { busy: 0, busyMax: 0, gap: 0, gapMax: 0, n: 0, last: 0, scans: 0 };

  system.runInterval(() => {
    const t0 = Date.now();
    if (perf.last) { const gap = t0 - perf.last; perf.gap += gap; perf.gapMax = Math.max(perf.gapMax, gap); }
    perf.last = t0;
    now++;
    for (const dimId of ['overworld', 'nether', 'the_end']) {
      let dim: any;
      try { dim = world.getDimension(dimId); } catch { continue; }
      let c = cache.get(dimId);
      const stale = !c || !tune.cache || now - c.at >= RESCAN || [...c.groups.values()].some(g => Object.values(g.parts).some((e: any) => !valid(e)));
      if (stale) { c = { groups: scan(dimId, dim), at: now }; cache.set(dimId, c); perf.scans++; }
      const groups = c!.groups;
      for (const [key, g] of groups) {
        try { tickGame(key, g, dim); } catch (err: any) { console.warn(`[pinball] ${config.label}: ${err && err.message ? err.message : err}`); }
      }
      if (stale) {
        // A placement that was removed takes its game (and its targets) with it.
        for (const key of [...games.keys()]) if (key.startsWith(`${dimId}@`) && !groups.has(key)) { removeZones(games.get(key)); games.delete(key); }
      }
      // Targets no game owns (a reload drops the script's map) are removed.
      if (now % 40 === 0) {
        try { for (const e of dim.getEntities({ families: [config.buttonFamily] })) if (!zones.has(e.id)) e.remove(); } catch {}
      }
    }
    const busy = Date.now() - t0;
    perf.busy += busy; perf.busyMax = Math.max(perf.busyMax, busy); perf.n++;
    if (perf.n >= 100) {
      if (tune.perf) {
        try { console.warn(`[pinball-perf] ${config.label}: script ${(perf.busy / perf.n).toFixed(2)} ms/tick avg, ${perf.busyMax} max; tick gap ${(perf.gap / Math.max(1, perf.n - 1)).toFixed(1)} ms avg, ${perf.gapMax} max; ${perf.scans} scans; ball ${ballMode}`); } catch {}
      }
      perf.busy = 0; perf.busyMax = 0; perf.gap = 0; perf.gapMax = 0; perf.n = 0; perf.scans = 0;
    }
  }, 1);
}

/** The behaviour pack's `scripts/pinball.js`. */
export function pinballScript(config: PinballRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${pinballRuntime.toString()})(CONFIG, ${createPinballSim.toString()}, ${fitPinballZone.toString()});\n`;
}

/** Exported for the host-simulation test. */
export { pinballRuntime as _pinballRuntimeForTests };
