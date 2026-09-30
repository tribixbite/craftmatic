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
import { LINE_MIN_OUT, LINE_OUT } from '../../../engine/interactive-walk.js';
import type { AddonAppearance } from './appearance.js';
import { entityDrawn, forwardViewWorld, type DrawnBox } from './drawn.js';
import { modelDirToWorld, modelToWorld, type CraftmaticPack, type Placed } from './pack-facts.js';
import { PLACED_KEY } from './wand.js';

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
      const drawn = staticDrawn(ctx, appearance);
      // The seat must run IN the chute: never over the surface the model draws directly under it (29b ran on the
      // side rails, 30 LDU over the bed). # TODO(sim-slide): the drawn slope is coarse (its cubes step by a few LDU),
      // so the margin between a seat on the bed and one on the rails is small; part-level geometry would settle it.
      let ticks = 0, worst = -Infinity, worstAt: Vec3 | undefined, reported = false;
      for (; ticks < 600 && ctx.player.ridingOn; ticks++) {
        await ctx.run(1);
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
      const statics = staticDrawn(ctx, appearance);
      for (let i = 0; i < ix.items.length; i++) {
        const it = ix.items[i]!;
        if (only && !only.includes(i)) continue;
        if (it.passSize === undefined || !it.leaf || !it.passSize || placed.sizePct < it.passSize) continue;
        const leafEntity = findEntity(ctx.sim, ctx.player, { where: e => e.dynamic.get(IX_KEYS.index) === i });
        if (!leafEntity) { ctx.note(`${it.label}: no entity`); continue; }
        if (leafEntity.dynamic.get(IX_KEYS.open) !== true) await tapPart(ctx, leafEntity, it.label, () => leafEntity.dynamic.get(IX_KEYS.open) === true);
        if (leafEntity.dynamic.get(IX_KEYS.open) !== true) { ctx.note(`${it.label}: no tap from any spot within reach opened it; its lines are not walked`); continue; }
        const leaf = it.leaf;
        const c = { x: leaf.c[0]!, y: leaf.c[1]!, z: leaf.c[2]! }, a = { x: leaf.a[0]!, y: leaf.a[1]!, z: leaf.a[2]! };
        const nW = modelDirToWorld(pack.placement, placed, { x: leaf.n[0]!, y: 0, z: leaf.n[2]! });
        const nl = Math.hypot(nW.x, nW.z) || 1, n = { x: nW.x / nl, z: nW.z / nl };
        const floorY = modelToWorld(pack.placement, placed, c).y;
        const columns = new Map<string, Vec3>();
        for (let s = 0.1; s < 1; s += 0.2) {
          const q = modelToWorld(pack.placement, placed, { x: c.x + a.x * s, y: c.y, z: c.z + a.z * s });
          columns.set(`${Math.floor(q.x)},${Math.floor(q.z)}`, { x: Math.floor(q.x) + 0.5, y: floorY, z: Math.floor(q.z) + 0.5 });
        }
        // Two starts per column and side: the harness's (`LINE_OUT` in to `LINE_MIN_OUT`) and the device round's
        // "porch", a teleport PORCH_OUT blocks out at the doorway's height (10326 Door 1 on the Saga, 29c).
        for (const col of columns.values()) for (const side of [-1, 1] as const) {
          await deviceLine(ctx, statics, it.label, col, n, side, floorY, k, LINE_OUT, LINE_MIN_OUT, 'line');
          await deviceLine(ctx, statics, it.label, col, n, side, floorY, k, PORCH_OUT, PORCH_OUT, 'porch');
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
          if (!fg.valid || out.has(fg.id)) continue;
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

/** Every drawn box of the placement's static actors (the shell and props), for attributing a doorway fall. */
function staticDrawn(ctx: StepContext, appearance: AddonAppearance): DrawnBox[] {
  const key = 'craftmatic.staticDrawn';
  const cached = ctx.state[key] as DrawnBox[] | undefined;
  if (cached) return cached;
  const out: DrawnBox[] = [];
  for (const e of ctx.sim.engine.entities.values()) {
    if (!e.valid || e.isPlayer || e.dynamic.has(IX_KEYS.index)) continue;
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
  const tried: Vec3[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const spot = attempt === 0 ? undefined : findApproach(ctx.sim.engine, ctx.player, part, undefined, tried);
    if (attempt > 0) { if (!spot) break; teleport(ctx.sim.host, ctx.player, spot.feet); await ctx.run(1); }
    await CORE_HANDLERS['tap']!({ kind: 'tap', target: { where: (e: SimEntity) => e === part, label } }, ctx);
    tried.push({ ...ctx.player.location });
    await ctx.run(10);
    if (changed()) return true;
  }
  return false;
}

/** A doorway finding for the report (the model's, or the pack's). */
export interface DoorwayFinding { kind: 'HOLE' | 'STOP'; where: string; model: boolean; [k: string]: unknown }
/** The doorway findings a scenario collected. */
export const doorwayFindings = (state: Record<string, unknown>): DoorwayFinding[] => (state['doorwayFindings'] as DoorwayFinding[] | undefined) ?? [];
const finding = (ctx: StepContext, f: DoorwayFinding): void => { ctx.state['doorwayFindings'] = [...doorwayFindings(ctx.state), f]; };

/** How far (blocks) drawn geometry may sit from a collider that stands for it: the colliders are supersets on a 1/16 grid, their forms a quarter block at the coarsest. */
export const COLLIDER_SLACK = 0.25;

/** The device round's "porch": a teleport this far out (blocks at 100 %) at the doorway's height, then a walk in. */
export const PORCH_OUT = 2.5;

const boxHits = (boxes: readonly DrawnBox[], q: Box): boolean => boxes.some(({ box: b }) => b.x1 > q.x0 && b.x0 < q.x1 && b.y1 > q.y0 && b.y0 < q.y1 && b.z1 > q.z0 && b.z0 < q.z1);

/**
 * One device line: stand the player `LINE_OUT` blocks out on one side, at the
 * doorway's floor (in the air if nothing is there - the device's teleport),
 * and walk straight through. A fall past a jump within a block of the leaf,
 * or a stop before crossing, is recorded and attributed.
 */
async function deviceLine(ctx: StepContext, statics: readonly DrawnBox[], label: string, col: Vec3, n: { x: number; z: number }, side: -1 | 1, floorY: number, k: number, outMax: number, outMin: number, kind: 'line' | 'porch'): Promise<void> {
  const p = ctx.player, w = ctx.sim.engine.dimension(p.dimension);
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
  if (!start && kind === 'porch') return;
  if (!start) {
    const q = { x: col.x + n.x * side * LINE_OUT * k, z: col.z + n.z * side * LINE_OUT * k };
    const blocked = boxHits(statics, { x0: q.x - 0.3, y0: floorY + 0.05, z0: q.z - 0.3, x1: q.x + 0.3, y1: floorY + 1.8, z1: q.z + 0.3 });
    ctx.note(`${where}: no room to stand ${LINE_MIN_OUT}-${LINE_OUT} blocks out (${blocked ? 'the model draws geometry there: SEALED, the model\'s' : 'colliders with nothing drawn'})`);
    finding(ctx, { kind: 'STOP', where, model: blocked, noRoom: true });
    if (!blocked) ctx.violate({ invariant: 'doorway-line', message: `${where}: no room to stand on this side, and the model draws nothing there (the pack's colliders)` });
    return;
  }
  ctx.quiet(['no-unprotected-fall', 'player-not-in-solid']);
  teleport(ctx.sim.host, p, start);
  p.onGround = false;
  const end = { x: col.x - n.x * side * 1.5 * k, z: col.z - n.z * side * 1.5 * k };
  let lowestNear = floorY, best = -Infinity, stall = 0, last = -Infinity, fellAt: Vec3 | undefined, stoppedAt: Vec3 | undefined;
  // Where the feet lost the doorway's level: the first point off the ground after the last one standing at it
  // (the start itself when the line began over nothing - the device's teleport into the air).
  let lostAt: Vec3 = { ...start }, standing = false;
  for (let t = 0; t < 200; t++) {
    p.rotation.y = lookAngles({ x: end.x - p.location.x, y: 0, z: end.z - p.location.z }).yaw;
    ctx.sim.controls.set(p.id, { forward: 1, strafe: 0, jump: false });
    const before = { ...p.location };
    await ctx.run(1);
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
    // nothing drawn there is the model's own hole (or a start over nothing).
    const ahead = { x: lostAt.x - n.x * side * 0.3, z: lostAt.z - n.z * side * 0.3 };
    const drawnFloor = statics.some(({ box: b }) => b.y1 >= floorY - STEP_HEIGHT && b.y1 <= floorY + 0.1 && b.x1 > ahead.x - 0.3 && b.x0 < ahead.x + 0.3 && b.z1 > ahead.z - 0.3 && b.z0 < ahead.z + 0.3);
    const text = `${where}: fell ${r3(drop)} blocks at the door plane (HOLE)`;
    if (drawnFloor) ctx.violate({ invariant: 'doorway-line', message: `${text}; the model draws a floor where the feet lost it, the pack's colliders do not`, evidence: { start: pt(start), lostAt: pt(lostAt), fellAt: pt(fellAt), floorY: r3(floorY), lowest: r3(lowestNear) } });
    else ctx.note(`${text} - the MODEL's: nothing is drawn at the doorway's level where the feet lost it (${standing || lostAt !== start ? `at ${JSON.stringify(pt(lostAt))}` : 'the line started over nothing'}; landed y ${r3(lowestNear)})`);
    finding(ctx, { kind: 'HOLE', where, drop: r3(drop), model: !drawnFloor, start: pt(start), lostAt: pt(lostAt), landed: r3(lowestNear) });
  } else if (best < 0.7 * k) {
    const at = stoppedAt ?? p.location;
    // What stopped it: the collider the box meets a step ahead. A collider is a SUPERSET of the geometry it stands for
    // (up to its sixteenth grid and its form's shape), so drawn geometry within `COLLIDER_SLACK` of the box ahead makes
    // the obstacle the model's.
    const ahead = { x: at.x - n.x * side * 0.15, z: at.z - n.z * side * 0.15 };
    const probe = { x0: ahead.x - 0.3, y0: at.y + 0.05, z0: ahead.z - 0.3, x1: ahead.x + 0.3, y1: at.y + 1.8, z1: ahead.z + 0.3 };
    const hit = w.overlapping(probe, 0.001);
    const g = COLLIDER_SLACK;
    const drawn = boxHits(statics, { x0: probe.x0 - g, y0: probe.y0 - g, z0: probe.z0 - g, x1: probe.x1 + g, y1: probe.y1 + g, z1: probe.z1 + g });
    const text = `${where}: stopped ${r3(-Math.min(0, best))} blocks before the door plane${hit?.block ? ` on ${hit.block.typeId} at ${hit.block.x},${hit.block.y},${hit.block.z}` : ''}`;
    if (drawn) ctx.note(`${text} - the MODEL's: it draws geometry where the player's box needs room (SEALED)`);
    else ctx.violate({ invariant: 'doorway-line', message: `${text}; nothing is drawn there, the pack's colliders block it`, evidence: { start: pt(start), stoppedAt: pt(at) } });
    finding(ctx, { kind: 'STOP', where, model: drawn, start: pt(start), stoppedAt: pt(at), block: hit?.block });
  }
}
