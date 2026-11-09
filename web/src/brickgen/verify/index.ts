/**
 * The lattice verifier (X-09, BIZ-08): the gate every generated plan passes
 * before it is written. It reads a `BrickPlan` on the stud lattice and reports
 * connectivity, stability, overlaps, legality and a cuboid budget as a
 * `VerifyReport` (the contract in `types.ts`); `verifyPlanDetailed` also returns
 * the offending elements so a repair pass can act on them.
 *
 * Parts outside the vocabulary have no known geometry: they are reported in
 * `illegalParts` and left out of the lattice checks (`parts` still counts them).
 */
import type { BrickPlan, PlacedElement, VerifyReport } from '../types.js';
import { estimateBudget, type BudgetEstimate, type BudgetOptions } from './budget.js';
import { connectivity, type Connectivity } from './connect.js';
import { checkLegality, type LegalityResult } from './legality.js';
import { findOverlaps, type OverlapPair } from './overlap.js';
import { stability, type StabilityOptions, type StabilityResult } from './stability.js';
import { placeAll, VOCABULARY_LOOKUP, type PartLookup, type WorldElement } from './world.js';

export { connectivity } from './connect.js';
export { estimateBudget } from './budget.js';
export { checkLegality } from './legality.js';
export { findOverlaps } from './overlap.js';
export { DEFAULT_CANTILEVER_LIMITS, stability } from './stability.js';
export { placeAll, placeElement, turnedCell, VOCABULARY_LOOKUP } from './world.js';
export type { PartLookup, VerifyPart, WorldElement } from './world.js';

export interface VerifyOptions extends StabilityOptions {
  /** Part resolver; defaults to the brick vocabulary. Tests and corpus imports inject their own. */
  lookup?: PartLookup;
  budget?: BudgetOptions;
}

export interface VerifyDetail {
  world: WorldElement[];
  unknown: PlacedElement[];
  connectivity: Connectivity;
  stability: StabilityResult;
  overlaps: OverlapPair[];
  legality: LegalityResult;
  budget: BudgetEstimate;
}

/** Verify a plan and return the report together with the evidence behind it. */
export function verifyPlanDetailed(plan: BrickPlan, options: VerifyOptions = {}): { report: VerifyReport; detail: VerifyDetail } {
  const lookup = options.lookup ?? VOCABULARY_LOOKUP;
  const { world, unknown } = placeAll(plan.elements, lookup);
  const conn = connectivity(world);
  const stab = stability(world, conn, options);
  const overlaps = findOverlaps(world);
  const legality = checkLegality(plan.elements, lookup);
  const budget = estimateBudget(world, options.budget);

  const worstByGroup = new Map<string, number>();
  for (const c of stab.cantilevers) worstByGroup.set(c.group, Math.max(worstByGroup.get(c.group) ?? 0, c.studs));
  const report: VerifyReport = {
    parts: plan.elements.length,
    components: conn.sizes.length,
    largestPct: world.length ? Math.round((10000 * conn.sizes[0]!) / world.length) / 100 : 0,
    unsupported: stab.unsupported.length,
    cantileverViolations: [...worstByGroup].map(([group, studs]) => ({ group, studs })).sort((a, b) => (a.group < b.group ? -1 : 1)),
    overlaps: overlaps.length,
    illegalParts: legality.parts.map(p => p.part),
    budget: { cuboidsEstimate: budget.cuboidsEstimate, parts: plan.elements.length },
  };
  return { report, detail: { world, unknown, connectivity: conn, stability: stab, overlaps, legality, budget } };
}

/** Verify a plan; the `VerifyReport` only. */
export function verifyPlan(plan: BrickPlan, options: VerifyOptions = {}): VerifyReport {
  return verifyPlanDetailed(plan, options).report;
}

/** True when a report meets every target: one component, nothing unsupported, no violations, overlaps or illegal parts. */
export function isClean(r: VerifyReport): boolean {
  return r.components <= 1 && r.unsupported === 0 && r.cantileverViolations.length === 0 && r.overlaps === 0 && r.illegalParts.length === 0;
}
