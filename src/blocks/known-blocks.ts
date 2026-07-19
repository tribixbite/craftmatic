/**
 * Palette-validity predicate — does the toolchain actually KNOW this block?
 *
 * A palette-generation bug can emit a state that is not a real Minecraft
 * block (e.g. `minecraft:deepslate_tile` — the real id is `deepslate_tiles`).
 * Nothing crashed: the schem writes fine, the renderer falls back to a
 * hash-derived colour, and in-game it draws the missing-texture magenta
 * checker. On 2026-07-18 that invalid id was the single most common block in
 * two golden builds (flatiron 22.9%, guggenheim 36.7%) while
 * `defect_score=10.0` — this module is the deterministic gate that makes the
 * failure class impossible to ship silently.
 *
 * "Known" = the base id appears in the texture-atlas name list OR the
 * renderer's colour map. That is intentionally the union of everything the
 * toolchain can draw faithfully: a state outside it is either an invalid id
 * or a block every renderer in the repo would fall back on. Validated against
 * all 5 golden palettes: flags exactly `deepslate_tile`, passes every real
 * block (brown_concrete, clay, smooth_stone_slab[type=double], …).
 *
 * Pure data module — browser-safe (texture names come from the
 * `texture-names.ts` leaf, not the node-only atlas).
 */

import { COMMON_TEXTURES } from '../render/texture-names.js';
import { knownColorBlockIds } from './colors.js';
import { getBlockName, isAir } from './registry.js';

let knownBases: Set<string> | null = null;

/** Lazy union of atlas texture names + colour-map ids (without namespace). */
function bases(): Set<string> {
  if (knownBases === null) {
    knownBases = new Set(COMMON_TEXTURES);
    for (const id of knownColorBlockIds()) {
      knownBases.add(id.replace(/^minecraft:/, ''));
    }
  }
  return knownBases;
}

/** True when the state's base id is one the toolchain can draw faithfully. */
export function isKnownBlockState(state: string): boolean {
  return isAir(state) || bases().has(getBlockName(state));
}

/**
 * Filter an iterable of block states (e.g. `grid.palette.keys()`) down to the
 * unknown ones, deduplicated, insertion-ordered. Empty array = palette clean.
 */
export function findUnknownStates(states: Iterable<string>): string[] {
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const s of states) {
    if (seen.has(s)) continue;
    seen.add(s);
    if (!isKnownBlockState(s)) unknown.push(s);
  }
  return unknown;
}
