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

/** What one ride reports: the scenario result and the per-tick traces. */
export interface ZonesCameraRide { result: Awaited<ReturnType<typeof runScenario>>; trace: unknown; arcs: Array<[number, number]> }

/** Build the scenario for `bytes` (a generated coaster's pack) on `profile`'s client and ride it `laps` laps. */
export async function rideCamera(bytes: Uint8Array, source: string, profile: ClientProfileName, laps = 1, maxTicks = 9000): Promise<ZonesCameraRide> {
  const addon = await readAddon(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, source);
  const pack = readCraftmaticPack(addon)!;
  /** The boarded car's arc every tick, to put the camera's frames on the track (`--trace=` writes it beside the camera trace). */
  const arcs: Array<[number, number]> = [];
  const arcProbe: Invariant = { id: 'arc-probe', description: 'records the ridden car arc per tick', tick(ctx) { const car = ctx.player.ridingOn; if (car) arcs.push([ctx.engine.tick, Number(car.dynamic.get('craftmatic:coaster_distance'))]); } };
  const steps: Step[] = [
    { kind: 'expect', label: 'ticking-areas', check: loadCircuit }, { kind: 'place', size: 100, rotation: 0 }, { kind: 'wait', ticks: 40 },
    { kind: 'expect', label: 'beside-a-stopped-train', check: toStoppedTrain(pack.namespace) },
    { kind: 'rideCoasterCamera', laps, maxTicks, frames: false }, { kind: 'undo' },
  ];
  const scenario: Scenario = { name: `coaster-zones-camera-${profile}`, description: `Ride the generated coaster ${laps} lap(s) under its zones, watching the drawn camera on the ${profile} client.`, steps, allowLines: [...CRAFTMATIC_ALLOWED_LINES], yieldingLines: [...CRAFTMATIC_YIELDING_LINES] };
  const result = await runScenario(scenario, [addon], {
    handlers: { ...craftmaticHandlers(pack, addon), ...clientSteps(pack, packAppearance(addon), {}, profile) },
    invariants: [...clientInvariants({ seatCamera: craftmaticSeatCamera() }), arcProbe], prepare: (sim, player) => { attachClient(sim, player, profile); },
  });
  return { result, trace: result.state['cameraTrace'], arcs };
}

// Bun runs the file as a script (`import.meta.main`); a test imports `rideCamera` and never takes this branch.
if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: bun scripts/_coaster_zones_camera.ts <pack.mcaddon> [--client=pixel|saga|both] [--laps=1] [--max=<ticks>] [--trace=<file.json>]'); process.exit(2); }
  const clientFlag = flag('client') ?? 'pixel';
  const profiles: ClientProfileName[] = clientFlag === 'both' ? ['pixel', 'saga'] : [clientFlag as ClientProfileName];
  let failed = 0;
  for (const profile of profiles) {
    const { result: r, trace, arcs } = await rideCamera(readFileSync(file), file, profile, Number(flag('laps') ?? 1), Number(flag('max') ?? 9000));
    console.log(`${basename(file)} ${profile}: ${r.status} ${r.violations.length} violation(s) in ${r.ticks} ticks`);
    for (const v of r.violations) console.log(`  [${v.invariant}] ${v.message.slice(0, 300)}`);
    for (const s of r.steps.filter(x => !x.ok)) console.log(`  step ${s.label} ERROR: ${s.error}`);
    for (const n of r.notes) console.log(`  ${n.slice(0, 400)}`);
    console.log(`  coasterCamera ${JSON.stringify(r.state['coasterCamera'])}`);
    const dump = flag('trace');
    if (dump) { writeFileSync(dump.replace('.json', `-${profile}.json`), JSON.stringify(trace)); writeFileSync(dump.replace('.json', `-${profile}-arcs.json`), JSON.stringify(arcs)); }
    if (r.status !== 'pass') failed++;
  }
  process.exit(failed ? 1 : 0);
}
