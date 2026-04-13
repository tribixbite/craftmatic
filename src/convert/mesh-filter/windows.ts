/**
 * Window detection, glazing, and regularization functions for the mesh-filter pipeline.
 *
 * Extracted from mesh-filter.ts — handles all window-related post-processing:
 * - Dark window glazing (photogrammetry shadow → glass conversion)
 * - Reflective/sky-reflecting window detection (Lab color analysis)
 * - Synthetic window injection (for uniformly light facades)
 * - Window regularization and door placement
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR, H_DIRS, getBlockLab } from './_internal.js';

// ─── Module-level block sets ────────────────────────────────────────────────

/** Dark blocks that typically represent baked window/shadow regions.
 * Only the truly dark blocks qualify — mid-grays (andesite, stone_bricks,
 * polished_andesite) are legitimate facade materials with the wider tonal range. */
const DARK_BLOCKS = new Set([
  'minecraft:gray_concrete',       // lum ~58 — deep shadow/window
  'minecraft:polished_deepslate',  // lum ~54 — deep shadow/window
  'minecraft:brown_concrete',      // lum ~45 — dark recesses
  'minecraft:black_concrete',      // lum ~25 — deep shadow/window
  'minecraft:deepslate',           // lum ~48 — dark recesses
]);

/** Glass block variants used to identify already-glazed windows. */
const GLASS_BLOCKS = new Set([
  'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
  'minecraft:light_gray_stained_glass', 'minecraft:black_stained_glass',
  'minecraft:light_blue_stained_glass',
]);

/** Glass/dark blocks that represent windows for regularization detection. */
const WINDOW_BLOCKS = new Set([
  'minecraft:gray_stained_glass', 'minecraft:glass', 'minecraft:glass_pane',
  'minecraft:gray_concrete', 'minecraft:polished_deepslate',
]);

// ─── Window functions ───────────────────────────────────────────────────────

/**
 * Phase 5: Convert dark facade blocks into gray stained glass (window proxy).
 *
 * Dark blocks (gray_concrete, polished_deepslate, black_concrete, deepslate,
 * brown_concrete) on exterior facades almost always represent baked window or
 * shadow regions from photogrammetry.  Converting them to translucent glass
 * dramatically improves building realism.
 *
 * Algorithm:
 * 1. Only considers blocks on exterior facade surfaces (Y≥2, horizontal adjacency to air)
 * 2. Groups facade dark blocks into vertical chains using Chebyshev-1 XZ tolerance:
 *    each block connects to the 3×3 XZ neighborhood (x±1, z±1) above, tolerating
 *    1-block lateral shift per floor (tapers, diagonals, curves)
 * 3. Glazes all dark blocks in chains with ≥2 members
 *
 * @param grid  Source BlockGrid (modified in place)
 * @returns Number of blocks glazed
 */
export function glazeDarkWindows(grid: BlockGrid, resolution = 1): number {
  const { width, height, length } = grid;

  let glazed = 0;

  // Scale MIN_Y with resolution: skip ground-level (foundation, entry, base shadow)
  const MIN_Y = Math.max(2, Math.round(2 * resolution));

  // Horizontal directions for facade detection (adjacent to air on X or Z axis)


  // Phase 1: Collect all facade dark block positions
  type Pos = { x: number; y: number; z: number };
  const facadeBlocks: Pos[] = [];
  // 3D lookup for quick neighbor queries: key = y*W*L + z*W + x
  const WL = width * length;
  const facadeSet = new Uint8Array(height * WL);

  for (let y = MIN_Y; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (!DARK_BLOCKS.has(block)) continue;

        // Reject overhang undersides (soffits): a true facade block rests on
        // something solid. If air directly below, it's a downward-facing surface
        // whose shadow should not be glazed as a window.
        if (grid.get(x, y - 1, z) === AIR) continue;

        // Check if on a horizontal facade (adjacent to air on X or Z axis)
        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true;
            break;
          }
        }
        if (isFacade) {
          facadeBlocks.push({ x, y, z });
          facadeSet[y * WL + z * width + x] = 1;
        }
      }
    }
  }

  if (facadeBlocks.length === 0) return 0;

  // Count total non-air exterior blocks for glazing cap.
  // If dark facade blocks exceed MAX_GLAZE_PCT of total facade, the "windows"
  // are actually baked photogrammetry shadows — skip glazing entirely.
  const MAX_GLAZE_PCT = 0.30; // max 30% of facade can be glazed (commercial buildings have >20% dark)
  let totalFacadeBlocks = 0;
  for (let y = MIN_Y; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;
        let onFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            onFacade = true;
            break;
          }
        }
        if (onFacade) totalFacadeBlocks++;
      }
    }
  }

  if (totalFacadeBlocks > 0 && facadeBlocks.length / totalFacadeBlocks > MAX_GLAZE_PCT) {
    console.log(`    glazeDarkWindows: SKIPPED — ${facadeBlocks.length} dark blocks = ${(100 * facadeBlocks.length / totalFacadeBlocks).toFixed(0)}% of ${totalFacadeBlocks} facade blocks (cap ${(MAX_GLAZE_PCT * 100).toFixed(0)}%)`);
    return 0;
  }

  // Phase 2: Union-Find to group facade dark blocks into vertical chains.
  // Two blocks are connected if they are Chebyshev-1 neighbors in XZ and ±1 in Y.
  // This means a block at (x,y,z) connects to any facade dark block at
  // (x±1, y±1, z±1) — tolerating diagonal walls and tapered facades.
  const parent = new Int32Array(facadeBlocks.length);
  const rank = new Uint8Array(facadeBlocks.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;

  function find(a: number): number {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }

  // Build index: for each (y, x, z) → index in facadeBlocks
  // Only need to check Y+1 direction (each pair found once)
  const posIndex = new Map<number, number>(); // key → facadeBlocks index
  for (let i = 0; i < facadeBlocks.length; i++) {
    const { x, y, z } = facadeBlocks[i];
    posIndex.set(y * WL + z * width + x, i);
  }

  for (let i = 0; i < facadeBlocks.length; i++) {
    const { x, y, z } = facadeBlocks[i];
    // Check Chebyshev-1 XZ neighbors at Y+1
    const ny = y + 1;
    if (ny >= height) continue;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
        const nIdx = ny * WL + nz * width + nx;
        if (facadeSet[nIdx]) {
          const j = posIndex.get(nIdx);
          if (j !== undefined) union(i, j);
        }
      }
    }
  }

  // Phase 3: Filter components by size AND vertical extent.
  // Real windows form vertically coherent chains spanning ≥3 Y levels;
  // noise/shadow artifacts are scattered with small vertical bounding boxes.
  const MIN_COMP_SIZE = 3;    // minimum blocks in the chain
  // Scale vertical span threshold with resolution: 3m floor = 9 blocks at res 3
  const MIN_COMP_HEIGHT = Math.max(2, Math.round(2 * resolution));

  const compSize = new Map<number, number>();
  const compMinY = new Map<number, number>();
  const compMaxY = new Map<number, number>();
  for (let i = 0; i < facadeBlocks.length; i++) {
    const root = find(i);
    const { y } = facadeBlocks[i];
    compSize.set(root, (compSize.get(root) ?? 0) + 1);
    compMinY.set(root, Math.min(compMinY.get(root) ?? y, y));
    compMaxY.set(root, Math.max(compMaxY.get(root) ?? y, y));
  }

  for (let i = 0; i < facadeBlocks.length; i++) {
    const root = find(i);
    const size = compSize.get(root) ?? 0;
    const vHeight = (compMaxY.get(root) ?? 0) - (compMinY.get(root) ?? 0) + 1;
    if (size >= MIN_COMP_SIZE && vHeight >= MIN_COMP_HEIGHT) {
      const { x, y, z } = facadeBlocks[i];
      grid.set(x, y, z, 'minecraft:gray_stained_glass');
      glazed++;
    }
  }

  return glazed;
}

/**
 * Phase 5a: Detect sky-reflecting windows on photogrammetry facades.
 *
 * In photogrammetry, windows often reflect the sky (blue/grey/white) rather than
 * appearing dark. This function detects blocks on vertical facades whose Lab color
 * is blue-shifted (b* < -5) or has high delta-E from the dominant facade material.
 *
 * Per-facade process:
 * 1. Collect all exterior facade blocks grouped by face direction (N/S/E/W)
 * 2. Compute dominant wall material per face
 * 3. Identify "reflective" candidates: blue-shifted or high-contrast from dominant
 * 4. Detect grid regularity in candidate positions (median H/V spacing)
 * 5. Fill in missing grid positions where >60% of a row already has candidates
 *
 * @param grid        BlockGrid (modified in place)
 * @param resolution  Blocks per meter (default: 1)
 * @returns Number of blocks converted to glass
 */
export function glazeReflectiveWindows(grid: BlockGrid, resolution = 1): number {
  const { width, height, length } = grid;

  const GLASS = 'minecraft:gray_stained_glass';
  const MIN_Y = Math.max(2, Math.round(2 * resolution));
  let totalGlazed = 0;

  // Face directions: [normalDx, normalDz, sweepAxis, depthAxis]
  // For each face, sweepAxis runs along the facade, depthAxis is the normal direction
  const faces = [
    { dx: -1, dz: 0, name: 'W' }, // facade facing west (air to the west)
    { dx: 1, dz: 0, name: 'E' },  // facade facing east
    { dx: 0, dz: -1, name: 'N' }, // facade facing north
    { dx: 0, dz: 1, name: 'S' },  // facade facing south
  ];

  for (const face of faces) {
    // Collect facade blocks for this face
    type FacadePos = { x: number; y: number; z: number; block: string };
    const facadeBlocks: FacadePos[] = [];

    for (let y = MIN_Y; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const block = grid.get(x, y, z);
          if (block === AIR || GLASS_BLOCKS.has(block)) continue;

          // Check if this block faces air in the specified direction
          const nx = x + face.dx, nz = z + face.dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
            facadeBlocks.push({ x, y, z, block });
          } else if (grid.get(nx, y, nz) === AIR) {
            facadeBlocks.push({ x, y, z, block });
          }
        }
      }
    }

    if (facadeBlocks.length < 10) continue;

    // Find dominant wall material on this face
    const blockCounts = new Map<string, number>();
    for (const { block } of facadeBlocks) {
      blockCounts.set(block, (blockCounts.get(block) ?? 0) + 1);
    }
    let dominantBlock = '';
    let dominantCount = 0;
    for (const [b, c] of blockCounts) {
      if (c > dominantCount) { dominantBlock = b; dominantCount = c; }
    }
    if (dominantCount < facadeBlocks.length * 0.25) continue; // no clear dominant

    const dominantLab = getBlockLab(dominantBlock);
    if (!dominantLab) continue;

    // Identify reflective window candidates: blue-shifted or high delta-E from dominant
    // Key insight: sky-reflecting windows have Lab b* < -5 (blue) and/or a* near 0 (achromatic)
    const candidates: FacadePos[] = [];
    for (const pos of facadeBlocks) {
      if (pos.block === dominantBlock) continue;
      const lab = getBlockLab(pos.block);
      if (!lab) continue;

      const dE = Math.sqrt(
        (lab[0] - dominantLab[0]) ** 2 +
        (lab[1] - dominantLab[1]) ** 2 +
        (lab[2] - dominantLab[2]) ** 2,
      );

      // Blue-shifted reflective: b* < -5 and delta-E > 10 from wall
      const isBlueShifted = lab[2] < -5 && dE > 10;
      // High-contrast achromatic: low chroma (|a*| < 10 and |b*| < 10) and delta-E > 20
      const isAchromatic = Math.abs(lab[1]) < 10 && Math.abs(lab[2]) < 10 && dE > 20;

      if (isBlueShifted || isAchromatic) {
        candidates.push(pos);
      }
    }

    if (candidates.length < 3) continue;

    // Cap: if candidates > 25% of face, it's not windows — it's facade variation
    if (candidates.length > facadeBlocks.length * 0.25) continue;

    // Project candidates onto 2D facade grid for regularity detection.
    // Sweep axis: for X-facing facade → Z is sweep, for Z-facing → X is sweep.
    // Vertical axis: Y always.
    const isXFace = face.dx !== 0;

    // Build a map of candidate positions: key = (sweep, y)
    const candidateGrid = new Map<string, FacadePos>();
    for (const pos of candidates) {
      const sweep = isXFace ? pos.z : pos.x;
      const key = `${sweep},${pos.y}`;
      candidateGrid.set(key, pos);
    }

    // Detect horizontal spacing: for each Y level with >1 candidate, compute gaps
    const yLevels = new Map<number, number[]>(); // y → sweep positions sorted
    for (const pos of candidates) {
      const sweep = isXFace ? pos.z : pos.x;
      if (!yLevels.has(pos.y)) yLevels.set(pos.y, []);
      yLevels.get(pos.y)!.push(sweep);
    }

    // Collect all horizontal gaps
    const hGaps: number[] = [];
    for (const [, sweeps] of yLevels) {
      if (sweeps.length < 2) continue;
      sweeps.sort((a, b) => a - b);
      for (let i = 1; i < sweeps.length; i++) {
        const gap = sweeps[i] - sweeps[i - 1];
        if (gap >= 2 && gap <= 6 * resolution) hGaps.push(gap);
      }
    }

    // Detect vertical spacing: for each sweep with >1 candidate, compute gaps
    const sweepLevels = new Map<number, number[]>(); // sweep → Y positions sorted
    for (const pos of candidates) {
      const sweep = isXFace ? pos.z : pos.x;
      if (!sweepLevels.has(sweep)) sweepLevels.set(sweep, []);
      sweepLevels.get(sweep)!.push(pos.y);
    }

    const vGaps: number[] = [];
    for (const [, ys] of sweepLevels) {
      if (ys.length < 2) continue;
      ys.sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) {
        const gap = ys[i] - ys[i - 1];
        if (gap >= 2 && gap <= 6 * resolution) vGaps.push(gap);
      }
    }

    // Need at least some regularity signal to proceed
    if (hGaps.length < 2 && vGaps.length < 2) continue;

    // Median spacing (robust to outliers)
    const medianOf = (arr: number[]) => {
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const hSpacing = hGaps.length >= 2 ? medianOf(hGaps) : 0;
    const vSpacing = vGaps.length >= 2 ? medianOf(vGaps) : 0;

    if (hSpacing === 0 && vSpacing === 0) continue;

    // Glaze all existing candidates
    for (const pos of candidates) {
      grid.set(pos.x, pos.y, pos.z, GLASS);
      totalGlazed++;
    }

    // Fill missing grid positions where >60% of a row already has candidates
    if (hSpacing > 0 && vSpacing > 0) {
      // Build sweep/Y ranges from candidates
      const sweepMax = Math.max(...candidates.map(p => isXFace ? p.z : p.x));
      const yMin = Math.min(...candidates.map(p => p.y));
      const yMax = Math.max(...candidates.map(p => p.y));

      // Find the best-populated reference row to anchor the grid
      let bestRowY = yMin;
      let bestRowCount = 0;
      for (const [y, sweeps] of yLevels) {
        if (sweeps.length > bestRowCount) { bestRowCount = sweeps.length; bestRowY = y; }
      }

      // Expected window positions along sweep axis from reference row
      const refSweeps = yLevels.get(bestRowY) ?? [];
      if (refSweeps.length < 2) continue;
      refSweeps.sort((a, b) => a - b);
      const refStart = refSweeps[0];

      // Generate expected grid positions
      for (let gy = yMin; gy <= yMax; gy += vSpacing) {
        // Count how many expected positions in this row already have windows
        let expectedCount = 0;
        let filledCount = 0;
        const missingPositions: number[] = [];

        for (let gs = refStart; gs <= sweepMax; gs += hSpacing) {
          expectedCount++;
          if (candidateGrid.has(`${gs},${gy}`)) {
            filledCount++;
          } else {
            missingPositions.push(gs);
          }
        }

        // Fill if >60% of row already has windows
        if (expectedCount > 0 && filledCount / expectedCount > 0.6) {
          for (const gs of missingPositions) {
            const fx = isXFace ? candidates[0].x : gs;
            const fz = isXFace ? gs : candidates[0].z;
            if (fx < 0 || fx >= width || fz < 0 || fz >= length) continue;
            if (gy < 0 || gy >= height) continue;
            const existing = grid.get(fx, gy, fz);
            if (existing === AIR || GLASS_BLOCKS.has(existing)) continue;
            // Only fill if this position is on the facade (has air neighbor in face direction)
            const checkX = fx + face.dx, checkZ = fz + face.dz;
            const isOnFacade = checkX < 0 || checkX >= width || checkZ < 0 || checkZ >= length ||
              grid.get(checkX, gy, checkZ) === AIR;
            if (isOnFacade) {
              grid.set(fx, gy, fz, GLASS);
              totalGlazed++;
            }
          }
        }
      }
    }
  }

  return totalGlazed;
}

/**
 * Inject synthetic windows on exterior facade blocks that lack dark-block windows.
 *
 * When the color pipeline produces a uniformly light facade (e.g. ESB at 78%
 * white_concrete), glazeDarkWindows can't find dark blocks to convert.
 * This function detects floor boundaries from horizontal band analysis and places
 * gray_stained_glass windows in a regular grid pattern between floors.
 *
 * Pattern: 1-block window every 2-3 blocks along the facade, at 2/3 of each
 * floor height. Only modifies exterior facade blocks that are the dominant
 * facade material (to avoid overwriting trim, corners, or accent blocks).
 *
 * @param grid  Source BlockGrid (modified in place)
 * @param existingGlazed  Number of blocks already glazed by glazeDarkWindows
 * @returns Number of blocks converted to windows
 */
export function injectSyntheticWindows(grid: BlockGrid, existingGlazed: number, resolution = 1): number {
  const { width, height, length } = grid;

  const GLASS = 'minecraft:gray_stained_glass';

  // Only inject if existing glazing was minimal (< 0.5% of non-air blocks)
  const nonAir = grid.countNonAir();
  if (existingGlazed > nonAir * 0.005) return 0;
  // Scale minimum height with resolution: 8m = 24 blocks at res 3
  if (height < Math.max(8, Math.round(8 * resolution))) return 0;

  // Horizontal directions for facade detection


  // Step 1: Find dominant facade material by counting exterior surface blocks
  const facadeCounts = new Map<string, number>();
  for (let y = 2; y < height - 1; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR || block === GLASS) continue;

        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true; break;
          }
        }
        if (isFacade) {
          facadeCounts.set(block, (facadeCounts.get(block) ?? 0) + 1);
        }
      }
    }
  }

  if (facadeCounts.size === 0) return 0;

  // Find dominant facade block (must be > 40% of facade)
  let totalFacade = 0;
  let dominantBlock = '';
  let dominantCount = 0;
  for (const [block, count] of facadeCounts) {
    totalFacade += count;
    if (count > dominantCount) { dominantCount = count; dominantBlock = block; }
  }
  if (dominantCount < totalFacade * 0.4) return 0; // no clear dominant material

  // Step 2: Detect floor boundaries using Y-layer block density analysis
  // Each Y-layer has a count of solid blocks. Floor/ceiling slabs show as high-density
  // horizontal bands. The gaps between them are where windows go.
  const layerDensity = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) count++;
      }
    }
    layerDensity[y] = count / (width * length);
  }

  // Estimate floor height from autocorrelation of density profile.
  // At 1 block/m floors are 3-4 blocks; at 3 blocks/m floors are 9-12 blocks.
  const minPeriod = Math.round(3 * resolution);
  const maxPeriod = Math.round(5 * resolution);
  let bestPeriod = minPeriod;
  let bestCorr = -1;
  for (let period = minPeriod; period <= maxPeriod; period++) {
    let corr = 0;
    let count = 0;
    for (let y = 0; y + period < height; y++) {
      corr += layerDensity[y] * layerDensity[y + period];
      count++;
    }
    corr = count > 0 ? corr / count : 0;
    if (corr > bestCorr) { bestCorr = corr; bestPeriod = period; }
  }

  // Step 3: Place windows on exterior dominant-material blocks at regular intervals
  // Window placement: every bestPeriod Y-layers, skip 1 block from floor, place window
  // Horizontally: every 2-3 blocks along the facade
  let injected = 0;
  // Scale foundation skip with resolution: 3m at res 3 = 9 blocks
  const MIN_Y = Math.max(3, Math.round(3 * resolution));

  for (let y = MIN_Y; y < height - 2; y++) {
    // Window rows: not at the very top or bottom of each floor
    const floorPos = y % bestPeriod;
    if (floorPos === 0 || floorPos === bestPeriod - 1) continue; // skip floor/ceiling layers

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block !== dominantBlock) continue;

        // Must be exterior facade
        let isFacade = false;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            isFacade = true; break;
          }
        }
        if (!isFacade) continue;

        // Horizontal spacing: window every 3*resolution blocks (scale with resolution)
        // Use (x + z) to create a consistent pattern across facades
        const hSpacing = Math.max(3, Math.round(3 * resolution));
        if ((x + z) % hSpacing !== 0) continue;

        // Don't place windows on corner blocks (where two facades meet)
        let facadeCount = 0;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
              grid.get(nx, y, nz) === AIR) {
            facadeCount++;
          }
        }
        if (facadeCount > 1) continue; // corner — skip

        grid.set(x, y, z, GLASS);
        injected++;
      }
    }
  }

  return injected;
}

/**
 * Detect and regularize windows on building facades, then add doors.
 *
 * For each facade face (N/S/E/W), projects facade blocks to a 2D bitmap.
 * Connected components of glass/dark blocks identify existing window clusters.
 * If windows were detected, snaps them to a regular grid (median spacing).
 * If < 3 windows detected, injects a regular window pattern.
 *
 * Also detects and places doors: lowest dark/glass cluster on the front face
 * touching ground level, 2+ blocks wide.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param groundY       Ground plane Y level
 * @returns Object with counts of windows regularized and doors placed
 */
export function detectAndRegularizeWindows(
  grid: BlockGrid,
  groundY = 0,
): { windowsRegularized: number; doorsPlaced: number } {
  const { width, height, length } = grid;

  const GLASS = 'minecraft:gray_stained_glass';
  const DOOR_BOTTOM = 'minecraft:oak_door[half=lower,facing=south]';
  const DOOR_TOP = 'minecraft:oak_door[half=upper,facing=south]';

  let windowsRegularized = 0;
  let doorsPlaced = 0;

  // Process each of 4 facade faces
  type FaceDir = { name: string; normal: [number, number]; facadeAxis: 'x' | 'z'; sweepAxis: 'z' | 'x' };
  const faces: FaceDir[] = [
    { name: 'north', normal: [0, -1], facadeAxis: 'z', sweepAxis: 'x' },
    { name: 'south', normal: [0, 1], facadeAxis: 'z', sweepAxis: 'x' },
    { name: 'west', normal: [-1, 0], facadeAxis: 'x', sweepAxis: 'z' },
    { name: 'east', normal: [1, 0], facadeAxis: 'x', sweepAxis: 'z' },
  ];

  // Find building bounds
  let bMinX = width, bMaxX = 0, bMinZ = length, bMaxZ = 0;
  let bMinY = height, bMaxY = 0;
  for (let y = groundY; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          bMinX = Math.min(bMinX, x); bMaxX = Math.max(bMaxX, x);
          bMinZ = Math.min(bMinZ, z); bMaxZ = Math.max(bMaxZ, z);
          bMinY = Math.min(bMinY, y); bMaxY = Math.max(bMaxY, y);
        }
      }
    }
  }
  if (bMaxY - bMinY < 4) return { windowsRegularized: 0, doorsPlaced: 0 };

  for (const face of faces) {
    // Determine facade plane position (outermost row of blocks for this face)
    let facadePos: number;
    const sweepRange: [number, number] = [0, 0];
    if (face.name === 'north') { facadePos = bMinZ; sweepRange[0] = bMinX; sweepRange[1] = bMaxX; }
    else if (face.name === 'south') { facadePos = bMaxZ; sweepRange[0] = bMinX; sweepRange[1] = bMaxX; }
    else if (face.name === 'west') { facadePos = bMinX; sweepRange[0] = bMinZ; sweepRange[1] = bMaxZ; }
    else { facadePos = bMaxX; sweepRange[0] = bMinZ; sweepRange[1] = bMaxZ; }

    // Project facade into 2D bitmap (sweep axis × Y)
    const facadeWidth = sweepRange[1] - sweepRange[0] + 1;
    const facadeHeight = bMaxY - bMinY + 1;
    if (facadeWidth < 3 || facadeHeight < 4) continue;

    // Count existing windows on this face
    let existingWindows = 0;
    const windowPositions: { s: number; y: number }[] = []; // sweep, y coords of windows

    for (let s = sweepRange[0]; s <= sweepRange[1]; s++) {
      for (let y = bMinY + 2; y <= bMaxY - 1; y++) {
        const [x, z] = face.sweepAxis === 'x' ? [s, facadePos] : [facadePos, s];
        const block = grid.get(x, y, z);
        if (WINDOW_BLOCKS.has(block)) {
          existingWindows++;
          windowPositions.push({ s: s - sweepRange[0], y: y - bMinY });
        }
      }
    }

    // If we have enough windows, try to regularize their spacing
    if (windowPositions.length >= 3) {
      // Find median horizontal spacing between windows on the same Y level
      const yGroups = new Map<number, number[]>();
      for (const wp of windowPositions) {
        if (!yGroups.has(wp.y)) yGroups.set(wp.y, []);
        yGroups.get(wp.y)!.push(wp.s);
      }

      const spacings: number[] = [];
      for (const [, positions] of yGroups) {
        positions.sort((a, b) => a - b);
        for (let i = 1; i < positions.length; i++) {
          const gap = positions[i] - positions[i - 1];
          if (gap >= 2 && gap <= 6) spacings.push(gap);
        }
      }

      if (spacings.length >= 2) {
        // Median spacing for regularization
        spacings.sort((a, b) => a - b);
        const medianSpacing = spacings[Math.floor(spacings.length / 2)];

        // Find median vertical spacing
        const sGroups = new Map<number, number[]>();
        for (const wp of windowPositions) {
          if (!sGroups.has(wp.s)) sGroups.set(wp.s, []);
          sGroups.get(wp.s)!.push(wp.y);
        }
        const vSpacings: number[] = [];
        for (const [, positions] of sGroups) {
          positions.sort((a, b) => a - b);
          for (let i = 1; i < positions.length; i++) {
            const gap = positions[i] - positions[i - 1];
            if (gap >= 2 && gap <= 6) vSpacings.push(gap);
          }
        }
        const medianVSpacing = vSpacings.length > 0
          ? vSpacings.sort((a, b) => a - b)[Math.floor(vSpacings.length / 2)]
          : 3;

        // Place regularized window grid
        // Start from the first detected window position, snap to grid
        const startS = windowPositions.length > 0
          ? windowPositions[0].s % medianSpacing
          : 1;
        const startY = windowPositions.length > 0
          ? (windowPositions[0].y - 2) % medianVSpacing + 2
          : 2;

        for (let sy = startY; sy < facadeHeight - 1; sy += medianVSpacing) {
          for (let ss = startS; ss < facadeWidth - 1; ss += medianSpacing) {
            const absS = sweepRange[0] + ss;
            const absY = bMinY + sy;
            const [x, z] = face.sweepAxis === 'x' ? [absS, facadePos] : [facadePos, absS];

            if (!grid.inBounds(x, absY, z)) continue;
            const current = grid.get(x, absY, z);
            // Only place window on solid non-air, non-glass blocks
            if (current === AIR || WINDOW_BLOCKS.has(current)) continue;

            grid.set(x, absY, z, GLASS);
            windowsRegularized++;
          }
        }
      }
    }

    // Door detection: lowest facade cluster touching ground, 2+ blocks wide
    if (face.name === 'south' || face.name === 'north') { // front faces
      const doorY = groundY + 1;
      if (doorY + 1 < height) {
        // Find a 2-block-wide gap or dark region at ground level on this face
        for (let s = sweepRange[0] + 1; s <= sweepRange[1] - 1; s++) {
          const [x, z] = face.sweepAxis === 'x' ? [s, facadePos] : [facadePos, s];
          const block = grid.get(x, doorY, z);
          const blockAbove = grid.get(x, doorY + 1, z);
          // Only place door where facade has solid blocks (to replace, not in air)
          if (block !== AIR && blockAbove !== AIR &&
              !WINDOW_BLOCKS.has(block) && doorsPlaced === 0) {
            grid.set(x, doorY, z, DOOR_BOTTOM);
            grid.set(x, doorY + 1, z, DOOR_TOP);
            doorsPlaced++;
            break; // one door per building
          }
        }
      }
    }
  }

  return { windowsRegularized, doorsPlaced };
}
