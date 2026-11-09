/**
 * The bricker (X-10, BIZ-05 / BIZ-33): `IntentLattice` -> `BrickPlan`.
 *
 * The shared core of both products: the landmark part mapper's grammars (A)
 * and the mesh-to-bricks route (B, `engine/legolize`) both hand it a lattice of
 * labelled stud/plate cells, and it returns a plan of OFFICIAL LDraw parts that
 * the X-09 verifier accepts and the X-08 writer prints.
 *
 *  1. Hollow interiors (`hollowOk` labels lose cells whose six neighbours are all filled).
 *  2. Pack: the largest legal element per run (1xN up to 1x8, 2xN up to 2x10; three plate
 *     layers become a brick), slopes / arches / frames / cones where the label asks for
 *     them and the cells match the part's own occupancy, a running bond between courses
 *     (`pack.ts`). One colour per element: a label is one colour.
 *  3. Repair: while X-09 reports more than one component or an unsupported element,
 *     re-cover the contacts between stranded pieces (`repair.ts`).
 *
 * What the labels mean to the bricker (the contract for grammar authors):
 *  - `wall`, `column`, `support`, `solid`, `terrain`: bricks, plates where no brick fits.
 *  - `floor`, `roof-flat`: plates. `trim`, `detail`: tiles under an empty cell, else plates.
 *  - `roof-slope` with `slope {dir, rise}`: the slope part whose own occupancy equals the
 *    cells (dir = the way the roof descends: 0 +x, 1 -x, 2 +z, 3 -z; rise 3 = 45 degree
 *    family, 2 = 33 degree, 1 = curved); cells no slope fits become bricks and plates.
 *    `feature: 'cone'` / `'dome'` pick the cone / dome parts the same way.
 *  - `arch`, `window`: the arch or frame whose occupancy matches. The part's own opening
 *    cells may be empty or carry the same label; an unmatched `window` cell is left open.
 *  - `column` with `feature: 'round'`: round bricks.
 */
import { BRICK_VOCABULARY } from '../vocab/index.js';
import type { BrickPlan, BrickVocabulary, IntentLabel, IntentLattice, ModelScale, PlacedElement, VerifyReport } from '../types.js';
import { verifyPlan } from '../verify/index.js';
import { Grid, OPENING, PackContext, packGrid, type Placement } from './pack.js';
import { repairGrid } from './repair.js';
import { buildVariants, type Variant } from './variants.js';

export { findAlignedSeams } from './bond.js';
export { latticeFromPlan } from './from-plan.js';
export { slopeDirOf } from './variants.js';

export interface BrickerOptions {
  /** Recorded in the plan; default 1 stud per metre, 2.5 plates per metre. */
  scale?: ModelScale;
  /** Longest single-wide element (default 8). */
  maxLength1?: number;
  /** Longest double-wide element (default 10). */
  maxLength2?: number;
  /** Remove the interior of `hollowOk` cells (default true). */
  hollow?: boolean;
  /** Run the repair pass (default true). */
  repair?: boolean;
  /** Repair rounds per strategy (default 6). */
  maxRepairRounds?: number;
  /** Cap on verifier runs the repair pass may spend (default 400). */
  maxRepairMeasures?: number;
  /** The vocabulary to build from (default: the official brick vocabulary). */
  vocabulary?: BrickVocabulary;
}

export interface BrickerResult {
  plan: BrickPlan;
  /** The X-09 report of `plan`. */
  report: VerifyReport;
  /** Re-cover operations the repair pass kept. */
  repairs: number;
  /** Cells removed from hollow interiors. */
  hollowed: number;
  /** Filled lattice cells in the input. */
  filled: number;
  /** Cells left as open window / arch voids (or labels nothing could build). */
  openings: number;
}

const DEFAULT_SCALE: ModelScale = { studsPerMetre: 1, platesPerMetre: 2.5, reason: 'bricker default (1 stud per metre)' };

/** One group per role family, so each lands in its own file of the written MPD and polish ops can name it. */
const GROUP_OF_ROLE: Readonly<Record<IntentLabel['role'], { id: string; label: string }>> = {
  wall: { id: 'walls', label: 'Walls' }, column: { id: 'walls', label: 'Walls' },
  floor: { id: 'floors', label: 'Floors' },
  'roof-slope': { id: 'roof', label: 'Roof' }, 'roof-flat': { id: 'roof', label: 'Roof' },
  window: { id: 'openings', label: 'Openings' }, arch: { id: 'openings', label: 'Openings' },
  trim: { id: 'trim', label: 'Trim and details' }, detail: { id: 'trim', label: 'Trim and details' },
  terrain: { id: 'base', label: 'Base and supports' }, support: { id: 'base', label: 'Base and supports' },
  solid: { id: 'model', label: 'Model' },
};

const variantCache = new Map<string, Variant[]>();

function variantsFor(vocabulary: BrickVocabulary, maxLength1: number, maxLength2: number): Variant[] {
  const key = `${vocabulary === BRICK_VOCABULARY ? 'default' : vocabulary.version}:${maxLength1}:${maxLength2}`;
  let v = variantCache.get(key);
  if (!v) { v = buildVariants(vocabulary, { maxLength1, maxLength2 }); if (vocabulary === BRICK_VOCABULARY) variantCache.set(key, v); }
  return v;
}

function placedOf(p: Placement, labels: readonly IntentLabel[]): PlacedElement {
  return { part: p.variant.part, colour: labels[p.label]!.colour, at: [p.at[0], p.at[1], p.at[2]], turn: p.variant.turn, group: GROUP_OF_ROLE[labels[p.label]!.role].id };
}

/** The plan of the live placements, deterministic order (layer, z, x, part). */
function planOf(live: readonly Placement[], labels: readonly IntentLabel[], scale: ModelScale): BrickPlan {
  const groups = new Map<string, string>();
  const elements: PlacedElement[] = live.map(p => {
    const g = GROUP_OF_ROLE[labels[p.label]!.role];
    groups.set(g.id, g.label);
    return { part: p.variant.part, colour: labels[p.label]!.colour, at: [p.at[0], p.at[1], p.at[2]], turn: p.variant.turn, group: g.id };
  });
  return { elements, groups: [...groups].map(([id, label]) => ({ id, label })).sort((a, b) => (a.id < b.id ? -1 : 1)), scale, metas: [] };
}

/** Brick a lattice. Never throws on a bad lattice shape except an inconsistent `cells` length. */
export function brickLattice(lattice: IntentLattice, options: BrickerOptions = {}): BrickerResult {
  const [W, H, D] = lattice.dims;
  if (lattice.cells.length !== W * H * D) throw new RangeError(`bricker: cells has ${lattice.cells.length} entries for dims ${W}x${H}x${D}`);
  const scale = options.scale ?? DEFAULT_SCALE;
  const variants = variantsFor(options.vocabulary ?? BRICK_VOCABULARY, options.maxLength1 ?? 8, options.maxLength2 ?? 10);
  const grid = new Grid(lattice);
  let filled = 0;
  for (const c of lattice.cells) if (c) filled++;
  const hollowed = options.hollow === false ? 0 : grid.hollowOut();
  const ctx = new PackContext(variants, lattice.labels);
  const plateCtx = new PackContext(variants, lattice.labels, 'plates');
  const genericCtx = new PackContext(variants, lattice.labels, 'generic');
  packGrid(grid, ctx);

  const build = (live: Placement[]): BrickPlan => planOf(live, lattice.labels, scale);
  let repairs = 0;
  if (options.repair !== false) {
    repairs = repairGrid(grid, ctx, plateCtx, genericCtx, p => placedOf(p, lattice.labels), { ...(options.maxRepairRounds !== undefined ? { maxRounds: options.maxRepairRounds } : {}), ...(options.maxRepairMeasures !== undefined ? { maxMeasures: options.maxRepairMeasures } : {}) }).repairs;
  }

  // Final plan: live placements in scan order of their anchor (layer, z, x), then part, so output is stable.
  const live = grid.placements.filter(p => !p.removed)
    .sort((a, b) => a.at[1] - b.at[1] || a.at[2] - b.at[2] || a.at[0] - b.at[0] || (a.variant.part < b.variant.part ? -1 : a.variant.part > b.variant.part ? 1 : 0));
  const plan = build(live);
  let openings = 0;
  for (const o of grid.owner) if (o === OPENING) openings++;
  return { plan, report: verifyPlan(plan), repairs, hollowed, filled, openings };
}
