/**
 * Post-voxelization pass that re-colors a BlockGrid by sampling colors
 * from photogrammetry meshes (positions + UVs + decoded textures).
 *
 * Pipeline integration:
 *   1. Voxelizer produces a BlockGrid filled with the BRep wall color.
 *   2. This pass walks every non-air voxel, finds the closest
 *      photogrammetry triangle in the SAME XZ but Y inverse-scaled to
 *      photogrammetry-local Y, samples the triangle's texture color via
 *      barycentric UV interpolation, and re-picks a Minecraft block via
 *      `rgbToWallBlock`.
 *   3. Voxels far from any photogrammetry surface keep their original
 *      block (the voxelizer-overlay-set windows / cornice / plinth).
 *
 * Coordinate frames:
 *   • Voxel grid local: minX..maxX × 0..H × minZ..maxZ at `resolution`
 *     blocks per metre. Y is the SCALED building height (the
 *     synthesizer Y-scaled photogrammetry's surviving range onto
 *     [0, expectedHeightM]).
 *   • Photogrammetry local: original capture frame, X/Z share grid
 *     conventions but Y is unscaled — bands.trueMinY..bands.trueMaxY.
 *
 * The `yScale` and `yOffset` parameters let us map grid Y back to
 * photogrammetry Y per voxel. Sampling photogrammetry at the matching
 * Y captures vertical material variation (lower-floor stone vs upper-
 * floor curtain wall, dark base vs light upper, etc.).
 */

import * as THREE from 'three';
import { MeshBVH, type MeshBVH as MeshBVHCore } from 'three-mesh-bvh';
import jpeg from 'jpeg-js';
import { rgbToWallBlock } from '../../gen/color-blocks.js';
import type { BlockGrid } from '../../schem/types.js';
import type { FullMeshPrimitive } from './glb-writer.js';

export interface RecolorOptions {
  /** Grid origin in world metres (corresponds to grid voxel (0,0,0)). */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  /** Voxel grid resolution (blocks per metre). */
  readonly resolution: number;
  /** Inverse-scale grid Y to photogrammetry Y: y_PG = y_grid / yScale + yShift. */
  readonly yScale: number;
  readonly yShift: number;
  /** Distance threshold for "close enough to photogrammetry surface". */
  readonly maxDistanceM?: number;
  /** Optional progress callback. */
  readonly onProgress?: (frac: number) => void;
}

interface DecodedTexture {
  width: number;
  height: number;
  /** RGBA pixel buffer (Uint8ClampedArray-compatible). */
  pixels: Uint8Array;
}

interface PreparedMesh {
  bvh: MeshBVHCore;
  geometry: THREE.BufferGeometry;
  /** Per-vertex UVs (TEXCOORD_0). null when the primitive had no UVs. */
  uvs: Float32Array | null;
  texture: DecodedTexture | null;
  /** Fallback factor when texture is null. */
  baseColor: readonly [number, number, number] | null;
}

/**
 * Decode a JPEG/PNG texture image into RGBA pixels. Uses jpeg-js for
 * JPEG; PNG uses pureimage as a fallback. Returns null for unsupported
 * mime types.
 */
async function decodeTexture(
  bytes: Uint8Array,
  mime: 'image/jpeg' | 'image/png',
): Promise<DecodedTexture | null> {
  if (mime === 'image/jpeg') {
    try {
      const result = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      return {
        width: result.width,
        height: result.height,
        pixels: new Uint8Array(result.data),
      };
    } catch {
      return null;
    }
  }
  // PNG via pureimage
  try {
    const pi = await import('pureimage');
    // pureimage works with streams; wrap bytes in a Buffer
    const { Readable } = await import('node:stream');
    const buf = Buffer.from(bytes);
    const stream = Readable.from(buf);
    const img = await pi.decodePNGFromStream(stream);
    const w = img.width;
    const h = img.height;
    const pixels = new Uint8Array(w * h * 4);
    // Read RGBA (pureimage stores as int32 ABGR; we re-pack)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = img.getPixelRGBA(x, y);
        const i = (y * w + x) * 4;
        // pureimage ABGR uint32: byte order R,G,B,A
        pixels[i]     = (px >>> 24) & 0xff;  // R
        pixels[i + 1] = (px >>> 16) & 0xff;  // G
        pixels[i + 2] = (px >>>  8) & 0xff;  // B
        pixels[i + 3] = px & 0xff;            // A
      }
    }
    return { width: w, height: h, pixels };
  } catch {
    return null;
  }
}

/**
 * Build a Three.js BufferGeometry + MeshBVH for closest-point queries
 * from a FullMeshPrimitive. Decodes texture if present.
 */
async function prepareMesh(prim: FullMeshPrimitive): Promise<PreparedMesh> {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(prim.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(prim.indices, 1));
  if (prim.uvs) {
    geo.setAttribute('uv', new THREE.BufferAttribute(prim.uvs, 2));
  }
  geo.computeBoundingBox();
  const bvh = new MeshBVH(geo);
  let texture: DecodedTexture | null = null;
  if (prim.textureImage && prim.textureMime) {
    texture = await decodeTexture(prim.textureImage, prim.textureMime);
  }
  const baseColor: [number, number, number] | null = prim.baseColorFactor
    ? [
        Math.round(prim.baseColorFactor[0] * 255),
        Math.round(prim.baseColorFactor[1] * 255),
        Math.round(prim.baseColorFactor[2] * 255),
      ]
    : null;
  return { bvh, geometry: geo, uvs: prim.uvs, texture, baseColor };
}

/**
 * Sample an RGB color from a triangle's texture by barycentric UV
 * interpolation. Returns null if no texture/UVs.
 */
function sampleTriangle(
  mesh: PreparedMesh,
  faceIdx: number,
  closest: { x: number; y: number; z: number },
  positions: Float32Array,
  indices: Uint32Array,
): readonly [number, number, number] | null {
  if (!mesh.texture || !mesh.uvs) {
    return mesh.baseColor;
  }
  const ia = indices[faceIdx * 3] * 3;
  const ib = indices[faceIdx * 3 + 1] * 3;
  const ic = indices[faceIdx * 3 + 2] * 3;
  // Barycentric coordinates of `closest` in triangle (a,b,c)
  const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
  const bx = positions[ib], by = positions[ib + 1], bz = positions[ib + 2];
  const cx = positions[ic], cy = positions[ic + 1], cz = positions[ic + 2];
  // Compute triangle area-based barycentric
  const v0x = bx - ax, v0y = by - ay, v0z = bz - az;
  const v1x = cx - ax, v1y = cy - ay, v1z = cz - az;
  const v2x = closest.x - ax, v2y = closest.y - ay, v2z = closest.z - az;
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z;
  const d01 = v0x * v1x + v0y * v1y + v0z * v1z;
  const d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z;
  const d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-12) return mesh.baseColor;
  const v = (d11 * d20 - d01 * d21) / denom;
  const w = (d00 * d21 - d01 * d20) / denom;
  const u = 1 - v - w;
  // UV interpolation
  const uvA = mesh.uvs[indices[faceIdx * 3] * 2];
  const uvAv = mesh.uvs[indices[faceIdx * 3] * 2 + 1];
  const uvB = mesh.uvs[indices[faceIdx * 3 + 1] * 2];
  const uvBv = mesh.uvs[indices[faceIdx * 3 + 1] * 2 + 1];
  const uvC = mesh.uvs[indices[faceIdx * 3 + 2] * 2];
  const uvCv = mesh.uvs[indices[faceIdx * 3 + 2] * 2 + 1];
  let texU = u * uvA + v * uvB + w * uvC;
  let texV = u * uvAv + v * uvBv + w * uvCv;
  // Wrap (textures repeat in Google 3D Tiles photogrammetry style)
  texU = texU - Math.floor(texU);
  texV = texV - Math.floor(texV);
  // glTF UV convention: V flipped vs image y
  texV = 1 - texV;
  const tex = mesh.texture;
  const px = Math.min(tex.width - 1, Math.max(0, Math.floor(texU * tex.width)));
  const py = Math.min(tex.height - 1, Math.max(0, Math.floor(texV * tex.height)));
  const idx = (py * tex.width + px) * 4;
  return [tex.pixels[idx], tex.pixels[idx + 1], tex.pixels[idx + 2]];
}

/**
 * Re-color the grid using photogrammetry textures. Mutates `grid` in
 * place. Skips voxels labeled as overlay materials (windows, plinth,
 * cornice, roof) so the architectural detail layer stays intact.
 */
export async function recolorFromPhotogrammetry(
  grid: BlockGrid,
  primitives: ReadonlyArray<FullMeshPrimitive>,
  opts: RecolorOptions,
  preserveBlocks: ReadonlySet<string>,
): Promise<{ replaced: number; skipped: number }> {
  if (primitives.length === 0) return { replaced: 0, skipped: 0 };
  const maxDist = opts.maxDistanceM ?? 2.0;
  const meshes: PreparedMesh[] = [];
  for (const prim of primitives) {
    if (prim.positions.length === 0) continue;
    meshes.push(await prepareMesh(prim));
  }
  if (meshes.length === 0) return { replaced: 0, skipped: 0 };

  const tmpClosestPoint = new THREE.Vector3();
  const tmpQueryPoint = new THREE.Vector3();
  const closestTarget: { point: THREE.Vector3; distance: number; faceIndex: number } = {
    point: new THREE.Vector3(),
    distance: Infinity,
    faceIndex: 0,
  };

  const { width: W, height: H, length: L } = grid;
  const AIR = 'minecraft:air';
  let replaced = 0;
  let skipped = 0;

  for (let y = 0; y < H; y++) {
    if (opts.onProgress) opts.onProgress(y / H);
    // Map grid-Y (already integer voxel index) to photogrammetry-Y
    const worldGridY = opts.originY + (y + 0.5) / opts.resolution;
    const worldPgY = (worldGridY / opts.yScale) + opts.yShift;
    for (let z = 0; z < L; z++) {
      const worldZ = opts.originZ + (z + 0.5) / opts.resolution;
      for (let x = 0; x < W; x++) {
        const block = grid.get(x, y, z);
        if (block === AIR) continue;
        if (preserveBlocks.has(block)) {
          skipped++;
          continue;
        }
        const worldX = opts.originX + (x + 0.5) / opts.resolution;
        tmpQueryPoint.set(worldX, worldPgY, worldZ);

        // Find closest photogrammetry triangle across all meshes
        let bestDist = Infinity;
        let bestColor: readonly [number, number, number] | null = null;
        for (const m of meshes) {
          // Quick bbox reject
          const bbox = m.geometry.boundingBox;
          if (!bbox) continue;
          if (worldX < bbox.min.x - maxDist || worldX > bbox.max.x + maxDist) continue;
          if (worldZ < bbox.min.z - maxDist || worldZ > bbox.max.z + maxDist) continue;
          if (worldPgY < bbox.min.y - maxDist || worldPgY > bbox.max.y + maxDist) continue;
          closestTarget.distance = Infinity;
          const result = m.bvh.closestPointToPoint(tmpQueryPoint, closestTarget, 0, Math.min(maxDist, bestDist));
          if (result && result.distance < bestDist) {
            tmpClosestPoint.copy(result.point);
            const colour = sampleTriangle(
              m,
              result.faceIndex,
              { x: tmpClosestPoint.x, y: tmpClosestPoint.y, z: tmpClosestPoint.z },
              m.geometry.getAttribute('position').array as Float32Array,
              m.geometry.index!.array as unknown as Uint32Array,
            );
            if (colour) {
              bestDist = result.distance;
              bestColor = colour;
            }
          }
        }

        if (bestColor) {
          const newBlock = rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], x, y, z);
          if (newBlock !== block) {
            grid.set(x, y, z, newBlock);
            replaced++;
          }
        }
      }
    }
  }

  if (opts.onProgress) opts.onProgress(1);
  return { replaced, skipped };
}
