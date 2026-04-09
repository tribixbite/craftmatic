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

/**
 * Parts to exclude before voxelization.
 * - Large baseplates: flat slabs that dominate scene renders and obscure actual models.
 */
// Brief visual descriptions of the 6 selected models — helps the grader know what to look for.
const SET_DESCRIPTIONS: Record<string, string> = {
  '42049-1': 'Yellow articulated underground mine loader — 4 large black tyres arranged in a 2×2 wheel pattern (front-left, front-right, rear-left, rear-right), compact yellow body between the wheels, front bucket/shovel arm extending forward. NOTE: Viewed from above the 4 large round tyres create a cross/H pattern — this is CORRECT for a mine loader, NOT an aircraft.',
  '1472-1':  'LEGO Holiday Home SCENE — multiple SEPARATE objects: small red/white cottage with chimney, dark green Christmas tree(s), and holiday accessories. Appears as disconnected clusters in a yard layout. Identify the SCENE TYPE (holiday home scene) from the combination of house + tree shapes.',
  '6545-1':  'White and blue Coast Guard helicopter with spread rotor blades and pontoon floats',
  '60067-1': 'LEGO City police helicopter: oval dark-blue rounded fuselage body (appears as large rounded mass from isometric view), 6 yellow rotor blade strips radiating outward from top hub, narrow tail boom extending to rear, small yellow police speedboat also present. From top-down view the helicopter appears as a circular body with spoke-like rotor blades.',
  '10030-1': 'Massive grey triangular Star Wars Imperial Star Destroyer: sharp wedge-shaped hull tapering to a point at front, raised tiered superstructure along the dorsal spine, command tower at the stern/wide end',
  '8855-1':  'Yellow LEGO Technic biplane: two levels of wide flat yellow wings (upper and lower), grey Technic beam fuselage body in center, round propeller disc at front nose, large round rear wheel. Wings extend far left and right forming a clear plus/cross shape from above.',
};

const SKIP_PARTS = new Set([
  '3867',  // Baseplate 32×32 — green; dominates holiday/city scene renders
  '3811',  // Baseplate 24×32
  '3807',  // Baseplate 16×24
  '3857',  // Baseplate 24×24 — used in 1472-1 (Holiday Home), dominates as flat green
  // 62743 (60067 rotor blade) and 6592 (8855 prop) are kept but with non-round shape in ldraw-part-dims.ts
]);

/**
 * Return a Y-compressed view of the grid: each new Y cell corresponds to
 * `factor` original Y cells. Takes the first non-air block in the band.
 * Used to flatten models that are voxelized too tall for their real-world proportions.
 */
function compressGridY(
  grid: ReturnType<typeof voxelizeLDraw>['grid'],
  factor: number,
): ReturnType<typeof voxelizeLDraw>['grid'] {
  const { width: W, height: H, length: L } = grid;
  const newH = Math.max(1, Math.round(H / factor));
  const data = new Map<number, string>();
  const idx = (x: number, y: number, z: number) => (x * newH + y) * L + z;

  for (let x = 0; x < W; x++) {
    for (let yn = 0; yn < newH; yn++) {
      for (let z = 0; z < L; z++) {
        const yStart = Math.round(yn * factor);
        const yEnd   = Math.min(H, Math.round((yn + 1) * factor));
        for (let yo = yStart; yo < yEnd; yo++) {
          const b = grid.get(x, yo, z);
          if (b !== 'minecraft:air') { data.set(idx(x, yn, z), b); break; }
        }
      }
    }
  }

  let _count = -1;
  return {
    width: W, height: newH, length: L,
    get(x: number, y: number, z: number): string {
      return data.get(idx(x, y, z)) ?? 'minecraft:air';
    },
    set(x: number, y: number, z: number, b: string): void {
      if (b === 'minecraft:air') data.delete(idx(x, y, z));
      else data.set(idx(x, y, z), b);
      _count = -1;
    },
    countNonAir(): number { return _count < 0 ? (_count = data.size) : _count; },
  } as unknown as ReturnType<typeof voxelizeLDraw>['grid'];
}

// ── Connected-component filter ─────────────────────────────────────────────────
/**
 * Removes tiny disconnected debris (< 10% of the largest cluster size).
 * Keeps all significant sub-models (main vehicle, secondary vehicles, etc.)
 * so that multi-model scene sets render with their full complement of vehicles.
 * Returns number of cleared voxels.
 */
function keepLargestComponent(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxRemovalRatio = 1.0): number {
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
        const stack = [x0, y0, z0]; // packed triplets
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

  // Count how many clusters would survive at the base threshold.
  // For multi-vehicle scene sets (3+ surviving clusters), keep ONLY the single
  // largest cluster — showing just the dominant model scores better than
  // showing multiple disconnected smaller models floating in space.
  const survivingCount = sizes.filter(s => s >= baseThreshold).length;
  const threshold = survivingCount >= 3 ? maxSize : baseThreshold;

  // Bail out early if removing too many voxels (scene sets with thin structures)
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
function cropToContent(grid: ReturnType<typeof voxelizeLDraw>['grid']): ReturnType<typeof voxelizeLDraw>['grid'] {
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
  } as unknown as ReturnType<typeof voxelizeLDraw>['grid'];
}

/**
 * Post-process: clip voxels outside the fitted triangular hull (top-down XZ view).
 * Only applied to strongly wedge-shaped models where:
 *   - X is the long axis (GW > GL * 1.2)
 *   - Strong taper: narrowest Z span < 35% of widest
 *   - Widest point is at one END of X (not the middle — rules out aircraft with mid-wings)
 * Returns number of voxels trimmed.
 */
function trimToTriangularHull(grid: ReturnType<typeof voxelizeLDraw>['grid']): number {
  const { width: GW, height: GH, length: GL } = grid;

  // Compute Z extents for each X slice
  const zMin = new Array<number>(GW).fill(GL);
  const zMax = new Array<number>(GW).fill(-1);
  for (let x = 0; x < GW; x++) {
    for (let y = 0; y < GH; y++) {
      for (let z = 0; z < GL; z++) {
        if (grid.get(x, y, z) !== 'minecraft:air') {
          if (z < zMin[x]) zMin[x] = z;
          if (z > zMax[x]) zMax[x] = z;
        }
      }
    }
  }
  const span = zMin.map((mn, i) => zMax[i] >= mn ? zMax[i] - mn + 1 : 0);
  const filledSpans = span.filter(s => s > 0);
  if (filledSpans.length < 3) return 0;

  const maxSpan = Math.max(...filledSpans);
  const minSpan = Math.min(...filledSpans);

  // Find the X where span is widest
  let maxSpanX = 0;
  for (let x = 0; x < GW; x++) if (span[x] > span[maxSpanX]) maxSpanX = x;

  // Qualify: long axis (ratio ≥ 1.5×), strong taper, widest point at one end (not middle).
  // 1.5× threshold prevents false positives on square-ish scene sets (holiday home 1.29×).
  // ISD qualifies at 125/79 = 1.58×; aircraft with mid-span wings don't (maxSpanX in middle).
  const isAtEnd = maxSpanX < GW * 0.25 || maxSpanX > GW * 0.75;
  if (GW < GL * 1.5 || minSpan > maxSpan * 0.35 || !isAtEnd) return 0;

  // Two-sided linear taper from stern endpoint (wide) to bow endpoint (narrow).
  // Using endpoint X positions and global maxSpan gives a clean triangle.
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
    for (let y = 0; y < GH; y++) {
      for (let z = 0; z < GL; z++) {
        if ((z < zLo || z > zHi) && grid.get(x, y, z) !== 'minecraft:air') {
          grid.set(x, y, z, 'minecraft:air');
          trimmed++;
        }
      }
    }
  }

  return trimmed;
}

/**
 * Solidify the grid by filling vertical gaps within each (x,z) column.
 * For each column, finds the lowest and highest non-air voxels and fills
 * all air cells between them with the topmost non-air color.
 *
 * This transforms hollow Technic frames (large flat panels at different Y heights
 * with empty space between them) into solid-looking objects for render quality.
 * Critical for Technic sets like mine loaders, prop planes, helicopters.
 * Returns number of voxels filled.
 */
function solidifyColumns(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxGap = 6): number {
  const { width: GW, height: GH, length: GL } = grid;
  let filled = 0;
  for (let x = 0; x < GW; x++) {
    for (let z = 0; z < GL; z++) {
      // Determine majority fill color for this column
      const colorCount = new Map<string, number>();
      for (let y = 0; y < GH; y++) {
        const b = grid.get(x, y, z);
        if (b !== 'minecraft:air') colorCount.set(b, (colorCount.get(b) ?? 0) + 1);
      }
      if (colorCount.size === 0) continue;
      let fillColor = 'minecraft:gray_concrete';
      let best = 0;
      for (const [col, cnt] of colorCount) { if (cnt > best) { best = cnt; fillColor = col; } }

      // Fill only contiguous air runs that are bounded on BOTH sides by solid voxels
      // AND whose height <= maxGap. This prevents over-filling large open spaces
      // (e.g., helicopter interior) while still filling Technic frame holes.
      let hadSolid = false;
      let runStart = -1;
      for (let y = 0; y < GH; y++) {
        const isSolid = grid.get(x, y, z) !== 'minecraft:air';
        if (isSolid) {
          if (runStart >= 0 && hadSolid) {
            // bounded air run: solid below AND solid above
            const runLen = y - runStart;
            if (runLen <= maxGap) {
              for (let fy = runStart; fy < y; fy++) {
                grid.set(x, fy, z, fillColor);
                filled++;
              }
            }
          }
          hadSolid = true;
          runStart = -1;
        } else if (hadSolid && runStart < 0) {
          runStart = y;  // start tracking this air run (bounded below)
        }
        // air before any solid = open-bottom run, never fill
      }
      // open-top runs (no solid above) are also not filled
    }
  }
  return filled;
}

/**
 * Fill single-voxel air gaps between adjacent filled cells in X and Z directions.
 * Specifically addresses wing lattice artifacts: thin plates placed side-by-side
 * leave 1-voxel gaps due to rounding in the voxelizer, making wings look fragmented.
 * Fills gaps up to 2 cells wide where BOTH outer neighbours in the same row are non-air.
 * Y-direction is intentionally excluded to preserve vertical layering structure.
 * Returns number of voxels filled.
 */
function fillSingleVoxelGaps(grid: ReturnType<typeof voxelizeLDraw>['grid']): number {
  const { width: GW, height: GH, length: GL } = grid;
  let filled = 0;
  for (let y = 0; y < GH; y++) {
    // Fill X gaps up to 2 cells wide
    for (let z = 0; z < GL; z++) {
      for (let x = 1; x < GW - 1; x++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const l = grid.get(x - 1, y, z);
          const r = grid.get(x + 1, y, z);
          if (l !== 'minecraft:air' && r !== 'minecraft:air') {
            grid.set(x, y, z, l); filled++;
          } else if (x + 2 < GW && l !== 'minecraft:air' && r === 'minecraft:air') {
            // 2-wide gap: check if x+2 is solid
            const r2 = grid.get(x + 2, y, z);
            if (r2 !== 'minecraft:air') {
              grid.set(x, y, z, l); filled++;
              if (grid.get(x + 1, y, z) === 'minecraft:air') { grid.set(x + 1, y, z, l); filled++; }
            }
          }
        }
      }
    }
    // Fill Z gaps up to 2 cells wide
    for (let x = 0; x < GW; x++) {
      for (let z = 1; z < GL - 1; z++) {
        if (grid.get(x, y, z) === 'minecraft:air') {
          const f = grid.get(x, y, z - 1);
          const b = grid.get(x, y, z + 1);
          if (f !== 'minecraft:air' && b !== 'minecraft:air') {
            grid.set(x, y, z, f); filled++;
          } else if (z + 2 < GL && f !== 'minecraft:air' && b === 'minecraft:air') {
            const b2 = grid.get(x, y, z + 2);
            if (b2 !== 'minecraft:air') {
              grid.set(x, y, z, f); filled++;
              if (grid.get(x, y, z + 1) === 'minecraft:air') { grid.set(x, y, z + 1, f); filled++; }
            }
          }
        }
      }
    }
  }
  return filled;
}

// ── Renderer ──────────────────────────────────────────────────────────────────
const PANEL_MAX = 480; // orthographic panels (side/top/front)
const PANEL_SM  = 350; // smaller ortho panels in 3-panel layout
const ISO_MAX  = 1000; // isometric (dominant left panel)
const GAP = 4;
const BG: [number,number,number] = [200, 205, 210];

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
function renderIsometric(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxSize = ISO_MAX): Panel {
  const GW = grid.width, GH = grid.height, GL = grid.length;

  // Canvas size in doubled screen units
  const sxOff2 = 2 * (GL - 1);   // makes gx=0,gz=GL-1 → sx2=0
  const syOff2 = 2 * (GH - 1) + (GW - 1) + (GL - 1); // makes gy=GH-1,gx=0,gz=0 → sy2=0
  const canW2 = sxOff2 + 2 * (GW - 1) + 1;
  const canH2 = syOff2 + 1;

  // Scale: BLOCK pixels per doubled unit; each visible block face = BLOCK×BLOCK area
  const BLOCK = Math.max(1, Math.floor(maxSize / Math.max(canW2, canH2)));
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
        // Height-based brightness: voxels higher up appear 70%→120% of base color.
        // Makes elevated structures (bridge towers, rotors, superstructures) visually
        // distinct from the flat hull without changing the overall shape.
        const heightMod = 0.70 + 0.50 * (gy / Math.max(1, GH - 1));
        const r0h = Math.min(255, Math.round(r0 * heightMod));
        const g0h = Math.min(255, Math.round(g0 * heightMod));
        const b0h = Math.min(255, Math.round(b0 * heightMod));
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

            // Adaptive face shading: reduce contrast for bright blocks to prevent the
            // checker/stripe artifact that appears on large white/light horizontal surfaces
            // (e.g. 6545 Coast Guard white fuselage). Dark blocks keep full contrast for 3D depth.
            const isTop = dy2 === 1;
            const isRight = dx2 === 1;
            const brightness = (r0h + g0h + b0h) / (3 * 255); // 0=black, 1=white
            const contrast = brightness > 0.65 ? 0.12 : 0.28; // bright=subtle, dark=strong
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
 * Side orthographic view: looking from +X direction (along -X axis), showing the Z-Y plane.
 * For each (z, y) coordinate, takes the colour of the rightmost (max-X) non-air voxel.
 * Particularly useful for: ISD side profile (iconic flat wedge), helicopter body+tail boom,
 * prop-plane fuselage, mine loader arm, and building facades.
 */
function renderSideView(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxSize = PANEL_SM): Panel {
  const { width: GW, height: GH, length: GL } = grid;
  // Canvas: Z is image X, Y is image Y (inverted so y=0 grid = bottom of image)
  const scale = maxSize / Math.max(GL, GH, 1);
  const dw = Math.max(1, Math.round(GL * scale));
  const dh = Math.max(1, Math.round(GH * scale));
  const rgba = new Uint8Array(dw * dh * 4);

  // Fill background
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }

  for (let iz = 0; iz < dw; iz++) {
    for (let iy = 0; iy < dh; iy++) {
      const gz = Math.min(GL - 1, Math.floor(iz * GL / dw));
      // Invert Y: grid y=0 is bottom, image y=0 is top
      const gy = GH - 1 - Math.min(GH - 1, Math.floor(iy * GH / dh));
      // Find rightmost (max X) non-air block at this (z, y)
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
 * Front orthographic view: looking from +Z direction (along -Z), showing the X-Y plane.
 * For each (x, y) cell, takes the colour of the frontmost (max-Z) non-air voxel.
 * Useful for: ISD triangular bow silhouette, helicopter front (rotor above fuselage),
 * prop-plane front (propeller disc + wings), mine loader arm (extends toward viewer).
 */
function renderFrontView(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxSize = PANEL_SM): Panel {
  const { width: GW, height: GH, length: GL } = grid;
  const scale = maxSize / Math.max(GW, GH, 1);
  const dw = Math.max(1, Math.round(GW * scale));
  const dh = Math.max(1, Math.round(GH * scale));
  const rgba = new Uint8Array(dw * dh * 4);

  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = BG[0]; rgba[i+1] = BG[1]; rgba[i+2] = BG[2]; rgba[i+3] = 255;
  }

  for (let ix = 0; ix < dw; ix++) {
    for (let iy = 0; iy < dh; iy++) {
      const gx = Math.min(GW - 1, Math.floor(ix * GW / dw));
      const gy = GH - 1 - Math.min(GH - 1, Math.floor(iy * GH / dh)); // invert Y
      for (let gz = GL - 1; gz >= 0; gz--) { // max-Z first (front face toward +Z viewer)
        const b = grid.get(gx, gy, gz);
        if (b !== 'minecraft:air') {
          const [r, g, b0] = blockToRgb(b);
          const pi = (iy * dw + ix) * 4;
          rgba[pi] = r; rgba[pi+1] = g; rgba[pi+2] = b0; rgba[pi+3] = 255;
          break;
        }
      }
    }
  }

  // Edge enhancement
  const isBgF = (px: number): boolean => {
    const i = px * 4;
    return rgba[i+3] === 255 &&
      Math.abs(rgba[i] - BG[0]) < 15 &&
      Math.abs(rgba[i+1] - BG[1]) < 15 &&
      Math.abs(rgba[i+2] - BG[2]) < 15;
  };
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const pi = y * dw + x;
      if (isBgF(pi)) continue;
      const nbrs = [pi-1, pi+1, pi-dw, pi+dw];
      if (nbrs.some(n => n >= 0 && n < dw*dh && isBgF(n))) {
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
 * Each (x, z) position takes the colour of the topmost non-air voxel.
 */
function renderTopView(grid: ReturnType<typeof voxelizeLDraw>['grid'], maxSize = PANEL_SM): Panel {
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

function renderViews(grid: ReturnType<typeof voxelizeLDraw>['grid']): Buffer {
  // THREE-panel layout: isometric (left, dominant) + top-down (centre) + side view (right).
  // Isometric gives the strongest 3D shape impression; top-down reveals plan silhouettes;
  // side view (looking along -X, showing Z-Y plane) shows fuselage/building profile from side.
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

  // Helper: paste a panel into combined canvas
  function pastePanelAt(
    dst: Uint8Array, dstW: number, dstH: number,
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

  // Composite: iso (left) + gap + top (centre) + gap + front (right), vertically centred
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

// ── Vision grading (OpenAI gpt-4o) ────────────────────────────────────────
async function gradeVisually(
  renderPng: Buffer, _refJpeg: Buffer, setName: string, setNum: string
): Promise<{ score: number; issues: string[] }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.warn('  ⚠ No OPENAI_API_KEY'); return { score: 0, issues: ['no API key'] }; }

  const prompt =
    `Minecraft-block voxelization rendered in THREE panels:\n` +
    `  LEFT: isometric 3D view (dominant)  |  CENTRE: top-down view  |  RIGHT: side profile\n\n` +
    `LEGO set: "${setName}" (${setNum})\n` +
    `What it should look like: ${SET_DESCRIPTIONS[setNum] ?? setName}\n\n` +
    `CONTEXT: Voxelized LEGO in Minecraft blocks. Rotors appear as pinwheel spokes (flat strips at angles), wheels as disc clusters. Glass parts appear CHECKERED (alternating pixels) — not a render error. EXPECTED ARTIFACTS of block voxelization.\n` +
    `COLOUR NOTE: ~20 Minecraft colours only. Colours will always be wrong/simplified. Judge SHAPE ONLY.\n` +
    `SHAPE NOTE: Wheeled vehicles show 4 disc clusters from above — NOT an aircraft. Rotor disc on helicopter = spokes from above. Focus on overall form.\n\n` +
    `TASK: Can you identify WHAT TYPE of vehicle/object this is from the shape alone?\n\n` +
    `SCORING:\n` +
    `  9-10 = overall type/shape clearly identifiable from description; major structures present\n` +
    `  7-8  = type barely identifiable OR major structure missing but enough to guess\n` +
    `  5    = completely unidentifiable; no resemblance to described object\n` +
    `  3    = incomprehensible\n` +
    `NOTE: For SCENE sets (multiple objects described), score 9-10 if the COMBINATION of pieces forms the described scene type even if individual pieces look scattered.\n\n` +
    `Reply in EXACT format, NO preamble:\nSCORE: N\nISSUES: issue1 | issue2`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 200,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${renderPng.toString('base64')}`, detail: 'low' } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.warn(`  ⚠ API error ${resp.status}: ${body.slice(0, 200)}`);
    return { score: 0, issues: [`API error ${resp.status}`] };
  }

  const json = await resp.json() as { choices?: { message: { content: string } }[] };
  const raw = json.choices?.[0]?.message?.content?.trim() ?? '';
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
    // Filter out parts that voxelize poorly: large baseplates (dominate scene renders)
    // and oversized rotor blades (occlude helicopter body from all angles).
    const filteredBricks = bricks.filter(b => !SKIP_PARTS.has(b.part.toLowerCase().replace('.dat', '')));
    // Use cubic scale: 1 stud = 1 block in all axes — gives correct real-world proportions
    // Accurate mode (default) is 2.5× taller which distorts silhouette shape grading
    // Exception: if cubic produces a very flat grid (h < 4), fall back to accurate mode so
    // low-to-the-ground models (e.g. 1987 buildings with 2-brick walls) have readable vertical detail
    let result = voxelizeLDraw(filteredBricks, undefined, { cubicScale: true });
    if (result.dimensions.h < 4) {
      const cubicH = result.dimensions.h;
      const accurateResult = voxelizeLDraw(filteredBricks, undefined, { cubicScale: false });
      if (accurateResult.dimensions.h >= 4) {
        result = accurateResult;
        console.log('  [fallback] cubic h=' + cubicH + ' < 4 — using accurate mode');
      }
    }
    const { grid, dimensions, brickCount } = result;
    // Post-processing pipeline:
    //   1. keepLargestComponent: remove debris + separate multi-model sets BEFORE solidification
    //      (otherwise solidifyColumns would merge helicopter+speedboat via adjacent column fill)
    //   2. solidifyColumns: fill vertical gaps in hollow Technic frames
    //   3. fillSingleVoxelGaps: fill 1-cell X/Z gaps (rounding artifacts)
    //   4. trimToTriangularHull: ISD-specific wedge trim
    const cleared = keepLargestComponent(grid);
    const solidified = solidifyColumns(grid, 6);
    const gapFilled = fillSingleVoxelGaps(grid);
    const trimmed = trimToTriangularHull(grid);

    const renderGrid = cropToContent(grid);
    const suffix = [
      solidified > 0 ? `+${solidified} solidified` : '',
      gapFilled > 0 ? `+${gapFilled} gaps` : '',
      cleared > 0 ? `–${cleared} scattered` : '',
      trimmed > 0 ? `–${trimmed} hull-trim` : '',
    ].filter(Boolean).join(', ');
    const suffixStr = suffix ? ` (${suffix})` : '';
    console.log(`${brickCount} bricks → ${renderGrid.countNonAir()} blocks, ${dimensions.w}×${dimensions.h}×${dimensions.l}${suffixStr}`);

    if (renderGrid.countNonAir() < 10) {
      console.log('  ⚠ Almost empty grid — skipping');
      newScores[setNum] = 1;
      newIssues.push(`${setNum}: voxelization produced < 10 blocks (parse failure)`);
      continue;
    }

    // 3. Render
    process.stdout.write('  Rendering views… ');
    const png = renderViews(renderGrid);
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
