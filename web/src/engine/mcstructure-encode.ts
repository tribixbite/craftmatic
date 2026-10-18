/**
 * `.mcstructure` encoder — Minecraft **Bedrock Edition**'s native placeable
 * structure format.
 *
 * WHY this exists: the only way to get a Craftmatic model into Bedrock used to
 * be converting our Java `.schem` with an external tool, and that hop is where
 * quality is lost — a Java→Bedrock converter that does not rename ids drops
 * every block whose Bedrock name differs (holes), and one that does not
 * translate state names loses every stair facing and every top slab. Writing
 * Bedrock's own format directly removes the hop; `engine/bedrock-blocks.ts`
 * owns the translation and is verified against Mojang's published registry.
 *
 * FORMAT (https://wiki.bedrock.dev/nbt/mcstructure.html):
 *   • little-endian NBT, **uncompressed, with no file header** (unlike Bedrock's
 *     `level.dat`, which carries an 8-byte version+length prefix);
 *   • root TAG_Compound with an empty name, holding
 *       TAG_Int      format_version           = 1
 *       TAG_List     size                     3 × TAG_Int  [X, Y, Z]
 *       TAG_Compound structure
 *         TAG_List     block_indices          2 × TAG_List of TAG_Int
 *         TAG_List     entities               (empty)
 *         TAG_Compound palette
 *           TAG_Compound default
 *             TAG_List     block_palette      TAG_Compound { name, states, version }
 *             TAG_Compound block_position_data (empty — we write no block entities)
 *       TAG_List     structure_world_origin   3 × TAG_Int
 *   • `block_indices` holds TWO parallel layers sharing one palette (layer 0 is
 *     the block, layer 1 the "extra" block used for waterlogging). `-1` means a
 *     void — a cell the structure does not touch.
 *   • cells iterate **Z fastest, then Y, then X** (the wiki's 2×3×4 example runs
 *     (0,0,0) (0,0,1) (0,0,2) (0,0,3) (0,1,0) …), i.e.
 *     `index = x * sizeY * sizeZ + y * sizeZ + z`.
 *
 * Both editions use +X east / +Y up / +Z south, so grid coordinates carry over
 * unchanged — there is no axis flip to get wrong.
 */

import type { BlockGrid } from '@craft/schem/types.js';
import { ByteWriter } from './byte-writer.js';
import { toBedrockBlock, type BedrockBlock } from './bedrock-blocks.js';

// NBT tag ids (shared with Java NBT; only the byte order differs).
const TAG_END = 0, TAG_BYTE = 1, TAG_INT = 3, TAG_STRING = 8, TAG_LIST = 9, TAG_COMPOUND = 10;

/** `.mcstructure` container revision. 1 is the only version Bedrock writes. */
export const MCSTRUCTURE_FORMAT_VERSION = 1;

/**
 * The `version` int stamped into every `block_palette` entry: Bedrock's packed
 * block version `(major << 24) | (minor << 16) | (patch << 8) | revision`.
 *
 * 18163712 = 0x01152800 = **1.21.40.0**, which is deliberately the SAME version
 * the block table was generated from (`bedrock-block-states.json`, pinned to
 * `bedrock-samples@v1.21.40.3`) and the same version `BEDROCK_MIN_ENGINE`
 * declares. That three-way agreement is the point:
 *   • Bedrock runs its block-state upgrade schemas FORWARD from the stamp, so a
 *     newer client silently corrects anything renamed since 1.21.40 — a stamp
 *     NEWER than the client has no downgrade path at all, which is the only
 *     direction that is undocumented;
 *   • the names are era-consistent with the stamp, so on a 1.21.40 client every
 *     schema is a no-op rather than a rewrite of a name it thinks is old.
 * Stamping an older version is known to work in the field (packs shipping
 * 1.18.10.1 still load), which is why the older direction is the safe one.
 *
 * This is the one value in the encoder whose EFFECT cannot be verified without
 * running a Bedrock client; the arithmetic is confirmed against the documented
 * 18168865 = 0x01153C21 = 1.21.60.33.
 */
export const BEDROCK_BLOCK_VERSION = 18163712;

/**
 * `min_engine_version` for the generated pack: 1.21.40, the oldest release in
 * which every block id we emit exists (see scripts/gen-bedrock-blocks.mjs for
 * the wave-by-wave measurement). Declaring a HIGHER version would refuse the
 * pack on clients that can run it perfectly well; a LOWER one would promise ids
 * that release does not have.
 */
export const BEDROCK_MIN_ENGINE: readonly [number, number, number] = [1, 21, 40];

/** Bedrock's structure-block volume limit: 64 wide, 384 tall, 64 deep. */
export const BEDROCK_MAX_TILE = { x: 64, y: 384, z: 64 } as const;

/** Index of a cell the structure leaves untouched. */
const VOID_INDEX = -1;

/** One `.mcstructure` file's worth of the model. */
export interface StructureTile {
  /** Structure name inside the pack namespace, e.g. `colosseum_10276_x1_z0`. */
  name: string;
  /** Origin of the tile in grid coordinates (inclusive, trimmed to content). */
  x: number; y: number; z: number;
  /** Tile size in blocks. */
  width: number; height: number; length: number;
  /** Position in the tiling lattice, before trimming — used for the name. */
  ix: number; iy: number; iz: number;
  /** Non-air blocks inside the tile. */
  nonAir: number;
}

/**
 * Split a grid into `.mcstructure`-sized tiles.
 *
 * Two reductions, both of which matter because `block_indices` costs a flat
 * 4 bytes per cell per layer (no run-length, no bit packing):
 *   • a lattice cell with no blocks at all is dropped entirely;
 *   • a lattice cell that is kept is TRIMMED to its own occupied bounding box,
 *     which on a typical model removes most of the empty headroom above it.
 * The trim is why each tile carries its own grid origin: the caller turns those
 * into the per-tile placement offsets, so trimming costs the user nothing.
 */
export function planStructureTiles(
  grid: BlockGrid,
  stem: string,
  max: { x: number; y: number; z: number } = BEDROCK_MAX_TILE,
): StructureTile[] {
  const nx = Math.max(1, Math.ceil(grid.width / max.x));
  const ny = Math.max(1, Math.ceil(grid.height / max.y));
  const nz = Math.max(1, Math.ceil(grid.length / max.z));
  const single = nx === 1 && ny === 1 && nz === 1;
  const tiles: StructureTile[] = [];

  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      for (let iz = 0; iz < nz; iz++) {
        const x0 = ix * max.x, y0 = iy * max.y, z0 = iz * max.z;
        const x1 = Math.min(grid.width, x0 + max.x);
        const y1 = Math.min(grid.height, y0 + max.y);
        const z1 = Math.min(grid.length, z0 + max.z);

        // Occupied bounding box within this lattice cell.
        let minX = x1, minY = y1, minZ = z1, maxX = x0 - 1, maxY = y0 - 1, maxZ = z0 - 1, nonAir = 0;
        for (let y = y0; y < y1; y++) {
          for (let z = z0; z < z1; z++) {
            for (let x = x0; x < x1; x++) {
              if (grid.getIndex(x, y, z) === 0) continue;
              nonAir++;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (y < minY) minY = y; if (y > maxY) maxY = y;
              if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
          }
        }
        if (nonAir === 0) continue;

        tiles.push({
          name: single ? stem : `${stem}_x${ix}_y${iy}_z${iz}`,
          x: minX, y: minY, z: minZ,
          width: maxX - minX + 1, height: maxY - minY + 1, length: maxZ - minZ + 1,
          ix, iy, iz, nonAir,
        });
      }
    }
  }
  return tiles;
}

export interface McstructureResult {
  bytes: Uint8Array;
  /** Distinct Bedrock blocks in this tile's palette. */
  paletteSize: number;
  /** Java palette entries with no Bedrock mapping (written as air). */
  unmapped: string[];
}

/**
 * Encode one tile of a grid as `.mcstructure` bytes.
 *
 * Air cells are written as an explicit `minecraft:air` palette entry rather than
 * as voids, so placing the structure CLEARS its bounding box — a model dropped
 * into a hillside cuts the hill instead of having terrain poke through its
 * interior. Layer 1 is all voids: we never waterlog anything.
 */
export function encodeMcstructureTile(grid: BlockGrid, tile: StructureTile): McstructureResult {
  const { x, y, z, width, height, length } = tile;
  const volume = width * height * length;

  // Per-tile palette: grid palette index → bedrock palette index, built lazily
  // so a tile only carries the blocks it actually uses.
  const remap = new Int32Array(grid.palette.size + 1).fill(-1);
  const palette: BedrockBlock[] = [];
  const unmapped: string[] = [];
  const indices = new Int32Array(volume);

  const resolve = (gid: number): number => {
    const cached = remap[gid]!;
    if (cached >= 0) return cached;
    const javaEntry = grid.blockStateFromIndex(gid);
    const bedrock = toBedrockBlock(javaEntry);
    if (!bedrock) unmapped.push(javaEntry);
    const idx = palette.length;
    palette.push(bedrock ?? { name: 'minecraft:air', states: {} });
    remap[gid] = idx;
    return idx;
  };

  // Z fastest, then Y, then X (the format's documented cell order).
  let i = 0;
  for (let dx = 0; dx < width; dx++) {
    for (let dy = 0; dy < height; dy++) {
      for (let dz = 0; dz < length; dz++) {
        indices[i++] = resolve(grid.getIndex(x + dx, y + dy, z + dz));
      }
    }
  }

  // 8 bytes/cell of block_indices + generous room for the palette and headers.
  const w = new ByteWriter(volume * 8 + 4096 + palette.length * 256);
  const enc = new TextEncoder();
  const name = (type: number, tagName: string) => { w.u8(type); w.nbtStringLE(tagName, enc); };
  const intList = (tagName: string, values: readonly number[]) => {
    name(TAG_LIST, tagName);
    w.u8(TAG_INT);
    w.u32le(values.length);
    for (const v of values) w.u32le(v);
  };

  w.u8(TAG_COMPOUND); w.nbtStringLE('', enc);           // root, unnamed

  name(TAG_INT, 'format_version'); w.u32le(MCSTRUCTURE_FORMAT_VERSION);
  intList('size', [width, height, length]);

  name(TAG_COMPOUND, 'structure');

  // block_indices: a list of exactly two int lists sharing one palette.
  name(TAG_LIST, 'block_indices');
  w.u8(TAG_LIST);
  w.u32le(2);
  w.u8(TAG_INT); w.u32le(volume);
  for (let k = 0; k < volume; k++) w.u32le(indices[k]!);
  w.u8(TAG_INT); w.u32le(volume);
  for (let k = 0; k < volume; k++) w.u32le(VOID_INDEX);

  // An empty list, written the way vanilla writes one: element type TAG_End.
  name(TAG_LIST, 'entities'); w.u8(TAG_END); w.u32le(0);

  name(TAG_COMPOUND, 'palette');
  name(TAG_COMPOUND, 'default');
  name(TAG_LIST, 'block_palette');
  w.u8(TAG_COMPOUND);
  w.u32le(palette.length);
  for (const block of palette) {
    name(TAG_STRING, 'name'); w.nbtStringLE(block.name, enc);
    name(TAG_COMPOUND, 'states');
    for (const [key, value] of Object.entries(block.states)) writeState(w, enc, key, value);
    w.u8(TAG_END);
    name(TAG_INT, 'version'); w.u32le(BEDROCK_BLOCK_VERSION);
    w.u8(TAG_END);                                       // end this palette entry
  }
  // Present but empty: we write no block entities or tick queues.
  name(TAG_COMPOUND, 'block_position_data'); w.u8(TAG_END);
  w.u8(TAG_END);                                         // end default
  w.u8(TAG_END);                                         // end palette
  w.u8(TAG_END);                                         // end structure

  intList('structure_world_origin', [0, 0, 0]);
  w.u8(TAG_END);                                         // end root

  return { bytes: w.toUint8Array(), paletteSize: palette.length, unmapped };
}

/**
 * Write one block state.
 *
 * Bedrock's three state types map to three NBT tags and the tag MUST match what
 * the block expects — a byte where an int belongs makes the permutation
 * unresolvable, which is how "the block is there but every stair faces north"
 * happens. `bedrock-blocks.ts` carries the type from Mojang's registry, so a
 * boolean arrives as a boolean and an int as a number.
 */
function writeState(
  w: ByteWriter, enc: TextEncoder, key: string, value: string | number | boolean,
): void {
  if (typeof value === 'boolean') {
    w.u8(TAG_BYTE); w.nbtStringLE(key, enc); w.u8(value ? 1 : 0);
  } else if (typeof value === 'number') {
    w.u8(TAG_INT); w.nbtStringLE(key, enc); w.u32le(value);
  } else {
    w.u8(TAG_STRING); w.nbtStringLE(key, enc); w.nbtStringLE(value, enc);
  }
}
