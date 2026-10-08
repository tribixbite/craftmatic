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
 * Run: `bun scripts/sim.ts <packs> --scenario=vehicles [--md=] [--json=]`.
 * Boats are left out (no water course yet: `TODO(sim-boat-course)`); native
 * mounts (a rotorcraft, a flyer's cloud) are left out: the simulator's hover
 * controller is a stand-in for the device's, whose stepping is not modelled.
 */

import type { AnyStep, Scenario, StepContext, StepHandler } from '../../scenario/types.js';
import type { SimEntity } from '../../entity/entity.js';
import type { CraftmaticPack } from './pack-facts.js';
import { packText } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import { FLAT_GROUND_Y } from '../../world/voxel-world.js';
import { FLIGHT } from '../../../engine/bedrock-vehicle.js';
import { cockpitCamera, type CockpitPose } from '../../../engine/vehicle-free-look.js';
import { quirkValue } from '../../quirks/registry.js';

/** Ticks after boarding before the seat turns a child who climbed on looking away onto the heading (quirk `mount-snaps-rider-yaw`: 4-12 on the Saga). */
const MOUNT_SNAP_TICKS = 4;
/** Ticks the cockpit-eye check drives at full stick (6 s: every class is at its top speed well before). */
const COCKPIT_DRIVE_TICKS = 120;
/** Blocks the cockpit eye may be drawn off the seat along the heading (half a block: inside the cabin of the smallest car). */
const COCKPIT_EYE_SLACK = 0.5;

/** A scripted vehicle type as `scripts/vehicles.js` declares it (blocks at scale 1). */
export interface ScriptedTypeFacts { typeId: string; mode: 'car' | 'boat' | 'plane' | 'hover'; noseReach: number; halfWidth: number; height: number }

/** The scripted vehicle types of a pack, read from `scripts/vehicles.js`'s config (the runtime's first argument). */
export function scriptedVehicleTypes(pack: CraftmaticPack): ScriptedTypeFacts[] {
  const text = packText(pack.pack, 'scripts/vehicles.js');
  if (!text) return [];
  const at = text.indexOf('({"types":');
  if (at < 0) return [];
  const cfg = extractJsonAfter(text.slice(at), '(') as { types?: Record<string, { mode?: string; noseReach?: number; halfWidth?: number; height?: number }> } | undefined;
  return Object.entries(cfg?.types ?? {}).map(([typeId, t]) => ({
    typeId, mode: (t.mode ?? 'car') as ScriptedTypeFacts['mode'], noseReach: Number(t.noseReach ?? 1), halfWidth: Number(t.halfWidth ?? 0.5), height: Number(t.height ?? 1),
  }));
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
/** Blocks a ship may drift across a lane beyond its heading's own before it is running ALONG the obstacle (the Saga's shortest run was 13). */
const SLIDE_ALONG_BLOCKS = 10;

/** One obstacle's outcome for one vehicle. */
export interface CourseRow {
  vehicle: string; mode: string; obstacle: CourseObstacle;
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
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
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
  const pitch = f.mode === 'plane' || f.mode === 'boat' ? Number(v.properties.get('craftmatic:fl_pitch') ?? 0) || 0 : 0;
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
  const types = new Map(scriptedVehicleTypes(pack).map(t => [t.typeId, t]));
  /**
   * Spawn the vehicle and seat the child on it, heading +x (yaw -90) turned `skew` degrees toward +z, at `at` on the
   * ground. `lookAway` (degrees): the child mounts looking that far off the heading, and the seat turns them onto it
   * `MOUNT_SNAP_TICKS` later, as the device does (quirk `mount-snaps-rider-yaw`; the simulator's `addRider` does not).
   */
  const board = async (ctx: StepContext, f: ScriptedTypeFacts, at: { x: number; z: number }, skew = 0, lookAway?: number): Promise<SimEntity> => {
    // A low car's seated rider has its feet under the road (the seat is the driver's EYE less the seated eye
    // height, cockpit-seat.ts), and the pits are dug below the flat world's ground on purpose: the course
    // judges the VEHICLE by its own clear band (`vehicle-no-clip`), so these two core checks are quiet.
    ctx.quiet(['player-not-in-solid', 'nothing-below-ground']);
    const v = ctx.sim.engine.spawnEntity(f.typeId, 'overworld', { x: at.x, y: FLAT_GROUND_Y, z: at.z });
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
  const cameraCfg = (typeId: string): { eye?: [number, number, number] } | undefined => {
    const text = packText(pack.pack, 'scripts/vehicle-camera.js');
    const at = text ? text.indexOf('({"vehicles":') : -1;
    if (!text || at < 0) return undefined;
    const cfg = extractJsonAfter(text.slice(at), '(') as { vehicles?: Array<{ typeId?: string; eye?: [number, number, number] }> } | undefined;
    return cfg?.vehicles?.find(c => c.typeId === typeId);
  };
  /** The band the runtime keeps clear (bedrock-vehicle.ts: a car's over its step, a ship's whole airframe aloft). */
  const bandOf = (f: ScriptedTypeFacts): { lo: number; hi: number } => (f.mode === 'plane' ? { lo: 0.15, hi: Math.max(0.2, f.height - 0.15) } : { lo: (f.mode === 'hover' ? 1.6 - 1 : 1.05) + 0.1, hi: Math.max(1.2, f.height - 0.15) });
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

  return {
    /**
     * Get off on the ground at every wand size (SEAT-05): the vehicle spawned on the flat world, sized by its
     * own `craftmatic:size_<pct>` event, the child seated, then the device's SNEAK (the engine's set-down about
     * the seat, quirk `dismount-near-seat`) and whatever the pack's runtime does after it. The child must end on
     * the ground (the core `no-unprotected-fall` judges the fall: Pixel 30l dropped ~9 blocks off the 200 %
     * Milano) and outside the hull (`dismount-in-hull`: within its footprint under its top): `{ type, sizes? }`.
     */
    async dismountEverySize(step: AnyStep, ctx: StepContext) {
      const f = typeOf(step);
      const sizes = (step['sizes'] as number[] | undefined) ?? [100, 200, 400];
      const rows: Array<{ pct: number; seatedY: number; end: { x: number; y: number; z: number }; inHull: boolean; lowest: number }> = [];
      for (const [i, pct] of sizes.entries()) {
        const at = { x: 400.5 + i * 200, z: -600.5 };
        const v = await board(ctx, f, at);
        v.triggerEvent(`craftmatic:size_${pct}`);
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
          if (hit) { clip++; firstClip ??= { t, x: r2(v.location.x - sx), y: r2(v.location.y - FLAT_GROUND_Y), pitch: r2(Number(v.properties.get('craftmatic:fl_pitch') ?? 0)), cell: [hit[0] - sx, hit[1] - FLAT_GROUND_Y, hit[2] - z0] }; }
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
      out['lookPitch'] = v.dynamic.get('craftmatic:look_pitch') ?? null;
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
      const v = await board(ctx, f, { x: 60.5, z: -160.5 }, 0, 180);
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
      const v = await board(ctx, f, { x: 60.5, z: -400.5 });
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
      const post = column(ctx, Math.floor(start.x - f.noseReach - 0.1), Math.floor(start.z - f.halfWidth - 0.7), Math.ceil(f.height) + 1);
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
  return scriptedVehicleTypes(pack).filter(t => t.mode !== 'boat').map(t => ({
    name: `vehicle-${t.typeId.replace(/^.*:/, '')}`,
    description: `${t.mode} ${t.typeId}: the stuck course (stick forward into each obstacle), ${t.mode === 'plane' ? 'the spaceship controls, ' : ''}the free look, the cockpit eye at speed, getting off at 100/200/400 %.`,
    steps: [
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

/** A course table in markdown: one row per vehicle, a column per obstacle. */
export function courseMarkdown(rows: readonly CourseRow[], title: string): string {
  const vehicles = [...new Set(rows.map(r => `${r.vehicle}|${r.policy}`))];
  const cell = (r: CourseRow | undefined): string => (!r ? '-' : r.passed ? `pass ${r.ticks}t${r.stuckTicks ? ` (${r.stuckTicks} stuck)` : ''}${r.clipTicks ? ` CLIP ${r.clipTicks}` : ''}` : `STOP${r.escaped === undefined ? '' : r.escaped ? ' / escaped' : ' / TRAPPED'}${Math.abs(r.side ?? 0) >= 3 ? ` (slid ${r.side} across)` : ''}${r.clipTicks ? ` CLIP ${r.clipTicks}` : ''}`);
  const lines = [`### ${title}`, '', `| vehicle | mode | ${COURSE_OBSTACLES.join(' | ')} | passed |`, `|---|---|${COURSE_OBSTACLES.map(() => '---').join('|')}|---|`];
  for (const v of vehicles) {
    const mine = rows.filter(r => `${r.vehicle}|${r.policy}` === v);
    lines.push(`| ${v.replace('|forward+jump', ' (stick + Jump)').replace('|forward', '')} | ${mine[0]?.mode ?? '?'} | ${COURSE_OBSTACLES.map(o => cell(mine.find(r => r.obstacle === o))).join(' | ')} | ${mine.filter(r => r.passed).length}/${mine.length} |`);
  }
  return lines.join('\n') + '\n';
}
