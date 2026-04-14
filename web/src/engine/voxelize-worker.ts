/**
 * Web Worker for mesh voxelization — runs BVH construction + surface/solid
 * voxelization entirely off the main thread to prevent UI freezing.
 *
 * Receives serialized mesh data (geometry buffers, texture pixels, matrices),
 * reconstructs Three.js objects, builds BVH, voxelizes, and posts back
 * progress updates + final grid data (palette-indexed Uint16Array).
 *
 * Imports Three.js, three-mesh-bvh, and color-blocks — all pure computation,
 * no DOM dependencies.
 */

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { rgbToWallBlock } from '@craft/gen/color-blocks.js';
import { VEGETATION_BLOCKS } from '@craft/convert/voxelizer.js';
import type { RGB } from '@craft/types/index.js';

// ─── Message types ───────────────────────────────────────────────────────────

/** Serialized mesh data from main thread (all transferable ArrayBuffers) */
export interface SerializedMesh {
  position: Float32Array;
  index: Uint16Array | Uint32Array | null;
  uv: Float32Array | null;
  normal: Float32Array | null;
  materialColor: [number, number, number];
  textureData: Uint8ClampedArray | null;
  textureWidth: number;
  textureHeight: number;
  matrixWorld: number[]; // 16 floats
}

export interface WorkerInput {
  meshes: SerializedMesh[];
  boxMin: [number, number, number];
  boxMax: [number, number, number];
  resolution: number;
  mode: 'solid' | 'surface';
  maxDimension: number;
  filterVegetation: boolean;
}

export interface WorkerProgress {
  type: 'progress';
  progress: number;
  currentY: number;
  totalY: number;
  phase: 'bvh' | 'voxelize';
  message?: string;
}

export interface WorkerResult {
  type: 'result';
  /** Palette-indexed block data (index 0 = air) */
  blocks: Uint16Array;
  /** Reverse palette: index → block state string */
  palette: string[];
  width: number;
  height: number;
  length: number;
}

export interface WorkerError {
  type: 'error';
  message: string;
}

export type WorkerOutput = WorkerProgress | WorkerResult | WorkerError;

// ─── Geometry types ──────────────────────────────────────────────────────────

interface BVHGeometry extends THREE.BufferGeometry {
  boundsTree?: MeshBVH;
}

interface MeshBVHExt extends MeshBVH {
  closestPointToPoint(
    point: THREE.Vector3,
    target: { point: THREE.Vector3; distance: number; faceIndex: number },
    minThreshold?: number,
    maxThreshold?: number,
  ): { point: THREE.Vector3; distance: number; faceIndex: number } | null;
}

interface MeshEntry {
  geometry: BVHGeometry;
  materialColor: [number, number, number];
  textureData: Uint8ClampedArray | null;
  textureWidth: number;
  textureHeight: number;
  inverseMatrix: THREE.Matrix4;
  worldMatrix: THREE.Matrix4;
}

// ─── Raw pixel texture sampler ───────────────────────────────────────────────

/** Sample raw RGBA pixel data at UV coordinates with 5-point median filter */
function sampleRawTexture(
  data: Uint8ClampedArray, w: number, h: number, u: number, v: number,
): RGB {
  const uu = ((u % 1) + 1) % 1;
  const vv = ((v % 1) + 1) % 1;
  const cx = Math.floor(uu * (w - 1));
  const cy = Math.floor((1 - vv) * (h - 1)); // UV y is flipped vs pixel y

  const offsets: Array<[number, number]> = [
    [0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1],
  ];
  const samples: Array<[number, number, number, number]> = [];
  for (const [dx, dy] of offsets) {
    const sx = Math.min(w - 1, Math.max(0, cx + dx));
    const sy = Math.min(h - 1, Math.max(0, cy + dy));
    const idx = (sy * w + sx) * 4;
    const r = data[idx], g = data[idx + 1], b = data[idx + 2];
    const lum = (r * 77 + g * 150 + b * 29) >> 8;
    samples.push([r, g, b, lum]);
  }
  samples.sort((a, b) => a[3] - b[3]);
  const median = samples[2];
  return [median[0], median[1], median[2]];
}

// ─── Surface color sampling ──────────────────────────────────────────────────

const _triA = new THREE.Vector3();
const _triB = new THREE.Vector3();
const _triC = new THREE.Vector3();
const _baryOut = new THREE.Vector3();
const _uv0 = new THREE.Vector2();
const _uv1 = new THREE.Vector2();
const _uv2 = new THREE.Vector2();

function computeBarycentric(
  p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3,
  out: THREE.Vector3,
): void {
  const v0 = new THREE.Vector3().subVectors(b, a);
  const v1 = new THREE.Vector3().subVectors(c, a);
  const v2 = new THREE.Vector3().subVectors(p, a);
  const d00 = v0.dot(v0);
  const d01 = v0.dot(v1);
  const d11 = v1.dot(v1);
  const d20 = v2.dot(v0);
  const d21 = v2.dot(v1);
  const denom = d00 * d11 - d01 * d01;
  if (Math.abs(denom) < 1e-10) { out.set(1, 0, 0); return; }
  const bv = (d11 * d20 - d01 * d21) / denom;
  const bw = (d00 * d21 - d01 * d20) / denom;
  out.set(1 - bv - bw, bv, bw);
}

function sampleColorAtSurfacePoint(
  entry: MeshEntry,
  faceIndex: number,
  closestPoint: THREE.Vector3,
): RGB {
  const geo = entry.geometry;
  if (entry.textureData && entry.textureWidth > 0) {
    const uvAttr = geo.getAttribute('uv') as THREE.BufferAttribute | null;
    if (uvAttr) {
      const index = geo.index;
      const i0 = index ? index.getX(faceIndex * 3) : faceIndex * 3;
      const i1 = index ? index.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
      const i2 = index ? index.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;

      const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
      _triA.fromBufferAttribute(posAttr, i0);
      _triB.fromBufferAttribute(posAttr, i1);
      _triC.fromBufferAttribute(posAttr, i2);
      computeBarycentric(closestPoint, _triA, _triB, _triC, _baryOut);

      _uv0.fromBufferAttribute(uvAttr, i0);
      _uv1.fromBufferAttribute(uvAttr, i1);
      _uv2.fromBufferAttribute(uvAttr, i2);

      const u = _uv0.x * _baryOut.x + _uv1.x * _baryOut.y + _uv2.x * _baryOut.z;
      const v = _uv0.y * _baryOut.x + _uv1.y * _baryOut.y + _uv2.y * _baryOut.z;
      return sampleRawTexture(
        entry.textureData, entry.textureWidth, entry.textureHeight, u, v,
      );
    }
  }

  // Fallback to material base color
  const [r, g, b] = entry.materialColor;
  return [r, g, b];
}

// ─── Reconstruct meshes from serialized data ─────────────────────────────────

function deserializeMeshes(serialized: SerializedMesh[]): MeshEntry[] {
  return serialized.map((s) => {
    const geo = new THREE.BufferGeometry() as BVHGeometry;
    geo.setAttribute('position', new THREE.BufferAttribute(s.position, 3));
    if (s.index) {
      geo.setIndex(new THREE.BufferAttribute(s.index, 1));
    }
    if (s.uv) {
      geo.setAttribute('uv', new THREE.BufferAttribute(s.uv, 2));
    }
    if (s.normal) {
      geo.setAttribute('normal', new THREE.BufferAttribute(s.normal, 3));
    }

    const worldMatrix = new THREE.Matrix4();
    worldMatrix.fromArray(s.matrixWorld);
    const inverseMatrix = new THREE.Matrix4();
    inverseMatrix.copy(worldMatrix).invert();

    return {
      geometry: geo,
      materialColor: s.materialColor,
      textureData: s.textureData,
      textureWidth: s.textureWidth,
      textureHeight: s.textureHeight,
      inverseMatrix,
      worldMatrix,
    };
  });
}

// ─── Grid AABB helpers (same as voxelizer.ts) ────────────────────────────────

interface GridAABB {
  yMin: number; yMax: number;
  zMin: number; zMax: number;
  xMin: number; xMax: number;
}

function computeMeshWorldBounds(entries: MeshEntry[], broadThreshold: number): THREE.Box3[] {
  return entries.map((e) => {
    e.geometry.computeBoundingBox();
    const bbox = e.geometry.boundingBox!.clone();
    bbox.applyMatrix4(e.worldMatrix);
    bbox.expandByScalar(broadThreshold);
    return bbox;
  });
}

function computeGridAABBs(
  meshBounds: THREE.Box3[], box: THREE.Box3, resolution: number,
  broadThreshold: number, width: number, height: number, length: number,
): GridAABB[] {
  return meshBounds.map((mBox) => {
    const expanded = mBox.clone().expandByScalar(broadThreshold);
    return {
      yMin: Math.max(0, Math.floor((expanded.min.y - box.min.y) * resolution)),
      yMax: Math.min(height - 1, Math.ceil((expanded.max.y - box.min.y) * resolution)),
      zMin: Math.max(0, Math.floor((expanded.min.z - box.min.z) * resolution)),
      zMax: Math.min(length - 1, Math.ceil((expanded.max.z - box.min.z) * resolution)),
      xMin: Math.max(0, Math.floor((expanded.min.x - box.min.x) * resolution)),
      xMax: Math.min(width - 1, Math.ceil((expanded.max.x - box.min.x) * resolution)),
    };
  });
}

function computeActiveSlabs(
  gridAABBs: GridAABB[], height: number, length: number, width: number,
): { zMin: Int32Array; zMax: Int32Array; xMin: Int32Array; xMax: Int32Array } {
  const zMin = new Int32Array(height).fill(length);
  const zMax = new Int32Array(height).fill(-1);
  const xMin = new Int32Array(height).fill(width);
  const xMax = new Int32Array(height).fill(-1);
  for (const aabb of gridAABBs) {
    for (let y = aabb.yMin; y <= aabb.yMax; y++) {
      if (aabb.zMin < zMin[y]) zMin[y] = aabb.zMin;
      if (aabb.zMax > zMax[y]) zMax[y] = aabb.zMax;
      if (aabb.xMin < xMin[y]) xMin[y] = aabb.xMin;
      if (aabb.xMax > xMax[y]) xMax[y] = aabb.xMax;
    }
  }
  return { zMin, zMax, xMin, xMax };
}

// ─── Voxelization core ───────────────────────────────────────────────────────

function voxelizeSurface(
  input: WorkerInput,
  entries: MeshEntry[],
): WorkerResult {
  const box = new THREE.Box3(
    new THREE.Vector3(...input.boxMin),
    new THREE.Vector3(...input.boxMax),
  );
  const size = new THREE.Vector3();
  box.getSize(size);

  let width = Math.ceil(size.x * input.resolution);
  let height = Math.ceil(size.y * input.resolution);
  let length = Math.ceil(size.z * input.resolution);

  // Enforce maxDimension cap
  if (input.maxDimension > 0) {
    const largest = Math.max(width, height, length);
    if (largest > input.maxDimension) {
      const scale = input.maxDimension / largest;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      length = Math.max(1, Math.round(length * scale));
    }
  }

  const resolution = input.resolution;
  const totalVoxels = width * height * length;
  const blocks = new Uint16Array(totalVoxels); // 0 = air
  const palette: string[] = ['minecraft:air']; // index 0 = air
  const paletteMap = new Map<string, number>([['minecraft:air', 0]]);
  let nextId = 1;

  function getPaletteId(block: string): number {
    let id = paletteMap.get(block);
    if (id === undefined) {
      id = nextId++;
      paletteMap.set(block, id);
      palette[id] = block;
    }
    return id;
  }

  const baseThreshold = 0.75 / resolution;
  const broadThreshold = baseThreshold * 1.5;

  // Compute mesh bounds and grid AABBs
  const meshBounds = computeMeshWorldBounds(entries, broadThreshold);
  const gridAABBs = computeGridAABBs(meshBounds, box, resolution, broadThreshold, width, height, length);
  const slabs = computeActiveSlabs(gridAABBs, height, length, width);

  // Pre-compute per-Y-layer active mesh indices
  const activeMeshesPerY: number[][] = [];
  for (let y = 0; y < height; y++) {
    const worldYMin = box.min.y + y / resolution;
    const worldYMax = box.min.y + (y + 1) / resolution;
    const active: number[] = [];
    for (let m = 0; m < entries.length; m++) {
      if (meshBounds[m].min.y <= worldYMax + broadThreshold &&
          meshBounds[m].max.y >= worldYMin - broadThreshold) {
        active.push(m);
      }
    }
    activeMeshesPerY.push(active);
  }

  // Reusable objects
  const localPoint = new THREE.Vector3();
  const closestTarget = { point: new THREE.Vector3(), distance: Infinity, faceIndex: 0 };
  const worldPos = new THREE.Vector3();

  for (let y = 0; y < height; y++) {
    // Report progress: voxelize phase is 0.2 → 1.0
    if (y % 2 === 0) {
      self.postMessage({
        type: 'progress',
        progress: 0.2 + (y / height) * 0.8,
        currentY: y,
        totalY: height,
        phase: 'voxelize',
      } satisfies WorkerProgress);
    }

    if (slabs.zMin[y] > slabs.zMax[y]) continue;

    const activeZMin = slabs.zMin[y];
    const activeZMax = slabs.zMax[y];
    const activeXMin = slabs.xMin[y];
    const activeXMax = slabs.xMax[y];
    const layerMeshes = activeMeshesPerY[y];

    for (let z = activeZMin; z <= activeZMax; z++) {
      for (let x = activeXMin; x <= activeXMax; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;
        worldPos.set(worldX, worldY, worldZ);

        let bestDist = Infinity;
        let bestColor: RGB | null = null;

        for (let mi = 0; mi < layerMeshes.length; mi++) {
          const m = layerMeshes[mi];
          if (!meshBounds[m].containsPoint(worldPos)) continue;

          const entry = entries[m];
          const geo = entry.geometry;
          if (!geo.boundsTree) continue;

          localPoint.set(worldX, worldY, worldZ);
          localPoint.applyMatrix4(entry.inverseMatrix);

          closestTarget.distance = Infinity;
          const result = (geo.boundsTree as MeshBVHExt).closestPointToPoint(
            localPoint, closestTarget, 0, Math.min(broadThreshold, bestDist),
          );

          if (result && result.distance < broadThreshold && result.distance < bestDist) {
            bestDist = result.distance;
            bestColor = sampleColorAtSurfacePoint(entry, result.faceIndex, result.point);
          }
        }

        if (bestColor) {
          const block = rgbToWallBlock(bestColor[0], bestColor[1], bestColor[2], x, y, z);
          if (!input.filterVegetation || !VEGETATION_BLOCKS.has(block)) {
            const idx = (y * length + z) * width + x;
            blocks[idx] = getPaletteId(block);
          }
        }
      }
    }
  }

  return { type: 'result', blocks, palette, width, height, length };
}

// ─── Solid mode (raycasting odd-even test) ───────────────────────────────────

function voxelizeSolid(
  input: WorkerInput,
  entries: MeshEntry[],
): WorkerResult {
  const box = new THREE.Box3(
    new THREE.Vector3(...input.boxMin),
    new THREE.Vector3(...input.boxMax),
  );
  const size = new THREE.Vector3();
  box.getSize(size);

  let width = Math.ceil(size.x * input.resolution);
  let height = Math.ceil(size.y * input.resolution);
  let length = Math.ceil(size.z * input.resolution);

  if (input.maxDimension > 0) {
    const largest = Math.max(width, height, length);
    if (largest > input.maxDimension) {
      const scale = input.maxDimension / largest;
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      length = Math.max(1, Math.round(length * scale));
    }
  }

  const resolution = input.resolution;
  const totalVoxels = width * height * length;
  const blocks = new Uint16Array(totalVoxels);
  const palette: string[] = ['minecraft:air'];
  const paletteMap = new Map<string, number>([['minecraft:air', 0]]);
  let nextId = 1;

  function getPaletteId(block: string): number {
    let id = paletteMap.get(block);
    if (id === undefined) {
      id = nextId++;
      paletteMap.set(block, id);
      palette[id] = block;
    }
    return id;
  }

  // Build THREE.Mesh objects for raycasting (solid mode needs intersectObject)
  const meshObjects: Array<{ mesh: THREE.Mesh; entry: MeshEntry }> = entries.map((e) => {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(
      e.materialColor[0] / 255, e.materialColor[1] / 255, e.materialColor[2] / 255,
    ) });
    const mesh = new THREE.Mesh(e.geometry, mat);
    mesh.matrixWorld.copy(e.worldMatrix);
    mesh.matrixAutoUpdate = false;
    return { mesh, entry: e };
  });

  const raycaster = new THREE.Raycaster();
  const directions = [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 1),
  ];

  for (let y = 0; y < height; y++) {
    if (y % 2 === 0) {
      self.postMessage({
        type: 'progress',
        progress: 0.2 + (y / height) * 0.8,
        currentY: y,
        totalY: height,
        phase: 'voxelize',
      } satisfies WorkerProgress);
    }

    for (let z = 0; z < length; z++) {
      for (let x = 0; x < width; x++) {
        const worldX = box.min.x + (x + 0.5) / resolution;
        const worldY = box.min.y + (y + 0.5) / resolution;
        const worldZ = box.min.z + (z + 0.5) / resolution;
        const point = new THREE.Vector3(worldX, worldY, worldZ);

        let hitColor: RGB | null = null;
        for (const dir of directions) {
          if (hitColor) break;
          const origin = point.clone().sub(dir.clone().multiplyScalar(1000));
          raycaster.set(origin, dir);

          for (const { mesh, entry } of meshObjects) {
            const intersections = raycaster.intersectObject(mesh);
            if (intersections.length > 0) {
              const dist = origin.distanceTo(point);
              const before = intersections.filter((i) => i.distance < dist);
              if (before.length % 2 === 1) {
                const lastHit = intersections[before.length - 1];
                if (entry.textureData && lastHit.uv) {
                  hitColor = sampleRawTexture(
                    entry.textureData, entry.textureWidth, entry.textureHeight,
                    lastHit.uv.x, lastHit.uv.y,
                  );
                } else {
                  hitColor = entry.materialColor;
                }
                break;
              }
            }
          }
        }

        if (hitColor) {
          const block = rgbToWallBlock(hitColor[0], hitColor[1], hitColor[2], x, y, z);
          const idx = (y * length + z) * width + x;
          blocks[idx] = getPaletteId(block);
        }
      }
    }
  }

  return { type: 'result', blocks, palette, width, height, length };
}

// ─── Worker message handler ──────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerInput>) => {
  try {
    const input = event.data;
    const entries = deserializeMeshes(input.meshes);

    // Build BVH for each mesh (report progress in 0 → 0.2 range)
    for (let i = 0; i < entries.length; i++) {
      self.postMessage({
        type: 'progress',
        progress: (i / entries.length) * 0.2,
        currentY: 0,
        totalY: 0,
        phase: 'bvh',
        message: `Building BVH ${i + 1}/${entries.length}`,
      } satisfies WorkerProgress);

      const geo = entries[i].geometry;
      if (!geo.boundsTree) {
        geo.boundsTree = new MeshBVH(geo as never);
      }
    }

    // Run voxelization
    let result: WorkerResult;
    if (input.mode === 'surface') {
      result = voxelizeSurface(input, entries);
    } else {
      result = voxelizeSolid(input, entries);
    }

    // Transfer the blocks buffer for zero-copy
    self.postMessage(result, [result.blocks.buffer]);
  } catch (err) {
    self.postMessage({
      type: 'error',
      message: String(err),
    } satisfies WorkerError);
  }
};
