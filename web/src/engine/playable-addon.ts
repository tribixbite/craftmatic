import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { createZip } from './zip-utils.js';
import { deterministicUuid, packIdentity, PACK_NAMESPACE, toBedrockIdentifier } from './mcpack.js';
import { currentPipelineStamp, packDisplayName, packProvenance, packVersionAt, provenanceSentence, type PackProvenance, type PipelineStamp, type SourceProvenance } from './pipeline-version.js';
import { BEDROCK_MAX_TILE, encodeMcstructureTile, planStructureTiles } from './mcstructure-encode.js';
import type { PlayableKind, VehicleFacing, VehicleMode } from './playable-components.js';
import { classifyVehicleKind, isWholeVehicleLabel } from './playable-components.js';
import { buildPlacementPackAssets, colliderSourceCells, encodeColliderRuns, placementAlias, visibleBoundsForSizeSteps, withSizeGroups, type PlacementActor, type PlacementColliders } from './bedrock-placement-pack.js';
import { buildPreviewGhost, type PreviewComponentPlacement } from './bedrock-preview-entity.js';
import { CONCRETE_COLORS, encodePngRgba, generateStudBlockPng, generateEntityLegoAtlasPng } from './lego-resource-pack.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { compileLdrawEntityGeometry, type CompiledLdrawGeometry, type EntityExtra, type EntityKind, type LegoGeometryDiagnostics } from './ldraw-entity-compiler.js';
import { BEDROCK_UNITS_PER_LDU, LDU_PER_BLOCK, PLAYER_HEIGHT_BLOCKS } from './lego-scale.js';
import { normaliseYaw, sceneGridPoint, yawForFacing, type AccessScaleRecommendation, type SceneGridFrame } from './bedrock-scene-actors.js';
import { MINIFIG_ANIMATIONS, MINIFIG_BONES, MINIFIG_CLIENT_ANIMATIONS } from './minifig-rig.js';
import { minifigFromSpec } from './minifig-rig.js';
import { minifigWandScript } from './bedrock-minifig-wand.js';
import { MAX_PRINT_LAYERS, MINIFIG_CREATOR_COLOURS, type MinifigLibrarySpec, type MinifigCreatorConfig, type CreatorSlot } from './minifig-creator-types.js';
import { COLLIDER_BLOCK_ID, COLLIDER_BLOCKS_JSON, COLLIDER_HI_STATE, COLLIDER_LO_STATE, COLLIDER_TERRAIN_TEXTURE, LEGO_SHELL_QUALITY, SHELL_FRAME, buildColliderGrid, colliderBlockDefinition, shellBehavior } from './bedrock-building-shell.js';
import type { NoseDirection } from './vehicle-facing.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { generateLegoMaterialSwatch, legoMaterialSwatchName } from './ldraw-entity-atlas.js';
import { resolveLdrawEntityMaterial } from './ldraw-entity-materials.js';
import { buildLodHull, DEFAULT_HULL_CELL_BLOCKS, LOD_CULL_MARGIN_BLOCKS, LOD_EMPTY_GEOMETRY, LOD_EMPTY_GEOMETRY_ID, MIN_LOD_NEAREST_CUBE_BLOCKS, planLodSwitch, RENDER_CULL_BLOCKS_PER_UNIT, RENDER_CULL_MIN_UNITS, type CollisionBox } from './bedrock-lod-hull.js';
import type { PartGeometryProvider } from './ldraw-part-geometry.js';
import type { LegoEntityQualityName } from './ldraw-part-prototype.js';
import { buildCoasterRideAssets, coasterDiagnostics, coasterRuntimeConfig, type CoasterRideAssets, type CoasterRoute } from './bedrock-coaster.js';
import { BALL_INITIALIZE, BALL_PRE_ANIMATION, PINBALL_ZONE_TEXTURE, ballAnimation, ballProperties, consoleAssets, consoleHideAnimation, flipperAnimation, flipperProperties, pinballPropBehavior, pinballRuntimeConfig, pinballScript, pinballZoneTexture, plungerAnimation, plungerProperties, zoneAssets, PINBALL_INTERACT_TEXT, type PinballPlan, type PinballRuntimeConfig } from './bedrock-pinball.js';
import { bedrockJsonText } from './bedrock-json.js';
import { doorwayWalkSummary } from './interactive-walk.js';
import { figureLifeScript, FIGURE_TUNING } from './bedrock-figure-life.js';
import { INTERACTIVE_FAMILY, INTERACTIVE_PROPERTY, OPEN_DEG, PASSAGE_KINDS, SWING_SECONDS, interactiveAnimation, interactiveBehavior, interactiveLangLines, interactiveRig, interactiveRuntimeItem, interactivesScript, interactiveHitboxes, interactiveNoun, separateHitboxes, INTERACTIVE_TURN_PROPERTY, INTERACTIVE_SIZE_PROPERTY, type InteractiveHitboxes, linkSharedDoorways, pairDoubleDoors, planInteractiveColliders, INTERACTIVE_REACH_NOTE, type InteractiveRuntimeConfig, type InteractiveRuntimeItem, type SceneInteractive } from './bedrock-interactives.js';
declare const world: any;
declare const system: any;
declare const ModalFormData: any;
export interface PlayableGridComponent {
    id: string;
    label: string;
    kind: PlayableKind;
    grid: BlockGrid;
    provenance: string;
    /** Convert this independently voxelized grid back to stationary-scene blocks. */
    sceneScale?: number;
    /** Longitudinal source axis; its sign is intentionally not inferred. */
    longitudinalAxis?: 'x' | 'z';
    forwardDirection?: Exclude<VehicleFacing, 'auto'>;
    seatAnchor?: { x: number; y: number; z: number };
    /** Spawn center in the stationary model's block coordinates. */
    x?: number;
    y?: number;
    z?: number;
    bricks?: ParsedBrick[];
}
export interface PlayableScreenAnchor {
    id: string;
    label: string;
    x: number;
    y: number;
    z: number;
}
export interface PlayableAddonOptions {
    stem: string;
    label?: string;
    vehicleMode?: VehicleMode;
    /** Override ambiguous source orientation; auto uses verified metadata or the measured long axis. */
    vehicleFacing?: VehicleFacing;
    /** Number of passenger seats (1 for single driver, 2+ for co-pilot/passengers). Defaults to 1. */
    seatCount?: number;
    /** Exact, separately voxelized source components. Required for a vehicle embedded in a larger build. */
    components?: PlayableGridComponent[];
    screens?: PlayableScreenAnchor[];
    maxTile?: {
        x: number;
        y: number;
        z: number;
    };
    onProgress?: (phase: string, pct?: number) => void;
    /** Part geometry source for brick components; defaults to the shared `.dat` cache. */
    partGeometry?: PartGeometryProvider;
    /** Cuboid budget profile for brick components (default balanced). */
    entityQuality?: LegoEntityQualityName;
    /** Emit Vibrant Visuals texture sets (MER + normal) for brick components. Default true. */
    pbr?: boolean;
    /**
     * Ground-vehicle chase camera: `orbit` (follow_orbit, look input orbits the
     * camera) or `boom` (fixed_boom, camera stays on the vehicle's tail). Both
     * presets ship in the pack; this picks the one the runtime applies.
     */
    cameraStyle?: VehicleCameraStyle;
    /**
     * Ship ONLY the primary vehicle of each component. Off (the default), the
     * separate objects the compiler finds beside it - figures standing on the
     * display base, a service cart, a second vehicle - are exported as their
     * own entities and placed where the source put them: figures wander as
     * minifig NPCs, a wheeled object is rideable, a wheel-less one is a prop.
     */
    mainVehicleOnly?: boolean;
    /** Figures found in the scenery (bedrock-scene-actors.ts), in grid coordinates: each becomes a wandering minifig NPC; one with a `seatIndex` spawns riding that seat. */
    figures?: Array<{ bricks: ParsedBrick[]; x: number; y: number; z: number; facingLdu: [number, number]; seatIndex?: number }>;
    /** Free seats in the scenery, in grid coordinates: each gets an invisible rideable seat entity. */
    seats?: Array<{ x: number; y: number; z: number; yaw: number; label: string }>;
    /** Continuous measured 3D track routes; open routes safely reverse at their ends. */
    coasterRoutes?: CoasterRoute[];
    /** A LEGO pinball machine read from the model (bedrock-pinball.ts): flippers, ball and console become a playable game. */
    pinball?: { plan: PinballPlan; frame: SceneGridFrame };
    /**
     * Brick-accurate building: the scenery's placements (figures and door
     * leaves already taken out) compiled as one static entity over invisible
     * colliders (bedrock-building-shell.ts). `frame` is the voxelizer's grid
     * origin the scenery grid was built with.
     */
    shell?: { bricks: ParsedBrick[]; frame: SceneGridFrame };
    /**
     * The model's moving parts (bedrock-interactives.ts): doors, gates and
     * hatches that open and let the player through, windows and cupboards
     * that open, levers and turnables. Each ships as its own hinged entity on
     * the shell's frame; doorways are cut into the shell's colliders and their
     * closed cells are laid by `scripts/interactives.js`. Needs `shell`.
     */
    interactives?: { items: SceneInteractive[]; frame: SceneGridFrame };
    /** The interactivity stage's per-set report (engine/interactivity-stage.ts), written whole into `craftmatic-diagnostics.json`. */
    interactivityReport?: import('./interactivity-stage.js').InteractivityReport;
    /** Exact source door leaves rendered only below their vanilla-door size threshold. */
    leafActors?: Array<{ bricks: ParsedBrick[]; frame: SceneGridFrame; maxSizeExclusive: number; doorCandidateIndex: number; hideAt100: boolean }>;
    /**
     * Model scale as a multiplier of the minifig scale (engine/addon-scale.ts),
     * default 1. Every brick-compiled entity is authored at
     * `BEDROCK_UNITS_PER_LDU × modelScale` and the figures beside a vehicle are
     * placed at `LDU_PER_BLOCK / modelScale` LDU per block, so they agree with
     * a block grid voxelized at that cell. FIGURES are the exception: their
     * geometry is compiled at `figureModelScale(modelScale)`, never above 1×,
     * so a minifig stays player height in a 2× or 4× export (their POSITIONS
     * still follow the model, so they stand where the source put them).
     */
    modelScale?: number;
    /**
     * Distance level of detail for the brick-compiled shell and vehicle
     * entities: `none` (the default) ships the full model only, `hull` adds a
     * per-colour surface hull (`bedrock-lod-hull.ts`) and switches to it past
     * `lodDistance`.
     *
     * OFF BY DEFAULT ON PURPOSE. The hull is RESIDENT memory on top of the full
     * model (2.5-8 % of an entity's cuboids over the golden packs), the memory
     * ceiling is definition-side (`DEVICE_CUBOID_BUDGET`), and the frame-time
     * win at distance has not yet been measured on a device. Nothing shipped
     * changes byte-for-byte while this is `none`.
     */
    lod?: LodMode;
    /**
     * Camera distance, in blocks, from the NEAREST CUBE of an LOD entity past
     * which it may switch to its hull (default `DEFAULT_LOD_DISTANCE`).
     *
     * Mojang's Molang docs list `query.distance_from_camera` without a unit and
     * do not say whether a render controller's `geometry` field evaluates it.
     * The 2026-09-19 Pixel 8 Pro round settled both: it is evaluated, in blocks,
     * and it measures to the entity's ROOT (`output/device-919/lod/LOD-RESULT.md`).
     * A shell's root is above the model (`originAboveModel`), so 10303's ground
     * track is 45 blocks from it and 68.7 % of the model's skin was past the
     * old bare threshold of 32 — the hull drew for a camera standing at the
     * tracks (user report 2026-09-21). Each entity's controllers therefore
     * switch at `lodDistance + hull.radiusBlocks`, its reach from the root,
     * which puts the camera at least `lodDistance` from every cube — capped
     * under the actor's own render cull (`planLodSwitch`), or the hull is
     * dropped: an entity whose collision box culls it at 64 blocks cannot
     * show a hull switched at 146 (10303, the same day). Set explicitly, the
     * value is honoured as asked and only reported when unreachable.
     */
    lodDistance?: number;
    /**
     * Experimental override for a figure NPC's `minecraft:collision_box.height`
     * (default: computed from the figure's own geometry, clamped to 1.0-1.8
     * blocks — see `figureBehavior`). Added for the chalet "figures do not
     * roam" investigation (`TASKS-BEDROCK-ADDON.md`): 6 of 7 chalet figures
     * never moved under a ~2.25-block ceiling; the working hypothesis is that
     * mob navigation needs two full air cells above a walkable block, which a
     * 1.8-tall box cannot fit under that ceiling. Unlike the normal clamp,
     * this bypasses it entirely so an experiment can go below 1.0.
     */
    figureCollisionHeight?: number;
    /** Compiled minifig creator library. Mini-dolls are rejected until their rig is measured. */
    minifigCreator?: MinifigLibrarySpec;
    /** Optional placement warning computed from semantic door geometry. */
    interactionNote?: string;
    /**
     * The measured size at which a player can walk through this model
     * (`recommendAccessScale`, run by schem-pipeline.ts over the scene's
     * meshes). It is written whole into `craftmatic-diagnostics.json` and its
     * step + reason go to the Brick Wand, which NAMES the step and never
     * applies it: no export changes size on its own.
     */
    access?: AccessScaleRecommendation;
    /** Existing invisible seat type exposed to the brick-wand manual chair placer. */
    manualSeatTypeId?: string;
    /** Small semantic LDraw doors that the placement wand may offer as interactive vanilla doors. */
    /** Grid cells the door pass opened (`applySceneDoors`), kept open by the shell's colliders. */
    colliderKeepClear?: ReadonlySet<number>;
    runtimeDoorCandidates?: Array<{ x: number; y: number; z: number; requiredSize: number; lower: { id: string; states: Record<string, string | number | boolean> }; upper: { id: string; states: Record<string, string | number | boolean> } }>;
    /**
     * The export pipeline's identity (pipeline-version.ts): shown in both pack
     * NAMES and written in full to `craftmatic-provenance.json`. Defaults to the
     * stamp the Vite build injected (`unstamped` under vitest / a bare import);
     * a CLI passes the one it computed from its working tree.
     */
    pipelineStamp?: PipelineStamp;
    /** The model file the pack was built from, with its sha256/12 (the index's convention). `null` when unknown. */
    source?: SourceProvenance | null;
}
/** `hull`: ship a per-colour surface hull beside the full model and switch to it at `lodDistance`. */
export type LodMode = 'none' | 'hull';
/**
 * Default camera-to-nearest-cube distance, in blocks, past which the hull may
 * take over (`PlayableAddonOptions.lodDistance`). The controllers add each
 * entity's reach from its root on top of this.
 *
 * 96, up from 32 (2026-09-21): the hull is a 1-block voxelisation and must only
 * replace detail the viewer cannot resolve. Bedrock's default FOV is 70° over
 * the screen height, so a block at distance D covers H / (2·tan 35°·D) px: on
 * the Pixel 8 Pro's 1344-px-tall landscape screen that is 960 / D. At 32 a
 * hull cell was 30 px and a brick face (20 LDU = 0.375 block at minifig scale)
 * 11 px — brick detail in plain sight was swapped for 30-px voxels. At 96 a
 * hull cell is 10 px and a brick face 3.75 px, under the ~4 px at which brick
 * edges stop resolving on that screen.
 *
 * This is the distance the pack ASKS for. Whether an entity can honour it is
 * decided per entity by `planLodSwitch`: the client stops drawing an actor at
 * a distance set by its `minecraft:collision_box` (a 0.1-box shell at ~64
 * blocks from its root — 10303 vanished between the 60- and 70-block camera
 * stops on 2026-09-21), and the hull is the same actor, so a switch past that
 * cull is never reached. The "drawn at 128 blocks" of the 09-19 round was the
 * Milano, a vehicle with a metre-scale box. `--lod-distance` sets an explicit
 * distance that is honoured as asked, for the device A/B.
 */
export const DEFAULT_LOD_DISTANCE = 96;
export type VehicleCameraStyle = 'orbit' | 'boom';
export interface PlayableAddonResult {
    bytes: Uint8Array;
    functionCommand: string;
    tileCount: number;
    components: Array<{
        id: string;
        label: string;
        kind: PlayableKind | 'screen' | 'figure' | 'prop' | 'seat' | 'shell';
        provenance: string;
    }>;
    warnings: string[];
    /** Geometry diagnostics per brick-compiled entity id (also written into the BP). */
    diagnostics: Record<string, LegoGeometryDiagnostics>;
    /** What built this pack and from which file — the record in `craftmatic-provenance.json`. */
    provenance: PackProvenance;
}
const enc = new TextEncoder();
const text = (s: string) => enc.encode(s.endsWith('\n') ? s : `${s}\n`);
/** Pack JSON: `bedrockJsonText` keeps declared float values as float literals. */
const json = (v: unknown) => text(bedrockJsonText(v, 2));
/**
 * Geometry serializer: MINIFIED, unlike every other file in the pack.
 *
 * `.geo.json` is 98-99 % of a pack's bytes (71043 ultra: 94.35 MB of 95.11 MB)
 * and pretty-printing costs 5.6-5.8x — 1,704-1,802 bytes per cuboid pretty,
 * about 310 minified. Sixteen test packs occupy 469 MB unpacked on a device;
 * minified they are ~82 MB. That is worth having for download size, for
 * storage and for the unzip on import.
 *
 * THIS DOES NOT REDUCE MINECRAFT'S RUNTIME MEMORY, and nothing here should be
 * "optimised" back on the theory that it would. Decisive A/B measured
 * 2026-09-18 on a Pixel 8 Pro (Bedrock 1.26.51.1): the SAME pack, identical
 * cuboids, shipped pretty (131.7 MB of JSON) and minified (23.0 MB) settled at
 * 947,571 kB vs 951,340 kB of native allocation - 0.4 % apart, the minified
 * one very slightly HIGHER. Retained memory tracks CUBOID COUNT
 * (native heap = 739 MB + 3.08 kB per cuboid), not file bytes. The fix for the
 * out-of-memory crash is fewer cuboids (see `DEVICE_CUBOID_BUDGET`), never
 * smaller files.
 *
 * Everything else in the pack stays pretty: manifests, entity definitions,
 * render controllers and `craftmatic-diagnostics.json` total ~0.15 MB and are
 * meant to be read by a human opening the archive.
 */
const geoJson = (v: unknown) => text(bedrockJsonText(v));
const safe = (s: string) => toBedrockIdentifier(s).slice(0, 48);
/**
 * A Bedrock ENTITY identifier's name part may not begin with a digit: the game
 * rejects the whole definition with "identifier cannot begin with a number"
 * and the entity simply does not exist in world. Measured on the device
 * 2026-09-21 — 10303's ride cart and manual seat never spawned, while the 13
 * entities that happened to carry a prefix were fine. Most LEGO set stems ARE
 * numeric, so every entity id must go through here; the per-kind letter keeps
 * ids distinct and matches what already-shipped packs use.
 */
const entityId = (raw: string, prefix: string) => /^[0-9]/.test(raw) ? `${prefix}_${raw}` : raw;
/**
 * Cuboids a phone can hold across ALL active add-on packs at once. Measured
 * 2026-09-18 on a Pixel 8 Pro (11.83 GB RAM, Bedrock 1.26.51.1): a world loads
 * 9 Ultra packs - 258,972 cuboids summed over the active packs, 1.58 GB
 * settled native heap - and dies on the 10th (281,185 cuboids) with
 * `libc++abi: terminating due to uncaught exception of type St9bad_alloc`
 * then `Fatal signal 6 (SIGABRT)`. That is an in-process OOM, not the
 * low-memory killer. Retained cost fits native heap = 739 MB + 3.08 kB per
 * cuboid and predicted three surviving configurations within 2 %.
 *
 * The ceiling is the CUBOID SUM over every active pack, NOT a pack count and
 * NOT a file size: minifying a pack's JSON moves its settled allocation by
 * 0.4 % (see `geoJson`). `maxModelCubes` caps ONE entity; nothing capped a
 * pack, and one measured pack shipped 82,163 cuboids over 12 entities without
 * a word of warning.
 *
 * Re-measured 2026-09-19 on the same phone with box-UV packs
 * (`output/device-919/ceiling/CEILING.md`): stacking 17 distinct Ultra packs
 * to 487,856 cuboids summed over the active packs loaded and ran at 60 fps
 * (median frame 16.7 ms, three sets placed) with nativePss 2.21 GB and
 * totalPss 2.99 GB - no bad_alloc, no low-memory kill. The slope was
 * 2.4-2.7 kB per cuboid, the on-device confirmation of the box-UV A/B. The run
 * stopped because it ran out of prepared packs, NOT because the device did, so
 * 480,000 is the highest OBSERVED SURVIVAL, not a crash point; the true box-UV
 * ceiling is above it and unmeasured. Only the definition side was exercised
 * (the 14 extra packs were activated, not placed) - the number of cuboids
 * DRAWN at once is a separate limit (~50-100k visible hold 60 fps, ~150k hold
 * 30) that this budget does not express.
 */
export const DEVICE_CUBOID_BUDGET = 480_000;
/** Warn about a pack's size once it is this share of the whole-device budget (fewer than 10 such packs fit). */
const PACK_CUBOID_WARN_SHARE = 0.1;
/** Locale-independent thousands separator, so the warning text is deterministic. */
const grouped = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * What a pack's cuboid total means for the player's device, in the terms they
 * can act in: the share of `DEVICE_CUBOID_BUDGET` it takes and how many packs
 * this size can be active together. `warning` is set only once the pack is a
 * large enough share for that count to matter — below it, the number is still
 * reported in `craftmatic-diagnostics.json`, never silently dropped.
 */
export function packCuboidBudget(label: string, cuboids: number, entities: number): {
    cuboids: number;
    entities: number;
    deviceCuboidBudget: number;
    shareOfDeviceBudget: number;
    packsThatFitTogether: number;
    warning?: string;
} {
    const share = cuboids / DEVICE_CUBOID_BUDGET;
    const fit = Math.floor(DEVICE_CUBOID_BUDGET / Math.max(1, cuboids));
    const out = {
        cuboids, entities,
        deviceCuboidBudget: DEVICE_CUBOID_BUDGET,
        shareOfDeviceBudget: Math.round(share * 1000) / 1000,
        packsThatFitTogether: fit,
    };
    if (share < PACK_CUBOID_WARN_SHARE) return out;
    const size = `${label}: ${grouped(cuboids)} cuboids across ${entities} entit${entities === 1 ? 'y' : 'ies'} - ${Math.round(share * 100)}% of the ~${grouped(DEVICE_CUBOID_BUDGET)}-cuboid budget a phone has for ALL of its add-on packs together (the highest sum a Pixel 8 Pro has survived with box-UV packs, 487,856 cuboids at 60 fps; the crash point is above it and unmeasured. Drawing many sets at once is a separate limit: ~150,000 visible cuboids hold 30 fps).`;
    // 2nd/3rd/4th…: `fit` is at most 10 here, because the warning needs a 10 % share.
    const nth = fit + 1 === 2 ? '2nd' : fit + 1 === 3 ? '3rd' : `${fit + 1}th`;
    return {
        ...out,
        warning: fit < 1
            ? `${size} This pack alone is past the highest sum a phone has been measured to survive; expect the world to run out of memory while it loads. Export at a lower quality, or split the model.`
            : `${size} About ${fit} pack${fit === 1 ? '' : 's'} this size can be active at once; a ${nth} takes the device past the highest sum measured to survive.`,
    };
}

function previewSamples(grid: BlockGrid, limit: number): Array<{ x: number; y: number; z: number }> {
    if (limit < 1) return [];
    const every = Math.max(1, Math.ceil(grid.countNonAir() / limit)), points = [];
    let seen = 0;
    for (let y = 0; y < grid.height; y++) for (let z = 0; z < grid.length; z++) for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air' && seen++ % every === 0 && points.length < limit) points.push({ x: x + .5, y: y + .5, z: z + .5 });
    }
    return points;
}

/**
 * Entity JSON format. `free_camera_controlled` and the seat camera radius need
 * 1.26.30 (the version bedrock-samples' own horse and Happy Ghast declare);
 * the pack's `min_engine_version` is 1.26.40, so nothing older loads it anyway.
 */
export const ENTITY_FORMAT_VERSION = '1.26.30';
/** Camel dash tuned for a car: shorter cooldown, same momentum. */
export const DASH_ACTION = { cooldown_time: 1.5, horizontal_momentum: 20, vertical_momentum: 0.6 } as const;
/** Aircraft component group that turns Jump into DESCEND (negative vertical velocity), and the events that toggle it. */
export const AIRCRAFT_DESCEND_GROUP = 'craftmatic:descending';
/** Aircraft component group holding the normal Jump = CLIMB action; added at spawn and by `descend_off`. */
export const AIRCRAFT_CLIMB_GROUP = 'craftmatic:climbing';
export const AIRCRAFT_DESCEND_ON = 'craftmatic:descend_on';
export const AIRCRAFT_DESCEND_OFF = 'craftmatic:descend_off';
/** Chase-camera boom length from the vehicle's longest side (blocks), 5..30. */
export function chaseRadius(size: { width: number; height: number; length: number }): number {
    const longest = Math.max(size.width, size.length, 1);
    return Math.min(30, Math.max(5, Math.round((longest + 2.5) * 10) / 10));
}

function componentLayout(kind: PlayableKind, grid: BlockGrid, requestedScale = 1, requestedAxis?: 'x' | 'z', requestedFacing: VehicleFacing = 'auto') {
    const scale = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
    const facing = requestedFacing === 'auto' ? undefined : requestedFacing;
    const longitudinalAxis = facing?.endsWith('x') ? 'x' : facing?.endsWith('z') ? 'z' : requestedAxis ?? (kind === 'car' && grid.width >= grid.length ? 'x' : 'z');
    const forwardSign = facing?.startsWith('-') ? -1 : 1;
    const width = (longitudinalAxis === 'x' ? grid.length : grid.width) * scale;
    const length = (longitudinalAxis === 'x' ? grid.width : grid.length) * scale;
    const height = grid.height * scale;
    // The world yaw at which the compiled entity's nose points along its LDraw
    // nose in the grid: the entity at yaw 0 faces world +Z, and the grid is
    // LDraw turned half a turn about X (`sceneGridPoint`: world Z is LDraw −Z),
    // so an LDraw −Z nose is yaw 0, +Z is 180, ±X keep ∓90 (`yawForFacing`).
    const actorYaw = yawForFacing(longitudinalAxis === 'x' ? [forwardSign, 0] : [0, forwardSign]);
    return { scale, longitudinalAxis, forwardSign, width, length, height, actorYaw };
}

function behaviorEntity(id: string, kind: PlayableKind, grid: BlockGrid, sceneScale?: number, longitudinalAxis?: 'x' | 'z', facing: VehicleFacing = 'auto', seatAnchor?: {x:number;y:number;z:number}, isTimeMachine = false, seatCount = 1, seatPositionOverride?: [number, number, number], collisionBoxOverride?: { width: number; height: number }, entitySize?: { width: number; height: number; length: number }): unknown {
    const layout = componentLayout(kind, grid, sceneScale, longitudinalAxis, facing);
    let seatX: number, seatY: number, seatZ: number;
    if (seatPositionOverride) {
        [seatX, seatY, seatZ] = seatPositionOverride;
        // A model scaled below the player (a 0.38x Mini Cooper is 2.25 blocks tall
        // and 1.9 wide) cannot hold an unscaled 1.8-block rider: the compiler's
        // cockpit seat put the player's arm and shoes through the car's flank on
        // the Pixel (rounds 2026-09-17 and b; the seat's driver-side offset is the
        // flank). Seat such a rider ON the model, centred, legs in the roof line,
        // like a kart: the model must clear the seated player's shoulders (~2.4).
        const modelHeight = entitySize?.height ?? layout.height;
        const modelWidth = entitySize?.width ?? layout.width;
        if (modelHeight < PLAYER_HEIGHT_BLOCKS + 0.6 || modelWidth < 2.2) {
            seatY = Math.max(seatY, Math.round((modelHeight - 0.55) * 100) / 100);
            seatX = 0;
        }
    } else {
        const seat = seatAnchor ?? { x: .5, y: .45, z: .5 };
        const ox = (seat.x - .5) * grid.width * layout.scale, oz = (seat.z - .5) * grid.length * layout.scale;
        // Mojang's vanilla horse geometry establishes -Z as model-forward. Keep
        // the source footprint fixed while its selected nose follows that axis:
        // the seat is authored for `layout.actorYaw` (along Z, a −Z nose is
        // yaw 0 and the grid offset is negated; +Z is yaw 180 and keeps it).
        seatX = layout.longitudinalAxis === 'x' ? layout.forwardSign * oz : layout.forwardSign * ox;
        seatZ = layout.longitudinalAxis === 'x' ? -layout.forwardSign * ox : layout.forwardSign * oz;
        seatY = Math.max(.35, Math.min(layout.height - .35, layout.height * seat.y));
    }
    // Vanilla third-person camera distance for a rider (Happy Ghast: 8 / 6),
    // sized to the vehicle so the player's own camera toggle is usable too.
    // A brick-compiled entity is at player scale (0.2 blocks per stud); the
    // scene grid is 12x that, so its size only stands in for the grid fallback.
    const cameraSeat = { third_person_camera_radius: chaseRadius(entitySize ?? { width: layout.width, height: layout.height, length: layout.length }), camera_relax_distance_smoothing: 6 };
    const rideableComponent: Record<string, unknown> = seatCount <= 1
        ? { seat_count: 1, family_types: ['player'], interact_text: 'action.interact.mount', crouching_skip_interact: true, seats: { position: [seatX, seatY, seatZ], lock_rider_rotation: 0, ...cameraSeat } }
        : {
            seat_count: seatCount,
            controlling_seat: 0,
            family_types: ['player'],
            interact_text: 'action.interact.mount',
            crouching_skip_interact: true,
            seats: (() => {
                const latOffset = Math.min(0.45, Math.max(0.25, layout.width * 0.2));
                const driverX = layout.longitudinalAxis === 'x' ? seatX : seatX - latOffset;
                const driverZ = layout.longitudinalAxis === 'x' ? seatZ + latOffset : seatZ;
                const passX = layout.longitudinalAxis === 'x' ? seatX : seatX + latOffset;
                const passZ = layout.longitudinalAxis === 'x' ? seatZ - latOffset : seatZ;
                const seatList: Array<Record<string, unknown>> = [
                    { min_rider_count: 0, max_rider_count: 1, position: [driverX, seatY, driverZ], lock_rider_rotation: 0, ...cameraSeat },
                    { min_rider_count: 1, max_rider_count: 2, position: [passX, seatY, passZ], lock_rider_rotation: 0, ...cameraSeat },
                ];
                if (seatCount >= 4) {
                    const backZOffset = Math.min(1.2, Math.max(0.6, layout.length * 0.25));
                    seatList.push(
                        { min_rider_count: 2, max_rider_count: 3, position: [driverX, seatY, driverZ + backZOffset], lock_rider_rotation: 0, ...cameraSeat },
                        { min_rider_count: 3, max_rider_count: 4, position: [passX, seatY, passZ + backZOffset], lock_rider_rotation: 0, ...cameraSeat },
                    );
                }
                return seatList;
            })(),
        };
    const common: Record<string, unknown> = {
        'minecraft:type_family': { family: ['craftmatic_vehicle', kind] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        // Bedrock exposes one horizontal diameter, not a rectangular box. Use
        // the transverse body width so a long car can still pass a doorway.
        // Clamp to practical navigation bounds (<= 3.5m wide, <= 2.5m tall) so oversized models
        // can navigate dunes, terrain steps, and doorways without clipping into terrain.
        'minecraft:collision_box': collisionBoxOverride ?? { width: Math.min(3.5, Math.max(0.8, layout.width * .85)), height: Math.min(2.5, Math.max(.8, layout.height * .8)) },
        'minecraft:rideable': rideableComponent,
        // Format 1.26.30 dropped `minecraft:pushable` from the schema (the whole
        // entity then fails to parse - measured on the Pixel's content log);
        // vanilla mobs declare `pushable_by_block` (pistons) and, only when they
        // may be shoved by entities, `pushable_by_entity`. A vehicle is not.
        'minecraft:pushable_by_block': {},
        // Aircraft speed is the Happy Ghast's (movement 0.3, flying_speed 0.083)
        // scaled: at 1.35 the X-wing climbed 206 blocks in about a second on the
        // Pixel (vertical velocity scales with the flying speed).
        'minecraft:movement': isTimeMachine
            ? { value: .02, max: 6 }
            : { value: kind === 'car' ? 1.05 : kind === 'boat' ? 1.15 : .3, max: kind === 'car' ? 1.35 : kind === 'boat' ? 1.5 : .6 },
        // Ridden vanilla mounts (horse, camel, Happy Ghast) are all tamed; the
        // `player_ride_tamed` goal that steers by rider input depends on it.
        'minecraft:is_tamed': {},
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 160, max_dropped_ticks: 7, use_motion_prediction_hints: true } },
    };
    // Ground vehicles follow the vanilla CAMEL: `input_ground_controlled` steers
    // by the rider's yaw and `dash_action` makes the Jump button a native boost
    // (hold to charge, release to dash) instead of a dismount - on touch the
    // rider gets the horse-style Jump + Dismount buttons. A script impulse on a
    // client-authoritative mount was never a reliable boost.
    if (kind === 'car') {
        Object.assign(common, {
            'minecraft:physics': { has_gravity: true, has_collision: true },
            'minecraft:input_ground_controlled': {},
            'minecraft:dash_action': DASH_ACTION,
            'minecraft:behavior.player_ride_tamed': {},
            'minecraft:movement.basic': { max_turn: 18 },
            'minecraft:navigation.walk': { can_path_over_water: true, avoid_damage_blocks: false },
            'minecraft:variable_max_auto_step': { base_value: 1.25, controlled_value: 1.56, jump_prevented_value: .6 },
        });
    } else if (kind === 'boat') {
        Object.assign(common, {
            'minecraft:physics': { has_gravity: true, has_collision: true },
            'minecraft:buoyant': {
                base_buoyancy: 1.0,
                apply_gravity: true,
                simulate_fluid_physics: true,
                liquid_blocks: ['minecraft:water', 'minecraft:flowing_water'],
            },
            'minecraft:input_ground_controlled': {},
            'minecraft:dash_action': DASH_ACTION,
            'minecraft:behavior.player_ride_tamed': {},
            'minecraft:movement.basic': { max_turn: 20 },
            'minecraft:navigation.walk': { can_path_over_water: true, avoid_damage_blocks: false },
            'minecraft:variable_max_auto_step': { base_value: 1.25, controlled_value: 1.56, jump_prevented_value: .6 },
        });
    } else {
        // Aircraft follow the vanilla HAPPY GHAST (bedrock-samples, format
        // 1.26.30): `free_camera_controlled` flies where the rider looks (pitch
        // included), `vertical_movement_action` makes Jump climb, hover
        // movement/navigation keep it airborne with no gravity.
        Object.assign(common, {
            'minecraft:physics': { has_gravity: false, has_collision: true },
            'minecraft:can_fly': {},
            'minecraft:jump.static': {},
            'minecraft:movement.hover': {},
            'minecraft:navigation.hover': { can_path_over_water: true, avoid_damage_blocks: false },
            'minecraft:free_camera_controlled': { strafe_speed_modifier: 1, backwards_movement_modifier: .5 },
            'minecraft:flying_speed': { value: .3 },
            // The vertical action lives in the climb/descend GROUPS below, never
            // in the base components: removing a group removes its components
            // outright, so a base +0.5 did not come back after one descend and
            // Jump then dismounted the rider (Pixel round 2026-09-17).
            'minecraft:behavior.player_ride_tamed': { priority: 1 },
            'minecraft:body_rotation_always_follows_head': {},
        });
    }
    // An aircraft's native vertical input is Jump = climb only; the vanilla
    // Happy Ghast descends by LOOKING down, and under the script chase camera
    // that pitch was reported not to reach the entity ("no way to fly
    // downwards"). `vertical_movement_action` with a NEGATIVE velocity moves
    // the entity down on Jump, so the driver script swaps this group in while
    // the rider pulls the stick back and holds Jump (vehicle-driver.js).
    const aircraftGroups = kind === 'plane' ? {
        component_groups: {
            [AIRCRAFT_CLIMB_GROUP]: { 'minecraft:vertical_movement_action': { vertical_velocity: .5 } },
            [AIRCRAFT_DESCEND_GROUP]: { 'minecraft:vertical_movement_action': { vertical_velocity: -.5 } },
        },
        events: {
            'minecraft:entity_spawned': { add: { component_groups: [AIRCRAFT_CLIMB_GROUP] } },
            [AIRCRAFT_DESCEND_ON]: { remove: { component_groups: [AIRCRAFT_CLIMB_GROUP] }, add: { component_groups: [AIRCRAFT_DESCEND_GROUP] } },
            [AIRCRAFT_DESCEND_OFF]: { remove: { component_groups: [AIRCRAFT_DESCEND_GROUP] }, add: { component_groups: [AIRCRAFT_CLIMB_GROUP] } },
        },
    } : {};
    // In-game size steps (bedrock-placement-pack.ts): scale, collision box and the seats together.
    return withSizeGroups(
        { format_version: ENTITY_FORMAT_VERSION, 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: true, is_summonable: true }, ...aircraftGroups, components: common } },
        common['minecraft:collision_box'] as { width: number; height: number },
        rideableComponent,
    );
}
/**
 * A minifig NPC: walks about, opens doors, looks at players, takes no damage.
 * Player-sized (a minifig IS player height at this scale) so it fits the
 * doorways and corridors of a minifig-scale building.
 */
/**
 * The model scale a FIGURE's geometry is compiled at: the model's scale, capped
 * at 1× so a minifig is never a giant. At 1× a standing minifig is
 * `LDU_PER_MINIFIG` = 96 LDU = `PLAYER_HEIGHT_BLOCKS` = 1.8 blocks by the one
 * shared scale (2.03 with hair, measured on the Pixel), i.e. the player's own
 * size - the rule "the minifigs should be capped to always be the same size as
 * a player". Below 1× the figure follows the model (a half-size set keeps
 * half-size figures; only a giant is forbidden). The wand's in-game size
 * steps apply the same cap at runtime (`withSizeGroups`, `playerSized`).
 */
export function figureModelScale(modelScale: number): number {
    return Math.min(1, Number.isFinite(modelScale) && modelScale > 0 ? modelScale : 1);
}

/** A figure NPC's collision box (see `figureBehavior`); its height is what scripts/figures.js keeps clear overhead. */
export function figureCollisionBox(size: { width: number; height: number; length: number }, collisionHeightOverride?: number): { width: number; height: number } {
    // No bigger than the player (0.6 x 1.8), who walks every room and doorway of
    // a minifig-scale build: at 0.9 x 2.0 six of seven chalet figures could not
    // path out of where they spawned (Pixel round 2026-09-17).
    // `collisionHeightOverride` (device-919 roaming experiment) replaces the
    // computed/clamped height outright rather than participating in the
    // 1.0-1.8 clamp, so a below-1.0 experimental value is not clamped back up.
    const height = collisionHeightOverride ?? Math.min(1.8, Math.max(1.0, Math.round(size.height * 10) / 10));
    return { width: Math.min(0.6, Math.max(0.4, Math.round(Math.max(size.width, size.length) * 0.8 * 10) / 10)), height };
}

function figureBehavior(id: string, size: { width: number; height: number; length: number }, collisionHeightOverride?: number): unknown {
    const collision = figureCollisionBox(size, collisionHeightOverride);
    return withSizeGroups({ format_version: ENTITY_FORMAT_VERSION, 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: true, is_summonable: true }, components: {
        'minecraft:type_family': { family: ['craftmatic_figure', 'mob'] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': collision,
        'minecraft:physics': { has_gravity: true, has_collision: true },
        'minecraft:pushable_by_block': {},
        // No members at format 1.26.30: `is_pushable` belonged to the removed
        // `minecraft:pushable`. With them every figure failed to parse on the
        // Pixel ("is not present in the Schema") and the wand aborted on it.
        'minecraft:pushable_by_entity': {},
        'minecraft:movement': { value: 0.18 },
        'minecraft:movement.basic': {},
        'minecraft:navigation.walk': { can_path_over_water: false, avoid_water: true, avoid_damage_blocks: true, can_open_doors: true, can_pass_doors: true, avoid_portals: true },
        'minecraft:jump.static': {},
        'minecraft:can_climb': {},
        'minecraft:behavior.float': { priority: 0 },
        'minecraft:behavior.open_door': { priority: 1, close_door_after: true },
        // WHERE it walks is scripts/figures.js (bedrock-figure-life.ts), not a
        // vanilla stroll: the mob path-finder plans on whole cells and never
        // found a path over the partial-height collider floors (Chalet: 0 of 7
        // roamed), while figures on plain ground strolled 12 blocks off the
        // model under `minecraft:home`. The script plans over the real
        // collision spans, inside the model's footprint and the figure's own
        // floor, and moves it by velocity. Only the head goals stay vanilla.
        'minecraft:behavior.look_at_player': { priority: 7, look_distance: 6, probability: 0.08 },
        'minecraft:behavior.random_look_around': { priority: 8 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 80, max_dropped_ticks: 10, use_motion_prediction_hints: true } },
    // Player-sized at every wand step at or above 100 %: a figure never becomes a giant (SizeGroupOptions).
    } } }, collision, undefined, { playerSized: true });
}

/** A static object beside the vehicle (a service cart without wheels, a crate): solid, immovable, unhurt. */
function propBehavior(id: string, collisionBox: { width: number; height: number }): unknown {
    return withSizeGroups({ format_version: ENTITY_FORMAT_VERSION, 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: true, is_summonable: true }, components: {
        'minecraft:type_family': { family: ['craftmatic_prop'] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': collisionBox,
        'minecraft:physics': { has_gravity: true, has_collision: true },
        'minecraft:pushable_by_block': {},
        'minecraft:knockback_resistance': { value: 1 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 80, max_dropped_ticks: 10, use_motion_prediction_hints: true } },
    } } }, collisionBox);
}

/**
 * The invisible seat: a chair or bench in the build becomes something the
 * player can sit on. No gravity, no collision, unhurt; the rider's origin sits
 * 0.3 blocks under the seat surface so a seated minifig-scale player's eyes
 * (0.96 blocks over the pan) land where the compiler puts a rider's.
 */
function seatBehavior(id: string): unknown {
    const rideable = { seat_count: 1, family_types: ['player', 'craftmatic_figure'], interact_text: 'action.interact.mount', crouching_skip_interact: true, seats: { position: [0, -0.3, 0], lock_rider_rotation: 181 } };
    return withSizeGroups({ format_version: ENTITY_FORMAT_VERSION, 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: true, is_summonable: true }, components: {
        'minecraft:type_family': { family: ['craftmatic_seat'] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': { width: 0.5, height: 0.5 },
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:pushable_by_block': {},
        // A figure the source seated rides too (placement.js addRider); the sit animation plays while it does.
        'minecraft:rideable': rideable,
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 80, max_dropped_ticks: 10, use_motion_prediction_hints: true } },
    // The rider (a player, or a figure capped at player size) does not grow with
    // the build, so the -0.3 offset under the pan is not scaled above 100 %: the
    // seat entity itself is spawned at the SCALED pan (`worldPoint`), and the
    // rider sits 0.3 blocks under it at every size.
    } } }, { width: 0.5, height: 0.5 }, rideable, { playerSized: true });
}
function seatClient(id: string): unknown {
    return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, materials: { default: 'entity_alphatest' }, textures: { default: 'textures/entity/craftmatic_seat' }, geometry: { default: `geometry.${PACK_NAMESPACE}.seat` }, render_controllers: ['controller.render.default'] } } };
}
const SEAT_GEOMETRY = { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: `geometry.${PACK_NAMESPACE}.seat`, texture_width: 2, texture_height: 2, visible_bounds_width: 1, visible_bounds_height: 1, visible_bounds_offset: [0, 0.5, 0] }, bones: [{ name: 'seat', pivot: [0, 0, 0], cubes: [{ origin: [-1, 0, -1], size: [2, 1, 2], uv: [0, 0] }] }] }] };

const mat3 = (m: readonly number[], v: Vec3): Vec3 => [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];
const noseVector = (nose: NoseDirection): Vec3 => nose === '+x' ? [1, 0, 0] : nose === '-x' ? [-1, 0, 0] : nose === '+z' ? [0, 0, 1] : [0, 0, -1];
/** The axis nearest a horizontal LDraw direction. */
export function snapFacing(f: [number, number]): NoseDirection {
    return Math.abs(f[0]) >= Math.abs(f[1]) ? (f[0] < 0 ? '-x' : '+x') : (f[1] < 0 ? '-z' : '+z');
}

/**
 * Where a secondary object stands relative to its primary vehicle's actor:
 * the offset (blocks) and the world yaw it spawns with.
 *
 * Frames, all measured or proven on the Pixel: the compiler's render frame
 * R is right-handed (nose −Z, right +X, up +Y) with `units = (A·p − origin)`;
 * Minecraft's world (X east, Y up, Z south) is right-handed too, and an
 * entity at yaw 0 faces +Z, so a render-frame offset lands in the world at
 * yaw 0 as (−x, y, −z) - a half turn about Y, no mirror. A yaw θ then
 * rotates that with forward = (−sin θ, cos θ). The object's own yaw is the
 * world direction of the LDraw nose its geometry was compiled to.
 */
export function extraPlacement(primary: CompiledLdrawGeometry, extra: EntityExtra, nose: NoseDirection, primaryYaw: number, exactFacingLdu?: [number, number], lduPerBlock = LDU_PER_BLOCK): { dx: number; dy: number; dz: number; yaw: number } {
    const { A, origin } = primary.transform;
    const floorCentre: Vec3 = [extra.centreLdu[0], extra.floorLdu, extra.centreLdu[2]];
    const r = mat3(A, floorCentre);
    const bx = -(r[0] - origin[0]) / lduPerBlock, by = (r[1] - origin[1]) / lduPerBlock, bz = -(r[2] - origin[2]) / lduPerBlock;
    const th = primaryYaw * Math.PI / 180, cos = Math.cos(th), sin = Math.sin(th);
    const dx = bx * cos - bz * sin, dz = bx * sin + bz * cos;
    // A figure's exact torso direction (levelled LDraw, horizontal) beats the snapped nose.
    const nr = mat3(A, exactFacingLdu ? [exactFacingLdu[0], 0, exactFacingLdu[1]] : noseVector(nose));
    const wx0 = -nr[0], wz0 = -nr[2];
    const wx = wx0 * cos - wz0 * sin, wz = wx0 * sin + wz0 * cos;
    return { dx: Math.round(dx * 100) / 100, dy: Math.round(Math.max(0, by) * 100) / 100, dz: Math.round(dz * 100) / 100, yaw: normaliseYaw(Math.atan2(-wx || 0, wz) * 180 / Math.PI) };
}

/**
 * Where a component's entity stands inside the placement, in the MODEL's own
 * blocks: X/Z the footprint centre, Y the component's own FLOOR.
 *
 * Every actor coordinate a pack ships is scaled about the pin by the wand's
 * size factor (`worldPoint` in `bedrock-placement-pack.ts`: `anchor + p × f`),
 * so each one has to be a measurement INSIDE the model - a height above the
 * model's floor plane, which is the same `anchor.y` the structure tiles, the
 * collider grid and the ghost preview all stand on. Y used to default to a
 * constant 1 block: a lift that is not such a height, so the size factor
 * multiplied it and the model left the ground by `(f − 1) × 1` blocks. The
 * Milano 76286 is an aircraft (`has_gravity: false`), so nothing pulled it
 * back down and its landing gear hung 3 blocks up at 400 % - Pixel 8 Pro,
 * world 919, 2026-09-20,
 * `output/device-919/round-2026-09-20/shots/186-milano400-under.jpg`.
 *
 * A component that IS the whole model stands on the model's floor, y = 0, so
 * the ground contact survives every size step and every model scale: both
 * multiply the same zero. A component placed inside a larger scene keeps its
 * own floor height (`schem-pipeline.ts` passes the component grid's offset),
 * which is a real height in the model and so scales correctly with it.
 */
export function componentSpawnPoint(
    component: Pick<PlayableGridComponent, 'x' | 'y' | 'z'>,
    scene: { width: number; length: number },
): { x: number; y: number; z: number } {
    return { x: component.x ?? scene.width / 2, y: component.y ?? 0, z: component.z ?? scene.length / 2 };
}

interface Box {
    x: number;
    y: number;
    z: number;
    sx: number;
    sy: number;
    sz: number;
    state: string;
}
function greedyBoxes(grid: BlockGrid): Box[] {
    const seen = new Uint8Array(grid.totalBlocks);
    const boxes: Box[] = [];
    const at = (x: number, y: number, z: number) => (y * grid.length + z) * grid.width + x;
    for (let y = 0; y < grid.height; y++)
        for (let z = 0; z < grid.length; z++)
            for (let x = 0; x < grid.width; x++) {
                const idx = at(x, y, z), state = grid.get(x, y, z);
                if (seen[idx] || state === 'minecraft:air')
                    continue;
                let sx = 1;
                while (x + sx < grid.width && !seen[at(x + sx, y, z)] && grid.get(x + sx, y, z) === state)
                    sx++;
                let sz = 1, ok = true;
                while (z + sz < grid.length && ok) {
                    for (let xx = x; xx < x + sx; xx++)
                        if (seen[at(xx, y, z + sz)] || grid.get(xx, y, z + sz) !== state) {
                            ok = false;
                            break;
                        }
                    if (ok)
                        sz++;
                }
                let sy = 1;
                ok = true;
                while (y + sy < grid.height && ok) {
                    for (let zz = z; zz < z + sz; zz++)
                        for (let xx = x; xx < x + sx; xx++)
                            if (seen[at(xx, y + sy, zz)] || grid.get(xx, y + sy, zz) !== state) {
                                ok = false;
                                break;
                            }
                    if (ok)
                        sy++;
                }
                for (let yy = y; yy < y + sy; yy++)
                    for (let zz = z; zz < z + sz; zz++)
                        for (let xx = x; xx < x + sx; xx++)
                            seen[at(xx, yy, zz)] = 1;
                boxes.push({ x, y, z, sx, sy, sz, state });
            }
    return boxes;
}
function geometry(id: string, kind: PlayableKind, grid: BlockGrid, sceneScale?: number, longitudinalAxis?: 'x' | 'z', facing: VehicleFacing = 'auto'): {
    value: unknown;
    palette: string[];
    meshIds: string[];
    /** Cuboids this entity ships - the unit the device's add-on memory ceiling is counted in (`DEVICE_CUBOID_BUDGET`). */
    cubeCount: number;
} {
    const boxes = greedyBoxes(grid), cap = 16384;
    if (boxes.length > cap)
        throw new Error(`${id} needs ${boxes.length} geometry cuboids (export budget ${cap}); lower export resolution to preserve the complete model.`);
    const palette = [...new Set(boxes.map(b => b.state))];
    const layout = componentLayout(kind, grid, sceneScale, longitudinalAxis, facing), { scale } = layout;
    const cubes = boxes.map(b => {
        const colorIdx = palette.indexOf(b.state);
        // Map top face to embossed stud tile; sides and bottom to beveled seam tile
        const topFace = { uv: [0, 1 + colorIdx * 16], uv_size: [16, 16] };
        const sideFace = { uv: [16, 1 + colorIdx * 16], uv_size: [16, 16] };
        // Authored for `layout.actorYaw`: along Z a −Z nose (yaw 0) negates the
        // grid offsets, a +Z nose (yaw 180) keeps them; along X unchanged.
        const origin = layout.longitudinalAxis === 'x'
            ? [layout.forwardSign > 0 ? (b.z - grid.length / 2) * 16 * scale : (grid.length / 2 - b.z - b.sz) * 16 * scale,
                b.y * 16 * scale,
                layout.forwardSign > 0 ? (grid.width / 2 - b.x - b.sx) * 16 * scale : (b.x - grid.width / 2) * 16 * scale]
            : [layout.forwardSign < 0 ? (grid.width / 2 - b.x - b.sx) * 16 * scale : (b.x - grid.width / 2) * 16 * scale,
                b.y * 16 * scale,
                layout.forwardSign < 0 ? (grid.length / 2 - b.z - b.sz) * 16 * scale : (b.z - grid.length / 2) * 16 * scale];
        const size = layout.longitudinalAxis === 'x'
            ? [b.sz * 16 * scale, b.sy * 16 * scale, b.sx * 16 * scale]
            : [b.sx * 16 * scale, b.sy * 16 * scale, b.sz * 16 * scale];
        return { origin, size, uv: { north: sideFace, south: sideFace, east: sideFace, west: sideFace, up: topFace, down: sideFace } };
    });
    // Each render controller owns a small mesh. A single 8,000-cube mesh can
    // exceed 16-bit vertex/index ranges on mobile renderers (24 vertices/cube).
    // Partitioning preserves every cube and its coordinates without decimation.
    const meshIds: string[] = [], meshes = [];
    const atlasW = 32;
    const atlasH = 1 + palette.length * 16;
    // The cubes above are centred on the entity position in X/Z and stand on
    // y = 0, so this is the model's AABB in blocks. Each chunk declares the
    // WHOLE model's culling box, not its own slice: a chunk's cubes can sit
    // anywhere in the model, and chunks culled independently would tear the
    // build apart. `visibleBoundsForSizeSteps` widens it to the largest wand
    // size step, which `minecraft:scale` cannot do at runtime.
    const cullingBounds = visibleBoundsForSizeSteps({
        min: [-layout.width / 2, 0, -layout.length / 2],
        max: [layout.width / 2, layout.height, layout.length / 2],
    }, 1);
    for (let offset = 0; offset < cubes.length; offset += 1024) {
        const meshId = `geometry.${PACK_NAMESPACE}.${id}_mesh_${meshIds.length}`;
        meshIds.push(meshId);
        meshes.push({ description: { identifier: meshId, texture_width: atlasW, texture_height: atlasH, ...cullingBounds }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes: cubes.slice(offset, offset + 1024) }] });
    }
    return { value: { format_version: '1.12.0', 'minecraft:geometry': meshes }, palette, meshIds, cubeCount: cubes.length };
}
/**
 * The BlockGrid fallback keeps ONE texture for the whole entity: its cubes are
 * greedy voxel boxes that carry the embossed stud tile on top and the bevelled
 * seam tile on their sides, which box UV cannot address. Its meshes therefore
 * all bind the same per-entity atlas and draw with the default (alpha-blended)
 * material, because a single mesh mixes glass blocks with solids.
 */
function gridMeshBindings(id: string, meshIds: string[]): MeshBinding[] {
    return meshIds.map(geometryId => ({ geometryId, texture: `textures/entity/${id}`, translucent: false }));
}
/**
 * `opaqueMaterial` is `entity` for brick-compiled bodies (their translucent
 * colours get their own geometries, bound to `Material.blend`) and
 * `entity_alphablend` for the BlockGrid fallback, whose single mesh mixes
 * glass blocks with solids.
 */
/** Animations a client entity plays: the `animations` map and the `scripts.animate` list (a minifig's walk / look / sit). */
export interface ClientAnimations {
    animations: Record<string, string>;
    animate: Array<string | Record<string, string>>;
    /** Molang run once when the client creates the entity, and before every animation frame (an interactive's eased angle). */
    initialize?: string[];
    preAnimation?: string[];
}

/**
 * One geometry of a client entity: the texture it samples and whether it draws
 * alpha-blended. A brick-compiled geometry carries a single LDraw colour (box
 * UV - see `ldraw-entity-compiler.ts`), so its texture is that colour's flat
 * swatch and many geometries of the same colour share one file.
 */
interface MeshBinding {
    geometryId: string;
    /** Resource-pack path, without the extension. */
    texture: string;
    translucent: boolean;
    /** Cut-out texture (a face atlas): drawn with `entity_alphatest`, so only the ink shows. */
    alphaTest?: boolean;
}

/** The `textures` map plus the key each binding resolves to; identical paths share a key. */
function textureKeys(bindings: MeshBinding[]): { textures: Record<string, string>; keyOf: string[] } {
    const textures: Record<string, string> = {};
    const seen = new Map<string, string>();
    const keyOf = bindings.map(b => {
        let key = seen.get(b.texture);
        if (!key) {
            key = seen.size === 0 ? 'default' : `tex_${seen.size}`;
            seen.set(b.texture, key);
            textures[key] = b.texture;
        }
        return key;
    });
    return { textures, keyOf };
}

/** The `minecraft:collision_box` a behaviour document declares at 100 %, for the render-cull rule (`planLodSwitch`). */
function collisionBoxOf(behavior: unknown): CollisionBox | undefined {
    const box = (behavior as { 'minecraft:entity'?: { components?: { 'minecraft:collision_box'?: Partial<CollisionBox> } } } | null | undefined)?.['minecraft:entity']?.components?.['minecraft:collision_box'];
    return box && typeof box.width === 'number' && typeof box.height === 'number' ? { width: box.width, height: box.height } : undefined;
}
/**
 * A string for the game to SHOW - a form body or button, a chat line, an
 * action bar. The client passes every one of them through its localisation
 * formatter, where `%` opens a format argument (`%s`, `%1`, `%d`) and a `%`
 * that opens nothing is deleted: the wand rendered "at 100 %; 150 % makes"
 * as "at 100 ; 150  makes" and the Size button "100%" as "100" (Pixel 8 Pro,
 * `output/bedrock-entity-qa/round921/round921-21-wand-top.jpg`, `-20-size-menu`).
 * Mojang's own `en_US.lang` spells a literal percent `%%`
 * (`options.percent.format=%s%%`, `attribute.modifier.plus.1=+%d%% %s`,
 * `world_recovery.progress=… %4%% complete`), so `%%` is the lang-file
 * escape; whether a script form body honours the same escape has not been
 * seen on a device, and a `%%` that rendered literally would be worse than a
 * word. So the word, until a device round confirms `%%` - then this one
 * replacement changes. Applied at the hand-off to the wand; the diagnostics
 * JSON and the README keep the sign, nothing renders them in game.
 */
export function bedrockInGameText(s: string): string {
    return s.replace(/\s*%/g, ' percent');
}
/**
 * How a client entity's geometries are split between the full model and its LOD
 * hull. `fullCount` bindings come first (the model), the rest are the hull.
 */
interface LodBinding {
    fullCount: number;
    /**
     * Camera-to-ROOT distance the controllers test: `lodDistance` plus the
     * entity's reach from its root (`LodHull.radiusBlocks`), so the camera is
     * at least `lodDistance` from every cube when the hull draws.
     */
    distance: number;
}
function clientEntity(id: string, bindings: MeshBinding[], opaqueMaterial = 'entity_alphablend', animations?: ClientAnimations, lod?: LodBinding): unknown {
    const materials: Record<string, string> = { default: opaqueMaterial };
    if (bindings.some(b => b.translucent)) materials.blend = 'entity_alphablend';
    if (bindings.some(b => b.alphaTest)) materials.cutout = 'entity_alphatest';
    const { textures } = textureKeys(bindings);
    const geometryMap: Record<string, string> = {};
    bindings.forEach((b, i) => { geometryMap[`mesh_${i}`] = b.geometryId; });
    // One shared empty geometry, declared once here: every LOD controller
    // selects it for the half of the pair that must not draw.
    if (lod) geometryMap.empty = LOD_EMPTY_GEOMETRY_ID;
    return {
        format_version: '1.10.0',
        'minecraft:client_entity': {
            description: {
                identifier: `${PACK_NAMESPACE}:${id}`,
                materials,
                textures,
                geometry: geometryMap,
                render_controllers: bindings.map((_, i) => `controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`),
                ...(animations ? { animations: animations.animations, scripts: {
                    ...(animations.initialize ? { initialize: animations.initialize } : {}),
                    ...(animations.preAnimation ? { pre_animation: animations.preAnimation } : {}),
                    animate: animations.animate,
                } } : {}),
                spawn_egg: { base_color: '#151515', overlay_color: '#f5c542' },
            },
        },
    };
}
/**
 * One render controller per geometry. With an LOD, each controller picks
 * between its own geometry and the shared empty one by camera distance, using
 * the documented `arrays.geometries` + indexed-`Array` mechanism:
 *   - https://learn.microsoft.com/en-us/minecraft/creator/reference/content/schemasreference/schemas/minecraftschema_render_controllers_1.8.0
 *     (`arrays.geometries`, `"geometry": "Array.<name>[<expr>]"`; the index is
 *     `max(0, expr) % size`, so a boolean expression selects element 0 or 1)
 *   - https://learn.microsoft.com/en-us/minecraft/creator/reference/content/molangreference/examples/molangconcepts/queryfunctions
 *     (the Mojang example `"geometry": "query.is_sheared ? geometry.sheared : geometry.woolly"` —
 *     a query IS read in this field; `query.distance_from_camera` is the query used here)
 *
 * Both arrays are `[own geometry, empty]`, so the full-detail controllers index
 * on `distance > D` (far → empty) and the hull controllers on `distance <= D`
 * (near → empty). Verified on the Pixel 8 Pro 2026-09-19: the query IS
 * evaluated in a geometry field, its unit is blocks, the switch shows at 26-28
 * blocks for D = 32, and the content log stays clean. The query measures the
 * camera to the entity's ROOT, so D is `lodDistance + radiusBlocks`
 * (`LodBinding.distance`), never the bare option: a bare 32 flipped 10303 to
 * its hull for a camera standing at the tracks (2026-09-21).
 */
function meshControllers(id: string, bindings: MeshBinding[], lod?: LodBinding): unknown {
    const controllers: Record<string, unknown> = {};
    const { keyOf } = textureKeys(bindings);
    bindings.forEach((b, i) => {
        const lodPair = lod
            ? {
                arrays: { geometries: { 'Array.g': [`Geometry.mesh_${i}`, 'Geometry.empty'] } },
                geometry: `Array.g[query.distance_from_camera ${i < lod.fullCount ? '>' : '<='} ${lod.distance}]`,
            }
            : { geometry: `Geometry.mesh_${i}` };
        controllers[`controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`] = {
            ...lodPair,
            materials: [{ '*': b.translucent ? 'Material.blend' : b.alphaTest ? 'Material.cutout' : 'Material.default' }],
            textures: [`Texture.${keyOf[i]}`],
        };
    });
    return {
        format_version: '1.8.0',
        render_controllers: controllers,
    };
}
function screenClient(id: string): unknown { return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, materials: { default: 'entity_emissive_alpha' }, textures: { default: 'textures/entity/craftmatic_screen' }, geometry: { default: `geometry.${PACK_NAMESPACE}.control_screen` }, render_controllers: ['controller.render.default'] } } }; }
const SCREEN_GEOMETRY = { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: `geometry.${PACK_NAMESPACE}.control_screen`, texture_width: 1, texture_height: 1, visible_bounds_width: 2, visible_bounds_height: 2, visible_bounds_offset: [0, 1, 0] }, bones: [{ name: 'screen', pivot: [0, 0, 0], cubes: [{ origin: [-8, 0, -1], size: [16, 16, 2], uv: [0, 0] }] }] }] };
function screenBehavior(id: string): unknown { return { format_version: '1.20.80', 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: false, is_summonable: true }, components: { 'minecraft:type_family': { family: ['craftmatic_screen'] }, 'minecraft:health': { value: 20, max: 20 }, 'minecraft:collision_box': { width: 1, height: 1 }, 'minecraft:physics': { has_gravity: false, has_collision: false }, 'minecraft:persistent': {}, 'minecraft:nameable': {}, 'minecraft:interact': { interactions: [{ interact_text: 'action.interact.craftmatic_screen' }] } } } }; }
const SCREEN_SCRIPT = `import { world, system, BlockPermutation } from "@minecraft/server";
import { ActionFormData } from "@minecraft/server-ui";
function* toggleNearby(origin, dimension, kind, player) {
  let changed=0;
  for(let x=-10;x<=10;x++)for(let y=-6;y<=6;y++)for(let z=-10;z<=10;z++){
    let block; try{block=dimension.getBlock({x:Math.floor(origin.x+x),y:Math.floor(origin.y+y),z:Math.floor(origin.z+z)});}catch{continue;} if(!block)continue;
    const id=block.typeId;
    if(kind==='lights' && (id==='minecraft:redstone_lamp'||id==='minecraft:lit_redstone_lamp')) { block.setPermutation(BlockPermutation.resolve(id==='minecraft:redstone_lamp'?'minecraft:lit_redstone_lamp':'minecraft:redstone_lamp')); changed++; }
    if(kind==='doors' && id.includes('_door')) { const p=block.permutation; const open=p.getState('open_bit'); if(typeof open==='boolean'){block.setPermutation(p.withState('open_bit',!open));changed++;} }
    if((x+y+z)%32===0)yield;
  } player.sendMessage('Updated '+changed+' nearby '+kind+'.');
}
world.afterEvents.playerInteractWithEntity.subscribe(async ev=>{
  if(ev.target.typeId!==SCREEN_TYPE)return;
  let response;
  try{response=await new ActionFormData().title(ev.target.nameTag||'Craftmatic computer').body('Connected build controls').button('Toggle lights').button('Toggle doors').button('Scanner vision').button('Vehicle status').show(ev.player);}
  catch{ev.player.sendMessage('Computer controls are unavailable right now.');return;}
  if(response.canceled)return;
  if(response.selection===2){try{if(ev.player.getEffect('minecraft:night_vision')){ev.player.removeEffect('minecraft:night_vision');ev.player.sendMessage('Scanner vision disabled.');}else{ev.player.addEffect('minecraft:night_vision',12000,{showParticles:false});ev.player.sendMessage('Scanner vision enabled for 10 minutes.');}}catch{ev.player.sendMessage('Scanner vision is unavailable right now.');}return;}
  if(response.selection===3){const vehicles=ev.target.dimension.getEntities({location:ev.target.location,maxDistance:64,families:['craftmatic_vehicle']});if(!vehicles.length){ev.player.sendMessage('No vehicles online within 64 blocks.');return;}ev.player.sendMessage('Vehicles online: '+vehicles.length);for(const vehicle of vehicles){const p=vehicle.location;ev.player.sendMessage((vehicle.nameTag||vehicle.typeId)+' @ '+Math.floor(p.x)+', '+Math.floor(p.y)+', '+Math.floor(p.z));}return;}
  system.runJob(toggleNearby(ev.target.location,ev.target.dimension,response.selection===0?'lights':'doors',ev.player));
});`;

function timeMachineRuntime(config: { typeId: string; width: number; height: number; length: number }) {
  const MPH_PER_BLOCK_TICK = 20 * 2.236936, ACCEL_MPH_PER_SECOND = 6, BRAKE_MPH_PER_SECOND = 60, PREPARED_TTL_TICKS = 1200;
  const AREA_PREFIX = `cm_t${Array.from(config.typeId).reduce((n: number, c: string) => (n * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(36)}`;
  const states = new Map<string, any>();
  let areaCounter = 0;
  const waitTicks = (ticks: number) => new Promise<void>(resolve => system.runTimeout(resolve, ticks));
  const dimensions = () => ['overworld', 'nether', 'the_end'].flatMap(id => { try { return [world.getDimension(id)]; } catch { return []; } });
  const vehicles = () => dimensions().flatMap(d => { try { return d.getEntities({ type: config.typeId }).filter((e: any) => e.typeId === config.typeId); } catch { return []; } });
  /**
   * Speed of a rider-driven vehicle. Its movement is client-authoritative
   * (`input_ground_controlled`), so the server's `getVelocity()` reads ~0 while
   * it visibly drives; measure from the position delta over the 2-tick interval
   * instead, and treat a jump of more than 5 blocks as a teleport, not motion.
   */
  const riddenVelocity = (state: any, vehicle: any): { x: number; y: number; z: number } => {
    let reported = { x: 0, y: 0, z: 0 };
    try { reported = vehicle.getVelocity?.() ?? reported; } catch {}
    let loc: any;
    try { loc = vehicle.location; } catch { return reported; }
    const last = state.lastPos;
    state.lastPos = { x: loc.x, y: loc.y, z: loc.z };
    if (!last) return reported;
    const measured = { x: (loc.x - last.x) / 2, y: (loc.y - last.y) / 2, z: (loc.z - last.z) / 2 };
    if (Math.hypot(measured.x, measured.y, measured.z) > 5) return reported; // a teleport, not motion
    // Whichever channel reports the motion: the server's velocity for script-driven
    // impulses, the position delta for the client-driven ride.
    return Math.hypot(measured.x, measured.z) >= Math.hypot(reported.x, reported.z) ? measured : reported;
  };
  const readNumber = (entity: any, key: string) => { const value = entity.getDynamicProperty?.(key); return typeof value === 'number' && Number.isFinite(value) ? value : undefined; };
  const stateFor = (entity: any) => {
    let state = states.get(entity.id);
    if (!state) {
      const x = readNumber(entity, 'craftmatic:time_x'), y = readNumber(entity, 'craftmatic:time_y'), z = readNumber(entity, 'craftmatic:time_z');
      state = { destination: x === undefined || y === undefined || z === undefined ? undefined : { x, y, z }, threshold: readNumber(entity, 'craftmatic:time_mph') ?? 88,
        armed: false, targetMph: 0, commandMph: 0, retention: 1, stallTicks: 0, blocked: false,
        loading: false, configuring: false, ready: false, failed: false, inFlight: false, hadRider: false,
        areaId: undefined, areaDimension: undefined, preparedAt: 0 };
      states.set(entity.id, state);
      entity.setDynamicProperty?.('craftmatic:time_armed', false);
    }
    return state;
  };
  const removeArea = async (state: any) => {
    if (!state.areaId || !state.areaDimension) return;
    try { state.areaDimension.runCommand(`tickingarea remove ${state.areaId}`); } catch {}
    state.areaId = undefined; state.areaDimension = undefined; state.ready = false;
    await waitTicks(2);
  };
  const prepareDestination = async (vehicle: any, state: any) => {
    if (!state.destination || state.loading) return;
    state.loading = true; state.ready = false;
    await removeArea(state);
    const d = vehicle.dimension, p = state.destination, range = d.heightRange;
    const half = Math.max(config.width, config.length) / 2;
    const x0 = Math.floor(p.x - half), x1 = Math.ceil(p.x + half), z0 = Math.floor(p.z - half), z1 = Math.ceil(p.z + half);
    const y0 = Math.floor(p.y), y1 = Math.ceil(p.y + config.height);
    if (!range || y0 < range.min || y1 >= range.max) { state.loading = false; throw new Error(`Vehicle must fit between Y ${range?.min ?? '?'} and ${(range?.max ?? 0) - 1}.`); }
    const name = `${AREA_PREFIX}_${(++areaCounter).toString(36)}`;
    try {
      const result = d.runCommand(`tickingarea add ${x0} ${y0} ${z0} ${x1} ${y0} ${z1} ${name} true`);
      if (result?.successCount === 0) throw new Error('destination ticking area could not be created');
      state.areaId = name; state.areaDimension = d;
      await waitTicks(2);
      let loaded = false;
      const probes: any[] = [];
      for (let cx = Math.floor(x0 / 16); cx <= Math.floor(x1 / 16); cx++) for (let cz = Math.floor(z0 / 16); cz <= Math.floor(z1 / 16); cz++)
        probes.push({ x: Math.max(x0, Math.min(x1, cx * 16 + 8)), y: y0, z: Math.max(z0, Math.min(z1, cz * 16 + 8)) });
      for (let elapsed = 0; elapsed < 200; elapsed += 2) {
        try { loaded = probes.every(probe => !!d.getBlock(probe)); } catch { loaded = false; }
        if (loaded) break;
        await waitTicks(2);
      }
      if (!loaded) throw new Error('destination did not load within 10 seconds');
      const clear = Array.from({ length: y1 - y0 + 1 }, (_, dy) => dy).every(dy => { try { const block = d.getBlock({ x: Math.floor(p.x), y: y0 + dy, z: Math.floor(p.z) }); return !!block && ['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(block.typeId); } catch { return false; } });
      if (!clear) throw new Error('destination vehicle-height clearance is obstructed; choose open ground');
      state.ready = true; state.preparedAt = tick;
    } catch (error) {
      await removeArea(state);
      throw error;
    } finally { state.loading = false; }
  };
  const findVehicle = (player: any) => {
    const candidates = (() => { try { return player.dimension.getEntities({ type: config.typeId, location: player.location, maxDistance: 32 }).filter((e: any) => e.typeId === config.typeId); } catch { return []; } })();
    return candidates.find((vehicle: any) => { try { return vehicle.getComponent('minecraft:rideable')?.getRiders().some((rider: any) => rider.id === player.id); } catch { return false; } }) ?? candidates[0];
  };
  async function showTimeMachineControls(player: any) {
    const vehicle = findVehicle(player);
    if (!vehicle) { player.sendMessage('No 10300 Time Machine is mounted or within 32 blocks.'); return; }
    const state = stateFor(vehicle), here = vehicle.location, current = state.destination ?? { x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) };
    if (state.configuring || state.loading || state.inFlight) { player.sendMessage('Time Machine controls are busy. Try again in a moment.'); return; }
    state.configuring = true;
    let response;
    try {
      response = await new ModalFormData().title('10300 Time Machine')
        .textField('Destination X', '0', { defaultValue: String(current.x) })
        .textField('Destination Y', '64', { defaultValue: String(current.y) })
        .textField('Destination Z', '0', { defaultValue: String(current.z) })
        .slider('Teleport speed (mph) · mph = blocks/sec × 2.236936', 10, 150, { defaultValue: state.threshold, valueStep: 1 }).show(player);
    } catch { state.configuring = false; player.sendMessage('Time Machine controls are unavailable right now.'); return; }
    if (response.canceled) { state.configuring = false; return; }
    const values = response.formValues ?? [], x = Number(values[0]), y = Number(values[1]), z = Number(values[2]), threshold = Number(values[3]);
    if (![x, y, z, threshold].every(Number.isFinite) || [x, y, z].some(value => Math.abs(value) >= 30000000) || threshold < 10 || threshold > 150) { state.configuring = false; player.sendMessage('Use coordinates within +/-29,999,999 and a speed from 10 to 150 mph.'); return; }
    await removeArea(state);
    state.destination = { x, y, z }; state.threshold = threshold; state.armed = true; state.failed = false; state.owner = player;
    try { state.hadRider = !!vehicle.getComponent('minecraft:rideable')?.getRiders?.().some((rider: any) => rider.id === player.id); } catch { state.hadRider = false; }
    for (const [key, value] of [['craftmatic:time_x', x], ['craftmatic:time_y', y], ['craftmatic:time_z', z], ['craftmatic:time_mph', threshold]] as const) vehicle.setDynamicProperty?.(key, value);
    vehicle.setDynamicProperty?.('craftmatic:time_armed', true);
    player.sendMessage(`Time circuit set to ${x}, ${y}, ${z} at ${threshold} mph. Loading destination…`);
    try { await prepareDestination(vehicle, state); player.sendMessage('Destination ready. Accelerate forward to engage.'); }
    catch (error) { state.armed = false; state.failed = true; vehicle.setDynamicProperty?.('craftmatic:time_armed', false); player.sendMessage(`Time circuit unavailable: ${error instanceof Error ? error.message : String(error)} Set the circuit again to retry.`); }
    finally { state.configuring = false; }
  }
  const teleport = async (vehicle: any, state: any, riders: any[]) => {
    state.armed = false; state.inFlight = true; state.targetMph = 0; state.commandMph = 0; vehicle.setDynamicProperty?.('craftmatic:time_armed', false);
    try { vehicle.clearVelocity(); } catch {}
    try { vehicle.dimension?.spawnParticle?.('minecraft:sonic_explosion', vehicle.location); } catch {}
    try { vehicle.dimension?.playSound?.('random.explode', vehicle.location, { volume: 1, pitch: 0.8 }); } catch {}
    try { vehicle.dimension?.playSound?.('beacon.activate', vehicle.location, { volume: 1, pitch: 1.2 }); } catch {}
    const p = state.destination, rotation = vehicle.getRotation?.();
    try {
      let moved = false;
      try { moved = vehicle.tryTeleport({ x: p.x, y: p.y, z: p.z }, { dimension: vehicle.dimension, rotation, checkForBlocks: true }); } catch {}
      if (!moved) { for (const rider of riders) rider.sendMessage?.('Time jump blocked at the destination. Set the circuit again to retry.'); return; }
      await waitTicks(1);
      const rideable = vehicle.getComponent('minecraft:rideable');
      let complete = true;
      for (const rider of riders) {
        let mounted = false;
        try { mounted = !!rideable?.getRiders?.().some((current: any) => current.id === rider.id); } catch {}
        if (!mounted) {
          try { rider.tryTeleport({ x: p.x, y: p.y + 1, z: p.z }, { dimension: vehicle.dimension, checkForBlocks: true }); mounted = rideable?.addRider?.(rider) !== false; } catch { mounted = false; }
        }
        complete = complete && mounted;
      }
      try { vehicle.dimension?.spawnParticle?.('minecraft:sonic_explosion', { x: p.x, y: p.y, z: p.z }); } catch {}
      try { vehicle.dimension?.playSound?.('beacon.power', { x: p.x, y: p.y, z: p.z }, { volume: 1, pitch: 1 }); } catch {}
      for (const rider of riders) rider.sendMessage?.(complete ? `Time jump complete at ${state.threshold} mph.` : 'Vehicle moved, but a rider could not be remounted. Move to open ground before trying again.');
    } finally { await removeArea(state); state.inFlight = false; }
  };
  let tick = 0;
  system.runInterval(() => {
    tick += 2;
    const seen = new Set<string>();
    for (const vehicle of vehicles()) {
      seen.add(vehicle.id);
      const state = stateFor(vehicle), rideable = vehicle.getComponent('minecraft:rideable'), riders = rideable?.getRiders?.() ?? [];
      const rider = riders.find((entity: any) => entity.typeId === 'minecraft:player') ?? riders[0];
      const velocity = riddenVelocity(state, vehicle), horizontal = Math.hypot(velocity.x, velocity.z), mph = horizontal * MPH_PER_BLOCK_TICK;
      let forward = false;
      try { forward = (rider?.inputInfo?.getMovementVector()?.y ?? 0) > .05; } catch {}
      if (rider) state.hadRider = true;
      if (((state.hadRider && !rider) || (state.ready && tick - state.preparedAt > PREPARED_TTL_TICKS)) && state.areaId && !state.loading && !state.inFlight) {
        state.armed = false; vehicle.setDynamicProperty?.('craftmatic:time_armed', false); void removeArea(state);
        state.owner?.sendMessage?.('Time circuit expired or rider dismounted. Set it again before accelerating.');
      }
      if (state.inFlight) continue;
      const step = 2 / 20;
      const direction = vehicle.getViewDirection(), horizontalDirection = Math.hypot(direction.x, direction.z) || 1;
      const forwardMph = Math.max(0, (velocity.x * direction.x + velocity.z * direction.z) / horizontalDirection) * MPH_PER_BLOCK_TICK;
      if (forward && state.commandMph > 10 && forwardMph < 1) state.stallTicks += 2; else state.stallTicks = 0;
      if (state.stallTicks >= 20) { state.blocked = true; state.targetMph = Math.min(state.targetMph, 10); }
      if (state.blocked && forwardMph > 1) { state.blocked = false; state.stallTicks = 0; }
      if (forward && !state.blocked && state.commandMph > 5 && forwardMph > 1) {
        const sample = Math.max(.15, Math.min(1, forwardMph / state.commandMph));
        state.retention = state.retention * .8 + sample * .2;
      }
      const driveCap = Math.max(88, state.threshold * 1.02);
      state.targetMph = forward ? Math.min(driveCap, state.targetMph + ACCEL_MPH_PER_SECOND * step) : Math.max(0, state.targetMph - BRAKE_MPH_PER_SECOND * step);
      const commandMph = forward ? Math.min(600, state.targetMph / Math.max(.15, state.retention)) : state.targetMph;
      state.commandMph = commandMph;
      const target = commandMph / MPH_PER_BLOCK_TICK;
      try { vehicle.applyImpulse({ x: direction.x / horizontalDirection * target - velocity.x, y: 0, z: direction.z / horizontalDirection * target - velocity.z }); } catch {}
      if (rider && tick % 20 === 0) {
        try { rider.addEffect?.('minecraft:night_vision', 80, { showParticles: false }); } catch {}
      }
      if (rider && forwardMph > 60 && tick % 6 === 0) {
        try { vehicle.dimension?.spawnParticle?.('minecraft:electric_spark_particle', vehicle.location); } catch {}
      }
      if (rider && tick % 4 === 0) rider.onScreenDisplay?.setActionBar?.(`${mph.toFixed(1)} mph · ${state.armed ? (state.ready ? `armed ${state.threshold} mph` : 'loading destination') : 'time circuit disarmed'}`);
      if (rider && forward && state.armed && state.ready && !state.failed && forwardMph >= state.threshold) { state.inFlight = true; void teleport(vehicle, state, riders); }
    }
    for (const [id, state] of states) if (!seen.has(id)) { if (state.areaId && !state.inFlight) void removeArea(state); states.delete(id); }
  }, 2);
  return showTimeMachineControls;
}

const timeMachineScript = (config: { typeId: string; width: number; height: number; length: number }) => `import { world, system } from "@minecraft/server";\nimport { ModalFormData } from "@minecraft/server-ui";\nconst showTimeMachineControls = (${timeMachineRuntime.toString()})(${JSON.stringify(config)});\nexport { showTimeMachineControls };\n`;

function vehicleDriverRuntime(config: { vehicles: Array<{ typeId: string; kind: 'car' | 'plane' | 'boat'; label: string }>; dashCooldownTicks: number; descendOn: string; descendOff: string }) {
  const MPH_PER_BLOCK_TICK = 20 * 2.236936;
  const vehiclesByType = new Map(config.vehicles.map((v: any) => [v.typeId, v]));
  const states = new Map<string, any>();
  /**
   * Speed of a rider-driven vehicle. Its movement is client-authoritative
   * (`input_ground_controlled`), so the server's `getVelocity()` reads ~0 while
   * it visibly drives; measure from the position delta over the 2-tick interval
   * instead, and treat a jump of more than 5 blocks as a teleport, not motion.
   */
  const riddenVelocity = (state: any, vehicle: any): { x: number; y: number; z: number } => {
    let reported = { x: 0, y: 0, z: 0 };
    try { reported = vehicle.getVelocity?.() ?? reported; } catch {}
    let loc: any;
    try { loc = vehicle.location; } catch { return reported; }
    const last = state.lastPos;
    state.lastPos = { x: loc.x, y: loc.y, z: loc.z };
    if (!last) return reported;
    const measured = { x: (loc.x - last.x) / 2, y: (loc.y - last.y) / 2, z: (loc.z - last.z) / 2 };
    if (Math.hypot(measured.x, measured.y, measured.z) > 5) return reported; // a teleport, not motion
    // Whichever channel reports the motion: the server's velocity for script-driven
    // impulses, the position delta for the client-driven ride.
    return Math.hypot(measured.x, measured.z) >= Math.hypot(reported.x, reported.z) ? measured : reported;
  };

  const dimensions = () => ['overworld', 'nether', 'the_end'].flatMap(id => {
    try { return [world.getDimension(id)]; } catch { return []; }
  });
  const activeVehicles = () => dimensions().flatMap(d => {
    return config.vehicles.flatMap(v => {
      try {
        return d.getEntities({ type: v.typeId })
          .filter((e: any) => e.typeId === v.typeId)
          .map((e: any) => ({ vehicle: e, config: v }));
      } catch {
        return [];
      }
    });
  });

  let tick = 0;
  system.runInterval(() => {
    tick += 2;
    for (const { vehicle, config: vConfig } of activeVehicles()) {
      let riders: any[] = [];
      try { riders = vehicle.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch {}
      const rider = riders.find((e: any) => e.typeId === 'minecraft:player') ?? riders[0];
      if (!rider) continue;

      let state = states.get(vehicle.id);
      if (!state) {
        state = { boostCooldown: 0, stallTicks: 0, lastMph: 0 };
        states.set(vehicle.id, state);
      }
      if (state.boostCooldown > 0) state.boostCooldown -= 2;
      const isPlane = vConfig.kind === 'plane';

      const vel = riddenVelocity(state, vehicle);
      const horizontal = Math.hypot(vel.x, vel.z);
      const mph = horizontal * MPH_PER_BLOCK_TICK;
      const isCar = vConfig.kind === 'car';
      const isBoat = vConfig.kind === 'boat';

      let jump = false;
      let forwardInput = 0;
      let steerInput = 0;
      try {
        const m = rider.inputInfo?.getMovementVector?.();
        forwardInput = m?.y ?? 0;
        steerInput = m?.x ?? 0;
        jump = !!(rider.isJumping || rider.inputInfo?.getButtonState?.('Jump') === 'Pressed');
      } catch {}

      const dir = vehicle.getViewDirection?.() ?? { x: 0, y: 0, z: 1 };
      const hDir = Math.hypot(dir.x, dir.z) || 1;

      // 0. Aircraft descend: pull the stick BACK and hold Jump. The entity's
      //    `craftmatic:descending` group makes Jump's vertical action negative
      //    while it is added (behaviorEntity); it is removed the moment the
      //    stick returns so Jump climbs again. Independent of the look pitch.
      if (isPlane) {
        const wantDescend = jump && forwardInput < -0.1;
        if (wantDescend !== !!state.descending) {
          state.descending = wantDescend;
          try { vehicle.triggerEvent?.(wantDescend ? config.descendOn : config.descendOff); } catch {}
        }
      }

      // 1. Boost feedback. The boost itself is NATIVE: a car/boat's
      //    `minecraft:dash_action` fires on the Jump button (hold to charge,
      //    release to dash) and a plane's `vertical_movement_action` climbs on
      //    Jump, so the script only plays the effects and shows the cooldown.
      if (jump && state.boostCooldown <= 0 && forwardInput >= 0 && !state.descending) {
        state.boostCooldown = config.dashCooldownTicks;
        if (isBoat) {
          try { vehicle.dimension?.playSound?.('random.splash', vehicle.location, { volume: 0.9, pitch: 1.1 }); } catch {}
          try { vehicle.dimension?.spawnParticle?.('minecraft:water_splash_particle', vehicle.location); } catch {}
          try { vehicle.dimension?.spawnParticle?.('minecraft:water_wake_particle', vehicle.location); } catch {}
        } else {
          try { vehicle.dimension?.playSound?.('firework.launch', vehicle.location, { volume: 0.8, pitch: 1.2 }); } catch {}
          try { vehicle.dimension?.spawnParticle?.('minecraft:flame_particle', vehicle.location); } catch {}
          try { vehicle.dimension?.spawnParticle?.('minecraft:campfire_smoke_particle', vehicle.location); } catch {}
        }
      }

      // 2. Obstacle Suspension Hop (for cars)
      if (isCar) {
        const forwardMph = Math.max(0, (vel.x * dir.x + vel.z * dir.z) / hDir) * MPH_PER_BLOCK_TICK;
        if (forwardInput > 0.3 && forwardMph < 1.2 && state.lastMph > 2) {
          state.stallTicks += 2;
        } else {
          state.stallTicks = 0;
        }
        if (state.stallTicks >= 4 && state.stallTicks <= 8) {
          try { vehicle.applyImpulse?.({ x: 0, y: 0.28, z: 0 }); } catch {}
          try { vehicle.dimension?.playSound?.('step.stone', vehicle.location, { volume: 0.5, pitch: 1.4 }); } catch {}
        }
      }

      // 2b. Reverse Gear & Dynamic Brake Lights
      if (forwardInput < -0.1) {
        const revSpeed = isCar ? -0.16 : isBoat ? -0.12 : -0.1;
        try {
          vehicle.applyImpulse?.({
            x: (dir.x / hDir) * revSpeed,
            y: 0,
            z: (dir.z / hDir) * revSpeed,
          });
        } catch {}
        if (tick % 4 === 0) {
          try {
            const rX = vehicle.location.x - (dir.x / hDir) * 1.2;
            const rZ = vehicle.location.z - (dir.z / hDir) * 1.2;
            vehicle.dimension?.spawnParticle?.('minecraft:redstone_ore_dust_particle', { x: rX, y: vehicle.location.y + 0.4, z: rZ });
          } catch {}
        }
      }

      // 2c. Interactive Horn on Sneak / Crouch
      if (rider.isSneaking && tick % 14 === 0) {
        try {
          vehicle.dimension?.playSound?.('note.cow_bell', vehicle.location, { volume: 1.0, pitch: 1.0 });
          vehicle.dimension?.spawnParticle?.('minecraft:note_particle', { x: vehicle.location.x, y: vehicle.location.y + 1.2, z: vehicle.location.z });
        } catch {}
      }

      // 2d. Engine Audio Loop & Dynamic Speed Pitch
      if (forwardInput > 0.1 && mph > 1.5) {
        if (tick % 10 === 0) {
          const enginePitch = Math.min(2.0, Math.max(0.6, 0.6 + (mph / 45) * 0.9));
          try {
            if (isBoat) {
              vehicle.dimension?.playSound?.('random.splash', vehicle.location, { volume: 0.35, pitch: enginePitch });
            } else if (isCar) {
              vehicle.dimension?.playSound?.('minecart.base', vehicle.location, { volume: 0.32, pitch: enginePitch });
            } else {
              vehicle.dimension?.playSound?.('elytra.loop', vehicle.location, { volume: 0.38, pitch: Math.min(1.8, 0.8 + (mph / 50) * 0.8) });
            }
          } catch {}
        }
      } else if (forwardInput <= 0.1 && mph < 1.0 && tick % 30 === 0) {
        try {
          vehicle.dimension?.playSound?.('minecart.base', vehicle.location, { volume: 0.12, pitch: 0.5 });
        } catch {}
      }

      // 3. Drift Tire Smoke or Water Wake on High Speed Turns
      if (isCar && mph > 10 && Math.abs(steerInput) > 0.35) {
        try { vehicle.dimension?.spawnParticle?.('minecraft:smoke_particle', vehicle.location); } catch {}
        if (tick % 8 === 0) {
          try { vehicle.dimension?.playSound?.('step.cloth', vehicle.location, { volume: 0.4, pitch: 0.7 }); } catch {}
        }
      } else if (isBoat && mph > 6) {
        try { vehicle.dimension?.spawnParticle?.('minecraft:water_wake_particle', vehicle.location); } catch {}
      }

      // 4. Headlights (automatic night vision)
      if (tick % 20 === 0) {
        try { rider.addEffect?.('minecraft:night_vision', 80, { showParticles: false }); } catch {}
      }

      // 5. Action Bar Speedometer HUD with Gear, Reverse, and Multi-seat Co-Pilot
      if (tick % 4 === 0) {
        const boostReady = state.boostCooldown <= 0;
        const icon = isCar ? '🏎️' : isBoat ? '⛵' : '✈️';
        const boostTag = (isCar || isBoat)
          ? (boostReady ? ' · §a[JUMP: DASH]§r' : ` · §8[DASH: ${(state.boostCooldown / 20).toFixed(1)}s]§r`)
          : (state.descending ? ' · §a[DESCENDING]§r' : ' · §a[STICK: TURN · JUMP: CLIMB · BACK+JUMP: DESCEND · LOOK DOWN: DIVE]§r');
        const coPilotTag = riders.length > 1 ? ` · §d[👥 ${riders.length}]§r` : '';
        let speedText = `§e${mph.toFixed(1)} mph§r`;
        if (forwardInput < -0.1) {
          speedText = `§c[REV]§r §e-${mph > 0.5 ? mph.toFixed(1) : '0.0'} mph§r`;
        } else if (isCar) {
          const gear = mph < 10 ? 1 : mph < 22 ? 2 : mph < 36 ? 3 : mph < 50 ? 4 : 5;
          speedText = `§e${mph.toFixed(1)} mph§r · §bGEAR ${gear}§r`;
        }
        const hud = (isCar || isBoat)
          ? `${icon} ${speedText}${coPilotTag}${boostTag}`
          : `${icon} §e${mph.toFixed(1)} mph§r · §bALT ${Math.floor(vehicle.location?.y ?? 0)}§r${coPilotTag}${boostTag}`;
        for (const r of riders) {
          try { r.onScreenDisplay?.setActionBar?.(hud); } catch {}
        }
      }

      state.lastMph = mph;
    }
  }, 2);

  try {
    world.afterEvents?.entityHitEntity?.subscribe?.((ev: any) => {
      try {
        if (vehiclesByType.has(ev.hitEntity?.typeId)) {
          ev.hitEntity.dimension?.playSound?.('note.bell', ev.hitEntity.location, { volume: 0.8, pitch: 1.2 });
        }
      } catch {}
    });
  } catch {}
}

const vehicleDriverScript = (config: { vehicles: Array<{ typeId: string; kind: 'car' | 'plane' | 'boat'; label: string }>; dashCooldownTicks: number; descendOn: string; descendOff: string }) =>
  `import { world, system } from "@minecraft/server";\n(${vehicleDriverRuntime.toString()})(${JSON.stringify(config)});\n`;

/**
 * Chase camera preset, one per vehicle. A rider in first person sits INSIDE
 * the entity's geometry — the DeLorean's cabin walls and dashboard are opaque
 * cuboids at eye height — sees nothing and cannot steer. Every rider is put on
 * a `minecraft:follow_orbit` preset sized to the vehicle (radius from its
 * longest side, orbit pivot raised to mid-body) for as long as they ride.
 * `follow_orbit`'s default control scheme is "locked player relative strafe"
 * (learn.microsoft.com/minecraft/creator/documents/controlschemes): look input
 * still turns the PLAYER, which is what `input_ground_controlled` steers by, so
 * driving is unchanged. Presets live in the behavior pack's `cameras/presets/`.
 */
export function chaseCameraPreset(cid: string, kind: PlayableKind, size: { width: number; height: number; length: number }): { id: string; radius: number; value: unknown } {
    // follow_orbit has no block collision (measured on the Pixel: a 10-block
    // boom behind a car parked at a hillside put the camera inside the hill),
    // so the boom is kept short and the orbit pivot sits at the vehicle's roof
    // line, where it clears terrain most of the time.
    const radius = chaseRadius(size);
    const id = `${PACK_NAMESPACE}:${cid}_chase`;
    const pivotY = Math.round(Math.max(0.8, size.height * 0.75 + 0.5) * 100) / 100;
    // Control scheme (learn.microsoft.com/minecraft/creator/documents/controlschemes):
    // a ground vehicle steers with the joystick's left/right under
    // `player_relative` (the stick ROTATES the player, which is the yaw
    // `input_ground_controlled` follows); under the default locked scheme the
    // stick only strafes and the rider has to swipe to turn - reported as
    // "just forward and backwards" on the Tumbler. An aircraft keeps the locked
    // scheme: its look pitch is what climbs and dives under free_camera_controlled.
    const control_scheme = kind === 'plane' ? 'locked_player_relative_strafe' : 'player_relative';
    return {
        id, radius,
        value: { format_version: '1.21.0', 'minecraft:camera_preset': { identifier: id, inherit_from: 'minecraft:follow_orbit', radius, entity_offset: [0, pivotY, 0], control_scheme } },
    };
}

/**
 * Alternative chase camera for ground vehicles: `minecraft:fixed_boom` does not
 * orbit with look input, so the view stays on the vehicle's tail while the
 * joystick steers (`player_relative`). Shipped beside the orbit preset; the
 * runtime applies whichever `cameraStyle` chose. No `starting_rot_x`: the
 * 1.26.51 camera-preset schema rejects it and one bad preset fails the whole
 * pack's presets (Pixel round 2026-09-17, the only content-log error).
 */
export function boomCameraPreset(cid: string, size: { width: number; height: number; length: number }): { id: string; radius: number; value: unknown } {
    const radius = chaseRadius(size);
    const id = `${PACK_NAMESPACE}:${cid}_boom`;
    const pivotY = Math.round(Math.max(0.8, size.height * 0.75 + 0.5) * 100) / 100;
    return {
        id, radius,
        value: { format_version: '1.21.0', 'minecraft:camera_preset': { identifier: id, inherit_from: 'minecraft:fixed_boom', radius, entity_offset: [0, pivotY, 0], control_scheme: 'player_relative' } },
    };
}

/**
 * Runs in the pack: applies each vehicle's chase preset to its riders and
 * clears the camera on dismount. If the preset is rejected (a client without
 * the orbit presets) the vanilla `minecraft:third_person` preset stands in.
 */
/** Per-vehicle camera config serialised into the pack. */
interface VehicleCameraConfig { typeId: string; preset: string; kind: 'car' | 'plane' | 'boat'; radius: number; height: number; pivotY: number }

/**
 * Runs in the pack. Measured on the Pixel (1.26.45, 2026-09-15): a camera
 * preset's `control_scheme` key is ignored, but `/controlscheme` works, and
 * under `player_relative` the joystick's left/right ROTATES the rider (the
 * heading `input_ground_controlled` drives along) instead of strafing. Neither
 * `follow_orbit` nor `fixed_boom` turns with the rider, so a ground vehicle
 * gets a script-driven `minecraft:free` chase camera placed behind the rider's
 * yaw every tick (eased), which is what keeps the view on the vehicle's tail
 * through a turn. Aircraft keep the orbit preset: their look pitch is the
 * climb/dive input under `free_camera_controlled`. Everything is cleared on
 * dismount. If the free camera is rejected, the vanilla third person stands in.
 */
function vehicleCameraRuntime(config: { vehicles: VehicleCameraConfig[] }) {
  const byType = new Map(config.vehicles.map((v: any) => [v.typeId, v] as const));
  const tracked = new Map<string, { typeId: string; chase: boolean }>();
  const dimensions = () => ['overworld', 'nether', 'the_end'].flatMap(id => { try { return [world.getDimension(id)]; } catch { return []; } });
  const applyPreset = (player: any, preset: string): boolean => {
    try { player.camera.setCamera(preset); return true; } catch {}
    try { player.camera.setCamera('minecraft:third_person'); return true; } catch {}
    return false;
  };
  const chase = (player: any, vehicle: any, cfg: any): boolean => {
    let yaw = 0, pitch = 0;
    try { const r = player.getRotation(); yaw = r.y; pitch = r.x; } catch {}
    const rad = yaw * Math.PI / 180;
    // Bedrock yaw: 0 faces +Z, 90 faces -X; forward = (-sin, cos).
    const fx = -Math.sin(rad), fz = Math.cos(rad);
    let v: any;
    try { v = vehicle.location; } catch { return false; }
    const location = { x: v.x - fx * cfg.radius, y: v.y + cfg.height, z: v.z - fz * cfg.radius };
    let facingLocation: any;
    if (cfg.kind === 'plane') {
      // Aircraft: the camera looks along the rider's exact yaw AND pitch, so
      // `free_camera_controlled` (flies where the camera looks) and the
      // rider's own look agree: look down = dive, look up = climb.
      const prad = pitch * Math.PI / 180, cp = Math.cos(prad);
      facingLocation = { x: location.x + fx * cp * cfg.radius * 2, y: location.y - Math.sin(prad) * cfg.radius * 2, z: location.z + fz * cp * cfg.radius * 2 };
    } else {
      facingLocation = { x: v.x, y: v.y + cfg.pivotY, z: v.z };
    }
    try { player.camera.setCamera('minecraft:free', { location, facingLocation, easeOptions: { easeTime: 0.15, easeType: 'Linear' } }); return true; } catch { return false; }
  };
  // Measured on the Pixel 2026-09-16: `/controlscheme @s set player_relative`
  // typed in chat makes the stick turn the rider; the same command run ONCE
  // from the script on mount did not take (the ride's own scheme lands after
  // it, and a remount reverted a chat-set scheme). So it is re-applied every
  // 10 ticks while riding, through both command paths.
  const scheme = (player: any, value: string): void => {
    try { player.runCommand(`controlscheme @s ${value}`); } catch {}
    try { player.runCommandAsync?.(`controlscheme @s ${value}`)?.catch?.(() => {}); } catch {}
  };
  let schemeTick = 0;
  system.runInterval(() => {
    const riding = new Map<string, { player: any; vehicle: any; cfg: any }>();
    for (const d of dimensions()) {
      let vehicles: any[] = [];
      try { vehicles = d.getEntities({ families: ['craftmatic_vehicle'] }); } catch { continue; }
      for (const vehicle of vehicles) {
        const cfg = byType.get(vehicle.typeId);
        if (!cfg) continue;
        let riders: any[] = [];
        try { riders = vehicle.getComponent('minecraft:rideable')?.getRiders?.() ?? []; } catch {}
        for (const rider of riders) if (rider?.typeId === 'minecraft:player') riding.set(rider.id, { player: rider, vehicle, cfg });
      }
    }
    for (const [id, { player, vehicle, cfg }] of riding) {
      const t = tracked.get(id);
      // Every vehicle, aircraft included, is steered with the joystick under
      // `player_relative` (left/right turns the rider) and watched from the
      // script-driven chase camera. Before 2026-09-16 an aircraft kept the
      // orbit preset, whose drag input orbited the CAMERA and never turned
      // the rider - "no way to turn a mounted vehicle" on touch.
      if (!t || t.typeId !== cfg.typeId) {
        scheme(player, 'set player_relative');
        tracked.set(id, { typeId: cfg.typeId, chase: true });
      } else if (schemeTick % 10 === 0) {
        scheme(player, 'set player_relative');
      }
      if (!chase(player, vehicle, cfg) && !t) applyPreset(player, cfg.preset);
    }
    schemeTick++;
    if (tracked.size) {
      let players: any[] = [];
      try { players = world.getAllPlayers().filter(Boolean); } catch {}
      for (const id of [...tracked.keys()]) {
        if (riding.has(id)) continue;
        const player = players.find((p: any) => p.id === id);
        if (player) { try { player.camera.clear(); } catch {} scheme(player, 'clear'); }
        tracked.delete(id);
      }
    }
  }, 1);
  try { world.afterEvents?.playerLeave?.subscribe?.((ev: any) => tracked.delete(ev.playerId)); } catch {}
}

const vehicleCameraScript = (config: { vehicles: VehicleCameraConfig[] }) =>
  `import { world, system } from "@minecraft/server";\n(${vehicleCameraRuntime.toString()})(${JSON.stringify(config)});\n`;

function blockRgb(state: string): [
    number,
    number,
    number
] { return getBlockColor(state) ?? [145, 145, 140]; }
function blockAlpha(state: string): number {
    const id = state.split('[', 1)[0]!;
    return id === 'minecraft:glass' || id === 'minecraft:glass_pane' || /_stained_glass(?:_pane)?$/.test(id) ? 96 : 255;
}
const PNG_CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++)
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
} return t; })();
function pngCrc(data: Uint8Array) { let c = 0xffffffff; for (const b of data)
    c = PNG_CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function u32(n: number) { return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); }
function concat(...parts: Uint8Array[]) { const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) {
    o.set(p, i);
    i += p.length;
} return o; }
function pngChunk(name: string, data: Uint8Array) { const n = enc.encode(name), body = concat(n, data); return concat(u32(data.length), body, u32(pngCrc(body))); }
/** A 2×2 fully transparent RGBA PNG (the invisible seat entity's texture). */
function transparentPng(): Uint8Array {
    const w = 2, h = 2, raw = new Uint8Array(h * (1 + w * 4));
    let a = 1, b = 0; for (const v of raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
    const z = concat(Uint8Array.of(0x78, 0x01), Uint8Array.of(1, raw.length & 255, raw.length >>> 8, (~raw.length) & 255, ((~raw.length) >>> 8) & 255), raw, u32((b << 16) | a));
    return concat(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', concat(u32(w), u32(h), Uint8Array.of(8, 6, 0, 0, 0))), pngChunk('IDAT', z), pngChunk('IEND', new Uint8Array()));
}
function palettePng(palette: string[]): Uint8Array { const w = 16, h = Math.max(1, Math.ceil(palette.length / 16)), raw = new Uint8Array(h * (1 + w * 4)); for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0;
    for (let x = 0; x < w; x++) {
        const [r, g, b] = blockRgb(palette[y * 16 + x] ?? 'gray'), o = y * (1 + w * 4) + 1 + x * 4;
        raw.set([r, g, b, blockAlpha(palette[y * 16 + x] ?? 'gray')], o);
    }
} let a = 1, b = 0; for (const v of raw) {
    a = (a + v) % 65521;
    b = (b + a) % 65521;
} const blocks: Uint8Array[] = []; for (let p = 0; p < raw.length;) {
    const len = Math.min(65535, raw.length - p), last = p + len === raw.length;
    blocks.push(Uint8Array.of(last ? 1 : 0, len & 255, len >>> 8, (~len) & 255, ((~len) >>> 8) & 255), raw.slice(p, p + len));
    p += len;
} const z = concat(Uint8Array.of(0x78, 0x01), ...blocks, u32((b << 16) | a)); return concat(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', concat(u32(w), u32(h), Uint8Array.of(8, 6, 0, 0, 0))), pngChunk('IDAT', z), pngChunk('IEND', new Uint8Array())); }
export async function buildPlayableAddon(grid: BlockGrid, options: PlayableAddonOptions): Promise<PlayableAddonResult> {
    // A pack of figures alone (a custom minifig from minifigFromSpec) has no blocks and is still a pack.
    if (!grid.countNonAir() && !options.components?.some(c => c.grid.countNonAir()) && !options.figures?.length && !options.minifigCreator)
        throw new Error('Nothing to export — the model has no blocks.');
    const label = options.label ?? options.stem, id = safe(options.stem), mode = options.vehicleMode ?? 'auto';
    // One scale for everything compiled from parts (engine/addon-scale.ts).
    const modelScale = Number.isFinite(options.modelScale) && options.modelScale! > 0 ? options.modelScale! : 1;
    const unitsPerLdu = BEDROCK_UNITS_PER_LDU * modelScale;
    const lduPerBlock = LDU_PER_BLOCK / modelScale;
    // Figures are compiled at the CAPPED scale (never above 1×): a minifig is the player's size, not a giant.
    const figureUnitsPerLdu = BEDROCK_UNITS_PER_LDU * figureModelScale(modelScale);
    const isTimeMachine = /\b10300\b|delorean|de lorean|time machine/i.test(`${id} ${label}`);
    const shortAlias = placementAlias(id);
    const components = options.components?.slice() ?? [];
    const warnings: string[] = [];
    if (!components.length && (mode === 'car' || mode === 'plane' || mode === 'boat'))
        components.push({ id, label, kind: mode, grid, provenance: 'explicit whole-model vehicle override' });
    if (!components.length && mode === 'auto' && isWholeVehicleLabel(label))
        components.push({ id, label, kind: classifyVehicleKind(label, mode)!, grid, provenance: 'whole model identified by source title' });
    if (!components.length && mode === 'auto' && /76252|batcave shadow/i.test(label))
        warnings.push('Batmobile source component was not supplied; the Batcave remains static rather than making the whole cave driveable.');
    const bp = `Craftmatic_${id}_BP/`, rp = `Craftmatic_${id}_RP/`, files: Array<{
        name: string;
        data: Uint8Array;
    }> = [];
    // A BUILD instant, readable as a UTC date in the game's Technical details
    // (pipeline-version.ts): a re-export at another scale or quality must rank
    // newer than the installed pack even when the pipeline did not change.
    const version = packVersionAt();
    // Provenance: the pipeline stamp goes in both pack NAMES so an older pack
    // is readable at a glance in Minecraft's pack list, and in full into
    // `craftmatic-provenance.json` (also spread into the diagnostics).
    const pipelineStamp = options.pipelineStamp ?? currentPipelineStamp();
    const source = options.source ?? null;
    const provenance = packProvenance({ stamp: pipelineStamp, source, version });
    // Manifest UUIDs are keyed on the model's IDENTITY, not on `id`: `id` is the
    // 12-char name stem, so every Hogwarts set shipped one BP/RP uuid and a
    // second import could never be activated beside the first (see packIdentity).
    // The identity takes the RAW label — never the stamped display name below.
    // A stamp in it would make every pipeline build a NEW pack beside the old
    // one instead of an upgrade, which is the stale-folder trap the stamp exists
    // to expose (pinned by "different stamps, same uuid" in playable-addon.test).
    const identity = packIdentity(options.stem, options.label);
    const bpHeader = deterministicUuid(`craftmatic.addon.bp.header:${identity}`), rpHeader = deterministicUuid(`craftmatic.addon.rp.header:${identity}`);
    files.push({ name: bp + 'manifest.json', data: json({ format_version: 2, header: { name: packDisplayName(label, 'Playable', pipelineStamp), description: `Place with /function ${shortAlias}; ride vehicles and use computer screens. ${provenanceSentence(pipelineStamp, source)}`, uuid: bpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'data', uuid: deterministicUuid(`craftmatic.addon.bp.data:${identity}`), version }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: deterministicUuid(`craftmatic.addon.bp.script:${identity}`), version }], dependencies: [{ uuid: rpHeader, version }, { module_name: '@minecraft/server', version: '2.9.0' }, { module_name: '@minecraft/server-ui', version: '2.1.0' }] }) });
    // Vibrant Visuals texture sets are emitted for brick-compiled entities; the
    // manifest must declare the capability or the game ignores the MER/normal maps.
    const pbr = options.pbr ?? true;
    const emitsPbr = pbr && components.some(c => c.bricks && c.bricks.length > 0);
    files.push({ name: rp + 'manifest.json', data: json({ format_version: 2, header: { name: packDisplayName(label, 'Playable Resources', pipelineStamp), description: `Faithful Craftmatic vehicle geometry and HD LEGO textures. ${provenanceSentence(pipelineStamp, source)}`, uuid: rpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'resources', uuid: deterministicUuid(`craftmatic.addon.rp.resources:${identity}`), version }], ...(emitsPbr ? { capabilities: ['pbr'] } : {}) }) });
    files.push({ name: `${bp}craftmatic-provenance.json`, data: json(provenance) });
    const diagnostics: Record<string, LegoGeometryDiagnostics> = {};
    /** Cuboids of the BlockGrid-fallback entities, which have no `LegoGeometryDiagnostics` to carry them. */
    let fallbackCuboids = 0;
    // Bundle authentic embossed LEGO stud & seam textures for Minecraft concrete blocks
    const terrainTextures: Record<string, { textures: string }> = {};
    for (const [colorName, [r, g, b]] of Object.entries(CONCRETE_COLORS)) {
        files.push({ name: `${rp}textures/blocks/concrete_${colorName}.png`, data: generateStudBlockPng(r, g, b, false) });
        terrainTextures[`concrete_${colorName}`] = { textures: `textures/blocks/concrete_${colorName}` };
    }
    files.push({
        name: `${rp}pack_icon.png`,
        data: generateStudBlockPng(220, 32, 32, true),
    });
    const scenery = components.some(c => c.grid === grid) ? new BlockGrid(grid.width, grid.height, grid.length) : grid;
    // What the structure tiles carry: the coloured scenery, or (brick-accurate
    // buildings) invisible colliders under the shell entity - see below.
    let structureGrid = scenery;
    let plan = planStructureTiles(scenery, id, options.maxTile ?? BEDROCK_MAX_TILE);
    /** The collider grid, run-length coded, so the wand can re-lay it at another size (bedrock-placement-pack.ts). */
    let placementColliders: PlacementColliders | undefined;
    /** The moving parts' runtime (`scripts/interactives.js`) and their diagnostics; set with the shell. */
    let interactiveConfig: InteractiveRuntimeConfig | undefined;
    let interactiveReport: unknown[] | undefined;
    /** What the doorway walk found at 100 % (`doorwayWalkSummary`), for the wand. */
    let ixWalkNote: string | undefined;
    const actors: PlacementActor[] = [];
    /** Collision height of every figure NPC type, for scripts/figures.js (bedrock-figure-life.ts). */
    const figureBodies: Record<string, number> = {};
    const extraComponents: PlayableAddonResult['components'] = [];
    /**
     * Every entity this pack declares gets a `texts/en_US.lang` name (and, if
     * `is_spawnable`, a spawn-egg name too) — otherwise Bedrock shows the raw
     * translation key (`entity.craftmatic:f_10303loop_10303_fig1.name`) on its
     * nameplate, spawn egg and creative-inventory tooltip, with nothing logged.
     * Previously only the minifig creator wand + figure had a lang file; every
     * other entity in a model pack (figures, vehicles, shells, the coaster
     * cart, seats, the preview ghost) had none (2026-09-21 pack audit).
     */
    const localisedEntities: Array<{ identifier: string; label: string; spawnable: boolean }> = [];
    const addEntityName = (identifier: string, entityLabel: string, spawnable: boolean): void => {
        localisedEntities.push({ identifier, label: entityLabel, spawnable });
    };
    /** Behaviour + client entity + geometry + render controllers + colour/PBR swatches for one brick-compiled entity. */
    let minifigsEmitted = 0;
    /** Swatch stems already written: a colour is a pack-wide file, not a per-entity one. */
    const emittedSwatches = new Set<string>();
    // The engine default stays `none` (unit tests and golden packs pin the bare
    // form); the PRODUCT default is `hull` at the pipeline/CLI entry since the
    // 2026-09-19 device round: switch seen at 26-28 blocks for the then-default 32,
    // zero content-log errors, near-frame p90 33 -> 17 ms (`output/device-919/lod/LOD-RESULT.md`).
    // That 32 was a root distance and put the hull in front of a camera standing
    // at 10303's tracks; see `DEFAULT_LOD_DISTANCE` and `LodBinding.distance`.
    const lodMode: LodMode = options.lod ?? 'none';
    const lodExplicit = Number.isFinite(options.lodDistance) && options.lodDistance! > 0;
    const lodDistance = lodExplicit ? options.lodDistance! : DEFAULT_LOD_DISTANCE;
    /**
     * Per-entity LOD hull accounting, reported in `craftmatic-diagnostics.json`
     * (nothing silent). `switchDistance` is the camera-to-root distance the
     * controllers test: `lodDistance + radiusBlocks`, capped under the actor's
     * render cull by `planLodSwitch`; `hullWindowBlocks` is how far the camera
     * can travel with the hull on screen before the actor stops drawing.
     */
    const lodHulls: Record<string, { cuboids: number; colours: number; geometries: number; cellBlocks: number; shareOfEntity: number; radiusBlocks: number; switchDistance: number; requestedSwitchDistance: number; renderCullBlocks: number; nearestCubeBlocks: number; hullWindowBlocks: number; switchSource: 'requested' | 'render-cull' }> = {};
    /**
     * Entities whose hull was built and then NOT shipped, because the actor
     * culls before the hull could take over at an acceptable distance. The
     * cuboids saved are named so the decision is auditable from the pack.
     */
    const lodSkipped: Record<string, { reason: string; radiusBlocks: number; requestedSwitchDistance: number; renderCullBlocks: number; latestSwitchDistance: number; nearestCubeBlocks: number; collisionBox: CollisionBox | null; hullCuboidsNotShipped: number }> = {};
    let lodEmptyEmitted = false;
    const emitCompiledEntity = (ecid: string, geo: CompiledLdrawGeometry, behavior: unknown, animations?: ClientAnimations, lodEligible = false): void => {
        if (animations === MINIFIG_CLIENT_ANIMATIONS) minifigsEmitted++;
        // Each geometry holds one LDraw colour and is textured with that
        // colour's flat swatch (box UV: `ldraw-entity-compiler.ts`).
        // A face geometry (`faceAtlas`) samples the entity's own face atlas,
        // alpha-tested (head-face.ts).
        const bindings: MeshBinding[] = geo.meshes.map(m => ({
            geometryId: m.id,
            texture: m.faceAtlas ? `textures/entity/${ecid}_faces` : `textures/entity/${legoMaterialSwatchName(m.material)}`,
            translucent: m.translucent,
            ...(m.faceAtlas ? { alphaTest: true } : {}),
        }));
        for (const m of geo.meshes) if (m.faceAtlas) files.push({ name: `${rp}textures/entity/${ecid}_faces.png`, data: m.faceAtlas.png });
        // Distance LOD (opt-in): a per-colour surface hull of the cubes that were
        // just emitted, bound after the full-detail geometries and selected by
        // camera distance in the render controllers. A figure is never hulled -
        // it is already clamped to a few hundred cuboids and the player stands
        // next to it.
        let lod: LodBinding | undefined;
        if (lodMode === 'hull' && lodEligible) {
            const hull = buildLodHull(ecid, geo, { cellBlocks: DEFAULT_HULL_CELL_BLOCKS });
            if (hull) {
                // The query measures to the ROOT; the plan adds the entity's reach
                // so the camera is at least `lodDistance` from its nearest cube,
                // then fits the switch under the actor's render cull — or drops
                // the hull, since a hull the actor culls before showing is only
                // resident cuboids (10303's 760, 2026-09-21).
                const radiusBlocks = Math.round(hull.radiusBlocks * 10) / 10;
                const collisionBox = collisionBoxOf(behavior);
                const plan = planLodSwitch({ lodDistance, radiusBlocks: hull.radiusBlocks, collisionBox, explicit: lodExplicit });
                if (plan.ship) {
                    lod = { fullCount: bindings.length, distance: plan.switchDistance };
                    for (const mesh of hull.meshes) bindings.push({
                        geometryId: mesh.id,
                        texture: `textures/entity/${legoMaterialSwatchName(mesh.material)}`,
                        translucent: mesh.translucent,
                    });
                    files.push({ name: `${rp}models/entity/${ecid}_lod.geo.json`, data: geoJson(hull.value) });
                    if (!lodEmptyEmitted) {
                        lodEmptyEmitted = true;
                        files.push({ name: `${rp}models/entity/craftmatic_lod_empty.geo.json`, data: geoJson(LOD_EMPTY_GEOMETRY) });
                    }
                    lodHulls[ecid] = {
                        cuboids: hull.cuboids, colours: hull.colours, geometries: hull.meshes.length, cellBlocks: hull.cellBlocks,
                        shareOfEntity: Math.round(hull.cuboids / Math.max(1, geo.diagnostics.cubeCount) * 1000) / 1000,
                        radiusBlocks, switchDistance: plan.switchDistance, requestedSwitchDistance: plan.requestedSwitchDistance,
                        renderCullBlocks: plan.renderCullBlocks, nearestCubeBlocks: plan.nearestCubeBlocks, hullWindowBlocks: plan.hullWindowBlocks, switchSource: plan.switchSource,
                    };
                } else {
                    lodSkipped[ecid] = {
                        reason: plan.reason, radiusBlocks, requestedSwitchDistance: plan.requestedSwitchDistance, renderCullBlocks: plan.renderCullBlocks,
                        latestSwitchDistance: plan.latestSwitchDistance, nearestCubeBlocks: plan.nearestCubeBlocks, collisionBox: collisionBox ?? null, hullCuboidsNotShipped: hull.cuboids,
                    };
                }
            }
        }
        files.push(
            { name: `${bp}entities/${ecid}.json`, data: json(behavior) },
            { name: `${rp}entity/${ecid}.entity.json`, data: json(clientEntity(ecid, bindings, 'entity', animations, lod)) },
            { name: `${rp}models/entity/${ecid}.geo.json`, data: geoJson(geo.value) },
            { name: `${rp}render_controllers/${ecid}.render_controllers.json`, data: json(meshControllers(ecid, bindings, lod)) },
        );
        // One swatch per LDraw colour: exact LDraw RGBA, plus the PBR maps.
        // Shared by every entity in the pack that uses the colour.
        for (const mesh of geo.meshes) {
            if (mesh.faceAtlas) continue; // textured by its own atlas, above
            const name = legoMaterialSwatchName(mesh.material);
            if (emittedSwatches.has(name)) continue;
            emittedSwatches.add(name);
            const swatch = generateLegoMaterialSwatch(mesh.material, { pbr, textureName: name });
            files.push({ name: `${rp}textures/entity/${name}.png`, data: swatch.colorPng });
            if (swatch.merPng && swatch.normalPng && swatch.textureSetJson) {
                files.push(
                    { name: `${rp}textures/entity/${name}_mer.png`, data: swatch.merPng },
                    { name: `${rp}textures/entity/${name}_normal.png`, data: swatch.normalPng },
                    { name: `${rp}textures/entity/${name}.texture_set.json`, data: text(swatch.textureSetJson) },
                );
            }
        }
    };
    let creatorConfig: MinifigCreatorConfig | undefined;
    if (options.minifigCreator) {
        if (Object.keys(options.minifigCreator.slots.minidoll).length) throw new Error('Mini-doll creator export is unavailable: canonical doll rig positions are not measured.');
        const source = options.minifigCreator.slots.minifig;
        const library: MinifigCreatorConfig['library'] = { minifig: {}, minidoll: {} };
        const geometry: Record<string, string> = {}, controllers: Record<string, unknown> = {}, printTextures: Record<string, string> = {};
        const emptyGeometryId = `geometry.${PACK_NAMESPACE}.${id}_mf_empty`;
        geometry.empty = emptyGeometryId;
        files.push({ name: `${rp}models/entity/${id}_mf_empty.geo.json`, data: geoJson({ format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: emptyGeometryId, texture_width: 1, texture_height: 1, visible_bounds_width: 1, visible_bounds_height: 1, visible_bounds_offset: [0, 0, 0] }, bones: MINIFIG_BONES.map(b => ({ name: b.name, ...(b.parent ? { parent: b.parent } : {}), pivot: [0, 0, 0] })) }] }) });
        let cuboids = 0;
        for (const [slot, entries] of Object.entries(source) as Array<[CreatorSlot, NonNullable<typeof source[CreatorSlot]>]>) {
            const optional = slot === 'hair' || slot === 'held_right' || slot === 'held_left' || slot === 'back';
            const emitted: Array<[string, string, string]> = optional ? [['', 'None', '']] : [];
            if (optional) geometry[`${slot}_0`] = emptyGeometryId;
            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index]!;
                const spec = slot === 'torso' ? { torso: { part: entry.part, color: 4 } }
                    : slot === 'head' ? { torso: { part: '973', color: 4 }, head: { part: entry.part, color: 4 } }
                    : slot === 'hair' ? { torso: { part: '973', color: 4 }, hair: { part: entry.part, color: 4 } }
                    : slot === 'hips' ? { torso: { part: '973', color: 4 }, hips: { part: entry.part, color: 4 } }
                    : slot === 'legs' ? (() => { if (entry.part !== '3816') throw new Error(`Creator legs require an explicit known pair; unsupported base ${entry.part}.`); return { torso: { part: '973', color: 4 }, legs: { right: '3816', left: '3817', color: 4 } }; })()
                    : slot === 'arms' ? (() => { if (entry.part !== '3818') throw new Error(`Creator arms require an explicit known pair; unsupported base ${entry.part}.`); return { torso: { part: '973', color: 4 }, arms: { right: '3818', left: '3819', color: 4 } }; })()
                    : slot === 'hands' ? { torso: { part: '973', color: 4 }, hands: { part: entry.part, color: 4 } }
                    : slot === 'held_right' ? { torso: { part: '973', color: 4 }, heldRight: { part: entry.part, color: 4 } }
                    : slot === 'held_left' ? { torso: { part: '973', color: 4 }, heldLeft: { part: entry.part, color: 4 } }
                    : { torso: { part: '973', color: 4 }, cape: { part: entry.part, color: 4 } };
                const assembled = minifigFromSpec(spec as Parameters<typeof minifigFromSpec>[0]);
                const wanted = slot === 'torso' ? 'torso' : slot === 'head' ? 'head' : slot === 'hair' ? 'headwear' : slot === 'back' ? 'back' : slot.startsWith('held') ? 'held' : slot;
                const bricks = assembled.bricks.filter((_, i) => assembled.slots[i] === wanted || (wanted === 'arms' && assembled.slots[i]!.startsWith('arm_')) || (wanted === 'hands' && assembled.slots[i]!.startsWith('hand_')) || (wanted === 'legs' && assembled.slots[i]!.startsWith('leg_')));
                if (!bricks.length) { warnings.push(`${entry.part}: no ${slot} geometry was produced; omitted from creator library.`); continue; }
                const cid = `${id}_mf_${slot}_${index}`;
                const geo = await compileLdrawEntityGeometry(cid, 'figure', bricks, { scale: figureUnitsPerLdu, partGeometry: options.partGeometry, quality: options.minifigCreator.quality ?? options.entityQuality, rig: { bones: assembled.rig.bones, boneOf: assembled.rig.boneOf.filter((_, i) => assembled.slots[i] === wanted || (wanted === 'arms' && assembled.slots[i]!.startsWith('arm_')) || (wanted === 'hands' && assembled.slots[i]!.startsWith('hand_')) || (wanted === 'legs' && assembled.slots[i]!.startsWith('leg_'))) }, wholeModel: true, pbr,
                    // Canonical minifig feet are y=72 LDU. Every library slot
                    // shares that origin; never recenter a head at its own floor.
                    originLdu: [0, 72, 0], inheritMaterialId: true, faceTextures: false });
                diagnostics[cid] = geo.diagnostics; cuboids += geo.diagnostics.cubeCount;
                const printMeshes = geo.meshes.filter(candidate => candidate.material.colorId !== 16);
                if (printMeshes.length > MAX_PRINT_LAYERS) {
                    warnings.push(`${entry.part}: rejected from creator library; ${printMeshes.length} fixed print layers exceed the ${MAX_PRINT_LAYERS}-layer limit.`);
                    continue;
                }
                files.push({ name: `${rp}models/entity/${cid}.geo.json`, data: geoJson(geo.value) });
                const mesh = geo.meshes.find(candidate => candidate.material.colorId === 16); if (!mesh) { warnings.push(`${entry.part}: no inherited-colour base mesh was produced; omitted from creator library.`); continue; }
                const key = `${slot}_${emitted.length}`; geometry[key] = mesh.id;
                // A printed part has one symbolic/base-colour mesh plus one or
                // more explicit-colour meshes.  Main geometry remains slot
                // tinted; each print layer gets its own fixed swatch controller.
                for (const [layer, print] of printMeshes.entries()) {
                    const printKey = `${key}_print_${layer}`;
                    geometry[printKey] = print.id;
                    const textureKey = `print_${slot}_${emitted.length}_${layer}`;
                    const textureName = legoMaterialSwatchName(print.material);
                    printTextures[textureKey] = `textures/entity/${textureName}`;
                    if (!emittedSwatches.has(textureName)) { emittedSwatches.add(textureName); const swatch = generateLegoMaterialSwatch(print.material, { pbr, textureName }); files.push({ name: `${rp}textures/entity/${textureName}.png`, data: swatch.colorPng }); }
                    controllers[`controller.render.${PACK_NAMESPACE}.${id}_mf_${slot}_${emitted.length}_print_${layer}`] = { arrays: { geometries: { 'Array.p': ['Geometry.empty', `Geometry.${printKey}`] } }, geometry: `Array.p[q.property('craftmatic:${slot}') == ${emitted.length}]`, materials: [{ '*': 'Material.default' }], textures: [`Texture.${textureKey}`] };
                }
                emitted.push([entry.part, entry.label ?? entry.part, entry.group ?? 'Other']);
            }
            library.minifig[slot] = emitted;
            if (emitted.length) controllers[`controller.render.${PACK_NAMESPACE}.${id}_mf_${slot}`] = { arrays: { geometries: { 'Array.g': emitted.map((_, i) => `Geometry.${slot}_${i}`) }, textures: { 'Array.swatch': (options.minifigCreator.colours ?? MINIFIG_CREATOR_COLOURS).map((_, i) => `Texture.sw_${i}`) } }, geometry: `Array.g[q.property('craftmatic:${slot}')]`, textures: [`Array.swatch[q.property('craftmatic:c_${slot}')]`], materials: [{ '*': 'Material.default' }] };
        }
        const colours = (options.minifigCreator.colours ?? MINIFIG_CREATOR_COLOURS).map(color => [color, `Colour ${color}`] as [number, string]);
        const textures: Record<string, string> = { ...printTextures }; for (let i = 0; i < colours.length; i++) { const material = resolveLdrawEntityMaterial(colours[i]![0]); const name = legoMaterialSwatchName(material); textures[`sw_${i}`] = `textures/entity/${name}`; if (!emittedSwatches.has(name)) { emittedSwatches.add(name); const swatch = generateLegoMaterialSwatch(material, { pbr, textureName: name }); files.push({ name: `${rp}textures/entity/${name}.png`, data: swatch.colorPng }); } }
        const defaults: Record<string, number> = { 'craftmatic:family': 0 };
        const defaultColours: Partial<Record<CreatorSlot, number>> = { torso: 4, arms: 4, head: 14, hands: 14, hips: 1, legs: 1 };
        for (const slot of Object.keys(library.minifig) as CreatorSlot[]) { defaults[`craftmatic:${slot}`] = 0; defaults[`craftmatic:c_${slot}`] = Math.max(0, colours.findIndex(([color]) => color === (defaultColours[slot] ?? 0))); }
        const figureId = `${PACK_NAMESPACE}:${entityId(`${id}_minifig`, 'f')}`;
        creatorConfig = { id, label, itemId: `${PACK_NAMESPACE}:${id}_minifig_wand`, shortAlias: `mf_${id.slice(-6)}`, figureType: figureId, library, colours, firstTranslucentColour: 43, defaults: { minifig: defaults, minidoll: defaults }, presets: options.minifigCreator.presets ?? [], worldCap: 200, savedCap: 100, pageSize: 8 };
        const properties: Record<string, unknown> = {}; for (const [slot, entries] of Object.entries(library.minifig)) { properties[`craftmatic:${slot}`] = { type: 'int', range: [0, Math.max(0, entries.length - 1)], default: 0, client_sync: true }; properties[`craftmatic:c_${slot}`] = { type: 'int', range: [0, colours.length - 1], default: 0, client_sync: true }; }
        properties['craftmatic:family'] = { type: 'int', range: [0, 0], default: 0, client_sync: true }; properties['craftmatic:draft'] = { type: 'bool', default: false, client_sync: true };
        const creatorBehavior = { format_version: ENTITY_FORMAT_VERSION, 'minecraft:entity': { description: { identifier: figureId, is_spawnable: true, is_summonable: true, properties }, components: { 'minecraft:type_family': { family: ['craftmatic_figure'] }, 'minecraft:nameable': {}, 'minecraft:persistent': {}, 'minecraft:physics': { has_gravity: true, has_collision: true }, 'minecraft:collision_box': { width: .6, height: 1.8 }, 'minecraft:health': { value: 20, max: 20 } }, component_groups: { 'craftmatic:npc': { 'minecraft:movement': { value: .18 }, 'minecraft:movement.basic': {}, 'minecraft:navigation.walk': { can_open_doors: true, can_pass_doors: true }, 'minecraft:behavior.random_stroll': { priority: 6, speed_multiplier: .8 }, 'minecraft:behavior.look_at_player': { priority: 7, look_distance: 6, probability: .02 } } }, events: { 'craftmatic:release': { add: { component_groups: ['craftmatic:npc'] } }, 'craftmatic:npc_off': { remove: { component_groups: ['craftmatic:npc'] } } } } };
        files.push({ name: `${bp}entities/${id}_minifig.json`, data: json(creatorBehavior) }, { name: `${rp}entity/${id}_minifig.entity.json`, data: json({ format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: figureId, materials: { default: 'entity_alphablend' }, textures, geometry, render_controllers: Object.keys(controllers), animations: MINIFIG_CLIENT_ANIMATIONS.animations, scripts: { animate: MINIFIG_CLIENT_ANIMATIONS.animate } } } }) }, { name: `${rp}animations/${id}_minifig.animation.json`, data: json(MINIFIG_ANIMATIONS) }, { name: `${rp}render_controllers/${id}_minifig.render_controllers.json`, data: json({ format_version: '1.8.0', render_controllers: controllers }) }, { name: `${bp}items/${id}_minifig_wand.json`, data: json({ format_version: '1.20.80', 'minecraft:item': { description: { identifier: `${PACK_NAMESPACE}:${id}_minifig_wand`, menu_category: { category: 'items' } }, components: { 'minecraft:icon': 'brick', 'minecraft:max_stack_size': 1 } } }) });
        addEntityName(figureId, `${label} Custom Minifig`, true);
        warnings.push(`${label}: creator library compiled ${cuboids} cuboids across ${Object.values(library.minifig).reduce((n, a) => n + a.length, 0)} selectable minifig parts. Mini-dolls are excluded because their canonical rig is unmeasured.`);
    }
    // Brick-accurate building: the scenery's parts compiled as one static
    // entity on the grid's own frame, over invisible colliders that follow
    // the part heights (bedrock-building-shell.ts).
    if (options.shell && options.shell.bricks.length && scenery.countNonAir()) {
        const rawShell = `${id}_shell`;
        const shellId = entityId(rawShell, 'b');
        options.onProgress?.(`compiling ${label} brick geometry`, 72);
        try {
            const sgeo = await compileLdrawEntityGeometry(shellId, 'prop', options.shell.bricks, {
                scale: unitsPerLdu, frame: [...SHELL_FRAME], wholeModel: true, partGeometry: options.partGeometry,
                quality: LEGO_SHELL_QUALITY[options.entityQuality ?? 'balanced'], pbr,
                // Lit from open sky above the roof, not from inside the colliders (Pixel round 4: three shells near-black).
                originAboveModel: true,
            });
            diagnostics[shellId] = sgeo.diagnostics;
            warnings.push(...sgeo.warnings.filter(w => !/front\/rear direction/.test(w)));
            emitCompiledEntity(shellId, sgeo, shellBehavior(shellId, sgeo.sizeBlocks), undefined, true);
            addEntityName(`${PACK_NAMESPACE}:${shellId}`, `${label} bricks`, false);
            const at = sceneGridPoint(options.shell.frame, sgeo.originLdu);
            actors.push({ typeId: `${PACK_NAMESPACE}:${shellId}`, label: `${label} bricks`, x: at[0], y: at[1] + sgeo.originLiftBlocks, z: at[2], yaw: 0 });
            extraComponents.push({ id: shellId, label: `${label} bricks`, kind: 'shell', provenance: `${options.shell.bricks.length} parts compiled as the building's visible geometry` });
            // The model's moving parts, each its own hinged entity on the
            // shell's frame (bedrock-interactives.ts). A part that is not a
            // doorway keeps its closed geometry in the colliders (a cupboard,
            // a window pane, a turntable's load); a doorway's closed cells are
            // laid by the runtime, so its boxes stay out of the static grid.
            const staticIxBoxes: Array<{ min: Vec3; max: Vec3 }> = [];
            const compiledIx: Array<{ it: SceneInteractive; typeId: string; label: string; hit: InteractiveHitboxes }> = [];
            const ixCounts = new Map<string, number>();
            // Tap boxes that follow each part's own shape, kept off each other
            // and off the seats before anything is compiled (bedrock-interactives.ts).
            const ixFrame = options.interactives?.frame;
            // The pipeline hands them in already separated (it.hit); a caller that did not gets them shaped and separated here.
            const ixHits = (options.interactives?.items ?? []).map(it => ({ origin: sceneGridPoint(ixFrame!, it.anchorLdu), hit: it.hit ?? interactiveHitboxes(it, p => sceneGridPoint(ixFrame!, p)) }));
            const separated = (options.interactives?.items ?? []).every(it => it.hit) ? { shrunk: 0, dropped: 0 } : separateHitboxes(ixHits, (options.seats ?? []).map(s => [s.x, s.y, s.z]));
            if (separated.shrunk || separated.dropped) warnings.push(`${label}: ${separated.shrunk} tap box shrink step${separated.shrunk === 1 ? '' : 's'} and ${separated.dropped} dropped box${separated.dropped === 1 ? '' : 'es'} keep the moving parts' tap boxes off each other and off the seats.`);
            for (const [ixIndex, it] of (options.interactives?.items ?? []).entries()) {
                // A part separation emptied (a caller that did not filter them out, as the pipeline does) keeps its own boxes rather than none.
                const hit = ixHits[ixIndex]!.hit.closed.length && ixHits[ixIndex]!.hit.open.length ? ixHits[ixIndex]!.hit : interactiveHitboxes(it, p => sceneGridPoint(ixFrame!, p));
                const noun = interactiveNoun(it);
                const n = (ixCounts.get(noun) ?? 0) + 1;
                ixCounts.set(noun, n);
                const ixId = entityId(`${id}_${noun.toLowerCase().replace(/[^a-z]+/g, '_')}_${n}`, 'x');
                const typeId = `${PACK_NAMESPACE}:${ixId}`;
                const ixLabel = `${noun} ${n}`;
                options.onProgress?.(`compiling ${label} ${ixLabel.toLowerCase()}`, 73);
                try {
                    const igeo = await compileLdrawEntityGeometry(ixId, 'prop', it.bricks, {
                        scale: unitsPerLdu, frame: [...SHELL_FRAME], wholeModel: true, partGeometry: options.partGeometry,
                        quality: LEGO_SHELL_QUALITY[options.entityQuality ?? 'balanced'], pbr,
                        rig: interactiveRig(it.bricks.length, it.pivotLdu, it.axisLdu, it.anchorLdu), originLdu: it.anchorLdu,
                    });
                    diagnostics[ixId] = igeo.diagnostics;
                    // A sliding part (a drawer, a roller or sliding door) eases its distance; a hinged one its angle.
                    const rate = (it.slide ? Math.abs(it.angleDeg) : Math.max(Math.abs(it.angleDeg), OPEN_DEG[it.kind])) / SWING_SECONDS;
                    const anim = interactiveAnimation(typeId, rate, it.slide ? unitsPerLdu : undefined);
                    emitCompiledEntity(ixId, igeo, interactiveBehavior(typeId, it, hit), { animations: { turn: anim.id }, animate: ['turn'], initialize: anim.initialize, preAnimation: anim.preAnimation });
                    files.push({ name: `${rp}animations/${ixId}.animation.json`, data: json(anim.file) });
                    addEntityName(typeId, `${label} ${ixLabel.toLowerCase()}`, false);
                    const at = sceneGridPoint(options.interactives!.frame, igeo.originLdu);
                    actors.push({ typeId, label: `${label} ${ixLabel.toLowerCase()}`, x: at[0], y: at[1] + igeo.originLiftBlocks, z: at[2], yaw: 0, interactive: compiledIx.length });
                    extraComponents.push({ id: ixId, label: `${label} ${ixLabel.toLowerCase()}`, kind: 'shell', provenance: `${it.bricks.length} source placement${it.bricks.length === 1 ? '' : 's'} (${it.part}) hinged at the measured ${it.kind === 'turnable' ? 'spin axis' : 'hinge'}` });
                    if (!PASSAGE_KINDS.has(it.kind)) staticIxBoxes.push(...(igeo.partBoxesLdu ?? []));
                    compiledIx.push({ it, typeId, label: ixLabel, hit });
                } catch (e) {
                    warnings.push(`${label}: ${ixLabel.toLowerCase()} (${it.part}) could not be compiled (${e instanceof Error ? e.message : String(e)}); it is missing from the build.`);
                }
            }
            const colliders = buildColliderGrid(scenery, [...(sgeo.partBoxesLdu ?? []), ...staticIxBoxes], options.shell.frame, options.colliderKeepClear);
            if (compiledIx.length) {
                const ixPlans = planInteractiveColliders(colliders.grid, compiledIx.map(c => c.it), options.shell.frame);
                const items: InteractiveRuntimeItem[] = compiledIx.map((c, k) => interactiveRuntimeItem(c.it, c.typeId, c.label, ixPlans[k] ?? null));
                linkSharedDoorways(items);
                // The hinge in the model's block frame (the walk preview swings the leaf about it; the runtime ignores it).
                items.forEach((item, k) => {
                    const it = compiledIx[k]!.it, f = options.shell!.frame;
                    const p = sceneGridPoint(f, it.pivotLdu), q = sceneGridPoint(f, [it.pivotLdu[0] + it.axisLdu[0] * LDU_PER_BLOCK, it.pivotLdu[1] + it.axisLdu[1] * LDU_PER_BLOCK, it.pivotLdu[2] + it.axisLdu[2] * LDU_PER_BLOCK]);
                    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
                    item.pivot = [p[0], p[1], p[2]].map(v => Math.round(v * 1e4) / 1e4) as [number, number, number];
                    item.axis = d.map(v => Math.round(v / l * 1e4) / 1e4) as [number, number, number];
                    if (it.leaf) {
                        const nq = sceneGridPoint(f, [it.pivotLdu[0] + it.leaf.normal[0] * LDU_PER_BLOCK, it.pivotLdu[1] + it.leaf.normal[1] * LDU_PER_BLOCK, it.pivotLdu[2] + it.leaf.normal[2] * LDU_PER_BLOCK]);
                        const nd = [nq[0] - p[0], nq[1] - p[1], nq[2] - p[2]], nl = Math.hypot(nd[0]!, nd[1]!, nd[2]!) || 1;
                        item.normal = nd.map(v => Math.round(v / nl * 1e4) / 1e4) as [number, number, number];
                        // The closed leaf in model blocks: the runtime's occupancy test (`obstructed`).
                        const q4 = (v: number[]): number[] => v.map(x => Math.round(x * 1e4) / 1e4);
                        const c0 = sceneGridPoint(f, it.leaf.corner), ca = sceneGridPoint(f, [it.leaf.corner[0] + it.leaf.along[0], it.leaf.corner[1] + it.leaf.along[1], it.leaf.corner[2] + it.leaf.along[2]]), cu = sceneGridPoint(f, [it.leaf.corner[0] + it.leaf.up[0], it.leaf.corner[1] + it.leaf.up[1], it.leaf.corner[2] + it.leaf.up[2]]);
                        item.leaf = { c: q4(c0), a: q4([ca[0] - c0[0], ca[1] - c0[1], ca[2] - c0[2]]), u: q4([cu[0] - c0[0], cu[1] - c0[1], cu[2] - c0[2]]), n: q4(item.normal), t: Math.round(it.leaf.thicknessLdu * f.scale / f.cellXZ * 1e4) / 1e4 };
                    }
                    // The tap boxes the entity ships (turn 0, 100 %): the runtime's line-of-sight test.
                    item.hit = { c: compiledIx[k]!.hit.closed, o: compiledIx[k]!.hit.open };
                    // A sliding part: model blocks per LDU along its axis (the Walk add-on moves it by this).
                    if (it.slide) item.slide = Math.round(l / LDU_PER_BLOCK * 1e5) / 1e5;
                });
                pairDoubleDoors(items);
                interactiveConfig = { family: INTERACTIVE_FAMILY, property: INTERACTIVE_PROPERTY, label, dims: { width: colliders.grid.width, height: colliders.grid.height, length: colliders.grid.length }, colliders: { block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE }, items, turnProperty: INTERACTIVE_TURN_PROPERTY, sizeProperty: INTERACTIVE_SIZE_PROPERTY };
                interactiveReport = compiledIx.map((c, k) => ({
                    type: c.typeId, kind: c.it.kind, part: c.it.part, label: c.label, parts: c.it.bricks.length, angleDeg: items[k]!.angle,
                    offGridDeg: c.it.offGridDeg, ...(items[k]!.opening ? { openingBlocks: items[k]!.opening } : {}),
                    ...(items[k]!.passSize !== undefined ? { passSize: items[k]!.passSize } : {}),
                    blockingCells: items[k]!.blocking.length, cleared: ixPlans[k]?.cleared ?? 0, passageCleared: ixPlans[k]?.passageCleared ?? 0, thresholdTreads: ixPlans[k]?.treads ?? 0, hitboxes: { closed: c.hit.closed.length, open: c.hit.open.length },
                    ...(c.it.sweep ? { sweepHits: c.it.sweep } : {}),
                }));
                warnings.push(interactiveSummary(label, items));
            }
            structureGrid = colliders.grid;
            plan = planStructureTiles(structureGrid, id, options.maxTile ?? BEDROCK_MAX_TILE);
            const runs = encodeColliderRuns(structureGrid, COLLIDER_BLOCK_ID);
            placementColliders = { width: structureGrid.width, height: structureGrid.height, length: structureGrid.length, block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE, runs: runs.runs, keptCells: runs.keptCells };
            if (interactiveConfig) {
                // Walk every doorway at 100 % over the blocks this pack ships, so
                // the wand's door count is the walk's, not the leaf measurement's
                // (device 2026-09-24d: "6/6 clear" against 5 walkable, 41732).
                const walks = doorwayWalkSummary({ cells: colliderSourceCells(placementColliders), dims: interactiveConfig.dims, interactives: interactiveConfig });
                if (walks.note) { ixWalkNote = walks.note; warnings.push(`${label}: ${walks.note}`); }
                // Minecraft only hands a tap on an entity to the script within the player's reach
                // (device 2026-09-24e: nothing from 3.5 blocks and more), so say where to stand.
                ixWalkNote = [INTERACTIVE_REACH_NOTE, ixWalkNote].filter(Boolean).join(' ');
                if (interactiveReport) interactiveReport = interactiveReport.map((r, k) => ({ ...(r as object), ...(walks.verdicts[k] ? { walk100: walks.verdicts[k] } : {}) }));
            }
            files.push(
                { name: `${bp}blocks/collider.json`, data: json(colliderBlockDefinition()) },
                // Only `sound` belongs here: the BP block already declares
                // `minecraft:material_instances` with this texture, which wins
                // for a data-driven block, so RP `blocks.json`'s own `textures`
                // key is silently ignored (dead config left in for the next
                // editor to trust). Trim it here rather than at
                // COLLIDER_BLOCKS_JSON's definition, which other packs/tests share.
                { name: `${rp}blocks.json`, data: json({ format_version: COLLIDER_BLOCKS_JSON.format_version, [COLLIDER_BLOCK_ID]: { sound: COLLIDER_BLOCKS_JSON[COLLIDER_BLOCK_ID].sound } }) },
                { name: `${rp}textures/blocks/craftmatic_collider.png`, data: transparentPng() },
            );
            Object.assign(terrainTextures, COLLIDER_TERRAIN_TEXTURE);
            warnings.push(`${label}: brick-accurate building - ${sgeo.diagnostics.cubeCount} cuboids at ${sgeo.diagnostics.quality.microcellLdu} LDU over ${colliders.stats.colliders} invisible collider blocks (${colliders.stats.partial} part-height, ${colliders.stats.kept} doors/lights kept; laid from the shell's own geometry: ${colliders.stats.emptyVoxelsDropped} voxel cells with nothing to see dropped, ${colliders.stats.geometryBlocksAdded} geometry blocks the voxels missed added).`);
        } catch (e) {
            warnings.push(`${label}: the brick-accurate building could not be compiled (${e instanceof Error ? e.message : String(e)}); exported as blocks.`);
        }
    }
    // A door too small for a vanilla two-block opening cannot stay inside the
    // monolithic shell: the shell cannot hide only that leaf when the wand is
    // enlarged. Compile the exact source placement as its own static actor on
    // the same source/grid frame, then let PlacementActor retire it precisely
    // when runtimeDoorCandidates hangs the interactive vanilla permutation.
    for (const [index, leaf] of (options.leafActors ?? []).entries()) {
        if (!leaf.bricks.length) continue;
        const leafId = entityId(`${id}_door_leaf_${index + 1}`, 'd');
        options.onProgress?.(`compiling ${label} door leaf ${index + 1}`, 74);
        try {
            const lgeo = await compileLdrawEntityGeometry(leafId, 'prop', leaf.bricks, {
                scale: unitsPerLdu, frame: [...SHELL_FRAME], wholeModel: true, partGeometry: options.partGeometry,
                quality: LEGO_SHELL_QUALITY[options.entityQuality ?? 'balanced'], pbr,
                originAboveModel: true,
            });
            diagnostics[leafId] = lgeo.diagnostics;
            warnings.push(...lgeo.warnings.filter(w => !/front\/rear direction/.test(w)));
            emitCompiledEntity(leafId, lgeo, shellBehavior(leafId, lgeo.sizeBlocks), undefined, true);
            addEntityName(`${PACK_NAMESPACE}:${leafId}`, `${label} door leaf`, false);
            const at = sceneGridPoint(leaf.frame, lgeo.originLdu);
            actors.push({
                typeId: `${PACK_NAMESPACE}:${leafId}`,
                label: `${label} door leaf`,
                x: at[0], y: at[1] + lgeo.originLiftBlocks, z: at[2], yaw: 0,
                maxSizeExclusive: leaf.maxSizeExclusive,
                doorCandidateIndex: leaf.doorCandidateIndex,
                hideAt100: leaf.hideAt100,
            });
            extraComponents.push({ id: leafId, label: `${label} door leaf`, kind: 'shell', provenance: `${leaf.bricks.length} exact source door placement${leaf.bricks.length === 1 ? '' : 's'} visible below ${leaf.maxSizeExclusive}%` });
        } catch (e) {
            warnings.push(`${label}: a source door leaf could not be compiled (${e instanceof Error ? e.message : String(e)}); its interactive vanilla replacement remains available at ${leaf.maxSizeExclusive}%.`);
        }
    }
    let timeMachineConfig: { typeId: string; width: number; height: number; length: number } | undefined;
    const driverVehicles: Array<{ typeId: string; kind: 'car' | 'plane' | 'boat'; label: string }> = [];
    const cameraVehicles: VehicleCameraConfig[] = [];
    const unmapped = new Set<string>();
    const cameraStyle: VehicleCameraStyle = options.cameraStyle ?? 'orbit';
    /** Writes the orbit preset (and, for ground vehicles, the boom preset) and returns the id the runtime applies. */
    const emitCameraPresets = (cid: string, kind: PlayableKind, size: { width: number; height: number; length: number }): VehicleCameraConfig => {
        const chase = chaseCameraPreset(cid, kind, size);
        files.push({ name: `${bp}cameras/presets/${cid}_chase.json`, data: json(chase.value) });
        const base = { typeId: `${PACK_NAMESPACE}:${cid}`, kind, radius: chase.radius, height: Math.round((size.height * 0.75 + 1.5) * 100) / 100, pivotY: Math.round(Math.max(0.5, size.height * 0.5) * 100) / 100 };
        if (kind === 'plane') return { ...base, preset: chase.id };
        const boom = boomCameraPreset(cid, size);
        files.push({ name: `${bp}cameras/presets/${cid}_boom.json`, data: json(boom.value) });
        return { ...base, preset: cameraStyle === 'boom' ? boom.id : chase.id };
    };
    // Registered after the shell block above, which may add the collider tile.
    files.push({ name: `${rp}textures/terrain_texture.json`, data: json({ resource_pack_name: `craftmatic_${id}`, texture_name: 'atlas.terrain', texture_data: terrainTextures }) });
    for (let i = 0; i < plan.length; i++) {
        const tile = plan[i]!, out = encodeMcstructureTile(structureGrid, tile);
        for (const state of out.unmapped) unmapped.add(state);
        files.push({ name: `${bp}structures/${PACK_NAMESPACE}/${tile.name}.mcstructure`, data: out.bytes });
        options.onProgress?.(`encoding structure ${i + 1}/${plan.length}`, Math.round((i + 1) / plan.length * 70));
    }
    for (const c of components) {
        const rawCid = safe(`${id}_${c.id}`).length === `${id}_${c.id}`.length ? safe(`${id}_${c.id}`) : safe(`${id.slice(0, 24)}_${c.id.slice(0, 12)}_${deterministicUuid(`${id}:${c.id}`).slice(0, 8)}`);
        const cid = entityId(rawCid, 'v');
        const fullTypeId = `${PACK_NAMESPACE}:${cid}`;
        const requestedFacing = options.vehicleFacing && options.vehicleFacing !== 'auto' ? options.vehicleFacing : c.forwardDirection ?? 'auto';
        // A brick component's nose is inferred by the compiler from its parts
        // (vehicle-facing.ts) and comes back resolved; a grid-only component
        // has no parts to read, so an unspecified car facing stays a guess.
        let ldrawGeo: CompiledLdrawGeometry | undefined;
        let facing: VehicleFacing = requestedFacing;
        if (c.bricks && c.bricks.length > 0) {
            options.onProgress?.(`compiling ${c.label} geometry`);
            ldrawGeo = await compileLdrawEntityGeometry(cid, c.kind, c.bricks, {
                scale: unitsPerLdu,
                facing: requestedFacing,
                userSeatAnchor: c.seatAnchor,
                partGeometry: options.partGeometry,
                quality: options.entityQuality,
                pbr,
            });
            facing = ldrawGeo.facing;
        } else if (c.kind === 'car' && facing === 'auto') {
            warnings.push(`${c.label}: front/rear direction was not identifiable from source geometry; select an explicit vehicle facing if it drives backward.`);
        }
        const layout = componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing);
        const componentIsTimeMachine = isTimeMachine && c.kind === 'car' && !timeMachineConfig;
        if (componentIsTimeMachine)
            timeMachineConfig = { typeId: fullTypeId, width: layout.width, height: layout.height, length: layout.length };
        else if (c.kind === 'car' || c.kind === 'plane' || c.kind === 'boat')
            driverVehicles.push({ typeId: fullTypeId, kind: c.kind, label: c.label });
        if (ldrawGeo) {
            warnings.push(...ldrawGeo.warnings);
            diagnostics[cid] = ldrawGeo.diagnostics;
            emitCompiledEntity(cid, ldrawGeo, behaviorEntity(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing, c.seatAnchor, componentIsTimeMachine, options.seatCount ?? 1, ldrawGeo.seatPosition, ldrawGeo.collisionBox, ldrawGeo.sizeBlocks), undefined, true);
            cameraVehicles.push(emitCameraPresets(cid, c.kind, ldrawGeo.sizeBlocks));

            // Secondary objects the compiler found beside the vehicle (see
            // EntityExtra): figures wander as minifig NPCs, a wheeled second
            // vehicle is rideable, a wheel-less one is a static prop. They are
            // placed relative to the vehicle's actor in its own levelled frame,
            // so they stand where the source put them, and turn with the wand.
            const extras = options.mainVehicleOnly ? [] : ldrawGeo.extras.filter(e => e.role !== 'prop');
            const primaryPos = componentSpawnPoint(c, grid);
            let figureIndex = 0, subIndex = 0;
            for (const extra of extras) {
                const ekind: EntityKind = extra.role === 'figure' ? 'figure' : extra.wheels >= 2 ? 'car' : 'prop';
                const ecid = `${cid}_${ekind === 'figure' ? `fig${++figureIndex}` : `sub${++subIndex}`}`;
                const elabel = ekind === 'figure' ? `${c.label} figure ${figureIndex}` : ekind === 'car' ? `${c.label} vehicle ${subIndex}` : `${c.label} prop ${subIndex}`;
                options.onProgress?.(`compiling ${elabel}`);
                let egeo: CompiledLdrawGeometry;
                try {
                    egeo = await compileLdrawEntityGeometry(ecid, ekind, extra.bricks, {
                        scale: ekind === 'figure' ? figureUnitsPerLdu : unitsPerLdu,
                        ...(extra.facingLdu ? { facing: snapFacing(extra.facingLdu) } : {}),
                        partGeometry: options.partGeometry, quality: options.entityQuality, pbr,
                    });
                } catch (e) {
                    warnings.push(`${elabel}: could not be compiled (${e instanceof Error ? e.message : String(e)}); left out.`);
                    continue;
                }
                diagnostics[ecid] = egeo.diagnostics;
                warnings.push(...egeo.warnings.filter(w => !/front\/rear direction/.test(w)));
                if (ekind === 'figure') figureBodies[`${PACK_NAMESPACE}:${ecid}`] = figureCollisionBox(egeo.sizeBlocks, options.figureCollisionHeight).height;
                const behavior = ekind === 'figure' ? figureBehavior(ecid, egeo.sizeBlocks, options.figureCollisionHeight)
                    : ekind === 'prop' ? propBehavior(ecid, egeo.collisionBox)
                    : behaviorEntity(ecid, 'car', c.grid, c.sceneScale, c.longitudinalAxis, egeo.facing, undefined, false, 1, egeo.seatPosition, egeo.collisionBox, egeo.sizeBlocks);
                emitCompiledEntity(ecid, egeo, behavior, ekind === 'figure' && egeo.figure ? MINIFIG_CLIENT_ANIMATIONS : undefined, ekind !== 'figure');
                addEntityName(`${PACK_NAMESPACE}:${ecid}`, elabel, true);
                if (ekind === 'car') {
                    driverVehicles.push({ typeId: `${PACK_NAMESPACE}:${ecid}`, kind: 'car', label: elabel });
                    cameraVehicles.push(emitCameraPresets(ecid, 'car', egeo.sizeBlocks));
                }
                // A rigged figure faces exactly where its torso pointed (not the nearest axis).
                const place = extraPlacement(ldrawGeo, extra, egeo.facing, layout.actorYaw, egeo.figure?.facingLdu, lduPerBlock);
                actors.push({ typeId: `${PACK_NAMESPACE}:${ecid}`, label: elabel, x: primaryPos.x + place.dx, y: primaryPos.y + place.dy, z: primaryPos.z + place.dz, yaw: place.yaw });
                extraComponents.push({ id: ecid, label: elabel, kind: ekind, provenance: `${extra.role} beside ${c.label} (${extra.reason})` });
            }
            const left = ldrawGeo.extras.length - extras.length;
            if (options.mainVehicleOnly && ldrawGeo.extras.some(e => e.role !== 'prop')) warnings.push(`${c.label}: ${ldrawGeo.extras.filter(e => e.role !== 'prop').length} separate object${ldrawGeo.extras.filter(e => e.role !== 'prop').length === 1 ? '' : 's'} beside the vehicle left out (main vehicle only).`);
            else if (left) warnings.push(`${c.label}: ${left} prop${left === 1 ? '' : 's'} beside the vehicle (a stand, a plaque) not exported.`);
        } else {
            files.push({ name: `${bp}entities/${cid}.json`, data: json(behaviorEntity(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing, c.seatAnchor, componentIsTimeMachine, options.seatCount ?? 1)) });
            cameraVehicles.push(emitCameraPresets(cid, c.kind, { width: layout.width, height: layout.height, length: layout.length }));
            const geo = geometry(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing);
            fallbackCuboids += geo.cubeCount;
            files.push({ name: `${rp}entity/${cid}.entity.json`, data: json(clientEntity(cid, gridMeshBindings(cid, geo.meshIds))) }, { name: `${rp}models/entity/${cid}.geo.json`, data: geoJson(geo.value) }, { name: `${rp}render_controllers/${cid}.render_controllers.json`, data: json(meshControllers(cid, gridMeshBindings(cid, geo.meshIds))) }, { name: `${rp}textures/entity/${cid}.png`, data: generateEntityLegoAtlasPng(geo.palette, blockRgb, blockAlpha) });
        }
        addEntityName(fullTypeId, c.label, true);
        actors.push({ typeId: fullTypeId, label: c.label, ...componentSpawnPoint(c, grid), yaw: layout.actorYaw });
    }
    // Figures found in the scenery: one minifig NPC type each, standing where the source put them.
    const figureKindCounts: Record<string, number> = {};
    /** Actor index of each scene figure, so a seated one can be told which seat actor to ride. */
    const figureActorIndex = new Map<number, number>();
    for (const [k, fig] of (options.figures ?? []).entries()) {
        const rawFig = `${id}_fig${k + 1}`;
        const fcid = entityId(rawFig, 'f');
        const flabel = `${label} figure ${k + 1}`;
        options.onProgress?.(`compiling ${flabel}`);
        let fgeo: CompiledLdrawGeometry;
        try {
            fgeo = await compileLdrawEntityGeometry(fcid, 'figure', fig.bricks, { scale: figureUnitsPerLdu, facing: snapFacing(fig.facingLdu), partGeometry: options.partGeometry, quality: options.entityQuality, pbr });
        } catch (e) {
            warnings.push(`${flabel}: could not be compiled (${e instanceof Error ? e.message : String(e)}); left out.`);
            continue;
        }
        diagnostics[fcid] = fgeo.diagnostics;
        warnings.push(...fgeo.warnings.filter(w => !/front\/rear direction/.test(w)));
        emitCompiledEntity(fcid, fgeo, figureBehavior(fcid, fgeo.sizeBlocks, options.figureCollisionHeight), fgeo.figure ? MINIFIG_CLIENT_ANIMATIONS : undefined);
        figureBodies[`${PACK_NAMESPACE}:${fcid}`] = figureCollisionBox(fgeo.sizeBlocks, options.figureCollisionHeight).height;
        addEntityName(`${PACK_NAMESPACE}:${fcid}`, flabel, true);
        // A rigged figure faces exactly where its torso pointed; an unrigged one the nearest axis it was compiled to.
        const yaw = fgeo.figure ? yawForFacing(fgeo.figure.facingLdu) : (() => {
            const nose = snapFacing(fig.facingLdu);
            return yawForFacing(nose === '+x' ? [1, 0] : nose === '-x' ? [-1, 0] : nose === '+z' ? [0, 1] : [0, -1]);
        })();
        actors.push({ typeId: `${PACK_NAMESPACE}:${fcid}`, label: flabel, x: fig.x, y: fig.y, z: fig.z, yaw });
        figureActorIndex.set(k, actors.length - 1);
        extraComponents.push({ id: fcid, label: flabel, kind: 'figure', provenance: fig.seatIndex !== undefined ? 'minifig sitting in the build' : 'minifig standing in the build' });
        figureKindCounts['figure'] = (figureKindCounts['figure'] ?? 0) + 1;
    }
    // Seats: one invisible rideable type shared by every chair and bench.
    const seatList = options.seats ?? [];
    // Manual brick-chair placement needs a real type even when the source had
    // no recognisable mould seat.  It is deliberately separate from inferred
    // seats: the wand owns its lifecycle and placement location.
    const coasterId = entityId(`${id}_coaster_cart`, 'c');
    const coasterConfig = options.coasterRoutes?.length
      ? coasterRuntimeConfig(`${PACK_NAMESPACE}:${coasterId}`, options.coasterRoutes) : undefined;
    let coasterCuboids = 0;
    let coasterRide: CoasterRideAssets | undefined;
    if (coasterConfig) {
        // The set's own ride cars, lift platform and counterweight compiled
        // from their bricks, the fabricated grey cart only where a route has
        // no car of its own, the placement actors and the runtime script
        // (bedrock-coaster.ts). Compiled entities go through emitCompiledEntity
        // so their swatches, controllers and diagnostics are the pack's own.
        options.onProgress?.(`compiling ${label} coaster ride`, 76);
        coasterRide = await buildCoasterRideAssets(coasterConfig, options.coasterRoutes!, {
            namespace: PACK_NAMESPACE, label, bp, rp, modelScale, unitsPerLdu, pbr, partGeometry: options.partGeometry,
            quality: LEGO_SHELL_QUALITY[options.entityQuality ?? 'balanced'], onProgress: options.onProgress,
        });
        for (const entity of coasterRide.compiled) {
            diagnostics[entity.id] = entity.geo.diagnostics;
            emitCompiledEntity(entity.id, entity.geo, entity.behavior, entity.animations);
            extraComponents.push({ id: entity.id, label: entity.label, kind: entity.role === 'car' ? 'car' : 'prop',
                provenance: entity.role === 'car' ? `the set's own ride car (${entity.cuboids} cuboids, ${entity.riders} posed rider variant${entity.riders === 1 ? '' : 's'})` : `the set's own lift ${entity.role} (${entity.cuboids} cuboids)` });
        }
        if (coasterRide.cartTypeUsed) {
            const texture = generateLegoMaterialSwatch(resolveLdrawEntityMaterial(71), { pbr: false, textureName: 'craftmatic_coaster' });
            files.push({ name: `${rp}textures/entity/craftmatic_coaster.png`, data: texture.colorPng });
        }
        files.push(...coasterRide.files);
        for (const name of coasterRide.names) addEntityName(name.identifier, name.label, false);
        actors.push(...coasterRide.actors);
        warnings.push(...coasterRide.warnings);
        coasterCuboids = coasterRide.cartCuboids;
    }
    // Pinball: flippers and the ball as their own entities, a console seat in
    // front, and the game runtime (bedrock-pinball.ts).
    let pinballConfig: PinballRuntimeConfig | undefined;
    if (options.pinball) {
        const { plan, frame } = options.pinball;
        const compileOpts = { scale: unitsPerLdu, frame: [...SHELL_FRAME], wholeModel: true, partGeometry: options.partGeometry,
            quality: LEGO_SHELL_QUALITY[options.entityQuality ?? 'balanced'], pbr, originAboveModel: true };
        try {
            options.onProgress?.(`compiling ${label} pinball`, 77);
            const flipperTypes: string[] = [];
            for (const [i, f] of plan.flippers.entries()) {
                const fid = entityId(`${id}_pinball_flipper_${f.side}`, 'p');
                const typeId = `${PACK_NAMESPACE}:${fid}`;
                const geo = await compileLdrawEntityGeometry(fid, 'prop', f.bricks, { ...compileOpts, rig: f.rig });
                diagnostics[fid] = geo.diagnostics;
                const anim = flipperAnimation(typeId);
                emitCompiledEntity(fid, geo, pinballPropBehavior(typeId, { width: 0.5, height: 0.3 }, flipperProperties()), { animations: { flip: anim.id }, animate: ['flip'] });
                files.push({ name: `${rp}animations/${fid}.animation.json`, data: json(anim.file) });
                addEntityName(typeId, `${label} ${f.side} flipper`, false);
                const at = sceneGridPoint(frame, geo.originLdu);
                actors.push({ typeId, label: `${label} ${f.side} flipper`, x: at[0], y: at[1] + geo.originLiftBlocks, z: at[2], yaw: 0, pinball: true });
                flipperTypes[i] = typeId;
                extraComponents.push({ id: fid, label: `${label} ${f.side} flipper`, kind: 'shell', provenance: `${f.bricks.length} source placements swung about the playfield normal` });
            }
            // The plunger: its own entity, drawn back along the lane by `pull`.
            let plungerType: string | undefined;
            if (plan.plunger) {
                const pid = entityId(`${id}_pinball_plunger`, 'p');
                plungerType = `${PACK_NAMESPACE}:${pid}`;
                const pgeo = await compileLdrawEntityGeometry(pid, 'prop', plan.plunger.bricks, { ...compileOpts, rig: plan.plunger.rig });
                diagnostics[pid] = pgeo.diagnostics;
                const panim = plungerAnimation(plungerType, plan.map, plan.plunger.strokeLdu);
                emitCompiledEntity(pid, pgeo, pinballPropBehavior(plungerType, { width: 0.5, height: 0.3 }, plungerProperties()), { animations: { pull: panim.id }, animate: ['pull'] });
                files.push({ name: `${rp}animations/${pid}.animation.json`, data: json(panim.file) });
                addEntityName(plungerType, `${label} plunger`, false);
                const pat = sceneGridPoint(frame, pgeo.originLdu);
                actors.push({ typeId: plungerType, label: `${label} plunger`, x: pat[0], y: pat[1] + pgeo.originLiftBlocks, z: pat[2], yaw: 0, pinball: true });
                extraComponents.push({ id: pid, label: `${label} plunger`, kind: 'shell', provenance: `${plan.plunger.bricks.length} source placements drawn back along the launch lane` });
            }
            // The ball: it stands on the serve point and its animation draws it
            // where the runtime's properties say (bedrock-pinball.ts), so its
            // culling box has to cover the whole table, not the ball.
            const bid = entityId(`${id}_pinball_ball`, 'p');
            const ballType = `${PACK_NAMESPACE}:${bid}`;
            const bgeo = await compileLdrawEntityGeometry(bid, 'prop', [plan.ballBrick], { ...compileOpts, rig: plan.ballRig });
            diagnostics[bid] = bgeo.diagnostics;
            const tableReach = (plan.table.grid.rows + plan.table.grid.cols) * plan.table.grid.cell * Math.hypot(...plan.map.u);
            const ballBounds = visibleBoundsForSizeSteps({ min: [-tableReach, -tableReach, -tableReach], max: [tableReach, tableReach, tableReach] });
            for (const g of (bgeo.value as { 'minecraft:geometry': Array<{ description: Record<string, unknown> }> })['minecraft:geometry']) Object.assign(g.description, ballBounds);
            const banim = ballAnimation(ballType, plan.map);
            emitCompiledEntity(bid, bgeo, pinballPropBehavior(ballType, { width: 0.3, height: 0.3 }, ballProperties()), { animations: { move: banim.id }, animate: ['move'], initialize: BALL_INITIALIZE, preAnimation: BALL_PRE_ANIMATION });
            files.push({ name: `${rp}animations/${bid}.animation.json`, data: json(banim.file) });
            addEntityName(ballType, `${label} ball`, false);
            const bat = sceneGridPoint(frame, bgeo.originLdu);
            const ballEntityModel: [number, number, number] = [bat[0], bat[1] + bgeo.originLiftBlocks, bat[2]];
            actors.push({ typeId: ballType, label: `${label} ball`, x: ballEntityModel[0], y: ballEntityModel[1], z: ballEntityModel[2], yaw: 0, pinball: true });
            const cid = entityId(`${id}_pinball_console`, 'p');
            const consoleType = `${PACK_NAMESPACE}:${cid}`;
            const ca = consoleAssets(consoleType);
            files.push(
                { name: `${bp}entities/${cid}.json`, data: json(ca.behavior) },
                { name: `${rp}entity/${cid}.entity.json`, data: json(ca.client) },
                { name: `${rp}models/entity/${cid}.geo.json`, data: geoJson(ca.geometry) },
                { name: `${rp}animations/${cid}.animation.json`, data: json(consoleHideAnimation(consoleType)) },
                // Solid LEGO yellow, so the pad reads as the thing to tap.
                { name: `${rp}textures/entity/craftmatic_pinball_console.png`, data: generateLegoMaterialSwatch(resolveLdrawEntityMaterial(14), { pbr: false, textureName: 'craftmatic_pinball_console' }).colorPng },
            );
            addEntityName(consoleType, `${label} - Play pinball`, false);
            actors.push({ typeId: consoleType, label: `${label} - Play pinball`, x: plan.consoleModel[0], y: plan.consoleModel[1], z: plan.consoleModel[2], yaw: plan.consoleYaw, pinball: true });
            // The tap targets: spawned by the runtime in front of a seated
            // player's head, on the line of sight to each flipper and the
            // plunger, never placed. Drawn as faint outlines.
            const zoneTexture = pinballZoneTexture();
            files.push({ name: `${rp}textures/entity/${PINBALL_ZONE_TEXTURE}.png`, data: encodePngRgba(zoneTexture.width, zoneTexture.height, zoneTexture.rgba) });
            const zid = entityId(`${id}_pinball_button`, 'p');
            const buttonType = `${PACK_NAMESPACE}:${zid}`;
            const za = zoneAssets(buttonType, plan.zones.flipperBox, 'flipper');
            files.push(
                { name: `${bp}entities/${zid}.json`, data: json(za.behavior) },
                { name: `${rp}entity/${zid}.entity.json`, data: json(za.client) },
                { name: `${rp}models/entity/${zid}.geo.json`, data: geoJson(za.geometry) },
            );
            addEntityName(buttonType, `${label} flipper button`, false);
            // The invisible pick boxes taps actually hit (see bedrock-pinball.ts `zoneAt`).
            const emitZone = (zoneId: string, typeId: string, box: { width: number; height: number }, role: 'flipper' | 'plunger' | 'pick', name: string): void => {
                const a = zoneAssets(typeId, box, role);
                files.push(
                    { name: `${bp}entities/${zoneId}.json`, data: json(a.behavior) },
                    { name: `${rp}entity/${zoneId}.entity.json`, data: json(a.client) },
                    { name: `${rp}models/entity/${zoneId}.geo.json`, data: geoJson(a.geometry) },
                );
                addEntityName(typeId, name, false);
            };
            const kid = entityId(`${id}_pinball_pick`, 'p');
            const pickType = `${PACK_NAMESPACE}:${kid}`;
            emitZone(kid, pickType, plan.zones.pickFlipperBox, 'pick', `${label} flipper pick`);
            let plungerButtonType: string | undefined, plungerPickType: string | undefined;
            if (plan.plunger) {
                const qid = entityId(`${id}_pinball_plunger_button`, 'p');
                plungerButtonType = `${PACK_NAMESPACE}:${qid}`;
                const qa = zoneAssets(plungerButtonType, plan.zones.plungerBox, 'plunger');
                files.push(
                    { name: `${bp}entities/${qid}.json`, data: json(qa.behavior) },
                    { name: `${rp}entity/${qid}.entity.json`, data: json(qa.client) },
                    { name: `${rp}models/entity/${qid}.geo.json`, data: geoJson(qa.geometry) },
                );
                addEntityName(plungerButtonType, `${label} plunger button`, false);
                const qkid = entityId(`${id}_pinball_plunger_pick`, 'p');
                plungerPickType = `${PACK_NAMESPACE}:${qkid}`;
                emitZone(qkid, plungerPickType, plan.zones.pickPlungerBox, 'pick', `${label} plunger pick`);
            }
            // The flipper spin is authored in the render frame; a mirrored frame reverses it.
            const f = SHELL_FRAME;
            const det = f[0]! * (f[4]! * f[8]! - f[5]! * f[7]!) - f[1]! * (f[3]! * f[8]! - f[5]! * f[6]!) + f[2]! * (f[3]! * f[7]! - f[4]! * f[6]!);
            pinballConfig = pinballRuntimeConfig(plan, { console: consoleType, ball: ballType, flippers: flipperTypes, button: buttonType, pick: pickType, plunger: plungerType, plungerButton: plungerButtonType, plungerPick: plungerPickType }, ballEntityModel, Math.sign(det) || 1, label);
            files.push({ name: `${bp}scripts/pinball.js`, data: text(pinballScript(pinballConfig)) });
            warnings.push(...plan.warnings.map(w => `Pinball: ${w}`));
            warnings.push(`Pinball: ${label} is playable - sit on the yellow pad in front of the machine ("${PINBALL_INTERACT_TEXT}"). Tap the outlined box over a flipper (or a hotbar slot left or right of the middle) to flip it; tap the yellow box over the plunger to draw it back and tap again to let go - the further it is drawn, the harder the shot. The stick works too (pull it back for the plunger). Sneak to leave. ${plan.table.bumpers.length} bumpers, ${plan.flippers.length} flippers, ${plan.table.tiltDeg.toFixed(1)} degree playfield tilt read from the model.`);
        } catch (e) {
            pinballConfig = undefined;
            warnings.push(`${label}: the pinball game could not be built (${e instanceof Error ? e.message : String(e)}); the machine ships as a static model.`);
        }
    }
    const manualSeatId = options.shell ? entityId(`${id}_manual_seat`, 's') : undefined;
    if (manualSeatId) {
        files.push(
            { name: `${bp}entities/${manualSeatId}.json`, data: json(seatBehavior(manualSeatId)) },
            { name: `${rp}entity/${manualSeatId}.entity.json`, data: json(seatClient(manualSeatId)) },
        );
        addEntityName(`${PACK_NAMESPACE}:${manualSeatId}`, `${label} Seat`, true);
    }
    if (manualSeatId || seatList.length) files.push(
        { name: `${rp}models/entity/craftmatic_seat.geo.json`, data: geoJson(SEAT_GEOMETRY) },
        { name: `${rp}textures/entity/craftmatic_seat.png`, data: transparentPng() },
    );
    if (seatList.length) {
        const rawSeat = `${id}_seat`;
        const seatId = entityId(rawSeat, 's');
        files.push(
            { name: `${bp}entities/${seatId}.json`, data: json(seatBehavior(seatId)) },
            { name: `${rp}entity/${seatId}.entity.json`, data: json(seatClient(seatId)) },
        );
        addEntityName(`${PACK_NAMESPACE}:${seatId}`, `${label} Seat`, true);
        const seatActorStart = actors.length;
        for (const [k, seat] of seatList.entries()) {
            actors.push({ typeId: `${PACK_NAMESPACE}:${seatId}`, label: seat.label, x: seat.x, y: seat.y, z: seat.z, yaw: seat.yaw });
            extraComponents.push({ id: `${seatId}_${k + 1}`, label: seat.label, kind: 'seat', provenance: 'seat mould in the build' });
        }
        // A figure the source seated rides its seat once both are spawned (placement.js).
        for (const [k, fig] of (options.figures ?? []).entries()) {
            const figActor = figureActorIndex.get(k);
            if (fig.seatIndex === undefined || figActor === undefined || fig.seatIndex >= seatList.length) continue;
            actors[figActor]!.rideOf = seatActorStart + fig.seatIndex;
        }
    }
    const screens = options.screens ?? [], rawScreenId = `${id}_control_screen`;
    const screenId = entityId(rawScreenId, 's');
    if (screens.length) {
        files.push({ name: `${bp}entities/${screenId}.json`, data: json(screenBehavior(screenId)) }, { name: `${rp}entity/${screenId}.entity.json`, data: json(screenClient(screenId)) }, { name: `${rp}models/entity/control_screen.geo.json`, data: geoJson(SCREEN_GEOMETRY) }, { name: `${rp}textures/entity/craftmatic_screen.png`, data: palettePng(['cyan']) });
        addEntityName(`${PACK_NAMESPACE}:${screenId}`, `${label} Control Screen`, false);
        for (const s of screens)
            actors.push({ typeId: `${PACK_NAMESPACE}:${screenId}`, label: s.label, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
    }
    // One animation file serves every minifig entity: the rig's bone names are shared.
    if (minifigsEmitted) files.push({ name: `${rp}animations/craftmatic_minifig.animation.json`, data: json(MINIFIG_ANIMATIONS) });
    if (unmapped.size) warnings.push(`${unmapped.size} block type${unmapped.size === 1 ? '' : 's'} had no Bedrock equivalent and ${unmapped.size === 1 ? 'was' : 'were'} omitted: ${[...unmapped].join(', ')}`);
    if (modelScale !== 1) warnings.push(`${label}: exported at ${modelScale}× minifig scale (1 block = ${Math.round(lduPerBlock * 100) / 100} LDU) - blocks, colliders and vehicles alike; figures ${modelScale > 1 ? 'stay at 1× (player-sized, never giants)' : 'follow the model'}.`);
    // ── Pack cuboid budget ───────────────────────────────────────────────────
    // `maxModelCubes` caps ONE entity. Nothing capped a PACK, and the device's
    // ceiling is the cuboid sum over every add-on the world has active
    // (`DEVICE_CUBOID_BUDGET`) - so a pack of a dozen entities, each of them
    // under its own budget, could quietly take a third of the phone. The total
    // always goes into `craftmatic-diagnostics.json`; the warning fires once
    // the pack is a large enough share of the budget for the count of packs to
    // matter. The placement ghost (<= 120 cuboids) and the invisible seat and
    // screen stubs are not counted: they are noise at this scale.
    const figuresClamped = Object.values(diagnostics).filter(d => d.figureQualityClamped).length;
    if (figuresClamped) {
        const to = Object.values(diagnostics).find(d => d.figureQualityClamped)!.figureQualityClamped!;
        warnings.push(`${label}: ${figuresClamped} figure${figuresClamped === 1 ? ' was' : 's were'} compiled at ${to.microcellLdu} LDU rather than the pack's ${to.requestedMicrocellLdu} LDU - at the finer grain a minifig costs 8-13× the cuboids (the phone's add-on memory budget) and gains only a rounder head and hands.`);
    }
    // Hull cuboids are RESIDENT beside the full model (add-on memory is
    // definition-side), so they count against the device budget like any other.
    const lodCuboids = Object.values(lodHulls).reduce((n, h) => n + h.cuboids, 0);
    const packCuboids = Object.values(diagnostics).reduce((n, d) => n + d.cubeCount, 0) + fallbackCuboids + lodCuboids + coasterCuboids;
    const entityCount = Object.keys(diagnostics).length + (fallbackCuboids ? 1 : 0) + (coasterRide?.cartTypeUsed ? 1 : 0);
    const budget = packCuboidBudget(label, packCuboids, entityCount);
    if (budget.warning) warnings.push(budget.warning);
    if (lodCuboids) {
        const switches = Object.entries(lodHulls).map(([id, h]) => `${id} at ${h.switchDistance} (reach ${h.radiusBlocks}, culls at ${h.renderCullBlocks}${h.switchSource === 'render-cull' ? `, capped from ${h.requestedSwitchDistance}` : ''}${h.hullWindowBlocks <= 0 ? ', NEVER DRAWN: the switch is past the cull' : ''})`).join(', ');
        warnings.push(`${label}: distance LOD on - ${lodCuboids} extra hull cuboids over ${Object.keys(lodHulls).length} entit${Object.keys(lodHulls).length === 1 ? 'y' : 'ies'} (${Math.round(lodCuboids / Math.max(1, packCuboids) * 100)}% of this pack, ${Math.round(lodCuboids / DEVICE_CUBOID_BUDGET * 1000) / 10}% of the device budget), resident beside the full model. The hull takes over once the camera is more than ${lodDistance} blocks from a model's nearest cube; query.distance_from_camera reads in blocks to the entity ROOT (Pixel 8 Pro, 2026-09-19), so each entity switches at ${lodDistance} plus its reach from the root, capped ${LOD_CULL_MARGIN_BLOCKS} blocks under the distance its collision box lets the client draw it to (${RENDER_CULL_BLOCKS_PER_UNIT} blocks per unit of box diagonal, at least ${RENDER_CULL_BLOCKS_PER_UNIT * RENDER_CULL_MIN_UNITS}; Pixel 8 Pro, 2026-09-21): ${switches}.`);
    }
    // A hull the actor culls before it could take over is dropped, and the
    // pack says so, with the collision box that would let it ship.
    if (Object.keys(lodSkipped).length) {
        const boxFor = (requested: number): string => (Math.ceil((requested + LOD_CULL_MARGIN_BLOCKS) / (RENDER_CULL_BLOCKS_PER_UNIT * Math.sqrt(3)) * 10) / 10).toFixed(1);
        const dropped = Object.entries(lodSkipped).map(([id, s]) => `${id} (${s.hullCuboidsNotShipped} hull cuboids not shipped: ${s.reason}; a ${boxFor(s.requestedSwitchDistance)} x ${boxFor(s.requestedSwitchDistance)} collision box would draw it to ${s.requestedSwitchDistance + LOD_CULL_MARGIN_BLOCKS}+ blocks)`).join('; ');
        warnings.push(`${label}: distance LOD dropped for ${Object.keys(lodSkipped).length} entit${Object.keys(lodSkipped).length === 1 ? 'y' : 'ies'} - the client stops drawing the whole actor before its hull could take over at ${MIN_LOD_NEAREST_CUBE_BLOCKS}+ blocks from its nearest cube, so the model pops out at that cull whether or not a hull ships: ${dropped}.`);
    }
    // Every fidelity degradation is inspectable from the pack itself.
    if (Object.keys(diagnostics).length || coasterConfig || options.access) files.push({ name: `${bp}craftmatic-diagnostics.json`, data: json({
        // The provenance record (pipeline stamp, source file + hash, build
        // instant) is spread in whole, so one file answers "which build made this".
        ...provenance, label,
        // `fallbackCuboids` are the BlockGrid-fallback entities' cuboids, which have no per-entity diagnostics of their own.
        pack: { ...budget, fallbackCuboids, figuresClampedToBalanced: figuresClamped, lodCuboids },
        // `query.distance_from_camera` is evaluated in a geometry field and reads
        // in blocks to the entity root (device round 2026-09-19); `distance` is the
        // nearest-cube option and each entity's `switchDistance` adds its reach,
        // capped under the actor's render cull (`renderCull`, device round
        // 2026-09-21) or the hull is dropped (`skipped`).
        lod: {
            mode: lodMode, distance: lodDistance, explicitDistance: lodExplicit, cuboids: lodCuboids,
            note: lodMode === 'hull' ? 'query.distance_from_camera is in blocks to the entity ROOT (Pixel 8 Pro 2026-09-19); each entity switches at distance + its radiusBlocks, capped marginBlocks under its renderCullBlocks (switchDistance), or ships no hull (skipped)' : 'off',
            renderCull: {
                blocksPerUnitDiagonal: RENDER_CULL_BLOCKS_PER_UNIT, minUnits: RENDER_CULL_MIN_UNITS, marginBlocks: LOD_CULL_MARGIN_BLOCKS, minNearestCubeBlocks: MIN_LOD_NEAREST_CUBE_BLOCKS,
                evidence: 'Pixel 8 Pro, Bedrock 1.26.51, 2026-09-21 (output/bedrock-entity-qa/round921): 10303 shell, collision box 0.1 x 0.1, drawn at the 60-block stop and absent at 70/86/100/168 while its 0.6 x 1.8 figures were drawn at 100 and gone at 168; visible_bounds (177 x 189) and simulation distance ruled out (the player stood at the model). The 64-per-unit constant is Java\'s shouldRenderAtSqrDistance rule; Bedrock\'s is undocumented and the clamp at one unit is inferred.',
            },
            entities: lodHulls, skipped: lodSkipped,
        },
        // The measured walk-through size, whole: the recommended step, what it
        // was measured on (door leaves or wall openings), the representative
        // doorway, the interior headroom and how far up the model a player
        // still reaches at that size. A recommendation - this pack was NOT
        // resized by it (`modelScale` is what it was exported at).
        ...(options.access ? { access: options.access } : {}),
        entities: diagnostics,
        ...(coasterConfig && coasterRide ? { coaster: coasterDiagnostics(coasterConfig, coasterRide) } : {}),
        // The moving parts: class, hinge angle, the opening a player passes and
        // the smallest wand size at which it can (0 = none), the collider cells
        // the closed leaf lays and what the doorway cut opened.
        ...(interactiveReport ? { interactives: interactiveReport } : {}),
        ...(options.interactivityReport ? { interactivity: options.interactivityReport } : {}),
    }) });
    // A Bedrock entity identifier may not begin with a digit: the engine drops
    // the WHOLE definition, so the entity simply never exists in game and
    // nothing is logged. `entityId()` guards each id, but a new path can forget
    // it — the door leaf did, and only a set with BOTH a numeric stem and a
    // door (31084) ever revealed it. Refuse to emit such a pack instead of
    // shipping one that is broken on the device.
    for (const file of files) {
        if (!/\/entities\/[^/]+\.json$/.test(file.name)) continue;
        const parsed = JSON.parse(new TextDecoder().decode(file.data)) as {
            'minecraft:entity'?: { description?: { identifier?: string } };
        };
        const identifier = parsed['minecraft:entity']?.description?.identifier ?? '';
        if (/^[0-9]/.test(identifier.split(':')[1] ?? '')) {
            throw new Error(
                `Bedrock rejects the entity identifier '${identifier}' in ${file.name}: `
                + 'an identifier may not begin with a digit. Build it through entityId().',
            );
        }
    }

    const previewPoints = previewSamples(scenery, components.length ? 90 : 120);
    const perVehicle = Math.floor((120 - previewPoints.length) / Math.max(1, components.length));
    for (const c of components) {
        const scale = componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis).scale;
        const at = componentSpawnPoint(c, grid);
        for (const p of previewSamples(c.grid, perVehicle)) previewPoints.push({
            x: at.x + (p.x - c.grid.width / 2) * scale,
            y: at.y + p.y * scale,
            z: at.z + (p.z - c.grid.length / 2) * scale,
        });
    }
    // Ghost preview of the whole placement: scenery plus each vehicle at its scene position.
    options.onProgress?.('building placement preview', 85);
    const ghost = buildPreviewGhost(id, scenery, components.map((c): PreviewComponentPlacement => ({
        grid: c.grid, scale: componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis).scale,
        ...componentSpawnPoint(c, grid),
    })));
    files.push(
        { name: `${bp}entities/${id}_preview.json`, data: json(ghost.behavior) },
        { name: `${rp}entity/${id}_preview.entity.json`, data: json(ghost.clientEntity) },
        { name: `${rp}models/entity/${id}_preview.geo.json`, data: geoJson(ghost.geometry) },
        { name: `${rp}render_controllers/${id}_preview.render_controllers.json`, data: json(ghost.renderControllers) },
        { name: `${rp}textures/entity/${id}_preview.png`, data: ghost.texturePng },
    );
    addEntityName(ghost.typeId, `${label} Preview`, false);
    const placement = buildPlacementPackAssets({ stem: id, label, width: grid.width, height: grid.height, length: grid.length,
        tiles: plan.map(tile => ({ identifier: `${PACK_NAMESPACE}:${tile.name}`, dx: tile.x, dy: tile.y, dz: tile.z, width: tile.width, height: tile.height, length: tile.length, nonAir: tile.nonAir })), actors, previewPoints,
        preview: { typeId: ghost.typeId },
        ...(placementColliders ? { colliders: placementColliders } : {}),
        ...(timeMachineConfig ? { vehicleControls: true } : {}),
        ...(options.interactionNote || ixWalkNote ? { interactionNote: bedrockInGameText([options.interactionNote, ixWalkNote].filter(Boolean).join(' ')) } : {}),
        // The wand names the measured walk-through step and quotes the reason
        // whole - spelt for Bedrock's text formatter, which deletes a bare `%`.
        ...(options.access ? { access: { ...(options.access.sizePct !== undefined ? { sizePct: options.access.sizePct } : {}), reason: bedrockInGameText(options.access.reason) } } : {}),
        ...(manualSeatId || options.manualSeatTypeId ? { manualSeatTypeId: manualSeatId ? `${PACK_NAMESPACE}:${manualSeatId}` : options.manualSeatTypeId } : {}),
        ...(options.runtimeDoorCandidates ? { runtimeDoorCandidates: options.runtimeDoorCandidates } : {}) });
    files.push(...placement.files.map(file => ({
        ...file, name: bp + file.name,
        ...(creatorConfig && file.name.endsWith('.mcfunction') ? {
            data: text(`${new TextDecoder().decode(file.data)}\ngive @s ${creatorConfig.itemId} 1\n`),
        } : {}),
    })));
    if (timeMachineConfig) files.push({ name: `${bp}scripts/time-machine.js`, data: text(timeMachineScript(timeMachineConfig)) });
    if (driverVehicles.length) files.push({ name: `${bp}scripts/vehicle-driver.js`, data: text(vehicleDriverScript({ vehicles: driverVehicles, dashCooldownTicks: Math.round(DASH_ACTION.cooldown_time * 20), descendOn: AIRCRAFT_DESCEND_ON, descendOff: AIRCRAFT_DESCEND_OFF })) });
    if (cameraVehicles.length) files.push({ name: `${bp}scripts/vehicle-camera.js`, data: text(vehicleCameraScript({ vehicles: cameraVehicles })) });
    if (interactiveConfig) files.push({ name: `${bp}scripts/interactives.js`, data: text(interactivesScript(interactiveConfig)) });
    // Figure life (bedrock-figure-life.ts): where every figure NPC walks, pauses and sits.
    const figureTypes = Object.keys(figureBodies);
    if (figureTypes.length) files.push({ name: `${bp}scripts/figures.js`, data: text(figureLifeScript({
        figureTypes, bodyHeights: figureBodies, bodyHeight: 1.8,
        seatTypes: [...new Set(actors.filter(a => /_seat$/.test(a.typeId)).map(a => a.typeId))],
        interactiveFamily: INTERACTIVE_FAMILY,
        colliders: placementColliders ? { block: placementColliders.block, loState: placementColliders.loState, hiState: placementColliders.hiState } : undefined,
        tuning: FIGURE_TUNING,
    })) });
    // texts/en_US.lang: one name per entity this pack declares (localisedEntities,
    // built up throughout the function above), plus the creator wand item name
    // when a minifig creator is present. Unconditional — a plain model pack
    // (no minifig creator) still has spawnable figures/vehicles/seats that need
    // this file just as much as the creator entity did.
    const langLines: string[] = [];
    if (creatorConfig) langLines.push(`item.${creatorConfig.itemId}=${label} Minifig Creator Wand`);
    for (const e of localisedEntities) {
        langLines.push(`entity.${e.identifier}.name=${e.label}`);
        if (e.spawnable) langLines.push(`item.spawn_egg.entity.${e.identifier}.name=${e.label} Spawn Egg`);
    }
    if (interactiveConfig) langLines.push(...interactiveLangLines());
    files.push(
        { name: `${rp}texts/languages.json`, data: json(['en_US']) },
        { name: `${rp}texts/en_US.lang`, data: text(langLines.join('\n')) },
    );
    if (creatorConfig) files.push(
        { name: `${bp}scripts/minifig-wand.js`, data: text(minifigWandScript(creatorConfig)) },
        { name: `${bp}functions/${creatorConfig.shortAlias}.mcfunction`, data: text(`give @s ${creatorConfig.itemId}`) },
        { name: `${bp}MINIFIG-CREATOR.txt`, data: text(`Minifig Creator\n\nActivate both packs and rejoin. /function ${placement.shortAlias} gives both wands. /function ${creatorConfig.shortAlias} gives only the Minifig Creator Wand. Select it in your hotbar to open the creator; switch away and back to reopen. Choose compiled parts and colours, save a figure or copy its portable mf1 code, then place it at your feet or aimed block. Sneak-use makes an owned copy at your aim. Use the wand on your own placed figure to edit it. Close returns an edited figure to its NPC behaviour. Discard deletes the draft or the figure being edited. Mini-dolls are not supported. Special PBR finishes are not yet supported by creator swatches.`) },
    );
    const mainImports = [
        "import './placement.js';",
        ...(driverVehicles.length ? ["import './vehicle-driver.js';"] : []),
        ...(cameraVehicles.length ? ["import './vehicle-camera.js';"] : []),
        ...(creatorConfig ? ["import './minifig-wand.js';"] : []),
        ...(coasterConfig ? ["import './coaster.js';"] : []),
        ...(pinballConfig ? ["import './pinball.js';"] : []),
        ...(interactiveConfig ? ["import './interactives.js';"] : []),
        ...(figureTypes.length ? ["import './figures.js';"] : []),
    ].join('\n');
    files.push({ name: `${bp}scripts/main.js`, data: text(`${mainImports}\nconst SCREEN_TYPE = ${JSON.stringify(PACK_NAMESPACE + ':' + screenId)};\n${SCREEN_SCRIPT}`) }, { name: `${bp}README.txt`, data: text(`${label}\n\nImport this .mcaddon, activate both packs, rejoin the world. Find '${label} Brick Wand' in Creative inventory or run /function ${placement.shortAlias}. Select the wand in your hotbar to open it; switch away and back to reopen it. Pin a position (or "Follow my aim" to carry the preview to wherever you look), then "View preview in world" shows a translucent ghost of the whole build standing at the pin, turned to the chosen rotation and size; rotate (90 degree steps for a build with blocks, 15 degree steps for a vehicle or figure alone), pick a size from 25% to 400%, place, and undo if needed. At another size the building, its vehicles and props take that size and a brick-accurate building's invisible walkable blocks are re-laid to match (its vanilla doors and lights are left out); the set's figures stay player-sized above 100% (a minifig is never a giant) and only shrink with a size below 100%; a coloured-block export keeps its blocks at 100%. Placement shows a progress bar above the hotbar.\nCars and boats: interact to ride. Push the joystick (or A/D) LEFT and RIGHT to steer, forward and back to drive - the camera stays behind you; hold Jump to charge a dash and release it for a boost; the Dismount (sneak) button gets you out. Planes: ride to fly - push the joystick LEFT and RIGHT to turn and forward to fly; Jump climbs straight up; pull the joystick BACK while holding Jump to descend straight down; looking up or down also climbs or dives; Dismount (sneak) exits. Figures from the set walk about on their own; a second vehicle in the set is rideable too (export with "main vehicle only" to leave them out). Vehicles resist damage. While you ride, a chase camera sized to the vehicle follows you; it clears when you dismount.${isTimeMachine ? ' 10300 Time Machine: use DeLorean controls on the Brick Wand to set destination coordinates and a teleport speed (88 mph by default).' : ''} Buildings: the set's figures walk about on their own; its doors, gates, trap doors, opening windows and cupboards are the set's own LEGO parts and swing open and shut when you tap them (a doorway you can walk through once it is open, when it is at least 1 x 2 blocks at the size you placed it - smaller ones open but stay blocked, and the message says which size to use); tap a turntable, a steering wheel or a rotor to turn it and a lever to flip it; its chairs and benches can be sat on (interact, sneak to get up); open doors stay open after a reload. A brick-accurate building is drawn by one entity standing on invisible blocks that follow the LEGO floors and walls; undo removes both. Computer screens: interact for lights, doors, scanner vision, and vehicle locations.\n`) });
    options.onProgress?.('packaging playable .mcaddon', 90);
    const bytes = await createZip(files, { alwaysDeflate: true });
    return { bytes, functionCommand: `/function ${placement.shortAlias}`, tileCount: plan.length, components: [...components.map(c => ({ id: c.id, label: c.label, kind: c.kind, provenance: c.provenance })), ...extraComponents, ...screens.map(s => ({ id: s.id, label: s.label, kind: 'screen' as const, provenance: 'source-aligned interaction anchor' }))], warnings, diagnostics, provenance };
}

/** One warning line for the moving parts: counts by class and, for doorways, at which wand size each can be walked through. */
export function interactiveSummary(label: string, items: readonly InteractiveRuntimeItem[]): string {
    const counts = new Map<string, number>();
    for (const it of items) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
    const plural = (k: string, n: number): string => `${n} ${k === 'hatch' ? (n === 1 ? 'hatch' : 'hatches') : `${k}${n === 1 ? '' : 's'}`}`;
    const parts = [...counts].map(([k, n]) => plural(k, n)).join(', ');
    const doorways = items.filter(it => it.passSize !== undefined);
    const bySize = new Map<number, number>();
    for (const d of doorways) bySize.set(d.passSize!, (bySize.get(d.passSize!) ?? 0) + 1);
    const pass = [...bySize].sort((a, b) => (a[0] || 1e9) - (b[0] || 1e9)).map(([size, n]) => size ? `${n} from ${size} %` : `${n} at no wand size (too small; they open but stay blocked)`).join(', ');
    return `${label}: moving parts - ${parts}; tap to open, close or turn. ${doorways.length ? `Doorways passable (a player needs 1 x 2 blocks): ${pass}.` : 'No doorway to walk through.'}`;
}

// ── Measured coaster train ───────────────────────────────────────────────────

/** Riders whose arc positions differ by less than this sit in the SAME car (two seats abreast). */
export const COASTER_SAME_CAR_ARC = 0.5;
/** Consecutive car pitches must agree within this fraction to be one train. */
export const COASTER_PITCH_TOLERANCE = 0.08;
/** Most cars a route may declare (`resolveCoasterCars` rejects more). */
const COASTER_MAX_CARS = 8;

export interface CoasterTrainMeasurement {
    /** Cars in the longest consistent run of riders (2..8). */
    count: number;
    /** Their mean arc pitch, model blocks (rounded to 1e-3). */
    spacing: number;
    /** Riders that projected onto the route within `maxOffset`. */
    riders: number;
    /** Every consecutive pitch in the chosen run, model blocks. */
    pitches: number[];
}

/**
 * Derive a route's train from the SOURCE's own evidence: the riders it posed
 * along the track. Nothing here assumes a pitch — a train is a measurement of
 * the set, and a set with no measurable train gets the single device-proved
 * cart (`undefined`).
 *
 * Rule: each rider anchor (the torso placement, in the same model blocks as
 * the route) is projected onto the route polyline; anchors further than
 * `maxOffset` from it are not riders. Anchors within `COASTER_SAME_CAR_ARC` of
 * each other along the arc share a car (two seats abreast). The remaining car
 * positions are sorted by arc, and the longest run of consecutive pitches that
 * agree within `COASTER_PITCH_TOLERANCE` of their running mean is the train:
 * its car count and mean pitch. Fewer than two cars in a run is no train.
 *
 * 10303 Loop Coaster: three riders posed nose-down (tilt 90°) on the vertical
 * drop, torsos at identical x/z exactly 120 LDU apart, project to three car
 * positions 2.25 blocks apart at that pack's 53.33-LDU cell, so the rule
 * returns `{ count: 3, spacing: 2.25 }`. Riders standing beside the track are
 * not passed in (only figures posed OFF upright are — see schem-pipeline.ts),
 * so a queue on the platform cannot lengthen the train.
 */
export function measureCoasterTrain(route: { points: readonly Vec3[]; closed: boolean }, riders: readonly Vec3[], maxOffset: number): CoasterTrainMeasurement | undefined {
    const points = route.points;
    if (points.length < 2 || riders.length < 2 || !(maxOffset > 0)) return undefined;
    // Cumulative arc length of the polyline.
    const cumulative = [0];
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!;
        cumulative.push(cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
    }
    // Nearest point on the polyline for each rider: (arc, perpendicular distance).
    const arcs: number[] = [];
    for (const r of riders) {
        let best = { d: Infinity, arc: 0 };
        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1]!, b = points[i]!;
            const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((r[0] - a[0]) * ab[0] + (r[1] - a[1]) * ab[1] + (r[2] - a[2]) * ab[2]) / len2)) : 0;
            const d = Math.hypot(r[0] - (a[0] + ab[0] * t), r[1] - (a[1] + ab[1] * t), r[2] - (a[2] + ab[2] * t));
            if (d < best.d) best = { d, arc: cumulative[i - 1]! + Math.sqrt(len2) * t };
        }
        if (best.d <= maxOffset) arcs.push(best.arc);
    }
    if (arcs.length < 2) return undefined;
    arcs.sort((a, b) => a - b);
    // Riders abreast in one car collapse to that car's mean arc.
    const cars: number[] = [];
    let group: number[] = [arcs[0]!];
    for (let i = 1; i <= arcs.length; i++) {
        const arc = arcs[i];
        if (arc !== undefined && arc - group[group.length - 1]! < COASTER_SAME_CAR_ARC) { group.push(arc); continue; }
        cars.push(group.reduce((s, v) => s + v, 0) / group.length);
        if (arc !== undefined) group = [arc];
    }
    if (cars.length < 2) return undefined;
    // Longest run of consecutive pitches that agree with their running mean.
    let best: { start: number; length: number } = { start: 0, length: 0 };
    let start = 0, sum = 0;
    for (let i = 1; i < cars.length; i++) {
        const pitch = cars[i]! - cars[i - 1]!;
        // Pitches already in the run: cars[start..i-1] hold i-1-start of them.
        const inRun = i - 1 - start;
        const mean = inRun > 0 ? sum / inRun : pitch;
        if (inRun > 0 && Math.abs(pitch - mean) > COASTER_PITCH_TOLERANCE * mean) { start = i - 1; sum = 0; }
        sum += pitch;
        const length = i - start;
        if (length > best.length) best = { start, length };
    }
    if (best.length < 1) return undefined;
    const pitches = Array.from({ length: Math.min(best.length, COASTER_MAX_CARS - 1) }, (_, k) => cars[best.start + k + 1]! - cars[best.start + k]!);
    const spacing = Math.round(pitches.reduce((s, v) => s + v, 0) / pitches.length * 1000) / 1000;
    if (!(spacing > 0)) return undefined;
    return { count: pitches.length + 1, spacing, riders: arcs.length, pitches: pitches.map(p => Math.round(p * 1000) / 1000) };
}
