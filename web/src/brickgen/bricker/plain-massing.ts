/**
 * A PLAIN lattice from a massing: the bricker's own stand-in for the facade and
 * roof grammars (A07/A08), so a massing can be bricked and looked at before
 * those exist. It adds no architecture: no windows, no bays, no buttresses.
 *
 * A two-plate base plate under the whole site bonds buildings that only touch side by side (studs join only
 * vertically, so two boxes standing next to each other are otherwise two models). Then, per volume (lowest top
 * first, so taller volumes cut through shorter ones):
 *  - a floor of TWO plate layers over the footprint (one layer would be loose plates side by side; the second bonds them);
 *  - a one-stud wall ring from the floor to the cap (the footprint's boundary cells);
 *  - a two-layer plate cap over the footprint (the ceiling the roof sits on); a volume under five plates high is a solid
 *    plate slab;
 *  - a stepped hip roof above the cap for every pitched roof shape: the height of a cell is its
 *    distance from the footprint's edge, scaled so the ridge reaches the volume's roof rise
 *    (`tan(pitch) * half span`), as `roof-slope` cells that face the nearest edge, hollow inside.
 * A taller volume clears the interior of what it cuts through, so overlapping volumes merge into one shell.
 *
 * TODO(A07): gabled, shed, conical, dome and onion roofs are all stepped hips here; the roof grammar replaces them.
 * TODO(A08): openings, bays, string courses.
 */
import { pointInRing } from '../massing/geometry.js';
import type { IntentLabel, IntentLattice, Massing, MassVolume } from '../types.js';

/** LDraw colours of the plain model. */
export interface PlainStyle { floor: number; wall: number; cap: number; roof: number; base: number }

/** Light bluish grey stone, dark bluish grey roofs, a tan base plate. */
export const PLAIN_STYLE: PlainStyle = { floor: 72, wall: 71, cap: 71, roof: 72, base: 19 };

/** Plate layers of the base plate every plain model stands on. It bonds volumes that only touch side by side. */
export const BASE_PLATES = 2;

/** Descent directions in label order (see `variants.ts`): 0 +x, 1 -x, 2 +z, 3 -z. */
const STEPS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export interface PlainMassingResult {
  lattice: IntentLattice;
  /** What was simplified, dropped or guessed. */
  notes: string[];
}

/** Rasterise one volume's footprint onto stud cells: a mask over its bounding box. */
function footprintMask(v: MassVolume, spm: number): { x0: number; z0: number; w: number; d: number; inside: Uint8Array } | undefined {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of v.outer) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const i0 = Math.floor(x0 * spm + 1e-6), j0 = Math.floor(z0 * spm + 1e-6);
  const w = Math.ceil(x1 * spm - 1e-6) - i0, d = Math.ceil(z1 * spm - 1e-6) - j0;
  if (w < 1 || d < 1) return undefined;
  const inside = new Uint8Array(w * d);
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
    const x = (i0 + i + 0.5) / spm, z = (j0 + j + 0.5) / spm;
    if (pointInRing(x, z, v.outer) && !v.holes.some(h => pointInRing(x, z, h))) inside[i + w * j] = 1;
  }
  return { x0: i0, z0: j0, w, d, inside };
}

/** Distance of each inside cell from the footprint's edge in stud steps (edge cells 0); -1 outside. Breadth-first. */
function edgeDistance(inside: Uint8Array, w: number, d: number): { dist: Int16Array; max: number } {
  const dist = new Int16Array(w * d).fill(-1);
  const queue: number[] = [];
  const outside = (i: number, j: number): boolean => i < 0 || j < 0 || i >= w || j >= d || inside[i + w * j] === 0;
  for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
    if (!inside[i + w * j]) continue;
    if (STEPS.some(([di, dj]) => outside(i + di, j + dj))) { dist[i + w * j] = 0; queue.push(i + w * j); }
  }
  let max = 0;
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    const i = c % w, j = (c - i) / w;
    for (const [di, dj] of STEPS) {
      const ni = i + di, nj = j + dj;
      if (outside(ni, nj) || dist[ni + w * nj]! >= 0) continue;
      dist[ni + w * nj] = dist[c]! + 1;
      max = Math.max(max, dist[c]! + 1);
      queue.push(ni + w * nj);
    }
  }
  return { dist, max };
}

/** Remove every filled cell that is not face-connected to the base plate (plate layer 0). Returns how many were removed. */
function removeStranded(cells: Uint16Array, W: number, H: number, D: number): number {
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

/** Build the plain lattice of a massing. */
export function plainMassingLattice(massing: Massing, style: PlainStyle = PLAIN_STYLE): PlainMassingResult {
  const spm = massing.scale.studsPerMetre, ppm = massing.scale.platesPerMetre;
  const W = Math.round(massing.boundsM[1][0] * spm), D = Math.round(massing.boundsM[1][2] * spm);
  const H = Math.ceil(massing.boundsM[1][1] * ppm) + 1 + BASE_PLATES;
  const notes: string[] = [];
  const labels: IntentLabel[] = [
    { role: 'floor', colour: style.floor },
    { role: 'wall', colour: style.wall },
    { role: 'roof-flat', colour: style.cap },
    ...([0, 1, 2, 3] as const).map((dir): IntentLabel => ({ role: 'roof-slope', colour: style.roof, slope: { dir, rise: 3 }, hollowOk: true })),
    { role: 'terrain', colour: style.base },
  ];
  const FLOOR = 1, WALL = 2, CAP = 3, ROOF = 4, BASE = 8; // 1-based cell values; roof label = ROOF + dir
  const cells = new Uint16Array(W * H * D);
  const at = (x: number, p: number, z: number): number => (p * D + z) * W + x;

  for (let p = 0; p < BASE_PLATES; p++) for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) cells[at(x, p, z)] = BASE;

  const volumes = [...massing.volumes].sort((a, b) => a.topM - b.topM || a.baseM - b.baseM);
  let dropped = 0, roofed = 0;
  for (const v of volumes) {
    const m = footprintMask(v, spm);
    const baseP = Math.round(v.baseM * ppm) + BASE_PLATES, topP = Math.round(v.topM * ppm) + BASE_PLATES;
    const grounded = baseP === BASE_PLATES; // stands on the base plate: it is its floor
    if (!m || topP <= baseP) { dropped++; continue; }
    const { x0, z0, w, d, inside } = m;
    const { dist, max } = edgeDistance(inside, w, d);
    const each = (fn: (x: number, z: number, edge: number) => void): void => {
      for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) {
        const k = i + w * j;
        const x = x0 + i, z = z0 + j;
        if (inside[k] && x >= 0 && z >= 0 && x < W && z < D) fn(x, z, dist[k]!);
      }
    };
    // Floor (unless it stands on the base plate), wall ring, ceiling cap. Interior wall layers are cleared: this volume cuts through what stood there.
    const slab = topP - baseP <= 4 && !grounded;
    each((x, z, edge) => {
      if (slab) {
        for (let p = baseP; p < topP && p < H; p++) cells[at(x, p, z)] = CAP;
        return;
      }
      if (!grounded) for (const p of [baseP, baseP + 1]) cells[at(x, p, z)] = FLOOR;
      for (let p = grounded ? baseP : baseP + 2; p <= topP - 3 && p < H; p++) cells[at(x, p, z)] = edge === 0 ? WALL : 0;
      for (const p of [topP - 2, topP - 1]) if (p < H) cells[at(x, p, z)] = CAP;
    });
    // Stepped hip roof.
    const pitch = v.roof.pitchDeg;
    if (v.roof.shape !== 'flat' && pitch !== undefined && pitch > 0) {
      const half = Math.min(w, d) / 2;
      const rise = Math.min(Math.tan((pitch * Math.PI) / 180) * half * (20 / 8), H - 1 - topP);
      if (rise >= 1) {
        roofed++;
        each((x, z, edge) => {
          const h = Math.max(1, Math.round((rise * (edge + 1)) / (max + 1)));
          // Face the nearest edge: the neighbour with the smallest distance (outside counts as -1).
          let best = 0, bestD = Infinity;
          STEPS.forEach(([di, dj], dir) => {
            const i = x - x0 + di, j = z - z0 + dj;
            const nd = i < 0 || j < 0 || i >= w || j >= d || !inside[i + w * j] ? -1 : dist[i + w * j]!;
            if (nd < bestD) { bestD = nd; best = dir; }
          });
          for (let k = 0; k < h && topP + k < H; k++) cells[at(x, topP + k, z)] = ROOF + best;
        });
      }
    }
  }
  // Carving one volume out of another can strand a sliver of the older one (a cap whose walls were cleared). Keep only
  // what is joined to the base plate through face-adjacent cells.
  const stranded = removeStranded(cells, W, H, D);
  if (stranded) notes.push(`${stranded} cell(s) cut off from the base plate by overlapping volumes were removed`);
  if (dropped) notes.push(`${dropped} volume(s) collapsed below one stud or one plate and were skipped`);
  notes.push(`${volumes.length - dropped} volumes, ${roofed} with a stepped roof; roofs are hips whatever their shape (TODO(A07))`);
  return { lattice: { dims: [W, H, D], cells, labels }, notes };
}
