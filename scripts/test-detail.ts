import { readFileSync } from 'fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';
import { keepLargestComponent, fillSingleVoxelGaps } from '../web/src/engine/ldraw-voxelizer.js';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');

const text = readFileSync('C:/git/clego/lego_sets/LDR/21063.ldr', 'utf-8');
const bricks = parseLDraw(text);
console.log(`Parsed: ${bricks.length} bricks`);

console.time('detail voxelize');
const result = await voxelizeLDrawGeometry(bricks, undefined, { detailScale: true });
console.timeEnd('detail voxelize');

keepLargestComponent(result.grid);
fillSingleVoxelGaps(result.grid);

const { width: w, height: h, length: l } = result.grid;
console.log(`${w}×${h}×${l} — ${result.grid.countNonAir().toLocaleString()} blocks`);
console.log(`Fallbacks: ${result.fallbackPartCount}`);
