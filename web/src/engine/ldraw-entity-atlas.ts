/**
 * Textures for a Bedrock LEGO entity: ONE flat swatch per LDraw colour.
 *
 * Why not an atlas any more. A cube in a Bedrock geometry can carry its UVs in
 * two forms: the per-face form (`uv: {north: {uv, uv_size}, …}`, six
 * descriptors) or **box UV** (`uv: [u, v]`, one origin, the six faces laid out
 * in a cross scaled by the cube's own size). Measured on a Pixel 8 Pro
 * (Bedrock 1.26.51.1) by rewriting all 48,093 cubes of the 71043 shell from
 * one form to the other — same cuboid count, file padded to the same byte
 * length — box UV costs **1.05 kB less per cuboid** (nativePss 1,280,812 →
 * 1,224,889 kB, a 50.7 MB saving, 34 % of the 3.08 kB a cuboid costs;
 * nativeAlloc agreed in sign but only by 8 %). Geometry parsed with 0 content
 * errors and the frame signature was unchanged.
 *
 * Box UV maps all six faces from one origin, so a cube can only carry ONE
 * tile. That is the whole reason this file no longer builds an atlas: cubes
 * are grouped by colour into one geometry per colour
 * (`ldraw-entity-compiler.ts`), and each of those geometries is textured with
 * a swatch that is a single flat colour. A uniform texture is sampled
 * identically at every cube size, at every mip level and under any filter or
 * wrap mode — which is what makes the size-scaled cross harmless. There is no
 * neighbouring tile to bleed from.
 *
 * Faces are FLAT colour. A part is several cuboids (a wheel is ~10), so a
 * per-cuboid seam or bevel would draw the decomposition, not the brick; the
 * LEGO read comes from real stud geometry and the material response instead.
 *
 * PBR (Vibrant Visuals): a `<name>_mer.png` (metalness / emissive / roughness
 * in R / G / B from `MATERIAL_PBR`), a flat `<name>_normal.png` and a
 * `<name>.texture_set.json` binding the three.
 */

import { encodePngRgba } from './lego-resource-pack.js';
import type { LdrawEntityMaterial } from './ldraw-entity-materials.js';

/**
 * Swatch edge in pixels, and the `texture_width`/`texture_height` every
 * brick-compiled geometry declares. The content is uniform, so the value only
 * sets how many texels a cube's UV cross walks before it wraps — never which
 * colour it lands on. 16 keeps the PNG a legal, unremarkable entity texture
 * rather than a 1×1 edge case.
 */
export const SWATCH_SIZE = 16;

export interface EntityMaterialSwatch {
  /** Both texture dimensions, and what the geometry declares. */
  size: number;
  colorPng: Uint8Array;
  normalPng?: Uint8Array;
  merPng?: Uint8Array;
  /** Contents of `<name>.texture_set.json`; present only with `pbr`. */
  textureSetJson?: string;
}

export interface MaterialSwatchOptions {
  /** Emit MER + normal maps and the texture set. */
  pbr: boolean;
  /** Texture file stem the texture set refers to (relative to its own folder). */
  textureName: string;
}

/** Bedrock texture-set format version that Vibrant Visuals reads. */
const TEXTURE_SET_FORMAT = '1.16.100';

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/**
 * Pack-wide file stem for a colour's swatch. A swatch is a pure function of the
 * LDraw colour id, so every entity in a pack shares one set of files: a
 * castle, its ten minifigs and a vehicle that all use Black emit
 * `craftmatic_swatch_0.png` once.
 */
export function legoMaterialSwatchName(material: LdrawEntityMaterial): string {
  return `craftmatic_swatch_${material.colorId}`;
}

/** The flat colour (+ PBR maps) one LDraw colour's geometry is textured with. */
export function generateLegoMaterialSwatch(material: LdrawEntityMaterial, options: MaterialSwatchOptions): EntityMaterialSwatch {
  const n = SWATCH_SIZE * SWATCH_SIZE;
  const [r, g, b] = material.rgb;
  const a = clamp255(material.alpha * 255);
  const color = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) { color[i * 4] = r; color[i * 4 + 1] = g; color[i * 4 + 2] = b; color[i * 4 + 3] = a; }

  const swatch: EntityMaterialSwatch = { size: SWATCH_SIZE, colorPng: encodePngRgba(SWATCH_SIZE, SWATCH_SIZE, color) };
  if (!options.pbr) return swatch;

  const normal = new Uint8Array(n * 4), mer = new Uint8Array(n * 4);
  const merR = clamp255(material.metalness * 255), merG = clamp255(material.emissive * 255), merB = clamp255(material.roughness * 255);
  for (let i = 0; i < n; i++) {
    normal[i * 4] = 128; normal[i * 4 + 1] = 128; normal[i * 4 + 2] = 255; normal[i * 4 + 3] = 255;
    mer[i * 4] = merR; mer[i * 4 + 1] = merG; mer[i * 4 + 2] = merB; mer[i * 4 + 3] = 255;
  }
  swatch.normalPng = encodePngRgba(SWATCH_SIZE, SWATCH_SIZE, normal);
  swatch.merPng = encodePngRgba(SWATCH_SIZE, SWATCH_SIZE, mer);
  swatch.textureSetJson = JSON.stringify({
    format_version: TEXTURE_SET_FORMAT,
    'minecraft:texture_set': {
      color: options.textureName,
      metalness_emissive_roughness: `${options.textureName}_mer`,
      normal: `${options.textureName}_normal`,
    },
  }, null, 2) + '\n';
  return swatch;
}
