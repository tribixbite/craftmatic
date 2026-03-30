import { parseToGrid } from '../src/schem/parse.js';
import { resolve } from 'path';
const projectRoot = resolve(import.meta.dir, '..');
const grid = await parseToGrid(resolve(projectRoot, 'output/tiles/newton-v16.schem'));
console.log('Grid dims:', grid.width, grid.height, grid.length);
console.log('Non-air:', grid.countNonAir());
console.log('Palette size:', grid.palette.size);
