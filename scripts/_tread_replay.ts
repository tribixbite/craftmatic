/**
 * Replay the scaled tread planner on one export's recorded inputs, without rebuilding the pack, and compare each
 * plan's reach with a built pack's (SCALE-06, IX-05).
 *
 * Record the inputs with any export: `CRAFTMATIC_TREAD_INPUTS=<file>.json bun scripts/_favorites_export_sweep.ts <set>
 * --out <dir>` (or `_playable_ref.ts`). A plan takes 1-30 seconds here; a rebuild of a favourite takes 1-4 minutes.
 *
 * Usage: bun scripts/_tread_replay.ts <inputs.json[.gz]> [--sizes=150,200,300,400] [--turns=0,90,180,270]
 *                                     [--against=<pack.mcaddon>] [--runs=<file.json>] [--plans=<file.json>]
 *   Prints one line per plan: the reach after the treads (surfaces, highest in blocks at 100 %), the runs laid and
 *   seconds; with `--against`, that pack's reach for the same plan and the difference (`LOSS` where either number is
 *   lower). `--runs` writes every plan's runs (`{ "<pct>:<turn>": TreadRun[] }`) for a run-by-run diff; `--plans`
 *   writes every plan's report row and its encoded blocks (`{ "<pct>:<turn>": { report, blocks } }`, the pack's
 *   `encodeTreadPlan` form) - test/tread-reach-replay.test.ts plans in this process so its worker never blocks. Exits 0.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { planTreadsFromInputs, type PlacementTreadReport, type TreadInputs } from '../web/src/engine/bedrock-placement-pack.ts';
import { extractFile, listZipEntries } from '../web/src/engine/zip-utils.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const list = (v: string | undefined, d: number[]): number[] => v ? v.split(',').map(Number) : d;

/** A built pack's tread report (its behaviour pack's `craftmatic-treads.json`). */
async function packReport(path: string): Promise<PlacementTreadReport> {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const name = listZipEntries(buffer).find(e => e.endsWith('craftmatic-treads.json'));
  if (!name) throw new Error(`no craftmatic-treads.json in ${path}`);
  return JSON.parse(new TextDecoder().decode(await extractFile(buffer, name))) as PlacementTreadReport;
}

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('usage: bun scripts/_tread_replay.ts <inputs.json> [--sizes=] [--turns=] [--against=<pack>] [--runs=<out.json>]'); process.exit(2); }
const raw = readFileSync(file);
const inputs = JSON.parse((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')) as TreadInputs;
const against = flag('against') ? await packReport(flag('against')!) : undefined;
const runsOut: Record<string, unknown> = {}, plansOut: Record<string, unknown> = {};
let total = 0, totalAgainst = 0, losses = 0;
for (const pct of list(flag('sizes'), [150, 200, 300, 400])) {
  for (const r of list(flag('turns'), [0, 90, 180, 270]) as QuarterTurn[]) {
    const t0 = Date.now();
    const result = planTreadsFromInputs(inputs, [[pct, r]]);
    const plan = result.report.plans[0]!;
    runsOut[`${pct}:${r}`] = plan.runs;
    plansOut[`${pct}:${r}`] = { report: plan, blocks: result.colliders.treads?.plans[`${pct}:${r}`] ?? '' };
    total += plan.after.surfaces;
    let line = `${pct} % turn ${r}: surfaces ${plan.after.surfaces} highest ${plan.after.highestBlocks} runs ${plan.runs.length} (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
    const other = against?.plans.find(p => p.sizePct === pct && p.rotation === r);
    if (other) {
      totalAgainst += other.after.surfaces;
      const loss = plan.after.surfaces < other.after.surfaces || plan.after.highestBlocks < other.after.highestBlocks;
      losses += loss ? 1 : 0;
      line += ` | pack ${other.after.surfaces} highest ${other.after.highestBlocks} | ${plan.after.surfaces - other.after.surfaces >= 0 ? '+' : ''}${plan.after.surfaces - other.after.surfaces}${loss ? ' LOSS' : ''}`;
    }
    console.log(line);
  }
}
console.log(`total surfaces ${total}${against ? ` | pack ${totalAgainst} | plans below the pack: ${losses}` : ''}`);
if (flag('runs')) writeFileSync(flag('runs')!, JSON.stringify(runsOut));
if (flag('plans')) writeFileSync(flag('plans')!, JSON.stringify(plansOut));
