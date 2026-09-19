/**
 * Regenerate web/src/engine/class-b-reframe-generated.ts from clego's
 * class_b_census.json — the part names both LDraw libraries ship with the
 * SAME mould in a different frame (docs/lego-sources-guide.md §7a).
 *
 * Usage: bun scripts/gen-class-b-reframe.ts [path/to/class_b_census.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface CensusRow {
  kind: 'shift' | 'rotated' | 'mirrored' | 'different';
  cloud: number;
  Q: number[] | null;
  t: number[] | null;
  placements: number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2] ?? 'C:/git/clego/class_b_census.json';
const census = JSON.parse(readFileSync(src, 'utf-8')) as { summary: Record<string, unknown>; stems: Record<string, CensusRow> };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
// A same-mould row whose frame is the identity within 0.5 LDU moves nothing
// (the census admitted it on an extent difference - a re-tessellated curve).
const isNoOp = (r: CensusRow): boolean =>
  r.Q!.every((v, i) => Math.abs(v - IDENTITY[i]!) < 1e-6) && r.t!.every(v => Math.abs(v) < 0.5);
const rows = Object.entries(census.stems)
  .filter(([, r]) => r.kind !== 'different' && r.Q && r.t && !isNoOp(r))
  .sort(([a], [b]) => a.localeCompare(b));
const fmt = (v: number): string => { const r = Math.round(v * 1000) / 1000; return String(r === 0 ? 0 : r); };
const lines = [
  '// AUTO-GENERATED — do not edit manually. Run: bun scripts/gen-class-b-reframe.ts',
  `// Generated: ${new Date().toISOString()}`,
  `// Source: ${src} (${rows.length} re-framed stems of ${Object.keys(census.stems).length} class-B stems)`,
  '// Each row is [q0..q8, t0, t1, t2]: studio_local = Q · upstream_local + t, Q row-major.',
  'export const CLASS_B_REFRAME: Record<string, readonly number[]> = {',
  ...rows.map(([stem, r]) => `  '${stem}': [${[...r.Q!, ...r.t!].map(fmt).join(', ')}], // ${r.kind} ${r.cloud} (${r.placements} placements)`),
  '};',
  '',
];
const out = join(root, 'web/src/engine/class-b-reframe-generated.ts');
writeFileSync(out, lines.join('\n'));
console.log(`${rows.length} stems -> ${out}`);
