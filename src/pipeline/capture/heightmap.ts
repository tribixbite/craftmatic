/**
 * Heightmap rasterization + bbox measurement — pure functions.
 *
 * Extracted from `scripts/tiles-headless.ts` lines 551-611 so the new
 * `captureTiles()` (Chunk 2 Task 2.2) and `refineContextWithTiles()`
 * (Chunk 1, already consuming the same shape) can share the math.
 *
 * All inputs are typed arrays + pre-computed bounds — nothing Three-specific.
 * The consumer is responsible for walking its mesh graph and calling
 * `addPositionsToHeightmap()` once per mesh.
 */

export interface HeightmapBbox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface HeightmapState {
  readonly width: number;
  readonly length: number;
  readonly bbox: HeightmapBbox;
  /** Y value (min seen) at each XZ cell. */
  readonly heights: Float32Array;
  /** 1 where we have data, 0 where untouched. */
  readonly counts: Uint8Array;
  /** Max samples-per-metre. 1 = 1m per cell. */
  readonly resolution: number;
}

export interface HeightmapLimits {
  readonly maxDim: number;   // default 1024
}

/**
 * Create an empty heightmap sized to the bbox.  `resolution` = cells per metre.
 * Returns `null` if either dimension exceeds `limits.maxDim` (prevents GPU OOM).
 */
export function createHeightmapState(
  bbox: HeightmapBbox,
  resolution = 1,
  limits: HeightmapLimits = { maxDim: 1024 },
): HeightmapState | null {
  const width = Math.ceil((bbox.maxX - bbox.minX) * resolution);
  const length = Math.ceil((bbox.maxZ - bbox.minZ) * resolution);
  if (width <= 0 || length <= 0) return null;
  if (width > limits.maxDim || length > limits.maxDim) return null;
  return {
    width,
    length,
    bbox,
    heights: new Float32Array(width * length),
    counts: new Uint8Array(width * length),
    resolution,
  };
}

/**
 * Add a batch of vertex positions (flat Float32Array, [x0,y0,z0, x1,y1,z1, …])
 * to the heightmap. Keeps the minimum Y at each XZ cell.
 */
export function addPositionsToHeightmap(
  state: HeightmapState,
  positions: Float32Array,
): void {
  const { heights, counts, width, length, bbox, resolution } = state;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    const px = Math.floor((x - bbox.minX) * resolution);
    const pz = Math.floor((z - bbox.minZ) * resolution);
    if (px < 0 || px >= width || pz < 0 || pz >= length) continue;
    const idx = pz * width + px;
    if (counts[idx] === 0 || y < heights[idx]) {
      heights[idx] = y;
      counts[idx] = 1;
    }
  }
}

/**
 * Normalise so the minimum touched cell is at y=0. Untouched cells stay 0.
 * Mutates and returns the same Float32Array.
 */
export function normaliseHeightmap(state: HeightmapState): Float32Array {
  const { heights, counts } = state;
  let minH = Infinity;
  for (let i = 0; i < heights.length; i++) {
    if (counts[i] > 0 && heights[i] < minH) minH = heights[i];
  }
  if (!Number.isFinite(minH)) {
    // No touched cells — leave zeros.
    return heights;
  }
  for (let i = 0; i < heights.length; i++) {
    heights[i] = counts[i] > 0 ? heights[i] - minH : 0;
  }
  return heights;
}

/**
 * Encode the heightmap as `[uint16 width][uint16 length][float32[] heights]`
 * for sidecar storage. Matches the format produced by the legacy headless
 * script so older artifacts roundtrip.
 */
export function encodeHeightmapSidecar(state: HeightmapState): Uint8Array {
  const { width, length, heights } = state;
  const header = new Uint16Array([width, length]);
  const out = new Uint8Array(4 + heights.byteLength);
  out.set(new Uint8Array(header.buffer), 0);
  out.set(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength), 4);
  return out;
}

/**
 * Detect height-truncation by comparing captured Y extent against the expected
 * (resolver-provided) building height. If captured < 60% of expected → truncated.
 */
export function isHeightTruncated(
  measured: HeightmapBbox,
  expectedHeightM: number | null,
): boolean {
  if (!expectedHeightM || expectedHeightM <= 0) return false;
  const captured = measured.maxY - measured.minY;
  return captured < expectedHeightM * 0.6;
}

/** A footprint vertex in the capture's local frame (metres; X east, Z south). */
export interface FootprintPointXZ {
  readonly x: number;
  readonly z: number;
}

export interface FootprintGroundOptions {
  /** Ring width outside the footprint edge that counts as "at the foot". */
  readonly ringM?: number;
  /** Fewer ring cells than this → no estimate (caller keeps the bbox span). */
  readonly minSamples?: number;
}

/**
 * Ground elevation at a building's foot, read from a NORMALISED 1-cell/m
 * heightmap (`normaliseHeightmap`): the median of the cells in a thin ring
 * just outside the footprint, in metres above the capture's lowest point.
 *
 * Why not the bbox minimum: the capture is a sphere around the building, so
 * its lowest point is wherever the terrain is lowest within it. On a slope
 * that is not the building's base — geisel sits on a canyon edge and
 * `maxY − minY` measured 72.9 m for a ~33 m building (canyon floor → roof).
 * The ring median is the ground the building actually stands on.
 *
 * Cells that are exactly 0 are skipped: after normalisation an untouched cell
 * and the single global-minimum cell both read 0, and neither is evidence of
 * the ground at the footprint.
 *
 * @param origin  scene X/Z of heightmap cell (0,0)'s corner (`measuredBbox.min`)
 * @returns metres above the capture minimum, or null when the ring holds fewer
 *          than `minSamples` cells (footprint outside the capture, no polygon).
 */
export function footprintGroundElevation(
  heightmap: Float32Array,
  width: number,
  length: number,
  origin: { readonly x: number; readonly z: number },
  footprint: readonly FootprintPointXZ[],
  opts: FootprintGroundOptions = {},
): number | null {
  const ringM = opts.ringM ?? 6;
  const minSamples = opts.minSamples ?? 20;
  if (footprint.length < 3 || width <= 0 || length <= 0) return null;

  const ring: number[] = [];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightmap[z * width + x];
      if (h === 0) continue;
      // Cell centre in scene metres (1 cell = 1 m, see createHeightmapState).
      const sx = origin.x + x + 0.5;
      const sz = origin.z + z + 0.5;
      if (pointInFootprint(sx, sz, footprint)) continue;
      if (distanceToFootprintEdge(sx, sz, footprint) <= ringM) ring.push(h);
    }
  }
  if (ring.length < minSamples) return null;
  ring.sort((a, b) => a - b);
  return ring[Math.floor((ring.length - 1) / 2)];
}

/** Even-odd point-in-polygon test in the XZ plane. */
function pointInFootprint(x: number, z: number, poly: readonly FootprintPointXZ[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance from (x, z) to any edge of the polygon. */
function distanceToFootprintEdge(x: number, z: number, poly: readonly FootprintPointXZ[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j].x, az = poly[j].z;
    const dx = poly[i].x - ax, dz = poly[i].z - az;
    const lenSq = dx * dx + dz * dz;
    const u = lenSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq)) : 0;
    best = Math.min(best, Math.hypot(x - (ax + u * dx), z - (az + u * dz)));
  }
  return best;
}

/** Accumulator-style bounding box helper over flat position arrays. */
export class BboxAccumulator {
  private minX = Infinity;
  private minY = Infinity;
  private minZ = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;
  private maxZ = -Infinity;
  private touched = false;

  addPositions(positions: Float32Array): void {
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      if (x < this.minX) this.minX = x;
      if (y < this.minY) this.minY = y;
      if (z < this.minZ) this.minZ = z;
      if (x > this.maxX) this.maxX = x;
      if (y > this.maxY) this.maxY = y;
      if (z > this.maxZ) this.maxZ = z;
    }
    this.touched = this.touched || positions.length > 0;
  }

  get(): HeightmapBbox | null {
    if (!this.touched) return null;
    return {
      minX: this.minX, minY: this.minY, minZ: this.minZ,
      maxX: this.maxX, maxY: this.maxY, maxZ: this.maxZ,
    };
  }
}
