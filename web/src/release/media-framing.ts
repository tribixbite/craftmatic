/**
 * Shared framing for the offline pack renderers (`scripts/_pack_render.ts`, QA, and
 * `scripts/media-turntable.ts`, store and gallery media): which actors a wand size places, their bounds,
 * where the camera goes round them, and how far back it must stand for the model to fill a share of the frame.
 *
 * Extracted in place from `_pack_render.ts` (BIZ-62 / X-14): that script now imports these, so there is ONE
 * copy of the maths and the QA renders and the marketing renders cannot drift apart.
 *
 * Frame: world blocks, Y up, exactly the frame `worldFaces` (bedrock-geometry-faces.ts) writes and the
 * simulator first-person snapshots use. THIS FRAME IS THE GAME FRAME, NOT A MIRROR IMAGE: `worldFaces` turns the
 * JSON by Z-mirror plus yaw (a proper rotation of the compiler render frame), and the rasteriser camera is
 * right-handed (`right = forward x up`, so looking north +X is on the right, as in Minecraft). Settled by
 * `test/release-media.test.ts` against Bedrock's entity convention (JSON +X is the entity's left). Mirroring
 * JSON X, as the first reading of the plan said, draws the marker on the WRONG side; do not add it.
 */
import { lodFaces } from '../sim/adapters/craftmatic/snapshot.js';
import { entityRenderCullBlocks } from '../engine/bedrock-lod-hull.js';
import { entityCollisionFromSources, entitySpawnsAt, placedPoint, type AddonPreviewFiles, type AddonPreviewModel } from '../ui/addon-preview-data.js';
import type { AuditActor, Vec3 } from '../engine/bedrock-geometry-faces.js';

/** An actor placed at the wand size with its realised cull distance. */
export interface PlacedActor { actor: AuditActor; cull: number }

/** Which actors to place: the `--kinds` and `--type` filters of `_pack_render.ts`. */
export interface ActorFilter { kinds?: readonly string[]; typeFilter?: string }

/**
 * Every actor the wand spawns at `sizePct`: its appearance, point, yaw, scale and realised cull.
 * The realised collision box is the declared 100 % box times the size (quirk `collision-box-scales-with-entity`).
 */
export function placeActors(model: AddonPreviewModel, files: Pick<AddonPreviewFiles, 'appearanceSources'>, sizePct: number, filter: ActorFilter = {}): PlacedActor[] {
  if (!model.appearance) throw new Error('pack has no appearance');
  const scale = sizePct / 100;
  const boxes = entityCollisionFromSources(files.appearanceSources ?? new Map());
  const out: PlacedActor[] = [];
  for (const e of model.entities) {
    if (!entitySpawnsAt(e, sizePct)) continue;
    if (filter.kinds && !filter.kinds.includes(e.kind)) continue;
    if (filter.typeFilter && !new RegExp(filter.typeFilter).test(e.typeId)) continue;
    const entry = model.appearance.byType.get(e.typeId);
    if (!entry) continue;
    const box = boxes.get(e.typeId);
    out.push({ actor: { typeId: e.typeId, kind: e.kind, entry, at: placedPoint(e, model.dims, sizePct, 0), yawDeg: e.yaw, scale }, cull: entityRenderCullBlocks(box ? { width: box.width * scale, height: box.height * scale } : undefined) });
  }
  return out;
}

/** Axis-aligned bounds in blocks. */
export interface Bounds { lo: Vec3; hi: Vec3 }

/** The drawn corners of `actors` in blocks (1/16 units divided down), each distinct corner once, for bounds and fitting. */
export function drawnPoints(actors: readonly AuditActor[]): Vec3[] {
  const { faces } = lodFaces(actors as AuditActor[], []);
  const seen = new Set<string>();
  const out: Vec3[] = [];
  for (const f of faces) for (const c of f.corners) {
    // 1/16-block corners repeat across the six faces of a cube: keep each once.
    const key = `${Math.round(c[0] * 16)},${Math.round(c[1] * 16)},${Math.round(c[2] * 16)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([c[0] / 16, c[1] / 16, c[2] / 16]);
  }
  return out;
}

/** The actors' bounds from their drawn faces, optionally narrowed to the typeIds matching `filter`. */
export function boundsOfActors(placed: readonly PlacedActor[], filter?: string): Bounds {
  const own = placed.filter(p => !filter || new RegExp(filter).test(p.actor.typeId));
  if (!own.length) throw new Error(`no actor matching ${filter}`);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const { faces } = lodFaces(own.map(p => p.actor), []);
  for (const f of faces) for (const c of f.corners) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, c[i]! / 16); hi[i] = Math.max(hi[i]!, c[i]! / 16); }
  return { lo, hi };
}

/** The bounds of a point cloud. */
export function boundsOfPoints(points: readonly Vec3[]): Bounds {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, p[i]!); hi[i] = Math.max(hi[i]!, p[i]!); }
  return { lo, hi };
}

/** The centre of a box. */
export const centreOf = (b: Bounds): Vec3 => [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];

/** Half the bounds' diagonal, at least half a block: the radius of a sphere that holds the model. */
export const boundingRadius = (b: Bounds): number => Math.max(0.5, Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2);

/** The distance at which a sphere of radius `r` just fits a vertical field of view `fovRad`, with the QA renders' 10 % margin. */
export const sphereFitDistance = (r: number, fovRad: number): number => r / Math.sin(fovRad / 2) * 1.1;

/** Where a `--dir` view looks from: the azimuth of the look direction and the elevation (radians, positive = looking down). */
export function viewAngles(dir: Vec3): { azimuth: number; elevation: number } {
  return { azimuth: Math.atan2(dir[2], dir[0]), elevation: Math.atan2(-dir[1], Math.hypot(dir[0], dir[2])) };
}

/** The eye of view `index` of `count` equal azimuths round `at`, `distance` away, at the `--dir` elevation. */
export function orbitEye(at: Vec3, dir: Vec3, index: number, count: number, distance: number): Vec3 {
  const { azimuth, elevation } = viewAngles(dir);
  const az = azimuth + index / count * 2 * Math.PI;
  return [at[0] - Math.cos(az) * Math.cos(elevation) * distance, at[1] + Math.sin(elevation) * distance, at[2] - Math.sin(az) * Math.cos(elevation) * distance];
}

/** The eye of a single `--frame` picture: `distance` back from `at` along the normalised look direction `dir`. */
export function lookEye(at: Vec3, dir: Vec3, distance: number): Vec3 {
  const l = Math.hypot(...dir);
  return [at[0] - dir[0] / l * distance, at[1] - dir[1] / l * distance, at[2] - dir[2] / l * distance];
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The camera axes, as the rasteriser derives them (web/src/sim/render/rasterizer.ts): forward, right = forward x up, up. */
export interface CameraBasis { fwd: Vec3; right: Vec3; up: Vec3 }
export function cameraBasis(eye: Vec3, at: Vec3): CameraBasis {
  const fwd = unit([at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]);
  let right = unit(cross(fwd, [0, 1, 0]));
  if (Math.hypot(...cross(fwd, [0, 1, 0])) < 1e-9) right = unit(cross(fwd, [1, 0, 0]));
  return { fwd, right, up: cross(right, fwd) };
}

/** A world point in normalised device coordinates (-1..1 each way, x right, y up) for the rasteriser camera, or null behind it. */
export function projectNdc(p: Vec3, eye: Vec3, basis: CameraBasis, fovDeg: number, aspect: number): [number, number] | null {
  const r: Vec3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const dotv = (a: Vec3): number => r[0] * a[0] + r[1] * a[1] + r[2] * a[2];
  const z = dotv(basis.fwd);
  if (z < 0.05) return null;
  const f = 1 / Math.tan(fovDeg * Math.PI / 360);
  return [dotv(basis.right) * f / aspect / z, dotv(basis.up) * f / z];
}

/** What a fit must satisfy: the share of the frame width and height the model's projected extent may fill. */
export interface FitTarget { fillWidth: number; fillHeight: number }

/** The widest and tallest share of the frame `points` fill from any of `eyes` (all aimed at `at`). */
export function projectedFill(points: readonly Vec3[], eyes: readonly Vec3[], at: Vec3, fovDeg: number, aspect: number, centred = false): { width: number; height: number } {
  let width = 0, height = 0;
  for (const eye of eyes) {
    const basis = cameraBasis(eye, at);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const n = projectNdc(p, eye, basis, fovDeg, aspect);
      if (!n) return { width: Infinity, height: Infinity };
      x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]); y0 = Math.min(y0, n[1]); y1 = Math.max(y1, n[1]);
    }
    // NDC spans 2 across the frame: an extent of e is a share e / 2 of it. `centred` measures about the frame
    // centre (twice the largest |coordinate|), so a model that sits off-centre in perspective is still inside.
    width = Math.max(width, centred ? Math.max(Math.abs(x0), Math.abs(x1)) : (x1 - x0) / 2);
    height = Math.max(height, centred ? Math.max(Math.abs(y0), Math.abs(y1)) : (y1 - y0) / 2);
  }
  return { width, height };
}

/**
 * The smallest distance from `at` at which the model, seen from every one of `azimuths` equal azimuths, fills
 * no more than the target share of the frame width and of its height. Bisection on the monotone extent; one
 * distance for all views, so a turntable does not pulse.
 */
export function fitDistance(points: readonly Vec3[], at: Vec3, dir: Vec3, azimuths: number, fovDeg: number, aspect: number, target: FitTarget, centred = true): number {
  const r = boundingRadius(boundsOfPoints(points));
  const fits = (d: number): boolean => {
    const eyes = Array.from({ length: azimuths }, (_, i) => orbitEye(at, dir, i, azimuths, d));
    const f = projectedFill(points, eyes, at, fovDeg, aspect, centred);
    return f.width <= target.fillWidth && f.height <= target.fillHeight;
  };
  // A point cloud inside a sphere of radius r never fits from inside it: start at r, double until it fits.
  let lo = r, hi = r * 2;
  while (!fits(hi) && hi < r * 400) { lo = hi; hi *= 2; }
  for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (fits(mid)) hi = mid; else lo = mid; }
  return hi;
}

/**
 * Aim point and distance for a view. A turntable (several azimuths) aims at the bounds centre and fits about the
 * frame centre. A single hero view first re-aims so the projected extent is centred (perspective pushes a nearer
 * corner out), then fits the extent itself: the model fills the asked share of the frame and sits in the middle.
 */
export function fitView(points: readonly Vec3[], centre: Vec3, dir: Vec3, azimuths: number, fovDeg: number, aspect: number, target: FitTarget): { at: Vec3; distance: number } {
  if (azimuths > 1) return { at: centre, distance: fitDistance(points, centre, dir, azimuths, fovDeg, aspect, target, true) };
  let at = centre;
  const f = 1 / Math.tan(fovDeg * Math.PI / 360);
  for (let k = 0; k < 4; k++) {
    const d = fitDistance(points, at, dir, 1, fovDeg, aspect, target, false);
    const eye = orbitEye(at, dir, 0, 1, d), basis = cameraBasis(eye, at);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const n = projectNdc(p, eye, basis, fovDeg, aspect);
      if (!n) break;
      x0 = Math.min(x0, n[0]); x1 = Math.max(x1, n[0]); y0 = Math.min(y0, n[1]); y1 = Math.max(y1, n[1]);
    }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // ndc = offset * f / (aspect * z) across, offset * f / z up: undo the centre offset at about the model depth.
    const dx = cx * d * aspect / f, dy = cy * d / f;
    at = [at[0] + basis.right[0] * dx + basis.up[0] * dy, at[1] + basis.right[1] * dx + basis.up[1] * dy, at[2] + basis.right[2] * dx + basis.up[2] * dy];
  }
  return { at, distance: fitDistance(points, at, dir, 1, fovDeg, aspect, target, false) };
}
