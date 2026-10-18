# Craftmatic LEGO → Minecraft Bedrock Add-on Architecture

**Status:** implementation target  
**Scope:** LDraw / BrickLink Studio LEGO model → importable Bedrock `.mcaddon` entity pipeline  
**Reviewed against:** `tribixbite/craftmatic` `main`, 2026-09-14

## 1. Objective

Produce a Bedrock add-on whose in-game entity preserves the source LEGO model's:

- part placement and orientation;
- silhouette and recognizable LEGO part geometry at player scale;
- exact LDraw colors and transparency classes;
- ABS-plastic / glass / rubber material appearance, with Vibrant Visuals PBR where available;
- cockpit/seat placement and existing Craftmatic vehicle behavior.

The high-detail entity path **must not voxelize the model into Minecraft world blocks first**.

Static `.schem` / `.mcstructure` export is a separate pipeline. Java display entities are out of scope for this document.

---

## 2. Current Pipeline and Primary Defect

Current flow:

```text
LDraw / MPD
  ↓
parseLDraw()
  ↓ ParsedBrick[]
discoverPlayableComponents()
  ↓ component.bricks
buildPlayableAddon()
  ↓
compileLdrawEntityGeometry()
  ↓
getPartDims(part)
  ↓
one rectangular Bedrock cube per LEGO part
  ↓
.geo.json + atlas + behavior/resource packs
  ↓
.mcaddon
```

Relevant current code:

| Responsibility | Current symbol | Source |
|---|---|---|
| Parse MPD/LDR and accumulate transforms | `parseLDraw()` / `expandSection()` | [`ldraw-parser.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-parser.ts#L48-L60) |
| Vehicle/submodel isolation | `discoverPlayableComponents()` | [`playable-components.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-components.ts#L100-L179) |
| Add-on orchestration | `buildPlayableAddon()` | [`playable-addon.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L743-L869) |
| Direct LDraw entity compiler | `compileLdrawEntityGeometry()` | [`ldraw-entity-compiler.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-entity-compiler.ts#L83-L92) |
| Current part-size approximation | `getPartDims()` | [`ldraw-part-dims.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-part-dims.ts#L530-L547) |
| Existing shape metadata | `getPartShape()` | [`ldraw-part-dims.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-part-dims.ts#L820-L827) |
| Current entity atlas | `generateEntityLegoAtlasPng()` | [`lego-resource-pack.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/lego-resource-pack.ts#L147-L160) |
| Legacy voxel → entity fallback | `greedyBoxes()` / `geometry()` | [`playable-addon.ts`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L188-L279) |

### Current defect

`compileLdrawEntityGeometry()` already bypasses the block voxel grid, which is correct. The fidelity loss now happens here:

```ts
const [sW, sH, sL] = getPartDims(b.part);
// ...
cubes.push({ origin, size: [wUnits, hUnits, lUnits], ... });
```

See [`ldraw-entity-compiler.ts` L309-L345](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-entity-compiler.ts#L309-L345).

This turns each terminal LDraw part into its bounding cuboid. A slope, wheel, curved fender, wedge, arch, canopy, etc. therefore has the correct approximate location and extent but the wrong shape.

**Do not increase world-block voxel resolution to fix this. Fix the per-part geometry representation.**

---

## 3. Bedrock Constraints

Use supported Bedrock entity geometry:

- bones;
- cuboids with floating-point `origin`, `size`, pivot and rotation;
- per-face UVs;
- multiple geometry/render-controller chunks;
- opaque/translucent material separation.

Do **not** build the architecture around `poly_mesh`. Bedrock's geometry schema describes it as deprecated and states that new use produces content errors.

References:

- [Bedrock geometry schema](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/visualreference/geometry.v1.19.30?view=minecraft-bedrock-stable)
- [Custom entity geometry/materials/render controllers](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoaddentity?view=minecraft-bedrock-stable)
- [`entity_alphablend` and entity materials](https://learn.microsoft.com/en-us/minecraft/creator/documents/material-files?view=minecraft-bedrock-stable)
- [Vibrant Visuals PBR](https://learn.microsoft.com/en-us/minecraft/creator/documents/vibrantvisuals/pbroverview?view=minecraft-bedrock-stable)
- [Texture Sets](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/texturesetsreference/texturesetsconcepts/texturesetsintroduction?view=minecraft-bedrock-stable)

The existing `1024` cubes/geometry partition is a Craftmatic renderer-safety policy, not a documented Bedrock format limit. Keep it unless device testing justifies changing it.

---

## 4. Target Architecture

```text
                          ┌───────────────────────────┐
LDraw / MPD / Studio .io │ source + embedded parts   │
             ───────────▶│ parseLDrawDocument()      │
                          └─────────────┬─────────────┘
                                        │
                         placements     │     part definitions
                                        ▼
                          ┌───────────────────────────┐
                          │ PartGeometryProvider      │
                          │ resolve part .dat tree    │
                          │ triangles/quads/materials │
                          └─────────────┬─────────────┘
                                        │ local-space part mesh
                                        ▼
                          ┌───────────────────────────┐
                          │ compilePartPrototype()    │
                          │ exact fast paths          │
                          │ analytic templates        │
                          │ adaptive box decomposition│
                          └─────────────┬─────────────┘
                                        │ cached prototype
                                        ▼
                          ┌───────────────────────────┐
                          │ instantiatePartPrototype()│
ParsedBrick transform ───▶│ apply world transform    │
                          └─────────────┬─────────────┘
                                        │
                      ┌─────────────────┴─────────────────┐
                      ▼                                   ▼
             opaque Bedrock cubes                translucent cubes
                      │                                   │
                      └─────────────────┬─────────────────┘
                                        ▼
                          ┌───────────────────────────┐
                          │ buildEntityGeometry()     │
                          │ chunk / bounds / seat     │
                          └─────────────┬─────────────┘
                                        │
                      ┌─────────────────┴─────────────────┐
                      ▼                                   ▼
             base/fallback atlas                 PBR texture sets
                      │                                   │
                      └─────────────────┬─────────────────┘
                                        ▼
                               buildPlayableAddon()
                                        │
                                        ▼
                                     .mcaddon
```

### Core invariant

`ParsedBrick` remains the placement-level source of truth:

```ts
interface ParsedBrick {
  color: number;
  x: number;
  y: number;
  z: number;
  rot?: number[]; // world 3×3
  part: string;
  step?: number;
  sourcePath?: string[];
}
```

Do not replace the current component-discovery or vehicle behavior architecture. Replace only the **visual part compilation** underneath it.

---

## 5. Parser/Data-Model Change

### Problem

`parseLDraw()` returns flattened terminal placements but discards the source geometry needed to reconstruct terminal `.dat` parts. It also intentionally treats embedded `Unofficial_Part` / `Unofficial_Subpart` sections as terminals.

Current behavior: [`ldraw-parser.ts` L153-L185](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-parser.ts#L153-L185).

### Add

```ts
export interface LDrawSection {
  name: string;
  lines: string[];
}

export interface LDrawDocument {
  bricks: ParsedBrick[];
  sections: Map<string, LDrawSection>;
  rootSection: string;
}

export function parseLDrawDocument(content: string): LDrawDocument;
```

Keep compatibility:

```ts
export function parseLDraw(content: string): ParsedBrick[] {
  return parseLDrawDocument(content).bricks;
}
```

`parseLDrawDocument()` must preserve:

- every `0 FILE` section;
- embedded `.dat` definitions from Studio/MPD files;
- root model;
- existing recursive placement expansion;
- color-16 inheritance;
- existing `step` and `sourcePath` behavior.

Do not expose parser-private `Section` objects by reference; normalize section names once.

---

## 6. Part Geometry Provider

Create:

`web/src/engine/ldraw-part-geometry.ts`

### Interfaces

```ts
export interface LdrawTriangle {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  color: number; // already resolved relative to the part instance
}

export interface LdrawPartMesh {
  partId: string;
  triangles: LdrawTriangle[];
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export interface PartGeometryProvider {
  getPartMesh(part: string): Promise<LdrawPartMesh | null>;
}
```

### Resolver

```ts
export function createPartGeometryProvider(options: {
  document?: LDrawDocument;
  fetchPartText?: (normalizedPath: string) => Promise<string | null>;
}): PartGeometryProvider;
```

Resolution order:

1. exact embedded MPD/Studio section;
2. embedded subpart;
3. Craftmatic `/ldraw-parts/` source;
4. explicit unresolved result.

Cache both source text and final `LdrawPartMesh` by normalized part ID.

### LDraw geometry parsing

Support only what is required for solid surface reconstruction:

- type `1`: recursive sub-file reference;
- type `3`: triangle;
- type `4`: quad → two triangles;
- type `2`/`5`: edge/conditional-line data may be ignored for entity solids;
- color `16`: inherit parent/material context;
- explicit local colors: retain;
- direct-color values: retain.

The recursive resolver must accumulate the same matrix convention used by `parseLDraw()`.

Guard recursion and cycles exactly as the placement parser does.

---

## 7. Per-Part Prototype Compiler

Create:

`web/src/engine/ldraw-part-prototype.ts`

```ts
export interface LegoEntityQuality {
  maxModelCubes: number;
  maxPartCubes: number;
  microcellLdu: number;
  meshChunkCubes: number;
}

export interface PartCuboid {
  originLdu: [number, number, number];
  sizeLdu: [number, number, number];
  rotation?: [number, number, number];
  material: LdrawMaterialKey;
  faceClass?: 'stud' | 'side' | 'bottom' | 'glass' | 'rubber' | 'print';
}

export interface CompiledPartPrototype {
  partId: string;
  cuboids: PartCuboid[];
  source: 'exact-box' | 'analytic' | 'mesh-decomposition' | 'aabb-fallback';
  boundsLdu: { min: Vec3; max: Vec3 };
  error?: PartApproximationMetrics;
}

export function compilePartPrototype(
  mesh: LdrawPartMesh,
  options: LegoEntityQuality,
): CompiledPartPrototype;
```

### Compilation strategy

Use this priority order.

#### A. Exact box fast path

For genuinely rectangular parts—standard bricks, plates, tiles, simple panels—emit the minimum exact cuboids.

`getPartDims()` and `getPartShape()` may be used as classification hints, **not as the rendered geometry source**.

#### B. Analytic templates

Use known shape classes where they are cheaper and more accurate than generic decomposition:

- `slope`, `slope_inv`, `slope_double`;
- `wedge`;
- `round`;
- `arch`;
- `frame`;
- `corner`;
- `panel`.

Existing classifications are in `PART_SHAPES` / `getPartShape()`.

Templates should emit rotated/subdivided cuboids in local part space.

#### C. Generic mesh → cuboid decomposition

For arbitrary curved/specialized parts:

1. rasterize the resolved local part mesh to a bounded microcell occupancy representation;
2. mark material at surface cells;
3. greedy-merge contiguous cells into cuboids;
4. iteratively merge/simplify while projected silhouette error stays within the quality threshold;
5. prefer preserving external silhouette over internal cavities;
6. discard invisible internal geometry where safe.

This rasterization is **per unique LEGO part**, not per assembled vehicle and not onto Minecraft world blocks.

Cache the compiled prototype. A model with 100 instances of part `3001.dat` compiles that prototype once.

#### D. AABB fallback

Only when:

- the part cannot be resolved;
- geometry is malformed;
- budget would otherwise be exceeded.

Every AABB fallback must produce a warning and diagnostic entry. It must never be silent.

---

## 8. Part Instancing and Coordinate Rules

Keep the existing physical scale unless product requirements change:

```ts
export const BEDROCK_UNITS_PER_LDU = 3.2 / 20; // 0.16
```

Current definition: [`ldraw-entity-compiler.ts` L15-L18](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-entity-compiler.ts#L15-L18).

Therefore:

```text
20 LDU = 1 LEGO stud = 3.2 Bedrock model units = 0.2 Minecraft blocks
 8 LDU = 1 LEGO plate
16 Bedrock model units = 1 Minecraft block
```

Add:

```ts
export function instantiatePartPrototype(
  prototype: CompiledPartPrototype,
  brick: ParsedBrick,
  modelTransform: LdrawToBedrockTransform,
): InstancedPartGeometry;
```

Rules:

- prototype cuboids remain in part-local LDraw coordinates;
- apply `brick.rot` to each local cuboid;
- apply `brick.x/y/z`;
- then apply model recentering, axis selection, forward direction and LDraw Y inversion;
- never infer part orientation from AABB dimensions;
- preserve arbitrary source rotation matrices.

Avoid grouping unrelated rotated parts under one averaged bone pivot if that changes local placement. A cuboid or minimal per-instance bone must retain the source transform exactly.

---

## 9. Replace the Current Compiler Internals

Keep the public orchestration point:

```ts
compileLdrawEntityGeometry(...)
```

Change it to asynchronous geometry resolution:

```ts
export async function compileLdrawEntityGeometry(
  cid: string,
  kind: PlayableKind,
  bricks: ParsedBrick[],
  options: {
    scale?: number;
    facing?: VehicleFacing;
    userSeatAnchor?: { x: number; y: number; z: number };
    partGeometry: PartGeometryProvider;
    quality?: Partial<LegoEntityQuality>;
  },
): Promise<CompiledLdrawGeometry>;
```

Then in `buildPlayableAddon()`:

```ts
const ldrawGeo = await compileLdrawEntityGeometry(...);
```

Current call site: [`playable-addon.ts` L795-L831](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L795-L831).

### Preserve from the current compiler

- display-stand filtering;
- vehicle orientation logic;
- cockpit/seat detection;
- collision-box derivation;
- opaque/canopy separation;
- mesh chunking;
- `meshIds` / `canopyMeshId` contract;
- visible bounds.

### Replace

Delete the assumption in `buildCubesFromBricks()` that one `ParsedBrick` equals one `getPartDims()` cube.

The new equivalent should operate on instantiated prototype cuboids.

---

## 10. Material and Color Architecture

### Do not use Minecraft block colors for entity visuals

Current entity generation does:

```text
LDraw color → ldrawColorToBlock() → Minecraft block state → blockRgb()
```

That unnecessarily quantizes source LEGO colors.

`ldrawColorToBlock()` remains correct for **world-block exports**, but the high-detail entity path should use LDraw RGB directly.

Authoritative RGB data already exists in `LDRAW_COLOR_RGB`:

[`ldraw-colors.ts` L260+](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/ldraw-colors.ts#L260-L330).

Add:

```ts
export type LegoMaterialClass =
  | 'abs'
  | 'transparent'
  | 'rubber'
  | 'chrome'
  | 'metallic'
  | 'pearl'
  | 'glow';

export interface LdrawEntityMaterial {
  colorId: number;
  rgb: [number, number, number];
  alpha: number;
  materialClass: LegoMaterialClass;
  metalness: number;
  emissive: number;
  roughness: number;
}

export function resolveLdrawEntityMaterial(colorId: number): LdrawEntityMaterial;
```

Use exact RGB for known LDraw colors and exact direct-color RGB for `0x2RRGGBB`.

Separate **cockpit semantics** from **transparency**:

- canopy/seat part-ID lists are for cockpit detection;
- color/material metadata determines translucency.

Do not automatically make a part translucent merely because its part ID is commonly used as a canopy.

---

## 11. Texture/PBR Pipeline

Retain a non-PBR fallback texture for compatibility, but add a real PBR path for Vibrant Visuals.

### Replace/extend

Current:

```ts
generateEntityLegoAtlasPng(palette, blockRgbFn, blockAlphaFn)
```

Target:

```ts
export interface EntityTextureAtlas {
  colorPng: Uint8Array;
  normalPng?: Uint8Array;
  merPng?: Uint8Array;
  textureSetJson?: Uint8Array;
  width: number;
  height: number;
}

export function generateLegoEntityTextureAtlas(
  materials: LdrawEntityMaterial[],
  options: {
    pbr: boolean;
    fallbackHighlights: boolean;
  },
): EntityTextureAtlas;
```

### Color/albedo map

For PBR:

- use source RGB;
- do not bake fake directional specular highlights into albedo;
- retain seam/print/color information that belongs in base color.

For classic rendering fallback:

- optional baked bevel/stud cues may remain.

### Normal map

Use normals for:

- stud rings;
- subtle molded-edge bevels;
- fine ABS surface response.

Normal mapping supplements geometry; it must not be used to fake major silhouette-changing slopes/wheels.

### MER map

For Vibrant Visuals, output metalness/emissive/roughness channels:

- ABS: non-metallic, low/moderate roughness;
- rubber: non-metallic, higher roughness;
- chrome/metallic LDraw finishes: metallic;
- transparent plastic: smooth, non-metallic;
- glow colors: emissive where appropriate.

Keep values centralized and tunable; do not scatter material constants through the compiler.

### Pack manifest

When PBR assets are emitted, add:

```json
"capabilities": ["pbr"]
```

to the resource-pack manifest.

Vibrant Visuals supports PBR Texture Sets on entities; RTX PBR support is more restricted. Target Vibrant Visuals for entity PBR.

---

## 12. Prints, Decals, and Multi-Color Parts

Preserve the full LDraw part ID. Do not normalize away print suffixes for visual geometry lookup.

Examples such as `3010p01.dat` may have geometry/material details distinct from the unprinted base part.

Implementation order:

1. resolve the exact printed part `.dat`;
2. propagate explicit LDraw colors in its triangles;
3. inherit placement color only for color `16`;
4. when a prototype cuboid face contains multiple source surface colors, bake the face appearance into atlas UV space;
5. if detailed face baking is not implemented yet, degrade to the dominant surface color and record a `print-detail-fallback` diagnostic.

Geometry normalization used by `getPartDims()` is not appropriate for visual part resolution.

---

## 13. Transparency

Maintain separate geometry/render controllers for opaque and translucent surfaces, as the current `clientEntity()` / `meshControllers()` architecture already supports.

Current functions:

- [`clientEntity()`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L280-L313)
- [`meshControllers()`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L314-L336)

Rules:

- opaque body: prefer `entity`/appropriate opaque material;
- translucent pieces: `entity_alphablend`;
- do not render the entire vehicle with `entity_alphablend` solely because some glass exists;
- preserve alpha from LDraw material classification.

---

## 14. Mesh Budgets and LOD

Keep deterministic budgets so a single pathological part cannot explode the pack or renderer.

Recommended initial profiles:

```ts
export const LEGO_ENTITY_QUALITY = {
  balanced: {
    maxModelCubes: 4096,
    maxPartCubes: 128,
    microcellLdu: 4,
    meshChunkCubes: 1024,
  },
  high: {
    maxModelCubes: 8192,
    maxPartCubes: 256,
    microcellLdu: 2,
    meshChunkCubes: 1024,
  },
  ultra: {
    maxModelCubes: 16384,
    maxPartCubes: 512,
    microcellLdu: 1,
    meshChunkCubes: 1024,
  },
} satisfies Record<string, LegoEntityQuality>;
```

These are Craftmatic policy defaults, not claimed Bedrock engine limits. Tune from device tests.

Budget reduction order:

1. remove invisible internal cells;
2. merge coplanar/adjacent cuboids;
3. reduce curved-part segmentation;
4. simplify tiny details below projected pixel significance;
5. only then use per-part AABB fallback.

Never silently drop whole visible LEGO parts.

---

## 15. Seats, Collision, and Vehicle Behavior

Do not couple visual geometry fidelity to vehicle physics.

Preserve current:

- `behaviorEntity()`;
- `minecraft:rideable`;
- car/plane/boat behavior;
- DeLorean special behavior;
- seat/cockpit heuristics;
- collision-box clamping.

Current behavior path starts at [`behaviorEntity()`](https://github.com/tribixbite/craftmatic/blob/main/web/src/engine/playable-addon.ts#L93-L186).

Improve seat calculation only when resolved geometry provides stronger anchors.

Recommended future extension:

```ts
interface PartSemantic {
  role?: 'seat' | 'steering-wheel' | 'canopy' | 'wheel' | 'stand' | 'body';
}
```

Keep semantic role lookup separate from material lookup and geometric decomposition.

---

## 16. Fallback Pipeline

`greedyBoxes()` / `geometry()` remains supported only when the component has no LDraw part data:

```ts
if (c.bricks?.length) {
  // high-detail LDraw path
} else {
  // existing BlockGrid → greedyBoxes fallback
}
```

Do not route a resolvable LDraw model through the BlockGrid path because a specific part fails. Fail/simplify **that part**, not the entire model.

---

## 17. Diagnostics

Add to `CompiledLdrawGeometry`:

```ts
export interface LegoGeometryDiagnostics {
  sourcePartCount: number;
  uniquePartCount: number;
  resolvedPartCount: number;
  unresolvedParts: string[];
  prototypeCacheHits: number;
  cubeCount: number;
  opaqueCubeCount: number;
  translucentCubeCount: number;
  meshCount: number;
  aabbFallbackParts: Array<{ part: string; count: number; reason: string }>;
  printFallbackParts: string[];
  quality: LegoEntityQuality;
}
```

Return it from `compileLdrawEntityGeometry()` and propagate high-value warnings into `PlayableAddonResult.warnings`.

In development builds, optionally include:

```text
Craftmatic_<id>_BP/craftmatic-diagnostics.json
```

The exporter must make fidelity degradation inspectable.

---

## 18. Testing

### Unit tests

Add tests for:

#### Parser/document preservation

- embedded `0 FILE ... .dat` sections survive `parseLDrawDocument()`;
- color-16 inheritance remains correct;
- transform accumulation matches current `parseLDraw()` output.

#### Part resolver

- nested type-1 transforms;
- triangles/quads;
- exact printed part ID resolution;
- cycle guard;
- missing-part result;
- embedded source beats remote source.

#### Prototype compiler

At minimum fixtures for:

- `3001.dat`: rectangular brick;
- common plate/tile;
- `3040.dat`: slope;
- wedge;
- round/cylindrical part;
- wheel/tire;
- canopy;
- printed part.

Assertions:

- box parts remain minimal;
- slope/wedge/round parts are **not** emitted as one AABB;
- prototype bounds match source bounds within 1 LDU;
- quality budget is respected;
- deterministic input produces byte-stable geometry JSON.

### Golden model tests

Keep the already-used validation models as permanent regression fixtures:

- `75892-1` McLaren Senna;
- `10300-1` DeLorean Time Machine;
- `7140-1` X-wing Starfighter.

For each:

- exported add-on contains BP/RP manifests;
- high-detail path is used;
- zero unexpected model-level fallback to `greedyBoxes()`;
- geometry cube count stays within selected profile;
- no unresolved high-visibility parts without warnings;
- canopy material path exists where applicable;
- PBR texture-set files exist when PBR enabled;
- behavior entity remains rideable/controllable.

### Visual regression

Render the source LDraw model and generated Bedrock cuboid approximation from identical canonical cameras.

Measure six-view silhouette IoU:

```text
front / back / left / right / top / isometric
```

Initial high-profile gate:

```text
model silhouette IoU >= 0.95
```

Also store image diffs for human inspection. The metric must emphasize silhouette; internal LEGO cavities are lower priority than visible shape.

### Bedrock smoke test

Automated ZIP/schema tests are necessary but not sufficient.

Release gate for representative models:

1. import `.mcaddon` into current Bedrock;
2. check Content Log for geometry/material errors;
3. summon/place entity;
4. verify opaque/translucent rendering;
5. verify riding/control;
6. test classic graphics and Vibrant Visuals where supported.

---

## 19. Implementation Sequence

### Phase A — Stop losing source geometry

1. Add `LDrawDocument`.
2. Add `parseLDrawDocument()`.
3. Add `PartGeometryProvider`.
4. Resolve embedded and `/ldraw-parts/` `.dat` geometry.
5. Add resolver tests.

**Exit condition:** any `ParsedBrick.part` used by a golden model can return a local triangle mesh or an explicit unresolved diagnostic.

### Phase B — Part prototypes

1. Add exact rectangular fast path.
2. Add generic mesh decomposition.
3. Add `getPartShape()` analytic optimizations.
4. Add prototype cache and budgets.
5. Replace `getPartDims()` cube generation inside `compileLdrawEntityGeometry()`.

**Exit condition:** slopes, wheels, wedges and canopies are no longer AABB boxes in exported `.geo.json`.

### Phase C — Correct materials

1. Add `resolveLdrawEntityMaterial()`.
2. Remove `ldrawColorToBlock()` from the high-detail entity color path.
3. Generate exact RGB/alpha atlas.
4. Keep block mapping unchanged for `.schem`/world exports.

**Exit condition:** solid entity colors come directly from LDraw/direct RGB values.

### Phase D — PBR

1. Generate entity normal + MER maps.
2. Generate `.texture_set.json`.
3. add `capabilities: ["pbr"]`;
4. maintain classic fallback albedo.

**Exit condition:** ABS/rubber/glass/metal classes visibly respond differently under Vibrant Visuals.

### Phase E — Prints + quality tuning

1. exact printed-part lookup;
2. face color/decal baking;
3. silhouette regression harness;
4. tune budgets on mobile/desktop Bedrock.

---

## 20. Hard Rules for the Coding Agent

1. **Do not reintroduce whole-model voxelization into the high-detail LDraw entity path.**
2. **Do not use deprecated `poly_mesh` as the solution.**
3. **Do not use `getPartDims()` as final visual geometry except explicit AABB fallback.**
4. **Do not map LDraw colors through Minecraft block colors for entity rendering.**
5. **Do not silently drop parts, prints, transparency, or unsupported geometry. Emit diagnostics.**
6. **Do not modify the existing static world-block pipeline to solve an entity-rendering problem.**
7. **Do not break `discoverPlayableComponents()`, rideability, DeLorean behavior, or the BlockGrid fallback.**
8. **Cache by unique part ID; compile geometry once, instance many times.**
9. **Preserve exact source transforms before optimization.**
10. **Optimize silhouette fidelity first, internal geometry second.**

---

## 21. Definition of Done

The architecture is complete when:

- `buildPlayableAddon()` still emits a directly importable `.mcaddon`;
- LDraw components no longer reduce ordinary non-box LEGO parts to bounding cuboids;
- all source part transforms are preserved;
- exact LDraw colors feed the entity textures;
- opaque and transparent pieces render through separate appropriate materials;
- Vibrant Visuals PBR assets are emitted without breaking classic rendering;
- golden models retain existing ride/flight/time-machine behavior;
- unsupported parts visibly degrade through documented per-part fallbacks rather than whole-model voxelization;
- diagnostics identify every fallback;
- high-quality exports pass the silhouette regression target and Bedrock smoke test.

The conceptual boundary should remain:

```text
LDraw placement/model semantics
        ↓
reusable LEGO part geometry
        ↓
Bedrock-supported cuboid approximation + PBR
        ↓
vehicle/entity packaging
```

—not:

```text
LDraw
  ↓
Minecraft world blocks
  ↓
greedy mesh
  ↓
vehicle
```
