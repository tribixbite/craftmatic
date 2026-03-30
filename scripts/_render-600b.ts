#!/usr/bin/env bun
import { resolve } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior, renderTopDown, renderFrontElevation } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const ROOT = resolve(import.meta.dir, '..');
const version = process.argv[2] || 'v5';
const schemPath = resolve(ROOT, `output/600broadway-${version}.schem`);
const grid = await parseToGrid(schemPath);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks, ${grid.palette.size} materials)`);

// Exterior (iso) render
const isoPng = await renderExterior(grid, { tile: 6 });
const isoJpg = await sharp(isoPng).jpeg({ quality: 85 }).toBuffer();
await writeFile(resolve(ROOT, `output/600broadway-${version}-iso.jpg`), isoJpg);
console.log(`→ iso: ${(isoJpg.length/1024).toFixed(0)}KB`);

// Top-down render
const tdPng = await renderTopDown(grid, { scale: 8 });
const tdJpg = await sharp(tdPng).jpeg({ quality: 85 }).toBuffer();
await writeFile(resolve(ROOT, `output/600broadway-${version}-td.jpg`), tdJpg);
console.log(`→ td: ${(tdJpg.length/1024).toFixed(0)}KB`);

// Front elevation render — face='north' means viewer at +Z looking toward -Z, showing the SOUTH face
const frontPng = await renderFrontElevation(grid, { scale: 16, face: 'north' });
const frontJpg = await sharp(frontPng).jpeg({ quality: 90 }).toBuffer();
await writeFile(resolve(ROOT, `output/600broadway-${version}-front.jpg`), frontJpg);
console.log(`→ front: ${(frontJpg.length/1024).toFixed(0)}KB`);
