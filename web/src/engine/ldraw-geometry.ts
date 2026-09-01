/**
 * Geometry-accurate voxelization from LDraw .dat triangle data.
 *
 * Fetches .dat files from the local dev server (/ldraw-parts — see vite.config.ts),
 * resolves sub-file references recursively, and rasterizes the resulting triangle
 * mesh into grid cells using Z-direction ray casting (Möller-Trumbore).
 *
 * Usage:
 *   // 1. Prefetch all unique part IDs (batch, parallel fetch)
 *   await prefetchPartGeometry(uniquePartIds);
 *   // 2. Voxelize — async drop-in for voxelizeLDraw()
 *   const result = await voxelizeLDrawGeometry(bricks, colorFn, options);
 *
 * Only works in dev (requires /ldraw-parts static middleware in vite.config.ts).
 * In production, all parts fall back to no-geometry (fallbackPartCount = total).
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { BlockGrid } from '@craft/schem/types.js';
import { ldrawColorToBlock, LDRAW_COLOR_TO_BLOCK } from './ldraw-colors.js';
import { type VoxelizeResult, type VoxelizeOptions, TECHNIC_INTERNAL_PARTS } from './ldraw-voxelizer.js';
import { getPartDims } from './ldraw-part-dims.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type Vec3 = readonly [number, number, number];
type Triangle = readonly [Vec3, Vec3, Vec3];

// ─── Caches ───────────────────────────────────────────────────────────────────

const datTextCache  = new Map<string, string | null>();
const partGeomCache = new Map<string, Triangle[]>();
const datInFlight   = new Map<string, Promise<string | null>>();
const geomInFlight  = new Map<string, Promise<Triangle[]>>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normId(id: string): string {
  return id.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/i, '').trim();
}

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  if (/^\d+-\d+/.test(bare))         return true;
  if (bare.startsWith('stug-'))      return true;
  if (bare === 'axl2hole' || bare.startsWith('axlhol')) return true;
  if (bare.startsWith('connect'))    return true;
  if (bare.startsWith('npeghol'))    return true;
  if (bare.startsWith('npeghole'))   return true;
  if (bare.startsWith('logo'))       return true;
  if (bare.startsWith('stud'))       return true;
  if (bare === 'box' || /^box[\da-z]/.test(bare)) return true;
  if (bare === 'disc')               return true;
  if (bare === 'knob' || bare === 'tooth') return true;
  if (/^\d+s\d+$/.test(bare))       return true;
  if (/^ls\d+/.test(bare))          return true;  // LSynth virtual hose/cable segments
  return false;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

/** Browser URL path for dev server, or filesystem root for CLI usage. */
let LDRAW_BASE = '/ldraw-parts';
/** When true, read .dat files from local filesystem instead of fetch(). */
let useFilesystem = false;

/**
 * Configure the LDraw parts library root.
 * Call before voxelizing in CLI scripts where fetch() won't reach the dev server.
 * @param fsRoot Absolute path to the LDraw library root (e.g. 'C:/git/clego/extracted/studio_release/app/ldraw')
 */
export function setLDrawRoot(fsRoot: string): void {
  LDRAW_BASE = fsRoot.replace(/\\/g, '/').replace(/\/$/, '');
  useFilesystem = true;
}

/**
 * Point the fetch-based loader at a different origin/path (e.g. from a Web
 * Worker, which has no page-relative base). Stays in fetch mode.
 */
export function setLDrawBase(base: string): void {
  LDRAW_BASE = base.replace(/\/$/, '');
  useFilesystem = false;
}

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key))  return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;

  const paths: string[] = [];
  if (key.includes('/')) {
    if (key.startsWith('s/'))
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
  }
  paths.push(
    `${LDRAW_BASE}/parts/${stem}.dat`,
    `${LDRAW_BASE}/p/${stem}.dat`,
    `${LDRAW_BASE}/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
  );

  const promise = (async (): Promise<string | null> => {
    for (const path of paths) {
      try {
        if (useFilesystem) {
          // CLI: read from local filesystem
          const { readFileSync, existsSync } = await import('node:fs');
          if (existsSync(path)) {
            const text = readFileSync(path, 'utf-8');
            datTextCache.set(key, text);
            return text;
          }
        } else {
          // Browser: fetch from dev server
          const r = await fetch(path);
          if (r.ok) {
            const text = await r.text();
            datTextCache.set(key, text);
            return text;
          }
        }
      } catch { /* try next path */ }
    }
    datTextCache.set(key, null);
    return null;
  })();

  datInFlight.set(key, promise);
  const result = await promise;
  datInFlight.delete(key);
  return result;
}

// ─── Triangle resolution ──────────────────────────────────────────────────────

/**
 * Resolve all triangles for a part in its LOCAL coordinate space.
 * Sub-file references are recursively resolved and transformed into parent space.
 * Results are cached — concurrent calls for the same ID share one promise.
 */
async function resolvePartTriangles(id: string, depth = 0): Promise<Triangle[]> {
  if (depth > 12) return [];
  const key = normId(id);

  if (partGeomCache.has(key)) return partGeomCache.get(key)!;
  if (geomInFlight.has(key))  return geomInFlight.get(key)!;

  const promise = (async (): Promise<Triangle[]> => {
    const text = await fetchDatText(key);
    if (!text) return [];

    const tris: Triangle[] = [];
    partGeomCache.set(key, tris);     // cache reference early (cycle guard)

    const subPromises: Promise<void>[] = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const tok = line.split(/\s+/);

      if (tok[0] === '3' && tok.length >= 11) {
        tris.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
          [+tok[8]!, +tok[9]!, +tok[10]!],
        ]);
      } else if (tok[0] === '4' && tok.length >= 14) {
        const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
        const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
        const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
        const v3: Vec3 = [+tok[11]!, +tok[12]!, +tok[13]!];
        tris.push([v0, v1, v2]);
        tris.push([v0, v2, v3]);       // quad → 2 triangles
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 11) {
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        const R = [+tok[5]!,+tok[6]!,+tok[7]!, +tok[8]!,+tok[9]!,+tok[10]!, +tok[11]!,+tok[12]!,+tok[13]!];
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();

        subPromises.push(
          resolvePartTriangles(subId, depth + 1).then(subTris => {
            for (const [sv0, sv1, sv2] of subTris) {
              tris.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
            }
          }),
        );
      }
    }

    await Promise.all(subPromises);
    return tris;
  })();

  geomInFlight.set(key, promise);
  const result = await promise;
  geomInFlight.delete(key);
  return result;
}

/** Batch-prefetch geometry for all provided part IDs in parallel. */
export async function prefetchPartGeometry(partIds: string[]): Promise<void> {
  const unique = [...new Set(partIds.map(normId))];
  await Promise.all(unique.map(id => resolvePartTriangles(id)));
}

// ─── Ray-triangle intersection (generic axis) ───────────────────────────────

const LDU_STUD = 20;

/**
 * Generic Möller-Trumbore ray-triangle intersection.
 * Ray origin at (o0, o1) in the plane perpendicular to the sweep axis,
 * direction along the sweep axis (+1).
 *
 * Vertex components are indexed by i0, i1 (perpendicular) and iSweep (sweep).
 * Returns the sweep-axis coordinate of intersection, or null.
 */
function rayAxisHit(
  o0: number, o1: number,
  v0: Vec3, v1: Vec3, v2: Vec3,
  i0: number, i1: number, iSweep: number,
): number | null {
  const e1_0 = v1[i0] - v0[i0], e1_1 = v1[i1] - v0[i1], e1_s = v1[iSweep] - v0[iSweep];
  const e2_0 = v2[i0] - v0[i0], e2_1 = v2[i1] - v0[i1], e2_s = v2[iSweep] - v0[iSweep];
  // h = dir × E2, where dir=(0,0,1) in (i0,i1,iSweep) space → h = (-e2_1, e2_0, 0)
  const h0 = -e2_1, h1 = e2_0;
  const a = e1_0 * h0 + e1_1 * h1;
  if (Math.abs(a) < 1e-9) return null;
  const f = 1 / a;
  const s0 = o0 - v0[i0], s1 = o1 - v0[i1], ss = -v0[iSweep];
  const u = f * (s0 * h0 + s1 * h1);
  if (u < 0 || u > 1) return null;
  const q0 = s1 * e1_s - ss * e1_1;
  const q1 = ss * e1_0 - s0 * e1_s;
  const q2 = s0 * e1_1 - s1 * e1_0;
  const v = f * q2;
  if (v < 0 || u + v > 1) return null;
  return f * (e2_0 * q0 + e2_1 * q1 + e2_s * q2);
}

/**
 * Parity-fill ray hits into grid cells along one axis.
 * Writes the filled grid positions into `out` (reused across rays to avoid
 * allocating two arrays per ray).
 */
function parityFill(hits: number[], cellSize: number, out: number[]): void {
  out.length = 0;
  if (hits.length === 0) return;
  hits.sort((a, b) => a - b);

  // Deduplicate near-identical hits (shared triangle edges)
  const dedup: number[] = [hits[0]!];
  for (let i = 1; i < hits.length; i++) {
    if (hits[i]! - dedup[dedup.length - 1]! > 0.1) dedup.push(hits[i]!);
  }

  // Parity fill: pairs [t0,t1], [t2,t3], …
  // Odd count (non-watertight mesh) → fill only the surface cells at each hit
  // point instead of the full [min,max] range (which over-fills thin parts).
  if (dedup.length % 2 !== 0) {
    for (const hit of dedup) out.push(Math.round(hit / cellSize));
    return;
  }
  const pairs = dedup;

  for (let i = 0; i < pairs.length - 1; i += 2) {
    const g0 = Math.round(pairs[i]! / cellSize);
    const g1 = Math.round(pairs[i + 1]! / cellSize);
    for (let g = Math.min(g0, g1); g <= Math.max(g0, g1); g++) {
      out.push(g);
    }
  }
}

/**
 * CSR index of triangles by the 2D lattice of ray origins for one sweep axis.
 * `start[b]…start[b+1]` bounds the triangle indices covering bucket `b`,
 * where `b = (g0 - lo0) * n1 + (g1 - lo1)`.
 */
interface TriBuckets { start: Int32Array; items: Int32Array; n1: number }

function buildTriBuckets(
  nTris: number,
  lo0: number, hi0: number, lo1: number, hi1: number,
  r0Lo: Int32Array, r0Hi: Int32Array, r1Lo: Int32Array, r1Hi: Int32Array,
): TriBuckets {
  const n0 = hi0 - lo0 + 1;
  const n1 = hi1 - lo1 + 1;
  const nb = n0 * n1;
  const start = new Int32Array(nb + 1);
  for (let t = 0; t < nTris; t++) {
    const a0 = r0Lo[t]!, b0 = r0Hi[t]!, a1 = r1Lo[t]!, b1 = r1Hi[t]!;
    for (let g0 = a0; g0 <= b0; g0++) {
      const base = (g0 - lo0) * n1 - lo1 + 1;
      for (let g1 = a1; g1 <= b1; g1++) start[base + g1]++;
    }
  }
  for (let i = 0; i < nb; i++) start[i + 1] += start[i]!;
  const items = new Int32Array(start[nb]!);
  const cursor = start.slice(0, nb);
  for (let t = 0; t < nTris; t++) {
    const a0 = r0Lo[t]!, b0 = r0Hi[t]!, a1 = r1Lo[t]!, b1 = r1Hi[t]!;
    for (let g0 = a0; g0 <= b0; g0++) {
      const base = (g0 - lo0) * n1 - lo1;
      for (let g1 = a1; g1 <= b1; g1++) items[cursor[base + g1]!++] = t;
    }
  }
  return { start, items, n1 };
}

// ─── Rasterization (tri-axis) ────────────────────────────────────────────────

/**
 * Rasterize world-LDU triangles into grid cells using tri-axis ray casting.
 *
 * Casts rays along X, Y, and Z axes independently, then unions the results.
 * This captures geometry that a single-axis sweep would miss (thin plates
 * parallel to the sweep direction, angled panels, etc.).
 *
 * Grid coordinate system:
 *   gx = world_x / LDU_STUD        (LDraw X → grid X)
 *   gy = -world_y / LDU_PER_Y      (LDraw Y-down → grid Y-up)
 *   gz = world_z / LDU_STUD         (LDraw Z → grid Z)
 */
function rasterizeTriangles(
  worldTris: Triangle[],
  LDU_PER_Y: number,
  LDU_PER_XZ: number,
  emit: (gx: number, gy: number, gz: number) => void,
): void {
  if (worldTris.length === 0) return;

  // Full 3D bounding box in world LDU
  let wxMin = Infinity, wxMax = -Infinity;
  let wyMin = Infinity, wyMax = -Infinity;
  let wzMin = Infinity, wzMax = -Infinity;

  for (const [v0, v1, v2] of worldTris) {
    for (const v of [v0, v1, v2]) {
      if (v[0] < wxMin) wxMin = v[0]; if (v[0] > wxMax) wxMax = v[0];
      if (v[1] < wyMin) wyMin = v[1]; if (v[1] > wyMax) wyMax = v[1];
      if (v[2] < wzMin) wzMin = v[2]; if (v[2] > wzMax) wzMax = v[2];
    }
  }

  // Grid ranges
  const gxMin = Math.floor(wxMin / LDU_PER_XZ);
  const gxMax = Math.ceil(wxMax / LDU_PER_XZ);
  const gyMin = Math.floor(-wyMax / LDU_PER_Y);
  const gyMax = Math.ceil(-wyMin / LDU_PER_Y);
  const gzMin = Math.floor(wzMin / LDU_PER_XZ);
  const gzMax = Math.ceil(wzMax / LDU_PER_XZ);

  // Deduplicate cells from all 3 sweep axes.
  // Keys are NUMERIC (offset from the part's own grid AABB, row-major) rather
  // than `${gx},${gy},${gz}` strings — same insertion order, same dedup
  // semantics, but no per-cell string allocation. (S3: string keys dominated
  // the 85 s main-thread stall measured on 21063 at cellLDU 4.)
  // Every emitted coordinate provably lies in [gMin, gMax] (parity hits come
  // from ray/triangle intersections inside the mesh AABB; the surface pass
  // rounds a sub-range of it), but pad by 2 and keep a string overflow set so a
  // float edge case can never alias two cells onto one key.
  const oX = gxMin - 2, oY = gyMin - 2, oZ = gzMin - 2;
  const nX = (gxMax - gxMin) + 5;
  const nY = (gyMax - gyMin) + 5;
  const nZ = (gzMax - gzMin) + 5;
  const cellSet = new Set<number>();
  const overflow = new Set<string>();

  const addCell = (gx: number, gy: number, gz: number) => {
    const dx = gx - oX, dy = gy - oY, dz = gz - oZ;
    if (dx < 0 || dy < 0 || dz < 0 || dx >= nX || dy >= nY || dz >= nZ) {
      overflow.add(`${gx},${gy},${gz}`);
      return;
    }
    cellSet.add((dx * nY + dy) * nZ + dz);
  };

  // ── Per-triangle ray-index ranges (broad phase) ───────────────────────────
  // Möller-Trumbore's u/v test already rejects every ray whose 2D origin falls
  // outside the triangle's projected bounding box, so restricting each ray to
  // the triangles whose box covers it is EXACTLY equivalent — just without the
  // O(rays × triangles) scan that dominated the 60 s stall measured on 21063.
  // Ranges are padded ±1 cell so a float rounding edge can never drop a
  // boundary-touching ray. `hits` are sorted in parityFill, so changing the
  // triangle visit order cannot change the output.
  const nTris = worldTris.length;
  const xLo = new Int32Array(nTris), xHi = new Int32Array(nTris);
  const yLo = new Int32Array(nTris), yHi = new Int32Array(nTris);
  const zLo = new Int32Array(nTris), zHi = new Int32Array(nTris);
  for (let t = 0; t < nTris; t++) {
    const [v0, v1, v2] = worldTris[t]!;
    const txMin = Math.min(v0[0], v1[0], v2[0]), txMax = Math.max(v0[0], v1[0], v2[0]);
    const tyMin = Math.min(v0[1], v1[1], v2[1]), tyMax = Math.max(v0[1], v1[1], v2[1]);
    const tzMin = Math.min(v0[2], v1[2], v2[2]), tzMax = Math.max(v0[2], v1[2], v2[2]);
    xLo[t] = Math.max(gxMin, Math.ceil(txMin / LDU_PER_XZ - 0.5) - 1);
    xHi[t] = Math.min(gxMax, Math.floor(txMax / LDU_PER_XZ - 0.5) + 1);
    yLo[t] = Math.max(gyMin, Math.ceil(-tyMax / LDU_PER_Y - 0.5) - 1);
    yHi[t] = Math.min(gyMax, Math.floor(-tyMin / LDU_PER_Y - 0.5) + 1);
    zLo[t] = Math.max(gzMin, Math.ceil(tzMin / LDU_PER_XZ - 0.5) - 1);
    zHi[t] = Math.min(gzMax, Math.floor(tzMax / LDU_PER_XZ - 0.5) + 1);
  }

  // Bucketing only pays for itself on non-trivial meshes.
  const BUCKET_MIN_TRIS = 24;
  const useBuckets = nTris >= BUCKET_MIN_TRIS;

  const hits: number[] = [];
  const filled: number[] = [];

  // ── Sweep along Z (rays in XY plane, casting +Z) ──────────────────────────
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gxMin, gxMax, gyMin, gyMax, xLo, xHi, yLo, yHi) : null;
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gy = gyMin; gy <= gyMax; gy++) {
        const ox = (gx + 0.5) * LDU_PER_XZ;
        const oy = -(gy + 0.5) * LDU_PER_Y;
        hits.length = 0;
        if (bk) {
          const b = (gx - gxMin) * bk.n1 + (gy - gyMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(ox, oy, v0, v1, v2, 0, 1, 2);
            if (t !== null) hits.push(t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(ox, oy, v0, v1, v2, 0, 1, 2);
            if (t !== null) hits.push(t);
          }
        }
        parityFill(hits, LDU_PER_XZ, filled);
        for (const gz of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Sweep along X (rays in YZ plane, casting +X) ──────────────────────────
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gyMin, gyMax, gzMin, gzMax, yLo, yHi, zLo, zHi) : null;
    for (let gy = gyMin; gy <= gyMax; gy++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const oy = -(gy + 0.5) * LDU_PER_Y;
        const oz = (gz + 0.5) * LDU_PER_XZ;
        hits.length = 0;
        if (bk) {
          const b = (gy - gyMin) * bk.n1 + (gz - gzMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(oy, oz, v0, v1, v2, 1, 2, 0);
            if (t !== null) hits.push(t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(oy, oz, v0, v1, v2, 1, 2, 0);
            if (t !== null) hits.push(t);
          }
        }
        parityFill(hits, LDU_PER_XZ, filled);
        for (const gx of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Sweep along Y (rays in XZ plane, casting -Y in LDraw = +Y in grid) ───
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gxMin, gxMax, gzMin, gzMax, xLo, xHi, zLo, zHi) : null;
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const ox = (gx + 0.5) * LDU_PER_XZ;
        const oz = (gz + 0.5) * LDU_PER_XZ;
        hits.length = 0;
        if (bk) {
          const b = (gx - gxMin) * bk.n1 + (gz - gzMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(ox, oz, v0, v1, v2, 0, 2, 1);
            if (t !== null) hits.push(-t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(ox, oz, v0, v1, v2, 0, 2, 1);
            if (t !== null) hits.push(-t);
          }
        }
        parityFill(hits, LDU_PER_Y, filled);
        for (const gy of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Surface pass: mark every cell any triangle surface touches ────────────
  for (const [v0, v1, v2] of worldTris) {
    const txMin = Math.min(v0[0], v1[0], v2[0]);
    const txMax = Math.max(v0[0], v1[0], v2[0]);
    const tyMin = Math.min(v0[1], v1[1], v2[1]);
    const tyMax = Math.max(v0[1], v1[1], v2[1]);
    const tzMin = Math.min(v0[2], v1[2], v2[2]);
    const tzMax = Math.max(v0[2], v1[2], v2[2]);

    const tgxMin = Math.round(txMin / LDU_PER_XZ);
    const tgxMax = Math.round(txMax / LDU_PER_XZ);
    const tgyMin = Math.round(-tyMax / LDU_PER_Y);
    const tgyMax = Math.round(-tyMin / LDU_PER_Y);
    const tgzMin = Math.round(tzMin / LDU_PER_XZ);
    const tgzMax = Math.round(tzMax / LDU_PER_XZ);

    for (let x = tgxMin; x <= tgxMax; x++)
      for (let y = tgyMin; y <= tgyMax; y++)
        for (let z = tgzMin; z <= tgzMax; z++)
          addCell(x, y, z);
  }

  // Emit the deduplicated cells
  for (const key of cellSet) {
    const dz = key % nZ;
    const rest = (key - dz) / nZ;
    const dy = rest % nY;
    const dx = (rest - dy) / nY;
    emit(dx + oX, dy + oY, dz + oZ);
  }
  for (const key of overflow) {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    emit(x, y, z);
  }
}

// ─── Cell store ──────────────────────────────────────────────────────────────

/**
 * Chunked typed-array store for emitted voxel cells.
 *
 * WHY (S3): the accumulator used to be `Array<{gx,gy,gz,block,color}>` — 1.60M
 * objects ≈ 98 MB measured on 21063 at cellLDU 4, and linear in cell count, so
 * a 30M-cell export allocated hundreds of MB of short-lived objects. Parallel
 * Int32/Uint16 chunks store the same information in 14 bytes per cell with no
 * per-cell object header and no re-copy on growth. Block strings are interned
 * into `blocks` (colour is accumulated per-brick, never per-cell).
 */
const CELL_CHUNK = 1 << 20;

class CellStore {
  private xs: Int32Array[] = [];
  private ys: Int32Array[] = [];
  private zs: Int32Array[] = [];
  private bs: Uint16Array[] = [];
  private fill = CELL_CHUNK; // force a new chunk on first push
  count = 0;
  readonly blocks: string[] = [];
  private blockIdx = new Map<string, number>();

  /** Intern a block-state string; returns its index for push(). */
  blockId(block: string): number {
    let i = this.blockIdx.get(block);
    if (i === undefined) {
      i = this.blocks.length;
      if (i > 65535) throw new Error('CellStore: more than 65536 distinct block states');
      this.blocks.push(block);
      this.blockIdx.set(block, i);
    }
    return i;
  }

  push(gx: number, gy: number, gz: number, blockId: number): void {
    if (this.fill === CELL_CHUNK) {
      this.xs.push(new Int32Array(CELL_CHUNK));
      this.ys.push(new Int32Array(CELL_CHUNK));
      this.zs.push(new Int32Array(CELL_CHUNK));
      this.bs.push(new Uint16Array(CELL_CHUNK));
      this.fill = 0;
    }
    const c = this.xs.length - 1;
    this.xs[c]![this.fill] = gx;
    this.ys[c]![this.fill] = gy;
    this.zs[c]![this.fill] = gz;
    this.bs[c]![this.fill] = blockId;
    this.fill++;
    this.count++;
  }

  /** Iterate every stored cell. */
  forEach(fn: (gx: number, gy: number, gz: number, blockId: number) => void): void {
    for (let c = 0; c < this.xs.length; c++) {
      const n = c === this.xs.length - 1 ? this.fill : CELL_CHUNK;
      const X = this.xs[c]!, Y = this.ys[c]!, Z = this.zs[c]!, B = this.bs[c]!;
      for (let i = 0; i < n; i++) fn(X[i]!, Y[i]!, Z[i]!, B[i]!);
    }
  }
}

// ─── Public: geometry-accurate voxelization ──────────────────────────────────

const MAX_DIM_GEO = 384;

/** Progress sink for long voxelizations (worker → UI banner). */
export type VoxelProgress = (phase: string, pct?: number) => void;

/**
 * Geometry-accurate async replacement for voxelizeLDraw().
 *
 * Fetches real .dat triangle data for each unique part, rasterizes it to voxels,
 * and returns the same VoxelizeResult interface as voxelizeLDraw().
 *
 * Parts with no geometry available (file not found) are skipped and counted
 * in `fallbackPartCount`. In production where /ldraw-parts is unavailable,
 * all parts will be skipped — use regular voxelizeLDraw() instead.
 */
export async function voxelizeLDrawGeometry(
  bricks: ParsedBrick[],
  colorFn?: (id: number) => string,
  options?: VoxelizeOptions,
  onProgress?: VoxelProgress,
): Promise<VoxelizeResult> {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [], fallbackPartCount: 0 };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;
  const isDefaultFn  = colorFn == null;
  const unmappedColorSet = new Set<number>();
  const detail = options?.detailScale === true;
  const cell = options?.cellLDU;
  const LDU_PER_Y = cell ?? (detail ? 8 : (options?.cubicScale ? LDU_STUD : 8));
  const LDU_XZ = cell ?? (detail ? 8 : LDU_STUD);

  // Auto-flip disabled: LDraw convention is Y-down, and our grid conversion
  // (gy = -wy / LDU_PER_Y) already handles the inversion. Flipping was
  // incorrectly inverting models with all-negative Y (standard LDraw orientation).
  const shouldFlip = false;
  const maxStep = options?.maxStep;

  const effectiveBricks = (shouldFlip || maxStep != null)
    ? bricks
        .filter(b => maxStep == null || (b.step ?? 1) <= maxStep)
        .map(b => shouldFlip ? { ...b, y: -b.y } : b)
    : bricks;

  // Prefetch all unique part geometries in parallel
  const uniqueParts = [...new Set(
    effectiveBricks.map(b => b.part).filter(p => !isLDrawPrimitive(p)),
  )];
  onProgress?.('loading part geometry', 0);
  await prefetchPartGeometry(uniqueParts);

  const IDENTITY = [1,0,0, 0,1,0, 0,0,1];

  const cells = new CellStore();
  const colors = new Set<number>();
  let fallbackPartCount = 0;

  let brickIdx = 0;
  let lastPct = -1;
  for (const brick of effectiveBricks) {
    if (onProgress) {
      const pct = Math.floor((brickIdx / effectiveBricks.length) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress('voxelizing', pct); }
    }
    brickIdx++;
    if (isLDrawPrimitive(brick.part)) continue;
    // Skip Technic structural parts (pins, axles, bushes) — same as bbox voxelizer
    const barePartId = brick.part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
    if (TECHNIC_INTERNAL_PARTS.has(barePartId)) continue;

    const block = resolveColor(brick.color);
    const blockId = cells.blockId(block);
    if (isDefaultFn && !(brick.color in LDRAW_COLOR_TO_BLOCK)) {
      unmappedColorSet.add(brick.color);
    }

    const localTris = partGeomCache.get(normId(brick.part));
    const R = brick.rot ?? IDENTITY;

    if (!localTris || localTris.length === 0) {
      // Fallback: use AABB dims fill (same as bbox voxelizer)
      fallbackPartCount++;
      const [sW, sH, sL] = getPartDims(brick.part);
      const lxHalf = (sW - 1) / 2 * LDU_STUD;
      const lzHalf = (sL - 1) / 2 * LDU_STUD;
      const lyBot = (sH - 1) * 8;
      let bxMin = Infinity, bxMax = -Infinity;
      let byMin = Infinity, byMax = -Infinity;
      let bzMin = Infinity, bzMax = -Infinity;
      for (const lx of [-lxHalf, lxHalf]) {
        for (const ly of [0, lyBot]) {
          for (const lz of [-lzHalf, lzHalf]) {
            const wx = R[0]! * lx + R[1]! * ly + R[2]! * lz + brick.x;
            const wy = R[3]! * lx + R[4]! * ly + R[5]! * lz + brick.y;
            const wz = R[6]! * lx + R[7]! * ly + R[8]! * lz + brick.z;
            if (wx < bxMin) bxMin = wx; if (wx > bxMax) bxMax = wx;
            if (wy < byMin) byMin = wy; if (wy > byMax) byMax = wy;
            if (wz < bzMin) bzMin = wz; if (wz > bzMax) bzMax = wz;
          }
        }
      }
      const fbxMin = Math.round(bxMin / LDU_XZ), fbxMax = Math.round(bxMax / LDU_XZ);
      const fbyMin = Math.round(-byMax / LDU_PER_Y), fbyMax = Math.round(-byMin / LDU_PER_Y);
      const fbzMin = Math.round(bzMin / LDU_XZ), fbzMax = Math.round(bzMax / LDU_XZ);
      for (let x = fbxMin; x <= fbxMax; x++)
        for (let y = fbyMin; y <= fbyMax; y++)
          for (let z = fbzMin; z <= fbzMax; z++) {
            cells.push(x, y, z, blockId);
            colors.add(brick.color);
          }
      continue;
    }
    const T: Vec3 = [brick.x, brick.y, brick.z];

    // Transform local triangles → world LDU
    const worldTris: Triangle[] = localTris.map(([v0, v1, v2]) => [
      applyMat(v0, R, T),
      applyMat(v1, R, T),
      applyMat(v2, R, T),
    ]);

    let emitted = false;
    rasterizeTriangles(worldTris, LDU_PER_Y, LDU_XZ, (gx, gy, gz) => {
      cells.push(gx, gy, gz, blockId);
      emitted = true;
    });
    if (emitted) colors.add(brick.color);
  }

  if ((globalThis as { __voxProfile?: boolean }).__voxProfile) {
    console.log(`[profile] cells=${cells.count.toLocaleString()} ≈ ${(cells.count * 14 / 1048576).toFixed(1)} MB (typed chunks)`);
  }
  if (cells.count === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return {
      grid, brickCount: bricks.length, uniqueColors: 0,
      dimensions: { w: 1, h: 1, l: 1 },
      unmappedColors: [...unmappedColorSet], wasFlipped: shouldFlip, fallbackPartCount,
    };
  }

  // Compute bounds
  onProgress?.('measuring bounds');
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  cells.forEach((gx, gy, gz) => {
    if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
    if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
    if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
  });

  let w = maxX - minX + 1;
  let h = maxY - minY + 1;
  let l = maxZ - minZ + 1;
  let scale = 1;
  let warning: string | undefined;

  const dimCap = options?.maxDim ?? MAX_DIM_GEO;
  const maxDim = Math.max(w, h, l);
  if (maxDim > dimCap) {
    scale = dimCap / maxDim;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    l = Math.max(1, Math.round(l * scale));
    warning = `Model scaled down ${(1 / scale).toFixed(1)}× to fit limits (max dim ${dimCap})`;
  }

  onProgress?.('building grid');
  const grid = new BlockGrid(w, h, l);
  // Pre-intern the block palette in first-use order (identical to the old
  // per-cell grid.set(string) path, which assigned ids in the same order).
  const paletteIds = cells.blocks.map(b => grid.paletteIndexOf(b));

  cells.forEach((gx, gy, gz, blockId) => {
    const x = Math.max(0, Math.min(w - 1, Math.round((gx - minX) * scale)));
    const y = Math.max(0, Math.min(h - 1, Math.round((gy - minY) * scale)));
    const z = Math.max(0, Math.min(l - 1, Math.round((gz - minZ) * scale)));
    grid.setIndex(x, y, z, paletteIds[blockId]!);
  });

  if (fallbackPartCount > 0) {
    console.warn(`[geometry] ${fallbackPartCount} parts had no .dat geometry — skipped`);
  }

  return {
    grid,
    brickCount: bricks.length,
    uniqueColors: colors.size,
    dimensions: { w, h, l },
    warning,
    unmappedColors: [...unmappedColorSet],
    wasFlipped: shouldFlip,
    fallbackPartCount,
  };
}
