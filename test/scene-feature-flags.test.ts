/**
 * Tests for SceneFeatureFlags gating in scene-pipeline.ts and
 * the skip parameter in scene-enrichment.ts enrichForScene().
 *
 * Uses mock fetch to verify API calls are skipped when features are disabled,
 * and uses real BlockGrid instances to verify environment sections are gated.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import type { SceneFeatureFlags } from '../src/convert/scene-pipeline.js';

// ── Mock fetch globally to prevent real API calls ──────────────────────────

let fetchCallUrls: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCallUrls = [];
  // Mock fetch: return empty valid responses for all endpoints
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCallUrls.push(url);

    // Overpass API — return empty elements
    if (url.includes('overpass')) {
      return new Response(JSON.stringify({ elements: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // ESA WorldCover GeoTIFF — return 404 (triggers fallback)
    if (url.includes('esa-worldcover')) {
      return new Response('', { status: 404 });
    }
    // Default: 404
    return new Response('', { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── Helper: create a small test grid with a building block ─────────────────

function makeTestGrid(w = 32, h = 16, l = 32): BlockGrid {
  const grid = new BlockGrid(w, h, l);
  // Place a small building in the center so classifyGrid finds building bounds
  const cx = Math.floor(w / 2);
  const cz = Math.floor(l / 2);
  for (let y = 0; y < 6; y++) {
    for (let dx = -3; dx <= 3; dx++) {
      for (let dz = -3; dz <= 3; dz++) {
        // Shell: only place walls on edges, floor on y=0, roof on y=5
        const isEdge = Math.abs(dx) === 3 || Math.abs(dz) === 3 || y === 0 || y === 5;
        if (isEdge) {
          grid.set(cx + dx, y, cz + dz, 'minecraft:stone_bricks');
        }
      }
    }
  }
  return grid;
}

// ── enrichForScene skip parameter tests ────────────────────────────────────

describe('enrichForScene skip parameter', () => {
  it('skips Overpass infrastructure query when skip.infrastructure is true', async () => {
    const { enrichForScene } = await import('../src/convert/scene-enrichment.js');
    const result = await enrichForScene(37.75, -122.43, 40, undefined, {
      infrastructure: true,
      trees: true,
      landcover: true,
    });
    // No Overpass calls should be made at all
    const overpassCalls = fetchCallUrls.filter(u => u.includes('overpass'));
    expect(overpassCalls).toHaveLength(0);
    // Should still return valid enrichment with no API-sourced data
    expect(result.roads).toEqual([]);
    expect(result.paths).toEqual([]);
    expect(result.fences).toEqual([]);
    // Note: trees may still contain synthetic scatter (supplement runs when
    // OSM returns < 3 trees), so we only verify the API was not called
  });

  it('makes Overpass calls when skip is not provided', async () => {
    const { enrichForScene } = await import('../src/convert/scene-enrichment.js');
    await enrichForScene(37.75, -122.43, 40);
    // Should make at least 2 Overpass calls (infrastructure + trees)
    const overpassCalls = fetchCallUrls.filter(u => u.includes('overpass'));
    expect(overpassCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('skips only trees when skip.trees is true', async () => {
    const { enrichForScene } = await import('../src/convert/scene-enrichment.js');
    await enrichForScene(37.75, -122.43, 40, undefined, {
      infrastructure: false,
      trees: true,
      landcover: false,
    });
    // Infrastructure query should still happen (1 call)
    // Trees query should be skipped
    // Both go to overpass, but infrastructure queries for ways, trees for nodes
    const overpassCalls = fetchCallUrls.filter(u => u.includes('overpass'));
    // Should have exactly 1 call (infrastructure only, tree query skipped)
    expect(overpassCalls).toHaveLength(1);
  });

  it('returns synthetic trees when OSM trees are skipped', async () => {
    const { enrichForScene } = await import('../src/convert/scene-enrichment.js');
    const result = await enrichForScene(37.75, -122.43, 40, undefined, {
      trees: true,  // skip OSM tree query
    });
    // With 0 OSM trees + skip, synthetic scatter fills in (< 3 triggers supplement)
    // But since we skipped OSM, 0 OSM trees → supplement generates synthetic ones
    // Actually with skip.trees=true, osmTreesPromise resolves to []
    // So trees.length should be 0 (no OSM) but supplement adds synthetic ones
    // Wait: the supplement logic runs on the result of osmTreesPromise regardless
    // Let me check: "if (trees.length < 3)" — trees starts from OSM (0), so < 3 → supplement
    expect(result.trees.length).toBeGreaterThan(0);
    expect(result.treePalette.length).toBeGreaterThan(0);
  });

  it('infers ground cover from state when landcover is skipped', async () => {
    const { enrichForScene } = await import('../src/convert/scene-enrichment.js');
    const result = await enrichForScene(37.75, -122.43, 40,
      { stateAbbreviation: 'AZ' },
      { landcover: true },
    );
    // Arizona → desert ground cover via inferGroundCover()
    expect(result.groundCover).toBe('desert');
  });
});

// ── enrichScene feature flags tests ────────────────────────────────────────

describe('enrichScene feature flags', () => {
  it('fills ground when features.ground is not false (default)', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    const result = await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      // features is undefined → all default to true
    });
    expect(result.meta.envStats.groundFilled).toBeGreaterThan(0);
  });

  it('skips ground fill when features.ground is false', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    const result = await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: { ground: false },
    });
    expect(result.meta.envStats.groundFilled).toBe(0);
  });

  it('skips trees when features.trees is false', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    const result = await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: { trees: false },
    });
    expect(result.meta.envStats.treesPlaced).toBe(0);
  });

  it('still places ground when only trees are disabled', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    const result = await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: { trees: false, roads: false, paths: false, fences: false, pools: false },
    });
    // Ground should still be filled (ground defaults to true)
    expect(result.meta.envStats.groundFilled).toBeGreaterThan(0);
    expect(result.meta.envStats.treesPlaced).toBe(0);
    expect(result.meta.envStats.roadsPlaced).toBe(0);
    expect(result.meta.envStats.fencesPlaced).toBe(0);
  });

  it('all features disabled produces building-only output', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    const beforeNonAir = grid.countNonAir();
    const result = await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: {
        ground: false,
        trees: false,
        roads: false,
        paths: false,
        fences: false,
        pools: false,
      },
    });
    // With all features disabled, no environment blocks should be added
    expect(result.meta.envStats.groundFilled).toBe(0);
    expect(result.meta.envStats.treesPlaced).toBe(0);
    expect(result.meta.envStats.roadsPlaced).toBe(0);
    expect(result.meta.envStats.fencesPlaced).toBe(0);
    // Grid should have approximately the same number of non-air blocks
    // (classification doesn't add/remove blocks, only enrichment does)
    const afterNonAir = grid.countNonAir();
    expect(afterNonAir).toBe(beforeNonAir);
  });

  it('skip flags are computed correctly from features', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();

    // Disable all infrastructure-related features → skip infrastructure API
    await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: {
        roads: false,
        paths: false,
        fences: false,
        pools: false,
        ground: false,
        trees: false,
      },
    });

    // With all features disabled, no overpass calls should be made
    const overpassCalls = fetchCallUrls.filter(u => u.includes('overpass'));
    expect(overpassCalls).toHaveLength(0);
  });

  it('enables infrastructure API when only roads is true', async () => {
    const { enrichScene } = await import('../src/convert/scene-pipeline.js');
    const grid = makeTestGrid();
    fetchCallUrls = [];

    await enrichScene({
      grid,
      coords: { lat: 37.75, lng: -122.43 },
      resolution: 1,
      plotRadius: 15,
      features: {
        roads: true,       // needs infrastructure
        paths: false,
        fences: false,
        pools: false,
        ground: false,     // skip landcover
        trees: false,      // skip tree query
      },
    });

    // Infrastructure query should fire (roads=true needs it)
    const overpassCalls = fetchCallUrls.filter(u => u.includes('overpass'));
    expect(overpassCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── SceneFeatureFlags type tests ───────────────────────────────────────────

describe('SceneFeatureFlags defaults', () => {
  it('undefined features behave as all-true', () => {
    // Verify the default-true pattern: `features?.X !== false`
    const features: SceneFeatureFlags | undefined = undefined;
    expect(features?.ground !== false).toBe(true);
    expect(features?.trees !== false).toBe(true);
    expect(features?.roads !== false).toBe(true);
    expect(features?.paths !== false).toBe(true);
    expect(features?.fences !== false).toBe(true);
    expect(features?.pools !== false).toBe(true);
  });

  it('empty object behaves as all-true', () => {
    const features: SceneFeatureFlags = {};
    expect(features.ground !== false).toBe(true);
    expect(features.trees !== false).toBe(true);
    expect(features.roads !== false).toBe(true);
    expect(features.paths !== false).toBe(true);
    expect(features.fences !== false).toBe(true);
    expect(features.pools !== false).toBe(true);
  });

  it('explicit false disables feature', () => {
    const features: SceneFeatureFlags = { ground: false };
    expect(features.ground !== false).toBe(false);
    // Others still default true
    expect(features.trees !== false).toBe(true);
  });

  it('explicit true enables feature', () => {
    const features: SceneFeatureFlags = { ground: true };
    expect(features.ground !== false).toBe(true);
  });
});
