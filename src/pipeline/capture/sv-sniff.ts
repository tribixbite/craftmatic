/**
 * Image content sniffer — classifies each pixel as sky, vegetation, or
 * building/other and returns aggregate ratios + a sky+veg mask the caller
 * can reuse (e.g. for facade palette zone-sampling).
 *
 * Design notes (spec §Stage 4):
 *   • Sky: HSV with H in 180-240° OR high-brightness / low-saturation (white/grey)
 *   • Veg: HSV with H in 60-160° AND S > 0.3 (saturated green/yellow-green)
 *   • Building: everything else
 *
 * Pure — takes raw RGBA pixels, returns ratios and optionally a mask. Decode
 * of a JPEG/PNG buffer via `sharp` lives in a tiny helper at the bottom so
 * production callers don't repeat the boilerplate.
 */

export interface SniffRatios {
  readonly sky: number;
  readonly veg: number;
  readonly building: number;
}

export interface SniffResult {
  readonly ratios: SniffRatios;
  /**
   * Per-pixel classification mask, same dimensions as input.
   *   0 = building/other
   *   1 = sky
   *   2 = vegetation
   *
   * Allocated only when `options.mask === true`.
   */
  readonly mask: Uint8Array | null;
  readonly width: number;
  readonly height: number;
}

export interface SniffOptions {
  /** When true, return per-pixel mask for reuse (e.g. palette sampling). */
  readonly mask?: boolean;
  /** 0-255 threshold for "bright" — distinguishes bright sky from dim pixels. */
  readonly brightThreshold?: number;
  /** 0-1 threshold for "saturated" veg. */
  readonly vegSaturationMin?: number;
  /** 0-1 threshold for "unsaturated" sky (white sky). */
  readonly skyMaxSaturation?: number;
}

const H_SKY_MIN = 180;
const H_SKY_MAX = 240;
const H_VEG_MIN = 60;
const H_VEG_MAX = 160;

/**
 * Classify raw RGBA pixels (one byte per channel, packed RGBA-RGBA-…) into
 * sky/veg/building. Accepts RGB3-channel input too — pass channels=3.
 */
export function sniffPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: 3 | 4 = 4,
  options: SniffOptions = {},
): SniffResult {
  const brightThreshold = options.brightThreshold ?? 190;
  const vegSaturationMin = options.vegSaturationMin ?? 0.3;
  const skyMaxSaturation = options.skyMaxSaturation ?? 0.15;
  const totalPixels = width * height;
  const expectedLen = totalPixels * channels;
  if (pixels.length < expectedLen) {
    throw new Error(`sniffPixels: expected ${expectedLen} bytes, got ${pixels.length}`);
  }

  let sky = 0, veg = 0, building = 0;
  const mask = options.mask ? new Uint8Array(totalPixels) : null;

  for (let i = 0, p = 0; i < expectedLen; i += channels, p++) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const y = Math.floor(p / width);
    // The "bright + unsaturated ⇒ sky" rule only fires in the top 35% of the
    // image. Without this gate, cream limestone / white stucco / marble
    // facades (V ≈ 0.85-0.95, S < 0.15) at eye level were getting classified
    // as sky and masked out of the wall palette, so the wall K-means only
    // saw shadows + sidewalk and the building came out brown.
    const isTopZone = y < height * 0.35;
    const cls = classifyRgb(r, g, b, brightThreshold, vegSaturationMin, skyMaxSaturation, isTopZone);
    if (mask) mask[p] = cls;
    if (cls === 1) sky++;
    else if (cls === 2) veg++;
    else building++;
  }

  return {
    ratios: {
      sky: sky / totalPixels,
      veg: veg / totalPixels,
      building: building / totalPixels,
    },
    mask,
    width,
    height,
  };
}

/**
 * RGB → sky/veg/building class. 0 = building, 1 = sky, 2 = veg.
 *
 * HSV derivation inlined for speed — a 640×640 image has 409K pixels so we
 * want to avoid a function-call per pixel.
 */
function classifyRgb(
  r: number, g: number, b: number,
  brightThreshold: number,
  vegSaturationMin: number,
  skyMaxSaturation: number,
  inTopZone: boolean = true,
): 0 | 1 | 2 {
  // Normalize
  const rf = r / 255, gf = g / 255, bf = b / 255;
  const maxC = Math.max(rf, gf, bf);
  const minC = Math.min(rf, gf, bf);
  const delta = maxC - minC;
  const v = maxC;
  const s = maxC === 0 ? 0 : delta / maxC;

  // Hue in degrees 0-360
  let h = 0;
  if (delta > 0) {
    if (maxC === rf) h = 60 * (((gf - bf) / delta) % 6);
    else if (maxC === gf) h = 60 * ((bf - rf) / delta + 2);
    else h = 60 * ((rf - gf) / delta + 4);
  }
  if (h < 0) h += 360;

  // Sky: blue hue anywhere, OR bright+unsaturated only in the top zone
  // (otherwise bright stone facades get misclassified as overcast sky).
  if (h >= H_SKY_MIN && h <= H_SKY_MAX && s > 0.1 && v > 0.4) return 1;
  if (inTopZone && v * 255 > brightThreshold && s < skyMaxSaturation) return 1;

  // Veg: green/yellow-green hue with enough saturation
  if (h >= H_VEG_MIN && h <= H_VEG_MAX && s > vegSaturationMin) return 2;

  return 0;
}

// ─── Sharp-backed loader (tiny wrapper) ────────────────────────────────────

/**
 * Decode a JPEG/PNG/WebP buffer into raw RGBA pixels via `sharp`. Not tested
 * against specific formats — `sharp` handles all common ones.
 */
export async function decodeImageToRgba(
  buffer: Uint8Array | ArrayBuffer,
): Promise<{ pixels: Uint8Array; width: number; height: number }> {
  const sharpMod = (await import('sharp')).default;
  const buf = Buffer.from(buffer as ArrayBuffer);
  const img = sharpMod(buf).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { pixels: new Uint8Array(data), width: info.width, height: info.height };
}

export async function sniffImage(
  buffer: Uint8Array | ArrayBuffer,
  options: SniffOptions = {},
): Promise<SniffResult> {
  const { pixels, width, height } = await decodeImageToRgba(buffer);
  return sniffPixels(pixels, width, height, 4, options);
}
