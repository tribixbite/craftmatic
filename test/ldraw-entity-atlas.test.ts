import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { ATLAS_TILE, ATLAS_WIDTH, generateLegoEntityTextureAtlas } from '../web/src/engine/ldraw-entity-atlas.js';
import { resolveLdrawEntityMaterial } from '../web/src/engine/ldraw-entity-materials.js';
import { encodePngRgba } from '../web/src/engine/lego-resource-pack.js';

/** Decode our own stored-deflate PNG back to packed RGBA (filter 0 rows only). */
function decode(png: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const width = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
  const height = (png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!;
  const idat: Uint8Array[] = [];
  for (let p = 8; p < png.length;) {
    const n = (png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!;
    const type = new TextDecoder().decode(png.subarray(p + 4, p + 8));
    if (type === 'IDAT') idat.push(png.slice(p + 8, p + 8 + n));
    p += 12 + n;
  }
  const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = inflateSync(z);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 4)]).toBe(0);
    rgba.set(raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)), y * width * 4);
  }
  return { width, height, rgba };
}
const px = (img: { width: number; rgba: Uint8Array }, x: number, y: number): number[] => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('encodePngRgba', () => {
  it('round-trips pixels through a valid PNG', () => {
    const rgba = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const img = decode(encodePngRgba(2, 2, rgba));
    expect(img.width).toBe(2);
    expect(Array.from(img.rgba)).toEqual(Array.from(rgba));
    expect(() => encodePngRgba(2, 2, new Uint8Array(3))).toThrow();
  });
});

describe('generateLegoEntityTextureAtlas', () => {
  const materials = [resolveLdrawEntityMaterial(4), resolveLdrawEntityMaterial(47), resolveLdrawEntityMaterial(383), resolveLdrawEntityMaterial(21)];

  it('lays out one 16-px row per material with a palette scanline in row 0', () => {
    const atlas = generateLegoEntityTextureAtlas(materials, { pbr: false, fallbackHighlights: true, textureName: 't' });
    expect(atlas.width).toBe(ATLAS_WIDTH);
    expect(atlas.height).toBe(1 + materials.length * ATLAS_TILE);
    expect(atlas.tiles).toHaveLength(4);
    expect(atlas.tiles[2]).toEqual({ plain: { u: 0, v: 33 }, stud: { u: 16, v: 33 } });
    const img = decode(atlas.colorPng);
    expect(img.height).toBe(atlas.height);
    expect(px(img, 0, 0)).toEqual([...materials[0]!.rgb, 255]);
    expect(px(img, 1, 0)).toEqual([...materials[1]!.rgb, 128]);
    // Plain tile is the exact flat colour everywhere; stud tile keeps the colour off-disc.
    expect(px(img, 3, 1 + 0 * 16 + 9)).toEqual([...materials[0]!.rgb, 255]);
    expect(px(img, 16, 1 + 0 * 16)).toEqual([...materials[0]!.rgb, 255]);
    // …and lifts it inside the disc (classic highlight).
    const centre = px(img, 16 + 8, 1 + 8);
    expect(centre[0]).toBeGreaterThan(materials[0]!.rgb[0]);
    expect(atlas.normalPng).toBeUndefined();
    expect(atlas.merPng).toBeUndefined();
    expect(atlas.textureSetJson).toBeUndefined();
  });

  it('keeps the colour map pure when highlights are off and emits MER/normal/texture set for PBR', () => {
    const atlas = generateLegoEntityTextureAtlas(materials, { pbr: true, fallbackHighlights: false, textureName: 'v_car' });
    const color = decode(atlas.colorPng);
    expect(px(color, 16 + 8, 1 + 8)).toEqual([...materials[0]!.rgb, 255]);
    const mer = decode(atlas.merPng!);
    // Red ABS: non-metallic, non-emissive, roughness 0.36.
    expect(px(mer, 4, 1 + 4)).toEqual([0, 0, Math.round(0.36 * 255), 255]);
    // Chrome silver: metalness 1, low roughness.
    expect(px(mer, 4, 1 + 2 * 16 + 4)).toEqual([255, 0, Math.round(0.1 * 255), 255]);
    // Glow: emissive channel set.
    expect(px(mer, 4, 1 + 3 * 16 + 4)[1]).toBeGreaterThan(0);
    const normal = decode(atlas.normalPng!);
    expect(px(normal, 4, 1 + 4)).toEqual([128, 128, 255, 255]);
    // The stud dome tilts normals away from straight-up near the rim.
    expect(px(normal, 16 + 13, 1 + 8)[0]).toBeGreaterThan(128);
    expect(JSON.parse(atlas.textureSetJson!)).toEqual({
      format_version: '1.16.100',
      'minecraft:texture_set': { color: 'v_car', metalness_emissive_roughness: 'v_car_mer', normal: 'v_car_normal' },
    });
  });

  it('never emits an empty atlas', () => {
    const atlas = generateLegoEntityTextureAtlas([], { pbr: false, fallbackHighlights: false, textureName: 't' });
    expect(atlas.height).toBe(17);
    expect(atlas.tiles).toHaveLength(1);
  });
});
