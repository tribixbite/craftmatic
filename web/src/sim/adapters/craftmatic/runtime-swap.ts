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
 * (`ridesScript`), `scripts/vehicles.js` (`scriptedVehicleScript`). Every
 * other script runs as shipped. A pack whose CONFIG predates a field the
 * tree's runtime reads gets that runtime's own default for it - the swap is a
 * code change, never a data migration.
 */

import { behaviorPacks, packText, type Addon } from '../../pack/pack.js';
import { extractJsonAfter } from '../../pack/script-config.js';
import { figureLifeScript, type FigureLifeConfig } from '../../../engine/bedrock-figure-life.js';
import { ridesScript, type RideRuntimeConfig } from '../../../engine/bedrock-rides.js';
import { scriptedVehicleScript, type ScriptedVehicleConfig } from '../../../engine/bedrock-vehicle.js';

/** One swappable script: where its CONFIG sits in the shipped text and the tree's builder. */
interface Swap { path: string; read: (text: string) => unknown; build: (config: never) => string }

const SWAPS: readonly Swap[] = [
  { path: 'scripts/figures.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: FigureLifeConfig) => figureLifeScript(c) },
  { path: 'scripts/rides.js', read: t => extractJsonAfter(t, 'const CONFIG'), build: (c: RideRuntimeConfig) => ridesScript(c) },
  // vehicles.js passes its CONFIG inline as the runtime's first argument: `(function ...)({"types": ...}, ...)`.
  { path: 'scripts/vehicles.js', read: t => { const at = t.indexOf('({"types":'); return at < 0 ? undefined : extractJsonAfter(t.slice(at), '('); }, build: (c: ScriptedVehicleConfig) => scriptedVehicleScript(c) },
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
      pack.files.set(s.path, encoder.encode(s.build(config as never)));
      swapped.push(s.path);
    }
  }
  return swapped;
}
