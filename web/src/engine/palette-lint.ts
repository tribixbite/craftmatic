/**
 * Palette lint (S5) — "every block id we emit is a real Minecraft block".
 *
 * The failure this exists for: a typo in a colour→block table (or a new profile
 * naming a block that doesn't exist) produces a .schem that OUR importer happily
 * round-trips — palette strings are opaque to us — but that renders as a missing
 * / pink / invisible block in WorldEdit, Litematica or schemat.io. External
 * viewers were the only thing catching it (S1 was found that way).
 *
 * The registry is a small checked-in JSON of verified Java 1.20 block ids
 * (`mc-block-registry.json`): the 16-colour families expanded programmatically
 * plus an explicit list of solids/light sources. Adding a genuinely new block
 * means adding it there — deliberately, having checked the id.
 *
 * Block states may carry properties (`minecraft:oak_wall_sign[facing=north]`);
 * only the id before the `[` is validated.
 */

import REGISTRY from './mc-block-registry.json';

/** Every valid block id (no `minecraft:` prefix), expanded from the registry. */
export function knownBlockIds(): Set<string> {
  const ids = new Set<string>(REGISTRY.blocks);
  for (const family of REGISTRY.colorFamilies) {
    for (const color of REGISTRY.colors) ids.add(`${color}_${family}`);
  }
  return ids;
}

export interface PaletteLintIssue {
  entry: string;
  reason: 'missing-namespace' | 'bad-namespace' | 'unknown-block' | 'malformed';
}

export interface PaletteLintResult {
  ok: boolean;
  checked: number;
  issues: PaletteLintIssue[];
}

/**
 * Validate schematic palette entries (`minecraft:white_concrete`,
 * `minecraft:oak_wall_sign[facing=north]`, …).
 */
export function lintPalette(entries: Iterable<string>): PaletteLintResult {
  const known = knownBlockIds();
  const issues: PaletteLintIssue[] = [];
  let checked = 0;

  for (const entry of entries) {
    checked++;
    if (typeof entry !== 'string' || entry.length === 0) {
      issues.push({ entry: String(entry), reason: 'malformed' });
      continue;
    }
    const colon = entry.indexOf(':');
    if (colon < 0) { issues.push({ entry, reason: 'missing-namespace' }); continue; }
    if (entry.slice(0, colon) !== 'minecraft') { issues.push({ entry, reason: 'bad-namespace' }); continue; }
    const rest = entry.slice(colon + 1);
    const bracket = rest.indexOf('[');
    const id = bracket < 0 ? rest : rest.slice(0, bracket);
    if (!/^[a-z0-9_]+$/.test(id)) { issues.push({ entry, reason: 'malformed' }); continue; }
    if (!known.has(id)) issues.push({ entry, reason: 'unknown-block' });
  }

  return { ok: issues.length === 0, checked, issues };
}
