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
 * one side cannot reach the doorway at all (the model put solid geometry or a
 * drop there - a door into rock); STEP when that happens only above 100 %
 * (a riser grew past the jump). Exit 1 on any FAIL.
 *
 * An OK doorway is also walked the DEVICE's way (`doorwayColumnLines`): a
 * straight line through each of its leaf columns from 1.5 blocks out on each
 * side, the door open. A line whose feet fall past the jump under the
 * doorway's floor is a HOLE the verdict walk did not stand over (10326's
 * Door 1, Saga round 2026-09-29c: OK through one column of the leaf, a
 * 2.6-block pit through the other); it is printed, counted and written to
 * the JSON (`holes`), and does not change the verdict.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { doorwayColumnLines, doorwayHoles, verdictOf, walkThroughDoorway } from '../web/src/engine/interactive-walk.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const sizes = (flag('sizes') ?? '100,200').split(',').map(Number);
const rotations = (flag('rotations') ?? '0,90').split(',').map(Number) as QuarterTurn[];
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (!files.length) { console.error('usage: bun scripts/_ix_passability.ts <pack.mcaddon…> [--sizes=100,200] [--rotations=0,90] [--json=out.json]'); process.exit(2); }

const report: Array<Record<string, unknown>> = [];
let failures = 0, holeRows = 0;
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
    const okAt100 = size > 100 && walkThroughDoorway(pack, i, 100, rot, true).outcome === 'passed';
    const verdict = verdictOf(open, closed, okAt100);
    if (verdict === 'FAIL') failures++;
    // The device's line through every leaf column of an OK doorway: a fall past the jump is a hole.
    const lines = verdict === 'OK' ? doorwayColumnLines(pack, i, size, rot) : [];
    const holes = doorwayHoles(lines, size);
    // A line that STARTS more than a jump under the doorway's floor (the approach 1.5 blocks out is
    // already the ground or a street: 41732's Door 1 at 150 %, 10326's Door 1 on the ground plate) says the
    // door hangs over that ground, not that its threshold opened; the note says which.
    const startUnder = (h: (typeof holes)[number]): number => Math.round(((h.lowest + h.drop) - (h.start?.y ?? h.lowest)) * 100) / 100;
    if (holes.length) holeRows++;
    rows.push({ label: it.label, kind: it.kind, opening: it.opening, passSize: it.passSize, size, rotation: rot, open: open.outcome, closed: closed.outcome, verdict, openDirections: open.directions, closedDirections: closed.directions, ...(lines.length ? { lines } : {}), ...(holes.length ? { holes: holes.map(h => ({ column: h.column, from: h.from, drop: h.dropNear, startUnder: startUnder(h) })) } : {}) });
    const holeNote = holes.length ? `  HOLE ${holes.map(h => `${h.column.x},${h.column.z} from ${h.from > 0 ? '+' : '-'}: ${h.dropNear} down${startUnder(h) > 1.25 * Math.max(1, size / 100) ? ` (starts ${startUnder(h)} under)` : ''}`).join('; ')}` : '';
    console.log(`  ${it.label.padEnd(9)} ${it.kind.padEnd(5)} ${JSON.stringify(it.opening ?? {}).padEnd(26)} pass>=${String(it.passSize).padEnd(3)} @${String(size).padEnd(3)}/${String(rot).padEnd(3)} open:${open.outcome.padEnd(11)} closed:${closed.outcome.padEnd(11)} ${verdict}${holeNote}`);
  }
  report.push({ pack: basename(file), counts, doorways: doorways.length, rows });
}
const out = flag('json');
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
if (holeRows) console.log(`${holeRows} OK row${holeRows === 1 ? '' : 's'} with a HOLE on a leaf column's line`);
if (failures) { console.log(`${failures} FAIL`); process.exit(1); }
