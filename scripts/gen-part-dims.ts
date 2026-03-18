#!/usr/bin/env bun
/**
 * Build-time script: computes bounding-box dimensions for every LDraw part
 * and emits web/src/engine/ldraw-part-dims-generated.ts.
 *
 * Algorithm:
 *   For each parts/*.dat file, recursively resolve sub-file references,
 *   accumulate all vertex positions (type-3 triangles, type-4 quads), and
 *   compute an axis-aligned bounding box in LDraw units.
 *
 *   Convert spans to voxel units:
 *     sW = round(zSpan / 20)   (LDraw Z → studs width)
 *     sH = round(ySpan / 8)    (LDraw Y → plate-heights)
 *     sL = round(xSpan / 20)   (LDraw X → studs length)
 *   Clamp all values to ≥ 1.
 *
 * Usage: bun scripts/gen-part-dims.ts
 */

import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const LDRAW_ROOT = resolve('C:/git/clego/extracted/studio_release/app/ldraw');
const PARTS_DIR      = join(LDRAW_ROOT, 'parts');
const SUBPARTS_DIR   = join(LDRAW_ROOT, 'parts', 's');
const PRIMS_DIR      = join(LDRAW_ROOT, 'p');
const UNOFF_PARTS    = join(LDRAW_ROOT, 'UnOfficial', 'parts');
const UNOFF_PRIMS    = join(LDRAW_ROOT, 'UnOfficial', 'p');
const UNOFF_SUBPARTS = join(LDRAW_ROOT, 'UnOfficial', 'parts', 's');

const OUT_FILE = resolve(import.meta.dir, '../web/src/engine/ldraw-part-dims-generated.ts');

// ─── Types ───────────────────────────────────────────────────────────────────

interface BBox {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

const INF = Infinity;

function emptyBBox(): BBox {
  return { minX: INF, maxX: -INF, minY: INF, maxY: -INF, minZ: INF, maxZ: -INF };
}

function isBBoxEmpty(b: BBox): boolean {
  return b.minX === INF;
}

function extendBBox(b: BBox, x: number, y: number, z: number): void {
  if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y;
  if (z < b.minZ) b.minZ = z; if (z > b.maxZ) b.maxZ = z;
}

function mergeBBox(dst: BBox, src: BBox): void {
  if (isBBoxEmpty(src)) return;
  extendBBox(dst, src.minX, src.minY, src.minZ);
  extendBBox(dst, src.maxX, src.maxY, src.maxZ);
}

// ─── File Resolution ─────────────────────────────────────────────────────────

/** Build a case-insensitive filename index for a directory (if it exists). */
function buildIndex(dir: string): Map<string, string> {
  const idx = new Map<string, string>();
  if (!existsSync(dir)) return idx;
  for (const f of readdirSync(dir)) {
    idx.set(f.toLowerCase(), join(dir, f));
  }
  return idx;
}

const idxParts      = buildIndex(PARTS_DIR);
const idxSubparts   = buildIndex(SUBPARTS_DIR);
const idxPrims      = buildIndex(PRIMS_DIR);
const idxUnoffParts = buildIndex(UNOFF_PARTS);
const idxUnoffPrims = buildIndex(UNOFF_PRIMS);
const idxUnoffSubs  = buildIndex(UNOFF_SUBPARTS);

/** Resolve a sub-file reference name to an absolute path, or null. */
function resolveSubFile(name: string): string | null {
  // Normalise slashes
  const norm = name.replace(/\\/g, '/').toLowerCase();

  // Sub-parts: starts with "s/" prefix
  if (norm.startsWith('s/')) {
    const stem = norm.slice(2);
    return idxSubparts.get(stem) ?? idxUnoffSubs.get(stem) ?? null;
  }

  // p/ sub-directory of primitives (48/ hi-res, 8/ lo-res)
  if (norm.startsWith('p/') || norm.startsWith('48/') || norm.startsWith('8/')) {
    // look inside prims dir
    const parts2 = norm.split('/');
    const sub = parts2[0];
    const stem = parts2.slice(1).join('/');
    const subDir = join(PRIMS_DIR, sub);
    const subDirIdx = buildIndex(subDir);
    return subDirIdx.get(stem.toLowerCase()) ?? null;
  }

  const stem = norm.includes('/') ? norm.split('/').pop()! : norm;

  // Search order: prims, subparts, parts, unofficial
  return (
    idxPrims.get(stem)      ??
    idxSubparts.get(stem)   ??
    idxParts.get(stem)      ??
    idxUnoffParts.get(stem) ??
    idxUnoffPrims.get(stem) ??
    idxUnoffSubs.get(stem)  ??
    null
  );
}

// ─── BBox Cache & Computation ────────────────────────────────────────────────

// null = file exists but has no geometry; SENTINEL = currently computing (cycle guard)
const SENTINEL = Symbol('computing');
const bboxCache = new Map<string, BBox | null | typeof SENTINEL>();
const fileContentCache = new Map<string, string>();

function readDatFile(absPath: string): string {
  if (fileContentCache.has(absPath)) return fileContentCache.get(absPath)!;
  try {
    const text = readFileSync(absPath, 'utf-8');
    fileContentCache.set(absPath, text);
    return text;
  } catch {
    fileContentCache.set(absPath, '');
    return '';
  }
}

/**
 * Compute the axis-aligned bounding box of a .dat file in its LOCAL coordinate
 * space (no external transform applied).  Results are cached.
 *
 * Returns null if the file has no geometry (e.g. empty primitive).
 */
function getLocalBBox(absPath: string, depth = 0): BBox | null {
  // Cycle / depth guard
  const cached = bboxCache.get(absPath);
  if (cached === SENTINEL) return null;   // cycle detected
  if (bboxCache.has(absPath)) return cached as BBox | null;
  if (depth > 30) return null;

  bboxCache.set(absPath, SENTINEL);       // mark in-progress

  const text = readDatFile(absPath);
  const bbox = emptyBBox();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const tok = line.split(/\s+/);
    const type = tok[0];

    if (type === '3' && tok.length >= 11) {
      // Triangle: 3 color x1 y1 z1 x2 y2 z2 x3 y3 z3
      extendBBox(bbox, +tok[2], +tok[3], +tok[4]);
      extendBBox(bbox, +tok[5], +tok[6], +tok[7]);
      extendBBox(bbox, +tok[8], +tok[9], +tok[10]);
    } else if (type === '4' && tok.length >= 14) {
      // Quad: 4 color x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4
      extendBBox(bbox, +tok[2],  +tok[3],  +tok[4]);
      extendBBox(bbox, +tok[5],  +tok[6],  +tok[7]);
      extendBBox(bbox, +tok[8],  +tok[9],  +tok[10]);
      extendBBox(bbox, +tok[11], +tok[12], +tok[13]);
    } else if (type === '1' && tok.length >= 15) {
      // Sub-file: 1 color tx ty tz  a b c  d e f  g h i  subfile
      const tx = +tok[2], ty = +tok[3], tz = +tok[4];
      const a = +tok[5],  b = +tok[6],  c = +tok[7];
      const d = +tok[8],  e = +tok[9],  f = +tok[10];
      const g = +tok[11], h = +tok[12], i = +tok[13];
      // Sub-file name may contain spaces (rare); join remaining tokens
      const subName = tok.slice(14).join(' ').trim();

      const subPath = resolveSubFile(subName);
      if (!subPath) continue;

      const childBBox = getLocalBBox(subPath, depth + 1);
      if (!childBBox) continue;

      // Transform 8 corners of child AABB through (R=[a..i], T=[tx,ty,tz])
      // world = R * local + T
      const corners: [number, number, number][] = [
        [childBBox.minX, childBBox.minY, childBBox.minZ],
        [childBBox.maxX, childBBox.minY, childBBox.minZ],
        [childBBox.minX, childBBox.maxY, childBBox.minZ],
        [childBBox.maxX, childBBox.maxY, childBBox.minZ],
        [childBBox.minX, childBBox.minY, childBBox.maxZ],
        [childBBox.maxX, childBBox.minY, childBBox.maxZ],
        [childBBox.minX, childBBox.maxY, childBBox.maxZ],
        [childBBox.maxX, childBBox.maxY, childBBox.maxZ],
      ];
      for (const [cx, cy, cz] of corners) {
        extendBBox(bbox,
          a*cx + b*cy + c*cz + tx,
          d*cx + e*cy + f*cz + ty,
          g*cx + h*cy + i*cz + tz,
        );
      }
    }
  }

  const result = isBBoxEmpty(bbox) ? null : bbox;
  bboxCache.set(absPath, result);
  return result;
}

// ─── Normalization ────────────────────────────────────────────────────────────

/** Strip extension, print suffixes (p01, pb01…), and trailing letter variants.
 * Only strips trailing letters when the stem contains digits (numeric part IDs). */
function normalizeId(stem: string): string {
  const lower = stem.toLowerCase().replace(/\.dat$/i, '');
  // Only apply variant-stripping to numeric part IDs (contain at least one digit)
  if (!/\d/.test(lower)) return lower;  // pure-alpha names (flowers, light, etc.) → keep as-is
  return lower
    .replace(/p[a-z0-9]{2,}$/, '')   // print suffix: p01, pb01, pf01 …
    .replace(/[a-z]+$/, '');          // letter variant: a, b, c, ab …
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log('Indexing LDraw parts…');

// List all .dat files in parts/ and UnOfficial/parts/ (not recursing into s/)
function listDatFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.dat') && !f.includes('/') && !f.includes('\\'))
    .map(f => join(dir, f));
}

const officialFiles = listDatFiles(PARTS_DIR);
const unofficialFiles = listDatFiles(UNOFF_PARTS);
// Sort to ensure plain name (3001.dat) comes before variants (3001a.dat)
const allPartFiles = [...officialFiles, ...unofficialFiles].sort((a, b) =>
  basename(a).localeCompare(basename(b), undefined, { numeric: true }),
);

console.log(`Found ${officialFiles.length} official + ${unofficialFiles.length} unofficial parts. Computing bounding boxes…`);

const dims: Map<string, [number, number, number]> = new Map();
let processed = 0;
let skipped1x1 = 0;
let noGeometry = 0;

const startTime = Date.now();

for (const absPath of allPartFiles) {
  const stem = basename(absPath, '.dat');
  const id = normalizeId(stem);

  // Skip if we already have an entry for this normalized ID (prefer plain name)
  if (dims.has(id)) continue;

  const bbox = getLocalBBox(absPath);

  if (!bbox) {
    noGeometry++;
    continue;
  }

  const xSpan = Math.abs(bbox.maxX - bbox.minX);
  const ySpan = Math.abs(bbox.maxY - bbox.minY);
  const zSpan = Math.abs(bbox.maxZ - bbox.minZ);

  const sW = Math.max(1, Math.round(zSpan / 20));
  // Use floor for sH: stud bumps add ~4 LDU (half a plate) above the brick body,
  // so Math.round inflates every brick/plate by 1 plate. Floor truncates correctly.
  const sH = Math.max(1, Math.floor(ySpan / 8));
  const sL = Math.max(1, Math.round(xSpan / 20));

  // Skip trivial 1×1×1 entries — same as the default, no value in emitting
  if (sW === 1 && sH === 1 && sL === 1) {
    skipped1x1++;
    continue;
  }

  dims.set(id, [sW, sH, sL]);
  processed++;

  if (processed % 1000 === 0) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ${processed} non-trivial dims computed (${elapsed}s elapsed)…`);
  }
}

console.log(`\nDone.`);
console.log(`  Non-trivial entries: ${dims.size}`);
console.log(`  Trivial (1×1×1) skipped: ${skipped1x1}`);
console.log(`  No geometry: ${noGeometry}`);
console.log(`  Total processed: ${allPartFiles.length}`);
console.log(`  Elapsed: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

// ─── Emit TypeScript file ────────────────────────────────────────────────────

const entries = [...dims.entries()]
  .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
  .map(([id, [w, h, l]]) => `  '${id}': [${w}, ${h}, ${l}]`)
  .join(',\n');

const output = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/gen-part-dims.ts
// Generated: ${new Date().toISOString()}
// Source: ${LDRAW_ROOT}
// Entries: ${dims.size} non-trivial parts (1×1×1 parts omitted; fall back to default)
export const GENERATED_DIMS: Record<string, readonly [number, number, number]> = {
${entries},
};
`;

writeFileSync(OUT_FILE, output, 'utf-8');
console.log(`\nWrote ${OUT_FILE}`);
