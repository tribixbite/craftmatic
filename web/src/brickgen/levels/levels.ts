/**
 * Detail levels (LSCALE, BIZ-05 / BIZ-10 / BIZ-11): a landmark is DESIGNED at several studs-per-metre scales, and a Brick
 * Wand size step selects the level whose real size it corresponds to, instead of scaling one coarse design up.
 *
 * Units. A stud is 20 LDU and a Bedrock block is `LDU_PER_BLOCK` (53.33) LDU at the 1x model scale, so one stud is
 * `BLOCKS_PER_STUD` = 0.375 blocks. A design at `L` studs per metre placed at wand factor `f` therefore spans
 * `L * f * BLOCKS_PER_STUD` blocks per real metre. The wand's size steps (25 ... 400 percent) are labelled against the
 * 1 stud-per-metre design, so step `S` means `S / 100 * BLOCKS_PER_STUD` blocks per metre, and level `L` shown at
 * factor `S / (100 * L)` lands on exactly that size: a finer design at the same real size, with more studs per metre.
 *
 * Rule: the level of step `S` is the finest level `L <= S / 100`, so a finer pack is never shrunk below its own
 * 100 percent (factor >= 1); steps under 200 percent stay on the 1 stud-per-metre design.
 */
import { LDU_PER_BLOCK } from '../../engine/lego-scale.js';
import { LDU_PER_STUD } from '../massing/scale.js';
import type { ScaleRequest } from '../massing/scale.js';

/** Blocks one stud spans at the 1x model scale (0.375). */
export const BLOCKS_PER_STUD = LDU_PER_STUD / LDU_PER_BLOCK;

/** The wand's size steps in percent (`SIZE_STEPS` in `engine/bedrock-placement-pack.ts`; a test pins them equal). */
export const WAND_STEPS: readonly number[] = [25, 50, 75, 100, 150, 200, 300, 400];

export type DetailLevelId = 'standard' | 'fine' | 'finest';

/** One detail level. `id` names it in files and diagnostics; `label` is player-facing wording (X-05 lint clean). */
export interface DetailLevel {
  id: DetailLevelId;
  studsPerMetre: number;
  /** What the player is told the level adds, e.g. in the wand menu. */
  label: string;
}

/** The levels, coarsest first. A level is data: a finer one is another row. */
export const DETAIL_LEVELS: readonly DetailLevel[] = [
  { id: 'standard', studsPerMetre: 1, label: 'whole building, one stud to the metre' },
  { id: 'fine', studsPerMetre: 2, label: 'two studs to the metre: tapering spires, pinnacles, window shapes' },
  { id: 'finest', studsPerMetre: 4, label: 'four studs to the metre: pointed spire tips, pinnacle stages, rose window tracery' },
];

/** The level a wand step selects: the finest level whose studs per metre is at most `pct / 100`. */
export function levelForSizePct(pct: number): DetailLevel {
  let chosen = DETAIL_LEVELS[0]!;
  for (const l of DETAIL_LEVELS) if (l.studsPerMetre <= pct / 100 + 1e-9) chosen = l;
  return chosen;
}

/** One row of the size ladder: what wand step `pct` means. */
export interface SizeRung {
  pct: number;
  level: DetailLevel;
  /** The wand factor the level's pack is shown at (`pct / (100 * studsPerMetre)`). */
  factor: number;
  /** Real size of the step: blocks one metre of the building spans. */
  blocksPerMetre: number;
}

/** The ladder for `steps` (default: the wand's). Every rung keeps its real size: `blocksPerMetre` ignores the level. */
export function sizeLadder(steps: readonly number[] = WAND_STEPS): SizeRung[] {
  return steps.map(pct => {
    const level = levelForSizePct(pct);
    return { pct, level, factor: pct / (100 * level.studsPerMetre), blocksPerMetre: (pct / 100) * BLOCKS_PER_STUD };
  });
}

/**
 * The scale request that produces `level` EXACTLY. The default request clamps to 40,000 bricks, 512 studs and 1,536
 * plates, which silently turned a 4 studs-per-metre request into 1.83 for a cathedral; a level's cost is judged against
 * the pack budget at export (`levels/budget.ts`), not hidden inside the scale choice.
 */
export function scaleRequestForLevel(level: DetailLevel): ScaleRequest {
  return { target: level.studsPerMetre, maxBricks: Number.POSITIVE_INFINITY, maxStudsXZ: 2048, maxPlates: 4096 };
}

/**
 * What a landmark pack tells the Brick Wand about its detail level and the sizes around it (written by
 * `scripts/_landmark_levels.ts`, carried through the export as `PlacementPackSpec.detail`, shown by the wand).
 * Text fields are written for the player: the export spells them for Bedrock's text formatter.
 */
export interface PlacementDetail {
  /** The level this pack's design was generated at. */
  studsPerMetre: number;
  /** The design's real extent, metres. */
  extentM: { x: number; y: number; z: number };
  /** The suggested wand step in THIS pack's own percent (its 100 percent is the pack's design at factor 1), and the sentence for it. */
  suggestion: { pct: number; text: string };
  /** What the other levels of this landmark add, for a pack that is not the finest: one sentence each, coarsest first. */
  otherLevels: Array<{ studsPerMetre: number; text: string }>;
}
