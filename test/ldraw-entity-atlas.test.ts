import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { SWATCH_SIZE, generateLegoMaterialSwatch, legoMaterialSwatchName } from '../web/src/engine/ldraw-entity-atlas.js';
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

describe('generateLegoMaterialSwatch', () => {
  const red = resolveLdrawEntityMaterial(4), glass = resolveLdrawEntityMaterial(47);
  const chrome = resolveLdrawEntityMaterial(383), glow = resolveLdrawEntityMaterial(21);

  it('names a swatch after the LDraw colour, so every entity in a pack shares one file', () => {
    expect(legoMaterialSwatchName(red)).toBe('craftmatic_swatch_4');
    expect(legoMaterialSwatchName(resolveLdrawEntityMaterial(0x2ff8800))).toBe('craftmatic_swatch_50300928');
    expect(legoMaterialSwatchName(glass)).not.toBe(legoMaterialSwatchName(red));
  });

  it('is one flat colour edge to edge: box UV scales the face cross by CUBE SIZE, so every texel must match', () => {
    const swatch = generateLegoMaterialSwatch(red, { pbr: false, textureName: 't' });
    expect(swatch.size).toBe(SWATCH_SIZE);
    const img = decode(swatch.colorPng);
    expect(img.width).toBe(SWATCH_SIZE);
    expect(img.height).toBe(SWATCH_SIZE);
    // Every pixel, not a sample: a cube's UV cross can land anywhere in here
    // (and wrap past it), so a single stray texel would repaint a face.
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      expect(px(img, x, y)).toEqual([...red.rgb, 255]);
    }
    expect(swatch.normalPng).toBeUndefined();
    expect(swatch.merPng).toBeUndefined();
    expect(swatch.textureSetJson).toBeUndefined();
  });

  it('carries the material alpha, so a translucent colour stays translucent', () => {
    const img = decode(generateLegoMaterialSwatch(glass, { pbr: false, textureName: 't' }).colorPng);
    expect(glass.alpha).toBeLessThan(1);
    expect(px(img, 9, 3)).toEqual([...glass.rgb, Math.round(glass.alpha * 255)]);
  });

  it('emits flat MER/normal maps and a texture set for PBR', () => {
    const swatch = generateLegoMaterialSwatch(chrome, { pbr: true, textureName: 'craftmatic_swatch_383' });
    const mer = decode(swatch.merPng!);
    // Chrome silver: metalness 1, low roughness — uniform, like the colour map.
    for (let y = 0; y < mer.height; y++) for (let x = 0; x < mer.width; x++) {
      expect(px(mer, x, y)).toEqual([255, 0, Math.round(0.1 * 255), 255]);
    }
    expect(px(decode(generateLegoMaterialSwatch(glow, { pbr: true, textureName: 't' }).merPng!), 4, 4)[1]).toBeGreaterThan(0);
    expect(px(decode(generateLegoMaterialSwatch(red, { pbr: true, textureName: 't' }).merPng!), 4, 4)).toEqual([0, 0, Math.round(0.36 * 255), 255]);
    const normal = decode(swatch.normalPng!);
    expect(px(normal, 4, 4)).toEqual([128, 128, 255, 255]);
    expect(JSON.parse(swatch.textureSetJson!)).toEqual({
      format_version: '1.16.100',
      'minecraft:texture_set': {
        color: 'craftmatic_swatch_383',
        metalness_emissive_roughness: 'craftmatic_swatch_383_mer',
        normal: 'craftmatic_swatch_383_normal',
      },
    });
  });
});
