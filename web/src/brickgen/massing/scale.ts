/**
 * Scale choice (A05, BIZ-05): how many studs a metre becomes.
 *
 * 1 stud = 20 LDU, 1 plate = 8 LDU, so the model is isotropic when `platesPerMetre = studsPerMetre * 20 / 8`.
 * A product states a target; the choice is clamped so the estimated brick count fits a budget and the
 * footprint/height stay inside the lattice limits.
 *
 * Both budget terms (wall bricks: perimeter x height, slab bricks: area) grow with the SQUARE of the scale, so
 * the clamp is closed-form: `s = target * sqrt(budget / estimate(target))`.
 * TODO(budget): replace `estimateBrickCount` with X-09's `verify/budget.ts` once it merges; this is a heuristic
 * of shell bricks (running-bond walls at ~3 studs per element, 2 slabs per volume at ~6 studs^2 per element).
 */
import type { ModelScale, Vec2m } from '../types.js';
import { ringArea } from './geometry.js';

/** LDU per stud / per plate: the lattice's isotropic ratio. */
export const LDU_PER_STUD = 20;
export const LDU_PER_PLATE = 8;
export const PLATES_PER_STUD = LDU_PER_STUD / LDU_PER_PLATE;

/** Named product scales. `architecture` is the landmark default (about 1:125, 1 stud per metre). */
export const SCALE_PRESETS = {
  architecture: 1,
  /**
   * Walk-in / figure scale: a minifigure is ~4.75 studs tall for a ~1.75 m person (2.7 studs per metre).
   * TODO(figure-scale): take the exact figure from F01's study when it lands.
   */
  figure: 2.7,
} as const;

export interface ScaleRequest {
  /** Studs per metre wanted before clamping; a number or a preset name (default `architecture`). */
  target?: number | keyof typeof SCALE_PRESETS;
  /** Brick budget for the whole design (default 40,000). */
  maxBricks?: number;
  /** Longest footprint side allowed, studs (default 512). */
  maxStudsXZ?: number;
  /** Tallest point allowed, plates (default 1,536 = 192 bricks). */
  maxPlates?: number;
  /** Never go below this many studs per metre (default 0.05). */
  minStudsPerMetre?: number;
}

/** One volume in metres, the shape the estimator and the scale choice need. */
export interface MetreVolume { outer: ReadonlyArray<Vec2m>; holes: ReadonlyArray<ReadonlyArray<Vec2m>>; baseM: number; topM: number }

/** Shell brick estimate for volumes at `studsPerMetre`. */
export function estimateBrickCount(volumes: ReadonlyArray<MetreVolume>, studsPerMetre: number): number {
  let total = 0;
  for (const v of volumes) {
    const perimeterM = [v.outer, ...v.holes].reduce((sum, ring) => sum + ring.reduce((s, p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return s + Math.hypot(q[0] - p[0], q[1] - p[1]);
    }, 0), 0);
    const bricksHigh = ((v.topM - v.baseM) * studsPerMetre * PLATES_PER_STUD) / 3;
    const areaStuds2 = (ringArea(v.outer) - v.holes.reduce((s, h) => s + ringArea(h), 0)) * studsPerMetre * studsPerMetre;
    total += (perimeterM * studsPerMetre * bricksHigh) / 3 + (2 * areaStuds2) / 6;
  }
  return total;
}

/** Chooses the scale; `reason` states every clamp that applied. */
export function chooseScale(volumes: ReadonlyArray<MetreVolume>, req: ScaleRequest = {}): ModelScale {
  const target = typeof req.target === 'string' ? SCALE_PRESETS[req.target] : req.target ?? SCALE_PRESETS.architecture;
  const maxBricks = req.maxBricks ?? 40_000;
  const maxXZ = req.maxStudsXZ ?? 512;
  const maxPlates = req.maxPlates ?? 1536;
  const floor = req.minStudsPerMetre ?? 0.05;
  const notes: string[] = [`target ${target} stud/m`];
  let s = target;

  const est = estimateBrickCount(volumes, target);
  if (est > maxBricks) {
    s = Math.min(s, target * Math.sqrt(maxBricks / est));
    notes.push(`clamped by brick budget ${maxBricks} (estimate ${Math.round(est)} at target)`);
  }
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, topM = 0;
  for (const v of volumes) {
    for (const [x, z] of v.outer) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
    topM = Math.max(topM, v.topM);
  }
  const sideM = Math.max(maxX - minX, maxZ - minZ);
  if (sideM * s > maxXZ) { s = maxXZ / sideM; notes.push(`clamped to ${maxXZ} studs on the longest side`); }
  if (topM * s * PLATES_PER_STUD > maxPlates) { s = maxPlates / (topM * PLATES_PER_STUD); notes.push(`clamped to ${maxPlates} plates tall`); }
  if (s < floor) { s = floor; notes.push(`raised to the ${floor} stud/m floor (budget will be exceeded)`); }
  // Round to 3 decimals so the stored scale is a clean number, never above the clamp that produced it.
  s = Math.floor(s * 1000 + 1e-9) / 1000;
  return { studsPerMetre: s, platesPerMetre: s * PLATES_PER_STUD, reason: `${notes.join('; ')} -> ${s} stud/m` };
}
