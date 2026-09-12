import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { createZip } from './zip-utils.js';
import { deterministicUuid, exportVersion, PACK_NAMESPACE, toBedrockIdentifier } from './mcpack.js';
import { BEDROCK_MAX_TILE, encodeMcstructureTile, planStructureTiles } from './mcstructure-encode.js';
import type { PlayableKind, VehicleFacing, VehicleMode } from './playable-components.js';
import { classifyVehicleKind, isWholeVehicleLabel } from './playable-components.js';
import { buildPlacementPackAssets, placementAlias, type PlacementActor } from './bedrock-placement-pack.js';
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
    /** Exact, separately voxelized source components. Required for a vehicle embedded in a larger build. */
    components?: PlayableGridComponent[];
    screens?: PlayableScreenAnchor[];
    maxTile?: {
        x: number;
        y: number;
        z: number;
    };
    onProgress?: (phase: string, pct?: number) => void;
}
export interface PlayableAddonResult {
    bytes: Uint8Array;
    functionCommand: string;
    tileCount: number;
    components: Array<{
        id: string;
        label: string;
        kind: PlayableKind | 'screen';
        provenance: string;
    }>;
    warnings: string[];
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

function behaviorEntity(id: string, kind: PlayableKind, grid: BlockGrid, sceneScale?: number, longitudinalAxis?: 'x' | 'z', facing: VehicleFacing = 'auto', seatAnchor?: {x:number;y:number;z:number}, isTimeMachine = false): unknown {
    const layout = componentLayout(kind, grid, sceneScale, longitudinalAxis, facing);
    const seat = seatAnchor ?? { x: .5, y: .45, z: .5 };
    const ox = (seat.x - .5) * grid.width * layout.scale, oz = (seat.z - .5) * grid.length * layout.scale;
    // Mojang's vanilla horse geometry establishes -Z as model-forward. Keep
    // the source footprint fixed while its selected nose follows that axis.
    const seatX = layout.longitudinalAxis === 'x' ? layout.forwardSign * oz : -layout.forwardSign * ox;
    const seatZ = layout.longitudinalAxis === 'x' ? -layout.forwardSign * ox : -layout.forwardSign * oz;
    const seatY = Math.max(.35, Math.min(layout.height - .35, layout.height * seat.y));
    const common: Record<string, unknown> = {
        'minecraft:type_family': { family: ['craftmatic_vehicle', kind] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        // Bedrock exposes one horizontal diameter, not a rectangular box. Use
        // the transverse body width so a long car can still pass a doorway.
        'minecraft:collision_box': { width: Math.max(0.8, layout.width * .85), height: Math.max(.8, layout.height * .8) },
        'minecraft:rideable': { seat_count: 1, family_types: ['player'], interact_text: 'action.interact.mount', crouching_skip_interact: true, seats: { position: [seatX, seatY, seatZ], lock_rider_rotation: 0 } },
        'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: true },
        'minecraft:movement': isTimeMachine
            ? { value: .02, max: 6 }
            : { value: kind === 'car' ? 1.05 : 1.35, max: kind === 'car' ? 1.35 : 1.8 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 160, max_dropped_ticks: 7, use_motion_prediction_hints: true } },
    };
    if (kind === 'car')
        Object.assign(common, {
            'minecraft:physics': { has_gravity: true, has_collision: true },
            'minecraft:input_ground_controlled': {},
            'minecraft:movement.basic': { max_turn: 18 },
            'minecraft:navigation.walk': { can_path_over_water: true, avoid_damage_blocks: false },
            'minecraft:variable_max_auto_step': { base_value: 1.25, controlled_value: 1.56, jump_prevented_value: .6 },
        });
    else
        Object.assign(common, {
            'minecraft:physics': { has_gravity: false, has_collision: true },
            'minecraft:can_fly': {},
            'minecraft:input_air_controlled': { strafe_speed_modifier: 1, backwards_movement_modifier: .4 },
            'minecraft:movement.fly': { max_turn: 18, start_speed: 0, speed_when_turning: .86 },
            'minecraft:flying_speed': { value: 1.35 },
            'minecraft:vertical_movement_action': { vertical_velocity: .9 },
            'minecraft:body_rotation_always_follows_head': {},
        });
    return { format_version: '1.21.90', 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: true, is_summonable: true }, components: common } };
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
        const uv = [palette.indexOf(b.state) % 16, Math.floor(palette.indexOf(b.state) / 16)], face = { uv, uv_size: [1, 1] };
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
        return { origin, size, uv: { north: face, south: face, east: face, west: face, up: face, down: face } };
    });
    // Each render controller owns a small mesh. A single 8,000-cube mesh can
    // exceed 16-bit vertex/index ranges on mobile renderers (24 vertices/cube).
    // Partitioning preserves every cube and its coordinates without decimation.
    const meshIds: string[] = [], meshes = [];
    for (let offset = 0; offset < cubes.length; offset += 1024) {
        const meshId = `geometry.${PACK_NAMESPACE}.${id}_mesh_${meshIds.length}`;
        meshIds.push(meshId);
        meshes.push({ description: { identifier: meshId, texture_width: 16, texture_height: Math.max(1, Math.ceil(palette.length / 16)), visible_bounds_width: Math.max(2, layout.width, layout.length), visible_bounds_height: Math.max(2, layout.height), visible_bounds_offset: [0, layout.height / 2, 0] }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes: cubes.slice(offset, offset + 1024) }] });
    }
    return { value: { format_version: '1.12.0', 'minecraft:geometry': meshes }, palette, meshIds };
}
function clientEntity(id: string, meshIds: string[]): unknown { return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, materials: { default: 'entity_alphablend' }, textures: { default: `textures/entity/${id}` }, geometry: Object.fromEntries(meshIds.map((mesh, i) => [`mesh_${i}`, mesh])), render_controllers: meshIds.map((_, i) => `controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`), spawn_egg: { base_color: '#151515', overlay_color: '#f5c542' } } } }; }
function meshControllers(id: string, meshIds: string[]): unknown {
    return { format_version: '1.8.0', render_controllers: Object.fromEntries(meshIds.map((_, i) => [
        `controller.render.${PACK_NAMESPACE}.${id}_mesh_${i}`,
        { geometry: `Geometry.mesh_${i}`, materials: [{ '*': 'Material.default' }], textures: ['Texture.default'] },
    ])) };
}
function screenClient(id: string): unknown { return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, materials: { default: 'entity_emissive_alpha' }, textures: { default: 'textures/entity/craftmatic_screen' }, geometry: { default: `geometry.${PACK_NAMESPACE}.control_screen` }, render_controllers: ['controller.render.default'] } } }; }
const SCREEN_GEOMETRY = { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: `geometry.${PACK_NAMESPACE}.control_screen`, texture_width: 1, texture_height: 1, visible_bounds_width: 2, visible_bounds_height: 2, visible_bounds_offset: [0, 1, 0] }, bones: [{ name: 'screen', pivot: [0, 0, 0], cubes: [{ origin: [-8, 0, -1], size: [16, 16, 2], uv: [0, 0] }] }] }] };
function screenBehavior(id: string): unknown { return { format_version: '1.21.90', 'minecraft:entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, is_spawnable: false, is_summonable: true }, components: { 'minecraft:type_family': { family: ['craftmatic_screen'] }, 'minecraft:health': { value: 20, max: 20 }, 'minecraft:collision_box': { width: 1, height: 1 }, 'minecraft:physics': { has_gravity: false, has_collision: false }, 'minecraft:persistent': {}, 'minecraft:nameable': {}, 'minecraft:interact': { interactions: [{ interact_text: 'action.interact.craftmatic_screen' }] } } } }; }
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
      const velocity = vehicle.getVelocity(), horizontal = Math.hypot(velocity.x, velocity.z), mph = horizontal * MPH_PER_BLOCK_TICK;
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

function vehicleDriverRuntime(config: { vehicles: Array<{ typeId: string; kind: 'car' | 'plane'; label: string }> }) {
  const MPH_PER_BLOCK_TICK = 20 * 2.236936;
  const vehiclesByType = new Map(config.vehicles.map((v: any) => [v.typeId, v]));
  const states = new Map<string, any>();
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

      const vel = vehicle.getVelocity?.() ?? { x: 0, y: 0, z: 0 };
      const horizontal = Math.hypot(vel.x, vel.z);
      const mph = horizontal * MPH_PER_BLOCK_TICK;
      const isCar = vConfig.kind === 'car';

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

      // 1. Turbo Boost on Jump
      if (jump && state.boostCooldown <= 0 && forwardInput >= 0) {
        state.boostCooldown = 30;
        const boost = isCar ? 0.4 : 0.5;
        const lift = isCar ? 0.15 : (dir.y * 0.3 + 0.1);
        try {
          vehicle.applyImpulse?.({
            x: (dir.x / hDir) * boost,
            y: lift,
            z: (dir.z / hDir) * boost,
          });
        } catch {}
        try { vehicle.dimension?.playSound?.('firework.launch', vehicle.location, { volume: 0.8, pitch: 1.2 }); } catch {}
        try { vehicle.dimension?.spawnParticle?.('minecraft:flame_particle', vehicle.location); } catch {}
        try { vehicle.dimension?.spawnParticle?.('minecraft:campfire_smoke_particle', vehicle.location); } catch {}
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

      // 3. Drift Tire Smoke on High Speed Turns
      if (isCar && mph > 10 && Math.abs(steerInput) > 0.35) {
        try { vehicle.dimension?.spawnParticle?.('minecraft:smoke_particle', vehicle.location); } catch {}
        if (tick % 8 === 0) {
          try { vehicle.dimension?.playSound?.('step.cloth', vehicle.location, { volume: 0.4, pitch: 0.7 }); } catch {}
        }
      }

      // 4. Headlights (automatic night vision)
      if (tick % 20 === 0) {
        try { rider.addEffect?.('minecraft:night_vision', 80, { showParticles: false }); } catch {}
      }

      // 5. Action Bar Speedometer HUD
      if (tick % 4 === 0) {
        const boostReady = state.boostCooldown <= 0;
        const icon = isCar ? '🏎️' : '✈️';
        const boostTag = boostReady ? ' · §a[JUMP: NITRO]§r' : ` · §8[NITRO: ${(state.boostCooldown / 20).toFixed(1)}s]§r`;
        const hud = isCar
          ? `${icon} §e${mph.toFixed(1)} mph§r${boostTag}`
          : `${icon} §e${mph.toFixed(1)} mph§r · §bALT ${Math.floor(vehicle.location?.y ?? 0)}§r${boostTag}`;
        try { rider.onScreenDisplay?.setActionBar?.(hud); } catch {}
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

const vehicleDriverScript = (config: { vehicles: Array<{ typeId: string; kind: 'car' | 'plane'; label: string }> }) =>
  `import { world, system } from "@minecraft/server";\n(${vehicleDriverRuntime.toString()})(${JSON.stringify(config)});\n`;

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
    if (!grid.countNonAir() && !options.components?.some(c => c.grid.countNonAir()))
        throw new Error('Nothing to export — the model has no blocks.');
    const label = options.label ?? options.stem, id = safe(options.stem), mode = options.vehicleMode ?? 'auto';
    const isTimeMachine = /\b10300\b|delorean|de lorean|time machine/i.test(`${id} ${label}`);
    const shortAlias = placementAlias(id);
    const components = options.components?.slice() ?? [];
    const warnings: string[] = [];
    if (!components.length && (mode === 'car' || mode === 'plane'))
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
    files.push({ name: rp + 'manifest.json', data: json({ format_version: 2, header: { name: `${label} — Playable Resources`, description: 'Faithful Craftmatic vehicle geometry', uuid: rpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'resources', uuid: deterministicUuid(`craftmatic.addon.rp.resources:${id}`), version }] }) });
    const scenery = components.some(c => c.grid === grid) ? new BlockGrid(grid.width, grid.height, grid.length) : grid;
    const plan = planStructureTiles(scenery, id, options.maxTile ?? BEDROCK_MAX_TILE);
    const actors: PlacementActor[] = [];
    let timeMachineConfig: { typeId: string; width: number; height: number; length: number } | undefined;
    const driverVehicles: Array<{ typeId: string; kind: 'car' | 'plane'; label: string }> = [];
    const unmapped = new Set<string>();
    for (let i = 0; i < plan.length; i++) {
        const tile = plan[i]!, out = encodeMcstructureTile(grid, tile);
        for (const state of out.unmapped) unmapped.add(state);
        files.push({ name: `${bp}structures/${PACK_NAMESPACE}/${tile.name}.mcstructure`, data: out.bytes });
        options.onProgress?.(`encoding structure ${i + 1}/${plan.length}`, Math.round((i + 1) / plan.length * 70));
    }
    for (const c of components) {
        const cid = safe(`${id}_${c.id}`).length === `${id}_${c.id}`.length ? safe(`${id}_${c.id}`) : safe(`${id.slice(0, 24)}_${c.id.slice(0, 12)}_${deterministicUuid(`${id}:${c.id}`).slice(0, 8)}`);
        const fullTypeId = `${PACK_NAMESPACE}:${cid}`;
        const facing = options.vehicleFacing && options.vehicleFacing !== 'auto' ? options.vehicleFacing : c.forwardDirection ?? 'auto';
        if (c.kind === 'car' && facing === 'auto') warnings.push(`${c.label}: front/rear direction was not identifiable from source geometry; select an explicit vehicle facing if it drives backward.`);
        const layout = componentLayout(c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing);
        const componentIsTimeMachine = isTimeMachine && c.kind === 'car' && !timeMachineConfig;
        if (componentIsTimeMachine)
            timeMachineConfig = { typeId: fullTypeId, width: layout.width, height: layout.height, length: layout.length };
        else if (c.kind === 'car' || c.kind === 'plane')
            driverVehicles.push({ typeId: fullTypeId, kind: c.kind, label: c.label });
        files.push({ name: `${bp}entities/${cid}.json`, data: json(behaviorEntity(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing, c.seatAnchor, componentIsTimeMachine)) });
        const geo = geometry(cid, c.kind, c.grid, c.sceneScale, c.longitudinalAxis, facing);
        files.push({ name: `${rp}entity/${cid}.entity.json`, data: json(clientEntity(cid, geo.meshIds)) }, { name: `${rp}models/entity/${cid}.geo.json`, data: json(geo.value) }, { name: `${rp}render_controllers/${cid}.render_controllers.json`, data: json(meshControllers(cid, geo.meshIds)) }, { name: `${rp}textures/entity/${cid}.png`, data: palettePng(geo.palette) });
        actors.push({ typeId: fullTypeId, label: c.label, x: c.x ?? grid.width / 2, y: c.y ?? 1, z: c.z ?? grid.length / 2, yaw: layout.actorYaw });
    }
    const screens = options.screens ?? [], screenId = `${id}_control_screen`;
    if (screens.length) {
        files.push({ name: `${bp}entities/${screenId}.json`, data: json(screenBehavior(screenId)) }, { name: `${rp}entity/${screenId}.entity.json`, data: json(screenClient(screenId)) }, { name: `${rp}models/entity/control_screen.geo.json`, data: json(SCREEN_GEOMETRY) }, { name: `${rp}textures/entity/craftmatic_screen.png`, data: palettePng(['cyan']) });
        for (const s of screens)
            actors.push({ typeId: `${PACK_NAMESPACE}:${screenId}`, label: s.label, x: Math.round(s.x), y: Math.round(s.y), z: Math.round(s.z) });
    }
    if (unmapped.size) warnings.push(`${unmapped.size} block type${unmapped.size === 1 ? '' : 's'} had no Bedrock equivalent and ${unmapped.size === 1 ? 'was' : 'were'} omitted: ${[...unmapped].join(', ')}`);
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
    const placement = buildPlacementPackAssets({ stem: id, label, width: grid.width, height: grid.height, length: grid.length,
        tiles: plan.map(tile => ({ identifier: `${PACK_NAMESPACE}:${tile.name}`, dx: tile.x, dy: tile.y, dz: tile.z, width: tile.width, height: tile.height, length: tile.length, nonAir: tile.nonAir })), actors, previewPoints,
        ...(timeMachineConfig ? { vehicleControls: true } : {}) });
    files.push(...placement.files.map(file => ({ ...file, name: bp + file.name })));
    if (timeMachineConfig) files.push({ name: `${bp}scripts/time-machine.js`, data: text(timeMachineScript(timeMachineConfig)) });
    if (driverVehicles.length) files.push({ name: `${bp}scripts/vehicle-driver.js`, data: text(vehicleDriverScript({ vehicles: driverVehicles })) });
    const mainImports = [
        "import './placement.js';",
        ...(driverVehicles.length ? ["import './vehicle-driver.js';"] : []),
    ].join('\n');
    files.push({ name: `${bp}scripts/main.js`, data: text(`${mainImports}\nconst SCREEN_TYPE = ${JSON.stringify(PACK_NAMESPACE + ':' + screenId)};\n${SCREEN_SCRIPT}`) }, { name: `${bp}README.txt`, data: text(`${label}\n\nImport this .mcaddon, activate both packs, rejoin the world. Find '${label} Brick Wand' in Creative inventory or run /function ${placement.shortAlias}. Select the wand in your hotbar to open it; switch away and back to reopen it. Pin a position, preview, rotate, place, and undo.\nCars: interact to ride, press Jump for nitro boost, and steer into turns to drift. Planes: ride to fly with full 3D pitch/yaw and speed HUD. Vehicles resist damage.${isTimeMachine ? ' 10300 Time Machine: use DeLorean controls on the Brick Wand to set destination coordinates and a teleport speed (88 mph by default).' : ''} Computer screens: interact for lights, doors, scanner vision, and vehicle locations.\n`) });
    options.onProgress?.('packaging playable .mcaddon', 90);
    const bytes = await createZip(files, { alwaysDeflate: true });
    return { bytes, functionCommand: `/function ${placement.shortAlias}`, tileCount: plan.length, components: [...components.map(c => ({ id: c.id, label: c.label, kind: c.kind, provenance: c.provenance })), ...screens.map(s => ({ id: s.id, label: s.label, kind: 'screen' as const, provenance: 'source-aligned interaction anchor' }))], warnings };
}
