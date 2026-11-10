import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
const v = { id:'a', outer:[[135,130],[133,129],[132,127],[133,125],[135,124],[137,125],[138,127],[137,129]], holes:[], baseM:0, topM:61.2, roof:{shape:'pyramidal', pitchDeg:85.5, ridgeAxis:'long'}, role:'body' } as any;
const m = { volumes:[v], scale:{studsPerMetre:1,platesPerMetre:2.5,reason:''}, boundsM:[[0,0,0],[140,100,140]] } as any;
const r = buildGrammarLattice(m,{features:[{kind:'spire',volume:'a',atM:[3,61.2,3],sizeM:[6,35,6],confidence:0.7,sources:['x']}],style:{wallColour:71,trimColour:71,roofColour:72,accentColours:[]}});
const [W,H,D]=r.lattice.dims; const pad=r.frame.pad;
for (const [x,z] of [[135,127],[136,127],[134,127],[133,127]]) { let t=-1; for(let p=H-1;p>=0;p--) if(r.lattice.cells[(p*D+pad+z)*W+pad+x]){t=p;break;} console.log(x,z,t); }
console.log(r.stats.roofs, r.dims ?? r.lattice.dims);
