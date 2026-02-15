import { describe, it, expect } from 'vitest';
import { mapColorToWall, WALL_MATERIAL_PALETTE } from '../web/src/ui/import-color.js';

describe('mapColorToWall', () => {
  it('maps white/light gray to white_concrete', () => {
    expect(mapColorToWall({ r: 210, g: 215, b: 215 })).toBe('minecraft:white_concrete');
  });

  it('maps reddish-brown to bricks', () => {
    expect(mapColorToWall({ r: 155, g: 100, b: 85 })).toBe('minecraft:bricks');
  });

  it('maps warm tan to oak_planks', () => {
    expect(mapColorToWall({ r: 165, g: 133, b: 80 })).toBe('minecraft:oak_planks');
  });

  it('maps dark brown to dark_oak_planks', () => {
    expect(mapColorToWall({ r: 70, g: 45, b: 22 })).toBe('minecraft:dark_oak_planks');
  });

  it('maps medium gray to stone_bricks', () => {
    expect(mapColorToWall({ r: 125, g: 125, b: 125 })).toBe('minecraft:stone_bricks');
  });

  it('maps very light gray to iron_block', () => {
    expect(mapColorToWall({ r: 225, g: 225, b: 225 })).toBe('minecraft:iron_block');
  });

  it('maps sandy tan to sandstone', () => {
    expect(mapColorToWall({ r: 218, g: 205, b: 158 })).toBe('minecraft:sandstone');
  });

  it('maps terra cotta orange to terracotta', () => {
    expect(mapColorToWall({ r: 155, g: 96, b: 70 })).toBe('minecraft:terracotta');
  });

  it('maps medium brown to spruce_planks', () => {
    expect(mapColorToWall({ r: 116, g: 87, b: 50 })).toBe('minecraft:spruce_planks');
  });

  it('maps light tan to birch_planks', () => {
    expect(mapColorToWall({ r: 195, g: 178, b: 123 })).toBe('minecraft:birch_planks');
  });

  it('returns a valid block from the palette for any RGB', () => {
    const validBlocks = WALL_MATERIAL_PALETTE.map(m => m.block);
    // Random colors should all map to a known material
    for (let i = 0; i < 20; i++) {
      const rgb = { r: (i * 47) % 256, g: (i * 89) % 256, b: (i * 131) % 256 };
      const result = mapColorToWall(rgb);
      expect(validBlocks).toContain(result);
    }
  });
});
