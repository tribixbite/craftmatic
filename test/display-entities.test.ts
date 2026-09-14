import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  gridToDisplayBoxes,
  buildDisplayEntitiesFunction,
} from '../web/src/engine/display-entities.js';

describe('Java block_display entity exporter', () => {
  it('greedy-meshes single blocks and solid regions into cuboids', () => {
    const grid = new BlockGrid(4, 4, 4);
    // Fill a 2x2x2 cube
    for (let y = 0; y < 2; y++) {
      for (let z = 0; z < 2; z++) {
        for (let x = 0; x < 2; x++) {
          grid.set(x, y, z, 'minecraft:red_concrete');
        }
      }
    }
    // Single isolated block
    grid.set(3, 3, 3, 'minecraft:blue_concrete');

    const boxes = gridToDisplayBoxes(grid);
    expect(boxes).toHaveLength(2);

    const redBox = boxes.find(b => b.state === 'minecraft:red_concrete');
    expect(redBox).toBeDefined();
    expect(redBox?.sx).toBe(2);
    expect(redBox?.sy).toBe(2);
    expect(redBox?.sz).toBe(2);

    const blueBox = boxes.find(b => b.state === 'minecraft:blue_concrete');
    expect(blueBox).toBeDefined();
    expect(blueBox?.x).toBe(3);
    expect(blueBox?.y).toBe(3);
    expect(blueBox?.z).toBe(3);
    expect(blueBox?.sx).toBe(1);
    expect(blueBox?.sy).toBe(1);
    expect(blueBox?.sz).toBe(1);
  });

  it('generates a valid .mcfunction with summon commands and clean NBT', () => {
    const grid = new BlockGrid(2, 2, 2);
    grid.set(0, 0, 0, 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight]');
    grid.set(1, 0, 0, 'minecraft:yellow_concrete');

    const result = buildDisplayEntitiesFunction(grid, {
      tag: 'test_car',
      scale: 0.5,
    });

    expect(result.boxCount).toBe(2);
    expect(result.spawnCommand).toBe('/function <namespace>:test_car');
    expect(result.mcfunction).toContain('# Craftmatic Java Display Entities Model');
    expect(result.mcfunction).toContain('kill @e[type=block_display,tag=test_car,distance=..64]');
    expect(result.mcfunction).toContain('summon block_display');
    expect(result.mcfunction).toContain('Tags:["test_car"]');
    expect(result.mcfunction).toContain(
      '{Name:"minecraft:oak_stairs",Properties:{facing:"north",half:"bottom",shape:"straight"}}'
    );
    expect(result.mcfunction).toContain('{Name:"minecraft:yellow_concrete"}');
    expect(result.mcfunction).toContain('scale:[0.500f,0.500f,0.500f]');
  });
});
