/**
 * Edge geometry and openings (A08, BIZ-05): a feature stands on one edge of a volume's footprint, at a distance along
 * it and a height up it; this file maps those to lattice cells and cuts window / arch / door openings through the wall.
 *
 * An opening is a box of `window`-role cells replacing wall cells. The X-10 bricker fits a window or door frame
 * where the cells match the frame's own occupancy, and leaves every other `window` cell an open hole, so an opening
 * is the size A9 asked for whether or not a frame part exists for it.
 */
import { outerEdges, type EdgeInfo } from '../features/frame.js';
import type { MassVolume } from '../types.js';
import type { Canvas } from './canvas.js';
import { cellOf, type Frame } from './frame.js';

/** An edge of a volume with the mapping from (stud along it, studs outward) to lattice cells. */
export interface EdgeFrame {
  edge: EdgeInfo;
  /** Edge length in studs. */
  studs: number;
  /** The lattice cell `[x, z]` at stud `u` along the edge (from its start) and `v` studs out from the wall cell (v = 0 is the wall cell itself). */
  cell(u: number, v: number): [number, number];
}

/** The edge frames of a volume, by ring index. */
export function edgeFrames(v: MassVolume, f: Frame): Map<number, EdgeFrame> {
  const out = new Map<number, EdgeFrame>();
  for (const edge of outerEdges(v)) {
    out.set(edge.index, {
      edge,
      studs: edge.length * f.spm,
      cell(u, vOut) {
        const along = (u + 0.5) / f.spm;
        const out_ = (vOut - 0.5) / f.spm;
        return [cellOf(f, edge.a[0] + edge.dir[0] * along + edge.normal[0] * out_), cellOf(f, edge.a[1] + edge.dir[1] * along + edge.normal[1] * out_)];
      },
    });
  }
  return out;
}

/** Centres (metres along the edge) of the items of a run: `count` items `spacingM` apart around the centre `atM`. */
export function runCentres(atM: number, count: number | undefined, spacingM: number | undefined): number[] {
  const n = Math.max(1, count ?? 1);
  const sp = spacingM ?? 0;
  return Array.from({ length: n }, (_, i) => atM + (i - (n - 1) / 2) * sp);
}

/** Plate levels of a volume on the canvas: where its walls start and where its ceiling begins. */
export function volumeLevels(v: MassVolume, f: Frame): { baseP: number; topP: number; wallFrom: number } {
  const baseP = Math.round(v.baseM * f.ppm) + f.basePlates, topP = Math.round(v.topM * f.ppm) + f.basePlates;
  const grounded = baseP === f.basePlates;
  return { baseP, topP, wallFrom: grounded ? baseP : baseP + 2 };
}

/** Wall cells a cut may replace: the volume's own wall and trim. */
export function isWall(canvas: Canvas, x: number, p: number, z: number): boolean {
  const l = canvas.labelAt(x, p, z);
  return l !== undefined && (l.role === 'wall' || l.role === 'trim');
}

/**
 * Replace the wall cells of an opening with `label` (a cell value). `mask` is row-major over `w` studs from `u0`,
 * row 0 the plate `p0`. Returns how many cells were cut.
 */
export function cutOpening(canvas: Canvas, ef: EdgeFrame, u0: number, p0: number, w: number, h: number, mask: Uint8Array, label: number): number {
  let cut = 0;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    if (!mask[row * w + col]) continue;
    const u = u0 + col;
    if (u < 0 || u >= ef.studs) continue;
    const [x, z] = ef.cell(u, 0);
    if (isWall(canvas, x, p0 + row, z)) { canvas.set(x, p0 + row, z, label); cut++; }
  }
  return cut;
}

/** Recolour the wall cells of a row (a sill, a string course) to `label`. */
export function paintRow(canvas: Canvas, ef: EdgeFrame, u0: number, w: number, p: number, label: number): void {
  for (let col = 0; col < w; col++) {
    const u = u0 + col;
    if (u < 0 || u >= ef.studs) continue;
    const [x, z] = ef.cell(u, 0);
    if (isWall(canvas, x, p, z)) canvas.set(x, p, z, label);
  }
}
