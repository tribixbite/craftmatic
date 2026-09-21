/**
 * Pure route math for scripted Bedrock rides. Coordinates are in model-local
 * blocks; the placement runtime is responsible for applying its anchor,
 * rotation, and selected size. This module deliberately has no Minecraft API
 * dependency so it can be validated before a pack is emitted.
 */

/** A point or direction in the route's local block-space. Matches engine Vec3. */
export type CoasterVec3 = readonly [x: number, y: number, z: number];

/** A loop wraps forever; an open route stops at either explicitly authored end. */
export type CoasterRouteKind = 'closed' | 'open';

export interface CoasterRouteInput {
  /** Ordered centreline samples. A closed route must explicitly end at its first point. */
  points: readonly CoasterVec3[];
  kind: CoasterRouteKind;
  /** Every authored neighbour must be at most this far apart; gaps never become invented straight track. */
  maxSegmentLength: number;
  /** Guard against world-scale or corrupt coordinates before they enter a generated runtime. */
  maxCoordinate?: number;
}

export interface CoasterRouteSegment {
  from: CoasterVec3;
  to: CoasterVec3;
  length: number;
  /** Arc distance at the start of this segment. */
  startDistance: number;
}

export interface CoasterRoute {
  kind: CoasterRouteKind;
  points: readonly CoasterVec3[];
  segments: readonly CoasterRouteSegment[];
  /** Cumulative arc distances, one per authored point, including total length. */
  cumulative: readonly number[];
  length: number;
}

/** Compact route contract serialized into the Bedrock runtime. */
export interface CoasterPath {
  points: readonly CoasterVec3[];
  cumulative: readonly number[];
  length: number;
  closed: boolean;
}

export interface CoasterRouteSample {
  position: CoasterVec3;
  /** Unit travel direction. It is inverted when sampled in reverse. */
  tangent: CoasterVec3;
  distance: number;
  segmentIndex: number;
}

export interface CoasterRouteAdvance {
  distance: number;
  reachedEnd: boolean;
}

/** A transformed mould-profile centreline. Coordinates remain LDU until export chooses a block scale. */
export interface CoasterTrackFragment {
  id: string;
  samples: readonly CoasterVec3[];
}

export interface CoasterTrackEndpoint {
  key: string;
  fragmentId: string;
  end: 'start' | 'end';
  point: CoasterVec3;
  /** Direction pointing away from the fragment at this endpoint. */
  outwardTangent: CoasterVec3;
}

export interface CoasterTrackConnection {
  a: string;
  b: string;
  distance: number;
  tangentDot: number;
}

export interface CoasterTrackGraph {
  endpoints: readonly CoasterTrackEndpoint[];
  /** Only mutual, unambiguous compatible endpoint pairs; never a nearest-point bridge. */
  connections: readonly CoasterTrackConnection[];
  /** Fragment ids grouped by real compatible connections. Isolated fragments remain visible. */
  components: readonly (readonly string[])[];
  /** Endpoints with no compatible candidate under the supplied tolerance. */
  gaps: readonly string[];
  /** Endpoints with multiple possible candidates; none of their candidate edges is selected. */
  ambiguous: readonly string[];
}

export interface CoasterTrackStitchOptions {
  /** Explicit positional tolerance in transformed LDU; a caller must measure this from its track profile. */
  endpointToleranceLdu: number;
  /** Minimum dot product between opposing outward tangents, in [-1, 1]. */
  minTangentDot: number;
}

const DEFAULT_MAX_COORDINATE = 30_000_000;
const EPSILON = 1e-9;

const clone = (point: CoasterVec3): CoasterVec3 => [point[0], point[1], point[2]];
const isFinitePoint = (point: CoasterVec3): boolean => Number.isFinite(point[0]) && Number.isFinite(point[1]) && Number.isFinite(point[2]);
const samePoint = (a: CoasterVec3, b: CoasterVec3): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const distanceBetween = (a: CoasterVec3, b: CoasterVec3): number => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
/**
 * Build a conservative endpoint graph from transformed track-mould samples.
 * The extractor owns profile measurement and transforms; this routine only
 * connects an endpoint when it has exactly one geometrically compatible peer.
 * Ambiguous junctions and gaps are retained as diagnostics, never filled by a
 * nearest-point chord.
 */
export function stitchCoasterTrackFragments(
  fragments: readonly CoasterTrackFragment[], options: CoasterTrackStitchOptions,
): CoasterTrackGraph {
  if (!Number.isFinite(options.endpointToleranceLdu) || options.endpointToleranceLdu <= 0) throw new Error('Track endpointToleranceLdu must be finite and positive.');
  if (!Number.isFinite(options.minTangentDot) || options.minTangentDot < -1 || options.minTangentDot > 1) throw new Error('Track minTangentDot must be in [-1, 1].');
  const ids = new Set<string>();
  const endpoints: CoasterTrackEndpoint[] = [];
  for (const fragment of fragments) {
    if (!fragment.id || ids.has(fragment.id)) throw new Error(`Track fragment id must be unique and non-empty: ${fragment.id || '(empty)'}.`);
    ids.add(fragment.id);
    if (fragment.samples.length < 2) throw new Error(`Track fragment ${fragment.id} needs at least two transformed samples.`);
    const start = fragment.samples[0]!, next = fragment.samples[1]!, previous = fragment.samples.at(-2)!, end = fragment.samples.at(-1)!;
    for (const point of fragment.samples) if (!isFinitePoint(point)) throw new Error(`Track fragment ${fragment.id} has a non-finite sample.`);
    const firstLength = distanceBetween(start, next), lastLength = distanceBetween(previous, end);
    if (firstLength <= EPSILON || lastLength <= EPSILON) throw new Error(`Track fragment ${fragment.id} has a zero-length endpoint sample.`);
    endpoints.push(
      { key: `${fragment.id}:start`, fragmentId: fragment.id, end: 'start', point: clone(start), outwardTangent: [(start[0] - next[0]) / firstLength, (start[1] - next[1]) / firstLength, (start[2] - next[2]) / firstLength] },
      { key: `${fragment.id}:end`, fragmentId: fragment.id, end: 'end', point: clone(end), outwardTangent: [(end[0] - previous[0]) / lastLength, (end[1] - previous[1]) / lastLength, (end[2] - previous[2]) / lastLength] },
    );
  }
  const candidates = new Map<string, Array<{ other: CoasterTrackEndpoint; distance: number; tangentDot: number }>>();
  for (const endpoint of endpoints) candidates.set(endpoint.key, []);
  for (let a = 0; a < endpoints.length; a++) for (let b = a + 1; b < endpoints.length; b++) {
    const left = endpoints[a]!, right = endpoints[b]!;
    if (left.fragmentId === right.fragmentId) continue;
    const distance = distanceBetween(left.point, right.point);
    const tangentDot = -(left.outwardTangent[0] * right.outwardTangent[0] + left.outwardTangent[1] * right.outwardTangent[1] + left.outwardTangent[2] * right.outwardTangent[2]);
    if (distance <= options.endpointToleranceLdu && tangentDot >= options.minTangentDot) {
      candidates.get(left.key)!.push({ other: right, distance, tangentDot });
      candidates.get(right.key)!.push({ other: left, distance, tangentDot });
    }
  }
  const ambiguous = [...candidates].filter(([, list]) => list.length > 1).map(([key]) => key).sort();
  const ambiguousSet = new Set(ambiguous);
  const connections: CoasterTrackConnection[] = [];
  for (const endpoint of endpoints) {
    const candidate = candidates.get(endpoint.key)!;
    if (candidate.length !== 1 || ambiguousSet.has(endpoint.key)) continue;
    const match = candidate[0]!;
    const reciprocal = candidates.get(match.other.key)!;
    if (reciprocal.length !== 1 || ambiguousSet.has(match.other.key) || endpoint.key > match.other.key) continue;
    connections.push({ a: endpoint.key, b: match.other.key, distance: match.distance, tangentDot: match.tangentDot });
  }
  const linked = new Set(connections.flatMap(connection => [connection.a, connection.b]));
  const gaps = endpoints.filter(endpoint => !linked.has(endpoint.key) && !ambiguousSet.has(endpoint.key) && candidates.get(endpoint.key)!.length === 0).map(endpoint => endpoint.key).sort();
  const adjacency = new Map<string, Set<string>>();
  for (const id of ids) adjacency.set(id, new Set());
  for (const connection of connections) {
    const a = connection.a.slice(0, connection.a.lastIndexOf(':')), b = connection.b.slice(0, connection.b.lastIndexOf(':'));
    adjacency.get(a)!.add(b); adjacency.get(b)!.add(a);
  }
  const remaining = new Set(ids), components: string[][] = [];
  while (remaining.size) {
    const start = [...remaining].sort()[0]!, component: string[] = [], queue = [start];
    remaining.delete(start);
    while (queue.length) {
      const id = queue.shift()!; component.push(id);
      for (const other of adjacency.get(id) ?? []) if (remaining.delete(other)) queue.push(other);
    }
    components.push(component.sort());
  }
  return { endpoints, connections, components, gaps, ambiguous };
}

/**
 * Validate an authored centreline and precompute its cumulative arc lengths.
 *
 * Closed routes intentionally require a repeated final point rather than
 * silently drawing a closing chord from the last point to the first. Open
 * routes have no implicit return segment; a shuttle/elevator reverses only
 * when its caller explicitly changes direction after `advanceCoasterRoute`
 * reports an end.
 */
export function createCoasterRoute(input: CoasterRouteInput): CoasterRoute {
  if (!Number.isFinite(input.maxSegmentLength) || input.maxSegmentLength <= 0) {
    throw new Error('Coaster route maxSegmentLength must be a finite positive number.');
  }
  const maxCoordinate = input.maxCoordinate ?? DEFAULT_MAX_COORDINATE;
  if (!Number.isFinite(maxCoordinate) || maxCoordinate <= 0) {
    throw new Error('Coaster route maxCoordinate must be a finite positive number.');
  }
  const minimumPoints = input.kind === 'closed' ? 4 : 2;
  if (input.points.length < minimumPoints) {
    throw new Error(`${input.kind} coaster route needs at least ${minimumPoints} authored points.`);
  }
  const points = input.points.map(clone);
  for (const [index, point] of points.entries()) {
    if (!isFinitePoint(point)) throw new Error(`Coaster route point ${index} must have finite x, y, and z coordinates.`);
    if (Math.max(Math.abs(point[0]), Math.abs(point[1]), Math.abs(point[2])) > maxCoordinate) {
      throw new Error(`Coaster route point ${index} exceeds the ${maxCoordinate} coordinate guard.`);
    }
  }
  if (input.kind === 'closed' && !samePoint(points[0]!, points.at(-1)!)) {
    throw new Error('Closed coaster route must explicitly repeat its first point at the end; no closing chord is inferred.');
  }

  const segments: CoasterRouteSegment[] = [];
  let totalLength = 0;
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index]!, to = points[index + 1]!;
    const length = distanceBetween(from, to);
    if (length <= EPSILON) throw new Error(`Coaster route segment ${index} has zero length.`);
    if (length > input.maxSegmentLength + EPSILON) {
      throw new Error(`Coaster route segment ${index} is ${length.toFixed(3)} blocks, exceeding maxSegmentLength ${input.maxSegmentLength}; split or explicitly reject the gap.`);
    }
    segments.push({ from, to, length, startDistance: totalLength });
    totalLength += length;
  }
  return { kind: input.kind, points, segments, cumulative: [...segments.map(segment => segment.startDistance), totalLength], length: totalLength };
}

/**
 * Compact path builder for a pack's measured extracted track route. Callers
 * must provide the profile-derived spacing guard; inferring it from the
 * longest input segment would silently turn a missing mould into a chord.
 * Closed input still needs the explicit repeated seam; callers that assemble
 * arbitrary mould samples must use `stitchCoasterTrackFragments` first.
 */
export function buildCoasterPath(points: readonly CoasterVec3[], closed: boolean, maxSegmentLength: number): CoasterPath {
  const route = createCoasterRoute({ points, kind: closed ? 'closed' : 'open', maxSegmentLength });
  return { points: route.points, cumulative: route.cumulative, length: route.length, closed };
}

/** Normalize a distance into a route's valid domain without inventing motion beyond an open endpoint. */
export function normalizeCoasterDistance(route: CoasterRoute, distance: number): number {
  if (!Number.isFinite(distance)) throw new Error('Coaster route distance must be finite.');
  if (route.kind === 'open') return Math.max(0, Math.min(route.length, distance));
  const wrapped = distance % route.length;
  return wrapped < 0 ? wrapped + route.length : wrapped;
}

/** Sample an arc distance; a negative value measures reverse travel from the end. */
export function sampleCoasterPath(path: CoasterPath, signedDistance: number): CoasterRouteSample {
  // Kept local because this function is serialized into the Bedrock script.
  const epsilon = 1e-9;
  if (!Number.isFinite(signedDistance)) throw new Error('Coaster route distance must be finite.');
  if (!path || typeof path !== 'object' || !Array.isArray(path.points) || !Array.isArray(path.cumulative)
    || typeof path.closed !== 'boolean' || !Number.isFinite(path.length) || path.length <= 0
    || path.points.length < 2 || path.cumulative.length !== path.points.length) {
    throw new Error('Coaster path has invalid points, cumulative lengths, or total length.');
  }
  if (path.cumulative[0] !== 0 || Math.abs(path.cumulative.at(-1)! - path.length) > Math.max(1, path.length) * 1e-9) {
    throw new Error('Coaster path cumulative lengths must start at zero and end at total length.');
  }
  for (let index = 0; index < path.points.length; index++) {
    const point = path.points[index]!, cumulative = path.cumulative[index]!;
    if (!Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite) || !Number.isFinite(cumulative)) {
      throw new Error(`Coaster path point ${index} or cumulative length is invalid.`);
    }
    if (index > 0) {
      const previous = path.points[index - 1]!, previousCumulative = path.cumulative[index - 1]!;
      const segmentLength = Math.hypot(point[0]! - previous[0]!, point[1]! - previous[1]!, point[2]! - previous[2]!);
      if (!Number.isFinite(segmentLength) || segmentLength <= epsilon || cumulative <= previousCumulative
        || Math.abs(cumulative - previousCumulative - segmentLength) > Math.max(1, segmentLength) * 1e-9) {
        throw new Error(`Coaster path segment ${index - 1} is inconsistent with its cumulative length.`);
      }
    }
  }
  const direction = signedDistance < 0 ? -1 : 1;
  let distance = Math.abs(signedDistance);
  if (path.closed) {
    distance %= path.length;
    if (direction < 0) distance = (path.length - distance) % path.length;
  } else {
    distance = Math.max(0, Math.min(path.length, direction < 0 ? path.length - distance : distance));
  }
  const lastSegment = path.points.length - 2;
  let segmentIndex = lastSegment;
  for (let index = 0; index <= lastSegment; index++) {
    if (distance < path.cumulative[index + 1]! || index === lastSegment) { segmentIndex = index; break; }
  }
  const from = path.points[segmentIndex]!, to = path.points[segmentIndex + 1]!;
  const length = path.cumulative[segmentIndex + 1]! - path.cumulative[segmentIndex]!;
  if (!Number.isFinite(length) || length <= 0) throw new Error(`Coaster path segment ${segmentIndex} has invalid length.`);
  const ratio = Math.max(0, Math.min(1, (distance - path.cumulative[segmentIndex]!) / length));
  const tangent: CoasterVec3 = [(to[0] - from[0]) / length, (to[1] - from[1]) / length, (to[2] - from[2]) / length];
  return {
    position: [from[0] + (to[0] - from[0]) * ratio, from[1] + (to[1] - from[1]) * ratio, from[2] + (to[2] - from[2]) * ratio],
    tangent: direction > 0 ? tangent : [-tangent[0], -tangent[1], -tangent[2]],
    distance,
    segmentIndex,
  };
}

/** Compatibility wrapper for callers that retain their direction separately. */
export function sampleCoasterRoute(route: CoasterRoute, distance: number, direction: 1 | -1 = 1): CoasterRouteSample {
  if (direction !== 1 && direction !== -1) throw new Error('Coaster route direction must be 1 or -1.');
  const result = sampleCoasterPath({ points: route.points, cumulative: route.cumulative, length: route.length, closed: route.kind === 'closed' }, normalizeCoasterDistance(route, distance));
  // advanceCoasterRoute returns a position measured from the authored start,
  // even when travelling backwards. Only facing changes at the same position.
  return direction === 1 ? result : { ...result, tangent: result.tangent.map(value => -value) as unknown as CoasterVec3 };
}

/**
 * Advance by a positive arc distance. Open routes stop and report the endpoint;
 * callers may reverse direction for a shuttle, but reversal is never automatic.
 */
export function advanceCoasterRoute(route: CoasterRoute, distance: number, travel: number, direction: 1 | -1 = 1): CoasterRouteAdvance {
  if (!Number.isFinite(travel) || travel < 0) throw new Error('Coaster route travel must be finite and non-negative.');
  if (direction !== 1 && direction !== -1) throw new Error('Coaster route direction must be 1 or -1.');
  const current = normalizeCoasterDistance(route, distance);
  if (route.kind === 'closed') return { distance: normalizeCoasterDistance(route, current + travel * direction), reachedEnd: false };
  const next = current + travel * direction;
  return { distance: normalizeCoasterDistance(route, next), reachedEnd: next <= 0 || next >= route.length };
}
