/**
 * The moving parts and doorway passability of every pack in a sweep directory
 * (`bun scripts/_favorites_export_sweep.ts --out DIR`): one row per set with
 * the parts by class, the seats, and each doorway's verdict at 100 % and at
 * its own passable size, both turned 0 (engine/interactive-walk.ts).
 *
 * Usage: bun scripts/_ix_sweep_report.ts <dir> [--json=out.json] [--md=out.md]
 * Exit 1 when any doorway FAILs (walked through closed, or blocked open at a
 * size its opening clears).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddonPreviewModel, treadBlocksAt } from '../web/src/ui/addon-preview-data.ts';
import { verdictOf, walkThroughDoorway, type Verdict } from '../web/src/engine/interactive-walk.ts';
import type { QuarterTurn } from '../web/src/engine/bedrock-collider-scale.ts';

const dir = process.argv[2];
const flag = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!dir) { console.error('usage: bun scripts/_ix_sweep_report.ts <dir> [--json=out.json] [--md=out.md]'); process.exit(2); }

const KINDS = ['door', 'gate', 'hatch', 'cabinet', 'window', 'lever', 'turnable'] as const;
interface Row {
  set: string; counts: Record<string, number>; seats: number; doorways: number;
  at100: Record<Verdict, number>; atPassSize: Record<Verdict, number>;
  never: number; failures: string[]; smallest: number[];
}
const zero = (): Record<Verdict, number> => ({ OK: 0, 'ONE-WAY': 0, SMALL: 0, FAIL: 0, 'NO-APPROACH': 0, SEALED: 0, STEP: 0 });
const rows: Row[] = [];
for (const name of readdirSync(dir).filter(n => n.endsWith('.mcaddon')).sort()) {
  const bytes = readFileSync(join(dir, name));
  const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const cfg = model.interactives;
  const counts: Record<string, number> = {};
  for (const it of cfg?.items ?? []) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  const row: Row = { set: name.replace(/\.mcaddon$/, ''), counts, seats: model.entities.filter(e => e.kind === 'seat' && !e.pinball).length, doorways: 0, at100: zero(), atPassSize: zero(), never: 0, failures: [], smallest: [] };
  if (cfg) {
    const pack = { cells: model.cells, dims: model.dims, interactives: cfg, shippedTreads: (s: number, r: QuarterTurn) => treadBlocksAt(model, s, r) };
    cfg.items.forEach((it, i) => {
      if (it.passSize === undefined || !it.blocking.length) return;
      row.doorways++;
      if (!it.passSize) row.never++;
      else row.smallest.push(it.passSize);
      const judge = (size: number): Verdict => {
        const open = walkThroughDoorway(pack, i, size, 0, true), closed = walkThroughDoorway(pack, i, size, 0, false);
        const ok100 = size > 100 && walkThroughDoorway(pack, i, 100, 0, true).outcome === 'passed';
        const v = verdictOf(open, closed, ok100);
        if (v === 'FAIL') row.failures.push(`${it.label} at ${size} %: open ${open.outcome}, closed ${closed.outcome}`);
        return v;
      };
      row.at100[judge(100)]++;
      if (it.passSize && it.passSize > 100) row.atPassSize[judge(it.passSize)]++;
    });
  }
  rows.push(row);
  console.log(`${row.set.padEnd(7)} ${KINDS.map(k => `${k} ${counts[k] ?? 0}`).join(' ')} seats ${row.seats} | doorways ${row.doorways}: @100 ${JSON.stringify(row.at100)}${row.atPassSize.OK + row.atPassSize.SMALL + row.atPassSize.SEALED + row.atPassSize.STEP + row.atPassSize.FAIL ? ` @passSize ${JSON.stringify(row.atPassSize)}` : ''}${row.never ? ` never-passable ${row.never}` : ''}${row.failures.length ? ` FAIL ${row.failures.join('; ')}` : ''}`);
}
const failures = rows.reduce((n, r) => n + r.failures.length, 0);
const out = flag('json');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
const md = flag('md');
if (md) {
  const head = `| set | door | gate | hatch | cabinet | window | lever | turnable | seats | doorways | OK @100 % | SMALL | SEALED | STEP | NO-APPROACH | FAIL | passable from |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  const body = rows.map(r => `| ${r.set} | ${KINDS.map(k => r.counts[k] ?? 0).join(' | ')} | ${r.seats} | ${r.doorways} | ${r.at100.OK} | ${r.at100.SMALL} | ${r.at100.SEALED} | ${r.at100.STEP} | ${r.at100['NO-APPROACH']} | ${r.at100.FAIL} | ${r.smallest.length ? [...new Set(r.smallest)].sort((a, b) => a - b).map(s => `${s} %`).join(', ') : '-'}${r.never ? ` (+${r.never} never)` : ''} |`).join('\n');
  writeFileSync(md, head + body + '\n');
}
console.log(`${rows.length} packs, ${rows.reduce((n, r) => n + r.doorways, 0)} doorways, ${failures} FAIL`);
if (failures) process.exit(1);
