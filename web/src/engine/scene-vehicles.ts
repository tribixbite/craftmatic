/**
 * Vehicles standing inside a scene: the cars on a town's street, the boats at
 * a market's quay. A set titled as a building ("Downtown", "Medieval Seaside
 * Market") never reached the vehicle path - its title names no vehicle - so
 * the vehicles it carries shipped as part of the static shell (vehicle audit,
 * 2026-09-25). This finds them from the geometry, in any source shape
 * (flattened converters carry no submodel names to go by):
 *
 *   1. the scene's GROUND is set aside: every flat part (a plate, tile or
 *      baseplate, at most `GROUND_MAX_HEIGHT` LDU tall) lying on the model's
 *      lowest layer - the road, the quay, the water;
 *   2. what is left splits into physically separate objects on real part
 *      bounds (`connectedClusters`, the compiler's own contact rule): a car
 *      parked on the road or a boat on the water is no longer joined to the
 *      building beside it through the floor they share;
 *   3. an object is a CAR when it stands on its own wheels - at least
 *      `CAR_MIN_WHEELS` distinct wheel positions at its bottom, or two with a
 *      steering wheel or a seat in it - and a BOAT when it carries a pair of
 *      oars, a hull, a rudder or a sail; either way it must be small beside
 *      the scene (`MAX_SHARE`) and big enough to be a vehicle (`MIN_PARTS`).
 *
 * Every object considered is reported with its verdict and why, so a miss or
 * a false find is inspectable in the export warnings.
 */
import type { ParsedBrick } from './ldraw-parser.js';
import { classifiedDescription, type LdrawPartMesh, type Vec3 } from './ldraw-part-geometry.js';
import { connectedClusters, isFigurePart, isSeat, touchingIndices } from './ldraw-entity-compiler.js';
import { getPartDims } from './ldraw-part-dims.js';
import type { PlayableBrickComponent, PlayableKind } from './playable-components.js';

/** Every tuned number of the finder, in LDU unless named otherwise. */
export const SCENE_VEHICLES = {
  /** A ground part is at most this tall (a plate is 8, a tile 8, a baseplate 4). */
  GROUND_MAX_HEIGHT: 8,
  /** A ground part's top lies within this of the scene's lowest layer top. */
  GROUND_LAYER_SLACK: 12,
  /** Contact tolerance of the object split (the compiler's `connectedClusters` default). */
  CONTACT: 4,
  /** A vehicle is at most this share of the scene's placements. */
  MAX_SHARE: 0.25,
  /** ... and at least this many placements. */
  MIN_PARTS: 8,
  /** Distinct wheel positions a car stands on (a tyre and its rim count once: `WHEEL_MERGE`). */
  CAR_MIN_WHEELS: 3,
  /** A tyre and a rim closer than this are one wheel. */
  WHEEL_MERGE: 30,
  /** A wheel counts as one the object STANDS on when its bottom is within this of the object's bottom. */
  WHEEL_BOTTOM_SLACK: 16,
  /** Oars a rowing boat carries. */
  BOAT_MIN_OARS: 2,
  /** Oars count for an object when they lie within this of its box (a loose oar in the hull, a figure's oar alongside). */
  OAR_REACH: 60,
  /** A part lying within this of an object's box (and not under its bottom) is claimed by it. */
  CLAIM_SLACK: 6,
  /** How far below an object's lowest part its wheels may reach (a tyre under the chassis). */
  WHEEL_HANG: 40,
  /** A separate object this small standing on a vehicle rides with it (a figure is ~10 placements). */
  RIDER_MAX_PARTS: 40,
  /** A vehicle's long side is at least this (6 studs): a 4-stud barrow or pram is scenery a player cannot sit in. */
  MIN_LENGTH: 120,
  /** A flat part bigger than this (8 x 8 studs, LDU²) is scene ground, never a vehicle's floor. */
  FLOOR_PATCH_MAX_AREA: 160 * 160,
  /**
   * A WHOLE-MODEL car (`findWholeModelVehicles`) is no taller than its longest
   * horizontal side: 51515's robot on 8 wheels is 865 LDU tall over a 526 LDU
   * base, every car of the 2026-11-06 census at most 0.9 of its length.
   */
  WHOLE_MAX_HEIGHT_TO_LENGTH: 1,
  /** ... stands on at least this many distinct wheels (31141 Main Street's building stands on 3 with a seat in it). */
  WHOLE_MIN_WHEELS: 4,
  /** ... whose centres spread over at least this share of its long side (a car's axles sit near its ends). */
  WHOLE_MIN_WHEEL_SPREAD: 0.5,
  /**
   * A TITLED vehicle's model leaves out what stands apart from it (`vehicleApartFromScenery`) only when the vehicle
   * holds at least this share of the placements: 42663's camper beside its picnic, never a scene of equals.
   */
  APART_MIN_VEHICLE_SHARE: 0.5,
} as const;
export type SceneVehicleParams = { readonly [K in keyof typeof SCENE_VEHICLES]: number };

/** One separate object of the scene and what the finder decided about it. */
export interface SceneVehicleCandidate {
  kind: PlayableKind | null;
  parts: number;
  /** Centre and size of its box, LDU. */
  centre: Vec3; size: Vec3;
  wheels: number; oars: number; hull: number; steering: number; seats: number;
  reason: string;
}

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
/** The wording to classify by: a retired mould's target description (`~Moved to 3069b` reads as the tile). */
const desc = (mesh: LdrawPartMesh | null | undefined): string => (mesh ? classifiedDescription(mesh) : '').replace(/^[~=_]+\s*/, '');
const isWheel = (d: string): boolean => /^(Wheel|Tyre|Tire)\b/i.test(d) && !/^Wheel (Holder|Arch|Cover|Hub|Centre|Center)/i.test(d);
const isOar = (d: string): boolean => /\bOar\b|\bPaddle\b/i.test(d);
const isHull = (d: string): boolean => /^Boat\b|\bHull\b|\bRudder\b|^Sail\b|\bSail \d/i.test(d);
const isSteering = (d: string): boolean => /\bSteering Wheel\b/i.test(d);
/** Railway and coaster track, and the chassis of a ride car or train (their own engine moves them). */
const isRailPart = (d: string): boolean => /\b(Train (Base|Wheel|Track|Rail)|Roller Coaster|Coaster|Track|Rail \d|Monorail)\b/i.test(d);

type Box = { min: Vec3; max: Vec3 };
const area = (b: Box): number => (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]);
const boxOf = (list: Box[]): Box => {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of list) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, b.min[k]!); max[k] = Math.max(max[k]!, b.max[k]!); }
  return { min, max };
};

/** A placement's world box from its part's mesh bounds (a part with no mesh: its nominal size). */
export function placementBox(b: ParsedBrick, mesh: LdrawPartMesh | null | undefined): { min: Vec3; max: Vec3 } {
  let lo: Vec3, hi: Vec3;
  if (mesh && mesh.triangles.length) { lo = mesh.bounds.min; hi = mesh.bounds.max; }
  else { const [w, h, l] = getPartDims(b.part); lo = [-l * 10, -h * 8, -w * 10]; hi = [l * 10, 0, w * 10]; }
  const m = b.rot ?? IDENTITY;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const p: Vec3 = [m[0]! * x + m[1]! * y + m[2]! * z + b.x, m[3]! * x + m[4]! * y + m[5]! * z + b.y, m[6]! * x + m[7]! * y + m[8]! * z + b.z];
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k]!, p[k]!); max[k] = Math.max(max[k]!, p[k]!); }
  }
  return { min, max };
}

/**
 * Find the vehicles standing in a scene. `bricks` are the scene's placements
 * (the caller leaves out anything already claimed); `meshes` their resolved
 * parts. Returns rideable components (each the object's exact placements) and
 * the verdict on every object considered.
 */
export function findSceneVehicles(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, P: SceneVehicleParams = SCENE_VEHICLES): { components: PlayableBrickComponent[]; candidates: SceneVehicleCandidate[] } {
  if (bricks.length < P.MIN_PARTS * 2) return { components: [], candidates: [] };
  const boxes = bricks.map(b => placementBox(b, meshes.get(b.part)));
  // 1. The ground: flat parts on the lowest layer (LDraw y is DOWN: the lowest layer has the largest y).
  const floor = Math.max(...boxes.map(bx => bx.max[1]));
  const lowestTop = Math.max(...boxes.filter(bx => bx.max[1] >= floor - 1).map(bx => bx.min[1]));
  const ground = new Set<number>();
  boxes.forEach((bx, i) => { if (bx.max[1] - bx.min[1] <= P.GROUND_MAX_HEIGHT && bx.min[1] >= lowestTop - P.GROUND_LAYER_SLACK) ground.add(i); });
  const rest = bricks.map((_, i) => i).filter(i => !ground.has(i));
  // 2. Separate objects.
  let clusters = connectedClusters(rest.map(i => boxes[i]!), P.CONTACT).map(c => c.map(k => rest[k]!));
  // 2b. A flat part on the lowest layer can be a vehicle's OWN floor - a
  //     boat's keel plates, the plate a car's axle pins stand in - rather than
  //     the scene's ground. Such a part lies inside the footprint of what
  //     stands on it, and what stands on it is small: every object touching it
  //     is merged with it when their joint box covers it and they are still
  //     no bigger than a vehicle. A road or base plate reaches past what
  //     stands on it, or carries a building, and stays ground.
  const clusterOf = new Map<number, number>();
  clusters.forEach((c, k) => { for (const i of c) clusterOf.set(i, k); });
  /** Glue the flat parts `floorParts` to the objects standing on them, when they are one small object's floor. */
  const glue = (floorParts: number[]): boolean => {
    const touching = new Set(touchingIndices(boxes, floorParts, [...clusterOf.keys()], P.CONTACT).map(i => clusterOf.get(i)!));
    if (!touching.size) return false;
    // One object and its loose bits (a wheel, a tyre): two real objects sharing a plate stay apart.
    if ([...touching].filter(k => clusters[k]!.length >= P.MIN_PARTS).length > 1) return false;
    const members = [...touching].flatMap(k => clusters[k]!);
    if (members.length + floorParts.length > bricks.length * P.MAX_SHARE) return false;
    const box = boxOf(members.map(i => boxes[i]!));
    const G = boxOf(floorParts.map(i => boxes[i]!));
    if (G.min[0] < box.min[0] - P.CONTACT || G.max[0] > box.max[0] + P.CONTACT || G.min[2] < box.min[2] - P.CONTACT || G.max[2] > box.max[2] + P.CONTACT) return false;
    const into = Math.min(...touching);
    for (const k of touching) if (k !== into) { for (const i of clusters[k]!) clusterOf.set(i, into); clusters[into]!.push(...clusters[k]!); clusters[k] = []; }
    for (const g of floorParts) { clusters[into]!.push(g); clusterOf.set(g, into); ground.delete(g); }
    return true;
  };
  // A floor of several plates (a boat's keel) is judged whole first; what does
  // not glue as a patch (it touches the scene's own ground plates) plate by plate.
  // A baseplate or a big road plate is never part of a floor patch (the keel lies ON it).
  const groundList = [...ground].filter(i => area(boxes[i]!) <= P.FLOOR_PATCH_MAX_AREA);
  for (const patch of connectedClusters(groundList.map(i => boxes[i]!), P.CONTACT).map(c => c.map(k => groundList[k]!))) {
    if (patch.length > 1 && glue(patch)) continue;
    for (const g of patch.sort((a, b) => area(boxes[a]!) - area(boxes[b]!))) glue([g]);
  }
  clusters = clusters.filter(c => c.length);
  const oarAt = bricks.map((b, i) => isOar(desc(meshes.get(b.part))) ? i : -1).filter(i => i >= 0);
  const components: PlayableBrickComponent[] = [];
  const candidates: SceneVehicleCandidate[] = [];
  let cars = 0, boats = 0;
  const claimed = new Set<number>();
  const d = (i: number): string => desc(meshes.get(bricks[i]!.part));
  for (const base of clusters) {
    if (base.length < P.MIN_PARTS || base.length > bricks.length * P.MAX_SHARE) continue;
    // 3a. Claim what belongs to the object but touched something bigger: its
    //     wheels (a tyre resting on the road joins the road's cluster) and
    //     then any part lying wholly inside its box and not under its bottom
    //     (the axle plate the wheels hang from). A road or wall reaches past
    //     the box and stays where it is.
    const own = new Set(base.filter(i => !claimed.has(i)));
    const inside = (i: number, box: Box, below: number): boolean => {
      const b = boxes[i]!, s = P.CLAIM_SLACK;
      return b.min[0] >= box.min[0] - s && b.max[0] <= box.max[0] + s && b.min[2] >= box.min[2] - s && b.max[2] <= box.max[2] + s
        && b.min[1] >= box.min[1] - s && b.max[1] <= box.max[1] + below;
    };
    let box = boxOf([...own].map(i => boxes[i]!));
    for (let i = 0; i < bricks.length; i++) if (!own.has(i) && !claimed.has(i) && isWheel(d(i)) && inside(i, box, P.WHEEL_HANG)) own.add(i);
    box = boxOf([...own].map(i => boxes[i]!));
    for (let i = 0; i < bricks.length; i++) if (!own.has(i) && !claimed.has(i) && !ground.has(i) && inside(i, box, P.CLAIM_SLACK)) own.add(i);
    const cluster = [...own];
    if (cluster.length > bricks.length * P.MAX_SHARE) continue;
    const { min, max } = boxOf(cluster.map(i => boxes[i]!));
    // Wheels it stands on: level with its lowest wheel, which is at its bottom
    // (within `WHEEL_HANG`: a loose part touching it may reach lower - the
    // compiler's display-stand rule drops it from the car); a tyre and its rim
    // merged into one position.
    const wheelBottoms = cluster.filter(i => isWheel(d(i))).map(i => boxes[i]!.max[1]);
    const lowestWheel = wheelBottoms.length ? Math.max(...wheelBottoms) : -Infinity;
    const wheelParts = lowestWheel >= max[1] - P.WHEEL_HANG ? cluster.filter(i => isWheel(d(i)) && boxes[i]!.max[1] >= lowestWheel - P.WHEEL_BOTTOM_SLACK) : [];
    const positions: Vec3[] = [];
    for (const i of wheelParts) {
      const c: Vec3 = [(boxes[i]!.min[0] + boxes[i]!.max[0]) / 2, (boxes[i]!.min[1] + boxes[i]!.max[1]) / 2, (boxes[i]!.min[2] + boxes[i]!.max[2]) / 2];
      if (!positions.some(p => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < P.WHEEL_MERGE)) positions.push(c);
    }
    const steering = cluster.filter(i => isSteering(d(i))).length;
    const seats = cluster.filter(i => isSeat(bricks[i]!.part, d(i))).length;
    const hull = cluster.filter(i => isHull(d(i))).length;
    // Oars lying in or beside it (an oar is often a figure's, standing apart from the hull).
    const oars = oarAt.filter(i => boxes[i]!.max[0] >= min[0] - P.OAR_REACH && boxes[i]!.min[0] <= max[0] + P.OAR_REACH && boxes[i]!.max[2] >= min[2] - P.OAR_REACH && boxes[i]!.min[2] <= max[2] + P.OAR_REACH && boxes[i]!.max[1] >= min[1] - P.OAR_REACH && boxes[i]!.min[1] <= max[1] + P.OAR_REACH);
    let kind: PlayableKind | null = null, reason: string;
    const rail = cluster.filter(i => isRailPart(d(i))).length;
    if (rail) {
      // Ride cars and trains run on their track (coaster-assemblies.ts, the rail path), never as free vehicles.
      reason = `${rail} track or ride-car part${rail === 1 ? '' : 's'}: the rail engine's`;
    } else if (Math.max(max[0] - min[0], max[2] - min[2]) < P.MIN_LENGTH) {
      reason = `${Math.round(Math.max(max[0] - min[0], max[2] - min[2]))} LDU long: too small to ride`;
    } else if (positions.length >= P.CAR_MIN_WHEELS || (positions.length >= 2 && (steering || seats))) {
      kind = 'car';
      reason = `stands on ${positions.length} wheel${positions.length === 1 ? '' : 's'}${steering ? ' with a steering wheel' : seats ? ' with a seat' : ''}`;
    } else if (oars.length >= P.BOAT_MIN_OARS || hull) {
      kind = 'boat';
      reason = hull ? `${hull} hull, rudder or sail part${hull === 1 ? '' : 's'}` : `${oars.length} oars in or beside it`;
    } else {
      reason = positions.length ? `${positions.length} wheel${positions.length === 1 ? '' : 's'} only, no steering wheel or seat` : 'no wheels, oars or hull';
    }
    const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const round = (v: Vec3): Vec3 => [Math.round(v[0]), Math.round(v[1]), Math.round(v[2])];
    candidates.push({ kind, parts: cluster.length, centre: round(centre), size: round(size), wheels: positions.length, oars: oars.length, hull, steering, seats, reason });
    if (!kind) continue;
    // What rides on it goes with it: a small object (a figure at the oars, a
    // crate) standing within its footprint, its feet between its keel and its top.
    const riders: number[] = [];
    for (const other of clusters) {
      if (other === base || other.length > P.RIDER_MAX_PARTS || other.some(i => claimed.has(i) || own.has(i))) continue;
      const ob = boxOf(other.map(i => boxes[i]!)), r = P.OAR_REACH;
      if (ob.min[0] >= min[0] - r && ob.max[0] <= max[0] + r && ob.min[2] >= min[2] - r && ob.max[2] <= max[2] + r && ob.max[1] >= min[1] && ob.max[1] <= max[1] + P.CLAIM_SLACK) riders.push(...other);
    }
    // A car stands on its wheels: nothing of it reaches below them. A part that
    // does touched the car on the way down to the ground (60380's brick
    // separator lies against its side and down onto the road) and stays.
    const standing = kind === 'car' ? cluster.filter(i => boxes[i]!.max[1] <= lowestWheel + P.CLAIM_SLACK) : cluster;
    // A boat takes its loose oars with it.
    const members = [...new Set([...standing, ...riders, ...(kind === 'boat' ? oars.filter(i => !claimed.has(i)) : [])])];
    for (const i of members) claimed.add(i);
    const n = kind === 'car' ? ++cars : ++boats;
    components.push({
      id: `${kind}_${n}`, label: kind === 'car' ? `Car ${n}` : `Boat ${n}`, kind, bricks: members.map(i => bricks[i]!),
      provenance: `vehicle standing in the scene: ${members.length} placements that ${reason}`,
      fromScene: true,
    });
  }
  return { components, candidates };
}

/**
 * A model that IS a vehicle but whose title names none ("Airshow Aces",
 * "Pagani Utopia", "Police Chase", "Highway Transport"): the scene finder
 * caps a vehicle at `MAX_SHARE` of the scene, so a car that is the whole
 * model was never found, and its title kept it static (VEH-20 census,
 * 2026-11-06: 14 of the 143 sets shipped with no rideable stand on their own
 * wheels). The same finder runs with the cap lifted and keeps only CARS - a
 * whole model with two oars or a sail part is as often a scene's prop (a
 * science kit's iceberg) - no taller than long (`WHOLE_MAX_HEIGHT_TO_LENGTH`).
 * The caller runs it only where the title names no vehicle, no scenery
 * (`isSceneryLabel`: The Batcave stands on its Batmobile's wheels) and the
 * scene search found nothing.
 */
export function findWholeModelVehicles(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, P: SceneVehicleParams = SCENE_VEHICLES): { components: PlayableBrickComponent[]; candidates: SceneVehicleCandidate[] } {
  const found = findSceneVehicles(bricks, meshes, { ...P, MAX_SHARE: 1 });
  const components = found.components.filter(c => {
    // Only what the cap excluded: a smaller car is the scene finder's, and it judged it already.
    if (c.kind !== 'car' || c.bricks.length <= bricks.length * P.MAX_SHARE) return false;
    const boxes = c.bricks.map(b => placementBox(b, meshes.get(b.part)));
    const { min, max } = boxOf(boxes);
    const long = max[0] - min[0] >= max[2] - min[2] ? 0 : 2;
    const length = max[long] - min[long];
    if (max[1] - min[1] > P.WHOLE_MAX_HEIGHT_TO_LENGTH * length) return false;
    // The wheels it stands on (bottoms within `WHEEL_BOTTOM_SLACK` of its lowest), one per position.
    const wheels = boxes.filter((bx, i) => isWheel(desc(meshes.get(c.bricks[i]!.part))) && bx.max[1] >= max[1] - P.WHEEL_BOTTOM_SLACK);
    const centres: Vec3[] = [];
    for (const bx of wheels) {
      const m: Vec3 = [(bx.min[0] + bx.max[0]) / 2, (bx.min[1] + bx.max[1]) / 2, (bx.min[2] + bx.max[2]) / 2];
      if (!centres.some(q => Math.hypot(q[0] - m[0], q[1] - m[1], q[2] - m[2]) < P.WHEEL_MERGE)) centres.push(m);
    }
    if (centres.length < P.WHOLE_MIN_WHEELS) return false;
    const along = centres.map(q => q[long]);
    return Math.max(...along) - Math.min(...along) >= P.WHOLE_MIN_WHEEL_SPREAD * length;
  }).map(c => ({ ...c, provenance: `whole model stands on its own wheels (the title names no vehicle): ${c.provenance.replace(/^vehicle standing in the scene: /, '')}` }));
  return { components, candidates: found.candidates };
}

/**
 * A model whose TITLE names a vehicle but which also carries scenery standing apart from it: 42663 "Friendship
 * Camper Van Adventure" is the camper AND its picnic, and the whole model became one car (audit 2026-11-15,
 * "does not generalise" 2). The title-pair rule (`isVehicleAndPlaceLabel`) needs a place word the title may not
 * have ("Adventure"); this reads the GEOMETRY instead. The scene finder's split (ground set aside, separate
 * objects) runs with the share cap lifted; when exactly one vehicle of the title's kind stands on its wheels (or
 * floats on its hull) and holds at least `APART_MIN_VEHICLE_SHARE` of the placements, the vehicle is that object
 * plus everything over its footprint (a loose roof rack, the plate under it: things ON the vehicle), and what
 * stands wholly BESIDE it is scenery - but only when that scenery is at least `MIN_PARTS` placements that are
 * not figures (a driver figure standing by its car stays with the car, as before).
 * Returns the vehicle's placements, or null to keep the whole model.
 */
export function vehicleApartFromScenery(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, kind: PlayableKind, P: SceneVehicleParams = SCENE_VEHICLES): { bricks: ParsedBrick[]; scenery: ParsedBrick[]; reason: string } | null {
  if (kind !== 'car' && kind !== 'boat') return null;
  const found = findSceneVehicles(bricks, meshes, { ...P, MAX_SHARE: 1 });
  const ofKind = found.components.filter(c => c.kind === kind);
  if (ofKind.length !== 1) return null;
  const core = new Set(ofKind[0]!.bricks);
  if (core.size < bricks.length * P.APART_MIN_VEHICLE_SHARE || core.size >= bricks.length) return null;
  const coreBox = boxOf([...core].map(b => placementBox(b, meshes.get(b.part))));
  const c = P.CONTACT;
  const over = (b: ParsedBrick): boolean => {
    const bx = placementBox(b, meshes.get(b.part));
    return bx.max[0] >= coreBox.min[0] - c && bx.min[0] <= coreBox.max[0] + c && bx.max[2] >= coreBox.min[2] - c && bx.min[2] <= coreBox.max[2] + c;
  };
  const vehicle = bricks.filter(b => core.has(b) || over(b));
  const kept = new Set(vehicle);
  const scenery = bricks.filter(b => !kept.has(b));
  const objects = scenery.filter(b => !isFigurePart(b.part, desc(meshes.get(b.part))));
  if (objects.length < P.MIN_PARTS) return null;
  return { bricks: vehicle, scenery, reason: `${scenery.length} placement${scenery.length === 1 ? '' : 's'} standing apart from the vehicle (${objects.length} not figures) left out of it as the build's scenery; the ${kind} is ${vehicle.length} placements that ${ofKind[0]!.provenance.replace(/^vehicle standing in the scene: \d+ placements that /, '')}` };
}

/**
 * The vehicle a model IS, from its geometry, for sizing it (addon-scale.ts `GeometryVehicle`) and for the
 * pipeline's discovery, which make the same call so the two agree:
 *   - a title naming a whole vehicle (`titledKind`): the vehicle apart from its scenery, else the whole model;
 *   - no vehicle in the title and no scenery word: a whole-model car (`findWholeModelVehicles`), only when the
 *     scene finder found no smaller vehicle (a scene with cars in it is not a car);
 *   - otherwise none.
 */
export function modelVehicleFromGeometry(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, titledKind: PlayableKind | null, sceneryTitle: boolean): { kind: PlayableKind; bricks: ParsedBrick[] } | null {
  if (titledKind) {
    const apart = vehicleApartFromScenery(bricks, meshes, titledKind);
    return { kind: titledKind, bricks: apart ? apart.bricks : bricks };
  }
  if (sceneryTitle || findSceneVehicles(bricks, meshes).components.length) return null;
  const whole = findWholeModelVehicles(bricks, meshes).components;
  return whole.length === 1 ? { kind: whole[0]!.kind, bricks: whole[0]!.bricks } : null;
}
