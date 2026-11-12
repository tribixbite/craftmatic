/**
 * The generated coaster's rider camera under its zones (WP-C04): `scripts/sim.ts --scenario=coaster-camera`, but able
 * to BOARD a train that has launches.
 *
 *   bun scripts/_coaster_zones_camera.ts <pack.mcaddon> [--client=pixel|saga|both] [--laps=1] [--max=<ticks>]
 *
 * WHY NOT `sim.ts --scenario=coaster-camera`. That scenario places the pack and boards the nearest empty car by a hold.
 * The wand takes ~3,400 ticks to place, the unattended train leaves its platform after the dwell, and with a launch it
 * is out of the loaded area and frozen at 50 blocks/s long before the child looks for a car: the hold seats nobody.
 * (A train with no launch crawled the flats and was still boardable.) Here the circuit sits inside ticking areas
 * (added before the wand places, as the publisher's ticking-area policy would provide), the scenario waits until a
 * train stands still (a platform dwell, the bay, a block gate), stands the child beside its car, and runs the same
 * `rideCoasterCamera` step with the same client invariants: `camera-continuous`, `camera-on-own-seat`,
 * `no-own-view-flash`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { loadCircuit, toStoppedTrain } from './_coaster_zones_scenarios.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { clientSteps, craftmaticSeatCamera } from '../web/src/sim/adapters/craftmatic/client-steps.ts';
import { packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.ts';
import { attachClient, type ClientProfileName } from '../web/src/sim/client/camera.ts';
import { clientInvariants } from '../web/src/sim/client/invariants.ts';
import type { Invariant } from '../web/src/sim/scenario/invariants.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import type { Scenario, Step, StepContext } from '../web/src/sim/scenario/types.ts';
import { CRAFTMATIC_ALLOWED_LINES, CRAFTMATIC_YIELDING_LINES } from '../web/src/sim/adapters/craftmatic/child-play.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_coaster_zones_camera.ts <pack.mcaddon> [--client=pixel|saga|both] [--laps=1] [--max=<ticks>]'); process.exit(2); }
const clientFlag = flag('client') ?? 'pixel';
const profiles: ClientProfileName[] = clientFlag === 'both' ? ['pixel', 'saga'] : [clientFlag as ClientProfileName];
const laps = Number(flag('laps') ?? 1), maxTicks = Number(flag('max') ?? 9000);

const load = async () => { const b = readFileSync(file); return readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file); };

let failed = 0;
for (const profile of profiles) {
  const addon = await load();
  const pack = readCraftmaticPack(addon)!;
  const steps: Step[] = [
    { kind: 'expect', label: 'ticking-areas', check: loadCircuit }, { kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 },
    { kind: 'expect', label: 'beside-a-stopped-train', check: toStoppedTrain(pack.namespace) },
    { kind: 'rideCoasterCamera', laps, maxTicks, frames: false }, { kind: 'undo' },
  ];
  const scenario: Scenario = { name: `coaster-zones-camera-${profile}`, description: `Ride the generated coaster ${laps} lap(s) under its zones, watching the drawn camera on the ${profile} client.`, steps, allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  /** The boarded car's arc every tick, to put the camera's frames on the track (`--trace=` writes it beside the camera trace). */
  const arcs: Array<[number, number]> = [];
  const arcProbe: Invariant = { id: 'arc-probe', description: 'records the ridden car arc per tick', tick(ctx) { const car = ctx.player.ridingOn; if (car) arcs.push([ctx.engine.tick, Number(car.dynamic.get('craftmatic:coaster_distance'))]); } };
  const appearance = packAppearance(addon);
  const r = await runScenario(scenario, [addon], {
    handlers: { ...craftmaticHandlers(pack, addon), ...clientSteps(pack, appearance, {}, profile) },
    invariants: [...clientInvariants({ seatCamera: craftmaticSeatCamera() }), arcProbe], prepare: (sim, player) => { attachClient(sim, player, profile); },
  });
  console.log(`${basename(file)} ${profile}: ${r.status} ${r.violations.length} violation(s) in ${r.ticks} ticks`);
  for (const v of r.violations) console.log(`  [${v.invariant}] ${v.message.slice(0, 300)}`);
  for (const s of r.steps.filter(x => !x.ok)) console.log(`  step ${s.label} ERROR: ${s.error}`);
  for (const n of r.notes) console.log(`  ${n.slice(0, 400)}`);
  console.log(`  coasterCamera ${JSON.stringify(r.state['coasterCamera'])}`);
  const dump = flag('trace');
  if (dump) { writeFileSync(dump.replace('.json', `-${profile}.json`), JSON.stringify(r.state['cameraTrace'])); writeFileSync(dump.replace('.json', `-${profile}-arcs.json`), JSON.stringify(arcs)); }
  if (r.status !== 'pass') failed++;
}
process.exit(failed ? 1 : 0);
