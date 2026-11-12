/**
 * The generated coaster on the simulator (WP-C02): place the pack, board the LEAD train and ride until a car has run
 * the WHOLE circuit and is back where it boarded, and say how long it took.
 *
 *   bun scripts/sim.ts <pack.mcaddon> --scenario=scripts/_coaster_generated_scenarios.ts
 *   C02_MAX_TICKS=<n> C02_TRACE=<every n ticks>   (optional: a ceiling and a progress line)
 *
 * WHY THE CHILD GOES TO THE TRAIN. An unattended train leaves the platform after its dwell, and the runtime holds
 * a train still wherever the world is not loaded around the player (`An unloaded block is not air`, CLAUDE.md): on a
 * 1,872-block circuit the lead train has stalled ~140 blocks out by the time the wand has finished placing. The
 * scenario therefore finds the lead train's front car (`craftmatic:coaster_car` 0), stands the child beside it
 * (which loads it) and boards it by a hold, exactly as a player would walk up to a stopped train.
 *
 * PROGRESS is the lead car's own arc (`craftmatic:coaster_distance`, summed over forward steps, wrapped at the
 * route's length), so a lap is the runtime's own measure and does not depend on where the circuit was entered.
 */
import type { Scenario, Step, StepContext } from '../web/src/sim/scenario/types.ts';
import type { CraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { packFamily } from '../web/src/sim/adapters/craftmatic/namespace.ts';
import { packText } from '../web/src/sim/pack/pack.ts';
import { coasterScriptConfig } from '../web/src/sim/adapters/craftmatic/coaster.ts';
import { CORE_HANDLERS } from '../web/src/sim/scenario/runner.ts';
import { teleport } from '../web/src/sim/script-host/facades.ts';

/** Ticks the lap may take (the design's own lap is ~3,600 ticks; with no launch zones yet the train crawls the flats: TODO(C04)). */
const MAX_TICKS = Number(process.env['C02_MAX_TICKS'] ?? 60_000);
/** `C02_TRACE=<ticks>`: a progress line every that many ticks. */
const TRACE_EVERY = Number(process.env['C02_TRACE'] ?? 0);
/** The car is home when its arc is within this many blocks of the platform's stopping arc. */
const HOME_BLOCKS = 0.5;
const CAR = 'craftmatic:coaster_car', DISTANCE = 'craftmatic:coaster_distance', SPEED = 'craftmatic:coaster_speed';

export function scenarios(pack: CraftmaticPack): Scenario[] {
  const script = packText(pack.pack, 'scripts/coaster.js');
  if (!script) return [];
  const config = coasterScriptConfig(script);
  const length = config.routes[0]!.path.length;
  const family = packFamily(pack.namespace, 'coaster');
  const check = async (ctx: StepContext): Promise<string | undefined> => {
    const engine = ctx.sim.engine;
    // The lead train's front car, wherever it stalled (loaded or not).
    const front = [...engine.entities.values()].find(e => e.valid && e.families().includes(family) && e.dynamic.get(CAR) === 0);
    if (!front) return 'no coaster car with index 0 (the lead train)';
    teleport(ctx.sim.host, ctx.player, { x: front.location.x + 3, y: front.location.y + 1, z: front.location.z });
    await ctx.run(10);
    await CORE_HANDLERS['hold']!({ kind: 'hold', target: { family, where: e => e === front }, label: 'board the lead train' }, ctx);
    if (ctx.player.ridingOn !== front) return `a hold on the lead car did not seat the child (it is at ${front.location.x.toFixed(0)},${front.location.z.toFixed(0)})`;
    const cars = config.routes[0]!.cars.count;
    const arc = (): number => Number(front.dynamic.get(DISTANCE));
    // Where the child boarded, measured from the platform in the ride direction: the car has already run that far
    // unattended (its dwell is 100 ticks and the wand places for ~3,000), and must run the rest, back to the platform.
    const stop = config.routes[0]!.station.stop;
    const boardedAt = ((arc() - stop) % length + length) % length;
    const needed = length - boardedAt;
    let last = arc(), ran = 0, peak = 0, t = 0, lowest = Infinity, highest = -Infinity, home = false;
    for (; t < MAX_TICKS && ctx.player.ridingOn === front && !home; t++) {
      await ctx.run(1);
      const now = arc();
      // The arc advances by a step per tick: a wrap at the seam is a jump of one length the other way.
      let d = now - last; if (d < -length / 2) d += length;
      if (d > 0) ran += d;
      last = now;
      peak = Math.max(peak, Number(front.dynamic.get(SPEED)) || 0);
      lowest = Math.min(lowest, front.location.y); highest = Math.max(highest, front.location.y);
      home = ran > needed - 2 * HOME_BLOCKS && Math.abs(now - stop) < HOME_BLOCKS && !(Number(front.dynamic.get(SPEED)) > 0.01 && ran < needed - 1);
      if (TRACE_EVERY && t % TRACE_EVERY === 0) console.log(`  t=${t} arc ${now.toFixed(1)} ran ${ran.toFixed(0)}/${needed.toFixed(0)} y ${front.location.y.toFixed(1)} speed ${Number(front.dynamic.get(SPEED)).toFixed(1)}`);
    }
    const lap = { routeLength: Math.round(length * 10) / 10, unattendedBeforeBoarding: Math.round(boardedAt * 10) / 10, ridden: Math.round(ran * 10) / 10, covered: Math.round((boardedAt + ran) * 10) / 10, ticks: t, seconds: Math.round(t / 20), peakBlocksPerSecond: Math.round(peak * 10) / 10, rise: Math.round((highest - lowest) * 10) / 10 };
    ctx.state['lap'] = lap;
    console.log(`  lap: ${JSON.stringify(lap)}`);
    if (ctx.player.ridingOn !== front) return `the child left the car after ${t} ticks, ${Math.round(ran)} of ${Math.round(needed)} blocks`;
    return home ? undefined : `the lead car ran ${Math.round(ran)} of ${Math.round(needed)} blocks in ${t} ticks and is not back on the platform`;
  };
  const steps: Step[] = [{ kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'expect', label: 'full-circuit-lap', check }];
  return [{ name: 'generated-coaster-full-lap', description: 'Board the lead train and ride the generated circuit once round.', steps }];
}
