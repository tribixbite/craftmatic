/** S3 quality gate: emit a reference .schem + grid digest through the export path. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { voxelizeLDraw, fillSingleVoxelGaps } from '../web/src/engine/ldraw-voxelizer.ts';
import { studioColorToBlock } from '../web/src/engine/studio-colors.ts';
import { encodeSchemBytes } from '../web/src/viewer/exporter.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const file = process.argv[2] ?? 'C:/git/clego/lego_sets/IO/21063.io';
const out  = process.argv[3] ?? 'out.schem';
const forcedCell = process.argv[4] ? Number(process.argv[4]) : undefined;

const b = readFileSync(file);
const io = await extractIoModel(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
const colorFn = io.colorSpace === 'bl' ? studioColorToBlock : undefined;
const bricks = parseLDraw(synthesizeLSynth(io.text).text);
let nx=Infinity,xx=-Infinity,ny=Infinity,xy=-Infinity,nz=Infinity,xz=-Infinity;
for (const br of bricks){if(br.x<nx)nx=br.x;if(br.x>xx)xx=br.x;if(br.y<ny)ny=br.y;if(br.y>xy)xy=br.y;if(br.z<nz)nz=br.z;if(br.z>xz)xz=br.z;}
const span={x:xx-nx+80,y:xy-ny+80,z:xz-nz+80};
let cellLDU=20;
for(const c of [4,5,8,10,20]){const w=span.x/c,h=span.y/c,l=span.z/c;if(Math.max(w,l)<=640&&h<=320&&w*h*l<=30_000_000){cellLDU=c;break;}}
if (forcedCell) cellLDU = forcedCell;
const opts={cellLDU,maxDim:700};
const t0=Date.now();
let grid;
try{
  const r=await voxelizeLDrawGeometry(bricks,colorFn,opts);
  grid=r.grid.countNonAir()>=bricks.length?r.grid:voxelizeLDraw(bricks,colorFn,opts).grid;
}catch{grid=voxelizeLDraw(bricks,colorFn,opts).grid;}
const voxMs=Date.now()-t0;
fillSingleVoxelGaps(grid);
const bytes=encodeSchemBytes(grid);
writeFileSync(out,bytes);
const _raw=(grid as any).rawData; const rawDigest=_raw?createHash('sha256').update(Buffer.from(_raw.buffer,_raw.byteOffset,_raw.byteLength)).digest('hex'):'n/a';
console.log(JSON.stringify({file,cellLDU,dims:[grid.width,grid.height,grid.length],
  nonAir:grid.countNonAir(),palette:[...grid.palette.keys()],
  schemSha256:createHash('sha256').update(bytes).digest('hex'),schemBytes:bytes.length,
  gridSha256:rawDigest, voxMs},null,1));
