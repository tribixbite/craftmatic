/**
 * Screen-space touch: a finger at a point of a PHONE-SHAPED screen picks along
 * the ray from the camera the player SEES (quirk `touch-screen-pick`) - with
 * Split Controls on (a crosshair, how both QA phones are set) through the
 * screen CENTRE wherever the finger lands outside the HUD, with them off
 * through the touched point:
 *
 *   - the camera is the script camera when one is active (`setCamera`
 *     `minecraft:free` with a location: the chase or cockpit view), else the
 *     player's eye along its look;
 *   - the projection is the snapshot rasteriser's (`render/rasterizer.ts`):
 *     a vertical field of view, the screen's aspect;
 *   - the ray hits entities' REALISED pick boxes (`ray.ts` `pickBoxes`:
 *     custom hit test, else the collision box times the scale, quirk
 *     `collision-box-scales-with-entity`) and blocks' selection boxes (a
 *     collider has none, quirk `no-selection-box-passes-taps`);
 *   - a hit counts only within the touch reach (quirk `tap-is-hit`, 5 blocks)
 *     of the PLAYER's eye, wherever the camera stands.
 *
 * TODO(sim-client): the camera is the script's REQUESTED pose; the pose the
 * client DRAWS (the 0.1 s ease, the entity draw lag) is package B's client
 * camera model, and this module should read it once it lands.
 */

import { add, distance, scale, viewDirection, type Vec3 } from '../core/vec.js';
import type { SimEngine } from '../core/engine.js';
import type { SimEntity } from '../entity/entity.js';
import { quirkValue } from '../quirks/registry.js';
import { raycastBlocks, raycastEntities } from './ray.js';
import type { TouchResult } from './touch.js';

/** A phone screen in raw pixels (landscape) and the field of view the game draws it with. */
export interface Viewport {
  name: string; width: number; height: number;
  /** Vertical field of view, degrees. */
  fovDeg: number;
  /**
   * How a world tap aims (quirk `touch-screen-pick`): `crosshair` (Bedrock's Split Controls, the QA phones' setting:
   * a tap anywhere outside the HUD acts along the screen-CENTRE ray) or `touch` (Split Controls off: along the ray
   * through the touched point).
   */
  touchMode: 'crosshair' | 'touch';
}

/** The Pixel 8 Pro in landscape: the raw `screencap` size (CLAUDE.md "ADB taps use raw landscape screenshot coordinates"). */
export const PIXEL_VIEWPORT: Viewport = { name: 'pixel', width: 2244, height: 1008, fovDeg: quirkValue('touch-screen-pick', 'verticalFovDeg'), touchMode: 'crosshair' };
/** The Saga in landscape (2400 x 1080). */
export const SAGA_VIEWPORT: Viewport = { name: 'saga', width: 2400, height: 1080, fovDeg: quirkValue('touch-screen-pick', 'verticalFovDeg'), touchMode: 'crosshair' };
/** A phone with Split Controls OFF (the Bedrock default): a tap picks under the finger. */
export const touchModeOf = (v: Viewport, touchMode: Viewport['touchMode']): Viewport => ({ ...v, touchMode });

/** A point on the screen, raw pixels from the top-left corner. */
export interface ScreenPoint { x: number; y: number }

/** The camera a player sees through: where it stands and its frame. */
export interface ScreenCamera { eye: Vec3; forward: Vec3; source: 'script-camera' | 'eye' }

/** The script-camera state the host keeps per player (`PlayerExtra.camera`). */
export interface ScriptCameraState { preset?: string; rotation?: { x: number; y: number }; location?: Vec3; facing?: Vec3 }

const norm = (v: Vec3): Vec3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Whether a script camera replaces the player's own view (any preset but first person, as the packs use `minecraft:free`). */
export function scriptCameraActive(cam: ScriptCameraState | undefined): boolean {
  return !!cam?.preset && cam.preset !== 'minecraft:first_person';
}

/**
 * The camera the player sees through: a script `minecraft:free` camera with a location (facing its
 * `facingLocation`, else its rotation), otherwise the player's eye along its look.
 */
export function screenCamera(player: SimEntity, cam?: ScriptCameraState): ScreenCamera {
  if (scriptCameraActive(cam) && cam?.location) {
    const forward = cam.facing ? norm({ x: cam.facing.x - cam.location.x, y: cam.facing.y - cam.location.y, z: cam.facing.z - cam.location.z })
      : viewDirection(cam.rotation?.y ?? player.rotation.y, cam.rotation?.x ?? player.rotation.x);
    return { eye: { ...cam.location }, forward, source: 'script-camera' };
  }
  return { eye: player.headLocation(), forward: viewDirection(player.rotation.y, player.rotation.x), source: 'eye' };
}

/**
 * The world ray through a screen point: the inverse of the rasteriser's projection
 * (`x = W/2 + (r·right) f / aspect / z · W/2`, `y = H/2 - (r·up) f / z · H/2`, `f = 1 / tan(fov / 2)`).
 */
export function screenRay(camera: ScreenCamera, point: ScreenPoint, viewport: Viewport): { origin: Vec3; dir: Vec3 } {
  const f = 1 / Math.tan(viewport.fovDeg * Math.PI / 360), aspect = viewport.width / viewport.height;
  const fwd = norm(camera.forward);
  // A camera looking straight up or down has no right vector from world up; take one from +Z then.
  const right = Math.abs(fwd.y) > 0.999 ? norm(cross(fwd, { x: 0, y: 0, z: 1 })) : norm(cross(fwd, { x: 0, y: 1, z: 0 }));
  const up = cross(right, fwd);
  const nx = (point.x - viewport.width / 2) / (viewport.width / 2), ny = (viewport.height / 2 - point.y) / (viewport.height / 2);
  const dir = norm(add(add(fwd, scale(right, nx * aspect / f)), scale(up, ny / f)));
  return { origin: camera.eye, dir };
}

/** The screen point a world point is drawn at (undefined behind the camera): the rasteriser's projection. */
export function projectToScreen(camera: ScreenCamera, p: Vec3, viewport: Viewport): ScreenPoint | undefined {
  const f = 1 / Math.tan(viewport.fovDeg * Math.PI / 360), aspect = viewport.width / viewport.height;
  const fwd = norm(camera.forward);
  const right = Math.abs(fwd.y) > 0.999 ? norm(cross(fwd, { x: 0, y: 0, z: 1 })) : norm(cross(fwd, { x: 0, y: 1, z: 0 }));
  const up = cross(right, fwd);
  const r = { x: p.x - camera.eye.x, y: p.y - camera.eye.y, z: p.z - camera.eye.z };
  const z = r.x * fwd.x + r.y * fwd.y + r.z * fwd.z;
  if (z < 0.05) return undefined;
  const rx = r.x * right.x + r.y * right.y + r.z * right.z, ry = r.x * up.x + r.y * up.y + r.z * up.z;
  return { x: viewport.width / 2 + (rx * f / aspect / z) * viewport.width / 2, y: viewport.height / 2 - (ry * f / z) * viewport.height / 2 };
}

/** What a screen tap picked, and from which camera. */
export interface ScreenPick extends TouchResult {
  camera: ScreenCamera['source'];
  /** The world point the ray met first (entity box or block), when it met one within range. */
  point?: Vec3;
  /** Set when the first thing on the ray was an entity beyond the touch reach of the player's eye. */
  outOfReach?: { entity: string; eyeDistance: number };
}

/**
 * Pick along a screen point's ray (see the module header). The ray runs from the camera; whatever it meets first
 * - an entity's pick box or a block's selection box - is the candidate, and an entity counts only within the
 * touch reach of the player's EYE. The player's own mount is not pickable by its rider (as `touch.ts` `pick`).
 */
export function screenPick(engine: SimEngine, player: SimEntity, point: ScreenPoint, viewport: Viewport, cam?: ScriptCameraState): ScreenPick {
  const camera = screenCamera(player, cam);
  // With Split Controls (a crosshair) a tap anywhere outside the HUD acts at the crosshair: the screen centre.
  const aimAt = viewport.touchMode === 'crosshair' ? { x: viewport.width / 2, y: viewport.height / 2 } : point;
  const { origin, dir } = screenRay(camera, aimAt, viewport);
  const reach = quirkValue('tap-is-hit', 'reachBlocks');
  // The ray may start behind the player (a chase camera): it is long enough to pass the player's reach sphere.
  const maxT = distance(origin, player.headLocation()) + reach;
  const world = engine.dimension(player.dimension);
  const hits = raycastEntities(engine.loadedEntities(player.dimension), origin, dir, maxT, player).filter(h => h.entity !== player.ridingOn);
  const block = raycastBlocks(world, origin, dir, maxT, { includePassable: true });
  const first = hits[0];
  if (block && (!first || block.distance < first.distance)) {
    return { camera: camera.source, blockedBy: `${block.x},${block.y},${block.z} ${world.permutationAt(block.x, block.y, block.z).typeId}`, distance: block.distance, point: block.point };
  }
  if (!first) return { camera: camera.source };
  const at = add(origin, scale(dir, first.distance));
  const eyeDistance = distance(at, player.headLocation());
  if (eyeDistance > reach) return { camera: camera.source, outOfReach: { entity: first.entity.typeId, eyeDistance: Math.round(eyeDistance * 100) / 100 }, point: at };
  return { camera: camera.source, entity: first.entity, distance: first.distance, point: at };
}

/** A screen TAP: pick, then `entityHitEntity` on the entity picked (quirk `tap-is-hit`). */
export function tapScreen(engine: SimEngine, player: SimEntity, point: ScreenPoint, viewport: Viewport, cam?: ScriptCameraState): ScreenPick {
  const r = screenPick(engine, player, point, viewport, cam);
  if (r.entity) engine.emit('entityHitEntity', { damagingEntity: player, hitEntity: r.entity });
  return r;
}
