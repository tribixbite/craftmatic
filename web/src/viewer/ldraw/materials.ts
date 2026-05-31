/**
 * Material factory for LDraw color IDs.
 *
 * Maps each LDraw color to one of five material types — ABS plastic (default),
 * rubber (matte), metallic/pearl, transparent (transmission), glow-in-dark —
 * using LDRAW_COLOR_RGB plus type predicates for each special class.
 */

import * as THREE from 'three';
import { LDRAW_COLOR_RGB } from '@engine/ldraw-colors.js';
import { inlineTransparentColors } from './parts.js';

/** LDraw transparent color IDs (33-47 range plus known extras + rubber trans) */
export function isTransparentColor(colorId: number): boolean {
  if (colorId >= 33 && colorId <= 49) return true;
  if (colorId >= 52 && colorId <= 54) return true;
  if (colorId === 57) return true;
  if (colorId === 111 || colorId === 113 || colorId === 114 || colorId === 117) return true;
  if (colorId === 234 || colorId === 284 || colorId === 285 || colorId === 293) return true;
  if (colorId === 295 || colorId === 296 || colorId === 300 || colorId === 302) return true;
  if (colorId === 306 || colorId === 329 || colorId === 605) return true;
  if (colorId === 142 || colorId === 143 || colorId === 150) return true;
  if (colorId === 62 || colorId === 39) return true;
  if (colorId === 66 || colorId === 67) return true;
  if (colorId === 10035 || colorId === 10036) return true;
  if (colorId === 10043) return true;
  if (colorId === 10351 || colorId === 10366) return true;
  if (colorId === 10375) return true;
  if (colorId >= 0x3000000 && colorId < 0x4000000) return true;
  if (inlineTransparentColors.has(colorId)) return true;
  return false;
}

/** LDraw metallic/chrome/pearl color IDs */
export function isMetallicColor(colorId: number): boolean {
  if (colorId === 80 || colorId === 81 || colorId === 82 || colorId === 83) return true;
  if (colorId === 87 || colorId === 179 || colorId === 383 || colorId === 65) return true;
  if (colorId === 297 || colorId === 494 || colorId === 495) return true;
  if (colorId === 10179 || colorId === 134 || colorId === 135) return true;
  if (colorId === 132 || colorId === 133 || colorId === 148) return true;
  return false;
}

export function isGlowColor(colorId: number): boolean {
  return colorId === 21 || colorId === 294 || colorId === 601;
}

export function isRubberColor(colorId: number): boolean {
  if (colorId === 256 || colorId === 273 || colorId === 324 || colorId === 375) return true;
  if (colorId >= 10000 && colorId < 11000) return true;
  return false;
}

/**
 * Convert an LDraw color ID to a THREE.Color. Handles direct colors
 * (0x2RRGGBB / 0x3RRGGBB) and the named-color table.
 *
 * Both code paths return sRGB-encoded colors. THREE's Color(hex) constructor
 * with `THREE.ColorManagement` enabled (default in r152+) treats hex strings
 * as sRGB and stores them in linear-sRGB working space when assigned to a
 * material. The direct-color path now goes through the same hex-string path
 * (instead of `new Color(r, g, b)` which treats the values as linear) so
 * direct colors don't render too bright.
 */
export function getThreeColor(colorId: number): THREE.Color {
  if (isNaN(colorId)) return new THREE.Color(0x808080);
  if (colorId >= 0x2000000) {
    // Bottom 24 bits are sRGB-encoded R/G/B. setHex with sRGB hint applies
    // the working-space conversion that the material pipeline expects.
    const rgb = colorId & 0x00FFFFFF;
    return new THREE.Color().setHex(rgb, THREE.SRGBColorSpace);
  }
  const hex = LDRAW_COLOR_RGB[colorId] ?? '#808080';
  return new THREE.Color(hex);
}

/**
 * Create the appropriate THREE material for a given LDraw color, using the
 * color's brightness and the type predicates above to select among five
 * material recipes. Always returns DoubleSide because LDraw .dat winding
 * is inconsistent across the library.
 */
export function makeMaterial(colorId: number): THREE.MeshPhysicalMaterial {
  const color = getThreeColor(colorId);
  const transparent = isTransparentColor(colorId);
  const metallic = isMetallicColor(colorId);
  const glow = isGlowColor(colorId);
  const rubber = isRubberColor(colorId);

  if (glow) {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.35,
      metalness: 0.0,
      emissive: color.clone().multiplyScalar(0.3),
      clearcoat: 0.2,
      clearcoatRoughness: 0.5,
      side: THREE.DoubleSide,
    });
  }

  if (transparent) {
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.05,
      metalness: 0.0,
      transmission: 0.85,
      ior: 1.45,
      thickness: 0.5,
      specularIntensity: 1.0,
      specularColor: new THREE.Color(0xffffff),
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
      emissive: color.clone().multiplyScalar(0.12),
    });
  }

  if (metallic) {
    // Chrome NEEDS bright environment reflection to look like chrome —
    // without it, polished metal reads as dull dark grey. The scene-level
    // environmentIntensity is intentionally low (0.35) so dark ABS doesn't
    // wash out; we compensate per-material with a high envMapIntensity
    // multiplier (these multiply, effective env ≈ 0.35 × 3.0 = 1.05).
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.18,
      metalness: 0.88,
      envMapIntensity: 3.0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.12,
      specularIntensity: 1.3,
      specularColor: color.clone().lerp(new THREE.Color(0xffffff), 0.3),
      side: THREE.DoubleSide,
      emissive: color.clone().multiplyScalar(0.03),
    });
  }

  if (rubber) {
    // Proper matte rubber: high roughness, zero env reflection, no emissive
    // pop. Reads as Lambertian black instead of "shiny black plastic".
    return new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.92,
      metalness: 0.0,
      envMapIntensity: 0.0,
      clearcoat: 0.0,
      side: THREE.DoubleSide,
    });
  }

  // ABS plastic — dominant body material. Even small clearcoat + env
  // reflection bleaches dark colors to grey because the bright reflected
  // light dominates the small base contribution. Strategy: NO clearcoat,
  // NO env reflection, NO emissive on dark bricks; small amounts on light
  // bricks for sheen. Tested with diagnostic zero — dark bricks show their
  // true LDraw color when lit only by direct lights.
  const lum = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
  // Smooth gate: 0 below lum 0.25, ramps up above.
  const polish = Math.max(0, Math.min(1, (lum - 0.25) / 0.6));
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.45 - polish * 0.15,         // dark matte (0.45), light glossy (0.30)
    metalness: 0.0,
    envMapIntensity: polish * 1.2,           // dark 0, light 1.2
    clearcoat: polish * 0.5,                 // dark 0, light 0.5
    clearcoatRoughness: 0.3 - polish * 0.1,
    side: THREE.DoubleSide,
  });
  return mat;
}

/**
 * Decide whether a color should render after opaque (transparent renderOrder).
 */
export function isTransparentMaterial(colorId: number): boolean {
  return isTransparentColor(colorId);
}
