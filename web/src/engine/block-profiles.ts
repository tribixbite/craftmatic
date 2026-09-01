/**
 * Block-mapping profiles for the Minecraft export.
 *
 * A profile is the seam between "brick colour id" and "Minecraft block": one
 * mapping-table module per profile. There is exactly ONE profile today (the
 * built-in concrete/wool tables in `ldraw-colors.ts` / `studio-colors.ts`) —
 * this file exists so a second one (texture-pack-friendly, terracotta-only,
 * survival-obtainable…) is a data addition, not a refactor. Don't add
 * placeholder profiles that just re-point at the default; an entry here must
 * be a real, distinct mapping table.
 *
 * `colorFn` returns `undefined` for a colour space when the engine's built-in
 * default is wanted: the voxelizers treat a null colorFn as "default table" and
 * use it to decide whether unmapped colour ids are worth reporting
 * (`isDefaultFn`), so passing `ldrawColorToBlock` explicitly would NOT be a
 * no-op. Keep `undefined` meaning "engine default".
 */

import { studioColorToBlock } from './studio-colors.js';

export type BrickColorSpace = 'ldraw' | 'bl';

export interface BlockMappingProfile {
  id: string;
  label: string;
  description: string;
  /** Resolver for a colour space; `undefined` = the engine's built-in LDraw table. */
  colorFn(space: BrickColorSpace): ((colorId: number) => string) | undefined;
  /** Block used by the interior light-fill option. */
  lightBlock: string;
}

export const DEFAULT_PROFILE_ID = 'default';

export const BLOCK_PROFILES: readonly BlockMappingProfile[] = [
  {
    id: DEFAULT_PROFILE_ID,
    label: 'Default — concrete & glass',
    description:
      'LEGO colours → dyed concrete, with stained glass for transparent bricks and metal blocks for chrome/gold.',
    colorFn: (space) => (space === 'bl' ? studioColorToBlock : undefined),
    lightBlock: 'minecraft:glowstone',
  },
];

/** Look up a profile by id, falling back to the default for unknown ids. */
export function getBlockProfile(id: string | undefined): BlockMappingProfile {
  return BLOCK_PROFILES.find(p => p.id === id) ?? BLOCK_PROFILES[0]!;
}
