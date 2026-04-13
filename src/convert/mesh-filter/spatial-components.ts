/**
 * Connected-component analysis and isolation utilities.
 *
 * Functions for removing small/artifact components, isolating the tallest
 * structure, height-gradient severing, watershed isolation, primary building
 * isolation, street furniture removal, and thin pillar removal.
 * Split from spatial.ts.
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR, FACES6 } from './_internal.js';
// labelConnectedComponents is in analysis.ts (direct import avoids circular dep via barrel)
import { labelConnectedComponents } from './analysis.js';

// ═══════════════════════════════════════════════════════════════════════════
// Connected-component isolation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove connected components smaller than `minSize` (voxel count).
 *
 * Uses 6-connected flood fill. The largest component is always kept regardless
 * of minSize. Returns the number of voxels removed.
 *
 * @param grid     Mutable BlockGrid
 * @param minSize  Minimum voxel count for a component to survive (default: 50)
 * @returns Number of blocks removed
 */
export function removeSmallComponents(grid: BlockGrid, minSize = 50, resolution = 1): number {

  const { width, height, length } = grid;

  // Scale volume threshold cubically — higher-res grids have proportionally more voxels per component
  const scaledMinSize = Math.max(1, Math.round(minSize * resolution * resolution * resolution));
  const total = width * height * length;

  // Component label for each voxel (0 = unlabeled, -1 = air)
  const labels = new Int32Array(total);
  const idx = (x: number, y: number, z: number) => (y * length + z) * width + x;

  // Mark air voxels
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        if (grid.get(x, y, z) === AIR) labels[idx(x, y, z)] = -1;

  // Flood-fill to find connected components
  let nextLabel = 1;
  const componentSizes = new Map<number, number>(); // label → voxel count

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        if (labels[i] !== 0) continue; // already labeled or air

        // BFS flood fill for this component
        const label = nextLabel++;
        let size = 0;
        const queue: [number, number, number][] = [[x, y, z]];
        labels[i] = label;

        while (queue.length > 0) {
          const [cx, cy, cz] = queue.pop()!;
          size++;

          for (const [dx, dy, dz] of FACES6) {
            const nx = cx + dx;
            const ny = cy + dy;
            const nz = cz + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = idx(nx, ny, nz);
            if (labels[ni] !== 0) continue; // already labeled or air
            labels[ni] = label;
            queue.push([nx, ny, nz]);
          }
        }

        componentSizes.set(label, size);
      }
    }
  }

  // Find the largest component
  let largestLabel = 0;
  let largestSize = 0;
  for (const [label, size] of componentSizes) {
    if (size > largestSize) {
      largestSize = size;
      largestLabel = label;
    }
  }

  // Remove blocks in small components
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        const label = labels[i];
        if (label <= 0) continue; // air or unlabeled
        const size = componentSizes.get(label) ?? 0;
        // Remove if not the largest AND below scaledMinSize threshold
        if (label !== largestLabel && size < scaledMinSize) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

/**
 * Remove artifact components using density + distance heuristics.
 *
 * Goes beyond simple size thresholds:
 * 3a. Density-based: density = voxel_count / bbox_volume. Components with
 *     density < minDensity are removed regardless of size (catches sparse needles,
 *     string-like artifacts that have many voxels but low volume density).
 * 3b. Distance-based: components whose centroid is > maxDistanceRatio × building
 *     radius from the main building centroid are removed (catches distant debris).
 *
 * The largest component is always kept as the main building.
 *
 * @param grid              BlockGrid (modified in place)
 * @param minDensity        Minimum density to keep a non-largest component (default: 0.1)
 * @param maxDistanceRatio  Max centroid distance as ratio of building radius (default: 1.5)
 * @returns Number of blocks removed
 */
export function removeArtifactComponents(
  grid: BlockGrid,
  minDensity = 0.1,
  maxDistanceRatio = 1.5,
): number {

  const { width, height, length } = grid;
  const total = width * height * length;

  // Label connected components (6-connected)
  const labels = new Int32Array(total);
  const idx = (x: number, y: number, z: number) => (y * length + z) * width + x;
  // Mark air
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        if (grid.get(x, y, z) === AIR) labels[idx(x, y, z)] = -1;

  // Component data: size, bounding box, centroid sum
  interface CompData {
    size: number;
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
    sumX: number; sumY: number; sumZ: number;
  }
  const components = new Map<number, CompData>();
  let nextLabel = 1;

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y, z);
        if (labels[i] !== 0) continue;

        const label = nextLabel++;
        const data: CompData = {
          size: 0,
          minX: x, minY: y, minZ: z,
          maxX: x, maxY: y, maxZ: z,
          sumX: 0, sumY: 0, sumZ: 0,
        };
        const queue: [number, number, number][] = [[x, y, z]];
        labels[i] = label;

        while (queue.length > 0) {
          const [cx, cy, cz] = queue.pop()!;
          data.size++;
          data.sumX += cx; data.sumY += cy; data.sumZ += cz;
          if (cx < data.minX) data.minX = cx;
          if (cy < data.minY) data.minY = cy;
          if (cz < data.minZ) data.minZ = cz;
          if (cx > data.maxX) data.maxX = cx;
          if (cy > data.maxY) data.maxY = cy;
          if (cz > data.maxZ) data.maxZ = cz;

          for (const [dx, dy, dz] of FACES6) {
            const nx = cx + dx, ny = cy + dy, nz = cz + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = idx(nx, ny, nz);
            if (labels[ni] !== 0) continue;
            labels[ni] = label;
            queue.push([nx, ny, nz]);
          }
        }

        components.set(label, data);
      }
    }
  }

  // Find the largest component
  let largestLabel = 0;
  let largestSize = 0;
  for (const [label, data] of components) {
    if (data.size > largestSize) {
      largestSize = data.size;
      largestLabel = label;
    }
  }

  // Main building centroid and radius (from largest component)
  const main = components.get(largestLabel);
  if (!main) return 0;
  const mainCx = main.sumX / main.size;
  const mainCy = main.sumY / main.size;
  const mainCz = main.sumZ / main.size;
  const mainRadius = Math.max(
    main.maxX - main.minX,
    main.maxY - main.minY,
    main.maxZ - main.minZ,
  ) / 2;
  const maxDist = mainRadius * maxDistanceRatio;

  // Remove components failing density or distance checks
  let removed = 0;
  for (const [label, data] of components) {
    if (label === largestLabel) continue; // always keep main building

    // 3a: Density check — voxel_count / bbox_volume
    const bboxVol = Math.max(1,
      (data.maxX - data.minX + 1) *
      (data.maxY - data.minY + 1) *
      (data.maxZ - data.minZ + 1),
    );
    const density = data.size / bboxVol;

    // 3b: Distance check — centroid distance from main building
    const cx = data.sumX / data.size;
    const cy = data.sumY / data.size;
    const cz = data.sumZ / data.size;
    const dist = Math.sqrt(
      (cx - mainCx) ** 2 + (cy - mainCy) ** 2 + (cz - mainCz) ** 2,
    );

    // Remove if sparse OR too far from main building
    const shouldRemove = density < minDensity || dist > maxDist;
    if (shouldRemove) {
      // Mark for removal — set all voxels in this component to air
      for (let y = data.minY; y <= data.maxY; y++) {
        for (let z = data.minZ; z <= data.maxZ; z++) {
          for (let x = data.minX; x <= data.maxX; x++) {
            const i = idx(x, y, z);
            if (labels[i] === label) {
              grid.set(x, y, z, AIR);
              removed++;
            }
          }
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tower / height-based isolation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Isolate the tallest structure from surrounding shorter buildings.
 *
 * For skyscrapers captured with photogrammetry, surrounding buildings are often
 * fused into the same mesh. This filter:
 * 1. Builds a height map (max occupied Y per XZ column)
 * 2. Samples the footprint at a fraction of max height (above surrounding buildings)
 * 3. Expands this footprint by a margin (to capture setbacks at lower levels)
 * 4. Removes blocks in columns outside the expanded footprint
 *
 * Only effective for buildings significantly taller than their surroundings.
 *
 * @param grid           Mutable BlockGrid
 * @param heightFraction Sample footprint at this fraction of max height (default 0.5)
 * @param expansion      Expand sampled footprint by this many blocks (default 10)
 * @returns Number of blocks removed
 */
export function isolateTallestStructure(grid: BlockGrid, heightFraction = 0.5, expansion = 10): number {

  const { width, height, length } = grid;

  // Find max occupied Y
  let maxOccupiedY = 0;
  for (let y = height - 1; y >= 0; y--) {
    let found = false;
    for (let x = 0; x < width && !found; x++)
      for (let z = 0; z < length && !found; z++)
        if (grid.get(x, y, z) !== AIR) { maxOccupiedY = y; found = true; }
    if (found) break;
  }

  if (maxOccupiedY < 20) {
    console.log(`Tower isolation: skipped (max height ${maxOccupiedY} < 20)`);
    return 0;
  }

  // Build height map (max Y per XZ column)
  const heightMap = new Uint16Array(width * length);
  let occupiedCols = 0;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightMap[z * width + x] = y;
          occupiedCols++;
          break;
        }
      }
    }
  }

  // Compute median height of occupied columns
  const colHeights = Array.from(heightMap).filter(h => h > 0);
  colHeights.sort((a, b) => a - b);
  const medianH = colHeights[Math.floor(colHeights.length * 0.5)] || 0;

  // Only effective if tallest structure rises meaningfully above median surroundings
  // 1.25x threshold catches NYC skyscrapers surrounded by shorter midtown buildings
  if (maxOccupiedY < medianH * 1.25) {
    console.log(`Tower isolation: skipped (maxY ${maxOccupiedY} < median ${medianH} × 1.25 = ${Math.round(medianH * 1.25)})`);
    return 0;
  }

  // Per-layer approach: at each Y level, only keep blocks within expansion
  // distance of the actual occupied footprint at THAT level or any higher level.
  // This preserves the building's natural silhouette while trimming noise that's
  // spatially separated from the building at each height.
  //
  // Build cumulative top-down footprint: union of all layers from top to current Y.
  // This captures setbacks naturally (upper layers are narrower, lower layers wider).
  const cumulativeFootprint = new Uint8Array(width * length);
  let seedCount = 0;

  // First, count seed columns from top 25%
  const seedStartY = Math.floor(maxOccupiedY * heightFraction);
  for (let y = maxOccupiedY; y >= seedStartY; y--) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        if (!cumulativeFootprint[z * width + x] && grid.get(x, y, z) !== AIR) {
          cumulativeFootprint[z * width + x] = 1;
          seedCount++;
        }
      }
    }
  }

  if (seedCount === 0) return 0;

  // Keep only the largest connected component of the seed (2D 4-connected).
  // This prevents nearby tall buildings from leaking into the allowed mask.
  {
    const seedLabels = new Int32Array(width * length);
    let nextLabel = 1;
    const compSizes = new Map<number, number>();
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const i = z * width + x;
        if (!cumulativeFootprint[i] || seedLabels[i] !== 0) continue;
        const label = nextLabel++;
        let size = 0;
        const queue: [number, number][] = [[x, z]];
        seedLabels[i] = label;
        while (queue.length > 0) {
          const [cx, cz] = queue.pop()!;
          size++;
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
            const ni = nz * width + nx;
            if (cumulativeFootprint[ni] && seedLabels[ni] === 0) {
              seedLabels[ni] = label;
              queue.push([nx, nz]);
            }
          }
        }
        compSizes.set(label, size);
      }
    }
    // Find largest component
    let bestLabel = 0, bestSize = 0;
    for (const [label, size] of compSizes) {
      if (size > bestSize) { bestSize = size; bestLabel = label; }
    }
    // Strip non-largest from seed
    let stripped = 0;
    for (let i = 0; i < width * length; i++) {
      if (cumulativeFootprint[i] && seedLabels[i] !== bestLabel) {
        cumulativeFootprint[i] = 0;
        stripped++;
      }
    }
    if (stripped > 0) {
      seedCount -= stripped;
      console.log(`Tower isolation: kept largest seed component (${bestSize} cols), stripped ${stripped} cols from ${compSizes.size - 1} other components`);
    }
  }

  // Dilate the top-portion footprint by expansion
  const allowed = new Uint8Array(width * length);
  const expSq = expansion * expansion;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < length; z++) {
      if (!cumulativeFootprint[z * width + x]) continue;
      for (let dx = -expansion; dx <= expansion; dx++) {
        for (let dz = -expansion; dz <= expansion; dz++) {
          if (dx * dx + dz * dz > expSq) continue;
          const nx = x + dx, nz = z + dz;
          if (nx >= 0 && nx < width && nz >= 0 && nz < length) {
            allowed[nz * width + nx] = 1;
          }
        }
      }
    }
  }

  // Remove blocks outside the allowed mask at ALL heights
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (!allowed[z * width + x] && grid.get(x, y, z) !== AIR) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  console.log(`Tower isolation: seed Y≥${seedStartY}/${maxOccupiedY} (${seedCount} cols), expansion ${expansion} → removed ${removed} blocks`);
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Height gradient severing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Height gradient severing — splits fused buildings by detecting steep height
 * discontinuities in the 2D heightmap and severing the 3D grid at those boundaries.
 * Returns blocks removed (smaller components after severing).
 */
export function severByHeightGradient(
  grid: BlockGrid,
  gradientThreshold = 3,
  minComponentVolume = 200,
): number {

  const { width, height, length } = grid;

  // Step 1: Build 2D heightmap (max Y per XZ column)
  const heightmap = new Int32Array(width * length);
  heightmap.fill(-1);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== AIR) {
          heightmap[z * width + x] = y;
          break;
        }
      }
    }
  }

  // Step 2: Compute gradient and mark chasms (steep height drops)
  const chasmMap = new Uint8Array(width * length); // 1 = chasm
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const h = heightmap[z * width + x];
      if (h < 0) continue;
      // Check 4-connected neighbors
      const neighbors = [
        x > 0 ? heightmap[z * width + (x - 1)] : -1,
        x < width - 1 ? heightmap[z * width + (x + 1)] : -1,
        z > 0 ? heightmap[(z - 1) * width + x] : -1,
        z < length - 1 ? heightmap[(z + 1) * width + x] : -1,
      ];
      for (const nh of neighbors) {
        if (nh >= 0 && Math.abs(h - nh) > gradientThreshold) {
          chasmMap[z * width + x] = 1;
          break;
        }
      }
    }
  }

  // Step 3: 3D connected component labeling that respects chasms.
  // Flood fill cannot cross an XZ coordinate marked as chasm.
  const total = width * height * length;
  const labels = new Int32Array(total);
  let nextLabel = 1;
  const compSizes: number[] = [0];
  const stack: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * length + z) * width + x;
        if (labels[idx] !== 0 || grid.get(x, y, z) === AIR) continue;

        const label = nextLabel++;
        labels[idx] = label;
        stack.push(idx);
        let size = 0;

        while (stack.length > 0) {
          const ci = stack.pop()!;
          size++;
          const cx = ci % width;
          const cz = Math.floor(ci / width) % length;
          const cy = Math.floor(ci / (width * length));

          for (const [ddx, ddy, ddz] of FACES6) {
            const nx = cx + ddx, ny = cy + ddy, nz = cz + ddz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = (ny * length + nz) * width + nx;
            if (labels[ni] !== 0 || grid.get(nx, ny, nz) === AIR) continue;

            // Block crossing through chasm boundaries
            if (chasmMap[nz * width + nx] === 1 || chasmMap[cz * width + cx] === 1) {
              // Allow vertical movement within same XZ column (building on its own podium)
              if (ddx !== 0 || ddz !== 0) continue;
            }

            labels[ni] = label;
            stack.push(ni);
          }
        }
        compSizes.push(size);
      }
    }
  }

  if (nextLabel <= 2) return 0; // Single component after severing

  // Step 4: Find largest component (likely the target building)
  let largestLabel = 1, largestSize = 0;
  for (let i = 1; i < compSizes.length; i++) {
    if (compSizes[i] > largestSize) {
      largestSize = compSizes[i];
      largestLabel = i;
    }
  }

  // Step 5: Recombine — if a smaller component vertically overlaps the largest
  // (shares XZ columns) and is directly beneath it, keep it (podium/base).
  const keepLabels = new Set<number>([largestLabel]);
  const largestXZ = new Set<string>();
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (labels[(y * length + z) * width + x] === largestLabel) {
          largestXZ.add(`${x},${z}`);
          break;
        }
      }
    }
  }
  for (let i = 1; i < compSizes.length; i++) {
    if (i === largestLabel || compSizes[i] < minComponentVolume) continue;
    // Check if this component shares >50% XZ overlap with largest
    let overlap = 0, compCols = 0;
    const seen = new Set<string>();
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const key = `${x},${z}`;
        if (seen.has(key)) continue;
        for (let y = 0; y < height; y++) {
          if (labels[(y * length + z) * width + x] === i) {
            seen.add(key);
            compCols++;
            if (largestXZ.has(key)) overlap++;
            break;
          }
        }
      }
    }
    if (compCols > 0 && overlap / compCols > 0.5) {
      keepLabels.add(i); // Podium/base of same building
    }
  }

  // Step 6: Remove non-kept components
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue;
        if (!keepLabels.has(lbl)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Watershed isolation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Distance transform + watershed for isolating same-height fused buildings.
 * Computes Manhattan distance transform on XZ footprint, finds local maxima
 * (building centers), watershed-grows from them, and keeps the region closest
 * to grid center. Returns blocks removed.
 */
export function watershedIsolate(
  grid: BlockGrid,
  minCenterDist = 4,
): number {

  const { width, height, length } = grid;

  // Step 1: Build 2D occupancy footprint
  const occupied = new Uint8Array(width * length);
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) { occupied[z * width + x] = 1; break; }
      }
    }
  }

  // Step 2: Manhattan distance transform (distance from nearest air/boundary)
  const dist = new Int32Array(width * length);
  const INF = width + length;
  // Forward pass
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      if (occupied[z * width + x] === 0) { dist[z * width + x] = 0; continue; }
      let d = INF;
      if (x > 0) d = Math.min(d, dist[z * width + (x - 1)] + 1);
      if (z > 0) d = Math.min(d, dist[(z - 1) * width + x] + 1);
      dist[z * width + x] = d;
    }
  }
  // Backward pass
  for (let z = length - 1; z >= 0; z--) {
    for (let x = width - 1; x >= 0; x--) {
      if (occupied[z * width + x] === 0) continue;
      let d = dist[z * width + x];
      if (x < width - 1) d = Math.min(d, dist[z * width + (x + 1)] + 1);
      if (z < length - 1) d = Math.min(d, dist[(z + 1) * width + x] + 1);
      dist[z * width + x] = d;
    }
  }

  // Step 3: Find local maxima (building centers) with minimum distance threshold
  // Scale minCenterDist with building size — prevents splitting single buildings
  const footprintMin = Math.min(width, length);
  const effectiveMinDist = Math.max(minCenterDist, Math.floor(footprintMin / 4));
  const rawMaxima: { x: number; z: number; d: number }[] = [];
  for (let z = 1; z < length - 1; z++) {
    for (let x = 1; x < width - 1; x++) {
      const d = dist[z * width + x];
      if (d < effectiveMinDist) continue;
      // Check if local maximum in 8-connected neighborhood
      let isMax = true;
      for (let ddz = -1; ddz <= 1 && isMax; ddz++) {
        for (let ddx = -1; ddx <= 1 && isMax; ddx++) {
          if (ddx === 0 && ddz === 0) continue;
          if (dist[(z + ddz) * width + (x + ddx)] > d) isMax = false;
        }
      }
      if (isMax) rawMaxima.push({ x, z, d });
    }
  }

  // Merge maxima that are close together (same building plateau)
  rawMaxima.sort((a, b) => b.d - a.d); // highest distance first
  const maxima: typeof rawMaxima = [];
  for (const m of rawMaxima) {
    const tooClose = maxima.some(
      (existing) => Math.abs(existing.x - m.x) + Math.abs(existing.z - m.z) < effectiveMinDist,
    );
    if (!tooClose) maxima.push(m);
  }

  if (maxima.length <= 1) return 0; // Single building center

  // Step 4: Watershed — grow from maxima simultaneously
  const regionMap = new Int32Array(width * length); // 0=unassigned
  const queue: { x: number; z: number; region: number; d: number }[] = [];

  // Seed regions from maxima (sorted by distance descending for priority)
  maxima.sort((a, b) => b.d - a.d);
  for (let i = 0; i < maxima.length; i++) {
    const m = maxima[i];
    const region = i + 1;
    regionMap[m.z * width + m.x] = region;
    queue.push({ x: m.x, z: m.z, region, d: m.d });
  }

  // BFS growth — process in order of decreasing distance (highest priority first)
  queue.sort((a, b) => b.d - a.d);
  let qi = 0;
  while (qi < queue.length) {
    const { x, z, region } = queue[qi++];
    for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + ddx, nz = z + ddz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
      if (occupied[nz * width + nx] === 0) continue;
      if (regionMap[nz * width + nx] !== 0) continue;
      regionMap[nz * width + nx] = region;
      queue.push({ x: nx, z: nz, region, d: dist[nz * width + nx] });
    }
  }

  // Step 5: Find the region closest to grid center
  const cx = Math.floor(width / 2), cz = Math.floor(length / 2);
  let bestRegion = 1, bestDist = Infinity;
  for (let i = 0; i < maxima.length; i++) {
    const m = maxima[i];
    const d = Math.abs(m.x - cx) + Math.abs(m.z - cz);
    if (d < bestDist) { bestDist = d; bestRegion = i + 1; }
  }

  // Step 6: Remove all voxels not in the best region's XZ columns
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        if (regionMap[z * width + x] !== bestRegion) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }
  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// v300 Task 5: Primary building isolation + street furniture removal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Isolate the primary building by volume×centrality scoring.
 * Keeps the highest-scoring connected component plus any annexes within
 * annexRadius that are at least minVolumePct of the primary's volume.
 *
 * @param grid         Mutable BlockGrid
 * @param annexRadius  XZ AABB overlap tolerance (blocks, default 2)
 * @param minVolumePct Minimum annex volume relative to primary (default 0.15)
 * @returns Number of blocks removed
 */
export function isolatePrimaryBuilding(
  grid: BlockGrid,
  annexRadius = 2,      // v95: tightened 3→2 — adjacent buildings must be directly touching
  minVolumePct = 0.15,  // v95: tightened 0.05→0.15 — annexes must be ≥15% of primary volume
): number {

  const { width, height, length } = grid;

  // Step 1: Label connected components
  const { labels, count } = labelConnectedComponents(grid);
  if (count <= 1) return 0; // single component or empty — nothing to isolate

  // Step 2: Compute per-component centroid and volume
  const centroidX = new Float64Array(count + 1);
  const centroidZ = new Float64Array(count + 1);
  const compCounts = new Float64Array(count + 1);

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue;
        centroidX[lbl] += x;
        centroidZ[lbl] += z;
        compCounts[lbl]++;
      }
    }
  }

  // Step 3: Score components using volume × centrality (identical to analyzeGrid)
  const cx = width / 2;
  const cz = length / 2;
  const maxDist = Math.sqrt(cx * cx + cz * cz);
  let bestLabel = 1;
  let bestScore = -Infinity;
  let maxCompSize = 0;

  for (let i = 1; i <= count; i++) {
    if (compCounts[i] > maxCompSize) maxCompSize = compCounts[i];
  }

  for (let i = 1; i <= count; i++) {
    // Filter noise: must be ≥5% of largest component or ≥100 voxels
    if (compCounts[i] < Math.max(100, maxCompSize * 0.05)) continue;

    const mx = centroidX[i] / compCounts[i];
    const mz = centroidZ[i] / compCounts[i];
    const dist = Math.sqrt((mx - cx) * (mx - cx) + (mz - cz) * (mz - cz));
    const normalizedDist = maxDist > 0 ? dist / maxDist : 0;
    // v95: Reduced distance penalty 0.5→0.2 so volume dominates scoring.
    // Previously a centered component with 60% of the volume could beat the actual
    // target building if it was off-center. Now size is the primary signal.
    const score = compCounts[i] * (1.0 - normalizedDist * 0.2);

    if (score > bestScore) {
      bestScore = score;
      bestLabel = i;
    }
  }

  const primaryVolume = compCounts[bestLabel];

  // Step 4: Compute primary component's XZ AABB
  let pMinX = width, pMaxX = 0, pMinZ = length, pMaxZ = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (labels[(y * length + z) * width + x] !== bestLabel) continue;
        if (x < pMinX) pMinX = x;
        if (x > pMaxX) pMaxX = x;
        if (z < pMinZ) pMinZ = z;
        if (z > pMaxZ) pMaxZ = z;
      }
    }
  }

  // Step 5: Decide which components to keep
  const keepLabels = new Set<number>([bestLabel]);

  for (let i = 1; i <= count; i++) {
    if (i === bestLabel) continue;
    if (compCounts[i] < primaryVolume * minVolumePct) continue; // too small to be an annex

    // Compute this component's XZ AABB
    let cMinX = width, cMaxX = 0, cMinZ = length, cMaxZ = 0;
    for (let y = 0; y < height; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          if (labels[(y * length + z) * width + x] !== i) continue;
          if (x < cMinX) cMinX = x;
          if (x > cMaxX) cMaxX = x;
          if (z < cMinZ) cMinZ = z;
          if (z > cMaxZ) cMaxZ = z;
        }
      }
    }

    // Check if AABB overlaps or is within annexRadius of primary AABB
    const xOverlap = cMaxX >= pMinX - annexRadius && cMinX <= pMaxX + annexRadius;
    const zOverlap = cMaxZ >= pMinZ - annexRadius && cMinZ <= pMaxZ + annexRadius;
    if (xOverlap && zOverlap) {
      keepLabels.add(i);
    }
  }

  // Step 6: Clear everything not in keepLabels
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue; // air
        if (!keepLabels.has(lbl)) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// v300 Task 5: Street furniture removal — poles, lampposts, antennas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ray-casting point-in-polygon test in 2D block coordinates.
 * Uses the classic even-odd crossing algorithm on integer grid points.
 *
 * @param px       Query X (integer block coord)
 * @param pz       Query Z (integer block coord)
 * @param polygon  Polygon as array of {x, z} integer points (auto-closed)
 * @returns true if (px, pz) is inside the polygon
 */
function pointInPolygonXZ(
  px: number,
  pz: number,
  polygon: Array<{ x: number; z: number }>,
): boolean {
  // Cast a ray in +X direction, count crossings with polygon edges.
  // Using half-pixel offset (px + 0.5) avoids exact-vertex ambiguity.
  const qx = px + 0.5;
  const qz = pz + 0.5;
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ai = polygon[i];
    const aj = polygon[j];
    // Edge between aj and ai crosses the horizontal ray at qz?
    const crossesZ = (ai.z > qz) !== (aj.z > qz);
    if (!crossesZ) continue;
    // X-intercept of the edge at qz
    const tZ = (qz - aj.z) / (ai.z - aj.z);
    const xIntercept = aj.x + tZ * (ai.x - aj.x);
    if (qx < xIntercept) inside = !inside;
  }
  return inside;
}

/**
 * Remove street furniture (poles, lampposts, antennas) from a voxelized grid.
 *
 * Algorithm:
 * 1. Build a 2D XZ protection mask from the OSM polygon (if provided).
 *    Grid cells inside the polygon are protected from erasure.
 * 2. Erode the bottom `15 * resolution` layers OUTSIDE the protection mask
 *    using radius-1 surface erosion. This severs thin vertical pole connections
 *    to the building at ground level — poles have no horizontal neighbors outside
 *    the footprint, so they become disconnected after surface erosion.
 * 3. Run 3D connected component labeling on the eroded grid.
 * 4. Keep only the single largest component (the building); remove all others.
 * 5. Restore any eroded voxels that are now adjacent (6-connected) to at least
 *    one surviving building block, so legitimate edge blocks aren't lost.
 * 6. Aspect-ratio fallback (no OSM polygon): re-run CCL on the restored grid and
 *    delete any component whose height/footprint aspect ratio exceeds 8 (pole-like).
 *
 * @param grid           Mutable BlockGrid (modified in place)
 * @param resolution     Blocks per meter — scales the erosion depth and polygon projection
 * @param osmPolygon     Optional OSM building polygon ({lat, lon}[])
 * @param centerLat      Capture center latitude (degrees) — required with osmPolygon
 * @param centerLon      Capture center longitude (degrees) — required with osmPolygon
 * @param translationDx  Optional X offset applied to projected polygon (blocks)
 * @param translationDz  Optional Z offset applied to projected polygon (blocks)
 * @returns Total number of voxels removed
 */
export function severStreetFurniture(
  grid: BlockGrid,
  resolution: number,
  osmPolygon?: { lat: number; lon: number }[],
  centerLat?: number,
  centerLon?: number,
  translationDx = 0,
  translationDz = 0,
): number {

  const { width, height, length } = grid;
  const gridCx = Math.floor(width / 2);
  const gridCz = Math.floor(length / 2);

  // -- Step 1: Build XZ protection mask from OSM polygon --
  // Each cell (x, z) in grid coords is marked as protected if it falls inside
  // the projected OSM polygon. Protected cells are never eroded in Step 2,
  // ensuring legitimate building footprint blocks aren't disconnected.
  const protectedXZ = new Uint8Array(width * length); // 1 = protected

  if (osmPolygon && osmPolygon.length >= 3 && centerLat !== undefined && centerLon !== undefined) {
    // Project polygon lat/lon → block offsets relative to grid center.
    // Matches the coordinate convention in maskToFootprint():
    //   lon → +X (east), lat → -Z (south/north flipped)
    const latScale = 111320 * resolution; // deg→meters * blocks/meter
    const lonScale = 111320 * Math.cos(centerLat * Math.PI / 180) * resolution;

    let blockPts = osmPolygon.map(p => ({
      x: Math.round((p.lon - centerLon) * lonScale) + translationDx,
      z: Math.round((centerLat - p.lat) * latScale) + translationDz,
    }));

    // Auto-close the polygon if not already closed
    const pFirst = blockPts[0], pLast = blockPts[blockPts.length - 1];
    if (pFirst.x !== pLast.x || pFirst.z !== pLast.z) {
      blockPts.push({ x: pFirst.x, z: pFirst.z });
    }

    // Mark all grid XZ cells inside the polygon as protected.
    // Grid XZ (x, z) → polygon space offset from grid center (bx, bz).
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bx = x - gridCx;
        const bz = z - gridCz;
        if (pointInPolygonXZ(bx, bz, blockPts)) {
          protectedXZ[z * width + x] = 1;
        }
      }
    }
  }

  // -- Step 2: Surface erosion in bottom erosionLayers, outside protection mask --
  // For each Y layer, a block is "surface" if it has at least one air neighbor
  // in the XZ plane. We erode (remove) surface blocks outside the protected zone.
  // This severs horizontal bridges between poles and the building at ground level.
  //
  // IMPORTANT: Collect candidates from the ORIGINAL layer state BEFORE any erasure,
  // then erase them all at once. Without this snapshot approach, in-place mutation
  // cascades — erasing block A exposes its neighbor B as surface, then B is erased,
  // exposing C, etc., eating the entire building from the outside in.
  const erosionLayers = Math.round(15 * resolution);
  const eroded: Array<{ x: number; y: number; z: number; block: string }> = [];

  const xzOffsets = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

  for (let y = 0; y < Math.min(erosionLayers, height); y++) {
    // Phase A: collect surface candidates based on the original state of this Y layer
    const toErase: Array<{ x: number; y: number; z: number; block: string }> = [];
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;
        // Skip protected cells (inside OSM footprint polygon)
        if (protectedXZ[z * width + x]) continue;
        // Check if this is a surface block (has an XZ air neighbor in the CURRENT layer)
        let isSurface = false;
        for (const [dx, dz] of xzOffsets) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
            isSurface = true; // edge of grid counts as surface
            break;
          }
          if (grid.get(nx, y, nz) === AIR) {
            isSurface = true;
            break;
          }
        }
        if (isSurface) {
          toErase.push({ x, y, z, block });
        }
      }
    }
    // Phase B: erase all collected candidates at once (snapshot semantics)
    for (const e of toErase) {
      grid.set(e.x, e.y, e.z, AIR);
      eroded.push(e);
    }
  }

  // -- Step 3 & 4: Connected component labeling — keep largest component --
  const { labels, sizes, count } = labelConnectedComponents(grid);

  if (count === 0) {
    // Grid is empty — restore eroded blocks and return 0
    for (const e of eroded) grid.set(e.x, e.y, e.z, e.block);
    return 0;
  }

  // Find the largest component label
  let largestLabel = 1;
  let largestSize = sizes[1] ?? 0;
  for (let i = 2; i <= count; i++) {
    if (sizes[i] > largestSize) {
      largestSize = sizes[i];
      largestLabel = i;
    }
  }

  // Remove all voxels not in the largest component
  let removed = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const lbl = labels[(y * length + z) * width + x];
        if (lbl === 0) continue; // air
        if (lbl !== largestLabel) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  // -- Step 5: Restore eroded voxels adjacent to surviving building --
  // An eroded block is restored if any of its 6 neighbors is now a surviving
  // building block (non-air). This prevents over-erosion at building edges.
  const allOffsets = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ] as const;

  for (const { x, y, z, block } of eroded) {
    let hasSurvivingNeighbor = false;
    for (const [dx, dy, dz] of allOffsets) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
      if (grid.get(nx, ny, nz) !== AIR) {
        hasSurvivingNeighbor = true;
        break;
      }
    }
    if (hasSurvivingNeighbor) {
      grid.set(x, y, z, block);
    } else {
      // Permanently removed — count as a removed voxel (street furniture severed)
      removed++;
    }
  }

  // -- Step 6: Aspect-ratio fallback when no OSM polygon --
  // Without an OSM polygon, thin pole-like components that survived CCL
  // (e.g. attached to the building by a single block) are caught here.
  // Any component with height / max(footprintWidth, footprintDepth) > 8 is removed.
  if (!osmPolygon || osmPolygon.length < 3) {
    const { labels: labels2, count: count2 } = labelConnectedComponents(grid);

    if (count2 > 1) {
      // For each component compute its 3D AABB
      const compMinX = new Int32Array(count2 + 1).fill(width);
      const compMaxX = new Int32Array(count2 + 1).fill(-1);
      const compMinY = new Int32Array(count2 + 1).fill(height);
      const compMaxY = new Int32Array(count2 + 1).fill(-1);
      const compMinZ = new Int32Array(count2 + 1).fill(length);
      const compMaxZ = new Int32Array(count2 + 1).fill(-1);

      for (let y = 0; y < height; y++) {
        for (let z = 0; z < length; z++) {
          for (let x = 0; x < width; x++) {
            const lbl = labels2[(y * length + z) * width + x];
            if (lbl === 0) continue;
            if (x < compMinX[lbl]) compMinX[lbl] = x;
            if (x > compMaxX[lbl]) compMaxX[lbl] = x;
            if (y < compMinY[lbl]) compMinY[lbl] = y;
            if (y > compMaxY[lbl]) compMaxY[lbl] = y;
            if (z < compMinZ[lbl]) compMinZ[lbl] = z;
            if (z > compMaxZ[lbl]) compMaxZ[lbl] = z;
          }
        }
      }

      // Identify pole-like components: height > 8 × max(footprint dimension)
      const poleLabels = new Set<number>();
      for (let i = 1; i <= count2; i++) {
        if (compMaxY[i] < 0) continue; // empty component
        const compH = compMaxY[i] - compMinY[i] + 1;
        const footprintW = compMaxX[i] - compMinX[i] + 1;
        const footprintD = compMaxZ[i] - compMinZ[i] + 1;
        const maxFootprint = Math.max(footprintW, footprintD);
        if (maxFootprint > 0 && compH / maxFootprint > 8) {
          poleLabels.add(i);
        }
      }

      if (poleLabels.size > 0) {
        for (let y = 0; y < height; y++) {
          for (let z = 0; z < length; z++) {
            for (let x = 0; x < width; x++) {
              const lbl = labels2[(y * length + z) * width + x];
              if (lbl !== 0 && poleLabels.has(lbl)) {
                // Only remove if not inside a protected zone (belt-and-suspenders)
                if (!protectedXZ[z * width + x]) {
                  grid.set(x, y, z, AIR);
                  removed++;
                }
              }
            }
          }
        }
      }
    }
  }

  return removed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Thin pillar removal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Remove thin vertical pillar columns (street lights, traffic signals) from the grid.
 *
 * Uses a top-slice isolation strategy:
 * 1. Find the building's 75th percentile column height
 * 2. At that Y level, run 2D connected component labeling on the XZ slice
 * 3. Any component smaller than minComponentSize is a pole protruding above the mass
 * 4. Remove ALL blocks in those XZ columns (from bottom to top)
 *
 * This works because poles protrude above the main building body. At the building's
 * upper height levels, poles are spatially separated from the building even though
 * they're connected at ground level.
 *
 * @param grid               BlockGrid to modify in-place
 * @param minComponentSize   Minimum XZ component size at the check height to keep (default 20)
 * @returns Number of blocks removed
 */
export function removeThinPillars(
  grid: BlockGrid,
  minComponentSize = 20,
): number {

  const { width, height, length } = grid;

  // Step 1: Compute per-column max Y and find the 75th percentile height
  const columnMaxY = new Int32Array(width * length).fill(-1);
  const columnMinY = new Int32Array(width * length).fill(height);
  const maxYValues: number[] = [];

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const idx = z * width + x;
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          if (y > columnMaxY[idx]) columnMaxY[idx] = y;
          if (y < columnMinY[idx]) columnMinY[idx] = y;
        }
      }
      if (columnMaxY[idx] >= 0) {
        maxYValues.push(columnMaxY[idx]);
      }
    }
  }

  if (maxYValues.length === 0) return 0;
  maxYValues.sort((a, b) => a - b);
  const p75Height = maxYValues[Math.floor(maxYValues.length * 0.75)];
  if (p75Height <= 0) return 0;

  // Step 2: Create a 2D bitmap at the check level — which XZ positions are occupied?
  // Check at multiple heights around the 75th percentile for robustness
  const checkYs = [p75Height, Math.floor(p75Height * 0.9), Math.floor(p75Height * 0.8)];
  const occupiedAtCheck = new Uint8Array(width * length); // union of all check levels
  for (const checkY of checkYs) {
    if (checkY < 0 || checkY >= height) continue;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, checkY, z) !== AIR) {
          occupiedAtCheck[z * width + x] = 1;
        }
      }
    }
  }

  // Step 3: 2D connected-component labeling on the XZ bitmap (4-connected)
  const labels = new Int32Array(width * length); // 0 = unvisited/empty
  const sizes: number[] = [0]; // sizes[label] = component size
  let nextLabel = 1;

  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const idx = z * width + x;
      if (!occupiedAtCheck[idx] || labels[idx] !== 0) continue;

      // BFS flood fill
      const label = nextLabel++;
      const queue: Array<[number, number]> = [[x, z]];
      labels[idx] = label;
      let size = 0;

      while (queue.length > 0) {
        const [cx, cz] = queue.pop()!;
        size++;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx, nz = cz + dz;
          if (nx < 0 || nx >= width || nz < 0 || nz >= length) continue;
          const nidx = nz * width + nx;
          if (occupiedAtCheck[nidx] && labels[nidx] === 0) {
            labels[nidx] = label;
            queue.push([nx, nz]);
          }
        }
      }

      sizes.push(size);
    }
  }

  // Step 4: Find the largest component (the building)
  let largestLabel = 1;
  let largestSize = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] > largestSize) {
      largestSize = sizes[i];
      largestLabel = i;
    }
  }

  // Step 5: Remove all columns that belong to small components (poles)
  // Only remove columns that are NOT part of the main building component
  let removed = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const idx = z * width + x;
      const lbl = labels[idx];
      if (lbl === 0 || lbl === largestLabel) continue; // empty or building
      if (sizes[lbl] >= minComponentSize) continue; // large enough to keep

      // This XZ column belongs to a small component at the check height — remove all blocks
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          grid.set(x, y, z, AIR);
          removed++;
        }
      }
    }
  }

  return removed;
}
