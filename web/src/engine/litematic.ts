/**
 * Browser-compatible .litematic file parser.
 * Decompresses gzip with pako, parses NBT with custom browser parser,
 * decodes bit-packed blocks via shared litematic-decode utilities.
 */

import pako from 'pako';
import { parseNBT, type NBTCompound, type NBTValue } from './nbt.js';
import { BlockGrid } from '@craft/schem/types.js';
import {
  decodeBitPackedStates, reconstructBlockState, calcBitsPerEntry,
} from '@craft/schem/litematic-decode.js';

/** A parsed region with position and dimensions */
interface LitematicRegion {
  name: string;
  position: { x: number; y: number; z: number };
  width: number;
  height: number;
  length: number;
  grid: BlockGrid;
}

/**
 * Parse a .litematic file from raw bytes in the browser → BlockGrid.
 * Handles multi-region files by computing bounding box and compositing.
 */
export async function parseLitematicFile(fileBytes: ArrayBuffer): Promise<BlockGrid> {
  // Decompress gzip
  const compressed = new Uint8Array(fileBytes);
  let decompressed: Uint8Array;
  try {
    decompressed = pako.inflate(compressed);
  } catch {
    decompressed = compressed;
  }

  // Parse NBT
  const { value: root } = parseNBT(decompressed);

  const regionsTag = root['Regions'] as NBTCompound | undefined;
  if (!regionsTag) {
    throw new Error('Invalid .litematic: missing Regions compound');
  }

  const regions: LitematicRegion[] = [];

  for (const [regionName, regionVal] of Object.entries(regionsTag)) {
    const region = regionVal as NBTCompound;

    // Read Size compound (may have negative components)
    const sizeTag = region['Size'] as NBTCompound | undefined;
    const rawW = asNumber(sizeTag?.['x']);
    const rawH = asNumber(sizeTag?.['y']);
    const rawL = asNumber(sizeTag?.['z']);

    // Read Position compound
    const posTag = region['Position'] as NBTCompound | undefined;
    const posX = asNumber(posTag?.['x']);
    const posY = asNumber(posTag?.['y']);
    const posZ = asNumber(posTag?.['z']);

    // Normalize negative dimensions
    const absW = Math.abs(rawW);
    const absH = Math.abs(rawH);
    const absL = Math.abs(rawL);
    const minX = rawW < 0 ? posX + rawW + 1 : posX;
    const minY = rawH < 0 ? posY + rawH + 1 : posY;
    const minZ = rawL < 0 ? posZ + rawL + 1 : posZ;

    if (absW === 0 || absH === 0 || absL === 0) continue;

    // Read palette: List of compounds with Name + optional Properties
    const paletteList = region['BlockStatePalette'] as NBTValue[];
    if (!paletteList || !Array.isArray(paletteList)) {
      throw new Error(`Region "${regionName}": missing BlockStatePalette`);
    }

    const palette: string[] = [];
    for (const entry of paletteList) {
      const e = entry as NBTCompound;
      const name = (e['Name'] as string) ?? 'minecraft:air';
      const props = e['Properties'] as Record<string, string> | undefined;
      palette.push(reconstructBlockState(name, props));
    }

    // Read bit-packed block data (LongArray → BigInt64Array)
    const blockStatesRaw = region['BlockStates'];
    if (!(blockStatesRaw instanceof BigInt64Array)) {
      throw new Error(`Region "${regionName}": BlockStates is not a LongArray`);
    }

    const totalBlocks = absW * absH * absL;
    const bitsPerEntry = calcBitsPerEntry(palette.length);
    const indices = decodeBitPackedStates(blockStatesRaw, bitsPerEntry, totalBlocks);

    // Build BlockGrid — remap from Litematica XZY order to BlockGrid YZX order
    const grid = new BlockGrid(absW, absH, absL);
    const remapped: string[] = new Array(totalBlocks);
    for (let y = 0; y < absH; y++) {
      for (let z = 0; z < absL; z++) {
        for (let x = 0; x < absW; x++) {
          const litematicIdx = x + z * absW + y * absW * absL;
          const gridIdx = (y * absL + z) * absW + x;
          remapped[gridIdx] = palette[indices[litematicIdx]] ?? 'minecraft:air';
        }
      }
    }
    grid.loadFromArray(remapped);

    regions.push({
      name: regionName,
      position: { x: minX, y: minY, z: minZ },
      width: absW, height: absH, length: absL,
      grid,
    });
  }

  if (regions.length === 0) {
    throw new Error('No regions found in .litematic file');
  }

  // Single region — return directly
  if (regions.length === 1) return regions[0].grid;

  // Multi-region: compute bounding box and composite
  let bbMinX = Infinity, bbMinY = Infinity, bbMinZ = Infinity;
  let bbMaxX = -Infinity, bbMaxY = -Infinity, bbMaxZ = -Infinity;
  for (const r of regions) {
    bbMinX = Math.min(bbMinX, r.position.x);
    bbMinY = Math.min(bbMinY, r.position.y);
    bbMinZ = Math.min(bbMinZ, r.position.z);
    bbMaxX = Math.max(bbMaxX, r.position.x + r.width);
    bbMaxY = Math.max(bbMaxY, r.position.y + r.height);
    bbMaxZ = Math.max(bbMaxZ, r.position.z + r.length);
  }

  const merged = new BlockGrid(bbMaxX - bbMinX, bbMaxY - bbMinY, bbMaxZ - bbMinZ);
  for (const r of regions) {
    const offX = r.position.x - bbMinX;
    const offY = r.position.y - bbMinY;
    const offZ = r.position.z - bbMinZ;
    for (let y = 0; y < r.height; y++) {
      for (let z = 0; z < r.length; z++) {
        for (let x = 0; x < r.width; x++) {
          const bs = r.grid.get(x, y, z);
          if (bs !== 'minecraft:air') {
            merged.set(x + offX, y + offY, z + offZ, bs);
          }
        }
      }
    }
  }
  return merged;
}

/** Safely coerce an NBT value to a JS number */
function asNumber(val: NBTValue | undefined): number {
  if (val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'bigint') return Number(val);
  return 0;
}
