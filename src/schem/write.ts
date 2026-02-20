/**
 * Write SchematicData / BlockGrid to Sponge Schematic v2 (.schem) format.
 * Produces gzip-compressed NBT binary files compatible with WorldEdit.
 */

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { NBTWriter, TAG } from '../nbt/writer.js';
import { BlockGrid } from './types.js';
import type { SchematicData, BlockEntity } from '../types/index.js';

/** Default Minecraft data version (1.20.4) */
const DEFAULT_DATA_VERSION = 3700;

/**
 * Write a BlockGrid to a .schem file.
 */
export function writeSchematic(grid: BlockGrid, filepath: string, dataVersion?: number): void {
  const data = gridToSchematic(grid, dataVersion);
  writeSchematicData(data, filepath);
}

/**
 * Convert a BlockGrid into SchematicData.
 */
export function gridToSchematic(grid: BlockGrid, dataVersion = DEFAULT_DATA_VERSION): SchematicData {
  return {
    version: 2,
    dataVersion,
    width: grid.width,
    height: grid.height,
    length: grid.length,
    palette: new Map(grid.palette),
    blockData: grid.encodeBlockData(),
    blockEntities: [...grid.blockEntities],
    offset: [0, 0, 0],
  };
}

/**
 * Write SchematicData to a .schem file (gzip-compressed NBT).
 */
export function writeSchematicData(data: SchematicData, filepath: string): void {
  const nbt = encodeSchematicNBT(data);
  const compressed = gzipSync(Buffer.from(nbt));
  writeFileSync(filepath, compressed);
}

/**
 * Encode SchematicData as raw NBT bytes (uncompressed).
 */
export function encodeSchematicNBT(data: SchematicData): Uint8Array {
  const w = new NBTWriter();

  // Root compound tag named "Schematic"
  w.writeTagHeader(TAG.COMPOUND, 'Schematic');

  // Version
  w.writeTagHeader(TAG.INT, 'Version');
  w.writeInt(data.version);

  // DataVersion
  w.writeTagHeader(TAG.INT, 'DataVersion');
  w.writeInt(data.dataVersion);

  // Dimensions
  w.writeTagHeader(TAG.SHORT, 'Width');
  w.writeShort(data.width);
  w.writeTagHeader(TAG.SHORT, 'Height');
  w.writeShort(data.height);
  w.writeTagHeader(TAG.SHORT, 'Length');
  w.writeShort(data.length);

  // Offset
  w.writeTagHeader(TAG.INT_ARRAY, 'Offset');
  w.writeIntArray([data.offset[0], data.offset[1], data.offset[2]]);

  // PaletteMax
  w.writeTagHeader(TAG.INT, 'PaletteMax');
  w.writeInt(data.palette.size);

  // Palette compound
  w.writeTagHeader(TAG.COMPOUND, 'Palette');
  for (const [blockState, id] of data.palette.entries()) {
    w.writeTagHeader(TAG.INT, blockState);
    w.writeInt(id);
  }
  w.writeEnd(); // end Palette

  // BlockData (byte array)
  w.writeTagHeader(TAG.BYTE_ARRAY, 'BlockData');
  w.writeByteArray(data.blockData);

  // Block entities
  if (data.blockEntities.length > 0) {
    writeBlockEntities(w, data.blockEntities);
  }

  w.writeEnd(); // end root Schematic compound

  return w.getBytes();
}

/**
 * Write block entities as an NBT list of compounds.
 */
function writeBlockEntities(w: NBTWriter, entities: BlockEntity[]): void {
  w.writeTagHeader(TAG.LIST, 'BlockEntities');
  w.writeByte(TAG.COMPOUND); // list element type
  w.writeInt(entities.length);

  for (const entity of entities) {
    // Each entity is a compound (no header for list elements)

    // Id
    w.writeTagHeader(TAG.STRING, 'Id');
    w.writeString(entity.id);

    // Pos
    w.writeTagHeader(TAG.INT_ARRAY, 'Pos');
    w.writeIntArray([entity.pos[0], entity.pos[1], entity.pos[2]]);

    // Items (if present — chest/barrel inventory)
    if (entity.items && entity.items.length > 0) {
      w.writeTagHeader(TAG.LIST, 'Items');
      w.writeByte(TAG.COMPOUND); // list element type
      w.writeInt(entity.items.length);

      for (const item of entity.items) {
        // Slot
        w.writeTagHeader(TAG.BYTE, 'Slot');
        w.writeByte(item.slot);

        // id
        w.writeTagHeader(TAG.STRING, 'id');
        w.writeString(item.id);

        // Count
        w.writeTagHeader(TAG.BYTE, 'Count');
        w.writeByte(item.count);

        w.writeEnd(); // end item compound
      }
    }

    // Sign text (if present — wall_sign / standing sign)
    if (entity.text && entity.text.length > 0) {
      const lines = entity.text.slice(0, 4);
      while (lines.length < 4) lines.push('');
      // Modern format (1.20+): front_text compound with messages list
      writeSignFace(w, 'front_text', lines);
      writeSignFace(w, 'back_text', ['', '', '', '']);
      // Legacy format: Text1-Text4 string tags (pre-1.20 compatibility)
      for (let i = 0; i < 4; i++) {
        w.writeTagHeader(TAG.STRING, `Text${i + 1}`);
        w.writeString(JSON.stringify({ text: lines[i] }));
      }
    }

    w.writeEnd(); // end entity compound
  }
}

/** Write a sign face compound (front_text or back_text) with 4 message lines */
function writeSignFace(w: NBTWriter, name: string, lines: string[]): void {
  w.writeTagHeader(TAG.COMPOUND, name);

  // messages: list of 4 strings (JSON text components)
  w.writeTagHeader(TAG.LIST, 'messages');
  w.writeByte(TAG.STRING);
  w.writeInt(4);
  for (let i = 0; i < 4; i++) {
    w.writeString(JSON.stringify({ text: lines[i] || '' }));
  }

  w.writeTagHeader(TAG.STRING, 'color');
  w.writeString('black');

  w.writeTagHeader(TAG.BYTE, 'has_glowing_text');
  w.writeByte(0);

  w.writeEnd(); // end face compound
}
