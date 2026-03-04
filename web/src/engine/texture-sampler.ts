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
      if (!image) return [128, 128, 128]; // No image data — neutral gray

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
    const px = Math.floor(u * (entry.w - 1));
    const py = Math.floor((1 - v) * (entry.h - 1)); // UV y is flipped vs canvas

    const pixel = entry.ctx.getImageData(px, py, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2]];
  };
}
