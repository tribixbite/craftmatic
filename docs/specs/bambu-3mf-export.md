# Bambu-compatible 3MF + STL export — implementation spec

**Status:** spec, not yet implemented. Owner of next slice: agent dev.

**Goal.** Add two new exporters to `src/pipeline/export/` that turn a craftmatic `BlockGrid` (or an existing pipeline mesh) into files BambuStudio (and OrcaSlicer / PrusaSlicer, which share the same Slic3r-derived format) opens with **per-block-type colour already assigned to AMS filament slots**. The user opens the file and prints; no manual painting.

The fix solves the only remaining gap in the print path: today `glb-print.ts` writes a structurally-correct multi-group glTF, but BambuStudio drops every glTF colour and treats the whole part as filament 1. Bambu's own format carries the per-volume extruder index that the slicer reads on import.

---

## 1. Scope

| | In scope | Out of scope |
|---|---|---|
| Geometry | A list of `MeshInput` from `glb-writer.ts`, one per colour group | Generating the geometry (already done elsewhere) |
| Format | `.3mf` (Bambu/Slic3r flavour) and `.stl` (multi-file) | `.gcode.3mf` (sliced bundle — slicer's job, not ours) |
| Colour | Per-volume filament index (1..16) | Per-triangle paint (advanced; see §6.B for the future hook) |
| Targets | BambuStudio ≥ 02.00, OrcaSlicer ≥ 2.0, PrusaSlicer ≥ 2.7 | Cura, Simplify3D (don't read Slic3r metadata) |

Caller already has:
- `meshes: MeshInput[]` — one per colour group, vertices + indices, optional `groupName`.
- A parallel `filamentMap: number[]` — `filamentMap[i]` is the 1-indexed filament slot for `meshes[i]`. Out-of-range values clamp to 1.

The exporter does NOT pick filaments itself. Mapping block-name → filament index belongs in a separate module (`src/pipeline/export/filament-map.ts`, also new — see §7).

---

## 2. How BambuStudio actually assigns colours (RE summary)

Read directly from `bs-bionic/src/libslic3r/Format/bbs_3mf.cpp`:

There are **two** layered mechanisms. Both write into the `.3mf` ZIP. Both can coexist on the same model. **Per-volume is what we need; per-triangle is documented for completeness.**

### 2.A Per-volume `extruder` (the one we use)

Each `ModelObject` contains one or more `ModelVolume`s (think: separate watertight meshes that share a transform). Each `ModelVolume` may carry a config dict; the slicer reads `extruder=N` (1-indexed) from it and routes that volume's perimeters + infill to filament slot N.

Storage:

- `3D/3dmodel.model` — vanilla 3MF geometry, one `<object>` per `ModelObject`. Volumes don't appear here directly; the whole object's mesh is one `<triangles>` block with the volumes stitched together. The volume boundaries are recovered from `Metadata/model_settings.config`.
- `Metadata/model_settings.config` — Bambu/Slic3r's sidecar XML. Per-volume `<part>` blocks reference triangle ranges (`firstid` / `lastid`) inside the object's mesh and carry the `extruder` metadata. **This is where the colour assignment lives.**

Minimal example (one object, two volumes, two filaments):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1">
  <metadata key="name" value="schematic.schem"/>
  <part id="1" subtype="normal_part">
   <metadata key="name" value="oak_planks"/>
   <metadata key="extruder" value="1"/>
   <mesh_stat face_count="384" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </part>
  <part id="2" subtype="normal_part">
   <metadata key="name" value="cobblestone"/>
   <metadata key="extruder" value="2"/>
   <mesh_stat face_count="612" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </part>
 </object>
</config>
```

The `extruder` value is what BambuStudio shows in the right-side "Filaments" panel. The user sees "oak_planks → AMS slot 1, cobblestone → AMS slot 2" automatically.

`firstid`/`lastid` are **OPTIONAL on a single-volume object** but **REQUIRED when there are multiple volumes per object**. They index into the parent object's `<triangles>` list (0-based, inclusive end). When omitted on a single-volume object the slicer assumes the whole mesh.

### 2.B Per-triangle `paint_color` (deferred, but document the encoding)

Each `<triangle>` in `3D/3dmodel.model` may carry `paint_color="<hex>"`. The hex string is a length-prefixed bitmap encoding `EnforcerBlockerType` per (possibly recursively split) sub-triangle.

Encoding (exact, from `Model.cpp:4267-4313`, marked "changing it may break backwards compatibility"):

- The state of each sub-triangle is a 4-bit value in `0..15` (0=NONE, 1=ENFORCER for filament 1, 2=BLOCKER for filament 2, ..., up to filament 15).
- A triangle's bitstream is the concatenation of its 4-bit codes in tree-traversal order.
- The bitstream is written to a hex string **LSB-first per nibble, but the resulting hex digits are then reversed** as the final attribute value. Concretely: `out.insert(out.begin(), digit)` — each digit is prepended.

For a non-split triangle assigned a single filament, the resulting `paint_color` is **just one hex digit** equal to the filament index:

```xml
<triangle v1="0" v2="1" v3="2" paint_color="3"/>   <!-- filament 3 -->
```

We don't write per-triangle paint in v1 — every block-type is its own volume, so per-volume is sufficient. The future hook is in §6.B.

> Per-triangle painting + multiple volumes coexist: Bambu paints each volume in its assigned `extruder` first, then per-triangle `paint_color` overrides where present.

---

## 3. 3MF ZIP layout (minimum viable)

A `.3mf` is a ZIP. BambuStudio is happy with this six-entry minimum:

```
[Content_Types].xml          # MIME map (literal, see §3.1)
_rels/.rels                  # points at 3dmodel.model (literal, see §3.2)
3D/3dmodel.model             # geometry XML (we generate; §3.3)
Metadata/_rels/model_settings.config.rels   # OPTIONAL but BS ≥ 02.06 writes it
Metadata/model_settings.config              # per-volume extruder + names (§3.4)
Metadata/project_settings.config            # OPTIONAL; omit for "import as model"
```

Project-level files (`Metadata/plate_1.png`, `slice_info.config`, `project_settings.config`) make the file a **project bundle**. **Don't write them**; we want plain "open this as a model with colours preset", which lets the user pick their own printer / filaments. BambuStudio will auto-create a fresh plate around our objects on open.

### 3.1 `[Content_Types].xml` (literal, never changes)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
```

If you ever add a thumbnail later, add `<Default Extension="png" ContentType="image/png"/>`.

### 3.2 `_rels/.rels` (literal)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
```

### 3.3 `3D/3dmodel.model`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"
       xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
       requiredextensions="p">
 <metadata name="Application">craftmatic-&lt;version&gt;</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="CreationDate">2026-05-02</metadata>
 <metadata name="ModificationDate">2026-05-02</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex x="1" y="0" z="0"/>
     <vertex x="0" y="1" z="0"/>
     <!-- ... -->
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2"/>
     <!-- ... -->
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>
 </build>
</model>
```

Required pieces:

- **One `<object>` per craftmatic mesh**, **OR** one `<object>` containing one `<triangles>` per volume. Pick one strategy, see §4.
- `unit="millimeter"` — Minecraft blocks are 1 m on a side in real life; a 1:50 scale model means 20 mm per block. Bake the scale into vertex coordinates before writing.
- Triangle winding: counter-clockwise when viewed from outside (3MF spec §4.1.4). Match `glb-writer.ts`.
- Each `<vertex>` must have `x`, `y`, `z` as decimal mm. Use `.toFixed(3)` to keep file size reasonable; sub-µm precision is meaningless on a 0.4 mm nozzle.
- The `<build>` section must reference every visible object. The transform is row-major 4×3 (rotation 3×3 then translation 3×1, space-separated); identity works for our case since we already pre-baked transforms into vertex positions.

### 3.4 `Metadata/model_settings.config`

Two cases:

**Case A — one object per colour, one volume per object** (the recommended layout, see §4):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1">
  <metadata key="name" value="oak_planks"/>
  <part id="1" subtype="normal_part">
   <metadata key="name" value="oak_planks"/>
   <metadata key="extruder" value="1"/>
   <mesh_stat face_count="384" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </part>
 </object>
 <object id="2">
  <metadata key="name" value="cobblestone"/>
  <part id="2" subtype="normal_part">
   <metadata key="name" value="cobblestone"/>
   <metadata key="extruder" value="2"/>
   <mesh_stat face_count="612" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </part>
 </object>
</config>
```

Object ids must match the `<object id=…>` in `3dmodel.model`. Part ids must be unique across the file.

`mesh_stat` is informational; BambuStudio will recompute on load. Filling it with the truthful face count avoids a "this file may be corrupt" warning some users see; setting the other counts to 0 is fine.

**Case B — one object, multiple volumes**: each `<part>` needs `firstid`/`lastid` triangle indices:

```xml
<part id="1" subtype="normal_part" firstid="0" lastid="383">…</part>
<part id="2" subtype="normal_part" firstid="384" lastid="995">…</part>
```

`firstid`/`lastid` are 0-based indices into the parent object's flat triangle list (the order they appear in `<triangles>`). Inclusive end.

### 3.5 `Metadata/_rels/model_settings.config.rels` (optional but write it)

Empty rels file — newer BambuStudio versions emit it for forward-compat:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>
```

---

## 4. Object grouping strategy — pick one

We have two valid layouts. **Default to A; fall back to B only if there's a real reason.**

**A. One object per colour group (RECOMMENDED).**

- Pros: simplest code; user can drag individual colour groups on the build plate independently; no `firstid`/`lastid` arithmetic; matches how BambuStudio's own "Split to objects" command would re-split the file anyway.
- Cons: the schematic is N draggable parts instead of one selectable build. Mitigation: BambuStudio's "Group" command (Ctrl+G) re-glues them in seconds, and the auto-assemble feature treats them as a unit on the plate.

**B. One object containing all colour groups as volumes.**

- Pros: the schematic is one selectable, transformable object. Better for users who want to scale the whole build at once.
- Cons: requires concatenating every mesh into one big triangle stream, then tracking `firstid`/`lastid` per volume; more code; the user can't easily isolate one colour for separate-day prints.

Make the strategy a flag on the public API:

```ts
{ grouping: 'per-colour-object' | 'volumes-in-one-object' }   // default 'per-colour-object'
```

---

## 5. STL fallback (multi-file, the only sane way)

STL has no colour and no metadata — the format is just a list of triangles. The convention every multi-material slicer agrees on:

- Write **one STL per filament group**: `<base>_p1_oak_planks.stl`, `<base>_p2_cobblestone.stl`, …
- Suffix is `_p<N>_<sanitized_name>.stl`. The leading `_p<N>` is what BambuStudio's "Import as multi-material" feature reads to map STL → AMS slot N.
- Also emit a manifest `<base>_assembly.json` that any external tool (or a future Cura recipe) can read:

  ```json
  {
    "base": "schematic",
    "files": [
      { "path": "schematic_p1_oak_planks.stl", "filament": 1, "name": "oak_planks", "triangles": 128 },
      { "path": "schematic_p2_cobblestone.stl", "filament": 2, "name": "cobblestone", "triangles": 204 }
    ],
    "unit": "millimeter",
    "scale": 0.02
  }
  ```

STL writer notes: binary STL only (ASCII is 5–10× larger and BS reads both). 80-byte header (we put `craftmatic v<ver>` in it), uint32 LE triangle count, then 50 bytes per triangle (3× float32 normal, 3× 3× float32 vertex, 2-byte attribute = 0). All little-endian. Compute normals on write as the cross product of two edges, normalised; don't trust upstream normals (they may be unnormalised or zero from index-only meshes).

---

## 6. Module placement & API

### 6.A New files

```
src/pipeline/export/
├── 3mf-bambu.ts              # main exporter
├── 3mf-bambu.test.ts         # unit + integration tests
├── stl-multipart.ts          # multi-file STL exporter
├── stl-multipart.test.ts
├── filament-map.ts           # block-name → filament index policy
├── filament-map.test.ts
└── index.ts                  # re-export buildBambu3MF, writeMultipartStl
```

### 6.B Public API

```ts
// 3mf-bambu.ts
import type { MeshInput } from './glb-writer.js';

export interface Bambu3MFInput {
  /** Mesh per colour group. Each becomes either an object (default) or a
   *  volume in one shared object. */
  readonly meshes: readonly MeshInput[];
  /** Per-mesh filament index (1-indexed). Length must equal meshes.length. */
  readonly filamentMap: readonly number[];
  /** Optional per-mesh display name. Falls back to MeshInput.groupName then
   *  `volume_<i>`. Shown in BambuStudio's outline. */
  readonly names?: ReadonlyArray<string | undefined>;
  /** Default 'per-colour-object'. */
  readonly grouping?: 'per-colour-object' | 'volumes-in-one-object';
  /** Generator string in 3dmodel.model metadata. Default 'craftmatic'. */
  readonly generator?: string;
  /** Scale factor applied to vertex positions before writing. Default 1.
   *  Use 1000 for metres → millimetres, 20 for "1 block = 20 mm at 1:50",
   *  etc. The 3MF unit is always 'millimeter'. */
  readonly scaleToMm?: number;
}

export interface Bambu3MFResult {
  /** Complete .3mf bytes (a ZIP). */
  readonly bytes: Uint8Array;
  /** For tests: the literal 3dmodel.model XML. */
  readonly modelXml: string;
  /** For tests: the literal model_settings.config XML. */
  readonly settingsXml: string;
  /** Forward-compat: `[ { firstid, lastid, filament } ]` per object,
   *  populated only in 'volumes-in-one-object' grouping. */
  readonly volumeRanges: ReadonlyArray<{
    readonly objectId: number;
    readonly firstid: number;
    readonly lastid: number;
    readonly filament: number;
  }>;
}

export function buildBambu3MF(input: Bambu3MFInput): Bambu3MFResult;

// Convenience wrapper that writes to disk and reports the path back.
export async function writeBambu3MF(
  input: Bambu3MFInput,
  outPath: string,
): Promise<{ readonly path: string; readonly bytes: number }>;
```

```ts
// stl-multipart.ts
export interface StlMultipartInput {
  readonly meshes: readonly MeshInput[];
  readonly filamentMap: readonly number[];
  readonly names?: ReadonlyArray<string | undefined>;
  readonly scaleToMm?: number;
  /** Output base path WITHOUT extension. e.g. '/tmp/build/schematic'. */
  readonly basePath: string;
}

export interface StlMultipartResult {
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly filament: number;
    readonly name: string;
    readonly triangles: number;
    readonly bytes: number;
  }>;
  readonly manifestPath: string;
}

export async function writeMultipartStl(input: StlMultipartInput): Promise<StlMultipartResult>;
```

```ts
// filament-map.ts
import type { MeshInput } from './glb-writer.js';

/** Stable, deterministic mapping from MeshInput[] → 1-indexed filament slots.
 *  Ordering: by groupName ASCII order, ties broken by first appearance.
 *  Beyond 16 unique groups the policy collapses to the closest existing slot
 *  by Lab-distance using `MeshInput.baseColorFactor`. */
export function assignFilaments(
  meshes: readonly MeshInput[],
  opts?: { readonly maxSlots?: number },   // default 16
): { readonly filamentMap: number[]; readonly slotInfo: ReadonlyArray<{ readonly slot: number; readonly groupName: string; readonly rgba: readonly [number, number, number, number] }> };
```

The exporter is **deterministic**: same input → byte-identical output. That means:

- No `Date.now()` in metadata — read `CreationDate` from `Bambu3MFInput.creationDate` (optional, default to a spec-supplied constant `'1970-01-01'` so tests compare exactly).
- No randomised UUIDs.
- ZIP entries written in stable order, mtime pinned to `1980-01-01 00:00:00` (the ZIP epoch — `fflate`'s `mtime: 0` does this).
- Use `fflate` for the ZIP (already a dep via `glb-writer.ts`'s neighbours? — verify with `bun pm ls fflate`; if absent, prefer it over `jszip` or `archiver`: smaller, sync API, deterministic).

### 6.C Wire-up to existing pipeline

`src/pipeline/export/glb-print.ts` already produces a structurally-correct `MeshInput[]` keyed by colour group. Add a sibling `bambu3mf-print.ts` that calls `glb-print.ts` for the geometry, then `assignFilaments(...)` + `buildBambu3MF(...)`. The CLI surface in `src/cli.ts` gets one new subcommand:

```bash
npx craftmatic print3mf <input.schem> [-o out.3mf] [--grouping per-colour-object|volumes-in-one-object] [--scale 20]
```

Mirror it with `print-stl` for the multipart STL.

---

## 7. Implementation outline

Order of attack — do not parallelise; each step depends on the previous one's invariants:

1. **Filament-map module first** (`filament-map.ts`).
   - Property tests: stable across permutations of input meshes; clamps over 16; preserves ordering for fewer than 16.
   - No I/O, no XML — purely a function. Fast to test, blocks nothing else.

2. **Pure XML builders**, in-memory, no zipping yet:
   - `buildModelXml(meshes, scaleToMm) → string`
   - `buildSettingsXml(meshes, filamentMap, names, grouping, volumeRanges) → string`
   - Test: golden-file compare against the snippets in §3.3 and §3.4. Snapshot tests with `bun:test` are fine; check in the snapshots so reviewers see XML diffs.

3. **STL writer** — independent of 3MF, can run in parallel with step 4. Binary STL is ~30 lines.
   - Test: round-trip a known-good cube (12 triangles, hand-checked normals) → write → re-parse with a tiny inline reader → vertex sets match.

4. **ZIP packing** (`build3mfZip(parts: Map<string, Uint8Array | string>) → Uint8Array`).
   - One thin wrapper around `fflate.zipSync`. Fixed mtime, fixed entry order, no compression on `[Content_Types].xml`/`.rels` (they're already tiny — pass `level: 0` to `fflate` for those if it matters; default level is fine).

5. **`buildBambu3MF`** stitches the four primitives. ~50 lines.

6. **`writeBambu3MF` + `writeMultipartStl`** add `node:fs/promises.writeFile`. Trivial.

7. **CLI subcommand** — copy-paste from existing `gen` / `render` subcommands; wire to `buildBambu3MF` / `writeMultipartStl`.

8. **End-to-end test** (§8).

---

## 8. Acceptance tests

The exporter is correct when **all four** of these pass. Don't ship without #4.

1. **Unit: golden XML.** `buildModelXml` and `buildSettingsXml` match check-in snapshots for a 2-cube fixture (one cube → filament 1, other → filament 2).
2. **Unit: ZIP byte-stable.** `buildBambu3MF(input)` called twice returns identical bytes (`Buffer.compare === 0`).
3. **Unit: STL round-trip.** Parse the binary STL we just wrote → vertex set equals the input vertex set after dedup.
4. **Integration: BambuStudio actually opens it with colours preset.** Headless path, no GUI required:
   - Use BambuStudio's CLI: `bambu-studio --slice 1 --load-settings <preset> --debug 2 input.3mf -o out/` against a tiny fixture.
   - Parse `out/SuperSlicer.gcode` (or whatever filename BS writes); search for `M620 S<N>A` filament-change codes. Filament 1 should appear exactly when the filament-1 volume is being printed, filament 2 likewise. (The exact M620 op may vary — verify against a hand-sliced reference 3MF first.)
   - Alternative if BS CLI is awkward in CI: run BambuStudio under termux-x11 once, manually load the file, screenshot the right-side filament panel, eyeball that "AMS slot 1" / "AMS slot 2" labels point at the right volumes. Document the screenshot in the PR; subsequent CI uses the unit tests for regression.

Test fixtures live in `src/pipeline/export/__fixtures__/3mf/`:

- `two-cubes.input.json` — `Bambu3MFInput` literal, hand-written.
- `two-cubes.expected.model.xml`, `two-cubes.expected.settings.xml` — golden snapshots.
- `two-cubes.expected.3mf` — golden ZIP byte stream.

---

## 9. Edge cases — handle these explicitly, don't punt

| Case | Action |
|---|---|
| `filamentMap[i] < 1` or `> 16` | Clamp to `Math.min(Math.max(round(v), 1), 16)`. Log once via `console.warn` (NOT in tests — gate behind a non-default `quiet` option). |
| `meshes[i].position` is empty (zero triangles) | Skip the mesh entirely. Don't write an empty `<object>`; BS warns. |
| Two meshes with the same `groupName` | Merge their triangles into one `<object>` (but keep their separate filament indices if those differ — fall through to volumes-in-one-object grouping for that pair only). |
| Vertex coordinate is NaN/Infinity | Throw `Bambu3MFError('non-finite vertex')`. Never silently dropping — silent NaN drops are how meshes lose triangles invisibly. |
| `grouping === 'volumes-in-one-object'` and a mesh has > 4 GiB triangles | Throw — 3MF triangle indices are 32-bit but `firstid`/`lastid` are signed-ish in BS's parser; cap defensively at 2³¹−1. |
| Output path's parent dir missing | `fs.mkdir(..., { recursive: true })` before writing. Match what `glb-print.ts` does. |
| Caller passes `grouping: 'per-colour-object'` AND wants a single-selection-object UX | They can't have both. Document the trade-off in the JSDoc; prefer correctness (per-colour grouping) over UX. |

---

## 10. Future hooks (not now, but design-aware)

- **Per-triangle painting.** When craftmatic gets per-face block painting (not currently exposed), extend `Bambu3MFInput.meshes[i]` with an optional `paintColor: Uint8Array` (one byte per triangle, value 0..15). The XML builder writes `paint_color="<hex>"` per triangle when the byte is non-zero. See §2.B for the encoding.
- **Cut/seam/fuzzy-skin metadata.** Same triangle-attribute pattern. Bambu has `paint_seam`, `paint_fuzzy_skin`, `custom_supports`, `custom_seam`. Same encoding family. Add as optional Uint8Array fields when use-cases land.
- **Project bundles.** The `.gcode.3mf` (with embedded sliced gcode + plate previews) is the slicer's output, not ours. We never write those.
- **MakerWorld direct upload.** Bambu's `print.project_file` MQTT command (see `~/git/x2d/docs/CLOUD_BRIDGE.md`) accepts a `cloud://` URL pointing at a 3MF in OSS. The bridge's `cloud-print` command already takes a path; this exporter feeds it directly.

---

## 11. References

- `~/git/x2d/bs-bionic/src/libslic3r/Format/bbs_3mf.cpp` — the canonical reader/writer. When in doubt about an attribute, this is ground truth.
- `~/git/x2d/bs-bionic/src/libslic3r/Model.cpp:4267-4313` — `paint_color` encoding (the comment says "changing it may break backwards compatibility !!!!!" — don't touch).
- `~/git/x2d/samples/x2d_cloud_print_mira_official.gcode.3mf` — a real BambuStudio-emitted 3MF. Open with `unzip -l` for the file layout, `unzip -p … 3D/3dmodel.model` for the geometry XML, `unzip -p … Metadata/model_settings.config` for the per-volume config. The cleanest reference exemplar.
- 3MF Core spec 1.3: https://3mf.io/specification/
- 3MF Production extension (used by `xmlns:p` above): https://3mf.io/3mf-production-extension/
- Slic3r/PrusaSlicer 3MF flavour (the original, which Bambu forked): see `Slic3r/Format/3mf.cpp` upstream; Bambu added the `paint_fuzzy_skin` and a couple of metadata keys but kept the per-volume + per-triangle grammar.

---

## 12. Done when

- `npx craftmatic print3mf docs/images/castle_steampunk.schem -o out.3mf` produces a valid `.3mf`.
- Opening `out.3mf` in BambuStudio shows each block-type as a separate filament with the right name in the right-side panel — verified on at least one real machine OR via the CLI test in §8.4.
- Unit tests in §8.1–§8.3 are green in CI.
- The CLI subcommand is documented in `README.md` next to `gen`, `render`, etc.
- `craftmatic_improvements.md` (the per-task log at repo root) gets a one-line entry referencing the PR.
