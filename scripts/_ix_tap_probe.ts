/**
 * Tap audit over built packs (`test/_ix-tap-audit.ts`): for every moving part,
 * how many standing spots within touch reach see one of its tap boxes first,
 * and from how many the real runtime accepted the tap. Exit 1 when a part is
 * reachable but refuses every tap.
 *
 * Usage: bun scripts/_ix_tap_probe.ts <pack.mcaddon | dir> [--reach=3] [--all]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { auditPackTaps } from '../test/_ix-tap-audit.ts';

const args = process.argv.slice(2);
const target = args.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: bun scripts/_ix_tap_probe.ts <pack.mcaddon | dir> [--reach=3] [--all]'); process.exit(2); }
const reach = Number(args.find(a => a.startsWith('--reach='))?.slice(8) ?? 3);
const all = args.includes('--all');
const traceRe = args.find(a => a.startsWith('--trace='))?.slice(8);
const files = statSync(target).isDirectory() ? readdirSync(target).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(target, f)) : [target];
let refused = 0, unreachable = 0, total = 0;
for (const f of files) {
  const b = readFileSync(f);
  const audit = await auditPackTaps(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), { reach, trace: !!traceRe });
  for (const p of audit.parts) {
    total++;
    const bad = p.reachable > 0 && p.accepted === 0;
    if (bad) refused++;
    if (!p.reachable) unreachable++;
    if (all || bad || !p.reachable) console.log(`${f.split(/[\\/]/).pop()!.padEnd(44)} ${p.label.padEnd(20)} reachable ${String(p.reachable).padStart(4)}  accepted ${String(p.accepted).padStart(4)}  boxes ${p.boxes} (unreached ${p.unreachedBoxes})${bad ? '  REFUSED' : !p.reachable ? '  OUT OF REACH' : ''}`);
    if (traceRe && new RegExp(traceRe, 'i').test(p.label)) for (const s of p.spots ?? []) console.log(`   ${s.ok ? 'ok     ' : 'REFUSED'} feet ${s.at.map(v => v.toFixed(2)).join(', ')}`);
  }
}
console.log(`${files.length} packs, ${total} parts: ${refused} refuse every tap, ${unreachable} out of reach from any standing spot`);
process.exit(refused ? 1 : 0);
