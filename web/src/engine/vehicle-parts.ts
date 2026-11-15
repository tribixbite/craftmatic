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
 * Only a SCRIPTED vehicle (cars, hover craft, boats, ships: `isScriptedVehicle`) gets them: a native rotorcraft or
 * flyer has no script to answer the tap; its parts stay fixed geometry and are reported.
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
  /** Blocks every part box is padded by (a door leaf is a fraction of a block thick). */
  PAD_BLOCKS: 0.15,
  /** Blocks per second (the runtime's `speed`) over which the vehicle is moving: swinging parts close, taps board. */
  CLOSE_SPEED: 0.05,
  /** The leaf's swing (the interactives' `SWING_SECONDS`, bedrock-interactives.ts). */
  SWING_SECONDS: 0.4,
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
 * Which part a tap on a parked vehicle meant, or -1 (board instead). Pure and self-contained: serialised into
 * `scripts/vehicles.js`. `pose` is the vehicle's (Bedrock yaw: 0 faces +z, +x turns toward +z), `k` its live scale,
 * `eye` and `dir` the player's head and view (world), `open[i]` whether part i is open now (its open box is tested).
 *
 * A part is a candidate when its padded box is within `REACH_BLOCKS` (times the scale, above 100 %) of the eye. The
 * view ray through a candidate's own box wins (nearest first), then through its padded box; failing both, the candidate nearest the view direction within `CONE_DEG`. The cone is there
 * because a touch tap picks what is under the FINGER, which the server never sees: it reports only the view
 * (`getViewDirection`), so a door tapped at the screen's edge is off the view ray but well inside the cone.
 * # TODO(vehicle-parts-touch-aim): unmeasured on a phone - whether a touch tap's view direction is the camera's
 * centre or the finger's ray; the cone covers the screen's half-width either way.
 */
export function pickVehiclePart(parts: ReadonlyArray<{ closed: readonly number[]; open: readonly number[] }>, pose: { x: number; y: number; z: number; yaw: number }, k: number, eye: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, open: readonly boolean[], P: { REACH_BLOCKS: number; CONE_DEG: number; PAD_BLOCKS: number }): number {
  const r = pose.yaw * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  // World -> entity frame (the inverse of the yaw turn `boardPointPlaces` applies), in world blocks (scaled boxes).
  const dx = eye.x - pose.x, dz = eye.z - pose.z;
  const e = [dx * c + dz * s, eye.y - pose.y, -dx * s + dz * c];
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const d = [(dir.x * c + dir.z * s) / dl, dir.y / dl, (-dir.x * s + dir.z * c) / dl];
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
  let bestExact = -1, exactT = Infinity, bestPadded = -1, paddedT = Infinity, bestCone = -1, bestCos = -Infinity;
  for (let i = 0; i < parts.length; i++) {
    const b = open[i] ? parts[i]!.open : parts[i]!.closed;
    // A part none of whose cubes reached the geometry has no box: never picked.
    if (b.length < 6) continue;
    const lo0 = [b[0]! * k, b[1]! * k, b[2]! * k], hi0 = [b[3]! * k, b[4]! * k, b[5]! * k];
    const lo = lo0.map(v => v - pad), hi = hi0.map(v => v + pad);
    // The padded box's point nearest the eye: within reach, or not a candidate.
    const q = [0, 1, 2].map(a => Math.max(lo[a]!, Math.min(hi[a]!, e[a]!)));
    if (Math.hypot(q[0]! - e[0]!, q[1]! - e[1]!, q[2]! - e[2]!) > reach) continue;
    const exact = rayIn(lo0, hi0);
    if (exact < exactT) { exactT = exact; bestExact = i; }
    const padded = rayIn(lo, hi);
    if (padded < paddedT) { paddedT = padded; bestPadded = i; }
    if (padded < Infinity) continue;
    // Off the ray: how near the view points at the box's centre.
    const m = [(lo[0]! + hi[0]!) / 2 - e[0]!, (lo[1]! + hi[1]!) / 2 - e[1]!, (lo[2]! + hi[2]!) / 2 - e[2]!];
    const ml = Math.hypot(m[0]!, m[1]!, m[2]!) || 1;
    const cos = (m[0]! * d[0]! + m[1]! * d[1]! + m[2]! * d[2]!) / ml;
    if (cos >= cosCone && cos > bestCos) { bestCos = cos; bestCone = i; }
  }
  return bestExact >= 0 ? bestExact : bestPadded >= 0 ? bestPadded : bestCone;
}
