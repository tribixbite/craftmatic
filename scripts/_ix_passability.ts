/**
 * Walk a player through every doorway of built packs, open and closed, over
 * the exact collider blocks each pack ships (engine/interactive-walk.ts).
 *
 * Usage: bun scripts/_ix_passability.ts <pack.mcaddon…> [--sizes=100,200] [--rotations=0,90] [--json=out.json]
 *
 * Per doorway and size/turn it prints: whether the opening is passable at that
 * size (`passSize`), the walk with the door OPEN and with it CLOSED, and a
 * verdict: OK when open-and-passable passes and closed blocks; SMALL when the
 * opening is under the 1 x 2-block passage at that size and both are blocked
 * (the runtime keeps a too-small doorway blocked on purpose); FAIL otherwise;
 * NO-APPROACH when there is nowhere to stand on one side; SEALED when, open,
 * one side cannot reach the doorway at all (the model put solid geometry
 * there - a door into rock). Exit 1 on any FAIL.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { walkThroughDoorway, type DoorwayWalkResult } from '../web/src/engine/interactive-walk.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sizes = (flag('sizes') ?? '100,200').split(',').map(Number);
const rotations = (flag('rotations') ?? '0,90').split(',').map(Number) as QuarterTurn[];
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: bun scripts/_ix_passability.ts <pack.mcaddon…> [--sizes=100,200] [--rotations=0,90] [--json=out.json]'); process.exit(2); }

export type Verdict = 'OK' | 'SMALL' | 'FAIL' | 'NO-APPROACH' | 'SEALED';
/** The verdict for one doorway at one size and turn, from its open and closed walks. */
export function verdictOf(open: DoorwayWalkResult, closed: DoorwayWalkResult): Verdict {
  if (closed.outcome === 'passed') return 'FAIL';
  if (open.outcome === 'sealed') return 'SEALED';
  if (open.outcome === 'no-approach' || closed.outcome === 'no-approach') return 'NO-APPROACH';
  if (closed.outcome === 'passed') return 'FAIL';
  if (open.passableAtSize) return open.outcome === 'passed' ? 'OK' : 'FAIL';
  return open.outcome === 'passed' ? 'FAIL' : 'SMALL';
}

const report: Array<Record<string, unknown>> = [];
let failures = 0;
for (const file of files) {
  const bytes = readFileSync(file);
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const cfg = model.interactives;
  if (!cfg) { console.log(`${basename(file)}: no moving parts`); report.push({ pack: basename(file), doorways: 0 }); continue; }
  const doorways = cfg.items.map((it, i) => ({ it, i })).filter(({ it }) => it.passSize !== undefined && it.blocking.length);
  const counts: Record<string, number> = {};
  for (const it of cfg.items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  console.log(`${basename(file)}: ${cfg.items.length} moving parts ${JSON.stringify(counts)}, ${doorways.length} doorways`);
  const pack = { cells: model.cells, dims: model.dims, interactives: cfg, shippedTreads: (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r) };
  const rows: Array<Record<string, unknown>> = [];
  for (const { it, i } of doorways) for (const size of sizes) for (const rot of rotations) {
    const open = walkThroughDoorway(pack, i, size, rot, true);
    const closed = walkThroughDoorway(pack, i, size, rot, false);
    const verdict = verdictOf(open, closed);
    if (verdict === 'FAIL') failures++;
    rows.push({ label: it.label, kind: it.kind, opening: it.opening, passSize: it.passSize, size, rotation: rot, open: open.outcome, closed: closed.outcome, verdict, openDirections: open.directions, closedDirections: closed.directions });
    console.log(`  ${it.label.padEnd(9)} ${it.kind.padEnd(5)} ${JSON.stringify(it.opening ?? {}).padEnd(26)} pass>=${String(it.passSize).padEnd(3)} @${String(size).padEnd(3)}/${String(rot).padEnd(3)} open:${open.outcome.padEnd(11)} closed:${closed.outcome.padEnd(11)} ${verdict}`);
  }
  report.push({ pack: basename(file), counts, doorways: doorways.length, rows });
}
const out = flag('json');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
if (failures) { console.log(`${failures} FAIL`); process.exit(1); }
