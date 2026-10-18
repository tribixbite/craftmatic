#!/usr/bin/env bun
/**
 * Grade 10 LEGO models using geometry-accurate voxelization.
 * Renders orthographic views (isometric/side/top) then grades each 1-10
 * via Claude vision API (Anthropic).
 * Writes scores and issues to .claude/geometry-grade-state.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDrawGeometry, setLDrawRoot } from '../web/src/engine/ldraw-geometry.js';

const LDRAW_ROOT = 'C:/git/clego/extracted/studio_release/app/ldraw';
const LDR_DIR    = 'C:/git/clego/lego_sets/LDR/';
const STATE_FILE = join(import.meta.dir, '..', '.claude', 'geometry-grade-state.json');
const OUT_DIR    = join(import.meta.dir, '..', '.grade-geometry-out');
const SCORE_THRESHOLD = 9; // out of 10

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

setLDrawRoot(LDRAW_ROOT);

const BENCHMARKS = [
  { file: '71043_hogwarts_castle.ldr', name: 'Hogwarts Castle' },
  { file: '42083 Bugatti Chiron.mpd', name: 'Bugatti Chiron' },
  { file: '10179 UCS Millenium Falcon.mpd', name: 'UCS Millennium Falcon' },
  { file: '10255 Assembly Square.ldr', name: 'Assembly Square' },
  { file: '60216 Downtown Fire Brigade.mpd', name: 'Downtown Fire Brigade' },
  { file: '31084 Pirate Roller Coaster [Model A].mpd', name: 'Pirate Roller Coaster' },
  { file: '8010 Darth Vader.mpd', name: 'Darth Vader Figure' },
  { file: '6986 Mission Commander.mpd', name: 'Mission Commander Spaceship' },
  { file: '8849 Tractor.ldr', name: 'Technic Tractor' },
  { file: '1924 Viking Line Ferry.ldr', name: 'Viking Line Ferry' },
];

// ── Block RGB lookup ──────────────────────────────────────────────────────────
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
  'minecraft:light_gray_concrete_powder': [228, 228, 228],
  'minecraft:quartz_block':             [236, 229, 220],
  'minecraft:iron_block':               [220, 220, 227],
  'minecraft:gold_block':               [249, 236, 77 ],
};
const FALLBACK_RGB: readonly [number, number, number] = [150, 150, 150];
function blockToRgb(block: string): readonly [number, number, number] {
  return BLOCK_RGB[block.split('[')[0]] ?? FALLBACK_RGB;
}

// ── Minimal PNG encoder ───────────────────────────────────────────────────────
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
  return new Uint8Array([(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
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

// ── Grid type alias ───────────────────────────────────────────────────────────
type Grid = { width: number; height: number; length: number; get(x: number, y: number, z: number): string; set(x: number, y: number, z: number, b: string): void; countNonAir(): number };

// ── Connected-component filter ────────────────────────────────────────────────
/**
 * Removes tiny disconnected debris (< 10% of the largest cluster size).
 * For multi-vehicle scene sets (3+ surviving clusters), keeps ONLY the single
 * largest cluster.
 * Returns number of cleared voxels.
 */
function keepLargestComponent(grid: Grid, maxRemovalRatio = 1.0): number {
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
          const nbrs: [number, number, number][] = [
            [x+1,y,z],[x-1,y,z],[x,y+1,z],[x,y-1,z],[x,y,z+1],[x,y,z-1],
          ];
          for (const [nx, ny, nz] of nbrs) {
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
  const baseThreshPct = 0.10;
  const baseThreshold = Math.max(10, Math.round(maxSize * baseThreshPct));

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
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      for (let z = 0; z < L; z++) {
        const li = label[x * HL + y * L + z];
        if (li >= 0 && sizes[li] < threshold) {
          grid.set(x, y, z, 'minecraft:air');
          cleared++;
        }
      }
    }
  }
  return cleared;
}

/**
 * Crop the grid to its tight content bounding box (strip empty border rows/columns).
 * Returns a new virtual grid object; does not modify the original.
 */
function cropToContent(grid: Grid): Grid {
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
  };
}

// ── Renderer ──────────────────────────────────────────────────────────────────
const PANEL_SM  = 350;
const ISO_MAX   = 1000;
const GAP = 4;
const BG: [number,number,number] = [200, 205, 210];

interface Panel { rgba: Uint8Array; w: number; h: number; }

/**
 * Isometric projection (2:1 pixel-art style).
 */
function renderIsometric(grid: Grid, maxSize = ISO_MAX): Panel {
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
            const brightness = (r0h + g0h + b0h) / (3 * 255);
            const contrast = brightness > 0.65 ? 0.12 : 0.28;
            const f = isTop ? (1 + contrast) : isRight ? 1.0 : (1 - contrast);

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

/**
 * Side orthographic view: looking from +X direction, showing the Z-Y plane.
 */
function renderSideView(grid: Grid, maxSize = PANEL_SM): Panel {
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
  const isBgPixel = (px: number): boolean => {
    const i = px * 4;
    return rgba[i+3] === 255 &&
      Math.abs(rgba[i] - BG[0]) < 15 &&
      Math.abs(rgba[i+1] - BG[1]) < 15 &&
      Math.abs(rgba[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const pi = y * dw + x;
      if (isBgPixel(pi)) continue;
      const nbrs = [pi-1, pi+1, pi-dw, pi+dw];
      if (nbrs.some(n => n >= 0 && n < dw*dh && isBgPixel(n))) {
        const i = pi * 4;
        rgba[i]   = Math.round(rgba[i]   * 0.4);
        rgba[i+1] = Math.round(rgba[i+1] * 0.4);
        rgba[i+2] = Math.round(rgba[i+2] * 0.4);
      }
    }
  }

  return { rgba, w: dw, h: dh };
}

/**
 * Top-down orthographic view (looking straight down from Y+).
 */
function renderTopView(grid: Grid, maxSize = PANEL_SM): Panel {
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
    return rgba[i+3] === 255 &&
      Math.abs(rgba[i] - BG[0]) < 15 &&
      Math.abs(rgba[i+1] - BG[1]) < 15 &&
      Math.abs(rgba[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const pi = y * dw + x;
      if (isBgT(pi)) continue;
      const nbrs = [pi-1, pi+1, pi-dw, pi+dw];
      if (nbrs.some(n => n >= 0 && n < dw*dh && isBgT(n))) {
        const i = pi * 4;
        rgba[i]   = Math.round(rgba[i]   * 0.4);
        rgba[i+1] = Math.round(rgba[i+1] * 0.4);
        rgba[i+2] = Math.round(rgba[i+2] * 0.4);
      }
    }
  }

  return { rgba, w: dw, h: dh };
}

function renderViews(grid: Grid): Buffer {
  const iso = renderIsometric(grid);
  const top = renderTopView(grid);
  const front = renderSideView(grid);

  // Edge-enhance isometric
  const W_iso = iso.w, H_iso = iso.h;
  const enhancedIso = new Uint8Array(iso.rgba);
  const isBgIso = (px: number): boolean => {
    const i = px * 4;
    return enhancedIso[i+3] === 255 &&
      Math.abs(enhancedIso[i] - BG[0]) < 15 &&
      Math.abs(enhancedIso[i+1] - BG[1]) < 15 &&
      Math.abs(enhancedIso[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < H_iso; y++) {
    for (let x = 0; x < W_iso; x++) {
      const pi = y * W_iso + x;
      if (isBgIso(pi)) continue;
      const nbrs = [pi-1, pi+1, pi-W_iso, pi+W_iso];
      if (nbrs.some(n => n >= 0 && n < W_iso*H_iso && isBgIso(n))) {
        const i = pi * 4;
        enhancedIso[i]   = Math.round(enhancedIso[i]   * 0.4);
        enhancedIso[i+1] = Math.round(enhancedIso[i+1] * 0.4);
        enhancedIso[i+2] = Math.round(enhancedIso[i+2] * 0.4);
      }
    }
  }

  function pastePanelAt(
    dst: Uint8Array, dstW: number, _dstH: number,
    src: Uint8Array, srcW: number, srcH: number,
    xOff: number, yOff: number,
  ) {
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) {
        const si = (y * srcW + x) * 4;
        const di = ((y + yOff) * dstW + xOff + x) * 4;
        dst[di]   = src[si];   dst[di+1] = src[si+1];
        dst[di+2] = src[si+2]; dst[di+3] = src[si+3];
      }
    }
  }

  const totalW = W_iso + GAP + top.w + GAP + front.w;
  const totalH = Math.max(H_iso, top.h, front.h);
  const combined = new Uint8Array(totalW * totalH * 4);
  for (let i = 0; i < combined.length; i += 4) {
    combined[i] = BG[0]; combined[i+1] = BG[1]; combined[i+2] = BG[2]; combined[i+3] = 255;
  }

  pastePanelAt(combined, totalW, totalH, enhancedIso, W_iso, H_iso, 0, Math.floor((totalH - H_iso) / 2));
  pastePanelAt(combined, totalW, totalH, top.rgba, top.w, top.h, W_iso + GAP, Math.floor((totalH - top.h) / 2));
  pastePanelAt(combined, totalW, totalH, front.rgba, front.w, front.h, W_iso + GAP + top.w + GAP, Math.floor((totalH - front.h) / 2));

  return encodePng(totalW, totalH, combined);
}

// ── Vision grading (OpenRouter free models) ─────────────────────────────────
const OPENROUTER_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'arcee-ai/trinity-large-preview:free',
];

async function gradeVisually(
  renderPng: Buffer, modelName: string
): Promise<{ score: number; issues: string[] }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) { console.warn('  !! No OPENROUTER_API_KEY'); return { score: 0, issues: ['no API key'] }; }

  const prompt =
    `Minecraft-block voxelization rendered in THREE panels:\n` +
    `  LEFT: isometric 3D view (dominant)  |  CENTRE: top-down view  |  RIGHT: side profile\n\n` +
    `LEGO set: "${modelName}"\n\n` +
    `CONTEXT: This is a geometry-accurate voxelization of a LEGO model into Minecraft blocks. ` +
    `The voxelizer traces actual part geometry (not just bounding boxes), so curved and angled surfaces ` +
    `appear as stepped block approximations. ~20 Minecraft colours only — judge SHAPE, not colour.\n\n` +
    `TASK: Can you identify WHAT TYPE of vehicle/object/building this is from the shape alone?\n\n` +
    `SCORING:\n` +
    `  9-10 = overall type/shape clearly identifiable; major structures present\n` +
    `  7-8  = type barely identifiable OR major structure missing but enough to guess\n` +
    `  5    = hard to identify; vague resemblance at best\n` +
    `  3    = completely unidentifiable; no resemblance\n\n` +
    `Reply in EXACT format, NO preamble:\nSCORE: N\nISSUES: issue1 | issue2`;

  // Try each free model in order until one succeeds (with rate-limit retry)
  for (const model of OPENROUTER_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const delay = 15_000 * attempt;
        process.stdout.write(`  (rate limited, waiting ${delay/1000}s...) `);
        await new Promise(r => setTimeout(r, delay));
      }
    try {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${renderPng.toString('base64')}` } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!resp.ok) {
        const body = await resp.text();
        if (resp.status === 429) {
          console.warn(`  !! ${model} rate limited`);
          continue; // retry after delay
        }
        console.warn(`  !! ${model} error ${resp.status}: ${body.slice(0, 120)}`);
        break; // try next model (not retryable)
      }

      const json = await resp.json() as { choices?: { message: { content: string } }[] };
      const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
      console.log(`  [${model.split('/')[1]?.split(':')[0]}] ${raw.slice(0, 120)}`);

      const scoreMatch = /SCORE:\s*(\d+)/i.exec(raw);
      const issuesMatch = /ISSUES:\s*(.+)/i.exec(raw);
      const score = scoreMatch ? Math.min(10, Math.max(1, parseInt(scoreMatch[1], 10))) : 0;
      const issues = issuesMatch
        ? issuesMatch[1].split('|').map(s => s.trim()).filter(Boolean)
        : [];
      return { score, issues };
    } catch (e) {
      console.warn(`  !! ${model} failed: ${e instanceof Error ? e.message : String(e)}`);
      break; // try next model
    }
    } // end retry loop
  } // end model loop

  return { score: 0, issues: ['all models failed'] };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nGeometry-Accurate Visual Grading — 10 Benchmark Models');
  console.log('======================================================\n');

  const scores: Record<string, number> = {};
  const allIssues: string[] = [];
  let passingCount = 0;

  for (const bench of BENCHMARKS) {
    const filePath = join(LDR_DIR, bench.file);
    console.log(`\n[${bench.file}] ${bench.name}`);

    // 1. Read file from local filesystem
    if (!existsSync(filePath)) {
      console.log(`  !! File not found: ${filePath}`);
      scores[bench.file] = 0;
      allIssues.push(`${bench.name}: file not found`);
      continue;
    }

    process.stdout.write('  Reading file... ');
    const mpdText = readFileSync(filePath, 'utf8');
    console.log(`${(mpdText.length/1024).toFixed(0)}KB`);

    // 2. Parse + geometry-accurate voxelize
    process.stdout.write('  Parsing + geometry voxelizing... ');
    const bricks = parseLDraw(mpdText);

    let result;
    try {
      result = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: true });
      if (result.dimensions.h < 4) {
        const cubicH = result.dimensions.h;
        const accurateResult = await voxelizeLDrawGeometry(bricks, undefined, { cubicScale: false });
        if (accurateResult.dimensions.h >= 4) {
          result = accurateResult;
          console.log(`  [fallback] cubic h=${cubicH} < 4 -- using accurate mode`);
        }
      }
    } catch (e: unknown) {
      console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
      scores[bench.file] = 0;
      allIssues.push(`${bench.name}: voxelization error`);
      continue;
    }

    const { grid, dimensions, brickCount } = result;

    // 3. Post-processing: keepLargestComponent + cropToContent only (no solidify/gapFill)
    const cleared = keepLargestComponent(grid);
    const renderGrid = cropToContent(grid);

    const suffix = cleared > 0 ? ` (-${cleared} scattered)` : '';
    console.log(`${brickCount} bricks -> ${renderGrid.countNonAir()} blocks, ${dimensions.w}x${dimensions.h}x${dimensions.l}${suffix}`);

    if (renderGrid.countNonAir() < 10) {
      console.log('  !! Almost empty grid -- skipping');
      scores[bench.file] = 1;
      allIssues.push(`${bench.name}: voxelization produced < 10 blocks`);
      continue;
    }

    // 4. Render
    process.stdout.write('  Rendering views... ');
    const png = renderViews(renderGrid);
    const renderPath = join(OUT_DIR, `${bench.file.replace(/[^a-zA-Z0-9._-]/g, '_')}-render.png`);
    writeFileSync(renderPath, png);
    console.log(`${(png.length/1024).toFixed(0)}KB -> ${renderPath}`);

    // 5. Grade via Claude vision
    process.stdout.write('  Grading... ');
    const { score, issues } = await gradeVisually(png, bench.name);
    scores[bench.file] = score;
    allIssues.push(...issues.map(i => `${bench.name}: ${i}`));
    const pass = score >= SCORE_THRESHOLD;
    if (pass) passingCount++;
    console.log(`Score: ${score}/10 -- ${pass ? 'PASS' : 'needs improvement'}`);
    // Rate limit courtesy delay between models (free tier = ~2 req/min)
    await new Promise(r => setTimeout(r, 35_000));
  }

  console.log('\n======================================================');
  console.log('Results:');
  for (const bench of BENCHMARKS) {
    const s = scores[bench.file] ?? 0;
    console.log(`  ${bench.name}: ${s}/10 ${s >= SCORE_THRESHOLD ? 'PASS' : 'FAIL'}`);
  }
  console.log(`\nPassing: ${passingCount}/${BENCHMARKS.length} (threshold: ${SCORE_THRESHOLD}/10)`);

  // Save state
  const state = {
    benchmarks: BENCHMARKS,
    scores,
    issues: [...new Set(allIssues)].slice(0, 30),
    passing_count: passingCount,
    total: BENCHMARKS.length,
    threshold: SCORE_THRESHOLD,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('\nState saved:', STATE_FILE);
}

main().catch(console.error);
