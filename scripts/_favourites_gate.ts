/**
 * The favourites gate (PROC-19, audit A-16): build the favourites as the LEGO tab does and judge them with every
 * simulator suite that a phone round would otherwise answer, over ONE directory, into ONE report.
 *
 *   1. sweep        `_favorites_export_sweep.ts --with-regressions` (LEGO-tab labels, regression stems): the favourites
 *                   and every pack the regression set names (the Gabby sets, 7140, the nimbus fixture), so no case is
 *                   NOT TESTED for want of its pack (favgate-e7da6e47: 10 were);
 *   2. child-play   `sim.ts <dir> --sizes=50,100,150,200,400`: every size step the 2026-11-15 audit found failing.
 *                   `sim.ts` alone places 100 and 150 percent (`CHILD_PLAY_SIZES`, kept quick for development), which
 *                   passed 240 of 240 while 27 of 320 scenarios at 50, 200 and 400 failed in 15 packs;
 *   3. vehicles     `sim.ts <dir> --scenario=vehicles`;
 *   4. regressions  `sim.ts --scenario=regressions --new=<dir>` (the device-bug set on this build).
 * Then a CONTENT section (`scripts/pack-content.ts`, generality census 2026-11-16): per pack, boxed placements,
 * unresolved and substituted parts, real / default faces, floating parts and the coarsened share, read from the
 * sweep's `<stem>.json` build reports - totals and the worst packs. It reports; it never fails the gate.
 *
 * Usage: bun scripts/_favourites_gate.ts [set…] [--out=<dir>] [--build] [--with-gabby] [--faces=<dir>] [--content-only]
 *   --content-only  skip every step and write only the content section over the reports already in <dir>.
 *   --out=<dir>   the packs' directory (default `output/favgate-<pipeline stamp>`); also where the report goes.
 *   --build       run the sweep first (otherwise the packs already in <dir> are judged). Commit first: the packs
 *                 stamp the pipeline, and the sweep spawns one export per set over the tree as it is then.
 *   --faces=<dir> face art for every export (the sweep's `--faces=`, `_playable_ref.ts --faces=`).
 *   set…          only these favourites (the sweep's and the simulator's selection; no regression packs).
 * Output: <dir>/gate.md (one row per step: exit code, minutes, its summary lines) and <dir>/gate-<step>.json.
 * Exit 1 when any step fails. A full gate over 40 packs takes about 25 minutes on this machine (child play ~19).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { contentSection, contentTotals, packContent, readBuildReports } from './pack-content.ts';

/** The wand sizes the favourites gate places: the sizes a child picks that have failed before (A-16). */
export const FAVOURITES_GATE_SIZES: readonly number[] = [50, 100, 150, 200, 400];

/** One step of the gate: its name and the `bun` arguments that run it. */
export interface GateStep { name: 'sweep' | 'child-play' | 'vehicles' | 'regressions'; argv: string[] }

/** What the gate runs, in order (pure: the test pins it). `sets` empty = every favourite in `dir`. */
export function gateSteps(o: { dir: string; sets: readonly string[]; withGabby: boolean; build: boolean; faces?: string | undefined }): GateStep[] {
  const steps: GateStep[] = [];
  // A full build also makes every pack the regression step asks for (named sets build only themselves).
  if (o.build) steps.push({ name: 'sweep', argv: ['scripts/_favorites_export_sweep.ts', ...o.sets, '--out', o.dir, ...(o.withGabby ? ['--with-gabby'] : []), ...(o.sets.length ? [] : ['--with-regressions']), ...(o.faces ? [`--faces=${o.faces}`] : [])] });
  const json = (name: string) => `--json=${o.dir}/gate-${name}.json`;
  // The simulator takes a directory or packs; with named sets, the packs of those sets in the directory.
  const packs = o.sets.length ? o.sets.map(s => `${o.dir}/${s}*.mcaddon`) : [o.dir];
  steps.push({ name: 'child-play', argv: ['scripts/sim.ts', ...packs, `--sizes=${FAVOURITES_GATE_SIZES.join(',')}`, json('child-play')] });
  // Named sets: no vehicle among them is not a failure, and only their own regression cases have a pack here
  // (fav4-1124: 47 cases NOT TESTED and 'no scripted vehicles' made two false FAILs, PROC-20).
  const named = o.sets.length > 0;
  steps.push({ name: 'vehicles', argv: ['scripts/sim.ts', ...packs, '--scenario=vehicles', ...(named ? ['--allow-none'] : []), json('vehicles')] });
  steps.push({ name: 'regressions', argv: ['scripts/sim.ts', '--scenario=regressions', `--new=${o.dir}`, ...(named ? [`--sets=${o.sets.join(',')}`] : []), json('regressions')] });
  return steps;
}

/** Expand `<dir>/<set>*.mcaddon` against the directory (no shell runs the simulator). */
function expandPacks(argv: string[]): string[] {
  return argv.flatMap(a => {
    const m = /^(.*)\/([^/]+)\*\.mcaddon$/.exec(a);
    if (!m) return [a];
    const [, dir, prefix] = m as unknown as [string, string, string];
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.mcaddon')).map(f => `${dir}/${f}`);
  });
}

/** The lines of a step's output worth keeping in the report: its summary and every failure line. */
function summaryLines(out: string): string[] {
  return out.split(/\r?\n/).filter(l => /\bfail\b|FAIL|NOT TESTED|error|scenarios;|packs;|OK |verdict|unmodelled/i.test(l)).slice(-60);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outArg = argv.find(a => a.startsWith('--out='));
  let dir = outArg ? outArg.slice('--out='.length) : '';
  if (!dir) {
    // Named for the HEAD commit the packs are built from (`+dirty` for an uncommitted pipeline).
    let name = 'unstamped';
    try {
      const s = JSON.parse(spawnSync('bun', ['scripts/pipeline-stamp.ts'], { encoding: 'utf8' }).stdout) as { head?: string; dirty?: boolean };
      if (s.head) name = `${s.head}${s.dirty ? '+dirty' : ''}`;
    } catch { /* unstamped */ }
    dir = `output/favgate-${name}`;
  }
  mkdirSync(dir, { recursive: true });
  const sets = argv.filter(a => !a.startsWith('--'));
  const faces = argv.find(a => a.startsWith('--faces='))?.slice('--faces='.length);
  const contentOnly = argv.includes('--content-only');
  const steps = contentOnly ? [] : gateSteps({ dir, sets, withGabby: argv.includes('--with-gabby'), build: argv.includes('--build'), faces });
  const rows: string[] = [];
  let failed = false;
  for (const step of steps) {
    const args = expandPacks(step.argv);
    const t0 = Date.now();
    console.log(`[gate] ${step.name}: bun ${args.join(' ')}`);
    const r = spawnSync('bun', args, { encoding: 'utf8', maxBuffer: 1 << 30 });
    const minutes = ((Date.now() - t0) / 60000).toFixed(1), out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    writeFileSync(`${dir}/gate-${step.name}.log`, out);
    const code = r.status ?? 1;
    if (code !== 0) failed = true;
    console.log(`[gate] ${step.name}: exit ${code} in ${minutes} min`);
    rows.push(`## ${step.name}: ${code === 0 ? 'PASS' : `FAIL (exit ${code})`}, ${minutes} min\n\n\`bun ${args.join(' ')}\`\n\n\`\`\`\n${summaryLines(out).join('\n')}\n\`\`\`\n`);
  }
  const section = contentFor(dir);
  if (contentOnly) {
    // Keep the steps' results and verdict; only the content numbers are refreshed.
    const existing = existsSync(`${dir}/gate.md`) ? readFileSync(`${dir}/gate.md`, 'utf8') : `# Favourites gate\n\nDirectory: \`${dir}\`; content only, no step was run.\n`;
    writeFileSync(`${dir}/gate.md`, section ? withContentSection(existing, section) : existing);
    console.log(`[gate] content: ${dir}/gate.md`);
    process.exit(0);
  }
  const report = `# Favourites gate\n\nDirectory: \`${dir}\`; sizes ${FAVOURITES_GATE_SIZES.join(', ')} percent; ${failed ? 'FAILED' : 'passed'}.\nLogs: \`gate-<step>.log\`, JSON: \`gate-<step>.json\`.\n\n${rows.join('\n')}`;
  writeFileSync(`${dir}/gate.md`, section ? withContentSection(report, section) : report);
  console.log(`[gate] report: ${dir}/gate.md`);
  process.exit(failed ? 1 : 0);
}

/**
 * The report with `section` (the content section, `contentSection`) as its LAST section: an older content section is
 * replaced, every step row and the verdict line are kept. A `--content-only` run passes the existing gate.md, so it
 * refreshes the content numbers without erasing the step results (2026-11-16: it rewrote gate.md as an empty
 * "passed" report, and no full run wrote the section at all).
 */
export function withContentSection(report: string, section: string): string {
  const at = report.search(/^## content\b/m);
  const steps = (at >= 0 ? report.slice(0, at) : report).replace(/\s+$/, '');
  return `${steps}\n\n${section.replace(/\s+$/, '')}\n`;
}

/** The content section over the build reports in `dir` (empty when there are none); also writes gate-content.json. */
function contentFor(dir: string): string {
  const rows = readBuildReports(dir).map(({ stem, report }) => packContent(stem, report));
  if (!rows.length) return '';
  writeFileSync(`${dir}/gate-content.json`, JSON.stringify({ totals: contentTotals(rows), rows }, null, 1));
  return contentSection(rows);
}

// Run as a script only (`import.meta.main` is Bun's); the test imports the pure parts.
if ((import.meta as { main?: boolean }).main) {
  if (!existsSync('scripts/sim.ts')) { console.error('run from the repo root'); process.exit(2); }
  await main();
}
