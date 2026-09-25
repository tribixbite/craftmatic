/**
 * Which doorways share cells (`shares`) and which of them are one double door
 * (`pairs`), over built packs: the doorways that touch a neighbour but move on
 * their own are the ones `pairDoubleDoors` split (76457's Door 1 and Door 2).
 *
 * Usage: bun scripts/_ix_pairs_report.ts <pack.mcaddon | dir> [--recompute]
 *   --recompute: pair the shipped leaves with the CURRENT `pairDoubleDoors`
 *   (to judge a rule change without rebuilding the packs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { pairDoubleDoors, type InteractiveRuntimeItem } from '../web/src/engine/bedrock-interactives.ts';

const target = process.argv.slice(2).find(a => !a.startsWith('--'));
const recompute = process.argv.includes('--recompute');
if (!target) { console.error('usage: bun scripts/_ix_pairs_report.ts <pack.mcaddon | dir>'); process.exit(2); }
const files = statSync(target).isDirectory() ? readdirSync(target).filter(f => f.endsWith('.mcaddon')).sort().map(f => join(target, f)) : [target];
let linked = 0, paired = 0;
for (const f of files) {
  const b = readFileSync(f);
  const found = await extractMatching(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), n => /scripts\/interactives\.js$/.test(n));
  for (const [, data] of found) {
    const m = /^const CONFIG = (\{.*\});$/m.exec(new TextDecoder().decode(data));
    if (!m) continue;
    const items = JSON.parse(m[1]!).items as InteractiveRuntimeItem[];
    if (recompute) { for (const it of items) delete it.pairs; pairDoubleDoors(items); }
    for (const it of items) {
      if (!it.shares.length) continue;
      linked++;
      if (it.pairs?.length) paired++;
      console.log(`${f.split(/[\\/]/).pop()!.padEnd(20)} ${it.label.padEnd(12)} shares ${it.shares.map(i => items[i]!.label).join(', ').padEnd(24)} ${it.pairs?.length ? `paired with ${it.pairs.map(i => items[i]!.label).join(', ')}` : 'moves on its own'}`);
    }
  }
}
console.log(`${files.length} packs: ${linked} doorways share cells with another, ${paired} of them are one double door, ${linked - paired} move on their own`);
