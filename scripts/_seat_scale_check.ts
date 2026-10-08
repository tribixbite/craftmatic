/**
 * Every rideable's seat against what its vehicle DRAWS, at every wand size,
 * for every built pack given - offline, from the pack's JSON alone
 * (web/src/sim/adapters/craftmatic/seat-scale.ts). A size group's declared
 * seat times its `minecraft:scale` is where the device puts the rider (quirk
 * `seat-scales-with-entity`, Saga round 30k: 76286's rider at 200 % sat six
 * blocks over the hull because the seat was written pre-scaled); the rider's
 * eye is 1.12 over it. At 100 % a seat is IN or ON its vehicle when it stands
 * within the drawn footprint and no more than `SEAT_ON_DRAWN.over` blocks over
 * the drawn surface under it (SEAT-01: "in the cockpit, never on top or
 * outside"); at every other size it must sit where the 100 % seat sits scaled
 * once (x, z; y between the plain-scaled and the eye-anchored seat), and its
 * place against the geometry at that scale is reported beside the verdict.
 *
 * Usage: bun scripts/_seat_scale_check.ts <pack.mcaddon | dir>... [--json=<out.json>] [--md=<out.md>] [--all]
 *   --all   print every row, not only the seats off their vehicle
 *
 * Exit 1 when any seat at any size is off its vehicle, or a pack cannot be read.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readAddon } from '../web/src/sim/pack/pack.ts';
import { behaviorPacks } from '../web/src/sim/pack/pack.ts';
import { packAppearance } from '../web/src/sim/adapters/craftmatic/drawn.ts';
import { describeSeatRow, seatScaleAudit, type SeatScaleRow, type SeatScaleSkip } from '../web/src/sim/adapters/craftmatic/seat-scale.ts';

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => args.find(a => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const all = args.includes('--all');
const inputs = args.filter(a => !a.startsWith('--'));
const packs = inputs.flatMap(p => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(p, f)) : [p]));
if (!packs.length) { console.error('usage: bun scripts/_seat_scale_check.ts <pack.mcaddon | dir>... [--json=] [--md=] [--all]'); process.exit(2); }

interface PackRows { pack: string; rows: SeatScaleRow[]; skipped: SeatScaleSkip[]; error?: string }
const report: PackRows[] = [];
let failed = 0;
const mark = (r: SeatScaleRow): string => (r.ok ? 'ok ' : 'OFF');

for (const file of packs) {
  const name = basename(file);
  try {
    const b = readFileSync(file);
    const addon = await readAddon(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, file);
    const appearance = packAppearance(addon);
    const rows: SeatScaleRow[] = [], skipped: SeatScaleSkip[] = [];
    for (const bp of behaviorPacks(addon)) { const a = seatScaleAudit(bp, appearance); rows.push(...a.rows); skipped.push(...a.skipped); }
    const bad = rows.filter(r => !r.ok);
    const types = new Set(rows.map(r => r.typeId)).size;
    console.log(`${name}: ${rows.length} seat-size rows over ${types} drawn rideable(s), ${bad.length} off the vehicle${skipped.length ? `; not judged: ${skipped.map(s => `${s.typeId} (${s.why})`).join(', ')}` : ''}`);
    for (const r of rows) if (all || !r.ok) console.log(`  ${mark(r)} ${describeSeatRow(r)}`);
    if (bad.length) failed++;
    report.push({ pack: name, rows, skipped });
  } catch (e) {
    failed++;
    console.log(`${name}: ERROR ${(e as Error).message}`);
    report.push({ pack: name, rows: [], skipped: [], error: (e as Error).message });
  }
}

const json = flag('json');
if (json) writeFileSync(json, JSON.stringify(report, null, 1));
const md = flag('md');
if (md) {
  const lines = ['| pack | rideable | size | scale | seat (declared) | seat (device) | eye | place at this scale | vs the 100 % seat scaled once | verdict |', '|---|---|---|---|---|---|---|---|---|---|'];
  const v = (p: { x: number; y: number; z: number }): string => `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
  const place = (r: SeatScaleRow): string => `${r.place.verdict}${r.place.over !== undefined ? ` (${r.place.over.toFixed(2)} over the drawn top)` : ''}`;
  const drift = (r: SeatScaleRow): string => (r.pct === 100 ? '-' : r.drift.ok ? 'same' : `drifts x ${r.drift.dx.toFixed(2)} y ${r.drift.dy.toFixed(2)} z ${r.drift.dz.toFixed(2)}`);
  for (const p of report) for (const r of p.rows) lines.push(`| ${p.pack} | ${r.typeId.replace(/^craftmatic:/, '')} | ${r.pct} % | ${r.scale} | ${v(r.declared)} | ${v(r.seat)} | ${v(r.eye)} | ${place(r)} | ${drift(r)} | ${r.ok ? 'ok' : '**OFF**'} |`);
  for (const p of report) if (p.error) lines.push(`| ${p.pack} | - | - | - | - | - | - | - | - | ERROR ${p.error} |`);
  writeFileSync(md, lines.join('\n') + '\n');
}
process.exit(failed ? 1 : 0);
