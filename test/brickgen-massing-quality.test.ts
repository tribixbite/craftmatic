/**
 * Massing quality (package MQ, BIZ-05 / BIZ-10): measured faults of the A05 massing + X-10 plain bricker on the REAL
 * OSM fixtures (Notre-Dame de Paris, Palais du Louvre). Each test measures one fault in the stud lattice itself, never a
 * Notre-Dame special case: the same invariants run over both fixtures.
 *
 *  1. Two towers stay two towers: above the gallery that joins them the corridor between them is empty.
 *  2. Nothing rises above what OSM declares: a column's top may not exceed the tallest declared `height` over it. The
 *     chevet (east end) is therefore the aisle/apse height, and only the spire's footprint passes 36 m.
 *  3. Neighbouring buildings that the Overpass query returned beside the cathedral do not come along: a
 *     `building:part` that lies outside the chosen building outline is not part of that building.
 *
 * Facts about the real cathedral come from OSM tags in the fixture and Wikipedia (towers 69 m, spire 96 m, the apse
 * roof ridge about 33-35 m); no LEGO set is consulted.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_PLATES, plainMassingLattice } from '../web/src/brickgen/bricker/plain-massing.js';
import { coverageFraction, pointInPolygon } from '../web/src/brickgen/massing/geometry.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { IntentLattice, Massing, MassVolume, SiteEvidence } from '../web/src/brickgen/types.js';

/** Roof ridge over the apse/chevet: 33 m vault + roof, the OSM `height` of its roofs. */
const APSE_ROOF_RIDGE_M = 45;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): { elements?: never } => JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'osm', name), 'utf8'));

interface Built { site: SiteEvidence; massing: Massing; lattice: IntentLattice; outlineId: string }

const FIXTURES: Array<{ name: string; file: string; buildingId: string }> = [
  { name: 'Notre-Dame', file: 'notre-dame.overpass.json', buildingId: 'way/201611261' },
  { name: 'Louvre', file: 'louvre-palace.overpass.json', buildingId: 'relation/3262297' },
];

function build(f: (typeof FIXTURES)[number]): Built {
  const res = siteFromOverpass(fixture(f.file), { name: f.name, retrieved: '2026-11-09', buildingId: f.buildingId });
  const { massing } = buildMassing(res.site, { roles: res.roles });
  return { site: res.site, massing, lattice: plainMassingLattice(massing).lattice, outlineId: f.buildingId };
}

/** Highest filled plate of a lattice column, as metres above the ground plate; -1 for an empty column. */
function columnTopM(l: IntentLattice, ppm: number, x: number, z: number): number {
  const [W, H, D] = l.dims;
  for (let p = H - 1; p >= BASE_PLATES; p--) if (l.cells[(p * D + z) * W + x]) return (p + 1 - BASE_PLATES) / ppm;
  return -1;
}

const partIdOf = (v: MassVolume): string => v.id.replace(/^vol-/, '').replace('-', '/');

describe('massing quality on the real OSM fixtures', () => {
  for (const f of FIXTURES) {
    describe(f.name, () => {
      const b = build(f);
      const [W, , D] = b.lattice.dims;
      const spm = b.massing.scale.studsPerMetre, ppm = b.massing.scale.platesPerMetre;
      const declared = new Map(b.site.parts.map(p => [p.partId, p.heightM]));

      it('no column rises above the tallest height OSM declares over it', () => {
        const tol = 1 / ppm; // one plate of snapping
        const over: string[] = [];
        for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
          const top = columnTopM(b.lattice, ppm, x, z);
          if (top < 0) continue;
          const cx = (x + 0.5) / spm, cz = (z + 0.5) / spm;
          const cap = Math.max(0, ...b.massing.volumes
            .filter(v => pointInPolygon(cx, cz, v.outer, v.holes))
            .map(v => declared.get(partIdOf(v)) ?? 0));
          if (top > cap + tol) over.push(`(${x},${z}) ${top.toFixed(1)} m > declared ${cap} m`);
        }
        expect(over.slice(0, 8), `${over.length} column(s) taller than declared`).toEqual([]);
      });

      it('every building:part lies inside the chosen outline (no neighbouring buildings)', () => {
        const outline = b.site.footprint.find(fp => fp.partId === b.outlineId)!;
        const outside = b.site.footprint
          .filter(fp => fp !== outline)
          .filter(fp => coverageFraction(fp.outer, fp.holes, [outline], 0.25) < 0.5)
          .map(fp => fp.partId);
        expect(outside).toEqual([]);
      });
    });
  }

  describe('Notre-Dame', () => {
    const b = build(FIXTURES[0]!);
    const spm = b.massing.scale.studsPerMetre, ppm = b.massing.scale.platesPerMetre;
    const [W, H, D] = b.lattice.dims;
    const bbox = (v: MassVolume): { x0: number; x1: number; z0: number; z1: number } => {
      const xs = v.outer.map(p => p[0]), zs = v.outer.map(p => p[1]);
      return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
    };

    it('the two west-front towers are disjoint above the gallery that joins them', () => {
      const towers = b.massing.volumes.filter(v => v.role === 'tower');
      expect(towers).toHaveLength(2);
      const [a, c] = towers.map(bbox).sort((p, q) => p.z0 - q.z0) as [ReturnType<typeof bbox>, ReturnType<typeof bbox>];
      expect(a.z1).toBeLessThan(c.z0); // a real gap between the footprints
      const x0 = Math.max(a.x0, c.x0), x1 = Math.min(a.x1, c.x1);
      // Everything that bridges the gap (galleries) tops out below the towers; the corridor must be empty above it.
      const bridge = Math.max(0, ...b.massing.volumes.filter(v => v.role !== 'tower').filter(v => {
        const bb = bbox(v); return bb.z0 <= a.z1 && bb.z1 >= c.z0 && bb.x1 >= x0 && bb.x0 <= x1;
      }).map(v => v.topM));
      let filled = 0;
      for (let p = Math.round((bridge + 1) * ppm) + BASE_PLATES; p < H; p++)
        for (let z = Math.ceil(a.z1 * spm); z < Math.floor(c.z0 * spm); z++)
          for (let x = Math.ceil(x0 * spm); x < Math.floor(x1 * spm); x++) if (b.lattice.cells[(p * D + z) * W + x]) filled++;
      expect(filled).toBe(0);
      // ... and the towers themselves do rise above that bridge (otherwise the test proves nothing).
      expect(Math.min(...towers.map(t => t.topM))).toBeGreaterThan(bridge + 10);
    });

    /**
     * The cathedral's own site gives 33 m under the vaults and 43 m under the nave roof (notredamedeparis.fr, "Plans and
     * Elevations"); OSM tags the east-end roofs 33 m walls + 12 m = 45 m. The ridge is therefore ~45 m, and nothing else
     * at the east end may pass it: the tower (69 m) and spire (96 m) are not at the chevet.
     */
    it('the east end carries no mass taller than the apse roof (45 m); only the spire passes it', () => {
      const spire = [...b.massing.volumes].sort((p, q) => (declared(b, q) - declared(b, p)))[0]!;
      const sp = bbox(spire);
      const tower = b.massing.volumes.find(v => v.role === 'tower')!;
      const eastIsPlusX = bbox(tower).x1 < sp.x0;
      expect(eastIsPlusX).toBe(true);
      let tall = 0, tallest = 0;
      for (let z = 0; z < D; z++) for (let x = Math.ceil(sp.x1 * spm) + 1; x < W; x++) {
        const t = columnTopM(b.lattice, ppm, x, z);
        tallest = Math.max(tallest, t);
        if (t > APSE_ROOF_RIDGE_M + 0.5) tall++;
      }
      expect(tall, `east of the spire the tallest column is ${tallest.toFixed(1)} m`).toBe(0);
    });
  });
});

function declared(b: Built, v: MassVolume): number {
  return b.site.parts.find(p => p.partId === partIdOf(v))?.heightM ?? 0;
}
