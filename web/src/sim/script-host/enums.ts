/**
 * The Script API's enums as the device hands them to a script: each member's
 * REAL value from the generated catalog (`ApiType.values`, read from the
 * published typings) - a NUMERIC enum (`InputPermissionCategory.Camera` is 1)
 * carries numbers, a string enum its id strings (`EntityComponentTypes.Rideable`
 * is "minecraft:rideable") - frozen, as an enum exported by the native module is
 * read-only. A member the typings give no literal for stands for its own name.
 */

import type { ApiType } from './api-catalog.js';

/** A frozen enum object for a catalog enum type. */
export function enumObject(t: ApiType): Readonly<Record<string, string | number>> {
  return Object.freeze(Object.fromEntries(t.members.map(m => [m, t.values?.[m] ?? m])));
}
