/**
 * Stages 0-1 resolver + MBR fallback chain.
 *
 * Responsibilities:
 *   • Stage 0 — geocode address → lat/lng + viewport
 *   • Stage 1 — parallel fetch Solar + OSM + Smarty (cheap, no inter-dep)
 *   • Stage 2 — classify + compute MBR → `BuildingContext`
 *
 * The `mbr` field is always non-null. Fallback chain:
 *   OSM polygon → Solar bbox rectangle → geocode viewport → throw 'context-insufficient'
 */

import {
  computeBuildingAlignment,
  type BuildingAlignment,
} from '../../convert/building-alignment.js';
import type { SolarBuildingData } from '../../gen/api/google-solar.js';
import type { OSMBuildingData } from '../../gen/api/osm.js';
import type {
  BuildingContext,
  GeocodeResult,
  LatLon,
  MBR,
  SiblingBuilding,
} from './types.js';
import {
  classifyArchType,
  classifyShape,
  classifySize,
  classifySvDifficulty,
  isCampusCluster,
} from './classify.js';

// ─── Geo helpers ────────────────────────────────────────────────────────────

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_111;

/** Haversine distance between two lat/lon points, metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const φ1 = a.lat * DEG2RAD;
  const φ2 = b.lat * DEG2RAD;
  const dφ = (b.lat - a.lat) * DEG2RAD;
  const dλ = (b.lon - a.lon) * DEG2RAD;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Compute MBR from an OSM polygon (uses existing convex-hull MBR algorithm). */
export function computeMbrFromPolygon(
  polygon: readonly LatLon[],
  center: LatLon,
): MBR {
  const align: BuildingAlignment = computeBuildingAlignment(
    polygon as LatLon[],
    center.lat,
    center.lon,
  );
  return mbrFromAlignment(align, center);
}

/** Derive four corner LatLons from a rotated MBR centred at `center`. */
function mbrFromAlignment(align: BuildingAlignment, center: LatLon): MBR {
  const cosLat = Math.cos(center.lat * DEG2RAD);
  const rot = align.rotationDeg * DEG2RAD;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const halfW = align.mbrWidth / 2;
  const halfD = align.mbrDepth / 2;
  // Four corners in local metres (X=east, Z=south); rotate + translate
  const corners: LatLon[] = [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ].map(([x, z]) => {
    const rx = x * cos - z * sin;
    const rz = x * sin + z * cos;
    return {
      lat: center.lat - rz / METERS_PER_DEG_LAT,
      lon: center.lon + rx / (METERS_PER_DEG_LAT * cosLat),
    };
  });
  return {
    rotationDeg: align.rotationDeg,
    widthM: align.mbrWidth,
    depthM: align.mbrDepth,
    corners: corners as unknown as MBR['corners'],
  };
}

/** Axis-aligned MBR from an arbitrary lat/lng bounding box. */
export function computeMbrFromBbox(
  sw: LatLon,
  ne: LatLon,
): MBR {
  const center = { lat: (sw.lat + ne.lat) / 2, lon: (sw.lon + ne.lon) / 2 };
  const widthM = haversineM({ lat: center.lat, lon: sw.lon }, { lat: center.lat, lon: ne.lon });
  const depthM = haversineM({ lat: sw.lat, lon: center.lon }, { lat: ne.lat, lon: center.lon });
  const corners: LatLon[] = [
    { lat: sw.lat, lon: sw.lon },
    { lat: sw.lat, lon: ne.lon },
    { lat: ne.lat, lon: ne.lon },
    { lat: ne.lat, lon: sw.lon },
  ];
  return {
    rotationDeg: 0,
    widthM: Math.max(widthM, depthM),
    depthM: Math.min(widthM, depthM),
    corners: corners as unknown as MBR['corners'],
  };
}

export class ContextInsufficientError extends Error {
  constructor(public readonly reason: string) {
    super(`context-insufficient: ${reason}`);
    this.name = 'ContextInsufficientError';
  }
}

/**
 * Fallback chain: OSM polygon → Solar bbox → geocode viewport →
 * throws ContextInsufficientError.
 *
 * The viewport fallback only applies when the geocode located a specific
 * address (`ROOFTOP` or `RANGE_INTERPOLATED`) and the viewport is small
 * enough (<500m on a side) to plausibly represent one building. City-scale
 * viewports (>500m) trigger context-insufficient rather than a silent
 * 25m generic box.
 */
export interface MbrFallbackInput {
  readonly polygon: readonly LatLon[] | null;
  readonly solarBounds: { readonly sw: LatLon; readonly ne: LatLon } | null;
  readonly geocode: GeocodeResult;
  readonly center: LatLon;
}

export function resolveMbr(input: MbrFallbackInput): { mbr: MBR; source: 'osm' | 'solar-bbox' | 'inferred' } {
  if (input.polygon && input.polygon.length >= 3) {
    return { mbr: computeMbrFromPolygon(input.polygon, input.center), source: 'osm' };
  }
  if (input.solarBounds) {
    return { mbr: computeMbrFromBbox(input.solarBounds.sw, input.solarBounds.ne), source: 'solar-bbox' };
  }
  const vp = input.geocode.viewport;
  const isAddressLevel = input.geocode.locationType === 'ROOFTOP'
                      || input.geocode.locationType === 'RANGE_INTERPOLATED';
  if (vp && isAddressLevel) {
    const mbr = computeMbrFromBbox(vp.sw, vp.ne);
    if (mbr.widthM < 500 && mbr.depthM < 500) {
      return { mbr, source: 'inferred' };
    }
  }
  throw new ContextInsufficientError(
    input.geocode.locationType === 'APPROXIMATE'
      ? 'geocode too imprecise (APPROXIMATE) and no polygon/solar bbox available'
      : 'no OSM polygon, no Solar bbox, viewport too large (>500m)',
  );
}

// ─── Sibling detection ──────────────────────────────────────────────────────

export function deriveSiblings(
  primaryPolygon: readonly LatLon[] | null,
  candidates: ReadonlyArray<{ polygon: readonly LatLon[]; tags: Record<string, string> }>,
): readonly SiblingBuilding[] {
  if (!primaryPolygon || primaryPolygon.length === 0) return [];
  return candidates.map(c => {
    let minDist = Infinity;
    for (const p of primaryPolygon) {
      for (const q of c.polygon) {
        const d = haversineM(p, q);
        if (d < minDist) minDist = d;
      }
    }
    return { polygon: c.polygon, tags: c.tags, distanceM: minDist };
  });
}

// ─── Height + levels resolution ─────────────────────────────────────────────

export interface HeightResolution {
  readonly heightM: number | null;
  readonly heightSource: BuildingContext['heightSource'];
  readonly levels: number | null;
}

export function resolveHeight(
  solar: SolarBuildingData | null,
  osm: OSMBuildingData | null,
): HeightResolution {
  // Priority: solar > osm-levels > null. Smarty can override in later pass.
  const solarHeight = (solar as unknown as { estimatedHeightM?: number | null })?.estimatedHeightM ?? null;
  const osmLevels = (osm as unknown as { levels?: number | null })?.levels ?? null;
  const osmHeightM = (osm as unknown as { height?: number | null })?.height ?? null;

  if (osmHeightM && osmHeightM > 0) {
    return { heightM: osmHeightM, heightSource: 'osm-levels', levels: osmLevels };
  }
  if (solarHeight && solarHeight > 0) {
    return { heightM: solarHeight, heightSource: 'solar', levels: osmLevels };
  }
  if (osmLevels && osmLevels > 0) {
    return { heightM: osmLevels * 3.5, heightSource: 'osm-levels', levels: osmLevels };
  }
  return { heightM: null, heightSource: null, levels: null };
}

// ─── Top-level context builder (pure — no I/O) ──────────────────────────────

export interface BuildContextInput {
  readonly geocode: GeocodeResult;
  readonly solar: SolarBuildingData | null;
  readonly osm: OSMBuildingData | null;
  readonly smarty: NonNullable<BuildingContext['rawSmarty']> | null;
  readonly siblings: readonly SiblingBuilding[];
  readonly buildingParts?: BuildingContext['buildingParts'];
  /** Optional — when true-SV-coverage absence is known a priori. */
  readonly knownNoSvCoverage?: boolean;
}

/**
 * Pure constructor — takes already-fetched data, produces the `BuildingContext`.
 * Throws `ContextInsufficientError` when MBR cannot be resolved.
 */
export function buildBuildingContext(input: BuildContextInput): BuildingContext {
  const center: LatLon = { lat: input.geocode.lat, lon: input.geocode.lng };
  const polygon = input.osm?.polygon && input.osm.polygon.length >= 3
    ? (input.osm.polygon as readonly LatLon[])
    : null;

  const solarBounds = input.solar?.buildingBounds
    ? {
        sw: { lat: input.solar.buildingBounds.sw.lat, lon: input.solar.buildingBounds.sw.lng },
        ne: { lat: input.solar.buildingBounds.ne.lat, lon: input.solar.buildingBounds.ne.lng },
      }
    : null;

  const { mbr, source: polygonSource } = resolveMbr({
    polygon,
    solarBounds,
    geocode: input.geocode,
    center,
  });

  const isCampus = isCampusCluster(input.siblings);
  const size = classifySize(mbr.widthM, mbr.depthM, isCampus);
  const shape = polygon
    ? classifyShape({ polygon })
    : 'rect'; // no polygon → default assumption

  const svDifficulty = classifySvDifficulty({
    center: { lat: center.lat, lng: center.lon },
    osm: input.osm,
    knownNoCoverage: input.knownNoSvCoverage,
  });
  const archType = classifyArchType(input.osm);

  let { heightM, heightSource, levels } = resolveHeight(input.solar, input.osm);
  // Compound buildings: when OSM `building:part` tags provide heights,
  // use the tallest part as the building's height (Pennzoil's twin
  // towers are 151m, taller than the parent's 36-level estimate).
  // Filter parts to those whose centroid sits inside the primary
  // OSM polygon so neighbour parts don't contaminate.
  //
  // Plausibility: only override an existing surveyed height when the
  // parts-tallest is within 1.5× of it (Pennzoil 36-level → 126m,
  // parts max 151m, ratio 1.20 — passes). Without this, Flatiron's
  // 9-part query — which returns several neighbouring building parts
  // with centroids that happen to fall inside the wedge — would push
  // ctx.heightM up to 95m vs the actual 87m, causing h_err=21%.
  if (input.buildingParts && input.buildingParts.length > 0 && polygon) {
    let tallest = 0;
    const ptInPoly = (px: number, py: number, poly: readonly { lat: number; lon: number }[]): boolean => {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].lon, yi = poly[i].lat;
        const xj = poly[j].lon, yj = poly[j].lat;
        const intersect = ((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    };
    const polyAreaAbs = (poly: readonly { lat: number; lon: number }[]): number => {
      let a = 0;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        a += (poly[j].lon + poly[i].lon) * (poly[i].lat - poly[j].lat);
      }
      return Math.abs(a) * 0.5;
    };
    const osmA = polyAreaAbs(polygon);
    // Pre-filter: parts whose centroid+vertices land inside primary polygon
    const qualified: Array<{ heightM: number; coverage: number }> = [];
    for (const part of input.buildingParts) {
      if (!part.heightM || !Number.isFinite(part.heightM)) continue;
      let cx = 0, cy = 0;
      for (const p of part.polygon) { cx += p.lon; cy += p.lat; }
      cx /= part.polygon.length; cy /= part.polygon.length;
      if (!ptInPoly(cx, cy, polygon)) continue;
      let insideVerts = 0;
      for (const v of part.polygon) {
        if (ptInPoly(v.lon, v.lat, polygon)) insideVerts++;
      }
      // 0.5 threshold: tower polygons may extend slightly beyond the
      // overarching `building` polygon (OSM mappers don't always align
      // them perfectly). Stricter 0.8 threshold rejected real towers.
      if (insideVerts / part.polygon.length < 0.5) continue;
      const coverage = osmA > 0 ? polyAreaAbs(part.polygon) / osmA : 1;
      qualified.push({ heightM: part.heightM, coverage });
    }
    // Compound discriminator: ≥2 qualified parts, each <60% coverage.
    // Same heuristic the synthesizer applies.
    const isCompound = qualified.length >= 2 && qualified.every(p => p.coverage < 0.6);
    console.error(`  [resolver] buildingParts=${input.buildingParts.length} qualified=${qualified.length} isCompound=${isCompound} coverage=${qualified.map(p => p.coverage.toFixed(2)).join(',')}`);
    if (isCompound) {
      for (const q of qualified) if (q.heightM > tallest) tallest = q.heightM;
    }
    const surveyed = heightM ?? 0;
    const plausible = surveyed === 0 || (tallest >= surveyed * 0.7 && tallest <= surveyed * 1.5);
    if (tallest > surveyed && plausible) {
      heightM = tallest;
      heightSource = 'osm-levels';
    }
  }

  const tags = input.osm?.tags ?? {};

  return {
    center: { lat: center.lat, lng: center.lon },
    polygon,
    polygonSource,
    geocodeLocationType: input.geocode.locationType,
    mbr,
    heightM,
    heightSource,
    levels,
    roofShape: roofShapeFromTags(tags),
    roofPitchDeg: null,
    size,
    shape,
    svDifficulty,
    archType,
    wallColourHint: tags['building:colour'] ?? tags['building:color'] ?? null,
    roofColourHint: tags['roof:colour'] ?? tags['roof:color'] ?? null,
    wallMaterialHint: tags['building:material'] ?? null,
    roofMaterialHint: tags['roof:material'] ?? null,
    groundElevationM: 0,
    isSloped: false,
    slopeVector: null,
    isCampus,
    siblingBuildings: input.siblings,
    rawSolar: input.solar,
    rawOsm: input.osm,
    rawSmarty: input.smarty,
    buildingParts: input.buildingParts ?? [],
  };
}

// ─── Full resolveContext orchestrator (Stages 0-2) ────────────────────────
// Takes injectable fetchers so tests can stub without touching fetch().

export interface ContextFetchers {
  readonly geocode: (address: string) => Promise<GeocodeResult>;
  readonly solar: (lat: number, lng: number) => Promise<SolarBuildingData | null>;
  readonly osm: (lat: number, lng: number) => Promise<OSMBuildingData | null>;
  /**
   * OSM sibling query — all building polygons within `radiusM` of `center`,
   * excluding the primary. Returns raw polygon + tags for campus detection.
   */
  readonly osmSiblings: (lat: number, lng: number, radiusM: number) => Promise<ReadonlyArray<{
    polygon: readonly LatLon[];
    tags: Record<string, string>;
  }>>;
  /**
   * OSM building:part query — compound buildings (Pennzoil Place, ESB)
   * tag each tower with its own height/roof/colour. Optional fetcher
   * (defaults to empty list for callers that don't wire it).
   */
  readonly osmBuildingParts?: (lat: number, lng: number, radiusM: number) => Promise<BuildingContext['buildingParts']>;
  readonly smarty: (address: string) => Promise<BuildingContext['rawSmarty']>;
}

export interface ResolveContextOptions {
  readonly knownNoSvCoverage?: boolean;
  /** Sibling search radius in metres for campus detection. */
  readonly siblingRadiusM?: number;
}

/**
 * Stage 0-2 orchestrator. Stage 1 parallel-fetches the metadata (Solar/OSM/
 * Smarty) because none of them informs another; that is a pre-classification
 * fan-out, not the sequential capture loop (see spec §Decisions).
 */
export async function resolveContext(
  address: string,
  fetchers: ContextFetchers,
  opts: ResolveContextOptions = {},
): Promise<BuildingContext> {
  // Stage 0
  const geocode = await fetchers.geocode(address);

  // Stage 1 — parallel, independent
  const [solar, osm, smarty] = await Promise.all([
    fetchers.solar(geocode.lat, geocode.lng).catch(() => null),
    fetchers.osm(geocode.lat, geocode.lng).catch(() => null),
    fetchers.smarty(address).catch(() => null),
  ]);

  // Sibling fetch (only when we have a polygon to compare against)
  let siblings: readonly SiblingBuilding[] = [];
  if (osm?.polygon && osm.polygon.length >= 3) {
    const raw = await fetchers.osmSiblings(
      geocode.lat,
      geocode.lng,
      opts.siblingRadiusM ?? 60,
    ).catch(() => [] as ReturnType<ContextFetchers['osmSiblings']> extends Promise<infer U> ? U : never);
    siblings = deriveSiblings(osm.polygon as readonly LatLon[], raw);
  }

  // Compound building parts (Pennzoil-style twin towers etc.)
  const buildingParts = fetchers.osmBuildingParts
    ? await fetchers.osmBuildingParts(geocode.lat, geocode.lng, 100).catch(() => [])
    : [];

  // Stage 2
  return buildBuildingContext({
    geocode,
    solar,
    osm,
    smarty,
    siblings,
    buildingParts,
    knownNoSvCoverage: opts.knownNoSvCoverage,
  });
}

function roofShapeFromTags(tags: Record<string, string>): BuildingContext['roofShape'] {
  const raw = tags['roof:shape'];
  switch (raw) {
    case 'flat': return 'flat';
    case 'gabled': return 'gabled';
    case 'hipped': return 'hipped';
    case 'pyramidal': return 'pyramidal';
    case 'dome': return 'dome';
    case 'mansard': return 'mansard';
    case 'shed':
    case 'skillion': return 'shed';
    default: return 'flat'; // safer default for mixed-use; can refine per archType
  }
}
