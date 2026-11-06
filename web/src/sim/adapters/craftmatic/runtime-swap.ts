/**
 * Re-run a BUILT pack with the current tree's runtimes: each generated pack
 * script whose builder takes only its CONFIG is regenerated from the CONFIG
 * the pack ships, so the world (colliders, placement, entities) is the pack's
 * exactly and only the runtime CODE is this tree's. Used to measure a runtime
 * fix on the packs a device round ran, without re-exporting them (an export
 * reads the part library and changes the world too): `bun scripts/sim.ts
 * <packs> --runtime=tree`, `scripts/_seat_egress_sweep.ts --runtime=tree`.
 *
 * Swapped: `scripts/figures.js` (`figureLifeScript`), `scripts/rides.js`
 * (`ridesScript`), `scripts/vehicles.js` (`scriptedVehicleScript`),
 * `scripts/interactives.js` (`interactivesScript`, since 2026-10-07: the
 * doors' step-out fix measured on round 30k's packs), `scripts/vehicle-camera.js`
 * (`vehicleCameraScript`, since 2026-10-15: the 25 % chase framing),
 * `scripts/coaster.js` (`coasterScript`, since 2026-11-06: the rider camera,
 * COAST-06; its `world` still taken from the pack's roster when the pack's
 * was). `CRAFTMATIC_SIM_COASTER_CAMERA` (a JSON object) is merged over the
 * coaster CONFIG's `camera` for an experiment, and noted on stderr. Every
 * other script runs as shipped. A pack whose CONFIG predates a field the
 * tree's runtime reads gets that runtime's own default for it - the swap is a
 * code change, never a data migration.
 */

import { behaviorPacks, packText, type Addon } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import { figureLifeScript, type FigureLifeConfig } from '../../../engine/bedrock-figure-life.js';
import { ridesScript, type RideRuntimeConfig } from '../../../engine/bedrock-rides.js';
import { interactivesScript, type InteractiveRuntimeConfig } from '../../../engine/bedrock-interactives.js';
import { BOAT, CAR, FLIGHT, FOOTPRINT, HEADLIGHTS, HOVER, MOVE, scriptedVehicleScript, type ScriptedVehicleConfig } from '../../../engine/bedrock-vehicle.js';
import { vehicleCameraScript, type VehicleCameraRuntimeConfig } from '../../../engine/playable-addon.js';
import { FREE_LOOK } from '../../../engine/vehicle-free-look.js';
import { coasterScript, type CoasterRuntimeConfig } from '../../../engine/bedrock-coaster.js';
import { rosterScriptSource } from '../../../engine/player-roster.js';

/** One swappable script: where its CONFIG sits in the shipped text and the tree's builder. */
interface Swap { path: string; read: (text: string) => unknown; build: (config: never, shipped: string) => string }

/**
 * A vehicle CONFIG's constant sections topped up with this tree's constants for every key the pack
 * predates (the pack's own values stay). The runtime reads its constants from the CONFIG, so a key
 * it did not ship is `undefined` there: `MOVE.NARROW_CELLS` was, and `seen.size > undefined` never
 * held, so the swapped X-wing still deflected along the oblique hill the harness rose at (2026-10-07).
 */
function vehicleConfigWithTreeDefaults(c: ScriptedVehicleConfig): ScriptedVehicleConfig {
  return {
    ...c,
    flight: { ...FLIGHT, ...c.flight }, boat: { ...BOAT, ...c.boat }, car: { ...CAR, ...c.car }, hover: { ...HOVER, ...c.hover },
    footprint: { ...FOOTPRINT, ...c.footprint }, move: { ...MOVE, ...c.move }, headlights: { ...HEADLIGHTS, ...c.headlights },
  };
}

/**
 * The coaster runtime rebuilt from its CONFIG, with the experiment's camera override when one is set, and `world`
 * from `./roster.js` when the shipped script took it from there (the pack ships the roster beside it).
 */
function coasterFromConfig(c: CoasterRuntimeConfig, shipped: string): string {
  const raw = typeof process !== 'undefined' ? process.env['CRAFTMATIC_SIM_COASTER_CAMERA'] : undefined;
  let config = c;
  if (raw) {
    const override = JSON.parse(raw) as Partial<NonNullable<CoasterRuntimeConfig['camera']>>;
    config = { ...c, camera: { ...(c.camera ?? {}), ...override } as CoasterRuntimeConfig['camera'] };
    console.error(`runtime-swap: coaster camera override ${JSON.stringify(override)}`);
  }
  const source = coasterScript(config);
  return shipped.includes(`from './roster.js'`) ? rosterScriptSource(source) : source;
}

const SWAPS: readonly Swap[] = [
  { path: 'scripts/figures.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: FigureLifeConfig) => figureLifeScript(c) },
  { path: 'scripts/rides.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: RideRuntimeConfig) => ridesScript(c) },
  { path: 'scripts/interactives.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: InteractiveRuntimeConfig) => interactivesScript(c) },
  // vehicle-camera.js passes its CONFIG inline too: `(function ...)({"vehicles": ...}, ...)`; its free-look constants topped up.
  { path: 'scripts/vehicle-camera.js', read: t => { const at = t.indexOf('({"vehicles":'); return at < 0 ? undefined : extractJsonAfter(t.slice(at), '('); }, build: (c: VehicleCameraRuntimeConfig) => vehicleCameraScript({ ...c, freeLook: { ...FREE_LOOK, ...c.freeLook } }) },
  // vehicles.js passes its CONFIG inline as the runtime's first argument: `(function ...)({"types": ...}, ...)`.
  { path: 'scripts/coaster.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: CoasterRuntimeConfig, shipped: string) => coasterFromConfig(c, shipped) },
  { path: 'scripts/vehicles.js', read: t => { const at = t.indexOf('({"types":'); return at < 0 ? undefined : extractJsonAfter(t.slice(at), '('); }, build: (c: ScriptedVehicleConfig) => scriptedVehicleScript(vehicleConfigWithTreeDefaults(c)) },
];

const encoder = new TextEncoder();

/** Replace the add-on's swappable scripts with this tree's runtimes (in place); returns the paths swapped. */
export function swapTreeRuntimes(addon: Addon): string[] {
  const swapped: string[] = [];
  for (const pack of behaviorPacks(addon)) {
    for (const s of SWAPS) {
      const text = packText(pack, s.path);
      if (!text) continue;
      const config = s.read(text);
      if (!config || typeof config !== 'object') throw new Error(`${addon.source}: ${s.path} has no readable CONFIG to rebuild from`);
      pack.files.set(s.path, encoder.encode(s.build(config as never, text)));
      swapped.push(s.path);
    }
  }
  return swapped;
}
