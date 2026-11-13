/**
 * Two trains on the generated circuit, judged against the route's zones (WP-C04, BIZ-14).
 *
 *   bun scripts/sim.ts <pack.mcaddon> --scenario=scripts/_coaster_zones_scenarios.ts
 *   C04_LAPS=<n> (laps of the lead train, default 2)  C04_TRACE=<every n ticks>
 *
 * WHAT IT MODELS. The circuit is far larger than the simulation distance, and the runtime holds a train still
 * wherever the world is not loaded (`An unloaded block is not air`), so an unattended pair would freeze a hundred
 * blocks from the pin. The scenario therefore adds TICKING AREAS over the circuit's footprint after the wand has
 * placed it (the publisher's ticking-area policy, U17): both trains then run unattended, and nobody rides.
 *
 * WHAT IT MEASURES, per tick, from the cars' own `craftmatic:coaster_distance` / `_speed`:
 *  - the arc gap between the trains' ends, and whether both stand in one BLOCK section (`zonePlan.blocks`);
 *  - ticks a train stood at a block gate (speed 0 within a block of a gated entry);
 *  - the peak speed, and each launch zone's speed at its end against its target.
 * The result is `ctx.state.zones`; the scenario fails when two trains share a block, or when a launch ends under 98 %
 * of its target (a train that is not held back by anything in front of it).
 */
import type { Scenario, Step, StepContext } from '../web/src/sim/scenario/types.ts';
import type { CraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { packFamily } from '../web/src/sim/adapters/craftmatic/namespace.ts';
import { packText } from '../web/src/sim/pack/pack.ts';
import { teleport } from '../web/src/sim/script-host/facades.ts';
import { coasterScriptConfig } from '../web/src/sim/adapters/craftmatic/coaster.ts';

const LAPS = Number(process.env['C04_LAPS'] ?? 2);
const TRACE_EVERY = Number(process.env['C04_TRACE'] ?? 0);
const MAX_TICKS = Number(process.env['C04_MAX_TICKS'] ?? 40_000);
const CAR = 'craftmatic:coaster_car', DISTANCE = 'craftmatic:coaster_distance', SPEED = 'craftmatic:coaster_speed';
/** Chunks per side of one ticking area (Bedrock allows 100 chunks an area). */
const AREA_CHUNKS = 10;
/** A launch must end within this share of its target speed. */
const LAUNCH_END_SHARE = 0.98;
/** How far from the player the circuit can reach into negative x and z, and past the pin on the other sides, blocks. */
const REACH = Number(process.env['C04_REACH'] ?? 480), MARGIN = Number(process.env["C04_MARGIN"] ?? 400);

/** The measurements `ctx.state.zones` carries. */
export interface ZonesResult {
  ticks: number; leadLaps: number; sharedBlockTicks: number; minGapBlocks: number; gateHoldTicks: number; peakBps: number;
  launches: Array<{ at: number; target: number; endSpeed: number }>; trains: number;
}

/**
 * Ticking areas over the whole neighbourhood the circuit can occupy (it runs from the pin into negative x and z), in
 * AREA_CHUNKS-square tiles. Add them BEFORE the wand places, so the trains never freeze while it works.
 */
export async function loadCircuit(ctx: StepContext): Promise<undefined> {
  const at = ctx.player.location, tile = AREA_CHUNKS * 16;
  let n = 0;
  for (let x = Math.floor((at.x - REACH) / tile) * tile; x < at.x + MARGIN; x += tile) for (let z = Math.floor((at.z - REACH) / tile) * tile; z < at.z + MARGIN; z += tile) { const name = `c04_${n++}`; ctx.sim.engine.tickingAreas.set(name, { name, dimension: ctx.player.dimension, x0: x, z0: z, x1: x + tile - 1, z1: z + tile - 1 }); }
  return undefined;
}

/**
 * Wait until an empty car of the pack's coaster stands still (a platform dwell, the bay, a block gate), stand the
 * child beside it and record it as `ctx.state.stoppedCar` (the entity id). A train with a launch is out of reach
 * and moving at 50 blocks/s long before the wand has finished placing, so the child cannot board whatever is nearest.
 */
export function toStoppedTrain(namespace: string, maxTicks = 6000): (ctx: StepContext) => Promise<string | undefined> {
  const family = packFamily(namespace, 'coaster');
  return async (ctx) => {
    for (let t = 0; t < maxTicks; t++) {
      const car = [...ctx.sim.engine.entities.values()].find(e => e.valid && e.families().includes(family) && !!e.rideable() && !e.riderList().length && Number(e.dynamic.get(SPEED)) < 0.01 && Number.isFinite(Number(e.dynamic.get(DISTANCE))));
      if (car) { teleport(ctx.sim.host, ctx.player, { x: car.location.x + 3, y: car.location.y + 1, z: car.location.z }); await ctx.run(10); ctx.state['stoppedCar'] = car.id; return undefined; }
      await ctx.run(1);
    }
    return `no train stood still within ${maxTicks} ticks`;
  };
}

export function scenarios(pack: CraftmaticPack): Scenario[] {
  const script = packText(pack.pack, 'scripts/coaster.js');
  if (!script) return [];
  const config = coasterScriptConfig(script);
  const route = config.routes[0]!;
  if (!route.zonePlan || route.cars.trains < 2) return [];
  const length = route.path.length, extent = route.cars.extent, count = route.cars.count;
  const blocks = route.zonePlan.blocks, launches = route.zonePlan.rules.filter(r => r.kind === 'launch');
  const family = packFamily(pack.namespace, 'coaster');
  const wrap = (v: number): number => ((v % length) + length) % length;
  /** Blocks a train centred at `c` overlaps (its span is `extent` long, wrapping the seam). */
  const blocksOf = (c: number): Set<number> => {
    const out = new Set<number>(), lo = wrap(c - extent / 2);
    blocks.forEach((b, i) => { for (const s of [-length, 0, length]) if (lo + s < b.to && lo + extent + s > b.from) out.add(i); });
    return out;
  };
  const check = async (ctx: StepContext): Promise<string | undefined> => {
    const engine = ctx.sim.engine;
    const lead = (train: number) => [...engine.entities.values()].find(e => e.valid && e.families().includes(family) && e.dynamic.get(CAR) === train * count);
    const a = lead(0), b = lead(1);
    if (!a || !b) return `the two trains' lead cars were not found (${a ? 'train 1' : 'train 0'} missing)`;
    const arc = (e: typeof a): number => Number(e.dynamic.get(DISTANCE));
    const speed = (e: typeof a): number => Number(e.dynamic.get(SPEED)) || 0;
    // Start the lap count from where the lead train is now.
    let last = arc(a), ran = 0, t = 0, shared = 0, holds = 0, peak = 0, minGap = Infinity;
    const launchEnds = launches.map(l => ({ at: l.to, target: l.speed, endSpeed: 0, seen: false }));
    const gates = blocks.filter(bl => bl.gated).map(bl => wrap(bl.from - 0.5 - extent / 2));
    let lastB = arc(b);
    for (; t < MAX_TICKS && ran < LAPS * length; t++) {
      await ctx.run(1);
      const ca = arc(a), cb = arc(b);
      let d = ca - last; if (d < -length / 2) d += length; if (d > 0) ran += d;
      last = ca; lastB = cb;
      for (const e of [a, b]) peak = Math.max(peak, speed(e));
      const ba = blocksOf(ca), bb = blocksOf(cb);
      // The open course (the ungated block) is spaced by the dispatcher's half lap; the GATED blocks (the brake run and the station block) hold one train.
      if ([...ba].some(i => bb.has(i) && blocks[i]!.gated)) shared++;
      let gap = Math.abs(ca - cb); gap = Math.min(gap, length - gap) - extent;
      minGap = Math.min(minGap, gap);
      for (const e of [a, b]) if (speed(e) < 0.01 && gates.some(g => Math.min(wrap(arc(e) - g), wrap(g - arc(e))) < 1)) { holds++; break; }
      // A launch's end speed: the first tick either train's centre is within a tick's travel of the zone's end.
      for (const l of launchEnds) for (const e of [a, b]) { const c = arc(e); if (Math.abs(c - l.at) < Math.max(1, speed(e) / 20)) { l.endSpeed = Math.max(l.endSpeed, speed(e)); l.seen = true; } }
      if (TRACE_EVERY && t % TRACE_EVERY === 0) console.log(`  t=${t} lead ${ca.toFixed(0)} @${speed(a).toFixed(1)}  second ${cb.toFixed(0)} @${speed(b).toFixed(1)}  gap ${gap.toFixed(0)}  lead at ${a.location.x.toFixed(0)},${a.location.y.toFixed(0)},${a.location.z.toFixed(0)} loaded ${engine.isEntityLoaded(a)}`);
    }
    void lastB;
    const result: ZonesResult = {
      ticks: t, leadLaps: Math.round(ran / length * 100) / 100, sharedBlockTicks: shared, minGapBlocks: Math.round(minGap * 10) / 10, gateHoldTicks: holds,
      peakBps: Math.round(peak * 10) / 10, trains: 2, launches: launchEnds.map(l => ({ at: Math.round(l.at), target: l.target, endSpeed: Math.round(l.endSpeed * 10) / 10 })),
    };
    ctx.state['zones'] = result;
    console.log(`  zones: ${JSON.stringify(result)}`);
    if (ran < LAPS * length) return `the lead train ran ${Math.round(ran)} of ${Math.round(LAPS * length)} blocks in ${t} ticks`;
    if (shared) return `the two trains shared a gated block section for ${shared} tick(s)`;
    const slow = result.launches.find(l => l.endSpeed < LAUNCH_END_SHARE * l.target);
    if (slow) return `the launch ending at arc ${slow.at} reached ${slow.endSpeed} of ${slow.target} blocks/s`;
    return undefined;
  };
  const steps: Step[] = [{ kind: 'expect', label: 'ticking-areas', check: loadCircuit }, { kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'expect', label: 'two-trains', check }];
  return [{ name: 'generated-coaster-two-trains', description: 'Two unattended trains run the generated circuit under its zones, in ticking areas.', steps }];
}
