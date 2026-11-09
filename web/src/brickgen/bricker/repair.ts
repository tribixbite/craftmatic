/**
 * The repair pass: while the verifier reports more than one component (or
 * elements with no load path), re-cover the neighbourhood of every contact
 * between a stranded piece and the rest of the model until the elements span
 * the join. This is the "split a seam-aligned element and re-cover" step.
 *
 * Strategies, tried in order, each for as many rounds as it keeps improving:
 *  0. re-pack the two touching elements with the old seam faces forbidden;
 *  1. the same region, plates only (a stack of plates has no course to line up);
 *  2. the region widened by every generic element resting on or under it, seams forbidden;
 *  3. that widened region, plates only;
 *  4. the widened region INCLUDING slopes, arches and frames, which become plain bricks (a slope whose studs miss the
 *     part above it cannot be joined any other way);
 *  5. the same, plates only.
 * Strategies 0-3 never re-pack slopes, arches or frames.
 *
 * Each proposal is judged LOCALLY first: studs join only vertically, so the elements touching the region from above
 * and below plus the region's elements form a small graph, and a re-cover is kept only when it leaves that graph with
 * fewer pieces and splits none of the old pieces. A round of kept proposals is then judged by the global
 * (components, unsupported) measure and rolled back as a whole when that did not improve.
 */
import type { PlacedElement } from '../types.js';
import { connectivity, placeElement, stability, VOCABULARY_LOOKUP, type WorldElement } from '../verify/index.js';
import type { Connectivity } from '../verify/connect.js';
import { FREE, Grid, faceKey, packGrid, type PackContext, type Placement } from './pack.js';

/** What a round is judged by. */
export interface Measure { components: number; unsupported: number; connectivity: Connectivity }

export interface RepairOptions {
  /** Rounds per strategy (default 6). */
  maxRounds?: number;
  /** Cap on whole-model verifier runs (default 400): bounds the cost on a model that cannot be joined. */
  maxMeasures?: number;
}

const better = (a: Measure, b: Measure): boolean => a.components < b.components || (a.components === b.components && a.unsupported < b.unsupported);
const done = (m: Measure): boolean => m.components <= 1 && m.unsupported === 0;

/** Alternative contacts tried for a stranded piece before a strategy gives up. */
const VARIANTS = 3;

interface Proposal { region: Placement[]; forbid: Set<number> }
interface Undo { saved: Array<[number, number]>; before: number; removed: Placement[] }

/** Re-cover stranded contacts. `toPlaced` names a placement as a plan element. Returns the kept re-covers and the final measure. */
export function repairGrid(
  grid: Grid, ctx: PackContext, plateCtx: PackContext, genericCtx: PackContext,
  toPlaced: (p: Placement) => PlacedElement, options: RepairOptions = {},
): { repairs: number; measure: Measure } {
  const { W, D } = grid;
  const layer = W * D;
  const live = (): Placement[] => grid.placements.filter(p => !p.removed);

  // Elements resolved onto the lattice once: a placement never changes its cells.
  const resolved = new Map<Placement, WorldElement>();
  const worldOf = (p: Placement): WorldElement => {
    let w = resolved.get(p);
    if (!w) { w = placeElement(0, toPlaced(p), VOCABULARY_LOOKUP)!; resolved.set(p, w); }
    return w;
  };
  const measure = (): Measure => {
    const world = live().map(worldOf);
    const conn = connectivity(world);
    return { components: conn.sizes.length, unsupported: stability(world, conn).unsupported.length, connectivity: conn };
  };

  /** Live elements directly above or below the region's cells (outside the region): the only ones it can be joined to. */
  const verticalNeighbours = (region: readonly Placement[]): Placement[] => {
    const inRegion = new Set(region);
    const out = new Set<Placement>();
    for (const p of region) for (const i of p.cells) for (const d of [layer, -layer]) {
      const o = grid.owner[i + d];
      if (o !== undefined && o >= 0) {
        const q = grid.placements[o]!;
        if (!inRegion.has(q) && !q.removed) out.add(q);
      }
    }
    return [...out];
  };

  /** Number of pieces of a node set under stud joins, and the piece of each node. */
  const pieces = (nodes: readonly Placement[]): Connectivity => connectivity(nodes.map(worldOf));

  /** Re-pack a region and report how to undo it. */
  const apply = (p: Proposal, useCtx: PackContext): { undo: Undo; created: Placement[] } => {
    const undo: Undo = { saved: [], before: grid.placements.length, removed: [] };
    const cells: number[] = [];
    for (const old of p.region) {
      old.removed = true;
      undo.removed.push(old);
      for (const i of old.cells) { undo.saved.push([i, grid.owner[i]!]); grid.owner[i] = FREE; cells.push(i); }
    }
    cells.sort((x, y) => x - y);
    packGrid(grid, useCtx, { region: cells, forbid: p.forbid });
    return { undo, created: grid.placements.slice(undo.before) };
  };
  const rollback = (u: Undo): void => {
    for (let k = u.saved.length - 1; k >= 0; k--) grid.owner[u.saved[k]![0]] = u.saved[k]![1];
    grid.placements.length = u.before;
    u.removed.forEach(p => { p.removed = false; });
  };

  let current = measure();
  let repairs = 0;
  const maxRounds = options.maxRounds ?? 6;
  const maxMeasures = options.maxMeasures ?? 400;
  let measures = 0;

  for (let strategy = 0; strategy < 6 && !done(current); strategy++) {
    let variant = 0;
    for (let round = 0; round < maxRounds && !done(current) && measures < maxMeasures; round++) {
      const members = live();
      const label = current.connectivity.label; // component per live index (0 = the largest)
      const indexOf = new Map<Placement, number>(members.map((p, i) => [p, i]));
      const eligible = (p: Placement): boolean => strategy >= 4 || p.variant.use === 'generic';
      const contactsOf = (p: Placement): Placement[] => {
        const out = new Set<Placement>();
        for (const i of p.cells) for (const d of [1, -1, W, -W, layer, -layer]) {
          const o = grid.owner[i + d];
          if (o !== undefined && o >= 0 && grid.placements[o] !== p && !grid.placements[o]!.removed) out.add(grid.placements[o]!);
        }
        return [...out];
      };

      const used = new Set<Placement>();
      const proposals: Proposal[] = [];
      members.forEach((a, ai) => {
        if (label[ai] === 0) return;
        // Contacts with the largest component first: joining two stranded pieces to each other helps nothing.
        const sorted = contactsOf(a).filter(b => label[indexOf.get(b)!] !== label[ai])
          .sort((x, y) => label[indexOf.get(x)!]! - label[indexOf.get(y)!]!);
        const turn = sorted.length ? variant % sorted.length : 0;
        for (const b of [...sorted.slice(turn), ...sorted.slice(0, turn)]) {
          const core = [a, b].filter(eligible);
          if (core.length === 0 || used.has(a) || used.has(b)) continue;
          let region = core;
          if (strategy >= 2) {
            const around = new Set<Placement>(core);
            for (const c of core) for (const n of contactsOf(c)) if (eligible(n) && !used.has(n)) around.add(n);
            region = [...around];
          }
          if (region.some(p => used.has(p))) continue;
          // Faces between the two pieces: the seams the old cover had here.
          const forbid = new Set<number>();
          const aCells = new Set(a.cells);
          for (const i of b.cells) for (const [d, axis] of [[1, 0], [-1, 0], [W, 1], [-W, 1]] as const) {
            if (aCells.has(i + d)) forbid.add(faceKey(d > 0 ? i : i + d, axis));
          }
          region.forEach(p => used.add(p));
          proposals.push({ region, forbid });
          break;
        }
      });
      if (proposals.length === 0) break;

      const useCtx = strategy % 2 === 1 ? plateCtx : strategy >= 4 ? genericCtx : ctx;
      const undos: Undo[] = [];
      for (const proposal of proposals) {
        const around = verticalNeighbours(proposal.region);
        const oldPieces = pieces([...around, ...proposal.region]);
        const { undo, created } = apply(proposal, useCtx);
        const newPieces = pieces([...around, ...created]);
        // No old piece of the neighbours may be split, and the graph must have fewer pieces than before.
        let splits = false;
        const seenNew = new Map<number, number>();
        for (let k = 0; k < around.length && !splits; k++) {
          const o = oldPieces.label[k]!, n = newPieces.label[k]!;
          if (seenNew.has(o) && seenNew.get(o) !== n) splits = true;
          seenNew.set(o, n);
        }
        if (splits || newPieces.sizes.length >= oldPieces.sizes.length) rollback(undo);
        else undos.push(undo);
      }
      if (undos.length === 0) {
        if (++variant >= VARIANTS) break;
        round--; // nothing helped with this contact: try the next contact of each piece
        continue;
      }
      measures++;
      const next = measure();
      if (better(next, current)) { current = next; repairs += undos.length; variant = 0; continue; }
      for (let k = undos.length - 1; k >= 0; k--) rollback(undos[k]!);
      if (++variant >= VARIANTS) break;
      round--;
    }
  }
  return { repairs, measure: current };
}
