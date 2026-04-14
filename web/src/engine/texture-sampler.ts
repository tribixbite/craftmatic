/**
 * Canvas-backed texture sampler for UV-mapped Three.js meshes.
 *
 * Shared between mesh file upload and 3D tiles pipelines.
 * Draws textures to an OffscreenCanvas and samples pixels via getImageData.
 */

import * as THREE from 'three';
import type { TextureSampler } from '@craft/convert/voxelizer.js';
import type { RGB } from '@craft/types/index.js';

/**
 * Create a texture sampler backed by a 2D canvas.
 * Draws each texture to an offscreen canvas on first use and caches it.
 * Returns the RGB color at the given UV coordinate.
 */
export function createCanvasTextureSampler(): TextureSampler {
  const cache = new Map<THREE.Texture, { ctx: CanvasRenderingContext2D; w: number; h: number }>();

  return (texture: THREE.Texture, uv: THREE.Vector2): RGB => {
    let entry = cache.get(texture);
    if (!entry) {
      const image = texture.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap;
      if (!image) return [176, 176, 176]; // No image data — light gray (maps to plaster, not shadow)

      const w = image.width || 64;
      const h = image.height || 64;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image as CanvasImageSource, 0, 0);
      entry = { ctx: ctx as unknown as CanvasRenderingContext2D, w, h };
      cache.set(texture, entry);
    }

    // UV wrapping (repeat)
    const u = ((uv.x % 1) + 1) % 1;
    const v = ((uv.y % 1) + 1) % 1;
    const cx = Math.floor(u * (entry.w - 1));
    const cy = Math.floor((1 - v) * (entry.h - 1)); // UV y is flipped vs canvas

    // 5-point median filter: sample center + 4 half-texel neighbors, sort by
    // luminance, take the middle sample. Filters JPEG compression artifacts
    // and seam noise from photogrammetry textures without blurring boundaries.
    const offsets: Array<[number, number]> = [
      [0, 0],
      [-1, -1], [1, -1],
      [-1, 1],  [1, 1],
    ];
    const samples: Array<[number, number, number, number]> = []; // [r, g, b, luminance]
    for (const [dx, dy] of offsets) {
      const sx = Math.min(entry.w - 1, Math.max(0, cx + dx));
      const sy = Math.min(entry.h - 1, Math.max(0, cy + dy));
      const pixel = entry.ctx.getImageData(sx, sy, 1, 1).data;
      const lum = (pixel[0] * 77 + pixel[1] * 150 + pixel[2] * 29) >> 8;
      samples.push([pixel[0], pixel[1], pixel[2], lum]);
    }
    samples.sort((a, b) => a[3] - b[3]);
    const median = samples[2];
    return [median[0], median[1], median[2]];
  };
}
