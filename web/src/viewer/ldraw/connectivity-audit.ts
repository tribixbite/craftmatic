/**
 * Contact-candidate audit for a loaded LDraw model.
 *
 * WHAT THIS IS: a heuristic that finds pieces with **no detected attachment** to
 * the main build. It is NOT a certificate of mechanically correct assembly, and
 * a single connected component does not prove one (audit item P1 #5,
 * docs/lego-3d-generation-audit-2026-09-08.md). Every number it returns is a
 * candidate list for a human to look at.
 *
 * Two independent evidence sources are FUSED (the hybrid the snap engine's own
 * conclusion called for — see scripts/ldcad_connectivity.py):
 *
 *  A. SURFACE CONTACT (primary, covers every part)
 *     1. Voxelize each UNIQUE part's triangle surface once, in part-local LDU
 *        space, at resolution R (deduped to one sample per local voxel).
 *     2. Transform those points by each placement's world rotation+translation
 *        and snap to a global R-voxel grid.
 *     3. Union pieces that share a voxel OR occupy face-adjacent voxels.
 *
 *  B. ATTACHMENT METADATA (supplement, partial coverage)
 *     LDCad connection points for the joints (A) is blind to — clips on bars,
 *     pins in holes, hair on a minifig head — resolved offline into
 *     `attachment-snaps.ts`. A compatible male/female (or clip/bar) pair that
 *     coincides in world space unions the two pieces even when no surface
 *     voxel touches.
 *
 * KNOWN LIMITS, all reported in the returned report rather than hidden:
 *  • TOLERANCE: face adjacency at R = 4 LDU means surfaces up to ~4 LDU (0.2
 *    stud) apart are joined. A real but small designed gap therefore reads as
 *    contact — this over-connects, so a "one component" result is the weaker
 *    claim, not the stronger one.
 *  • COVERAGE: (B) covers only the parts in the table (`piecesWithSnaps` says
 *    how many of THIS model's pieces it reached). Everything else relies on (A)
 *    alone and can still show a clip/pin joint as detached.
 *  • MISSING GEOMETRY: a piece whose `.dat` never resolved has no surface at
 *    all. It cannot touch anything and nothing can touch it, so it is reported
 *    separately (`piecesWithoutGeometry`) — counting it as "detached" would be
 *    a claim about a model we never loaded.
 *  • SNAP_GEN connectors are ignored: matching them needs LDCad group ids the
 *    table does not carry, and a groupless match would invent unions.
 *
 * Measured behaviour on the settled reference sets: 21063 (traditional
 * stud-stacking) → one component, 100 %; 71043 (microscale/SNOT) under-reports
 * and its "detached" pieces are visibly embedded in the build.
 */

import { getCachedPartGeom, normId } from './parts';
import {
  ATTACHMENT_SNAPS, SNAP_TABLE_PARTS, SNAP_TABLE_CONNECTORS, type SnapPoint,
} from './attachment-snaps';
import type { ParsedBrick } from '../../engine/ldraw-parser';
import type { Triangle } from './types';

/**
 * One group of pieces with no detected attachment to the main build.
 *
 * `kind` separates the two very different meanings of "detached", using the
 * SAME calibrated rules geograde applies offline (clego GEOGRADE.md):
 *  • 'grounded' — the group rests on, or within 12 LDU of, something below it
 *    (or stands on the model's own floor plane). Deliberately separate
 *    sub-builds live here: posed minifigures, loose accessories, display
 *    stands, a second model in a multi-model set. Usually NOT a defect.
 *  • 'airborne' — nothing supports it within 12 LDU and it sits more than 48
 *    LDU above the floor. This is the suspicious class.
 *
 * It is a HEURISTIC about the geometry, not about intent: a minifigure standing
 * on an upper floor whose support is a piece the audit could not resolve reads
 * as airborne, and a floating piece that happens to hover just above a wall
 * reads as grounded.
 */
export interface DetachedComponent {
  size: number;
  /** A representative part id (the first piece in the group). */
  part: string;
  /** That piece's world position, rounded, in LDU. */
  pos: [number, number, number];
  kind: 'grounded' | 'airborne';
  /** Vertical distance to the nearest thing beneath, LDU. Infinity = nothing. */
  supportGapLDU: number;
  /** How far the group's lowest surface sits above the model's floor, LDU. */
  heightAboveFloorLDU: number;
}

export interface ConnectivityReport {
  pieces: number;
  components: number;
  largest: number;
  largestPct: number;
  detached: number;
  /** The largest detached groups (candidates to eyeball), worst first. */
  detachedComponents: DetachedComponent[];
  /** Voxel edge length used for the surface test, LDU. */
  resolutionLDU: number;
  /** Contact tolerance: surfaces this far apart still count as touching, LDU. */
  toleranceLDU: number;
  /** Pieces whose part geometry never resolved — no verdict is possible. */
  piecesWithoutGeometry: number;
  /**
   * How many of the DETACHED pieces are geometry-less. They are unavoidably
   * detached (a piece with no surface cannot touch anything), so subtracting
   * this is what turns `detached` into a number that means something.
   */
  detachedWithoutGeometry: number;
  /** Pieces the attachment-metadata table covered. */
  piecesWithSnaps: number;
  /** Unions found ONLY by attachment metadata (surface contact missed them). */
  snapOnlyUnions: number;
  /** Provenance of the attachment table, for the status line + diagnostics. */
  snapTable: { parts: number; connectors: number };
  /** Detached groups that rest on something (likely deliberate sub-builds). */
  groundedDetached: number;
  /** Detached groups hanging in mid-air (the suspicious class). */
  airborneDetached: number;
  /** Parallel to the input bricks: true if that piece is NOT in the main component. */
  isDetached: boolean[];
}

const vkey = (x: number, y: number, z: number) => `${x},${y},${z}`;

/**
 * Per-part cache of local surface sample points (deduped to one per local
 * voxel). Flattened [x0,y0,z0, x1,y1,z1, ...] in part-local LDU.
 */
const partPointCache = new Map<string, Float32Array>();

function partLocalPoints(partId: string, R: number): Float32Array {
  const key = `${partId}@${R}`;
  const hit = partPointCache.get(key);
  if (hit) return hit;

  const geom = getCachedPartGeom(partId);
  const seen = new Set<string>();
  const pts: number[] = [];
  // Dedup at a grid FINER than the world voxel (R/2) and store the ACTUAL
  // sample coordinate (not the voxel centre) so a piece's surface points stay
  // on the real surface. Snapping to local centres here would displace points
  // up to ~R/2 and, once rotated, push touching surfaces into non-adjacent
  // world voxels — producing false "detached" pieces on angled/SNOT parts.
  const LR = R * 0.5;

  const addTris = (tris: readonly Triangle[]) => {
    for (const [a, b, c] of tris) {
      const e1 = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const e2 = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
      const e3 = Math.hypot(b[0] - c[0], b[1] - c[1], b[2] - c[2]);
      // ~2.5 samples per dedup cell along the longest edge; capped so a giant
      // baseplate face doesn't explode the sample count.
      let n = Math.max(1, Math.ceil(Math.max(e1, e2, e3) / (LR * 0.4)));
      if (n > 300) n = 300;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n - i; j++) {
          const u = i / n, v = j / n, w = 1 - u - v;
          const x = u * a[0] + v * b[0] + w * c[0];
          const y = u * a[1] + v * b[1] + w * c[1];
          const z = u * a[2] + v * b[2] + w * c[2];
          const k = vkey(Math.floor(x / LR), Math.floor(y / LR), Math.floor(z / LR));
          if (!seen.has(k)) {
            seen.add(k);
            pts.push(x, y, z);
          }
        }
      }
    }
  };

  if (geom) {
    addTris(geom.tris);
    for (const ct of geom.colorTris.values()) addTris(ct);
  }
  const arr = new Float32Array(pts);
  partPointCache.set(key, arr);
  return arr;
}

// ─── Attachment metadata (evidence source B) ─────────────────────────────────

const NO_SNAPS: readonly SnapPoint[] = [];
const snapCache = new Map<string, readonly SnapPoint[]>();

/**
 * Attachment points for a part id, falling back to its base mould.
 *
 * Printed/decorated variants share their base part's connectors, and the table
 * generator drops any variant whose snaps are identical to the base — so
 * `3626bpb01` must resolve through `3626b` and then `3626`. Mirrors
 * `base_candidates()` in scripts/ldcad_connectivity.py.
 */
export function snapsForPart(partId: string): readonly SnapPoint[] {
  const key = partId.toLowerCase();
  const hit = snapCache.get(key);
  if (hit) return hit;
  let out: readonly SnapPoint[] = NO_SNAPS;
  for (const cand of snapNameCandidates(key)) {
    const t = ATTACHMENT_SNAPS[cand];
    if (t) { out = t; break; }
  }
  snapCache.set(key, out);
  return out;
}

function snapNameCandidates(id: string): string[] {
  const bare = id.replace(/\.dat$/, '');
  const out = [bare];
  const stripped = bare.startsWith('bl_') ? bare.slice(3) : bare;
  if (stripped !== bare) out.push(stripped);
  const m = /^(\d+)([a-z])?/.exec(stripped);
  if (m) {
    if (m[2]) out.push(m[1]! + m[2]);
    out.push(m[1]!);
  }
  return [...new Set(out)];
}

/** Thresholds inherited from the validated snap engine (ldcad_connectivity.py). */
const SNAP_CELL = 20;        // spatial-hash cell, LDU
const SNAP_TOL = 8;          // coincidence tolerance, LDU
const SNAP_PARALLEL = 0.95;  // |cos| between connector axes
const SNAP_RADIUS_TOL = 1.5; // male/female nominal radius slack, LDU
/**
 * A clip grips a MALE cylinder no fatter than a technic axle. The reference
 * engine matched a clip against any cylinder of any gender; that is tightened
 * here because a false union HIDES a real floater, which is the failure
 * direction that matters for this report.
 */
const CLIP_MAX_RADIUS = 6.5;

interface WorldSnap {
  piece: number;
  x: number; y: number; z: number;
  ax: number; ay: number; az: number;
  k: SnapPoint['k']; g: SnapPoint['g']; r: number;
}

function parallelAxes(a: WorldSnap, b: WorldSnap): boolean {
  return Math.abs(a.ax * b.ax + a.ay * b.ay + a.az * b.az) > SNAP_PARALLEL;
}

function snapsCompatible(a: WorldSnap, b: WorldSnap): boolean {
  if (a.k === 'gen' || b.k === 'gen') return false;  // needs group ids we don't carry
  if (a.k === 'cyl' && b.k === 'cyl') {
    return a.g !== b.g && a.g !== 'X' && b.g !== 'X'
      && Math.abs(a.r - b.r) <= SNAP_RADIUS_TOL && parallelAxes(a, b);
  }
  if (a.k === 'clp' && b.k === 'clp') return parallelAxes(a, b);
  if (a.k === 'fgr' && b.k === 'fgr') return parallelAxes(a, b);
  if ((a.k === 'clp' && b.k === 'cyl') || (a.k === 'cyl' && b.k === 'clp')) {
    const cyl = a.k === 'cyl' ? a : b;
    return cyl.g === 'M' && cyl.r <= CLIP_MAX_RADIUS && parallelAxes(a, b);
  }
  return false;
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function auditConnectivity(bricks: ParsedBrick[], R = 4): ConnectivityReport {
  const N = bricks.length;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;
  const find = (a: number): number => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // world voxel key -> one representative piece index (enough for union).
  const voxRep = new Map<string, number>();
  // remember each piece's occupied voxel keys for the adjacency pass.
  const pieceVoxels: string[][] = new Array(N);
  let piecesWithoutGeometry = 0;
  let piecesWithSnaps = 0;
  const worldSnaps: WorldSnap[] = [];

  for (let i = 0; i < N; i++) {
    const br = bricks[i]!;
    const id = normId(br.part);
    const pts = partLocalPoints(id, R);
    if (pts.length === 0) piecesWithoutGeometry++;
    const r = br.rot ?? IDENTITY;
    const tx = br.x, ty = br.y, tz = br.z;
    const mine: string[] = [];
    const local = new Set<string>();
    for (let p = 0; p < pts.length; p += 3) {
      const lx = pts[p]!, ly = pts[p + 1]!, lz = pts[p + 2]!;
      const wx = r[0]! * lx + r[1]! * ly + r[2]! * lz + tx;
      const wy = r[3]! * lx + r[4]! * ly + r[5]! * lz + ty;
      const wz = r[6]! * lx + r[7]! * ly + r[8]! * lz + tz;
      const k = vkey(Math.round(wx / R), Math.round(wy / R), Math.round(wz / R));
      if (local.has(k)) continue;
      local.add(k);
      mine.push(k);
      const rep = voxRep.get(k);
      if (rep === undefined) voxRep.set(k, i);
      else union(i, rep);
    }
    pieceVoxels[i] = mine;

    // Evidence source B: place this piece's attachment points in world space.
    const snaps = snapsForPart(id);
    if (snaps.length > 0) {
      piecesWithSnaps++;
      for (const s of snaps) {
        const [lx, ly, lz] = s.p;
        const [axl, ayl, azl] = s.a;
        worldSnaps.push({
          piece: i,
          x: r[0]! * lx + r[1]! * ly + r[2]! * lz + tx,
          y: r[3]! * lx + r[4]! * ly + r[5]! * lz + ty,
          z: r[6]! * lx + r[7]! * ly + r[8]! * lz + tz,
          ax: r[0]! * axl + r[1]! * ayl + r[2]! * azl,
          ay: r[3]! * axl + r[4]! * ayl + r[5]! * azl,
          az: r[6]! * axl + r[7]! * ayl + r[8]! * azl,
          k: s.k, g: s.g, r: s.r,
        });
      }
    }
  }

  // Adjacency pass: union pieces in face-adjacent voxels (≈ one-voxel gap).
  const neigh = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0; i < N; i++) {
    for (const k of pieceVoxels[i]!) {
      const c = k.split(',');
      const x = +c[0]!, y = +c[1]!, z = +c[2]!;
      for (const [dx, dy, dz] of neigh) {
        const rep = voxRep.get(vkey(x + dx!, y + dy!, z + dz!));
        if (rep !== undefined && find(rep) !== find(i)) union(i, rep);
      }
    }
  }

  // Attachment pass: union pieces whose compatible connectors coincide. Counted
  // separately so the report can say what the surface test alone would have
  // missed instead of silently taking credit for it.
  let snapOnlyUnions = 0;
  if (worldSnaps.length > 1) {
    const buckets = new Map<string, number[]>();
    for (let s = 0; s < worldSnaps.length; s++) {
      const w = worldSnaps[s]!;
      const k = vkey(Math.round(w.x / SNAP_CELL), Math.round(w.y / SNAP_CELL),
                     Math.round(w.z / SNAP_CELL));
      let arr = buckets.get(k);
      if (!arr) { arr = []; buckets.set(k, arr); }
      arr.push(s);
    }
    const tol2 = SNAP_TOL * SNAP_TOL;
    for (const [key, list] of buckets) {
      const c = key.split(',');
      const cx = +c[0]!, cy = +c[1]!, cz = +c[2]!;
      const near: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const n = buckets.get(vkey(cx + dx, cy + dy, cz + dz));
            if (n) near.push(...n);
          }
        }
      }
      for (const a of list) {
        const wa = worldSnaps[a]!;
        for (const b of near) {
          if (b <= a) continue;
          const wb = worldSnaps[b]!;
          if (wa.piece === wb.piece) continue;
          const d2 = (wa.x - wb.x) ** 2 + (wa.y - wb.y) ** 2 + (wa.z - wb.z) ** 2;
          if (d2 > tol2) continue;
          if (!snapsCompatible(wa, wb)) continue;
          if (find(wa.piece) !== find(wb.piece)) {
            snapOnlyUnions++;
            union(wa.piece, wb.piece);
          }
        }
      }
    }
  }

  // Components
  const comp = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const r = find(i);
    let arr = comp.get(r);
    if (!arr) { arr = []; comp.set(r, arr); }
    arr.push(i);
  }
  const comps = [...comp.values()].sort((a, b) => b.length - a.length);
  const largest = comps[0] ?? [];
  const mainRoot = largest.length ? find(largest[0]!) : -1;
  const isDetached: boolean[] = new Array(N);
  let detachedWithoutGeometry = 0;
  for (let i = 0; i < N; i++) {
    isDetached[i] = find(i) !== mainRoot;
    if (isDetached[i] && pieceVoxels[i]!.length === 0) detachedWithoutGeometry++;
  }

  const detachedComponents = classifyDetached(comps.slice(1), bricks, pieceVoxels,
                                              find, R);
  const grounded = detachedComponents.filter(d => d.kind === 'grounded').length;

  return {
    pieces: N,
    components: comps.length,
    largest: largest.length,
    largestPct: N ? +(100 * largest.length / N).toFixed(2) : 0,
    detached: N - largest.length,
    detachedComponents: detachedComponents.slice(0, 20),
    resolutionLDU: R,
    toleranceLDU: R,
    piecesWithoutGeometry,
    detachedWithoutGeometry,
    piecesWithSnaps,
    snapOnlyUnions,
    snapTable: { parts: SNAP_TABLE_PARTS, connectors: SNAP_TABLE_CONNECTORS },
    groundedDetached: grounded,
    airborneDetached: detachedComponents.length - grounded,
    isDetached,
  };
}

/** geograde's calibrated floater rules (clego GEOGRADE.md §1), in LDU. */
const SUPPORT_GAP_LDU = 12;
const FLOOR_CLEARANCE_LDU = 48;

/**
 * Split the non-main components into 'grounded' (resting on something — the
 * deliberately-separate-sub-build class) and 'airborne' (hanging in mid-air).
 *
 * Support is measured only in the columns a detached group actually occupies,
 * so the scan cost is bounded by the detached footprint rather than the whole
 * model. LDraw +Y is DOWN, so "beneath" means a LARGER y.
 */
function classifyDetached(
  comps: number[][], bricks: ParsedBrick[], pieceVoxels: string[][],
  find: (a: number) => number, R: number,
): DetachedComponent[] {
  if (comps.length === 0) return [];

  // Columns the detached groups occupy, and each group's lowest voxel row.
  const wanted = new Set<string>();
  for (const c of comps) {
    for (const i of c) for (const k of pieceVoxels[i]!) wanted.add(columnOf(k));
  }
  // column -> [voxelY, componentRoot] for EVERY piece, restricted to those columns
  const byColumn = new Map<string, { y: number; root: number }[]>();
  let floorY = -Infinity;               // largest y over the whole model = floor
  for (let i = 0; i < pieceVoxels.length; i++) {
    const root = find(i);
    for (const k of pieceVoxels[i]!) {
      const y = yOf(k);
      if (y > floorY) floorY = y;
      const col = columnOf(k);
      if (!wanted.has(col)) continue;
      let arr = byColumn.get(col);
      if (!arr) { arr = []; byColumn.set(col, arr); }
      arr.push({ y, root });
    }
  }
  for (const arr of byColumn.values()) arr.sort((a, b) => a.y - b.y);

  const out: DetachedComponent[] = [];
  for (const c of comps) {
    const root = find(c[0]!);
    let gap = Infinity;
    let lowest = -Infinity;
    for (const i of c) {
      for (const k of pieceVoxels[i]!) {
        const y = yOf(k);
        if (y > lowest) lowest = y;
        const arr = byColumn.get(columnOf(k));
        if (!arr) continue;
        // first voxel strictly BELOW this one that belongs to another component
        for (const e of arr) {
          if (e.y <= y || e.root === root) continue;
          const d = (e.y - y) * R;
          if (d < gap) gap = d;
          break;
        }
      }
    }
    const height = lowest === -Infinity || floorY === -Infinity
      ? 0 : (floorY - lowest) * R;
    const airborne = gap >= SUPPORT_GAP_LDU
      && (Number.isFinite(gap) || height > FLOOR_CLEARANCE_LDU);
    const br = bricks[c[0]!]!;
    out.push({
      size: c.length,
      part: br.part,
      pos: [Math.round(br.x), Math.round(br.y), Math.round(br.z)],
      kind: airborne ? 'airborne' : 'grounded',
      supportGapLDU: gap,
      heightAboveFloorLDU: +height.toFixed(1),
    });
  }
  // Worst first: airborne before grounded, then by size.
  out.sort((a, b) => (a.kind === b.kind ? b.size - a.size : a.kind === 'airborne' ? -1 : 1));
  return out;
}

function columnOf(k: string): string {
  const i = k.indexOf(',');
  const j = k.indexOf(',', i + 1);
  return `${k.slice(0, i)},${k.slice(j + 1)}`;
}

function yOf(k: string): number {
  const i = k.indexOf(',');
  const j = k.indexOf(',', i + 1);
  return +k.slice(i + 1, j);
}
