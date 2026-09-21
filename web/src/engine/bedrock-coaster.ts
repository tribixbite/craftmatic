/** Scripted ride carts follow measured track paths, including vertical curves.
 * These are deliberately distinct from vanilla rails: no track is flattened,
 * and an open track shuttles rather than inventing a connection across a gap.
 */
import { buildCoasterFrames, buildCoasterPath, sampleCoasterPath, type CoasterPath, type CoasterVec3 } from './coaster-path.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import { withSizeGroups } from './bedrock-placement-pack.js';

declare const world: any;
declare const system: any;

export interface CoasterRoute {
  label: string;
  /** Model/grid coordinates in blocks, at the exported scale. */
  points: Vec3[];
  closed: boolean;
  /** Maximum verified sample spacing in blocks; not derived from a possibly broken route. */
  maxSegmentLength: number;
}

export interface CoasterRuntimeConfig {
  typeId: string;
  routes: Array<{ label: string; path: CoasterPath; up: CoasterVec3[] }>;
}

/** Validate routes before putting them in an executable add-on. */
export function coasterRuntimeConfig(typeId: string, routes: CoasterRoute[]): CoasterRuntimeConfig {
  if (routes.length > 16) throw new Error('At most 16 independent coaster routes are supported per pack.');
  return { typeId, routes: routes.map(route => {
    const path = buildCoasterPath(route.points, route.closed, route.maxSegmentLength);
    return { label: route.label, path, up: buildCoasterFrames(path) };
  }) };
}

/** A purpose-built ride vehicle, not invented replacement LEGO geometry.
 * The imported set and its display cars remain intact. */
export function coasterCartAssets(typeId: string, modelScale = 1) {
  if (!Number.isFinite(modelScale) || modelScale <= 0 || modelScale > 4) throw new Error('Coaster cart export scale must be in (0, 4].');
  const collision = { width: 1.375 * modelScale, height: 0.6 * modelScale };
  const rideable = { seat_count: 1, family_types: ['player'], interact_text: 'Ride coaster',
    crouching_skip_interact: true, seats: { position: [0, 0.35 * modelScale, 0], lock_rider_rotation: 181 } };
  const geometryId = `geometry.${typeId.replace(':', '.')}`;
  const animationId = `animation.${typeId.replace(':', '.')}.track_pitch`;
  return {
    behavior: withSizeGroups({ format_version: '1.26.30', 'minecraft:entity': {
      description: { identifier: typeId, is_spawnable: false, is_summonable: true,
        properties: {
          'craftmatic:track_pitch': { type: 'float', range: [-90, 90], default: 0, client_sync: true },
          'craftmatic:track_roll': { type: 'float', range: [-180, 180], default: 0, client_sync: true },
        } },
      components: {
        'minecraft:type_family': { family: ['craftmatic_coaster'] },
        'minecraft:persistent': {}, 'minecraft:nameable': {},
        'minecraft:health': { value: 20, max: 20 },
        'minecraft:damage_sensor': { triggers: [{ cause: 'all', deals_damage: 'no' }] },
        'minecraft:fire_immune': {},
        'minecraft:collision_box': collision,
        'minecraft:physics': { has_gravity: false, has_collision: false },
        'minecraft:rideable': rideable,
      },
    } }, collision, rideable),
    client: { format_version: '1.10.0', 'minecraft:client_entity': { description: {
      identifier: typeId, materials: { default: 'entity_alphatest' },
      textures: { default: 'textures/entity/craftmatic_coaster' }, geometry: { default: geometryId },
      animations: { track_pitch: animationId }, scripts: { animate: ['track_pitch'] },
      render_controllers: ['controller.render.default'],
    } } },
    geometry: { format_version: '1.12.0', 'minecraft:geometry': [{
      description: { identifier: geometryId, texture_width: 2, texture_height: 2,
        visible_bounds_width: 8 * modelScale, visible_bounds_height: 8 * modelScale, visible_bounds_offset: [0, 0, 0] },
      // Separate pitch/roll bones make composition explicit, independent of
      // the engine's Euler order. The entity itself only rotates in yaw.
      bones: [{ name: 'track_pitch', pivot: [0, 0, 0], cubes: [] as Array<{ origin: number[]; size: number[]; uv: number[] }> },
      { name: 'cart', parent: 'track_pitch', pivot: [0, 0, 0], cubes: [
        { origin: [-11, 0, -10], size: [22, 2, 20], uv: [0, 0] },
        { origin: [-11, 2, -10], size: [1, 4, 20], uv: [0, 0] },
        { origin: [10, 2, -10], size: [1, 4, 20], uv: [0, 0] },
        { origin: [-10, 2, -10], size: [20, 5, 1], uv: [0, 0] },
        { origin: [-10, 2, 9], size: [20, 3, 1], uv: [0, 0] },
        // Standard rails are 60 LDU apart: wheel centres ±9 entity units.
        // The running datum is 32 LDU above sleepers, rail tops 10 LDU:
        // wheels reach down 22 LDU = 6.6 entity units, avoiding a floating tub.
        ...[-11, 7].flatMap(x => [-8, 4].map(z => ({ origin: [x, -6.6, z], size: [4, 6.6, 4], uv: [0, 0] }))),
      ].map(cube => ({ ...cube, origin: cube.origin.map(v => v * modelScale), size: cube.size.map(v => v * modelScale) })) }],
    }] },
    animations: { format_version: '1.8.0', animations: { [animationId]: {
      loop: true, bones: {
        track_pitch: { rotation: ["query.property('craftmatic:track_pitch')", 0, 0] },
        cart: { rotation: [0, 0, "query.property('craftmatic:track_roll')"] },
      },
    } } },
  };
}

// Serialized with the pure sampler into the pack. No imports may be captured.
function coasterRuntime(config: CoasterRuntimeConfig, sample: typeof sampleCoasterPath) {
  const tracked = new Map<string, any>();
  let ticks = 0;
  const key = 'craftmatic:coaster_';
  const warn = (riders: any[], message: string) => {
    for (const rider of riders) try { rider.onScreenDisplay?.setActionBar(message); } catch {}
  };
  const tick = () => {
    ticks++;
    if (ticks === 1 || ticks % 20 === 0) {
      for (const name of ['overworld', 'nether', 'the_end']) {
        try {
          for (const entity of world.getDimension(name).getEntities({ type: config.typeId })) {
            if (!tracked.has(entity.id)) tracked.set(entity.id, { entity, wait: 40 });
          }
        } catch { /* A dimension may be unavailable during world startup. */ }
      }
    }
    for (const [id, state] of tracked) {
      const entity = state.entity;
      let riders: any[] = [];
      try {
        const rideable = entity.getComponent('minecraft:rideable');
        riders = rideable?.getRiders() ?? [];
        const routeIndex = entity.getDynamicProperty(key + 'route');
        const route = Number.isInteger(routeIndex) ? config.routes[routeIndex as number] : undefined;
        const origin = entity.getDynamicProperty(key + 'origin');
        const rotation = Number(entity.getDynamicProperty(key + 'rotation'));
        const scale = Number(entity.getDynamicProperty(key + 'scale'));
        if (!route || !origin || ![origin.x, origin.y, origin.z, rotation, scale].every(Number.isFinite) || scale <= 0 || scale > 4) {
          if (riders.length) { warn(riders, 'Coaster has no valid placed track. Re-place it with the Brick Wand.'); rideable?.ejectRiders(); }
          continue;
        }
        if (!riders.length) { state.wait = 40; continue; }
        if (state.wait > 0) { state.wait--; warn(riders, 'Coaster departing — sneak to dismount'); continue; }
        const stored = Number(entity.getDynamicProperty(key + 'distance') ?? 0);
        const distance = Number.isFinite(stored) ? Math.max(0, Math.min(route.path.length, stored)) : 0;
        const direction = entity.getDynamicProperty(key + 'direction') === -1 ? -1 : 1;
        // Fixed real-world speed, independent of wand size. Vertical ascents
        // use a slower lift speed; a bounded downhill boost is not a physics sim.
        const here = sample(route.path, distance);
        const slope = here.tangent[1] * direction;
        const speed = slope > 0.2 ? 1.5 : slope < -0.2 ? 6 : 4;
        let next = distance + direction * speed / (20 * scale);
        let nextDirection = direction;
        if (route.path.closed) next = ((next % route.path.length) + route.path.length) % route.path.length;
        else if (next > route.path.length || next < 0) {
          next = Math.max(0, Math.min(route.path.length, next));
          nextDirection = -direction;
          state.wait = 40;
        }
        const at = sample(route.path, next);
        const angle = rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
        const p = at.position;
        const position = { x: origin.x + (p[0] * c - p[2] * s) * scale,
          y: origin.y + p[1] * scale, z: origin.z + (p[0] * s + p[2] * c) * scale };
        // Never teleport into an unloaded region. Holding distance allows a
        // later tick to resume without skipping track or abandoning the rider.
        let loaded = false;
        try { loaded = !!entity.dimension.getBlock({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }); } catch {}
        if (!loaded) { warn(riders, 'Coaster paused: next track chunk is not loaded'); continue; }
        const tangent = at.tangent.map(value => value * direction);
        const horizontal = Math.hypot(tangent[0]!, tangent[2]!);
        const worldTx = tangent[0]! * c - tangent[2]! * s;
        const worldTz = tangent[0]! * s + tangent[2]! * c;
        const yaw = horizontal > 1e-6 ? Math.atan2(-worldTx, worldTz) * 180 / Math.PI : entity.getRotation().y;
        const pitch = -Math.atan2(tangent[1]!, horizontal) * 180 / Math.PI;
        const i = at.segmentIndex;
        const ratio = (at.distance - route.path.cumulative[i]) / (route.path.cumulative[i + 1] - route.path.cumulative[i]);
        const up0 = route.up[i], up1 = route.up[i + 1];
        const up = up0.map((value, axis) => value + (up1[axis] - value) * ratio);
        const ux = up[0] * c - up[2] * s, uy = up[1], uz = up[0] * s + up[2] * c;
        // Remove entity yaw then bone pitch from the transported track up.
        // The remaining angle is local roll; at a loop apex this turns the
        // cart upside down without attempting unsupported player-camera roll.
        const yawRad = yaw * Math.PI / 180, pitchRad = pitch * Math.PI / 180;
        const localX = ux * Math.cos(yawRad) + uz * Math.sin(yawRad);
        const yawZ = -ux * Math.sin(yawRad) + uz * Math.cos(yawRad);
        const localY = uy * Math.cos(pitchRad) + yawZ * Math.sin(pitchRad);
        const roll = Math.atan2(-localX, localY) * 180 / Math.PI;
        if (!entity.tryTeleport(position, { rotation: { x: 0, y: yaw }, keepVelocity: false, checkForBlocks: false })) {
          warn(riders, 'Coaster paused: movement could not complete'); continue;
        }
        entity.setDynamicProperty(key + 'distance', next);
        entity.setDynamicProperty(key + 'direction', nextDirection);
        entity.setProperty('craftmatic:track_pitch', pitch);
        entity.setProperty('craftmatic:track_roll', roll);
        const retained = new Set((rideable?.getRiders() ?? []).map((rider: any) => rider.id));
        if (riders.some(rider => !retained.has(rider.id))) {
          state.wait = 40;
          warn(riders, 'Coaster mount was interrupted. Reboard the cart to continue.');
          // Never force a rider back on: this may have been a deliberate dismount.
        }
        if (ticks % 20 === 0) warn(riders, `${route.label} — ${route.path.closed ? 'circuit' : 'open-track shuttle'} — sneak to dismount`);
      } catch {
        warn(riders, 'Coaster paused after a movement error; retrying safely');
        // Removed carts (Undo/re-place) must not survive as script-held state.
        tracked.delete(id);
      }
    }
  };
  system.runInterval(tick, 1);
}

/** Emit the same runtime exercised by the host tests. Riders remain upright;
 * pitch animates the cart only, not an unsupported upside-down player pose. */
export function coasterScript(config: CoasterRuntimeConfig): string {
  return `import { world, system } from '@minecraft/server';\nconst CONFIG = ${JSON.stringify(config)};\n(${coasterRuntime.toString()})(CONFIG, ${sampleCoasterPath.toString()});\n`;
}
