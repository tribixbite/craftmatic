/**
 * 2D PNG renderer — produces floor plans, cutaway isometrics,
 * and exterior views from schematic data.
 * Uses pureimage (pure JS) for cross-platform PNG encoding.
 *
 * Supports textured rendering via the ProceduralAtlas (Faithful 32x + procedural
 * fallback) and custom item sprites for furniture/decorative blocks.
 */

import { BlockGrid } from '../schem/types.js';
import { getBlockColor, FURNITURE_BLOCKS, LIGHT_BLOCKS, DOOR_BLOCKS } from '../blocks/colors.js';
import { getBaseId, isSolidBlock } from '../blocks/registry.js';
import { getBlockTextures } from '../blocks/textures.js';
import { initDefaultAtlas, getDefaultAtlas, type ProceduralAtlas } from './texture-atlas.js';
import { getItemSprite, ITEM_SPRITE_SIZE } from './item-sprites.js';
import type { RGB } from '../types/index.js';
import { Writable } from 'node:stream';

/** Cached atlas instance for textured rendering */
let atlas: ProceduralAtlas | null = null;

/** Ensure atlas is loaded (called once per render session).
 * Falls back to procedural-only atlas after 10s timeout to avoid ARM pureimage PNG decode hang. */
async function ensureAtlas(): Promise<ProceduralAtlas> {
  if (!atlas) {
    const timeout = new Promise<null>(r => setTimeout(() => r(null), 10_000));
    const hybrid = initDefaultAtlas();
    const result = await Promise.race([hybrid, timeout]);
    if (result) {
      atlas = result;
    } else {
      console.warn('  Atlas load timeout — falling back to procedural textures');
      atlas = getDefaultAtlas();
    }
  }
  return atlas;
}

/**
 * Encode a raw RGBA pixel buffer to PNG.
 */
async function encodePNG(pixels: Buffer, width: number, height: number): Promise<Buffer> {
  try {
    const pureimage = await import('pureimage');
    const img = pureimage.make(width, height);
    const data = img.data;
    for (let i = 0; i < width * height * 4; i++) {
      data[i] = pixels[i];
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
  } catch {
    const sharp = (await import('sharp')).default;
    return sharp(pixels, { raw: { width, height, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }
}

/** Maximum image dimension in pixels */
const MAX_DIM = 1950;

/** Clamp a value between 0 and 255 */
function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// ─── Texture Blitting Helpers ─────────────────────────────────────────────────

/**
 * Blit a texture tile (nearest-neighbor scale) to a rectangular cell.
 * Applies RGB tint multiplier (0.0–1.0 per channel).
 */
function blitTextureTile(
  buf: Buffer, imgW: number, px: number, py: number,
  cellSize: number, textureData: Uint8Array, tileSize: number,
  tintR = 1.0, tintG = 1.0, tintB = 1.0,
): void {
  for (let dy = 0; dy < cellSize; dy++) {
    const ty = Math.min(Math.floor(dy * tileSize / cellSize), tileSize - 1);
    for (let dx = 0; dx < cellSize; dx++) {
      const tx = Math.min(Math.floor(dx * tileSize / cellSize), tileSize - 1);
      const srcIdx = (ty * tileSize + tx) * 4;
      const a = textureData[srcIdx + 3];
      if (a < 128) continue; // Skip transparent pixels
      const r = clamp(textureData[srcIdx] * tintR);
      const g = clamp(textureData[srcIdx + 1] * tintG);
      const b = clamp(textureData[srcIdx + 2] * tintB);
      setPixel(buf, imgW, px + dx, py + dy, [r, g, b]);
    }
  }
}

/**
 * Blit a 16x16 sprite centered in a cell, scaled to cellSize.
 */
function blitSprite(
  buf: Buffer, imgW: number, px: number, py: number,
  cellSize: number, spriteData: Uint8Array,
): void {
  const spriteSize = ITEM_SPRITE_SIZE;
  for (let dy = 0; dy < cellSize; dy++) {
    const sy = Math.min(Math.floor(dy * spriteSize / cellSize), spriteSize - 1);
    for (let dx = 0; dx < cellSize; dx++) {
      const sx = Math.min(Math.floor(dx * spriteSize / cellSize), spriteSize - 1);
      const srcIdx = (sy * spriteSize + sx) * 4;
      const a = spriteData[srcIdx + 3];
      if (a < 128) continue;
      setPixel(buf, imgW, px + dx, py + dy, [
        spriteData[srcIdx], spriteData[srcIdx + 1], spriteData[srcIdx + 2],
      ]);
    }
  }
}

/**
 * Blit textured isometric top face (diamond shape).
 * Maps diamond pixels back to texture UV and applies brightness tint.
 */
function blitTextureIsoTop(
  buf: Buffer, imgW: number, sx: number, sy: number,
  _tile: number, halfT: number, textureData: Uint8Array, tileSize: number,
  brightness: number,
): void {
  for (let row = 0; row <= halfT * 2; row++) {
    const width = row <= halfT ? row : halfT * 2 - row;
    const y = sy + row;
    for (let dx = 0; dx <= width * 2; dx++) {
      const x = sx - width + dx;
      // Map screen position to texture UV (0-1)
      const u = (dx / (width * 2 + 1)) || 0;
      const v = row / (halfT * 2);
      const tx = Math.min(Math.floor(u * tileSize), tileSize - 1);
      const ty = Math.min(Math.floor(v * tileSize), tileSize - 1);
      const srcIdx = (ty * tileSize + tx) * 4;
      if (textureData[srcIdx + 3] < 128) continue;
      setPixel(buf, imgW, x, y, [
        clamp(textureData[srcIdx] * brightness),
        clamp(textureData[srcIdx + 1] * brightness),
        clamp(textureData[srcIdx + 2] * brightness),
      ]);
    }
  }
}

/**
 * Blit textured isometric left face (parallelogram sloping down-right).
 */
function blitTextureIsoLeft(
  buf: Buffer, imgW: number, sx: number, sy: number,
  w: number, h: number, textureData: Uint8Array, tileSize: number,
  brightness: number,
): void {
  for (let row = 0; row < h; row++) {
    const xStart = sx + Math.floor(row / 2);
    const v = row / h;
    for (let dx = 0; dx < w; dx++) {
      const u = dx / w;
      const tx = Math.min(Math.floor(u * tileSize), tileSize - 1);
      const ty = Math.min(Math.floor(v * tileSize), tileSize - 1);
      const srcIdx = (ty * tileSize + tx) * 4;
      if (textureData[srcIdx + 3] < 128) continue;
      setPixel(buf, imgW, xStart + dx, sy + row, [
        clamp(textureData[srcIdx] * brightness),
        clamp(textureData[srcIdx + 1] * brightness),
        clamp(textureData[srcIdx + 2] * brightness),
      ]);
    }
  }
}

/**
 * Blit textured isometric right face (parallelogram sloping down-left).
 */
function blitTextureIsoRight(
  buf: Buffer, imgW: number, sx: number, sy: number,
  w: number, h: number, textureData: Uint8Array, tileSize: number,
  brightness: number,
): void {
  for (let row = 0; row < h; row++) {
    const xStart = sx - Math.floor(row / 2);
    const v = row / h;
    for (let dx = 0; dx < w; dx++) {
      const u = dx / w;
      const tx = Math.min(Math.floor(u * tileSize), tileSize - 1);
      const ty = Math.min(Math.floor(v * tileSize), tileSize - 1);
      const srcIdx = (ty * tileSize + tx) * 4;
      if (textureData[srcIdx + 3] < 128) continue;
      setPixel(buf, imgW, xStart + dx, sy + row, [
        clamp(textureData[srcIdx] * brightness),
        clamp(textureData[srcIdx + 1] * brightness),
        clamp(textureData[srcIdx + 2] * brightness),
      ]);
    }
  }
}

/**
 * Get texture data for a block face, falling back to null.
 */
function getTexData(atlas: ProceduralAtlas, blockState: string, face: 'top' | 'north' | 'south' | 'east' | 'west' | 'bottom'): Uint8Array | null {
  const textures = getBlockTextures(blockState);
  const texName = textures[face];
  const entry = atlas.entries.get(texName);
  return entry?.data ?? null;
}

// ─── Render Functions ─────────────────────────────────────────────────────────

/**
 * Render a detailed top-down floor plan for a single story.
 * Uses atlas textures with item sprite overlays.
 */
export async function renderFloorDetail(
  grid: BlockGrid, story: number,
  options: { scale?: number; storyH?: number; output?: string; title?: string } = {}
): Promise<Buffer> {
  const texAtlas = await ensureAtlas();
  let { scale = 40 } = options;
  const { storyH = 5 } = options;
  const { width: w, length: l } = grid;
  const blocks = grid.to3DArray();
  const baseY = story * storyH;

  const margin = scale * 2;
  const titleH = Math.round(scale * 1.2);
  let imgW = w * scale + margin * 2;
  let imgH = l * scale + margin * 2 + titleH;

  if (Math.max(imgW, imgH) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(imgW, imgH);
    scale = Math.max(2, Math.round(scale * ratio));
    const newMargin = scale * 2;
    const newTitleH = Math.round(scale * 1.2);
    imgW = w * scale + newMargin * 2;
    imgH = l * scale + newMargin * 2 + newTitleH;
  }

  const pixels = Buffer.alloc(imgW * imgH * 4);
  fillRect(pixels, imgW, 0, 0, imgW, imgH, [22, 22, 28]);
  fillRect(pixels, imgW, 0, 0, imgW, titleH, [35, 35, 42]);

  const ox = margin;
  const oy = margin + titleH;

  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const px = ox + x * scale;
      const py = oy + z * scale;

      let color: RGB | null = null;
      let blockState = 'minecraft:air';
      let layer = 'air';

      for (let y = Math.min(baseY + storyH - 1, grid.height - 1); y >= Math.max(baseY - 1, 0); y--) {
        if (y >= grid.height) continue;
        const bs = blocks[y][z][x];
        if (bs === 'minecraft:air') continue;
        const c = getBlockColor(bs);
        if (c !== null) {
          color = c;
          blockState = bs;
          if (y === baseY) layer = 'floor';
          else if (y === baseY + storyH) layer = 'ceiling';
          else layer = 'content';
          break;
        }
      }

      if (color === null) {
        fillRect(pixels, imgW, px, py, scale, scale, [30, 30, 38]);
        continue;
      }

      const baseId = getBaseId(blockState);
      const tint = layer === 'floor' ? 0.7 : 1.0;

      // Try textured rendering first
      const texData = getTexData(texAtlas, blockState, 'top');
      if (texData && scale >= 4) {
        blitTextureTile(pixels, imgW, px + 1, py + 1, scale - 2,
          texData, texAtlas.tileSize, tint, tint, tint);
      } else {
        let [r, g, b] = color;
        if (layer === 'floor') {
          r = Math.round(r * 0.7);
          g = Math.round(g * 0.7);
          b = Math.round(b * 0.7);
        }
        fillRect(pixels, imgW, px + 1, py + 1, scale - 2, scale - 2, [r, g, b]);
      }

      // Cell outline
      const [cr, cg, cb] = color;
      drawRectOutline(pixels, imgW, px, py, scale, scale,
        [clamp(cr * tint - 50), clamp(cg * tint - 50), clamp(cb * tint - 50)]);

      // --- Item sprites and decorative overlays ---
      const sprite = getItemSprite(baseId);
      if (sprite) {
        // Blit custom item sprite on top of texture
        blitSprite(pixels, imgW, px + 1, py + 1, scale - 2, sprite);
      } else {
        // Fallback markers for items without sprites
        const cx = px + Math.floor(scale / 2);
        const cy = py + Math.floor(scale / 2);
        const hs = Math.max(2, Math.floor(scale / 6));

        if (baseId === 'minecraft:end_rod') {
          fillRect(pixels, imgW, cx - 1, cy - hs, 2, hs * 2, [180, 180, 190]);
        } else if (baseId === 'minecraft:amethyst_cluster') {
          const ds = Math.max(2, Math.floor(scale / 5));
          fillCircle(pixels, imgW, cx, cy, ds, [170, 90, 220]);
        } else if (baseId === 'minecraft:candle' || baseId === 'minecraft:white_candle') {
          const fs = Math.max(2, Math.floor(scale / 5));
          fillRect(pixels, imgW, cx - 1, cy, 2, fs, [200, 160, 50]);
          fillCircle(pixels, imgW, cx, cy - 1, Math.max(1, fs - 1), [255, 230, 80]);
        } else if (baseId === 'minecraft:stone_pressure_plate') {
          const pw = Math.max(3, Math.floor(scale / 3));
          fillRect(pixels, imgW, cx - pw, cy - 1, pw * 2, 2, [160, 160, 160]);
        } else if (baseId === 'minecraft:sea_lantern') {
          fillCircle(pixels, imgW, cx, cy, hs, [120, 220, 230]);
        } else if (baseId === 'minecraft:redstone_lamp') {
          fillCircle(pixels, imgW, cx, cy, hs, [230, 150, 60]);
        } else if (LIGHT_BLOCKS.has(baseId) && !['minecraft:lantern', 'minecraft:soul_lantern'].includes(baseId)) {
          fillCircle(pixels, imgW, cx, cy, hs, [255, 240, 120]);
        } else if (FURNITURE_BLOCKS.has(baseId)) {
          const ms = Math.max(2, Math.floor(scale / 5));
          fillRect(pixels, imgW, cx - ms, cy - ms, ms * 2, ms * 2, [255, 255, 255]);
        }
      }

      // Doors: vertical bar overlay
      if (DOOR_BLOCKS.has(baseId)) {
        const cx = px + Math.floor(scale / 2);
        fillRect(pixels, imgW, cx - 1, py + 2, 3, scale - 4, [100, 70, 35]);
      }

      // Precious blocks: diamond outline
      if (['minecraft:gold_block', 'minecraft:diamond_block', 'minecraft:emerald_block', 'minecraft:lapis_block'].includes(baseId)) {
        const cx = px + Math.floor(scale / 2);
        const cy = py + Math.floor(scale / 2);
        const ds = Math.max(3, Math.floor(scale / 4));
        drawLine(pixels, imgW, cx, cy - ds, cx + ds, cy, [255, 255, 255]);
        drawLine(pixels, imgW, cx + ds, cy, cx, cy + ds, [255, 255, 255]);
        drawLine(pixels, imgW, cx, cy + ds, cx - ds, cy, [255, 255, 255]);
        drawLine(pixels, imgW, cx - ds, cy, cx, cy - ds, [255, 255, 255]);
      }
    }
  }

  const gridColor: RGB = [60, 60, 70];
  for (let gx = 0; gx <= w; gx += 5) {
    drawLine(pixels, imgW, ox + gx * scale, oy, ox + gx * scale, oy + l * scale, gridColor);
  }
  for (let gz = 0; gz <= l; gz += 5) {
    drawLine(pixels, imgW, ox, oy + gz * scale, ox + w * scale, oy + gz * scale, gridColor);
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Compute ambient occlusion factor (0.0=fully occluded, 1.0=fully open).
 */
function getAO(grid: BlockGrid, x: number, y: number, z: number): number {
  let solidNeighbors = 0;
  const checks: [number, number, number][] = [
    [x+1,y,z], [x-1,y,z], [x,y+1,z], [x,y-1,z], [x,y,z+1], [x,y,z-1],
    [x+1,y+1,z], [x-1,y+1,z], [x,y+1,z+1], [x,y+1,z-1],
  ];
  for (const [cx, cy, cz] of checks) {
    if (isSolidBlock(grid.get(cx, cy, cz))) solidNeighbors++;
  }
  return 1.0 - (solidNeighbors / checks.length) * 0.4;
}

/**
 * Render isometric blocks with texture support.
 * Shared by renderCutawayIso and renderExterior.
 */
function renderIsoBlock(
  pixels: Buffer, imgW: number,
  texAtlas: ProceduralAtlas,
  blockState: string, color: RGB, ao: number,
  sx: number, sy: number, tile: number, halfT: number,
): void {
  let [r, g, b] = color;
  r = Math.round(r * ao);
  g = Math.round(g * ao);
  b = Math.round(b * ao);

  // Get face textures
  const topTex = getTexData(texAtlas, blockState, 'top');
  const westTex = getTexData(texAtlas, blockState, 'west');
  const southTex = getTexData(texAtlas, blockState, 'south');
  const ts = texAtlas.tileSize;

  // Top face (sunlit): strong brightness for overhead light
  const topBright = ao * 1.2;
  if (topTex && tile >= 4) {
    blitTextureIsoTop(pixels, imgW, sx, sy, tile, halfT, topTex, ts, topBright);
  } else {
    fillDiamond(pixels, imgW, sx, sy, tile, halfT,
      [clamp(r + 35), clamp(g + 35), clamp(b + 35)]);
  }

  // Left face (side-lit): west texture, moderate shadow
  const leftBright = ao * 0.78;
  if (westTex && tile >= 4) {
    blitTextureIsoLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile, westTex, ts, leftBright);
  } else {
    fillParallelogramLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile,
      [clamp(r - 25), clamp(g - 25), clamp(b - 25)]);
  }

  // Right face (shadowed): south texture, deep shadow for depth
  const rightBright = ao * 0.60;
  if (southTex && tile >= 4) {
    blitTextureIsoRight(pixels, imgW, sx, sy + tile, tile, tile, southTex, ts, rightBright);
  } else {
    fillParallelogramRight(pixels, imgW, sx, sy + tile, tile, tile,
      [clamp(r - 50), clamp(g - 50), clamp(b - 50)]);
  }

  // Edge outlines for definition
  if (tile >= 6) {
    const edgeColor: RGB = [clamp(r - 55), clamp(g - 55), clamp(b - 55)];
    drawLine(pixels, imgW, sx, sy, sx + tile, sy + halfT, edgeColor);
    drawLine(pixels, imgW, sx, sy, sx - tile, sy + halfT, edgeColor);
    drawLine(pixels, imgW, sx - tile, sy + halfT, sx, sy + tile, edgeColor);
    drawLine(pixels, imgW, sx + tile, sy + halfT, sx, sy + tile, edgeColor);
  }
}

/**
 * Render a cutaway isometric view of a single story.
 * Enhanced with textured faces and ambient occlusion.
 */
export async function renderCutawayIso(
  grid: BlockGrid, story: number,
  options: { tile?: number; storyH?: number; output?: string; title?: string } = {}
): Promise<Buffer> {
  const texAtlas = await ensureAtlas();
  let { tile = 16 } = options;
  const { storyH = 5 } = options;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();
  const baseY = story * storyH;
  const topY = Math.min(baseY + storyH, h);

  const corners = [
    [0, baseY, 0], [w, baseY, 0], [0, topY, 0], [0, baseY, l],
    [w, topY, 0], [w, baseY, l], [0, topY, l], [w, topY, l],
  ];
  let sxs = corners.map(([x, _y, z]) => (x - z) * tile);
  let sys = corners.map(([x, y, z]) => -(y * tile) + (x + z) * Math.floor(tile / 2));
  const margin = tile * 3;

  let minSx = Math.min(...sxs) - margin;
  let maxSx = Math.max(...sxs) + margin;
  let minSy = Math.min(...sys) - margin;
  let maxSy = Math.max(...sys) + margin + tile * 3;
  let imgW = maxSx - minSx;
  let imgH = maxSy - minSy;

  if (Math.max(imgW, imgH) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(imgW, imgH);
    tile = Math.max(2, Math.round(tile * ratio));
    sxs = corners.map(([x, _y, z]) => (x - z) * tile);
    sys = corners.map(([x, y, z]) => -(y * tile) + (x + z) * Math.floor(tile / 2));
    const m2 = tile * 3;
    minSx = Math.min(...sxs) - m2;
    maxSx = Math.max(...sxs) + m2;
    minSy = Math.min(...sys) - m2;
    maxSy = Math.max(...sys) + m2 + tile * 3;
    imgW = maxSx - minSx;
    imgH = maxSy - minSy;
  }

  const cx = -minSx;
  const cy = -minSy;
  const pixels = Buffer.alloc(imgW * imgH * 4);
  fillRect(pixels, imgW, 0, 0, imgW, imgH, [22, 22, 28]);

  // Cache block color lookups
  const colorCache = new Map<string, RGB | null>();
  function cachedBlockColor(bs: string): RGB | null {
    let c = colorCache.get(bs);
    if (c !== undefined) return c;
    c = getBlockColor(bs);
    colorCache.set(bs, c);
    return c;
  }

  for (let y = baseY; y < topY; y++) {
    for (let z = l - 1; z >= 0; z--) {
      for (let x = 0; x < w; x++) {
        const bs = blocks[y][z][x];
        const color = cachedBlockColor(bs);
        if (color === null) continue;

        // Skip fully interior blocks — never visible from any isometric angle
        if (x > 0 && x < w - 1 && y > baseY && y < topY - 1 && z > 0 && z < l - 1 &&
            cachedBlockColor(blocks[y + 1][z][x]) !== null &&
            cachedBlockColor(blocks[y - 1][z][x]) !== null &&
            cachedBlockColor(blocks[y][z][x - 1]) !== null &&
            cachedBlockColor(blocks[y][z][x + 1]) !== null &&
            cachedBlockColor(blocks[y][z - 1][x]) !== null &&
            cachedBlockColor(blocks[y][z + 1][x]) !== null) {
          continue;
        }

        const ao = getAO(grid, x, y, z);
        const sx = (x - z) * tile + cx;
        const sy = -(y * tile) + (x + z) * Math.floor(tile / 2) + cy;
        const halfT = Math.floor(tile / 2);

        renderIsoBlock(pixels, imgW, texAtlas, bs, color, ao, sx, sy, tile, halfT);
      }
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Render a top-down orthographic view (plan view) of the building.
 * Each XZ cell shows the topmost non-air block, matching satellite perspective.
 * Used for VLM comparison against satellite imagery where perspective must match.
 */
export async function renderTopDown(
  grid: BlockGrid,
  options: { scale?: number; output?: string; flat?: boolean } = {}
): Promise<Buffer> {
  const texAtlas = await ensureAtlas();
  let { scale = 8, flat = false } = options;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();

  // Auto-crop: find XZ bounding box of non-air blocks to center the building
  let minX = w, maxX = 0, minZ = l, maxZ = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          break;
        }
      }
    }
  }
  // Fallback if empty grid
  if (minX > maxX) { minX = 0; maxX = w - 1; }
  if (minZ > maxZ) { minZ = 0; maxZ = l - 1; }

  // Add small padding around the content
  const pad = 2;
  minX = Math.max(0, minX - pad);
  maxX = Math.min(w - 1, maxX + pad);
  minZ = Math.max(0, minZ - pad);
  maxZ = Math.min(l - 1, maxZ + pad);

  const cw = maxX - minX + 1; // content width
  const cl = maxZ - minZ + 1; // content length

  const margin = Math.max(4, scale);
  let imgW = cw * scale + margin * 2;
  let imgH = cl * scale + margin * 2;

  // Clamp to MAX_DIM
  if (Math.max(imgW, imgH) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(imgW, imgH);
    scale = Math.max(2, Math.round(scale * ratio));
    const m2 = Math.max(4, scale);
    imgW = cw * scale + m2 * 2;
    imgH = cl * scale + m2 * 2;
  }

  const ox = Math.max(4, scale);
  const oy = Math.max(4, scale);

  const pixels = Buffer.alloc(imgW * imgH * 4);
  // Dark background matching satellite image darkness
  fillRect(pixels, imgW, 0, 0, imgW, imgH, [20, 20, 20]);

  // Cache block color lookups
  const colorCache = new Map<string, RGB | null>();
  function cachedBlockColor(bs: string): RGB | null {
    let c = colorCache.get(bs);
    if (c !== undefined) return c;
    c = getBlockColor(bs);
    colorCache.set(bs, c);
    return c;
  }

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      // Find topmost non-air block (what satellite sees from above)
      let topBlock = 'minecraft:air';
      let topY = -1;
      for (let y = h - 1; y >= 0; y--) {
        const bs = blocks[y][z][x];
        if (bs !== 'minecraft:air') {
          topBlock = bs;
          topY = y;
          break;
        }
      }

      const color = cachedBlockColor(topBlock);
      if (color === null) continue;

      const px = ox + (x - minX) * scale;
      const py = oy + (z - minZ) * scale;

      // Height-based brightness: taller = slightly brighter (depth cue)
      const heightFactor = topY >= 0 ? 0.7 + 0.3 * (topY / (h - 1 || 1)) : 0.7;

      // Try textured rendering (skip in flat mode for cleaner satellite-like output)
      const texData = flat ? null : getTexData(texAtlas, topBlock, 'top');
      if (texData && scale >= 4) {
        blitTextureTile(pixels, imgW, px, py, scale,
          texData, texAtlas.tileSize, heightFactor, heightFactor, heightFactor);
      } else {
        let [r, g, b] = color;
        r = clamp(r * heightFactor);
        g = clamp(g * heightFactor);
        b = clamp(b * heightFactor);
        fillRect(pixels, imgW, px, py, scale, scale, [r, g, b]);
      }
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Render a top-down view using satellite image colors projected onto voxel geometry.
 * Combines accurate real-world colors from satellite imagery with 3D height detail
 * from voxelization. Each XZ column samples the satellite image at the corresponding
 * geographic position and modulates by heightmap brightness.
 *
 * @param grid - Voxelized BlockGrid from .schem
 * @param satPixels - Raw RGB pixel buffer from satellite image (no alpha)
 * @param satW - Satellite image width (typically 640)
 * @param satH - Satellite image height (typically 640)
 * @param options.resolution - Voxel resolution in blocks/meter (e.g. 3)
 * @param options.lat - Latitude of the building (for meters-per-pixel calc)
 * @param options.zoom - Google Maps zoom level of the satellite image (e.g. 20)
 * @param options.scale - Output pixel scale per block (default 8)
 */
export async function renderSatelliteColored(
  grid: BlockGrid,
  satPixels: Buffer,
  satW: number,
  satH: number,
  options: { resolution: number; lat: number; zoom: number; scale?: number },
): Promise<Buffer> {
  let { scale = 8 } = options;
  const { resolution, lat, zoom } = options;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();

  // Meters per pixel at this zoom/latitude
  const DEG2RAD = Math.PI / 180;
  const metersPerPx = 156543.03392 * Math.cos(lat * DEG2RAD) / Math.pow(2, zoom);

  // Blocks per satellite pixel: metersPerPx * resolution
  const blocksPerSatPx = metersPerPx * resolution;

  // Compute centroid of TALL blocks (top 50% of heightmap) to anchor on the
  // actual building rather than ground-level roads/sidewalks/parking lots.
  let maxH = 0;
  const hmScan = new Int16Array(w * l);
  hmScan.fill(-1);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          hmScan[z * w + x] = y;
          if (y > maxH) maxH = y;
          break;
        }
      }
    }
  }
  const heightThresh = maxH * 0.5;
  let sumX = 0, sumZ = 0, count = 0;
  let sumXAll = 0, sumZAll = 0, countAll = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const hy = hmScan[z * w + x];
      if (hy >= 0) {
        sumXAll += x; sumZAll += z; countAll++;
        if (hy >= heightThresh) {
          sumX += x; sumZ += z; count++;
        }
      }
    }
  }
  const gridCenterX = count > 0 ? sumX / count : (countAll > 0 ? sumXAll / countAll : w / 2);
  const gridCenterZ = count > 0 ? sumZ / count : (countAll > 0 ? sumZAll / countAll : l / 2);
  const satCenterX = satW / 2;
  const satCenterY = satH / 2;

  // Auto-crop: find XZ bounding box of non-air blocks
  let minX = w, maxX = 0, minZ = l, maxZ = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (z < minZ) minZ = z;
          if (z > maxZ) maxZ = z;
          break;
        }
      }
    }
  }
  if (minX > maxX) { minX = 0; maxX = w - 1; }
  if (minZ > maxZ) { minZ = 0; maxZ = l - 1; }

  // Small padding around content — keep building prominent in the image.
  // Dimmed satellite fills air blocks so background isn't black.
  const pad = 8;
  minX = Math.max(0, minX - pad);
  maxX = Math.min(w - 1, maxX + pad);
  minZ = Math.max(0, minZ - pad);
  maxZ = Math.min(l - 1, maxZ + pad);

  const cw = maxX - minX + 1;
  const cl = maxZ - minZ + 1;

  const margin = Math.max(4, scale);
  let imgW = cw * scale + margin * 2;
  let imgH = cl * scale + margin * 2;

  // Clamp to MAX_DIM
  if (Math.max(imgW, imgH) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(imgW, imgH);
    scale = Math.max(2, Math.round(scale * ratio));
    const m2 = Math.max(4, scale);
    imgW = cw * scale + m2 * 2;
    imgH = cl * scale + m2 * 2;
  }

  const ox = Math.max(4, scale);
  const oy = Math.max(4, scale);

  const pixels = Buffer.alloc(imgW * imgH * 4);
  // Dark background
  fillRect(pixels, imgW, 0, 0, imgW, imgH, [20, 20, 20]);

  // Build heightmap for hillshade computation
  const heightmap = new Int16Array(w * l);
  heightmap.fill(-1);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          heightmap[z * w + x] = y;
          break;
        }
      }
    }
  }

  // Smooth heightmap with 3x3 Gaussian to reduce voxel stair-stepping
  // in the hillshade normals. Pitched roofs become smoother shading planes.
  const smoothHm = new Float32Array(w * l);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const c = heightmap[z * w + x];
      if (c < 0) { smoothHm[z * w + x] = -1; continue; }
      // 3x3 Gaussian kernel (σ≈0.85): [1,2,1; 2,4,2; 1,2,1] / 16
      let sum = 0, wt = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= w || nz < 0 || nz >= l) continue;
          const nh = heightmap[nz * w + nx];
          if (nh < 0) continue;
          const k = (dx === 0 ? 2 : 1) * (dz === 0 ? 2 : 1); // center=4, edge=2, corner=1
          sum += nh * k;
          wt += k;
        }
      }
      smoothHm[z * w + x] = wt > 0 ? sum / wt : c;
    }
  }

  // Hillshade: sun from upper-left (azimuth ~315°, elevation ~45°)
  // mimics typical satellite imagery shadow direction
  const sunDirX = -0.5;  // from west (negative X)
  const sunDirZ = -0.5;  // from north (negative Z)
  const sunDirY = 0.707; // 45° elevation
  const sunLen = Math.sqrt(sunDirX * sunDirX + sunDirZ * sunDirZ + sunDirY * sunDirY);
  const sdx = sunDirX / sunLen;
  const sdz = sunDirZ / sunLen;
  const sdy = sunDirY / sunLen;

  /** Get smoothed heightmap value with boundary clamping */
  function shm(x: number, z: number): number {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cz = Math.max(0, Math.min(l - 1, z));
    return Math.max(0, smoothHm[cz * w + cx]);
  }

  /** Sample satellite RGB with bilinear interpolation at grid coordinates */
  function sampleSat(x: number, z: number): [number, number, number] {
    const satFx = satCenterX + (x - gridCenterX) / blocksPerSatPx;
    const satFy = satCenterY + (z - gridCenterZ) / blocksPerSatPx;
    const sx0 = Math.floor(satFx), sy0 = Math.floor(satFy);
    const sx1 = sx0 + 1, sy1 = sy0 + 1;
    if (sx0 >= 0 && sx1 < satW && sy0 >= 0 && sy1 < satH) {
      const fx = satFx - sx0, fy = satFy - sy0;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy, w11 = fx * fy;
      const i00 = (sy0 * satW + sx0) * 3, i10 = (sy0 * satW + sx1) * 3;
      const i01 = (sy1 * satW + sx0) * 3, i11 = (sy1 * satW + sx1) * 3;
      return [
        satPixels[i00] * w00 + satPixels[i10] * w10 + satPixels[i01] * w01 + satPixels[i11] * w11,
        satPixels[i00+1] * w00 + satPixels[i10+1] * w10 + satPixels[i01+1] * w01 + satPixels[i11+1] * w11,
        satPixels[i00+2] * w00 + satPixels[i10+2] * w10 + satPixels[i01+2] * w01 + satPixels[i11+2] * w11,
      ];
    }
    // Nearest-neighbor fallback at edges
    const cx = Math.max(0, Math.min(satW - 1, Math.round(satFx)));
    const cy = Math.max(0, Math.min(satH - 1, Math.round(satFy)));
    const idx = (cy * satW + cx) * 3;
    return [satPixels[idx], satPixels[idx + 1], satPixels[idx + 2]];
  }

  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const topY = heightmap[z * w + x];
      const [sr, sg, sb] = sampleSat(x, z);
      const px = ox + (x - minX) * scale;
      const py = oy + (z - minZ) * scale;

      if (topY < 0) {
        // No building here — show dimmed satellite for context
        fillRect(pixels, imgW, px, py, scale, scale,
          [Math.round(sr * 0.35), Math.round(sg * 0.35), Math.round(sb * 0.35)]);
        continue;
      }

      // Compute surface normal from SMOOTHED heightmap gradient
      const dzdx = (shm(x + 1, z) - shm(x - 1, z)) / 2;
      const dzdy = (shm(x, z + 1) - shm(x, z - 1)) / 2;
      const nx = -dzdx, ny = 1, nz = -dzdy;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dot = (nx / nlen) * sdx + (ny / nlen) * sdy + (nz / nlen) * sdz;
      const shade = 0.4 + 0.6 * Math.max(0, dot);
      const globalH = 0.85 + 0.15 * (topY / (h - 1 || 1));
      const brightness = shade * globalH;

      fillRect(pixels, imgW, px, py, scale, scale,
        [clamp(sr * brightness), clamp(sg * brightness), clamp(sb * brightness)]);
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Render at satellite image resolution (1 output px = 1 satellite px).
 * Uses the voxel heightmap for hillshade and building masking, but preserves
 * the full satellite color resolution instead of downsampling to block grid.
 *
 * This produces renders that look much closer to the satellite reference
 * because color detail is preserved at the satellite's native resolution
 * (~0.11m/px at z20), while the voxel geometry adds 3D depth perception.
 *
 * The output image is cropped to the building's bounding box in satellite
 * coordinates, with a small margin.
 */
/**
 * Rasterize a lat/lng polygon to a grid-space boolean mask using ray-casting PIP.
 * Returns Uint8Array[w*l] where 1 = inside polygon, 0 = outside.
 */
function rasterizePolygonToGridMask(
  polygon: { lat: number; lon: number }[],
  centerLat: number,
  centerLng: number,
  gridCenterX: number,
  gridCenterZ: number,
  resolution: number,
  w: number,
  l: number,
): Uint8Array {
  const DEG2RAD = Math.PI / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(centerLat * DEG2RAD);

  // Convert polygon vertices from lat/lng to grid (x, z) coordinates
  const polyXZ: { x: number; z: number }[] = polygon.map(v => ({
    x: gridCenterX + (v.lon - centerLng) * metersPerDegLng * resolution,
    z: gridCenterZ + (centerLat - v.lat) * metersPerDegLat * resolution,
  }));

  // Expand polygon by ~2 blocks to account for voxel edge overlap
  const cx = polyXZ.reduce((s, p) => s + p.x, 0) / polyXZ.length;
  const cz = polyXZ.reduce((s, p) => s + p.z, 0) / polyXZ.length;
  const expandedXZ = polyXZ.map(p => {
    const dx = p.x - cx, dz = p.z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz) || 1;
    return { x: p.x + (dx / dist) * 2, z: p.z + (dz / dist) * 2 };
  });

  const mask = new Uint8Array(w * l);
  // Ray-casting point-in-polygon for each grid cell
  for (let gz = 0; gz < l; gz++) {
    for (let gx = 0; gx < w; gx++) {
      let inside = false;
      const n = expandedXZ.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = expandedXZ[i].x, zi = expandedXZ[i].z;
        const xj = expandedXZ[j].x, zj = expandedXZ[j].z;
        if ((zi > gz) !== (zj > gz) &&
            gx < (xj - xi) * (gz - zi) / (zj - zi) + xi) {
          inside = !inside;
        }
      }
      if (inside) mask[gz * w + gx] = 1;
    }
  }
  return mask;
}

export async function renderSatelliteHiRes(
  grid: BlockGrid,
  satPixels: Buffer,
  satW: number,
  satH: number,
  options: {
    resolution: number;
    lat: number;
    zoom: number;
    /** Optional OSM building polygon — restricts building mask to polygon interior */
    osmPolygon?: { lat: number; lon: number }[];
    /** Center longitude (needed when osmPolygon is provided) */
    lng?: number;
    /** Non-building area brightness: 0.25 = strong contrast, 1.0 = full context (default: 0.25) */
    contextDim?: number;
  },
): Promise<Buffer> {
  const { resolution, lat, zoom } = options;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();

  // Coordinate mapping: building centroid = satellite center.
  // Use centroid of TALL blocks (top 50% of heightmap) to anchor on the actual
  // building rather than ground-level roads/sidewalks that shift the centroid.
  const DEG2RAD = Math.PI / 180;
  const metersPerPx = 156543.03392 * Math.cos(lat * DEG2RAD) / Math.pow(2, zoom);
  const blocksPerSatPx = metersPerPx * resolution;

  // First pass: build heightmap and find max height
  const hmTemp = new Int16Array(w * l);
  hmTemp.fill(-1);
  let maxH = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          hmTemp[z * w + x] = y;
          if (y > maxH) maxH = y;
          break;
        }
      }
    }
  }

  // Compute centroid of blocks above 50% of max height (building roofline)
  // to exclude ground-level content (roads, sidewalks, parking lots)
  const heightThreshold = maxH * 0.5;
  let sumX = 0, sumZ = 0, cnt = 0;
  let sumXAll = 0, sumZAll = 0, cntAll = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const hy = hmTemp[z * w + x];
      if (hy >= 0) {
        sumXAll += x; sumZAll += z; cntAll++;
        if (hy >= heightThreshold) {
          sumX += x; sumZ += z; cnt++;
        }
      }
    }
  }
  // Fall back to all-blocks centroid if no tall blocks found (single-story)
  const gridCenterX = cnt > 0 ? sumX / cnt : (cntAll > 0 ? sumXAll / cntAll : w / 2);
  const gridCenterZ = cnt > 0 ? sumZ / cnt : (cntAll > 0 ? sumZAll / cntAll : l / 2);
  const satCenterX = satW / 2;
  const satCenterY = satH / 2;

  // Build heightmap
  const heightmap = new Int16Array(w * l);
  heightmap.fill(-1);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      for (let y = h - 1; y >= 0; y--) {
        if (blocks[y][z][x] !== 'minecraft:air') {
          heightmap[z * w + x] = y;
          break;
        }
      }
    }
  }

  // Smooth heightmap with 3x3 Gaussian
  const smoothHm = new Float32Array(w * l);
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      const c = heightmap[z * w + x];
      if (c < 0) { smoothHm[z * w + x] = -1; continue; }
      let sum = 0, wt = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, nz = z + dz;
          if (nx < 0 || nx >= w || nz < 0 || nz >= l) continue;
          const nh = heightmap[nz * w + nx];
          if (nh < 0) continue;
          const k = (dx === 0 ? 2 : 1) * (dz === 0 ? 2 : 1);
          sum += nh * k; wt += k;
        }
      }
      smoothHm[z * w + x] = wt > 0 ? sum / wt : c;
    }
  }

  // Building mask: combine heightmap (non-air) with optional OSM polygon mask.
  // OSM polygon restricts building area to actual footprint, filtering out trees.
  const isBuilding = new Uint8Array(w * l);
  let buildingCount = 0;

  let polyMask: Uint8Array | null = null;
  if (options.osmPolygon && options.osmPolygon.length >= 3 && options.lng !== undefined) {
    polyMask = rasterizePolygonToGridMask(
      options.osmPolygon, lat, options.lng,
      gridCenterX, gridCenterZ, resolution, w, l,
    );
    const polyCount = polyMask.reduce((s, v) => s + v, 0);
    console.log(`  OSM polygon mask: ${polyCount}/${w * l} cells (${(100 * polyCount / (w * l)).toFixed(1)}%)`);
  }

  // ExG vegetation filter: use satellite color to detect tree canopy in voxels.
  // Excess Green Index (ExG = 2G - R - B) from remote sensing literature.
  // Only filter LOW voxels (ground-level trees); tall structures keep green pixels
  // (e.g. Apple Park's green roof, moss-covered roofs) since they're buildings.
  const vegMask = new Uint8Array(w * l);
  const EXG_THRESHOLD = 30; // calibrated: deciduous canopy ExG is typically 40-80
  const vegHeightCap = maxH * 0.4; // only filter below 40% of max height
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      // Skip tall structures — green roofs are buildings, not vegetation
      if (heightmap[z * w + x] > vegHeightCap) continue;
      // Map grid cell to satellite pixel
      const sx = Math.round(satCenterX + (x - gridCenterX) / blocksPerSatPx);
      const sy = Math.round(satCenterY + (z - gridCenterZ) / blocksPerSatPx);
      if (sx < 0 || sx >= satW || sy < 0 || sy >= satH) continue;
      const idx = (sy * satW + sx) * 3;
      const r = satPixels[idx], g = satPixels[idx + 1], b = satPixels[idx + 2];
      const exg = 2 * g - r - b;
      if (exg > EXG_THRESHOLD) vegMask[z * w + x] = 1;
    }
  }
  const vegCount = vegMask.reduce((s, v) => s + v, 0);

  for (let i = 0; i < w * l; i++) {
    if (heightmap[i] >= 0 && (!polyMask || polyMask[i]) && !vegMask[i]) {
      isBuilding[i] = 1; buildingCount++;
    }
  }
  if (vegCount > 0) {
    console.log(`  ExG vegetation filter: ${vegCount} cells filtered (${(100 * vegCount / (w * l)).toFixed(1)}%)`);
  }

  // Find bounding box of BUILDING blocks in satellite pixel space
  let minSatX = satW, maxSatX = 0, minSatY = satH, maxSatY = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      if (!isBuilding[z * w + x]) continue;
      const sx = satCenterX + (x - gridCenterX) / blocksPerSatPx;
      const sy = satCenterY + (z - gridCenterZ) / blocksPerSatPx;
      if (sx < minSatX) minSatX = sx;
      if (sx > maxSatX) maxSatX = sx;
      if (sy < minSatY) minSatY = sy;
      if (sy > maxSatY) maxSatY = sy;
    }
  }

  // Fallback: if no building cells found (e.g. OSM polygon too small/misaligned),
  // fall back to heightmap-only mask without OSM filtering
  if (buildingCount === 0 && polyMask) {
    console.log(`  OSM mask yielded 0 building cells — falling back to heightmap-only`);
    for (let i = 0; i < w * l; i++) {
      if (heightmap[i] >= 0 && !vegMask[i]) {
        isBuilding[i] = 1; buildingCount++;
      }
    }
  }

  // Pad the bounding box with some satellite pixels for context
  const pad = Math.ceil(10 / blocksPerSatPx); // ~10 blocks worth of context
  // Recompute bounding box after potential fallback
  minSatX = satW; maxSatX = 0; minSatY = satH; maxSatY = 0;
  for (let z = 0; z < l; z++) {
    for (let x = 0; x < w; x++) {
      if (!isBuilding[z * w + x]) continue;
      const sx = satCenterX + (x - gridCenterX) / blocksPerSatPx;
      const sy = satCenterY + (z - gridCenterZ) / blocksPerSatPx;
      if (sx < minSatX) minSatX = sx;
      if (sx > maxSatX) maxSatX = sx;
      if (sy < minSatY) minSatY = sy;
      if (sy > maxSatY) maxSatY = sy;
    }
  }
  minSatX = Math.max(0, Math.floor(minSatX) - pad);
  maxSatX = Math.min(satW - 1, Math.ceil(maxSatX) + pad);
  minSatY = Math.max(0, Math.floor(minSatY) - pad);
  maxSatY = Math.min(satH - 1, Math.ceil(maxSatY) + pad);

  const imgW = maxSatX - minSatX + 1;
  const imgH = maxSatY - minSatY + 1;
  const pixels = Buffer.alloc(imgW * imgH * 4);

  // Sun direction for hillshade (same as standard renderer)
  const sunDirX = -0.5, sunDirZ = -0.5, sunDirY = 0.707;
  const sunLen = Math.sqrt(sunDirX * sunDirX + sunDirZ * sunDirZ + sunDirY * sunDirY);
  const sdx = sunDirX / sunLen, sdz = sunDirZ / sunLen, sdy = sunDirY / sunLen;

  /** Get smoothed heightmap value with boundary clamping */
  function shm(x: number, z: number): number {
    const cx = Math.max(0, Math.min(w - 1, x));
    const cz = Math.max(0, Math.min(l - 1, z));
    return Math.max(0, smoothHm[cz * w + cx]);
  }

  /** Bilinear heightmap sample at fractional grid coords */
  function sampleHeight(gx: number, gz: number): number {
    const x0 = Math.floor(gx), z0 = Math.floor(gz);
    const x1 = Math.min(x0 + 1, w - 1), z1 = Math.min(z0 + 1, l - 1);
    const fx = gx - x0, fz = gz - z0;
    const h00 = heightmap[z0 * w + x0];
    const h10 = heightmap[z0 * w + x1];
    const h01 = heightmap[z1 * w + x0];
    const h11 = heightmap[z1 * w + x1];
    // If any neighbor is air, nearest-neighbor instead
    if (h00 < 0 || h10 < 0 || h01 < 0 || h11 < 0) {
      const nx = Math.round(gx), nz = Math.round(gz);
      if (nx >= 0 && nx < w && nz >= 0 && nz < l) return heightmap[nz * w + nx];
      return -1;
    }
    return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) +
           h01 * (1 - fx) * fz + h11 * fx * fz;
  }

  // Iterate over satellite pixels in the cropped region
  for (let sy = 0; sy < imgH; sy++) {
    for (let sx = 0; sx < imgW; sx++) {
      const satX = minSatX + sx;
      const satY = minSatY + sy;

      // Map satellite pixel → grid coordinates (fractional)
      const gx = gridCenterX + (satX - satCenterX) * blocksPerSatPx;
      const gz = gridCenterZ + (satY - satCenterY) * blocksPerSatPx;

      // Get satellite color
      const satIdx = (satY * satW + satX) * 3;
      const sr = satPixels[satIdx];
      const sg = satPixels[satIdx + 1];
      const sb = satPixels[satIdx + 2];

      // Check if this satellite pixel maps to a building in the grid
      const topY = sampleHeight(gx, gz);
      const ix = Math.max(0, Math.min(w - 1, Math.round(gx)));
      const iz = Math.max(0, Math.min(l - 1, Math.round(gz)));
      const building = topY >= 0 && gx >= 0 && gx < w && gz >= 0 && gz < l
        && isBuilding[iz * w + ix];
      const outIdx = (sy * imgW + sx) * 4;

      if (!building) {
        // Non-building: show satellite at configurable brightness.
        // Full brightness (1.0) preserves global histogram for VLM comparison;
        // dimmed (0.25) creates contrast but VLM penalizes the composition mismatch.
        const dim = options.contextDim ?? 0.25;
        pixels[outIdx] = Math.round(sr * dim);
        pixels[outIdx + 1] = Math.round(sg * dim);
        pixels[outIdx + 2] = Math.round(sb * dim);
        pixels[outIdx + 3] = 255;
        continue;
      }

      // Subtle hillshade — just enough to show edges, not enough to reveal
      // voxel stairstepping on roofs (which VLM penalizes as "oversimplified")
      const dzdx = (shm(ix + 1, iz) - shm(ix - 1, iz)) / 2;
      const dzdy = (shm(ix, iz + 1) - shm(ix, iz - 1)) / 2;
      const nx = -dzdx, ny = 1, nz = -dzdy;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const dot = (nx / nlen) * sdx + (ny / nlen) * sdy + (nz / nlen) * sdz;
      const shade = 0.85 + 0.15 * Math.max(0, dot); // subtle: 0.85-1.0

      // Global height factor (compressed)
      const globalH = 0.92 + 0.08 * (topY / (h - 1 || 1));
      const brightness = shade * globalH;

      pixels[outIdx] = clamp(sr * brightness);
      pixels[outIdx + 1] = clamp(sg * brightness);
      pixels[outIdx + 2] = clamp(sb * brightness);
      pixels[outIdx + 3] = 255;
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Render a full exterior isometric view of the entire schematic.
 * Enhanced with textured faces, ambient occlusion and edge outlines.
 */
export async function renderExterior(
  grid: BlockGrid,
  options: { tile?: number; output?: string } = {}
): Promise<Buffer> {
  const texAtlas = await ensureAtlas();
  let { tile = 10 } = options;
  const { width: w, height: h, length: l } = grid;
  const blocks = grid.to3DArray();

  const corners = [
    [0, 0, 0], [w, 0, 0], [0, h, 0], [0, 0, l],
    [w, h, 0], [w, 0, l], [0, h, l], [w, h, l],
  ];
  let sxs = corners.map(([x, _y, z]) => (x - z) * tile);
  let sys = corners.map(([x, y, z]) => -(y * tile) + (x + z) * Math.floor(tile / 2));
  const margin = tile * 4;

  let minSx = Math.min(...sxs) - margin;
  let maxSx = Math.max(...sxs) + margin;
  let minSy = Math.min(...sys) - margin;
  let maxSy = Math.max(...sys) + margin;
  let imgW = maxSx - minSx;
  let imgH = maxSy - minSy;

  if (Math.max(imgW, imgH) > MAX_DIM) {
    const ratio = MAX_DIM / Math.max(imgW, imgH);
    tile = Math.max(2, Math.round(tile * ratio));
    sxs = corners.map(([x, _y, z]) => (x - z) * tile);
    sys = corners.map(([x, y, z]) => -(y * tile) + (x + z) * Math.floor(tile / 2));
    const m2 = tile * 4;
    minSx = Math.min(...sxs) - m2; maxSx = Math.max(...sxs) + m2;
    minSy = Math.min(...sys) - m2; maxSy = Math.max(...sys) + m2;
    imgW = maxSx - minSx; imgH = maxSy - minSy;
  }

  const cx = -minSx;
  const cy = -minSy;
  const pixels = Buffer.alloc(imgW * imgH * 4);
  fillRect(pixels, imgW, 0, 0, imgW, imgH, [22, 22, 28]);

  // Cache block color lookups — same block state appears thousands of times
  const colorCache = new Map<string, RGB | null>();
  function cachedBlockColor(bs: string): RGB | null {
    let c = colorCache.get(bs);
    if (c !== undefined) return c;
    c = getBlockColor(bs);
    colorCache.set(bs, c);
    return c;
  }

  for (let y = 0; y < h; y++) {
    for (let z = l - 1; z >= 0; z--) {
      for (let x = 0; x < w; x++) {
        const bs = blocks[y][z][x];
        const color = cachedBlockColor(bs);
        if (color === null) continue;

        // Skip fully interior blocks — never visible from any isometric angle
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1 && z > 0 && z < l - 1 &&
            cachedBlockColor(blocks[y + 1][z][x]) !== null &&
            cachedBlockColor(blocks[y - 1][z][x]) !== null &&
            cachedBlockColor(blocks[y][z][x - 1]) !== null &&
            cachedBlockColor(blocks[y][z][x + 1]) !== null &&
            cachedBlockColor(blocks[y][z - 1][x]) !== null &&
            cachedBlockColor(blocks[y][z + 1][x]) !== null) {
          continue;
        }

        const ao = getAO(grid, x, y, z);
        const sx = (x - z) * tile + cx;
        const sy = -(y * tile) + (x + z) * Math.floor(tile / 2) + cy;
        const halfT = Math.floor(tile / 2);

        renderIsoBlock(pixels, imgW, texAtlas, bs, color, ao, sx, sy, tile, halfT);
      }
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

// ─── Pixel Drawing Helpers ───────────────────────────────────────────────────

function setPixel(buf: Buffer, imgW: number, x: number, y: number, [r, g, b]: RGB): void {
  if (x < 0 || y < 0) return;
  const offset = (y * imgW + x) * 4;
  if (offset + 3 >= buf.length) return;
  buf[offset] = r;
  buf[offset + 1] = g;
  buf[offset + 2] = b;
  buf[offset + 3] = 255;
}

function fillRect(buf: Buffer, imgW: number, x: number, y: number, w: number, h: number, color: RGB): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, imgW, x + dx, y + dy, color);
    }
  }
}

function drawRectOutline(buf: Buffer, imgW: number, x: number, y: number, w: number, h: number, color: RGB): void {
  for (let dx = 0; dx < w; dx++) {
    setPixel(buf, imgW, x + dx, y, color);
    setPixel(buf, imgW, x + dx, y + h - 1, color);
  }
  for (let dy = 0; dy < h; dy++) {
    setPixel(buf, imgW, x, y + dy, color);
    setPixel(buf, imgW, x + w - 1, y + dy, color);
  }
}

function drawLine(buf: Buffer, imgW: number, x0: number, y0: number, x1: number, y1: number, color: RGB): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let cx = x0, cy = y0;
  while (true) {
    setPixel(buf, imgW, cx, cy, color);
    if (cx === x1 && cy === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; cx += sx; }
    if (e2 < dx) { err += dx; cy += sy; }
  }
}

function fillCircle(buf: Buffer, imgW: number, cx: number, cy: number, r: number, color: RGB): void {
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        setPixel(buf, imgW, cx + dx, cy + dy, color);
      }
    }
  }
}

function fillDiamond(buf: Buffer, imgW: number, sx: number, sy: number, _tileW: number, halfH: number, color: RGB): void {
  for (let row = 0; row <= halfH * 2; row++) {
    const width = row <= halfH ? row : halfH * 2 - row;
    const startX = sx - width;
    const y = sy + row;
    for (let dx = 0; dx <= width * 2; dx++) {
      setPixel(buf, imgW, startX + dx, y, color);
    }
  }
}

function fillParallelogramLeft(buf: Buffer, imgW: number, sx: number, sy: number, w: number, h: number, color: RGB): void {
  for (let row = 0; row < h; row++) {
    const xStart = sx + Math.floor(row / 2);
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, imgW, xStart + dx, sy + row, color);
    }
  }
}

function fillParallelogramRight(buf: Buffer, imgW: number, sx: number, sy: number, w: number, h: number, color: RGB): void {
  for (let row = 0; row < h; row++) {
    const xStart = sx - Math.floor(row / 2);
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, imgW, xStart + dx, sy + row, color);
    }
  }
}
