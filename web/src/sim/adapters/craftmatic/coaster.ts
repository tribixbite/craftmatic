/**
 * A coaster runtime (`scripts/coaster.js`, `coasterScript` in
 * bedrock-coaster.ts) as the simulator loads it WITHOUT a whole pack: the
 * entity types its CONFIG names, built from the exporter's own cart
 * definition, and the entities the Brick Wand would place for it. The coaster
 * tests (`test/bedrock-coaster.test.ts`) and the coaster probes
 * (`scripts/_coaster_replay.ts`, `_coaster_cam_probe.ts`, `_coaster_pace_scan.ts`)
 * build their worlds from these, so the runtime meets the property
 * declarations, family, seat and gravity the pack ships.
 */

import { COASTER_FAMILY, coasterCartAssets, type CoasterRuntimeConfig } from '../../../engine/bedrock-coaster.js';

/** Where the tests and probes pin a placement (the replay host's origin; every expected point is measured from it). */
export const COASTER_TEST_ORIGIN = { x: 100, y: 64, z: 200 } as const;

/**
 * The behaviour document of every entity type a runtime config names. A car
 * is the pack's cart (`coasterCartAssets`: the coaster family, the track and
 * body-offset FLOAT properties, the rideable seat, no gravity or collision)
 * with its measured seat and, when it carries posed riders, the
 * `craftmatic:rider` (int 0..riders) and `craftmatic:occupied` (bool)
 * properties the exporter declares for it (`carBehavior`). A platform or
 * counterweight is a family member the runtime only teleports.
 */
export function coasterEntityTypes(config: Pick<CoasterRuntimeConfig, 'types'>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [typeId, type] of Object.entries(config.types)) {
    if (type.role !== 'car') {
      out[typeId] = { format_version: '1.26.30', 'minecraft:entity': {
        description: { identifier: typeId, is_spawnable: false, is_summonable: true },
        components: { 'minecraft:type_family': { family: [COASTER_FAMILY] }, 'minecraft:physics': { has_gravity: false, has_collision: false }, 'minecraft:collision_box': { width: 1, height: 1 } },
      } };
      continue;
    }
    // A fresh document per call (its float literals are the exporter's own objects), adjusted in place.
    const doc = coasterCartAssets(typeId).behavior as { 'minecraft:entity': { description: { properties: Record<string, unknown> }; components: Record<string, { seats?: { position: number[] } }> } };
    const entity = doc['minecraft:entity'];
    if (type.riders) Object.assign(entity.description.properties, { 'craftmatic:rider': { type: 'int', range: [0, type.riders], default: 0, client_sync: true }, 'craftmatic:occupied': { type: 'bool', default: false, client_sync: true } });
    const seats = entity.components['minecraft:rideable']?.seats;
    if (type.seat && seats) seats.position = [...type.seat];
    out[typeId] = doc as unknown as Record<string, unknown>;
  }
  return out;
}

/** One entity the Brick Wand places for a coaster: its id in a trace, its type and its placement record. */
export interface CoasterPlacementEntity { id: string; typeId: string; dynamic: Record<string, unknown> }

/**
 * The entities one placement of every route carries, as the wand records them:
 * one per car slot (`r<route>c<slot>`, with its slot index), and a lift
 * route's platform and counterweight (`r<route>platform`, `r<route>cw`), each
 * with the placement frame (origin, yaw 0, `scale`, its route).
 */
export function coasterPlacementEntities(config: Pick<CoasterRuntimeConfig, 'typeId' | 'routes'>, scale = 1, origin: { x: number; y: number; z: number } = COASTER_TEST_ORIGIN): CoasterPlacementEntity[] {
  const out: CoasterPlacementEntity[] = [];
  config.routes.forEach((route, r) => {
    const base = { 'craftmatic:coaster_origin': { ...origin }, 'craftmatic:coaster_rotation': 0, 'craftmatic:coaster_scale': scale, 'craftmatic:coaster_route': r };
    const cars = route.cars as { slots?: Array<{ type: string }>; count?: number; trains?: number } | undefined;
    const slots = cars?.slots ?? Array.from({ length: (cars?.count ?? 1) * (cars?.trains ?? 1) }, () => ({ type: config.typeId }));
    slots.forEach((slot, k) => out.push({ id: `r${r}c${k}`, typeId: slot.type, dynamic: { ...base, 'craftmatic:coaster_car': k } }));
    if (route.lift) {
      out.push({ id: `r${r}platform`, typeId: route.lift.type, dynamic: { ...base } });
      if (route.lift.counterweightType) out.push({ id: `r${r}cw`, typeId: route.lift.counterweightType, dynamic: { ...base } });
    }
  });
  return out;
}

/** The `CONFIG` a shipped `coaster.js` carries (its one `const CONFIG = {...};` line). */
export function coasterScriptConfig(script: string): CoasterRuntimeConfig {
  const m = /^const CONFIG = (\{.*\});$/m.exec(script);
  if (!m) throw new Error('coaster.js: no `const CONFIG = {...};` line');
  return JSON.parse(m[1]!) as CoasterRuntimeConfig;
}
