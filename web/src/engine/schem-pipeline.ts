/**
 * THE shared Minecraft-export pipeline — one implementation for every tab.
 *
 * Two sources feed it:
 *   • `bricks` — a parsed LDraw model (LEGO tab): voxelize → close 1-cell gaps
 *     → [optional light fill] → NBT → gzip.
 *   • `grid`   — a BlockGrid that already exists (Upload tab, generator, tiles):
 *     [optional light fill] → NBT → gzip. No voxelization, no gap fill; the
 *     grid IS the model and re-voxelizing it would be lossy.
 *
 * It runs in `schem-worker.ts` (off the main thread — see S3: 85 s of blocked
 * main thread and a 1.33 GB allocation peak) and, unchanged, inline when a
 * Worker can't be constructed. Both callers go through `ui/schem-export.ts`;
 * nothing else may re-implement voxelize/encode.
 *
 * BYTE-IDENTITY: with the shipped defaults (auto resolution, default profile,
 * light fill OFF) the bricks path is exactly the pre-S4 sequence — same
 * functions, same order, same `undefined` colorFn for LDraw-space models. The
 * 21063 reference sha256 gate depends on it.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { voxelizeLDrawGeometry, seedDatTexts } from './ldraw-geometry.js';
import { voxelizeLDraw, fillSingleVoxelGaps, type VoxelizeOptions, type VoxelizeResult } from './ldraw-voxelizer.js';
import { encodeSchemBytes, encodeLitematicBytes } from './schem-encode.js';
import { addInteriorLights, type LightFillResult } from './light-fill.js';
import { applyBlockShapes, type ShapeHints, type ShapeStats } from './block-shapes.js';
import { applyDetailMaterials, type DetailMaterialsStats } from './schem-detail.js';
import { applyPartElements, type ElementStats } from './part-elements.js';
import { getBlockProfile, type BrickColorSpace } from './block-profiles.js';
import { BlockGrid } from '@craft/schem/types.js';
import type { BlockEntity } from '@craft/types/index.js';

/**
 * `mcpack` is the Bedrock Edition target: a behavior pack of `.mcstructure`
 * files (engine/mcpack.ts). It shares the whole grid-building path with the Java
 * formats and differs only in the encoder, which is the point — the alternative
 * was converting our `.schem` with an external tool, and that hop is where a
 * Java→Bedrock translation loses blocks and block states.
 */
export type SchemWorkerFormat = 'schem' | 'litematic' | 'guide' | 'mcpack' | 'live' | 'mcaddon';

/** A parsed LDraw model that still needs voxelizing. */
export interface BrickSource {
  kind: 'bricks';
  bricks: ParsedBrick[];
  /** Which colour table to resolve brick colour ids through (CLAUDE.md "Color systems"). */
  colorSpace: BrickColorSpace;
  options: VoxelizeOptions;
}

/** An already-voxelized grid, transferred as raw parts (see BlockGrid.fromRaw). */
export interface GridSource {
  kind: 'grid';
  width: number;
  height: number;
  length: number;
  data: Uint16Array;
  palette: string[];
  blockEntities?: BlockEntity[];
}

export type SchemSource = BrickSource | GridSource;

export interface SchemWorkerInput {
  source: SchemSource;
  format: SchemWorkerFormat;
  /** Block-mapping profile id (block-profiles.ts). */
  profile: string;
  /** Light up enclosed interiors after voxelization. */
  lightFill: boolean;
  lightCoverage?: 'sealed' | 'covered';
  lightStyle?: 'profile' | 'lantern' | 'sea_lantern';
  lightSpacing?: number;
  vehicleFacing?: 'auto' | '+x' | '-x' | '+z' | '-z';
  /**
   * Refine solid cells into partial Minecraft blocks (slabs, stairs) where the
   * geometry is genuinely partial — engine/block-shapes.ts. Bricks only: a grid
   * source is already blocks and carries no occupancy to refine from.
   * `false` reproduces the pre-2026-09-08 all-cubes output byte for byte.
   */
  shapes: boolean;
  /** Smooth slopes into tonally-matched stairs/slabs (HotSchem detail engine). */
  detailMaterials?: boolean;
  /** Absolute origin for /ldraw-parts fetches inside the worker (bricks only). */
  ldrawBase?: string;
  /**
   * Part name → `.dat` text already resolved on the main thread (`null` = a
   * known-definitive miss). Seeds the geometry resolver so exporting a model
   * that is already loaded and rendered fetches NOTHING. Bricks only; anything
   * absent from the map is fetched as before (with progress).
   */
  datTexts?: ReadonlyMap<string, string | null>;
  /**
   * Filename stem for the Bedrock pack (`format: 'mcpack'`). It becomes the
   * pack's display name, its structure identifiers and its deterministic
   * manifest UUIDs, so the same set always re-imports as an UPDATE rather than a
   * second pack with the same name.
   */
  packStem?: string;
  /** Human label for the pack (`Colosseum (10276)`); defaults to `packStem`. */
  packLabel?: string;
  /** Explicit whole-model vehicle override; auto preserves scenery. */
  vehicleMode?: 'auto' | 'car' | 'plane' | 'static';
}

/** What a Bedrock `.mcpack` export produced, for the status line. */
export interface McpackSummary {
  warnings?: string[];
  components?: string[];
  /** Short `/function` command that gives the model's BrickWand. */
  functionCommand: string;
  /** One `.mcstructure` per entry. */
  tileCount: number;
  /** Java block ids with no Bedrock equivalent (written as air). */
  unmapped: string[];
}

export type SchemWorkerOutput =
  | { type: 'progress'; phase: string; pct?: number }
  | {
      type: 'result';
      /** schem/litematic: the finished gzipped file bytes. */
      bytes?: Uint8Array;
      /** guide: raw grid so the main thread can render the HTML. */
      grid?: { width: number; height: number; length: number; data: Uint16Array; palette: string[] };
      width: number;
      height: number;
      length: number;
      nonAir: number;
      /** Non-zero only when the light-fill option was on. */
      lights: number;
      /** Present only when the block-shape pass ran. */
      shapes?: ShapeStats;
      /** Present only when the semantic-element pass ran (part-elements.ts). */
      elements?: ElementStats;
      /** Present only for `format: 'mcpack'`. */
      mcpack?: McpackSummary;
    }
  | { type: 'error'; message: string };

export type ProgressFn = (phase: string, pct?: number) => void;

export interface SchemPipelineResult {
  grid: BlockGrid;
  gridOrigin?: VoxelizeResult['gridOrigin'];
  bytes?: Uint8Array;
  nonAir: number;
  lights: number;
  lightFill?: LightFillResult;
  /** Non-null only when the block-shape pass ran (bricks source, shapes on). */
  shapes?: ShapeStats;
  /** Non-null only when slope detail materials pass ran. */
  detailMaterials?: DetailMaterialsStats;
  /** Non-null only when a mapped part was small enough for a Minecraft element. */
  elements?: ElementStats;
  /** Non-null only for `format: 'mcpack'`. */
  mcpack?: McpackSummary;
}

/**
 * Build the grid and (unless `format === 'guide'`) encode it.
 * Pure with respect to the DOM — safe in a Worker and in Node tests.
 */
export async function runSchemPipeline(
  input: SchemWorkerInput,
  onProgress: ProgressFn = () => {},
): Promise<SchemPipelineResult> {
  const profile = getBlockProfile(input.profile);
  let grid: BlockGrid;
  let sourceOrigin: VoxelizeResult['gridOrigin'];
  let shapeStats: ShapeStats | undefined;
  let elementStats: ElementStats | undefined;

  if (input.source.kind === 'grid') {
    const s = input.source;
    grid = BlockGrid.fromRaw(s.width, s.height, s.length, s.data, s.palette);
    if (s.blockEntities) grid.blockEntities.push(...s.blockEntities);
  } else {
    const s = input.source;
    const colorFn = profile.colorFn(s.colorSpace);
    const wantShapes = input.shapes === true;
    // Reuse the .dat texts the viewer already downloaded (see seedDatTexts):
    // the model on screen costs zero further network, and `.io` CustomParts —
    // which exist ONLY in the archive and used to hit the AABB box fallback
    // here — now voxelize from their real geometry.
    if (input.datTexts && input.datTexts.size > 0) {
      onProgress('reusing loaded part geometry');
      seedDatTexts(input.datTexts);
    }
    const options: VoxelizeOptions = wantShapes ? { ...s.options, shapes: true } : s.options;
    let hints: ShapeHints | undefined;
    try {
      const r = await voxelizeLDrawGeometry(s.bricks, colorFn, options, onProgress);
      // Near-empty result = part geometry unavailable → bbox fallback.
      if (r.grid.countNonAir() >= s.bricks.length) {
        grid = r.grid;
        sourceOrigin = r.gridOrigin;
        hints = r.shapeHints;
      } else {
        grid = voxelizeLDraw(s.bricks, colorFn, options).grid;
      }
    } catch {
      grid = voxelizeLDraw(s.bricks, colorFn, options).grid;
    }
    onProgress('closing surface holes');
    fillSingleVoxelGaps(grid);
    // AFTER the gap fill, so a cell the fill just added counts as a neighbour:
    // giving up the top half of a cell is only safe when the top half is air.
    if (hints) {
      // Elements first: a window's glass is a pane, not a slab of glass, and
      // the pass zeroes the cells it declines so they still reach the slab
      // rules below.
      if (hints.element) {
        onProgress('placing window panes and fences');
        elementStats = applyPartElements(grid, hints);
      }
      onProgress('shaping partial blocks');
      shapeStats = applyBlockShapes(grid, hints);
    }
  }

  let detailStats: DetailMaterialsStats | undefined;
  if (input.detailMaterials) {
    onProgress('smoothing slopes with detail materials');
    detailStats = applyDetailMaterials(grid, { stairs: true, slabs: false });
  }

  let lightFill: LightFillResult | undefined;
  if (input.lightFill) {
    onProgress('lighting interiors');
    lightFill = addInteriorLights(grid, {
      coverage: input.lightCoverage,
      spacing: input.lightSpacing,
      lightBlock: input.lightStyle === 'sea_lantern' ? 'minecraft:sea_lantern' : profile.lightBlock,
      // A lantern is the partial-block form of a light, so it is only reached
      // when the shape passes are on — with them off the light fill behaves
      // exactly as it did before slice 6.
      ...(input.lightStyle === 'lantern' ? { floorLightBlock: 'minecraft:lantern[hanging=false]' }
        : input.lightStyle === 'sea_lantern' ? { floorLightBlock: 'minecraft:sea_lantern' }
        : input.shapes === true && profile.lightElement ? { floorLightBlock: profile.lightElement } : {}),
    });
  }

  const nonAir = grid.countNonAir();
  const lights = lightFill?.lights ?? 0;
  if (input.format === 'guide') return { grid, gridOrigin: sourceOrigin, nonAir, lights, lightFill, shapes: shapeStats, elements: elementStats, detailMaterials: detailStats };

  if (input.format === 'live') {
    onProgress('preparing live Bedrock delivery');
    const { encodeLiveGrid } = await import('./live-model.js');
    const { bedrockExportNotes } = await import('./bedrock-export-notes.js');
    return { grid, bytes: encodeLiveGrid(grid, input.packLabel ?? input.packStem ?? 'Imported build'), nonAir, lights,
      shapes: shapeStats, elements: elementStats, detailMaterials: detailStats,
      mcpack: { functionCommand: '', tileCount: 0, unmapped: [], warnings: bedrockExportNotes(grid) } };
  }

  if (input.format === 'mcaddon') {
    const { buildPlayableAddon } = await import('./playable-addon.js');
    const { bedrockExportNotes } = await import('./bedrock-export-notes.js');
    const { discoverPlayableComponents, knownScreenAnchors } = await import('./playable-components.js');
    const label = input.packLabel ?? input.packStem ?? 'Imported build';
    const components = [];
    const warnings: string[] = bedrockExportNotes(grid);
    const screens = [];
    if (input.source.kind === 'bricks') {
      const source = input.source;
      const found = discoverPlayableComponents(source.bricks, label, input.vehicleMode ?? 'auto');
      warnings.push(...found.warnings);
      const movable = new Set<ParsedBrick>();
      for (const component of found.components) {
        for (const brick of component.bricks) movable.add(brick);
        onProgress(`preparing ${component.label}`);
        if (component.bricks.length === source.bricks.length) {
          components.push({ ...component, grid });
          grid = new BlockGrid(grid.width, grid.height, grid.length);
          continue;
        }
        const part = await voxelizeLDrawGeometry(component.bricks, profile.colorFn(source.colorSpace), source.options, onProgress);
        if (!sourceOrigin || !part.gridOrigin) throw new Error('Component alignment requires resolved source geometry.');
        const a = sourceOrigin, b = part.gridOrigin;
        const dx = (b.x - a.x) * a.scale, dy = (b.y - a.y) * a.scale, dz = (b.z - a.z) * a.scale;
        const ratio = a.scale / b.scale;
        components.push({ ...component, grid: part.grid, sceneScale: ratio, x: dx + part.grid.width * ratio / 2, y: dy, z: dz + part.grid.length * ratio / 2 });
      }
      if (movable.size > 0 && movable.size < source.bricks.length) {
        // Rebuild scenery from its own source assembly. Subtracting a separate
        // vehicle voxel mask leaves gap-fill/bridge fragments and can erase
        // scenery where the two assemblies touch.
        onProgress('rebuilding scenery without movable components');
        const scenery = await runSchemPipeline({ ...input, format: 'guide',
          source: { ...source, bricks: source.bricks.filter(b => !movable.has(b)) } }, onProgress);
        if (!sourceOrigin || !scenery.gridOrigin) throw new Error('Scenery alignment requires resolved source geometry.');
        grid = alignVoxelGrid(scenery.grid, scenery.gridOrigin, sourceOrigin, grid);
      }
      if (sourceOrigin) for (const anchor of knownScreenAnchors(label)) {
        const a = sourceOrigin;
        screens.push({ id: anchor.id, label: anchor.label,
          x: (anchor.ldraw[0] / a.cellXZ - a.x) * a.scale,
          y: (-anchor.ldraw[1] / a.cellY - a.y) * a.scale,
          z: (anchor.ldraw[2] / a.cellXZ - a.z) * a.scale });
      }
    }
    const pack = await buildPlayableAddon(grid, { stem: input.packStem ?? 'model', label, vehicleMode: input.vehicleMode, vehicleFacing: input.vehicleFacing, components: components.length ? components : undefined, screens, onProgress });
    return { grid, bytes: pack.bytes, nonAir, lights, shapes: shapeStats, elements: elementStats, detailMaterials: detailStats, mcpack: { functionCommand: pack.functionCommand, tileCount: pack.tileCount, unmapped: [], warnings: [...warnings, ...pack.warnings], components: pack.components.map(c => `${c.label} (${c.kind})`) } };
  }

  if (input.format === 'mcpack') {
    // Bedrock: same grid, different (little-endian, per-tile) encoder.
    const { buildMcpack } = await import('./mcpack.js');
    const { bedrockExportNotes } = await import('./bedrock-export-notes.js');
    const pack = await buildMcpack(grid, {
      stem: input.packStem ?? 'model',
      ...(input.packLabel ? { label: input.packLabel } : {}),
      onProgress,
    });
    return {
      grid, bytes: pack.bytes, nonAir, lights, lightFill,
      shapes: shapeStats, elements: elementStats, detailMaterials: detailStats,
      mcpack: {
        functionCommand: pack.functionCommand,
        tileCount: pack.tiles.length,
        unmapped: pack.unmapped,
        warnings: bedrockExportNotes(grid),
      },
    };
  }

  if (input.format !== 'schem' && input.format !== 'litematic') throw new Error(`Unsupported export format: ${input.format}`);
  onProgress(input.format === 'schem' ? 'writing NBT' : 'writing Litematica NBT');
  const bytes = input.format === 'schem' ? encodeSchemBytes(grid) : encodeLitematicBytes(grid);
  return { grid, bytes, nonAir, lights, lightFill, shapes: shapeStats, elements: elementStats, detailMaterials: detailStats };
}

/** Keep separately voxelized assemblies in the original model's coordinate frame. */
export function alignVoxelGrid(source: BlockGrid, from: NonNullable<VoxelizeResult['gridOrigin']>,
  to: NonNullable<VoxelizeResult['gridOrigin']>, bounds: BlockGrid): BlockGrid {
  const result = new BlockGrid(bounds.width, bounds.height, bounds.length);
  for (let y = 0; y < source.height; y++) for (let z = 0; z < source.length; z++) for (let x = 0; x < source.width; x++) {
    const state = source.get(x, y, z);
    if (state === 'minecraft:air') continue;
    const px = Math.round((from.x + x / from.scale - to.x) * to.scale);
    const py = Math.round((from.y + y / from.scale - to.y) * to.scale);
    const pz = Math.round((from.z + z / from.scale - to.z) * to.scale);
    if (px >= 0 && py >= 0 && pz >= 0 && px < result.width && py < result.height && pz < result.length) result.set(px, py, pz, state);
  }
  return result;
}
