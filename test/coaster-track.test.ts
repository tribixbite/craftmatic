import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { COASTER_TRACK_ENDPOINT_TOLERANCE_LDU, COASTER_TRACK_MAX_SAMPLE_SPACING_LDU, coasterTrackProfile, extractCoasterTrackFragments, extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import { buildCoasterPath } from '../web/src/engine/coaster-path.js';

describe('measured coaster track profiles', () => {
  it('keeps 80564 embedded-mesh connector coordinates and its real lateral shift', () => {
    const profile = coasterTrackProfile('80564.dat')!;
    expect(profile.samples[0]).toEqual([-20.2, -40, -122.2]);
    expect(profile.samples.at(-1)).toEqual([19.8, -240, 89.72]);
    expect(profile.samples.at(-1)![0] - profile.samples[0]![0]).toBe(40);
  });

  it('uses connector-plane endpoints rather than geometry bounding boxes', () => {
    expect(coasterTrackProfile('25061.dat')!.samples[0]).toEqual([240, -32, 0]);
    expect(coasterTrackProfile('25061.dat')!.samples.at(-1)![2]).toBe(240);
    expect(coasterTrackProfile('26559.dat')!.railSamples[0]).toEqual([-10, 0, 0]);
    expect(coasterTrackProfile('26559.dat')!.railSamples.at(-1)).toEqual([310, 144, 0]);
    expect(coasterTrackProfile('26559.dat')!.railSamples).toContainEqual([39.5, 20.5, 0]);
    expect(coasterTrackProfile('26560.dat')!.railSamples).toContainEqual([50.5, -1.7, 0]);
  });

  it('preserves measured sloped terminal rail axes instead of flattening connector helpers', () => {
    const straightRamp = coasterTrackProfile('26561.dat')!.railSamples;
    expect(straightRamp[0]).toEqual([-10, 0, 0]);
    expect(straightRamp.at(-1)).toEqual([150, 144, 0]);
    const lowerTransition = coasterTrackProfile('26559.dat')!.railSamples;
    const start = lowerTransition[0]!, after = lowerTransition[1]!;
    expect((after[1] - start[1]) / (after[0] - start[0])).toBeCloseTo(.9, 2);

    // Exact adjacent placements from 10303: the straight 45-degree rail and
    // lower transition meet within .006 LDU and have opposing terminal axes.
    const extraction = extractCoasterTrackRoutes([
      { color: 191, x: 189.9978, y: -432, z: -179.9956, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26561.dat' },
      { color: 191, x: 350.0013, y: -288, z: -179.9969, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26559.dat' },
    ]);
    expect(extraction.graph.connections).toHaveLength(1);
    expect(extraction.routes[0]!.fragmentIds).toEqual(['26559:1', '26561:0']);
  });

  it('joins the real 10303 cut rail tips rather than their 32-LDU-away sleeper planes', () => {
    const extraction = extractCoasterTrackRoutes([
      { color: 191, x: 148.023138, y: -473.97964, z: -180.00192, rot: [.000345, -.999988, 0, -1, -.000345, 0, 0, 0, -.999988], part: '26559.dat' },
      { color: 191, x: 189.9978, y: -432, z: -179.9956, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26561.dat' },
    ]);
    expect(extraction.graph.connections).toHaveLength(1);
    expect(extraction.graph.connections[0]!.distance).toBeCloseTo(.0385, 2);
    expect(extraction.routes).toHaveLength(1);
    expect(() => buildCoasterPath(extraction.routes[0]!.points, false, extraction.routes[0]!.maxSegmentLengthLdu)).not.toThrow();
  });

  it('recognises the paired vertical 25061 quarter-turn from its measured outer rails', () => {
    const fragments = extractCoasterTrackFragments([
      { color: 191, x: -782.004656, y: -1584.0009, z: -83.993508, rot: [0, 0, .999988, -1, 0, 0, 0, -.999988, 0], part: '25061.dat' },
      { color: 191, x: -782.004956, y: -1584.0008, z: -115.993154, rot: [.999988, 0, 0, 0, 0, -1, 0, .999988, 0], part: '25061.dat' },
    ]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.id).toBe('25061-pair:0+1');
    expect(fragments[0]!.samples[0]).toEqual([-782.004656, -1872.0009, -99.99331600000001]);
    expect(fragments[0]!.samples.at(-1)).toEqual([-494.008112, -1584.0009, -99.99331600000001]);
    for (let index = 1; index < fragments[0]!.samples.length; index++) {
      const a = fragments[0]!.samples[index - 1]!, b = fragments[0]!.samples[index]!;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThanOrEqual(COASTER_TRACK_MAX_SAMPLE_SPACING_LDU);
    }
  });

  it('does not reinterpret stacked horizontal or ambiguous 25061 placements as a composite', () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(extractCoasterTrackFragments([
      { color: 16, x: 0, y: 0, z: 0, rot: identity, part: '25061.dat' },
      { color: 16, x: 0, y: 0, z: 32, rot: identity, part: '25061.dat' },
    ])).toHaveLength(2);

    const verticalA = { color: 191, x: -782.004656, y: -1584.0009, z: -83.993508, rot: [0, 0, .999988, -1, 0, 0, 0, -.999988, 0], part: '25061.dat' };
    const verticalB = { color: 191, x: -782.004956, y: -1584.0008, z: -115.993154, rot: [.999988, 0, 0, 0, 0, -1, 0, .999988, 0], part: '25061.dat' };
    const ambiguous = extractCoasterTrackFragments([verticalA, verticalB, { ...verticalB }]);
    expect(ambiguous).toHaveLength(3);
    expect(ambiguous.every(fragment => !fragment.id.startsWith('25061-pair:'))).toBe(true);
  });

  it('reproduces a measured 10303 loop-to-ramp seam within the explicit tolerance', () => {
    const fragments = extractCoasterTrackFragments([
      { color: 191, x: 473.989888, y: -906, z: -120.202338, rot: [0, .999988, 0, 0, 0, -1, -.999988, 0, 0], part: '80564.dat' },
      { color: 191, x: 321.991624, y: -474.00008, z: -100.00258, rot: [0, .999988, 0, -1, 0, 0, 0, 0, .999988], part: '26559.dat' },
    ], { isGeometryAvailable: () => true });
    const loopStart = fragments[0]!.samples[0]!;
    const rampEnd = fragments[1]!.samples.at(-1)!;
    const distance = Math.hypot(loopStart[0] - rampEnd[0], loopStart[1] - rampEnd[1], loopStart[2] - rampEnd[2]);
    expect(distance).toBeLessThan(COASTER_TRACK_ENDPOINT_TOLERANCE_LDU);
    expect(distance).toBeCloseTo(.2, 1);
  });

  it('applies the complete LDraw placement matrix and ignores unsupported parts', () => {
    const fragments = extractCoasterTrackFragments([
      { color: 16, x: 10, y: 20, z: 30, rot: [0, 0, 1, 0, 1, 0, -1, 0, 0], part: 'parts/80562.dat' },
      { color: 16, x: 0, y: 0, z: 0, part: '3001.dat' },
    ]);
    expect(fragments).toHaveLength(1);
    expect(fragments[0]!.samples[0]).toEqual([10, -12, 70]);
    expect(fragments[0]!.samples.at(-1)).toEqual([10, -12, -10]);
  });

  it('transforms a running-centre point directly through reflected Studio placements', () => {
    const [fragment] = extractCoasterTrackFragments([
      { color: 16, x: 0, y: 0, z: 0, rot: [-1, 0, 0, 0, 1, 0, 0, 0, 1], part: '80562.dat' },
    ]);
    expect(fragment!.samples[0]).toEqual([40, -32, 0]);
    expect(fragment!.samples.at(-1)).toEqual([-40, -32, 0]);
  });

  it('does not alias an unverified design id and rejects malformed rotations', () => {
    expect(coasterTrackProfile('bl_80564.dat')).toBeUndefined();
    expect(() => extractCoasterTrackFragments([{ color: 16, x: 0, y: 0, z: 0, rot: [1], part: '80562.dat' }])).toThrow('expected 9');
  });

  it('withholds 80564 unless its source-local geometry is proven available', () => {
    const brick = { color: 191, x: 0, y: 0, z: 0, part: '80564.dat' };
    const missing = extractCoasterTrackRoutes([brick]);
    expect(missing.fragments).toEqual([]);
    expect(missing.unavailablePartIds).toEqual(['80564:0']);
    expect(missing.warnings.at(-1)).toContain('lack proven geometry');
    expect(extractCoasterTrackFragments([brick], { isGeometryAvailable: id => id === '80564' })).toHaveLength(1);
  });

  it('keeps the sample-spacing guard explicit and orders only connected moulds', () => {
    for (const id of ['25059', '25061', '26022', '26559', '26560', '26561', '34738', '80562', '80564', '80566']) {
      const samples = coasterTrackProfile(id)!.samples;
      for (let index = 1; index < samples.length; index++) {
        const a = samples[index - 1]!, b = samples[index]!;
        expect(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])).toBeLessThanOrEqual(COASTER_TRACK_MAX_SAMPLE_SPACING_LDU);
      }
    }
    const extraction = extractCoasterTrackRoutes([
      { color: 16, x: 0, y: 0, z: 0, part: '80562.dat' },
      { color: 16, x: 80, y: 0, z: 0, part: '80562.dat' },
      { color: 16, x: 1_000, y: 0, z: 0, part: '80562.dat' },
    ]);
    expect(extraction.routes).toHaveLength(1);
    expect(extraction.routes[0]).toMatchObject({ closed: false, fragmentIds: ['80562:0', '80562:1'], maxSegmentLengthLdu: 25 });
    expect(() => buildCoasterPath(extraction.routes[0]!.points, false, extraction.routes[0]!.maxSegmentLengthLdu)).not.toThrow();
    expect(extraction.warnings).toContain('Withheld isolated track mould 80562:2.');
    expect(extraction.warnings.at(-1)).toContain('remain open; no gap was bridged');
  });

  it('withholds a vertical straight-track guide without an authored transfer mechanism', () => {
    const vertical = [0, 1, 0, 1, 0, 0, 0, 0, 1];
    const extraction = extractCoasterTrackRoutes([
      { color: 16, x: 0, y: 0, z: 0, rot: vertical, part: '25059.dat' },
      { color: 16, x: 0, y: 320, z: 0, rot: vertical, part: '25059.dat' },
    ]);
    expect(extraction.routes).toEqual([]);
    expect(extraction.warnings).toContain('Withheld vertical guide/lift (25059:0, 25059:1): vertical guide/lift requires authored transfer mechanism.');
  });

  it('orders an exact four-quarter loop without duplicate seam vertices', () => {
    const rotations = [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0, 0, -1, 0, 1, 0, 1, 0, 0],
      [-1, 0, 0, 0, 1, 0, 0, 0, -1],
      [0, 0, 1, 0, 1, 0, -1, 0, 0],
    ];
    const extraction = extractCoasterTrackRoutes(rotations.map(rot => ({ color: 16, x: 0, y: 0, z: 0, rot, part: '25061.dat' })));
    expect(extraction.routes).toHaveLength(1);
    expect(extraction.routes[0]!.closed).toBe(true);
    const points = extraction.routes[0]!.points;
    expect(points[0]).toEqual(points.at(-1));
    expect(() => buildCoasterPath(points, true, extraction.routes[0]!.maxSegmentLengthLdu)).not.toThrow();
  });
});

/**
 * The published 10303 source is a real corpus file; skip where it is absent (CI).
 * These facts were established 2026-09-21 against the deployed render: the
 * lift is a brick-built 4.1-degree platform that rides the tower's front
 * column, NOT a track mould, so the course's high end hangs in mid-air at the
 * tower by design and the vertical 25059 stack is the counterweight's guide.
 */
const PUBLISHED_10303 = 'C:/git/clego/lego_sets/IOModel2V2/10303.ldr';
describe.skipIf(!existsSync(PUBLISHED_10303))('published 10303 route (real corpus file)', () => {
  const bricks = parseLDrawDocument(readFileSync(PUBLISHED_10303, 'utf8')).bricks;
  const extraction = extractCoasterTrackRoutes(bricks, { isGeometryAvailable: () => true });
  const near = (a: readonly number[], b: readonly number[], tolerance: number): boolean =>
    Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!) <= tolerance;

  it('places all 42 track moulds and orders the main course as one open chain', () => {
    expect(bricks.filter(brick => coasterTrackProfile(brick.part))).toHaveLength(42);
    expect(extraction.routes).toHaveLength(1);
    const [course] = extraction.routes;
    expect(course!.closed).toBe(false);
    expect(course!.fragmentIds).toHaveLength(29);
    // Station end (cars roll downhill toward the tower onto the platform).
    expect(near(course!.points[0]!, [-382.41, -156.44, -580], .05)).toBe(true);
    // High end: the 80566 tip where the raised platform hands the cars over.
    expect(near(course!.points.at(-1)!, [-781.8, -2014.26, -579.71], .05)).toBe(true);
  });

  it('withholds the seven-piece vertical guide and the five canopy moulds, bridging nothing', () => {
    const guide = extraction.warnings.find(warning => warning.startsWith('Withheld vertical guide/lift'));
    expect(guide).toBeDefined();
    expect(guide!.match(/25059:\d+/g)).toHaveLength(7);
    expect(extraction.warnings.filter(warning => warning.startsWith('Withheld isolated track mould'))).toHaveLength(5);
    expect(extraction.graph.gaps).toHaveLength(14);
  });

  it('has no track mould at the hand-off point: the platform, not a missing piece, closes the lift', () => {
    const handOff = [-781.8, -2014.26, -579.71] as const;
    // The only track connector within 200 LDU of the tip is the tip itself; the
    // nearest other connector (the guide's top, 25059:2352:end) is ~443 LDU away.
    const connectorsWithinReach = extraction.graph.endpoints
      .filter(endpoint => near(endpoint.point, handOff, 200))
      .map(endpoint => endpoint.key);
    expect(connectorsWithinReach).toEqual(['80566:2474:end']);
    // Elevator platform: every member carries the same 4.1-degree tilt about Z at the tower base.
    const platform = bricks.filter(brick => brick.rot && Math.abs(Math.abs(brick.rot[1]!) - .0715) < .002 && Math.abs(brick.rot[8]!) > .9);
    expect(platform.length).toBe(42);
    expect(Math.min(...platform.map(brick => brick.x))).toBeCloseTo(-759.4, 0);
    expect(Math.max(...platform.map(brick => brick.y))).toBeCloseTo(-83.9, 0);
  });
});
