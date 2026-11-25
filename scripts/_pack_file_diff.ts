/**
 * Which files two built packs differ in, byte for byte (cull-400): every archive entry of both, listed as only-in-A,
 * only-in-B or changed (with each side's size), the rest counted as identical. Used to prove a change leaves an
 * ordinary pack unchanged apart from what names the build (the pipeline stamp in pack names, manifests and the
 * diagnostics' provenance).
 *
 * Usage: bun scripts/_pack_file_diff.ts <a.mcaddon> <b.mcaddon> [--show=<entry substring>]
 *   --show  print the first differing line of each changed text entry whose name contains the substring.
 */
import { readFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';

const args = process.argv.slice(2);
const [fa, fb] = args.filter(a => !a.startsWith('--'));
const show = args.find(a => a.startsWith('--show='))?.slice('--show='.length);
if (!fa || !fb) { console.error('usage: bun scripts/_pack_file_diff.ts <a.mcaddon> <b.mcaddon> [--show=<entry substring>]'); process.exit(2); }

const read = async (f: string): Promise<Map<string, Uint8Array>> => {
  const b = new Uint8Array(readFileSync(f));
  const entries = await extractMatching(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, n => !n.endsWith('/'));
  return new Map([...entries].map(([n, data]) => [n, new Uint8Array(data)]));
};
const a = await read(fa), b = await read(fb);
const same = (x: Uint8Array, y: Uint8Array): boolean => x.length === y.length && x.every((v, i) => v === y[i]);
let identical = 0;
const changed: string[] = [];
for (const [name, x] of a) {
  const y = b.get(name);
  if (!y) { console.log(`only in A: ${name} (${x.length} B)`); continue; }
  if (same(x, y)) { identical++; continue; }
  changed.push(name);
  console.log(`changed:   ${name} (${x.length} -> ${y.length} B)`);
  if (show !== undefined && name.includes(show)) {
    const la = new TextDecoder().decode(x).split('\n'), lb = new TextDecoder().decode(y).split('\n');
    const i = la.findIndex((l, k) => l !== lb[k]);
    if (i >= 0) console.log(`  line ${i + 1}:\n  A ${la[i]!.slice(0, 300)}\n  B ${(lb[i] ?? '').slice(0, 300)}`);
  }
}
for (const name of b.keys()) if (!a.has(name)) console.log(`only in B: ${name} (${b.get(name)!.length} B)`);
console.log(`${identical} identical, ${changed.length} changed, ${[...a.keys()].filter(n => !b.has(n)).length} only in A, ${[...b.keys()].filter(n => !a.has(n)).length} only in B`);
