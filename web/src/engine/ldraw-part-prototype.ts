/**
 * Per-part cuboid prototypes for the Bedrock entity path.
 *
 * A prototype is compiled ONCE per unique part id (and quality) from the
 * part's local-space mesh (`ldraw-part-geometry.ts`) and then instanced for
 * every placement. It is an axis-aligned cuboid decomposition in part-local
 * LDU:
 *
 *   1. rasterize the stud-stripped surface onto a lattice ALIGNED TO THE PART'S
 *      AABB, at half the requested microcell (exact triangle/cell overlap —
 *      Akenine-Möller SAT — so a slanted face marks every cell it crosses and a
 *      flood fill cannot leak through it);
 *   2. fill the interior by flooding air in from the lattice boundary through
 *      the top and the four sides. LDraw parts are authored with an OPEN
 *      BOTTOM (+Y): a brick's underside cavity is reachable only from below, so
 *      it fills solid and the brick becomes one cuboid, while a Technic pin
 *      hole or a wheel's bore is reachable from a side and stays open.
 *      Translucent parts (`hollow`) flood from all six faces instead, so a
 *      windscreen keeps its thin shell and the driver stays visible;
 *   3. downsample 2×2×2 to the microcell (majority), keep the dominant EXPLICIT
 *      colour per cell so a printed face survives as its own cuboids;
 *   4. greedy-merge per colour into cuboids whose LDU extents are clamped to
 *      the part's true AABB — a box part is exactly one cuboid. The opt-in
 *      `best-of` decomposition tries five more axis orders and a
 *      largest-box-first pass on the same lattice and keeps the fewest.
 *
 * Budget: over `maxPartCubes` the microcell doubles (up to three times) and,
 * failing that, the part becomes its AABB — always with `source` saying so.
 * Everything here is deterministic; the same mesh and quality produce
 * byte-identical cuboids.
 */

import type { LdrawPartMesh, LdrawStud, LdrawTriangle, Vec3 } from './ldraw-part-geometry.js';

export interface LegoEntityQuality {
  /** Cap on cuboids for the whole entity (studs included). */
  maxModelCubes: number;
  /** Cap on cuboids per part prototype before it is coarsened / boxed. */
  maxPartCubes: number;
  /** Cuboid lattice size in LDU (4 = a fifth of a stud, half a plate). */
  microcellLdu: number;
  /** Cubes per Bedrock geometry (mobile renderers choke on one huge mesh). */
  meshChunkCubes: number;
  /** Cap on exposed-stud cuboids; studs are the first detail dropped over budget. */
  maxStudCubes: number;
  /** Cuboids fanned per stud so it reads round (4 = a 16-sided outline); 1 is a square peg. */
  studFacets: number;
}

/**
 * Craftmatic policy defaults for VEHICLES, figures and props, NOT Bedrock
 * engine limits (building shells have their own table,
 * `LEGO_SHELL_QUALITY` in bedrock-building-shell.ts).
 *
 * `microcellLdu` is the grain every part STARTS at; `maxModelCubes` is the
 * budget the entity must fit, and `planPartGrains` coarsens individual parts
 * — least visible loss per cuboid saved first — until it does. So the two
 * numbers no longer contradict each other the way the 2026-09-14 table did:
 * there `balanced` asked for 4 LDU under a 6,144 cap, and a 1,906-part
 * DeLorean fell to 8 LDU for EVERY part (5,401 cuboids), the same uniform
 * fall that put a 3,808-part coaster's hero track at 16 LDU. The budgets are
 * sized against the device (2026-09-21): ~480,000 resident cuboids across all
 * active packs and, separately, ~50k DRAWN cuboids for 60 fps / ~100k for 30
 * (`docs/bedrock-addon-guide.md`). A vehicle is always in view when ridden and
 * usually shares the pack with scenery, so `balanced` is a 5 % share.
 */
export const LEGO_ENTITY_QUALITY = {
  balanced: { maxModelCubes: 24576, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 6144, studFacets: 4 },
  high: { maxModelCubes: 49152, maxPartCubes: 4096, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 12288, studFacets: 4 },
  ultra: { maxModelCubes: 98304, maxPartCubes: 4096, microcellLdu: 1, meshChunkCubes: 1024, maxStudCubes: 16384, studFacets: 4 },
} as const satisfies Record<string, LegoEntityQuality>;

export type LegoEntityQualityName = keyof typeof LEGO_ENTITY_QUALITY;

export function resolveEntityQuality(quality?: LegoEntityQualityName | Partial<LegoEntityQuality>): LegoEntityQuality {
  if (!quality) return { ...LEGO_ENTITY_QUALITY.balanced };
  if (typeof quality === 'string') return { ...(LEGO_ENTITY_QUALITY[quality] ?? LEGO_ENTITY_QUALITY.balanced) };
  return { ...LEGO_ENTITY_QUALITY.balanced, ...quality };
}

/**
 * Coarsen a quality to `high`, field by field — the ceiling every FIGURE is
 * compiled at however fine the pack asked for.
 *
 * `high` and `ultra` exist to spend what is left of `maxModelCubes` after the
 * render cuboids ON A DENSE MODEL: a 6,000-part castle or a 2,000-part ship
 * fills the budget and a finer microcell is the only way to keep its grain. A
 * minifig is ~10 placements on the rig and never approaches that budget, so it
 * pays 8-13x the cuboids for very little: measured 2026-09-18, one ultra figure
 * is 1,257-1,751 cuboids where the same figures at balanced are 106-183 (76435
 * ships 10 figures in 1,296 cuboids total). What that buys, over 76286's four
 * figures, is six-view silhouette IoU against the figure's own source
 * triangles of 0.940-0.959 at 1 LDU, 0.904-0.932 at 2 LDU and 0.852-0.897 at
 * 4 LDU: the head and hands round off, the rest is unchanged.
 *
 * `high` is the clamp rather than `balanced` because it is FREE. Figures are
 * 9.5-24.7 % of an Ultra pack (11.4 % over a 16-pack corpus) and cuboids are
 * what the device's add-on memory ceiling is denominated in (see
 * `DEVICE_CUBOID_BUDGET` in playable-addon.ts) - but that ceiling is coarse:
 * 71043 lands at ~50.1k cuboids clamped to `high` against 48.7k clamped to
 * `balanced`, and 260,000 over either is the SAME 5 packs; 76286 is 13 packs
 * either way. `balanced` would give up 0.03 IoU per figure and buy no extra
 * pack. Drop to `balanced` only if a measurement shows a pack count actually
 * turning on it. (Since 2026-09-21 `balanced` and `high` both start at 2 LDU
 * and differ in budget, which a ~10-part figure never reaches, so the clamp
 * changes a figure only when the pack is `ultra`.)
 *
 * Field-by-field rather than "replace with high" so a caller that asked for
 * something COARSER than high keeps it.
 */
export function clampFigureQuality(quality: LegoEntityQuality): LegoEntityQuality {
  const b = LEGO_ENTITY_QUALITY.high;
  return {
    ...quality,
    maxModelCubes: Math.min(quality.maxModelCubes, b.maxModelCubes),
    maxPartCubes: Math.min(quality.maxPartCubes, b.maxPartCubes),
    microcellLdu: Math.max(quality.microcellLdu, b.microcellLdu),
    maxStudCubes: Math.min(quality.maxStudCubes, b.maxStudCubes),
    studFacets: Math.min(quality.studFacets, b.studFacets),
  };
}

/** An axis-aligned box in part-local LDU. `color` 16 means the placement's colour. */
export interface PartCuboid {
  min: Vec3;
  max: Vec3;
  color: number;
}

export type PrototypeSource = 'exact-box' | 'mesh-decomposition' | 'aabb-fallback' | 'empty';

export interface PrototypeMetrics {
  /** Occupied microcells after the fill. */
  solidCells: number;
  /** Microcells in the part's AABB. */
  aabbCells: number;
  /** solidCells / aabbCells — 1.0 for a box, ~0.5 for a 45° slope, ~0.79 for a cylinder. */
  fill: number;
  /** How many times the microcell was doubled to meet `maxPartCubes`. */
  coarsened: number;
}

export interface CompiledPartPrototype {
  partId: string;
  cuboids: PartCuboid[];
  /** Top studs the resolver recorded; the compiler emits those the model leaves exposed. */
  studs: LdrawStud[];
  source: PrototypeSource;
  boundsLdu: { min: Vec3; max: Vec3 };
  /** Microcell actually used (≥ the requested one after coarsening). */
  microcellLdu: number;
  hollow: boolean;
  metrics: PrototypeMetrics;
}

/**
 * How the coarse lattice is merged into cuboids. `greedy` is the shipped
 * scan-order merge. `best-of` also runs the other five axis orders and a
 * largest-box-first pass and keeps whichever needs the fewest cuboids; every
 * candidate tiles exactly the same cells, so the geometry is identical and
 * only the count changes (measured 2026-09-19 on 399 random parts: -7.4 %,
 * on the 69 costliest: -8.4 %; `scripts/part-decomposition-compare.ts`).
 */
export type PartDecomposition = 'greedy' | 'best-of';

export interface CompilePrototypeOptions {
  /** Shell-only decomposition: flood from all six faces (translucent parts). */
  hollow?: boolean;
  /** Merge strategy; defaults to the scan-order `greedy`. */
  decomposition?: PartDecomposition;
}

/** Upper bound on the fine lattice; above it the microcell is doubled first. */
const MAX_FINE_CELLS = 6_000_000;
const MAX_COARSENING = 3;

// ─── Triangle / box overlap (Akenine-Möller separating-axis test) ─────────────

function axisTest(
  ax: number, ay: number, az: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  hx: number, hy: number, hz: number,
): boolean {
  const p0 = ax * x0 + ay * y0 + az * z0;
  const p1 = ax * x1 + ay * y1 + az * z1;
  const p2 = ax * x2 + ay * y2 + az * z2;
  const lo = Math.min(p0, p1, p2), hi = Math.max(p0, p1, p2);
  const r = hx * Math.abs(ax) + hy * Math.abs(ay) + hz * Math.abs(az);
  return lo <= r && hi >= -r;
}

/** True when the triangle (vertices relative to the box centre) touches the box of half-size h. */
export function triangleBoxOverlap(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  hx: number, hy: number, hz: number,
): boolean {
  // 1. triangle AABB vs box
  if (Math.min(x0, x1, x2) > hx || Math.max(x0, x1, x2) < -hx) return false;
  if (Math.min(y0, y1, y2) > hy || Math.max(y0, y1, y2) < -hy) return false;
  if (Math.min(z0, z1, z2) > hz || Math.max(z0, z1, z2) < -hz) return false;
  // 2. triangle plane vs box
  const e0x = x1 - x0, e0y = y1 - y0, e0z = z1 - z0;
  const e1x = x2 - x1, e1y = y2 - y1, e1z = z2 - z1;
  const e2x = x0 - x2, e2y = y0 - y2, e2z = z0 - z2;
  const nx = e0y * e1z - e0z * e1y, ny = e0z * e1x - e0x * e1z, nz = e0x * e1y - e0y * e1x;
  const dist = nx * x0 + ny * y0 + nz * z0;
  const r = hx * Math.abs(nx) + hy * Math.abs(ny) + hz * Math.abs(nz);
  if (dist > r || dist < -r) return false;
  // 3. nine cross-product axes (box axis × triangle edge)
  for (const [ex, ey, ez] of [[e0x, e0y, e0z], [e1x, e1y, e1z], [e2x, e2y, e2z]] as const) {
    if (!axisTest(0, -ez, ey, x0, y0, z0, x1, y1, z1, x2, y2, z2, hx, hy, hz)) return false;
    if (!axisTest(ez, 0, -ex, x0, y0, z0, x1, y1, z1, x2, y2, z2, hx, hy, hz)) return false;
    if (!axisTest(-ey, ex, 0, x0, y0, z0, x1, y1, z1, x2, y2, z2, hx, hy, hz)) return false;
  }
  return true;
}

// ─── Rasterization ────────────────────────────────────────────────────────────

export interface Lattice {
  origin: Vec3;
  cell: number;
  nx: number; ny: number; nz: number;
  /** 1 where solid. */
  solid: Uint8Array;
  /** Colour palette index + 1 per cell (0 = none / inherit). */
  label: Uint16Array;
  colors: number[];
}

/** Map a colour id to a palette index; 16 (inherit) is never given a label. */
function labelFor(colors: number[], color: number): number {
  if (color === 16) return 0;
  let i = colors.indexOf(color);
  if (i < 0) { i = colors.length; colors.push(color); }
  return i + 1;
}

export function rasterizeSurface(triangles: LdrawTriangle[], min: Vec3, max: Vec3, cell: number): Lattice {
  const nx = Math.max(1, Math.ceil((max[0] - min[0]) / cell - 1e-9));
  const ny = Math.max(1, Math.ceil((max[1] - min[1]) / cell - 1e-9));
  const nz = Math.max(1, Math.ceil((max[2] - min[2]) / cell - 1e-9));
  const solid = new Uint8Array(nx * ny * nz);
  const label = new Uint16Array(nx * ny * nz);
  const colors: number[] = [];
  const h = cell / 2;
  const idx = (x: number, y: number, z: number): number => (y * nz + z) * nx + x;

  for (const t of triangles) {
    const lbl = labelFor(colors, t.color);
    const xs = [t.a[0], t.b[0], t.c[0]], ys = [t.a[1], t.b[1], t.c[1]], zs = [t.a[2], t.b[2], t.c[2]];
    // Both ends clamped: a face lying exactly on the AABB's max plane starts at
    // index n, which is one past the last cell — unclamped, its loop never ran
    // and every +X/+Z wall went missing (the flood then filled nothing).
    const clamp = (v: number, n: number): number => Math.max(0, Math.min(n - 1, v));
    const i0 = clamp(Math.floor((Math.min(...xs) - min[0]) / cell), nx), i1 = clamp(Math.floor((Math.max(...xs) - min[0]) / cell), nx);
    const j0 = clamp(Math.floor((Math.min(...ys) - min[1]) / cell), ny), j1 = clamp(Math.floor((Math.max(...ys) - min[1]) / cell), ny);
    const k0 = clamp(Math.floor((Math.min(...zs) - min[2]) / cell), nz), k1 = clamp(Math.floor((Math.max(...zs) - min[2]) / cell), nz);
    for (let j = j0; j <= j1; j++) {
      const cy = min[1] + (j + 0.5) * cell;
      for (let k = k0; k <= k1; k++) {
        const cz = min[2] + (k + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = min[0] + (i + 0.5) * cell;
          if (!triangleBoxOverlap(
            t.a[0] - cx, t.a[1] - cy, t.a[2] - cz,
            t.b[0] - cx, t.b[1] - cy, t.b[2] - cz,
            t.c[0] - cx, t.c[1] - cy, t.c[2] - cz,
            h, h, h,
          )) continue;
          const n = idx(i, j, k);
          solid[n] = 1;
          // An explicit colour beats "inherit"; the first explicit colour wins.
          if (lbl && !label[n]) label[n] = lbl;
        }
      }
    }
  }
  return { origin: min, cell, nx, ny, nz, solid, label, colors };
}

/**
 * Flood air from the lattice boundary through empty cells; everything not
 * reached becomes solid. `sixSided` also floods from the bottom (+Y) face.
 */
export function fillInterior(lat: Lattice, sixSided: boolean): void {
  const { nx, ny, nz, solid } = lat;
  const total = nx * ny * nz;
  const reached = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0, tail = 0;
  const idx = (x: number, y: number, z: number): number => (y * nz + z) * nx + x;
  const seed = (n: number): void => { if (!solid[n] && !reached[n]) { reached[n] = 1; queue[tail++] = n; } };
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) { seed(idx(0, y, z)); seed(idx(nx - 1, y, z)); }
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { seed(idx(x, y, 0)); seed(idx(x, y, nz - 1)); }
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    seed(idx(x, 0, z));                       // top (LDraw −Y is up, lattice y=0 is min Y)
    if (sixSided) seed(idx(x, ny - 1, z));    // bottom
  }
  while (head < tail) {
    const n = queue[head++]!;
    const x = n % nx, rest = (n - x) / nx, z = rest % nz, y = (rest - z) / nz;
    if (x > 0) seed(n - 1);
    if (x < nx - 1) seed(n + 1);
    if (z > 0) seed(n - nx);
    if (z < nz - 1) seed(n + nx);
    if (y > 0) seed(n - nx * nz);
    if (y < ny - 1) seed(n + nx * nz);
  }
  for (let n = 0; n < total; n++) if (!reached[n]) solid[n] = 1;
}

/** 2×2×2 majority downsample; a coarse cell takes its most frequent explicit colour. */
export function downsample(fine: Lattice): Lattice {
  const cell = fine.cell * 2;
  const nx = Math.ceil(fine.nx / 2), ny = Math.ceil(fine.ny / 2), nz = Math.ceil(fine.nz / 2);
  const solid = new Uint8Array(nx * ny * nz);
  const label = new Uint16Array(nx * ny * nz);
  const counts = new Map<number, number>();
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    let filled = 0, present = 0;
    counts.clear();
    for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
      const fx = x * 2 + dx, fy = y * 2 + dy, fz = z * 2 + dz;
      if (fx >= fine.nx || fy >= fine.ny || fz >= fine.nz) continue;
      present++;
      const n = (fy * fine.nz + fz) * fine.nx + fx;
      if (fine.solid[n]) {
        filled++;
        const l = fine.label[n]!;
        if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
      }
    }
    // Majority of the fine cells that exist (a truncated edge cell has fewer than 8).
    if (filled * 2 < present) continue;
    const n = (y * nz + z) * nx + x;
    solid[n] = 1;
    let best = 0, bestCount = 0;
    for (const [l, c] of counts) if (c > bestCount || (c === bestCount && l < best)) { best = l; bestCount = c; }
    label[n] = best;
  }
  return { origin: fine.origin, cell, nx, ny, nz, solid, label, colors: fine.colors };
}

// ─── Greedy merge ─────────────────────────────────────────────────────────────

export function greedyCuboids(lat: Lattice, boundsMax: Vec3): PartCuboid[] {
  const { nx, ny, nz, solid, label, origin, cell } = lat;
  const seen = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number): number => (y * nz + z) * nx + x;
  const same = (n: number, l: number): boolean => solid[n] === 1 && !seen[n] && label[n] === l;
  const out: PartCuboid[] = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const n0 = idx(x, y, z);
    if (!solid[n0] || seen[n0]) continue;
    const l = label[n0]!;
    let sx = 1;
    while (x + sx < nx && same(idx(x + sx, y, z), l)) sx++;
    let sz = 1, ok = true;
    while (z + sz < nz && ok) {
      for (let xx = x; xx < x + sx; xx++) if (!same(idx(xx, y, z + sz), l)) { ok = false; break; }
      if (ok) sz++;
    }
    let sy = 1;
    ok = true;
    while (y + sy < ny && ok) {
      for (let zz = z; zz < z + sz && ok; zz++) for (let xx = x; xx < x + sx; xx++) if (!same(idx(xx, y + sy, zz), l)) { ok = false; break; }
      if (ok) sy++;
    }
    for (let yy = y; yy < y + sy; yy++) for (let zz = z; zz < z + sz; zz++) for (let xx = x; xx < x + sx; xx++) seen[idx(xx, yy, zz)] = 1;
    out.push({
      min: [origin[0] + x * cell, origin[1] + y * cell, origin[2] + z * cell],
      // Clamp the far side to the true AABB so a part 17 LDU wide is 17, not 20.
      max: [
        Math.min(boundsMax[0], origin[0] + (x + sx) * cell),
        Math.min(boundsMax[1], origin[1] + (y + sy) * cell),
        Math.min(boundsMax[2], origin[2] + (z + sz) * cell),
      ],
      color: l ? lat.colors[l - 1]! : 16,
    });
  }
  return out;
}

// ─── Alternative merges (same cells, fewer boxes) ─────────────────────────────

type AxisOrder = readonly [number, number, number];
/** The shipped greedy extends x, then z, then y — order [0, 2, 1]. */
const AXIS_ORDERS: AxisOrder[] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
/** Largest-box-first is quadratic in cells; above this it is skipped and `best-of` is the six greedy orders. */
const MAX_BOX_CELLS = 200_000;

const cellIndex = (lat: Lattice, x: number, y: number, z: number): number => (y * lat.nz + z) * lat.nx + x;

/** Grow a same-label box from (x, y, z) one axis at a time in `order`; returns its cell extents. */
function growBox(lat: Lattice, seen: Uint8Array, x: number, y: number, z: number, order: AxisOrder): [number, number, number] {
  const { solid, label } = lat;
  const dims = [lat.nx, lat.ny, lat.nz];
  const l = label[cellIndex(lat, x, y, z)]!;
  const same = (a: number, b: number, c: number): boolean => { const n = cellIndex(lat, a, b, c); return solid[n] === 1 && !seen[n] && label[n] === l; };
  const size: [number, number, number] = [1, 1, 1];
  const start = [x, y, z];
  const p = [0, 0, 0];
  for (const axis of order) {
    const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
    for (;;) {
      const next = start[axis]! + size[axis];
      if (next >= dims[axis]!) break;
      let ok = true;
      p[axis] = next;
      for (let i = 0; i < size[o1]! && ok; i++) for (let j = 0; j < size[o2]!; j++) {
        p[o1] = start[o1]! + i; p[o2] = start[o2]! + j;
        if (!same(p[0]!, p[1]!, p[2]!)) { ok = false; break; }
      }
      if (!ok) break;
      size[axis]++;
    }
  }
  return size;
}

function markBox(lat: Lattice, seen: Uint8Array, x: number, y: number, z: number, s: [number, number, number]): void {
  for (let yy = y; yy < y + s[1]; yy++) for (let zz = z; zz < z + s[2]; zz++) for (let xx = x; xx < x + s[0]; xx++) seen[cellIndex(lat, xx, yy, zz)] = 1;
}

function cellCuboid(lat: Lattice, boundsMax: Vec3, x: number, y: number, z: number, s: [number, number, number]): PartCuboid {
  const { origin, cell } = lat;
  const l = lat.label[cellIndex(lat, x, y, z)]!;
  return {
    min: [origin[0] + x * cell, origin[1] + y * cell, origin[2] + z * cell],
    // Clamp the far side to the true AABB, exactly as `greedyCuboids` does.
    max: [
      Math.min(boundsMax[0], origin[0] + (x + s[0]) * cell),
      Math.min(boundsMax[1], origin[1] + (y + s[1]) * cell),
      Math.min(boundsMax[2], origin[2] + (z + s[2]) * cell),
    ],
    color: l ? lat.colors[l - 1]! : 16,
  };
}

/** Scan-order greedy merge extending along the axes in `order` (`[0, 2, 1]` reproduces `greedyCuboids`). */
export function greedyCuboidsOrdered(lat: Lattice, boundsMax: Vec3, order: AxisOrder): PartCuboid[] {
  const { nx, ny, nz, solid } = lat;
  const seen = new Uint8Array(nx * ny * nz);
  const out: PartCuboid[] = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    const n = cellIndex(lat, x, y, z);
    if (!solid[n] || seen[n]) continue;
    const s = growBox(lat, seen, x, y, z, order);
    markBox(lat, seen, x, y, z, s);
    out.push(cellCuboid(lat, boundsMax, x, y, z, s));
  }
  return out;
}

/**
 * Largest-box-first: from every uncovered corner cell (no coverable same-label
 * cell at -x, -y or -z) grow a box in each of the six orders, take the largest,
 * mark it, repeat until every solid cell is covered. Deterministic.
 */
export function maxBoxCuboids(lat: Lattice, boundsMax: Vec3): PartCuboid[] {
  const { nx, ny, nz, solid, label } = lat;
  const seen = new Uint8Array(nx * ny * nz);
  const out: PartCuboid[] = [];
  let remaining = 0;
  for (let n = 0; n < solid.length; n++) if (solid[n]) remaining++;
  while (remaining > 0) {
    let best: { x: number; y: number; z: number; s: [number, number, number]; v: number } | null = null;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const n = cellIndex(lat, x, y, z);
      if (!solid[n] || seen[n]) continue;
      const l = label[n];
      const free = (a: number, b: number, c: number): boolean => { const m = cellIndex(lat, a, b, c); return solid[m] === 1 && !seen[m] && label[m] === l; };
      if ((x > 0 && free(x - 1, y, z)) || (y > 0 && free(x, y - 1, z)) || (z > 0 && free(x, y, z - 1))) continue;
      for (const order of AXIS_ORDERS) {
        const s = growBox(lat, seen, x, y, z, order);
        const v = s[0] * s[1] * s[2];
        if (!best || v > best.v) best = { x, y, z, s, v };
      }
    }
    if (!best) break; // unreachable while `remaining` > 0: the lowest uncovered cell has no free predecessor
    markBox(lat, seen, best.x, best.y, best.z, best.s);
    remaining -= best.v;
    out.push(cellCuboid(lat, boundsMax, best.x, best.y, best.z, best.s));
  }
  return out;
}

/** The fewest cuboids among the shipped greedy, the other five axis orders and largest-box-first; ties keep the earlier candidate. */
export function bestOfCuboids(lat: Lattice, boundsMax: Vec3): PartCuboid[] {
  let best = greedyCuboids(lat, boundsMax);
  for (const order of AXIS_ORDERS) {
    if (order[0] === 0 && order[1] === 2) continue; // the shipped order
    const c = greedyCuboidsOrdered(lat, boundsMax, order);
    if (c.length < best.length) best = c;
  }
  if (lat.solid.length <= MAX_BOX_CELLS) {
    const c = maxBoxCuboids(lat, boundsMax);
    if (c.length < best.length) best = c;
  }
  return best;
}

function decomposeLattice(lat: Lattice, boundsMax: Vec3, strategy: PartDecomposition): PartCuboid[] {
  return strategy === 'best-of' ? bestOfCuboids(lat, boundsMax) : greedyCuboids(lat, boundsMax);
}

// ─── Compilation ──────────────────────────────────────────────────────────────

function aabbFallback(mesh: LdrawPartMesh, cell: number, coarsened: number, hollow: boolean): CompiledPartPrototype {
  const { min, max } = mesh.bounds;
  const aabbCells = Math.max(1, Math.ceil((max[0] - min[0]) / cell)) * Math.max(1, Math.ceil((max[1] - min[1]) / cell)) * Math.max(1, Math.ceil((max[2] - min[2]) / cell));
  return {
    partId: mesh.partId,
    cuboids: [{ min: [...min], max: [...max], color: 16 }],
    studs: mesh.studs,
    source: 'aabb-fallback',
    boundsLdu: { min: [...min], max: [...max] },
    microcellLdu: cell,
    hollow,
    metrics: { solidCells: aabbCells, aabbCells, fill: 1, coarsened },
  };
}

export function compilePartPrototype(
  mesh: LdrawPartMesh,
  quality: LegoEntityQuality,
  options: CompilePrototypeOptions = {},
): CompiledPartPrototype {
  const hollow = options.hollow ?? false;
  const { min, max } = mesh.bounds;
  if (mesh.triangles.length === 0) {
    return {
      partId: mesh.partId, cuboids: [], studs: mesh.studs, source: 'empty',
      boundsLdu: { min: [...min], max: [...max] }, microcellLdu: quality.microcellLdu, hollow,
      metrics: { solidCells: 0, aabbCells: 0, fill: 0, coarsened: 0 },
    };
  }

  let cell = quality.microcellLdu;
  let coarsened = 0;
  // A huge part (a 48×48 baseplate at 1 LDU) would need tens of millions of
  // fine cells; coarsen before allocating.
  const fineCells = (c: number): number =>
    Math.max(1, Math.ceil((max[0] - min[0]) / (c / 2))) * Math.max(1, Math.ceil((max[1] - min[1]) / (c / 2))) * Math.max(1, Math.ceil((max[2] - min[2]) / (c / 2)));
  while (fineCells(cell) > MAX_FINE_CELLS && coarsened < MAX_COARSENING) { cell *= 2; coarsened++; }

  for (;;) {
    const fine = rasterizeSurface(mesh.triangles, min, max, cell / 2);
    fillInterior(fine, hollow);
    const coarse = downsample(fine);
    const cuboids = decomposeLattice(coarse, max, options.decomposition ?? 'greedy');
    if (cuboids.length <= quality.maxPartCubes || coarsened >= MAX_COARSENING) {
      if (cuboids.length > quality.maxPartCubes) return aabbFallback(mesh, cell, coarsened, hollow);
      let solidCells = 0;
      for (let n = 0; n < coarse.solid.length; n++) solidCells += coarse.solid[n]!;
      const aabbCells = coarse.nx * coarse.ny * coarse.nz;
      const isBox = cuboids.length === 1 && cuboids[0]!.color === 16
        && cuboids[0]!.min.every((v, i) => Math.abs(v - min[i]!) < 1e-6)
        && cuboids[0]!.max.every((v, i) => Math.abs(v - max[i]!) < 1e-6);
      // A single AABB reached only by coarsening is a fallback, not a box part.
      const source: PrototypeSource = isBox ? (coarsened === 0 ? 'exact-box' : 'aabb-fallback') : 'mesh-decomposition';
      return {
        partId: mesh.partId,
        cuboids,
        studs: mesh.studs,
        source,
        boundsLdu: { min: [...min], max: [...max] },
        microcellLdu: cell,
        hollow,
        metrics: { solidCells, aabbCells, fill: solidCells / aabbCells, coarsened },
      };
    }
    cell *= 2;
    coarsened++;
  }
}

/** Compile-once, instance-many: keyed by part id, quality and hollowness. */
export interface PrototypeCache {
  get(mesh: LdrawPartMesh, quality: LegoEntityQuality, options?: CompilePrototypeOptions): CompiledPartPrototype;
  readonly size: number;
  readonly hits: number;
}

export function createPrototypeCache(): PrototypeCache {
  const map = new Map<string, CompiledPartPrototype>();
  let hits = 0;
  return {
    get(mesh, quality, options = {}) {
      const key = `${mesh.partId}|${mesh.resolvedAs}|${quality.microcellLdu}|${quality.maxPartCubes}|${options.hollow ? 'h' : 's'}|${options.decomposition ?? 'greedy'}`;
      const cached = map.get(key);
      if (cached) { hits++; return cached; }
      const built = compilePartPrototype(mesh, quality, options);
      map.set(key, built);
      return built;
    },
    get size() { return map.size; },
    get hits() { return hits; },
  };
}

// ─── Silhouette fidelity ──────────────────────────────────────────────────────

/**
 * The six orthographic views of the entity silhouette gate
 * (`scripts/_entity_silhouette.ts`): front, back, left, right, top and an
 * isometric. Each is a row-major 3x3 taking part-local LDU to (screen x,
 * screen y, depth).
 */
const SILHOUETTE_VIEWS: readonly number[][] = (() => {
  const s = Math.SQRT1_2;
  const yaw = [s, 0, s, 0, 1, 0, -s, 0, s];
  const p = Math.atan(Math.SQRT1_2), cp = Math.cos(p), sp = Math.sin(p);
  const pitch = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const iso = [0, 1, 2].flatMap(i => [0, 1, 2].map(j => pitch[i * 3]! * yaw[j]! + pitch[i * 3 + 1]! * yaw[3 + j]! + pitch[i * 3 + 2]! * yaw[6 + j]!));
  return [
    [1, 0, 0, 0, 1, 0, 0, 0, 1], [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    [0, 0, 1, 0, 1, 0, -1, 0, 0], [0, 0, -1, 0, 1, 0, 1, 0, 0],
    [1, 0, 0, 0, 0, 1, 0, -1, 0], iso,
  ];
})();

/** Longest bitmap side the silhouette scorer uses; bigger parts get fewer pixels per LDU. */
const SILHOUETTE_MAX_PX = 256;
/** Pixels per LDU the scorer asks for (a 2 LDU grain step is then 3 px), until `SILHOUETTE_MAX_PX` caps it. */
const SILHOUETTE_PX_PER_LDU = 1.5;
const SILHOUETTE_MIN_PX = 48;

/**
 * A part's own six-view silhouette, rasterised once so every candidate
 * prototype can be scored against it. `areaLdu2` is the mean silhouette area
 * over the six views, the weight a part's fidelity carries in a model.
 */
export interface SilhouetteReference {
  px: number;
  pxPerLdu: number;
  centre: Vec3;
  bitmaps: Uint8Array[];
  /** Silhouette pixels per view (mean over the six). */
  areaPx: number;
  areaLdu2: number;
}

type Tri3 = readonly [Vec3, Vec3, Vec3];

const applyM = (m: number[], v: Vec3): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
];

/** Scan-line rasterise triangles into a px x px bitmap through one view; no depth, silhouette only. */
function rasterizeSilhouette(tris: Iterable<Tri3>, view: number[], centre: Vec3, pxPerLdu: number, px: number, into: Uint8Array): void {
  const half = px / 2;
  for (const [a, b, c] of tris) {
    const pa = applyM(view, [a[0] - centre[0], a[1] - centre[1], a[2] - centre[2]]);
    const pb = applyM(view, [b[0] - centre[0], b[1] - centre[1], b[2] - centre[2]]);
    const pc = applyM(view, [c[0] - centre[0], c[1] - centre[1], c[2] - centre[2]]);
    const x0 = half + pa[0] * pxPerLdu, y0 = half - pa[1] * pxPerLdu;
    const x1 = half + pb[0] * pxPerLdu, y1 = half - pb[1] * pxPerLdu;
    const x2 = half + pc[0] * pxPerLdu, y2 = half - pc[1] * pxPerLdu;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(px - 1, Math.ceil(Math.max(y0, y1, y2)));
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(px - 1, Math.ceil(Math.max(x0, x1, x2)));
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const pxc = x + 0.5;
        const w0 = ((x1 - pxc) * (y2 - py) - (x2 - pxc) * (y1 - py)) / area;
        const w1 = ((x2 - pxc) * (y0 - py) - (x0 - pxc) * (y2 - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) into[y * px + x] = 1;
      }
    }
  }
}

/**
 * A box's silhouette in one view: the three faces that face the camera (one
 * per axis, chosen by the sign of the view's depth row) already cover the
 * projection, so six triangles are rasterised, not twelve. The three facing
 * away would do equally; a MIX of the two sets would not.
 */
function* boxSilhouetteTriangles(min: Vec3, max: Vec3, view: number[]): Generator<Tri3> {
  const pick = (axis: number, lo: number, hi: number): number => (view[6 + axis]! >= 0 ? hi : lo);
  const x = pick(0, min[0], max[0]), y = pick(1, min[1], max[1]), z = pick(2, min[2], max[2]);
  // The x face at `x` spans y and z; likewise for the other two.
  yield [[x, min[1], min[2]], [x, max[1], min[2]], [x, max[1], max[2]]];
  yield [[x, min[1], min[2]], [x, max[1], max[2]], [x, min[1], max[2]]];
  yield [[min[0], y, min[2]], [max[0], y, min[2]], [max[0], y, max[2]]];
  yield [[min[0], y, min[2]], [max[0], y, max[2]], [min[0], y, max[2]]];
  yield [[min[0], min[1], z], [max[0], min[1], z], [max[0], max[1], z]];
  yield [[min[0], min[1], z], [max[0], max[1], z], [min[0], max[1], z]];
}

/** True for a view whose rows are signed axes: a box projects to an axis-aligned rectangle in it. */
const isAxisView = (view: number[]): boolean => view.every(v => v === 0 || v === 1 || v === -1);

/**
 * Fill the rectangle a box projects to in an axis view (its corners' projected
 * extents), with the SAME coverage rule as `rasterizeSilhouette`: a pixel is
 * in when its centre is inside the rectangle, edges inclusive - so a box part
 * scores exactly 1 against its own triangles.
 */
function fillBoxRect(min: Vec3, max: Vec3, view: number[], centre: Vec3, pxPerLdu: number, px: number, into: Uint8Array): void {
  const half = px / 2, eps = 1e-6;
  const lo = applyM(view, [min[0] - centre[0], min[1] - centre[1], min[2] - centre[2]]);
  const hi = applyM(view, [max[0] - centre[0], max[1] - centre[1], max[2] - centre[2]]);
  const xa = half + Math.min(lo[0], hi[0]) * pxPerLdu, xb = half + Math.max(lo[0], hi[0]) * pxPerLdu;
  const ya = half - Math.max(lo[1], hi[1]) * pxPerLdu, yb = half - Math.min(lo[1], hi[1]) * pxPerLdu;
  const x0 = Math.max(0, Math.ceil(xa - 0.5 - eps)), x1 = Math.min(px - 1, Math.floor(xb - 0.5 + eps));
  const y0 = Math.max(0, Math.ceil(ya - 0.5 - eps)), y1 = Math.min(px - 1, Math.floor(yb - 0.5 + eps));
  if (x1 < x0) return;
  for (let y = y0; y <= y1; y++) into.fill(1, y * px + x0, y * px + x1 + 1);
}

/** Rasterise a part's triangles from the six views, once. Studs are excluded on both sides of the comparison. */
export function silhouetteReference(mesh: LdrawPartMesh): SilhouetteReference {
  const { min, max } = mesh.bounds;
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 1;
  const px = Math.max(SILHOUETTE_MIN_PX, Math.min(SILHOUETTE_MAX_PX, Math.ceil(radius * 2 * SILHOUETTE_PX_PER_LDU)));
  const pxPerLdu = (px / 2) / radius;
  const tris: Tri3[] = mesh.triangles.map(t => [t.a, t.b, t.c] as const);
  let areaPx = 0;
  const bitmaps = SILHOUETTE_VIEWS.map(view => {
    const bmp = new Uint8Array(px * px);
    rasterizeSilhouette(tris, view, centre, pxPerLdu, px, bmp);
    for (let i = 0; i < bmp.length; i++) areaPx += bmp[i]!;
    return bmp;
  });
  areaPx /= SILHOUETTE_VIEWS.length;
  return { px, pxPerLdu, centre, bitmaps, areaPx, areaLdu2: areaPx / (pxPerLdu * pxPerLdu) };
}

/**
 * Mean six-view silhouette intersection-over-union of a cuboid set against
 * the part's reference silhouette: 1 for a box part's own box, lower the more
 * a grain rounds off a curve or fills a hole. The same measure the entity
 * silhouette gate reports, taken per part in part-local space.
 */
export function silhouetteIoU(ref: SilhouetteReference, cuboids: readonly PartCuboid[]): number {
  if (!cuboids.length) return ref.areaPx ? 0 : 1;
  let sum = 0;
  const scratch = new Uint8Array(ref.px * ref.px);
  for (let v = 0; v < SILHOUETTE_VIEWS.length; v++) {
    scratch.fill(0);
    const view = SILHOUETTE_VIEWS[v]!;
    if (isAxisView(view)) for (const c of cuboids) fillBoxRect(c.min, c.max, view, ref.centre, ref.pxPerLdu, ref.px, scratch);
    else for (const c of cuboids) rasterizeSilhouette(boxSilhouetteTriangles(c.min, c.max, view), view, ref.centre, ref.pxPerLdu, ref.px, scratch);
    const s = ref.bitmaps[v]!;
    let inter = 0, union = 0;
    for (let i = 0; i < s.length; i++) { if (s[i]! && scratch[i]!) inter++; if (s[i]! || scratch[i]!) union++; }
    sum += union ? inter / union : 1;
  }
  return sum / SILHOUETTE_VIEWS.length;
}

// ─── Per-part grain planning ──────────────────────────────────────────────────

/** One unique part (by id and hollowness) the model places, with how often. */
export interface GrainPlanPart {
  /** Cache key the caller instances by, e.g. `${partId}|${hollow}`. */
  key: string;
  mesh: LdrawPartMesh;
  placements: number;
  hollow: boolean;
}

export interface GrainPlanOptions {
  decomposition: PartDecomposition;
  /** Cuboids the plan must fit, INCLUDING `fixedCuboids`. */
  budget: number;
  /** Cuboids the plan cannot change (unresolved parts drawn as dims-table boxes). */
  fixedCuboids?: number;
}

/**
 * The coarsest cell the planner will push any part to: a plate's height. The
 * old uniform coarsening could take a whole model to 32 or 64 LDU, and the
 * old 64-cuboid part cap put 10303's track moulds at 16; past 8 LDU a curved
 * or holed part is its bounding box in all but name, so a model that still
 * does not fit at 8 LDU is reported as over budget instead.
 */
export const PLANNER_COARSEST_LDU = 8;

/** What `planPartGrains` decided, for the compile diagnostics. */
export interface GrainPlanSummary {
  requestedMicrocellLdu: number;
  /** The coarsest cell a part may be pushed to: up to three doublings, never past `PLANNER_COARSEST_LDU` (unless the request itself is coarser). */
  coarsestMicrocellLdu: number;
  budget: number;
  fixedCuboids: number;
  /** Placements x prototype cuboids at the requested grain, before the cull and the merge. */
  cuboidsAtRequested: number;
  /** The same sum after the plan. */
  cuboids: number;
  /** Six-view silhouette IoU, weighted by placements x silhouette area, at the requested grain. */
  fidelityAtRequested: number;
  fidelity: number;
  partsCoarsened: number;
  placementsCoarsened: number;
  /** Unique parts per microcell, e.g. `{ "2": 185, "4": 86, "8": 27 }`. */
  partsAtGrain: Record<string, number>;
  placementsAtGrain: Record<string, number>;
  /** False when every part is at the coarsest cell and the sum is still over budget. */
  fits: boolean;
  /** Coarsening steps taken. */
  steps: number;
}

export interface GrainPlan {
  /** Microcell per part key. */
  grains: Map<string, number>;
  summary: GrainPlanSummary;
}

/**
 * Choose a microcell PER PART so the model fits `budget` cuboids, spending the
 * budget where it shows.
 *
 * Every part starts at the requested grain. While the sum of placements x
 * prototype cuboids is over budget, one part is coarsened one useful step
 * (the next cell at which its prototype actually has fewer cuboids, up to
 * three doublings), and the part chosen is the one whose step loses the least
 * VISIBLE fidelity per cuboid saved:
 *
 *     loss = placements x silhouetteArea x (IoU before - IoU after)
 *     save = placements x (cuboids before - cuboids after)
 *
 * with the six-view silhouette IoU of `silhouetteIoU`. Box parts never move
 * (one cuboid at any grain, nothing to save); a many-placement round brick
 * whose IoU barely changes between 4 and 8 LDU goes early; a rare, large,
 * curved hero part (a coaster's track) goes last.
 *
 * Measured on 10303 (3,495 placements, 298 moulds, 2026-09-21): uniform grains
 * give area-weighted IoU 0.930 at 8 LDU (15.1k cuboids), 0.949 at 4 (50.9k),
 * 0.967 at 2 (142k); this plan from a 2 LDU start reaches 0.957 at a 48k
 * budget - above uniform 4 LDU for fewer cuboids, with the track at 2-4 LDU -
 * where the uniform whole-model coarsening it replaces would have dropped
 * EVERY part to 4 LDU, and coarsening by the largest spender first (no
 * fidelity term) manages 0.949.
 *
 * Deterministic: ties go to the lexically smaller key. The prototypes it
 * compiles stay in `cache`, so instancing them afterwards costs nothing more.
 */
export function planPartGrains(parts: readonly GrainPlanPart[], quality: LegoEntityQuality, cache: PrototypeCache, options: GrainPlanOptions): GrainPlan {
  const requested = quality.microcellLdu;
  const ladder = Array.from({ length: MAX_COARSENING + 1 }, (_, i) => requested * 2 ** i)
    .filter((cell, i) => i === 0 || cell <= Math.max(requested, PLANNER_COARSEST_LDU));
  const fixed = options.fixedCuboids ?? 0;

  interface State {
    part: GrainPlanPart;
    ref: SilhouetteReference | null;
    /** Index into `ladder`. */
    level: number;
    /** Whether the part is a box AT THE FINEST GRAIN — see `measure`. Lazily decided. */
    boxAtFinest: boolean | null;
    /** Memoised (cuboids, IoU) per ladder level. */
    at: Array<{ cuboids: number; iou: number } | undefined>;
  }
  const states: State[] = parts.map(part => ({ part, ref: null, level: 0, boxAtFinest: null, at: [] }));
  const measure = (s: State, level: number): { cuboids: number; iou: number } => {
    const memo = s.at[level];
    if (memo) return memo;
    const proto = cache.get(s.part.mesh, { ...quality, microcellLdu: ladder[level]! }, { hollow: s.part.hollow, decomposition: options.decomposition });
    // Is this part genuinely a box, or did a COARSE grain merely collapse it to
    // one? `compilePartPrototype` reports `exact-box` for ANY single
    // bbox-filling cuboid, and its "reached only by coarsening" guard counts
    // only its own internal loop — the planner walks the ladder by passing
    // `microcellLdu`, so that guard never fires here. A 1x1 round brick is
    // therefore `exact-box` at 8 LDU, and taking the shortcut below told the
    // planner that turning a cylinder into a cube IMPROVES its silhouette
    // (1.000 against 0.931 at 4 LDU) while saving five cuboids. Round parts
    // were consequently coarsened FIRST and read as squares up close, which is
    // exactly the reported defect. Box-ness is decided at the finest grain,
    // where the label means what it says; everything else is measured.
    if (s.boxAtFinest === null) {
      const finest = level === 0
        ? proto
        : cache.get(s.part.mesh, { ...quality, microcellLdu: ladder[0]! }, { hollow: s.part.hollow, decomposition: options.decomposition });
      s.boxAtFinest = finest.source === 'exact-box';
    }
    // A box part's silhouette is its own box: exact at every grain, no raster needed.
    let iou = 1;
    if (proto.source !== 'empty' && !s.boxAtFinest) {
      s.ref ??= silhouetteReference(s.part.mesh);
      iou = silhouetteIoU(s.ref, proto.cuboids);
    }
    const m = { cuboids: proto.cuboids.length, iou };
    s.at[level] = m;
    return m;
  };
  const weight = (s: State): number => s.part.placements * (s.ref?.areaLdu2 ?? 0);

  let total = fixed;
  for (const s of states) total += s.part.placements * measure(s, 0).cuboids;
  const cuboidsAtRequested = total;
  const fidelityOf = (): number => {
    let num = 0, den = 0;
    for (const s of states) { const w = weight(s); num += w * measure(s, s.level).iou; den += w; }
    return den ? num / den : 1;
  };
  const fidelityAtRequested = fidelityOf();

  let steps = 0;
  while (total > options.budget) {
    let best: { s: State; level: number; priority: number } | null = null;
    for (const s of states) {
      const cur = measure(s, s.level);
      // The next coarser level that actually saves cuboids; a level that saves
      // nothing is skipped over rather than paid for.
      for (let level = s.level + 1; level < ladder.length; level++) {
        const next = measure(s, level);
        const save = s.part.placements * (cur.cuboids - next.cuboids);
        if (save <= 0) continue;
        const loss = weight(s) * Math.max(0, cur.iou - next.iou);
        const priority = loss / save;
        if (!best || priority < best.priority || (priority === best.priority && s.part.key < best.s.part.key)) best = { s, level, priority };
        break;
      }
    }
    if (!best) break;
    total -= best.s.part.placements * (measure(best.s, best.s.level).cuboids - measure(best.s, best.level).cuboids);
    best.s.level = best.level;
    steps++;
  }

  const grains = new Map<string, number>();
  const partsAtGrain: Record<string, number> = {}, placementsAtGrain: Record<string, number> = {};
  let partsCoarsened = 0, placementsCoarsened = 0;
  for (const s of states) {
    const cell = ladder[s.level]!;
    grains.set(s.part.key, cell);
    partsAtGrain[cell] = (partsAtGrain[cell] ?? 0) + 1;
    placementsAtGrain[cell] = (placementsAtGrain[cell] ?? 0) + s.part.placements;
    if (s.level > 0) { partsCoarsened++; placementsCoarsened += s.part.placements; }
  }
  return {
    grains,
    summary: {
      requestedMicrocellLdu: requested, coarsestMicrocellLdu: ladder[ladder.length - 1]!, budget: options.budget, fixedCuboids: fixed,
      cuboidsAtRequested, cuboids: total, fidelityAtRequested: round4(fidelityAtRequested), fidelity: round4(fidelityOf()),
      partsCoarsened, placementsCoarsened, partsAtGrain, placementsAtGrain, fits: total <= options.budget, steps,
    },
  };
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;
