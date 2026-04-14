/**
 * Cropping, footprint masking, and polygon enforcement utilities.
 *
 * Functions for center/rect/AABB cropping, ground plane removal,
 * OSM footprint masking, alignment, and polygon enforcement.
 * Split from spatial.ts.
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR } from './_internal.js';

// ═══════════════════════════════════════════════════════════════════════════
// Cropping utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crop grid to keep only blocks within a given XZ radius from the center.
 *
 * Useful for isolating the central building when the capture radius grabs
 * neighboring structures. Uses circular (Euclidean) XZ distance from grid center.
 *
 * @param grid     Mutable BlockGrid
 * @param radius   Max XZ distance from center to keep (in blocks)
 * @returns Number of blocks removed
 */
export function cropToCenter(grid: BlockGrid, radius: number): number {

  const { width, height, length } = grid;
  const cx = Math.floor(width / 2);
  const cz = Math.floor(length / 2);
  const r2 = radius * radius;
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        const dx = x - cx;
        const dz = z - cz;
        if (dx * dx + dz * dz > r2) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Crop grid to a rectangular area centered on the grid center.
 * Unlike circular cropToCenter, this preserves straight edges and right angles
 * which is critical for building geometry appearance.
 *
 * @param grid     Mutable BlockGrid
 * @param radius   Half-width of the rectangle in blocks (same as cropToCenter's radius)
 * @returns Number of blocks removed
 */
export function cropToRect(grid: BlockGrid, radius: number): number {

  const { width, height, length } = grid;
  const cx = Math.floor(width / 2);
  const cz = Math.floor(length / 2);
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (Math.abs(x - cx) > radius || Math.abs(z - cz) > radius) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Crop grid to an axis-aligned bounding box (AABB).
 * Unlike circular cropToCenter, this preserves rectangular/triangular shapes.
 * Keeps blocks within [minX..maxX, minZ..maxZ] and removes everything outside.
 *
 * @param grid     Mutable BlockGrid
 * @param minX     Min X boundary (inclusive)
 * @param maxX     Max X boundary (inclusive)
 * @param minZ     Min Z boundary (inclusive)
 * @param maxZ     Max Z boundary (inclusive)
 * @param margin   Extra blocks around the AABB to keep (default: 2)
 * @returns Number of blocks removed
 */
export function cropToAABB(
  grid: BlockGrid, minX: number, maxX: number, minZ: number, maxZ: number, margin = 2,
): number {

  const { width, height, length } = grid;
  const lo_x = Math.max(0, minX - margin);
  const hi_x = Math.min(width - 1, maxX + margin);
  const lo_z = Math.max(0, minZ - margin);
  const hi_z = Math.min(length - 1, maxZ + margin);
  let removed = 0;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (x < lo_x || x > hi_x || z < lo_z || z > hi_z) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Ground plane removal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove ground plane and terrain below a building.
 *
 * For each XZ column, finds the lowest non-air Y ("ground height").
 * Computes the median ground height as the ground plane level.
 * Removes all blocks at or below (groundPlaneY + margin) for columns
 * whose ground height is within tolerance of the median.
 * This strips flat terrain without removing building foundations on slopes.
 *
 * @param grid     Mutable BlockGrid
 * @param margin   Extra layers above ground plane to remove (default: 1)
 * @returns Object with removed count and detected ground Y
 */
export function removeGroundPlane(
  grid: BlockGrid, margin = 1,
): { removed: number; groundY: number } {

  const { width, height, length } = grid;

  // Find lowest non-air Y for each XZ column
  const groundHeights: number[] = [];
  const columnGround: number[][] = []; // [x, z, groundY]
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          groundHeights.push(y);
          columnGround.push([x, z, y]);
          break;
        }
      }
    }
  }

  if (groundHeights.length === 0) return { removed: 0, groundY: 0 };

  // Low percentile ground height = ground plane level.
  // Median fails when a hollow building shell covers >50% of footprint — the
  // lowest solid block for interior columns is the roof, making median = roof height,
  // which deletes the entire building. 10th percentile ignores noise while finding
  // the true ground level even when the building dominates the footprint.
  const sorted = [...groundHeights].sort((a, b) => a - b);
  const groundY = sorted[Math.floor(sorted.length * 0.10)];
  const cutY = groundY + margin;

  // Remove blocks at or below cutY for columns near the ground plane.
  // Columns whose ground height is far above the 10th-percentile ground level
  // are building walls extending down — don't strip those.
  let removed = 0;
  const tolerance = 3; // columns with ground height > groundY + tolerance are kept
  for (const [x, z, colGround] of columnGround) {
    if (colGround > groundY + tolerance) continue;
    for (let y = 0; y <= Math.min(cutY, height - 1); y++) {
      if (grid.get(x, y, z) !== AIR) {
        grid.set(x, y, z, AIR);
        removed++;
      }
    }
  }

  return { removed, groundY };
}

/**
 * Adaptively remove ground plane and thick terrain layers below a building.
 *
 * The standard `removeGroundPlane()` uses a fixed 10th-percentile column ground
 * height with a +1 margin, which fails on sloped terrain or thick ground planes
 * (2-5 block terrain slabs from photogrammetry). This function analyzes fill ratio
 * per Y-level to detect where the ground plane transitions into building structure.
 *
 * Algorithm:
 * 1. For each Y level from 0 upward, count solid blocks and compute fill ratio
 *    (solidCount / width * length).
 * 2. A Y level is classified as ground if its fill ratio exceeds `footprintThreshold`
 *    AND the next Y level's fill ratio drops below half the current level's ratio.
 *    This detects the sharp density transition from terrain to building walls.
 * 3. All blocks at and below the detected ground Y are removed.
 *
 * @param grid                 Mutable BlockGrid
 * @param footprintThreshold   Minimum fill ratio to consider a layer as ground (default: 0.4)
 * @returns Number of blocks removed
 */
export function removeGroundPlaneAdaptive(
  grid: BlockGrid,
  footprintThreshold = 0.4,
): number {
  const { width, height, length } = grid;
  const area = width * length;
  if (area === 0) return 0;

  // Compute fill ratio for each Y level
  const fillRatios = new Float64Array(height);
  const solidCounts = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) count++;
      }
    }
    solidCounts[y] = count;
    fillRatios[y] = count / area;
  }

  // Find the ground Y: the highest Y where fill ratio > threshold AND
  // the next Y level's ratio drops below 50% of current (sharp transition).
  // Scan from bottom up to find the transition point.
  let groundY = -1;
  for (let y = 0; y < height - 1; y++) {
    if (fillRatios[y] < footprintThreshold) continue;
    // Check if next level has a significant density drop
    const nextRatio = fillRatios[y + 1];
    if (nextRatio < fillRatios[y] * 0.5) {
      groundY = y;
      break; // Take the FIRST sharp transition — avoids destroying interior floors
    }
  }

  if (groundY < 0) return 0;

  // Remove all blocks at and below the detected ground Y
  let removed = 0;
  for (let y = 0; y <= groundY; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// OSM footprint masking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal CoordinateBitmap for internal use (avoids circular import).
 * Same bit-packed logic as src/gen/coordinate-bitmap.ts.
 */
export class CoordinateBitmapImpl {
  private bits: Uint8Array;
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly height: number;
  private _count = 0;

  constructor(minX: number, maxX: number, minZ: number, maxZ: number) {
    this.minX = minX; this.minZ = minZ;
    this.width = maxX - minX + 1;
    this.height = maxZ - minZ + 1;
    this.bits = new Uint8Array(Math.ceil(this.width * this.height / 8));
  }

  get count(): number { return this._count; }

  set(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    const mask = 1 << (i & 7);
    if ((this.bits[i >> 3] & mask) !== 0) return false;
    this.bits[i >> 3] |= mask;
    this._count++;
    return true;
  }

  contains(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    return ((this.bits[i >> 3] >> (i & 7)) & 1) === 1;
  }

  clear(x: number, z: number): boolean {
    const lx = x - this.minX, lz = z - this.minZ;
    if (lx < 0 || lx >= this.width || lz < 0 || lz >= this.height) return false;
    const i = lz * this.width + lx;
    const mask = 1 << (i & 7);
    if ((this.bits[i >> 3] & mask) === 0) return false;
    this.bits[i >> 3] &= ~mask;
    this._count--;
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Shared helpers (extracted from 4 duplicate implementations)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Project lat/lon polygon to block coordinates with optional rotation.
 * Shared by maskToFootprint, maskToFootprintAligned, enforceFootprintPolygon,
 * and alignOSMToFootprint.
 *
 * @param polygon     Array of {lat, lon} vertices
 * @param centerLat   Center latitude (capture/address coords)
 * @param centerLng   Center longitude (capture/address coords)
 * @param resolution  Blocks per meter (scales projection)
 * @param rotationAngle  Radians to rotate polygon (PCA alignment, default 0)
 * @param round       Whether to Math.round the output coordinates (default true)
 * @returns Array of {x, z} block coordinates
 */
export function projectPolygonToBlocks(
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  resolution: number,
  rotationAngle: number,
  round = true,
): { x: number; z: number }[] {
  const latScale = 111320 * resolution; // meters per degree × blocks per meter
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;
  let pts = polygon.map(p => ({
    x: (p.lon - centerLng) * lonScale,
    z: (centerLat - p.lat) * latScale, // flip: grid Z = south
  }));
  if (Math.abs(rotationAngle) > 0.01) {
    const cos = Math.cos(-rotationAngle);
    const sin = Math.sin(-rotationAngle);
    pts = pts.map(p => ({
      x: p.x * cos - p.z * sin,
      z: p.x * sin + p.z * cos,
    }));
  }
  if (round) {
    pts = pts.map(p => ({ x: Math.round(p.x), z: Math.round(p.z) }));
  }
  return pts;
}

/**
 * Rasterize a closed polygon into a CoordinateBitmapImpl using winding-number scanline fill.
 * The polygon must be auto-closed (first vertex === last vertex).
 *
 * @param blockPts  Closed polygon vertices (first === last)
 * @param minX      Bitmap min X bound (inclusive)
 * @param maxX      Bitmap max X bound (inclusive)
 * @param minZ      Bitmap min Z bound (inclusive)
 * @param maxZ      Bitmap max Z bound (inclusive)
 * @returns Populated bitmap with interior cells set
 */
export function rasterizePolygonToBitmap(
  blockPts: { x: number; z: number }[],
  minX: number, maxX: number, minZ: number, maxZ: number,
): CoordinateBitmapImpl {
  const bitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: { x: number; dir: 1 | -1 }[] = [];
    for (let i = 0; i < blockPts.length - 1; i++) {
      const a = blockPts[i], b = blockPts[i + 1];
      if (a.z === b.z) continue;
      const eMinZ = Math.min(a.z, b.z), eMaxZ = Math.max(a.z, b.z);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
      const t = (scanZ - a.z) / (b.z - a.z);
      intercepts.push({ x: a.x + t * (b.x - a.x), dir: a.z < b.z ? 1 : -1 });
    }
    intercepts.sort((a, b) => a.x - b.x);
    let winding = 0, idx = 0;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      while (idx < intercepts.length && intercepts[idx].x <= cx) {
        winding += intercepts[idx].dir;
        idx++;
      }
      if (winding !== 0) bitmap.set(x, z);
    }
  }
  return bitmap;
}

/**
 * Rasterize polygon to a Set of "x,z" strings (for IoU comparison).
 * Unlike rasterizePolygonToBitmap, this takes floating-point points with an offset,
 * rounds them internally, and returns a Set<string> for set intersection/union.
 *
 * @param pts  Polygon vertices (NOT necessarily closed; wraps using modular indexing)
 * @param ox   X offset to apply after rounding
 * @param oz   Z offset to apply after rounding
 * @returns Set of "x,z" cell keys
 */
export function rasterizePolygonToSet(
  pts: { x: number; z: number }[],
  ox: number, oz: number,
): Set<string> {
  // Compute rounded bounds with offset
  let minZ = Infinity, maxZ = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of pts) {
    const rz = Math.round(p.z) + oz;
    const rx = Math.round(p.x) + ox;
    if (rz < minZ) minZ = rz;
    if (rz > maxZ) maxZ = rz;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
  }
  const cells = new Set<string>();
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: { x: number; dir: 1 | -1 }[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const az = Math.round(a.z) + oz, bz = Math.round(b.z) + oz;
      const ax = Math.round(a.x) + ox, bx = Math.round(b.x) + ox;
      if (az === bz) continue;
      const eMinZ = Math.min(az, bz), eMaxZ = Math.max(az, bz);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;
      // Use rounded coords consistently for both boundary test and interpolation
      const t = (scanZ - az) / (bz - az);
      intercepts.push({ x: ax + t * (bx - ax), dir: az < bz ? 1 : -1 });
    }
    intercepts.sort((a, b) => a.x - b.x);
    let winding = 0, idx = 0;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      while (idx < intercepts.length && intercepts[idx].x <= cx) {
        winding += intercepts[idx].dir;
        idx++;
      }
      if (winding !== 0) cells.add(`${x},${z}`);
    }
  }
  return cells;
}

/**
 * Morphological close on a bitmap: dilate then erode by `radius`.
 * Uses circular structuring element (Euclidean distance ≤ radius).
 * Fills internal gaps without expanding the footprint boundary.
 * Complexity: O(N × r²) where N = bitmap area — fine for typical radii (1-5).
 *
 * @param bitmap  Mutable bitmap to close
 * @param minX    Bitmap min X bound
 * @param maxX    Bitmap max X bound
 * @param minZ    Bitmap min Z bound
 * @param maxZ    Bitmap max Z bound
 * @param radius  Dilation/erosion radius in blocks
 */
export function morphCloseBitmap(
  bitmap: CoordinateBitmapImpl,
  minX: number, maxX: number, minZ: number, maxZ: number,
  radius: number,
): void {
  if (radius <= 0 || bitmap.count === 0) return;

  // Step 1: Dilate (expand by radius blocks)
  const original: [number, number][] = [];
  for (let lz = 0; lz <= maxZ - minZ; lz++) {
    for (let lx = 0; lx <= maxX - minX; lx++) {
      const x = lx + minX, z = lz + minZ;
      if (bitmap.contains(x, z)) original.push([x, z]);
    }
  }
  const r2 = radius * radius;
  for (const [ox, oz] of original) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > r2) continue; // circular structuring element
        bitmap.set(ox + dx, oz + dz);
      }
    }
  }

  // Step 2: Erode (shrink by radius blocks) — completes morphological close.
  // A cell survives erosion only if ALL cells within radius are set.
  const toRemove: [number, number][] = [];
  for (let lz = 0; lz <= maxZ - minZ; lz++) {
    for (let lx = 0; lx <= maxX - minX; lx++) {
      const x = lx + minX, z = lz + minZ;
      if (!bitmap.contains(x, z)) continue;
      let allSet = true;
      for (let ez = -radius; ez <= radius && allSet; ez++) {
        for (let ex = -radius; ex <= radius && allSet; ex++) {
          if (ex * ex + ez * ez > r2) continue; // circular structuring element
          if (!bitmap.contains(x + ex, z + ez)) allSet = false;
        }
      }
      if (!allSet) toRemove.push([x, z]);
    }
  }
  for (const [rx, rz] of toRemove) {
    bitmap.clear(rx, rz);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OSM footprint masking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mask a BlockGrid to an OSM building footprint polygon.
 *
 * Projects the OSM polygon to block coordinates centered on the capture point
 * (address lat/lng), rasterizes to a 2D bitmap, dilates by a margin, then
 * clears all grid blocks outside the footprint at every Y layer.
 *
 * Coordinate mapping:
 * - Grid center (W/2, L/2) = capture center (address lat/lng)
 * - Grid X ≈ East (ENU capture frame), Grid Z ≈ South (Three.js convention)
 * - Polygon lon → X (east offset), polygon lat → -Z (north flipped to south)
 *
 * @param grid       Mutable BlockGrid
 * @param polygon    OSM building polygon vertices as {lat, lon}[]
 * @param centerLat  Capture center latitude (address coords)
 * @param centerLng  Capture center longitude (address coords)
 * @param dilate     Expand footprint by this many blocks in each direction (default 3)
 * @param resolution Blocks per meter (default 1) — scales polygon projection to grid units
 * @param rotationAngle Radians to rotate polygon (PCA horizontal alignment angle, default 0)
 * @returns Number of blocks removed
 */
export function maskToFootprint(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  dilate = 3,
  resolution = 1,
  rotationAngle = 0,
): number {
  if (polygon.length < 3) return 0;

  const { width, height, length } = grid;

  // Project polygon to block coords centered on capture point (M4 dedup: shared helper)
  let blockPts = projectPolygonToBlocks(polygon, centerLat, centerLng, resolution, rotationAngle);

  // Auto-close polygon if needed
  const first = blockPts[0];
  const last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) {
    blockPts.push({ x: first.x, z: first.z });
  }

  // Compute bitmap bounds with dilation margin
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of blockPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX -= dilate; maxX += dilate;
  minZ -= dilate; maxZ += dilate;

  // Scanline fill the polygon into a bitmap (M4 dedup: shared helper)
  const bitmap = rasterizePolygonToBitmap(blockPts, minX, maxX, minZ, maxZ);

  // Morphological close: dilate then erode by same amount (M4 dedup: shared helper)
  morphCloseBitmap(bitmap, minX, maxX, minZ, maxZ, dilate);

  // Map grid XZ to bitmap coords and mask. Grid center = bitmap (0,0).
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);

  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        const bx = x - gridCx;
        const bz = z - gridCz;
        if (!bitmap.contains(bx, bz)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// v95: Advanced building isolation — 3-tier strategy for fused meshes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a combined alignment score from IoU, centroid distance, and coverage.
 *
 * IoU alone penalizes size mismatches even with perfect placement and fails on
 * L-shaped/complex buildings. This three-metric composite is more robust:
 *  - IoU:            standard intersection-over-union (penalizes false positives & negatives)
 *  - Centroid score:  1 − (centroid_dist / building_extent), rewards spatial overlap
 *  - Coverage score:  fraction of voxel footprint cells covered by OSM mask (recall)
 *
 * @param osmCells     Rasterized OSM polygon cell keys ("x,z")
 * @param voxelFoot    Voxel footprint cell keys ("x,z")
 * @param voxelExtent  Diagonal extent of voxel footprint in blocks (for normalizing centroid dist)
 * @returns Object with iou, centroidScore, coverageScore, and combined score
 */
function computeAlignmentScore(
  osmCells: Set<string>,
  voxelFoot: Set<string>,
  voxelExtent: number,
): { iou: number; centroidScore: number; coverageScore: number; combined: number } {
  if (osmCells.size === 0 || voxelFoot.size === 0) {
    return { iou: 0, centroidScore: 0, coverageScore: 0, combined: 0 };
  }

  // IoU
  let intersection = 0;
  for (const key of osmCells) {
    if (voxelFoot.has(key)) intersection++;
  }
  const union = voxelFoot.size + osmCells.size - intersection;
  const iou = union > 0 ? intersection / union : 0;

  // Centroid distance score: compute centroids of both sets, normalize distance by extent
  let osmSumX = 0, osmSumZ = 0;
  for (const key of osmCells) {
    const comma = key.indexOf(',');
    osmSumX += parseInt(key.substring(0, comma), 10);
    osmSumZ += parseInt(key.substring(comma + 1), 10);
  }
  let voxSumX = 0, voxSumZ = 0;
  for (const key of voxelFoot) {
    const comma = key.indexOf(',');
    voxSumX += parseInt(key.substring(0, comma), 10);
    voxSumZ += parseInt(key.substring(comma + 1), 10);
  }
  const osmCx = osmSumX / osmCells.size;
  const osmCz = osmSumZ / osmCells.size;
  const voxCx = voxSumX / voxelFoot.size;
  const voxCz = voxSumZ / voxelFoot.size;
  const centroidDist = Math.hypot(osmCx - voxCx, osmCz - voxCz);
  const normExtent = Math.max(voxelExtent, 1); // prevent division by zero
  const centroidScore = Math.max(0, 1 - centroidDist / normExtent);

  // Coverage score: fraction of voxel footprint cells that overlap with OSM mask (recall)
  const coverageScore = voxelFoot.size > 0 ? intersection / voxelFoot.size : 0;

  // Combined score: weighted average of all three metrics
  const combined = 0.4 * iou + 0.3 * centroidScore + 0.3 * coverageScore;

  return { iou, centroidScore, coverageScore, combined };
}

/**
 * Rotate polygon points around their centroid by a given angle (radians).
 *
 * @param pts   Polygon vertices (floating-point block coords)
 * @param angle Rotation angle in radians (positive = counter-clockwise)
 * @returns New array of rotated points
 */
function rotatePolygonPoints(
  pts: { x: number; z: number }[],
  angle: number,
): { x: number; z: number }[] {
  if (Math.abs(angle) < 1e-9) return pts;

  // Compute centroid
  let cx = 0, cz = 0;
  for (const p of pts) { cx += p.x; cz += p.z; }
  cx /= pts.length;
  cz /= pts.length;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return pts.map(p => {
    const dx = p.x - cx;
    const dz = p.z - cz;
    return {
      x: cx + dx * cos - dz * sin,
      z: cz + dx * sin + dz * cos,
    };
  });
}

/**
 * Auto-align an OSM polygon to the voxel footprint using combined scoring.
 * Fixes geocoding drift that causes maskToFootprint to clip the entire building.
 *
 * Scoring uses a three-metric composite (IoU + centroid distance + coverage) which
 * is more robust than IoU alone for L-shaped buildings and size-mismatched polygons.
 *
 * Includes a small rotation search (+-5 deg in 1 deg steps) around the base rotation.
 * This catches buildings where OSM polygon orientation differs from Google 3D Tiles.
 *
 * @returns The best (dx, dz) offset and its combined score, or null if no good alignment found.
 */
export function alignOSMToFootprint(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  resolution = 1,
  rotationAngle = 0,
  searchRadius = 40,
  // Combined score threshold (replaces IoU-only threshold of 0.15).
  // The composite metric is more lenient than raw IoU since centroid/coverage
  // contribute even for poor overlap. 0.20 rejects truly misaligned polygons
  // while accepting correct placements that IoU alone would miss.
  minScore = 0.20,
  // v300: When BuildingAlignment provides precise rotation, tighter translation search suffices
  hasAlignment = false,
): { dx: number; dz: number; iou: number } | null {
  if (polygon.length < 3) return null;

  // v300: When alignment provides precise rotation, only need tight translation search
  const effectiveRadius = hasAlignment ? Math.min(searchRadius, 10) : searchRadius;

  const { width, length } = grid;

  // Build voxel footprint bitmask (XZ occupied columns)
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);
  const voxelFoot = new Set<string>();
  let vMinX = Infinity, vMaxX = -Infinity, vMinZ = Infinity, vMaxZ = -Infinity;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < grid.height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          const bx = x - gridCx;
          const bz = z - gridCz;
          voxelFoot.add(`${bx},${bz}`);
          if (bx < vMinX) vMinX = bx;
          if (bx > vMaxX) vMaxX = bx;
          if (bz < vMinZ) vMinZ = bz;
          if (bz > vMaxZ) vMaxZ = bz;
          break;
        }
      }
    }
  }
  if (voxelFoot.size === 0) return null;

  // Diagonal extent of voxel footprint (for normalizing centroid distance)
  const voxelExtent = Math.hypot(vMaxX - vMinX, vMaxZ - vMinZ);

  // Project polygon to block coords (unrounded for sub-block sliding)
  const blockPts = projectPolygonToBlocks(polygon, centerLat, centerLng, resolution, rotationAngle, false);

  // Best result tracking across all rotation + translation candidates
  let bestCombined = 0;
  let bestDx = 0, bestDz = 0;
  let bestIoU = 0;

  // Rotation search: +-5 degrees in 1-degree steps around the base rotation.
  // This catches buildings where OSM polygon is slightly rotated vs Google 3D Tiles.
  const DEG_TO_RAD = Math.PI / 180;
  const rotationSteps = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];

  for (const rotDeg of rotationSteps) {
    const rotRad = rotDeg * DEG_TO_RAD;
    // Rotate polygon around its centroid by the candidate offset
    const rotatedPts = rotatePolygonPoints(blockPts, rotRad);

    // Translation search within +-effectiveRadius
    for (let dz = -effectiveRadius; dz <= effectiveRadius; dz++) {
      for (let dx = -effectiveRadius; dx <= effectiveRadius; dx++) {
        const osmCells = rasterizePolygonToSet(rotatedPts, dx, dz);
        if (osmCells.size === 0) continue;

        const scores = computeAlignmentScore(osmCells, voxelFoot, voxelExtent);

        if (scores.combined > bestCombined) {
          bestCombined = scores.combined;
          bestIoU = scores.iou;
          bestDx = dx;
          bestDz = dz;
        }
      }
    }
  }

  if (bestCombined < minScore) return null;
  // Return iou field for backward compatibility (callers log it)
  return { dx: bestDx, dz: bestDz, iou: bestIoU };
}

/**
 * Apply maskToFootprint with a pre-computed alignment offset.
 * Shifts the polygon by (dx, dz) blocks before masking.
 */
export function maskToFootprintAligned(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  dilate: number,
  resolution: number,
  rotationAngle: number,
  dx: number,
  dz: number,
): number {
  if (polygon.length < 3) return 0;

  const { width, height, length } = grid;

  // H3 fix: project polygon to block coords WITHOUT offset first (M4 dedup: shared helper)
  let blockPts = projectPolygonToBlocks(polygon, centerLat, centerLng, resolution, rotationAngle);

  // H3 fix: apply alignment offset AFTER rotation so it's in grid-space, not geo-space.
  // Previously dx/dz was added before rotation, causing the offset vector itself to be
  // rotated, shifting the polygon away from the IoU-found position.
  blockPts = blockPts.map(p => ({ x: p.x + dx, z: p.z + dz }));

  // Auto-close
  const first = blockPts[0], last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) blockPts.push({ x: first.x, z: first.z });

  // Compute bounds with dilation
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of blockPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  minX -= dilate; maxX += dilate;
  minZ -= dilate; maxZ += dilate;

  // Scanline fill (M4 dedup: shared helper)
  const bitmap = rasterizePolygonToBitmap(blockPts, minX, maxX, minZ, maxZ);

  // H2 fix: full morphological close (dilate + erode), not dilate-only.
  // Previously only the dilate step was present, making the aligned mask
  // systematically larger than intended.
  morphCloseBitmap(bitmap, minX, maxX, minZ, maxZ, dilate);

  // Apply mask
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (!bitmap.contains(x - gridCx, z - gridCz)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Footprint polygon enforcement
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enforce a polygon footprint on the grid — clip blocks outside the polygon
 * AND fill empty columns inside the polygon to the building's median height.
 * Uses the building's centroid for polygon alignment (not grid center), which
 * fixes the offset caused by OSM pre-fill masking removing neighbors.
 *
 * v71: This gives sharp straight edges matching the real building outline,
 * overriding the photogrammetry mesh's rounded edges.
 */
export function enforceFootprintPolygon(
  grid: BlockGrid,
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  resolution = 1,
  rotationAngle = 0,
  wallBlock = 'minecraft:stone_bricks',
  roofBlock = 'minecraft:light_gray_concrete',
  /** Buffer in blocks around polygon for clip tolerance (0 = exact) */
  buffer = 2,
): { clipped: number; filled: number } {
  if (polygon.length < 3) return { clipped: 0, filled: 0 };

  const { width, height, length } = grid;

  // Compute building centroid — center of mass of occupied columns
  let centX = 0, centZ = 0, centCount = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          centX += x;
          centZ += z;
          centCount++;
          break;
        }
      }
    }
  }
  if (centCount === 0) return { clipped: 0, filled: 0 };
  centX = Math.round(centX / centCount);
  centZ = Math.round(centZ / centCount);

  // Compute median building height for fill
  const colHeights: number[] = [];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      let topY = -1;
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) { topY = y; break; }
      }
      if (topY >= 0) colHeights.push(topY);
    }
  }
  colHeights.sort((a, b) => a - b);
  const p75Height = colHeights[Math.floor(colHeights.length * 0.75)] ?? 10;

  // Project polygon to block coords centered on building centroid (M4 dedup: shared helper)
  let blockPts = projectPolygonToBlocks(polygon, centerLat, centerLng, resolution, rotationAngle);

  // M1 fix: compute polygon centroid BEFORE auto-close, so the duplicated closing vertex
  // doesn't bias the centroid toward the first vertex.
  let polyCx = 0, polyCz = 0;
  for (const p of blockPts) { polyCx += p.x; polyCz += p.z; }
  polyCx = Math.round(polyCx / blockPts.length);
  polyCz = Math.round(polyCz / blockPts.length);

  // Auto-close polygon
  const first = blockPts[0];
  const last = blockPts[blockPts.length - 1];
  if (first.x !== last.x || first.z !== last.z) {
    blockPts.push({ x: first.x, z: first.z });
  }

  // Shift polygon so its centroid aligns with building centroid in grid
  const shiftX = centX - polyCx;
  const shiftZ = centZ - polyCz;
  blockPts = blockPts.map(p => ({ x: p.x + shiftX, z: p.z + shiftZ }));

  // Clamp polygon vertices to grid bounds — points far outside can't affect voxels.
  // NOTE: per-vertex clamping can collapse edges for polygons extending well beyond
  // the grid. A proper Sutherland-Hodgman clip would preserve edge topology, but the
  // rasterizer handles degenerate edges (az===bz skipped), so this is safe in practice.
  blockPts = blockPts.map(p => ({
    x: Math.max(-1, Math.min(width, p.x)),
    z: Math.max(-1, Math.min(length, p.z)),
  }));

  // Scanline fill polygon into bitmap (no dilation — exact edges) (M4 dedup: shared helper)
  const minX = 0, maxX = width - 1, minZ = 0, maxZ = length - 1;
  const bitmap = rasterizePolygonToBitmap(blockPts, minX, maxX, minZ, maxZ);

  // Create dilated bitmap for clip tolerance (photogrammetry edges bleed 1-3 blocks
  // outside the exact OSM polygon). Core (un-dilated) bitmap used for fill decisions.
  const clipBitmap = new CoordinateBitmapImpl(minX, maxX, minZ, maxZ);
  // Copy core into clip bitmap
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      if (bitmap.contains(x, z)) clipBitmap.set(x, z);
    }
  }
  if (buffer > 0) {
    // Dilate clip bitmap
    const toSet: Array<[number, number]> = [];
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        if (!bitmap.contains(x, z)) continue;
        for (let dz = -buffer; dz <= buffer; dz++) {
          for (let dx = -buffer; dx <= buffer; dx++) {
            const nx = x + dx, nz = z + dz;
            if (nx >= minX && nx <= maxX && nz >= minZ && nz <= maxZ) {
              toSet.push([nx, nz]);
            }
          }
        }
      }
    }
    for (const [x, z] of toSet) clipBitmap.set(x, z);
  }

  // Build occupied-column bitmap (before clipping) for proximity-gated fill
  const occupiedCol = new Uint8Array(width * length);
  let existingBlockCount = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          occupiedCol[z * width + x] = 1;
          existingBlockCount++;
          break;
        }
      }
    }
  }

  // v71b: Skip clipping — the pre-fill OSM mask already removed neighbors.
  // Clipping here destroys legitimate building geometry that extends slightly
  // beyond the OSM polygon (wing connectors, overhangs, bay windows).
  const clipped = 0;

  // Fill empty columns inside core polygon — proximity-gated.
  // Only fill columns adjacent (within 2 blocks) to existing occupied columns
  // to prevent massive fills for partial captures (e.g. Dakota corner-only).
  // Also cap total fill to 30% of existing block count.
  const fillCap = Math.floor(existingBlockCount * 0.30);
  let filled = 0;
  for (let z = 0; z < length && filled < fillCap; z++) {
    for (let x = 0; x < width && filled < fillCap; x++) {
      if (!bitmap.contains(x, z)) continue; // Outside core polygon
      // Skip already-occupied columns
      if (occupiedCol[z * width + x]) continue;
      // Proximity gate: require occupied neighbor within 2 blocks
      let hasNeighbor = false;
      for (let dz = -2; dz <= 2 && !hasNeighbor; dz++) {
        for (let dx = -2; dx <= 2 && !hasNeighbor; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (occupiedCol[nz * width + nx]) hasNeighbor = true;
          }
        }
      }
      if (!hasNeighbor) continue;
      // Fill to median height
      for (let y = 0; y < p75Height; y++) {
        grid.set(x, y, z, wallBlock);
        filled++;
      }
      grid.set(x, p75Height, z, roofBlock);
      filled++;
    }
  }

  return { clipped, filled };
}
