/**
 * The "minifig hair floats above the head" regression (2026-09-08).
 *
 * ROOT CAUSE, measured on 76416-1 with `scripts/_hair_probe.ts`: LDraw authors a
 * hairpiece so its socket clears the head stud — 62810's underside sits 1.81 LDU
 * above the head's crown, 25972's 0.26 LDU. A 4-LDU export cell cannot represent
 * a gap that small, and the rounding puts the hair's shell one row ABOVE and one
 * column OUTSIDE the head's top row: the two footprints then meet only
 * DIAGONALLY (minimum Chebyshev distance 1, no shared face), which in Minecraft
 * reads as a hat hovering over the head. Nothing closed it — `fillSingleVoxelGaps`
 * only fills X/Z runs flanked on both sides and has no vertical pass at all.
 *
 * `bridgePartContacts` (engine/ldraw-geometry.ts) welds exactly that case. These
 * tests pin the behaviour AND its limits, on a synthetic head+hair whose numbers
 * mirror the measured ones:
 *   • a 2-LDU clearance (half a cell) is closed → one connected component;
 *   • a 3-LDU clearance (representable at this cell size, so a REAL gap) is
 *     left alone → still two components;
 *   • parts a stud apart are never fused;
 *   • the pass only ever ADDS cells — nothing is deleted or moved.
 *
 * Offline: `fetch` is mocked to serve synthetic `.dat` boxes. Every case uses
 * DISTINCT part names — the resolver's caches are module-level.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { voxelizeLDrawGeometry } from '../web/src/engine/ldraw-geometry.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import type { BlockGrid } from '@craft/schem/types.js';

// ─── Synthetic parts ─────────────────────────────────────────────────────────

/** Axis-aligned box as LDraw type-4 quads. LDraw Y is DOWN. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): string {
  const L: string[] = [];
  const q = (a: number[], b: number[], c: number[], d: number[]) =>
    L.push(`4 16 ${a.join(' ')} ${b.join(' ')} ${c.join(' ')} ${d.join(' ')}`);
  q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  q([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]);
  q([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]);
  q([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  q([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]);
  q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  return L.join('\n');
}

/** Minifig head stand-in: 24-LDU body with its top face at y=0, plus a stud. */
const HEAD = [box(-12, 12, 0, 24, -12, 12), box(-6, 6, -4, 0, -6, 6)].join('\n');

/**
 * Hairpiece stand-in: a hollow cap whose brim hangs OUTSIDE the head (inner
 * radius 15 > the head's 12) and whose underside is `clearance` LDU above the
 * head's stud top — exactly the geometry that produces a diagonal-only touch.
 */
function hair(clearance: number): string {
  const bottom = -4 - clearance;   // head stud top is at y = -4
  const IN = 15, OUT = 20;
  return [
    box(-OUT, -IN, bottom - 24, bottom, -OUT, OUT),
    box(IN, OUT, bottom - 24, bottom, -OUT, OUT),
    box(-OUT, OUT, bottom - 24, bottom, -OUT, -IN),
    box(-OUT, OUT, bottom - 24, bottom, IN, OUT),
    box(-OUT, OUT, bottom - 28, bottom - 24, -OUT, OUT),   // top cap
  ].join('\n');
}

const FIX: Record<string, string> = {
  // Case 1 — sub-cell clearance (the bug).
  bridgehead2: HEAD, bridgehair2: hair(2),
  // Case 2 — a real, representable gap.
  bridgehead3: HEAD, bridgehair3: hair(3),
  // Case 3 — two separate objects.
  bridgehead4: HEAD, bridgehead5: HEAD,
};

let realFetch: typeof globalThis.fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const stem = String(url).split('/').pop()!.replace(/\.dat$/i, '').toLowerCase();
    return stem in FIX ? new Response(FIX[stem], { status: 200 }) : new Response('', { status: 404 });
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

// ─── helpers ─────────────────────────────────────────────────────────────────

const brick = (part: string, x = 0, y = 0, z = 0, color = 15): ParsedBrick => ({ color, x, y, z, part });

/** Number of 6-connected non-air components — the "is it floating?" measure. */
function componentCount(grid: BlockGrid): number {
  const { width: W, height: H, length: L } = grid;
  const seen = new Uint8Array(W * H * L);
  const idx = (x: number, y: number, z: number) => (x * H + y) * L + z;
  const solid = (x: number, y: number, z: number) => grid.get(x, y, z) !== 'minecraft:air';
  let n = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
    if (seen[idx(x, y, z)] || !solid(x, y, z)) continue;
    n++;
    const stack: Array<[number, number, number]> = [[x, y, z]];
    seen[idx(x, y, z)] = 1;
    while (stack.length) {
      const [cx, cy, cz] = stack.pop()!;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy, nz = cz + dz;
        if (nx < 0 || ny < 0 || nz < 0 || nx >= W || ny >= H || nz >= L) continue;
        const i = idx(nx, ny, nz);
        if (seen[i] || !solid(nx, ny, nz)) continue;
        seen[i] = 1; stack.push([nx, ny, nz]);
      }
    }
  }
  return n;
}

/** Every solid cell of `a` must still be solid in `b` (same dims). */
function keepsEverySolidCell(a: BlockGrid, b: BlockGrid): boolean {
  if (a.width !== b.width || a.height !== b.height || a.length !== b.length) return false;
  for (let x = 0; x < a.width; x++) for (let y = 0; y < a.height; y++) for (let z = 0; z < a.length; z++) {
    if (a.get(x, y, z) !== 'minecraft:air' && b.get(x, y, z) === 'minecraft:air') return false;
  }
  return true;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('inter-part contact pass (floating hair)', () => {
  it('reproduces the bug with the pass OFF: hair is its own component', async () => {
    const bricks = [brick('bridgehead2.dat'), brick('bridgehair2.dat', 0, 0, 0, 0)];
    const r = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4, bridgeParts: false });
    expect(componentCount(r.grid)).toBe(2);
    expect(r.bridge).toBeUndefined();
  });

  it('welds a sub-cell clearance: one component, cells only added', async () => {
    const bricks = [brick('bridgehead2.dat'), brick('bridgehair2.dat', 0, 0, 0, 0)];
    const off = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4, bridgeParts: false });
    const on  = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4, bridgeParts: true });

    expect(componentCount(on.grid)).toBe(1);
    expect(on.bridge?.nearPairs).toBe(1);
    expect(on.bridge?.bridgedPairs).toBe(1);
    expect(on.bridge!.cellsAdded).toBeGreaterThan(0);
    // Additive only — no cell is deleted or moved.
    expect(on.grid.countNonAir()).toBe(off.grid.countNonAir() + on.bridge!.cellsAdded);
    expect(keepsEverySolidCell(off.grid, on.grid)).toBe(true);
  });

  it('leaves a REAL gap alone (3 LDU is representable at a 4-LDU cell)', async () => {
    const bricks = [brick('bridgehead3.dat'), brick('bridgehair3.dat', 0, 0, 0, 0)];
    const r = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4, bridgeParts: true });
    expect(r.bridge?.bridgedPairs).toBe(0);
    expect(r.bridge?.cellsAdded).toBe(0);
    expect(componentCount(r.grid)).toBe(2);
  });

  it('never fuses genuinely separate objects (two heads a stud apart)', async () => {
    const bricks = [brick('bridgehead4.dat'), brick('bridgehead5.dat', 60, 0, 0)];
    const r = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4, bridgeParts: true });
    expect(r.bridge?.bridgedPairs).toBe(0);
    expect(r.bridge?.cellsAdded).toBe(0);
    expect(componentCount(r.grid)).toBe(2);
  });

  it('is on by default (no option passed)', async () => {
    const bricks = [brick('bridgehead2.dat'), brick('bridgehair2.dat', 0, 0, 0, 0)];
    const r = await voxelizeLDrawGeometry(bricks, undefined, { cellLDU: 4 });
    expect(r.bridge?.bridgedPairs).toBe(1);
    expect(componentCount(r.grid)).toBe(1);
  });
});
