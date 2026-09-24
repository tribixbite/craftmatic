/**
 * Read a pinball table out of a model (engine/pinball-table.ts) and draw what
 * the ball will see: the signed distance field (free = dark, solid = light),
 * flippers at rest (green) and raised (lime), bumpers (magenta), the launch
 * point (yellow) and the drain line (red).
 *
 * Usage: bun scripts/_pinball_probe.ts <model.ldr> [out.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { setLDrawRoot } from '../web/src/engine/ldraw-geometry.ts';
import { createPartGeometryProvider, type LdrawPartMesh } from '../web/src/engine/ldraw-part-geometry.ts';
import { partStem } from '../web/src/engine/part-id.ts';
import { detectPinballTable } from '../web/src/engine/pinball-table.ts';

setLDrawRoot('C:/git/clego/extracted/studio_release/app/ldraw');
const [file, outPng] = process.argv.slice(2);
if (!file) { console.error('usage: bun scripts/_pinball_probe.ts <model.ldr> [out.png]'); process.exit(64); }

const bricks = parseLDraw(readFileSync(file, 'utf8'));
const provider = createPartGeometryProvider({});
const meshes = new Map<string, LdrawPartMesh | null>();
for (const b of bricks) {
  const stem = partStem(b.part);
  if (!meshes.has(stem)) meshes.set(stem, await provider.getPartMesh(`${stem}.dat`));
}
const t0 = performance.now();
const table = detectPinballTable(bricks, meshes, { debug: line => console.log(`  [detect] ${line}`) });
const ms = performance.now() - t0;
if (!table) { console.log('no pinball table detected'); process.exit(1); }
const { grid } = table;
let freeCells = 0;
for (const v of grid.sdf) if (v > 0) freeCells++;
console.log(JSON.stringify({
  ms: Math.round(ms), tiltDeg: +table.tiltDeg.toFixed(2), nominalTilt: table.nominalTilt,
  floorH: table.floorH, ballRadius: table.ballRadius,
  grid: { rows: grid.rows, cols: grid.cols, cell: grid.cell, freeCells, lengthLdu: grid.rows * grid.cell, widthLdu: grid.cols * grid.cell },
  flippers: table.flippers.map(f => ({ side: f.side, pivot: f.pivot.map(v => +v.toFixed(1)), length: +f.length.toFixed(1), restDeg: +(f.restAngle * 180 / Math.PI).toFixed(1), activeDeg: +(f.activeAngle * 180 / Math.PI).toFixed(1), parts: f.bricks.length, radius: [f.pivotRadius, f.tipRadius].map(v => +v.toFixed(1)) })),
  bumpers: table.bumpers.map(b => ({ part: b.part, centre: b.centre.map(v => +v.toFixed(0)), r: b.radius })),
  launch: { at: table.launch.at.map(v => +v.toFixed(1)), laneTopU: +table.launch.laneTopU.toFixed(1) },
  drainU: +table.drainU.toFixed(1), balls: table.ballBricks.length, warnings: table.warnings,
}, null, 1));

if (outPng) {
  const S = 3; // pixels per cell
  const W = grid.cols * S, H = grid.rows * S;
  const px = new Uint8Array(W * H * 3);
  const set = (x: number, y: number, rgb: [number, number, number]): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (Math.round(y) * W + Math.round(x)) * 3;
    px[k] = rgb[0]; px[k + 1] = rgb[1]; px[k + 2] = rgb[2];
  };
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
    const d = grid.sdf[r * grid.cols + c]!;
    const v: [number, number, number] = d > 0
      ? (d < table.ballRadius ? [60, 60, 110] : [20, 20, 40])
      : [200, 200, 200];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(c * S + x, r * S + y, v);
  }
  const toPx = (u: number, w: number): [number, number] => [(w - grid.w0) / grid.cell * S, (u - grid.u0) / grid.cell * S];
  const line = (a: [number, number], b: [number, number], rgb: [number, number, number]): void => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1;
    for (let i = 0; i <= n; i++) set(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n, rgb);
  };
  const circle = (u: number, w: number, r: number, rgb: [number, number, number]): void => {
    for (let a = 0; a < 64; a++) {
      const t = a / 64 * Math.PI * 2;
      const p = toPx(u + Math.cos(t) * r, w + Math.sin(t) * r);
      set(p[0], p[1], rgb);
    }
  };
  for (const f of table.flippers) {
    for (const [ang, rgb] of [[f.restAngle, [40, 200, 80]], [f.activeAngle, [190, 255, 60]]] as const) {
      const tip: [number, number] = [f.pivot[0] + Math.sin(ang) * f.length, f.pivot[1] + Math.cos(ang) * f.length];
      line(toPx(f.pivot[0], f.pivot[1]), toPx(tip[0], tip[1]), rgb as [number, number, number]);
    }
  }
  for (const b of table.bumpers) circle(b.centre[0], b.centre[1], b.radius, [230, 60, 200]);
  circle(table.launch.at[0], table.launch.at[1], table.ballRadius, [250, 220, 40]);
  line(toPx(table.drainU, grid.w0), toPx(table.drainU, grid.w0 + grid.cols * grid.cell), [230, 50, 50]);
  writeFileSync(outPng, encodePng(W, H, px));
  console.log(`wrote ${outPng} (${W}x${H})`);
}

/** Minimal RGB PNG encoder (no dependency). */
function encodePng(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
