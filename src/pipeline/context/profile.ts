/**
 * Profile lookup for Stage 2 (classify + profile).
 *
 * Reads `profiles.json`, looks up a base row by `size`, applies the `svDifficulty`
 * modifier row, and returns an immutable `CaptureProfile`.
 *
 * Modifier operator semantics (per spec):
 *   • `scale` — numeric multiply: `field *= value`
 *   • `concat` — array append + dedup: `field = [...field, ...values]`
 *   • `set`    — override: `field = value`
 */

import type { BuildingSize, CaptureProfile, SvDifficulty } from './types.js';
import profiles from './profiles.json';

type ModifierOp =
  | { readonly op: 'scale'; readonly by: number }
  | { readonly op: 'concat'; readonly values: readonly number[] }
  | { readonly op: 'set'; readonly value: number | boolean };

type NestedModifier = Readonly<Record<string, ModifierOp>>;
type Modifier = Readonly<Record<string, NestedModifier>>;

function applyOp(current: unknown, op: ModifierOp): unknown {
  switch (op.op) {
    case 'scale':
      if (typeof current !== 'number') throw new Error(`scale op requires number, got ${typeof current}`);
      return current * op.by;
    case 'concat':
      if (!Array.isArray(current)) throw new Error('concat op requires array');
      // Array append + dedup, preserving order
      return Array.from(new Set([...(current as readonly number[]), ...op.values]));
    case 'set':
      return op.value;
  }
}

function applyModifier(base: CaptureProfile, modifier: Modifier): CaptureProfile {
  // Deep-clone to avoid mutating imported JSON
  const out: Record<string, Record<string, unknown>> = {
    tiles: { ...base.tiles },
    streetview: { ...base.streetview, angleVariants: [...base.streetview.angleVariants] },
    satellite: { ...base.satellite },
  };
  for (const [group, ops] of Object.entries(modifier)) {
    const groupObj = out[group];
    if (!groupObj) continue;
    for (const [field, op] of Object.entries(ops)) {
      groupObj[field] = applyOp(groupObj[field], op);
    }
  }
  return out as unknown as CaptureProfile;
}

export interface ProfileLookupInput {
  readonly size: BuildingSize;
  readonly svDifficulty: SvDifficulty;
}

export function lookupProfile(ctx: ProfileLookupInput): CaptureProfile {
  const base = (profiles.base as Record<string, CaptureProfile>)[ctx.size];
  if (!base) throw new Error(`No profile row for size '${ctx.size}'`);
  const modifier = (profiles.modifiers as Record<string, Modifier>)[ctx.svDifficulty] ?? {};
  return applyModifier(base, modifier);
}
