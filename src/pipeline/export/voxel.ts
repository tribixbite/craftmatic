/**
 * Stage 8c — voxel export.
 *
 * Converts a `BuildingBRep` into a Minecraft `BlockGrid` via the existing
 * `voxelizer.ts`. The BRep is evaluated via manifold-3d into a triangle mesh,
 * wrapped in a Three.js `Mesh`, and handed to `threeToGrid` with the
 * block-name hints from `brep.materials`.
 *
 * Uses 'solid' voxelization mode since BRep output is always watertight.
 */

import * as THREE from 'three';

import { evaluateBRep, type BuildingBRep } from '../synthesis/brep.js';
import { threeToGrid, type VoxelizeMode } from '../../convert/voxelizer.js';
import { BlockGrid } from '../../schem/types.js';

export interface VoxelExportOptions {
  /** Blocks per metre. Default 1. */
  readonly resolution?: number;
  readonly mode?: VoxelizeMode;
  /** Hard cap on any grid dimension. Default 256 (Minecraft-friendly). */
  readonly maxDimension?: number;
}

export interface VoxelExportResult {
  readonly grid: BlockGrid;
  readonly blockCount: number;
  /** Dominant material block name — for logging / UI. */
  readonly wallBlock: string;
  readonly roofBlock: string;
}

/**
 * Build a Three.js Object3D from an EvaluatedMesh so the existing voxelizer
 * can consume it. Positions/indices are copied into BufferAttributes.
 *
 * Materials: one mesh → one MeshStandardMaterial whose baseColorFactor is the
 * wall material's Lab → sRGB approximation. This is good enough for the
 * voxelizer's color pipeline (which re-derives the Minecraft block per voxel
 * via CIE-Lab matching in `color-blocks.ts`).
 */
function brepMeshToObject3D(
  positions: Float32Array,
  indices: Uint32Array,
  baseColorHex: number,
): THREE.Object3D {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: baseColorHex });
  return new THREE.Mesh(geo, mat);
}

function labToHexColor(lab: readonly [number, number, number]): number {
  // Lightweight Lab → sRGB for material tinting. Voxelizer uses its own
  // palette-matching so precise colour conversion isn't critical here.
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t: number): number => t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787;
  const x = fInv(fx) * 0.95047;
  const y = fInv(fy) * 1.0;
  const z = fInv(fz) * 1.08883;
  let R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  let G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  let B = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const toS = (c: number): number => {
    if (c > 0.0031308) return 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return 12.92 * c;
  };
  R = Math.max(0, Math.min(1, toS(R)));
  G = Math.max(0, Math.min(1, toS(G)));
  B = Math.max(0, Math.min(1, toS(B)));
  return (Math.round(R * 255) << 16) | (Math.round(G * 255) << 8) | Math.round(B * 255);
}

export async function exportVoxel(
  brep: BuildingBRep,
  opts: VoxelExportOptions = {},
): Promise<VoxelExportResult> {
  const mesh = await evaluateBRep(brep);
  const colorHex = labToHexColor(brep.materials.wall.lab);
  const object = brepMeshToObject3D(mesh.positions, mesh.indices, colorHex);

  const grid = threeToGrid(object, opts.resolution ?? 1, {
    mode: opts.mode ?? 'solid',
    maxDimension: opts.maxDimension ?? 256,
  });

  // Count non-air blocks
  let blockCount = 0;
  for (let y = 0; y < grid.height; y++) {
    for (let z = 0; z < grid.length; z++) {
      for (let x = 0; x < grid.width; x++) {
        if (grid.get(x, y, z) !== 'minecraft:air') blockCount++;
      }
    }
  }

  return {
    grid,
    blockCount,
    wallBlock: brep.materials.wall.blockName,
    roofBlock: brep.materials.roof.blockName,
  };
}
