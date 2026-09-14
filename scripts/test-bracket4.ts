#!/usr/bin/env bun
// Test bracket masking by simulating its logic directly on the Saturn V local file
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { getPartShape, getPartDims } from '../web/src/engine/ldraw-part-dims.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LDU_PER_PLATE = 8, LDU_PER_STUD = 20;
const PUBLIC = join(import.meta.dir, '..', 'web', 'public');
const raw = readFileSync(join(PUBLIC, '21309-1.mpd'), 'utf8');
const bricks = parseLDraw(raw);

let totalWithout = 0, totalWith = 0, bracketSavings = 0;

for (const b of bricks) {
  const shape = getPartShape(b.part);
  const [sW, sH, sL] = getPartDims(b.part);
  const R = b.rot ?? [1,0,0,0,1,0,0,0,1];

  const lxHalf = (sW-1)/2*LDU_PER_STUD, lzHalf = (sL-1)/2*LDU_PER_STUD, lyBot = (sH-1)*LDU_PER_PLATE;
  
  let wxMin=Infinity,wxMax=-Infinity,wyMin=Infinity,wyMax=-Infinity,wzMin=Infinity,wzMax=-Infinity;
  for (const lx of [-lxHalf, lxHalf]) for (const ly of [0, lyBot]) for (const lz of [-lzHalf, lzHalf]) {
    const wx=R[0]*lx+R[1]*ly+R[2]*lz+b.x, wy=R[3]*lx+R[4]*ly+R[5]*lz+b.y, wz=R[6]*lx+R[7]*ly+R[8]*lz+b.z;
    if(wx<wxMin)wxMin=wx; if(wx>wxMax)wxMax=wx;
    if(wy<wyMin)wyMin=wy; if(wy>wyMax)wyMax=wy;
    if(wz<wzMin)wzMin=wz; if(wz>wzMax)wzMax=wz;
  }
  const gxMin=Math.round(wxMin/LDU_PER_STUD), gxMax=Math.round(wxMax/LDU_PER_STUD);
  const gyMin=Math.round(-wyMax/LDU_PER_PLATE), gyMax=Math.round(-wyMin/LDU_PER_PLATE);
  const gzMin=Math.round(wzMin/LDU_PER_STUD), gzMax=Math.round(wzMax/LDU_PER_STUD);
  const spanX=gxMax-gxMin, spanY=gyMax-gyMin, spanZ=gzMax-gzMin;
  
  const aabb = (spanX+1)*(spanY+1)*(spanZ+1);
  totalWithout += aabb;

  // Simulate bracket masking
  if (shape === 'bracket' && spanY > 0) {
    const faceWorldX = -R[2], faceWorldZ = -R[8];
    let faceAxis: 'x'|'z' = 'z', facePos = gzMin;
    if (Math.abs(faceWorldZ) >= Math.abs(faceWorldX) && spanZ > 0) {
      faceAxis = 'z'; facePos = faceWorldZ >= 0 ? gzMax : gzMin;
    } else if (spanX > 0) {
      faceAxis = 'x'; facePos = faceWorldX >= 0 ? gxMax : gxMin;
    }
    const plateY = R[4] >= 0 ? gyMax : gyMin;

    let kept = 0;
    for (let x=gxMin; x<=gxMax; x++) {
      for (let z=gzMin; z<=gzMax; z++) {
        for (let y=gyMin; y<=gyMax; y++) {
          const onFace = faceAxis==='z' ? z===facePos : x===facePos;
          if (!onFace && y !== plateY) continue;
          kept++;
        }
      }
    }
    bracketSavings += (aabb - kept);
    totalWith += kept;
  } else {
    totalWith += aabb;
  }
}

console.log(`AABB total (no masking): ${totalWithout}`);
console.log(`With bracket masking: ${totalWith}`);
console.log(`Bracket savings: ${bracketSavings} cells`);
