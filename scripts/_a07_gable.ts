import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
const outer = (w:number,d:number)=>[[0,0],[w,0],[w,d],[0,d]] as [number,number][];
const shape = (process.argv[2]??'gabled') as any, w=Number(process.argv[3]??10), pitch=Number(process.argv[4]??45);
const v = { id:'a', outer: outer(w,w*2), holes:[], baseM:0, topM:6, roof:{shape, pitchDeg:pitch, ridgeAxis:'long'}, role:'body' } as any;
const m = { volumes:[v], scale:{studsPerMetre:1,platesPerMetre:2.5,reason:''}, boundsM:[[0,0,0],[w,40,w*2]] } as any;
const r = buildGrammarLattice(m,{features:[],style:{wallColour:71,trimColour:71,roofColour:72,accentColours:[]}});
const [W,H,D]=r.lattice.dims; const pad=r.frame.pad; const z=pad+w;
const tops:number[]=[]; for(let x=0;x<w;x++){let t=-1;for(let p=H-1;p>=0;p--) if(r.lattice.cells[(p*D+z)*W+pad+x]){t=p;break;} tops.push(t);}
console.log(shape, tops.join(' '), r.stats);
