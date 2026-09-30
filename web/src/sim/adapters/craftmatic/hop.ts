/**
 * HOP scenarios over BUILT packs (web/src/engine/bedrock-ride-hop.ts): a
 * child flies or drives one pack's driveable into another pack's mountable.
 * Several add-ons are loaded into one world, as on a phone with a few packs
 * active, and every runtime of every pack runs:
 *
 *   hop-flyer-into-coaster   a flyer's cloud (the Nimbus fixture) is flown into
 *                            a MOVING coaster train (10261) at a car behind its
 *                            front: the child must end in the front-most car
 *                            with a free seat, the cloud must stay where it was
 *                            left, the coaster's camera must take the view, and
 *                            exactly one pack may act (a car pack with its own
 *                            hop.js is loaded too);
 *   hop-coaster-full         the same fly-in with a player in every car: the
 *                            cloud flies through and nobody is moved;
 *   hop-slide-into-car       a car (42639) parked at a slide's foot (10788):
 *                            the rider slides into it instead of being set down.
 *
 * Steps (registered by `hopHandlers`): `mountSpawned`, `flyIntoTrain`,
 * `fillTrain`, `slideIntoParked`. Checks, each a named invariant:
 *
 *   hop-boards          the fly-in ended on a coaster car;
 *   hop-front-most      that car is the front-most of its train with a free seat;
 *   hop-source-waits    the mount left behind stays where it was (a native
 *                       cloud hovers; a scripted plane holds);
 *   hop-camera          the new mount's camera took the view within 10 ticks;
 *   hop-once            one hop, one sound, whatever packs are loaded;
 *   hop-no-full         nothing boards a train whose seats players hold;
 *   hop-slide-into-car  a slide's set-down boards the car parked at its foot.
 */

import type { AnyStep, Scenario, StepContext, StepHandler } from '../../scenario/types.js';
import { CORE_HANDLERS, findEntity } from '../../scenario/runner.js';
import type { SimEntity } from '../../entity/entity.js';
import type { Vec3 } from '../../core/vec.js';
import { lookAngles } from '../../core/vec.js';
import { teleport } from '../../script-host/facades.js';
import { quirkValue } from '../../quirks/registry.js';
import { HOP, HOP_TAGS } from '../../../engine/bedrock-ride-hop.js';
import type { Addon } from '../../pack/pack.js';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES, craftmaticHandlers } from './child-play.js';
import { modelToWorld, readCraftmaticPack, type CraftmaticPack } from './pack-facts.js';
import { placedOf } from './play.js';

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const pt = (p: Vec3): Vec3 => ({ x: r3(p.x), y: r3(p.y), z: r3(p.z) });
const COASTER_FAMILY = 'craftmatic_coaster';
/** The sound `scripts/hop.js` plays on a hop (`hopRuntimeConfig`), counted to prove one hop. */
const HOP_SOUND = 'sound note.chime';

/** A tag's value after its prefix, or undefined. */
const tagValue = (e: SimEntity, prefix: string): string | undefined => { for (const t of e.tags) if (t.startsWith(prefix)) return t.slice(prefix.length); return undefined; };
/** A coaster car's rank from the front (its hop tag), or undefined before the coaster tagged it. */
const rankOf = (e: SimEntity): number | undefined => { const v = tagValue(e, HOP_TAGS.rank); return v === undefined ? undefined : Number(v); };
/** Seats a player could still take: seat count less the players aboard (hop.ts `takeable`). */
const freeSeats = (e: SimEntity): number => (e.rideable()?.seatCount ?? 0) - e.riderList().filter(r => r.isPlayer).length;
/** Every coaster car that carries a rideable seat. */
const coasterCars = (ctx: StepContext): SimEntity[] => ctx.sim.engine.loadedEntities(ctx.player.dimension).filter(e => e.families().includes(COASTER_FAMILY) && !!e.rideable());

/**
 * Entities a step hands to a later one (the mount the child was put on, the players filling a train), kept beside
 * the scenario's state rather than in it: the state is written to the JSON report, and an entity is not JSON.
 */
const refs = new WeakMap<object, { source?: SimEntity; riders?: SimEntity[] }>();
const refsOf = (ctx: StepContext): { source?: SimEntity; riders?: SimEntity[] } => { let r = refs.get(ctx.state); if (!r) refs.set(ctx.state, r = {}); return r; };

/** The hop steps. `flyer`: the pack whose mount the child flies (its cloud type); `car`: the pack whose car is parked. */
export function hopHandlers(packs: { flyer?: CraftmaticPack; car?: CraftmaticPack; slide?: CraftmaticPack }): Record<string, StepHandler> {
  return {
    /**
     * Put the child on a new `type` entity (a flyer's summoned cloud) standing `ahead` blocks in front of them
     * and `up` over the ground, boarded as flyer.js boards a summon (addRider two ticks after the spawn).
     */
    async mountSpawned(step: AnyStep, ctx: StepContext) {
      const type = String(step['type'] ?? packs.flyer?.flyers[0]?.cloudType ?? '');
      if (!type) throw new Error('mountSpawned: no type');
      const p = ctx.player, yaw = p.rotation.y * Math.PI / 180, ahead = Number(step['ahead'] ?? 1.5), up = Number(step['up'] ?? 0);
      const e = ctx.sim.engine.spawnEntity(type, p.dimension, { x: p.location.x - Math.sin(yaw) * ahead, y: p.location.y + up, z: p.location.z + Math.cos(yaw) * ahead });
      await ctx.run(2);
      const r = e.addRider(p, ctx.sim.engine.tick);
      if (!r.ok) throw new Error(`mountSpawned: addRider refused (${r.why})`);
      refsOf(ctx).source = e;
      ctx.state['hopSource'] = { type: e.typeId, id: e.id };
      await ctx.run(HOP.BOARD_GRACE_TICKS + 5);
    },

    /** Every car of the coaster gets a player of its own (`Rider<n>`), boarded as a hold would board them. */
    async fillTrain(_step: AnyStep, ctx: StepContext) {
      const cars = coasterCars(ctx);
      if (!cars.length) throw new Error('fillTrain: no coaster car');
      const riders: SimEntity[] = [];
      for (const [i, c] of cars.entries()) {
        const q = ctx.sim.addPlayer(`Rider${i + 1}`, { ...c.location });
        await ctx.run(1);
        if (!c.addRider(q, ctx.sim.engine.tick).ok) throw new Error(`fillTrain: ${c.typeId} refused a rider`);
        riders.push(q);
      }
      refsOf(ctx).riders = riders;
      ctx.state['trainRiders'] = riders.map(q => q.nameTag);
      ctx.note(`fillTrain: ${riders.length} players aboard ${cars.length} cars`);
    },

    /**
     * Fly the ridden mount into a MOVING coaster train. The lead car's path is recorded as the train runs; when the
     * lead passes the recorded point again, the mount is set `side` blocks off it at the track's height and flown at
     * the car BEHIND the lead (steering at where it will be `leadTicks` on, Jump to climb, look down + Jump to
     * descend, as the driver script reads them), until the child is on another mount or `ticks` have passed.
     * `{ expect: 'board' | 'none', side, ticks }`.
     */
    async flyIntoTrain(step: AnyStep, ctx: StepContext) {
      const source = refsOf(ctx).source;
      const p = ctx.player;
      if (!source || p.ridingOn !== source) throw new Error('flyIntoTrain: the child is not on the spawned mount');
      const expectBoard = step['expect'] !== 'none';
      const side = Number(step['side'] ?? 4), maxTicks = Number(step['ticks'] ?? 6000);
      const sim = ctx.sim, controls = sim.controls;
      // 1. The train starts (a placed train dwells at its platform first) and the coaster tags its cars.
      let lead: SimEntity | undefined, t = 0;
      for (; t < 2400 && !lead; t++) {
        await ctx.run(1);
        lead = coasterCars(ctx).find(c => rankOf(c) === 0 && c.valid);
      }
      if (!lead) throw new Error('flyIntoTrain: no coaster car was ever tagged rank 0 (the train never ran)');
      // 2. Record the lead car's path for `recordTicks` of running and pick the point it passed FASTEST (the child flies
      // at a train in full flight, not one creeping out of its station); a straight or level stretch is not needed.
      const path: Vec3[] = [];
      for (let i = 0; i < Number(step['recordTicks'] ?? 1200); i++) { await ctx.run(1); path.push({ ...lead.location }); }
      const stepLen = (i: number): number => Math.hypot(path[i + 1]!.x - path[i]!.x, path[i + 1]!.y - path[i]!.y, path[i + 1]!.z - path[i]!.z);
      let best = -1, bestV = 0;
      for (let i = 20; i < path.length - 21; i++) { const v = stepLen(i); if (v > bestV && v < 3) { bestV = v; best = i; } }
      if (best < 0 || bestV * 20 < 1) throw new Error(`flyIntoTrain: the lead car never ran faster than ${r3(bestV * 20)} blocks/s`);
      const at = path[best]!;
      ctx.note(`flyIntoTrain: the lead car passed ${JSON.stringify(pt(at))} at ${r3(bestV * 20)} blocks/s`);
      // 3. The flight's timing: the mount crosses `side` blocks at its cruise (the hover controller's measured speed, quirk
      // `hover-controller-speed`), so it sets off when the lead is that many ticks (less `lateTicks`, so it meets a car
      // BEHIND the lead) short of the point on its next pass - a circuit's next lap, a shuttle's way back.
      const fs = (source.components['minecraft:flying_speed'] as { value?: number } | undefined)?.value ?? 0.0725;
      const cruise = (quirkValue('hover-controller-speed', 'blocksPerSecondPerFlyingSpeed') * fs + quirkValue('hover-controller-speed', 'offsetBlocksPerSecond')) / 20;
      const k = Math.max(1, Math.min(best, Math.round(side / cruise) - Number(step['lateTicks'] ?? 6)));
      const cue = path[best - k]!;
      let passed = false, prevD = Infinity;
      for (t = 0; t < maxTicks && !passed; t++) {
        await ctx.run(1);
        if (!lead.valid) throw new Error('flyIntoTrain: the lead car is gone');
        const d = Math.hypot(lead.location.x - cue.x, lead.location.y - cue.y, lead.location.z - cue.z);
        passed = prevD < 1.5 && d > prevD;
        prevD = d;
      }
      if (!passed) throw new Error(`flyIntoTrain: the lead car did not come back to ${JSON.stringify(pt(cue))} in ${maxTicks} ticks`);
      // 4. The mount is set `side` blocks off the track (across the lead's heading at the point), at the track's height.
      const next = path[best + 1]!, heading = { x: next.x - at.x, z: next.z - at.z }, hl = Math.hypot(heading.x, heading.z) || 1;
      const across = { x: -heading.z / hl, z: heading.x / hl };
      teleport(sim.host, source, { x: at.x + across.x * side, y: at.y, z: at.z + across.z * side });
      await ctx.run(1);
      const hopsBefore = sim.host.stats.get(HOP_SOUND) ?? 0;
      // 5. Fly onto the track at the point and wait there, as a child who cannot outrun the train flies into its path.
      ctx.note(`flyIntoTrain: the mount set ${side} blocks off the track, setting off ${k} ticks before the lead reaches ${JSON.stringify(pt(at))} (cruise ${r3(cruise * 20)} blocks/s)`);
      const target = lead;
      let hopTick = -1, left: Vec3 | undefined;
      for (t = 0; t < maxTicks; t++) {
        const d = { x: at.x - source.location.x, y: at.y - source.location.y, z: at.z - source.location.z };
        p.rotation.y = lookAngles({ x: d.x, y: 0, z: d.z }).yaw;
        const climb = d.y > 0.4, dive = d.y < -0.4;
        p.rotation.x = dive ? 40 : 0;
        controls.set(p.id, { forward: Math.hypot(d.x, d.z) > 0.3 ? 1 : 0, strafe: 0, jump: climb || dive });
        await ctx.run(1);
        // Where the mount was when the hop took the child off it (it moved this tick before the hop ran).
        if (p.ridingOn && p.ridingOn !== source) { hopTick = sim.engine.tick; left = { ...source.location }; break; }
        if (!expectBoard && t > 400) break;
      }
      // Which car the mount met: the one nearest it when the hop ran (the runtime boards the front-most free one).
      const met = hopTick < 0 ? undefined : coasterCars(ctx).sort((a, b) => Math.hypot(a.location.x - left!.x, a.location.y - left!.y, a.location.z - left!.z) - Math.hypot(b.location.x - left!.x, b.location.y - left!.y, b.location.z - left!.z))[0];
      controls.set(p.id, { forward: 0, strafe: 0, jump: false });
      p.rotation.x = 0;
      const hops = (sim.host.stats.get(HOP_SOUND) ?? 0) - hopsBefore;
      ctx.state['hop'] = { hopTick, hops, at: pt(at), trainSpeed: r3(bestV * 20), ridden: p.ridingOn?.typeId, riddenRank: p.ridingOn ? rankOf(p.ridingOn) : undefined };
      if (!expectBoard) {
        if (hopTick >= 0) ctx.violate({ invariant: 'hop-no-full', message: `the child hopped onto ${p.ridingOn?.typeId} though every car held a player`, evidence: { ridden: p.ridingOn?.typeId } });
        const riders = refsOf(ctx).riders ?? [];
        const moved = riders.filter(q => !q.ridingOn || !q.ridingOn.families().includes(COASTER_FAMILY));
        if (moved.length) ctx.violate({ invariant: 'hop-no-full', message: `${moved.length} train riders were moved off their cars` });
        ctx.note(`flyIntoTrain: flew through the full train; still on ${p.ridingOn?.typeId}`);
        return;
      }
      if (hopTick < 0) { ctx.violate({ invariant: 'hop-boards', message: `the child waited on the track at ${JSON.stringify(pt(at))} for ${maxTicks} ticks and boarded nothing`, evidence: { mount: pt(source.location), lead: pt(target.location) } }); return; }
      const car = p.ridingOn!;
      const train = tagValue(car, HOP_TAGS.train);
      const mates = coasterCars(ctx).filter(c => tagValue(c, HOP_TAGS.train) === train && c !== car);
      const ahead = mates.filter(c => freeSeats(c) > 0 && (rankOf(c) ?? 1e9) < (rankOf(car) ?? 1e9));
      if (!car.families().includes(COASTER_FAMILY)) ctx.violate({ invariant: 'hop-boards', message: `the child hopped onto ${car.typeId}, not a coaster car` });
      if (ahead.length) ctx.violate({ invariant: 'hop-front-most', message: `the child sits in rank ${rankOf(car)} while ${ahead.length} car(s) ahead have a free seat`, evidence: { ranks: ahead.map(rankOf) } });
      if (hops !== 1) ctx.violate({ invariant: 'hop-once', message: `${hops} hop sounds for one hop`, evidence: { hops } });
      // The coaster's rider camera takes the view within 10 ticks, and the mount left behind stays where it was left.
      let camTick = -1;
      for (let i = 0; i < 10 && camTick < 0; i++) { await ctx.run(1); const c = sim.host.playerState(p).camera; if (c.preset && c.tick >= hopTick) camTick = c.tick; }
      if (camTick < 0) ctx.violate({ invariant: 'hop-camera', message: 'no camera was set for the coaster rider in the 10 ticks after the hop' });
      await ctx.run(40);
      const drift = left ? Math.hypot(source.location.x - left.x, source.location.y - left.y, source.location.z - left.z) : 0;
      if (!source.valid || drift > 0.05) ctx.violate({ invariant: 'hop-source-waits', message: `the mount left behind ${source.valid ? `moved ${r3(drift)} blocks` : 'is gone'} within 2 s`, evidence: { left: left && pt(left), now: pt(source.location) } });
      ctx.note(`flyIntoTrain: hopped at tick ${hopTick} from ${source.typeId} onto ${car.typeId} (rank ${rankOf(car)}; nearest the mount when it hopped: ${met?.typeId} rank ${met ? rankOf(met) : '-'}), camera at ${camTick}, the cloud moved ${r3(drift)} blocks in 2 s`);
      ctx.state['hop'] = { ...(ctx.state['hop'] as object), met: met?.typeId, metRank: met ? rankOf(met) : undefined, camTick, drift: r3(drift) };
      // Ride on a while: the invariants (no fall, no script error) keep running with the child aboard.
      await ctx.run(Number(step['rideTicks'] ?? 200));
      if (p.ridingOn !== car) ctx.violate({ invariant: 'hop-boards', message: `the child did not stay on ${car.typeId} (now on ${p.ridingOn?.typeId ?? 'nothing'})` });
    },

    /**
     * Park the car pack's first vehicle beyond the end of slide `index`'s run-out (its box `gap` blocks past the
     * set-down point, facing along the run-out), then ride the slide by a tap: the rider must end in the car.
     */
    async slideIntoParked(step: AnyStep, ctx: StepContext) {
      const slidePack = packs.slide, carPack = packs.car;
      if (!slidePack?.rides || !carPack?.vehicleTypes[0]) throw new Error('slideIntoParked: needs a slide pack and a car pack');
      const index = Number(step['index'] ?? slidePack.rides.rides.find(r => r.kind === 'slide')?.index ?? -1);
      const actor = slidePack.placement.actors.find(a => a.ridePath && (a as { ride?: number }).ride === index);
      const path = actor?.ridePath;
      if (!path || path.length < 2) throw new Error(`slideIntoParked: slide ${index} has no path`);
      const placed = placedOf(ctx);
      const [ax, ay, az] = path[path.length - 2]!, [bx, by, bz] = path[path.length - 1]!;
      const foot = modelToWorld(slidePack.placement, placed, { x: ax, y: ay, z: az }), end = modelToWorld(slidePack.placement, placed, { x: bx, y: by, z: bz });
      const dir = { x: end.x - foot.x, z: end.z - foot.z }, dl = Math.hypot(dir.x, dir.z) || 1;
      const gap = Number(step['gap'] ?? 1);
      const type = carPack.vehicleTypes[0]!;
      const car = ctx.sim.engine.spawnEntity(type, ctx.player.dimension, { x: end.x + dir.x / dl * gap, y: end.y, z: end.z + dir.z / dl * gap });
      car.rotation.y = lookAngles({ x: dir.x, y: 0, z: dir.z }).yaw;
      await ctx.run(4);
      ctx.note(`slideIntoParked: ${type} parked at ${JSON.stringify(pt(car.location))}, ${gap} block(s) past slide ${index + 1}'s set-down ${JSON.stringify(pt(end))}`);
      const seat = findEntity(ctx.sim, ctx.player, { type: slidePack.rides.seatType, where: e => e.dynamic.get('craftmatic:ride') === index });
      if (!seat) throw new Error(`slideIntoParked: no seat for slide ${index}`);
      await CORE_HANDLERS['tap']!({ kind: 'tap', target: { where: (e: SimEntity) => e === seat, label: `slide ${index + 1}'s seat` } }, ctx);
      let t = 0;
      for (; t < 20 && ctx.player.ridingOn !== seat; t++) await ctx.run(1);
      if (ctx.player.ridingOn !== seat) { ctx.violate({ invariant: 'tap-boards-ride', message: `a tap on slide ${index + 1}'s seat boarded nothing` }); return; }
      for (t = 0; t < 600 && ctx.player.ridingOn === seat; t++) await ctx.run(1);
      const on = ctx.player.ridingOn;
      ctx.state['slideHop'] = { ridden: on?.typeId, ticks: t, car: pt(car.location), player: pt(ctx.player.location) };
      if (on !== car) { ctx.violate({ invariant: 'hop-slide-into-car', message: `slide ${index + 1} set the rider down ${on ? `on ${on.typeId}` : 'on foot'}, not into the ${type} parked at its foot`, evidence: { player: pt(ctx.player.location), car: pt(car.location), end: pt(end) } }); return; }
      ctx.note(`slideIntoParked: slid into ${type} after ${t} ticks`);
      // Drive off: the car is the child's now (vehicles.js takes the stick after the boarding grace).
      await ctx.run(HOP.BOARD_GRACE_TICKS);
      const from = { ...car.location };
      await CORE_HANDLERS['drive']!({ kind: 'drive', hold: { forward: 1, ticks: 60 } }, ctx);
      const ahead = Math.hypot(car.location.x - from.x, car.location.z - from.z), mid = { ...car.location };
      await CORE_HANDLERS['drive']!({ kind: 'drive', hold: { forward: -1, ticks: 60 } }, ctx);
      // A note, not a check: where the car can go from a slide's foot is the MODEL's (a dollhouse room may hold it in).
      ctx.note(`slideIntoParked: drove ${r3(ahead)} blocks ahead and ${r3(Math.hypot(car.location.x - mid.x, car.location.z - mid.z))} in reverse from the slide's foot`);
    },
  };
}

/** One hop scenario: the add-ons it loads (first is the one whose wand places), its steps and handlers. */
export interface HopCase { scenario: Scenario; addons: Addon[]; handlers: Record<string, StepHandler> }

/**
 * The hop scenarios over built packs. `coaster` (10261), `flyer` (the Nimbus fixture), `slide` (10788), `car`
 * (42639); a scenario whose packs are not given is left out.
 */
export function hopCases(addons: { coaster?: Addon; flyer?: Addon; slide?: Addon; car?: Addon }): HopCase[] {
  const read = (a?: Addon): CraftmaticPack | undefined => (a ? readCraftmaticPack(a) : undefined);
  const coaster = read(addons.coaster), flyer = read(addons.flyer), slide = read(addons.slide), car = read(addons.car);
  const common = { allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  const out: HopCase[] = [];
  if (coaster && flyer && addons.coaster && addons.flyer) {
    const extra = addons.car ? [addons.car] : [];
    const handlers = { ...craftmaticHandlers(coaster, addons.coaster), ...hopHandlers({ flyer, ...(car ? { car } : {}) }) };
    out.push({
      scenario: {
        name: 'hop-flyer-into-coaster', description: `Place ${coaster.placement.label}, summon ${flyer.placement.label}'s cloud, fly it into a car behind the front of the moving train: the child sits in the front-most car, the cloud waits where it was left, the coaster's camera takes the view, one pack acts${extra.length ? ` (${car?.placement.label} loaded too)` : ''}.`,
        items: [coaster.placement.itemId], ...common,
        steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'mountSpawned', up: 1 }, { kind: 'flyIntoTrain', expect: 'board', side: 7 }],
      },
      addons: [addons.coaster, addons.flyer, ...extra], handlers,
    });
    out.push({
      scenario: {
        name: 'hop-coaster-full', description: `The same fly-in at ${coaster.placement.label}'s train with a player in every car: nobody moves.`,
        items: [coaster.placement.itemId], ...common,
        steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'fillTrain' }, { kind: 'mountSpawned', up: 1 }, { kind: 'flyIntoTrain', expect: 'none', side: 7 }],
      },
      addons: [addons.coaster, addons.flyer], handlers,
    });
  }
  if (slide && car && addons.slide && addons.car && slide.rides?.rides.some(r => r.kind === 'slide')) {
    out.push({
      scenario: {
        name: 'hop-slide-into-car', description: `Park ${car.placement.label}'s car at the foot of ${slide.placement.label}'s slide and slide into it, then drive off.`,
        items: [slide.placement.itemId], ...common,
        steps: [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'slideIntoParked' }],
      },
      // The car may be the slide pack's own (10797 has both): one add-on then, loaded once.
      addons: addons.car === addons.slide ? [addons.slide] : [addons.slide, addons.car], handlers: { ...craftmaticHandlers(slide, addons.slide), ...hopHandlers({ slide, car }) },
    });
  }
  return out;
}
