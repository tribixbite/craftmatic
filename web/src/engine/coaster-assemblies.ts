/**
 * Detection of a LEGO roller coaster's MOVING assemblies from the source's own
 * bricks: the ride cars, the trains they form, and the lift that closes the
 * circuit. Everything here is a measurement of the placed model in LDraw
 * units (LDU, Y down); nothing is fabricated, moved or re-posed. A set with no
 * detectable car or lift gets an empty list and a warning, never a fallback.
 *
 * The module is pure (no Bedrock types, no pack writing) so the placement
 * runtime and the tests consume the same data. Its inputs are the placed
 * bricks, the resolved part meshes (for library descriptions and bounds) and
 * the measured track extraction from `coaster-track.ts`.
 *
 * ## Rules, one sentence each
 *
 * - **Ride car**: a rolling chassis — a non-figure brick with at least two
 *   wheel-described parts seated inside its bounds (10303: `26021` + 2 x
 *   `24869`), or a part whose own library description says it carries wheels
 *   (the `.io` composite `26021c01`) — together with the non-figure, non-track
 *   bricks whose origins stand in its footprint; it is a RIDE car when its
 *   origin projects within `CAR_ON_ROUTE_MAX_LDU` of an extracted route.
 * - **Train**: the ride cars of one route ordered by arc, split wherever a gap
 *   exceeds twice the longer neighbour's length.
 * - **Chain lift**: sprocket / pulley / chain-link parts that are not car
 *   members, lie within `LIFT_LATERAL_MAX_LDU` of a route's running line and
 *   `LIFT_BELOW_MAX_LDU` beneath it (a chain drive engages the car from
 *   underneath), and span a section of that route rising at least
 *   `LIFT_MIN_RISE_LDU`.
 * - **Platform lift**: on a route with open ends only, a rigid group of at
 *   least `PLATFORM_MIN_MEMBERS` bricks sharing one off-grid rotation frame
 *   (the source's author articulated it), none of them car members, whose deck
 *   line at its authored position meets one open terminal end-on within
 *   `PLATFORM_DOCK_MAX_LDU`; its travel is the world-axis translation that
 *   carries the deck's car-origin line to the other open terminal, reported
 *   with the residual misfit rather than snapped.
 *
 * The 10303 and 10261 measurements these rules produce are recorded in
 * `test/coaster-assemblies.test.ts` (corpus-gated) and in the addon guide.
 */
import { parseLDrawDocument, type ParsedBrick } from './ldraw-parser.js';
import { descriptionOf, type LdrawPartMesh } from './ldraw-part-geometry.js';
import { peekDatText } from './ldraw-geometry.js';
import { connectedClusters, groupFigures, isFigurePart, snapSignedPermutation } from './ldraw-entity-compiler.js';
import { coasterTrackProfile, isSingleRail, type CoasterTrackExtraction } from './coaster-track.js';
import type { CoasterVec3 } from './coaster-path.js';
import { partStem } from './part-id.js';

// ─── Tunables (all LDU; each is a physical statement, not a fit) ─────────────

/** A chassis origin further than this from the running line is not riding it (its own wheels are 31 LDU tall). */
export const CAR_ON_ROUTE_MAX_LDU = 40;
/** Lateral slack around a chassis footprint for member bricks (a stud pitch is 20). */
export const CAR_FOOTPRINT_MARGIN_LDU = 4;
/** How far above the chassis origin a car's own bricks (tub, restraint, rider) can reach. */
export const CAR_HEIGHT_LDU = 120;
/** A wheel is mounted on a chassis when its origin is inside the chassis bounds grown by this much. */
export const WHEEL_MOUNT_TOLERANCE_LDU = 4;
/** Consecutive cars further apart than this multiple of the longer car's length are separate trains. */
export const TRAIN_MAX_GAP_FACTOR = 2;
/** A chain drive runs between the rails: its sprockets sit within this of the running line's vertical plane. */
export const LIFT_LATERAL_MAX_LDU = 40;
/** …and beneath it, within this depth (10261's sprockets are 70-110 LDU under the datum). */
export const LIFT_BELOW_MAX_LDU = 150;
/** A sprocket may sit this far ABOVE the datum before it stops counting as a drive under the car. */
export const LIFT_ABOVE_MAX_LDU = 20;
/** The route must climb at least this much across the drive's span to be a lift. */
export const LIFT_MIN_RISE_LDU = 200;
/** Drive parts further apart along the route than this belong to different mechanisms (10261's hill pulleys are 1,370 LDU apart). */
export const LIFT_CLUSTER_GAP_LDU = 2_000;
/** Smallest rigid off-grid group that can be a platform (10303's has 55 members). */
export const PLATFORM_MIN_MEMBERS = 8;
/** A deck end this close to an open terminal's car-origin point is docked to it. */
export const PLATFORM_DOCK_MAX_LDU = 40;
/** Off-grid rotation frames are grouped after quantising their entries to this step (about 0.3 degrees). */
export const FRAME_QUANTUM = 0.005;
/** A rotation whose entries are all within this of -1/0/1 is grid-aligned and never a platform member. */
export const GRID_SNAP_EPS = 0.01;
/** Off-grid rotations further than this from any signed permutation (about 20 degrees) are not a tilted rigid group. */
export const FRAME_SNAP_EPS = 0.35;
/**
 * Railway cars (a route whose moulds are all railway track, `CoasterTrackRouteLdu.family`):
 * the running gear is every `Train Wheel …` part (wheels and wheel bogies), a
 * car is the WIDEST brick standing over at least two of them within this
 * depth (the train base over its bogies; 10277's plates over its wheels), and
 * its members reach this far above the chassis origin (a locomotive's cab
 * roof) and this far below it (the bogies and wheels).
 */
export const TRAIN_GEAR_DEPTH_LDU = 88;
export const TRAIN_CAR_HEIGHT_LDU = 400;
/** A train chassis origin rides this far over the rail-top line at most (a base on bogies on wheels). */
export const TRAIN_ON_ROUTE_MAX_LDU = 120;
/** How far from the rail-top line (horizontally) a brick under the rail heads is still the track bed. */
export const TRAIN_BED_REACH_LDU = 200;
/** A car stands over a railway line when its chassis origin is within this of the line's vertical plane. */
export const TRAIN_LATERAL_MAX_LDU = 30;
/** Two running-gear units closer than this along the car are one axle group, not a wheelbase. */
export const TRAIN_MIN_WHEELBASE_LDU = 20;
/** Datum-to-origin measurement of a car is taken from cars on the route; this fallback is 10261/10303's 26021 (14.3). */
const DEFAULT_ORIGIN_ABOVE_DATUM_LDU = 14.3;
/** Datum-over-rail-top is measured from a placed straight mould; this fallback is 25059's (14). */
const DEFAULT_DATUM_ABOVE_RAIL_TOP_LDU = 14;
/** The rails found under the wheels must cover at least this fraction of the platform's length. */
const PLATFORM_RAIL_MIN_COVERAGE = .5;

// ─── Data handed to the runtime ─────────────────────────────────────────────

/** A rigid frame in model space: `rot` maps local to world (row-major, LDraw convention). */
export interface CoasterAssemblyFrame {
  originLdu: CoasterVec3;
  rot: readonly number[];
  /** World unit vector of the local axis a car travels along (its chassis's long axis). */
  travelWorld: CoasterVec3;
  /** World unit vector of local -Y (up in LDraw). */
  upWorld: CoasterVec3;
}

export interface CoasterSeat {
  /** Hips/legs joint of the rider, in the car frame (LDU). */
  localLdu: CoasterVec3;
  worldLdu: CoasterVec3;
  /** `rider`: measured from a figure sitting here; `sibling`: copied from a rider in another car of the same chassis mould. */
  source: 'rider' | 'sibling';
  /** Input indices of the rider's figure parts (empty for a sibling-derived seat). */
  riderBricks: readonly number[];
}

export interface CoasterCarRoutePosition {
  routeIndex: number;
  routeLabel: string;
  arcLdu: number;
  /** Straight-line distance from the chassis origin to the running line. */
  offsetLdu: number;
  /** Component of that offset along the car's up axis: how high the chassis origin rides over the datum. */
  originAboveDatumLdu: number;
  /** +1 when the car's travel axis points along increasing arc, -1 against it. */
  heading: 1 | -1;
}

export interface CoasterCar {
  id: string;
  /** Input index, part and library description of the chassis brick. */
  chassis: { index: number; part: string; description: string };
  /** Every member's input index (chassis and wheels included, riders excluded). */
  bricks: readonly number[];
  /** Input indices of the wheel parts mounted on the chassis (empty for a composite chassis with built-in wheels). */
  wheels: readonly number[];
  frame: CoasterAssemblyFrame;
  /** Union of the members' mesh bounds in the car frame. */
  extentLocalLdu: { min: CoasterVec3; max: CoasterVec3 };
  lengthLdu: number;
  widthLdu: number;
  heightLdu: number;
  seats: readonly CoasterSeat[];
  /**
   * From the wheel parts' own meshes, when they are separate parts: axle height
   * under the chassis origin, flange radius, and the axial band of the tread
   * either side of the car centre (24869: flange at 21.5-24, tread 24-33).
   */
  wheelGeometry?: { axleBelowOriginLdu: number; flangeRadiusLdu: number; treadBandLdu: readonly [inner: number, outer: number] };
  /**
   * Wheel contact spacing along the travel axis, in LDU: the spread of the
   * separate wheel parts' origins in the car frame (10303: the two 24869 at
   * +/-25 on the 26021), or, for a composite chassis with its wheels built in,
   * the spread of the wheel subfile placements in its own DAT (`26021c01`:
   * two 24869 at x +/-25, so 50). Undefined when neither can be measured; the
   * runtime then pitches the car on the local tangent instead of the chord.
   */
  wheelbaseLdu?: number;
  route?: CoasterCarRoutePosition;
}

export interface CoasterTrain {
  routeIndex: number;
  routeLabel: string;
  /** Car ids ordered by increasing arc. */
  carIds: readonly string[];
  pitchesLdu: readonly number[];
  meanPitchLdu: number;
  /** Arc from the first car to the last. */
  extentLdu: number;
  routeLengthLdu: number;
  routeClosed: boolean;
}

export interface CoasterStray {
  car: CoasterCar;
  /** Nearest extracted fragment (including withheld guides) and the distance to it. */
  nearestFragmentId: string | null;
  nearestFragmentDistanceLdu: number | null;
}

export interface CoasterChainLift {
  kind: 'chain';
  routeIndex: number;
  routeLabel: string;
  /** Arc span the drive parts cover, increasing arc order. */
  arcStartLdu: number;
  arcEndLdu: number;
  /** Signed rise across that span in ride terms (positive = the route climbs between arcStart and arcEnd). */
  riseLdu: number;
  /** +1 when the climb runs with increasing arc, -1 when the cars climb against the route's ordering. */
  climbDirection: 1 | -1;
  /** Input indices of the sprocket / pulley parts found under the running line. */
  sprockets: readonly number[];
  /** Input indices of chain links or treads found under the running line. */
  links: readonly number[];
}

export interface CoasterPlatformDock {
  /** Which open terminal of the route, and its running-line point. */
  routeIndex: number;
  routeLabel: string;
  end: 'start' | 'end';
  terminalLdu: CoasterVec3;
  /** The terminal's car-origin point (terminal raised by the measured origin-above-datum). */
  terminalCarOriginLdu: CoasterVec3;
  /** Which deck end meets it, and the deck's car-origin point there, at the platform position this dock describes. */
  deckEnd: 'a' | 'b';
  deckCarOriginLdu: CoasterVec3;
  /** Signed misfit from the deck point to the terminal point, world LDU (x, y, z). */
  misfitLdu: CoasterVec3;
  misfitDistanceLdu: number;
}

export interface CoasterPlatformLift {
  kind: 'platform';
  /** Input indices of every member sharing the platform's rotation frame. */
  bricks: readonly number[];
  frame: CoasterAssemblyFrame;
  /** Members' union bounds in the platform frame. */
  extentLocalLdu: { min: CoasterVec3; max: CoasterVec3 };
  /** Tilt of the frame from the grid, degrees, and the world axis it tilts about. */
  tiltDeg: number;
  /**
   * The rails a car's wheels run on: the two ends of the running line (world,
   * at the authored position), the local-frame rail-top height, how the rails
   * were found and how many members form them.
   */
  deck: { aLdu: CoasterVec3; bLdu: CoasterVec3; railTopLocalY: number; memberCount: number; rule: 'wheel-tread-band' | 'largest-top-area' };
  /** Height of a car's origin over the rail top (origin-over-datum + datum-over-rail-top, both measured on the track). */
  carOriginAboveRailLdu: number;
  /** Where the platform stands as authored: which terminal it collects a car from. */
  parked: CoasterPlatformDock;
  /**
   * The pure translation to the other terminal and where it delivers.
   * `distanceLdu` is measured from the AUTHORED pose; `betweenTerminalsLdu`
   * is the same axis's distance between the two terminals' car-origin points,
   * i.e. the travel once the parked pose is snapped onto its terminal.
   */
  travel: { axisWorld: CoasterVec3; distanceLdu: number; betweenTerminalsLdu: number; deliveredAt: CoasterPlatformDock };
}

export type CoasterLift = CoasterChainLift | CoasterPlatformLift;

export interface CoasterAssemblies {
  cars: readonly CoasterCar[];
  trains: readonly CoasterTrain[];
  strays: readonly CoasterStray[];
  lifts: readonly CoasterLift[];
  /** Measured across all ride cars: how high a chassis origin rides over the running datum. */
  originAboveDatumLdu: number | null;
  /** Measured from a straight track mould's mesh: how high the running datum sits over the rail top (25059: 14). */
  datumAboveRailTopLdu: number | null;
  warnings: readonly string[];
}

// ─── Small vector helpers ────────────────────────────────────────────────────

type V = CoasterVec3;
const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: V): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V): V => { const n = norm(a); return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 0]; };
const apply = (m: readonly number[], v: V): V => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
const transpose = (m: readonly number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
const mul = (a: readonly number[], b: readonly number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};
/** Rounded to `places`, with -0 normalised to 0 so serialized data and deep-equality never carry a signed zero. */
const round = (v: number, places = 3): number => Math.round(v * 10 ** places) / 10 ** places || 0;
const roundV = (v: V): V => [round(v[0]), round(v[1]), round(v[2])];
const rotOf = (b: ParsedBrick): readonly number[] => b.rot && b.rot.length === 9 ? b.rot : IDENTITY;
const originOf = (b: ParsedBrick): V => [b.x, b.y, b.z];

interface Box { min: V; max: V }
const emptyBox = (): Box => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
const growBox = (box: Box, p: V): void => {
  box.min = [Math.min(box.min[0], p[0]), Math.min(box.min[1], p[1]), Math.min(box.min[2], p[2])];
  box.max = [Math.max(box.max[0], p[0]), Math.max(box.max[1], p[1]), Math.max(box.max[2], p[2])];
};
const corners = (box: Box): V[] => {
  const { min: lo, max: hi } = box;
  return [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]],
  ];
};
/** A mesh's bounds, or a 20 x 24 x 20 LDU stand-in centred under the origin when the library did not resolve the part. */
const localBounds = (mesh: LdrawPartMesh | null | undefined): Box =>
  mesh && mesh.triangles.length ? { min: [...mesh.bounds.min] as unknown as V, max: [...mesh.bounds.max] as unknown as V } : { min: [-10, 0, -10], max: [10, 24, 10] };
/** A brick's mesh bounds expressed in another frame (`frameRot`, `frameOrigin`), as an axis-aligned box there. */
const boundsInFrame = (b: ParsedBrick, mesh: LdrawPartMesh | null | undefined, frameRot: readonly number[], frameOrigin: V): Box => {
  const toFrame = mul(transpose(frameRot), rotOf(b));
  const offset = apply(transpose(frameRot), sub(originOf(b), frameOrigin));
  const box = emptyBox();
  for (const c of corners(localBounds(mesh))) growBox(box, add(apply(toFrame, c), offset));
  return box;
};
const worldBounds = (b: ParsedBrick, mesh: LdrawPartMesh | null | undefined): Box => boundsInFrame(b, mesh, IDENTITY, [0, 0, 0]);
const inBox = (box: Box, p: V, margin = 0): boolean =>
  p[0] >= box.min[0] - margin && p[0] <= box.max[0] + margin
  && p[1] >= box.min[1] - margin && p[1] <= box.max[1] + margin
  && p[2] >= box.min[2] - margin && p[2] <= box.max[2] + margin;

// ─── Mesh measurements ───────────────────────────────────────────────────────

/**
 * A wheel part's flange radius and tread band from its own triangles. The axle
 * is the mesh's longest bounds axis; the flange is the largest radius about it,
 * and the tread is the axial band beyond the flange out to the last vertex of
 * wheel size (radius >= 8, which excludes axle stubs). 24869: flange 13.4 at
 * axial 21.5-24, tread out to 33.
 */
function wheelMeshGeometry(mesh: LdrawPartMesh | null | undefined): { flangeRadius: number; treadBand: readonly [number, number] } | null {
  if (!mesh || !mesh.triangles.length) return null;
  const spans = [mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[1] - mesh.bounds.min[1], mesh.bounds.max[2] - mesh.bounds.min[2]];
  const axle = spans.indexOf(Math.max(...spans));
  const radial = (v: readonly number[]): number => Math.hypot(...[0, 1, 2].filter(k => k !== axle).map(k => v[k]!));
  let flangeRadius = 0;
  for (const t of mesh.triangles) for (const v of [t.a, t.b, t.c]) flangeRadius = Math.max(flangeRadius, radial(v));
  if (flangeRadius < 8) return null;
  let flangeOuter = 0, wheelOuter = 0;
  for (const t of mesh.triangles) for (const v of [t.a, t.b, t.c]) {
    const r = radial(v), a = Math.abs(v[axle]!);
    if (r >= flangeRadius - .5) flangeOuter = Math.max(flangeOuter, a);
    if (r >= 8) wheelOuter = Math.max(wheelOuter, a);
  }
  return { flangeRadius: round(flangeRadius), treadBand: [round(flangeOuter), round(wheelOuter)] };
}

/** The lateral (and long-axis) extent of a member's TOP face in a frame, from its triangles; its box when the mesh is missing. */
function topFaceInFrame(b: ParsedBrick, mesh: LdrawPartMesh | null | undefined, frameRot: readonly number[], frameOrigin: V): { top: number; min: V; max: V } {
  if (!mesh || !mesh.triangles.length) { const box = boundsInFrame(b, mesh, frameRot, frameOrigin); return { top: box.min[1], min: box.min, max: box.max }; }
  const toFrame = mul(transpose(frameRot), rotOf(b));
  const offset = apply(transpose(frameRot), sub(originOf(b), frameOrigin));
  const points: V[] = [];
  let top = Infinity;
  for (const t of mesh.triangles) for (const v of [t.a, t.b, t.c]) { const p = add(apply(toFrame, v), offset); points.push(p); if (p[1] < top) top = p[1]; }
  const box = emptyBox();
  for (const p of points) if (p[1] <= top + .5) growBox(box, p);
  return { top, min: box.min, max: box.max };
}

/**
 * How far the running datum sits above the rail top, from a straight mould
 * placed in the model: the profile's running line is authored in the part
 * frame, the rail top is the mesh's highest point (25059: samples y -32, rail
 * top y -18, so 14). Null when the model places no level straight mould.
 */
export function measureDatumAboveRailTop(bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>): number | null {
  for (const b of bricks) {
    const profile = coasterTrackProfile(b.part);
    const mesh = meshes.get(b.part);
    if (!profile || !mesh || !mesh.triangles.length) continue;
    const y = profile.samples[0]![1];
    if (!profile.samples.every(s => Math.abs(s[1] - y) < 1e-6)) continue;
    return round(mesh.bounds.min[1] - y);
  }
  return null;
}

// ─── Part classification by library description ────────────────────────────

const clean = (description: string): string => description.replace(/^[~=_]+\s*/, '');
/** A wheel or tyre a vehicle rolls on (`Wheels Roller Coaster`, `Wheel Rim 14 x 18`, `Tyre 6/50 x 8`). */
export const isWheelPart = (description: string): boolean => /^(Wheels?|Tyre)\b/i.test(clean(description));
/** A part that is a chassis WITH its wheels built in (the Studio composite `26021c01`: `Train Base 4 x 5 Roller Coaster with Dark Bluish Gray Wheels`). */
export const isSelfWheeledPart = (description: string): boolean => !isWheelPart(description) && /\bwith\b.*\bWheels\b/i.test(clean(description));
/** A chain-drive rotor: Technic wedge-belt wheel (10261's chain sprockets), pulley, sprocket or gear. */
export const isSprocketPart = (description: string): boolean => /\b(Wedge Belt Wheel|Pulley|Sprocket)\b|^(Technic )?Gear\b/i.test(clean(description));
/** A chain link or tread. */
export const isChainPart = (description: string): boolean => /^Technic Chain (Link|Tread)\b/i.test(clean(description));
/** A piece of railway track that is not a routed mould: sleepers, points, crossings, loose rails. Scenery, never a car. */
export const isRailwayTrackPart = (description: string): boolean => /^(Train|Monorail) Track\b/i.test(clean(description));
/** A coupling: magnets, buffer beams, hitches. Left out of a railway car's connectivity (coupled cars touch only there), then rejoined to the body it touches. */
export const isTrainCouplerPart = (description: string): boolean => /\b(Magnet|Coupl\w*|Buffer Beam|Hitch)\b/i.test(clean(description));
/** Railway running gear: a train wheel or a train wheel bogie (`Train Wheel with Closed Centre for Wheel Bogie`, `Train Wheel Bogie Single Axle …`). */
export const isTrainGearPart = (description: string): boolean => /^Train Wheel\b/i.test(clean(description));

// ─── Route geometry ──────────────────────────────────────────────────────────

interface RouteGeometry {
  index: number;
  label: string;
  points: readonly V[];
  cumulative: readonly number[];
  length: number;
  closed: boolean;
}

function routeGeometry(tracks: CoasterTrackExtraction): RouteGeometry[] {
  return tracks.routes.map((route, index) => {
    const cumulative = [0];
    for (let i = 1; i < route.points.length; i++) cumulative.push(cumulative[i - 1]! + norm(sub(route.points[i]!, route.points[i - 1]!)));
    return { index, label: route.label, points: route.points, cumulative, length: cumulative.at(-1) ?? 0, closed: route.closed };
  });
}

interface Projection { arc: number; point: V; tangent: V; distance: number }

/** Nearest point of a polyline to `p`: its arc distance, position, unit tangent there and the straight-line distance. */
function projectOntoPolyline(points: readonly V[], cumulative: readonly number[], p: V): Projection {
  let best: Projection = { arc: 0, point: points[0]!, tangent: [1, 0, 0], distance: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, ab = sub(b, a);
    const len2 = dot(ab, ab);
    if (len2 <= 0) continue;
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2));
    const q = add(a, scale(ab, t));
    const d = norm(sub(p, q));
    if (d < best.distance) best = { arc: cumulative[i - 1]! + Math.sqrt(len2) * t, point: q, tangent: unit(ab), distance: d };
  }
  return best;
}

/** Running-line point at an arc distance (clamped for open routes). */
function pointAtArc(route: RouteGeometry, arc: number): V {
  const s = Math.max(0, Math.min(route.length, arc));
  let i = 0;
  while (i < route.cumulative.length - 2 && route.cumulative[i + 1]! < s) i++;
  const a = route.points[i]!, b = route.points[i + 1]!;
  const span = route.cumulative[i + 1]! - route.cumulative[i]!;
  const t = span > 0 ? (s - route.cumulative[i]!) / span : 0;
  return add(a, scale(sub(b, a), t));
}

// ─── Detection ───────────────────────────────────────────────────────────────

export interface CoasterAssemblyOptions {
  /** Override the measured chassis-origin height over the datum used for docking when no ride car provides one. */
  originAboveDatumLdu?: number;
  /**
   * The `.dat` text of a library part by id (`26021c01.dat`), used to read a
   * composite chassis's own wheel subfile placements. Defaults to the shared
   * text cache the meshes were resolved through (`peekDatText`); a test or a
   * caller with its own loader supplies the texts directly.
   */
  partText?: (partId: string) => string | null | undefined;
}

/**
 * The wheelbase of a composite chassis from the wheel-described subfile
 * placements in its own DAT, measured along `travelLocal` in the part's
 * frame. One level deep: a shortcut places its wheels directly (`26021c01`
 * places two `24869`). Undefined without the text, fewer than two wheel
 * children, or no spread between them.
 */
function compositeWheelbaseLdu(
  chassisPart: string, travelLocal: V, partText: (partId: string) => string | null | undefined,
): number | undefined {
  const text = partText(chassisPart);
  if (!text) return undefined;
  const along: number[] = [];
  for (const child of parseLDrawDocument(text).bricks) {
    const childText = partText(child.part);
    if (!childText || !isWheelPart(descriptionOf(childText))) continue;
    along.push(child.x * travelLocal[0] + child.y * travelLocal[1] + child.z * travelLocal[2]);
  }
  if (along.length < 2) return undefined;
  const spread = Math.max(...along) - Math.min(...along);
  return spread > 1 ? round(spread) : undefined;
}

/**
 * Detect the ride cars, trains, strays and lifts of a placed model. `meshes`
 * is the same map `discoverSceneActors` builds (part → resolved mesh or null);
 * `tracks` is `extractCoasterTrackRoutes(...)` over the same bricks.
 */
export function detectCoasterAssemblies(
  bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, tracks: CoasterTrackExtraction,
  options: CoasterAssemblyOptions = {},
): CoasterAssemblies {
  const warnings: string[] = [];
  const mesh = (b: ParsedBrick): LdrawPartMesh | null | undefined => meshes.get(b.part);
  const desc = (b: ParsedBrick): string => mesh(b)?.description ?? '';
  const routes = routeGeometry(tracks);

  // Figures: every grouped part, plus loose figure parts, are never car or platform members.
  const figureGroups = groupFigures(bricks as ParsedBrick[], meshes as Map<string, LdrawPartMesh | null>);
  const figureOfBrick = new Map<number, number>();
  figureGroups.forEach((g, k) => { for (const i of g.parts) figureOfBrick.set(i, k); });
  const isFigureBrick = (i: number): boolean => figureOfBrick.has(i) || isFigurePart(bricks[i]!.part, desc(bricks[i]!));
  const isTrackMould = (i: number): boolean => coasterTrackProfile(bricks[i]!.part) !== undefined;

  // ── 1. Rolling chassis ────────────────────────────────────────────────────
  const wheelIndices: number[] = [];
  const sprocketIndices: number[] = [];
  const chainIndices: number[] = [];
  const selfWheeled: number[] = [];
  bricks.forEach((b, i) => {
    if (isFigureBrick(i) || isTrackMould(i)) return;
    const d = desc(b);
    if (isWheelPart(d)) wheelIndices.push(i);
    else if (isSelfWheeledPart(d)) selfWheeled.push(i);
    if (isSprocketPart(d)) sprocketIndices.push(i);
    if (isChainPart(d)) chainIndices.push(i);
  });
  // Each wheel mounts on the nearest non-wheel brick whose OWN bounds contain
  // its origin — tested in that brick's local frame, not as a world AABB. A
  // car parked on a slope turns every part with it, and a turned part's world
  // AABB swells to swallow its neighbours: 76417's cart, placed on its spiral
  // at an 8.5 degree pitch (the set's own final page, 2026-09-24), had one
  // wheel claimed by the 47457 slope beside the chassis, so neither brick got
  // two wheels and the set lost its own car. Local containment is what the
  // world test meant, and it is identical for an axis-aligned car.
  const wheelWorld = new Map<number, Box>();
  const candidates: number[] = [];
  bricks.forEach((b, i) => {
    if (isFigureBrick(i) || isTrackMould(i) || isWheelPart(desc(b))) return;
    candidates.push(i);
  });
  const wheelsByChassis = new Map<number, number[]>();
  for (const w of wheelIndices) {
    const origin = originOf(bricks[w]!);
    let best = -1, bestDistance = Infinity;
    for (const i of candidates) {
      const b = bricks[i]!;
      const local = apply(transpose(rotOf(b)), sub(origin, originOf(b)));
      if (!inBox(localBounds(mesh(b)), local, WHEEL_MOUNT_TOLERANCE_LDU)) continue;
      const d = norm(sub(origin, originOf(b)));
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    if (best < 0) continue;
    wheelWorld.set(w, worldBounds(bricks[w]!, mesh(bricks[w]!)));
    (wheelsByChassis.get(best) ?? wheelsByChassis.set(best, []).get(best)!).push(w);
  }
  // ── 1b. Railway cars ──────────────────────────────────────────────────────
  // Only where a RAILWAY route was extracted, so a coaster set is detected
  // exactly as before. A bogie with its wheelset describes itself "with
  // Wheels", which would make every bogie a car of its own: here it is gear.
  const trainChassis = new Set<number>();
  /** A railway car's members (its connected body, the gear under it, its couplers) and its extent in the chassis frame. */
  const trainCars = new Map<number, { members: number[]; box: Box }>();
  if (tracks.routes.some(route => route.family === 'train')) {
    // A railway car is a CONNECTED body: every non-figure, non-track brick
    // that touches another, with the running gear and the couplers left out
    // of the connectivity - wheels touch the rails, and coupled cars touch
    // only magnet to magnet. A body with at least two gear units under it,
    // spread along its length, is a car; its chassis (its frame) is its
    // widest brick. The couplers then rejoin the body they touch.
    // Running gear: train wheels and bogies, a wheelset that describes itself
    // "with … Wheels" (4558's 12V axles), and plain wheels (4204's mine carts).
    // Every piece of the track itself - rails, sleepers, points - is scenery.
    const railway = (i: number): boolean => isTrackMould(i) || isRailwayTrackPart(desc(bricks[i]!)) || isSingleRail(bricks[i]!.part);
    const gear: number[] = [];
    bricks.forEach((b, i) => {
      if (isFigureBrick(i) || railway(i)) return;
      const d = desc(b);
      if (isTrainGearPart(d) || isSelfWheeledPart(d) || isWheelPart(d)) gear.push(i);
    });
    const gearSet = new Set(gear);
    // A car never reaches below the rail heads (only its wheel flanges do, and
    // they are gear): anything whose top is at or under the rail-top line near
    // the track is the track bed a display set builds under it (10277's 1,206
    // plates and tiles), which would otherwise join the train to its stand.
    const railPoints = tracks.routes.filter(route => route.family === 'train').flatMap(route => route.points);
    const underRails = (box: Box): boolean => {
      const cx = (box.min[0] + box.max[0]) / 2, cz = (box.min[2] + box.max[2]) / 2;
      let nearest: V | undefined, best = TRAIN_BED_REACH_LDU;
      for (const p of railPoints) { const h = Math.hypot(p[0] - cx, p[2] - cz); if (h < best) { best = h; nearest = p; } }
      return !!nearest && box.min[1] >= nearest[1] - 1; // LDraw Y down: the top is at or below the rail top
    };
    const worldBox = new Map<number, Box>();
    const body: number[] = [], couplers: number[] = [];
    bricks.forEach((b, i) => {
      if (isFigureBrick(i) || railway(i) || gearSet.has(i)) return;
      const box = worldBounds(b, mesh(b));
      if (underRails(box)) return;
      worldBox.set(i, box);
      (isTrainCouplerPart(desc(b)) ? couplers : body).push(i);
    });
    for (const i of gear) worldBox.set(i, worldBounds(bricks[i]!, mesh(bricks[i]!)));
    const clusters = connectedClusters(body.map(i => worldBox.get(i)! as { min: [number, number, number]; max: [number, number, number] }), 2).map(c => c.map(k => body[k]!));
    const clusterOf = new Map<number, number>();
    clusters.forEach((c, k) => { for (const i of c) clusterOf.set(i, k); });
    const clusterBox = clusters.map(c => { const box = emptyBox(); for (const i of c) { const w = worldBox.get(i)!; growBox(box, w.min); growBox(box, w.max); } return box; });
    // Gear hangs under a body: the cluster whose footprint holds it and whose underside is within the gear depth over it.
    const gearOf = new Map<number, number[]>();
    for (const g of gear) {
      const p = originOf(bricks[g]!);
      let best = -1, bestGap = Infinity;
      clusterBox.forEach((box, k) => {
        if (p[0] < box.min[0] - 4 || p[0] > box.max[0] + 4 || p[2] < box.min[2] - 4 || p[2] > box.max[2] + 4) return;
        const gap = p[1] - box.max[1]; // LDraw Y down: how far the gear hangs under the body
        if (gap < -TRAIN_GEAR_DEPTH_LDU || gap > TRAIN_GEAR_DEPTH_LDU) return;
        if (Math.abs(gap) < bestGap) { bestGap = Math.abs(gap); best = k; }
      });
      if (best >= 0) (gearOf.get(best) ?? gearOf.set(best, []).get(best)!).push(g);
    }
    const touching = (a: Box, b: Box): boolean => a.min[0] - 2 <= b.max[0] && a.max[0] + 2 >= b.min[0] && a.min[1] - 2 <= b.max[1] && a.max[1] + 2 >= b.min[1] && a.min[2] - 2 <= b.max[2] && a.max[2] + 2 >= b.min[2];
    const couplerOf = new Map<number, number>();
    for (const c of couplers) {
      const w = worldBox.get(c)!;
      const k = clusters.findIndex((cluster, index) => gearOf.has(index) && cluster.some(i => touching(worldBox.get(i)!, w)));
      if (k >= 0) couplerOf.set(c, k);
    }
    for (const [k, units] of gearOf) {
      // The chassis: the body's widest brick, whose long axis is the car's travel.
      const cluster = clusters[k]!;
      let chassis = cluster[0]!, area = -1;
      for (const i of cluster) { const w = worldBox.get(i)!; const a = (w.max[0] - w.min[0]) * (w.max[2] - w.min[2]); if (a > area) { area = a; chassis = i; } }
      const b = bricks[chassis]!, own = localBounds(mesh(b));
      const travel: V = (own.max[0] - own.min[0]) >= (own.max[2] - own.min[2]) ? [1, 0, 0] : [0, 0, 1];
      const along = units.map(g => dot(apply(transpose(rotOf(b)), sub(originOf(bricks[g]!), originOf(b))), travel));
      if (units.length < 2 || Math.max(...along) - Math.min(...along) < TRAIN_MIN_WHEELBASE_LDU) continue;
      const members = [...cluster, ...units, ...couplers.filter(c => couplerOf.get(c) === k)];
      const box = emptyBox();
      for (const i of members) { const local = boundsInFrame(bricks[i]!, mesh(bricks[i]!), rotOf(b), originOf(b)); growBox(box, local.min); growBox(box, local.max); }
      trainChassis.add(chassis);
      wheelsByChassis.set(chassis, units);
      trainCars.set(chassis, { members, box });
    }
    // A wheeled chassis inside a railway car is part of that car, not a car of its own.
    const claimed = new Set([...trainCars.values()].flatMap(car => car.members));
    for (let k = selfWheeled.length - 1; k >= 0; k--) if (claimed.has(selfWheeled[k]!)) selfWheeled.splice(k, 1);
    for (const c of [...wheelsByChassis.keys()]) if (!trainChassis.has(c) && claimed.has(c)) wheelsByChassis.delete(c);
  }
  const chassisIndices = [
    ...selfWheeled,
    ...[...wheelsByChassis].filter(([, wheels]) => wheels.length >= 2).map(([i]) => i),
  ].sort((a, b) => a - b);

  // ── 2. Cars: members, riders, extents ─────────────────────────────────────
  const memberOf = new Map<number, number>(); // brick index → chassis index
  const carLocal = new Map<number, { rot: readonly number[]; origin: V; footprint: Box }>();
  for (const c of chassisIndices) {
    const b = bricks[c]!;
    const rot = rotOf(b), origin = originOf(b);
    const own = localBounds(mesh(b));
    // Footprint: the chassis's own local bounds grown laterally, from just under
    // the chassis bottom up to CAR_HEIGHT above the origin (local -Y is up).
    // A railway car reaches a cab roof above and its bogies and wheels below.
    const train = trainCars.get(c);
    const footprint: Box = train
      ? { min: [train.box.min[0] - CAR_FOOTPRINT_MARGIN_LDU, train.box.min[1] - CAR_FOOTPRINT_MARGIN_LDU, train.box.min[2] - CAR_FOOTPRINT_MARGIN_LDU], max: [train.box.max[0] + CAR_FOOTPRINT_MARGIN_LDU, train.box.max[1] + CAR_FOOTPRINT_MARGIN_LDU, train.box.max[2] + CAR_FOOTPRINT_MARGIN_LDU] }
      : {
        min: [own.min[0] - CAR_FOOTPRINT_MARGIN_LDU, -CAR_HEIGHT_LDU, own.min[2] - CAR_FOOTPRINT_MARGIN_LDU],
        max: [own.max[0] + CAR_FOOTPRINT_MARGIN_LDU, own.max[1] + CAR_FOOTPRINT_MARGIN_LDU, own.max[2] + CAR_FOOTPRINT_MARGIN_LDU],
      };
    carLocal.set(c, { rot, origin, footprint });
  }
  const chassisSet = new Set(chassisIndices);
  bricks.forEach((b, i) => {
    if (isFigureBrick(i) || isTrackMould(i)) return;
    if (chassisSet.has(i)) { memberOf.set(i, i); return; }
    let best = -1, bestScore = Infinity;
    for (const c of chassisIndices) {
      if (trainCars.has(c)) continue; // a railway car's members are its connected body, set below
      const { rot, origin, footprint } = carLocal.get(c)!;
      const local = apply(transpose(rot), sub(originOf(b), origin));
      if (!inBox(footprint, local)) continue;
      // Neighbouring cars' footprints overlap (10303: 141 LDU chassis at a 120 LDU pitch); the nearest chassis along travel wins.
      const score = Math.abs(local[0]) + norm(local) * 1e-3;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    if (best >= 0) memberOf.set(i, best);
  });
  // A wheel mounted on a chassis belongs to that chassis even if another footprint scores it closer.
  for (const [c, wheels] of wheelsByChassis) if (chassisSet.has(c)) for (const w of wheels) memberOf.set(w, c);
  for (const [c, car] of trainCars) for (const i of car.members) memberOf.set(i, c);

  const riderOfChassis = new Map<number, number[]>(); // chassis → figure group indices
  figureGroups.forEach((g, k) => {
    const torso = bricks[g.torso]!;
    for (const c of chassisIndices) {
      const { rot, origin, footprint } = carLocal.get(c)!;
      const local = apply(transpose(rot), sub(originOf(torso), origin));
      const seatBox: Box = trainCars.has(c) ? footprint : { min: [footprint.min[0], -CAR_HEIGHT_LDU, footprint.min[2]], max: [footprint.max[0], 10, footprint.max[2]] };
      if (inBox(seatBox, local)) { (riderOfChassis.get(c) ?? riderOfChassis.set(c, []).get(c)!).push(k); break; }
    }
  });

  const cars: CoasterCar[] = [];
  const seatByMould = new Map<string, V>(); // chassis part → measured local seat, for sibling cars
  const measuredSeat = (c: number, k: number): { local: V; world: V } => {
    const { rot, origin } = carLocal.get(c)!;
    const g = figureGroups[k]!;
    const torso = bricks[g.torso]!;
    // The seat is the hips/legs joint: the legs' origin when the figure has
    // legs, otherwise 44 LDU down the torso's own axis (hips 32 + leg pivot 12).
    const legs = g.parts.map(i => bricks[i]!).find(p => /^(971|972|3816|3817)(?![0-9])/.test(partStem(p.part)) || /^Minifig Leg\b/i.test(clean(desc(p))));
    const world: V = legs ? originOf(legs) : add(originOf(torso), apply(rotOf(torso), [0, 44, 0]));
    return { local: apply(transpose(rot), sub(world, origin)), world };
  };
  for (const c of chassisIndices) {
    const b = bricks[c]!;
    const { rot, origin } = carLocal.get(c)!;
    const members = [...memberOf].filter(([, chassis]) => chassis === c).map(([i]) => i).sort((a, z) => a - z);
    const extent = emptyBox();
    for (const i of members) {
      const box = boundsInFrame(bricks[i]!, mesh(bricks[i]!), rot, origin);
      growBox(extent, box.min); growBox(extent, box.max);
    }
    const wheels = (wheelsByChassis.get(c) ?? []).filter(w => memberOf.get(w) === c);
    const seats: CoasterSeat[] = [];
    for (const k of riderOfChassis.get(c) ?? []) {
      const { local, world } = measuredSeat(c, k);
      seats.push({ localLdu: roundV(local), worldLdu: roundV(world), source: 'rider', riderBricks: figureGroups[k]!.parts });
      if (!seatByMould.has(b.part)) seatByMould.set(b.part, local);
    }
    // Travel axis: the chassis's longest horizontal local axis (X for 26021: 141 vs 80 LDU).
    const own = localBounds(mesh(b));
    const travelLocal: V = (own.max[0] - own.min[0]) >= (own.max[2] - own.min[2]) ? [1, 0, 0] : [0, 0, 1];
    let wheelGeometry: CoasterCar['wheelGeometry'];
    let wheelbaseLdu: number | undefined;
    if (wheels.length) {
      const wheelsLocal = wheels.map(w => apply(transpose(rot), sub(originOf(bricks[w]!), origin)));
      const axle = wheelsLocal.reduce((s, p) => s + p[1], 0) / wheels.length;
      const measured = wheelMeshGeometry(mesh(bricks[wheels[0]!]!));
      if (measured) wheelGeometry = { axleBelowOriginLdu: round(axle), flangeRadiusLdu: measured.flangeRadius, treadBandLdu: measured.treadBand };
      if (wheels.length >= 2) {
        const along = wheelsLocal.map(p => p[0] * travelLocal[0] + p[1] * travelLocal[1] + p[2] * travelLocal[2]);
        const spread = Math.max(...along) - Math.min(...along);
        if (spread > 1) wheelbaseLdu = round(spread);
      }
    } else {
      wheelbaseLdu = compositeWheelbaseLdu(b.part, travelLocal, options.partText ?? peekDatText);
    }
    cars.push({
      id: `car:${c}`,
      chassis: { index: c, part: b.part, description: desc(b) },
      bricks: members,
      wheels,
      frame: { originLdu: roundV(origin), rot, travelWorld: roundV(unit(apply(rot, travelLocal))), upWorld: roundV(unit(apply(rot, [0, -1, 0]))) },
      extentLocalLdu: { min: roundV(extent.min), max: roundV(extent.max) },
      lengthLdu: round(travelLocal[0] ? extent.max[0] - extent.min[0] : extent.max[2] - extent.min[2]),
      widthLdu: round(travelLocal[0] ? extent.max[2] - extent.min[2] : extent.max[0] - extent.min[0]),
      heightLdu: round(extent.max[1] - extent.min[1]),
      seats,
      ...(wheelGeometry ? { wheelGeometry } : {}),
      ...(wheelbaseLdu !== undefined ? { wheelbaseLdu } : {}),
    });
  }
  // A car with no rider takes the seat measured on a ridden car of the same chassis mould.
  for (const car of cars) {
    if (car.seats.length) continue;
    const local = seatByMould.get(car.chassis.part);
    if (!local) continue;
    const world = add(car.frame.originLdu, apply(car.frame.rot, local));
    (car.seats as CoasterSeat[]).push({ localLdu: roundV(local), worldLdu: roundV(world), source: 'sibling', riderBricks: [] });
  }

  // ── 3. Route positions, trains, strays ────────────────────────────────────
  const originHeights: number[] = [];
  for (const car of cars) {
    let best: { route: RouteGeometry; projection: Projection } | undefined;
    // A railway car rides a railway route (and a coaster car a coaster one), higher over its datum.
    const train = trainChassis.has(car.chassis.index);
    for (const route of routes) {
      const railway = tracks.routes[route.index]!.family === 'train';
      // A railway car never rides a coaster route; a wheeled cart (4204's
      // mine carts) may ride a railway one when it stands square over it.
      if (train && !railway) continue;
      const projection = projectOntoPolyline(route.points, route.cumulative, car.frame.originLdu);
      if (projection.distance > (railway ? TRAIN_ON_ROUTE_MAX_LDU : CAR_ON_ROUTE_MAX_LDU)) continue;
      if (railway) {
        const d = sub(car.frame.originLdu, projection.point), t = projection.tangent;
        const lateral = Math.abs(dot(d, unit([t[2], 0, -t[0]])));
        if (lateral > TRAIN_LATERAL_MAX_LDU || dot(d, [0, -1, 0]) <= 0) continue;
      }
      if (!best || projection.distance < best.projection.distance) best = { route, projection };
    }
    if (!best) continue;
    const above = dot(sub(car.frame.originLdu, best.projection.point), car.frame.upWorld);
    // The coaster datum height (platform docking) is measured on coaster cars only.
    if (!train) originHeights.push(above);
    car.route = {
      routeIndex: best.route.index, routeLabel: best.route.label,
      arcLdu: round(best.projection.arc), offsetLdu: round(best.projection.distance), originAboveDatumLdu: round(above),
      heading: dot(car.frame.travelWorld, best.projection.tangent) >= 0 ? 1 : -1,
    };
  }
  const originAboveDatumLdu = originHeights.length ? round(originHeights.reduce((s, v) => s + v, 0) / originHeights.length) : null;

  const trains: CoasterTrain[] = [];
  for (const route of routes) {
    const onRoute = cars.filter(car => car.route?.routeIndex === route.index).sort((a, b) => a.route!.arcLdu - b.route!.arcLdu);
    if (!onRoute.length) continue;
    let group: CoasterCar[] = [onRoute[0]!];
    const flush = (): void => {
      const pitches = group.slice(1).map((car, i) => round(car.route!.arcLdu - group[i]!.route!.arcLdu));
      trains.push({
        routeIndex: route.index, routeLabel: route.label, carIds: group.map(car => car.id), pitchesLdu: pitches,
        meanPitchLdu: pitches.length ? round(pitches.reduce((s, v) => s + v, 0) / pitches.length) : 0,
        extentLdu: round(group.at(-1)!.route!.arcLdu - group[0]!.route!.arcLdu),
        routeLengthLdu: round(route.length), routeClosed: route.closed,
      });
    };
    for (let i = 1; i < onRoute.length; i++) {
      const previous = group.at(-1)!, car = onRoute[i]!;
      const gap = car.route!.arcLdu - previous.route!.arcLdu;
      if (gap > TRAIN_MAX_GAP_FACTOR * Math.max(previous.lengthLdu, car.lengthLdu)) { flush(); group = [car]; }
      else group.push(car);
    }
    flush();
  }

  const strays: CoasterStray[] = [];
  for (const car of cars) {
    if (car.route) continue;
    let nearestId: string | null = null, nearest = Infinity;
    for (const fragment of tracks.fragments) {
      const cumulative = [0];
      for (let i = 1; i < fragment.samples.length; i++) cumulative.push(cumulative[i - 1]! + norm(sub(fragment.samples[i]!, fragment.samples[i - 1]!)));
      const d = projectOntoPolyline(fragment.samples, cumulative, car.frame.originLdu).distance;
      if (d < nearest) { nearest = d; nearestId = fragment.id; }
    }
    strays.push({ car, nearestFragmentId: nearestId, nearestFragmentDistanceLdu: Number.isFinite(nearest) ? round(nearest) : null });
  }
  if (!cars.length) warnings.push('No rolling chassis found: no non-figure brick carries two wheel-described parts and no part describes itself as wheeled.');
  else if (!trains.length) warnings.push(`${cars.length} rolling chassis found but none within ${CAR_ON_ROUTE_MAX_LDU} LDU of an extracted route.`);

  // ── 4. Lifts ──────────────────────────────────────────────────────────────
  const lifts: CoasterLift[] = [];
  const carMember = (i: number): boolean => memberOf.has(i) && chassisSet.has(memberOf.get(i)!);
  for (const route of routes) {
    const under = (i: number): Projection | undefined => {
      const p = originOf(bricks[i]!);
      const projection = projectOntoPolyline(route.points, route.cumulative, p);
      const offset = sub(p, projection.point);
      // Lateral is measured along the track's HORIZONTAL normal (tangent x up):
      // on a grade the perpendicular offset of a part straight under the rails
      // has a large along-slope x component that is not sideways at all. The
      // remainder's world-Y component says how far under the datum it sits.
      const t = projection.tangent;
      const horizontalNormal = unit([t[2], 0, -t[0]]);
      const lateral = norm(horizontalNormal) > 0 ? Math.abs(dot(offset, horizontalNormal)) : Math.hypot(offset[0], offset[2]);
      const below = norm(horizontalNormal) > 0 ? offset[1] - dot(offset, horizontalNormal) * horizontalNormal[1] : offset[1];
      if (lateral > LIFT_LATERAL_MAX_LDU || below > LIFT_BELOW_MAX_LDU || below < -LIFT_ABOVE_MAX_LDU) return undefined;
      return projection;
    };
    const sprockets = sprocketIndices.filter(i => !carMember(i)).map(i => ({ i, p: under(i), link: false })).filter((x): x is { i: number; p: Projection; link: false } => !!x.p);
    const links = chainIndices.filter(i => !carMember(i)).map(i => ({ i, p: under(i), link: true })).filter((x): x is { i: number; p: Projection; link: true } => !!x.p);
    const drive = [...sprockets, ...links].sort((a, b) => a.p.arc - b.p.arc);
    if (!drive.length) continue;
    // One drive per GRADE: a chain follows a single climb, so consecutive
    // drive parts join a cluster only when the route between them rises
    // monotonically (within 2 LDU of sag) and not further apart than a lift
    // spans. 10261's circuit also has a station gear under the platform
    // straight 1,415 LDU before its bottom pulley with a 72 LDU dip between;
    // by arc gap alone it pooled with the hill and shifted the measured foot
    // of the lift. A closed route's clusters wrap through the seam.
    const monotoneClimb = (fromArc: number, toArc: number): boolean => {
      let previous = pointAtArc(route, fromArc)[1];
      const steps = Math.max(2, Math.ceil(Math.abs(toArc - fromArc) / 10));
      for (let s = 1; s <= steps; s++) {
        const y = pointAtArc(route, fromArc + (toArc - fromArc) * s / steps)[1];
        if (y > previous + 2) return false; // LDraw Y down: a larger y is lower
        previous = Math.min(previous, y);
      }
      return true;
    };
    const joins = (a: number, b: number): boolean => b - a <= LIFT_CLUSTER_GAP_LDU && (monotoneClimb(a, b) || monotoneClimb(b, a));
    const clusters: Array<typeof drive> = [];
    for (const part of drive) {
      const current = clusters.at(-1);
      if (current && joins(current.at(-1)!.p.arc, part.p.arc)) current.push(part);
      else clusters.push([part]);
    }
    if (route.closed && clusters.length > 1) {
      const first = clusters[0]!, last = clusters.at(-1)!;
      const wrapGap = route.length - last.at(-1)!.p.arc + first[0]!.p.arc;
      const wrapClimb = (): boolean => {
        // Unwrap: sample the seam-crossing span as one run.
        const from = last.at(-1)!.p.arc, to = route.length + first[0]!.p.arc;
        const at = (arc: number): number => pointAtArc(route, arc % route.length)[1];
        const steps = Math.max(2, Math.ceil((to - from) / 10));
        let up = true, down = true, previous = at(from);
        for (let s = 1; s <= steps; s++) { const y = at(from + (to - from) * s / steps); if (y > previous + 2) up = false; if (y < previous - 2) down = false; previous = y; }
        return up || down;
      };
      if (wrapGap <= LIFT_CLUSTER_GAP_LDU && wrapClimb()) { clusters.shift(); last.push(...first); }
    }
    for (const cluster of clusters) {
      // A cluster that wraps the seam is measured on the unwrapped arc.
      const wraps = route.closed && cluster.length > 1 && cluster[0]!.p.arc > cluster.at(-1)!.p.arc;
      const arcs = cluster.map(x => wraps && x.p.arc >= cluster[0]!.p.arc ? x.p.arc - route.length : x.p.arc);
      const arcStart = Math.min(...arcs), arcEnd = Math.max(...arcs);
      const at = (arc: number): V => pointAtArc(route, route.closed ? ((arc % route.length) + route.length) % route.length : arc);
      const rise = at(arcStart)[1] - at(arcEnd)[1]; // LDraw Y down: positive = climbs with arc
      const describe = cluster.map(x => `${bricks[x.i]!.part.replace(/\.dat$/i, '')}@${round(x.p.arc, 0)}`).join(' ');
      if (cluster.length < 2 || Math.abs(rise) < LIFT_MIN_RISE_LDU) {
        warnings.push(`${route.label}: ${cluster.length} chain-drive part(s) under the running line (${describe}) span ${round(Math.abs(rise), 1)} LDU of rise (a lift needs two parts and ${LIFT_MIN_RISE_LDU}); not a lift.`);
        continue;
      }
      lifts.push({
        kind: 'chain', routeIndex: route.index, routeLabel: route.label,
        arcStartLdu: round(((arcStart % route.length) + route.length) % route.length), arcEndLdu: round(arcEnd), riseLdu: round(Math.abs(rise)),
        climbDirection: rise > 0 ? 1 : -1,
        sprockets: cluster.filter(x => !x.link).map(x => x.i), links: cluster.filter(x => x.link).map(x => x.i),
      });
    }
  }
  const datumAboveRailTopLdu = measureDatumAboveRailTop(bricks, meshes);
  lifts.push(...detectPlatformLifts(bricks, meshes, routes, cars, memberOf, isFigureBrick, isTrackMould,
    options.originAboveDatumLdu ?? originAboveDatumLdu ?? DEFAULT_ORIGIN_ABOVE_DATUM_LDU, datumAboveRailTopLdu ?? DEFAULT_DATUM_ABOVE_RAIL_TOP_LDU, warnings));
  if (!lifts.length) warnings.push('No lift detected: no chain drive under a climbing route section and no articulated platform docked at an open terminal.');

  return { cars, trains, strays, lifts, originAboveDatumLdu, datumAboveRailTopLdu, warnings };
}

// ─── Platform lift ───────────────────────────────────────────────────────────

interface FrameGroup { key: string; tilt: readonly number[]; members: number[] }

/** Group off-grid bricks by their tilt frame T = rot · snap(rot)ᵀ, quantised. */
function offGridFrameGroups(bricks: readonly ParsedBrick[], eligible: (i: number) => boolean): FrameGroup[] {
  const groups = new Map<string, FrameGroup>();
  bricks.forEach((b, i) => {
    if (!eligible(i)) return;
    const rot = rotOf(b);
    if (snapSignedPermutation(rot, GRID_SNAP_EPS)) return;
    const permutation = snapSignedPermutation(rot, FRAME_SNAP_EPS);
    if (!permutation) return;
    const tilt = mul(rot, transpose(permutation));
    const key = tilt.map(v => (Math.round(v / FRAME_QUANTUM) * FRAME_QUANTUM).toFixed(3)).join(',');
    const group = groups.get(key) ?? groups.set(key, { key, tilt, members: [] }).get(key)!;
    group.members.push(i);
  });
  return [...groups.values()].filter(g => g.members.length >= PLATFORM_MIN_MEMBERS).sort((a, b) => b.members.length - a.members.length);
}

function detectPlatformLifts(
  bricks: readonly ParsedBrick[], meshes: ReadonlyMap<string, LdrawPartMesh | null>, routes: RouteGeometry[],
  cars: readonly CoasterCar[], memberOf: ReadonlyMap<number, number>, isFigureBrick: (i: number) => boolean,
  isTrackMould: (i: number) => boolean, originAboveDatum: number, datumAboveRailTop: number, warnings: string[],
): CoasterPlatformLift[] {
  const open = routes.filter(route => !route.closed && route.points.length >= 2);
  if (!open.length) return [];
  const terminals = open.flatMap(route => (['start', 'end'] as const).map(end => {
    const point = end === 'start' ? route.points[0]! : route.points.at(-1)!;
    const next = end === 'start' ? route.points[1]! : route.points.at(-2)!;
    return { route, end, point, outward: unit(sub(point, next)) };
  }));
  const groups = offGridFrameGroups(bricks, i => !isFigureBrick(i) && !isTrackMould(i) && !memberOf.has(i));
  // A car's origin rides (origin over datum) + (datum over rail top) above whatever its wheels run on.
  const carOriginAboveRail = originAboveDatum + datumAboveRailTop;
  const referenceCar = cars.find(car => car.route) ?? cars[0];
  const treadBand = (cars.find(car => car.route && car.wheelGeometry) ?? cars.find(car => car.wheelGeometry))?.wheelGeometry?.treadBandLdu;
  const found: CoasterPlatformLift[] = [];
  for (const group of groups) {
    const tilt = group.tilt;
    const origin: V = (() => {
      const sum = group.members.reduce((s, i) => add(s, originOf(bricks[i]!)), [0, 0, 0] as V);
      return scale(sum, 1 / group.members.length);
    })();
    const extent = emptyBox();
    const memberBoxes = group.members.map(i => {
      const box = boundsInFrame(bricks[i]!, meshes.get(bricks[i]!.part), tilt, origin);
      growBox(extent, box.min); growBox(extent, box.max);
      return { i, box };
    });
    // Long axis of the group in its own frame: X or Z, whichever spans more.
    const longAxis = (extent.max[0] - extent.min[0]) >= (extent.max[2] - extent.min[2]) ? 0 : 2;
    const lateralAxis = longAxis === 0 ? 2 : 0;
    const lateralCentre = (extent.min[lateralAxis] + extent.max[lateralAxis]) / 2;
    // Rails: each member's TOP FACE (from its triangles) in the platform frame.
    // With a ride car's wheel geometry, the running surface is the highest
    // top-face level that lies under the wheel tread band on BOTH sides and
    // covers at least half the platform's length. 10303's 24869 tread runs at
    // |lateral| 24-33; the platform's 30413 panels put a 4 LDU wall at 27-31
    // whose top (local y -31.8) the wheels ride, with the flange guided
    // inside the wall - exactly how they ride the real rail ridge. A box test
    // could not tell that wall top from the panel base 16 LDU lower; without
    // wheel geometry the fallback is the level with the largest top area
    // inside the car's width (the 11212 deck here, 24 LDU lower).
    const faces = memberBoxes.map(({ i }) => ({ i, face: topFaceInFrame(bricks[i]!, meshes.get(bricks[i]!.part), tilt, origin) }));
    const halfWidth = (referenceCar?.widthLdu ?? 80) / 2;
    const platformLength = extent.max[longAxis] - extent.min[longAxis];
    const levels: Array<{ top: number; members: number[]; plus: number; minus: number; area: number; min: number; max: number }> = [];
    for (const { i, face } of faces) {
      const level = levels.find(l => Math.abs(l.top - face.top) <= 1) ?? levels[levels.push({ top: face.top, members: [], plus: 0, minus: 0, area: 0, min: Infinity, max: -Infinity }) - 1]!;
      const lo = face.min[lateralAxis] - lateralCentre, hi = face.max[lateralAxis] - lateralCentre;
      const length = face.max[longAxis] - face.min[longAxis];
      if (treadBand) {
        const onPlus = hi >= treadBand[0] && lo <= treadBand[1], onMinus = lo <= -treadBand[0] && hi >= -treadBand[1];
        if (!onPlus && !onMinus) continue;
        if (onPlus) level.plus += length;
        if (onMinus) level.minus += length;
      } else {
        if (hi < -halfWidth || lo > halfWidth) continue;
        level.area += length * (hi - lo);
      }
      level.members.push(i);
      level.min = Math.min(level.min, face.min[longAxis]);
      level.max = Math.max(level.max, face.max[longAxis]);
    }
    const rails = treadBand
      ? levels.filter(l => l.plus >= PLATFORM_RAIL_MIN_COVERAGE * platformLength && l.minus >= PLATFORM_RAIL_MIN_COVERAGE * platformLength).sort((p, q) => p.top - q.top)[0]
      : levels.filter(l => l.members.length).sort((p, q) => q.area - p.area || p.top - q.top)[0];
    if (!rails) continue;
    const deckTop = rails.top, deckMin = rails.min, deckMax = rails.max;
    const localA: V = longAxis === 0 ? [deckMin, deckTop, lateralCentre] : [lateralCentre, deckTop, deckMin];
    const localB: V = longAxis === 0 ? [deckMax, deckTop, lateralCentre] : [lateralCentre, deckTop, deckMax];
    const deckA = add(origin, apply(tilt, localA)), deckB = add(origin, apply(tilt, localB));
    const upWorld = unit(apply(tilt, [0, -1, 0]));
    const carLineA = add(deckA, scale(upWorld, carOriginAboveRail)), carLineB = add(deckB, scale(upWorld, carOriginAboveRail));
    // Parked dock: the terminal whose car-origin point is nearest either deck end, end-on.
    let parked: CoasterPlatformDock | undefined;
    let parkedTerminal: typeof terminals[number] | undefined;
    for (const terminal of terminals) {
      // A car's origin rides `originAboveDatum` over the running line, straight up in the model (LDraw -Y).
      const target = add(terminal.point, [0, -originAboveDatum, 0]);
      for (const [deckEnd, point] of [['a', carLineA], ['b', carLineB]] as const) {
        const misfit = sub(target, point);
        const distance = norm(misfit);
        if (distance > PLATFORM_DOCK_MAX_LDU) continue;
        if (parked && distance >= parked.misfitDistanceLdu) continue;
        parked = { routeIndex: terminal.route.index, routeLabel: terminal.route.label, end: terminal.end, terminalLdu: roundV(terminal.point),
          terminalCarOriginLdu: roundV(target), deckEnd, deckCarOriginLdu: roundV(point), misfitLdu: roundV(misfit), misfitDistanceLdu: round(distance) };
        parkedTerminal = terminal;
      }
    }
    if (!parked || !parkedTerminal) continue;
    // Delivery: the same route's OTHER open terminal. The platform translates along
    // a world axis; the deck's car-origin line is evaluated at the terminal's
    // along-deck coordinate, so a tip that overhangs the deck end is measured, not assumed.
    const other = terminals.find(t => t.route === parkedTerminal!.route && t.end !== parkedTerminal!.end);
    if (!other) { warnings.push(`Platform group of ${group.members.length} docks at ${parked.routeLabel}:${parked.end} but the route has no other open terminal to deliver to.`); continue; }
    const target = add(other.point, [0, -originAboveDatum, 0]);
    // The terminal's position ALONG the deck is its horizontal projection: the
    // deck is tilted, and projecting the ~1,850 LDU vertical displacement onto
    // the tilted direction would slide the delivery point 130 LDU along it.
    const deckDir = unit(sub(carLineB, carLineA));
    const deckDirH = unit([deckDir[0], 0, deckDir[2]]);
    const deckLengthH = dot(sub(carLineB, carLineA), deckDirH);
    const alongH = dot(sub(target, carLineA), deckDirH);
    const alongT = Math.max(0, Math.min(deckLengthH, alongH)) / deckLengthH;
    const onDeck = add(carLineA, scale(sub(carLineB, carLineA), alongT));
    const delta = sub(target, onDeck);
    // Travel axis: the dominant world axis of the displacement; the rest is reported as misfit.
    const axisIndex = [0, 1, 2].sort((p, q) => Math.abs(delta[q]!) - Math.abs(delta[p]!))[0]!;
    const axisWorld: V = [0, 0, 0].map((_, k) => k === axisIndex ? Math.sign(delta[axisIndex]!) : 0) as unknown as V;
    const distance = Math.abs(delta[axisIndex]!);
    const deliveredPoint = add(onDeck, scale(axisWorld, distance));
    const misfit = sub(target, deliveredPoint);
    const deliveredEnd: 'a' | 'b' = alongT <= .5 ? 'a' : 'b';
    // A platform that would not meet the other terminal after its translation
    // is not the lift (10303's 21-part 9.5-degree Technic lever at the station
    // docks at the route start by proximity and lands 411 LDU from the tip).
    if (norm(misfit) > PLATFORM_DOCK_MAX_LDU) {
      warnings.push(`Off-grid group of ${group.members.length} (tilt ${round(Math.acos(Math.max(-1, Math.min(1, (tilt[0]! + tilt[4]! + tilt[8]! - 1) / 2))) * 180 / Math.PI, 1)} deg) docks at ${parked.routeLabel}:${parked.end} within ${parked.misfitDistanceLdu} LDU but would miss ${other.route.label}:${other.end} by ${round(norm(misfit))} LDU after a ${round(distance)} LDU translation; not a lift platform.`);
      continue;
    }
    const tiltAngle = Math.acos(Math.max(-1, Math.min(1, (tilt[0]! + tilt[4]! + tilt[8]! - 1) / 2))) * 180 / Math.PI;
    found.push({
      kind: 'platform',
      bricks: group.members,
      frame: { originLdu: roundV(origin), rot: tilt, travelWorld: roundV(unit(apply(tilt, longAxis === 0 ? [1, 0, 0] : [0, 0, 1]))), upWorld: roundV(upWorld) },
      extentLocalLdu: { min: roundV(extent.min), max: roundV(extent.max) },
      tiltDeg: round(tiltAngle, 2),
      deck: { aLdu: roundV(deckA), bLdu: roundV(deckB), railTopLocalY: round(deckTop), memberCount: rails.members.length, rule: treadBand ? 'wheel-tread-band' : 'largest-top-area' },
      carOriginAboveRailLdu: round(carOriginAboveRail),
      parked,
      travel: {
        axisWorld, distanceLdu: round(distance),
        betweenTerminalsLdu: round(Math.abs(target[axisIndex]! - parked.terminalCarOriginLdu[axisIndex]!)),
        deliveredAt: { routeIndex: other.route.index, routeLabel: other.route.label, end: other.end, terminalLdu: roundV(other.point),
          terminalCarOriginLdu: roundV(target), deckEnd: deliveredEnd, deckCarOriginLdu: roundV(deliveredPoint), misfitLdu: roundV(misfit), misfitDistanceLdu: round(norm(misfit)) },
      },
    });
    if (!treadBand) warnings.push('Platform rails were taken as the largest top area inside the car width: no ride car exposes separate wheel parts, so the wheel tread band is unknown.');
  }
  return found;
}
