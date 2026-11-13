/**
 * The wand's size suggestion (LSCALE, BIZ-05 / BIZ-10): which size to place a landmark at, from the detail each level
 * adds, what a pack of that level costs a phone, and the room the player has. Pure data in, player-facing text out;
 * the wand shows `text` before placement and the runtime re-asks the pin's clear space (`availableBlocks`).
 *
 * Today's wand already names a size, but only a WALK-THROUGH one (`recommendAccessScale`, `PlacementAccess`): the step
 * at which a doorway is player-sized, labelled "(recommended)". It says nothing about detail, budget or room, so a
 * landmark with no doorway shows no suggestion at all. This one is about the design.
 */
import { DETAIL_LEVELS, sizeLadder, type DetailLevel, type SizeRung } from './levels.js';

/** A building's real extent in metres. */
export interface ExtentM { x: number; y: number; z: number }

/** What one level costs: cuboids the pack of that level ships resident on the phone (measured, `budget.ts` of M06). */
export interface LevelCost { studsPerMetre: number; residentCuboids: number }

export interface SuggestInput {
  extent: ExtentM;
  /** Measured cost per level; a level with no row is not offered. */
  costs: readonly LevelCost[];
  /** Resident cuboids one pack may ship (`BUDGET_TIERS.standard.maxResidentCuboids`: 60,000). */
  maxResidentCuboids: number;
  /** Blocks of clear space on the longest side, when known (the pin's preflight); absent = not limited. */
  availableBlocks?: number;
  /** Wand steps; default the wand's. */
  steps?: readonly number[];
}

/** One wand step with what the suggestion knows about it. */
export interface SuggestedRung extends SizeRung {
  /** Blocks the building spans at this step. */
  blocks: { x: number; y: number; z: number };
  /** The level's pack fits the phone's budget. */
  withinBudget: boolean;
  /** The longest side fits the clear space (always true when it is unknown). */
  fitsSpace: boolean;
}

export interface SizeSuggestion {
  /** The suggested wand step, in percent. */
  pct: number;
  level: DetailLevel;
  rungs: SuggestedRung[];
  /** Player-facing sentences (X-05 lint clean: no percent sign, no marks, no set numbers). */
  text: string;
  /** Why this and not a bigger step, for diagnostics. */
  reason: string;
}

const round = (n: number): number => Math.round(n);

/** Blocks the building spans at `rung`. */
function blocksAt(extent: ExtentM, rung: SizeRung): { x: number; y: number; z: number } {
  return { x: round(extent.x * rung.blocksPerMetre), y: round(extent.y * rung.blocksPerMetre), z: round(extent.z * rung.blocksPerMetre) };
}

/**
 * The suggested step: the SMALLEST step of the finest level that fits the budget and the room (a level's smallest step
 * is its own 100 percent, so the footprint is no bigger than the detail needs). When even the coarsest level does not
 * fit the room, the largest step that does (or the smallest step) is named with that said plainly.
 */
export function suggestSize(input: SuggestInput): SizeSuggestion {
  const budgetOk = (l: DetailLevel): boolean => {
    const c = input.costs.find(k => k.studsPerMetre === l.studsPerMetre);
    return c !== undefined && c.residentCuboids <= input.maxResidentCuboids;
  };
  const rungs: SuggestedRung[] = sizeLadder(input.steps).map(r => {
    const blocks = blocksAt(input.extent, r);
    return { ...r, blocks, withinBudget: budgetOk(r.level), fitsSpace: input.availableBlocks === undefined || Math.max(blocks.x, blocks.z) <= input.availableBlocks };
  });
  const usable = rungs.filter(r => r.withinBudget && r.fitsSpace);
  // Finest level first; within a level the smallest step (rungs are in step order, so the first of a level wins).
  const finest = usable.reduce<SuggestedRung | undefined>((best, r) => (best === undefined || r.level.studsPerMetre > best.level.studsPerMetre ? r : best), undefined);
  const fallback = rungs.filter(r => r.fitsSpace).pop() ?? rungs[0]!;
  const pick = finest ?? fallback;
  const coarsest = DETAIL_LEVELS[0]!;
  const fine = pick.level.studsPerMetre > coarsest.studsPerMetre;
  const unfit = !finest;
  const reason = unfit
    ? 'no level fits both the phone budget and the room'
    : `finest level within budget (${pick.level.studsPerMetre} studs per metre) at its smallest step`;
  const size = `${pick.blocks.x} by ${pick.blocks.z} blocks and ${pick.blocks.y} high`;
  const text = unfit
    ? `Suggested size: ${pick.pct} percent, the largest that fits the clear space. It covers ${size}.`
    : `Suggested size: ${pick.pct} percent. ${fine ? `At this size the design has ${pick.level.label}.` : 'This is the whole building at one stud to the metre.'} It covers ${size}${input.availableBlocks === undefined ? '' : ', which fits your clear space'}.`;
  return { pct: pick.pct, level: pick.level, rungs, text, reason };
}

