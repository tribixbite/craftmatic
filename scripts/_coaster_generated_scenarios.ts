/**
 * The generated coaster on the simulator (WP-C02): place the pack, board the LEAD train and ride until a car has run
 * the WHOLE circuit and is back where it boarded, and say how long it took.
 *
 *   bun scripts/sim.ts <pack.mcaddon> --scenario=scripts/_coaster_generated_scenarios.ts
 *   C02_MAX_TICKS=<n> C02_TRACE=<every n ticks>   (optional: a ceiling and a progress line)
 *
 * WHY THE CHILD GOES TO A STOPPED TRAIN. The wand takes ~3,400 ticks to place and the trains do not wait for it. Out of
 * the loaded area the runtime holds a train still (`An unloaded block is not air`, CLAUDE.md), and with a launch it is
 * frozen at 50 blocks/s, so no hold seats the child on whatever is nearest. The circuit therefore sits inside ticking areas
 * (`loadCircuit`, the publisher's ticking-area policy), and the child is stood beside a train that is standing still
 * (`toStoppedTrain`: a platform dwell, the bay or a block gate) and boards it by a hold, as a player would.
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
import { loadCircuit, toStoppedTrain } from './_coaster_zones_scenarios.ts';

/** Ticks the lap may take (the design's own lap is ~3,600 ticks; zones act since C04). */
const MAX_TICKS = Number(process.env['C02_MAX_TICKS'] ?? 60_000);
/** `C02_TRACE=<ticks>`: a progress line every that many ticks. */
const TRACE_EVERY = Number(process.env['C02_TRACE'] ?? 0);
/** The car is home when its arc is within this many blocks of the platform's stopping arc. */
const HOME_BLOCKS = 0.5;
const DISTANCE = 'craftmatic:coaster_distance', SPEED = 'craftmatic:coaster_speed';

export function scenarios(pack: CraftmaticPack): Scenario[] {
  const script = packText(pack.pack, 'scripts/coaster.js');
  if (!script) return [];
  const config = coasterScriptConfig(script);
  const length = config.routes[0]!.path.length;
  const family = packFamily(pack.namespace, 'coaster');
  const check = async (ctx: StepContext): Promise<string | undefined> => {
    const engine = ctx.sim.engine;
    // The car `toStoppedTrain` stood the child beside: any train that is standing still (a platform dwell, the bay, a gate).
    const front = [...engine.entities.values()].find(e => e.valid && e.id === ctx.state['stoppedCar']);
    if (!front) return 'no stopped coaster car was found to board';
    await CORE_HANDLERS['hold']!({ kind: 'hold', target: { family, where: e => e === front }, label: 'board the stopped train' }, ctx);
    if (ctx.player.ridingOn !== front) return `a hold on the stopped car did not seat the child (it is at ${front.location.x.toFixed(0)},${front.location.z.toFixed(0)})`;
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
  const steps: Step[] = [{ kind: 'expect', label: 'ticking-areas', check: loadCircuit }, { kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 }, { kind: 'expect', label: 'beside-a-stopped-train', check: toStoppedTrain(pack.namespace) }, { kind: 'expect', label: 'full-circuit-lap', check }];
  return [{ name: 'generated-coaster-full-lap', description: 'Board the lead train and ride the generated circuit once round.', steps }];
}
