/**
 * Public surface of the LDraw renderer module.
 *
 * Prefer the LDrawViewer class for new code — it supports persistent state
 * with O(1) step toggling. The createLDrawViewer factory below remains for
 * backward compatibility with the older single-shot API.
 */

import type { ParsedBrick } from '@engine/ldraw-parser.js';
import { LDrawViewer } from './viewer.js';
import type { LDrawViewerOptions } from './types.js';

export { LDrawViewer } from './viewer.js';
export type { LDrawViewerOptions, Vec3, Triangle, Edge, PartGeom } from './types.js';
export { setLDrawBase } from './parts.js';

/**
 * Backward-compat factory matching the old createLDrawViewer signature.
 * Internally creates an LDrawViewer and calls load() once. Callers who
 * need step toggling without rebuild should use LDrawViewer directly.
 */
export async function createLDrawViewer(
  container: HTMLElement,
  bricks: ParsedBrick[],
  opts?: LDrawViewerOptions,
): Promise<LDrawViewer> {
  const viewer = await LDrawViewer.create(container, opts);
  await viewer.load(bricks, opts);
  return viewer;
}
