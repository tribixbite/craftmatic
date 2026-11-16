/**
 * The doors, lids, cupboards, windows, levers and turnables a VEHICLE carries (audit 2026-11-15 A-02): a bus's
 * doors, a camper's cupboards, a ship's hatch. A building's moving part is its own hinged entity on a fixed frame
 * (bedrock-interactives.ts); a vehicle moves, so its parts are BONES in the vehicle's own geometry instead:
 *
 *   - each part hangs on a hinge chain (`hingeChain`, the interactives' tilt -> spin -> un-tilt) under the vehicle's
 *     `body` bone, so it leans with the body and rides with the vehicle with no per-tick work at all - the engine
 *     draws it where the vehicle is;
 *   - one float actor property per part (`craftmatic:vpart_<k>`) is its angle (a drawer's or sliding door's distance,
 *     LDU); the client eases toward it in Molang over `SWING_SECONDS`, as an interactive does;
 *   - the scripted-vehicle runtime (bedrock-vehicle.ts) answers a TAP on the parked vehicle: a part within
 *     `REACH_BLOCKS` of the eye that the view points at (`pickVehiclePart`) toggles; any other tap boards as before.
 *     A hold still boards (the native mount), so a child can always get in;
 *   - while the vehicle moves, every swinging part (door, gate, cabinet, window, hatch, lid, drawer) is CLOSED and a
 *     tap does not open it (`closesWhenMoving`): an open leaf stands outside the hull the move resolver sweeps
 *     (`sweepFootprint` tests the hull's footprint, not the leaf), so it would pass through walls and trees, and a
 *     door left open while a car drives is not what a child expects of a car. Levers and turnables stay as left:
 *     they turn in place inside the hull.
 *
 * A vehicle has no collider blocks (it is one entity): a parked vehicle is entered by its seats, never walked into,
 * so the doorway rules of docs/bedrock-interactivity.md (collider cuts, passage, threshold treads) do not apply to its
 * doors; an open bus door is a visual and a cue, not a passage.
 *
 * A tap reaches the runtime only through the vehicle's hull hit box (clipped to 8 blocks wide, `BOARD`) or a board
 * point, so a board column also stands under every part (and slide) the clipped hit box leaves out at the vehicle's
 * size and turn (`ScriptedVehicleType.tapAt`, `boardPointPlaces`): 41395's interior window at 150 % sat 6 blocks out
 * over the middle of the bus, under no edge column, and a tap on it raised no event.
 *
 * A SCRIPTED vehicle (cars, hover craft, boats, ships: `isScriptedVehicle`) gets them, and a native ROTORCRAFT too: the
 * device flies it, and vehicle-driver.js (playable-addon.ts `vehicleDriverRuntime`) answers a tap on its parts with the
 * same pick and shuts the swinging ones once it moves (its windowed speed or its own step over 2 ticks). Its body's
 * lean is not followed there (a parked rotorcraft is level: its nose-down lean follows ground speed). A component flown
 * as a `flyer` keeps its parts fixed geometry, reported (`TODO(vehicle-interactives)`, interactivity-stage.ts).
 */
import type { ParsedBrick } from './ldraw-parser.js';
import type { Vec3 } from './ldraw-part-geometry.js';
import type { InteractiveKind } from './bedrock-interactives.js';
import { floatActorProperty } from './bedrock-json.js';
import { boneTransforms, cubeCorners, drawnCubeBox, IDENTITY, type Affine, type AnimatedBonePose } from './bedrock-geometry-faces.js';

/** The runtime's constants (serialised into `scripts/vehicles.js`). */
export const VEHICLE_PART = {
  /** Parts one vehicle carries: one actor property each, beside the vehicle's own three (Bedrock allows 32). */
  MAX: 16,
  /** Blocks from the eye to a part's box (padded) for a tap to reach it: the Survival tap reaches ~3 (Saga 30w). */
  REACH_BLOCKS: 2.5,
  /** Degrees off the view a part may be and still be the tapped one, when the view ray itself misses every part. */
  CONE_DEG: 60,
  /** Blocks past the nearest box the view ray enters within which a box whose centre is nearer the ray wins instead. */
  TIE_BLOCKS: 0.25,
  /** Blocks every part box is padded by (a door leaf is a fraction of a block thick). */
  PAD_BLOCKS: 0.15,
  /** Blocks per second (the runtime's `speed`) over which the vehicle is moving: swinging parts close, taps board. */
  CLOSE_SPEED: 0.05,
  /** The leaf's swing (the interactives' `SWING_SECONDS`, bedrock-interactives.ts). */
  SWING_SECONDS: 0.4,
  /**
   * Blocks from the eye along the view ray to a SLIDE's box (times the scale above 100 %) for a tap to ride it. A
   * slide on a vehicle often sits on its roof (41395's foot is 4.5 blocks up the bus), which no child climbs: the
   * device delivers the tap through the hull hit box or a board column within ~3 blocks of the eye, and the runtime
   * then rides the slide the child is LOOKING at, up to this far (the view ray only, never the cone).
   */
  SLIDE_REACH_BLOCKS: 8,
} as const;
export type VehiclePartParams = typeof VEHICLE_PART;

/** The actor property of part `k`. */
export const vehiclePartProperty = (k: number): string => `craftmatic:vpart_${k}`;
/** The hinge chain's bone names of part `k`. */
export const vehiclePartBones = (k: number): { tilt: string; spin: string; untilt: string } => ({ tilt: `vpart${k}_tilt`, spin: `vpart${k}_spin`, untilt: `vpart${k}_untilt` });
/** Whether a bone is one of a vehicle part's chain (the compiler merges and culls each part on its own). */
export const isVehiclePartBone = (bone: string): boolean => /^vpart\d+_(tilt|spin|untilt)$/.test(bone);

/** Swinging parts close while the vehicle moves; a lever or a turnable turns in place and stays as left. */
export const closesWhenMoving = (kind: InteractiveKind): boolean => kind !== 'lever' && kind !== 'turnable';

/** One part as the pipeline found it in the vehicle's placements (the interactivity stage's item). */
export interface VehiclePartSpec {
  kind: InteractiveKind;
  /** Mould id and what it is called ("Door", "Cupboard"). */
  part: string;
  noun: string;
  /** Every placement that moves with it (the part first): the SAME objects as the vehicle component's bricks. */
  bricks: ParsedBrick[];
  /** The hinge line, source LDraw frame. */
  pivotLdu: Vec3;
  axisLdu: Vec3;
  /** Open angle (signed, right-handed about the axis), a turnable's step, or a sliding part's distance (LDU). */
  angleDeg: number;
  slide?: boolean;
}

/** One part as the runtime sees it (blocks at 100 %, the ENTITY frame at yaw 0: +z the nose, `geometryEntityBoxes`). */
export interface VehiclePartRuntime {
  kind: InteractiveKind;
  noun: string;
  /** What one tap sets (a turnable: adds). */
  angle: number;
  closes: boolean;
  /** Its drawn box closed and open: x0, y0, z0, x1, y1, z1. */
  closed: number[];
  open: number[];
}

/**
 * A SLIDE a scripted vehicle carries (the bus's playground slide, 41395's 11267), as the runtime sees it: the ride's
 * index in `scripts/rides.js`, its running line (top to foot, then the run-out: bedrock-rides.ts `slidePathLdu`) and the
 * slide part's box, both in the ENTITY frame at yaw 0 and 100 % (blocks; +z the nose), as a part's boxes are.
 *
 * A building's slide is a ride seat standing at the top of a WORLD path the placement wrote; a vehicle drives away
 * from any such path. So the vehicle's slide is resolved when it is ridden: a tap on the slide of the PARKED vehicle
 * (picked with its parts, `pickVehiclePart` over the slide's box) has the vehicle runtime turn the path to where the
 * vehicle stands now (`vehicleSlideWorldPath`), spawn the pack's ride seat at its top carrying that path and seat the
 * tapper; rides.js then runs it as any slide (its own path runner and set-down through `colliderBodyProbe`) and
 * removes the seat at the foot (`craftmatic:ride_owner`). A tap on it while the vehicle moves is refused, with a line
 * saying why. A slide on a native vehicle (rotorcraft, flyer) stays fixed geometry: no script starts it.
 */
export interface VehicleSlideRuntime {
  /** Its index in rides.js's `rides` (a `slide` entry with `onVehicle`). */
  ride: number;
  /** Its running line, entity frame at 100 % (blocks). */
  path: number[][];
  /** The slide part's box, entity frame at 100 %: x0, y0, z0, x1, y1, z1. */
  box: number[];
}

/** What the vehicle runtime needs to start a slide (the rides' seat type and dynamic property keys, rides.js's own). */
export interface VehicleSlideSeatConfig {
  seatType: string;
  keys: { index: string; path: string; scale: string; owner: string };
}

/** The ride seat's dynamic property naming the vehicle a slide's seat belongs to (rides.js removes such a seat at the foot). */
export const RIDE_OWNER_PROPERTY = 'craftmatic:ride_owner';

/**
 * A point of the compiled vehicle's SOURCE (LDraw, as the pipeline found the slide) in the entity frame at 100 % (blocks):
 * levelled with the model, into the render frame (`A`), less the origin, scaled - then half round, x and z, as the
 * geometry is drawn (`renderSeatToEntity`, `extraPlacement`).
 */
export function sourceToEntityBlocks(t: { A: readonly number[]; origin: readonly number[]; scale: number; level?: { rotation: readonly number[]; centre: readonly number[] } }, p: readonly number[]): number[] {
  let q = [p[0]!, p[1]!, p[2]!];
  if (t.level) {
    const R = t.level.rotation, c = t.level.centre, d = [q[0]! - c[0]!, q[1]! - c[1]!, q[2]! - c[2]!];
    q = [0, 1, 2].map(i => R[i * 3]! * d[0]! + R[i * 3 + 1]! * d[1]! + R[i * 3 + 2]! * d[2]! + c[i]!);
  }
  const A = t.A, r = [0, 1, 2].map(i => A[i * 3]! * q[0]! + A[i * 3 + 1]! * q[1]! + A[i * 3 + 2]! * q[2]!);
  const k = t.scale / 16, r3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;
  return [r3(-(r[0]! - t.origin[0]!) * k), r3((r[1]! - t.origin[1]!) * k), r3(-(r[2]! - t.origin[2]!) * k)];
}

/**
 * A vehicle slide's running line in the WORLD where the vehicle stands (pure; serialised into `scripts/vehicles.js`):
 * every point scaled by the vehicle's live scale `k` and turned by its Bedrock yaw (0 faces +z, +x turns toward +z,
 * as `boardPointPlaces` turns its columns). The body's leftover lean is not followed (# TODO(vehicle-slide-lean): a
 * parked car's 3 degrees move a 3-block chute's top ~0.15 blocks; the seat runs over the drawn bed within that).
 */
export function vehicleSlideWorldPath(path: ReadonlyArray<readonly number[]>, pose: { x: number; y: number; z: number; yaw: number }, k: number): Array<{ x: number; y: number; z: number }> {
  const r = pose.yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return path.map(p => ({ x: pose.x + (p[0]! * c - p[2]! * s) * k, y: pose.y + p[1]! * k, z: pose.z + (p[0]! * s + p[2]! * c) * k }));
}

/** `description.properties` of a vehicle carrying `count` parts (float literals: bedrock-json.ts). */
export function vehiclePartProperties(count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let k = 0; k < count; k++) out[vehiclePartProperty(k)] = floatActorProperty([-40000, 40000], 0);
  return out;
}

/**
 * The drive animation's part channels: each part's spin bone follows `v.vp<k>`, which the client eases toward the
 * property at the part's own rate (the whole swing takes `SWING_SECONDS`), so one property write per tap draws a
 * smooth swing. The sign is the interactives' (`interactiveAnimation`): a positive property is a right-handed turn
 * about the hinge axis. A sliding part moves its spin bone along the axis, `unitsPerLdu` geometry units per LDU.
 */
export function vehiclePartAnimation(parts: ReadonlyArray<{ angle: number; slide?: boolean }>, unitsPerLdu: number): { bones: Record<string, unknown>; initialize: string[]; preAnimation: string[] } {
  const bones: Record<string, unknown> = {}, initialize: string[] = [], preAnimation: string[] = [];
  const r = (v: number): number => Math.round(v * 1e5) / 1e5;
  parts.forEach((p, k) => {
    const v = `v.vp${k}`, prop = `q.property('${vehiclePartProperty(k)}')`;
    const rate = Math.round(Math.max(1, Math.abs(p.angle)) / VEHICLE_PART.SWING_SECONDS * 10) / 10;
    initialize.push(`${v} = ${prop};`);
    preAnimation.push(`${v} = ${v} + math.clamp(${prop} - ${v}, -q.delta_time * ${rate}, q.delta_time * ${rate});`);
    bones[vehiclePartBones(k).spin] = p.slide ? { position: [0, `${v} * ${r(unitsPerLdu)}`, 0] } : { rotation: [0, `-${v}`, 0] };
  });
  return { bones, initialize, preAnimation };
}

/** The pose the client draws part `k`'s spin bone in at value `value` (the channel `vehiclePartAnimation` writes). */
function partPose(value: number, slide: boolean | undefined, unitsPerLdu: number): AnimatedBonePose {
  return slide ? { rotation: [0, 0, 0], position: [0, value * unitsPerLdu, 0], scale: [1, 1, 1] } : { rotation: [0, -value, 0], position: [0, 0, 0], scale: [1, 1, 1] };
}

/**
 * Each part's drawn box in a shipped geometry (`.geo.json` value), closed and open, in blocks at 100 % in the entity
 * frame at yaw 0 (JSON z mirrored, as `geometryEntityBoxes`): every cube under the part's spin bone, read through
 * `drawnCubeBox`, the open one with the spin bone posed as the client draws it open. A part none of whose cubes made
 * it into the geometry is `undefined`.
 */
export function vehiclePartBoxes(geometry: unknown, parts: ReadonlyArray<{ angle: number; slide?: boolean }>, unitsPerLdu: number): Array<{ closed: number[]; open: number[] } | undefined> {
  type Cube = { origin: readonly number[]; size: readonly number[]; inflate?: unknown; rotation?: [number, number, number]; pivot?: [number, number, number] };
  type Bone = { name: string; pivot?: [number, number, number]; rotation?: [number, number, number]; parent?: string; cubes?: Cube[] };
  const meshes = (geometry as { 'minecraft:geometry'?: Array<{ bones?: Bone[] }> } | undefined)?.['minecraft:geometry'] ?? [];
  const acc = parts.map(() => ({ closed: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], open: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], n: 0 }));
  const grow = (b: number[], corners: Vec3[]): void => {
    for (const p of corners) {
      const q = [p[0] / 16, p[1] / 16, p[2] === 0 ? 0 : -p[2] / 16];
      for (let i = 0; i < 3; i++) { if (q[i]! < b[i]!) b[i] = q[i]!; if (q[i]! > b[i + 3]!) b[i + 3] = q[i]!; }
    }
  };
  for (const mesh of meshes) {
    const bones = (mesh.bones ?? []).map(b => ({ name: b.name, pivot: b.pivot ?? [0, 0, 0] as [number, number, number], ...(b.rotation ? { rotation: b.rotation } : {}), ...(b.parent ? { parent: b.parent } : {}) }));
    const parentOf = new Map(bones.map(b => [b.name, b.parent]));
    /** The part whose spin bone a bone hangs under, or -1. */
    const partOf = (name: string): number => {
      for (let b: string | undefined = name, guard = 0; b && guard < 64; b = parentOf.get(b), guard++) {
        const m = /^vpart(\d+)_spin$/.exec(b);
        if (m) return Number(m[1]);
      }
      return -1;
    };
    const rest = boneTransforms(bones);
    const opened = new Map<number, Map<string, Affine>>();
    for (const bone of mesh.bones ?? []) {
      const k = partOf(bone.name);
      if (k < 0 || k >= parts.length || !bone.cubes?.length) continue;
      let open = opened.get(k);
      if (!open) {
        const p = parts[k]!;
        open = boneTransforms(bones, undefined, new Map([[vehiclePartBones(k).spin, partPose(p.angle, p.slide, unitsPerLdu)]]));
        opened.set(k, open);
      }
      for (const cube of bone.cubes) {
        const d = drawnCubeBox(cube);
        const c = { bone: bone.name, origin: d.origin, size: d.size, ...(cube.rotation && cube.pivot ? { rotation: cube.rotation, pivot: cube.pivot } : {}) };
        grow(acc[k]!.closed, cubeCorners(c, rest.get(bone.name) ?? IDENTITY));
        grow(acc[k]!.open, cubeCorners(c, open.get(bone.name) ?? IDENTITY));
        acc[k]!.n++;
      }
    }
  }
  const r3 = (v: number): number => Math.round(v * 1000) / 1000;
  return acc.map(a => (a.n ? { closed: a.closed.map(r3), open: a.open.map(r3) } : undefined));
}

/**
 * The `body` bone's pivot of a shipped geometry (`.geo.json` value) in the entity frame at 100 % (blocks, JSON z
 * mirrored): where the drive animation's lean turns the body, for `pickVehiclePart`'s `pose.pivot`. Undefined: no body.
 */
export function bodyPivotOf(geometry: unknown): number[] | undefined {
  const meshes = (geometry as { 'minecraft:geometry'?: Array<{ bones?: Array<{ name: string; pivot?: readonly number[] }> }> } | undefined)?.['minecraft:geometry'] ?? [];
  for (const mesh of meshes) for (const bone of mesh.bones ?? []) {
    if (bone.name !== 'body') continue;
    const p = bone.pivot ?? [0, 0, 0];
    const r3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;
    return [r3((p[0] ?? 0) / 16), r3((p[1] ?? 0) / 16), r3(-(p[2] ?? 0) / 16)];
  }
  return undefined;
}

/**
 * What a tap on a vehicle meant (pure; serialised into `scripts/vehicles.js`, `pick` is `pickVehiclePart`): a part the
 * view RAY enters within reach first; else a slide the view ray enters within `SLIDE_REACH_BLOCKS` (a roof slide is
 * looked up at from the ground); else a part by the view cone (`pickVehiclePart`'s last rule). `moving`: slides only
 * (a part neither opens nor shuts while the vehicle moves; a slide is answered so the runtime can refuse it).
 * Null: nothing meant (the tap boards).
 */
export function pickVehicleTap(pick: typeof pickVehiclePart, parts: ReadonlyArray<{ closed: readonly number[]; open: readonly number[] }>, slides: ReadonlyArray<{ box: readonly number[] }>, pose: { x: number; y: number; z: number; yaw: number; pitch?: number; bank?: number; pivot?: readonly number[] }, k: number, eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, open: readonly boolean[], moving: boolean, P: { REACH_BLOCKS: number; CONE_DEG: number; PAD_BLOCKS: number; TIE_BLOCKS: number; SLIDE_REACH_BLOCKS: number }): { part: number } | { slide: number } | null {
  if (!moving && parts.length) {
    const ray = pick(parts, pose, k, eye, dir, open, { ...P, CONE_DEG: 0 });
    if (ray >= 0) return { part: ray };
  }
  if (slides.length) {
    const boxes = slides.map(sl => ({ closed: sl.box, open: sl.box }));
    const i = pick(boxes, pose, k, eye, dir, boxes.map(() => false), { ...P, REACH_BLOCKS: P.SLIDE_REACH_BLOCKS, CONE_DEG: 0 });
    if (i >= 0) return { slide: i };
  }
  if (!moving && parts.length) {
    const cone = pick(parts, pose, k, eye, dir, open, P);
    if (cone >= 0) return { part: cone };
  }
  return null;
}

/**
 * Which part a tap on a parked vehicle meant, or -1 (board instead). Pure and self-contained: serialised into
 * `scripts/vehicles.js`. `pose` is the vehicle's (Bedrock yaw: 0 faces +z, +x turns toward +z), `k` its live scale,
 * `eye` and `dir` the player's head and view (world), `open[i]` whether part i is open now (the box over its open and
 * closed boxes is tested).
 *
 * A part is a candidate when its padded box is within `REACH_BLOCKS` (times the scale, above 100 %) of the eye. The
 * view ray through a candidate's own box wins (nearest first), then through its padded box; failing both, the candidate nearest the view direction within `CONE_DEG`. The cone is there
 * because a touch tap picks what is under the FINGER, which the server never sees: it reports only the view
 * (`getViewDirection`), so a door tapped at the screen's edge is off the view ray but well inside the cone.
 * # TODO(vehicle-parts-touch-aim): unmeasured on a phone - whether a touch tap's view direction is the camera's
 * centre or the finger's ray; the cone covers the screen's half-width either way.
 */
export function pickVehiclePart(parts: ReadonlyArray<{ closed: readonly number[]; open: readonly number[] }>, pose: { x: number; y: number; z: number; yaw: number; pitch?: number; bank?: number; pivot?: readonly number[] }, k: number, eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, open: readonly boolean[], P: { REACH_BLOCKS: number; CONE_DEG: number; PAD_BLOCKS: number; TIE_BLOCKS: number }): number {
  const r = pose.yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  // World -> entity frame (the inverse of the yaw turn `boardPointPlaces` applies), in world blocks (scaled boxes).
  const dx = eye.x - pose.x, dz = eye.z - pose.z;
  let e = [dx * c + dz * s, eye.y - pose.y, -dx * s + dz * c];
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  let d = [(dir.x * c + dir.z * s) / dl, dir.y / dl, (-dir.x * s + dir.z * c) / dl];
  // The body's lean (a parked car keeps its last squat; `FLIGHT_PROPS` pitch and bank, degrees): the drive animation
  // turns the `body` bone by [-pitch, 0, -bank] about its pivot, which the geometry JSON draws as Rz(bank)·Rx(pitch)
  // (`pivotRotation`) in its own frame, the entity frame mirrored in z. The boxes are the LEVEL body's, so the eye and
  // the view are turned back by the inverse, Rx(-pitch)·Rz(-bank), in that JSON frame.
  const pa = (pose.pitch ?? 0) * Math.PI / 180, ba = (pose.bank ?? 0) * Math.PI / 180;
  if (pa || ba) {
    const ca = Math.cos(pa), sa = Math.sin(pa), cb = Math.cos(ba), sb = Math.sin(ba);
    const unlean = (v: number[]): number[] => {
      // Entity -> JSON (z mirrored); Rz(-bank) then Rx(-pitch); back.
      const x0 = v[0]!, y0 = v[1]!, z0 = -v[2]!;
      const x1 = x0 * cb + y0 * sb, y1 = -x0 * sb + y0 * cb;
      const y2 = y1 * ca + z0 * sa, z2 = -y1 * sa + z0 * ca;
      return [x1, y2, -z2];
    };
    const pv = [0, 1, 2].map(a => (pose.pivot?.[a] ?? 0) * k);
    const rel = unlean([e[0]! - pv[0]!, e[1]! - pv[1]!, e[2]! - pv[2]!]);
    e = [rel[0]! + pv[0]!, rel[1]! + pv[1]!, rel[2]! + pv[2]!];
    d = unlean(d);
  }
  const cosCone = Math.cos(P.CONE_DEG * Math.PI / 180);
  // The vehicle's size scales its parts' spacing: the reach grows with it (a 400 % bus's door is 4x as far across);
  // the pad never outgrows a small part (a 50 % lever is a tenth of a block).
  const reach = P.REACH_BLOCKS * Math.max(1, k), pad = P.PAD_BLOCKS * Math.min(1, k);
  /** The view ray's entry distance into a box, within reach, or Infinity (slab test). */
  const rayIn = (lo: number[], hi: number[]): number => {
    let t0 = 0, t1 = reach + pad;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]!) < 1e-9) { if (e[a]! < lo[a]! || e[a]! > hi[a]!) return Infinity; continue; }
      let ta = (lo[a]! - e[a]!) / d[a]!, tb = (hi[a]! - e[a]!) / d[a]!;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return Infinity;
    }
    return t0;
  };
  // Ranked: the view ray through a part's own box (nearest first), then through its padded box, then the cone.
  let bestPadded = -1, paddedT = Infinity, bestCone = -1, bestCos = -Infinity;
  /** Every part whose own box the view ray enters: where, and how far its centre is off the ray. */
  const exacts: Array<{ i: number; t: number; off: number }> = [];
  for (let i = 0; i < parts.length; i++) {
    // An open part answers where it is AND where it was (the box over both: a leaf sweeps between them), so a window
    // opened from below can be closed from the same spot though it swung out of reach.
    const c0 = parts[i]!.closed, o0 = parts[i]!.open;
    // A part none of whose cubes reached the geometry has no box: never picked.
    if (c0.length < 6) continue;
    const b = open[i] && o0.length >= 6 ? [0, 1, 2, 3, 4, 5].map(a => (a < 3 ? Math.min(c0[a]!, o0[a]!) : Math.max(c0[a]!, o0[a]!))) : c0;
    const lo0 = [b[0]! * k, b[1]! * k, b[2]! * k], hi0 = [b[3]! * k, b[4]! * k, b[5]! * k];
    const lo = lo0.map(v => v - pad), hi = hi0.map(v => v + pad);
    // The padded box's point nearest the eye: within reach, or not a candidate.
    const q = [0, 1, 2].map(a => Math.max(lo[a]!, Math.min(hi[a]!, e[a]!)));
    if (Math.hypot(q[0]! - e[0]!, q[1]! - e[1]!, q[2]! - e[2]!) > reach) continue;
    const exact = rayIn(lo0, hi0);
    if (exact < Infinity) {
      const cx = (lo0[0]! + hi0[0]!) / 2 - e[0]!, cy = (lo0[1]! + hi0[1]!) / 2 - e[1]!, cz = (lo0[2]! + hi0[2]!) / 2 - e[2]!;
      const along = cx * d[0]! + cy * d[1]! + cz * d[2]!;
      exacts.push({ i, t: exact, off: Math.hypot(cx - along * d[0]!, cy - along * d[1]!, cz - along * d[2]!) });
    }
    const padded = rayIn(lo, hi);
    if (padded < paddedT) { paddedT = padded; bestPadded = i; }
    if (padded < Infinity) continue;
    // Off the ray: how near the view points at the box's centre.
    const m = [(lo[0]! + hi[0]!) / 2 - e[0]!, (lo[1]! + hi[1]!) / 2 - e[1]!, (lo[2]! + hi[2]!) / 2 - e[2]!];
    const ml = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    const cos = (m[0]! * d[0]! + m[1]! * d[1]! + m[2]! * d[2]!) / ml;
    if (cos >= cosCone && cos > bestCos) { bestCos = cos; bestCone = i; }
  }
  // The nearest box the ray enters, unless another it enters within `TIE_BLOCKS` of it has its centre nearer the ray:
  // overlapping boxes (two stacked drawers' corner boxes, a door before its frame's cupboard) go to the one aimed at.
  if (exacts.length) {
    const first = Math.min(...exacts.map(x => x.t)), band = P.TIE_BLOCKS * Math.max(1, k);
    let best = exacts[0]!;
    for (const x of exacts) if (x.t <= first + band && (best.t > first + band || x.off < best.off)) best = x;
    return best.i;
  }
  return bestPadded >= 0 ? bestPadded : bestCone;
}
