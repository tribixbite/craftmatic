/**
 * ASCII plan of one doorway in a built pack: the collider blocks (at 100 %,
 * turn 0) in the rows a player occupies at the doorway floor, with the
 * doorway's closed cells and the leaf's normal marked. A debugging aid for
 * engine/interactive-walk.ts verdicts.
 *
 * Usage: bun scripts/_ix_doorway_map.ts <pack.mcaddon> <doorway index> [--radius=6]
 *   legend per cell (rows y0 / y0+1 / y0+2 as three characters): '#' solid,
 *   'd' closed-leaf cell, '.' air; '-' outside the footprint.
 */
import { readFileSync } from 'node:fs';
import { loadAddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { ixWorldBlocks } from '../web/src/engine/bedrock-interactives.ts';

const [file, idxText] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const radius = Number(process.argv.find(a => a.startsWith('--radius='))?.slice(9) ?? 6);
if (!file || idxText === undefined) { console.error('usage: bun scripts/_ix_doorway_map.ts <pack.mcaddon> <index> [--radius=6]'); process.exit(2); }
const bytes = readFileSync(file);
const model = await loadAddonPreviewModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
const cfg = model.interactives!;
const item = cfg.items[Number(idxText)]!;
const solid = new Map<string, [number, number]>();
for (const c of model.cells) solid.set(`${c.x},${c.y},${c.z}`, [c.lo, c.hi]);
const door = new Map<string, [number, number]>();
for (const c of item.blocking) door.set(`${c[0]},${c[1]},${c[2]}`, [c[3], c[4]]);
const xs = item.blocking.map(c => c[0]), ys = item.blocking.map(c => c[1]), zs = item.blocking.map(c => c[2]);
const y0 = Math.min(...ys);
console.log(`${item.label} ${item.kind} opening ${JSON.stringify(item.opening)} passSize ${item.passSize} blocking ${item.blocking.length} neighbours ${item.neighbours.length} normal ${JSON.stringify(item.normal)} pivot ${JSON.stringify(item.pivot)}`);
console.log(`blocking cells: ${JSON.stringify(item.blocking)}`);
console.log(`rows y${y0 - 2}..y${y0 + 2}; x ${Math.min(...xs) - radius}..${Math.max(...xs) + radius} across, z down`);
const ch = (x: number, y: number, z: number): string => {
  if (x < 0 || z < 0 || x >= model.dims.width || z >= model.dims.length) return '-';
  const k = `${x},${y},${z}`;
  if (door.has(k)) return 'd';
  const s = solid.get(k);
  if (!s) return '.';
  return s[1] - s[0] >= 12 ? '#' : s[1] <= 6 ? '_' : '+';
};
const header = [];
for (let x = Math.min(...xs) - radius; x <= Math.max(...xs) + radius; x++) header.push(String(((x % 100) + 100) % 100).padStart(6));
console.log('    z ' + header.join(''));
for (let z = Math.min(...zs) - radius; z <= Math.max(...zs) + radius; z++) {
  const row = [];
  for (let x = Math.min(...xs) - radius; x <= Math.max(...xs) + radius; x++) row.push(' ' + [y0 - 2, y0 - 1, y0, y0 + 1, y0 + 2].map(y => ch(x, y, z)).join(''));
  console.log(String(z).padStart(6) + row.join(''));
}
void ixWorldBlocks;
