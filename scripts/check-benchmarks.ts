import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw, solidifyColumns, fillSingleVoxelGaps } from '../web/src/engine/ldraw-voxelizer.js';

const OMR_BASE = 'https://library.ldraw.org/library/omr';
const models = ['10030-1', '42049-1', '8855-1', '6545-1', '60067-1', '1472-1'];

for (const m of models) {
  try {
    const resp = await fetch(`${OMR_BASE}/${m}.mpd`);
    if (!resp.ok) { console.log(`${m}: fetch failed ${resp.status}`); continue; }
    const text = await resp.text();
    const bricks = parseLDraw(text);
    const result = voxelizeLDraw(bricks);
    solidifyColumns(result.grid, 6);
    fillSingleVoxelGaps(result.grid);
    const { width: w, height: h, length: l } = result.grid;
    const blocks = result.grid.countNonAir();
    console.log(`${m}: ${w}×${h}×${l} — ${blocks.toLocaleString()} blocks, ${result.fallbackPartCount} fallbacks`);
  } catch (e) {
    console.log(`${m}: error ${e}`);
  }
}
