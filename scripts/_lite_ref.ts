/** S3 gate: hash .litematic bytes from a deterministic synthetic grid. */
import { createHash } from 'node:crypto';
import { BlockGrid } from '../src/schem/types.ts';
const g = new BlockGrid(37, 19, 43);
const blocks = ['minecraft:white_concrete','minecraft:gray_concrete','minecraft:red_concrete',
  'minecraft:blue_concrete','minecraft:oak_stairs[facing=north,half=bottom]','minecraft:sandstone',
  'minecraft:iron_block','minecraft:lime_concrete','minecraft:gold_block'];
let n = 0;
for (let y=0;y<19;y++) for (let z=0;z<43;z++) for (let x=0;x<37;x++) {
  const h = (x*7 + y*13 + z*17) % 23;
  if (h < 11) { g.set(x,y,z, blocks[(x*3+y*5+z) % blocks.length]!); n++; }
}
const captured: Blob[] = [];
(globalThis as any).document = {
  createElement: () => ({ href:'', download:'', click(){}, remove(){} }),
  body: { appendChild(){} },
};
(globalThis as any).URL = { createObjectURL: (b: Blob) => { captured.push(b); return 'blob:x'; }, revokeObjectURL(){} };
Date.now = () => 1700000000000;
const { exportLitematic } = await import('../web/src/viewer/exporter.ts');
exportLitematic(g, 'x.litematic');
const bytes = new Uint8Array(await captured[0]!.arrayBuffer());
console.log(JSON.stringify({ nonAir:n, palette:g.palette.size, bytes:bytes.length,
  sha256:createHash('sha256').update(bytes).digest('hex') }));
