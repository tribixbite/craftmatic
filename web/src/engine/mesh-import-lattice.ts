/**
 * Mesh bytes -> stud lattice (BIZ-32 feeding X-11): any supported mesh format, scaled by a
 * {@link MeshSizing} ("real size", "fit to N studs" or explicit), then `meshToLattice`.
 * Kept apart from mesh-import.ts so the readers do not pull in the voxeliser.
 */

import { loadMeshFromBytes, resolveLduPerUnit, type MeshSizing } from './mesh-import.js';
import type { MeshToLatticeOptions } from './legolize/lattice.js';
import type { IntentLattice } from './legolize/types.js';

/** Options passed through to `meshToLattice` (its `lduPerUnit` is set from the sizing). */
export type MeshBytesToLatticeOptions = Omit<MeshToLatticeOptions, 'lduPerUnit'>;

/**
 * Reads a mesh file and voxelises it to a lattice.
 * @param sizing how to map file units to LDU (see {@link MeshSizing}).
 */
export async function meshBytesToLattice(
  bytes: ArrayBuffer,
  filename: string,
  sizing: MeshSizing,
  options: MeshBytesToLatticeOptions = {},
): Promise<IntentLattice> {
  const object = await loadMeshFromBytes(bytes, filename);
  const { meshToLattice } = await import('./legolize/lattice.js');
  return meshToLattice(object, { ...options, lduPerUnit: resolveLduPerUnit(object, sizing) });
}
