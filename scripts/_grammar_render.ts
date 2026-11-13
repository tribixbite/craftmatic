/**
 * Offline isometric render of a brickgen grammar result (A07/A08, BIZ-05): site -> massing -> features -> grammar
 * lattice -> X-10 bricker -> X-09 verify -> PNG of the BUILT parts (each plan element's own occupancy, not the intent
 * lattice), so a roof shows the slope parts the bricker really placed.
 *
 *   bun scripts/_grammar_render.ts notre-dame output/a07/notre-dame --scale=1 [--target=1] [--views=se,nw] [--plain]
 *   bun scripts/_grammar_render.ts louvre-palace output/a07/louvre
 *
 * Writes `<out>-<view>.png` (each under 2000 px) and `<out>.json` (stats, verify report, part histogram).
 * `--plain` renders the plain stand-in (`bricker/plain-massing.ts`) for comparison.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { brickLattice } from '../web/src/brickgen/bricker/index.js';
import { plainMassingLattice } from '../web/src/brickgen/bricker/plain-massing.js';
import { ldrawRgb } from '../web/src/brickgen/colour.js';
import { buildFeatureSet, parseSidecar, tagPartsFromOverpass } from '../web/src/brickgen/features/index.js';
import { buildGrammarModel } from '../web/src/brickgen/grammar/index.js';
import { buildMassing } from '../web/src/brickgen/massing/index.js';
import { siteFromOverpass } from '../web/src/brickgen/site/osm.js';
import type { BrickPlan } from '../web/src/brickgen/types.js';
import { verifyPlanDetailed } from '../web/src/brickgen/verify/index.js';
import { placeAll, VOCABULARY_LOOKUP } from '../web/src/brickgen/verify/world.js';

const args = process.argv.slice(2);
const flag = (name: string, dflt: string): string => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt;
const [siteName, outBase] = args.filter(a => !a.startsWith('--')) as [string, string];
if (!siteName || !outBase) { console.error('usage: _grammar_render.ts <notre-dame|louvre-palace> <out-base> [--target=1] [--views=se,nw] [--plain]'); process.exit(2); }

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

const PH_E = 0.4; // plate height in studs
type View = 'se' | 'sw' | 'ne' | 'nw' | 'w' | 'e' | 'n' | 's';

/** Isometric render of a plan's body cells from one corner. Returns the PNG and its size. */
function renderPlan(plan: BrickPlan, view: View, maxPx: number, region?: number[]): { png: Buffer; w: number; h: number } {
  const { world } = placeAll(plan.elements, VOCABULARY_LOOKUP);
  // `region` = [x0, z0, x1, z1] in lattice studs, optionally [.., p0, p1] plates: render only that part, shifted to the origin.
  const [rx0, rz0, rx1, rz1, rp0 = 0, rp1 = 1e9] = region ?? [0, 0, 1e9, 1e9];
  let X = 0, P = 0, Z = 0;
  const colour = new Map<string, number>();
  const key = (x: number, p: number, z: number): string => `${x},${p},${z}`;
  for (const e of world) for (const [x, p, z] of e.body) {
    if (x < rx0! || x >= rx1! || z < rz0! || z >= rz1! || p < rp0! || p >= rp1!) continue;
    X = Math.max(X, x - rx0! + 1); P = Math.max(P, p - rp0! + 1); Z = Math.max(Z, z - rz0! + 1);
    colour.set(key(x - rx0!, p - rp0!, z - rz0!), e.placed.colour);
  }
  if (view === 'w' || view === 'e' || view === 'n' || view === 's') {
    // Elevation: the nearest cell of every (across, plate) column seen from the named side, flat-shaded by depth.
    const alongZ = view === 'w' || view === 'e';
    const across = alongZ ? Z : X, depthMax = alongZ ? X : Z;
    const near = new Map<string, { c: number; d: number }>();
    for (const [k, c] of colour) {
      const [x, p, z] = k.split(',').map(Number) as [number, number, number];
      const a = alongZ ? (view === 'w' ? z : Z - 1 - z) : (view === 's' ? x : X - 1 - x);
      const d = view === 'w' ? x : view === 'e' ? X - 1 - x : view === 'n' ? z : Z - 1 - z;
      const kk = `${a},${p}`, have = near.get(kk);
      if (!have || d < have.d) near.set(kk, { c, d });
    }
    const sc = Math.min((maxPx - 8) / across, (maxPx - 8) / (P * PH_E));
    const w = Math.ceil(across * sc) + 8, h = Math.ceil(P * PH_E * sc) + 8;
    const img = new Uint8Array(w * h * 3).fill(22);
    for (const [kk, { c, d }] of near) {
      const [a, p] = kk.split(',').map(Number) as [number, number];
      const rgb = ldrawRgb(c) ?? [128, 128, 128];
      // Darker the deeper the cell lies behind the nearest surface around it: an opening shows the interior darker.
      let lo = d;
      for (let da = -8; da <= 8; da++) for (let dp = -8; dp <= 8; dp++) { const o = near.get(`${a + da},${p + dp}`); if (o && o.d < lo) lo = o.d; }
      const f = 1 - 0.65 * Math.min(1, (d - lo) / 4);
      void depthMax;
      const x0 = Math.floor(a * sc) + 4, x1 = Math.floor((a + 1) * sc) + 4, y1 = Math.floor((P - p) * PH_E * sc) + 4, y0 = Math.floor((P - p - 1) * PH_E * sc) + 4;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * w + x) * 3; img[o] = rgb[0] * f; img[o + 1] = rgb[1] * f; img[o + 2] = rgb[2] * f; }
    }
    return { png: png(w, h, img), w, h };
  }
  // Turn the model so the chosen corner faces the viewer.
  const flipX = view === 'nw' || view === 'sw', flipZ = view === 'nw' || view === 'ne';
  const tx = (x: number): number => (flipX ? X - 1 - x : x), tz = (z: number): number => (flipZ ? Z - 1 - z : z);
  const PH = 0.4; // plate height in studs
  const c30 = Math.cos(Math.PI / 6);
  const spanX = (X + Z) * c30, spanY = (X + Z) * 0.5 + P * PH;
  const s = Math.min((maxPx - 8) / spanX, (maxPx - 8) / spanY);
  const w = Math.ceil(spanX * s) + 8, h = Math.ceil(spanY * s) + 8;
  const img = new Uint8Array(w * h * 3).fill(22);
  const project = (x: number, p: number, z: number): [number, number] => [(x - z + Z) * c30 * s + 4, ((x + z) * 0.5 + (P - p) * PH) * s + 4];
  const poly = (pts: Array<[number, number]>, rgb: [number, number, number]): void => {
    let y0 = Infinity, y1 = -Infinity;
    for (const [, y] of pts) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(h - 1, Math.ceil(y1)); y++) {
      let xl = Infinity, xr = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const [ax, ay] = pts[i]!, [bx, by] = pts[(i + 1) % pts.length]!;
        const yy = y + 0.5;
        if ((ay <= yy && by > yy) || (by <= yy && ay > yy)) { const x = ax + ((yy - ay) / (by - ay)) * (bx - ax); xl = Math.min(xl, x); xr = Math.max(xr, x); }
      }
      for (let x = Math.max(0, Math.round(xl)); x < Math.min(w, Math.round(xr)); x++) { const o = (y * w + x) * 3; img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; }
    }
  };
  const shade = (rgb: readonly [number, number, number], f: number): [number, number, number] => [Math.round(rgb[0] * f), Math.round(rgb[1] * f), Math.round(rgb[2] * f)];
  // Model axes after the turn: draw far to near (small x + z first), low to high.
  const cells = new Map<string, number>();
  for (const [k, c] of colour) { const [x, p, z] = k.split(',').map(Number) as [number, number, number]; cells.set(key(tx(x), p, tz(z)), c); }
  const has = (x: number, p: number, z: number): boolean => cells.has(key(x, p, z));
  for (let sum = 0; sum < X + Z; sum++) for (let x = Math.max(0, sum - Z + 1); x <= Math.min(X - 1, sum); x++) {
    const z = sum - x;
    for (let p = 0; p < P; p++) {
      const c = cells.get(key(x, p, z));
      if (c === undefined) continue;
      const rgb = ldrawRgb(c) ?? [128, 128, 128];
      if (!has(x, p + 1, z)) poly([project(x, p + 1, z), project(x + 1, p + 1, z), project(x + 1, p + 1, z + 1), project(x, p + 1, z + 1)], shade(rgb, 1));
      if (!has(x, p, z + 1)) poly([project(x, p + 1, z + 1), project(x + 1, p + 1, z + 1), project(x + 1, p, z + 1), project(x, p, z + 1)], shade(rgb, 0.78));
      if (!has(x + 1, p, z)) poly([project(x + 1, p + 1, z), project(x + 1, p + 1, z + 1), project(x + 1, p, z + 1), project(x + 1, p, z)], shade(rgb, 0.58));
    }
  }
  return { png: png(w, h, img), w, h };
}

const FIXTURES = path.resolve(import.meta.dirname, '../test/fixtures/osm');
// `--fixture=<file>` reads an Overpass response from anywhere (the private designs repo's landmarks, L00);
// `--building=<type/id>` names the outline element, and `--building=parts` keeps only the `building:part` ways (no
// outline: an outline as tall as its parts hides them in massing, SPIRE). `--maxpx` bounds each PNG's longest side.
const overpass = JSON.parse(readFileSync(flag('fixture', path.join(FIXTURES, `${siteName}.overpass.json`)), 'utf8'));
if (flag('building', '') === 'parts') overpass.elements = overpass.elements.filter((e: { tags?: Record<string, string> }) => e.tags?.['building:part'] !== undefined);
const buildingFlag = flag('building', siteName === 'notre-dame' ? 'way/201611261' : '');
const buildingId = buildingFlag && buildingFlag !== 'parts' ? buildingFlag : undefined;
const site = siteFromOverpass(overpass, { retrieved: '2026-11-09', url: 'https://overpass-api.de/api/interpreter', ...(buildingId ? { buildingId } : {}) });
const massed = buildMassing(site.site, { roles: site.roles, scale: { target: Number(flag('target', '1')) } });
const sidecarPath = path.resolve(import.meta.dirname, '../web/src/brickgen/features/sidecars', `${siteName}.annotations.json`);
let sidecars: ReturnType<typeof parseSidecar>[] = [];
try { sidecars = [parseSidecar(JSON.parse(readFileSync(sidecarPath, 'utf8')))]; } catch { /* no sidecar for this site */ }
const featureSet = buildFeatureSet({ site: site.site, massing: massed, sidecars, tagParts: tagPartsFromOverpass(overpass.elements) });

const t0 = Date.now();
let lattice, stats: unknown, notes: string[], brick;
if (args.includes('--plain')) { const p = plainMassingLattice(massed.massing); lattice = p.lattice; notes = p.notes; stats = {}; brick = brickLattice(lattice, { scale: massed.massing.scale }); }
else { const g = buildGrammarModel(massed.massing, featureSet.set); lattice = g.lattice; notes = g.notes; stats = { ...g.stats, pruned: g.pruned, rounds: g.rounds }; brick = { plan: g.plan, report: g.report, repairs: 0, openings: 0 }; }
const t1 = Date.now();
const t2 = Date.now();
if (args.includes('--diag')) {
  // Where the model is not one piece: the parts of every component but the largest, and of every unsupported element.
  const { detail } = verifyPlanDetailed(brick.plan);
  const groups = new Map<number, string[]>();
  detail.world.forEach((w, i) => { const l = detail.connectivity.label[i]!; (groups.get(l) ?? groups.set(l, []).get(l)!).push(`${w.placed.part}@${w.placed.at.join(',')}`); });
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length).slice(1);
  for (const g of sorted.slice(0, 12)) console.log('component', g.length, g.slice(0, 6).join(' '));
  for (const u of detail.stability.unsupported.slice(0, 12)) console.log('unsupported', brick.plan.elements[u]!.part, brick.plan.elements[u]!.at.join(','));
}
const hist: Record<string, number> = {};
for (const e of brick.plan.elements) hist[e.part] = (hist[e.part] ?? 0) + 1;
mkdirSync(path.dirname(outBase), { recursive: true });
for (const v of flag('views', 'se,nw').split(',') as View[]) {
  const regionArg = flag('region', '');
  const r = renderPlan(brick.plan, v, Number(flag('maxpx', '1900')), regionArg ? regionArg.split(',').map(Number) : undefined);
  writeFileSync(`${outBase}-${v}.png`, r.png);
  console.log(`${outBase}-${v}.png ${r.w}x${r.h}`);
}
writeFileSync(`${outBase}.json`, JSON.stringify({ site: siteName, dims: lattice.dims, grammarMs: t1 - t0, brickMs: t2 - t1, report: brick.report, repairs: brick.repairs, openings: brick.openings, notes, stats, histogram: hist }, null, 1));
console.log(JSON.stringify({ dims: lattice.dims, grammarMs: t1 - t0, brickMs: t2 - t1, parts: brick.plan.elements.length, report: brick.report, notes }));
