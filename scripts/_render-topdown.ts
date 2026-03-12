#!/usr/bin/env bun
import { resolve } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';

const schemPath = resolve(process.argv[2]);
const outPath = process.argv[3] || schemPath.replace('.schem', '-topdown.jpg');

const grid = await parseToGrid(schemPath);
console.log(`${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

const pngBuf = await renderTopDown(grid, { scale: 8 });
const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
await writeFile(outPath, jpgBuf);
console.log(`→ ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
