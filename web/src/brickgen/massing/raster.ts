/**
 * Cell masks to rings (MQ2, BIZ-05/BIZ-11).
 *
 * Massing works on polygons, but two of its jobs are easier on the stud grid itself: "the part of an outline that no
 * building:part covers" (a boolean difference) and "the part of a sloped footprint above a given height" (a terrace of
 * a skillion). Both are answered per stud cell, and a mask of cells is turned back into integer-coordinate rings here,
 * so no polygon-clipping library is needed and every ring is already on the stud grid (axis-aligned, integer).
 */
import type { Vec2m } from '../types.js';
import { dropCollinear, pointInRing, ringArea, signedArea } from './geometry.js';

/** One connected region of a mask: its outer ring and the rings of the holes inside it (cell-corner coordinates). */
export interface RasterRegion { outer: Vec2m[]; holes: Vec2m[][] }

/** A bit mask over a `w` x `d` cell grid whose cell (i, j) covers [i, i+1) x [j, j+1). */
export interface CellMask { w: number; d: number; cells: Uint8Array }

/** An empty mask. */
export function newMask(w: number, d: number): CellMask { return { w, d, cells: new Uint8Array(w * d) }; }

const at = (m: CellMask, i: number, j: number): boolean => i >= 0 && j >= 0 && i < m.w && j < m.d && m.cells[i + m.w * j] === 1;

/**
 * Morphological opening with the 4-neighbourhood: a strip two cells wide or less (the sliver left beside a part whose
 * edge and the outline's never align exactly) disappears, anything wider keeps its shape.
 */
export function openMask(m: CellMask): CellMask {
  const eroded = newMask(m.w, m.d);
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    if (at(m, i, j) && at(m, i - 1, j) && at(m, i + 1, j) && at(m, i, j - 1) && at(m, i, j + 1)) eroded.cells[i + m.w * j] = 1;
  }
  const out = newMask(m.w, m.d);
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    if (at(m, i, j) && (at(eroded, i, j) || at(eroded, i - 1, j) || at(eroded, i + 1, j) || at(eroded, i, j - 1) || at(eroded, i, j + 1))) out.cells[i + m.w * j] = 1;
  }
  return out;
}

/** Number of filled cells. */
export function maskCount(m: CellMask): number {
  let n = 0;
  for (const c of m.cells) n += c;
  return n;
}

/**
 * The boundary of a mask as rings, in a frame where x runs right and z runs down. Every edge is directed with the filled
 * cell on its right, so outer rings come out with positive signed area and holes with negative. Where two cells touch
 * only at a corner the walk turns right (hugs the filled side), so such cells stay separate regions.
 * Returns regions with collinear vertices removed; each hole is assigned to the smallest outer ring that contains it.
 */
export function traceMask(m: CellMask): RasterRegion[] {
  const key = (x: number, z: number): number => z * (m.w + 1) + x;
  type Edge = { x0: number; z0: number; x1: number; z1: number; used: boolean };
  const out = new Map<number, Edge[]>();
  const add = (x0: number, z0: number, x1: number, z1: number): void => {
    const e: Edge = { x0, z0, x1, z1, used: false };
    const k = key(x0, z0);
    const list = out.get(k);
    if (list) list.push(e); else out.set(k, [e]);
  };
  for (let j = 0; j < m.d; j++) for (let i = 0; i < m.w; i++) {
    if (!at(m, i, j)) continue;
    if (!at(m, i, j - 1)) add(i, j, i + 1, j);
    if (!at(m, i + 1, j)) add(i + 1, j, i + 1, j + 1);
    if (!at(m, i, j + 1)) add(i + 1, j + 1, i, j + 1);
    if (!at(m, i - 1, j)) add(i, j + 1, i, j);
  }
  const loops: Vec2m[][] = [];
  for (const list of out.values()) for (const first of list) {
    if (first.used) continue;
    const ring: Vec2m[] = [];
    let e = first;
    for (;;) {
      e.used = true;
      ring.push([e.x0, e.z0]);
      const next = (out.get(key(e.x1, e.z1)) ?? []).filter(c => !c.used || c === first);
      if (next.length === 0) break;
      const dx = e.x1 - e.x0, dz = e.z1 - e.z0;
      // The sharpest right turn: cross > 0 is clockwise on screen, with the filled side on the right.
      next.sort((a, b) => (dx * (b.z1 - b.z0) - dz * (b.x1 - b.x0)) - (dx * (a.z1 - a.z0) - dz * (a.x1 - a.x0)));
      const n = next[0]!;
      if (n === first) break;
      e = n;
    }
    if (ring.length >= 4) loops.push(ring);
  }
  const tidy = (ring: Vec2m[]): Vec2m[] => dropCollinear(ring.map(([x, z], i) => ({ x, z, src: i }))).map(p => [p.x, p.z] as Vec2m);
  const outers = loops.filter(l => signedArea(l) > 0).map(tidy).filter(r => r.length >= 4);
  const holes = loops.filter(l => signedArea(l) < 0).map(tidy).filter(r => r.length >= 4);
  const regions: RasterRegion[] = outers.map(outer => ({ outer, holes: [] }));
  for (const h of holes) {
    // A point just to the right of the hole's first edge lies in a filled cell, hence inside the containing outer ring.
    const [ax, az] = h[0]!, [bx, bz] = h[1]!;
    const px = (ax + bx) / 2 + 0.5 * -(bz - az) / Math.max(1e-9, Math.hypot(bx - ax, bz - az));
    const pz = (az + bz) / 2 + 0.5 * (bx - ax) / Math.max(1e-9, Math.hypot(bx - ax, bz - az));
    let best: RasterRegion | undefined;
    for (const r of regions) if (pointInRing(px, pz, r.outer) && (!best || ringArea(r.outer) < ringArea(best.outer))) best = r;
    best?.holes.push(h);
  }
  return regions;
}
