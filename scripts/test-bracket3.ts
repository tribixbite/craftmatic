#!/usr/bin/env bun
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = join(import.meta.dir, '..', 'web', 'public');
for (const name of ['21309-1', '10030-1', '10179-1']) {
  const raw = readFileSync(join(PUBLIC, `${name}.mpd`), 'utf8');
  const bricks = parseLDraw(raw);
  const result = voxelizeLDraw(bricks, () => 'stone');
  console.log(`${name}: ${result.grid.countNonAir()} blocks`);
}
