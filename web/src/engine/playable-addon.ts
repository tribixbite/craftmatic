import { BlockGrid } from '@craft/schem/types.js';
import { getBlockColor } from '@craft/blocks/colors.js';
import { createZip } from './zip-utils.js';
import { deterministicUuid, exportVersion, PACK_NAMESPACE, toBedrockIdentifier } from './mcpack.js';
import { BEDROCK_MAX_TILE, encodeMcstructureTile, planStructureTiles } from './mcstructure-encode.js';
import type { PlayableKind, VehicleMode } from './playable-components.js';
import { classifyVehicleKind, isWholeVehicleLabel } from './playable-components.js';
export interface PlayableGridComponent {
    id: string;
    label: string;
    kind: PlayableKind;
    grid: BlockGrid;
    provenance: string;
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

function behaviorEntity(id: string, kind: PlayableKind, grid: BlockGrid): unknown {
    const horizontal = Math.max(grid.width, grid.length);
    const scale = Math.min(1, 8 / Math.max(1, horizontal));
    const common: Record<string, unknown> = {
        'minecraft:type_family': { family: ['craftmatic_vehicle', kind] },
        'minecraft:nameable': {}, 'minecraft:persistent': {},
        'minecraft:health': { value: 100, max: 100 },
        'minecraft:collision_box': { width: Math.max(0.8, horizontal * scale * .8), height: Math.max(.8, grid.height * scale * .8) },
        'minecraft:rideable': { seat_count: 1, family_types: ['player'], interact_text: 'action.interact.mount', crouching_skip_interact: true, seats: { position: [0, Math.max(.5, grid.height * scale * .55), 0] } },
        'minecraft:pushable': { is_pushable: false, is_pushable_by_piston: true },
        'minecraft:movement': { value: kind === 'car' ? 1.4 : 1.8, max: kind === 'car' ? 1.8 : 2.4 },
        'minecraft:conditional_bandwidth_optimization': { default_values: { max_optimized_distance: 160, max_dropped_ticks: 7, use_motion_prediction_hints: true } },
    };
    if (kind === 'car')
        Object.assign(common, {
            'minecraft:physics': { has_gravity: true, has_collision: true },
            'minecraft:input_ground_controlled': {},
            'minecraft:movement.basic': { max_turn: 18 },
            'minecraft:navigation.walk': { can_path_over_water: true, avoid_damage_blocks: false },
            'minecraft:variable_max_auto_step': { base_value: 1.25, controlled_value: 1.25, jump_prevented_value: .6 },
        });
    else
        Object.assign(common, {
            'minecraft:physics': { has_gravity: false, has_collision: true },
            'minecraft:can_fly': {},
            'minecraft:input_air_controlled': { strafe_speed_modifier: 1, backwards_movement_modifier: .4 },
            'minecraft:movement.fly': { max_turn: 18, start_speed: 1.4, speed_when_turning: 1.15 },
            'minecraft:flying_speed': { value: 1.8 },
            'minecraft:vertical_movement_action': { vertical_velocity: 1.2 },
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
function geometry(id: string, grid: BlockGrid): {
    value: unknown;
    palette: string[];
} {
    const boxes = greedyBoxes(grid), cap = 16384;
    if (boxes.length > cap)
        throw new Error(`${id} needs ${boxes.length} geometry cuboids (export budget ${cap}); lower export resolution to preserve the complete model.`);
    const palette = [...new Set(boxes.map(b => b.state))];
    const scale = Math.min(1, 8 / Math.max(1, grid.width, grid.length));
    const cubes = boxes.map(b => { const uv = [palette.indexOf(b.state) % 16, Math.floor(palette.indexOf(b.state) / 16)], face = { uv, uv_size: [1, 1] }; return { origin: [(b.x - grid.width / 2) * 16 * scale, b.y * 16 * scale, (b.z - grid.length / 2) * 16 * scale], size: [b.sx * 16 * scale, b.sy * 16 * scale, b.sz * 16 * scale], uv: { north: face, south: face, east: face, west: face, up: face, down: face } }; });
    return { value: { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: `geometry.${PACK_NAMESPACE}.${id}`, texture_width: 16, texture_height: Math.max(1, Math.ceil(palette.length / 16)), visible_bounds_width: Math.max(2, grid.width * scale), visible_bounds_height: Math.max(2, grid.height * scale), visible_bounds_offset: [0, grid.height * scale / 2, 0] }, bones: [{ name: 'body', pivot: [0, 0, 0], cubes }] }] }, palette };
}
function clientEntity(id: string): unknown { return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: `${PACK_NAMESPACE}:${id}`, materials: { default: 'entity_alphatest' }, textures: { default: `textures/entity/${id}` }, geometry: { default: `geometry.${PACK_NAMESPACE}.${id}` }, render_controllers: ['controller.render.default'], spawn_egg: { base_color: '#151515', overlay_color: '#f5c542' } } } }; }
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
function blockRgb(state: string): [
    number,
    number,
    number
] { return getBlockColor(state) ?? [145, 145, 140]; }
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
        raw.set([r, g, b, 255], o);
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
    files.push({ name: bp + 'manifest.json', data: json({ format_version: 2, header: { name: `${label} — Playable`, description: `Place with /function ${PACK_NAMESPACE}/${id}; ride vehicles and use computer screens.`, uuid: bpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'data', uuid: deterministicUuid(`craftmatic.addon.bp.data:${id}`), version }, { type: 'script', language: 'javascript', entry: 'scripts/main.js', uuid: deterministicUuid(`craftmatic.addon.bp.script:${id}`), version }], dependencies: [{ uuid: rpHeader, version }, { module_name: '@minecraft/server', version: '2.9.0' }, { module_name: '@minecraft/server-ui', version: '2.1.0' }] }) });
    files.push({ name: rp + 'manifest.json', data: json({ format_version: 2, header: { name: `${label} — Playable Resources`, description: 'Faithful Craftmatic vehicle geometry', uuid: rpHeader, version, min_engine_version: [1, 26, 40] }, modules: [{ type: 'resources', uuid: deterministicUuid(`craftmatic.addon.rp.resources:${id}`), version }] }) });
    const scenery = components.some(c => c.grid === grid) ? new BlockGrid(grid.width, grid.height, grid.length) : grid;
    const plan = planStructureTiles(scenery, id, options.maxTile ?? BEDROCK_MAX_TILE), functionLines = ['# Generated by Craftmatic'];
    const unmapped = new Set<string>();
    for (let i = 0; i < plan.length; i++) {
        const tile = plan[i]!, out = encodeMcstructureTile(grid, tile);
        for (const state of out.unmapped) unmapped.add(state);
        files.push({ name: `${bp}structures/${PACK_NAMESPACE}/${tile.name}.mcstructure`, data: out.bytes });
        functionLines.push(`structure load ${PACK_NAMESPACE}:${tile.name} ~${tile.x} ~${tile.y} ~${tile.z}`);
        options.onProgress?.(`encoding structure ${i + 1}/${plan.length}`, Math.round((i + 1) / plan.length * 70));
    }
    for (const c of components) {
        const cid = safe(`${id}_${c.id}`).length === `${id}_${c.id}`.length ? safe(`${id}_${c.id}`) : safe(`${id.slice(0, 24)}_${c.id.slice(0, 12)}_${deterministicUuid(`${id}:${c.id}`).slice(0, 8)}`);
        files.push({ name: `${bp}entities/${cid}.json`, data: json(behaviorEntity(cid, c.kind, c.grid)) });
        const geo = geometry(cid, c.grid);
        files.push({ name: `${rp}entity/${cid}.entity.json`, data: json(clientEntity(cid)) }, { name: `${rp}models/entity/${cid}.geo.json`, data: json(geo.value) }, { name: `${rp}textures/entity/${cid}.png`, data: palettePng(geo.palette) });
        functionLines.push(`summon ${PACK_NAMESPACE}:${cid} ${JSON.stringify(c.label)} ~${Math.round(c.x ?? grid.width / 2)} ~${Math.round(c.y ?? 1)} ~${Math.round(c.z ?? grid.length / 2)}`);
    }
    const screens = options.screens ?? [], screenId = `${id}_control_screen`;
    if (screens.length) {
        files.push({ name: `${bp}entities/${screenId}.json`, data: json(screenBehavior(screenId)) }, { name: `${rp}entity/${screenId}.entity.json`, data: json(screenClient(screenId)) }, { name: `${rp}models/entity/control_screen.geo.json`, data: json(SCREEN_GEOMETRY) }, { name: `${rp}textures/entity/craftmatic_screen.png`, data: palettePng(['cyan']) });
        for (const s of screens)
            functionLines.push(`summon ${PACK_NAMESPACE}:${screenId} ${JSON.stringify(s.label)} ~${Math.round(s.x)} ~${Math.round(s.y)} ~${Math.round(s.z)}`);
    }
    if (unmapped.size) warnings.push(`${unmapped.size} block type${unmapped.size === 1 ? '' : 's'} had no Bedrock equivalent and ${unmapped.size === 1 ? 'was' : 'were'} omitted: ${[...unmapped].join(', ')}`);
    files.push({ name: `${bp}functions/${PACK_NAMESPACE}/${id}.mcfunction`, data: text(functionLines.join('\n')) }, { name: `${bp}scripts/main.js`, data: text('const SCREEN_TYPE = ' + JSON.stringify(PACK_NAMESPACE + ':' + screenId) + ';\n' + SCREEN_SCRIPT) }, { name: `${bp}README.txt`, data: text(`${label}\n\nImport this .mcaddon, activate both packs, rejoin the world, then run /function ${PACK_NAMESPACE}/${id}.\nCars: interact to ride and use normal movement controls. Planes: ride, then use movement plus camera pitch. Computer screens: interact for lights, doors, scanner vision, and named vehicle coordinates.\n`) });
    options.onProgress?.('packaging playable .mcaddon', 90);
    const bytes = await createZip(files, { alwaysDeflate: true });
    return { bytes, functionCommand: `/function ${PACK_NAMESPACE}/${id}`, tileCount: plan.length, components: [...components.map(c => ({ id: c.id, label: c.label, kind: c.kind, provenance: c.provenance })), ...screens.map(s => ({ id: s.id, label: s.label, kind: 'screen' as const, provenance: 'source-aligned interaction anchor' }))], warnings };
}
