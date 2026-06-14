#!/usr/bin/env bun
import { resolve } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderTopDown } from '../src/render/png-renderer.js';

const schemPath = resolve(process.argv[2]);
const outPath = process.argv[3] || schemPath.replace('.schem', '-topdown.jpg');
// Optional scale: --scale N (default 8)
const scaleIdx = process.argv.indexOf('--scale');
const scale = scaleIdx >= 0 ? parseInt(process.argv[scaleIdx + 1], 10) : 8;

const grid = await parseToGrid(schemPath);
console.log(`${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

const pngBuf = await renderTopDown(grid, { scale });
const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
await writeFile(outPath, jpgBuf);
console.log(`→ ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
