/**
 * The vehicle course: every SCRIPTED vehicle of a built pack (a car, a hover
 * craft, a ship; `scripts/vehicles.js`) driven, as a five-year-old drives it,
 * into the obstacles that used to stop it dead - a step, a hill, a two-block
 * kerb, a three-block wall, a tree met with a corner, a wall met at an angle,
 * two- and three-deep pits - holding the stick FORWARD and nothing else
 * (2026-09-30, "it's too easy to get fully stuck in place by hills / blocks").
 * Each obstacle is laid in its own lane of the superflat world, away from the
 * model (no placement is needed: the vehicle is spawned, the child seated on
 * it). Per obstacle it records whether the vehicle got past, how many ticks it
 * pushed without moving, the highest it rose, and whether its clear band ever
 * went INTO a block (the footprint's band: over a car's step, a ship's whole
 * airframe aloft). Where it did not get past, the child backs off, turns and
 * drives away (`escaped`).
 *
 * Then, per vehicle: the ship's spaceship controls (`shipControls`: straight
 * up, hover, forward, straight back, a turn on the spot, back + Jump and look
 * down + Jump straight down) and the free look (`cameraRecentre`: a drag
 * orbits the chase camera, it holds at rest, it eases back behind the nose
 * while driving, and it opens behind the nose when the child climbed on
 * looking away) and the cockpit view at full speed (`cockpitEye`).
 *
 *   vehicle-not-stuck   a vehicle class that must pass an obstacle did not
 *                       (every obstacle for a ship; all but the three-block
 *                       wall and the three-deep pit for a car or hover craft);
 *   vehicle-escapes     after a stop the child could not back and turn away;
 *   vehicle-no-clip     the vehicle's clear band went into a block;
 *   ship-controls       a spaceship control did not do what it says;
 *   free-look           a drag did not move the camera, or it did not ease back,
 *                       or the chase camera opened off the nose after a mount
 *                       (the seat's turn of the rider read as a drag, Saga 30k);
 *   cockpit-eye-on-seat the cockpit camera is drawn more than half a block off
 *                       the drawn seat at speed (quirk `cockpit-draw-lag`;
 *                       Saga 30k: over the McLaren's hood at 43 mph);
 *   ship-slides-along   a ship ran along an obstacle's face (10+ blocks across the lane) instead of lifting over it (Saga 30j);
 *   ship-turn-climbs    a turn on the spot against a post lifted the ship (Saga 30j);
 *   ship-parks-on-player  an empty ship sank onto the child who sneaked off it (Saga 30j);
 *   ship-parks          an empty ship did not park once the child walked out from under it;
 *   dismount-in-hull    a sneak on the ground at 100/200/400 % left the child inside the hull (or
 *                       aboard); the fall off the seat is the core `no-unprotected-fall` (Pixel 30l:
 *                       ~9 blocks off the 200 % Milano).
 *
 * BOATS (2026-10-08, `TODO(sim-boat-course)` closed) run the WATER lanes
 * (`boatCourse`, `WATER_LANES`) in pools as deep as their draft at the size
 * needs, the surface 1.11 under the shore as in the GameTest arena
 * (`GT_VEHICLE_LAYOUT`): open water (`water-flat`: it must make way and stay
 * afloat), a bank met bow-on (`water-bank`: it must stop at the waterline and
 * back off, never climb out), a one-block-deep channel (`water-shallow`:
 * measured - how far its keel would sit in the bed), a pier post met off
 * square (`water-wall`: never through it); then getting off on open water and
 * beside a bank at 100/200/400 % (`waterEgress`), and the free look and the
 * cockpit eye on water.
 *
 *   boat-not-afloat     on open water the boat did not make way, or left its waterline;
 *   boat-climbs-bank    a boat driven at a bank rose onto it or ran past the waterline;
 *   water-egress-under-hull  a sneak off a boat left the child under (or in) the hull.
 *
 * Run: `bun scripts/sim.ts <packs> --scenario=vehicles [--md=] [--json=]`.
 * Native mounts (a rotorcraft, a flyer's cloud) are left out: the simulator's
 * hover controller is a stand-in for the device's, whose stepping is not modelled.
 */

import { entityKey, nsId, sizeEventOf } from './namespace.js';
import type { AnyStep, Scenario, StepContext, StepHandler } from '../../scenario/types.js';
import type { SimEntity } from '../../entity/entity.js';
import { vehicleCameraEntry, type CraftmaticPack } from './pack-facts.js';
import { packText } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { BOAT, FLIGHT, FLIGHT_PROPS } from '../../../engine/bedrock-vehicle.js';
import { cockpitCamera, type CockpitPose } from '../../../engine/vehicle-free-look.js';
import { quirkValue } from '../../quirks/registry.js';
import { liquidSurface, submersion } from '../../world/liquids.js';
import { PLAYER_HEIGHT, PLAYER_WIDTH } from '../../physics/body.js';
import type { AddonAppearance } from './appearance.js';
import { animatedPoses, drawnBoxes, entityDrawn } from './drawn.js';
import { pick, tap } from '../../input/touch.js';
import { viewDirection } from '../../core/vec.js';
import { floorBelow, standsAt } from '../../scenario/approach.js';
import { teleport } from '../../script-host/facades.js';
import { CORE_HANDLERS, findEntity } from '../../scenario/runner.js';
import { lookAt } from '../../input/touch.js';
import { VEHICLE_PART, pickVehiclePart, pickVehicleTap, vehiclePartProperty, vehicleSlideWorldPath, type VehiclePartRuntime, type VehicleSlideRuntime } from '../../../engine/vehicle-parts.js';
import { pivotRotation } from '../../../engine/bedrock-geometry-faces.js';
import { SLIDE_SEAT_OVER_DRAWN, heightOverDrawn, onRunout } from './play.js';

/** The view a player's rotation looks along (the facade's `getViewDirection`). */
const viewDirectionOf = (e: SimEntity): { x: number; y: number; z: number } => viewDirection(e.rotation.y, e.rotation.x);
/** A standing player's eye over its feet (quirk `rider-location-under-head`: 1.62 standing). */
const PLAYER_EYE = 1.62;
import type { Pack } from '../../pack/pack.js';

/**
 * The drawn appearance of each pack the child-play handlers were built for (`registerAppearance`), so the course's
 * handlers - built from the pack's facts alone - can read a vehicle's DRAWN hull (a boat's keel against the water).
 */
const appearances = new WeakMap<Pack, AddonAppearance>();
/** Remember a pack's appearance for the course (child-play's `craftmaticHandlers` calls this). */
export function registerAppearance(pack: Pack, appearance: AddonAppearance): void { appearances.set(pack, appearance); }
/** A pack's registered drawn appearance (undefined until `craftmaticHandlers` built it): a regression case reads a hull through it. */
export function registeredAppearance(pack: Pack): AddonAppearance | undefined { return appearances.get(pack); }

/** Ticks after boarding before the seat turns a child who climbed on looking away onto the heading (quirk `mount-snaps-rider-yaw`: 4-12 on the Saga). */
const MOUNT_SNAP_TICKS = 4;
/** Ticks the cockpit-eye check drives at full stick (6 s: every class is at its top speed well before). */
const COCKPIT_DRIVE_TICKS = 120;
/** Blocks the cockpit eye may be drawn off the seat along the heading (half a block: inside the cabin of the smallest car). */
const COCKPIT_EYE_SLACK = 0.5;

/** A scripted vehicle type as `scripts/vehicles.js` declares it (blocks at scale 1; a boat's `draft` its keel's depth under the waterline). */
export interface ScriptedTypeFacts {
  typeId: string; mode: 'car' | 'boat' | 'plane' | 'hover'; noseReach: number; halfWidth: number; height: number; draft: number;
  /** The doors, lids and cupboards it carries (vehicle-parts.ts `VehiclePartRuntime`), part k on `craftmatic:vpart_<k>`. */
  parts: VehiclePartRuntime[];
  /** Its `body` bone's pivot (entity frame, blocks at 100 %), where the lean the pick follows turns it; absent: the origin. */
  bodyPivot?: number[];
  /** The slides it carries, ridden while it is parked (vehicle-parts.ts `VehicleSlideRuntime`). */
  slides: VehicleSlideRuntime[];
}

/** The scripted vehicle types of a pack, read from `scripts/vehicles.js`'s config (the runtime's first argument). */
export function scriptedVehicleTypes(pack: CraftmaticPack): ScriptedTypeFacts[] {
  const text = packText(pack.pack, 'scripts/vehicles.js');
  if (!text) return [];
  const at = text.indexOf('({"types":');
  if (at < 0) return [];
  const cfg = extractJsonAfter(text.slice(at), '(') as { types?: Record<string, { mode?: string; noseReach?: number; halfWidth?: number; height?: number; draft?: number; parts?: VehiclePartRuntime[]; bodyPivot?: number[]; slides?: VehicleSlideRuntime[] }> } | undefined;
  return Object.entries(cfg?.types ?? {}).map(([typeId, t]) => ({
    typeId, mode: (t.mode ?? 'car') as ScriptedTypeFacts['mode'], noseReach: Number(t.noseReach ?? 1), halfWidth: Number(t.halfWidth ?? 0.5), height: Number(t.height ?? 1), draft: Number(t.draft ?? BOAT.DRAFT),
    parts: Array.isArray(t.parts) ? t.parts : [],
    ...(Array.isArray(t.bodyPivot) ? { bodyPivot: t.bodyPivot } : {}),
    slides: Array.isArray(t.slides) ? t.slides : [],
  }));
}

/**
 * The NATIVE vehicles of a pack that carry moving parts (a rotorcraft's doors: vehicle-driver.js answers a tap on
 * them, vehicle-parts.ts), read from `scripts/vehicle-driver.js`'s config, as part-carrying facts: `mode` 'plane',
 * a nominal footprint (only where a fresh one is spawned beside the child), no slides. The device flies them itself,
 * so no course step drives them.
 */
export function nativePartTypes(pack: CraftmaticPack): ScriptedTypeFacts[] {
  const text = packText(pack.pack, 'scripts/vehicle-driver.js');
  if (!text) return [];
  const at = text.indexOf('({"');
  if (at < 0) return [];
  const cfg = extractJsonAfter(text.slice(at), '(') as { vehicles?: Array<{ typeId?: string; parts?: VehiclePartRuntime[] }> } | undefined;
  return (cfg?.vehicles ?? []).filter(v => v.typeId && Array.isArray(v.parts) && v.parts.length).map(v => ({
    typeId: v.typeId!, mode: 'plane' as const, noseReach: 4, halfWidth: 2, height: 2, draft: BOAT.DRAFT, parts: v.parts!, slides: [],
  }));
}

/** Every vehicle type that carries moving parts: the scripted ones and the native ones (`nativePartTypes`). */
export function partVehicleTypes(pack: CraftmaticPack): ScriptedTypeFacts[] {
  return [...scriptedVehicleTypes(pack).filter(t => t.parts.length), ...nativePartTypes(pack)];
}

/**
 * The course's obstacles, in the order a lane is laid. `oblique` is the Saga's
 * (round 30j, 2026-10-07): a two-high hill met 19 degrees off square, long
 * toward the side a sidestep runs to - every other lane meets its wall
 * square-on, where both halves of the footprint block and the response
 * rises; off square one half meets it first and the X-wing "deflected" 13-50
 * blocks along it, never lifting (`VEH-08`, CMVT 15:19:25-31, 15:21:04-09).
 */
export const COURSE_OBSTACLES = ['step1', 'hill', 'kerb2', 'wall3', 'tree', 'angled', 'pit2', 'pit3', 'oblique'] as const;
export type CourseObstacle = typeof COURSE_OBSTACLES[number];

/** The heading a lane is driven at, degrees off the lane's +x (a positive angle turns toward +z). */
export const OBSTACLE_SKEW_DEG: Readonly<Partial<Record<CourseObstacle, number>>> = { oblique: 19 };
/**
 * What a car or hover craft may be stopped by (it must still back and turn away from the wall; the deep pit is a
 * known trap; a kerb met off square is slid along, not climbed - the car's climb comes after its slide, and the
 * device passed its kerb, wall and slide-along square-on: measured here, not required. `TODO(car-oblique-kerb)`).
 */
const GROUND_MAY_BLOCK: ReadonlySet<CourseObstacle> = new Set(['wall3', 'pit3', 'oblique']);
/** Ticks the child holds the stick forward at an obstacle (10 s). */
export const COURSE_PUSH_TICKS = 200;
/** Blocks the oblique hill runs past the lane toward +z (a sidestep of 0.63 a tick covers it in 6 s; the push is 10). */
const OBLIQUE_RUN = 70;
/** Ticks the child holds the stick right against a post (`turnAgainstPost`, 2 s: the Saga's rise took one). */
const TURN_TICKS = 40;

/**
 * The block cell (index along a decreasing axis) of a post whose near face stands about `gap` beyond `edge`, and never
 * on or inside it: `floor(edge - gap)` alone puts the face anywhere from `gap` beyond to `1 - gap` INSIDE (the cell
 * runs to `floor + 1`). 31060's stunt plane (half width 0.79) started 0.29 inside its post and every tick of the
 * turn counted as a clip. Where that face is less than 0.1 beyond, the post moves one cell out; every favourite's
 * plane keeps its cell (7140 -248, 0.68 off; 60446 0.19; 76286 0.5; 7877 0.52).
 */
export function postCellBeyond(edge: number, gap: number): number {
  const cell = Math.floor(edge - gap);
  return edge - (cell + 1) < 0.1 ? cell - 1 : cell;
}
/** Blocks a ship may drift across a lane beyond its heading's own before it is running ALONG the obstacle (the Saga's shortest run was 13). */
const SLIDE_ALONG_BLOCKS = 10;

/** One obstacle's outcome for one vehicle. */
export interface CourseRow {
  vehicle: string; mode: string; obstacle: CourseObstacle | WaterLane;
  /** What the child held: the stick forward, or (a ship's second run) the stick forward and Jump - the old flight model's throttle. */
  policy: 'forward' | 'forward+jump';
  passed: boolean; ticks: number; stuckTicks: number; rose: number; clipTicks: number;
  /** How far it went ACROSS the lane (blocks, toward +z) beyond its heading's own drift: a sidestep along a wall shows here. */
  side: number;
  /** The vehicle's position relative to the obstacle's start every `trace` ticks (`stuckCourse` `{ trace: n }`), for a diagnosis. */
  trace?: Array<[number, number, number]>;
  /** After a stop: did backing off, turning and driving away move it 3 blocks? (undefined when it passed). */
  escaped?: boolean;
  /** The first tick its band went into a block: where it stood (y relative to the ground), its pitch, the cell. */
  firstClip?: { t: number; x: number; y: number; pitch: number; cell: [number, number, number] };
  /** A water lane: how far the origin strayed from the waterline (blocks; a boat afloat rides `surface - draft`). */
  offWaterline?: number;
  /** `water-shallow`: how deep (blocks) the keel would sit in the channel's bed, the hull drawn through it (0: clear). */
  keelInBed?: number;
  /** `water-bank`: how far the bow ran past the bank's face (blocks; negative: short of it). */
  pastBank?: number;
}

/**
 * The water lanes a boat runs (2026-10-08): open water, a bank met bow-on, a one-block-deep channel, a pier post met
 * `OBSTACLE_SKEW_DEG.oblique` off square. Each in its own pool, deep enough for the boat's draft.
 */
export const WATER_LANES = ['water-flat', 'water-bank', 'water-shallow', 'water-wall'] as const;
export type WaterLane = typeof WATER_LANES[number];
/** Blocks a boat must make ahead on open water in `COURSE_PUSH_TICKS` (the GameTest's `aheadMoves` asks 8 in 80 ticks). */
const WATER_AHEAD_BLOCKS = 20;
/** Blocks a boat afloat may stray from its waterline (`surface - draft`): the GameTest's `floats` (0.3). */
const WATERLINE_SLACK = 0.3;
/** How far (blocks) the bow may run past a bank's face: half a block for the tick it stopped on (the GameTest's `beaches`: rose under 0.5). */
const BANK_SLACK = 0.5;

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const wrap = (a: number): number => ((a + 180) % 360 + 360) % 360 - 180;

/** The solid cells an obstacle lays, relative to a lane: x along the drive from the obstacle's start, z across from the lane's centre line, y from the ground's first air layer (negative: dug). */
function obstacleCells(o: CourseObstacle, f: ScriptedTypeFacts): { solid: Array<[number, number, number]>; dig: Array<[number, number, number]>; length: number } {
  const half = Math.ceil(f.halfWidth) + 4, solid: Array<[number, number, number]> = [], dig: Array<[number, number, number]> = [];
  const across = (fn: (z: number) => void): void => { for (let z = -half; z <= half; z++) fn(z); };
  const box = (x0: number, x1: number, h: number): void => { for (let x = x0; x <= x1; x++) for (let y = 0; y < h; y++) across(z => solid.push([x, y, z])); };
  const pitLength = Math.ceil(2 * f.noseReach) + 2;
  switch (o) {
    case 'step1': box(0, 5, 1); return { solid, dig, length: 6 };
    case 'kerb2': box(0, 5, 2); return { solid, dig, length: 6 };
    case 'wall3': box(0, 0, 3); return { solid, dig, length: 1 };
    case 'hill':
      // Up a block every two, to four high, six flat, and down again.
      for (let s = 0; s < 4; s++) box(2 * s, 2 * s + 1, s + 1);
      box(8, 13, 4);
      for (let s = 0; s < 3; s++) box(14 + 2 * s, 15 + 2 * s, 3 - s);
      return { solid, dig, length: 20 };
    case 'tree': {
      // A trunk five high a little inside the footprint's +z side (a corner meets it), a crown over it.
      const tz = Math.floor(Math.max(0, f.halfWidth - 0.35));
      for (let y = 0; y < 5; y++) solid.push([0, y, tz]);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) solid.push([dx, 5, tz + dz]);
      return { solid, dig, length: 2 };
    }
    case 'angled': {
      // A three-high wall across the lane at 30 degrees off the drive (it meets the vehicle's +z side first).
      for (let z = -half; z <= half; z++) { const x = Math.round((half - z) * Math.tan(30 * Math.PI / 180)); for (let y = 0; y < 3; y++) solid.push([x, y, z]); }
      return { solid, dig, length: Math.round(2 * half * Math.tan(30 * Math.PI / 180)) + 1 };
    }
    case 'pit2': case 'pit3': {
      const d = o === 'pit2' ? 2 : 3;
      for (let x = 0; x < pitLength; x++) for (let y = 1; y <= d; y++) across(z => dig.push([x, -y, z]));
      return { solid, dig, length: pitLength };
    }
    case 'oblique':
      // The Saga's two-high hill, met `OBSTACLE_SKEW_DEG` off square: long toward +z, the side the heading's
      // first-touching (left) half would sidestep to, so a slide along it cannot reach the end in a push.
      for (let x = 0; x <= 1; x++) for (let y = 0; y < 2; y++) for (let z = -half; z <= half + OBLIQUE_RUN; z++) solid.push([x, y, z]);
      return { solid, dig, length: 2 };
  }
}

/**
 * How deep (blocks) a vehicle's band may graze a block before it counts as going INTO it: the runtime
 * probes the band at heights along the boundary that moves, at 0.9-block
 * spacing, so a graze of a few hundredths between two probes is the model's grain, not a hole.
 */
export const CLIP_SLACK = 0.1;

/** The vehicle's rectangle and band (blocks): does it overlap a block cell anywhere in the band? */
function bandOverlaps(v: SimEntity, f: ScriptedTypeFacts, lo: number, hi: number, cell: [number, number, number]): boolean {
  const [cx, cy, cz] = cell;
  // The band tilts with the vehicle's nose-up pitch about its LOW end, as the runtime's sweep does
  // (`sweepFootprint`): a car climbing a slope carries its front band up the slope.
  // (A car's and a hover craft's band is swept LEVEL since 2026-09-30: only a ship's or a boat's tilts.)
  const pitch = f.mode === 'plane' || f.mode === 'boat' ? Number(v.properties.get(entityKey(v.typeId, 'fl_pitch')) ?? 0) || 0 : 0;
  const tilt = Math.tan(Math.max(-60, Math.min(60, pitch)) * Math.PI / 180);
  if (v.location.y + hi + Math.max(0, f.noseReach * Math.abs(tilt)) <= cy + 1e-3 || v.location.y + lo >= cy + 1 - 1e-3) return false;
  const r = v.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
  /** Whether a point of the footprint, `a` blocks along the nose, has its band in the cell's height. */
  const bandAt = (a: number): boolean => {
    const lift = Math.max(0, a * tilt);
    // A tenth of a block of slack: the runtime probes the band at heights along
    // its perimeter, and a pitched band's interior grazes a kerb's top edge by a few hundredths as it climbs.
    return v.location.y + hi + lift > cy + CLIP_SLACK && v.location.y + lo + lift < cy + 1 - CLIP_SLACK;
  };
  // The cell's corners and centre in the vehicle's frame, and the rectangle's own sample points in the cell.
  for (const [px, pz] of [[cx + 0.5, cz + 0.5], [cx + 0.05, cz + 0.05], [cx + 0.95, cz + 0.05], [cx + 0.05, cz + 0.95], [cx + 0.95, cz + 0.95]] as const) {
    const dx = px - v.location.x, dz = pz - v.location.z, a = dx * fx + dz * fz;
    if (Math.abs(a) < f.noseReach - 0.05 && Math.abs(dx * rx + dz * rz) < f.halfWidth - 0.05 && bandAt(a)) return true;
  }
  for (const k of [-1, 0, 1]) for (const s of [-1, 0, 1]) {
    const a = k * (f.noseReach - 0.05);
    const px = v.location.x + fx * a + rx * s * (f.halfWidth - 0.05), pz = v.location.z + fz * a + rz * s * (f.halfWidth - 0.05);
    if (px > cx && px < cx + 1 && pz > cz && pz < cz + 1 && bandAt(a)) return true;
  }
  return false;
}

/** The vehicle course's step handlers. */
export function vehicleCourseHandlers(pack: CraftmaticPack): Record<string, StepHandler> {
  // The native part carriers too: only the `vehicleParts` step reaches them (no course is laid for a native vehicle).
  const types = new Map([...scriptedVehicleTypes(pack), ...nativePartTypes(pack)].map(t => [t.typeId, t]));
  /**
   * Spawn the vehicle and seat the child on it, heading +x (yaw -90) turned `skew` degrees toward +z, at `at` on the
   * ground. `lookAway` (degrees): the child mounts looking that far off the heading, and the seat turns them onto it
   * `MOUNT_SNAP_TICKS` later, as the device does (quirk `mount-snaps-rider-yaw`; the simulator's `addRider` does not).
   */
  const board = async (ctx: StepContext, f: ScriptedTypeFacts, at: { x: number; z: number; y?: number }, skew = 0, lookAway?: number): Promise<SimEntity> => {
    // A low car's seated rider has its feet under the road (the seat is the driver's EYE less the seated eye
    // height, cockpit-seat.ts), and the pits are dug below the flat world's ground on purpose: the course
    // judges the VEHICLE by its own clear band (`vehicle-no-clip`), so these two core checks are quiet.
    ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
    const v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', { x: at.x, y: at.y ?? FLAT_GROUND_Y, z: at.z });
    v.rotation = { x: 0, y: -90 + skew };
    await ctx.run(2);
    const r = v.addRider(ctx.player, ctx.sim.engine.tick);
    if (!r.ok) throw new Error(`could not seat the child on ${f.typeId}: ${r.why}`);
    if (lookAway !== undefined) {
      ctx.player.rotation = { x: 0, y: wrap(-90 + skew + lookAway) };
      await ctx.run(MOUNT_SNAP_TICKS);
    }
    ctx.player.rotation = { x: 0, y: -90 + skew };
    await ctx.run(2);
    return v;
  };
  /** A scripted vehicle's camera config in `scripts/vehicle-camera.js` (the runtime's first argument): the cockpit eye. */
  const cameraCfg = (typeId: string): { eye?: [number, number, number] } | undefined => vehicleCameraEntry(pack.pack, typeId);
  /** The band the runtime keeps clear (bedrock-vehicle.ts: a car's over its step, a ship's whole airframe aloft, a boat's from just above its waterline). */
  const bandOf = (f: ScriptedTypeFacts): { lo: number; hi: number } => (f.mode === 'plane' ? { lo: 0.15, hi: Math.max(0.2, f.height - 0.15) }
    : f.mode === 'boat' ? { lo: f.draft + 0.05, hi: Math.max(f.draft + 0.5, Math.min(f.height, f.draft + 3)) }
      : { lo: (f.mode === 'hover' ? 1.6 - 1 : 1.05) + 0.1, hi: Math.max(1.2, f.height - 0.15) });
  /** Lay a column of stone from the ground up `h` blocks at cell (x, z); returns its cells. */
  const column = (ctx: StepContext, x: number, z: number, h: number): Array<[number, number, number]> => {
    const w = ctx.sim.engine.dimension('overworld'), stone = ctx.sim.host.resolvePermutation('minecraft:stone');
    const cells: Array<[number, number, number]> = [];
    for (let y = 0; y < h; y++) { w.setPermutation(x, FLAT_GROUND_Y + y, z, stone); cells.push([x, FLAT_GROUND_Y + y, z]); }
    return cells;
  };
  const hold = (ctx: StepContext, c: { forward?: number; strafe?: number; jump?: boolean }): void => { ctx.sim.controls.set(ctx.player.id, { forward: c.forward ?? 0, strafe: c.strafe ?? 0, jump: c.jump ?? false }); };
  const typeOf = (step: AnyStep): ScriptedTypeFacts => {
    const f = types.get(String(step['type']));
    if (!f) throw new Error(`no scripted vehicle type ${String(step['type'])}`);
    return f;
  };
  const setBlock = (ctx: StepContext, x: number, y: number, z: number, typeId: string): void => { ctx.sim.engine.dimension('overworld').setPermutation(x, y, z, ctx.sim.host.resolvePermutation(typeId)); };
  /**
   * A pool on the flat world: water over x [x0, x1], z [z0, z1] from the ground up `depth` blocks (no flow is
   * simulated, so it needs no rim), a stone bed in its lowest `bed` blocks. Its surface sits 8/9 into the top block
   * (quirk `liquid-surface-height`); a bank laid beside it to `yTop + 1` stands 1.11 over the surface, the GameTest
   * arena's shore (`GT_VEHICLE_LAYOUT`: land top +4, water to +2).
   */
  const pool = (ctx: StepContext, b: { x0: number; x1: number; z0: number; z1: number }, depth: number, bed = 0): { surface: number; yTop: number; bed: number } => {
    const w = ctx.sim.engine.dimension('overworld'), water = ctx.sim.host.resolvePermutation('minecraft:water'), stone = ctx.sim.host.resolvePermutation('minecraft:stone');
    const yTop = FLAT_GROUND_Y + depth - 1;
    for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) for (let y = FLAT_GROUND_Y; y <= yTop; y++) w.setPermutation(x, y, z, y < FLAT_GROUND_Y + bed ? stone : water);
    return { surface: liquidSurface(w, b.x0, yTop, b.z0) ?? yTop + 8 / 9, yTop, bed: FLAT_GROUND_Y + bed };
  };
  /** A bank: stone over x [x0, x1], z [z0, z1] from the ground to `top` (its top face at `top + 1`); returns its cells. */
  const bank = (ctx: StepContext, b: { x0: number; x1: number; z0: number; z1: number }, top: number): Array<[number, number, number]> => {
    const cells: Array<[number, number, number]> = [];
    for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) for (let y = FLAT_GROUND_Y; y <= top; y++) { setBlock(ctx, x, y, z, 'minecraft:stone'); cells.push([x, y, z]); }
    return cells;
  };
  // The pack's own namespace (a rewritten twin's `NS:vpart_0`, sim-namespace.test.ts), never the literal `craftmatic:`.
  const prop = (name: string): string => nsId(pack.namespace, name.replace(/^[^:]+:/, ''));
  /** The vehicle's pose as the runtime's pick reads it: its yaw and its body's leftover lean (`FLIGHT_PROPS`). */
  const poseOf = (v: SimEntity, f: ScriptedTypeFacts): { x: number; y: number; z: number; yaw: number; pitch: number; bank: number; pivot?: number[] } => ({
    ...v.location, yaw: v.rotation.y, pitch: Number(v.properties.get(prop(FLIGHT_PROPS.pitch)) ?? 0) || 0, bank: Number(v.properties.get(prop(FLIGHT_PROPS.bank)) ?? 0) || 0, ...(f.bodyPivot ? { pivot: f.bodyPivot } : {}),
  });
  /**
   * An entity-frame box (x0, y0, z0, x1, y1, z1 at 100 %) in the world at the vehicle's pose: [x0, y0, z0, x1, y1, z1].
   * With `lean`, the body's turn as the drive animation draws it: [-pitch, 0, -bank] about the body pivot, in the
   * geometry JSON's frame (the entity frame mirrored in z, sixteenths), through the drawn geometry's own transform.
   */
  const boxInWorld = (v: SimEntity, b: readonly number[], lean?: { pitch: number; bank: number; pivot?: number[] }): number[] => {
    const k = v.scale(), r = v.rotation.y * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    const pv = lean?.pivot ?? [0, 0, 0];
    const T = lean && (lean.pitch || lean.bank) ? pivotRotation([-lean.pitch, 0, -lean.bank], [pv[0]! * 16, pv[1]! * 16, -pv[2]! * 16]) : undefined;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (const x0 of [b[0]!, b[3]!]) for (const y0 of [b[1]!, b[4]!]) for (const z0 of [b[2]!, b[5]!]) {
      let x = x0, y = y0, z = z0;
      if (T) { const j = [x * 16, y * 16, -z * 16]; x = (T[0]! * j[0]! + T[1]! * j[1]! + T[2]! * j[2]! + T[3]!) / 16; y = (T[4]! * j[0]! + T[5]! * j[1]! + T[6]! * j[2]! + T[7]!) / 16; z = -(T[8]! * j[0]! + T[9]! * j[1]! + T[10]! * j[2]! + T[11]!) / 16; }
      xs.push(v.location.x + (x * c - z * s) * k); ys.push(v.location.y + y * k); zs.push(v.location.z + (x * s + z * c) * k);
    }
    return [Math.min(...xs), Math.min(...ys), Math.min(...zs), Math.max(...xs), Math.max(...ys), Math.max(...zs)];
  };
  type TapSpot = { feet: { x: number; y: number; z: number }; gap: number; aim: { x: number; y: number; z: number } };
  /**
   * Where `who` can stand to tap the world box `b` of vehicle `v` so that the runtime's own pick from that eye and view
   * `means` it: every spot round the box on a free floor (`standsAt`) with the eye within the pick's reach
   * (`REACH_BLOCKS` x the scale above 100 %), aiming at its middle, low on it, or its point nearest the eye; nearest
   * first. The chosen spot is the first whose DEVICE pick (`pick`, a tap's ray) also lands on the vehicle or one of its
   * board points - a tap on nothing raises no event at all (quirk `tap-is-hit`); `who` is left standing there,
   * looking at it. `crowded`: some spot's view meant something else.
   */
  const findTapSpot = async (ctx: StepContext, who: SimEntity, v: SimEntity, b: readonly number[], means: (eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }) => boolean, reachBlocks: number = VEHICLE_PART.REACH_BLOCKS): Promise<{ chosen?: TapSpot; spots: number; crowded: boolean; reach: number }> => {
    const mid = { x: (b[0]! + b[3]!) / 2, y: (b[1]! + b[4]!) / 2, z: (b[2]! + b[5]!) / 2 };
    const reach = reachBlocks * Math.max(1, v.scale()) - 0.1;
    const gapTo = (eye: { x: number; y: number; z: number }): number => Math.hypot(Math.max(b[0]! - eye.x, 0, eye.x - b[3]!), Math.max(b[1]! - eye.y, 0, eye.y - b[4]!), Math.max(b[2]! - eye.z, 0, eye.z - b[5]!));
    const half = Math.max(b[3]! - b[0]!, b[5]! - b[2]!) / 2;
    const spots: TapSpot[] = [];
    let crowded = false;
    for (const out of [0.5, 1, 1.6, 2.4]) for (let a = 0; a < 16; a++) {
      const x = mid.x + Math.cos(a * Math.PI / 8) * (half + out), z = mid.z + Math.sin(a * Math.PI / 8) * (half + out);
      const y = floorBelow(ctx.sim.engine, v.dimension, x, Math.max(v.location.y, mid.y) + 0.5, z, Math.max(4, mid.y - v.location.y + 4));
      if (y === undefined || !standsAt(ctx.sim.engine, v.dimension, { x, y, z })) continue;
      const eye = { x, y: y + PLAYER_EYE, z };
      const g = gapTo(eye);
      if (g > reach) continue;
      const inset = (lo: number, hi: number, q: number): number => Math.max(lo + Math.min(0.05, (hi - lo) / 4), Math.min(hi - Math.min(0.05, (hi - lo) / 4), q));
      const aims = [mid, { x: mid.x, y: inset(b[1]!, b[4]!, b[1]!), z: mid.z }, { x: inset(b[0]!, b[3]!, eye.x), y: inset(b[1]!, b[4]!, eye.y), z: inset(b[2]!, b[5]!, eye.z) }];
      for (const aim of aims) {
        if (!means(eye, { x: aim.x - eye.x, y: aim.y - eye.y, z: aim.z - eye.z })) { crowded = true; continue; }
        spots.push({ feet: { x, y, z }, gap: g, aim });
      }
    }
    spots.sort((p1, p2) => p1.gap - p2.gap);
    const isTarget = (e: SimEntity | undefined): boolean => !!e && (e === v || /_board_\d+$/.test(e.typeId));
    for (const sp of spots) {
      // Where the child really stands a tick later (a body pushed out of a board point is not where it was put).
      teleport(ctx.sim.host, who, sp.feet);
      await ctx.run(1);
      lookAt(who, sp.aim);
      if (means(who.headLocation(), viewDirectionOf(who)) && isTarget(pick(ctx.sim.engine, who).entity)) return { chosen: sp, spots: spots.length, crowded, reach };
    }
    return { spots: spots.length, crowded, reach };
  };
  /** Where a vehicle is boarded for a check on open ground: a boat on a pool of its own (aground it cannot move), anything else on the ground. */
  const onWater = (ctx: StepContext, f: ScriptedTypeFacts, at: { x: number; z: number }): { x: number; z: number; y?: number } => {
    if (f.mode !== 'boat') return at;
    const water = pool(ctx, { x0: Math.floor(at.x - f.noseReach) - 40, x1: Math.ceil(at.x) + 160, z0: Math.floor(at.z - f.halfWidth) - 40, z1: Math.ceil(at.z + f.halfWidth) + 40 }, Math.ceil(f.draft + 2));
    return { ...at, y: water.surface - f.draft };
  };

  return {
    /**
     * Get off on the ground at every wand size (SEAT-05): the vehicle spawned on the flat world, sized by its
     * own `<ns>:size_<pct>` event, the child seated, then the device's SNEAK (the engine's set-down about
     * the seat, quirk `dismount-near-seat`) and whatever the pack's runtime does after it. The child must end on
     * the ground (the core `no-unprotected-fall` judges the fall: Pixel 30l dropped ~9 blocks off the 200 %
     * Milano) and outside the hull (`dismount-in-hull`: within its footprint under its top): `{ type, sizes? }`.
     */
    /**
     * The doors, lids and cupboards a vehicle carries (vehicle-parts.ts, audit A-02), as a child uses them: standing beside
     * each part of the PARKED vehicle, looking at it, a tap opens it (`vehicle-part-opens`) and a second tap closes it;
     * then with the first swinging part open the child climbs in and drives off - it must be shut while the vehicle moves
     * (`vehicle-part-closes-moving`) - gets out where it stopped and opens it again there (`vehicle-part-rides-along`):
     * its drawn leaf (the pack's own geometry posed by its own client animation) must stand where the part's open box is
     * at the vehicle's NEW pose. Uses the placed vehicle when there is one, else spawns one on open ground. `{ type? }`;
     * the totals go to `state.vehicleParts`.
     */
    async vehicleParts(step: AnyStep, ctx: StepContext) {
      const wanted = step['type'] ? [typeOf(step)] : [...types.values()].filter(t => t.parts.length);
      const sum = { parts: 0, opened: 0, unreachable: 0, closedWhileMoving: true, drove: 0, reopenedAfterDrive: false, followed: false };
      const value = (v: SimEntity, i: number): number => Number(v.properties.get(prop(vehiclePartProperty(i))) ?? 0);
      /** Part i's box (closed or open) in the world at the vehicle's pose (with `lean`, turned by the body's lean). */
      const worldBox = (v: SimEntity, part: VehiclePartRuntime, open: boolean, lean?: { pitch: number; bank: number; pivot?: number[] }): number[] => boxInWorld(v, open ? part.open : part.closed, lean);
      /**
       * Stand where a child could tap part i (`findTapSpot`: the runtime's pick means THIS part, the device's pick lands on
       * the vehicle or a board point) and tap. 'unreachable' when no spot is within reach: a vehicle has no floors, so a
       * cupboard high in a 400 % bus is out of reach on foot (the model's size, not a fault of the pick).
       */
      const tapOn = async (v: SimEntity, f: ScriptedTypeFacts, i: number): Promise<'changed' | 'unchanged' | 'unreachable'> => {
        const part = f.parts[i]!, before = value(v, i);
        // An open part answers over its open and closed boxes together (`pickVehiclePart`): the child taps that.
        const shutBox = worldBox(v, part, false), openBox = worldBox(v, part, true);
        const b = before !== 0 ? shutBox.map((q, a) => (a < 3 ? Math.min(q, openBox[a]!) : Math.max(q, openBox[a]!))) : shutBox;
        // The runtime's own tap pick over the parts and the slides (bedrock-vehicle.ts `tapPart`, `pickVehicleTap`).
        const means = (eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): boolean => {
          const m = pickVehicleTap(pickVehiclePart, f.parts, f.slides, poseOf(v, f), v.scale(), eye, dir, f.parts.map((_q, j) => value(v, j) !== 0), false, VEHICLE_PART);
          return !!m && 'part' in m && m.part === i;
        };
        const found = await findTapSpot(ctx, ctx.player, v, b, means);
        if (!found.spots && found.crowded) {
          ctx.violate({ invariant: 'vehicle-part-opens', message: `${f.typeId} part ${i} (${part.noun}): from every spot within reach a tap picks another part first`, evidence: { box: b.map(r3) } });
          return 'unchanged';
        }
        if (!found.spots) {
          ctx.note(`${f.typeId} part ${i} (${part.noun.toLowerCase()} ${part.kind}) at scale ${r3(v.scale())}: out of reach on foot - no floor within ${r3(found.reach)} blocks of it (a vehicle has no floors; its box spans y ${r3(b[1]! - v.location.y)}..${r3(b[4]! - v.location.y)} over the vehicle's base)`);
          return 'unreachable';
        }
        if (!found.chosen) {
          ctx.violate({ invariant: 'vehicle-part-tap-target', message: `${f.typeId} part ${i} (${part.noun}): from the ${found.spots} spot(s) a child can tap it from, the tap lands on neither the vehicle's hit box nor a board point`, evidence: { box: b.map(r3), spots: found.spots } });
          return 'unchanged';
        }
        const r = tap(ctx.sim.engine, ctx.player);
        await ctx.run(12);
        const changed = value(v, i) !== before;
        ctx.note(`${f.typeId} part ${i} (${part.noun.toLowerCase()} ${part.kind}): a tap with the eye ${r3(found.chosen.gap)} blocks off it picked ${r.entity ? r.entity.typeId : r.blockedBy ? `the block ${r.blockedBy}` : 'nothing'}; ${before} -> ${value(v, i)}`);
        return changed ? 'changed' : 'unchanged';
      };
      for (const f of wanted) {
        // The placed vehicle when the scenario placed one, else a fresh one on open ground (the vehicle course).
        let v = findEntity(ctx.sim, ctx.player, { type: f.typeId });
        if (!v) {
          // On open ground beside the child (loaded: the course's own spots are far out), clear of its footprint.
          const at = { x: Math.floor(ctx.player.location.x) + 0.5 + Math.ceil(f.noseReach + f.halfWidth) + 4, y: FLAT_GROUND_Y, z: Math.floor(ctx.player.location.z) + 0.5 };
          v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', at);
          await ctx.run(4);
        }
        for (let i = 0; i < f.parts.length; i++) {
          if (f.parts[i]!.closed.length < 6) continue;
          sum.parts++;
          const got = await tapOn(v, f, i);
          if (got === 'unreachable') { sum.unreachable++; continue; }
          if (got === 'changed') {
            sum.opened++;
            // Back as it was (a turnable keeps its step: it is never "open").
            if (f.parts[i]!.kind !== 'turnable' && (await tapOn(v, f, i)) !== 'changed') ctx.violate({ invariant: 'vehicle-part-opens', message: `${f.typeId} part ${i}: a second tap did not close it`, evidence: { value: value(v, i) } });
          } else ctx.violate({ invariant: 'vehicle-part-opens', message: `${f.typeId} part ${i} (${f.parts[i]!.noun}): a tap beside the parked vehicle did not open it`, evidence: { at: { x: r3(v.location.x), y: r3(v.location.y), z: r3(v.location.z) }, value: value(v, i) } });
        }
        // The first swinging part a child can reach here (by the same search).
        let swing = -1;
        for (let i = 0; i < f.parts.length && swing < 0; i++) if (f.parts[i]!.closes && f.parts[i]!.closed.length >= 6 && (await tapOn(v, f, i)) === 'changed') swing = i;
        if (swing < 0) continue;
        // In, and off down the road.
        const start = { ...v.location };
        await CORE_HANDLERS['hold']!({ kind: 'hold', target: { where: (e: SimEntity) => e === v, label: f.typeId } }, ctx);
        if (ctx.player.ridingOn !== v) { ctx.violate({ invariant: 'tap-boards-ride', message: `a hold on ${f.typeId} with a part open did not mount it`, evidence: { at: start } }); continue; }
        ctx.player.rotation.y = v.rotation.y;
        let shutWhileMoving = true, movingTicks = 0;
        for (let t = 0; t < 60; t++) {
          ctx.sim.controls.set(ctx.player.id, { forward: 1, strafe: 0, jump: false });
          const was = { ...v.location };
          await ctx.run(1);
          // Moving (it went somewhere this tick) for a few ticks: every swinging part must be shut (the runtime closes them
          // on the first tick its speed passes CLOSE_SPEED). A boat on dry land does not move: nothing to judge.
          if (Math.hypot(v.location.x - was.x, v.location.z - was.z) > 0.01) movingTicks++; else continue;
          if (movingTicks > 2 && f.parts.some((p, i) => p.closes && value(v!, i) !== 0)) shutWhileMoving = false;
        }
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
        await ctx.run(40);
        const drove = Math.hypot(v.location.x - start.x, v.location.z - start.z);
        sum.drove = Math.max(sum.drove, r2(drove));
        if (!shutWhileMoving) { sum.closedWhileMoving = false; ctx.violate({ invariant: 'vehicle-part-closes-moving', message: `${f.typeId}: a part stayed open while the vehicle drove`, evidence: { drove: r2(drove) } }); }
        await CORE_HANDLERS['sneak']!({ kind: 'sneak' }, ctx);
        await ctx.run(30);
        // Where it parked: the same tap opens it, and its drawn leaf stands at the part's open box there. A vehicle that never
        // moved (a boat on land) kept it open: the tap closes it first.
        if (!movingTicks) { ctx.note(`${f.typeId}: did not move off (${r2(drove)} blocks): the part stayed as it was`); if (value(v, swing) !== 0) await tapOn(v, f, swing); }
        const reopened = await tapOn(v, f, swing);
        const again = reopened === 'changed';
        if (again) sum.reopenedAfterDrive = true;
        else if (reopened === 'unreachable') ctx.note(`${f.typeId}: where it parked, part ${swing} is out of reach on foot`);
        else ctx.violate({ invariant: 'vehicle-part-rides-along', message: `${f.typeId}: after a ${r2(drove)}-block drive a tap beside part ${swing} did not open it`, evidence: { at: v.location } });
        const entry = registeredAppearance(pack.pack)?.byType.get(f.typeId);
        if (entry && again) {
          // The part's own swing WITH the body's lean the vehicle parked in (fl_pitch / fl_bank): the runtime's pick
          // follows the lean (`pickVehiclePart` pose pitch/bank), so the drawn leaf must stand in the part's open box
          // turned by it.
          const props: Record<string, number | boolean | string> = { ...Object.fromEntries(v.properties) };
          const closedProps = { ...props, [prop(vehiclePartProperty(swing))]: 0 };
          const set = registeredAppearance(pack.pack)?.animations?.get(f.typeId);
          const shut = drawnBoxes(entry, v.location, v.rotation.y, v.scale(), 'near', animatedPoses(set, closedProps));
          const open = drawnBoxes(entry, v.location, v.rotation.y, v.scale(), 'near', animatedPoses(set, props));
          // The cubes that moved when it opened are the part's: their union must be the part's open box at this pose.
          const moved = open.filter((d, j) => { const q = shut[j]?.box; return !!q && Math.abs(q.x0 - d.box.x0) + Math.abs(q.y0 - d.box.y0) + Math.abs(q.z0 - d.box.z0) > 1e-3; });
          const want = worldBox(v, f.parts[swing]!, true, poseOf(v, f));
          const got = moved.length ? [Math.min(...moved.map(d => d.box.x0)), Math.min(...moved.map(d => d.box.y0)), Math.min(...moved.map(d => d.box.z0)), Math.max(...moved.map(d => d.box.x1)), Math.max(...moved.map(d => d.box.y1)), Math.max(...moved.map(d => d.box.z1))] : [];
          // Every cube that moved stands inside the part's open box there (a cube ON the hinge line keeps its box and
          // is not among them, so the union may be smaller than the box, never outside it).
          const off = got.length ? Math.max(0, ...[0, 1, 2].map(a => want[a]! - got[a]!), ...[3, 4, 5].map(a => got[a]! - want[a]!)) : Infinity;
          const slack = 0.05 * Math.max(1, v.scale());
          sum.followed = off <= slack;
          ctx.note(`${f.typeId} part ${swing}: ${moved.length} drawn cubes swung open where it parked; they reach ${r3(off)} blocks outside the part's open box at the vehicle's pose`);
          if (!sum.followed) ctx.violate({ invariant: 'vehicle-part-rides-along', message: `${f.typeId}: part ${swing}'s drawn leaf reaches ${r3(off)} blocks outside where the runtime picks it after the drive (${moved.length} cubes moved)`, evidence: { want: want.map(r3), got: got.map(r3) } });
        }
        // Shut again for the steps after.
        if (value(v, swing) !== 0) await tapOn(v, f, swing);
      }
      ctx.state['vehicleParts'] = sum;
    },

    /**
     * The slides a scripted vehicle carries (vehicle-parts.ts `VehicleSlideRuntime`), as a child uses them: standing
     * beside the PARKED vehicle, a tap on the slide seats the child at its top and slides them down the chute the
     * vehicle draws (`slide-rides-in-chute`, the building slide's limit), sets them down standing (`rider-set-down`) and
     * leaves no seat behind; then the child drives off, and a second child's tap on the slide of the MOVING vehicle is
     * refused with a line saying why (`vehicle-slide-refused-moving`); where it parks, the same tap rides the slide from
     * the vehicle's NEW pose (`vehicle-slide-follows`). `{ type? }`; the totals go to `state.vehicleSlides`.
     */
    async vehicleSlides(step: AnyStep, ctx: StepContext) {
      const wanted = step['type'] ? [typeOf(step)] : [...types.values()].filter(t => t.slides.length);
      const sum = { slides: 0, rode: 0, unreachable: 0, refusedMoving: false, rodeAfterDrive: false, drove: 0, seatsLeft: 0, worstOverDrawn: -Infinity };
      const seatType = pack.rides?.seatType;
      if (!seatType) { if (wanted.length) ctx.violate({ invariant: 'vehicle-slide-rides', message: 'a vehicle carries a slide but the pack ships no ride seat (scripts/rides.js)', evidence: {} }); ctx.state['vehicleSlides'] = sum; return; }
      const appearance = registeredAppearance(pack.pack);
      const ownerKey = prop('craftmatic:ride_owner'), pathKey = prop('craftmatic:ride_path');
      const vehicleSeats = (v: SimEntity): SimEntity[] => ctx.sim.engine.loadedEntities(v.dimension).filter(e => e.typeId === seatType && e.dynamic.get(ownerKey) === v.id);
      /** The runtime's pick over a vehicle's parts and slides (parked) or its slides alone (moving), as `tapPart`. */
      const means = (v: SimEntity, f: ScriptedTypeFacts, j: number, moving: boolean) => (eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): boolean => {
        const open = f.parts.map((_q, i) => Number(v.properties.get(prop(vehiclePartProperty(i))) ?? 0) !== 0);
        const m = pickVehicleTap(pickVehiclePart, f.parts, f.slides, poseOf(v, f), v.scale(), eye, dir, open, moving, VEHICLE_PART);
        return !!m && 'slide' in m && m.slide === j;
      };
      /** Ride slide j of the parked vehicle from a tap: 'rode', 'unreachable' (no spot on foot), or 'failed' (violated). */
      const rideOne = async (v: SimEntity, f: ScriptedTypeFacts, j: number): Promise<'rode' | 'unreachable' | 'failed'> => {
        const slide = f.slides[j]!, k = v.scale();
        const b = boxInWorld(v, slide.box, poseOf(v, f));
        // A slide is ridden from as far as the child sees it along the view ray (`SLIDE_REACH_BLOCKS`): a roof slide from the ground.
        const found = await findTapSpot(ctx, ctx.player, v, b, means(v, f, j, false), VEHICLE_PART.SLIDE_REACH_BLOCKS);
        if (!found.spots) { ctx.note(`${f.typeId} slide ${j}: out of reach on foot at scale ${r3(k)} (no floor within ${r3(found.reach)} blocks of its box)`); return 'unreachable'; }
        if (!found.chosen) { ctx.violate({ invariant: 'vehicle-part-tap-target', message: `${f.typeId} slide ${j}: from the ${found.spots} spot(s) a child can tap it from, the tap lands on neither the vehicle's hit box nor a board point`, evidence: { box: b.map(r3) } }); return 'failed'; }
        // Where the runtime should start it: the path turned to where the vehicle stands NOW.
        const want = vehicleSlideWorldPath(slide.path, { ...v.location, yaw: v.rotation.y }, k);
        tap(ctx.sim.engine, ctx.player);
        for (let t = 0; t < 20 && ctx.player.ridingOn?.typeId !== seatType; t++) await ctx.run(1);
        const seat = ctx.player.ridingOn;
        if (!seat || seat.typeId !== seatType) { ctx.violate({ invariant: 'tap-boards-ride', message: `${f.typeId} slide ${j}: a tap beside the parked vehicle boarded ${seat ? seat.typeId : 'nothing'}`, evidence: { at: { x: r3(v.location.x), y: r3(v.location.y), z: r3(v.location.z) } } }); return 'failed'; }
        let path: Array<{ x: number; y: number; z: number }> = [];
        try { path = JSON.parse(String(seat.dynamic.get(pathKey))); } catch { path = []; }
        const off = path.length ? Math.hypot(path[0]!.x - want[0]!.x, path[0]!.y - want[0]!.y, path[0]!.z - want[0]!.z) : Infinity;
        if (!(off <= 0.05 * Math.max(1, k))) ctx.violate({ invariant: 'vehicle-slide-follows', message: `${f.typeId} slide ${j}: the seat's path starts ${r3(off)} blocks from the slide's top where the vehicle stands`, evidence: { want: want[0], got: path[0] } });
        const runout = path.length >= 2 && Math.abs(path[path.length - 1]!.y - path[path.length - 2]!.y) < 1e-6 ? { foot: path[path.length - 2]!, end: path[path.length - 1]! } : undefined;
        let worst = -Infinity, ticks = 0, reported = false;
        for (; ticks < 600 && ctx.player.ridingOn === seat; ticks++) {
          await ctx.run(1);
          if (!appearance || (runout && onRunout(seat.location, runout))) continue;
          const h = heightOverDrawn(entityDrawn(appearance, v) ?? [], seat.location, 0);
          if (h === undefined) continue;
          worst = Math.max(worst, h);
          if (!reported && h > SLIDE_SEAT_OVER_DRAWN * Math.max(1, k) && (reported = true)) ctx.violate({ invariant: 'slide-rides-in-chute', message: `${f.typeId} slide ${j}: the rider runs ${r3(h)} blocks over the chute the vehicle draws`, evidence: { seat: seat.location, over: r3(h) } });
        }
        sum.worstOverDrawn = Math.max(sum.worstOverDrawn, r3(worst));
        const y0 = ctx.player.location.y;
        await ctx.run(20);
        if (!ctx.player.ridingOn && y0 - ctx.player.location.y > 1) ctx.violate({ invariant: 'rider-set-down', message: `${f.typeId} slide ${j}: the player dropped ${r3(y0 - ctx.player.location.y)} blocks from where the slide set it down`, evidence: { at: ctx.player.location } });
        ctx.note(`${f.typeId} slide ${j}: rode ${ticks} ticks from a tap ${r3(found.chosen.gap)} blocks off it; the seat ran at most ${r3(worst)} blocks over the drawn chute; set down at ${JSON.stringify({ x: r3(ctx.player.location.x), y: r3(ctx.player.location.y), z: r3(ctx.player.location.z) })}`);
        if (ctx.player.ridingOn) { ctx.violate({ invariant: 'rider-set-down', message: `${f.typeId} slide ${j}: after ${ticks} ticks the child rides ${ctx.player.ridingOn.typeId}, not set down`, evidence: {} }); return 'failed'; }
        return 'rode';
      };
      for (const f of wanted) {
        let v = findEntity(ctx.sim, ctx.player, { type: f.typeId });
        if (!v) {
          const at = { x: Math.floor(ctx.player.location.x) + 0.5 + Math.ceil(f.noseReach + f.halfWidth) + 4, y: FLAT_GROUND_Y, z: Math.floor(ctx.player.location.z) + 0.5 };
          v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', at);
          await ctx.run(4);
        }
        let first = -1;
        for (let j = 0; j < f.slides.length; j++) {
          sum.slides++;
          const got = await rideOne(v, f, j);
          if (got === 'rode') { sum.rode++; if (first < 0) first = j; } else if (got === 'unreachable') sum.unreachable++;
        }
        await ctx.run(5);
        sum.seatsLeft += vehicleSeats(v).length;
        if (first < 0) continue;
        // In, off down the road; a second child beside it taps the slide while it moves.
        const start = { ...v.location };
        await CORE_HANDLERS['hold']!({ kind: 'hold', target: { where: (e: SimEntity) => e === v, label: f.typeId } }, ctx);
        if (ctx.player.ridingOn !== v) { ctx.violate({ invariant: 'tap-boards-ride', message: `a hold on ${f.typeId} did not mount it`, evidence: { at: start } }); continue; }
        ctx.player.rotation.y = v.rotation.y;
        const watcher = ctx.sim.addPlayer('Watcher', { x: start.x, y: FLAT_GROUND_Y, z: start.z + 30 });
        let movingTicks = 0, tried = false;
        for (let t = 0; t < 60; t++) {
          ctx.sim.controls.set(ctx.player.id, { forward: 1, strafe: 0, jump: false });
          const was = { ...v.location };
          await ctx.run(1);
          if (Math.hypot(v.location.x - was.x, v.location.z - was.z) > 0.01) movingTicks++;
          if (tried || movingTicks < 6) continue;
          // Beside the moving slide, looking at it, in this one tick: the runtime must refuse it and say so.
          const b = boxInWorld(v, f.slides[first]!.box), mid = { x: (b[0]! + b[3]!) / 2, y: (b[1]! + b[4]!) / 2, z: (b[2]! + b[5]!) / 2 };
          const half = Math.max(b[3]! - b[0]!, b[5]! - b[2]!) / 2;
          for (let a = 0; a < 16 && !tried; a++) for (const out of [0.4, 0.9]) {
            const feet = { x: mid.x + Math.cos(a * Math.PI / 8) * (half + out), y: FLAT_GROUND_Y, z: mid.z + Math.sin(a * Math.PI / 8) * (half + out) };
            if (!standsAt(ctx.sim.engine, v.dimension, feet)) continue;
            teleport(ctx.sim.host, watcher, feet);
            lookAt(watcher, mid);
            if (!means(v, f, first, true)(watcher.headLocation(), viewDirectionOf(watcher))) continue;
            const hit = pick(ctx.sim.engine, watcher).entity;
            if (hit !== v) continue;
            const since = ctx.sim.engine.timeline.entries.length;
            tap(ctx.sim.engine, watcher);
            await ctx.run(6);
            const said = ctx.sim.engine.timeline.entries.slice(since).some(e => e.kind === 'actionbar' && /parked/.test(String(e.text)));
            sum.refusedMoving = !watcher.ridingOn && !vehicleSeats(v).length && said;
            if (!sum.refusedMoving) ctx.violate({ invariant: 'vehicle-slide-refused-moving', message: `${f.typeId}: a tap on its slide while it drove ${watcher.ridingOn ? `seated the child on ${watcher.ridingOn.typeId}` : said ? 'left a seat behind' : 'said nothing'}`, evidence: { at: feet } });
            tried = true;
            break;
          }
        }
        if (!tried) ctx.note(`${f.typeId}: no spot beside its moving slide where a tap lands on it; the moving refusal was not tested`);
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false });
        await ctx.run(40);
        sum.drove = Math.max(sum.drove, r2(Math.hypot(v.location.x - start.x, v.location.z - start.z)));
        await CORE_HANDLERS['sneak']!({ kind: 'sneak' }, ctx);
        await ctx.run(30);
        // Where it parked: the same tap rides the slide from there.
        if (sum.drove > 1) sum.rodeAfterDrive = (await rideOne(v, f, first)) === 'rode';
        await ctx.run(5);
        sum.seatsLeft += vehicleSeats(v).length;
      }
      ctx.state['vehicleSlides'] = sum;
    },

    async dismountEverySize(step: AnyStep, ctx: StepContext) {
      if (typeOf(step).mode === 'boat') { ctx.note(`${typeOf(step).typeId} is a boat: its egress runs on water (waterEgress)`); return; }
      const f = typeOf(step);
      const sizes = (step['sizes'] as number[] | undefined) ?? [100, 200, 400];
      const rows: Array<{ pct: number; seatedY: number; end: { x: number; y: number; z: number }; inHull: boolean; lowest: number }> = [];
      for (const [i, pct] of sizes.entries()) {
        const at = { x: 400.5 + i * 200, z: -600.5 };
        const v = await board(ctx, f, at);
        v.triggerEvent(sizeEventOf(v.typeId, pct));
        v.placeRiders();
        await ctx.run(4);
        const k = v.scale(), seatedY = r2(ctx.player.location.y - FLAT_GROUND_Y);
        // From here every core check runs: the fall off the seat, the body in a block, under the ground.
        ctx.quiet([]);
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: true });
        await ctx.run(1);
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: false });
        let lowest = Infinity;
        for (let t = 0; t < 80; t++) { await ctx.run(1); lowest = Math.min(lowest, ctx.player.location.y); }
        const p = ctx.player.location, r = v.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
        const dx = p.x - v.location.x, dz = p.z - v.location.z;
        const inHull = Math.abs(dx * fx + dz * fz) < f.noseReach * k && Math.abs(dx * rx + dz * rz) < f.halfWidth * k && p.y < v.location.y + f.height * k;
        const row = { pct, seatedY, end: { x: r2(dx), y: r2(p.y - FLAT_GROUND_Y), z: r2(dz) }, inHull, lowest: r2(lowest - FLAT_GROUND_Y) };
        rows.push(row);
        ctx.note(`${f.typeId} at ${pct} %: seated feet ${seatedY} over the ground; after a sneak the child stands at ${JSON.stringify(row.end)} from the vehicle (${inHull ? 'INSIDE the hull' : 'outside the hull'}), lowest ${row.lowest}${ctx.player.ridingOn ? ' - STILL RIDING' : ''}`);
        if (ctx.player.ridingOn) ctx.violate({ invariant: 'dismount-in-hull', message: `${f.typeId} at ${pct} %: a sneak did not get the child off`, evidence: row });
        else if (inHull) ctx.violate({ invariant: 'dismount-in-hull', message: `${f.typeId} at ${pct} %: the child got off INSIDE the hull, at ${JSON.stringify(row.end)} from its origin (footprint ${r2(f.noseReach * k)} x ${r2(f.halfWidth * k)}, ${r2(f.height * k)} tall)`, evidence: row });
        if (ctx.player.ridingOn) v.removeRider(ctx.player);
        ctx.sim.engine.removeEntity(v);
        await ctx.run(2);
      }
      ctx.state['dismount'] = { ...((ctx.state['dismount'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: rows };
    },

    /** Drive into every course obstacle holding the stick forward (and Jump, `policy: 'forward+jump'`): `{ type, obstacles?, policy? }`. */
    async stuckCourse(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      const policy = step['policy'] === 'forward+jump' ? 'forward+jump' : 'forward';
      const jump = policy === 'forward+jump';
      const only = step['obstacles'] as CourseObstacle[] | undefined;
      const w = ctx.sim.engine.dimension('overworld');
      const stone = ctx.sim.host.resolvePermutation('minecraft:stone'), air = ctx.sim.host.resolvePermutation('minecraft:air');
      // Lanes far enough apart that a vehicle stepped round the END of one lane's obstacle (its half width past the
      // obstacle's edge) never meets the next lane's: the Milano (30 wide) slid into the tree lane at 2W + 24.
      const laneGap = Math.ceil(4 * f.halfWidth) + 24;
      const rows: CourseRow[] = [];
      let lane = 0;
      const band = bandOf(f);
      for (const o of COURSE_OBSTACLES) {
        if (only && !only.includes(o)) continue;
        lane++;
        const z0 = 200 + lane * laneGap, x0 = 100;
        const start = { x: x0 + 0.5, z: z0 + 0.5 };
        const skew = OBSTACLE_SKEW_DEG[o] ?? 0, skewRad = skew * Math.PI / 180;
        // The obstacle starts 4 blocks past the footprint's furthest reach along the lane: turned `skew`, a wide
        // ship's near corner reaches past its nose (the Milano, 30 wide at 19 degrees: 12.5 for a nose of 8).
        const sx = Math.floor(start.x + f.noseReach * Math.cos(skewRad) + f.halfWidth * Math.sin(skewRad)) + 4;
        const { solid, dig, length } = obstacleCells(o, f);
        const cells = solid.map(([x, y, z]) => [sx + x, FLAT_GROUND_Y + y, z0 + z] as [number, number, number]);
        for (const c of cells) w.setPermutation(c[0], c[1], c[2], stone);
        for (const [x, y, z] of dig) w.setPermutation(sx + x, FLAT_GROUND_Y + y, z0 + z, air);
        const v = await board(ctx, f, start, skew);
        const passX = sx + length + f.noseReach + 1;
        let t = 0, stuck = 0, clip = 0, last = { ...v.location }, rose = 0;
        let firstClip: CourseRow['firstClip'];
        const every = Number(step['trace'] ?? 0), trace: Array<[number, number, number]> = [];
        for (; t < COURSE_PUSH_TICKS && v.location.x < passX && ctx.player.ridingOn === v; t++) {
          hold(ctx, { forward: 1, jump });
          await ctx.run(1);
          if (every > 0 && t % every === 0) trace.push([r2(v.location.x - sx), r2(v.location.y - FLAT_GROUND_Y), r2(v.location.z - z0)]);
          if (Math.hypot(v.location.x - last.x, v.location.z - last.z) < 0.01) stuck++;
          rose = Math.max(rose, v.location.y - FLAT_GROUND_Y);
          const hit = cells.find(c => bandOverlaps(v, f, band.lo, band.hi, c));
          if (hit) { clip++; firstClip ??= { t, x: r2(v.location.x - sx), y: r2(v.location.y - FLAT_GROUND_Y), pitch: r2(Number(v.properties.get(entityKey(v.typeId, 'fl_pitch')) ?? 0)), cell: [hit[0] - sx, hit[1] - FLAT_GROUND_Y, hit[2] - z0] }; }
          last = { ...v.location };
        }
        const passed = v.location.x >= passX;
        // Across the lane beyond the heading's own drift (tan skew of the progress): a sidestep along a wall.
        const side = (v.location.z - start.z) - (v.location.x - start.x) * Math.tan(skew * Math.PI / 180);
        const row: CourseRow = { vehicle: f.typeId, mode: f.mode, obstacle: o, policy, passed, ticks: t, stuckTicks: stuck, rose: r2(rose), clipTicks: clip, side: r2(side), ...(firstClip ? { firstClip } : {}), ...(trace.length ? { trace } : {}) };
        if (!passed) {
          // The child backs off, turns right on the spot, and drives away.
          const from = { ...v.location };
          hold(ctx, { forward: -1 }); await ctx.run(30);
          hold(ctx, { strafe: -1 }); await ctx.run(45);
          hold(ctx, { forward: 1 }); await ctx.run(60);
          row.escaped = Math.hypot(v.location.x - from.x, v.location.z - from.z) >= 3;
        }
        hold(ctx, {});
        rows.push(row);
        // Holding Jump on a ship flies it up and away: the second run is a measurement, not a requirement.
        const mayBlock = jump || (f.mode !== 'plane' && GROUND_MAY_BLOCK.has(o));
        if (!passed && !mayBlock) ctx.violate({ invariant: 'vehicle-not-stuck', message: `${f.typeId} (${f.mode}) did not get past the ${o} holding the stick forward for ${t} ticks (${stuck} of them without moving)`, evidence: { ...row } });
        // A ship goes OVER what it meets; one that got past by running along the obstacle's face to its end (the
        // Saga's X-wing: 13-50 blocks along a hill, never lifting) did not, passed or not.
        if (f.mode === 'plane' && !jump && Math.abs(side) >= SLIDE_ALONG_BLOCKS) ctx.violate({ invariant: 'ship-slides-along', message: `${f.typeId} ran ${r2(side)} blocks along the ${o} instead of lifting over it (rose ${r2(rose)})`, evidence: { ...row } });
        if (!passed && !jump && row.escaped === false && o !== 'pit3') ctx.violate({ invariant: 'vehicle-escapes', message: `${f.typeId} stopped at the ${o} and could not back, turn and drive away`, evidence: { ...row } });
        if (clip > 0) ctx.violate({ invariant: 'vehicle-no-clip', message: `${f.typeId}'s clear band went into the ${o} on ${clip} ticks`, evidence: { ...row } });
        v.removeRider(ctx.player);
        ctx.sim.engine.removeEntity(v);
        await ctx.run(2);
      }
      ctx.state['course'] = [...((ctx.state['course'] as CourseRow[] | undefined) ?? []), ...rows];
      ctx.note(`${f.typeId} (${policy}): ${rows.filter(r => r.passed).length} of ${rows.length} obstacles passed; ${rows.map(r => `${r.obstacle} ${r.passed ? `in ${r.ticks}` : `STOP (${r.stuckTicks} stuck${r.escaped === undefined ? '' : r.escaped ? ', escaped' : ', trapped'})`}${r.clipTicks ? ` CLIP ${r.clipTicks}` : ''}`).join(', ')}`);
    },

    /**
     * The water lanes (`WATER_LANES`): the boat spawned afloat in each lane's pool, the child seated, the stick held
     * forward `COURSE_PUSH_TICKS`. Per lane a `CourseRow` (into `state.course`, beside the land rows): `{ type, lanes? }`.
     *   water-flat     it makes `WATER_AHEAD_BLOCKS` and stays on its waterline (`boat-not-afloat`);
     *   water-bank     it stops at the waterline - the bow at the bank's face, never risen onto it (`boat-climbs-bank`) -
     *                  and backs off (`vehicle-escapes`);
     *   water-shallow  measured: how far it got and how deep its keel would sit in the bed (a note, no rule yet);
     *   water-wall     never through the post (`vehicle-no-clip`); stopped, it backs and turns away (`vehicle-escapes`).
     */
    async boatCourse(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      if (f.mode !== 'boat') { ctx.note(`${f.typeId} is a ${f.mode}: no water lanes`); return; }
      const only = step['lanes'] as WaterLane[] | undefined;
      const band = bandOf(f), laneGap = Math.ceil(4 * f.halfWidth) + 30, depth = Math.ceil(f.draft + 2);
      const rows: CourseRow[] = [];
      let lane = 0;
      for (const o of WATER_LANES) {
        if (only && !only.includes(o)) continue;
        lane++;
        const z0 = -1200 - lane * laneGap, x0 = 100;
        const start = { x: x0 + 0.5, z: z0 + 0.5 };
        const skew = o === 'water-wall' ? OBSTACLE_SKEW_DEG.oblique ?? 0 : 0, skewRad = skew * Math.PI / 180;
        const across = Math.ceil(f.halfWidth) + 10;
        const sx = Math.floor(start.x + f.noseReach * Math.cos(skewRad) + f.halfWidth * Math.sin(skewRad)) + 4;
        // The pool: from behind the stern to well past the push, a bank's lane ends at the bank.
        const end = o === 'water-bank' ? sx + 4 : x0 + 160;
        const water = pool(ctx, { x0: Math.floor(x0 - f.noseReach) - 6, x1: end - 1, z0: z0 - across, z1: z0 + across + (o === 'water-wall' ? 60 : 0) }, o === 'water-shallow' ? depth + 1 : depth, o === 'water-shallow' ? depth : 0);
        const cells: Array<[number, number, number]> = [];
        if (o === 'water-bank') cells.push(...bank(ctx, { x0: end, x1: end + 12, z0: z0 - across, z1: z0 + across }, water.yTop + 1));
        if (o === 'water-wall') {
          // A pier post a little inside the hull's +z side (a corner meets it), from the pool's bed to 6 over the water.
          const tz = z0 + Math.floor(Math.max(0, f.halfWidth - 0.35));
          for (let y = FLAT_GROUND_Y; y <= water.yTop + 6; y++) { setBlock(ctx, sx, y, tz, 'minecraft:stone'); cells.push([sx, y, tz]); }
        }
        const line = water.surface - f.draft;
        const v = await board(ctx, f, { ...start, y: line }, skew);
        // Past the post (the wall lane), or `WATER_AHEAD_BLOCKS` made (open water, the channel); a bank lane pushes the whole time.
        const passX = o === 'water-wall' ? sx + 1 + f.noseReach + 1 : o === 'water-bank' ? Infinity : start.x + WATER_AHEAD_BLOCKS;
        let t = 0, stuck = 0, clip = 0, rose = 0, off = 0, last = { ...v.location }, keel = 0;
        let firstClip: CourseRow['firstClip'];
        for (; t < COURSE_PUSH_TICKS && v.location.x < passX && ctx.player.ridingOn === v; t++) {
          hold(ctx, { forward: 1 });
          await ctx.run(1);
          if (Math.hypot(v.location.x - last.x, v.location.z - last.z) < 0.01) stuck++;
          rose = Math.max(rose, v.location.y - line);
          off = Math.max(off, Math.abs(v.location.y - line));
          keel = Math.max(keel, water.bed - (v.location.y));
          const hit = cells.find(c => bandOverlaps(v, f, band.lo, band.hi, c));
          if (hit) { clip++; firstClip ??= { t, x: r2(v.location.x - sx), y: r2(v.location.y - line), pitch: r2(Number(v.properties.get(entityKey(v.typeId, 'fl_pitch')) ?? 0)), cell: [hit[0] - sx, hit[1] - FLAT_GROUND_Y, hit[2] - z0] }; }
          last = { ...v.location };
        }
        const ahead = (v.location.x - start.x) / Math.max(1e-6, Math.cos(skewRad));
        const side = (v.location.z - start.z) - (v.location.x - start.x) * Math.tan(skewRad);
        const pastBank = r2(v.location.x + f.noseReach - end);
        const passed = o === 'water-bank' ? pastBank <= BANK_SLACK && rose < 0.5 : o === 'water-wall' ? v.location.x >= passX : ahead >= WATER_AHEAD_BLOCKS;
        const row: CourseRow = { vehicle: f.typeId, mode: f.mode, obstacle: o, policy: 'forward', passed, ticks: t, stuckTicks: stuck, rose: r2(rose), clipTicks: clip, side: r2(side), offWaterline: r2(off), ...(firstClip ? { firstClip } : {}),
          ...(o === 'water-shallow' ? { keelInBed: r2(Math.max(0, keel)) } : {}), ...(o === 'water-bank' ? { pastBank } : {}) };
        if (o === 'water-bank' || (o === 'water-wall' && !passed)) {
          // Back off (and for the post, turn and go): it must get 0.3 / 3 blocks away.
          const from = { ...v.location };
          hold(ctx, { forward: -1 }); await ctx.run(40);
          if (o === 'water-wall') { hold(ctx, { strafe: -1 }); await ctx.run(45); hold(ctx, { forward: 1 }); await ctx.run(60); }
          row.escaped = Math.hypot(v.location.x - from.x, v.location.z - from.z) >= (o === 'water-bank' ? 0.3 : 3);
        }
        hold(ctx, {});
        rows.push(row);
        if (o === 'water-flat' && off > WATERLINE_SLACK) ctx.violate({ invariant: 'boat-not-afloat', message: `${f.typeId} on open water strayed ${r2(off)} blocks from its waterline (at most ${WATERLINE_SLACK})`, evidence: { ...row } });
        if (o === 'water-flat' && !passed) ctx.violate({ invariant: 'boat-not-afloat', message: `${f.typeId} made only ${r2(ahead)} blocks ahead on open water in ${t} ticks (needs ${WATER_AHEAD_BLOCKS})`, evidence: { ...row } });
        if (o === 'water-bank' && !passed) ctx.violate({ invariant: 'boat-climbs-bank', message: `${f.typeId} driven at a bank ${rose >= 0.5 ? `rose ${r2(rose)} blocks onto it` : `ran ${pastBank} blocks past its face`} (it must stop at the waterline)`, evidence: { ...row } });
        if (row.escaped === false) ctx.violate({ invariant: 'vehicle-escapes', message: `${f.typeId} stopped at the ${o} and could not back${o === 'water-wall' ? ', turn and drive' : ''} away`, evidence: { ...row } });
        if (clip > 0) ctx.violate({ invariant: 'vehicle-no-clip', message: `${f.typeId}'s clear band went into the ${o === 'water-bank' ? 'bank' : 'pier post'} on ${clip} ticks`, evidence: { ...row } });
        if (o === 'water-shallow') ctx.note(`${f.typeId} in a one-block channel: ${passed ? `made way, ${r2(ahead)} blocks` : `made only ${r2(ahead)} blocks`}; its keel (draft ${r2(f.draft)}) would sit ${row.keelInBed} blocks in the bed`);
        v.removeRider(ctx.player);
        ctx.sim.engine.removeEntity(v);
        await ctx.run(2);
      }
      ctx.state['course'] = [...((ctx.state['course'] as CourseRow[] | undefined) ?? []), ...rows];
      ctx.note(`${f.typeId} water lanes: ${rows.map(r => `${r.obstacle} ${r.passed ? 'pass' : 'FAIL'} (${r.ticks}t, off waterline ${r.offWaterline}${r.pastBank !== undefined ? `, bow ${r.pastBank} past the bank` : ''}${r.keelInBed !== undefined ? `, keel ${r.keelInBed} in the bed` : ''}${r.clipTicks ? `, CLIP ${r.clipTicks}` : ''}${r.escaped === undefined ? '' : r.escaped ? ', backed off' : ', TRAPPED'})`).join(', ')}`);
    },

    /**
     * Getting off a boat on the water at every wand size (SEAT-05 "water"): the boat afloat in a pool as deep as its
     * draft at the size needs, sized by its own `<ns>:size_<pct>` event, the child seated, then the device's
     * sneak and whatever the runtime's egress does (`vehicleEgress`: a bank beside the hull, else a swim at the
     * waterline). Twice per size: on OPEN water, and with a bank a block beside the hull's +z side. The child must
     * never end under (or in) the hull (`water-egress-under-hull`); where it ended - on the bank, swimming, aboard -
     * is recorded (`state.waterEgress`): `{ type, sizes? }`.
     */
    async waterEgress(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      if (f.mode !== 'boat') { ctx.note(`${f.typeId} is a ${f.mode}: no water egress`); return; }
      const sizes = (step['sizes'] as number[] | undefined) ?? [100, 200, 400];
      const rows: Array<{ pct: number; where: 'open' | 'bank'; end: { x: number; y: number; z: number }; underHull: boolean; onBank: boolean; swimming: boolean; riding: boolean }> = [];
      let i = 0;
      for (const pct of sizes) for (const where of ['open', 'bank'] as const) {
        const k = pct / 100, reach = f.noseReach * k, half = f.halfWidth * k;
        const at = { x: 400.5 + (i % 2) * 300, z: -2400.5 - Math.floor(i / 2) * 300 };
        i++;
        const water = pool(ctx, { x0: Math.floor(at.x - reach) - 10, x1: Math.ceil(at.x + reach) + 10, z0: Math.floor(at.z - half) - 10, z1: Math.ceil(at.z + half) + 10 }, Math.ceil(f.draft * k + 3));
        const shoreZ = Math.ceil(at.z + half) + 1;
        if (where === 'bank') bank(ctx, { x0: Math.floor(at.x - reach) - 10, x1: Math.ceil(at.x + reach) + 10, z0: shoreZ, z1: shoreZ + 8 }, water.yTop + 1);
        const v = await board(ctx, f, { ...at, y: water.surface - f.draft });
        v.triggerEvent(sizeEventOf(v.typeId, pct));
        v.placeRiders();
        await ctx.run(10);
        ctx.quiet([]);
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: true });
        await ctx.run(1);
        ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0, jump: false, sneak: false });
        await ctx.run(60);
        const p = ctx.player.location, r = v.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
        const dx = p.x - v.location.x, dz = p.z - v.location.z;
        const inFootprint = Math.abs(dx * fx + dz * fz) < reach - 0.05 && Math.abs(dx * rx + dz * rz) < half - 0.05;
        const hullTop = v.location.y + f.height * k;
        const box = { x0: p.x - PLAYER_WIDTH / 2, y0: p.y, z0: p.z - PLAYER_WIDTH / 2, x1: p.x + PLAYER_WIDTH / 2, y1: p.y + PLAYER_HEIGHT, z1: p.z + PLAYER_WIDTH / 2 };
        const swimming = submersion(ctx.sim.engine.dimension('overworld'), box) > 0;
        const row = { pct, where, end: { x: r2(dx), y: r2(p.y - water.surface), z: r2(dz) }, underHull: !ctx.player.ridingOn && inFootprint && p.y < hullTop, onBank: !swimming && ctx.player.onGround && p.y >= water.yTop + 2 - 0.05, swimming, riding: !!ctx.player.ridingOn };
        rows.push(row);
        ctx.note(`${f.typeId} at ${pct} % (${where} water): after a sneak the child is ${row.riding ? 'STILL ABOARD' : row.underHull ? 'UNDER THE HULL' : row.onBank ? 'on the bank' : row.swimming ? 'swimming beside the hull' : 'standing'} at ${JSON.stringify(row.end)} from the boat (y from the surface)`);
        if (row.underHull) ctx.violate({ invariant: 'water-egress-under-hull', message: `${f.typeId} at ${pct} % (${where} water): the child got off under the hull, at ${JSON.stringify(row.end)} from its origin (footprint ${r2(reach)} x ${r2(half)})`, evidence: row });
        if (row.riding) { ctx.violate({ invariant: 'dismount-in-hull', message: `${f.typeId} at ${pct} % (${where} water): a sneak did not get the child off`, evidence: row }); v.removeRider(ctx.player); }
        ctx.sim.engine.removeEntity(v);
        await ctx.run(2);
      }
      ctx.state['waterEgress'] = { ...((ctx.state['waterEgress'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: rows };
    },

    /**
     * A boat afloat where the DRAWN hull sits (regression `ship-floats-29b`): in a pool `depth` blocks deep (default:
     * its draft + 2), the drawn hull's lowest point against the water's surface at rest, then 3 s of stick forward:
     * how far it went and how far it strayed from its waterline (`state.boatFloat`). Needs the pack's appearance
     * (`registerAppearance`): `{ type, depth? }`.
     */
    async boatFloat(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      const appearance = appearances.get(pack.pack);
      if (!appearance) throw new Error('boatFloat: the pack\'s appearance was not registered (craftmaticHandlers)');
      const depth = Number(step['depth'] ?? Math.ceil(f.draft + 2));
      const at = { x: 200.5, z: -3400.5 };
      const water = pool(ctx, { x0: Math.floor(at.x - f.noseReach) - 8, x1: Math.ceil(at.x) + 120, z0: Math.floor(at.z - f.halfWidth) - 8, z1: Math.ceil(at.z + f.halfWidth) + 8 }, depth);
      const line = water.surface - f.draft;
      const v = await board(ctx, f, { ...at, y: line });
      await ctx.run(20);
      const drawn = entityDrawn(appearance, v);
      const bottom = drawn?.length ? Math.min(...drawn.map(d => d.box.y0)) : undefined;
      const y0 = v.location.y, x0 = v.location.x;
      let off = 0;
      for (let t = 0; t < 60; t++) { hold(ctx, { forward: 1 }); await ctx.run(1); off = Math.max(off, Math.abs(v.location.y - y0)); }
      hold(ctx, {});
      const out = { depth, draft: r2(f.draft), surface: r2(water.surface), origin: r2(y0 - water.surface), drawnBottom: bottom === undefined ? null : r2(bottom - water.surface), drove: r2(v.location.x - x0), offLevel: r2(off) };
      ctx.state['boatFloat'] = out;
      ctx.note(`${f.typeId} in a ${depth}-deep pool: origin ${out.origin} from the surface, the drawn hull's bottom ${out.drawnBottom ?? 'not drawn'} from it; drove ${out.drove} blocks in 3 s, ${out.offLevel} off level`);
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /** A ship's spaceship controls on open ground: `{ type }`. */
    async shipControls(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      if (f.mode !== 'plane') { ctx.note(`${f.typeId} is a ${f.mode}: no ship controls`); return; }
      const v = await board(ctx, f, { x: 60.5, z: -80.5 });
      const out: Record<string, unknown> = {};
      const fail = (label: string, msg: string): void => { ctx.violate({ invariant: 'ship-controls', message: `${f.typeId}: ${label}: ${msg}`, evidence: { ...out } }); };
      const at = (): { x: number; y: number; z: number; yaw: number } => ({ ...v.location, yaw: v.rotation.y });
      const phase = async (name: string, ticks: number, c: { forward?: number; strafe?: number; jump?: boolean }, each?: (t: number) => void): Promise<{ along: number; side: number; dy: number; yaw: number; flat: number }> => {
        const a = at(), r = a.yaw * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r);
        for (let t = 0; t < ticks; t++) { each?.(t); hold(ctx, c); await ctx.run(1); }
        hold(ctx, {});
        const b = at(), dx = b.x - a.x, dz = b.z - a.z;
        const res = { along: r2(dx * fx + dz * fz), side: r2(dx * fz - dz * fx), dy: r2(b.y - a.y), yaw: r2(wrap(b.yaw - a.yaw)), flat: r2(Math.hypot(dx, dz)) };
        out[name] = res;
        return res;
      };
      const up = await phase('up', 40, { jump: true });
      if (!(up.dy > 4 && up.flat < 0.3)) fail('Jump', `should go straight up, went dy ${up.dy}, ${up.flat} sideways`);
      // Let go: up to a block of drift while the climb stops (VERTICAL_ACCEL), then it must hold.
      await phase('settle_up', 10, {});
      const hover = await phase('hover', 40, {});
      if (!(Math.abs(hover.dy) < 0.1 && hover.flat < 0.3)) fail('hands off', `should hover, moved dy ${hover.dy}, ${hover.flat} sideways`);
      const fwd = await phase('forward', 40, { forward: 1 });
      if (!(fwd.along > 5 && Math.abs(fwd.dy) < 0.1)) fail('stick forward', `should fly forward level, went ${fwd.along} along, dy ${fwd.dy}`);
      await phase('stop', 30, {});
      const back = await phase('backward', 40, { forward: -1 });
      if (!(back.along < -2)) fail('stick back', `should fly straight backwards, went ${back.along} along`);
      await phase('stop_back', 30, {});
      const turn = await phase('turn', 30, { strafe: -1 });
      if (!(turn.yaw > 30 && turn.flat < 0.3)) fail('stick right at rest', `should turn on the spot, turned ${turn.yaw} and moved ${turn.flat}`);
      const down = await phase('back_jump', 100, { forward: -1, jump: true });
      if (!(down.dy < -2 && down.flat < 0.3)) fail('back + Jump', `should go straight down, went dy ${down.dy}, ${down.flat} sideways`);
      // Up again; then the child drags the view 40 degrees down (the camera reads the drag) and presses Jump: down.
      await phase('up_again', 30, { jump: true });
      await phase('look_down', 10, {}, () => { ctx.player.rotation = { x: ctx.player.rotation.x + 4, y: ctx.player.rotation.y }; });
      out['lookPitch'] = v.dynamic.get(entityKey(v.typeId, 'look_pitch')) ?? null;
      const press = await phase('look_down_jump', 30, { jump: true });
      if (!(press.dy < -1)) fail('look down + Jump', `a Jump pressed while the view looks down should go down, went dy ${press.dy} (view pitch ${String(out['lookPitch'])})`);
      ctx.state['shipControls'] = { ...((ctx.state['shipControls'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: out };
      ctx.note(`${f.typeId} ship controls: ${JSON.stringify(out)}`);
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /** The free look: a drag orbits the camera, it holds at rest, eases back while driving: `{ type }`. */
    async cameraRecentre(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      // The child climbs on looking at the vehicle's face (half round from its heading), and the seat turns them
      // onto the heading a few ticks later (quirk `mount-snaps-rider-yaw`): the chase camera must open behind the
      // nose all the same (Saga 30k: it opened facing the rider until a slot switch).
      // A boat is driven on a pool (aground it cannot move, and the ease-back needs a moving vehicle).
      const v = await board(ctx, f, onWater(ctx, f, { x: 60.5, z: -160.5 }), 0, 180);
      await ctx.run(20);
      const cam = (): { yaw: number; pitch: number } | undefined => {
        const c = ctx.sim.host.playerState(ctx.player).camera;
        if (!c.location || !c.facing) return undefined;
        const dx = c.facing.x - c.location.x, dy = c.facing.y - c.location.y, dz = c.facing.z - c.location.z;
        return { yaw: Math.atan2(-dx, dz) * 180 / Math.PI, pitch: -Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI };
      };
      const off = (): number | undefined => { const c = cam(); return c ? r2(wrap(c.yaw - v.rotation.y)) : undefined; };
      const out: Record<string, unknown> = { start: off() };
      const start = Number(out['start'] ?? 999);
      if (!(Math.abs(start) < 5)) ctx.violate({ invariant: 'free-look', message: `${f.typeId}: a child who climbed on looking at its face got a chase camera ${start} degrees off the nose (the seat's turn of the rider read as a drag)`, evidence: { ...out } });
      // Drag 90 degrees round at rest (6 degrees a tick: a slow finger), then let go for 2 s.
      for (let t = 0; t < 15; t++) { ctx.player.rotation = { x: ctx.player.rotation.x, y: ctx.player.rotation.y + 6 }; await ctx.run(1); }
      out['dragged'] = off();
      await ctx.run(40);
      out['restAfter2s'] = off();
      // Drive: forward (a ship along the ground, a car along the road) for 3 s.
      const trace: Array<number | undefined> = [];
      for (let t = 0; t < 60; t++) { hold(ctx, { forward: 1 }); await ctx.run(1); if (t % 10 === 9) trace.push(off()); }
      hold(ctx, {});
      out['driving'] = trace;
      const dragged = Number(out['dragged'] ?? 0), rest = Number(out['restAfter2s'] ?? 0), end = Math.abs(Number(trace.at(-1) ?? 999));
      if (!(Math.abs(dragged) > 60)) ctx.violate({ invariant: 'free-look', message: `${f.typeId}: a 90-degree drag turned the camera ${dragged} degrees`, evidence: { ...out } });
      else {
        if (!(Math.abs(rest - dragged) < 5)) ctx.violate({ invariant: 'free-look', message: `${f.typeId}: at rest the view moved from ${dragged} to ${rest} (it should stay where the child left it)`, evidence: { ...out } });
        if (!(end < 5)) ctx.violate({ invariant: 'free-look', message: `${f.typeId}: 3 s of driving left the view ${end} degrees off the nose (it should ease back within ~2 s)`, evidence: { ...out } });
      }
      ctx.state['freeLook'] = { ...((ctx.state['freeLook'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: out };
      ctx.note(`${f.typeId} free look: ${JSON.stringify(out)}`);
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /**
     * The cockpit view (hotbar slot 9) at full speed: its eye must stay on the DRAWN seat. The device draws the
     * vehicle behind the camera's schedule (quirk `cockpit-draw-lag`: a camera on the pose L ticks back is drawn
     * speed/20 x (lag - L) ahead), so each tick the camera's target is compared with the eye on the vehicle's pose
     * that many ticks back, along the heading (Saga 30k: at L 1.5 the McLaren's eye sat over its hood at 43 mph,
     * the X-wing's 2-3 blocks up its nose): `{ type }`.
     */
    async cockpitEye(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      const cfg = cameraCfg(f.typeId);
      if (!cfg?.eye) { ctx.note(`${f.typeId}: no cockpit eye in vehicle-camera.js (the cockpit camera stands at the rider's head)`); return; }
      const v = await board(ctx, f, onWater(ctx, f, { x: 60.5, z: -400.5 }));
      ctx.sim.host.playerState(ctx.player).selectedSlot = 8;
      const drawLag = quirkValue('cockpit-draw-lag', 'ticks');
      // The lag is counted in the camera runtime's own poses, read when IT runs: a pack whose main.js imports
      // vehicle-camera.js before vehicles.js reads the vehicle before this tick's move (on the device as here, the
      // intervals run in that order), so its newest pose is the one before the newest seen after the tick.
      const main = packText(pack.pack, 'scripts/main.js') ?? '';
      const camAt = main.indexOf('vehicle-camera.js'), moveAt = main.indexOf('vehicles.js');
      const cameraFirst = camAt >= 0 && moveAt >= 0 && camAt < moveAt;
      const poses: CockpitPose[] = [];
      let worst = 0, worstAt: Record<string, number> = {}, top = 0, last = { ...v.location };
      for (let t = 0; t < COCKPIT_DRIVE_TICKS; t++) {
        hold(ctx, { forward: 1 });
        await ctx.run(1);
        poses.push({ x: v.location.x, y: v.location.y, z: v.location.z, yaw: v.rotation.y, pitch: 0 });
        if (poses.length > Math.ceil(drawLag) + 3) poses.shift();
        const speed = Math.hypot(v.location.x - last.x, v.location.z - last.z) * 20;
        last = { ...v.location };
        top = Math.max(top, speed);
        const cam = ctx.sim.host.playerState(ctx.player).camera.location;
        const seen = cameraFirst ? poses.slice(0, -1) : poses;
        const drawn = cockpitCamera(seen, drawLag, cfg.eye, v.scale(), { yaw: 0, pitch: 0 }, 89);
        if (!cam || !drawn || seen.length <= Math.ceil(drawLag)) continue;
        const r = drawn.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r);
        const lead = (cam.x - drawn.location.x) * fx + (cam.z - drawn.location.z) * fz;
        if (Math.abs(lead) > Math.abs(worst)) { worst = lead; worstAt = { t, speed: r2(speed), lead: r2(lead) }; }
      }
      hold(ctx, {});
      const out = { topSpeed: r2(top), worstLead: r2(worst), at: worstAt, drawLag };
      ctx.state['cockpitEye'] = { ...((ctx.state['cockpitEye'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: out };
      ctx.note(`${f.typeId} cockpit eye at up to ${out.topSpeed} blocks/s: worst ${out.worstLead} blocks ${worst >= 0 ? 'ahead of' : 'behind'} the drawn seat`);
      if (Math.abs(worst) > COCKPIT_EYE_SLACK) ctx.violate({ invariant: 'cockpit-eye-on-seat', message: `${f.typeId}: the cockpit eye is drawn ${out.worstLead} blocks ${worst >= 0 ? 'AHEAD of' : 'behind'} the seat at ${worstAt['speed']} blocks/s (the camera's pose lag does not match the device's draw lag of ${drawLag} ticks)`, evidence: out });
      ctx.sim.host.playerState(ctx.player).selectedSlot = 0;
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /**
     * A ship parked with its tail against a post, the stick held right (`TURN_TICKS`): the Saga's X-wing rose 4-6
     * blocks to the post's top (round 30j, CMVT 15:17:11 and 15:22:49, `how: rise` on a pure turn). A turn must not
     * climb; it may pivot or be blocked, and never enter the post: `{ type }`.
     */
    async turnAgainstPost(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      if (f.mode !== 'plane') { ctx.note(`${f.typeId} is a ${f.mode}: no turn-against-post check`); return; }
      const start = { x: 60.5, z: -240.5 };
      // Heading +x; a right turn swings the tail to -z. The post stands just past the tail's -z corner (x a step
      // behind the tail, z 0.7 beyond the corner), the airframe's full height, so a few degrees of swing meet it.
      const post = column(ctx, Math.floor(start.x - f.noseReach - 0.1), postCellBeyond(start.z - f.halfWidth, 0.7), Math.ceil(f.height) + 1);
      const v = await board(ctx, f, start);
      const band = bandOf(f), yaw0 = v.rotation.y, y0 = v.location.y;
      let rose = 0, clip = 0;
      for (let t = 0; t < TURN_TICKS; t++) {
        hold(ctx, { strafe: -1 });
        await ctx.run(1);
        rose = Math.max(rose, v.location.y - y0);
        if (post.some(c => bandOverlaps(v, f, band.lo, band.hi, c))) clip++;
      }
      hold(ctx, {});
      const turned = r2(wrap(v.rotation.y - yaw0));
      const out = { rose: r2(rose), turned, clipTicks: clip, end: { x: r2(v.location.x), y: r2(v.location.y), z: r2(v.location.z) } };
      ctx.state['turnAgainstPost'] = { ...((ctx.state['turnAgainstPost'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: out };
      ctx.note(`${f.typeId} turning with its tail against a post: rose ${out.rose}, turned ${turned} degrees, ${clip} ticks in the post`);
      if (rose > 0.5) ctx.violate({ invariant: 'ship-turn-climbs', message: `${f.typeId} turning on the spot with its tail against a post rose ${out.rose} blocks (a turn must not climb)`, evidence: out });
      if (clip > 0) ctx.violate({ invariant: 'vehicle-no-clip', message: `${f.typeId}'s clear band went into the post on ${clip} ticks of a turn`, evidence: out });
      v.removeRider(ctx.player);
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },

    /**
     * Sneak off a ship in the air: the child falls straight under it and the empty ship sinks to park. The Saga's
     * X-wing parked ON the child (round 30j s77-s79, CMVT 15:28:07-11: rider off, vy -3 to the ground). It must
     * hold over anyone under it and park once they walk out: `{ type }`.
     */
    async parkOverRider(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      if (f.mode !== 'plane') { ctx.note(`${f.typeId} is a ${f.mode}: no park-over-rider check`); return; }
      const v = await board(ctx, f, { x: 60.5, z: -320.5 });
      // The fall from the seat is the dismount's (a ship has no slow falling; the Nimbus case covers that rule).
      ctx.quiet(['player-not-in-solid', 'nothing-below-ground', 'no-unprotected-fall']);
      for (let t = 0; t < 40; t++) { hold(ctx, { jump: true }); await ctx.run(1); }
      hold(ctx, {});
      await ctx.run(10);
      const top = r2(v.location.y - FLAT_GROUND_Y);
      v.removeRider(ctx.player);
      for (let t = 0; t < 300 && !ctx.player.onGround; t++) await ctx.run(1);
      // Let the ship come down: it sinks 3 blocks a second from `top`; then settle.
      await ctx.run(Math.ceil(top / 3 * 20) + 60);
      const p = ctx.player.location, r = v.rotation.y * Math.PI / 180, fx = -Math.sin(r), fz = Math.cos(r), rx = -Math.cos(r), rz = -Math.sin(r);
      const dx = p.x - v.location.x, dz = p.z - v.location.z;
      // Within the footprint and below the hull's top: under it, or inside it (the Saga's X-wing parked with its
      // base at the child's feet, s79 - the child stood in the hull).
      const under = Math.abs(dx * fx + dz * fz) < f.noseReach && Math.abs(dx * rx + dz * rz) < f.halfWidth && p.y < v.location.y + f.height;
      const headroom = r2(v.location.y - (p.y + FLIGHT.PLAYER_HEIGHT));
      const out = { top, under, headroom, ship: { x: r2(v.location.x), y: r2(v.location.y), z: r2(v.location.z) }, child: { x: r2(p.x), y: r2(p.y), z: r2(p.z) } };
      ctx.note(`${f.typeId} after a sneak off at ${top} up: the child ${under ? 'is under it' : 'is not under it'}, hull base ${headroom} over the child's head (ship ${JSON.stringify(out.ship)}, child ${JSON.stringify(out.child)}, yaw ${r2(v.rotation.y)})`);
      if (under && headroom < 0) ctx.violate({ invariant: 'ship-parks-on-player', message: `${f.typeId} parked ON the child who sneaked off it: hull base ${headroom} over the child's head`, evidence: out });
      // Out from under it: it must park on the ground.
      ctx.player.location = { x: p.x + 2 * f.noseReach + 4, y: p.y, z: p.z };
      await ctx.run(Math.ceil((v.location.y - FLAT_GROUND_Y) / 3 * 20) + 60);
      const parked = r2(v.location.y - FLAT_GROUND_Y);
      ctx.note(`${f.typeId} parked ${parked} over the ground after the child walked out`);
      if (parked > 0.05) ctx.violate({ invariant: 'ship-parks', message: `${f.typeId} stayed ${parked} blocks up after the child walked out from under it (it should sink and park)`, evidence: { ...out, parked } });
      ctx.state['parkOverRider'] = { ...((ctx.state['parkOverRider'] as Record<string, unknown> | undefined) ?? {}), [f.typeId]: { ...out, parked } };
      ctx.sim.engine.removeEntity(v);
      await ctx.run(2);
    },
  };
}

/** The vehicle scenarios of a pack: one per scripted car, hover craft and ship. */
export function vehicleScenarios(pack: CraftmaticPack): Scenario[] {
  return scriptedVehicleTypes(pack).map(t => t.mode === 'boat' ? boatScenario(t) : ({
    name: `vehicle-${t.typeId.replace(/^.*:/, '')}`,
    description: `${t.mode} ${t.typeId}: the stuck course (stick forward into each obstacle), ${t.mode === 'plane' ? 'the spaceship controls, ' : ''}the free look, the cockpit eye at speed, getting off at 100/200/400 %.`,
    steps: [
      // Its doors, lids and cupboards open on a tap while it is parked, close as it drives off and ride with it (A-02).
      ...(t.parts.length ? [{ kind: 'vehicleParts', type: t.typeId }] : []),
      // Its slides are ridden from a tap while it is parked, refused while it moves, and follow it (A-02).
      ...(t.slides.length ? [{ kind: 'vehicleSlides', type: t.typeId }] : []),
      { kind: 'stuckCourse', type: t.typeId },
      // A ship also with Jump held: the old flight model's throttle (its stick alone never moved it), the new one's "up".
      ...(t.mode === 'plane' ? [{ kind: 'stuckCourse', type: t.typeId, policy: 'forward+jump' }] : []),
      ...(t.mode === 'plane' ? [{ kind: 'shipControls', type: t.typeId }] : []),
      { kind: 'cameraRecentre', type: t.typeId },
      { kind: 'cockpitEye', type: t.typeId },
      // The Saga's two turn/park findings (round 30j): a turn against a post must not climb; an empty ship never parks on the child.
      ...(t.mode === 'plane' ? [{ kind: 'turnAgainstPost', type: t.typeId }, { kind: 'parkOverRider', type: t.typeId }] : []),
      // Getting off on the ground at 100, 200 and 400 % lands beside the hull, never a fall (SEAT-05, Pixel 30l).
      { kind: 'dismountEverySize', type: t.typeId },
    ],
    // A course is a long drive on purpose: the HUD lines it prints are the runtime's, not faults.
    allowLines: [/CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9/],
  }));
}

/** A boat's scenario: the water lanes, getting off on the water at 100/200/400 %, the free look and the cockpit eye on a pool. */
function boatScenario(t: ScriptedTypeFacts): Scenario {
  return {
    name: `vehicle-${t.typeId.replace(/^.*:/, '')}`,
    description: `boat ${t.typeId}: the water lanes (open water, a bank, a one-block channel, a pier post), getting off on the water at 100/200/400 %, the free look and the cockpit eye on a pool.`,
    steps: [
      // Its lids, hatches and cupboards open on a tap while it is parked (A-02); a boat parked on land does not drive off.
      ...(t.parts.length ? [{ kind: 'vehicleParts', type: t.typeId }] : []),
      ...(t.slides.length ? [{ kind: 'vehicleSlides', type: t.typeId }] : []),
      { kind: 'boatCourse', type: t.typeId },
      { kind: 'waterEgress', type: t.typeId },
      { kind: 'cameraRecentre', type: t.typeId },
      { kind: 'cockpitEye', type: t.typeId },
    ],
    allowLines: [/CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9|knots/i],
  };
}

/** A course table in markdown: one row per vehicle, a column per obstacle. */
export function courseMarkdown(rows: readonly CourseRow[], title: string): string {
  const vehicles = [...new Set(rows.map(r => `${r.vehicle}|${r.policy}`))];
  const cell = (r: CourseRow | undefined): string => (!r ? '-' : r.passed ? `pass ${r.ticks}t${r.stuckTicks ? ` (${r.stuckTicks} stuck)` : ''}${r.clipTicks ? ` CLIP ${r.clipTicks}` : ''}` : `STOP${r.escaped === undefined ? '' : r.escaped ? ' / escaped' : ' / TRAPPED'}${Math.abs(r.side ?? 0) >= 3 ? ` (slid ${r.side} across)` : ''}${r.clipTicks ? ` CLIP ${r.clipTicks}` : ''}`);
  // The water lanes get columns only when a boat ran them.
  const lanes: Array<CourseObstacle | WaterLane> = [...COURSE_OBSTACLES, ...WATER_LANES.filter(l => rows.some(r => r.obstacle === l))];
  const lines = [`### ${title}`, '', `| vehicle | mode | ${lanes.join(' | ')} | passed |`, `|---|---|${lanes.map(() => '---').join('|')}|---|`];
  for (const v of vehicles) {
    const mine = rows.filter(r => `${r.vehicle}|${r.policy}` === v);
    lines.push(`| ${v.replace('|forward+jump', ' (stick + Jump)').replace('|forward', '')} | ${mine[0]?.mode ?? '?'} | ${lanes.map(o => cell(mine.find(r => r.obstacle === o))).join(' | ')} | ${mine.filter(r => r.passed).length}/${mine.length} |`);
  }
  return lines.join('\n') + '\n';
}
