/**
 * Deterministic defect score — a production regression signal that does NOT
 * depend on the VLM.
 *
 * The binary defect checklist (`src/grade/defect-score.ts`) is filled by a VLM
 * in the legacy path. But several of its booleans are computable from signals
 * the pipeline already produces deterministically — so they should be measured,
 * not guessed by a noisy model. This module derives the *provable* defects from
 * the objective gates + the height cross-check + a connected-component pass on
 * the voxel grid, and rolls them into a stable 0-10 score the iterate loop can
 * rank on. The VLM is then reserved for the genuinely-perceptual judgements
 * (colour harmony, "reads as the building") and the two defects that need visual
 * attribution (neighbour-merge vs false-positive), which geometry can't separate.
 *
 * Pure except for reading the grid.
 */

import type { ObjectiveResult } from './objective.js';
import type { CrossCheckResult } from './cross-check.js';
import { BlockGrid } from '../../schem/types.js';
import { getBlockColor } from '../../blocks/colors.js';

/** Above this fraction of voxels off the largest body ⇒ floating artifacts. */
const FLOATING_RATIO = 0.02;
/** Fewer distinct block types than this ⇒ uniform/monochrome surface. */
const MIN_BLOCK_TYPES = 3;
/** Bounding-volume cap above which the connectivity pass is skipped (memory). */
const MAX_CELLS_FOR_FLOOD = 64_000_000;
/**
 * Dominant-facade-block share below this ⇒ incoherent facade. Calibrated on
 * the 2026-07 golden renders: the visually-jumbled sliced flatiron measured
 * 18% dominant; coherent builds (parametric highland, flatiron post-router)
 * measured 31-36%. A real facade has a primary material; per-voxel recolor
 * dither that never settles on one reads as noise to both humans and VLMs.
 */
const FACADE_DOMINANT_MIN = 0.25;
/** Facades smaller than this many exposed voxels are too small to judge. */
const MIN_FACADE_VOXELS = 200;
/**
 * Mean facade luma below this on a RESIDENTIAL archetype ⇒ implausibly dark
 * (shaded-pano wall palette). Calibrated on real builds: shade-victim
 * rowhouse = 98, healthy residential = 140-169. Commercial is exempt —
 * Pennzoil's genuine black-glass towers measure 103.
 */
const RESIDENTIAL_DARK_LUMA = 110;

export interface GridStats {
  /** Non-air voxel count. */
  readonly total: number;
  /** Number of 6-connected components (−1 when the flood pass was skipped). */
  readonly components: number;
  /** Size of the largest component (the main body). */
  readonly largestSize: number;
  /** (total − largestSize) / total — fraction of voxels NOT on the main body. */
  readonly disconnectedRatio: number;
  /** Distinct non-air block types actually present. */
  readonly uniqueBlockTypes: number;
  /** False when the grid was too large to flood-fill (components left −1). */
  readonly computed: boolean;
  /** Side-exposed (±x/±z face on air) voxel count — the visible facade. */
  readonly facadeTotal: number;
  /** Largest single block type's share of the facade (0 when no facade). */
  readonly facadeDominantShare: number;
  /** That block's state string, or null when no facade voxels exist. */
  readonly facadeDominantState: string | null;
  /** Count-weighted mean sRGB luma (0-255) of facade blocks; 0 = no facade. */
  readonly facadeMeanLuma: number;
}

/**
 * Single pass over the grid: count occupancy + distinct block types, and (unless
 * the bounding volume is pathologically large) label 6-connected components so
 * the caller can detect voxels floating off the main body.
 */
export function analyseGridConnectivity(grid: BlockGrid): GridStats {
  const W = grid.width, H = grid.height, L = grid.length;
  const cells = W * H * L;
  const seen = new Set<number>();
  const facadeCounts = new Map<number, number>();

  if (cells > MAX_CELLS_FOR_FLOOD) {
    let total = 0;
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          const id = grid.getIndex(x, y, z);
          if (id !== 0) {
            total++;
            seen.add(id);
            if (isSideExposed(grid, x, y, z, W, L)) {
              facadeCounts.set(id, (facadeCounts.get(id) ?? 0) + 1);
            }
          }
        }
      }
    }
    return {
      total, components: -1, largestSize: -1, disconnectedRatio: 0,
      uniqueBlockTypes: seen.size, computed: false,
      ...facadeStats(grid, facadeCounts),
    };
  }

  const visited = new Uint8Array(cells);
  const stack: number[] = [];
  let total = 0, components = 0, largestSize = 0;

  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const id = grid.getIndex(x, y, z);
        if (id === 0) continue;
        total++;
        seen.add(id);
        if (isSideExposed(grid, x, y, z, W, L)) {
          facadeCounts.set(id, (facadeCounts.get(id) ?? 0) + 1);
        }
        const flat = (y * L + z) * W + x;
        if (visited[flat]) continue;

        // Flood-fill this component (6-connectivity).
        visited[flat] = 1;
        stack.length = 0;
        stack.push(flat);
        let size = 0;
        while (stack.length > 0) {
          const cur = stack.pop() as number;
          size++;
          const cx = cur % W;
          const t = (cur / W) | 0;
          const cz = t % L;
          const cy = (t / L) | 0;
          tryPush(grid, visited, stack, cx - 1, cy, cz, W, H, L);
          tryPush(grid, visited, stack, cx + 1, cy, cz, W, H, L);
          tryPush(grid, visited, stack, cx, cy - 1, cz, W, H, L);
          tryPush(grid, visited, stack, cx, cy + 1, cz, W, H, L);
          tryPush(grid, visited, stack, cx, cy, cz - 1, W, H, L);
          tryPush(grid, visited, stack, cx, cy, cz + 1, W, H, L);
        }
        components++;
        if (size > largestSize) largestSize = size;
      }
    }
  }

  const disconnectedRatio = total > 0 ? (total - largestSize) / total : 0;
  return {
    total, components, largestSize, disconnectedRatio,
    uniqueBlockTypes: seen.size, computed: true,
    ...facadeStats(grid, facadeCounts),
  };
}

/**
 * A voxel is facade when any ±x/±z face neighbour is air (or the grid edge —
 * trimmed grids abut their bounds). Vertical exposure (roofs, floors) is
 * intentionally excluded: the coherence signal is about what a viewer sees
 * looking AT the building, and roof material legitimately differs.
 */
function isSideExposed(
  grid: BlockGrid, x: number, y: number, z: number, W: number, L: number,
): boolean {
  return (x === 0 || grid.getIndex(x - 1, y, z) === 0)
    || (x === W - 1 || grid.getIndex(x + 1, y, z) === 0)
    || (z === 0 || grid.getIndex(x, y, z - 1) === 0)
    || (z === L - 1 || grid.getIndex(x, y, z + 1) === 0);
}

/** Resolve the facade tally into the GridStats facade fields. */
function facadeStats(
  grid: BlockGrid, facadeCounts: Map<number, number>,
): Pick<GridStats, 'facadeTotal' | 'facadeDominantShare' | 'facadeDominantState' | 'facadeMeanLuma'> {
  let facadeTotal = 0, best = 0;
  let bestId: number | null = null;
  let lumaSum = 0, lumaN = 0;
  for (const [id, n] of facadeCounts) {
    facadeTotal += n;
    if (n > best) { best = n; bestId = id; }
    // Per-palette-id luma — O(palette), not O(voxels).
    const c = getBlockColor(grid.blockStateFromIndex(id));
    if (c) { lumaSum += (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * n; lumaN += n; }
  }
  return {
    facadeTotal,
    facadeDominantShare: facadeTotal > 0 ? best / facadeTotal : 0,
    facadeDominantState: bestId !== null ? grid.blockStateFromIndex(bestId) : null,
    facadeMeanLuma: lumaN > 0 ? lumaSum / lumaN : 0,
  };
}

function tryPush(
  grid: BlockGrid, visited: Uint8Array, stack: number[],
  x: number, y: number, z: number,
  W: number, H: number, L: number,
): void {
  if (x < 0 || x >= W || y < 0 || y >= H || z < 0 || z >= L) return;
  const flat = (y * L + z) * W + x;
  if (visited[flat]) return;
  if (grid.getIndex(x, y, z) === 0) return;
  visited[flat] = 1;
  stack.push(flat);
}

/** The subset of the defect checklist that geometry can prove (true = bad,
 *  except the two `*_visible`/`*_correct` quality flags where true = good). */
export interface DeterministicDefects {
  readonly height_truncated: boolean;
  readonly facade_holes_visible: boolean;
  readonly floating_artifacts: boolean;
  readonly footprint_wrong_shape: boolean;
  readonly surface_detail_visible: boolean;
  readonly proportions_correct: boolean;
  /** No block reaches FACADE_DOMINANT_MIN share of the visible facade —
   *  per-voxel recolor dither with no primary material (reads as noise). */
  readonly facade_incoherent: boolean;
  /** Residential archetype with a near-black facade — a shaded street pano
   *  baked into the wall palette, not black siding. */
  readonly facade_implausibly_dark: boolean;
}

export interface DefectScoreResult {
  readonly defects: DeterministicDefects;
  /** 0-10 over the provable fields (same weights as scoreFromDefects). */
  readonly score: number;
  /** Which penalties fired — for telemetry and the iterate loop. */
  readonly penalties: readonly string[];
  readonly grid: GridStats;
}

/**
 * Derive the provable defect checklist from deterministic signals and roll it
 * into a 0-10 score. Reuses the checklist weights (height/holes/floating/uniform
 * −1 each; footprint/proportions −0.3 each). The two attribution-only defects
 * (neighbour-merge, false-positive) are intentionally excluded — they need the
 * VLM.
 */
export function deriveDefects(
  objective: ObjectiveResult,
  crossCheck: CrossCheckResult | null,
  grid: BlockGrid,
  opts: { readonly archType?: string } = {},
): DefectScoreResult {
  const g = analyseGridConnectivity(grid);

  const defects: DeterministicDefects = {
    height_truncated: (crossCheck?.truncationSuspected ?? false) || objective.heightErr > 0.10,
    facade_holes_visible: !objective.watertight,
    floating_artifacts: g.computed && g.disconnectedRatio > FLOATING_RATIO,
    footprint_wrong_shape: objective.footprintIoU < 0.85,
    surface_detail_visible: g.uniqueBlockTypes >= MIN_BLOCK_TYPES,
    proportions_correct: objective.heightErr <= 0.10 && objective.footprintIoU >= 0.85,
    facade_incoherent: g.facadeTotal >= MIN_FACADE_VOXELS
      && g.facadeDominantShare < FACADE_DOMINANT_MIN,
    facade_implausibly_dark: opts.archType === 'residential'
      && g.facadeTotal >= MIN_FACADE_VOXELS
      && g.facadeMeanLuma > 0
      && g.facadeMeanLuma < RESIDENTIAL_DARK_LUMA,
  };

  const penalties: string[] = [];
  let score = 10;
  if (defects.height_truncated) { score -= 1; penalties.push('height_truncated'); }
  if (defects.facade_holes_visible) { score -= 1; penalties.push('facade_holes_visible'); }
  if (defects.floating_artifacts) { score -= 1; penalties.push('floating_artifacts'); }
  if (!defects.surface_detail_visible) { score -= 1; penalties.push('uniform_surface'); }
  if (defects.facade_incoherent) { score -= 1; penalties.push('facade_incoherent'); }
  if (defects.facade_implausibly_dark) { score -= 1; penalties.push('facade_implausibly_dark'); }
  if (defects.footprint_wrong_shape) { score -= 0.3; penalties.push('footprint_wrong_shape'); }
  if (!defects.proportions_correct) { score -= 0.3; penalties.push('proportions_off'); }

  return { defects, score: Math.max(0, Math.round(score * 10) / 10), penalties, grid: g };
}
