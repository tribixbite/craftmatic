/**
 * The craftmatic pieces an in-memory fixture pack (`sim/pack/fixture.ts`)
 * needs to stand in for a generated pack: the collider kit's block
 * definitions exactly as the exporter writes them, so a runtime under test
 * lays and reads the same collider forms (and the simulator reads their
 * boxes through the same block-JSON path, mirror quirk included) as in a
 * shipped `.mcaddon`.
 */

import { COLLIDER_KIT, colliderBlockDefinition } from '../../../engine/collider-form.js';
import type { FixtureFile } from '../../pack/fixture.js';

/** Every collider form's `blocks/collider_<v>.json`, as the exporter ships them. */
export function colliderKitFiles(): Record<string, FixtureFile> {
  const out: Record<string, FixtureFile> = {};
  for (let v = 0; v < COLLIDER_KIT.VARIANTS.length; v++) out[`blocks/collider_${v}.json`] = colliderBlockDefinition(v) as Record<string, unknown>;
  return out;
}
