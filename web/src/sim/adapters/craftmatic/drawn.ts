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

/** Read an add-on's appearance (every entity type's drawn geometry). */
export function packAppearance(addon: Addon): AddonAppearance {
  const sources = new Map<string, string>();
  const dec = new TextDecoder();
  for (const rp of resourcePacks(addon)) for (const [path, data] of rp.files) if (APPEARANCE_FILE_PATTERN.test(path)) sources.set(path, dec.decode(data));
  return buildAddonAppearance(sources);
}

/** A drawn cube's world box (blocks) and whether it is see-through (glass). */
export interface DrawnBox { box: Box; glass: boolean }

/** The world boxes of an entity's near geometry at its pose (a turned cube is its corners' box). */
export function drawnBoxes(entry: AddonAppearanceEntry, at: Vec3, yawDeg: number, scale = 1): DrawnBox[] {
  const bones = boneTransforms(entry.bones);
  // `yawDeg` is Bedrock's (yaw 90 faces -X). The placement matrix below is `worldFaces`', whose angle turns
  // the other way (the walk preview's three.js `rotation.y`), so it takes the negated yaw. Measured: at a
  // 90-degree placement of 11371 the un-negated turn put 2 % of the collider boxes near drawn geometry, the
  // negated one as many as at 0 degrees.
  const y = -yawDeg * Math.PI / 180, cy = Math.cos(y), sy = Math.sin(y);
  // Geometry JSON → world: Z mirrored, then the yaw about +Y, then the scale and the placement (units of 1/16 block).
  const place: Affine = [cy * scale, 0, -sy * scale, at.x * 16, 0, scale, 0, at.y * 16, -sy * scale, 0, -cy * scale, at.z * 16];
  const out: DrawnBox[] = [];
  for (const g of entry.groups) {
    if (g.far) continue;
    for (const c of g.cubes) {
      const k = cubeCorners(c, mul(place, bones.get(c.bone) ?? IDENTITY));
      const xs = k.map(p => p[0] / 16), ys = k.map(p => p[1] / 16), zs = k.map(p => p[2] / 16);
      out.push({ box: { x0: Math.min(...xs), y0: Math.min(...ys), z0: Math.min(...zs), x1: Math.max(...xs), y1: Math.max(...ys), z1: Math.max(...zs) }, glass: g.alpha < 1 });
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
 * meeting an opaque one - the cockpit test (`forwardView` in
 * cockpit-seat.ts, with its yaw/pitch fan), in the world frame, looking along
 * `yawDeg`. 1 = every ray clear.
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
