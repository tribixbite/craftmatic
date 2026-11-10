/**
 * The grammar's drawing surface (A07/A08, BIZ-05): a lattice under construction.
 *
 * Every grammar writes cells through one `Canvas`, so labels are interned once (a label is one role + colour +
 * feature + slope, never two copies of the same thing), writes outside the lattice are counted rather than thrown,
 * and the result is the `IntentLattice` the X-10 bricker reads. Cell frame as `types.ts`: x east, z south, `plate` up.
 */
import type { IntentLabel, IntentLattice } from '../types.js';

/** A label in the interned table (the cell value is `1 + index`). */
export type LabelSpec = IntentLabel;

export class Canvas {
  readonly W: number;
  readonly H: number;
  readonly D: number;
  readonly cells: Uint16Array;
  readonly labels: IntentLabel[] = [];
  private readonly index = new Map<string, number>();
  /** Writes that fell outside the lattice (a roof taller than the allowance); reported, never silently lost. */
  clipped = 0;

  constructor(W: number, H: number, D: number) {
    this.W = W; this.H = H; this.D = D;
    this.cells = new Uint16Array(W * H * D);
  }

  /** Cell value (1-based) of a label, adding it to the table the first time it is seen. */
  label(l: LabelSpec): number {
    const key = `${l.role}|${l.colour}|${l.feature ?? ''}|${l.slope ? `${l.slope.dir}.${l.slope.rise}` : ''}|${l.hollowOk ? 1 : 0}`;
    let k = this.index.get(key);
    if (k === undefined) {
      k = this.labels.length + 1;
      if (k > 0xffff) throw new RangeError('canvas: more than 65535 distinct labels');
      this.labels.push({ ...l });
      this.index.set(key, k);
    }
    return k;
  }

  inside(x: number, p: number, z: number): boolean { return x >= 0 && p >= 0 && z >= 0 && x < this.W && p < this.H && z < this.D; }
  idx(x: number, p: number, z: number): number { return (p * this.D + z) * this.W + x; }

  /** Cell value at a position; 0 outside the lattice. */
  get(x: number, p: number, z: number): number { return this.inside(x, p, z) ? this.cells[this.idx(x, p, z)]! : 0; }

  /** The label at a position, or undefined for an empty cell. */
  labelAt(x: number, p: number, z: number): IntentLabel | undefined {
    const v = this.get(x, p, z);
    return v === 0 ? undefined : this.labels[v - 1];
  }

  /** Write a cell value (0 clears). A write outside the lattice is counted in `clipped`. */
  set(x: number, p: number, z: number, value: number): void {
    if (!this.inside(x, p, z)) { if (value !== 0) this.clipped++; return; }
    this.cells[this.idx(x, p, z)] = value;
  }

  /** Fill the plate layers `[p0, p1)` of one stud column. */
  column(x: number, z: number, p0: number, p1: number, value: number): void {
    for (let p = p0; p < p1; p++) this.set(x, p, z, value);
  }

  /** Fill a box `[x0, x1) x [p0, p1) x [z0, z1)`. */
  box(x0: number, p0: number, z0: number, x1: number, p1: number, z1: number, value: number): void {
    for (let p = p0; p < p1; p++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) this.set(x, p, z, value);
  }

  /** The lattice as the bricker reads it. */
  toLattice(): IntentLattice { return { dims: [this.W, this.H, this.D], cells: this.cells, labels: this.labels }; }

  /**
   * Remove every filled cell that is not face-connected to plate layer 0 (a sliver cut off when one volume was carved
   * out of another). Returns how many cells were removed.
   */
  removeStranded(): number {
    const { W, H, D, cells } = this;
    const reached = new Uint8Array(cells.length);
    const queue = new Int32Array(cells.length);
    let tail = 0;
    for (let i = 0; i < W * D; i++) if (cells[i]) { reached[i] = 1; queue[tail++] = i; }
    const L = W * D;
    for (let head = 0; head < tail; head++) {
      const i = queue[head]!;
      const x = i % W, z = Math.floor(i / W) % D, p = Math.floor(i / L);
      const visit = (j: number): void => { if (cells[j] && !reached[j]) { reached[j] = 1; queue[tail++] = j; } };
      if (x > 0) visit(i - 1);
      if (x < W - 1) visit(i + 1);
      if (z > 0) visit(i - W);
      if (z < D - 1) visit(i + W);
      if (p > 0) visit(i - L);
      if (p < H - 1) visit(i + L);
    }
    let removed = 0;
    for (let i = 0; i < cells.length; i++) if (cells[i] && !reached[i]) { cells[i] = 0; removed++; }
    return removed;
  }
}
