/**
 * The headless Bedrock simulator's CLI (web/src/sim, docs/sim-engine.md):
 * load built packs exactly as shipped, run their scripts against the mock
 * `@minecraft/server`, play scenarios with invariants, report.
 *
 * Usage:
 *   bun scripts/sim.ts <pack.mcaddon | dir>… [--scenario=child-play|regressions|<file.ts>]
 *        [--json=<out.json>] [--md=<out.md>] [--quick] [--only=<scenario substring>] [--shots=<dir>]
 *        [--new=<dir>]   (regressions: the current tree's packs, `<dir>/<stem>.mcaddon`)
 *
 *   child-play   (default) every craftmatic pack's generated scenarios: place at
 *                100/150 percent and turns 0/90, tap every part, walk every
 *                doorway, ride, drive, fly, let figures live 5 minutes, Undo.
 *   regressions  the 2026-09-29 device-bug set: each on the pack the device ran
 *                and on `--new=<dir>`'s build; packs on the command line are ignored.
 *   <file.ts>    a module exporting `scenarios(pack: CraftmaticPack): Scenario[]`.
 *   --shots      child-play also takes first-person pictures (after placing, after
 *                the figures lived) and writes them there as PNG.
 *
 * Exit 1 when a scenario fails (child-play, files) or a regression's verdict is FAIL.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { runScenario, type ScenarioResult } from '../web/src/sim/scenario/runner.ts';
import { markdownReport, regressionMarkdown, unmodelledTotals, type PackReport, type RegressionRow } from '../web/src/sim/scenario/report.ts';
import { childPlay, craftmaticHandlers, type Snapshot } from '../web/src/sim/adapters/craftmatic/child-play.ts';
import { readCraftmaticPack, type CraftmaticPack } from '../web/src/sim/adapters/craftmatic/pack-facts.ts';
import { REGRESSIONS } from '../web/src/sim/adapters/craftmatic/regressions.ts';
import type { Scenario } from '../web/src/sim/scenario/types.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const mode = flag('scenario') ?? 'child-play';
const quick = args.includes('--quick');
const only = flag('only');
const shotsDir = flag('shots');
const inputs = args.filter(a => !a.startsWith('--'));
const packs = inputs.flatMap(p => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(p, f)) : [p]));

const load = async (file: string): Promise<Awaited<ReturnType<typeof readAddon>>> => {
  const b = readFileSync(file);
  return readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
};
const statusLine = (r: ScenarioResult): string => `  ${r.name.padEnd(28)} ${r.status.padEnd(7)} ${String(r.violations.length).padStart(3)} violation(s) ${String(r.ticks).padStart(6)} ticks ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.unmodelled.length ? `  unmodelled: ${r.unmodelled.map(u => u.member).join(', ')}` : ''}`;

let failed = 0;

if (mode === 'regressions') {
  const newDir = flag('new');
  if (!newDir) { console.error('--scenario=regressions needs --new=<dir> (the current tree\'s packs)'); process.exit(2); }
  const rows: RegressionRow[] = [];
  for (const c of REGRESSIONS) {
    if (only && !c.id.includes(only)) continue;
    const run = async (file: string): Promise<RegressionRow['old']> => {
      if (!existsSync(file)) return { error: `missing ${file}` };
      const addon = await load(file);
      const pack = readCraftmaticPack(addon);
      if (!pack) return { error: `${file} is not a craftmatic pack` };
      const r = await runScenario(c.scenario(pack), [addon], { handlers: craftmaticHandlers(pack, addon) });
      const j = c.judge(r, pack);
      const failedSteps = r.steps.filter(s => !s.ok).map(s => `${s.label}: ${s.error}`);
      return { reproduced: j.reproduced, ...(j.attribution ? { attribution: j.attribution } : {}), evidence: `${j.evidence}${failedSteps.length ? ` [step error: ${failedSteps.join('; ')}]` : ''}`, status: r.status, ms: r.ms };
    };
    const oldR = await run(c.oldPack), newR = await run(resolve(newDir, `${c.newStem}.mcaddon`));
    const oldOk = !('error' in oldR) && oldR.reproduced;
    const newOk = !('error' in newR) && (c.expectNew === 'pass' ? !newR.reproduced : newR.reproduced && newR.attribution === 'model');
    const verdict = !oldOk ? `NOT REPRODUCED on the old pack${c.limits ? ` (${c.limits})` : ''}` : newOk ? 'OK' : 'FAIL';
    if (verdict === 'FAIL') failed++;
    rows.push({ id: c.id, title: c.title, evidence: c.evidence, expectNew: c.expectNew, old: oldR, new: newR, verdict, ...(c.limits ? { limits: c.limits } : {}) });
    console.log(`${c.id}: old ${'error' in oldR ? oldR.error : oldR.reproduced ? `REPRODUCED${oldR.attribution ? ` (${oldR.attribution})` : ''}` : 'not reproduced'}; new ${'error' in newR ? newR.error : newR.reproduced ? `REPRODUCED${newR.attribution ? ` (${newR.attribution})` : ''}` : 'not reproduced'} -> ${verdict}`);
    for (const [k, x] of [['old', oldR], ['new', newR]] as const) if (!('error' in x)) console.log(`    ${k}: ${x.evidence.slice(0, 300)}`);
  }
  const md = regressionMarkdown(rows);
  if (flag('md')) writeFileSync(flag('md')!, md);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(rows, null, 1));
  process.exit(failed ? 1 : 0);
}

if (!packs.length) { console.error('usage: bun scripts/sim.ts <pack.mcaddon | dir>… [--scenario=child-play|regressions|<file.ts>] [--json=] [--md=] [--quick] [--only=] [--new=<dir>]'); process.exit(2); }

let custom: ((pack: CraftmaticPack) => Scenario[]) | undefined;
if (mode !== 'child-play') {
  const mod = await import(pathToFileURL(resolve(mode)).href) as { scenarios?: (pack: CraftmaticPack) => Scenario[] };
  if (typeof mod.scenarios !== 'function') { console.error(`${mode} exports no scenarios(pack) function`); process.exit(2); }
  custom = mod.scenarios;
}

const reports: PackReport[] = [];
for (const file of packs) {
  const t0 = performance.now();
  const report: PackReport = { pack: basename(file), results: [], ms: 0 };
  try {
    const addon = await load(file);
    const cp = childPlay(addon, { quick, shots: !!shotsDir });
    if (!cp) { report.error = 'not a craftmatic pack (no scripts/placement.js)'; reports.push(report); console.log(`${report.pack}: ${report.error}`); continue; }
    report.label = cp.pack.placement.label;
    const scenarios = (custom ? custom(cp.pack) : cp.scenarios).filter(s => !only || s.name.includes(only));
    console.log(`${report.pack}: ${scenarios.length} scenarios`);
    for (const s of scenarios) {
      // Each scenario on a fresh world: the add-on is read again so no state leaks between them.
      const r = await runScenario(s, [await load(file)], { handlers: cp.handlers });
      // Pictures go to --shots as PNG files; the report keeps their names only.
      const shots = (r.state['snapshots'] as Snapshot[] | undefined) ?? [];
      if (shots.length && shotsDir) {
        mkdirSync(shotsDir, { recursive: true });
        for (const sh of shots) await sharp(Buffer.from(sh.rgb), { raw: { width: sh.width, height: sh.height, channels: 3 } }).png().toFile(join(shotsDir, `${basename(file, '.mcaddon')}-${r.name}-${sh.name}.png`));
      }
      r.state['snapshots'] = shots.map(sh => sh.name);
      report.results.push(r);
      if (r.status === 'fail') failed++;
      console.log(statusLine(r));
      for (const v of r.violations) console.log(`      [${v.invariant}] ${v.message.slice(0, 220)}`);
      for (const st of r.steps.filter(x => !x.ok)) console.log(`      step ${st.label} ERROR: ${st.error}`);
    }
  } catch (e) { report.error = (e as Error).message; console.log(`${report.pack}: ERROR ${report.error}`); }
  report.ms = Math.round(performance.now() - t0);
  reports.push(report);
}
const ranking = unmodelledTotals(reports.flatMap(r => r.results));
console.log(`\n${reports.length} packs; ${reports.flatMap(r => r.results).length} scenarios; ${failed} failed. Unmodelled: ${ranking.length ? ranking.map(u => `${u.member} x${u.count}`).join(', ') : 'none'}`);
if (flag('md')) writeFileSync(flag('md')!, markdownReport(reports));
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(reports, null, 1));
process.exit(failed ? 1 : 0);
