/**
 * The scaled-grid tread planner restores a climb to a doorway's THRESHOLD
 * from either side (`planColliderTreads` `doorCells`, bedrock-collider-scale.ts).
 *
 * The planner restores only a surface the unassisted walk reaches by no route,
 * and a doorway's threshold is one surface for its two sides: once one side
 * has a way up (the model's own stair, an access stair), the other side's
 * climb was dropped. 31141's Door 2 read ONE-WAY from its front ledge at
 * 150-200 % after an access stair appeared behind it (2026-09-30). With the
 * doorway's cells named, every blocked rise from a reached surface into its
 * threshold is restored by the same rule, and the never-block check holds.
 */
import { describe, expect, it } from 'vitest';
import { planColliderTreads, walkScaledColliders, ScaledColliderGrid, type SourceCell } from '../web/src/engine/bedrock-collider-scale.js';

/** A column of full cells from the ground up to `top16` (sixteenths), across z 0..2. */
function column(x: number, top16: number): SourceCell[] {
  const out: SourceCell[] = [];
  for (let z = 0; z < 3; z++) for (let y = 0; y * 16 < top16; y++) out.push({ x, y, z, lo: 0, hi: Math.min(16, top16 - y * 16) });
  return out;
}

/**
 * Along x: the ground (x 0-1), a gentle stair up to the threshold (x 2-6, a
 * half block a step, walked at 200 % as whole-block hops), the doorway's
 * threshold at 3 blocks (x 7), a ledge a jump below it (x 8, 28/16) and the
 * ground again (x 9-11). The ledge is reached by dropping off the threshold.
 */
function doorwayScene(): { cells: SourceCell[]; door: number[][] } {
  const tops = [0, 0, 8, 16, 24, 32, 40, 48, 28, 0, 0, 0];
  const cells = tops.flatMap((t, x) => (t ? column(x, t) : []));
  // The closed leaf over the threshold (x 7), rows 3-5.
  const door = [0, 1, 2].flatMap(z => [3, 4, 5].map(y => [7, y, z, 0, 16]));
  return { cells, door };
}

describe('doorway thresholds in the scaled-grid tread planner', () => {
  const dims = { width: 12, height: 8, length: 3 };
  it('restores the climb from the ledge to a threshold the other side already reaches', () => {
    const { cells, door } = doorwayScene();
    const without = planColliderTreads(cells, dims, 200, 0);
    const withDoor = planColliderTreads(cells, dims, 200, 0, [], door);
    expect(withDoor.verified).toBe(true);
    expect(withDoor.blocks.length).toBeGreaterThan(without.blocks.length);
    // A run climbs to the threshold (at 200 %: 6 blocks, 96/16) from the ledge's side.
    expect(withDoor.runs.some(r => r.to.t === 96 && r.from.x > r.to.x)).toBe(true);
    expect(without.runs.some(r => r.to.t === 96 && r.from.x > r.to.x)).toBe(false);
  });
  it('never blocks: every surface reached without the doorway pass is reached with it', () => {
    const { cells, door } = doorwayScene();
    const plan = planColliderTreads(cells, dims, 200, 0, [], door);
    const bare = new ScaledColliderGrid(cells, dims, 2, 0);
    const before = walkScaledColliders(bare);
    const laid = new ScaledColliderGrid(cells, dims, 2, 0);
    for (const b of plan.blocks) laid.write(b.x, b.z, { row: b.y, lo: b.lo, hi: b.hi, src16: 0 });
    const after = walkScaledColliders(laid);
    const treadColumns = new Set(plan.runs.flatMap(r => r.columns.map(c => `${c.x},${c.z}`)));
    for (const k of before.visited) {
      if (after.visited.has(k)) continue;
      const { x, z } = bare.unkey(k);
      expect(treadColumns.has(`${x},${z}`), `lost ${JSON.stringify(bare.unkey(k))}`).toBe(true);
    }
  });
});
