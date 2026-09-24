/**
 * A PLAYABLE PINBALL in a Bedrock add-on, built from a LEGO pinball machine's
 * own geometry (engine/pinball-table.ts) and simulated by the same code the
 * tests run (engine/pinball-physics.ts).
 *
 * WHAT SHIPS:
 *   - the machine as the usual brick shell, minus its flippers and its spare
 *     balls;
 *   - each FLIPPER as its own entity compiled from its exact parts, rigged
 *     with three bones at its pivot (tilt -> spin -> un-tilt) so a single
 *     float property swings it about the tilted playfield's normal;
 *   - the BALL as an entity compiled from the set's own ball part, teleported
 *     every tick to where the simulation puts it;
 *   - a CONSOLE: a yellow pad in front of the machine ("Play pinball"). Sitting
 *     on it lifts the player's head to a viewpoint just behind the table's
 *     front edge, with a free camera there looking down the table;
 *   - two TAP ZONES the runtime spawns left and right in front of the seated
 *     head: tapping the left / right half of the screen works that flipper,
 *     and a tap while a ball waits fires the plunger. The stick (left / right,
 *     forward = both, pull back = plunger) and Jump work too where a device
 *     reports them; sneak leaves.
 *
 * The runtime is serialised with `.toString()` like the coaster's, so it and
 * the simulation it is handed may not reference anything outside themselves.
 *
 * Device report 2026-09-24 (first playable build): the game started (the
 * action bar showed "Ball 1/3") but nothing moved. The stick and Jump were
 * the only inputs and no charge ever showed, so the seated phone reported
 * neither; hence the tap zones. NOT device-verified: that a tap on a touch
 * screen hits the zone under the finger while a free camera is set (the
 * camera is placed at the rider's head so either pick origin agrees), the
 * flipper spin sign in Bedrock's bone convention, and the framing.
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
const SPIN_BONE = 'pb_spin';

// ─── Plan ────────────────────────────────────────────────────────────────────

/** Plane (u, w, h) -> model blocks: `p0 + u*U + w*W + h*N`. */
export interface PinballMap { p0: Vec3; u: Vec3; w: Vec3; n: Vec3 }

export interface PinballFlipperPlan {
  side: 'left' | 'right';
  bricks: ParsedBrick[];
  rig: EntityRig;
  restAngle: number;
}

export interface PinballPlan {
  table: PinballTable;
  sim: PinballSimTable;
  map: PinballMap;
  /** Height along N of the ball's centre, LDU. */
  ballH: number;
  flippers: PinballFlipperPlan[];
  /** The ball the runtime moves: the set's own part, re-placed at the serve point with its centre on it. */
  ballBrick: ParsedBrick;
  /** Its centre in model blocks (where the sim's serve point lands). */
  ballCentreModel: Vec3;
  /** Console seat and camera, model blocks. */
  consoleModel: Vec3;
  consoleYaw: number;
  cameraEyeModel: Vec3;
  cameraLookModel: Vec3;
  /** Every brick that leaves the static shell: flippers and spare balls. */
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
  // here and puts the camera just in front of it, so the view and the
  // player's own tap ray agree (taps pick the flipper zones). A player
  // standing at a real machine looks down the table from just behind its
  // front edge. The walk preview measured 0.35 L out / 0.75 L up grazing
  // geometry near the look point; the first device build used 0.15 L out and
  // 1.1 L up, which the user found too far ("slightly closer", 2026-09-24):
  // 0.1 L out and 0.8 L up keeps the whole playfield in a 60 degree vertical
  // view (front edge 83 degrees down, back edge ~36) with the table filling it.
  // TODO: device-check the framing on the phone; tune these two factors.
  const cameraEyeModel = toModel(add(ldu(front + length * 0.1, centreW, table.floorH), scale([0, -1, 0], length * 0.8)));
  const cameraLookModel = toModel(ldu(grid.u0 + length * 0.5, centreW, table.floorH));
  // The seat faces up the table (-U) in the world.
  const upTable = sub(toModel(ldu(front - 100, centreW, table.floorH)), toModel(ldu(front, centreW, table.floorH)));
  const consoleYaw = Math.round(Math.atan2(-upTable[0], upTable[2]) * 180 / Math.PI);

  return {
    table, sim, map, ballH, flippers, ballBrick, ballCentreModel: toModel(serveCentre),
    consoleModel, consoleYaw, cameraEyeModel, cameraLookModel, moved, warnings,
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

/** The console seat: a rideable with no visible geometry. */
export function consoleAssets(typeId: string): { behavior: unknown; client: unknown; geometry: unknown } {
  const collision = { width: 1.2, height: 1.0 };
  // The rider's yaw is locked to the seat (0 degrees of freedom): the runtime
  // turns the seat to face up the table, and the tap zones left and right of
  // the rider's head only mean "left" and "right" while the head faces it.
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

/**
 * A TAP ZONE: an invisible, hittable box the runtime spawns left and right in
 * front of a seated player's head. Bedrock gives a script no touch position,
 * but a tap on a touch screen hits the entity under the finger, so a tap on
 * the left half of the screen hits the left zone (`entityHitEntity`, or
 * `playerInteractWithEntity` for a long press) and works the left flipper
 * (device report 2026-09-24: "right side of screen touch = right flipper and
 * left side = left"). A mouse click or a controller trigger works the same way
 * through the crosshair.
 *
 * The box is big and close: 1.9 blocks wide and deep, 6 tall, starting 0.45
 * blocks in front of the eye, so every ray inside a 115 x 60 degree phone view
 * enters one zone within reach whatever the rider's pitch. No size groups:
 * it is sized to the player, not the model, and the runtime places it.
 */
export const PINBALL_ZONE = { width: 1.9, height: 6, near: 0.45, below: 3.8 } as const;
export const PINBALL_BUTTON_FAMILY = 'craftmatic_pinball_button';

export function buttonAssets(typeId: string): { behavior: unknown; client: unknown; geometry: unknown } {
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  return {
    behavior: { format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true },
      components: {
        'minecraft:type_family': { family: [PINBALL_BUTTON_FAMILY] },
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': { width: PINBALL_ZONE.width, height: PINBALL_ZONE.height },
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
      },
    } },
    client: { format_version: '1.10.0', 'minecraft:client_entity': { description: {
      identifier: typeId, materials: { default: 'entity_alphatest' },
      textures: { default: 'textures/entity/craftmatic_pinball_console' }, geometry: { default: geometryId },
      render_controllers: ['controller.render.default'],
    } } },
    // No cubes: nothing to see, only the collision box to hit.
    geometry: { format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: geometryId, texture_width: 2, texture_height: 2, visible_bounds_width: 1, visible_bounds_height: 1, visible_bounds_offset: [0, 0.5, 0] },
      bones: [{ name: 'root', pivot: [0, 0, 0] }],
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
  /** The tap-zone entity the runtime spawns beside a seated player's head, and its family. */
  buttonType: string;
  buttonFamily: string;
  zone: { width: number; height: number; near: number; below: number };
  sim: PinballSimTable;
  map: PinballMap;
  ballH: number;
  /** Model-block vector from the ball's centre to its entity's position. */
  ballOffset: Vec3;
  /** Rest angle per flipper and the sign that turns a plane swing into the property (render handedness). */
  restAngles: number[];
  spinSign: number;
  /** The seated player's eye and the point it looks at, model blocks. */
  cameraEye: Vec3;
  cameraLook: Vec3;
  /** Where the console pad was planned, model blocks, and its yaw: the fallback home when none was recorded. */
  consoleHome: Vec3;
  consoleYaw: number;
  label: string;
}

export function pinballRuntimeConfig(plan: PinballPlan, types: { console: string; ball: string; flippers: string[]; button: string }, ballEntityModel: Vec3, spinSign: number, label: string): PinballRuntimeConfig {
  return {
    family: PINBALL_FAMILY, consoleType: types.console, ballType: types.ball, flipperTypes: types.flippers,
    buttonType: types.button, buttonFamily: PINBALL_BUTTON_FAMILY, zone: { ...PINBALL_ZONE },
    sim: plan.sim, map: plan.map, ballH: plan.ballH,
    ballOffset: sub(ballEntityModel, plan.ballCentreModel),
    restAngles: plan.flippers.map(f => f.restAngle), spinSign,
    cameraEye: plan.cameraEyeModel, cameraLook: plan.cameraLookModel,
    consoleHome: plan.consoleModel, consoleYaw: plan.consoleYaw, label,
  };
}

/** Dynamic-property prefix the placement writes on every pinball actor (bedrock-placement-pack.ts). */
export const PINBALL_KEY = 'craftmatic:pinball_';

/**
 * The per-tick game. Serialised with `.toString()`; `createSim` is
 * `createPinballSim`, passed in the same way.
 *
 * Seating: the pad lifts its rider (a teleported vehicle keeps its rider, as
 * every coaster car does) until the rider's HEAD is at `cameraEye`, turned to
 * face up the table, and a free camera sits just in front of that head. The
 * picture and the player's own pick ray then start from the same place, so
 * the two tap zones spawned left and right in front of the head split the
 * screen into a left and a right half. Standing up puts the player back on
 * the ground behind the pad (with a moment of slow falling) and the pad home.
 *
 * Input, all at once: a tap (or long press) on a half of the screen raises
 * that flipper for 0.3 s and, while a ball waits on the launcher, charges and
 * fires the plunger; the stick and Jump still work where a device reports them.
 */
function pinballRuntime(config: PinballRuntimeConfig, createSim: typeof createPinballSim): void {
  const KEY = 'craftmatic:pinball_';
  /** A tap holds its flipper up this many ticks (0.3 s); repeated taps extend it. */
  const TAP_TICKS = 6;
  /** A tap on a waiting ball charges the plunger this long (0.8 s of a 1 s full charge), then fires. */
  const LAUNCH_TICKS = 16;
  /** Head-to-eye tolerance when lifting the seat, blocks, and the most corrections tried. */
  const SEAT_TOLERANCE = 0.08, SEAT_TRIES = 8;
  /** Rider-yaw tolerance when turning the seat, degrees. */
  const YAW_TOLERANCE = 1.5;
  const games = new Map<string, any>();
  /** Tap-zone entity id -> the game it belongs to and its side. */
  const zones = new Map<string, { key: string; side: 'left' | 'right' }>();
  let now = 0;
  const fmt = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const toWorld = (g: any, p: number[]): { x: number; y: number; z: number } => {
    const a = g.rotation * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: g.origin.x + (p[0]! * c - p[2]! * s) * g.scale, y: g.origin.y + p[1]! * g.scale, z: g.origin.z + (p[0]! * s + p[2]! * c) * g.scale };
  };
  const planePoint = (u: number, w: number, h: number): number[] => {
    const m = config.map;
    return [0, 1, 2].map(k => m.p0[k]! + u * m.u[k]! + w * m.w[k]! + h * m.n[k]!);
  };
  const sound = (dim: any, id: string, at: any, pitch = 1): void => { try { dim.playSound(id, at, { volume: 0.8, pitch }); } catch {} };
  const dist = (a: any, b: any): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  /** The seated view in world space: eye, look point, horizontal forward/left and the facing yaw. */
  const viewOf = (g: any) => {
    const eye = toWorld(g, config.cameraEye), look = toWorld(g, config.cameraLook);
    const dx = look.x - eye.x, dz = look.z - eye.z, h = Math.hypot(dx, dz) || 1;
    const fwd = { x: dx / h, z: dz / h };
    // Facing +z (yaw 0), a player's left is +x.
    const left = { x: fwd.z, z: -fwd.x };
    return { eye, look, fwd, left, yaw: Math.atan2(-fwd.x, fwd.z) * 180 / Math.PI };
  };
  /** Where a tap zone stands (its entity position: bottom centre), from the seated eye. */
  /**
   * The frame the tap zones and the camera hang from once seated: the rider's
   * MEASURED head and actual yaw, not the planned eye. A device run
   * (2026-09-24, 980f54fd) found the left/right split 20-28 degrees right of
   * the screen centre with the zones hung from the planned eye: the zones'
   * near faces are 0.15 blocks from the camera, so a head a few centimetres
   * off the plan, or a yaw a few degrees off, moves the split a long way.
   */
  const aimOf = (head: any, yawDeg: number, v: any) => {
    const a = yawDeg * Math.PI / 180;
    const fwd = { x: -Math.sin(a), z: Math.cos(a) };
    return { eye: head, look: v.look, fwd, left: { x: fwd.z, z: -fwd.x }, yaw: yawDeg };
  };
  const wrapDeg = (d: number): number => ((d + 540) % 360) - 180;
  /**
   * Device tuning, live: `/scriptevent craftmatic:pinball {"anchor":"eye","fwd":0,"side":0,"up":0,"near":0.45}`
   * moves the zones (relative to the measured `head` or the planned `eye`)
   * without a rebuild; `{}` restores the defaults. Where a phone's tap ray
   * starts is not documented, so the working placement is found on a device.
   * TODO: fold the measured placement into the defaults and drop the hook.
   */
  const tune: { anchor: 'head' | 'eye'; fwd: number; side: number; up: number; near: number; view: 'first' | 'free' } = { anchor: 'head', fwd: 0, side: 0, up: 0, near: config.zone.near, view: 'first' };
  try {
    system.afterEvents.scriptEventReceive.subscribe((ev: any) => {
      if (ev.id !== 'craftmatic:pinball') return;
      let t: any = {};
      try { t = JSON.parse(ev.message || '{}'); } catch { return; }
      tune.anchor = t.anchor === 'eye' ? 'eye' : 'head';
      for (const k of ['fwd', 'side', 'up'] as const) tune[k] = Number.isFinite(Number(t[k])) ? Number(t[k]) : 0;
      tune.near = Number.isFinite(Number(t.near)) ? Number(t.near) : config.zone.near;
      // A new view mode ("first" / "free") takes effect at the next seating.
      tune.view = t.view === 'free' ? 'free' : 'first';
      for (const game of games.values()) game.retune = true;
    });
  } catch {}
  const zoneAt = (v: any, side: 'left' | 'right') => {
    const z = config.zone, s = side === 'left' ? 1 : -1, ahead = tune.near + z.width / 2 + tune.fwd, across = z.width / 2 * s + tune.side;
    return { x: v.eye.x + v.fwd.x * ahead + v.left.x * across, y: v.eye.y - z.below + tune.up, z: v.eye.z + v.fwd.z * ahead + v.left.z * across };
  };
  /** The frame the zones hang from under the current tuning. */
  const zoneFrame = (game: any, view: any) => (tune.anchor === 'eye' || !game.aim ? view : game.aim);

  // A hit (tap / click) or a long press on a tap zone. `beforeEvents` runs
  // read-only: this only records script state.
  const press = (game: any, side: 'left' | 'right'): void => {
    game.tapUntil[side] = now + TAP_TICKS;
    game.taps[side]++;
    if (game.sim.state.phase !== 'play' && game.autoLaunch <= 0) game.autoLaunch = LAUNCH_TICKS;
  };
  const tap = (zone: any, player: any): void => {
    const z = zones.get(zone.id);
    if (!z) return;
    const game = games.get(z.key);
    if (!game || !game.rider || !player || game.rider.id !== player.id) return;
    press(game, z.side);
  };
  /** The hotbar slot a seated player is parked on; a tap on a slot left / right of it is that flipper. */
  const PARK_SLOT = 4;
  /** Seated players carry this tag, so the Brick Wands do not open when a hotbar tap lands on theirs. */
  const SEATED_TAG = 'craftmatic_pinball';
  try { world.afterEvents.entityHitEntity.subscribe((ev: any) => { try { if (ev.hitEntity?.typeId === config.buttonType) tap(ev.hitEntity, ev.damagingEntity); } catch {} }); } catch {}
  try {
    world.beforeEvents.playerInteractWithEntity.subscribe((ev: any) => {
      try { if (ev.target?.typeId === config.buttonType) { ev.cancel = true; tap(ev.target, ev.player); } } catch {}
    });
  } catch {}

  const removeZones = (game: any): void => {
    for (const side of ['left', 'right']) {
      const e = game.zones?.[side];
      if (e) { zones.delete(e.id); try { e.remove(); } catch {} }
    }
    game.zones = undefined;
  };
  const homeOf = (g: any, console_: any): { at: any; yaw: number } => {
    let at: any, yaw = NaN;
    try { at = console_.getDynamicProperty(KEY + 'home'); yaw = Number(console_.getDynamicProperty(KEY + 'home_yaw')); } catch {}
    if (at && [at.x, at.y, at.z, yaw].every(Number.isFinite)) return { at, yaw };
    // Never recorded (first sight already seated): the planned pad position.
    const p = toWorld(g, config.consoleHome);
    return { at: { x: p.x, y: g.origin.y + config.consoleHome[1]! * g.scale, z: p.z }, yaw: config.consoleYaw + g.rotation };
  };

  const tickGame = (key: string, g: any, dim: any): void => {
    const console_ = g.parts[config.consoleType];
    if (!console_) return;
    let game = games.get(key);
    if (!game) {
      game = {
        sim: createSim(config.sim), rider: undefined as any, flip: config.flipperTypes.map(() => NaN),
        best: Number(console_.getDynamicProperty(KEY + 'best')) || 0, hud: 0, hint: 0,
        tapUntil: { left: -1, right: -1 }, taps: { left: 0, right: 0 }, autoLaunch: 0,
        seatTries: 0, seatAt: -99, seated: false, seatYaw: 0, aim: undefined as any, aimError: NaN, zones: undefined as any,
      };
      games.set(key, game);
    }
    let rider: any;
    try { rider = console_.getComponent('minecraft:rideable')?.getRiders?.()?.[0]; } catch {}
    if (rider && rider.typeId !== 'minecraft:player') rider = undefined;
    const view = viewOf(g);

    // The pad's home: recorded the first time it is seen empty (where the
    // placement put it, on the ground), so a lifted seat can always go back.
    if (!rider) {
      let recorded: any;
      try { recorded = console_.getDynamicProperty(KEY + 'home'); } catch {}
      if (!recorded && !game.rider) {
        try {
          console_.setDynamicProperty(KEY + 'home', console_.location);
          console_.setDynamicProperty(KEY + 'home_yaw', console_.getRotation?.().y ?? config.consoleYaw + g.rotation);
        } catch {}
      }
    }

    // Boarding: lift the seat toward the eye, camera in front of it.
    if (rider && game.rider?.id !== rider.id) {
      game.seatTries = 0; game.seatAt = -99; game.seated = false; game.seatYaw = view.yaw; game.aim = undefined;
      game.tapUntil = { left: -1, right: -1 }; game.taps = { left: 0, right: 0 }; game.autoLaunch = 0;
      game.view = tune.view; game.firstPerson = false;
      if (game.view === 'free') {
        const cam = { x: view.eye.x + view.fwd.x * 0.3, y: view.eye.y, z: view.eye.z + view.fwd.z * 0.3 };
        try { rider.camera.setCamera('minecraft:free', { location: cam, facingLocation: view.look, easeOptions: { easeTime: 0.6, easeType: 'InOutSine' } }); } catch {}
      }
      // Park the hotbar on the middle slot (the old one comes back on leaving).
      try { game.slot0 = rider.selectedSlotIndex; rider.selectedSlotIndex = PARK_SLOT; } catch {}
      try { rider.addTag(SEATED_TAG); } catch {}
      if (game.sim.state.phase === 'over') game.sim.reset();
    }
    // Standing up: camera back, the player down on the ground behind the pad
    // (the seat was up at eye height), the zones gone, the pad home.
    if (!rider && game.rider) {
      const p = game.rider;
      const home = homeOf(g, console_);
      try { p.camera.clear(); } catch {}
      try { p.inputPermissions.setPermissionCategory(1, true); } catch {} // InputPermissionCategory.Camera
      try { if (Number.isInteger(game.slot0)) p.selectedSlotIndex = game.slot0; } catch {}
      try { p.removeTag(SEATED_TAG); } catch {}
      try { p.onScreenDisplay.setActionBar(''); } catch {}
      try { p.addEffect('slow_falling', 60, { showParticles: false }); } catch {}
      try { p.teleport({ x: home.at.x - view.fwd.x * 1.6, y: home.at.y + 0.05, z: home.at.z - view.fwd.z * 1.6 }, { rotation: { x: 20, y: view.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      removeZones(game);
      try { console_.tryTeleport(home.at, { rotation: { x: 0, y: home.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      game.seated = false;
    }
    game.rider = rider;

    if (rider) {
      // Close the loop on the rider's HEAD, not a guessed seat height: the
      // seat offset and the sitting pose are the engine's, not ours.
      // The yaw closes the same way: the seat turns until the rider FACES up the table.
      if (!game.seated && now - game.seatAt >= 2) {
        let head: any, ry = NaN;
        try { head = rider.getHeadLocation(); } catch {}
        try { ry = Number(rider.getRotation().y); } catch {}
        const err = head ? { x: view.eye.x - head.x, y: view.eye.y - head.y, z: view.eye.z - head.z } : undefined;
        const dyaw = Number.isFinite(ry) ? wrapDeg(view.yaw - ry) : 0;
        if (err && Math.hypot(err.x, err.y, err.z) <= SEAT_TOLERANCE && Math.abs(dyaw) <= YAW_TOLERANCE) game.seated = true;
        else if (game.seatTries >= SEAT_TRIES) game.seated = true; // as close as it gets; the aim below uses what it got
        else {
          const at = console_.location;
          game.seatYaw += dyaw;
          // First try without a head reading: the pad plus a seated eye height.
          const to = err ? { x: at.x + err.x, y: at.y + err.y, z: at.z + err.z } : { x: view.eye.x, y: view.eye.y - 1.8, z: view.eye.z };
          try { console_.tryTeleport(to, { rotation: { x: 0, y: game.seatYaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
          game.seatTries++; game.seatAt = now;
        }
        if (game.seated) {
          // Hang the camera from where the head really is and the way it really faces.
          game.aim = aimOf(head ?? view.eye, Number.isFinite(ry) ? ry : view.yaw, view);
          game.aimError = Number.isFinite(ry) ? Math.abs(wrapDeg(view.yaw - ry)) : NaN;
          const a = game.aim, reach = Math.hypot(view.look.x - a.eye.x, view.look.z - a.eye.z);
          game.pitch = Math.atan2(a.eye.y - view.look.y, reach) * 180 / Math.PI; // Minecraft pitch: + is down
          // FIRST PERSON (default): the player's own eyes, turned down the
          // table, with head turning locked. A tap then picks what is under
          // the finger, as it does a mob. Under a free camera it does not: a
          // device run (2026-09-24, bcd1e3c9) found taps only ever reached a
          // zone that ENCLOSED the head, whatever was under the finger.
          if (game.view === 'first') {
            try { rider.camera.clear(); } catch {}
            try { rider.setRotation({ x: game.pitch, y: a.yaw }); } catch {}
            let r: any;
            try { r = rider.getRotation(); } catch {}
            game.firstPerson = !!r && Math.abs(Number(r.x) - game.pitch) <= 3 && Math.abs(wrapDeg(Number(r.y) - a.yaw)) <= 3;
            if (game.firstPerson) { try { rider.inputPermissions.setPermissionCategory(1, false); } catch {} } // InputPermissionCategory.Camera
          }
          // A free camera when asked for, or when the player's head could not be turned.
          if (!game.firstPerson) {
            const cam = { x: a.eye.x + a.fwd.x * 0.3, y: a.eye.y, z: a.eye.z + a.fwd.z * 0.3 };
            const facing = { x: a.eye.x + a.fwd.x * reach, y: view.look.y, z: a.eye.z + a.fwd.z * reach };
            try { rider.camera.setCamera('minecraft:free', { location: cam, facingLocation: facing }); } catch {}
          }
        }
      }
      if (game.seated) {
        // A seat that lost its turn (4 of ~20 device seatings sat 90-130
        // degrees off, looking at the grass) seats again; a first-person head
        // that drifted is turned back.
        let ry = NaN;
        try { ry = Number(rider.getRotation().y); } catch {}
        if (Number.isFinite(ry) && game.aim && Math.abs(wrapDeg(game.aim.yaw - ry)) > 5) {
          if (game.firstPerson) { try { rider.setRotation({ x: game.pitch, y: game.aim.yaw }); } catch {} }
          else if (Math.abs(wrapDeg(view.yaw - ry)) > 5) { game.seated = false; game.seatTries = 0; game.seatYaw = view.yaw; }
        }
        // Hotbar taps: a slot left of the parked one is the left flipper, right of it the right.
        let slot = PARK_SLOT;
        try { slot = rider.selectedSlotIndex; } catch {}
        if (Number.isInteger(slot) && slot !== PARK_SLOT) {
          press(game, slot < PARK_SLOT ? 'left' : 'right');
          try { rider.selectedSlotIndex = PARK_SLOT; } catch {}
        }
      }
      // The two zones, spawned once the seat is up and kept in front of the eye.
      if (game.seated) {
        if (!game.zones) {
          game.zones = {};
          for (const side of ['left', 'right'] as const) {
            try {
              const e = dim.spawnEntity(config.buttonType, zoneAt(zoneFrame(game, view), side));
              game.zones[side] = e;
              zones.set(e.id, { key, side });
            } catch {}
          }
        } else if (now % 10 === 0 || game.retune) {
          game.retune = false;
          for (const side of ['left', 'right'] as const) {
            const e = game.zones[side];
            if (!e) continue;
            const want = zoneAt(zoneFrame(game, view), side);
            try { if (dist(e.location, want) > 0.05) e.teleport(want, { keepVelocity: false, checkForBlocks: false }); } catch {}
          }
        }
      }
    } else if (now % 20 === 0) {
      // An empty pad away from home (the world closed with a player seated) goes back.
      const home = homeOf(g, console_);
      try { if (dist(console_.location, home.at) > 0.3) console_.tryTeleport(home.at, { rotation: { x: 0, y: home.yaw }, keepVelocity: false, checkForBlocks: false }); } catch {}
      if (game.zones) removeZones(game);
    }
    // A player tagged seated who rides no pad (the world closed mid-game)
    // gets the tag, head turning and camera back.
    if (now % 40 === 0) {
      try {
        for (const pl of world.getPlayers({ tags: [SEATED_TAG] })) {
          if ([...games.values()].some(gm => gm.rider?.id === pl.id)) continue;
          try { pl.removeTag(SEATED_TAG); } catch {}
          try { pl.inputPermissions.setPermissionCategory(1, true); } catch {}
          try { pl.camera.clear(); } catch {}
        }
      } catch {}
    }

    let left = false, right = false, launch = false;
    if (rider) {
      left = game.tapUntil.left > now;
      right = game.tapUntil.right > now;
      if (game.autoLaunch > 0) { launch = true; game.autoLaunch--; }
      try {
        const m = rider.inputInfo?.getMovementVector?.();
        const x = m?.x ?? 0, y = m?.y ?? 0;
        // x > 0 is a left strafe in Minecraft's convention; forward works both.
        if (x > 0.3 || y > 0.3) left = true;
        if (x < -0.3 || y > 0.3) right = true;
        // The plunger by stick: pull BACK and release, like the real one.
        if (y < -0.4 || rider.isJumping || rider.inputInfo?.getButtonState?.('Jump') === 'Pressed') launch = true;
      } catch {}
    }
    const events = game.sim.step({ left, right, launch }, 0.05);
    const st = game.sim.state;

    // Ball.
    const ball = g.parts[config.ballType];
    if (ball) {
      const c = planePoint(st.u, st.w, config.ballH);
      const p = toWorld(g, [c[0]! + config.ballOffset[0]!, c[1]! + config.ballOffset[1]!, c[2]! + config.ballOffset[2]!]);
      try { ball.teleport(p, { keepVelocity: false, checkForBlocks: false }); } catch {}
    }
    // Flippers: the swing in degrees about the normal, only when it changed.
    config.flipperTypes.forEach((type, i) => {
      const e = g.parts[type];
      if (!e) return;
      const deg = (config.restAngles[i]! - st.flipperAngles[i]!) * 180 / Math.PI * config.spinSign;
      if (Math.abs(deg - game.flip[i]) < 0.25) return;
      game.flip[i] = deg;
      try { e.setProperty('craftmatic:flip', Math.max(-180, Math.min(180, deg))); } catch {}
    });

    // Sound and score.
    const at = ball ? ball.location : console_.location;
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
        for (const pl of world.getPlayers()) {
          const l = pl.location;
          if (pl.dimension?.id && dim.id && pl.dimension.id !== dim.id) continue;
          if (Math.hypot(l.x - c.x, l.z - c.z) < 5 * Math.max(1, g.scale) && Math.abs(l.y - c.y) < 4) {
            pl.onScreenDisplay.setActionBar(`§e${config.label}§r - tap the yellow pad to play pinball`);
          }
        }
      } catch {}
    }
    if (rider && (++game.hud % 4 === 0 || events.length)) {
      // The held flippers show as << >> so a player (and a device check) can
      // see which input arrived; the tap counts say whether taps reach the zones.
      const held = `${left ? '§a<<§r' : '  '} ${right ? '§a>>§r' : '  '}`;
      let line: string;
      if (st.phase === 'over') line = `§eGAME OVER§r  ${fmt(st.score)} points  (best ${fmt(game.best)})  - tap the screen for a new game`;
      else if (st.phase === 'ready') line = `§bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  - tap the screen to launch ${'|'.repeat(Math.round(st.charge * 10))}  (taps ${game.taps.left}/${game.taps.right}${Number.isFinite(game.aimError) ? `, aim ${game.aimError.toFixed(1)}` : ''}${game.aim ? `, head ${(['x', 'y', 'z'] as const).map(k => (game.aim.eye[k] - view.eye[k]).toFixed(2)).join(' ')}` : ''})`;
      else line = `${held} §bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  (best ${fmt(game.best)})  - tap the left / right half, or a hotbar slot left / right of the middle, for the flippers; sneak to leave`;
      try { rider.onScreenDisplay.setActionBar(line); } catch {}
    }
  };

  system.runInterval(() => {
    now++;
    for (const dimId of ['overworld', 'nether', 'the_end']) {
      let dim: any, list: any[] = [];
      try { dim = world.getDimension(dimId); list = dim.getEntities({ families: [config.family] }); } catch { continue; }
      const groups = new Map<string, any>();
      for (const e of list) {
        let origin: any, rotation = NaN, scale = NaN;
        try { origin = e.getDynamicProperty(KEY + 'origin'); rotation = Number(e.getDynamicProperty(KEY + 'rotation')); scale = Number(e.getDynamicProperty(KEY + 'scale')); } catch { continue; }
        if (!origin || ![origin.x, origin.y, origin.z, rotation, scale].every(Number.isFinite) || scale <= 0) continue;
        const key = `${dimId}@${origin.x},${origin.y},${origin.z}/${rotation}/${scale}`;
        let g = groups.get(key);
        if (!g) groups.set(key, g = { origin, rotation, scale, parts: {} as Record<string, any> });
        g.parts[e.typeId] = e;
      }
      for (const [key, g] of groups) {
        try { tickGame(key, g, dim); } catch (err: any) { console.warn(`[pinball] ${config.label}: ${err && err.message ? err.message : err}`); }
      }
      // A placement that was removed takes its game (and its zones) with it.
      for (const key of [...games.keys()]) if (key.startsWith(`${dimId}@`) && !groups.has(key)) { removeZones(games.get(key)); games.delete(key); }
      // Zones no game owns (a reload drops the script's map) are removed.
      if (now % 40 === 0) {
        try { for (const e of dim.getEntities({ families: [config.buttonFamily] })) if (!zones.has(e.id)) e.remove(); } catch {}
      }
    }
  }, 1);
}

/** The behaviour pack's `scripts/pinball.js`. */
export function pinballScript(config: PinballRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${pinballRuntime.toString()})(CONFIG, ${createPinballSim.toString()});\n`;
}

/** Exported for the host-simulation test. */
export { pinballRuntime as _pinballRuntimeForTests };
