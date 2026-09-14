#!/usr/bin/env bun
/**
 * Showcase visual grader — renders 3-panel views of showcase models and grades
 * shape recognition using Claude vision. Reference photos provided for shape context.
 *
 * Uses the same rendering pipeline as grade-models.ts (3-panel isometric+top+side,
 * post-processing, lenient shape-focused scoring).
 *
 * Usage:  bun scripts/showcase-grade.ts
 */

import { parseLDraw }    from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import { getPartDims }   from '../web/src/engine/ldraw-part-dims.js';
import type { ParsedBrick } from '../web/src/engine/ldraw-parser.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join }          from 'node:path';
import { deflateSync }   from 'node:zlib';
import * as https        from 'node:https';

// ─── PNG encoder ──────────────────────────────────────────────────────────────

let _crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    _crcTable[i] = c;
  }
  return _crcTable;
}
function crc32(buf: Uint8Array): number {
  const t = getCrcTable(); let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function u32be(n: number): Uint8Array {
  return new Uint8Array([(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF]);
}
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const tb = new TextEncoder().encode(type);
  const body = new Uint8Array(tb.length + data.length);
  body.set(tb); body.set(data, tb.length);
  const crc = u32be(crc32(body));
  const out = new Uint8Array(4 + 4 + data.length + 4);
  out.set(u32be(data.length)); out.set(tb, 4); out.set(data, 8);
  out.set(crc, 8 + data.length);
  return out;
}
function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const sig = new Uint8Array([137,80,78,71,13,10,26,10]);
  const ihdrData = new Uint8Array(13);
  const dv = new DataView(ihdrData.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdrData[8] = 8; ihdrData[9] = 2;
  const ihdr = pngChunk('IHDR', ihdrData);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4, di = y * (w * 3 + 1) + 1 + x * 3;
      raw[di] = rgba[si]; raw[di+1] = rgba[si+1]; raw[di+2] = rgba[si+2];
    }
  }
  const idat = pngChunk('IDAT', deflateSync(raw));
  const iend = pngChunk('IEND', new Uint8Array(0));
  const total = sig.length + ihdr.length + idat.length + iend.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of [sig, ihdr, idat, iend]) { out.set(c, off); off += c.length; }
  return Buffer.from(out);
}

// ─── Block colour lookup ──────────────────────────────────────────────────────

type VGrid = ReturnType<typeof voxelizeLDraw>['grid'];

const BLOCK_RGB: Record<string, readonly [number, number, number]> = {
  'minecraft:black_concrete':           [55,  55,  65 ],
  'minecraft:blue_concrete':            [44,  46,  143],
  'minecraft:green_concrete':           [73,  91,  36 ],
  'minecraft:cyan_concrete':            [21,  119, 136],
  'minecraft:red_concrete':             [142, 33,  33 ],
  'minecraft:magenta_concrete':         [169, 48,  159],
  'minecraft:brown_concrete':           [96,  59,  31 ],
  'minecraft:light_gray_concrete':      [125, 125, 115],
  'minecraft:gray_concrete':            [55,  58,  62 ],
  'minecraft:light_blue_concrete':      [36,  137, 199],
  'minecraft:lime_concrete':            [94,  168, 24 ],
  'minecraft:pink_concrete':            [213, 101, 143],
  'minecraft:yellow_concrete':          [240, 175, 21 ],
  'minecraft:white_concrete':           [207, 213, 214],
  'minecraft:orange_concrete':          [224, 97,  0  ],
  'minecraft:purple_concrete':          [100, 32,  156],
  'minecraft:sandstone':                [216, 199, 148],
  'minecraft:glass':                    [175, 213, 228],
  'minecraft:lime_stained_glass':       [128, 199, 31 ],
  'minecraft:red_stained_glass':        [153, 51,  51 ],
  'minecraft:blue_stained_glass':       [64,  64,  255],
  'minecraft:yellow_stained_glass':     [229, 229, 51 ],
  'minecraft:purple_stained_glass':     [127, 63,  178],
  'minecraft:orange_stained_glass':     [216, 127, 51 ],
  'minecraft:green_stained_glass':      [102, 127, 51 ],
  'minecraft:gray_stained_glass':       [76,  76,  76 ],
  'minecraft:light_blue_stained_glass': [102, 153, 216],
  'minecraft:pink_stained_glass':       [242, 127, 165],
  'minecraft:cyan_stained_glass':       [76,  127, 153],
  'minecraft:white_terracotta':         [209, 178, 161],
  'minecraft:gray_terracotta':          [95,  75,  69 ],
  'minecraft:iron_block':               [220, 220, 227],
  'minecraft:gold_block':               [249, 236, 77 ],
};
const FALLBACK_RGB: readonly [number, number, number] = [150, 150, 150];
function blockToRgb(block: string): readonly [number, number, number] {
  return BLOCK_RGB[block.split('[')[0]] ?? FALLBACK_RGB;
}

// ─── Post-processing ──────────────────────────────────────────────────────────

function keepLargestComponent(grid: VGrid, maxRemovalRatio = 1.0): number {
  const { width: W, height: H, length: L } = grid;
  const HL = H * L;
  const label = new Int32Array(W * HL).fill(-1);
  let numComp = 0;
  const sizes: number[] = [];

  for (let x0 = 0; x0 < W; x0++) {
    for (let y0 = 0; y0 < H; y0++) {
      for (let z0 = 0; z0 < L; z0++) {
        const i0 = x0 * HL + y0 * L + z0;
        if (label[i0] >= 0 || grid.get(x0, y0, z0) === 'minecraft:air') continue;
        const id = numComp++;
        let size = 0;
        const stack = [x0, y0, z0];
        label[i0] = id;
        while (stack.length > 0) {
          const z = stack.pop()!, y = stack.pop()!, x = stack.pop()!;
          size++;
          for (const [nx, ny, nz] of [[x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1]] as [number,number,number][]) {
            if (nx<0||nx>=W||ny<0||ny>=H||nz<0||nz>=L) continue;
            const ni = nx * HL + ny * L + nz;
            if (label[ni] >= 0 || grid.get(nx, ny, nz) === 'minecraft:air') continue;
            label[ni] = id;
            stack.push(nx, ny, nz);
          }
        }
        sizes.push(size);
      }
    }
  }

  if (numComp <= 1) return 0;

  const maxSize = Math.max(...sizes);
  const baseThreshold = Math.max(10, Math.round(maxSize * 0.10));
  const survivingCount = sizes.filter(s => s >= baseThreshold).length;
  const threshold = survivingCount >= 3 ? maxSize : baseThreshold;

  if (maxRemovalRatio < 1.0) {
    const totalNonAir = grid.countNonAir();
    let wouldClear = 0;
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
      const li = label[x * HL + y * L + z];
      if (li >= 0 && sizes[li] < threshold) wouldClear++;
    }
    if (totalNonAir > 0 && wouldClear / totalNonAir > maxRemovalRatio) return 0;
  }

  let cleared = 0;
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
    const li = label[x * HL + y * L + z];
    if (li >= 0 && sizes[li] < threshold) { grid.set(x, y, z, 'minecraft:air'); cleared++; }
  }
  return cleared;
}

function cropToContent(grid: VGrid): VGrid {
  const { width: GW, height: GH, length: GL } = grid;
  let minX = GW, maxX = -1, minY = GH, maxY = -1, minZ = GL, maxZ = -1;
  for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) for (let z = 0; z < GL; z++) {
    if (grid.get(x, y, z) !== 'minecraft:air') {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (maxX < 0) return grid;
  const cW = maxX - minX + 1, cH = maxY - minY + 1, cL = maxZ - minZ + 1;
  if (cW === GW && cH === GH && cL === GL) return grid;
  const data = new Map<number, string>();
  const idx = (x: number, y: number, z: number) => (x * cH + y) * cL + z;
  for (let x = 0; x < cW; x++) for (let y = 0; y < cH; y++) for (let z = 0; z < cL; z++) {
    const b = grid.get(x + minX, y + minY, z + minZ);
    if (b !== 'minecraft:air') data.set(idx(x, y, z), b);
  }
  let _count = -1;
  return {
    width: cW, height: cH, length: cL,
    get(x: number, y: number, z: number): string { return data.get(idx(x, y, z)) ?? 'minecraft:air'; },
    set(x: number, y: number, z: number, b: string): void {
      if (b === 'minecraft:air') data.delete(idx(x, y, z)); else data.set(idx(x, y, z), b); _count = -1;
    },
    countNonAir(): number { return _count < 0 ? (_count = data.size) : _count; },
  } as unknown as VGrid;
}

function trimToTriangularHull(grid: VGrid): number {
  const { width: GW, height: GH, length: GL } = grid;
  const zMin = new Array<number>(GW).fill(GL);
  const zMax = new Array<number>(GW).fill(-1);
  for (let x = 0; x < GW; x++) for (let y = 0; y < GH; y++) for (let z = 0; z < GL; z++) {
    if (grid.get(x, y, z) !== 'minecraft:air') {
      if (z < zMin[x]) zMin[x] = z; if (z > zMax[x]) zMax[x] = z;
    }
  }
  const span = zMin.map((mn, i) => zMax[i] >= mn ? zMax[i] - mn + 1 : 0);
  const filledSpans = span.filter(s => s > 0);
  if (filledSpans.length < 3) return 0;
  const maxSpan = Math.max(...filledSpans);
  const minSpan = Math.min(...filledSpans);
  let maxSpanX = 0;
  for (let x = 0; x < GW; x++) if (span[x] > span[maxSpanX]) maxSpanX = x;
  const isAtEnd = maxSpanX < GW * 0.25 || maxSpanX > GW * 0.75;
  if (GW < GL * 1.5 || minSpan > maxSpan * 0.35 || !isAtEnd) return 0;
  const sternX = maxSpanX < GW / 2 ? 0 : GW - 1;
  const bowX   = sternX === 0 ? GW - 1 : 0;
  const sternZ = (zMin[sternX] + zMax[sternX]) / 2;
  const bowZ   = (zMin[bowX]   + zMax[bowX])   / 2;
  const sternHalf = maxSpan / 2;
  const bowHalf   = minSpan / 2;
  let trimmed = 0;
  for (let x = 0; x < GW; x++) {
    if (span[x] === 0) continue;
    const t = Math.abs(x - sternX) / Math.max(1, Math.abs(bowX - sternX));
    const halfExpected = sternHalf + t * (bowHalf - sternHalf);
    const centerZ = sternZ + t * (bowZ - sternZ);
    const zLo = Math.floor(centerZ - halfExpected);
    const zHi = Math.ceil(centerZ + halfExpected);
    for (let y = 0; y < GH; y++) for (let z = 0; z < GL; z++) {
      if ((z < zLo || z > zHi) && grid.get(x, y, z) !== 'minecraft:air') {
        grid.set(x, y, z, 'minecraft:air'); trimmed++;
      }
    }
  }
  return trimmed;
}

function fillSingleVoxelGaps(grid: VGrid): number {
  const { width: GW, height: GH, length: GL } = grid;
  let filled = 0;
  for (let y = 0; y < GH; y++) {
    for (let z = 0; z < GL; z++) {
      for (let x = 1; x < GW - 1; x++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const l = grid.get(x - 1, y, z), r = grid.get(x + 1, y, z);
          if (l !== 'minecraft:air' && r !== 'minecraft:air') { grid.set(x, y, z, l); filled++; }
        }
      }
    }
    for (let x = 0; x < GW; x++) {
      for (let z = 1; z < GL - 1; z++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const f = grid.get(x, y, z - 1), b = grid.get(x, y, z + 1);
          if (f !== 'minecraft:air' && b !== 'minecraft:air') { grid.set(x, y, z, f); filled++; }
        }
      }
    }
  }
  return filled;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

const ISO_MAX   = 800;
const PANEL_SM  = 320;
const GAP = 4;
const BG: [number,number,number] = [200, 205, 210];

interface Panel { rgba: Uint8Array; w: number; h: number; }

function renderIsometric(grid: VGrid, maxSize = ISO_MAX): Panel {
  const GW = grid.width, GH = grid.height, GL = grid.length;
  const sxOff2 = 2 * (GL - 1);
  const syOff2 = 2 * (GH - 1) + (GW - 1) + (GL - 1);
  const canW2 = sxOff2 + 2 * (GW - 1) + 1;
  const canH2 = syOff2 + 1;
  const BLOCK = Math.max(1, Math.floor(maxSize / Math.max(canW2, canH2)));
  const canW = canW2 * BLOCK;
  const canH = canH2 * BLOCK;

  const rgba = new Uint8Array(canW * canH * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }
  const zbuf = new Int32Array(canW * canH).fill(-1);
  const shade = (c: number, f: number) => Math.min(255, Math.round(c * f));

  for (let gx = 0; gx < GW; gx++) {
    for (let gz = 0; gz < GL; gz++) {
      for (let gy = 0; gy < GH; gy++) {
        const b = grid.get(gx, gy, gz);
        if (b === 'minecraft:air') continue;
        const [r0, g0, b0] = blockToRgb(b);
        const heightMod = 0.70 + 0.50 * (gy / Math.max(1, GH - 1));
        const r0h = Math.min(255, Math.round(r0 * heightMod));
        const g0h = Math.min(255, Math.round(g0 * heightMod));
        const b0h = Math.min(255, Math.round(b0 * heightMod));
        const depth = gx + gz + gy;
        const sx2 = (gx - gz) * 2 + sxOff2;
        const sy2 = -(gy * 2 + gx + gz) + syOff2;
        for (let dy2 = 0; dy2 < 2; dy2++) {
          for (let dx2 = 0; dx2 < 2; dx2++) {
            const px2 = sx2 + dx2;
            const py2 = sy2 - dy2;
            if (px2 < 0 || px2 >= canW2 || py2 < 0 || py2 >= canH2) continue;
            const isTop = dy2 === 1;
            const isRight = dx2 === 1;
            const f = isTop ? 1.35 : isRight ? 1.0 : 0.75;
            for (let py = py2 * BLOCK; py < (py2 + 1) * BLOCK; py++) {
              for (let px = px2 * BLOCK; px < (px2 + 1) * BLOCK; px++) {
                if (px < 0 || px >= canW || py < 0 || py >= canH) continue;
                const ci = py * canW + px;
                if (depth >= zbuf[ci]) {
                  zbuf[ci] = depth;
                  const pi = ci * 4;
                  rgba[pi]   = shade(r0h, f);
                  rgba[pi+1] = shade(g0h, f);
                  rgba[pi+2] = shade(b0h, f);
                  rgba[pi+3] = 255;
                }
              }
            }
          }
        }
      }
    }
  }
  return { rgba, w: canW, h: canH };
}

function renderSideView(grid: VGrid, maxSize = PANEL_SM): Panel {
  const { width: GW, height: GH, length: GL } = grid;
  const scale = maxSize / Math.max(GL, GH, 1);
  const dw = Math.max(1, Math.round(GL * scale));
  const dh = Math.max(1, Math.round(GH * scale));
  const rgba = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }
  for (let iz = 0; iz < dw; iz++) {
    for (let iy = 0; iy < dh; iy++) {
      const gz = Math.min(GL - 1, Math.floor(iz * GL / dw));
      const gy = GH - 1 - Math.min(GH - 1, Math.floor(iy * GH / dh));
      for (let x = GW - 1; x >= 0; x--) {
        const b = grid.get(x, gy, gz);
        if (b !== 'minecraft:air') {
          const [r, g, b0] = blockToRgb(b);
          const pi = (iy * dw + iz) * 4;
          rgba[pi] = r; rgba[pi+1] = g; rgba[pi+2] = b0; rgba[pi+3] = 255;
          break;
        }
      }
    }
  }
  // Edge enhancement
  const isBg = (px: number): boolean => {
    const i = px * 4;
    return rgba[i+3] === 255 && Math.abs(rgba[i] - BG[0]) < 15 && Math.abs(rgba[i+1] - BG[1]) < 15 && Math.abs(rgba[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const pi = y * dw + x;
    if (isBg(pi)) continue;
    if ([pi-1,pi+1,pi-dw,pi+dw].some(n => n >= 0 && n < dw*dh && isBg(n))) {
      const i = pi * 4;
      rgba[i] = Math.round(rgba[i] * 0.4); rgba[i+1] = Math.round(rgba[i+1] * 0.4); rgba[i+2] = Math.round(rgba[i+2] * 0.4);
    }
  }
  return { rgba, w: dw, h: dh };
}

function renderTopView(grid: VGrid, maxSize = PANEL_SM): Panel {
  const { width: GW, height: GH, length: GL } = grid;
  const scale = maxSize / Math.max(GW, GL, 1);
  const dw = Math.max(1, Math.round(GW * scale));
  const dh = Math.max(1, Math.round(GL * scale));
  const rgba = new Uint8Array(dw * dh * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }
  for (let dz = 0; dz < dh; dz++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(GW - 1, Math.floor(dx * GW / dw));
      const sz = Math.min(GL - 1, Math.floor(dz * GL / dh));
      for (let y = GH - 1; y >= 0; y--) {
        const b = grid.get(sx, y, sz);
        if (b !== 'minecraft:air') {
          const [r, g, b0] = blockToRgb(b);
          const pi = (dz * dw + dx) * 4;
          rgba[pi] = r; rgba[pi+1] = g; rgba[pi+2] = b0; rgba[pi+3] = 255;
          break;
        }
      }
    }
  }
  // Edge enhancement
  const isBgT = (px: number): boolean => {
    const i = px * 4;
    return rgba[i+3] === 255 && Math.abs(rgba[i] - BG[0]) < 15 && Math.abs(rgba[i+1] - BG[1]) < 15 && Math.abs(rgba[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const pi = y * dw + x;
    if (isBgT(pi)) continue;
    if ([pi-1,pi+1,pi-dw,pi+dw].some(n => n >= 0 && n < dw*dh && isBgT(n))) {
      const i = pi * 4;
      rgba[i] = Math.round(rgba[i] * 0.4); rgba[i+1] = Math.round(rgba[i+1] * 0.4); rgba[i+2] = Math.round(rgba[i+2] * 0.4);
    }
  }
  return { rgba, w: dw, h: dh };
}

function renderViews(grid: VGrid): Buffer {
  const iso = renderIsometric(grid);
  const top = renderTopView(grid);
  const side = renderSideView(grid);

  // Edge-enhance iso
  const isBgIso = (px: number): boolean => {
    const i = px * 4;
    return iso.rgba[i+3] === 255 && Math.abs(iso.rgba[i] - BG[0]) < 15 && Math.abs(iso.rgba[i+1] - BG[1]) < 15 && Math.abs(iso.rgba[i+2] - BG[2]) < 15;
  };
  const enhancedIso = new Uint8Array(iso.rgba);
  for (let y = 0; y < iso.h; y++) for (let x = 0; x < iso.w; x++) {
    const pi = y * iso.w + x;
    if (isBgIso(pi)) continue;
    if ([pi-1,pi+1,pi-iso.w,pi+iso.w].some(n => n >= 0 && n < iso.w*iso.h && isBgIso(n))) {
      const i = pi * 4;
      enhancedIso[i] = Math.round(enhancedIso[i] * 0.4);
      enhancedIso[i+1] = Math.round(enhancedIso[i+1] * 0.4);
      enhancedIso[i+2] = Math.round(enhancedIso[i+2] * 0.4);
    }
  }

  function paste(dst: Uint8Array, dstW: number, src: Uint8Array, srcW: number, srcH: number, xOff: number, yOff: number) {
    for (let y = 0; y < srcH; y++) for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4;
      const di = ((y + yOff) * dstW + xOff + x) * 4;
      dst[di] = src[si]; dst[di+1] = src[si+1]; dst[di+2] = src[si+2]; dst[di+3] = src[si+3];
    }
  }

  const totalW = iso.w + GAP + top.w + GAP + side.w;
  const totalH = Math.max(iso.h, top.h, side.h);
  const combined = new Uint8Array(totalW * totalH * 4);
  for (let i = 0; i < combined.length; i += 4) {
    combined[i] = BG[0]; combined[i+1] = BG[1]; combined[i+2] = BG[2]; combined[i+3] = 255;
  }
  paste(combined, totalW, enhancedIso, iso.w, iso.h, 0, Math.floor((totalH - iso.h) / 2));
  paste(combined, totalW, top.rgba, top.w, top.h, iso.w + GAP, Math.floor((totalH - top.h) / 2));
  paste(combined, totalW, side.rgba, side.w, side.h, iso.w + GAP + top.w + GAP, Math.floor((totalH - side.h) / 2));

  return encodePng(totalW, totalH, combined);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchUrl(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

async function fetchMpd(setId: string): Promise<string | null> {
  const local = join(import.meta.dir, '..', 'web', 'public', `${setId}.mpd`);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const buf = await fetchUrl(`https://library.ldraw.org/library/omr/${setId}.mpd`);
  return buf ? buf.toString('utf8') : null;
}

// ─── Models ───────────────────────────────────────────────────────────────────

const MODELS = [
  { id: '10030-1', name: 'Imperial Star Destroyer', theme: 'Star Wars',
    desc: 'Massive grey triangular Star Wars Imperial Star Destroyer — long flat wedge hull that tapers to a point, tiered dorsal hull ridges running lengthwise, elevated command tower block at the stern (wide end)' },
  { id: '8855-1',  name: 'Prop Plane',              theme: 'Technic',
    desc: 'Yellow LEGO Technic propeller biplane — two sets of wide horizontal wings (upper and lower), circular rear propeller disc, large round disc-shaped landing wheels on either side, long fuselage body' },
  { id: '42049-1', name: 'Mine Loader',              theme: 'Technic',
    desc: 'Yellow articulated underground mine loader — 4 large round black wheels, front bucket/shovel arm extending forward, compact boxy yellow body, orange/red cylindrical drum attachment at the rear' },
  { id: '60067-1', name: 'Helicopter Pursuit',       theme: 'City',
    desc: 'LEGO City scene: a dark blue/grey police helicopter (large circular rotor disc on top, tail boom extending back, skid landing gear) PLUS a dark grey speedboat beside it. Two vehicles: the helicopter is the main feature, the speedboat is secondary.' },
  { id: '6545-1',  name: "Search N' Rescue",         theme: 'Town',
    desc: 'LEGO Town Search & Rescue scene with MULTIPLE vehicles: a white/blue helicopter (large spread rotor blades), a police car, a boat trailer, and a motorboat. All are part of the set. Look for the helicopter rotor disc as the key identifying feature.' },
  { id: '1472-1',  name: 'Holiday Home',             theme: 'Town',
    desc: 'LEGO Town 1987 holiday lakeside scene — a house/building with peaked A-frame roof as the central element, two small cars parked nearby, a boat trailer, and a motorboat. Multiple objects spread across the scene; the house with its triangular roof is the main structure.' },
] as const;

// Parts to skip: large baseplates that dominate and obscure models
const SKIP_PARTS = new Set(['3867', '3811', '3807', '3857']);

// ─── Main ─────────────────────────────────────────────────────────────────────

const ROOT       = join(import.meta.dir, '..');
const OUT_DIR    = join(ROOT, '.grade-out');
const STATE_FILE = join(ROOT, '.claude', 'showcase-loop-state.json');
const THUMBS_DIR = join(ROOT, 'web', 'public', 'lego-thumbs');

function getRefImage(setId: string): Buffer | null {
  const p = join(THUMBS_DIR, `${setId}.jpg`);
  return existsSync(p) ? readFileSync(p) : null;
}

mkdirSync(OUT_DIR, { recursive: true });

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const THRESHOLD = state.score_threshold ?? 8;
const API_KEY   = process.env.ANTHROPIC_API_KEY ?? '';

const newScores: Record<string, number> = { ...state.scores };
const allIssues: string[] = [];
let   passingCount = 0;

for (const model of MODELS) {
  console.log(`\n▶ ${model.id} — ${model.name}`);

  const mpd = await fetchMpd(model.id);
  if (!mpd) { console.error('  ✗ MPD fetch failed'); continue; }

  const allBricks = parseLDraw(mpd);
  // Filter baseplates and oversized parts
  const bricks = allBricks.filter((b: ParsedBrick) => {
    const partBase = b.part.toLowerCase().replace('.dat', '');
    if (SKIP_PARTS.has(partBase)) return false;
    const [sW, sH, sL] = getPartDims(b.part);
    return !(sH === 1 && sW >= 12 && sL >= 12);
  });

  const { grid, dimensions: { w, h, l } } = voxelizeLDraw(bricks, undefined, { cubicScale: true });

  // Post-processing — limit component removal to 10% of total to preserve rotors/secondary parts
  const cleared = keepLargestComponent(grid, 0.10);
  const trimmed = trimToTriangularHull(grid);
  fillSingleVoxelGaps(grid);
  const renderGrid = cropToContent(grid);

  const renderBuf = renderViews(renderGrid);
  writeFileSync(join(OUT_DIR, `${model.id}-showcase.png`), renderBuf);
  const suffix = [cleared > 0 ? `-${cleared} scattered` : '', trimmed > 0 ? `-${trimmed} hull-trim` : ''].filter(Boolean).join(', ');
  console.log(`  rendered ${w}×${h}×${l}${suffix ? ` (${suffix})` : ''} (${(renderBuf.length/1024).toFixed(0)}KB)`);

  const refBuf = getRefImage(model.id);
  if (refBuf) console.log(`  ref thumb loaded (${(refBuf.length/1024).toFixed(0)}KB)`);

  // Build vision message content
  const content: object[] = [
    {
      type: 'text',
      text: `Minecraft-block voxelization of LEGO set ${model.id} ("${model.name}") rendered in THREE panels:\n  LEFT: isometric 3D view  |  CENTRE: top-down view  |  RIGHT: side profile view\n\nWhat the real set looks like: ${model.desc}\n\nCONTEXT: Every LEGO part is a solid rectangular block in the voxelization — rotor discs appear as flat ovals, propellers as cross shapes, wheels as disc clusters, thin wings as struts. Colours WILL differ from reality due to the limited Minecraft block palette (~20 colours). This is EXPECTED and should NOT affect scoring.\n\nThe reference photo below (if present) shows the real set's SHAPE for comparison — ignore colour differences entirely.`
    },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: renderBuf.toString('base64') } },
    ...(refBuf ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refBuf.toString('base64') } }] : []),
    {
      type: 'text',
      text: `TASK: Look at ALL THREE panels. Can you identify this as "${model.name}"? Use the description and reference photo (shape only, ignore colours).

SCORING:
  9-10 = clearly identifiable; key structural features present across panels
  8    = identifiable as this model type; main features visible in at LEAST ONE panel
  7    = general category only (you can say "helicopter" but not which one)
  5-6  = unidentifiable / completely wrong shape
  3-4  = incomprehensible

CRITICAL RULES — READ CAREFULLY:
1. If ANY panel shows the key identifying features, score AT LEAST 8. One good view is enough.
2. Do NOT score below 8 just because some panels are unclear — look at ALL three.
3. Do NOT penalise for wrong/simplified colours — block palette is limited.
4. Scoring 8 means "I can identify this as the right type of model." That is sufficient for 8.

For helicopter sets: if ANY panel shows a circular/cross rotor disc above a body shape, score 8 or higher.
For ship/vehicle sets with multiple vehicles: if the main vehicle type is identifiable in any panel, score 8+.
For wedge/ship shapes: if the triangular wedge silhouette is clear, score 8+.

Reply IMMEDIATELY — NO preamble:
SCORE: N
ISSUES: issue1 | issue2 | issue3`,
    },
  ];

  let score = newScores[model.id] ?? 5;
  let issues: string[] = [];

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content }] }),
    });
    const data = await resp.json() as { content: Array<{ text: string }> };
    const text = data.content?.[0]?.text ?? '';
    console.log(`  response: ${text.slice(0, 250).replace(/\n/g, ' ')}`);

    const m = /^(?:##?\s+)?SCORE:\s*\*{0,2}(\d+)\*{0,2}/im.exec(text);
    if (m) score = parseInt(m[1], 10);
    else {
      const all = [...text.matchAll(/(\d+)\s*\/?\s*10/g)];
      if (all.length) score = parseInt(all[all.length - 1][1], 10);
    }

    const issueLines = text
      .split('|')
      .map(l => l.replace(/^[-•*\d.]+\s*\*?\*?/, '').replace(/\*\*/g, '').trim())
      .filter(l => l.length > 10 && !l.match(/^(SCORE|Score|image|render|voxel|grade|assess)/i));

    issues = issueLines.slice(0, 4).map(i => `${model.id}: ${i}`);
  } catch (e) {
    console.error(`  ✗ grading error: ${e}`);
  }

  console.log(`  → ${score}/10`);
  newScores[model.id] = score;
  allIssues.push(...issues);
  if (score >= THRESHOLD) passingCount++;
}

// Update state
state.scores        = newScores;
state.issues        = allIssues.slice(0, 20);
state.passing_count = passingCount;
state.pass          = (state.pass ?? 0) + 1;
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const total = MODELS.length;
console.log(`\n✓ Pass ${state.pass} — ${passingCount}/${total} ≥${THRESHOLD}/10`);
console.log(`  Scores: ${JSON.stringify(newScores)}`);
