/**
 * Assemble an LXFML whose sub-builds are stored laid out side by side, and
 * report what moved (engine/lxfml-assembly.ts).
 *
 * Usage: bun scripts/_lxfml_assemble.ts <in.lxfml> [out.lxfml] [--root-step]
 *          [--minParts N] [--minMove N] [--seat N]
 *
 *   --root-step  take the instruction's TOP-LEVEL step as the finished-model
 *                page and apply every placement it makes (sub-builds, figures,
 *                the dragon, the cart), nested frames composed — `composeRootStep`.
 *                Without it, the seating heuristic (`assembleLxfml`) decides
 *                one large move at a time and cannot place a figure indoors.
 *                76417 is built with it (2026-09-24).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { assembleLxfml, composeRootStep, readPartOrigins } from '../web/src/engine/lxfml-assembly.ts';

const argv = process.argv.slice(2);
const NUMERIC = new Set(['--minParts', '--minMove', '--seat']);
const flag = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? Number(argv[i + 1]) : fallback;
};
// Left undefined unless asked, so the module's own measured defaults apply.
const opts: Record<string, number> = {};
for (const [name, key] of [['minParts', 'minParts'], ['minMove', 'minDistanceUnits'], ['seat', 'seatToleranceUnits']] as const) {
  const v = flag(name, NaN);
  if (Number.isFinite(v)) opts[key] = v;
}
const rootStep = argv.includes('--root-step');
// A value follows only the NUMERIC flags; a boolean flag must not swallow the path after it.
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && NUMERIC.has(argv[i - 1]!)));
const inPath = positional[0]!;
const outPath = positional[1];
const xml = readFileSync(inPath, 'utf8');

const extent = (text: string): string => {
  const o = [...readPartOrigins(text).values()];
  const s = [0, 1, 2].map(a => {
    let lo = Infinity, hi = -Infinity;
    for (const p of o) { lo = Math.min(lo, p[a]!); hi = Math.max(hi, p[a]!); }
    return (hi - lo).toFixed(1);
  });
  return `${o.length} parts, extent ${s[0]} x ${s[1]} x ${s[2]} units (X x Y up x Z)`;
};

console.log(`${basename(inPath)}${rootStep ? '   [--root-step]' : ''}`);
console.log(`  before: ${extent(xml)}`);
const result = rootStep ? composeRootStep(xml) : assembleLxfml(xml, opts);
console.log(`  after:  ${extent(result.xml)}`);
console.log(`  applied ${result.applied.length} move(s)${Object.keys(opts).length ? `   [${JSON.stringify(opts)}]` : ''}`);
for (const note of result.notes) console.log(`    ${note}`);
if (outPath && result.applied.length) { writeFileSync(outPath, result.xml); console.log(`  wrote ${outPath}`); }
