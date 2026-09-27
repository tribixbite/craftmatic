/**
 * Where the player sits in a vehicle, and whether their body can be SEEN there.
 *
 * The compiler finds the driver's EYE from the model's own evidence
 * (`findCockpit`: a seated figure, a seat mould, a steering wheel, the
 * canopy glass). The player's seat is that eye less the seated eye height, so
 * the first-person view is the driver's view out of the cockpit. What varies
 * is whether a player-sized body FITS there: a minifig-scale car was built
 * around a figure the player's own size, but a display car shrunk to its real
 * length (a 0.25× McLaren is 2.1 blocks tall) cannot hold an unscaled
 * 1.8-block player - the head goes through the roof and the arms through the
 * flanks.
 *
 * Until 2026-09-26 such a rider was sat ON the roof, like a kart
 * (`roofAtSeatBlocks − 0.55`): the body no longer clipped, but the player was
 * outside the car and the first-person view looked down on its roof. Now the
 * player always sits at the driver's seat, its EYE on the driver's eye at
 * every wand size, so the first-person view is the driver's. Where the body
 * does not fit at the size the vehicle was placed, the rider is made
 * INVISIBLE while riding (vehicle-camera.js); at a size where it fits
 * (`riderVisibleSizes`), the rider is drawn in the seat.
 *
 * Everything here is in the ENTITY frame the rideable seats use: blocks, Y up
 * from the model's floor, the nose toward −Z, before the JSON X mirror.
 */

import { SEATED_EYE_HEIGHT_BLOCKS } from './lego-scale.js';

export type Vec3 = [number, number, number];
/** A model box (entity frame, blocks). `glass`: a translucent part, seen through (the eye and the view ignore it). */
export interface BoxBlocks { min: Vec3; max: Vec3; glass?: boolean }

/**
 * A riding player's eye above its seat position: the measured 1.12
 * (`SEATED_EYE_HEIGHT_BLOCKS`, lego-scale.ts), the one value every seat uses.
 */
export const RIDER_EYE_ABOVE_SEAT = SEATED_EYE_HEIGHT_BLOCKS;

/**
 * The seated player's body, relative to its seat position (the rider's
 * origin), in blocks. The player model is 32 px tall at 0.9375 (1.875
 * blocks): the head a 0.47-block cube, the torso 0.47 wide and 0.7 tall,
 * each arm 0.23 wide beside it (0.94 across the shoulders), arms reaching a
 * little forward in the riding pose. The eye is `RIDER_EYE_ABOVE_SEAT`
 * above the seat, a quarter of the head below its top. The legs and the
 * pelvis are not probed: the legs go under a dashboard or into a footwell
 * that is usually modelled solid, the pelvis sinks into the cushion (a
 * player's eye stands 0.95 above its hips where a seated minifig's stands
 * 0.81, so a player on a minifig seat mould sits 0.15 into its pan), and
 * nobody sees either there.
 */
export const SEATED_RIDER_PROBES: ReadonlyArray<{ name: 'head' | 'torso'; min: Vec3; max: Vec3 }> = [
  { name: 'head', min: [-0.235, RIDER_EYE_ABOVE_SEAT - 0.25, -0.235], max: [0.235, RIDER_EYE_ABOVE_SEAT + 0.22, 0.235] },
  { name: 'torso', min: [-0.45, RIDER_EYE_ABOVE_SEAT - 0.8, -0.3], max: [0.45, RIDER_EYE_ABOVE_SEAT - 0.25, 0.15] },
];

/**
 * The share of each probe that may lie inside the model and still count as a
 * fit. The head may graze (a hair's width of canopy); the torso may brush the
 * seat back, a door card or a steering wheel with its arms.
 * TODO(seat-fit): tolerances chosen from the 2026-09-26 census, not from a
 * device judgement of every set; revisit if a rider reads as clipping.
 */
export const SEAT_FIT_TOLERANCE = { head: 0.08, torso: 0.2 } as const;

/** The wand's size factors at and above 100 % a rider's fit is tested at (bedrock-scene-actors `WAND_SIZE_STEPS`). */
export const SEAT_FIT_STEPS = [1, 1.5, 2, 3, 4] as const;

/** Sampling pitch inside a probe, blocks. */
const SAMPLE_STEP = 0.05;

/**
 * Share of each probe (at `seat`, the model scaled by `f` about its origin)
 * that lies inside any OPAQUE box. Glass is a shell the rider is seen
 * through, not a solid: a canopy mould's cuboids fill the space under it,
 * and counting them kept 76286's pilot out of the Milano's cockpit at every
 * size (head and torso 38 % "inside" its canopy; 0 % and 8 % without it).
 */
export function riderOverlap(boxes: readonly BoxBlocks[], seat: Vec3, f = 1): { head: number; torso: number } {
  const out = { head: 0, torso: 0 };
  for (const probe of SEATED_RIDER_PROBES) {
    // The model is scaled by f about its origin and the rider is not: test the
    // probe shrunk by 1/f in the model's own frame, which is the same thing.
    const lo: Vec3 = [0, 0, 0], hi: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) { lo[k] = seat[k]! + probe.min[k]! / f; hi[k] = seat[k]! + probe.max[k]! / f; }
    const near = boxes.filter(b => !b.glass && b.max[0] > lo[0] && b.min[0] < hi[0] && b.max[1] > lo[1] && b.min[1] < hi[1] && b.max[2] > lo[2] && b.min[2] < hi[2]);
    const n = [0, 1, 2].map(k => Math.max(1, Math.round((probe.max[k]! - probe.min[k]!) / SAMPLE_STEP)));
    let inside = 0, total = 0;
    for (let i = 0; i < n[0]!; i++) for (let j = 0; j < n[1]!; j++) for (let l = 0; l < n[2]!; l++) {
      const p = [lo[0] + (hi[0] - lo[0]) * (i + 0.5) / n[0]!, lo[1] + (hi[1] - lo[1]) * (j + 0.5) / n[1]!, lo[2] + (hi[2] - lo[2]) * (l + 0.5) / n[2]!];
      total++;
      // Below the model's floor is the ground (or, aloft, the body hanging out
      // under the hull): a seat sunk under the floor does not fit.
      if (p[1]! < 0 || near.some(b => p[0]! >= b.min[0] && p[0]! <= b.max[0] && p[1]! >= b.min[1] && p[1]! <= b.max[1] && p[2]! >= b.min[2] && p[2]! <= b.max[2])) inside++;
    }
    out[probe.name] = total ? Math.round(inside / total * 1000) / 1000 : 0;
  }
  return out;
}

export const riderFits = (o: { head: number; torso: number }): boolean => o.head <= SEAT_FIT_TOLERANCE.head && o.torso <= SEAT_FIT_TOLERANCE.torso;

/**
 * The drawn rider's hips sit ~0.3 above the seat; a seat more than this far
 * below the model's floor (at the placed size) puts the pelvis and legs out
 * under the model - a 60221 helm seat at -0.27 would have drawn the legs
 * through the hull. The torso probe cannot see it (the pelvis is not probed).
 */
export const SEAT_FLOOR_SLACK = 0.15;

/** Share of the model's length at either end a searched seat may not enter. */
export const SEAT_END_MARGIN = 0.06;

/** Anything reaching above the eye straight over the seat (a roof, a canopy's glass)? */
function roofed(boxes: readonly BoxBlocks[], seat: Vec3): boolean {
  const eyeY = seat[1] + RIDER_EYE_ABOVE_SEAT;
  return boxes.some(b => b.min[0] <= seat[0] && b.max[0] >= seat[0] && b.min[2] <= seat[2] && b.max[2] >= seat[2] && b.max[1] > eyeY + 0.05 && b.min[1] < eyeY + 3);
}

/** Model beside the torso on both sides within reach (a door, a flank, a gunwale)? */
function sided(boxes: readonly BoxBlocks[], seat: Vec3): boolean {
  const y0 = seat[1] + 0.5, y1 = seat[1] + 0.9, z0 = seat[2] - 0.3, z1 = seat[2] + 0.3;
  const band = boxes.filter(b => b.max[1] > y0 && b.min[1] < y1 && b.max[2] > z0 && b.min[2] < z1);
  return band.some(b => b.max[0] <= seat[0] - 0.2 && b.max[0] >= seat[0] - 1.4) && band.some(b => b.min[0] >= seat[0] + 0.2 && b.min[0] <= seat[0] + 1.4);
}

/** Something to sit on under the hips: a surface at the seat to half a block over it, or the floor. */
function supported(boxes: readonly BoxBlocks[], seat: Vec3): boolean {
  if (seat[1] + 0.3 <= 0.15) return true;
  return boxes.some(b => b.min[0] <= seat[0] + 0.2 && b.max[0] >= seat[0] - 0.2 && b.min[2] <= seat[2] + 0.25 && b.max[2] >= seat[2] - 0.1 && b.max[1] >= seat[1] - 0.05 && b.max[1] <= seat[1] + 0.55);
}

/** The driver's seat and the size from which a player's body fits it. */
export interface SeatPlan {
  /** The driver's eye (entity frame, blocks at 100 %). */
  eye: Vec3;
  /**
   * The seat at 100 %: the eye less the seated eye height, NOT clamped to the
   * floor. Where the body fits, the eye is high enough for the seat to be
   * above the floor; where it does not, the body is hidden and only the eye
   * matters.
   */
  seat: Vec3;
  /**
   * Smallest of `SEAT_FIT_STEPS` at which the seated body fits; null when it
   * fits at none (up to 400 %). Not a threshold: a bigger model can also bring
   * a lap-high dashboard or the floor up into a relatively smaller rider, so
   * each step decides for itself (`riderVisibleAt`, `riderVisibleSizes`).
   */
  fitScale: number | null;
  /** The measured overlap at each step, for the diagnostics. */
  steps: Array<{ f: number; head: number; torso: number; fits: boolean }>;
  /** How far the search moved the seat from its evidence (x toward the centre line, y, z toward the tail); null = not moved. */
  moved: Vec3 | null;
  /** The search, when it ran: whether the evidence's cabin has a roof and sides the seat must stay under and between, candidates tried, and how many left the cabin. */
  search?: { needRoof: boolean; needSides: boolean; tried: number; outOfCabin: number } | null;
  /** A hidden rider's eye moved out of the model into air (x, y, z); null/absent = not moved. */
  eyeMoved?: Vec3 | null;
}

/**
 * How far a seat may be moved from its evidence to find room for the body
 * (blocks: back toward the tail, down, up, and toward the centre line). A
 * canopy or a default cabin is a VOLUME, not a seat: its centre put the
 * rider's chest in the dashboard of every minifig-scale car in the census
 * (42639's car 63 % of the torso inside, 60380's food truck 36 %) where the
 * source's driver sits a stud or two further back. A steering wheel fixes
 * the driver more closely, but its eye is a SEATED minifig's (20 LDU over
 * the wheel): a player's eye stands 0.14 higher over the same pan, and a
 * boat's helm is steered standing (60221's seat came out 0.27 under the
 * keel), so it may rise half a block. A seated figure or a seat mould IS the seat and
 * is never moved.
 */
export const SEAT_SEARCH = {
  volume: { back: 0.9, down: 0.4, up: 0.2 },
  steering: { back: 0.4, down: 0.2, up: 0.5 },
  /** Candidate spacing, blocks. */
  step: 0.1,
} as const;

/**
 * A searched seat whose rider is still hidden at 100 % is judged by what its
 * EYE sees: never trade the evidence's view for one with more of the model in
 * the head (a 1989 Batmobile candidate fit from 300 % with 73 % of the head
 * inside the body, against 32 % at the canopy).
 */
export function keepsTheView(at100: { fits: boolean; head: number }, evidenceHead: number): boolean {
  return at100.fits || at100.head <= evidenceHead + 1e-9;
}

/** The evidence a seat came from, as far as the search cares. */
export type SeatEvidence = 'seat' | 'steering' | 'volume';

/** Measure a driver's seat against the model's boxes (entity frame, blocks). */
export function planSeat(boxes: readonly BoxBlocks[], eye: Vec3, seat: Vec3, evidence: SeatEvidence = 'seat'): SeatPlan {
  // At wand factor f the seat is `seatPositionAt(s, f)`, i.e. in the model's
  // own (unscaled) frame the eye stays put and the unscaled body hangs 1.25/f
  // under it.
  const measure = (s: Vec3): SeatPlan['steps'] => SEAT_FIT_STEPS.map(f => {
    const at: Vec3 = [s[0], s[1] + RIDER_EYE_ABOVE_SEAT - RIDER_EYE_ABOVE_SEAT / f, s[2]];
    const o = riderOverlap(boxes, at, f);
    return { f, ...o, fits: riderFits(o) && at[1] * f + SEAT_FLOOR_SLACK >= 0 };
  });
  const fitOf = (steps: SeatPlan['steps']): number | null => steps.find(s => s.fits)?.f ?? null;
  let best = { seat, eye, steps: measure(seat), moved: null as Vec3 | null };
  let search: SeatPlan['search'] = null;
  if (evidence !== 'seat' && !best.steps[0]!.fits) {
    // Search the cabin around the evidence for the spot the body fits at the
    // smallest size (then the least overlap at 100 %, then the least move).
    const range = evidence === 'steering' ? SEAT_SEARCH.steering : SEAT_SEARCH.volume;
    const n = (v: number): number => Math.round(v / SEAT_SEARCH.step);
    const rank = (steps: SeatPlan['steps'], move: number): [number, number, number] => [fitOf(steps) ?? 99, steps[0]!.head + steps[0]!.torso, move];
    const better = (a: [number, number, number], b: [number, number, number]): boolean => a[0] < b[0] - 1e-9 || (a[0] === b[0] && (a[1] < b[1] - 1e-6 || (Math.abs(a[1] - b[1]) <= 1e-6 && a[2] < b[2])));
    let bestRank = rank(best.steps, 0);
    const evidenceHead = best.steps[0]!.head;
    // A moved seat stays IN the cabin the evidence is in: under its roof if the
    // evidence has one, between its sides if the evidence has them, and always
    // on something (a 0.25x Ferrari's search otherwise walked out onto the
    // engine deck at the tail, where open air "fits" anyone).
    const needRoof = roofed(boxes, seat), needSides = sided(boxes, seat);
    // Nor into the last 6 % at either end: no driver sits on a bumper (the
    // same Ferrari's canopy evidence lay aft, and the search reached 0.24
    // blocks, 3 %, from its tail). 15 % shut a cab-forward van's driver out of
    // its own cab (60253's helm is 7 % from the nose).
    const zs = boxes.flatMap(b => [b.min[2], b.max[2]]);
    const z0 = Math.min(...zs), z1 = Math.max(...zs), endMargin = (z1 - z0) * SEAT_END_MARGIN;
    const inCabin = (c: Vec3): boolean => c[2] >= z0 + endMargin && c[2] <= z1 - endMargin && supported(boxes, c) && (!needRoof || roofed(boxes, c)) && (!needSides || sided(boxes, c));
    search = { needRoof, needSides, tried: 0, outOfCabin: 0 };
    const xs = [...new Set([0, 0.25, 0.5, 0.75, 1].map(t => Math.round(seat[0] * (1 - t) * 100) / 100))];
    for (let k = 0; k <= n(range.back); k++) for (let j = -n(range.down); j <= n(range.up); j++) for (const x of xs) {
      const dz = k * SEAT_SEARCH.step, dy = j * SEAT_SEARCH.step;
      const s: Vec3 = [x, Math.round((seat[1] + dy) * 100) / 100, Math.round((seat[2] + dz) * 100) / 100];
      search.tried++;
      if ((dz || dy || x !== seat[0]) && !inCabin(s)) { search.outOfCabin++; continue; }
      const steps = measure(s);
      if (!keepsTheView(steps[0]!, evidenceHead)) continue;
      const r = rank(steps, Math.hypot(dz, dy, x - seat[0]));
      if (better(r, bestRank)) { bestRank = r; best = { seat: s, eye: [s[0], Math.round((s[1] + RIDER_EYE_ABOVE_SEAT) * 100) / 100, s[2]], steps, moved: [Math.round((s[0] - seat[0]) * 100) / 100, Math.round(dy * 100) / 100, Math.round(dz * 100) / 100] }; }
    }
    // Keep the evidence's own seat unless the search found one that fits at a smaller size.
    if ((fitOf(best.steps) ?? 99) >= (fitOf(measure(seat)) ?? 99)) best = { seat, eye, steps: measure(seat), moved: null };
  }
  // A rider hidden at 100 % is only its EYE there, and the eye must be in air:
  // 42172's canopy-centre eye sat inside the body, and the cockpit view on the
  // Saga (2026-09-26) was the dark inside of its cuboids. Move the eye to the
  // nearest clear point (back, up, toward the centre line) when it is not.
  let eyeMoved: Vec3 | null = null;
  // The camera is the SEAT's eye (seat + the seated eye height), which for a
  // canopy is 0.35 behind the glass centre the evidence named.
  const camera: Vec3 = [best.seat[0], Math.round((best.seat[1] + RIDER_EYE_ABOVE_SEAT) * 100) / 100, best.seat[2]];
  if (!best.steps[0]!.fits && (eyeOverlap(boxes, camera) > 0 || !forwardClear(boxes, camera))) {
    const r = EYE_CLEAR_SEARCH, n = (v: number): number => Math.round(v / SEAT_SEARCH.step);
    let pick: { eye: Vec3; overlap: number; blocked: number; move: number } = { eye: camera, overlap: eyeOverlap(boxes, camera), blocked: forwardClear(boxes, camera) ? 0 : 1, move: 0 };
    const xs = [...new Set([0, 0.25, 0.5, 0.75, 1].map(t => Math.round(camera[0] * (1 - t) * 100) / 100))];
    // Under a roof the eye stays under one: out through it is the kart's view again.
    const overhead = (e: Vec3): boolean => boxes.some(b => b.min[0] <= e[0] && b.max[0] >= e[0] && b.min[2] <= e[2] && b.max[2] >= e[2] && b.min[1] > e[1] + 0.05 && b.min[1] < e[1] + 2);
    const needOverhead = overhead(camera);
    for (let k = 0; k <= n(r.back); k++) for (let j = -n(r.down); j <= n(r.up); j++) for (const x of xs) {
      const e: Vec3 = [x, Math.round((camera[1] + j * SEAT_SEARCH.step) * 100) / 100, Math.round((camera[2] + k * SEAT_SEARCH.step) * 100) / 100];
      if (e[1] <= 0.1 || (needOverhead && !overhead(e))) continue;
      const overlap = eyeOverlap(boxes, e), blocked = forwardClear(boxes, e) ? 0 : 1, move = Math.hypot(e[0] - camera[0], e[1] - camera[1], e[2] - camera[2]);
      // In air first, then a view out ahead (over the dashboard, through the windscreen), then the least move.
      const same = Math.abs(overlap - pick.overlap) <= 1e-9;
      if (overlap < pick.overlap - 1e-9 || (same && blocked < pick.blocked) || (same && blocked === pick.blocked && move < pick.move)) pick = { eye: e, overlap, blocked, move };
    }
    if (pick.move > 0) {
      eyeMoved = [Math.round((pick.eye[0] - camera[0]) * 100) / 100, Math.round((pick.eye[1] - camera[1]) * 100) / 100, Math.round((pick.eye[2] - camera[2]) * 100) / 100];
      const s2: Vec3 = [pick.eye[0], Math.round((pick.eye[1] - RIDER_EYE_ABOVE_SEAT) * 100) / 100, pick.eye[2]];
      best = { seat: s2, eye: pick.eye, steps: measure(s2), moved: best.moved };
    }
  }
  return { eye: best.eye, seat: best.seat, fitScale: fitOf(best.steps), steps: best.steps, moved: best.moved, search, eyeMoved };
}

/**
 * Whether the view straight ahead of an eye (toward the nose, -Z) leaves the
 * model through air or glass only: at eye height and 0.1 above it, no opaque
 * box in front of the eye before the model's nose.
 */
export function forwardClear(boxes: readonly BoxBlocks[], eye: Vec3): boolean {
  return ![0, 0.1].some(dy => boxes.some(b => !b.glass && b.min[0] <= eye[0] && b.max[0] >= eye[0] && b.min[1] <= eye[1] + dy && b.max[1] >= eye[1] + dy && b.max[2] < eye[2] - 0.1));
}

/** How far a hidden rider's eye may move to reach air (blocks: toward the tail, up, down). */
export const EYE_CLEAR_SEARCH = { back: 0.9, up: 0.6, down: 0.3 } as const;

/** Share of a 0.2-block box around the eye that lies inside the model (0 = the camera is in air). */
export function eyeOverlap(boxes: readonly BoxBlocks[], eye: Vec3): number {
  const h = 0.1, n = 4;
  const near = boxes.filter(b => !b.glass && b.max[0] > eye[0] - h && b.min[0] < eye[0] + h && b.max[1] > eye[1] - h && b.min[1] < eye[1] + h && b.max[2] > eye[2] - h && b.min[2] < eye[2] + h);
  if (!near.length) return 0;
  let inside = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let l = 0; l < n; l++) {
    const p = [eye[0] - h + (i + 0.5) * 2 * h / n, eye[1] - h + (j + 0.5) * 2 * h / n, eye[2] - h + (l + 0.5) * 2 * h / n];
    if (near.some(b => p[0]! >= b.min[0] && p[0]! <= b.max[0] && p[1]! >= b.min[1] && p[1]! <= b.max[1] && p[2]! >= b.min[2] && p[2]! <= b.max[2])) inside++;
  }
  return inside / (n * n * n);
}

/**
 * Whether the rider's body is drawn at wand factor `f`: only at a measured
 * step where it fits. Below 100 % (the 25-75 % steps) it is never drawn: the
 * model is smaller than the one it was measured at.
 */
export function riderVisibleAt(plan: Pick<SeatPlan, 'steps'>, f: number): boolean {
  return plan.steps.some(s => s.fits && Math.abs(s.f - f) < 1e-6);
}

/**
 * The wand size factors at which vehicle-camera.js shows the rider (every
 * other size hides it). No plan (a grid-only vehicle): always shown, `null`.
 */
export const riderVisibleSizes = (plan: Pick<SeatPlan, 'steps'> | undefined): number[] | null =>
  plan ? plan.steps.filter(s => s.fits).map(s => s.f) : null;

/**
 * A seat's position at wand factor `f`: the rider's EYE stays on the scaled
 * driver's eye (the seat was derived from that eye, less the seated eye
 * height), because the model scales and the player does not. At 400 % a
 * quarter-scale car is a minifig-scale car and the player sits where its
 * minifig driver would, eye to eye; scaling the whole seat instead kept a
 * quarter-scale seat under the floor at every size.
 */
export function seatPositionAt(position: Vec3, f: number): Vec3 {
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return [r3(position[0] * f), r3((position[1] + RIDER_EYE_ABOVE_SEAT) * f - RIDER_EYE_ABOVE_SEAT), r3(position[2] * f)];
}
