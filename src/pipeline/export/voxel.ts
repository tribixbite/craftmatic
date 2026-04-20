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
 * Post-voxelization architectural-detail pass. The voxelizer paints the
 * whole solid surface with one or two wall-block variants (depending on the
 * cluster-option pick). We re-label specific bands/patterns to produce
 * recognisable architectural features:
 *
 *   1. Roof cap — top `roofDepth` layers flip to the roof block.
 *   2. Cornice band — the 2 layers directly under the roof flip to a
 *      contrasting trim block (the roof block's companion: slab/stairs
 *      variant → a full block of the same family; else `polished_andesite`).
 *   3. Windows — 2×2-voxel rectangles at ~5-block horizontal spacing and
 *      ~4-block vertical spacing, on outer-facing voxels, in windowBlock.
 *   4. Base band — bottom 2 layers flip to a darker plinth block for
 *      street-level contrast (typical of commercial/historic buildings).
 *
 * Re-labeling targets any solid voxel (not just the literal wallBlock
 * string) so k-means cluster-option variants (e.g. both sandstone AND
 * smooth_sandstone from the same Lab cluster) both participate.
 */
function applyMaterialOverlay(
  grid: BlockGrid,
  wallBlock: string,
  roofBlock: string,
  windowBlock: string,
): void {
  const { width: W, height: H, length: L } = grid;
  const roofDepth = Math.max(1, Math.round(H * 0.05));
  // Tall buildings get a thicker cornice: 3 layers on >50m towers, 2 layers on
  // mid-rise, 0 on small residential. Historic/BeauArts towers have pronounced
  // cornice+parapet stacks that a single-voxel band fails to convey.
  const corniceBandH = H > 50 ? 3 : H > 20 ? 2 : 0;
  const baseBandH = H > 15 ? 2 : 0;
  const trimBlock = pickTrimBlock(wallBlock);
  const plinthBlock = pickPlinthBlock(wallBlock);

  const AIR = 'minecraft:air';
  const isSolid = (x: number, y: number, z: number): boolean =>
    grid.get(x, y, z) !== AIR;

  // Pass 1 — roof cap (topmost solid voxels per column)
  const topYOf: number[][] = [];
  for (let x = 0; x < W; x++) {
    topYOf[x] = [];
    for (let z = 0; z < L; z++) {
      let topY = -1;
      for (let y = H - 1; y >= 0; y--) {
        if (isSolid(x, y, z)) { topY = y; break; }
      }
      topYOf[x][z] = topY;
      if (topY < 0) continue;
      for (let dy = 0; dy < roofDepth && topY - dy >= 0; dy++) {
        if (isSolid(x, topY - dy, z)) grid.set(x, topY - dy, z, roofBlock);
      }
    }
  }

  // Pass 2 — cornice band (2 layers under the roof cap, only on outer-facing
  // voxels so the band is visible as a ring and not an interior slab).
  if (corniceBandH > 0) {
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < L; z++) {
        const topY = topYOf[x][z];
        if (topY < roofDepth + corniceBandH) continue;
        for (let dy = 0; dy < corniceBandH; dy++) {
          const y = topY - roofDepth - dy;
          if (!isOuter(grid, x, y, z, W, L)) continue;
          grid.set(x, y, z, trimBlock);
        }
      }
    }
  }

  // Pass 3 — windows. 2-wide × 2-tall rectangles, spaced every ~5 blocks
  // horizontally, every ~4 blocks vertically. Skip top (roof+cornice),
  // bottom (base), and any floor-trim rows from 3a.
  const spacingX = Math.max(3, Math.round(W * 0.15));
  const spacingZ = Math.max(3, Math.round(L * 0.15));
  const winVStep = 4;
  const yMin = baseBandH;
  const yMax = H - roofDepth - corniceBandH;
  // Single-voxel window stripes on the windowBand rows. 2-tall stamps
  // regressed color scores (+glass voxels eat wall-material texture) —
  // single-voxel windows read as regular fenestration to the VLM while
  // preserving the dominant wall material.
  for (let y = yMin; y < yMax; y++) {
    if ((y - yMin) % winVStep !== 1) continue;
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < L; z++) {
        if (!isOuter(grid, x, y, z, W, L)) continue;
        const b = grid.get(x, y, z);
        if (b === AIR || b === roofBlock || b === trimBlock || b === plinthBlock) continue;
        const onX = x % spacingX === Math.floor(spacingX / 2);
        const onZ = z % spacingZ === Math.floor(spacingZ / 2);
        if (!onX && !onZ) continue;
        grid.set(x, y, z, windowBlock);
      }
    }
  }

  // Pass 4 — base plinth
  if (baseBandH > 0) {
    for (let y = 0; y < baseBandH; y++) {
      for (let x = 0; x < W; x++) {
        for (let z = 0; z < L; z++) {
          if (!isSolid(x, y, z)) continue;
          grid.set(x, y, z, plinthBlock);
        }
      }
    }
  }

}

/** Does voxel (x,y,z) border air on at least one X or Z face? */
function isOuter(grid: BlockGrid, x: number, y: number, z: number, W: number, L: number): boolean {
  const AIR = 'minecraft:air';
  if (grid.get(x, y, z) === AIR) return false;
  return (x > 0 && grid.get(x - 1, y, z) === AIR)
      || (x < W - 1 && grid.get(x + 1, y, z) === AIR)
      || (z > 0 && grid.get(x, y, z - 1) === AIR)
      || (z < L - 1 && grid.get(x, y, z + 1) === AIR);
}

/** Trim/cornice block that visually contrasts with the wall family. */
function pickTrimBlock(wall: string): string {
  // Sandstone / limestone families → chiseled_sandstone band
  if (wall.includes('sandstone')) return 'minecraft:chiseled_sandstone';
  if (wall.includes('quartz')) return 'minecraft:chiseled_quartz_block';
  if (wall.includes('stone_brick')) return 'minecraft:chiseled_stone_bricks';
  if (wall.includes('deepslate')) return 'minecraft:chiseled_deepslate';
  if (wall.includes('nether_brick')) return 'minecraft:chiseled_nether_bricks';
  // Concrete / clay / terracotta: no chiseled variants; use polished_andesite
  // which reads as a neutral decorative band in renders.
  return 'minecraft:polished_andesite';
}

/** Street-level plinth — one tier darker than the wall. */
function pickPlinthBlock(wall: string): string {
  if (wall.includes('sandstone') || wall.includes('quartz')) return 'minecraft:smooth_stone';
  if (wall.includes('light_gray') || wall.includes('clay')) return 'minecraft:stone_bricks';
  if (wall.includes('smooth_stone')) return 'minecraft:cobblestone';
  if (wall.includes('bricks')) return 'minecraft:polished_granite';
  if (wall.includes('deepslate')) return 'minecraft:blackstone';
  return 'minecraft:cobblestone';
}
