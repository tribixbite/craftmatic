/**
 * Read a built pack's drawable appearance and print what the preview would
 * draw: per entity, how many cubes in how many colours. A pack whose model the
 * preview cannot reconstruct says so here, offline, instead of on a phone.
 *
 * Usage: bun scripts/_appearance_probe.ts <pack.mcaddon…>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractMatching } from '../web/src/engine/zip-utils.ts';
import { APPEARANCE_FILE_PATTERN, buildAddonAppearance } from '../web/src/ui/addon-appearance.ts';

const utf8 = new TextDecoder();
for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const found = await extractMatching(buffer, name => APPEARANCE_FILE_PATTERN.test(name));
  const sources = new Map<string, string>();
  for (const [name, data] of found) sources.set(name, utf8.decode(data));
  const app = buildAddonAppearance(sources);
  console.log(`${basename(file)}  files ${sources.size}  entities ${app.byType.size}  cubes ${app.cubeCount.toLocaleString()}`);
  for (const [id, e] of [...app.byType].sort((a, b) => b[1].cubeCount - a[1].cubeCount).slice(0, 6)) {
    const colours = new Set(e.groups.map(g => g.ldrawColor)).size;
    console.log(`   ${id.padEnd(40)} ${String(e.cubeCount).padStart(7)} cubes  ${String(e.groups.length).padStart(3)} chunks  ${colours} colours  ${e.bones.length} bones`);
  }
  for (const n of app.notes.slice(0, 4)) console.log(`   note: ${n}`);
  if (app.notes.length > 4) console.log(`   (+${app.notes.length - 4} more notes)`);
}
