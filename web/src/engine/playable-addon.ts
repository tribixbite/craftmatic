import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { createZip } from './zip-utils.js';
import { deterministicUuid, exportVersion, PACK_NAMESPACE, toBedrockIdentifier } from './mcpack.js';
import { BEDROCK_MAX_TILE, encodeMcstructureTile, planStructureTiles } from './mcstructure-encode.js';
import type { PlayableKind, VehicleFacing, VehicleMode } from './playable-components.js';
import { classifyVehicleKind, isWholeVehicleLabel } from './playable-components.js';
import { buildPlacementPackAssets, encodeColliderRuns, placementAlias, withSizeGroups, type PlacementActor, type PlacementColliders } from './bedrock-placement-pack.js';
import { buildPreviewGhost, type PreviewComponentPlacement } from './bedrock-preview-entity.js';
import { CONCRETE_COLORS, generateStudBlockPng, generateEntityLegoAtlasPng } from './lego-resource-pack.js';
import type { ParsedBrick } from './ldraw-parser.js';
import { compileLdrawEntityGeometry, type CompiledLdrawGeometry, type EntityExtra, type EntityKind, type LegoGeometryDiagnostics } from './ldraw-entity-compiler.js';
import { BEDROCK_UNITS_PER_LDU, LDU_PER_BLOCK, PLAYER_HEIGHT_BLOCKS } from './lego-scale.js';
import { normaliseYaw, sceneGridPoint, yawForFacing, type SceneGridFrame } from './bedrock-scene-actors.js';
import { MINIFIG_ANIMATIONS, MINIFIG_CLIENT_ANIMATIONS } from './minifig-rig.js';
import { COLLIDER_BLOCK_ID, COLLIDER_BLOCKS_JSON, COLLIDER_HI_STATE, COLLIDER_LO_STATE, COLLIDER_TERRAIN_TEXTURE, LEGO_SHELL_QUALITY, SHELL_FRAME, buildColliderGrid, colliderBlockDefinition, shellBehavior } from './bedrock-building-shell.js';
import type { NoseDirection } from './vehicle-facing.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { generateLegoEntityTextureAtlas } from './ldraw-entity-atlas.js';
import type { PartGeometryProvider } from './ldraw-part-geometry.js';
import type { LegoEntityQualityName } from './ldraw-part-prototype.js';
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
    /**
     * Brick-accurate building: the scenery's placements (figures and door
     * leaves already taken out) compiled as one static entity over invisible
     * colliders (bedrock-building-shell.ts). `frame` is the voxelizer's grid
     * origin the scenery grid was built with.
     */
    shell?: { bricks: ParsedBrick[]; frame: SceneGridFrame };
    /**
     * Model scale as a multiplier of the minifig scale (engine/addon-scale.ts),
     * default 1. Every brick-compiled entity is authored at
     * `BEDROCK_UNITS_PER_LDU × modelScale` and the figures beside a vehicle are
     * placed at `LDU_PER_BLOCK / modelScale` LDU per block, so they agree with
     * a block grid voxelized at that cell.
     */
    modelScale?: number;
}
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
}
const enc = new TextEncoder();
const text = (s: string) => enc.encode(s.endsWith('\n') ? s : `${s}\n`);
const json = (v: unknown) => text(JSON.stringify(v, null, 2));
const safe = (s: string) => toBedrockIdentifier(s).slice(0, 48);

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
    const actorYaw = longitudinalAxis === 'x' ? -90 * forwardSign : forwardSign < 0 ? 180 : 0;
    return { scale, longitudinalAxis, forwardSign, width, length, height, actorYaw };
}

function behaviorEntity(id: string, kind: PlayableKind, grid: BlockGrid, sceneScale?: number, longitudinalAxis?: 'x' | 'z', facing: VehicleFacing = 'auto', seatAnchor?: {x:number;y:number;z:number}, isTimeMachine = false, seatCount = 1, seatPositionOverride?: [number, number, number], collisionBoxOverride?: { width: number; height: number }, entitySize?: { width: number; height: number; length: number }): unknown {
    const layout = componentLayout(kind, grid, sceneScale, longitudinalAxis, facing);
    let seatX: number, seatY: number, seatZ: number;
    if (seatPositionOverride) {
        [seatX, seatY, seatZ] = seatPositionOverride;
        // A model scaled below the player (a 0.38x Mini Cooper is 2 blocks tall)
        // cannot hold an unscaled 1.8-block rider: the compiler's cockpit seat put
        // the player through the car's flank and floor (Pixel round 2026-09-17).
        // Seat such a rider ON the model, legs inside the roof line, like a kart.
        const modelHeight = entitySize?.height ?? layout.height;
        if (modelHeight < PLAYER_HEIGHT_BLOCKS + 0.2) seatY = Math.max(seatY, Math.round((modelHeight - 0.55) * 100) / 100);
    } else {
        const seat = seatAnchor ?? { x: .5, y: .45, z: .5 };
        const ox = (seat.x - .5) * grid.width * layout.scale, oz = (seat.z - .5) * grid.length * layout.scale;
        // Mojang's vanilla horse geometry establishes -Z as model-forward. Keep
        // the source footprint fixed while its selected nose follows that axis.
        seatX = layout.longitudinalAxis === 'x' ? layout.forwardSign * oz : -layout.forwardSign * ox;
        seatZ = layout.longitudinalAxis === 'x' ? -layout.forwardSign * ox : -layout.forwardSign * oz;
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
function figureBehavior(id: string, size: { width: number; height: number; length: number }): unknown {
    // No bigger than the player (0.6 x 1.8), who walks every room and doorway of
    // a minifig-scale build: at 0.9 x 2.0 six of seven chalet figures could not
    // path out of where they spawned (Pixel round 2026-09-17).
    const collision = { width: Math.min(0.6, Math.max(0.4, Math.round(Math.max(size.width, size.length) * 0.8 * 10) / 10)), height: Math.min(1.8, Math.max(1.0, Math.round(size.height * 10) / 10)) };
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
        // Tethered to where it was placed: round 2 on the Pixel had a museum
        // figure 28 blocks outside the building within minutes.
        // `restriction_type` is required or the radius is ignored ("will be ignored as
        // restriction_type was set to none" on every figure, Pixel round 3).
        'minecraft:home': { restriction_radius: 12, restriction_type: 'random_movement' },
        'minecraft:behavior.move_towards_home_restriction': { priority: 5, speed_multiplier: 1 },
        'minecraft:behavior.random_stroll': { priority: 6, speed_multiplier: 0.8, interval: 60, xz_dist: 6, y_dist: 3 },
        'minecraft:behavior.look_at_player': { priority: 7, look_distance: 6, probability: 0.02 },
        'minecraft:behavior.random_look_around': { priority: 8 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 80, max_dropped_ticks: 10, use_motion_prediction_hints: true } },
    } } }, collision);
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
    } } }, { width: 0.5, height: 0.5 }, rideable);
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
        const origin = layout.longitudinalAxis === 'x'
            ? [layout.forwardSign > 0 ? (b.z - grid.length / 2) * 16 * scale : (grid.length / 2 - b.z - b.sz) * 16 * scale,
                b.y * 16 * scale,
                layout.forwardSign > 0 ? (grid.width / 2 - b.x - b.sx) * 16 * scale : (b.x - grid.width / 2) * 16 * scale]
            : [layout.forwardSign > 0 ? (grid.width / 2 - b.x - b.sx) * 16 * scale : (b.x - grid.width / 2) * 16 * scale,
                b.y * 16 * scale,
                layout.forwardSign > 0 ? (grid.length / 2 - b.z - b.sz) * 16 * scale : (b.z - grid.length / 2) * 16 * scale];
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
    for (let offset = 0; offset < cubes.length; offset += 1024) {
        const meshId = `geometry.${PACK_NAMESPACE}.${id}_mesh_${meshIds.length}`;
        meshIds.push(meshId);
        meshes.push({ description: { identifier: meshId, texture_width: atlasW, texture_height: atlasH, visible_bounds_width: Math.max(2, layout.width, layout.length), visible_bounds_height: Math.max(2, layout.height), visible_bounds_offset: [0, layout.height / 2, 0] }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes: cubes.slice(offset, offset + 1024) }] });
    }
    return { value: { format_version: '1.12.0', 'minecraft:geometry': meshes }, palette, meshIds };
}
/**
 * `opaqueMaterial` is `entity` for brick-compiled bodies (their translucent
 * pieces live in the canopy mesh) and `entity_alphablend` for the BlockGrid
 * fallback, whose single mesh mixes glass blocks with solids.
 */
/** Animations a client entity plays: the `animations` map and the `scripts.animate` list (a minifig's walk / look / sit). */
export interface ClientAnimations { animations: Record<string, string>; animate: Array<string | Record<string, string>> }

function clientEntity(id: string, meshIds: string[], canopyMeshId?: string, opaqueMaterial = 'entity_alphablend', animations?: ClientAnimations): unknown {
    const materials: Record<string, string> = { default: opaqueMaterial };
    const textures: Record<string, string> = { default: `textures/entity/${id}` };
    if (canopyMeshId) {
        materials.canopy = 'entity_alphablend';
        textures.canopy = `textures/entity/${id}_canopy`;
    }
    const geometryMap: Record<string, string> = {};
    for (let i = 0; i < meshIds.length; i++) {
        const mesh = meshIds[i]!;
        if (mesh === canopyMeshId) {
            geometryMap.canopy = mesh;
        } else {
            geometryMap[`mesh_${i}`] = mesh;
        }
    }
    return {
        format_version: '1.10.0',
        'minecraft:client_entity': {
            description: {
                identifier: `${PACK_NAMESPACE}:${id}`,
                materials,
                textures,
                geometry: geometryMap,
                render_controllers: meshIds.map((mesh, i) =>
                    mesh === canopyMeshId
                        ? `controller.render.${PACK_NAMESPACE}.${id}_canopy`
                        : `controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`
                ),
                ...(animations ? { animations: animations.animations, scripts: { animate: animations.animate } } : {}),
                spawn_egg: { base_color: '#151515', overlay_color: '#f5c542' },
            },
        },
    };
}
function meshControllers(id: string, meshIds: string[], canopyMeshId?: string): unknown {
    const controllers: Record<string, unknown> = {};
    for (let i = 0; i < meshIds.length; i++) {
        const mesh = meshIds[i]!;
        if (mesh === canopyMeshId) {
            controllers[`controller.render.${PACK_NAMESPACE}.${id}_canopy`] = {
                geometry: 'Geometry.canopy',
                materials: [{ '*': 'Material.canopy' }],
                textures: ['Texture.canopy'],
            };
        } else {
            controllers[`controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`] = {
                geometry: `Geometry.mesh_${i}`,
                materials: [{ '*': 'Material.default' }],
                textures: ['Texture.default'],
            };
        }
    }
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
      try { players = world.getAllPlayers(); } catch {}
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
    if (!grid.countNonAir() && !options.components?.some(c => c.grid.countNonAir()) && !options.figures?.length)
        throw new Error('Nothing to export — the model has no blocks.');
    const label = options.label ?? options.stem, id = safe(options.stem), mode = options.vehicleMode ?? 'auto';
    // One scale for everything compiled from parts (engine/addon-scale.ts).
    const modelScale = Number.isFinite(options.modelScale) && options.modelScale! > 0 ? options.modelScale! : 1;
    const unitsPerLdu = BEDROCK_UNITS_PER_LDU * modelScale;
    const lduPerBlock = LDU_PER_BLOCK / modelScale;
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
    const version = exportVersion();
    const bpHeader = deterministicUuid(`craftmatic.addon.bp.header:${id}`), rpHeader = deterministicUuid(`craftmatic.addon.rp.header:${id}`);
    files.push({ name: bp + 'manifest.json', data: json({ format_version: 2, header: { name: `${label} — Playable`, description: `Place with /function ${shortAlias}; ride vehicles and use computer screens.`, uuid: bpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'data', uuid: deterministicUuid(`craftmatic.addon.bp.data:${id}`), version }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: deterministicUuid(`craftmatic.addon.bp.script:${id}`), version }], dependencies: [{ uuid: rpHeader, version }, { module_name: '@minecraft/server', version: '2.9.0' }, { module_name: '@minecraft/server-ui', version: '2.1.0' }] }) });
    // Vibrant Visuals texture sets are emitted for brick-compiled entities; the
    // manifest must declare the capability or the game ignores the MER/normal maps.
    const pbr = options.pbr ?? true;
    const emitsPbr = pbr && components.some(c => c.bricks && c.bricks.length > 0);
    files.push({ name: rp + 'manifest.json', data: json({ format_version: 2, header: { name: `${label} — Playable Resources`, description: 'Faithful Craftmatic vehicle geometry and HD LEGO textures', uuid: rpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'resources', uuid: deterministicUuid(`craftmatic.addon.rp.resources:${id}`), version }], ...(emitsPbr ? { capabilities: ['pbr'] } : {}) }) });
    const diagnostics: Record<string, LegoGeometryDiagnostics> = {};
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
    const actors: PlacementActor[] = [];
    const extraComponents: PlayableAddonResult['components'] = [];
    /** Behaviour + client entity + geometry + render controllers + colour/PBR atlases for one brick-compiled entity. */
    let minifigsEmitted = 0;
    const emitCompiledEntity = (ecid: string, geo: CompiledLdrawGeometry, behavior: unknown, animations?: ClientAnimations): void => {
        if (animations) minifigsEmitted++;
        files.push(
            { name: `${bp}entities/${ecid}.json`, data: json(behavior) },
            { name: `${rp}entity/${ecid}.entity.json`, data: json(clientEntity(ecid, geo.meshIds, geo.canopyMeshId, 'entity', animations)) },
            { name: `${rp}models/entity/${ecid}.geo.json`, data: json(geo.value) },
            { name: `${rp}render_controllers/${ecid}.render_controllers.json`, data: json(meshControllers(ecid, geo.meshIds, geo.canopyMeshId)) },
        );
        // One atlas per mesh material: exact LDraw RGB, plus the PBR maps.
        const atlases: Array<[string, typeof geo.materials]> = [[ecid, geo.materials]];
        if (geo.canopyMeshId) atlases.push([`${ecid}_canopy`, geo.canopyMaterials]);
        for (const [name, materials] of atlases) {
            const atlas = generateLegoEntityTextureAtlas(materials, { pbr, fallbackHighlights: !pbr, textureName: name });
            files.push({ name: `${rp}textures/entity/${name}.png`, data: atlas.colorPng });
            if (atlas.merPng && atlas.normalPng && atlas.textureSetJson) {
                files.push(
                    { name: `${rp}textures/entity/${name}_mer.png`, data: atlas.merPng },
                    { name: `${rp}textures/entity/${name}_normal.png`, data: atlas.normalPng },
                    { name: `${rp}textures/entity/${name}.texture_set.json`, data: text(atlas.textureSetJson) },
                );
            }
        }
    };
    // Brick-accurate building: the scenery's parts compiled as one static
    // entity on the grid's own frame, over invisible colliders that follow
    // the part heights (bedrock-building-shell.ts).
    if (options.shell && options.shell.bricks.length && scenery.countNonAir()) {
        const rawShell = `${id}_shell`;
        const shellId = /^[0-9]/.test(rawShell) ? `b_${rawShell}` : rawShell;
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
            emitCompiledEntity(shellId, sgeo, shellBehavior(shellId));
            const at = sceneGridPoint(options.shell.frame, sgeo.originLdu);
            actors.push({ typeId: `${PACK_NAMESPACE}:${shellId}`, label: `${label} bricks`, x: at[0], y: at[1] + sgeo.originLiftBlocks, z: at[2], yaw: 0 });
            extraComponents.push({ id: shellId, label: `${label} bricks`, kind: 'shell', provenance: `${options.shell.bricks.length} parts compiled as the building's visible geometry` });
            const colliders = buildColliderGrid(scenery, sgeo.partBoxesLdu ?? [], options.shell.frame);
            structureGrid = colliders.grid;
            plan = planStructureTiles(structureGrid, id, options.maxTile ?? BEDROCK_MAX_TILE);
            const runs = encodeColliderRuns(structureGrid, COLLIDER_BLOCK_ID);
            placementColliders = { width: structureGrid.width, height: structureGrid.height, length: structureGrid.length, block: COLLIDER_BLOCK_ID, loState: COLLIDER_LO_STATE, hiState: COLLIDER_HI_STATE, runs: runs.runs, keptCells: runs.keptCells };
            files.push(
                { name: `${bp}blocks/collider.json`, data: json(colliderBlockDefinition()) },
                { name: `${rp}blocks.json`, data: json(COLLIDER_BLOCKS_JSON) },
                { name: `${rp}textures/blocks/craftmatic_collider.png`, data: transparentPng() },
            );
            Object.assign(terrainTextures, COLLIDER_TERRAIN_TEXTURE);
            warnings.push(`${label}: brick-accurate building - ${sgeo.diagnostics.cubeCount} cuboids at ${sgeo.diagnostics.quality.microcellLdu} LDU over ${colliders.stats.colliders} invisible collider blocks (${colliders.stats.partial} part-height, ${colliders.stats.kept} doors/lights kept).`);
        } catch (e) {
            warnings.push(`${label}: the brick-accurate building could not be compiled (${e instanceof Error ? e.message : String(e)}); exported as blocks.`);
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
        const cid = /^[0-9]/.test(rawCid) ? `v_${rawCid}` : rawCid;
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
            emitCompiledEntity(cid, ldrawGeo, behaviorEntity(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing, c.seatAnchor, componentIsTimeMachine, options.seatCount ?? 1, ldrawGeo.seatPosition, ldrawGeo.collisionBox, ldrawGeo.sizeBlocks));
            cameraVehicles.push(emitCameraPresets(cid, c.kind, ldrawGeo.sizeBlocks));

            // Secondary objects the compiler found beside the vehicle (see
            // EntityExtra): figures wander as minifig NPCs, a wheeled second
            // vehicle is rideable, a wheel-less one is a static prop. They are
            // placed relative to the vehicle's actor in its own levelled frame,
            // so they stand where the source put them, and turn with the wand.
            const extras = options.mainVehicleOnly ? [] : ldrawGeo.extras.filter(e => e.role !== 'prop');
            const primaryPos = { x: c.x ?? grid.width / 2, y: c.y ?? 1, z: c.z ?? grid.length / 2 };
            let figureIndex = 0, subIndex = 0;
            for (const extra of extras) {
                const ekind: EntityKind = extra.role === 'figure' ? 'figure' : extra.wheels >= 2 ? 'car' : 'prop';
                const ecid = `${cid}_${ekind === 'figure' ? `fig${++figureIndex}` : `sub${++subIndex}`}`;
                const elabel = ekind === 'figure' ? `${c.label} figure ${figureIndex}` : ekind === 'car' ? `${c.label} vehicle ${subIndex}` : `${c.label} prop ${subIndex}`;
                options.onProgress?.(`compiling ${elabel}`);
                let egeo: CompiledLdrawGeometry;
                try {
                    egeo = await compileLdrawEntityGeometry(ecid, ekind, extra.bricks, {
                        scale: unitsPerLdu,
                        ...(extra.facingLdu ? { facing: snapFacing(extra.facingLdu) } : {}),
                        partGeometry: options.partGeometry, quality: options.entityQuality, pbr,
                    });
                } catch (e) {
                    warnings.push(`${elabel}: could not be compiled (${e instanceof Error ? e.message : String(e)}); left out.`);
                    continue;
                }
                diagnostics[ecid] = egeo.diagnostics;
                warnings.push(...egeo.warnings.filter(w => !/front\/rear direction/.test(w)));
                const behavior = ekind === 'figure' ? figureBehavior(ecid, egeo.sizeBlocks)
                    : ekind === 'prop' ? propBehavior(ecid, egeo.collisionBox)
                    : behaviorEntity(ecid, 'car', c.grid, c.sceneScale, c.longitudinalAxis, egeo.facing, undefined, false, 1, egeo.seatPosition, egeo.collisionBox, egeo.sizeBlocks);
                emitCompiledEntity(ecid, egeo, behavior, ekind === 'figure' && egeo.figure ? MINIFIG_CLIENT_ANIMATIONS : undefined);
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
            files.push({ name: `${rp}entity/${cid}.entity.json`, data: json(clientEntity(cid, geo.meshIds)) }, { name: `${rp}models/entity/${cid}.geo.json`, data: json(geo.value) }, { name: `${rp}render_controllers/${cid}.render_controllers.json`, data: json(meshControllers(cid, geo.meshIds)) }, { name: `${rp}textures/entity/${cid}.png`, data: generateEntityLegoAtlasPng(geo.palette, blockRgb, blockAlpha) });
        }
        actors.push({ typeId: fullTypeId, label: c.label, x: c.x ?? grid.width / 2, y: c.y ?? 1, z: c.z ?? grid.length / 2, yaw: layout.actorYaw });
    }
    // Figures found in the scenery: one minifig NPC type each, standing where the source put them.
    const figureKindCounts: Record<string, number> = {};
    /** Actor index of each scene figure, so a seated one can be told which seat actor to ride. */
    const figureActorIndex = new Map<number, number>();
    for (const [k, fig] of (options.figures ?? []).entries()) {
        const rawFig = `${id}_fig${k + 1}`;
        const fcid = /^[0-9]/.test(rawFig) ? `f_${rawFig}` : rawFig;
        const flabel = `${label} figure ${k + 1}`;
        options.onProgress?.(`compiling ${flabel}`);
        let fgeo: CompiledLdrawGeometry;
        try {
            fgeo = await compileLdrawEntityGeometry(fcid, 'figure', fig.bricks, { scale: unitsPerLdu, facing: snapFacing(fig.facingLdu), partGeometry: options.partGeometry, quality: options.entityQuality, pbr });
        } catch (e) {
            warnings.push(`${flabel}: could not be compiled (${e instanceof Error ? e.message : String(e)}); left out.`);
            continue;
        }
        diagnostics[fcid] = fgeo.diagnostics;
        warnings.push(...fgeo.warnings.filter(w => !/front\/rear direction/.test(w)));
        emitCompiledEntity(fcid, fgeo, figureBehavior(fcid, fgeo.sizeBlocks), fgeo.figure ? MINIFIG_CLIENT_ANIMATIONS : undefined);
        // A rigged figure faces exactly where its torso pointed; an unrigged one the nearest axis it was compiled to.
        const yaw = fgeo.figure ? yawForFacing(fgeo.figure.facingLdu) : (() => {
            const nose = snapFacing(fig.facingLdu);
            const n: [number, number] = nose === '+x' ? [1, 0] : nose === '-x' ? [-1, 0] : nose === '+z' ? [0, 1] : [0, -1];
            return normaliseYaw(Math.atan2(-n[0] || 0, n[1]) * 180 / Math.PI);
        })();
        actors.push({ typeId: `${PACK_NAMESPACE}:${fcid}`, label: flabel, x: fig.x, y: fig.y, z: fig.z, yaw });
        figureActorIndex.set(k, actors.length - 1);
        extraComponents.push({ id: fcid, label: flabel, kind: 'figure', provenance: fig.seatIndex !== undefined ? 'minifig sitting in the build' : 'minifig standing in the build' });
        figureKindCounts['figure'] = (figureKindCounts['figure'] ?? 0) + 1;
    }
    // Seats: one invisible rideable type shared by every chair and bench.
    const seatList = options.seats ?? [];
    if (seatList.length) {
        const rawSeat = `${id}_seat`;
        const seatId = /^[0-9]/.test(rawSeat) ? `s_${rawSeat}` : rawSeat;
        files.push(
            { name: `${bp}entities/${seatId}.json`, data: json(seatBehavior(seatId)) },
            { name: `${rp}entity/${seatId}.entity.json`, data: json(seatClient(seatId)) },
            { name: `${rp}models/entity/craftmatic_seat.geo.json`, data: json(SEAT_GEOMETRY) },
            { name: `${rp}textures/entity/craftmatic_seat.png`, data: transparentPng() },
        );
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
    const screenId = /^[0-9]/.test(rawScreenId) ? `s_${rawScreenId}` : rawScreenId;
    if (screens.length) {
        files.push({ name: `${bp}entities/${screenId}.json`, data: json(screenBehavior(screenId)) }, { name: `${rp}entity/${screenId}.entity.json`, data: json(screenClient(screenId)) }, { name: `${rp}models/entity/control_screen.geo.json`, data: json(SCREEN_GEOMETRY) }, { name: `${rp}textures/entity/craftmatic_screen.png`, data: palettePng(['cyan']) });
        for (const s of screens)
            actors.push({ typeId: `${PACK_NAMESPACE}:${screenId}`, label: s.label, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
    }
    // One animation file serves every minifig entity: the rig's bone names are shared.
    if (minifigsEmitted) files.push({ name: `${rp}animations/craftmatic_minifig.animation.json`, data: json(MINIFIG_ANIMATIONS) });
    if (unmapped.size) warnings.push(`${unmapped.size} block type${unmapped.size === 1 ? '' : 's'} had no Bedrock equivalent and ${unmapped.size === 1 ? 'was' : 'were'} omitted: ${[...unmapped].join(', ')}`);
    if (modelScale !== 1) warnings.push(`${label}: exported at ${modelScale}× minifig scale (1 block = ${Math.round(lduPerBlock * 100) / 100} LDU) - blocks, colliders, entities and figures alike.`);
    // Every fidelity degradation is inspectable from the pack itself.
    if (Object.keys(diagnostics).length) files.push({ name: `${bp}craftmatic-diagnostics.json`, data: json({ generator: 'craftmatic', label, entities: diagnostics }) });
    const previewPoints = previewSamples(scenery, components.length ? 90 : 120);
    const perVehicle = Math.floor((120 - previewPoints.length) / Math.max(1, components.length));
    for (const c of components) {
        const scale = componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis).scale;
        for (const p of previewSamples(c.grid, perVehicle)) previewPoints.push({
            x: (c.x ?? grid.width / 2) + (p.x - c.grid.width / 2) * scale,
            y: (c.y ?? 1) + p.y * scale,
            z: (c.z ?? grid.length / 2) + (p.z - c.grid.length / 2) * scale,
        });
    }
    // Ghost preview of the whole placement: scenery plus each vehicle at its scene position.
    options.onProgress?.('building placement preview', 85);
    const ghost = buildPreviewGhost(id, scenery, components.map((c): PreviewComponentPlacement => ({
        grid: c.grid, scale: componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis).scale,
        x: c.x ?? grid.width / 2, y: c.y ?? 1, z: c.z ?? grid.length / 2,
    })));
    files.push(
        { name: `${bp}entities/${id}_preview.json`, data: json(ghost.behavior) },
        { name: `${rp}entity/${id}_preview.entity.json`, data: json(ghost.clientEntity) },
        { name: `${rp}models/entity/${id}_preview.geo.json`, data: json(ghost.geometry) },
        { name: `${rp}render_controllers/${id}_preview.render_controllers.json`, data: json(ghost.renderControllers) },
        { name: `${rp}textures/entity/${id}_preview.png`, data: ghost.texturePng },
    );
    const placement = buildPlacementPackAssets({ stem: id, label, width: grid.width, height: grid.height, length: grid.length,
        tiles: plan.map(tile => ({ identifier: `${PACK_NAMESPACE}:${tile.name}`, dx: tile.x, dy: tile.y, dz: tile.z, width: tile.width, height: tile.height, length: tile.length, nonAir: tile.nonAir })), actors, previewPoints,
        preview: { typeId: ghost.typeId },
        ...(placementColliders ? { colliders: placementColliders } : {}),
        ...(timeMachineConfig ? { vehicleControls: true } : {}) });
    files.push(...placement.files.map(file => ({ ...file, name: bp + file.name })));
    if (timeMachineConfig) files.push({ name: `${bp}scripts/time-machine.js`, data: text(timeMachineScript(timeMachineConfig)) });
    if (driverVehicles.length) files.push({ name: `${bp}scripts/vehicle-driver.js`, data: text(vehicleDriverScript({ vehicles: driverVehicles, dashCooldownTicks: Math.round(DASH_ACTION.cooldown_time * 20), descendOn: AIRCRAFT_DESCEND_ON, descendOff: AIRCRAFT_DESCEND_OFF })) });
    if (cameraVehicles.length) files.push({ name: `${bp}scripts/vehicle-camera.js`, data: text(vehicleCameraScript({ vehicles: cameraVehicles })) });
    const mainImports = [
        "import './placement.js';",
        ...(driverVehicles.length ? ["import './vehicle-driver.js';"] : []),
        ...(cameraVehicles.length ? ["import './vehicle-camera.js';"] : []),
    ].join('\n');
    files.push({ name: `${bp}scripts/main.js`, data: text(`${mainImports}\nconst SCREEN_TYPE = ${JSON.stringify(PACK_NAMESPACE + ':' + screenId)};\n${SCREEN_SCRIPT}`) }, { name: `${bp}README.txt`, data: text(`${label}\n\nImport this .mcaddon, activate both packs, rejoin the world. Find '${label} Brick Wand' in Creative inventory or run /function ${placement.shortAlias}. Select the wand in your hotbar to open it; switch away and back to reopen it. Pin a position (or "Follow my aim" to carry the preview to wherever you look), then "View preview in world" shows a translucent ghost of the whole build standing at the pin, turned to the chosen rotation and size; rotate (90 degree steps for a build with blocks, 15 degree steps for a vehicle or figure alone), pick a size from 25% to 400%, place, and undo if needed. At another size every entity takes that size and a brick-accurate building's invisible walkable blocks are re-laid to match (its vanilla doors and lights are left out); a coloured-block export keeps its blocks at 100%. Placement shows a progress bar above the hotbar.\nCars and boats: interact to ride. Push the joystick (or A/D) LEFT and RIGHT to steer, forward and back to drive - the camera stays behind you; hold Jump to charge a dash and release it for a boost; the Dismount (sneak) button gets you out. Planes: ride to fly - push the joystick LEFT and RIGHT to turn and forward to fly; Jump climbs straight up; pull the joystick BACK while holding Jump to descend straight down; looking up or down also climbs or dives; Dismount (sneak) exits. Figures from the set walk about on their own; a second vehicle in the set is rideable too (export with "main vehicle only" to leave them out). Vehicles resist damage. While you ride, a chase camera sized to the vehicle follows you; it clears when you dismount.${isTimeMachine ? ' 10300 Time Machine: use DeLorean controls on the Brick Wand to set destination coordinates and a teleport speed (88 mph by default).' : ''} Buildings: the set's figures walk about on their own, its doors open (tap them), and its chairs and benches can be sat on (interact, sneak to get up). A brick-accurate building is drawn by one entity standing on invisible blocks that follow the LEGO floors and walls; undo removes both. Computer screens: interact for lights, doors, scanner vision, and vehicle locations.\n`) });
    options.onProgress?.('packaging playable .mcaddon', 90);
    const bytes = await createZip(files, { alwaysDeflate: true });
    return { bytes, functionCommand: `/function ${placement.shortAlias}`, tileCount: plan.length, components: [...components.map(c => ({ id: c.id, label: c.label, kind: c.kind, provenance: c.provenance })), ...extraComponents, ...screens.map(s => ({ id: s.id, label: s.label, kind: 'screen' as const, provenance: 'source-aligned interaction anchor' }))], warnings, diagnostics };
}
