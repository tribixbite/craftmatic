/**
 * PER-SIZE CARVE (SCALE-06, 2026-10-15). The collider grid is built once, at
 * 100 %, one block per cell (`buildColliderGrid` + clearance); the wand lays
 * it at a larger size by scaling every cell up (`COLLIDER_KIT.cellPieces`).
 * So anything a player cannot pass at 100 % stays shut at EVERY size: a gap
 * 0.6 blocks wide between two jambs is one full cell, and at 200 % - where it
 * is 1.2 blocks wide, room for the player's 0.6 - it is still two full
 * blocks. Microscale sets (21063 Neuschwanstein, 76419 Hogwarts, 21061
 * Notre-Dame) are made of such gaps: the size exists to make them explorable
 * (the user, 2026-10-14), and their entrances stayed sealed (Saga and Pixel
 * rounds 30zg/30zi).
 *
 * The carve cuts every block the scaled grid lays at a size to the DRAWN
 * part geometry inside it at that size: the box list the 100 % grid was built
 * from (`buildColliderGrid`'s boxes, through the same `sceneGridPoint` map,
 * so in model blocks from the pin at 100 %), turned with the wand and scaled
 * by `f`, each box rounded OUTWARD to sixteenths of the block, intersected
 * with the block's own laid form (a carve never adds a collider anywhere),
 * and covered by the kit's least form (`COLLIDER_KIT.cover`). A block with no
 * drawn geometry left in it becomes air. Only blocks whose form changes are
 * kept: the plan is a list of edits the runtime applies after it lays the
 * scaled cells and before the treads.
 *
 * A block whose top is a STANDING surface of the uncarved grid (its top with a
 * player's height clear over it) keeps its whole footprint: it is only cut
 * vertically to the drawn span, or made air when nothing is drawn in it. The
 * tread planner and the reach guards read a column by its blocks' full
 * footprints, so a floor or a roof edge trimmed to a band left an opening a
 * player fell through that no guard could see (21061 at 300 %: 19 of 210 fan
 * lanes fell 4.4 blocks off the north aisle's edge through a trimmed gutter).
 * Clearance keeps floors' tops for the same reason. A block under a ceiling - a
 * wall, a passage between two jambs - takes any form: that is what opens the
 * doorways the size makes wide enough.
 *
 * Whole sizes only (200, 300, 400 %): there a cell's columns are exactly its
 * scaled span (`cellColumns`' centre rule shifts nothing), so the drawn boxes
 * and the laid blocks are in the same place. At 150 % a wall can be laid half
 * a block off its drawn geometry; carving it to that geometry would delete
 * it. Below 100 % several cells share a block (the re-lay widens every piece).
 */
import { COLLIDER_KIT, type Box16, type ColliderForm } from './collider-form.js';
import { ScaledColliderGrid, colliderPairIndex, colliderPairOf, scaledDims, type GridDims, type QuarterTurn, type SizeCarve, type SourceCell } from './bedrock-collider-scale.js';

/** A drawn box in model blocks at 100 % from the pin corner, unturned: [x0, x1, y0, y1, z0, z1]. */
export type ModelBox = readonly [number, number, number, number, number, number];

/**
 * The sizes a carve is planned for (whole factors; see the module header). Not 200 %: there the carve reshapes
 * the whole tread plan, and every device-proven route of the microscale sets was lost with it (2026-10-16,
 * packs `output/scale06-1016/carve2/`: 76419's boathouse slip walled again by one fine run after another as the
 * cross pass reverted each, 21063's east-flank lawn route 8.13 -> 1.88 blocks), for a fan walk no better than
 * the uncarved plan's. At 300 % it is the gain the carve exists for (lanes over 5 blocks: 76419 15 -> 24,
 * 21063 11 -> 17, 21061 11 -> 30).
 */
export const CARVE_SIZES: readonly number[] = [300, 400];

/** Whether a size gets a carve in a pack (`CARVE_SIZES`). */
export const carvesAt = (sizePct: number): boolean => CARVE_SIZES.includes(sizePct);

/** Whether a carve CAN be planned at a size: a whole factor of 2 or more (see the module header). */
export const carvableAt = (sizePct: number): boolean => sizePct >= 200 && sizePct % 100 === 0;

/**
 * A model box turned with the wand (`rotatedCell`'s map, for continuous coordinates): a point at (px, pz)
 * in the unturned grid lands at (L - pz, px) at 90 degrees, (W - px, L - pz) at 180, (pz, W - px) at 270.
 */
export function turnModelBox(b: ModelBox, dims: GridDims, r: QuarterTurn): ModelBox {
  const [x0, x1, y0, y1, z0, z1] = b, W = dims.width, L = dims.length;
  if (r === 90) return [L - z1, L - z0, y0, y1, x0, x1];
  if (r === 180) return [W - x1, W - x0, y0, y1, L - z1, L - z0];
  if (r === 270) return [z0, z1, y0, y1, W - x1, W - x0];
  return b;
}

const volume = (boxes: ReadonlyArray<readonly number[]>): number => boxes.reduce((t, b) => t + (b[1]! - b[0]!) * (b[3]! - b[2]!) * (b[5]! - b[4]!), 0);

/**
 * The carve for one size and turn: world block key `x,y,z` (from the pin, at this size and turn) -> its new
 * form, or null for air. Empty where no carve can be planned (`carvableAt`); which sizes ship one is `carvesAt`. `boxes` are the drawn boxes in model blocks at 100 %.
 * `protect`: source cells (`x,y,z`, the unturned grid) that are invisible ON PURPOSE - an access stair, a
 * threshold tread, a filled sill, a drop guard: what the planners laid past the drawn geometry. Nothing is drawn
 * there, so a carve would delete them; every block such a cell lays is left as it is.
 */
export function planSizeCarve(cells: readonly SourceCell[], dims: GridDims, sizePct: number, rotation: QuarterTurn, boxes: readonly ModelBox[], protect?: ReadonlySet<string>): Map<string, ColliderForm | null> {
  const out = new Map<string, ColliderForm | null>();
  if (!carvableAt(sizePct) || !cells.length) return out;
  const f = sizePct / 100;
  const laid = scaledDims(dims, f, rotation);
  // The laid pieces per world block, exactly as the runtime gathers them (`placeColliders`).
  const pieces = new Map<string, Box16[]>();
  const kept = new Set<string>();
  for (const c of cells) {
    const keep = protect?.has(`${c.x},${c.y},${c.z}`) ?? false;
    COLLIDER_KIT.cellPieces(c.x, c.y, c.z, c.v ?? 0, c.lo, c.hi, dims, f, rotation, (wx, wy, wz, box) => {
      if (wx < 0 || wz < 0 || wy < 0 || wx >= laid.width || wz >= laid.length || wy >= laid.height) return;
      const key = `${wx},${wy},${wz}`;
      if (keep) kept.add(key);
      const list = pieces.get(key);
      if (list) list.push(box); else pieces.set(key, [box]);
    });
  }
  // The drawn boxes at this size and turn, bucketed by the world columns they reach.
  const byColumn = new Map<number, number[][]>();
  const colKey = (x: number, z: number): number => x * laid.length + z;
  for (const b of boxes) {
    const t = turnModelBox(b, dims, rotation).map(v => v * f);
    for (let x = Math.max(0, Math.floor(t[0]!)); x < Math.min(laid.width, Math.ceil(t[1]!)); x++) {
      for (let z = Math.max(0, Math.floor(t[4]!)); z < Math.min(laid.length, Math.ceil(t[5]!)); z++) {
        const k = colKey(x, z);
        const list = byColumn.get(k);
        if (list) list.push(t); else byColumn.set(k, [t]);
      }
    }
  }
  /** The uncarved grid, for which blocks' tops are standing surfaces. */
  const grid = new ScaledColliderGrid(cells, dims, f, rotation);
  const standsOn = (x: number, row: number, z: number): boolean => {
    const b = grid.blockAt(x, z, row);
    return !!b && grid.surfaces(x, z).includes(row * 16 + b.hi);
  };
  for (const [key, list] of pieces) {
    if (kept.has(key)) continue;
    const form = COLLIDER_KIT.cover(list);
    if (!form) continue;
    const own = COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi);
    const [wx, wy, wz] = key.split(',').map(Number) as [number, number, number];
    const surface = standsOn(wx, wy, wz);
    // A GROUND PLATE stays as laid: a standing surface on the bottom row (at most a block up, an auto-jump). Nothing
    // can fall under it, so a carve gains no passage there, and trimming it re-planned the treads around it:
    // 21063's east plate strip at 300 % lost its outer column (a full 100 % cell over the plate's drawn edge),
    // the planner laid fine runs up across the strip from the ground beside it, and the flank the Pixel climbed
    // 10.3 blocks (round 30zi) was walled off at z 40.
    if (surface && wy === 0) continue;
    const cut: Box16[] = [];
    for (const t of byColumn.get(colKey(wx, wz)) ?? []) {
      // The drawn box in this block's sixteenths, rounded outward.
      const d = [Math.floor((t[0]! - wx) * 16), Math.ceil((t[1]! - wx) * 16), Math.floor((t[2]! - wy) * 16), Math.ceil((t[3]! - wy) * 16), Math.floor((t[4]! - wz) * 16), Math.ceil((t[5]! - wz) * 16)];
      for (const o of own) {
        const q: Box16 = [Math.max(d[0]!, o[0]), Math.min(d[1]!, o[1]), Math.max(d[2]!, o[2]), Math.min(d[3]!, o[3]), Math.max(d[4]!, o[4]), Math.min(d[5]!, o[5])];
        if (q[0] < q[1] && q[2] < q[3] && q[4] < q[5]) cut.push(q);
      }
    }
    if (!cut.length) { out.set(key, null); continue; }
    if (surface) {
      // A standing surface: its footprint stays whole (a full block's span cut to the drawn span; a clearance
      // form, already pulled back by its own certain test, is left as it is).
      if (form.v !== 0) continue;
      const lo = Math.max(form.lo, Math.min(...cut.map(q => q[2]))), hi = Math.min(form.hi, Math.max(...cut.map(q => q[3])));
      if (hi > lo && (lo > form.lo || hi < form.hi)) out.set(key, { v: 0, lo, hi });
      continue;
    }
    const carved = COLLIDER_KIT.cover(cut);
    if (!carved) { out.set(key, null); continue; }
    if (volume(COLLIDER_KIT.formBoxes(carved.v, carved.lo, carved.hi)) < volume(own) - 1e-9) out.set(key, carved);
  }
  // A cut block whose top is a standing surface of the CARVED grid - a wall's band left with nothing drawn over
  // it - would be a floor to every grid reader and a hole to the player: 21061's north aisle at 300 % took a
  // tread run up to such a band, and the walk stepped off its top and fell 4.4 blocks through it. It keeps its
  // whole footprint over its cut span. The grid reads a band and a full block alike, so this changes no surface.
  const carvedGrid = new ScaledColliderGrid(cells, dims, f, rotation, out);
  for (const [key, form] of [...out]) {
    if (!form || form.v === 0) continue;
    const [wx, wy, wz] = key.split(',').map(Number) as [number, number, number];
    const b = carvedGrid.blockAt(wx, wz, wy);
    if (!b || !carvedGrid.surfaces(wx, wz).includes(wy * 16 + b.hi)) continue;
    const fb = COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi);
    const whole: ColliderForm = { v: 0, lo: Math.min(...fb.map(q => q[2])), hi: Math.max(...fb.map(q => q[3])) };
    const laid = pieces.get(key) && COLLIDER_KIT.cover(pieces.get(key)!);
    if (laid && laid.v === 0 && laid.lo === whole.lo && laid.hi === whole.hi) out.delete(key); else out.set(key, whole);
  }
  // THE SHAFT RULE. A cut band under a block that does not cover the whole footprint - air, or a clearance form
  // laid at 100 % - is a shaft a player drops down from that block's open part, and the grid reads the stack as
  // solid: 21061's north aisle at 300 % kept its 100 % clearance form on top and the carve emptied the bands
  // under it, a 4.4-block drop no guard saw. Down each column from its top, the highest cut band with nothing
  // whole over it takes its whole footprint (over its cut span); everything under it is then capped.
  const columns = new Map<string, number[]>();
  for (const key of pieces.keys()) {
    const [wx, wy, wz] = key.split(',').map(Number) as [number, number, number];
    const ck = `${wx},${wz}`;
    const rows = columns.get(ck);
    if (rows) rows.push(wy); else columns.set(ck, [wy]);
  }
  for (const [ck, rows] of columns) {
    const [wx, wz] = ck.split(',').map(Number) as [number, number];
    let covered = false;
    for (const wy of rows.sort((a, b) => b - a)) {
      const key = `${wx},${wy},${wz}`;
      const final = out.has(key) ? out.get(key)! : COLLIDER_KIT.cover(pieces.get(key)!);
      if (!final) continue;
      if (final.v === 0) { covered = true; continue; }
      if (covered || !out.has(key)) continue;
      const fb = COLLIDER_KIT.formBoxes(final.v, final.lo, final.hi);
      const whole: ColliderForm = { v: 0, lo: Math.min(...fb.map(q => q[2])), hi: Math.max(...fb.map(q => q[3])) };
      const laid = COLLIDER_KIT.cover(pieces.get(key)!);
      if (laid && laid.v === 0 && laid.lo === whole.lo && laid.hi === whole.hi) out.delete(key); else out.set(key, whole);
      covered = true;
    }
  }
  return out;
}

const DIGIT_BASE = 200, CHAR_BASE = 40, PAIRS = 136;
const digits = (v: number): string => {
  if (v < 0 || v >= DIGIT_BASE * DIGIT_BASE) throw new Error(`carve value out of range: ${v}`);
  return String.fromCharCode(CHAR_BASE + Math.floor(v / DIGIT_BASE)) + String.fromCharCode(CHAR_BASE + v % DIGIT_BASE);
};

/**
 * A carve as shipped: 8 chars per edit - x, y, z and the form's run value (`v * 136 + pair`, 0 = air), each as
 * two base-200 digits over char 40 (the tread plan's digits). Sorted, so the same carve encodes the same.
 */
export function encodeSizeCarve(carve: SizeCarve): string {
  const rows = [...carve.entries()].map(([key, form]) => {
    const [x, y, z] = key.split(',').map(Number) as [number, number, number];
    return { x, y, z, value: form ? form.v * PAIRS + colliderPairIndex(form.lo, form.hi) : 0 };
  }).sort((a, b) => a.x - b.x || a.z - b.z || a.y - b.y);
  return rows.map(r => `${digits(r.x)}${digits(r.y)}${digits(r.z)}${digits(r.value)}`).join('');
}

/** Inverse of `encodeSizeCarve`. */
export function decodeSizeCarve(plan: string): Map<string, ColliderForm | null> {
  const out = new Map<string, ColliderForm | null>();
  const at = (k: number): number => (plan.charCodeAt(k) - CHAR_BASE) * DIGIT_BASE + plan.charCodeAt(k + 1) - CHAR_BASE;
  for (let k = 0; k + 7 < plan.length; k += 8) {
    const value = at(k + 6);
    let form: ColliderForm | null = null;
    if (value > 0) {
      const v = Math.floor((value - 1) / PAIRS);
      const [lo, hi] = colliderPairOf(value - v * PAIRS);
      form = { v, lo, hi };
    }
    out.set(`${at(k)},${at(k + 2)},${at(k + 4)}`, form);
  }
  return out;
}
