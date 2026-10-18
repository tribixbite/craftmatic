/**
 * The LDraw → scene frame, in ONE place.
 *
 * LDraw is right-handed with +Y DOWN and its models face −Z; three.js is
 * right-handed with +Y up. The map between two right-handed frames is a
 * ROTATION: a half turn about X, `diag(1, −1, −1)`, which sends LDraw −Z (the
 * model's front) to scene +Z. Negating Y ALONE (`diag(1, −1, 1)`) has
 * determinant −1: it is a reflection, and every model rendered through it was
 * the mirror image of the real set — invisible on symmetric builds, obvious on
 * text (10261's COASTER sign read backwards against the box art, 2026-09-22;
 * every one of the 932 glyph triangles of 10261's printed `3069bp82` tile
 * reversed its apparent winding from the printed side) and on any chiral
 * layout. The same matrix was baked into every GLB/OBJ/STL/3MF export, so
 * prints came out chirally wrong with inward-facing normals.
 *
 * The block grid (`engine/ldraw-geometry.ts`, `engine/ldraw-voxelizer.ts`,
 * `engine/bedrock-scene-actors.ts` `sceneGridPoint`) uses the same rotation,
 * and `engine/lxf-parser.ts` `FRAME_SIGN` and `engine/ldraw-entity-compiler.ts`
 * `ldrawToRenderRotation('+z')` are the same matrix. `test/ldraw-frame.test.ts`
 * pins `det = +scale³ · det(R)` and a printed-side winding check, so the
 * reflection cannot silently return.
 */

import * as THREE from 'three';
import type { Vec3 } from './types.js';

/** Per-axis signs of the LDraw → scene frame: the half turn about X. */
export const LDRAW_TO_SCENE_SIGN: readonly [1, -1, -1] = [1, -1, -1];

/** An LDraw point in scene units: `(x, −y, −z) · scale`. */
export function ldrawPointToScene(v: Vec3, scale = 1): [number, number, number] {
  return [v[0] * scale, -v[1] * scale, -v[2] * scale];
}

/** `ldrawPointToScene` without the allocation, for the edge-segment hot loop. */
export function pushLdrawPointToScene(out: number[], v: Vec3, scale: number): void {
  out.push(v[0] * scale, -v[1] * scale, -v[2] * scale);
}

/**
 * The per-instance matrix for a placement: `S · F · [R | T]` with the uniform
 * scale `S`, the frame `F = diag(1, −1, −1)` and the LDraw row-major rotation
 * `R` and position `T`. Its determinant is `+scale³ · det(R)`: a placement's
 * handedness in the scene is exactly its handedness in the source (a
 * mirrored sub-part keeps `det(R) = −1`, nothing else flips).
 */
export function ldrawInstanceMatrix(R: readonly number[], T: Vec3, scale: number): THREE.Matrix4 {
  const [sx, sy, sz] = LDRAW_TO_SCENE_SIGN;
  return new THREE.Matrix4().set(
    sx * scale * R[0]!, sx * scale * R[1]!, sx * scale * R[2]!, sx * scale * T[0],
    sy * scale * R[3]!, sy * scale * R[4]!, sy * scale * R[5]!, sy * scale * T[1],
    sz * scale * R[6]!, sz * scale * R[7]!, sz * scale * R[8]!, sz * scale * T[2],
    0, 0, 0, 1,
  );
}
