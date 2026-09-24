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
import type { PackProvenance, PipelineStamp, SourceProvenance } from './pipeline-version.js';
import type { AccessScaleRecommendation } from './bedrock-scene-actors.js';

/**
 * `mcpack` is the Bedrock Edition target: a behavior pack of `.mcstructure`
 * files (engine/mcpack.ts). It shares the whole grid-building path with the Java
 * formats and differs only in the encoder, which is the point — the alternative
 * was converting our `.schem` with an external tool, and that hop is where a
 * Java→Bedrock translation loses blocks and block states.
 */
export type SchemWorkerFormat = 'schem' | 'litematic' | 'guide' | 'mcpack' | 'live' | 'mcaddon' | 'display';

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
  vehicleMode?: 'auto' | 'car' | 'plane' | 'boat' | 'static';
  /** Number of passenger seats (1 for single driver, 2+ for co-pilot/passengers). */
  seatCount?: number;
  /** Cuboid budget for brick-compiled vehicle entities (ldraw-part-prototype.ts). */
  entityQuality?: 'balanced' | 'high' | 'ultra';
  /** Ground-vehicle chase camera style for the .mcaddon (default orbit). */
  cameraStyle?: 'orbit' | 'boom';
  /**
   * `.mcaddon`: distance level of detail for the shell/vehicle entities
   * (`engine/bedrock-lod-hull.ts`). `hull` (the default since the 2026-09-19 device
   * round verified the switch) adds a resident per-colour surface hull (+3-10 %
   * cuboids per entity) drawn past `lodDistance`; `none` ships the pre-LOD bytes.
   */
  lod?: 'none' | 'hull';
  /** `.mcaddon`: camera distance at which an LOD entity switches to its hull (default 32 blocks; measured switch 26-28 on the Pixel). */
  lodDistance?: number;
  /** `.mcaddon`: leave out the figures / second vehicle found beside the main vehicle. */
  mainVehicleOnly?: boolean;
  /**
   * `.mcaddon`: how the building (everything that is not a vehicle) is shown.
   * `bricks` (the default) compiles its parts as a static entity at the
   * vehicle pipeline's fidelity over invisible colliders; `blocks` ships the
   * coloured block structure as before.
   */
  buildingFidelity?: 'bricks' | 'blocks';
  /**
   * `.mcaddon`: the model scale as a multiplier of the minifig scale
   * (engine/addon-scale.ts). It MUST equal `LDU_PER_BLOCK / options.cellLDU`
   * of the brick source, so the entities land on the block grid; the caller
   * (ui/schem-export.ts, scripts/_playable_ref.ts) derives both from one plan.
   */
  modelScale?: number;
  /**
   * `.mcaddon`: experimental override for a figure NPC's
   * `minecraft:collision_box.height` (device-919 roaming investigation,
   * `TASKS-BEDROCK-ADDON.md`). Default: computed per figure, clamped to
   * 1.0-1.8; see `figureBehavior` in `playable-addon.ts`.
   */
  figureCollisionHeight?: number;
  /**
   * `.mcpack` / `.mcaddon`: the export pipeline's identity (pipeline-version.ts),
   * shown in the pack NAME and written to `craftmatic-provenance.json`. The
   * main thread passes the build-injected stamp so the Worker bundle need not
   * carry the define; a CLI passes the stamp it computed from its tree. Absent,
   * the pack builders fall back to `currentPipelineStamp()`.
   */
  pipelineStamp?: PipelineStamp;
  /** `.mcpack` / `.mcaddon`: the model file the bytes came from, with its sha256/12. */
  sourceProvenance?: SourceProvenance | null;
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
  /** The pack's provenance record (`craftmatic-provenance.json`), for the status line. */
  provenance?: PackProvenance;
  /**
   * `.mcaddon`: the measured size at which a player can actually walk through
   * the model (engine/bedrock-scene-actors.ts, `recommendAccessScale`), run
   * over the scene's own part meshes. A RECOMMENDATION carried as data - the
   * export was NOT resized by it - for the settings panel, the status line and
   * the pack's own `craftmatic-diagnostics.json`.
   */
  access?: AccessScaleRecommendation;
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
      // Part geometry unavailable (most parts fell back) → bbox fallback. Judged
      // by the resolver's own fallback count, not by "fewer cells than bricks":
      // at minifig scale (53 LDU cells) a 192-part Senna is ~35 cells and the
      // old test threw the resolved geometry away - with its grid origin, so
      // every component and scene actor then failed to align.
      if (r.grid.countNonAir() > 0 && r.fallbackPartCount < s.bricks.length * 0.5) {
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
    const { buildPlayableAddon, measureCoasterTrain } = await import('./playable-addon.js');
    const { bedrockExportNotes } = await import('./bedrock-export-notes.js');
    const { discoverPlayableComponents, knownScreenAnchors } = await import('./playable-components.js');
    const { discoverSceneActors, applySceneDoors, measureSceneAccess, recommendAccessScale, runtimeDoorCandidates, sceneFloorPoint, sceneGridPoint, yawForFacing } = await import('./bedrock-scene-actors.js');
    const { isTorso } = await import('./ldraw-entity-compiler.js');
    const label = input.packLabel ?? input.packStem ?? 'Imported build';
    const components = [];
    const warnings: string[] = bedrockExportNotes(grid);
    const screens = [];
    const figures: Array<{ bricks: ParsedBrick[]; x: number; y: number; z: number; facingLdu: [number, number]; seatIndex?: number }> = [];
    const seats: Array<{ x: number; y: number; z: number; yaw: number; label: string }> = [];
    const coasterRoutes: import('./bedrock-coaster.js').CoasterRoute[] = [];
    let sceneDoors: import('./bedrock-scene-actors.js').SceneDoor[] = [];
    let interactionNote: string | undefined;
    /** The measured walk-through size (see `measureSceneAccess` below); undefined when no scene was discovered. */
    let access: AccessScaleRecommendation | undefined;
    let runtimeDoors: import('./bedrock-scene-actors.js').RuntimeDoorCandidate[] = [];
    let shell: { bricks: ParsedBrick[]; frame: NonNullable<typeof sourceOrigin> } | undefined;
    const leafActors: Array<{ bricks: ParsedBrick[]; frame: NonNullable<typeof sourceOrigin>; maxSizeExclusive: number; doorCandidateIndex: number; hideAt100: boolean; door: import('./bedrock-scene-actors.js').SceneDoor }> = [];
    if (input.source.kind === 'bricks') {
      const source = input.source;
      const found = discoverPlayableComponents(source.bricks, label, input.vehicleMode ?? 'auto');
      warnings.push(...found.warnings);
      const movable = new Set<ParsedBrick>();
      for (const component of found.components) for (const brick of component.bricks) movable.add(brick);
      // The building's own life: figures become NPCs, seats sittable, door leaves doors.
      // Vehicle components carry their own figures through the compiler's extras.
      const doorLeaves = new Set<ParsedBrick>();
      if (input.format === 'mcaddon' && !input.mainVehicleOnly) {
        onProgress('finding figures, seats and doors');
        const scene = await discoverSceneActors(source.bricks.filter(b => !movable.has(b)));
        // Figures posed off upright stay in the geometry; say so rather than dropping them silently.
        warnings.push(...scene.warnings);
        // The size at which a player can actually walk through this model, over
        // the same placements the scene was found in (the vehicles are movable
        // and the figures standing in a doorway are not a wall). Costs
        // 0.1-4.6 s per set, which is why it lives HERE, in the Worker, and
        // never in the main-thread settings popover. It is a recommendation
        // and nothing more: the export's size is `input.modelScale`, untouched.
        onProgress('measuring the walk-through size');
        access = recommendAccessScale(measureSceneAccess(source.bricks.filter(b => !movable.has(b)), scene.meshes, { exclude: scene.figureBricks }));
        warnings.push(`Walk-through size: ${access.reason}`);
        if (!sourceOrigin && (scene.figures.length || scene.seats.length || scene.doors.length)) {
          warnings.push('Figures, seats and doors were found but the source geometry did not resolve, so they stay as blocks.');
        } else if (sourceOrigin) {
          const frame = sourceOrigin;
          const { extractCoasterTrackRoutes } = await import('./coaster-track.js');
          const sceneBricks = source.bricks.filter(b => !movable.has(b));
          const tracks = extractCoasterTrackRoutes(sceneBricks, {
            isGeometryAvailable: (_part, brick) => (scene.meshes.get(brick.part)?.triangles.length ?? 0) > 0,
          });
          warnings.push(...tracks.warnings.map(warning => `Coaster: ${warning}`));
          // The set's OWN ride cars, trains and lift, measured from the same
          // placements (coaster-assemblies.ts). Their bricks - the cars, the
          // riders posed in them, the lift platform and its counterweight -
          // become the moving entities and leave the static shell, so nothing
          // is drawn twice. A route with no detected car keeps the fabricated
          // cart below; a short open siding holding a train stays parked.
          const { detectCoasterAssemblies } = await import('./coaster-assemblies.js');
          const { coasterRoutesFromAssemblies } = await import('./bedrock-coaster.js');
          const assemblies = tracks.routes.length ? detectCoasterAssemblies(sceneBricks, scene.meshes, tracks) : undefined;
          if (assemblies) warnings.push(...assemblies.warnings.map(warning => `Coaster: ${warning}`));
          const own = assemblies ? coasterRoutesFromAssemblies(tracks, assemblies, sceneBricks, frame) : undefined;
          const riderBricks = new Set<ParsedBrick>();
          if (own) {
            warnings.push(...own.warnings.map(warning => `Coaster: ${warning}`));
            for (const i of own.movedIndices) movable.add(sceneBricks[i]!);
            for (const i of own.riderIndices) riderBricks.add(sceneBricks[i]!);
            for (const route of own.routes) {
              if (!route.vehicles) continue;
              const riders = route.vehicles.filter(car => car.rider.length).length;
              warnings.push(`Coaster: ${route.label} runs the set's own ${route.vehicles.length} car${route.vehicles.length === 1 ? '' : 's'} (${route.vehicles.map(car => car.chassis.replace(/\.dat$/i, '')).join(', ')}; ${riders} posed rider${riders === 1 ? '' : 's'} aboard${route.lift ? `; ${route.lift.kind} lift` : ''}).`);
            }
          }
          // The train is measured from the riders the source posed OFF upright
          // (nose-down on a drop, hanging in a loop): a figure a Bedrock actor
          // cannot stand in for is, on a coaster, a figure sitting in a car.
          // Their torso placements are the car positions — the cluster centre
          // shifts with hair and held items (10303: 115 LDU by centre, exactly
          // 120 by torso). Upright figures near the track are NOT riders here:
          // a queue on the platform would lengthen the train.
          const riderAnchors = scene.posedFigures.map(f => {
            const torso = f.bricks.find(b => isTorso(b.part, scene.meshes.get(b.part)?.description ?? ''));
            return sceneGridPoint(frame, torso ? [torso.x, torso.y, torso.z] : f.centreLdu);
          });
          // A seated rider's torso sits about 50 LDU off the running line on
          // 10303; 80 LDU admits larger cars and still rejects the next track over.
          const riderMaxOffset = 80 * frame.scale / Math.min(frame.cellXZ, frame.cellY);
          const plainRoutes: import('./bedrock-coaster.js').CoasterRoute[] = own ? own.routes : tracks.routes.map(route => ({
            label: route.label, closed: route.closed, points: route.points.map(point => sceneGridPoint(frame, [...point])),
            maxSegmentLength: route.maxSegmentLengthLdu * frame.scale / Math.min(frame.cellXZ, frame.cellY),
          }));
          for (const route of plainRoutes) {
            // The set's own cars ARE the train; only a route without them is
            // measured from its posed riders and given the fabricated cart.
            if (route.vehicles) { coasterRoutes.push(route); continue; }
            const train = measureCoasterTrain({ points: route.points, closed: route.closed }, riderAnchors, riderMaxOffset);
            if (train) warnings.push(`Coaster: ${route.label} carries a measured train of ${train.count} cars at a ${train.spacing}-block pitch (${train.riders} posed rider${train.riders === 1 ? '' : 's'} on the track; pitches ${train.pitches.join(', ')}).`);
            coasterRoutes.push({ ...route, ...(train ? { cars: { count: train.count, spacing: train.spacing } } : {}) });
          }
          // A figure's feet and a seat's surface are grounded on the model's
          // UNDERSIDE (`scene.groundLdu`, the pin plane the shell and the
          // colliders stand on), not on the voxel grid's row-0 bottom: the
          // voxelizer's surface pass rounds a thin baseplate into row 0, so the
          // grid put the chalet's figures at y -0.15 - one plate under the pin
          // plane, and inside the grass at 400 % (2026-09-21). Doors keep
          // `sceneGridPoint`: they are cut into the block grid itself.
          for (const f of scene.figures) {
            // A figure seated in a ride car (upright in a station, 10261) rides
            // in that car's entity, not as a wandering NPC.
            if (f.bricks.some(b => riderBricks.has(b))) continue;
            const p = sceneFloorPoint(frame, scene.groundLdu, [f.centreLdu[0], f.floorLdu, f.centreLdu[2]]);
            figures.push({ bricks: f.bricks, x: p[0], y: p[1], z: p[2], facingLdu: f.facingLdu, ...(f.seatIndex !== undefined ? { seatIndex: f.seatIndex } : {}) });
            for (const brick of f.bricks) movable.add(brick);
          }
          for (const s of scene.seats) {
            const p = sceneFloorPoint(frame, scene.groundLdu, s.surfaceLdu);
            seats.push({ x: p[0], y: p[1], z: p[2], yaw: yawForFacing(s.facingLdu), label: `Seat (${s.part})` });
          }
          sceneDoors = scene.doors;
          runtimeDoors = runtimeDoorCandidates(sceneDoors, frame);
          if (sceneDoors.length && !runtimeDoors.length) {
            interactionNote = 'A measured source door leaf remains under the two-block vanilla clearance even at 400%, so the wand will not claim a usable door.';
            warnings.push(`Interactive doors: ${interactionNote}`);
          }
          // A leaf usable at 100% is represented by the vanilla door in the
          // structure. A smaller but runtime-usable leaf must be partitioned
          // out of the monolithic shell so its exact geometry can disappear
          // at the same size where the vanilla permutation takes over.
          for (const d of scene.doors) {
            const candidate = runtimeDoorCandidates([d], frame)[0];
            if (!candidate || !d.brick) continue;
            const doorCandidateIndex = runtimeDoors.findIndex(runtime => runtime.requiredSize === candidate.requiredSize && Math.abs(runtime.x - candidate.x) < 1e-6 && runtime.y === candidate.y && Math.abs(runtime.z - candidate.z) < 1e-6);
            if (doorCandidateIndex < 0) continue;
            doorLeaves.add(d.brick);
            // Even a 100%-usable leaf needs its source geometry at the smaller
            // 25/50/75% wand steps, where the structure is replaced by scaled
            // colliders and a vanilla two-block door no longer fits.
            leafActors.push({ bricks: [d.brick], frame, maxSizeExclusive: candidate.requiredSize, doorCandidateIndex, hideAt100: false, door: d });
          }
        }
      }
      // Brick-accurate building: every placement that is not a vehicle, a
      // figure or a door leaf is the shell's (bedrock-building-shell.ts).
      if (input.format === 'mcaddon' && (input.buildingFidelity ?? 'bricks') === 'bricks' && sourceOrigin) {
        const shellBricks = source.bricks.filter(b => !movable.has(b) && !doorLeaves.has(b));
        if (shellBricks.length) shell = { bricks: shellBricks, frame: sourceOrigin };
      } else if (input.format === 'mcaddon' && (input.buildingFidelity ?? 'bricks') === 'bricks' && !sourceOrigin && source.bricks.some(b => !movable.has(b))) {
        warnings.push('The building is exported as blocks: its part geometry did not resolve, so no brick-accurate shell could be compiled.');
      }
      for (const component of found.components) {
        onProgress(`preparing ${component.label}`);
        if (component.bricks.length === source.bricks.length) {
          components.push({ ...component, grid, bricks: component.bricks });
          grid = new BlockGrid(grid.width, grid.height, grid.length);
          continue;
        }
        const part = await voxelizeLDrawGeometry(component.bricks, profile.colorFn(source.colorSpace), source.options, onProgress);
        if (!sourceOrigin || !part.gridOrigin) throw new Error('Component alignment requires resolved source geometry.');
        const a = sourceOrigin, b = part.gridOrigin;
        const dx = (b.x - a.x) * a.scale, dy = (b.y - a.y) * a.scale, dz = (b.z - a.z) * a.scale;
        const ratio = a.scale / b.scale;
        components.push({ ...component, grid: part.grid, sceneScale: ratio, x: dx + part.grid.width * ratio / 2, y: dy, z: dz + part.grid.length * ratio / 2, bricks: component.bricks });
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
      if (sceneDoors.length && sourceOrigin) {
        onProgress('cutting doorways and hanging doors');
        const hungDoors = new Set<import('./bedrock-scene-actors.js').SceneDoor>();
        const d = applySceneDoors(grid, sceneDoors, sourceOrigin, hungDoors);
        for (const leaf of leafActors) leaf.hideAt100 = hungDoors.has(leaf.door);
        if (d.doors) warnings.push(`${d.doors} door${d.doors === 1 ? '' : 's'} hung in ${sceneDoors.length - d.skippedSmall - d.skippedOutside} doorway${sceneDoors.length - d.skippedSmall - d.skippedOutside === 1 ? '' : 's'} (leaf cells opened: ${d.leavesCleared}, passage cells opened: ${d.passageCleared}${d.unreachable ? `, ${d.unreachable} with no room within three blocks` : ''}).`);
        if (d.skippedSmall) warnings.push(`${d.skippedSmall} door leaf${d.skippedSmall === 1 ? '' : 'ves'} under two blocks tall left as blocks.`);
        if (d.skippedOutside) warnings.push(`${d.skippedOutside} door leaf${d.skippedOutside === 1 ? '' : 'ves'} fell outside the export bounds.`);
      }
      if (sourceOrigin) for (const anchor of knownScreenAnchors(label)) {
        const [x, y, z] = sceneGridPoint(sourceOrigin, [anchor.ldraw[0], anchor.ldraw[1], anchor.ldraw[2]]);
        screens.push({ id: anchor.id, label: anchor.label, x, y, z });
      }
    }
    const pack = await buildPlayableAddon(grid, { stem: input.packStem ?? 'model', label, vehicleMode: input.vehicleMode, vehicleFacing: input.vehicleFacing, seatCount: input.seatCount, entityQuality: input.entityQuality, cameraStyle: input.cameraStyle, lod: input.lod ?? 'hull', lodDistance: input.lodDistance, mainVehicleOnly: input.mainVehicleOnly, modelScale: input.modelScale, figureCollisionHeight: input.figureCollisionHeight, components: components.length ? components : undefined, screens, figures, seats, shell, ...(coasterRoutes.length ? { coasterRoutes } : {}), ...(leafActors.length ? { leafActors: leafActors.map(({ door: _door, ...leaf }) => leaf) } : {}), ...(interactionNote ? { interactionNote } : {}), ...(access ? { access } : {}), ...(runtimeDoors.length ? { runtimeDoorCandidates: runtimeDoors } : {}), ...(input.pipelineStamp ? { pipelineStamp: input.pipelineStamp } : {}), ...(input.sourceProvenance !== undefined ? { source: input.sourceProvenance } : {}), onProgress });
    return { grid, bytes: pack.bytes, nonAir, lights, shapes: shapeStats, elements: elementStats, detailMaterials: detailStats, mcpack: { functionCommand: pack.functionCommand, tileCount: pack.tileCount, unmapped: [], warnings: [...warnings, ...pack.warnings], components: pack.components.map(c => `${c.label} (${c.kind})`), provenance: pack.provenance, ...(access ? { access } : {}) } };
  }

  if (input.format === 'mcpack') {
    // Bedrock: same grid, different (little-endian, per-tile) encoder.
    const { buildMcpack } = await import('./mcpack.js');
    const { bedrockExportNotes } = await import('./bedrock-export-notes.js');
    const pack = await buildMcpack(grid, {
      stem: input.packStem ?? 'model',
      ...(input.packLabel ? { label: input.packLabel } : {}),
      ...(input.pipelineStamp ? { pipelineStamp: input.pipelineStamp } : {}),
      ...(input.sourceProvenance !== undefined ? { source: input.sourceProvenance } : {}),
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
        provenance: pack.provenance,
      },
    };
  }

  if (input.format === 'display') {
    const { buildDisplayEntitiesFunction, ldrawToDisplayEntities } = await import('./display-entities.js');
    onProgress('generating Java block_display entities');
    const tag = (input.packStem ?? 'craftmatic_model').replace(/[^a-zA-Z0-9_]/g, '_');
    const res = input.source.kind === 'bricks' && input.source.bricks.length > 0
      ? ldrawToDisplayEntities(input.source.bricks, { tag })
      : buildDisplayEntitiesFunction(grid, { tag });
    return {
      grid,
      bytes: new TextEncoder().encode(res.mcfunction),
      nonAir,
      lights,
      lightFill,
      shapes: shapeStats,
      elements: elementStats,
      detailMaterials: detailStats,
      mcpack: {
        functionCommand: res.spawnCommand,
        tileCount: res.boxCount,
        unmapped: [],
        warnings: [],
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
