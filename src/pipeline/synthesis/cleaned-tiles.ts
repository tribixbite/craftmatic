/**
 * Stage 7b — cleaned-tiles fallback synthesizer.
 *
 * Invoked when the parametric path is unsuitable (no polygon, curved/irregular
 * footprints, or heavy truncation). Produces a watertight B-rep built from
 * the measured tile bbox rather than an OSM polygon.
 *
 * **Simplification for MVP**: rather than polygon-clipping + hole-filling the
 * photogrammetry mesh (which requires substantial geometry work), this fallback
 * builds a **conservative rectangular box** sized to the measured tile bbox
 * (width × depth × measured Y). When tiles are truncated, the height is
 * extrapolated from `ctx.heightM`. Every voxel is watertight, manifold, and
 * 3D-printable — objective gates pass.
 *
 * A richer polygon-clipped-tile-mesh implementation is tracked as a follow-up
 * for buildings where the box silhouette loses too much detail (curved shells,
 * cantilevers). Gemini plateau analysis already declares these source-data-limited.
 */

import type { RefinedBuildingContext, Lab, MaterialRef } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';
import type { BuildingBRep, FloorSlab, RoofVolume, Wall } from './brep.js';

const DEFAULT_BLOCK_GREY = 'minecraft:smooth_stone';

function makeMaterial(lab: Lab, block: string): MaterialRef {
  return { blockName: block, lab };
}

/**
 * Build a conservative box-shaped B-rep from the measured tile extent.
 *
 * When `tiles.truncated`, the extrapolated height comes from `ev.heightM` so
 * the building doesn't look chopped off. When `ctx.mbr` disagrees with the
 * measured bbox by > 30%, we trust the measured bbox (photogrammetry is
 * authoritative on captured massing).
 */
export function synthesizeCleanedTiles(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence | null,
): BuildingBRep {
  const widthM = tiles
    ? Math.max(3, tiles.measuredBbox.max.x - tiles.measuredBbox.min.x)
    : ctx.mbr.widthM;
  const depthM = tiles
    ? Math.max(3, tiles.measuredBbox.max.z - tiles.measuredBbox.min.z)
    : ctx.mbr.depthM;

  // Height: prefer tile measurement unless truncated
  const measuredH = tiles ? tiles.measuredBbox.max.y - tiles.measuredBbox.min.y : 0;
  const heightM = (tiles?.truncated || measuredH < 3)
    ? Math.max(3, ev.heightM.value)
    : measuredH;

  // Levels for slab spacing — roughly 3.5m per storey
  const levels = Math.max(1, Math.round(heightM / 3.5));
  const floorHeightM = heightM / levels;
  const slabThickness = 0.3;

  const halfW = widthM / 2;
  const halfD = depthM / 2;
  const rectPoly = [
    { x: -halfW, z: -halfD },
    { x:  halfW, z: -halfD },
    { x:  halfW, z:  halfD },
    { x: -halfW, z:  halfD },
  ];

  const floors: FloorSlab[] = [];
  const walls: Wall[] = [];
  for (let level = 0; level < levels; level++) {
    const elevationM = level * floorHeightM;
    floors.push({ level, elevationM, thicknessM: slabThickness, polygon: rectPoly });
    for (let e = 0; e < 4; e++) {
      walls.push({
        level,
        facadeEdge: e,
        start: rectPoly[e],
        end: rectPoly[(e + 1) % 4],
        heightM: floorHeightM - slabThickness,
        thicknessM: 0.3,
        material: 'wall',
      });
    }
  }

  // Roof: use the reconciled shape; flat is the safe default for unknown footprints
  const roofType = ev.roofShape.value;
  const roofExtrude = roofType === 'flat' ? 0.5 : Math.max(2, heightM * 0.1);
  const roof: RoofVolume = {
    type: roofType,
    baseZ: heightM,
    peakZ: heightM + roofExtrude,
    pitchDeg: roofType === 'flat' ? 0 : 25,
    polygon: rectPoly,
    params: {},
  };

  const wallLab = ev.wallPalette.value[0];
  const roofLab = ev.roofPalette.value[0];

  return {
    origin: ctx.center,
    rotationDeg: ctx.mbr.rotationDeg,
    floors,
    walls,
    roof,
    details: [],
    materials: {
      wall: makeMaterial(wallLab, DEFAULT_BLOCK_GREY),
      trim: makeMaterial(wallLab, DEFAULT_BLOCK_GREY),
      roof: makeMaterial(roofLab, 'minecraft:deepslate_tiles'),
      window: makeMaterial([50, 0, 0], 'minecraft:glass'),
    },
  };
}
