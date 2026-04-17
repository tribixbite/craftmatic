import { describe, it, expect } from 'vitest';
import {
  BboxAccumulator,
  addPositionsToHeightmap,
  createHeightmapState,
  encodeHeightmapSidecar,
  isHeightTruncated,
  normaliseHeightmap,
  type HeightmapBbox,
} from './heightmap.js';

describe('BboxAccumulator', () => {
  it('returns null when untouched', () => {
    expect(new BboxAccumulator().get()).toBeNull();
  });
  it('aggregates bounds over multiple position arrays', () => {
    const acc = new BboxAccumulator();
    acc.addPositions(new Float32Array([0, 0, 0, 1, 2, 3]));
    acc.addPositions(new Float32Array([-5, 1, 4]));
    expect(acc.get()).toEqual({
      minX: -5, minY: 0, minZ: 0, maxX: 1, maxY: 2, maxZ: 4,
    });
  });
});

describe('createHeightmapState', () => {
  const bbox: HeightmapBbox = { minX: 0, minY: 0, minZ: 0, maxX: 50, maxY: 30, maxZ: 20 };

  it('sizes grid from bbox XZ extent × resolution', () => {
    const s = createHeightmapState(bbox, 1);
    expect(s?.width).toBe(50);
    expect(s?.length).toBe(20);
  });
  it('returns null when dimension exceeds limit', () => {
    expect(createHeightmapState(bbox, 40, { maxDim: 100 })).toBeNull();
  });
});

describe('addPositionsToHeightmap + normaliseHeightmap', () => {
  it('keeps minimum Y per cell and normalises to 0-based', () => {
    const bbox: HeightmapBbox = { minX: 0, minY: -5, minZ: 0, maxX: 3, maxY: 10, maxZ: 3 };
    const state = createHeightmapState(bbox, 1)!;
    // Three samples in cell (0,0) with Y = 5, 10, -2 → min is -2
    addPositionsToHeightmap(state, new Float32Array([
      0.1, 5,  0.1,
      0.2, 10, 0.2,
      0.3, -2, 0.3,
      1.5, 3, 1.5,
    ]));
    normaliseHeightmap(state);
    const idx00 = 0;
    const idx11 = 1 * state.width + 1;
    // (0,0) min was -2; after normalise, becomes 0
    expect(state.heights[idx00]).toBeCloseTo(0);
    // (1,1) was 3; after normalise = 3 - (-2) = 5
    expect(state.heights[idx11]).toBeCloseTo(5);
    // Untouched cell stays 0
    expect(state.heights[2]).toBe(0);
  });

  it('ignores out-of-bounds positions', () => {
    const bbox: HeightmapBbox = { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 1, maxZ: 2 };
    const state = createHeightmapState(bbox, 1)!;
    addPositionsToHeightmap(state, new Float32Array([
      10, 1, 10, // out of bounds
      -5, 0, -5, // out of bounds
      1, 1, 1,   // in bounds
    ]));
    expect(state.counts[0] + state.counts[1] + state.counts[2] + state.counts[3]).toBe(1);
  });
});

describe('encodeHeightmapSidecar', () => {
  it('produces [u16 width][u16 length][f32 data]', () => {
    const bbox: HeightmapBbox = { minX: 0, minY: 0, minZ: 0, maxX: 4, maxY: 1, maxZ: 3 };
    const state = createHeightmapState(bbox, 1)!;
    const encoded = encodeHeightmapSidecar(state);
    const header = new Uint16Array(encoded.buffer, encoded.byteOffset, 2);
    expect(header[0]).toBe(4);
    expect(header[1]).toBe(3);
    // 4×3 float32 = 48 bytes + 4-byte header = 52
    expect(encoded.byteLength).toBe(52);
  });
});

describe('isHeightTruncated', () => {
  const bbox = (maxY: number): HeightmapBbox => ({
    minX: 0, minY: 0, minZ: 0, maxX: 50, maxY, maxZ: 50,
  });
  it('false when expected height is null', () => {
    expect(isHeightTruncated(bbox(30), null)).toBe(false);
  });
  it('true when captured < 60% of expected', () => {
    // pennzoil: expected 172m, captured 60m → truncated
    expect(isHeightTruncated(bbox(60), 172)).toBe(true);
  });
  it('false when captured ≥ 60%', () => {
    expect(isHeightTruncated(bbox(110), 172)).toBe(false);
  });
});
