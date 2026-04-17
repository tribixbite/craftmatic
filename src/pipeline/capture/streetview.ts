/**
 * Stage 4 — Street View iterative capture.
 *
 * For each of `profile.streetview.dirCount` directions:
 *   1. Metadata probe at 1.0× / 0.5× / 1.5× offset — accept first usable pano
 *   2. Compute heading (pano → centre) + FOV (from facade width and pano dist)
 *   3. Fetch primary image, sniff sky/veg/building ratios
 *   4. If occluded (building% < threshold), try `angleVariants` — keep best
 *   5. Classify occlusion → `SvFacadeEvidence`
 *
 * All network access goes through injected `StreetViewFetchers` so tests can
 * stub without mocking global `fetch`.
 */

import type { BuildingContext, CaptureProfile } from '../context/types.js';
import type { OcclusionKind, SvEvidence, SvFacadeEvidence, CaptureProgressFn } from './types.js';
import { sniffPixels, decodeImageToRgba, type SniffRatios } from './sv-sniff.js';

async function imageToSniff(img: SvImageFetch): Promise<SniffRatios> {
  if (img.rgba) {
    return sniffPixels(img.rgba, img.width, img.height, 4).ratios;
  }
  const dec = await decodeImageToRgba(img.bytes);
  return sniffPixels(dec.pixels, dec.width, dec.height).ratios;
}

// ─── Fetcher interface ─────────────────────────────────────────────────────

export interface SvMetadata {
  readonly panoId: string;
  readonly panoLat: number;
  readonly panoLng: number;
}

export interface SvImageFetch {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /**
   * Optional pre-decoded RGBA pixels. When present, `sniffPixels` uses these
   * directly; when absent, `bytes` is decoded via sharp. Real fetchers leave
   * this undefined; test stubs can populate it to avoid the sharp dependency.
   */
  readonly rgba?: Uint8Array;
}

export interface StreetViewFetchers {
  /** Query Google SV Metadata API at a query point. Returns null on no coverage. */
  readonly metadata: (lat: number, lng: number) => Promise<SvMetadata | null>;
  /** Fetch a SV image for a given pano at explicit heading / fov / pitch. */
  readonly image: (
    panoId: string,
    heading: number,
    fov: number,
    pitch: number,
  ) => Promise<SvImageFetch>;
}

// ─── Geo helpers (inlined for speed — tiny scope) ──────────────────────────

const DEG2RAD = Math.PI / 180;
const METERS_PER_DEG_LAT = 111_111;

function metersToDegLat(m: number): number { return m / METERS_PER_DEG_LAT; }
function metersToDegLon(m: number, lat: number): number {
  return m / (METERS_PER_DEG_LAT * Math.cos(lat * DEG2RAD));
}

function haversineM(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const φ1 = lat1 * DEG2RAD, φ2 = lat2 * DEG2RAD;
  const dφ = (lat2 - lat1) * DEG2RAD;
  const dλ = (lon2 - lon1) * DEG2RAD;
  const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(
  fromLat: number, fromLng: number, toLat: number, toLng: number,
): number {
  const dLng = (toLng - fromLng) * DEG2RAD;
  const lat1 = fromLat * DEG2RAD;
  const lat2 = toLat * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ─── Direction distribution ────────────────────────────────────────────────

/**
 * Place `dirCount` query points around the centre at `offsetM` distance.
 * Angles are spread evenly starting from the MBR's primary axis (when
 * rotationDeg is known) or from true north otherwise. Distributing along the
 * MBR means directions line up with facades instead of arbitrary cardinals.
 */
export function computeDirectionBearings(
  dirCount: number,
  rotationDeg: number,
): number[] {
  if (dirCount <= 0) return [];
  const step = 360 / dirCount;
  const out: number[] = [];
  for (let i = 0; i < dirCount; i++) {
    out.push((rotationDeg + i * step) % 360);
  }
  return out;
}

export function offsetPoint(
  centerLat: number, centerLng: number,
  bearingDegValue: number, distM: number,
): { lat: number; lng: number } {
  const br = bearingDegValue * DEG2RAD;
  // Use projection approximation, accurate under ~200m
  const dLat = metersToDegLat(distM * Math.cos(br));
  const dLon = metersToDegLon(distM * Math.sin(br), centerLat);
  return { lat: centerLat + dLat, lng: centerLng + dLon };
}

// ─── Per-direction capture ─────────────────────────────────────────────────

interface FetchAttempt {
  readonly offsetScale: number;
  readonly meta: SvMetadata;
  readonly panoDistM: number;
}

/** Try up to 3 metadata probes: 1.0×, 0.5×, 1.5× offset. Accept first usable. */
async function probePano(
  fetchers: StreetViewFetchers,
  center: { lat: number; lng: number },
  bearing: number,
  baseOffsetM: number,
  maxPanoDistM: number,
): Promise<FetchAttempt | null> {
  const scales = [1.0, 0.5, 1.5];
  for (const scale of scales) {
    const probe = offsetPoint(center.lat, center.lng, bearing, baseOffsetM * scale);
    const meta = await fetchers.metadata(probe.lat, probe.lng).catch(() => null);
    if (!meta) continue;
    const panoDistM = haversineM(meta.panoLat, meta.panoLng, center.lat, center.lng);
    if (panoDistM <= maxPanoDistM) return { offsetScale: scale, meta, panoDistM };
  }
  return null;
}

function computeFov(facadeWidthM: number, panoDistM: number): number {
  // Aim to fit ~65% of the facade width into the frame
  const halfWidth = facadeWidthM * 0.65;
  const raw = 2 * Math.atan2(halfWidth, Math.max(20, panoDistM)) * 180 / Math.PI;
  return Math.min(110, Math.max(60, Math.round(raw)));
}

/** Classify occlusion from sniff ratios + best-variant comparison. */
export function classifyOcclusion(
  primary: { sky: number; veg: number; building: number },
  best: { sky: number; veg: number; building: number },
  primaryHeading: number,
  bestHeading: number,
  minBuildingRatio: number,
): OcclusionKind {
  const headingDelta = Math.min(
    Math.abs(bestHeading - primaryHeading),
    360 - Math.abs(bestHeading - primaryHeading),
  );

  // If a heading shift was required to clear occlusion, the original view had
  // an obstruction. Classify by what that obstruction was.
  if (headingDelta >= 20 && best.building > primary.building + 0.15) {
    // Variant was meaningfully better than primary — something was in the way
    if (primary.veg >= 0.30) return 'trees';
    return 'adjacent-building';
  }

  // No meaningful improvement from variants — classify by the best view's content
  if (best.veg >= 0.30) return 'trees';
  if (best.building >= minBuildingRatio && best.veg < 0.15) return 'none';
  return 'poles';
}

/** Capture a single facade direction — metadata probe + image sniff + retries. */
export async function fetchFacadeSv(params: {
  readonly fetchers: StreetViewFetchers;
  readonly center: { lat: number; lng: number };
  readonly bearing: number;
  readonly facadeEdge: number;
  readonly facadeWidthM: number;
  readonly profile: CaptureProfile['streetview'];
}): Promise<SvFacadeEvidence | null> {
  const { fetchers, center, bearing, facadeEdge, facadeWidthM, profile } = params;

  const probe = await probePano(fetchers, center, bearing, profile.offsetM, profile.maxPanoDistM);
  if (!probe) return null;

  const heading = bearingDeg(probe.meta.panoLat, probe.meta.panoLng, center.lat, center.lng);
  const fov = computeFov(facadeWidthM, probe.panoDistM);

  // Primary image
  const primaryImg = await fetchers.image(probe.meta.panoId, heading, fov, profile.pitchDeg);
  const primarySniff = await imageToSniff(primaryImg);

  // Decide if retry needed
  let bestHeading = heading;
  let bestSniff = primarySniff;
  let bestImg = primaryImg;

  if (primarySniff.building < profile.minBuildingPixelRatio) {
    for (const variant of profile.angleVariants) {
      if (variant === 0) continue; // already took the primary at this heading
      const testHeading = (heading + variant + 360) % 360;
      let variantImg: SvImageFetch;
      try {
        variantImg = await fetchers.image(probe.meta.panoId, testHeading, fov, profile.pitchDeg);
      } catch {
        continue;
      }
      const varSniff = await imageToSniff(variantImg);
      if (varSniff.building > bestSniff.building) {
        bestHeading = testHeading;
        bestSniff = varSniff;
        bestImg = variantImg;
      }
    }
  }

  const occlusion = classifyOcclusion(
    primarySniff, bestSniff, heading, bestHeading, profile.minBuildingPixelRatio,
  );

  // Confidence: building ratio × (0.5 + 0.5×(probe.offsetScale === 1 ? 1 : 0.6))
  const scaleBonus = probe.offsetScale === 1 ? 1 : 0.6;
  const confidence = Math.min(1, bestSniff.building * scaleBonus);

  return {
    facadeEdge,
    imagePath: null,
    imageBytes: copyToArrayBuffer(bestImg.bytes),
    panoId: probe.meta.panoId,
    panoDistM: probe.panoDistM,
    headingDeg: bestHeading,
    fovDeg: fov,
    pitchDeg: profile.pitchDeg,
    sniff: bestSniff,
    // Palette + window grid + cornice wired in Task 3.3
    palette: { wall: [50, 0, 0], trim: [60, 0, 0], accent: null },
    windowGrid: null,
    cornice: false,
    occlusion,
    confidence,
  };
}

/** Copy a typed array's view into a fresh ArrayBuffer (handles SAB sources). */
function copyToArrayBuffer(arr: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(arr.byteLength);
  new Uint8Array(out).set(arr);
  return out;
}

// ─── Orchestrator ──────────────────────────────────────────────────────────

export interface CaptureStreetViewInput {
  readonly ctx: Pick<BuildingContext, 'center' | 'mbr' | 'svDifficulty'>;
  readonly profile: CaptureProfile;
  readonly fetchers: StreetViewFetchers;
  readonly onProgress?: CaptureProgressFn;
}

export async function captureStreetView(input: CaptureStreetViewInput): Promise<SvEvidence> {
  const { ctx, profile, fetchers, onProgress } = input;
  const dirCount = profile.streetview.dirCount;
  if (dirCount <= 0) return [];

  const bearings = computeDirectionBearings(dirCount, ctx.mbr.rotationDeg);
  const facadeWidthM = Math.max(ctx.mbr.widthM, ctx.mbr.depthM);
  const out: SvFacadeEvidence[] = [];

  for (let i = 0; i < bearings.length; i++) {
    const bearing = bearings[i];
    onProgress?.({
      stage: 'sv',
      message: `facade ${i + 1}/${dirCount} @ ${bearing.toFixed(0)}°`,
      ratio: i / dirCount,
    });
    const facade = await fetchFacadeSv({
      fetchers,
      center: { lat: ctx.center.lat, lng: ctx.center.lng },
      bearing,
      facadeEdge: i % 4,
      facadeWidthM,
      profile: profile.streetview,
    });
    if (facade) out.push(facade);
  }

  onProgress?.({ stage: 'sv', message: `${out.length}/${dirCount} facades captured`, ratio: 1 });
  return out;
}
