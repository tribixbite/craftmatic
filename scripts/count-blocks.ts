import { readFileSync } from 'node:fs';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';

const sets = [
  { name: 'Saturn V', path: 'web/public/21309-1.mpd' },
  { name: 'Falcon',   path: 'web/public/10179-1.mpd' },
  { name: 'ISD',      path: 'web/public/10030-1.mpd' },
];
for (const s of sets) {
  const text = readFileSync(s.path, 'utf8');
  const bricks = parseLDraw(text, s.path);
  const result = voxelizeLDraw(bricks);
  const grid = result.grid;
  let count = 0;
  for (let x = 0; x < grid.width; x++)
    for (let y = 0; y < grid.height; y++)
      for (let z = 0; z < grid.length; z++)
        if (grid.get(x,y,z) !== 'minecraft:air') count++;
  console.log(`${s.name}: ${count} blocks (${grid.width}×${grid.height}×${grid.length})`);
}
