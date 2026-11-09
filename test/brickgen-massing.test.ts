/** A05 (BIZ-05/06): massing from footprints, scale choice and the input licence gate. */
import { describe, expect, it } from 'vitest';
import { assertSiteLicences, gateSite, isGoogleMapsUrl, LicenceGateError } from '../web/src/brickgen/site/licence-gate.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { dominantAxisDeg, isSimpleRing, ringArea, rotatePoint } from '../web/src/brickgen/massing/geometry.js';
import { chooseScale } from '../web/src/brickgen/massing/scale.js';
import { simplifyRingStuds } from '../web/src/brickgen/massing/simplify.js';
import type { SiteEvidence, SourceRef, Vec2m } from '../web/src/brickgen/types.js';

const OWN: SourceRef = { id: 'own', kind: 'measurement', retrieved: '2026-11-09', licence: 'own-work', usedFor: ['footprint'] };

/** A centred axis-aligned rectangle ring. */
const rect = (w: number, d: number, cx = 0, cz = 0): Vec2m[] =>
  [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];

function site(over: Partial<SiteEvidence> & Pick<SiteEvidence, 'footprint' | 'parts'>): SiteEvidence {
  return { name: 'test', sources: [OWN], measurements: [], annotations: [], ...over };
}

const onGrid = (v: number, s: number): boolean => Math.abs(v * s - Math.round(v * s)) < 1e-6;

describe('brickgen-massing', () => {
  it('a 20 x 10 m rectangle at 1 stud per metre becomes a 20 x 10 stud volume with edges on the grid', () => {
    const { massing } = buildMassing(site({
      footprint: [{ outer: rect(20, 10), holes: [], partId: 'a' }],
      parts: [{ partId: 'a', baseM: 0, heightM: 6 }],
    }));
    expect(massing.scale.studsPerMetre).toBe(1);
    const v = massing.volumes[0]!;
    const xs = v.outer.map(p => p[0]), zs = v.outer.map(p => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)]).toEqual([0, 20, 0, 10]);
    expect(v.outer).toHaveLength(4);
    for (const [x, z] of v.outer) { expect(onGrid(x, 1)).toBe(true); expect(onGrid(z, 1)).toBe(true); }
    expect(v.topM).toBeCloseTo(6, 6);
    expect(v.baseM).toBe(0);
  });

  it('a rectangle turned 33 degrees is rotated back onto the stud axes', () => {
    const turned = rect(24, 12).map(p => rotatePoint(p, 33));
    const r = buildMassing(site({ footprint: [{ outer: turned, holes: [], partId: 'a' }], parts: [{ partId: 'a', baseM: 0, heightM: 5 }] }));
    expect(Math.abs(r.frame.rotationDeg - 33)).toBeLessThan(0.5);
    const v = r.massing.volumes[0]!;
    expect(v.outer).toHaveLength(4);
    const xs = v.outer.map(p => p[0]), zs = v.outer.map(p => p[1]);
    // Axis-aligned: every edge is horizontal or vertical, and the sides are 24 x 12 (or 12 x 24 when the frame flips).
    expect(new Set(xs).size).toBe(2);
    expect(new Set(zs).size).toBe(2);
    expect(Math.max(...xs) * Math.max(...zs)).toBeCloseTo(288, -1);
    expect(r.massing.volumes[0]!.outer.every(([x, z]) => onGrid(x, 1) && onGrid(z, 1))).toBe(true);
  });

  it('keeps a courtyard hole and gives it the opposite orientation', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(30, 30), holes: [rect(10, 10)], partId: 'c' }],
      parts: [{ partId: 'c', baseM: 0, heightM: 8 }],
    }));
    const v = r.massing.volumes[0]!;
    expect(v.holes).toHaveLength(1);
    expect(ringArea(v.outer) - ringArea(v.holes[0]!)).toBe(800);
    expect(v.holes[0]!.every(([x, z]) => x > 0 && x < 30 && z > 0 && z < 30)).toBe(true);
  });

  it('drops a hole that collapses at a coarse scale and says so', () => {
    const r = buildMassing(site({
      footprint: [{ outer: rect(40, 40), holes: [rect(0.4, 0.4)], partId: 'c' }],
      parts: [{ partId: 'c', baseM: 0, heightM: 8 }],
    }));
    expect(r.massing.volumes[0]!.holes).toHaveLength(0);
    expect(r.warnings.join(' ')).toMatch(/hole/);
  });

  it('part heights: stacked and offset parts keep their own base and top, snapped to plates', () => {
    const r = buildMassing(site({
      footprint: [
        { outer: rect(20, 20), holes: [], partId: 'base' },
        { outer: rect(6, 6), holes: [], partId: 'tower' },
        { outer: rect(6, 6), holes: [], partId: 'spire' },
      ],
      parts: [
        { partId: 'base', baseM: 0, heightM: 10 },
        { partId: 'tower', baseM: 0, heightM: 40 },
        { partId: 'spire', baseM: 40, heightM: 46, roof: { shape: 'pyramidal' } },
      ],
      measurements: [{ what: 'roof-rise:spire', valueM: 4, source: 'own' }],
    }), { roles: { tower: 'tower' } });
    const byId = Object.fromEntries(r.massing.volumes.map(v => [v.id, v]));
    expect(r.massing.volumes).toHaveLength(3); // the spire is NOT swallowed by the tower under it
    expect(byId['vol-spire']!.baseM).toBe(40);
    expect(byId['vol-spire']!.topM).toBeCloseTo(42, 6); // 46 total - 4 m roof rise
    expect(byId['vol-spire']!.roof.shape).toBe('pyramidal');
    expect(byId['vol-spire']!.roof.pitchDeg).toBeGreaterThan(50); // rises 4 m over 3 m half span
    expect(byId['vol-tower']!.role).toBe('tower');
    for (const v of r.massing.volumes) {
      expect(onGrid(v.baseM, r.massing.scale.platesPerMetre)).toBe(true);
      expect(onGrid(v.topM, r.massing.scale.platesPerMetre)).toBe(true);
    }
    expect(r.massing.boundsM[1][1]).toBeCloseTo(46, 6);
  });

  it('an outline fully covered by its building parts is dropped, a partly covered one is kept', () => {
    const base = {
      footprint: [
        { outer: rect(20, 10), holes: [], partId: 'outline' },
        { outer: rect(20, 10, 0, 0), holes: [], partId: 'p1' },
      ],
      parts: [{ partId: 'outline', baseM: 0, heightM: 5 }, { partId: 'p1', baseM: 0, heightM: 12 }],
    };
    const covered = buildMassing(site(base));
    expect(covered.massing.volumes.map(v => v.id)).toEqual(['vol-p1']);
    expect(covered.dropped[0]!.partId).toBe('outline');

    const partial = buildMassing(site({ ...base, footprint: [base.footprint[0]!, { outer: rect(6, 10, -7, 0), holes: [], partId: 'p1' }] }));
    expect(partial.massing.volumes.map(v => v.id).sort()).toEqual(['vol-outline', 'vol-p1']);
  });

  it('reports the source vertex of every output edge', () => {
    // A square with one extra vertex on an edge, wobbling by 0.1 m: simplification removes it.
    const ring: Vec2m[] = [[0, 0], [5, 0.1], [10, 0], [10, 10], [0, 10]];
    const r = buildMassing(site({ footprint: [{ outer: ring, holes: [], partId: 'a' }], parts: [{ partId: 'a', baseM: 0, heightM: 4 }] }), { rotate: false });
    expect(r.reports[0]!.originalVertices).toBe(5);
    expect(r.reports[0]!.vertices).toBe(4);
    expect(r.reports[0]!.edgeSource).not.toContain(1);
  });

  it('refuses a site with no usable footprint', () => {
    expect(() => buildMassing(site({ footprint: [], parts: [] }))).toThrow(/no footprint/);
  });
});

describe('brickgen-massing geometry', () => {
  it('dominantAxisDeg finds the wall direction regardless of which axis the walls vote for', () => {
    const turned = rect(30, 10).map(p => rotatePoint(p, 20));
    expect(dominantAxisDeg([turned])).toBeCloseTo(20, 3);
    expect(dominantAxisDeg([rect(30, 10)])).toBeCloseTo(0, 6);
    expect(dominantAxisDeg([rect(30, 10).map(p => rotatePoint(p, 110))])).toBeCloseTo(20, 3);
  });

  it('simplification never returns a self-intersecting ring and keeps an L-shape as 6 vertices', () => {
    const l: Vec2m[] = [[0, 0], [20, 0], [20, 8.2], [8, 8], [8, 20], [0, 20]];
    const r = simplifyRingStuds(l);
    expect(r.mode).toBe('snapped');
    expect(r.points).toHaveLength(6);
    expect(isSimpleRing(r.points.map(p => [p.x, p.z] as Vec2m))).toBe(true);
    expect(r.nonOrthogonalEdges).toBe(0);
  });

  it('diagonal edges survive and are counted', () => {
    const tri: Vec2m[] = [[0, 0], [20, 0], [0, 20]];
    const r = simplifyRingStuds(tri);
    expect(r.nonOrthogonalEdges).toBe(1);
  });
});

describe('brickgen-massing scale', () => {
  const big = [{ outer: rect(200, 100), holes: [], baseM: 0, topM: 60 }];
  it('keeps the target when the budget allows it', () => {
    expect(chooseScale(big, { target: 1, maxBricks: 10_000_000 }).studsPerMetre).toBe(1);
  });
  it('clamps by the brick budget and explains why', () => {
    const s = chooseScale(big, { target: 1, maxBricks: 5_000 });
    expect(s.studsPerMetre).toBeLessThan(1);
    expect(s.reason).toMatch(/brick budget/);
    expect(s.platesPerMetre).toBeCloseTo(s.studsPerMetre * 2.5, 9);
  });
  it('clamps the footprint side and the height', () => {
    expect(chooseScale(big, { maxBricks: 1e12, maxStudsXZ: 100 }).studsPerMetre).toBe(0.5);
    expect(chooseScale(big, { maxBricks: 1e12, maxPlates: 75 }).studsPerMetre).toBe(0.5);
  });
  it('the figure preset is finer than architecture', () => {
    expect(chooseScale([{ outer: rect(6, 4), holes: [], baseM: 0, topM: 3 }], { target: 'figure' }).studsPerMetre).toBe(2.7);
  });
});

describe('brickgen-massing licence gate', () => {
  const geo = (licence: SourceRef['licence'], extra: Partial<SourceRef> = {}): SiteEvidence => site({
    sources: [{ ...OWN, licence, ...extra }],
    footprint: [{ outer: rect(10, 10), holes: [], partId: 'a' }], parts: [{ partId: 'a', baseM: 0, heightM: 4 }],
  });

  it('the licence gate refuses google-maps-content', () => {
    const s = geo('google-maps-content');
    expect(gateSite(s, { commercial: true }).ok).toBe(false);
    expect(() => assertSiteLicences(s, { commercial: true })).toThrow(LicenceGateError);
    expect(() => buildMassing(s)).toThrow(LicenceGateError); // massing is commercial unless told otherwise
  });

  it('the licence gate refuses unknown in a commercial run and only warns in a local one', () => {
    const s = geo('unknown');
    expect(gateSite(s, { commercial: true }).ok).toBe(false);
    const local = gateSite(s, { commercial: false });
    expect(local.ok).toBe(true);
    expect(local.warnings).toHaveLength(1);
    expect(() => buildMassing(s, { commercial: false })).not.toThrow();
  });

  it('refuses a Google-hosted URL under any declared licence, even in a local run', () => {
    const s = geo('cc0', { url: 'https://maps.googleapis.com/maps/api/staticmap?center=1,2' });
    expect(gateSite(s, { commercial: false }).ok).toBe(false);
    expect(isGoogleMapsUrl('https://www.google.com/maps/@48.85,2.35,17z')).toBe(true);
    expect(isGoogleMapsUrl('https://overpass-api.de/api/interpreter')).toBe(false);
    expect(isGoogleMapsUrl('not a url')).toBe(false);
  });

  it('requires an attribution where the licence does, and collects the attributions', () => {
    expect(gateSite(geo('odbl'), { commercial: true }).ok).toBe(false);
    const ok = gateSite(geo('odbl', { attribution: '(c) OpenStreetMap contributors' }), { commercial: true });
    expect(ok.ok).toBe(true);
    expect(ok.attributions).toEqual(['(c) OpenStreetMap contributors']);
  });

  it('refuses share-alike 3D geometry but allows share-alike photos for measurement', () => {
    expect(gateSite(geo('cc-by-sa', { kind: 'mesh', attribution: 'x' }), { commercial: true }).ok).toBe(false);
    expect(gateSite(geo('cc-by-sa', { kind: 'photo', attribution: 'x' }), { commercial: true }).ok).toBe(true);
  });

  it('treats evidence citing a missing source as unlicensed, and geometry with no sources as refused', () => {
    const s = geo('own-work');
    s.measurements.push({ what: 'length', valueM: 5, source: 'nowhere' });
    const r = gateSite(s, { commercial: true });
    expect(r.refused.map(f => f.sourceId)).toContain('nowhere');
    expect(gateSite({ ...geo('own-work'), sources: [] }, { commercial: true }).ok).toBe(false);
  });
});
