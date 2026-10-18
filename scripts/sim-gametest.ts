/**
 * Run a GameTest pack's tests OFFLINE, in the headless simulator, with the
 * same test definitions the Pixel runs (web/src/sim/script-host/gametest-module.ts),
 * and write the same `CMGT` lines the phone's content log gets - so a device
 * GameTest run becomes a diff against an expected log instead of a reading.
 *
 * Usage:
 *   bun scripts/sim-gametest.ts <pack.mcaddon> [--tag=craftmatic_gt] [--only=<test substring>] [--log=<out.log>] [--md=<out.md>] [--json=<out.json>] [--out=<dir>]
 *        A model pack is first built into its GameTest variant by `scripts/_gametest_pack.ts` (into `--out`,
 *        default output/sim-gametest/); a pack that already carries `scripts/gametest.js` (a variant, or the quirk
 *        probe) is run as it is. Every registered test with the tag (default: any) runs in a fresh world, one after
 *        the other. Exit 1 when a test fails, times out or errors, or reaches an unmodelled API member.
 *   bun scripts/sim-gametest.ts --replay=<cmgt.log | ContentLog.txt> [--pack=<pack.mcaddon>] [--log=] [--md=] [--out=<dir>]
 *        Re-derive every verdict line of a past device run: the log's tests are run offline on `--pack` (the variant
 *        the device ran, or a model pack to build one from); a quirk-probe log (`QTP`/`QDM`/`QREACH`/`QBANDS`) builds
 *        the probe with `scripts/_gametest_quirks.ts` when no pack is named. Prints the row-by-row diff; exit 1 on any
 *        differing verdict (each is a finding: a quirk row to add or correct, never a test to tune).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readAddon, type Addon } from '../web/src/sim/pack/pack.ts';
import { Simulation } from '../web/src/sim/core/simulation.ts';
import { runGametest, type GametestRunResult } from '../web/src/sim/script-host/gametest-module.ts';
import { compareRows, isQuirkLog, parseCmgt, replayMarkdown, verdictRows } from '../web/src/sim/adapters/craftmatic/gametest-replay.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const outDir = resolve(flag('out') ?? 'output/sim-gametest');
mkdirSync(outDir, { recursive: true });

/** Read an add-on archive. */
async function load(file: string): Promise<Addon> {
  const b = readFileSync(file);
  return readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
}

/** Whether an add-on carries a GameTest script (a variant, or the quirk probe). */
const hasTests = (a: Addon): boolean => a.packs.some(p => [...p.files.keys()].some(f => f === 'scripts/gametest.js') || (p.scriptModules?.['@minecraft/server-gametest'] !== undefined));

/** Run a builder script (`scripts/_gametest_pack.ts`, `scripts/_gametest_quirks.ts`) into `outDir` and return the archive it wrote. */
function build(script: string, extra: string[], expect: (files: string[]) => string | undefined): string {
  const r = spawnSync(process.execPath, [script, ...extra, `--out=${outDir}`], { encoding: 'utf8' });
  process.stdout.write(r.stdout ?? '');
  if (r.status !== 0) { process.stderr.write(r.stderr ?? ''); throw new Error(`${script} exited ${r.status}`); }
  const made = expect(readdirSync(outDir));
  if (!made) throw new Error(`${script} wrote no archive into ${outDir}`);
  return join(outDir, made);
}

/** The pack to run: a pack with tests as it is; a model pack built into its variant. */
async function testPack(file: string): Promise<string> {
  if (hasTests(await load(file))) return file;
  const stem = basename(file).replace(/\.mcaddon$/i, '');
  return build('scripts/_gametest_pack.ts', [file], files => files.find(f => f === `${stem}-gametest.mcaddon`));
}

/** Run every selected test of a pack, each in a fresh world; the results in registration order. */
async function runAll(file: string, select: (id: string, tags: readonly string[]) => boolean): Promise<GametestRunResult[]> {
  const probe = new Simulation();
  probe.loadAddon(await load(file));
  const ids = probe.gametests.tests.filter(t => select(t.id, t.settings.tags)).map(t => t.id);
  const results: GametestRunResult[] = [];
  for (const id of ids) {
    const sim = new Simulation();
    sim.loadAddon(await load(file));
    // A world's first ticks: chunks load, the packs' scripts start (worldLoad), as before `/gametest runset`.
    await sim.run(20);
    const def = sim.gametests.find(id);
    if (!def) { results.push({ id, status: 'error', message: 'not registered on reload', ticks: 0, lines: [] }); continue; }
    const t0 = performance.now();
    const r = await runGametest(sim, def);
    const unmodelled = sim.engine.timeline.unmodelledRanking();
    const errors = sim.engine.timeline.of('script-error').map(e => e.text);
    if (unmodelled.length && r.status === 'pass') { r.status = 'error'; r.message = `unmodelled API reached: ${unmodelled.map(u => u.member).join(', ')}`; }
    console.log(`  ${id.padEnd(40)} ${r.status.padEnd(7)} ${String(r.ticks).padStart(6)} ticks ${((performance.now() - t0) / 1000).toFixed(1).padStart(6)} s${r.message ? `  ${r.message.slice(0, 200)}` : ''}${unmodelled.length ? `  unmodelled: ${unmodelled.map(u => u.member).join(', ')}` : ''}${errors.length ? `  script errors: ${errors.slice(0, 2).join(' | ').slice(0, 300)}` : ''}`);
    results.push(r);
  }
  return results;
}

const replay = flag('replay');
if (replay) {
  const deviceLines = parseCmgt(readFileSync(replay, 'utf8'));
  const quirk = isQuirkLog(deviceLines);
  let pack = flag('pack');
  if (quirk && (!pack || !hasTests(await load(pack)))) {
    // The probe's tests, all of them (its log says which ran).
    pack = build('scripts/_gametest_quirks.ts', [], files => files.find(f => f === 'craftmatic-quirk-probe.mcaddon'));
  }
  if (!pack) { console.error('--replay needs --pack=<pack.mcaddon> (the variant the device ran, or a model pack) unless the log is the quirk probe\'s'); process.exit(2); }
  const file = await testPack(pack);
  // The tests the device log shows ran: a quirk log names them (`QUIRK_DONE`), a model log by its rows' kinds.
  const ranQuirk = new Set(deviceLines.filter(l => l.tag === 'QUIRK_DONE').map(l => String(l.data?.['test'])));
  const kinds = new Set(deviceLines.map(l => l.tag));
  const wants = (id: string): boolean => {
    const name = id.split(':')[1] ?? id;
    if (quirk) return ranQuirk.has(name) || (ranQuirk.size === 0);
    return (kinds.has('DOOR') && name.startsWith('doors_')) || (kinds.has('PART') || kinds.has('SEAT') ? name.startsWith('parts_') : false)
      || (kinds.has('SMOKE') && name === 'smoke') || (kinds.has('PINBALL') && name.startsWith('pinball_')) || (kinds.has('FIGURE_SUMMARY') && name.startsWith('figures_'))
      || (kinds.has('VEHICLE') && name.startsWith('vehicle_')) || (kinds.has('TRAIN') && name.startsWith('train_')) || (kinds.has('FLYER') && name.startsWith('flyer_'))
      || (kinds.has('CREATOR') && name.startsWith('creator_') && !name.startsWith('creator_wand_')) || (kinds.has('CREATOR_WAND') && name.startsWith('creator_wand_'));
  };
  console.log(`replay ${replay}: ${deviceLines.length} CMGT lines (${quirk ? 'quirk probe' : 'model tests'}); pack ${file}`);
  const results = await runAll(file, id => wants(id));
  const simLines = parseCmgt(results.flatMap(r => r.lines).join('\n'));
  const diffs = compareRows(verdictRows(deviceLines), verdictRows(simLines));
  const md = replayMarkdown(diffs, `Replay of ${basename(replay)} on ${basename(file)}`);
  console.log(`\n${md}`);
  if (flag('log')) writeFileSync(flag('log')!, results.flatMap(r => r.lines).join('\n') + '\n');
  if (flag('md')) writeFileSync(flag('md')!, md);
  if (flag('json')) writeFileSync(flag('json')!, JSON.stringify({ results, diffs }, null, 1));
  process.exit(diffs.some(d => !d.match) || !diffs.length ? 1 : 0);
}

const input = args.find(a => !a.startsWith('--'));
if (!input || !existsSync(input)) { console.error('usage: bun scripts/sim-gametest.ts <pack.mcaddon> [--tag=] [--only=] [--log=] [--md=] [--json=]  |  --replay=<log> [--pack=]'); process.exit(2); }
const file = await testPack(input);
const tag = flag('tag'), only = flag('only');
console.log(`${basename(file)}:`);
const results = await runAll(file, (id, tags) => (!tag || tags.includes(tag)) && (!only || id.includes(only)));
if (!results.length) { console.error(`NOT TESTED: no registered test matched${tag ? ` --tag=${tag}` : ''}${only ? ` --only=${only}` : ''}`); process.exit(1); }
const log = results.flatMap(r => r.lines).join('\n') + '\n';
if (flag('log')) writeFileSync(flag('log')!, log);
const md = [`# GameTests of ${basename(file)} in the simulator`, '', '| test | status | ticks | message |', '|---|---|---|---|', ...results.map(r => `| ${r.id} | ${r.status} | ${r.ticks} | ${(r.message ?? '').replace(/\|/g, '\\|').slice(0, 300)} |`), '', '## Verdict rows', '', '| tag | row | fields |', '|---|---|---|', ...verdictRows(parseCmgt(log)).map(r => `| ${r.tag} | ${r.key.replace(/\|/g, '\\|')} | ${Object.entries(r.fields).map(([k, v]) => `${k}: ${v}`).join('; ').replace(/\|/g, '\\|').slice(0, 400)} |`)].join('\n') + '\n';
if (flag('md')) writeFileSync(flag('md')!, md);
if (flag('json')) writeFileSync(flag('json')!, JSON.stringify(results, null, 1));
console.log(`\n${results.length} test(s): ${results.filter(r => r.status === 'pass').length} pass, ${results.filter(r => r.status !== 'pass').length} not`);
process.exit(results.every(r => r.status === 'pass') ? 0 : 1);
