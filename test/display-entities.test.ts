import { describe, expect, it } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import {
  gridToDisplayBoxes,
  buildDisplayEntitiesFunction,
  ldrawToDisplayEntities,
  matrixToQuaternion,
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

  it('converts rotation matrices to normalized quaternions', () => {
    // Identity rotation
    const qIdent = matrixToQuaternion([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(qIdent).toEqual([0, 0, 0, 1]);

    // 90-degree yaw rotation around Y
    const q90Y = matrixToQuaternion([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(Math.abs(q90Y[1])).toBeCloseTo(0.7071, 3);
    expect(Math.abs(q90Y[3])).toBeCloseTo(0.7071, 3);
  });

  it('compiles parsed LDraw bricks directly to display entities with true dimensions and colors', () => {
    const bricks = [
      { part: '3001.dat', color: 4, x: 0, y: 0, z: 0 }, // 2x4 red brick
      { part: '3023.dat', color: 14, x: 20, y: -24, z: 0 }, // 1x2 yellow plate
      { part: '3065.dat', color: 47, x: -20, y: -24, z: 0 }, // 1x2 trans-clear brick (glass)
    ];

    const result = ldrawToDisplayEntities(bricks, { tag: 'direct_ldraw_model' });
    expect(result.boxCount).toBe(3);
    expect(result.spawnCommand).toBe('/function <namespace>:direct_ldraw_model');
    expect(result.mcfunction).toContain('# Craftmatic Java Display Entities Model (Direct Non-Voxelized LDraw)');
    expect(result.mcfunction).toContain('kill @e[type=block_display,tag=direct_ldraw_model,distance=..64]');

    // Color check
    expect(result.mcfunction).toContain('minecraft:red_concrete');
    expect(result.mcfunction).toContain('minecraft:yellow_concrete');
    expect(result.mcfunction).toContain('minecraft:glass');

    // Scale check (at default scale 0.2/20 = 0.01 blocks/LDU)
    // 3001 is 2x4 studs = 40x80 LDU, height 3 plates = 24 LDU -> sx: 0.400, sy: 0.240, sz: 0.800
    expect(result.mcfunction).toContain('scale:[0.400f,0.240f,0.800f]');
    // 3023 is 1x2 studs = 20x40 LDU, height 1 plate = 8 LDU -> sx: 0.200, sy: 0.080, sz: 0.400
    expect(result.mcfunction).toContain('scale:[0.200f,0.080f,0.400f]');
  });
});
