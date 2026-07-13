/**
 * Offline tests for the geometry-contact connectivity audit
 * (`web/src/viewer/ldraw/connectivity-audit.ts`) — the engine behind the
 * LEGO tab's "Verify" control and `viewer.auditConnectivity()`.
 *
 * Fully offline + GPU-free: `fetch` is mocked to serve a synthetic flat-plate
 * `.dat`, resolved once through the real `resolvePartGeometry` path so the
 * audit reads the same part-geometry cache production does.
 *
 * The invariants under test (R = 4 LDU, contact tolerance ≈ one voxel):
 *   - pieces whose surfaces share / neighbour a voxel union into one component
 *   - pieces further apart than one voxel are detached
 *   - brick world rotation is applied to the surface points
 *   - report bookkeeping (largestPct, isDetached parallel array, detached
 *     component summaries) is consistent
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { auditConnectivity } from '../web/src/viewer/ldraw/connectivity-audit.js';
import { resolvePartGeometry } from '../web/src/viewer/ldraw/parts.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

// A flat 20×20 LDU square in the XZ plane at y=0 (one stud footprint).
const FIX: Record<string, string> = {
  cplate: '0 BFC CERTIFY CCW\n4 16 0 0 0  20 0 0  20 0 20  0 0 20',
};

let realFetch: typeof globalThis.fetch;
beforeAll(async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const stem = String(url).split('/').pop()!.replace(/\.dat$/i, '');
    if (stem in FIX) return new Response(FIX[stem], { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
  // Populate the module-level part-geometry cache the audit reads from.
  await resolvePartGeometry('cplate');
});
afterAll(() => { globalThis.fetch = realFetch; });

const brick = (x: number, y: number, z: number, rot?: number[]): ParsedBrick =>
  ({ color: 4, x, y, z, part: 'cplate.dat', ...(rot ? { rot } : {}) });

describe('auditConnectivity — component detection', () => {
  it('reports two touching pieces as one component', () => {
    // Same plane, overlapping in x — shared voxels.
    const rep = auditConnectivity([brick(0, 0, 0), brick(16, 0, 0)], 4);
    expect(rep.pieces).toBe(2);
    expect(rep.components).toBe(1);
    expect(rep.detached).toBe(0);
    expect(rep.largestPct).toBe(100);
    expect(rep.isDetached).toEqual([false, false]);
  });

  it('connects pieces one voxel apart (face-adjacency tolerance)', () => {
    // y=4 → voxel row 1 vs row 0: face-adjacent, within tolerance.
    const rep = auditConnectivity([brick(0, 0, 0), brick(0, 4, 0)], 4);
    expect(rep.components).toBe(1);
  });

  it('detaches pieces two voxels apart', () => {
    // y=8 → voxel row 2 vs row 0: beyond the one-voxel tolerance.
    const rep = auditConnectivity([brick(0, 0, 0), brick(0, 8, 0)], 4);
    expect(rep.components).toBe(2);
    expect(rep.detached).toBe(1);
  });

  it('flags a far-away piece as detached with a component summary', () => {
    const rep = auditConnectivity(
      [brick(0, 0, 0), brick(16, 0, 0), brick(500, 0, 0)],
      4,
    );
    expect(rep.pieces).toBe(3);
    expect(rep.components).toBe(2);
    expect(rep.largest).toBe(2);
    expect(rep.largestPct).toBeCloseTo(66.67, 1);
    expect(rep.isDetached).toEqual([false, false, true]);
    expect(rep.detachedComponents).toHaveLength(1);
    expect(rep.detachedComponents[0]).toMatchObject({
      size: 1,
      part: 'cplate.dat',
      pos: [500, 0, 0],
    });
  });

  it('applies brick rotation to the surface points', () => {
    // 90° about Z (row-major): world = (−ly + tx, lx + ty, lz + tz). The flat
    // plate (local y = 0) becomes a vertical wall at x = tx spanning
    // y ∈ [ty, ty+20]. At ty = −20 the wall's bottom edge reaches the base
    // plate's y = 0 plane → connected; the same placement WITHOUT rotation is
    // a flat plate hovering at y = −20 → detached. Only applied rotation
    // distinguishes the two.
    const rotZ90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const wall = auditConnectivity([brick(0, 0, 0), brick(8, -20, 0, rotZ90)], 4);
    expect(wall.components).toBe(1);
    const flat = auditConnectivity([brick(0, 0, 0), brick(8, -20, 0)], 4);
    expect(flat.components).toBe(2);
  });

  it('handles an empty model without crashing', () => {
    const rep = auditConnectivity([], 4);
    expect(rep.pieces).toBe(0);
    expect(rep.components).toBe(0);
    expect(rep.detached).toBe(0);
    expect(rep.largestPct).toBe(0);
    expect(rep.isDetached).toEqual([]);
  });
});
