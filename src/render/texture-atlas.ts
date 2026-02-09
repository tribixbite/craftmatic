/**
 * Hybrid texture atlas — loads real open-source PNG textures where
 * available (ProgrammerArt CC-BY 4.0), falling back to procedural
 * 16x16 pixel textures for blocks without bundled assets.
 *
 * Procedural textures use seeded patterns (noise, grain, brick, etc.)
 * to approximate the Minecraft look.
 */

import type { AtlasUV, BlockFace, BlockFaceMap, RGB } from '../types/index.js';
import { getBlockColor } from '../blocks/colors.js';
import { getBlockTextures } from '../blocks/textures.js';
import { Writable } from 'node:stream';
import { existsSync, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TILE = 16; // Texture resolution per block face

/** Seeded PRNG for deterministic texture generation */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Texture Pattern Generators ──────────────────────────────────────────────

/** Pattern type for a texture */
type PatternType = 'solid' | 'noise' | 'grain' | 'brick' | 'speckle' | 'plank' | 'checkerboard' | 'cross' | 'dots' | 'shelf';

/** Generate a 16x16 RGBA pixel array for a given color and pattern */
function generateTexture(baseColor: RGB, pattern: PatternType, seed: number = 0): Uint8Array {
  const data = new Uint8Array(TILE * TILE * 4);
  const rng = mulberry32(seed);
  const [r, g, b] = baseColor;

  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const idx = (y * TILE + x) * 4;
      let pr = r, pg = g, pb = b;

      switch (pattern) {
        case 'noise': {
          // Subtle random noise (stone, dirt, gravel)
          const n = (rng() - 0.5) * 20;
          pr = clamp(r + n);
          pg = clamp(g + n);
          pb = clamp(b + n);
          break;
        }
        case 'grain': {
          // Vertical grain pattern (wood planks)
          const grainX = Math.sin(x * 1.5 + seed * 0.1) * 8;
          const n2 = (rng() - 0.5) * 10;
          const brightness = grainX + n2;
          pr = clamp(r + brightness);
          pg = clamp(g + brightness);
          pb = clamp(b + brightness);
          // Plank edge lines
          if (y === 0 || y === TILE - 1) {
            pr = clamp(r - 25); pg = clamp(g - 25); pb = clamp(b - 25);
          }
          break;
        }
        case 'brick': {
          // Brick pattern with mortar lines
          const brickH = 4;
          const brickW = 8;
          const row = Math.floor(y / brickH);
          const offset = (row % 2) * (brickW / 2);
          const localY = y % brickH;
          const localX = (x + offset) % brickW;
          if (localY === 0 || localX === 0) {
            // Mortar
            pr = clamp(r + 40); pg = clamp(g + 40); pb = clamp(b + 40);
          } else {
            const n3 = (rng() - 0.5) * 12;
            pr = clamp(r + n3);
            pg = clamp(g + n3);
            pb = clamp(b + n3);
          }
          break;
        }
        case 'speckle': {
          // Random speckle pattern (granite, diorite)
          const n4 = (rng() - 0.5) * 30;
          pr = clamp(r + n4);
          pg = clamp(g + n4 * 0.8);
          pb = clamp(b + n4 * 0.6);
          break;
        }
        case 'plank': {
          // Horizontal plank pattern with grain and joints
          const plankH = 4;
          const localPY = y % plankH;
          const grainVal = Math.sin(x * 0.8 + Math.floor(y / plankH) * 3.7) * 6;
          const n5 = (rng() - 0.5) * 8;
          if (localPY === 0) {
            // Joint line
            pr = clamp(r - 30); pg = clamp(g - 30); pb = clamp(b - 30);
          } else {
            pr = clamp(r + grainVal + n5);
            pg = clamp(g + grainVal + n5);
            pb = clamp(b + grainVal + n5);
          }
          break;
        }
        case 'checkerboard': {
          // Subtle checkerboard (polished stone)
          const check = ((Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0) ? 5 : -5;
          pr = clamp(r + check);
          pg = clamp(g + check);
          pb = clamp(b + check);
          break;
        }
        case 'cross': {
          // Cross/plus pattern (chiseled blocks)
          const cx = TILE / 2, cy = TILE / 2;
          const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
          if ((dx < 2 && dy < 6) || (dy < 2 && dx < 6)) {
            pr = clamp(r + 20); pg = clamp(g + 20); pb = clamp(b + 20);
          } else if (x === 0 || x === TILE - 1 || y === 0 || y === TILE - 1) {
            pr = clamp(r - 20); pg = clamp(g - 20); pb = clamp(b - 20);
          } else {
            const n6 = (rng() - 0.5) * 8;
            pr = clamp(r + n6); pg = clamp(g + n6); pb = clamp(b + n6);
          }
          break;
        }
        case 'dots': {
          // Small dot pattern (end stone, prismarine)
          const dotSpacing = 4;
          const isDot = (x % dotSpacing === 1) && (y % dotSpacing === 1);
          if (isDot) {
            pr = clamp(r + 25); pg = clamp(g + 25); pb = clamp(b + 25);
          } else {
            const n7 = (rng() - 0.5) * 8;
            pr = clamp(r + n7); pg = clamp(g + n7); pb = clamp(b + n7);
          }
          break;
        }
        case 'shelf': {
          // Bookshelf pattern — books on middle rows
          if (y < 2 || y > 13) {
            // Wood planks (top/bottom shelf)
            const grainS = Math.sin(x * 0.9) * 4;
            pr = clamp(162 + grainS); pg = clamp(130 + grainS); pb = clamp(78 + grainS);
          } else if (y === 2 || y === 8 || y === 13) {
            // Shelf divider
            pr = clamp(r - 40); pg = clamp(g - 40); pb = clamp(b - 40);
          } else {
            // Book spines — varying colors
            const bookIdx = Math.floor(x / 2) + Math.floor((y - 3) / 5) * 8;
            const bookRng = mulberry32(bookIdx + seed);
            const hue = bookRng() * 360;
            const bookColor = hslToRgb(hue, 0.4, 0.35);
            pr = bookColor[0]; pg = bookColor[1]; pb = bookColor[2];
            // Book edge
            if (x % 2 === 0 && x > 0) {
              pr = clamp(pr - 15); pg = clamp(pg - 15); pb = clamp(pb - 15);
            }
          }
          break;
        }
        default:
          // Solid color
          pr = r; pg = g; pb = b;
          break;
      }

      data[idx] = pr;
      data[idx + 1] = pg;
      data[idx + 2] = pb;
      data[idx + 3] = 255;
    }
  }

  return data;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Convert HSL to RGB */
function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0, g1 = 0, b1 = 0;
  if (h < 60) { r1 = c; g1 = x; }
  else if (h < 120) { r1 = x; g1 = c; }
  else if (h < 180) { g1 = c; b1 = x; }
  else if (h < 240) { g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; b1 = c; }
  else { r1 = c; b1 = x; }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

// ─── Block → Pattern Mapping ─────────────────────────────────────────────────

/** Determine the best pattern for a texture name */
function getPattern(textureName: string): PatternType {
  if (textureName.includes('planks') || textureName.includes('plank')) return 'plank';
  if (textureName.includes('log_top') || textureName.includes('_end')) return 'cross';
  if (textureName.includes('log') || textureName.includes('wood')) return 'grain';
  if (textureName.includes('brick')) return 'brick';
  if (textureName.includes('stone_brick') || textureName.includes('chiseled')) return 'checkerboard';
  if (textureName.includes('polished') || textureName.includes('smooth')) return 'checkerboard';
  if (textureName.includes('stone') || textureName.includes('cobble')) return 'noise';
  if (textureName.includes('dirt') || textureName.includes('gravel') || textureName.includes('sand')) return 'noise';
  if (textureName.includes('granite') || textureName.includes('diorite') || textureName.includes('andesite')) return 'speckle';
  if (textureName.includes('deepslate')) return 'noise';
  if (textureName.includes('end_stone')) return 'dots';
  if (textureName.includes('prismarine')) return 'dots';
  if (textureName === 'bookshelf') return 'shelf';
  if (textureName.includes('concrete') || textureName.includes('terracotta')) return 'noise';
  if (textureName.includes('wool') || textureName.includes('carpet')) return 'noise';
  if (textureName.includes('glass')) return 'solid';
  if (textureName.includes('quartz')) return 'checkerboard';
  if (textureName.includes('obsidian')) return 'noise';
  if (textureName.includes('netherrack') || textureName.includes('nether')) return 'speckle';
  return 'noise';
}

/** Hash a string to a seed number */
function hashString(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return hash;
}

// ─── Atlas Builder ───────────────────────────────────────────────────────────

/** Atlas entry: position and UV coordinates in the atlas */
interface AtlasEntry {
  textureName: string;
  x: number;   // Pixel position in atlas
  y: number;
  uv: AtlasUV;
  data: Uint8Array;  // 16x16 RGBA pixel data
}

/** Pre-built atlas containing all textures */
let cachedAtlas: ProceduralAtlas | null = null;

/** Procedural texture atlas */
export class ProceduralAtlas {
  readonly entries: Map<string, AtlasEntry>;
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  private pixelData: Uint8Array | null = null;

  constructor(textureNames: string[], blockColors: Map<string, RGB>) {
    this.tileSize = TILE;
    this.entries = new Map();

    // Deduplicate texture names
    const uniqueNames = [...new Set(textureNames)];
    const count = uniqueNames.length;

    // Calculate atlas dimensions (square-ish power of 2)
    this.columns = Math.ceil(Math.sqrt(count));
    this.rows = Math.ceil(count / this.columns);
    this.width = this.columns * TILE;
    this.height = this.rows * TILE;

    // Generate each texture and place it in the atlas
    for (let i = 0; i < uniqueNames.length; i++) {
      const name = uniqueNames[i];
      const col = i % this.columns;
      const row = Math.floor(i / this.columns);
      const px = col * TILE;
      const py = row * TILE;

      // Get base color for this texture
      const color = blockColors.get(name) ?? blockColors.get(`minecraft:${name}`) ?? [128, 128, 128];
      const pattern = getPattern(name);
      const seed = hashString(name);
      const data = generateTexture(color, pattern, seed);

      this.entries.set(name, {
        textureName: name,
        x: px,
        y: py,
        uv: {
          u: px / this.width,
          v: py / this.height,
          w: TILE / this.width,
          h: TILE / this.height,
        },
        data,
      });
    }
  }

  /** Get UV coordinates for a texture name */
  getUV(textureName: string): AtlasUV {
    const entry = this.entries.get(textureName);
    if (entry) return entry.uv;
    // Fallback: full atlas
    return { u: 0, v: 0, w: TILE / this.width, h: TILE / this.height };
  }

  /** Get the full atlas as a flat RGBA pixel buffer */
  getPixelData(): Uint8Array {
    if (this.pixelData) return this.pixelData;

    this.pixelData = new Uint8Array(this.width * this.height * 4);

    for (const entry of this.entries.values()) {
      // Copy tile into atlas at (entry.x, entry.y)
      for (let ty = 0; ty < TILE; ty++) {
        for (let tx = 0; tx < TILE; tx++) {
          const srcIdx = (ty * TILE + tx) * 4;
          const dstIdx = ((entry.y + ty) * this.width + (entry.x + tx)) * 4;
          this.pixelData[dstIdx] = entry.data[srcIdx];
          this.pixelData[dstIdx + 1] = entry.data[srcIdx + 1];
          this.pixelData[dstIdx + 2] = entry.data[srcIdx + 2];
          this.pixelData[dstIdx + 3] = entry.data[srcIdx + 3];
        }
      }
    }

    return this.pixelData;
  }

  /** Export atlas as PNG buffer */
  async toPNG(): Promise<Buffer> {
    const pureimage = await import('pureimage');
    const img = pureimage.make(this.width, this.height);
    const pixels = this.getPixelData();
    for (let i = 0; i < this.width * this.height * 4; i++) {
      img.data[i] = pixels[i];
    }
    const chunks: Buffer[] = [];
    const ws = new Writable({
      write(chunk: Buffer, _encoding: string, callback: () => void) {
        chunks.push(chunk);
        callback();
      },
    });
    await pureimage.encodePNGToStream(img, ws);
    return Buffer.concat(chunks);
  }

  /** Export atlas UV mapping as JSON */
  toJSON(): Record<string, AtlasUV> {
    const result: Record<string, AtlasUV> = {};
    for (const [name, entry] of this.entries) {
      result[name] = entry.uv;
    }
    return result;
  }

  /**
   * Load real PNG textures from a directory, replacing procedural entries.
   * Files should be named `{textureName}.png` (e.g. `oak_planks.png`).
   * Returns the number of textures successfully loaded.
   */
  async loadRealTextures(textureDir: string): Promise<number> {
    let pureimage: typeof import('pureimage');
    try {
      pureimage = await import('pureimage');
    } catch {
      return 0; // pureimage not available
    }

    let loaded = 0;
    for (const [name, entry] of this.entries) {
      const filePath = join(textureDir, name + '.png');
      if (!existsSync(filePath)) continue;

      try {
        const stream = createReadStream(filePath);
        const img = await pureimage.decodePNGFromStream(stream);
        const data = new Uint8Array(TILE * TILE * 4);

        // Copy pixel data, handling potential size mismatch
        const srcW = Math.min(TILE, img.width);
        const srcH = Math.min(TILE, img.height);
        for (let y = 0; y < srcH; y++) {
          for (let x = 0; x < srcW; x++) {
            const srcIdx = (y * img.width + x) * 4;
            const dstIdx = (y * TILE + x) * 4;
            data[dstIdx] = img.data[srcIdx];
            data[dstIdx + 1] = img.data[srcIdx + 1];
            data[dstIdx + 2] = img.data[srcIdx + 2];
            data[dstIdx + 3] = img.data[srcIdx + 3];
          }
        }

        entry.data = data;
        loaded++;
      } catch {
        // Keep procedural fallback for this entry
      }
    }

    // Clear cached pixel data so it gets rebuilt with real textures
    this.pixelData = null;
    return loaded;
  }

  /**
   * Build a hybrid atlas: real textures where available, procedural fallback.
   * Looks for PNG files in the bundled textures/blocks/ directory.
   */
  static async buildHybrid(
    textureNames: string[],
    blockColors: Map<string, RGB>,
  ): Promise<ProceduralAtlas> {
    const atlas = new ProceduralAtlas(textureNames, blockColors);
    const textureDir = findTextureDir();
    if (textureDir) {
      const loaded = await atlas.loadRealTextures(textureDir);
      if (loaded > 0) {
        // eslint-disable-next-line no-console
        console.log(`  Loaded ${loaded} real textures from ${textureDir}`);
      }
    }
    return atlas;
  }
}

// ─── Texture Directory Discovery ─────────────────────────────────────────────

/**
 * Find the bundled textures/blocks/ directory.
 * Searches relative to this module's location and the package root.
 */
function findTextureDir(): string | null {
  // Try multiple paths relative to the package
  const candidates = [
    // When running from dist/ (compiled)
    join(dirname(fileURLToPath(import.meta.url)), '../../textures/blocks'),
    // When running from src/ (dev)
    join(dirname(fileURLToPath(import.meta.url)), '../../textures/blocks'),
    // Absolute fallback for common locations
    join(process.cwd(), 'textures/blocks'),
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Common block texture names that should be in every atlas */
const COMMON_TEXTURES = [
  // Stone variants
  'stone', 'cobblestone', 'stone_bricks', 'chiseled_stone_bricks', 'mossy_stone_bricks',
  'polished_andesite', 'polished_diorite', 'polished_granite',
  'andesite', 'diorite', 'granite',
  'deepslate', 'deepslate_bricks', 'polished_deepslate', 'polished_blackstone', 'polished_blackstone_bricks',
  // Wood planks
  'oak_planks', 'spruce_planks', 'birch_planks', 'dark_oak_planks', 'acacia_planks', 'jungle_planks',
  // Logs
  'oak_log', 'oak_log_top', 'spruce_log', 'spruce_log_top',
  'birch_log', 'birch_log_top', 'dark_oak_log', 'dark_oak_log_top',
  // Stripped logs
  'stripped_oak_log', 'stripped_oak_log_top', 'stripped_dark_oak_log', 'stripped_dark_oak_log_top',
  'stripped_spruce_log', 'stripped_spruce_log_top',
  // Concrete
  'white_concrete', 'gray_concrete', 'light_gray_concrete', 'black_concrete',
  'red_concrete', 'blue_concrete', 'green_concrete', 'yellow_concrete',
  'orange_concrete', 'cyan_concrete', 'purple_concrete', 'pink_concrete',
  // Bricks & terracotta
  'bricks', 'nether_bricks', 'red_nether_bricks', 'end_stone_bricks',
  'terracotta', 'white_terracotta',
  // Glass
  'glass',
  // Quartz
  'quartz_block_side', 'quartz_block_top', 'quartz_block_bottom', 'quartz_pillar', 'smooth_quartz',
  // Functional
  'bookshelf', 'crafting_table_top', 'crafting_table_side',
  'furnace_top', 'furnace_front',
  // Misc
  'obsidian', 'glowstone', 'sea_lantern', 'prismarine',
  'gold_block', 'diamond_block', 'emerald_block', 'lapis_block', 'iron_block',
  'netherrack', 'gilded_blackstone',
  // Ground
  'dirt', 'sand', 'gravel', 'clay',
  // Wool
  'white_wool', 'red_wool', 'blue_wool',
  // Carpet
  'red_carpet', 'blue_carpet', 'cyan_carpet', 'yellow_carpet', 'white_carpet',
  'black_carpet', 'purple_carpet', 'green_carpet', 'brown_carpet', 'gray_carpet',
  'light_gray_carpet',
];

/** Build a color map from block colors for texture generation */
function buildColorMap(): Map<string, RGB> {
  const map = new Map<string, RGB>();
  for (const name of COMMON_TEXTURES) {
    const color = getBlockColor(`minecraft:${name}`);
    if (color) {
      map.set(name, color);
    }
  }
  return map;
}

/**
 * Build or get the default texture atlas (procedural only, sync).
 * Use `initDefaultAtlas()` first for hybrid real+procedural textures.
 */
export function getDefaultAtlas(): ProceduralAtlas {
  if (!cachedAtlas) {
    const colors = buildColorMap();
    cachedAtlas = new ProceduralAtlas(COMMON_TEXTURES, colors);
  }
  return cachedAtlas;
}

/**
 * Initialize the default atlas with real textures where available.
 * Call this once before rendering for best quality output.
 * Falls back gracefully to all-procedural if textures aren't found.
 */
export async function initDefaultAtlas(): Promise<ProceduralAtlas> {
  if (!cachedAtlas) {
    const colors = buildColorMap();
    cachedAtlas = await ProceduralAtlas.buildHybrid(COMMON_TEXTURES, colors);
  }
  return cachedAtlas;
}

/**
 * Get UV coordinates for a block face from the procedural atlas.
 */
export function getBlockFaceUV(blockState: string, face: BlockFace): AtlasUV {
  const atlas = getDefaultAtlas();
  const textures = getBlockTextures(blockState);
  const textureName = textures[face];
  return atlas.getUV(textureName);
}

/**
 * Get all face UVs for a block.
 */
export function getBlockUVs(blockState: string): BlockFaceMap {
  const atlas = getDefaultAtlas();
  const textures = getBlockTextures(blockState);
  return {
    top: atlas.getUV(textures.top),
    bottom: atlas.getUV(textures.bottom),
    north: atlas.getUV(textures.north),
    south: atlas.getUV(textures.south),
    east: atlas.getUV(textures.east),
    west: atlas.getUV(textures.west),
  };
}

/**
 * Build a custom atlas from a list of block states.
 * Useful for building project-specific atlases.
 */
export function buildAtlasForBlocks(blockStates: string[]): ProceduralAtlas {
  const textureNames = new Set<string>();
  for (const bs of blockStates) {
    const textures = getBlockTextures(bs);
    textureNames.add(textures.top);
    textureNames.add(textures.bottom);
    textureNames.add(textures.north);
    textureNames.add(textures.south);
    textureNames.add(textures.east);
    textureNames.add(textures.west);
  }
  const colors = buildColorMap();
  // Add colors for non-common textures
  for (const name of textureNames) {
    if (!colors.has(name)) {
      const color = getBlockColor(`minecraft:${name}`);
      if (color) colors.set(name, color);
    }
  }
  return new ProceduralAtlas([...textureNames], colors);
}
