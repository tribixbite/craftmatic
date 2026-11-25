/**
 * The walk-away table of a `sim.ts --scenario=walk-away` JSON report (TODO(cull-400), PROC-20): per pack, the share of
 * the shell's cubes drawn at each distance off the model's edge, the WORST bearing and the mean over bearings, and
 * every `model-vanishes` verdict. Two reports side by side (`--before=`) print the change per pack.
 *
 * Usage: bun scripts/_walk_away_table.ts <after.json> [--before=<before.json>]
 * The packs are matched by their file name's leading set number (`21065-…`), so a rebuilt pack under a new stem
 * still lines up with its old report.
 */
import { readFileSync } from 'node:fs';

/** One walk-away row as `walkAway` writes it into the scenario state. */
interface WalkRow { bearing?: number; distance: number; full: number; hull: number; gone: number; shellCubeShare?: number }
/** What the table reads of one pack: its rows and its `model-vanishes` messages. */
interface PackWalk { key: string; pack: string; rows: WalkRow[]; vanishes: string[] }

/** The packs of one report, keyed by the leading set number of the pack's file name. */
export function readWalkReport(file: string): Map<string, PackWalk> {
  const out = new Map<string, PackWalk>();
  const reports = JSON.parse(readFileSync(file, 'utf8')) as Array<{ pack: string; results?: Array<{ state?: Record<string, unknown>; violations?: Array<{ invariant: string; message: string }> }> }>;
  for (const r of reports) {
    const key = /^(\d+|[^-]+)/.exec(r.pack)?.[1] ?? r.pack;
    for (const s of r.results ?? []) {
      const rows = s.state?.['walkAway'] as WalkRow[] | undefined;
      if (!rows) continue;
      out.set(key, { key, pack: r.pack, rows, vanishes: (s.violations ?? []).filter(v => v.invariant === 'model-vanishes').map(v => v.message) });
    }
  }
  return out;
}

/** Per distance: the worst and the mean share over the bearings walked. */
export function shareByDistance(rows: readonly WalkRow[]): Map<number, { worst: number; mean: number }> {
  const by = new Map<number, number[]>();
  for (const r of rows) by.set(r.distance, [...(by.get(r.distance) ?? []), r.shellCubeShare ?? 0]);
  return new Map([...by].map(([d, v]) => [d, { worst: Math.min(...v), mean: v.reduce((a, b) => a + b, 0) / v.length }]));
}

const pct = (v: number | undefined): string => (v === undefined ? '-' : `${Math.round(v * 100)}`);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const after = args.find(a => !a.startsWith('--'));
  const beforeFile = args.find(a => a.startsWith('--before='))?.slice('--before='.length);
  if (!after) { console.error('usage: bun scripts/_walk_away_table.ts <after.json> [--before=<before.json>]'); process.exit(2); }
  const a = readWalkReport(after), b = beforeFile ? readWalkReport(beforeFile) : undefined;
  for (const [key, walk] of a) {
    const now = shareByDistance(walk.rows), was = b?.get(key) ? shareByDistance(b.get(key)!.rows) : undefined;
    console.log(`${walk.pack}: shell cubes drawn, percent (worst bearing / mean over bearings)${was ? ', before -> after' : ''}`);
    for (const [d, s] of now) {
      const old = was?.get(d);
      console.log(`  ${String(d).padStart(3)} blocks off: ${old ? `${pct(old.worst)}/${pct(old.mean)} -> ` : ''}${pct(s.worst)}/${pct(s.mean)}`);
    }
    for (const v of b?.get(key)?.vanishes ?? []) console.log(`  before: ${v}`);
    for (const v of walk.vanishes) console.log(`  after:  ${v}`);
  }
}
