/**
 * Parse Sponge Schematic v2 (.schem) files into SchematicData / BlockGrid.
 * Uses prismarine-nbt for robust NBT parsing.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parse as parseNbt } from 'prismarine-nbt';
import type { SchematicData, BlockEntity, ItemSlot, Vec3 } from '../types/index.js';
import { BlockGrid } from './types.js';
import { decodeAllVarints } from './varint.js';

/**
 * Parse a .schem file into a SchematicData object.
 * Supports Sponge Schematic v2 format (WorldEdit compatible).
 */
export async function parseSchematic(filepath: string): Promise<SchematicData> {
  const raw = readFileSync(filepath);
  const decompressed = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : Buffer.from(raw);
  const { parsed } = await parseNbt(decompressed);

  // Navigate to the root compound — prismarine-nbt wraps values
  const root = unwrap(parsed) as Record<string, unknown>;

  // Sponge Schematic v2 may have a "Schematic" wrapper (v3) or be at root (v2)
  const schem = (root['Schematic'] as Record<string, unknown>) ?? root;

  const version = getNum(schem, 'Version') ?? 2;
  const dataVersion = getNum(schem, 'DataVersion') ?? 0;
  const width = getNum(schem, 'Width') ?? 0;
  const height = getNum(schem, 'Height') ?? 0;
  const length = getNum(schem, 'Length') ?? 0;

  // Parse palette: maps block state string -> palette ID
  const palette = new Map<string, number>();
  const rawPalette = schem['Palette'] as Record<string, unknown> | undefined;
  if (rawPalette) {
    const unwrapped = unwrap(rawPalette) as Record<string, unknown>;
    for (const [key, val] of Object.entries(unwrapped)) {
      palette.set(key, typeof val === 'number' ? val : Number(val));
    }
  }

  // Parse block data (byte array of varints)
  let blockData = new Uint8Array(0);
  const rawBlockData = schem['BlockData'];
  if (rawBlockData) {
    const unwrappedData = unwrap(rawBlockData);
    if (unwrappedData instanceof Int8Array || unwrappedData instanceof Uint8Array) {
      blockData = new Uint8Array(unwrappedData);
    } else if (Array.isArray(unwrappedData)) {
      blockData = new Uint8Array(unwrappedData.map(v => Number(v) & 0xff));
    }
  }

  // Parse offset
  const rawOffset = schem['Offset'];
  let offset: Vec3 = [0, 0, 0];
  if (rawOffset) {
    const unwrappedOffset = unwrap(rawOffset);
    if (Array.isArray(unwrappedOffset) || unwrappedOffset instanceof Int32Array) {
      offset = [
        Number(unwrappedOffset[0]) || 0,
        Number(unwrappedOffset[1]) || 0,
        Number(unwrappedOffset[2]) || 0,
      ];
    }
  }

  // Parse block entities
  const blockEntities: BlockEntity[] = [];
  const rawEntities = schem['BlockEntities'];
  if (rawEntities) {
    const entities = unwrap(rawEntities) as unknown[];
    if (Array.isArray(entities)) {
      for (const entity of entities) {
        const ent = unwrap(entity) as Record<string, unknown>;
        const pos = unwrap(ent['Pos']) as number[] | Int32Array;
        // Parse inventory items (chests, barrels, hoppers, etc.)
        const items: ItemSlot[] = [];
        const rawItems = ent['Items'];
        if (rawItems) {
          const itemList = unwrap(rawItems) as unknown[];
          if (Array.isArray(itemList)) {
            for (const item of itemList) {
              const it = unwrap(item) as Record<string, unknown>;
              items.push({
                slot: Number(it['Slot'] ?? 0),
                id: String(it['id'] ?? it['Id'] ?? ''),
                count: Number(it['Count'] ?? 1),
              });
            }
          }
        }

        blockEntities.push({
          type: String(unwrap(ent['Id']) ?? ''),
          pos: [Number(pos?.[0]) || 0, Number(pos?.[1]) || 0, Number(pos?.[2]) || 0],
          id: String(unwrap(ent['Id']) ?? ''),
          ...(items.length > 0 ? { items } : {}),
        });
      }
    }
  }

  return {
    version,
    dataVersion,
    width,
    height,
    length,
    palette,
    blockData,
    blockEntities,
    offset,
  };
}

/**
 * Parse a .schem file directly into a BlockGrid for easy manipulation.
 */
export async function parseToGrid(filepath: string): Promise<BlockGrid> {
  const data = await parseSchematic(filepath);
  return schematicToGrid(data);
}

/**
 * Convert SchematicData into a BlockGrid.
 */
export function schematicToGrid(data: SchematicData): BlockGrid {
  const { width, height, length, palette, blockData, blockEntities } = data;
  const grid = new BlockGrid(width, height, length);

  // Build reverse palette: ID -> block state string
  const reversePalette = new Map<number, string>();
  for (const [blockState, id] of palette.entries()) {
    reversePalette.set(id, blockState);
  }

  // Decode varint block data
  const totalBlocks = width * height * length;
  const blockIds = decodeAllVarints(blockData, totalBlocks);

  // Populate grid — block data is stored in YZX order
  const blockStates: string[] = [];
  for (let i = 0; i < totalBlocks; i++) {
    blockStates.push(reversePalette.get(blockIds[i]) ?? 'minecraft:air');
  }
  grid.loadFromArray(blockStates);

  // Restore block entities
  for (const entity of blockEntities) {
    // Block entities are already placed via the block data;
    // we just need to attach the entity data to the grid
    grid.blockEntities.push(entity);
  }

  return grid;
}

/**
 * Recursively unwrap prismarine-nbt's { type, value } format.
 */
function unwrap(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  // Handle prismarine-nbt tagged values: { type: string, value: ... }
  if (typeof val === 'object' && 'type' in (val as Record<string, unknown>) && 'value' in (val as Record<string, unknown>)) {
    return unwrap((val as Record<string, unknown>)['value']);
  }

  // Handle compounds (plain objects)
  if (typeof val === 'object' && !Array.isArray(val) && !(val instanceof Int8Array) && !(val instanceof Int32Array) && !(val instanceof Uint8Array)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[k] = unwrap(v);
    }
    return result;
  }

  // Handle arrays
  if (Array.isArray(val)) {
    return val.map(unwrap);
  }

  return val;
}

/** Helper to extract a numeric value from a parsed compound */
function getNum(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  if (val === undefined) return undefined;
  const unwrapped = unwrap(val);
  return typeof unwrapped === 'number' ? unwrapped : undefined;
}
