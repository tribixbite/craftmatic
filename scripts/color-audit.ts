/**
 * Audit which LDraw color IDs in the test models fall to the gray_concrete fallback.
 * Run: bun scripts/color-audit.ts
 */
import { LDRAW_COLOR_TO_BLOCK } from '../web/src/engine/ldraw-colors.js';
import { readFileSync } from 'fs';

function getColorsFromMPD(path: string): Record<number, number> {
  const lines = readFileSync(path, 'utf8').split('\n');
  const colors: Record<number, number> = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('1 ')) continue;
    const tokens = t.split(/\s+/);
    if (tokens.length < 15) continue;
    const colorId = parseInt(tokens[1], 10);
    if (!isNaN(colorId)) colors[colorId] = (colors[colorId] || 0) + 1;
  }
  return colors;
}

const models: Record<string, string> = {
  ISD:    'C:/git/craftmatic/data/seymouria/LDR/10030 Imperial Star Destroyer.mpd',
  Falcon: 'C:/git/craftmatic/data/seymouria/LDR/10179 UCS Millenium Falcon.mpd',
  Saturn: 'C:/git/craftmatic/web/public/21309-1.mpd',
};

// Collect all color IDs across all models
const globalColors: Record<number, { count: number; models: string[] }> = {};
for (const [name, path] of Object.entries(models)) {
  const colors = getColorsFromMPD(path);
  for (const [idStr, count] of Object.entries(colors)) {
    const id = Number(idStr);
    if (!globalColors[id]) globalColors[id] = { count: 0, models: [] };
    globalColors[id].count += count;
    globalColors[id].models.push(`${name}:${count}`);
  }
}

// Identify unmapped (gray fallback) color IDs
const unmapped = Object.entries(globalColors)
  .filter(([idStr]) => !(Number(idStr) in LDRAW_COLOR_TO_BLOCK))
  .sort((a, b) => b[1].count - a[1].count);

const mapped = Object.entries(globalColors)
  .filter(([idStr]) => Number(idStr) in LDRAW_COLOR_TO_BLOCK)
  .sort((a, b) => b[1].count - a[1].count);

console.log(`\n=== Color Coverage ===`);
console.log(`Total unique color IDs: ${Object.keys(globalColors).length}`);
console.log(`Mapped: ${mapped.length}, Unmapped (→ gray): ${unmapped.length}`);
const totalUnmappedBricks = unmapped.reduce((s, [, d]) => s + d.count, 0);
const totalBricks = Object.values(globalColors).reduce((s, d) => s + d.count, 0);
console.log(`Unmapped brick references: ${totalUnmappedBricks} / ${totalBricks} (${(100*totalUnmappedBricks/totalBricks).toFixed(1)}%)`);

if (unmapped.length > 0) {
  console.log(`\nUnmapped color IDs (highest count first):`);
  for (const [idStr, data] of unmapped) {
    console.log(`  Color ${idStr}: ${data.count}x  [${data.models.join(', ')}]`);
  }
} else {
  console.log(`\n✓ All color IDs in test models are mapped!`);
}

console.log(`\nTop 10 mapped colors (by usage):`);
for (const [idStr, data] of mapped.slice(0, 10)) {
  const block = LDRAW_COLOR_TO_BLOCK[Number(idStr)];
  console.log(`  Color ${idStr}: ${data.count}x → ${block}  [${data.models.join(', ')}]`);
}
