import { readFileSync, existsSync } from 'node:fs';

const LDRAW_BASE = 'C:/git/clego/extracted/studio_release/app/ldraw';
const SEARCH_DIRS = [
  `${LDRAW_BASE}/parts`,
  `${LDRAW_BASE}/parts/s`,
  `${LDRAW_BASE}/p`,
];

function findFile(name) {
  const bare = name.toLowerCase().split(/[/\\]/).pop();
  for (const dir of SEARCH_DIRS) {
    const p = `${dir}/${bare}`;
    if (existsSync(p)) return p;
  }
  return null;
}

function empty() { return { minX:Infinity,maxX:-Infinity,minY:Infinity,maxY:-Infinity,minZ:Infinity,maxZ:-Infinity }; }
function extend(b, x, y, z) {
  if (!isFinite(x)||!isFinite(y)||!isFinite(z)) return;
  b.minX=Math.min(b.minX,x); b.maxX=Math.max(b.maxX,x);
  b.minY=Math.min(b.minY,y); b.maxY=Math.max(b.maxY,y);
  b.minZ=Math.min(b.minZ,z); b.maxZ=Math.max(b.maxZ,z);
}
function computeLocal(filePath, visited) {
  if (visited.has(filePath)) return empty();
  visited.add(filePath);
  const b = empty();
  if (!existsSync(filePath)) return b;
  const lines = readFileSync(filePath,'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim().split(/\s+/);
    if (!t.length) continue;
    if (t[0]==='3' && t.length>=11) {
      for (let i=0;i<3;i++) extend(b,+t[2+i*3],+t[3+i*3],+t[4+i*3]);
    } else if (t[0]==='4' && t.length>=14) {
      for (let i=0;i<4;i++) extend(b,+t[2+i*3],+t[3+i*3],+t[4+i*3]);
    } else if (t[0]==='1' && t.length>=15) {
      const sub = t.slice(14).join(' ');
      const childPath = findFile(sub);
      if (!childPath) continue;
      const lR=[+t[5],+t[6],+t[7],+t[8],+t[9],+t[10],+t[11],+t[12],+t[13]];
      const lT=[+t[2],+t[3],+t[4]];
      const cb = computeLocal(childPath, new Set([...visited]));
      if (cb.minX===Infinity) continue;
      for (const sx of [cb.minX,cb.maxX]) for (const sy of [cb.minY,cb.maxY]) for (const sz of [cb.minZ,cb.maxZ]) {
        const wx=lR[0]*sx+lR[1]*sy+lR[2]*sz+lT[0];
        const wy=lR[3]*sx+lR[4]*sy+lR[5]*sz+lT[1];
        const wz=lR[6]*sx+lR[7]*sy+lR[8]*sz+lT[2];
        extend(b,wx,wy,wz);
      }
    }
  }
  return b;
}

const parts = process.argv.slice(2).length ? process.argv.slice(2) : ['4592','3820','85861','14417','98138','33291','6141','3070b','3024'];
for (const p of parts) {
  const fp = findFile(`${p}.dat`);
  if (!fp) { console.log(`${p}: NOT FOUND`); continue; }
  const b = computeLocal(fp, new Set());
  if (b.minX===Infinity) { console.log(`${p}: EMPTY bbox`); continue; }
  const xSpan=b.maxX-b.minX, ySpan=b.maxY-b.minY, zSpan=b.maxZ-b.minZ;
  const sW=Math.max(1,Math.round(zSpan/20)), sH=Math.max(1,Math.floor(ySpan/8)), sL=Math.max(1,Math.round(xSpan/20));
  console.log(`${p}: x=${xSpan.toFixed(0)} y=${ySpan.toFixed(0)} z=${zSpan.toFixed(0)} -> [sW=${sW},sH=${sH},sL=${sL}]`);
}
