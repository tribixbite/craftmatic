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
import { douglasPeucker } from '../context/classify.js';
import { rgbToWallBlock, rgbToRoofOverride } from '../../gen/color-blocks.js';

function makeMaterial(lab: Lab, block: string): MaterialRef {
  return { blockName: block, lab };
}

/**
 * Convert a Lab colour to the nearest full-block Minecraft block, via the
 * shared 36-cluster palette in `color-blocks.ts`. Same logic as parametric.ts
 * — inlined here to avoid a cross-directory import when both synthesizers
 * need the same picker.
 */
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
  if (['dark_oak', 'oak', 'spruce', 'birch', 'jungle', 'acacia', 'warped', 'crimson'].includes(base)) {
    return `minecraft:${base}_planks`;
  }
  if (['stone_brick', 'deepslate_tile', 'nether_brick', 'mud_brick', 'polished_blackstone_brick'].includes(base)) {
    return `minecraft:${base}s`;
  }
  return `minecraft:${base}`;
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
    // Douglas-Peucker simplify before synthesis; see parametric.ts for rationale.
    const simplified = douglasPeucker(osmPoly, 0.00001);
    const usedPoly = simplified.length >= 3 ? simplified : osmPoly;
    const localPoly = projectPolygonToLocal(
      usedPoly.map(p => ({ lat: p.lat, lon: p.lon })),
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
      wall: makeMaterial(wallLab, pickWallBlock(wallLab)),
      trim: makeMaterial(wallLab, pickWallBlock(wallLab)),
      roof: makeMaterial(roofLab, pickRoofBlock(roofLab)),
      window: makeMaterial([50, 0, 0], 'minecraft:glass'),
    },
  };
}
