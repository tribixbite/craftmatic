#!/usr/bin/env bun
import { writeFile, mkdir } from 'fs/promises';
import { resolve, join } from 'path';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior, renderTopDown } from '../src/render/png-renderer.js';

sharp.concurrency(1);
const projectRoot = resolve(import.meta.dir, '..');
const tilesDir = join(projectRoot, 'output/tiles');
const outDir = join(tilesDir, 'render-v71');
await mkdir(outDir, { recursive: true });

const name = process.argv[2] || 'beach-v71b';
const schemPath = join(tilesDir, `${name}.schem`);
const grid = await parseToGrid(schemPath);
console.log(`Grid: ${grid.width}x${grid.height}x${grid.length} | Palette: ${grid.palette.size}`);

const isoPng = await renderExterior(grid, { tile: 4 });
const isoJpg = await sharp(isoPng).jpeg({ quality: 90 }).toBuffer();
await writeFile(join(outDir, `iso-${name}.jpg`), isoJpg);

const topPng = await renderTopDown(grid, { scale: 6 });
const topJpg = await sharp(topPng).jpeg({ quality: 90 }).toBuffer();
await writeFile(join(outDir, `top-${name}.jpg`), topJpg);
console.log(`Done: iso ${(isoJpg.length/1024).toFixed(0)}KB, top ${(topJpg.length/1024).toFixed(0)}KB`);
