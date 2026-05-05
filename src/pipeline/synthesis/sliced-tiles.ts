/**
 * Stage 7d — sliced-tiles synthesizer.
 *
 * Slices the photogrammetry mesh horizontally and groups consecutive same-
 * topology slices into bands. Each band contributes one or more vertical
 * prisms (one per disjoint polygon in the slice) to the BRep. The
 * `bandedSilhouettes` field on BRep then unions everything.
 *
 * This generalises the cleaned-tiles fallback (which produced a single
 * polygon prism) to buildings whose silhouette changes with height —
 * twin towers, setbacks, cantilevers, spirals.
 *
 * The slice delta defaults to `1 / voxelResolution` so the mesh shape gets
 * sampled at the same resolution we'll voxelize at: any feature smaller
 * than a voxel can't survive into the final grid anyway.
 */

import type { Lab, LocalPoint2D, MaterialRef, RefinedBuildingContext } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';
import type { BuildingBRep } from './brep.js';
import {
  extractBands,
  type MeshSliceInput,
  type Polygon2D,
} from './slice-extract.js';
import { rgbToWallBlock, rgbToRoofOverride } from '../../gen/color-blocks.js';
import { DEFAULT_VOXEL_RESOLUTION } from '../pipeline.js';

export interface SynthesizeSlicedOptions {
  /** Voxelizer resolution — used to size the slice delta. */
  readonly voxelResolution?: number;
}

/**
 * The photogrammetry mesh from `captureTiles` lives in scene-local metres
 * and is already in the same XZ frame as the BRep evaluator (after the
 * Z↔Y swap performed inside `extractMeshInputs`). We can use it directly.
 */
export function synthesizeSlicedTiles(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence,
  opts: SynthesizeSlicedOptions = {},
): BuildingBRep {
  if (!tiles.meshes || tiles.meshes.length === 0) {
    throw new Error('synthesizeSlicedTiles: tiles.meshes is missing — cannot slice');
  }

  const meshes: MeshSliceInput[] = tiles.meshes.map(m => ({
    positions: m.positions,
    indices: m.indices,
  }));

  const resolution = opts.voxelResolution ?? DEFAULT_VOXEL_RESOLUTION;
  const deltaY = 1 / resolution;

  const minY = tiles.measuredBbox.min.y;
  const maxY = tiles.measuredBbox.max.y;

  const bands = extractBands(
    meshes,
    { minY, maxY },
    { deltaY, snap: 0.05, minArea: 2.0, centroidTolM: 1.5, areaRatioTol: 0.08 },
  );

  // Translate bands into BRep `bandedSilhouettes`. The mesh's local frame
  // already shares centre + rotation with the BRep, so polygons project
  // straight through.
  const bandedSilhouettes: Array<{
    polygon: readonly LocalPoint2D[];
    baseY: number;
    topY: number;
  }> = [];
  // Translate so y=0 is at the ground plane
  const yOffset = -minY;
  for (const band of bands) {
    for (const poly of band.polygons) {
      bandedSilhouettes.push({
        polygon: openRingFrom(poly),
        baseY: band.y0 + yOffset,
        topY: band.y1 + yOffset,
      });
    }
  }

  const wallLab = ev.wallPalette.value[0];
  const roofLab = ev.roofPalette.value[0];

  // Top band acts as roof footprint when present; emit a flat-top "roof".
  const topBand = bands[bands.length - 1];
  const roofPolygon: readonly LocalPoint2D[] = topBand && topBand.polygons.length > 0
    ? openRingFrom(topBand.polygons[0])
    : [];
  const topElev = topBand ? topBand.y1 + yOffset : (maxY - minY);

  return {
    origin: { lat: ctx.center.lat, lng: ctx.center.lng },
    rotationDeg: ctx.mbr.rotationDeg,
    floors: [],
    walls: [],
    bandedSilhouettes,
    roof: {
      type: 'flat',
      baseZ: topElev,
      peakZ: topElev,
      pitchDeg: 0,
      polygon: roofPolygon,
      params: {},
    },
    details: [],
    materials: {
      wall: makeMaterial(wallLab, pickWallBlock(wallLab)),
      trim: makeMaterial(wallLab, pickWallBlock(wallLab)),
      roof: makeMaterial(roofLab, pickRoofBlock(roofLab)),
      window: makeMaterial([50, 0, 0], 'minecraft:glass'),
    },
  };
}

function openRingFrom(p: Polygon2D): readonly LocalPoint2D[] {
  return p.points.map(pt => ({ x: pt.x, z: pt.z }));
}

function makeMaterial(lab: Lab, block: string): MaterialRef {
  return { blockName: block, lab };
}

function labToRgb(lab: Lab): readonly [number, number, number] {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fInv = (t: number): number => t * t * t > 0.008856 ? t * t * t : (t - 16 / 116) / 7.787;
  const x = fInv(fx) * 0.95047;
  const y = fInv(fy) * 1.0;
  const z = fInv(fz) * 1.08883;
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.2040 + z * 1.0570;
  const toS = (c: number): number => c > 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : 12.92 * c;
  const clamp = (v: number): number => Math.max(0, Math.min(1, v));
  return [
    Math.round(clamp(toS(R)) * 255),
    Math.round(clamp(toS(G)) * 255),
    Math.round(clamp(toS(B)) * 255),
  ];
}

function pickWallBlock(lab: Lab): string {
  const [r, g, b] = labToRgb(lab);
  return rgbToWallBlock(r, g, b);
}

function pickRoofBlock(lab: Lab): string {
  const [r, g, b] = labToRgb(lab);
  const override = rgbToRoofOverride(r, g, b);
  const base = override.cap.replace(/^minecraft:/, '').replace(/_slab\[type=bottom\]$/, '');
  return `minecraft:${base}`;
}
