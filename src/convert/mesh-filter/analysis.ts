/**
 * Auto-detection analyzer for voxel grids.
 *
 * Analyzes a BlockGrid to classify building shape, detect entry points,
 * estimate confidence, and recommend optimal pipeline parameters.
 * Extracted from mesh-filter.ts — these are pure analysis functions with
 * no mutations to the grid.
 */

import { BlockGrid } from '../../schem/types.js';
import { AIR, FACES6 } from './_internal.js';

// ─── Exported types ─────────────────────────────────────────────────────────

/** Building shape classification from volumetric analysis */
export type BuildingTypology = 'tower' | 'flatiron' | 'block' | 'house' | 'complex';

/** Detected front face direction for street frontage */
export type FaceDirection = '+x' | '-x' | '+z' | '-z';

/** Complete analysis result with recommended pipeline parameters */
export interface AnalysisResult {
  // 1. Terrain / ground plane
  groundPlaneY: number;        // estimated ground Y layer
  slopeAngle: number;          // degrees — 0 = flat, >5 = sloped terrain
  isFlat: boolean;             // slopeAngle < 3°

  // 2. Central component isolation
  componentCount: number;      // number of distinct 3D connected components
  centralAABB: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number };
  suggestedCropRadius: number; // auto-computed XZ radius for --crop

  // 3. Capture boundary intersection — partial capture detection
  edgeTouchPct: number;        // % of non-air voxels touching grid XZ edges
  isPartialCapture: boolean;   // edgeTouchPct > 5% → building extends beyond capture

  // 4. Volumetric typology
  typology: BuildingTypology;
  aspectRatio: number;         // height / max(width, length) of central component
  footprintFill: number;       // fraction of XZ bounding rect filled at ground level
  isRectangular: boolean;      // footprintFill > 0.7

  // 4b. Shape classification for filter gating
  rectangularity: number;      // footprint area / OBB area (0-1, <0.85 = non-rectangular)
  hasSetbacks: boolean;        // footprint shrinks >20% between Y quartiles
  heightProfile: 'uniform' | 'tapered' | 'stepped' | 'domed';

  // 5. Roof analysis
  isFlatRoof: boolean;         // low heightmap variance in top 10%
  roofVariance: number;        // normalized variance of top-layer height distribution

  // 6. Facade color clustering (k=2 dominant + secondary)
  dominantBlock: string;       // most common non-air block on exterior surface
  secondaryBlock: string;      // second most common exterior block
  dominantPct: number;         // % of exterior surface covered by dominant block
  suggestedRemaps: Map<string, string>; // auto-generated --remap args

  // 7. Noise estimation
  protrusion1vCount: number;   // single-voxel protrusions (noise indicator)
  noisePct: number;            // protrusions / total non-air
  suggestedClean: number;      // recommended --clean value

  // 8. Street frontage
  frontFace: FaceDirection;    // side with most ground-level density

  // 9. Confidence score
  confidence: number;          // 1-10 predicted voxelization quality

  // 10. Entry/door detection
  entryPosition: { x: number; z: number } | null; // ground-level doorway position (grid coords)
  entryFace: FaceDirection;    // face where entry was detected (usually matches frontFace)
  entryWidth: number;          // width of the detected opening in blocks

  // 11. Ground boundary / footprint
  footprintArea: number;       // number of XZ columns with building blocks at ground level
  perimeterLength: number;     // number of ground-level blocks on the building perimeter
  groundContactY: number;      // Y layer where building first contacts ground

  // 12. Entry path — straight-line path from grid edge to detected entry
  entryPath: Array<{ x: number; z: number }>;  // path blocks from edge to door (empty if no entry)

  // 13. Data quality assessment
  compactness: number;           // footprintArea / AABB area (1.0 = perfect rectangle, <0.3 = scattered)
  dataQuality: 'good' | 'fair' | 'poor'; // overall capture quality verdict

  // 14. Building extent (at 1 block/m, blocks ≈ meters)
  estimatedWidthM: number;       // central component X extent
  estimatedHeightM: number;      // central component Y extent
  estimatedDepthM: number;       // central component Z extent
  estimatedFloors: number;       // estimated floor count (height / 3.5m per floor)

  // Recommended CLI args
  recommended: {
    generic: boolean;
    fill: boolean;
    noPalette: boolean;
    noCornice: boolean;
    noFireEscape: boolean;
    smoothPct: number;
    modePasses: number;
    cropRadius: number;       // circular crop (0 = skip)
    useAABBCrop: boolean;     // use AABB crop instead of circular (shape-preserving)
    cleanMinSize: number;
    remaps: Map<string, string>;
  };
}

// ─── Module-level block-type Sets (hoisted from analyzeGrid) ────────────────

/** Warm stucco / sandstone facade blocks */
const WARM_BLOCKS = new Set([
  'minecraft:smooth_sandstone', 'minecraft:sandstone', 'minecraft:orange_terracotta',
  'minecraft:yellow_terracotta', 'minecraft:white_terracotta', 'minecraft:terracotta',
]);

/** Cool / copper / green facade blocks */
const COOL_BLOCKS = new Set([
  'minecraft:cyan_terracotta', 'minecraft:light_blue_terracotta', 'minecraft:prismarine',
  'minecraft:dark_prismarine', 'minecraft:warped_planks',
]);

/** White / light gray facade blocks */
const WHITE_BLOCKS = new Set([
  'minecraft:smooth_quartz', 'minecraft:white_concrete', 'minecraft:quartz_block',
  'minecraft:snow_block', 'minecraft:iron_block',
]);

// ─── Functions ──────────────────────────────────────────────────────────────

/**
 * 3D flood-fill connected component labeling.
 * Returns component sizes and a label map (0 = air, 1..N = component ID).
 */
export function labelConnectedComponents(grid: BlockGrid): {
  labels: Int32Array;
  sizes: number[];
  count: number;
} {

  const { width, height, length } = grid;
  const total = width * height * length;
  const labels = new Int32Array(total); // 0 = unlabeled/air
  let nextLabel = 1;
  const sizes: number[] = [0]; // sizes[0] unused (air)

  // 6-connected flood fill via stack-based BFS
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
          const cx2 = ci % width;
          const cz2 = Math.floor(ci / width) % length;
          const cy2 = Math.floor(ci / (width * length));

          for (const [dx, dy, dz] of FACES6) {
            const nx = cx2 + dx, ny = cy2 + dy, nz = cz2 + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const ni = (ny * length + nz) * width + nx;
            if (labels[ni] !== 0 || grid.get(nx, ny, nz) === AIR) continue;
            labels[ni] = label;
            stack.push(ni);
          }
        }

        sizes.push(size);
      }
    }
  }

  return { labels, sizes, count: nextLabel - 1 };
}

/**
 * Analyze a voxel grid to auto-detect building properties and recommend
 * optimal pipeline parameters. Runs after trimSparseBottomLayers but before
 * any destructive shape processing.
 *
 * Implements 9 analysis criteria:
 * 1. Terrain/slope, 2. Component isolation, 3. Partial capture,
 * 4. Volumetric typology, 5. Roof flatness, 6. Facade color clustering,
 * 7. Noise estimation, 8. Street frontage, 9. Confidence scoring
 */
export function analyzeGrid(grid: BlockGrid): AnalysisResult {

  const { width, height, length } = grid;

  // ── 1. Ground plane / slope estimation ──
  // Find lowest non-air Y for each XZ column → fit plane
  const groundHeights: number[] = [];
  const groundXZ: [number, number][] = [];
  for (let z = 0; z < length; z++) {
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if (grid.get(x, y, z) !== AIR) {
          groundHeights.push(y);
          groundXZ.push([x, z]);
          break;
        }
      }
    }
  }

  let groundPlaneY = 0;
  let slopeAngle = 0;
  if (groundHeights.length > 0) {
    const sorted = [...groundHeights].sort((a, b) => a - b);
    groundPlaneY = sorted[Math.floor(sorted.length / 2)];

    // Use bottom 10% of heights for slope estimation
    const threshold = sorted[Math.floor(sorted.length * 0.1)];
    const groundOnly: { x: number; z: number; y: number }[] = [];
    for (let i = 0; i < groundHeights.length; i++) {
      if (groundHeights[i] <= threshold + 2) {
        groundOnly.push({ x: groundXZ[i][0], z: groundXZ[i][1], y: groundHeights[i] });
      }
    }

    if (groundOnly.length >= 3) {
      const minGY = groundOnly.reduce((m, g) => Math.min(m, g.y), Infinity);
      const maxGY = groundOnly.reduce((m, g) => Math.max(m, g.y), -Infinity);
      const rise = maxGY - minGY;
      const run = Math.sqrt(width * width + length * length);
      slopeAngle = Math.atan2(rise, run) * (180 / Math.PI);
    }
  }

  // ── 2. Connected component isolation ──
  const { labels, sizes: _componentSizes, count: componentCount } = labelConnectedComponents(grid);

  // Find primary building component using size-weighted centrality score.
  // Pure centroid-proximity fails for ring/courtyard buildings (Pentagon, Colosseum)
  // where a tiny noise voxel at center beats the actual structure.
  const cx = width / 2;
  const cz = length / 2;
  let centralLabel = 1;

  if (componentCount > 0) {
    const centroidX = new Float64Array(componentCount + 1);
    const centroidZ = new Float64Array(componentCount + 1);
    const compCounts = new Float64Array(componentCount + 1);

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

    // Establish baseline: largest component size
    let maxCompSize = 0;
    for (let i = 1; i <= componentCount; i++) {
      if (compCounts[i] > maxCompSize) maxCompSize = compCounts[i];
    }

    const maxDist = Math.sqrt(cx * cx + cz * cz); // max possible distance (corner to center)
    let bestScore = -Infinity;

    for (let i = 1; i <= componentCount; i++) {
      // Filter noise: must be ≥5% of largest component or ≥100 voxels
      if (compCounts[i] < Math.max(100, maxCompSize * 0.05)) continue;

      const mx = centroidX[i] / compCounts[i];
      const mz = centroidZ[i] / compCounts[i];
      const dist = Math.sqrt((mx - cx) * (mx - cx) + (mz - cz) * (mz - cz));

      // Score = volume penalized by distance from center (up to 50% reduction at edge)
      const normalizedDist = maxDist > 0 ? dist / maxDist : 0;
      const score = compCounts[i] * (1.0 - normalizedDist * 0.5);

      if (score > bestScore) {
        bestScore = score;
        centralLabel = i;
      }
    }
  }

  // Compute AABB of central component
  let cMinX = width, cMaxX = 0, cMinZ = length, cMaxZ = 0, cMinY = height, cMaxY = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (labels[(y * length + z) * width + x] !== centralLabel) continue;
        if (x < cMinX) cMinX = x;
        if (x > cMaxX) cMaxX = x;
        if (z < cMinZ) cMinZ = z;
        if (z > cMaxZ) cMaxZ = z;
        if (y < cMinY) cMinY = y;
        if (y > cMaxY) cMaxY = y;
      }
    }
  }

  const centralAABB = { minX: cMinX, maxX: cMaxX, minZ: cMinZ, maxZ: cMaxZ, minY: cMinY, maxY: cMaxY };

  // Suggested crop radius: half-diagonal of central AABB + 2 block margin
  const halfW = (cMaxX - cMinX) / 2;
  const halfL = (cMaxZ - cMinZ) / 2;
  const suggestedCropRadius = Math.ceil(Math.sqrt(halfW * halfW + halfL * halfL) + 2);

  // ── 3. Capture boundary intersection ──
  // Detect if building extends beyond capture radius by counting blocks on grid edges.
  // Note: cylindrical captures have low edge touch (~1.2%). The CLI pipeline handles
  // this by running OSM mask BEFORE fill to remove capture boundary walls.
  let edgeTouchCount = 0;
  let totalNonAir = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        totalNonAir++;
        if (x === 0 || x === width - 1 || z === 0 || z === length - 1) {
          edgeTouchCount++;
        }
      }
    }
  }
  const edgeTouchPct = totalNonAir > 0 ? (edgeTouchCount / totalNonAir) * 100 : 0;
  const isPartialCapture = edgeTouchPct > 5;

  // ── 4. Volumetric typology ──
  const centralW = cMaxX - cMinX + 1;
  const centralH = cMaxY - cMinY + 1;
  const centralL = cMaxZ - cMinZ + 1;
  const maxFootprint = Math.max(centralW, centralL);
  const aspectRatio = centralH / Math.max(maxFootprint, 1);

  // Footprint fill via ray-containment at mid-height.
  // Surface-mode voxelization produces hollow shells, so counting solid voxels
  // gives low fill (22%) for rectangular buildings. Instead, for each XZ column
  // cast rays in ±X direction: if both hit solid blocks, column is "inside".
  const midY = Math.floor((cMinY + cMaxY) / 2);
  let fpContained = 0;
  const fpTotal = centralW * centralL;
  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      // Cast +X ray from this column
      let hitPosX = false;
      for (let rx = x + 1; rx <= cMaxX; rx++) {
        if (labels[(midY * length + z) * width + rx] === centralLabel) { hitPosX = true; break; }
      }
      // Cast -X ray
      let hitNegX = false;
      for (let rx = x - 1; rx >= cMinX; rx--) {
        if (labels[(midY * length + z) * width + rx] === centralLabel) { hitNegX = true; break; }
      }
      // Cast +Z ray
      let hitPosZ = false;
      for (let rz = z + 1; rz <= cMaxZ; rz++) {
        if (labels[(midY * length + rz) * width + x] === centralLabel) { hitPosZ = true; break; }
      }
      // Cast -Z ray
      let hitNegZ = false;
      for (let rz = z - 1; rz >= cMinZ; rz--) {
        if (labels[(midY * length + rz) * width + x] === centralLabel) { hitNegZ = true; break; }
      }
      // Column is "contained" if enclosed from all 4 directions (or is itself solid)
      if ((hitPosX && hitNegX && hitPosZ && hitNegZ) ||
          labels[(midY * length + z) * width + x] === centralLabel) {
        fpContained++;
      }
    }
  }
  const footprintFill = fpTotal > 0 ? fpContained / fpTotal : 0;

  // Classify building shape.
  // Ray-containment footprintFill for surface-mode voxels:
  //   >0.25 = enclosed shell (typical building with thin surface walls)
  //   <0.25 = scattered/complex (multiple disconnected structures)
  // Quadrant analysis distinguishes rectangular from triangular footprints.
  const isEnclosed = footprintFill > 0.25;

  // Note: flatiron/wedge detection was attempted using corner occupancy,
  // footprint taper, and XZ projection fill, but surface-mode voxels produce
  // shells too sparse for reliable shape classification (all large buildings
  // cluster at 0.5-0.6 fill regardless of actual footprint shape).
  // Wedge buildings still get correct processing as 'block' (interior fill
  // handles any enclosed shell). Use --generic for manual non-rectangular override.
  const isRectangular = isEnclosed;

  let typology: BuildingTypology;
  if (aspectRatio > 1.5) {
    typology = 'tower';
  } else if (!isEnclosed) {
    typology = 'complex';
  } else if (centralH > 10) {
    typology = 'block';
  } else {
    typology = 'house';
  }

  // ── 4b. OBB rectangularity + setback detection ──
  // Compute oriented bounding box via brute-force angular sweep (36 steps = 5° each).
  // Collect occupied XZ columns of central component at mid-height.
  const obbColumns: { x: number; z: number }[] = [];
  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      if (labels[(midY * length + z) * width + x] === centralLabel) {
        obbColumns.push({ x: x - cMinX, z: z - cMinZ });
      }
    }
  }

  let rectangularity = 1.0;
  if (obbColumns.length > 2) {
    let minOBBArea = Infinity;
    for (let deg = 0; deg < 180; deg += 5) {
      const theta = deg * Math.PI / 180;
      const cos = Math.cos(theta);
      const sin = Math.sin(theta);
      let rMinU = Infinity, rMaxU = -Infinity;
      let rMinV = Infinity, rMaxV = -Infinity;
      for (const col of obbColumns) {
        const u = col.x * cos - col.z * sin;
        const v = col.x * sin + col.z * cos;
        if (u < rMinU) rMinU = u;
        if (u > rMaxU) rMaxU = u;
        if (v < rMinV) rMinV = v;
        if (v > rMaxV) rMaxV = v;
      }
      // +1 because columns are discrete cells
      const area = (rMaxU - rMinU + 1) * (rMaxV - rMinV + 1);
      if (area < minOBBArea) minOBBArea = area;
    }
    rectangularity = Math.min(1.0, obbColumns.length / minOBBArea);
  }

  // Detect setbacks: compare footprint area at height quartiles.
  // Count occupied XZ columns at 25%, 50%, 75% height of central component.
  const quartileAreas: number[] = [];
  for (const pct of [0.25, 0.50, 0.75]) {
    const sampleY = Math.floor(cMinY + (cMaxY - cMinY) * pct);
    let count = 0;
    for (let z = cMinZ; z <= cMaxZ; z++) {
      for (let x = cMinX; x <= cMaxX; x++) {
        if (labels[(sampleY * length + z) * width + x] === centralLabel) count++;
      }
    }
    quartileAreas.push(count);
  }
  const hasSetbacks = quartileAreas[0] > 0 && quartileAreas[2] < quartileAreas[0] * 0.80;

  // Classify height profile
  let heightProfile: 'uniform' | 'tapered' | 'stepped' | 'domed' = 'uniform';
  if (quartileAreas[0] > 0) {
    const ratio50 = quartileAreas[1] / quartileAreas[0];
    const ratio75 = quartileAreas[2] / quartileAreas[0];
    if (ratio75 < 0.3) {
      // Top is much narrower — check if linear taper or discrete steps
      heightProfile = ratio50 < 0.65 ? 'tapered' : 'stepped';
    } else if (ratio50 > ratio75 && ratio50 > 1.05) {
      // Middle is wider than bottom and top — dome/bulge
      heightProfile = 'domed';
    } else if (hasSetbacks) {
      heightProfile = 'stepped';
    }
  }

  // ── 5. Roof flatness ──
  const heightMap: number[] = [];
  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      for (let y = cMaxY; y >= cMinY; y--) {
        if (labels[(y * length + z) * width + x] === centralLabel) {
          heightMap.push(y);
          break;
        }
      }
    }
  }

  let roofVariance = 0;
  let isFlatRoof = true;
  if (heightMap.length > 0) {
    const sortedH = [...heightMap].sort((a, b) => b - a);
    const top10pct = sortedH.slice(0, Math.max(1, Math.floor(sortedH.length * 0.1)));
    const mean = top10pct.reduce((s, v) => s + v, 0) / top10pct.length;
    roofVariance = top10pct.reduce((s, v) => s + (v - mean) ** 2, 0) / top10pct.length;
    isFlatRoof = roofVariance < 2.0;
  }

  // ── 6. Facade color clustering ──
  // Count blocks on exterior surface of central component (exposed to air)
  const surfaceBlocks = new Map<string, number>();
  for (let y = cMinY; y <= cMaxY; y++) {
    for (let z = cMinZ; z <= cMaxZ; z++) {
      for (let x = cMinX; x <= cMaxX; x++) {
        if (labels[(y * length + z) * width + x] !== centralLabel) continue;
        const block = grid.get(x, y, z);
        if (block === AIR) continue;

        let isSurface = false;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as [number,number,number][]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (!grid.inBounds(nx, ny, nz) || grid.get(nx, ny, nz) === AIR) {
            isSurface = true;
            break;
          }
        }
        if (isSurface) {
          surfaceBlocks.set(block, (surfaceBlocks.get(block) ?? 0) + 1);
        }
      }
    }
  }

  const sortedBlocks = [...surfaceBlocks.entries()].sort((a, b) => b[1] - a[1]);
  const totalSurface = sortedBlocks.reduce((s, [, c]) => s + c, 0);
  const dominantBlock = sortedBlocks[0]?.[0] ?? AIR;
  const dominantPct = totalSurface > 0 ? (sortedBlocks[0]?.[1] ?? 0) / totalSurface * 100 : 0;
  const secondaryBlock = sortedBlocks[1]?.[0] ?? AIR;

  // Auto-generate remap suggestions based on dominant facade material
  const suggestedRemaps = new Map<string, string>();

  if (WARM_BLOCKS.has(dominantBlock) || WARM_BLOCKS.has(secondaryBlock)) {
    // Warm stucco building — remap shadows to sandstone family
    suggestedRemaps.set('minecraft:gray_concrete', 'minecraft:sandstone');
    suggestedRemaps.set('minecraft:light_gray_concrete', 'minecraft:smooth_sandstone');
    suggestedRemaps.set('minecraft:stone', 'minecraft:sandstone');
  } else if (COOL_BLOCKS.has(dominantBlock) || COOL_BLOCKS.has(secondaryBlock)) {
    // Copper/green building — remap to prismarine family
    suggestedRemaps.set('minecraft:gray_concrete', 'minecraft:dark_prismarine');
    suggestedRemaps.set('minecraft:light_gray_concrete', 'minecraft:prismarine');
    suggestedRemaps.set('minecraft:white_concrete', 'minecraft:prismarine');
  } else if (WHITE_BLOCKS.has(dominantBlock) || WHITE_BLOCKS.has(secondaryBlock)) {
    // White/light gray building — only remap the darkest noise (stone, cobblestone)
    // to preserve texture variety from andesite and stone_bricks which add visual
    // interest to facades (window sills, trim bands, floor separators).
    suggestedRemaps.set('minecraft:stone', 'minecraft:light_gray_concrete');
    suggestedRemaps.set('minecraft:cobblestone', 'minecraft:light_gray_concrete');
  }

  // ── 7. Noise estimation ──
  let protrusion1vCount = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (grid.get(x, y, z) === AIR) continue;
        let neighbors = 0;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]] as [number,number,number][]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (grid.inBounds(nx, ny, nz) && grid.get(nx, ny, nz) !== AIR) neighbors++;
        }
        if (neighbors <= 1) protrusion1vCount++;
      }
    }
  }
  const noisePct = totalNonAir > 0 ? (protrusion1vCount / totalNonAir) * 100 : 0;
  const suggestedClean = noisePct > 10 ? 100 : noisePct > 5 ? 50 : 0;

  // ── 8. Street frontage ──
  // Evaluate face density at ground level of central component
  const faceScores: Record<FaceDirection, number> = { '+x': 0, '-x': 0, '+z': 0, '-z': 0 };
  const scanH = Math.min(3, centralH);
  for (let dy = 0; dy < scanH; dy++) {
    const y = cMinY + dy;
    if (y >= height) break;
    for (let z = cMinZ; z <= cMaxZ; z++) {
      if (grid.inBounds(cMaxX, y, z) && grid.get(cMaxX, y, z) !== AIR) faceScores['+x']++;
      if (grid.inBounds(cMinX, y, z) && grid.get(cMinX, y, z) !== AIR) faceScores['-x']++;
    }
    for (let x = cMinX; x <= cMaxX; x++) {
      if (grid.inBounds(x, y, cMaxZ) && grid.get(x, y, cMaxZ) !== AIR) faceScores['+z']++;
      if (grid.inBounds(x, y, cMinZ) && grid.get(x, y, cMinZ) !== AIR) faceScores['-z']++;
    }
  }
  const frontFace = (Object.entries(faceScores) as [FaceDirection, number][])
    .sort((a, b) => b[1] - a[1])[0][0];

  // ── 10. Entry/door detection ──
  // Two strategies:
  // A. Air gap scan — contiguous air runs in facade surface at ground level.
  // B. Facade recession — spots where the wall is indented ≥2 blocks compared to neighbors.
  //    Common for building entrances (recessed doorways, covered porticos).
  let entryPosition: { x: number; z: number } | null = null;
  let entryFace: FaceDirection = frontFace;
  let entryWidth = 0;

  {
    const doorScanH = Math.min(3, centralH);
    type DoorCandidate = { x: number; z: number; width: number; distFromCenter: number; score: number };
    const candidates: DoorCandidate[] = [];

    const faces: FaceDirection[] = ['+x', '-x', '+z', '-z'];
    for (const face of faces) {
      const isXFace = face === '+x' || face === '-x';
      const fixedCoord = face === '+x' ? cMaxX : face === '-x' ? cMinX : face === '+z' ? cMaxZ : cMinZ;
      const sweepMin = isXFace ? cMinZ : cMinX;
      const sweepMax = isXFace ? cMaxZ : cMaxX;
      const sweepCenter = (sweepMin + sweepMax) / 2;
      const isFrontFace = face === frontFace;

      // Measure facade depth at each sweep position — how far from the AABB face
      // to the first solid block along the face normal direction.
      const depths: number[] = [];
      const occupied: boolean[] = [];
      for (let s = sweepMin; s <= sweepMax; s++) {
        let minDepth = Infinity;
        let hasBlock = false;
        for (let dy = 0; dy < doorScanH; dy++) {
          const y = cMinY + dy;
          if (y >= height) break;
          // Ray inward from face boundary to find first solid block
          const maxProbe = 6; // probe up to 6 blocks deep
          for (let d = 0; d < maxProbe; d++) {
            let px: number, pz: number;
            if (face === '+x') { px = cMaxX - d; pz = s; }
            else if (face === '-x') { px = cMinX + d; pz = s; }
            else if (face === '+z') { px = s; pz = cMaxZ - d; }
            else { px = s; pz = cMinZ + d; }
            if (grid.inBounds(px, y, pz) && grid.get(px, y, pz) !== AIR) {
              hasBlock = true;
              if (d < minDepth) minDepth = d;
              break;
            }
          }
        }
        depths.push(minDepth === Infinity ? -1 : minDepth);
        occupied.push(hasBlock);
      }

      // Strategy A: Air gap — contiguous runs of no block at facade boundary
      let runStart = -1;
      for (let i = 0; i <= occupied.length; i++) {
        if (i < occupied.length && !occupied[i]) {
          if (runStart < 0) runStart = i;
        } else if (runStart >= 0) {
          const runLen = i - runStart;
          if (runLen >= 1 && runLen <= 4) {
            const midRun = sweepMin + runStart + runLen / 2;
            const dist = Math.abs(midRun - sweepCenter);
            const gapX = isXFace ? fixedCoord : Math.round(midRun);
            const gapZ = isXFace ? Math.round(midRun) : fixedCoord;
            candidates.push({
              x: gapX, z: gapZ, width: runLen, distFromCenter: dist,
              score: (isFrontFace ? 10 : 3) + (4 - runLen) - dist * 0.1,
            });
          }
          runStart = -1;
        }
      }

      // Strategy B: Facade recession — contiguous runs deeper than neighbors
      // A recession is where depth[i] > median(depths) + 1 (entry is set back from facade)
      const validDepths = depths.filter(d => d >= 0);
      if (validDepths.length > 0) {
        const sortedDepths = [...validDepths].sort((a, b) => a - b);
        const medianDepth = sortedDepths[Math.floor(sortedDepths.length / 2)];
        const recessThreshold = medianDepth + 1;

        let rStart = -1;
        for (let i = 0; i <= depths.length; i++) {
          if (i < depths.length && depths[i] >= recessThreshold) {
            if (rStart < 0) rStart = i;
          } else if (rStart >= 0) {
            const rLen = i - rStart;
            // Recessed entry: 1-5 blocks wide
            if (rLen >= 1 && rLen <= 5) {
              const midRun = sweepMin + rStart + rLen / 2;
              const dist = Math.abs(midRun - sweepCenter);
              // Position at the recessed depth
              const avgDepth = depths.slice(rStart, rStart + rLen).reduce((s, d) => s + d, 0) / rLen;
              let gapX: number, gapZ: number;
              if (face === '+x') { gapX = Math.round(cMaxX - avgDepth); gapZ = Math.round(midRun); }
              else if (face === '-x') { gapX = Math.round(cMinX + avgDepth); gapZ = Math.round(midRun); }
              else if (face === '+z') { gapX = Math.round(midRun); gapZ = Math.round(cMaxZ - avgDepth); }
              else { gapX = Math.round(midRun); gapZ = Math.round(cMinZ + avgDepth); }
              candidates.push({
                x: gapX, z: gapZ, width: rLen, distFromCenter: dist,
                // Recession score: lower than air gap, but boost for front face and depth
                score: (isFrontFace ? 6 : 1) + avgDepth * 0.5 - dist * 0.1,
              });
            }
            rStart = -1;
          }
        }
      }
    }

    // Pick the best candidate by score
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      entryPosition = { x: best.x, z: best.z };
      entryWidth = best.width;
      // Determine face from position
      if (best.x >= cMaxX) entryFace = '+x';
      else if (best.x <= cMinX) entryFace = '-x';
      else if (best.z >= cMaxZ) entryFace = '+z';
      else if (best.z <= cMinZ) entryFace = '-z';
      else entryFace = frontFace; // recessed entries are inside the AABB
    }
  }

  // ── 11. Ground boundary / footprint ──
  // Count XZ columns with building blocks at the ground contact layer.
  // Perimeter = ground-level blocks adjacent to air in the XZ plane.
  const groundContactY = cMinY;
  let footprintArea = 0;
  let perimeterLength = 0;

  for (let z = cMinZ; z <= cMaxZ; z++) {
    for (let x = cMinX; x <= cMaxX; x++) {
      // Check bottom 2 layers for ground contact
      let hasGround = false;
      for (let dy = 0; dy < Math.min(2, centralH); dy++) {
        const y = groundContactY + dy;
        if (labels[(y * length + z) * width + x] === centralLabel) {
          hasGround = true;
          break;
        }
      }
      if (!hasGround) continue;
      footprintArea++;

      // Check 4-connected XZ neighbors — if any neighbor is air/empty, this is perimeter
      let isPerimeter = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]] as [number,number][]) {
        const nx = x + dx, nz = z + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= length) {
          isPerimeter = true; // grid edge = perimeter
          break;
        }
        let neighborHasGround = false;
        for (let dy = 0; dy < Math.min(2, centralH); dy++) {
          const y = groundContactY + dy;
          if (labels[(y * length + z + dz) * width + (x + dx)] === centralLabel) {
            neighborHasGround = true;
            break;
          }
        }
        if (!neighborHasGround) {
          isPerimeter = true;
          break;
        }
      }
      if (isPerimeter) perimeterLength++;
    }
  }

  // ── 12. Entry path generation ──
  // Straight-line path from the nearest grid edge to the entry position.
  // Follows the entry face normal outward to the grid boundary.
  const entryPath: Array<{ x: number; z: number }> = [];
  if (entryPosition) {
    let px = entryPosition.x;
    let pz = entryPosition.z;
    // Walk from entry toward the grid edge along the face normal
    const dx = entryFace === '+x' ? 1 : entryFace === '-x' ? -1 : 0;
    const dz = entryFace === '+z' ? 1 : entryFace === '-z' ? -1 : 0;
    // Start one step outside the entry
    px += dx;
    pz += dz;
    while (px >= 0 && px < width && pz >= 0 && pz < length) {
      // Skip if this position is inside the building
      const isBuilding = grid.inBounds(px, groundContactY, pz) &&
                         grid.get(px, groundContactY, pz) !== AIR;
      if (!isBuilding) {
        entryPath.push({ x: px, z: pz });
      }
      px += dx;
      pz += dz;
    }
  }

  // ── 13. Compactness and data quality ──
  const aabbArea = centralW * centralL;
  const compactness = aabbArea > 0 ? footprintArea / aabbArea : 0;

  // ── 14. Confidence scoring ──
  // Weighted heuristic 1-10 estimating voxelization quality.
  // Calibrated against Gemini visual scores: Francisco 9.5/10, Sentinel 5/10,
  // Green 6/10, Beach 4/10.
  let confidence = 5.0;

  // Positive indicators
  if (componentCount === 1) confidence += 1.0;
  else if (componentCount <= 3) confidence += 0.3;
  if (isRectangular) confidence += 0.5;
  if (isFlatRoof) confidence += 0.2;
  if (dominantPct > 40) confidence += 0.5;        // uniform facade color
  if (aspectRatio > 0.4 && aspectRatio < 2.0) confidence += 0.3;
  if (!isPartialCapture) confidence += 0.3;
  if (entryPosition) confidence += 0.3;            // detected entry = clean geometry
  // Footprint fill quality: high fill = clean rectangular building
  if (footprintFill > 0.4) confidence += 0.5;
  else if (footprintFill > 0.25) confidence += 0.2;
  // Large central component relative to total = focused capture
  const centralPct = totalNonAir > 0 ? (footprintArea * centralH) / totalNonAir : 0;
  if (centralPct > 0.6) confidence += 0.5;

  // Negative indicators
  if (isPartialCapture) confidence -= 2.0;
  if (noisePct > 15) confidence -= 1.5;
  else if (noisePct > 8) confidence -= 0.5;
  if (componentCount > 5) confidence -= 1.5;
  else if (componentCount > 3) confidence -= 0.5;
  if (slopeAngle > 10) confidence -= 0.5;
  if (totalNonAir < 500) confidence -= 2.0;
  else if (totalNonAir < 2000) confidence -= 0.5;
  if (edgeTouchPct > 15) confidence -= 1.0;
  // Small footprint relative to grid = lots of surrounding noise
  if (footprintArea < 50 && totalNonAir > 5000) confidence -= 1.0;

  confidence = Math.max(1, Math.min(10, confidence));

  const dataQuality: 'good' | 'fair' | 'poor' = confidence >= 7 ? 'good'
    : confidence >= 5 ? 'fair' : 'poor';

  // ── Build recommended pipeline args ──
  // Use AABB crop for non-rectangular buildings (preserves shape), circular for rectangular
  const needsCrop = componentCount > 1;
  const t = typology as BuildingTypology; // widen for future flatiron support
  const useAABBCrop = needsCrop && (t === 'flatiron' || t === 'complex');
  // Interior fill works for rectangular buildings (block, tower, house).
  // Non-rectangular (flatiron, complex, or OBB <0.85) need generic mode to preserve shape.
  const useGeneric = t === 'flatiron' || t === 'complex' || rectangularity < 0.85 || hasSetbacks;
  // Use full palette only for white/gray rectangular buildings where it was tuned.
  // Non-rectangular and colored buildings need colors preserved.
  const wantFullPalette = !useGeneric && (WHITE_BLOCKS.has(dominantBlock) || WHITE_BLOCKS.has(secondaryBlock));
  const recommended = {
    generic: useGeneric,
    fill: true,
    noPalette: !wantFullPalette,
    noCornice: !isFlatRoof || typology === 'house',
    noFireEscape: typology !== 'block' || centralH < 15,
    smoothPct: 0, // disabled: modeFilter3D handles noise locally; smoothRareBlocks
    // uses global frequency threshold that erases surface details after interior fill
    // inflates totalNonAir (2% of 425K solid = 8500 blocks, erasing windows/trim)
    modePasses: noisePct > 10 ? 4 : 3, // v92: bumped 2-3→3-4 for cleaner surfaces (deep review: "noisy, artifact-ridden")
    cropRadius: needsCrop && !useAABBCrop ? suggestedCropRadius : 0,
    useAABBCrop,
    cleanMinSize: suggestedClean,
    remaps: suggestedRemaps,
  };

  return {
    groundPlaneY, slopeAngle, isFlat: slopeAngle < 3,
    componentCount, centralAABB, suggestedCropRadius,
    edgeTouchPct, isPartialCapture,
    typology, aspectRatio, footprintFill, isRectangular,
    rectangularity, hasSetbacks, heightProfile,
    isFlatRoof, roofVariance,
    dominantBlock, secondaryBlock, dominantPct, suggestedRemaps,
    protrusion1vCount, noisePct, suggestedClean,
    frontFace,
    confidence,
    entryPosition, entryFace, entryWidth,
    footprintArea, perimeterLength, groundContactY,
    entryPath,
    compactness, dataQuality,
    // At 1 block/m resolution, block dimensions ≈ meters
    estimatedWidthM: centralW,
    estimatedHeightM: centralH,
    estimatedDepthM: centralL,
    estimatedFloors: Math.max(1, Math.round(centralH / 3.5)),
    recommended,
  };
}
