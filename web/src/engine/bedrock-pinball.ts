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
 *   - a CONSOLE: an invisible seat in front of the machine ("Play pinball").
 *     The seated player's movement input works the flippers (left / right,
 *     forward = both), Jump charges and fires the plunger, sneak leaves. A free
 *     camera looks down the table while seated.
 *
 * The runtime is serialised with `.toString()` like the coaster's, so it and
 * the simulation it is handed may not reference anything outside themselves.
 *
 * NOT device-verified (2026-09-23): the sign of `getMovementVector().x`
 * (assumed positive = left, Minecraft's strafe convention; forward fires both
 * flippers so the game stays playable either way), the flipper spin sign in
 * Bedrock's bone convention, and the free camera's framing.
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
  // Steep enough to look down into the cabinet over its front wall: the walk
  // preview measured the first framing (0.35 L out, 0.75 L up) grazing
  // geometry near the look point. 0.15 L out and 1.1 L up clears it.
  // TODO: device-check the framing on the phone; tune these two factors.
  const cameraEyeModel = toModel(add(ldu(front + length * 0.15, centreW, table.floorH), scale([0, -1, 0], length * 1.1)));
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
      'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: false },
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
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: PINBALL_INTERACT_TEXT,
    crouching_skip_interact: true, seats: { position: [0, 0.2, 0], lock_rider_rotation: 181 } };
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

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface PinballRuntimeConfig {
  family: string;
  consoleType: string;
  ballType: string;
  /** Flipper entity types, in `sim.flippers` order. */
  flipperTypes: string[];
  sim: PinballSimTable;
  map: PinballMap;
  ballH: number;
  /** Model-block vector from the ball's centre to its entity's position. */
  ballOffset: Vec3;
  /** Rest angle per flipper and the sign that turns a plane swing into the property (render handedness). */
  restAngles: number[];
  spinSign: number;
  cameraEye: Vec3;
  cameraLook: Vec3;
  label: string;
}

export function pinballRuntimeConfig(plan: PinballPlan, types: { console: string; ball: string; flippers: string[] }, ballEntityModel: Vec3, spinSign: number, label: string): PinballRuntimeConfig {
  return {
    family: PINBALL_FAMILY, consoleType: types.console, ballType: types.ball, flipperTypes: types.flippers,
    sim: plan.sim, map: plan.map, ballH: plan.ballH,
    ballOffset: sub(ballEntityModel, plan.ballCentreModel),
    restAngles: plan.flippers.map(f => f.restAngle), spinSign,
    cameraEye: plan.cameraEyeModel, cameraLook: plan.cameraLookModel, label,
  };
}

/** Dynamic-property prefix the placement writes on every pinball actor (bedrock-placement-pack.ts). */
export const PINBALL_KEY = 'craftmatic:pinball_';

/**
 * The per-tick game. Serialised with `.toString()`; `createSim` is
 * `createPinballSim`, passed in the same way.
 */
function pinballRuntime(config: PinballRuntimeConfig, createSim: typeof createPinballSim): void {
  const KEY = 'craftmatic:pinball_';
  const games = new Map<string, any>();
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

  const tickGame = (key: string, g: any, dim: any): void => {
    const console_ = g.parts[config.consoleType];
    if (!console_) return;
    let game = games.get(key);
    if (!game) {
      game = { sim: createSim(config.sim), rider: undefined as any, flip: config.flipperTypes.map(() => NaN), best: Number(console_.getDynamicProperty(KEY + 'best')) || 0, hud: 0, hint: 0 };
      games.set(key, game);
    }
    let rider: any;
    try { rider = console_.getComponent('minecraft:rideable')?.getRiders?.()?.[0]; } catch {}
    if (rider && rider.typeId !== 'minecraft:player') rider = undefined;
    // Boarding and leaving: the camera looks down the table while seated.
    if (rider && game.rider?.id !== rider.id) {
      try { rider.camera.setCamera('minecraft:free', { location: toWorld(g, config.cameraEye), facingLocation: toWorld(g, config.cameraLook), easeOptions: { easeTime: 0.6, easeType: 'InOutSine' } }); } catch {}
      if (game.sim.state.phase === 'over') game.sim.reset();
    }
    if (!rider && game.rider) { try { game.rider.camera.clear(); } catch {} try { game.rider.onScreenDisplay.setActionBar(''); } catch {} }
    game.rider = rider;

    let left = false, right = false, launch = false;
    if (rider) {
      try {
        const m = rider.inputInfo?.getMovementVector?.();
        const x = m?.x ?? 0, y = m?.y ?? 0;
        // x > 0 is a left strafe in Minecraft's convention; forward works both.
        left = x > 0.3 || y > 0.3;
        right = x < -0.3 || y > 0.3;
        // The plunger: pull the stick BACK and release, like the real one. A
        // phone shows no Jump button while riding a seat that is not a
        // vehicle, so Jump alone could not launch on touch; it still works.
        launch = y < -0.4 || !!(rider.isJumping || rider.inputInfo?.getButtonState?.('Jump') === 'Pressed');
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
      let line: string;
      if (st.phase === 'over') line = `§eGAME OVER§r  ${fmt(st.score)} points  (best ${fmt(game.best)})  - pull back for a new game`;
      else if (st.phase === 'ready') line = `§bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  - pull back (or hold Jump) to charge, release to launch ${'|'.repeat(Math.round(st.charge * 10))}`;
      else line = `§bBall ${st.ball}/${st.balls}§r  ${fmt(st.score)}  (best ${fmt(game.best)})  - left/right flippers, forward both, sneak to leave`;
      try { rider.onScreenDisplay.setActionBar(line); } catch {}
    }
  };

  system.runInterval(() => {
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
      // A placement that was removed takes its game with it.
      for (const key of [...games.keys()]) if (key.startsWith(`${dimId}@`) && !groups.has(key)) games.delete(key);
    }
  }, 1);
}

/** The behaviour pack's `scripts/pinball.js`. */
export function pinballScript(config: PinballRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${pinballRuntime.toString()})(CONFIG, ${createPinballSim.toString()});\n`;
}

/** Exported for the host-simulation test. */
export { pinballRuntime as _pinballRuntimeForTests };
