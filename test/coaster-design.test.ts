import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCoasterRoute } from '../web/src/engine/coaster-path';
import { generateCoaster, type CoasterDesign, type CoasterElement } from '../web/src/engine/coaster-design';

const limits = { maxSpeedBps: 52, gVertical: [-1, 4.5] as [number, number], gLateral: 1.5, maxJerk: 40 };
const design = (elements: CoasterElement[], over: Partial<CoasterDesign> = {}): CoasterDesign =>
  ({ name: 't', elements, heartlineB: 0.8, trains: 1, carsPerTrain: 3, limits, shows: [], ...over });

const basic: CoasterElement[] = [
  { kind: 'station', lengthB: 10 },
  { kind: 'chain-lift', riseB: 60, angleDeg: 45, speedBps: 4 },
  { kind: 'drop', fallB: 90, angleDeg: 70 },
  { kind: 'loop', radiusB: 9 },
  { kind: 'block-brake', lengthB: 90, toSpeedBps: 4 },
];
const sub = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe('coaster-design', () => {
  it('a station-lift-drop-loop-brake circuit closes with continuous position, tangent and up', () => {
    const gen = generateCoaster(design(basic));
    const pts = gen.route.points, n = pts.length;
    expect(n).toBeGreaterThan(100);
    const route = createCoasterRoute(gen.route); // throws unless closed with an exact repeated seam
    expect(route.length).toBeGreaterThan(100);
    expect(gen.ups.length).toBe(n);
    expect(sub(pts[0]!, pts[n - 1]!)).toBeLessThan(1e-9);
    const tan = (i: number, j: number) => { const d = [0, 1, 2].map(k => pts[j]![k]! - pts[i]![k]!); const l = Math.hypot(...d); return d.map(x => x / l); };
    const tIn = tan(n - 3, n - 2), tOut = tan(0, 1);
    expect(sub(tIn, tOut)).toBeLessThan(0.02);
    expect(sub(gen.ups[0]!, gen.ups[n - 1]!)).toBeLessThan(1e-6);
    expect(sub(gen.ups[n - 2]!, gen.ups[0]!)).toBeLessThan(0.02);
    for (const u of gen.ups) expect(Math.hypot(...u)).toBeCloseTo(1, 6);
  });

  it('a loop of radius r reports one inversion', () => {
    expect(generateCoaster(design(basic)).report.inversions).toBe(1);
    expect(generateCoaster(design(basic.filter(e => e.kind !== 'loop'))).report.inversions).toBe(0);
  });

  it("an airtime hill's crest g is below 0", () => {
    const gen = generateCoaster(design([
      ...basic.slice(0, 3), { kind: 'airtime-hill', riseB: 6, lengthB: 60 }, basic[4]!]));
    expect(gen.spans.find(s => s.kind === 'airtime-hill')!.minG).toBeLessThan(0);
  });

  it('consecutive samples are at most 0.4 blocks apart', () => {
    const pts = generateCoaster(design(basic)).route.points;
    for (let i = 1; i < pts.length; i++) expect(sub(pts[i]!, pts[i - 1]!)).toBeLessThanOrEqual(0.4);
  });

  it('the report of the 3x sketch exceeds 10303 on every axis (length >= 545, height >= 132, longest footprint axis >= 120, inversions >= 6)', () => {
    const sketch = JSON.parse(readFileSync('test/fixtures/coaster/3x-sketch.json', 'utf8')) as CoasterDesign;
    const r = generateCoaster(sketch).report;
    expect(r.lengthB).toBeGreaterThanOrEqual(545);
    expect(r.heightB).toBeGreaterThanOrEqual(132);
    expect(Math.max(...r.footprintB)).toBeGreaterThanOrEqual(120);
    expect(r.inversions).toBeGreaterThanOrEqual(6);
  });

  it('a design above world height is refused', () => {
    const tall = design([{ kind: 'station', lengthB: 10 }, { kind: 'chain-lift', riseB: 260, angleDeg: 50, speedBps: 4 },
      { kind: 'drop', fallB: 260, angleDeg: 70 }, { kind: 'block-brake', lengthB: 40, toSpeedBps: 4 }]);
    expect(() => generateCoaster(tall)).toThrow(/world height/);
  });

  it('lateral g above 1.5 in an unbanked turn is refused', () => {
    const els: CoasterElement[] = [...basic.slice(0, 3), { kind: 'turn', radiusB: 20, angleDeg: 90, bankDeg: 0 }, basic[4]!];
    expect(() => generateCoaster(design(els))).toThrow(/lateral/);
    const banked = els.map(e => e.kind === 'turn' ? { ...e, bankDeg: undefined } : e);
    expect(() => generateCoaster(design(banked))).not.toThrow();
  });

  it('a design with no station first is refused', () => {
    expect(() => generateCoaster(design(basic.slice(1)))).toThrow(/station/);
  });
});
