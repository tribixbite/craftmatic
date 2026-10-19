/**
 * Convert a list of Three.js `Mesh` objects into `MeshInput[]` for the GLB
 * writer, with texture pixels encoded as JPEG via `sharp`.
 *
 * This is the single place Three-specific mesh data crosses into pure pipeline
 * data. Everything downstream (GLB writer, voxelizer) operates on plain
 * Float32Arrays and Uint8Arrays.
 *
 * Extracted from the inline block in `scripts/tiles-headless.ts` (lines
 * 628-668) so it can be reused by the new `captureTiles()` and the legacy
 * script. Adds stronger typing and optional texture-encoding-off path for
 * faster tests.
 */

import type * as THREE from 'three';
import type { MeshInput } from '../export/glb-writer.js';

export interface ExtractMeshOptions {
  /**
   * When false, skip the sharp JPEG encode step (textures dropped).
   * Default true — keep texture data so the tile capture's output GLB is
   * viewable in a renderer.
   */
  readonly encodeTextures?: boolean;
  /** JPEG quality (1-100). Default 85 — matches legacy script. */
  readonly textureQuality?: number;
}

/**
 * Extract attributes + texture images from a set of Three meshes, returning
 * `MeshInput[]` ready to feed into `buildGlb()`.
 *
 * Input meshes must have:
 *   • `geometry.attributes.position` (required)
 *   • optional `geometry.attributes.normal`, `geometry.attributes.uv`
 *   • optional `material.map` with a raw RGBA image (as DRACO decoder produces)
 *
 * The world matrix is NOT applied here — callers should bake matrixWorld into
 * geometry before calling (as `scripts/tiles-headless.ts` does at line 458-464
 * via `geometry.applyMatrix4(mesh.matrixWorld)`).
 */
export async function extractMeshInputs(
  meshes: readonly THREE.Mesh[],
  opts: ExtractMeshOptions = {},
): Promise<MeshInput[]> {
  const encodeTextures = opts.encodeTextures ?? true;
  const textureQuality = opts.textureQuality ?? 85;

  const sharpMod = encodeTextures
    ? (await import('sharp')).default
    : null;

  const out: MeshInput[] = [];
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geo.getAttribute('position') as (THREE.BufferAttribute | undefined);
    if (!posAttr) continue;

    const position = new Float32Array(posAttr.array);
    const normalAttr = geo.getAttribute('normal') as (THREE.BufferAttribute | undefined);
    const uvAttr = geo.getAttribute('uv') as (THREE.BufferAttribute | undefined);
    const indexAttr = geo.getIndex();

    const normal = normalAttr ? new Float32Array(normalAttr.array) : null;
    const uv = uvAttr ? new Float32Array(uvAttr.array) : null;
    const index = indexAttr ? new Uint32Array(indexAttr.array) : null;

    let textureJpeg: Uint8Array | null = null;
    let texWidth = 0;
    let texHeight = 0;

    if (encodeTextures && sharpMod) {
      const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
      const tex = mat?.map;
      const image = (tex as unknown as { image?: { data?: ArrayBuffer | Uint8Array; width: number; height: number } })?.image;
      if (image?.data && image.width > 1 && image.height > 1) {
        try {
          const w = image.width;
          const h = image.height;
          const dataSource = image.data as ArrayBuffer | Uint8Array;
          const imgData = new Uint8Array(
            dataSource instanceof Uint8Array ? dataSource.buffer : dataSource,
          );
          const channels = imgData.length / (w * h);
          if (channels === 3 || channels === 4) {
            const jpeg = await sharpMod(Buffer.from(imgData), {
              raw: { width: w, height: h, channels: channels as 3 | 4 },
            }).jpeg({ quality: textureQuality }).toBuffer();
            textureJpeg = new Uint8Array(jpeg);
            texWidth = w;
            texHeight = h;
          }
        } catch {
          // swallow — missing texture is non-fatal, mesh gets default grey material
        }
      }
    }

    out.push({
      position, normal, uv, index,
      textureJpeg,
      ...(texWidth > 0 ? { texWidth, texHeight } : {}),
    });
  }
  return out;
}

/**
 * Count how many meshes in the input have usable texture maps.
 * Helpful for progress reporting and for deciding whether to invoke the pure
 * extraction path at all.
 */
export function countTexturedMeshes(meshes: readonly THREE.Mesh[]): number {
  let n = 0;
  for (const mesh of meshes) {
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined;
    const tex = mat?.map;
    const image = (tex as unknown as { image?: { data?: unknown; width?: number; height?: number } })?.image;
    if (image?.data && (image.width ?? 0) > 1 && (image.height ?? 0) > 1) n++;
  }
  return n;
}
