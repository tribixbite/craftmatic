/**
 * What a child does with a placed craftmatic model, as scenario steps with
 * their own checks: ride a slide and a lift, drive a vehicle, summon and fly
 * a mount, walk through the doorways, and let the figures live. Each step
 * finds its targets from the pack's facts, acts through the core steps (tap,
 * hold, walk, drive) and checks what a child would notice:
 *
 *   tap-boards-ride        a tap on a ride's seat or car seats the player;
 *   slide-rides-in-chute   a slide carries its rider in the chute, not on a rim;
 *   lift-car-in-model      a lift's car stays inside the model's box;
 *   rider-set-down         at a ride's end the rider stands free on a floor;
 *   driver-sees-ahead      a driver's eye sees out of the vehicle (the cockpit
 *                          fan of `cockpit-seat.ts`, over the DRAWN geometry);
 *   mount-summoned         a tap on a flyer's companion puts the player on a mount;
 *   doorway-line           the device's straight walk through a doorway, from
 *                          both sides and every leaf column; a fall or a stop is
 *                          ATTRIBUTED: the model's (nothing drawn where the
 *                          player needed a floor, or drawn geometry where it hit
 *                          its head) or the pack's (colliders that disagree with
 *                          what the model draws);
 *   figures-stay           a figure stays inside the model's box.
 */

import type { AnyStep, StepContext, StepHandler } from '../../scenario/types.js';
import { CORE_HANDLERS, findEntity } from '../../scenario/runner.js';
import { lookAngles, type Box, type Vec3 } from '../../core/vec.js';
import type { SimEntity } from '../../entity/entity.js';
import { teleport } from '../../script-host/facades.js';
import { findApproach } from '../../scenario/approach.js';
import { VIEW } from '../../../engine/cockpit-seat.js';
import { IX_KEYS } from '../../../engine/bedrock-interactives.js';
import { JUMP_PEAK, STEP_HEIGHT } from '../../physics/body.js';
import { LINE_MIN_OUT, LINE_OUT, doorwayGeometry, jumpHelps } from '../../../engine/interactive-walk.js';
import type { AddonAppearance } from './appearance.js';
import type { VoxelWorld } from '../../world/voxel-world.js';
import { entityDrawn, forwardViewWorld, type DrawnBox } from './drawn.js';
import { modelToWorld, type CraftmaticPack, type Placed } from './pack-facts.js';
import { PLACED_KEY } from './wand.js';
import { treadBlocksFor } from '../../../engine/bedrock-placement-pack.js';
import { relayRounding, type QuarterTurn } from '../../../engine/bedrock-collider-scale.js';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const pt = (p: Vec3): Vec3 => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z) });

/** The placement the wand made in this scenario (a step before must have placed). */
export function placedOf(ctx: StepContext): Placed {
  const p = ctx.state[PLACED_KEY] as Placed | undefined;
  if (!p) throw new Error('no placement: a `place` step must come first');
  return p;
}

/** The ride seat of ride `index` (its idle seat carries the index). */
const rideSeat = (ctx: StepContext, pack: CraftmaticPack, index: number): SimEntity | undefined =>
  findEntity(ctx.sim, ctx.player, { type: pack.rides?.seatType ?? '-', where: e => e.dynamic.get('craftmatic:ride') === index });

/**
 * How far a point sits over the surface the model DRAWS under it: the point's
 * height less the highest drawn top within `radius` of it (x, z) and within
 * the band [y - 1, y + 0.5] - negative when the point is below that top (a
 * seat sunk into its chute). Undefined when nothing is drawn there. The
 * collider grid cannot answer this: a chute's rims and bed share a cell.
 */
function heightOverDrawn(boxes: readonly DrawnBox[], p: Vec3, radius: number): number | undefined {
  let top = -Infinity;
  for (const { box: b } of boxes) {
    if (p.x < b.x0 - radius || p.x > b.x1 + radius || p.z < b.z0 - radius || p.z > b.z1 + radius) continue;
    if (b.y1 >= p.y - 1 && b.y1 <= p.y + 0.5) top = Math.max(top, b.y1);
  }
  return top === -Infinity ? undefined : p.y - top;
}

/** A slide's run-out in the world: its last two path points (the foot and the set-down point), when the last segment is level. */
function slideRunout(pack: CraftmaticPack, placed: Placed, index: number): { foot: Vec3; end: Vec3 } | undefined {
  const actor = pack.placement.actors.find(a => a.ridePath && (a as { ride?: number }).ride === index);
  const path = actor?.ridePath;
  if (!path || path.length < 2) return undefined;
  const [fx, fy, fz] = path[path.length - 2]!, [ex, ey, ez] = path[path.length - 1]!;
  if (Math.abs(fy - ey) > 1e-6) return undefined;
  return { foot: modelToWorld(pack.placement, placed, { x: fx, y: fy, z: fz }), end: modelToWorld(pack.placement, placed, { x: ex, y: ey, z: ez }) };
}

/** Whether a seat is on the run-out: past the foot along the run-out's direction, at its height. */
export function onRunout(at: Vec3, r: { foot: Vec3; end: Vec3 }): boolean {
  const dx = r.end.x - r.foot.x, dz = r.end.z - r.foot.z, len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return false;
  const t = ((at.x - r.foot.x) * dx + (at.z - r.foot.z) * dz) / len2;
  return t > 1e-3 && Math.abs(at.y - r.foot.y) < 0.05;
}

/** How far over its drawn chute a slide's seat may run (blocks at 100 %, times the size): the drawn geometry's own grain. */
export const SLIDE_SEAT_OVER_DRAWN = 0.2;

/** Board a ride by a tap on `target` (or a hold), waiting a second for the runtime to seat the player. */
async function board(ctx: StepContext, target: SimEntity, how: 'tap' | 'hold', label: string): Promise<boolean> {
  await CORE_HANDLERS[how]!({ kind: how, target: { where: (e: SimEntity) => e === target, label } }, ctx);
  for (let t = 0; t < 20 && !ctx.player.ridingOn; t++) await ctx.run(1);
  if (!ctx.player.ridingOn) ctx.violate({ invariant: 'tap-boards-ride', message: `a ${how} on ${label} boarded nothing`, evidence: { target: target.typeId, at: pt(target.location), eye: pt(ctx.player.headLocation()) } });
  return !!ctx.player.ridingOn;
}

/** After a ride: the rider set down stays up (it does not drop more than a block once off). */
async function checkSetDown(ctx: StepContext, label: string): Promise<void> {
  const p = ctx.player, y0 = p.location.y;
  await ctx.run(20);
  if (p.ridingOn) return;
  if (y0 - p.location.y > 1) ctx.violate({ invariant: 'rider-set-down', message: `after ${label} the player dropped ${r3(y0 - p.location.y)} blocks from where the ride set it down`, evidence: { setDown: r3(y0), now: pt(p.location) } });
}

/** The ride steps, the vehicle, mount, doorway and figure steps for one pack. */
export function playHandlers(pack: CraftmaticPack, appearance: AddonAppearance): Record<string, StepHandler> {
  return {
    /** Ride a slide: `{ index, board: 'tap' | 'hold' }`. */
    async rideSlide(step: AnyStep, ctx: StepContext) {
      const index = Number(step['index'] ?? 0);
      const seat = rideSeat(ctx, pack, index);
      if (!seat) throw new Error(`rideSlide: no seat for ride ${index}`);
      const f = placedOf(ctx).sizePct / 100;
      if (!await board(ctx, seat, (step['board'] as 'tap' | 'hold') ?? 'tap', `slide ${index + 1}'s seat`)) return;
      const drawn = staticDrawn(ctx, appearance, pack);
      // The seat must run IN the chute: never over the surface the model draws directly under it (29b ran on the
      // side rails, 30 LDU over the bed). # TODO(sim-slide): the drawn slope is coarse (its cubes step by a few LDU),
      // so the margin between a seat on the bed and one on the rails is small; part-level geometry would settle it.
      // The run-out (the path's last, level segment past the chute's foot, `RIDE.SLIDE_RUNOUT_LDU`) carries the rider
      // off the chute to where it is set down: it is not in the chute, and over a floor lower than the foot it
      // read as "running over the chute" (42652's slides, 0.45 over the floor under the run-out).
      const runout = slideRunout(pack, placedOf(ctx), index);
      let ticks = 0, worst = -Infinity, worstAt: Vec3 | undefined, reported = false;
      for (; ticks < 600 && ctx.player.ridingOn; ticks++) {
        await ctx.run(1);
        if (runout && onRunout(seat.location, runout)) continue;
        const h = heightOverDrawn(drawn, seat.location, 0);
        if (h === undefined) continue;
        if (h > worst) { worst = h; worstAt = { ...seat.location }; }
        if (!reported && h > SLIDE_SEAT_OVER_DRAWN * f && (reported = true)) ctx.violate({ invariant: 'slide-rides-in-chute', message: `slide ${index + 1}: the rider runs ${r3(h)} blocks over the chute the model draws`, evidence: { seat: pt(seat.location), over: r3(h), limit: SLIDE_SEAT_OVER_DRAWN * f } });
      }
      ctx.state['slideWorstOverDrawn'] = { worst: r3(worst), at: worstAt && pt(worstAt) };
      ctx.note(`slide ${index + 1}: rode ${ticks} ticks; the seat ran at most ${r3(worst)} blocks over the drawn chute`);
      await checkSetDown(ctx, `slide ${index + 1}`);
    },

    /** Ride a lift from floor to floor: `{ index, trips, board: 'tap' | 'hold', on: 'car' | 'seat' }` (default: a tap on the car). */
    async rideLift(step: AnyStep, ctx: StepContext) {
      const index = Number(step['index'] ?? 0), trips = Number(step['trips'] ?? 3);
      const ride = pack.rides?.rides[index];
      const placed = placedOf(ctx);
      const car = ride?.carType ? findEntity(ctx.sim, ctx.player, { type: ride.carType }) : undefined;
      const seat = rideSeat(ctx, pack, index);
      const how = (step['board'] as 'tap' | 'hold' | undefined) ?? 'tap';
      const target = step['on'] === 'seat' ? seat : car ?? seat;
      if (!target) throw new Error(`rideLift: no car or seat for ride ${index}`);
      const box: Box = { x0: placed.from.x - 1, y0: placed.from.y - 1, z0: placed.from.z - 1, x1: placed.to.x + 2, y1: placed.to.y + 2, z1: placed.to.z + 2 };
      let outside = false;
      for (let trip = 0; trip < trips; trip++) {
        if (!await board(ctx, target, how, `lift ${index + 1}'s ${target === car ? 'car' : 'seat'} (trip ${trip + 1})`)) return;
        let ticks = 0;
        for (; ticks < 1200 && ctx.player.ridingOn; ticks++) {
          await ctx.run(1);
          const c = car ?? seat!;
          const b = entityDrawn(appearance, c)?.map(d => d.box) ?? [c.aabb()];
          const top = Math.max(...b.map(q => q.y1));
          if (!outside && (top > box.y1 || c.location.x < box.x0 || c.location.x > box.x1 || c.location.z < box.z0 || c.location.z > box.z1)) {
            outside = true;
            ctx.violate({ invariant: 'lift-car-in-model', message: `lift ${index + 1}: its car draws up to y ${r3(top)}, over the model's top ${placed.to.y + 1}`, evidence: { car: c.typeId, at: pt(c.location), modelTop: placed.to.y + 1 } });
          }
        }
        ctx.note(`lift ${index + 1} trip ${trip + 1}: ${ticks} ticks, set down at ${JSON.stringify(pt(ctx.player.location))}`);
        await checkSetDown(ctx, `lift ${index + 1} trip ${trip + 1}`);
      }
    },

    /** Board a vehicle by a hold, check the driver's view, drive a course, sneak off: `{ type, ticks }`. */
    async driveVehicle(step: AnyStep, ctx: StepContext) {
      const type = String(step['type']);
      const v = findEntity(ctx.sim, ctx.player, { type });
      if (!v) throw new Error(`driveVehicle: no ${type}`);
      await CORE_HANDLERS['hold']!({ kind: 'hold', target: { where: (e: SimEntity) => e === v, label: type } }, ctx);
      if (ctx.player.ridingOn !== v) { ctx.violate({ invariant: 'tap-boards-ride', message: `a hold on ${type} did not mount it`, evidence: { at: pt(v.location) } }); return; }
      await ctx.run(5);
      const drawn = entityDrawn(appearance, v);
      if (drawn && v.riders[0] === ctx.player) {
        const eye = ctx.player.headLocation();
        const view = forwardViewWorld(drawn, eye, v.rotation.y, VIEW);
        ctx.state['driverView'] = view;
        if (view.clear / view.total < VIEW.minClear) ctx.violate({ invariant: 'driver-sees-ahead', message: `${type}: the driver's eye sees out of ${view.clear} of ${view.total} forward rays (needs ${Math.round(VIEW.minClear * 100)} percent)`, evidence: { eye: pt(eye), yaw: r3(v.rotation.y) } });
      }
      // First under the model's overhangs (a shelf, a balcony: a collider span starting 1-3 blocks over a floor the
      // car stands on) - 10797's car fell through the world under one on the Saga - then the open course.
      for (const target of overhangTargets(ctx, v).slice(0, Number(step['overhangs'] ?? 3))) await driveTo(ctx, v, target, 240);
      // The course: straight, a right sweep, straight, a left sweep, reverse - 30 s at the default.
      const total = Number(step['ticks'] ?? 600), leg = Math.max(20, Math.floor(total / 5));
      ctx.player.rotation.y = v.rotation.y;
      const legs = [{ forward: 1, turnPerTick: 0 }, { forward: 1, turnPerTick: 3 }, { forward: 1, turnPerTick: 0 }, { forward: 1, turnPerTick: -3 }, { forward: -1, turnPerTick: 0 }];
      const start = { ...v.location };
      let far = 0, lowest = v.location.y;
      for (const l of legs) {
        await CORE_HANDLERS['drive']!({ kind: 'drive', hold: { ...l, strafe: l.turnPerTick > 0 ? -1 : l.turnPerTick < 0 ? 1 : 0, ticks: leg } }, ctx);
        far = Math.max(far, Math.hypot(v.location.x - start.x, v.location.z - start.z));
        lowest = Math.min(lowest, v.location.y);
      }
      ctx.note(`${type}: drove ${total} ticks, at most ${r3(far)} blocks from its start, lowest y ${r3(lowest)} (start ${JSON.stringify(pt(start))}, end ${JSON.stringify(pt(v.location))})`);
      await CORE_HANDLERS['sneak']!({ kind: 'sneak' }, ctx);
      await ctx.run(60);
    },

    /**
     * Drive a ridden vehicle straight under a FIXTURE overhang: a row of the pack's own collider blocks
     * (`lo`/`hi` sixteenths, default 4..16: its underside 1.25 over the road) laid across the path
     * `ahead` blocks in front, the geometry of the host test that pins 10797's fall (Saga 2026-09-29,
     * `test/bedrock-vehicle.test.ts`). Where the device met its overhang is not recorded, so the
     * regression lays one: `{ type, ahead, lo, hi, ticks }`.
     */
    async driveUnderFixture(step: AnyStep, ctx: StepContext) {
      const type = String(step['type']);
      const v = findEntity(ctx.sim, ctx.player, { type });
      if (!v) throw new Error(`driveUnderFixture: no ${type}`);
      if (ctx.player.ridingOn !== v) await CORE_HANDLERS['hold']!({ kind: 'hold', target: { where: (e: SimEntity) => e === v, label: type } }, ctx);
      if (ctx.player.ridingOn !== v) throw new Error(`driveUnderFixture: could not mount ${type}`);
      const w = ctx.sim.engine.dimension(v.dimension), base = Math.floor(v.location.y + 1e-6);
      const yaw = v.rotation.y * Math.PI / 180, fx = -Math.sin(yaw), fz = Math.cos(yaw), ahead = Number(step['ahead'] ?? 6);
      const lo = Number(step['lo'] ?? 4), hi = Number(step['hi'] ?? 16), rise = Number(step['rise'] ?? 1);
      const block = ctx.sim.host.resolvePermutation(pack.placement.colliders?.block ?? 'craftmatic:collider', { [pack.placement.colliders?.loState ?? 'craftmatic:lo']: lo, [pack.placement.colliders?.hiState ?? 'craftmatic:hi']: hi });
      for (let d = 0; d < 5; d++) for (let side = -3; side <= 3; side++) {
        const x = Math.floor(v.location.x + fx * (ahead + d) - fz * side), z = Math.floor(v.location.z + fz * (ahead + d) + fx * side);
        w.setPermutation(x, base + rise, z, block);
      }
      ctx.note(`fixture overhang: ${pack.placement.colliders?.block ?? 'craftmatic:collider'}[${lo},${hi}] at y ${base + rise}, ${ahead}-${ahead + 4} blocks ahead of ${type} at ${JSON.stringify(pt(v.location))}`);
      let lowest = v.location.y;
      for (let t = 0; t < Number(step['ticks'] ?? 120) && ctx.player.ridingOn === v; t++) {
        ctx.player.rotation.y = v.rotation.y;
        ctx.sim.controls.set(ctx.player.id, { forward: 0.6, strafe: 0 });
        await ctx.run(1);
        lowest = Math.min(lowest, v.location.y);
      }
      ctx.sim.controls.set(ctx.player.id, { forward: 0 });
      ctx.note(`drove under the fixture: ended at ${JSON.stringify(pt(v.location))}, lowest y ${r3(lowest)}`);
      await ctx.run(20);
    },

    /** Summon a flyer mount by a tap on its companion, climb, fly, sneak off in the air: `{ climbTicks, flyTicks }`. */
    async flyMount(step: AnyStep, ctx: StepContext) {
      const mount = pack.flyers[0];
      if (!mount) throw new Error('flyMount: the pack has no flyer mount');
      const companion = findEntity(ctx.sim, ctx.player, { where: e => mount.summonTypes.includes(e.typeId) && e.typeId !== mount.cloudType });
      if (!companion) throw new Error('flyMount: no companion to tap');
      await CORE_HANDLERS['tap']!({ kind: 'tap', target: { where: (e: SimEntity) => e === companion, label: companion.typeId } }, ctx);
      for (let t = 0; t < 20 && !ctx.player.ridingOn; t++) await ctx.run(1);
      if (!ctx.player.ridingOn) { ctx.violate({ invariant: 'mount-summoned', message: `a tap on ${companion.typeId} put the player on no mount` }); return; }
      await CORE_HANDLERS['jumpHold']!({ kind: 'jumpHold', ticks: Number(step['climbTicks'] ?? 60) }, ctx);
      await CORE_HANDLERS['drive']!({ kind: 'drive', hold: { forward: 1, ticks: Number(step['flyTicks'] ?? 40) } }, ctx);
      ctx.state['flyAltitude'] = r3(ctx.player.location.y);
      await CORE_HANDLERS['sneak']!({ kind: 'sneak' }, ctx);
      for (let t = 0; t < 1200 && !ctx.player.onGround; t++) await ctx.run(1);
      await ctx.run(20);
    },

    /** Walk the device's line through every doorway passable at the placed size (the door tapped open first): `{ only?: number[] }`. */
    async doorwayLines(step: AnyStep, ctx: StepContext) {
      const ix = pack.interactives;
      if (!ix) return;
      const placed = placedOf(ctx), f = placed.sizePct / 100, k = Math.max(1, f);
      const only = step['only'] as number[] | undefined;
      const statics = staticDrawn(ctx, appearance, pack), treads = treadKeys(ctx, pack);
      for (let i = 0; i < ix.items.length; i++) {
        const it = ix.items[i]!;
        if (only && !only.includes(i)) continue;
        if (it.passSize === undefined || !it.leaf || !it.passSize || placed.sizePct < it.passSize) continue;
        const leafEntity = findEntity(ctx.sim, ctx.player, { where: e => e.dynamic.get(IX_KEYS.index) === i });
        if (!leafEntity) { ctx.note(`${it.label}: no entity`); continue; }
        if (leafEntity.dynamic.get(IX_KEYS.open) !== true) await tapPart(ctx, leafEntity, it.label, () => leafEntity.dynamic.get(IX_KEYS.open) === true);
        if (leafEntity.dynamic.get(IX_KEYS.open) !== true) { ctx.note(`${it.label}: no tap from any spot within reach opened it; its lines are not walked`); continue; }
        // A double door's other leaf must be open too (the pair moves together, but a leaf tapped on its own can leave it shut).
        for (const j of it.pairs ?? []) {
          const other = findEntity(ctx.sim, ctx.player, { where: e => e.dynamic.get(IX_KEYS.index) === j });
          if (other && other.dynamic.get(IX_KEYS.open) !== true) await tapPart(ctx, other, ix.items[j]?.label ?? `part ${j}`, () => other.dynamic.get(IX_KEYS.open) === true);
          if (other && other.dynamic.get(IX_KEYS.open) !== true) ctx.note(`${it.label}: its pair ${ix.items[j]?.label ?? j} stays shut`);
        }
        // The harness's doorway (`doorwayGeometry`): the columns of the leaf's closed blocks at this size and turn,
        // the doorway's floor the lowest closed bottom, the walk's normal. Until 2026-09-30 the lines read the leaf's
        // corner `c` as the floor, which is the leaf's TOP when it hangs down (`u` negative: 60380's Door 1), and
        // sampled their own columns along the leaf.
        const geo = doorwayGeometry({ dims: ix.dims }, it, f, placed.rotation as QuarterTurn);
        if (!geo.own.length) { ctx.note(`${it.label}: no closed blocks at ${placed.sizePct} percent; its lines are not walked`); continue; }
        const n = geo.n, floorY = placed.anchor.y + geo.centre.y;
        const columns = new Map<string, Vec3>();
        for (const b of geo.own) columns.set(`${b.x},${b.z}`, { x: placed.anchor.x + b.x + 0.5, y: floorY, z: placed.anchor.z + b.z + 0.5 });
        // Two starts per column and side: the harness's (`LINE_OUT` in to `LINE_MIN_OUT`) and the device round's
        // "porch", a teleport PORCH_OUT blocks out at the doorway's height (10326 Door 1 on the Saga, 29c).
        for (const side of [-1, 1] as const) {
          const outcomes: LineOutcome[] = [];
          for (const col of columns.values()) {
            outcomes.push(await deviceLine(ctx, statics, treads, it.label, col, n, side, floorY, k, LINE_OUT, LINE_MIN_OUT, 'line'));
            outcomes.push(await deviceLine(ctx, statics, treads, it.label, col, n, side, floorY, k, PORCH_OUT, PORCH_OUT, 'porch'));
          }
          judgeSide(ctx, outcomes);
        }
      }
    },

    /** Let the figures live: `{ ticks }`; each must stay inside the model's box. */
    async figuresLive(step: AnyStep, ctx: StepContext) {
      const placed = placedOf(ctx), ticks = Number(step['ticks'] ?? 6000);
      // The child steps back out of the way (a figure yields a seat to a player within reach).
      teleport(ctx.sim.host, ctx.player, { x: placed.from.x - 6.5, y: placed.from.y, z: placed.from.z - 6.5 });
      const figs = [...ctx.sim.engine.entities.values()].filter(e => e.valid && /_fig\d+$/.test(e.typeId));
      const out = new Set<string>();
      for (let t = 0; t < ticks; t += 20) {
        await ctx.run(20);
        for (const fg of figs) {
          // A figure on a mount is where its mount takes it: the flyer companion's orbit runs outside the model on purpose.
          if (!fg.valid || out.has(fg.id) || fg.ridingOn) continue;
          const l = fg.location;
          if (l.x < placed.from.x - 1 || l.x > placed.to.x + 2 || l.z < placed.from.z - 1 || l.z > placed.to.z + 2 || l.y < placed.from.y - 1) {
            out.add(fg.id);
            ctx.violate({ invariant: 'figures-stay', message: `${fg.typeId} left the model's box`, evidence: { at: pt(l), box: { from: placed.from, to: placed.to } } });
          }
        }
      }
      ctx.note(`figures lived ${ticks} ticks: ${figs.length} figures, ${figs.filter(fg => fg.ridingOn).length} seated at the end`);
    },
  };
}

/**
 * Columns of the placement where a car fits UNDER something: a floor within a
 * block of the vehicle's own base, open above it for at least a block, then a
 * collider span whose underside is 1 to 3 blocks over the floor. Nearest the
 * vehicle first; one per 2 x 2 area.
 */
function overhangTargets(ctx: StepContext, v: SimEntity): Vec3[] {
  const placed = placedOf(ctx), w = ctx.sim.engine.dimension(v.dimension), base = v.location.y;
  const out: Vec3[] = [], seen = new Set<string>();
  for (let x = placed.from.x; x <= placed.to.x; x++) for (let z = placed.from.z; z <= placed.to.z; z++) {
    const floor = w.supportBelow(x + 0.5, base + 1, z + 0.5, 4);
    if (!Number.isFinite(floor) || Math.abs(floor - base) > 1) continue;
    let under = Infinity;
    for (let y = Math.floor(floor + 0.01); y <= Math.floor(floor) + 4; y++) {
      for (const b of w.shapeAt(x, y, z).collision) { const y0 = y + b.y0; if (y0 >= floor + 0.01 && y0 < under) under = y0; }
    }
    const clear = under - floor;
    if (clear < 1 || clear > 3) continue;
    const key = `${x >> 1},${z >> 1}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: x + 0.5, y: floor, z: z + 0.5 });
  }
  return out.sort((a, b) => Math.hypot(a.x - v.location.x, a.z - v.location.z) - Math.hypot(b.x - v.location.x, b.z - v.location.z));
}

/**
 * Steer a ridden scripted vehicle toward a point with the stick: forward, and
 * the stick's side against the heading error (the car runtime steers by the
 * stick's x). Stops at the point, after `maxTicks`, or when the car stalls.
 */
async function driveTo(ctx: StepContext, v: SimEntity, target: Vec3, maxTicks: number): Promise<void> {
  let stall = 0, last = { ...v.location };
  for (let t = 0; t < maxTicks && ctx.player.ridingOn === v; t++) {
    const dx = target.x - v.location.x, dz = target.z - v.location.z, dist = Math.hypot(dx, dz);
    if (dist < 0.6) break;
    const want = lookAngles({ x: dx, y: 0, z: dz }).yaw;
    const err = ((want - v.rotation.y + 540) % 360) - 180;
    ctx.player.rotation.y = v.rotation.y;
    ctx.sim.controls.set(ctx.player.id, { forward: dist < 3 ? 0.5 : 1, strafe: Math.max(-1, Math.min(1, -err / 30)), jump: false });
    await ctx.run(1);
    if (Math.hypot(v.location.x - last.x, v.location.z - last.z) < 0.005) { if (++stall > 40) break; } else stall = 0;
    last = { ...v.location };
  }
  ctx.sim.controls.set(ctx.player.id, { forward: 0, strafe: 0 });
  await ctx.run(20);
  ctx.note(`drove toward the overhang at ${JSON.stringify(pt(target))}: ended ${r3(Math.hypot(target.x - v.location.x, target.z - v.location.z))} blocks from it at ${JSON.stringify(pt(v.location))}`);
}

/** A craftmatic figure's entity type (`..._fig<N>`). */
export const FIGURE_TYPE = /_fig\d+$/;

/**
 * Every drawn box the placement's STATIC collider grid stands for, for attributing a doorway fall or stop:
 * the static actors (the shell and props) and every moving part that is NOT a passage (a window, cabinet,
 * lever, turnable or hinged section: "their closed part boxes stay in the static colliders",
 * docs/bedrock-interactivity.md) at its pose when first read - read it before any tap, while the parts
 * stand as the placement laid them (closed). Doors and gates are left out: the runtime re-lays their
 * cells (air when open). Figures are left out: they walk, and no collider stands for them. Until
 * 2026-09-30 every moving part was left out, so a collider standing for 41395's closed hinged section
 * read as "nothing is drawn there, the pack's colliders".
 */
export function staticDrawn(ctx: StepContext, appearance: AddonAppearance, pack: CraftmaticPack): DrawnBox[] {
  const key = 'craftmatic.staticDrawn';
  const cached = ctx.state[key] as DrawnBox[] | undefined;
  if (cached) return cached;
  const out: DrawnBox[] = [];
  for (const e of ctx.sim.engine.entities.values()) {
    if (!e.valid || e.isPlayer || FIGURE_TYPE.test(e.typeId)) continue;
    const ix = e.dynamic.get(IX_KEYS.index);
    if (typeof ix === 'number' && (pack.interactives?.items[ix]?.blocking.length ?? 0) > 0) continue;
    const d = entityDrawn(appearance, e);
    if (d) out.push(...d);
  }
  ctx.state[key] = out;
  return out;
}

/**
 * Tap a moving part until it answers, as a child would: from the nearest spot
 * that picks it, then - when the runtime refused (a part tapped from behind its
 * wall says so on the action bar) - from the next spot, up to four. Returns
 * whether `changed` became true.
 */
export async function tapPart(ctx: StepContext, part: SimEntity, label: string, changed: () => boolean): Promise<boolean> {
  const tried: Vec3[] = [], log: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    // After a refusal the child steps IN FRONT of the part (where nothing solid hides it), as the refusal tells it to.
    const spot = attempt === 0 ? undefined : findApproach(ctx.sim.engine, ctx.player, part, undefined, tried, { inFront: true });
    if (attempt > 0) { if (!spot) break; teleport(ctx.sim.host, ctx.player, spot.feet); await ctx.run(1); }
    await CORE_HANDLERS['tap']!({ kind: 'tap', target: { where: (e: SimEntity) => e === part, label } }, ctx);
    tried.push({ ...ctx.player.location });
    const picked = (ctx.state['lastTap'] as { entity?: SimEntity; blockedBy?: string } | undefined);
    log.push(`${attempt === 0 ? 'here' : `spot ${attempt}`} ${JSON.stringify(pt(ctx.player.location))}: ${picked?.entity === part ? 'picked it' : picked?.entity ? `picked ${picked.entity.typeId}` : picked?.blockedBy ? `a block ${picked.blockedBy}` : 'picked nothing'}`);
    await ctx.run(10);
    if (changed()) return true;
  }
  ctx.note(`${label}: no tap changed it; ${log.join('; ') || 'no spot to tap from'}`);
  return false;
}

/** A doorway finding for the report (the model's, or the pack's). */
export interface DoorwayFinding { kind: 'HOLE' | 'STOP'; where: string; model: boolean; [k: string]: unknown }
/** The doorway findings a scenario collected. */
export const doorwayFindings = (state: Record<string, unknown>): DoorwayFinding[] => (state['doorwayFindings'] as DoorwayFinding[] | undefined) ?? [];
const finding = (ctx: StepContext, f: DoorwayFinding): void => { ctx.state['doorwayFindings'] = [...doorwayFindings(ctx.state), f]; };

/** How far (blocks) drawn geometry may sit from a collider that stands for it: the colliders are supersets on a 1/16 grid, their forms a quarter block at the coarsest. */
export const COLLIDER_SLACK = 0.25;

/**
 * Whether every solid a box meets stands for drawn geometry: each collider box the probe overlaps has a drawn
 * cube within `COLLIDER_SLACK` of it (a collider is a superset of its geometry), plus `shift` horizontally - the
 * re-lay's rounding at the placed size (`relayRounding`: a wall re-laid at 150 % lands up to half a block from
 * the geometry it stands for). No solid at all counts as the model's (nothing of the pack's is in the way).
 */
function colliderIsModels(w: VoxelWorld, statics: readonly DrawnBox[], probe: Box, shift = 0): boolean {
  const g = COLLIDER_SLACK, h = g + shift;
  const solids = w.solidsNear(probe, 0, 0, 0).filter(sd => !sd.unloaded && sd.x1 > probe.x0 + 1e-3 && sd.x0 < probe.x1 - 1e-3 && sd.y1 > probe.y0 + 1e-3 && sd.y0 < probe.y1 - 1e-3 && sd.z1 > probe.z0 + 1e-3 && sd.z0 < probe.z1 - 1e-3);
  return solids.every(sd => boxHits(statics, { x0: sd.x0 - h, y0: sd.y0 - g, z0: sd.z0 - h, x1: sd.x1 + h, y1: sd.y1 + g, z1: sd.z1 + h }));
}

/**
 * The world blocks the placement's TREAD plan wrote (invisible steps the planner lays above 100 %,
 * `bedrock-collider-scale.ts`), keyed "x,y,z". A collider that is a tread stands for no geometry by
 * design, so a doorway line it stops is the pack's, and the report names the tread as the cause.
 */
function treadKeys(ctx: StepContext, pack: CraftmaticPack): ReadonlySet<string> {
  const placed = placedOf(ctx), key = `craftmatic.treads.${placed.sizePct}:${placed.rotation}`;
  const cached = ctx.state[key] as Set<string> | undefined;
  if (cached) return cached;
  const out = new Set<string>();
  if (pack.placement.colliders) {
    for (const b of treadBlocksFor(pack.placement.colliders, placed.sizePct, placed.rotation as QuarterTurn)) out.add(`${placed.anchor.x + b.x},${placed.anchor.y + b.y},${placed.anchor.z + b.z}`);
  }
  ctx.state[key] = out;
  return out;
}

/** The tread blocks among the solids a box overlaps ("x,y,z" of each). */
function treadsIn(w: VoxelWorld, treads: ReadonlySet<string>, probe: Box): string[] {
  if (!treads.size) return [];
  const out = new Set<string>();
  for (const sd of w.solidsNear(probe, 0, 0, 0)) {
    if (sd.unloaded || !sd.block) continue;
    if (!(sd.x1 > probe.x0 + 1e-3 && sd.x0 < probe.x1 - 1e-3 && sd.y1 > probe.y0 + 1e-3 && sd.y0 < probe.y1 - 1e-3 && sd.z1 > probe.z0 + 1e-3 && sd.z0 < probe.z1 - 1e-3)) continue;
    const k = `${sd.block.x},${sd.block.y},${sd.block.z}`;
    if (treads.has(k)) out.add(k);
  }
  return [...out];
}

/** The device round's "porch": a teleport this far out (blocks at 100 %) at the doorway's height, then a walk in. */
export const PORCH_OUT = 2.5;

const boxHits = (boxes: readonly DrawnBox[], q: Box): boolean => boxes.some(({ box: b }) => b.x1 > q.x0 && b.x0 < q.x1 && b.y1 > q.y0 && b.y0 < q.y1 && b.z1 > q.z0 && b.z0 < q.z1);

/**
 * What one device line did. A HOLE is judged at once (a fall anywhere a child walks is a fall); a STOP the pack
 * is blamed for is `pending` until the side is judged (`judgeSide`).
 */
export interface LineOutcome { crossed: boolean; pending?: { message: string; evidence: Record<string, unknown> } }

/**
 * Judge one side of a doorway from its lines. A child STEERS through a doorway: a straight line in one column
 * that meets a jamb, a step or a re-laid wall while another column from the same side crosses is not a door
 * nobody can use - the harness judges passability by a route (`walkThroughDoorway`) and only holes by its
 * lines (`doorwayHoles`). So a pack-attributed stop is a violation only when NO line from that side crossed;
 * otherwise it is a note (the finding is kept, marked `steered`). Until 2026-09-30 every stopped column was
 * a violation, and 38 of the favourites' 66 doorway findings were edge columns of doorways a child walks through.
 */
export function judgeSide(ctx: Pick<StepContext, 'note' | 'violate' | 'state'>, outcomes: readonly LineOutcome[]): void {
  const crossed = outcomes.some(o => o.crossed);
  for (const o of outcomes) {
    if (!o.pending) continue;
    if (crossed) ctx.note(`${o.pending.message} - but another column from this side crosses (a child steers through it; not a failure)`);
    else ctx.violate({ invariant: 'doorway-line', message: `${o.pending.message}; no column from this side crosses`, evidence: o.pending.evidence });
  }
  if (crossed) for (const f of doorwayFindings(ctx.state)) if (outcomes.some(o => o.pending && f['pendingMessage'] === o.pending.message)) f['steered'] = true;
}

/** Why a stop is the pack's: its treads, or colliders with nothing drawn near them. */
function stopCause(tread: readonly string[]): string {
  return tread.length ? `the pack's TREAD at ${tread.join(' ')} blocks it` : 'nothing is drawn there, the pack\'s colliders block it';
}

/** How a stop's obstacle is the model's: as drawn, or within the re-lay's rounding of what is drawn. */
function modelsObstacle(w: VoxelWorld, statics: readonly DrawnBox[], probe: Box, rounding: number): 'drawn' | 'relay' | undefined {
  if (colliderIsModels(w, statics, probe)) return 'drawn';
  return rounding > 0 && colliderIsModels(w, statics, probe, rounding) ? 'relay' : undefined;
}

/** The note for an obstacle the model draws. */
const sealedText = (how: 'drawn' | 'relay', rounding: number, sizePct: number): string => how === 'drawn'
  ? 'the model draws geometry where the player\'s box needs room (SEALED)'
  : `the model draws geometry within ${rounding} block of it, the shift of the whole-block re-lay at ${sizePct} percent (SEALED, RELAY)`;

/**
 * One device line: stand the player `LINE_OUT` blocks out on one side, at the
 * doorway's floor (in the air if nothing is there - the device's teleport),
 * and walk straight through, jumping where a jump helps. A fall past a jump
 * within a block of the leaf is attributed and reported at once; a stop is
 * attributed and returned for its side to judge.
 */
async function deviceLine(ctx: StepContext, statics: readonly DrawnBox[], treads: ReadonlySet<string>, label: string, col: Vec3, n: { x: number; z: number }, side: -1 | 1, floorY: number, k: number, outMax: number, outMin: number, kind: 'line' | 'porch'): Promise<LineOutcome> {
  const p = ctx.player, w = ctx.sim.engine.dimension(p.dimension), placed = placedOf(ctx), rounding = relayRounding(placed.sizePct / 100);
  const along = (q: Vec3): number => ((q.x - col.x) * n.x + (q.z - col.z) * n.z) * -side;
  // The start, as the harness (`doorwayColumnLines`) and the device's teleport pick it: the farthest spot from
  // `LINE_OUT` in to `LINE_MIN_OUT` where the player's box is free within a jump over the doorway's floor - in
  // the air when nothing is there (the device's "porch" on 10326 was a teleport into the air).
  let start: Vec3 | undefined;
  for (let out = outMax * k; out >= outMin * k - 1e-9 && !start; out -= 1 / 8) {
    for (let up = 0.01; up <= 1.25 * k + 1e-9; up += 1 / 16) {
      const q = { x: col.x + n.x * side * out, y: floorY + up, z: col.z + n.z * side * out };
      if (!w.overlapping({ x0: q.x - 0.3, y0: q.y, z0: q.z - 0.3, x1: q.x + 0.3, y1: q.y + 1.8, z1: q.z + 0.3 }, 0.001)) { start = q; break; }
    }
  }
  const where = `${label} column ${Math.floor(col.x)},${Math.floor(col.z)} from ${side > 0 ? '+' : '-'} side${kind === 'porch' ? ` (porch, ${outMax} out)` : ''}`;
  if (!start && kind === 'porch') return { crossed: false };
  if (!start) {
    // Who took the room: the colliders the player's box meets at the harness's start, each judged by whether the
    // model draws geometry within a collider's superset slack of it.
    const q = { x: col.x + n.x * side * outMax * k, z: col.z + n.z * side * outMax * k };
    const standBox = { x0: q.x - 0.3, y0: floorY + 0.05, z0: q.z - 0.3, x1: q.x + 0.3, y1: floorY + 1.8, z1: q.z + 0.3 };
    const how = modelsObstacle(w, statics, standBox, rounding);
    const tread = treadsIn(w, treads, standBox);
    if (how) { ctx.note(`${where}: no room to stand ${LINE_MIN_OUT}-${LINE_OUT} blocks out - the MODEL's: ${sealedText(how, rounding, placed.sizePct)}`); finding(ctx, { kind: 'STOP', where, model: true, noRoom: true, ...(how === 'relay' ? { relay: true } : {}) }); return { crossed: false }; }
    const message = `${where}: no room to stand on this side; ${stopCause(tread)}`;
    finding(ctx, { kind: 'STOP', where, model: false, noRoom: true, pendingMessage: message, ...(tread.length ? { tread } : {}) });
    return { crossed: false, pending: { message, evidence: { treads: tread } } };
  }
  ctx.quiet(['no-unprotected-fall', 'player-not-in-solid']);
  teleport(ctx.sim.host, p, start);
  p.onGround = false;
  const end = { x: col.x - n.x * side * 1.5 * k, z: col.z - n.z * side * 1.5 * k };
  let lowestNear = floorY, best = -Infinity, stall = 0, last = -Infinity, fellAt: Vec3 | undefined, stoppedAt: Vec3 | undefined;
  // Where the feet lost the doorway's level: the first point off the ground after the last one standing at it
  // (the start itself when the line began over nothing - the device's teleport into the air).
  let lostAt: Vec3 = { ...start }, standing = false;
  // The harness's line (`doorwayColumnLines`) jumps where a jump helps (`jumpHelps`: blocked at the feet a
  // short reach ahead, free a jump up - a sill, a step, a tread); so does a child. A line that never jumped
  // stopped at every riser past the step height and reported it as a wall (2026-09-30 triage).
  let jump = false, jumps = 0;
  for (let t = 0; t < 200; t++) {
    p.rotation.y = lookAngles({ x: end.x - p.location.x, y: 0, z: end.z - p.location.z }).yaw;
    ctx.sim.controls.set(p.id, { forward: 1, strafe: 0, jump });
    const before = { ...p.location };
    await ctx.run(1);
    const dx = end.x - p.location.x, dz = end.z - p.location.z, dl = Math.hypot(dx, dz) || 1;
    const movedH = Math.hypot(p.location.x - before.x, p.location.z - before.z);
    jump = p.onGround && movedH < 0.1 && jumpHelps(w, p.location, dx / dl, dz / dl);
    if (jump) jumps++;
    const atLevel = p.onGround && p.location.y >= floorY - STEP_HEIGHT - 1e-6;
    if (atLevel) standing = true;
    else if (standing && !p.onGround) { lostAt = before; standing = false; }
    const a = along(p.location);
    if (Math.abs(a) <= 1.0 * k && p.location.y < lowestNear) { lowestNear = p.location.y; if (floorY - lowestNear > JUMP_PEAK * k) fellAt ??= { ...p.location }; }
    best = Math.max(best, a);
    if (a >= 1.5 * k) break;
    if (a > last + 1e-3) { last = a; stall = 0; } else if (++stall > 30) { stoppedAt = { ...p.location }; break; }
  }
  ctx.sim.controls.set(p.id, { forward: 0 });
  await ctx.run(2);
  ctx.quiet([]);
  const drop = floorY - lowestNear;
  if (fellAt) {
    // Attribute: does the model DRAW a floor at the doorway's level where the feet lost it? A drawn top within a
    // step under the doorway's floor, under the footprint a little ahead of that point, is a floor the colliders lost;
    // nothing drawn there is the model's own hole (or a start over nothing). Above 100 % the re-lay can move the
    // floor's edge by `relayRounding` (half a block at 150 %): when the drawn floor itself ends within that distance
    // further on, the drop is the model's own edge, moved by the re-lay (31141's upper doors open over the street).
    const drawnFloorAt = (d: number): boolean => {
      const q = { x: lostAt.x - n.x * side * d, z: lostAt.z - n.z * side * d };
      return statics.some(({ box: b }) => b.y1 >= floorY - STEP_HEIGHT && b.y1 <= floorY + 0.1 && b.x1 > q.x - 0.3 && b.x0 < q.x + 0.3 && b.z1 > q.z - 0.3 && b.z0 < q.z + 0.3);
    };
    const drawnFloor = drawnFloorAt(0.3);
    const edgeMoved = drawnFloor && rounding > 0 && !drawnFloorAt(0.3 + rounding);
    const text = `${where}: fell ${r3(drop)} blocks at the door plane (HOLE)`;
    const evidence = { start: pt(start), lostAt: pt(lostAt), fellAt: pt(fellAt), floorY: r3(floorY), lowest: r3(lowestNear), jumps };
    if (drawnFloor && !edgeMoved) ctx.violate({ invariant: 'doorway-line', message: `${text}; the model draws a floor where the feet lost it, the pack's colliders do not`, evidence });
    else if (edgeMoved) ctx.note(`${text} - the MODEL's drop: its drawn floor ends within ${rounding} block of where the feet lost it, the edge the ${placed.sizePct} percent re-lay moves (RELAY)`);
    else ctx.note(`${text} - the MODEL's: nothing is drawn at the doorway's level where the feet lost it (${standing || lostAt !== start ? `at ${JSON.stringify(pt(lostAt))}` : 'the line started over nothing'}; landed y ${r3(lowestNear)})`);
    finding(ctx, { kind: 'HOLE', where, drop: r3(drop), model: !drawnFloor || edgeMoved, ...(edgeMoved ? { relay: true } : {}), start: pt(start), lostAt: pt(lostAt), landed: r3(lowestNear) });
    return { crossed: false };
  }
  if (best >= 0.7 * k) return { crossed: true };
  const at = stoppedAt ?? p.location;
  // What stopped it: the collider the box meets a step ahead. A collider is a SUPERSET of the geometry it stands for
  // (up to its sixteenth grid and its form's shape), so drawn geometry within `COLLIDER_SLACK` of the box ahead makes
  // the obstacle the model's.
  const ahead = { x: at.x - n.x * side * 0.15, z: at.z - n.z * side * 0.15 };
  const probe = { x0: ahead.x - 0.3, y0: at.y + 0.05, z0: ahead.z - 0.3, x1: ahead.x + 0.3, y1: at.y + 1.8, z1: ahead.z + 0.3 };
  const hit = w.overlapping(probe, 0.001);
  const how = modelsObstacle(w, statics, probe, rounding);
  const tread = treadsIn(w, treads, probe);
  const text = `${where}: stopped ${r3(-Math.min(0, best))} blocks before the door plane${hit?.block ? ` on ${hit.block.typeId} at ${hit.block.x},${hit.block.y},${hit.block.z}` : ''}`;
  if (how) {
    ctx.note(`${text} - the MODEL's: ${sealedText(how, rounding, placed.sizePct)}`);
    finding(ctx, { kind: 'STOP', where, model: true, start: pt(start), stoppedAt: pt(at), block: hit?.block, ...(how === 'relay' ? { relay: true } : {}) });
    return { crossed: false };
  }
  const message = `${text}; ${stopCause(tread)}`;
  finding(ctx, { kind: 'STOP', where, model: false, pendingMessage: message, start: pt(start), stoppedAt: pt(at), block: hit?.block, ...(tread.length ? { tread } : {}) });
  return { crossed: false, pending: { message, evidence: { start: pt(start), stoppedAt: pt(at), treads: tread, jumps } } };
}
