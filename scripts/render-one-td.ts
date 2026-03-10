#!/usr/bin/env bun
/** Render a single schem as top-down JPEG. Usage: bun scripts/render-one-td.ts <path.schem> */
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';

sharp.concurrency(1);

const schemPath = process.argv[2];
if (!schemPath) { console.error('Usage: bun scripts/render-one-td.ts <path.schem>'); process.exit(1); }

const outPath = schemPath.replace(/\.schem$/, '-td.jpg');
const grid = await parseToGrid(schemPath);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks, ${grid.palette.size} materials)`);

const tdPng = await renderTopDown(grid, { scale: 8 });
const tdJpg = await sharp(tdPng).jpeg({ quality: 85 }).toBuffer();
await writeFile(outPath, tdJpg);
console.log(`→ ${outPath} (${(tdJpg.length/1024).toFixed(0)}KB)`);
