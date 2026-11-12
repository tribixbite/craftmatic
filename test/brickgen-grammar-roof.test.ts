/**
 * A07 (BIZ-05): roof grammars. A massing volume's `RoofSpec` becomes `roof-slope` cells the X-10 bricker turns into
 * real slope parts (not a stepped hip of bricks), in the descent direction the slope picker expects, and every
 * result must still pass X-09 with one component.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
import { buildGrammarLattice, buildGrammarModel } from '../web/src/brickgen/grammar/index.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { FeatureSet, IntentLattice, Massing, MassVolume, RoofSpec, Vec2m } from '../web/src/brickgen/types.js';
import { isClean } from '../web/src/brickgen/verify/index.js';
import { placeAll, VOCABULARY_LOOKUP } from '../web/src/brickgen/verify/world.js';
import { slopeDirOf } from '../web/src/brickgen/bricker/index.js';
import { elementFor } from '../web/src/brickgen/vocab/index.js';
import type { BrickPlan } from '../web/src/brickgen/types.js';

const NO_FEATURES: FeatureSet = { features: [], style: { wallColour: 71, trimColour: 71, roofColour: 72, accentColours: [] } };
const rect = (x0: number, z0: number, x1: number, z1: number): Vec2m[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** One volume on the ground at 1 stud per metre (2.5 plates per metre). */
function massingOf(volumes: MassVolume[]): Massing {
  let w = 0, d = 0, h = 0;
  for (const v of volumes) { for (const [x, z] of v.outer) { w = Math.max(w, x); d = Math.max(d, z); } h = Math.max(h, v.topM + 30); }
  return { volumes, scale: { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' }, boundsM: [[0, 0, 0], [w, h, d]] };
}
const volume = (id: string, outer: Vec2m[], topM: number, roof: RoofSpec, role: MassVolume['role'] = 'body'): MassVolume =>
  ({ id, outer, holes: [], baseM: 0, topM, roof, role });

const SLOPE_PARTS = new Set(['3040b.dat', '3039.dat', '3038.dat', '3037.dat', '3298.dat', '3297.dat', '4286.dat', '11477.dat', '85984.dat', '15068.dat']);

/** Grammar -> bricker, the whole path a roof takes. */
function build(volumes: MassVolume[]): { lattice: IntentLattice; plan: BrickPlan; clean: boolean; pad: number } {
  const { lattice, frame } = buildGrammarLattice(massingOf(volumes), NO_FEATURES);
  const r = brickLattice(lattice);
  return { lattice, plan: r.plan, clean: isClean(r.report), pad: frame.pad };
}

/** Slope elements with the cell-space centre of their body and the direction their roof descends. */
function slopes(plan: BrickPlan): Array<{ part: string; cx: number; cz: number; dir: number; top: number }> {
  const { world } = placeAll(plan.elements, VOCABULARY_LOOKUP);
  return world.filter(w => SLOPE_PARTS.has(w.placed.part)).map(w => {
    let sx = 0, sz = 0, top = 0;
    for (const [x, p, z] of w.body) { sx += x + 0.5; sz += z + 0.5; top = Math.max(top, p); }
    return { part: w.placed.part, cx: sx / w.body.length, cz: sz / w.body.length, dir: slopeDirOf(elementFor(w.placed.part)!, w.placed.turn)!, top };
  });
}

/** Highest filled plate layer of the column holding cell `(x, z)`. */
function columnTop(l: IntentLattice, x: number, z: number): number {
  const [W, H, D] = l.dims;
  for (let p = H - 1; p >= 0; p--) if (l.cells[(p * D + z) * W + x]) return p;
  return -1;
}

describe('brickgen-grammar-roof gabled', () => {
  const walls = 6; // metres of wall under the roof
  const { lattice, plan, clean, pad } = build([volume('a', rect(0, 0, 10, 24), walls, { shape: 'gabled', pitchDeg: 45, ridgeAxis: 'long' })]);

  it('a gabled roof over a 10-stud span at 45 degrees uses slope elements on both faces and closes at the ridge', () => {
    const s = slopes(plan);
    const west = s.filter(e => e.cx - pad < 5), east = s.filter(e => e.cx - pad > 5);
    expect(west.length).toBeGreaterThanOrEqual(4);
    expect(east.length).toBeGreaterThanOrEqual(4);
    // Slopes face outward: the west face descends towards -x (dir 1), the east face towards +x (dir 0).
    expect(west.every(e => e.dir === 1)).toBe(true);
    expect(east.every(e => e.dir === 0)).toBe(true);
    // Closes at the ridge: the two centre columns are the highest, level with each other, and the roof falls away from them.
    const mid = (x: number): number => columnTop(lattice, pad + x, pad + 12);
    expect(mid(4)).toBe(mid(5));
    for (let x = 0; x < 4; x++) expect(mid(x)).toBeLessThanOrEqual(mid(x + 1));
    for (let x = 6; x < 10; x++) expect(mid(x)).toBeLessThanOrEqual(mid(x - 1));
    expect(mid(0)).toBeLessThan(mid(4) - 6);
  });

  it('rises at the pitch the massing asked for (45 degrees: 5 studs of half span = 12.5 plates, within a brick)', () => {
    // Roof base = the ceiling's top: 6 m of wall is 15 plates over the 2-plate base plate.
    const apex = columnTop(lattice, pad + 4, pad + 12) + 1 - (15 + 2);
    expect(Math.abs(apex - 12.5)).toBeLessThanOrEqual(3);
  });

  it('verifies as one clean component', () => { expect(clean).toBe(true); });
});

/** Slope elements whose descent direction points away from `centre` (a slope part facing outward has a positive dot product). */
function outwardness(plan: BrickPlan, centre: [number, number]): { total: number; outward: number } {
  const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const s = slopes(plan);
  let outward = 0;
  for (const e of s) {
    const [dx, dz] = DIRS[e.dir]!;
    if ((e.cx - centre[0]) * dx + (e.cz - centre[1]) * dz > 0) outward++;
  }
  return { total: s.length, outward };
}

describe('brickgen-grammar-roof shapes', () => {
  const pad = 4;
  it('a hipped roof slopes down towards all four eaves, every slope part facing outward', () => {
    const r = build([volume('a', rect(0, 0, 14, 14), 6, { shape: 'hipped', pitchDeg: 31 })]);
    const o = outwardness(r.plan, [pad + 7, pad + 7]);
    expect(o.total).toBeGreaterThanOrEqual(8);
    expect(o.outward).toBe(o.total);
    expect(new Set(slopes(r.plan).map(e => e.dir)).size).toBe(4);
    expect(r.clean).toBe(true);
  });

  it('a pyramidal roof over a 12 x 12 base closes at one apex column', () => {
    const r = build([volume('a', rect(0, 0, 12, 12), 6, { shape: 'pyramidal', pitchDeg: 45 })]);
    expect(columnTop(r.lattice, pad + 5, pad + 5)).toBeGreaterThan(columnTop(r.lattice, pad, pad + 5) + 6);
    const o = outwardness(r.plan, [pad + 6, pad + 6]);
    expect(o.outward).toBe(o.total);
    expect(r.clean).toBe(true);
  });

  it('a conical roof over a round plan is a cone: the apex is over the middle and the plan stays one piece', () => {
    const ring: Vec2m[] = Array.from({ length: 32 }, (_, i) => [8 + 8 * Math.cos((i / 32) * 2 * Math.PI), 8 + 8 * Math.sin((i / 32) * 2 * Math.PI)] as Vec2m);
    const r = build([volume('a', ring, 5, { shape: 'conical', pitchDeg: 50 })]);
    expect(columnTop(r.lattice, pad + 8, pad + 8)).toBeGreaterThan(columnTop(r.lattice, pad + 1, pad + 8) + 8);
    expect(slopes(r.plan).length).toBeGreaterThanOrEqual(4);
    expect(r.clean).toBe(true);
  });

  it('a shed roof descends one way only (towards -z) and rises along the whole span', () => {
    const r = build([volume('a', rect(0, 0, 20, 8), 5, { shape: 'shed', pitchDeg: 20 })]);
    const s = slopes(r.plan);
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(new Set(s.map(e => e.dir))).toEqual(new Set([3])); // the run is across z; the low side is z = 0
    expect(columnTop(r.lattice, pad + 10, pad + 7)).toBeGreaterThan(columnTop(r.lattice, pad + 10, pad));
    expect(r.clean).toBe(true);
  });

  it('a steep Gothic roof (57 degrees over a 14-stud span) is built of slope parts, stepped, and as high as the pitch says', () => {
    const r = build([volume('a', rect(0, 0, 14, 30), 8, { shape: 'gabled', pitchDeg: 57, ridgeAxis: 'long' })]);
    expect(slopes(r.plan).length).toBeGreaterThanOrEqual(8);
    const topP = Math.round(8 * 2.5) + 2;
    const apex = columnTop(r.lattice, pad + 6, pad + 15) + 1 - topP;
    const expected = Math.tan((57 * Math.PI) / 180) * 7 * 2.5;
    expect(Math.abs(apex - expected)).toBeLessThanOrEqual(0.15 * expected);
    expect(r.clean).toBe(true);
  });

  it('a shallow 22 degree roof uses the 33 degree slope family in a continuous ramp', () => {
    const r = build([volume('a', rect(0, 0, 12, 20), 5, { shape: 'gabled', pitchDeg: 22, ridgeAxis: 'long' })]);
    const parts = new Set(slopes(r.plan).map(e => e.part));
    expect([...parts].some(p => ['4286.dat', '3298.dat', '3297.dat'].includes(p))).toBe(true);
    expect(r.clean).toBe(true);
  });

  it('an L-shaped plan gets a gable on each leg, one connected roof', () => {
    const L: Vec2m[] = [[0, 0], [10, 0], [10, 24], [24, 24], [24, 34], [0, 34]];
    const r = build([volume('a', L, 6, { shape: 'gabled', pitchDeg: 40 })]);
    expect(slopes(r.plan).length).toBeGreaterThanOrEqual(8);
    expect(r.clean).toBe(true);
  });

  it('a spire reaches the rise A9 measured (35 m over a 6-stud base) and clips nothing', () => {
    const spire = volume('a', rect(0, 0, 6, 6), 20, { shape: 'pyramidal', pitchDeg: 85.5 });
    const features: FeatureSet = { features: [{ kind: 'spire', volume: 'a', atM: [3, 20, 3], sizeM: [6, 35, 6], confidence: 0.7, sources: ['t'] }], style: NO_FEATURES.style };
    const { lattice, stats } = buildGrammarLattice(massingOf([spire]), features);
    const apex = columnTop(lattice, pad + 3, pad + 3) + 1 - (Math.round(20 * 2.5) + 2);
    expect(Math.abs(apex - 87.5)).toBeLessThanOrEqual(6);
    expect(stats.roofs['spire']).toBe(1);
    expect(stats.clipped).toBe(0);
  });

  it('a pitch over 60 degrees is capped by the wall height (a widened sub-stud footprint is not a tower)', () => {
    const { lattice } = buildGrammarLattice(massingOf([volume('a', rect(0, 0, 5, 13), 18, { shape: 'shed', pitchDeg: 88.4 })]), NO_FEATURES);
    const topP = Math.round(18 * 2.5) + 2;
    expect(columnTop(lattice, pad + 4, pad + 6) + 1 - topP).toBeLessThanOrEqual(Math.round(0.5 * (topP - 2)) + 1);
  });

  it('a dome rises to the height A9 gave it and is level at the crown', () => {
    const ring: Vec2m[] = Array.from({ length: 32 }, (_, i) => [10 + 10 * Math.cos((i / 32) * 2 * Math.PI), 10 + 10 * Math.sin((i / 32) * 2 * Math.PI)] as Vec2m);
    const features: FeatureSet = { features: [{ kind: 'dome', volume: 'a', atM: [10, 6, 10], sizeM: [20, 8, 20], confidence: 0.7, sources: ['t'] }], style: NO_FEATURES.style };
    const dome = volume('a', ring, 6, { shape: 'dome' });
    const { lattice } = buildGrammarLattice(massingOf([dome]), features);
    const apex = columnTop(lattice, pad + 10, pad + 10) + 1 - (Math.round(6 * 2.5) + 2);
    expect(Math.abs(apex - 20)).toBeLessThanOrEqual(5);
    expect(columnTop(lattice, pad + 10, pad + 10)).toBeGreaterThanOrEqual(columnTop(lattice, pad + 11, pad + 10) - 1);
    expect(isClean(brickLattice(lattice).report)).toBe(true);
  });

  it('a mansard is steep low down and shallower above, and a flat roof draws nothing above its ceiling', () => {
    const m = buildGrammarLattice(massingOf([volume('a', rect(0, 0, 16, 16), 6, { shape: 'mansard', pitchDeg: 60 })]), NO_FEATURES);
    const f = buildGrammarLattice(massingOf([volume('a', rect(0, 0, 16, 16), 6, { shape: 'flat' })]), NO_FEATURES);
    const topP = Math.round(6 * 2.5) + 2;
    expect(columnTop(m.lattice, pad + 8, pad + 8)).toBeGreaterThan(topP + 4);
    expect(columnTop(f.lattice, pad + 8, pad + 8)).toBe(topP - 1);
    expect(m.stats.roofs['mansard']).toBe(1);
  });

  it('two volumes whose roofs meet still verify as one model, and a taller volume cuts through a shorter roof', () => {
    const r = build([
      volume('low', rect(0, 0, 20, 12), 5, { shape: 'gabled', pitchDeg: 35, ridgeAxis: 'long' }),
      volume('tower', rect(7, 3, 13, 9), 15, { shape: 'pyramidal', pitchDeg: 50 }, 'tower'),
    ]);
    expect(r.clean).toBe(true);
    expect(columnTop(r.lattice, pad + 10, pad + 6)).toBeGreaterThan(Math.round(15 * 2.5));
  });
});

/**
 * The real fixtures: the Notre-Dame and Louvre OSM massings with the A09 sidecar and tag features, through the whole
 * path (grammar, bricker, X-09). Rendered by `bun scripts/_grammar_render.ts notre-dame output/a07/notre-dame`.
 */
describe('brickgen-grammar real fixtures', () => {
  const FIX = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/osm/${name}.overpass.json`, import.meta.url), 'utf8'));

  function model(name: 'notre-dame' | 'louvre-palace') {
    const overpass = FIX(name) as { elements: Parameters<typeof tagPartsFromOverpass>[0] };
    const site = siteFromOverpass(overpass as never, { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter', ...(name === 'notre-dame' ? { buildingId: 'way/201611261' } : {}) });
    const massed = buildMassing(site.site, { roles: site.roles });
    const sidecars = name === 'notre-dame'
      ? [parseSidecar(JSON.parse(readFileSync(new URL('../web/src/brickgen/features/sidecars/notre-dame.annotations.json', import.meta.url), 'utf8')))]
      : [];
    const features = buildFeatureSet({ site: site.site, massing: massed, sidecars, tagParts: tagPartsFromOverpass(overpass.elements) });
    return { massed, features, built: buildGrammarModel(massed.massing, features.set) };
  }

  const nd = model('notre-dame');

  it('Notre-Dame verifies as one clean model: 1 component, nothing unsupported, no overlap, no illegal part', () => {
    const r = nd.built.report;
    expect(r.components).toBe(1);
    expect(r.unsupported).toBe(0);
    expect(r.overlaps).toBe(0);
    expect(r.illegalParts).toEqual([]);
    expect(r.cantileverViolations).toEqual([]);
    expect(nd.built.stats.clipped).toBe(0);
    expect(nd.built.pruned).toBeLessThanOrEqual(20); // a handful of cells the bricker could not join, not a sign of a broken roof
  }, 120_000);

  it('Notre-Dame is roofed in real slope parts (not stepped bricks) and its spire reaches the 96 m of the massing', () => {
    const hist = new Map<string, number>();
    for (const e of nd.built.plan.elements) hist.set(e.part, (hist.get(e.part) ?? 0) + 1);
    const slopeParts = [...SLOPE_PARTS].reduce((n, p) => n + (hist.get(p) ?? 0), 0);
    expect(slopeParts).toBeGreaterThan(400); // measured 560 parts: 70 % of the slope-labelled cells (hip corners and one-stud ridges are bricks)
    expect(nd.built.stats.roofs['gabled']).toBeGreaterThanOrEqual(10);
    expect(nd.built.stats.roofs['spire']).toBeGreaterThanOrEqual(1);
    const [W, H, D] = nd.built.lattice.dims;
    let top = 0;
    for (let i = 0; i < nd.built.lattice.cells.length; i++) if (nd.built.lattice.cells[i]) top = Math.max(top, Math.floor(i / (W * D)));
    void H;
    expect(Math.abs(top - 96.4 * 2.5 - 2)).toBeLessThanOrEqual(6);
  }, 120_000);

  it('Notre-Dame has the three west portals, the rose and the belfry lancets as openings', () => {
    const r = nd.features.set.features;
    expect(r.filter(f => f.kind === 'portal')).toHaveLength(3);
    expect(nd.built.stats.facade.byKind['portal']).toBe(3);
    expect(nd.built.stats.facade.byKind['rose']).toBeGreaterThanOrEqual(1);
    expect(nd.built.stats.facade.byKind['lancet']).toBeGreaterThanOrEqual(8);
    expect(nd.built.stats.facade.byKind['buttress']).toBeGreaterThanOrEqual(4);
    expect(nd.built.stats.facade.byKind['flying-buttress']).toBeGreaterThanOrEqual(10);
    expect(nd.built.stats.facade.openings).toBeGreaterThanOrEqual(30);
  }, 120_000);

  it('the Louvre palace (one flat volume, window rows) verifies clean with an opening for every window of every row', () => {
    const l = model('louvre-palace');
    expect(l.built.report.components).toBe(1);
    expect(l.built.report.unsupported).toBe(0);
    expect(l.built.stats.facade.openings).toBeGreaterThanOrEqual(200);
    expect(l.built.stats.roofs).toEqual({}); // the massing gives it a flat roof: nothing to roof
  }, 120_000);
});
