/**
 * A09 (BIZ-05): features from tags, licensed-photo annotation sidecars (authority) and mesh slices.
 * The Notre-Dame sidecar (`web/src/brickgen/features/sidecars/notre-dame.annotations.json`) is written from a
 * CC BY-SA photograph of the public west front; no LEGO set file was read for any value in it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildMassing, type MassingResult } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import { LicenceGateError } from '../web/src/brickgen/site/licence-gate.js';
import { buildFeatureSet } from '../web/src/brickgen/features/index.js';
import { parseSidecar, SidecarError } from '../web/src/brickgen/features/annotate.js';
import { featuresFromTags, tagPartsFromOverpass } from '../web/src/brickgen/features/tags.js';
import { featuresFromMesh } from '../web/src/brickgen/features/mesh.js';
import { SIDECAR_SCHEMA, type AnnotationSidecar, type FacadeEntry } from '../web/src/brickgen/features/types.js';
import type { FeatureSpec, SiteEvidence, SourceRef, Vec2m } from '../web/src/brickgen/types.js';

const OWN: SourceRef = { id: 'own', kind: 'measurement', retrieved: '2026-11-09', licence: 'own-work', usedFor: ['footprint'] };
const DRAWING: SourceRef = { id: 'drawing-1', kind: 'drawing', url: 'https://example.org/drawing', retrieved: '2026-11-09', licence: 'public-domain', usedFor: ['facade marks'] };

const rect = (w: number, d: number, cx = 0, cz = 0): Vec2m[] =>
  [[cx - w / 2, cz - d / 2], [cx + w / 2, cz - d / 2], [cx + w / 2, cz + d / 2], [cx - w / 2, cz + d / 2]];

function site(over: Partial<SiteEvidence> & Pick<SiteEvidence, 'footprint' | 'parts'>): SiteEvidence {
  return { name: 'test', sources: [OWN], measurements: [], annotations: [], ...over };
}

/** A 20 x 10 m body 12 m high, massed at 1 stud per metre without rotation. */
function bodyMassing(): { s: SiteEvidence; m: MassingResult } {
  const s = site({ footprint: [{ outer: rect(20, 10), holes: [], partId: 'a' }], parts: [{ partId: 'a', baseM: 0, heightM: 12 }] });
  return { s, m: buildMassing(s, { rotate: false }) };
}

function sidecar(facades: FacadeEntry[], sources: SourceRef[] = [DRAWING]): AnnotationSidecar {
  return { schema: SIDECAR_SCHEMA, site: 'test', sources, facades };
}

const edgeLength = (m: MassingResult, i: number): number => {
  const o = m.massing.volumes[0]!.outer;
  const a = o[i]!, b = o[(i + 1) % o.length]!;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
};

describe('brickgen-features annotations', () => {
  it('an annotation marking a rose window on edge 0 yields one rose FeatureSpec at the marked height', () => {
    const { s, m } = bodyMassing();
    const len = edgeLength(m, 0);
    const sc = sidecar([{
      id: 'f0', source: 'drawing-1', volume: 'a', edge: 0, image: { widthPx: 200, heightPx: 140 },
      // 200 px across the edge, 0.1 m per pixel, ground at row 120.
      calibration: { spanPx: [0, 200], groundRowPx: 120 },
      marks: [{ id: 'rose-1', kind: 'rose', boxPx: [80, 20, 120, 60] }],
    }]);
    const { set } = buildFeatureSet({ site: s, massing: m, sidecars: [sc] });
    const roses = set.features.filter(f => f.kind === 'rose');
    expect(roses).toHaveLength(1);
    const r = roses[0]!;
    expect(r.volume).toBe('vol-a');
    expect(r.edge).toBe(0);
    expect(r.atM[0]).toBeCloseTo(len / 2, 6); // centre of the edge
    expect(r.atM[1]).toBeCloseTo(6, 6); // bottom of the box: (120 - 60) px * 0.1
    expect(r.sizeM[0]).toBeCloseTo(4, 6);
    expect(r.sizeM[1]).toBeCloseTo(4, 6);
    expect(r.sources).toEqual(['drawing-1']);
    expect(r.confidence).toBeCloseTo(0.95, 6); // a drawing's authority
  });

  it('mirror runs image x from the edge end to its start', () => {
    const { s, m } = bodyMassing();
    const mk = (mirror: boolean): FeatureSpec => buildFeatureSet({
      site: s, massing: m,
      sidecars: [sidecar([{
        id: 'f0', source: 'drawing-1', volume: 'a', edge: 0, mirror, image: { widthPx: 200, heightPx: 140 },
        calibration: { spanPx: [0, 200], groundRowPx: 120 },
        marks: [{ id: 'w', kind: 'window', boxPx: [20, 40, 40, 80] }],
      }])],
    }).set.features[0]!;
    const len = edgeLength(m, 0);
    expect(mk(false).atM[0]).toBeCloseTo(0.1 * 30, 6);
    expect(mk(true).atM[0]).toBeCloseTo(len - 0.1 * 30, 6);
  });

  it('a count run keeps the whole box, one item width, the pitch and the count', () => {
    const { s, m } = bodyMassing();
    const { set } = buildFeatureSet({
      site: s, massing: m,
      sidecars: [sidecar([{
        id: 'f0', source: 'drawing-1', volume: 'a', edge: 0, image: { widthPx: 200, heightPx: 140 },
        calibration: { spanPx: [0, 200], groundRowPx: 120 },
        marks: [{ id: 'gallery', kind: 'arcade', boxPx: [20, 30, 180, 50], count: 8 }],
      }])],
    });
    const f = set.features[0]!;
    expect(f.count).toBe(8);
    expect(f.sizeM[0]).toBeCloseTo(2, 6); // 16 m run / 8
    expect(f.spacingM).toBeCloseTo(2, 6);
    expect(f.atM[0]).toBeCloseTo(10, 6); // centre of the run
  });

  it('heightRef sets the vertical scale from a second known height', () => {
    const { s, m } = bodyMassing();
    const { set } = buildFeatureSet({
      site: s, massing: m,
      sidecars: [sidecar([{
        id: 'f0', source: 'drawing-1', volume: 'a', edge: 0, image: { widthPx: 200, heightPx: 140 },
        // The 12 m wall top is at row 20 and the ground at row 120: 0.12 m per pixel vertically.
        calibration: { spanPx: [0, 200], groundRowPx: 120, heightRef: { rowPx: 20, heightM: 12 } },
        marks: [{ id: 'door', kind: 'door', boxPx: [90, 80, 110, 120] }],
      }])],
    });
    const f = set.features[0]!;
    expect(f.atM[1]).toBeCloseTo(0, 6);
    expect(f.sizeM[1]).toBeCloseTo(4.8, 6);
  });

  it('facing west places marks on the volume face and picks the ring edge; facing east runs the other way', () => {
    const { s, m } = bodyMassing();
    const v = m.massing.volumes[0]!;
    const zs = v.outer.map(p => p[1]);
    const zLo = Math.min(...zs), zHi = Math.max(...zs);
    const mark = { id: 'm', kind: 'window' as const, boxPx: [0, 40, 20, 80] as [number, number, number, number] };
    const run = (facing: 'west' | 'east'): FeatureSpec => buildFeatureSet({
      site: s, massing: m,
      sidecars: [sidecar([{
        id: 'f', source: 'drawing-1', volume: 'a', facing, image: { widthPx: 100, heightPx: 140 },
        calibration: { spanPx: [0, 100], groundRowPx: 120 }, marks: [mark],
      }])],
    }).set.features[0]!;
    const west = run('west'), east = run('east');
    const edgeOf = (f: FeatureSpec) => {
      const a = v.outer[f.edge!]!, b = v.outer[(f.edge! + 1) % v.outer.length]!;
      return { a, b };
    };
    // The 10 m x-facing sides: west is the edge at minimum x, east at maximum x.
    const xs = v.outer.map(p => p[0]);
    const w = edgeOf(west), e = edgeOf(east);
    expect(w.a[0]).toBe(Math.min(...xs));
    expect(w.b[0]).toBe(Math.min(...xs));
    expect(e.a[0]).toBe(Math.max(...xs));
    // Looking east from the west, left is north (low z): a mark on the image's left lands near z = zLo.
    const worldZ = (f: FeatureSpec): number => {
      const { a, b } = edgeOf(f);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return a[1] + ((b[1] - a[1]) / len) * f.atM[0];
    };
    expect(worldZ(west)).toBeCloseTo(zLo + 1, 6); // centre 10 px of 100 px over 10 m
    expect(worldZ(east)).toBeCloseTo(zHi - 1, 6);
  });
});

describe('brickgen-features sidecar validation', () => {
  const base = (): AnnotationSidecar => sidecar([{
    id: 'f0', source: 'drawing-1', volume: 'a', edge: 0, image: { widthPx: 200, heightPx: 140 },
    calibration: { spanPx: [0, 200], groundRowPx: 120 }, marks: [{ id: 'w', kind: 'window', boxPx: [0, 0, 10, 10] }],
  }]);

  it('accepts a good sidecar and rejects a wrong schema tag and unknown kinds with every message', () => {
    expect(parseSidecar(base()).facades).toHaveLength(1);
    const bad = base() as unknown as { schema: string; facades: Array<{ edge: number; marks: Array<{ kind: string }> }> };
    bad.schema = 'other/9';
    bad.facades[0]!.marks[0]!.kind = 'tardis';
    let err: unknown;
    try { parseSidecar(bad); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SidecarError);
    const msgs = (err as SidecarError).problems.join('\n');
    expect(msgs).toMatch(/schema/);
    expect(msgs).toMatch(/tardis/);
  });

  it('buildFeatureSet rejects an edge index outside the ring and a facade that names no source', () => {
    const { s, m } = bodyMassing();
    const sc = base();
    sc.facades[0]!.edge = 9;
    expect(() => buildFeatureSet({ site: s, massing: m, sidecars: [sc] })).toThrow(/edge 9/);
    const sc2 = base();
    sc2.facades[0]!.source = 'nope';
    expect(() => buildFeatureSet({ site: s, massing: m, sidecars: [sc2] })).toThrow(LicenceGateError);
  });
});

describe('brickgen-features licence gate', () => {
  const run = (sources: SourceRef[], commercial = true) => {
    const { s, m } = bodyMassing();
    return buildFeatureSet({
      site: s, massing: m, commercial,
      sidecars: [sidecar([{
        id: 'f0', source: sources[0]!.id, volume: 'a', edge: 0, image: { widthPx: 200, heightPx: 140 },
        calibration: { spanPx: [0, 200], groundRowPx: 120 }, marks: [{ id: 'w', kind: 'window', boxPx: [0, 0, 10, 10] }],
      }], sources)],
    });
  };

  it('refuses Google content, unknown licences, mislabelled Google URLs and attribution-less CC BY photos', () => {
    const photo = (over: Partial<SourceRef>): SourceRef => ({ id: 'p', kind: 'photo', retrieved: '2026-11-09', licence: 'cc-by', usedFor: ['marks'], ...over });
    expect(() => run([photo({ licence: 'google-maps-content' })])).toThrow(LicenceGateError);
    expect(() => run([photo({ licence: 'unknown' })])).toThrow(LicenceGateError);
    expect(() => run([photo({ licence: 'cc0', url: 'https://maps.googleapis.com/maps/api/streetview?x=1' })])).toThrow(LicenceGateError);
    expect(() => run([photo({ licence: 'cc-by' })])).toThrow(/attribution/);
  });

  it('accepts a CC BY-SA photo for measurement (share-alike is allowed for photos), and a local run warns on Google', () => {
    const ok = run([{ id: 'p', kind: 'photo', retrieved: '2026-11-09', licence: 'cc-by-sa', attribution: 'A. Author, CC BY-SA 3.0', usedFor: ['marks'] }]);
    expect(ok.report.licence.ok).toBe(true);
    expect(ok.report.licence.attributions).toContain('A. Author, CC BY-SA 3.0');
    const local = run([{ id: 'g', kind: 'photo', retrieved: '2026-11-09', licence: 'google-maps-content', usedFor: ['marks'] }], false);
    expect(local.report.licence.warnings).toHaveLength(1);
  });

  it('refuses a share-alike MESH (the geometry would ship)', () => {
    const { s, m } = bodyMassing();
    const meshSrc: SourceRef = { id: 'scan', kind: 'mesh', retrieved: '2026-11-09', licence: 'cc-by-sa', attribution: 'X', usedFor: ['bands'] };
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    expect(() => buildFeatureSet({ site: { ...s, sources: [...s.sources, meshSrc] }, massing: m, meshes: [{ ...tri, source: 'scan' }] })).toThrow(LicenceGateError);
  });
});

describe('brickgen-features precedence', () => {
  const spireSite = (): SiteEvidence => site({
    footprint: [{ outer: rect(10, 10), holes: [], partId: 'way/1' }],
    parts: [{ partId: 'way/1', baseM: 0, heightM: 30, roof: { shape: 'pyramidal' } }],
    measurements: [{ what: 'roof-rise:way/1', valueM: 20, source: 'own' }],
  });
  const tagParts = [{ partId: 'way/1', tags: { 'building:part': 'yes', 'roof:shape': 'pyramidal', 'roof:height': '20' }, sourceId: 'own' }];

  it('an annotation beats a tag feature of the same kind on the same volume, and the report says so', () => {
    const s = spireSite();
    const m = buildMassing(s, { rotate: false });
    const auto = buildFeatureSet({ site: s, massing: m, tagParts });
    expect(auto.set.features.filter(f => f.kind === 'spire')).toHaveLength(1);
    expect(auto.set.features[0]!.sources).toEqual(['own']);
    const withNote = buildFeatureSet({
      site: s, massing: m, tagParts,
      sidecars: [sidecar([{
        id: 'f', source: 'drawing-1', volume: 'way/1', edge: 0, image: { widthPx: 200, heightPx: 300 },
        calibration: { spanPx: [0, 200], groundRowPx: 280 }, marks: [{ id: 'spire-marked', kind: 'spire', boxPx: [90, 40, 110, 140] }],
      }])],
    });
    const spires = withNote.set.features.filter(f => f.kind === 'spire');
    expect(spires).toHaveLength(1);
    expect(spires[0]!.sources).toEqual(['drawing-1']);
    expect(withNote.report.superseded).toHaveLength(1);
    expect(withNote.report.superseded[0]!.dropped.origin).toBe('tags');
    expect(withNote.report.superseded[0]!.by.origin).toBe('annotation');
  });

  it('an automatic feature of a different kind survives, and output order is deterministic', () => {
    const s = spireSite();
    const m = buildMassing(s, { rotate: false });
    const sc = sidecar([{
      id: 'f', source: 'drawing-1', volume: 'way/1', edge: 0, image: { widthPx: 200, heightPx: 300 },
      calibration: { spanPx: [0, 200], groundRowPx: 280 }, marks: [{ id: 'd', kind: 'door', boxPx: [90, 220, 110, 280] }],
    }]);
    const a = buildFeatureSet({ site: s, massing: m, tagParts, sidecars: [sc] });
    const b = buildFeatureSet({ site: s, massing: m, tagParts, sidecars: [sc] });
    expect(a.set.features.map(f => f.kind).sort()).toEqual(['door', 'spire']);
    expect(JSON.stringify(a.set)).toBe(JSON.stringify(b.set));
  });
});

describe('brickgen-features tags', () => {
  const nd = JSON.parse(readFileSync(new URL('./fixtures/osm/notre-dame.overpass.json', import.meta.url), 'utf8'));
  const r = siteFromOverpass(nd, { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter', buildingId: 'way/201611261' });
  const m = buildMassing(r.site, { roles: r.roles });
  const parts = tagPartsFromOverpass(nd.elements);

  it('reads every building:part with its tags and the SourceRef id of its element', () => {
    const tour = parts.find(p => p.partId === 'way/201611269')!;
    expect(tour.tags['tower:type']).toBe('bell_tower');
    expect(tour.sourceId).toBe('osm-way-201611269');
  });

  it('finds the 96 m spire (35 m rise), the pinnacles and the flying buttresses of the Paris cathedral', () => {
    const { features } = featuresFromTags(m.massing, parts);
    const by = (k: string) => features.filter(f => f.kind === k);
    const spire = by('spire');
    expect(spire).toHaveLength(1);
    expect(spire[0]!.volume).toBe('vol-way-1299835416');
    expect(spire[0]!.sizeM[1]).toBeCloseTo(35, 0);
    expect(by('pinnacle').length).toBeGreaterThanOrEqual(10);
    // The 15 m skillion strips between nave and outer piers.
    expect(by('flying-buttress').length).toBeGreaterThanOrEqual(10);
    expect(features.every(f => f.confidence < 0.9)).toBe(true);
    expect(features.every(f => f.sources.length === 1 && f.sources[0]!.startsWith('osm-way-'))).toBe(true);
  });

  it('building:levels becomes a window row per level on long edges, at low confidence', () => {
    const s = site({
      footprint: [{ outer: rect(24, 10), holes: [], partId: 'way/7' }],
      parts: [{ partId: 'way/7', baseM: 0, heightM: 9.6 }],
    });
    const mm = buildMassing(s, { rotate: false });
    const { features } = featuresFromTags(mm.massing, [{ partId: 'way/7', tags: { 'building:part': 'yes', 'building:levels': '3' }, sourceId: 'own' }]);
    const windows = features.filter(f => f.kind === 'window');
    // 2 long edges x 3 levels.
    expect(windows).toHaveLength(6);
    expect(windows.every(f => (f.count ?? 0) >= 4 && f.confidence <= 0.4)).toBe(true);
  });

  it('a dome roof becomes a dome feature', () => {
    const s = site({
      footprint: [{ outer: rect(12, 12), holes: [], partId: 'way/8' }],
      parts: [{ partId: 'way/8', baseM: 0, heightM: 20, roof: { shape: 'dome' } }],
      measurements: [{ what: 'roof-rise:way/8', valueM: 6, source: 'own' }],
    });
    const mm = buildMassing(s, { rotate: false });
    const { features } = featuresFromTags(mm.massing, [{ partId: 'way/8', tags: { 'roof:shape': 'dome', 'roof:height': '6' }, sourceId: 'own' }]);
    expect(features.map(f => f.kind)).toEqual(['dome']);
  });
});

/** 12 triangles of an axis-aligned box. */
function boxMesh(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { positions: new Float32Array(p.flat()), indices: new Uint32Array(f.flat()) };
}
/** A square pyramid, apex at height y1. */
function pyramidMesh(cx: number, cz: number, half: number, y0: number, y1: number) {
  const p = [[cx - half, y0, cz - half], [cx + half, y0, cz - half], [cx + half, y0, cz + half], [cx - half, y0, cz + half], [cx, y1, cz]];
  const f = [[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
  return { positions: new Float32Array(p.flat()), indices: new Uint32Array(f.flat()) };
}

describe('brickgen-features mesh slices', () => {
  // A 10 x 10 m tower centred on the site origin, 18 m of shaft, a 12 x 12 m corbel table 1.2 m deep, a short
  // upper shaft and a 10 m pyramidal spire.
  const meshes = [
    boxMesh(-5, 5, 0, 18, -5, 5), boxMesh(-6, 6, 18, 19.2, -6, 6), boxMesh(-5, 5, 19.2, 22, -5, 5), pyramidMesh(0, 0, 5, 22, 32),
  ];
  const s = site({ footprint: [{ outer: rect(10, 10), holes: [], partId: 'way/9' }], parts: [{ partId: 'way/9', baseM: 0, heightM: 22 }] });
  const m = buildMassing(s, { rotate: false });

  it('finds the spire taper and the overhanging cornice, in the massing frame, on the right volume', () => {
    const { features } = featuresFromMesh(m.massing, meshes, { source: 'scan', frame: m.frame, deltaY: 0.5 });
    const spire = features.find(f => f.kind === 'spire')!;
    expect(spire).toBeDefined();
    expect(spire.volume).toBe('vol-way-9');
    expect(spire.atM[1]).toBeGreaterThanOrEqual(21);
    expect(spire.atM[1]).toBeLessThanOrEqual(23);
    expect(spire.sizeM[1]).toBeGreaterThan(8);
    // The site origin (0, 0) is the middle of the 10 x 10 m massing footprint.
    expect(spire.atM[0]).toBeCloseTo(5, 0);
    expect(spire.atM[2]).toBeCloseTo(5, 0);
    const cornice = features.find(f => f.kind === 'cornice')!;
    expect(cornice).toBeDefined();
    expect(cornice.atM[1]).toBeGreaterThan(17);
    expect(cornice.atM[1]).toBeLessThan(19);
    expect(features.every(f => f.sources[0] === 'scan' && f.confidence <= 0.75)).toBe(true);
  });

  it('a plain prism yields no features', () => {
    const { features } = featuresFromMesh(m.massing, [boxMesh(-5, 5, 0, 22, -5, 5)], { source: 'scan', frame: m.frame, deltaY: 0.5 });
    expect(features).toEqual([]);
  });

  it('flows through buildFeatureSet with the mesh licence-gated and listed in the report sources', () => {
    const meshSrc: SourceRef = { id: 'scan', kind: 'mesh', retrieved: '2026-11-09', licence: 'own-work', usedFor: ['bands'] };
    const r = buildFeatureSet({ site: { ...s, sources: [...s.sources, meshSrc] }, massing: m, meshes: meshes.map(x => ({ ...x, source: 'scan' })) });
    expect(r.set.features.some(f => f.kind === 'spire')).toBe(true);
    expect(r.report.sources).toContain('scan');
  });
});

describe('brickgen-features Notre-Dame de Paris (public west front)', () => {
  const nd = JSON.parse(readFileSync(new URL('./fixtures/osm/notre-dame.overpass.json', import.meta.url), 'utf8'));
  const sidecarJson = JSON.parse(readFileSync(new URL('../web/src/brickgen/features/sidecars/notre-dame.annotations.json', import.meta.url), 'utf8'));
  const r = siteFromOverpass(nd, { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter', buildingId: 'way/201611261' });
  const m = buildMassing(r.site, { roles: r.roles });
  const sc = parseSidecar(sidecarJson);
  const out = buildFeatureSet({ site: r.site, massing: m, sidecars: [sc], tagParts: tagPartsFromOverpass(nd.elements) });
  const f = (k: string) => out.set.features.filter(x => x.kind === k);
  const annotated = (k: string) => f(k).filter(x => x.confidence >= 0.9);

  it('records every source with url, author, sha256 and an open licence; none is Google content', () => {
    expect(sc.sources.length).toBeGreaterThanOrEqual(1);
    for (const src of sc.sources) {
      expect(src.url).toMatch(/^https:\/\/commons\.wikimedia\.org\//);
      expect(['public-domain', 'cc0', 'cc-by', 'cc-by-sa']).toContain(src.licence);
      expect(src.attribution?.length ?? 0).toBeGreaterThan(5);
      expect(src.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(out.report.licence.ok).toBe(true);
  });

  it('has three portals on the west front, the central one widest and all standing on the ground', () => {
    const portals = annotated('portal');
    expect(portals).toHaveLength(3);
    const widths = [...portals].sort((a, b) => a.atM[0] - b.atM[0]).map(p => p.sizeM[0]);
    expect(widths[1]!).toBeGreaterThan(widths[0]!);
    expect(widths[1]!).toBeGreaterThan(widths[2]!);
    for (const p of portals) { expect(p.atM[1]).toBeLessThan(1.5); expect(p.sizeM[1]).toBeGreaterThan(10); expect(p.sizeM[1]).toBeLessThan(18); }
    expect(new Set(portals.map(p => p.volume)).size).toBe(1);
  });

  it('has the west rose: one ~9.6 m window between the towers, 25-31 m up', () => {
    const roses = annotated('rose').filter(x => x.sizeM[0] > 6);
    expect(roses).toHaveLength(1);
    const rose = roses[0]!;
    expect(rose.sizeM[0]).toBeGreaterThan(9);
    expect(rose.sizeM[0]).toBeLessThan(10.5);
    expect(rose.sizeM[1]).toBeCloseTo(rose.sizeM[0], 0);
    const centre = rose.atM[1] + rose.sizeM[1] / 2;
    expect(centre).toBeGreaterThan(25);
    expect(centre).toBeLessThan(31);
  });

  it('has the twin towers with belfry lancets, the buttresses, the gallery of kings, and the 35 m spire', () => {
    for (const t of ['vol-way-201754180', 'vol-way-201611269']) {
      expect(annotated('lancet').filter(x => x.volume === t).length).toBeGreaterThanOrEqual(1);
    }
    expect(annotated('buttress').length).toBeGreaterThanOrEqual(4);
    expect(annotated('arcade').filter(x => (x.count ?? 0) === 28)).toHaveLength(1);
    expect(f('spire')).toHaveLength(1);
    expect(f('flying-buttress').length).toBeGreaterThanOrEqual(10);
    // Every feature cites a SourceRef that exists in the design's evidence.
    const known = new Set([...r.site.sources.map(x => x.id), ...sc.sources.map(x => x.id)]);
    for (const x of out.set.features) { expect(x.sources.length).toBeGreaterThan(0); for (const id of x.sources) expect(known.has(id)).toBe(true); }
  });

  it('puts the marks inside the massing: nothing hangs off its volume', () => {
    const vol = new Map(m.massing.volumes.map(v => [v.id, v]));
    for (const x of out.set.features.filter(y => y.confidence >= 0.9)) {
      const v = vol.get(x.volume)!;
      expect(v).toBeDefined();
      expect(x.atM[1]).toBeGreaterThanOrEqual(v.baseM - 0.5);
      expect(x.atM[1] + x.sizeM[1]).toBeLessThanOrEqual(v.topM + 6);
    }
  });
});
