/**
 * Lightweight grid checkpoint system for iterative pipeline refinement.
 *
 * Saves named snapshots of BlockGrid state to disk as compressed binary files.
 * Each snapshot captures the grid's dimensions, palette, and block data so the
 * full grid can be restored without re-running earlier pipeline stages.
 *
 * Binary format (gzipped):
 *   4 bytes: width (uint32 LE)
 *   4 bytes: height (uint32 LE)
 *   4 bytes: length (uint32 LE)
 *   4 bytes: palette size (uint32 LE)
 *   For each palette entry:
 *     4 bytes: string byte length (uint32 LE)
 *     N bytes: UTF-8 encoded block state string
 *   Grid data: width*height*length × 2 bytes (uint16 LE palette indices)
 *
 * Usage:
 *   initCheckpoints('/path/to/output');
 *   await saveCheckpoint(grid, 'post-voxelize');
 *   // ... later ...
 *   const restored = await loadCheckpoint('post-mask');
 */

import { BlockGrid } from '../schem/types.js';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Metadata for a saved checkpoint (returned by save/list operations). */
export interface GridCheckpoint {
  name: string;
  timestamp: number;
  width: number;
  height: number;
  length: number;
  blockCount: number;
  paletteSize: number;
}

// ─── Module state ───────────────────────────────────────────────────────────

/** Checkpoint storage directory (set by initCheckpoints) */
let checkpointDir = '';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize checkpoint system with output directory.
 * Creates a `.checkpoints/` subdirectory if it doesn't exist.
 */
export function initCheckpoints(outputDir: string): void {
  checkpointDir = join(outputDir, '.checkpoints');
  mkdirSync(checkpointDir, { recursive: true });
}

/**
 * Save a named checkpoint of the current grid state.
 *
 * Serializes the grid's dimensions, palette, and block data into a binary
 * format, gzip-compresses it, and writes to `{name}.ckpt.gz`.
 *
 * @param grid  The BlockGrid to snapshot
 * @param name  Checkpoint name (e.g. "post-voxelize", "post-mask")
 * @returns Metadata about the saved checkpoint
 */
export async function saveCheckpoint(grid: BlockGrid, name: string): Promise<GridCheckpoint> {
  if (!checkpointDir) {
    throw new Error('Checkpoint system not initialized — call initCheckpoints() first');
  }

  const { width, height, length } = grid;

  // Build palette: collect all unique block states in insertion order
  const paletteEntries: string[] = [];
  const paletteMap = new Map<string, number>();
  // Always reserve index 0 for air
  paletteEntries.push('minecraft:air');
  paletteMap.set('minecraft:air', 0);

  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        if (!paletteMap.has(block)) {
          paletteMap.set(block, paletteEntries.length);
          paletteEntries.push(block);
        }
      }
    }
  }

  // Encode palette strings to UTF-8
  const encoder = new TextEncoder();
  const encodedPalette: Uint8Array[] = paletteEntries.map(s => encoder.encode(s));

  // Compute total buffer size
  // Header: 4 × uint32 = 16 bytes
  // Palette: for each entry, 4 bytes length + N bytes string data
  let paletteBytes = 0;
  for (const enc of encodedPalette) {
    paletteBytes += 4 + enc.byteLength;
  }
  // Grid data: W*H*L × 2 bytes (uint16)
  const gridDataBytes = width * height * length * 2;
  const totalBytes = 16 + paletteBytes + gridDataBytes;

  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  let offset = 0;

  // Write header
  view.setUint32(offset, width, true); offset += 4;
  view.setUint32(offset, height, true); offset += 4;
  view.setUint32(offset, length, true); offset += 4;
  view.setUint32(offset, paletteEntries.length, true); offset += 4;

  // Write palette entries: [length:u32][data:u8[]]
  for (const enc of encodedPalette) {
    view.setUint32(offset, enc.byteLength, true); offset += 4;
    new Uint8Array(buffer, offset, enc.byteLength).set(enc);
    offset += enc.byteLength;
  }

  // Write grid data as palette indices
  const gridView = new Uint16Array(buffer, offset, width * height * length);
  let idx = 0;
  for (let y = 0; y < height; y++) {
    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const block = grid.get(x, y, z);
        gridView[idx++] = paletteMap.get(block) ?? 0;
      }
    }
  }

  // Gzip compress and write
  const compressed = gzipSync(new Uint8Array(buffer));
  const filePath = join(checkpointDir, `${name}.ckpt.gz`);
  await Bun.write(filePath, compressed);

  const blockCount = grid.countNonAir();
  const sizeMB = (compressed.byteLength / (1024 * 1024)).toFixed(1);
  console.log(`Checkpoint: saved '${name}' (${sizeMB} MB, ${blockCount.toLocaleString()} blocks, palette=${paletteEntries.length})`);

  return {
    name,
    timestamp: Date.now(),
    width,
    height,
    length,
    blockCount,
    paletteSize: paletteEntries.length,
  };
}

/**
 * List all available checkpoints in the checkpoint directory.
 * Returns metadata parsed from checkpoint files, sorted by timestamp.
 */
export function listCheckpoints(): GridCheckpoint[] {
  if (!checkpointDir) return [];

  try {
    const files = readdirSync(checkpointDir).filter(f => f.endsWith('.ckpt.gz'));
    const checkpoints: GridCheckpoint[] = [];

    for (const file of files) {
      const name = file.replace('.ckpt.gz', '');
      const filePath = join(checkpointDir, file);
      const stat = statSync(filePath);

      // For listing, we store timestamp from file mtime; full metadata requires reading
      checkpoints.push({
        name,
        timestamp: stat.mtimeMs,
        width: 0, // Populated on load
        height: 0,
        length: 0,
        blockCount: 0,
        paletteSize: 0,
      });
    }

    return checkpoints.sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

/**
 * Restore a BlockGrid from a named checkpoint.
 *
 * Reads the compressed binary file, decompresses, and reconstructs the grid
 * with the saved palette and block data.
 *
 * @param name  Checkpoint name (without .ckpt.gz extension)
 * @returns A new BlockGrid with the saved state
 * @throws If the checkpoint file doesn't exist or is corrupted
 */
export async function loadCheckpoint(name: string): Promise<BlockGrid> {
  if (!checkpointDir) {
    throw new Error('Checkpoint system not initialized — call initCheckpoints() first');
  }

  const filePath = join(checkpointDir, `${name}.ckpt.gz`);
  const compressed = await Bun.file(filePath).arrayBuffer();
  const data = gunzipSync(new Uint8Array(compressed));
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  // Read header
  const width = view.getUint32(offset, true); offset += 4;
  const height = view.getUint32(offset, true); offset += 4;
  const length = view.getUint32(offset, true); offset += 4;
  const paletteSize = view.getUint32(offset, true); offset += 4;

  // Read palette entries
  const palette: string[] = [];
  for (let i = 0; i < paletteSize; i++) {
    const strLen = view.getUint32(offset, true); offset += 4;
    const strBytes = new Uint8Array(data.buffer, data.byteOffset + offset, strLen);
    palette.push(decoder.decode(strBytes));
    offset += strLen;
  }

  // Create grid and populate from palette indices
  const grid = new BlockGrid(width, height, length);
  const totalVoxels = width * height * length;

  // Read uint16 palette indices. Ensure alignment-safe reads.
  let blockCount = 0;
  for (let i = 0; i < totalVoxels; i++) {
    const paletteIdx = view.getUint16(offset, true); offset += 2;
    if (paletteIdx > 0 && paletteIdx < palette.length) {
      // Decompose flat index back to (x, y, z) using Sponge ordering: (y*L+z)*W+x
      const x = i % width;
      const z = Math.floor(i / width) % length;
      const y = Math.floor(i / (width * length));
      grid.set(x, y, z, palette[paletteIdx]);
      blockCount++;
    }
    // paletteIdx === 0 is air, which is the default — no need to set
  }

  console.log(`Checkpoint: loaded '${name}' (${width}x${height}x${length}, ${blockCount.toLocaleString()} blocks, palette=${paletteSize})`);

  return grid;
}

/**
 * Delete all checkpoint files in the checkpoint directory.
 */
export function clearCheckpoints(): void {
  if (!checkpointDir) return;

  try {
    const files = readdirSync(checkpointDir).filter(f => f.endsWith('.ckpt.gz'));
    for (const file of files) {
      rmSync(join(checkpointDir, file));
    }
    if (files.length > 0) {
      console.log(`Checkpoint: cleared ${files.length} checkpoint(s)`);
    }
  } catch {
    // Directory may not exist — ignore
  }
}
