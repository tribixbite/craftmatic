/**
 * The headless Bedrock simulator's CLI (web/src/sim, docs/sim-engine.md):
 * load built packs exactly as shipped, run their scripts against the mock
 * `@minecraft/server`, play scenarios with invariants, report.
 *
 * Usage:
 *   bun scripts/sim.ts <pack.mcaddon | dir>… [--scenario=child-play|regressions|<file.ts>]
 *        [--json=<out.json>] [--md=<out.md>] [--quick] [--only=<scenario substring>] [--shots=<dir>]
 *        [--new=<dir>]   (regressions: the current tree's packs, `<dir>/<stem>.mcaddon`)
 *        [--runtime=pack|tree]   (tree: each pack's figures/rides/vehicles scripts rebuilt from its own
 *                                 CONFIG with THIS tree's runtimes; regressions: the new side only)
 *   bun scripts/sim.ts --scenario=hop --coaster=<10261> --flyer=<nimbus> [--car=<42639>|same] [--slide=<10788>] [--json=] [--md=]
 *   bun scripts/sim.ts <packs> --scenario=input [--only=tap-occlusion] [--md=]
 *   bun scripts/sim.ts <pack> --scenario=input --device-script=<round tool or session file> [--device-args=<$1>]
 *        [--device-pin=x,y,z] [--tool-rev=<git rev>] [--md=]
 *   bun scripts/sim.ts <packs> --scenario=child-play --sneak-toggle      (only the doorway scenarios, sneak left ON)
 *   bun scripts/sim.ts <packs> --scenario=vehicles|input|child-play --cost (predicted ms/tick per phone)
 *
 *   child-play   (default) every craftmatic pack's generated scenarios: place at
 *                100/150 percent and turns 0/90, tap every part, walk every
 *                doorway, ride, drive, fly, let figures live 5 minutes, Undo.
 *   regressions  the 2026-09-29 device-bug set: each on the pack the device ran
 *                and on `--new=<dir>`'s build; packs on the command line are ignored.
 *   vehicles     every scripted car, hover craft and ship of each pack on the
 *                vehicle course (web/src/sim/adapters/craftmatic/vehicle-course.ts):
 *                stick forward into a step, a hill, a kerb, a wall, a tree, an
 *                angled wall and two pits; a ship's spaceship controls; the free look.
 *   hop          several packs in ONE world (web/src/sim/adapters/craftmatic/hop.ts):
 *                a flyer's cloud flown into a moving coaster train (and into a full
 *                one), a car parked at a slide's foot slid into.
 *   input        the client's hand (web/src/sim/adapters/craftmatic/input-probe.ts):
 *                per scripted vehicle the mount snap, a drag at rest and driving, a
 *                pitch drag and player_relative; the flyer's swipe and look-down +
 *                Jump; `tap-occlusion` (each moving part tapped on the screen at its
 *                drawn centre); with `--device-script=` an adb round's tools
 *                replayed on the Pixel's screen model after the placement (the
 *                device's `/tp` coordinates moved by `--device-pin=` onto the
 *                placement's anchor; `--tool-rev=` reads `scripts/` tools as they
 *                were at that revision, the round's version).
 *   <file.ts>    a module exporting `scenarios(pack: CraftmaticPack): Scenario[]`.
 *   --sneak-toggle  child-play runs only its doorway scenarios, with the touch
 *                sneak TOGGLE left on before the doorway lines (quirk
 *                `touch-sneak-toggle`).
 *   --cost       count the scripts' facade calls per tick and turn the vehicles'
 *                telemetry on: predicted ms/tick p50/p95 per phone (quirks/cost.ts),
 *                `tick-budget` warnings over 25 ms (never a failure).
 *   --shots      child-play also takes first-person pictures (after placing, after
 *                the figures lived) and writes them there as PNG.
 *
 * Exit 1 for a failed, errored or unmodelled scenario, an unreadable pack,
 * a regression verdict FAIL / NOT TESTED, or no applicable selected cases. A
 * KNOWN-UNREPRODUCED regression (the case records why the simulator cannot show
 * the device bug, and the current pack passes) is listed apart and does not.
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
import { REGRESSIONS, regressionVerdict } from '../web/src/sim/adapters/craftmatic/regressions.ts';
import { swapTreeRuntimes } from '../web/src/sim/adapters/craftmatic/runtime-swap.ts';
import { hopCases } from '../web/src/sim/adapters/craftmatic/hop.ts';
import { courseMarkdown, vehicleCourseHandlers, vehicleScenarios, type CourseRow } from '../web/src/sim/adapters/craftmatic/vehicle-course.ts';
import type { Scenario, StepHandler } from '../web/src/sim/scenario/types.ts';
import { execFileSync } from 'node:child_process';
import { INPUT_HANDLERS } from '../web/src/sim/input/steps.ts';
import { deviceScriptScenario, inputProbeHandlers, inputScenarios, sneakToggleScenarios, type DeviceScriptInput } from '../web/src/sim/adapters/craftmatic/input-probe.ts';
import { parseCmvtSamples, summarizeCost, type CostSummary } from '../web/src/sim/quirks/cost.ts';
import { COSTED_CALLS, type TickCost } from '../web/src/sim/script-host/host.ts';
import type { Simulation } from '../web/src/sim/core/simulation.ts';
import { VEHICLE_TELEMETRY_EVENT } from '../web/src/engine/bedrock-vehicle.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const mode = flag('scenario') ?? 'child-play';
const quick = args.includes('--quick');
const only = flag('only');
const shotsDir = flag('shots');
const inputs = args.filter(a => !a.startsWith('--'));
const packs = inputs.flatMap(p => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(p, f)) : [p]));

// `--runtime=tree`: run each pack's figures/rides/vehicles scripts as THIS tree builds them from the
// pack's own CONFIG (adapters/craftmatic/runtime-swap.ts) - a runtime fix measured on the packs a device ran.
const runtime = flag('runtime') ?? 'pack';
if (runtime !== 'pack' && runtime !== 'tree') { console.error('--runtime= is pack (as shipped) or tree (this tree\'s runtimes)'); process.exit(2); }
const load = async (file: string, swap = runtime === 'tree'): Promise<Awaited<ReturnType<typeof readAddon>>> => {
  const b = readFileSync(file);
  const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
  if (swap) swapTreeRuntimes(addon);
  return addon;
};
const statusLine = (r: ScenarioResult): string => `  ${r.name.padEnd(28)} ${r.status.padEnd(7)} ${String(r.violations.length).padStart(3)} violation(s) ${String(r.ticks).padStart(6)} ticks ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.unmodelled.length ? `  unmodelled: ${r.unmodelled.map(u => u.member).join(', ')}` : ''}`;

let failed = 0;

// ─── --cost: facade counts and the vehicles' telemetry, turned into predicted ms/tick ───
const costOn = args.includes('--cost');
/** One scenario's cost: the predicted ms/tick from the telemetry and the facade calls per tick by script. */
interface CostRow { pack: string; scenario: string; summary: CostSummary; calls: Array<{ source: string; p50: number; p95: number; max: number; getBlockMax: number }>; maxTick?: { tick: number; calls: number } }
const costRows: CostRow[] = [];
/** The run options --cost adds: counters on, the timeline kept, the vehicles' telemetry switched on before the first step. */
const costOptions = (capture: { sim?: Simulation }): { costCounters?: boolean; keepTimeline?: boolean; prepare?: (sim: Simulation) => void } => (!costOn ? {} : {
  costCounters: true, keepTimeline: true,
  prepare: sim => { capture.sim = sim; sim.engine.emit('scriptEventReceive', { id: VEHICLE_TELEMETRY_EVENT, message: 'fast' }); },
});
const pctOf = (xs: number[], p: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!; };
/** Fold one finished scenario into the cost table (prints its line). */
const recordCost = (pack: string, r: ScenarioResult, sim: Simulation | undefined): void => {
  if (!costOn || !sim) return;
  const text = (r.timeline ?? []).filter(e => e.kind === 'console').map(e => e.text).join('\n');
  const summary = summarizeCost(parseCmvtSamples(text));
  const log: TickCost[] = sim.host.costLog;
  const sources = new Set(log.flatMap(t => Object.keys(t.bySource)));
  const calls = [...sources].map(source => {
    const per = log.map(t => COSTED_CALLS.reduce((n, c) => n + (t.bySource[source]?.[c] ?? 0), 0));
    return { source, p50: pctOf(per, 0.5), p95: pctOf(per, 0.95), max: Math.max(0, ...per), getBlockMax: Math.max(0, ...log.map(t => t.bySource[source]?.getBlock ?? 0)) };
  }).sort((a, b) => b.max - a.max);
  const totals = log.map(t => ({ tick: t.tick, calls: Object.values(t.bySource).reduce((n, by) => n + COSTED_CALLS.reduce((m, c) => m + (by[c] ?? 0), 0), 0) }));
  const maxTick = totals.reduce<{ tick: number; calls: number } | undefined>((m, t) => (!m || t.calls > m.calls ? t : m), undefined);
  costRows.push({ pack, scenario: r.name, summary, calls, ...(maxTick ? { maxTick } : {}) });
  const s = summary;
  console.log(`      cost (PREDICTED): ${s.movingSamples ? `sweepChecks p50 ${s.sweepChecksP50} p95 ${s.sweepChecksP95}; Pixel ${s.predicted.pixel.p50}/${s.predicted.pixel.p95} ms, Saga ${s.predicted.saga.p50}/${s.predicted.saga.p95} ms (p50/p95) over ${s.movingSamples} moving samples` : 'no moving vehicle telemetry'}; busiest tick ${maxTick ? `${maxTick.tick}: ${maxTick.calls} calls` : '-'}`);
  for (const w of s.warnings) console.log(`      WARN ${w}`);
};
/** The cost table (markdown). */
const costMarkdown = (): string => {
  if (!costOn) return '';
  const lines = ['', '## Predicted cost per tick (quirks/cost.ts: PREDICTED from device telemetry, never measured here)', '',
    '| pack | scenario | moving samples | sweepChecks p50 / p95 | Pixel ms p50 / p95 | Saga ms p50 / p95 | busiest tick (calls) | top script: calls/tick p50 / p95 / max (getBlock max) |', '|---|---|---|---|---|---|---|---|'];
  for (const c of costRows) {
    const s = c.summary, top = c.calls[0];
    lines.push(`| ${c.pack} | ${c.scenario} | ${s.movingSamples} | ${s.movingSamples ? `${s.sweepChecksP50} / ${s.sweepChecksP95}` : '-'} | ${s.movingSamples ? `${s.predicted.pixel.p50} / ${s.predicted.pixel.p95}` : '-'} | ${s.movingSamples ? `${s.predicted.saga.p50} / ${s.predicted.saga.p95}` : '-'} | ${c.maxTick ? `${c.maxTick.tick} (${c.maxTick.calls})` : '-'} | ${top ? `${top.source}: ${top.p50} / ${top.p95} / ${top.max} (${top.getBlockMax})` : '-'} |`);
  }
  const warns = costRows.flatMap(c => c.summary.warnings.map(w => `- ${c.pack} \`${c.scenario}\`: ${w}`));
  lines.push('', warns.length ? '### tick-budget warnings' : 'No `tick-budget` warning (predicted p95 under 25 ms everywhere).', '', ...warns);
  return `${lines.join('\n')}\n`;
};
/** Every note of the results, for the markdown of the input scenarios (the replay log and the probes' readings). */
const notesMarkdown = (reports: readonly PackReport[]): string => {
  const lines = ['', '## Notes', ''];
  for (const r of reports) for (const res of r.results) for (const n of res.notes) lines.push(`- **${r.pack}** \`${res.name}\`: ${n.replace(/\|/g, '\\|')}`);
  return `${lines.join('\n')}\n`;
};

// ─── --device-script: an adb round's tools, read from disk (or from git at --tool-rev) ───
const deviceFile = flag('device-script');
const toolRev = flag('tool-rev');
/** A tool's text by the path a round script names: Git Bash paths (`/c/...`) read as Windows ones; `scripts/` tools at `--tool-rev` when given. */
const readTool = (path: string): string | undefined => {
  const p = path.replace(/^\/([a-zA-Z])\//, (_m, d: string) => `${d.toUpperCase()}:/`);
  if (toolRev && /[\\/]craftmatic[\\/]scripts[\\/][^\\/]+$/.test(p)) {
    try { return execFileSync('git', ['show', `${toolRev}:scripts/${basename(p)}`], { encoding: 'utf8' }); } catch { return undefined; }
  }
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
};
const devicePin = flag('device-pin')?.split(',').map(Number);
const deviceInput = (): DeviceScriptInput | undefined => {
  if (!deviceFile) return undefined;
  const text = readTool(resolve(deviceFile).replace(/\\/g, '/'));
  if (text === undefined) { console.error(`--device-script: cannot read ${deviceFile}`); process.exit(2); }
  const devArgs = flag('device-args');
  return { file: resolve(deviceFile).replace(/\\/g, '/'), text, args: devArgs !== undefined ? [devArgs] : [], readTool, ...(devicePin?.length === 3 && devicePin.every(Number.isFinite) ? { pin: { x: devicePin[0]!, y: devicePin[1]!, z: devicePin[2]! } } : {}) };
};
/** The input module's step handlers on top of a pack's. */
const withInput = (pack: CraftmaticPack, addon: Awaited<ReturnType<typeof readAddon>>, base: Record<string, StepHandler>): Record<string, StepHandler> => ({ ...base, ...INPUT_HANDLERS, ...inputProbeHandlers(pack, addon, deviceInput()) });

if (mode === 'regressions') {
  const newDir = flag('new');
  if (!newDir) { console.error('--scenario=regressions needs --new=<dir> (the current tree\'s packs)'); process.exit(2); }
  const selected = REGRESSIONS.filter(c => !only || c.id.includes(only));
  if (!selected.length) { console.error(`--scenario=regressions selected no cases${only ? ` for --only=${only}` : ''}`); process.exit(2); }
  console.log(`Regression selection: ${selected.length}/${REGRESSIONS.length} case(s)${only ? ` (--only=${only})` : ''}`);
  const rows: RegressionRow[] = [];
  let notTested = 0;
  const known: string[] = [];
  for (const c of selected) {
    // The OLD side is always the pack as the device ran it (it must reproduce); only the new side takes `--runtime`.
    const run = async (file: string, swap: boolean): Promise<RegressionRow['old']> => {
      if (!existsSync(file)) return { error: `missing ${file}` };
      const addon = await load(file, swap);
      const pack = readCraftmaticPack(addon);
      if (!pack) return { error: `${file} is not a craftmatic pack` };
      const r = await runScenario(c.scenario(pack), [addon], { handlers: withInput(pack, addon, craftmaticHandlers(pack, addon)) });
      const j = c.judge(r, pack);
      const failedSteps = r.steps.filter(s => !s.ok).map(s => `${s.label}: ${s.error}`);
      if (r.status === 'unknown' || r.status === 'error' || failedSteps.length) {
        return { error: `${file}: ${r.status}${failedSteps.length ? `; ${failedSteps.join('; ')}` : ''}${r.unmodelled.length ? `; unmodelled ${r.unmodelled.map(u => u.member).join(', ')}` : ''}` };
      }
      // A targeted symptom can be fixed while another invariant fails. Put
      // that failure first so a red verdict never prints only success text.
      const otherFailures = r.status === 'fail' && !j.reproduced
        ? r.violations.map(v => `[${v.invariant}] ${v.message}`).join('; ')
        : '';
      const evidence = otherFailures ? `${otherFailures}; targeted check: ${j.evidence}` : j.evidence;
      return { reproduced: j.reproduced, ...(j.attribution ? { attribution: j.attribution } : {}), ...(j.untested ? { untested: j.untested } : {}), evidence, status: r.status, ms: r.ms };
    };
    const oldR = await run(c.oldPack, false), newR = await run(resolve(newDir, `${c.newStem}.mcaddon`), runtime === 'tree');
    const v = regressionVerdict(c, oldR, newR), verdict = v.verdict;
    if (v.failing) failed++;
    if (v.notTested) notTested++;
    if (v.known) known.push(c.id);
    rows.push({ id: c.id, title: c.title, evidence: c.evidence, expectNew: c.expectNew, old: oldR, new: newR, verdict, ...(c.limits ? { limits: c.limits } : {}) });
    console.log(`${c.id}: old ${'error' in oldR ? oldR.error : oldR.reproduced ? `REPRODUCED${oldR.attribution ? ` (${oldR.attribution})` : ''}` : 'not reproduced'}; new ${'error' in newR ? newR.error : newR.reproduced ? `REPRODUCED${newR.attribution ? ` (${newR.attribution})` : ''}` : 'not reproduced'} -> ${verdict}`);
    for (const [k, x] of [['old', oldR], ['new', newR]] as const) if (!('error' in x)) console.log(`    ${k}: ${x.evidence.slice(0, 300)}`);
  }
  const md = regressionMarkdown(rows);
  if (flag('md')) writeFileSync(flag('md')!, md);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(rows, null, 1));
  console.log(`\n${rows.length} selected regression(s); ${failed - notTested} failed; ${notTested} not tested; ${known.length} known-unreproduced.`);
  // Listed on their own: these pass only their current-pack check (the old pack never showed the device bug here).
  if (known.length) console.log(`KNOWN-UNREPRODUCED (not failing the run): ${known.join(', ')}`);
  process.exit(failed ? 1 : 0);
}

if (mode === 'hop') {
  const named = async (n: string): Promise<Awaited<ReturnType<typeof load>> | undefined> => { const f = flag(n); return f ? load(f) : undefined; };
  const slide = await named('slide');
  // `--car=same`: the slide pack's own car (a set with both, 10797).
  const cases = hopCases({ coaster: await named('coaster'), flyer: await named('flyer'), slide, car: flag('car') === 'same' ? slide : await named('car') });
  if (!cases.length) { console.error('--scenario=hop needs --coaster= and --flyer=, and/or --slide= and --car='); process.exit(2); }
  const report: PackReport = { pack: 'hop', results: [], ms: 0 };
  const t0 = performance.now();
  for (const c of cases) {
    if (only && !c.scenario.name.includes(only)) continue;
    const r = await runScenario(c.scenario, c.addons, { handlers: c.handlers });
    report.results.push(r);
    if (r.status !== 'pass') failed++;
    console.log(statusLine(r));
    for (const v of r.violations) console.log(`      [${v.invariant}] ${v.message.slice(0, 220)}`);
    for (const st of r.steps.filter(x => !x.ok)) console.log(`      step ${st.label} ERROR: ${st.error}`);
    for (const n of r.notes) console.log(`      ${n.slice(0, 260)}`);
  }
  report.ms = Math.round(performance.now() - t0);
  if (flag('md')) writeFileSync(flag('md')!, markdownReport([report]));
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify([report], null, 1));
  if (!report.results.length) console.error('hop: NOT TESTED — no scenarios matched');
  process.exit(failed || !report.results.length ? 1 : 0);
}

if (!packs.length) { console.error('usage: bun scripts/sim.ts <pack.mcaddon | dir>… [--scenario=child-play|regressions|vehicles|<file.ts>] [--json=] [--md=] [--quick] [--only=] [--new=<dir>] [--runtime=pack|tree]'); process.exit(2); }

if (mode === 'vehicles') {
  const reports: PackReport[] = [], rows: CourseRow[] = [];
  let selected = 0;
  for (const file of packs) {
    const t0 = performance.now();
    const report: PackReport = { pack: basename(file), results: [], ms: 0 };
    try {
      const addon = await load(file);
      const pack = readCraftmaticPack(addon);
      if (!pack) { report.error = 'not a craftmatic pack'; failed++; reports.push(report); continue; }
      report.label = pack.placement.label;
      const scenarios = vehicleScenarios(pack).filter(s => !only || s.name.includes(only));
      selected += scenarios.length;
      console.log(`${report.pack}: ${scenarios.length} scripted vehicle(s)`);
      for (const s of scenarios) {
        const fresh = await load(file);
        const p = readCraftmaticPack(fresh)!;
        const capture: { sim?: Simulation } = {};
        const scen = costOn ? { ...s, allowLines: [...(s.allowLines ?? []), /CMVT|CMCAM/] } : s;
        const r = await runScenario(scen, [fresh], { handlers: withInput(p, fresh, { ...craftmaticHandlers(p, fresh), ...vehicleCourseHandlers(p) }), ...costOptions(capture) });
        report.results.push(r);
        rows.push(...((r.state['course'] as CourseRow[] | undefined) ?? []));
        if (r.status !== 'pass') failed++;
        console.log(statusLine(r));
        recordCost(report.pack, r, capture.sim);
        delete r.timeline;
        for (const v of r.violations) console.log(`      [${v.invariant}] ${v.message.slice(0, 220)}`);
        for (const st of r.steps.filter(x => !x.ok)) console.log(`      step ${st.label} ERROR: ${st.error}`);
        for (const n of r.notes) console.log(`      ${n.slice(0, 400)}`);
      }
    } catch (e) { failed++; report.error = (e as Error).message; console.log(`${report.pack}: ERROR ${report.error}`); }
    report.ms = Math.round(performance.now() - t0);
    reports.push(report);
  }
  const table = courseMarkdown(rows, 'The vehicle course (stick forward only)');
  console.log(`\n${table}`);
  if (flag('md')) writeFileSync(flag('md')!, `${table}\n${markdownReport(reports)}${costMarkdown()}`);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ course: rows, reports, ...(costOn ? { cost: costRows } : {}) }, null, 1));
  if (!selected) {
    console.error(`vehicles: NOT TESTED — no scripted vehicles matched${only ? ` --only=${only}` : ''} in ${reports.length} pack(s)`);
    process.exit(1);
  }
  process.exit(failed ? 1 : 0);
}

if (mode === 'input') {
  const reports: PackReport[] = [];
  const device = deviceInput();
  let selected = 0;
  for (const file of packs) {
    const t0 = performance.now();
    const report: PackReport = { pack: basename(file), results: [], ms: 0 };
    try {
      const addon = await load(file);
      const pack = readCraftmaticPack(addon);
      if (!pack) { report.error = 'not a craftmatic pack'; failed++; reports.push(report); continue; }
      report.label = pack.placement.label;
      // A device-script run replays the script only; otherwise every input scenario of the pack.
      const scenarios = (device ? [deviceScriptScenario(device)] : inputScenarios(pack)).filter(s => !only || s.name.includes(only));
      selected += scenarios.length;
      console.log(`${report.pack}: ${scenarios.length} input scenario(s)`);
      for (const s of scenarios) {
        const fresh = await load(file);
        const p = readCraftmaticPack(fresh)!;
        const capture: { sim?: Simulation } = {};
        const scen = costOn ? { ...s, allowLines: [...(s.allowLines ?? []), /CMVT|CMCAM/] } : s;
        const r = await runScenario(scen, [fresh], { handlers: withInput(p, fresh, craftmaticHandlers(p, fresh)), ...costOptions(capture) });
        report.results.push(r);
        if (r.status !== 'pass') failed++;
        console.log(statusLine(r));
        for (const v of r.violations) console.log(`      [${v.invariant}] ${v.message.slice(0, 260)}`);
        for (const st of r.steps.filter(x => !x.ok)) console.log(`      step ${st.label} ERROR: ${st.error}`);
        for (const n of r.notes) console.log(`      ${n.slice(0, 400)}`);
        recordCost(report.pack, r, capture.sim);
        delete r.timeline;
      }
    } catch (e) { failed++; report.error = (e as Error).message; console.log(`${report.pack}: ERROR ${report.error}`); }
    report.ms = Math.round(performance.now() - t0);
    reports.push(report);
  }
  if (flag('md')) writeFileSync(flag('md')!, `${markdownReport(reports, 'Simulator input run')}${notesMarkdown(reports)}${costMarkdown()}`);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ reports, ...(costOn ? { cost: costRows } : {}) }, null, 1));
  if (!selected) { console.error(`input: NOT TESTED — no input scenarios matched${only ? ` --only=${only}` : ''}`); process.exit(1); }
  process.exit(failed ? 1 : 0);
}

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
    if (!cp) { failed++; report.error = 'not a craftmatic pack (no scripts/placement.js)'; reports.push(report); console.log(`${report.pack}: ${report.error}`); continue; }
    report.label = cp.pack.placement.label;
    const base = custom ? custom(cp.pack) : cp.scenarios;
    // `--sneak-toggle`: only the doorway scenarios, each with the touch sneak toggle left ON before its lines.
    const scenarios = (args.includes('--sneak-toggle') ? sneakToggleScenarios(base) : base).filter(s => !only || s.name.includes(only));
    console.log(`${report.pack}: ${scenarios.length} scenarios`);
    for (const s of scenarios) {
      // Each scenario on a fresh world: the add-on is read again so no state leaks between them.
      const fresh = await load(file);
      const capture: { sim?: Simulation } = {};
      const scen = costOn ? { ...s, allowLines: [...(s.allowLines ?? []), /CMVT|CMCAM/] } : s;
      const r = await runScenario(scen, [fresh], { handlers: { ...cp.handlers, ...INPUT_HANDLERS }, ...costOptions(capture) });
      recordCost(report.pack, r, capture.sim);
      delete r.timeline;
      // Pictures go to --shots as PNG files; the report keeps their names only.
      const shots = (r.state['snapshots'] as Snapshot[] | undefined) ?? [];
      if (shots.length && shotsDir) {
        mkdirSync(shotsDir, { recursive: true });
        for (const sh of shots) await sharp(Buffer.from(sh.rgb), { raw: { width: sh.width, height: sh.height, channels: 3 } }).png().toFile(join(shotsDir, `${basename(file, '.mcaddon')}-${r.name}-${sh.name}.png`));
      }
      r.state['snapshots'] = shots.map(sh => sh.name);
      report.results.push(r);
      if (r.status !== 'pass') failed++;
      console.log(statusLine(r));
      for (const v of r.violations) console.log(`      [${v.invariant}] ${v.message.slice(0, 220)}`);
      for (const st of r.steps.filter(x => !x.ok)) console.log(`      step ${st.label} ERROR: ${st.error}`);
    }
  } catch (e) { failed++; report.error = (e as Error).message; console.log(`${report.pack}: ERROR ${report.error}`); }
  report.ms = Math.round(performance.now() - t0);
  reports.push(report);
}
const ranking = unmodelledTotals(reports.flatMap(r => r.results));
console.log(`\n${reports.length} packs; ${reports.flatMap(r => r.results).length} scenarios; ${failed} failed. Unmodelled: ${ranking.length ? ranking.map(u => `${u.member} x${u.count}`).join(', ') : 'none'}`);
if (flag('md')) writeFileSync(flag('md')!, `${markdownReport(reports)}${args.includes('--sneak-toggle') ? notesMarkdown(reports) : ''}${costMarkdown()}`);
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(costOn ? { reports, cost: costRows } : reports, null, 1));
if (!reports.some(r => r.results.length)) console.error(`${mode}: NOT TESTED — no scenarios ran`);
process.exit(failed || !reports.some(r => r.results.length) ? 1 : 0);
