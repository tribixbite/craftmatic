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
  /** A guessed seat's (`none`) forward view (`forwardView`) at the evidence's seat and at the one shipped; absent for other evidence. */
  view?: { before: number; after: number } | null;
  /**
   * The horizon ahead (`AHEAD`, share of its rays clear) from the eye the
   * earlier steps chose and from the one shipped, and how far the eye moved
   * to see it (x, y, z; null = not moved). Every seat has it. `sides`: the
   * view to either side (`SIDES`, share of each side's rays clear) before and
   * after. `fallback`: no eye in the cabin saw ahead, so the eye left it
   * (`AHEAD_FALLBACK`) and the rider is hidden at every size.
   */
  ahead?: { before: number; after: number; moved: Vec3 | null; sides?: { before: SideView; after: SideView }; fallback?: boolean };
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

/**
 * The evidence a seat came from, as far as the search cares. `none`: nothing
 * in the model says where a driver sits (`findCockpit`'s default cabin: a doll
 * or Technic car with no figure, seat, wheel or glass) - the seat is a guess,
 * and it is judged by what its eye SEES (`VIEW`).
 */
export type SeatEvidence = 'seat' | 'steering' | 'volume' | 'none';

/**
 * The driver's view out ahead, for a seat with no evidence (`none`): rays from
 * the eye over a forward cone (yaw and pitch offsets, degrees, nose toward
 * -Z), each clear when it leaves the model's bounds through air or glass. A
 * guessed seat whose view is blocked is moved to one whose view is clear:
 * Gabby's doll cars (10797's cat bus, 10796's carts) sat the rider's eye
 * inside their bodywork, so the first-person view was a wall of colour
 * (Saga, 2026-09-29). Only at minifig scale (the compiler asks): a display
 * car shrunk to its real length has a real cabin whose bonnet fills the low
 * rays (42172 scored 0.4 and its windscreen view is device-checked good).
 */
export const VIEW = {
  yaw: [-30, -15, 0, 15, 30],
  pitch: [-15, -5, 5],
  /** Share of the rays that must be clear. */
  minClear: 0.9,
  /** March step along a ray, blocks. */
  step: 0.05,
  /** How far over the model's top a searched eye may go, blocks (a player sitting on a toy car's roof). */
  overTop: 1.4,
} as const;

/** Share of the forward view rays from `eye` that leave the model through air or glass (1 = all clear). */
export function forwardView(boxes: readonly BoxBlocks[], eye: Vec3): number {
  const opaque = boxes.filter(b => !b.glass);
  if (!opaque.length) return 1;
  const lo: Vec3 = [Math.min(...boxes.map(b => b.min[0])), Math.min(...boxes.map(b => b.min[1])), Math.min(...boxes.map(b => b.min[2]))];
  const hi: Vec3 = [Math.max(...boxes.map(b => b.max[0])), Math.max(...boxes.map(b => b.max[1])), Math.max(...boxes.map(b => b.max[2]))];
  let clear = 0, total = 0;
  for (const yd of VIEW.yaw) for (const pd of VIEW.pitch) {
    total++;
    const y = yd * Math.PI / 180, p = pd * Math.PI / 180;
    const d: Vec3 = [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
    let hit = false;
    for (let s = VIEW.step; !hit; s += VIEW.step) {
      const q: Vec3 = [eye[0] + d[0] * s, eye[1] + d[1] * s, eye[2] + d[2] * s];
      if (q[0] < lo[0] || q[0] > hi[0] || q[1] < lo[1] || q[1] > hi[1] || q[2] < lo[2] || q[2] > hi[2]) break;
      hit = opaque.some(b => q[0] >= b.min[0] && q[0] <= b.max[0] && q[1] >= b.min[1] && q[1] <= b.max[1] && q[2] >= b.min[2] && q[2] <= b.max[2]);
    }
    if (!hit) clear++;
  }
  return clear / total;
}

/** A fan of view rays from an eye: yaw and pitch offsets from the nose, degrees (+pitch looks up). */
export interface ViewFan { yaw: readonly number[]; pitch: readonly number[] }

/**
 * THE HORIZON AHEAD, the one test every driver's eye passes whatever its
 * evidence (a seated figure, a seat, a wheel, glass or a guess): the rays at
 * the level and 5 degrees over it, straight ahead and 15 degrees either side,
 * leave the vehicle through air or glass. Below the level a bonnet or a
 * dashboard may fill the view (42172 at 0.25x: 6 of `VIEW`'s 15 rays clear,
 * every one of these, and its windscreen view is device-checked good); what
 * may not is a panel in front of the face, which hides the road wherever the
 * player looks - 42639's driver sat 0.23 block behind a raised door and none
 * of these rays cleared (Pixel round 30f, the cockpit view two thirds teal) -
 * nor a steering wheel's rim over the level, which hides the road straight
 * ahead (a minifig-scale wheel is half a block across, half a block from the
 * eye: 42639 and 60380 at the wheel's own eye height).
 */
export const AHEAD: ViewFan & { minClear: number } = { yaw: [-15, 0, 15], pitch: [0, 5], minClear: 1 };

/**
 * How far the eye may move to see the horizon ahead (blocks: up over a wheel
 * or a dashboard, back from a panel), in `step`s, and never out through a roof
 * it sat under nor more than `VIEW.overTop` over the model's top.
 */
export const AHEAD_SEARCH = { up: 0.6, back: 0.6, step: 0.05 } as const;

/** The direction of a fan ray in the entity frame (nose toward -Z, +y up). */
export function fanDirection(yawDeg: number, pitchDeg: number): Vec3 {
  const y = yawDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}

/** Whether a ray from `o` along `d` (a unit vector) meets the box within `reach` blocks (slab test; an eye inside the box is blocked). */
function rayHitsBox(o: Vec3, d: Vec3, b: BoxBlocks, reach = Infinity): boolean {
  let t0 = 1e-6, t1 = reach;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (o[k]! < b.min[k]! || o[k]! > b.max[k]!) return false; continue; }
    let a = (b.min[k]! - o[k]!) / d[k]!, c = (b.max[k]! - o[k]!) / d[k]!;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Share of a fan's rays from `eye` that leave the model through air or glass
 * (exact ray-box tests, as the simulator's `forwardViewWorld` casts them);
 * with a `reach`, only what stands within that many blocks of the eye counts.
 */
export function fanView(boxes: readonly BoxBlocks[], eye: Vec3, fan: ViewFan, reach = Infinity): number {
  const opaque = boxes.filter(b => !b.glass);
  let clear = 0, total = 0;
  for (const yd of fan.yaw) for (const pd of fan.pitch) {
    total++;
    const d = fanDirection(yd, pd);
    if (!opaque.some(b => rayHitsBox(eye, d, b, reach))) clear++;
  }
  return total ? clear / total : 1;
}

/** Whether an eye sees the horizon ahead (`AHEAD`). */
export const seesAhead = (boxes: readonly BoxBlocks[], eye: Vec3): boolean => fanView(boxes, eye, AHEAD) >= AHEAD.minClear - 1e-9;

/**
 * THE VIEW TO EITHER SIDE of the road ahead: no panel BESIDE the face. Rays
 * 20 to 50 degrees off the nose, 5 degrees under the level to 10 over it, on
 * each side; a ray is blocked by an opaque part within `near` blocks of the
 * eye. `AHEAD` cannot see such a panel: 42639's raised door, 0.4 block beside
 * the driver, passed all six of its rays and still filled the left ~35 % of
 * the cockpit view (Saga round 30g, `s70-42639-cockpit`; a device screen is
 * ~115 degrees wide, the panel spans ~20-57 degrees off the nose). Only what
 * is NEAR counts: a panel at arm's length fills a third of the screen, while
 * the body of the car a block or more away (42172's sills, a ship's rigging)
 * is what a driver expects to see, and a device-good cockpit has none within
 * reach (42172, 60380, 7140, 60221, 10797: all 28 rays of each side clear).
 * `minClear` lets a thin pillar through (75892's: 2 of 28), not a panel:
 * 42639's door blocked 24 of 28 at its first eye and 6 at a quarter block
 * higher, where its top still stood on the horizon.
 */
export const SIDES = { yaw: [20, 25, 30, 35, 40, 45, 50], pitch: [-5, 0, 5, 10], near: 1, minClear: 0.9 } as const;

/** One side's fan of `SIDES` (+1: toward +x of this frame, the driver's right with the nose at -Z; -1: the left). */
export const sideFan = (side: 1 | -1): ViewFan => ({ yaw: SIDES.yaw.map(y => y * side), pitch: SIDES.pitch });

/** Share of each side's `SIDES` rays that meet no opaque part within `SIDES.near`. */
export interface SideView { left: number; right: number }

/** The view to either side of an eye (`SIDES`). */
export const sideView = (boxes: readonly BoxBlocks[], eye: Vec3): SideView => ({ left: fanView(boxes, eye, sideFan(-1), SIDES.near), right: fanView(boxes, eye, sideFan(1), SIDES.near) });

/**
 * THE DRIVER SEES OUT: the one judgement of a driver's eye, shared by the
 * compiler (`planSeat`) and the simulator's `driver-sees-ahead` invariant -
 * every `AHEAD` ray clear, and at least `SIDES.minClear` of each side's rays.
 * Takes the measured shares so either frame (the compiler's boxes, the
 * simulator's drawn world) is judged by the same numbers.
 */
export function driverSeesOut(ahead: number, sides: SideView): boolean {
  return ahead >= AHEAD.minClear - 1e-9 && sides.left >= SIDES.minClear - 1e-9 && sides.right >= SIDES.minClear - 1e-9;
}

/** Whether an eye passes `driverSeesOut` over these boxes. */
export const seesOut = (boxes: readonly BoxBlocks[], eye: Vec3): boolean => driverSeesOut(fanView(boxes, eye, AHEAD), sideView(boxes, eye));

/**
 * When no eye in the cabin sees the horizon ahead (`AHEAD_SEARCH` under the
 * roof it sat under found none), the eye LEAVES the cabin: up to
 * `VIEW.overTop` over the model's top and `back` blocks toward the tail, in
 * `step`s, never past the tail and never inside the model - the nearest point
 * that sees ahead (and, if one within `sideSlack` further does, to the sides
 * too). 76286's canopy evidence is a rear window, and its eye sat in the hull
 * looking down the whole fuselage (Saga round 30g, `s74-76286-cockpit`: all
 * grey panels); 14 of 41 audited rideables had no eye in the cabin that saw
 * ahead. The rider there is only an eye: its body is hidden at every size (a
 * body drawn over a roof is the kart rule removed on 2026-09-26). A child
 * must SEE where they are going; a closed display cockpit's windscreen view is
 * not worth a wall of grey.
 */
export const AHEAD_FALLBACK = { back: 2, step: 0.1, sideSlack: 0.5 } as const;

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
  // A guessed seat (`none`) is judged by its view: when the eye cannot see out
  // ahead, the seat moves to the nearest one that can - on a surface of the
  // model (the hips on it), anywhere along its length but the ends, a body
  // that fits preferred to a hidden one, then the lower eye. On a doll car that is its roof or
  // rear deck: the player rides it the way a child sits on a toy car.
  let view: SeatPlan['view'] = null;
  if (evidence === 'none') {
    // Judged where the game puts the rider's eye: 1.12 over the seat (quirk `rider-eye-above-seat`), not at the
    // cockpit point the seat was guessed from - 910047's boat scored 15/15 at its cockpit point, 0.35 block ahead
    // of and 0.15 beside the seat, while the rider's own eye saw out of 13 of 15 (simulator triage 2026-09-30).
    const before = forwardView(boxes, [best.seat[0], best.seat[1] + RIDER_EYE_ABOVE_SEAT, best.seat[2]]);
    view = { before, after: before };
    if (before < VIEW.minClear) {
      const r2 = (v: number): number => Math.round(v * 100) / 100;
      const zs = boxes.flatMap(b => [b.min[2], b.max[2]]);
      const z0 = Math.min(...zs), z1 = Math.max(...zs), margin = (z1 - z0) * SEAT_END_MARGIN;
      const modelTop = Math.max(...boxes.map(b => b.max[1]));
      const xs = [...new Set([0, best.seat[0]])];
      let pick: { seat: Vec3; eye: Vec3; view: number; rank: [number, number, number, number] } | null = null;
      for (let z = z0 + margin; z <= z1 - margin + 1e-9; z += SEAT_SEARCH.step) for (const x of xs) {
        // The surfaces the hips can sit on here: every opaque top of the model under the seat's
        // footprint (never the ground beside it: a rider sat on the grass at a doll truck's bumper).
        const tops = boxes.filter(b => !b.glass && b.min[0] <= x + 0.2 && b.max[0] >= x - 0.2 && b.min[2] <= z + 0.25 && b.max[2] >= z - 0.1).map(b => b.max[1]);
        for (const top of new Set(tops.map(r2))) {
          const s: Vec3 = [r2(x), r2(top - 0.3), r2(z)];
          const e: Vec3 = [s[0], r2(s[1] + RIDER_EYE_ABOVE_SEAT), s[2]];
          if (e[1] > modelTop + VIEW.overTop || eyeOverlap(boxes, e) > 0) continue;
          const v = forwardView(boxes, e);
          const fits = measure(s)[0]!.fits;
          const rank: [number, number, number, number] = [v >= VIEW.minClear ? 0 : 1, fits ? 0 : 1, Math.hypot(s[0] - best.seat[0], s[1] - best.seat[1], s[2] - best.seat[2]), e[1]];
          const better = !pick || rank.some((_, i) => rank.slice(0, i).every((q, j) => Math.abs(q - pick!.rank[j]!) < 1e-9) && rank[i]! < pick!.rank[i]! - 1e-9);
          if (better) pick = { seat: s, eye: e, view: v, rank };
        }
      }
      if (pick && pick.view >= VIEW.minClear) {
        best = { seat: pick.seat, eye: pick.eye, steps: measure(pick.seat), moved: [r2(pick.seat[0] - seat[0]), r2(pick.seat[1] - seat[1]), r2(pick.seat[2] - seat[2])] };
        eyeMoved = null;
        view = { before, after: pick.view };
      }
    }
  }
  // Every seat, whatever its evidence: the driver SEES OUT (`driverSeesOut`:
  // the horizon ahead, `AHEAD`, and the view to either side, `SIDES`). When it
  // does not - a panel, a raised door, a wheel's rim in front of or beside the
  // face - the eye moves to the nearest point that does, up over it or back
  // from it (`AHEAD_SEARCH`), across the car where the evidence put it, in
  // air, under the roof it sat under. A body drawn in the seat is kept drawn
  // if any such point allows it. Where no such point sees out to the sides,
  // the nearest that sees ahead will do; where none sees ahead either, the eye
  // leaves the cabin (`AHEAD_FALLBACK`).
  const r2 = (v: number): number => Math.round(v * 100) / 100;
  const eyeOf = (s: Vec3): Vec3 => [s[0], r2(s[1] + RIDER_EYE_ABOVE_SEAT), s[2]];
  const seatOf = (e: Vec3): Vec3 => [e[0], r2(e[1] - RIDER_EYE_ABOVE_SEAT), e[2]];
  const from = eyeOf(best.seat);
  const aheadOf = (e: Vec3): boolean => fanView(boxes, e, AHEAD) >= AHEAD.minClear - 1e-9;
  const aheadBefore = fanView(boxes, from, AHEAD), sidesBefore = sideView(boxes, from);
  let ahead: NonNullable<SeatPlan['ahead']> = { before: aheadBefore, after: aheadBefore, moved: null, sides: { before: sidesBefore, after: sidesBefore } };
  const take = (e: Vec3, steps: SeatPlan['steps'], fallback: boolean): void => {
    ahead = { before: aheadBefore, after: fanView(boxes, e, AHEAD), moved: [0, r2(e[1] - from[1]), r2(e[2] - from[2])], sides: { before: sidesBefore, after: sideView(boxes, e) }, ...(fallback ? { fallback } : {}) };
    best = { seat: seatOf(e), eye: e, steps, moved: best.moved };
  };
  if (!driverSeesOut(aheadBefore, sidesBefore)) {
    const n = (v: number): number => Math.round(v / AHEAD_SEARCH.step);
    const modelTop = Math.max(...boxes.map(b => b.max[1]));
    const underRoof = (e: Vec3): boolean => boxes.some(b => !b.glass && b.min[0] <= e[0] && b.max[0] >= e[0] && b.min[2] <= e[2] && b.max[2] >= e[2] && b.min[1] > e[1] + 0.05 && b.min[1] < e[1] + 2);
    const roofed0 = underRoof(from);
    const drawn0 = best.steps[0]!.fits;
    const seesAheadBefore = aheadBefore >= AHEAD.minClear - 1e-9;
    const candidates: Array<{ e: Vec3; move: number }> = [];
    for (let j = 0; j <= n(AHEAD_SEARCH.up); j++) for (let k = 0; k <= n(AHEAD_SEARCH.back); k++) {
      if (!j && !k) continue;
      const e: Vec3 = [from[0], r2(from[1] + j * AHEAD_SEARCH.step), r2(from[2] + k * AHEAD_SEARCH.step)];
      candidates.push({ e, move: Math.hypot(j, k) * AHEAD_SEARCH.step });
    }
    candidates.sort((a, b) => a.move - b.move);
    // The nearest point that sees out (ahead AND to the sides), unless a body drawn in the seat could stay
    // drawn a little further on; beside it, the nearest point that sees ahead only.
    let pick: { e: Vec3; drawn: boolean } | null = null, aheadOnly: { e: Vec3; drawn: boolean } | null = null;
    for (const { e } of candidates) {
      if (e[1] > modelTop + VIEW.overTop || eyeOverlap(boxes, e) > 0 || (roofed0 && !underRoof(e))) continue;
      if (!aheadOf(e)) continue;
      const drawn = measure(seatOf(e))[0]!.fits;
      if (!aheadOnly || (drawn0 && drawn && !aheadOnly.drawn)) aheadOnly = { e, drawn };
      if (!driverSeesOut(1, sideView(boxes, e))) continue;
      if (!pick || (drawn0 && drawn && !pick.drawn)) pick = { e, drawn };
      if (!drawn0 || drawn) break;
    }
    if (pick) take(pick.e, measure(seatOf(pick.e)), false);
    // The sides are a preference: an eye that already saw ahead stays where it was rather than trade the cabin for them.
    else if (!seesAheadBefore && aheadOnly) take(aheadOnly.e, measure(seatOf(aheadOnly.e)), false);
    else if (!seesAheadBefore) {
      // No eye in the cabin sees ahead: leave it, the nearest point up or back that does (`AHEAD_FALLBACK`).
      const f = AHEAD_FALLBACK, zs = boxes.flatMap(b => [b.min[2], b.max[2]]), tail = Math.max(...zs);
      const out: Array<{ e: Vec3; move: number }> = [];
      for (let j = 0; from[1] + j * f.step <= modelTop + VIEW.overTop + 1e-9; j++) for (let k = 0; k * f.step <= f.back + 1e-9; k++) {
        const e: Vec3 = [from[0], r2(from[1] + j * f.step), r2(from[2] + k * f.step)];
        if ((j || k) && e[2] <= tail) out.push({ e, move: Math.hypot(j, k) * f.step });
      }
      out.sort((a, b) => a.move - b.move);
      let near: { e: Vec3; move: number } | null = null, both: Vec3 | null = null;
      for (const c of out) {
        if (near && c.move > near.move + f.sideSlack + 1e-9) break;
        if (eyeOverlap(boxes, c.e) > 0 || !aheadOf(c.e)) continue;
        near ??= c;
        if (driverSeesOut(1, sideView(boxes, c.e))) { both = c.e; break; }
      }
      const e = both ?? near?.e;
      // Only an eye out there: the body is hidden at every size (`riderVisibleSizes` reads `fits`).
      if (e) take(e, measure(seatOf(e)).map(s => ({ ...s, fits: false })), true);
    }
  }
  return { eye: best.eye, seat: best.seat, fitScale: fitOf(best.steps), steps: best.steps, moved: best.moved, search, eyeMoved, ...(view ? { view } : {}), ahead };
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
 * A seat measured in the compiler's RENDER frame (this module's frame: nose
 * toward -Z) as a `minecraft:rideable` seat position (+Z the nose). The
 * geometry is drawn at (-x, y, -z) of the render frame - its JSON x is the
 * render x negated, and the world draws JSON x as x with z mirrored
 * (`drawnBoxes`, bedrock-geometry-faces `worldFaces`) - so the seat turns half
 * round with it, BOTH horizontal axes. Keeping x (until 2026-09-30) sat every
 * seat off the centre line mirrored across it: 60380's driver outside its cab
 * wall, 42639's beside its door (Pixel round 30f).
 */
export function renderSeatToEntity(p: Vec3): Vec3 {
  return [p[0] === 0 ? 0 : -p[0], p[1], p[2] === 0 ? 0 : -p[2]];
}

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
