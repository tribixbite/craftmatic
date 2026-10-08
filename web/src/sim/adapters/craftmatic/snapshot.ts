/**
 * Pictures of a craftmatic pack: its entities' drawn geometry (the pack's own
 * swatch colours and face atlases) through the simulator's rasteriser. The
 * offline renderer (`scripts/_pack_render.ts`) and the simulator's
 * first-person snapshots share the painting here.
 *
 * A snapshot applies the device's actor cull through `entityRenderCullBlocks`
 * (quirks `actor-draw-ceiling` and `cull-by-collision-box`, whose registry
 * values ARE that function's constants `ACTOR_DRAW_CEILING_BLOCKS` and
 * `RENDER_CULL_BLOCKS_PER_UNIT`): an actor farther than its cull from the eye
 * is not drawn, as on the phones.
 * Cuboid faces only - the colliders are invisible and the ground is not drawn.
 *
 * `clientSnapshot` is the picture the PHONE shows: rendered from the DRAWN
 * camera (`client/camera.ts`: the eased or animated script camera, or the
 * player's own eye) with every entity at its DRAWN pose (the client's lag),
 * the box-UV faces the device drops left out (quirk `box-uv-sub-unit-faces`,
 * `UvFloorModel` `v`), coplanar fights flagged as hatch pixels (quirk
 * `coplanar-hatching`), each entity's LOD hull switched by the drawn
 * camera's distance to its root (quirk `lod-switch-camera-root`) and the cull
 * read in 3-D with the horizontal reading reported beside it (TODO(cull)).
 */

import { worldFaces, type AuditActor, type WorldFace } from '../../../engine/bedrock-geometry-faces.js';
import { entityRenderCullBlocks } from '../../../engine/bedrock-lod-hull.js';
import { boxUvFaceDrawn, type UvFloorModel } from '../../../engine/figure-holes.js';
import { resolveLdrawEntityMaterial } from '../../../engine/ldraw-entity-materials.js';
import { paintHatch, rasterize, rasterizeDetailed, type RasterPaint, type RasterQuad, type RasterResult, type RasterTexture, type V3 } from '../../render/rasterizer.js';
import type { AddonAppearance } from './appearance.js';
import type { SimEngine } from '../../core/engine.js';
import type { SimEntity } from '../../entity/entity.js';
import { viewDirection, type Vec3 } from '../../core/vec.js';
import type { ClientView, DrawnCamera } from '../../client/camera.js';

/** Paint a face of `actors` with its group's swatch colour, or its face atlas when decoded. */
export function craftmaticPaint(actors: readonly AuditActor[], faces: readonly WorldFace[], atlases: ReadonlyMap<string, RasterTexture> = new Map()): (q: unknown, index: number, shade: number) => RasterPaint {
  return (_q, index, shade) => {
    const face = faces[index]!;
    const g = actors[face.actor]!.entry.groups[face.group]!;
    const tex = g.texture ? atlases.get(g.texture.path) : undefined;
    if (tex) return { rgb: [shade, shade, shade], alpha: 1, tex };
    const m = g.ldrawColor !== null ? resolveLdrawEntityMaterial(g.ldrawColor) : { rgb: [176, 184, 196] as [number, number, number], alpha: 1 };
    return { rgb: [m.rgb[0] / 255 * shade, m.rgb[1] / 255 * shade, m.rgb[2] / 255 * shade], alpha: m.alpha };
  };
}

/** The rasteriser's quads for drawn faces: corners, normal, decal UVs, the colour key and the actor (for the hatch flag). */
export function faceQuads(faces: readonly WorldFace[]): RasterQuad[] {
  return faces.map(f => ({ corners: f.corners, normal: f.normal as V3, key: f.colour, owner: f.actor, ...(f.uv ? { uv: f.uv } : {}) }));
}

/** Render actors' faces from a camera; `faces` from `worldFaces(actors)`. */
export function renderActors(actors: readonly AuditActor[], faces: readonly WorldFace[], camera: { eye: V3; at: V3; up?: V3; fovDeg: number; width: number; height: number }, atlases?: ReadonlyMap<string, RasterTexture>): Uint8Array {
  return rasterize(faceQuads(faces), craftmaticPaint(actors, faces, atlases), camera);
}

/** The device rules a detailed render applies. */
export interface RenderRules {
  /** Leave out the box-UV faces the device does not draw (`v`: the Pixel-measured rule); `none` draws every face. */
  uvFloor: UvFloorModel;
  /** Flag coplanar fights (always measured; this only says whether the frames paint them). */
  hatch: boolean;
}

/** `renderActors` with the device rules: the picture, the per-pixel findings and the dropped-face test the caller may reuse. */
export function renderActorsDetailed(actors: readonly AuditActor[], faces: readonly WorldFace[], camera: { eye: V3; at: V3; up?: V3; fovDeg: number; width: number; height: number }, rules: RenderRules, atlases?: ReadonlyMap<string, RasterTexture>): RasterResult {
  const dropped = (i: number): boolean => {
    const f = faces[i]!;
    return !boxUvFaceDrawn(actors[f.actor]!.entry.groups[f.group]!.cubes[f.cube]!, f.face, rules.uvFloor);
  };
  return rasterizeDetailed(faceQuads(faces), craftmaticPaint(actors, faces, atlases), camera, { dropped });
}

/** A first-person picture from a player's eye: every entity the pack draws within the draw ceiling. */
export function firstPersonSnapshot(engine: SimEngine, appearance: AddonAppearance, player: SimEntity, size = { width: 480, height: 270 }, fovDeg = 70): Uint8Array {
  const eye = player.headLocation();
  const actors: AuditActor[] = [];
  for (const e of engine.loadedEntities(player.dimension)) {
    if (e.isPlayer) continue;
    const entry = appearance.byType.get(e.typeId);
    // Measured: the cull follows the CAMERA, not the player (the 200 % shell
    // was drawn 50.34 blocks from its root and gone at 75.82). Whether the
    // device measures that distance in 3D or horizontally is NOT separated by
    // that evidence; the snapshot takes the 3D camera-to-root distance.
    // TODO(cull): settle 3D vs horizontal with a probe that varies only height.
    // At 100 % a small box uses the 64-block floor and no actor exceeds the
    // measured 70-block ceiling; geometry and visible_bounds do not extend it.
    const rootDistance = Math.hypot(e.location.x - eye.x, e.location.y - eye.y, e.location.z - eye.z);
    if (!entry || rootDistance > entityRenderCullBlocks(e.collisionSize())) continue;
    actors.push({ typeId: e.typeId, kind: 'entity', entry, at: e.location, yawDeg: e.rotation.y, scale: e.scale() });
  }
  const d = viewDirection(player.rotation.y, player.rotation.x);
  const faces = worldFaces(actors);
  return renderActors(actors, faces, { eye: [eye.x, eye.y, eye.z], at: [eye.x + d.x, eye.y + d.y, eye.z + d.z], fovDeg, ...size });
}

/** Blocks from the eye within which a hatch or a dropped face is "near" (what a player standing at a model sees up close). */
export const NEAR_BLOCKS = 8;

/** What a client snapshot asks for. */
export interface ClientSnapshotOptions {
  width?: number; height?: number; fovDeg?: number;
  /** The box-UV floor rule (default `v`, the device's). */
  uvFloor?: UvFloorModel;
  /** Switch each entity's LOD hull by the drawn camera's distance to its root (default true). */
  lod?: boolean;
  /** Paint the hatch pixels into the picture (default false: the picture shows the nearer face; the count is always taken). */
  paintHatch?: boolean;
  /** Decoded face atlases by resource path (a figure's face print); without them a decal cube draws its swatch shade. */
  atlases?: ReadonlyMap<string, RasterTexture>;
}

/** One drawn entity's cull and LOD reading. */
export interface SnapshotEntity {
  typeId: string;
  id: string;
  /** Camera-to-root distance, 3-D (the snapshot's verdict) and horizontal (reported). */
  dist3d: number; distHorizontal: number;
  /** The realised cull distance (`entityRenderCullBlocks` of the realised box). */
  cullBlocks: number;
  /** `full`: the near geometry; `hull`: the LOD hull past its switch; `gone`: culled. */
  state: 'full' | 'hull' | 'gone';
  /** The entity's LOD switch distance, when it ships a hull. */
  lodDistance?: number;
  /** The 3-D and horizontal readings give DIFFERENT cull verdicts here (TODO(cull): unsettled, reported, the 3-D one taken). */
  cullDisagree: boolean;
}

/** What a client snapshot measured beside its picture. */
export interface SnapshotMetrics {
  /** Pixels an opaque face reached. */
  drawnPixels: number;
  /** Hatch pixels in the whole picture, and within `NEAR_BLOCKS` of the eye by kind. */
  hatchPixels: number;
  hatchNear: { sameActor: number; crossActor: number };
  /** Share of the picture's drawn pixels that are hatched. */
  hatchShareOfImage: number;
  /** Pixels within `NEAR_BLOCKS` whose nearest face the device drops, and their share of the near drawn pixels. */
  droppedNearPixels: number;
  droppedNearShare: number;
  /** Pixels a translucent face was blended on (FID-05: glass drawn translucent). */
  translucentPixels: number;
  entities: SnapshotEntity[];
}

/** A client snapshot: the picture and what it measured, with the camera it was drawn from. */
export interface ClientSnapshotResult { rgb: Uint8Array; width: number; height: number; camera: DrawnCamera; metrics: SnapshotMetrics }

/**
 * One actor's cull and LOD reading from a camera: culled past its realised cull (3-D, the horizontal reading
 * reported), the hull past its switch distance when it ships one and `lod` is on.
 */
export function actorLodState(entry: AddonAppearance['byType'] extends Map<string, infer E> ? E : never, cullBlocks: number, dist3d: number, distHorizontal: number, lod: boolean): Pick<SnapshotEntity, 'state' | 'lodDistance' | 'cullDisagree'> {
  const gone3d = dist3d > cullBlocks, goneH = distHorizontal > cullBlocks;
  const lodDistance = entry.groups.find(g => g.lodDistance !== undefined)?.lodDistance;
  const hull = lod && lodDistance !== undefined && dist3d > lodDistance && entry.groups.some(g => g.far);
  return { state: gone3d ? 'gone' : hull ? 'hull' : 'full', ...(lodDistance !== undefined ? { lodDistance } : {}), cullDisagree: gone3d !== goneH };
}

/** The faces of actors drawn full and actors drawn as their hull, one actor list (the hull actors' face indices offset past the full ones). */
export function lodFaces(full: readonly AuditActor[], hull: readonly AuditActor[]): { actors: AuditActor[]; faces: WorldFace[] } {
  return { actors: [...full, ...hull], faces: [...worldFaces(full), ...worldFaces(hull, { far: true }).map(f => ({ ...f, actor: f.actor + full.length }))] };
}

/** What a detailed raster measured: drawn, hatched (near by kind), dropped-near and translucent pixels. */
export function rasterMetrics(res: RasterResult, nearBlocks = NEAR_BLOCKS): Omit<SnapshotMetrics, 'entities'> {
  let drawnPixels = 0, hatchPixels = 0, same = 0, cross = 0, droppedNear = 0, drawnNear = 0, translucentPixels = 0;
  for (let k = 0; k < res.width * res.height; k++) {
    const d = res.depth[k]!;
    if (Number.isFinite(d)) drawnPixels++;
    if (res.translucent[k]) translucentPixels++;
    if (res.hatch[k]) { hatchPixels++; if (d <= nearBlocks) { if (res.hatch[k] === 1) same++; else cross++; } }
    if (Number.isFinite(d) && d <= nearBlocks) drawnNear++;
    if (res.dropped[k] && d <= nearBlocks) droppedNear++;
  }
  return { drawnPixels, hatchPixels, hatchNear: { sameActor: same, crossActor: cross }, hatchShareOfImage: drawnPixels ? hatchPixels / drawnPixels : 0, droppedNearPixels: droppedNear, droppedNearShare: drawnNear ? droppedNear / drawnNear : 0, translucentPixels };
}

/**
 * The picture the phone shows a player NOW: from the drawn camera, every
 * entity at its drawn pose, with the device's face, hatch, LOD and cull rules.
 */
export function clientSnapshot(engine: SimEngine, appearance: AddonAppearance, player: SimEntity, client: ClientView, options: ClientSnapshotOptions = {}): ClientSnapshotResult {
  const width = options.width ?? 480, height = options.height ?? 270, fovDeg = options.fovDeg ?? 70;
  const uvFloor = options.uvFloor ?? 'v', lod = options.lod ?? true;
  const camera = client.drawn(player);
  const eye = camera.eye;
  const full: AuditActor[] = [], hull: AuditActor[] = [];
  const entities: SnapshotEntity[] = [];
  for (const e of engine.loadedEntities(player.dimension)) {
    if (e === player) continue;
    const entry = appearance.byType.get(e.typeId);
    if (!entry) continue;
    const p = client.drawnPose(e);
    const dist3d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z), distHorizontal = Math.hypot(p.x - eye.x, p.z - eye.z);
    const cullBlocks = entityRenderCullBlocks(e.collisionSize());
    const s = actorLodState(entry, cullBlocks, dist3d, distHorizontal, lod);
    entities.push({ typeId: e.typeId, id: e.id, dist3d, distHorizontal, cullBlocks, ...s });
    if (s.state === 'gone') continue;
    (s.state === 'hull' ? hull : full).push({ typeId: e.typeId, kind: 'entity', entry, at: { x: p.x, y: p.y, z: p.z }, yawDeg: p.yaw, scale: p.scale });
  }
  const { actors, faces } = lodFaces(full, hull);
  const at: V3 = [eye.x + camera.dir.x, eye.y + camera.dir.y, eye.z + camera.dir.z];
  const res = renderActorsDetailed(actors, faces, { eye: [eye.x, eye.y, eye.z], at, up: [camera.up.x, camera.up.y, camera.up.z], fovDeg, width, height }, { uvFloor, hatch: !!options.paintHatch }, options.atlases);
  return { rgb: options.paintHatch ? paintHatch(res) : res.rgb, width, height, camera, metrics: { ...rasterMetrics(res), entities } };
}

/** The point a drawn camera looks at, one block ahead (for callers building a raster camera). */
export function lookPoint(camera: DrawnCamera): Vec3 { return { x: camera.eye.x + camera.dir.x, y: camera.eye.y + camera.dir.y, z: camera.eye.z + camera.dir.z }; }
