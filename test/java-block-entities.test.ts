import { it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { parseUncompressed, simplify } from 'prismarine-nbt';
import { BlockGrid } from '../src/schem/types.js';
import { encodeSchemBytes, encodeLitematicBytes } from '../web/src/engine/schem-encode.js';

it('Java downloads preserve chest contents and modern sign text in both formats', () => {
  const grid = new BlockGrid(4, 3, 2);
  grid.addChest(1, 0, 1, 'east', [{ slot: 3, id: 'minecraft:diamond', count: 7 }]);
  grid.addSign(2, 1, 0, 'north', ['Computer', 'Ready']);
  const read = (bytes: Uint8Array) => simplify(parseUncompressed(gunzipSync(bytes), 'big')) as any;
  const sponge = read(encodeSchemBytes(grid));
  expect(sponge.BlockEntities[0]).toMatchObject({ Id: 'minecraft:chest', Pos: [1, 0, 1], Items: [{ Slot: 3, id: 'minecraft:diamond', Count: 7 }] });
  expect(sponge.BlockEntities[1].Id).toBe('minecraft:sign');
  expect(JSON.parse(sponge.BlockEntities[1].front_text.messages[0])).toEqual({ text: 'Computer' });
  const litematic = read(encodeLitematicBytes(grid));
  const region = Object.values(litematic.Regions)[0] as any;
  expect(region.TileEntities[0]).toMatchObject({ id: 'minecraft:chest', x: 1, y: 0, z: 1, Items: [{ Count: 7 }] });
  expect(region.TileEntities[1].front_text.messages).toHaveLength(4);
});
