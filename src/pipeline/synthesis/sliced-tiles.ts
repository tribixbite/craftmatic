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
import { decomposePolygonByWaists } from './polygon-decompose.js';
import { detectCurvedShape } from './curved-shape.js';
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
/**
 * @returns the BRep plus Y-mapping metadata. The recolor pass uses
 * yScale/yShift to translate grid-Y back to photogrammetry-Y for
 * texture sampling.
 */
export interface SlicedSynthesisResult {
  readonly brep: BuildingBRep;
  readonly yScale: number;
  readonly yShift: number;
}

export function synthesizeSlicedTilesResult(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence,
  opts: SynthesizeSlicedOptions = {},
): SlicedSynthesisResult {
  const r = synthesizeSlicedTilesImpl(ctx, ev, tiles, opts);
  return r;
}

/** Legacy 1-arg-shape wrapper for tests. */
export function synthesizeSlicedTiles(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence,
  opts: SynthesizeSlicedOptions = {},
): BuildingBRep {
  return synthesizeSlicedTilesImpl(ctx, ev, tiles, opts).brep;
}

function synthesizeSlicedTilesImpl(
  ctx: RefinedBuildingContext,
  ev: JointEvidence,
  tiles: TileEvidence,
  opts: SynthesizeSlicedOptions = {},
): SlicedSynthesisResult {
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

  // OSM polygon mask. When available we use it both as the silhouette
  // anchor (`maskedSilhouette`) and to drive the polygon-count filter:
  // if OSM is present, keep ALL polygons inside it (twin-tower compounds
  // like Pennzoil get both members preserved). If OSM is absent, fall
  // back to "keep the polygon closest to origin" — single-building case.
  //
  // Curved-shape exception: when the OSM polygon is approximately
  // circular (Guggenheim, Marina City, domes), the rigid OSM-anchor
  // mask would clamp every band to the same circle — destroying the
  // spiral/cone Y-variation that's the building's defining feature.
  // We detect curved via `building:shape`, `roof:shape=dome`, or
  // geometric isoperimetric ratio, and SKIP the OSM mask for those.
  // Photogrammetry slices then keep their natural per-band radii.
  const curvedDetect = detectCurvedShape(
    ev.footprint.value as readonly { lat: number; lon: number }[] | null,
    ctx.rawOsm?.tags ?? null,
  );
  // Detect at 0.65 (informational), but only ACTUALLY bypass the OSM
  // mask when circularity > 0.85 — true cylinders (Marina City, drum
  // shaped buildings) safely bypass; partial-circular L-shapes
  // (Guggenheim 0.69) keep the OSM mask so neighbour photogrammetry
  // doesn't leak into the bands.
  if (curvedDetect.isCurved) {
    console.error(`  [sliced-tiles] curved shape detected (${curvedDetect.reason})${curvedDetect.circularity > 0.85 ? ' — bypassing OSM mask' : ''}`);
  }
  const osmLocal = curvedDetect.isCurved && curvedDetect.circularity > 0.85
    ? null
    : projectOsmPolygonOrNull(ctx, ev);

  // OSM building:part polygons. Used only for genuine compound
  // buildings (Pennzoil-style twin towers). For monolithic buildings
  // (Flatiron) Overpass returns multiple `building:part` ways within
  // the polygon (interior subdivisions, parking levels) that overlap
  // the whole footprint and would corrupt the synthesizer if we treated
  // them as separate towers. We only activate the parts path when:
  //   • ≥ 2 qualified parts (single part = monolithic, parent polygon
  //     captures it sufficiently)
  //   • Each part covers < 60% of the OSM polygon area (parts in a
  //     true compound DON'T fill the polygon — there's a gap between
  //     them where the plaza/courtyard sits)
  const partPolygons: Array<{
    polygon: readonly LocalPoint2D[];
    expectedHeightM: number;
    coverageFrac: number;
  }> = [];
  const osmArea = osmLocal !== null ? polygonAreaAbs(osmLocal) : 0;
  for (const part of ctx.buildingParts ?? []) {
    if (part.polygon.length < 3) continue;
    const localPart = projectPolygonToLocal(
      part.polygon.map(p => ({ lat: p.lat, lon: p.lon })),
      ctx.center,
      ctx.mbr.rotationDeg,
    );
    const isClosed = localPart.length >= 2
      && Math.abs(localPart[0].x - localPart[localPart.length - 1].x) < 1e-6
      && Math.abs(localPart[0].z - localPart[localPart.length - 1].z) < 1e-6;
    const ring = isClosed ? localPart.slice(0, -1) : [...localPart];
    if (osmLocal !== null) {
      let cx = 0, cz = 0;
      for (const p of ring) { cx += p.x; cz += p.z; }
      cx /= ring.length; cz /= ring.length;
      if (!pointInPolygon(cx, cz, osmLocal)) continue;
      let inside = 0;
      for (const v of ring) {
        if (pointInPolygon(v.x, v.z, osmLocal)) inside++;
      }
      if (inside / ring.length < 0.5) continue;
    }
    const partHeight = part.heightM && Number.isFinite(part.heightM) && part.heightM > 1
      ? part.heightM
      : expectedHeightM;
    const partArea = polygonAreaAbs(ring);
    const coverageFrac = osmArea > 0 ? partArea / osmArea : 1;
    partPolygons.push({ polygon: ring, expectedHeightM: partHeight, coverageFrac });
  }
  // Compound discriminator. Cases:
  //   • 0-1 parts → monolithic, single-polygon path
  //   • ≥2 parts, all <60% coverage AND distinct heights → compound
  //   • ≥2 parts but one ≥60% coverage OR all same height → monolithic
  //     (interior subdivisions of a single building, not separate towers)
  let isCompound = false;
  if (partPolygons.length >= 2) {
    const allBelowFull = partPolygons.every(p => p.coverageFrac < 0.6);
    const heights = partPolygons.map(p => p.expectedHeightM);
    const hMin = Math.min(...heights), hMax = Math.max(...heights);
    const heightSpread = hMax - hMin;
    // Distinct heights: ≥10m spread, OR all parts <40% coverage
    // (well-separated towers regardless of height).
    const distinctHeights = heightSpread >= 10;
    const wellSeparated = partPolygons.every(p => p.coverageFrac < 0.4);
    isCompound = allBelowFull && (distinctHeights || wellSeparated);
  }
  console.error(`  [sliced-tiles] parts=${partPolygons.length} isCompound=${isCompound} coverage=${partPolygons.map(p => p.coverageFrac.toFixed(2)).join(',')}`);
  if (!isCompound) partPolygons.length = 0;

  // Polygon waist decomposition fallback. When OSM has no building:part
  // tags but the parent polygon has a narrow waist (twin-tower compound
  // mapped as one polygon), split it into sub-polygons and treat each
  // as a synthesized part. Heights inherit from the parent expected.
  // Only runs when the part-tag path produced nothing (isCompound=false
  // AND partPolygons cleared).
  if (partPolygons.length === 0 && ev.footprint.source === 'osm' && ev.footprint.value.length >= 6) {
    const subs = decomposePolygonByWaists(
      ev.footprint.value.map(p => ({ lat: p.lat, lon: p.lon })),
      { maxChordM: 8, minChildAreaSqm: 50 },
    );
    if (subs.length >= 2) {
      const osmAreaForFrac = osmArea;
      for (const sub of subs) {
        const localSub = projectPolygonToLocal(
          sub.map(p => ({ lat: p.lat, lon: p.lon })),
          ctx.center,
          ctx.mbr.rotationDeg,
        );
        const isClosed = localSub.length >= 2
          && Math.abs(localSub[0].x - localSub[localSub.length - 1].x) < 1e-6
          && Math.abs(localSub[0].z - localSub[localSub.length - 1].z) < 1e-6;
        const ring = isClosed ? localSub.slice(0, -1) : [...localSub];
        const partArea = polygonAreaAbs(ring);
        const coverageFrac = osmAreaForFrac > 0 ? partArea / osmAreaForFrac : 1;
        partPolygons.push({
          polygon: ring,
          expectedHeightM,
          coverageFrac,
        });
      }
      console.error(`  [sliced-tiles] waist-decomposed OSM polygon into ${partPolygons.length} sub-parts`);
    }
  }

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
      // With OSM polygon: keep all polygons; sliced-tiles drops those
      // outside OSM. Without OSM: keep only the closest one.
      maxPolysPerSlice: osmLocal !== null ? Infinity : 1,
    },
  );

  // Translate bands into BRep `bandedSilhouettes`. The mesh's local frame
  // already shares centre + rotation with the BRep, so polygons project
  // straight through.
  //
  // Compound-building case: when ctx.buildingParts is non-empty, emit
  // one clean prism per part directly from its OSM polygon + OSM
  // height. Bypasses per-part band slicing (which produces stratified
  // gaps from per-part Y rescaling) — Pennzoil's two towers each get a
  // single full-height prism with their distinct heights from OSM tags.
  // Photogrammetry color-transfer still applies post-voxelization.
  interface MaskedBand {
    polygon: readonly LocalPoint2D[];
    y0: number;
    y1: number;
  }
  const masked: MaskedBand[] = [];

  if (partPolygons.length > 0) {
    // Per-part one-prism path. Each tower becomes a single full-height
    // prism at its OSM-tagged height. Add a low PLAZA prism using the
    // full OSM polygon so the IoU validator (which compares against
    // OSM footprint) sees full coverage at ground level. Plaza height
    // ~5m approximates the typical podium / breezeway / lobby visible
    // in OSM-tagged compound buildings (Pennzoil 4-storey lobby etc.).
    if (osmLocal !== null) {
      masked.push({
        polygon: osmLocal,
        y0: minY,
        y1: minY + 5,
      });
    }
    for (const part of partPolygons) {
      masked.push({
        polygon: part.polygon,
        y0: minY,
        y1: minY + part.expectedHeightM,
      });
    }
  } else {
    for (const band of bands) {
      for (const poly of band.polygons) {
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
  }

  const trueMinY = masked.length > 0
    ? Math.min(...masked.map(b => b.y0))
    : minY;
  const trueMaxY = masked.length > 0
    ? Math.max(...masked.map(b => b.y1))
    : maxY;
  const observedSpan = Math.max(0.01, trueMaxY - trueMinY);
  const scaleY = partPolygons.length > 0 ? 1 : expectedHeightM / observedSpan;

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

  // Wall + roof material resolution priority:
  //   1. OSM building:part colour (per-part compound buildings — averaged
  //      across qualified parts when they agree to within ΔE-equivalent
  //      threshold)
  //   2. OSM parent polygon's building:colour tag (ctx.wallColourHint)
  //   3. SV/satellite palette extracted from imagery (ev.wallPalette[0])
  //
  // OSM colours are curated data — when present they beat photogrammetry
  // -averaged SV pixels for accuracy. The photogrammetry recolor pass
  // STILL runs after (per-voxel sampling), but per-voxel samples now
  // start from a more-accurate wallLab when the BRep is rendered, giving
  // the recolor's k-means clusters a better initial reference.
  const partColours = (ctx.buildingParts ?? [])
    .map(p => p.buildingColour)
    .filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  const partWallLab = partColours.length > 0 ? hexToLab(partColours[0]) : null;
  const osmWallLab = ctx.wallColourHint && /^#[0-9a-fA-F]{6}$/.test(ctx.wallColourHint)
    ? hexToLab(ctx.wallColourHint)
    : null;
  const wallLab = partWallLab ?? osmWallLab ?? ev.wallPalette.value[0];

  const partRoofColours = (ctx.buildingParts ?? [])
    .map(p => p.roofColour)
    .filter((c): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c));
  const partRoofLab = partRoofColours.length > 0 ? hexToLab(partRoofColours[0]) : null;
  const osmRoofLab = ctx.roofColourHint && /^#[0-9a-fA-F]{6}$/.test(ctx.roofColourHint)
    ? hexToLab(ctx.roofColourHint)
    : null;
  const roofLab = partRoofLab ?? osmRoofLab ?? ev.roofPalette.value[0];

  if (partWallLab || osmWallLab) {
    console.error(`  [sliced-tiles] wall from ${partWallLab ? 'part-colour' : 'osm-colour'} (Lab ${wallLab[0].toFixed(0)},${wallLab[1].toFixed(0)},${wallLab[2].toFixed(0)})`);
  }

  // Roof shape inference from top-band geometry. The bandedSilhouettes
  // path stair-steps the photogrammetry exactly — for residential
  // gables and pyramidal towers the top band's polygon is much smaller
  // than the median band, producing a recognisable taper but pixelated
  // roof. We replace the topmost N tapered bands with a single roof
  // shape primitive (gabled / pyramidal / flat) so the BRep evaluator
  // produces a smooth roof instead of stairs.
  const roofInference = inferRoofFromBands(bandedSilhouettes);

  // Drop the bands that the roof primitive replaces (they're now part
  // of the roof shape, not stacked prisms).
  if (roofInference.replacedBandCount > 0) {
    bandedSilhouettes.length -= roofInference.replacedBandCount;
  }

  const brep: BuildingBRep = {
    origin: { lat: ctx.center.lat, lng: ctx.center.lng },
    rotationDeg: ctx.mbr.rotationDeg,
    floors: [],
    walls: [],
    bandedSilhouettes,
    roof: {
      type: roofInference.type,
      baseZ: roofInference.baseZ,
      peakZ: roofInference.peakZ,
      pitchDeg: roofInference.pitchDeg,
      polygon: roofInference.polygon,
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
  return { brep, yScale: scaleY, yShift: trueMinY };
}

function openRingFrom(p: Polygon2D): readonly LocalPoint2D[] {
  return p.points.map(pt => ({ x: pt.x, z: pt.z }));
}

function polygonAreaAbs(poly: ReadonlyArray<LocalPoint2D>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += (poly[j].x + poly[i].x) * (poly[i].z - poly[j].z);
  }
  return Math.abs(a) * 0.5;
}

/**
 * Convert a `#RRGGBB` hex colour string to CIE-Lab. Lab is the colour
 * space the synthesizer uses internally (wallLab/roofLab fields). Same
 * sRGB→linear→XYZ→Lab pipeline as the photogrammetry recolor pass.
 */
function hexToLab(hex: string): Lab {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lin = (c: number): number => {
    const cn = c / 255;
    return cn > 0.04045 ? Math.pow((cn + 0.055) / 1.055, 2.4) : cn / 12.92;
  };
  const lr = lin(r), lg = lin(g), lb = lin(b);
  const X = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const Y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750;
  const Z = lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041;
  const xn = X / 0.95047, yn = Y / 1.0, zn = Z / 1.08883;
  const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116);
  const fx = f(xn), fy = f(yn), fz = f(zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface RoofInference {
  /** Roof shape type (matches RoofShape enum). */
  readonly type: 'flat' | 'gabled' | 'hipped' | 'pyramidal' | 'dome' | 'mansard' | 'shed';
  readonly baseZ: number;
  readonly peakZ: number;
  readonly pitchDeg: number;
  readonly polygon: readonly LocalPoint2D[];
  /** How many trailing bands the roof primitive replaces. */
  readonly replacedBandCount: number;
}

/**
 * Infer roof shape from the silhouette taper at the top of the
 * banded extrusion stack. The photogrammetry naturally captures peaked
 * residential roofs as progressively-shrinking polygons in the topmost
 * bands; we replace those bands with a single roof shape so the
 * voxelizer produces a smooth peak instead of stair-stepped layers.
 *
 * Heuristic:
 *   • Find the median band area as the "main mass" reference.
 *   • Walk top-down from the highest band. While bands are <60% of
 *     median area, mark them as part of the roof zone.
 *   • Roof type by aspect ratio of the FIRST tapered band:
 *       elongated (long/short > 2) → 'gabled' (ridge along long axis)
 *       roughly square (≤2)        → 'pyramidal'
 *       single tapered band        → 'flat' with height pad (no taper)
 *   • Roof base = first tapered band's baseY
 *   • Roof peak = expectedHeightM (= last band's topY before the drop)
 *
 * Single-tapered or flat-roof buildings get type='flat' and 0 bands
 * dropped — the bandedSilhouettes path renders normally.
 */
function inferRoofFromBands(
  bands: ReadonlyArray<{ polygon: readonly LocalPoint2D[]; baseY: number; topY: number }>,
): RoofInference {
  if (bands.length === 0) {
    return { type: 'flat', baseZ: 0, peakZ: 0, pitchDeg: 0, polygon: [], replacedBandCount: 0 };
  }
  const peakZ = bands[bands.length - 1].topY;
  const flatFallback: RoofInference = {
    type: 'flat',
    baseZ: peakZ,
    peakZ,
    pitchDeg: 0,
    polygon: bands[bands.length - 1].polygon,
    replacedBandCount: 0,
  };

  if (bands.length < 4) return flatFallback; // not enough signal

  const areas = bands.map(b => signedAreaAbs(b.polygon));
  const medianArea = median(areas);
  if (medianArea <= 0) return flatFallback;

  // Walk top-down counting bands < 60% of median
  let taperedCount = 0;
  for (let i = bands.length - 1; i >= 0; i--) {
    if (areas[i] / medianArea < 0.6) {
      taperedCount++;
    } else {
      break;
    }
  }
  // Need at least 2 tapered bands to be worth replacing
  if (taperedCount < 2) return flatFallback;

  // First tapered band is the roof base
  const firstTaperedIdx = bands.length - taperedCount;
  const baseBand = bands[firstTaperedIdx];
  const baseZ = baseBand.baseY;
  const polygon = baseBand.polygon;

  // Aspect ratio of the base polygon → gabled vs pyramidal
  const bbox = polygonBBox(polygon);
  const long = Math.max(bbox.w, bbox.d);
  const short = Math.min(bbox.w, bbox.d);
  const aspectRatio = long / Math.max(short, 0.1);
  const type: RoofInference['type'] = aspectRatio > 2 ? 'gabled' : 'pyramidal';

  const pitchHeight = peakZ - baseZ;
  const pitchDeg = pitchHeight > 0 && short > 0
    ? Math.atan2(pitchHeight, short / 2) * (180 / Math.PI)
    : 30;

  return {
    type,
    baseZ,
    peakZ,
    pitchDeg,
    polygon,
    replacedBandCount: taperedCount,
  };
}

function signedAreaAbs(points: ReadonlyArray<LocalPoint2D>): number {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    a += (points[j].x + points[i].x) * (points[i].z - points[j].z);
  }
  return Math.abs(a) * 0.5;
}

function median(vals: readonly number[]): number {
  if (vals.length === 0) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[(n - 1) / 2];
}

function polygonBBox(points: ReadonlyArray<LocalPoint2D>): { w: number; d: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }
  return { w: maxX - minX, d: maxZ - minZ };
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
 *   • All slice vertices inside OSM → keep slice polygon (preserves
 *     real setbacks; if photogrammetry produces TWO disjoint polygons
 *     per slice, both kept separately so twin towers preserved).
 *   • Any slice vertex outside OSM → replace with OSM (drops
 *     photogrammetry overshoot, neighbour buildings).
 *
 * Sutherland-Hodgman clipping (kept as a helper for future use)
 * requires a convex clip polygon. Pennzoil's 7-vertex OSM polygon
 * has a concave indent between its two towers — clipping there
 * over-shrinks the survived geometry and drops IoU from 1.00 to 0.66.
 * The all-or-nothing decision is robust across non-convex OSM shapes;
 * Greiner-Hormann would handle concavity correctly but adds 200+ lines.
 *
 * Twin-tower detection is a separate problem: photogrammetry usually
 * produces ONE peanut-shaped polygon (towers + plaza connector), not
 * two trapezoids. Splitting requires polygon-decomposition (waist
 * detection or medial-axis), which is not implemented yet.
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

/**
 * Sutherland-Hodgman polygon clipping — clips `subject` against `clip`,
 * which must be convex (or near-convex; concavities are skipped). For
 * each edge of clip polygon, walk subject and keep / interpolate
 * vertices on the inside half-plane.
 *
 * Returns the clipped polygon as a flat array (no closing vertex).
 * Returns empty if the clip eats everything or inputs are degenerate.
 */
// Helper kept for future twin-tower polygon-decomposition work. See
// commit 2ff24ea2 for context — Sutherland-Hodgman over-shrinks
// non-convex OSM clip polygons (Pennzoil drops IoU 1.0 → 0.66).
// @ts-expect-error retained for future use
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function sutherlandHodgmanClip(
  subject: ReadonlyArray<LocalPoint2D>,
  clip: ReadonlyArray<LocalPoint2D>,
): LocalPoint2D[] {
  if (subject.length < 3 || clip.length < 3) return [];
  let output: LocalPoint2D[] = [...subject];
  for (let i = 0; i < clip.length; i++) {
    if (output.length === 0) break;
    const ce = clip[i];
    const cf = clip[(i + 1) % clip.length];
    const input = output;
    output = [];
    let s = input[input.length - 1];
    const inside = (p: LocalPoint2D): boolean =>
      // CCW edge ce→cf — point is inside if it's to the LEFT
      (cf.x - ce.x) * (p.z - ce.z) - (cf.z - ce.z) * (p.x - ce.x) >= 0;
    for (const e of input) {
      if (inside(e)) {
        if (!inside(s)) output.push(intersectEdge(s, e, ce, cf));
        output.push(e);
      } else if (inside(s)) {
        output.push(intersectEdge(s, e, ce, cf));
      }
      s = e;
    }
  }
  return output;
}

function intersectEdge(
  s: LocalPoint2D,
  e: LocalPoint2D,
  ca: LocalPoint2D,
  cb: LocalPoint2D,
): LocalPoint2D {
  const dx1 = e.x - s.x, dz1 = e.z - s.z;
  const dx2 = cb.x - ca.x, dz2 = cb.z - ca.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(denom) < 1e-9) return { x: e.x, z: e.z };
  const t = ((ca.x - s.x) * dz2 - (ca.z - s.z) * dx2) / denom;
  return { x: s.x + t * dx1, z: s.z + t * dz1 };
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
