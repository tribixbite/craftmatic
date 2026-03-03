/**
 * Write BlockGrid to Litematica .litematic format (v5).
 * Produces gzip-compressed NBT files compatible with the Litematica mod.
 *
 * NBT structure follows Litematica v5 format:
 * - Root compound with MinecraftDataVersion, Version, Metadata, Regions
 * - Single region with bit-packed LongArray BlockStates + palette
 * - Block entities stored as TileEntities list
 */

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { NBTWriter, TAG } from '../nbt/writer.js';
import { BlockGrid } from './types.js';
import { encodeBitPackedStates, decomposeBlockState, calcBitsPerEntry } from './litematic-encode.js';
import type { LitematicRegion } from './parse-litematic.js';

/** Default Minecraft data version (1.20.4) */
const DEFAULT_DATA_VERSION = 3700;

/** Litematica format version */
const LITEMATICA_VERSION = 5;

export interface LitematicOptions {
  /** Schematic name (default: "craftmatic") */
  name?: string;
  /** Author (default: "craftmatic") */
  author?: string;
  /** Description */
  description?: string;
  /** MC data version (default: 3700 = 1.20.4) */
  dataVersion?: number;
}

/**
 * Write a BlockGrid to a .litematic file.
 */
export function writeLitematic(
  grid: BlockGrid,
  filepath: string,
  options?: LitematicOptions,
): void {
  const nbt = encodeLitematicNBT(grid, options);
  const compressed = gzipSync(Buffer.from(nbt));
  writeFileSync(filepath, compressed);
}

/**
 * Encode a BlockGrid as raw .litematic NBT bytes (uncompressed).
 */
export function encodeLitematicNBT(
  grid: BlockGrid,
  options?: LitematicOptions,
): Uint8Array {
  const name = options?.name ?? 'craftmatic';
  const author = options?.author ?? 'craftmatic';
  const description = options?.description ?? '';
  const dataVersion = options?.dataVersion ?? DEFAULT_DATA_VERSION;
  const { width, height, length } = grid;
  const nonAirCount = grid.countNonAir();
  const totalVolume = width * height * length;
  const timestamp = BigInt(Math.floor(Date.now() / 1000));

  const w = new NBTWriter();

  // Root compound (empty name per NBT spec for root)
  w.writeTagHeader(TAG.COMPOUND, '');

  // MinecraftDataVersion
  w.writeTagHeader(TAG.INT, 'MinecraftDataVersion');
  w.writeInt(dataVersion);

  // Version
  w.writeTagHeader(TAG.INT, 'Version');
  w.writeInt(LITEMATICA_VERSION);

  // ─── Metadata ────────────────────────────────────────────────────────
  w.writeTagHeader(TAG.COMPOUND, 'Metadata');

  w.writeTagHeader(TAG.STRING, 'Name');
  w.writeString(name);
  w.writeTagHeader(TAG.STRING, 'Author');
  w.writeString(author);
  w.writeTagHeader(TAG.STRING, 'Description');
  w.writeString(description);
  w.writeTagHeader(TAG.INT, 'RegionCount');
  w.writeInt(1);
  w.writeTagHeader(TAG.LONG, 'TimeCreated');
  w.writeLong(timestamp);
  w.writeTagHeader(TAG.LONG, 'TimeModified');
  w.writeLong(timestamp);
  w.writeTagHeader(TAG.INT, 'TotalBlocks');
  w.writeInt(nonAirCount);
  w.writeTagHeader(TAG.INT, 'TotalVolume');
  w.writeInt(totalVolume);

  // EnclosingSize
  w.writeTagHeader(TAG.COMPOUND, 'EnclosingSize');
  w.writeTagHeader(TAG.INT, 'x');
  w.writeInt(width);
  w.writeTagHeader(TAG.INT, 'y');
  w.writeInt(height);
  w.writeTagHeader(TAG.INT, 'z');
  w.writeInt(length);
  w.writeEnd(); // end EnclosingSize

  w.writeEnd(); // end Metadata

  // ─── Regions ─────────────────────────────────────────────────────────
  w.writeTagHeader(TAG.COMPOUND, 'Regions');

  writeRegion(w, grid, name);

  w.writeEnd(); // end Regions
  w.writeEnd(); // end root compound

  return w.getBytes();
}

/**
 * Convert a BlockGrid to a single LitematicRegion (for programmatic use).
 */
export function gridToLitematicRegion(grid: BlockGrid, regionName = 'craftmatic'): LitematicRegion {
  return {
    name: regionName,
    position: { x: 0, y: 0, z: 0 },
    width: grid.width,
    height: grid.height,
    length: grid.length,
    grid,
  };
}

/**
 * Write a single region compound to the NBT stream.
 * Handles palette construction, index remapping (YZX → XZY), and bit-packing.
 */
function writeRegion(w: NBTWriter, grid: BlockGrid, regionName: string): void {
  const { width, height, length } = grid;

  w.writeTagHeader(TAG.COMPOUND, regionName);

  // Position (always 0,0,0 for single-region export)
  w.writeTagHeader(TAG.COMPOUND, 'Position');
  w.writeTagHeader(TAG.INT, 'x');
  w.writeInt(0);
  w.writeTagHeader(TAG.INT, 'y');
  w.writeInt(0);
  w.writeTagHeader(TAG.INT, 'z');
  w.writeInt(0);
  w.writeEnd();

  // Size
  w.writeTagHeader(TAG.COMPOUND, 'Size');
  w.writeTagHeader(TAG.INT, 'x');
  w.writeInt(width);
  w.writeTagHeader(TAG.INT, 'y');
  w.writeInt(height);
  w.writeTagHeader(TAG.INT, 'z');
  w.writeInt(length);
  w.writeEnd();

  // Build palette: map each unique blockState to an index
  // Litematica palette is a list (ordered), not a name→id map
  const paletteMap = new Map<string, number>();
  const paletteList: string[] = [];
  const totalBlocks = width * height * length;

  // Ensure "minecraft:air" is at index 0 (Litematica convention)
  paletteMap.set('minecraft:air', 0);
  paletteList.push('minecraft:air');

  // Collect all unique block states in XZY order (Litematica storage order)
  // and build the palette simultaneously
  const indices: number[] = new Array(totalBlocks);
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const bs = grid.get(x, y, z);
        let idx = paletteMap.get(bs);
        if (idx === undefined) {
          idx = paletteList.length;
          paletteMap.set(bs, idx);
          paletteList.push(bs);
        }
        // Litematica index order: x + z * width + y * width * length
        const litIdx = x + z * width + y * width * length;
        indices[litIdx] = idx;
      }
    }
  }

  // BlockStatePalette: list of compounds with Name + optional Properties
  w.writeTagHeader(TAG.LIST, 'BlockStatePalette');
  w.writeByte(TAG.COMPOUND);
  w.writeInt(paletteList.length);
  for (const blockState of paletteList) {
    const { name, properties } = decomposeBlockState(blockState);
    w.writeTagHeader(TAG.STRING, 'Name');
    w.writeString(name);
    if (properties) {
      w.writeTagHeader(TAG.COMPOUND, 'Properties');
      for (const [key, val] of Object.entries(properties)) {
        w.writeTagHeader(TAG.STRING, key);
        w.writeString(val);
      }
      w.writeEnd(); // end Properties
    }
    w.writeEnd(); // end palette entry compound
  }

  // BlockStates: bit-packed LongArray
  const bitsPerEntry = calcBitsPerEntry(paletteList.length);
  const packed = encodeBitPackedStates(indices, bitsPerEntry);
  w.writeTagHeader(TAG.LONG_ARRAY, 'BlockStates');
  w.writeLongArray(packed);

  // TileEntities (block entities)
  const entities = grid.blockEntities;
  w.writeTagHeader(TAG.LIST, 'TileEntities');
  if (entities.length > 0) {
    w.writeByte(TAG.COMPOUND);
    w.writeInt(entities.length);
    for (const entity of entities) {
      // Litematica tile entities use absolute position within the region
      w.writeTagHeader(TAG.STRING, 'id');
      w.writeString(entity.id);
      w.writeTagHeader(TAG.INT, 'x');
      w.writeInt(entity.pos[0]);
      w.writeTagHeader(TAG.INT, 'y');
      w.writeInt(entity.pos[1]);
      w.writeTagHeader(TAG.INT, 'z');
      w.writeInt(entity.pos[2]);

      // Items (chest/barrel inventory)
      if (entity.items && entity.items.length > 0) {
        w.writeTagHeader(TAG.LIST, 'Items');
        w.writeByte(TAG.COMPOUND);
        w.writeInt(entity.items.length);
        for (const item of entity.items) {
          w.writeTagHeader(TAG.BYTE, 'Slot');
          w.writeByte(item.slot);
          w.writeTagHeader(TAG.STRING, 'id');
          w.writeString(item.id);
          w.writeTagHeader(TAG.BYTE, 'Count');
          w.writeByte(item.count);
          w.writeEnd(); // end item
        }
      }

      // Sign text
      if (entity.text && entity.text.length > 0) {
        const lines = entity.text.slice(0, 4);
        while (lines.length < 4) lines.push('');
        for (let i = 0; i < 4; i++) {
          w.writeTagHeader(TAG.STRING, `Text${i + 1}`);
          w.writeString(JSON.stringify({ text: lines[i] }));
        }
      }

      w.writeEnd(); // end entity compound
    }
  } else {
    w.writeByte(TAG.COMPOUND);
    w.writeInt(0);
  }

  // Empty entity/tick lists (required by format)
  w.writeTagHeader(TAG.LIST, 'Entities');
  w.writeByte(TAG.COMPOUND);
  w.writeInt(0);

  w.writeTagHeader(TAG.LIST, 'PendingBlockTicks');
  w.writeByte(TAG.COMPOUND);
  w.writeInt(0);

  w.writeTagHeader(TAG.LIST, 'PendingFluidTicks');
  w.writeByte(TAG.COMPOUND);
  w.writeInt(0);

  w.writeEnd(); // end region compound
}
