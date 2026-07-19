/**
 * Stage 7 — synthesis routing.
 *
 * Decides which synthesizer produces the B-rep, in STRICT PRECEDENCE ORDER.
 * Usable photogrammetry (meshes present, not truncated, coverage OK) is
 * preferred for everything except small parametrizable homes, because the
 * sliced silhouette captures setbacks / twin towers / cantilevers a single
 * prism cannot. The iconic / curved / truncated / no-polygon rows below are
 * therefore FALLBACKS — reached only when photogrammetry is NOT usable (which
 * is why they never fire for a Guggenheim-class curved landmark that has good
 * tiles: it takes row 2). Order matches the code exactly:
 *
 *   1. small/tiny + parametrizable footprint + polygon → '7a-parametric'
 *        (a house fills a fraction of the capture radius → the blob is noise)
 *   2. curved footprint with polygon                   → '7b-cleaned-tiles'
 *        (the sliced silhouette merges a curved mass with its neighbours —
 *         guggenheim 7d IoU 0.57 vs 7b 0.99; 7b routes through the curved/
 *         helical primitives built for these shapes)
 *   3. usable tiles (meshes, not truncated, coverage)  → '7d-sliced'  ← dominant
 *   4. iconic landmark with any coverage               → '7c-hybrid'
 *   5. curved / irregular footprint                    → '7b-cleaned-tiles'
 *   6. truncated skyscraper with polygon               → '7a-parametric'
 *   7. no polygon                                      → '7b-cleaned-tiles'
 *   8. default                                         → '7a-parametric'
 */

import type { RefinedBuildingContext } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';
import type { BuildingBRep } from './brep.js';
import { synthesizeParametric } from './parametric.js';
import { synthesizeCleanedTiles } from './cleaned-tiles.js';
import { synthesizeSlicedTilesResult } from './sliced-tiles.js';

export type SynthesisPath = '7a-parametric' | '7b-cleaned-tiles' | '7c-hybrid' | '7d-sliced';

export function routeSynthesis(
  ctx: RefinedBuildingContext,
  _ev: JointEvidence,
  tiles: TileEvidence | null,
): SynthesisPath {
  const tags = ctx.rawOsm?.tags ?? {};
  const iconic = tags['tourism'] === 'attraction'
              || tags['historic'] === 'monument'
              || tags['heritage'] != null;
  // Sliced path requires actual mesh data (positions/indices) — preferred
  // for any building with tile coverage because the sliced silhouette
  // captures setbacks, twin towers, cantilevers that single-prism
  // synthesizers cannot. Truncated photogrammetry is excluded — the top
  // is missing so per-band heights would underreport.
  const tilesUsable = tiles && !tiles.noCoverage && !tiles.truncated
    && tiles.meshes && tiles.meshes.length > 0;

  // Small buildings: a house fills only a fraction of the tile-capture radius,
  // so the photogrammetry silhouette is dominated by surrounding trees, ground
  // and neighbours — the sliced path then misreads the blob as curved/irregular
  // and the per-band heights are noise (a 44 m capture scaled to an 8 m house).
  // The OSM polygon (extruded by parametric, including L/U plans) + a parametric
  // roof reproduces a home far better, so prefer parametric for any small,
  // parametrizable footprint with a usable polygon, even with tiles present.
  // Curved/irregular footprints (which don't parametrize cleanly) and iconic
  // landmarks (which want photogrammetry detail) still take their normal paths.
  const smallWithPolygon = (ctx.size === 'tiny' || ctx.size === 'small')
    && ctx.shape !== 'curved' && ctx.shape !== 'irregular'
    && !iconic
    && ctx.polygon != null && ctx.polygon.length >= 3;
  if (smallWithPolygon) return '7a-parametric';

  // Curved massing beats usable tiles: the sliced silhouette merges a curved
  // building's blob with sidewalk/neighbour mass (guggenheim via 7d scored
  // IoU 0.57 fail-objective; via 7b, 0.99), and 7b is the path wired to the
  // curved/helical primitives built for exactly these shapes. Requires a
  // polygon — without one 7b has no silhouette anchor, so usable tiles (or
  // the no-polygon fallback) still win below. Irregular (non-curved) shapes
  // stay on the sliced path: their per-band silhouettes are genuine signal.
  if (ctx.shape === 'curved' && ctx.polygon != null && ctx.polygon.length >= 3) {
    return '7b-cleaned-tiles';
  }

  if (tilesUsable) return '7d-sliced';
  if (iconic && tiles && !tiles.noCoverage) return '7c-hybrid';
  if (ctx.shape === 'curved' || ctx.shape === 'irregular') return '7b-cleaned-tiles';
  if (tiles?.truncated && ctx.size === 'skyscraper' && ctx.polygon) return '7a-parametric';
  if (!ctx.polygon) return '7b-cleaned-tiles';
  return '7a-parametric';
}

/**
 * Per-synthesizer metadata that downstream stages (voxel export,
 * photogrammetry recolor) need. Currently only populated for the
 * sliced path.
 */
export interface SynthesisMeta {
  /** Y-scale factor: y_grid = (y_photogrammetry - yShift) × yScale. Identity when absent. */
  readonly yScale?: number;
  /** Y-shift = trueMinY of survived bands (photogrammetry origin). */
  readonly yShift?: number;
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
): { path: SynthesisPath; brep: BuildingBRep; meta: SynthesisMeta } {
  const path = routeSynthesis(ctx, ev, tiles);
  switch (path) {
    case '7a-parametric':
      return { path, brep: synthesizeParametric(ctx, ev), meta: {} };
    case '7b-cleaned-tiles':
      return { path, brep: synthesizeCleanedTiles(ctx, ev, tiles), meta: {} };
    case '7c-hybrid':
      // TODO: add photogrammetry texture baking over the parametric mass.
      return { path, brep: synthesizeParametric(ctx, ev), meta: {} };
    case '7d-sliced': {
      const result = synthesizeSlicedTilesResult(ctx, ev, tiles!);
      return { path, brep: result.brep, meta: { yScale: result.yScale, yShift: result.yShift } };
    }
  }
}
