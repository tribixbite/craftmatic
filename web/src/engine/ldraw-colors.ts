/**
 * LDraw standard color ID → Minecraft block state mapping.
 *
 * Color definitions sourced from the LDraw Color Definition Reference:
 * https://www.ldraw.org/article/547.html
 *
 * Transparent LDraw colors map to Minecraft stained glass;
 * metallic/chrome colors map to ore/metal blocks.
 */

import { closestBlock } from './color-utils.js';

/** Direct mapping from LDraw color ID → Minecraft block state */
export const LDRAW_COLOR_TO_BLOCK: Record<number, string> = {
  // ── Standard Solid Colors ────────────────────────────────────────────────
  0:   'minecraft:black_concrete',        // Black
  1:   'minecraft:blue_concrete',         // Blue
  2:   'minecraft:green_concrete',        // Green
  3:   'minecraft:cyan_concrete',         // Dark Turquoise
  4:   'minecraft:red_concrete',          // Red
  5:   'minecraft:magenta_concrete',      // Dark Pink
  6:   'minecraft:brown_concrete',        // Brown
  7:   'minecraft:light_gray_concrete',   // Light Gray
  8:   'minecraft:gray_concrete',         // Dark Gray
  9:   'minecraft:light_blue_concrete',   // Light Blue
  10:  'minecraft:lime_concrete',         // Bright Green
  11:  'minecraft:cyan_concrete',         // Light Turquoise
  12:  'minecraft:pink_concrete',         // Salmon
  13:  'minecraft:pink_concrete',         // Pink
  14:  'minecraft:yellow_concrete',       // Yellow
  15:  'minecraft:white_concrete',        // White
  17:  'minecraft:lime_concrete',         // Light Green
  18:  'minecraft:yellow_concrete',       // Light Yellow
  19:  'minecraft:sandstone',             // Tan
  20:  'minecraft:light_blue_concrete',   // Light Violet
  22:  'minecraft:purple_concrete',       // Purple
  23:  'minecraft:blue_concrete',         // Dark Blue-Violet
  25:  'minecraft:orange_concrete',       // Orange
  26:  'minecraft:magenta_concrete',      // Magenta
  27:  'minecraft:lime_concrete',         // Lime
  28:  'minecraft:brown_concrete',        // Dark Tan
  29:  'minecraft:pink_concrete',         // Bright Pink
  30:  'minecraft:purple_concrete',       // Medium Lavender
  31:  'minecraft:light_blue_concrete',   // Lavender
  32:  'minecraft:yellow_concrete',       // Very Light Orange-Yellow

  // ── Transparent Colors → Stained Glass ──────────────────────────────────
  // IDs verified against LDConfig.ldr (LDraw standard color definitions)
  33:  'minecraft:blue_stained_glass',    // Trans_Dark_Blue  (#0020A0)
  34:  'minecraft:green_stained_glass',   // Trans_Green      (#237841)
  35:  'minecraft:lime_stained_glass',    // Trans_Bright_Green (#56E646)
  36:  'minecraft:red_stained_glass',     // Trans_Red        (#C91A09)
  37:  'minecraft:pink_stained_glass',    // Trans_Dark_Pink  (#DF6695)
  38:  'minecraft:orange_stained_glass',  // Trans_Neon_Orange (#FF800D)
  40:  'minecraft:gray_stained_glass',    // Trans_Black      (#635F52)
  41:  'minecraft:light_blue_stained_glass', // Trans_Medium_Blue (#559AB7)
  42:  'minecraft:lime_stained_glass',    // Trans_Neon_Green (#C0FF00)
  43:  'minecraft:light_blue_stained_glass', // Trans_Light_Blue (#AEE9EF)
  44:  'minecraft:purple_stained_glass',  // Trans_Light_Purple (#96709F)
  45:  'minecraft:pink_stained_glass',    // Trans_Pink       (#FC97AC)
  46:  'minecraft:yellow_stained_glass',  // Trans_Yellow     (#F5CD2F)
  47:  'minecraft:glass',                 // Trans_Clear      (#FCFCFC)
  48:  'minecraft:green_stained_glass',   // Trans_Dark_Green (unofficial old ID)
  49:  'minecraft:orange_stained_glass',  // Trans_Neon_Orange (unofficial old ID)
  111: 'minecraft:gray_stained_glass',    // Trans_Black (old code 40 alias)
  113: 'minecraft:light_blue_stained_glass', // Trans_Medium_Blue variant
  114: 'minecraft:pink_stained_glass',    // Glitter_Trans_Dark_Pink (#DF6695)
  117: 'minecraft:glass',                 // Glitter_Trans_Clear     (#FFFFFF)
  234: 'minecraft:orange_stained_glass',  // Trans_Fire_Yellow (orangeish)

  // ── Extended Solid Colors ────────────────────────────────────────────────
  68:  'minecraft:orange_concrete',       // Very Light Orange
  69:  'minecraft:blue_concrete',         // Light Lilac → closest blue
  70:  'minecraft:brown_concrete',        // Reddish Brown
  71:  'minecraft:light_gray_concrete',   // Light Bluish Gray
  72:  'minecraft:gray_concrete',         // Dark Bluish Gray
  73:  'minecraft:light_blue_concrete',   // Medium Blue
  74:  'minecraft:lime_concrete',         // Medium Green
  77:  'minecraft:pink_concrete',         // Pink
  78:  'minecraft:white_concrete',        // Light Flesh
  84:  'minecraft:orange_concrete',       // Medium Dark Flesh
  85:  'minecraft:purple_concrete',       // Dark Purple
  86:  'minecraft:brown_concrete',        // Dark Flesh
  92:  'minecraft:orange_concrete',       // Flesh
  100: 'minecraft:pink_concrete',         // Light Salmon
  110: 'minecraft:blue_concrete',         // Violet
  112: 'minecraft:blue_concrete',         // Medium Violet
  115: 'minecraft:lime_concrete',         // Medium Lime
  118: 'minecraft:cyan_concrete',         // Aqua
  120: 'minecraft:lime_concrete',         // Light Lime
  125: 'minecraft:orange_concrete',       // Light Orange
  128: 'minecraft:orange_concrete',       // Dark Orange

  // ── Bright/Vivid ─────────────────────────────────────────────────────────
  191: 'minecraft:orange_concrete',       // Bright Light Orange
  212: 'minecraft:light_blue_concrete',   // Bright Light Blue
  216: 'minecraft:red_concrete',          // Rust
  226: 'minecraft:yellow_concrete',       // Bright Light Yellow
  272: 'minecraft:blue_concrete',         // Dark Blue
  288: 'minecraft:green_concrete',        // Dark Green
  294: 'minecraft:white_concrete',        // Glow In Dark White → white_concrete
  308: 'minecraft:brown_concrete',        // Dark Brown
  313: 'minecraft:light_blue_concrete',   // Maersk Blue
  320: 'minecraft:red_concrete',          // Dark Red
  321: 'minecraft:cyan_concrete',         // Dark Azure
  322: 'minecraft:cyan_concrete',         // Medium Azure
  323: 'minecraft:light_blue_concrete',   // Light Aqua
  324: 'minecraft:red_concrete',          // Red (LDConfig #C40026)
  326: 'minecraft:lime_concrete',         // Spring Yellowish Green

  // ── Metallic / Special ───────────────────────────────────────────────────
  80:  'minecraft:iron_block',            // Metallic Silver
  81:  'minecraft:gold_block',            // Metallic Green (closest)
  82:  'minecraft:gold_block',            // Metallic Gold
  83:  'minecraft:iron_block',            // Metallic Dark Gray
  87:  'minecraft:iron_block',            // Metal
  297: 'minecraft:gold_block',            // Pearl Gold
  494: 'minecraft:iron_block',            // Electric Contact / Chrome Silver
  495: 'minecraft:iron_block',            // Chrome Antique Brass
  496: 'minecraft:light_gray_concrete',   // Light Bluish Gray (#A3A2A4)

  // ── Rubber Colors ────────────────────────────────────────────────────────
  256: 'minecraft:black_concrete',        // Rubber Black
  273: 'minecraft:blue_concrete',         // Rubber Blue
  // 324 already mapped above (Red)
  375: 'minecraft:light_gray_concrete',   // Rubber Light Gray
  // BrickLink Studio 10xxx rubber color IDs (used in tree foliage, tires, etc.)
  10002: 'minecraft:lime_concrete',       // Rubber Green (#58AB41)
  10070: 'minecraft:brown_concrete',      // Rubber Reddish Brown (#5F3109)
  10320: 'minecraft:red_concrete',        // Rubber Dark Red (#720012)
  10484: 'minecraft:orange_concrete',     // Rubber Dark Orange (#91501C)
  10047: 'minecraft:white_concrete',      // Rubber White
  10026: 'minecraft:red_concrete',        // Rubber Red

  // ── Extended colors referenced by LDD/LXF pipeline ─────────────────────
  21:  'minecraft:lime_concrete',         // Glow In Dark Opaque (yellowish-green)
  39:  'minecraft:cyan_stained_glass',    // Trans-Dark Turquoise
  45:  'minecraft:pink_stained_glass',    // Trans-Dark Pink (medium)
  52:  'minecraft:pink_stained_glass',    // Glitter Trans-Dark Pink
  54:  'minecraft:gray_concrete',         // Copper/Speckle
  57:  'minecraft:orange_stained_glass',  // Trans-Orange
  62:  'minecraft:lime_stained_glass',    // Trans-Light Green
  63:  'minecraft:blue_concrete',         // Dark Blue (old ID)
  65:  'minecraft:gold_block',            // Metallic Gold (Chrome)
  75:  'minecraft:lime_stained_glass',    // Trans-Bright Green
  79:  'minecraft:white_concrete',        // Milky White
  89:  'minecraft:purple_concrete',       // Reddish Lilac
  96:  'minecraft:orange_concrete',       // Very Light Orange
  129: 'minecraft:iron_block',            // Pearl Very Light Gray
  133: 'minecraft:light_blue_stained_glass', // Trans-Medium Blue
  134: 'minecraft:gray_concrete',         // Unknown (gray fallback)
  135: 'minecraft:white_concrete',        // Satin White
  137: 'minecraft:gray_concrete',         // Pearl Dark Gray
  139: 'minecraft:gray_concrete',         // Unknown (gray fallback)
  142: 'minecraft:lime_stained_glass',    // Trans-Fluorescent Green
  143: 'minecraft:blue_stained_glass',    // Trans-Fluorescent Blue
  148: 'minecraft:gray_concrete',         // Metallic Dark Grey
  150: 'minecraft:glass',                 // Glitter Trans-Clear
  151: 'minecraft:white_concrete',        // Milky White (alt)
  178: 'minecraft:sandstone',             // Sandy Yellow
  179: 'minecraft:iron_block',            // Flat Silver
  183: 'minecraft:white_concrete',        // Pearl White
  184: 'minecraft:pink_concrete',         // Chrome Pink
  218: 'minecraft:orange_concrete',       // Fabuland Orange
  219: 'minecraft:purple_concrete',       // Lilac
  232: 'minecraft:light_blue_concrete',   // Sky Blue
  284: 'minecraft:pink_stained_glass',    // Trans-Medium Reddish Violet
  285: 'minecraft:lime_stained_glass',    // Trans-Light Green (bright)
  293: 'minecraft:blue_stained_glass',    // Trans-Blue
  295: 'minecraft:pink_stained_glass',    // Trans-Bright Pink
  296: 'minecraft:purple_stained_glass',  // Trans-Light Purple
  300: 'minecraft:lime_stained_glass',    // Glitter Trans-Neon Green
  302: 'minecraft:lime_stained_glass',    // Trans-Neon Green
  306: 'minecraft:lime_stained_glass',    // Trans-Bright Green (alt)
  329: 'minecraft:pink_stained_glass',    // Trans-Pink
  330: 'minecraft:green_concrete',        // Olive Green
  334: 'minecraft:pink_concrete',         // Bright Pink
  335: 'minecraft:red_concrete',          // Sand Red
  351: 'minecraft:red_concrete',          // Medium Red
  353: 'minecraft:pink_concrete',         // Coral
  366: 'minecraft:orange_concrete',       // Bright Light Orange
  373: 'minecraft:purple_concrete',       // Sand Purple
  378: 'minecraft:green_concrete',        // Sand Green
  379: 'minecraft:light_blue_concrete',   // Sand Blue
  450: 'minecraft:brown_concrete',        // Fabuland Brown
  462: 'minecraft:orange_concrete',       // Medium Orange
  484: 'minecraft:orange_concrete',       // Dark Orange
  503: 'minecraft:light_gray_concrete',   // Light Stone Gray
  507: 'minecraft:light_blue_concrete',   // Aqua
  508: 'minecraft:light_gray_concrete',   // Pearl Very Light Gray (alt)

  // ── Chrome / Speckle / Rubber / Special — LDConfig colours not yet mapped ──
  605: 'minecraft:orange_stained_glass',     // Trans_Light_Orange
  383: 'minecraft:light_gray_concrete',      // Chrome_Silver (#E0E0E0)
   60: 'minecraft:gray_terracotta',          // Chrome_Antique_Brass (#645A4C)
   64: 'minecraft:black_concrete',           // Chrome_Black (#1B2A34)
   61: 'minecraft:light_blue_concrete',      // Chrome_Blue (#6C96BF)
  601: 'minecraft:white_terracotta',         // Glow_In_Dark_White (#BDC6AD)
  132: 'minecraft:black_concrete',           // Speckle_Black_Silver
   76: 'minecraft:gray_concrete',            // Speckle_Dark_Bluish_Gray_Silver
   66: 'minecraft:yellow_stained_glass',     // Rubber_Trans_Yellow
   67: 'minecraft:glass',                    // Rubber_Trans_Clear
  350: 'minecraft:orange_concrete',          // Rubber_Orange (#D06610)
  406: 'minecraft:blue_concrete',            // Rubber_Dark_Blue (#001D68)
  449: 'minecraft:purple_concrete',          // Rubber_Purple (#81007B)
  490: 'minecraft:lime_concrete',            // Rubber_Lime (#D7F000)
  504: 'minecraft:gray_concrete',            // Rubber_Flat_Silver (#898788)
  511: 'minecraft:white_concrete',           // Rubber_White (#FAFAFA)
  493: 'minecraft:gray_concrete',            // Magnet (#656761)

  // ── Edge / Meta ──────────────────────────────────────────────────────────
  16:  'minecraft:gray_concrete',         // Main_Color placeholder
  24:  'minecraft:black_concrete',        // Edge Color
};

/** Resolve LDraw color ID to a Minecraft block state string. */
export function ldrawColorToBlock(colorId: number): string {
  const explicit = LDRAW_COLOR_TO_BLOCK[colorId];
  if (explicit) return explicit;
  // Perceptual fallback: if we know the RGB, find the closest Minecraft block
  const hex = LDRAW_COLOR_RGB[colorId];
  if (hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const match = closestBlock(r, g, b);
    // Cache so we only compute once per color ID
    LDRAW_COLOR_TO_BLOCK[colorId] = match;
    return match;
  }
  return 'minecraft:gray_concrete';
}

/**
 * LDraw color ID → hex RGB (for display in UI and perceptual fallback).
 * Comprehensive list from LDConfig.ldr (LDraw standard color definitions).
 */
export const LDRAW_COLOR_RGB: Record<number, string> = {
  // ── Standard solid colors ──
  // All RGB values from LDConfig.ldr (authoritative source).
  // ── Standard solid colors (0–31) ──
  0: '#05131D', 1: '#0055BF', 2: '#257A3E', 3: '#00838F',
  4: '#C91A09', 5: '#C870A0', 6: '#583927', 7: '#9BA19D',
  8: '#6D6E5C', 9: '#B4D2E3', 10: '#4B9F4A', 11: '#55A5AF',
  12: '#F2705E', 13: '#FC97AC', 14: '#F2CD37', 15: '#FFFFFF',
  17: '#C2DAB8', 18: '#FBE696', 19: '#E4CD9E', 20: '#C9CAE2',
  21: '#E0FFB0', 22: '#81007B', 23: '#2032B0', 25: '#FE8A18',
  26: '#923978', 27: '#BBE90B', 28: '#958A73', 29: '#E4ADC8',
  30: '#AC78BA', 31: '#E1D5ED', 32: '#000000',
  // ── Transparent (33–69) ──
  33: '#0020A0', 34: '#237841', 35: '#56E646', 36: '#C91A09',
  37: '#DF6695', 38: '#FF800D', 39: '#C1DFF0', 40: '#635F52',
  41: '#559AB7', 42: '#C0FF00', 43: '#AEE9EF', 44: '#96709F',
  45: '#FC97AC', 46: '#F5CD2F', 47: '#FCFCFC', 52: '#A5A5CB',
  54: '#DAB000', 57: '#F08F1C', 60: '#645A4C', 61: '#6C96BF',
  62: '#3CB371', 63: '#AA4D8E', 64: '#1B2A34', 65: '#F5CD2F',
  66: '#CAB000', 67: '#FFFFFF', 68: '#F3CF9B', 69: '#CD6298',
  // ── Extended solids (70–100) ──
  70: '#582A12', 71: '#A0A5A9', 72: '#6C6E68', 73: '#5C9DD1',
  74: '#73DCA1', 75: '#AB6038', 76: '#898788', 77: '#FECCCF',
  78: '#F6D7B3', 79: '#FFFFFF', 80: '#A5A9B4', 81: '#899B5F',
  82: '#DBAC34', 83: '#1A2831', 84: '#CC702A', 85: '#3F3691',
  86: '#7C503A', 87: '#6D6E5C', 89: '#4C61DB', 92: '#D09168',
  100: '#FEBABD',
  // ── More extended (110–184) ──
  110: '#4354A3', 112: '#6874CA', 114: '#923978',
  115: '#C7D23C', 117: '#FFFFFF', 118: '#B3D7D1',
  120: '#D9E4A7', 125: '#F9BA61', 129: '#8C00FF',
  132: '#898788', 133: '#DBAC34', 134: '#964A27',
  135: '#9CA3A8', 137: '#5677BA', 142: '#DCBE61',
  148: '#575857', 150: '#BBBDBC', 151: '#E6E3E0',
  178: '#B4883E', 179: '#898788', 183: '#F2F3F2',
  // ── Bright/Vivid (191–605) ──
  191: '#F8BB3D', 212: '#86C1E1', 216: '#B31004',
  226: '#FFF03A', 232: '#56BED6',
  256: '#212121', 272: '#0D325B', 273: '#0033B2',
  288: '#184632', 294: '#BDC6AD', 297: '#CC9C2B', 308: '#352100',
  313: '#54A9C8', 320: '#720E0F', 321: '#1498D7', 322: '#3EC2DD',
  323: '#BDDCD8', 324: '#C40026', 326: '#DFEEA5',
  330: '#9B9A5A', 334: '#BBA53D', 335: '#D67572',
  350: '#D06610', 351: '#F785B1', 366: '#FA9C1C',
  373: '#845E84', 375: '#C1C2C1', 378: '#A0BCAC', 379: '#597184',
  383: '#E0E0E0', 406: '#001D68', 449: '#81007B', 450: '#B67B50',
  462: '#FFA70B', 484: '#A95500', 490: '#D7F000', 493: '#656761',
  494: '#D0D0D0', 495: '#AE7A59', 496: '#A3A2A4', 503: '#E6E3DA',
  504: '#898788', 511: '#FAFAFA',
  601: '#BDC6AD', 605: '#FF9F2C',
  // BrickLink Studio 10xxx rubber color IDs (from StudioColorDefinition.txt)
  10002: '#58AB41', 10026: '#B40000', 10047: '#FFFFFF',
  10070: '#5F3109', 10320: '#720012', 10484: '#91501C',
};
