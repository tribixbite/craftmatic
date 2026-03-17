#!/usr/bin/env bun
/**
 * Visual quality grading for LEGO voxelization pipeline.
 *
 * For each test set:
 *   1. Fetches MPD from OMR, parses and voxelizes
 *   2. Renders a 3-panel orthographic PNG (front / side / top)
 *   3. Loads local reference thumbnail from web/public/lego-thumbs/
 *   4. Calls Claude vision API to grade structural accuracy 0-100
 *
 * Exit 0 if all grades ≥ PASS_THRESHOLD.
 * Exit 1 otherwise — triggers continued pipeline refinement via Stop hook.
 */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PASS_THRESHOLD = 99;
const OMR_BASE = 'https://library.ldraw.org/library/omr';
const THUMBS_DIR = join(import.meta.dir, '..', 'web', 'public', 'lego-thumbs');
const OUT_DIR    = join(import.meta.dir, '..', '.grade-out');

const SETS = [
  { set_num: '21309-1', name: 'NASA Apollo Saturn V'         },
  { set_num: '10030-1', name: 'UCS Imperial Star Destroyer'  },
  { set_num: '10179-1', name: 'UCS Millennium Falcon'        },
];

// ── Block name → RGB ───────────────────────────────────────────────────────────

const BLOCK_RGB: Record<string, readonly [number, number, number]> = {
  'minecraft:black_concrete':           [8,   10,  15 ],
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
};

const FALLBACK_RGB: readonly [number, number, number] = [150, 150, 150];

function blockToRgb(block: string): readonly [number, number, number] {
  return BLOCK_RGB[block.split('[')[0]] ?? FALLBACK_RGB;
}

// ── Minimal PNG encoder ────────────────────────────────────────────────────────

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
  const t = getCrcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput));
  return Buffer.concat([lenBuf, typeBytes, data, crcBuf]);
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);  // 8-bit depth
  ihdr.writeUInt8(6, 9);  // RGBA colour type
  // bytes 10-12 stay 0 (compression, filter, interlace)

  const rowBytes = width * 4;
  const raw = Buffer.alloc((1 + rowBytes) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (1 + rowBytes)] = 0; // filter type: None
    raw.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), y * (1 + rowBytes) + 1);
  }

  const idat = deflateSync(raw, { level: 6 });

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Orthographic renderer ──────────────────────────────────────────────────────

const PANEL_MAX = 180;
const GAP       = 8;
const BG        = [240, 240, 240] as const;

interface Panel { rgba: Uint8Array; w: number; h: number }

function scalePanel(src: Uint8Array, hit: Uint8Array, srcW: number, srcH: number): Panel {
  const scale = Math.min(PANEL_MAX / srcW, PANEL_MAX / srcH, 4); // cap upscale at 4×
  const dstW = Math.max(1, Math.round(srcW * scale));
  const dstH = Math.max(1, Math.round(srcH * scale));
  const rgba = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x / scale));
      const sy = Math.min(srcH - 1, Math.floor(y / scale));
      const di = (y * dstW + x) * 4;
      if (hit[sy * srcW + sx]) {
        const ci = (sy * srcW + sx) * 3;
        rgba[di]   = src[ci];
        rgba[di+1] = src[ci+1];
        rgba[di+2] = src[ci+2];
        rgba[di+3] = 255;
      } else {
        rgba[di] = rgba[di+1] = rgba[di+2] = 220;
        rgba[di+3] = 255;
      }
    }
  }
  return { rgba, w: dstW, h: dstH };
}

function renderViews(
  grid: { width: number; height: number; length: number; get(x: number, y: number, z: number): string },
): Buffer {
  const GW = grid.width, GH = grid.height, GL = grid.length;

  // Front view: project onto X×Y looking from +Z (front-most Z wins)
  const frontRgb = new Uint8Array(GW * GH * 3);
  const frontHit = new Uint8Array(GW * GH);
  for (let x = 0; x < GW; x++) {
    for (let y = 0; y < GH; y++) {
      for (let z = GL - 1; z >= 0; z--) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r, g, bl] = blockToRgb(b);
          const row = GH - 1 - y; // flip Y (grid Y up, image Y down)
          const ci = (row * GW + x) * 3;
          frontRgb[ci] = r; frontRgb[ci+1] = g; frontRgb[ci+2] = bl;
          frontHit[row * GW + x] = 1;
          break;
        }
      }
    }
  }

  // Side view: project onto Z×Y looking from +X (highest X wins)
  const sideRgb = new Uint8Array(GL * GH * 3);
  const sideHit = new Uint8Array(GL * GH);
  for (let z = 0; z < GL; z++) {
    for (let y = 0; y < GH; y++) {
      for (let x = GW - 1; x >= 0; x--) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r, g, bl] = blockToRgb(b);
          const row = GH - 1 - y;
          const ci = (row * GL + z) * 3;
          sideRgb[ci] = r; sideRgb[ci+1] = g; sideRgb[ci+2] = bl;
          sideHit[row * GL + z] = 1;
          break;
        }
      }
    }
  }

  // Top view: project onto X×Z looking from -Y (top-most Y wins)
  const topRgb = new Uint8Array(GW * GL * 3);
  const topHit = new Uint8Array(GW * GL);
  for (let x = 0; x < GW; x++) {
    for (let z = 0; z < GL; z++) {
      for (let y = GH - 1; y >= 0; y--) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r, g, bl] = blockToRgb(b);
          const ci = (z * GW + x) * 3;
          topRgb[ci] = r; topRgb[ci+1] = g; topRgb[ci+2] = bl;
          topHit[z * GW + x] = 1;
          break;
        }
      }
    }
  }

  const front = scalePanel(frontRgb, frontHit, GW, GH);
  const side  = scalePanel(sideRgb,  sideHit,  GL, GH);
  const top   = scalePanel(topRgb,   topHit,   GW, GL);

  // Composite: three panels in a row, vertically centred
  const maxH  = Math.max(front.h, side.h, top.h);
  const totalW = front.w + GAP + side.w + GAP + top.w;
  const comp = new Uint8Array(totalW * maxH * 4);

  // Background fill
  for (let i = 0; i < comp.length; i += 4) {
    comp[i] = BG[0]; comp[i+1] = BG[1]; comp[i+2] = BG[2]; comp[i+3] = 255;
  }

  function blit(panel: Panel, offX: number): void {
    const offY = Math.floor((maxH - panel.h) / 2);
    for (let y = 0; y < panel.h; y++) {
      for (let x = 0; x < panel.w; x++) {
        const si = (y * panel.w + x) * 4;
        const di = ((offY + y) * totalW + offX + x) * 4;
        comp[di]   = panel.rgba[si];
        comp[di+1] = panel.rgba[si+1];
        comp[di+2] = panel.rgba[si+2];
        comp[di+3] = panel.rgba[si+3];
      }
    }
  }

  blit(front, 0);
  blit(side,  front.w + GAP);
  blit(top,   front.w + GAP + side.w + GAP);

  return encodePng(totalW, maxH, comp);
}

// ── Claude vision grading ──────────────────────────────────────────────────────

async function gradeVisually(
  renderPng: Buffer,
  refJpeg: Buffer,
  setName: string,
): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠ ANTHROPIC_API_KEY not set — grade 0');
    return 0;
  }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Image 1: official product photo of LEGO set "${setName}". ` +
              `Image 2: three orthographic views (front / side / top) of a Minecraft-block voxelization of that set.\n\n` +
              `Grade 0-100 how accurately the voxelized recreation captures the 3D shape, proportions, and silhouette of the set. ` +
              `Focus ONLY on structural shape — ignore colour, texture, and material differences between LEGO plastic and Minecraft blocks. ` +
              `A score of 100 means the shape is perfectly recognizable and proportionally correct from all three views. ` +
              `Reply with a single integer only, nothing else.`,
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: refJpeg.toString('base64') },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: renderPng.toString('base64') },
          },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(`  ⚠ Claude API error ${resp.status}: ${body}`);
    return 0;
  }

  const json = await resp.json() as { content: { type: string; text: string }[] };
  const raw  = json.content?.find(c => c.type === 'text')?.text?.trim() ?? '';
  const num  = parseInt(raw.replace(/\D/g, ''), 10);
  return isNaN(num) ? 0 : Math.min(100, Math.max(0, num));
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('LEGO Voxelization — Visual Quality Grading');
  console.log('===========================================');
  console.log(`Pass threshold: ${PASS_THRESHOLD}/100 per set\n`);

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  let allPassed = true;

  for (const spec of SETS) {
    console.log(`\n[${spec.set_num}] ${spec.name}`);

    // 1. Fetch + parse + voxelize
    process.stdout.write('  Fetching MPD… ');
    const t0 = Date.now();
    const mpdResp = await fetch(`${OMR_BASE}/${spec.set_num}.mpd`, {
      headers: { 'User-Agent': 'craftmatic-visual-grade/1.0' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!mpdResp.ok) {
      console.log(`FAIL HTTP ${mpdResp.status}`);
      allPassed = false;
      continue;
    }
    const mpdText = await mpdResp.text();
    const bricks  = parseLDraw(mpdText, `${spec.set_num}.mpd`);
    const result  = voxelizeLDraw(bricks);
    const { grid, dimensions } = result;
    console.log(`${Date.now() - t0}ms — ${bricks.length} bricks, ${grid.countNonAir()} blocks, ${dimensions.w}×${dimensions.h}×${dimensions.l}`);

    // 2. Render
    process.stdout.write('  Rendering orthographic views… ');
    const renderPng  = renderViews(grid);
    const renderPath = join(OUT_DIR, `${spec.set_num}-render.png`);
    writeFileSync(renderPath, renderPng);
    console.log(`${(renderPng.length / 1024).toFixed(0)}KB → ${renderPath}`);

    // 3. Load reference thumbnail
    const thumbPath = join(THUMBS_DIR, `${spec.set_num}.jpg`);
    if (!existsSync(thumbPath)) {
      console.log(`  ⚠ No thumbnail at ${thumbPath} — cannot grade`);
      allPassed = false;
      continue;
    }
    const refJpeg = readFileSync(thumbPath);

    // 4. Grade via Claude vision
    process.stdout.write('  Grading with Claude vision… ');
    const grade = await gradeVisually(renderPng, refJpeg, `${spec.name} (${spec.set_num})`);
    const pass  = grade >= PASS_THRESHOLD;
    console.log(`${grade}/100 — ${pass ? '✓ PASS' : `✗ FAIL (need ${PASS_THRESHOLD})`}`);
    if (!pass) allPassed = false;
  }

  console.log('\n===========================================');
  if (allPassed) {
    console.log(`All sets ≥ ${PASS_THRESHOLD}/100 — visual quality target achieved.`);
    process.exit(0);
  } else {
    console.log(
      `One or more sets scored below ${PASS_THRESHOLD}/100.\n` +
      `Improve voxelization fidelity and re-run. Rendered PNGs saved to ${OUT_DIR}/`,
    );
    process.exit(1);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
