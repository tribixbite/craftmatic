#!/usr/bin/env bun
/** Render a single schem as top-down JPEG. Usage: bun scripts/render-one-td.ts <path.schem> */
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';

sharp.concurrency(1);

// Bun on Termux sets CWD to ~/.bun/tmp/ — resolve relative paths against project root
const projectRoot = resolve(import.meta.dir, '..');
const resolvePath = (p: string) => p.startsWith('/') ? p : resolve(projectRoot, p);

let schemPath = process.argv[2];
if (!schemPath) { console.error('Usage: bun scripts/render-one-td.ts <path.schem>'); process.exit(1); }
schemPath = resolvePath(schemPath);

const outPath = schemPath.replace(/\.schem$/, '-td.jpg');
const grid = await parseToGrid(schemPath);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks, ${grid.palette.size} materials)`);

const tdPng = await renderTopDown(grid, { scale: 8 });
const tdJpg = await sharp(tdPng).jpeg({ quality: 85 }).toBuffer();
await writeFile(outPath, tdJpg);
console.log(`→ ${outPath} (${(tdJpg.length/1024).toFixed(0)}KB)`);
