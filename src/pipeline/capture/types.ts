/**
 * Types for tile / SV / satellite capture evidence.
 * Per spec §Core datatypes.
 */

import type * as THREE from 'three';

// ─── TileEvidence (Stage 3) ─────────────────────────────────────────────────

export interface TileEvidence {
  /**
   * Path to the captured GLB on disk. Populated when `captureTiles()` is called
   * with an `outputPath` option; null when running fully in-memory (browser).
   */
  readonly glbPath: string | null;
  /** In-memory GLB bytes. Always populated. */
  readonly glbBytes: ArrayBuffer;
  /**
   * 1-sample-per-metre ground heightmap. Indexed `z * width + x`. Each cell
   * holds the minimum Y value observed at that XZ column, normalised to
   * `heightmap[i] - minY` so the ground plane is at 0.
   */
  readonly heightmap: Float32Array;
  readonly heightmapWidth: number;
  readonly heightmapLength: number;
  /** Measured axis-aligned bounding box of all captured meshes, in scene-metres. */
  readonly measuredBbox: {
    readonly min: { readonly x: number; readonly y: number; readonly z: number };
    readonly max: { readonly x: number; readonly y: number; readonly z: number };
  };
  /** `captured.y` < 0.6 × `ctx.heightM` → height truncation likely */
  readonly truncated: boolean;
  readonly meshCount: number;
  /** `meshCount < 3` — scene extraction failed, fallback needed */
  readonly noCoverage: boolean;
  /**
   * Per-mesh positions + indices in scene-local metres (Y is up). Optional
   * because the browser path can omit it when the caller doesn't need slice
   * extraction. When present, `synthesis/router` routes through the
   * sliced-band synthesizer instead of single-prism cleaned-tiles.
   */
  readonly meshes?: ReadonlyArray<{
    readonly positions: Float32Array;
    readonly indices: Uint32Array;
  }>;
}

// ─── SvEvidence (Stage 4) ──────────────────────────────────────────────────
// Full shape wired in Chunk 3.

export type OcclusionKind = 'none' | 'trees' | 'adjacent-building' | 'poles';

export interface SvFacadeEvidence {
  readonly facadeEdge: number;
  readonly imagePath: string | null;
  readonly imageBytes: ArrayBuffer;
  readonly panoId: string;
  readonly panoDistM: number;
  readonly headingDeg: number;
  readonly fovDeg: number;
  readonly pitchDeg: number;
  readonly sniff: {
    readonly sky: number;
    readonly veg: number;
    readonly building: number;
  };
  readonly palette: {
    readonly wall: readonly [number, number, number];
    readonly trim: readonly [number, number, number];
    readonly accent: readonly [number, number, number] | null;
  };
  readonly windowGrid: {
    readonly rows: number;
    readonly cols: number;
    readonly confidence: number;
  } | null;
  readonly cornice: boolean;
  readonly occlusion: OcclusionKind;
  readonly confidence: number;
}

export type SvEvidence = readonly SvFacadeEvidence[];

// ─── SatEvidence (Stage 5) ─────────────────────────────────────────────────

export interface SatEvidence {
  readonly imagePath: string | null;
  readonly hiresImagePath: string | null;
  readonly imageBytes: ArrayBuffer;
  readonly hiresImageBytes: ArrayBuffer | null;
  readonly zoom: number;
  readonly treeMask: Uint8Array;
  readonly treeMaskDim: { readonly w: number; readonly h: number };
  readonly roofPalette: {
    readonly primary: readonly [number, number, number];
    readonly secondary: readonly [number, number, number] | null;
  };
  /** True when roof sampling was masked to the building footprint. When
   *  false, fusion distrusts vegetation-green "roof" colours (lawn risk). */
  readonly roofPaletteMaskedToFootprint?: boolean;
  readonly shadowAzimuthDeg: number | null;
}

// ─── Capture callbacks / options ───────────────────────────────────────────

export interface CaptureProgress {
  readonly stage: 'tiles' | 'sv' | 'satellite' | 'fusion' | 'synthesis' | 'export' | 'verify';
  readonly message: string;
  /** 0-1 approximate progress through this stage. */
  readonly ratio?: number;
}

export type CaptureProgressFn = (p: CaptureProgress) => void;

/** Abstracts the THREE namespace so capture code can be unit-tested without three. */
export type ThreeNamespace = typeof THREE;
