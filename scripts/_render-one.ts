import { resolve } from 'path';
import { writeFile } from 'fs/promises';
import sharp from 'sharp';
import { parseToGrid } from '../src/schem/parse.js';
import { renderExterior } from '../src/render/png-renderer.js';

const schemPath = resolve(process.argv[2]);
const outPath = process.argv[3] || schemPath.replace('.schem', '-iso.jpg');
// Optional tile size: --tile N (default 4)
const tileIdx = process.argv.indexOf('--tile');
const tileSize = tileIdx >= 0 ? parseInt(process.argv[tileIdx + 1], 10) : 4;

const grid = await parseToGrid(schemPath);
console.log(`${grid.width}x${grid.height}x${grid.length} (${grid.countNonAir()} blocks)`);

const pngBuf = await renderExterior(grid, { tile: tileSize });
const jpgBuf = await sharp(pngBuf).jpeg({ quality: 90 }).toBuffer();
await writeFile(outPath, jpgBuf);
console.log(`→ ${outPath} (${(jpgBuf.length / 1024).toFixed(0)}KB)`);
