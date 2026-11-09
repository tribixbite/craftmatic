/**
 * A05 (BIZ-05): real OSM data through the site adapter and massing.
 * Fixtures are Overpass responses fetched 2026-11-09, ODbL, (c) OpenStreetMap contributors:
 *  - notre-dame.overpass.json: way 201611261 (cathedral outline) + its building:part ways;
 *  - louvre-palace.overpass.json: relation 3262297, a multipolygon with 6 inner rings.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { gateSite } from '../web/src/brickgen/site/licence-gate.js';
import { parseLengthM, roofShapeFromOsm, siteFromOverpass, ROOF_RISE_PREFIX } from '../web/src/brickgen/site/osm.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/osm/${name}`, import.meta.url), 'utf8'));
const notreDame = load('notre-dame.overpass.json');
const louvre = load('louvre-palace.overpass.json');
const opts = { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter' };

describe('brickgen-osm tag parsing', () => {
  it('parses lengths in metres and feet and rejects prose', () => {
    expect(parseLengthM('12')).toBe(12);
    expect(parseLengthM('12,5 m')).toBe(12.5);
    expect(parseLengthM('40 ft')).toBeCloseTo(12.192, 3);
    expect(parseLengthM('tall')).toBeNull();
    expect(parseLengthM(undefined)).toBeNull();
  });
  it('maps roof shapes and flags unknown ones', () => {
    expect(roofShapeFromOsm('skillion').shape).toBe('shed');
    expect(roofShapeFromOsm('cone').shape).toBe('conical');
    expect(roofShapeFromOsm('sawtooth')).toEqual({ shape: 'flat', known: false });
  });
});

describe('brickgen-osm Notre-Dame de Paris (real OSM)', () => {
  const r = siteFromOverpass(notreDame, { ...opts, buildingId: 'way/201611261' });

  it('reads the outline and every building:part with its tags', () => {
    expect(r.site.name).toBe('Cathedral of Notre Dame');
    const partCount = notreDame.elements.filter((e: { tags?: Record<string, string> }) => e.tags?.['building:part']).length;
    expect(r.site.footprint).toHaveLength(partCount + 1);
    const tour = r.site.parts.find(p => p.partId === 'way/201611269')!;
    expect(tour.heightM).toBe(69);
    expect(r.roles['way/201611269']).toBe('tower'); // "Tour Sud", man_made=tower
    const spire = r.site.parts.find(p => p.partId === 'way/201760771')!;
    expect(spire).toMatchObject({ baseM: 73, heightM: 78 });
    expect(spire.roof?.shape).toBe('pyramidal');
    expect(r.site.measurements.find(m => m.what === `${ROOF_RISE_PREFIX}way/201760771`)!.valueM).toBe(5);
  });

  it('records every element as an ODbL source with the OSM attribution, and passes the commercial gate', () => {
    expect(r.site.sources.every(s => s.licence === 'odbl' && /OpenStreetMap/.test(s.attribution ?? ''))).toBe(true);
    const g = gateSite(r.site, { commercial: true });
    expect(g.ok).toBe(true);
    expect(g.attributions).toHaveLength(1);
  });

  it('projects to metres: the cathedral is ~128 m long and ~48 m wide', () => {
    const outer = r.site.footprint[0]!.outer;
    const xs = outer.map(p => p[0]), zs = outer.map(p => p[1]);
    const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...zs) - Math.min(...zs);
    expect(Math.max(w, d)).toBeGreaterThan(110);
    expect(Math.max(w, d)).toBeLessThan(150);
  });

  it('builds a massing: the 10.5 m outline is replaced by the parts, the towers and spires survive', () => {
    const m = buildMassing(r.site, { roles: r.roles });
    expect(m.dropped.some(d => d.partId === 'way/201611261')).toBe(true);
    const ids = m.massing.volumes.map(v => v.id);
    expect(ids).toContain('vol-way-201611269'); // south tower
    expect(ids).toContain('vol-way-201754180'); // north tower
    expect(m.massing.volumes.filter(v => v.role === 'tower')).toHaveLength(2);
    // The cathedral's own axes are ~30 degrees off north; the site is turned onto the stud grid.
    expect(Math.abs(m.frame.rotationDeg)).toBeGreaterThan(10);
    // Height from the tallest spire part (96 m, roof included).
    expect(m.massing.boundsM[1][1]).toBeGreaterThan(90);
    expect(m.massing.boundsM[1][1]).toBeLessThanOrEqual(96.5);
    // Everything on the stud/plate grid, inside the lattice limits, with the bounds from the origin.
    const s = m.massing.scale;
    for (const v of m.massing.volumes) {
      for (const [x, z] of [...v.outer, ...v.holes.flat()]) {
        expect(Math.abs(x * s.studsPerMetre - Math.round(x * s.studsPerMetre))).toBeLessThan(1e-6);
        expect(Math.abs(z * s.studsPerMetre - Math.round(z * s.studsPerMetre))).toBeLessThan(1e-6);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(z).toBeGreaterThanOrEqual(0);
      }
      expect(v.topM).toBeGreaterThan(v.baseM);
    }
    // The 283-vertex body ring (curved chevet) loses over half its vertices; the rest are stud-sized steps.
    const body = m.reports.find(x => x.partId === 'way/201611267')!;
    expect(body.originalVertices).toBeGreaterThan(200);
    expect(body.vertices).toBeLessThan(body.originalVertices * 0.6);
    expect(Math.abs(body.areaChange)).toBeLessThan(0.1);
  });

  it('is deterministic', () => {
    const a = buildMassing(r.site, { roles: r.roles }).massing;
    const b = buildMassing(siteFromOverpass(notreDame, { ...opts, buildingId: 'way/201611261' }).site, { roles: r.roles }).massing;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a coarse budget lowers the scale and keeps the model buildable', () => {
    const m = buildMassing(r.site, { roles: r.roles, scale: { maxBricks: 3000 } });
    expect(m.massing.scale.studsPerMetre).toBeLessThan(1);
    expect(m.massing.scale.reason).toMatch(/brick budget/);
    expect(m.massing.volumes.length).toBeGreaterThan(0);
  });
});

describe('brickgen-osm Louvre Palace (multipolygon relation with holes)', () => {
  const r = siteFromOverpass(louvre, { ...opts, buildingId: 'relation/3262297' });

  it('assembles the outer ring and the six courtyards', () => {
    expect(r.site.footprint[0]!.outer.length).toBeGreaterThan(1000);
    expect(r.site.footprint[0]!.holes).toHaveLength(6);
    // No height tag, 3 levels: 3 x 3.2 m, reported.
    expect(r.site.parts[0]!.heightM).toBeCloseTo(9.6, 6);
  });

  it('keeps the courtyards as holes in the massing', () => {
    const m = buildMassing(r.site, { scale: { target: 0.5 } });
    const v = m.massing.volumes[0]!;
    expect(v.holes.length).toBeGreaterThanOrEqual(4);
    const outerArea = Math.abs(v.outer.reduce((s, p, i) => { const q = v.outer[(i + 1) % v.outer.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    expect(outerArea).toBeGreaterThan(20000);
  });
});

describe('brickgen-osm errors', () => {
  it('rejects a response with no building geometry and an unknown buildingId', () => {
    expect(() => siteFromOverpass({ elements: [] }, opts)).toThrow(/no building/);
    expect(() => siteFromOverpass(notreDame, { ...opts, buildingId: 'way/1' })).toThrow(/not in the response/);
  });
});
