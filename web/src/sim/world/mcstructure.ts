/**
 * Bedrock's `.mcstructure` read back into blocks, and laid into a world the
 * way `/structure load <id> x y z <r>_degrees` lays it.
 *
 * Format (https://wiki.bedrock.dev/nbt/mcstructure.html; the writer is
 * web/src/engine/mcstructure-encode.ts): `size` [X, Y, Z]; `structure.
 * block_indices` two layers of palette indices (-1 = void, the structure does
 * not touch that cell), cells Z fastest, then Y, then X; `structure.palette.
 * default.block_palette` the permutations `{ name, states }`.
 */

import { readNbtLE, type NbtValue } from './nbt.js';
import type { BlockStates } from './block-types.js';

/** A permutation as the structure names it. */
export interface StructureBlock { typeId: string; states: BlockStates }

export interface ParsedStructure {
  size: { x: number; y: number; z: number };
  palette: StructureBlock[];
  /** Layer 0, `x * sizeY * sizeZ + y * sizeZ + z` → palette index, -1 void. */
  indices: Int32Array;
  /** Layer 1 (the waterlogging layer), same indexing. */
  extra: Int32Array;
}

const obj = (v: NbtValue | undefined): Record<string, NbtValue> => (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) ? v as Record<string, NbtValue> : {});

/** Parse a `.mcstructure` file. */
export function parseMcstructure(bytes: Uint8Array): ParsedStructure {
  const root = readNbtLE(bytes);
  const size = (root['size'] as number[] | undefined) ?? [0, 0, 0];
  const structure = obj(root['structure']);
  const layers = (structure['block_indices'] as number[][] | undefined) ?? [];
  const paletteRaw = (obj(obj(structure['palette'])['default'])['block_palette'] as NbtValue[] | undefined) ?? [];
  const palette: StructureBlock[] = paletteRaw.map(p => {
    const c = obj(p);
    const states: BlockStates = {};
    for (const [k, v] of Object.entries(obj(c['states']))) states[k] = typeof v === 'bigint' ? Number(v) : (v as number | string);
    return { typeId: String(c['name'] ?? 'minecraft:air'), states };
  });
  return { size: { x: size[0]!, y: size[1]!, z: size[2]! }, palette, indices: Int32Array.from(layers[0] ?? []), extra: Int32Array.from(layers[1] ?? []) };
}

/** A quarter turn, degrees. */
export type StructureRotation = 0 | 90 | 180 | 270;

/**
 * Where structure cell (x, z) lands under a quarter turn, relative to the
 * load position (the turned footprint's minimum corner). The same mapping
 * the placement runtime uses for its own points and collider cells
 * (`pointAt` / `cellAt` in bedrock-placement-pack.ts), which the device
 * rounds proved against `structure load`.
 */
export function rotateStructureCell(x: number, z: number, sizeX: number, sizeZ: number, r: StructureRotation): { x: number; z: number } {
  if (r === 90) return { x: sizeZ - 1 - z, z: x };
  if (r === 180) return { x: sizeX - 1 - x, z: sizeZ - 1 - z };
  if (r === 270) return { x: z, z: sizeX - 1 - x };
  return { x, z };
}

/** Visit every non-void cell of a structure at a turn: `(dx, dy, dz, block)` from the load position. */
export function forEachStructureBlock(s: ParsedStructure, r: StructureRotation, visit: (dx: number, dy: number, dz: number, block: StructureBlock) => void): void {
  const { x: sx, y: sy, z: sz } = s.size;
  for (let x = 0; x < sx; x++) for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) {
    const i = s.indices[x * sy * sz + y * sz + z]!;
    if (i < 0) continue;
    const block = s.palette[i];
    if (!block) continue;
    const q = rotateStructureCell(x, z, sx, sz, r);
    visit(q.x, y, q.z, block);
  }
}
