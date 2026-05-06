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
import { projectPolygonToLocal } from './features.js';
import { douglasPeucker } from '../context/classify.js';
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
  // Band detection delta: 1m is plenty to catch setbacks, twin-tower splits,
  // and cantilever transitions. Sub-metre slicing wastes compute (we'd
  // produce hundreds of bands that all merge into a few anyway) and at
  // res=6 a 0.167m feature is sub-voxel. The actual extruded prism still
  // hits res-6 voxel resolution in exportVoxel — `deltaY` only sets
  // band-detection granularity.
  const deltaY = Math.max(1.0, 1 / resolution);

  // Slice across the full photogrammetry Y range. The OSM mask filter
  // (applied per-slice via maskedSilhouette) drops polygons outside the
  // building's footprint, so neighbouring buildings naturally don't
  // contribute bands at their own height. We still get a tight Y range
  // for the building from the SURVIVED bands.
  const expectedHeightM = ev.heightM.value > 0 ? ev.heightM.value : 30;
  const minY = tiles.measuredBbox.min.y;
  const maxY = tiles.measuredBbox.max.y;

  // Crop to the building's expected XZ extent so we don't slice surrounding
  // ground / neighbour buildings included in the photogrammetry capture.
  // MBR widthM/depthM are normalised to (max, min) without preserving E-W
  // vs N-S, so we use max(widthM, depthM) on both axes plus 30% slop.
  // The photogrammetry GLB contains the target plus neighbouring buildings
  // (Google's tile capture pulls a ~150m-radius cylinder). Crop tightly to
  // the building's MBR + 20% slop so we don't slice 8 neighbours alongside.
  // For twin-tower compounds (Pennzoil) the MBR already covers both
  // towers + gap, so 20% slop is ample. For single buildings this excludes
  // adjacent structures whose footprints would otherwise produce extra
  // disjoint polygons in every slice.
  const buildingMaxDim = Math.max(ctx.mbr.widthM, ctx.mbr.depthM);
  const cropHalf = buildingMaxDim * 0.5 + Math.max(buildingMaxDim * 0.1, 5);

  // Photogrammetry mesh edges are noisy at the ~0.5m scale — every slice
  // produces slightly different polygon vertex counts and centroids even
  // for what should be a uniform tower. Loosen tolerances so slices over
  // a uniform section fold into one band: centroid drift up to 3m, area
  // up to ±15%. This trades band count (fewer prisms = faster CSG union)
  // against shape accuracy (tighter tolerances catch smaller setbacks).
  const bands = extractBands(
    meshes,
    { minY, maxY },
    {
      deltaY,
      snap: 0.5,
      minArea: 8.0,
      centroidTolM: 3.0,
      areaRatioTol: 0.15,
      cropXZ: { halfX: cropHalf, halfZ: cropHalf },
      // Keep only the polygon nearest origin per slice. Single-building
      // case: this isolates the target from neighbouring photogrammetry.
      // TODO: detect twin-tower compounds (Pennzoil) from OSM polygon
      // disjoint-parts count and bump to 2 in those cases.
      maxPolysPerSlice: 1,
    },
  );

  // Translate bands into BRep `bandedSilhouettes`. The mesh's local frame
  // already shares centre + rotation with the BRep, so polygons project
  // straight through.
  // OSM polygon mask — when available, project to local frame and use as
  // the authoritative ground footprint. Slice polygons that fall fully
  // inside OSM (real setbacks) are kept as-is; slice polygons that
  // overshoot OSM (photogrammetry artifacts, neighbours) are replaced
  // with the OSM polygon. This anchors the silhouette to OSM at ground
  // level and lets Stage B's setback detection survive only on real
  // step-ins.
  const osmLocal = projectOsmPolygonOrNull(ctx, ev);

  // First pass: filter out bands whose polygons are entirely outside OSM.
  // We materialise the masked polygon for each surviving band and track
  // the actual (post-mask) Y range — this is the building's true Y span
  // even when photogrammetry includes neighbours that span a wider Y.
  interface MaskedBand {
    polygon: readonly LocalPoint2D[];
    y0: number;
    y1: number;
  }
  const masked: MaskedBand[] = [];
  for (const band of bands) {
    for (const poly of band.polygons) {
      // Skip slices that fall entirely outside OSM — when the OSM polygon
      // is provided and `osmLocal` is non-null, only slices that pass the
      // origin-proximity filter AND have at least one vertex inside OSM
      // contribute. `maskedSilhouette` returns OSM polygon as fallback
      // when nothing inside; we treat that as "no surviving footprint" by
      // checking if any vertex is actually inside.
      if (osmLocal !== null) {
        const anyInside = poly.points.some(p => pointInPolygon(p.x, p.z, osmLocal));
        if (!anyInside) continue;
      }
      const ring = osmLocal !== null
        ? maskedSilhouette(poly, osmLocal)
        : openRingFrom(poly);
      masked.push({ polygon: ring, y0: band.y0, y1: band.y1 });
    }
  }

  // True building Y range from masked bands
  const trueMinY = masked.length > 0
    ? Math.min(...masked.map(b => b.y0))
    : minY;
  const trueMaxY = masked.length > 0
    ? Math.max(...masked.map(b => b.y1))
    : maxY;
  const observedSpan = Math.max(0.01, trueMaxY - trueMinY);

  // Y normalisation: linearly scale the masked Y range onto [0, expectedHeightM].
  // OSM/Solar surveyed height is the authoritative input here — it's
  // curated data, while photogrammetry's bbox is contaminated by sub-
  // grade entrances, neighbour buildings, and antenna noise. Setbacks
  // and cantilevers in the observed range are preserved proportionally.
  // For buildings with no surveyed height (`expectedHeightM` falls back
  // to 30m default), this collapses to "build to 30m" — least bad.
  const scaleY = expectedHeightM / observedSpan;

  const bandedSilhouettes: Array<{
    polygon: readonly LocalPoint2D[];
    baseY: number;
    topY: number;
  }> = [];
  for (const b of masked) {
    bandedSilhouettes.push({
      polygon: b.polygon,
      baseY: (b.y0 - trueMinY) * scaleY,
      topY: (b.y1 - trueMinY) * scaleY,
    });
  }
  console.error(`  [sliced-tiles] survived ${masked.length} bands, Y range ${trueMinY.toFixed(1)}..${trueMaxY.toFixed(1)} (${observedSpan.toFixed(1)}m) → scaled to expected ${expectedHeightM.toFixed(1)}m (×${scaleY.toFixed(3)})`);

  const wallLab = ev.wallPalette.value[0];
  const roofLab = ev.roofPalette.value[0];

  // Top band acts as roof footprint when present; emit a flat-top "roof".
  // After Y normalisation, the top is at expectedHeightM; roof polygon
  // takes the topmost surviving silhouette.
  const topMasked = masked[masked.length - 1];
  const roofPolygon: readonly LocalPoint2D[] = topMasked
    ? topMasked.polygon
    : [];
  const topElev = expectedHeightM;

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

/**
 * Project the OSM polygon (when available) into MBR-aligned local frame.
 * Mirrors `cleaned-tiles.ts` logic. Returns null when no usable OSM
 * polygon exists — Solar bbox / inferred polygons are deliberately
 * rejected because they're rectangles that defeat the mask filter.
 */
function projectOsmPolygonOrNull(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
): readonly LocalPoint2D[] | null {
  if (ev.footprint.source !== 'osm') return null;
  const osmPoly = ev.footprint.value;
  if (osmPoly.length < 3) return null;
  const simplified = douglasPeucker(osmPoly, 0.00001);
  const used = simplified.length >= 3 ? simplified : osmPoly;
  const local = projectPolygonToLocal(
    used.map(p => ({ lat: p.lat, lon: p.lon })),
    ctx.center,
    ctx.mbr.rotationDeg,
  );
  // Drop closing duplicate vertex if present
  const isClosed = local.length >= 2
    && Math.abs(local[0].x - local[local.length - 1].x) < 1e-6
    && Math.abs(local[0].z - local[local.length - 1].z) < 1e-6;
  return isClosed ? local.slice(0, -1) : [...local];
}

/**
 * Constrain a slice polygon to the OSM footprint. Two outcomes:
 *   • All slice vertices inside OSM → keep the slice polygon as-is. This
 *     preserves real setbacks (upper bands narrower than ground).
 *   • Any slice vertex outside OSM → replace with OSM polygon. Drops
 *     photogrammetry overshoot (the photogrammetry mesh extends beyond
 *     the real building due to facade detail / scaffolding noise).
 *
 * A more accurate implementation would polygon-clip with Sutherland-
 * Hodgman or Weiler-Atherton, but the all-or-nothing decision is robust
 * across non-convex OSM shapes (the Flatiron wedge isn't convex once
 * its detailed corners survive).
 */
function maskedSilhouette(
  slice: Polygon2D,
  osmLocal: readonly LocalPoint2D[],
): readonly LocalPoint2D[] {
  for (const v of slice.points) {
    if (!pointInPolygon(v.x, v.z, osmLocal)) {
      return osmLocal;
    }
  }
  return slice.points.map(p => ({ x: p.x, z: p.z }));
}

function pointInPolygon(
  x: number,
  z: number,
  poly: readonly { x: number; z: number }[],
): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z;
    const xj = poly[j].x, zj = poly[j].z;
    const intersect = ((zi > z) !== (zj > z))
      && (x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
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
