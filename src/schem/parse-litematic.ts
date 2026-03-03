/**
 * Parse Litematica .litematic files into BlockGrid.
 * Uses prismarine-nbt for NBT parsing (same pattern as parse.ts).
 *
 * Litematica format stores one or more named "regions", each with its own
 * dimensions, position, palette, and bit-packed block data (LongArray).
 * Regions can have negative Size dimensions — the position is then the
 * max corner and the actual min corner is `pos + size + 1`.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { parse as parseNbt } from 'prismarine-nbt';
import { BlockGrid } from './types.js';
import { decodeBitPackedStates, reconstructBlockState, calcBitsPerEntry } from './litematic-decode.js';

/** A single Litematica region with decoded block data */
export interface LitematicRegion {
  name: string;
  /** Absolute min corner after normalizing negative sizes */
  position: { x: number; y: number; z: number };
  width: number;
  height: number;
  length: number;
  /** Decoded block grid for this region */
  grid: BlockGrid;
}

/**
 * Parse a .litematic file into an array of regions.
 * Each region has its own BlockGrid.
 */
export async function parseLitematic(filepath: string): Promise<LitematicRegion[]> {
  const raw = readFileSync(filepath);
  const decompressed = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : Buffer.from(raw);
  const { parsed } = await parseNbt(decompressed);
  const root = unwrap(parsed) as Record<string, unknown>;

  const regionsTag = root['Regions'] as Record<string, unknown> | undefined;
  if (!regionsTag) {
    throw new Error('Invalid .litematic: missing Regions compound');
  }

  const regions: LitematicRegion[] = [];

  for (const [regionName, regionVal] of Object.entries(regionsTag)) {
    const region = regionVal as Record<string, unknown>;

    // Read raw Size (may have negative components)
    const sizeTag = region['Size'] as Record<string, unknown> | undefined;
    const rawW = getNum(sizeTag, 'x') ?? 0;
    const rawH = getNum(sizeTag, 'y') ?? 0;
    const rawL = getNum(sizeTag, 'z') ?? 0;

    // Read raw Position
    const posTag = region['Position'] as Record<string, unknown> | undefined;
    const posX = getNum(posTag, 'x') ?? 0;
    const posY = getNum(posTag, 'y') ?? 0;
    const posZ = getNum(posTag, 'z') ?? 0;

    // Normalize: negative size means pos is max corner
    const absW = Math.abs(rawW);
    const absH = Math.abs(rawH);
    const absL = Math.abs(rawL);
    const minX = rawW < 0 ? posX + rawW + 1 : posX;
    const minY = rawH < 0 ? posY + rawH + 1 : posY;
    const minZ = rawL < 0 ? posZ + rawL + 1 : posZ;

    if (absW === 0 || absH === 0 || absL === 0) continue;

    // Read palette: List of compounds with Name + optional Properties
    const paletteList = region['BlockStatePalette'] as unknown[];
    if (!paletteList || !Array.isArray(paletteList)) {
      throw new Error(`Region "${regionName}": missing BlockStatePalette`);
    }

    const palette: string[] = [];
    for (const entry of paletteList) {
      const e = entry as Record<string, unknown>;
      const name = (e['Name'] as string) ?? 'minecraft:air';
      const props = e['Properties'] as Record<string, string> | undefined;
      palette.push(reconstructBlockState(name, props));
    }

    // Read bit-packed block data
    const blockStatesRaw = region['BlockStates'] as BigInt64Array | unknown;
    if (!(blockStatesRaw instanceof BigInt64Array)) {
      throw new Error(`Region "${regionName}": BlockStates is not a LongArray`);
    }

    const totalBlocks = absW * absH * absL;
    const bitsPerEntry = calcBitsPerEntry(palette.length);
    const indices = decodeBitPackedStates(blockStatesRaw, bitsPerEntry, totalBlocks);

    // Build BlockGrid — Litematica index order: x + z * absW + y * absW * absL
    const grid = new BlockGrid(absW, absH, absL);
    const blockStates: string[] = new Array(totalBlocks);
    for (let i = 0; i < totalBlocks; i++) {
      blockStates[i] = palette[indices[i]] ?? 'minecraft:air';
    }

    // Litematica uses x + z * width + y * width * length (XZY),
    // but BlockGrid.loadFromArray expects YZX order: (y * length + z) * width + x.
    // Remap indices.
    const remapped: string[] = new Array(totalBlocks);
    for (let y = 0; y < absH; y++) {
      for (let z = 0; z < absL; z++) {
        for (let x = 0; x < absW; x++) {
          const litematicIdx = x + z * absW + y * absW * absL;
          const gridIdx = (y * absL + z) * absW + x;
          remapped[gridIdx] = blockStates[litematicIdx];
        }
      }
    }
    grid.loadFromArray(remapped);

    regions.push({
      name: regionName,
      position: { x: minX, y: minY, z: minZ },
      width: absW,
      height: absH,
      length: absL,
      grid,
    });
  }

  return regions;
}

/**
 * Parse a .litematic file and merge all regions into a single BlockGrid.
 * Computes the bounding box of all regions and composites them.
 */
export async function parseLitematicToGrid(filepath: string): Promise<BlockGrid> {
  const regions = await parseLitematic(filepath);
  if (regions.length === 0) {
    throw new Error('No regions found in .litematic file');
  }
  return mergeRegionsToGrid(regions);
}

/**
 * Merge multiple regions into a single BlockGrid.
 * Computes the combined bounding box and places each region at its offset.
 */
export function mergeRegionsToGrid(regions: LitematicRegion[]): BlockGrid {
  if (regions.length === 1) {
    return regions[0].grid;
  }

  // Compute bounding box across all regions
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const r of regions) {
    minX = Math.min(minX, r.position.x);
    minY = Math.min(minY, r.position.y);
    minZ = Math.min(minZ, r.position.z);
    maxX = Math.max(maxX, r.position.x + r.width);
    maxY = Math.max(maxY, r.position.y + r.height);
    maxZ = Math.max(maxZ, r.position.z + r.length);
  }

  const totalW = maxX - minX;
  const totalH = maxY - minY;
  const totalL = maxZ - minZ;
  const merged = new BlockGrid(totalW, totalH, totalL);

  // Place each region's blocks at the correct offset
  for (const r of regions) {
    const offX = r.position.x - minX;
    const offY = r.position.y - minY;
    const offZ = r.position.z - minZ;

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

// ─── NBT Helpers (same pattern as parse.ts) ────────────────────────────────

/** Recursively unwrap prismarine-nbt's { type, value } wrapper */
function unwrap(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object' && 'type' in (val as Record<string, unknown>) && 'value' in (val as Record<string, unknown>)) {
    return unwrap((val as Record<string, unknown>)['value']);
  }
  if (typeof val === 'object' && !Array.isArray(val)
    && !(val instanceof Int8Array) && !(val instanceof Int32Array)
    && !(val instanceof Uint8Array) && !(val instanceof BigInt64Array)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      result[k] = unwrap(v);
    }
    return result;
  }
  if (Array.isArray(val)) return val.map(unwrap);
  return val;
}

/** Extract a numeric value from an unwrapped compound */
function getNum(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!obj) return undefined;
  const val = obj[key];
  if (val === undefined) return undefined;
  const unwrapped = unwrap(val);
  if (typeof unwrapped === 'number') return unwrapped;
  if (typeof unwrapped === 'bigint') return Number(unwrapped);
  return undefined;
}
