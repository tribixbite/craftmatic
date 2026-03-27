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
import type { VoxelizeResult, VoxelizeOptions } from './ldraw-voxelizer.js';

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
  return false;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

const LDRAW_BASE = '/ldraw-parts';

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key))  return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;

  const paths: string[] = [];
  // Handle sub-directory refs (e.g. "s/12345", "48/4-4cyli")
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
        const r = await fetch(path);
        if (r.ok) {
          const text = await r.text();
          datTextCache.set(key, text);
          return text;
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
  if (depth > 5) return [];
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
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 4) {
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

// ─── Ray-triangle intersection ────────────────────────────────────────────────

/**
 * Möller-Trumbore: ray origin (ox, oy, 0), direction (0, 0, 1) in world LDU.
 * Returns the Z-coordinate of intersection, or null if none.
 */
function rayZHit(ox: number, oy: number, v0: Vec3, v1: Vec3, v2: Vec3): number | null {
  const e1x = v1[0]-v0[0], e1y = v1[1]-v0[1], e1z = v1[2]-v0[2];
  const e2x = v2[0]-v0[0], e2y = v2[1]-v0[1], e2z = v2[2]-v0[2];
  // h = (0,0,1) × E2 = (-E2y, E2x, 0)
  const hx = -e2y, hy = e2x;
  const a  = e1x*hx + e1y*hy;
  if (Math.abs(a) < 1e-9) return null;     // ray parallel to triangle
  const f = 1 / a;
  const sx = ox - v0[0], sy = oy - v0[1], sz = -v0[2];
  const u  = f * (sx*hx + sy*hy);
  if (u < 0 || u > 1) return null;
  const qx = sy*e1z - sz*e1y;
  const qy = sz*e1x - sx*e1z;
  const qz = sx*e1y - sy*e1x;
  const v  = f * qz;
  if (v < 0 || u + v > 1) return null;
  return f * (e2x*qx + e2y*qy + e2z*qz);  // intersection Z
}

// ─── Rasterization ────────────────────────────────────────────────────────────

const LDU_STUD = 20;

/**
 * Rasterize world-LDU triangles into grid cells using Z-sweep ray casting.
 * Casts a ray in +Z for each (gx, gy) pair and parity-fills between intersections.
 *
 * @param worldTris Triangles in world LDU (already transformed with brick's rot/pos)
 * @param LDU_PER_Y LDU per vertical grid cell (8 for accurate, 20 for cubic)
 * @returns Array of absolute [gx, gy, gz] grid coordinates
 */
function rasterizeTriangles(
  worldTris: Triangle[],
  LDU_PER_Y: number,
): Array<readonly [number, number, number]> {
  if (worldTris.length === 0) return [];

  // Bounding box in world LDU
  let wxMin = Infinity, wxMax = -Infinity;
  let wyMin = Infinity, wyMax = -Infinity;

  for (const [v0, v1, v2] of worldTris) {
    for (const v of [v0, v1, v2]) {
      if (v[0] < wxMin) wxMin = v[0]; if (v[0] > wxMax) wxMax = v[0];
      if (v[1] < wyMin) wyMin = v[1]; if (v[1] > wyMax) wyMax = v[1];
    }
  }

  // Grid Y range (LDraw Y-down → gy = -wy / LDU_PER_Y)
  const gxMin = Math.floor(wxMin / LDU_STUD);
  const gxMax = Math.ceil(wxMax / LDU_STUD);
  const gyMin = Math.floor(-wyMax / LDU_PER_Y);
  const gyMax = Math.ceil(-wyMin / LDU_PER_Y);

  const cells: Array<readonly [number, number, number]> = [];

  for (let gx = gxMin; gx <= gxMax; gx++) {
    for (let gy = gyMin; gy <= gyMax; gy++) {
      // Ray origin in world LDU: center of this (gx, gy) grid column
      const ox = (gx + 0.5) * LDU_STUD;
      // Invert grid Y back to LDraw Y-down: wy = -(gy + 0.5) * LDU_PER_Y
      const oy = -(gy + 0.5) * LDU_PER_Y;

      const hits: number[] = [];
      for (const [v0, v1, v2] of worldTris) {
        const t = rayZHit(ox, oy, v0, v1, v2);
        if (t !== null) hits.push(t);
      }
      if (hits.length === 0) continue;

      hits.sort((a, b) => a - b);

      // Remove near-duplicates (shared edges between adjacent triangles)
      const dedup: number[] = [hits[0]!];
      for (let i = 1; i < hits.length; i++) {
        if (hits[i]! - dedup[dedup.length - 1]! > 0.1) dedup.push(hits[i]!);
      }

      // Parity fill: pairs [t0,t1], [t2,t3], … fill solid interior
      // Odd count (degenerate mesh) → use full [min,max] range
      const pairs = dedup.length % 2 === 0
        ? dedup
        : [dedup[0]!, dedup[dedup.length - 1]!];

      for (let i = 0; i < pairs.length - 1; i += 2) {
        const gz0 = Math.round(pairs[i]! / LDU_STUD);
        const gz1 = Math.round(pairs[i + 1]! / LDU_STUD);
        for (let gz = Math.min(gz0, gz1); gz <= Math.max(gz0, gz1); gz++) {
          cells.push([gx, gy, gz] as const);
        }
      }
    }
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

    const block = resolveColor(brick.color);
    if (isDefaultFn && !(brick.color in LDRAW_COLOR_TO_BLOCK)) {
      unmappedColorSet.add(brick.color);
    }

    const localTris = partGeomCache.get(normId(brick.part));
    if (!localTris || localTris.length === 0) {
      fallbackPartCount++;
      continue;
    }

    const R = brick.rot ?? IDENTITY;
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
