/** S3: isolate the NBT-encode memory peak at the 30M-cell export cap. */
import { BlockGrid } from '../src/schem/types.ts';
import { encodeSchemBytes } from '../web/src/viewer/exporter.ts';
const MB = (n:number)=>(n/1048576).toFixed(1)+' MB';
let peak=0; const mem=(l:string)=>{const m=process.memoryUsage(); if(m.rss>peak)peak=m.rss;
  console.log(`  [${l.padEnd(26)}] heap=${MB(m.heapUsed).padStart(10)} rss=${MB(m.rss).padStart(10)}`);};
const W=640,H=73,L=640; // 29.9M cells — the export cap
const g=new BlockGrid(W,H,L);
const blocks=['minecraft:white_concrete','minecraft:gray_concrete','minecraft:red_concrete','minecraft:blue_concrete'];
for(let y=0;y<H;y++)for(let z=0;z<L;z++)for(let x=0;x<W;x++) if(((x+y+z)&7)<3) g.set(x,y,z,blocks[(x+z)&3]!);
console.log(`grid ${W}×${H}×${L} = ${(g.totalBlocks/1e6).toFixed(1)}M cells, nonAir=${g.countNonAir().toLocaleString()}, data=${MB(g.totalBlocks*2)}`);
mem('grid built');
let t=Date.now(); const bd=g.encodeBlockData(); mem('after encodeBlockData');
console.log(`  encodeBlockData ${Date.now()-t} ms → ${MB(bd.length)}`);
t=Date.now(); const s=encodeSchemBytes(g); mem('after encodeSchemBytes');
console.log(`  encodeSchemBytes ${Date.now()-t} ms → ${MB(s.length)}`);
console.log(`PEAK RSS = ${MB(peak)}`);
