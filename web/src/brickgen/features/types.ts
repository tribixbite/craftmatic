/**
 * Feature-stage types (A09, BIZ-05): the annotation sidecar format and the inputs/outputs of `buildFeatureSet`.
 *
 * The brickgen contract types (`FeatureSpec`, `FeatureSet`, `FacadeAnnotation`, ...) live in `../types.ts` and are
 * not changed here. This file adds what a JSON annotation sidecar needs beyond `FacadeAnnotation` (which has only
 * `edge`, `rectifiedScale` and marks in pixels): the image size, how pixels map to the facade (horizontal span and
 * a ground row) and which massing volume the facade belongs to. A sidecar facade entry is a superset of a
 * `FacadeAnnotation`, so `toFacadeAnnotation` can hand one to `SiteEvidence.annotations`.
 *
 * Coordinates (one place):
 *  - pixels: origin top-left, x right, y DOWN, in the rectified image the reviewer marked;
 *  - plan metres: the MASSING frame (x east, z south, minimum corner at the origin), y up;
 *  - an edge feature's `atM` is `[along-edge centre, bottom height, 0]`, a world feature's is `[x, bottom y, z]`.
 */
import type { FacadeAnnotation, FeatureKind, FeatureSpec, InputLicence, SourceRef, StyleProfile } from '../types.js';

/** Schema tag every sidecar carries; bump the trailing number on a breaking change. */
export const SIDECAR_SCHEMA = 'craftmatic.facade-annotations/1';

/** Compass side a facade looks towards, in the massing frame (west = -x, north = -z). */
export type Facing = 'north' | 'south' | 'east' | 'west';

/** One thing a reviewer marked on a facade image. */
export interface AnnotationMark {
  /** Stable within the sidecar, e.g. `"rose-west"`; shown in reports. */
  id: string;
  kind: FeatureKind;
  /** `[x0, y0, x1, y1]` pixels, any corner order. For `count > 1` the box spans the WHOLE run. */
  boxPx: [number, number, number, number];
  /** Items in the run (a row of windows, an arcade, a gallery of statues). Default 1. */
  count?: number;
  /** Depth into/out of the wall in metres; default from `DEFAULT_DEPTH_M`. */
  depthM?: number;
  /** 0..1; defaults to the source's authority (drawing 0.95, photo 0.9). */
  confidence?: number;
  note?: string;
}

/** How the image's pixels map onto the facade. */
export interface FacadeCalibration {
  /**
   * Pixel columns `[x0, x1]` that span the facade's full width: the edge from its start to its end (or, with
   * `facing`, the volume's whole face from its left end to its right end). Sets the horizontal scale from the
   * massing itself, so a slightly foreshortened photo still lands every mark on the model's stud grid.
   */
  spanPx?: [number, number];
  /** Pixel row of the ground (or of the volume's base). */
  groundRowPx: number;
  /** A second known height: pixel row `rowPx` is `heightM` above the ground. Sets the vertical scale. */
  heightRef?: { rowPx: number; heightM: number };
  /** Metres per pixel when neither `spanPx` nor `heightRef` can give a scale (the `FacadeAnnotation` field). */
  rectifiedScale?: number;
  /** Height of the ground row above the model's zero; default the volume's `baseM`. */
  groundHeightM?: number;
}

/** One rectified facade image with its marks. */
export interface FacadeEntry {
  id: string;
  /** `SourceRef` id of the photo or drawing (must be in the sidecar's `sources`). */
  source: string;
  /** A massing volume id (`vol-way-123`) or an OSM part id (`way/123`). */
  volume: string;
  /** Index into the volume's `outer` ring: edge `i` runs from `outer[i]` to `outer[i + 1]`. */
  edge?: number;
  /** Alternative to `edge`: the compass side; the ring edge each mark lands on is chosen per mark. */
  facing?: Facing;
  /** Image x runs from the edge's END to its start (explicit `edge`), or the opposite way round (`facing`). */
  mirror?: boolean;
  image: { widthPx: number; heightPx: number };
  calibration: FacadeCalibration;
  marks: AnnotationMark[];
  note?: string;
}

/** Colours the reviewer read off the sources (hex), mapped to LDraw colours by `style.ts`. */
export interface SidecarStyle {
  wall?: string;
  trim?: string;
  roof?: string;
  accents?: string[];
  era?: string;
}

/** The JSON annotation sidecar written beside licensed photos/drawings. */
export interface AnnotationSidecar {
  schema: typeof SIDECAR_SCHEMA;
  /** Working title of the site, never a LEGO set name. */
  site: string;
  /** Every photo/drawing used, each with url, author (`attribution`) and licence. */
  sources: SourceRef[];
  style?: SidecarStyle;
  facades: FacadeEntry[];
  /** Free-text caveats (approximations, what was not marked). */
  notes?: string[];
}

/** Where a feature came from; the order is the precedence (annotation beats mesh beats tags). */
export type FeatureOrigin = 'annotation' | 'mesh' | 'tags';

/** A feature with its origin, before precedence is applied. */
export interface OriginFeature {
  origin: FeatureOrigin;
  spec: FeatureSpec;
  /** Mark/part id it came from, for reports. */
  ref: string;
}

/** An automatic feature dropped because a higher-authority one covers it. */
export interface SupersededFeature {
  dropped: OriginFeature;
  by: OriginFeature;
}

/** Default depth (m) of a feature when the mark gives none. */
export const DEFAULT_DEPTH_M: Readonly<Record<FeatureKind, number>> = {
  window: 0.5, lancet: 0.6, rose: 0.8, door: 0.4, portal: 1.5, arcade: 1.2, column: 0.6, pilaster: 0.4,
  buttress: 3, 'flying-buttress': 1.5, cornice: 0.8, balustrade: 0.5, pinnacle: 1, gargoyle: 1, clock: 0.3,
  spire: 0, dome: 0, lantern: 0, battlement: 0.6, chimney: 0, balcony: 1.2, stair: 1.5, lattice: 0.5, cable: 0.2, statue: 0.5,
};

/** Authority of a source kind, used as the default confidence of an annotation. */
export const SOURCE_AUTHORITY: Readonly<Partial<Record<SourceRef['kind'], number>>> = { drawing: 0.95, photo: 0.9, measurement: 0.95 };

/** Converts a sidecar facade entry to the contract's `FacadeAnnotation` (edge -1 = resolved from `facing`). */
export function toFacadeAnnotation(f: FacadeEntry, scaleMPerPx: number): FacadeAnnotation {
  return {
    source: f.source,
    edge: f.edge ?? -1,
    rectifiedScale: scaleMPerPx,
    marks: f.marks.map(m => ({ kind: m.kind, boxPx: [...m.boxPx] as [number, number, number, number], note: m.note })),
  };
}

export type { FeatureKind, FeatureSpec, InputLicence, SourceRef, StyleProfile };
