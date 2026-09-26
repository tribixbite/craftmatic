/**
 * Run a real pack's moving-parts runtime in the host simulation with EVERY
 * part spawned (so double-door partners act as on the device), stand the
 * player at a spot, aim at a part's closed tap box and tap it; print what the
 * runtime did - open state, angle and events of every part it touched, the
 * collider cells it wrote, and anything it said.
 *
 * Usage: bun scripts/_ix_host_trace.ts <pack.mcaddon> <label regex> <feetX,feetY,feetZ> [taps=1] [box index=middle]
 */
import { readFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { hitGroupName, worldHitBox, type HitBox, type InteractiveRuntimeConfig } from '../web/src/engine/bedrock-interactives.ts';
import { colliderSourceCells } from '../web/src/engine/bedrock-placement-pack.ts';
import { runtimeHost } from '../test/_ix-host.ts';

const [path, labelRe, feet, tapsArg, boxArg] = process.argv.slice(2);
if (!path || !labelRe || !feet) { console.error('usage: bun scripts/_ix_host_trace.ts <pack> <label regex> <x,y,z feet> [taps] [box]'); process.exit(2); }
const bytes = readFileSync(path);
const found = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), n => /scripts\/(placement|interactives)\.js$/.test(n) || /_BP\/entities\/[^/]+\.json$/.test(n));
const utf8 = new TextDecoder();
let placement: any = {}, cfg: InteractiveRuntimeConfig | null = null;
const groups = new Map<string, Record<string, any>>();
for (const [name, data] of found) {
  const text = utf8.decode(data);
  const m = /^const CONFIG = (\{.*\});$/m.exec(text);
  if (name.endsWith('placement.js')) { if (m) placement = JSON.parse(m[1]!); continue; }
  if (name.endsWith('interactives.js')) { if (m) cfg = JSON.parse(m[1]!); continue; }
  try { const e = JSON.parse(text)['minecraft:entity']; if (e?.description?.identifier) groups.set(e.description.identifier, e.component_groups ?? {}); } catch { /* not an entity */ }
}
if (!cfg) throw new Error('no interactives config');
const h = runtimeHost(cfg);
for (const c of colliderSourceCells(placement.colliders)) h.setCollider(c.x, c.y, c.z, c.lo, c.hi, c.v ?? 0);
const anchor = { x: 0, y: 0, z: 0 };
const spawned = (placement.actors as any[]).filter(a => a.interactive !== undefined).map(a => ({ a, e: h.spawn(a.interactive, anchor, 1, 0, { x: a.x, y: a.y, z: a.z }) }));
h.sync();
const before = new Map(h.blocks);
const target = spawned.find(s => new RegExp(labelRe, 'i').test(s.a.label));
if (!target) throw new Error(`no part matches ${labelRe}`);
const boxes: HitBox[] = groups.get(target.a.typeId)?.[hitGroupName(0, 100, false)]?.['minecraft:custom_hit_test']?.hitboxes ?? [];
const bi = boxArg !== undefined ? Number(boxArg) : Math.floor(boxes.length / 2);
const wb = worldHitBox([target.a.x, target.a.y, target.a.z], boxes[bi]!);
const at = { x: (wb.x0 + wb.x1) / 2, y: (wb.y0 + wb.y1) / 2, z: (wb.z0 + wb.z1) / 2 };
const [fx, fy, fz] = feet.split(',').map(Number) as [number, number, number];
h.aim({ x: fx, y: fy + 1.62, z: fz }, at);
for (let t = 0; t < Number(tapsArg ?? 1); t++) {
  h.tap(target.e);
  console.log(`tap ${t + 1} on ${target.a.label} box ${bi} at ${[at.x, at.y, at.z].map(v => v.toFixed(2)).join(', ')} from feet ${feet}`);
  for (const s of spawned) {
    const open = s.e.getDynamicProperty('craftmatic:ix_open');
    if (open !== undefined || s === target) console.log(`   ${s.a.label.padEnd(20)} open=${open} angle=${s.e.angle} last event=${s.e.events.at(-1)}`);
  }
  const changed = [...new Set([...before.keys(), ...h.blocks.keys()])].filter(k => JSON.stringify(before.get(k)) !== JSON.stringify(h.blocks.get(k)));
  console.log(`   collider cells changed vs sync: ${changed.length}${changed.length ? ` (${changed.slice(0, 8).join(' ')}${changed.length > 8 ? ' ...' : ''})` : ''}`);
  if (h.bars.length) console.log(`   said: ${h.bars.at(-1)}`);
}
