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
 *      the part's true AABB — a box part is exactly one cuboid.
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
}

/**
 * Craftmatic policy defaults, NOT Bedrock engine limits. Tuned 2026-09-14
 * against a Pixel 8 Pro (Bedrock 1.26.45): the previous greedy path shipped
 * 6,823 cuboids for the Batmobile and it rendered fine there, and at a
 * 6,144 balanced budget the 340-part X-wing keeps its 4 LDU grain (4,681
 * cuboids) and the 1,906-part DeLorean lands at 8 LDU (5,401) — both above the
 * 0.95 six-view silhouette gate, where the spec's 4,096 pushed them to 8 and 16
 * LDU and the X-wing under the gate (TASKS-BEDROCK-ADDON.md §6).
 */
export const LEGO_ENTITY_QUALITY = {
  balanced: { maxModelCubes: 6144, maxPartCubes: 128, microcellLdu: 4, meshChunkCubes: 1024, maxStudCubes: 1536 },
  high: { maxModelCubes: 12288, maxPartCubes: 256, microcellLdu: 2, meshChunkCubes: 1024, maxStudCubes: 3072 },
  ultra: { maxModelCubes: 24576, maxPartCubes: 512, microcellLdu: 1, meshChunkCubes: 1024, maxStudCubes: 6144 },
} as const satisfies Record<string, LegoEntityQuality>;

export type LegoEntityQualityName = keyof typeof LEGO_ENTITY_QUALITY;

export function resolveEntityQuality(quality?: LegoEntityQualityName | Partial<LegoEntityQuality>): LegoEntityQuality {
  if (!quality) return { ...LEGO_ENTITY_QUALITY.balanced };
  if (typeof quality === 'string') return { ...(LEGO_ENTITY_QUALITY[quality] ?? LEGO_ENTITY_QUALITY.balanced) };
  return { ...LEGO_ENTITY_QUALITY.balanced, ...quality };
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

export interface CompilePrototypeOptions {
  /** Shell-only decomposition: flood from all six faces (translucent parts). */
  hollow?: boolean;
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

interface Lattice {
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

function rasterizeSurface(triangles: LdrawTriangle[], min: Vec3, max: Vec3, cell: number): Lattice {
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
function fillInterior(lat: Lattice, sixSided: boolean): void {
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
function downsample(fine: Lattice): Lattice {
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

function greedyCuboids(lat: Lattice, boundsMax: Vec3): PartCuboid[] {
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
    const cuboids = greedyCuboids(coarse, max);
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
      const key = `${mesh.partId}|${mesh.resolvedAs}|${quality.microcellLdu}|${quality.maxPartCubes}|${options.hollow ? 'h' : 's'}`;
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
