// Lists volumes whose roof column rises more than 12 plates above their ceiling in the ND grammar lattice.
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
const [W, H, D] = g.lattice.dims;
for (const v of m.massing.volumes) {
  const xs = v.outer.map(p => p[0]), zs = v.outer.map(p => p[1]);
  const cx = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2) + g.frame.pad, cz = Math.floor((Math.min(...zs) + Math.max(...zs)) / 2) + g.frame.pad;
  let top = -1; for (let p = H - 1; p >= 0; p--) if (g.lattice.cells[(p * D + cz) * W + cx]) { top = p; break; }
  const topP = Math.round(v.topM * 2.5) + 2;
  if (top - topP > 12) console.log(v.id, v.roof.shape, v.roof.pitchDeg, 'w', Math.max(...xs) - Math.min(...xs), 'd', Math.max(...zs) - Math.min(...zs), 'topM', v.topM, 'colTop', top, 'rise', top - topP);
}
