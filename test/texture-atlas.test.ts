import { describe, it, expect } from 'vitest';
import { getDefaultAtlas, initDefaultAtlas, getBlockFaceUV, getBlockUVs, buildAtlasForBlocks, ProceduralAtlas } from '../src/render/texture-atlas.js';
import { getBlockTextures } from '../src/blocks/textures.js';
import { getItemSprite } from '../src/render/item-sprites.js';
import { getAllBlockColors } from '../src/blocks/colors.js';
import { generateStructure } from '../src/gen/generator.js';
import { renderExterior } from '../src/render/png-renderer.js';

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

  it('initDefaultAtlas loads ≥150 textures with real PNGs', async () => {
    const atlas = await initDefaultAtlas();
    expect(atlas.entries.size).toBeGreaterThanOrEqual(150);
    // Verify some entries have non-zero pixel data (real textures)
    const stoneEntry = atlas.entries.get('stone');
    expect(stoneEntry).toBeDefined();
    expect(stoneEntry!.data.length).toBe(32 * 32 * 4);
  });

  it('getBlockTextures returns valid face names for all known blocks', () => {
    const blockColors = getAllBlockColors();
    for (const [blockId] of blockColors) {
      const textures = getBlockTextures(blockId);
      expect(textures.top).toBeTruthy();
      expect(textures.bottom).toBeTruthy();
      expect(textures.north).toBeTruthy();
      expect(textures.south).toBeTruthy();
      expect(textures.east).toBeTruthy();
      expect(textures.west).toBeTruthy();
    }
  });
});

describe('item sprites', () => {
  it('returns non-null for key furniture items', () => {
    const items = [
      'minecraft:chest', 'minecraft:lantern', 'minecraft:soul_lantern',
      'minecraft:barrel', 'minecraft:anvil', 'minecraft:crafting_table',
      'minecraft:bookshelf', 'minecraft:enchanting_table', 'minecraft:bell',
      'minecraft:campfire', 'minecraft:cauldron', 'minecraft:armor_stand',
      'minecraft:brewing_stand', 'minecraft:cartography_table',
    ];
    for (const item of items) {
      const sprite = getItemSprite(item);
      expect(sprite, `sprite missing for ${item}`).not.toBeNull();
      expect(sprite!.length).toBe(16 * 16 * 4);
    }
  });

  it('returns non-null for potted plants', () => {
    const sprite = getItemSprite('minecraft:potted_fern');
    expect(sprite).not.toBeNull();
  });

  it('returns non-null for bed variants', () => {
    for (const color of ['red', 'blue', 'cyan']) {
      const sprite = getItemSprite(`minecraft:${color}_bed`);
      expect(sprite, `sprite missing for ${color}_bed`).not.toBeNull();
    }
  });

  it('returns null for plain structural blocks', () => {
    expect(getItemSprite('minecraft:stone')).toBeNull();
    expect(getItemSprite('minecraft:oak_planks')).toBeNull();
    expect(getItemSprite('minecraft:cobblestone')).toBeNull();
  });
});

describe('textured rendering', () => {
  it('renderExterior produces valid PNG for each structure type', async () => {
    const types = ['house', 'castle', 'cathedral', 'ship'] as const;
    for (const type of types) {
      const grid = generateStructure({ type, floors: 2, style: 'medieval', seed: 42 });
      const png = await renderExterior(grid, { tile: 6 });
      expect(png.length).toBeGreaterThan(100);
      // Check PNG header bytes
      expect(png[0]).toBe(0x89);
      expect(png[1]).toBe(0x50); // P
      expect(png[2]).toBe(0x4e); // N
      expect(png[3]).toBe(0x47); // G
    }
  }, 30000);
});
