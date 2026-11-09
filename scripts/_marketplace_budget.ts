/**
 * Marketplace budget gate (M06, BIZ-25; plan A section 7.6): measure a BUILT pack against one budget tier.
 *
 *   bun scripts/_marketplace_budget.ts <pack.mcaddon>... [--tier=standard] [--ticks=200] [--size=100]
 *                                      [--static-only] [--json=<report.json>]
 *
 * Static rows read the archive: uncompressed size, file count, block permutations (summed over every custom block),
 * texture sizes, and the cuboids of every geometry the pack defines. Runtime rows load the pack into the headless
 * simulator, place it with the wand at `--size` percent, let it settle for 40 ticks and read the entities left in the
 * world and their cuboids, then time the pack's script callbacks over `--ticks` ticks (median per tick, `setPackProfiler`).
 * The script times are the HOST's (Bun), not a phone's: see the `standard` tier's evidence in
 * `web/src/engine/marketplace/budget.ts`. Tiers are data there; this script knows none.
 *
 * Exit 0 = pass (or incomplete under `--static-only`), 1 = a limit failed or the runtime could not be measured,
 * 2 = usage. `--json` writes `{ pack, tier, static, runtime, report }` per pack (an array) for the submission bundle (S02).
 *
 * TODO(m06-tick-window): a pack whose cost peaks in a ride (the coaster) is measured idle after placement; ride cost
 * comes from `scripts/sim.ts --cost` scenarios, which this gate does not drive yet.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import {
  DEFAULT_TIER_ID, entityGeometryCubes, evaluateBudget, median, quantile, staticMeasure, tierById,
  type BudgetFile, type BudgetReport, type RuntimeMeasure, type StaticMeasure,
} from '../web/src/engine/marketplace/budget.ts';
import { readAddon, type Addon } from '../web/src/sim/pack/pack.ts';
import { readCraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { craftmaticHandlers } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { runScenario } from '../web/src/sim/scenario/runner.ts';
import { setPackProfiler } from '../web/src/sim/script-host/pack-context.ts';
import type { Simulation } from '../web/src/sim/core/simulation.ts';
import type { Step } from '../web/src/sim/scenario/types.ts';

/** Ticks the placement is given to spawn its entities before the measured window opens. */
const SETTLE_TICKS = 40;

/** Every file of an archive's packs, keyed as the archive names them. */
export async function archiveFiles(bytes: Uint8Array): Promise<BudgetFile[]> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const out: BudgetFile[] = [];
  for (const name of listZipEntries(buffer)) {
    if (!name.endsWith('/')) out.push({ name, data: new Uint8Array(await extractFile(buffer, name)) });
  }
  return out;
}

/** The files of a loaded add-on as budget files (folder-prefixed, as in the archive). */
export function addonFiles(addon: Addon): BudgetFile[] {
  return addon.packs.flatMap(p => [...p.files].map(([path, data]) => ({ name: p.folder ? `${p.folder}/${path}` : path, data })));
}

/**
 * Place the pack on the simulator and measure it: live entities (and their cuboids) after the placement settled, and
 * the median / 95th-percentile of the pack's script callback time per tick over `ticks` ticks.
 * Throws when the pack is not a craftmatic pack (no placement runtime to drive) or a step failed.
 */
export async function measureRuntime(addon: Addon, o: { ticks: number; size: number }): Promise<RuntimeMeasure> {
  const pack = readCraftmaticPack(addon);
  if (!pack) throw new Error('not a craftmatic placement pack: nothing to place on the simulator');
  const cubesOf = entityGeometryCubes(addonFiles(addon));

  let sim: Simulation | undefined;
  let windowStart = -1;
  const msByTick = new Map<number, number>();
  setPackProfiler((_key, _module, ms) => {
    if (!sim || windowStart < 0) return;
    msByTick.set(sim.engine.tick, (msByTick.get(sim.engine.tick) ?? 0) + ms);
  });
  const resident = { count: 0, cubes: 0, byType: {} as Record<string, number> };
  const steps: Step[] = [
    { kind: 'place', size: o.size, rotation: 0 },
    { kind: 'wait', ticks: SETTLE_TICKS },
    { kind: 'expect', label: 'open the measured window', check: () => { windowStart = sim!.engine.tick; return undefined; } },
    { kind: 'wait', ticks: o.ticks },
    {
      kind: 'expect', label: 'count the live entities',
      check: () => {
        for (const e of sim!.engine.entities.values()) {
          if (!e.valid || e.isPlayer) continue;
          resident.count++;
          resident.cubes += cubesOf.get(e.typeId) ?? 0;
          resident.byType[e.typeId] = (resident.byType[e.typeId] ?? 0) + 1;
        }
        return undefined;
      },
    },
  ];
  try {
    const r = await runScenario({ name: 'marketplace-budget', invariants: [], steps }, [addon], {
      handlers: craftmaticHandlers(pack, addon),
      prepare: s => { sim = s; },
    });
    const failed = r.steps.filter(s => !s.ok);
    if (failed.length) throw new Error(`simulator steps failed: ${failed.map(s => s.error).join('; ')}`);
  } finally {
    setPackProfiler(null);
  }
  // Every tick of the window counts, including ticks in which no callback ran (0 ms).
  const perTick = Array.from({ length: o.ticks }, (_, i) => msByTick.get(windowStart + 1 + i) ?? 0);
  return {
    residentEntities: resident.count, placedCuboids: resident.cubes, entitiesByType: resident.byType,
    scriptMsMedian: median(perTick), scriptMsP95: quantile(perTick, 0.95), ticks: o.ticks,
  };
}

/** One pack's full result, as written to `--json`. */
export interface PackBudget { pack: string; tier: string; static: StaticMeasure; runtime: RuntimeMeasure | null; report: BudgetReport }

/** Measure and judge one archive. */
export async function budgetForPack(file: string, tierId: string, opts: { ticks: number; size: number; staticOnly: boolean }): Promise<PackBudget> {
  const bytes = new Uint8Array(readFileSync(file));
  const tier = tierById(tierId);
  const stat = staticMeasure(await archiveFiles(bytes));
  let runtime: RuntimeMeasure | null = null;
  let runtimeReason: string | undefined = opts.staticOnly ? '--static-only' : undefined;
  if (!opts.staticOnly) {
    try { runtime = await measureRuntime(await readAddon(bytes, basename(file)), opts); }
    catch (e) { runtimeReason = e instanceof Error ? e.message : String(e); }
  }
  return { pack: basename(file), tier: tier.id, static: stat, runtime, report: evaluateBudget({ static: stat, runtime, ...(runtimeReason ? { runtimeReason } : {}) }, tier) };
}

const fmt = (n: number | null): string => (n === null ? '-' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(3));

function printPack(p: PackBudget): void {
  console.log(`${p.pack}  tier ${p.tier}: ${p.report.verdict.toUpperCase()}`);
  for (const r of p.report.rows) {
    console.log(`  ${r.status.toUpperCase().padEnd(12)} ${r.metric.padEnd(32)} ${fmt(r.value).padStart(12)} / ${fmt(r.limit).padStart(12)}${r.note ? `  (${r.note})` : ''}`);
  }
  if (p.report.runtimeReason) console.log(`  runtime not measured: ${p.report.runtimeReason}`);
  if (p.runtime) console.log(`  runtime: p95 ${p.runtime.scriptMsP95.toFixed(3)} ms over ${p.runtime.ticks} ticks; ${Object.keys(p.runtime.entitiesByType).length} entity types (--json lists them)`);
}

async function main(argv: string[]): Promise<number> {
  const flag = (n: string): string | undefined => argv.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const packs = argv.filter(a => !a.startsWith('--'));
  if (!packs.length) {
    console.error('usage: bun scripts/_marketplace_budget.ts <pack.mcaddon>... [--tier=standard] [--ticks=200] [--size=100] [--static-only] [--json=<out>]');
    return 2;
  }
  const staticOnly = argv.includes('--static-only');
  const results: PackBudget[] = [];
  for (const p of packs) {
    const r = await budgetForPack(p, flag('tier') ?? DEFAULT_TIER_ID, { ticks: Number(flag('ticks') ?? 200), size: Number(flag('size') ?? 100), staticOnly });
    printPack(r);
    results.push(r);
  }
  const out = flag('json');
  if (out) writeFileSync(out, JSON.stringify(results, null, 2));
  return results.some(r => r.report.verdict === 'fail' || (r.report.verdict === 'incomplete' && !staticOnly)) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
