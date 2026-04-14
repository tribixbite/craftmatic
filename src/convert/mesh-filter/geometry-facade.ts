/**
 * Facade-domain geometry operations on BlockGrid voxel grids.
 *
 * Facade detection, alignment, plane operations, edge straightening,
 * and facade-specific hole filling. Split from geometry.ts.
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR, H_DIRS, snapshotGrid, readSnap } from './_internal.js';

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
export function flattenFacades(grid: BlockGrid, snapRadius = 2, maxY?: number, resolution = 1): number {
  const { width, height, length } = grid;
  // Scale snapRadius by resolution (higher resolution = larger snap distance needed)
  const scaledSnap = Math.max(1, Math.round(snapRadius * resolution));
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
    const peakSet = new Set<number>();     // O(1) .has() for skip checks
    const peaksArr: number[] = [];         // ordered list for nearest-peak search
    for (let x = 0; x < width; x++) {
      if (xHist[x] < minPeak) continue;
      const left = x > 0 ? xHist[x - 1] : 0;
      const right = x < width - 1 ? xHist[x + 1] : 0;
      if (xHist[x] >= left && xHist[x] >= right) {
        peakSet.add(x);
        peaksArr.push(x);
      }
    }

    if (peakSet.size === 0) continue;

    // Snap non-peak voxels to nearest peak within snapRadius (wall zone only)
    for (let y = 0; y < yLimit; y++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peakSet.has(x)) continue; // Already on a peak

        // Find nearest peak within scaledSnap
        let nearestPeak = -1;
        let nearestDist = scaledSnap + 1;
        for (const peak of peaksArr) {
          const dist = Math.abs(x - peak);
          if (dist <= scaledSnap && dist < nearestDist) {
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
    const peakSet = new Set<number>();
    const peaksArr: number[] = [];
    for (let z = 0; z < length; z++) {
      if (zHist[z] < minPeak) continue;
      const prev = z > 0 ? zHist[z - 1] : 0;
      const next = z < length - 1 ? zHist[z + 1] : 0;
      if (zHist[z] >= prev && zHist[z] >= next) {
        peakSet.add(z);
        peaksArr.push(z);
      }
    }

    if (peakSet.size === 0) continue;

    for (let y = 0; y < yLimit; y++) {
      for (let z = 0; z < length; z++) {
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        if (peakSet.has(z)) continue;

        let nearestPeak = -1;
        let nearestDist = scaledSnap + 1;
        for (const peak of peaksArr) {
          const dist = Math.abs(z - peak);
          if (dist <= scaledSnap && dist < nearestDist) {
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
  resolution = 1,
): number {
  const { width, height, length } = grid;
  const scaledSnap = Math.max(1, Math.round(snapRadius * resolution));
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
      const peakSet = new Set<number>();
      const peaksArr: number[] = [];
      for (let x = 0; x < width; x++) {
        if (xHist[x] < minPeak) continue;
        const left = x > 0 ? xHist[x - 1] : 0;
        const right = x < width - 1 ? xHist[x + 1] : 0;
        if (xHist[x] >= left && xHist[x] >= right) {
          peakSet.add(x);
          peaksArr.push(x);
        }
      }
      if (peakSet.size === 0) continue;

      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue; // Don't flatten cornices
        for (let x = 0; x < width; x++) {
          const block = grid.get(x, y, z);
          if (block === 'minecraft:air') continue;
          if (peakSet.has(x)) continue;

          let nearestPeak = -1;
          let nearestDist = scaledSnap + 1;
          for (const peak of peaksArr) {
            const dist = Math.abs(x - peak);
            if (dist <= scaledSnap && dist < nearestDist) {
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
      const peakSet = new Set<number>();
      const peaksArr: number[] = [];
      for (let z = 0; z < length; z++) {
        if (zHist[z] < minPeak) continue;
        const prev = z > 0 ? zHist[z - 1] : 0;
        const next = z < length - 1 ? zHist[z + 1] : 0;
        if (zHist[z] >= prev && zHist[z] >= next) {
          peakSet.add(z);
          peaksArr.push(z);
        }
      }
      if (peakSet.size === 0) continue;

      for (let y = yMin; y < yMax; y++) {
        if (corniceYs.has(y)) continue;
        for (let z = 0; z < length; z++) {
          const block = grid.get(x, y, z);
          if (block === 'minecraft:air') continue;
          if (peakSet.has(z)) continue;

          let nearestPeak = -1;
          let nearestDist = scaledSnap + 1;
          for (const peak of peaksArr) {
            const dist = Math.abs(z - peak);
            if (dist <= scaledSnap && dist < nearestDist) {
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
export function fillFacadeVoids2D(grid: BlockGrid, maxGapWidth = 15, resolution = 1): number {
  const { width, height, length } = grid;
  // Scale gap width by resolution (higher resolution = larger gaps in voxels)
  const scaledGap = Math.max(1, Math.round(maxGapWidth * resolution));

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
          if (gapLen <= scaledGap) {
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
          if (gapLen <= scaledGap) {
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
export function fillFacadePlaneHoles(grid: BlockGrid, maxGapArea = 25, resolution = 1): number {
  const { width, height, length } = grid;
  // Scale area quadratically by resolution (area = length^2)
  const scaledArea = Math.max(1, Math.round(maxGapArea * resolution * resolution));

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

        if (pocket.length <= scaledArea) {
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

/**
 * Iteratively fill voids on facade planes by expanding from existing facade blocks.
 *
 * Standard `fillFacadeHoles()` requires 4+ solid face-neighbors, which misses large
 * voids (5+ wide) where interior air has 0-2 neighbors. This function works per-facade
 * direction, projects the facade surface into a 2D plane, and iteratively fills air
 * voxels with >= 2 coplanar solid neighbors.
 *
 * Each iteration grows the filled region inward by one cell, like a wavefront advancing
 * from the existing facade edges. Capped at `maxIter` to prevent courtyard closure --
 * courtyards are large open regions that would require many more iterations.
 *
 * @param grid     BlockGrid (modified in place)
 * @param maxIter  Maximum fill iterations (default: 5). Higher fills larger voids but
 *                 risks closing intended openings.
 * @returns Total number of air voxels filled across all iterations and directions
 */
export function fillFacadeVoidsIterative(grid: BlockGrid, maxIter = 5): number {
  const { width, height, length } = grid;
  let totalFilled = 0;

  // Process 4 cardinal facade directions: for each direction, we identify facade
  // voxels (solid with air on the outward side) and work in the 2D plane they span.
  // Directions are defined by the facade normal axis and sign.
  const directions: Array<{
    /** Size along the perpendicular horizontal axis */
    perpSize: number;
    /** Size along the facade normal axis */
    axisSize: number;
    /** Convert (axis, perp, y) to grid (x, y, z) */
    toXYZ: (a: number, p: number, y: number) => [number, number, number];
    /** +1 = outward normal is positive axis, -1 = outward normal is negative axis */
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
    // The facade is the outermost solid block that has air on the normal side.
    const surfaceAxis = new Int16Array(mapSize).fill(-1);
    const surfaceBlock: string[] = new Array(mapSize).fill(AIR);

    for (let p = 0; p < perpSize; p++) {
      for (let y = 0; y < height; y++) {
        // Scan from the exterior inward to find the outermost facade block
        const start = normalSign > 0 ? axisSize - 1 : 0;
        const end = normalSign > 0 ? -1 : axisSize;
        const step = normalSign > 0 ? -1 : 1;

        for (let a = start; a !== end; a += step) {
          const [x, gy, z] = toXYZ(a, p, y);
          const block = grid.get(x, gy, z);
          if (block !== AIR) {
            const outA = a + normalSign;
            const isFacade = outA < 0 || outA >= axisSize ||
              grid.get(...toXYZ(outA, p, y)) === AIR;
            if (isFacade) {
              const idx = p * height + y;
              surfaceAxis[idx] = a;
              surfaceBlock[idx] = block;
            }
            break;
          }
        }
      }
    }

    // Build 2D bitmap of the facade plane: 1 = has facade block, 0 = void
    const bitmap = new Uint8Array(mapSize);
    for (let i = 0; i < mapSize; i++) {
      if (surfaceAxis[i] >= 0) bitmap[i] = 1;
    }

    // 2D neighbor directions in the (perp, y) plane
    const DIRS_2D: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    // Iteratively fill voids: air cells with >= 2 coplanar solid neighbors get filled
    for (let iter = 0; iter < maxIter; iter++) {
      const toFill: number[] = [];

      for (let p = 0; p < perpSize; p++) {
        for (let y = 0; y < height; y++) {
          const idx = p * height + y;
          if (bitmap[idx] !== 0) continue; // Already solid

          // Count coplanar solid neighbors in the 2D plane
          let solidN = 0;
          for (const [dp, dy] of DIRS_2D) {
            const np = p + dp, ny = y + dy;
            if (np < 0 || np >= perpSize || ny < 0 || ny >= height) continue;
            if (bitmap[np * height + ny] !== 0) solidN++;
          }

          if (solidN >= 2) {
            toFill.push(idx);
          }
        }
      }

      if (toFill.length === 0) break; // Converged

      // Determine fill block and depth for each newly filled cell from its neighbors
      for (const idx of toFill) {
        const p = Math.floor(idx / height);
        const y = idx % height;

        // Collect neighboring blocks and depths for material/depth selection
        const neighborCounts = new Map<string, number>();
        let depthSum = 0, depthN = 0;

        for (const [dp, dy] of DIRS_2D) {
          const np = p + dp, ny = y + dy;
          if (np < 0 || np >= perpSize || ny < 0 || ny >= height) continue;
          const ni = np * height + ny;
          if (bitmap[ni] !== 0 && surfaceBlock[ni] !== AIR) {
            neighborCounts.set(surfaceBlock[ni], (neighborCounts.get(surfaceBlock[ni]) ?? 0) + 1);
            if (surfaceAxis[ni] >= 0) { depthSum += surfaceAxis[ni]; depthN++; }
          }
        }

        // Pick mode block from neighbors
        let fillBlock = 'minecraft:stone';
        let bestCount = 0;
        for (const [b, c] of neighborCounts) {
          if (c > bestCount) { fillBlock = b; bestCount = c; }
        }

        // Fill depth = average of neighboring facade depths
        const fillDepth = depthN > 0 ? Math.round(depthSum / depthN) : -1;
        if (fillDepth < 0) continue;

        // Write to grid
        const [fx, fy, fz] = toXYZ(fillDepth, p, y);
        if (fx >= 0 && fx < width && fy >= 0 && fy < height && fz >= 0 && fz < length) {
          if (grid.get(fx, fy, fz) === AIR) {
            grid.set(fx, fy, fz, fillBlock);
            totalFilled++;
          }
        }

        // Update 2D state for next iteration
        bitmap[idx] = 1;
        surfaceAxis[idx] = fillDepth;
        surfaceBlock[idx] = fillBlock;
      }
    }
  }

  return totalFilled;
}

/**
 * Fill single-block vertical stripes on facade surfaces.
 *
 * Oblique photogrammetry capture angles produce a "venetian blind" artifact where
 * alternating horizontal rows are solid/air across a facade face. This creates
 * visible 1-block horizontal stripes. This function scans each facade face direction
 * and fills isolated single-air-block gaps sandwiched between solid blocks on the
 * same horizontal row.
 *
 * Only fills 1-wide gaps (not 2+) to avoid closing real architectural features
 * like window bands or recessed panels.
 *
 * @param grid  BlockGrid (modified in place)
 * @returns Number of stripe gaps filled
 */
export function fillFacadeStripes(grid: BlockGrid): number {
  const { width, height, length } = grid;
  // Take a snapshot so reads are consistent during mutation
  const snap = snapshotGrid(grid);
  let filled = 0;

  // Process X-facing facades: for each (y, z), scan along X
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 1; x < width - 1; x++) {
        if (readSnap(snap, grid, x, y, z) !== AIR) continue;

        // Check if this air block is on a facade (has air in +Z or -Z direction,
        // indicating it's on the surface, not buried interior)
        const hasAirNeighborZ =
          (z > 0 && readSnap(snap, grid, x, y, z - 1) === AIR) ||
          (z < length - 1 && readSnap(snap, grid, x, y, z + 1) === AIR);
        if (!hasAirNeighborZ) continue;

        // Look for solid blocks within 2 positions on each side along X
        let solidLeft: string | null = null;
        let solidRight: string | null = null;
        for (let d = 1; d <= 2; d++) {
          if (x - d >= 0) {
            const b = readSnap(snap, grid, x - d, y, z);
            if (b !== AIR) { solidLeft = b; break; }
          }
        }
        for (let d = 1; d <= 2; d++) {
          if (x + d < width) {
            const b = readSnap(snap, grid, x + d, y, z);
            if (b !== AIR) { solidRight = b; break; }
          }
        }

        // Only fill single-block gaps: both sides must have solid within 2 blocks,
        // and the gap must be exactly 1 wide (not part of a larger void)
        if (!solidLeft || !solidRight) continue;

        // Verify this is a single-block gap: BOTH immediate neighbors must be solid.
        // If either immediate neighbor is air, this is part of a 2+ wide gap.
        const leftImmediate = readSnap(snap, grid, x - 1, y, z);
        const rightImmediate = readSnap(snap, grid, x + 1, y, z);
        if (leftImmediate === AIR || rightImmediate === AIR) continue; // 2+ wide gap

        // Fill with the most common of the two neighbor blocks
        const fillBlock = solidLeft === solidRight ? solidLeft : solidRight;
        grid.set(x, y, z, fillBlock);
        filled++;
      }
    }
  }

  // Process Z-facing facades: for each (y, x), scan along Z
  // Retake snapshot after X-pass mutations
  const snap2 = snapshotGrid(grid);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 1; z < length - 1; z++) {
        if (readSnap(snap2, grid, x, y, z) !== AIR) continue;

        // Check if on a facade surface (has air in +X or -X direction)
        const hasAirNeighborX =
          (x > 0 && readSnap(snap2, grid, x - 1, y, z) === AIR) ||
          (x < width - 1 && readSnap(snap2, grid, x + 1, y, z) === AIR);
        if (!hasAirNeighborX) continue;

        // Look for solid blocks within 2 positions on each side along Z
        let solidFront: string | null = null;
        let solidBack: string | null = null;
        for (let d = 1; d <= 2; d++) {
          if (z - d >= 0) {
            const b = readSnap(snap2, grid, x, y, z - d);
            if (b !== AIR) { solidFront = b; break; }
          }
        }
        for (let d = 1; d <= 2; d++) {
          if (z + d < length) {
            const b = readSnap(snap2, grid, x, y, z + d);
            if (b !== AIR) { solidBack = b; break; }
          }
        }

        if (!solidFront || !solidBack) continue;

        // Verify single-block gap: BOTH immediate neighbors must be solid
        const frontImmediate = readSnap(snap2, grid, x, y, z - 1);
        const backImmediate = readSnap(snap2, grid, x, y, z + 1);
        if (frontImmediate === AIR || backImmediate === AIR) continue;

        const fillBlock = solidFront === solidBack ? solidFront : solidBack;
        grid.set(x, y, z, fillBlock);
        filled++;
      }
    }
  }

  return filled;
}
