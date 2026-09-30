/**
 * Pictures of a craftmatic pack: its entities' drawn geometry (the pack's own
 * swatch colours and face atlases) through the simulator's rasteriser. The
 * offline renderer (`scripts/_pack_render.ts`) and the simulator's
 * first-person snapshots share the painting here.
 *
 * A snapshot applies the device's draw ceiling (quirk `actor-draw-ceiling`):
 * an actor farther than it from the eye is not drawn, as on the phones.
 * Cuboid faces only - the colliders are invisible and the ground is not drawn.
 */

import { worldFaces, type AuditActor, type WorldFace } from '../../../engine/bedrock-geometry-faces.js';
import { resolveLdrawEntityMaterial } from '../../../engine/ldraw-entity-materials.js';
import { rasterize, type RasterPaint, type RasterTexture, type V3 } from '../../render/rasterizer.js';
import { quirkValue } from '../../quirks/registry.js';
import type { AddonAppearance } from './appearance.js';
import type { SimEngine } from '../../core/engine.js';
import type { SimEntity } from '../../entity/entity.js';
import { viewDirection } from '../../core/vec.js';

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

/** Render actors' faces from a camera; `faces` from `worldFaces(actors)`. */
export function renderActors(actors: readonly AuditActor[], faces: readonly WorldFace[], camera: { eye: V3; at: V3; fovDeg: number; width: number; height: number }, atlases?: ReadonlyMap<string, RasterTexture>): Uint8Array {
  return rasterize(faces.map(f => ({ corners: f.corners, normal: f.normal as V3, ...(f.uv ? { uv: f.uv } : {}) })), craftmaticPaint(actors, faces, atlases), camera);
}

/** A first-person picture from a player's eye: every entity the pack draws within the draw ceiling. */
export function firstPersonSnapshot(engine: SimEngine, appearance: AddonAppearance, player: SimEntity, size = { width: 480, height: 270 }, fovDeg = 70): Uint8Array {
  const eye = player.headLocation(), ceiling = quirkValue('actor-draw-ceiling', 'blocks');
  const actors: AuditActor[] = [];
  for (const e of engine.loadedEntities(player.dimension)) {
    if (e.isPlayer) continue;
    const entry = appearance.byType.get(e.typeId);
    if (!entry || Math.hypot(e.location.x - eye.x, e.location.z - eye.z) > ceiling) continue;
    // # TODO(sim-render): `worldFaces` places an actor at scale 1; a resized entity (`minecraft:scale`) draws at 100 %.
    // `worldFaces` turns the other way from Bedrock's yaw (see `drawnBoxes`).
    actors.push({ typeId: e.typeId, kind: 'entity', entry, at: e.location, yawDeg: -e.rotation.y });
  }
  const d = viewDirection(player.rotation.y, player.rotation.x);
  const faces = worldFaces(actors);
  return renderActors(actors, faces, { eye: [eye.x, eye.y, eye.z], at: [eye.x + d.x, eye.y + d.y, eye.z + d.z], fovDeg, ...size });
}
