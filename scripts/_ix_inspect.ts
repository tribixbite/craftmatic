/**
 * Print what a built pack ships for its seats and moving parts: each actor's
 * label, type and placement point, each interactive item's leaf data, and the
 * tap boxes (turn 0, 100 %, closed/open) its behaviour carries. A diagnostic
 * for device reports like "the seat floats above the chair" or "a tap on
 * window 1 does nothing".
 *
 * Usage: bun scripts/_ix_inspect.ts <pack.mcaddon> [label filter regex] [--raw]
 */
import { readFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { hitGroupName } from '../web/src/engine/bedrock-interactives.ts';

const argv = process.argv.slice(2);
const raw = argv.includes('--raw');
const [path, filter] = argv.filter(a => a !== '--raw');
if (!path) { console.error('usage: bun scripts/_ix_inspect.ts <pack.mcaddon> [label regex]'); process.exit(2); }
const bytes = readFileSync(path);
const found = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), n => /scripts\/(placement|interactives)\.js$/.test(n) || /_BP\/entities\/[^/]+\.json$/.test(n));
const utf8 = new TextDecoder();
let config: Record<string, unknown> & { actors?: Array<Record<string, unknown>> } = {};
let ixConfig: { items?: Array<Record<string, unknown>> } = {};
const groups = new Map<string, Record<string, unknown>>();
for (const [name, data] of found) {
  const text = utf8.decode(data);
  if (name.endsWith('placement.js')) { const m = /^const CONFIG = (\{.*\});$/m.exec(text); if (m) config = JSON.parse(m[1]!); continue; }
  if (name.endsWith('interactives.js')) { const m = /^const (?:CONFIG|IX) = (\{.*\});$/m.exec(text); if (m) ixConfig = JSON.parse(m[1]!); continue; }
  try { const e = JSON.parse(text)['minecraft:entity']; if (e?.description?.identifier) groups.set(e.description.identifier, e.component_groups ?? {}); } catch { /* not an entity */ }
}
const re = filter ? new RegExp(filter, 'i') : null;
for (const a of config.actors ?? []) {
  const label = String(a.label ?? a.typeId);
  if (re && !re.test(label) && !re.test(String(a.typeId))) continue;
  console.log(`${label.padEnd(28)} ${String(a.typeId).padEnd(44)} at ${[a.x, a.y, a.z].map(v => Number(v).toFixed(3)).join(', ')}${a.interactive !== undefined ? ` ix=${a.interactive}` : ''}`);
  if (raw) console.log('   ' + JSON.stringify(a));
  const g = groups.get(String(a.typeId));
  if (g && a.interactive !== undefined) for (const open of [false, true]) {
    const hb = (g[hitGroupName(0, 100, open)] as { 'minecraft:custom_hit_test'?: { hitboxes?: unknown[] } } | undefined)?.['minecraft:custom_hit_test']?.hitboxes ?? [];
    console.log(`   ${open ? 'open  ' : 'closed'} ${hb.length} boxes ${JSON.stringify(hb)}`);
  }
}
if (!ixConfig.items) console.log('(no interactives config found; keys:', Object.keys(config).join(','), ')');
for (const it of ixConfig.items ?? []) if (!re || re.test(String(it.label))) console.log(JSON.stringify(it));
