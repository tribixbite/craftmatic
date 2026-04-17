/**
 * Stage 7 — synthesis routing.
 *
 * Decides which synthesizer produces the B-rep based on context + tile
 * evidence. Per spec §Stage 7 Router:
 *   • iconic landmark  → '7c-hybrid' (parametric mass + photogrammetry detail)
 *   • curved/irregular → '7b-cleaned-tiles'
 *   • truncated skyscraper with polygon → '7a-parametric' (ignore truncated mesh)
 *   • no polygon       → '7b-cleaned-tiles'
 *   • default          → '7a-parametric'
 */

import type { RefinedBuildingContext } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';
import type { BuildingBRep } from './brep.js';
import { synthesizeParametric } from './parametric.js';
import { synthesizeCleanedTiles } from './cleaned-tiles.js';

export type SynthesisPath = '7a-parametric' | '7b-cleaned-tiles' | '7c-hybrid';

export function routeSynthesis(
  ctx: RefinedBuildingContext,
  _ev: JointEvidence,
  tiles: TileEvidence | null,
): SynthesisPath {
  const tags = ctx.rawOsm?.tags ?? {};
  const iconic = tags['tourism'] === 'attraction'
              || tags['historic'] === 'monument'
              || tags['heritage'] != null;
  if (iconic && tiles && !tiles.noCoverage) return '7c-hybrid';
  if (ctx.shape === 'curved' || ctx.shape === 'irregular') return '7b-cleaned-tiles';
  if (tiles?.truncated && ctx.size === 'skyscraper' && ctx.polygon) return '7a-parametric';
  if (!ctx.polygon) return '7b-cleaned-tiles';
  return '7a-parametric';
}

/**
 * Top-level synthesis dispatcher. Invokes the correct synthesizer and returns
 * the B-rep. Hybrid path (7c) currently delegates to parametric since the
 * texture-baking layer isn't implemented yet; future work will add
 * photogrammetry-texture mapping on the parametric mass.
 */
export function synthesize(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence | null,
): { path: SynthesisPath; brep: BuildingBRep } {
  const path = routeSynthesis(ctx, ev, tiles);
  switch (path) {
    case '7a-parametric':
      return { path, brep: synthesizeParametric(ctx, ev) };
    case '7b-cleaned-tiles':
      return { path, brep: synthesizeCleanedTiles(ctx, ev, tiles) };
    case '7c-hybrid':
      // TODO: add photogrammetry texture baking over the parametric mass.
      return { path, brep: synthesizeParametric(ctx, ev) };
  }
}
