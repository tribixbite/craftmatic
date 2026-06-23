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
  /**
   * Per-band colour clustering (Lab k-means). When > 1, the recolor
   * pass collects samples first, runs k-means per Y band of
   * `bandHeightM` metres, and snaps every voxel to its band's nearest
   * cluster centroid before block assignment. Removes JPEG noise +
   * photogrammetry artifacts that produce splotchy patches in the
   * naive per-voxel path. Default 3 clusters / 5m bands.
   */
  readonly clustersPerBand?: number;
  readonly bandHeightM?: number;
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

// Minimal structural types for the browser image-decode globals. The CLI
// tsconfig has lib:["ES2022"] (no DOM), so we can't reference the DOM
// `createImageBitmap`/`OffscreenCanvas` types directly. These cover only
// the members `decodePngBrowser` uses, accessed via `globalThis`.
interface BrowserBitmap { readonly width: number; readonly height: number; close(): void; }
interface BrowserImageData { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray; }
interface BrowserCanvasCtx {
  drawImage(img: BrowserBitmap, dx: number, dy: number): void;
  getImageData(x: number, y: number, w: number, h: number): BrowserImageData;
}
interface BrowserCanvas { getContext(id: '2d'): BrowserCanvasCtx | null; }
interface BrowserImageGlobals {
  createImageBitmap?: (blob: unknown) => Promise<BrowserBitmap>;
  OffscreenCanvas?: new (w: number, h: number) => BrowserCanvas;
}

/**
 * True when a real browser image-decode pipeline is available
 * (`createImageBitmap` + `OffscreenCanvas`). The headless Node/Bun CLI
 * polyfills `createImageBitmap` to return a STUB ImageBitmap (no pixels),
 * so we additionally require `OffscreenCanvas`, which the polyfill does
 * not provide — distinguishing a real browser (main thread or worker)
 * from the stubbed Node environment.
 */
function browserImageGlobals(): Required<BrowserImageGlobals> | null {
  const g = globalThis as unknown as BrowserImageGlobals;
  if (typeof g.createImageBitmap === 'function' && typeof g.OffscreenCanvas === 'function') {
    return { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
  }
  return null;
}

/**
 * Decode a PNG byte buffer into RGBA pixels via the browser's
 * `createImageBitmap` + `OffscreenCanvas` (same approach as
 * `web/src/ui/browser-fetchers.ts`). Returns null on failure.
 */
async function decodePngBrowser(
  bytes: Uint8Array,
  g: Required<BrowserImageGlobals>,
): Promise<DecodedTexture | null> {
  try {
    const blob = new Blob([bytes], { type: 'image/png' });
    const bitmap = await g.createImageBitmap(blob);
    const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: img.width, height: img.height, pixels: new Uint8Array(img.data.buffer) };
  } catch {
    return null;
  }
}

/**
 * Specifier for the Node-only PNG decoder leaf, assembled at runtime so
 * vite's static import analyser cannot resolve the literal path. A bare
 * `import('./png-decode-node.js')` (even with `@vite-ignore`) is still
 * followed by rollup and would pull `node:stream` into the browser graph,
 * producing an externalization warning. Concatenating the path defeats
 * that static analysis: the browser never reaches this branch, and Node
 * resolves the relative specifier at runtime.
 */
const PNG_NODE_DECODER = './png-decode' + '-node.js';

/**
 * Decode a JPEG/PNG texture image into RGBA pixels. JPEG uses jpeg-js
 * (pure JS, works everywhere). PNG uses the browser canvas decoder when
 * available, otherwise falls back to the Node-only `png-decode-node.ts`
 * leaf (pureimage + node:stream).
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
  // PNG: prefer the browser canvas decoder; never touch node:stream there.
  const browserGlobals = browserImageGlobals();
  if (browserGlobals) {
    return decodePngBrowser(bytes, browserGlobals);
  }
  // Node/Bun fallback. The runtime-assembled specifier + @vite-ignore keep
  // the node:stream-importing leaf out of the browser bundle entirely (so
  // no externalization warning). See `png-decode-node.ts`.
  const mod = await import(/* @vite-ignore */ PNG_NODE_DECODER) as typeof import('./png-decode-node.js');
  return mod.decodePngNode(bytes);
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
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  const tmpAB = new THREE.Vector3();
  const tmpAC = new THREE.Vector3();
  const tmpNormal = new THREE.Vector3();
  const tmpToVoxel = new THREE.Vector3();

  // Building XZ centroid — used to determine "outward" direction from
  // each voxel. Voxels should sample the photogrammetry triangle whose
  // surface normal points OUTWARD (away from building centre), not
  // inward-facing back-of-building triangles or interior scaffolding.
  let cX = 0, cZ = 0, cN = 0;
  for (const m of meshes) {
    const bb = m.geometry.boundingBox;
    if (!bb) continue;
    cX += (bb.min.x + bb.max.x) / 2;
    cZ += (bb.min.z + bb.max.z) / 2;
    cN++;
  }
  if (cN > 0) { cX /= cN; cZ /= cN; }

  const { width: W, height: H, length: L } = grid;
  const AIR = 'minecraft:air';
  const clustersPerBand = Math.max(1, opts.clustersPerBand ?? 3);
  const bandHeightM = Math.max(1, opts.bandHeightM ?? 5);
  const bandRows = Math.max(1, Math.round(bandHeightM * opts.resolution));

  // Per-voxel sampled colour (RGB packed as Uint32 0xRRGGBB | 0x80000000 for
  // "filled"). Allocated as Int32Array so we can use -1 as sentinel.
  const sampledRGB = new Int32Array(W * H * L);
  sampledRGB.fill(-1);
  let skipped = 0;
  let sampled = 0;

  // ─── Pass 1: collect colour samples per voxel ────────────────────────────
  for (let y = 0; y < H; y++) {
    if (opts.onProgress) opts.onProgress((y / H) * 0.6);
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

        let bestDist = Infinity;
        let bestColor: readonly [number, number, number] | null = null;
        for (const m of meshes) {
          const bbox = m.geometry.boundingBox;
          if (!bbox) continue;
          if (worldX < bbox.min.x - maxDist || worldX > bbox.max.x + maxDist) continue;
          if (worldZ < bbox.min.z - maxDist || worldZ > bbox.max.z + maxDist) continue;
          if (worldPgY < bbox.min.y - maxDist || worldPgY > bbox.max.y + maxDist) continue;
          closestTarget.distance = Infinity;
          const result = m.bvh.closestPointToPoint(tmpQueryPoint, closestTarget, 0, Math.min(maxDist, bestDist));
          if (!result || result.distance >= bestDist) continue;
          tmpClosestPoint.copy(result.point);
          const positions = m.geometry.getAttribute('position').array as Float32Array;
          const indices = m.geometry.index!.array as unknown as Uint32Array;
          const ia = indices[result.faceIndex * 3] * 3;
          const ib = indices[result.faceIndex * 3 + 1] * 3;
          const ic = indices[result.faceIndex * 3 + 2] * 3;
          tmpA.set(positions[ia], positions[ia + 1], positions[ia + 2]);
          tmpB.set(positions[ib], positions[ib + 1], positions[ib + 2]);
          tmpC.set(positions[ic], positions[ic + 1], positions[ic + 2]);
          tmpAB.subVectors(tmpB, tmpA);
          tmpAC.subVectors(tmpC, tmpA);
          tmpNormal.crossVectors(tmpAB, tmpAC).normalize();
          tmpToVoxel.set(worldX - cX, 0, worldZ - cZ);
          const dotXZ = tmpNormal.x * tmpToVoxel.x + tmpNormal.z * tmpToVoxel.z;
          const horizonDot = Math.abs(tmpNormal.x) + Math.abs(tmpNormal.z);
          if (horizonDot > 0.2 && dotXZ < 0) continue;
          const colour = sampleTriangle(
            m,
            result.faceIndex,
            { x: tmpClosestPoint.x, y: tmpClosestPoint.y, z: tmpClosestPoint.z },
            positions,
            indices,
          );
          if (colour) {
            bestDist = result.distance;
            bestColor = colour;
          }
        }

        if (bestColor) {
          const cellIdx = (y * L + z) * W + x;
          sampledRGB[cellIdx] = (bestColor[0] << 16) | (bestColor[1] << 8) | bestColor[2];
          sampled++;
        }
      }
    }
  }

  // ─── Pass 2: per-band k-means cluster + snap ─────────────────────────────
  // Group voxels by Y band (bandRows tall each), run k-means on each band's
  // collected RGB samples in CIE-Lab space, then snap each voxel's colour
  // to its band's nearest cluster centroid before block assignment. The
  // result: each band has at most `clustersPerBand` distinct materials,
  // collapsing JPEG noise + texture artifacts into clean facade colours.
  let replaced = 0;
  for (let bandStart = 0; bandStart < H; bandStart += bandRows) {
    const bandEnd = Math.min(H, bandStart + bandRows);
    const bandSamples: Array<[number, number, number]> = [];
    for (let y = bandStart; y < bandEnd; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          const cellIdx = (y * L + z) * W + x;
          const packed = sampledRGB[cellIdx];
          if (packed < 0) continue;
          const r = (packed >> 16) & 0xff;
          const g = (packed >> 8) & 0xff;
          const b = packed & 0xff;
          bandSamples.push([r, g, b]);
        }
      }
    }
    if (bandSamples.length === 0) continue;

    const centroids = clustersPerBand > 1 && bandSamples.length >= clustersPerBand
      ? kMeansLab(bandSamples, clustersPerBand)
      : [averageRGB(bandSamples)];

    for (let y = bandStart; y < bandEnd; y++) {
      for (let z = 0; z < L; z++) {
        for (let x = 0; x < W; x++) {
          const cellIdx = (y * L + z) * W + x;
          const packed = sampledRGB[cellIdx];
          if (packed < 0) continue;
          const r = (packed >> 16) & 0xff;
          const g = (packed >> 8) & 0xff;
          const b = packed & 0xff;
          const centroid = nearestCentroid([r, g, b], centroids);
          const newBlock = rgbToWallBlock(centroid[0], centroid[1], centroid[2], x, y, z);
          const block = grid.get(x, y, z);
          if (newBlock !== block) {
            grid.set(x, y, z, newBlock);
            replaced++;
          }
        }
      }
    }
    if (opts.onProgress) opts.onProgress(0.6 + 0.4 * (bandEnd / H));
  }

  if (opts.onProgress) opts.onProgress(1);
  void sampled;
  return { replaced, skipped };
}

// ─── k-means helpers ────────────────────────────────────────────────────────

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  // sRGB → linear
  const sr = r / 255, sg = g / 255, sb = b / 255;
  const lin = (c: number): number => c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
  const lr = lin(sr), lg = lin(sg), lb = lin(sb);
  // linear sRGB → XYZ (D65)
  const X = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const Y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const Z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;
  // XYZ → Lab (D65 reference white)
  const xn = X / 0.95047, yn = Y / 1.0, zn = Z / 1.08883;
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(xn), fy = f(yn), fz = f(zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function kMeansLab(samples: ReadonlyArray<readonly [number, number, number]>, k: number): Array<[number, number, number]> {
  const n = samples.length;
  if (n <= k) return samples.map(s => [s[0], s[1], s[2]]);
  // Convert to Lab once
  const labs = samples.map(s => rgbToLab(s[0], s[1], s[2]));
  // Initialise with k samples spread by Lab-distance (k-means++ style)
  const centroids: Array<[number, number, number]> = [labs[0]];
  for (let ci = 1; ci < k; ci++) {
    let bestIdx = 0, bestMinDistSq = -1;
    for (let i = 0; i < n; i++) {
      let minDistSq = Infinity;
      for (const c of centroids) {
        const d0 = labs[i][0] - c[0], d1 = labs[i][1] - c[1], d2 = labs[i][2] - c[2];
        const distSq = d0 * d0 + d1 * d1 + d2 * d2;
        if (distSq < minDistSq) minDistSq = distSq;
      }
      if (minDistSq > bestMinDistSq) {
        bestMinDistSq = minDistSq;
        bestIdx = i;
      }
    }
    centroids.push(labs[bestIdx]);
  }
  // Lloyd iterations
  const assignments = new Int32Array(n);
  for (let iter = 0; iter < 8; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bestC = 0, bestDistSq = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d0 = labs[i][0] - centroids[c][0];
        const d1 = labs[i][1] - centroids[c][1];
        const d2 = labs[i][2] - centroids[c][2];
        const distSq = d0 * d0 + d1 * d1 + d2 * d2;
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed++;
      }
    }
    if (changed === 0) break;
    for (let c = 0; c < centroids.length; c++) {
      let sl = 0, sa = 0, sb = 0, count = 0;
      for (let i = 0; i < n; i++) {
        if (assignments[i] !== c) continue;
        sl += labs[i][0]; sa += labs[i][1]; sb += labs[i][2];
        count++;
      }
      if (count > 0) centroids[c] = [sl / count, sa / count, sb / count];
    }
  }
  // Convert centroids back to RGB by averaging the original RGB samples
  // assigned to each cluster (more accurate than Lab-to-RGB inverse).
  const rgbCentroids: Array<[number, number, number]> = [];
  for (let c = 0; c < centroids.length; c++) {
    let sr = 0, sg = 0, sb = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (assignments[i] !== c) continue;
      sr += samples[i][0]; sg += samples[i][1]; sb += samples[i][2];
      count++;
    }
    if (count > 0) rgbCentroids.push([Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)]);
  }
  return rgbCentroids.length > 0 ? rgbCentroids : samples.slice(0, 1).map(s => [s[0], s[1], s[2]]);
}

function nearestCentroid(
  rgb: readonly [number, number, number],
  centroids: ReadonlyArray<readonly [number, number, number]>,
): readonly [number, number, number] {
  if (centroids.length === 1) return centroids[0];
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let bestIdx = 0, bestDistSq = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const cLab = rgbToLab(centroids[c][0], centroids[c][1], centroids[c][2]);
    const d0 = lab[0] - cLab[0], d1 = lab[1] - cLab[1], d2 = lab[2] - cLab[2];
    const distSq = d0 * d0 + d1 * d1 + d2 * d2;
    if (distSq < bestDistSq) { bestDistSq = distSq; bestIdx = c; }
  }
  return centroids[bestIdx];
}

function averageRGB(samples: ReadonlyArray<readonly [number, number, number]>): [number, number, number] {
  let r = 0, g = 0, b = 0;
  for (const s of samples) { r += s[0]; g += s[1]; b += s[2]; }
  const n = samples.length;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
