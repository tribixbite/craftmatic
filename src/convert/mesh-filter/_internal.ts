/**
 * Shared constants, types, and helpers for the mesh-filter pipeline.
 * Imported by all domain modules — never imported directly by callers.
 */

import { BlockGrid } from '../../schem/types.js';
import { rgbToLab, WALL_CLUSTERS } from '../../gen/color-blocks.js';

// ─── Shared constants ───────────────────────────────────────────────────────

/** Minecraft air block ID, used pervasively throughout the filter pipeline. */
export const AIR = 'minecraft:air';

/** 4 cardinal horizontal directions in the XZ plane: +X, -X, +Z, -Z. */
export const H_DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** 6 face-neighbor offsets (±X, ±Y, ±Z) for 3D flood-fill / adjacency checks. */
export const FACES6: readonly [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

// ─── Grid snapshot helpers ──────────────────────────────────────────────────

/**
 * Create a flat string[] snapshot of the entire grid for consistent reads
 * during mutation passes (prevents cascading within a single pass).
 * Index formula: `(y * grid.length + z) * grid.width + x`
 */
export function snapshotGrid(grid: BlockGrid): string[] {
  const { width, height, length } = grid;
  const snap = new Array<string>(width * height * length);
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        snap[(y * length + z) * width + x] = grid.get(x, y, z);
  return snap;
}

/** Read a single voxel from a snapshot produced by `snapshotGrid`. */
export function readSnap(snap: string[], grid: BlockGrid, x: number, y: number, z: number): string {
  return snap[(y * grid.length + z) * grid.width + x];
}

// ─── Block luminance / Lab helpers ──────────────────────────────────────────

/** Overrides for blocks whose in-game brightness differs from texture RGB
 * (transparency, emissivity, or rendering effects not captured by flat color) */
const LUMINANCE_OVERRIDES = new Map<string, number>([
  ['minecraft:black_stained_glass', 0.05],
  ['minecraft:gray_stained_glass', 0.25],
  ['minecraft:glass', 0.80],
  ['minecraft:glass_pane', 0.80],
]);

/** Lazy-init cache: block name → [L*, a*, b*] from WALL_CLUSTERS RGB entries */
let _blockLabCache: Map<string, [number, number, number]> | null = null;

/**
 * Get CIE-Lab coordinates for a Minecraft block. Returns null for unknown blocks.
 * Used by modeFilter3D and smoothDarkBlocks to make color-aware decisions.
 */
export function getBlockLab(block: string): [number, number, number] | null {
  if (!_blockLabCache) {
    _blockLabCache = new Map();
    for (const cluster of WALL_CLUSTERS) {
      const [r, g, b] = cluster.rgb;
      const lab = rgbToLab(r, g, b);
      for (const opt of cluster.options) {
        // Strip minecraft: prefix variants — options always include it
        if (!_blockLabCache.has(opt)) {
          _blockLabCache.set(opt, lab);
        }
      }
    }
  }
  return _blockLabCache.get(block) ?? null;
}

/**
 * Get perceptual luminance (0-1) for a Minecraft block.
 * Uses CIE L* lightness from WALL_CLUSTERS (via getBlockLab), scaled to 0-1.
 * Falls back to 0.5 for unknown blocks not in any palette cluster.
 */
export function blockLuminance(block: string): number {
  const override = LUMINANCE_OVERRIDES.get(block);
  if (override !== undefined) return override;
  const lab = getBlockLab(block);
  if (lab) return lab[0] / 100; // L* ranges 0-100
  return 0.5;
}

/** Find the dominant block brighter than a threshold in a neighborhood */
export function findBrightNeighborMode(
  grid: BlockGrid, cx: number, cy: number, cz: number,
  radius: number, lumFloor: number,
): string | null {

  const { width, height, length } = grid;
  const neighborCounts = new Map<string, number>();

  for (let dy = -radius; dy <= radius; dy++) {
    const ny = cy + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dz = -radius; dz <= radius; dz++) {
      const nz = cz + dz;
      if (nz < 0 || nz >= length) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const nx = cx + dx;
        if (nx < 0 || nx >= width) continue;
        const nb = grid.get(nx, ny, nz);
        if (nb === AIR || blockLuminance(nb) <= lumFloor) continue;
        neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
      }
    }
  }

  let bestBlock = '';
  let bestCount = 0;
  for (const [b, c] of neighborCounts) {
    if (c > bestCount) { bestBlock = b; bestCount = c; }
  }
  return bestBlock || null;
}
