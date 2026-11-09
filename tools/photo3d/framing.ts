/**
 * Frame photos like Pixal3D's camera rig (BIZ-39 / WP B15). Ported from pokefit `imageto3d.py` `frame_views`.
 *
 * Pixal3D puts the object, normalised to a unit cube at the origin, at 1/1.1 of the frame in every view
 * (20 degree FOV orbit cameras at azimuth 0/90/180/270). So each photo is scaled so the figure has the SAME
 * height in every view (the vertical extent is the same from any side), the largest extent over all views
 * spans FRAME/PAD px, the mask box is centred, and the result is composited on black. A per-view
 * crop-to-mask framing would give each view its own scale, which is wrong for a multi-view model.
 *
 * Pixel work uses `sharp` (an optional dependency of the repo) for decoding, resampling and PNG encoding.
 */
import sharp from 'sharp';

/** Pixal3D conditions on 1024 x 1024 views. */
export const FRAME = 1024;
/** The unit cube spans FRAME / PAD pixels. */
export const PAD = 1.1;
/** A mask value above this is figure. */
export const MASK_THRESHOLD = 0.5;

/** An 8-bit RGB image, row-major, 3 bytes per pixel. */
export interface RawImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A single-channel mask in 0..1, row-major. */
export interface RawMask {
  width: number;
  height: number;
  data: Float32Array;
}

/** One prepared view and how it was framed. */
export interface Framed {
  name: string;
  /** FRAME x FRAME RGB, figure on black. */
  rgb: Uint8Array;
  /** FRAME x FRAME, 1 where the figure is. */
  mask: Uint8Array;
  /** Photo pixels to frame pixels. */
  scale: number;
  /** Mask bounding box in the photo, exclusive ends: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

/** Bounding box (x0, y0, x1, y1), exclusive ends, of mask > MASK_THRESHOLD. Throws on an empty mask. */
export function maskBox(mask: RawMask): [number, number, number, number] {
  let x0 = mask.width;
  let y0 = mask.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < mask.height; y++) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x++) {
      if (mask.data[row + x]! > MASK_THRESHOLD) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) throw new Error('no figure found in the photo (empty background mask)');
  return [x0, y0, x1 + 1, y1 + 1];
}

/**
 * Frame every photo like Pixal3D's rig: same figure height in all views, largest extent at FRAME / PAD,
 * mask box centred, background black (RGB x mask). Each mask must be the size of its photo.
 */
export async function frameViews(
  photos: Record<string, RawImage>,
  masks: Record<string, RawMask>,
): Promise<Record<string, Framed>> {
  const names = Object.keys(photos);
  const boxes: Record<string, [number, number, number, number]> = {};
  for (const v of names) {
    const m = masks[v];
    const p = photos[v]!;
    if (!m) throw new Error(`no mask for view ${v}`);
    if (m.width !== p.width || m.height !== p.height) throw new Error(`mask of view ${v} is not the photo's size`);
    boxes[v] = maskBox(m);
  }
  // Every view at the common height H; the widest view's width (or H) must fit FRAME / PAD.
  const ratio = Math.max(...names.map((v) => {
    const [x0, y0, x1, y1] = boxes[v]!;
    return Math.max(x1 - x0, y1 - y0) / (y1 - y0);
  }));
  const height = FRAME / PAD / ratio;
  const out: Record<string, Framed> = {};
  for (const v of names) {
    const p = photos[v]!;
    const m = masks[v]!;
    const box = boxes[v]!;
    const [x0, y0, x1, y1] = box;
    const s = height / (y1 - y0);
    // RGB x alpha on black at photo resolution, then resample (pokefit: LANCZOS for colour, BILINEAR for the mask).
    const onBlack = Buffer.alloc(p.width * p.height * 3);
    const alpha8 = Buffer.alloc(p.width * p.height);
    for (let i = 0; i < p.width * p.height; i++) {
      const a = Math.min(1, Math.max(0, m.data[i]!));
      for (let c = 0; c < 3; c++) onBlack[i * 3 + c] = Math.floor(p.data[i * 3 + c]! * a + 0.5);
      alpha8[i] = Math.floor(a * 255);
    }
    const w = Math.max(1, Math.round(p.width * s));
    const h = Math.max(1, Math.round(p.height * s));
    const scaledRgb = await sharp(onBlack, { raw: { width: p.width, height: p.height, channels: 3 } })
      .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
      .raw()
      .toBuffer();
    const scaledMask = await sharp(alpha8, { raw: { width: p.width, height: p.height, channels: 1 } })
      .resize(w, h, { kernel: 'cubic', fit: 'fill' })
      .extractChannel(0) // sharp returns a greyscale raw buffer as 3 channels; keep one
      .raw()
      .toBuffer();
    const cx = ((x0 + x1) / 2) * s;
    const cy = ((y0 + y1) / 2) * s;
    const atX = Math.round(FRAME / 2 - cx);
    const atY = Math.round(FRAME / 2 - cy);
    const rgb = new Uint8Array(FRAME * FRAME * 3);
    const mask = new Uint8Array(FRAME * FRAME);
    // Paste with clipping: the scaled photo may overhang the frame, and anything outside it is cropped.
    for (let y = 0; y < h; y++) {
      const fy = y + atY;
      if (fy < 0 || fy >= FRAME) continue;
      for (let x = 0; x < w; x++) {
        const fx = x + atX;
        if (fx < 0 || fx >= FRAME) continue;
        const di = fy * FRAME + fx;
        const si = y * w + x;
        rgb[di * 3] = scaledRgb[si * 3]!;
        rgb[di * 3 + 1] = scaledRgb[si * 3 + 1]!;
        rgb[di * 3 + 2] = scaledRgb[si * 3 + 2]!;
        mask[di] = scaledMask[si]! > 127 ? 1 : 0;
      }
    }
    out[v] = { name: v, rgb, mask, scale: s, box };
  }
  return out;
}

/** Encode a FRAME x FRAME RGB buffer (or any raw RGB) as PNG bytes. */
export async function encodePng(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const buf = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/**
 * Decode a photo file or bytes to RGB, applying its EXIF orientation (camera photos are often stored rotated)
 * and capping the long edge at `maxEdge` so uploads and BiRefNet stay quick. The cap never enlarges.
 */
export async function decodePhoto(input: string | Uint8Array, maxEdge = 2048): Promise<RawImage> {
  const { data, info } = await sharp(input as string | Buffer)
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

/** Mirror an RGB image left to right (the missing "right" view is the left one mirrored). */
export function flipImage(img: RawImage): RawImage {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const s = (y * img.width + x) * 3;
      const d = (y * img.width + (img.width - 1 - x)) * 3;
      out[d] = img.data[s]!;
      out[d + 1] = img.data[s + 1]!;
      out[d + 2] = img.data[s + 2]!;
    }
  }
  return { width: img.width, height: img.height, data: out };
}

/** Mirror a mask left to right. */
export function flipMask(m: RawMask): RawMask {
  const out = new Float32Array(m.data.length);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) out[y * m.width + (m.width - 1 - x)] = m.data[y * m.width + x]!;
  }
  return { width: m.width, height: m.height, data: out };
}
