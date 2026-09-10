import { describe, it, expect } from 'vitest';
import { BlockGrid } from '../src/schem/types.js';
import { buildLiveModel, encodeLiveGrid } from '../web/src/engine/live-model.js';
import { decodeModel, makeParts, acceptPart } from '../web/src/engine/hotschem/live-import.js';

describe('live Bedrock export', () => {
  it('round-trips a non-cubic grid with correct Bedrock palette and every occupied coordinate', () => {
    const grid = new BlockGrid(7, 3, 5);
    grid.set(1, 0, 4, 'minecraft:bricks');
    grid.set(5, 2, 1, 'minecraft:cobblestone_stairs[facing=east,half=top,shape=straight,waterlogged=false]');
    grid.set(6, 2, 1, 'minecraft:cobblestone_stairs[facing=east,half=top,shape=straight,waterlogged=false]');
    const encoded = new TextDecoder().decode(encodeLiveGrid(grid, 'Local castle'));
    const model = decodeModel(encoded);
    expect([model.w, model.h, model.l]).toEqual([7, 3, 5]);
    expect(model.palette.some(p => p[0] === 'minecraft:brick_block')).toBe(true);
    const cells: string[] = [];
    for (const [x, y, z, xx, yy, zz] of model.ops) for(let a=x!;a<=xx!;a++) for(let b=y!;b<=yy!;b++) for(let c=z!;c<=zz!;c++) cells.push(`${a},${b},${c}`);
    expect(cells.sort()).toEqual(['1,0,4', '5,2,1', '6,2,1']);
    const parts = makeParts(encoded, 300);
    let session: unknown;
    let result;
    for (const part of parts.reverse()) { result = acceptPart(session, part); session = result.session; }
    expect(result?.model).toEqual(model);
  });
  it('rejects missing block mappings instead of silently losing blocks', () => {
    const grid = new BlockGrid(1, 1, 1); grid.set(0, 0, 0, 'custom:unknown');
    expect(() => buildLiveModel(grid, 'Unsupported')).toThrow(/mapping/);
  });
});
