/**
 * Geometry-level regression tests for the LDraw geometry-assembly layer
 * (`resolvePartGeometry` in viewer/ldraw/parts.ts).
 *
 * This is the de-risked, GPU-free form of visual regression: it asserts the
 * deterministic geometry SIGNATURE (triangle/edge counts, vertex winding,
 * transformed positions, bounding box) that the renderer builds its meshes
 * from. If `.dat` parsing, BFC winding, det<0 handling, or sub-part transform
 * composition regress, these counts/positions shift — without needing a
 * headless WebGL context.
 *
 * Fully offline: global `fetch` is mocked to serve synthetic `.dat` fixtures,
 * so no LDraw library / network is involved. All expected values are
 * hand-derived from the parser in parts.ts.
 *
 * NOTE: resolvePartGeometry caches by part id and IGNORES the invertWinding
 * argument, so a sub-part resolved inverted once is reused inverted elsewhere.
 * The invert/det cases below therefore use DISTINCT sub-part names to stay
 * order-independent. (That cache behaviour is a real production subtlety —
 * a part used both normally and mirrored would share one winding.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolvePartGeometry, preloadDatTexts, clearMpdInlines } from '../web/src/viewer/ldraw/parts.js';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import type { Triangle } from '../web/src/viewer/ldraw/types.js';

// ─── Synthetic .dat fixtures (served via the mocked fetch) ────────────────────

const FIX: Record<string, string> = {
  // Single CCW triangle in the X/Z plane.
  gtri: '0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10',
  // One quad → must split into two triangles [v0,v1,v2] + [v0,v2,v3].
  gquad: '0 BFC CERTIFY CCW\n4 16 0 0 0  10 0 0  10 0 10  0 0 10',
  // Type-2 (edge) colour routing: 24 → shared edges, 4 → colour edges.
  gedge: '2 24 0 0 0  10 0 0\n2 4 0 0 0  0 10 0',
  // Type-5 optional line → treated as an edge.
  g5: '5 24 0 0 0  10 0 0  5 5 5  6 6 6',
  // Same triangle but CW winding → vertex order flips vs gtri.
  gcw: '0 BFC CERTIFY CW\n3 16 0 0 0  10 0 0  0 0 10',
  // Colour routing for triangles: 16 → tris, 4 → colorTris.
  gcolor: '0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10\n3 4 0 0 0  10 0 0  0 0 10',
  // Sub-part reference translated +100 in X (det>0, no winding flip).
  gsub: '1 16 100 0 0  1 0 0  0 1 0  0 0 1 gtri.dat',
  // Distinct CCW triangles for the invert/det cases (avoid cache sharing).
  gtri_inv: '0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10',
  gtri_det: '0 BFC CERTIFY CCW\n3 16 0 0 0  10 0 0  0 0 10',
  // INVERTNEXT flips the referenced sub-part's winding.
  ginv: '0 BFC CERTIFY CCW\n0 BFC INVERTNEXT\n1 16 0 0 0  1 0 0  0 1 0  0 0 1 gtri_inv.dat',
  // Reflection transform (det = -1) also flips winding; then mirrors X.
  gdet: '0 BFC CERTIFY CCW\n1 16 0 0 0  -1 0 0  0 1 0  0 0 1 gtri_det.dat',
};

let realFetch: typeof globalThis.fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const stem = String(url).split('/').pop()!.replace(/\.dat$/i, '');
    if (stem in FIX) return new Response(FIX[stem], { status: 200 });
    return new Response('', { status: 404 }); // definitive miss → fast EMPTY
  }) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Normalise -0 → 0 so toEqual on transformed coords is stable. */
const clean = (tris: Triangle[]): number[][][] =>
  tris.map((t) => t.map((v) => v.map((c) => c + 0)));

function bbox(tris: Triangle[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let i = 0; i < 3; i++) {
    if (v[i] < min[i]) min[i] = v[i];
    if (v[i] > max[i]) max[i] = v[i];
  }
  return { min, max };
}

/** Apply a row-major 3×3 R + translation T to a point (mirrors parts.ts applyMat). */
const applyMat = (v: number[], R: number[], T: number[]): number[] => [
  R[0] * v[0] + R[1] * v[1] + R[2] * v[2] + T[0],
  R[3] * v[0] + R[4] * v[1] + R[5] * v[2] + T[1],
  R[6] * v[0] + R[7] * v[1] + R[8] * v[2] + T[2],
];

// ─── primitive parsing ─────────────────────────────────────────────────────────

describe('resolvePartGeometry — primitive parsing', () => {
  it('parses a single CCW triangle (type 3) into one tri', async () => {
    const g = await resolvePartGeometry('gtri');
    expect(g.tris).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
    expect(clean(g.tris)[0]).toEqual([[0, 0, 0], [10, 0, 0], [0, 0, 10]]);
    expect(bbox(g.tris)).toEqual({ min: [0, 0, 0], max: [10, 0, 10] });
  });

  it('splits a quad (type 4) into two triangles [v0,v1,v2] + [v0,v2,v3]', async () => {
    const g = await resolvePartGeometry('gquad');
    expect(g.tris).toHaveLength(2);
    expect(clean(g.tris)).toEqual([
      [[0, 0, 0], [10, 0, 0], [10, 0, 10]],
      [[0, 0, 0], [10, 0, 10], [0, 0, 10]],
    ]);
  });

  it('routes type-2 edges by colour (24/16 → edges, explicit → colorEdges)', async () => {
    const g = await resolvePartGeometry('gedge');
    expect(g.edges).toHaveLength(1);
    expect(g.colorEdges.get(4)).toHaveLength(1);
  });

  it('treats a type-5 optional line as an edge', async () => {
    const g = await resolvePartGeometry('g5');
    expect(g.edges).toHaveLength(1);
    expect(g.tris).toHaveLength(0);
  });
});

// ─── winding ────────────────────────────────────────────────────────────────────

describe('resolvePartGeometry — BFC winding', () => {
  it('CW certification flips the triangle vertex order vs CCW', async () => {
    const ccw = await resolvePartGeometry('gtri');
    const cw = await resolvePartGeometry('gcw');
    // CCW: [v0,v1,v2]; CW: [v0,v2,v1]
    expect(clean(ccw.tris)[0]).toEqual([[0, 0, 0], [10, 0, 0], [0, 0, 10]]);
    expect(clean(cw.tris)[0]).toEqual([[0, 0, 0], [0, 0, 10], [10, 0, 0]]);
  });

  it('BFC INVERTNEXT flips the referenced sub-part winding', async () => {
    const g = await resolvePartGeometry('ginv');
    expect(g.tris).toHaveLength(1);
    // gtri_inv is CCW; INVERTNEXT inverts it → [v0,v2,v1], identity transform.
    expect(clean(g.tris)[0]).toEqual([[0, 0, 0], [0, 0, 10], [10, 0, 0]]);
  });

  it('a det<0 (reflection) transform flips winding AND mirrors the geometry', async () => {
    const g = await resolvePartGeometry('gdet');
    expect(g.tris).toHaveLength(1);
    // gtri_det CCW → det<0 inverts to [v0,v2,v1], then X is mirrored (×-1).
    const inv = [[0, 0, 0], [0, 0, 10], [10, 0, 0]];
    const R = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(clean(g.tris)[0]).toEqual(inv.map((v) => applyMat(v, R, [0, 0, 0]).map((c) => c + 0)));
  });
});

// ─── colour routing & sub-part transforms ────────────────────────────────────────

describe('resolvePartGeometry — colour routing & sub-parts', () => {
  it('routes colour-16 tris to .tris and explicit colours to .colorTris', async () => {
    const g = await resolvePartGeometry('gcolor');
    expect(g.tris).toHaveLength(1);
    expect(g.colorTris.get(4)).toHaveLength(1);
  });

  it('applies the sub-part transform (R·v + T) to recursed geometry', async () => {
    const g = await resolvePartGeometry('gsub');
    expect(g.tris).toHaveLength(1);
    // gtri translated +100 X.
    expect(clean(g.tris)[0]).toEqual([[100, 0, 0], [110, 0, 0], [100, 0, 10]]);
  });

  it('returns empty geometry for a part that does not resolve', async () => {
    const g = await resolvePartGeometry('gdoesnotexist');
    expect(g.tris).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });
});

// ─── preloaded archive part definitions (.io CustomParts) ───────────────────────

describe('preloadDatTexts — archive-bundled part definitions', () => {
  it('resolves a custom part from a preloaded definition without fetching', async () => {
    preloadDatTexts(new Map([
      ['mcustom_123_456.dat', '0 BFC CERTIFY CCW\n3 16 0 0 0  4 0 0  0 0 4'],
    ]));
    const g = await resolvePartGeometry('mcustom_123_456');
    expect(g.tris).toHaveLength(1);
    clearMpdInlines(); // model-specific — clean up
  });

  it('registers every path suffix so prefixed primitive refs resolve', async () => {
    preloadDatTexts(new Map([
      ['p/48/zz-testprim.dat', '3 16 0 0 0  2 0 0  0 0 2'],
    ]));
    // A part may reference it as `48\zz-testprim.dat` OR bare `zz-testprim.dat`.
    const viaSubdir = await resolvePartGeometry('48/zz-testprim');
    const viaBare = await resolvePartGeometry('zz-testprim');
    expect(viaSubdir.tris).toHaveLength(1);
    expect(viaBare.tris).toHaveLength(1);
    clearMpdInlines();
  });

  it('clearMpdInlines evicts preloaded definitions (model-specific lifecycle)', async () => {
    preloadDatTexts(new Map([['mgone_1_2.dat', '3 16 0 0 0 1 0 0 0 0 1']]));
    clearMpdInlines();
    const g = await resolvePartGeometry('mgone_1_2'); // now falls through to fetch → 404 → empty
    expect(g.tris).toHaveLength(0);
  });
});

// ─── full-model geometry signature ──────────────────────────────────────────────

describe('model geometry signature (parser + parts + world transform)', () => {
  it('produces a stable triangle count and bounding box for a 2-brick model', async () => {
    const mpd = [
      '0 FILE model.ldr',
      '1 16 0 0 0   1 0 0 0 1 0 0 0 1 gtri.dat',  // 1 tri at origin
      '1 16 100 0 0 1 0 0 0 1 0 0 0 1 gquad.dat', // 2 tris at +100 X
    ].join('\n');

    const bricks = parseLDraw(mpd);
    expect(bricks).toHaveLength(2);

    // Mirror what the viewer does: resolve each part's local geometry and place
    // it by the brick's world rotation+position.
    const worldTris: Triangle[] = [];
    for (const b of bricks) {
      const geom = await resolvePartGeometry(b.part);
      const R = b.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
      const T = [b.x, b.y, b.z];
      for (const t of geom.tris) {
        worldTris.push(t.map((v) => applyMat(v, R, T)) as unknown as Triangle);
      }
    }

    expect(worldTris).toHaveLength(3); // 1 (gtri) + 2 (gquad)
    expect(bbox(worldTris)).toEqual({ min: [0, 0, 0], max: [110, 0, 10] });
  });
});
