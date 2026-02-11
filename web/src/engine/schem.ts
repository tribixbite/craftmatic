/**
 * Browser-compatible .schem file parser.
 * Decompresses gzip with pako, parses NBT, builds a BlockGrid.
 */

import pako from 'pako';
import { parseNBT, type NBTCompound, type NBTValue } from './nbt.js';
import { BlockGrid } from '@craft/schem/types.js';

/** Decode varint-encoded block data to palette index array */
function decodeVarints(data: Uint8Array, count: number): number[] {
  const result: number[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    let shift = 0;
    while (true) {
      if (offset >= data.length) throw new Error('Varint extends past end of data');
      const byte = data[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    result.push(value);
  }
  return result;
}

/** Parse a .schem file from raw bytes into a BlockGrid */
export async function parseSchemFile(fileBytes: ArrayBuffer): Promise<BlockGrid> {
  // Decompress gzip
  const compressed = new Uint8Array(fileBytes);
  let decompressed: Uint8Array;
  try {
    decompressed = pako.inflate(compressed);
  } catch {
    // Maybe not gzipped, try raw
    decompressed = compressed;
  }

  // Parse NBT
  const { value: root } = parseNBT(decompressed);

  // Sponge Schematic v2 wraps data in "Schematic" compound
  const schematic = (root['Schematic'] as NBTCompound | undefined) ?? root;

  const width = asNumber(schematic['Width']);
  const height = asNumber(schematic['Height']);
  const length = asNumber(schematic['Length']);

  if (!width || !height || !length) {
    throw new Error('Invalid schematic: missing dimensions');
  }

  // Build reverse palette (index -> block state string)
  const paletteTag = schematic['Palette'] as NBTCompound | undefined;
  if (!paletteTag) throw new Error('Invalid schematic: missing Palette');

  const reversePalette = new Map<number, string>();
  for (const [blockState, id] of Object.entries(paletteTag)) {
    reversePalette.set(asNumber(id), blockState);
  }

  // Decode block data
  const blockDataRaw = schematic['BlockData'] as Uint8Array | undefined;
  if (!blockDataRaw) throw new Error('Invalid schematic: missing BlockData');

  const totalBlocks = width * height * length;
  const indices = decodeVarints(blockDataRaw, totalBlocks);

  // Build BlockGrid
  const grid = new BlockGrid(width, height, length);
  const blockStates: string[] = [];
  for (let i = 0; i < totalBlocks; i++) {
    const blockState = reversePalette.get(indices[i]) ?? 'minecraft:air';
    blockStates.push(blockState);
  }
  grid.loadFromArray(blockStates);

  // Load block entities
  const blockEntities = schematic['BlockEntities'] as NBTValue[] | undefined;
  if (blockEntities) {
    for (const beTag of blockEntities) {
      const be = beTag as NBTCompound;
      const pos = be['Pos'] as Int32Array | undefined;
      const id = be['Id'] as string | undefined;
      if (pos && id) {
        const items: Array<{ slot: number; id: string; count: number }> = [];
        const itemsList = be['Items'] as NBTValue[] | undefined;
        if (itemsList) {
          for (const itemTag of itemsList) {
            const item = itemTag as NBTCompound;
            items.push({
              slot: asNumber(item['Slot']),
              id: (item['id'] as string) ?? 'minecraft:air',
              count: asNumber(item['Count'] ?? 1),
            });
          }
        }
        grid.blockEntities.push({
          type: id.replace('minecraft:', ''),
          pos: [pos[0], pos[1], pos[2]],
          id,
          items: items.length > 0 ? items : undefined,
        });
      }
    }
  }

  return grid;
}

/** Safely coerce an NBT value to a JS number */
function asNumber(val: NBTValue | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return 0;
}
