# Pipeline Rearchitecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 21-phase voxel-patching pipeline with a resolver-first adaptive pipeline that synthesizes parametric B-rep building models from US addresses, producing printable GLB + scene GLB + voxel schematics.

**Architecture:** Pure core (`src/pipeline/`) with CLI + browser adapters. Sequential capture (tiles → SV → satellite) each informing the next. Parametric synthesis from OSM polygon + facade evidence, with cleaned-tiles fallback for irregular shapes. Objective gates + multi-VLM consensus for release.

**Tech Stack:** TypeScript (Bun runtime, no DOM/Node APIs in pure core), Three.js for geometry, three-mesh-bvh for collision/CSG, `manifold-3d` for CSG operations, existing API clients (Solar / OSM / SV / Smarty / geocoder), existing voxelizer, existing schem writers, Vitest for testing.

**Spec reference:** `docs/superpowers/specs/2026-04-17-pipeline-rearchitecture-design.md`

**Execution principles:**
- Strict TDD — test before implementation for every module
- Frequent commits — one per task completion minimum
- Old pipeline stays functional until Chunk 14; new entry (`scripts/build.ts`) runs alongside
- Each chunk produces a shippable increment verifiable via its tests
- `bunx tsc --noEmit` must be clean at the end of every step

---

## Chunk 0: Preparation

Baseline + worktree setup. No code changes to src yet.

### Task 0.1: Verify baseline

**Files:**
- Read: `package.json`, `tsconfig.json`, `output/category-state.json`
- Create: (none)
- Test: (none)

- [ ] **Step 1: Confirm typecheck clean**

Run: `bunx tsc --noEmit`
Expected: no errors (baseline — if errors exist, record them in `output/baseline-errors.log` and address separately)

- [ ] **Step 2: Confirm test suite passes**

Run: `bun run test`
Expected: all tests pass (979+)

- [ ] **Step 3: Record baseline line counts**

Run: `find src -name "*.ts" | xargs wc -l | tail -1`
Expected: record total; target is ~10K lines fewer at end of chunk 14

- [ ] **Step 4: Commit baseline marker**

```bash
git add -A
git commit --allow-empty -m "chore: baseline snapshot before pipeline rearchitecture"
```

### Task 0.2: Install CSG library

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add manifold-3d dependency**

Run: `~/.bun/bin/bun add --backend=copyfile manifold-3d`
Expected: package.json updated; `node_modules/manifold-3d/` present

- [ ] **Step 2: Verify it loads in Bun**

Run this one-liner (creates a temp script and deletes it):
```bash
cat > /tmp/m3d-test.ts <<'EOF'
import Module from 'manifold-3d';
const mod = await Module();
console.log('manifold loaded:', typeof mod.Manifold);
EOF
bun /tmp/m3d-test.ts
rm /tmp/m3d-test.ts
```
Expected: `manifold loaded: function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add manifold-3d for B-rep CSG operations"
```

### Task 0.3: Disable old stop hooks for rearchitecture

**Files:**
- Create: `.claude/hooks/_DISABLED_DURING_REWRITE.md`
- Modify: `.claude/hooks/check-category-state.sh`, `check-iterate-state.sh`, `check-scene-completion.sh`

The old hooks keep interrupting work. Their replacement (Chunk 12) is far out. Add an early-exit for the duration of this rewrite, keyed by the presence of a sentinel file, so we don't lose them (migration plan calls for archival in step 15, not early deletion).

- [ ] **Step 1: Create sentinel file**

Create `.claude/hooks/_DISABLED_DURING_REWRITE.md` with content:
```markdown
# Hooks disabled during pipeline rearchitecture
The three `check-*-state.sh` hooks in this directory exit 0 early
when this file is present. See `docs/superpowers/specs/2026-04-17-pipeline-rearchitecture-design.md`.
Deleting this file re-activates the old behavior.
Chunk 12 of the implementation plan replaces these hooks with a single `check-pipeline-state.sh`.
```

- [ ] **Step 2: Add early-exit to each old hook**

For each of the 3 hooks, prepend (after the shebang):
```bash
# Disabled during rearchitecture — see _DISABLED_DURING_REWRITE.md
if [ -f "$CLAUDE_PROJECT_DIR/.claude/hooks/_DISABLED_DURING_REWRITE.md" ]; then exit 0; fi
```

- [ ] **Step 3: Test hook exits 0**

Run: `CLAUDE_PROJECT_DIR=/data/data/com.termux/files/home/git/craftmatic bash .claude/hooks/check-category-state.sh <<< '{}'`
Expected: exit 0, no output

- [ ] **Step 4: Commit**

```bash
git add .claude/hooks/
git commit -m "chore: disable old stop hooks during pipeline rearchitecture"
```

### Task 0.4: Update MEMORY.md with spec reference

**Files:**
- Modify: `/data/data/com.termux/files/home/.claude/projects/-data-data-com-termux-files-home-git-craftmatic/memory/MEMORY.md`

- [ ] **Step 1: Add memory pointer to the design spec**

Append to `MEMORY.md`:
```markdown
- [Pipeline Rearchitecture](pipeline-rearchitecture.md) — parametric B-rep pipeline replacing 21-phase voxel-patch (spec 2026-04-17)
```

- [ ] **Step 2: Create the referenced memory file**

Create `memory/pipeline-rearchitecture.md`:
```markdown
---
name: Pipeline Rearchitecture 2026-04-17
description: Design and status of the parametric B-rep pipeline replacing the 21-phase voxel-patch approach
type: project
---

# Rearchitecture Status

**Spec:** `docs/superpowers/specs/2026-04-17-pipeline-rearchitecture-design.md` (approved round 3)
**Plan:** `docs/superpowers/plans/2026-04-17-pipeline-rearchitecture.md`

## Decisions

- Model-first, voxel downstream
- Hybrid parametric synthesis (B-rep), cleaned-tiles fallback for curved/irregular
- Printable building GLB + separate scene GLB artifacts
- Objective gates + multi-VLM consensus (Gemini + Claude + GPT-5), median≥8.5 AND min≥7 AND spread≤2
- Pure core `src/pipeline/` shared by CLI and browser adapters
- Hybrid rewrite: delete mesh-filter/+pipeline.ts (~12K lines), keep voxelizer/API/color-blocks/schem (~7.6K lines), add ~2.5K new

## Why

Prior VLM grading plateaued at 5/20 passing 9.0; 15/20 declared source-data-limited. Root cause was architectural (patch dirty voxels) not tuning. Parametric synthesis from polygon+SV+sat bypasses photogrammetry limits.

## Key Invariants

1. Resolver runs once; BuildingContext is single source of truth
2. Captures sequential, each informing next (tiles → SV → satellite)
3. Stage 2 only runs pre-capture; `refineContextWithTiles` is the ONE post-3 mutation
4. B-rep is canonical form for print + voxel + scene derivatives
5. Watertight/manifold/self-intersect gates on `group_structural` only
6. Hook branches on `status` field, never derived `objective.pass`
```

- [ ] **Step 3: Commit**

```bash
git add ~/.claude/projects/-data-data-com-termux-files-home-git-craftmatic/memory/
git commit -m "docs: record rearchitecture project memory"
```

### Task 0.5: Scaffold src/pipeline/ directory tree

**Files:**
- Create: `src/pipeline/` with empty stubs per spec module layout
- Test: (none yet; scaffold is structural)

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p src/pipeline/context src/pipeline/capture src/pipeline/fusion \
         src/pipeline/synthesis src/pipeline/environment src/pipeline/export \
         src/pipeline/verify
```

- [ ] **Step 2: Create empty barrel files**

For each directory above, create `types.ts` and an `index.ts`:
- `src/pipeline/context/types.ts` — empty export block
- `src/pipeline/context/index.ts` — re-export from types
- (repeat for capture, fusion, synthesis, environment, export, verify)

Also create the top-level orchestrator stub:
- `src/pipeline/pipeline.ts` — `export async function runPipeline(address: string) { throw new Error('not yet implemented'); }`

- [ ] **Step 3: Typecheck clean**

Run: `bunx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/
git commit -m "feat: scaffold src/pipeline/ directory tree"
```

---

## Chunk 1: Resolver + Classify + Profile (Stages 0–2)

Pure, pre-capture data path. Test-driven from stub to full-coverage, no network calls in tests (mock the API clients).

### Task 1.1: Define `BuildingContext` and primitive types

**Files:**
- Create: `src/pipeline/context/types.ts`
- Test: `src/pipeline/context/types.test.ts`

- [ ] **Step 1: Write type definitions**

Populate `src/pipeline/context/types.ts` with all types from spec §"`BuildingContext` (resolver output)" including `LatLon`, `BuildingContext`, `RefinedBuildingContext` branded type, `CaptureProfile`, `ContextDraft`, nullability per spec. Import `SolarBuildingData` from `@craft/gen/api/google-solar.js`, `OSMBuildingData` from `@craft/gen/api/osm.js`.

- [ ] **Step 2: Test — type structural conformance**

Write compile-only test asserting `RefinedBuildingContext` is assignable to `BuildingContext` but not vice versa (use `expectTypeOf` from `expect-type` or a simple ambient-checks file).

- [ ] **Step 3: Run typecheck**

`bunx tsc --noEmit` — clean.

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/context): add BuildingContext + RefinedBuildingContext types"`

### Task 1.2: Profile table data

**Files:**
- Create: `src/pipeline/context/profiles.json`, `src/pipeline/context/profile.ts`
- Test: `src/pipeline/context/profile.test.ts`

- [ ] **Step 1: Failing test**

Write tests in `profile.test.ts`:
- `lookupProfile({ size: 'small', svDifficulty: 'suburban' })` → tile radius 40, SV dirs 4, offset 30, sat scale 1
- `lookupProfile({ size: 'tiny', svDifficulty: 'dense-urban' })` → SV offset 15/2 = 7.5 (modifier applied), angleVariants includes -45, 45
- `lookupProfile({ size: 'skyscraper', svDifficulty: 'rural-occluded' })` → angleVariants includes -60, 60; satellite.maskTrees = true; minBuildingPixelRatio = 0.15
- `lookupProfile({ size: 'medium', svDifficulty: 'no-coverage' })` → streetview.dirCount = 0

Run `bunx vitest run src/pipeline/context/profile.test.ts` — expect 4 failing tests.

- [ ] **Step 2: Implement `profiles.json`**

Write the base + modifier rows from spec §"Profile table (base rows)" and §"Modifier semantics".

- [ ] **Step 3: Implement `profile.ts`**

```ts
import data from './profiles.json' with { type: 'json' };
import type { CaptureProfile, BuildingContext } from './types.js';

export function lookupProfile(
  ctx: Pick<BuildingContext, 'size' | 'svDifficulty'>,
): CaptureProfile {
  const base = data.base[ctx.size];
  const mod = data.modifiers[ctx.svDifficulty] ?? {};
  return applyModifier(base, mod);
}
```

Plus `applyModifier` with operator semantics: scale-ops (`/=`, `*=`), concat-ops (`+=` on arrays, dedup), override-ops (`=`).

- [ ] **Step 4: Tests pass**

`bunx vitest run src/pipeline/context/profile.test.ts` — all 4 pass.

- [ ] **Step 5: Commit**

`git commit -m "feat(pipeline/context): profile table + modifier resolver"`

### Task 1.3: Shape classifier (polygon-based, pre-tile)

**Files:**
- Create: `src/pipeline/context/classify.ts` (partial — initial shape only)
- Test: `src/pipeline/context/classify.test.ts`

- [ ] **Step 1: Failing tests**

- `classifyShape(rectPolygon)` → `'rect'`
- `classifyShape(trianglePolygon)` → `'wedge'`
- `classifyShape(uShapedPolygon)` → `'U'`
- `classifyShape(courtyardWithInnerRing)` → `'courtyard'`
- `classifyShape(curvedPolygon(20vertices))` → `'curved'`
- `classifyShape(irregular8vertices)` → `'irregular'`

Polygons are pure arrays of `LocalPoint2D` (convert from LatLon via existing `geo-projection.ts`). Use synthetic polygons in tests.

- [ ] **Step 2: Implement `classifyShape()`**

Use convex-hull ratio, vertex count, concavity analysis (inner rings), Douglas-Peucker simplification (already in existing codebase — reuse), per spec §"Shape (initial, from polygon only)".

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/context): shape classifier from polygon"`

### Task 1.4: Size / SV-difficulty / archType classifiers

**Files:**
- Modify: `src/pipeline/context/classify.ts`
- Test: extend `classify.test.ts`

- [ ] **Step 1: Failing tests for each classifier**

- `classifySize({widthM: 12, depthM: 10})` → `'tiny'`
- `classifySize({widthM: 350, depthM: 60})` → `'skyscraper'`
- `classifySvDifficulty(osm, geocode)` — various scenarios
- `classifyArchType(osm, smarty)` — OSM amenity=townhall → civic, historic=* → historic, tourism=* → (various)

- [ ] **Step 2: Implement classifiers**

Per spec §"Size", §"SV difficulty", §"archType". Pure functions, no API calls.

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/context): size + SV-difficulty + archType classifiers"`

### Task 1.5: MBR fallback chain

**Files:**
- Modify: `src/pipeline/context/resolver.ts`
- Test: `src/pipeline/context/resolver.test.ts`

- [ ] **Step 1: Failing tests**

- `computeMbr(polygon)` → uses existing `building-alignment.computeBuildingAlignment()`
- `computeMbr(null, solarBbox)` → axis-aligned rectangle from bbox
- `computeMbr(null, null, geocodeViewport)` → viewport rectangle
- `computeMbr(null, null, null)` → throws 'context-insufficient' (resolver catches this and sets status)

- [ ] **Step 2: Implement**

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/context): MBR fallback chain + context-insufficient detection"`

### Task 1.6: Resolver top-level

**Files:**
- Modify: `src/pipeline/context/resolver.ts`
- Test: `src/pipeline/context/resolver.test.ts` (integration w/ mocked API clients)

- [ ] **Step 1: Failing test — flatiron golden**

Set up MSW or a simple fetch mock that intercepts:
- `/geocode/json?address=Flatiron...` → fixed Flatiron response
- `/solar.googleapis.com/v1/buildingInsights...` → fixed Solar response
- `/overpass...` → fixed OSM response

Assert `resolveContext('175 5th Ave, New York, NY')` returns a `BuildingContext` with:
- `size === 'medium'`
- `shape === 'wedge'`
- `archType === 'historic' || 'commercial'`
- `polygon !== null`
- `heightM ≈ 87`

- [ ] **Step 2: Implement `resolveContext()`**

Parallel fetch (Stage 1 is metadata fan-out, allowed):
```ts
const [geo, solar, osm, smarty] = await Promise.all([
  geocode(address),
  querySolar(address),
  searchOSM(...),
  querySmarty(address).catch(() => null),
]);
```
Then classify, build MBR, return `BuildingContext`.

- [ ] **Step 3: Test passes**

- [ ] **Step 4: Add 4 more golden tests**

guggenheim, pennzoil, geisel, 240-highland — each with fixture API responses (can cache live responses via a one-off fetcher script for reproducibility).

- [ ] **Step 5: All 5 golden tests pass**

- [ ] **Step 6: Commit**

`git commit -m "feat(pipeline/context): end-to-end resolver with 5-golden test coverage"`

---

## Chunk 2: Tile capture (Stage 3)

Extract pure capture logic from `scripts/tiles-headless.ts`.

### Task 2.1: Extract DRACO + polyfills to shared module

**Files:**
- Create: `src/pipeline/capture/tiles-deps.ts`
- Modify: `scripts/tiles-headless.ts` (to import from new module)
- Test: (integration, below)

- [ ] **Step 1: Move polyfills**

Extract lines 11-89 (window/document/DOMParser/rAF/ImageBitmap/createImageBitmap/ProgressEvent polyfills) and the DRACO decoder setup (lines 242-350) into `tiles-deps.ts` as `installNodePolyfills()` and `createDracoLoader()` exports.

- [ ] **Step 2: Legacy script imports from new module**

- [ ] **Step 3: Run legacy script — verify unchanged behavior**

Run: `bun scripts/tiles-headless.ts --lat=37.7567 --lng=-122.4313 -r 50 -o /tmp/coit-check.glb`
Expected: same behavior as before, GLB produced

- [ ] **Step 4: Commit**

`git commit -m "refactor: extract DRACO+polyfills into pipeline/capture/tiles-deps"`

### Task 2.2: Pure tile capture function

**Files:**
- Create: `src/pipeline/capture/tiles.ts`
- Test: `src/pipeline/capture/tiles.test.ts` (integration test — skip in CI, run locally)

- [ ] **Step 1: Failing test (integration, live API)**

```ts
it.skipIf(!process.env.GOOGLE_MAPS_API_KEY)('captures flatiron', async () => {
  const ctx = /* pre-built flatiron BuildingContext fixture */;
  const profile = lookupProfile(ctx);
  const evidence = await captureTiles(ctx, profile, { apiKey: process.env.GOOGLE_MAPS_API_KEY! });
  expect(evidence.meshCount).toBeGreaterThan(3);
  expect(evidence.measuredBbox.max.y).toBeGreaterThan(50);
  expect(evidence.noCoverage).toBe(false);
});
```

- [ ] **Step 2: Implement `captureTiles()`**

Lift the capture loop, multi-angle logic, mesh extraction, heightmap from `tiles-headless.ts` into `captureTiles(ctx, profile, opts) → TileEvidence`. Use `tiles-deps.ts` helpers. MBR-aligned bearings for multi-angle via existing `multi-angle-capture.ts`. Emit truncation + no-coverage flags per spec.

- [ ] **Step 3: Test passes** (when GOOGLE_MAPS_API_KEY set)

- [ ] **Step 4: Add unit tests for pure helpers**

- `measureTruncation(heightmap, expectedM)` → boolean
- `detectNoCoverage(meshCount)` → boolean

- [ ] **Step 5: Commit**

`git commit -m "feat(pipeline/capture): pure tile capture producing TileEvidence"`

### Task 2.3: Rewrite legacy tile script as thin wrapper

**Files:**
- Modify: `scripts/tiles-headless.ts`

- [ ] **Step 1: Replace capture loop with call to `captureTiles()`**

Script becomes ~150 lines: arg parse → build BuildingContext from flags → call `captureTiles()` → write GLB from returned `TileEvidence.glbPath`.

- [ ] **Step 2: Re-run same command as Task 2.1 Step 3**

Expect identical behavior.

- [ ] **Step 3: Commit**

`git commit -m "refactor: tiles-headless.ts delegates to pipeline/capture/tiles"`

---

## Chunk 3: SV capture (Stage 4)

The iterative per-direction loop is the big new logic.

### Task 3.1: Image sniff function

**Files:**
- Create: `src/pipeline/capture/sv-sniff.ts`
- Test: `src/pipeline/capture/sv-sniff.test.ts`

- [ ] **Step 1: Failing tests**

Synthesize test images (solid green = trees, solid blue = sky, grayscale gradient = building) via `sharp`. Assert `sniffImage(greenImg)` → `{ veg: ~1.0, sky: ~0, building: ~0 }`, etc.

- [ ] **Step 2: Implement sniff**

HSV-based classifier. Veg = H in 80-140 range with S > 0.3. Sky = H in 180-240 range OR high brightness with low saturation. Building = remainder. Per-pixel then aggregated as ratios.

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/capture): image sniff for sky/veg/building ratios"`

### Task 3.2: Per-direction SV iteration

**Files:**
- Create: `src/pipeline/capture/streetview.ts`
- Test: `src/pipeline/capture/streetview.test.ts`

- [ ] **Step 1: Failing tests (mocked API)**

Mock SV metadata + image endpoints:
- `fetchFacadeSv(ctx, profile, direction=0, api)` → resolves with `SvFacadeEvidence`
- If metadata returns pano 2× beyond maxPanoDistM: retries at 0.5× offset succeed
- If metadata returns no pano anywhere: `null` result, direction marked no-pano
- If image sniff shows veg%>0.4: try angleVariants; pick best; occlusion='trees'

- [ ] **Step 2: Implement `fetchFacadeSv()`**

Per spec §"Stage 4 — SV Capture (iterative)". Up to 3 metadata probes per direction, up to N variants per occlusion retry.

- [ ] **Step 3: Implement `captureStreetView()`**

Orchestrates per-direction calls based on `profile.streetview.dirCount`. Directions distributed along MBR edges (cardinal for rect, MBR-aligned for rotated footprints).

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

`git commit -m "feat(pipeline/capture): iterative SV per-direction capture"`

### Task 3.3: Facade palette + window grid + cornice detection

**Files:**
- Modify: `src/pipeline/capture/streetview.ts`
- Create: `src/pipeline/fusion/palette.ts` (shared palette extraction)
- Test: extend `streetview.test.ts`

- [ ] **Step 1: Failing tests**

- `extractFacadePalette(maskedImage)` → `{ wall: Lab, trim: Lab, accent: Lab|null }`
- `detectWindowGrid(image, facadeWidthM, facadeHeightM)` → `{ rows, cols, confidence }`
- `detectCornice(image)` → boolean

- [ ] **Step 2: Implement**

Palette: K-means in Lab on sky/veg-masked pixels, zone-sampled (bottom 60% wall, top 20% trim).
Windows: Hough-line detection for horizontal bands; count rows; count repeating patterns for cols.
Cornice: horizontal dark band at top 10-15%.

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/capture): facade palette + window grid + cornice detection"`

### Task 3.4: Occlusion classification rule

**Files:**
- Modify: `src/pipeline/capture/streetview.ts`
- Test: extend tests

- [ ] **Step 1: Failing tests**

- Given `{sniff: {veg: 0.05, sky: 0.2, building: 0.75}, heading: 90, bestHeading: 90}` → `'none'`
- Given `{sniff: {veg: 0.4, ...}}` → `'trees'`
- Given `{headingDelta: 25, primaryBuilding: 0.3, variantBuilding: 0.6}` → `'adjacent-building'`
- Otherwise → `'poles'`

- [ ] **Step 2: Implement `classifyOcclusion()`** per spec §"Occlusion classification rule"

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/capture): deterministic occlusion classification"`

---

## Chunk 4: Satellite + Fusion (Stages 5-6)

### Task 4.1: Satellite capture

**Files:**
- Create: `src/pipeline/capture/satellite.ts`
- Test: `src/pipeline/capture/satellite.test.ts`

- [ ] **Step 1: Failing tests (mocked)**

- `captureSatellite(ctx, tiles, sv, profile, api)` → returns `SatEvidence`
- Zoom computed from `tiles.measuredBbox` (not OSM)
- `scale=2` when `profile.satellite.scale === 2`
- Tree mask includes pixels from SV canopy + OSM `natural=tree`

- [ ] **Step 2: Implement**

Fetch Static Maps; tree mask via HSV green clusters excluding roof greens; K-means roof palette on unmasked pixels.

- [ ] **Step 3: Shadow detection helper + test**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/capture): satellite capture with tree mask + shadow detection"`

### Task 4.2: Evidence reconciliation

**Files:**
- Create: `src/pipeline/fusion/reconcile.ts`
- Test: `src/pipeline/fusion/reconcile.test.ts`

- [ ] **Step 1: Failing tests**

- `fuseEvidence(ctx, tiles, sv, sat)` → `JointEvidence` with `footprint.source === 'osm'` when polygon available
- `heightM.source === 'solar'` when tiles truncated
- `wallPalette` uses SV over OSM tag when they disagree by delta-E > 20
- Trees are union of OSM + SV + sat positions, deduped within 3m

- [ ] **Step 2: Implement per spec §"Stage 6 — Fusion" conflict table**

- [ ] **Step 3: Tests pass**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/fusion): evidence reconciliation w/ provenance"`

### Task 4.3: `refineContextWithTiles()`

**Files:**
- Modify: `src/pipeline/context/classify.ts`
- Test: extend `classify.test.ts`

- [ ] **Step 1: Failing tests**

- Flat even heightmap → shape unchanged
- Heightmap with tall center column, short surroundings → shape refined to `'tower-podium'`

- [ ] **Step 2: Implement**

Returns `RefinedBuildingContext` brand.

- [ ] **Step 3: Tests pass + commit**

`git commit -m "feat(pipeline/context): refineContextWithTiles for tower-podium detection"`

---

## Chunk 5: Parametric synthesis (Stage 7a)

### Task 5.1: BuildingBRep datatype + CSG helpers

**Files:**
- Create: `src/pipeline/synthesis/brep.ts`
- Test: `src/pipeline/synthesis/brep.test.ts`

- [ ] **Step 1: Type definitions** per spec §"`BuildingBRep`"

- [ ] **Step 2: `evaluateBRep(brep) → THREE.BufferGeometry`**

Uses `manifold-3d` to union floors + walls + roof, subtract window insets. Returns a single watertight mesh.

- [ ] **Step 3: Tests**

- Simple single-floor rect box → watertight cube geometry, correct volume
- Box with one window inset → still watertight, volume reduced by inset volume

- [ ] **Step 4: Tests pass + commit**

`git commit -m "feat(pipeline/synthesis): BuildingBRep datatype + manifold CSG evaluator"`

### Task 5.2: Roof volume generators

**Files:**
- Create: `src/pipeline/synthesis/roofs.ts`
- Test: `src/pipeline/synthesis/roofs.test.ts`

- [ ] **Step 1: Failing tests — one per shape**

For each of `flat`, `gabled`, `hipped`, `pyramidal`, `dome`, `mansard`, `shed`:
- `buildRoof(shape, polygon, baseZ, pitchDeg)` → `RoofVolume` with expected `peakZ`
- CSG-evaluable (no self-intersections at the ridge)
- Watertight when combined with the base box

- [ ] **Step 2: Implement each generator**

- [ ] **Step 3: Tests pass + commit**

`git commit -m "feat(pipeline/synthesis): 7 roof shape generators"`

### Task 5.3: Facade feature generators

**Files:**
- Create: `src/pipeline/synthesis/features.ts`
- Test: `src/pipeline/synthesis/features.test.ts`

- [ ] **Step 1: Failing tests**

- `buildWindowGrid(facadeWidth, facadeHeight, rows, cols, archType)` → correctly spaced window rectangles with `depthM = 0.08`
- `buildCornice(facadeEdge, facadeWidth, bandHeight)` → horizontal band at top
- `buildEntry(edge, offset, ground)` → door-sized rect at ground level

- [ ] **Step 2: Implement** per spec §"Features"

- [ ] **Step 3: Tests pass + commit**

`git commit -m "feat(pipeline/synthesis): window/cornice/entry feature generators"`

### Task 5.4: Parametric synthesizer

**Files:**
- Create: `src/pipeline/synthesis/parametric.ts`
- Test: `src/pipeline/synthesis/parametric.test.ts`

- [ ] **Step 1: Failing test — flatiron golden**

```ts
const brep = await synthesizeParametric(flatironCtx, flatironJointEv);
expect(brep.floors.length).toBe(Math.round(flatironCtx.heightM! / 3.5));
expect(brep.roof.type).toBe('flat'); // from OSM
const mesh = evaluateBRep(brep);
const bbox = new THREE.Box3().setFromObject(new THREE.Mesh(mesh));
expect(bbox.max.y - bbox.min.y).toBeCloseTo(flatironCtx.heightM!, 1);
expect(isWatertight(mesh)).toBe(true);
```

- [ ] **Step 2: Implement `synthesizeParametric()`** per spec §"Stage 7a — Parametric Synthesis"

- [ ] **Step 3: Test passes**

- [ ] **Step 4: Add tests for 240-highland (residential, gabled roof), pennzoil (skyscraper from truncated tiles)**

- [ ] **Step 5: Commit**

`git commit -m "feat(pipeline/synthesis): parametric synthesis producing BuildingBRep"`

---

## Chunk 6: Cleaned-tiles fallback (Stage 7b)

### Task 6.1: Polygon clipping + wall repair

**Files:**
- Create: `src/pipeline/synthesis/cleaned-tiles.ts`
- Test: `src/pipeline/synthesis/cleaned-tiles.test.ts`

- [ ] **Step 1: Failing test**

- Clip a test GLB to OSM polygon → meshes outside polygon removed
- Wall hole repair closes a synthetic 2m hole in a vertical wall

- [ ] **Step 2: Implement `clipMeshToPolygon()`, `repairWalls()`, `closeBottom()`**

- [ ] **Step 3: Tests pass + commit**

`git commit -m "feat(pipeline/synthesis): cleaned-tiles polygon clip + wall repair"`

### Task 6.2: Height extrapolation

**Files:**
- Modify: `src/pipeline/synthesis/cleaned-tiles.ts`
- Test: extend tests

- [ ] **Step 1: Failing test**

- Given truncated 60m mesh but ctx.heightM=172: after extrapolation, final mesh reaches Y=172 ± 2m
- Template cross-section taken from top-2m band; extruded with linear 0-2% taper
- Band texture tiled vertically

- [ ] **Step 2: Implement `extrapolateHeight()`** per spec §"Stage 7b — Cleaned Tiles" step 4

- [ ] **Step 3: Test passes + commit**

`git commit -m "feat(pipeline/synthesis): cleaned-tiles height extrapolation for truncated captures"`

### Task 6.3: Synthesis router

**Files:**
- Create: `src/pipeline/synthesis/router.ts`
- Test: `src/pipeline/synthesis/router.test.ts`

- [ ] **Step 1: Failing tests**

Per spec §"Stage 7 Router" decision table. 5 route cases.

- [ ] **Step 2: Implement + commit**

`git commit -m "feat(pipeline/synthesis): router parametric/cleaned-tiles/hybrid"`

---

## Chunk 7: Exports (Stage 8)

### Task 7.1: Shared glTF 2.0 writer

**Files:**
- Create: `src/pipeline/export/glb-writer.ts`
- Test: `src/pipeline/export/glb-writer.test.ts`

- [ ] **Step 1: Extract manual glTF 2.0 writer from `tiles-headless.ts` lines 619-830**

- [ ] **Step 2: Support multi-group export** (named scene nodes for group_structural / group_fixtures / group_plinth)

- [ ] **Step 3: Tests — roundtrip through gltf-validator (via `npx gltf-validator`)**

- [ ] **Step 4: Commit**

`git commit -m "feat(pipeline/export): shared multi-group glTF 2.0 writer"`

### Task 7.2: Print GLB export

**Files:**
- Create: `src/pipeline/export/glb-print.ts`
- Test: `src/pipeline/export/glb-print.test.ts`

- [ ] **Step 1: Failing test**

`exportPrintGlb(brep, { plinth: true })` → multi-group GLB; structural group watertight; loads in `gltf-transform` without warnings.

- [ ] **Step 2: Implement**

CSG evaluate → group_structural. Optional plinth → group_plinth. Optional windowpane planes → group_fixtures.

- [ ] **Step 3: Test passes + commit**

`git commit -m "feat(pipeline/export): printable GLB with structural/fixtures/plinth groups"`

### Task 7.3: Scene GLB export

**Files:**
- Create: `src/pipeline/export/glb-scene.ts`, `src/pipeline/environment/{trees,roads,terrain-mesh,scene}.ts`
- Test: `src/pipeline/export/glb-scene.test.ts`

- [ ] **Step 1: Environment primitives**

Trees (instanced billboards from JointEvidence), roads (flat strips from OSM), terrain mesh (from TileEvidence.heightmap with satellite texture).

- [ ] **Step 2: `exportSceneGlb(brep, env)`** assembles building + environment, no watertight gate.

- [ ] **Step 3: Tests + commit**

`git commit -m "feat(pipeline/export): scene GLB with terrain+trees+roads"`

### Task 7.4: Voxel export

**Files:**
- Create: `src/pipeline/export/voxel.ts`
- Test: `src/pipeline/export/voxel.test.ts`

- [ ] **Step 1: Failing test**

`exportVoxel(brep, { resolution: 1, sceneEnv })` → BlockGrid; building blocks at priority 1, environment at 0; color-matched via CIE-Lab.

- [ ] **Step 2: Implement**

Evaluates B-rep to mesh, calls existing `voxelizer.ts` with `color-blocks.ts` palette. Re-implements the small `writeWithPriority` primitive (~40 lines) for building vs environment priority.

- [ ] **Step 3: Test + commit**

`git commit -m "feat(pipeline/export): B-rep → BlockGrid via existing voxelizer"`

---

## Chunk 8: Verification (Stage 9)

### Task 8.1: Objective gates

**Files:**
- Create: `src/pipeline/verify/objective.ts`
- Test: `src/pipeline/verify/objective.test.ts`

- [ ] **Step 1: Failing tests**

One per gate:
- `checkFootprintIoU(synthMesh, osmPolygon)` → 0.85 threshold
- `checkHeightError(synthMesh, ctx)` → 10% threshold
- `checkWatertight(mesh)` → boundary edges = 0
- `checkManifold(mesh)`
- `checkSelfIntersect(mesh)` — exhaustive BVH-accelerated
- `checkMinWallThickness(mesh, scale=1/100)` → 0.8mm
- `checkVoxelOccupancy(grid)` → ≥1 AND ≤500K
- `checkPlinthWatertight(plinthMesh|null)` — skipped if null

- [ ] **Step 2: Implement each**

- [ ] **Step 3: `runObjectiveGates()` aggregates** → `ObjectiveResult`

- [ ] **Step 4: Tests pass + commit**

`git commit -m "feat(pipeline/verify): 8 objective gates with deterministic checks"`

### Task 8.2: VLM consensus

**Files:**
- Create: `src/pipeline/verify/consensus.ts`, `src/grade/vlm-consensus.ts`
- Test: `src/pipeline/verify/consensus.test.ts`

- [ ] **Step 1: Multi-model wrapper**

`src/grade/vlm-consensus.ts` exports `scoreConsensus(images, refs, { gemini: true, claude: true, gpt5: true })`. Each model via existing API pattern. For Claude/GPT-5, use `mcp__pal__chat` (requires MCP at runtime) OR direct SDK if available.

- [ ] **Step 2: 4-view renderer**

`render4Views(brep) → Buffer[]` using Three.js offscreen WebGL (Termux GPU-safe via node-canvas fallback).

- [ ] **Step 3: Release gate**

`median ≥ 8.5 AND min ≥ 7 AND spread ≤ 2`; rounds 1-3 with view rotation; terminal `needs-human-review`.

- [ ] **Step 4: Tests — mock model responses for deterministic assertions**

- [ ] **Step 5: Commit**

`git commit -m "feat(pipeline/verify): multi-VLM consensus scoring w/ 3-round termination"`

### Task 8.3: Verification report

**Files:**
- Create: `src/pipeline/verify/report.ts`
- Test: `src/pipeline/verify/report.test.ts`

- [ ] **Step 1: Compose objective + consensus into canonical state-record JSON** per spec §"Stage 10 — Stop hook" (including `status` enum)

- [ ] **Step 2: Tests pass + commit**

`git commit -m "feat(pipeline/verify): canonical VerificationReport shape"`

---

## Chunk 9: Orchestrator + entry script

### Task 9.1: Top-level `runPipeline()`

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Test: `src/pipeline/pipeline.test.ts`

- [ ] **Step 1: Failing test — full flow on flatiron with mocked APIs**

- [ ] **Step 2: Implement orchestrator** per spec §"Orchestrator call shape"

- [ ] **Step 3: End-to-end test passes + commit**

`git commit -m "feat(pipeline): top-level runPipeline orchestrator"`

### Task 9.2: `scripts/build.ts` CLI entry

**Files:**
- Create: `scripts/build.ts`

- [ ] **Step 1: Arg parse + call runPipeline**

`bun scripts/build.ts "175 5th Ave, New York, NY" --out output/flatiron/`

- [ ] **Step 2: Outputs:**

- `<slug>.print.glb`, `<slug>.scene.glb`, `<slug>.schem`, `<slug>.litematic`, `<slug>.verification.json`

- [ ] **Step 3: Run on 5 goldens, commit all outputs to `output/pipeline/` for review**

- [ ] **Step 4: Commit**

`git commit -m "feat: scripts/build.ts — address to all artifacts"`

---

## Chunk 10: Stop hook + iterate.ts (Stage 10)

### Task 10.1: State file + writer

**Files:**
- Modify: `src/pipeline/verify/report.ts` (add writeStateFile)
- Test: extend tests

- [ ] **Step 1: `updatePipelineState(path, slug, report)` merges into canonical JSON**

- [ ] **Step 2: `scripts/build.ts` writes to `output/pipeline-state.json`**

- [ ] **Step 3: Tests + commit**

`git commit -m "feat(pipeline/verify): state file writer"`

### Task 10.2: New stop hook

**Files:**
- Create: `.claude/hooks/check-pipeline-state.sh`

- [ ] **Step 1: Implement per spec §"Hook logic"**

Terminal-states-first ordering. Reads `status` field.

- [ ] **Step 2: Test with hand-crafted state files** (5 status cases)

- [ ] **Step 3: Register in `.claude/settings.json`**

- [ ] **Step 4: Remove sentinel `_DISABLED_DURING_REWRITE.md` (re-enable old hooks? NO — new hook supersedes)**

Instead: move old hooks to `.claude/hooks/_archived/` and delete entries from settings.json.

- [ ] **Step 5: Commit**

`git commit -m "feat: pipeline-state stop hook replaces old category/iterate/scene hooks"`

### Task 10.3: `scripts/iterate.ts`

**Files:**
- Create: `scripts/iterate.ts`

- [ ] **Step 1: Reads state, picks worst status, re-runs build for that address**

- [ ] **Step 2: Commit**

`git commit -m "feat: scripts/iterate.ts drives pipeline improvements based on state"`

---

## Chunk 11: Browser adapter

### Task 11.1: Extract browser-specific concerns from `tiles.ts`

**Files:**
- Modify: `web/src/ui/tiles.ts`
- Modify: `web/src/workers/voxelize-worker.ts`
- Create: (none)

- [ ] **Step 1: Replace tile loading + voxelization calls with `runPipeline()` wrappers**

The pure core handles tile capture + synthesis + export. Browser UI keeps: address input, progress UI, upload UI, selection raycaster.

- [ ] **Step 2: Manual testing on device**

Enter address → verify new pipeline runs, GLB downloads, voxel preview renders.

- [ ] **Step 3: Commit**

`git commit -m "refactor: web tiles.ts becomes thin adapter over pipeline core"`

---

## Chunk 12: Cleanup + delete old pipeline

### Task 12.1: Archive legacy scripts

**Files:**
- Move: `scripts/iterate-category-grade.ts`, `scripts/iterate-grade.ts`, `scripts/fetch-reference-data.ts` → `scripts/_legacy/`
- Move: `scripts/voxelize-glb.ts` → `scripts/_legacy/`
- Keep: `scripts/tiles-headless.ts` (still a useful debug tool, now a wrapper)

- [ ] **Step 1: Git mv each file**

- [ ] **Step 2: Fix any imports broken by the move**

- [ ] **Step 3: `bun run test` — clean**

- [ ] **Step 4: Commit**

`git commit -m "chore: archive legacy iteration scripts to scripts/_legacy"`

### Task 12.2: Delete the bandaid layer

**Files:**
- Delete: `src/convert/pipeline.ts`, `src/convert/mesh-filter.ts`, `src/convert/mesh-filter/*.ts` (11 files)
- Delete: `src/convert/voxel-classifier.ts`, `src/convert/scene-pipeline.ts`
- Delete: `src/convert/semantic-palette.ts` (concept re-implemented in fusion/palette.ts)
- Delete: `src/convert/scene-enrichment.ts`, `src/convert/osm-infrastructure.ts` (replaced by pipeline/environment/)
- Delete: `src/grade/category-locations.ts`, `src/grade/category-prompts.ts`, `src/grade/category-score.ts`, `src/grade/parse-category-scores.ts`, `src/grade/defect-score.ts`

- [ ] **Step 1: Check no remaining imports (grep)**

Run: `grep -r "from.*mesh-filter\|from.*scene-pipeline\|from.*voxel-classifier" src/ web/ scripts/ 2>/dev/null`
Expected: no output

- [ ] **Step 2: Delete files, run typecheck**

- [ ] **Step 3: Run full test suite**

- [ ] **Step 4: Commit each deletion category separately**

```bash
git rm src/convert/mesh-filter.ts src/convert/mesh-filter/
git commit -m "chore: delete mesh-filter/ — replaced by pipeline core"
git rm src/convert/voxel-classifier.ts src/convert/scene-pipeline.ts
git commit -m "chore: delete voxel-classifier + scene-pipeline — subsumed"
# ... etc
```

### Task 12.3: Archive old hooks

**Files:**
- Move: `.claude/hooks/check-{category,iterate,scene}-state.sh` → `.claude/hooks/_archived/`

- [ ] **Step 1: Git mv**

- [ ] **Step 2: Commit**

`git commit -m "chore: archive obsolete stop hooks"`

### Task 12.4: Line count verification

**Files:**
- (no changes, verification only)

- [ ] **Step 1: Count lines**

`find src web scripts -name "*.ts" -not -path "*/_legacy/*" -not -path "*/node_modules/*" | xargs wc -l | tail -1`

- [ ] **Step 2: Compare to baseline from Task 0.1 Step 3**

Expected: ~10K lines lighter.

- [ ] **Step 3: Update MEMORY.md with final status** (pass count, line count, any known plateau)

- [ ] **Step 4: Commit**

`git commit -m "docs: final rearchitecture status"`

---

## Execution notes

- Each chunk's tests must pass before moving to the next chunk.
- `bunx tsc --noEmit` clean at every commit — no exceptions.
- If a chunk's reference behavior (flatiron etc.) regresses, stop and fix before moving forward.
- Objective gate thresholds are tunable; start with spec values. If golden tests fail by small margins, first verify the pipeline isn't buggy, then consider threshold tuning (requires spec update).
- VLM consensus depends on external models (Gemini, Claude, GPT-5). Mock them in tests; run real calls only in `scripts/build.ts` path against goldens.
- API cost control: Chunk 9 (`scripts/build.ts`) is the first real-API run. Budget ~$5-10 to grade all 5 goldens once (tiles + SV + sat + 3 VLMs).

## Risk callouts during execution

- **manifold-3d + Bun compatibility** — if it fails, fall back to `three-bvh-csg` (pure TS).
- **Three.js offscreen rendering on Termux** — if WebGL fails, switch to `node-canvas` software rasterization for the 4-view renderer; quality is fine for VLM scoring at 512×512.
- **Old pipeline left functional until Chunk 12** — if anything pre-Chunk-12 breaks old workflows, surface and fix before continuing.
