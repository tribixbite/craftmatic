/**
 * MQ2 (BIZ-05/BIZ-11): the massing faults L00 found across the 22 landmarks, each pinned by a general case.
 *  1. an outline as tall as its building:parts must not hide them;
 *  2. a site may have several outlines (and an outline tagged `building:part=no`);
 *  3. a skillion that is the whole body (Eiffel's legs) is terraced, so the stack is one connected tower;
 *  4. the true top (roof included) is reported beside the wall top.
 */
import { describe, expect, it } from 'vitest';
import { buildFeatureSet } from '../web/src/brickgen/features/index.js';
import { buildGrammarLattice } from '../web/src/brickgen/grammar/index.js';
import { buildMassing, OUTLINE_PREFIX, volumeRoofRiseM } from '../web/src/brickgen/massing/index.js';
import { newMask, openMask, traceMask } from '../web/src/brickgen/massing/raster.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { SiteEvidence, SourceRef, Vec2m } from '../web/src/brickgen/types.js';

const OWN: SourceRef = { id: 'own', kind: 'measurement', retrieved: '2026-11-13', licence: 'own-work', usedFor: ['footprint'] };
const rect = (w: number, d: number, cx = 0, cz = 0): Vec2m[] =>
  [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];
const site = (over: Partial<SiteEvidence> & Pick<SiteEvidence, 'footprint' | 'parts'>): SiteEvidence =>
  ({ name: 'test', sources: [OWN], measurements: [], annotations: [], ...over });
const outlineMark = (partId: string): SiteEvidence['measurements'][number] => ({ what: `${OUTLINE_PREFIX}${partId}`, valueM: 1, source: 'own' });

describe('mq2 outline vs parts', () => {
  it('an outline as tall as its parts does not hide them: the parts are massed, the outline is not', () => {
    const r = buildMassing(site({
      footprint: [
        { outer: rect(40, 20), holes: [], partId: 'outline' },
        { outer: rect(20, 20, -10, 0), holes: [], partId: 'west' },
        { outer: rect(20, 20, 10, 0), holes: [], partId: 'east' },
      ],
      parts: [{ partId: 'outline', baseM: 0, heightM: 30 }, { partId: 'west', baseM: 0, heightM: 30 }, { partId: 'east', baseM: 0, heightM: 18 }],
      measurements: [outlineMark('outline')],
    }));
    expect(r.massing.volumes.map(v => v.id).sort()).toEqual(['vol-east', 'vol-west']);
    expect(r.dropped.some(d => d.partId === 'outline')).toBe(true);
  });

  it('an outline taller than the parts that cover it yields to them everywhere', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(30, 30), holes: [], partId: 'outline' }, { outer: rect(30, 30), holes: [], partId: 'low' }],
      parts: [{ partId: 'outline', baseM: 0, heightM: 60 }, { partId: 'low', baseM: 0, heightM: 12 }],
      measurements: [outlineMark('outline')],
    }));
    expect(r.massing.volumes.map(v => v.id)).toEqual(['vol-low']);
    expect(r.trueTopM).toBeCloseTo(12, 6);
    // The model falls short of the outline's tagged 60 m, and the result says so instead of hiding it.
    expect(r.warnings.some(w => w.startsWith('outline:') && w.includes('60') && w.includes('12'))).toBe(true);
  });

  it('where parts cover only half of the outline, the outline is kept over the other half only', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(40, 20), holes: [], partId: 'outline' }, { outer: rect(20, 20, -10, 0), holes: [], partId: 'west' }],
      parts: [{ partId: 'outline', baseM: 0, heightM: 30 }, { partId: 'west', baseM: 0, heightM: 30 }],
      measurements: [outlineMark('outline')],
    }), { rotate: false });
    const west = r.massing.volumes.find(v => v.id === 'vol-west')!;
    const rest = r.massing.volumes.filter(v => v.id !== 'vol-west');
    expect(rest.length).toBeGreaterThanOrEqual(1);
    // The outline's volume lies on the east half: it never overlaps the west part's footprint.
    const westMaxX = Math.max(...west.outer.map(p => p[0]));
    for (const v of rest) expect(Math.min(...v.outer.map(p => p[0]))).toBeGreaterThanOrEqual(westMaxX - 1e-6);
    expect(rest.reduce((s, v) => s + Math.abs(areaOf(v.outer)), 0)).toBeCloseTo(400, -1);
  });

  it('a thin rim of outline left beside a part (the two edges never align exactly) is not kept as a wall', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(40, 20), holes: [], partId: 'outline' }, { outer: rect(38, 18), holes: [], partId: 'part' }],
      parts: [{ partId: 'outline', baseM: 0, heightM: 30 }, { partId: 'part', baseM: 0, heightM: 30 }],
      measurements: [outlineMark('outline')],
    }), { rotate: false });
    expect(r.massing.volumes.map(v => v.id)).toEqual(['vol-part']);
  });

  it('an outline with no parts at all is still massed (a plain tower)', () => {
    const r = buildMassing(site({ footprint: [{ outer: rect(10, 10), holes: [], partId: 'o' }], parts: [{ partId: 'o', baseM: 0, heightM: 50 }], measurements: [outlineMark('o')] }));
    expect(r.massing.volumes.map(v => v.id)).toEqual(['vol-o']);
  });
});

/** Absolute area of a ring. */
function areaOf(ring: Vec2m[]): number {
  return ring.reduce((s, p, i) => { const q = ring[(i + 1) % ring.length]!; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
}

describe('mq2 true top', () => {
  it('reports the roof rise on top of the wall top', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(20, 20), holes: [], partId: 'tower' }],
      parts: [{ partId: 'tower', baseM: 0, heightM: 60, roof: { shape: 'pyramidal' } }],
      measurements: [{ what: 'roof-rise:tower', valueM: 30, source: 'own' }],
    }));
    const v = r.massing.volumes[0]!;
    expect(v.topM).toBeCloseTo(30, 1); // the wall top
    expect(volumeRoofRiseM(v)).toBeGreaterThan(20);
    expect(r.trueTopM).toBeCloseTo(v.topM + volumeRoofRiseM(v)!, 6);
    expect(r.trueTopM).toBeCloseTo(60, 0);
  });
});

/** An Overpass way from a metre rectangle around (51.5 N, 0 E). */
function way(id: number, tags: Record<string, string>, cxM: number, czM: number, wM: number, dM: number): unknown {
  const lat0 = 51.5, mLat = 111_320, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({
    lat: lat0 - (czM + (sz! * dM) / 2) / mLat, lon: (cxM + (sx! * wM) / 2) / mLon,
  }));
  return { type: 'way', id, tags, geometry: pts, nodes: [] };
}

describe('mq2 multi-building sites', () => {
  const els = [
    way(1, { building: 'yes', height: '9', name: 'North Tower' }, 0, -100, 20, 20),
    way(2, { building: 'yes', height: '9', name: 'South Tower' }, 0, 100, 20, 20),
    way(11, { 'building:part': 'yes', height: '40' }, 0, -100, 10, 10),
    way(12, { 'building:part': 'yes', height: '42' }, 0, 100, 10, 10),
    way(20, { 'building:part': 'yes', height: '30' }, 500, 0, 10, 10), // a neighbour: in neither outline
  ];
  const opts = { retrieved: '2026-11-13' };

  it('every named outline keeps its parts; a part in none of them is still a neighbour', () => {
    const r = siteFromOverpass({ elements: els as never }, { ...opts, buildingIds: ['way/1', 'way/2'] });
    const ids = r.site.parts.map(p => p.partId).sort();
    expect(ids).toEqual(['way/1', 'way/11', 'way/12', 'way/2']);
    expect(r.warnings.filter(w => w.includes('way/12'))).toEqual([]);
    expect(r.warnings.some(w => w.startsWith('way/20'))).toBe(true);
  });

  it('marks every outline, so massing can tell it from a part', () => {
    const r = siteFromOverpass({ elements: els as never }, { ...opts, buildingIds: ['way/1', 'way/2'] });
    const marked = r.site.measurements.filter(m => m.what.startsWith(OUTLINE_PREFIX)).map(m => m.what.slice(OUTLINE_PREFIX.length)).sort();
    expect(marked).toEqual(['way/1', 'way/2']);
  });

  it('a building tagged building:part=no is an outline, not a part', () => {
    const tagged = [
      way(5, { building: 'tower', 'building:part': 'no', height: '330' }, 0, 0, 30, 30),
      way(6, { 'building:part': 'yes', height: '40' }, 0, 0, 10, 10),
    ];
    const r = siteFromOverpass({ elements: tagged as never }, { ...opts, buildingIds: ['way/5'] });
    expect(r.site.measurements.some(m => m.what === `${OUTLINE_PREFIX}way/5`)).toBe(true);
    expect(r.site.parts.map(p => p.partId).sort()).toEqual(['way/5', 'way/6']);
  });

  it('a named element with no building tag (a site area, a bridge) admits parts but is not massed itself', () => {
    const area = [
      way(7, { name: 'Castle grounds', height: '3' }, 0, 0, 80, 80),
      way(8, { 'building:part': 'yes', height: '25' }, 10, 10, 10, 10),
    ];
    const r = siteFromOverpass({ elements: area as never }, { ...opts, buildingIds: ['way/7'] });
    expect(r.site.parts.map(p => p.partId)).toEqual(['way/8']);
    expect(r.warnings.some(w => w.includes('way/8') && w.includes('neighbour'))).toBe(false);
  });

  it('an unknown id is an error, not a silent drop', () => {
    expect(() => siteFromOverpass({ elements: els as never }, { ...opts, buildingIds: ['way/999'] })).toThrow(/way\/999/);
  });
});

describe('mq2 terraced skillion (a roof that is the whole body)', () => {
  /** Two stacked wedge tiers like Eiffel's legs: the high edge of each wedge meets the next tier's base. */
  const tiers: SiteEvidence = site({
    footprint: [
      { outer: rect(40, 40), holes: [], partId: 'low' },
      { outer: rect(20, 20, 0, -10), holes: [], partId: 'high' },
    ],
    parts: [
      { partId: 'low', baseM: 0, heightM: 40, roof: { shape: 'shed' } },
      { partId: 'high', baseM: 40, heightM: 120, roof: { shape: 'shed' } },
    ],
    measurements: [
      { what: 'roof-rise:low', valueM: 40, source: 'own' }, { what: 'roof-direction-deg:low', valueM: 180, source: 'own' },
      { what: 'roof-rise:high', valueM: 80, source: 'own' }, { what: 'roof-direction-deg:high', valueM: 180, source: 'own' },
    ],
  });

  it('turns each steep skillion into flat terraces that step up to the part height', () => {
    const r = buildMassing(tiers, { rotate: false, scale: { target: 1 } });
    const lows = r.massing.volumes.filter(v => v.id.startsWith('vol-low'));
    expect(lows.length).toBeGreaterThan(3);
    expect(lows.every(v => v.roof.shape === 'flat')).toBe(true);
    // The terraces rise monotonically and the highest reaches the part's true top; none sticks out of its footprint.
    const tops = lows.map(v => v.topM).sort((a, b) => a - b);
    expect(tops[tops.length - 1]!).toBeGreaterThan(38);
    expect(r.trueTopM).toBeGreaterThan(118);
    const maxFootprint = Math.max(...lows.map(v => Math.abs(areaOf(v.outer))));
    expect(maxFootprint).toBeLessThanOrEqual(1600 + 1e-6);
  });

  it('a gentle ordinary skillion roof is left as a roof', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(12, 8), holes: [], partId: 'shed' }],
      parts: [{ partId: 'shed', baseM: 0, heightM: 8, roof: { shape: 'shed' } }],
      measurements: [{ what: 'roof-rise:shed', valueM: 2, source: 'own' }, { what: 'roof-direction-deg:shed', valueM: 180, source: 'own' }],
    }), { rotate: false });
    expect(r.massing.volumes).toHaveLength(1);
    expect(r.massing.volumes[0]!.roof.shape).toBe('shed');
  });

  it('the grammar builds the stack as one piece up to its real height: nothing is cut off the base plate', () => {
    const r = buildMassing(tiers, { rotate: false, scale: { target: 1 } });
    const features = buildFeatureSet({ site: tiers, massing: r, sidecars: [], tagParts: [] });
    const g = buildGrammarLattice(r.massing, features.set);
    expect(g.stats.stranded).toBe(0);
    const [W, , D] = g.lattice.dims;
    let top = 0;
    g.lattice.cells.forEach((c, i) => { if (c) top = Math.max(top, Math.floor(i / (W * D))); });
    // plates = metres * platesPerMetre, over the 2-plate base plate; the tower is within a few per cent of 120 m.
    expect(top / r.massing.scale.platesPerMetre).toBeGreaterThan(110);
  });
});

describe('mq2 cell masks to rings', () => {
  const fill = (w: number, d: number, rows: string[]): ReturnType<typeof newMask> => {
    const m = newMask(w, d);
    rows.forEach((row, j) => [...row].forEach((c, i) => { if (c === '#') m.cells[i + w * j] = 1; }));
    return m;
  };

  it('traces a rectangle with a hole into one outer ring and one hole', () => {
    const regions = traceMask(fill(5, 5, ['#####', '#####', '##.##', '#####', '#####']));
    expect(regions).toHaveLength(1);
    expect(regions[0]!.outer).toHaveLength(4);
    expect(regions[0]!.holes).toHaveLength(1);
    expect(Math.abs(areaOf(regions[0]!.outer)) - Math.abs(areaOf(regions[0]!.holes[0]!))).toBe(24);
  });

  it('cells that touch only at a corner stay two regions', () => {
    expect(traceMask(fill(2, 2, ['#.', '.#']))).toHaveLength(2);
  });

  it('an L-shape has six corners', () => {
    expect(traceMask(fill(3, 3, ['#..', '#..', '###']))[0]!.outer).toHaveLength(6);
  });

  it('opening removes a strip two cells wide and keeps one three wide', () => {
    expect(traceMask(openMask(fill(6, 4, ['######', '######', '......', '......']))).length).toBe(0);
    expect(traceMask(openMask(fill(6, 4, ['######', '######', '######', '......'])))).toHaveLength(1);
  });
});
