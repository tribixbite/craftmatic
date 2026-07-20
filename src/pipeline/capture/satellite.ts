/**
 * Stage 5 — Google Static Maps (satellite) capture + roof palette extraction.
 *
 * Zoom is computed from the *measured* tile bbox (more reliable than OSM), with
 * a conservative fallback to MBR dimensions when no tile evidence is available.
 *
 * Tree-mask construction:
 *   1. Cheap HSV green-cluster detection (green not matching verdigris/green-roof hues)
 *   2. Dilated by 2px to cover canopy margins
 *   Consumed by palette extraction so sampled roof pixels exclude trees.
 *
 * All network access goes through an injectable fetcher so tests can stub.
 */

import type { CaptureProfile } from '../context/types.js';
import type { CaptureProgressFn, SatEvidence, TileEvidence } from './types.js';
import { decodeImageToRgba, sniffPixels } from './sv-sniff.js';
import { extractPalette, type Lab } from '../fusion/palette.js';

// ─── Fetcher ────────────────────────────────────────────────────────────────

export interface SatelliteImageFetch {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Optional pre-decoded RGBA pixels so test stubs can avoid sharp. */
  readonly rgba?: Uint8Array;
}

export interface SatelliteFetcher {
  /** Fetch Google Static Maps image at the given centre + zoom + scale. */
  (input: {
    readonly lat: number;
    readonly lng: number;
    readonly zoom: number;
    readonly scale: 1 | 2;
    readonly size: number;
  }): Promise<SatelliteImageFetch>;
}

// ─── Zoom selection ────────────────────────────────────────────────────────

/**
 * Compute a satellite zoom level that comfortably fits the building footprint
 * in `size`×`size` pixels at the given latitude.
 */
export function computeSatelliteZoomFromBbox(
  widthM: number,
  depthM: number,
  lat: number,
  imagePixels: number,
): number {
  // Google tile size is 256px at zoom z; covers 40075016/2^z metres at equator
  // times cos(lat). Fit max(widthM, depthM) + 20% margin in (imagePixels/256) tiles.
  const extentM = Math.max(widthM, depthM) * 1.2;
  const cosLat = Math.cos(lat * Math.PI / 180);
  const availableTiles = imagePixels / 256;
  const equatorMetresAtZ0 = 40_075_016;
  // Solve: extentM ≤ availableTiles × (equatorMetresAtZ0 × cosLat / 2^z)
  const z = Math.log2((equatorMetresAtZ0 * cosLat * availableTiles) / extentM);
  return Math.min(21, Math.max(15, Math.round(z)));
}

// ─── Tree mask ──────────────────────────────────────────────────────────────

/**
 * Build a tree mask from satellite imagery. Trees are saturated greens; roof
 * greens (verdigris copper) are duller. We threshold in HSV on saturation AND
 * value to distinguish.
 *
 * Output: 1 where tree canopy is detected, 0 elsewhere. Same dimensions as
 * input pixels. Dilated by 2px for safety margin.
 */
export function buildTreeMask(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
): Uint8Array {
  const total = width * height;
  const raw = new Uint8Array(total);
  for (let p = 0; p < total; p++) {
    const i = p * channels;
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const delta = maxC - minC;
    if (maxC === 0) continue;
    const s = delta / maxC;
    const v = maxC;
    let h = 0;
    if (delta > 0) {
      if (maxC === r) h = 60 * (((g - b) / delta) % 6);
      else if (maxC === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
      if (h < 0) h += 360;
    }
    // Trees: H 60-160 (green to yellow-green), S > 0.35, V between 0.2 and 0.7
    // This excludes verdigris (V higher, more cyan) and dark-green roofs (S lower).
    if (h >= 60 && h <= 160 && s > 0.35 && v > 0.2 && v < 0.7) {
      raw[p] = 1;
    }
  }
  // Dilate by 2px
  return dilate(raw, width, height, 2);
}

function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask);
  for (let r = 0; r < radius; r++) {
    const tmp = new Uint8Array(out);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (tmp[idx] !== 0) continue;
        if (
          (x > 0         && tmp[idx - 1] !== 0) ||
          (x < width - 1 && tmp[idx + 1] !== 0) ||
          (y > 0         && tmp[idx - width] !== 0) ||
          (y < height - 1 && tmp[idx + width] !== 0)
        ) {
          out[idx] = 1;
        }
      }
    }
  }
  return out;
}

// ─── Shadow azimuth (optional, heuristic) ──────────────────────────────────

/**
 * Rough shadow direction — finds dark low-saturation pixels and averages their
 * XY offsets from image centre. Returns compass azimuth (0-360°) or null if
 * no shadow signal. Not precise; only useful as a lighting hint for scene render.
 */
export function detectShadowAzimuth(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
): number | null {
  const cx = width / 2;
  const cy = height / 2;
  let sumDx = 0, sumDy = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const v = Math.max(r, g, b);
      const delta = v - Math.min(r, g, b);
      const s = v === 0 ? 0 : delta / v;
      // Shadow candidate: low brightness (<60) and low saturation (<0.15)
      if (v < 60 && s < 0.15) {
        sumDx += x - cx;
        sumDy += y - cy;
        count++;
      }
    }
  }
  if (count < 30) return null; // not enough shadow pixels to trust the direction
  const avgDx = sumDx / count;
  const avgDy = sumDy / count;
  // Convert pixel XY → compass azimuth (0=N, 90=E). Image Y+ = south.
  // atan2(x, -y) gives north-clockwise heading.
  const azimuth = (Math.atan2(avgDx, -avgDy) * 180 / Math.PI + 360) % 360;
  return azimuth;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

export interface CaptureSatelliteInput {
  readonly lat: number;
  readonly lng: number;
  /** Building MBR (used when tile evidence is absent). */
  readonly widthM: number;
  readonly depthM: number;
  /** Tile evidence from Stage 3 — preferred for zoom computation. */
  readonly tiles?: TileEvidence | null;
  /** Building footprint (lat/lon). When present, roof-palette sampling is
   *  masked to the polygon's satellite-pixel projection so lawns/streets
   *  around a small building can't pollute the roof colour. */
  readonly polygon?: readonly { lat: number; lon: number }[] | null;
  readonly profile: CaptureProfile;
  readonly fetcher: SatelliteFetcher;
  readonly onProgress?: CaptureProgressFn;
}

const SAT_SIZE = 640;

export async function captureSatellite(input: CaptureSatelliteInput): Promise<SatEvidence> {
  const { lat, lng, widthM, depthM, tiles, polygon, profile, fetcher, onProgress } = input;

  // Prefer measured tile bbox for zoom; fall back to MBR dims.
  let fitW = widthM;
  let fitD = depthM;
  if (tiles && !tiles.noCoverage) {
    fitW = tiles.measuredBbox.max.x - tiles.measuredBbox.min.x;
    fitD = tiles.measuredBbox.max.z - tiles.measuredBbox.min.z;
  }
  const zoom = computeSatelliteZoomFromBbox(fitW, fitD, lat, SAT_SIZE);

  onProgress?.({ stage: 'satellite', message: `fetching z${zoom} scale=${profile.satellite.scale}`, ratio: 0.1 });

  const primary = await fetcher({ lat, lng, zoom, scale: profile.satellite.scale, size: SAT_SIZE });
  const hires = profile.satellite.scale === 1
    ? await fetcher({ lat, lng, zoom, scale: 2, size: SAT_SIZE }).catch(() => null)
    : null;

  // Decode primary for mask + palette
  const { pixels, width, height } = primary.rgba
    ? { pixels: primary.rgba, width: primary.width, height: primary.height }
    : await decodeImageToRgba(primary.bytes);

  onProgress?.({ stage: 'satellite', message: 'building tree mask', ratio: 0.5 });
  const treeMask = profile.satellite.maskTrees
    ? buildTreeMask(pixels, width, height, 4)
    : new Uint8Array(width * height); // empty mask

  // Derive a combined sniff mask (sky + veg) if maskTrees is enabled
  // so satellite palette skips trees. sky% on aerial is typically 0.
  const satSniff = sniffPixels(pixels, width, height, 4, { mask: true });
  const combinedMask = new Uint8Array(width * height);
  for (let i = 0; i < combinedMask.length; i++) {
    // Mask out: tree (1), or the sniff detected sky/veg
    if (treeMask[i] !== 0) combinedMask[i] = 1;
    else if (satSniff.mask && satSniff.mask[i] !== 0) combinedMask[i] = satSniff.mask[i];
  }

  onProgress?.({ stage: 'satellite', message: 'extracting roof palette', ratio: 0.8 });
  // Roof sampling area: the building polygon projected into the crop when
  // available (pin-centred inner-70% otherwise). Without the footprint mask
  // a small building's crop is dominated by its parcel — a Berwyn build
  // sampled the LAWN and produced a green roof at high confidence.
  let paletteMask = combinedMask;
  let maskedToFootprint = false;
  if (polygon && polygon.length >= 3) {
    const poly = buildFootprintMask(polygon, lat, lng, zoom, width, height, SAT_SIZE);
    if (poly.insideCount >= MIN_FOOTPRINT_PIXELS) {
      paletteMask = new Uint8Array(width * height);
      for (let i = 0; i < paletteMask.length; i++) {
        paletteMask[i] = poly.outside[i] !== 0 ? 1 : combinedMask[i];
      }
      maskedToFootprint = true;
    }
  }
  const roofPaletteResult = extractPalette(pixels, width, height, 4, {
    k: 2,
    mask: paletteMask,
    // Full frame when footprint-masked; inner 70% otherwise (skips edges
    // where neighbouring buildings / streets intrude).
    zone: maskedToFootprint ? { x0: 0, y0: 0, x1: 1, y1: 1 } : { x0: 0.15, y0: 0.15, x1: 0.85, y1: 0.85 },
    stride: 2,
    seed: 1,
  });

  const primaryRoof: Lab = roofPaletteResult.clusters[0]?.lab ?? [50, 0, 0];
  const secondaryRoof: Lab | null = roofPaletteResult.clusters[1]?.lab ?? null;

  const shadowAzimuthDeg = detectShadowAzimuth(pixels, width, height, 4);

  const hiresBytes = hires ? copyToArrayBuffer(hires.bytes) : null;
  onProgress?.({ stage: 'satellite', message: 'done', ratio: 1 });

  return {
    imagePath: null,
    hiresImagePath: null,
    imageBytes: copyToArrayBuffer(primary.bytes),
    hiresImageBytes: hiresBytes,
    zoom,
    treeMask,
    treeMaskDim: { w: width, h: height },
    roofPalette: { primary: primaryRoof, secondary: secondaryRoof },
    roofPaletteMaskedToFootprint: maskedToFootprint,
    shadowAzimuthDeg,
  };
}

/** Minimum footprint pixels inside the crop before the mask is trusted. */
const MIN_FOOTPRINT_PIXELS = 200;

/**
 * Project a lat/lon footprint into satellite-crop pixel space (web-mercator,
 * crop centred on lat/lng at `zoom`, logical size `satSize`, decoded size
 * width×height) and rasterize it into an outside-mask (1 = outside polygon).
 * Exported for tests.
 */
export function buildFootprintMask(
  polygon: readonly { lat: number; lon: number }[],
  latC: number,
  lngC: number,
  zoom: number,
  width: number,
  height: number,
  satSize: number,
): { outside: Uint8Array; insideCount: number } {
  const scalePx = width / satSize;
  const world = 256 * Math.pow(2, zoom) * scalePx;
  const mercY = (lat: number): number => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const toPx = (p: { lat: number; lon: number }): { x: number; y: number } => ({
    x: width / 2 + ((p.lon - lngC) / 360) * world,
    y: height / 2 + (mercY(p.lat) - mercY(latC)) * world,
  });
  const pts = polygon.map(toPx);
  const outside = new Uint8Array(width * height);
  let insideCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Even-odd point-in-polygon per pixel centre.
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if ((yi > y + 0.5) !== (yj > y + 0.5)
          && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi + 1e-12) + xi) {
          inside = !inside;
        }
      }
      if (inside) insideCount++;
      else outside[y * width + x] = 1;
    }
  }
  return { outside, insideCount };
}

function copyToArrayBuffer(arr: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(arr.byteLength);
  new Uint8Array(out).set(arr);
  return out;
}

// ─── Default production fetcher (used by scripts/build.ts) ─────────────────

/**
 * Build the default Google Static Maps fetcher. Consumers who need a
 * different base URL (e.g. internal proxy) can construct their own.
 */
export function createGoogleSatelliteFetcher(apiKey: string): SatelliteFetcher {
  return async ({ lat, lng, zoom, scale, size }) => {
    const url = `https://maps.googleapis.com/maps/api/staticmap`
      + `?center=${lat},${lng}&zoom=${zoom}&size=${size}x${size}`
      + `&scale=${scale}&maptype=satellite&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) throw new Error(`Static Maps HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, width: size * scale, height: size * scale };
  };
}
