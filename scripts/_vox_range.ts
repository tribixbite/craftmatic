/** Diagnostic: emitted cell range vs the part's exact LDU extent. */
import { setLDrawRoot, __debugWorldTris, __debugCells } from '../web/src/engine/ldraw-geometry.ts';
setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const cell = Number(process.argv[3] ?? 4);
const part = process.argv[2] ?? '3001.dat';
const b = { color: 15, x: 0, y: 0, z: 0, part };
const tris = await __debugWorldTris(b);
let xn=Infinity,xx=-Infinity,yn=Infinity,yx=-Infinity,zn=Infinity,zx=-Infinity;
for (const t of tris) for (const v of t) {
  if(v[0]<xn)xn=v[0]; if(v[0]>xx)xx=v[0];
  if(v[1]<yn)yn=v[1]; if(v[1]>yx)yx=v[1];
  if(v[2]<zn)zn=v[2]; if(v[2]>zx)zx=v[2];
}
const cells = await __debugCells(b, cell);
const ax = (i: 0|1|2) => { const v = cells.map(c=>c[i]); return [Math.min(...v), Math.max(...v)]; };
const exp = (lo:number,hi:number)=>[Math.floor(lo/cell), Math.ceil(hi/cell)-1];
console.log(`${part} LDU x[${xn},${xx}] y[${yn},${yx}] z[${zn},${zx}]  cells=${cells.length}`);
console.log(`  X got ${ax(0)} expected ${exp(xn,xx)}`);
console.log(`  Y got ${ax(1)} expected ${exp(-yx,-yn)}`);
console.log(`  Z got ${ax(2)} expected ${exp(zn,zx)}`);
for (const i of [0,1,2] as const) {
  const [lo,hi] = i===1?exp(-yx,-yn):exp(i===0?xn:zn, i===0?xx:zx);
  const out = cells.filter(c=>c[i]<lo||c[i]>hi);
  if (out.length) console.log(`  axis ${i}: ${out.length} cells outside; samples ${JSON.stringify(out.slice(0,6))}`);
}
