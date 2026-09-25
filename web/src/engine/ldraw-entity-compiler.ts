/**
 * Direct LDraw → Bedrock entity geometry compiler.
 *
 * Every placed part is instanced from a cached per-part cuboid PROTOTYPE
 * (`ldraw-part-prototype.ts`, compiled from the part's real `.dat` mesh) at
 * MINIFIG scale: a standing minifig (96 LDU, feet to head top) is as tall as
 * the 1.8-block player, so 1 block = 53.33 LDU and 1 stud = 6 units. Slopes, wheels, wedges and
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
 * alignment, cockpit/seat detection, collision-box derivation and ≤ N cubes
 * per mesh. The mesh contract is now `meshes`: one geometry per LDraw colour,
 * because a cube carries BOX UV into a flat swatch (see step 8 and
 * `ldraw-entity-atlas.ts`) and so cannot address a second colour.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import type { PlayableKind, VehicleFacing } from './playable-components.js';

/** What the compiler is building: a rideable vehicle, a minifig (NPC), or a static prop (a second object beside the vehicle). */
export type EntityKind = PlayableKind | 'figure' | 'prop';
import { getPartDims } from './ldraw-part-dims.js';
import { createPartGeometryProvider, type LdrawPartMesh, type LdrawStud, type PartGeometryProvider, type Vec3 } from './ldraw-part-geometry.js';
import {
  clampFigureQuality, createPrototypeCache, planPartGrains, resolveEntityQuality,
  type CompiledPartPrototype, type GrainPlanPart, type GrainPlanSummary, type LegoEntityQuality, type LegoEntityQualityName, type PartCuboid,
  type PartDecomposition,
} from './ldraw-part-prototype.js';
import { resolveLdrawEntityMaterial, type LdrawEntityMaterial } from './ldraw-entity-materials.js';
import { SWATCH_SIZE } from './ldraw-entity-atlas.js';
import { encodePngRgba } from './lego-resource-pack.js';
import { faceArtImage, orientFace, packFaceAtlas, rasterizeHeadFace, type BedrockFaceName, type FaceImage } from './head-face.js';
import { inferVehicleNose, type FacingDecision, type NoseDirection } from './vehicle-facing.js';
import { mouldFamilyId, assembleMinifig, classifyMiniDollPart, classifyMinifigPart, figureAnchor, figureSystemOfTorso, normaliseFigureDescription, type EntityRig, type FigureSystem, type MinifigSlot } from './minifig-rig.js';

const PACK_NAMESPACE = 'craftmatic';

// The scale lives in lego-scale.ts (shared with the block-export planner); re-exported for the tests and the CLI probes.
export { BEDROCK_UNITS_PER_LDU, LDU_PER_BLOCK, LDU_PER_MINIFIG, PLAYER_HEIGHT_BLOCKS, SEATED_EYE_HEIGHT_BLOCKS } from './lego-scale.js';
import { BEDROCK_UNITS_PER_LDU, SEATED_EYE_HEIGHT_BLOCKS } from './lego-scale.js';
import { visibleBoundsForSizeSteps } from './bedrock-placement-pack.js';
import { partStem } from './part-id.js';
import { separateCoplanarFaces, type CoplanarSeparation, type GeoEntryLike } from './bedrock-geometry-faces.js';

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

/** Seats the driver sits ON (steering wheels are ranked separately: the driver sits behind them). */
const SEAT_PARTS = new Set(['4079', '4079b', '33176', '58888', '14520']);
/** Steering wheels and steering stands: the driver sits ~30 LDU behind, eyes ~20 LDU above the wheel. */
const STEERING_PARTS = new Set(['3829', '3829c01', '73081']);
/** Minifig torsos: the anchor of a figure (a figure is torso + head + legs, everything else is dressing). */
const TORSO_PARTS = /^(973|3814|76382)(?![0-9])/;
/** Every part a minifig is built from, by id family - used when a description is unavailable. */
const FIGURE_PART_IDS = /^(973|3814|76382|3626|970|3815|3816|3817|41879|16968|3901|3625|3624|3833|2446|30370|3838|3846|4485|3962|3818|3819|983|3820|4498|2447|3878|30367|3899|6120|3900|30162|4522|3837|3836|4006|30173|30374|18041|2530|3849|3959|30375|30369|6246|6247|4349|4350|4351|4352|3835|3847|4497|59363|85975|93553|60752|62810|61190)(?![0-9])/;

/** `30372p79` → `30372`, `3626bp03` → `3626b`, `973ps1` → `973`: the mould behind a print. Composite (`c01`) and shape (`a`/`b`) suffixes are distinct moulds and stay. */
export function baseMould(part: string): string {
  return figureId(part).replace(/p[0-9a-z]+$/, '');
}

/** A Studio custom part id without its `bl_` prefix and `_torso`-style suffix (`bl_973pb5574c01_torso` → `973pb5574c01`). */
function figureId(part: string): string {
  return cleanPartId(part).replace(/^bl_/, '').replace(/_(torso|head|legs|hips|arm|hand)$/, '');
}

/** LDraw's own description says what a part is; `''` when the mesh is unresolved. */

/** A minifig body/clothing/accessory part, by the library description first and the id family second. */
export function isFigurePart(part: string, description: string): boolean {
  // BrickLink's `Minifigure, …` (a Studio-private part) folds onto LDraw's `Minifig …`.
  const d = normaliseFigureDescription(description);
  if (/^Minifig\b/i.test(d)) return !/^Minifig (Seat|Chair|Steering|Stand|Display|Bench)\b/i.test(d);
  if (/^(Figure|Friends|Duplo Figure|Technic Figure)\b/i.test(d)) return true;
  // Big-fig moulds: Studio's `Torso Large, …` / `Arm Large with Pin, …` and LDraw's `Bigfig …`.
  if (/^(Torso Large|Arm Large|Bigfig)\b/i.test(d)) return true;
  // `mouldFamilyId` follows LDraw's `~Moved to <id>` retirement stubs, whose
  // description names no part at all. Without it `981`/`982` (the arms the
  // `.io`-derived museum places) match nothing and every figure loses both arms.
  return FIGURE_PART_IDS.test(mouldFamilyId(part, description)) || /_(torso|head|legs|hips)$/.test(cleanPartId(part));
}
/**
 * The anchor of a figure group: a minifig torso, a mini-doll torso or a
 * big-fig body (`figureSystemOfTorso`, minifig-rig.ts). The id families
 * cover a custom torso the library cannot describe.
 */
export const isTorso = (part: string, description: string): boolean =>
  figureSystemOfTorso(part, description) !== null || TORSO_PARTS.test(figureId(part)) || /_torso$/.test(cleanPartId(part));
export const isSeat = (part: string, description: string): boolean => SEAT_PARTS.has(baseMould(part)) || /^(Minifig )?(Seat|Chair|Bench)\b/i.test(description.replace(/^[~=_]+\s*/, ''));
const isSteering = (part: string, description: string): boolean => STEERING_PARTS.has(baseMould(part)) || /^(Minifig )?Steering\b/i.test(description.replace(/^[~=_]+\s*/, ''));
const isCanopyMould = (part: string, description: string): boolean => CANOPY_PARTS.has(baseMould(part)) || /^(Windscreen|Canopy|Cockpit|Windshield)\b/i.test(description.replace(/^[~=_]+\s*/, ''));

/** Technic pins and axles buried inside the model: geometry weight without silhouette. */
const TECHNIC_INTERNAL = new Set([
  '2780', '3673', '3749', '6558', '32054', '4274', '43093', '3705', '3706', '3707', '3708', '6587',
  '61332', '65304', // Type-2 friction pins (76240: 106 + 24 placements, one buried cuboid each)
]);

/**
 * A connected group this big is a SUB-BUILD, not debris: a model displayed as
 * separate structures is normal, and only small pieces are candidates for
 * "floating". Whichever is larger, so a big model does not call a 200-part
 * outbuilding debris and a small one does not call half of itself a sub-build.
 */
const SUB_BUILD_MIN_PARTS = 200, SUB_BUILD_MIN_SHARE = 0.05;
/** Clear air around a fragment before a player would call it floating (one stud). */
const FLOATER_CLEARANCE_LDU = 20;

/**
 * What the placements actually break into: how many pieces, how many of those
 * are big enough to be sub-builds, and how much genuinely floats clear.
 *
 * Used by BOTH preparation paths — a building shell goes through
 * `prepareWholeModel`, which is the case this matters for.
 */
function analyseOrphans(boxes: ReadonlyArray<{ min: Vec3; max: Vec3 }>): {
  clusters: number; placements: number; subBuilds: number;
  floatingParts: number; floatingGroups: number; worstClearanceLdu: number;
} {
  const groups = connectedClusters(boxes as Array<{ min: Vec3; max: Vec3 }>);
  const orphanGroups = groups.slice(1);
  const subBuildMin = Math.max(SUB_BUILD_MIN_PARTS, boxes.length * SUB_BUILD_MIN_SHARE);
  const subBuilds = groups.filter(group => group.length >= subBuildMin);
  const fragments = groups.filter(group => group.length < subBuildMin);
  /** Distance from a fragment to the nearest part of any sub-build, in LDU. */
  const clearanceOf = (group: readonly number[]): number => {
    let best = Infinity;
    for (const index of group) {
      const a = boxes[index]!;
      for (const build of subBuilds) for (const j of build) {
        const b = boxes[j]!;
        let squared = 0;
        for (let axis = 0; axis < 3; axis++) {
          const gap = Math.max(0, Math.max(b.min[axis]! - a.max[axis]!, a.min[axis]! - b.max[axis]!));
          squared += gap * gap;
        }
        if (squared === 0) return 0;
        if (squared < best) best = squared;
      }
    }
    return best === Infinity ? Infinity : Math.sqrt(best);
  };
  let floatingParts = 0, floatingGroups = 0, worstClearanceLdu = 0;
  if (subBuilds.length) {
    for (const group of fragments) {
      const clearance = clearanceOf(group);
      if (clearance <= FLOATER_CLEARANCE_LDU) continue;
      floatingParts += group.length;
      floatingGroups++;
      if (Number.isFinite(clearance) && clearance > worstClearanceLdu) worstClearanceLdu = clearance;
    }
  }
  return {
    clusters: orphanGroups.length, placements: orphanGroups.reduce((a, g) => a + g.length, 0),
    subBuilds: subBuilds.length, floatingParts, floatingGroups, worstClearanceLdu,
  };
}

const WHEEL_PARTS = new Set(['56908', '44771', '44772', '87697', '92912', '15413', '41897', '23798', '23799']);

const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function cleanPartId(part: string): string {
  return partStem(part);
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
  /** Figures only: what the figure rig rebuilt (minifig-rig.ts), on which skeleton, and whether the frame moved off the torso. */
  minifig?: { parts: number; synthesized: string[]; dropped: string[]; system?: FigureSystem; reanchoredLdu?: Vec3 };
  /**
   * Figures only, and only when the pack asked for a finer grain than the
   * figure was given: every figure is clamped to `balanced` detail
   * (`clampFigureQuality`) - 8-13x fewer cuboids, at the cost of 0.05-0.09 of
   * six-view silhouette IoU on the head and hands.
   */
  figureQualityClamped?: { requestedMicrocellLdu: number; microcellLdu: number };
  sourcePartCount: number;
  uniquePartCount: number;
  resolvedPartCount: number;
  unresolvedParts: string[];
  prototypeCacheHits: number;
  cubeCount: number;
  opaqueCubeCount: number;
  translucentCubeCount: number;
  studCubeCount: number;
  /**
   * Square-peg studs (`studFacets` 1) that lost the atlas's stud-top disc: box
   * UV maps all six faces from one origin, so a cube can only carry the one
   * flat colour its geometry is textured with. 0 at `studFacets` >= 2, where
   * the fanned facets always shared one plain tile anyway.
   */
  studTopTilesDropped: number;
  /** Exposed studs that were NOT emitted because `maxStudCubes` was exceeded. */
  studsOmitted: number;
  rotatedBoneCount: number;
  meshCount: number;
  aabbFallbackParts: Array<{ part: string; count: number; reason: string }>;
  printFallbackParts: string[];
  /** Parts skipped as buried Technic internals. */
  skippedInternalCount: number;
  /**
   * Unique parts compiled coarser than the requested microcell to meet
   * `maxModelCubes` (until 2026-09-21 this counted whole-model doublings; the
   * budget is now spent per part - see `grainPlan`).
   */
  modelCoarsened: number;
  /** Placements × prototype cuboids at the requested microcell, before the cull and the merge. */
  cubesAtRequestedDetail: number;
  /**
   * How the cuboid budget was spent across the model's parts
   * (`planPartGrains`): the grain every part started at, how many parts and
   * placements ended at each cell, and the area-weighted six-view silhouette
   * fidelity before and after.
   */
  grainPlan: GrainPlanSummary;
  quality: LegoEntityQuality;
  pbr: boolean;
  /** Library names served by the alias ladder (a sibling mould / unprinted base stood in). */
  substitutedParts: Array<{ part: string; alias: string }>;
  /** Cuboids per exposed stud (1 = square; 3-4 = a rotated fan that reads round; 0 = omitted). */
  studFacets: number;
  /** Where the driver's EYES are (model units) and which evidence chose it (findCockpit, best first). */
  cockpit: { source: CockpitSource; units: [number, number, number]; detail: string };
  /** Parts of the seated driver figure left out of the geometry because the player sits there. */
  driverFigureRemoved: number;
  /** Separate objects found beside the vehicle and classified (figures and secondary vehicles are offered as their own entities). */
  extras: Array<{ role: ExtraRole; placements: number; reason: string }>;
  /** The display pose removed from a posed source (null when the model was already level). */
  leveled: { angleDeg: number; alignedBefore: number; alignedAfter: number } | null;
  /** Placements left out because they form separate objects beside the vehicle (a standing driver, a display). */
  detached: { placements: number; groups: number };
  /**
   * Placements left out by the display-stand rule BEFORE the cluster test: a car
   * keeps only what sits inside its wheel envelope and above its wheel line; a
   * plane drops a small cluster far below its canopy. Was silent until
   * 2026-09-15, when 76240's base plate and minifigs turned out to be 20 % of
   * the silhouette the gate was measuring against.
   */
  displayDropped: { placements: number; rule: 'wheel-envelope' | 'stand-below-canopy' | null };
  /**
   * Placements the display-stand drop would have stranded and that were put
   * back so nothing hangs in mid-air (see the repair in
   * `prepareEntityPlacements`).
   */
  strandedRepaired: number;
  /**
   * Placements the stand drop CONTINUED into: parts touching the dropped stand
   * that hang below the hull's lower envelope (the Milano's two Technic-beam
   * mast stubs). Without this the stub is the model's lowest cuboid, the
   * render frame grounds the model on it, and the hull hovers a mast above
   * the ground on a thin stalk (Pixel, world 919, 2026-09-19).
   */
  standContinued: number;
  /**
   * Connected pieces of the compiled entity that do not touch its main body -
   * exactly what a player reports as a "floating piece". Anything left here
   * after the stranding repair is loose in the SOURCE, so it is reported, not
   * hidden: 31141 ships 22 such placements in 9 pieces, 76435 ships 60 in 43.
   */
  orphans: {
    clusters: number; placements: number;
    /** Groups big enough to be a sub-build rather than debris. */
    subBuilds: number;
    /** Parts in small groups with more than a stud of clear air around them. */
    floatingParts: number; floatingGroups: number;
    /** The furthest such group's clearance, in LDU. */
    worstClearanceLdu: number;
  };
  /** Body cuboids removed because every face was buried behind opaque cuboids (never visible from any viewpoint). */
  hiddenCubesCulled: number;
  /**
   * Plain (unprinted) minifig / mini-doll heads given the default face
   * (`faceDecals`). A converted source carries no head print — the LXFML
   * decoration is dropped — so without this every face is blank skin.
   */
  defaultFaces: number;
  /**
   * Heads whose face is drawn as a TEXTURE on a decal cube (`head-face.ts`):
   * `printed` from a printed LDraw head's own artwork, `art` from face art the
   * caller seeded for a head no library prints. `atlas` is the entity's face
   * texture size in texels ([0, 0] when none).
   */
  faceTextures?: { printed: number; art: number; atlas: [number, number] };
  /**
   * Head cuboid fragments removed under a figure's headwear (`carveHeads`):
   * a head cell that shares space with its hair would otherwise show through
   * the hair's coplanar faces as skin-coloured stripes.
   */
  headCubesCarved: number;
  /**
   * The occupancy grid that cull ran on: the cell it sampled at, the cell the
   * quality asked for, and whether the 40 M-cell budget forced a coarser cell
   * (`coarsened`) or, at the very coarsest allowed cell, no cull at all
   * (`skipped`). Never silent: before 2026-09-19 an over-budget grid returned
   * an empty set with nothing recorded, so the cull had never run on 71043.
   */
  hiddenCull: Omit<HiddenCullPlan, 'hidden'>;
  /** Body cuboids absorbed by a same-colour face-adjacent neighbour (`mergeAlignedCuboids`, lossless). */
  mergedCubes: number;
  /**
   * Different-colour faces that shared a plane (z-fight hatching on the
   * device) and how they were separated (`separateCoplanarFaces`,
   * bedrock-geometry-faces.ts): pairs and area found, faces pushed out, pairs
   * left. Absent on a geometry compiled before 2026-09-25.
   */
  coplanar?: CoplanarSeparation;
  /** The parts that cost the most cuboids in total (prototype cuboids × placements), heaviest first. */
  heaviestParts: Array<{ part: string; placements: number; cubesEach: number; microcellLdu: number; cubes: number }>;
  /** Which LDraw end became the nose, with every vote that decided it (`vehicle-facing.ts`). */
  facing: FacingDecision;
  /**
   * `vehicleRig` compiles only: wheel/tyre placements found, the road wheels
   * they formed (one spinning bone each, its rolling radius in blocks, front
   * or rear half), and the placements that were not a road wheel (flat, not
   * round, or turned along the travel axis) and stayed on the body.
   */
  wheels?: { placements: number; bones: Array<{ name: string; radiusBlocks: number; parts: number; end: 1 | -1 }>; rejected: number };
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

/**
 * One emitted geometry. Cubes carry box UV into a texture that is a single flat
 * colour, so a geometry holds exactly one material - the pack textures it with
 * that colour's swatch (`legoMaterialSwatchName`) and draws it opaque or
 * alpha-blended by `translucent`.
 */
export interface CompiledMesh {
  id: string;
  material: LdrawEntityMaterial;
  /** Alpha < 1: drawn with `entity_alphablend`, after every opaque mesh. */
  translucent: boolean;
  /**
   * The entity's FACE geometry (`head-face.ts`): decal cubes with per-face UV
   * into this atlas, drawn alpha-TESTED so only the ink shows. `material` is
   * then nominal (no swatch is made for it).
   */
  faceAtlas?: { png: Uint8Array; width: number; height: number };
}

export interface CompiledLdrawGeometry {
  value: unknown;
  transform: LdrawToBedrockTransform;
  /** Distinct opaque colours in the model, in first-appearance order. */
  materials: LdrawEntityMaterial[];
  /** Distinct translucent colours in the model. */
  canopyMaterials: LdrawEntityMaterial[];
  /** The emitted geometries and the one colour each of them carries. */
  meshes: CompiledMesh[];
  /** `meshes.map(m => m.id)`, in draw order. */
  meshIds: string[];
  seatPosition: [number, number, number];
  /** Up to three passenger seats from the model's free seat moulds (entity frame, blocks, before the JSON X mirror like `seatPosition`). */
  passengerSeats: Array<[number, number, number]>;
  collisionBox: { width: number; height: number };
  /** Entity extent in blocks (render frame: width across, length nose-to-tail). */
  sizeBlocks: { width: number; height: number; length: number };
  /** The LDraw nose direction the geometry was compiled with (explicit or inferred). */
  facing: NoseDirection;
  /** Indices into the INPUT `bricks` of every placement that made it into the geometry (after the stand, internal, cluster and driver-figure drops). */
  keptSourceIndices: number[];
  /** Separate objects beside the vehicle (figures, a second vehicle, props), levelled with the model; see EntityExtra. */
  extras: EntityExtra[];
  /** Where the entity's origin (floor centre) sits in the LEVELLED LDraw frame: the point a scene maps to the actor position. */
  originLdu: Vec3;
  /** Blocks the entity's origin sits ABOVE the model's floor (`originAboveModel`); the actor spawns that much higher than `originLdu`. 0 normally. */
  originLiftBlocks: number;
  /** The level pose the extras share (their `bricks` are already levelled); null when the source was level. */
  levelPose: { rotation: number[]; centre: Vec3 } | null;
  /** Whole-model compiles only: every body cuboid's LDraw AABB (source frame), what a collider grid is measured from. */
  partBoxesLdu?: Array<{ min: Vec3; max: Vec3 }>;
  /** Figures only: the torso's exact horizontal facing in the SOURCE frame (x, z), and what the rig rebuilt. */
  figure?: { facingLdu: [number, number]; synthesized: string[]; dropped: string[]; system: FigureSystem };
  /** `vehicleRig` compiles only: the spinning road wheels (possibly none; the rig's `body` root is there either way). */
  wheelBones?: VehicleWheelBone[];
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
  /**
   * How a part's coarse lattice is merged into cuboids. `best-of` tries five
   * more axis orders and a largest-box-first pass and keeps the smallest;
   * every candidate tiles the SAME cells, so the geometry is identical and
   * only the count changes.
   *
   * Left unset it follows the MICROCELL, because the per-part saving and the
   * per-pack saving are different numbers and only the second one reaches the
   * device. `mergeAlignedCuboids` absorbs same-colour face-adjacent boxes
   * across part boundaries afterwards, and at a coarse grain it has already
   * taken most of what `best-of` would have won — measured with
   * `scripts/decomposition-pack-ab.ts` over the three golden models:
   *
   *   balanced (4 LDU):  10,828 -> 10,746 cuboids, **-0.8 %**, and 10300 gets
   *                      WORSE (+2.0 %) — a per-part win can hand the merge a
   *                      worse arrangement.
   *   high (2 LDU):      18,128 -> 17,150, **-5.4 %**, all three sets better
   *                      (-5.3 / -6.4 / -4.3 %), and 7140 loses a mesh.
   *
   * So: `best-of` at 2 LDU and finer, `greedy` at 4 LDU, and an explicit value
   * overrides both.
   */
  decomposition?: PartDecomposition;
  /** Recorded in diagnostics; the atlas is generated by the caller. */
  pbr?: boolean;
  /**
   * An explicit LDraw → render matrix (row-major 3×3, orthogonal; a mirror is
   * allowed) in place of the inferred nose. A building shell uses the point
   * reflection −I so its geometry lands on the block grid's own (mirrored)
   * frame at yaw 0; a figure uses the nose-−Z rotation of its own torso frame.
   */
  frame?: number[];
  /**
   * Compile EVERY placement as given: no levelling, no clustering, no stand
   * rules, no cockpit search. A building shell is one object however many
   * loose pieces it has; a rigged figure is already canonical.
   */
  wholeModel?: boolean;
  /**
   * A bone tree with pivots at the joints and the bone each placement belongs
   * to (minifig-rig.ts). Aligned parts are authored in their bone; a rotated
   * part gets its own child bone under it, so an animation that turns the
   * bone moves everything on it.
   */
  rig?: EntityRig;
  /**
   * Put the entity's origin one block above the model's top instead of at
   * its floor centre, so the block that lights it is open sky (a building
   * shell inside its own colliders was lit as light 0). See `originLiftBlocks`.
   */
  originAboveModel?: boolean;
  /**
   * Fixed entity origin in the input LDraw frame.  Library slots use one
   * shared figure origin so independently compiled head/torso/leg geometry
   * remains assembled when render controllers select them together.
   */
  originLdu?: Vec3;
  /** Keep LDraw inherited colour 16 symbolic instead of resolving it to the placement colour. */
  inheritMaterialId?: boolean;
  /**
   * Draw a printed head's face (or seeded face art) as a texture on a decal
   * cube (`head-face.ts`). Default true. The minifig creator turns it off: its
   * library slots carry prints as fixed-colour layer meshes.
   */
  faceTextures?: boolean;
  /**
   * The rig slot of each placement in `bricks` (parallel; from
   * `assembleMinifig`). Headwear compiles surface-preserving (a thin hair
   * shell keeps every cell) and carves the head cells it covers.
   */
  figureSlots?: readonly MinifigSlot[];
  /**
   * A driven vehicle's rig (`vehicleWheelAssemblies`): every road wheel
   * (a wheel and the tyre on it) gets its own `wheel_<n>` bone pivoted on its
   * axle, and every bone of the model hangs under `body`, whose pivot is the
   * model's floor centre (its mid-height for an aircraft). The client
   * animation spins the wheels and leans, pitches and bobs the body
   * (`vehicleClientAnimation` in playable-addon.ts). Off: the flat bone list
   * every other entity has.
   */
  vehicleRig?: boolean;
}

/** One spinning road wheel of a compiled vehicle: its bone, axle radius and how many placements ride on it. */
export interface VehicleWheelBone {
  name: string;
  /** Rolling radius in world blocks at the compiled scale (the tyre's outer radius). */
  radiusBlocks: number;
  /** Placements (wheel, tyre) on the bone. */
  parts: number;
  /** Axle centre in model units (entity frame, the JSON's mirrored X). */
  pivot: [number, number, number];
  /** +1 front half of the wheelbase, -1 rear: a front wheel can be steered by the animation. */
  end: 1 | -1;
}

/**
 * Group a vehicle's wheel and tyre placements into road wheels: placements
 * whose boxes share a centre (a tyre sits on its rim) form one wheel; its
 * axle is the box's SHORTEST side (a road wheel is wider across than it is
 * thick) and must be horizontal. A wheel lying flat, one whose two long sides
 * differ by more than a third (not round), or an axle along the travel axis is
 * not a road wheel and is left on the body — and counted, so nothing is
 * silently dropped.
 */
export function vehicleWheelAssemblies(
  boxes: ReadonlyArray<{ index: number; min: Vec3; max: Vec3 }>,
  travelAxis: 'x' | 'z',
): { wheels: Array<{ indices: number[]; centre: Vec3; radiusLdu: number; axle: 0 | 2 }>; rejected: number } {
  const groups: Array<{ indices: number[]; min: Vec3; max: Vec3 }> = [];
  const centreOf = (b: { min: Vec3; max: Vec3 }): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const volume = (b: { min: Vec3; max: Vec3 }): number => Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);
  for (const b of boxes) {
    // Same wheel: the boxes share at least half of the smaller one (a rim sits
    // inside its tyre, often set in along the axle, so the centres need not
    // coincide), with the axle heights within a quarter of the smaller radius.
    const g = groups.find(g => {
      const inter = { min: [0, 1, 2].map(k => Math.max(g.min[k]!, b.min[k]!)) as Vec3, max: [0, 1, 2].map(k => Math.min(g.max[k]!, b.max[k]!)) as Vec3 };
      const r = Math.min(Math.max(g.max[1] - g.min[1], 1), Math.max(b.max[1] - b.min[1], 1)) / 2;
      return volume(inter) >= 0.5 * Math.min(volume(g), volume(b)) && Math.abs(centreOf(g)[1] - centreOf(b)[1]) <= Math.max(4, r * 0.25);
    });
    if (g) {
      g.indices.push(b.index);
      for (let k = 0; k < 3; k++) { g.min[k] = Math.min(g.min[k]!, b.min[k]!); g.max[k] = Math.max(g.max[k]!, b.max[k]!); }
    } else groups.push({ indices: [b.index], min: [...b.min] as Vec3, max: [...b.max] as Vec3 });
  }
  const wheels: Array<{ indices: number[]; centre: Vec3; radiusLdu: number; axle: 0 | 2 }> = [];
  let rejected = 0;
  for (const g of groups) {
    const ext = [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]];
    const axle = ext[0]! <= ext[2]! ? 0 : 2;
    const across = [ext[1]!, ext[axle === 0 ? 2 : 0]!];
    const round = Math.min(...across) >= Math.max(...across) * 0.66;
    // The axle must be the thinnest side, horizontal, and across the travel axis.
    const thin = ext[axle]! < Math.min(...across);
    const acrossTravel = (axle === 0 ? 'x' : 'z') !== travelAxis;
    if (!round || !thin || !acrossTravel) { rejected += g.indices.length; continue; }
    wheels.push({ indices: g.indices, centre: centreOf(g), radiusLdu: Math.max(...across) / 2, axle });
  }
  return { wheels, rejected };
}

// ─── Internal geometry records ────────────────────────────────────────────────

interface BedrockCube {
  origin: [number, number, number];
  size: [number, number, number];
  /** Per-cube rotation (degrees, Bedrock's mirrored frame) about `pivot` — used for stud facets. */
  pivot?: [number, number, number];
  rotation?: [number, number, number];
  /**
   * BOX UV: one origin into a texture that is a single flat colour, not six
   * face descriptors into an atlas. Box UV lays the six faces out in a cross
   * scaled by the cube's own size, which is why the geometry it belongs to
   * carries exactly one colour (`ldraw-entity-atlas.ts`). Measured worth:
   * 1.05 kB per cuboid on a Pixel 8 Pro, 34 % of a cuboid's 3.08 kB.
   */
  uv: [number, number] | FaceUv;
}
/**
 * Per-face UV, used ONLY by a face decal: the one face it lists is drawn from
 * that atlas rectangle and every other face of the cube is not drawn at all.
 */
type FaceUv = Partial<Record<BedrockFaceName, { uv: [number, number]; uv_size: [number, number] }>>;
interface BedrockBone {
  name: string;
  parent?: string;
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
  /**
   * Set for the square-peg stud fallback (`studFacets` 1), which used to take a
   * stud-top tile on its up face. Box UV cannot address a second tile, so the
   * flag now only keeps the cube out of `mergeAlignedCuboids` and is counted in
   * `studTopTilesDropped` - never silently.
   */
  studTop?: boolean;
  /** Render-frame Euler (degrees) about `pivot`, for a cube that is itself rotated (stud facets). */
  rotation?: [number, number, number];
  pivot?: Vec3;
  /** Body cuboid placed directly (exact box); false for a cuboid inside a rotated bone. */
  aligned?: boolean;
  /**
   * A face decal: its print, already laid out for the cube face it looks out
   * of (`orientFace`). Kept out of the carve, the cull and the merge, and
   * emitted into the entity's face geometry with per-face UV.
   */
  face?: { face: BedrockFaceName; width: number; height: number; rgba: Uint8Array };
}

/** World-LDraw AABB of a placed body cuboid, for stud exposure tests. */
interface WorldBox { min: Vec3; max: Vec3; brick: number }

/** Two-decimal rounding that never yields −0 (a mirrored zero would otherwise print as `-0`). */
const round = (v: number): number => { const r = Math.round(v * 100) / 100; return r === 0 ? 0 : r; };

// ─── Default faces and hair-over-head carving ────────────────────────────────

/** How far a face decal stands proud of the head's front (LDU) and how deep it sits into it. */
const DECAL_PROUD_LDU = 0.6, DECAL_EMBED_LDU = 0.3;
/** Below this relative luminance the skin is dark and the face is drawn white. */
const DARK_SKIN_LUMINANCE = 0.3;
/** A carved fragment thinner than this (LDU) is a rounding sliver, not geometry. */
const CARVE_SLIVER_LDU = 0.05;

/** A head mould with no print of its own: every triangle inherits the placement colour. */
const isPlainHead = (part: string, mesh: LdrawPartMesh): boolean =>
  isHeadPart(part, mesh.description) && mesh.triangles.length > 0 && mesh.triangles.every(t => t.color === 16);

/**
 * The default face for a plain head: two eyes and a mouth as thin cuboids on
 * the head's front (LDraw −Z), placed proud of the front-most compiled cell
 * under each feature so they sit on the head whatever grain it compiled at.
 * Proportions follow the classic print (eyes at 40 % of the height, 17 % of
 * the width off centre; a mouth at 66 %); the ink is black on any skin that
 * is not itself dark, white otherwise.
 *
 * Converted sources have no head prints — the DBIX LXFML carries the face as
 * an LDD `decoration` that the LDraw conversion drops, so every one of
 * 76417's twelve heads and 42703's five arrived as `3626c`/`92198` plain and
 * shipped as blank skin (Pixel 8 Pro, 2026-09-24). This is now the LAST
 * resort: the converters swap a decorated head for its printed LDraw part
 * (`ldd-print-map.json`), a printed head's face is a texture
 * (`texturedHeadFace`), and a head no library prints can carry seeded face
 * art. Only a head with none of those gets these cuboids.
 * # TODO: a genuinely UNdecorated head (a statue, 76417's gold and grey
 * busts) is blank in the set but still gets this face - the conversion
 * cannot yet tell it from a decorated head it could not resolve.
 */
export function faceDecals(proto: CompiledPartPrototype, skin: LdrawEntityMaterial): PartCuboid[] {
  const cubes = proto.cuboids;
  if (!cubes.length) return [];
  const lo = proto.boundsLdu.min, hi = proto.boundsLdu.max;
  const W = hi[0] - lo[0], H = hi[1] - lo[1];
  if (W < 8 || H < 8) return [];
  const cx = (lo[0] + hi[0]) / 2;
  const [r, g, b] = skin.rgb;
  const ink = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < DARK_SKIN_LUMINANCE ? 15 : 0;
  const eyeW = W * 0.10, eyeH = H * 0.11, eyeDx = W * 0.17, eyeY = lo[1] + H * 0.40;
  const mouthW = W * 0.32, mouthH = H * 0.06, mouthY = lo[1] + H * 0.66;
  const rects: Array<[number, number, number, number]> = [
    [cx - eyeDx - eyeW / 2, cx - eyeDx + eyeW / 2, eyeY - eyeH / 2, eyeY + eyeH / 2],
    [cx + eyeDx - eyeW / 2, cx + eyeDx + eyeW / 2, eyeY - eyeH / 2, eyeY + eyeH / 2],
    [cx - mouthW / 2, cx + mouthW / 2, mouthY - mouthH / 2, mouthY + mouthH / 2],
  ];
  const out: PartCuboid[] = [];
  for (const [x0, x1, y0, y1] of rects) {
    let front = Infinity;
    for (const c of cubes) if (c.max[0] > x0 && c.min[0] < x1 && c.max[1] > y0 && c.min[1] < y1) front = Math.min(front, c.min[2]);
    if (!Number.isFinite(front)) continue;
    out.push({ min: [x0, y0, front - DECAL_PROUD_LDU], max: [x1, y1, front + DECAL_EMBED_LDU], color: ink });
  }
  return out;
}

/** A head whose face is a texture: its re-coloured prototype and the decal that carries the print. */
interface TexturedHeadFace {
  proto: CompiledPartPrototype;
  /** Part-local decal box, proud of the head's front-most cuboid. */
  decal: PartCuboid;
  oriented: NonNullable<ReturnType<typeof orientFace>>;
  source: 'printed' | 'art';
}

/**
 * A head's face as a TEXTURE (`head-face.ts`): a printed LDraw head's own
 * artwork, else face art seeded for this part name; null when neither exists
 * or the face does not look along a horizontal axis (then the caller falls
 * back to the cuboid print or the default face).
 *
 * `frame` takes part-local directions to the render frame (A·R for an aligned
 * part, A for a rotated one, whose cube is authored unrotated in its bone).
 * The print's cuboids on the FRONT half take the head's own colour - the
 * decal draws that print sharper - while a back print (a dual-sided head's
 * second face) keeps its cuboids.
 */
function texturedHeadFace(part: string, mesh: LdrawPartMesh, proto: CompiledPartPrototype, frame: Mat3, headPrint?: string): TexturedHeadFace | null {
  if (!proto.cuboids.length) return null;
  const printed = rasterizeHeadFace(mesh);
  const image: FaceImage | null = printed ?? faceArtImage(part, mesh, headPrint);
  if (!image) return null;
  const dir = (v: Vec3): Vec3 => apply(frame, v);
  const oriented = orientFace(image, dir([0, 0, -1]), dir([1, 0, 0]), dir([0, 1, 0]));
  if (!oriented) return null;
  const midZ = (proto.boundsLdu.min[2] + proto.boundsLdu.max[2]) / 2;
  const front = Math.min(...proto.cuboids.map(c => c.min[2]));
  const cuboids = proto.cuboids.map(c => (c.color !== 16 && (c.min[2] + c.max[2]) / 2 < midZ ? { ...c, color: 16 } : c));
  const decal: PartCuboid = {
    min: [image.rect.x0, image.rect.y0, front - DECAL_PROUD_LDU],
    max: [image.rect.x1, image.rect.y1, front + DECAL_EMBED_LDU],
    color: 16,
  };
  return { proto: { ...proto, cuboids }, decal, oriented, source: printed ? 'printed' : 'art' };
}

/** Axis-aligned box difference `box − cut`: up to six boxes, slivers dropped. */
function subtractBox(box: { min: Vec3; max: Vec3 }, cut: { min: Vec3; max: Vec3 }): Array<{ min: Vec3; max: Vec3 }> {
  const lo: Vec3 = [Math.max(box.min[0], cut.min[0]), Math.max(box.min[1], cut.min[1]), Math.max(box.min[2], cut.min[2])];
  const hi: Vec3 = [Math.min(box.max[0], cut.max[0]), Math.min(box.max[1], cut.max[1]), Math.min(box.max[2], cut.max[2])];
  if (hi[0] - lo[0] <= CARVE_SLIVER_LDU || hi[1] - lo[1] <= CARVE_SLIVER_LDU || hi[2] - lo[2] <= CARVE_SLIVER_LDU) return [box];
  const out: Array<{ min: Vec3; max: Vec3 }> = [];
  const keep = (min: Vec3, max: Vec3): void => {
    if (max[0] - min[0] > CARVE_SLIVER_LDU && max[1] - min[1] > CARVE_SLIVER_LDU && max[2] - min[2] > CARVE_SLIVER_LDU) out.push({ min, max });
  };
  // Slabs beside the intersection along X, then Y within the X band, then Z within both.
  keep([box.min[0], box.min[1], box.min[2]], [lo[0], box.max[1], box.max[2]]);
  keep([hi[0], box.min[1], box.min[2]], [box.max[0], box.max[1], box.max[2]]);
  keep([lo[0], box.min[1], box.min[2]], [hi[0], lo[1], box.max[2]]);
  keep([lo[0], hi[1], box.min[2]], [hi[0], box.max[1], box.max[2]]);
  keep([lo[0], lo[1], box.min[2]], [hi[0], hi[1], lo[2]]);
  keep([lo[0], lo[1], hi[2]], [hi[0], hi[1], box.max[2]]);
  return out;
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
  if (nx * ny * nz > CULL_GRID_CELL_BUDGET) return hidden; // the caller coarsens instead: cullHiddenCuboidsWithinBudget
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

/**
 * Occupancy-grid cells `cullHiddenCuboids` may allocate (one byte each, so
 * 40 MB). The grid is dense and allocated up front; a 5,967-part castle at
 * 4 LDU wants 61.3 M cells, which is why the cell is coarsened rather than
 * the cull abandoned.
 */
export const CULL_GRID_CELL_BUDGET = 40_000_000;

/**
 * Occupancy cells the cull is allowed to sample at, coarsest last. Measured on
 * 71043 at ultra (2026-09-19, `scripts/_probe-geo-audit.ts`): 4 LDU needs
 * 61.3 M cells and used to BAIL; 6 LDU culls 219 cuboids (0.46 %), 8 LDU 262
 * (0.54 %), 12 LDU 338 (0.70 %) — and **16 LDU culls visible material**
 * (three exposed studs), so the ladder stops at 12.
 */
export const CULL_CELL_LADDER: readonly number[] = [4, 6, 8, 12];

/** What `cullHiddenCuboidsWithinBudget` did, for the compile diagnostics (hard rule 4: nothing silent). */
export interface HiddenCullPlan {
  hidden: Set<number>;
  /** The cell the cull actually sampled at (the coarsest tried when it was skipped). */
  cellLdu: number;
  /** The cell the caller asked for. */
  requestedCellLdu: number;
  /** Occupancy cells the chosen cell needs (`nx·ny·nz`). */
  gridCells: number;
  coarsened: boolean;
  /** Even `CULL_CELL_LADDER`'s coarsest cell did not fit the budget: nothing was culled. */
  skipped: boolean;
}

/**
 * Cull buried cuboids at the finest cell whose occupancy grid fits
 * `CULL_GRID_CELL_BUDGET`, coarsening up `CULL_CELL_LADDER` when the requested
 * cell does not fit. Before this the culler simply returned an empty set over
 * the budget, so it had **never run on the largest golden model** (71043 at
 * ultra bails at both 4 and 6.67 LDU); a coarser occupancy cell is strictly
 * more conservative about what it calls hidden in the ring test, which is why
 * coarsening is safe up to the measured 12 LDU limit.
 *
 * A model that already fits keeps the requested cell, so its result is
 * byte-identical to the previous behaviour.
 */
export function cullHiddenCuboidsWithinBudget(
  cuboids: Array<{ min: Vec3; max: Vec3; translucent: boolean; aligned: boolean }>,
  cell: number,
): HiddenCullPlan {
  const base = { hidden: new Set<number>(), requestedCellLdu: cell };
  if (cuboids.length < 2) return { ...base, cellLdu: cell, gridCells: 0, coarsened: false, skipped: false };
  const all = aabbOfCorners(cuboids.flatMap(c => [c.min, c.max]));
  const cellsAt = (c: number): number =>
    (Math.ceil((all.max[0] - all.min[0]) / c) + 2) * (Math.ceil((all.max[1] - all.min[1]) / c) + 2) * (Math.ceil((all.max[2] - all.min[2]) / c) + 2);
  const ladder = [cell, ...CULL_CELL_LADDER.filter(c => c > cell)];
  for (const candidate of ladder) {
    const gridCells = cellsAt(candidate);
    if (gridCells > CULL_GRID_CELL_BUDGET) continue;
    return { ...base, hidden: cullHiddenCuboids(cuboids, candidate), cellLdu: candidate, gridCells, coarsened: candidate !== cell, skipped: false };
  }
  const coarsest = ladder[ladder.length - 1]!;
  return { ...base, cellLdu: coarsest, gridCells: cellsAt(coarsest), coarsened: coarsest !== cell, skipped: true };
}

// ─── Compiler ─────────────────────────────────────────────────────────────────

/**
 * Merge same-material, face-adjacent BODY cuboids into one. The union of the
 * boxes is unchanged, every face texture is a flat colour tile, and the shared
 * internal face was never visible - so the geometry is identical and the cube
 * count drops, which is what lets the whole-model budget loop keep a finer
 * microcell on a 2,000-part model. Repeated per axis until nothing merges.
 * Studs, rotated cubes and cuboids inside rotated bones are left alone.
 */
export function mergeAlignedCuboids(cuboids: RenderCuboid[], eps = 0.01): { cuboids: RenderCuboid[]; merged: number } {
  const eligible: RenderCuboid[] = [], rest: RenderCuboid[] = [];
  // A vehicle's wheel bone (`wheel_<n>`) is authored aligned like `body`, so its
  // cuboids merge too - but only with cuboids of the SAME bone, or a merged box
  // would spin half on the wheel and half on the body.
  const mergeable = (bone: string): boolean => bone === 'body' || bone.startsWith('wheel_');
  for (const c of cuboids) (c.aligned && mergeable(c.bone) && !c.studTop && !c.rotation ? eligible : rest).push(c);
  let current = eligible;
  let merged = 0;
  const key = (v: number): string => String(Math.round(v / eps));
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const axis of [0, 1, 2] as const) {
      const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
      const groups = new Map<string, RenderCuboid[]>();
      for (const c of current) {
        const k = `${c.bone === 'body' ? '' : `${c.bone}|`}${c.material.colorId}|${key(c.min[o1])}|${key(c.max[o1])}|${key(c.min[o2])}|${key(c.max[o2])}`;
        const g = groups.get(k);
        if (g) g.push(c); else groups.set(k, [c]);
      }
      const next: RenderCuboid[] = [];
      for (const g of groups.values()) {
        if (g.length === 1) { next.push(g[0]!); continue; }
        g.sort((a, b) => a.min[axis] - b.min[axis]);
        let acc = { ...g[0]!, min: [...g[0]!.min] as Vec3, max: [...g[0]!.max] as Vec3 };
        for (let i = 1; i < g.length; i++) {
          const c = g[i]!;
          if (Math.abs(c.min[axis] - acc.max[axis]) <= eps) { acc.max[axis] = Math.max(acc.max[axis], c.max[axis]); merged++; changed = true; }
          else if (c.min[axis] < acc.max[axis] - eps && c.max[axis] <= acc.max[axis] + eps) { merged++; changed = true; } // fully contained duplicate
          else { next.push(acc); acc = { ...c, min: [...c.min] as Vec3, max: [...c.max] as Vec3 }; }
        }
        next.push(acc);
      }
      current = next;
    }
    if (!changed) break;
  }
  return { cuboids: [...current, ...rest], merged };
}

// ─── Placement preparation: level, clusters, figures, stand rules ─────────────

export type ExtraRole = 'figure' | 'vehicle' | 'prop';

/** A separate object found beside the primary vehicle. */
export interface EntityExtra {
  role: ExtraRole;
  /** Indices into the INPUT `bricks`. */
  sourceIndices: number[];
  /** The placements, LEVELLED with the model (the frame `levelPose` describes). */
  bricks: ParsedBrick[];
  /** Centre of the object's real bounds, LDraw (levelled). */
  centreLdu: Vec3;
  /** The object's lowest point (LDraw Y is down, so this is the LARGEST y) - what it stands on. */
  floorLdu: number;
  /** A figure's facing: its torso's local −Z through the placement, horizontal unit vector (x, z). */
  facingLdu?: [number, number];
  reason: string;
  wheels: number;
  seats: number;
  figureParts: number;
}

export type CockpitSource = 'seated-figure' | 'seat-parts' | 'steering-wheel' | 'canopy-parts' | 'translucent-canopy' | 'default-cabin';

export interface PreparedEntityPlacements {
  level: LevelResult;
  /** The primary object's placements (levelled, Technic internals removed), parallel to `placedIdx`. */
  placed: ParsedBrick[];
  /** Indices into the INPUT `bricks`. */
  placedIdx: number[];
  meshes: Map<string, LdrawPartMesh | null>;
  displayDropped: { placements: number; rule: 'wheel-envelope' | 'stand-below-canopy' | null };
  /** Placements outside the primary object, and how many separate objects they formed. */
  detached: { placements: number; groups: number };
  extras: EntityExtra[];
  skippedInternalCount: number;
  /** Placements a display-stand drop would have stranded, and that were put back so nothing floats. */
  strandedRepaired: number;
  /** Placements the stand drop grew into because they hang off the stand below the hull (mast stubs). */
  standContinued: number;
  /**
   * Connected pieces of `placed` that do not touch the main body — what a
   * player sees as a floating piece. After the stranding repair these can only
   * come from the SOURCE (a converted model whose parts do not meet), so the
   * count is reported rather than fixed.
   */
  orphans: {
    clusters: number; placements: number;
    /** Groups big enough to be a sub-build rather than debris. */
    subBuilds: number;
    /** Parts in small groups with more than a stud of clear air around them. */
    floatingParts: number; floatingGroups: number;
    /** The furthest such group's clearance, in LDU. */
    worstClearanceLdu: number;
  };
  /** World-LDraw AABB of a placement from its REAL part bounds (dims-table box when unresolved). */
  worldBoundsOf: (b: ParsedBrick) => { min: Vec3; max: Vec3 };
}

/**
 * Indices of `pool` whose box touches any box of `seed`, at the same tolerance
 * `connectedClusters` uses. Grid-bucketed, so a repair pass over a whole model
 * costs the same order as one clustering.
 */
export function touchingIndices(
  boxes: Array<{ min: Vec3; max: Vec3 }>, seed: readonly number[], pool: readonly number[], tol = 4,
): number[] {
  const CELL = 120;
  const cells = new Map<string, number[]>();
  for (const i of seed) {
    const { min, max } = boxes[i]!;
    for (let x = Math.floor((min[0] - tol) / CELL); x <= Math.floor((max[0] + tol) / CELL); x++)
      for (let y = Math.floor((min[1] - tol) / CELL); y <= Math.floor((max[1] + tol) / CELL); y++)
        for (let z = Math.floor((min[2] - tol) / CELL); z <= Math.floor((max[2] + tol) / CELL); z++) {
          const key = `${x},${y},${z}`;
          const list = cells.get(key);
          if (list) list.push(i); else cells.set(key, [i]);
        }
  }
  const hit: number[] = [];
  for (const j of pool) {
    const B = boxes[j]!;
    const seen = new Set<number>();
    let touched = false;
    for (let x = Math.floor((B.min[0] - tol) / CELL); x <= Math.floor((B.max[0] + tol) / CELL) && !touched; x++)
      for (let y = Math.floor((B.min[1] - tol) / CELL); y <= Math.floor((B.max[1] + tol) / CELL) && !touched; y++)
        for (let z = Math.floor((B.min[2] - tol) / CELL); z <= Math.floor((B.max[2] + tol) / CELL) && !touched; z++) {
          for (const i of cells.get(`${x},${y},${z}`) ?? []) {
            if (seen.has(i)) continue;
            seen.add(i);
            const A = boxes[i]!;
            if (A.min[0] - tol <= B.max[0] && A.max[0] + tol >= B.min[0]
              && A.min[1] - tol <= B.max[1] && A.max[1] + tol >= B.min[1]
              && A.min[2] - tol <= B.max[2] && A.max[2] + tol >= B.min[2]) { touched = true; break; }
          }
        }
    if (touched) hit.push(j);
  }
  return hit;
}

/** Union-find over touching boxes: every connected group, largest first. */
export function connectedClusters(boxes: Array<{ min: Vec3; max: Vec3 }>, tol = 4): number[][] {
  const n = boxes.length;
  if (n === 0) return [];
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
  return [...members.values()].sort((a, b) => b.length - a.length);
}

/** A minifig or mini-doll head mould, by description, id family or a custom part's `_head` suffix. */
export const isHeadPart = (part: string, description: string): boolean =>
  /^Minifig Head\b/i.test(normaliseFigureDescription(description)) || /^(3626|3625|3624)(?![0-9])/.test(mouldFamilyId(part, description)) || /_head$/.test(cleanPartId(part))
  || classifyMiniDollPart(part, description) === 'doll_head';

/**
 * How far from its torso a figure's parts may sit and still be its own, in
 * the torso frame: horizontal radius, and the vertical range (Y down: negative
 * is above the torso). A big-fig is bigger in every direction, and its torso
 * is the part a converter most often leaves at a raw origin (76417's `37777`
 * sits 70 LDU below its own shoulders), so its reach is wider still.
 */
/**
 * The lowest (torso frame, LDU, Y down) a loose accessory's origin may sit and
 * still join a figure: a minifig hand is 26.6 below the torso origin
 * (`MINIFIG_CANON`), its hips 32, its knees about 54, its soles 72. 48 keeps a
 * sword or broom held low and leaves an item on the floor to the scenery.
 */
export const HELD_BELOW_LDU = 48;

const GROUP_REACH: Record<FigureSystem, { radius: number; above: number; below: number }> = {
  minifig: { radius: 40, above: 48, below: 80 },
  minidoll: { radius: 40, above: 48, below: 100 },
  bigfig: { radius: 60, above: 130, below: 110 },
};

/**
 * Minifig parts grouped into figures around each torso: a part joins the
 * nearest torso within 40 LDU beside it and from 48 LDU above it (hair, a
 * helmet) to 80 LDU below (the feet) - measured in the TORSO'S OWN frame, not
 * the world's. A figure the source posed lying or pitched keeps its legs that
 * way: 10303's drop-track riders sit nose-down at 90°, so in world axes their
 * legs stood 44 LDU "beside" the torso, failed the 40 LDU radius and were left
 * in the building shell while the rig supplied standard legs (2026-09-21).
 * For an upright figure the two frames differ by a yaw and agree exactly.
 *
 * A placement the vocabulary cannot name that sits at a grouped head's origin
 * is that figure's headwear: every hair, hat and helmet mould is placed there.
 * Loose accessories stay ungrouped.
 */
export function groupFigures(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): Array<{ torso: number; parts: number[] }> {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const torsos: number[] = [];
  bricks.forEach((b, i) => { if (isTorso(b.part, desc(b))) torsos.push(i); });
  const torsoSet = new Set(torsos);
  const groups = torsos.map(t => ({ torso: t, parts: [t] }));
  const grouped = new Set<number>();
  /** A placement's offset from the torso in the torso's frame (Y down, −Z forward). */
  const inTorsoFrame = (T: ParsedBrick, b: ParsedBrick): Vec3 => apply(transpose(T.rot ?? IDENTITY), [b.x - T.x, b.y - T.y, b.z - T.z]);
  const reachOf = torsos.map(t => GROUP_REACH[figureSystemOfTorso(bricks[t]!.part, desc(bricks[t]!)) ?? 'minifig']);
  bricks.forEach((b, i) => {
    if (torsoSet.has(i) || !isFigurePart(b.part, desc(b))) return;
    // A loose accessory (a wand, a tool, a cup) is carried only from hand
    // height: one lying at the figure's feet is the scenery's. 76457 places a
    // second wand at every figure's feet; grouped, it hung from the hand at
    // the figure's knees, set the entity's floor under the soles and walked
    // off with the figure (2026-09-25).
    const accessory = classifyMinifigPart(b.part, desc(b)) === 'held' && classifyMiniDollPart(b.part, desc(b)) === null;
    let best = -1, bestD = Infinity;
    torsos.forEach((t, k) => {
      const [dx, dy, dz] = inTorsoFrame(bricks[t]!, b);
      const reach = reachOf[k]!;
      if (Math.hypot(dx, dz) > reach.radius || dy < -reach.above || dy > (accessory ? Math.min(reach.below, HELD_BELOW_LDU) : reach.below)) return;
      const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.25;
      if (d < bestD) { bestD = d; best = k; }
    });
    if (best >= 0) { groups[best]!.parts.push(i); grouped.add(i); }
  });
  // A head no torso claimed, with hips or legs of its own system under it, is
  // a figure whose torso the source lost (42703's fifth doll): it anchors a
  // group the rig completes with a synthesised torso (`figureAnchor`). The
  // head stands in for the torso at the system's head offset.
  bricks.forEach((b, i) => {
    if (torsoSet.has(i) || grouped.has(i) || !isHeadPart(b.part, desc(b))) return;
    const doll = classifyMiniDollPart(b.part, desc(b)) === 'doll_head';
    const reach = GROUP_REACH[doll ? 'minidoll' : 'minifig'];
    const headAbove = doll ? 33.2 : 24;
    const members: number[] = [];
    bricks.forEach((c, j) => {
      if (j === i || torsoSet.has(j) || grouped.has(j) || !isFigurePart(c.part, desc(c))) return;
      const [dx, dy, dz] = inTorsoFrame(b, c);
      const dyTorso = dy - headAbove;
      if (Math.hypot(dx, dz) > reach.radius || dyTorso < -reach.above || dyTorso > reach.below) return;
      members.push(j);
    });
    if (!members.length) return;
    const group = { torso: i, parts: [i, ...members] };
    if (!figureAnchor(group.parts.map(k => bricks[k]!), meshes)?.headless) return;
    groups.push(group);
    for (const k of group.parts) grouped.add(k);
  });
  if (!groups.length) return [];
  // Headwear the library cannot name: an ungrouped placement within 4 LDU of a grouped head's origin.
  const heads = groups.flatMap((g, k) => g.parts.filter(i => isHeadPart(bricks[i]!.part, desc(bricks[i]!))).map(i => ({ k, head: bricks[i]! })));
  if (heads.length) bricks.forEach((b, i) => {
    if (torsoSet.has(i) || grouped.has(i)) return;
    const worn = heads.find(h => Math.hypot(h.head.x - b.x, h.head.y - b.y, h.head.z - b.z) <= 4);
    if (worn) groups[worn.k]!.parts.push(i);
  });
  return groups;
}

/** What `repairFigureTorsos` moved: the torso part and its move in world LDU. */
export interface TorsoRepair { part: string; system: FigureSystem; offsetLdu: Vec3 }

/**
 * Move every figure torso a converter left at a raw origin to where its own
 * limbs and head put it — the rig's consensus re-anchor (`assembleMinifig`),
 * applied to the SOURCE placements so every consumer of a figure agrees:
 * the NPC path, the coaster's rider seats (a torso 70 LDU low sat inside
 * the chassis), the building shell a posed figure stays in, and the voxel
 * grid. 76417's big-fig `37777` has no LDD→LDraw alignment row and arrived
 * 10 / −70.5 LDU from its shoulders; a figure that agrees with itself is
 * returned untouched (the same objects, so identity-keyed sets stay valid).
 * A torso-less group has no torso to move.
 */
export function repairFigureTorsos(bricks: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): { bricks: ParsedBrick[]; repairs: TorsoRepair[] } {
  const repairs: TorsoRepair[] = [];
  const replaced = new Map<number, ParsedBrick>();
  for (const g of groupFigures(bricks, meshes)) {
    const parts = g.parts.map(i => bricks[i]!);
    const root = figureAnchor(parts, meshes);
    if (!root || root.headless) continue;
    const a = assembleMinifig(parts, meshes);
    if (!a.reanchoredLdu) continue;
    const torso = bricks[g.torso]!;
    replaced.set(g.torso, { ...torso, x: a.torso.position[0], y: a.torso.position[1], z: a.torso.position[2] });
    repairs.push({ part: torso.part, system: a.system, offsetLdu: [a.torso.position[0] - torso.x, a.torso.position[1] - torso.y, a.torso.position[2] - torso.z] });
  }
  if (!replaced.size) return { bricks, repairs };
  return { bricks: bricks.map((b, i) => replaced.get(i) ?? b), repairs };
}

/** One line per repair, for the export warnings. */
export const describeTorsoRepairs = (repairs: readonly TorsoRepair[]): string =>
  repairs.map(r => `${r.part.replace(/\.dat$/i, '')} (${r.system}) moved ${Math.round(Math.hypot(...r.offsetLdu))} LDU to its limbs`).join('; ');

/**
 * Whether a torso group is a minifig that should LIVE (walk as an NPC) or a
 * display piece that stays in the block scenery: a group in ONE colour is a
 * statue (the museum's two light-grey figures on plinths, Pixel round 3),
 * and a group without legs is a bust or a partial figure - as an NPC it
 * rendered as a floating blob.
 */
export function figureRole(parts: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>): 'npc' | 'statue' | 'partial' {
  const colours = new Set(parts.map(b => b.color));
  const d = (b: ParsedBrick): string => normaliseFigureDescription(meshes.get(b.part)?.description ?? '');
  // The minifig rig (minifig-rig.ts) supplies missing legs, arms and a head,
  // so a figure only needs its torso plus one more BODY part to be one - the
  // IOModel2V2 museum has three figures with no legs (its arms DO exist -
  // they are `981`/`982`, resolved through the `~Moved to` redirect). A
  // lone torso with a hand beside it is not a figure.
  const bodyParts = parts.filter(b => /^(970|3815|3816|3817|41879|16968|3626|3625|3624|3818|3819)(?![0-9])/.test(mouldFamilyId(b.part, meshes.get(b.part)?.description ?? ''))
    || /^Minifig (Hips|Leg|Head|Arm|Hair|Hat|Helmet|Cap|Hood)\b/i.test(d(b)) || /_(head|legs|hips)$/.test(cleanPartId(b.part))
    // A mini-doll's head, hips, legs, arms or hair; a big-fig's arms, hands or hair-head.
    || (classifyMiniDollPart(b.part, meshes.get(b.part)?.description ?? '') ?? 'doll_torso') !== 'doll_torso'
    || /^(Arm Large|Bigfig (Arm|Hand))\b/i.test(d(b)));
  if (!bodyParts.length) return 'partial';
  if (colours.size === 1 && parts.length >= 3) return 'statue';
  return 'npc';
}

/** A wheel or tyre by the library description (`Wheel 8mm D. x 6mm`, `Tyre 6/ 50 x 8`), else by the compiler's id list. */
const isWheelDescription = (description: string): boolean => /^[~=_]*\s*(Wheel|Tyre|Tire)\b/i.test(description) && !/^[~=_]*\s*Wheel (Holder|Arch|Cover|Hub)/i.test(description);
const isWheelPartWith = (meshes: Map<string, LdrawPartMesh | null>) => (b: ParsedBrick): boolean => {
  const p = cleanPartId(b.part);
  return WHEEL_PARTS.has(p) || p.includes('wheel') || p.includes('tire') || isWheelDescription(meshes.get(b.part)?.description ?? '');
};

function summariseExtras(extras: EntityExtra[]): string {
  const count = (role: ExtraRole): number => extras.filter(e => e.role === role).length;
  const parts: string[] = [];
  if (count('figure')) parts.push(`${count('figure')} figure${count('figure') === 1 ? '' : 's'}`);
  if (count('vehicle')) parts.push(`${count('vehicle')} secondary vehicle${count('vehicle') === 1 ? '' : 's'}`);
  if (count('prop')) parts.push(`${count('prop')} prop${count('prop') === 1 ? '' : 's'}`);
  return parts.join(', ') || 'nothing classified';
}

/**
 * Everything the compiler decides about WHICH placements are the vehicle,
 * in one place, so the CLI probes see exactly what the geometry sees:
 *
 *   1. level a posed source (`levelModel`) and straighten turned front wheels;
 *   2. resolve every unique part to its mesh (Technic internals included -
 *      an axle is what connects a wheel to the chassis);
 *   3. split the placements into physically connected objects on real part
 *      bounds (`connectedClusters`, 4 LDU);
 *   4. the largest object is the vehicle. Every other object is CLASSIFIED:
 *      a `figure` (a torso group plus at most a few carried/stood-on parts),
 *      a secondary `vehicle` (wheels or a seat and at least 12 parts, or a
 *      large object), or a `prop` (a stand, a crate, a plaque). A tiny
 *      cluster (≤ 3) inside the vehicle's own box is a floating source defect
 *      and stays attached; a cluster at least 40 % of the vehicle with no
 *      wheels of its own is treated as a split of the same vehicle;
 *   5. the display-stand rules run on the vehicle: a car keeps only what
 *      sits inside its wheel envelope and above its wheel line, a plane
 *      drops a small cluster far below its canopy. Whole figures dropped by
 *      those rules are re-offered as `figure` extras (76286's four figures
 *      stand on the plaque under the ship), the rest is the stand.
 *
 * The X-wing (7140) before this: its service cart stood under a wing, inside
 * the plane's bounding box, so it was "attached"; Biggs stood under the other
 * wing. Both are extras now.
 */
/**
 * The whole model as ONE object, as placed: meshes resolved, buried Technic
 * internals skipped, nothing levelled, clustered, classified or dropped. A
 * building shell keeps every loose piece (a signpost, a tree beside the
 * museum); a rigged figure arrives canonical from minifig-rig.ts.
 */
export async function prepareWholeModel(bricks: ParsedBrick[], provider: PartGeometryProvider): Promise<PreparedEntityPlacements> {
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  // A figure kept in a shell or riding a car at its source pose still gets
  // its torso where its limbs are (idempotent: a rigged figure arrives repaired).
  bricks = repairFigureTorsos(bricks, meshes).bricks;
  const placed: ParsedBrick[] = [], placedIdx: number[] = [];
  let skippedInternalCount = 0;
  bricks.forEach((b, i) => {
    if (TECHNIC_INTERNAL.has(cleanPartId(b.part))) { skippedInternalCount++; return; }
    placed.push(b); placedIdx.push(i);
  });
  const worldBoundsOf = (b: ParsedBrick): { min: Vec3; max: Vec3 } => {
    const mesh = meshes.get(b.part);
    let lo: Vec3, hi: Vec3;
    if (mesh && mesh.triangles.length) { lo = mesh.bounds.min; hi = mesh.bounds.max; }
    else { const [sW, sH, sL] = getPartDims(b.part); lo = [-sL * 10, -sH * 8, -sW * 10]; hi = [sL * 10, 0, sW * 10]; }
    const R = b.rot ?? IDENTITY;
    return aabbOfCorners(cornersOf(lo, hi).map(v => { const r = apply(R, v); return [r[0] + b.x, r[1] + b.y, r[2] + b.z] as Vec3; }));
  };
  const centre: Vec3 = bricks.length ? [
    bricks.reduce((s, b) => s + b.x, 0) / bricks.length, bricks.reduce((s, b) => s + b.y, 0) / bricks.length, bricks.reduce((s, b) => s + b.z, 0) / bricks.length,
  ] : [0, 0, 0];
  // A shell compiles every placement as given, so its loose pieces are the
  // SOURCE's (an exploded instruction layout, a converted model with gaps):
  // counted here so the export can say so instead of the player finding them.
  const wholeOrphans = analyseOrphans(placed.map(worldBoundsOf));
  return {
    level: { bricks, rotation: null, centre, alignedBefore: bricks.length, alignedAfter: bricks.length, angleDeg: 0 },
    placed, placedIdx, meshes,
    displayDropped: { placements: 0, rule: null }, detached: { placements: 0, groups: 0 }, extras: [],
    skippedInternalCount, strandedRepaired: 0, standContinued: 0,
    // This early path has no sub-build analysis to report.
    orphans: wholeOrphans,
    worldBoundsOf,
  };
}

export async function prepareEntityPlacements(kind: EntityKind, bricks: ParsedBrick[], provider: PartGeometryProvider): Promise<PreparedEntityPlacements> {
  const level = levelModel(bricks);
  bricks = level.bricks;

  const uniqueAll = [...new Set(bricks.map(b => b.part))];
  const meshes = new Map<string, LdrawPartMesh | null>();
  await Promise.all(uniqueAll.map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
  // A seated figure inside a vehicle stays in its geometry at the source pose: its torso where its limbs are.
  bricks = repairFigureTorsos(bricks, meshes).bricks;
  const worldBoundsOf = (b: ParsedBrick): { min: Vec3; max: Vec3 } => {
    const mesh = meshes.get(b.part);
    let lo: Vec3, hi: Vec3;
    if (mesh && mesh.triangles.length) { lo = mesh.bounds.min; hi = mesh.bounds.max; }
    else { const [sW, sH, sL] = getPartDims(b.part); lo = [-sL * 10, -sH * 8, -sW * 10]; hi = [sL * 10, 0, sW * 10]; }
    const R = b.rot ?? IDENTITY;
    return aabbOfCorners(cornersOf(lo, hi).map(v => { const r = apply(R, v); return [r[0] + b.x, r[1] + b.y, r[2] + b.z] as Vec3; }));
  };
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const isWheelPart = isWheelPartWith(meshes);

  // Wheel-yaw alignment (a car whose front wheels are turned in the source) is
  // applied to the whole placement set before anything measures it.
  const wheels = bricks.filter(isWheelPart);
  if (kind === 'car' && wheels.length >= 4) {
    const wheelZs = wheels.map(b => b.z);
    const midZw = (Math.min(...wheelZs) + Math.max(...wheelZs)) / 2;
    const front = wheels.filter(b => b.z < midZw), rear = wheels.filter(b => b.z >= midZw);
    if (front.length >= 2 && rear.length >= 2) {
      const fX = front.reduce((a, b) => a + b.x, 0) / front.length, fZ = front.reduce((a, b) => a + b.z, 0) / front.length;
      const rX = rear.reduce((a, b) => a + b.x, 0) / rear.length, rZ = rear.reduce((a, b) => a + b.z, 0) / rear.length;
      const yaw = Math.atan2(fX - rX, fZ - rZ);
      if (Math.abs(yaw) > 0.05 && Math.abs(yaw) < Math.PI * 0.45) {
        const cosT = Math.cos(-yaw), sinT = Math.sin(-yaw);
        const pivotX = (fX + rX) / 2, pivotZ = (fZ + rZ) / 2;
        const yawRot: number[] = [cosT, 0, sinT, 0, 1, 0, -sinT, 0, cosT];
        bricks = bricks.map(b => {
          const relX = b.x - pivotX, relZ = b.z - pivotZ;
          return { ...b, x: relX * cosT + relZ * sinT + pivotX, z: -relX * sinT + relZ * cosT + pivotZ, rot: mul(yawRot, b.rot ?? IDENTITY) };
        });
      }
    }
  }
  const boxes = bricks.map(worldBoundsOf);
  const figures = groupFigures(bricks, meshes);
  const figureOf = new Map<number, number>(); // placement → figure index
  figures.forEach((f, k) => { for (const i of f.parts) figureOf.set(i, k); });

  // 3-4. Objects.
  const clusters = connectedClusters(boxes);
  const primary = clusters[0] ?? [];
  // The vehicle's box grows as split-off clusters are attached (largest first), so
  // a piece floating between two decks that do not touch is inside it by the time it is judged.
  let primaryBox = primary.length ? aabbOfCorners(primary.flatMap(i => [boxes[i]!.min, boxes[i]!.max])) : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  const attached: number[] = [];
  const attach = (cluster: number[]): void => {
    attached.push(...cluster);
    primaryBox = aabbOfCorners([primaryBox.min, primaryBox.max, ...cluster.flatMap(i => [boxes[i]!.min, boxes[i]!.max])]);
  };
  const extras: EntityExtra[] = [];
  const makeExtra = (indices: number[], role: ExtraRole, reason: string): EntityExtra => {
    const box = aabbOfCorners(indices.flatMap(i => [boxes[i]!.min, boxes[i]!.max]));
    const torso = indices.find(i => isTorso(bricks[i]!.part, desc(bricks[i]!)));
    let facingLdu: [number, number] | undefined;
    if (torso !== undefined) {
      const f = apply(bricks[torso]!.rot ?? IDENTITY, [0, 0, -1]);
      const h = Math.hypot(f[0], f[2]);
      if (h > 0.5) facingLdu = [f[0] / h, f[2] / h];
    }
    return {
      role, sourceIndices: indices, bricks: indices.map(i => bricks[i]!),
      centreLdu: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2],
      floorLdu: box.max[1], ...(facingLdu ? { facingLdu } : {}), reason,
      wheels: indices.filter(i => isWheelPart(bricks[i]!)).length,
      seats: indices.filter(i => isSeat(bricks[i]!.part, desc(bricks[i]!))).length,
      figureParts: indices.filter(i => isFigurePart(bricks[i]!.part, desc(bricks[i]!))).length,
    };
  };
  /** Split a cluster into its figures (one extra each) and whatever is left. */
  const classify = (cluster: number[], inPrimaryBox: boolean): void => {
    const byFigure = new Map<number, number[]>();
    const rest: number[] = [];
    for (const i of cluster) { const f = figureOf.get(i); if (f === undefined) rest.push(i); else { const l = byFigure.get(f); if (l) l.push(i); else byFigure.set(f, [i]); } }
    const wheelCount = rest.filter(i => isWheelPart(bricks[i]!)).length;
    const seatCount = rest.filter(i => isSeat(bricks[i]!.part, desc(bricks[i]!))).length;
    const figureExtra = (parts: number[]): void => {
      const role = figureRole(parts.map(i => bricks[i]!), meshes);
      if (role === 'npc') extras.push(makeExtra(parts, 'figure', 'minifig torso with its head, legs and dressing'));
      else extras.push(makeExtra(parts, 'prop', role === 'statue' ? 'single-colour figure: a statue' : 'figure without legs: a bust or partial figure'));
    };
    if (byFigure.size && rest.length <= 4 + byFigure.size * 2) {
      // A figure (or a few standing together) with what it holds / stands on.
      for (const parts of byFigure.values()) figureExtra(parts);
      if (rest.length) extras.push(makeExtra(rest, 'prop', `${rest.length} part${rest.length === 1 ? '' : 's'} beside a figure`));
      return;
    }
    if (cluster.length <= 3 && inPrimaryBox) { attach(cluster); return; } // a floating source defect inside the body
    if (cluster.length >= primary.length * 0.4 && wheelCount === 0 && !byFigure.size) { attach(cluster); return; } // a split of the same vehicle
    for (const parts of byFigure.values()) figureExtra(parts);
    if (rest.length >= 12 && (wheelCount >= 2 || seatCount >= 1 || rest.length >= primary.length * 0.15)) {
      extras.push(makeExtra(rest, 'vehicle', wheelCount >= 2 ? `${wheelCount} wheels` : seatCount ? `${seatCount} seat${seatCount === 1 ? '' : 's'}` : `${rest.length} parts`));
    } else if (rest.length) {
      extras.push(makeExtra(rest, 'prop', `${rest.length} part${rest.length === 1 ? '' : 's'}, no wheels or seat`));
    }
  };
  for (let c = 1; c < clusters.length; c++) {
    const cluster = clusters[c]!;
    const box = aabbOfCorners(cluster.flatMap(i => [boxes[i]!.min, boxes[i]!.max]));
    const margin = 20;
    const inside = box.min[0] >= primaryBox.min[0] - margin && box.max[0] <= primaryBox.max[0] + margin
      && box.min[1] >= primaryBox.min[1] - margin && box.max[1] <= primaryBox.max[1] + margin
      && box.min[2] >= primaryBox.min[2] - margin && box.max[2] <= primaryBox.max[2] + margin;
    classify(cluster, inside);
  }
  let vehicleIdx = [...primary, ...attached].sort((a, b) => a - b);
  const detached = { placements: bricks.length - vehicleIdx.length, groups: extras.length };

  // 5. Display-stand rules on the vehicle. Figures are judged by their FEET so a
  //    figure standing on the plaque is dropped whole (and re-offered as an extra)
  //    instead of being cut at the waist and then discarded as floating debris.
  let displayRule: PreparedEntityPlacements['displayDropped']['rule'] = null;
  const footY = (i: number): number => { const f = figureOf.get(i); return f === undefined ? bricks[i]!.y : bricks[figures[f]!.torso]!.y + 72; };
  const vehicleWheels = vehicleIdx.filter(i => isWheelPart(bricks[i]!));
  let keep: number[] = vehicleIdx;
  if (kind === 'car' && vehicleWheels.length >= 4) {
    const wheelYs = vehicleWheels.map(i => bricks[i]!.y);
    const groundY = Math.max(...wheelYs) + 60;
    // A car's display stand is BELOW it. The height test alone says that.
    // The rule used to ALSO require every placement's ORIGIN to sit inside a
    // box 120 LDU (6 studs) around the outermost wheel CENTRES - narrower
    // than any real car's overhang. Measured 2026-09-18 on the sources the
    // device round shipped: 10337's body reaches 183 LDU past the front hubs
    // and 161 past the rear, so the whole nose, the rear wing and its two
    // struts went out as "display stand" (202 of 1299 placements) and the
    // wing's two plates were left hanging in mid-air - the floating slab in
    // `output/bedrock-entity-qa/device-2026-09-18/shots/car-view-3-front.jpg`.
    // 42172 lost 870 of 2892 the same way. Neither set HAS a display stand.
    const filtered = vehicleIdx.filter(i => footY(i) <= groundY + 40);
    if (filtered.length >= vehicleIdx.length * 0.6 && filtered.length < vehicleIdx.length) { keep = filtered; displayRule = 'wheel-envelope'; }
  } else if (kind === 'plane') {
    const canopyParts = vehicleIdx.filter(i => isCanopyMould(bricks[i]!.part, desc(bricks[i]!)));
    if (canopyParts.length) {
      const canopyY = canopyParts.reduce((a, i) => a + bricks[i]!.y, 0) / canopyParts.length;
      const stand = vehicleIdx.filter(i => footY(i) > canopyY + 250);
      if (stand.length > 0 && stand.length < vehicleIdx.length * 0.2) { keep = vehicleIdx.filter(i => footY(i) <= canopyY + 250); displayRule = 'stand-below-canopy'; }
    }
  }
  // A stand's mast reaches UP past the height line: the Milano's stand drops
  // 52 placements and leaves two Technic beams (`32524`) hanging under the
  // hull, and since the render frame grounds the model on its LOWEST cuboid
  // (step 6 of compileLdrawEntityGeometry) the hull then hovers a mast high
  // on a thin stalk. Grow the drop from the stand through touching placements
  // whose underside lies below the hull's lower envelope - the lowest point
  // of everything that does NOT touch the stand. Measured on 76286 before it
  // was built: this claims exactly the 2 beams, where a footprint rule
  // ("inside the stand's XZ") would have taken 80 hull plates.
  let standContinued = 0;
  if (displayRule === 'stand-below-canopy') {
    const kept0 = new Set(keep);
    let dropped = vehicleIdx.filter(i => !kept0.has(i));
    const onStand = new Set(touchingIndices(boxes, dropped, keep));
    const envelope = Math.max(...keep.filter(i => !onStand.has(i)).map(i => boxes[i]!.max[1]));
    for (let pass = 0; pass < 8 && Number.isFinite(envelope); pass++) {
      const hanging = touchingIndices(boxes, dropped, keep).filter(i => boxes[i]!.max[1] > envelope + 24);
      if (!hanging.length) break;
      const h = new Set(hanging);
      keep = keep.filter(i => !h.has(i));
      dropped = [...dropped, ...hanging];
      standContinued += hanging.length;
    }
    // The mast's own fittings - the pins in its top (76286: 3673 + 2 x 2780) -
    // touch nothing but the mast once it is gone. Left to the repair below
    // they would bridge the whole mast back (measured: 5 out, 5 back). A
    // stranded piece of at most 4 placements that touches the dropped set is
    // the stand's and goes with it; the repair only rescues real structure.
    if (standContinued) {
      const groups = connectedClusters(keep.map(i => boxes[i]!)).slice(1);
      const fittings = groups.filter(g => g.length <= 4).map(g => g.map(k => keep[k]!))
        .filter(members => touchingIndices(boxes, dropped, members).length > 0).flat();
      if (fittings.length) {
        const f = new Set(fittings);
        keep = keep.filter(i => !f.has(i));
        dropped = [...dropped, ...fittings];
        standContinued += fittings.length;
      }
    }
  }
  // A display-stand drop may not DISCONNECT the model: a piece that reached the
  // body only through a dropped placement would hang in mid-air (10337's rear
  // wing sat one block over the deck on its own in the 2026-09-18 device round,
  // its two struts having gone out with the "stand"). Grow each stranded piece
  // back through the dropped placements, one contact layer per pass, until it
  // meets the body again; a piece that is already loose in the SOURCE finds no
  // bridge and is left alone (and reported below).
  let strandedRepaired = 0;
  if (displayRule) {
    for (let pass = 0; pass < 8; pass++) {
      const groups = connectedClusters(keep.map(i => boxes[i]!));
      if (groups.length <= 1) break;
      const kept = new Set(keep);
      const droppedIdx = vehicleIdx.filter(i => !kept.has(i));
      if (!droppedIdx.length) break;
      const stranded = groups.slice(1).flatMap(g => g.map(k => keep[k]!));
      const bridge = touchingIndices(boxes, stranded, droppedIdx);
      if (!bridge.length) break;
      strandedRepaired += bridge.length;
      keep = [...keep, ...bridge].sort((a, b) => a - b);
    }
    if (keep.length === vehicleIdx.length) displayRule = null;
  }

  const keepSet = new Set(keep);
  const displayDroppedIdx = displayRule ? vehicleIdx.filter(i => !keepSet.has(i)) : [];
  if (displayDroppedIdx.length) {
    vehicleIdx = keep;
    // Whole figures on the stand become extras; the rest of the stand is a prop.
    const byFigure = new Map<number, number[]>();
    const stand: number[] = [];
    for (const i of displayDroppedIdx) { const f = figureOf.get(i); if (f === undefined) stand.push(i); else { const l = byFigure.get(f); if (l) l.push(i); else byFigure.set(f, [i]); } }
    for (const parts of byFigure.values()) extras.push(makeExtra(parts, 'figure', 'figure standing on the display stand'));
    if (stand.length) extras.push(makeExtra(stand, 'prop', `display stand (${displayRule})`));
  }
  const displayDropped = { placements: displayDroppedIdx.length, rule: displayRule };

  let skippedInternalCount = 0;
  const placedIdx: number[] = [];
  const placed: ParsedBrick[] = [];
  for (const i of vehicleIdx) {
    const b = bricks[i]!;
    if (TECHNIC_INTERNAL.has(cleanPartId(b.part))) { skippedInternalCount++; continue; }
    placedIdx.push(i); placed.push(b);
  }
  // What a player would see floating, AFTER every rule has run.
  //
  // The group count alone says nothing: a model may legitimately be several
  // sub-builds standing apart. 76417 Gringotts is TWO halves of 2,867 and
  // 1,511 parts about 115 studs apart in every one of its five sources - that
  // is how the set is displayed, not a fault. What a player calls a floating
  // piece is a SMALL group with clear air around it, and 76417 has 409 parts
  // in 50 of those, up to 43.7 studs clear. One number for both said "1,832
  // placements in 72 pieces", which cannot tell them apart and fired on 39 of
  // 40 sets.
  const orphans = analyseOrphans(placed.map(worldBoundsOf));
  return { level: { ...level, bricks }, placed, placedIdx, meshes, displayDropped, detached, extras, skippedInternalCount, strandedRepaired, standContinued, orphans, worldBoundsOf };
}

// ─── Cockpit ──────────────────────────────────────────────────────────────────

interface CockpitFrame { nose: NoseDirection; isXLongitudinal: boolean; forwardSign: number; spanX: number; spanZ: number }

/**
 * Where the driver's EYES are, from the best evidence available, in order:
 *   1. a seated figure inside the vehicle's footprint - eyes 11 LDU above the
 *      torso origin (the head's origin is 24 LDU up, the eyes half-way down
 *      the 24 LDU head); the figure nearest a steering wheel, else the
 *      front-most, is the driver and its parts come back in `driverParts`;
 *   2. a seat mould - a figure on it has its eyes 51 LDU above the seat (8
 *      hips, 32 torso, 11 to the eyes), centred over the seat;
 *   3. a steering wheel / stand - the driver sits 30 LDU behind it (its
 *      local +Z), eyes 20 LDU above the wheel;
 *   4. the LARGEST windscreen / canopy mould - eyes at its centre;
 *   5. the largest translucent part big enough to be glass (≥ 30 LDU on two
 *      axes) - eyes at its centre; a lamp or an engine glow never qualifies;
 *   6. the default forward cabin (20 % forward, 35 % up).
 */
export function findCockpit(placed: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, frame: CockpitFrame): { source: CockpitSource; eyeLdu: Vec3; detail: string; driverParts: number[]; passengerEyesLdu: Vec3[] } {
  const cockpit = findDriverSeat(placed, meshes, frame);
  // Passenger seats: every OTHER free seat mould (not the driver's, none a
  // figure already sits on), eyes 51 LDU above it like the driver's. A seated
  // figure stays in the model, so its seat is not offered to a player.
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const local = (b: ParsedBrick, v: Vec3): Vec3 => { const r = apply(b.rot ?? IDENTITY, v); return [b.x + r[0], b.y + r[1], b.z + r[2]]; };
  const torsos = groupFigures(placed, meshes).map(f => placed[f.torso]!);
  const passengerEyesLdu = placed
    .filter(b => isSeat(b.part, desc(b)))
    .map(b => local(b, [0, -51, 0]))
    .filter(eye => Math.hypot(eye[0] - cockpit.eyeLdu[0], eye[2] - cockpit.eyeLdu[2]) > 15)
    .filter(eye => !torsos.some(t => Math.hypot(t.x - eye[0], t.z - eye[2]) < 20 && Math.abs(t.y - (eye[1] + 11)) < 40));
  return { ...cockpit, passengerEyesLdu };
}

function findDriverSeat(placed: ParsedBrick[], meshes: Map<string, LdrawPartMesh | null>, frame: CockpitFrame): { source: CockpitSource; eyeLdu: Vec3; detail: string; driverParts: number[] } {
  const desc = (b: ParsedBrick): string => meshes.get(b.part)?.description ?? '';
  const xs = placed.map(b => b.x), zs = placed.map(b => b.z), ys = placed.map(b => b.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const along = (b: ParsedBrick): number => frame.isXLongitudinal ? (b.x - cx) * frame.forwardSign : (b.z - cz) * frame.forwardSign;
  const local = (b: ParsedBrick, v: Vec3): Vec3 => { const r = apply(b.rot ?? IDENTITY, v); return [b.x + r[0], b.y + r[1], b.z + r[2]]; };

  // 1. Seated figure.
  const figures = groupFigures(placed, meshes);
  const insideX0 = minX + frame.spanX * 0.08, insideX1 = maxX - frame.spanX * 0.08, insideZ0 = minZ + frame.spanZ * 0.08, insideZ1 = maxZ - frame.spanZ * 0.08;
  const seatedFigures = figures.filter(f => { const t = placed[f.torso]!; return t.x >= insideX0 && t.x <= insideX1 && t.z >= insideZ0 && t.z <= insideZ1 && t.y + 72 < maxY - 8; });
  const wheels = placed.filter(b => isSteering(b.part, desc(b)));
  if (seatedFigures.length) {
    let driver = seatedFigures[0]!;
    if (wheels.length) {
      const d = (f: { torso: number }): number => Math.min(...wheels.map(w => Math.hypot(w.x - placed[f.torso]!.x, w.y - placed[f.torso]!.y, w.z - placed[f.torso]!.z)));
      driver = seatedFigures.reduce((a, b) => d(b) < d(a) ? b : a);
    } else {
      driver = seatedFigures.reduce((a, b) => along(placed[b.torso]!) > along(placed[a.torso]!) ? b : a);
    }
    const torso = placed[driver.torso]!;
    return { source: 'seated-figure', eyeLdu: local(torso, [0, -11, 0]), detail: `${seatedFigures.length} seated figure${seatedFigures.length === 1 ? '' : 's'}; driver torso ${cleanPartId(torso.part)} at ${Math.round(torso.x)}, ${Math.round(torso.y)}, ${Math.round(torso.z)}`, driverParts: driver.parts };
  }
  // 2. Seat moulds.
  const seats = placed.filter(b => isSeat(b.part, desc(b)));
  if (seats.length) {
    const nearestWheel = (b: ParsedBrick): number => Math.min(...wheels.map(w => Math.hypot(w.x - b.x, w.z - b.z)));
    const seat = wheels.length
      ? seats.reduce((a, b) => nearestWheel(b) < nearestWheel(a) ? b : a)
      : seats.reduce((a, b) => along(b) > along(a) ? b : a);
    return { source: 'seat-parts', eyeLdu: local(seat, [0, -51, 0]), detail: `${seats.length} seat${seats.length === 1 ? '' : 's'}; ${cleanPartId(seat.part)} at ${Math.round(seat.x)}, ${Math.round(seat.y)}, ${Math.round(seat.z)}`, driverParts: [] };
  }
  // 3. Steering wheel.
  if (wheels.length) {
    const w = wheels.reduce((a, b) => along(b) > along(a) ? b : a);
    return { source: 'steering-wheel', eyeLdu: local(w, [0, -20, 30]), detail: `${cleanPartId(w.part)} at ${Math.round(w.x)}, ${Math.round(w.y)}, ${Math.round(w.z)}`, driverParts: [] };
  }
  // 4-5. Glass: the largest canopy mould, else the largest translucent part that is big enough to be glass.
  const boundsCentre = (b: ParsedBrick): { centre: Vec3; size: Vec3; volume: number } | null => {
    const m = meshes.get(b.part);
    if (!m || !m.triangles.length) return null;
    const box = aabbOfCorners(cornersOf(m.bounds.min, m.bounds.max).map(v => local(b, v)));
    const size: Vec3 = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    return { centre: [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2], size, volume: size[0] * size[1] * size[2] };
  };
  const largest = (list: ParsedBrick[]): { brick: ParsedBrick; centre: Vec3 } | null => {
    let best: { brick: ParsedBrick; centre: Vec3; volume: number } | null = null;
    for (const b of list) { const c = boundsCentre(b); if (c && (!best || c.volume > best.volume)) best = { brick: b, centre: c.centre, volume: c.volume }; }
    return best;
  };
  const canopy = largest(placed.filter(b => isCanopyMould(b.part, desc(b))));
  if (canopy) return { source: 'canopy-parts', eyeLdu: canopy.centre, detail: `${cleanPartId(canopy.brick.part)} at ${Math.round(canopy.brick.x)}, ${Math.round(canopy.brick.y)}, ${Math.round(canopy.brick.z)}`, driverParts: [] };
  const glass = largest(placed.filter(b => {
    if (resolveLdrawEntityMaterial(b.color).alpha >= 1) return false;
    const c = boundsCentre(b);
    return !!c && [...c.size].sort((p, q) => q - p)[1]! >= 30;
  }));
  if (glass) return { source: 'translucent-canopy', eyeLdu: glass.centre, detail: `${cleanPartId(glass.brick.part)} at ${Math.round(glass.brick.x)}, ${Math.round(glass.brick.y)}, ${Math.round(glass.brick.z)}`, driverParts: [] };
  // 6. Default forward cabin.
  const eye: Vec3 = frame.isXLongitudinal
    ? [cx + frame.forwardSign * frame.spanX * 0.2, minY + (maxY - minY) * 0.35, cz]
    : [cx, minY + (maxY - minY) * 0.35, cz + frame.forwardSign * frame.spanZ * 0.2];
  return { source: 'default-cabin', eyeLdu: eye, detail: 'no figure, seat, steering wheel or glass found', driverParts: [] };
}

export async function compileLdrawEntityGeometry(
  cid: string,
  kind: EntityKind,
  bricks: ParsedBrick[],
  options: CompileLdrawEntityOptions = {},
): Promise<CompiledLdrawGeometry> {
  const scale = options.scale ?? BEDROCK_UNITS_PER_LDU;
  const provider = options.partGeometry ?? createPartGeometryProvider();
  // A FIGURE is compiled at `balanced` however fine the pack's quality: a 1 LDU
  // minifig costs 8-13x the cuboids of a 4 LDU one for 0.05-0.09 of six-view
  // silhouette IoU, and cuboids are what the device's whole-add-on memory
  // ceiling is denominated in. See `clampFigureQuality` for the measurements.
  // Vehicles, props and building shells keep the quality the caller asked for.
  const requestedQuality = resolveEntityQuality(options.quality);
  const baseQuality = kind === 'figure' ? clampFigureQuality(requestedQuality) : requestedQuality;
  const figureQualityClamped = baseQuality.microcellLdu !== requestedQuality.microcellLdu
    ? { requestedMicrocellLdu: requestedQuality.microcellLdu, microcellLdu: baseQuality.microcellLdu }
    : undefined;
  // See `CompileLdrawEntityOptions.decomposition`: the per-pack saving is
  // -5.4 % at 2 LDU and -0.8 % at 4 LDU (where one of the three golden models
  // gets worse), so the default follows the grain the compile actually runs at.
  const decomposition: PartDecomposition =
    options.decomposition ?? (baseQuality.microcellLdu <= 2 ? 'best-of' : 'greedy');
  const warnings: string[] = [];

  // A figure is rebuilt on the minifig rig (minifig-rig.ts): canonical pose,
  // the parts a converted source lost supplied, joints for the walk animation.
  // The compile then runs on the canonical figure in its own torso frame.
  if (kind === 'figure' && !options.rig) {
    const meshes = new Map<string, LdrawPartMesh | null>();
    await Promise.all([...new Set(bricks.map(b => b.part))].map(async part => { meshes.set(part, await provider.getPartMesh(part)); }));
    if (figureAnchor(bricks, meshes)) {
      const figure = assembleMinifig(bricks, meshes);
      const inner = await compileLdrawEntityGeometry(cid, 'figure', figure.bricks, {
        ...options, partGeometry: provider, rig: figure.rig, frame: ldrawToRenderRotation('-z'), wholeModel: true, figureSlots: figure.slots,
      });
      inner.figure = { facingLdu: figure.facingLdu, synthesized: figure.synthesized, dropped: figure.dropped, system: figure.system };
      inner.diagnostics.minifig = { parts: figure.bricks.length, synthesized: figure.synthesized, dropped: figure.dropped, system: figure.system, ...(figure.reanchoredLdu ? { reanchoredLdu: figure.reanchoredLdu } : {}) };
      if (figure.reanchoredLdu) {
        const o = figure.reanchoredLdu.map(v => Math.round(v * 10) / 10);
        inner.warnings.push(`${cid}: the source placed the ${figure.system} torso ${Math.round(Math.hypot(...figure.reanchoredLdu))} LDU (${o.join(', ')}) away from where its own limbs and head put the shoulders; the figure was rebuilt around the limbs (a converted torso with no alignment row sits at its raw origin).`);
      }
      if (figure.synthesized.length) inner.warnings.push(`${cid}: the source lacked the figure's ${figure.synthesized.join(', ')}; standard moulds were supplied.`);
      if (figure.dropped.length) inner.warnings.push(`${cid}: ${figure.dropped.length} part${figure.dropped.length === 1 ? '' : 's'} of the figure could not be placed on the rig (${figure.dropped.slice(0, 4).join(', ')}).`);
      // Not a failure: a part the minifig rig has no slot for (a mini-doll's
      // head or arms, caught in the same group) is kept where the source put
      // it. Said out loud because it means the group held two figure systems.
      if (figure.bystanders.length) inner.warnings.push(`${cid}: ${figure.bystanders.length} part${figure.bystanders.length === 1 ? '' : 's'} in the figure's group belong to no minifig slot and were left where the source put them (${figure.bystanders.slice(0, 4).join(', ')}).`);
      return inner;
    }
    warnings.push(`${cid}: no torso among the figure's parts; compiled as placed, without joints.`);
  }

  // 0-1. Level the pose, resolve meshes, split the placements into physically
  // connected objects, classify the secondary ones (figures, a service cart,
  // a display stand) and apply the display-stand rules - prepareEntityPlacements.
  const prepared = options.wholeModel || options.rig
    ? await prepareWholeModel(bricks, provider)
    : await prepareEntityPlacements(kind, bricks, provider);
  const { level, meshes, displayDropped, detached, extras, strandedRepaired, standContinued, orphans } = prepared;
  bricks = level.bricks;
  let placed = prepared.placed;
  let placedIdx = prepared.placedIdx;
  let uniqueParts = [...new Set(placed.map(b => b.part))];
  const skippedInternalCount = prepared.skippedInternalCount;
  if (displayDropped.placements) warnings.push(`${cid}: ${displayDropped.placements} placement${displayDropped.placements === 1 ? '' : 's'} left out as a display stand (${displayDropped.rule === 'wheel-envelope' ? 'below the wheel line' : 'a small cluster far below the canopy'}).`);
  if (strandedRepaired) warnings.push(`${cid}: ${strandedRepaired} placement${strandedRepaired === 1 ? '' : 's'} were put back after the display-stand drop: leaving them out would have left part of the model hanging in mid-air.`);
  if (standContinued) warnings.push(`${cid}: ${standContinued} placement${standContinued === 1 ? '' : 's'} hanging off the display stand below the hull (its mast) went out with it, so the model stands on its hull, not on a stalk.`);
  if (orphans.clusters && kind !== 'figure') {
    const structure = orphans.subBuilds > 1
      ? `the model is ${orphans.subBuilds} sub-builds standing apart (normal for a set displayed that way)`
      : `${orphans.placements} placement${orphans.placements === 1 ? '' : 's'} in ${orphans.clusters} piece${orphans.clusters === 1 ? '' : 's'} do not touch the rest of the model`;
    const floating = orphans.floatingParts
      ? ` ${orphans.floatingParts} part${orphans.floatingParts === 1 ? '' : 's'} in ${orphans.floatingGroups} piece${orphans.floatingGroups === 1 ? '' : 's'} float more than a stud clear of it${orphans.worstClearanceLdu ? `, up to ${(orphans.worstClearanceLdu / 20).toFixed(1)} studs` : ''} - those are loose in the SOURCE and will look like floating pieces in game.`
      : ' Nothing floats clear of it.';
    warnings.push(`${cid}: ${structure};${floating}`);
  }
  if (detached.placements) warnings.push(`${cid}: ${detached.placements} placement${detached.placements === 1 ? '' : 's'} in ${detached.groups} separate object${detached.groups === 1 ? '' : 's'} beside the vehicle left out of it (${summariseExtras(extras)}).`);

  // 2. Frame: nose direction → A. The nose is INFERRED from the placements
  //    (driver parts, windscreen lean, tail lights, wheel asymmetry, canopy
  //    position, narrow end) unless the caller fixed it; see vehicle-facing.ts.
  const xs = placed.map(b => b.x), zs = placed.map(b => b.z);
  const spanX = Math.max(...xs) - Math.min(...xs), spanZ = Math.max(...zs) - Math.min(...zs);
  // A figure or prop is not a vehicle: its facing is the caller's (a figure's torso direction), else the convention.
  // An explicit frame (a building shell, a rigged figure) is not a vehicle
  // nose: the caller fixed the whole matrix and nothing is inferred.
  const facing: FacingDecision = options.frame
    ? { nose: '-z', axis: 'z', sign: -1, source: 'explicit', agreement: 1, votes: [] }
    : inferVehicleNose(placed, kind === 'figure' || kind === 'prop' ? 'car' : kind, {
      explicit: options.facing && options.facing !== 'auto' ? options.facing : (kind === 'figure' || kind === 'prop' ? '-z' : undefined),
      meshes,
      isWheel: isWheelPartWith(meshes),
    });
  const nose = facing.nose;
  const isXLongitudinal = facing.axis === 'x';
  const forwardSign = facing.sign;
  if (facing.source === 'convention') {
    warnings.push(`${cid}: front/rear direction was not identifiable from the parts; assumed the LDraw convention (nose toward ${nose}). Select an explicit vehicle facing if it drives backward.`);
  } else if (facing.agreement < 0.75) {
    warnings.push(`${cid}: facing evidence disagreed (${Math.round(facing.agreement * 100)}% agreement, chose nose ${nose}: ${facing.votes.map(v => v.signal).join(', ')}). Select an explicit vehicle facing if it drives backward.`);
  }
  const A: Mat3 = options.frame ?? ldrawToRenderRotation(nose);
  const At = transpose(A);
  // The rig's bones, pivots through the frame; every placement's bone by index.
  const rigBoneOf = (i: number): string => options.rig?.boneOf[placedIdx[i]!] ?? 'body';
  const rigParents = new Map<string, string | undefined>();
  for (const b of options.rig?.bones ?? []) rigParents.set(b.name, b.parent);

  // 3. Cockpit: ranked evidence on the PRIMARY object only (see findCockpit).
  //    A seated figure wins; the player then replaces that figure, so its
  //    parts leave the geometry (reported). The old average over every
  //    translucent part put the X-wing's rider under its tail: four engine
  //    glows and a service cart's lamps outvoted the one canopy.
  const cockpit = kind === 'figure' || kind === 'prop'
    ? { source: 'default-cabin' as const, eyeLdu: [0, 0, 0] as Vec3, detail: `${kind}: no rider`, driverParts: [], passengerEyesLdu: [] as Vec3[] }
    : findCockpit(placed, meshes, { nose, isXLongitudinal, forwardSign, spanX, spanZ });
  let driverFigureRemoved = 0;
  if (cockpit.driverParts.length) {
    const drop = new Set(cockpit.driverParts);
    driverFigureRemoved = drop.size;
    placed = placed.filter((_, i) => !drop.has(i));
    placedIdx = placedIdx.filter((_, i) => !drop.has(i));
    uniqueParts = [...new Set(placed.map(b => b.part))];
    warnings.push(`${cid}: the seated driver figure (${driverFigureRemoved} part${driverFigureRemoved === 1 ? '' : 's'}) was left out of the geometry; the player sits in its place.`);
  }

  // 3b. A driven vehicle's rig (`vehicleRig`): each road wheel on its own bone
  //     at its axle, every bone under `body`. Found on the FINAL placements
  //     (the driver figure is gone), in the levelled LDraw frame.
  const vehicleRig = !!options.vehicleRig && !options.rig && kind !== 'figure' && kind !== 'prop';
  const wheelBoneOf = new Map<number, string>();
  const wheelPivotsLdu = new Map<string, Vec3>();
  const wheelPlan: Array<{ name: string; radiusLdu: number; parts: number; centre: Vec3 }> = [];
  let wheelPlacements = 0, wheelsRejected = 0;
  if (vehicleRig) {
    const isWheel = isWheelPartWith(meshes);
    const boxes = placed.flatMap((b, i) => {
      if (!isWheel(b)) return [];
      wheelPlacements++;
      const mesh = meshes.get(b.part);
      if (!mesh || mesh.bounds.max[1] - mesh.bounds.min[1] <= 0) { wheelsRejected++; return []; }
      const R: Mat3 = b.rot ?? IDENTITY;
      const box = aabbOfCorners(cornersOf(mesh.bounds.min, mesh.bounds.max).map(v => { const r = apply(R, v); return [r[0] + b.x, r[1] + b.y, r[2] + b.z] as Vec3; }));
      return [{ index: i, min: box.min, max: box.max }];
    });
    const found = vehicleWheelAssemblies(boxes, facing.axis);
    wheelsRejected += found.rejected;
    found.wheels.forEach((w, k) => {
      const name = `wheel_${k}`;
      for (const i of w.indices) wheelBoneOf.set(i, name);
      wheelPivotsLdu.set(name, w.centre);
      wheelPlan.push({ name, radiusLdu: w.radiusLdu, parts: w.indices.length, centre: w.centre });
    });
  }

  // 4. Instantiate prototypes into the render frame (body cuboids first, studs after exposure).
  //    Prototypes are compiled once per (part, grain, hollowness) and shared by
  //    the planning pass and the final pass through this one cache.
  const cache = createPrototypeCache();
  const quality: LegoEntityQuality = { ...baseQuality };
  const protoKey = (mesh: LdrawPartMesh, hollow: boolean, preserveSurface = false): string => `${mesh.partId}|${mesh.resolvedAs}|${hollow ? 'h' : 's'}${preserveSurface ? '|p' : ''}`;
  /** The rig slot of a PLACED index (the caller's slots are parallel to the input bricks). */
  const slotOf = (i: number): MinifigSlot | undefined => options.figureSlots?.[placedIdx[i]!];
  /** Headwear is a thin shell: compile it surface-preserving (see `CompilePrototypeOptions.preserveSurface`). */
  const surfaceOf = (i: number): boolean => slotOf(i) === 'headwear';
  const faceTexturesOn = options.faceTextures !== false;
  const instantiate = (grainOf: (key: string) => number, cullAndMerge: boolean) => {
    const renderCuboids: RenderCuboid[] = [];
    const worldBoxes: WorldBox[] = [];
    const studCandidates: Array<{ brick: number; s: LdrawStud; R: Mat3; t: Vec3; material: LdrawEntityMaterial; bone: string; aligned: boolean }> = [];
    const bones = new Map<string, { pivot: Vec3; rotation?: [number, number, number]; parent?: string }>();
    bones.set('body', { pivot: [0, 0, 0] });
    // A wheel bone holds its parts ALIGNED, authored where they stand (like `body`); only the animation turns it.
    for (const [name, p] of wheelPivotsLdu) bones.set(name, { pivot: apply(A, p), parent: 'body' });
    for (const b of options.rig?.bones ?? []) {
      // A static bone rotation is given in the LDraw frame and goes to the
      // render frame the same way a rotated part's does (M = A R A^T).
      const rotation = b.rotation ? eulerZYX(mul(mul(A, b.rotation as Mat3), At)) : undefined;
      bones.set(b.name, { pivot: apply(A, b.pivotLdu), ...(rotation ? { rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) });
    }
    const aabbFallback = new Map<string, { count: number; reason: string }>();
    const perPart = new Map<string, { placements: number; cubesEach: number; microcellLdu: number }>();
    let rotatedBoneCount = 0;
    let unresolvedCount = 0;
    let defaultFaces = 0;
    let facePrinted = 0, faceArtCount = 0;
    /** Face decals (render frame), kept apart from `renderCuboids` so no carve, cull or merge touches them. */
    const faceDecalCuboids: RenderCuboid[] = [];
    /** `renderCuboids` index range each placement's body cuboids occupy (for the head carve). */
    const cuboidRange: Array<[number, number]> = [];

    placed.forEach((b, brickIndex) => {
      let faceDecal: TexturedHeadFace | null = null;
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
      let bone = wheelBoneOf.get(brickIndex) ?? rigBoneOf(brickIndex);
      if (!aligned) {
        // A rotated part under a rig bone is that bone's child, so it turns with it
        // (a vehicle's rotated parts hang under `body` too, so the body lean carries them).
        const parent = bone === 'body' && !options.rig && !vehicleRig ? undefined : bone;
        bone = `r${brickIndex}`;
        const [ea, eb, ec] = eulerZYX(M);
        bones.set(bone, { pivot: apply(A, t), rotation: [ea, eb, ec], ...(parent ? { parent } : {}) });
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
        const hollow = material.alpha < 1;
        const preserveSurface = surfaceOf(brickIndex);
        proto = cache.get(mesh, { ...quality, microcellLdu: grainOf(protoKey(mesh, hollow, preserveSurface)) }, { hollow, decomposition, preserveSurface });
        if (proto.source === 'aabb-fallback') {
          const entry = aabbFallback.get(proto.partId) ?? { count: 0, reason: `over ${quality.maxPartCubes} cuboids after coarsening` };
          entry.count++;
          aabbFallback.set(proto.partId, entry);
        }
        // A head's face: its print (or seeded face art) as a texture on one
        // decal cube; failing that, a plain head gets the default face in
        // cuboids, in an ink that reads on ITS skin.
        const face = faceTexturesOn && isHeadPart(b.part, mesh.description)
          // A rotated part's cuboids are authored unrotated in its own bone,
          // so its face looks out along A·(−Z); an aligned one along A·R·(−Z).
          ? texturedHeadFace(b.part, mesh, proto, aligned ? mul(A, R) : A, b.headPrint)
          : null;
        if (face) {
          proto = face.proto;
          faceDecal = face;
          if (face.source === 'printed') facePrinted++; else faceArtCount++;
        } else if (isPlainHead(b.part, mesh)) {
          const decals = faceDecals(proto, material);
          if (decals.length) { proto = { ...proto, cuboids: [...proto.cuboids, ...decals] }; defaultFaces++; }
        }
      }

      const pp = perPart.get(proto.partId) ?? { placements: 0, cubesEach: proto.cuboids.length, microcellLdu: proto.microcellLdu };
      pp.placements++;
      perPart.set(proto.partId, pp);
      cuboidRange[brickIndex] = [renderCuboids.length, renderCuboids.length + proto.cuboids.length];
      for (const c of proto.cuboids as PartCuboid[]) {
        const cubeMaterial = c.color === 16 && options.inheritMaterialId ? resolveLdrawEntityMaterial(16)
          : c.color === 16 ? material : resolveLdrawEntityMaterial(c.color);
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
      if (faceDecal) {
        // The decal goes through the same transform as the head's own cuboids.
        const { decal, oriented } = faceDecal;
        if (aligned) {
          const world = aabbOfCorners(cornersOf(decal.min, decal.max).map(v => { const r = apply(R, v); return [r[0] + t[0], r[1] + t[1], r[2] + t[2]] as Vec3; }));
          const rb = aabbOfCorners(cornersOf(world.min, world.max).map(v => apply(A, v)));
          faceDecalCuboids.push({ ...rb, material, bone, aligned: true, face: oriented });
        } else {
          const at = apply(A, t);
          const local = aabbOfCorners(cornersOf(decal.min, decal.max).map(v => apply(A, v)));
          faceDecalCuboids.push({
            min: [local.min[0] + at[0], local.min[1] + at[1], local.min[2] + at[2]],
            max: [local.max[0] + at[0], local.max[1] + at[1], local.max[2] + at[2]],
            material, bone, aligned: false, face: oriented,
          });
        }
      }
      for (const s of proto.studs) studCandidates.push({ brick: brickIndex, s, R, t, material, bone, aligned });
    });

    // Headwear carves the head: a head cell that shares space with its hair
    // is never visible, and where the two surfaces coincide the game draws
    // both and the skin shows through the hair as stripes. Aligned cuboids
    // only (a rotated hair rides its own child bone, whose cuboids are stored
    // unrotated); `worldBoxes` is rebuilt in step so the indices stay paired.
    let headCubesCarved = 0;
    const headIdx = placed.map((_, i) => i).filter(i => slotOf(i) === 'head' && cuboidRange[i]);
    const wearIdx = placed.map((_, i) => i).filter(i => slotOf(i) === 'headwear' && cuboidRange[i]);
    if (headIdx.length && wearIdx.length) {
      const cutters = wearIdx.flatMap(i => { const [s, e] = cuboidRange[i]!; return renderCuboids.slice(s, e).filter(c => c.aligned); });
      const carved: RenderCuboid[] = [], carvedWorld: WorldBox[] = [];
      const headRanges = headIdx.map(i => cuboidRange[i]!);
      renderCuboids.forEach((c, k) => {
        const range = headRanges.find(([s, e]) => k >= s && k < e);
        if (!range || !c.aligned) { carved.push(c); carvedWorld.push(worldBoxes[k]!); return; }
        let pieces: Array<{ min: Vec3; max: Vec3 }> = [{ min: c.min, max: c.max }];
        for (const cut of cutters) pieces = pieces.flatMap(p => subtractBox(p, cut));
        if (pieces.length === 1 && pieces[0] && pieces[0].min === c.min) { carved.push(c); carvedWorld.push(worldBoxes[k]!); return; }
        headCubesCarved++;
        for (const p of pieces) {
          carved.push({ ...c, min: p.min, max: p.max });
          carvedWorld.push({ ...aabbOfCorners(cornersOf(p.min, p.max).map(v => apply(At, v))), brick: worldBoxes[k]!.brick });
        }
      });
      renderCuboids.length = 0; renderCuboids.push(...carved);
      worldBoxes.length = 0; worldBoxes.push(...carvedWorld);
    }

    const heaviestParts = [...perPart].map(([part, v]) => ({ part, placements: v.placements, cubesEach: v.cubesEach, microcellLdu: v.microcellLdu, cubes: v.placements * v.cubesEach }))
      .sort((a, b) => b.cubes - a.cubes || a.part.localeCompare(b.part)).slice(0, 12);
    if (!cullAndMerge) {
      // The planning pass: only the world boxes and stud candidates are needed
      // (for the stud reserve), so the cull and the merge are skipped.
      const cullPlan: HiddenCullPlan = { hidden: new Set(), cellLdu: 0, requestedCellLdu: 0, gridCells: 0, coarsened: false, skipped: false };
      return { renderCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, unresolvedCount, hiddenCubesCulled: 0, cullPlan, mergedCubes: 0, heaviestParts, defaultFaces, headCubesCarved, faceDecalCuboids, facePrinted, faceArtCount };
    }

    // Buried cuboids cost budget and draw calls for nothing: cull them. The
    // occupancy is sampled in the render frame, where aligned boxes are exact;
    // a rotated bone's cuboid is stored unrotated at its pivot, so its render
    // AABB here is not its world box — it is tested with the world AABB instead.
    const forCull = renderCuboids.map((c, i) => c.aligned
      ? { min: c.min, max: c.max, translucent: c.material.alpha < 1, aligned: true }
      : { ...(() => { const wb = worldBoxes[i]!; return aabbOfCorners(cornersOf(wb.min, wb.max).map(v => apply(A, v))); })(), translucent: c.material.alpha < 1, aligned: false });
    // Over the 40 M-cell budget the cell is COARSENED (up to 12 LDU), not the
    // cull abandoned - see cullHiddenCuboidsWithinBudget.
    const cullPlan = cullHiddenCuboidsWithinBudget(forCull, Math.min(4, quality.microcellLdu));
    const hidden = cullPlan.hidden;
    const visibleCuboids = hidden.size ? renderCuboids.filter((_, i) => !hidden.has(i)) : renderCuboids;
    // Lossless: same-colour face-adjacent body boxes become one (see mergeAlignedCuboids).
    const mergedResult = mergeAlignedCuboids(visibleCuboids);

    return { renderCuboids: mergedResult.cuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, unresolvedCount, hiddenCubesCulled: hidden.size, cullPlan, mergedCubes: mergedResult.merged, heaviestParts, defaultFaces, headCubesCarved, faceDecalCuboids, facePrinted, faceArtCount };
  };

  // 5. Exposed studs: a stud whose top is inside another part's box is covered.
  interface ExposedStud { centre: Vec3; up: Vec3; radius: number; height: number; material: LdrawEntityMaterial; bone: string }
  const findExposedStuds = (worldBoxes: WorldBox[], studCandidates: Array<{ brick: number; s: LdrawStud; R: Mat3; t: Vec3; material: LdrawEntityMaterial; bone: string; aligned: boolean }>): ExposedStud[] => {
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
    const exposed: ExposedStud[] = [];
    for (const cand of studCandidates) {
      const { s, R, t, brick, material, bone, aligned } = cand;
      const centerW = apply(R, s.center);
      const upW = apply(R, s.up);
      const probe: Vec3 = [
        centerW[0] + t[0] + upW[0] * (s.height + 2), centerW[1] + t[1] + upW[1] * (s.height + 2), centerW[2] + t[2] + upW[2] * (s.height + 2),
      ];
      if (covered(probe, brick)) continue;
      // A wheel bone's parts are authored where they stand, exactly like `body`'s.
      if (bone === 'body' || (aligned && wheelPivotsLdu.has(bone))) {
        // Render frame: the stud's base centre and axis through the placement.
        exposed.push({ centre: apply(A, [centerW[0] + t[0], centerW[1] + t[1], centerW[2] + t[2]]), up: apply(A, upW), radius: s.radius, height: s.height, material, bone });
      } else {
        // Rotated bone: the cube is authored unrotated at the brick origin; the bone's rotation places it.
        const at = apply(A, t), c = apply(A, s.center);
        exposed.push({ centre: [c[0] + at[0], c[1] + at[1], c[2] + at[2]], up: apply(A, s.up), radius: s.radius, height: s.height, material, bone });
      }
    }
    return exposed;
  };

  // Whole-model budget, spent PER PART where it shows (planPartGrains): every
  // part starts at the requested grain and, while the model is over budget,
  // the part whose next coarser grain loses the least silhouette per cuboid
  // saved is coarsened - never the whole model at once.
  //
  // The studs' share of `maxModelCubes` is reserved before the body is
  // planned, from the exposed-stud count of a draft instantiation at the
  // requested grain. That count FALLS as parts coarsen (a stud seen through a
  // Technic hole is covered once the hole closes: 10303 exposes 2,616 studs at
  // 2 LDU and 1,280 after its balanced plan), so the reserve is re-measured on
  // the planned model and the body re-planned with what the studs gave back,
  // until the two agree within 1 % of the budget or the loop has run three
  // times. Every pass reuses the prototype cache; only the instancing repeats.
  const requestedFacets = Math.max(1, Math.round(quality.studFacets));
  const planParts = new Map<string, GrainPlanPart>();
  placed.forEach((b, i) => {
    const mesh = meshes.get(b.part);
    if (!mesh) return;
    const hollow = resolveLdrawEntityMaterial(b.color).alpha < 1;
    const preserveSurface = surfaceOf(i);
    const key = protoKey(mesh, hollow, preserveSurface);
    const entry = planParts.get(key);
    if (entry) entry.placements++; else planParts.set(key, { key, mesh, placements: 1, hollow, preserveSurface });
  });
  const studReserveOf = (r: ReturnType<typeof instantiate>): number => Math.min(quality.maxStudCubes, findExposedStuds(r.worldBoxes, r.studCandidates).length * requestedFacets);
  const draft = instantiate(() => quality.microcellLdu, false);
  let studReserve = studReserveOf(draft);
  let plan = planPartGrains([...planParts.values()], quality, cache, { decomposition, budget: Math.max(0, quality.maxModelCubes - studReserve), fixedCuboids: draft.unresolvedCount });
  let built = instantiate(key => plan.grains.get(key) ?? quality.microcellLdu, true);
  for (let pass = 1; pass < 3 && plan.summary.partsCoarsened; pass++) {
    const measured = studReserveOf(built);
    if (studReserve - measured <= quality.maxModelCubes * 0.01) break;
    studReserve = measured;
    plan = planPartGrains([...planParts.values()], quality, cache, { decomposition, budget: Math.max(0, quality.maxModelCubes - studReserve), fixedCuboids: draft.unresolvedCount });
    built = instantiate(key => plan.grains.get(key) ?? quality.microcellLdu, true);
  }
  const grainPlan = plan.summary;
  if (!grainPlan.fits) {
    warnings.push(`${cid}: ${built.renderCuboids.length} cuboids exceed the ${quality.maxModelCubes} budget even with every part at ${grainPlan.coarsestMicrocellLdu} LDU; the pack keeps them all, expect a heavy entity.`);
  } else if (grainPlan.partsCoarsened) {
    warnings.push(`${cid}: ${grainPlan.placementsCoarsened} placement${grainPlan.placementsCoarsened === 1 ? '' : 's'} of ${grainPlan.partsCoarsened} part${grainPlan.partsCoarsened === 1 ? '' : 's'} compiled coarser than ${grainPlan.requestedMicrocellLdu} LDU to fit the ${quality.maxModelCubes}-cuboid budget (silhouette fidelity ${grainPlan.fidelity} against ${grainPlan.fidelityAtRequested} at full grain); the other ${grainPlan.placementsAtGrain[grainPlan.requestedMicrocellLdu] ?? 0} keep ${grainPlan.requestedMicrocellLdu} LDU.`);
  }
  const { renderCuboids, worldBoxes, studCandidates, bones, aabbFallback, rotatedBoneCount, hiddenCubesCulled, cullPlan, mergedCubes, heaviestParts, defaultFaces, headCubesCarved, faceDecalCuboids, facePrinted, faceArtCount } = built;
  if (cullPlan.skipped) {
    warnings.push(`${cid}: buried-cuboid culling was skipped - the model spans ${Math.round(Math.cbrt(cullPlan.gridCells))} cells a side even at ${cullPlan.cellLdu} LDU, over the ${CULL_GRID_CELL_BUDGET / 1_000_000} M-cell occupancy budget; a few hundred never-visible cuboids ship with it.`);
  }
  let studCubeCount = 0, studsOmitted = 0;
  const exposedStuds = findExposedStuds(worldBoxes, studCandidates);
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
      // Square peg: the cylinder's AABB. It used to take the atlas's stud-top
      // tile on its up face; under box UV a cube carries one flat colour, so
      // the disc is gone and `studTopTilesDropped` reports it.
      return [{ ...box(st.radius, st.radius), material: st.material, bone: st.bone, studTop: true }];
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
  // A rigged figure stands on its FEET: its actor is placed at the source
  // figure's feet (bedrock-scene-actors `floorLdu`), so the geometry's y = 0
  // must be the lowest cube of its body, not of what it holds. A broom, wand
  // or tool a figure is grouped with can hang below its soles (76457: nine of
  // twelve figures carried an item 2.7 units under their feet), and taking the
  // floor from it stood the whole figure that far above every floor.
  const heldBone = (name: string): boolean => {
    for (let b: string | undefined = name, guard = 0; b && guard < 32; b = bones.get(b)?.parent, guard++) if (b === 'hand_right' || b === 'hand_left') return true;
    return false;
  };
  const bodyCubes = options.rig ? renderCuboids.filter(c => !heldBone(c.bone)) : [];
  const floorOf = bodyCubes.length ? Math.min(...bodyCubes.map(c => c.min[1])) : all.min[1];
  const automaticOrigin: Vec3 = [(all.min[0] + all.max[0]) / 2, floorOf, (all.min[2] + all.max[2]) / 2];
  const [midX, floorY, midZ] = options.originLdu ? apply(A, options.originLdu) : automaticOrigin;
  const totalWidth = (all.max[0] - all.min[0]) * scale / 16;
  const totalHeight = (all.max[1] - all.min[1]) * scale / 16;
  // An entity is lit by the block at its own position. A building shell's
  // floor centre sits inside its collider volume (light 0: three of four
  // shells rendered near-black at noon on the Pixel, round 4), so the shell's
  // origin is put one block ABOVE its roof, in open sky, and the geometry is
  // authored that many blocks lower. The actor spawns `originLiftBlocks` up.
  const originLiftBlocks = options.originAboveModel ? Math.ceil(totalHeight) + 1 : 0;
  const toUnits = (v: Vec3): Vec3 => [(v[0] - midX) * scale, (v[1] - floorY) * scale - originLiftBlocks * 16, (v[2] - midZ) * scale];
  const totalLength = (all.max[2] - all.min[2]) * scale / 16;
  // The vehicle rig's root turns about the floor centre (a car leans and
  // squats on its wheels), an aircraft's about its mid-height (it banks
  // through its own middle). Bone pivots are absolute, so moving the root's
  // pivot moves nothing until an animation turns it.
  if (vehicleRig) bones.get('body')!.pivot = [midX, floorY + (kind === 'plane' ? (all.max[1] - all.min[1]) / 2 : 0), midZ];
  const wheelBones: VehicleWheelBone[] = wheelPlan.map(w => {
    const p = toUnits(apply(A, w.centre));
    // Front or rear half: along the nose axis, relative to the wheels' own middle.
    const ax = facing.axis === 'x' ? 0 : 2;
    const mid = wheelPlan.reduce((s, o) => s + o.centre[ax]!, 0) / Math.max(1, wheelPlan.length);
    return { name: w.name, radiusBlocks: round(w.radiusLdu * scale / 16), parts: w.parts, pivot: [round(-p[0]), round(p[1]), round(p[2])] as [number, number, number], end: ((w.centre[ax]! - mid) * facing.sign >= 0 ? 1 : -1) as 1 | -1 };
  });

  // 7. Seat + collision. The cockpit's EYE point (LDraw) goes through the same
  //    frame; the rider's origin sits SEATED_EYE_HEIGHT_BLOCKS below it.
  const cockpitUnits = toUnits(apply(A, cockpit.eyeLdu));
  const seatX = Math.abs(cockpitUnits[0] / 16) < 0.3 ? 0 : round(cockpitUnits[0] / 16);
  const seatY = Math.max(0.3, round(cockpitUnits[1] / 16 - SEATED_EYE_HEIGHT_BLOCKS));
  // A canopy or default cabin is a volume, not a seat: set the rider back a little so the eyes sit inside the glass.
  const seatZ = round(cockpitUnits[2] / 16 + (cockpit.source === 'seated-figure' || cockpit.source === 'seat-parts' || cockpit.source === 'steering-wheel' ? 0 : 0.35));
  // Passenger seats measured from the model's free seat moulds, in the same frame as the driver's.
  const passengerSeats: Array<[number, number, number]> = cockpit.passengerEyesLdu.slice(0, 3).map(eye => {
    const u = toUnits(apply(A, eye));
    return [round(u[0] / 16), Math.max(0.3, round(u[1] / 16 - SEATED_EYE_HEIGHT_BLOCKS)), round(u[2] / 16)];
  });
  const collisionBox = {
    width: Math.min(3.5, Math.max(0.8, Math.round(totalWidth * 0.85 * 10) / 10)),
    height: Math.min(2.5, Math.max(0.8, Math.round(totalHeight * 0.8 * 10) / 10)),
  };

  // 8. Palettes (opaque / translucent by material alpha) and JSON cubes.
  //
  // Cubes carry BOX UV - one origin into a texture that is a single flat
  // colour - so a geometry can hold exactly ONE material, and the cubes are
  // grouped by colour here. See `ldraw-entity-atlas.ts` for the Pixel 8 Pro
  // A/B that bought the form: 1.05 kB less per cuboid, 34 % of the 3.08 kB a
  // cuboid costs in add-on memory.
  const opaque: LdrawEntityMaterial[] = [], translucent: LdrawEntityMaterial[] = [];
  const indexOf = (list: LdrawEntityMaterial[], m: LdrawEntityMaterial): number => {
    let i = list.findIndex(x => x.colorId === m.colorId);
    if (i < 0) { i = list.length; list.push(m); }
    return i;
  };

  /** Every cube of one LDraw colour: the unit a geometry (and its swatch) is cut from. */
  interface MaterialGroup { material: LdrawEntityMaterial; translucent: boolean; items: Array<{ bone: string; cube: BedrockCube }> }
  const groups = new Map<number, MaterialGroup>();
  /** Square-peg studs whose stud-top tile box UV cannot address (`studFacets` 1). */
  let studTopTilesDropped = 0;
  let translucentCubeCount = 0;
  for (const c of renderCuboids) {
    const isT = c.material.alpha < 1;
    if (isT) translucentCubeCount++;
    indexOf(isT ? translucent : opaque, c.material);
    if (c.studTop) studTopTilesDropped++;
    const lo = toUnits(c.min), hi = toUnits(c.max);
    const cube: BedrockCube = {
      // Bedrock's entity frame is mirrored in X relative to the render frame.
      origin: [round(-hi[0]), round(lo[1]), round(lo[2])],
      size: [round(hi[0] - lo[0]), round(hi[1] - lo[1]), round(hi[2] - lo[2])],
      // The swatch is uniform, so the size-scaled cross this walks lands on the
      // same colour at every cube size, mip level and wrap mode.
      uv: [0, 0],
    };
    if (c.rotation && c.pivot) {
      const p = toUnits(c.pivot);
      cube.pivot = [round(-p[0]), round(p[1]), round(p[2])];
      cube.rotation = [round(-c.rotation[0]), round(-c.rotation[1]), round(c.rotation[2])];
    }
    let group = groups.get(c.material.colorId);
    if (!group) { group = { material: c.material, translucent: isT, items: [] }; groups.set(c.material.colorId, group); }
    // A cuboid carries ONE material for all six faces (the six-face UVs it used
    // to emit were the same tile six times), so a colour id must resolve to one
    // appearance everywhere. If it ever did not, the swatch would silently
    // repaint part of the model - refuse instead of picking one.
    else if (group.material.rgb.join() !== c.material.rgb.join() || group.material.alpha !== c.material.alpha) {
      throw new Error(`${cid}: LDraw colour ${c.material.colorId} resolved to two appearances (${group.material.rgb.join()} @${group.material.alpha} vs ${c.material.rgb.join()} @${c.material.alpha}); a box-UV geometry can carry only one.`);
    }
    group.items.push({ bone: c.bone, cube });
  }
  if (!opaque.length) opaque.push(resolveLdrawEntityMaterial(7));
  if (studTopTilesDropped) {
    warnings.push(`${cid}: ${studTopTilesDropped} square-peg stud${studTopTilesDropped === 1 ? '' : 's'} lost the stud-top highlight - a box-UV cube carries one flat colour, and at studFacets 1 there is no fanned facet to read as round.`);
  }

  const jsonBone = (name: string): BedrockBone => {
    const b = bones.get(name)!;
    const p = toUnits(b.pivot);
    return {
      name,
      ...(b.parent ? { parent: b.parent } : {}),
      pivot: [round(-p[0]), round(p[1]), round(p[2])],
      ...(b.rotation ? { rotation: [round(-b.rotation[0]), round(-b.rotation[1]), round(b.rotation[2])] as [number, number, number] } : {}),
      cubes: [],
    };
  };

  // Culling box, shared by every mesh of this model. The recentring above puts
  // the cubes symmetrically about the entity position in X/Z and lifts them by
  // `originLiftBlocks`, so the render-frame AABB in blocks is exactly this. A
  // rotated bone's cuboids are authored unrotated at the pivot, so their true
  // extent can exceed that AABB by up to a cuboid diagonal; two blocks of
  // padding covers every LEGO part at 0.16 units/LDU.
  //
  // Every mesh chunk declares the WHOLE model's box on purpose: a chunk holds
  // an arbitrary slice of the cube list, so its cubes can sit anywhere in the
  // model, and chunks culled independently would tear a set apart. The helper
  // widens the box to the largest wand size step - see
  // `visibleBoundsForSizeSteps`. (A "vanishes from above" report on the Pixel
  // was the tester falling back to the ground after an elevated /tp - not
  // culling.)
  const modelExtent = {
    min: [-totalWidth / 2, -originLiftBlocks, -totalLength / 2] as const,
    max: [totalWidth / 2, totalHeight - originLiftBlocks, totalLength / 2] as const,
  };
  const cullingBounds = visibleBoundsForSizeSteps(modelExtent, 2);
  const description = (identifier: string) => ({
    identifier,
    // The geometry's texture is one flat colour end to end, so these only set
    // how many texels a box-UV cross walks before it wraps - never which
    // colour a face lands on.
    texture_width: SWATCH_SIZE,
    texture_height: SWATCH_SIZE,
    ...cullingBounds,
  });

  const geometryMeshes: unknown[] = [];
  const emittedMeshes: CompiledMesh[] = [];
  const chunk = quality.meshChunkCubes;
  const groupByBone = (items: Array<{ bone: string; cube: BedrockCube }>): BedrockBone[] => {
    const byBone = new Map<string, BedrockBone>();
    // A bone's parent chain must exist in the same geometry (empty bones are fine).
    const ensure = (name: string): BedrockBone => {
      let bone = byBone.get(name);
      if (!bone) {
        bone = jsonBone(name);
        byBone.set(name, bone);
        const parent = bones.get(name)?.parent;
        if (parent) ensure(parent);
      }
      return bone;
    };
    for (const item of items) ensure(item.bone).cubes.push(item.cube);
    // Parents before children, the order Bedrock's loader expects.
    const order = new Map<string, number>();
    const depth = (name: string): number => { const p = bones.get(name)?.parent; return p ? depth(p) + 1 : 0; };
    for (const name of byBone.keys()) order.set(name, depth(name));
    return [...byBone.values()].sort((a, b) => order.get(a.name)! - order.get(b.name)!);
  };
  // Opaque colours first, then the translucent ones: alpha-blended geometry
  // draws last, exactly as it did when there was one canopy mesh.
  const ordered = [...groups.values()].sort((a, b) => Number(a.translucent) - Number(b.translucent));
  // Two parts the source sinks into each other, or lays flush on the same
  // plane, leave faces of different colours on ONE plane; the device cannot
  // order them and draws the hatching and strobing a user reported on every
  // model (2026-09-25: 76417's shell 10,672 such pairs, 80 block faces).
  // Push each pair's winning face out, in the JSON cubes themselves (their
  // origin/size arrays are shared with the wrappers below).
  const coplanarEntry: GeoEntryLike = {
    groups: ordered.map(g => ({
      ldrawColor: g.material.colorId, alpha: g.material.alpha,
      cubes: g.items.map(it => ({ bone: it.bone, origin: it.cube.origin, size: it.cube.size, ...(it.cube.rotation && it.cube.pivot ? { rotation: it.cube.rotation, pivot: it.cube.pivot } : {}) })),
    })),
    bones: [...bones.keys()].map(name => { const b = jsonBone(name); return { name: b.name, pivot: b.pivot, ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) }; }),
  };
  // The face decals (emitted below) are never moved, but a fringe or visor on
  // their plane must be pushed in front of them, so they take part as a group.
  if (faceDecalCuboids.length) {
    coplanarEntry.groups.push({
      ldrawColor: null, alpha: 1, texture: { path: 'faces' },
      cubes: faceDecalCuboids.map(d => {
        const lo = toUnits(d.min), hi = toUnits(d.max);
        return {
          bone: d.bone, origin: [round(-hi[0]), round(lo[1]), round(lo[2])], size: [round(hi[0] - lo[0]), round(hi[1] - lo[1]), round(hi[2] - lo[2])],
          faceUv: { face: d.face!.face, uv: [0, 0], size: [1, 1] },
        };
      }),
    });
  }
  const coplanar = separateCoplanarFaces(coplanarEntry);
  if (coplanar.pairsLeft) warnings.push(`${cid}: ${coplanar.pairsLeft} different-colour face pair${coplanar.pairsLeft === 1 ? '' : 's'} still share a plane after separation (may hatch on the device).`);
  for (const group of ordered) {
    for (let offset = 0; offset < group.items.length; offset += chunk) {
      const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_${emittedMeshes.length}`;
      emittedMeshes.push({ id: meshId, material: group.material, translucent: group.translucent });
      geometryMeshes.push({ description: description(meshId), bones: groupByBone(group.items.slice(offset, offset + chunk)) });
    }
  }
  // Faces: one geometry whose decal cubes each draw ONE face from an atlas of
  // this entity's face prints (per-face UV; every other face of a decal is
  // not drawn), alpha-tested so only the ink shows over the head's cuboids.
  let faceAtlasSize: [number, number] = [0, 0];
  if (faceDecalCuboids.length) {
    const atlas = packFaceAtlas(faceDecalCuboids.map(d => d.face!));
    faceAtlasSize = [atlas.width, atlas.height];
    const items = faceDecalCuboids.map((d, k) => {
      const lo = toUnits(d.min), hi = toUnits(d.max);
      const f = d.face!;
      const cube: BedrockCube = {
        origin: [round(-hi[0]), round(lo[1]), round(lo[2])],
        size: [round(hi[0] - lo[0]), round(hi[1] - lo[1]), round(hi[2] - lo[2])],
        uv: { [f.face]: { uv: [atlas.at[k]![0], atlas.at[k]![1]], uv_size: [f.width, f.height] } },
      };
      return { bone: d.bone, cube };
    });
    const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_${emittedMeshes.length}`;
    emittedMeshes.push({
      id: meshId, material: resolveLdrawEntityMaterial(16), translucent: false,
      faceAtlas: { png: encodePngRgba(atlas.width, atlas.height, atlas.rgba), width: atlas.width, height: atlas.height },
    });
    geometryMeshes.push({
      description: { ...description(meshId), texture_width: atlas.width, texture_height: atlas.height },
      bones: groupByBone(items),
    });
  }
  if (!emittedMeshes.length) {
    const meshId = `geometry.${PACK_NAMESPACE}.${cid}_mesh_0`;
    emittedMeshes.push({ id: meshId, material: opaque[0]!, translucent: false });
    geometryMeshes.push({ description: description(meshId), bones: [jsonBone('body')] });
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
    ...(figureQualityClamped ? { figureQualityClamped } : {}),
    cubeCount: renderCuboids.length,
    opaqueCubeCount: renderCuboids.length - translucentCubeCount,
    translucentCubeCount,
    studCubeCount,
    studTopTilesDropped,
    studsOmitted,
    rotatedBoneCount,
    meshCount: geometryMeshes.length,
    aabbFallbackParts,
    printFallbackParts: report.printFallbacks.map(f => f.part),
    skippedInternalCount,
    modelCoarsened: grainPlan.partsCoarsened,
    cubesAtRequestedDetail: grainPlan.cuboidsAtRequested,
    grainPlan,
    quality,
    pbr: options.pbr ?? false,
    substitutedParts: report.substitutions,
    studFacets,
    cockpit: { source: cockpit.source, units: [round(cockpitUnits[0]), round(cockpitUnits[1]), round(cockpitUnits[2])], detail: cockpit.detail },
    driverFigureRemoved,
    extras: extras.map(e => ({ role: e.role, placements: e.sourceIndices.length, reason: e.reason })),
    leveled: level.rotation ? { angleDeg: round(level.angleDeg), alignedBefore: level.alignedBefore, alignedAfter: level.alignedAfter } : null,
    detached,
    displayDropped,
    strandedRepaired,
    standContinued,
    orphans,
    hiddenCubesCulled,
    defaultFaces,
    ...(faceDecalCuboids.length ? { faceTextures: { printed: facePrinted, art: faceArtCount, atlas: faceAtlasSize } } : {}),
    headCubesCarved,
    hiddenCull: { cellLdu: cullPlan.cellLdu, requestedCellLdu: cullPlan.requestedCellLdu, gridCells: cullPlan.gridCells, coarsened: cullPlan.coarsened, skipped: cullPlan.skipped },
    mergedCubes,
    coplanar,
    heaviestParts,
    facing,
    ...(vehicleRig ? { wheels: { placements: wheelPlacements, bones: wheelBones.map(w => ({ name: w.name, radiusBlocks: w.radiusBlocks, parts: w.parts, end: w.end })), rejected: wheelsRejected } } : {}),
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
    meshes: emittedMeshes,
    meshIds: emittedMeshes.map(m => m.id),
    seatPosition: [seatX, seatY, seatZ],
    passengerSeats,
    collisionBox,
    sizeBlocks: { width: round(totalWidth), height: round(totalHeight), length: round(totalLength) },
    facing: nose,
    keptSourceIndices: placedIdx,
    extras,
    originLdu: apply(At, [midX, floorY, midZ]),
    originLiftBlocks,
    levelPose: level.rotation ? { rotation: [...level.rotation], centre: [...level.centre] as Vec3 } : null,
    ...(options.wholeModel ? { partBoxesLdu: worldBoxes.map(wb => ({ min: wb.min, max: wb.max })) } : {}),
    ...(vehicleRig ? { wheelBones } : {}),
    diagnostics,
    warnings,
  };
}



