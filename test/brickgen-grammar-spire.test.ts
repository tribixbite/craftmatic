/**
 * SPIRE (BIZ-05 / BIZ-10): spires, conical and pyramidal roofs taper by height, the footprint shrinking stage by stage
 * (a stepped taper in the cells the bricker turns into plates and bricks, a real cone part on a square apex). Before,
 * a spire's rings were grouped like a slope roof's: the merged Notre-Dame spire was one tall needle of constant width.
 * Every result must still verify as one clean model.
 * Rendered by `bun scripts/_grammar_render.ts notre-dame output/spire/after` (and `cologne-spires --building=parts`).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
import { buildGrammarLattice, buildGrammarModel } from '../web/src/brickgen/grammar/index.js';
import { spireHeight } from '../web/src/brickgen/grammar/spire.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { FeatureSet, IntentLattice, Massing, MassVolume, RoofSpec, Vec2m } from '../web/src/brickgen/types.js';
import { isClean } from '../web/src/brickgen/verify/index.js';

const NO_FEATURES: FeatureSet = { features: [], style: { wallColour: 71, trimColour: 71, roofColour: 72, accentColours: [] } };

/** Regular polygon of `n` corners about `(cx, cz)`. */
const polygon = (cx: number, cz: number, r: number, n: number, turn = 0): Vec2m[] =>
  Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n + turn), cz + r * Math.sin((2 * Math.PI * i) / n + turn)] as Vec2m);
const square = (cx: number, cz: number, half: number): Vec2m[] => [[cx - half, cz - half], [cx + half, cz - half], [cx + half, cz + half], [cx - half, cz + half]];

/** One volume at 1 stud per metre (2.5 plates per metre), walls `wallM` high, roof as given; a `spire` feature when `spireM` is set. */
function spireLattice(outer: Vec2m[], wallM: number, roof: RoofSpec, spireM?: number): { lattice: IntentLattice; wallTop: number; clean: boolean; parts: Record<string, number> } {
  const v: MassVolume = { id: 'v', outer, holes: [], baseM: 0, topM: wallM, roof, role: 'body' };
  const m: Massing = { volumes: [v], scale: { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'test' }, boundsM: [[0, 0, 0], [40, wallM + 80, 40]] };
  const f: FeatureSet = spireM === undefined ? NO_FEATURES
    : { ...NO_FEATURES, features: [{ kind: 'spire', volume: 'v', sources: [], atM: [20, wallM, 20], sizeM: [6, spireM, 6], confidence: 1 }] };
  const { lattice, frame } = buildGrammarLattice(m, f);
  const r = brickLattice(lattice);
  const parts: Record<string, number> = {};
  for (const e of r.plan.elements) parts[e.part] = (parts[e.part] ?? 0) + 1;
  return { lattice, wallTop: Math.round(wallM * 2.5) + frame.basePlates, clean: isClean(r.report), parts };
}

/** Highest filled plate of every column (-1 for an empty one). */
function columnTops(l: IntentLattice): Int32Array {
  const [W, H, D] = l.dims;
  const top = new Int32Array(W * D).fill(-1);
  for (let p = 0; p < H; p++) for (let i = 0; i < W * D; i++) if (l.cells[p * W * D + i]) top[i] = p;
  return top;
}

/**
 * Footprint of the roof above `wallTop`: columns reaching each plate layer. Hollow fill is ignored on purpose (a column
 * counts while its top is at or above the layer), so the series is the silhouette and can only fall with height.
 */
function profile(l: IntentLattice, wallTop: number): number[] {
  const top = columnTops(l);
  const out: number[] = [];
  for (let p = wallTop; p < l.dims[1]; p++) { let n = 0; for (const t of top) if (t >= p) n++; if (n === 0) break; out.push(n); }
  return out;
}

describe('brickgen-grammar-spire profile', () => {
  it('spireHeight is a straight taper in the cell distance: the boundary lowest, the innermost at the apex', () => {
    expect(spireHeight(3, 3, 100)).toBe(100);
    expect(spireHeight(1, 3, 100)).toBeLessThan(spireHeight(1.5, 3, 100));
    expect(spireHeight(1.5, 3, 100)).toBeLessThan(spireHeight(2, 3, 100));
    expect(spireHeight(2, 3, 100)).toBeLessThan(100);
    expect(spireHeight(0.4, 3, 100)).toBeGreaterThanOrEqual(1);
  });
});

describe('brickgen-grammar-spire synthetic spires', () => {
  const oct = spireLattice(polygon(20, 20, 3.4, 8, Math.PI / 8), 10, { shape: 'pyramidal', pitchDeg: 85 }, 35);
  const sq = spireLattice(square(20, 20, 8), 8, { shape: 'pyramidal', pitchDeg: 80 }, 40);

  it('an octagonal 6-stud spire tapers: the footprint falls through at least three stages and never grows with height', () => {
    const prof = profile(oct.lattice, oct.wallTop);
    const stages = [...new Set(prof)];
    expect(stages.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < prof.length; i++) expect(prof[i]!).toBeLessThanOrEqual(prof[i - 1]!);
    // The widest stage is several times the tip: it is not one needle from foot to apex.
    expect(prof[0]!).toBeGreaterThanOrEqual(4 * prof[prof.length - 1]!);
  });

  it('a square 16-stud spire loses footprint stage by stage: at least 6 stages, the top third under a quarter of the foot', () => {
    const prof = profile(sq.lattice, sq.wallTop);
    expect(new Set(prof).size).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < prof.length; i++) expect(prof[i]!).toBeLessThanOrEqual(prof[i - 1]!);
    expect(prof[Math.floor((prof.length * 2) / 3)]!).toBeLessThan(prof[0]! / 4);
  });

  it('a square apex ends in a real cone part, and both spires verify clean', () => {
    expect(oct.parts['3942c.dat'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(sq.parts['3942c.dat'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(oct.clean).toBe(true);
    expect(sq.clean).toBe(true);
  });
});

describe('brickgen-grammar-spire conical and pyramidal tower roofs', () => {
  it('a conical tower roof still takes slope parts and verifies clean', () => {
    const cone = spireLattice(polygon(20, 20, 6, 16), 12, { shape: 'conical', pitchDeg: 57 });
    expect(cone.clean).toBe(true);
    const slopes = ['3040b.dat', '3039.dat', '3038.dat', '3037.dat', '3298.dat', '3297.dat', '4286.dat'].reduce((n, p) => n + (cone.parts[p] ?? 0), 0);
    expect(slopes).toBeGreaterThan(0);
    const prof = profile(cone.lattice, cone.wallTop);
    for (let i = 1; i < prof.length; i++) expect(prof[i]!).toBeLessThanOrEqual(prof[i - 1]!);
  });

  it('a pyramidal tower roof under the spire pitch is untouched: a stepped slope pyramid', () => {
    const pyr = spireLattice(square(20, 20, 6), 12, { shape: 'pyramidal', pitchDeg: 40 });
    expect(pyr.clean).toBe(true);
    expect(new Set(profile(pyr.lattice, pyr.wallTop)).size).toBeGreaterThanOrEqual(3);
  });
});

describe('brickgen-grammar-spire real fixtures', () => {
  const FIX = (name: string): { elements: Array<{ tags?: Record<string, string> }> } => JSON.parse(readFileSync(new URL(`./fixtures/osm/${name}.overpass.json`, import.meta.url), 'utf8'));
  const NOW = { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter' };

  /** Tallest `spire` feature's volume: the plates above its wall, as a footprint profile of the built lattice. */
  function spireProfile(massing: Massing, features: FeatureSet, lattice: IntentLattice, pad: number, ppm: number, spm: number): number[] {
    const f = [...features.features].filter(x => x.kind === 'spire').sort((a, b) => b.sizeM[1] - a.sizeM[1])[0]!;
    const v = massing.volumes.find(x => x.id === f.volume)!;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of v.outer) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const [W, H, D] = lattice.dims;
    const wallTop = Math.round(v.topM * ppm) + 2;
    const out: number[] = [];
    for (let p = wallTop; p < H; p++) {
      let n = 0;
      for (let z = Math.floor(z0 * spm) + pad; z < Math.ceil(z1 * spm) + pad; z++) for (let x = Math.floor(x0 * spm) + pad; x < Math.ceil(x1 * spm) + pad; x++) if (lattice.cells[(p * D + z) * W + x]) n++;
      if (n === 0) break;
      out.push(n);
    }
    return out;
  }

  it('Notre-Dame: the crossing spire tapers over several stages and the whole model verifies clean', () => {
    const overpass = FIX('notre-dame');
    const site = siteFromOverpass(overpass as never, { ...NOW, buildingId: 'way/201611261' });
    const massed = buildMassing(site.site, { roles: site.roles, scale: { target: 1 } });
    const sidecar = parseSidecar(JSON.parse(readFileSync(new URL('../web/src/brickgen/features/sidecars/notre-dame.annotations.json', import.meta.url), 'utf8')));
    const fs = buildFeatureSet({ site: site.site, massing: massed, sidecars: [sidecar], tagParts: tagPartsFromOverpass(overpass.elements as never) });
    const g = buildGrammarModel(massed.massing, fs.set);
    expect(g.report.components).toBe(1);
    expect(g.report.unsupported).toBe(0);
    expect(isClean(g.report)).toBe(true);
    const prof = spireProfile(massed.massing, fs.set, g.lattice, g.frame.pad, massed.massing.scale.platesPerMetre, massed.massing.scale.studsPerMetre);
    expect(prof.length).toBeGreaterThan(60); // the 35 m spire stands
    expect(new Set(prof).size).toBeGreaterThanOrEqual(3);
    expect(prof[0]!).toBeGreaterThanOrEqual(3 * prof[prof.length - 1]!);
    expect(g.plan.elements.some(e => e.part === '3942c.dat' || e.part === '4589.dat')).toBe(true);
  }, 120_000);

  it('Cologne Cathedral (OSM building:part ways): two tall spires taper, and the model verifies clean', () => {
    // The part ways only: an outline as tall as its parts hides them in massing (see the SPIRE report).
    const overpass = FIX('cologne-spires');
    overpass.elements = overpass.elements.filter(e => e.tags?.['building:part'] !== undefined);
    const site = siteFromOverpass(overpass as never, NOW);
    const massed = buildMassing(site.site, { roles: site.roles, scale: { target: 1 } });
    const fs = buildFeatureSet({ site: site.site, massing: massed, sidecars: [], tagParts: tagPartsFromOverpass(overpass.elements as never) });
    const g = buildGrammarModel(massed.massing, fs.set);
    expect(isClean(g.report)).toBe(true);
    expect(g.report.components).toBe(1);
    expect(g.stats.roofs['spire'] ?? 0).toBeGreaterThanOrEqual(2);
    const tall = massed.massing.volumes.filter(v => v.roof.shape === 'pyramidal' && (v.roof.pitchDeg ?? 0) >= 70 && v.topM > 100);
    expect(tall.length).toBeGreaterThanOrEqual(2);
    // The tallest layer count over the walls: a stepped column, not one stick.
    const [W, H, D] = g.lattice.dims;
    const widths = new Set<number>();
    for (let p = Math.round(100 * massed.massing.scale.platesPerMetre); p < H; p++) {
      let n = 0;
      for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) if (g.lattice.cells[(p * D + z) * W + x]) n++;
      widths.add(n);
    }
    expect(widths.size).toBeGreaterThanOrEqual(8);
  }, 180_000);
});
