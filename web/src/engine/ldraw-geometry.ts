/**
 * Geometry-accurate voxelization from LDraw .dat triangle data.
 *
 * Fetches .dat files from the local dev server (/ldraw-parts — see vite.config.ts),
 * resolves sub-file references recursively, and rasterizes the resulting triangle
 * mesh into grid cells using Z-direction ray casting (Möller-Trumbore).
 *
 * Usage:
 *   // 1. Prefetch all unique part IDs (batch, parallel fetch)
 *   await prefetchPartGeometry(uniquePartIds);
 *   // 2. Voxelize — async drop-in for voxelizeLDraw()
 *   const result = await voxelizeLDrawGeometry(bricks, colorFn, options);
 *
 * `/ldraw-parts` RESOLVES IN PRODUCTION TOO. (The header used to say this was
 * dev-only and that every part fell back to no-geometry in prod — untrue since
 * 2026-06, and corrected here per the 2026-09-08 audit's P2 item.) In dev a
 * Vite middleware serves the local clego library; on craftmatic.click the
 * Cloudflare Worker serves the same paths R2-first from the `lego-models`
 * bucket, with library.ldraw.org as a fallback. See CLAUDE.md, "LDraw parts
 * library — DEV vs PROD".
 *
 * The one deployment where geometry genuinely is unavailable is the GitHub
 * Pages mirror, which has no Worker routes at all — see README, "Web App".
 *
 * When a part still does not resolve, that part alone falls back to its
 * bounding box and is counted in `fallbackPartCount`; the rest of the model
 * voxelizes from real triangles.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { BlockGrid } from '@craft/schem/types.js';
import { ldrawColorToBlock, LDRAW_COLOR_TO_BLOCK } from './ldraw-colors.js';
import { type VoxelizeResult, type VoxelizeOptions, TECHNIC_INTERNAL_PARTS } from './ldraw-voxelizer.js';
import {
  createShapeHints, addOccupancy, addStairRequest, addElementRequest,
  isSlopeDescription, analyzeSlope, stairCodeForPlacement,
  type ShapeHints, type SlopeAnalysis,
} from './block-shapes.js';
import {
  elementKindForDescription, MAX_ELEMENT_CELLS, ELEMENT_NONE, type ElementKind,
} from './part-elements.js';
import { getPartDims } from './ldraw-part-dims.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type Vec3 = readonly [number, number, number];
type Triangle = readonly [Vec3, Vec3, Vec3];

// ─── Caches ───────────────────────────────────────────────────────────────────

const datTextCache  = new Map<string, string | null>();
const partGeomCache = new Map<string, Triangle[]>();
const datInFlight   = new Map<string, Promise<string | null>>();
const geomInFlight  = new Map<string, Promise<Triangle[]>>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normId(id: string): string {
  return id.replace(/\\/g, '/').toLowerCase().replace(/\.dat$/i, '').trim();
}

function applyMat(v: Vec3, R: readonly number[], T: Vec3): Vec3 {
  return [
    R[0]! * v[0] + R[1]! * v[1] + R[2]! * v[2] + T[0],
    R[3]! * v[0] + R[4]! * v[1] + R[5]! * v[2] + T[1],
    R[6]! * v[0] + R[7]! * v[1] + R[8]! * v[2] + T[2],
  ];
}

function isLDrawPrimitive(part: string): boolean {
  const bare = part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
  if (/^\d+-\d+/.test(bare))         return true;
  if (bare.startsWith('stug-'))      return true;
  if (bare === 'axl2hole' || bare.startsWith('axlhol')) return true;
  if (bare.startsWith('connect'))    return true;
  if (bare.startsWith('npeghol'))    return true;
  if (bare.startsWith('npeghole'))   return true;
  if (bare.startsWith('logo'))       return true;
  if (bare.startsWith('stud'))       return true;
  if (bare === 'box' || /^box[\da-z]/.test(bare)) return true;
  if (bare === 'disc')               return true;
  if (bare === 'knob' || bare === 'tooth') return true;
  if (/^\d+s\d+$/.test(bare))       return true;
  if (/^ls\d+/.test(bare))          return true;  // LSynth virtual hose/cable segments
  return false;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

/** Browser URL path for dev server, or filesystem root for CLI usage. */
let LDRAW_BASE = '/ldraw-parts';
/** When true, read .dat files from local filesystem instead of fetch(). */
let useFilesystem = false;

/**
 * Configure the LDraw parts library root.
 * Call before voxelizing in CLI scripts where fetch() won't reach the dev server.
 * @param fsRoot Absolute path to the LDraw library root (e.g. 'C:/git/clego/extracted/studio_release/app/ldraw')
 */
export function setLDrawRoot(fsRoot: string): void {
  LDRAW_BASE = fsRoot.replace(/\\/g, '/').replace(/\/$/, '');
  useFilesystem = true;
}

/**
 * Point the fetch-based loader at a different origin/path (e.g. from a Web
 * Worker, which has no page-relative base). Stays in fetch mode.
 */
export function setLDrawBase(base: string): void {
  LDRAW_BASE = base.replace(/\/$/, '');
  useFilesystem = false;
}

/**
 * Pre-populate the .dat text cache from an outside source.
 *
 * The export path used to re-download the whole part library for a model the
 * viewer had ALREADY loaded, because the viewer's cache lives in
 * `viewer/ldraw/parts.ts` — a different module (and, in the export worker, a
 * different thread). `ui/schem-export.ts` now snapshots that cache
 * (`collectDatTexts()`) and seeds it here before voxelizing, so an export of
 * the rendered model does zero network work. Texts in, triangles out — the
 * resolver below is untouched.
 *
 * A `null` value is a known-definitive miss (skip the fetch, use the AABB
 * fallback). Seeding never DOWNGRADES a real text to a miss. Anything already
 * cached with different text invalidates the assembled-triangle cache, since
 * parents may have baked the old child in.
 *
 * @returns how many entries were newly added or changed.
 */
export function seedDatTexts(entries: Iterable<readonly [string, string | null]>): number {
  let changed = 0;
  let replaced = false;
  for (const [rawId, text] of entries) {
    const key = normId(rawId);
    if (!key) continue;
    const existing = datTextCache.get(key);
    if (existing === text) continue;
    // Never turn a resolved part into a missing one.
    if (text === null && typeof existing === 'string') continue;
    if (existing !== undefined) replaced = true;
    datTextCache.set(key, text);
    changed++;
  }
  // A replaced text can be embedded in an already-assembled parent, so the
  // triangle cache as a whole is suspect. Pure additions can't invalidate it.
  if (replaced) partGeomCache.clear();
  return changed;
}

async function fetchDatText(id: string): Promise<string | null> {
  const key = normId(id);
  if (datTextCache.has(key)) return datTextCache.get(key)!;
  if (datInFlight.has(key))  return datInFlight.get(key)!;

  const stem = key.split('/').pop()!;

  const paths: string[] = [];
  if (key.includes('/')) {
    if (key.startsWith('s/'))
      paths.push(`${LDRAW_BASE}/parts/${key}.dat`);
    else
      paths.push(`${LDRAW_BASE}/p/${key}.dat`, `${LDRAW_BASE}/UnOfficial/p/${key}.dat`);
  }
  paths.push(
    `${LDRAW_BASE}/parts/${stem}.dat`,
    `${LDRAW_BASE}/p/${stem}.dat`,
    `${LDRAW_BASE}/parts/s/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/parts/${stem}.dat`,
    `${LDRAW_BASE}/UnOfficial/p/${stem}.dat`,
  );

  const promise = (async (): Promise<string | null> => {
    for (const path of paths) {
      try {
        if (useFilesystem) {
          // CLI: read from local filesystem
          const { readFileSync, existsSync } = await import('node:fs');
          if (existsSync(path)) {
            const text = readFileSync(path, 'utf-8');
            datTextCache.set(key, text);
            return text;
          }
        } else {
          // Browser: fetch from dev server
          const r = await fetch(path);
          if (r.ok) {
            const text = await r.text();
            datTextCache.set(key, text);
            return text;
          }
        }
      } catch { /* try next path */ }
    }
    datTextCache.set(key, null);
    return null;
  })();

  datInFlight.set(key, promise);
  const result = await promise;
  datInFlight.delete(key);
  return result;
}

// ─── Triangle resolution ──────────────────────────────────────────────────────

/**
 * Resolve all triangles for a part in its LOCAL coordinate space.
 * Sub-file references are recursively resolved and transformed into parent space.
 * Results are cached — concurrent calls for the same ID share one promise.
 */
async function resolvePartTriangles(
  id: string,
  depth = 0,
  ancestors: ReadonlySet<string> | null = null,
): Promise<Triangle[]> {
  if (depth > 12) return [];
  const key = normId(id);

  // IN-FLIGHT IS CHECKED FIRST — order matters (fixed 2026-09-02).
  // `partGeomCache` is populated with the still-EMPTY triangle array before the
  // sub-file references are appended (the cycle guard below), so a concurrent
  // resolution that read the cache first could copy a partially-assembled part
  // into its parent. Which callers lost that race depended purely on fetch
  // timing, so the SAME model voxelized differently over a warm cache than over
  // the network (measured on 21063: 1,184,777 vs 1,174,763 non-air cells). The
  // in-flight promise always resolves to the COMPLETE array.
  const inFlight = geomInFlight.get(key);
  if (inFlight) {
    // The one caller that may NOT wait is a genuine reference cycle — a part
    // that (transitively) references itself would deadlock awaiting its own
    // ancestor. It reads the partial array, exactly as before.
    if (ancestors?.has(key)) return partGeomCache.get(key) ?? [];
    return inFlight;
  }
  if (partGeomCache.has(key)) return partGeomCache.get(key)!;

  const childAncestors = new Set(ancestors ?? []);
  childAncestors.add(key);

  const promise = (async (): Promise<Triangle[]> => {
    const text = await fetchDatText(key);
    if (!text) return [];

    const tris: Triangle[] = [];
    partGeomCache.set(key, tris);     // cache reference early (cycle guard)

    const subPromises: Promise<void>[] = [];

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const tok = line.split(/\s+/);

      if (tok[0] === '3' && tok.length >= 11) {
        tris.push([
          [+tok[2]!, +tok[3]!, +tok[4]!],
          [+tok[5]!, +tok[6]!, +tok[7]!],
          [+tok[8]!, +tok[9]!, +tok[10]!],
        ]);
      } else if (tok[0] === '4' && tok.length >= 14) {
        const v0: Vec3 = [+tok[2]!, +tok[3]!, +tok[4]!];
        const v1: Vec3 = [+tok[5]!, +tok[6]!, +tok[7]!];
        const v2: Vec3 = [+tok[8]!, +tok[9]!, +tok[10]!];
        const v3: Vec3 = [+tok[11]!, +tok[12]!, +tok[13]!];
        tris.push([v0, v1, v2]);
        tris.push([v0, v2, v3]);       // quad → 2 triangles
      } else if (tok[0] === '1' && tok.length >= 15 && depth < 11) {
        const tx = +tok[2]!, ty = +tok[3]!, tz = +tok[4]!;
        const R = [+tok[5]!,+tok[6]!,+tok[7]!, +tok[8]!,+tok[9]!,+tok[10]!, +tok[11]!,+tok[12]!,+tok[13]!];
        const T: Vec3 = [tx, ty, tz];
        const subId = tok.slice(14).join(' ').trim();

        subPromises.push(
          resolvePartTriangles(subId, depth + 1, childAncestors).then(subTris => {
            for (const [sv0, sv1, sv2] of subTris) {
              tris.push([applyMat(sv0, R, T), applyMat(sv1, R, T), applyMat(sv2, R, T)]);
            }
          }),
        );
      }
    }

    await Promise.all(subPromises);
    return tris;
  })();

  geomInFlight.set(key, promise);
  const result = await promise;
  geomInFlight.delete(key);
  return result;
}

/**
 * Batch-prefetch geometry for all provided part IDs in parallel.
 *
 * Progress is REAL: one tick per top-level part as it finishes resolving
 * (`resolved / total`). Before this the phase posted a single `0` and then sat
 * there for the whole download — on a cold big set that is minutes of a banner
 * reading "loading part geometry 0%", which is indistinguishable from a hang.
 */
export async function prefetchPartGeometry(
  partIds: string[],
  onProgress?: VoxelProgress,
): Promise<void> {
  const unique = [...new Set(partIds.map(normId))];
  const total = unique.length;
  if (total === 0) return;
  let done = 0;
  onProgress?.('loading part geometry', 0);
  await Promise.all(unique.map(id => resolvePartTriangles(id).then(() => {
    done++;
    onProgress?.('loading part geometry', (done / total) * 100);
  })));
}

/**
 * Diagnostic hook: resolve ONE brick's triangles in world LDU.
 * Used by `scripts/_hair_probe.ts` to compare two parts' real extents without
 * running a whole export. Not used by the pipeline.
 */
export async function __debugWorldTris(
  brick: { part: string; x: number; y: number; z: number; rot?: number[] },
): Promise<Triangle[]> {
  const local = await resolvePartTriangles(brick.part);
  const R = brick.rot ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const T: Vec3 = [brick.x, brick.y, brick.z];
  return local.map(([v0, v1, v2]) => [applyMat(v0, R, T), applyMat(v1, R, T), applyMat(v2, R, T)] as Triangle);
}

// ─── Ray-triangle intersection (generic axis) ───────────────────────────────
// (see __debugCells below for the diagnostic wrapper around the rasterizer)

const LDU_STUD = 20;

/**
 * Generic Möller-Trumbore ray-triangle intersection.
 * Ray origin at (o0, o1) in the plane perpendicular to the sweep axis,
 * direction along the sweep axis (+1).
 *
 * Vertex components are indexed by i0, i1 (perpendicular) and iSweep (sweep).
 * Returns the sweep-axis coordinate of intersection, or null.
 */
function rayAxisHit(
  o0: number, o1: number,
  v0: Vec3, v1: Vec3, v2: Vec3,
  i0: number, i1: number, iSweep: number,
): number | null {
  const e1_0 = v1[i0] - v0[i0], e1_1 = v1[i1] - v0[i1], e1_s = v1[iSweep] - v0[iSweep];
  const e2_0 = v2[i0] - v0[i0], e2_1 = v2[i1] - v0[i1], e2_s = v2[iSweep] - v0[iSweep];
  // h = dir × E2, where dir=(0,0,1) in (i0,i1,iSweep) space → h = (-e2_1, e2_0, 0)
  const h0 = -e2_1, h1 = e2_0;
  const a = e1_0 * h0 + e1_1 * h1;
  if (Math.abs(a) < 1e-9) return null;
  const f = 1 / a;
  const s0 = o0 - v0[i0], s1 = o1 - v0[i1], ss = -v0[iSweep];
  const u = f * (s0 * h0 + s1 * h1);
  if (u < 0 || u > 1) return null;
  const q0 = s1 * e1_s - ss * e1_1;
  const q1 = ss * e1_0 - s0 * e1_s;
  const q2 = s0 * e1_1 - s1 * e1_0;
  const v = f * q2;
  if (v < 0 || u + v > 1) return null;
  return f * (e2_0 * q0 + e2_1 * q1 + e2_s * q2);
}

/**
 * Parity-fill ray hits into grid cells along one axis.
 * Writes the filled grid positions into `out` (reused across rays to avoid
 * allocating two arrays per ray).
 */
function parityFill(hits: number[], cellSize: number, out: number[]): void {
  out.length = 0;
  if (hits.length === 0) return;
  hits.sort((a, b) => a - b);

  // Deduplicate near-identical hits (shared triangle edges)
  const dedup: number[] = [hits[0]!];
  for (let i = 1; i < hits.length; i++) {
    if (hits[i]! - dedup[dedup.length - 1]! > 0.1) dedup.push(hits[i]!);
  }

  // Parity fill: pairs [t0,t1], [t2,t3], …
  // Odd count (non-watertight mesh) → fill only the surface cells at each hit
  // point instead of the full [min,max] range (which over-fills thin parts).
  //
  // CELLS ARE CENTRED ON g·c (`Math.round`), deliberately. A half-open lattice
  // (cell g owns [g·c,(g+1)·c)) was tried on 2026-09-08 and REVERTED: it makes
  // a part's cell dimensions exactly right — a 2×4 brick becomes 10×7×20 at
  // cellLDU 4 instead of 11×8×21 — but every LEGO face sits on a multiple of
  // 4 LDU, i.e. exactly on a lattice boundary, so sub-cell relief (wall
  // buttresses, panel recesses, the whole architectural read of 21063) collapses
  // flush into the wall behind it and the surface picks up single-cell noise.
  // Verified in schemat.io: `output/schem-backlog/before-z2.png` (centred, kept)
  // vs `after-z2.png` (half-open, rejected). Centred cells over-cover by half a
  // cell per side, and that conservative bias is what preserves thin features.
  if (dedup.length % 2 !== 0) {
    for (const hit of dedup) out.push(Math.round(hit / cellSize));
    return;
  }
  const pairs = dedup;

  for (let i = 0; i < pairs.length - 1; i += 2) {
    const g0 = Math.round(pairs[i]! / cellSize);
    const g1 = Math.round(pairs[i + 1]! / cellSize);
    for (let g = Math.min(g0, g1); g <= Math.max(g0, g1); g++) {
      out.push(g);
    }
  }
}

/**
 * CSR index of triangles by the 2D lattice of ray origins for one sweep axis.
 * `start[b]…start[b+1]` bounds the triangle indices covering bucket `b`,
 * where `b = (g0 - lo0) * n1 + (g1 - lo1)`.
 */
interface TriBuckets { start: Int32Array; items: Int32Array; n1: number }

function buildTriBuckets(
  nTris: number,
  lo0: number, hi0: number, lo1: number, hi1: number,
  r0Lo: Int32Array, r0Hi: Int32Array, r1Lo: Int32Array, r1Hi: Int32Array,
): TriBuckets {
  const n0 = hi0 - lo0 + 1;
  const n1 = hi1 - lo1 + 1;
  const nb = n0 * n1;
  const start = new Int32Array(nb + 1);
  for (let t = 0; t < nTris; t++) {
    const a0 = r0Lo[t]!, b0 = r0Hi[t]!, a1 = r1Lo[t]!, b1 = r1Hi[t]!;
    for (let g0 = a0; g0 <= b0; g0++) {
      const base = (g0 - lo0) * n1 - lo1 + 1;
      for (let g1 = a1; g1 <= b1; g1++) start[base + g1]++;
    }
  }
  for (let i = 0; i < nb; i++) start[i + 1] += start[i]!;
  const items = new Int32Array(start[nb]!);
  const cursor = start.slice(0, nb);
  for (let t = 0; t < nTris; t++) {
    const a0 = r0Lo[t]!, b0 = r0Hi[t]!, a1 = r1Lo[t]!, b1 = r1Hi[t]!;
    for (let g0 = a0; g0 <= b0; g0++) {
      const base = (g0 - lo0) * n1 - lo1;
      for (let g1 = a1; g1 <= b1; g1++) items[cursor[base + g1]!++] = t;
    }
  }
  return { start, items, n1 };
}

// ─── Rasterization (tri-axis) ────────────────────────────────────────────────

/**
 * Rasterize world-LDU triangles into grid cells using tri-axis ray casting.
 *
 * Casts rays along X, Y, and Z axes independently, then unions the results.
 * This captures geometry that a single-axis sweep would miss (thin plates
 * parallel to the sweep direction, angled panels, etc.).
 *
 * Grid coordinate system:
 *   gx = world_x / LDU_STUD        (LDraw X → grid X)
 *   gy = -world_y / LDU_PER_Y      (LDraw Y-down → grid Y-up)
 *   gz = world_z / LDU_STUD         (LDraw Z → grid Z)
 */
function rasterizeTriangles(
  worldTris: Triangle[],
  LDU_PER_Y: number,
  LDU_PER_XZ: number,
  emit: (gx: number, gy: number, gz: number) => void,
): void {
  if (worldTris.length === 0) return;

  // Full 3D bounding box in world LDU
  let wxMin = Infinity, wxMax = -Infinity;
  let wyMin = Infinity, wyMax = -Infinity;
  let wzMin = Infinity, wzMax = -Infinity;

  for (const [v0, v1, v2] of worldTris) {
    for (const v of [v0, v1, v2]) {
      if (v[0] < wxMin) wxMin = v[0]; if (v[0] > wxMax) wxMax = v[0];
      if (v[1] < wyMin) wyMin = v[1]; if (v[1] > wyMax) wyMax = v[1];
      if (v[2] < wzMin) wzMin = v[2]; if (v[2] > wzMax) wzMax = v[2];
    }
  }

  // Grid ranges
  const gxMin = Math.floor(wxMin / LDU_PER_XZ);
  const gxMax = Math.ceil(wxMax / LDU_PER_XZ);
  const gyMin = Math.floor(-wyMax / LDU_PER_Y);
  const gyMax = Math.ceil(-wyMin / LDU_PER_Y);
  const gzMin = Math.floor(wzMin / LDU_PER_XZ);
  const gzMax = Math.ceil(wzMax / LDU_PER_XZ);

  // Deduplicate cells from all 3 sweep axes.
  // Keys are NUMERIC (offset from the part's own grid AABB, row-major) rather
  // than `${gx},${gy},${gz}` strings — same insertion order, same dedup
  // semantics, but no per-cell string allocation. (S3: string keys dominated
  // the 85 s main-thread stall measured on 21063 at cellLDU 4.)
  // Every emitted coordinate provably lies in [gMin, gMax] (parity hits come
  // from ray/triangle intersections inside the mesh AABB; the surface pass
  // rounds a sub-range of it), but pad by 2 and keep a string overflow set so a
  // float edge case can never alias two cells onto one key.
  const oX = gxMin - 2, oY = gyMin - 2, oZ = gzMin - 2;
  const nX = (gxMax - gxMin) + 5;
  const nY = (gyMax - gyMin) + 5;
  const nZ = (gzMax - gzMin) + 5;
  const cellSet = new Set<number>();
  const overflow = new Set<string>();

  const addCell = (gx: number, gy: number, gz: number) => {
    const dx = gx - oX, dy = gy - oY, dz = gz - oZ;
    if (dx < 0 || dy < 0 || dz < 0 || dx >= nX || dy >= nY || dz >= nZ) {
      overflow.add(`${gx},${gy},${gz}`);
      return;
    }
    cellSet.add((dx * nY + dy) * nZ + dz);
  };

  // ── Per-triangle ray-index ranges (broad phase) ───────────────────────────
  // Möller-Trumbore's u/v test already rejects every ray whose 2D origin falls
  // outside the triangle's projected bounding box, so restricting each ray to
  // the triangles whose box covers it is EXACTLY equivalent — just without the
  // O(rays × triangles) scan that dominated the 60 s stall measured on 21063.
  // Ranges are padded ±1 cell so a float rounding edge can never drop a
  // boundary-touching ray. `hits` are sorted in parityFill, so changing the
  // triangle visit order cannot change the output.
  const nTris = worldTris.length;
  const xLo = new Int32Array(nTris), xHi = new Int32Array(nTris);
  const yLo = new Int32Array(nTris), yHi = new Int32Array(nTris);
  const zLo = new Int32Array(nTris), zHi = new Int32Array(nTris);
  for (let t = 0; t < nTris; t++) {
    const [v0, v1, v2] = worldTris[t]!;
    const txMin = Math.min(v0[0], v1[0], v2[0]), txMax = Math.max(v0[0], v1[0], v2[0]);
    const tyMin = Math.min(v0[1], v1[1], v2[1]), tyMax = Math.max(v0[1], v1[1], v2[1]);
    const tzMin = Math.min(v0[2], v1[2], v2[2]), tzMax = Math.max(v0[2], v1[2], v2[2]);
    xLo[t] = Math.max(gxMin, Math.ceil(txMin / LDU_PER_XZ - 0.5) - 1);
    xHi[t] = Math.min(gxMax, Math.floor(txMax / LDU_PER_XZ - 0.5) + 1);
    yLo[t] = Math.max(gyMin, Math.ceil(-tyMax / LDU_PER_Y - 0.5) - 1);
    yHi[t] = Math.min(gyMax, Math.floor(-tyMin / LDU_PER_Y - 0.5) + 1);
    zLo[t] = Math.max(gzMin, Math.ceil(tzMin / LDU_PER_XZ - 0.5) - 1);
    zHi[t] = Math.min(gzMax, Math.floor(tzMax / LDU_PER_XZ - 0.5) + 1);
  }

  // Bucketing only pays for itself on non-trivial meshes.
  const BUCKET_MIN_TRIS = 24;
  const useBuckets = nTris >= BUCKET_MIN_TRIS;

  const hits: number[] = [];
  const filled: number[] = [];

  // ── Sweep along Z (rays in XY plane, casting +Z) ──────────────────────────
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gxMin, gxMax, gyMin, gyMax, xLo, xHi, yLo, yHi) : null;
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gy = gyMin; gy <= gyMax; gy++) {
        const ox = (gx + 0.5) * LDU_PER_XZ;
        const oy = -(gy + 0.5) * LDU_PER_Y;
        hits.length = 0;
        if (bk) {
          const b = (gx - gxMin) * bk.n1 + (gy - gyMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(ox, oy, v0, v1, v2, 0, 1, 2);
            if (t !== null) hits.push(t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(ox, oy, v0, v1, v2, 0, 1, 2);
            if (t !== null) hits.push(t);
          }
        }
        parityFill(hits, LDU_PER_XZ, filled);
        for (const gz of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Sweep along X (rays in YZ plane, casting +X) ──────────────────────────
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gyMin, gyMax, gzMin, gzMax, yLo, yHi, zLo, zHi) : null;
    for (let gy = gyMin; gy <= gyMax; gy++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const oy = -(gy + 0.5) * LDU_PER_Y;
        const oz = (gz + 0.5) * LDU_PER_XZ;
        hits.length = 0;
        if (bk) {
          const b = (gy - gyMin) * bk.n1 + (gz - gzMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(oy, oz, v0, v1, v2, 1, 2, 0);
            if (t !== null) hits.push(t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(oy, oz, v0, v1, v2, 1, 2, 0);
            if (t !== null) hits.push(t);
          }
        }
        parityFill(hits, LDU_PER_XZ, filled);
        for (const gx of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Sweep along Y (rays in XZ plane, casting -Y in LDraw = +Y in grid) ───
  {
    const bk = useBuckets ? buildTriBuckets(nTris, gxMin, gxMax, gzMin, gzMax, xLo, xHi, zLo, zHi) : null;
    for (let gx = gxMin; gx <= gxMax; gx++) {
      for (let gz = gzMin; gz <= gzMax; gz++) {
        const ox = (gx + 0.5) * LDU_PER_XZ;
        const oz = (gz + 0.5) * LDU_PER_XZ;
        hits.length = 0;
        if (bk) {
          const b = (gx - gxMin) * bk.n1 + (gz - gzMin);
          for (let k = bk.start[b]!; k < bk.start[b + 1]!; k++) {
            const [v0, v1, v2] = worldTris[bk.items[k]!]!;
            const t = rayAxisHit(ox, oz, v0, v1, v2, 0, 2, 1);
            if (t !== null) hits.push(-t);
          }
        } else {
          for (const [v0, v1, v2] of worldTris) {
            const t = rayAxisHit(ox, oz, v0, v1, v2, 0, 2, 1);
            if (t !== null) hits.push(-t);
          }
        }
        parityFill(hits, LDU_PER_Y, filled);
        for (const gy of filled) addCell(gx, gy, gz);
      }
    }
  }

  // ── Surface pass: mark every cell any triangle surface touches ────────────
  // This fills each triangle's 3D bounding BOX, which over-covers a slanted
  // triangle. That over-coverage is DELIBERATE and was re-verified 2026-09-08:
  // replacing it with an exact triangle/cell overlap test (Akenine-Möller SAT)
  // is geometrically correct and visually WORSE — sub-cell relief (wall
  // buttresses, arch recesses) collapses flush into the surface behind it and
  // the remaining shell speckles, because a curved part becomes a one-cell skin
  // whose neighbours win half the boundary cells. Measured on 21063: 1,190,999
  // -> 1,049,085 cells, and see output/schem-backlog/before-z2.png (kept) vs
  // sat-z2.png (exact, rejected). Do not "fix" this without a visual A/B.
  for (const [v0, v1, v2] of worldTris) {
    const txMin = Math.min(v0[0], v1[0], v2[0]);
    const txMax = Math.max(v0[0], v1[0], v2[0]);
    const tyMin = Math.min(v0[1], v1[1], v2[1]);
    const tyMax = Math.max(v0[1], v1[1], v2[1]);
    const tzMin = Math.min(v0[2], v1[2], v2[2]);
    const tzMax = Math.max(v0[2], v1[2], v2[2]);

    const tgxMin = Math.round(txMin / LDU_PER_XZ);
    const tgxMax = Math.round(txMax / LDU_PER_XZ);
    const tgyMin = Math.round(-tyMax / LDU_PER_Y);
    const tgyMax = Math.round(-tyMin / LDU_PER_Y);
    const tgzMin = Math.round(tzMin / LDU_PER_XZ);
    const tgzMax = Math.round(tzMax / LDU_PER_XZ);

    for (let x = tgxMin; x <= tgxMax; x++)
      for (let y = tgyMin; y <= tgyMax; y++)
        for (let z = tgzMin; z <= tgzMax; z++)
          addCell(x, y, z);
  }

  // Emit the deduplicated cells
  for (const key of cellSet) {
    const dz = key % nZ;
    const rest = (key - dz) / nZ;
    const dy = rest % nY;
    const dx = (rest - dy) / nY;
    emit(dx + oX, dy + oY, dz + oZ);
  }
  for (const key of overflow) {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    emit(x, y, z);
  }
}

/**
 * Diagnostic hook: the exact grid cells ONE brick rasterizes to, in absolute
 * (un-offset) grid coordinates, using the real rasterizer. Lets a probe compare
 * two parts' voxel footprints without running a whole export.
 */
export async function __debugCells(
  brick: { part: string; x: number; y: number; z: number; rot?: number[] },
  cellLDU: number,
): Promise<Array<[number, number, number]>> {
  const worldTris = await __debugWorldTris(brick);
  const out: Array<[number, number, number]> = [];
  rasterizeTriangles(worldTris, cellLDU, cellLDU, (gx, gy, gz) => out.push([gx, gy, gz]));
  return out;
}

// ─── Cell store ──────────────────────────────────────────────────────────────

/**
 * Chunked typed-array store for emitted voxel cells.
 *
 * WHY (S3): the accumulator used to be `Array<{gx,gy,gz,block,color}>` — 1.60M
 * objects ≈ 98 MB measured on 21063 at cellLDU 4, and linear in cell count, so
 * a 30M-cell export allocated hundreds of MB of short-lived objects. Parallel
 * Int32/Uint16 chunks store the same information in 14 bytes per cell with no
 * per-cell object header and no re-copy on growth. Block strings are interned
 * into `blocks` (colour is accumulated per-brick, never per-cell).
 */
const CELL_CHUNK = 1 << 20;

class CellStore {
  private xs: Int32Array[] = [];
  private ys: Int32Array[] = [];
  private zs: Int32Array[] = [];
  private bs: Uint16Array[] = [];
  private fill = CELL_CHUNK; // force a new chunk on first push
  count = 0;
  readonly blocks: string[] = [];
  private blockIdx = new Map<string, number>();

  /** Intern a block-state string; returns its index for push(). */
  blockId(block: string): number {
    let i = this.blockIdx.get(block);
    if (i === undefined) {
      i = this.blocks.length;
      if (i > 65535) throw new Error('CellStore: more than 65536 distinct block states');
      this.blocks.push(block);
      this.blockIdx.set(block, i);
    }
    return i;
  }

  push(gx: number, gy: number, gz: number, blockId: number): void {
    if (this.fill === CELL_CHUNK) {
      this.xs.push(new Int32Array(CELL_CHUNK));
      this.ys.push(new Int32Array(CELL_CHUNK));
      this.zs.push(new Int32Array(CELL_CHUNK));
      this.bs.push(new Uint16Array(CELL_CHUNK));
      this.fill = 0;
    }
    const c = this.xs.length - 1;
    this.xs[c]![this.fill] = gx;
    this.ys[c]![this.fill] = gy;
    this.zs[c]![this.fill] = gz;
    this.bs[c]![this.fill] = blockId;
    this.fill++;
    this.count++;
  }

  /** Iterate the cells pushed in `[start, end)` of the push sequence. */
  forRange(start: number, end: number, fn: (gx: number, gy: number, gz: number) => void): void {
    for (let i = start; i < end; i++) {
      const c = (i / CELL_CHUNK) | 0;
      const j = i % CELL_CHUNK;
      fn(this.xs[c]![j]!, this.ys[c]![j]!, this.zs[c]![j]!);
    }
  }

  /** Iterate every stored cell. */
  forEach(fn: (gx: number, gy: number, gz: number, blockId: number) => void): void {
    for (let c = 0; c < this.xs.length; c++) {
      const n = c === this.xs.length - 1 ? this.fill : CELL_CHUNK;
      const X = this.xs[c]!, Y = this.ys[c]!, Z = this.zs[c]!, B = this.bs[c]!;
      for (let i = 0; i < n; i++) fn(X[i]!, Y[i]!, Z[i]!, B[i]!);
    }
  }
}

// ─── Inter-part contact ("floating hair") pass ───────────────────────────────

/** Dev/CLI switch: `globalThis.__voxProfile = true` turns on measurement logs. */
const VOX_PROFILE = (): boolean => (globalThis as { __voxProfile?: boolean }).__voxProfile === true;

/**
 * World-LDU extent + cell range of one brick's contribution to the cell store.
 * `start`/`end` index the store's push sequence.
 */
interface BrickFootprint {
  /** Part id, for diagnostics only. */
  part: string;
  start: number; end: number; blockId: number;
  xn: number; xx: number; yn: number; yx: number; zn: number; zx: number;
  /** Stair code for the block-shape pass (0 = this brick is not a placed slope). */
  stair?: number;
  /** Semantic element kind (0 = this part maps to no Minecraft element). */
  element?: ElementKind;
}

/** What the contact pass did — surfaced for status/tests, never for control flow. */
export interface BridgeStats {
  /** Part pairs whose real LDraw geometry is within one cell of each other. */
  nearPairs: number;
  /** Of those, the pairs whose voxels shared no face and were reconnected. */
  bridgedPairs: number;
  /** Cells the pass added. */
  cellsAdded: number;
}

/**
 * Reach, in cells, of the bridge search. 2 = "at most one empty cell between",
 * which covers a diagonal touch (Chebyshev 1, Manhattan 2-3) and one missing
 * cell. Anything further apart is left alone.
 */
const BRIDGE_REACH = 2;
/** Never add more than this many cells for a single pair. */
const BRIDGE_PAIR_CELL_CAP = 512;
/** Parts with more cells than this are structural (baseplates, hulls) — skipped as the pair SOURCE. */
const BRIDGE_MAX_OWN_CELLS = 200_000;

/**
 * Per-axis separation between two world-LDU AABBs.
 * ≤0 when they overlap; otherwise the width of the real air gap between them.
 */
function aabbSeparation(a: BrickFootprint, b: BrickFootprint): number {
  return Math.max(
    a.xn - b.xx, b.xn - a.xx,
    a.yn - b.yx, b.yn - a.yx,
    a.zn - b.zx, b.zn - a.zx,
  );
}

/**
 * Reconnect parts that quantization left touching only at a corner.
 *
 * WHY (2026-09-08, the "minifig hair floats above the head" report). Measured
 * with `scripts/_hair_probe.ts` on 76416-1: LDraw authors a hairpiece so its
 * socket clears the head stud — 62810's underside sits 1.81 LDU above the
 * head's crown, 25972's 0.26 LDU. That clearance is a fraction of a 4-LDU cell,
 * but it lands the hair's shell one row ABOVE and one column OUTSIDE the head's
 * top row, so the two footprints meet only DIAGONALLY (minimum Chebyshev
 * distance 1, no shared face). A diagonal touch reads as a floating hat, and
 * nothing closed it: `fillSingleVoxelGaps` fills X and Z runs flanked on both
 * sides and has no vertical pass at all, so a diagonal step is invisible to it.
 *
 * The pass is PAIRWISE and driven by real LDU adjacency, never by dilation:
 *   • only pairs whose world-LDU AABBs are within `clearLDU` (one cell) of each
 *     other are considered — parts that genuinely touch or nearly touch;
 *   • a pair is skipped the moment its two footprints share any FACE;
 *   • otherwise the shortest monotone path (≤ BRIDGE_REACH-1 cells) between the
 *     two nearest cells is filled, in the colour of the upper part.
 * Two minifigs standing a stud apart are 20 LDU and 5 cells apart, so no pair
 * is ever formed; a deliberate 1-plate (8 LDU) air gap is likewise out of reach.
 *
 * Pairwise matters: the hair above IS voxel-connected to the neck bracket it
 * clips into, so a "part has no contact anywhere" rule (tried first) left the
 * visible head-to-hair gap wide open.
 */
function bridgePartContacts(
  cells: CellStore,
  parts: BrickFootprint[],
  cellLDU_Y: number,
  cellLDU_XZ: number,
): BridgeStats {
  const stats: BridgeStats = { nearPairs: 0, bridgedPairs: 0, cellsAdded: 0 };
  if (parts.length < 2 || cells.count === 0) return stats;

  // ── Occupancy bitset over the cell AABB (padded by the search reach) ───────
  let xn = Infinity, xx = -Infinity, yn = Infinity, yx = -Infinity, zn = Infinity, zx = -Infinity;
  cells.forEach((gx, gy, gz) => {
    if (gx < xn) xn = gx; if (gx > xx) xx = gx;
    if (gy < yn) yn = gy; if (gy > yx) yx = gy;
    if (gz < zn) zn = gz; if (gz > zx) zx = gz;
  });
  const oX = xn - BRIDGE_REACH, oY = yn - BRIDGE_REACH, oZ = zn - BRIDGE_REACH;
  const nX = xx - xn + 1 + 2 * BRIDGE_REACH;
  const nY = yx - yn + 1 + 2 * BRIDGE_REACH;
  const nZ = zx - zn + 1 + 2 * BRIDGE_REACH;
  const total = nX * nY * nZ;
  // 1 bit per cell — ≈4 MB at the export's 30M-cell ceiling.
  if (!Number.isFinite(total) || total <= 0 || total > 400_000_000) return stats;
  const occ = new Uint8Array(Math.ceil(total / 8));
  const lin = (gx: number, gy: number, gz: number) => ((gx - oX) * nY + (gy - oY)) * nZ + (gz - oZ);
  const setBit = (i: number) => { occ[i >>> 3]! |= 1 << (i & 7); };
  cells.forEach((gx, gy, gz) => setBit(lin(gx, gy, gz)));

  // ── Broadphase over part AABBs, bucketed in LDU ───────────────────────────
  // A pair is eligible when its real air gap is smaller than HALF a cell — the
  // grid cannot represent such a gap, so leaving it open is pure quantization
  // error. A gap of a whole cell or more IS representable (and usually real:
  // measured 4.00 LDU between stacked plates on 76416-1), so it stays open.
  const clearLDU = Math.max(cellLDU_Y, cellLDU_XZ) / 2;
  /** Window padding — the search reach, not the eligibility threshold. */
  const windowPadLDU = Math.max(cellLDU_Y, cellLDU_XZ) * BRIDGE_REACH;
  const BUCKET = 160; // 8 studs
  const buckets = new Map<string, number[]>();
  const bkey = (i: number, j: number, k: number) => `${i},${j},${k}`;
  for (let p = 0; p < parts.length; p++) {
    const f = parts[p]!;
    for (let i = Math.floor(f.xn / BUCKET); i <= Math.floor(f.xx / BUCKET); i++)
      for (let j = Math.floor(f.yn / BUCKET); j <= Math.floor(f.yx / BUCKET); j++)
        for (let k = Math.floor(f.zn / BUCKET); k <= Math.floor(f.zx / BUCKET); k++) {
          const key = bkey(i, j, k);
          const arr = buckets.get(key);
          if (arr) arr.push(p); else buckets.set(key, [p]);
        }
  }

  // Offsets within the search reach, ordered by Manhattan distance so the first
  // hit is always the shortest possible bridge.
  const reachOffsets: Array<[number, number, number, number]> = [];
  for (let dx = -BRIDGE_REACH; dx <= BRIDGE_REACH; dx++)
    for (let dy = -BRIDGE_REACH; dy <= BRIDGE_REACH; dy++)
      for (let dz = -BRIDGE_REACH; dz <= BRIDGE_REACH; dz++) {
        const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (m >= 2) reachOffsets.push([dx, dy, dz, m]);
      }
  reachOffsets.sort((a, b) => a[3] - b[3] || a[1] - b[1] || a[0] - b[0] || a[2] - b[2]);
  const FACE: ReadonlyArray<readonly [number, number, number]> =
    [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  const ownCells: number[] = [];   // flat triples for the source part
  for (let p = 0; p < parts.length; p++) {
    const f = parts[p]!;
    const n = f.end - f.start;
    if (n <= 0 || n > BRIDGE_MAX_OWN_CELLS) continue;

    // Partners: parts whose real geometry is within one cell of this one.
    const partners: number[] = [];
    const seen = new Set<number>();
    for (let i = Math.floor((f.xn - clearLDU) / BUCKET); i <= Math.floor((f.xx + clearLDU) / BUCKET); i++)
      for (let j = Math.floor((f.yn - clearLDU) / BUCKET); j <= Math.floor((f.yx + clearLDU) / BUCKET); j++)
        for (let k = Math.floor((f.zn - clearLDU) / BUCKET); k <= Math.floor((f.zx + clearLDU) / BUCKET); k++)
          for (const q of buckets.get(bkey(i, j, k)) ?? []) {
            if (q <= p || seen.has(q)) continue;   // each unordered pair once
            seen.add(q);
            if (aabbSeparation(f, parts[q]!) <= clearLDU) partners.push(q);
          }
    if (partners.length === 0) continue;
    partners.sort((a, b) => a - b);               // determinism

    ownCells.length = 0;
    const own = new Set<number>();
    cells.forRange(f.start, f.end, (gx, gy, gz) => {
      ownCells.push(gx, gy, gz);
      own.add(lin(gx, gy, gz));
    });

    for (const q of partners) {
      const g = parts[q]!;
      if (g.end - g.start <= 0) continue;
      stats.nearPairs++;

      // Cell window where the two parts could possibly meet.
      const wxn = Math.max(f.xn, g.xn) - windowPadLDU, wxx = Math.min(f.xx, g.xx) + windowPadLDU;
      const wyn = Math.max(f.yn, g.yn) - windowPadLDU, wyx = Math.min(f.yx, g.yx) + windowPadLDU;
      const wzn = Math.max(f.zn, g.zn) - windowPadLDU, wzx = Math.min(f.zx, g.zx) + windowPadLDU;
      const bxLo = Math.floor(wxn / cellLDU_XZ) - 1, bxHi = Math.ceil(wxx / cellLDU_XZ) + 1;
      const byLo = Math.floor(-wyx / cellLDU_Y) - 1, byHi = Math.ceil(-wyn / cellLDU_Y) + 1;
      const bzLo = Math.floor(wzn / cellLDU_XZ) - 1, bzHi = Math.ceil(wzx / cellLDU_XZ) + 1;

      // Partner cells inside that window; bail out the moment a face is shared.
      const window: number[] = [];
      let touching = false;
      cells.forRange(g.start, g.end, (gx, gy, gz) => {
        if (touching) return;
        if (gx < bxLo || gx > bxHi || gy < byLo || gy > byHi || gz < bzLo || gz > bzHi) return;
        for (const [dx, dy, dz] of FACE) {
          if (own.has(lin(gx + dx, gy + dy, gz + dz))) { touching = true; return; }
        }
        window.push(gx, gy, gz);
      });
      if (touching || window.length === 0) continue;

      // Weld the whole interface: every partner cell in the window takes its
      // OWN shortest path to the nearest cell of the other part. Welding only
      // ever runs on a pair that shares no face at all, so a pair that already
      // meets somewhere is never thickened — and a single bridge cell would
      // leave the rest of the seam (a hairpiece's whole brim) still hovering.
      let added = 0;
      for (let w = 0; w < window.length && added < BRIDGE_PAIR_CELL_CAP; w += 3) {
        const sx = window[w]!, sy = window[w + 1]!, sz = window[w + 2]!;
        for (const [dx, dy, dz] of reachOffsets) {
          const tx = sx + dx, ty = sy + dy, tz = sz + dz;
          if (!own.has(lin(tx, ty, tz))) continue;
          // Colour the bridge like the UPPER part (a hairpiece meeting a head
          // should read as hair), stepping vertically first.
          const upperBlock = sy >= ty ? g.blockId : f.blockId;
          let cx = sx, cy = sy, cz = sz;
          const step = (axis: 0 | 1 | 2, delta: number) => {
            const s = Math.sign(delta);
            for (let k = 0; k < Math.abs(delta); k++) {
              if (axis === 0) cx += s; else if (axis === 1) cy += s; else cz += s;
              if (cx === tx && cy === ty && cz === tz) return;
              const ci = lin(cx, cy, cz);
              if ((occ[ci >>> 3]! & (1 << (ci & 7))) !== 0) continue;
              setBit(ci);
              cells.push(cx, cy, cz, upperBlock);
              added++; stats.cellsAdded++;
            }
          };
          step(1, dy); step(0, dx); step(2, dz);
          break;                                   // shortest path for this cell
        }
      }
      if (added > 0) {
        stats.bridgedPairs++;
        if (VOX_PROFILE()) console.log(`[bridge] ${f.part} ↔ ${g.part}: +${added} cells (sep ${aabbSeparation(f, g).toFixed(2)} LDU)`);
      }
    }
  }

  return stats;
}

// ─── Public: geometry-accurate voxelization ──────────────────────────────────

const MAX_DIM_GEO = 384;

/** Progress sink for long voxelizations (worker → UI banner). */
export type VoxelProgress = (phase: string, pct?: number) => void;

/**
 * Geometry-accurate async replacement for voxelizeLDraw().
 *
 * Fetches real .dat triangle data for each unique part, rasterizes it to voxels,
 * and returns the same VoxelizeResult interface as voxelizeLDraw().
 *
 * Parts with no geometry available (file not found) are skipped and counted
 * in `fallbackPartCount`. In production where /ldraw-parts is unavailable,
 * all parts will be skipped — use regular voxelizeLDraw() instead.
 */
export async function voxelizeLDrawGeometry(
  bricks: ParsedBrick[],
  colorFn?: (id: number) => string,
  options?: VoxelizeOptions,
  onProgress?: VoxelProgress,
): Promise<VoxelizeResult> {
  if (bricks.length === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return { grid, brickCount: 0, uniqueColors: 0, dimensions: { w: 1, h: 1, l: 1 }, unmappedColors: [], fallbackPartCount: 0 };
  }

  const resolveColor = colorFn ?? ldrawColorToBlock;
  const isDefaultFn  = colorFn == null;
  const unmappedColorSet = new Set<number>();
  const detail = options?.detailScale === true;
  const cell = options?.cellLDU;
  const LDU_PER_Y = cell ?? (detail ? 8 : (options?.cubicScale ? LDU_STUD : 8));
  const LDU_XZ = cell ?? (detail ? 8 : LDU_STUD);

  // Auto-flip disabled: LDraw convention is Y-down, and our grid conversion
  // (gy = -wy / LDU_PER_Y) already handles the inversion. Flipping was
  // incorrectly inverting models with all-negative Y (standard LDraw orientation).
  const shouldFlip = false;
  const maxStep = options?.maxStep;

  const effectiveBricks = (shouldFlip || maxStep != null)
    ? bricks
        .filter(b => maxStep == null || (b.step ?? 1) <= maxStep)
        .map(b => shouldFlip ? { ...b, y: -b.y } : b)
    : bricks;

  // Prefetch all unique part geometries in parallel
  const uniqueParts = [...new Set(
    effectiveBricks.map(b => b.part).filter(p => !isLDrawPrimitive(p)),
  )];
  await prefetchPartGeometry(uniqueParts, onProgress);

  const IDENTITY = [1,0,0, 0,1,0, 0,0,1];

  const cells = new CellStore();
  const colors = new Set<number>();
  let fallbackPartCount = 0;
  // Per-brick cell range + world-LDU extent, for the inter-part contact pass
  // AND the block-shape pass (which needs each part's real vertical extent to
  // tell a half-occupied cell from a full one).
  const footprints: BrickFootprint[] = [];
  const bridgeEnabled = options?.bridgeParts !== false;
  const shapesEnabled = options?.shapes === true;
  const trackFootprints = bridgeEnabled || shapesEnabled;

  let brickIdx = 0;
  let lastPct = -1;
  for (const brick of effectiveBricks) {
    if (onProgress) {
      const pct = Math.floor((brickIdx / effectiveBricks.length) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress('voxelizing', pct); }
    }
    brickIdx++;
    if (isLDrawPrimitive(brick.part)) continue;
    // Skip Technic structural parts (pins, axles, bushes) — same as bbox voxelizer
    const barePartId = brick.part.replace(/\.dat$/i, '').toLowerCase().replace(/^.*[/\\]/, '');
    if (TECHNIC_INTERNAL_PARTS.has(barePartId)) continue;

    const block = resolveColor(brick.color);
    const blockId = cells.blockId(block);
    if (isDefaultFn && !(brick.color in LDRAW_COLOR_TO_BLOCK)) {
      unmappedColorSet.add(brick.color);
    }

    const localTris = partGeomCache.get(normId(brick.part));
    const R = brick.rot ?? IDENTITY;

    if (!localTris || localTris.length === 0) {
      // Fallback: use AABB dims fill (same as bbox voxelizer)
      fallbackPartCount++;
      const [sW, sH, sL] = getPartDims(brick.part);
      const lxHalf = (sW - 1) / 2 * LDU_STUD;
      const lzHalf = (sL - 1) / 2 * LDU_STUD;
      const lyBot = (sH - 1) * 8;
      let bxMin = Infinity, bxMax = -Infinity;
      let byMin = Infinity, byMax = -Infinity;
      let bzMin = Infinity, bzMax = -Infinity;
      for (const lx of [-lxHalf, lxHalf]) {
        for (const ly of [0, lyBot]) {
          for (const lz of [-lzHalf, lzHalf]) {
            const wx = R[0]! * lx + R[1]! * ly + R[2]! * lz + brick.x;
            const wy = R[3]! * lx + R[4]! * ly + R[5]! * lz + brick.y;
            const wz = R[6]! * lx + R[7]! * ly + R[8]! * lz + brick.z;
            if (wx < bxMin) bxMin = wx; if (wx > bxMax) bxMax = wx;
            if (wy < byMin) byMin = wy; if (wy > byMax) byMax = wy;
            if (wz < bzMin) bzMin = wz; if (wz > bzMax) bzMax = wz;
          }
        }
      }
      const fbxMin = Math.round(bxMin / LDU_XZ), fbxMax = Math.round(bxMax / LDU_XZ);
      const fbyMin = Math.round(-byMax / LDU_PER_Y), fbyMax = Math.round(-byMin / LDU_PER_Y);
      const fbzMin = Math.round(bzMin / LDU_XZ), fbzMax = Math.round(bzMax / LDU_XZ);
      const fbStart = cells.count;
      for (let x = fbxMin; x <= fbxMax; x++)
        for (let y = fbyMin; y <= fbyMax; y++)
          for (let z = fbzMin; z <= fbzMax; z++) {
            cells.push(x, y, z, blockId);
            colors.add(brick.color);
          }
      if (trackFootprints && cells.count > fbStart) {
        footprints.push({
          part: brick.part, start: fbStart, end: cells.count, blockId,
          xn: bxMin, xx: bxMax, yn: byMin, yx: byMax, zn: bzMin, zx: bzMax,
        });
      }
      continue;
    }
    const T: Vec3 = [brick.x, brick.y, brick.z];

    // Transform local triangles → world LDU (tracking the extent for the
    // inter-part contact pass, which needs REAL LDU adjacency, not cell hits).
    let wxn = Infinity, wxx = -Infinity, wyn = Infinity, wyx = -Infinity, wzn = Infinity, wzx = -Infinity;
    const worldTris: Triangle[] = localTris.map(([v0, v1, v2]) => {
      const a = applyMat(v0, R, T), b = applyMat(v1, R, T), c = applyMat(v2, R, T);
      for (const v of [a, b, c]) {
        if (v[0] < wxn) wxn = v[0]; if (v[0] > wxx) wxx = v[0];
        if (v[1] < wyn) wyn = v[1]; if (v[1] > wyx) wyx = v[1];
        if (v[2] < wzn) wzn = v[2]; if (v[2] > wzx) wzx = v[2];
      }
      return [a, b, c];
    });

    const geoStart = cells.count;
    let emitted = false;
    rasterizeTriangles(worldTris, LDU_PER_Y, LDU_XZ, (gx, gy, gz) => {
      cells.push(gx, gy, gz, blockId);
      emitted = true;
    });
    if (emitted) {
      colors.add(brick.color);
      if (trackFootprints) {
        footprints.push({
          part: brick.part, start: geoStart, end: cells.count, blockId,
          xn: wxn, xx: wxx, yn: wyn, yx: wyx, zn: wzn, zx: wzx,
          stair: shapesEnabled ? stairCodeFor(brick.part, localTris, R) : 0,
          element: shapesEnabled ? elementKindFor(brick.part) : ELEMENT_NONE,
        });
      }
    }
  }

  // Close sub-cell gaps that quantization opened between parts that really do
  // meet (the "minifig hair floats above the head" class). See bridgePartContacts.
  let bridge: BridgeStats | undefined;
  if (bridgeEnabled && footprints.length > 1) {
    onProgress?.('joining parts');
    bridge = bridgePartContacts(cells, footprints, LDU_PER_Y, LDU_XZ);
  }

  if ((globalThis as { __voxProfile?: boolean }).__voxProfile) {
    console.log(`[profile] cells=${cells.count.toLocaleString()} ≈ ${(cells.count * 14 / 1048576).toFixed(1)} MB (typed chunks)`);
  }
  if (cells.count === 0) {
    const grid = new BlockGrid(1, 1, 1);
    return {
      grid, brickCount: bricks.length, uniqueColors: 0,
      dimensions: { w: 1, h: 1, l: 1 },
      unmappedColors: [...unmappedColorSet], wasFlipped: shouldFlip, fallbackPartCount,
    };
  }

  // Compute bounds
  onProgress?.('measuring bounds');
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  cells.forEach((gx, gy, gz) => {
    if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
    if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
    if (gz < minZ) minZ = gz; if (gz > maxZ) maxZ = gz;
  });

  let w = maxX - minX + 1;
  let h = maxY - minY + 1;
  let l = maxZ - minZ + 1;
  let scale = 1;
  let warning: string | undefined;

  const dimCap = options?.maxDim ?? MAX_DIM_GEO;
  const maxDim = Math.max(w, h, l);
  if (maxDim > dimCap) {
    scale = dimCap / maxDim;
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
    l = Math.max(1, Math.round(l * scale));
    warning = `Model scaled down ${(1 / scale).toFixed(1)}× to fit limits (max dim ${dimCap})`;
  }

  onProgress?.('building grid');
  const grid = new BlockGrid(w, h, l);
  // Pre-intern the block palette in first-use order (identical to the old
  // per-cell grid.set(string) path, which assigned ids in the same order).
  const paletteIds = cells.blocks.map(b => grid.paletteIndexOf(b));

  cells.forEach((gx, gy, gz, blockId) => {
    const x = Math.max(0, Math.min(w - 1, Math.round((gx - minX) * scale)));
    const y = Math.max(0, Math.min(h - 1, Math.round((gy - minY) * scale)));
    const z = Math.max(0, Math.min(l - 1, Math.round((gz - minZ) * scale)));
    grid.setIndex(x, y, z, paletteIds[blockId]!);
  });

  // Per-cell vertical occupancy for the block-shape pass. Built from each
  // part's REAL world-Y extent clamped to each of its cells, which is exactly
  // right at a part's top/bottom boundary cells (the only place a cell can be
  // half-occupied) and conservatively "full" everywhere in between — a part
  // that doesn't fill its own Y extent at some XZ never emitted a cell there.
  const shapeHints = shapesEnabled ? buildShapeHints(
    cells, footprints, w, h, l, minX, minY, minZ, scale, LDU_PER_Y,
  ) : undefined;
  if (shapesEnabled) { slopeCache.clear(); elementCache.clear(); }

  if (fallbackPartCount > 0) {
    console.warn(`[geometry] ${fallbackPartCount} parts had no .dat geometry — skipped`);
  }

  return {
    grid,
    brickCount: bricks.length,
    uniqueColors: colors.size,
    dimensions: { w, h, l },
    warning,
    unmappedColors: [...unmappedColorSet],
    wasFlipped: shouldFlip,
    fallbackPartCount,
    bridge,
    shapeHints,
  };
}

/**
 * Union every part's clamped vertical extent into per-cell occupancy hints.
 *
 * Cell `gy` covers world y in `[-(gy+0.5)·c, -(gy-0.5)·c]` (LDraw Y is down and
 * cells are CENTRED on multiples of the cell size — see parityFill). In grid-up
 * terms `u(wy) = -wy/c - gy + 0.5`, so 0 is the cell's bottom face and 1 its
 * top. A part contributes `[u(yx), u(yn)]` clamped to `[0,1]`, identical for
 * every cell it emitted in the same grid row — computed once per (part, row).
 *
 * Skipped when the grid was downscaled (`scale < 1` merges cells, so a cell's
 * occupancy is no longer one part's clamped extent).
 */
function buildShapeHints(
  cells: CellStore,
  parts: BrickFootprint[],
  w: number, h: number, l: number,
  minX: number, minY: number, minZ: number,
  scale: number,
  cellLDU_Y: number,
): ShapeHints | undefined {
  if (scale !== 1) return undefined;
  const total = w * h * l;
  // 2-3 bytes per grid cell: 90 MB at the export's 30M-cell ceiling.
  if (!Number.isFinite(total) || total <= 0 || total > 60_000_000) return undefined;
  const anyStairs = parts.some(f => (f.stair ?? 0) > 0);
  // A part only earns an element when the swap is size-comparable — a Minecraft
  // pane/fence/bar is one cell, so a part spanning half a wall is not a
  // candidate however well its description matches. See MAX_ELEMENT_CELLS.
  const anyElements = parts.some(f => (f.element ?? 0) > 0 && f.end - f.start <= MAX_ELEMENT_CELLS);
  const hints = createShapeHints(w, h, l, anyStairs, anyElements);
  const lo = new Map<number, number>();   // grid row → uLo for this part
  const hi = new Map<number, number>();
  for (const f of parts) {
    if (f.end <= f.start) continue;
    lo.clear(); hi.clear();
    const stair = f.stair ?? 0;
    const element = (f.element ?? 0) > 0 && f.end - f.start <= MAX_ELEMENT_CELLS ? f.element! : 0;
    cells.forRange(f.start, f.end, (gx, gy, gz) => {
      const x = gx - minX, y = gy - minY, z = gz - minZ;
      if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= l) return;
      let a = lo.get(gy);
      if (a === undefined) {
        // yx = the part's LOWEST point (largest LDraw y) → smallest u.
        a = clamp01(-f.yx / cellLDU_Y - gy + 0.5);
        lo.set(gy, a);
        hi.set(gy, clamp01(-f.yn / cellLDU_Y - gy + 0.5));
      }
      addOccupancy(hints, x, y, z, a, hi.get(gy)!);
      if (stair > 0) addStairRequest(hints, x, y, z, stair);
      if (element > 0) addElementRequest(hints, x, y, z, element);
    });
  }
  return hints;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Slope analysis per part id — `null` for "checked, not a usable slope".
 * Cleared at the end of every voxelization: a seeded/replaced `.dat` text can
 * change a part's geometry within one session (see seedDatTexts).
 */
const slopeCache = new Map<string, SlopeAnalysis | null>();

/**
 * The stair code for one placed brick, or 0 when the part is not a slope (or is
 * placed at an angle a stair cannot represent).
 *
 * Membership comes from the LDraw library's OWN description line — the first
 * line of the `.dat`, already in `datTextCache` — and orientation from the
 * part's real triangles. Neither is guessed; see `isSlopeDescription` for why a
 * hand-written part-id list was rejected.
 */
function stairCodeFor(part: string, localTris: Triangle[], rot: readonly number[]): number {
  const key = normId(part);
  let slope = slopeCache.get(key);
  if (slope === undefined) {
    slope = isSlopeDescription(headerOf(key)) ? analyzeSlope(localTris) : null;
    slopeCache.set(key, slope);
  }
  return slope ? stairCodeForPlacement(slope, rot) : 0;
}

/** The `.dat`'s first line — the LDraw library's own description of the part. */
function headerOf(key: string): string {
  const text = datTextCache.get(key);
  return text ? text.slice(0, text.indexOf('\n') + 1 || undefined) : '';
}

/** Semantic-element kind per part id, cached alongside the slope analysis. */
const elementCache = new Map<string, ElementKind>();

/**
 * Which Minecraft element (if any) a part maps to — description-driven, exactly
 * like the slope test above. See engine/part-elements.ts for what is in the
 * table and, more importantly, what was measured and left out.
 */
function elementKindFor(part: string): ElementKind {
  const key = normId(part);
  let kind = elementCache.get(key);
  if (kind === undefined) {
    kind = elementKindForDescription(headerOf(key));
    elementCache.set(key, kind);
  }
  return kind;
}
