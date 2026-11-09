/**
 * Legality: a generated model may use vocabulary parts only. Every vocabulary
 * part is an official LDraw part under CC BY (asserted by the vocabulary's own
 * test); this re-checks what the plan names, so a hand-edited or regenerated
 * plan cannot smuggle in a Studio-only mesh, a `bl_` copy or a logo stud.
 */
import type { PlacedElement } from '../types.js';
import { PRODUCTION_PALETTE } from '../colour.js';
import { VOCABULARY_LOOKUP, type PartLookup } from './world.js';

export interface IllegalPart { part: string; reasons: string[] }

export interface LegalityResult {
  /** One entry per distinct illegal part, with every reason. */
  parts: IllegalPart[];
  /** Colour codes outside the production palette (informational; not in `illegalParts`). */
  colours: number[];
}

/** Reasons a part name is illegal on its own, before the vocabulary is asked. */
export function nameProblems(part: string): string[] {
  const out: string[] = [];
  if (/^bl_/i.test(part)) out.push('BrickLink copy (bl_)');
  if (/logo/i.test(part)) out.push('logo stud');
  if (/^(unofficial|studio)\b|[\\/]/i.test(part)) out.push('Studio or unofficial path');
  return out;
}

/** Check every element of a plan. `palette` defaults to the production palette. */
export function checkLegality(elements: readonly PlacedElement[], lookup: PartLookup = VOCABULARY_LOOKUP, palette: readonly number[] = PRODUCTION_PALETTE): LegalityResult {
  const problems = new Map<string, Set<string>>();
  const colours = new Set<number>();
  const paletteSet = new Set(palette);
  for (const e of elements) {
    if (!paletteSet.has(e.colour)) colours.add(e.colour);
    if (problems.has(e.part)) continue;
    const reasons = nameProblems(e.part);
    const found = lookup(e.part);
    if (!found) reasons.push('not in the vocabulary');
    else if (!/CC BY/.test(found.element.licence)) reasons.push('licence is not CC BY');
    if (reasons.length) problems.set(e.part, new Set(reasons));
  }
  return {
    parts: [...problems].map(([part, r]) => ({ part, reasons: [...r] })).sort((a, b) => (a.part < b.part ? -1 : 1)),
    colours: [...colours].sort((a, b) => a - b),
  };
}
