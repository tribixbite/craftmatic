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
 * Returns filled grid positions along the sweep axis.
 */
function parityFill(hits: number[], cellSize: number): number[] {
  if (hits.length === 0) return [];
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
    const result: number[] = [];
    for (const hit of dedup) result.push(Math.round(hit / cellSize));
    return result;
  }
  const pairs = dedup;

  const result: number[] = [];
  for (let i = 0; i < pairs.length - 1; i += 2) {
    const g0 = Math.round(pairs[i]! / cellSize);
    const g1 = Math.round(pairs[i + 1]! / cellSize);
    for (let g = Math.min(g0, g1); g <= Math.max(g0, g1); g++) {
      result.push(g);
    }
  }
  return result;
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
): Array<readonly [number, number, number]> {
  if (worldTris.length === 0) return [];

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
  const gxMin = Math.floor(wxMin / LDU_STUD);
  const gxMax = Math.ceil(wxMax / LDU_STUD);
  const gyMin = Math.floor(-wyMax / LDU_PER_Y);
  const gyMax = Math.ceil(-wyMin / LDU_PER_Y);
  const gzMin = Math.floor(wzMin / LDU_STUD);
  const gzMax = Math.ceil(wzMax / LDU_STUD);

  // Use a Set to deduplicate cells from all 3 sweep axes
  const cellSet = new Set<string>();

  const addCell = (gx: number, gy: number, gz: number) => {
    cellSet.add(`${gx},${gy},${gz}`);
  };

  // ── Sweep along Z (rays in XY plane, casting +Z) ──────────────────────────
  // Indices: i0=0(X), i1=1(Y), iSweep=2(Z)
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      const ox = (gx + 0.5) * LDU_STUD;
      const oy = -(gy + 0.5) * LDU_PER_Y;
      const hits: number[] = [];
      for (const [v0, v1, v2] of worldTris) {
        const t = rayAxisHit(ox, oy, v0, v1, v2, 0, 1, 2);
        if (t !== null) hits.push(t);
      }
      for (const gz of parityFill(hits, LDU_STUD)) addCell(gx, gy, gz);
    }
  }

  // ── Sweep along X (rays in YZ plane, casting +X) ──────────────────────────
  // Indices: i0=1(Y), i1=2(Z), iSweep=0(X)
  for (let gy = gyMin; gy <= gyMax; gy++) {
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const oy = -(gy + 0.5) * LDU_PER_Y;
      const oz = (gz + 0.5) * LDU_STUD;
      const hits: number[] = [];
      for (const [v0, v1, v2] of worldTris) {
        const t = rayAxisHit(oy, oz, v0, v1, v2, 1, 2, 0);
        if (t !== null) hits.push(t);
      }
      for (const gx of parityFill(hits, LDU_STUD)) addCell(gx, gy, gz);
    }
  }

  // ── Sweep along Y (rays in XZ plane, casting +Y in LDraw = -Y in grid) ───
  // LDraw Y is inverted (positive = down). Must negate raw hits BEFORE dividing
  // by LDU_PER_Y so parity fill operates in grid-Y space (positive = up).
  // Indices: i0=0(X), i1=2(Z), iSweep=1(Y)
  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gz = gzMin; gz <= gzMax; gz++) {
      const ox = (gx + 0.5) * LDU_STUD;
      const oz = (gz + 0.5) * LDU_STUD;
      const hits: number[] = [];
      for (const [v0, v1, v2] of worldTris) {
        const t = rayAxisHit(ox, oz, v0, v1, v2, 0, 2, 1);
        if (t !== null) hits.push(-t); // negate LDraw Y → grid Y BEFORE division
      }
      for (const gy of parityFill(hits, LDU_PER_Y)) {
        addCell(gx, gy, gz);
      }
    }
  }

  // ── Surface pass: mark every cell any triangle surface touches ────────────
  // Ray casting misses thin surfaces (< 1 cell thick) that fall between grid
  // lines. This pass ensures all visible surfaces are present by computing
  // each triangle's grid-space AABB and adding those cells.
  for (const [v0, v1, v2] of worldTris) {
    const txMin = Math.min(v0[0], v1[0], v2[0]);
    const txMax = Math.max(v0[0], v1[0], v2[0]);
    const tyMin = Math.min(v0[1], v1[1], v2[1]);
    const tyMax = Math.max(v0[1], v1[1], v2[1]);
    const tzMin = Math.min(v0[2], v1[2], v2[2]);
    const tzMax = Math.max(v0[2], v1[2], v2[2]);

    const tgxMin = Math.round(txMin / LDU_STUD);
    const tgxMax = Math.round(txMax / LDU_STUD);
    const tgyMin = Math.round(-tyMax / LDU_PER_Y);
    const tgyMax = Math.round(-tyMin / LDU_PER_Y);
    const tgzMin = Math.round(tzMin / LDU_STUD);
    const tgzMax = Math.round(tzMax / LDU_STUD);

    for (let x = tgxMin; x <= tgxMax; x++)
      for (let y = tgyMin; y <= tgyMax; y++)
        for (let z = tgzMin; z <= tgzMax; z++)
          addCell(x, y, z);
  }

  // Convert Set back to array
  const cells: Array<readonly [number, number, number]> = [];
  for (const key of cellSet) {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    cells.push([x, y, z]);
  }
  return cells;
}

// ─── Public: geometry-accurate voxelization ──────────────────────────────────

const MAX_DIM_GEO = 384;

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
): Promise<VoxelizeResult> {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [], fallbackPartCount: 0 };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;
  const isDefaultFn  = colorFn == null;
  const unmappedColorSet = new Set<number>();
  const LDU_PER_Y = options?.cubicScale ? LDU_STUD : 8;

  // Auto-flip detection (same logic as voxelizeLDraw)
  const nonPrimBricks = bricks.filter(b => !isLDrawPrimitive(b.part));
  const ySum = nonPrimBricks.reduce((s, b) => s + b.y, 0);
  const shouldFlip = nonPrimBricks.length > 0 && ySum / nonPrimBricks.length < -LDU_STUD;
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
  await prefetchPartGeometry(uniqueParts);

  const IDENTITY = [1,0,0, 0,1,0, 0,0,1];

  interface Cell { gx: number; gy: number; gz: number; block: string; color: number }
  const cells: Cell[] = [];
  let fallbackPartCount = 0;

  for (const brick of effectiveBricks) {
    if (isLDrawPrimitive(brick.part)) continue;
    // Skip Technic structural parts (pins, axles, bushes) — same as bbox voxelizer
    const barePartId = brick.part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
    if (TECHNIC_INTERNAL_PARTS.has(barePartId)) continue;

    const block = resolveColor(brick.color);
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
      const fbxMin = Math.round(bxMin / LDU_STUD), fbxMax = Math.round(bxMax / LDU_STUD);
      const fbyMin = Math.round(-byMax / LDU_PER_Y), fbyMax = Math.round(-byMin / LDU_PER_Y);
      const fbzMin = Math.round(bzMin / LDU_STUD), fbzMax = Math.round(bzMax / LDU_STUD);
      for (let x = fbxMin; x <= fbxMax; x++)
        for (let y = fbyMin; y <= fbyMax; y++)
          for (let z = fbzMin; z <= fbzMax; z++)
            cells.push({ gx: x, gy: y, gz: z, block, color: brick.color });
      continue;
    }
    const T: Vec3 = [brick.x, brick.y, brick.z];

    // Transform local triangles → world LDU
    const worldTris: Triangle[] = localTris.map(([v0, v1, v2]) => [
      applyMat(v0, R, T),
      applyMat(v1, R, T),
      applyMat(v2, R, T),
    ]);

    for (const [gx, gy, gz] of rasterizeTriangles(worldTris, LDU_PER_Y)) {
      cells.push({ gx, gy, gz, block, color: brick.color });
    }
  }

  if (cells.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return {
      grid, brickCount: bricks.length, uniqueColors: 0,
      dimensions: { w: 1, h: 1, l: 1 },
      unmappedColors: [...unmappedColorSet], wasFlipped: shouldFlip, fallbackPartCount,
    };
  }

  // Compute bounds
  let minX = cells[0]!.gx, maxX = cells[0]!.gx;
  let minY = cells[0]!.gy, maxY = cells[0]!.gy;
  let minZ = cells[0]!.gz, maxZ = cells[0]!.gz;
  for (const c of cells) {
    if (c.gx < minX) minX = c.gx; if (c.gx > maxX) maxX = c.gx;
    if (c.gy < minY) minY = c.gy; if (c.gy > maxY) maxY = c.gy;
    if (c.gz < minZ) minZ = c.gz; if (c.gz > maxZ) maxZ = c.gz;
  }

  let w = maxX - minX + 1;
  let h = maxY - minY + 1;
  let l = maxZ - minZ + 1;
  let scale = 1;
  let warning: string | undefined;

  const maxDim = Math.max(w, h, l);
  if (maxDim > MAX_DIM_GEO) {
    scale = MAX_DIM_GEO / maxDim;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    l = Math.max(1, Math.round(l * scale));
    warning = `Model scaled down ${(1 / scale).toFixed(1)}× to fit limits (max dim ${MAX_DIM_GEO})`;
  }

  const grid = new BlockGrid(w, h, l);
  const colors = new Set<number>();

  for (const c of cells) {
    const x = Math.max(0, Math.min(w - 1, Math.round((c.gx - minX) * scale)));
    const y = Math.max(0, Math.min(h - 1, Math.round((c.gy - minY) * scale)));
    const z = Math.max(0, Math.min(l - 1, Math.round((c.gz - minZ) * scale)));
    grid.set(x, y, z, c.block);
    colors.add(c.color);
  }

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
