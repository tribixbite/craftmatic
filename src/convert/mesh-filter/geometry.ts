/**
 * Geometry and morphology operations on BlockGrid voxel grids.
 *
 * These are pure BlockGrid helpers with no Three.js deps — they operate on
 * voxel data after mesh-to-grid conversion. Functions include morphological
 * close/open, facade flattening, interior filling, surface smoothing,
 * footprint straightening, and hole repair.
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
export function morphClose3D(grid: BlockGrid, radius = 1, maxY?: number): number {
  const { width, height, length } = grid;
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
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dz = -radius; dz <= radius; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue;
            for (let dx = -radius; dx <= radius; dx++) {
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
        for (let dy = -radius; dy <= radius && !hasAirNeighbor; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue; // OOB = solid (standard morphClose boundary)
          for (let dz = -radius; dz <= radius && !hasAirNeighbor; dz++) {
            const nz = z + dz;
            if (nz < 0 || nz >= length) continue; // OOB = solid
            for (let dx = -radius; dx <= radius && !hasAirNeighbor; dx++) {
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

// ─── Facade operations ──────────────────────────────────────────────────────

/**
 * Flatten facades using depth histogram snapping. Identifies dominant wall
 * planes via histogram peaks, then snaps all nearby voxels to the nearest peak.
 *
 * Architecture has flat walls at discrete depth positions. Photogrammetry
 * produces noisy surfaces ±1-2 voxels from the true plane. This finds the
 * actual plane positions and enforces planarity.
 *
 * Algorithm per Y-row per facade direction:
 * 1. Build depth histogram (count solid voxels at each X or Z coordinate)
 * 2. Find peaks: coordinates with local maxima in the histogram
 * 3. For each non-peak solid voxel within `snapRadius`, move it to the
 *    nearest peak (snapping to the dominant wall plane)
 *
 * @param grid        Source BlockGrid (modified in place)
 * @param snapRadius  Max distance to snap to a peak (default: 2 voxels)
 * @returns Number of voxels snapped
 */
export function flattenFacades(grid: BlockGrid, snapRadius = 2, maxY?: number): number {
  const { width, height, length } = grid;
  // v95: maxY limits flattening to wall zone only — protects roof geometry from
  // being snapped to facade planes, which was creating holes in top-down views.
  const yLimit = maxY ?? height;
  let snapped = 0;

  // ── X-axis flattening: for each Z row, find dominant X planes ──
  for (let z = 0; z < length; z++) {
    // Build depth histogram across all Y for this Z slice (wall zone only)
    const xHist = new Int32Array(width);
    for (let y = 0; y < yLimit; y++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') xHist[x]++;
      }
    }

    // Find peaks: X positions with more voxels than both neighbors
    // A peak must have at least 15% of height to be a real wall plane
    const minPeak = yLimit * 0.1;
    const peaks: number[] = [];
    for (let x = 0; x < width; x++) {
      if (xHist[x] < minPeak) continue;
      const left = x > 0 ? xHist[x - 1] : 0;
      const right = x < width - 1 ? xHist[x + 1] : 0;
      if (xHist[x] >= left && xHist[x] >= right) {
        peaks.push(x);
      }
    }

    if (peaks.length === 0) continue;

    // Snap non-peak voxels to nearest peak within snapRadius (wall zone only)
    for (let y = 0; y < yLimit; y++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peaks.includes(x)) continue; // Already on a peak

        // Find nearest peak within snapRadius
        let nearestPeak = -1;
        let nearestDist = snapRadius + 1;
        for (const peak of peaks) {
          const dist = Math.abs(x - peak);
          if (dist <= snapRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestPeak = peak;
          }
        }

        if (nearestPeak >= 0 && nearestPeak !== x) {
          // Move voxel to the peak plane — only if target is empty
          if (grid.get(nearestPeak, y, z) === 'minecraft:air') {
            grid.set(nearestPeak, y, z, block);
            grid.set(x, y, z, 'minecraft:air');
            snapped++;
          }
          // If target occupied, leave source block in place (don't destroy it)
        }
      }
    }
  }

  // ── Z-axis flattening: for each X row, find dominant Z planes ──
  for (let x = 0; x < width; x++) {
    const zHist = new Int32Array(length);
    for (let y = 0; y < yLimit; y++) {
      for (let z = 0; z < length; z++) {
        if (grid.get(x, y, z) !== 'minecraft:air') zHist[z]++;
      }
    }

    const minPeak = yLimit * 0.1;
    const peaks: number[] = [];
    for (let z = 0; z < length; z++) {
      if (zHist[z] < minPeak) continue;
      const prev = z > 0 ? zHist[z - 1] : 0;
      const next = z < length - 1 ? zHist[z + 1] : 0;
      if (zHist[z] >= prev && zHist[z] >= next) {
        peaks.push(z);
      }
    }

    if (peaks.length === 0) continue;

    for (let y = 0; y < yLimit; y++) {
      for (let z = 0; z < length; z++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peaks.includes(z)) continue;

        let nearestPeak = -1;
        let nearestDist = snapRadius + 1;
        for (const peak of peaks) {
          const dist = Math.abs(z - peak);
          if (dist <= snapRadius && dist < nearestDist) {
            nearestDist = dist;
            nearestPeak = peak;
          }
        }

        if (nearestPeak >= 0 && nearestPeak !== z) {
          if (grid.get(x, y, nearestPeak) === 'minecraft:air') {
            grid.set(x, y, nearestPeak, block);
            grid.set(x, y, z, 'minecraft:air');
            snapped++;
          }
        }
      }
    }
  }

  return snapped;
}

/**
 * Phase 2c: Facade-aligned morphological close (dilate→erode) along facade normals.
 *
 * Standard morphClose3D operates uniformly in all 3 axes, which can fill depth
 * features (balconies, recesses) that are real geometry. This version detects
 * each facade surface's normal direction and only dilates/erodes along that axis,
 * closing 2-voxel pockmarks in facades without adding unwanted depth.
 *
 * @param grid    BlockGrid (modified in place)
 * @param radius  Close radius along facade normal (default: 2)
 * @returns Number of voxels changed
 */
export function morphCloseFacadeAligned(grid: BlockGrid, radius = 2): number {

  const { width, height, length } = grid;
  let changed = 0;

  // Snapshot for reading
  const snap: string[] = new Array(width * height * length);
  for (let y = 0; y < height; y++)
    for (let z = 0; z < length; z++)
      for (let x = 0; x < width; x++)
        snap[(y * length + z) * width + x] = grid.get(x, y, z);

  const getSnap = (x: number, y: number, z: number) => snap[(y * length + z) * width + x];

  // For each air voxel on a facade surface, check if it's a gap along the facade normal
  // direction (solid blocks on both sides within radius). If so, fill it.


  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (getSnap(x, y, z) !== AIR) continue;

        // Check each horizontal axis: is this gap bounded by solid on both sides?
        for (const [dx, dz] of H_DIRS) {
          // Only check if this is along a single axis (X or Z)
          // Look for solid blocks within radius in both directions along this axis
          let solidPos: string | null = null;
          let solidNeg: string | null = null;

          for (let r = 1; r <= radius; r++) {
            const px = x + dx * r, pz = z + dz * r;
            if (px >= 0 && px < width && pz >= 0 && pz < length) {
              const b = getSnap(px, y, pz);
              if (b !== AIR) { solidPos = b; break; }
            }
          }

          for (let r = 1; r <= radius; r++) {
            const px = x - dx * r, pz = z - dz * r;
            if (px >= 0 && px < width && pz >= 0 && pz < length) {
              const b = getSnap(px, y, pz);
              if (b !== AIR) { solidNeg = b; break; }
            }
          }

          // Fill gap if solid on both sides along this axis
          if (solidPos && solidNeg) {
            grid.set(x, y, z, solidPos);
            changed++;
            break; // Don't try other directions
          }
        }
      }
    }
  }

  return changed;
}

/**
 * Phase 5b: Detect and preserve cornices — horizontal edge features where facade
 * depth changes ≥2 blocks across the full building width.
 *
 * Scans each facade face for Y-layers where the depth profile shifts abruptly
 * (e.g., a ledge, cornice, or setback boundary). Returns the set of Y levels
 * that should be excluded from facade flattening. Optionally marks cornice
 * blocks with a trim material for architectural detail.
 *
 * @param grid          BlockGrid (read-only scan)
 * @param minDepthDelta Minimum depth change to qualify as cornice (default: 2)
 * @param applyTrim     If true, replace topmost cornice blocks with stone_brick_slab
 * @returns Set of Y levels identified as cornices
 */
export function detectCornices(
  grid: BlockGrid,
  minDepthDelta = 2,
  applyTrim = false,
): Set<number> {

  const { width, height, length } = grid;
  const corniceYs = new Set<number>();

  // For each axis direction, compute the facade depth profile per Y layer.
  // Facade depth = how far inward the outermost solid block sits from the AABB edge.

  // X-axis: scan from minX and maxX edges
  for (let z = 0; z < length; z++) {
    // West edge depth per Y
    const westDepth = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let depth = width; // no block found
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) { depth = x; break; }
      }
      westDepth[y] = depth;
    }

    // Detect Y-layers where depth changes sharply
    for (let y = 1; y < height; y++) {
      if (westDepth[y] === width || westDepth[y - 1] === width) continue;
      const delta = Math.abs(westDepth[y] - westDepth[y - 1]);
      if (delta >= minDepthDelta) {
        corniceYs.add(y);
        corniceYs.add(y - 1);
      }
    }

    // East edge depth per Y
    const eastDepth = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let depth = width;
      for (let x = width - 1; x >= 0; x--) {
        if (grid.get(x, y, z) !== AIR) { depth = width - 1 - x; break; }
      }
      eastDepth[y] = depth;
    }

    for (let y = 1; y < height; y++) {
      if (eastDepth[y] === width || eastDepth[y - 1] === width) continue;
      if (Math.abs(eastDepth[y] - eastDepth[y - 1]) >= minDepthDelta) {
        corniceYs.add(y);
        corniceYs.add(y - 1);
      }
    }
  }

  // Z-axis: scan from minZ and maxZ edges
  for (let x = 0; x < width; x++) {
    const northDepth = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let depth = length;
      for (let z2 = 0; z2 < length; z2++) {
        if (grid.get(x, y, z2) !== AIR) { depth = z2; break; }
      }
      northDepth[y] = depth;
    }

    for (let y = 1; y < height; y++) {
      if (northDepth[y] === length || northDepth[y - 1] === length) continue;
      if (Math.abs(northDepth[y] - northDepth[y - 1]) >= minDepthDelta) {
        corniceYs.add(y);
        corniceYs.add(y - 1);
      }
    }

    const southDepth = new Int32Array(height);
    for (let y = 0; y < height; y++) {
      let depth = length;
      for (let z2 = length - 1; z2 >= 0; z2--) {
        if (grid.get(x, y, z2) !== AIR) { depth = length - 1 - z2; break; }
      }
      southDepth[y] = depth;
    }

    for (let y = 1; y < height; y++) {
      if (southDepth[y] === length || southDepth[y - 1] === length) continue;
      if (Math.abs(southDepth[y] - southDepth[y - 1]) >= minDepthDelta) {
        corniceYs.add(y);
        corniceYs.add(y - 1);
      }
    }
  }

  // Optionally apply trim material to cornice edges
  if (applyTrim && corniceYs.size > 0) {
    const TRIM = 'minecraft:stone_brick_slab';


    for (const y of corniceYs) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const block = grid.get(x, y, z);
          if (block === AIR) continue;

          // Only trim exterior blocks (adjacent to air)
          let isExterior = false;
          for (const [dx, dz] of H_DIRS) {
            const nx = x + dx, nz = z + dz;
            if (nx < 0 || nx >= width || nz < 0 || nz >= length || grid.get(nx, y, nz) === AIR) {
              isExterior = true; break;
            }
          }
          // Also check above — cornices protrude upward
          if (!isExterior && y + 1 < height && grid.get(x, y + 1, z) === AIR) {
            isExterior = true;
          }

          if (isExterior) {
            grid.set(x, y, z, TRIM);
          }
        }
      }
    }
  }

  return corniceYs;
}

/**
 * Phase 5c: Setback-aware facade flattening — detects multiple facade planes
 * per wall at different Y-height ranges and flattens each section independently.
 *
 * Buildings with setbacks (Art Deco towers, zoning-stepped buildings) have
 * different facade planes above and below setback levels. Standard flattenFacades
 * picks a single dominant plane that doesn't match either section. This version
 * splits the Y range at detected setback Y levels and runs per-section flattening.
 *
 * @param grid          BlockGrid (modified in place)
 * @param corniceYs     Set of Y levels to exclude from flattening (from detectCornices)
 * @param snapRadius    Max snap distance for flattening (default: 2)
 * @returns Number of voxels snapped
 */
export function flattenFacadesSetbackAware(
  grid: BlockGrid,
  corniceYs: Set<number>,
  snapRadius = 2,
): number {
  const { width, height, length } = grid;
  let totalSnapped = 0;

  // Sort cornice Y levels to define sections
  const sortedCornices = [...corniceYs].sort((a, b) => a - b);

  // Build Y-range sections: [0, firstCornice), [firstCornice, secondCornice), ...
  const sections: [number, number][] = [];
  let prevY = 0;
  for (const cy of sortedCornices) {
    if (cy > prevY + 2) { // Minimum section height of 3
      sections.push([prevY, cy]);
      prevY = cy;
    }
  }
  // Final section from last cornice to top
  if (prevY < height) {
    sections.push([prevY, height]);
  }

  // If no meaningful sections detected, fall back to standard flatten
  if (sections.length <= 1) {
    return flattenFacades(grid, snapRadius);
  }

  // Flatten each section independently — each gets its own dominant plane detection
  for (const [yMin, yMax] of sections) {
    const sectionHeight = yMax - yMin;
    if (sectionHeight < 3) continue; // Too thin to flatten meaningfully

    // X-axis flattening for this Y section
    for (let z = 0; z < length; z++) {
      const xHist = new Int32Array(width);
      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue; // Skip cornice layers
        for (let x = 0; x < width; x++) {
          if (grid.get(x, y, z) !== 'minecraft:air') xHist[x]++;
        }
      }

      const minPeak = sectionHeight * 0.1;
      const peaks: number[] = [];
      for (let x = 0; x < width; x++) {
        if (xHist[x] < minPeak) continue;
        const left = x > 0 ? xHist[x - 1] : 0;
        const right = x < width - 1 ? xHist[x + 1] : 0;
        if (xHist[x] >= left && xHist[x] >= right) {
          peaks.push(x);
        }
      }
      if (peaks.length === 0) continue;

      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue; // Don't flatten cornices
        for (let x = 0; x < width; x++) {
          const block = grid.get(x, y, z);
          if (block === 'minecraft:air') continue;
          if (peaks.includes(x)) continue;

          let nearestPeak = -1;
          let nearestDist = snapRadius + 1;
          for (const peak of peaks) {
            const dist = Math.abs(x - peak);
            if (dist <= snapRadius && dist < nearestDist) {
              nearestDist = dist; nearestPeak = peak;
            }
          }

          if (nearestPeak >= 0 && nearestPeak !== x) {
            if (grid.get(nearestPeak, y, z) === 'minecraft:air') {
              grid.set(nearestPeak, y, z, block);
              grid.set(x, y, z, 'minecraft:air');
              totalSnapped++;
            }
          }
        }
      }
    }

    // Z-axis flattening for this Y section
    for (let x = 0; x < width; x++) {
      const zHist = new Int32Array(length);
      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue;
        for (let z = 0; z < length; z++) {
          if (grid.get(x, y, z) !== 'minecraft:air') zHist[z]++;
        }
      }

      const minPeak = sectionHeight * 0.1;
      const peaks: number[] = [];
      for (let z = 0; z < length; z++) {
        if (zHist[z] < minPeak) continue;
        const prev = z > 0 ? zHist[z - 1] : 0;
        const next = z < length - 1 ? zHist[z + 1] : 0;
        if (zHist[z] >= prev && zHist[z] >= next) {
          peaks.push(z);
        }
      }
      if (peaks.length === 0) continue;

      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue;
        for (let z = 0; z < length; z++) {
          const block = grid.get(x, y, z);
          if (block === 'minecraft:air') continue;
          if (peaks.includes(z)) continue;

          let nearestPeak = -1;
          let nearestDist = snapRadius + 1;
          for (const peak of peaks) {
            const dist = Math.abs(z - peak);
            if (dist <= snapRadius && dist < nearestDist) {
              nearestDist = dist; nearestPeak = peak;
            }
          }

          if (nearestPeak >= 0 && nearestPeak !== z) {
            if (grid.get(x, y, nearestPeak) === 'minecraft:air') {
              grid.set(x, y, nearestPeak, block);
              grid.set(x, y, z, 'minecraft:air');
              totalSnapped++;
            }
          }
        }
      }
    }
  }

  return totalSnapped;
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

/**
 * Seal multi-block holes on facade surfaces using per-Y scanline fill.
 *
 * For each cardinal direction (N/S/E/W) and each Y level independently,
 * projects the facade surface onto a 1D scanline (perpendicular axis),
 * finds the building extent (leftmost/rightmost solid), and fills interior
 * air gaps that are smaller than `maxGapWidth`.
 *
 * Works per-Y-layer (no vertical flood-fill), so buildings with open lower
 * levels (columns, pilotis) don't leak exterior air into upper-floor holes.
 * Courtyard-safe: courtyards create gaps wider than maxGapWidth.
 *
 * Also runs vertical scanlines (per-perp-column) to catch vertically-oriented
 * holes missed by horizontal passes.
 *
 * @param grid  Source BlockGrid (modified in place)
 * @param maxGapWidth  Max gap width to fill in scanline (default: 15 blocks).
 *   Wider gaps are left alone (probably courtyards or intentional openings).
 * @returns Number of air voxels filled
 */
export function fillFacadeVoids2D(grid: BlockGrid, maxGapWidth = 15): number {
  const { width, height, length } = grid;

  let totalFilled = 0;

  // Process 4 facade directions
  const directions: Array<{
    label: string;
    perpSize: number;
    toXYZ: (a: number, p: number, y: number) => [number, number, number];
    rayStart: number;
    rayEnd: number;
    rayStep: number;
  }> = [
    { label: '+X', perpSize: length,
      toXYZ: (a, p, y) => [a, y, p],
      rayStart: width - 1, rayEnd: -1, rayStep: -1 },
    { label: '-X', perpSize: length,
      toXYZ: (a, p, y) => [a, y, p],
      rayStart: 0, rayEnd: width, rayStep: 1 },
    { label: '+Z', perpSize: width,
      toXYZ: (a, p, y) => [p, y, a],
      rayStart: length - 1, rayEnd: -1, rayStep: -1 },
    { label: '-Z', perpSize: width,
      toXYZ: (a, p, y) => [p, y, a],
      rayStart: 0, rayEnd: length, rayStep: 1 },
  ];

  for (const dir of directions) {
    const { perpSize, toXYZ, rayStart, rayEnd, rayStep } = dir;

    // For each (perp, y), find the outermost solid block = facade surface
    const surfaceDepth = new Int32Array(perpSize * height).fill(-1);
    const surfaceBlock: string[] = new Array(perpSize * height).fill(AIR);

    for (let p = 0; p < perpSize; p++) {
      for (let y = 0; y < height; y++) {
        for (let a = rayStart; a !== rayEnd; a += rayStep) {
          const [x, gy, z] = toXYZ(a, p, y);
          const block = grid.get(x, gy, z);
          if (block !== AIR) {
            surfaceDepth[p * height + y] = a;
            surfaceBlock[p * height + y] = block;
            break;
          }
        }
      }
    }

    // --- Pass 1: Horizontal scanlines (fill gaps along perp axis per Y level) ---
    for (let y = 0; y < height; y++) {
      // Find building extent at this Y level
      let pMin = -1, pMax = -1;
      for (let p = 0; p < perpSize; p++) {
        if (surfaceDepth[p * height + y] >= 0) {
          if (pMin < 0) pMin = p;
          pMax = p;
        }
      }
      if (pMin < 0) continue; // no building at this Y level

      // Scan within building extent for air gaps
      let gapStart = -1;
      for (let p = pMin; p <= pMax + 1; p++) {
        const hasSolid = p <= pMax && surfaceDepth[p * height + y] >= 0;

        if (!hasSolid && gapStart < 0) {
          gapStart = p; // start of gap
        } else if (hasSolid && gapStart >= 0) {
          // End of gap — fill if narrow enough
          const gapLen = p - gapStart;
          if (gapLen <= maxGapWidth) {
            // Collect neighbor depths and blocks for fill material
            const neighborDepths: number[] = [];
            const neighborCounts = new Map<string, number>();

            // Look at solid neighbors on both sides of the gap
            for (const np of [gapStart - 1, p]) {
              if (np >= 0 && np < perpSize) {
                const d = surfaceDepth[np * height + y];
                const b = surfaceBlock[np * height + y];
                if (d >= 0 && b !== AIR) {
                  neighborDepths.push(d);
                  neighborCounts.set(b, (neighborCounts.get(b) || 0) + 1);
                }
              }
            }
            if (neighborDepths.length === 0) { gapStart = -1; continue; }

            // Fill block = most common neighbor
            let fillBlock = AIR;
            let bestCount = 0;
            for (const [b, c] of neighborCounts) {
              if (c > bestCount) { fillBlock = b; bestCount = c; }
            }

            // Fill depth = average of neighbor depths
            const fillDepth = Math.round(
              neighborDepths.reduce((s, d) => s + d, 0) / neighborDepths.length
            );

            for (let fp = gapStart; fp < p; fp++) {
              const [x, gy, z] = toXYZ(fillDepth, fp, y);
              if (grid.get(x, gy, z) === AIR) {
                grid.set(x, gy, z, fillBlock);
                totalFilled++;
                // Update surface arrays so vertical pass sees the fill
                surfaceDepth[fp * height + y] = fillDepth;
                surfaceBlock[fp * height + y] = fillBlock;
              }
            }
          }
          gapStart = -1;
        }
      }
    }

    // --- Pass 2: Vertical scanlines (fill gaps along Y axis per perp column) ---
    for (let p = 0; p < perpSize; p++) {
      // Find building extent at this perp column
      let yMin = -1, yMax = -1;
      for (let y = 0; y < height; y++) {
        if (surfaceDepth[p * height + y] >= 0) {
          if (yMin < 0) yMin = y;
          yMax = y;
        }
      }
      if (yMin < 0) continue;

      let gapStart = -1;
      for (let y = yMin; y <= yMax + 1; y++) {
        const hasSolid = y <= yMax && surfaceDepth[p * height + y] >= 0;

        if (!hasSolid && gapStart < 0) {
          gapStart = y;
        } else if (hasSolid && gapStart >= 0) {
          const gapLen = y - gapStart;
          if (gapLen <= maxGapWidth) {
            const neighborDepths: number[] = [];
            const neighborCounts = new Map<string, number>();

            for (const ny of [gapStart - 1, y]) {
              if (ny >= 0 && ny < height) {
                const d = surfaceDepth[p * height + ny];
                const b = surfaceBlock[p * height + ny];
                if (d >= 0 && b !== AIR) {
                  neighborDepths.push(d);
                  neighborCounts.set(b, (neighborCounts.get(b) || 0) + 1);
                }
              }
            }
            if (neighborDepths.length === 0) { gapStart = -1; continue; }

            let fillBlock = AIR;
            let bestCount = 0;
            for (const [b, c] of neighborCounts) {
              if (c > bestCount) { fillBlock = b; bestCount = c; }
            }

            const fillDepth = Math.round(
              neighborDepths.reduce((s, d) => s + d, 0) / neighborDepths.length
            );

            for (let fy = gapStart; fy < y; fy++) {
              const [x, gy, z] = toXYZ(fillDepth, p, fy);
              if (grid.get(x, gy, z) === AIR) {
                grid.set(x, gy, z, fillBlock);
                totalFilled++;
              }
            }
          }
          gapStart = -1;
        }
      }
    }
  }

  return totalFilled;
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
 * @returns Number of interior air voxels filled
 */
export function fillInteriorGaps(grid: BlockGrid, dilateRadius = 2): number {
  const { width, height, length } = grid;

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
  // dilateRadius=2 closes 2-voxel gaps — enough for most photogrammetry porosity.
  let currentMask = new Uint8Array(originalSolid);
  for (let step = 0; step < dilateRadius; step++) {
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
 * @param grid  Source BlockGrid (modified in place)
 * @returns Number of interior air voxels filled
 */
export function scanlineInteriorFill(grid: BlockGrid): number {

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
        const idx = z * width + x;
        if (insideX[idx] && insideZ[idx]) {
          // Sky-visibility check: if there's a solid block above this position,
          // it's under a roof → safe to fill. If sky is visible → courtyard → skip.
          const top = topSolid[idx];
          if (top > y) {
            grid.set(x, y, z, FILL_BLOCK);
            filled++;
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
 * @returns             Number of fill blocks removed
 */
export function clearOpenAirFill(
  grid: BlockGrid,
  fillBlock = 'minecraft:smooth_stone',
  minClearance = 5,
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

  // Step 3: Clear fill only in columns belonging to large components
  let removed = 0;
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      const id = componentId[z * width + x];
      if (id === 0) continue;
      const size = componentSizes.get(id)!;
      if (size < MIN_OPEN_AIR_COLUMNS) continue;

      // Clear all fill blocks in this open-air column (no roof above them)
      for (let y = height - 1; y >= 0; y--) {
        if (grid.get(x, y, z) === fillBlock) {
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
export function rectangularize(grid: BlockGrid, minRegionSize = 20, maxExtend = 2, facadeDepth = 0): number {
  const { width, height, length } = grid;

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

        if (size < minRegionSize) continue;

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
            // Facade zone: only fill within maxExtend of existing solid.
            // This preserves balconies, recesses, and other depth features.
            const effectiveMax = maxExtend;
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

// ─── Footprint & edge operations ────────────────────────────────────────────

/**
 * Straighten jagged building edges using median-filter trace smoothing.
 *
 * For each Y layer, computes the left/right/front/back edge traces (the first and
 * last solid block in each row/column). Applies a sliding median filter to smooth
 * stair-steps, then fills or clears the 1-2 block band to match.
 *
 * Only shifts edges by up to maxShift blocks to avoid distorting real architectural
 * features (balconies, setbacks). Run after fill but before facade smoothing.
 */
export function straightenFootprintEdges(
  grid: BlockGrid,
  maxShift = 2,
  windowRadius = 2,
  wallBlock?: string,
): number {

  const { width, height, length } = grid;
  let changed = 0;

  // Determine dominant wall block from bottom 25% of height
  const wallDom = wallBlock ?? (() => {
    const counts = new Map<string, number>();
    const maxY = Math.floor(height * 0.25);
    for (let y = 0; y <= maxY; y++) {
      for (let z = 0; z < length; z++) {
        for (let x = 0; x < width; x++) {
          const b = grid.get(x, y, z);
          if (b !== AIR) counts.set(b, (counts.get(b) ?? 0) + 1);
        }
      }
    }
    let best = AIR;
    let bestC = 0;
    for (const [b, c] of counts) { if (c > bestC) { best = b; bestC = c; } }
    return best;
  })();

  // Median of an array (handles NaN by filtering)
  function median(arr: number[]): number {
    const valid = arr.filter(v => v >= 0);
    if (valid.length === 0) return -1;
    valid.sort((a, b) => a - b);
    return valid[Math.floor(valid.length / 2)];
  }

  // Process each Y layer
  for (let y = 0; y < height; y++) {
    // Check if this layer has enough blocks to be worth straightening
    let layerCount = 0;
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) layerCount++;
      }
    }
    if (layerCount < 20) continue; // Skip sparse layers

    // Compute left (min-x) and right (max-x) traces for each z
    const leftTrace = new Int32Array(length).fill(-1);
    const rightTrace = new Int32Array(length).fill(-1);
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) !== AIR) {
          if (leftTrace[z] < 0) leftTrace[z] = x;
          rightTrace[z] = x;
        }
      }
    }

    // Median-filter the traces
    for (let z = 0; z < length; z++) {
      if (leftTrace[z] < 0) continue;

      // Collect window for left trace
      const leftWindow: number[] = [];
      const rightWindow: number[] = [];
      for (let dz = -windowRadius; dz <= windowRadius; dz++) {
        const nz = z + dz;
        if (nz >= 0 && nz < length) {
          if (leftTrace[nz] >= 0) leftWindow.push(leftTrace[nz]);
          if (rightTrace[nz] >= 0) rightWindow.push(rightTrace[nz]);
        }
      }

      const newLeft = median(leftWindow);
      const newRight = median(rightWindow);

      // Apply left edge correction (within maxShift)
      if (newLeft >= 0 && Math.abs(newLeft - leftTrace[z]) <= maxShift && newLeft !== leftTrace[z]) {
        if (newLeft < leftTrace[z]) {
          // Fill inward (extend building edge)
          for (let x = newLeft; x < leftTrace[z]; x++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          // Clear outward (retract building edge)
          for (let x = leftTrace[z]; x < newLeft; x++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }

      // Apply right edge correction
      if (newRight >= 0 && Math.abs(newRight - rightTrace[z]) <= maxShift && newRight !== rightTrace[z]) {
        if (newRight > rightTrace[z]) {
          for (let x = rightTrace[z] + 1; x <= newRight; x++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let x = newRight + 1; x <= rightTrace[z]; x++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }
    }

    // Same for front/back traces (min-z/max-z per x column)
    const frontTrace = new Int32Array(width).fill(-1);
    const backTrace = new Int32Array(width).fill(-1);
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        if (grid.get(x, y, z) !== AIR) {
          if (frontTrace[x] < 0) frontTrace[x] = z;
          backTrace[x] = z;
        }
      }
    }

    for (let x = 0; x < width; x++) {
      if (frontTrace[x] < 0) continue;

      const frontWindow: number[] = [];
      const backWindow: number[] = [];
      for (let dx = -windowRadius; dx <= windowRadius; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) {
          if (frontTrace[nx] >= 0) frontWindow.push(frontTrace[nx]);
          if (backTrace[nx] >= 0) backWindow.push(backTrace[nx]);
        }
      }

      const newFront = median(frontWindow);
      const newBack = median(backWindow);

      if (newFront >= 0 && Math.abs(newFront - frontTrace[x]) <= maxShift && newFront !== frontTrace[x]) {
        if (newFront < frontTrace[x]) {
          for (let z = newFront; z < frontTrace[x]; z++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let z = frontTrace[x]; z < newFront; z++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
      }

      if (newBack >= 0 && Math.abs(newBack - backTrace[x]) <= maxShift && newBack !== backTrace[x]) {
        if (newBack > backTrace[x]) {
          for (let z = backTrace[x] + 1; z <= newBack; z++) {
            if (grid.get(x, y, z) === AIR) { grid.set(x, y, z, wallDom); changed++; }
          }
        } else {
          for (let z = newBack + 1; z <= backTrace[x]; z++) {
            if (grid.get(x, y, z) !== AIR) { grid.set(x, y, z, AIR); changed++; }
          }
        }
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

/**
 * Targeted facade-plane hole filler — fills medium-sized gaps (2-5 blocks)
 * that survive the single-pass `fillFacadeHoles()` by operating in 2D on
 * detected facade planes.
 *
 * Algorithm:
 * 1. For each cardinal direction, detect facade voxels (solid with air neighbor
 *    in that direction) and find the dominant depth coordinate per Y×perp cell.
 * 2. Project the facade to a 2D bitmap (Y × perpendicular axis).
 * 3. Flood-fill exterior air from edges to classify interior vs. exterior air.
 * 4. Fill interior air pockets (bounded holes) whose area ≤ maxGapArea.
 * 5. Write filled voxels back to 3D grid at the facade depth coordinate.
 *
 * This avoids the courtyard problem because courtyards connect to exterior air
 * in the 2D projection. Only true enclosed holes on the facade surface get filled.
 *
 * @param grid        BlockGrid (modified in place)
 * @param maxGapArea  Maximum 2D air pocket area to fill (default: 25 = 5×5 block region)
 * @returns Number of voxels filled
 */
export function fillFacadePlaneHoles(grid: BlockGrid, maxGapArea = 25): number {
  const { width, height, length } = grid;

  let totalFilled = 0;

  // 4 cardinal facade directions: axis=X or Z, sign=+1 or -1
  const directions: Array<{
    // perpSize: size along the perpendicular horizontal axis
    perpSize: number;
    // axisSize: size along the facade normal axis
    axisSize: number;
    // Convert (axis, perp, y) back to grid (x, y, z)
    toXYZ: (a: number, p: number, y: number) => [number, number, number];
    // Direction from solid toward exterior air (the outward normal)
    normalSign: number;
  }> = [
    // +X facade: solid block has air at x+1
    { perpSize: length, axisSize: width,
      toXYZ: (a, p, y) => [a, y, p], normalSign: 1 },
    // -X facade: solid block has air at x-1
    { perpSize: length, axisSize: width,
      toXYZ: (a, p, y) => [a, y, p], normalSign: -1 },
    // +Z facade: solid block has air at z+1
    { perpSize: width, axisSize: length,
      toXYZ: (a, p, y) => [p, y, a], normalSign: 1 },
    // -Z facade: solid block has air at z-1
    { perpSize: width, axisSize: length,
      toXYZ: (a, p, y) => [p, y, a], normalSign: -1 },
  ];

  for (const dir of directions) {
    const { perpSize, axisSize, toXYZ, normalSign } = dir;
    const mapSize = perpSize * height;

    // For each (perp, y) cell, find the facade surface coordinate along the axis.
    // Facade = solid block with air in the normal direction (or at grid edge).
    // Store the outermost such coordinate per (perp, y) cell.
    const surfaceAxis = new Int16Array(mapSize).fill(-1);
    const surfaceBlock: string[] = new Array(mapSize).fill(AIR);

    for (let p = 0; p < perpSize; p++) {
      for (let y = 0; y < height; y++) {
        // Scan from the outside inward to find the outermost facade block
        const start = normalSign > 0 ? axisSize - 1 : 0;
        const end = normalSign > 0 ? -1 : axisSize;
        const step = normalSign > 0 ? -1 : 1;

        for (let a = start; a !== end; a += step) {
          const [x, gy, z] = toXYZ(a, p, y);
          const block = grid.get(x, gy, z);
          if (block !== AIR) {
            // Check if air is on the outward side (facade condition)
            const outA = a + normalSign;
            const isFacade = outA < 0 || outA >= axisSize ||
              grid.get(...toXYZ(outA, p, y)) === AIR;
            if (isFacade) {
              const idx = p * height + y;
              surfaceAxis[idx] = a;
              surfaceBlock[idx] = block;
            }
            break; // Only the outermost block matters
          }
        }
      }
    }

    // Build 2D bitmap: 1 = has facade block, 0 = air gap on facade plane
    const bitmap = new Uint8Array(mapSize);
    for (let i = 0; i < mapSize; i++) {
      if (surfaceAxis[i] >= 0) bitmap[i] = 1;
    }

    // Flood-fill exterior from edges (4-connected in 2D: perp × Y)
    const EXTERIOR = 2;
    const visited = new Uint8Array(mapSize);
    const queue: number[] = [];

    // Seed boundary cells that are air
    for (let p = 0; p < perpSize; p++) {
      for (const y of [0, height - 1]) {
        const idx = p * height + y;
        if (bitmap[idx] === 0 && !visited[idx]) {
          visited[idx] = EXTERIOR;
          queue.push(idx);
        }
      }
    }
    for (let y = 0; y < height; y++) {
      for (const p of [0, perpSize - 1]) {
        const idx = p * height + y;
        if (bitmap[idx] === 0 && !visited[idx]) {
          visited[idx] = EXTERIOR;
          queue.push(idx);
        }
      }
    }

    // BFS flood fill exterior air
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const p = Math.floor(idx / height);
      const y = idx % height;

      for (const [dp, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const np = p + dp, ny = y + dy;
        if (np < 0 || np >= perpSize || ny < 0 || ny >= height) continue;
        const ni = np * height + ny;
        if (visited[ni] || bitmap[ni] === 1) continue;
        visited[ni] = EXTERIOR;
        queue.push(ni);
      }
    }

    // Find interior air pockets (not exterior, not solid) via connected-component labeling
    let nextLabel = 1;
    const labels = new Int16Array(mapSize); // 0 = unlabeled
    const components: Map<number, number[]> = new Map();

    for (let i = 0; i < mapSize; i++) {
      if (bitmap[i] === 0 && visited[i] !== EXTERIOR && labels[i] === 0) {
        // BFS to label this interior pocket
        const label = nextLabel++;
        const pocket: number[] = [];
        const bfsQueue = [i];
        labels[i] = label;

        let bfsHead = 0;
        while (bfsHead < bfsQueue.length) {
          const ci = bfsQueue[bfsHead++];
          pocket.push(ci);
          const cp = Math.floor(ci / height);
          const cy = ci % height;

          for (const [dp, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const np2 = cp + dp, ny2 = cy + dy;
            if (np2 < 0 || np2 >= perpSize || ny2 < 0 || ny2 >= height) continue;
            const ni2 = np2 * height + ny2;
            if (labels[ni2] || bitmap[ni2] === 1 || visited[ni2] === EXTERIOR) continue;
            labels[ni2] = label;
            bfsQueue.push(ni2);
          }
        }

        if (pocket.length <= maxGapArea) {
          components.set(label, pocket);
        }
      }
    }

    // Fill each small interior pocket with the mode block of its boundary
    for (const [, pocket] of components) {
      // Collect boundary blocks around this pocket
      const boundaryCounts = new Map<string, number>();
      for (const ci of pocket) {
        const cp = Math.floor(ci / height);
        const cy = ci % height;
        for (const [dp, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const np = cp + dp, ny = cy + dy;
          if (np < 0 || np >= perpSize || ny < 0 || ny >= height) continue;
          const ni = np * height + ny;
          if (surfaceAxis[ni] >= 0 && surfaceBlock[ni] !== AIR) {
            boundaryCounts.set(surfaceBlock[ni], (boundaryCounts.get(surfaceBlock[ni]) ?? 0) + 1);
          }
        }
      }

      // Find mode block
      let fillBlock = 'minecraft:stone';
      let bestCount = 0;
      for (const [b, c] of boundaryCounts) {
        if (c > bestCount) { fillBlock = b; bestCount = c; }
      }

      // Fill pocket voxels — place at average depth of surrounding facade surface
      let depthSum = 0, depthN = 0;
      for (const ci of pocket) {
        const cp = Math.floor(ci / height);
        const cy = ci % height;
        for (const [dp, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const np = cp + dp, ny = cy + dy;
          if (np < 0 || np >= perpSize || ny < 0 || ny >= height) continue;
          const ni = np * height + ny;
          if (surfaceAxis[ni] >= 0) { depthSum += surfaceAxis[ni]; depthN++; }
        }
      }
      const fillDepth = depthN > 0 ? Math.round(depthSum / depthN) : -1;
      if (fillDepth < 0) continue;

      for (const ci of pocket) {
        const cp = Math.floor(ci / height);
        const cy = ci % height;
        const [fx, fy, fz] = toXYZ(fillDepth, cp, cy);
        if (fx >= 0 && fx < width && fy >= 0 && fy < height && fz >= 0 && fz < length) {
          if (grid.get(fx, fy, fz) === AIR) {
            grid.set(fx, fy, fz, fillBlock);
            totalFilled++;
          }
        }
      }
    }
  }

  return totalFilled;
}
