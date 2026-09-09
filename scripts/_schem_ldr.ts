/** Voxel-export one flat .ldr through the REAL shared pipeline (audit P0 #1,
 *  "validate voxel export separately"). Mirrors scripts/_schem_ref.ts but takes
 *  an .ldr instead of an .io. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { runSchemPipeline } from '../web/src/engine/schem-pipeline.ts';
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2]!, out = process.argv[3]!;
const cellLDU = Number(process.argv[4] ?? 4);
const bridgeParts = !process.argv.includes('--no-bridge');
const bricks = parseLDraw(readFileSync(file, 'utf-8'));
const { grid, bytes } = await runSchemPipeline({
  source: { kind: 'bricks', bricks, colorSpace: 'ldraw',
            options: { cellLDU, maxDim: 700, bridgeParts } },
  format: 'schem', packStem: 'x', profile: 'default', lightFill: false, shapes: true,
});
writeFileSync(out, bytes!);
const raw = grid.rawData;
console.log(JSON.stringify({
  file, bricks: bricks.length, cellLDU, bridgeParts,
  dims: [grid.width, grid.height, grid.length], nonAir: grid.countNonAir(),
  gridSha256: createHash('sha256').update(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)).digest('hex'),
}));
