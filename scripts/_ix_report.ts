/**
 * Print what a built pack's moving parts are (bedrock-interactives.ts): the
 * `interactives` block of `craftmatic-diagnostics.json` and the runtime config
 * of `scripts/interactives.js`, one line per part.
 *
 * Usage: bun scripts/_ix_report.ts <pack.mcaddon> [--json]
 */
import { readFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';

const file = process.argv[2];
if (!file) { console.error('usage: bun scripts/_ix_report.ts <pack.mcaddon> [--json]'); process.exit(2); }
const bytes = readFileSync(file);
const found = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, n => /craftmatic-diagnostics\.json$|scripts\/interactives\.js$/.test(n));
const utf8 = new TextDecoder();
let diag: { interactives?: Array<Record<string, unknown>> } = {};
let script = '';
for (const [name, data] of found) {
  if (name.endsWith('craftmatic-diagnostics.json')) diag = JSON.parse(utf8.decode(data));
  else script = utf8.decode(data);
}
const rows = diag.interactives ?? [];
if (process.argv.includes('--json')) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
console.log(`${file}: ${rows.length} moving part${rows.length === 1 ? '' : 's'}${script ? '' : ' (no scripts/interactives.js)'}`);
for (const r of rows) console.log(`  ${String(r['label']).padEnd(12)} ${String(r['part']).padEnd(10)} angle ${String(r['angleDeg']).padStart(6)}  parts ${r['parts']}  offGrid ${r['offGridDeg']}°${r['openingBlocks'] ? `  opening ${JSON.stringify(r['openingBlocks'])}` : ''}${r['passSize'] !== undefined ? `  passSize ${r['passSize']}` : ''}  blocking ${r['blockingCells']}  cleared ${r['cleared']}+${r['passageCleared']}${r['sweepHits'] ? `  sweep ${JSON.stringify(r['sweepHits'])}` : ''}`);
