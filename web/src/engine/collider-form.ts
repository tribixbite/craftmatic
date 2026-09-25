/**
 * The FORMS a collider block can take, and the one function that turns any set
 * of boxes inside a block into the form that contains them (design:
 * docs/bedrock-interactivity.md, "Clearance: colliders pulled back to the
 * geometry").
 *
 * A collider block used to be one box over the WHOLE footprint, `lo..hi`
 * sixteenths high. A form adds a horizontal SHAPE - a band a quarter-block
 * multiple wide along x or z - so a wall's collider is the wall's thickness,
 * not the block:
 *
 *   v = 0            `craftmatic:collider`       full footprint, lo..hi (unchanged)
 *   kind 0 (wall)    `craftmatic:collider_w<s>`  shape s, lo..hi
 *   kind 1 (floor)   `craftmatic:collider_f<s>`  full lo..hi, then shape s from hi to the block top
 *   kind 2 (ceiling) `craftmatic:collider_c<s>`  shape s from the block bottom to lo, then full lo..hi
 *
 * Every form uses the same two states (`craftmatic:lo`, `craftmatic:hi`), so a
 * form is (variant, lo, hi) and a block is one of 43 ids. Bedrock allows a
 * collision box anywhere inside the block (origin -8,0,-8 to 8,16,8) and, since
 * format 1.26.0, an array of up to 16 boxes (Microsoft Learn,
 * minecraft:collision_box); a state holds at most 16 values, so shapes are ids
 * rather than a third state (43 x 256 registered permutations, 136 condition
 * entries each, instead of one block with 43 x 256 states and 5,848 entries).
 *
 * `colliderFormKit` is PLAIN JavaScript with no outside reference: the pack's
 * runtimes (the Brick Wand's re-lay, the doorway runtime) receive it
 * serialised with `.toString()` exactly as the build, the walk harness and the
 * tests use it, so there is one implementation of "which blocks does a cell
 * lay at this size and turn".
 */

/** A box inside one block, sixteenths: [x0, x1, y0, y1, z0, z1], each pair ascending. */
export type Box16 = [number, number, number, number, number, number];

/** One collider variant: its block id, kind (0 wall, 1 floor + wall, 2 wall + ceiling) and horizontal shape. */
export interface ColliderVariant { id: string; kind: 0 | 1 | 2; shape: number }

/** A collider block's form: variant index (0 = the full-footprint `craftmatic:collider`) and its lo/hi states. */
export interface ColliderForm { v: number; lo: number; hi: number }

/** The kit (see the module header). */
export interface ColliderFormKit {
  /** Horizontal shapes, sixteenths [x0, x1, z0, z1]; index 0 is the full footprint. */
  SHAPES: ReadonlyArray<readonly [number, number, number, number]>;
  /** Variant table, index = the `v` of a form. */
  VARIANTS: readonly ColliderVariant[];
  /** Variant index of a block id, or -1 when it is not a collider. */
  variantOf(id: string): number;
  /** The boxes a form's collision box consists of. */
  formBoxes(v: number, lo: number, hi: number): Box16[];
  /** The form of least volume containing every box (null for none); a full-footprint result is always v = 0. */
  cover(boxes: ReadonlyArray<readonly number[]>): ColliderForm | null;
  /** The form turned by a quarter turn about the vertical (the wand's placement turn). */
  turnForm(form: ColliderForm, r: number): ColliderForm;
  /**
   * The world pieces one grid cell lays at wand factor `f` and quarter turn
   * `r`: `emit(wx, wy, wz, box)` for every world block (relative to the
   * anchor) the cell's form reaches, with the part of the form in that block
   * (sixteenths, rounded outward). The columns a cell owns are the re-lay's
   * (`cellColumns`: centre rule at f >= 1, any overlap below); rows follow the
   * continuous scale. Below 100 % a piece is widened to the full footprint
   * (several cells share a block there).
   */
  cellPieces(x: number, y: number, z: number, v: number, lo: number, hi: number, dims: { width: number; length: number }, f: number, r: number, emit: (wx: number, wy: number, wz: number, box: Box16) => void): void;
}

export function colliderFormKit(): ColliderFormKit {
  const BANDS = [[0, 4], [0, 8], [0, 12], [4, 16], [8, 16], [12, 16], [4, 12]];
  const SHAPES: Array<[number, number, number, number]> = [[0, 16, 0, 16]];
  for (const b of BANDS) SHAPES.push([b[0]!, b[1]!, 0, 16]);
  for (const b of BANDS) SHAPES.push([0, 16, b[0]!, b[1]!]);
  const TAG = ['w', 'f', 'c'];
  const VARIANTS: ColliderVariant[] = [{ id: 'craftmatic:collider', kind: 0, shape: 0 }];
  for (let k = 0; k < 3; k++) for (let s = 1; s < SHAPES.length; s++) VARIANTS.push({ id: 'craftmatic:collider_' + TAG[k] + s, kind: k as 0 | 1 | 2, shape: s });
  const byId: Record<string, number> = {};
  VARIANTS.forEach((d, i) => { byId[d.id] = i; });
  const vid = (kind: number, s: number): number => s === 0 ? 0 : 1 + kind * (SHAPES.length - 1) + (s - 1);
  const area = (s: number): number => (SHAPES[s]![1] - SHAPES[s]![0]) * (SHAPES[s]![3] - SHAPES[s]![2]);
  /** The smallest shape containing a footprint (ties: lowest index). */
  const smallest = (x0: number, x1: number, z0: number, z1: number): number => {
    let best = 0;
    for (let s = 1; s < SHAPES.length; s++) {
      const q = SHAPES[s]!;
      if (q[0] <= x0 && q[1] >= x1 && q[2] <= z0 && q[3] >= z1 && area(s) < area(best)) best = s;
    }
    return best;
  };
  const formBoxes = (v: number, lo: number, hi: number): Box16[] => {
    const d = VARIANTS[v]!, q = SHAPES[d.shape]!;
    if (d.kind === 0) return [[q[0], q[1], lo, hi, q[2], q[3]]];
    if (d.kind === 1) return hi < 16 ? [[0, 16, lo, hi, 0, 16], [q[0], q[1], hi, 16, q[2], q[3]]] : [[0, 16, lo, hi, 0, 16]];
    return lo > 0 ? [[q[0], q[1], 0, lo, q[2], q[3]], [0, 16, lo, hi, 0, 16]] : [[0, 16, lo, hi, 0, 16]];
  };
  const cover = (boxes: ReadonlyArray<readonly number[]>): ColliderForm | null => {
    let Y0 = 16, Y1 = 0, bx0 = 16, bx1 = 0, bz0 = 16, bz1 = 0, any = false;
    for (const b of boxes) {
      if (!(b[1]! > b[0]! && b[3]! > b[2]! && b[5]! > b[4]!)) continue;
      any = true;
      if (b[2]! < Y0) Y0 = b[2]!;
      if (b[3]! > Y1) Y1 = b[3]!;
      if (b[0]! < bx0) bx0 = b[0]!;
      if (b[1]! > bx1) bx1 = b[1]!;
      if (b[4]! < bz0) bz0 = b[4]!;
      if (b[5]! > bz1) bz1 = b[5]!;
    }
    if (!any) return null;
    const s0 = smallest(bx0, bx1, bz0, bz1);
    let best: ColliderForm = { v: vid(0, s0), lo: Y0, hi: Y1 };
    let bestVol = area(s0) * (Y1 - Y0);
    /** The footprint bbox of the boxes' parts within the span [a, b). */
    const within = (a: number, b: number): [number, number, number, number] | null => {
      let x0 = 16, x1 = 0, z0 = 16, z1 = 0, hit = false;
      for (const q of boxes) {
        if (!(q[1]! > q[0]! && q[3]! > q[2]! && q[5]! > q[4]!) || q[3]! <= a || q[2]! >= b) continue;
        hit = true;
        if (q[0]! < x0) x0 = q[0]!;
        if (q[1]! > x1) x1 = q[1]!;
        if (q[4]! < z0) z0 = q[4]!;
        if (q[5]! > z1) z1 = q[5]!;
      }
      return hit ? [x0, x1, z0, z1] : null;
    };
    // Floor + wall: full band Y0..m, shape m..16 (only when the geometry reaches the block top).
    if (Y1 === 16) for (let m = Y0 + 1; m <= 15; m++) {
      const up = within(m, 16);
      if (!up) continue;
      const s = smallest(up[0], up[1], up[2], up[3]);
      if (s === 0) continue;
      const vol = 256 * (m - Y0) + area(s) * (16 - m);
      if (vol < bestVol) { bestVol = vol; best = { v: vid(1, s), lo: Y0, hi: m }; }
    }
    // Wall + ceiling: shape 0..m, full band m..Y1 (only when the geometry reaches the block bottom).
    if (Y0 === 0) for (let m = 1; m < Y1; m++) {
      const down = within(0, m);
      if (!down) continue;
      const s = smallest(down[0], down[1], down[2], down[3]);
      if (s === 0) continue;
      const vol = area(s) * m + 256 * (Y1 - m);
      if (vol < bestVol) { bestVol = vol; best = { v: vid(2, s), lo: m, hi: Y1 }; }
    }
    return best;
  };
  /** A footprint box turned: the cell index turns as `cellAt` in the re-lay, so do its sixteenths. */
  const turnXZ = (x0: number, x1: number, z0: number, z1: number, r: number): [number, number, number, number] => {
    if (r === 90) return [16 - z1, 16 - z0, x0, x1];
    if (r === 180) return [16 - x1, 16 - x0, 16 - z1, 16 - z0];
    if (r === 270) return [z0, z1, 16 - x1, 16 - x0];
    return [x0, x1, z0, z1];
  };
  const turnForm = (form: ColliderForm, r: number): ColliderForm => {
    if (form.v === 0 || !r) return form;
    const d = VARIANTS[form.v]!, q = SHAPES[d.shape]!;
    const t = turnXZ(q[0], q[1], q[2], q[3], r);
    const s = smallest(t[0], t[1], t[2], t[3]);
    return { v: vid(d.kind, s), lo: form.lo, hi: form.hi };
  };
  const cols = (i: number, f: number): [number, number] => {
    const a = i * f, b = (i + 1) * f;
    if (f < 1) return [Math.floor(a), Math.max(Math.floor(a), Math.ceil(b) - 1)];
    return [Math.ceil(a - 0.5), Math.max(Math.ceil(a - 0.5), Math.ceil(b - 0.5) - 1)];
  };
  const cellPieces: ColliderFormKit['cellPieces'] = (x, y, z, v, lo, hi, dims, f, r, emit) => {
    const rc = r === 90 ? { x: dims.length - 1 - z, z: x } : r === 180 ? { x: dims.width - 1 - x, z: dims.length - 1 - z } : r === 270 ? { x: z, z: dims.width - 1 - x } : { x, z };
    const cx = cols(rc.x, f), cz = cols(rc.z, f), nx = cx[1] - cx[0] + 1, nz = cz[1] - cz[0] + 1;
    for (const b of formBoxes(v, lo, hi)) {
      const t = f < 1 ? [0, 16, 0, 16] : turnXZ(b[0], b[1], b[4], b[5], r);
      const wy0 = (y + b[2] / 16) * f, wy1 = (y + b[3] / 16) * f;
      const xa = cx[0] + t[0]! / 16 * nx, xb = cx[0] + t[1]! / 16 * nx, za = cz[0] + t[2]! / 16 * nz, zb = cz[0] + t[3]! / 16 * nz;
      for (let wy = Math.floor(wy0); wy < Math.ceil(wy1); wy++) {
        // The row arithmetic is the re-lay's, verbatim, so a full cell lays exactly what it always did.
        const l = Math.max(0, Math.min(15, Math.floor((wy0 - wy) * 16)));
        const h = Math.max(l + 1, Math.min(16, Math.ceil((wy1 - wy) * 16)));
        for (let wx = cx[0]; wx <= cx[1]; wx++) {
          const ux0 = Math.max(xa, wx) - wx, ux1 = Math.min(xb, wx + 1) - wx;
          if (ux1 - ux0 <= 1e-9) continue;
          const px0 = Math.max(0, Math.floor(ux0 * 16 + 1e-9)), px1 = Math.min(16, Math.ceil(ux1 * 16 - 1e-9));
          for (let wz = cz[0]; wz <= cz[1]; wz++) {
            const uz0 = Math.max(za, wz) - wz, uz1 = Math.min(zb, wz + 1) - wz;
            if (uz1 - uz0 <= 1e-9) continue;
            const pz0 = Math.max(0, Math.floor(uz0 * 16 + 1e-9)), pz1 = Math.min(16, Math.ceil(uz1 * 16 - 1e-9));
            emit(wx, wy, wz, [px0, Math.max(px0 + 1, px1), l, h, pz0, Math.max(pz0 + 1, pz1)]);
          }
        }
      }
    }
  };
  return { SHAPES, VARIANTS, variantOf: (id: string): number => (id in byId ? byId[id]! : -1), formBoxes, cover, turnForm, cellPieces };
}

/** The kit, built once for the engine (the runtimes build their own from the serialised source). */
export const COLLIDER_KIT: ColliderFormKit = colliderFormKit();

/** Number of collider variants (43): block ids the pack defines. */
export const COLLIDER_VARIANT_COUNT = COLLIDER_KIT.VARIANTS.length;
