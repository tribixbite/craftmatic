// usage: bun scripts/_a07_row.ts <z> <plate> [x0 x1]: roles along x at one z, plate of the ND grammar lattice (lattice coords)
import { readFileSync } from 'node:fs';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
const nd = JSON.parse(readFileSync('test/fixtures/osm/notre-dame.overpass.json', 'utf8'));
const s = siteFromOverpass(nd, { retrieved: 'x', url: 'x', buildingId: 'way/201611261' });
const m = buildMassing(s.site, { roles: s.roles });
const f = buildFeatureSet({ site: s.site, massing: m, sidecars: [parseSidecar(JSON.parse(readFileSync('web/src/brickgen/features/sidecars/notre-dame.annotations.json', 'utf8')))], tagParts: tagPartsFromOverpass(nd.elements) });
for (const x of f.set.features.filter(q => q.kind === 'portal')) console.log(JSON.stringify(x));
const g = buildGrammarLattice(m.massing, f.set);
const [W, H, D] = g.lattice.dims; const z = Number(process.argv[2]), p = Number(process.argv[3]);
const x0 = Number(process.argv[4] ?? 60), x1 = Number(process.argv[5] ?? 100);
const sym: Record<string, string> = { wall: 'W', window: 'o', trim: 't', terrain: 'B', floor: 'F', 'roof-flat': 'c', 'roof-slope': 's' };
let out = ''; for (let x = x0; x < x1; x++) { const v = g.lattice.cells[(p * D + z) * W + x]!; out += v ? sym[g.lattice.labels[v - 1]!.role] ?? '?' : '.'; }
console.log(out);
const v270 = m.massing.volumes.find(v => v.id === 'vol-way-201611270')!; console.log(JSON.stringify(v270.outer));
