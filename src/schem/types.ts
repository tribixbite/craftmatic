/**
 * BlockGrid — 3D grid of Minecraft block states with block entity tracking.
 * Core data structure for building and manipulating schematics.
 */

import type { BlockState, BlockEntity, ItemSlot, Vec3 } from '../types/index.js';

export class BlockGrid {
  readonly width: number;
  readonly height: number;
  readonly length: number;

  private blocks: BlockState[];
  private _palette: Map<BlockState, number>;
  private _nextId: number;
  private _blockEntities: BlockEntity[];

  constructor(width: number, height: number, length: number) {
    this.width = width;
    this.height = height;
    this.length = length;
    this.blocks = new Array<BlockState>(width * height * length).fill('minecraft:air');
    this._palette = new Map([['minecraft:air', 0]]);
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

  /** Get block state at position, returns "minecraft:air" for out-of-bounds */
  get(x: number, y: number, z: number): BlockState {
    if (!this.inBounds(x, y, z)) return 'minecraft:air';
    return this.blocks[this.index(x, y, z)];
  }

  /** Set block state at position. Silently ignores out-of-bounds. */
  set(x: number, y: number, z: number, blockState: BlockState): void {
    if (!this.inBounds(x, y, z)) return;
    if (!this._palette.has(blockState)) {
      this._palette.set(blockState, this._nextId++);
    }
    this.blocks[this.index(x, y, z)] = blockState;
  }

  /** Fill a rectangular region (inclusive on all axes) */
  fill(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockState: BlockState): void {
    const xMin = Math.min(x1, x2), xMax = Math.max(x1, x2);
    const yMin = Math.min(y1, y2), yMax = Math.max(y1, y2);
    const zMin = Math.min(z1, z2), zMax = Math.max(z1, z2);
    for (let y = yMin; y <= yMax; y++) {
      for (let z = zMin; z <= zMax; z++) {
        for (let x = xMin; x <= xMax; x++) {
          this.set(x, y, z, blockState);
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
    this.fill(x1, y1, z1, x2, y2, z2, 'minecraft:air');
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
    for (const bs of this.blocks) {
      const pid = this._palette.get(bs) ?? 0;
      // Varint encoding
      let value = pid;
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

  /** Count non-air blocks */
  countNonAir(): number {
    let count = 0;
    for (const bs of this.blocks) {
      if (bs !== 'minecraft:air') count++;
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
    if (blockStates.length !== this.blocks.length) {
      throw new Error(
        `Block array length mismatch: expected ${this.blocks.length}, got ${blockStates.length}`
      );
    }
    this._palette.clear();
    this._palette.set('minecraft:air', 0);
    this._nextId = 1;

    for (let i = 0; i < blockStates.length; i++) {
      const bs = blockStates[i];
      if (!this._palette.has(bs)) {
        this._palette.set(bs, this._nextId++);
      }
      this.blocks[i] = bs;
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
