/**
 * Metrics harness for the mesh -> bricks route (B) and the part mapper (A) (BIZ-33, X-12).
 *
 * Measures a generated lattice against a reference: voxel IoU (best integer shift, +-2 cells), silhouette
 * IoU through the sim rasteriser (`web/src/sim/render/rasterizer.ts`, read only) for six axis views and any
 * number of free cameras, median CIEDE2000 per matched cell, connectivity, part-type diversity, and a
 * contact sheet. Pure: lattices (and optionally masks / part lists) in, numbers and RGB buffers out; the PNG
 * encoding lives in `scripts/_byom_metrics.ts`.
 *
 * Frame: a lattice cell is 1 stud x 1 plate x 1 stud, drawn 1 x 0.4 x 1 world units so a view has the real
 * 20 : 8 : 20 LDU proportions. Axis views are near-orthographic (a distant camera with a narrow field), so a
 * silhouette is an outline, not a perspective picture.
 */

import { rasterizeDetailed, type RasterQuad, type RasterCamera, type V3 } from '../../sim/render/rasterizer.js';
import { deltaE2000, ldrawRgb, rgbToLab, type Rgb } from '../../brickgen/colour.js';
import { partStem } from '../part-id.js';
import { latticeIndex, type IntentLattice } from './types.js';

/** Height of one plate layer relative to a stud pitch (8 / 20 LDU). */
export const PLATE_RATIO = 8 / 20;
/** The rasteriser reads corners in 1/16 units. */
const SIXTEENTHS = 16;

// ---------------------------------------------------------------------------------------------------------
// Voxel IoU

/** True when cell (x, p, z) is filled; out of range is empty. */
export function filledAt(l: IntentLattice, x: number, p: number, z: number): boolean {
  return x >= 0 && p >= 0 && z >= 0 && x < l.dims[0] && p < l.dims[1] && z < l.dims[2] && l.cells[latticeIndex(l.dims, x, p, z)] !== 0;
}

/** Number of filled cells. */
export function filledCount(l: IntentLattice): number {
  let n = 0;
  for (let i = 0; i < l.cells.length; i++) if (l.cells[i] !== 0) n++;
  return n;
}

/** Offset of `b` against `a`, in cells: b's cell (x, p, z) is compared with a's (x + dx, p + dy, z + dz). */
export type Shift = readonly [dx: number, dy: number, dz: number];

/** IoU of two lattices with `b` moved by `shift`; two empty lattices are identical (1). */
export function voxelIoUAt(a: IntentLattice, b: IntentLattice, shift: Shift = [0, 0, 0]): number {
  let inter = 0;
  let bCount = 0;
  const [dx, dy, dz] = shift;
  for (let p = 0; p < b.dims[1]; p++) for (let z = 0; z < b.dims[2]; z++) for (let x = 0; x < b.dims[0]; x++) {
    if (b.cells[latticeIndex(b.dims, x, p, z)] === 0) continue;
    bCount++;
    if (filledAt(a, x + dx, p + dy, z + dz)) inter++;
  }
  const union = filledCount(a) + bCount - inter;
  return union === 0 ? 1 : inter / union;
}

/** Result of {@link voxelIoU}. */
export interface VoxelIoUResult {
  /** Best IoU over the shifts searched. */
  iou: number;
  /** The shift of `b` that gave it (ties go to the smallest |shift|, then scan order). */
  shift: Shift;
  /** IoU with no shift, for reading how much alignment bought. */
  iouUnshifted: number;
}

/**
 * Voxel IoU of two lattices, `b` aligned to `a` by the best integer shift within +-`maxShift` cells per axis
 * (two independent voxelisations of one model rarely share an origin: see lattice.ts, "lattice origin").
 */
export function voxelIoU(a: IntentLattice, b: IntentLattice, maxShift = 2): VoxelIoUResult {
  const iouUnshifted = voxelIoUAt(a, b);
  let best: VoxelIoUResult = { iou: iouUnshifted, shift: [0, 0, 0], iouUnshifted };
  let bestNorm = 0;
  for (let dy = -maxShift; dy <= maxShift; dy++) for (let dz = -maxShift; dz <= maxShift; dz++) for (let dx = -maxShift; dx <= maxShift; dx++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    const iou = voxelIoUAt(a, b, [dx, dy, dz]);
    const norm = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    if (iou > best.iou + 1e-12 || (Math.abs(iou - best.iou) <= 1e-12 && norm < bestNorm)) { best = { iou, shift: [dx, dy, dz], iouUnshifted }; bestNorm = norm; }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------
// Colour

/** sRGB of a label's LDraw colour (a direct `0x2RRGGBB` colour reads its own RGB); mid grey when unknown. */
export function labelRgb(l: IntentLattice, cell: number): Rgb {
  const code = l.labels[cell - 1]?.colour ?? 16;
  if (code >= 0x2000000 && code < 0x4000000) return [(code >> 16) & 255, (code >> 8) & 255, code & 255];
  return ldrawRgb(code) ?? [128, 128, 128];
}

const median = (v: number[]): number => {
  if (v.length === 0) return 0;
  const s = [...v].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Median CIEDE2000 between the colours of cells filled in both lattices (`b` shifted by `shift`); 0 when none match. */
export function medianCellDeltaE(a: IntentLattice, b: IntentLattice, shift: Shift = [0, 0, 0]): { median: number; matched: number } {
  const labCache = new Map<string, ReturnType<typeof rgbToLab>>();
  const lab = (l: IntentLattice, cell: number, tag: string): ReturnType<typeof rgbToLab> => {
    const key = `${tag}${cell}`;
    let v = labCache.get(key);
    if (!v) { v = rgbToLab(labelRgb(l, cell)); labCache.set(key, v); }
    return v;
  };
  const d: number[] = [];
  const [dx, dy, dz] = shift;
  for (let p = 0; p < b.dims[1]; p++) for (let z = 0; z < b.dims[2]; z++) for (let x = 0; x < b.dims[0]; x++) {
    const cb = b.cells[latticeIndex(b.dims, x, p, z)]!;
    if (cb === 0 || !filledAt(a, x + dx, p + dy, z + dz)) continue;
    const ca = a.cells[latticeIndex(a.dims, x + dx, p + dy, z + dz)]!;
    d.push(deltaE2000(lab(a, ca, 'a'), lab(b, cb, 'b')));
  }
  return { median: median(d), matched: d.length };
}

/** Median CIEDE2000 over pixels both masks cover, between two RGB images of one size (a render vs a reference photo). */
export function medianImageDeltaE(rgbA: Uint8Array, maskA: Uint8Array, rgbB: Uint8Array, maskB: Uint8Array): { median: number; matched: number } {
  const d: number[] = [];
  for (let i = 0; i < maskA.length; i++) {
    if (!maskA[i] || !maskB[i]) continue;
    d.push(deltaE2000(rgbToLab([rgbA[i * 3]!, rgbA[i * 3 + 1]!, rgbA[i * 3 + 2]!]), rgbToLab([rgbB[i * 3]!, rgbB[i * 3 + 1]!, rgbB[i * 3 + 2]!])));
  }
  return { median: median(d), matched: d.length };
}

// ---------------------------------------------------------------------------------------------------------
// Connectivity

/** Face-connectivity of the filled cells. */
export interface ConnectivityStats {
  filled: number;
  /** Face-connected components (6-neighbourhood). */
  components: number;
  /** Cells in the largest component. */
  largest: number;
  /** largest / filled; 1 means one piece, 0 for an empty lattice. */
  largestShare: number;
  /** Components with no more than 2 cells (stray specks a builder would drop). */
  specks: number;
}

/** Count face-connected components of the filled cells (iterative flood fill; no recursion). */
export function connectivity(l: IntentLattice): ConnectivityStats {
  const [nx, ny, nz] = l.dims;
  const seen = new Uint8Array(l.cells.length);
  const stack: number[] = [];
  const sizes: number[] = [];
  let filled = 0;
  for (let start = 0; start < l.cells.length; start++) {
    if (l.cells[start] === 0) continue;
    filled++;
    if (seen[start]) continue;
    let size = 0;
    seen[start] = 1; stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      size++;
      const x = i % nx, z = Math.floor(i / nx) % nz, p = Math.floor(i / (nx * nz));
      const visit = (xx: number, pp: number, zz: number): void => {
        if (xx < 0 || pp < 0 || zz < 0 || xx >= nx || pp >= ny || zz >= nz) return;
        const j = latticeIndex(l.dims, xx, pp, zz);
        if (l.cells[j] === 0 || seen[j]) return;
        seen[j] = 1; stack.push(j);
      };
      visit(x - 1, p, z); visit(x + 1, p, z); visit(x, p - 1, z); visit(x, p + 1, z); visit(x, p, z - 1); visit(x, p, z + 1);
    }
    sizes.push(size);
  }
  const largest = sizes.reduce((m, s) => Math.max(m, s), 0);
  return { filled, components: sizes.length, largest, largestShare: filled === 0 ? 0 : largest / filled, specks: sizes.filter((s) => s <= 2).length };
}

// ---------------------------------------------------------------------------------------------------------
// Part-type diversity

/** Coarse part families the diversity measure counts. */
export type PartFamily = 'slope' | 'arch' | 'round' | 'other';

/** Library ids by family (stems as `partStem` yields them). A plain brick or plate is `other`. */
const FAMILY_IDS: Record<Exclude<PartFamily, 'other'>, ReadonlySet<string>> = {
  slope: new Set(['3040', '3039', '3038', '3037', '3041', '3042', '3043', '3044', '3045', '3046', '3665', '3660', '3298', '3300', '3675', '4286', '4287', '54200', '50746', '3037b', '60481', '3040b']),
  arch: new Set(['3659', '6091', '15254', '4490', '3455', '30099', '2339', '6005', '92950', '4744']),
  round: new Set(['3062b', '3062', '4073', '4589', '6141', '3941', '3942', '4032', '3941b', '6143', '2780', '30367', '3942c', '87580', '2654', '4740']),
};

/** The family of a part id (`3040b.dat`, `u123 - 3040`), by {@link FAMILY_IDS}. */
export function partFamily(part: string): PartFamily {
  const stem = partStem(part).toLowerCase();
  const base = stem.replace(/[a-z]+$/, '');
  for (const f of ['slope', 'arch', 'round'] as const) if (FAMILY_IDS[f].has(stem) || FAMILY_IDS[f].has(base)) return f;
  return 'other';
}

/** Part-type diversity of a brick list. */
export interface PartDiversity {
  parts: number;
  distinct: number;
  slopeShare: number;
  archShare: number;
  roundShare: number;
}

/** Share of slopes / arches / rounds and the number of distinct part ids; `classify` overrides the id table. */
export function partDiversity(parts: readonly string[], classify: (part: string) => PartFamily = partFamily): PartDiversity {
  const count = { slope: 0, arch: 0, round: 0, other: 0 };
  for (const p of parts) count[classify(p)]++;
  const n = parts.length;
  const share = (k: number): number => (n === 0 ? 0 : k / n);
  return { parts: n, distinct: new Set(parts.map((p) => partStem(p).toLowerCase())).size, slopeShare: share(count.slope), archShare: share(count.arch), roundShare: share(count.round) };
}

// ---------------------------------------------------------------------------------------------------------
// Silhouettes

/** Drawn height of a plate layer in lattice drawing units, exposed for tests. */
const cellBox = (x: number, p: number, z: number): [V3, V3] => [[x, p * PLATE_RATIO, z], [x + 1, (p + 1) * PLATE_RATIO, z + 1]];

/** Outward faces of every filled cell with an empty neighbour, in 1/16 units; `key` is the cell's label (its colour). Shifted by `shift`. */
export function latticeQuads(l: IntentLattice, shift: Shift = [0, 0, 0], owner = 0): RasterQuad[] {
  const quads: RasterQuad[] = [];
  const s = (v: V3): V3 => [v[0] * SIXTEENTHS, v[1] * SIXTEENTHS, v[2] * SIXTEENTHS];
  for (let p = 0; p < l.dims[1]; p++) for (let z = 0; z < l.dims[2]; z++) for (let x = 0; x < l.dims[0]; x++) {
    const cell = l.cells[latticeIndex(l.dims, x, p, z)]!;
    if (cell === 0) continue;
    const [lo, hi] = cellBox(x + shift[0], p + shift[1], z + shift[2]);
    const key = String(cell);
    const face = (normal: V3, c: [V3, V3, V3, V3]): void => { quads.push({ corners: [s(c[0]), s(c[1]), s(c[2]), s(c[3])], normal, key, owner }); };
    if (!filledAt(l, x - 1, p, z)) face([-1, 0, 0], [[lo[0], lo[1], lo[2]], [lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]]]);
    if (!filledAt(l, x + 1, p, z)) face([1, 0, 0], [[hi[0], lo[1], hi[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]]]);
    if (!filledAt(l, x, p - 1, z)) face([0, -1, 0], [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [lo[0], lo[1], hi[2]]]);
    if (!filledAt(l, x, p + 1, z)) face([0, 1, 0], [[lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]]);
    if (!filledAt(l, x, p, z - 1)) face([0, 0, -1], [[hi[0], lo[1], lo[2]], [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]]]);
    if (!filledAt(l, x, p, z + 1)) face([0, 0, 1], [[lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]]);
  }
  return quads;
}

/** Drawing-unit bounding box (min, max) of the union of lattices, each moved by its shift. */
export function drawnBounds(items: ReadonlyArray<{ lattice: IntentLattice; shift?: Shift }>): [V3, V3] {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const { lattice: l, shift = [0, 0, 0] } of items) {
    lo[0] = Math.min(lo[0], shift[0]); lo[1] = Math.min(lo[1], shift[1] * PLATE_RATIO); lo[2] = Math.min(lo[2], shift[2]);
    hi[0] = Math.max(hi[0], l.dims[0] + shift[0]); hi[1] = Math.max(hi[1], (l.dims[1] + shift[1]) * PLATE_RATIO); hi[2] = Math.max(hi[2], l.dims[2] + shift[2]);
  }
  return [lo, hi];
}

/** A named view direction: the unit vector from the model towards the camera. */
export interface ViewSpec { name: string; dir: V3; up?: V3 }

/** The six axis views (camera on +x, -x, +y, -y, +z, -z). */
export const AXIS_VIEWS: readonly ViewSpec[] = [
  { name: '+x', dir: [1, 0, 0] }, { name: '-x', dir: [-1, 0, 0] },
  { name: '+y', dir: [0, 1, 0], up: [0, 0, -1] }, { name: '-y', dir: [0, -1, 0], up: [0, 0, 1] },
  { name: '+z', dir: [0, 0, 1] }, { name: '-z', dir: [0, 0, -1] },
];

/** Near-orthographic camera framing `bounds` from direction `dir`, `size` pixels square, `margin` of padding. */
export function framedCamera(bounds: readonly [V3, V3], spec: ViewSpec, size: number, margin = 1.1): RasterCamera {
  const [lo, hi] = bounds;
  const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const radius = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2, 1e-6);
  const dist = radius * 200; // far enough that perspective is below a pixel
  const n = Math.hypot(...spec.dir) || 1;
  const eye: V3 = [centre[0] + (spec.dir[0] / n) * dist, centre[1] + (spec.dir[1] / n) * dist, centre[2] + (spec.dir[2] / n) * dist];
  const fovDeg = (2 * Math.atan((radius * margin) / dist) * 180) / Math.PI;
  return { eye, at: centre, ...(spec.up ? { up: spec.up } : {}), fovDeg, width: size, height: size };
}

/** A rendered view: its coverage mask (1 where a face is drawn), flat-colour RGB, and size. */
export interface View { width: number; height: number; mask: Uint8Array; rgb: Uint8Array }

/** Render a lattice (flat label colours, no shading) from `cam`; `shift` moves it against the other lattice being compared. */
export function renderView(l: IntentLattice, cam: RasterCamera, shift: Shift = [0, 0, 0]): View {
  const quads = latticeQuads(l, shift);
  const colours = new Map<string, V3>();
  const r = rasterizeDetailed(quads, (q) => {
    let c = colours.get(q.key!);
    if (!c) { const [R, G, B] = labelRgb(l, Number(q.key)); c = [R / 255, G / 255, B / 255]; colours.set(q.key!, c); }
    return { rgb: c, alpha: 1 };
  }, cam);
  const mask = new Uint8Array(r.width * r.height);
  for (let i = 0; i < mask.length; i++) mask[i] = Number.isFinite(r.depth[i]!) ? 1 : 0;
  return { width: r.width, height: r.height, mask, rgb: r.rgb };
}

/** IoU of two equally sized masks; two empty masks are identical (1). */
export function maskIoU(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new RangeError(`maskIoU: sizes differ (${a.length} vs ${b.length})`);
  let inter = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] !== 0, y = b[i] !== 0;
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/** Per-view silhouette result. */
export interface SilhouetteResult { view: string; iou: number }

/**
 * Silhouette IoU of `b` (moved by `shift`) against `a` for each view, both framed by the union of their bounds so
 * the two pictures share one camera. `cameras` adds free views to the six axis ones.
 */
export function silhouetteIoUs(a: IntentLattice, b: IntentLattice, options: { shift?: Shift; size?: number; views?: readonly ViewSpec[] } = {}): SilhouetteResult[] {
  const shift = options.shift ?? [0, 0, 0];
  const size = options.size ?? 128;
  const bounds = drawnBounds([{ lattice: a }, { lattice: b, shift }]);
  return (options.views ?? AXIS_VIEWS).map((v) => {
    const cam = framedCamera(bounds, v, size);
    return { view: v.name, iou: maskIoU(renderView(a, cam).mask, renderView(b, cam, shift).mask) };
  });
}

/**
 * IoU of a lattice's silhouette against a REFERENCE mask (a rendered or photographed outline of `size` x `size`
 * pixels framed by `cam`); the caller owns the camera, so a reference image and a lattice view line up.
 */
export function silhouetteIoUToMask(l: IntentLattice, referenceMask: Uint8Array, cam: RasterCamera, shift: Shift = [0, 0, 0]): number {
  return maskIoU(renderView(l, cam, shift).mask, referenceMask);
}

// ---------------------------------------------------------------------------------------------------------
// Report + contact sheet

/** Everything {@link measureLattices} returns; JSON-serialisable. */
export interface MetricsReport {
  voxel: VoxelIoUResult;
  silhouettes: SilhouetteResult[];
  silhouetteMean: number;
  silhouetteMin: number;
  colour: { median: number; matched: number };
  connectivity: { reference: ConnectivityStats; generated: ConnectivityStats };
  diversity?: PartDiversity;
}

/** Score `generated` against `reference`: voxel IoU (aligned), silhouettes, colour, connectivity, optional part diversity. */
export function measureLattices(reference: IntentLattice, generated: IntentLattice, options: { maxShift?: number; size?: number; views?: readonly ViewSpec[]; parts?: readonly string[] } = {}): MetricsReport {
  const voxel = voxelIoU(reference, generated, options.maxShift ?? 2);
  const silhouettes = silhouetteIoUs(reference, generated, { shift: voxel.shift, ...(options.size ? { size: options.size } : {}), ...(options.views ? { views: options.views } : {}) });
  const ious = silhouettes.map((s) => s.iou);
  return {
    voxel, silhouettes,
    silhouetteMean: ious.reduce((s, v) => s + v, 0) / Math.max(1, ious.length),
    silhouetteMin: Math.min(...ious),
    colour: medianCellDeltaE(reference, generated, voxel.shift),
    connectivity: { reference: connectivity(reference), generated: connectivity(generated) },
    ...(options.parts ? { diversity: partDiversity(options.parts) } : {}),
  };
}

/** Longest side the sheet may have: the project's screenshot rule (never 2000 px or more). */
export const MAX_SHEET_PX = 1999;

/**
 * A contact sheet: for each of the six axis views a row cell of reference | generated | difference (green = both,
 * red = reference only, blue = generated only), `tile` pixels each, scaled down so neither side exceeds 1999 px.
 */
export function contactSheet(reference: IntentLattice, generated: IntentLattice, options: { shift?: Shift; tile?: number; views?: readonly ViewSpec[] } = {}): { width: number; height: number; rgb: Uint8Array } {
  const views = options.views ?? AXIS_VIEWS;
  const shift = options.shift ?? [0, 0, 0];
  const tile = Math.max(8, Math.min(options.tile ?? 160, Math.floor(MAX_SHEET_PX / 3)));
  const rows = views.length;
  // 3 tiles across; shrink the tile when many views would pass the pixel cap.
  const fit = Math.min(tile, Math.floor(MAX_SHEET_PX / rows));
  const t = Math.max(8, fit);
  const W = t * 3, H = t * rows;
  const rgb = new Uint8Array(W * H * 3).fill(20);
  const bounds = drawnBounds([{ lattice: reference }, { lattice: generated, shift }]);
  views.forEach((v, row) => {
    const cam = framedCamera(bounds, v, t);
    const A = renderView(reference, cam), B = renderView(generated, cam, shift);
    const put = (col: number, x: number, y: number, r: number, g: number, b: number): void => {
      const o = ((row * t + y) * W + col * t + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    };
    for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) {
      const i = y * t + x;
      if (A.mask[i]) put(0, x, y, A.rgb[i * 3]!, A.rgb[i * 3 + 1]!, A.rgb[i * 3 + 2]!);
      if (B.mask[i]) put(1, x, y, B.rgb[i * 3]!, B.rgb[i * 3 + 1]!, B.rgb[i * 3 + 2]!);
      const a = A.mask[i] !== 0, b = B.mask[i] !== 0;
      if (a && b) put(2, x, y, 60, 200, 90); else if (a) put(2, x, y, 220, 60, 60); else if (b) put(2, x, y, 70, 110, 230);
    }
  });
  return { width: W, height: H, rgb };
}
