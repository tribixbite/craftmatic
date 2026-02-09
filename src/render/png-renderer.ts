/**
 * 2D PNG renderer — produces floor plans, cutaway isometrics,
 * and exterior views from schematic data.
 * Uses pureimage (pure JS) for cross-platform PNG encoding.
 */

import { BlockGrid } from '../schem/types.js';
import { getBlockColor, FURNITURE_BLOCKS, LIGHT_BLOCKS, BED_BLOCKS, DOOR_BLOCKS } from '../blocks/colors.js';
import { getBaseId, isSolidBlock } from '../blocks/registry.js';
import type { RGB } from '../types/index.js';
import { Writable } from 'node:stream';

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

/**
 * Render a detailed top-down floor plan for a single story.
 */
export async function renderFloorDetail(
  grid: BlockGrid, story: number,
  options: { scale?: number; storyH?: number; output?: string; title?: string } = {}
): Promise<Buffer> {
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

      let [r, g, b] = color;
      const baseId = getBaseId(blockState);

      if (layer === 'floor') {
        r = Math.round(r * 0.7);
        g = Math.round(g * 0.7);
        b = Math.round(b * 0.7);
      }

      fillRect(pixels, imgW, px + 1, py + 1, scale - 2, scale - 2, [r, g, b]);
      drawRectOutline(pixels, imgW, px, py, scale, scale,
        [clamp(r - 50), clamp(g - 50), clamp(b - 50)]);

      const cx = px + Math.floor(scale / 2);
      const cy = py + Math.floor(scale / 2);
      const hs = Math.max(2, Math.floor(scale / 6));

      if (FURNITURE_BLOCKS.has(baseId)) {
        const ms = Math.max(2, Math.floor(scale / 5));
        fillRect(pixels, imgW, cx - ms, cy - ms, ms * 2, ms * 2, [255, 255, 255]);
      }

      if (baseId === 'minecraft:chest' || baseId === 'minecraft:trapped_chest' || baseId === 'minecraft:ender_chest') {
        drawLine(pixels, imgW, px + hs, py + hs, px + scale - hs, py + scale - hs, [255, 220, 50]);
        drawLine(pixels, imgW, px + scale - hs, py + hs, px + hs, py + scale - hs, [255, 220, 50]);
      }

      if (LIGHT_BLOCKS.has(baseId)) {
        fillCircle(pixels, imgW, cx, cy, hs, [255, 240, 120]);
      }

      if (BED_BLOCKS.has(baseId)) {
        const bm = Math.max(2, Math.floor(scale / 8));
        drawRectOutline(pixels, imgW, px + bm, py + bm, scale - bm * 2, scale - bm * 2,
          [clamp(r + 40), clamp(g + 40), clamp(b + 40)]);
      }

      if (DOOR_BLOCKS.has(baseId)) {
        fillRect(pixels, imgW, cx - 1, py + 2, 3, scale - 4, [100, 70, 35]);
      }

      if (['minecraft:gold_block', 'minecraft:diamond_block', 'minecraft:emerald_block', 'minecraft:lapis_block'].includes(baseId)) {
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
 * Counts how many of the 6 neighbor positions are solid.
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
 * Render a cutaway isometric view of a single story.
 * Enhanced with ambient occlusion and higher default resolution.
 */
export async function renderCutawayIso(
  grid: BlockGrid, story: number,
  options: { tile?: number; storyH?: number; output?: string; title?: string } = {}
): Promise<Buffer> {
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
        let [r, g, b] = color;
        r = Math.round(r * ao);
        g = Math.round(g * ao);
        b = Math.round(b * ao);

        const sx = (x - z) * tile + cx;
        const sy = -(y * tile) + (x + z) * Math.floor(tile / 2) + cy;
        const halfT = Math.floor(tile / 2);

        // Top face (bright)
        fillDiamond(pixels, imgW, sx, sy, tile, halfT,
          [clamp(r + 30), clamp(g + 30), clamp(b + 30)]);

        // Left face (medium)
        fillParallelogramLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile,
          [clamp(r - 15), clamp(g - 15), clamp(b - 15)]);

        // Right face (dark)
        fillParallelogramRight(pixels, imgW, sx, sy + tile, tile, tile,
          [clamp(r - 35), clamp(g - 35), clamp(b - 35)]);

        // Edge outlines for definition at higher resolution
        if (tile >= 8) {
          const edgeColor: RGB = [clamp(r - 55), clamp(g - 55), clamp(b - 55)];
          // Top diamond edges
          drawLine(pixels, imgW, sx, sy, sx + tile, sy + halfT, edgeColor);
          drawLine(pixels, imgW, sx, sy, sx - tile, sy + halfT, edgeColor);
          // Bottom edges
          drawLine(pixels, imgW, sx - tile, sy + halfT, sx, sy + tile, edgeColor);
          drawLine(pixels, imgW, sx + tile, sy + halfT, sx, sy + tile, edgeColor);
        }
      }
    }
  }

  return encodePNG(pixels, imgW, imgH);
}

/**
 * Render a full exterior isometric view of the entire schematic.
 * Enhanced with ambient occlusion and edge outlines.
 */
export async function renderExterior(
  grid: BlockGrid,
  options: { tile?: number; output?: string } = {}
): Promise<Buffer> {
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
        let [r, g, b] = color;
        r = Math.round(r * ao);
        g = Math.round(g * ao);
        b = Math.round(b * ao);

        const sx = (x - z) * tile + cx;
        const sy = -(y * tile) + (x + z) * Math.floor(tile / 2) + cy;
        const halfT = Math.floor(tile / 2);

        // Top face (bright)
        fillDiamond(pixels, imgW, sx, sy, tile, halfT,
          [clamp(r + 30), clamp(g + 30), clamp(b + 30)]);

        // Left face (medium)
        fillParallelogramLeft(pixels, imgW, sx - tile, sy + halfT, tile, tile,
          [clamp(r - 15), clamp(g - 15), clamp(b - 15)]);

        // Right face (dark)
        fillParallelogramRight(pixels, imgW, sx, sy + tile, tile, tile,
          [clamp(r - 35), clamp(g - 35), clamp(b - 35)]);

        // Edge outlines
        if (tile >= 6) {
          const edgeColor: RGB = [clamp(r - 55), clamp(g - 55), clamp(b - 55)];
          drawLine(pixels, imgW, sx, sy, sx + tile, sy + halfT, edgeColor);
          drawLine(pixels, imgW, sx, sy, sx - tile, sy + halfT, edgeColor);
          drawLine(pixels, imgW, sx - tile, sy + halfT, sx, sy + tile, edgeColor);
          drawLine(pixels, imgW, sx + tile, sy + halfT, sx, sy + tile, edgeColor);
        }
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
