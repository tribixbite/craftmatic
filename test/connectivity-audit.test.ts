/**
 * Offline tests for the contact-candidate audit
 * (`web/src/viewer/ldraw/connectivity-audit.ts`) — the engine behind the
 * LEGO tab's "Verify" control and `viewer.auditConnectivity()`.
 *
 * Fully offline + GPU-free: `fetch` is mocked to serve synthetic `.dat` files,
 * resolved once through the real `resolvePartGeometry` path so the audit reads
 * the same part-geometry cache production does.
 *
 * The invariants under test (R = 4 LDU, contact tolerance ≈ one voxel):
 *   - pieces whose surfaces share / neighbour a voxel union into one component
 *   - pieces further apart than one voxel are detached
 *   - brick world rotation is applied to the surface points
 *   - report bookkeeping (largestPct, isDetached parallel array, detached
 *     component summaries) is consistent
 *
 * Plus the honesty cases the 2026-09-08 audit asked for (P1 #5): a real gap
 * closed by the tolerance is DISCLOSED rather than hidden; missing geometry is
 * separated from genuine detachment; a deliberately separate sub-build is
 * separated from a mid-air fragment; and the LDCad attachment metadata unions
 * a hair-on-head joint that surface contact alone misses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  auditConnectivity, snapsForPart,
} from '../web/src/viewer/ldraw/connectivity-audit.js';
import { resolvePartGeometry } from '../web/src/viewer/ldraw/parts.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

// A flat 20×20 LDU square in the XZ plane at y=0 (one stud footprint).
const square = (y: number) =>
  `0 BFC CERTIFY CCW\n4 16 0 ${y} 0  20 ${y} 0  20 ${y} 20  0 ${y} 20`;
const FIX: Record<string, string> = {
  cplate: square(0),
  // Minifig head + hair, with their surfaces deliberately 40 LDU apart so ONLY
  // the attachment metadata can join them (head stud and hair socket are both
  // at the part origin, so the two snaps coincide when both are placed at the
  // same world position).
  '3626b': square(0),
  '3901': square(-40),
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
  for (const stem of Object.keys(FIX)) await resolvePartGeometry(stem);
});
afterAll(() => { globalThis.fetch = realFetch; });

const brick = (x: number, y: number, z: number, rot?: number[]): ParsedBrick =>
  ({ color: 4, x, y, z, part: 'cplate.dat', ...(rot ? { rot } : {}) });
const partAt = (part: string, x: number, y: number, z: number): ParsedBrick =>
  ({ color: 4, x, y, z, part: `${part}.dat` });

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

describe('disclosed limits — the audit must not overstate what it measured', () => {
  it('reports the tolerance that closed a real gap (near-gap false positive)', () => {
    // A designed 4 LDU gap is INSIDE the face-adjacency tolerance, so these two
    // read as one component even though they do not touch. The report has to
    // carry the tolerance that produced the verdict, or "1 component" is a
    // claim the data does not support.
    const rep = auditConnectivity([brick(0, 0, 0), brick(0, 4, 0)], 4);
    expect(rep.components).toBe(1);
    expect(rep.toleranceLDU).toBe(4);
    expect(rep.resolutionLDU).toBe(4);
    // At a finer resolution the same gap is resolved as a real separation.
    expect(auditConnectivity([brick(0, 0, 0), brick(0, 4, 0)], 1).components).toBe(2);
  });

  it('separates pieces with no resolved geometry from genuine floaters', () => {
    // 'nosuch' 404s, so it has no surface: it cannot touch anything and nothing
    // can touch it. Counting it as a floater would be a claim about a model
    // that was never loaded.
    const rep = auditConnectivity([
      brick(0, 0, 0), brick(16, 0, 0),
      { color: 4, x: 0, y: 0, z: 0, part: 'nosuch.dat' },
    ], 4);
    expect(rep.piecesWithoutGeometry).toBe(1);
    expect(rep.detachedWithoutGeometry).toBe(1);
    // …and subtracting it leaves nothing unexplained.
    expect(rep.detached - rep.detachedWithoutGeometry).toBe(0);
  });

  it('reports snap-table coverage instead of implying completeness', () => {
    const rep = auditConnectivity([brick(0, 0, 0), partAt('3626b', 0, 0, 0)], 4);
    expect(rep.snapTable.parts).toBeGreaterThan(300);
    expect(rep.snapTable.connectors).toBeGreaterThan(rep.snapTable.parts);
    // cplate is not a real mould and carries no attachment metadata; the head does.
    expect(rep.piecesWithSnaps).toBe(1);
  });
});

describe('detached-group classification (grounded vs airborne)', () => {
  // A two-plate main structure sitting on the floor plane at y = 0.
  const main = (): ParsedBrick[] => [brick(0, 0, 0), brick(0, -4, 0)];

  it('calls a separate sub-build standing on the same floor "grounded"', () => {
    const rep = auditConnectivity([...main(), brick(400, 0, 0)], 4);
    expect(rep.components).toBe(2);
    expect(rep.detachedComponents[0]!.kind).toBe('grounded');
    expect(rep.detachedComponents[0]!.heightAboveFloorLDU).toBe(0);
    expect(rep.groundedDetached).toBe(1);
    expect(rep.airborneDetached).toBe(0);
  });

  it('calls a piece hanging far above everything "airborne"', () => {
    // LDraw +Y is DOWN, so y = -400 is 400 LDU above the floor.
    const rep = auditConnectivity([...main(), brick(400, -400, 0)], 4);
    const d = rep.detachedComponents[0]!;
    expect(d.kind).toBe('airborne');
    expect(d.heightAboveFloorLDU).toBeGreaterThan(48);
    expect(d.supportGapLDU).toBe(Infinity);
    expect(rep.airborneDetached).toBe(1);
  });

  it('calls a piece resting just above real support "grounded", not floating', () => {
    // 8 LDU above the main stack, in the same column: beyond the contact
    // tolerance (so still a separate component) but inside the 12 LDU support
    // gap, which is the class a clip/pin joint lands in.
    const rep = auditConnectivity([...main(), brick(0, -12, 0)], 4);
    expect(rep.components).toBe(2);
    const d = rep.detachedComponents[0]!;
    expect(d.kind).toBe('grounded');
    expect(d.supportGapLDU).toBeLessThan(12);
  });

  it('orders airborne groups before grounded ones', () => {
    const rep = auditConnectivity([
      ...main(),
      brick(400, 0, 0), brick(420, 0, 0),   // grounded pair
      brick(800, -400, 0),                  // single airborne
    ], 4);
    expect(rep.detachedComponents.map(d => d.kind)).toEqual(['airborne', 'grounded']);
    expect(rep.groundedDetached).toBe(1);
    expect(rep.airborneDetached).toBe(1);
  });
});

describe('attachment metadata (the snap half of the hybrid)', () => {
  it('resolves a printed variant through its base mould', () => {
    expect(snapsForPart('3626bpb01').length).toBeGreaterThan(0);
    expect(snapsForPart('bl_3626b').length).toBeGreaterThan(0);
    expect(snapsForPart('nosuchpart').length).toBe(0);
  });

  it('joins hair to a head that surface contact alone reports as detached', () => {
    // Surfaces 40 LDU apart → no voxel contact anywhere. The head's top stud
    // and the hair's socket are both at the part origin, so placing both at the
    // same world position makes the two connectors coincide.
    const rep = auditConnectivity([partAt('3626b', 0, 0, 0), partAt('3901', 0, 0, 0)], 4);
    expect(rep.components).toBe(1);
    expect(rep.snapOnlyUnions).toBe(1);
    expect(rep.piecesWithSnaps).toBe(2);
  });

  it('does NOT join hair displaced from the head (the reported defect class)', () => {
    // 20 LDU off: past the 8 LDU coincidence tolerance, so no snap match and no
    // surface contact — exactly what a hair piece with a wrong local origin
    // should look like.
    const rep = auditConnectivity([partAt('3626b', 0, 0, 0), partAt('3901', 0, -20, 0)], 4);
    expect(rep.components).toBe(2);
    expect(rep.snapOnlyUnions).toBe(0);
  });

  it('leaves a model with no table coverage exactly as the surface test found it', () => {
    const rep = auditConnectivity([brick(0, 0, 0), brick(500, 0, 0)], 4);
    expect(rep.piecesWithSnaps).toBe(0);
    expect(rep.snapOnlyUnions).toBe(0);
    expect(rep.components).toBe(2);
  });
});
