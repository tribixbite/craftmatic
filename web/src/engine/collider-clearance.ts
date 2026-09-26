/**
 * CLEARANCE: pull the invisible colliders back to the model's own geometry so
 * a player fits through minifig rooms, halls and doorways - and do it only
 * where it is certain (design: docs/bedrock-interactivity.md, "Clearance:
 * colliders pulled back to the geometry").
 *
 * Input is the collider grid AFTER the doorway cut (every collider still the
 * full-footprint form) and, per collider cell, the part geometry in it as
 * sixteen layer footprints (`CellLayers`, built by `buildColliderGrid`). For
 * each cell the proposal is `colliderCover` of its geometry - the thinnest
 * form containing every part box - and a raised ceiling where a sneaking
 * player fits but a standing one does not. A proposal is applied only when:
 *
 *   1. SUBSET      the form lies inside the old full cell (never less free space);
 *   2. SUPERSET    it contains the cell's geometry (a wall trim), or it is the ceiling rule;
 *   3. DOOR        no closed leaf reaches the cell and the doorway cut left it as built;
 *   4. FLOOR       a cell whose top is a standing surface keeps its top sixteenth full;
 *   5. NO LEAK     flooding the model from outside with a flying, sneaking,
 *                  0.5-wide player reaches no block with the trims that neither
 *                  the colliders before them nor the part geometry itself let
 *                  it reach (every closed door closed in all three worlds).
 *
 * Every applied and every refused proposal is logged with its reason. Pure: a
 * BlockGrid in, the same grid edited in place and a report out.
 */

import type { BlockGrid } from '@craft/schem/types.js';
import { COLLIDER_KIT, type Box16, type ColliderForm } from './collider-form.js';

/** Per cell, 16 layer footprints (one per sixteenth of height): [x0, x1, z0, z1] at 4·level; x0 = 255 marks an empty layer. */
export type CellLayers = Map<number, Uint8Array>;
export const EMPTY_LAYER = 255;

/** A new, empty layer record. */
export function newCellLayers(): Uint8Array {
  const a = new Uint8Array(64);
  for (let l = 0; l < 16; l++) a[4 * l] = EMPTY_LAYER;
  return a;
}

/** Widen a cell's layers by one box (sixteenths inside the cell, ascending pairs). */
export function addLayerBox(a: Uint8Array, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  for (let l = Math.max(0, y0); l < Math.min(16, y1); l++) {
    const k = 4 * l;
    if (a[k] === EMPTY_LAYER) { a[k] = x0; a[k + 1] = x1; a[k + 2] = z0; a[k + 3] = z1; continue; }
    if (x0 < a[k]!) a[k] = x0;
    if (x1 > a[k + 1]!) a[k + 1] = x1;
    if (z0 < a[k + 2]!) a[k + 2] = z0;
    if (z1 > a[k + 3]!) a[k + 3] = z1;
  }
}

/** A cell's layers as boxes (one per non-empty layer), for `colliderCover`. */
export function layerBoxes(a: Uint8Array): Box16[] {
  const out: Box16[] = [];
  for (let l = 0; l < 16; l++) {
    const k = 4 * l;
    if (a[k] === EMPTY_LAYER) continue;
    out.push([a[k]!, a[k + 1]!, l, l + 1, a[k + 2]!, a[k + 3]!]);
  }
  return out;
}

/** The vertical extent of a cell's layers, sixteenths [lo, hi), or null when empty. */
export function layerSpan(a: Uint8Array): [number, number] | null {
  let lo = -1, hi = -1;
  for (let l = 0; l < 16; l++) if (a[4 * l] !== EMPTY_LAYER) { if (lo < 0) lo = l; hi = l + 1; }
  return lo < 0 ? null : [lo, hi];
}

/** Collider state string of a form (`<variant id>[lo=…,hi=…]`), the grid's and the structure's spelling. */
export const formState = (form: ColliderForm): string => `${COLLIDER_KIT.VARIANTS[form.v]!.id}[lo=${form.lo},hi=${form.hi}]`;

/** Parse a collider state string (any variant) into its form, or null when it is not a collider. */
export function parseFormState(state: string): ColliderForm | null {
  const m = /^([a-z0-9_:]+)\[lo=(\d+),hi=(\d+)\]$/.exec(state);
  if (!m) return null;
  const v = COLLIDER_KIT.variantOf(m[1]!);
  return v < 0 ? null : { v, lo: Number(m[2]), hi: Number(m[3]) };
}

/** Why a proposal was refused. */
export type ClearanceRefusal = 'door-leaf' | 'door-cut' | 'walkable-top' | 'leak' | 'unverifiable';
export const CLEARANCE_REFUSALS: readonly ClearanceRefusal[] = ['door-leaf', 'door-cut', 'walkable-top', 'leak', 'unverifiable'];

/** A box in grid blocks (the collider grid's frame, y up). */
export interface GridBox { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export interface ClearanceInput {
  /** The collider grid after the doorway cut; edited in place. */
  grid: BlockGrid;
  /** The part geometry per cell (`buildColliderGrid`). */
  layers: CellLayers;
  /** Every closed passage leaf's box, grid blocks (a door, gate, hatch, garage door): solid in the leak check's geometry world. */
  leaves: readonly GridBox[];
  /**
   * Every closed passage leaf's mid-plane in grid blocks (corner, and the
   * vectors along its width and up its height): the cells it crosses, and the
   * cells a little past its ends (its frame's sliver), are never trimmed. A
   * leaf without a plane protects every cell its box reaches.
   */
  leafPlanes?: ReadonlyArray<{ c: readonly number[]; a: readonly number[]; u: readonly number[] } | null>;
  /** The cells the runtime lays while those leaves are closed: `[x, y, z, lo, hi]`. */
  closedCells: ReadonlyArray<readonly (number | undefined)[]>;
}

/** One proposal's fate: the cell, what was proposed, and why it was refused (absent when applied). */
export interface ClearanceEntry { x: number; y: number; z: number; rule: 'wall' | 'ceiling'; from: ColliderForm; to: ColliderForm; refused?: ClearanceRefusal }

export interface ClearanceReport {
  /** Cells with geometry the pass looked at, and those whose geometry fills them (nothing to trim). */
  cells: number;
  alreadyTight: number;
  applied: { wall: number; ceiling: number };
  refused: Record<ClearanceRefusal, number>;
  /** Block volume freed (blocks cubed at 100 %). */
  freedBlocks: number;
  /** Leak-check rounds run, leak blocks found in each, and the voxel grid it ran on. */
  leakRounds: number[];
  /** The first leak blocks of each round, grid cells [x, y, z] (at most `LEAKS_REPORTED` a round). */
  leaks: number[][][];
  voxels: number;
  /** Wall-clock milliseconds the pass took (the leak floods dominate). */
  millis: number;
  /** True when the final grid passed the leak check (always, unless every trim was refused as unverifiable). */
  verified: boolean;
  /** Every proposal, applied and refused. */
  entries: ClearanceEntry[];
}

/** Clear height a sneaking player needs, and a standing one (sixteenths); the most a ceiling is raised; what it must keep. */
export const SNEAK_NEED16 = 24;
export const STAND_NEED16 = 29;
export const CEILING_RAISE_MAX16 = STAND_NEED16 - SNEAK_NEED16;
export const CEILING_KEEP16 = 2;
/** Leak-check resolution (voxels per block), the flying player's width and height in voxels, and its round limit. */
const VOX = 4;
const PLAYER_VOX_W = 2;
const PLAYER_VOX_H = 6;
const MAX_LEAK_ROUNDS = 8;
const LEAKS_REPORTED = 40;
/** How far past each end of a closed leaf (blocks) its protected cells reach: a frame's sliver. */
const LEAF_END_REACH = 0.4;
/** Above this many voxels the leak check is not run and every trim is refused (`unverifiable`). */
export const MAX_LEAK_VOXELS = 64_000_000;

const volume16 = (boxes: readonly Box16[]): number => boxes.reduce((n, b) => n + (b[1] - b[0]) * (b[3] - b[2]) * (b[5] - b[4]), 0);
const formVolume = (f: ColliderForm): number => volume16(COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi));
/** Whether every box of `inner` lies inside the union of `outer` (checked on the 16³ lattice). */
export function formWithin(inner: ColliderForm, outer: ColliderForm): boolean {
  const a = COLLIDER_KIT.formBoxes(inner.v, inner.lo, inner.hi), b = COLLIDER_KIT.formBoxes(outer.v, outer.lo, outer.hi);
  for (const p of a) for (let x = p[0]; x < p[1]; x++) for (let y = p[2]; y < p[3]; y++) for (let z = p[4]; z < p[5]; z++) {
    if (!b.some(q => x >= q[0] && x < q[1] && y >= q[2] && y < q[3] && z >= q[4] && z < q[5])) return false;
  }
  return true;
}
/** Whether a form contains every layer box of a cell's geometry. */
export function formContains(form: ColliderForm, geometry: readonly Box16[]): boolean {
  const b = COLLIDER_KIT.formBoxes(form.v, form.lo, form.hi);
  for (const p of geometry) for (let x = p[0]; x < p[1]; x++) for (let y = p[2]; y < p[3]; y++) for (let z = p[4]; z < p[5]; z++) {
    if (!b.some(q => x >= q[0] && x < q[1] && y >= q[2] && y < q[3] && z >= q[4] && z < q[5])) return false;
  }
  return true;
}

/**
 * A debugging tap: when set, `applyColliderClearance` hands it its input
 * (before any change) - how an offline probe replays one set's clearance
 * without re-exporting it. Never set by the pipeline.
 */
export const clearanceDebug: { capture?: (input: ClearanceInput) => void } = {};

/**
 * Plan and apply clearance on `input.grid` (see the module header). Returns
 * the report; the grid holds the applied forms.
 */
export function applyColliderClearance(input: ClearanceInput): ClearanceReport {
  clearanceDebug.capture?.(input);
  const started = performance.now();
  const { grid, layers, leaves, closedCells } = input;
  const W = grid.width, H = grid.height, L = grid.length;
  const idx = (x: number, y: number, z: number): number => (x * H + y) * L + z;
  const refused: Record<ClearanceRefusal, number> = { 'door-leaf': 0, 'door-cut': 0, 'walkable-top': 0, leak: 0, unverifiable: 0 };
  const entries: ClearanceEntry[] = [];
  const report: ClearanceReport = { cells: 0, alreadyTight: 0, applied: { wall: 0, ceiling: 0 }, refused, freedBlocks: 0, leakRounds: [], leaks: [], voxels: 0, millis: 0, verified: true, entries };

  /** The collider form the grid holds at a cell (pristine full form after the cut), or null. */
  const formAt = (x: number, y: number, z: number): ColliderForm | null => parseFormState(grid.get(x, y, z));
  const solidAt = (x: number, y: number, z: number): boolean => grid.get(x, y, z) !== 'minecraft:air';

  // Cells a closed leaf's mid-plane crosses, from a little before one end to a little past the other
  // (the frame's sliver beside the leaf), are never trimmed: a trim there could open a slot beside
  // the closed leaf. Cells in front of and behind it are not protected - a trim there cannot open
  // the leaf's plane, and the leak check still floods with every leaf closed.
  const leafCells = new Set<number>();
  const inGrid = (x: number, y: number, z: number): boolean => x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < L;
  leaves.forEach((b, k) => {
    const pl = input.leafPlanes?.[k];
    if (pl) {
      const la = Math.hypot(pl.a[0]!, pl.a[1]!, pl.a[2]!), lu = Math.hypot(pl.u[0]!, pl.u[1]!, pl.u[2]!);
      const ns = Math.max(2, Math.ceil(la * 16)), nt = Math.max(2, Math.ceil(lu * 16));
      const past = Math.min(0.5, LEAF_END_REACH / Math.max(la, 1e-6));
      for (let i = 0; i <= ns; i++) for (let j = 0; j <= nt; j++) {
        const sa = -past + (1 + 2 * past) * i / ns, tu = j / nt;
        const x = Math.floor(pl.c[0]! + pl.a[0]! * sa + pl.u[0]! * tu), y = Math.floor(pl.c[1]! + pl.a[1]! * sa + pl.u[1]! * tu), z = Math.floor(pl.c[2]! + pl.a[2]! * sa + pl.u[2]! * tu);
        if (inGrid(x, y, z)) leafCells.add(idx(x, y, z));
      }
      return;
    }
    const e = 1 / 16;
    for (let x = Math.max(0, Math.floor(b.x0 - e)); x <= Math.min(W - 1, Math.floor(b.x1 + e)); x++)
      for (let y = Math.max(0, Math.floor(b.y0 - e)); y <= Math.min(H - 1, Math.floor(b.y1 + e)); y++)
        for (let z = Math.max(0, Math.floor(b.z0 - e)); z <= Math.min(L - 1, Math.floor(b.z1 + e)); z++) leafCells.add(idx(x, y, z));
  });

  /** A cell's solid boxes in sixteenths (a kept scene block is the whole block), or none for air. */
  const boxesAt = (x: number, y: number, z: number): Box16[] => {
    const s = grid.get(x, y, z);
    if (s === 'minecraft:air') return [];
    const f = parseFormState(s);
    return f ? COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi) : [[0, 16, 0, 16, 0, 16]];
  };
  /**
   * Clear sixteenths above a height in a column of the grid as it stands
   * (after the cut, before any trim), up to the next solid's bottom; Infinity
   * past the top of the grid. A box overlapping the height means 0.
   */
  const headroomAbove = (x: number, z: number, top16: number): number => {
    for (let y = Math.floor(top16 / 16); y < H; y++) {
      let best = Infinity;
      for (const b of boxesAt(x, y, z)) {
        const a0 = y * 16 + b[2], a1 = y * 16 + b[3];
        if (a1 <= top16) continue;
        best = Math.min(best, Math.max(0, a0 - top16));
      }
      if (best < Infinity) return best;
    }
    return Infinity;
  };

  // ── Wall proposals.
  type Proposal = { i: number; x: number; y: number; z: number; rule: 'wall' | 'ceiling'; from: ColliderForm; to: ColliderForm };
  const proposals: Proposal[] = [];
  const proposedAt = new Map<number, Proposal>();
  const refuse = (p: Proposal, why: ClearanceRefusal): void => { refused[why]++; entries.push({ x: p.x, y: p.y, z: p.z, rule: p.rule, from: p.from, to: p.to, refused: why }); };
  for (const [i, a] of layers) {
    const z = i % L, y = Math.floor(i / L) % H, x = Math.floor(i / (L * H));
    const span = layerSpan(a);
    if (!span) continue;
    report.cells++;
    const geometry = layerBoxes(a);
    const to = COLLIDER_KIT.cover(geometry)!;
    const built: ColliderForm = { v: 0, lo: span[0], hi: span[1] };
    if (to.v === 0) { report.alreadyTight++; continue; }
    const p: Proposal = { i, x, y, z, rule: 'wall', from: built, to };
    // 3. The doorway cut left the cell as built, and no closed leaf reaches it.
    const now = formAt(x, y, z);
    if (!now || now.v !== 0 || now.lo !== built.lo || now.hi !== built.hi) { refuse(p, 'door-cut'); continue; }
    if (leafCells.has(i)) { refuse(p, 'door-leaf'); continue; }
    // 1, 2. Subset of the old cell, superset of the geometry (by construction; asserted).
    if (!formWithin(to, built) || !formContains(to, geometry)) throw new Error(`clearance: cover of cell ${x},${y},${z} is not between its geometry and its full cell`);
    // 4. A standing surface on top keeps its top sixteenth full.
    if (headroomAbove(x, z, y * 16 + built.hi) >= SNEAK_NEED16) {
      const top = COLLIDER_KIT.formBoxes(to.v, to.lo, to.hi).filter(b => b[3] === built.hi);
      if (!top.some(b => b[0] === 0 && b[1] === 16 && b[4] === 0 && b[5] === 16)) { refuse(p, 'walkable-top'); continue; }
    }
    proposals.push(p);
    proposedAt.set(i, p);
  }

  // ── Ceiling proposals: over a full-topped floor, a sneaking player fits and a standing one does not.
  /** The form a cell will have if its proposal is applied. */
  const planned = (x: number, y: number, z: number): ColliderForm | null => proposedAt.get(idx(x, y, z))?.to ?? formAt(x, y, z);
  const fullTop = (f: ColliderForm): boolean => { const d = COLLIDER_KIT.VARIANTS[f.v]!; return d.shape === 0 || d.kind === 2; };
  for (let x = 0; x < W; x++) for (let z = 0; z < L; z++) {
    for (let y = 1; y < H; y++) {
      const i = idx(x, y, z);
      const c = formAt(x, y, z);
      if (!c || c.v !== 0 || proposedAt.has(i)) continue;
      const a = layers.get(i), span = a ? layerSpan(a) : null;
      if (!span || span[0] !== c.lo || span[1] !== c.hi) continue; // not as built (a cut, a tread)
      const bottom = y * 16 + c.lo;
      // The floor under it: the first solid below (the model's ground plane when there is none), nothing between.
      let floorTop = 0, floorOk = true;
      for (let yy = y - 1; yy >= 0; yy--) {
        if (!solidAt(x, yy, z)) continue;
        const f = planned(x, yy, z);
        floorOk = f !== null && fullTop(f); // a kept scene block is not a floor this rule reasons about
        floorTop = f ? yy * 16 + Math.max(...COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi).map(b => b[3])) : -1;
        break;
      }
      if (floorTop < 0 || !floorOk) continue;
      const gap = bottom - floorTop;
      if (gap < SNEAK_NEED16 || gap >= STAND_NEED16) continue;
      const lo = c.lo + (STAND_NEED16 - gap);
      if (lo > 15 || c.hi - lo < CEILING_KEEP16) continue;
      const p: Proposal = { i, x, y, z, rule: 'ceiling', from: c, to: { v: 0, lo, hi: c.hi } };
      if (leafCells.has(i)) { refuse(p, 'door-leaf'); continue; }
      proposals.push(p);
      proposedAt.set(i, p);
    }
  }

  // ── 5. The leak check.
  const active = new Set<Proposal>(proposals);
  const voxels = (W + 2) * VOX * (H + 2) * VOX * (L + 2) * VOX;
  report.voxels = voxels;
  if (proposals.length && voxels > MAX_LEAK_VOXELS) {
    for (const p of proposals) refuse(p, 'unverifiable');
    active.clear();
    report.verified = false;
  } else if (proposals.length) {
    const flood = new LeakFlood(W, H, L);
    const closedBoxes: Array<[number, number, number, Box16]> = closedCells.map(c => [c[0]!, c[1]!, c[2]!, [0, 16, c[3]!, c[4]!, 0, 16]]);
    /** Lay the collider grid (with `forms` overriding cells) and the closed doorways. */
    const colliderWorld = (forms: ReadonlyMap<number, ColliderForm>): void => {
      flood.clear();
      for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
        const s = grid.get(x, y, z);
        if (s === 'minecraft:air') continue;
        const f = forms.get(idx(x, y, z)) ?? parseFormState(s);
        if (!f) { flood.solid16(x, y, z, [0, 16, 0, 16, 0, 16]); continue; } // a kept scene block
        for (const b of COLLIDER_KIT.formBoxes(f.v, f.lo, f.hi)) flood.solid16(x, y, z, b);
      }
      for (const [x, y, z, b] of closedBoxes) flood.solid16(x, y, z, b);
    };
    // The part geometry, the closed leaves and the kept scene blocks.
    flood.clear();
    for (const [i, a] of layers) {
      const z = i % L, y = Math.floor(i / L) % H, x = Math.floor(i / (L * H));
      for (const b of layerBoxes(a)) flood.solid16(x, y, z, b);
    }
    for (const b of leaves) flood.solidBox(b);
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) {
      const s = grid.get(x, y, z);
      if (s !== 'minecraft:air' && !parseFormState(s)) flood.solid16(x, y, z, [0, 16, 0, 16, 0, 16]);
    }
    const reachedGeometry = flood.reach();
    colliderWorld(new Map());
    const reachedBefore = flood.reach();
    for (let round = 0; ; round++) {
      const forms = new Map<number, ColliderForm>();
      for (const p of active) forms.set(p.i, p.to);
      colliderWorld(forms);
      const after = flood.reach();
      const leaks: number[] = [];
      for (let k = 0; k < after.length; k++) if (after[k] && !reachedBefore[k] && !reachedGeometry[k]) leaks.push(k);
      report.leakRounds.push(leaks.length);
      {
        const PL = L + 2, PH = H + 2;
        report.leaks.push(leaks.slice(0, LEAKS_REPORTED).map(k => [Math.floor(k / (PL * PH)) - 1, Math.floor(k / PL) % PH, k % PL - 1]));
      }
      if (!leaks.length) break;
      if (round + 1 >= MAX_LEAK_ROUNDS) {
        for (const p of active) refuse(p, 'leak');
        active.clear();
        break;
      }
      // Refuse every trim within one block of a leak block (reach cells are padded by one block).
      const near = new Set<number>();
      const PL = L + 2, PH = H + 2;
      for (const k of leaks) {
        const cz = k % PL - 1, cy = Math.floor(k / PL) % PH, cx = Math.floor(k / (PL * PH)) - 1;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const x = cx + dx, y = cy + dy, z = cz + dz;
          if (x >= 0 && y >= 0 && z >= 0 && x < W && y < H && z < L) near.add(idx(x, y, z));
        }
      }
      let dropped = 0;
      for (const p of [...active]) if (near.has(p.i)) { active.delete(p); refuse(p, 'leak'); dropped++; }
      if (!dropped) {
        // A leak no trim is near cannot be the trims' doing: it is in the collider world already (reported, not fixed here).
        break;
      }
    }
  }

  // ── Apply.
  for (const p of proposals) {
    if (!active.has(p)) continue;
    grid.set(p.x, p.y, p.z, formState(p.to));
    report.applied[p.rule]++;
    report.freedBlocks += (formVolume(p.from) - formVolume(p.to)) / 4096;
    entries.push({ x: p.x, y: p.y, z: p.z, rule: p.rule, from: p.from, to: p.to });
  }
  report.freedBlocks = Math.round(report.freedBlocks * 100) / 100;
  report.millis = Math.round(performance.now() - started);
  return report;
}

/**
 * The leak check's voxel world: quarter-block voxels over the grid padded by
 * one block on every side and two above (a player flies over the roof), the
 * model's own ground plane solid below. `reach` floods the positions a
 * flying player 0.5 wide and 1.5 tall (sneaking, narrower than the real 0.6)
 * can take from outside, and returns the grid cells (padded, one block on
 * each horizontal side) a position's feet corner lies in.
 */
export class LeakFlood {
  readonly VX: number; readonly VY: number; readonly VZ: number;
  private readonly solid: Uint8Array;
  constructor(readonly W: number, readonly H: number, readonly L: number) {
    this.VX = (W + 2) * VOX; this.VY = (H + 2) * VOX; this.VZ = (L + 2) * VOX;
    this.solid = new Uint8Array(this.VX * this.VY * this.VZ);
  }
  clear(): void { this.solid.fill(0); }
  /** Mark a box given in sixteenths of cell (x, y, z) solid, rounded outward to voxels. */
  solid16(x: number, y: number, z: number, b: readonly number[]): void {
    const q = 16 / VOX;
    const x0 = (x + 1) * VOX + Math.floor(b[0]! / q), x1 = (x + 1) * VOX + Math.ceil(b[1]! / q);
    const y0 = y * VOX + Math.floor(b[2]! / q), y1 = y * VOX + Math.ceil(b[3]! / q);
    const z0 = (z + 1) * VOX + Math.floor(b[4]! / q), z1 = (z + 1) * VOX + Math.ceil(b[5]! / q);
    this.fill(x0, x1, y0, y1, z0, z1);
  }
  /** Mark a box in grid blocks solid, rounded outward. */
  solidBox(b: GridBox): void {
    this.fill(Math.floor((b.x0 + 1) * VOX), Math.ceil((b.x1 + 1) * VOX), Math.floor(b.y0 * VOX), Math.ceil(b.y1 * VOX), Math.floor((b.z0 + 1) * VOX), Math.ceil((b.z1 + 1) * VOX));
  }
  private fill(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0);
    x1 = Math.min(this.VX, x1); y1 = Math.min(this.VY, y1); z1 = Math.min(this.VZ, z1);
    for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) {
      const base = (x * this.VZ + z) * this.VY;
      this.solid.fill(1, base + y0, base + y1);
    }
  }
  /** Flood from outside; returns reached cells over the padded cell grid ((W+2) x (H+2) x (L+2), index (cx·(H+2) + cy)·(L+2) + cz). */
  reach(): Uint8Array {
    const { VX, VY, VZ } = this;
    const n = VX * VY * VZ;
    // state[v]: 1 when the player's box with its min corner at v is free, 2 once the flood has been there.
    const state = new Uint8Array(n);
    for (let x = 0; x + PLAYER_VOX_W <= VX; x++) for (let z = 0; z + PLAYER_VOX_W <= VZ; z++) {
      let run = 0;
      const c00 = (x * VZ + z) * VY, c01 = (x * VZ + z + 1) * VY, c10 = ((x + 1) * VZ + z) * VY, c11 = ((x + 1) * VZ + z + 1) * VY;
      for (let y = VY - 1; y >= 0; y--) {
        const free = !this.solid[c00 + y] && !this.solid[c01 + y] && !this.solid[c10 + y] && !this.solid[c11 + y];
        run = free ? run + 1 : 0;
        if (run >= PLAYER_VOX_H) state[c00 + y] = 1;
      }
    }
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const push = (x: number, y: number, z: number): void => {
      if (x < 0 || y < 0 || z < 0 || x + PLAYER_VOX_W > VX || z + PLAYER_VOX_W > VZ || y + PLAYER_VOX_H > VY) return;
      const k = (x * VZ + z) * VY + y;
      if (state[k] !== 1) return;
      state[k] = 2; queue[tail++] = k;
    };
    for (let x = 0; x + PLAYER_VOX_W <= VX; x++) for (let z = 0; z + PLAYER_VOX_W <= VZ; z++) {
      const edge = x === 0 || z === 0 || x + PLAYER_VOX_W === VX || z + PLAYER_VOX_W === VZ;
      if (edge) for (let y = 0; y + PLAYER_VOX_H <= VY; y++) push(x, y, z);
      else push(x, VY - PLAYER_VOX_H, z);
    }
    const PH = this.H + 2, PL = this.L + 2;
    const cells = new Uint8Array((this.W + 2) * PH * PL);
    while (head < tail) {
      const k = queue[head++]!;
      const y = k % VY, xz = (k - y) / VY, z = xz % VZ, x = (xz - z) / VZ;
      cells[(Math.floor(x / VOX) * PH + Math.floor(y / VOX)) * PL + Math.floor(z / VOX)] = 1;
      push(x + 1, y, z); push(x - 1, y, z); push(x, y + 1, z); push(x, y - 1, z); push(x, y, z + 1); push(x, y, z - 1);
    }
    return cells;
  }
}
