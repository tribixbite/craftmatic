#!/usr/bin/env bun
/**
 * Grade the 6 randomly-selected models in .claude/visual-loop-state.json.
 * Renders orthographic views (front/side/top) via the same pipeline as visual-grade.ts,
 * then grades each 1-10 via Claude vision API (comparing render to reference thumbnail).
 * Writes scores and issues back to the loop state file.
 */

import { parseLDraw } from '../web/src/engine/ldraw-parser.js';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const STATE_FILE = join(import.meta.dir, '..', '.claude', 'visual-loop-state.json');
const THUMBS_DIR = join(import.meta.dir, '..', 'web', 'public', 'lego-thumbs');
const OUT_DIR    = join(import.meta.dir, '..', '.grade-out');
const CATALOG    = join(import.meta.dir, '..', 'web', 'public', 'lego-catalog.json');
const OMR_BASE   = 'https://library.ldraw.org/library/omr';
const SCORE_THRESHOLD = 9; // out of 10

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const catalog: { sets: { set_num: string; name: string }[] } = JSON.parse(readFileSync(CATALOG, 'utf8'));

function getSetName(setNum: string): string {
  return catalog.sets.find(s => s.set_num === setNum)?.name ?? setNum;
}

// ── Block RGB lookup (from visual-grade.ts) ────────────────────────────────────
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

// ── Minimal PNG encoder (from visual-grade.ts) ─────────────────────────────────
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

// ── Renderer ──────────────────────────────────────────────────────────────────
const PANEL_MAX = 480; // each panel is scaled to fit this
const ISO_MAX  = 640; // isometric panel gets more space
const GAP = 4;
const BG: [number,number,number] = [30, 30, 40];

interface Panel { rgba: Uint8Array; w: number; h: number; }

function scalePanel(rgb: Uint8Array, hit: Uint8Array, srcW: number, srcH: number): Panel {
  const scale = PANEL_MAX / Math.max(srcW, srcH, 1);
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const rgba = new Uint8Array(dw * dh * 4);
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.floor(dx / scale);
      const sy = Math.floor(dy / scale);
      const si = (sy * srcW + sx) * 3;
      const di = (dy * dw + dx) * 4;
      if (hit[sy * srcW + sx]) {
        rgba[di] = rgb[si]; rgba[di+1] = rgb[si+1]; rgba[di+2] = rgb[si+2]; rgba[di+3] = 255;
      } else {
        rgba[di] = BG[0]; rgba[di+1] = BG[1]; rgba[di+2] = BG[2]; rgba[di+3] = 255;
      }
    }
  }
  return { rgba, w: dw, h: dh };
}

/**
 * Isometric projection (2:1 pixel-art style).
 * Uses doubled screen coordinates to avoid fractional steps:
 *   sx2 = (gx - gz) * 2            (each gx/gz step = 2 screen units)
 *   sy2 = -(gy * 2 + gx + gz)      (each gy step = 2, each gx/gz = 1 screen unit)
 * Top face shaded +30%, left face normal, right face -20%.
 */
function renderIsometric(grid: ReturnType<typeof voxelizeLDraw>['grid']): Panel {
  const GW = grid.width, GH = grid.height, GL = grid.length;

  // Canvas size in doubled screen units
  const sxOff2 = 2 * (GL - 1);   // makes gx=0,gz=GL-1 → sx2=0
  const syOff2 = 2 * (GH - 1) + (GW - 1) + (GL - 1); // makes gy=GH-1,gx=0,gz=0 → sy2=0
  const canW2 = sxOff2 + 2 * (GW - 1) + 1;
  const canH2 = syOff2 + 1;

  // Scale: BLOCK pixels per doubled unit; each visible block face = BLOCK×BLOCK area
  const BLOCK = Math.max(1, Math.floor(ISO_MAX / Math.max(canW2, canH2)));
  const canW = canW2 * BLOCK;
  const canH = canH2 * BLOCK;

  const rgba = new Uint8Array(canW * canH * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }
  // z-buffer: depth value per pixel (gx+gz+gy, higher = closer)
  const zbuf = new Int32Array(canW * canH).fill(-1);

  // Shade helpers
  const shade = (c: number, f: number) => Math.min(255, Math.round(c * f));

  for (let gx = 0; gx < GW; gx++) {
    for (let gz = 0; gz < GL; gz++) {
      for (let gy = 0; gy < GH; gy++) {
        const b = grid.get(gx, gy, gz);
        if (b === 'minecraft:air') continue;

        const [r0, g0, b0] = blockToRgb(b);
        const depth = gx + gz + gy;

        // Screen origin of this block in doubled units
        const sx2 = (gx - gz) * 2 + sxOff2;
        const sy2 = -(gy * 2 + gx + gz) + syOff2;

        // Render three visible faces with shading:
        //   Top face:   block at sy2-1 row (one doubled-unit up), full width, lighter
        //   Right face: block at sx2+1..sx2+2, sy2 row, normal
        //   Left face:  block at sx2-1..sx2-0, sy2 row, slightly darker
        // For simplicity: paint a 2×2 block in doubled coords, with top half brighter

        for (let dy2 = 0; dy2 < 2; dy2++) {
          for (let dx2 = 0; dx2 < 2; dx2++) {
            const px2 = sx2 + dx2;
            const py2 = sy2 - dy2; // dy2=0=bottom, dy2=1=top
            if (px2 < 0 || px2 >= canW2 || py2 < 0 || py2 >= canH2) continue;

            // Shading: top half lighter, right-half normal, left-half darker
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
                  rgba[pi]   = shade(r0, f);
                  rgba[pi+1] = shade(g0, f);
                  rgba[pi+2] = shade(b0, f);
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

function renderViews(grid: ReturnType<typeof voxelizeLDraw>['grid']): Buffer {
  const { width: GW, height: GH, length: GL } = grid;
  const frontRgb = new Uint8Array(GW * GH * 3);
  const frontHit = new Uint8Array(GW * GH);
  for (let x = 0; x < GW; x++) {
    for (let y = 0; y < GH; y++) {
      for (let z = 0; z < GL; z++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r,g,bl] = blockToRgb(b);
          const ci = ((GH-1-y) * GW + x) * 3;
          frontRgb[ci] = r; frontRgb[ci+1] = g; frontRgb[ci+2] = bl;
          frontHit[(GH-1-y) * GW + x] = 1;
          break;
        }
      }
    }
  }
  const sideRgb = new Uint8Array(GL * GH * 3);
  const sideHit = new Uint8Array(GL * GH);
  for (let z = 0; z < GL; z++) {
    for (let y = 0; y < GH; y++) {
      for (let x = GW-1; x >= 0; x--) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r,g,bl] = blockToRgb(b);
          const ci = ((GH-1-y) * GL + z) * 3;
          sideRgb[ci] = r; sideRgb[ci+1] = g; sideRgb[ci+2] = bl;
          sideHit[(GH-1-y) * GL + z] = 1;
          break;
        }
      }
    }
  }
  const topRgb = new Uint8Array(GW * GL * 3);
  const topHit = new Uint8Array(GW * GL);
  for (let x = 0; x < GW; x++) {
    for (let z = 0; z < GL; z++) {
      for (let y = GH-1; y >= 0; y--) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') {
          const [r,g,bl] = blockToRgb(b);
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
  const iso   = renderIsometric(grid);

  // Layout: isometric on top row (full width), orthographic on bottom row
  const orthoMaxH = Math.max(front.h, side.h, top.h);
  const orthoW = front.w + GAP + side.w + GAP + top.w;
  const totalW = Math.max(orthoW, iso.w);
  const totalH = iso.h + GAP + orthoMaxH;

  const comp = new Uint8Array(totalW * totalH * 4);
  for (let i = 0; i < comp.length; i += 4) {
    comp[i] = BG[0]; comp[i+1] = BG[1]; comp[i+2] = BG[2]; comp[i+3] = 255;
  }
  function blit(panel: Panel, offX: number, offY: number): void {
    for (let y = 0; y < panel.h; y++) {
      for (let x = 0; x < panel.w; x++) {
        const si = (y * panel.w + x) * 4;
        const di = ((offY + y) * totalW + offX + x) * 4;
        comp[di] = panel.rgba[si]; comp[di+1] = panel.rgba[si+1];
        comp[di+2] = panel.rgba[si+2]; comp[di+3] = panel.rgba[si+3];
      }
    }
  }
  // Isometric centered at top
  blit(iso, Math.floor((totalW - iso.w) / 2), 0);
  // Orthographic views at bottom, centered
  const orthoOffX = Math.floor((totalW - orthoW) / 2);
  const orthoOffY = iso.h + GAP;
  blit(front, orthoOffX, orthoOffY + Math.floor((orthoMaxH - front.h) / 2));
  blit(side,  orthoOffX + front.w + GAP, orthoOffY + Math.floor((orthoMaxH - side.h) / 2));
  blit(top,   orthoOffX + front.w + GAP + side.w + GAP, orthoOffY + Math.floor((orthoMaxH - top.h) / 2));
  return encodePng(totalW, totalH, comp);
}

// ── Claude vision grading ──────────────────────────────────────────────────────
async function gradeVisually(
  renderPng: Buffer, refJpeg: Buffer, setName: string, setNum: string
): Promise<{ score: number; issues: string[] }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn('  ⚠ No ANTHROPIC_API_KEY'); return { score: 0, issues: ['no API key'] }; }

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Image 1: official LEGO product photo of set "${setName}" (${setNum}).\n` +
              `Image 2: Minecraft-block voxelization — TOP: isometric 3D view; BOTTOM ROW (left to right): front/side/top orthographic projections.\n\n` +
              `Score the voxelization 1-10 for visual accuracy (shape, proportions, silhouette — ignore color):\n` +
              `10 = perfect shape match; 7 = recognizable but proportions off; 4 = barely recognizable; 1 = wrong shape.\n\n` +
              `Use ALL views together to assess shape accuracy — the orthographic views often reveal detail hidden in the isometric. Be BRUTALLY HONEST.\n` +
              `List up to 3 specific structural issues (e.g. "too tall", "missing wings", "cube instead of tapered nose").\n\n` +
              `Reply in this exact format:\nSCORE: N\nISSUES: issue1 | issue2 | issue3`,
          },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refJpeg.toString('base64') } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png',  data: renderPng.toString('base64') } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(`  ⚠ API error ${resp.status}: ${body.slice(0, 100)}`);
    return { score: 0, issues: [`API error ${resp.status}`] };
  }

  const json = await resp.json() as { content: { type: string; text: string }[] };
  const raw = json.content?.find(c => c.type === 'text')?.text?.trim() ?? '';
  console.log(`  Response: ${raw}`);

  const scoreMatch = /SCORE:\s*(\d+)/i.exec(raw);
  const issuesMatch = /ISSUES:\s*(.+)/i.exec(raw);
  const score = scoreMatch ? Math.min(10, Math.max(1, parseInt(scoreMatch[1], 10))) : 0;
  const issues = issuesMatch
    ? issuesMatch[1].split('|').map(s => `${setNum}: ${s.trim()}`).filter(Boolean)
    : [];
  return { score, issues };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nVisual Quality Grading — 6 Selected Models');
  console.log('===========================================');
  console.log('Models:', state.selected_models.join(', '), '\n');

  const newScores: Record<string, number> = { ...state.scores };
  const newIssues: string[] = [];
  let passingCount = 0;

  for (const setNum of state.selected_models) {
    const setName = getSetName(setNum);
    console.log(`\n[${setNum}] ${setName}`);

    // 1. Fetch MPD
    process.stdout.write('  Fetching MPD from OMR… ');
    let mpdText: string;
    try {
      const r = await fetch(`${OMR_BASE}/${setNum}.mpd`, {
        headers: { 'User-Agent': 'craftmatic-grader/1.0' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!r.ok) { console.log(`FAIL HTTP ${r.status}`); newScores[setNum] = 0; newIssues.push(`${setNum}: failed to fetch from OMR (${r.status})`); continue; }
      mpdText = await r.text();
      console.log(`${(mpdText.length/1024).toFixed(0)}KB`);
    } catch (e: unknown) {
      console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`);
      newScores[setNum] = 0;
      newIssues.push(`${setNum}: fetch error`);
      continue;
    }

    // 2. Parse + voxelize
    process.stdout.write('  Parsing + voxelizing… ');
    const bricks = parseLDraw(mpdText);
    // Use cubic scale: 1 stud = 1 block in all axes — gives correct real-world proportions
    // Accurate mode (default) is 2.5× taller which distorts silhouette shape grading
    const result = voxelizeLDraw(bricks, undefined, { cubicScale: true });
    const { grid, dimensions, brickCount } = result;
    console.log(`${brickCount} bricks → ${grid.countNonAir()} blocks, ${dimensions.w}×${dimensions.h}×${dimensions.l}`);

    if (grid.countNonAir() < 10) {
      console.log('  ⚠ Almost empty grid — skipping');
      newScores[setNum] = 1;
      newIssues.push(`${setNum}: voxelization produced < 10 blocks (parse failure)`);
      continue;
    }

    // 3. Render
    process.stdout.write('  Rendering views… ');
    const png = renderViews(grid);
    const renderPath = join(OUT_DIR, `${setNum}-render.png`);
    writeFileSync(renderPath, png);
    console.log(`${(png.length/1024).toFixed(0)}KB → ${renderPath}`);

    // 4. Reference thumbnail
    const thumbPath = join(THUMBS_DIR, `${setNum}.jpg`);
    if (!existsSync(thumbPath)) {
      console.log(`  ⚠ No thumbnail at ${thumbPath}`);
      // Grade render-only (no reference comparison)
      newScores[setNum] = 5; // unknown without reference
      newIssues.push(`${setNum}: no reference thumbnail available for comparison`);
      continue;
    }
    const refJpeg = readFileSync(thumbPath);

    // 5. Grade
    process.stdout.write('  Grading… ');
    const { score, issues } = await gradeVisually(png, refJpeg, setName, setNum);
    newScores[setNum] = score;
    newIssues.push(...issues);
    const pass = score >= SCORE_THRESHOLD;
    if (pass) passingCount++;
    console.log(`Score: ${score}/10 — ${pass ? '✓ PASS' : '✗ needs improvement'}`);
  }

  console.log('\n===========================================');
  console.log('Results:');
  for (const [k, v] of Object.entries(newScores)) {
    console.log(`  ${k}: ${v}/10 ${v >= SCORE_THRESHOLD ? '✓' : '✗'}`);
  }
  console.log(`\nPassing: ${passingCount}/6 (need 5 to complete loop)`);

  // Update loop state
  const allIssues = [...new Set(newIssues)];
  state.scores = newScores;
  state.issues = allIssues.slice(0, 20); // cap
  state.passing_count = passingCount;
  state.phase = passingCount >= state.pass_threshold ? 'grade' : 'fix';
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('\nLoop state updated:', STATE_FILE);

  if (passingCount >= state.pass_threshold) {
    console.log('\n✓ LOOP COMPLETE — 5/6 models score >= 9/10');
    // Deactivate loop
    state.active = false;
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  }
}

main().catch(console.error);
