/**
 * Tap-box audit over built packs (engine/interactive-hitbox-audit.ts): every
 * pair of moving parts whose shipped `minecraft:custom_hit_test` boxes overlap
 * (any combination of open and closed), and every part box over a seat.
 *
 * Usage: bun scripts/_ix_hitbox_audit.ts <pack.mcaddon | dir>...   (exit 1 on any overlap or missing box)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { auditPackHitboxes } from '../web/src/engine/interactive-hitbox-audit.ts';

const files = process.argv.slice(2).flatMap(p => statSync(p).isDirectory() ? readdirSync(p).filter(n => n.endsWith('.mcaddon')).sort().map(n => join(p, n)) : [p]);
if (!files.length) { console.error('usage: bun scripts/_ix_hitbox_audit.ts <pack.mcaddon | dir>...'); process.exit(2); }
let bad = 0, parts = 0, boxes = 0;
for (const f of files) {
  const b = readFileSync(f);
  const a = await auditPackHitboxes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
  parts += a.parts; boxes += a.boxes;
  const problems = [...a.partOverlaps, ...a.seatOverlaps.map(s => `seat: ${s}`), ...a.missing.map(m => `no boxes: ${m}`)];
  bad += problems.length;
  console.log(`${basename(f).padEnd(34)} parts ${String(a.parts).padStart(3)} seats ${String(a.seats).padStart(3)} boxes ${String(a.boxes).padStart(4)}${problems.length ? `  ${problems.join('; ')}` : '  ok'}`);
}
console.log(`${files.length} packs, ${parts} parts, ${boxes} boxes, ${bad} problem(s)`);
if (bad) process.exit(1);
