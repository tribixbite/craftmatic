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

const measuredRamp = (
  control: readonly (readonly [number, number])[], endpointSlopes: readonly [number, number] = [0, 0],
): CoasterVec3[] => {
  const start = control[0]![0], end = control.at(-1)![0];
  const count = Math.ceil((end - start) / 5);
  const xValues = new Set(control.map(point => point[0]));
  // The stitcher obtains each endpoint tangent from the adjacent sample. Keep
  // a short derivative probe at both connector planes so that its direction is
  // the measured rail-axis derivative, not the average chord to the first
  // sleeper (which can be tens of LDU away on the transition moulds).
  const endpointProbe = Math.min(.01, (end - start) / 1_000);
  xValues.add(start + endpointProbe);
  xValues.add(end - endpointProbe);
  for (let index = 0; index <= count; index++) xValues.add(start + (end - start) * index / count);
  return [...xValues].sort((a, b) => a - b).map(x => [x, pchip(control, x, endpointSlopes), 0] as const);
};

/** DAT sleeper controls sit 32 LDU below the measured inner rail corner. */
const offsetAbove = (samples: readonly CoasterVec3[]): CoasterVec3[] =>
  samples.map(point => [point[0], point[1] - 32, point[2]] as const);

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
 * Ramp controls below are literal `s/34738s03.dat` sleeper-centre transforms
 * from the named official DATs. Source SHA-256 prefixes: 25061 24059780,
 * 26559 efb23c86, 26560 06cdabdd, 26561 1bb3395f, 34738 277af786. 80566
 * controls come from unofficial DAT 30e4453c. Full hashes and the extraction
 * audit belong in the source-quality evidence; keeping anchors literal makes a
 * library update reviewable instead of silently changing a ride path.
 */
const profile = (
  partId: string, controls: readonly CoasterVec3[], geometry: 'library' | 'embedded',
  loopCentreYZ?: readonly [y: number, z: number],
): CoasterTrackProfile => {
  const running = loopCentreYZ ? offsetRadial(controls, loopCentreYZ) : offsetAbove(controls);
  const topology = controls;
  const railSamples: CoasterVec3[] = [topology[0]!], samples: CoasterVec3[] = [running[0]!];
  for (let index = 1; index < controls.length; index++) {
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
  // The .01 LDU rail-axis probes exist for the stitcher's terminal tangent and
  // stay in railSamples; on the running line they would only survive into the
  // route as sub-epsilon vertices at every ramp connector.
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
  // 26559 is the lower transition (45-degree rail to level), while 26560 is
  // the complementary upper transition (level to 45 degrees). Their endpoint
  // slopes come from the longitudinal rail axes in s/26559s01 and s/26560s01;
  // the extra ten-LDU connector spans must not flatten those measured axes.
  ['26559', profile('26559', measuredRamp([[-10, 0], [0, 0], [39.5, 20.5], [87.3, 56.9], [138.4, 88.4], [192.7, 113.9], [250.2, 131.1], [300, 144], [310, 144]], [.9, 0]), 'library')],
  ['26560', profile('26560', measuredRamp([[-10, 0], [0, 0], [50.5, -1.7], [109.4, 9.8], [166.4, 28.5], [219.8, 55.9], [269.8, 89], [300, 144], [310, 144]], [0, .9]), 'library')],
  // s/26561s01 is explicitly a straight rail. Its two connector planes are
  // 160 LDU apart in X and 144 LDU apart in Y, so its rail-axis slope is .9.
  ['26561', profile('26561', line([-10, 0, 0], [150, 144, 0]), 'library')],
  ['34738', profile('34738', measuredRamp([[-10, 0], [0, 0], [59.8, .7], [108.1, 13.5], [154.4, 32.4], [201.4, 49.6], [250.1, 61], [300, 72], [310, 72]]), 'library')],
  ['80562', profile('80562', line([-40, 0, 0], [40, 0, 0], 4), 'library')],
  ['80564', profile('80564', loopQuarter(), 'embedded', LOOP_SWEEP_CENTRE_YZ)],
  ['80566', profile('80566', elevatedQuarterCurve(), 'library')],
]);

const stem = (part: string): string => {
  const name = part.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
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
    const mergeConnector = previous !== undefined && oriented.length > 1
      && distance(previous, oriented[1]!) <= COASTER_TRACK_MAX_SAMPLE_SPACING_LDU;
    for (const point of oriented.slice(mergeConnector ? 1 : 0)) {
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
