/**
 * CIE Lab color utilities for perceptual Minecraft block matching.
 *
 * Used as a fallback when a LDraw color ID has no explicit entry in
 * ldraw-colors.ts — finds the perceptually closest Minecraft block
 * using ΔE (simple Euclidean distance in Lab space).
 */

/** Convert sRGB byte [0-255] channel to linear light */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** sRGB [0-255] → CIE XYZ (D65 illuminant) */
function rgbToXyz(r: number, g: number, b: number): [number, number, number] {
  const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
  return [
    rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375,
    rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750,
    rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041,
  ];
}

/** CIE XYZ → CIE Lab (D65 white point) */
function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x / 0.95047), fy = f(y / 1.00000), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** sRGB [0-255] → CIE Lab */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  return xyzToLab(...rgbToXyz(r, g, b));
}

/** Euclidean distance in Lab space (approximate ΔE) */
function deltaE(lab1: readonly [number, number, number], lab2: readonly [number, number, number]): number {
  const dL = lab1[0] - lab2[0], da = lab1[1] - lab2[1], db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

export interface BlockEntry {
  name: string;
  r: number; g: number; b: number;
}

/**
 * Full palette of solid Minecraft blocks with approximate average RGB.
 * Used for perceptual fallback matching.
 */
export const BLOCK_PALETTE: BlockEntry[] = [
  // Concrete (16 colors)
  { name: 'minecraft:white_concrete',      r: 207, g: 213, b: 214 },
  { name: 'minecraft:orange_concrete',     r: 224, g:  97, b:   0 },
  { name: 'minecraft:magenta_concrete',    r: 169, g:  48, b: 159 },
  { name: 'minecraft:light_blue_concrete', r:  36, g: 137, b: 199 },
  { name: 'minecraft:yellow_concrete',     r: 240, g: 175, b:  21 },
  { name: 'minecraft:lime_concrete',       r:  94, g: 169, b:  24 },
  { name: 'minecraft:pink_concrete',       r: 213, g: 101, b: 142 },
  { name: 'minecraft:gray_concrete',       r:  54, g:  57, b:  61 },
  { name: 'minecraft:light_gray_concrete', r: 125, g: 125, b: 115 },
  { name: 'minecraft:cyan_concrete',       r:  21, g: 119, b: 136 },
  { name: 'minecraft:purple_concrete',     r: 100, g:  31, b: 156 },
  { name: 'minecraft:blue_concrete',       r:  44, g:  46, b: 143 },
  { name: 'minecraft:brown_concrete',      r:  96, g:  59, b:  31 },
  { name: 'minecraft:green_concrete',      r:  73, g:  91, b:  36 },
  { name: 'minecraft:red_concrete',        r: 142, g:  32, b:  32 },
  { name: 'minecraft:black_concrete',      r:   8, g:  10, b:  15 },
  // Terracotta (16 colors)
  { name: 'minecraft:white_terracotta',       r: 209, g: 178, b: 161 },
  { name: 'minecraft:orange_terracotta',      r: 162, g:  83, b:  37 },
  { name: 'minecraft:magenta_terracotta',     r: 149, g:  88, b: 108 },
  { name: 'minecraft:light_blue_terracotta',  r: 113, g: 108, b: 137 },
  { name: 'minecraft:yellow_terracotta',      r: 186, g: 133, b:  36 },
  { name: 'minecraft:lime_terracotta',        r: 103, g: 117, b:  52 },
  { name: 'minecraft:pink_terracotta',        r: 161, g:  78, b:  78 },
  { name: 'minecraft:gray_terracotta',        r:  58, g:  42, b:  36 },
  { name: 'minecraft:light_gray_terracotta',  r: 135, g: 106, b:  97 },
  { name: 'minecraft:cyan_terracotta',        r:  86, g:  91, b:  91 },
  { name: 'minecraft:purple_terracotta',      r: 118, g:  70, b:  86 },
  { name: 'minecraft:blue_terracotta',        r:  74, g:  59, b:  91 },
  { name: 'minecraft:brown_terracotta',       r:  77, g:  51, b:  35 },
  { name: 'minecraft:green_terracotta',       r:  76, g:  83, b:  42 },
  { name: 'minecraft:red_terracotta',         r: 143, g:  61, b:  46 },
  { name: 'minecraft:black_terracotta',       r:  37, g:  22, b:  16 },
  // Stone types
  { name: 'minecraft:stone',                  r: 125, g: 125, b: 125 },
  { name: 'minecraft:smooth_stone',           r: 160, g: 160, b: 160 },
  { name: 'minecraft:cobblestone',            r: 127, g: 127, b: 127 },
  { name: 'minecraft:granite',                r: 149, g: 103, b:  83 },
  { name: 'minecraft:diorite',                r: 188, g: 188, b: 188 },
  { name: 'minecraft:andesite',               r: 136, g: 136, b: 136 },
  { name: 'minecraft:blackstone',             r:  43, g:  37, b:  46 },
  { name: 'minecraft:deepslate',              r:  74, g:  74, b:  80 },
  // Sand / gravel
  { name: 'minecraft:sand',                   r: 218, g: 207, b: 158 },
  { name: 'minecraft:red_sand',               r: 179, g:  97, b:  31 },
  { name: 'minecraft:sandstone',              r: 218, g: 207, b: 158 },
  { name: 'minecraft:red_sandstone',          r: 179, g:  97, b:  31 },
  // Metal/ore blocks
  { name: 'minecraft:iron_block',             r: 220, g: 220, b: 220 },
  { name: 'minecraft:gold_block',             r: 249, g: 236, b:  78 },
  { name: 'minecraft:diamond_block',          r:  99, g: 219, b: 213 },
  { name: 'minecraft:emerald_block',          r:  67, g: 190, b: 113 },
  { name: 'minecraft:lapis_block',            r:  29, g:  73, b: 149 },
  { name: 'minecraft:redstone_block',         r: 167, g:  18, b:   4 },
  { name: 'minecraft:coal_block',             r:  20, g:  20, b:  20 },
  { name: 'minecraft:copper_block',           r: 184, g:  91, b:  62 },
  { name: 'minecraft:netherite_block',        r:  68, g:  63, b:  68 },
  // Wood planks
  { name: 'minecraft:oak_planks',             r: 162, g: 130, b:  78 },
  { name: 'minecraft:spruce_planks',          r: 114, g:  84, b:  48 },
  { name: 'minecraft:birch_planks',           r: 194, g: 173, b: 120 },
  { name: 'minecraft:jungle_planks',          r: 160, g: 115, b:  80 },
  { name: 'minecraft:acacia_planks',          r: 168, g:  90, b:  50 },
  { name: 'minecraft:dark_oak_planks',        r:  67, g:  43, b:  20 },
  { name: 'minecraft:mangrove_planks',        r: 115, g:  54, b:  44 },
  { name: 'minecraft:cherry_planks',          r: 239, g: 173, b: 163 },
  { name: 'minecraft:crimson_planks',         r: 149, g:  53, b:  71 },
  { name: 'minecraft:warped_planks',          r:  43, g: 104, b:  95 },
  // Special blocks
  { name: 'minecraft:quartz_block',           r: 235, g: 229, b: 221 },
  { name: 'minecraft:snow_block',             r: 249, g: 255, b: 254 },
  { name: 'minecraft:bone_block',             r: 226, g: 224, b: 194 },
  { name: 'minecraft:obsidian',               r:  23, g:  17, b:  34 },
  { name: 'minecraft:glowstone',              r: 210, g: 175, b: 117 },
  { name: 'minecraft:hay_block',              r: 176, g: 147, b:  19 },
  { name: 'minecraft:purpur_block',           r: 169, g: 125, b: 169 },
  { name: 'minecraft:end_stone',              r: 219, g: 219, b: 172 },
  { name: 'minecraft:packed_ice',             r: 141, g: 180, b: 226 },
  { name: 'minecraft:clay',                   r: 162, g: 166, b: 182 },
  { name: 'minecraft:dirt',                   r: 134, g:  96, b:  67 },
  { name: 'minecraft:podzol',                 r: 131, g:  91, b:  51 },
  { name: 'minecraft:mycelium',               r: 111, g:  99, b: 119 },
  { name: 'minecraft:netherrack',             r: 116, g:  55, b:  55 },
  { name: 'minecraft:soul_sand',              r: 130, g: 108, b:  89 },
  { name: 'minecraft:magma_block',            r: 130, g:  56, b:  14 },
  { name: 'minecraft:nether_bricks',          r:  44, g:  22, b:  24 },
  { name: 'minecraft:basalt',                 r:  80, g:  80, b:  89 },
];

/** Pre-computed Lab values for each palette entry */
const PALETTE_LAB: Array<readonly [number, number, number]> = BLOCK_PALETTE.map(
  e => rgbToLab(e.r, e.g, e.b),
);

/**
 * Find the Minecraft block name whose color is perceptually closest to the
 * given sRGB value (Euclidean distance in CIE Lab space).
 */
export function closestBlock(r: number, g: number, b: number): string {
  const lab = rgbToLab(r, g, b);
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE_LAB.length; i++) {
    const d = deltaE(lab, PALETTE_LAB[i]!);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return BLOCK_PALETTE[bestIdx]!.name;
}
