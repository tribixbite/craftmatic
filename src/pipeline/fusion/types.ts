/**
 * JointEvidence — the single reconciled output of Stage 6 (fusion).
 *
 * Each field stores `{value, source, confidence}` so synthesis can both read
 * the canonical value and know where it came from / how much to trust it.
 */

import type { LatLon, Lab, RoofShape } from '../context/types.js';

export type EvidenceSource =
  | 'tiles'
  | 'osm'
  | 'solar'
  | 'sv'
  | 'sat'
  | 'smarty'
  | 'inferred';

export interface Evidence<T> {
  readonly value: T;
  readonly source: EvidenceSource;
  /** 0-1. 1 = sourced from authoritative data; 0 = pure default. */
  readonly confidence: number;
}

export interface TreeInstance {
  readonly position: LatLon;
  readonly radiusM: number;
  readonly source: 'osm' | 'sv' | 'sat';
}

export interface RoadSegment {
  readonly polyline: readonly LatLon[];
  readonly widthM: number;
  readonly type: string;
}

export interface JointEvidence {
  readonly footprint: Evidence<readonly LatLon[]>;
  readonly heightM: Evidence<number>;
  readonly levels: Evidence<number>;
  readonly wallPalette: Evidence<readonly Lab[]>;
  readonly roofPalette: Evidence<readonly Lab[]>;
  readonly roofShape: Evidence<RoofShape>;
  /** Per-facade window grid. Array index = MBR edge (0-3). `null` entry = no detection. */
  readonly windowGrid: ReadonlyArray<Evidence<{ readonly rows: number; readonly cols: number }> | null>;
  readonly cornice: Evidence<boolean>;
  readonly entry: Evidence<{ readonly edge: number; readonly offsetAlongEdge: number }>;
  readonly trees: readonly TreeInstance[];
  readonly roads: readonly RoadSegment[];
}
