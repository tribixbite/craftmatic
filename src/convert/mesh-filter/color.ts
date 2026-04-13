/**
 * Color-processing functions for the mesh-filter pipeline.
 *
 * Smoothing, palette consolidation, facade clustering, and dark-block
 * replacement — all operate on BlockGrid in-place.
 */

import { BlockGrid } from '../../schem/types.js';
import { rgbToLab, deltaESq, WALL_CLUSTERS } from '../../gen/color-blocks.js';
import {
  AIR, H_DIRS,
  snapshotGrid, readSnap,
  getBlockLab, blockLuminance, findBrightNeighborMode,
} from './_internal.js';

// ─── Module-level protected block sets ─────────────────────────────────────

/** Minecraft color name prefixes for all 16 stained glass variants. */
const MC_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
] as const;

/**
 * Blocks never replaced by modeFilter3D — structural/detail elements.
 * All 16 MC color stained glass + pane variants protected — glass-facade buildings
 * (Seattle Library, Citigroup) lose glass to majority-vote wall material without this.
 */
export const MODEFILTER_PROTECTED: ReadonlySet<string> = (() => {
  const s = new Set([
    'minecraft:air',
    'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:iron_bars', 'minecraft:iron_block',
    'minecraft:chain', 'minecraft:end_rod', 'minecraft:lightning_rod',
  ]);
  // Add all 32 colored glass variants (16 colors x glass + glass_pane)
  for (const color of MC_COLORS) {
    s.add(`minecraft:${color}_stained_glass`);
    s.add(`minecraft:${color}_stained_glass_pane`);
  }
  return s;
})();

/** Blocks never consolidated by consolidateBlockPalette. */
export const PALETTE_PROTECTED: ReadonlySet<string> = new Set([
  'minecraft:air',
  'minecraft:smooth_stone', // fill block
  'minecraft:gray_stained_glass', // windows from glazeDarkWindows
  'minecraft:glass', 'minecraft:glass_pane',
  'minecraft:smooth_stone_slab', // entry path
]);

// ─── smoothRareBlocks ──────────────────────────────────────────────────────

export function smoothRareBlocks(grid: BlockGrid, minFrequency = 0.02): number {
  const { width, height, length } = grid;

  // Pass 1: count global block frequencies
  const freq = new Map<string, number>();
  let totalNonAir = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        totalNonAir++;
        freq.set(block, (freq.get(block) ?? 0) + 1);
      }
    }
  }

  if (totalNonAir === 0) return 0;

  // Identify rare blocks (below threshold)
  const threshold = totalNonAir * minFrequency;
  const rareBlocks = new Set<string>();
  for (const [block, count] of freq) {
    if (count < threshold) rareBlocks.add(block);
  }

  if (rareBlocks.size === 0) return 0;

  // Find the globally most common block as fallback
  let globalBest = 'minecraft:stone';
  let globalBestCount = 0;
  for (const [block, count] of freq) {
    if (!rareBlocks.has(block) && count > globalBestCount) {
      globalBest = block;
      globalBestCount = count;
    }
  }

  // Pass 2: replace rare blocks with most common neighbor
  let replaced = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air' || !rareBlocks.has(block)) continue;

        // Count non-air neighbors in 3x3x3 cube
        const neighborCounts = new Map<string, number>();
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dz = -1; dz <= 1; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const nb = grid.get(nx, ny, nz);
              if (nb !== 'minecraft:air' && !rareBlocks.has(nb)) {
                neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
              }
            }
          }
        }

        // Pick the most common non-rare neighbor, or global best if isolated
        let bestNeighbor = globalBest;
        let bestCount = 0;
        for (const [nb, count] of neighborCounts) {
          if (count > bestCount) {
            bestNeighbor = nb;
            bestCount = count;
          }
        }

        grid.set(x, y, z, bestNeighbor);
        replaced++;
      }
    }
  }

  return replaced;
}

// ─── constrainPalette ──────────────────────────────────────────────────────

export function constrainPalette(
  grid: BlockGrid,
  replacements: Map<string, string>,
): number {
  const { width, height, length } = grid;
  let replaced = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        const replacement = replacements.get(block);
        if (replacement) {
          grid.set(x, y, z, replacement);
          replaced++;
        }
      }
    }
  }
  return replaced;
}

// ─── modeFilter3D ──────────────────────────────────────────────────────────

export function modeFilter3D(grid: BlockGrid, passes = 2, radius = 1, extraProtected?: Set<string>): number {
  const { width, height, length } = grid;

  // Build effective protected set from module-level constant + caller additions
  const PROTECTED = new Set(MODEFILTER_PROTECTED);
  if (extraProtected) for (const b of extraProtected) PROTECTED.add(b);

  let totalReplaced = 0;

  for (let pass = 0; pass < passes; pass++) {
    // Snapshot current state so replacements in this pass don't cascade
    const snapshot = snapshotGrid(grid);

    let passReplaced = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const center = snapshot[(y * length + z) * width + x];
          if (PROTECTED.has(center)) continue;

          // Count non-air neighbors in (2r+1)^3 cube from snapshot
          const neighborCounts = new Map<string, number>();
          let totalNeighbors = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dz = -radius; dz <= radius; dz++) {
              const nz = z + dz;
              if (nz < 0 || nz >= length) continue;
              for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nb = snapshot[(ny * length + nz) * width + nx];
                if (nb === 'minecraft:air') continue;
                neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
                totalNeighbors++;
              }
            }
          }

          if (totalNeighbors === 0) continue;

          // Find the majority neighbor block
          let majorityBlock = center;
          let majorityCount = 0;
          for (const [block, count] of neighborCounts) {
            if (count > majorityCount) {
              majorityCount = count;
              majorityBlock = block;
            }
          }

          // Replace if center disagrees with plurality, plurality is strong (>35%),
          // AND center block is isolated (< 2 same-type neighbors).
          // 35% threshold works well after K-Means reduces palette to ~5 types —
          // the dominant type in a 27-voxel neighborhood needs ~7 votes to win.
          // This protects 1-block-wide continuous lines (window frames, trim, pipes)
          // which have >=2 neighbors of their own type — they're part of a feature, not noise.
          const centerCount = neighborCounts.get(center) ?? 0;
          if (majorityBlock !== center && majorityCount > totalNeighbors * 0.35 && centerCount < 2) {
            // v306: CIE-Lab guard — skip replacement if center and majority are very different
            // colors (delta-E > 20). Preserves terracotta accents in stone walls, brick bands
            // in concrete, etc. Only replaces same-color-family noise.
            const cLab = getBlockLab(center);
            const mLab = getBlockLab(majorityBlock);
            if (cLab && mLab) {
              const dE = (cLab[0] - mLab[0]) ** 2 + (cLab[1] - mLab[1]) ** 2 + (cLab[2] - mLab[2]) ** 2;
              if (dE > 400) continue; // delta-E^2 > 20^2 -> skip, colors too different
            }
            grid.set(x, y, z, majorityBlock);
            passReplaced++;
          }
        }
      }
    }

    totalReplaced += passReplaced;
    if (passReplaced === 0) break; // Converged early
  }

  return totalReplaced;
}

// ─── smoothDarkBlocks ──────────────────────────────────────────────────────

/**
 * Replace shadow-artifact blocks that are significantly darker than their neighborhood.
 *
 * Photogrammetry textures bake shadow into pixel data. After CIELAB block matching,
 * shadow regions map to dark Minecraft blocks creating leopard-spot noise patterns
 * that obscure building form. This function identifies blocks that are luminance
 * outliers relative to their local context and replaces them with the neighborhood mode.
 *
 * Two-pass approach:
 * 1. Replace very dark blocks (luminance <= 0.22) with brighter neighborhood mode
 * 2. Replace contrast outliers: blocks much darker than their neighborhood median
 *
 * @param contrastDelta - Min luminance gap below neighborhood median to trigger replacement (default 0.20)
 * @param radius - Neighborhood radius for context (default 2 -> 5x5x5)
 */
export function smoothDarkBlocks(grid: BlockGrid, contrastDelta = 0.20, radius = 2): number {

  const { width, height, length } = grid;
  let totalReplaced = 0;

  // Adaptive thresholds: compute grid luminance stats to avoid destroying
  // legitimate dark blocks on dark stone/brick buildings while still cleaning
  // baked shadows on bright buildings.
  const lumValues: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const b = grid.get(x, y, z);
        if (b === AIR) continue;
        const lum = blockLuminance(b);
        if (lum > 0) lumValues.push(lum); // skip 0-luminance (unknown blocks)
      }
    }
  }
  let DARK_FLOOR = 0.22;
  let adaptiveContrastDelta = contrastDelta;
  if (lumValues.length > 100) {
    lumValues.sort((a, b) => a - b);
    const p10 = lumValues[Math.floor(lumValues.length * 0.10)];
    const p90 = lumValues[Math.floor(lumValues.length * 0.90)];
    // Dark buildings (p10=0.10): floor=0.12, keeping dark blocks that ARE the building
    // Bright buildings (p10=0.40): floor=0.30, aggressively cleaning shadows
    DARK_FLOOR = Math.max(0.12, Math.min(0.30, p10 * 0.8));
    // Narrow range (all similar): small contrast delta (less aggressive)
    // Wide range (bright walls + dark shadows): large delta (more aggressive)
    adaptiveContrastDelta = Math.max(0.12, Math.min(0.28, (p90 - p10) * 0.5));
  }

  // Batch all replacements from both passes before writing — prevents Pass 1's
  // modifications from cascading into Pass 2's neighborhood median computation.
  // Keyed by 1D index to deduplicate (Pass 1 wins if both match same voxel).
  const allReplacements = new Map<number, { x: number; y: number; z: number; replacement: string }>();
  const idx1d = (x: number, y: number, z: number) => (y * length + z) * width + x;

  // Pass 1: Replace very dark blocks (adaptive luminance floor)
  {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const block = grid.get(x, y, z);
          if (block === AIR) continue;
          if (blockLuminance(block) > DARK_FLOOR) continue;

          // v306/v308: Chroma guard — skip saturated dark materials (brick, terracotta, dark wood).
          // Shadow artifacts map to neutral blocks (a*~0, b*~0) and are still cleaned.
          // v308: Lowered threshold 8->5 — brown_terracotta has b*~8, was on the edge.
          const lab1 = getBlockLab(block);
          if (lab1 && (Math.abs(lab1[1]) > 5 || Math.abs(lab1[2]) > 5)) continue;

          const best = findBrightNeighborMode(grid, x, y, z, radius, DARK_FLOOR);
          if (best) allReplacements.set(idx1d(x, y, z), { x, y, z, replacement: best });
        }
      }
    }
  }

  // Pass 2: Replace contrast outliers (dark blocks in bright neighborhoods)
  // Reads original grid state (Pass 1 writes deferred), preventing cascading brightness inflation.
  {
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const key = idx1d(x, y, z);
          if (allReplacements.has(key)) continue; // already scheduled by Pass 1
          const block = grid.get(x, y, z);
          if (block === AIR) continue;

          const lum = blockLuminance(block);

          // Collect neighbor luminances to compute median
          const neighborLums: number[] = [];
          const neighborCounts = new Map<string, number>();
          for (let dy = -radius; dy <= radius; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height) continue;
            for (let dz = -radius; dz <= radius; dz++) {
              const nz = z + dz;
              if (nz < 0 || nz >= length) continue;
              for (let dx = -radius; dx <= radius; dx++) {
                if (dx === 0 && dy === 0 && dz === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= width) continue;
                const nb = grid.get(nx, ny, nz);
                if (nb === AIR) continue;
                const nl = blockLuminance(nb);
                neighborLums.push(nl);
                neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
              }
            }
          }

          if (neighborLums.length < 4) continue;

          // Compute median luminance of neighborhood
          neighborLums.sort((a, b) => a - b);
          const median = neighborLums[Math.floor(neighborLums.length / 2)];

          // v306/v308: Chroma guard — skip saturated dark materials in contrast pass too
          const lab2 = getBlockLab(block);
          if (lab2 && (Math.abs(lab2[1]) > 5 || Math.abs(lab2[2]) > 5)) continue;

          // Replace if this block is much darker than its neighborhood median
          if (median - lum >= adaptiveContrastDelta) {
            // Find the dominant block with luminance near the median
            let bestBlock = '';
            let bestCount = 0;
            for (const [b, c] of neighborCounts) {
              const bl = blockLuminance(b);
              if (bl < median - 0.10) continue; // skip other dark blocks
              if (c > bestCount) { bestBlock = b; bestCount = c; }
            }
            if (bestBlock) {
              allReplacements.set(key, { x, y, z, replacement: bestBlock });
            }
          }
        }
      }
    }
  }

  // Apply all deferred replacements in a single write pass
  for (const { x, y, z, replacement } of allReplacements.values()) {
    grid.set(x, y, z, replacement);
  }
  totalReplaced += allReplacements.size;

  return totalReplaced;
}

// ─── smoothFacadeColors ────────────────────────────────────────────────────

/**
 * Phase 4c: Smooth facade colors using 5x5x1 Lab-weighted averaging on facade planes.
 *
 * For each facade block (adjacent to air on X or Z axis), averages the color of
 * co-planar neighbors in a 5x5 window along the facade plane. Snaps blocks with
 * delta-E > 15 from the local average to the majority color — preserves real
 * trim-vs-wall transitions while smoothing noise.
 *
 * @param grid  BlockGrid (modified in place)
 * @returns Number of blocks replaced
 */
export function smoothFacadeColors(grid: BlockGrid): number {

  const { width, height, length } = grid;

  let replaced = 0;

  // Snapshot for reading while modifying
  const snapshot = snapshotGrid(grid);
  const getSnap = (x: number, y: number, z: number) => readSnap(snapshot, grid, x, y, z);

  // Process each voxel that's on a facade
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = getSnap(x, y, z);
        if (block === AIR) continue;

        // Detect which facade face this block is on
        let facadeNormal: [number, number] | null = null;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length || getSnap(nx, y, nz) === AIR) {
            facadeNormal = [dx, dz];
            break;
          }
        }
        if (!facadeNormal) continue; // interior block

        // 5x5 window co-planar with this facade (along Y and the perpendicular horizontal axis)
        const isXFacade = facadeNormal[0] !== 0; // Facade faces X direction -> window in Y,Z
        const neighborCounts = new Map<string, number>();
        const R = 2; // half-size of 5x5 window

        for (let dy = -R; dy <= R; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dp = -R; dp <= R; dp++) {
            const nx2 = isXFacade ? x : x + dp;
            const nz2 = isXFacade ? z + dp : z;
            if (nx2 < 0 || nx2 >= width || nz2 < 0 || nz2 >= length) continue;
            const nb = getSnap(nx2, ny, nz2);
            if (nb === AIR) continue;
            neighborCounts.set(nb, (neighborCounts.get(nb) ?? 0) + 1);
          }
        }

        // Find majority block in window
        let majorBlock = block;
        let majorCount = 0;
        for (const [b, c] of neighborCounts) {
          if (c > majorCount) { majorBlock = b; majorCount = c; }
        }

        // Replace if center block differs from majority AND delta-E > 15
        if (majorBlock !== block) {
          const cLab = getBlockLab(block);
          const mLab = getBlockLab(majorBlock);
          if (cLab && mLab) {
            const dE = Math.sqrt(
              (cLab[0] - mLab[0]) ** 2 + (cLab[1] - mLab[1]) ** 2 + (cLab[2] - mLab[2]) ** 2,
            );
            // Only replace noisy outliers (delta-E > 15) — preserves real trim/accent transitions
            if (dE > 15) {
              grid.set(x, y, z, majorBlock);
              replaced++;
            }
          }
        }
      }
    }
  }

  return replaced;
}

// ─── clusterFacadePalette ──────────────────────────────────────────────────

/**
 * Phase 4d: Per-facade K-means palette clustering.
 *
 * Reduces per-facade block diversity from 15-20 noisy variants down to k coherent
 * materials. For each facade face (N/S/E/W), collects all facade block Lab colors,
 * runs K-means clustering (k=3-5 adaptive), then maps each cluster center to the
 * nearest WALL_CLUSTERS MC block.
 *
 * Subsample: uses every Nth facade voxel (N = ceil(count/100)) for cluster center
 * computation, then nearest-neighbor assigns the full set for O(N) performance.
 *
 * @param grid  BlockGrid (modified in place)
 * @param k     Max number of palette clusters per facade (default: 4)
 * @returns Number of blocks replaced
 */
export function clusterFacadePalette(grid: BlockGrid, k = 4): number {

  const { width, height, length } = grid;

  let replaced = 0;

  // Group facade voxels by face direction (4 cardinal faces)
  // Key: "dx,dz" -> list of {x, y, z, block, lab}
  type FacadeVoxel = { x: number; y: number; z: number; block: string; lab: [number, number, number] };
  const faceGroups = new Map<string, FacadeVoxel[]>();

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        // Find which face this block is exposed on
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length || grid.get(nx, y, nz) === AIR) {
            const lab = getBlockLab(block);
            if (!lab) break; // unknown block — skip
            const key = `${dx},${dz}`;
            let group = faceGroups.get(key);
            if (!group) { group = []; faceGroups.set(key, group); }
            group.push({ x, y, z, block, lab });
            break; // only assign to first exposed face
          }
        }
      }
    }
  }

  // K-means++ initialization: pick centers that are far apart in Lab space
  function kmeansInit(samples: [number, number, number][], numK: number): [number, number, number][] {
    const centers: [number, number, number][] = [];
    // First center: random (use middle sample for determinism)
    centers.push([...samples[Math.floor(samples.length / 2)]]);

    for (let c = 1; c < numK; c++) {
      // For each sample, find min distance to existing centers
      let totalDist = 0;
      const dists: number[] = new Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        let minD = Infinity;
        for (const ct of centers) {
          const d = (samples[i][0] - ct[0]) ** 2 + (samples[i][1] - ct[1]) ** 2 + (samples[i][2] - ct[2]) ** 2;
          if (d < minD) minD = d;
        }
        dists[i] = minD;
        totalDist += minD;
      }
      // Pick next center proportional to distance squared (deterministic: pick the farthest)
      let maxD = 0, maxIdx = 0;
      for (let i = 0; i < dists.length; i++) {
        if (dists[i] > maxD) { maxD = dists[i]; maxIdx = i; }
      }
      centers.push([...samples[maxIdx]]);
    }
    return centers;
  }

  // K-means iteration
  function kmeans(
    samples: [number, number, number][],
    numK: number,
    maxIter = 20,
  ): [number, number, number][] {
    if (samples.length <= numK) return samples.map(s => [...s] as [number, number, number]);

    const centers = kmeansInit(samples, numK);
    const assignments = new Int32Array(samples.length);

    for (let iter = 0; iter < maxIter; iter++) {
      let changed = false;

      // Assign each sample to nearest center
      for (let i = 0; i < samples.length; i++) {
        let bestC = 0, bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = (samples[i][0] - centers[c][0]) ** 2 +
                    (samples[i][1] - centers[c][1]) ** 2 +
                    (samples[i][2] - centers[c][2]) ** 2;
          if (d < bestD) { bestD = d; bestC = c; }
        }
        if (assignments[i] !== bestC) { assignments[i] = bestC; changed = true; }
      }

      if (!changed) break;

      // Recompute centers
      const sums: [number, number, number][] = centers.map(() => [0, 0, 0]);
      const counts = new Int32Array(centers.length);
      for (let i = 0; i < samples.length; i++) {
        const c = assignments[i];
        sums[c][0] += samples[i][0];
        sums[c][1] += samples[i][1];
        sums[c][2] += samples[i][2];
        counts[c]++;
      }
      for (let c = 0; c < centers.length; c++) {
        if (counts[c] > 0) {
          centers[c][0] = sums[c][0] / counts[c];
          centers[c][1] = sums[c][1] / counts[c];
          centers[c][2] = sums[c][2] / counts[c];
        }
      }
    }

    return centers;
  }

  // Map a Lab center to the nearest WALL_CLUSTERS MC block
  function labToBlock(lab: [number, number, number]): string {
    let bestBlock = WALL_CLUSTERS[0].options[0];
    let bestDist = Infinity;
    for (const cluster of WALL_CLUSTERS) {
      const cLab = rgbToLab(cluster.rgb[0], cluster.rgb[1], cluster.rgb[2]);
      const d = (lab[0] - cLab[0]) ** 2 + (lab[1] - cLab[1]) ** 2 + (lab[2] - cLab[2]) ** 2;
      if (d < bestDist) { bestDist = d; bestBlock = cluster.options[0]; }
    }
    return bestBlock;
  }

  // Process each facade face
  for (const [_key, voxels] of faceGroups) {
    if (voxels.length < 6) continue; // too few to cluster

    // Count unique blocks to determine actual k
    const uniqueBlocks = new Set(voxels.map(v => v.block));
    if (uniqueBlocks.size <= 2) continue; // already minimal palette

    const actualK = Math.min(k, Math.max(2, uniqueBlocks.size - 1));

    // Subsample for cluster center computation (1/100 or min 50)
    const step = Math.max(1, Math.ceil(voxels.length / 100));
    const samples: [number, number, number][] = [];
    for (let i = 0; i < voxels.length; i += step) {
      samples.push(voxels[i].lab);
    }

    // Run K-means
    const centers = kmeans(samples, actualK);

    // Map each center to a MC block
    const centerBlocks = centers.map(c => labToBlock(c));

    // Assign every facade voxel to nearest center and replace
    for (const v of voxels) {
      let bestC = 0, bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = (v.lab[0] - centers[c][0]) ** 2 +
                  (v.lab[1] - centers[c][1]) ** 2 +
                  (v.lab[2] - centers[c][2]) ** 2;
        if (d < bestD) { bestD = d; bestC = c; }
      }
      const newBlock = centerBlocks[bestC];
      if (newBlock !== v.block) {
        grid.set(v.x, v.y, v.z, newBlock);
        replaced++;
      }
    }
  }

  return replaced;
}

// ─── smoothRoofPlane ───────────────────────────────────────────────────────

/**
 * Phase 4e: Smooth roof plane blocks with aggressive majority-vote filtering.
 *
 * Identifies roof voxels (Y > 80% of building height, facing upward = no solid above)
 * and applies a 5x5 horizontal majority-vote filter. Roof surfaces in photogrammetry
 * are noisy (HVAC equipment, varied materials, shadows) and benefit from stronger
 * smoothing than facade surfaces.
 *
 * @param grid  BlockGrid (modified in place)
 * @returns Number of roof blocks replaced
 */
export function smoothRoofPlane(grid: BlockGrid): number {

  const { width, height, length } = grid;
  let replaced = 0;

  // Find building height (topmost non-air Y)
  let maxY = 0;
  for (let y = height - 1; y >= 0; y--) {
    let found = false;
    for (let z = 0; z < length && !found; z++)
      for (let x = 0; x < width && !found; x++)
        if (grid.get(x, y, z) !== AIR) { maxY = y; found = true; }
    if (found) break;
  }

  const roofThreshold = Math.floor(maxY * 0.8); // Top 20% of building
  const R = 2; // 5x5 horizontal window

  // Snapshot for reading
  const snapshot: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        snapshot[(y * length + z) * width + x] = grid.get(x, y, z);

  const getSnap = (x: number, y: number, z: number) => snapshot[(y * length + z) * width + x];

  for (let y = roofThreshold; y <= maxY; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = getSnap(x, y, z);
        if (block === AIR) continue;

        // Check if this is a roof voxel: no solid block directly above
        const hasRoof = y < height - 1 && getSnap(x, y + 1, z) !== AIR;
        if (hasRoof) continue; // Not a top surface

        // 5x5 horizontal majority vote
        const counts = new Map<string, number>();
        for (let dz = -R; dz <= R; dz++) {
          const nz = z + dz;
          if (nz < 0 || nz >= length) continue;
          for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            const nb = getSnap(nx, y, nz);
            if (nb === AIR) continue;
            counts.set(nb, (counts.get(nb) ?? 0) + 1);
          }
        }

        let bestBlock = block;
        let bestCount = 0;
        for (const [b, c] of counts) {
          if (c > bestCount) { bestBlock = b; bestCount = c; }
        }

        if (bestBlock !== block) {
          grid.set(x, y, z, bestBlock);
          replaced++;
        }
      }
    }
  }

  return replaced;
}

// ─── FacadeDir + homogenizeFacadesByFace ───────────────────────────────────

export type FacadeDir = '+x' | '-x' | '+z' | '-z';

/**
 * Per-face minority block collapse — forces facade surfaces toward homogeneous
 * materials. For each exterior face direction (+x/-x/+z/-z), blocks that appear
 * in < minPct of that face's surface are replaced with the nearest majority block
 * found on the same face at the same Y level, or the face's global mode.
 *
 * This pushes heterogeneous facades (54% dominant) toward Flatiron-level
 * homogeneity (70%+), which VLMs perceive as "clean, complete surfaces" (C=3).
 *
 * Run AFTER glazeDarkWindows + modeFilter (so glass is already placed and protected).
 */
export function homogenizeFacadesByFace(
  grid: BlockGrid,
  minPct = 0.05,
  searchRadius = 6,
  protectedBlocks?: Set<string>,
): number {

  const MIN_SAMPLES = 100;

  // Blocks that should never be replaced (glass, trim accents)
  const prot = new Set<string>([
    AIR,
    'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
    'minecraft:iron_bars', 'minecraft:smooth_stone_slab',
  ]);
  if (protectedBlocks) for (const b of protectedBlocks) prot.add(b);

  const { width, height, length } = grid;
  const faces: FacadeDir[] = ['+x', '-x', '+z', '-z'];
  let totalReplaced = 0;

  // For each face direction, collect exterior surface voxels
  for (const dir of faces) {
    // Collect surface positions: solid block whose neighbor in dir is air
    const surface: Array<{ x: number; y: number; z: number; b: string }> = [];
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const b = grid.get(x, y, z);
          if (b === AIR || prot.has(b)) continue;

          let isExterior = false;
          if (dir === '+x') isExterior = x === width - 1 || grid.get(x + 1, y, z) === AIR;
          else if (dir === '-x') isExterior = x === 0 || grid.get(x - 1, y, z) === AIR;
          else if (dir === '+z') isExterior = z === length - 1 || grid.get(x, y, z + 1) === AIR;
          else isExterior = z === 0 || grid.get(x, y, z - 1) === AIR;

          if (isExterior) surface.push({ x, y, z, b });
        }
      }
    }

    if (surface.length < MIN_SAMPLES) continue;

    // Build frequency histogram for this face
    const freq = new Map<string, number>();
    for (const p of surface) freq.set(p.b, (freq.get(p.b) ?? 0) + 1);

    // Find face mode (most frequent block)
    let faceMode = '';
    let faceModeCount = 0;
    for (const [b, c] of freq) {
      if (c > faceModeCount) { faceMode = b; faceModeCount = c; }
    }
    if (!faceMode) continue;

    // Identify minority blocks (< minPct of this face)
    const threshold = surface.length * minPct;
    const minority = new Set<string>();
    for (const [b, c] of freq) {
      if (c < threshold) minority.add(b);
    }
    if (minority.size === 0) continue;

    // Replace minority blocks with nearest majority on same face + same Y
    for (const p of surface) {
      if (!minority.has(p.b)) continue;

      // Search outward on the face plane (same Y) for nearest non-minority block
      let bestBlock: string | null = null;
      for (let r = 1; r <= searchRadius && !bestBlock; r++) {
        for (let d = -r; d <= r && !bestBlock; d++) {
          // For x-faces, search along z axis. For z-faces, search along x axis.
          let nx = p.x, nz = p.z;
          if (dir === '+x' || dir === '-x') nz = p.z + d;
          else nx = p.x + d;

          if (!grid.inBounds(nx, p.y, nz)) continue;
          const nb = grid.get(nx, p.y, nz);
          if (nb === AIR || prot.has(nb) || minority.has(nb)) continue;

          // Verify it's also on the same face surface
          let neighborIsExterior = false;
          if (dir === '+x') neighborIsExterior = nx === width - 1 || grid.get(nx + 1, p.y, nz) === AIR;
          else if (dir === '-x') neighborIsExterior = nx === 0 || grid.get(nx - 1, p.y, nz) === AIR;
          else if (dir === '+z') neighborIsExterior = nz === length - 1 || grid.get(nx, p.y, nz + 1) === AIR;
          else neighborIsExterior = nz === 0 || grid.get(nx, p.y, nz - 1) === AIR;

          if (neighborIsExterior) bestBlock = nb;
        }
      }

      if (!bestBlock) bestBlock = faceMode;

      grid.set(p.x, p.y, p.z, bestBlock);
      totalReplaced++;
    }
  }

  return totalReplaced;
}

// ─── consolidateBlockPalette ───────────────────────────────────────────────

export function consolidateBlockPalette(grid: BlockGrid, k = 5): number {
  // Build block -> RGB lookup from WALL_CLUSTERS
  const blockRgb = new Map<string, [number, number, number]>();
  for (const cluster of WALL_CLUSTERS) {
    for (const opt of cluster.options) {
      if (!blockRgb.has(opt)) blockRgb.set(opt, [...cluster.rgb] as [number, number, number]);
    }
  }

  // Collect non-protected block frequencies
  const blockCounts = new Map<string, number>();
  const { width, height, length } = grid;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (PALETTE_PROTECTED.has(block) || !blockRgb.has(block)) continue;
        blockCounts.set(block, (blockCounts.get(block) || 0) + 1);
      }
    }
  }

  const uniqueBlocks = [...blockCounts.keys()];
  if (uniqueBlocks.length <= k) return 0; // Already few enough distinct blocks

  // Convert each unique block to Lab space with its count weight
  type BlockEntry = { block: string; lab: [number, number, number]; count: number };
  const entries: BlockEntry[] = uniqueBlocks.map(block => ({
    block,
    lab: rgbToLab(...blockRgb.get(block)!),
    count: blockCounts.get(block)!,
  }));

  // Sort by frequency descending — most common blocks become initial centroids
  entries.sort((a, b) => b.count - a.count);

  // K-Means++ initialization: pick k centroids weighted by distance to nearest existing centroid
  const centroids: [number, number, number][] = [entries[0].lab];
  for (let c = 1; c < k; c++) {
    // Compute distance from each entry to nearest existing centroid
    let totalDist = 0;
    const dists: number[] = [];
    for (const entry of entries) {
      let minDist = Infinity;
      for (const centroid of centroids) {
        const d = deltaESq(entry.lab[0], entry.lab[1], entry.lab[2], centroid[0], centroid[1], centroid[2]);
        if (d < minDist) minDist = d;
      }
      dists.push(minDist * entry.count); // Weight by frequency
      totalDist += minDist * entry.count;
    }
    // Pick proportional to distance^2
    let target = Math.random() * totalDist;
    let picked = 0;
    for (let i = 0; i < dists.length; i++) {
      target -= dists[i];
      if (target <= 0) { picked = i; break; }
    }
    centroids.push([...entries[picked].lab] as [number, number, number]);
  }

  // K-Means iterations (max 20)
  const assignments = new Int32Array(entries.length);
  for (let iter = 0; iter < 20; iter++) {
    let changed = 0;

    // Assign each entry to nearest centroid
    for (let i = 0; i < entries.length; i++) {
      const { lab } = entries[i];
      let bestC = 0;
      let bestDist = deltaESq(lab[0], lab[1], lab[2], centroids[0][0], centroids[0][1], centroids[0][2]);
      for (let c = 1; c < k; c++) {
        const d = deltaESq(lab[0], lab[1], lab[2], centroids[c][0], centroids[c][1], centroids[c][2]);
        if (d < bestDist) { bestDist = d; bestC = c; }
      }
      if (assignments[i] !== bestC) { assignments[i] = bestC; changed++; }
    }

    if (changed === 0) break; // Converged

    // Recompute centroids (weighted by block count)
    for (let c = 0; c < k; c++) {
      let sumL = 0, sumA = 0, sumB = 0, totalW = 0;
      for (let i = 0; i < entries.length; i++) {
        if (assignments[i] !== c) continue;
        const w = entries[i].count;
        sumL += entries[i].lab[0] * w;
        sumA += entries[i].lab[1] * w;
        sumB += entries[i].lab[2] * w;
        totalW += w;
      }
      if (totalW > 0) {
        centroids[c] = [sumL / totalW, sumA / totalW, sumB / totalW];
      }
    }
  }

  // For each cluster, pick the representative block: the most frequent block in the cluster
  const clusterBlock = new Map<number, string>();
  for (let c = 0; c < k; c++) {
    let bestBlock = '';
    let bestCount = 0;
    for (let i = 0; i < entries.length; i++) {
      if (assignments[i] !== c) continue;
      if (entries[i].count > bestCount) {
        bestCount = entries[i].count;
        bestBlock = entries[i].block;
      }
    }
    if (bestBlock) clusterBlock.set(c, bestBlock);
  }

  // Build remap: for each entry, if its cluster's representative is different, remap
  const remap = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const rep = clusterBlock.get(assignments[i]);
    if (rep && rep !== entries[i].block) {
      remap.set(entries[i].block, rep);
    }
  }

  if (remap.size === 0) return 0;

  // Apply remap in-place
  let reassigned = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        const newBlock = remap.get(block);
        if (newBlock) {
          grid.set(x, y, z, newBlock);
          reassigned++;
        }
      }
    }
  }

  return reassigned;
}
