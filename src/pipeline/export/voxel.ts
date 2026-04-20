/**
 * Stage 8c — voxel export.
 *
 * Converts a `BuildingBRep` into a Minecraft `BlockGrid` via the existing
 * `voxelizer.ts`. The BRep is evaluated via manifold-3d into a triangle mesh,
 * wrapped in a Three.js `Mesh`, and handed to `threeToGrid` with the
 * block-name hints from `brep.materials`.
 *
 * Uses 'surface' voxelization mode so the output is a hollow shell rather
 * than a fully-filled solid. For a 150m skyscraper, solid fill produces
 * ~700K voxels (vastly exceeding the objective voxelCount gate); surface
 * mode produces ~50-100K, appropriate for a Minecraft build.
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
  const mat = new THREE.MeshStandardMaterial();
  // Assign the sRGB-hex components DIRECTLY without Three.js's automatic
  // sRGB→linear colour-space conversion. `new MeshStandardMaterial({ color:
  // 0xRRGGBB })` treats the hex as sRGB and silently converts to linear for
  // rendering — but the voxelizer reads material.color.r/g/b back as
  // Math.round(c.r * 255), expecting sRGB 0-255. Without this override, a
  // wall Lab of (73.6, -0.3, 3.5) ≈ sRGB(181,178,179) becomes linear(118,114,115)
  // at voxel-time, which `rgbToWallBlock` maps to light_gray_concrete instead
  // of the intended smooth_stone — turning every building a uniform dull
  // grey regardless of real colour.
  const r = ((baseColorHex >> 16) & 0xff) / 255;
  const g = ((baseColorHex >> 8) & 0xff) / 255;
  const b = (baseColorHex & 0xff) / 255;
  mat.color.r = r;
  mat.color.g = g;
  mat.color.b = b;
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
    mode: opts.mode ?? 'surface',
    maxDimension: opts.maxDimension ?? 256,
  });

  // Post-process: the voxelizer outputs a single-material surface shell
  // based on the wall color. Re-label the top N layers as roof blocks
  // and punch vertical window stripes on the long facades so the output
  // isn't a monochrome featureless prism.
  const wallBlock = brep.materials.wall.blockName;
  const roofBlock = brep.materials.roof.blockName;
  const windowBlock = brep.materials.window.blockName;
  applyMaterialOverlay(grid, wallBlock, roofBlock, windowBlock);

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
    wallBlock,
    roofBlock,
  };
}

/**
 * Post-voxelization material pass. The voxelizer has already painted every
 * solid voxel with the wall block (derived from the mesh colour). We now:
 *
 *   1. Find the top solid voxel per (x,z) column. That voxel plus any
 *      solid voxels within `roofDepth` of it become roof blocks.
 *      `roofDepth` scales with grid height (≈5% of height, min 1).
 *   2. Compute vertical window stripes: for each x-column with a non-empty
 *      solid run, identify wall voxels (those not already flipped to roof)
 *      and replace every `spacing`-th voxel with the window block. Applies
 *      only to voxels that border air on the X face (outer wall), so
 *      interior voxels remain wall-block.
 *
 * Both transforms are idempotent when run a second time because they key
 * off the current block identity.
 */
function applyMaterialOverlay(
  grid: BlockGrid,
  wallBlock: string,
  roofBlock: string,
  windowBlock: string,
): void {
  const { width: W, height: H, length: L } = grid;
  const roofDepth = Math.max(1, Math.round(H * 0.05));

  // Pass 1 — roof re-labeling
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < L; z++) {
      // Find topmost non-air voxel in this column
      let topY = -1;
      for (let y = H - 1; y >= 0; y--) {
        if (grid.get(x, y, z) !== 'minecraft:air') { topY = y; break; }
      }
      if (topY < 0) continue;
      for (let dy = 0; dy < roofDepth && topY - dy >= 0; dy++) {
        const y = topY - dy;
        if (grid.get(x, y, z) !== 'minecraft:air') {
          grid.set(x, y, z, roofBlock);
        }
      }
    }
  }

  // Pass 2 — window stripes. Walk long-edge columns; replace outer-face
  // wall voxels on a periodic grid. Skip the bottom ground band and the
  // top roof band; skip solar-side-only sampling since the BRep mesh
  // isn't orientation-aware at this stage.
  const stripeSpacingX = Math.max(2, Math.round(W * 0.08));
  const stripeSpacingZ = Math.max(2, Math.round(L * 0.08));
  const winVStep = 4; // one window per ~4 blocks of height
  const groundBand = 2; // skip bottom 2 rows (street level)
  for (let y = groundBand; y < H - roofDepth; y++) {
    if ((y - groundBand) % winVStep !== 1) continue; // window band every 4th row
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < L; z++) {
        const b = grid.get(x, y, z);
        if (b !== wallBlock) continue; // don't overwrite roof / air
        // Outer-face check: must border air on at least one of +/- X or Z
        const facing =
          (x > 0 && grid.get(x - 1, y, z) === 'minecraft:air') ||
          (x < W - 1 && grid.get(x + 1, y, z) === 'minecraft:air') ||
          (z > 0 && grid.get(x, y, z - 1) === 'minecraft:air') ||
          (z < L - 1 && grid.get(x, y, z + 1) === 'minecraft:air');
        if (!facing) continue;
        // Stripe pattern — every N-th voxel along x AND z axes
        if (x % stripeSpacingX === Math.floor(stripeSpacingX / 2) ||
            z % stripeSpacingZ === Math.floor(stripeSpacingZ / 2)) {
          grid.set(x, y, z, windowBlock);
        }
      }
    }
  }
}
