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
 * Entities whose placement record is not where they rest are left out: a coaster car (every car of a train is
 * recorded at the station point; the runtime spaces them along the track), a ride car or seat (carried along a path
 * from its start), and a figure that rides another actor (`rideOf`, moved onto its seat). Separating those at the
 * record point would push faces against a neighbour they never meet. `TODO(a17-moving)`: separate a coaster car
 * against the track where it parks, and a seated figure on its seat.
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
}

/** Whether a placement's record is where the entity rests (see the module note). */
export const restsAtRecord = (a: PlacedEntity): boolean => a.coasterRouteIndex === undefined && a.ride === undefined && a.rideOf === undefined;

/**
 * Separate every placed compiled entity from the fixed shell and from the entities before it. `geometries` holds the
 * shipped geometry per type id (the documents are edited IN PLACE); `isFixed` names the shell's types.
 */
export function separateEntitiesFromNeighbours(
  placements: readonly PlacedEntity[],
  geometries: ReadonlyMap<string, ShippedGeometry>,
  isFixed: (typeId: string) => boolean,
): CrossEntitySeparation {
  const out: CrossEntitySeparation = { entities: {}, changed: [], skippedMoving: [] };
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
    if (!restsAtRecord(a)) { if (!out.skippedMoving.includes(a.typeId)) out.skippedMoving.push(a.typeId); continue; }
    const list = movable.get(a.typeId);
    if (list) list.push(a); else movable.set(a.typeId, [a]);
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
    const r = separateCoplanarAgainst(actors, fixed, { settledOwn: true });
    const cubesRewritten = r.facesGrown ? shipped.writeBack() : 0;
    out.entities[typeId] = { ...r, cubesRewritten };
    if (cubesRewritten) out.changed.push(typeId);
    // What is separated becomes a neighbour of what follows (a figure beside a door), at its new faces.
    for (const f of worldFaces(actors)) fixed.push({ ...f, actor: next + f.actor });
    next += actors.length;
  }
  return out;
}
