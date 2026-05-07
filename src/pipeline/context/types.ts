/**
 * Types for the resolver / classify / profile layer (Stages 0-2).
 * Per spec §Core datatypes.
 */

import type { LatLon } from '../../convert/building-alignment.js';
import type { OSMBuildingData } from '../../gen/api/osm.js';
import type { SolarBuildingData } from '../../gen/api/google-solar.js';
import type { SmartyPropertyData } from '../../gen/api/smarty.js';

export type { LatLon } from '../../convert/building-alignment.js';

/** Local flat-plane coordinates; x+ east, z+ south, origin at building centre. */
export interface LocalPoint2D {
  readonly x: number;
  readonly z: number;
}

/** CIE-Lab colour using the project's tuple convention. */
export type Lab = readonly [L: number, a: number, b: number];

/** Geocode output (subset the pipeline uses). */
export interface GeocodeResult {
  readonly lat: number;
  readonly lng: number;
  readonly formattedAddress: string;
  readonly placeId: string | null;
  readonly locationType: 'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE';
  readonly viewport: { readonly sw: LatLon; readonly ne: LatLon } | null;
  readonly bounds: { readonly sw: LatLon; readonly ne: LatLon } | null;
}

export type BuildingSize = 'tiny' | 'small' | 'medium' | 'large' | 'skyscraper' | 'campus';

export type BuildingShape =
  | 'rect'
  | 'wedge'
  | 'U'
  | 'courtyard'
  | 'multi-wing'
  | 'tower-podium'
  | 'curved'
  | 'irregular';

export type SvDifficulty = 'dense-urban' | 'suburban' | 'rural-occluded' | 'no-coverage';

export type ArchType = 'residential' | 'commercial' | 'civic' | 'industrial' | 'historic' | 'religious';

export type RoofShape =
  | 'flat'
  | 'gabled'
  | 'hipped'
  | 'pyramidal'
  | 'dome'
  | 'mansard'
  | 'shed'
  | 'complex';

/** Minimum-bounding-rectangle for the footprint, oriented and sized. */
export interface MBR {
  /** Primary axis rotation from north, degrees. */
  readonly rotationDeg: number;
  readonly widthM: number;
  readonly depthM: number;
  /** Four corners in order. */
  readonly corners: readonly [LatLon, LatLon, LatLon, LatLon];
}

export interface SiblingBuilding {
  readonly polygon: readonly LatLon[];
  readonly tags: Record<string, string>;
  /** Edge-to-edge distance from primary footprint, metres. */
  readonly distanceM: number;
}

/**
 * Canonical resolver output. Single source of truth for every downstream stage.
 *
 * Invariants (spec §Key invariants):
 *   • Resolver runs once; no downstream module re-derives these fields.
 *   • `shape` may be refined to `'tower-podium'` by `refineContextWithTiles()` —
 *     that is the ONE exception to the "resolver runs once" rule, scoped and
 *     documented. All other fields are immutable after Stage 2.
 */
export interface BuildingContext {
  readonly center: { readonly lat: number; readonly lng: number };

  /** Footprint polygon if OSM or Solar provided one. */
  readonly polygon: readonly LatLon[] | null;
  readonly polygonSource: 'osm' | 'solar-bbox' | 'inferred';
  readonly mbr: MBR;

  /** Best-estimate height in metres. Null when no source provides height. */
  readonly heightM: number | null;
  readonly heightSource: 'tiles' | 'solar' | 'osm-levels' | 'smarty' | null;
  readonly levels: number | null;

  readonly roofShape: RoofShape;
  readonly roofPitchDeg: number | null;

  readonly size: BuildingSize;
  readonly shape: BuildingShape;
  readonly svDifficulty: SvDifficulty;
  readonly archType: ArchType;

  /** OSM / SV / Smarty palette hints (raw strings to be resolved downstream). */
  readonly wallColourHint: string | null;
  readonly roofColourHint: string | null;
  readonly wallMaterialHint: string | null;
  readonly roofMaterialHint: string | null;

  readonly groundElevationM: number;
  /** >3° slope across the footprint. */
  readonly isSloped: boolean;
  readonly slopeVector: { readonly dx: number; readonly dy: number } | null;

  readonly isCampus: boolean;
  readonly siblingBuildings: readonly SiblingBuilding[];

  readonly rawSolar: SolarBuildingData | null;
  readonly rawOsm: OSMBuildingData | null;
  readonly rawSmarty: SmartyPropertyData | null;
  /**
   * Compound building parts from OSM `building:part` tags. Empty for
   * single-volume buildings. Pennzoil Place returns 2 entries (one per
   * tower) with own height/colour/roof. The sliced-tiles synthesizer
   * uses these to mask each part separately and union into a single
   * BRep with multiple disjoint silhouettes.
   */
  readonly buildingParts: ReadonlyArray<{
    readonly polygon: readonly LatLon[];
    readonly heightM: number | null;
    readonly levels: number | null;
    readonly buildingColour: string | null;
    readonly roofColour: string | null;
    readonly roofShape: string | null;
    readonly tags: Record<string, string>;
  }>;
}

/**
 * Branded refined context — produced by `refineContextWithTiles()`, consumed by
 * the synthesis router. The brand makes it a compile-time error to pass an
 * unrefined `BuildingContext` where a refined one is required.
 */
export type RefinedBuildingContext = BuildingContext & { readonly __refined: true };

/** Draft context before Stage 2 classification — all classifier fields undefined. */
export interface ContextDraft {
  readonly center: BuildingContext['center'];
  readonly geocode: GeocodeResult;
  readonly rawSolar: SolarBuildingData | null;
  readonly rawOsm: OSMBuildingData | null;
  readonly rawSmarty: SmartyPropertyData | null;
  readonly siblingBuildings: readonly SiblingBuilding[];
}

// ─── CaptureProfile ─────────────────────────────────────────────────────────

export interface CaptureProfile {
  readonly tiles: {
    readonly radiusM: number;
    readonly errorTarget: number;
    readonly verticalBands: number;
    readonly cameraMode: 'ortho' | 'perspective' | 'street';
    readonly expectedHeightM: number;
  };
  readonly streetview: {
    readonly dirCount: number;
    readonly offsetM: number;
    readonly maxPanoDistM: number;
    readonly angleVariants: readonly number[];
    readonly minBuildingPixelRatio: number;
    readonly pitchDeg: number;
  };
  readonly satellite: {
    readonly scale: 1 | 2;
    readonly maskTrees: boolean;
  };
}

// ─── Material reference (shared by synthesis + export) ──────────────────────

/**
 * Unified material handle: Minecraft block name + a future glTF material slot +
 * the resolved Lab colour. Downstream synthesis / export adapters each read the
 * fields they need.
 */
export interface MaterialRef {
  readonly blockName: string;
  readonly lab: Lab;
  /** Reserved for Chunk 7 — glTF material definition. */
  readonly glbMaterial?: unknown;
}
