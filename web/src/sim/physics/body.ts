/**
 * Minecraft's per-tick motion of a box among solids: the player, and any mob
 * the engine moves (a figure walking by impulses). This is the ONE integrator
 * of the project: the walk preview (`web/src/engine/addon-walk.ts`), the
 * doorway walks (`interactive-walk.ts`) and the headless simulator all run it.
 *
 * PHYSICS, matched to Minecraft's per-tick model (20 ticks/s; minecraft.wiki
 * "Entity" motion and "Jumping", docs/physics-architecture.md §3):
 *   - the player is a 0.6 x 1.8 axis-aligned box standing on its bottom centre;
 *   - gravity 0.08 blocks/tick² with the 0.98 vertical drag, so a jump at
 *     0.42 blocks/tick peaks at 1.2522 blocks: the 1.25-block jump;
 *   - horizontal: walk 4.317 blocks/s (sprint x1.3, sneak x0.3), ground
 *     friction 0.546 and air friction 0.91 with the 0.02/tick air control;
 *   - the auto-step of 9/16 block (0.5625): a horizontal move blocked by a
 *     rise up to it is retried stepped up, exactly when on the ground or
 *     landing this tick;
 *   - collision resolved per axis (y, then x, then z) against the solids the
 *     world reports; sneaking on the ground will not walk off a drop deeper
 *     than the step;
 *   - IN WATER (a world that reports `submersion`): the stick accelerates
 *     0.02 a tick, every axis keeps 0.8 of its speed a tick, gravity is a
 *     sixteenth (a body sinks at 0.5 blocks/s), Jump swims up 0.04 a tick once
 *     the water is deeper than 0.4, and a body pushing against a bank at the
 *     surface is lifted out (0.3) - Java Edition's `LivingEntity.travel` water
 *     branch, ASSUMED for Bedrock (quirk `liquid-motion`); a mob with
 *     `minecraft:behavior.float` swims up as Jump does, a `minecraft:buoyant`
 *     body floats half under (`BodyFluid`, ASSUMED: no pack ships one).
 *
 * WHAT IT COLLIDES WITH is the caller's: any `SolidQuery` (the walk preview's
 * collider grid, the simulator's voxel world). Solids are plain boxes that may
 * carry the caller's own payload (`S extends Box`), handed back in `contacts`.
 *
 * Pure: no DOM, no Bedrock API, no engine state.
 */

import type { Box } from '../core/vec.js';

export type { Box } from '../core/vec.js';

// ─── Constants (Minecraft's own; docs/physics-architecture.md §9) ────────────

/** Ticks per second. */
export const TICKS_PER_SECOND = 20;
/** Blocks per tick² and the per-tick vertical drag; a jump starts at `JUMP_VELOCITY` and peaks at `JUMP_PEAK`. */
export const GRAVITY = 0.08;
export const VERTICAL_DRAG = 0.98;
export const JUMP_VELOCITY = 0.42;
/** Terminal fall speed, blocks per tick (0.08 × 0.98 / 0.02). */
export const TERMINAL_VELOCITY = 3.92;
/** Walking speed, blocks per tick (4.317 blocks/s); sprint and sneak scale it. */
export const WALK_SPEED = 4.317 / TICKS_PER_SECOND;
export const SPRINT_FACTOR = 1.3;
export const SNEAK_FACTOR = 0.3;
/** Horizontal velocity kept per tick on the ground and in the air, and the in-air control. */
export const GROUND_FRICTION = 0.546;
export const AIR_FRICTION = 0.91;
export const AIR_ACCELERATION = 0.02;
/**
 * The auto-step, 9/16 block. The collider reach walk quantises the same rise
 * (`STEP16` = 9 in bedrock-collider-scale.ts, asserted equal in the tests), so
 * the walk preview's player and its reach BFS agree by construction.
 */
export const STEP_HEIGHT = 9 / 16;
/** The player's box: 0.6 wide (full extent), 1.8 tall. */
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
/** A standing player's eye above its feet (Minecraft: 1.62). */
export const PLAYER_EYE_HEIGHT = 1.62;
/**
 * Slow falling's gravity, blocks/tick², applied while falling (Minecraft's
 * slow falling effect). Measured consequence on the Pixel (2026-09-29,
 * `output/nimbus-pixel-0929/`): a float-down of 89 blocks took 11 s, against
 * ~2.4 s of plain gravity; 0.01 with the 0.98 drag gives a 9.8 blocks/s
 * terminal, 89 blocks in ~9.5 s plus the ramp.
 */
export const SLOW_FALL_GRAVITY = 0.01;
/** The jump's reach in blocks under this integrator (1.2522). */
export const JUMP_PEAK = ((): number => {
  let y = 0, v = JUMP_VELOCITY, peak = 0;
  for (let i = 0; i < 20; i++) { y += v; if (y > peak) peak = y; v = (v - GRAVITY) * VERTICAL_DRAG; }
  return peak;
})();
/** The collision epsilon (Minecraft's own 1e-7). */
const EPS = 1e-7;
/**
 * AUTO-JUMP (Bedrock's touch default; `autoJumpWanted`). Bedrock's code is closed; these are Java's
 * `LocalPlayer.updateAutoJump` (1.10+, the same feature: "jumps up one-block-higher areas when moving
 * forward", minecraft.wiki "Jumping"), assumed for Bedrock (quirk `auto-jump`) and checked against the Pixel's
 * auto-jump-only climb of 10261's lift hill (round 30k: stops at pin + 28.2 on three tries):
 *   - an obstacle is jumped when its top is more than `AUTO_JUMP_MIN_RISE` and at most `AUTO_JUMP_MAX_RISE`
 *     over the feet (Java's 0.5 and 1.2, no jump boost) - a taller one is never tried, though a pressed jump
 *     reaches `JUMP_PEAK` (1.2522);
 *   - it is found by two horizontal probes at `AUTO_JUMP_PROBE_HEIGHT` (0.51) over the feet, along the box's two
 *     sides, from the feet to `AUTO_JUMP_LOOKAHEAD` (0.7: the walk speed attribute 0.1 x 7) past this tick's move;
 *   - only moving forward: the move direction against the facing at or over `AUTO_JUMP_BACKWARD_DOT` (-0.15);
 *   - only with the two block cells over the head (the one holding the box's top and the next) free of collision;
 *   - on the ground, not sneaking, and the jump is made on the NEXT tick (Java's `autoJumpTime = 1`).
 */
export const AUTO_JUMP_MIN_RISE = 0.5;
export const AUTO_JUMP_MAX_RISE = 1.2;
export const AUTO_JUMP_PROBE_HEIGHT = 0.51;
export const AUTO_JUMP_LOOKAHEAD = 0.7;
export const AUTO_JUMP_BACKWARD_DOT = -0.15;
/**
 * WATER (quirk `liquid-motion`, ASSUMED: Java Edition's `LivingEntity.travel` water branch; Bedrock's code is closed).
 * Per tick in water: the stick adds `WATER_ACCELERATION`; every axis keeps `WATER_DRAG`; gravity is `WATER_GRAVITY`
 * (`GRAVITY` / 16, Java's `getFluidFallingAdjustedMovement`), so a body sinks at a terminal 0.025 blocks/tick
 * (0.5 blocks/s); Jump adds `WATER_SWIM_UP` once the water at the body is deeper than `FLOAT_JUMP_DEPTH` (Java's
 * fluid jump threshold; shallower, Jump is the ordinary jump from the ground); a horizontal collision with room
 * `WATER_EXIT_STEP` higher sets the rise to `WATER_EXIT_LIFT` (climbing out onto a bank).
 */
export const WATER_ACCELERATION = 0.02;
export const WATER_DRAG = 0.8;
export const WATER_GRAVITY = GRAVITY / 16;
export const WATER_SWIM_UP = 0.04;
export const FLOAT_JUMP_DEPTH = 0.4;
export const WATER_EXIT_STEP = 0.6;
export const WATER_EXIT_LIFT = 0.3;
/**
 * A `minecraft:buoyant` body (ASSUMED, quirk `buoyant-body`: Bedrock documents the component's `base_buoyancy`, not
 * its motion): it is pushed up `BUOYANT_SPRING` x buoyancy a tick per unit of its height under water beyond half,
 * and pulled down by the same while less than half under, so it rests half submerged at buoyancy 1.
 */
export const BUOYANT_SPRING = 0.1;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Where the solids come from: the boxes a box moving by `(dx, dy, dz)` could meet; and, for a world with liquids,
 * how much of a box's height is under a liquid surface (0..1; absent: a dry world, as the walk preview's collider
 * grid is).
 */
export interface SolidQuery<S extends Box = Box> {
  solidsNear(box: Box, dx: number, dy: number, dz: number): readonly S[];
  submersion?(box: Box): number;
}

/** A mob's response to water (`tickBody`): it swims up like a pressed Jump (`minecraft:behavior.float`), or floats (`minecraft:buoyant`'s `base_buoyancy`). */
export interface BodyFluid { floats?: boolean; buoyancy?: number }

/** A body's box size: full width (x and z) and height, blocks. */
export interface BodyDims { width: number; height: number }

/** The player's box. */
export const PLAYER_DIMS: BodyDims = { width: PLAYER_WIDTH, height: PLAYER_HEIGHT };

export interface PlayerState {
  /** Feet position: the box's bottom centre. */
  x: number; y: number; z: number;
  /** Velocity, blocks per tick. */
  vx: number; vy: number; vz: number;
  onGround: boolean;
  sneaking: boolean;
  /** The tick counter, for a caller's own timing. */
  tick: number;
  /** Auto-jump decided after the last tick's move: the next tick jumps (`WalkInput.autoJump`). */
  autoJumpPending?: boolean;
}

export interface WalkInput {
  /** The intended horizontal direction in world axes, magnitude at most 1 (clamped). */
  move: { x: number; z: number };
  jump: boolean;
  sneak: boolean;
  sprint?: boolean;
  /** Slow falling is active: the fall uses `SLOW_FALL_GRAVITY`. */
  slowFalling?: boolean;
  /** Auto-jump is on (Bedrock's touch default): an obstacle ahead within `AUTO_JUMP_MAX_RISE` is jumped (`autoJumpWanted`). */
  autoJump?: boolean;
  /** Where the player faces (world x/z), for auto-jump's forward test; absent, the move direction (the stick pushed forward). */
  facing?: { x: number; z: number };
}

/** A solid the move was clipped by, and on which axis. */
export interface Contact<S extends Box = Box> { axis: 'x' | 'y' | 'z'; solid: S }

export interface TickResult<S extends Box = Box> {
  state: PlayerState;
  /** Whether the move was clipped below (landing / standing), above (a ceiling), or sideways. */
  collided: { below: boolean; above: boolean; x: boolean; z: boolean };
  /** The auto-step raised the player this tick. */
  stepped: boolean;
  /** Each solid that clipped the move, once per axis it clipped. */
  contacts: Array<Contact<S>>;
}

export const NO_INPUT: WalkInput = { move: { x: 0, z: 0 }, jump: false, sneak: false };

/** The box of a body standing at a state's feet (the player's by default). */
export function playerBox(s: { x: number; y: number; z: number }, dims: BodyDims = PLAYER_DIMS): Box {
  const h = dims.width / 2;
  return { x0: s.x - h, y0: s.y, z0: s.z - h, x1: s.x + h, y1: s.y + dims.height, z1: s.z + h };
}

// ─── The sweep ───────────────────────────────────────────────────────────────

const overlapsXZ = (a: Box, b: Box): boolean => a.x1 > b.x0 + EPS && a.x0 < b.x1 - EPS && a.z1 > b.z0 + EPS && a.z0 < b.z1 - EPS;
const overlapsY = (a: Box, b: Box): boolean => a.y1 > b.y0 + EPS && a.y0 < b.y1 - EPS;
const overlapsXY = (a: Box, b: Box): boolean => a.x1 > b.x0 + EPS && a.x0 < b.x1 - EPS && overlapsY(a, b);
const overlapsYZ = (a: Box, b: Box): boolean => a.z1 > b.z0 + EPS && a.z0 < b.z1 - EPS && overlapsY(a, b);
const shift = (b: Box, dx: number, dy: number, dz: number): Box => ({ x0: b.x0 + dx, y0: b.y0 + dy, z0: b.z0 + dz, x1: b.x1 + dx, y1: b.y1 + dy, z1: b.z1 + dz });

/** Clip a y move against the solids the box overlaps in x and z; the clipping solid, if any. */
function clipY<S extends Box>(box: Box, dy: number, solids: readonly S[]): { d: number; hit: S | null } {
  let d = dy, hit: S | null = null;
  for (const s of solids) {
    if (!overlapsXZ(box, s)) continue;
    if (d > 0 && s.y0 >= box.y1 - EPS) { const m = s.y0 - box.y1; if (m < d) { d = m; hit = s; } }
    else if (d < 0 && s.y1 <= box.y0 + EPS) { const m = s.y1 - box.y0; if (m > d) { d = m; hit = s; } }
  }
  return { d, hit };
}
function clipX<S extends Box>(box: Box, dx: number, solids: readonly S[]): { d: number; hit: S | null } {
  let d = dx, hit: S | null = null;
  for (const s of solids) {
    if (!overlapsYZ(box, s)) continue;
    if (d > 0 && s.x0 >= box.x1 - EPS) { const m = s.x0 - box.x1; if (m < d) { d = m; hit = s; } }
    else if (d < 0 && s.x1 <= box.x0 + EPS) { const m = s.x1 - box.x0; if (m > d) { d = m; hit = s; } }
  }
  return { d, hit };
}
function clipZ<S extends Box>(box: Box, dz: number, solids: readonly S[]): { d: number; hit: S | null } {
  let d = dz, hit: S | null = null;
  for (const s of solids) {
    if (!overlapsXY(box, s)) continue;
    if (d > 0 && s.z0 >= box.z1 - EPS) { const m = s.z0 - box.z1; if (m < d) { d = m; hit = s; } }
    else if (d < 0 && s.z1 <= box.z0 + EPS) { const m = s.z1 - box.z0; if (m > d) { d = m; hit = s; } }
  }
  return { d, hit };
}

interface Sweep<S> { dx: number; dy: number; dz: number; hits: { x: S | null; y: S | null; z: S | null } }

/** The per-axis sweep (y, then x, then z) of a box by a move against the solids. */
function sweep<S extends Box>(box: Box, dx: number, dy: number, dz: number, solids: readonly S[]): Sweep<S> {
  const y = clipY(box, dy, solids);
  let b = shift(box, 0, y.d, 0);
  const x = clipX(b, dx, solids);
  b = shift(b, x.d, 0, 0);
  const z = clipZ(b, dz, solids);
  return { dx: x.d, dy: y.d, dz: z.d, hits: { x: x.hit, y: y.hit, z: z.hit } };
}

/**
 * True when the box, moved by (dx, dy, dz) all at once, overlaps a solid -
 * the sneak guard's support test (the game's `noCollision(box.move(dx,
 * -step, dz))`): a plain overlap of the displaced box, not a sweep, so
 * support under the box's OLD position does not count.
 */
function wouldCollide(box: Box, dx: number, dy: number, dz: number, solids: readonly Box[]): boolean {
  const b = shift(box, dx, dy, dz);
  for (const s of solids) if (overlapsXZ(b, s) && overlapsY(b, s)) return true;
  return false;
}

/** The result of moving a box by a wanted displacement. */
export interface MoveResult<S extends Box = Box> {
  /** The displacement actually made. */
  dx: number; dy: number; dz: number;
  collided: { below: boolean; above: boolean; x: boolean; z: boolean };
  stepped: boolean;
  contacts: Array<Contact<S>>;
}

/**
 * Move a box by a wanted displacement among the world's solids: the per-axis
 * sweep, then - when a sideways clip happens on the ground or while landing -
 * the auto-step retry raised by `STEP_HEIGHT`, kept when it gets further.
 * `sneakGuard` shortens a move on the ground that would leave the box without
 * support within a step below (the player's sneak).
 */
export function moveBox<S extends Box>(world: SolidQuery<S>, box: Box, wanted: { dx: number; dy: number; dz: number }, onGround: boolean, sneakGuard = false): MoveResult<S> {
  let { dx, dz } = wanted;
  const dy = wanted.dy;
  // The solids the move can meet: down to a step under the feet (the sneak guard, the step's settle) AND up to what the
  // box rises into - a jump's rise or the auto-step's `STEP_HEIGHT` raise. Until 2026-10-08 the query reached only the
  // displacement min(dy, -STEP_HEIGHT), so a box rising across a block boundary never saw the block it rose into: an
  // auto-jump under 10261's low lintel put the player's head 0.09 into a collider slab (found by `--walk` child play).
  const solids = world.solidsNear({ ...box, y1: box.y1 + Math.max(0, dy, STEP_HEIGHT) }, dx, Math.min(dy, -STEP_HEIGHT), dz);
  if (sneakGuard && onGround) {
    const supported = (ex: number, ez: number): boolean => wouldCollide(box, ex, -STEP_HEIGHT, ez, solids);
    for (; dx !== 0 && !supported(dx, 0); dx = Math.abs(dx) <= 0.05 ? 0 : dx - Math.sign(dx) * 0.05);
    for (; dz !== 0 && !supported(0, dz); dz = Math.abs(dz) <= 0.05 ? 0 : dz - Math.sign(dz) * 0.05);
    for (; dx !== 0 && dz !== 0 && !supported(dx, dz); dx = Math.abs(dx) <= 0.05 ? 0 : dx - Math.sign(dx) * 0.05, dz = Math.abs(dz) <= 0.05 ? 0 : dz - Math.sign(dz) * 0.05);
  }
  let sw = sweep(box, dx, dy, dz, solids);
  let stepped = false;
  const clippedSideways = Math.abs(sw.dx - dx) > EPS || Math.abs(sw.dz - dz) > EPS;
  // The auto-step: when on the ground (or landing this tick), retry the move raised by the step height, then settle down.
  if (clippedSideways && (onGround || (dy < 0 && Math.abs(sw.dy - dy) > EPS))) {
    // Two raises, as Java's `Entity.collide` tries them: the full step clipped over the box where it stands, and the
    // step clipped over the box stretched along the move (`expandTowards(dx, 0, dz)`), so a ceiling over the TARGET
    // column lowers the raise instead of turning the step into a wall (a 3/16 riser under a ceiling 1.81 over it,
    // 10261's station). The candidate that goes farther wins. The stretched raise only became necessary when the
    // solids query started reaching what the box rises into (2026-10-08); before, the ceiling was never seen.
    const stretched: Box = { x0: Math.min(box.x0, box.x0 + dx), x1: Math.max(box.x1, box.x1 + dx), y0: box.y0, y1: box.y1, z0: Math.min(box.z0, box.z0 + dz), z1: Math.max(box.z1, box.z1 + dz) };
    const plainDist = sw.dx * sw.dx + sw.dz * sw.dz;
    let bestDist = plainDist + EPS;
    for (const up of new Set([clipY(box, STEP_HEIGHT, solids).d, clipY(stretched, STEP_HEIGHT, solids).d])) {
      if (up <= EPS) continue;
      const raised = shift(box, 0, up, 0);
      const x = clipX(raised, dx, solids);
      const afterX = shift(raised, x.d, 0, 0);
      const z = clipZ(afterX, dz, solids);
      const afterZ = shift(afterX, 0, 0, z.d);
      const down = clipY(afterZ, -up, solids);
      const stepDist = x.d * x.d + z.d * z.d;
      if (stepDist > bestDist) {
        bestDist = stepDist;
        sw = { dx: x.d, dy: up + down.d, dz: z.d, hits: { x: x.hit, y: down.hit, z: z.hit } };
        stepped = true;
      }
    }
  }
  const collided = { below: dy < 0 && sw.dy > dy + EPS, above: dy > 0 && sw.dy < dy - EPS, x: Math.abs(sw.dx - dx) > EPS, z: Math.abs(sw.dz - dz) > EPS };
  if (stepped) collided.below = true;
  const contacts: Array<Contact<S>> = [];
  if (sw.hits.y && (collided.below || collided.above)) contacts.push({ axis: 'y', solid: sw.hits.y });
  if (sw.hits.x && collided.x) contacts.push({ axis: 'x', solid: sw.hits.x });
  if (sw.hits.z && collided.z) contacts.push({ axis: 'z', solid: sw.hits.z });
  return { dx: sw.dx, dy: sw.dy, dz: sw.dz, collided, stepped, contacts };
}

/**
 * The post-move damping, as the game applies it: gravity + drag vertically,
 * friction horizontally, velocity zeroed on an axis that collided.
 */
function damp(s: PlayerState, collided: MoveResult['collided'], slowFalling: boolean): void {
  s.onGround = collided.below;
  if (collided.x) s.vx = 0;
  if (collided.z) s.vz = 0;
  if (collided.below || collided.above) s.vy = 0;
  const g = slowFalling && s.vy <= 0 ? SLOW_FALL_GRAVITY : GRAVITY;
  s.vy = Math.max(-TERMINAL_VELOCITY, (s.vy - g) * VERTICAL_DRAG);
  const friction = s.onGround ? GROUND_FRICTION : AIR_FRICTION;
  s.vx *= friction; s.vz *= friction;
  if (Math.abs(s.vx) < 1e-5) s.vx = 0;
  if (Math.abs(s.vz) < 1e-5) s.vz = 0;
}

/**
 * The damping in water (quirk `liquid-motion`): every axis keeps `WATER_DRAG`, gravity is `WATER_GRAVITY`, and a body
 * pushed against a bank with room `WATER_EXIT_STEP` higher rises at `WATER_EXIT_LIFT` (Java: `horizontalCollision &&
 * isFree(dx, dy + 0.6, dz)`).
 */
function dampInWater<S extends Box>(world: SolidQuery<S>, s: PlayerState, collided: MoveResult['collided'], dims: BodyDims, gravity: boolean): void {
  s.onGround = collided.below;
  const sideways = collided.x || collided.z;
  if (collided.x) s.vx = 0;
  if (collided.z) s.vz = 0;
  if (collided.below || collided.above) s.vy = 0;
  s.vx *= WATER_DRAG; s.vy *= WATER_DRAG; s.vz *= WATER_DRAG;
  if (gravity) s.vy -= WATER_GRAVITY;
  if (sideways) {
    const lifted = shift(playerBox(s, dims), 0, WATER_EXIT_STEP + s.vy, 0);
    if (!world.solidsNear(lifted, 0, 0, 0).some(q => overlapsXZ(lifted, q) && overlapsY(lifted, q))) s.vy = WATER_EXIT_LIFT;
  }
  if (Math.abs(s.vx) < 1e-5) s.vx = 0;
  if (Math.abs(s.vz) < 1e-5) s.vz = 0;
}

/**
 * One tick of player motion. Input is applied first (a jump only from the
 * ground, sneaking scales speed and guards ledges), the box is swept per
 * axis against the solids it could meet, a sideways clip on the ground is
 * retried stepped up by `STEP_HEIGHT`, and the velocity is then damped as
 * the game does after its move.
 */
export function tickPlayer<S extends Box>(world: SolidQuery<S>, prev: PlayerState, input: WalkInput, dims: BodyDims = PLAYER_DIMS): TickResult<S> {
  const s: PlayerState = { ...prev, tick: prev.tick + 1, sneaking: input.sneak };
  // Intent → velocity. Ground: an acceleration whose steady state is the walking speed under ground friction.
  let mx = input.move.x, mz = input.move.z;
  const mag = Math.hypot(mx, mz);
  if (mag > 1) { mx /= mag; mz /= mag; }
  const speed = WALK_SPEED * (input.sneak ? SNEAK_FACTOR : input.sprint ? SPRINT_FACTOR : 1);
  // In water (a world with liquids; quirk `liquid-motion`): its own control, swim and damping.
  const wet = world.submersion?.(playerBox(s, dims)) ?? 0;
  if (wet > 0) {
    s.vx += mx * WATER_ACCELERATION; s.vz += mz * WATER_ACCELERATION;
    if (input.jump) { if (wet * dims.height > FLOAT_JUMP_DEPTH) s.vy += WATER_SWIM_UP; else if (s.onGround) s.vy = JUMP_VELOCITY; }
    const moved = moveBox(world, playerBox(s, dims), { dx: s.vx, dy: s.vy, dz: s.vz }, s.onGround, input.sneak);
    s.x += moved.dx; s.y += moved.dy; s.z += moved.dz;
    dampInWater(world, s, moved.collided, dims, true);
    s.autoJumpPending = false;
    return { state: s, collided: moved.collided, stepped: moved.stepped, contacts: moved.contacts };
  }
  if (s.onGround) {
    const accel = speed * (1 - GROUND_FRICTION);
    s.vx += mx * accel; s.vz += mz * accel;
    // A pressed jump, or the auto-jump the last tick decided (Java: `autoJumpTime` counts down into `jumping`).
    if (input.jump || (input.autoJump && !input.sneak && prev.autoJumpPending)) { s.vy = JUMP_VELOCITY; }
  } else {
    s.vx += mx * AIR_ACCELERATION; s.vz += mz * AIR_ACCELERATION;
  }
  const move = moveBox(world, playerBox(s, dims), { dx: s.vx, dy: s.vy, dz: s.vz }, s.onGround, input.sneak);
  s.x += move.dx; s.y += move.dy; s.z += move.dz;
  damp(s, move.collided, input.slowFalling === true);
  // Decided after the move, from where it ended and what it made, as the game does.
  s.autoJumpPending = !!input.autoJump && !input.sneak && s.onGround && (mx !== 0 || mz !== 0)
    && autoJumpWanted(world, s, { x: move.dx, z: move.dz }, { x: mx, z: mz }, input.facing ?? { x: mx, z: mz }, dims, speed);
  return { state: s, collided: move.collided, stepped: move.stepped, contacts: move.contacts };
}

/**
 * Whether auto-jump fires for a player standing at `s` after a tick that moved it by `moved`, with the stick
 * pushed `intent` and the camera facing `facing` (both world x/z): Java's `LocalPlayer.updateAutoJump`, the
 * rules and their numbers listed at `AUTO_JUMP_MIN_RISE`. `speed` is this tick's walk speed (blocks/tick), the
 * stuck player's probe step when the move made nothing (pressed against a wall). Of the solids the two side
 * probes meet, the NEAREST along the move is the obstacle (Java takes the first its collision iterator yields);
 * a solid in the block cell over that obstacle's centre raises its top (a two-high wall is not jumped).
 */
export function autoJumpWanted<S extends Box>(world: SolidQuery<S>, s: { x: number; y: number; z: number }, moved: { x: number; z: number }, intent: { x: number; z: number }, facing: { x: number; z: number }, dims: BodyDims = PLAYER_DIMS, speed = WALK_SPEED): boolean {
  let d = { x: moved.x, z: moved.z };
  if (d.x * d.x + d.z * d.z <= 0.001) {
    // Pressed against something: the stick's direction at the walk speed (Java: getSpeed() x the move vector).
    const n = Math.hypot(intent.x, intent.z) || 1;
    d = { x: intent.x / n * speed, z: intent.z / n * speed };
  }
  const len = Math.hypot(d.x, d.z);
  if (len < 1e-9) return false;
  const dir = { x: d.x / len, z: d.z / len };
  const fn = Math.hypot(facing.x, facing.z);
  if (fn > 1e-9 && (facing.x * dir.x + facing.z * dir.z) / fn < AUTO_JUMP_BACKWARD_DOT) return false;
  // Headroom: the cell holding the box's top and the one over it carry no collision.
  const cellSolid = (bx: number, by: number, bz: number): S[] => world.solidsNear({ x0: bx, y0: by, z0: bz, x1: bx + 1, y1: by + 1, z1: bz + 1 }, 0, 0, 0)
    .filter(q => q.x1 > bx + EPS && q.x0 < bx + 1 - EPS && q.y1 > by + EPS && q.y0 < by + 1 - EPS && q.z1 > bz + EPS && q.z0 < bz + 1 - EPS);
  const hx = Math.floor(s.x), hy = Math.floor(s.y + dims.height), hz = Math.floor(s.z);
  if (cellSolid(hx, hy, hz).length || cellSolid(hx, hy + 1, hz).length) return false;
  // The two side probes, at 0.51 over the feet, from the feet to the lookahead past this move.
  const reach = Math.max(AUTO_JUMP_LOOKAHEAD, len);
  const end = { x: s.x + d.x + dir.x * reach, z: s.z + d.z + dir.z * reach };
  const py = s.y + AUTO_JUMP_PROBE_HEIGHT, half = dims.width / 2;
  const perp = { x: -dir.z * half, z: dir.x * half };
  const probes = [-1, 1].map(k => ({ x0: Math.min(s.x, end.x) + k * perp.x, x1: Math.max(s.x, end.x) + k * perp.x, z0: Math.min(s.z, end.z) + k * perp.z, z1: Math.max(s.z, end.z) + k * perp.z }));
  const area = { x0: Math.min(s.x, end.x) - dims.width, y0: s.y, z0: Math.min(s.z, end.z) - dims.width, x1: Math.max(s.x, end.x) + dims.width, y1: s.y + dims.height, z1: Math.max(s.z, end.z) + dims.width };
  let best: { q: S; t: number } | undefined;
  for (const q of world.solidsNear(area, 0, 0, 0)) {
    // AABB.intersects(from, to): a strict overlap of the solid with the probe's own (flat) bounding box.
    if (!(q.y0 < py && q.y1 > py)) continue;
    if (!probes.some(p => q.x0 < p.x1 && q.x1 > p.x0 && q.z0 < p.z1 && q.z1 > p.z0)) continue;
    // How far along the move the solid starts (its nearest corner): the first one met is the obstacle.
    const t = Math.max(0, Math.min(...[[q.x0, q.z0], [q.x0, q.z1], [q.x1, q.z0], [q.x1, q.z1]].map(([x, z]) => (x! - s.x) * dir.x + (z! - s.z) * dir.z)));
    if (!best || t < best.t) best = { q, t };
  }
  if (!best) return false;
  let top = best.q.y1;
  const cx = Math.floor((best.q.x0 + best.q.x1) / 2), cy = Math.floor((best.q.y0 + best.q.y1) / 2), cz = Math.floor((best.q.z0 + best.q.z1) / 2);
  const stacked = cellSolid(cx, cy + 1, cz);
  if (stacked.length) {
    top = Math.max(...stacked.map(q => q.y1));
    if (top - s.y > AUTO_JUMP_MAX_RISE) return false;
  }
  const rise = top - s.y;
  return rise > AUTO_JUMP_MIN_RISE && rise <= AUTO_JUMP_MAX_RISE;
}

/**
 * One tick of a mob that moves by velocity alone (no walk input): an impulse
 * already added to its velocity, gravity when `gravity`, the same sweep,
 * step and damping as the player. A figure walked by `applyImpulse` is this.
 */
export function tickBody<S extends Box>(world: SolidQuery<S>, prev: PlayerState, dims: BodyDims, gravity = true, fluid: BodyFluid = {}): TickResult<S> {
  const s: PlayerState = { ...prev, tick: prev.tick + 1, sneaking: false };
  // In water (quirk `liquid-motion`): a floater swims up, a buoyant body is pushed toward half under (`buoyant-body`).
  const wet = world.submersion?.(playerBox(s, dims)) ?? 0;
  if (wet > 0) {
    if (fluid.floats && wet * dims.height > FLOAT_JUMP_DEPTH) s.vy += WATER_SWIM_UP;
    if (fluid.buoyancy) s.vy += BUOYANT_SPRING * fluid.buoyancy * (wet - 0.5);
  }
  const move = moveBox(world, playerBox(s, dims), { dx: s.vx, dy: s.vy, dz: s.vz }, s.onGround);
  s.x += move.dx; s.y += move.dy; s.z += move.dz;
  if (wet > 0) dampInWater(world, s, move.collided, dims, gravity && !fluid.buoyancy);
  else if (gravity) damp(s, move.collided, false);
  else {
    s.onGround = move.collided.below;
    if (move.collided.x) s.vx = 0;
    if (move.collided.z) s.vz = 0;
    if (move.collided.below || move.collided.above) s.vy = 0;
    s.vx *= AIR_FRICTION; s.vy *= VERTICAL_DRAG; s.vz *= AIR_FRICTION;
  }
  return { state: s, collided: move.collided, stepped: move.stepped, contacts: move.contacts };
}
