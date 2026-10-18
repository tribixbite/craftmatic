/**
 * Geometry voxelizer (web/src/engine/ldraw-geometry.ts) — broad-phase guard.
 *
 * S3 (2026-09-01) added a per-triangle bounding-box bucket index so each
 * sweep ray only tests the triangles whose projected box covers it. That is
 * meant to be EXACTLY equivalent to the old O(rays × triangles) scan (the
 * Möller-Trumbore u/v test already rejects everything outside that box), so
 * the test voxelizes the same solid twice — once with a mesh below the
 * bucketing threshold and once with a finely subdivided mesh above it — and
 * asserts the two grids are identical, cell for cell and palette for palette.
 *
 * Offline + deterministic: `fetch` is mocked with synthetic `.dat` text
 * (same pattern as test/ldraw-geometry.test.ts). No network, no GPU, no DOM.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';

const CUBE_HALF = 20; // 40 LDU cube = 2 studs on a side

/** Axis-aligned cube as LDraw type-3 triangle lines, each face split N×N. */
function cubeDat(subdiv: number): string {
  const h = CUBE_HALF;
  const lines: string[] = ['0 Test Cube', '0 !LDRAW_ORG Unofficial_Part'];
  const tri = (a: number[], b: number[], c: number[]) =>
    lines.push(`3 16 ${a.join(' ')} ${b.join(' ')} ${c.join(' ')}`);

  // For each of the 6 axis-aligned faces, emit a subdiv×subdiv grid of quads.
  const faces: Array<[number, number]> = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
  for (const [axis, sign] of faces) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (let i = 0; i < subdiv; i++) {
      for (let j = 0; j < subdiv; j++) {
        const u0 = -h + (2 * h * i) / subdiv, u1 = -h + (2 * h * (i + 1)) / subdiv;
        const v0 = -h + (2 * h * j) / subdiv, v1 = -h + (2 * h * (j + 1)) / subdiv;
        const mk = (uu: number, vv: number) => {
          const p = [0, 0, 0];
          p[axis] = sign * h; p[u] = uu; p[v] = vv;
          return p;
        };
        tri(mk(u0, v0), mk(u1, v0), mk(u1, v1));
        tri(mk(u0, v0), mk(u1, v1), mk(u0, v1));
      }
    }
  }
  return lines.join('\n');
}

const DATS: Record<string, string> = {
  // 12 triangles → below the 24-triangle bucketing threshold (linear scan)
  'gtestcubelo': cubeDat(1),
  // 192 triangles → bucketed broad phase
  'gtestcubehi': cubeDat(4),
};

let realFetch: typeof globalThis.fetch | undefined;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const stem = url.replace(/^.*\//, '').replace(/\.dat$/i, '').toLowerCase();
    const text = DATS[stem];
    if (text === undefined) return new Response('not found', { status: 404 });
    return new Response(text, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterAll(() => { if (realFetch) globalThis.fetch = realFetch; });

function brick(part: string): ParsedBrick[] {
  return [{ part, color: 4, x: 0, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], step: 1 } as ParsedBrick];
}

describe('voxelizeLDrawGeometry broad phase', () => {
  it('bucketed and linear rasterization produce identical grids', async () => {
    const { voxelizeLDrawGeometry } = await import('../web/src/engine/ldraw-geometry.js');
    const opts = { cellLDU: 4, maxDim: 700 };

    const lo = await voxelizeLDrawGeometry(brick('gtestcubelo'), undefined, opts);
    const hi = await voxelizeLDrawGeometry(brick('gtestcubehi'), undefined, opts);

    expect(lo.fallbackPartCount).toBe(0);
    expect(hi.fallbackPartCount).toBe(0);
    expect([hi.grid.width, hi.grid.height, hi.grid.length])
      .toEqual([lo.grid.width, lo.grid.height, lo.grid.length]);
    expect(hi.grid.countNonAir()).toBe(lo.grid.countNonAir());
    expect([...hi.grid.palette.keys()]).toEqual([...lo.grid.palette.keys()]);

    for (let y = 0; y < lo.grid.height; y++)
      for (let z = 0; z < lo.grid.length; z++)
        for (let x = 0; x < lo.grid.width; x++)
          if (hi.grid.get(x, y, z) !== lo.grid.get(x, y, z)) {
            throw new Error(`cell mismatch at ${x},${y},${z}: ${hi.grid.get(x, y, z)} vs ${lo.grid.get(x, y, z)}`);
          }
  });

  it('voxelizes the 40 LDU cube as a solid 10×10×10 block at cellLDU 4', async () => {
    const { voxelizeLDrawGeometry } = await import('../web/src/engine/ldraw-geometry.js');
    const r = await voxelizeLDrawGeometry(brick('gtestcubehi'), undefined, { cellLDU: 4, maxDim: 700 });
    // 40 LDU / 4 = 10 cells per axis (±1 from boundary rounding).
    for (const d of [r.grid.width, r.grid.height, r.grid.length]) {
      expect(d).toBeGreaterThanOrEqual(10);
      expect(d).toBeLessThanOrEqual(12);
    }
    // Solid: essentially every cell in the box is filled.
    const total = r.grid.width * r.grid.height * r.grid.length;
    expect(r.grid.countNonAir()).toBeGreaterThan(total * 0.9);
    expect([...r.grid.palette.keys()]).toContain('minecraft:red_concrete');
  });
});
