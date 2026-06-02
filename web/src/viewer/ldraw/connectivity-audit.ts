/**
 * Geometry-contact connectivity audit for a loaded LDraw model.
 *
 * Answers "are all pieces actually connected, or do some float?" at the level
 * of real surface contact — NOT axis-aligned bounding boxes. A bounding-box
 * test wrongly flags microscale / SNOT / clip / cheese-slope joints as
 * disconnected because the boxes don't overlap even though the parts physically
 * touch. This works from the actual triangle geometry instead:
 *
 *   1. Voxelize each UNIQUE part's triangle surface once, in part-local LDU
 *      space, at resolution R (deduped to one sample point per local voxel).
 *   2. For each placed brick, transform that part's surface points by the
 *      brick's world rotation+translation (LDraw LDU space — no scene scale /
 *      Y-flip needed) and snap to a global R-voxel grid.
 *   3. Union bricks that share a voxel OR occupy face-adjacent voxels
 *      (tolerance ≈ one voxel). Two parts whose surfaces touch land in the
 *      same / neighbouring voxels regardless of how they attach.
 *   4. Connected components → the main build is one giant component; anything
 *      separate is a genuine floater (its surface touches nothing).
 *
 * R defaults to 4 LDU (0.2 stud); contact tolerance ≈ one voxel ≈ 0.4 stud,
 * comfortably tighter than any real connection gap yet robust to quantization.
 *
 * LIMITATION (important): this detects FACE/SURFACE contact (studs-up stacking,
 * flush walls). It is blind to joints whose mechanical contact is a small or
 * curved patch — clip-grips-bar, pin-in-hole, axle, and some SNOT/tile
 * interfaces. On traditionally-built models (e.g. 21063) it reports a single
 * 100%-connected component. On SNOT/microscale-heavy models (e.g. 71043) it
 * under-counts: pieces joined only by clips/bars/pins show as "detached" even
 * though they're embedded in the build. So: a single component == provably
 * connected; multiple components == candidates to eyeball (use the viewer's
 * highlightDetached()), NOT proof of floating. True clip/bar/pin certainty
 * needs LEGO connection-point metadata (LDCad-style), which this does not use.
 */

import { getCachedPartGeom, normId } from './parts';
import type { ParsedBrick } from '../../engine/ldraw-parser';
import type { Triangle } from './types';

export interface ConnectivityReport {
  pieces: number;
  components: number;
  largest: number;
  largestPct: number;
  detached: number;
  /** Representative info for the largest detached components (real floaters). */
  detachedComponents: { size: number; part: string; pos: [number, number, number] }[];
  resolutionLDU: number;
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

  for (let i = 0; i < N; i++) {
    const br = bricks[i]!;
    const pts = partLocalPoints(normId(br.part), R);
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
  for (let i = 0; i < N; i++) isDetached[i] = find(i) !== mainRoot;
  const detachedComponents = comps.slice(1).map(c => {
    const br = bricks[c[0]!]!;
    return {
      size: c.length,
      part: br.part,
      pos: [Math.round(br.x), Math.round(br.y), Math.round(br.z)] as [number, number, number],
    };
  });

  return {
    pieces: N,
    components: comps.length,
    largest: largest.length,
    largestPct: N ? +(100 * largest.length / N).toFixed(2) : 0,
    detached: N - largest.length,
    detachedComponents: detachedComponents.slice(0, 20),
    resolutionLDU: R,
    isDetached,
  };
}
