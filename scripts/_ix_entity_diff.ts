/**
 * Print every file a pack ships for one or more entity type ids (behaviour,
 * client entity, geometry bones, animation, render controller), condensed,
 * so two moving parts can be compared side by side: "why does Door 1 not
 * swing when Door 2 does".
 *
 * Usage: bun scripts/_ix_entity_diff.ts <pack.mcaddon> <type substring>...
 */
import { readFileSync } from 'node:fs';
import { extractMatching } from '../web/src/engine/zip-utils.ts';

const [path, ...names] = process.argv.slice(2);
if (!path || !names.length) { console.error('usage: bun scripts/_ix_entity_diff.ts <pack> <type substring>...'); process.exit(2); }
const bytes = readFileSync(path);
const found = await extractMatching(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), n => names.some(s => n.includes(s)));
const utf8 = new TextDecoder();
for (const [name, data] of [...found].sort((a, b) => a[0].localeCompare(b[0]))) {
  const text = utf8.decode(data);
  let summary = text;
  try {
    const j = JSON.parse(text);
    const geo = j['minecraft:geometry'];
    if (geo) {
      summary = JSON.stringify(geo.map((g: any) => ({ id: g.description?.identifier, bones: g.bones?.map((b: any) => ({ name: b.name, parent: b.parent, pivot: b.pivot, rotation: b.rotation, cubes: b.cubes?.length ?? 0 })) })));
    } else {
      const e = j['minecraft:entity'];
      if (e) { const { component_groups, ...rest } = e; summary = JSON.stringify({ ...rest, component_groups: Object.keys(component_groups ?? {}).length }); }
      else summary = JSON.stringify(j);
    }
  } catch { /* not JSON */ }
  console.log(`== ${name} (${data.length} bytes)\n${summary.slice(0, 3000)}`);
}
