/**
 * What an entity DRAWS, in the world: its pack geometry (the resource pack's
 * geo, client entity and render controllers, read by `appearance.ts`) placed
 * at the engine entity's position, yaw and `minecraft:scale`, through the ONE
 * rotation convention and Z mirror of `bedrock-geometry-faces.ts`. The rider
 * view checks (is the eye inside the bodywork? does the car carry the rider?)
 * and the snapshots read it.
 */

import { boneTransforms, cubeCorners, mul, IDENTITY, type Affine } from '../../../engine/bedrock-geometry-faces.js';
import { APPEARANCE_FILE_PATTERN, buildAddonAppearance, type AddonAppearance, type AddonAppearanceEntry } from './appearance.js';
import { resourcePacks, type Addon } from '../../pack/pack.js';
import type { Box, Vec3 } from '../../core/vec.js';
import { rayBox } from '../../core/vec.js';
import type { SimEntity } from '../../entity/entity.js';
import { AHEAD, SIDES, VIEW, driverSeesOut, sideFan } from '../../../engine/cockpit-seat.js';
import { clipParallelepiped, isAxisAligned, parallelepipedFromCorners, type Parallelepiped } from '../../../engine/oriented-box.js';

/** Read an add-on's appearance (every entity type's drawn geometry). */
export function packAppearance(addon: Addon): AddonAppearance {
  const sources = new Map<string, string>();
  const dec = new TextDecoder();
  for (const rp of resourcePacks(addon)) for (const [path, data] of rp.files) if (APPEARANCE_FILE_PATTERN.test(path)) sources.set(path, dec.decode(data));
  return buildAddonAppearance(sources);
}

/**
 * A drawn cube's world box (blocks) and whether it is see-through (glass). A TURNED cube (a rotated bone or
 * cube) also carries `solid`, the cube itself: its corner box holds air beside it (a baseplate turned 45
 * degrees is a diamond in a square), so a test of what the model draws reads `drawnReaches`, not `box`.
 */
export interface DrawnBox { box: Box; glass: boolean; solid?: Parallelepiped }

/** Whether a drawn cube reaches into a box by more than `eps` on every axis: its corner box, then the cube itself when turned. */
export function drawnReaches(d: DrawnBox, q: Box, eps = 0): boolean {
  const b = d.box;
  if (!(b.x1 > q.x0 + eps && b.x0 < q.x1 - eps && b.y1 > q.y0 + eps && b.y0 < q.y1 - eps && b.z1 > q.z0 + eps && b.z0 < q.z1 - eps)) return false;
  if (!d.solid) return true;
  const c = clipParallelepiped(d.solid, [q.x0, q.y0, q.z0], [q.x1, q.y1, q.z1]);
  return !!c && c.max[0] - c.min[0] > eps && c.max[1] - c.min[1] > eps && c.max[2] - c.min[2] > eps;
}

/**
 * The highest point a drawn cube reaches over a footprint (x0..x1, z0..z1), or undefined when it is not over
 * it: the corner box's top for an aligned cube, the cube's own top inside the footprint for a turned one.
 */
export function drawnTopOver(d: DrawnBox, x0: number, x1: number, z0: number, z1: number): number | undefined {
  const b = d.box;
  if (!(b.x1 > x0 && b.x0 < x1 && b.z1 > z0 && b.z0 < z1)) return undefined;
  if (!d.solid) return b.y1;
  const c = clipParallelepiped(d.solid, [x0, b.y0, z0], [x1, b.y1, z1]);
  return c && c.max[0] > c.min[0] && c.max[2] > c.min[2] ? c.max[1] : undefined;
}

/** The world boxes of an entity's near geometry at its pose (a turned cube is its corners' box). */
export function drawnBoxes(entry: AddonAppearanceEntry, at: Vec3, yawDeg: number, scale = 1): DrawnBox[] {
  const bones = boneTransforms(entry.bones);
  // `yawDeg` is Bedrock's (yaw 90 faces -X). The placement matrix below is `worldFaces`' (three.js `rotation.y`
  // by the negated yaw, as `worldFaces` itself negates since 2026-09-30). Measured: at a 90-degree placement of
  // 11371 the un-negated turn put 2 % of the collider boxes near drawn geometry, the negated one as many as at 0.
  const y = -yawDeg * Math.PI / 180, cy = Math.cos(y), sy = Math.sin(y);
  // Geometry JSON → world: Z mirrored, then the yaw about +Y, then the scale and the placement (units of 1/16 block).
  const place: Affine = [cy * scale, 0, -sy * scale, at.x * 16, 0, scale, 0, at.y * 16, -sy * scale, 0, -cy * scale, at.z * 16];
  const out: DrawnBox[] = [];
  for (const g of entry.groups) {
    if (g.far) continue;
    for (const c of g.cubes) {
      const k = cubeCorners(c, mul(place, bones.get(c.bone) ?? IDENTITY));
      const xs = k.map(p => p[0] / 16), ys = k.map(p => p[1] / 16), zs = k.map(p => p[2] / 16);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), z0: Math.min(...zs), x1: Math.max(...xs), y1: Math.max(...ys), z1: Math.max(...zs) };
      const solid = parallelepipedFromCorners(k.map(p => [p[0] / 16, p[1] / 16, p[2] / 16]));
      out.push(solid && !isAxisAligned(solid) ? { box, glass: g.alpha < 1, solid } : { box, glass: g.alpha < 1 });
    }
  }
  return out;
}

/** An engine entity's drawn boxes (undefined when the pack draws nothing for its type). */
export function entityDrawn(appearance: AddonAppearance, e: SimEntity): DrawnBox[] | undefined {
  const entry = appearance.byType.get(e.typeId);
  return entry ? drawnBoxes(entry, e.location, e.rotation.y, e.scale()) : undefined;
}

/**
 * The share of forward view rays from `eye` that leave `boxes` without
 * meeting an opaque one - the cockpit tests of cockpit-seat.ts (`fanView`
 * with `AHEAD`, the rule every seat is placed by; `forwardView`'s wider `VIEW`
 * fan), in the world frame, looking along `yawDeg`. 1 = every ray clear.
 */
export function forwardViewWorld(boxes: readonly DrawnBox[], eye: Vec3, yawDeg: number, fan: { yaw: readonly number[]; pitch: readonly number[] }, maxDistance = 16): { clear: number; total: number } {
  const opaque = boxes.filter(b => !b.glass).map(b => b.box);
  let clear = 0, total = 0;
  for (const yd of fan.yaw) for (const pd of fan.pitch) {
    total++;
    const yy = (yawDeg + yd) * Math.PI / 180, p = pd * Math.PI / 180;
    // Bedrock yaw: 0 looks +Z, +90 looks -X; +pitch in the fan looks UP here (cockpit-seat's convention).
    const d = { x: -Math.sin(yy) * Math.cos(p), y: Math.sin(p), z: Math.cos(yy) * Math.cos(p) };
    if (!opaque.some(b => rayBox(eye, d, b, maxDistance) !== undefined)) clear++;
  }
  return { clear, total };
}

/** A driver's view over the drawn geometry: rays clear / cast per fan of cockpit-seat.ts. */
export interface DriverViewWorld {
  /** The horizon ahead (`AHEAD`). */
  ahead: { clear: number; total: number };
  /** Each side (`SIDES`): left and right as the driver sees them. */
  left: { clear: number; total: number };
  right: { clear: number; total: number };
  /** The wider forward fan (`VIEW`), reported, never judged. */
  view: { clear: number; total: number };
  /** `driverSeesOut` over these shares: the compiler's own judgement of a seat. */
  seesOut: boolean;
}

/**
 * The driver's view from `eye` looking along `yawDeg`, judged by the SAME rule
 * every compiled seat is placed by (`driverSeesOut`, cockpit-seat.ts): the
 * simulator's `driver-sees-ahead` invariant and `_cockpit_view.ts` read it.
 * A +yaw offset looks to the driver's right in both frames (Bedrock: facing
 * +Z, +yaw turns toward -X), so `sideFan(1)` is the right here as there.
 */
export function driverViewWorld(boxes: readonly DrawnBox[], eye: Vec3, yawDeg: number): DriverViewWorld {
  const ahead = forwardViewWorld(boxes, eye, yawDeg, AHEAD), left = forwardViewWorld(boxes, eye, yawDeg, sideFan(-1), SIDES.near), right = forwardViewWorld(boxes, eye, yawDeg, sideFan(1), SIDES.near);
  const share = (r: { clear: number; total: number }): number => r.total ? r.clear / r.total : 1;
  return { ahead, left, right, view: forwardViewWorld(boxes, eye, yawDeg, VIEW), seesOut: driverSeesOut(share(ahead), { left: share(left), right: share(right) }) };
}
