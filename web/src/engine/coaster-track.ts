/**
 * Measured LEGO roller-coaster track centrelines in each mould's LDraw frame.
 *
 * End points come from the connector planes in the real LDraw/Studio meshes,
 * not from part bounding boxes. Curved interiors are sampled densely enough
 * for ride motion; graph connectivity is decided only at these measured ends.
 */
import type { ParsedBrick } from './ldraw-parser.js';
import {
  stitchCoasterTrackFragments,
  type CoasterTrackFragment,
  type CoasterTrackGraph,
  type CoasterVec3,
} from './coaster-path.js';

export interface CoasterTrackProfile {
  /** Canonical LDraw stem (without `.dat`). */
  partId: string;
  /** Ordered centreline in the part's local LDraw frame. */
  samples: readonly CoasterVec3[];
  /** Rail-datum samples used to preserve the running side through mirrored Studio transforms. */
  railSamples: readonly CoasterVec3[];
  /** 80564 has no upstream LDraw DAT and must be proven present in its source MPD. */
  geometry: 'library' | 'embedded';
}

/** Covers the largest measured physical running-line seam in 10303 (2.941 LDU). */
export const COASTER_TRACK_ENDPOINT_TOLERANCE_LDU = 3;
/**
 * Covers the largest measured longitudinal rail overlap in 10303 (7.797 LDU):
 * its three 26559s that stand rotated 90 degrees (the vertical drop's
 * pull-outs, `26559:1429`, `1421`, `2153`) are not clip-mated to the 26561
 * and 26559 sloped ends they continue; Studio placed them so the rails run
 * 7.7-7.8 LDU past each other's tips, laterally within .08 LDU, at a 7.6-8.9
 * degree kink (the modelled rails are 40.6 and 42.0 degrees, not 45). The
 * doubly measured rail is dropped once, like a matched connector.
 */
export const COASTER_TRACK_OVERLAP_TOLERANCE_LDU = 8;
/** All authored neighbouring samples are at most this far apart. */
export const COASTER_TRACK_MAX_SAMPLE_SPACING_LDU = 25;
/**
 * Adjacent route vertices closer than this collapse into one. It absorbs the
 * .01 LDU rail-axis probes inside the ramp profiles and the sub-.04 LDU seam
 * mismatch between two moulds' running lines (Studio's .999988 rotations), so
 * the runtime never sees a segment whose direction is numerical noise. The
 * smallest real running-line seam step in 10303 is .2 LDU and the largest
 * 2.94 LDU, so no physical seam is merged. Each removed vertex changes the
 * route length by at most this much; both route endpoints are kept exactly.
 */
export const COASTER_TRACK_DUPLICATE_EPSILON_LDU = .05;

export interface CoasterTrackRouteLdu {
  label: string;
  points: readonly CoasterVec3[];
  closed: boolean;
  fragmentIds: readonly string[];
  maxSegmentLengthLdu: number;
}

export interface CoasterTrackExtraction {
  fragments: readonly CoasterTrackFragment[];
  graph: CoasterTrackGraph;
  /** Connected routes only; isolated decorative moulds are deliberately withheld. */
  routes: readonly CoasterTrackRouteLdu[];
  warnings: readonly string[];
  unavailablePartIds: readonly string[];
}

export interface CoasterTrackExtractionOptions {
  /** Renderer/provider evidence for the exact placed mould; false always withholds it. */
  isGeometryAvailable?: (partId: string, brick: ParsedBrick) => boolean;
}

const STEPS = 16;
const line = (a: CoasterVec3, b: CoasterVec3, steps = STEPS): CoasterVec3[] =>
  Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as const;
  });

/** Shape-preserving cubic interpolation through DAT-authored rail/sleeper centres. */
function pchip(
  control: readonly (readonly [number, number])[], x: number,
  endpointSlopes: readonly [start: number, end: number] = [0, 0],
): number {
  const n = control.length;
  if (n < 2) throw new Error('Track profile needs at least two measured controls.');
  const h = Array.from({ length: n - 1 }, (_, i) => control[i + 1]![0] - control[i]![0]);
  const delta = h.map((span, i) => (control[i + 1]![1] - control[i]![1]) / span);
  const slope = new Array<number>(n);
  slope[0] = endpointSlopes[0];
  slope[n - 1] = endpointSlopes[1];
  for (let i = 1; i < n - 1; i++) {
    const left = delta[i - 1]!, right = delta[i]!;
    if (left === 0 || right === 0 || Math.sign(left) !== Math.sign(right)) slope[i] = 0;
    else {
      const w1 = 2 * h[i]! + h[i - 1]!, w2 = h[i]! + 2 * h[i - 1]!;
      slope[i] = (w1 + w2) / (w1 / left + w2 / right);
    }
  }
  let i = 0;
  while (i + 1 < n - 1 && x > control[i + 1]![0]) i++;
  const t = (x - control[i]![0]) / h[i]!;
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * control[i]![1]
    + (t3 - 2 * t2 + t) * h[i]! * slope[i]!
    + (-2 * t3 + 3 * t2) * control[i + 1]![1]
    + (t3 - t2) * h[i]! * slope[i + 1]!;
}

/**
 * The running datum sits this far above the rail top, measured perpendicular
 * to the rail: on every straight mould the tread surface the 24869 wheels
 * ride is at y -17.8 and the sleeper-plane running line at -32 (this is the
 * 14 LDU `measureDatumAboveRailTop` finds on a placed straight). It is the
 * one datum every mould's running line is built on; a ramp's line is the
 * rail-top curve offset by this much along its local normal, so on a slope
 * of gradient m the vertical clearance is 14.2 * sqrt(1 + m^2), exactly
 * where a wheel of that effective radius holds its axle.
 */
export const COASTER_RUNNING_ABOVE_RAIL_TOP_LDU = 14.2;

/** DAT sleeper controls sit 32 LDU below the measured inner rail corner. */
const offsetAbove = (samples: readonly CoasterVec3[]): CoasterVec3[] =>
  samples.map(point => [point[0], point[1] - 32, point[2]] as const);

/**
 * Offset a rail-top polyline in its X/Y plane by the running clearance along
 * the local up normal. The normal at a vertex bisects its two segments; at
 * either end it is the terminal segment's own, so the terminal sample is the
 * offset of the measured tip, not of an interpolated point.
 */
const offsetNormal = (railTop: readonly CoasterVec3[]): CoasterVec3[] =>
  railTop.map((point, index) => {
    const before = railTop[Math.max(0, index - 1)]!, after = railTop[Math.min(railTop.length - 1, index + 1)]!;
    const dx = after[0] - before[0], dy = after[1] - before[1], length = Math.hypot(dx, dy);
    if (length <= 0) throw new Error('Rail-top profile has a zero-length segment.');
    // Up in LDraw is -Y; the up normal of direction (dx, dy) is (dy, -dx).
    return [
      point[0] + COASTER_RUNNING_ABOVE_RAIL_TOP_LDU * dy / length,
      point[1] - COASTER_RUNNING_ABOVE_RAIL_TOP_LDU * dx / length,
      point[2],
    ] as const;
  });

/**
 * Rail-top heights (LDraw y) of the four ramp moulds at every 5 LDU of local
 * x from the x = -10 connector plane, ray-cast vertically at z 29..31 (the
 * flat of the tread band; the same to .005 LDU at -z) on the resolved meshes
 * of Studio's library (`UnOfficial/parts`, SHA-256 prefixes 26559 012a964d,
 * 26560 b88567ea, 26561 778dba6c, 34738 ef81b655, 2019-03 updates). The
 * official 2024-05 DATs (efb23c86, 06cdabdd, 1bb3395f, 277af786) moved only
 * the sleepers; their rails cast the same heights to .01 LDU from x = -5 on.
 *
 * The previous profiles were built on TWO datums: sleeper origins in the
 * interior (which on these moulds sit 11.5-13.8 LDU below the rail, not the
 * straights' 17.8) and hand-added connector controls on the sleeper-plane
 * datum at every end. The level ends were right to .01 LDU; every sloped
 * end put the running line 3.9 LDU BELOW the rail top instead of 18.6 above
 * it, so the whole of 26561 rode 23 LDU inside its rails and each transition
 * into a 26561 jogged 14-31 LDU in a few LDU of run (10261 arc 79-81: 55 LDU
 * of rise in 30 of run; 10303 arcs 87/91/116/130: a 1.1 LDU hermite bump
 * between a flat 10 LDU span and a .9 endpoint slope). One datum removes all
 * of them.
 *
 * The x = -10 tip of 26559 and 26561 carries a 5 LDU end relief: the ray
 * reads -33.51 there (the 2024-05 DAT models it as -26.18) while every
 * reading from x = -5 on lies on one line, which the mating rail continues.
 * A 12 LDU-radius wheel bridges the relief, so the plane value is that line
 * through the -5 and 0 readings (-35.96 and -36.16); the other three tips
 * read on their lines. At every level end the height is the straights'
 * -17.8, and at 26559's x = 310 it is 144 - 17.8 = 126.2.
 */
const RAMP_RAIL_TOP_STEP_LDU = 5;
const RAMP_RAIL_TOP_START_X = -10;
const RAMP_RAIL_TOP: Readonly<Record<string, readonly number[]>> = {
  '26559': [-35.96, -31.68, -27.4, -23.08, -18.77, -14.46, -10.14, -5.83, -1.52, 2.8, 7.11, 11.42, 15.74, 19.69, 23.43, 27.18, 30.92, 34.66, 38.4, 42.14, 45.88, 49.55, 52.73, 55.9, 59.08, 62.26, 65.43, 68.61, 71.78, 74.58, 77.22, 79.87, 82.51, 85.15, 87.8, 90.44, 92.82, 94.88, 96.94, 99, 101.06, 103.12, 105.18, 106.99, 108.55, 110.11, 111.68, 113.24, 114.8, 116.31, 117.39, 118.46, 119.54, 120.62, 121.69, 122.6, 123.2, 123.79, 124.39, 124.98, 125.45, 125.64, 125.83, 126.01, 126.2],
  '26560': [-17.8, -17.54, -17.28, -17.01, -16.75, -16.49, -16.23, -15.96, -15.7, -15.44, -14.93, -14.16, -13.4, -12.63, -11.86, -11.09, -10.33, -9.56, -8.79, -7.84, -6.58, -5.33, -4.07, -2.81, -1.55, -0.29, 0.97, 2.23, 3.83, 5.62, 7.42, 9.22, 11.02, 12.82, 14.62, 16.42, 18.4, 20.81, 23.23, 25.65, 28.06, 30.48, 32.9, 35.31, 37.73, 40.7, 43.72, 46.75, 49.78, 52.8, 55.83, 58.86, 61.88, 64.91, 68.64, 72.39, 76.14, 79.88, 83.63, 87.38, 91.12, 95.36, 99.62, 103.87, 108.13],
  '26561': [-36.16, -31.68, -27.2, -22.69, -18.18, -13.67, -9.16, -4.65, -0.14, 4.37, 8.89, 13.4, 17.91, 22.42, 26.93, 31.44, 35.95, 40.46, 44.97, 49.48, 53.99, 58.51, 63.02, 67.53, 72.04, 76.55, 81.06, 85.57, 90.08, 94.6, 99.11, 103.62, 108.13],
  '34738': [-17.8, -17.6, -17.41, -17.21, -17.01, -16.81, -16.33, -15.84, -15.34, -14.85, -14.35, -13.48, -12.57, -11.66, -10.75, -9.84, -8.93, -7.66, -6.34, -5.02, -3.7, -2.38, -1.01, 0.8, 2.6, 4.41, 6.21, 8.02, 10.04, 12.21, 14.39, 16.57, 18.75, 20.93, 23, 24.98, 26.96, 28.94, 30.92, 32.89, 34.82, 36.3, 37.77, 39.24, 40.71, 42.18, 43.65, 44.7, 45.74, 46.78, 47.82, 48.74, 49.5, 50.26, 51.02, 51.68, 52.17, 52.67, 53.17, 53.66, 53.86, 53.94, 54.03, 54.11, 54.2],
};

/** A ramp mould's rail-top polyline, the datum its running line is offset from. */
const rampRailTop = (partId: string): CoasterVec3[] => {
  const heights = RAMP_RAIL_TOP[partId];
  if (!heights) throw new Error(`No measured rail top for ramp mould ${partId}.`);
  return heights.map((y, index) => [RAMP_RAIL_TOP_START_X + index * RAMP_RAIL_TOP_STEP_LDU, y, 0] as const);
};

/**
 * A loop mould is a circular sweep of one cross-section, so its running line
 * is the datum ring moved 32 LDU toward the sweep centre in the Y/Z curvature
 * plane: -Y at the A connector, -Z at the B connector, and exactly radial in
 * between. Estimating the normal from neighbouring samples instead (the
 * previous approach) swung it by 24-51 degrees across the 5 LDU connector
 * stubs and folded the running line back over itself at both ends.
 */
const offsetRadial = (samples: readonly CoasterVec3[], centreYZ: readonly [y: number, z: number]): CoasterVec3[] =>
  samples.map(point => {
    const dy = point[1] - centreYZ[0], dz = point[2] - centreYZ[1], radius = Math.hypot(dy, dz);
    if (radius <= 32) throw new Error('Loop track control lies inside its 32 LDU running-line offset.');
    const scale = (radius - 32) / radius;
    return [point[0], centreYZ[0] + dy * scale, centreYZ[1] + dz * scale] as const;
  });

/** Radius and angular controls come directly from 25061's rail subpart rotations. */
const quarterCurve = (): CoasterVec3[] => Array.from({ length: STEPS + 1 }, (_, index) => {
  const angle = index / STEPS * Math.PI / 2;
  return [240 * Math.cos(angle), 0, 240 * Math.sin(angle)] as const;
});

/** 80566 sleeper centres from the unofficial DAT, interpolated only in elevation. */
const elevatedQuarterCurve = (): CoasterVec3[] => {
  const elevation = [[0, 72], [17, 56.6], [31, 44.5], [45, 33.6], [59, 15.1], [73, 3], [90, 0]] as const;
  return Array.from({ length: STEPS + 1 }, (_, index) => {
    const degrees = index / STEPS * 90, angle = degrees * Math.PI / 180;
    return [240 * Math.cos(angle), pchip(elevation, degrees), 240 * Math.sin(angle)] as const;
  });
};

/**
 * 80564 exists only as Studio-embedded geometry in 10303's source archive
 * (section SHA-256 4d771a13ce5b7bff30ead8f314277c913f010c4ee10caaf99f0304a1e88c9794;
 * the published `IOModel2V2/10303.ldr` carrying it is
 * df3b47c3c9f27623eaa1d8ab40fdf9a0938035cab5d5ffdaac20b55f31676b38).
 * Its stud anchors put the lower connector centre at x=-20.2 and the upper at
 * x=19.8: the +40 LDU lateral shift is real and must not be normalised away.
 *
 * Measured on that mesh (2026-09-21): the quarter is a circular sweep about
 * y=-240, z=-122.2. Its inner rail face is at radius 214.0 +- .1 in every
 * 6-degree sector, its outer face at 240 (bbox y 0 / z 117.8), and the base
 * plate's inner face - the same datum the straight moulds' sleeper controls
 * use, 8 LDU inside the outer face - is at radius 232 on BOTH connector planes:
 * y=-8 on the z=-122.2 plane and z=109.8 on the y=-240 plane. The tail stud
 * (`stud.dat` at z=117.72, pointing outward) is not that datum; its tip
 * (121.72) had been used, which put the B end 11.9 LDU outside the mesh and
 * made the loop 424 LDU wide by 399 tall in 10303.
 *
 * `LOOP_TRACED_CHAIN_CENTROIDS` are the centroid of eight independently traced
 * longitudinal type-2 rail-edge chains, resampled by their own arc lengths.
 * They lie on the radius 224.3 ring (224.2-225.6), 7.7 LDU inside the plate
 * datum, so each keeps its measured lateral x and is re-projected radially onto
 * the datum ring. Keeping them literal keeps a re-trace reviewable.
 */
const LOOP_SWEEP_CENTRE_YZ = [-240, -122.2] as const;
const LOOP_DATUM_RADIUS = 232;
const LOOP_TRACED_CHAIN_CENTROIDS: readonly CoasterVec3[] = [
  [-20.1363, -14.9615, -106.3161], [-19.5611, -18.9683, -83.8775],
  [-18.6457, -24.0411, -61.2821], [-17.2298, -31.4127, -39.3518],
  [-15.3883, -41.1163, -18.3761], [-13.1754, -52.7322, 1.5758],
  [-10.6535, -66.4822, 20.0785], [-7.8073, -81.8947, 37.1683],
  [-4.6172, -99.1191, 52.3662], [-1.3527, -117.664, 65.9036],
  [2.1217, -137.509, 77.3868], [5.8567, -158.3794, 86.7711],
  [9.6304, -180.0986, 93.938], [13.1841, -202.4633, 98.8364],
  [16.8989, -224.6637, 102.5061],
];
const loopQuarter = (): CoasterVec3[] => {
  const [centreY, centreZ] = LOOP_SWEEP_CENTRE_YZ;
  const onDatumRing = (point: CoasterVec3): CoasterVec3 => {
    const dy = point[1] - centreY, dz = point[2] - centreZ, radius = Math.hypot(dy, dz);
    return [point[0], centreY + dy * LOOP_DATUM_RADIUS / radius, centreZ + dz * LOOP_DATUM_RADIUS / radius];
  };
  return [
    // 5 LDU connector stubs along each connector axis (+Z at A, -Y at B) give
    // the stitcher the measured terminal direction.
    [-20.2, -8, -122.2], [-20.2, -8, -117.2],
    ...LOOP_TRACED_CHAIN_CENTROIDS.map(onDatumRing),
    [19.8, -235, 109.8], [19.8, -240, 109.8],
  ];
};

/*
 * Straight, curve and loop controls below are literal: 25061's radius from its
 * rail subpart rotations (SHA-256 prefix 24059780), 80566's elevation from
 * unofficial DAT 30e4453c, 80564 from the embedded mesh named above, and the
 * ramps from the rail-top table above. Keeping anchors literal makes a library
 * update reviewable instead of silently changing a ride path.
 */
const profile = (
  partId: string, controls: readonly CoasterVec3[], geometry: 'library' | 'embedded',
  loopCentreYZ?: readonly [y: number, z: number],
): CoasterTrackProfile =>
  profileFrom(partId, controls, loopCentreYZ ? offsetRadial(controls, loopCentreYZ) : offsetAbove(controls), geometry);

/** A ramp: the measured rail top is the topology datum, its normal offset the running line. */
const rampProfile = (partId: string): CoasterTrackProfile => {
  const railTop = rampRailTop(partId);
  return profileFrom(partId, railTop, offsetNormal(railTop), 'library');
};

/**
 * Pair a topology (rail-datum) polyline with its running line sample for
 * sample, subdividing both in lockstep to at most 20 LDU so the stitcher's
 * terminal tangents and the route's vertices come from the same controls.
 */
const profileFrom = (
  partId: string, topology: readonly CoasterVec3[], running: readonly CoasterVec3[], geometry: 'library' | 'embedded',
): CoasterTrackProfile => {
  if (topology.length !== running.length) throw new Error(`Track profile ${partId} has ${topology.length} rail and ${running.length} running controls.`);
  const railSamples: CoasterVec3[] = [topology[0]!], samples: CoasterVec3[] = [running[0]!];
  for (let index = 1; index < topology.length; index++) {
    const railA = topology[index - 1]!, railB = topology[index]!, runA = running[index - 1]!, runB = running[index]!;
    const distance = Math.max(
      Math.hypot(railB[0] - railA[0], railB[1] - railA[1], railB[2] - railA[2]),
      Math.hypot(runB[0] - runA[0], runB[1] - runA[1], runB[2] - runA[2]),
    );
    const divisions = Math.ceil(distance / 20);
    for (let step = 1; step <= divisions; step++) {
      const t = step / divisions;
      railSamples.push(railA.map((value, axis) => value + (railB[axis]! - value) * t) as unknown as CoasterVec3);
      samples.push(runA.map((value, axis) => value + (runB[axis]! - value) * t) as unknown as CoasterVec3);
    }
  }
  // A running line may carry sub-epsilon neighbours where a topology control
  // is dense (the loop stubs); they would only survive into the route as
  // numerical-noise segments, so the route sees them once.
  return { partId, railSamples, samples: dropNearDuplicates(samples, COASTER_TRACK_DUPLICATE_EPSILON_LDU), geometry };
};

/**
 * Keep-first merge of consecutive samples closer than `epsilon`; the last
 * sample always wins over a predecessor within `epsilon`, so both measured
 * connector positions are preserved exactly.
 */
function dropNearDuplicates(samples: readonly CoasterVec3[], epsilon: number): CoasterVec3[] {
  const kept: CoasterVec3[] = [];
  samples.forEach((sample, index) => {
    const previous = kept.at(-1);
    if (!previous) { kept.push(sample); return; }
    const near = Math.hypot(sample[0] - previous[0], sample[1] - previous[1], sample[2] - previous[2]) <= epsilon;
    if (!near) kept.push(sample);
    else if (index === samples.length - 1 && kept.length > 1) kept[kept.length - 1] = sample;
  });
  return kept;
}
const profiles = new Map<string, CoasterTrackProfile>([
  ['25059', profile('25059', line([-160, 0, 0], [160, 0, 0]), 'library')],
  ['25061', profile('25061', quarterCurve(), 'library')],
  ['26022', profile('26022', line([-80, 0, 0], [80, 0, 0]), 'library')],
  // 26559 is the lower transition (its x = -10 tip is a .856 gradient, 40.6
  // degrees, easing to level at x = 310), 26560 the complementary upper one
  // (level at x = -10, .851 at x = 310), 26561 the straight between them
  // (.902 over its whole rail: 135.3 LDU of rise from x = 0 to 150, 42.0
  // degrees, not the 45 the clip pitch suggests) and 34738 the three-brick
  // S-bend. All four are the rail-top table offset along its normal.
  ['26559', rampProfile('26559')],
  ['26560', rampProfile('26560')],
  ['26561', rampProfile('26561')],
  ['34738', rampProfile('34738')],
  ['80562', profile('80562', line([-40, 0, 0], [40, 0, 0], 4), 'library')],
  ['80564', profile('80564', loopQuarter(), 'embedded', LOOP_SWEEP_CENTRE_YZ)],
  ['80566', profile('80566', elevatedQuarterCurve(), 'library')],
]);

/**
 * An OMR/MPD source embeds its unofficial parts as `<set> - <mould>.dat`
 * sections (`10261 - 25061.dat`) and references them by that full name, so
 * the index's first pick for 10261 extracted ZERO track moulds. The prefix is
 * the set number the document belongs to, never part of the mould id; strip
 * it here rather than resolving every reference through the document's
 * sections, which the parser has already flattened away by the time the
 * placed bricks reach this module.
 */
const EMBEDDED_SET_PREFIX = /^\d{3,7}(?:-\d{1,2})?\s*-\s*/;
const stem = (part: string): string => {
  const name = part.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase().replace(EMBEDDED_SET_PREFIX, '') ?? '';
  return name.endsWith('.dat') ? name.slice(0, -4) : name;
};

/** Return a read-only measured profile for an exact mould id. */
export function coasterTrackProfile(part: string): CoasterTrackProfile | undefined {
  return profiles.get(stem(part));
}

const transform = (brick: ParsedBrick, point: CoasterVec3): CoasterVec3 => {
  const r = brick.rot;
  if (r && r.length !== 9) throw new Error(`Track ${brick.part} has a ${r.length}-element rotation; expected 9.`);
  if (!r) return [brick.x + point[0], brick.y + point[1], brick.z + point[2]];
  return [
    brick.x + r[0]! * point[0] + r[1]! * point[1] + r[2]! * point[2],
    brick.y + r[3]! * point[0] + r[4]! * point[1] + r[5]! * point[2],
    brick.z + r[6]! * point[0] + r[7]! * point[1] + r[8]! * point[2],
  ];
};

/**
 * Transform every supported track mould into model-space fragments. Unknown
 * parts are ignored; no nearest-mould alias or inferred bridge is introduced.
 */
function extractFragments(bricks: readonly ParsedBrick[], options: CoasterTrackExtractionOptions = {}): {
  fragments: CoasterTrackFragment[]; topologyFragments: CoasterTrackFragment[]; unavailablePartIds: string[];
} {
  const fragments: CoasterTrackFragment[] = [];
  const topologyFragments: CoasterTrackFragment[] = [];
  const unavailablePartIds: string[] = [];
  bricks.forEach((brick, index) => {
    const profile = coasterTrackProfile(brick.part);
    if (!profile) return;
    const available = options.isGeometryAvailable?.(profile.partId, brick) ?? profile.geometry === 'library';
    if (!available) {
      unavailablePartIds.push(`${profile.partId}:${index}`);
      return;
    }
    // The running centre is an authored point in the part frame, not an axial
    // normal. Transform it exactly like the mesh. In particular, a reflected
    // Studio placement must reflect this offset too; a determinant sign flip
    // would put the cart on the opposite side of the visible rails.
    const samples = profile.samples.map(point => transform(brick, point));
    fragments.push({ id: `${profile.partId}:${index}`, samples });
    // Connector positions come from the physical running line, while terminal
    // directions come from the measured rail datum. Keeping these independent
    // is essential for ramp tips: the DAT sleeper transform is 32 LDU away
    // from the real cut rail corner, but its longitudinal axis is still exact.
    const railStart = profile.railSamples[0]!, railAfter = profile.railSamples[1]!;
    const railBefore = profile.railSamples.at(-2)!, railEnd = profile.railSamples.at(-1)!;
    const physicalStart = profile.samples[0]!, physicalEnd = profile.samples.at(-1)!;
    const startLength = Math.hypot(railAfter[0] - railStart[0], railAfter[1] - railStart[1], railAfter[2] - railStart[2]);
    const endLength = Math.hypot(railEnd[0] - railBefore[0], railEnd[1] - railBefore[1], railEnd[2] - railBefore[2]);
    const probe = .01;
    const startProbe = physicalStart.map((value, axis) => value + probe * (railAfter[axis]! - railStart[axis]!) / startLength) as unknown as CoasterVec3;
    const endProbe = physicalEnd.map((value, axis) => value - probe * (railEnd[axis]! - railBefore[axis]!) / endLength) as unknown as CoasterVec3;
    topologyFragments.push({
      id: `${profile.partId}:${index}`,
      samples: [physicalStart, startProbe, endProbe, physicalEnd].map(point => transform(brick, point)),
    });
  });

  // 10303 uses two 25061 moulds 32 LDU apart as the two sides of one vertical
  // quarter-turn. Their outer physical rails are radius 270; their midpoint is
  // the route datum, and the cart line is another 18 LDU outward (radius 288),
  // matching the adjacent straight/elevated running lines. Recognise the pair
  // geometrically so a lone or ordinary horizontal 25061 is never reinterpreted.
  const quarterIds = fragments.map(fragment => fragment.id).filter(id => id.startsWith('25061:'));
  const paired = new Set<string>();
  const compositeFragments: CoasterTrackFragment[] = [];
  const compositeTopology: CoasterTrackFragment[] = [];
  const compositeSteps = 24;
  const curve = (radius: number): CoasterVec3[] => Array.from({ length: compositeSteps + 1 }, (_, sample) => {
    const angle = sample / compositeSteps * Math.PI / 2;
    return [radius * Math.cos(angle), 16, radius * Math.sin(angle)] as const;
  });
  const closeReversed = (a: readonly CoasterVec3[], b: readonly CoasterVec3[]): boolean =>
    a.every((point, sample) => {
      const other = b[b.length - 1 - sample]!;
      return Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]) <= 1;
    });
  const candidatePairs = new Map<string, string[]>();
  for (const id of quarterIds) candidatePairs.set(id, []);
  for (let left = 0; left < quarterIds.length; left++) {
    const leftId = quarterIds[left]!;
    const leftIndex = Number(leftId.slice(leftId.lastIndexOf(':') + 1));
    const leftBrick = bricks[leftIndex]!;
    for (let right = left + 1; right < quarterIds.length; right++) {
      const rightId = quarterIds[right]!;
      const rightIndex = Number(rightId.slice(rightId.lastIndexOf(':') + 1));
      const rightBrick = bricks[rightIndex]!;
      if (!leftBrick.rot || !rightBrick.rot) continue;
      const leftLocalY = [leftBrick.rot[1]!, leftBrick.rot[4]!, leftBrick.rot[7]!] as const;
      const rightLocalY = [rightBrick.rot[1]!, rightBrick.rot[4]!, rightBrick.rot[7]!] as const;
      const normalDot = leftLocalY.reduce((sum, value, axis) => sum + value * rightLocalY[axis]!, 0);
      if (Math.abs(leftLocalY[1]) > .01 || Math.abs(rightLocalY[1]) > .01 || normalDot > -.99) continue;
      const placementSeparation = Math.hypot(leftBrick.x - rightBrick.x, leftBrick.y - rightBrick.y, leftBrick.z - rightBrick.z);
      if (Math.abs(placementSeparation - 32) > 1) continue;
      const topologyLeft = curve(270).map(point => transform(leftBrick, point));
      const topologyRight = curve(270).map(point => transform(rightBrick, point));
      if (!closeReversed(topologyLeft, topologyRight)) continue;
      const runningLeft = curve(288).map(point => transform(leftBrick, point));
      const runningRight = curve(288).map(point => transform(rightBrick, point));
      if (!closeReversed(runningLeft, runningRight)) continue;
      candidatePairs.get(leftId)!.push(rightId);
      candidatePairs.get(rightId)!.push(leftId);
    }
  }
  for (const leftId of quarterIds) {
    if (paired.has(leftId) || candidatePairs.get(leftId)!.length !== 1) continue;
    const rightId = candidatePairs.get(leftId)![0]!;
    if (candidatePairs.get(rightId)?.length !== 1 || candidatePairs.get(rightId)![0] !== leftId) continue;
    const leftIndex = Number(leftId.slice(leftId.lastIndexOf(':') + 1));
    const rightIndex = Number(rightId.slice(rightId.lastIndexOf(':') + 1));
    const running = curve(288).map(point => transform(bricks[leftIndex]!, point));
    paired.add(leftId); paired.add(rightId);
    const id = `25061-pair:${Math.min(leftIndex, rightIndex)}+${Math.max(leftIndex, rightIndex)}`;
    compositeFragments.push({ id, samples: running });
      // Graph endpoints use the same running-line datum as neighbouring moulds;
      // the physical rail midpoint above establishes the pair, while radius
      // 288 is the 18-LDU outward cart line shared by those neighbours.
    compositeTopology.push({ id, samples: running });
  }
  if (paired.size) {
    const keep = (fragment: CoasterTrackFragment): boolean => !paired.has(fragment.id);
    fragments.splice(0, fragments.length, ...fragments.filter(keep), ...compositeFragments);
    topologyFragments.splice(0, topologyFragments.length, ...topologyFragments.filter(keep), ...compositeTopology);
  }
  return { fragments, topologyFragments, unavailablePartIds };
}

export function extractCoasterTrackFragments(
  bricks: readonly ParsedBrick[], options: CoasterTrackExtractionOptions = {},
): CoasterTrackFragment[] {
  return extractFragments(bricks, options).fragments;
}

const endpointParts = (key: string): [fragmentId: string, end: 'start' | 'end'] => {
  const split = key.lastIndexOf(':');
  const end = key.slice(split + 1);
  if (split < 1 || (end !== 'start' && end !== 'end')) throw new Error(`Invalid track endpoint key: ${key}`);
  return [key.slice(0, split), end];
};

/** Order a non-branching graph component without bridging any missing seam. */
function orderComponent(
  component: readonly string[], graph: CoasterTrackGraph, fragments: ReadonlyMap<string, CoasterTrackFragment>,
): { points: CoasterVec3[]; ids: string[]; closed: boolean } | undefined {
  const links = new Map<string, string>();
  for (const connection of graph.connections) {
    links.set(connection.a, connection.b);
    links.set(connection.b, connection.a);
  }
  const degrees = new Map(component.map(id => [id, Number(links.has(`${id}:start`)) + Number(links.has(`${id}:end`))]));
  const closed = [...degrees.values()].every(degree => degree === 2);
  const ends = [...degrees].filter(([, degree]) => degree === 1).map(([id]) => id).sort();
  if (!closed && (ends.length !== 2 || [...degrees.values()].some(degree => degree < 1 || degree > 2))) return undefined;

  const endpointByKey = new Map(graph.endpoints.map(endpoint => [endpoint.key, endpoint]));
  let id: string;
  let entry: 'start' | 'end';
  if (closed) {
    const lowest = graph.endpoints
      .filter(endpoint => component.includes(endpoint.fragmentId))
      .sort((a, b) => b.point[1] - a.point[1] || a.key.localeCompare(b.key))[0]!;
    id = lowest.fragmentId;
    entry = lowest.end;
  } else {
    const lowest = ends.map(endId => {
      const end: 'start' | 'end' = links.has(`${endId}:start`) ? 'end' : 'start';
      return endpointByKey.get(`${endId}:${end}`)!;
    }).sort((a, b) => b.point[1] - a.point[1] || a.key.localeCompare(b.key))[0]!;
    id = lowest.fragmentId;
    entry = lowest.end;
  }
  const firstEntry = `${id}:${entry}`;
  const visited = new Set<string>();
  const orderedIds: string[] = [];
  const points: CoasterVec3[] = [];
  const distance = (a: CoasterVec3, b: CoasterVec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  while (!visited.has(id)) {
    const fragment = fragments.get(id);
    if (!fragment) return undefined;
    visited.add(id);
    orderedIds.push(id);
    const oriented = entry === 'start' ? fragment.samples : [...fragment.samples].reverse();
    // A connector the stitcher matched is ONE physical point measured twice,
    // within COASTER_TRACK_ENDPOINT_TOLERANCE_LDU. The previous mould's
    // terminal sample already stands for it; repeating this mould's own
    // measurement would insert a seam step of up to that tolerance, and where
    // the source placements overlap (10303: 0.2-0.97 LDU at every loop seam)
    // that step points against travel and flips the runtime's per-segment
    // tangent for a tick. The step is kept as measured only when merging
    // would stretch the next chord past the authored spacing guard.
    const previous = points.at(-1);
    let skip = 0;
    if (previous !== undefined && oriented.length > 1 && distance(previous, oriented[1]!) <= COASTER_TRACK_MAX_SAMPLE_SPACING_LDU) skip = 1;
    // Where a placement overlaps its neighbour's rail longitudinally (within
    // COASTER_TRACK_OVERLAP_TOLERANCE_LDU), this mould's leading samples lie
    // BEHIND the previous terminal along the travel direction: the same rail
    // measured twice. Each is dropped while the next kept sample still fits
    // the spacing guard, so the route never steps backwards over an overlap.
    const back = points.length >= 2 ? points.at(-2)! : undefined;
    if (previous !== undefined && back !== undefined) {
      const forwardLength = distance(back, previous);
      const forward = [(previous[0] - back[0]) / forwardLength, (previous[1] - back[1]) / forwardLength, (previous[2] - back[2]) / forwardLength];
      const behind = (point: CoasterVec3): boolean =>
        (point[0] - previous[0]) * forward[0]! + (point[1] - previous[1]) * forward[1]! + (point[2] - previous[2]) * forward[2]! <= 0;
      while (skip < oriented.length - 1 && behind(oriented[skip]!)
        && distance(previous, oriented[skip + 1]!) <= COASTER_TRACK_MAX_SAMPLE_SPACING_LDU) skip++;
    }
    for (const point of oriented.slice(skip)) {
      // The profiles are already free of sub-epsilon neighbours; this only
      // guards an unmerged seam whose two measurements coincide.
      if (points.length && distance(point, points.at(-1)!) <= COASTER_TRACK_DUPLICATE_EPSILON_LDU) continue;
      points.push(point);
    }
    const exit: 'start' | 'end' = entry === 'start' ? 'end' : 'start';
    const nextKey = links.get(`${id}:${exit}`);
    if (!nextKey) break;
    const [nextId, nextEnd] = endpointParts(nextKey);
    if (nextId === endpointParts(firstEntry)[0] && closed) break;
    id = nextId;
    entry = nextEnd;
  }
  if (visited.size !== component.length) return undefined;
  if (closed) {
    // The closing connector is merged the same way: the first vertex stands
    // for it unless that would stretch the final chord past the guard.
    const first = points[0]!;
    if (points.length > 2 && distance(points.at(-2)!, first) <= COASTER_TRACK_MAX_SAMPLE_SPACING_LDU) points[points.length - 1] = first;
    else if (distance(points.at(-1)!, first) > 1e-9) points.push(first);
    else points[points.length - 1] = first;
  }
  return { points, ids: orderedIds, closed };
}

/**
 * Extract, transform, and conservatively order supported track placements.
 * A component must contain at least two real moulds and form one chain or loop;
 * isolated pieces, branches, ambiguous joins, and source gaps remain warnings.
 */
export function extractCoasterTrackRoutes(
  bricks: readonly ParsedBrick[], options: CoasterTrackExtractionOptions = {},
): CoasterTrackExtraction {
  const { fragments, topologyFragments, unavailablePartIds } = extractFragments(bricks, options);
  // Connectivity belongs to the physical rail datum. Running-centre normals
  // can differ slightly at a mirrored seam and must never erase a real join or
  // create a new one.
  const graph = stitchCoasterTrackFragments(topologyFragments, {
    endpointToleranceLdu: COASTER_TRACK_ENDPOINT_TOLERANCE_LDU,
    minTangentDot: .97,
    overlapToleranceLdu: COASTER_TRACK_OVERLAP_TOLERANCE_LDU,
  });
  const byId = new Map(fragments.map(fragment => [fragment.id, fragment]));
  const routes: CoasterTrackRouteLdu[] = [];
  const warnings: string[] = [];
  for (const component of graph.components) {
    if (component.length < 2) {
      warnings.push(`Withheld isolated track mould ${component[0]}.`);
      continue;
    }
    const ordered = orderComponent(component, graph, byId);
    if (!ordered) {
      warnings.push(`Withheld non-chain track component (${component.join(', ')}).`);
      continue;
    }
    const first = ordered.points[0]!, last = ordered.points.at(-1)!;
    const horizontalSpan = Math.hypot(last[0] - first[0], last[2] - first[2]);
    const verticalSpan = Math.abs(last[1] - first[1]);
    if (component.every(id => id.startsWith('25059:'))
      && horizontalSpan <= COASTER_TRACK_ENDPOINT_TOLERANCE_LDU
      && verticalSpan > 80) {
      warnings.push(`Withheld vertical guide/lift (${component.join(', ')}): vertical guide/lift requires authored transfer mechanism.`);
      continue;
    }
    routes.push({
      label: `Track ${routes.length + 1}`,
      points: ordered.points,
      closed: ordered.closed,
      fragmentIds: ordered.ids,
      maxSegmentLengthLdu: COASTER_TRACK_MAX_SAMPLE_SPACING_LDU,
    });
  }
  if (graph.gaps.length) warnings.push(`${graph.gaps.length} track endpoint(s) remain open; no gap was bridged.`);
  if (graph.ambiguous.length) warnings.push(`${graph.ambiguous.length} ambiguous track endpoint(s) were withheld.`);
  if (unavailablePartIds.length) warnings.push(`${unavailablePartIds.length} track mould placement(s) lack proven geometry and were withheld.`);
  return { fragments, graph, routes, warnings, unavailablePartIds };
}
