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
import { windowDimsFor } from '../synthesis/features.js';
import { threeToGrid, type VoxelizeMode } from '../../convert/voxelizer.js';
import { BlockGrid } from '../../schem/types.js';
import type { ArchType } from '../context/types.js';
import { labToHexColor } from '../color.js';

/**
 * Building evidence the architectural overlay uses to place windows at real
 * storey heights instead of a blind every-4th-row pattern. All fields
 * optional — the overlay falls back to archetype-typical estimates.
 */
export interface OverlayEvidence {
  readonly archType?: ArchType;
  /** Storey count from fused evidence (OSM building:levels etc.). */
  readonly levels?: number;
  /** Wall material L* — commercial walls darker than ~45 L* are treated as
   * curtain wall (glass-dominant facade with wall-block mullions). */
  readonly wallLabL?: number;
}

export interface VoxelExportOptions {
  /** Blocks per metre. Default 1. */
  readonly resolution?: number;
  readonly mode?: VoxelizeMode;
  /** Hard cap on any grid dimension. Default 256 (Minecraft-friendly). */
  readonly maxDimension?: number;
  /**
   * Optional photogrammetry colour-transfer pass. When provided, after
   * voxelization completes, every wall voxel is recoloured from the
   * closest photogrammetry surface point (sampled via UV+texture). The
   * caller passes:
   *   • `primitives` — full mesh primitives with UVs and texture bytes
   *   • `yScale`, `yShift` — inverse-transform from grid Y to
   *     photogrammetry Y. The synthesizer linearly scales [trueMinY,
   *     trueMaxY] → [0, expectedHeightM]; we invert that mapping here.
   */
  readonly photogrammetryRecolor?: {
    readonly primitives: ReadonlyArray<import('./glb-writer.js').FullMeshPrimitive>;
    readonly yScale: number;
    readonly yShift: number;
    readonly maxDistanceM?: number;
    readonly onProgress?: (frac: number) => void;
  };
  /** Evidence for the architectural overlay's window placement. */
  readonly overlay?: OverlayEvidence;
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

export async function exportVoxel(
  brep: BuildingBRep,
  opts: VoxelExportOptions = {},
): Promise<VoxelExportResult> {
  const mesh = await evaluateBRep(brep);
  const colorHex = labToHexColor(brep.materials.wall.lab);
  const object = brepMeshToObject3D(mesh.positions, mesh.indices, colorHex);

  const resolution = opts.resolution ?? 1;
  const grid = threeToGrid(object, resolution, {
    mode: opts.mode ?? 'surface',
    maxDimension: opts.maxDimension ?? 256,
  });

  // Compute world-space grid origin so the recolor pass can map voxel
  // indices back to photogrammetry coordinates.
  const gridBox = new THREE.Box3().setFromObject(object);

  // Photogrammetry color transfer (optional, before architectural
  // overlay so the overlay's window/cornice/plinth blocks survive
  // unchanged on top of the recolored wall).
  if (opts.photogrammetryRecolor && opts.photogrammetryRecolor.primitives.length > 0) {
    const { recolorFromPhotogrammetry } = await import('./photogrammetry-recolor.js');
    await recolorFromPhotogrammetry(
      grid,
      opts.photogrammetryRecolor.primitives,
      {
        originX: gridBox.min.x,
        originY: gridBox.min.y,
        originZ: gridBox.min.z,
        resolution,
        yScale: opts.photogrammetryRecolor.yScale,
        yShift: opts.photogrammetryRecolor.yShift,
        maxDistanceM: opts.photogrammetryRecolor.maxDistanceM,
        onProgress: opts.photogrammetryRecolor.onProgress,
      },
      // Architectural overlay hasn't run yet — every voxel is the wall
      // block, so an empty preserve set just means "recolor everything".
      new Set<string>(),
    );
  }

  // Multi-part colour pre-paint. When the synthesizer emitted
  // `partBlockBands` (mixed-colour compound buildings tagged with
  // distinct OSM building:colour per part), repaint voxels within each
  // part's polygon × height range with that part's block. Runs BEFORE
  // applyMaterialOverlay so the architectural overlay still applies
  // its top/cornice/window pattern over the per-part base colour.
  if (brep.partBlockBands && brep.partBlockBands.length > 0) {
    paintPartBlockBands(grid, brep.partBlockBands, gridBox, resolution);
  }

  // Post-process: the voxelizer outputs a single-material surface shell
  // based on the wall color. Re-label the top N layers as roof blocks
  // and punch vertical window stripes on the long facades so the output
  // isn't a monochrome featureless prism.
  const wallBlock = brep.materials.wall.blockName;
  const roofBlock = brep.materials.roof.blockName;
  const windowBlock = brep.materials.window.blockName;
  applyMaterialOverlay(grid, wallBlock, roofBlock, windowBlock, resolution, {
    wallLabL: brep.materials.wall.lab[0],
    ...opts.overlay,
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
    wallBlock,
    roofBlock,
  };
}

/**
/**
 * Per-part block painter. For each entry in `partBlockBands`, walks the
 * voxel grid within the polygon's XZ bounding box and Y range, and
 * relabels any non-air voxel inside the polygon with the part's block.
 * Runs before applyMaterialOverlay so window/cornice/plinth overlays
 * still apply over the per-part base colour.
 */
function paintPartBlockBands(
  grid: BlockGrid,
  bands: ReadonlyArray<NonNullable<BuildingBRep['partBlockBands']>[number]>,
  gridBox: THREE.Box3,
  resolution: number,
): void {
  const AIR = 'minecraft:air';
  for (const band of bands) {
    if (band.polygon.length < 3) continue;
    let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (const p of band.polygon) {
      if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
      if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z;
    }
    const gx0 = Math.max(0, Math.floor((xMin - gridBox.min.x) * resolution));
    const gx1 = Math.min(grid.width - 1, Math.ceil((xMax - gridBox.min.x) * resolution));
    const gz0 = Math.max(0, Math.floor((zMin - gridBox.min.z) * resolution));
    const gz1 = Math.min(grid.length - 1, Math.ceil((zMax - gridBox.min.z) * resolution));
    const gy0 = Math.max(0, Math.floor((band.baseY - gridBox.min.y) * resolution));
    const gy1 = Math.min(grid.height - 1, Math.ceil((band.topY - gridBox.min.y) * resolution));
    for (let y = gy0; y <= gy1; y++) {
      for (let z = gz0; z <= gz1; z++) {
        const worldZ = gridBox.min.z + (z + 0.5) / resolution;
        for (let x = gx0; x <= gx1; x++) {
          if (grid.get(x, y, z) === AIR) continue;
          const worldX = gridBox.min.x + (x + 0.5) / resolution;
          if (!pointInPolygonXZ(worldX, worldZ, band.polygon)) continue;
          grid.set(x, y, z, band.blockName);
        }
      }
    }
  }
}

function pointInPolygonXZ(
  x: number,
  z: number,
  poly: ReadonlyArray<{ x: number; z: number }>,
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi)) {
      inside = !inside;
    }
  }
  return inside;
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
export function applyMaterialOverlay(
  grid: BlockGrid,
  wallBlock: string,
  roofBlock: string,
  windowBlock: string,
  resolution: number = 1,
  ev: OverlayEvidence = {},
): void {
  const { width: W, height: H, length: L } = grid;
  const res = Math.max(0.25, resolution);
  const heightM = H / res;
  const roofDepth = Math.max(1, Math.round(H * 0.05));
  // Cornice and base are sized in METRES, not blocks. The old thresholds
  // compared a BLOCK height against `50`/`15` and emitted 2-3 BLOCK bands —
  // at the default 6 blocks/m that is a 0.5m cornice and a 0.33m plinth on a
  // 73m tower: invisible, while the consensus scorer asks about "cornices,
  // parapets" by name and scored features 1-2 on every tall golden.
  // A real projecting cornice runs ~2-3% of facade height; a rusticated /
  // storefront base runs about one storey. Both are clamped so a small house
  // gets a modest eave and plinth rather than a banded stripe.
  const corniceM = heightM > 8 ? Math.min(2.5, Math.max(0.4, heightM * 0.025)) : 0;
  const baseM = heightM > 6 ? Math.min(4.5, Math.max(0.5, heightM * 0.06)) : 0;
  const corniceBandH = Math.round(corniceM * res);
  const baseBandH = Math.round(baseM * res);
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

  // Pass 3 — windows, placed at real storey heights. The old pass stamped
  // single voxels on every 4th row with no knowledge of levels or metric
  // scale — at 4 blocks/m a 2-storey house grew 6+ rows of invisible dots
  // and the consensus VLM scored features 0-1 on every golden. Windows are
  // now sized in metres from the archetype table (shared with the BRep
  // feature generator), one row per storey, face-aware so each facade gets
  // vertical window columns instead of a corner-wrapping moiré.
  const yMin = baseBandH;
  // Window band ends at the EAVE line, not grid height. On pitched roofs
  // the top third of the grid is roof geometry — banding against H pushed
  // the upper residential window row into the roof mass where it half
  // clipped under the eave. The eave is the 25th percentile of per-column
  // top heights: pitched roofs put most columns well above it (slope) but
  // perimeter wall columns AT it; flat roofs collapse it to ≈ H−1 so
  // towers keep their full band.
  const tops: number[] = [];
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < L; z++) {
      if (topYOf[x][z] >= 0) tops.push(topYOf[x][z]);
    }
  }
  tops.sort((a, b) => a - b);
  const eaveY = tops.length > 0 ? tops[Math.floor(tops.length * 0.25)] : H - 1;
  const yMax = Math.min(H - roofDepth - corniceBandH, eaveY - roofDepth + 1);
  const archType: ArchType = ev.archType ?? (heightM > 15 ? 'commercial' : 'residential');
  const usable = yMax - yMin;
  // Storey pitch in blocks: prefer evidence levels; else archetype-typical
  // floor height. Clamp so at least one row fits and rows never touch.
  const typFloorM = archType === 'residential' ? 3.0 : 4.0;
  const storeys = ev.levels && ev.levels > 0
    ? ev.levels
    : Math.max(1, Math.round(usable / (typFloorM * res)));
  const storeyBlocks = usable / Math.max(1, storeys);
  const dims = windowDimsFor(archType);
  const wBlk = Math.max(1, Math.round(dims.widthM * res));
  const hBlk = Math.max(1, Math.min(Math.round(dims.heightM * res), Math.floor(storeyBlocks) - 1));
  const pitchM = archType === 'residential' ? 3.5 : 2.8;
  // Pitch floor of wBlk+2 guarantees ≥2 blocks of wall between windows, so
  // coarse resolutions keep a masonry-dominant punched facade (~25-35%
  // window share) instead of degenerating toward curtain wall.
  const pitchBlk = Math.max(wBlk + 2, Math.round(pitchM * res));
  // Curtain-wall mode: commercial archetype whose wall material is dark
  // (L* < 45 — black/bronze glass towers like Pennzoil). The facade flips
  // to glass-dominant with wall-block spandrels at storey lines and thin
  // vertical mullions, instead of punched windows in a masonry field.
  const curtainWall = archType === 'commercial' && ev.wallLabL != null && ev.wallLabL < 45;
  // 1-block mullions on a ~3m module — at coarse resolutions a tighter pitch
  // makes half the facade mullion and the curtain wall stops reading as glass.
  const mullionPitch = Math.max(4, Math.round(3 * res));

  const isReplaceableWall = (b: string): boolean =>
    b !== AIR && b !== roofBlock && b !== trimBlock && b !== plinthBlock;

  if (storeyBlocks >= 2 && usable >= 2) {
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < L; z++) {
        // Face direction: which horizontal neighbour is air decides the axis
        // the window pattern runs along (pattern along the facade, not into it).
        for (let y = yMin; y < yMax; y++) {
          const b = grid.get(x, y, z);
          if (!isReplaceableWall(b)) continue;
          const airX = (x > 0 && grid.get(x - 1, y, z) === AIR) || (x < W - 1 && grid.get(x + 1, y, z) === AIR);
          const airZ = (z > 0 && grid.get(x, y, z - 1) === AIR) || (z < L - 1 && grid.get(x, y, z + 1) === AIR);
          if (!airX && !airZ) continue;
          // Phase along the facade: X-normal walls pattern along Z and vice versa.
          const along = airZ ? x : z;
          if (curtainWall) {
            // Glass everywhere except storey spandrels + vertical mullions.
            const isSpandrel = storeyBlocks >= 3 && (y - yMin) % storeyBlocks < 1;
            const isMullion = along % mullionPitch === 0;
            if (!isSpandrel && !isMullion) grid.set(x, y, z, windowBlock);
          } else {
            // Punched windows: one row per storey, centred in the storey.
            const storeyIdx = Math.min(storeys - 1, Math.floor((y - yMin) / storeyBlocks));
            const rowY0 = yMin + Math.round(storeyIdx * storeyBlocks + (storeyBlocks - hBlk) / 2);
            if (y < rowY0 || y >= rowY0 + hBlk) continue;
            // Half-pitch offset insets the first window column from the corner.
            if ((along + (pitchBlk >> 1)) % pitchBlk < wBlk) grid.set(x, y, z, windowBlock);
          }
        }
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
