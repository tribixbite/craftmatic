import { describe, it, expect } from 'vitest';
import { normalizeSampleLuminance } from './photogrammetry-recolor.js';

function pack(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}
function luma(packed: number): number {
  return 0.2126 * ((packed >> 16) & 0xff) + 0.7152 * ((packed >> 8) & 0xff) + 0.0722 * (packed & 0xff);
}

describe('normalizeSampleLuminance', () => {
  it('lifts the shadowed tail of a bimodal (sun/shade) sample set', () => {
    // Half the facade in deep shade (~RGB 40), half sunlit (~RGB 200) — the
    // baked-lighting signature. After normalisation the dark half must be
    // materially lifted while ordering (dark < light) is preserved.
    const n = 400;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      arr[i] = i < n / 2 ? pack(40, 38, 42) : pack(200, 196, 190);
    }
    const beforeDark = luma(arr[0]);
    normalizeSampleLuminance(arr);
    const afterDark = luma(arr[0]);
    const afterLight = luma(arr[n - 1]);
    expect(afterDark).toBeGreaterThan(beforeDark + 15); // shadow lifted
    expect(afterDark).toBeLessThan(afterLight);          // ordering intact
  });

  it('preserves chroma direction (brick stays reddish after the lift)', () => {
    const n = 200;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      // Shaded brick (dark red) + sunlit cream.
      arr[i] = i < n / 2 ? pack(70, 35, 30) : pack(210, 200, 180);
    }
    normalizeSampleLuminance(arr);
    const r = (arr[0] >> 16) & 0xff, g = (arr[0] >> 8) & 0xff, b = arr[0] & 0xff;
    expect(r).toBeGreaterThan(g); // still red-dominant
    expect(r).toBeGreaterThan(b);
  });

  it('leaves uniformly-lit buildings untouched (genuinely dark tower)', () => {
    // Narrow spread around RGB 60 — a real dark facade, not sun/shade.
    const n = 200;
    const arr = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const v = 55 + (i % 11); // L* spread well under the 25 threshold
      arr[i] = pack(v, v, v);
    }
    const before = Array.from(arr);
    normalizeSampleLuminance(arr);
    expect(Array.from(arr)).toEqual(before);
  });

  it('ignores unsampled (-1) cells and tiny sample sets', () => {
    const arr = new Int32Array(60).fill(-1);
    arr[0] = pack(40, 40, 40);
    arr[1] = pack(200, 200, 200);
    const before = Array.from(arr);
    normalizeSampleLuminance(arr); // <50 samples → no-op
    expect(Array.from(arr)).toEqual(before);
  });
});

// ─── consolidation pass ─────────────────────────────────────────────────────
import { consolidateRecoloredBlocks } from './photogrammetry-recolor.js';
import { BlockGrid } from '../../schem/types.js';

describe('consolidateRecoloredBlocks', () => {
  function markAll(grid: BlockGrid): Int32Array {
    const m = new Int32Array(grid.width * grid.height * grid.length).fill(-1);
    for (let y = 0; y < grid.height; y++)
      for (let z = 0; z < grid.length; z++)
        for (let x = 0; x < grid.width; x++)
          if (grid.getIndex(x, y, z) !== 0) m[(y * grid.length + z) * grid.width + x] = 0x808080;
    return m;
  }

  it('absorbs a single-voxel outlier into its surrounding material', () => {
    const g = new BlockGrid(3, 3, 3);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 3; z++)
        for (let x = 0; x < 3; x++) g.set(x, y, z, 'minecraft:stone');
    g.set(1, 1, 1, 'minecraft:polished_deepslate'); // speckle, 6 stone neighbours
    const flips = consolidateRecoloredBlocks(g, markAll(g));
    expect(flips).toBe(1);
    expect(g.get(1, 1, 1)).toBe('minecraft:stone');
  });

  it('leaves a coherent two-material boundary alone', () => {
    // Left half A, right half B — boundary voxels see ≤3 of the other side.
    const g = new BlockGrid(4, 3, 3);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 3; z++)
        for (let x = 0; x < 4; x++)
          g.set(x, y, z, x < 2 ? 'minecraft:stone' : 'minecraft:bricks');
    const flips = consolidateRecoloredBlocks(g, markAll(g));
    expect(flips).toBe(0);
  });

  it('never touches un-recolored voxels', () => {
    const g = new BlockGrid(3, 3, 3);
    for (let y = 0; y < 3; y++)
      for (let z = 0; z < 3; z++)
        for (let x = 0; x < 3; x++) g.set(x, y, z, 'minecraft:stone');
    g.set(1, 1, 1, 'minecraft:glass'); // window overlay — NOT in the mask
    const mask = markAll(g);
    mask[(1 * 3 + 1) * 3 + 1] = -1;
    const flips = consolidateRecoloredBlocks(g, mask);
    expect(flips).toBe(0);
    expect(g.get(1, 1, 1)).toBe('minecraft:glass');
  });
});

