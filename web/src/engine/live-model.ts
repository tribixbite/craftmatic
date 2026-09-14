import type { BlockGrid } from '@craft/schem/types.js';
import { toBedrockBlock } from './bedrock-blocks.js';
import { encodeModel, type LiveModel } from './hotschem/live-import.js';
import { mergeCuboids } from './hotschem/rle.js';

/** Same Bedrock mapping and merged placement operations as the downloadable export. */
export function buildLiveModel(grid: BlockGrid, title: string): LiveModel {
  const source = grid.reversePalette();
  const used = new Set(grid.rawData);
  const airSet = new Set<number>();
  const palette: LiveModel['palette'] = source.map((state, i) => {
    if (/^minecraft:(air|cave_air|void_air)$/.test(state)) airSet.add(i);
    const block = toBedrockBlock(state);
    if (!block && !used.has(i)) return ['minecraft:air', {}];
    if (!block) throw new Error(`No Bedrock mapping for ${state}`);
    return [block.name, block.states];
  });
  return {
    title: title.slice(0, 200), w: grid.width, h: grid.height, l: grid.length, palette,
    ops: mergeCuboids({ W: grid.width, H: grid.height, L: grid.length, data: grid.rawData, airSet }),
  };
}

export function encodeLiveGrid(grid: BlockGrid, title: string): Uint8Array {
  return new TextEncoder().encode(encodeModel(buildLiveModel(grid, title)));
}
