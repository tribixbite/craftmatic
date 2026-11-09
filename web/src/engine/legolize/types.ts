/**
 * Lattice types for the mesh -> bricks pipeline (BIZ-33, X-11).
 *
 * TODO(X-08): these are an identical local copy of the shared contract in
 * docs/plans/README.md section 1.1. When `web/src/brickgen/types.ts` merges, replace
 * this file's declarations with `export type { IntentLattice, IntentLabel } from
 * '../../brickgen/types.js'` and keep `LATTICE_CELL_LDU` here.
 */

/** Semantic role of a lattice cell; the mesh front end only ever emits `'solid'`. */
export interface IntentLabel {
  role: 'wall' | 'floor' | 'roof-slope' | 'roof-flat' | 'window' | 'arch' | 'column' | 'trim' | 'detail' | 'terrain' | 'support' | 'solid';
  /** LDraw colour code. */
  colour: number;
  feature?: string;
  slope?: { dir: 0 | 1 | 2 | 3; rise: 1 | 2 | 3 };
  hollowOk?: boolean;
}

/** One cell per stud column x plate layer; 0 = empty, otherwise 1 + index into `labels`. */
export interface IntentLattice {
  dims: [studsX: number, plates: number, studsZ: number];
  cells: Uint16Array;
  labels: IntentLabel[];
}

/** One lattice cell is 1 stud x 1 plate x 1 stud: 20 x 8 x 20 LDU. */
export const LATTICE_CELL_LDU: readonly [number, number, number] = [20, 8, 20];

/**
 * Index of cell (stud x, plate layer p, stud z) in `IntentLattice.cells`:
 * plate-major, then z, then x. The contract does not fix a layout; X-08 must
 * adopt this one (or this helper changes in the one place).
 */
export function latticeIndex(dims: IntentLattice['dims'], x: number, p: number, z: number): number {
  return (p * dims[2] + z) * dims[0] + x;
}
