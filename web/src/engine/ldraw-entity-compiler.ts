/**
 * Direct LDraw → Bedrock entity geometry compiler.
 *
 * Every placed part is instanced from a cached per-part cuboid PROTOTYPE
 * (`ldraw-part-prototype.ts`, compiled from the part's real `.dat` mesh) at the
 * player scale 1 stud = 3.2 units = 0.2 blocks. Slopes, wheels, wedges and
 * canopies keep their shape; a plain brick is exactly one cuboid; studs are
 * added only where the model leaves them visible. Colours are the LDraw RGB
 * (`ldraw-entity-materials.ts`), and a piece is translucent because its
 * MATERIAL is, never because of its part id.
 *
 * Frame (see TASKS-BEDROCK-ADDON.md §2.2). Bedrock's entity frame is
 * left-handed: Blockbench's codec mirrors X and negates the X/Y rotation
 * angles when it writes a `.geo.json`. So the compiler works in a right-handed
 * RENDER frame R (Y up, nose → −Z, model's right → +X) reached from LDraw by
 * a proper rotation `A` (det +1), and only the final JSON step mirrors X:
 *
 *   world = A·(R_brick·p + t) = (A R_brick Aᵀ)·(A p) + A t
 *
 * A prototype cuboid (part-local, axis-aligned) is mapped by `A` (still
 * axis-aligned). When `M = A R Aᵀ` is a signed permutation the box is
 * transformed directly into the `body` bone; otherwise the brick gets its own
 * bone with `pivot = A t` and a ZYX Euler of `M`, written as `(−a, −b, c)`.
 *
 * Kept from the previous compiler: display-stand filtering, wheel-yaw
 * alignment, cockpit/seat detection, collision-box derivation, the
 * `meshIds` / `canopyMeshId` contract and ≤ N cubes per mesh.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { PlayableKind, VehicleFacing } from './playable-components.js';
import { getPartDims } from './ldraw-part-dims.js';
import { createPartGeometryProvider, type LdrawPartMesh, type LdrawStud, type PartGeometryProvider, type Vec3 } from './ldraw-part-geometry.js';
import {
  createPrototypeCache, resolveEntityQuality,
  type CompiledPartPrototype, type LegoEntityQuality, type LegoEntityQualityName, type PartCuboid,
} from './ldraw-part-prototype.js';
import { resolveLdrawEntityMaterial, type LdrawEntityMaterial } from './ldraw-entity-materials.js';
import { ATLAS_TILE, ATLAS_WIDTH } from './ldraw-entity-atlas.js';

const PACK_NAMESPACE = 'craftmatic';

/** Scale: 3.2 Bedrock units per stud (20 LDU). 1 block = 16 units = 5 studs. */
export const BEDROCK_UNITS_PER_LDU = 3.2 / 20; // 0.16

/**
 * Canopy / windscreen moulds — used for COCKPIT DETECTION only. Whether a
 * piece renders translucent is decided by its material's alpha.
 */
const CANOPY_PARTS = new Set([
  '35654', '65633', '4594', '2483', '2437', '3823', '4872', '57783',
  '62360', '84954', '92579', '98834', '4474', '2447', '50747', '62576',
  '23447', '30372', '58181', '48288', '60581', '60803', '59349', '87544',
  '3065', '3066', '3067',
]);

/** Steering wheels and seats: the driver sits here. */
const SEAT_PARTS = new Set(['4079', '4079b', '3829', '3829c01', '73081', '2432']);

/** Technic pins and axles buried inside the model: geometry weight without silhouette. */
const TECHNIC_INTERNAL = new Set([
  '2780', '3673', '3749', '6558', '32054', '4274', '43093', '3705', '3706', '3707', '3708', '6587',
]);

const WHEEL_PARTS = new Set(['56908', '44771', '44772', '87697', '92912', '15413', '41897', '23798', '23799']);

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function cleanPartId(part: string): string {
  return part.replace(/^.*[/\\]/, '').replace(/\.dat$/i, '').toLowerCase();
}

// ─── Small linear algebra (row-major 3×3) ─────────────────────────────────────

type Mat3 = readonly number[];

function mul(a: Mat3, b: Mat3): number[] {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}
const transpose = (m: Mat3): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
  m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
  m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];

/**
 * The exact signed permutation a NEAR-axis-aligned matrix means (entries snapped
 * to −1/0/1), or null when any entry is farther than `eps` from those values.
 * Converted sources carry float noise (`0.9983`, `-0.0189`) that would otherwise
 * cost a bone per brick for a rotation nobody can see.
 */
export function snapSignedPermutation(m: Mat3, eps = 0.01): number[] | null {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const usedCols = new Set<number>();
  for (let r = 0; r < 3; r++) {
    let best = -1, bestAbs = 0;
    for (let c = 0; c < 3; c++) { const v = Math.abs(m[r * 3 + c]!); if (v > bestAbs) { bestAbs = v; best = c; } }
    if (best < 0 || Math.abs(bestAbs - 1) > eps || usedCols.has(best)) return null;
    for (let c = 0; c < 3; c++) if (c !== best && Math.abs(m[r * 3 + c]!) > eps) return null;
    usedCols.add(best);
    out[r * 3 + best] = m[r * 3 + best]! > 0 ? 1 : -1;
  }
  return out;
}

/** The signed permutation NEAREST a rotation (largest entry per row), for rotations up to 45° off-axis. */
function nearestSignedPermutation(m: Mat3): number[] | null {
  const out = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const usedCols = new Set<number>();
  for (let r = 0; r < 3; r++) {
    let best = -1, bestAbs = 0;
    for (let c = 0; c < 3; c++) { const v = Math.abs(m[r * 3 + c]!); if (v > bestAbs) { bestAbs = v; best = c; } }
    if (best < 0 || usedCols.has(best)) return null;
    usedCols.add(best);
    out[r * 3 + best] = m[r * 3 + best]! > 0 ? 1 : -1;
  }
  return out;
}

export interface LevelResult {
  bricks: ParsedBrick[];
  /** Rotation applied to every placement (row-major, LDraw frame), or null when the model was left as it was. */
  rotation: number[] | null;
  /** LDraw point the rotation was applied about. */
  centre: Vec3;
  /** Placements that were axis-aligned (within `snapSignedPermutation`'s tolerance) before / after. */
  alignedBefore: number;
  alignedAfter: number;
  /** Angle of the removed pose, degrees. */
  angleDeg: number;
}

/**
 * Level a POSED model. Mecabricks-lineage sources ship the whole model turned
 * to a display pose (76240 Tumbler: a 19° yaw plus a 3° pitch on 92% of its
 * placements), so no brick is axis-aligned, every brick costs a bone, and the
 * long-axis / nose logic reads a diagonal footprint. The dominant placement
 * rotation `Rc` is found by histogram; `G = Rc·Pᵀ` (P the signed permutation
 * nearest `Rc`) is that pose with the "which of the 24 axis frames" ambiguity
 * removed, so undoing it can never turn the model on its side; `Gᵀ` is then
 * applied to every placement about the model's centre. Applied only when it
 * at least doubles the axis-aligned placements (and reaches a fifth of them).
 */
export function levelModel(bricks: ParsedBrick[]): LevelResult {
  const n = bricks.length;
  const centre: Vec3 = n
    ? [bricks.reduce((a, b) => a + b.x, 0) / n, bricks.reduce((a, b) => a + b.y, 0) / n, bricks.reduce((a, b) => a + b.z, 0) / n]
    : [0, 0, 0];
  const alignedCount = (rot: Mat3 | null): number =>
    bricks.filter(b => snapSignedPermutation(rot ? mul(rot, b.rot ?? IDENTITY) : (b.rot ?? IDENTITY), 0.02) !== null).length;
  const alignedBefore = alignedCount(null);
  const keep = (): LevelResult => ({ bricks, rotation: null, centre, alignedBefore, alignedAfter: alignedBefore, angleDeg: 0 });
  if (n < 8 || alignedBefore >= n * 0.5) return keep();

  // Histogram of placement rotations (2-decimal key; the FIRST exact matrix
  // seen represents its bin, so the removed pose is not a rounded one).
  const hist = new Map<string, { R: number[]; count: number }>();
  for (const b of bricks) {
    const exact = [...(b.rot ?? IDENTITY)];
    const key = exact.map(v => Math.round(v * 100) / 100).join(',');
    const e = hist.get(key);
    if (e) e.count++; else hist.set(key, { R: exact, count: 1 });
  }
  const candidates = [...hist.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  let best: { Gt: number[]; aligned: number } | null = null;
  for (const { R: Rc } of candidates) {
    const P = nearestSignedPermutation(Rc);
    if (!P) continue;
    // Source matrices are not always exactly orthogonal: re-orthonormalise the rows (Gram–Schmidt) first.
    const r0 = norm([Rc[0]!, Rc[1]!, Rc[2]!]);
    const row1: Vec3 = [Rc[3]!, Rc[4]!, Rc[5]!];
    const d1 = dot(row1, r0);
    const r1 = norm([row1[0] - d1 * r0[0], row1[1] - d1 * r0[1], row1[2] - d1 * r0[2]]);
    const r2: Vec3 = [r0[1] * r1[2] - r0[2] * r1[1], r0[2] * r1[0] - r0[0] * r1[2], r0[0] * r1[1] - r0[1] * r1[0]];
    const Ro = [...r0, ...r1, ...r2];
    const G = mul(Ro, transpose(P));
    const Gt = transpose(G);
    const aligned = alignedCount(Gt);
    if (!best || aligned > best.aligned) best = { Gt, aligned };
  }
  // A clear improvement is enough: a curved spaceship keeps most of its parts at
  // real angles even when level (76286: 124 → 578 aligned of 2,077).
  if (!best || best.aligned < Math.max(alignedBefore * 2, n * 0.2)) return keep();
  const { Gt } = best;
  const leveled = bricks.map(b => {
    const rel: Vec3 = [b.x - centre[0], b.y - centre[1], b.z - centre[2]];
    const p = apply(Gt, rel);
    return { ...b, x: p[0] + centre[0], y: p[1] + centre[1], z: p[2] + centre[2], rot: mul(Gt, b.rot ?? IDENTITY) };
  });
  const trace = Gt[0]! + Gt[4]! + Gt[8]!;
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI;
  return { bricks: leveled, rotation: Gt, centre, alignedBefore, alignedAfter: best.aligned, angleDeg };
}

/**
 * ZYX Euler angles (degrees) with `M = Rz(c)·Ry(b)·Rx(a)` — three.js order
 * 'ZYX', which Blockbench uses for Bedrock bones. Exported for the tests.
 */
export function eulerZYX(m: Mat3): [number, number, number] {
  const m20 = Math.max(-1, Math.min(1, m[6]!));
  const b = Math.asin(-m20);
  let a: number, c: number;
  if (Math.abs(m20) < 0.99999) {
    a = Math.atan2(m[7]!, m[8]!);
    c = Math.atan2(m[3]!, m[0]!);
  } else {
    // Gimbal lock: fold the yaw into the roll.
    c = 0;
    a = m20 < 0 ? Math.atan2(m[1]!, m[4]!) : Math.atan2(-m[1]!, m[4]!);
  }
  const deg = (r: number): number => Math.round(r * 180 / Math.PI * 100) / 100;
  return [deg(a), deg(b), deg(c)];
}

/** Rotation from LDraw (Y down) into the render frame for a given nose direction. */
export function ldrawToRenderRotation(nose: '+x' | '-x' | '+z' | '-z'): number[] {
  switch (nose) {
    case '+z': return [1, 0, 0, 0, -1, 0, 0, 0, -1];
    case '-z': return [-1, 0, 0, 0, -1, 0, 0, 0, 1];
    case '+x': return [0, 0, -1, 0, -1, 0, -1, 0, 0];
    case '-x': return [0, 0, 1, 0, -1, 0, 1, 0, 0];
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface LegoGeometryDiagnostics {
  sourcePartCount: number;
  uniquePartCount: number;
  resolvedPartCount: number;
  unresolvedParts: string[];
  prototypeCacheHits: number;
  cubeCount: number;
  opaqueCubeCount: number;
  translucentCubeCount: number;
  studCubeCount: number;
  /** Exposed studs that were NOT emitted because `maxStudCubes` was exceeded. */
  studsOmitted: number;
  rotatedBoneCount: number;
  meshCount: number;
  aabbFallbackParts: Array<{ part: string; count: number; reason: string }>;
  printFallbackParts: string[];
  /** Parts skipped as buried Technic internals. */
  skippedInternalCount: number;
  /** How many times the whole model was coarsened to meet `maxModelCubes`. */
  modelCoarsened: number;
  /** Body cuboid count at the requested microcell, before any coarsening. */
  cubesAtRequestedDetail: number;
  quality: LegoEntityQuality;
  pbr: boolean;
  /** Library names served by the alias ladder (a sibling mould / unprinted base stood in). */
  substitutedParts: Array<{ part: string; alias: string }>;
  /** Cuboids per exposed stud (1 = square; 3-4 = a rotated fan that reads round; 0 = omitted). */
  studFacets: number;
  /** Where the driver sits and which evidence chose it. */
  cockpit: { source: 'seat-parts' | 'canopy-parts' | 'translucent-parts' | 'default-cabin'; units: [number, number, number] };
  /** The display pose removed from a posed source (null when the model was already level). */
  leveled: { angleDeg: number; alignedBefore: number; alignedAfter: number } | null;
  /** Placements left out because they form separate objects beside the vehicle (a standing driver, a display). */
  detached: { placements: number; groups: number };
  /** Body cuboids removed because every face was buried behind opaque cuboids (never visible from any viewpoint). */
  hiddenCubesCulled: number;
  /** The parts that cost the most cuboids in total (prototype cuboids × placements), heaviest first. */
  heaviestParts: Array<{ part: string; placements: number; cubesEach: number; cubes: number }>;
}

/**
 * How LDraw world coordinates became model units: `units = ((A·p) − origin) · scale`
 * in the right-handed render frame; the JSON additionally mirrors X. Lets an
 * offline harness put the source triangles and the emitted cuboids in one frame.
 */
export interface LdrawToBedrockTransform {
  /** Row-major 3×3 rotation LDraw → render frame (det +1). */
  A: number[];
  /** Render-frame LDU subtracted before scaling (floor at y = 0, centred in X/Z). */
  origin: [number, number, number];
  /** Model units per LDU. */
  scale: number;
  /** Pose removed first: `p_level = level.rotation·(p − centre) + centre`, applied before `A`. */
  level?: { rotation: number[]; centre: [number, number, number] };
}

export interface CompiledLdrawGeometry {
  value: unknown;
  transform: LdrawToBedrockTransform;
  /** Opaque palette; index = atlas row. */
  materials: LdrawEntityMaterial[];
  /** Translucent palette for the canopy mesh. */
  canopyMaterials: LdrawEntityMaterial[];
  meshIds: string[];
  canopyMeshId?: string;
  seatPosition: [number, number, number];
  collisionBox: { width: number; height: number };
  /** Entity extent in blocks (render frame: width across, length nose-to-tail). */
  sizeBlocks: { width: number; height: number; length: number };
  diagnostics: LegoGeometryDiagnostics;
  /** Human-readable degradations worth surfacing in the export status. */
  warnings: string[];
}

export interface CompileLdrawEntityOptions {
  scale?: number;
  facing?: VehicleFacing;
  userSeatAnchor?: { x: number; y: number; z: number };
  /** Defaults to a provider over the shared `.dat` cache (`ldraw-geometry.ts`). */
  partGeometry?: PartGeometryProvider;
  quality?: LegoEntityQualityName | Partial<LegoEntityQuality>;
  /** Recorded in diagnostics; the atlas is generated by the caller. */
  pbr?: boolean;
}

// ─── Internal geometry records ────────────────────────────────────────────────

interface BedrockUv { uv: [number, number]; uv_size: [number, number] }
interface BedrockCube {
  origin: [number, number, number];
  size: [number, number, number];
  /** Per-cube rotation (degrees, Bedrock's mirrored frame) about `pivot` — used for stud facets. */
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  uv: Record<'north' | 'south' | 'east' | 'west' | 'up' | 'down', BedrockUv>;
}
interface BedrockBone {
  name: string;
  pivot: [number, number, number];
  rotation?: [number, number, number];
  cubes: BedrockCube[];
}

/** A cuboid in the render frame R, before the JSON mirror. */
interface RenderCuboid {
  min: Vec3;
  max: Vec3;
  material: LdrawEntityMaterial;
  bone: string;
  /** Set for stud cuboids: the JSON face that gets the stud-top tile. */
  studFace?: keyof BedrockCube['uv'];
  /** Render-frame Euler (degrees) about `pivot`, for a cube that is itself rotated (stud facets). */
  rotation?: [number, number, number];
  pivot?: Vec3;
  /** Body cuboid placed directly (exact box); false for a cuboid inside a rotated bone. */
  aligned?: boolean;
}

/** World-LDraw AABB of a placed body cuboid, for stud exposure tests. */
interface WorldBox { min: Vec3; max: Vec3; brick: number }

/** Two-decimal rounding that never yields −0 (a mirrored zero would otherwise print as `-0`). */
const round = (v: number): number => { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; };

/** JSON face for a unit direction in the render frame (X mirrored on output). */
function faceForRenderDirection(d: Vec3): keyof BedrockCube['uv'] {
  const ax = Math.abs(d[0]), ay = Math.abs(d[1]), az = Math.abs(d[2]);
  if (ay >= ax && ay >= az) return d[1] > 0 ? 'up' : 'down';
  if (ax >= az) return d[0] > 0 ? 'west' : 'east'; // render +X is JSON −X
  return d[2] > 0 ? 'south' : 'north';
}

const aabbOfCorners = (corners: Vec3[]): { min: Vec3; max: Vec3 } => {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) for (let i = 0; i < 3; i++) { if (c[i]! < min[i]!) min[i] = c[i]!; if (c[i]! > max[i]!) max[i] = c[i]!; }
  return { min, max };
};

const cornersOf = (min: Vec3, max: Vec3): Vec3[] => [
  [min[0], min[1], min[2]], [max[0], min[1], min[2]], [min[0], max[1], min[2]], [max[0], max[1], min[2]],
  [min[0], min[1], max[2]], [max[0], min[1], max[2]], [min[0], max[1], max[2]], [max[0], max[1], max[2]],
];

/**
 * Split placements into physically connected clusters (world AABBs of their
 * REAL part bounds within `tol` LDU) and return the indices to drop. A
 * flattened source has no submodel names yet still ships the driver standing
 * on the ground, a display stand or a service cart beside the vehicle; nothing
 * that does not touch the vehicle belongs to the entity. Kept: the largest
 * cluster and every cluster at least `keepFraction` of its size (two similar
 * vehicles both survive). A small cluster is dropped only when it also lies
 * OUTSIDE the kept clusters' bounding box (+`margin` LDU): a part floating
 * inside the body is a source defect to report, not a separate object, and a
 * minifig seated in or leaning on the vehicle stays.
 */
export function detachedClusters(
  boxes: Array<{ min: Vec3; max: Vec3 }>,
  options: { tol?: number; keepFraction?: number; margin?: number } = {},
): { drop: Set<number>; groups: number; clusters: number } {
  const tol = options.tol ?? 4, keepFraction = options.keepFraction ?? 0.4, margin = options.margin ?? 20;
  const n = boxes.length;
  if (n === 0) return { drop: new Set(), groups: 0, clusters: 0 };
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; } return i; };
  const CELL = 120;
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const { min, max } = boxes[i]!;
    for (let x = Math.floor((min[0] - tol) / CELL); x <= Math.floor((max[0] + tol) / CELL); x++)
      for (let y = Math.floor((min[1] - tol) / CELL); y <= Math.floor((max[1] + tol) / CELL); y++)
        for (let z = Math.floor((min[2] - tol) / CELL); z <= Math.floor((max[2] + tol) / CELL); z++) {
          const key = `${x},${y},${z}`;
          const list = cells.get(key);
          if (list) list.push(i); else cells.set(key, [i]);
        }
  }
  const touches = (a: number, b: number): boolean => {
    const A = boxes[a]!, B = boxes[b]!;
    return A.min[0] - tol <= B.max[0] && A.max[0] + tol >= B.min[0]
      && A.min[1] - tol <= B.max[1] && A.max[1] + tol >= B.min[1]
      && A.min[2] - tol <= B.max[2] && A.max[2] + tol >= B.min[2];
  };
  for (const list of cells.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!, b = list[j]!;
      const ra = find(a), rb = find(b);
      if (ra !== rb && touches(a, b)) parent[ra] = rb;
    }
  }
  const members = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = find(i); const m = members.get(r); if (m) m.push(i); else members.set(r, [i]); }
  const clusters = [...members.values()].sort((a, b) => b.length - a.length);
  const largest = clusters[0]!.length;
  const kept = clusters.filter(c => c.length >= largest * keepFraction);
  const keptBox = aabbOfCorners(kept.flatMap(c => c.flatMap(i => [boxes[i]!.min, boxes[i]!.max])));
  const drop = new Set<number>();
  let groups = 0;
  for (const c of clusters) {
    if (c.length >= largest * keepFraction) continue;
    const box = aabbOfCorners(c.flatMap(i => [boxes[i]!.min, boxes[i]!.max]));
    const inside = box.min[0] >= keptBox.min[0] - margin && box.max[0] <= keptBox.max[0] + margin
      && box.min[1] >= keptBox.min[1] - margin && box.max[1] <= keptBox.max[1] + margin
      && box.min[2] >= keptBox.min[2] - margin && box.max[2] <= keptBox.max[2] + margin;
    if (inside) continue;
    groups++;
    for (const i of c) drop.add(i);
  }
  return { drop, groups, clusters: clusters.length };
}

/**
 * Remove body cuboids no viewpoint can see. A dense model buries whole parts
 * (Technic frames, the inner faces of double-walled panels, pins) inside
 * others; at 6,144 cuboids that interior was what pushed the Tumbler to a
 * 32 LDU grain. Occupancy is sampled at `cell` LDU over the model: a sample is
 * occupied when its centre lies inside an OPAQUE, axis-aligned cuboid (a
 * rotated bone's box is an over-estimate, so it never occludes; a translucent
 * one is see-through). A cuboid is hidden when every sample in the one-cell
 * ring around it is occupied — including the ring of its own AABB for a
 * rotated cuboid, which is conservative because the box contains the shape.
 * Studs are tested on `worldBoxes` separately, so culling here changes no stud.
 */
export function cullHiddenCuboids(
  cuboids: Array<{ min: Vec3; max: Vec3; translucent: boolean; aligned: boolean }>,
  cell: number,
): Set<number> {
  const hidden = new Set<number>();
  if (cuboids.length < 2) return hidden;
  const all = aabbOfCorners(cuboids.flatMap(c => [c.min, c.max]));
  const nx = Math.ceil((all.max[0] - all.min[0]) / cell) + 2, ny = Math.ceil((all.max[1] - all.min[1]) / cell) + 2, nz = Math.ceil((all.max[2] - all.min[2]) / cell) + 2;
  if (nx * ny * nz > 40_000_000) return hidden; // a model this large is coarsened anyway
  const occ = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number): number => (x * ny + y) * nz + z;
  // Sample centres sit at (k + 0.5)·cell from one cell before the model's min.
  const origin: Vec3 = [all.min[0] - cell, all.min[1] - cell, all.min[2] - cell];
  const firstCentreAfter = (v: number, axis: number): number => Math.ceil((v - origin[axis]!) / cell - 0.5);
  const lastCentreBefore = (v: number, axis: number): number => Math.floor((v - origin[axis]!) / cell - 0.5);
  for (const c of cuboids) {
    if (!c.aligned || c.translucent) continue;
    const x0 = Math.max(0, firstCentreAfter(c.min[0], 0)), x1 = Math.min(nx - 1, lastCentreBefore(c.max[0], 0));
    const y0 = Math.max(0, firstCentreAfter(c.min[1], 1)), y1 = Math.min(ny - 1, lastCentreBefore(c.max[1], 1));
    const z0 = Math.max(0, firstCentreAfter(c.min[2], 2)), z1 = Math.min(nz - 1, lastCentreBefore(c.max[2], 2));
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) occ[idx(x, y, z)] = 1;
  }
  cuboids.forEach((c, i) => {
    // Ring: samples within one cell outside the box, minus those inside it.
    const x0 = Math.max(0, firstCentreAfter(c.min[0] - cell, 0)), x1 = Math.min(nx - 1, lastCentreBefore(c.max[0] + cell, 0));
    const y0 = Math.max(0, firstCentreAfter(c.min[1] - cell, 1)), y1 = Math.min(ny - 1, lastCentreBefore(c.max[1] + cell, 1));
    const z0 = Math.max(0, firstCentreAfter(c.min[2] - cell, 2)), z1 = Math.min(nz - 1, lastCentreBefore(c.max[2] + cell, 2));
    const ix0 = firstCentreAfter(c.min[0], 0), ix1 = lastCentreBefore(c.max[0], 0);
    const iy0 = firstCentreAfter(c.min[1], 1), iy1 = lastCentreBefore(c.max[1], 1);
    const iz0 = firstCentreAfter(c.min[2], 2), iz1 = lastCentreBefore(c.max[2], 2);
    let ring = 0;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1 && z >= iz0 && z <= iz1) continue;
      ring++;
      if (!occ[idx(x, y, z)]) return;
    }
    if (ring > 0) hidden.add(i);
  });
  return hidden;
}

// ─── Compiler ─────────────────────────────────────────────────────────────────

export async function compileLdrawEntityGeometry(
  cid: string,
  kind: PlayableKind,
  bricks: ParsedBrick[],
  options: CompileLdrawEntityOptions = {},
): Promise<CompiledLdrawGeometry> {
  const scale = options.scale ?? BEDROCK_UNITS_PER_LDU;
  const provider = options.partGeometry ?? createPartGeometryProvider();
  const baseQuality = resolveEntityQuality(options.quality);
  const warnings: string[] = [];

  // 0a. A posed source (Mecabricks display pose) is levelled before anything
  // measures its footprint; the pose is reported in `transform.level`.
  const level = levelModel(bricks);
  bricks = level.bricks;

  // 0. Display stands / plaques and wheel-yaw alignment (unchanged policy).
  let activeBricks = bricks;
  const wheels = bricks.filter(b => {
    const p = cleanPartId(b.part);
    return WHEEL_PARTS.has(p) || p.includes('wheel') || p.includes('tire');
  });
  if (kind === 'car' && wheels.length >= 4) {
    const wheelYs = wheels.map(b => b.y);
    const groundY = Math.max(...wheelYs) + 60;
    const wheelXs = wheels.map(b => b.x), wheelZs = wheels.map(b => b.z);
    const minWheelX = Math.min(...wheelXs) - 120, maxWheelX = Math.max(...wheelXs) + 120;
    const minWheelZ = Math.min(...wheelZs) - 120, maxWheelZ = Math.max(...wheelZs) + 120;
    const filtered = bricks.filter(b => b.y <= groundY + 40 && b.x >= minWheelX && b.x <= maxWheelX && b.z >= minWheelZ && b.z <= maxWheelZ);
    if (filtered.length >= bricks.length * 0.6) activeBricks = filtered;

    const midZw = (Math.min(...wheelZs) + Math.max(...wheelZs)) / 2;
    const front = wheels.filter(b => b.z < midZw), rear = wheels.filter(b => b.z >= midZw);
    if (front.length >= 2 && rear.length >= 2) {
      const fX = front.reduce((a, b) => a + b.x, 0) / front.length, fZ = front.reduce((a, b) => a + b.z, 0) / front.length;
      const rX = rear.reduce((a, b) => a + b.x, 0) / rear.length, rZ = rear.reduce((a, b) => a + b.z, 0) / rear.length;
      const yaw = Math.atan2(fX - rX, fZ - rZ);
      if (Math.abs(yaw) > 0.05 && Math.abs(yaw) < Math.PI * 0.45) {
        const cosT = Math.cos(-yaw), sinT = Math.sin(-yaw);
        const pivotX = (fX + rX) / 2, pivotZ = (fZ + rZ) / 2;
        // A yaw about LDraw Y, applied to positions AND rotations so the parts turn with the car.
        const yawRot: number[] = [cosT, 0, sinT, 0, 1, 0, -sinT, 0, cosT];
        activeBricks = activeBricks.map(b => {
          const relX = b.x - pivotX, relZ = b.z - pivotZ;
          return { ...b, x: relX * cosT + relZ * sinT + pivotX, z: -relX * sinT + relZ * cosT + pivotZ, rot: mul(yawRot, b.rot ?? IDENTITY) };
        });
      }
    }
  } else if (kind === 'plane') {
    const canopyParts = bricks.filter(b => CANOPY_PARTS.has(cleanPartId(b.part)));
    if (canopyParts.length) {
      const canopyY = canopyParts.reduce((a, b) => a + b.y, 0) / canopyParts.length;
      const stand = bricks.filter(b => b.y > canopyY + 250);
      if (stand.length > 0 && stand.length < bricks.length * 0.2) activeBricks = bricks.filter(b => b.y <= canopyY + 250);
    }
  }

  // 1. Resolve every unique part to a mesh (parallel, cached by the provider).
  let skippedInternalCount = 0;
  let placed = activeBricks.filter(b => {
    if (TECHNIC_INTERNAL.has(cleanPartId(b.part))) { skippedInternalCount++; return false; }
    return true;
  });
  let uniqueParts = [...new Set(placed.map(b => b.part))];
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all(uniqueParts.map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));

  // 1b. Separate objects beside the vehicle (the driver standing on the ground,
  // a wind tunnel, a stand) are dropped on REAL part bounds — see detachedClusters.
  const worldBoundsOf = (b: ParsedBrick): { min: Vec3; max: Vec3 } => {
    const mesh = meshes.get(b.part);
    let lo: Vec3, hi: Vec3;
    if (mesh && mesh.triangles.length) { lo = mesh.bounds.min; hi = mesh.bounds.max; }
    else { const [sW, sH, sL] = getPartDims(b.part); lo = [-sL * 10, -sH * 8, -sW * 10]; hi = [sL * 10, 0, sW * 10]; }
    const R = b.rot ?? IDENTITY;
    return aabbOfCorners(cornersOf(lo, hi).map(v => { const r = apply(R, v); return [r[0] + b.x, r[1] + b.y, r[2] + b.z] as Vec3; }));
  };
  const detachedReport = detachedClusters(placed.map(worldBoundsOf));
  const detached = { placements: detachedReport.drop.size, groups: detachedReport.groups };
  if (detachedReport.drop.size) {
    placed = placed.filter((_, i) => !detachedReport.drop.has(i));
    uniqueParts = [...new Set(placed.map(b => b.part))];
    warnings.push(`${cid}: ${detached.placements} placement${detached.placements === 1 ? '' : 's'} in ${detached.groups} separate object${detached.groups === 1 ? '' : 's'} beside the vehicle left out (they do not touch it).`);
  }

  // 2. Frame: nose direction → A.
  const xs = placed.map(b => b.x), zs = placed.map(b => b.z);
  const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs);
  const isXLongitudinal = options.facing && options.facing !== 'auto' ? options.facing.endsWith('x') : (kind === 'car' && spanX > spanZ * 1.1);
  const forwardSign = options.facing?.startsWith('-') ? -1 : 1;
  const nose = (isXLongitudinal ? (forwardSign > 0 ? '+x' : '-x') : (forwardSign > 0 ? '+z' : '-z')) as '+x' | '-x' | '+z' | '-z';
  const A = ldrawToRenderRotation(nose);
  const At = transpose(A);

  // 3. Cockpit (unchanged heuristics; translucency now by material).
  const isTranslucentBrick = (b: ParsedBrick): boolean => resolveLdrawEntityMaterial(b.color).alpha < 1;
  const seatBricks = placed.filter(b => SEAT_PARTS.has(cleanPartId(b.part)));
  const dedicatedCanopies = placed.filter(b => CANOPY_PARTS.has(cleanPartId(b.part)));
  const translucentBricks = placed.filter(isTranslucentBrick);
  const avg = (list: ParsedBrick[]): Vec3 => [
    list.reduce((a, b) => a + b.x, 0) / list.length, list.reduce((a, b) => a + b.y, 0) / list.length, list.reduce((a, b) => a + b.z, 0) / list.length,
  ];

  // 4. Instantiate prototypes into the render frame (body cuboids first, studs after exposure).
  const compileAt = (quality: LegoEntityQuality) => {
    const cache = createPrototypeCache();
    const renderCuboids: RenderCuboid[] = [];
    const worldBoxes: WorldBox[] = [];
    const studCandidates: Array<{ brick: number; s: LdrawStud; R: Mat3; t: Vec3; material: LdrawEntityMaterial; bone: string }> = [];
    const bones = new Map<string, { pivot: Vec3; rotation?: [number, number, number] }>();
    bones.set('body', { pivot: [0, 0, 0] });
    const aabbFallback = new Map<string, { count: number; reason: string }>();
    const perPart = new Map<string, { placements: number; cubesEach: number }>();
    let rotatedBoneCount = 0;
    let unresolvedCount = 0;

    placed.forEach((b, brickIndex) => {
      const mesh = meshes.get(b.part) ?? null;
      const material = resolveLdrawEntityMaterial(b.color);
      const rawR: Mat3 = b.rot ?? IDENTITY;
      const t: Vec3 = [b.x, b.y, b.z];
      const rawM = mul(mul(A, rawR), At);
      // Float noise in converted sources (`0.9983`) is snapped to the exact
      // permutation; a real rotation keeps its matrix and gets a bone.
      const snapped = snapSignedPermutation(rawM, 0.01);
      const aligned = snapped !== null;
      const M: Mat3 = snapped ?? rawM;
      const R: Mat3 = snapped ? mul(mul(At, snapped), A) : rawR;
      let bone = 'body';
      if (!aligned) {
        bone = `r${brickIndex}`;
        const [ea, eb, ec] = eulerZYX(M);
        bones.set(bone, { pivot: apply(A, t), rotation: [ea, eb, ec] });
        rotatedBoneCount++;
      }

      let proto: CompiledPartPrototype;
      if (!mesh) {
        // Explicit, diagnosed fallback: the dims table's box.
        unresolvedCount++;
        // Dims are in NAME order ("2 x 4": 2 wide along Z, 4 long along X).
        const [sW, sH, sL] = getPartDims(b.part);
        const hw = sL * 10, h = sH * 8, hl = sW * 10;
        proto = {
          partId: cleanPartId(b.part), cuboids: [{ min: [-hw, -h, -hl], max: [hw, 0, hl], color: 16 }], studs: [],
          source: 'aabb-fallback', boundsLdu: { min: [-hw, -h, -hl], max: [hw, 0, hl] }, microcellLdu: quality.microcellLdu, hollow: false,
          metrics: { solidCells: 0, aabbCells: 0, fill: 1, coarsened: 0 },
        };
        const entry = aabbFallback.get(proto.partId) ?? { count: 0, reason: 'no geometry resolved' };
        entry.count++;
        aabbFallback.set(proto.partId, entry);
      } else {
        proto = cache.get(mesh, quality, { hollow: material.alpha < 1 });
        if (proto.source === 'aabb-fallback') {
          const entry = aabbFallback.get(proto.partId) ?? { count: 0, reason: `over ${quality.maxPartCubes} cuboids after coarsening` };
          entry.count++;
          aabbFallback.set(proto.partId, entry);
        }
      }

      const pp = perPart.get(proto.partId) ?? { placements: 0, cubesEach: proto.cuboids.length };
      pp.placements++;
      perPart.set(proto.partId, pp);
      for (const c of proto.cuboids as PartCuboid[]) {
        const cubeMaterial = c.color === 16 ? material : resolveLdrawEntityMaterial(c.color);
        // World LDraw box (for stud exposure): exact for aligned parts, the OBB's AABB otherwise.
        const world = aabbOfCorners(cornersOf(c.min, c.max).map(v => { const r = apply(R, v); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]] as Vec3; }));
        worldBoxes.push({ ...world, brick: brickIndex });
        if (aligned) {
          const rb = aabbOfCorners(cornersOf(world.min, world.max).map(v => apply(A, v)));
          renderCuboids.push({ ...rb, material: cubeMaterial, bone, aligned: true });
        } else {
          // Unrotated box at the brick's origin; the bone's rotation about that pivot places it.
          const at = apply(A, t);
          const local = aabbOfCorners(cornersOf(c.min, c.max).map(v => apply(A, v)));
          renderCuboids.push({
            min: [local.min[0] + at[0], local.min[1] + at[1], local.min[2] + at[2]],
            max: [local.max[0] + at[0], local.max[1] + at[1], local.max[2] + at[2]],
            material: cubeMaterial, bone, aligned: false,
          });
        }
      }
      for (const s of proto.studs) studCandidates.push({ brick: brickIndex, s, R, t, material, bone });
    });

    // Buried cuboids cost budget and draw calls for nothing: cull them. The
    // occupancy is sampled in the render frame, where aligned boxes are exact;
    // a rotated bone's cuboid is stored unrotated at its pivot, so its render
    // AABB here is not its world box — it is tested with the world AABB instead.
    const forCull = renderCuboids.map((c, i) => c.aligned
      ? { min: c.min, max: c.max, translucent: c.material.alpha < 1, aligned: true }
      : { ...(() => { const wb = worldBoxes[i]!; return aabbOfCorners(cornersOf(wb.min, wb.max).map(v => apply(A, v))); })(), translucent: c.material.alpha < 1, aligned: false });
    const hidden = cullHiddenCuboids(forCull, Math.min(4, quality.microcellLdu));
    const visibleCuboids = hidden.size ? renderCuboids.filter((_, i) => !hidden.has(i)) : renderCuboids;

    const heaviestParts = [...perPart].map(([part, v]) => ({ part, placements: v.placements, cubesEach: v.cubesEach, cubes: v.placements * v.cubesEach }))
      .sort((a, b) => b.cubes - a.cubes || a.part.localeCompare(b.part)).slice(0, 12);

    return { cache, renderCuboids: visibleCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, unresolvedCount, hiddenCubesCulled: hidden.size, heaviestParts };
  };

  // Whole-model budget: coarsen everything (deterministically) before giving up detail per part.
  let quality = { ...baseQuality };
  let modelCoarsened = 0;
  let built = compileAt(quality);
  const cubesAtRequestedDetail = built.renderCuboids.length;
  while (built.renderCuboids.length > quality.maxModelCubes && modelCoarsened < 3) {
    quality = { ...quality, microcellLdu: quality.microcellLdu * 2 };
    modelCoarsened++;
    built = compileAt(quality);
  }
  if (built.renderCuboids.length > quality.maxModelCubes) {
    warnings.push(`${cid}: ${built.renderCuboids.length} cuboids exceed the ${quality.maxModelCubes} budget even at ${quality.microcellLdu} LDU; the pack keeps them all, expect a heavy entity.`);
  }
  const { renderCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, cache, hiddenCubesCulled, heaviestParts } = built;

  // 5. Exposed studs: a stud whose top is inside another part's box is covered.
  const CELL = 40;
  const hash = new Map<string, WorldBox[]>();
  const keyOf = (x: number, y: number, z: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (const wb of worldBoxes) {
    for (let x = Math.floor(wb.min[0] / CELL); x <= Math.floor(wb.max[0] / CELL); x++)
      for (let y = Math.floor(wb.min[1] / CELL); y <= Math.floor(wb.max[1] / CELL); y++)
        for (let z = Math.floor(wb.min[2] / CELL); z <= Math.floor(wb.max[2] / CELL); z++) {
          const k = `${x},${y},${z}`;
          const list = hash.get(k);
          if (list) list.push(wb); else hash.set(k, [wb]);
        }
  }
  const covered = (p: Vec3, ownBrick: number): boolean => {
    const list = hash.get(keyOf(p[0], p[1], p[2]));
    if (!list) return false;
    for (const wb of list) {
      if (wb.brick === ownBrick) continue;
      if (p[0] > wb.min[0] + 0.5 && p[0] < wb.max[0] - 0.5 && p[1] > wb.min[1] + 0.5 && p[1] < wb.max[1] - 0.5 && p[2] > wb.min[2] + 0.5 && p[2] < wb.max[2] - 0.5) return true;
    }
    return false;
  };
  let studCubeCount = 0, studsOmitted = 0;
  interface ExposedStud { centre: Vec3; up: Vec3; radius: number; height: number; material: LdrawEntityMaterial; bone: string }
  const exposedStuds: ExposedStud[] = [];
  for (const cand of studCandidates) {
    const { s, R, t, brick, material, bone } = cand;
    const centerW = apply(R, s.center);
    const upW = apply(R, s.up);
    const probe: Vec3 = [
      centerW[0] + t[0] + upW[0] * (s.height + 2), centerW[1] + t[1] + upW[1] * (s.height + 2), centerW[2] + t[2] + upW[2] * (s.height + 2),
    ];
    if (covered(probe, brick)) continue;
    if (bone === 'body') {
      // Render frame: the stud's base centre and axis through the placement.
      exposedStuds.push({ centre: apply(A, [centerW[0] + t[0], centerW[1] + t[1], centerW[2] + t[2]]), up: apply(A, upW), radius: s.radius, height: s.height, material, bone });
    } else {
      // Rotated bone: the cube is authored unrotated at the brick origin; the bone's rotation places it.
      const at = apply(A, t), c = apply(A, s.center);
      exposedStuds.push({ centre: [c[0] + at[0], c[1] + at[1], c[2] + at[2]], up: apply(A, s.up), radius: s.radius, height: s.height, material, bone });
    }
  }
  /**
   * A stud is a cylinder; Bedrock only has cuboids. One axis-aligned box reads
   * as a square peg, so a stud is emitted as `facets` equal rectangles fanned
   * about its axis (k·180°/facets), each spanning the disc's diameter with its
   * corners ON the circle (half-length r·cos(π/2N), half-width r·sin(π/2N)):
   * four give a 16-sided outline within 8 % of the true radius. The tops are
   * coplanar and share one flat tile, so the overlap cannot z-fight visibly.
   */
  const studCuboids = (st: ExposedStud, facets: number): RenderCuboid[] => {
    const u = st.up;
    const axis = Math.abs(u[1]) >= Math.abs(u[0]) && Math.abs(u[1]) >= Math.abs(u[2]) ? 1 : (Math.abs(u[0]) >= Math.abs(u[2]) ? 0 : 2);
    const sign = u[axis]! >= 0 ? 1 : -1;
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    const box = (h1: number, h2: number): { min: Vec3; max: Vec3 } => {
      const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
      min[a1] = st.centre[a1]! - h1; max[a1] = st.centre[a1]! + h1;
      min[a2] = st.centre[a2]! - h2; max[a2] = st.centre[a2]! + h2;
      min[axis] = sign > 0 ? st.centre[axis]! : st.centre[axis]! - st.height;
      max[axis] = sign > 0 ? st.centre[axis]! + st.height : st.centre[axis]!;
      return { min, max };
    };
    if (facets <= 1) {
      // Square peg: the cylinder's AABB, stud-top tile on the up face.
      const upDir: Vec3 = [0, 0, 0]; upDir[axis] = sign;
      return [{ ...box(st.radius, st.radius), material: st.material, bone: st.bone, studFace: faceForRenderDirection(upDir) }];
    }
    const hl = st.radius * Math.cos(Math.PI / (2 * facets)), hw = st.radius * Math.sin(Math.PI / (2 * facets));
    const out: RenderCuboid[] = [];
    for (let k = 0; k < facets; k++) {
      const rotation: [number, number, number] = [0, 0, 0];
      rotation[axis] = k * 180 / facets;
      out.push({ ...box(hl, hw), material: st.material, bone: st.bone, ...(k === 0 ? {} : { rotation, pivot: [...st.centre] as Vec3 }) });
    }
    return out;
  };
  // Facets are the first detail traded for budget: 4 → 3 → 1 → none.
  const studBudget = Math.min(quality.maxStudCubes, Math.max(0, quality.maxModelCubes - renderCuboids.length));
  const requestedFacets = Math.max(1, Math.round(quality.studFacets));
  let studFacets = 0;
  for (const facets of [requestedFacets, 3, 1]) {
    if (facets > requestedFacets) continue;
    if (exposedStuds.length * facets <= studBudget) { studFacets = facets; break; }
  }
  if (exposedStuds.length && studFacets === 0) {
    studsOmitted = exposedStuds.length;
    warnings.push(`${cid}: ${exposedStuds.length} exposed studs exceed the stud budget (${studBudget}); studs omitted.`);
  } else {
    for (const st of exposedStuds) renderCuboids.push(...studCuboids(st, studFacets));
    studCubeCount = exposedStuds.length * studFacets;
  }

  // 6. Recentre: true geometric bounds in the render frame (floor at y = 0).
  const all = renderCuboids.length ? aabbOfCorners(renderCuboids.flatMap(c => [c.min, c.max])) : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  const midX = (all.min[0] + all.max[0]) / 2, midZ = (all.min[2] + all.max[2]) / 2, floorY = all.min[1];
  const toUnits = (v: Vec3): Vec3 => [(v[0] - midX) * scale, (v[1] - floorY) * scale, (v[2] - midZ) * scale];
  const totalWidth = (all.max[0] - all.min[0]) * scale / 16;
  const totalHeight = (all.max[1] - all.min[1]) * scale / 16;
  const totalLength = (all.max[2] - all.min[2]) * scale / 16;

  // 7. Seat + collision from the cockpit anchor (LDraw) mapped through the same frame.
  let cockpitLdu: Vec3;
  let cockpitSource: LegoGeometryDiagnostics['cockpit']['source'];
  if (seatBricks.length) { cockpitLdu = avg(seatBricks); cockpitSource = 'seat-parts'; }
  else if (dedicatedCanopies.length) { cockpitLdu = avg(dedicatedCanopies); cockpitSource = 'canopy-parts'; }
  else if (translucentBricks.length) { cockpitLdu = avg(translucentBricks); cockpitSource = 'translucent-parts'; }
  else {
    cockpitSource = 'default-cabin';
    // Default forward cabin: forward 20 %, 35 % up.
    const ys = placed.map(b => b.y);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    cockpitLdu = isXLongitudinal
      ? [cx + forwardSign * spanX * 0.2, minY + (maxY - minY) * 0.35, cz]
      : [cx, minY + (maxY - minY) * 0.35, cz + forwardSign * spanZ * 0.2];
  }
  const cockpitUnits = toUnits(apply(A, cockpitLdu));
  // Player eyes sit 1.62 blocks above the seat; put them at the cockpit centre, slightly set back.
  const seatX = Math.abs(cockpitUnits[0] / 16) < 0.8 ? 0 : round(cockpitUnits[0] / 16);
  const seatY = Math.max(0.4, round(cockpitUnits[1] / 16 - 1.25));
  const seatZ = round(cockpitUnits[2] / 16 + 0.35);
  const collisionBox = {
    width: Math.min(3.5, Math.max(0.8, Math.round(totalWidth * 0.85 * 10) / 10)),
    height: Math.min(2.5, Math.max(0.8, Math.round(totalHeight * 0.8 * 10) / 10)),
  };

  // 8. Palettes (opaque / translucent by material alpha) and JSON cubes.
  const opaque: LdrawEntityMaterial[] = [], translucent: LdrawEntityMaterial[] = [];
  const indexOf = (list: LdrawEntityMaterial[], m: LdrawEntityMaterial): number => {
    let i = list.findIndex(x => x.colorId === m.colorId);
    if (i < 0) { i = list.length; list.push(m); }
    return i;
  };
  const tile = (row: number, stud: boolean): BedrockUv => ({ uv: [stud ? ATLAS_TILE : 0, 1 + row * ATLAS_TILE], uv_size: [ATLAS_TILE, ATLAS_TILE] });

  const opaqueCubes: Array<{ bone: string; cube: BedrockCube }> = [];
  const translucentCubes: Array<{ bone: string; cube: BedrockCube }> = [];
  for (const c of renderCuboids) {
    const isT = c.material.alpha < 1;
    const row = indexOf(isT ? translucent : opaque, c.material);
    const lo = toUnits(c.min), hi = toUnits(c.max);
    const plain = tile(row, false);
    const uv: BedrockCube['uv'] = { north: plain, south: plain, east: plain, west: plain, up: plain, down: plain };
    if (c.studFace) uv[c.studFace] = tile(row, true);
    const cube: BedrockCube = {
      // Bedrock's entity frame is mirrored in X relative to the render frame.
      origin: [round(-hi[0]), round(lo[1]), round(lo[2])],
      size: [round(hi[0] - lo[0]), round(hi[1] - lo[1]), round(hi[2] - lo[2])],
      uv,
    };
    if (c.rotation && c.pivot) {
      const p = toUnits(c.pivot);
      cube.pivot = [round(-p[0]), round(p[1]), round(p[2])];
      cube.rotation = [round(-c.rotation[0]), round(-c.rotation[1]), round(c.rotation[2])];
    }
    (isT ? translucentCubes : opaqueCubes).push({ bone: c.bone, cube });
  }
  if (!opaque.length) opaque.push(resolveLdrawEntityMaterial(7));

  const jsonBone = (name: string): BedrockBone => {
    const b = bones.get(name)!;
    const p = toUnits(b.pivot);
    return {
      name,
      pivot: [round(-p[0]), round(p[1]), round(p[2])],
      ...(b.rotation ? { rotation: [round(-b.rotation[0]), round(-b.rotation[1]), round(b.rotation[2])] as [number, number, number] } : {}),
      cubes: [],
    };
  };

  const description = (identifier: string, materialCount: number) => ({
    identifier,
    texture_width: ATLAS_WIDTH,
    texture_height: 1 + Math.max(1, materialCount) * ATLAS_TILE,
    // Culling box. A rotated bone's cuboids are authored unrotated at the
    // pivot, so their true extent can exceed the render-frame AABB by up to a
    // cuboid diagonal; two blocks of padding covers every LEGO part at 0.16
    // units/LDU. (A "vanishes from above" report on the Pixel was the tester
    // falling back to the ground after an elevated /tp - not culling.)
    visible_bounds_width: Math.max(4, Math.ceil(Math.max(totalWidth, totalLength)) + 2),
    visible_bounds_height: Math.max(4, Math.ceil(totalHeight) + 2),
    visible_bounds_offset: [0, Math.round(totalHeight / 2 * 100) / 100, 0],
  });

  const geometryMeshes: unknown[] = [];
  const meshIds: string[] = [];
  const chunk = quality.meshChunkCubes;
  const groupByBone = (items: Array<{ bone: string; cube: BedrockCube }>): BedrockBone[] => {
    const byBone = new Map<string, BedrockBone>();
    for (const item of items) {
      let bone = byBone.get(item.bone);
      if (!bone) { bone = jsonBone(item.bone); byBone.set(item.bone, bone); }
      bone.cubes.push(item.cube);
    }
    return [...byBone.values()];
  };
  for (let offset = 0; offset < opaqueCubes.length; offset += chunk) {
    const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_${meshIds.length}`;
    meshIds.push(meshId);
    geometryMeshes.push({ description: description(meshId, opaque.length), bones: groupByBone(opaqueCubes.slice(offset, offset + chunk)) });
  }
  if (!meshIds.length) {
    const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_0`;
    meshIds.push(meshId);
    geometryMeshes.push({ description: description(meshId, opaque.length), bones: [jsonBone('body')] });
  }
  let canopyMeshId: string | undefined;
  if (translucentCubes.length) {
    canopyMeshId = `geometry.${PACK_NAMESPACE}.${cid}_canopy`;
    meshIds.push(canopyMeshId);
    geometryMeshes.push({ description: description(canopyMeshId, translucent.length), bones: groupByBone(translucentCubes) });
  }

  // 9. Diagnostics.
  const report = provider.report();
  const aabbFallbackParts = [...aabbFallback].map(([part, v]) => ({ part, ...v })).sort((a, b) => b.count - a.count || a.part.localeCompare(b.part));
  const diagnostics: LegoGeometryDiagnostics = {
    sourcePartCount: bricks.length,
    uniquePartCount: uniqueParts.length,
    resolvedPartCount: uniqueParts.filter(p => meshes.get(p) != null).length,
    unresolvedParts: report.unresolved,
    prototypeCacheHits: cache.hits,
    cubeCount: opaqueCubes.length + translucentCubes.length,
    opaqueCubeCount: opaqueCubes.length,
    translucentCubeCount: translucentCubes.length,
    studCubeCount,
    studsOmitted,
    rotatedBoneCount,
    meshCount: geometryMeshes.length,
    aabbFallbackParts,
    printFallbackParts: report.printFallbacks.map(f => f.part),
    skippedInternalCount,
    modelCoarsened,
    cubesAtRequestedDetail,
    quality,
    pbr: options.pbr ?? false,
    substitutedParts: report.substitutions,
    studFacets,
    cockpit: { source: cockpitSource, units: [round(cockpitUnits[0]), round(cockpitUnits[1]), round(cockpitUnits[2])] },
    leveled: level.rotation ? { angleDeg: round(level.angleDeg), alignedBefore: level.alignedBefore, alignedAfter: level.alignedAfter } : null,
    detached,
    hiddenCubesCulled,
    heaviestParts,
  };

  if (aabbFallbackParts.length) {
    const total = aabbFallbackParts.reduce((n, f) => n + f.count, 0);
    warnings.push(`${cid}: ${total} placement${total === 1 ? '' : 's'} of ${aabbFallbackParts.length} part${aabbFallbackParts.length === 1 ? '' : 's'} rendered as bounding boxes (${aabbFallbackParts.slice(0, 5).map(f => `${f.part}×${f.count}`).join(', ')}${aabbFallbackParts.length > 5 ? ', …' : ''}).`);
  }
  if (report.substitutions.length) {
    warnings.push(`${cid}: ${report.substitutions.length} part name${report.substitutions.length === 1 ? '' : 's'} stood in by a sibling mould (${report.substitutions.slice(0, 4).map(f => `${f.part}→${f.alias}`).join(', ')}${report.substitutions.length > 4 ? ', …' : ''}).`);
  }
  if (report.printFallbacks.length) {
    warnings.push(`${cid}: ${report.printFallbacks.length} printed part${report.printFallbacks.length === 1 ? '' : 's'} used the unprinted mould (${report.printFallbacks.slice(0, 4).map(f => f.part).join(', ')}${report.printFallbacks.length > 4 ? ', …' : ''}).`);
  }

  return {
    value: { format_version: '1.12.0', 'minecraft:geometry': geometryMeshes },
    transform: {
      A: [...A], origin: [midX, floorY, midZ], scale,
      ...(level.rotation ? { level: { rotation: [...level.rotation], centre: [...level.centre] as [number, number, number] } } : {}),
    },
    materials: opaque,
    canopyMaterials: translucent,
    meshIds,
    canopyMeshId,
    seatPosition: [seatX, seatY, seatZ],
    collisionBox,
    sizeBlocks: { width: round(totalWidth), height: round(totalHeight), length: round(totalLength) },
    diagnostics,
    warnings,
  };
}
