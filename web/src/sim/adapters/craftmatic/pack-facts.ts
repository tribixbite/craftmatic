/**
 * What a CRAFTMATIC pack says about itself, read from its scripts' `CONFIG`
 * literals: the placement (dims, actors, sizes, the wand's item), the moving
 * parts (doorways with their leaves), the rides, the flyer mounts, the
 * scripted vehicles. The adapter builds scenarios from these facts; the
 * engine itself never reads them.
 */

import type { Addon, Pack } from '../../pack/pack.js';
import { behaviorPacks, packText } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import type { PlacementActor, PlacementColliders } from '../../../engine/bedrock-placement-pack.js';
import type { InteractiveRuntimeConfig } from '../../../engine/bedrock-interactives.js';
import { rotatePlacementPoint, type PlacementRotation } from '../../../engine/bedrock-placement-pack.js';
import type { Vec3 } from '../../core/vec.js';

/** The placement runtime's CONFIG, the fields scenarios use. */
export interface PlacementFacts {
  id: string;
  label: string;
  itemId: string;
  width: number; height: number; length: number;
  actors: PlacementActor[];
  sizes: number[];
  /** Whether the pack ships a collider grid (blocks can resize). */
  resizable: boolean;
  /** The shipped collider grid (run-length cells and tread plans), when there is one. */
  colliders: PlacementColliders | null;
}

/** A ride as rides.js knows it. */
export interface RideFacts { index: number; kind: string; carType?: string }

export interface CraftmaticPack {
  pack: Pack;
  placement: PlacementFacts;
  interactives: InteractiveRuntimeConfig | null;
  rides: { seatType: string; rides: RideFacts[] } | null;
  /** Summonable flyer mounts: the cloud type and the types a tap on which summons it. */
  flyers: Array<{ cloudType: string; summonTypes: string[] }>;
  /** Vehicle types (family `craftmatic_vehicle`: scripted cars, boats, planes, and the native rotorcraft). */
  vehicleTypes: string[];
  /** Entity types that are native-controlled mounts (a rotorcraft, a flyer's cloud). */
  nativeMountTypes: string[];
  /** The scripts the pack ships (`scripts/*.js`). */
  scripts: string[];
}

const config = (pack: Pack, path: string): Record<string, unknown> | undefined => {
  const t = packText(pack, path);
  return t ? extractJsonAfter(t, 'const CONFIG') as Record<string, unknown> | undefined : undefined;
};

/** Read a craftmatic add-on's facts; undefined when it has no placement script (not a craftmatic pack). */
export function readCraftmaticPack(addon: Addon): CraftmaticPack | undefined {
  for (const pack of behaviorPacks(addon)) {
    const placement = config(pack, 'scripts/placement.js');
    if (!placement) continue;
    const ix = config(pack, 'scripts/interactives.js') as InteractiveRuntimeConfig | undefined;
    const rides = config(pack, 'scripts/rides.js') as { seatType?: string; rides?: Array<{ kind?: string; carType?: string }> } | undefined;
    const flyer = config(pack, 'scripts/flyer.js') as { mounts?: Array<{ cloudType?: string; summonTypes?: string[]; tapTypes?: string[] }> } | undefined;
    const nativeMountTypes: string[] = [], vehicleTypes: string[] = [];
    for (const [path, data] of pack.files) {
      if (!path.startsWith('entities/')) continue;
      const text = new TextDecoder().decode(data);
      const id = /"identifier"\s*:\s*"([^"]+)"/.exec(text)?.[1];
      if (!id) continue;
      // A scripted vehicle carries the family `craftmatic_vehicle`; a native mount drives by the hover controller at a non-zero flying speed.
      if (text.includes('"craftmatic_vehicle"')) vehicleTypes.push(id);
      else if (text.includes('minecraft:free_camera_controlled')) nativeMountTypes.push(id);
    }
    return {
      pack,
      placement: {
        id: String(placement['id'] ?? ''), label: String(placement['label'] ?? ''), itemId: String(placement['itemId'] ?? ''),
        width: Number(placement['width'] ?? 1), height: Number(placement['height'] ?? 1), length: Number(placement['length'] ?? 1),
        actors: (placement['actors'] as PlacementActor[] | undefined) ?? [],
        sizes: (placement['sizes'] as number[] | undefined) ?? [100],
        resizable: !!placement['colliders'] || !((placement['tiles'] as unknown[] | undefined)?.length),
        colliders: (placement['colliders'] as PlacementColliders | undefined) ?? null,
      },
      interactives: ix && Array.isArray(ix.items) ? ix : null,
      rides: rides?.seatType ? { seatType: rides.seatType, rides: (rides.rides ?? []).map((r, index) => ({ index, kind: String(r.kind ?? '?'), ...(r.carType ? { carType: r.carType } : {}) })) } : null,
      flyers: (flyer?.mounts ?? []).map(m => ({ cloudType: String(m.cloudType ?? ''), summonTypes: m.summonTypes ?? m.tapTypes ?? [] })),
      vehicleTypes,
      nativeMountTypes,
      scripts: [...pack.files.keys()].filter(p => /^scripts\/[^/]+\.js$/.test(p)),
    };
  }
  return undefined;
}

/** A placement as the wand made it: where, how turned, how big. */
export interface Placed {
  anchor: Vec3;
  rotation: PlacementRotation;
  sizePct: number;
  /** The world box it covers (inclusive blocks). */
  from: Vec3; to: Vec3;
}

/** A model point (blocks at 100 % from the model's corner) where the wand put it: the runtime's `worldPoint`. */
export function modelToWorld(facts: PlacementFacts, placed: Placed, v: Vec3): Vec3 {
  const q = rotatePlacementPoint(v, facts.width, facts.length, placed.rotation);
  const f = placed.sizePct / 100;
  return { x: placed.anchor.x + q.x * f, y: placed.anchor.y + q.y * f, z: placed.anchor.z + q.z * f };
}

/** A model-frame direction turned like the placement (no translation). */
export function modelDirToWorld(facts: PlacementFacts, placed: Placed, d: Vec3): Vec3 {
  const o = rotatePlacementPoint({ x: 0, y: 0, z: 0 }, facts.width, facts.length, placed.rotation);
  const q = rotatePlacementPoint(d, facts.width, facts.length, placed.rotation);
  return { x: q.x - o.x, y: q.y - o.y, z: q.z - o.z };
}
