/**
 * BlockGrid — 3D grid of Minecraft block states with block entity tracking.
 * Core data structure for building and manipulating schematics.
 *
 * Storage: palette-indexed Uint16Array for memory efficiency at high resolutions.
 * At resolution=10, a 50m building is 500³ = 125M voxels.
 * With string[]: 125M × ~40 bytes/ref = 5GB. With Uint16Array: 125M × 2 bytes = 250MB.
 */

import type { BlockState, BlockEntity, ItemSlot, Vec3 } from '../types/index.js';

/** Default air block — palette index 0 is always air. */
const AIR: BlockState = 'minecraft:air';

export class BlockGrid {
  width: number;
  height: number;
  readonly length: number;

  /** Palette-indexed voxel data. Index 0 = air. Max 65535 unique block types. */
  private data: Uint16Array;
  /** Block state string → palette index. */
  private _palette: Map<BlockState, number>;
  /** Palette index → block state string (reverse lookup for get()). */
  private _reversePalette: BlockState[];
  private _nextId: number;
  private _blockEntities: BlockEntity[];

  constructor(width: number, height: number, length: number) {
    this.width = width;
    this.height = height;
    this.length = length;
    const size = width * height * length;
    this.data = new Uint16Array(size); // All zeros = air (index 0)
    this._palette = new Map([[AIR, 0]]);
    this._reversePalette = [AIR]; // Index 0 = air
    this._nextId = 1;
    this._blockEntities = [];
  }

  /** Get the palette mapping block states to numeric IDs */
  get palette(): Map<BlockState, number> {
    return this._palette;
  }

  /** Get all block entities */
  get blockEntities(): BlockEntity[] {
    return this._blockEntities;
  }

  /** Convert (x, y, z) to a flat array index. Sponge Schematic ordering: (y * length + z) * width + x */
  private index(x: number, y: number, z: number): number {
    return (y * this.length + z) * this.width + x;
  }

  /** Check if coordinates are within bounds */
  inBounds(x: number, y: number, z: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height && z >= 0 && z < this.length;
  }

  /** Add a block state to the palette, returning its new index. */
  private _addToPalette(blockState: BlockState): number {
    if (this._nextId > 65535) {
      throw new Error(`BlockGrid palette overflow: more than 65535 unique block types`);
    }
    const id = this._nextId++;
    this._palette.set(blockState, id);
    this._reversePalette[id] = blockState;
    return id;
  }

  /** Get block state at position, returns "minecraft:air" for out-of-bounds */
  get(x: number, y: number, z: number): BlockState {
    if (!this.inBounds(x, y, z)) return AIR;
    return this._reversePalette[this.data[this.index(x, y, z)]];
  }

  /** Set block state at position. Silently ignores out-of-bounds. */
  set(x: number, y: number, z: number, blockState: BlockState): void {
    if (!this.inBounds(x, y, z)) return;
    const paletteId = this._palette.get(blockState) ?? this._addToPalette(blockState);
    this.data[this.index(x, y, z)] = paletteId;
  }

  /**
   * Get raw palette index at position (0 = air). Returns 0 for out-of-bounds.
   * Use for hot-path post-processing that can compare indices instead of strings.
   */
  getIndex(x: number, y: number, z: number): number {
    if (!this.inBounds(x, y, z)) return 0;
    return this.data[this.index(x, y, z)];
  }

  /**
   * Set by raw palette index. No bounds or palette validation — caller must ensure
   * the index is valid (obtained from getIndex or palette.get). Fastest mutation path.
   */
  setIndex(x: number, y: number, z: number, paletteIndex: number): void {
    if (!this.inBounds(x, y, z)) return;
    this.data[this.index(x, y, z)] = paletteIndex;
  }

  /** Resolve a palette index to its block state string. */
  blockStateFromIndex(paletteIndex: number): BlockState {
    return this._reversePalette[paletteIndex] ?? AIR;
  }

  /** Get the palette index for a block state, adding it if needed. */
  paletteIndexOf(blockState: BlockState): number {
    return this._palette.get(blockState) ?? this._addToPalette(blockState);
  }

  /** Fill a rectangular region (inclusive on all axes) */
  fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockState: BlockState): void {
    const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);
    const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);
    const pid = this._palette.get(blockState) ?? this._addToPalette(blockState);
    for (let y = yMin; y <= yMax; y++) {
      for (let z = zMin; z <= zMax; z++) {
        for (let x = xMin; x <= xMax; x++) {
          if (this.inBounds(x, y, z)) {
            this.data[this.index(x, y, z)] = pid;
          }
        }
      }
    }
  }

  /** Fill only the four vertical walls of a rectangular region (no floor/ceiling) */
  walls(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockState: BlockState): void {
    const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);
    const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);
    for (let y = yMin; y <= yMax; y++) {
      for (let z = zMin; z <= zMax; z++) {
        for (let x = xMin; x <= xMax; x++) {
          if (x === xMin || x === xMax || z === zMin || z === zMax) {
            this.set(x, y, z, blockState);
          }
        }
      }
    }
  }

  /** Clear a region to air */
  clear(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number): void {
    this.fill(x1, y1, z1, x2, y2, z2, AIR);
  }

  /** Place a chest block and register its inventory as a block entity */
  addChest(x: number, y: number, z: number, facing: string, items: ItemSlot[], trapped = false): void {
    const prefix = trapped ? 'trapped_' : '';
    const blockState: BlockState = `minecraft:${prefix}chest[facing=${facing}]`;
    this.set(x, y, z, blockState);
    this._blockEntities.push({
      type: 'chest',
      pos: [x, y, z],
      id: `minecraft:${prefix}chest`,
      items,
    });
  }

  /** Place a barrel with inventory contents */
  addBarrel(x: number, y: number, z: number, facing: string, items: ItemSlot[]): void {
    const blockState: BlockState = `minecraft:barrel[facing=${facing}]`;
    this.set(x, y, z, blockState);
    this._blockEntities.push({
      type: 'barrel',
      pos: [x, y, z],
      id: 'minecraft:barrel',
      items,
    });
  }

  /** Place a wall sign with text lines (up to 4) */
  addSign(x: number, y: number, z: number, facing: string, text: string[]): void {
    const blockState: BlockState = `minecraft:oak_wall_sign[facing=${facing}]`;
    this.set(x, y, z, blockState);
    // Pad to 4 lines
    const lines = [...text.slice(0, 4)];
    while (lines.length < 4) lines.push('');
    this._blockEntities.push({
      type: 'sign',
      pos: [x, y, z],
      id: 'minecraft:oak_wall_sign',
      text: lines,
    });
  }

  /** Encode block data as varint byte array for .schem format */
  encodeBlockData(): Uint8Array {
    const result: number[] = [];
    const len = this.data.length;
    for (let i = 0; i < len; i++) {
      // Varint encoding of palette index
      let value = this.data[i];
      while (true) {
        let byte = value & 0x7f;
        value >>>= 7;
        if (value !== 0) byte |= 0x80;
        result.push(byte);
        if (value === 0) break;
      }
    }
    return new Uint8Array(result);
  }

  /** Expand grid height upward (adds air layers on top) */
  expandHeight(newHeight: number): void {
    if (newHeight <= this.height) return;
    const newSize = this.width * newHeight * this.length;
    const newData = new Uint16Array(newSize); // All zeros = air (index 0)
    // Copy existing data — same index layout (y * length + z) * width + x
    for (let y = 0; y < this.height; y++) {
      for (let z = 0; z < this.length; z++) {
        const srcBase = (y * this.length + z) * this.width;
        const dstBase = (y * this.length + z) * this.width;
        for (let x = 0; x < this.width; x++) {
          newData[dstBase + x] = this.data[srcBase + x];
        }
      }
    }
    this.data = newData;
    this.height = newHeight;
  }

  /** Count non-air blocks */
  countNonAir(): number {
    let count = 0;
    const len = this.data.length;
    for (let i = 0; i < len; i++) {
      if (this.data[i] !== 0) count++; // Index 0 = air
    }
    return count;
  }

  /** Get total block count (including air) */
  get totalBlocks(): number {
    return this.width * this.height * this.length;
  }

  /** Get dimensions as Vec3 */
  get dimensions(): Vec3 {
    return [this.width, this.height, this.length];
  }

  /**
   * Load block data from a flat array of block state strings.
   * Used when reconstructing a grid from parsed schematic data.
   */
  loadFromArray(blockStates: BlockState[]): void {
    const expectedLen = this.width * this.height * this.length;
    if (blockStates.length !== expectedLen) {
      throw new Error(
        `Block array length mismatch: expected ${expectedLen}, got ${blockStates.length}`
      );
    }
    this._palette.clear();
    this._palette.set(AIR, 0);
    this._reversePalette = [AIR];
    this._nextId = 1;

    for (let i = 0; i < blockStates.length; i++) {
      const bs = blockStates[i];
      let pid = this._palette.get(bs);
      if (pid === undefined) {
        pid = this._addToPalette(bs);
      }
      this.data[i] = pid;
    }
  }

  /**
   * Get block states as a 3D array [y][z][x] for renderer compatibility.
   */
  to3DArray(): BlockState[][][] {
    const result: BlockState[][][] = [];
    for (let y = 0; y < this.height; y++) {
      const layer: BlockState[][] = [];
      for (let z = 0; z < this.length; z++) {
        const row: BlockState[] = [];
        for (let x = 0; x < this.width; x++) {
          row.push(this.get(x, y, z));
        }
        layer.push(row);
      }
      result.push(layer);
    }
    return result;
  }
}
