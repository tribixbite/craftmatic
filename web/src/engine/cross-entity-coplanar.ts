/**
 * Coplanar faces BETWEEN entities of one pack (A-17, 2026-11-15).
 *
 * `separateCoplanarFaces` runs on every compiled entity on its own, so two colours on one plane inside an entity
 * never hatch. But a pack draws many entities together - the shell's lattice chunks, the hinged doors, windows and
 * turntables, figures, pinball parts - and a part that is its own entity shares planes with the shell it sits in: a
 * leaf flush with its frame, a turntable's top on its floor, a figure's foot on a plate. Over the 40 favourites
 * those were 13 of the 30.5 block faces of hatching left after the per-entity pass (`_render_fault_audit.ts`).
 *
 * This pass runs once every entity is compiled and placed: the shell's chunks are FIXED (shipped, shared by every
 * neighbour, and by far the largest), every other placed compiled entity is separated against them and against the
 * entities separated before it (`separateCoplanarAgainst`), and only its own geometry JSON is rewritten.
 *
 * A coaster car's placement record is not where it rests: every car of a train is recorded at the station point and
 * the runtime spaces them along the track. Each car is separated where the runtime PARKS it instead
 * (`coasterParkedCarPoses`: the platform for the first train, the loading bay for a second), when that pose is level
 * - a car drawn pitched or rolled on its bones is not an axis-aligned neighbour of anything. A lift platform and its
 * counterweight rest at their records (the hoist's parked pose). A car is a moving actor: what it meets while it runs
 * is transient, and only the parked pose is drawn for long.
 *
 * A lift ride's car rests at each of its stops (`liftCarRestingPoses`) and is separated at all of them.
 *
 * Still left out: a funfair ring or orbit car (it moves whenever the ride runs, and an orbit never stops), a ride's
 * invisible seat (no geometry), and a figure that rides another actor (`rideOf`, moved onto its seat by the runtime,
 * posed by the seat's sitting animation). Separating those at the record point would push faces against a neighbour
 * they never meet. `TODO(a17-moving)`: separate a seated figure in its seated pose on its seat.
 */
import {
  drawnCubeBox, separateCoplanarAgainst, worldFaces,
  type AuditActor, type BedrockFace, type CoplanarSeparation, type GeoBoneLike, type GeoCubeLike, type GeoEntryLike, type WorldFace,
} from './bedrock-geometry-faces.js';

/** A geometry JSON cube as the compiler writes it (declared box; `inflate` grows it). */
interface JsonCube { origin: number[]; size: number[]; inflate?: number; rotation?: number[]; pivot?: number[]; uv?: unknown }
interface JsonBone { name: string; pivot?: number[]; rotation?: number[]; parent?: string; cubes?: JsonCube[] }
interface JsonGeometry { bones?: JsonBone[] }

/** What a compiled entity ships: its geometry document and, per geometry, the colour it is drawn in. */
export interface ShippedGeometry {
  value: unknown;
  meshes: ReadonlyArray<{ material: { colorId: number; alpha: number }; faceAtlas?: unknown }>;
  /**
   * The compiler's own coplanar record: `offset` is the push its per-entity pass used (`coplanarSeparationOffset` of
   * the entity's finest shipped grain). The cross-entity pass pushes this entity's faces by the same amount, so a model
   * compiled below minifig scale is not pushed a whole grain step onto its next plane against a neighbour. Absent (a
   * rail chunk, a geometry compiled before 2026-11-19): the full `COPLANAR_SEPARATION_UNITS`.
   */
  diagnostics?: { coplanar?: { offset?: number } };
}

/** A shipped geometry read as the audit reads it, and a way to write the separation's edits back into its JSON. */
export interface ShippedGeometryEntry {
  entry: GeoEntryLike;
  /** Write every changed cube's drawn box back onto its JSON cube (declared box moved by the same amount); returns the count. */
  writeBack(): number;
}

const FACES: readonly BedrockFace[] = ['north', 'south', 'east', 'west', 'up', 'down'];
const round2 = (v: number): number => { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; };
const vec = (v: readonly number[] | undefined): [number, number, number] => [v?.[0] ?? 0, v?.[1] ?? 0, v?.[2] ?? 0];

/** The one face a per-face-UV (decal) cube draws, as `addon-appearance` reads it. */
function decalFace(uv: unknown): GeoCubeLike['faceUv'] {
  if (!uv || typeof uv !== 'object' || Array.isArray(uv)) return undefined;
  for (const face of FACES) {
    const f = (uv as Record<string, { uv?: number[]; uv_size?: number[] }>)[face];
    if (f && Array.isArray(f.uv) && Array.isArray(f.uv_size)) return { face, uv: [f.uv[0]!, f.uv[1]!], size: [f.uv_size[0]!, f.uv_size[1]!] };
  }
  return undefined;
}

/**
 * One colour group per geometry of the document (the compiler emits one geometry per colour, `meshes[i]`), each cube
 * as its DRAWN box (`drawnCubeBox`), so a box-UV-inflated cube is measured where it is drawn. Bones are shared by
 * name across the document's geometries (the compiler writes the same pivot and turn in each).
 */
export function shippedGeometryEntry(geo: ShippedGeometry): ShippedGeometryEntry {
  const geometries = ((geo.value as { 'minecraft:geometry'?: JsonGeometry[] })?.['minecraft:geometry'] ?? []);
  const bones = new Map<string, GeoBoneLike>();
  const links: Array<{ json: JsonCube; cube: GeoCubeLike; origin: [number, number, number]; size: [number, number, number] }> = [];
  const entry: GeoEntryLike = { bones: [], groups: [] };
  geometries.forEach((g, i) => {
    const mesh = geo.meshes[i];
    const group: GeoEntryLike['groups'][number] = mesh?.faceAtlas
      ? { ldrawColor: null, alpha: 1, texture: { path: 'faces' }, cubes: [] }
      : { ldrawColor: mesh?.material.colorId ?? null, alpha: mesh?.material.alpha ?? 1, cubes: [] };
    for (const b of g.bones ?? []) {
      if (!bones.has(b.name)) bones.set(b.name, { name: b.name, pivot: vec(b.pivot), ...(b.rotation ? { rotation: vec(b.rotation) } : {}), ...(b.parent ? { parent: b.parent } : {}) });
      for (const json of b.cubes ?? []) {
        const drawn = drawnCubeBox(json);
        const face = decalFace(json.uv);
        const cube: GeoCubeLike = {
          bone: b.name, origin: [...drawn.origin], size: [...drawn.size],
          ...(json.rotation && json.pivot ? { rotation: vec(json.rotation), pivot: vec(json.pivot) } : {}),
          ...(face ? { faceUv: face } : {}),
        };
        group.cubes.push(cube);
        links.push({ json, cube, origin: drawn.origin, size: drawn.size });
      }
    }
    entry.groups.push(group);
  });
  entry.bones = [...bones.values()];
  return {
    entry,
    writeBack(): number {
      let changed = 0;
      for (const { json, cube, origin, size } of links) {
        let moved = false;
        for (let k = 0; k < 3; k++) {
          const dO = cube.origin[k]! - origin[k]!, dS = cube.size[k]! - size[k]!;
          if (Math.abs(dO) > 1e-9) { json.origin[k] = round2(json.origin[k]! + dO); moved = true; }
          if (Math.abs(dS) > 1e-9) { json.size[k] = round2(json.size[k]! + dS); moved = true; }
        }
        if (moved) changed++;
      }
      return changed;
    },
  };
}

/** One placement as the pass needs it: the placement record's own fields (`PlacementActor`). */
export interface PlacedEntity {
  typeId: string;
  x: number; y: number; z: number;
  yaw?: number;
  coasterRouteIndex?: number;
  /** A coaster car's index over every train of its route (absent on a lift platform or counterweight). */
  coasterCarIndex?: number;
  ride?: number;
  rideOf?: number;
}

export interface CrossEntitySeparation {
  /** Per separated entity type: the separation's counts and the JSON cubes rewritten. */
  entities: Record<string, CoplanarSeparation & { cubesRewritten: number }>;
  /** Types whose geometry JSON changed (re-serialise these). */
  changed: string[];
  /** Placed compiled types left out because their record is not where they rest (see the module note). */
  skippedMoving: string[];
  /** Placements separated at a resting pose other than their record (a parked coaster car), by type. */
  restedAway: Record<string, number>;
}

/** Where a placement rests when that is not its record: model-frame point and Bedrock yaw (`AuditActor`). */
export interface RestingPose { x: number; y: number; z: number; yaw: number }

/** Every pose a moving placement rests in (several for a lift car, one per stop), or null when none is known. */
export type RestingPoses = (a: PlacedEntity) => readonly RestingPose[] | null;

/** A parked car is separated as an upright actor only within this pitch and roll, degrees (see `coasterRestingPoses`). */
export const PARKED_LEVEL_DEG = 0.25;

/**
 * A resting-pose lookup over a coaster's parked cars (`coasterParkedCarPoses`), keyed by route and car index. A car
 * parked pitched or rolled past `PARKED_LEVEL_DEG` gets none: its bones turn every face off the axes, so it is left
 * out rather than separated in a pose it is not drawn in. Within the bound a face strays at most
 * sin(0.25 deg) x 1 block = 0.0044 block over a car's half-length, under half the 1/107-block push.
 */
export function coasterRestingPoses(poses: ReadonlyArray<{ route: number; index: number; datum: readonly number[]; yaw: number; pitch: number; roll: number }>): RestingPoses {
  const byKey = new Map<string, RestingPose>();
  for (const p of poses) {
    if (Math.abs(p.pitch) > PARKED_LEVEL_DEG || Math.abs(p.roll) > PARKED_LEVEL_DEG) continue;
    byKey.set(`${p.route}/${p.index}`, { x: p.datum[0]!, y: p.datum[1]!, z: p.datum[2]!, yaw: p.yaw });
  }
  return a => {
    if (a.coasterRouteIndex === undefined || a.coasterCarIndex === undefined) return null;
    const pose = byKey.get(`${a.coasterRouteIndex}/${a.coasterCarIndex}`);
    return pose ? [pose] : null;
  };
}

/**
 * A lift ride's car (bedrock-rides.ts) rests at whichever stop it last reached: the runtime carries it at a fixed
 * offset from the ride's seat (`carOffset`, taken where both stand) and never turns it, so at stop k it stands at its
 * record plus `path[k] - path[startStop]`. `rides` is the rides runtime's list (index = the actor's `ride`) and
 * `paths` each ride's stop path in the placement's model frame (the seat actor's `ridePath`).
 */
export function liftCarRestingPoses(rides: ReadonlyArray<{ kind: string; carType?: string; startStop?: number }>, paths: ReadonlyMap<number, ReadonlyArray<readonly number[]>>): RestingPoses {
  return a => {
    const ride = a.ride === undefined ? undefined : rides[a.ride];
    const path = a.ride === undefined ? undefined : paths.get(a.ride);
    if (!ride || ride.kind !== 'lift' || ride.carType !== a.typeId || !path?.length) return null;
    const from = path[ride.startStop ?? 0];
    if (!from) return null;
    return path.map(p => ({ x: a.x + p[0]! - from[0]!, y: a.y + p[1]! - from[1]!, z: a.z + p[2]! - from[2]!, yaw: a.yaw ?? 0 }));
  };
}

/** The first lookup that knows a placement's resting poses. */
export const firstRestingPoses = (...lookups: ReadonlyArray<RestingPoses | undefined>): RestingPoses =>
  a => { for (const f of lookups) { const r = f?.(a); if (r?.length) return r; } return null; };

/** Whether a placement's record is where the entity rests (see the module note). */
export const restsAtRecord = (a: PlacedEntity): boolean =>
  // A lift platform / counterweight carries its route but no car index: its record is the hoist's parked pose.
  (a.coasterRouteIndex === undefined || a.coasterCarIndex === undefined) && a.ride === undefined && a.rideOf === undefined;

/**
 * Separate every placed compiled entity from the fixed shell and from the entities before it. `geometries` holds the
 * shipped geometry per type id (the documents are edited IN PLACE); `isFixed` names the shell's types; `restingPoses`
 * places a moving actor where it rests (null: leave it out).
 */
export function separateEntitiesFromNeighbours(
  placements: readonly PlacedEntity[],
  geometries: ReadonlyMap<string, ShippedGeometry>,
  isFixed: (typeId: string) => boolean,
  restingPoses?: RestingPoses,
): CrossEntitySeparation {
  const out: CrossEntitySeparation = { entities: {}, changed: [], skippedMoving: [], restedAway: {} };
  const toActor = (a: PlacedEntity, entry: GeoEntryLike): AuditActor => ({ typeId: a.typeId, kind: 'placed', entry, at: { x: a.x, y: a.y, z: a.z }, yawDeg: a.yaw ?? 0 });
  const fixedActors: AuditActor[] = [];
  const movable = new Map<string, PlacedEntity[]>();
  const entries = new Map<string, ShippedGeometryEntry>();
  const entryOf = (typeId: string): ShippedGeometryEntry | undefined => {
    let e = entries.get(typeId);
    if (!e) { const g = geometries.get(typeId); if (!g) return undefined; entries.set(typeId, e = shippedGeometryEntry(g)); }
    return e;
  };
  for (const a of placements) {
    if (!geometries.has(a.typeId)) continue;
    if (isFixed(a.typeId)) { fixedActors.push(toActor(a, entryOf(a.typeId)!.entry)); continue; }
    const rest = atRest(a, restingPoses);
    if (!rest) { if (!out.skippedMoving.includes(a.typeId)) out.skippedMoving.push(a.typeId); continue; }
    if (rest[0] !== a) out.restedAway[a.typeId] = (out.restedAway[a.typeId] ?? 0) + rest.length;
    const list = movable.get(a.typeId);
    if (list) list.push(...rest); else movable.set(a.typeId, [...rest]);
  }
  // A type placed both at rest and moving keeps only its resting placements.
  out.skippedMoving = out.skippedMoving.filter(t => !movable.has(t));
  if (!movable.size) return out;
  const fixed: WorldFace[] = worldFaces(fixedActors);
  let next = fixedActors.length;
  for (const [typeId, list] of movable) {
    const shipped = entryOf(typeId)!;
    const actors = list.map(a => toActor(a, shipped.entry));
    // Its own pairs were separated when it was compiled: only what meets a neighbour is measured.
    // The entity being rewritten decides its own push: only its faces move, so only its grain bounds the step.
    const offset = geometries.get(typeId)!.diagnostics?.coplanar?.offset;
    const r = separateCoplanarAgainst(actors, fixed, { settledOwn: true, ...(offset !== undefined ? { offset } : {}) });
    const cubesRewritten = r.facesGrown ? shipped.writeBack() : 0;
    out.entities[typeId] = { ...r, cubesRewritten };
    if (cubesRewritten) out.changed.push(typeId);
    // What is separated becomes a neighbour of what follows (a figure beside a door), at its new faces.
    for (const f of worldFaces(actors)) fixed.push({ ...f, actor: next + f.actor });
    next += actors.length;
  }
  return out;
}

/**
 * A placement where it RESTS, for anything that measures a built pack as drawn (the render-fault audit, tests): its
 * record when that is where it rests, its resting poses when the lookup knows them (a parked coaster car, a lift car
 * at each stop), and null for a moving actor with no known resting pose.
 */
export function atRest<T extends PlacedEntity>(a: T, restingPoses?: RestingPoses): T[] | null {
  if (restsAtRecord(a)) return [a];
  const poses = restingPoses?.(a);
  return poses?.length ? poses.map(pose => ({ ...a, ...pose })) : null;
}
