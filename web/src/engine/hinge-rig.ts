/**
 * The hinge chain every moving LEGO part turns on, whichever entity carries it: an interactive's own entity
 * (bedrock-interactives.ts `interactiveRig`) or a vehicle that carries its doors, lids and cupboards in its own
 * geometry (vehicle-parts.ts, audit A-02). Pure and dependency-free so the entity compiler can build it without
 * importing either runtime module.
 *
 * The chain is tilt -> spin -> un-tilt about the hinge's pivot: `tilt` turns LDraw up (-Y) onto the hinge axis, the
 * spin bone is animated about its own Y, and `untilt` is the inverse of `tilt`. At zero spin the three cancel and the
 * part is exactly where the model put it; any spin turns it about the axis through the pivot. A positive spin is a
 * right-handed turn about the axis in the LDraw frame (the pinball flipper's convention, proven on the Pixel
 * 2026-09-24; the render frame is a proper rotation of it).
 */
import type { Vec3 } from './ldraw-part-geometry.js';
import type { RigBone } from './minifig-rig.js';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** A rotation (row-major) taking unit `a` onto unit `b` (Rodrigues; a half turn when they are opposite). */
export function rotationBetween(a: Vec3, b: Vec3): number[] {
  const v = cross(a, b), c = dot(a, b);
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -1 + 1e-12) {
    // Opposite: a half turn about any axis perpendicular to `a`.
    const p = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 0, 1]));
    return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2], 2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2], 2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1];
  }
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1],
    v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0],
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c,
  ];
}

/** The transpose (= inverse) of a row-major 3 x 3 rotation. */
export const transpose3 = (m: readonly number[]): number[] => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];

/** The three bone names of one hinge chain. */
export interface HingeChainNames { tilt: string; spin: string; untilt: string }

/**
 * The three bones of a hinge on the line through `pivotLdu` along unit `axisLdu` (LDraw), hung under `parent`
 * (none: a root). The part's placements belong to `names.untilt`; an animation turns `names.spin` about its Y.
 */
export function hingeChain(names: HingeChainNames, pivotLdu: Vec3, axisLdu: Vec3, parent?: string): RigBone[] {
  const tilt = rotationBetween([0, -1, 0], norm(axisLdu)); // LDraw up is -Y
  return [
    { name: names.tilt, ...(parent ? { parent } : {}), pivotLdu, rotation: tilt },
    { name: names.spin, parent: names.tilt, pivotLdu },
    { name: names.untilt, parent: names.spin, pivotLdu, rotation: transpose3(tilt) },
  ];
}
