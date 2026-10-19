/**
 * Script cost of a world with MANY packs (the user's world binds every round pack at once): load every `.mcaddon`
 * in a folder into one simulated world, stand a player in it, run `--ticks` idle ticks (and, with `--place=<stem>`,
 * place that pack at `--size` first and keep riding nothing), and print the wall time each pack's modules spend in
 * their callbacks per tick (`setPackProfiler`, pack-context.ts), largest first.
 *
 * The times are the host's (Bun), not a phone's: the ORDER and the share are what carry over - which runtime a world
 * of 26 packs spends its tick in when nothing is happening. The device measures itself with `/script profiler`.
 *
 * Usage: bun scripts/_sim_script_cost.ts <packs-dir> [--ticks=400] [--place=<stem>] [--size=100] [--top=30]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import { setPackProfiler } from '../web/src/sim/script-host/pack-context.ts';
import type { ScenarioStep } from '../web/src/sim/scenario/types.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const dir = args.find(a => !a.startsWith('--'));
if (!dir) { console.error('usage: bun scripts/_sim_script_cost.ts <packs-dir> [--ticks=400] [--place=<stem>] [--size=100] [--top=30]'); process.exit(2); }
const ticks = Number(flag('ticks') ?? 400), top = Number(flag('top') ?? 30), size = Number(flag('size') ?? 100);
const placeStem = flag('place');

/** Time per pack + module, and the number of calls, over the measured window only. */
const totals = new Map<string, { ms: number; calls: number }>();
let measuring = false;
setPackProfiler((key, module, ms) => {
  if (!measuring) return;
  const k = `${key} :: ${module}`;
  const t = totals.get(k) ?? { ms: 0, calls: 0 };
  t.ms += ms; t.calls++;
  totals.set(k, t);
});

const files = readdirSync(dir).filter(f => f.endsWith('.mcaddon')).sort();
const addons = [];
for (const f of files) {
  const b = readFileSync(join(dir, f));
  addons.push(await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, f.replace(/\.mcaddon$/, '')));
}
console.log(`${addons.length} packs from ${dir}`);
const placed = placeStem ? addons.find(a => a.name.startsWith(placeStem)) : undefined;
if (placeStem && !placed) { console.error(`no pack whose name starts with ${placeStem}`); process.exit(2); }
const pack = readCraftmaticPack(placed ?? addons[0]!);
if (!pack) { console.error('the first pack is not a craftmatic pack'); process.exit(1); }

const steps: ScenarioStep[] = [
  ...(placed ? [{ kind: 'place', size, rotation: 0 } as ScenarioStep] : []),
  { kind: 'wait', ticks: 40 },
  { kind: 'expect', label: 'start measuring', check: () => { measuring = true; return undefined; } },
  { kind: 'wait', ticks },
  { kind: 'expect', label: 'stop measuring', check: () => { measuring = false; return undefined; } },
];
const t0 = performance.now();
const r = await runScenario({ name: 'script-cost', invariants: [], steps }, placed ? [placed, ...addons.filter(a => a !== placed)] : addons, { handlers: craftmaticHandlers(pack, placed ?? addons[0]!) });
const failed = r.steps.filter(s => !s.ok);
if (failed.length) console.log(`steps failed: ${failed.map(s => s.error).join('; ')}`);
const rows = [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms);
const all = rows.reduce((s, [, t]) => s + t.ms, 0);
console.log(`measured ${ticks} ticks${placed ? ` after placing ${placed.name} at ${size} %` : ' idle'}: ${(all / ticks).toFixed(3)} ms of pack callbacks per tick (host), ${rows.length} pack modules; run ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (const [k, t] of rows.slice(0, top)) console.log(`  ${(t.ms / ticks).toFixed(3).padStart(8)} ms/tick  ${(100 * t.ms / Math.max(1e-9, all)).toFixed(1).padStart(5)} %  ${String(Math.round(t.calls / ticks * 10) / 10).padStart(5)} calls/tick  ${k}`);
