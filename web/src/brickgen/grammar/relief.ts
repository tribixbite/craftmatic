/**
 * Relief grammars (A08, BIZ-05): what stands out of or on top of a wall: buttresses, pilasters, cornices, balustrades,
 * battlements, balconies, gargoyles, statues, pinnacles, chimneys, and the flying buttress.
 *
 * Connection rule for everything that stands OUT of a wall: studs join only vertically, so a relief cell next to a
 * wall cell is not joined to it. Every relief therefore takes the wall's own cell along its inner edge (`v = 0`) as
 * well, so the bricker lays one element across wall and relief and its studs bond to the wall courses above and
 * below. A relief that stands on the ground (a buttress) is also joined through the base plate.
 */
import type { MassVolume } from '../types.js';
import { elementFor, occupancyIndex } from '../vocab/index.js';
import type { Canvas } from './canvas.js';
import { plateOf, type Frame } from './frame.js';
import type { Mask } from './footprint.js';
import { isWall, type EdgeFrame } from './window.js';

/** What every relief needs. */
export interface ReliefContext {
  canvas: Canvas;
  frame: Frame;
}

/**
 * Cells out of a wall: `w` studs from `u0` along the edge, plates `[p0, p1)`, `depthAt(row, rows)` studs out (the wall
 * cell `v = 0` is always included where it is wall). Outward cells are written only where the canvas is empty, so a
 * relief never overwrites other geometry. Returns the cells written.
 */
export function placeRelief(ctx: ReliefContext, ef: EdgeFrame, u0: number, w: number, p0: number, p1: number, depthAt: (row: number, rows: number) => number, label: number, every = 1): number {
  let n = 0;
  for (let p = p0; p < p1; p++) {
    const depth = depthAt(p - p0, p1 - p0);
    for (let col = 0; col < w; col++) {
      if (every > 1 && col % every !== 0) continue;
      const u = u0 + col;
      if (u < 0 || u >= ef.studs) continue;
      for (let v = 0; v <= depth; v++) {
        const [x, z] = ef.cell(u, v);
        if (v === 0) { if (isWall(ctx.canvas, x, p, z)) { ctx.canvas.set(x, p, z, label); n++; } continue; }
        if (ctx.canvas.get(x, p, z) === 0 && ctx.canvas.inside(x, p, z)) { ctx.canvas.set(x, p, z, label); n++; }
      }
    }
  }
  return n;
}

/** A buttress: full depth for the lower part, then set back a stud at a time to the top (never below one stud). */
export function buttressDepth(depthMax: number): (row: number, rows: number) => number {
  return (row, rows) => {
    const t = row / Math.max(1, rows - 1);
    if (t <= 0.55) return depthMax;
    return Math.max(1, Math.round(depthMax * (1 - (t - 0.55) / 0.45)));
  };
}

/** The cone part for a square cap of `side` studs (1, 2 or 4): the part and its height in plates. */
const CONE_PARTS: Readonly<Record<number, string>> = { 1: '4589.dat', 2: '3942c.dat', 4: '272.dat' };

/**
 * A pinnacle: a square shaft with a cone on top, standing on the wall top. `w` studs square (1, 2 or 4 get a real cone
 * part; another size is capped by the largest cone that fits, centred), centred on stud `uCentre` of the edge and
 * inside the wall line.
 *
 * Only the cone's BODY cells carry the cone label (read from the part's own occupancy); the cells above them, where the
 * cone narrows, stay empty. The bricker refuses a slope or cone with anything labelled over its body, and labelling the
 * part's whole envelope would do just that.
 */
export function placePinnacle(ctx: ReliefContext, ef: EdgeFrame, uCentre: number, w: number, p0: number, heightPlates: number, shaft: number, cone: number): number {
  const side = Math.max(1, w);
  const capSide = side >= 4 ? 4 : side >= 2 ? 2 : 1;
  const element = elementFor(CONE_PARTS[capSide]!)!;
  const [fx, fz] = element.footprint;
  const shaftH = Math.max(0, heightPlates - element.heightPlates);
  let n = 0;
  const u0 = Math.round(uCentre - side / 2);
  for (let a = 0; a < side; a++) for (let b = 0; b < side; b++) {
    const [x, z] = ef.cell(u0 + a, -b);
    for (let p = p0; p < p0 + shaftH; p++) { ctx.canvas.set(x, p, z, shaft); n++; }
    // The cap sits in the middle of the shaft: its cell (ca, cb) within the cone's footprint.
    const ca = a - Math.floor((side - capSide) / 2), cb = b - Math.floor((side - capSide) / 2);
    if (ca < 0 || ca >= fx || cb < 0 || cb >= fz) continue;
    for (let layer = 0; layer < element.heightPlates; layer++) {
      if (element.occupancy && element.occupancy[occupancyIndex(fx, fz, ca, cb, layer)] === 0) continue;
      ctx.canvas.set(x, p0 + shaftH + layer, z, cone); n++;
    }
  }
  return n;
}

/** A solid box of `label` from world cell `(x0, z0)` of `w x d` studs, plates `[p0, p1)`. Empty cells only. */
export function placeBox(ctx: ReliefContext, x0: number, z0: number, w: number, d: number, p0: number, p1: number, label: number): number {
  let n = 0;
  for (let p = p0; p < p1; p++) for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) {
    if (ctx.canvas.get(x, p, z) === 0 && ctx.canvas.inside(x, p, z)) { ctx.canvas.set(x, p, z, label); n++; }
  }
  return n;
}

/** What a flying buttress needs to know about the volume that stands for it. */
export interface StrutInput {
  volume: MassVolume;
  mask: Mask;
  /** Plates the outer end drops below the inner end (the rise A9 measured). */
  dropPlates: number;
  label: number;
}

/**
 * A flying buttress built on the footprint of the (thin) volume that stands for it: a pier at the outer end and a strut
 * that climbs from the pier's top to the wall it braces, open underneath. The inner end is the end beside a taller
 * volume's wall (the filled cell next to it), else the first. The strut is as thick as its slope needs to keep its
 * columns overlapping, so the bricker can bond it into one element run. Returns the cells written.
 */
export function placeStrut(ctx: ReliefContext, s: StrutInput): number {
  const { canvas, frame } = ctx;
  const { mask } = s;
  const alongX = mask.w >= mask.d;
  const n = alongX ? mask.w : mask.d;
  const wAcross = alongX ? mask.d : mask.w;
  const topHi = plateOf(frame, s.volume.topM);
  const cellAt = (i: number, a: number): [number, number] => (alongX ? [mask.x0 + i, mask.z0 + a] : [mask.x0 + a, mask.z0 + i]);
  const filledBeside = (i: number): number => {
    let c = 0;
    for (let a = 0; a < wAcross; a++) { const [x, z] = cellAt(i, a); for (let p = Math.max(0, topHi - 8); p <= topHi; p++) if (canvas.get(x, p, z)) c++; }
    return c;
  };
  // The inner end touches a taller wall: check the cell row just past each end.
  const innerAtStart = filledBeside(-1) >= filledBeside(n);
  const drop = Math.min(s.dropPlates, Math.max(0, topHi - frame.basePlates - 3));
  const slope = n > 1 ? drop / (n - 1) : 0;
  const thickness = Math.max(3, Math.ceil(slope * 1.5) + 2);
  const pierLen = Math.min(2, n);
  let cells = 0;
  for (let i = 0; i < n; i++) {
    const k = innerAtStart ? i : n - 1 - i; // distance from the inner end
    const top = Math.round(topHi - slope * k) + 1;
    const outer = k >= n - pierLen;
    const bottom = outer ? frame.basePlates : Math.max(frame.basePlates, top - thickness);
    for (let a = 0; a < wAcross; a++) {
      const [x, z] = cellAt(i, a);
      if (!mask.inside[(x - mask.x0) + mask.w * (z - mask.z0)]) continue;
      for (let p = bottom; p < top; p++) { canvas.set(x, p, z, s.label); cells++; }
    }
  }
  return cells;
}
