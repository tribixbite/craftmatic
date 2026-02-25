/**
 * CoordinateBitmap — memory-efficient 2D bit-array for block occupancy.
 *
 * Rasterizes OSM building polygons into a grid of occupied/empty blocks
 * using scanline fill. Replaces the heuristic L/T/U shape classification
 * with pixel-perfect footprint masks.
 *
 * Inspired by Arnis floodfill_cache.rs:CoordinateBitmap.
 * Memory: ~3 KB for a 150×150 block area (vs ~270 KB in a Set).
 */

/** 2D point in block-space (integer x, z) */
export interface BlockPoint {
  x: number;
  z: number;
}

/**
 * Bit-packed 2D occupancy grid. Stores 1 bit per (x, z) coordinate,
 * offset by (minX, minZ) to allow negative coordinates.
 */
export class CoordinateBitmap {
  private bits: Uint8Array;
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly height: number;
  private _count: number;

  constructor(minX: number, maxX: number, minZ: number, maxZ: number) {
    this.minX = minX;
    this.minZ = minZ;
    this.width = maxX - minX + 1;
    this.height = maxZ - minZ + 1;
    const numBits = this.width * this.height;
    this.bits = new Uint8Array(Math.ceil(numBits / 8));
    this._count = 0;
  }

  /** Number of set coordinates */
  get count(): number {
    return this._count;
  }

  /** Mark (x, z) as occupied. Returns true if newly set. */
  set(x: number, z: number): boolean {
    const localX = x - this.minX;
    const localZ = z - this.minZ;
    if (localX < 0 || localX >= this.width || localZ < 0 || localZ >= this.height) return false;
    const bitIndex = localZ * this.width + localX;
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    if ((this.bits[byteIndex] & mask) !== 0) return false;
    this.bits[byteIndex] |= mask;
    this._count++;
    return true;
  }

  /** Clear (x, z). Returns true if was previously set. */
  clear(x: number, z: number): boolean {
    const localX = x - this.minX;
    const localZ = z - this.minZ;
    if (localX < 0 || localX >= this.width || localZ < 0 || localZ >= this.height) return false;
    const bitIndex = localZ * this.width + localX;
    const byteIndex = bitIndex >> 3;
    const mask = 1 << (bitIndex & 7);
    if ((this.bits[byteIndex] & mask) === 0) return false;
    this.bits[byteIndex] &= ~mask;
    this._count--;
    return true;
  }

  /** Check if (x, z) is occupied */
  contains(x: number, z: number): boolean {
    const localX = x - this.minX;
    const localZ = z - this.minZ;
    if (localX < 0 || localX >= this.width || localZ < 0 || localZ >= this.height) return false;
    const bitIndex = localZ * this.width + localX;
    return ((this.bits[bitIndex >> 3] >> (bitIndex & 7)) & 1) === 1;
  }

  /** Iterate all set coordinates. Yields [x, z] pairs. */
  *entries(): Generator<[number, number]> {
    for (let lz = 0; lz < this.height; lz++) {
      for (let lx = 0; lx < this.width; lx++) {
        const bitIndex = lz * this.width + lx;
        if (((this.bits[bitIndex >> 3] >> (bitIndex & 7)) & 1) === 1) {
          yield [lx + this.minX, lz + this.minZ];
        }
      }
    }
  }

  /**
   * Get axis-aligned bounding box of set bits.
   * Returns null if bitmap is empty.
   */
  bounds(): { minX: number; maxX: number; minZ: number; maxZ: number } | null {
    if (this._count === 0) return null;
    let bMinX = Infinity, bMaxX = -Infinity;
    let bMinZ = Infinity, bMaxZ = -Infinity;
    for (const [x, z] of this.entries()) {
      if (x < bMinX) bMinX = x;
      if (x > bMaxX) bMaxX = x;
      if (z < bMinZ) bMinZ = z;
      if (z > bMaxZ) bMaxZ = z;
    }
    return { minX: bMinX, maxX: bMaxX, minZ: bMinZ, maxZ: bMaxZ };
  }
}

// ─── Scanline Polygon Fill ─────────────────────────────────────────────────

/**
 * Scanline fill a polygon into a CoordinateBitmap.
 * Uses ray-casting (even-odd rule): for each block (x, z), cast a ray
 * and count edge crossings to determine inside/outside.
 *
 * Optimized with scanline approach — for each row z, find all x-intercepts,
 * sort them, and fill between pairs. O(edges × height).
 *
 * For building footprints, we test at block centers (x+0.5, z+0.5) but
 * expand the polygon by a half-block margin to ensure blocks touching the
 * boundary are included — buildings should fill their full footprint.
 *
 * @param vertices Polygon vertices in block-space (integer x, z). Must be closed
 *   (first vertex == last vertex) or will be auto-closed.
 * @returns CoordinateBitmap with all interior+boundary blocks marked
 */
export function scanlineFill(vertices: BlockPoint[]): CoordinateBitmap {
  if (vertices.length < 3) {
    return new CoordinateBitmap(0, 0, 0, 0);
  }

  // Auto-close if needed
  const pts = [...vertices];
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.x !== last.x || first.z !== last.z) {
    pts.push({ x: first.x, z: first.z });
  }

  // Compute bounds
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  const bitmap = new CoordinateBitmap(minX, maxX, minZ, maxZ);
  const edgeCount = pts.length - 1;

  // For each scanline row z, test at half-integer y = z + 0.5 to determine
  // which blocks are inside. Polygon vertices are integers representing block
  // coordinates. We sample at block centers for robust even-odd classification.
  for (let z = minZ; z <= maxZ; z++) {
    const scanZ = z + 0.5;
    const intercepts: number[] = [];

    for (let i = 0; i < edgeCount; i++) {
      const a = pts[i];
      const b = pts[i + 1];

      // Skip horizontal edges
      if (a.z === b.z) continue;

      // Edge spans [min, max) in z — check if scanline z+0.5 crosses
      const eMinZ = Math.min(a.z, b.z);
      const eMaxZ = Math.max(a.z, b.z);
      if (scanZ <= eMinZ || scanZ > eMaxZ) continue;

      // Compute x-intercept via linear interpolation
      const t = (scanZ - a.z) / (b.z - a.z);
      const xIntercept = a.x + t * (b.x - a.x);
      intercepts.push(xIntercept);
    }

    // Sort intercepts and fill between pairs (even-odd rule)
    intercepts.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intercepts.length; i += 2) {
      // Include blocks whose center x+0.5 falls between intercepts
      const xStart = Math.floor(intercepts[i]);
      const xEnd = Math.ceil(intercepts[i + 1]) - 1;
      for (let x = xStart; x <= xEnd; x++) {
        bitmap.set(x, z);
      }
    }
  }

  return bitmap;
}

// ─── Polygon Projection ───────────────────────────────────────────────────

/**
 * Project lat/lon polygon vertices to block-space integer coordinates.
 * Each block ≈ 1 meter. Origin is placed at polygon centroid so the bitmap
 * is centered around (0, 0).
 *
 * @param polygon OSM polygon vertices (lat/lon, closed or unclosed)
 * @returns Block-space vertices suitable for scanlineFill()
 */
export function projectPolygonToBlocks(
  polygon: { lat: number; lon: number }[],
): BlockPoint[] {
  if (polygon.length < 3) return [];

  // Centroid for projection reference
  const centerLat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
  const centerLon = polygon.reduce((s, p) => s + p.lon, 0) / polygon.length;

  // Meters per degree at this latitude
  const latScale = 111320;
  const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180);

  // Project to meters relative to centroid, then round to blocks
  return polygon.map(p => ({
    x: Math.round((p.lon - centerLon) * lonScale),
    z: Math.round((p.lat - centerLat) * latScale),
  }));
}

/**
 * Full pipeline: lat/lon polygon → projected block coords → scanline filled bitmap.
 *
 * @param polygon OSM building polygon vertices
 * @returns CoordinateBitmap with the building footprint filled, or null if
 *   polygon is too small (< 3 vertices)
 */
export function polygonToBitmap(
  polygon: { lat: number; lon: number }[],
): CoordinateBitmap | null {
  const blockPts = projectPolygonToBlocks(polygon);
  if (blockPts.length < 3) return null;
  return scanlineFill(blockPts);
}

/**
 * Subtract inner rings (courtyards) from an outer ring bitmap.
 * Used for OSM multipolygon relations where inner roles represent holes.
 *
 * @param outer The filled outer ring bitmap
 * @param innerPolygons Array of inner ring lat/lon polygons
 */
export function subtractInnerRings(
  outer: CoordinateBitmap,
  innerPolygons: { lat: number; lon: number }[][],
): void {
  for (const inner of innerPolygons) {
    const innerBitmap = polygonToBitmap(inner);
    if (!innerBitmap) continue;
    for (const [x, z] of innerBitmap.entries()) {
      outer.clear(x, z);
    }
  }
}

/**
 * Classify a bitmap's shape by analyzing its fill ratio and geometry.
 * More accurate than vertex-count heuristics because it operates on
 * the actual rasterized footprint.
 *
 * @param bitmap Filled footprint bitmap
 * @returns Detected floor plan shape
 */
export function classifyBitmapShape(
  bitmap: CoordinateBitmap,
): 'rect' | 'L' | 'T' | 'U' {
  const b = bitmap.bounds();
  if (!b) return 'rect';

  const bboxW = b.maxX - b.minX + 1;
  const bboxH = b.maxZ - b.minZ + 1;
  const bboxArea = bboxW * bboxH;
  if (bboxArea <= 0) return 'rect';

  const fillRatio = bitmap.count / bboxArea;

  // High fill ratio → rectangular
  if (fillRatio > 0.88) return 'rect';

  // Analyze quadrant fill to distinguish L/T/U:
  // Divide bounding box into 4 quadrants and count filled blocks in each
  const midX = Math.floor((b.minX + b.maxX) / 2);
  const midZ = Math.floor((b.minZ + b.maxZ) / 2);
  const quadCounts = [0, 0, 0, 0]; // NW, NE, SW, SE
  for (const [x, z] of bitmap.entries()) {
    const qi = (z > midZ ? 2 : 0) + (x > midX ? 1 : 0);
    quadCounts[qi]++;
  }

  const maxQ = Math.max(...quadCounts);
  const emptyThreshold = maxQ * 0.25; // quadrant considered "empty" if < 25% of largest
  const emptyQuadrants = quadCounts.filter(c => c < emptyThreshold).length;

  // 2 empty quadrants on same side → U-shape
  if (emptyQuadrants >= 2) return 'U';
  // 1 empty quadrant → L or T
  if (emptyQuadrants === 1) {
    // T-shape: empty quadrant is adjacent to a filled one on both sides
    // L-shape: empty quadrant is a corner
    // Heuristic: if the bitmap is roughly symmetric about one axis, it's T
    const nw = quadCounts[0], ne = quadCounts[1];
    const sw = quadCounts[2], se = quadCounts[3];
    const xSymmetry = Math.abs((nw + sw) - (ne + se)) / bitmap.count;
    const zSymmetry = Math.abs((nw + ne) - (sw + se)) / bitmap.count;
    if (xSymmetry < 0.15 || zSymmetry < 0.15) return 'T';
    return 'L';
  }

  // Low fill ratio but no empty quadrants → irregular, treat as L
  if (fillRatio < 0.75) return 'L';

  return 'rect';
}
