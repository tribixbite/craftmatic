/**
 * Where a built pack's moving actors REST (A-17): coaster cars where the runtime parks a newly placed train
 * (`coasterParkedCarPoses` over the pack's own `scripts/coaster.js` CONFIG) and a lift car at each stop of its ride
 * (`liftCarRestingPoses` over `scripts/rides.js` and the ride seats' paths). The export separates coplanar faces at
 * exactly these poses (playable-addon.ts), so the tools that measure or draw a pack (`_render_fault_audit.ts`,
 * `_pack_render.ts --parked`) read them the same way.
 */
import { readPackScriptConfig, type AddonPreviewModel } from '../web/src/ui/addon-preview-data.ts';
import { coasterParkedCarPoses, type CoasterRuntimeConfig } from '../web/src/engine/bedrock-coaster.ts';
import { coasterRestingPoses, firstRestingPoses, liftCarRestingPoses, type RestingPoses } from '../web/src/engine/cross-entity-coplanar.ts';
import type { RideRuntimeConfig } from '../web/src/engine/bedrock-rides.ts';

/** The resting-pose lookup of one pack (`.mcaddon` bytes) and its preview model. */
export async function packRestingPoses(bytes: Uint8Array, model: Pick<AddonPreviewModel, 'entities'>): Promise<RestingPoses> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const coaster = await readPackScriptConfig<CoasterRuntimeConfig>(buffer, 'coaster');
  const rides = await readPackScriptConfig<RideRuntimeConfig>(buffer, 'rides');
  return firstRestingPoses(
    coaster ? coasterRestingPoses(coasterParkedCarPoses(coaster)) : undefined,
    rides ? liftCarRestingPoses(rides.rides, new Map(model.entities.flatMap(e => e.typeId === rides.seatType && e.ride !== undefined && e.ridePath ? [[e.ride, e.ridePath] as const] : []))) : undefined);
}
