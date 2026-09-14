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

/** True when every row is a single ±1 (axis-aligned rotation, possibly with a flip). */
function isSignedPermutation(m: Mat3, eps = 1e-4): boolean {
  for (let r = 0; r < 3; r++) {
    let ones = 0;
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(m[r * 3 + c]!);
      if (v > 1 - eps && v < 1 + eps) ones++;
      else if (v > eps) return false;
    }
    if (ones !== 1) return false;
  }
  return true;
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
  /** Prototype cuboids dropped because the whole-model budget forced coarsening. */
  modelCoarsened: number;
  quality: LegoEntityQuality;
  pbr: boolean;
}

export interface CompiledLdrawGeometry {
  value: unknown;
  /** Opaque palette; index = atlas row. */
  materials: LdrawEntityMaterial[];
  /** Translucent palette for the canopy mesh. */
  canopyMaterials: LdrawEntityMaterial[];
  meshIds: string[];
  canopyMeshId?: string;
  seatPosition: [number, number, number];
  collisionBox: { width: number; height: number };
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
}

/** World-LDraw AABB of a placed body cuboid, for stud exposure tests. */
interface WorldBox { min: Vec3; max: Vec3; brick: number }

const round = (v: number): number => Math.round(v * 100) / 100;

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

/** Local AABB of a stud cylinder: `radius` across, `height` along `up`. */
function studLocalBox(s: LdrawStud): { min: Vec3; max: Vec3 } {
  const along: Vec3 = [s.up[0] * s.height, s.up[1] * s.height, s.up[2] * s.height];
  const across: Vec3 = [
    s.radius * Math.sqrt(Math.max(0, 1 - s.up[0] * s.up[0])),
    s.radius * Math.sqrt(Math.max(0, 1 - s.up[1] * s.up[1])),
    s.radius * Math.sqrt(Math.max(0, 1 - s.up[2] * s.up[2])),
  ];
  const a: Vec3 = [s.center[0] - across[0], s.center[1] - across[1], s.center[2] - across[2]];
  const b: Vec3 = [s.center[0] + across[0] + along[0], s.center[1] + across[1] + along[1], s.center[2] + across[2] + along[2]];
  return aabbOfCorners([a, b]);
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
  const placed = activeBricks.filter(b => {
    if (TECHNIC_INTERNAL.has(cleanPartId(b.part))) { skippedInternalCount++; return false; }
    return true;
  });
  const uniqueParts = [...new Set(placed.map(b => b.part))];
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all(uniqueParts.map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));

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
    let rotatedBoneCount = 0;
    let unresolvedCount = 0;

    placed.forEach((b, brickIndex) => {
      const mesh = meshes.get(b.part) ?? null;
      const material = resolveLdrawEntityMaterial(b.color);
      const R: Mat3 = b.rot ?? IDENTITY;
      const t: Vec3 = [b.x, b.y, b.z];
      const M = mul(mul(A, R), At);
      const aligned = isSignedPermutation(M);
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
        const [sW, sH, sL] = getPartDims(b.part);
        const hw = sW * 10, h = sH * 8, hl = sL * 10;
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

      for (const c of proto.cuboids as PartCuboid[]) {
        const cubeMaterial = c.color === 16 ? material : resolveLdrawEntityMaterial(c.color);
        // World LDraw box (for stud exposure): exact for aligned parts, the OBB's AABB otherwise.
        const world = aabbOfCorners(cornersOf(c.min, c.max).map(v => { const r = apply(R, v); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]] as Vec3; }));
        worldBoxes.push({ ...world, brick: brickIndex });
        if (aligned) {
          const rb = aabbOfCorners(cornersOf(world.min, world.max).map(v => apply(A, v)));
          renderCuboids.push({ ...rb, material: cubeMaterial, bone });
        } else {
          // Unrotated box at the brick's origin; the bone's rotation about that pivot places it.
          const at = apply(A, t);
          const local = aabbOfCorners(cornersOf(c.min, c.max).map(v => apply(A, v)));
          renderCuboids.push({
            min: [local.min[0] + at[0], local.min[1] + at[1], local.min[2] + at[2]],
            max: [local.max[0] + at[0], local.max[1] + at[1], local.max[2] + at[2]],
            material: cubeMaterial, bone,
          });
        }
      }
      for (const s of proto.studs) studCandidates.push({ brick: brickIndex, s, R, t, material, bone });
    });

    return { cache, renderCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, unresolvedCount };
  };

  // Whole-model budget: coarsen everything (deterministically) before giving up detail per part.
  let quality = { ...baseQuality };
  let modelCoarsened = 0;
  let built = compileAt(quality);
  while (built.renderCuboids.length > quality.maxModelCubes && modelCoarsened < 3) {
    quality = { ...quality, microcellLdu: quality.microcellLdu * 2 };
    modelCoarsened++;
    built = compileAt(quality);
  }
  if (built.renderCuboids.length > quality.maxModelCubes) {
    warnings.push(`${cid}: ${built.renderCuboids.length} cuboids exceed the ${quality.maxModelCubes} budget even at ${quality.microcellLdu} LDU; the pack keeps them all, expect a heavy entity.`);
  }
  const { renderCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, cache } = built;

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
  const exposed: RenderCuboid[] = [];
  for (const cand of studCandidates) {
    const { s, R, t, brick, material, bone } = cand;
    const centerW = apply(R, s.center);
    const upW = apply(R, s.up);
    const probe: Vec3 = [
      centerW[0] + t[0] + upW[0] * (s.height + 2), centerW[1] + t[1] + upW[1] * (s.height + 2), centerW[2] + t[2] + upW[2] * (s.height + 2),
    ];
    if (covered(probe, brick)) continue;
    const local = studLocalBox(s);
    const upR = apply(A, apply(R, s.up));
    if (bone === 'body') {
      const world = aabbOfCorners(cornersOf(local.min, local.max).map(v => { const r = apply(R, v); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]] as Vec3; }));
      const rb = aabbOfCorners(cornersOf(world.min, world.max).map(v => apply(A, v)));
      exposed.push({ ...rb, material, bone, studFace: faceForRenderDirection(upR) });
    } else {
      const at = apply(A, t);
      const lb = aabbOfCorners(cornersOf(local.min, local.max).map(v => apply(A, v)));
      // In a rotated bone the stud's face is named in the bone's own (unrotated) frame.
      exposed.push({
        min: [lb.min[0] + at[0], lb.min[1] + at[1], lb.min[2] + at[2]], max: [lb.max[0] + at[0], lb.max[1] + at[1], lb.max[2] + at[2]],
        material, bone, studFace: faceForRenderDirection(apply(A, s.up)),
      });
    }
  }
  const studBudget = Math.min(quality.maxStudCubes, Math.max(0, quality.maxModelCubes - renderCuboids.length));
  if (exposed.length > studBudget) {
    studsOmitted = exposed.length;
    warnings.push(`${cid}: ${exposed.length} exposed studs exceed the stud budget (${studBudget}); studs omitted.`);
  } else {
    renderCuboids.push(...exposed);
    studCubeCount = exposed.length;
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
  if (seatBricks.length) cockpitLdu = avg(seatBricks);
  else if (dedicatedCanopies.length) cockpitLdu = avg(dedicatedCanopies);
  else if (translucentBricks.length) cockpitLdu = avg(translucentBricks);
  else {
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
    visible_bounds_width: Math.max(2, Math.ceil(Math.max(totalWidth, totalLength))),
    visible_bounds_height: Math.max(2, Math.ceil(totalHeight)),
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
    quality,
    pbr: options.pbr ?? false,
  };

  if (aabbFallbackParts.length) {
    const total = aabbFallbackParts.reduce((n, f) => n + f.count, 0);
    warnings.push(`${cid}: ${total} placement${total === 1 ? '' : 's'} of ${aabbFallbackParts.length} part${aabbFallbackParts.length === 1 ? '' : 's'} rendered as bounding boxes (${aabbFallbackParts.slice(0, 5).map(f => `${f.part}×${f.count}`).join(', ')}${aabbFallbackParts.length > 5 ? ', …' : ''}).`);
  }
  if (report.printFallbacks.length) {
    warnings.push(`${cid}: ${report.printFallbacks.length} printed part${report.printFallbacks.length === 1 ? '' : 's'} used the unprinted mould (${report.printFallbacks.slice(0, 4).map(f => f.part).join(', ')}${report.printFallbacks.length > 4 ? ', …' : ''}).`);
  }

  return {
    value: { format_version: '1.12.0', 'minecraft:geometry': geometryMeshes },
    materials: opaque,
    canopyMaterials: translucent,
    meshIds,
    canopyMeshId,
    seatPosition: [seatX, seatY, seatZ],
    collisionBox,
    diagnostics,
    warnings,
  };
}
