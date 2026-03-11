/**
 * LDD (LEGO Digital Designer) material ID → LDraw color code mapping.
 * Used when parsing .lxf files (LXFML brick data uses LDD material IDs).
 *
 * Derived from Studio's authoritative ldraw.xml:
 *   extracted/studio_release/app/data/ldraw.xml
 * Primary `type=""` entries used; `type="from_lego"` fills gaps.
 */

const LDD_TO_LDRAW: Record<number, number> = {
  // ── Solid colours ──────────────────────────────────────────────────────────
  1:   15,  // White
  2:   7,   // Light Grey
  3:   18,  // Brick Yellow / Light Yellow
  4:   12,  // Flame Yellowish Orange → Salmon/Light Pink
  5:   19,  // Brick Yellow / Tan
  6:   17,  // Light Green
  8:   218, // Medium Orange / Fabuland Orange
  9:   13,  // Pink
  11:  313, // Maersk Blue
  12:  450, // Fabuland Brown
  18:  92,  // Nougat / Flesh
  20:  79,  // Milky White
  21:  4,   // Bright Red
  22:  351, // Medium Red
  23:  1,   // Bright Blue
  24:  14,  // Bright Yellow
  25:  6,   // Brown / Earth Orange
  26:  0,   // Black
  27:  8,   // Dark Grey
  28:  2,   // Dark Green
  29:  74,  // Medium Green
  36:  68,  // Very Light Orange
  37:  10,  // Bright Green
  38:  484, // Dark Orange
  39:  20,  // Light Violet
  40:  47,  // Trans-Clear
  41:  36,  // Trans-Red
  42:  43,  // Trans-Blue (NOT Trans-Neon Green)
  43:  33,  // Trans-Clear
  44:  46,  // Trans-Yellow
  45:  9,   // Light Blue
  47:  38,  // Trans-Neon Green alt
  48:  34,  // Trans-Neon Green
  49:  42,  // Trans-Neon Green (bright)
  50:  294, // Glow In Dark White
  100: 100, // Light Salmon
  102: 73,  // Medium Blue
  103: 503, // Light Stone Gray
  104: 22,  // Purple
  105: 462, // Medium Orange
  106: 25,  // Bright Orange
  107: 3,   // Dark Turquoise
  110: 110, // Violet
  111: 40,  // Trans-Black → Trans-Clear (closest)
  112: 112, // Medium Violet
  113: 37,  // Trans-Dark Pink
  114: 114, // Trans-Neon Green
  115: 115, // Medium Lime
  116: 11,  // Light Turquoise
  117: 117, // Trans-Light Blue
  118: 118, // Aqua
  119: 27,  // Bright Yellowish Green / Lime
  120: 120, // Light Lime
  121: 507, // Bright Light Orange (Aquaracer)
  125: 125, // Light Orange
  126: 52,  // Glitter Trans-Dark Pink
  127: 142, // Trans-Fluorescent Green
  129: 129, // Pearl Very Light Gray
  131: 179, // Flat Silver
  132: 133, // Trans-Medium Blue
  135: 379, // Sand Blue
  136: 373, // Sand Purple
  138: 28,  // Dark Tan / Sand Yellow
  139: 134, // unknown (gray fallback)
  140: 272, // Earth Blue / Dark Blue
  141: 288, // Earth Green / Dark Green
  143: 143, // Trans-Fluorescent Blue
  145: 137, // Pearl Dark Gray
  147: 178, // Sandy Yellow
  148: 148, // Metallic Dark Grey
  150: 150, // Glitter Trans-Clear
  151: 378, // Sand Green
  153: 335, // Sand Red
  154: 320, // Dark Red / New Dark Red
  157: 54,  // Copper (Speckle)
  179: 135, // Satin White
  182: 57,  // Trans-Orange
  183: 183, // Pearl White
  184: 184, // Chrome Pink
  190: 65,  // Metallic Gold
  191: 191, // Bright Light Orange
  192: 70,  // Reddish Brown
  194: 71,  // Medium Stone Gray / Light Bluish Gray
  195: 89,  // Reddish Lilac
  196: 23,  // Dark Blue-Violet
  198: 69,  // Light Lilac
  199: 72,  // Dark Stone Gray / Dark Bluish Gray
  200: 81,  // Metallic Green
  208: 151, // Milky White (Light Stone Gray variant)
  209: 84,  // Medium Dark Flesh
  212: 212, // Bright Light Blue
  216: 216, // Rust
  218: 63,  // Dark Blue
  219: 219, // Lilac
  220: 61,  // Pearl Gold (Warm Gold)
  221: 5,   // Bright Purple / Dark Pink
  222: 29,  // Bright Pink
  223: 77,  // Pink
  226: 226, // Cool Yellow / Bright Light Yellow
  228: 41,  // Trans-Fluorescent Reddish Orange
  229: 39,  // Trans-Dark Turquoise
  230: 45,  // Trans-Dark Pink (medium)
  232: 232, // Sky Blue
  233: 62,  // Trans-Light Green
  234: 44,  // Trans-Yellow (Fire Yellow)
  236: 44,  // Trans-Yellow (alt)
  268: 85,  // Medium Lilac / Dark Purple
  283: 78,  // Light Nougat / Light Flesh
  284: 284, // Trans-Medium Reddish Violet
  285: 285, // Trans-Light Green (bright)
  288: 288, // Dark Green
  293: 293, // Trans-Blue (alt)
  294: 21,  // Glow In Dark Opaque
  295: 295, // Trans-Pink (bright)
  296: 296, // Trans-Light Purple
  297: 297, // Pearl Gold / Warm Gold
  298: 80,  // Metallic Silver
  299: 82,  // Metallic Gold
  300: 300, // Glitter Trans-Neon Green
  302: 302, // Trans-Neon Green (bright)
  304: 117, // Trans-Light Blue
  306: 75,  // Trans-Bright Green
  308: 308, // Dark Brown
  309: 26,  // Magenta
  310: 334, // Bright Pink (trans?)
  311: 35,  // Trans-Fire Yellow / Orange
  312: 86,  // Light Bluish Gray
  315: 87,  // Metallic (Metal)
  316: 83,  // Metallic Dark Gray
  320: 320, // Dark Red (2nd entry)
  321: 321, // Dark Azure
  322: 321, // Dark Azure (rubber alt, use same)
  323: 323, // Light Aqua
  324: 30,  // Medium Lavender
  325: 31,  // Lavender
  326: 326, // Spring Yellowish Green
  329: 329, // Trans-Pink
  330: 330, // Olive Green
  335: 335, // Sand Red
  339: 79,  // Milky White (alt)
  351: 351, // Medium Red
  353: 353, // Coral
  366: 366, // Bright Light Orange (alt)
  373: 373, // Sand Purple
  378: 378, // Sand Green
  379: 379, // Sand Blue
  450: 450, // Fabuland Brown
  462: 462, // Medium Orange
  484: 484, // Dark Orange
  503: 503, // Light Stone Gray

  // ── Transparent colours ────────────────────────────────────────────────────
  // (most already in solid section above by LDD ID)
};

/** Map a LDD material ID to the nearest LDraw color code. Falls back to Light Bluish Gray (71). */
export function lddToLDraw(materialId: number): number {
  return LDD_TO_LDRAW[materialId] ?? 71;
}
