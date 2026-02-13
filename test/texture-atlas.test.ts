import { describe, it, expect } from 'vitest';
import { getDefaultAtlas, getBlockFaceUV, getBlockUVs, buildAtlasForBlocks, ProceduralAtlas } from '../src/render/texture-atlas.js';

describe('texture atlas', () => {
  it('builds a default atlas with common textures', () => {
    const atlas = getDefaultAtlas();
    expect(atlas.entries.size).toBeGreaterThan(50);
    expect(atlas.width).toBeGreaterThan(0);
    expect(atlas.height).toBeGreaterThan(0);
    expect(atlas.tileSize).toBe(32);
  });

  it('returns same cached atlas on repeated calls', () => {
    const a = getDefaultAtlas();
    const b = getDefaultAtlas();
    expect(a).toBe(b);
  });

  it('has UVs for stone', () => {
    const atlas = getDefaultAtlas();
    const uv = atlas.getUV('stone');
    expect(uv.u).toBeGreaterThanOrEqual(0);
    expect(uv.v).toBeGreaterThanOrEqual(0);
    expect(uv.w).toBeGreaterThan(0);
    expect(uv.h).toBeGreaterThan(0);
  });

  it('has UVs for planks', () => {
    const atlas = getDefaultAtlas();
    const uv = atlas.getUV('oak_planks');
    expect(uv.w).toBeGreaterThan(0);
  });

  it('generates pixel data', () => {
    const atlas = getDefaultAtlas();
    const pixels = atlas.getPixelData();
    expect(pixels).toBeInstanceOf(Uint8Array);
    expect(pixels.length).toBe(atlas.width * atlas.height * 4);
    // Pixels should have some non-zero values
    let nonZero = 0;
    for (let i = 0; i < 100; i++) {
      if (pixels[i] > 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(0);
  });

  it('exports JSON UV map', () => {
    const atlas = getDefaultAtlas();
    const json = atlas.toJSON();
    expect(Object.keys(json).length).toBe(atlas.entries.size);
    expect(json['stone']).toBeDefined();
    expect(json['stone'].u).toBeGreaterThanOrEqual(0);
  });

  it('gets block face UVs', () => {
    const uv = getBlockFaceUV('minecraft:oak_planks', 'top');
    expect(uv.w).toBeGreaterThan(0);
    expect(uv.h).toBeGreaterThan(0);
  });

  it('gets all face UVs for a block', () => {
    const uvs = getBlockUVs('minecraft:stone');
    expect(uvs.top).toBeDefined();
    expect(uvs.bottom).toBeDefined();
    expect(uvs.north).toBeDefined();
    expect(uvs.south).toBeDefined();
    expect(uvs.east).toBeDefined();
    expect(uvs.west).toBeDefined();
  });

  it('builds custom atlas for specific blocks', () => {
    const atlas = buildAtlasForBlocks([
      'minecraft:stone', 'minecraft:oak_planks', 'minecraft:glass',
    ]);
    expect(atlas).toBeInstanceOf(ProceduralAtlas);
    expect(atlas.entries.size).toBeGreaterThan(0);
  });
});
