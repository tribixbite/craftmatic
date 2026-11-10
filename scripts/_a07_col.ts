// usage: bun scripts/_a07_col.ts <x> <z>  (lattice coords): print the label role+colour of every plate of a column of the ND grammar lattice
import { readFileSync } from 'node:fs';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
const nd = JSON.parse(readFileSync('test/fixtures/osm/notre-dame.overpass.json', 'utf8'));
const s = siteFromOverpass(nd, { retrieved: 'x', url: 'x', buildingId: 'way/201611261' });
const m = buildMassing(s.site, { roles: s.roles });
const f = buildFeatureSet({ site: s.site, massing: m, sidecars: [parseSidecar(JSON.parse(readFileSync('web/src/brickgen/features/sidecars/notre-dame.annotations.json', 'utf8')))], tagParts: tagPartsFromOverpass(nd.elements) });
const g = buildGrammarLattice(m.massing, f.set);
const [W, H, D] = g.lattice.dims; const x = Number(process.argv[2]), z = Number(process.argv[3]);
const out: string[] = [];
for (let p = 0; p < H; p++) { const v = g.lattice.cells[(p * D + z) * W + x]!; out.push(v ? `${p}:${g.lattice.labels[v - 1]!.role}${g.lattice.labels[v - 1]!.feature ?? ''}` : `${p}:-`); }
console.log(out.filter(o => !o.endsWith(':-')).join(' '));
