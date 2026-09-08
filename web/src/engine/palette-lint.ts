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
 * Block states carry properties (`minecraft:sandstone_slab[type=bottom]`). Since
 * the block-shape passes started emitting them (2026-09-08) the states are
 * validated too, not just the id: a state string is where a plausible-looking
 * typo hides best — `[type=lower]` or `[facing=up]` are accepted by our own
 * encoder and importer and only fail in Minecraft. Ids whose suffix has a schema
 * in the registry (`_slab`, `_stairs`) get their keys AND values checked; every
 * other id is checked for syntax only (`k=v`, no duplicate keys), because the
 * registry does not carry a schema for every block in the game.
 */

import REGISTRY from './mc-block-registry.json';

/** Every valid block id (no `minecraft:` prefix), expanded from the registry. */
export function knownBlockIds(): Set<string> {
  const ids = new Set<string>(REGISTRY.blocks);
  for (const family of REGISTRY.colorFamilies) {
    for (const color of REGISTRY.colors) ids.add(`${color}_${family}`);
  }
  for (const id of REGISTRY.slabs) ids.add(id);
  for (const id of REGISTRY.stairs) ids.add(id);
  return ids;
}

/** Suffix → allowed `{property: values}`, longest suffix wins. */
const STATE_SCHEMAS: ReadonlyArray<readonly [string, Record<string, readonly string[]>]> =
  Object.entries(REGISTRY.stateSchemas as Record<string, Record<string, string[]>>)
    .sort((a, b) => b[0].length - a[0].length);

/** The property schema for a block id, or null when none is known. */
export function stateSchemaFor(id: string): Record<string, readonly string[]> | null {
  for (const [suffix, schema] of STATE_SCHEMAS) if (id.endsWith(suffix)) return schema;
  return null;
}

export interface PaletteLintIssue {
  entry: string;
  reason:
    | 'missing-namespace' | 'bad-namespace' | 'unknown-block' | 'malformed'
    | 'malformed-state' | 'duplicate-state' | 'unknown-state-key' | 'bad-state-value';
  /** The offending `k=v` pair, for the state reasons. */
  detail?: string;
}

export interface PaletteLintResult {
  ok: boolean;
  checked: number;
  issues: PaletteLintIssue[];
}

/**
 * Validate schematic palette entries (`minecraft:white_concrete`,
 * `minecraft:sandstone_slab[type=bottom]`, …).
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
    if (!known.has(id)) { issues.push({ entry, reason: 'unknown-block' }); continue; }
    if (bracket < 0) continue;
    issues.push(...lintStates(entry, id, rest.slice(bracket)));
  }

  return { ok: issues.length === 0, checked, issues };
}

/** Validate the `[k=v,…]` tail of one palette entry. */
function lintStates(entry: string, id: string, tail: string): PaletteLintIssue[] {
  const out: PaletteLintIssue[] = [];
  if (!tail.startsWith('[') || !tail.endsWith(']') || tail.length < 4) {
    return [{ entry, reason: 'malformed-state', detail: tail }];
  }
  const schema = stateSchemaFor(id);
  const seen = new Set<string>();
  for (const pair of tail.slice(1, -1).split(',')) {
    const eq = pair.indexOf('=');
    // Vanilla property names are lower_snake; values are lower_snake, an
    // integer (`layers=3`) or a boolean.
    if (eq <= 0 || !/^[a-z_]+$/.test(pair.slice(0, eq)) || !/^[a-z0-9_]+$/.test(pair.slice(eq + 1))) {
      out.push({ entry, reason: 'malformed-state', detail: pair });
      continue;
    }
    const key = pair.slice(0, eq), value = pair.slice(eq + 1);
    if (seen.has(key)) { out.push({ entry, reason: 'duplicate-state', detail: pair }); continue; }
    seen.add(key);
    if (!schema) continue;
    const allowed = schema[key];
    if (!allowed) { out.push({ entry, reason: 'unknown-state-key', detail: pair }); continue; }
    if (!allowed.includes(value)) out.push({ entry, reason: 'bad-state-value', detail: pair });
  }
  return out;
}
