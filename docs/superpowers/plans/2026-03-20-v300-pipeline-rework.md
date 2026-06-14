# v300 Pipeline Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the voxelization pipeline for picture-perfect Minecraft buildings — immediately recognizable, clean, with accurate photogrammetric color and architectural form.

**Architecture:** Unified `BuildingAlignment` type computed from OSM polygon MBR (Minimum Area Bounding Rectangle), propagated to capture cameras, mesh rotation, OSM masking, satellite grading, and front elevation rendering. Replace destructive post-processing (window glazing, zone normalization) with photogrammetry-preserving alternatives (gamma correction, CIELAB color mapping, reduced spatial filtering).

**Tech Stack:** TypeScript, bun, vitest, Three.js, Google 3D Tiles, Google Static Maps API, Gemini 2.5 Pro VLM, sharp (image processing)

**Spec:** `docs/superpowers/specs/2026-03-19-v300-pipeline-rework-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/convert/building-alignment.ts` | `BuildingAlignment` type, `computeBuildingAlignment()`, convex hull, MBR algorithm |
| `test/building-alignment.test.ts` | Unit tests for alignment computation |
| `test/sever-street-furniture.test.ts` | Unit tests for pole removal algorithm |
| `test/dda-shadows.test.ts` | Unit tests for DDA raycast shadow computation |

### Modified Files
| File | Changes |
|------|---------|
| `scripts/voxelize-glb.ts` | Gamma default 0.85→0.7, disable glazing, hybrid color, accept `BuildingAlignment` in `reorientToENU()` |
| `src/convert/mesh-filter.ts` | `severStreetFurniture()` (new export), import `BuildingAlignment` |
| `src/render/png-renderer.ts` | DDA shadow computation, AO multiplier tuning, `renderCutawayIsoBackLeft()` |
| `scripts/iterate-grade.ts` | Binary defect checklist, 5 separate images, building set, dynamic zoom, satellite rotation + OSM overlay |
| `scripts/tiles-headless.ts` | Orthographic camera, OSM query + alignment, `errorTarget` for ortho |
| `src/convert/multi-angle-capture.ts` | Accept `rotationDeg` parameter, rotate facade angles |

---

## Task 1: BuildingAlignment Type + computeBuildingAlignment()

Pure algorithm with no dependencies. Computes building orientation from OSM polygon using Minimum Area Bounding Rectangle.

**Files:**
- Create: `src/convert/building-alignment.ts`
- Create: `test/building-alignment.test.ts`

- [ ] **Step 1: Write failing tests for convex hull + MBR**

```typescript
// test/building-alignment.test.ts
import { describe, it, expect } from 'vitest';
import { computeBuildingAlignment } from '../src/convert/building-alignment.js';

describe('computeBuildingAlignment', () => {
  it('computes MBR for axis-aligned rectangle', () => {
    // Simple rectangle oriented N-S (no rotation needed)
    const polygon = [
      { lat: 40.0001, lon: -74.0001 },
      { lat: 40.0001, lon: -73.9999 },
      { lat: 39.9999, lon: -73.9999 },
      { lat: 39.9999, lon: -74.0001 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    // Axis-aligned → rotation should be ~0 or ~90 (either edge aligns)
    expect(result.rotationDeg % 90).toBeCloseTo(0, 0);
    expect(result.mbrWidth).toBeGreaterThan(0);
    expect(result.mbrDepth).toBeGreaterThan(0);
    expect(result.osmPolygon).toEqual(polygon);
  });

  it('detects 45° rotated square', () => {
    // Diamond shape — MBR should detect 45° rotation
    const center = { lat: 40.7484, lon: -73.9857 };
    const d = 0.0002; // ~20m offset
    const polygon = [
      { lat: center.lat + d, lon: center.lon },     // N
      { lat: center.lat, lon: center.lon + d },      // E
      { lat: center.lat - d, lon: center.lon },      // S
      { lat: center.lat, lon: center.lon - d },      // W
    ];
    const result = computeBuildingAlignment(polygon, center.lat, center.lon);
    expect(result.rotationDeg).toBeCloseTo(45, 5);
  });

  it('computes MBR for Flatiron-like triangle', () => {
    // Acute triangle — MBR should align to longest edge
    const polygon = [
      { lat: 40.7411, lon: -73.9897 },
      { lat: 40.7414, lon: -73.9893 },
      { lat: 40.7409, lon: -73.9891 },
    ];
    const result = computeBuildingAlignment(polygon, 40.741, -73.9894);
    expect(result.mbrWidth).toBeGreaterThan(result.mbrDepth);
    expect(result.rotationRad).toBeCloseTo(result.rotationDeg * Math.PI / 180, 6);
    expect(result.primaryFaceAzimuth).toBeDefined();
  });

  it('handles degenerate polygon (< 3 points) gracefully', () => {
    const polygon = [
      { lat: 40.0, lon: -74.0 },
      { lat: 40.0001, lon: -74.0 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    expect(result.rotationDeg).toBeDefined();
    expect(result.mbrWidth).toBeGreaterThanOrEqual(0);
  });

  it('includes center and polygon in result', () => {
    const polygon = [
      { lat: 40.0001, lon: -74.0001 },
      { lat: 40.0001, lon: -73.9999 },
      { lat: 39.9999, lon: -73.9999 },
    ];
    const result = computeBuildingAlignment(polygon, 40.0, -74.0);
    expect(result.center).toEqual({ lat: 40.0, lon: -74.0 });
    expect(result.osmPolygon).toEqual(polygon);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- test/building-alignment.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement BuildingAlignment type and computeBuildingAlignment()**

```typescript
// src/convert/building-alignment.ts

/** Unified building orientation derived from OSM polygon MBR */
export interface BuildingAlignment {
  rotationDeg: number;          // CW from true north, from OSM MBR
  rotationRad: number;          // same in radians
  mbrWidth: number;             // MBR long axis (meters) = primary facade length
  mbrDepth: number;             // MBR short axis (meters) = side facade length
  primaryFaceAzimuth: number;   // compass bearing of main facade normal
  osmPolygon: {lat: number; lon: number}[];
  center: {lat: number; lon: number};
}

interface Point2D { x: number; z: number }

/** Project lat/lon to local meters centered on (centerLat, centerLon) */
function projectToMeters(
  polygon: {lat: number; lon: number}[],
  centerLat: number, centerLon: number
): Point2D[] {
  const cosLat = Math.cos(centerLat * Math.PI / 180);
  return polygon.map(p => ({
    x: (p.lon - centerLon) * 111320 * cosLat,
    z: (centerLat - p.lat) * 111320,
  }));
}

/** Andrew's monotone chain convex hull (O(n log n)) */
function convexHull(points: Point2D[]): Point2D[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.z - b.z);
  if (sorted.length <= 2) return sorted;

  const cross = (o: Point2D, a: Point2D, b: Point2D) =>
    (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);

  // Lower hull
  const lower: Point2D[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }

  // Upper hull
  const upper: Point2D[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }

  // Remove last point of each half (duplicated at junction)
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Compute building alignment from OSM polygon using Minimum Area Bounding Rectangle.
 * Edge-aligned sweep on convex hull — tests each hull edge as a candidate alignment.
 */
export function computeBuildingAlignment(
  polygon: {lat: number; lon: number}[],
  centerLat: number,
  centerLon: number,
): BuildingAlignment {
  const projected = projectToMeters(polygon, centerLat, centerLon);

  // Degenerate case: < 3 points
  if (projected.length < 3) {
    const dx = projected.length === 2 ? projected[1].x - projected[0].x : 0;
    const dz = projected.length === 2 ? projected[1].z - projected[0].z : 0;
    const angle = Math.atan2(dx, -dz); // CW from north
    const len = Math.sqrt(dx * dx + dz * dz);
    return {
      rotationDeg: (angle * 180 / Math.PI + 360) % 360,
      rotationRad: angle,
      mbrWidth: len,
      mbrDepth: 0,
      primaryFaceAzimuth: ((angle * 180 / Math.PI + 90 + 360) % 360),
      osmPolygon: polygon,
      center: { lat: centerLat, lon: centerLon },
    };
  }

  const hull = convexHull(projected);

  let bestArea = Infinity;
  let bestAngle = 0;
  let bestWidth = 0;
  let bestDepth = 0;

  // Test each hull edge as alignment candidate
  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const edgeDx = hull[j].x - hull[i].x;
    const edgeDz = hull[j].z - hull[i].z;
    const edgeAngle = Math.atan2(edgeDx, -edgeDz); // CW from north (Z points south)

    const cos = Math.cos(-edgeAngle);
    const sin = Math.sin(-edgeAngle);

    // Rotate all hull points and compute AABB
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of hull) {
      const rx = p.x * cos - p.z * sin;
      const rz = p.x * sin + p.z * cos;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (rz < minZ) minZ = rz;
      if (rz > maxZ) maxZ = rz;
    }

    const w = maxX - minX;
    const d = maxZ - minZ;
    const area = w * d;

    if (area < bestArea) {
      bestArea = area;
      bestAngle = edgeAngle;
      bestWidth = Math.max(w, d); // long axis
      bestDepth = Math.min(w, d); // short axis
    }
  }

  const rotDeg = ((bestAngle * 180 / Math.PI) % 360 + 360) % 360;
  return {
    rotationDeg: rotDeg,
    rotationRad: bestAngle,
    mbrWidth: bestWidth,
    mbrDepth: bestDepth,
    primaryFaceAzimuth: (rotDeg + 90) % 360,
    osmPolygon: polygon,
    center: { lat: centerLat, lon: centerLon },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/building-alignment.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/convert/building-alignment.ts test/building-alignment.test.ts
git commit -m "feat(v300): add BuildingAlignment type and MBR computation from OSM polygon"
```

---

## Task 2: Gamma Default Change (0.85 → 0.7)

Simple one-line change. Changes the CLI default for the existing `gamma` parameter.

**Files:**
- Modify: `scripts/voxelize-glb.ts:213`

- [ ] **Step 1: Change gamma default**

At line 213, change:
```typescript
let gamma = 0.85;
```
to:
```typescript
let gamma = 0.7; // v300: stronger gamma lifts shadows without clipping highlights
```

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run existing tests**

Run: `bun run test`
Expected: All tests pass (gamma default is not tested directly)

- [ ] **Step 4: Commit**

```bash
git add scripts/voxelize-glb.ts
git commit -m "feat(v300): change gamma default from 0.85 to 0.7 for better shadow lifting"
```

---

## Task 3: Disable Window Glazing (Default Off)

Gate `glazeDarkWindows()` behind `--glaze` flag (default: off).

**Files:**
- Modify: `scripts/voxelize-glb.ts:142` (CLIArgs), `scripts/voxelize-glb.ts:1929` (call site)

- [ ] **Step 1: Add `--glaze` flag to CLI args**

In CLIArgs interface (~line 142), the existing `noGlaze` field should be repurposed. Find the arg parsing section and ensure glazing is OFF by default. Locate the CLI flag parsing (around line 250-280) and add/modify:

```typescript
// In arg parsing loop, add:
case '--glaze': args.glaze = true; break;
```

Add `glaze?: boolean` to the CLIArgs interface.

- [ ] **Step 2: Gate glazeDarkWindows call**

At line 1929, change:
```typescript
glazed = glazeDarkWindows(trimmed, args.resolution);
```
to:
```typescript
if (args.glaze) {
  glazed = glazeDarkWindows(trimmed, args.resolution);
} else {
  glazed = 0;
}
```

- [ ] **Step 3: Run typecheck + tests**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add scripts/voxelize-glb.ts
git commit -m "feat(v300): disable window glazing by default, add --glaze flag to re-enable"
```

---

## Task 4: Hybrid Surface Color (Replace Zone Normalization)

Replace 5-zone facade system with hybrid approach: raw CIELAB colors for walls, zones for roof + ground only. Keep `modeFilter3D` at 1 pass to avoid confetti.

**Files:**
- Modify: `scripts/voxelize-glb.ts:1949-2244` (zone normalization), `scripts/voxelize-glb.ts:2361` (homogenization)

- [ ] **Step 1: Gate zone normalization behind flag**

Add `--zone-normalize` flag to CLIArgs and arg parsing (default: off):

```typescript
// CLIArgs interface:
zoneNormalize?: boolean;

// Arg parsing:
case '--zone-normalize': args.zoneNormalize = true; break;
```

- [ ] **Step 2: Wrap zone normalization block in conditional**

At line ~1949, wrap the zone normalization block:
```typescript
if (args.zoneNormalize) {
  // ... existing zone normalization code (lines 1949-2244) ...
} else {
  // v300 hybrid: only apply roof zone + ground foundation band
  // Roof: keep existing roofDom detection, apply to top blocks
  // Ground: bottom 2 layers forced to sandstone/stone
  // Walls: untouched — raw gamma-corrected CIELAB colors preserved
}
```

- [ ] **Step 3: Skip homogenizeFacadesByFace when not zone-normalizing**

At line ~2361, gate:
```typescript
if (args.zoneNormalize) {
  const homogenized = homogenizeFacadesByFace(trimmed, 0.15, 6, facadeProtected);
}
```

- [ ] **Step 4: Reduce modeFilter3D to 1 pass when not zone-normalizing**

Find modeFilter3D calls and reduce pass count:
```typescript
const modePasses = args.zoneNormalize ? analysis.recommended.modePasses : 1;
```

- [ ] **Step 5: Skip palette cleanup when not zone-normalizing**

At lines ~2367-2427, gate the zone-variable-dependent palette cleanup:
```typescript
if (args.zoneNormalize) {
  // ... existing palette cleanup using wallDom/groundDom/bandBlock/trimBlock ...
}
```

- [ ] **Step 6: Implement roof-only + ground foundation zone**

```typescript
// In the else branch of the zone-normalize conditional:
// Apply roofDom to top Y layers (existing detection at ~1960-1980)
// Force bottom 2*resolution layers to sandstone (ground anchoring)
const groundH = Math.round(2 * args.resolution);
for (let y = 0; y < Math.min(groundH, grid.height); y++) {
  for (let x = 0; x < grid.width; x++) {
    for (let z = 0; z < grid.length; z++) {
      const block = grid.get(x, y, z);
      if (block !== 'minecraft:air') {
        grid.set(x, y, z, 'minecraft:sandstone');
      }
    }
  }
}
```

- [ ] **Step 7: Run typecheck + tests**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add scripts/voxelize-glb.ts
git commit -m "feat(v300): hybrid surface color — raw CIELAB walls, zones for roof+ground only"
```

---

## Task 5: severStreetFurniture() — Pole Removal

New function using targeted erosion with OSM footprint protection mask.

**Files:**
- Modify: `src/convert/mesh-filter.ts` (add new export)
- Create: `test/sever-street-furniture.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/sever-street-furniture.test.ts
import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { severStreetFurniture } from '../src/convert/mesh-filter.js';

function makeGrid(w: number, h: number, l: number): BlockGrid {
  return new BlockGrid(w, h, l);
}
const STONE = 'minecraft:stone';

describe('severStreetFurniture', () => {
  it('removes disconnected pole outside footprint', () => {
    // 20x20x20 grid: main building 10x20x10 at center, 1x15x1 pole at corner
    const grid = makeGrid(20, 20, 20);
    // Fill main building (x=5-14, z=5-14, y=0-19)
    for (let y = 0; y < 20; y++)
      for (let x = 5; x < 15; x++)
        for (let z = 5; z < 15; z++)
          grid.set(x, y, z, STONE);
    // Add pole at (1, 0-14, 1) — outside footprint, connected at ground
    for (let y = 0; y < 15; y++)
      grid.set(1, y, 1, STONE);
    // Connect pole to building at y=0
    grid.set(2, 0, 1, STONE);
    grid.set(3, 0, 1, STONE);
    grid.set(4, 0, 1, STONE);

    const removed = severStreetFurniture(grid, 1);
    expect(removed).toBeGreaterThan(0);
    // Pole should be gone
    expect(grid.get(1, 10, 1)).toBe('minecraft:air');
    // Building should remain
    expect(grid.get(10, 10, 10)).toBe('minecraft:stone');
  });

  it('preserves building voxels inside OSM footprint mask', () => {
    const grid = makeGrid(10, 20, 10);
    // Narrow 2-block wide building (like Flatiron tip)
    for (let y = 0; y < 20; y++)
      for (let x = 4; x < 6; x++)
        for (let z = 0; z < 10; z++)
          grid.set(x, y, z, STONE);

    // OSM polygon covers the building footprint
    const osmPoly = [
      { lat: 0.0001, lon: -0.0001 },
      { lat: 0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: 0.0001 },
      { lat: -0.0001, lon: -0.0001 },
    ];
    const removed = severStreetFurniture(grid, 1, osmPoly, 0, 0);
    // Narrow building preserved — it's inside the OSM polygon
    expect(grid.get(5, 10, 5)).toBe('minecraft:stone');
  });

  it('uses aspect-ratio fallback when no OSM polygon', () => {
    const grid = makeGrid(20, 20, 20);
    // Main building 10x10x10
    for (let y = 0; y < 10; y++)
      for (let x = 5; x < 15; x++)
        for (let z = 5; z < 15; z++)
          grid.set(x, y, z, STONE);
    // Very tall thin pole: 1x18x1 (aspect > 8)
    for (let y = 0; y < 18; y++)
      grid.set(0, y, 0, STONE);

    const removed = severStreetFurniture(grid, 1);
    expect(removed).toBeGreaterThan(0);
    expect(grid.get(0, 10, 0)).toBe('minecraft:air');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- test/sever-street-furniture.test.ts`
Expected: FAIL — `severStreetFurniture` not exported

- [ ] **Step 3: Implement severStreetFurniture**

Add to `src/convert/mesh-filter.ts` (after `isolatePrimaryBuilding` at ~line 5991):

```typescript
/**
 * Remove street furniture (poles, lampposts, trees) via targeted erosion
 * with OSM footprint protection mask.
 *
 * Algorithm:
 * 1. Build protection mask from OSM polygon (if available)
 * 2. Erode bottom 15m layers outside protection mask (radius=1)
 * 3. 3D connected component labeling
 * 4. Keep largest component, delete all others
 * 5. Dilate bottom 15m layers to restore building footprint
 */
export function severStreetFurniture(
  grid: BlockGrid,
  resolution: number,
  osmPolygon?: {lat: number; lon: number}[],
  centerLat?: number,
  centerLon?: number,
  translationDx = 0,
  translationDz = 0,
): number {
  const { width, height, length } = grid;
  const streetLayers = Math.round(15 * resolution);
  const maxErodeY = Math.min(streetLayers, height);
  let removed = 0;

  // Build 2D XZ protection mask from OSM polygon
  const protectedXZ = new Uint8Array(width * length); // 0 = unprotected, 1 = protected
  if (osmPolygon && osmPolygon.length >= 3 && centerLat !== undefined && centerLon !== undefined) {
    const cosLat = Math.cos(centerLat * Math.PI / 180);
    // Project polygon to grid coordinates (apply translation from alignOSMToFootprint)
    const polyGrid: {x: number; z: number}[] = osmPolygon.map(p => ({
      x: Math.round((p.lon - centerLon) * 111320 * cosLat * resolution + width / 2 + translationDx),
      z: Math.round((centerLat - p.lat) * 111320 * resolution + length / 2 + translationDz),
    }));

    // Scanline rasterize polygon to protection mask
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        if (pointInPolygon(x, z, polyGrid)) {
          protectedXZ[z * width + x] = 1;
        }
      }
    }
  }

  // Step 1: Targeted erosion of bottom layers (outside protection mask)
  const eroded = new Uint8Array(width * height * length); // 1 = eroded
  for (let y = 0; y < maxErodeY; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        if (protectedXZ[z * width + x]) continue; // inside OSM footprint — skip
        const block = grid.get(x, y, z);
        if (block === 'minecraft:air') continue;
        // Check if any neighbor is air (surface block)
        let isSurface = false;
        for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
          const nx = x + dx, ny = y + dy, nz = z + dz;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) {
            isSurface = true; break;
          }
          const nb = grid.get(nx, ny, nz);
          if (nb === 'minecraft:air') { isSurface = true; break; }
        }
        if (isSurface) {
          eroded[(y * length + z) * width + x] = 1;
          grid.set(x, y, z, 'minecraft:air');
        }
      }
    }
  }

  // Step 2: 3D connected component labeling
  const ccl = labelConnectedComponents(grid);

  // Step 3: Keep largest component
  let largestLabel = 0;
  let largestSize = 0;
  for (let i = 1; i <= ccl.count; i++) {
    if (ccl.sizes[i] > largestSize) {
      largestSize = ccl.sizes[i];
      largestLabel = i;
    }
  }

  // Delete non-largest components
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        const idx = (y * length + z) * width + x;
        if (ccl.labels[idx] !== 0 && ccl.labels[idx] !== largestLabel) {
          grid.set(x, y, z, 'minecraft:air');
          removed++;
        }
      }
    }
  }

  // Step 4: Restore eroded building voxels at street level
  for (let y = 0; y < maxErodeY; y++) {
    for (let x = 0; x < width; x++) {
      for (let z = 0; z < length; z++) {
        const idx = (y * length + z) * width + x;
        if (eroded[idx]) {
          // Only restore if adjacent to surviving building
          let adjacentToBuilding = false;
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
            const nx = x + dx, ny = y + dy, nz = z + dz;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= length) continue;
            const nb = grid.get(nx, ny, nz);
            if (nb !== 'minecraft:air') { adjacentToBuilding = true; break; }
          }
          if (adjacentToBuilding) {
            grid.set(x, y, z, 'minecraft:stone');
          }
        }
      }
    }
  }

  // Fallback: when no OSM polygon, delete tall thin components (aspect > 8)
  if (!osmPolygon || osmPolygon.length < 3) {
    const ccl2 = labelConnectedComponents(grid);
    // Recompute largest label for this CCL (labels differ from first CCL)
    let largest2 = 0, largestSize2 = 0;
    for (let i = 1; i <= ccl2.count; i++) {
      if (ccl2.sizes[i] > largestSize2) { largestSize2 = ccl2.sizes[i]; largest2 = i; }
    }
    for (let label = 1; label <= ccl2.count; label++) {
      if (label === largest2) continue;
      // Compute component bounding box
      let minX = width, maxX = 0, minY = height, maxY = 0, minZ = length, maxZ = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          for (let z = 0; z < length; z++) {
            if (ccl2.labels[(y * length + z) * width + x] === label) {
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
          }
        }
      }
      const h = maxY - minY + 1;
      const w = Math.max(maxX - minX + 1, maxZ - minZ + 1);
      if (w > 0 && h / w > 8) {
        // Delete pole-like component
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            for (let z = 0; z < length; z++) {
              if (ccl2.labels[(y * length + z) * width + x] === label) {
                grid.set(x, y, z, 'minecraft:air');
                removed++;
              }
            }
          }
        }
      }
    }
  }

  return removed;
}

/** Point-in-polygon via ray casting */
function pointInPolygon(px: number, pz: number, poly: {x: number; z: number}[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- test/sever-street-furniture.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Wire into voxelize-glb.ts pipeline**

In `scripts/voxelize-glb.ts`, after the existing `isolatePrimaryBuilding()` call, add the `severStreetFurniture()` call:

```typescript
import { severStreetFurniture } from '../src/convert/mesh-filter.js';

// After isolatePrimaryBuilding (or as replacement when alignment available):
if (alignment) {
  const severed = severStreetFurniture(
    trimmed, args.resolution,
    alignment.osmPolygon, alignment.center.lat, alignment.center.lon,
    osmTranslationDx, osmTranslationDz,
  );
  if (severed > 0) console.log(`    Street furniture severed: ${severed} blocks removed`);
} else {
  // Existing isolatePrimaryBuilding fallback
  isolatePrimaryBuilding(trimmed, 2);
}
```

- [ ] **Step 6: Run typecheck + full test suite**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/convert/mesh-filter.ts test/sever-street-furniture.test.ts scripts/voxelize-glb.ts
git commit -m "feat(v300): add severStreetFurniture() with OSM footprint protection, wire into pipeline"
```

---

## Task 6: DDA Directional Shadows

Add shadow computation to the software voxel renderer via 3D DDA raycasting.

**Files:**
- Modify: `src/render/png-renderer.ts`
- Create: `test/dda-shadows.test.ts`

- [ ] **Step 1: Write failing tests for shadow computation**

```typescript
// test/dda-shadows.test.ts
import { describe, it, expect } from 'vitest';
import { computeShadow } from '../src/render/png-renderer.js';
import { BlockGrid } from '../src/schem/types.js';

const STONE = 'minecraft:stone';

describe('computeShadow', () => {
  it('returns 1.0 (no shadow) for top surface with clear sky', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 0, 2, STONE); // single block on ground
    // Ray from top surface along [1,1,1] — should exit grid without hitting anything
    const shadow = computeShadow(grid, 2, 0, 2, 'up');
    expect(shadow).toBe(1.0);
  });

  it('returns shadow factor for block under overhang', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 0, 2, STONE); // target block
    grid.set(3, 1, 3, STONE); // overhang block — in shadow ray path [1,1,1]
    const shadow = computeShadow(grid, 2, 0, 2, 'up');
    expect(shadow).toBeLessThan(1.0);
    expect(shadow).toBeCloseTo(0.6, 1); // 40% darkening
  });

  it('offsets ray origin along face normal to avoid self-intersection', () => {
    const grid = new BlockGrid(5, 5, 5);
    grid.set(2, 2, 2, STONE); // single floating block
    // Ray from +X face should not self-intersect
    const shadow = computeShadow(grid, 2, 2, 2, '+x');
    expect(shadow).toBe(1.0); // nothing blocking in [1,1,1] direction from +X face
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- test/dda-shadows.test.ts`
Expected: FAIL — `computeShadow` not exported

- [ ] **Step 3: Implement DDA shadow computation**

Add to `src/render/png-renderer.ts` (export for testing):

```typescript
/** Light direction for isometric sun: [1, 1, 1] normalized */
const LIGHT_DIR = { x: 1 / Math.sqrt(3), y: 1 / Math.sqrt(3), z: 1 / Math.sqrt(3) };

/**
 * Compute shadow factor for a surface voxel via DDA raycast.
 * Returns 1.0 (fully lit) or 0.6 (40% darkened, in shadow).
 * Ray is offset by +1 along face normal to avoid self-intersection.
 */
export function computeShadow(
  grid: BlockGrid,
  x: number, y: number, z: number,
  face: 'up' | '+x' | '-x' | '+z' | '-z',
): number {
  // Offset origin along face normal
  let ox = x, oy = y, oz = z;
  switch (face) {
    case 'up':  oy += 1; break;
    case '+x':  ox += 1; break;
    case '-x':  ox -= 1; break;
    case '+z':  oz += 1; break;
    case '-z':  oz -= 1; break;
  }

  // 3D DDA along light direction [1, 1, 1]
  // Since direction is uniform, step 1 in each axis simultaneously
  const maxSteps = Math.max(grid.width, grid.height, grid.length);
  for (let step = 1; step <= maxSteps; step++) {
    const sx = ox + step;
    const sy = oy + step;
    const sz = oz + step;
    if (sx >= grid.width || sy >= grid.height || sz >= grid.length) break;
    if (sx < 0 || sy < 0 || sz < 0) continue;
    const block = grid.get(sx, sy, sz);
    if (block !== 'minecraft:air') {
      return 0.6; // 40% shadow darkening
    }
  }
  return 1.0; // fully lit
}
```

- [ ] **Step 4: Integrate shadow into renderCutawayIso and renderFrontElevation**

In `renderCutawayIso()` (~line 447), where block color is computed before `renderIsoBlock()`:
```typescript
const shadowFactor = computeShadow(grid, x, y, z, 'up');
// Apply shadow to the color passed to renderIsoBlock
// Multiply RGB by shadowFactor before rendering
```

Similarly in `renderFrontElevation()` (~line 656), apply shadow to the visible face.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- test/dda-shadows.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 6: Run typecheck + full test suite**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/render/png-renderer.ts test/dda-shadows.test.ts
git commit -m "feat(v300): add DDA directional shadows to voxel renderer"
```

---

## Task 7: AO Tuning + Second Isometric Angle

Tune existing `getAO()` multiplier for stronger effect, add back-left isometric view.

**Files:**
- Modify: `src/render/png-renderer.ts:373-383` (AO), add `renderCutawayIsoBackLeft()`

- [ ] **Step 1: Tune AO multiplier**

At line ~383, change the AO multiplier from `0.4` to a stronger value:

```typescript
// Before:
return 1.0 - (solidNeighbors / checks.length) * 0.4;
// After:
return 1.0 - (solidNeighbors / checks.length) * 0.6; // v300: stronger AO for visible recesses
```

- [ ] **Step 2: Add renderCutawayIsoBackLeft()**

Add new function after `renderCutawayIso()` (~line 530). Copy the existing function and reverse iteration order:

```typescript
/**
 * Isometric render from back-left corner (opposite of renderCutawayIso).
 * Reversed iteration: z = 0..l-1, x = w-1..0
 */
export async function renderCutawayIsoBackLeft(
  grid: BlockGrid,
  story: number,
  options?: { tile?: number; storyH?: number; output?: string; title?: string },
): Promise<Buffer> {
  // Same setup as renderCutawayIso but with reversed iteration
  // z iterates 0 → length-1 (front to back becomes back to front)
  // x iterates width-1 → 0 (left to right becomes right to left)
  // Projection origin shifted to opposite corner
  // ... (copy renderCutawayIso body, swap iteration order + adjust sx origin)
}
```

Key changes from `renderCutawayIso`:
- Inner loops: `for (let z = 0; z < l; z++)` and `for (let x = w - 1; x >= 0; x--)`
- Projection: `sx = (z - x) * tile + imgW / 2` (mirrored)

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/render/png-renderer.ts
git commit -m "feat(v300): tune AO multiplier 0.4→0.6, add renderCutawayIsoBackLeft()"
```

---

## Task 8: Wire BuildingAlignment into reorientToENU

Accept `BuildingAlignment` in mesh rotation to replace angular sweep + 90° snap with exact rotation.

**Files:**
- Modify: `scripts/voxelize-glb.ts:594-734` (reorientToENU function)

- [ ] **Step 1: Import BuildingAlignment type**

At top of `scripts/voxelize-glb.ts`:
```typescript
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
```

- [ ] **Step 2: Add alignment parameter to reorientToENU**

Modify function signature (~line 594):
```typescript
function reorientToENU(
  mesh: THREE.Object3D,
  args: CLIArgs,
  alignment?: BuildingAlignment,
): { ... } {
```

- [ ] **Step 3: Replace angular sweep with exact rotation when alignment provided**

Inside reorientToENU, after PCA vertical alignment (~line 619):
```typescript
if (alignment) {
  // Exact rotation from OSM MBR — primary facade faces -Z
  // IMPORTANT: apply via geometry transform (same as PCA), NOT mesh.rotation.y
  // mesh.rotation.y would conflict with geometry-level transforms used by PCA
  const yRotation = new THREE.Matrix4().makeRotationY(-alignment.rotationRad);
  scene.traverse((child: THREE.Object3D) => {
    if (child instanceof THREE.Mesh && child.geometry) {
      child.geometry.applyMatrix4(yRotation);
    }
  });
  enuHorizontalAngle = alignment.rotationRad; // preserve for downstream OSM mask
  // Skip angular sweep + 90° snap
} else {
  // Existing angular sweep fallback (lines 621-711)
  // ... keep existing code ...
}
```

- [ ] **Step 4: Wire alignment into pipeline**

In the main pipeline where reorientToENU is called, compute alignment from OSM polygon when `--coords` is provided:
```typescript
let alignment: BuildingAlignment | undefined;
if (osmPolygon && osmPolygon.length >= 3) {
  alignment = computeBuildingAlignment(osmPolygon, lat, lon);
}
const oriented = reorientToENU(mesh, args, alignment);
```

- [ ] **Step 5: Run typecheck + tests**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add scripts/voxelize-glb.ts
git commit -m "feat(v300): wire BuildingAlignment into reorientToENU for precise mesh rotation"
```

---

## Task 8b: maskToFootprint Translation-Only Search (Step D)

When `BuildingAlignment` is available, skip rotation search in `alignOSMToFootprint()` — only do XZ translation.

**Files:**
- Modify: `src/convert/mesh-filter.ts:3629` (alignOSMToFootprint)

- [ ] **Step 1: Add alignment parameter to maskToFootprint / alignOSMToFootprint**

Pass `hasAlignment: boolean` flag through. When true, skip rotation sweep and only search XZ translation ±10 blocks:

```typescript
// In alignOSMToFootprint (~line 3629), add parameter:
function alignOSMToFootprint(
  grid: BlockGrid,
  polygon: {lat: number; lon: number}[],
  centerLat: number, centerLon: number,
  hasAlignment = false, // v300: skip rotation search when BuildingAlignment available
): { dx: number; dz: number; angle: number } {
  if (hasAlignment) {
    // Translation-only search (±10 blocks)
    // Skip the rotation sweep loop entirely
    // ... only vary dx, dz in search ...
  }
  // ... existing rotation + translation search ...
}
```

- [ ] **Step 2: Wire into voxelize-glb.ts where maskToFootprint is called**

Pass `!!alignment` to indicate alignment is available.

- [ ] **Step 3: Run typecheck + tests**

Run: `bunx tsc --noEmit && bun run test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/convert/mesh-filter.ts scripts/voxelize-glb.ts
git commit -m "feat(v300): maskToFootprint translation-only search when BuildingAlignment available"
```

---

## Task 8c: Front Elevation Always Renders -Z Face (Step F)

After alignment, primary facade is at -Z. Front elevation should always render south face, not auto-detect.

**Files:**
- Modify: `src/render/png-renderer.ts:656` (renderFrontElevation)

- [ ] **Step 1: Add `alignedToBuilding` option**

In `renderFrontElevation` options, add a flag:

```typescript
export async function renderFrontElevation(
  grid: BlockGrid,
  options?: {
    scale?: number;
    face?: 'north' | 'south' | 'east' | 'west' | 'auto';
    alignedToBuilding?: boolean; // v300: when true, always render south face (-Z = primary facade)
  },
): Promise<Buffer> {
  let face = options?.face ?? 'auto';
  if (options?.alignedToBuilding) {
    face = 'south'; // -Z is always primary facade after BuildingAlignment rotation
  }
  // ... existing logic ...
}
```

- [ ] **Step 2: Wire into voxelize-glb.ts front elevation call**

Pass `alignedToBuilding: !!alignment` when rendering front elevation.

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/render/png-renderer.ts scripts/voxelize-glb.ts
git commit -m "feat(v300): front elevation always renders -Z face when alignment available"
```

---

## Task 9: Wire BuildingAlignment into Multi-Angle Capture

Rotate facade capture cameras by `rotationDeg` to align with building faces.

**Files:**
- Modify: `src/convert/multi-angle-capture.ts:35-65` (FIVE_ANGLE_PRESET), `src/convert/multi-angle-capture.ts:96-100` (positionCameraForAngle)

- [ ] **Step 1: Add rotationDeg parameter to angle computation**

Create a new function that generates aligned angles:

```typescript
/**
 * Generate 5-angle capture preset aligned to building faces.
 * @param rotationDeg CW from north, from BuildingAlignment
 */
export function getAlignedAngles(rotationDeg: number): CameraAngle[] {
  const rad = rotationDeg * Math.PI / 180;
  return [
    { name: 'top-down', offset: new THREE.Vector3(0, 1, 0), orthographic: true },
    { name: 'front', offset: new THREE.Vector3(Math.sin(rad) * 0.707, 0.707, -Math.cos(rad) * 0.707), orthographic: false },
    { name: 'right', offset: new THREE.Vector3(Math.sin(rad + Math.PI/2) * 0.707, 0.707, -Math.cos(rad + Math.PI/2) * 0.707), orthographic: false },
    { name: 'rear', offset: new THREE.Vector3(Math.sin(rad + Math.PI) * 0.707, 0.707, -Math.cos(rad + Math.PI) * 0.707), orthographic: false },
    { name: 'left', offset: new THREE.Vector3(Math.sin(rad + 3*Math.PI/2) * 0.707, 0.707, -Math.cos(rad + 3*Math.PI/2) * 0.707), orthographic: false },
  ];
}
```

- [ ] **Step 2: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/convert/multi-angle-capture.ts
git commit -m "feat(v300): add getAlignedAngles() for building-face-aligned capture cameras"
```

---

## Task 10: Orthographic Camera + Nadir Pass + tiles-headless Wiring

Switch to orthographic camera, add OSM query + alignment to tiles-headless.ts.

**Files:**
- Modify: `scripts/tiles-headless.ts:176-223` (camera setup, tile renderer)

- [ ] **Step 1: Import alignment + OSM modules**

```typescript
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
import { searchOSMBuilding } from '../src/gen/api/osm.js';
import { getAlignedAngles } from '../src/convert/multi-angle-capture.js';
```

- [ ] **Step 2: Add OSM query after geocoding**

After the geocode step, query OSM for building polygon and compute alignment:
```typescript
// After lat/lon are resolved:
let alignment: BuildingAlignment | undefined;
try {
  const osmResult = await searchOSMBuilding(lat, lon);
  if (osmResult?.polygon?.length >= 3) {
    alignment = computeBuildingAlignment(osmResult.polygon, lat, lon);
    console.log(`Building alignment: ${alignment.rotationDeg.toFixed(1)}° MBR ${alignment.mbrWidth.toFixed(0)}x${alignment.mbrDepth.toFixed(0)}m`);
  }
} catch (e) {
  console.warn('OSM query failed, using default camera angles');
}
```

- [ ] **Step 3: Switch to orthographic camera for facade captures**

Replace perspective camera setup with orthographic when alignment available:
```typescript
if (alignment) {
  const maxDim = Math.max(alignment.mbrWidth, alignment.mbrDepth, buildingHeight || 50);
  const halfExtent = maxDim * 0.7;
  camera = new THREE.OrthographicCamera(-halfExtent, halfExtent, halfExtent, -halfExtent, 1, maxDim * 4);
  const camDist = maxDim * 1.5;
  // Use aligned angles
  const angles = getAlignedAngles(alignment.rotationDeg);
}
```

- [ ] **Step 4: Lower errorTarget for orthographic passes**

```typescript
// When using orthographic camera, force higher LOD
if (camera instanceof THREE.OrthographicCamera) {
  tiles.errorTarget = 0.5; // vs default 2.0 for perspective
}
```

- [ ] **Step 5: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add scripts/tiles-headless.ts
git commit -m "feat(v300): orthographic camera + OSM alignment wiring in tiles-headless"
```

---

## Task 11: Satellite Rotation + OSM Overlay for Grading

Rotate satellite image to match voxel orientation, draw OSM polygon outline.

**Files:**
- Modify: `scripts/iterate-grade.ts:330-360` (ensureSatRef)

- [ ] **Step 1: Import alignment module and sharp**

```typescript
import { computeBuildingAlignment, type BuildingAlignment } from '../src/convert/building-alignment.js';
```

- [ ] **Step 2: Add alignment computation to ensureSatRef**

After fetching satellite image, compute alignment and rotate:
```typescript
async function ensureSatRef(b: BuildingConfig, alignment?: BuildingAlignment): Promise<void> {
  // ... existing satellite fetch logic ...

  if (alignment) {
    // Rotate satellite image by -rotationDeg to match voxel grid
    const rotated = await sharp(satPath)
      .rotate(-alignment.rotationDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();

    // Draw OSM polygon outline (2px cyan stroke)
    // Create SVG overlay with polygon path, composite on rotated satellite
    // ... (sharp composite with SVG polygon overlay) ...

    await sharp(rotated).jpeg({ quality: 90 }).toFile(satPath);
  }
}
```

- [ ] **Step 3: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add scripts/iterate-grade.ts
git commit -m "feat(v300): satellite rotation + OSM polygon overlay for grading alignment"
```

---

## Task 12: Binary Defect Checklist + 5 Separate Images

Replace STRUCTURED_PROMPT with binary defect detection, send 5 separate images.

**Files:**
- Modify: `scripts/iterate-grade.ts:197-281` (SubScore, STRUCTURED_PROMPT), grading function

- [ ] **Step 1: Define new defect interface**

```typescript
interface DefectChecklist {
  height_truncated: boolean;
  facade_holes_visible: boolean;
  floating_artifacts: boolean;
  neighbor_buildings_merged: boolean;
  footprint_wrong_shape: boolean;
  false_positives_merged: boolean;
  building_recognizable: boolean;
  proportions_correct: boolean;
  surface_detail_visible: boolean;
}
```

- [ ] **Step 2: Write new VLM prompt**

Replace `STRUCTURED_PROMPT` (lines 224-281):
```typescript
const DEFECT_PROMPT = `You are evaluating a Minecraft voxel recreation of a real building.

You will see 5 images:
1. Satellite reference (rotated to match voxel orientation, building outlined in cyan)
2. Top-down view of the voxel model
3. Front elevation of the voxel model
4. Isometric front-right view of the voxel model
5. Isometric back-left view of the voxel model

Answer each question with true or false:

{
  "height_truncated": [true if building appears cut off / much shorter than reference],
  "facade_holes_visible": [true if walls have swiss-cheese holes or missing patches],
  "floating_artifacts": [true if there are floating blocks, disconnected pieces, or noise],
  "neighbor_buildings_merged": [true if adjacent buildings are merged into the target],
  "footprint_wrong_shape": [true if footprint shape doesn't match satellite outline],
  "false_positives_merged": [true if large unrelated structures are attached to the building],
  "building_recognizable": [true if someone familiar with this building would identify it],
  "proportions_correct": [true if width/height/depth ratios roughly match the reference],
  "surface_detail_visible": [true if facade has visible material variation, not uniform gray]
}

Respond with ONLY the JSON object, no explanation.`;
```

- [ ] **Step 3: Implement deterministic scoring**

```typescript
function scoreFromDefects(defects: DefectChecklist): number {
  let score = 10;
  if (defects.height_truncated) score -= 3;
  if (defects.facade_holes_visible) score -= 2;
  if (defects.floating_artifacts) score -= 2;
  if (defects.neighbor_buildings_merged) score -= 2;
  if (defects.footprint_wrong_shape) score -= 2;
  if (defects.false_positives_merged) score -= 2;
  if (!defects.building_recognizable) score -= 3;
  if (!defects.proportions_correct) score -= 1;
  if (!defects.surface_detail_visible) score -= 1;
  return Math.max(0, score);
}
```

- [ ] **Step 4: Add back-left iso render call + switch to 5 separate images**

Add rendering call for back-left iso (using `renderCutawayIsoBackLeft` from Task 7), then pass all 5 images to VLM:

```typescript
import { renderCutawayIsoBackLeft } from '../src/render/png-renderer.js';

// In the render phase, add:
const isoBackLeftBuf = await renderCutawayIsoBackLeft(grid, 0, { tile: b.tileSize || 10 });
const isoBackLeftPath = `output/tiles/${b.key}-v${version}-iso-backleft.jpg`;
await sharp(isoBackLeftBuf).jpeg({ quality: 90 }).toFile(isoBackLeftPath);

// Pass 5 individual images to VLM:
const images = [
  satRefPath,           // 1. Satellite reference
  topdownPath,          // 2. Top-down voxel
  frontElevPath,        // 3. Front elevation
  isoFrontRightPath,    // 4. Isometric front-right
  isoBackLeftPath,      // 5. Isometric back-left (new)
];
```

- [ ] **Step 5: Switch model to gemini-2.5-pro with temp=0.0**

Update model config:
```typescript
const model = 'gemini-2.5-pro';
const temperature = 0.0;
```

- [ ] **Step 6: Add unit tests for scoreFromDefects**

```typescript
// In a test block or separate test file:
describe('scoreFromDefects', () => {
  it('returns 10 for no defects', () => {
    expect(scoreFromDefects({
      height_truncated: false, facade_holes_visible: false, floating_artifacts: false,
      neighbor_buildings_merged: false, footprint_wrong_shape: false, false_positives_merged: false,
      building_recognizable: true, proportions_correct: true, surface_detail_visible: true,
    })).toBe(10);
  });
  it('returns 0 for all defects', () => {
    expect(scoreFromDefects({
      height_truncated: true, facade_holes_visible: true, floating_artifacts: true,
      neighbor_buildings_merged: true, footprint_wrong_shape: true, false_positives_merged: true,
      building_recognizable: false, proportions_correct: false, surface_detail_visible: false,
    })).toBe(0);
  });
  it('subtracts 3 for unrecognizable building', () => {
    const base = { height_truncated: false, facade_holes_visible: false, floating_artifacts: false,
      neighbor_buildings_merged: false, footprint_wrong_shape: false, false_positives_merged: false,
      building_recognizable: false, proportions_correct: true, surface_detail_visible: true };
    expect(scoreFromDefects(base)).toBe(7);
  });
});
```

- [ ] **Step 7: Run typecheck + tests**

Run: `bunx tsc --noEmit && bun run test`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add scripts/iterate-grade.ts
git commit -m "feat(v300): binary defect checklist + 5 separate images + gemini-2.5-pro"
```

---

## Task 13: Dynamic Satellite Zoom + Building Set Update

Replace hardcoded satZoom with formula, update building configs.

**Files:**
- Modify: `scripts/iterate-grade.ts:45-194` (BUILDINGS array), zoom logic

- [ ] **Step 1: Implement dynamic zoom formula**

```typescript
function computeSatZoom(mbrWidth: number): number {
  return Math.min(20, Math.floor(22 - Math.log2(mbrWidth / 10)));
}
```

- [ ] **Step 2: Replace BUILDINGS array with v300 building set**

Replace lines 45-194 with the 10 new buildings from the spec:

```typescript
const BUILDINGS: BuildingConfig[] = [
  // Tier 1
  { key: 'flatiron', glb: 'models/flatiron.glb', coords: '40.7411,-73.9897', satRef: '', resolution: 2, maskDilate: 2, difficulty: 'easy' as const, tileSize: 10, topdownScale: 12 },
  { key: 'pennzoil', glb: 'models/pennzoil.glb', coords: '29.7536,-95.3653', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'nga-east', glb: 'models/nga-east.glb', coords: '38.8913,-77.0180', satRef: '', resolution: 2, maskDilate: 2, difficulty: 'medium' as const, tileSize: 10, topdownScale: 12 },
  // Tier 2
  { key: 'dallas-cityhall', glb: 'models/dallas-cityhall.glb', coords: '32.7763,-96.7968', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'seattle-library', glb: 'models/seattle-library.glb', coords: '47.6067,-122.3326', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'boston-cityhall', glb: 'models/boston-cityhall.glb', coords: '42.3605,-71.0580', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'citigroup', glb: 'models/citigroup.glb', coords: '40.7588,-73.9707', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  // Tier 3
  { key: 'denver-art', glb: 'models/denver-art.glb', coords: '39.7372,-104.9893', satRef: '', resolution: 2, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'usaf-chapel', glb: 'models/usaf-chapel.glb', coords: '38.9984,-104.8615', satRef: '', resolution: 3, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
  { key: 'la-cityhall', glb: 'models/la-cityhall.glb', coords: '34.0537,-118.2430', satRef: '', resolution: 1, maskDilate: 2, difficulty: 'hard' as const, tileSize: 10, topdownScale: 12 },
];
```

- [ ] **Step 3: Wire dynamic zoom into ensureSatRef**

Replace hardcoded `b.satZoom` with computed zoom from alignment:
```typescript
const zoom = alignment ? computeSatZoom(alignment.mbrWidth) : (b.satZoom || 19);
```

- [ ] **Step 4: Run typecheck**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add scripts/iterate-grade.ts
git commit -m "feat(v300): update building set (10 angular buildings) + dynamic satellite zoom"
```

---

## Task 14: Integration — Capture + Grade Tier 1 Buildings

End-to-end test of the full pipeline on the 3 Tier 1 buildings.

**Files:**
- No new files — uses existing scripts

- [ ] **Step 1: Capture Flatiron GLB with alignment**

```bash
bun scripts/tiles-headless.ts --address "Flatiron Building, NYC" --multi-angle -o models/flatiron.glb
```

- [ ] **Step 2: Voxelize Flatiron with v300 pipeline**

```bash
bun scripts/voxelize-glb.ts models/flatiron.glb --auto --coords 40.7411,-73.9897 --resolution 2 --mask-dilate 2 -o output/tiles/flatiron-v300.schem
```

Verify:
- No window glazing holes
- Raw photogrammetric colors preserved on walls
- Sandstone ground foundation
- Triangular footprint intact

- [ ] **Step 3: Render all 5 views**

```bash
bun scripts/_render-one.ts output/tiles/flatiron-v300.schem output/tiles/flatiron-v300-iso.jpg --tile 10
bun scripts/_render-topdown.ts output/tiles/flatiron-v300.schem output/tiles/flatiron-v300-topdown.jpg --scale 12
bun scripts/_render-front.ts output/tiles/flatiron-v300.schem output/tiles/flatiron-v300-front.jpg
# Back-left iso (new render script needed or add flag to _render-one.ts)
```

- [ ] **Step 4: Grade with binary defect checklist**

```bash
bun scripts/iterate-grade.ts --version v300 --buildings flatiron --runs 5 --model gemini-2.5-pro
```

Expected: Flatiron scores 9-10/10 (triangular footprint, recognizable, no defects)

- [ ] **Step 5: Repeat for Pennzoil and NGA East**

```bash
# Capture + voxelize + grade each
bun scripts/tiles-headless.ts --address "Pennzoil Place, Houston" --multi-angle -o models/pennzoil.glb
bun scripts/voxelize-glb.ts models/pennzoil.glb --auto --coords 29.7536,-95.3653 -o output/tiles/pennzoil-v300.schem
bun scripts/iterate-grade.ts --version v300 --buildings pennzoil --runs 5 --model gemini-2.5-pro

bun scripts/tiles-headless.ts --address "National Gallery East Building, Washington DC" --multi-angle -o models/nga-east.glb
bun scripts/voxelize-glb.ts models/nga-east.glb --auto --coords 38.8913,-77.0180 --resolution 2 -o output/tiles/nga-east-v300.schem
bun scripts/iterate-grade.ts --version v300 --buildings nga-east --runs 5 --model gemini-2.5-pro
```

- [ ] **Step 6: Review results and iterate**

Visually inspect all 3 buildings. Identify any remaining issues. If scores < 7, diagnose from defect checklist output and adjust pipeline parameters.

- [ ] **Step 7: Commit state**

```bash
git add output/iterate-state.md output/tiles/iterate-state.json
git commit -m "feat(v300): Tier 1 building results — flatiron, pennzoil, nga-east"
```

---

## Task 15: Capture + Grade Tier 2 Buildings

4 more complex angular buildings.

**Files:**
- No new files

- [ ] **Step 1: Capture all 4 Tier 2 GLBs**

```bash
bun scripts/tiles-headless.ts --address "Dallas City Hall, Dallas TX" --multi-angle -o models/dallas-cityhall.glb
bun scripts/tiles-headless.ts --address "Seattle Central Library, Seattle" --multi-angle -o models/seattle-library.glb
bun scripts/tiles-headless.ts --address "Boston City Hall, Boston" --multi-angle -o models/boston-cityhall.glb
bun scripts/tiles-headless.ts --address "Citigroup Center, NYC" --multi-angle -o models/citigroup.glb
```

- [ ] **Step 2: Voxelize all 4**

```bash
for b in dallas-cityhall seattle-library boston-cityhall citigroup; do
  bun scripts/voxelize-glb.ts models/$b.glb --auto --coords $(grep $b scripts/iterate-grade.ts | grep -oP '\d+\.\d+,-\d+\.\d+') -o output/tiles/$b-v300.schem
done
```

- [ ] **Step 3: Grade all 4**

```bash
bun scripts/iterate-grade.ts --version v300 --buildings dallas-cityhall,seattle-library,boston-cityhall,citigroup --runs 5 --model gemini-2.5-pro
```

Expected: 3/4 at 7+

- [ ] **Step 4: Commit state**

```bash
git add output/iterate-state.md output/tiles/iterate-state.json
git commit -m "feat(v300): Tier 2 building results"
```

---

## Task 16: Capture + Grade Tier 3 Buildings + Final Assessment

3 stretch-goal buildings, then full assessment.

**Files:**
- No new files

- [ ] **Step 1: Capture all 3 Tier 3 GLBs**

```bash
bun scripts/tiles-headless.ts --address "Denver Art Museum Hamilton Building" --multi-angle -o models/denver-art.glb
bun scripts/tiles-headless.ts --address "USAF Academy Cadet Chapel, Colorado Springs" --multi-angle -o models/usaf-chapel.glb
bun scripts/tiles-headless.ts --address "Los Angeles City Hall" --multi-angle -o models/la-cityhall.glb
```

- [ ] **Step 2: Voxelize + grade all 3**

```bash
bun scripts/iterate-grade.ts --version v300 --buildings denver-art,usaf-chapel,la-cityhall --runs 5 --model gemini-2.5-pro
```

- [ ] **Step 3: Full 10-building assessment**

```bash
bun scripts/iterate-grade.ts --version v300 --runs 5 --model gemini-2.5-pro
```

Target: 7/10 buildings at 7+ (honest human grade)

- [ ] **Step 4: Generate visual review HTML**

Update `output/v200-visual-review.html` to v300, or create `output/v300-visual-review.html` with all 10 building results.

- [ ] **Step 5: Commit final state**

```bash
git add output/ scripts/iterate-grade.ts
git commit -m "feat(v300): full 10-building assessment — X/10 at 7+"
```

---

## Dependency Graph

```
Task 1 (BuildingAlignment) ──┬──→ Task 8 (reorientToENU wiring)
                              ├──→ Task 9 (multi-angle-capture)
                              ├──→ Task 10 (tiles-headless)
                              ├──→ Task 11 (satellite rotation)
                              └──→ Task 13 (dynamic zoom)

Task 2 (Gamma) ──→ Task 4 (Hybrid color)

Task 3 (Disable glazing) ── independent

Task 5 (severStreetFurniture) ── independent

Task 6 (DDA shadows) ──┬──→ Task 12 (binary checklist needs renders)
Task 7 (AO + iso)  ────┘

Task 8 (reorientToENU) ──→ Task 8b (maskToFootprint) ──→ Task 8c (front elev -Z)

Tasks 1, 3, 5, 6, 7: fully parallelizable (no inter-dependencies)
Task 4 depends on Task 2 (gamma before hybrid color)
Tasks 8-8c, 9-13: sequential (depend on Task 1)
Tasks 14-16: sequential (depend on all above)
```
