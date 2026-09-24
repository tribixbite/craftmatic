/**
 * Find large footprint 'box'-classified parts in test models by total block contribution.
 * Run: bun scripts/shape-gaps.ts
 */
import { getPartDims, getPartShape } from '../web/src/engine/ldraw-part-dims.js';
import { readFileSync } from 'fs';

function getPartsFromMPD(path: string): Record<string, number> {
  const lines = readFileSync(path, 'utf8').split('\n');
  const parts: Record<string, number> = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('1 ')) continue;
    const tokens = t.split(/\s+/);
    if (tokens.length < 15) continue;
    const partFile = tokens.slice(14).join(' ').toLowerCase();
    if (partFile.endsWith('.ldr') || partFile.includes('submodel')) continue;
    const id = partFile.replace(/\.dat$/, '');
    parts[id] = (parts[id] || 0) + 1;
  }
  return parts;
}

const models: Record<string, string> = {
  ISD:    'C:/git/craftmatic/data/seymouria/LDR/10030 Imperial Star Destroyer.mpd',
  Falcon: 'C:/git/craftmatic/data/seymouria/LDR/10179 UCS Millenium Falcon.mpd',
  Saturn: 'C:/git/craftmatic/web/public/21309-1.mpd',
};

interface PartInfo {
  id: string;
  w: number; h: number; l: number;
  shape: string;
  area: number;
  totalCount: number;
  models: string;
  blockContrib: number;
}

const found: Record<string, PartInfo> = {};

for (const [name, path] of Object.entries(models)) {
  const parts = getPartsFromMPD(path);
  for (const [id, count] of Object.entries(parts)) {
    const [w, h, l] = getPartDims(id);
    const shape = getPartShape(id);
    if (shape !== 'box' && shape !== 'flat') continue;  // only unmasked shapes
    const area = w * l;
    if (area < 4) continue;  // skip tiny parts
    if (!found[id]) found[id] = { id, w, h, l, shape, area, totalCount: 0, models: '', blockContrib: 0 };
    found[id].totalCount += count;
    found[id].blockContrib += count * w * h * l;
    found[id].models += `${name}:${count} `;
  }
}

const ranked = Object.values(found)
  .sort((a, b) => b.blockContrib - a.blockContrib)
  .slice(0, 30);

console.log('Box-classified parts with largest block contribution (area >= 4):');
console.log('id            dims        shape  count  blocks  models');
for (const p of ranked) {
  console.log(
    `${p.id.padEnd(14)} [${p.w},${p.h},${p.l}]`.padEnd(28) +
    `${p.shape.padEnd(7)} ${String(p.totalCount).padEnd(7)} ${String(p.blockContrib).padEnd(8)} ${p.models.trim()}`
  );
}
