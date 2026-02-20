/**
 * Round-trip tests for sign block entities through the .schem write/parse pipeline.
 * Verifies that sign text, position, and block state survive serialization.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { BlockGrid } from '@craft/schem/types.js';
import { writeSchematicData, gridToSchematic } from '@craft/schem/write.js';
import { parseSchematic, parseToGrid } from '@craft/schem/parse.js';
import { stampSign } from '@craft/gen/gen-utils.js';

/** Temp files created during tests, cleaned up in afterAll */
const tempFiles: string[] = [];

/** Helper: write a grid to a temp .schem file and track for cleanup */
function writeTemp(grid: BlockGrid, name: string): string {
  const filepath = `/tmp/craftmatic-test-${name}-${Date.now()}.schem`;
  const data = gridToSchematic(grid);
  writeSchematicData(data, filepath);
  tempFiles.push(filepath);
  return filepath;
}

afterAll(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore cleanup errors */ }
    }
  }
});

describe('Sign block entity round-trip', () => {
  it('preserves sign text through file write and parse', async () => {
    const grid = new BlockGrid(5, 5, 5);
    // Place a floor so the sign has context
    grid.fill(0, 0, 0, 4, 0, 4, 'minecraft:stone');

    const originalText = ['Craftmatic', 'v2026.02.20', 'gothic house 3f', 'seed:12345'];
    grid.addSign(2, 1, 2, 'south', originalText);

    const filepath = writeTemp(grid, 'sign-text');
    const parsed = await parseSchematic(filepath);

    // Exactly 1 block entity
    expect(parsed.blockEntities).toHaveLength(1);

    const entity = parsed.blockEntities[0];

    // Entity ID contains "sign"
    expect(entity.id).toContain('sign');

    // Position matches
    expect(entity.pos).toEqual([2, 1, 2]);

    // Text array has 4 elements matching original
    expect(entity.text).toBeDefined();
    expect(entity.text).toHaveLength(4);
    expect(entity.text).toEqual(originalText);

    // Verify the block state at the sign position in the parsed grid
    const roundTrippedGrid = await parseToGrid(filepath);
    const blockState = roundTrippedGrid.get(2, 1, 2);
    expect(blockState).toContain('oak_wall_sign');
    expect(blockState).toContain('facing=south');
  });

  it('preserves empty sign lines', async () => {
    const grid = new BlockGrid(5, 5, 5);
    const originalText = ['Line 1', '', '', ''];
    grid.addSign(1, 0, 1, 'north', originalText);

    const filepath = writeTemp(grid, 'sign-empty-lines');
    const parsed = await parseSchematic(filepath);

    expect(parsed.blockEntities).toHaveLength(1);
    const entity = parsed.blockEntities[0];
    expect(entity.text).toBeDefined();
    expect(entity.text).toHaveLength(4);
    expect(entity.text).toEqual(originalText);
  });

  it('preserves multiple signs at different positions', async () => {
    const grid = new BlockGrid(10, 5, 10);
    // Place walls so signs have context
    grid.fill(0, 0, 0, 9, 0, 9, 'minecraft:stone');

    const text1 = ['Sign A', 'Line 2', '', ''];
    const text2 = ['Sign B', '', 'Line 3', 'Line 4'];

    grid.addSign(2, 1, 3, 'south', text1);
    grid.addSign(7, 1, 5, 'east', text2);

    const filepath = writeTemp(grid, 'sign-multiple');
    const parsed = await parseSchematic(filepath);

    expect(parsed.blockEntities).toHaveLength(2);

    // Sort by x position for deterministic assertion order
    const sorted = [...parsed.blockEntities].sort((a, b) => a.pos[0] - b.pos[0]);

    // First sign at (2,1,3)
    expect(sorted[0].pos).toEqual([2, 1, 3]);
    expect(sorted[0].text).toEqual(text1);
    expect(sorted[0].id).toContain('sign');

    // Second sign at (7,1,5)
    expect(sorted[1].pos).toEqual([7, 1, 5]);
    expect(sorted[1].text).toEqual(text2);
    expect(sorted[1].id).toContain('sign');

    // Verify both block states exist in the round-tripped grid
    const roundTrippedGrid = await parseToGrid(filepath);
    expect(roundTrippedGrid.get(2, 1, 3)).toContain('oak_wall_sign');
    expect(roundTrippedGrid.get(7, 1, 5)).toContain('oak_wall_sign');
  });

  it('sign coexists with chest block entities', async () => {
    const grid = new BlockGrid(10, 5, 10);
    grid.fill(0, 0, 0, 9, 0, 9, 'minecraft:stone');

    const signText = ['Treasure', 'Room', '', ''];
    grid.addSign(3, 1, 2, 'south', signText);
    grid.addChest(5, 1, 4, 'north', [
      { slot: 0, id: 'minecraft:diamond', count: 3 },
      { slot: 1, id: 'minecraft:gold_ingot', count: 16 },
    ]);

    const filepath = writeTemp(grid, 'sign-with-chest');
    const parsed = await parseSchematic(filepath);

    expect(parsed.blockEntities).toHaveLength(2);

    // Find sign and chest entities by id
    const signEntity = parsed.blockEntities.find(e => e.id.includes('sign'));
    const chestEntity = parsed.blockEntities.find(e => e.id.includes('chest'));

    // Sign survived
    expect(signEntity).toBeDefined();
    expect(signEntity!.pos).toEqual([3, 1, 2]);
    expect(signEntity!.text).toEqual(signText);

    // Chest survived with inventory
    expect(chestEntity).toBeDefined();
    expect(chestEntity!.pos).toEqual([5, 1, 4]);
    expect(chestEntity!.items).toBeDefined();
    expect(chestEntity!.items).toHaveLength(2);
    expect(chestEntity!.items![0].id).toBe('minecraft:diamond');
    expect(chestEntity!.items![0].count).toBe(3);
    expect(chestEntity!.items![1].id).toBe('minecraft:gold_ingot');
    expect(chestEntity!.items![1].count).toBe(16);

    // Verify block states in round-tripped grid
    const roundTrippedGrid = await parseToGrid(filepath);
    expect(roundTrippedGrid.get(3, 1, 2)).toContain('oak_wall_sign');
    expect(roundTrippedGrid.get(5, 1, 4)).toContain('chest');
  });

  it('stampSign places a sign entity on a walled grid', () => {
    // Create a 20x10x20 grid with a walled perimeter at y=1
    const grid = new BlockGrid(20, 10, 20);
    // Floor
    grid.fill(0, 0, 0, 19, 0, 19, 'minecraft:stone');
    // Walls at y=1 around the perimeter
    grid.walls(0, 1, 0, 19, 3, 19, 'minecraft:stone_bricks');
    // Interior air (walls method already leaves interior open, but ensure y=1 interior is air)
    grid.clear(1, 1, 1, 18, 3, 18);
    // Re-apply walls since clear wiped them
    grid.walls(0, 1, 0, 19, 3, 19, 'minecraft:stone_bricks');

    // Before stampSign — no sign entities
    expect(grid.blockEntities).toHaveLength(0);

    stampSign(grid, 'house', 'gothic', 3, 42);

    // After stampSign — exactly 1 sign entity placed
    expect(grid.blockEntities).toHaveLength(1);

    const entity = grid.blockEntities[0];
    expect(entity.id).toContain('sign');
    expect(entity.text).toBeDefined();
    expect(entity.text).toHaveLength(4);
    // Verify text content from stampSign
    expect(entity.text![0]).toBe('Craftmatic');
    expect(entity.text![2]).toBe('gothic house 3f');
    expect(entity.text![3]).toBe('seed:42');

    // Verify the sign block state was set at the entity position
    const [sx, sy, sz] = entity.pos;
    const blockState = grid.get(sx, sy, sz);
    expect(blockState).toContain('oak_wall_sign');
  });
});
