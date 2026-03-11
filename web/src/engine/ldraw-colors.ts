/**
 * LDraw standard color ID → Minecraft block state mapping.
 *
 * Color definitions sourced from the LDraw Color Definition Reference:
 * https://www.ldraw.org/article/547.html
 *
 * Transparent LDraw colors map to Minecraft stained glass;
 * metallic/chrome colors map to ore/metal blocks.
 */

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
  33:  'minecraft:glass',                 // Trans-Clear
  34:  'minecraft:lime_stained_glass',    // Trans-Neon Green
  35:  'minecraft:orange_stained_glass',  // Trans-Neon Orange
  36:  'minecraft:red_stained_glass',     // Trans-Red
  37:  'minecraft:purple_stained_glass',  // Trans-Dark Pink
  38:  'minecraft:green_stained_glass',   // Trans-Neon Green alt
  40:  'minecraft:glass',                 // Trans-Clear
  41:  'minecraft:red_stained_glass',     // Trans-Red
  42:  'minecraft:lime_stained_glass',    // Trans-Neon Green
  43:  'minecraft:blue_stained_glass',    // Trans-Blue
  44:  'minecraft:yellow_stained_glass',  // Trans-Yellow
  45:  'minecraft:pink_stained_glass',    // Trans-Dark Pink
  46:  'minecraft:yellow_stained_glass',  // Trans-Yellow alt
  47:  'minecraft:glass',                 // Trans-Clear alt
  48:  'minecraft:green_stained_glass',   // Trans-Green
  49:  'minecraft:orange_stained_glass',  // Trans-Neon Orange
  111: 'minecraft:gray_stained_glass',    // Trans-Black
  113: 'minecraft:light_blue_stained_glass', // Trans-Medium Blue
  114: 'minecraft:lime_stained_glass',    // Trans-Neon Green
  117: 'minecraft:light_blue_stained_glass', // Trans-Light Blue
  234: 'minecraft:orange_stained_glass',  // Trans-Fire Yellow

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
  324: 'minecraft:pink_concrete',         // Coral
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
  496: 'minecraft:iron_block',            // Chrome Silver

  // ── Rubber Colors ────────────────────────────────────────────────────────
  256: 'minecraft:black_concrete',        // Rubber Black
  273: 'minecraft:blue_concrete',         // Rubber Blue
  324: 'minecraft:pink_concrete',         // Rubber Pink
  375: 'minecraft:light_gray_concrete',   // Rubber Light Gray

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

  // ── Edge / Meta ──────────────────────────────────────────────────────────
  16:  'minecraft:gray_concrete',         // Main_Color placeholder
  24:  'minecraft:black_concrete',        // Edge Color
};

/** Resolve LDraw color ID to a Minecraft block state string. */
export function ldrawColorToBlock(colorId: number): string {
  return LDRAW_COLOR_TO_BLOCK[colorId] ?? 'minecraft:gray_concrete';
}

/**
 * LDraw color ID → hex RGB (for display in UI).
 * Covers the most common colors only.
 */
export const LDRAW_COLOR_RGB: Record<number, string> = {
  0: '#05131D', 1: '#0055BF', 2: '#237841', 3: '#008F9B',
  4: '#C91A09', 5: '#C870A0', 6: '#583927', 7: '#9BA19D',
  8: '#6D6E5C', 9: '#B4D2E3', 10: '#4B9F4A', 11: '#55A5AF',
  12: '#F2705E', 13: '#FC97AC', 14: '#F2CD37', 15: '#FFFFFF',
  17: '#C2DAB8', 18: '#FBE696', 19: '#E4CD9E', 20: '#C9CAE2',
  22: '#81007B', 23: '#2032B0', 25: '#FE8A18', 26: '#923978',
  27: '#BBE90B', 28: '#958A73', 29: '#E4ADC8', 30: '#AC78BA',
  31: '#E1D5ED', 70: '#582A12', 71: '#A0A5A9', 72: '#6C6E68',
  73: '#5C9DD1', 74: '#73DCA1', 85: '#3F3691', 92: '#D09168',
  191: '#F8BB3D', 216: '#B31004', 226: '#FFE371', 272: '#0D325B',
  288: '#184632', 297: '#CC9C2B', 308: '#352100', 320: '#720E0F',
  321: '#078BC9', 324: '#FF698F',
};
