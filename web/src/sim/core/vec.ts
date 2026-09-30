/**
 * The engine's vector and box vocabulary: plain objects, world blocks, Y up.
 *
 * Minecraft's frame: +X east, +Y up, +Z south; one block is one metre; yaw 0
 * faces +Z and +yaw turns right (yaw 90 faces -X); +pitch looks down. Every
 * module of the simulator uses this frame and these helpers, so a frame
 * mistake can only be made once.
 */

/** A point or direction in world blocks. */
export interface Vec3 { x: number; y: number; z: number }

/** An axis-aligned box in world blocks (`x0 <= x1` etc.). */
export interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** Degrees to radians. */
export const DEG = Math.PI / 180;

/** `a + b`. */
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
/** `a - b`. */
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
/** `a * k`. */
export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
/** Euclidean length. */
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
/** Distance between two points. */
export const distance = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
/** A copy of a point (the API hands out copies, never its own state). */
export const copy = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });

/**
 * Minecraft's view direction for a yaw and pitch (degrees): yaw 0 looks +Z,
 * yaw 90 looks -X, pitch +90 looks straight down.
 */
export function viewDirection(yawDeg: number, pitchDeg: number): Vec3 {
  const y = yawDeg * DEG, p = pitchDeg * DEG;
  return { x: -Math.sin(y) * Math.cos(p), y: -Math.sin(p), z: Math.cos(y) * Math.cos(p) };
}

/** The yaw and pitch (degrees) that look along a direction. */
export function lookAngles(d: Vec3): { yaw: number; pitch: number } {
  const h = Math.hypot(d.x, d.z);
  return { yaw: Math.atan2(-d.x, d.z) / DEG, pitch: Math.atan2(-d.y, h) / DEG };
}

/**
 * An entity-frame offset (x left, y up, z forward = the nose) turned by the
 * entity's yaw into world axes. This is how a `minecraft:rideable` seat
 * position lands in the world (its +Z is the entity's nose, CLAUDE.md).
 */
export function rotateYaw(offset: Vec3, yawDeg: number): Vec3 {
  const a = yawDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  return { x: offset.x * c - offset.z * s, y: offset.y, z: offset.x * s + offset.z * c };
}

/** A box of `width` x `height` standing on the point `feet` (its bottom centre). */
export function boxAt(feet: Vec3, width: number, height: number): Box {
  const h = width / 2;
  return { x0: feet.x - h, y0: feet.y, z0: feet.z - h, x1: feet.x + h, y1: feet.y + height, z1: feet.z + h };
}

/** Whether two boxes overlap with more than `eps` in every axis. */
export function boxesOverlap(a: Box, b: Box, eps = 1e-7): boolean {
  return a.x1 > b.x0 + eps && a.x0 < b.x1 - eps && a.y1 > b.y0 + eps && a.y0 < b.y1 - eps && a.z1 > b.z0 + eps && a.z0 < b.z1 - eps;
}

/**
 * The entry distance of a ray into a box (slab test), or `undefined` when the
 * ray misses it within `maxDistance`. A ray that starts inside the box enters
 * at 0.
 */
export function rayBox(origin: Vec3, dir: Vec3, b: Box, maxDistance = Infinity): number | undefined {
  let t0 = 0, t1 = maxDistance;
  const axes: Array<[number, number, number, number]> = [[origin.x, dir.x, b.x0, b.x1], [origin.y, dir.y, b.y0, b.y1], [origin.z, dir.z, b.z0, b.z1]];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return undefined; continue; }
    let a = (lo - o) / d, c = (hi - o) / d;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return undefined;
  }
  return t0;
}
