/**
 * The add-on walk's reach verdicts, off the main thread. `reachPoint`
 * (engine/addon-walk.ts) answers "can a player get here on foot?" for a model
 * point with the reach walk AND the simulated player, and the simulation is
 * what costs: on 10303 it measured 0.07 s at 150 %, 0.6 s at 200 %, 2.8 s at
 * 300 % and 6.7 s at 400 % (2026-09-22). Run inline that would freeze the
 * walk's frame loop for as long on every size change, so the preview posts
 * the pack's cells here, builds the same world, and paints the verdicts when
 * they arrive. Pure input, pure output: nothing here touches the DOM.
 */
import { buildWalkWorld, reachPoint, type PointReach } from '@engine/addon-walk.js';
import type { GridDims, QuarterTurn, ReachTarget, SourceCell, TreadBlock } from '@engine/bedrock-collider-scale.js';

export interface ReachWorkerRequest {
  id: number;
  cells: SourceCell[];
  dims: GridDims;
  sizePct: number;
  rotation: QuarterTurn;
  treads: TreadBlock[];
  targets: ReachTarget[];
}

export interface ReachWorkerResponse {
  id: number;
  results: PointReach[];
  /** Wall time of the whole job, ms, for the HUD's honesty line. */
  ms: number;
  error?: string;
}

/** The verdicts for one request; shared by the worker and the inline fallback so both give the same answer. */
export function answerReachRequest(req: ReachWorkerRequest): ReachWorkerResponse {
  const t0 = performance.now();
  try {
    const world = buildWalkWorld({ cells: req.cells, dims: req.dims, sizePct: req.sizePct, rotation: req.rotation, treads: req.treads });
    const results = req.targets.map(t => reachPoint(world, t));
    return { id: req.id, results, ms: performance.now() - t0 };
  } catch (err) {
    return { id: req.id, results: [], ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

// Worker entry: only when running as one (the inline fallback imports this module on the page).
if (typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function') {
  self.onmessage = (e: MessageEvent<ReachWorkerRequest>) => { (self as unknown as Worker).postMessage(answerReachRequest(e.data)); };
}
