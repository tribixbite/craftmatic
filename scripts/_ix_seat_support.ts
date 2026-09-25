/**
 * What does each seat in a built pack stand on? For every seat actor, the
 * highest shipped collider top under its point (within its 0.5-block footprint)
 * and the gap between that top and the seat. A seat whose gap is more than a
 * few plates floats; one whose collider column has solid ABOVE its point sits
 * inside geometry.
 *
 * Usage: bun scripts/_ix_seat_support.ts <pack.mcaddon | dir>
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';

const arg = process.argv[2];
if (!arg) { console.error('usage: bun scripts/_ix_seat_support.ts <pack.mcaddon | dir>'); process.exit(2); }
const files = statSync(arg).isDirectory() ? readdirSync(arg).filter(f => f.endsWith('.mcaddon')).map(f => join(arg, f)) : [arg];
for (const f of files) {
  const b = readFileSync(f);
  const model = await loadAddonPreviewModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const seats = model.entities.filter(e => e.kind === 'seat');
  if (!seats.length) continue;
  for (const s of seats) {
    const { x, y, z } = s;
    let support = -Infinity, above = Infinity;
    for (const dx of [-0.25, 0.25]) for (const dz of [-0.25, 0.25]) {
      const vals = model.cells.filter(c => c.x === Math.floor(x + dx) && c.z === Math.floor(z + dz));
      for (const c of vals) {
        const lo = c.y + c.lo / 16, hi = c.y + c.hi / 16;
        if (hi <= y + 0.01 && hi > support) support = hi;
        if (lo > y + 0.01 && lo < above) above = lo;
      }
    }
    console.log(`${f.split(/[\\/]/).pop()!.padEnd(40)} ${String(s.label).padEnd(18)} at ${[x, y, z].map(v => v.toFixed(2)).join(', ')}  support top ${Number.isFinite(support) ? support.toFixed(2) : 'none'}  gap ${Number.isFinite(support) ? (y - support).toFixed(2) : '-'}  headroom ${Number.isFinite(above) ? (above - y).toFixed(2) : 'open'}`);
  }
}
