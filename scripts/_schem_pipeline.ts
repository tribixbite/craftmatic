/**
 * QA harness: export → import round-trip for 20 varied large sets.
 *
 * Exercises the REAL LEGO-tab pipeline end to end:
 *   load (.io extractIoModel / .mpd|.ldr text) → synthesizeLSynth →
 *   parseLDraw → voxelizeLDraw → encodeSchemBytes → write .schem
 * then the REAL Upload-tab import path:
 *   parseSchematic → schematicToGrid → validate.
 *
 * Each run writes 20 .schem to output/schem-iter-<N>/ (never overwriting a
 * prior iteration) plus _report.json / _report.md listing every gap.
 *
 * Usage: bun scripts/_schem_pipeline.ts <iteration> [setsFile]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { extractIoModel } from '../web/src/engine/io-extractor.ts';
import { parseLDraw } from '../web/src/engine/ldraw-parser.ts';
import { synthesizeLSynth } from '../web/src/engine/lsynth.ts';
import { voxelizeLDraw } from '../web/src/engine/ldraw-voxelizer.ts';
import { hasDims } from '../web/src/engine/ldraw-part-dims.ts';
import { studioColorToBlock } from '../web/src/engine/studio-colors.ts';
import { ldrawColorToBlock } from '../web/src/engine/ldraw-colors.ts';
import { encodeSchemBytes } from '../web/src/viewer/exporter.ts';
import { parseSchematic, schematicToGrid } from '../src/schem/parse.ts';
// The REAL Upload-tab importer (browser path: pako + custom NBT parser) —
// distinct from the prismarine-nbt CLI parser above. Validate against THIS.
import { parseSchemFile } from '../web/src/engine/schem.ts';

const IO = 'C:/git/clego/lego_sets/IO';
const OMR = 'C:/git/clego/lego_sets/OMR';

// 20 varied, large, recognizable sets across categories. `io` ⇒ Studio colours,
// `ldr` ⇒ LDraw colours. First existing path wins (variant fallbacks).
const SETS: { name: string; cat: string; src: 'io' | 'ldr'; paths: string[] }[] = [
  { name: '21063 Neuschwanstein', cat: 'castle/SNOT', src: 'io', paths: [`${IO}/21063.io`] },
  { name: '71043 Hogwarts', cat: 'microscale', src: 'io', paths: [`${IO}/71043-1.io`, `${IO}/71043_hogwarts_castle.io`] },
  { name: '42110 Land Rover Defender', cat: 'technic', src: 'io', paths: [`${IO}/42110 Land Rover Defender.io`] },
  { name: '42083 Bugatti Chiron', cat: 'technic', src: 'io', paths: [`${IO}/42083-1.io`, `${IO}/42083 Bugatti Chiron.io`] },
  { name: '42115 Lamborghini', cat: 'technic', src: 'io', paths: [`${IO}/42115.io`, `${IO}/42115-1.io`] },
  { name: '10294 Titanic', cat: 'huge/ship', src: 'io', paths: [`${IO}/10294.io`, `${IO}/10294-1.io`] },
  { name: '10277 Crocodile Locomotive', cat: 'train', src: 'io', paths: [`${IO}/10277 Crocodile Locomotive.io`] },
  { name: '10290 Pickup Truck', cat: 'creator-car', src: 'io', paths: [`${IO}/10290 Pickup Truck.io`] },
  { name: '10300 Back to the Future', cat: 'vehicle', src: 'io', paths: [`${IO}/10300 Back to the Future Time Machine.io`] },
  { name: '10304 Camaro Z28', cat: 'creator-car', src: 'io', paths: [`${IO}/10304 Chevrolet Camaro Z28 1969.io`] },
  { name: '10305 Lion Knights Castle', cat: 'castle', src: 'io', paths: [`${IO}/10305.io`, `${IO}/10305-open.io`] },
  { name: '10307 Eiffel Tower', cat: 'tower', src: 'io', paths: [`${IO}/10307.io`, `${IO}/10307-tall.io`] },
  { name: '10317 Land Rover Defender 90', cat: 'creator-car', src: 'io', paths: [`${IO}/10317 Land Rover Classic Defender 90.io`] },
  { name: '42130 BMW M1000RR', cat: 'technic-bike', src: 'io', paths: [`${IO}/42130 BMW M 1000 RR.io`] },
  { name: '10220 VW T1 Camper', cat: 'creator-vehicle', src: 'io', paths: [`${IO}/10220 Volkswagen T1 Camper Van.io`] },
  { name: '10279 VW T2 Camper', cat: 'creator-vehicle', src: 'io', paths: [`${IO}/10279 Volkswagen T2 Camper Van.io`] },
  { name: '42143 Ferrari Daytona', cat: 'technic', src: 'io', paths: [`${IO}/42143.io`, `${IO}/42143-size1.io`] },
  { name: '10326 Natural History Museum', cat: 'modular', src: 'io', paths: [`${IO}/10326.io`, `${IO}/10326-size-noprint.io`] },
  { name: '10030 UCS Star Destroyer', cat: 'starwars-ucs', src: 'ldr', paths: [`${OMR}/10030-1.mpd`] },
  { name: '10179 UCS Millennium Falcon', cat: 'starwars-ucs', src: 'ldr', paths: [`${OMR}/10179-1.mpd`, `${OMR}/10179-1_UCS-Millennium-Falcon.mpd`] },
];

interface Gap { set: string; severity: 'error' | 'warn'; kind: string; detail: string; }

// ── Real-footprint check for fallback parts ───────────────────────────────────
// A part that lacks a dims entry falls back to 1×1×1. That's CORRECT for
// genuinely sub-voxel parts (flex-cable/hose segments, tiny clips) but WRONG
// for a part with a real multi-cell footprint. Resolve the part's actual .dat
// bounding box from the local LDraw library to tell the two apart, so the
// "missing-dims" warning reports only REAL gaps, not phantom flex noise.
const LDRAW_LIB = 'C:/git/clego/extracted/studio_release/app/ldraw';
const bboxCache = new Map<string, { w: number; h: number; l: number } | null>();
/** Locate a .dat; returns [path, isPrimitive] — primitives live under p/. */
function findDat(p: string): [string, boolean] | null {
  for (const d of ['parts', 'parts/s', 'UnOfficial/parts', 'UnOfficial/parts/s']) {
    const f = join(LDRAW_LIB, d, `${p}.dat`);
    if (existsSync(f)) return [f, false];
  }
  for (const d of ['p', 'p/48', 'UnOfficial/p', 'UnOfficial/p/48']) {
    const f = join(LDRAW_LIB, d, `${p}.dat`);
    if (existsSync(f)) return [f, true];
  }
  return null;
}
function partFootprint(part: string, depth = 0, seen = new Set<string>()): { w: number; h: number; l: number } | null {
  const id = part.replace(/\.dat$/i, '').toLowerCase();
  if (depth === 0 && bboxCache.has(id)) return bboxCache.get(id)!;
  if (depth > 8 || seen.has(id)) return null;
  seen.add(id);
  const found = findDat(id);
  if (!found) { if (depth === 0) bboxCache.set(id, null); return null; }
  const f = found[0];
  let mnx = 1e9, mxx = -1e9, mny = 1e9, mxy = -1e9, mnz = 1e9, mxz = -1e9, any = false;
  const acc = (x: number, y: number, z: number) => { mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z); any = true; };
  for (const raw of readFileSync(f, 'utf-8').split(/\r?\n/)) {
    const k = raw.trim().split(/\s+/);
    if (k[0] === '3' || k[0] === '4') {
      const n = k[0] === '3' ? 9 : 12;
      for (let i = 0; i < n; i += 3) { const x = +k[2 + i], y = +k[3 + i], z = +k[4 + i]; if (!Number.isNaN(x)) acc(x, y, z); }
    } else if (k[0] === '1') {
      const tx = +k[2], ty = +k[3], tz = +k[4];
      const child = partFootprint(k.slice(14).join(' '), depth + 1, seen);
      if (child) acc(tx - child.w * 10, ty - child.h * 4, tz - child.l * 10), acc(tx + child.w * 10, ty + child.h * 4, tz + child.l * 10);
    }
  }
  if (!any) { if (depth === 0) bboxCache.set(id, null); return null; }
  const r = { w: (mxz - mnz) / 20, h: (mxy - mny) / 8, l: (mxx - mnx) / 20 };
  if (depth === 0) bboxCache.set(id, r);
  return r;
}
/**
 * True if this is a REAL part (not a p/ primitive) whose actual footprint is
 * meaningfully larger than one cell — so a 1×1×1 dims fallback is a genuine
 * accuracy gap (vs. correct for flex/sub-voxel/tiny parts).
 */
function isSubstantiveGap(part: string): boolean {
  const id = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  const found = findDat(id);
  if (!found || found[1]) return false; // missing or primitive → not a real-part dims gap
  const fp = partFootprint(id);
  if (!fp) return false;
  return fp.w >= 1.5 || fp.l >= 1.5 || fp.h >= 2.0;
}

async function loadBricks(src: 'io' | 'ldr', path: string) {
  if (src === 'io') {
    const buf = readFileSync(path);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const io = await extractIoModel(ab);
    const text = synthesizeLSynth(io.text).text;
    return { bricks: parseLDraw(text), colorFn: studioColorToBlock };
  }
  const text = synthesizeLSynth(readFileSync(path, 'utf-8')).text;
  return { bricks: parseLDraw(text), colorFn: ldrawColorToBlock };
}

async function main() {
  const iter = process.argv[2] ?? '1';
  const outDir = join('output', `schem-iter-${iter}`);
  if (existsSync(outDir)) { console.error(`REFUSING to overwrite existing ${outDir} — bump iteration.`); process.exit(1); }
  mkdirSync(outDir, { recursive: true });

  const gaps: Gap[] = [];
  const rows: Record<string, unknown>[] = [];
  const addGap = (set: string, severity: 'error' | 'warn', kind: string, detail: string) =>
    gaps.push({ set, severity, kind, detail });

  for (const set of SETS) {
    const path = set.paths.find(existsSync);
    const row: Record<string, unknown> = { set: set.name, cat: set.cat, src: set.src };
    rows.push(row);
    if (!path) { addGap(set.name, 'error', 'missing-source', `none of: ${set.paths.map(basename).join(', ')}`); row.status = 'NO SOURCE'; continue; }
    row.file = basename(path);

    try {
      // ── EXPORT (LEGO tab Download→.schem) ───────────────────────────────
      const { bricks, colorFn } = await loadBricks(set.src, path);
      row.bricks = bricks.length;
      if (bricks.length === 0) { addGap(set.name, 'error', 'no-bricks', 'parseLDraw returned 0 placements'); row.status = 'NO BRICKS'; continue; }

      const vox = voxelizeLDraw(bricks, colorFn);
      const blocks = vox.grid.countNonAir();
      const { w, h, l } = vox.dimensions;
      row.dims = `${w}x${h}x${l}`; row.blocks = blocks;
      row.uniqueColors = vox.uniqueColors;
      row.unmapped = vox.unmappedColors.length;
      row.fallbackParts = vox.fallbackPartCount;

      if (blocks === 0) addGap(set.name, 'error', 'empty-voxelization', `${bricks.length} bricks → 0 blocks`);
      if (Math.min(w, h, l) <= 1) addGap(set.name, 'error', 'collapsed-dim', `dims ${w}x${h}x${l}`);
      if (h > 256) addGap(set.name, 'warn', 'over-build-height', `height ${h} > 256 (MC limit)`);
      if (vox.unmappedColors.length > 0) addGap(set.name, 'warn', 'unmapped-colors', `IDs ${vox.unmappedColors.slice(0, 12).join(',')}${vox.unmappedColors.length > 12 ? '…' : ''} → gray fallback`);
      // REAL dims gap = a non-primitive part with a genuine multi-cell footprint
      // that lacks a dims entry (so it collapsed to 1×1×1). Sub-voxel flex/hose
      // segments and tiny parts are excluded — 1×1×1 is correct for them.
      const realGapParts = new Map<string, number>();
      for (const b of bricks) {
        if (hasDims(b.part)) continue;
        if (!isSubstantiveGap(b.part)) continue;
        const id = b.part.replace(/\.dat$/i, '');
        realGapParts.set(id, (realGapParts.get(id) ?? 0) + 1);
      }
      row.realGapParts = [...realGapParts.keys()].length;
      row.fallbackTotal = vox.fallbackPartCount; // raw (incl. correct sub-voxel) for reference
      if (realGapParts.size > 0) {
        const top = [...realGapParts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, c]) => `${p}×${c}`).join(', ');
        addGap(set.name, 'warn', 'missing-dims', `${realGapParts.size} substantive part(s) lack dims → 1×1×1: ${top}`);
      }

      const schem = encodeSchemBytes(vox.grid);
      row.schemKB = Math.round(schem.length / 1024);
      const outPath = join(outDir, `${set.name.replace(/[^\w.-]+/g, '_')}.schem`);
      writeFileSync(outPath, schem);

      // ── IMPORT via the REAL Upload-tab parser (browser: parseSchemFile) ──
      const uploadGrid = await parseSchemFile(
        schem.buffer.slice(schem.byteOffset, schem.byteOffset + schem.byteLength) as ArrayBuffer,
      );
      const upBlocks = uploadGrid.countNonAir();
      if (uploadGrid.width !== w || uploadGrid.height !== h || uploadGrid.length !== l)
        addGap(set.name, 'error', 'upload-dim-mismatch', `export ${w}x${h}x${l} ≠ Upload-tab ${uploadGrid.width}x${uploadGrid.height}x${uploadGrid.length}`);
      if (upBlocks !== blocks)
        addGap(set.name, 'error', 'upload-block-mismatch', `export ${blocks} ≠ Upload-tab ${upBlocks}`);
      row.uploadBlocks = upBlocks;

      // ── Cross-check: CLI parser (prismarine-nbt) round-trip ─────────────
      const data = await parseSchematic(outPath);
      const reGrid = schematicToGrid(data);
      const reBlocks = reGrid.countNonAir();
      if (reBlocks !== blocks)
        addGap(set.name, 'error', 'cli-block-mismatch', `export ${blocks} ≠ CLI-import ${reBlocks}`);
      row.reBlocks = reBlocks;
      row.status = gaps.some(g => g.set === set.name && g.severity === 'error') ? 'ERROR' : (gaps.some(g => g.set === set.name) ? 'WARN' : 'OK');
    } catch (e) {
      addGap(set.name, 'error', 'exception', String(e instanceof Error ? e.stack ?? e.message : e).slice(0, 300));
      row.status = 'EXCEPTION';
    }
    console.error(`  ${row.status}\t${set.name}\t${row.dims ?? ''}\t${row.blocks ?? ''} blocks`);
  }

  // ── Report ────────────────────────────────────────────────────────────
  const errs = gaps.filter(g => g.severity === 'error');
  const warns = gaps.filter(g => g.severity === 'warn');
  writeFileSync(join(outDir, '_report.json'), JSON.stringify({ iter, rows, gaps }, null, 2));
  const md = [
    `# Schem pipeline iteration ${iter}`, '',
    `${rows.length} sets · ${errs.length} errors · ${warns.length} warnings`, '',
    '| set | cat | status | dims | blocks | reimport | unmapped | fallbackParts | schemKB |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.set} | ${r.cat} | ${r.status ?? '?'} | ${r.dims ?? '-'} | ${r.blocks ?? '-'} | ${r.reBlocks ?? '-'} | ${r.unmapped ?? '-'} | ${r.fallbackParts ?? '-'} | ${r.schemKB ?? '-'} |`),
    '', '## Gaps', '',
    ...(gaps.length ? gaps.map(g => `- **[${g.severity}] ${g.kind}** — ${g.set}: ${g.detail}`) : ['_none_']),
  ].join('\n');
  writeFileSync(join(outDir, '_report.md'), md);
  console.error(`\n=== iter ${iter}: ${errs.length} errors, ${warns.length} warnings → ${outDir}/_report.md ===`);
}

await main();
