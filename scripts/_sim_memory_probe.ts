/**
 * Where a placement's memory goes in the simulator (the `TODO(seat-sweep-memory)`
 * hunt): place one pack at one size with the wand, sampling the process's
 * resident memory every 2 s and, at the end, the JavaScript heap's largest
 * object kinds (Bun's `heapStats`) and the world's own counts (sections,
 * written blocks, timeline entries, entities).
 *
 * Usage: bun scripts/_sim_memory_probe.ts <pack.mcaddon> [--size=300] [--rot=0]
 */
import { readFileSync } from 'node:fs';
import { heapStats } from 'bun:jsc';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import type { StepContext } from '../web/src/sim/scenario/types.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('usage: bun scripts/_sim_memory_probe.ts <pack.mcaddon> [--size=300] [--rot=0]'); process.exit(2); }
const size = Number(flag('size') ?? 300), rotation = Number(flag('rot') ?? 0);
const gb = (n: number): string => (n / 2 ** 30).toFixed(2);
const t0 = performance.now();
const timer = setInterval(() => { const m = process.memoryUsage(); console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s: rss ${gb(m.rss)} GB, heap ${gb(m.heapUsed)} GB`); }, 2000);
const b = readFileSync(file);
const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
const pack = readCraftmaticPack(addon)!;
const r = await runScenario({ name: 'memory', invariants: [], steps: [
  { kind: 'place', size, rotation },
  { kind: 'expect', label: 'counts', check: (ctx: StepContext) => {
    const w = ctx.sim.engine.dimension('overworld') as unknown as { sections: Map<number, Uint32Array>; writes: { size: number } };
    console.log(`world: ${w.sections.size} sections (${gb(w.sections.size * 16384)} GB), ${w.writes.size} blocks written, ${ctx.sim.engine.timeline.entries.length} timeline entries, ${ctx.sim.engine.entities.size} entities, palette ${(ctx.sim.engine.palette as unknown as { byId: unknown[] }).byId.length}`);
    const kinds = Object.entries(heapStats().objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    console.log(`heap object kinds: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`);
    return undefined;
  } },
] }, [addon], {
  handlers: craftmaticHandlers(pack, addon),
  // A synchronous script loop never lets the 2-second timer run: sample from inside the scripts' own Math calls instead,
  // printing the resident memory and the calling script lines every 20 M calls.
  wrapMath: m => {
    let n = 0;
    const tap = (): void => { if (++n % 20_000_000 === 0) process.stderr.write(`  Math x${n / 1e6} M: rss ${gb(process.memoryUsage().rss)} GB\n${String(new Error().stack).split('\n').slice(3, 9).join('\n')}\n`); };
    return new Proxy(m, { get(t, k) { const v = Reflect.get(t, k); return typeof v === 'function' ? (...a: number[]) => { tap(); return (v as (...x: number[]) => number).apply(t, a); } : v; } });
  },
});
clearInterval(timer);
console.log(`${r.status} in ${((performance.now() - t0) / 1000).toFixed(0)} s; ${r.steps.map(s => `${s.label} ${s.ok ? 'ok' : s.error}`).join('; ')}`);
