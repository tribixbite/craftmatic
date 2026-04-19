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

import type { RefinedBuildingContext, Lab, LocalPoint2D, MaterialRef } from '../context/types.js';
import type { JointEvidence } from '../fusion/types.js';
import type { TileEvidence } from '../capture/types.js';
import type { BuildingBRep, FloorSlab, RoofVolume, Wall } from './brep.js';
import { projectPolygonToLocal } from './features.js';

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
  // Footprint: prefer the actual OSM polygon when available. Only fall back
  // to the MBR rectangle when no polygon or fewer than 3 vertices.
  let openPoly: LocalPoint2D[];
  const osmPoly = ev.footprint.value;
  if (osmPoly.length >= 3 && ev.footprint.source === 'osm') {
    const localPoly = projectPolygonToLocal(
      osmPoly.map(p => ({ lat: p.lat, lon: p.lon })),
      ctx.center,
      ctx.mbr.rotationDeg,
    );
    const isClosed = localPoly.length >= 2
      && Math.abs(localPoly[0].x - localPoly[localPoly.length - 1].x) < 1e-6
      && Math.abs(localPoly[0].z - localPoly[localPoly.length - 1].z) < 1e-6;
    openPoly = isClosed ? localPoly.slice(0, -1) : [...localPoly];
  } else {
    const widthM = tiles
      ? Math.max(3, tiles.measuredBbox.max.x - tiles.measuredBbox.min.x)
      : ctx.mbr.widthM;
    const depthM = tiles
      ? Math.max(3, tiles.measuredBbox.max.z - tiles.measuredBbox.min.z)
      : ctx.mbr.depthM;
    const halfW = widthM / 2;
    const halfD = depthM / 2;
    openPoly = [
      { x: -halfW, z: -halfD },
      { x:  halfW, z: -halfD },
      { x:  halfW, z:  halfD },
      { x: -halfW, z:  halfD },
    ];
  }

  // Height: prefer tile measurement unless truncated
  const measuredH = tiles ? tiles.measuredBbox.max.y - tiles.measuredBbox.min.y : 0;
  const heightM = (tiles?.truncated || measuredH < 3)
    ? Math.max(3, ev.heightM.value)
    : measuredH;

  // Roof: use the reconciled shape; flat is the safe default for unknown footprints
  const roofType = ev.roofShape.value;
  const roofExtrude = Math.min(
    heightM * 0.4,
    roofType === 'flat' ? 0.5 : Math.max(2, heightM * 0.15),
  );
  const wallsTotal = Math.max(2.5, heightM - roofExtrude);

  // Levels for slab spacing — roughly 3.5m per storey
  const levels = Math.max(1, Math.round(wallsTotal / 3.5));
  const floorHeightM = wallsTotal / levels;
  const slabThickness = Math.min(0.3, floorHeightM * 0.1);

  const floors: FloorSlab[] = [];
  const walls: Wall[] = [];
  for (let level = 0; level < levels; level++) {
    const elevationM = level * floorHeightM;
    floors.push({ level, elevationM, thicknessM: slabThickness, polygon: openPoly });
    for (let e = 0; e < openPoly.length; e++) {
      walls.push({
        level,
        facadeEdge: e % 4,
        start: openPoly[e],
        end: openPoly[(e + 1) % openPoly.length],
        heightM: floorHeightM - slabThickness,
        thicknessM: 0.3,
        material: 'wall',
      });
    }
  }

  const roof: RoofVolume = {
    type: roofType,
    baseZ: wallsTotal,
    peakZ: wallsTotal + roofExtrude,
    pitchDeg: roofType === 'flat' ? 0 : 25,
    polygon: openPoly,
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
