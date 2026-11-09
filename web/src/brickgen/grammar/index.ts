/** A07/A08 skeleton (fail-first run only): replaced by the real grammar in the next commit. */
import type { FeatureSet, IntentLattice, Massing } from '../types.js';

export interface GrammarResult { lattice: IntentLattice; notes: string[] }

/** Skeleton: a lattice holding only the base plate, so the first test run fails on assertions, not on a missing import. */
export function buildGrammarLattice(massing: Massing, _features: FeatureSet): GrammarResult {
  const W = Math.round(massing.boundsM[1][0] * massing.scale.studsPerMetre), D = Math.round(massing.boundsM[1][2] * massing.scale.studsPerMetre);
  const H = Math.ceil(massing.boundsM[1][1] * massing.scale.platesPerMetre) + 3;
  const cells = new Uint16Array(W * H * D);
  for (let i = 0; i < W * D * 2; i++) cells[i] = 1;
  return { lattice: { dims: [W, H, D], cells, labels: [{ role: 'terrain', colour: 19 }] }, notes: [] };
}
