/**
 * Trace one scripted vehicle through one course lane of the headless simulator
 * (`adapters/craftmatic/vehicle-course.ts`), as shipped or with this tree's
 * runtime: the vehicle's position every few ticks relative to the obstacle,
 * the HUD lines the driver saw, and the course row. For a diagnosis when the
 * course and the unit-test harness disagree (2026-10-07: the X-wing rose at
 * the oblique hill in the harness and slid along it in the course).
 *
 *   bun scripts/_course_trace.ts <pack.mcaddon> --obstacle=oblique [--type=<id>] [--runtime=pack|tree] [--every=5] [--policy=forward|forward+jump]
 */
import { readFileSync } from 'node:fs';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { scriptedVehicleTypes, type CourseRow } from '../web/src/sim/adapters/craftmatic/vehicle-course.ts';
import { swapTreeRuntimes } from '../web/src/sim/adapters/craftmatic/runtime-swap.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_course_trace.ts <pack.mcaddon> --obstacle=<lane> [--type=] [--runtime=pack|tree] [--every=5] [--policy=]'); process.exit(2); }
const b = readFileSync(file);
const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
if ((flag('runtime') ?? 'pack') === 'tree') console.log(`swapped: ${swapTreeRuntimes(addon).join(', ') || 'nothing'}`);
const pack = readCraftmaticPack(addon);
if (!pack) { console.error(`${file} is not a craftmatic pack`); process.exit(2); }
const types = scriptedVehicleTypes(pack);
const type = flag('type') ?? types.find(t => t.mode === 'plane')?.typeId ?? types[0]?.typeId;
if (!type) { console.error('no scripted vehicle type'); process.exit(2); }
const obstacle = flag('obstacle') ?? 'oblique';
const r = await runScenario({
  name: `trace-${obstacle}`,
  steps: [{ kind: 'stuckCourse', type, obstacles: [obstacle], policy: flag('policy') ?? 'forward', trace: Number(flag('every') ?? 5) }],
  allowLines: [/CAR|HOVER|FLY|PLANE|BOAT|mph|Hotbar slot 9/],
}, [addon], { handlers: craftmaticHandlers(pack, addon) });
console.log(`status ${r.status}; violations: ${r.violations.map(v => `[${v.invariant}] ${v.message}`).join('; ') || 'none'}`);
for (const n of r.notes) console.log(`note: ${n}`);
const rows = (r.state['course'] as CourseRow[] | undefined) ?? [];
for (const row of rows) {
  const { trace, ...rest } = row;
  console.log(JSON.stringify(rest));
  console.log(`trace (x, y, z relative to the obstacle's start / ground / lane centre, every ${flag('every') ?? 5} ticks):`);
  console.log((trace ?? []).map(p => p.join(',')).join('  '));
}
