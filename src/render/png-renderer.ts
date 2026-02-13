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
import { initDefaultAtlas, type ProceduralAtlas } from './texture-atlas.js';
import { getItemSprite, ITEM_SPRITE_SIZE } from './item-sprites.js';
import type { RGB } from '../types/index.js';
import { Writable } from 'node:stream';

/** Cached atlas instance for textured rendering */
let atlas: ProceduralAtlas | null = null;

/** Ensure atlas is loaded (called once per render session) */
async function ensureAtlas(): Promise<ProceduralAtlas> {
  if (!atlas) atlas = await initDefaultAtlas();
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

  // Top face (bright): +30 brightness
  const topBright = ao * 1.15;
  if (topTex && tile >= 4) {
    blitTextureIsoTop(pixels, imgW, sx, sy, tile, halfT, topTex, ts, topBright);
  } else {
    fillDiamond(pixels, imgW, sx, sy, tile, halfT,
      [clamp(r + 30), clamp(g + 30), clamp(b + 30)]);
  }

  // Left face (medium): west texture, -15 brightness
  const leftBright = ao * 0.85;
  if (westTex && tile >= 4) {
    blitTextureIsoLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile, westTex, ts, leftBright);
  } else {
    fillParallelogramLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile,
      [clamp(r - 15), clamp(g - 15), clamp(b - 15)]);
  }

  // Right face (dark): south texture, -35 brightness
  const rightBright = ao * 0.70;
  if (southTex && tile >= 4) {
    blitTextureIsoRight(pixels, imgW, sx, sy + tile, tile, tile, southTex, ts, rightBright);
  } else {
    fillParallelogramRight(pixels, imgW, sx, sy + tile, tile, tile,
      [clamp(r - 35), clamp(g - 35), clamp(b - 35)]);
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

  for (let y = baseY; y < topY; y++) {
    for (let z = l - 1; z >= 0; z--) {
      for (let x = 0; x < w; x++) {
        const bs = blocks[y][z][x];
        const color = getBlockColor(bs);
        if (color === null) continue;

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

  for (let y = 0; y < h; y++) {
    for (let z = l - 1; z >= 0; z--) {
      for (let x = 0; x < w; x++) {
        const bs = blocks[y][z][x];
        const color = getBlockColor(bs);
        if (color === null) continue;

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
