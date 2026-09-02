/**
 * Seeded part geometry for the Minecraft export (2026-09-02).
 *
 * The export resolver (`engine/ldraw-geometry.ts`) has its own `.dat` text
 * cache, separate from the viewer's (`viewer/ldraw/parts.ts`) and, in the
 * export Worker, on a different thread — so exporting a model that was already
 * loaded and rendered re-downloaded its entire part library. `SchemWorkerInput
 * .datTexts` now carries the viewer's texts into the pipeline.
 *
 * What this proves, offline (mocked `fetch`, the pattern from
 * test/ldraw-geometry-voxelize.test.ts):
 *   1. A seeded model performs ZERO fetches, and produces byte-identical
 *      output to the same model resolved over the network.
 *   2. An unseeded model still fetches (no silent regression to empty geometry).
 *   3. A part that exists ONLY in the seed (`.io` CustomParts are exactly this)
 *      voxelizes from real triangles instead of the AABB box fallback.
 *   4. The "loading part geometry" phase reports real, advancing per-part
 *      progress instead of sitting at 0%.
 *
 * Every case uses a DISTINCT part name: the resolver's caches are module-level
 * and would otherwise leak one case's result into the next.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { runSchemPipeline, type SchemWorkerInput } from '../web/src/engine/schem-pipeline.js';
import { voxelizeLDrawGeometry, seedDatTexts } from '../web/src/engine/ldraw-geometry.js';
import { DEFAULT_SCHEM_SETTINGS } from '../web/src/engine/schem-settings.js';

const CUBE_HALF = 20; // 40 LDU cube = 2 studs on a side

/** Axis-aligned solid cube as LDraw type-3 triangle lines. */
function cubeDat(): string {
  const h = CUBE_HALF;
  const lines: string[] = ['0 Seed Test Cube', '0 !LDRAW_ORG Unofficial_Part'];
  const faces: Array<[number, number]> = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
  for (const [axis, sign] of faces) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const mk = (uu: number, vv: number) => {
      const p = [0, 0, 0];
      p[axis] = sign * h; p[u] = uu; p[v] = vv;
      return p.join(' ');
    };
    lines.push(`3 16 ${mk(-h, -h)} ${mk(h, -h)} ${mk(h, h)}`);
    lines.push(`3 16 ${mk(-h, -h)} ${mk(h, h)} ${mk(-h, h)}`);
  }
  return lines.join('\n');
}

const CUBE = cubeDat();

/**
 * Parts the mocked server knows about (everything else 404s). A few are served
 * with a deliberate DELAY to reproduce the concurrent-resolution race — see the
 * determinism test at the bottom.
 */
const SERVED: Record<string, { text: string; delayMs?: number }> = {
  seedcube_net:  { text: CUBE },
  seedcube_both: { text: CUBE },
  seedprog0: { text: CUBE }, seedprog1: { text: CUBE },
  seedprog2: { text: CUBE }, seedprog3: { text: CUBE },

  // Race fixture: two parents share one child, which itself wraps a grandchild.
  // The slow parent arrives while the child sits half-assembled in the cache.
  raceparent_fast: { text: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 racechild.dat' },
  raceparent_slow: { text: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 racechild.dat', delayMs: 30 },
  racechild:       { text: '1 16 0 0 0 1 0 0 0 1 0 0 0 1 racegrand.dat', delayMs: 15 },
  racegrand:       { text: CUBE, delayMs: 30 },
  // Same shape, resolved alone — the reference for one instance.
  racereference:   { text: CUBE },
};

let fetchCalls: string[] = [];
let realFetch: typeof globalThis.fetch | undefined;

beforeAll(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchCalls.push(url);
    const stem = url.replace(/^.*\//, '').replace(/\.dat$/i, '').toLowerCase();
    const hit = SERVED[stem];
    if (!hit) return new Response('not found', { status: 404 });
    if (hit.delayMs) await new Promise(r => setTimeout(r, hit.delayMs));
    return new Response(hit.text, { status: 200 });
  }) as typeof globalThis.fetch;
});

afterAll(() => { if (realFetch) globalThis.fetch = realFetch; });
beforeEach(() => { fetchCalls = []; });

function bricks(...parts: string[]): ParsedBrick[] {
  return parts.map((part, i) => ({
    part, color: 4, x: i * 60, y: 0, z: 0,
    rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], step: 1,
  } as ParsedBrick));
}

function job(parts: string[], datTexts?: Map<string, string | null>): SchemWorkerInput {
  return {
    source: {
      kind: 'bricks',
      bricks: bricks(...parts),
      colorSpace: 'ldraw',
      options: { cellLDU: 4, maxDim: 700 },
    },
    format: 'schem',
    profile: DEFAULT_SCHEM_SETTINGS.profile,
    lightFill: false,
    datTexts,
  };
}

describe('export geometry seeding', () => {
  it('seeded parts short-circuit every fetch and match the networked output byte for byte', async () => {
    // A: resolved over the (mocked) network.
    const net = await runSchemPipeline(job(['seedcube_net']));
    expect(fetchCalls.length).toBeGreaterThan(0);

    // B: same geometry under a name the server does NOT serve, seeded instead.
    fetchCalls = [];
    const seeded = await runSchemPipeline(
      job(['seedcube_seed'], new Map([['seedcube_seed', CUBE]])),
    );

    expect(fetchCalls).toEqual([]);
    expect(seeded.bytes).toBeDefined();
    expect(Array.from(seeded.bytes!)).toEqual(Array.from(net.bytes!));
    expect(seeded.nonAir).toBe(net.nonAir);
  });

  it('still fetches parts that are not in the seed', async () => {
    // The seed covers one part; the other must come off the wire.
    await runSchemPipeline(
      job(['seedcube_both', 'seedcube_seed2'], new Map([['seedcube_seed2', CUBE]])),
    );
    const stems = fetchCalls.map(u => u.replace(/^.*\//, '').replace(/\.dat$/i, ''));
    expect(stems).toContain('seedcube_both');
    expect(stems).not.toContain('seedcube_seed2');
  });

  it('a seed-only part voxelizes from real geometry instead of the AABB fallback', async () => {
    // This is the `.io` CustomParts case: the part exists nowhere in the
    // library, so before seeding the export fell back to a box fill.
    const fallback = await voxelizeLDrawGeometry(
      bricks('seedcustom_missing'), undefined, { cellLDU: 4, maxDim: 700 },
    );
    expect(fallback.fallbackPartCount).toBe(1);

    seedDatTexts([['seedcustom_present', CUBE]]);
    fetchCalls = [];
    const real = await voxelizeLDrawGeometry(
      bricks('seedcustom_present'), undefined, { cellLDU: 4, maxDim: 700 },
    );
    expect(fetchCalls).toEqual([]);
    expect(real.fallbackPartCount).toBe(0);
    expect(real.grid.countNonAir()).toBeGreaterThan(0);
  });

  it('never downgrades an already-resolved part to a known-missing one', async () => {
    seedDatTexts([['seeddowngrade', CUBE]]);
    seedDatTexts([['seeddowngrade', null]]);
    fetchCalls = [];
    const r = await voxelizeLDrawGeometry(
      bricks('seeddowngrade'), undefined, { cellLDU: 4, maxDim: 700 },
    );
    expect(r.fallbackPartCount).toBe(0);
  });

  it('reports advancing per-part progress while loading geometry', async () => {
    const ticks: Array<{ phase: string; pct?: number }> = [];
    await runSchemPipeline(
      job(['seedprog0', 'seedprog1', 'seedprog2', 'seedprog3']),
      (phase, pct) => ticks.push({ phase, pct }),
    );

    const geo = ticks.filter(t => t.phase === 'loading part geometry').map(t => t.pct!);
    // One tick per part plus the opening 0 — NOT a single stuck 0%.
    expect(geo.length).toBeGreaterThan(1);
    expect(geo[0]).toBe(0);
    expect(geo[geo.length - 1]).toBe(100);
    expect(geo).toEqual([...geo].sort((a, b) => a - b));

    // And the later phases are still announced, each with its own name.
    const phases = ticks.map(t => t.phase);
    expect(phases).toContain('voxelizing');
    expect(phases).toContain('closing surface holes');
    expect(phases).toContain('writing NBT');
  });

  it('geometry does not depend on fetch timing (concurrent-resolution race)', async () => {
    // `partGeomCache` is populated with the still-empty triangle array before a
    // part's sub-file references are appended (the cycle guard). A caller that
    // read the cache in that window copied a HALF-ASSEMBLED part into its
    // parent — so the same model voxelized differently over a warm cache than
    // over the network (measured on 21063: 1,184,777 vs 1,174,763 non-air
    // cells, and 4,474 cells of real geometry silently lost even cold). The
    // in-flight promise is now checked first, so both parents get the complete
    // child no matter when they ask for it.
    const one = await voxelizeLDrawGeometry(
      bricks('racereference'), undefined, { cellLDU: 4, maxDim: 700 },
    );
    // Two parents of identical shape, resolved CONCURRENTLY, one arriving late.
    // Offsets are multiples of the cell size so instances rasterize identically.
    const pair = await voxelizeLDrawGeometry(
      [
        { part: 'raceparent_fast', color: 4, x: 0, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], step: 1 },
        { part: 'raceparent_slow', color: 4, x: 200, y: 0, z: 0, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], step: 1 },
      ] as ParsedBrick[],
      undefined, { cellLDU: 4, maxDim: 700 },
    );

    expect(one.fallbackPartCount).toBe(0);
    expect(pair.fallbackPartCount).toBe(0);
    expect(one.grid.countNonAir()).toBeGreaterThan(0);
    expect(pair.grid.countNonAir()).toBe(one.grid.countNonAir() * 2);
  });
});
