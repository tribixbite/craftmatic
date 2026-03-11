/**
 * BrickLink Studio color ID → Minecraft block mapping.
 *
 * BrickLink Studio (.io) files embed Studio/BrickLink color IDs in their
 * LDraw type-1 lines — NOT standard LDraw color IDs. This is confirmed by
 * BrickStore (documentio.cpp) and Studio's own StudioColorDefinition.txt.
 *
 * Derived from: Studio/data/StudioColorDefinition.txt (col 1 = Studio code,
 * col 9 = RGB). Transparent colors map to stained glass; metallic/pearl to
 * ore blocks; solid colors to the nearest concrete shade.
 */

export const STUDIO_COLOR_TO_BLOCK: Record<number, string> = {
  // ── Special / meta ──────────────────────────────────────────────────────────
  [-2]: 'minecraft:black_concrete',      // EdgeColor
  [-1]: 'minecraft:gray_concrete',       // MainColor (inherit from parent)

  // ── Core solid colours ───────────────────────────────────────────────────────
  1:   'minecraft:white_concrete',        // White       #FEFEFE
  2:   'minecraft:sandstone',             // Tan         #E3CC9D
  3:   'minecraft:yellow_concrete',       // Yellow      #F1CC36
  4:   'minecraft:orange_concrete',       // Orange      #FD8917
  5:   'minecraft:red_concrete',          // Red         #C81908
  6:   'minecraft:green_concrete',        // Dark Green  #24793D
  7:   'minecraft:blue_concrete',         // Blue        #0054BE
  8:   'minecraft:brown_concrete',        // Brown       #573826
  9:   'minecraft:light_gray_concrete',   // Light Gray  #9AA09C
  10:  'minecraft:gray_concrete',         // Dark Gray   #6C6D5B
  11:  'minecraft:black_concrete',        // Black       #04121C
  23:  'minecraft:pink_concrete',         // Pink        #FB96AB
  24:  'minecraft:purple_concrete',       // Purple      #80007A
  25:  'minecraft:pink_concrete',         // Salmon      #F16F5D
  26:  'minecraft:pink_concrete',         // Light Salmon #FDB9BC
  27:  'minecraft:red_concrete',          // Rust        #B20F03
  28:  'minecraft:orange_concrete',       // Nougat      #CF9067
  29:  'minecraft:orange_concrete',       // Earth Orange #F99B1B
  31:  'minecraft:orange_concrete',       // Medium Orange #FEA60A
  32:  'minecraft:orange_concrete',       // Light Orange #F8B960
  33:  'minecraft:yellow_concrete',       // Light Yellow #FAE595
  34:  'minecraft:lime_concrete',         // Lime        #BAE80A
  35:  'minecraft:lime_concrete',         // Light Lime  #e2db5f
  36:  'minecraft:lime_concrete',         // Bright Green #4A9E49
  37:  'minecraft:lime_concrete',         // Medium Green #72DBA0
  38:  'minecraft:lime_concrete',         // Light Green  #C1D9B7
  39:  'minecraft:cyan_concrete',         // Dark Turquoise #00828E
  40:  'minecraft:cyan_concrete',         // Light Turquoise #54A4AE
  41:  'minecraft:cyan_concrete',         // Aqua        #B2D6D0
  42:  'minecraft:light_blue_concrete',   // Medium Blue  #5B9CD0
  43:  'minecraft:blue_concrete',         // Violet      #4253A2
  44:  'minecraft:light_blue_concrete',   // Light Violet #C9CAE2
  46:  'minecraft:lime_concrete',         // Glow In Dark Opaque #DFFEAF
  47:  'minecraft:pink_concrete',         // Dark Pink   #C76F9F
  48:  'minecraft:green_concrete',        // Sand Green  #9FBBAB
  49:  'minecraft:white_concrete',        // Very Light Gray #E5E2D9
  54:  'minecraft:purple_concrete',       // Sand Purple #835D83
  55:  'minecraft:blue_concrete',         // Sand Blue   #587083
  56:  'minecraft:pink_concrete',         // Light Pink  #FDCBCE
  58:  'minecraft:red_concrete',          // Sand Red    #a37876
  59:  'minecraft:red_concrete',          // Dark Red    #710D0E
  62:  'minecraft:light_blue_concrete',   // Light Blue  #B3D1E2
  63:  'minecraft:blue_concrete',         // Dark Blue   #0C315A
  68:  'minecraft:orange_concrete',       // Dark Orange #A85400
  69:  'minecraft:brown_concrete',        // Dark Tan    #948972
  71:  'minecraft:magenta_concrete',      // Magenta     #913877
  72:  'minecraft:light_blue_concrete',   // Maersk Blue #53A8C7
  73:  'minecraft:blue_concrete',         // Medium Violet #6773C9
  76:  'minecraft:lime_concrete',         // Medium Lime #C6D13B
  80:  'minecraft:green_concrete',        // Dark Green  #174531
  85:  'minecraft:gray_concrete',         // Dark Bluish Gray #6B6D67
  86:  'minecraft:light_gray_concrete',   // Light Bluish Gray #9FA4A8
  87:  'minecraft:light_blue_concrete',   // Sky Blue    #55BDD5
  88:  'minecraft:brown_concrete',        // Reddish Brown #572911
  89:  'minecraft:purple_concrete',       // Dark Purple #3E3590
  90:  'minecraft:sandstone',             // Light Nougat #F5D6B2
  91:  'minecraft:brown_concrete',        // Light Brown #7B4F39
  93:  'minecraft:purple_concrete',       // Light Purple #AF3195
  94:  'minecraft:pink_concrete',         // Medium Dark Pink #F684B0
  96:  'minecraft:sandstone',             // Very Light Orange #F2CE9A
  97:  'minecraft:blue_concrete',         // Royal Blue  #4B60DA
  99:  'minecraft:white_concrete',        // Very Light Bluish Gray #E5E2DF
  103: 'minecraft:yellow_concrete',       // Bright Light Yellow #FEEF39
  104: 'minecraft:pink_concrete',         // Bright Pink #E3ACC7
  105: 'minecraft:light_blue_concrete',   // Bright Light Blue #85C0E0
  106: 'minecraft:brown_concrete',        // Fabuland Brown #B3694E
  109: 'minecraft:blue_concrete',         // Dark Royal Blue #1F31AF
  110: 'minecraft:orange_concrete',       // Bright Light Orange #F7BA3C
  111: 'minecraft:gray_concrete',         // Speckle Black-Silver
  116: 'minecraft:gray_concrete',         // Speckle Black-Copper
  117: 'minecraft:gray_concrete',         // Speckle DBGray-Silver
  119: 'minecraft:iron_block',            // Pearl Very Light Gray #BABCBB
  120: 'minecraft:brown_concrete',        // Dark Brown  #442800
  122: 'minecraft:black_concrete',        // Chrome Black #1A2933
  150: 'minecraft:orange_concrete',       // Medium Nougat #e3a05b
  151: 'minecraft:gray_concrete',         // Speckle Black-Gold
  152: 'minecraft:cyan_concrete',         // Light Aqua  #BCDBD7
  153: 'minecraft:blue_concrete',         // Dark Azure  #1397D6
  154: 'minecraft:light_blue_concrete',   // Lavender    #E0D4EC
  155: 'minecraft:lime_concrete',         // Olive Green #9A9959
  156: 'minecraft:cyan_concrete',         // Medium Azure #3DC1DC
  157: 'minecraft:purple_concrete',       // Medium Lavender #AB77B9
  158: 'minecraft:lime_concrete',         // Yellowish Green #DEEDA4
  159: 'minecraft:white_concrete',        // Glow In Dark White #ECECEC
  160: 'minecraft:orange_concrete',       // Fabuland Orange #D6923D
  165: 'minecraft:orange_concrete',       // Neon Orange #FF7052
  166: 'minecraft:lime_concrete',         // Neon Green  #BCEF66
  168: 'minecraft:brown_concrete',        // Dark Nougat #A95500
  173: 'minecraft:yellow_concrete',       // Ochre Yellow #DD9E47
  174: 'minecraft:blue_concrete',         // Blue Violet #665EA7
  175: 'minecraft:pink_concrete',         // Warm Pink   #F79B9B
  220: 'minecraft:pink_concrete',         // Coral       #ff7575
  227: 'minecraft:light_blue_concrete',   // Clikits Lavender #eeadf7
  236: 'minecraft:yellow_concrete',       // Neon Yellow #EDFF21
  237: 'minecraft:brown_concrete',        // Bionicle Copper
  240: 'minecraft:brown_concrete',        // Medium Brown #755945
  241: 'minecraft:sandstone',             // Medium Tan  #CCA372
  249: 'minecraft:brown_concrete',        // Reddish Copper
  254: 'minecraft:blue_concrete',         // Pearl Blue  #0059A3

  // ── Metallic / pearl / chrome ────────────────────────────────────────────────
  21:  'minecraft:gold_block',            // Chrome Gold #BAA43C
  22:  'minecraft:iron_block',            // Chrome Silver #DFDFDF
  52:  'minecraft:iron_block',            // Chrome Blue  #6B95BE
  57:  'minecraft:brown_concrete',        // Chrome Antique Brass #63594B
  60:  'minecraft:white_concrete',        // Milky White  #FEFEFE
  61:  'minecraft:gold_block',            // Pearl Light Gold #DBBD60
  64:  'minecraft:green_concrete',        // Chrome Green #3BB270
  65:  'minecraft:gold_block',            // Metallic Gold #DAAB33
  66:  'minecraft:iron_block',            // Pearl Light Gray #9BA2A7
  67:  'minecraft:iron_block',            // Metallic Silver #A4A8B3
  70:  'minecraft:green_concrete',        // Metallic Green #889A5E
  77:  'minecraft:iron_block',            // Pearl Dark Gray #565756
  78:  'minecraft:blue_concrete',         // Pearl Sand Blue #5576B9
  81:  'minecraft:gold_block',            // Pearl Yellow (Bionicle Gold) #B3873D
  82:  'minecraft:pink_concrete',         // Chrome Pink #A94C8D
  83:  'minecraft:white_concrete',        // Pearl White #F1F2F1
  84:  'minecraft:brown_concrete',        // Copper      #954926
  95:  'minecraft:iron_block',            // Flat Silver #888687
  115: 'minecraft:gold_block',            // Pearl Gold  #CB9B2A

  // ── Transparent → stained glass ─────────────────────────────────────────────
  12:  'minecraft:glass',                 // Trans-Clear #FBFBFB
  13:  'minecraft:glass',                 // Trans-Brown #625E51
  14:  'minecraft:blue_stained_glass',    // Trans-Dark Blue #001F9F
  15:  'minecraft:light_blue_stained_glass', // Trans-Light Blue #ADE8EE
  17:  'minecraft:red_stained_glass',     // Trans-Red   #C81908
  18:  'minecraft:orange_stained_glass',  // Trans-Neon Orange #FE7F0C
  19:  'minecraft:yellow_stained_glass',  // Trans-Yellow #F4CC2E
  20:  'minecraft:green_stained_glass',   // Trans-Green #227740
  50:  'minecraft:pink_stained_glass',    // Trans-Dark Pink #DE6594
  51:  'minecraft:purple_stained_glass',  // Trans-Purple #A4A4CA
  74:  'minecraft:blue_stained_glass',    // Trans-Medium Blue #5499B6
  98:  'minecraft:orange_stained_glass',  // Trans-Orange #EF8E1B
  100: 'minecraft:pink_stained_glass',    // Glitter Trans-Dark Pink
  101: 'minecraft:glass',                 // Glitter Trans-Clear
  102: 'minecraft:purple_stained_glass',  // Glitter Trans-Purple
  107: 'minecraft:pink_stained_glass',    // Trans-Pink   #FB96AB
  108: 'minecraft:lime_stained_glass',    // Trans-Bright Green #55E545
  114: 'minecraft:purple_stained_glass',  // Trans-Light Purple #956F9E
  16:  'minecraft:lime_stained_glass',    // Trans-Neon Green #BFFE00
  118: 'minecraft:lime_stained_glass',    // Glow In Dark Trans #BCC5AC
  121: 'minecraft:yellow_stained_glass',  // Trans-Neon Yellow #D9AF00
  162: 'minecraft:light_blue_stained_glass', // Glitter Trans-Light Blue
  163: 'minecraft:lime_stained_glass',    // Glitter Trans-Neon Green
  164: 'minecraft:orange_stained_glass',  // Trans-Light Orange #F0A423
  221: 'minecraft:lime_stained_glass',    // Trans-Light Green #94E5AB
  222: 'minecraft:orange_stained_glass',  // Glitter Trans-Orange
  223: 'minecraft:light_blue_stained_glass', // Satin Trans-Light Blue
  224: 'minecraft:pink_stained_glass',    // Satin Trans-Dark Pink
  226: 'minecraft:lime_stained_glass',    // Trans-Light Bright Green
  228: 'minecraft:glass',                 // Satin Trans-Clear
  229: 'minecraft:glass',                 // Satin Trans-Brown
  230: 'minecraft:purple_stained_glass',  // Satin Trans-Purple
  232: 'minecraft:blue_stained_glass',    // Satin Trans-Dark Blue
  233: 'minecraft:lime_stained_glass',    // Satin Trans-Bright Green

  // ── Rubber variants (same colour as solid counterpart) ───────────────────────
  1000: 'minecraft:black_concrete',       // Rubber Black
  1001: 'minecraft:yellow_concrete',      // Rubber Yellow
  1002: 'minecraft:orange_concrete',      // Rubber Orange
  1003: 'minecraft:red_concrete',         // Rubber Red
  1004: 'minecraft:blue_concrete',        // Rubber Blue
  1005: 'minecraft:light_gray_concrete',  // Rubber Light Gray
  1006: 'minecraft:black_concrete',       // Metallic Black
  1007: 'minecraft:black_concrete',       // Rubber Black (alt)
  1008: 'minecraft:glass',                // Rubber Trans-Clear
  1009: 'minecraft:yellow_stained_glass', // Rubber Trans-Yellow
};

/** Resolve a BrickLink Studio color ID to a Minecraft block state string. */
export function studioColorToBlock(colorId: number): string {
  return STUDIO_COLOR_TO_BLOCK[colorId] ?? 'minecraft:gray_concrete';
}
