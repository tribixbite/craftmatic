import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLDrawDocument } from '../web/src/engine/ldraw-parser.js';
import { COASTER_RUNNING_ABOVE_RAIL_TOP_LDU, COASTER_TRACK_DUPLICATE_EPSILON_LDU, COASTER_TRACK_ENDPOINT_TOLERANCE_LDU, COASTER_TRACK_MAX_SAMPLE_SPACING_LDU, COASTER_TRACK_OVERLAP_TOLERANCE_LDU, coasterTrackProfile, extractCoasterTrackFragments, extractCoasterTrackRoutes } from '../web/src/engine/coaster-track.js';
import { buildCoasterPath, stitchCoasterTrackFragments, type CoasterVec3 } from '../web/src/engine/coaster-path.js';
import { LDU_PER_BLOCK } from '../web/src/engine/lego-scale.js';

const distanceLdu = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const polylineLengthLdu = (points: readonly CoasterVec3[]): number => points.slice(1).reduce((sum, point, index) => sum + distanceLdu(points[index]!, point), 0);

/**
 * Smallest straight-line distance between two points `pitch` apart along the
 * polyline's arc, scanned at 1 LDU steps. This is what keeps a train's cars
 * from intersecting: two cars 2.25 blocks apart on the arc must never be
 * closer than a car length.
 */
function minimumChordLdu(points: readonly CoasterVec3[], pitch: number): number {
  const cumulative = [0];
  for (let index = 1; index < points.length; index++) cumulative.push(cumulative[index - 1]! + distanceLdu(points[index - 1]!, points[index]!));
  const at = (arc: number): CoasterVec3 => {
    let segment = 0;
    while (segment < cumulative.length - 2 && cumulative[segment + 1]! < arc) segment++;
    const t = (arc - cumulative[segment]!) / (cumulative[segment + 1]! - cumulative[segment]!);
    const a = points[segment]!, b = points[segment + 1]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  let minimum = Number.POSITIVE_INFINITY;
  for (let arc = 0; arc + pitch <= cumulative.at(-1)!; arc += 1) minimum = Math.min(minimum, distanceLdu(at(arc), at(arc + pitch)));
  return minimum;
}

describe('measured coaster track profiles', () => {
  it('keeps 80564 embedded-mesh connector coordinates and its real lateral shift', () => {
    const profile = coasterTrackProfile('80564.dat')!;
    expect(profile.samples[0]).toEqual([-20.2, -40, -122.2]);
    // B end: base-plate datum z=109.8 on the y=-240 plane (radius 232 about the
    // sweep centre y=-240, z=-122.2), running line 32 LDU inward at z=77.8.
    // The earlier 89.72 came from the tail stud's tip (117.72 + 4), which is
    // 11.9 LDU outside the mesh.
    expect(profile.railSamples.at(-1)).toEqual([19.8, -240, 109.8]);
    const end = profile.samples.at(-1)!;
    expect(end[0]).toBe(19.8);
    expect(end[1]).toBeCloseTo(-240, 9);
    expect(end[2]).toBeCloseTo(77.8, 9);
    expect(end[0] - profile.samples[0]![0]).toBe(40);
  });

  it('keeps the 80564 running line a fold-free circle of radius 200 about its measured sweep centre', () => {
    const profile = coasterTrackProfile('80564.dat')!;
    const centreY = -240, centreZ = -122.2;
    // Every running sample sits on the radius-200 ring (the 5 LDU connector
    // stubs are tangent lines, .05 LDU outside it); every rail sample on the
    // radius-232 base-plate datum ring.
    for (const sample of profile.samples) expect(Math.hypot(sample[1] - centreY, sample[2] - centreZ)).toBeCloseTo(200, 0);
    for (const sample of profile.railSamples) expect(Math.hypot(sample[1] - centreY, sample[2] - centreZ)).toBeCloseTo(232, 0);
    // The sweep angle must be strictly monotone from the A connector (+Z) to
    // the B connector (-Y): a running sample that doubles back is the fold
    // that reversed 10303's cart three times per loop and stacked the train.
    const angles = profile.samples.map(sample => Math.atan2(sample[2] - centreZ, sample[1] - centreY));
    for (let index = 1; index < angles.length; index++) expect(angles[index]!).toBeGreaterThan(angles[index - 1]!);
    expect(angles[0]).toBeCloseTo(0, 6);
    expect(angles.at(-1)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('uses connector-plane endpoints rather than geometry bounding boxes', () => {
    expect(coasterTrackProfile('25061.dat')!.samples[0]).toEqual([240, -32, 0]);
    expect(coasterTrackProfile('25061.dat')!.samples.at(-1)![2]).toBe(240);
    // A ramp's topology datum is its ray-cast rail top: at 26559's sloped tip
    // the rail line reaches the x = -10 plane at -35.96 (the 5 LDU end relief
    // reads -33.51 and is bridged by the wheel); at its level end the top is
    // the straights' -17.8 below the 144 clip plane.
    expect(coasterTrackProfile('26559.dat')!.railSamples[0]).toEqual([-10, -35.96, 0]);
    expect(coasterTrackProfile('26559.dat')!.railSamples.at(-1)).toEqual([310, 126.2, 0]);
    expect(coasterTrackProfile('26559.dat')!.railSamples).toContainEqual([40, 7.11, 0]);
    expect(coasterTrackProfile('26560.dat')!.railSamples).toContainEqual([50, -13.4, 0]);
  });

  it('keeps every running line one measured clearance above its rail top', () => {
    // The straights: rail top -17.8, running line -32, on the level.
    expect(COASTER_RUNNING_ABOVE_RAIL_TOP_LDU).toBe(14.2);
    expect(coasterTrackProfile('80562.dat')!.samples[0]).toEqual([-40, -32, 0]);
    // A ramp's level end reproduces that to the rail's residual gradient at
    // the plane: 26560's rail already climbs .052 per LDU at x = -10 (-17.8 to
    // -17.54 over the first 5) and 26559's .038 at x = 310, so the clearance
    // tilts with it (.74 and .54 LDU along x, .02 and .01 short in y).
    expect(coasterTrackProfile('26560.dat')!.samples[0]![1]).toBeCloseTo(-17.8 - 14.2 * 5 / Math.hypot(5, .26), 6);
    expect(coasterTrackProfile('26560.dat')!.samples[0]![0]).toBeCloseTo(-10 + 14.2 * .26 / Math.hypot(5, .26), 6);
    const lowerEnd = coasterTrackProfile('26559.dat')!.samples.at(-1)!;
    expect(lowerEnd[1]).toBeCloseTo(126.2 - 14.2 * 5 / Math.hypot(5, .19), 6);
    expect(lowerEnd[0]).toBeCloseTo(310 + 14.2 * .19 / Math.hypot(5, .19), 6);
    // On the slope the clearance is perpendicular: 26561's rail rises .902 per
    // LDU, so every running sample sits 14.2 from the rail line, never the
    // 3.9 LDU BELOW it the old sleeper-plane connector controls produced.
    const straight = coasterTrackProfile('26561.dat')!;
    const [x0, y0] = straight.railSamples[0]!, [x1, y1] = straight.railSamples.at(-1)!;
    const gradient = (y1 - y0) / (x1 - x0);
    expect(gradient).toBeCloseTo(.902, 3);
    for (const sample of straight.samples) {
      const clearance = Math.abs(gradient * (sample[0] - x0) - (sample[1] - y0)) / Math.hypot(gradient, 1);
      expect(clearance).toBeCloseTo(COASTER_RUNNING_ABOVE_RAIL_TOP_LDU, 1);
      expect(sample[1]).toBeLessThan(y0 + gradient * (sample[0] - x0));
    }
    // Every ramp sample is offset exactly the clearance from its rail-top
    // control, and the vertical share of that is 14.2 / sqrt(1 + m^2): the
    // full 14.2 on the level, never under the 10.5 of the steepest (.902) rail.
    for (const id of ['26559', '26560', '26561', '34738']) {
      const profile = coasterTrackProfile(id)!;
      profile.samples.forEach((sample, index) => {
        const rail = profile.railSamples[index]!;
        expect(Math.hypot(sample[0] - rail[0], sample[1] - rail[1])).toBeCloseTo(COASTER_RUNNING_ABOVE_RAIL_TOP_LDU, 6);
        expect(rail[1] - sample[1]).toBeGreaterThan(14.2 / Math.hypot(1, .902) - .01);
        expect(rail[1] - sample[1]).toBeLessThanOrEqual(COASTER_RUNNING_ABOVE_RAIL_TOP_LDU);
      });
    }
  });

  it('preserves measured sloped terminal rail axes instead of flattening connector helpers', () => {
    const straightRamp = coasterTrackProfile('26561.dat')!.railSamples;
    expect(straightRamp[0]).toEqual([-10, -36.16, 0]);
    expect(straightRamp.at(-1)).toEqual([150, 108.13, 0]);
    // 26559's sloped tip is a .856 gradient (40.6 degrees), the straight .902
    // (42.0): the modelled rails are not 45 degrees, and the 1.4 degree kink
    // at a clip-mated seam is theirs.
    const lowerTransition = coasterTrackProfile('26559.dat')!.railSamples;
    const start = lowerTransition[0]!, after = lowerTransition[1]!;
    expect((after[1] - start[1]) / (after[0] - start[0])).toBeCloseTo(.856, 2);
    const upperTransition = coasterTrackProfile('26560.dat')!.railSamples;
    const before = upperTransition.at(-2)!, end = upperTransition.at(-1)!;
    expect((end[1] - before[1]) / (end[0] - before[0])).toBeCloseTo(.852, 2);

    // Exact adjacent placements from 10303: the straight rail and the lower
    // transition are clip-mated, so their running lines meet within .43 LDU
    // (14.2 LDU of clearance across that 1.4 degree kink) with opposing axes.
    const extraction = extractCoasterTrackRoutes([
      { color: 191, x: 189.9978, y: -432, z: -179.9956, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26561.dat' },
      { color: 191, x: 350.0013, y: -288, z: -179.9969, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26559.dat' },
    ]);
    expect(extraction.graph.connections).toHaveLength(1);
    expect(extraction.graph.connections[0]!.distance).toBeCloseTo(.43, 2);
    expect(extraction.routes[0]!.fragmentIds).toEqual(['26559:1', '26561:0']);
  });

  it('joins a rotated 26559 whose rail overlaps the straight longitudinally, and drops the doubly measured rail', () => {
    // 10303's vertical-drop pull-out: this 26559 stands rotated 90 degrees and
    // is not clip-mated to the straight. Its rail runs 7.66 LDU past the
    // straight's tip along the travel direction, laterally within .08 LDU, at
    // a 7.6 degree kink. The old sleeper-plane tips matched to .04 LDU only
    // because both sat 4 LDU inside the rail on axes 90 degrees apart.
    const extraction = extractCoasterTrackRoutes([
      { color: 191, x: 148.023138, y: -473.97964, z: -180.00192, rot: [.000345, -.999988, 0, -1, -.000345, 0, 0, 0, -.999988], part: '26559.dat' },
      { color: 191, x: 189.9978, y: -432, z: -179.9956, rot: [.999988, 0, 0, 0, 1, 0, 0, 0, .999988], part: '26561.dat' },
    ]);
    expect(extraction.graph.connections).toHaveLength(1);
    const [seam] = extraction.graph.connections;
    expect(seam!.distance).toBeCloseTo(7.663, 2);
    expect(seam!.distance).toBeLessThanOrEqual(COASTER_TRACK_OVERLAP_TOLERANCE_LDU);
    expect(seam!.tangentDot).toBeCloseTo(Math.cos(7.6 * Math.PI / 180), 2);
    expect(extraction.routes).toHaveLength(1);
    const { points } = extraction.routes[0]!;
    // Two of the incoming mould's leading samples lie behind the straight's
    // tip and are dropped, so the route never steps backwards over the overlap.
    const sampleTotal = extraction.fragments.reduce((sum, fragment) => sum + fragment.samples.length, 0);
    expect(sampleTotal - points.length).toBe(2);
    for (let index = 2; index < points.length; index++) {
      const a = points[index - 2]!, b = points[index - 1]!, c = points[index]!;
      expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2])).toBeGreaterThan(0);
    }
    expect(() => buildCoasterPath(points, false, extraction.routes[0]!.maxSegmentLengthLdu)).not.toThrow();
    // Without the overlap admission the two are a gap, never a nearest-point bridge.
    const strict = stitchCoasterTrackFragments(extraction.fragments, { endpointToleranceLdu: COASTER_TRACK_ENDPOINT_TOLERANCE_LDU, minTangentDot: .97 });
    expect(strict.connections).toEqual([]);
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
    // The placements overlap by .2 LDU; the ramp's level end adds the .54 LDU
    // its rail's residual .038 gradient carries the clearance past the plane.
    expect(distance).toBeCloseTo(.74, 2);
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

  it('keeps 10303\'s four-quarter 80564 helix free of reversals and clears a 1.25-block car at 2.25-block pitch', () => {
    // The four 80564 placements of 10303's first loop, verbatim from the
    // published source. Studio overlaps the quarters by .8 LDU (615.2 - 136 =
    // 479.2 against 2 x 240), so every seam is a backward step unless the
    // matched connector is represented once.
    const extraction = extractCoasterTrackRoutes([
      { color: 191, x: 781.996236, y: -615.2001, z: -239.796432, rot: [0, 0, .999988, 0, -1, 0, .999988, 0, 0], part: '80564.dat' },
      { color: 191, x: 537.999064, y: -615.2001, z: -280.195998, rot: [0, 0, -.999988, 0, -1, 0, -.999988, 0, 0], part: '80564.dat' },
      { color: 191, x: 537.998864, y: -136.0001, z: -319.795642, rot: [0, 0, -.999988, 0, 1, 0, .999988, 0, .000001], part: '80564.dat' },
      { color: 191, x: 781.996236, y: -136, z: -200.196738, rot: [-.000001, 0, .999988, 0, 1, 0, -.999988, 0, -.000001], part: '80564.dat' },
    ], { isGeometryAvailable: () => true });
    expect(extraction.graph.connections).toHaveLength(3);
    expect(extraction.routes).toHaveLength(1);
    const { points, closed, maxSegmentLengthLdu } = extraction.routes[0]!;
    expect(closed).toBe(false);
    // One vertex per matched connector: 4 x 33 samples minus 3 merged seams.
    expect(points).toHaveLength(4 * 33 - 3);
    // The running line is a radius-200 helix about the loop axis (x 660,
    // y -375.6): the lower pair turns about y -376 and the upper about -375.2
    // because of that .8 LDU overlap, and 20 LDU chords sag .25, so 1 LDU.
    for (const point of points) expect(Math.abs(Math.hypot(point[0] - 660, point[1] + 375.6) - 200)).toBeLessThan(1);
    // No consecutive segments may oppose each other, and none may turn past 90 degrees.
    for (let index = 2; index < points.length; index++) {
      const a = points[index - 2]!, b = points[index - 1]!, c = points[index]!;
      expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2])).toBeGreaterThan(0);
    }
    expect(minimumChordLdu(points, 2.25 * LDU_PER_BLOCK)).toBeGreaterThan(1.25 * LDU_PER_BLOCK);
    expect(() => buildCoasterPath(points, false, maxSegmentLengthLdu)).not.toThrow();
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
  // `describe.skipIf` still EXECUTES this body to register the skipped tests,
  // so the corpus read must be guarded or CI (no clego checkout) dies here.
  const bricks = existsSync(PUBLISHED_10303) ? parseLDrawDocument(readFileSync(PUBLISHED_10303, 'utf8')).bricks : [];
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

  it('never doubles back and keeps a 1.25-block car clear at 2.25-block pitch everywhere', () => {
    const [course] = extraction.routes;
    const { points } = course!;
    // Measured 2026-09-21 at 53.333 LDU/block: the floor was 7.9 LDU (.148
    // blocks, three folds per 80564 loop), then 108.1 with the loops rebuilt,
    // and is 117.5 LDU (2.20 blocks) with the ramps on the rail-top datum.
    // COASTER_CAR_LENGTH in bedrock-coaster.ts is 1.25 blocks.
    const floor = minimumChordLdu(points, 2.25 * LDU_PER_BLOCK);
    expect(floor).toBeGreaterThan(1.25 * LDU_PER_BLOCK);
    expect(floor).toBeGreaterThan(115);
    // No reversal anywhere: consecutive segments never oppose. The sharpest
    // vertex was the 64.6-degree wiggle the sleeper-plane connector controls
    // put at every 26559 sloped end; it is now the 23.5-degree turn where the
    // rotated 26559:1429 meets its loop 1.34 LDU off-line (a set placement).
    let sharpest = 0;
    for (let index = 2; index < points.length; index++) {
      const a = points[index - 2]!, b = points[index - 1]!, c = points[index]!;
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) + (b[2] - a[2]) * (c[2] - b[2]);
      expect(dot).toBeGreaterThan(0);
      const cosine = Math.max(-1, Math.min(1, dot / (distanceLdu(a, b) * distanceLdu(b, c))));
      sharpest = Math.max(sharpest, Math.acos(cosine) * 180 / Math.PI);
    }
    expect(sharpest).toBeLessThan(25);
    for (let index = 1; index < points.length; index++) {
      const spacing = distanceLdu(points[index - 1]!, points[index]!);
      expect(spacing).toBeGreaterThan(COASTER_TRACK_DUPLICATE_EPSILON_LDU);
      expect(spacing).toBeLessThanOrEqual(COASTER_TRACK_MAX_SAMPLE_SPACING_LDU);
    }
    expect(() => buildCoasterPath(points, false, course!.maxSegmentLengthLdu)).not.toThrow();
  });

  it('represents each of its 28 matched connectors once, drops the three rail overlaps, and keeps the measured length', () => {
    const [course] = extraction.routes;
    const byId = new Map(extraction.fragments.map(fragment => [fragment.id, fragment]));
    // 29 moulds' running lines summed with no seam chords at all.
    const fragmentSum = course!.fragmentIds.reduce((sum, id) => sum + polylineLengthLdu(byId.get(id)!.samples), 0);
    const routeLength = polylineLengthLdu(course!.points);
    // Was 9327.185 LDU with the folds and 34 duplicated seam vertices (1066
    // points), then 8930.513 (1012) with the loops on one datum; the ramps on
    // the rail-top datum shed the 23 LDU the three rotated 26559s overlap
    // their neighbours by, and the 45-degree straights are 23 LDU higher.
    expect(course!.points).toHaveLength(990);
    expect(routeLength).toBeCloseTo(8905.855, 2);
    // Merging a connector's two measurements changes the length by less than
    // the endpoint tolerance per seam, and each of the three rotated seams
    // drops up to one rail overlap: measured net -27.50 LDU (28 seams -1.1,
    // three overlaps of 7.66-7.80 and the level-end shifts the rest).
    expect(Math.abs(routeLength - fragmentSum)).toBeLessThan(28 * COASTER_TRACK_ENDPOINT_TOLERANCE_LDU + 3 * COASTER_TRACK_OVERLAP_TOLERANCE_LDU);
    expect(routeLength - fragmentSum).toBeCloseTo(-27.5, 1);
    const sampleTotal = course!.fragmentIds.reduce((sum, id) => sum + byId.get(id)!.samples.length, 0);
    // 28 connectors represented once plus one overlapped sample at each of the three rotated seams.
    expect(sampleTotal - course!.points.length).toBe(31);
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

describe('OMR/MPD embedded part names', () => {
  it("strips a leading '<set> - ' from an embedded mould stem, so the index's OMR sources extract at all", () => {
    // 10261-1.mpd embeds its unofficial track as `0 FILE 10261 - 25061.dat` and
    // references it by that name; the set prefix is not part of the mould id.
    expect(coasterTrackProfile('10261 - 25061.dat')).toBe(coasterTrackProfile('25061.dat'));
    expect(coasterTrackProfile('10261-1 - 26559.dat')).toBe(coasterTrackProfile('26559.dat'));
    expect(coasterTrackProfile('models/10303 - 80564.dat')?.partId).toBe('80564');
    // A bare mould id, a path, and an unrelated name are untouched.
    expect(coasterTrackProfile('s/25061.dat')).toBe(coasterTrackProfile('25061.dat'));
    expect(coasterTrackProfile('3001.dat')).toBeUndefined();
    const extraction = extractCoasterTrackRoutes([
      { color: 4, x: 0, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], part: '10261 - 80562.dat' },
      { color: 4, x: 80, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], part: '10261 - 80562.dat' },
    ], { isGeometryAvailable: () => true });
    expect(extraction.routes).toHaveLength(1);
    expect(extraction.routes[0]!.fragmentIds).toEqual(['80562:0', '80562:1']);
  });
});

const OMR_10261 = 'C:/git/clego/lego_sets/OMR/10261-1.mpd';
describe.skipIf(!existsSync(OMR_10261))('10261-1.mpd (OMR source, embedded track parts)', () => {
  it('extracts the circuit from parts named `10261 - <mould>.dat`', () => {
    const doc = parseLDrawDocument(readFileSync(OMR_10261, 'utf8'));
    const named = doc.bricks.filter(b => /^10261 - \d+\.dat$/i.test(b.part));
    expect(named.length).toBeGreaterThan(0);
    const extraction = extractCoasterTrackRoutes(doc.bricks, { isGeometryAvailable: () => true });
    expect(extraction.fragments.length).toBeGreaterThan(30);
    expect(extraction.routes.length).toBeGreaterThan(0);
    expect(Math.max(...extraction.routes.map(r => r.points.length))).toBeGreaterThan(500);
  });
});
