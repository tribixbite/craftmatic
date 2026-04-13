/**
 * Core geometry and morphology operations on BlockGrid voxel grids.
 *
 * Morphological close/open, surface erosion, interior filling,
 * surface smoothing, rectangularization, and roof construction.
 * Split from geometry.ts.
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR, H_DIRS, FACES6, snapshotGrid } from './_internal.js';

// ─── Morphological operations ───────────────────────────────────────────────

/**
 * Morphological close (dilate→erode) in 3D to fill small gaps in voxel shells.
 *
 * The dilation assigns each new voxel the most common block in its neighborhood,
 * so filled gaps take on the local wall material (not a random block).
 *
 * @param grid    Source BlockGrid (modified in place)
 * @param radius  Structuring element radius (default: 1 = fills 1-voxel gaps)
 * @returns Number of voxels changed (net fills after erode)
 */
export function morphClose3D(grid: BlockGrid, radius = 1, maxY?: number, resolution = 1): number {
  const { width, height, length } = grid;
  // Scale radius by resolution (higher resolution = larger kernel needed)
  const scaledRadius = Math.max(1, Math.round(radius * resolution));
  // Optional Y limit — only process layers 0..maxY (protects crown/spire/dome above)
  const yLimit = maxY !== undefined ? Math.min(maxY, height) : height;

  // Snapshot before dilation
  const before: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        before[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  // ── Dilate: expand solid voxels into adjacent air ──
  // For each air voxel, check if any solid neighbor within radius exists.
  // If so, assign the most common neighbor block.
  let dilated = 0;
  for (let y = 0; y < yLimit; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (before[(y * length + z) * width + x] !== 'minecraft:air') continue;

        // Count solid neighbors within radius
        const counts = new Map<string, number>();
        let hasSolid = false;
        for (let dy = -scaledRadius; dy <= scaledRadius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dz = -scaledRadius; dz <= scaledRadius; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue;
            for (let dx = -scaledRadius; dx <= scaledRadius; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue;
              const nb = before[(ny * length + nz) * width + nx];
              if (nb !== 'minecraft:air') {
                counts.set(nb, (counts.get(nb) ?? 0) + 1);
                hasSolid = true;
              }
            }
          }
        }

        if (hasSolid) {
          // Assign the most common neighbor block
          let best = 'minecraft:stone';
          let bestCount = 0;
          for (const [block, count] of counts) {
            if (count > bestCount) { best = block; bestCount = count; }
          }
          grid.set(x, y, z, best);
          dilated++;
        }
      }
    }
  }

  // ── Erode: remove voxels that were solid in dilated but air in original ──
  // Only remove voxels on the OUTER surface — voxels that were air before
  // dilation AND have at least one air neighbor now. Interior fills are kept.
  // Actually, standard morphological closing erodes back by checking: if a
  // voxel was air in the original, and ALL its neighbors within radius are
  // solid (meaning it's truly interior), keep it. Otherwise, restore to air.
  let eroded = 0;
  // Snapshot the dilated state
  const afterDilate: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        afterDilate[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  for (let y = 0; y < yLimit; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        // Only consider voxels that were added by dilation (were air before)
        if (before[(y * length + z) * width + x] !== 'minecraft:air') continue;
        if (afterDilate[(y * length + z) * width + x] === 'minecraft:air') continue;

        // Check if this voxel has any air neighbor within radius in dilated state.
        // If it does, it's on the outer surface of the dilation — erode it back.
        let hasAirNeighbor = false;
        for (let dy = -scaledRadius; dy <= scaledRadius && !hasAirNeighbor; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue; // OOB = solid (standard morphClose boundary)
          for (let dz = -scaledRadius; dz <= scaledRadius && !hasAirNeighbor; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue; // OOB = solid
            for (let dx = -scaledRadius; dx <= scaledRadius && !hasAirNeighbor; dx++) {
              const nx = x + dx;
              if (nx < 0 || nx >= width) continue; // OOB = solid
              if (afterDilate[(ny * length + nz) * width + nx] === 'minecraft:air') {
                hasAirNeighbor = true;
              }
            }
          }
        }

        if (hasAirNeighbor) {
          grid.set(x, y, z, 'minecraft:air');
          eroded++;
        }
      }
    }
  }

  return dilated - eroded; // Net voxels filled
}

// ─── Surface erosion / smoothing ────────────────────────────────────────────

/**
 * Erode surface protrusions by removing solid voxels with too few solid
 * face-adjacent neighbors (6-connected). Then dilate back to restore
 * wall thickness. This shaves off the 1-block bumps caused by noisy
 * photogrammetry mesh surfaces.
 *
 * A block with <minNeighbors solid face-neighbors is considered a protrusion.
 * After removing protrusions, a dilation pass fills back voxels that have
 * >=minNeighbors solid face-neighbors, restoring legitimate wall surface.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param minNeighbors  Min solid face-neighbors to keep (default: 3 of 6)
 * @returns Net voxels removed
 */
export function erodeSurfaceBumps(grid: BlockGrid, minNeighbors = 3): number {
  const { width, height, length } = grid;


  // Snapshot before erosion
  const snap = snapshotGrid(grid);

  // Erode: remove blocks with fewer than minNeighbors solid face-neighbors
  let eroded = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (snap[(y * length + z) * width + x] === AIR) continue;

        let solidFaces = 0;
        for (const [dx, dy, dz] of FACES6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
            if (snap[(ny * length + nz) * width + nx] !== AIR) solidFaces++;
          }
        }

        if (solidFaces < minNeighbors) {
          grid.set(x, y, z, AIR);
          eroded++;
        }
      }
    }
  }

  // Dilate back: fill air voxels that now have >=minNeighbors solid face-neighbors.
  // Use the eroded grid state (not snapshot) for neighbor counting.
  // Assign the most common neighbor block.
  let dilated = 0;
  // Snapshot the eroded state
  const erodedSnap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        erodedSnap[(y * length + z) * width + x] = grid.get(x, y, z);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (erodedSnap[(y * length + z) * width + x] !== AIR) continue;

        let solidFaces = 0;
        const counts = new Map<string, number>();
        for (const [dx, dy, dz] of FACES6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
            const nb = erodedSnap[(ny * length + nz) * width + nx];
            if (nb !== AIR) {
              solidFaces++;
              counts.set(nb, (counts.get(nb) ?? 0) + 1);
            }
          }
        }

        if (solidFaces >= minNeighbors) {
          // Pick most common neighbor
          let best = 'minecraft:stone';
          let bestC = 0;
          for (const [b, c] of counts) {
            if (c > bestC) { best = b; bestC = c; }
          }
          grid.set(x, y, z, best);
          dilated++;
        }
      }
    }
  }

  return eroded - dilated;
}

// ─── Hole filling ───────────────────────────────────────────────────────────

/**
 * Fill air holes on facades and interior surfaces with iterative convergence.
 *
 * Each pass fills air voxels with `minSolid`+ solid face-neighbors, assigning
 * the most common neighbor block. Multiple passes gradually close larger holes
 * from the walls inward — pass 1 fills strict 1-block holes, pass 2 fills the
 * next ring (now exposed by pass-1 fills), and so on up to `maxPasses`.
 *
 * This catches the visible "black pixel" holes on otherwise solid facades
 * that morphClose3D (radius=1) misses because it operates as dilate+erode
 * rather than targeted single-voxel infill.
 *
 * @param grid  Source BlockGrid (modified in place)
 * @param minSolid  Minimum face-adjacent solid neighbors to consider a hole (default: 4)
 * @param maxPasses  Maximum fill iterations (default: 1). Higher values risk filling
 *   intentional openings (courtyards, walkways). Use 1 for safety.
 * @returns Number of air voxels filled across all passes
 */
export function fillFacadeHoles(grid: BlockGrid, minSolid = 4, maxPasses = 1): number {
  const { width, height, length } = grid;




  let totalFilled = 0;

  for (let pass = 0; pass < maxPasses; pass++) {
    // Fresh snapshot each pass so we see previous pass's fills as solid
    const snap = snapshotGrid(grid);

    let passFilled = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (snap[(y * length + z) * width + x] !== AIR) continue;

          // Count solid face-neighbors and track block types
          let solidFaces = 0;
          const counts = new Map<string, number>();
          for (const [dx, dy, dz] of FACES6) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
              const nb = snap[(ny * length + nz) * width + nx];
              if (nb !== AIR) {
                solidFaces++;
                counts.set(nb, (counts.get(nb) ?? 0) + 1);
              }
            }
          }

          if (solidFaces >= minSolid) {
            let best = 'minecraft:stone';
            let bestC = 0;
            for (const [b, c] of counts) {
              if (c > bestC) { best = b; bestC = c; }
            }
            grid.set(x, y, z, best);
            passFilled++;
          }
        }
      }
    }

    totalFilled += passFilled;
    // Converged — no more holes to fill
    if (passFilled === 0) break;
  }

  return totalFilled;
}

/**
 * Remove isolated single voxels with very few solid neighbors.
 *
 * Targets scattered 1-block artifacts — the "noise dots" visible in topdown
 * and facade views. These are typically photogrammetry fragments that survive
 * component filtering because they touch the main body at a single face.
 *
 * Only removes voxels with 0 or 1 solid face-neighbor to avoid eroding
 * legitimate thin features (cornices, antenna bases, etc).
 *
 * @param grid  Source BlockGrid (modified in place)
 * @param maxNeighbors  Maximum solid face-neighbors to consider isolated (default: 1)
 * @returns Number of voxels removed
 */
export function removeIsolatedVoxels(grid: BlockGrid, maxNeighbors = 1): number {
  const { width, height, length } = grid;




  // Snapshot for consistent reads
  const snap = snapshotGrid(grid);

  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (snap[(y * length + z) * width + x] === AIR) continue;

        let solidFaces = 0;
        for (const [dx, dy, dz] of FACES6) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
            if (snap[(ny * length + nz) * width + nx] !== AIR) solidFaces++;
          }
        }

        if (solidFaces <= maxNeighbors) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ─── Interior filling ───────────────────────────────────────────────────────

/**
 * Fill building interiors using 2D flood-fill per Y-layer.
 *
 * Photogrammetry meshes produce porous voxel shells — surfaces riddled with
 * 1-2 voxel gaps. This function identifies true building interiors vs exterior
 * air using a per-layer approach:
 *
 * For each Y slice:
 * 1. Dilate solid voxels by `dilateRadius` to close wall porosity
 * 2. Flood-fill from grid edges on the dilated layer → marks "exterior" air
 * 3. Any air NOT reachable from edges is "interior" → fill with nearest block
 *
 * Uses 3D Masked Dilation for robust leak-prevention:
 * 1. Create a temporary 3D mask where solid walls are dilated by `dilateRadius`
 *    to virtually close all photogrammetry porosity and cracks.
 * 2. Run a 3D flood-fill from all 6 grid boundaries through the dilated mask
 *    to identify true "exterior" air (reachable from outside).
 * 3. Fill only voxels that are air in the ORIGINAL un-dilated grid AND were
 *    not reached by the flood fill (= interior gaps).
 *
 * This gives the leak-prevention of high dilation while preserving the crisp
 * exterior geometry of the original shell. A 3D flood fill (vs per-Y-layer 2D)
 * is exponentially more robust — a window open on layer Y=10 doesn't leak if
 * Y=9 and Y=11 are solid, since the 3D fill requires a continuous 3D tunnel.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param dilateRadius  Dilation radius for the virtual mask (default: 2)
 * @param resolution    Blocks per meter scaling factor (default: 1)
 * @param filledSet     Optional set to track flat indices of filled voxels.
 *   Formula: `(y * grid.length + z) * grid.width + x`. When provided, each filled
 *   voxel's index is added so callers can distinguish fills from original geometry.
 * @returns Number of interior air voxels filled
 */
export function fillInteriorGaps(grid: BlockGrid, dilateRadius = 2, resolution = 1, filledSet?: Set<number>): number {
  const { width, height, length } = grid;
  // Scale dilation radius by resolution (higher resolution = larger dilation needed)
  const scaledRadius = Math.max(1, Math.round(dilateRadius * resolution));

  const totalSize = width * height * length;
  let netFilled = 0;

  // ── Step 1: Snapshot original solid state ──
  const originalSolid = new Uint8Array(totalSize);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          originalSolid[(y * length + z) * width + x] = 1;
        }
      }
    }
  }

  // ── Step 2: Multi-pass 3D dilation (6-connected) to create leak-proof mask ──
  // Each pass expands solid blocks by 1 in all 6 directions (Manhattan distance).
  // scaledRadius closes gaps proportional to voxel resolution.
  let currentMask = new Uint8Array(originalSolid);
  for (let step = 0; step < scaledRadius; step++) {
    const nextMask = new Uint8Array(currentMask);
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * length + z) * width + x;
          if (currentMask[idx]) {
            for (const [dx, dy, dz] of FACES6) {
              const nx = x + dx, ny = y + dy, nz = z + dz;
              if (nx >= 0 && nx < width && ny >= 0 && ny < height && nz >= 0 && nz < length) {
                nextMask[(ny * length + nz) * width + nx] = 1;
              }
            }
          }
        }
      }
    }
    currentMask = nextMask;
  }
  const dilatedMask = currentMask;

  // ── Step 3: 3D flood fill from grid boundaries to find exterior air ──
  // Seed all 6 outer faces. Any air cell reachable through the dilated mask
  // from a boundary is exterior. Interior pockets are unreachable.
  const exterior = new Uint8Array(totalSize);
  // Use Int32Array as queue for performance (avoid GC from push/shift)
  const q = new Int32Array(totalSize);
  let qHead = 0, qTail = 0;

  // Seed boundary cells that are air in the dilated mask
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (x !== 0 && x !== width - 1 && y !== 0 && y !== height - 1 && z !== 0 && z !== length - 1) continue;
        const idx = (y * length + z) * width + x;
        if (!dilatedMask[idx] && !exterior[idx]) {
          exterior[idx] = 1;
          q[qTail++] = idx;
        }
      }
    }
  }

  // BFS 3D flood fill (6-connected)
  while (qHead < qTail) {
    const idx = q[qHead++];
    const x = idx % width;
    const z = Math.floor(idx / width) % length;
    const y = Math.floor(idx / (width * length));

    for (const [dx, dy, dz] of FACES6) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
      const nIdx = (ny * length + nz) * width + nx;
      if (dilatedMask[nIdx] || exterior[nIdx]) continue; // Wall or already visited
      exterior[nIdx] = 1;
      q[qTail++] = nIdx;
    }
  }

  // ── Step 4: Fill interior gaps in the ORIGINAL grid ──
  // Only voxels that were air in the original AND not reached by flood fill.
  // Use smooth_stone for interior fill: neutral gray that reads as depth
  // through shell gaps. NOT in glazeDarkWindows SHADOW_BLOCKS, so fill
  // blocks won't be mistakenly glazed as windows.
  const FILL_BLOCK = 'minecraft:smooth_stone';
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (originalSolid[idx] || exterior[idx]) continue; // Solid or exterior
        grid.set(x, y, z, FILL_BLOCK);
        netFilled++;
        // Track filled voxel index if caller wants to distinguish fills from originals
        if (filledSet) filledSet.add(idx);
      }
    }
  }

  return netFilled;
}

/**
 * Scanline-based interior fill — 2D per-Y-slice with sky-visibility check.
 *
 * Algorithm:
 * 1. For each Y-layer, scanline-fill in both X and Z directions
 * 2. A voxel is "interior" if BOTH X-scanline AND Z-scanline agree (odd crossing)
 * 3. Sky-visibility check: if a voxel has an unobstructed vertical path to the
 *    sky (no solid block above), it's exterior (courtyard/open-air) — skip filling
 *
 * Compared to `fillInteriorGaps` (dilation + 3D flood):
 * - Faster: O(W×H×L) scanlines vs O(W×H×L × dilateRadius³) dilation
 * - Better courtyard handling: sky-check is inherent, not post-hoc
 * - May miss some interior pockets in 3D — use as complement, not replacement
 *
 * @param grid       Source BlockGrid (modified in place)
 * @param filledSet  Optional set to track flat indices `(y * L + z) * W + x` of
 *   filled voxels. When provided, callers can later distinguish fills from originals.
 * @returns Number of interior air voxels filled
 */
export function scanlineInteriorFill(grid: BlockGrid, filledSet?: Set<number>): number {

  const FILL_BLOCK = 'minecraft:smooth_stone';
  const { width, height, length } = grid;
  let filled = 0;

  // Pre-compute sky-visibility map: for each (x,z), find the topmost solid Y.
  // A voxel at (x, y, z) has sky visibility if there's no solid block above it
  // (i.e., y > topSolid for that column).
  const topSolid = new Int32Array(width * length);
  topSolid.fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          topSolid[z * width + x] = y;
          break;
        }
      }
    }
  }

  for (let y = 0; y < height; y++) {
    // X-direction scanline: for each Z row, count boundary crossings traversing X
    const insideX = new Uint8Array(width * length);
    for (let z = 0; z < length; z++) {
      let crossings = 0;
      let prevSolid = false;
      for (let x = 0; x < width; x++) {
        const solid = grid.get(x, y, z) !== AIR;
        // Transition from air→solid = entering wall
        if (solid && !prevSolid) crossings++;
        // Transition from solid→air = exiting wall (only count one transition per wall)
        if (!solid && prevSolid) {
          // We're now in a region after an odd number of crossings = inside
        }
        if (!solid) {
          insideX[z * width + x] = crossings % 2 === 1 ? 1 : 0;
        }
        prevSolid = solid;
      }
    }

    // Z-direction scanline: for each X column, count boundary crossings traversing Z
    const insideZ = new Uint8Array(width * length);
    for (let x = 0; x < width; x++) {
      let crossings = 0;
      let prevSolid = false;
      for (let z = 0; z < length; z++) {
        const solid = grid.get(x, y, z) !== AIR;
        if (solid && !prevSolid) crossings++;
        if (!solid) {
          insideZ[z * width + x] = crossings % 2 === 1 ? 1 : 0;
        }
        prevSolid = solid;
      }
    }

    // Fill voxels that BOTH scanlines agree are interior AND have no sky visibility
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) continue;
        const xzIdx = z * width + x;
        if (insideX[xzIdx] && insideZ[xzIdx]) {
          // Sky-visibility check: if there's a solid block above this position,
          // it's under a roof → safe to fill. If sky is visible → courtyard → skip.
          const top = topSolid[xzIdx];
          if (top > y) {
            grid.set(x, y, z, FILL_BLOCK);
            filled++;
            // Track filled voxel flat index if caller wants to distinguish fills from originals
            if (filledSet) filledSet.add((y * length + z) * width + x);
          }
        }
      }
    }
  }

  return filled;
}

/**
 * Remove fill blocks that have no solid (non-fill) roof above them.
 *
 * After fillInteriorGaps, stadiums, courtyards, and open-air spaces may be
 * incorrectly filled because the dilation mask closed small rim/wall gaps.
 * This pass checks each fill voxel for a vertical line-of-sight to the sky:
 * - If a fill voxel has a non-fill solid block anywhere above it → keep (under a roof)
 * - If a fill voxel has only air or other fill above → remove (open-air space)
 *
 * To avoid false-clearing on buildings truncated by capture radius (where the top
 * has no roof simply because capture was too short), requires a minimum vertical
 * clearance of `minClearance` air/fill layers above the fill before classifying
 * as open-air. This prevents removing fill at truncation boundaries where the
 * building simply extends beyond the grid.
 *
 * @param grid          Source BlockGrid (modified in place)
 * @param fillBlock     The block ID used by fillInteriorGaps (default: smooth_stone)
 * @param minClearance  Minimum air layers above fill before classifying as open-air (default: 5)
 * @param filledSet     Optional set of flat indices `(y * L + z) * W + x` produced by
 *   fillInteriorGaps/scanlineInteriorFill. When provided, only voxels in this set
 *   are cleared — original geometry blocks that happen to match `fillBlock` are preserved.
 * @returns             Number of fill blocks removed
 */
export function clearOpenAirFill(
  grid: BlockGrid,
  fillBlock = 'minecraft:smooth_stone',
  minClearance = 5,
  filledSet?: Set<number>,
): number {
  const { width, height, length } = grid;


  // 2D connected-component approach:
  // 1. Build XZ mask of "open-air columns" — has fill, no solid roof above, sufficient clearance
  // 2. 4-connected flood fill to find contiguous open-air regions
  // 3. Only clear fill in large regions (≥MIN_OPEN_AIR_COLUMNS) — stadiums/courtyards are large,
  //    truncation artifacts from missing roof are small/scattered
  const MIN_OPEN_AIR_COLUMNS = 25; // ~5×5m² minimum open-air region

  // Step 1: Build XZ "open-air" mask
  // A column is "open-air" if it has fill blocks AND no solid (non-fill) roof above them
  // AND has sufficient vertical clearance above the topmost real block
  const openAirMask = new Uint8Array(width * length); // 1 = open-air column

  // Minimum real blocks above fill to count as "roofed" — thin photogrammetry
  // artifacts (1 block) shouldn't prevent courtyard clearing, but 2+ blocks of
  // solid roof should be trusted even if photogrammetry is imperfect.
  const MIN_ROOF_THICKNESS = 2;

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      let hasFill = false;
      let topRealY = -1;
      let realBlocksAboveFill = 0;

      // Top-down scan: find topmost real block, count real blocks above fill
      let seenFill = false;
      for (let y = height - 1; y >= 0; y--) {
        const block = grid.get(x, y, z);
        if (block !== AIR && block !== fillBlock) {
          if (topRealY < 0) topRealY = y;
          if (!seenFill) realBlocksAboveFill++;
        } else if (block === fillBlock) {
          hasFill = true;
          seenFill = true;
        }
      }

      // Column is open-air if: has fill, no SUBSTANTIAL roof above fill, sufficient clearance.
      // A "substantial roof" requires MIN_ROOF_THICKNESS real blocks above the fill —
      // this prevents thin photogrammetry artifacts from masking courtyards.
      const hasRoofAboveFill = realBlocksAboveFill >= MIN_ROOF_THICKNESS;
      const clearanceAbove = topRealY >= 0 ? (height - 1 - topRealY) : 0;
      if (hasFill && !hasRoofAboveFill && clearanceAbove >= minClearance) {
        openAirMask[z * width + x] = 1;
      }
    }
  }

  // Step 2: 4-connected flood fill to find connected components
  const componentId = new Int32Array(width * length); // 0 = unassigned
  const componentSizes: Map<number, number> = new Map();
  let nextId = 1;

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const idx = z * width + x;
      if (openAirMask[idx] !== 1 || componentId[idx] !== 0) continue;

      // BFS flood fill for this component
      const id = nextId++;
      const queue: number[] = [idx];
      let size = 0;
      componentId[idx] = id;

      while (queue.length > 0) {
        const cur = queue.pop()!;
        size++;
        const cx = cur % width;
        const cz = Math.floor(cur / width);

        // 4-connected neighbors
        const neighbors = [
          cz > 0 ? (cz - 1) * width + cx : -1,
          cz < length - 1 ? (cz + 1) * width + cx : -1,
          cx > 0 ? cz * width + (cx - 1) : -1,
          cx < width - 1 ? cz * width + (cx + 1) : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && openAirMask[ni] === 1 && componentId[ni] === 0) {
            componentId[ni] = id;
            queue.push(ni);
          }
        }
      }

      componentSizes.set(id, size);
    }
  }

  // Step 3: Clear fill only in columns belonging to large components.
  // When filledSet is provided, only clear voxels that were added by fill operations
  // (not original geometry). This prevents the destructive fill-then-clear cycle
  // from damaging real building geometry that happens to match the fill block.
  let removed = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const id = componentId[z * width + x];
      if (id === 0) continue;
      const size = componentSizes.get(id)!;
      if (size < MIN_OPEN_AIR_COLUMNS) continue;

      // Clear fill blocks in this open-air column (no roof above them)
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) === fillBlock) {
          const flatIdx = (y * length + z) * width + x;
          // If filledSet provided, only clear voxels that were filled (not original)
          if (filledSet && !filledSet.has(flatIdx)) continue;
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ─── Surface smoothing & rectangularization ─────────────────────────────────

/**
 * 2D morphological open (erode→dilate) per Y layer to smooth jagged surface.
 *
 * Photogrammetry mesh surfaces have ±1-block noise. The roof surface is especially
 * bumpy from photogrammetry mesh noise. This cleans it up.
 *
 * @param grid  Source BlockGrid (modified in place)
 * @returns Number of surface voxels removed
 */
export function smoothSurface(grid: BlockGrid, maxY?: number, preserveBoundary = false): number {
  const { width, height, length } = grid;

  let totalChanged = 0;
  // maxY: optional upper Y bound (exclusive) — skip smoothing above this layer
  // to preserve roof features (gables, peaks, dormers) that read as noise.
  const yLimit = maxY !== undefined ? Math.min(maxY, height) : height;

  // Face-adjacent offsets in XZ plane (4-connected)


  // v73: Compute footprint boundary mask — protects silhouette edges (tips, corners)
  // from erosion. Union of all Y layers' boundaries: any XZ position that has a solid
  // voxel adjacent to exterior air at any height is protected at ALL heights.
  let boundaryMask: Set<number> | null = null;
  if (preserveBoundary) {
    boundaryMask = new Set<number>();
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (grid.get(x, y, z) === AIR) continue;
          // Check if this solid voxel touches air in XZ
          for (const [dx, dz] of H_DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length ||
                grid.get(nx, y, nz) === AIR) {
              boundaryMask.add(z * width + x);
              break;
            }
          }
        }
      }
    }
  }

  for (let y = 0; y < yLimit; y++) {
    // Snapshot this layer
    const layer: boolean[] = new Array(width * length);
    const blocks: string[] = new Array(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        const b = grid.get(x, y, z);
        layer[idx] = b !== AIR;
        blocks[idx] = b;
      }
    }

    // Erode: remove solid voxels with < 2 solid 4-connected XZ neighbors
    // (these are 1-block protrusions on the surface)
    // v73: Skip erosion for boundary voxels when preserveBoundary is enabled
    const eroded: boolean[] = [...layer];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (!layer[idx]) continue;
        // Protect footprint boundary — tips, corners, edges
        if (boundaryMask?.has(idx)) continue;

        let solidNeighbors = 0;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (layer[nz * width + nx]) solidNeighbors++;
          }
        }

        if (solidNeighbors < 2) {
          eroded[idx] = false;
        }
      }
    }

    // Dilate: restore eroded voxels that have >=3 solid neighbors in eroded state
    // This recovers wall edges that were over-eroded
    const opened: boolean[] = [...eroded];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (eroded[idx]) continue; // Already solid

        let solidNeighbors = 0;
        for (const [dx, dz] of H_DIRS) {
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            if (eroded[nz * width + nx]) solidNeighbors++;
          }
        }

        if (solidNeighbors >= 3) {
          opened[idx] = true;
        }
      }
    }

    // Apply changes: remove voxels that were solid but now air
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (layer[idx] && !opened[idx]) {
          grid.set(x, y, z, AIR);
          totalChanged++;
        } else if (!layer[idx] && opened[idx]) {
          // Dilated back — find nearest block color
          let bestBlock = AIR;
          let bestDist = Infinity;
          for (const [dx, dz] of H_DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
              const nIdx = nz * width + nx;
              if (blocks[nIdx] !== AIR) {
                const dist = 1;
                if (dist < bestDist) { bestDist = dist; bestBlock = blocks[nIdx]; }
              }
            }
          }
          if (bestBlock !== AIR) {
            grid.set(x, y, z, bestBlock);
          }
        }
      }
    }
  }

  return totalChanged;
}

/**
 * Rectangularize building cross-sections using connected-component AABBs.
 *
 * For each Y layer:
 * 1. Find connected solid regions (4-connected BFS)
 * 2. Discard tiny regions (< minRegionSize voxels — noise/vegetation)
 * 3. For each significant region, compute axis-aligned bounding box (AABB)
 * 4. Fill the AABB with the region's dominant block → perfectly rectangular
 *
 * This replaces the organic outlines from photogrammetry with sharp-edged
 * rectangular building footprints. Separate buildings get separate rectangles
 * as long as they're not connected in that layer.
 *
 * @param grid           Source BlockGrid (modified in place)
 * @param minRegionSize  Minimum connected component size to keep (default: 20 voxels)
 * @param maxExtend      Max distance (Manhattan) from existing solid to fill (default: 2).
 *                        Prevents filling deep voids (balconies/recesses) while still
 *                        smoothing 1-2 block wall jaggedness. Set to Infinity for full AABB.
 * @param facadeDepth    Depth from AABB edges to preserve scan detail (default: 0 = disabled).
 *                        Cells within facadeDepth of any AABB face use maxExtend-limited fill.
 *                        Cells deeper than facadeDepth from all faces get full AABB fill.
 *                        This preserves balconies/recesses near facades while solidifying
 *                        building interiors.
 * @returns Number of voxels changed
 */
export function rectangularize(grid: BlockGrid, minRegionSize = 20, maxExtend = 2, facadeDepth = 0, resolution = 1): number {
  const { width, height, length } = grid;
  // Scale minRegionSize cubically (volume = length^3) and maxExtend linearly
  const scaledMinSize = Math.max(1, Math.round(minRegionSize * resolution * resolution * resolution));
  const scaledExtend = Math.max(1, Math.round(maxExtend * resolution));

  let changed = 0;

  for (let y = 0; y < height; y++) {
    // Snapshot the solid mask BEFORE rectangularization for distance checking
    const originalSolid: boolean[] = new Array(width * length);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        originalSolid[z * width + x] = grid.get(x, y, z) !== AIR;
      }
    }

    // Find connected components via BFS
    const visited = new Uint8Array(width * length);
    const regions: Array<{
      minX: number; maxX: number; minZ: number; maxZ: number;
      dominant: string; size: number;
    }> = [];

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (visited[idx] || !originalSolid[idx]) continue;

        // BFS flood fill to find connected region
        let minX = x, maxX = x, minZ = z, maxZ = z;
        const counts = new Map<string, number>();
        const queue: number[] = [idx];
        let head = 0;
        let size = 0;
        visited[idx] = 1;

        while (head < queue.length) {
          const ci = queue[head++];
          const cx = ci % width;
          const cz = (ci - cx) / width;
          size++;

          const block = grid.get(cx, y, cz);
          counts.set(block, (counts.get(block) ?? 0) + 1);
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cz < minZ) minZ = cz;
          if (cz > maxZ) maxZ = cz;

          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
            const ni = nz * width + nx;
            if (visited[ni] || !originalSolid[ni]) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }

        if (size < scaledMinSize) continue;

        let dominant = AIR;
        let maxC = 0;
        for (const [b, c] of counts) {
          if (c > maxC) { dominant = b; maxC = c; }
        }

        regions.push({ minX, maxX, minZ, maxZ, dominant, size });
      }
    }

    // Sort by size descending — larger regions get priority in overlaps
    regions.sort((a, b) => b.size - a.size);

    // Fill each region's AABB using hybrid strategy:
    // - Cells within facadeDepth of any AABB edge: distance-limited fill (preserves balconies)
    // - Cells deeper than facadeDepth from all edges: full fill (solidifies interior)
    // When facadeDepth=0, everything uses the maxExtend/full strategy.
    const claimed = new Uint8Array(width * length);
    for (const region of regions) {
      for (let z = region.minZ; z <= region.maxZ; z++) {
        for (let x = region.minX; x <= region.maxX; x++) {
          const idx = z * width + x;
          if (claimed[idx]) continue;

          if (originalSolid[idx]) {
            // Already solid — claim it
            claimed[idx] = 1;
            continue;
          }

          // Compute distance from this cell to the nearest AABB edge (in XZ).
          // Cells near the edge are in the "facade zone" and keep scan detail.
          const edgeDist = Math.min(
            x - region.minX,
            region.maxX - x,
            z - region.minZ,
            region.maxZ - z,
          );
          const inFacadeZone = facadeDepth > 0 && edgeDist < facadeDepth;

          if (inFacadeZone) {
            // Facade zone: only fill within scaledExtend of existing solid.
            // This preserves balconies, recesses, and other depth features.
            const effectiveMax = scaledExtend;
            let nearestDist = effectiveMax + 1;
            for (let dz2 = -effectiveMax; dz2 <= effectiveMax && nearestDist > 1; dz2++) {
              const nz = z + dz2;
              if (nz < region.minZ || nz > region.maxZ) continue;
              for (let dx2 = -effectiveMax; dx2 <= effectiveMax; dx2++) {
                const nx = x + dx2;
                if (nx < region.minX || nx > region.maxX) continue;
                const dist = Math.abs(dx2) + Math.abs(dz2);
                if (dist >= nearestDist) continue;
                if (originalSolid[nz * width + nx]) {
                  nearestDist = dist;
                }
              }
            }

            if (nearestDist <= effectiveMax) {
              grid.set(x, y, z, region.dominant);
              claimed[idx] = 1;
              changed++;
            }
          } else {
            // Core zone: full fill — solidify the building interior
            grid.set(x, y, z, region.dominant);
            claimed[idx] = 1;
            changed++;
          }
        }
      }
    }

    // Remove small isolated blocks not part of any region
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = z * width + x;
        if (grid.get(x, y, z) !== AIR && !claimed[idx]) {
          grid.set(x, y, z, AIR);
          changed++;
        }
      }
    }
  }

  return changed;
}

/**
 * Regularize a flat roof plane by filling holes and removing stray bumps.
 *
 * Photogrammetry roofs have scattered noise: random 1-2 block bumps above the
 * dominant roof plane, and small holes (missing blocks) in the otherwise flat
 * surface. This function identifies the primary roof Y level, fills holes where
 * air is surrounded by 3+ horizontal solid neighbors, and removes stray blocks
 * on Y levels above the roof that have very low fill.
 *
 * @param grid  BlockGrid (modified in place)
 * @returns Number of blocks changed (holes filled + bumps removed)
 */
export function regularizeFlatRoof(grid: BlockGrid): number {
  const { width, height, length } = grid;
  const area = width * length;
  if (area === 0 || height === 0) return 0;

  let changed = 0;

  // Find the roof plane: highest Y with >= 10% footprint fill
  const MIN_ROOF_FILL = 0.10;
  let roofY = -1;
  let roofFillCount = 0;
  for (let y = height - 1; y >= 0; y--) {
    let count = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) count++;
      }
    }
    if (count / area >= MIN_ROOF_FILL) {
      roofY = y;
      roofFillCount = count;
      break;
    }
  }

  if (roofY < 0) return 0; // No roof found

  // Remove stray bumps: Y levels above roofY with < 5% of roof fill are noise
  const BUMP_THRESHOLD = 0.05;
  for (let y = roofY + 1; y < height; y++) {
    let count = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) count++;
      }
    }
    if (count > 0 && count < roofFillCount * BUMP_THRESHOLD) {
      // Remove all blocks at this Y level (stray bumps)
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (grid.get(x, y, z) !== AIR) {
            grid.set(x, y, z, AIR);
            changed++;
          }
        }
      }
    }
  }

  // Fill holes on the roof Y plane: air surrounded by 3+ solid horizontal neighbors
  // Determine mode block on the roof level for uniform fill material
  const roofCounts = new Map<string, number>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const b = grid.get(x, roofY, z);
      if (b !== AIR) roofCounts.set(b, (roofCounts.get(b) ?? 0) + 1);
    }
  }
  let roofMode = 'minecraft:stone';
  let roofModeCount = 0;
  for (const [b, c] of roofCounts) {
    if (c > roofModeCount) { roofMode = b; roofModeCount = c; }
  }

  // Snapshot the roof layer for consistent reads during fill
  const roofSnap = new Array<string>(area);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      roofSnap[z * width + x] = grid.get(x, roofY, z);
    }
  }

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      if (roofSnap[z * width + x] !== AIR) continue;

      // Count solid horizontal neighbors (4-connected in XZ plane)
      let solidN = 0;
      for (const [dx, dz] of H_DIRS) {
        const nx = x + dx, nz = z + dz;
        if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
          if (roofSnap[nz * width + nx] !== AIR) solidN++;
        }
      }

      if (solidN >= 3) {
        grid.set(x, roofY, z, roofMode);
        changed++;
      }
    }
  }

  return changed;
}

/**
 * Add a hip/pyramid roof by stacking progressively inset footprints.
 * Each layer erodes the XZ footprint by 1 block and places it 1 Y higher.
 * Creates a natural sloped roof from any footprint shape (triangles, rectangles, L-shapes).
 *
 * @param grid       Source BlockGrid (modified in place)
 * @param roofBlock  Block for roof surface (default: same as topmost layer's dominant block)
 * @param maxLayers  Maximum number of roof layers to add (default: 15)
 * @returns          Number of blocks placed
 */
export function addPeakedRoof(
  grid: BlockGrid,
  roofBlock?: string,
  maxLayers = 15,
): number {
  const { width, height, length } = grid;

  let placed = 0;

  // Find the highest non-air Y for each (x, z) — the "roof surface"
  const heightMap = new Int32Array(width * length).fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightMap[z * width + x] = y;
          break;
        }
      }
    }
  }

  // Find the max height (roof level) and dominant roof block
  let maxH = 0;
  const blockCounts = new Map<string, number>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h > maxH) maxH = h;
    }
  }
  // Sample blocks at the top layer to find dominant roof block
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h >= maxH - 2) { // top 3 layers
        const b = grid.get(x, h, z);
        if (b !== AIR) blockCounts.set(b, (blockCounts.get(b) ?? 0) + 1);
      }
    }
  }
  const dominantRoof = roofBlock ?? [...blockCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'minecraft:andesite';

  // Build roof layers by iteratively eroding the footprint
  // Start with the top-layer footprint (all positions at maxH or within 2 blocks of it)
  let currentFootprint = new Set<number>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightMap[z * width + x];
      if (h >= maxH - 2) { // within 2 blocks of top
        currentFootprint.add(z * width + x);
      }
    }
  }



  for (let layer = 0; layer < maxLayers; layer++) {
    // Erode: remove boundary voxels (those touching air/outside)
    const eroded = new Set<number>();
    for (const idx of currentFootprint) {
      const x = idx % width;
      const z = Math.floor(idx / width);
      let isBoundary = false;
      for (const [dx, dz] of H_DIRS) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
          isBoundary = true;
          break;
        }
        if (!currentFootprint.has(nz * width + nx)) {
          isBoundary = true;
          break;
        }
      }
      if (!isBoundary) {
        eroded.add(idx);
      }
    }

    if (eroded.size === 0) break; // Fully eroded — peak reached

    // Place roof blocks at maxH + 1 + layer for the eroded footprint
    const placeY = maxH + 1 + layer;
    if (placeY >= 256) break; // MC height limit

    // Expand grid height if needed (BlockGrid.expandHeight adds air layers on top)
    if (placeY >= grid.height) {
      grid.expandHeight(placeY + maxLayers + 1);
    }

    for (const idx of eroded) {
      const x = idx % width;
      const z = Math.floor(idx / width);
      grid.set(x, placeY, z, dominantRoof);
      placed++;
    }

    currentFootprint = eroded;
  }

  return placed;
}
