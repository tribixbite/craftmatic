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
import { connectedClusters, isSeat, touchingIndices } from './ldraw-entity-compiler.js';
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
    // A boat takes its loose oars with it.
    const members = [...new Set([...cluster, ...riders, ...(kind === 'boat' ? oars.filter(i => !claimed.has(i)) : [])])];
    for (const i of members) claimed.add(i);
    const n = kind === 'car' ? ++cars : ++boats;
    components.push({
      id: `${kind}_${n}`, label: kind === 'car' ? `Car ${n}` : `Boat ${n}`, kind, bricks: members.map(i => bricks[i]!),
      provenance: `vehicle standing in the scene: ${members.length} placements that ${reason}`,
    });
  }
  return { components, candidates };
}
