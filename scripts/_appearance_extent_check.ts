/**
 * Does the drawn model land on the collider grid it overlays?
 *
 * The preview divides Bedrock model units by 16 and scales by the wand size.
 * If that is wrong the model floats, sinks or is the wrong size, and the whole
 * point of the overlay — comparing what it LOOKS like against what you can
 * stand on — is lost. This compares the shell's own cube extent, in blocks,
 * against the collider grid the same pack ships.
 *
 * Usage: bun scripts/_appearance_extent_check.ts <pack.mcaddon…>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const model = await loadAddonPreviewModel(buffer);
  const shell = model.entities.find(e => e.kind === 'shell');
  const entry = shell && model.appearance ? model.appearance.byType.get(shell.typeId) : undefined;
  if (!entry) { console.log(`${basename(file)}: no shell appearance`); continue; }

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const g of entry.groups) for (const c of g.cubes) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, c.origin[a]!);
      hi[a] = Math.max(hi[a]!, c.origin[a]! + c.size[a]!);
    }
  }
  const blocks = [0, 1, 2].map(a => (hi[a]! - lo[a]!) / 16);
  const d = model.dims;
  console.log(`${basename(file)}`);
  console.log(`  shell cubes ${entry.cubeCount.toLocaleString()}  model-space extent (blocks): ${blocks.map(v => v.toFixed(1)).join(' x ')}`);
  console.log(`  collider grid (blocks):          ${d.width} x ${d.height} x ${d.length}`);
  const ratio = [blocks[0]! / d.width, blocks[1]! / d.height, blocks[2]! / d.length];
  console.log(`  ratio drawn/collider:            ${ratio.map(v => v.toFixed(2)).join(' x ')}  (1.00 means the /16 scale is right)`);
  if (model.notes.length) console.log(`  notes: ${model.notes.slice(0, 2).join(' | ')}`);
}
