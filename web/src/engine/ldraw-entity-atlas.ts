/**
 * Texture atlas for a Bedrock LEGO entity: one 16×16 tile row per material.
 *
 * Layout (width 32, height 1 + 16·N):
 *   row 0            palette scanline — pixel x is material x's RGBA (x < 32),
 *                    a single-pixel probe for tests and diagnostics;
 *   rows 1+16i       material i: column 0 = plain face, column 1 = stud top.
 *
 * Faces are FLAT colour. A part is now several cuboids (a wheel is ~10), so a
 * per-cuboid seam or bevel would draw the decomposition, not the brick; the
 * LEGO read comes from real stud geometry and the material response instead.
 * The classic (non-PBR) stud-top tile carries a faint lighter disc so a stud
 * still reads without normal mapping.
 *
 * PBR (Vibrant Visuals): a `<name>_mer.png` (metalness / emissive / roughness
 * in R / G / B from `MATERIAL_PBR`), a `<name>_normal.png` (flat, with a soft
 * dome on the stud-top tile) and `<name>.texture_set.json` binding the three.
 */

import { encodePngRgba } from './lego-resource-pack.js';
import type { LdrawEntityMaterial } from './ldraw-entity-materials.js';

export const ATLAS_TILE = 16;
export const ATLAS_WIDTH = 32;

export interface AtlasTile { u: number; v: number }

export interface EntityTextureAtlas {
  width: number;
  height: number;
  colorPng: Uint8Array;
  normalPng?: Uint8Array;
  merPng?: Uint8Array;
  /** Contents of `<name>.texture_set.json`; present only with `pbr`. */
  textureSetJson?: string;
  /** Tile origins per material index. Every tile is ATLAS_TILE square. */
  tiles: Array<{ plain: AtlasTile; stud: AtlasTile }>;
}

export interface EntityAtlasOptions {
  /** Emit MER + normal maps and the texture set. */
  pbr: boolean;
  /** Bake the faint stud disc into the colour map (classic rendering cue). */
  fallbackHighlights: boolean;
  /** Texture file stem the texture set refers to (relative to its own folder). */
  textureName: string;
}

/** Bedrock texture-set format version that Vibrant Visuals reads. */
const TEXTURE_SET_FORMAT = '1.16.100';

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

export function generateLegoEntityTextureAtlas(materials: LdrawEntityMaterial[], options: EntityAtlasOptions): EntityTextureAtlas {
  const count = Math.max(1, materials.length);
  const width = ATLAS_WIDTH;
  const height = 1 + count * ATLAS_TILE;
  const color = new Uint8Array(width * height * 4);
  const normal = options.pbr ? new Uint8Array(width * height * 4) : undefined;
  const mer = options.pbr ? new Uint8Array(width * height * 4) : undefined;
  const put = (buf: Uint8Array, x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const o = (y * width + x) * 4;
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = a;
  };

  const fallback: LdrawEntityMaterial = {
    colorId: 7, rgb: [155, 161, 157], alpha: 1, materialClass: 'abs', metalness: 0, emissive: 0, roughness: 0.36, known: false,
  };
  const at = (i: number): LdrawEntityMaterial => materials[i] ?? fallback;

  // Row 0: palette scanline.
  for (let x = 0; x < width; x++) {
    const m = at(x % count);
    const [r, g, b] = m.rgb;
    put(color, x, 0, r, g, b, clamp255(m.alpha * 255));
    if (normal) put(normal, x, 0, 128, 128, 255, 255);
    if (mer) put(mer, x, 0, clamp255(m.metalness * 255), clamp255(m.emissive * 255), clamp255(m.roughness * 255), 255);
  }

  const tiles: EntityTextureAtlas['tiles'] = [];
  for (let i = 0; i < count; i++) {
    const m = at(i);
    const [r, g, b] = m.rgb;
    const a = clamp255(m.alpha * 255);
    const v0 = 1 + i * ATLAS_TILE;
    tiles.push({ plain: { u: 0, v: v0 }, stud: { u: ATLAS_TILE, v: v0 } });
    const merR = clamp255(m.metalness * 255), merG = clamp255(m.emissive * 255), merB = clamp255(m.roughness * 255);

    for (let ty = 0; ty < ATLAS_TILE; ty++) for (let tx = 0; tx < ATLAS_TILE; tx++) {
      // Column 0: plain face.
      put(color, tx, v0 + ty, r, g, b, a);
      if (normal) put(normal, tx, v0 + ty, 128, 128, 255, 255);
      if (mer) put(mer, tx, v0 + ty, merR, merG, merB, 255);

      // Column 1: stud top — a disc of radius ~6.5 px, lit a touch lighter in
      // the classic map and given a soft dome in the normal map.
      const dx = tx - 7.5, dy = ty - 7.5;
      const dist = Math.hypot(dx, dy);
      const inDisc = dist <= 6.5;
      const x = ATLAS_TILE + tx, y = v0 + ty;
      if (options.fallbackHighlights && inDisc && m.alpha >= 1) {
        const rim = dist > 5.2;
        const k = rim ? 0.86 : 1.08;
        put(color, x, y, clamp255(r * k), clamp255(g * k), clamp255(b * k), a);
      } else {
        put(color, x, y, r, g, b, a);
      }
      if (normal) {
        if (inDisc && dist > 0.01) {
          // Dome: normal tilts outward proportional to the radius.
          const t = Math.min(1, dist / 6.5) * 0.45;
          put(normal, x, y, clamp255(128 + (dx / dist) * t * 127), clamp255(128 - (dy / dist) * t * 127), clamp255(255 * Math.sqrt(1 - t * t)), 255);
        } else {
          put(normal, x, y, 128, 128, 255, 255);
        }
      }
      if (mer) put(mer, x, y, merR, merG, merB, 255);
    }
  }

  const atlas: EntityTextureAtlas = {
    width, height, tiles,
    colorPng: encodePngRgba(width, height, color),
  };
  if (normal && mer) {
    atlas.normalPng = encodePngRgba(width, height, normal);
    atlas.merPng = encodePngRgba(width, height, mer);
    atlas.textureSetJson = JSON.stringify({
      format_version: TEXTURE_SET_FORMAT,
      'minecraft:texture_set': {
        color: options.textureName,
        metalness_emissive_roughness: `${options.textureName}_mer`,
        normal: `${options.textureName}_normal`,
      },
    }, null, 2) + '\n';
  }
  return atlas;
}
