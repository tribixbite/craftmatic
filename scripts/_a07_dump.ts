import { readFileSync } from 'node:fs';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
const which = process.argv[2] ?? 'notre-dame';
const nd = JSON.parse(readFileSync(`test/fixtures/osm/${which}.overpass.json`, 'utf8'));
const id = which === 'notre-dame' ? 'way/201611261' : undefined;
const r = siteFromOverpass(nd, { retrieved: '2026-11-09', url: 'x', ...(id ? { buildingId: id } : {}) });
const m = buildMassing(r.site, { roles: r.roles });
console.log(JSON.stringify(m.massing.scale), JSON.stringify(m.massing.boundsM), m.warnings);
for (const v of m.massing.volumes) { const xs=v.outer.map(p=>p[0]), zs=v.outer.map(p=>p[1]); console.log(v.id, v.role, 'x',Math.min(...xs),Math.max(...xs),'z',Math.min(...zs),Math.max(...zs),'y',v.baseM.toFixed(1),v.topM.toFixed(1), JSON.stringify(v.roof), v.outer.length+'v', v.holes.length+'h'); }
const sc = which==='notre-dame' ? [parseSidecar(JSON.parse(readFileSync('web/src/brickgen/features/sidecars/notre-dame.annotations.json','utf8')))] : [];
const out = buildFeatureSet({ site: r.site, massing: m, sidecars: sc, tagParts: tagPartsFromOverpass(nd.elements) });
const by: Record<string,number> = {}; for (const f of out.set.features) by[f.kind]=(by[f.kind]??0)+1; console.log(by);
for (const f of out.set.features) console.log(f.kind, f.volume, f.edge, f.atM.map(x=>+x.toFixed(1)).join(','), f.sizeM.map(x=>+x.toFixed(1)).join(','), f.count??'', f.confidence);
