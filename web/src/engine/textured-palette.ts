/**
 * The "Textured + shapes" block-mapping palette (docs/schem-shapes-proposal.md
 * pass D) — perceptual OKLab matching over a palette chosen so that the block a
 * LEGO colour lands on actually HAS a slab and a stair.
 *
 * WHY THIS EXISTS, measured. The shipped default profile maps ~97% of cells to
 * dyed concrete, and vanilla Minecraft has NO slab or stair for ANY dyed family
 * (concrete, wool, terracotta, stained glass). So on 21063 the block-shape pass
 * found 87,800 cells whose geometry is genuinely half-height and could rewrite
 * only 5,355 of them — every one of those a LEGO tan mapped to sandstone, the
 * single shape-capable block the default table emits. The other 71,150 were
 * refused for want of a variant (`ShapeStats.noVariantByBlock`), concentrated in
 * gray (19,445), black (16,688), light gray (14,319), white (7,585) and brown
 * (6,855). Moving those LEGO colours onto stone/quartz/plank families is what
 * unlocks the shape passes — this file is that move.
 *
 * THE RULES, in the order they bind:
 *
 * 1. **Transparent and metallic colours are never re-matched.** A trans brick
 *    belongs in stained glass and a chrome brick in a metal block for reasons
 *    that have nothing to do with hue; both families are shapeless anyway, so
 *    there is nothing to win. The default table's answer is kept verbatim.
 *
 * 2. **A colour is only ever REPLACED by a shape-capable block.** When the gates
 *    below refuse every textured candidate, the default profile's own answer is
 *    kept verbatim — this profile has nothing to add there, and second-guessing
 *    a hand-curated table with a nearest-neighbour is how LEGO Orange came out
 *    as `yellow_concrete` in the first cut (nearer in OKLab, wrong to a viewer).
 *    So the whole difference between the two profiles is "cells that gained a
 *    material with a slab", which is exactly what the profile is for.
 *
 * 3. **One block per LEGO colour id, globally.** Material-seam coherence comes
 *    free from that: every cell of every part of a given colour resolves to the
 *    same block, so a part can never dither across families and a large
 *    same-colour region is one material. (The slice-3 rejection — a quartz slab
 *    against a gray concrete wall — was exactly a per-cell material seam; the
 *    fix is to move the WHOLE gray region to a stone-family block, which is what
 *    happens here.)
 *
 * 4. **Nearest in OKLab, but a shape-capable block must EARN the cell twice.**
 *    The best slab-carrying candidate takes the colour only when it is within
 *    `MAX_TEXTURED_DISTANCE` of it in absolute terms AND no worse than the best
 *    dyed candidate by more than `SHAPE_PENALTY`. Otherwise the dyed block wins
 *    even if it is further away — see MAX_TEXTURED_DISTANCE for why a
 *    margin-only rule repaints LEGO red as acacia planks. The anchors this
 *    produces are pinned in test/textured-palette.test.ts.
 *
 * COLOUR SOURCES, honestly. Every value below is an average-sRGB estimate of the
 * vanilla 1.20 texture, not a measurement made in this session. The textured
 * materials reuse the repo's existing render table (`src/blocks/colors.ts`
 * BLOCK_COLORS), whose non-dyed entries are ordinary MC averages; the 16 dyed
 * concretes come from `color-utils.ts` BLOCK_PALETTE, the repo's existing
 * perceptual-match table. The two tables disagree for the dyed families and for
 * `minecraft:sandstone` on purpose: BLOCK_COLORS' concrete entries are
 * deliberately LEGO-TUNED (they carry `// LEGO White #F2F3F2` comments) so that
 * a LEGO export renders back in LEGO colours, which makes them useless as a
 * match reference — matching a LEGO colour against a block coloured like that
 * LEGO colour is circular. Hence the split, and hence the test that only asserts
 * every candidate id is PRESENT in BLOCK_COLORS (so a re-imported export never
 * hits its hash fallback), never that the values agree.
 *
 * EXCLUDED, deliberately:
 *   • glazed terracotta — a directional pattern on every face; measured harm on
 *     smooth LEGO surfaces (proposal §3 pass D), and no slab either.
 *   • wool / terracotta / concrete powder — no slab, and they only duplicate
 *     hues concrete already covers, so they could only ever displace a
 *     shape-capable winner.
 *   • smooth_quartz — the same colour as quartz_block to within a rounding
 *     error, so keeping both would make the winner a coin flip for no gain.
 */

import { LDRAW_COLOR_RGB, ldrawColorToBlock } from './ldraw-colors.js';
import { studioColorToBlock } from './studio-colors.js';
import { BL_TO_LDRAW } from './bl-ldraw-map.js';
import { SHAPE_VARIANTS } from './block-shapes.js';

// ─── OKLab ───────────────────────────────────────────────────────────────────

/** sRGB byte → linear light. */
function toLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * sRGB [0-255] → OKLab (Björn Ottosson, 2020).
 *
 * OKLab rather than the CIE Lab already in `color-utils.ts` because Lab's
 * blue/purple region is badly non-uniform — the exact region where LEGO's
 * saturated colours live, and where a wrong nearest-neighbour is most visible.
 */
export function rgbToOklab(r: number, g: number, b: number): [number, number, number] {
  const rl = toLinear(r), gl = toLinear(g), bl = toLinear(b);
  const l = Math.cbrt(0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl);
  const m = Math.cbrt(0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl);
  const s = Math.cbrt(0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Euclidean distance in OKLab (its whole point: this is perceptual). */
function oklabDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ─── The candidate palette ───────────────────────────────────────────────────

export interface TexturedCandidate {
  block: string;
  rgb: readonly [number, number, number];
}

/**
 * Materials with a slab (and usually a stair) in vanilla, biased toward the
 * muted browns / tans / grays LEGO actually uses and Minecraft's dyed families
 * do not have. RGB values: `src/blocks/colors.ts` BLOCK_COLORS — see the header
 * for why that table is the source for these and NOT for the dyed ones.
 *
 * Whether a candidate is shape-capable is NOT duplicated here: it is read from
 * `SHAPE_VARIANTS` (engine/block-shapes.ts), which is the file that has to be
 * right about it anyway.
 */
const TEXTURED_MATERIALS: readonly TexturedCandidate[] = [
  // Stone family — the workhorse for LEGO's four grays.
  { block: 'minecraft:stone',                      rgb: [125, 125, 125] },
  { block: 'minecraft:smooth_stone',               rgb: [165, 165, 165] },
  { block: 'minecraft:cobblestone',                rgb: [127, 127, 127] },
  { block: 'minecraft:mossy_cobblestone',          rgb: [110, 126, 100] },
  { block: 'minecraft:stone_bricks',               rgb: [122, 122, 122] },
  { block: 'minecraft:mossy_stone_bricks',         rgb: [115, 127, 105] },
  { block: 'minecraft:andesite',                   rgb: [136, 136, 136] },
  { block: 'minecraft:polished_andesite',          rgb: [136, 136, 132] },
  { block: 'minecraft:diorite',                    rgb: [188, 188, 188] },
  { block: 'minecraft:polished_diorite',           rgb: [192, 193, 195] },
  { block: 'minecraft:granite',                    rgb: [149, 103,  83] },
  { block: 'minecraft:polished_granite',           rgb: [154, 107,  86] },
  // Deepslate + blackstone — LEGO's dark bluish gray and near-black.
  { block: 'minecraft:cobbled_deepslate',          rgb: [ 77,  77,  80] },
  { block: 'minecraft:polished_deepslate',         rgb: [ 72,  72,  76] },
  { block: 'minecraft:deepslate_bricks',           rgb: [ 76,  76,  80] },
  { block: 'minecraft:deepslate_tiles',            rgb: [ 54,  54,  58] },
  { block: 'minecraft:blackstone',                 rgb: [ 42,  36,  46] },
  { block: 'minecraft:polished_blackstone',        rgb: [ 60,  54,  65] },
  { block: 'minecraft:polished_blackstone_bricks', rgb: [ 62,  55,  66] },
  // Sandstone — already the default table's only shape-capable block (LEGO tan).
  { block: 'minecraft:sandstone',                  rgb: [216, 203, 155] },
  { block: 'minecraft:smooth_sandstone',           rgb: [220, 207, 159] },
  { block: 'minecraft:cut_sandstone',              rgb: [216, 203, 155] },
  { block: 'minecraft:red_sandstone',              rgb: [186,  99,  29] },
  { block: 'minecraft:smooth_red_sandstone',       rgb: [190, 103,  33] },
  { block: 'minecraft:cut_red_sandstone',          rgb: [181,  98,  31] },
  // Fired clay / mud — LEGO dark red, dark tan, nougat.
  { block: 'minecraft:bricks',                     rgb: [150,  97,  83] },
  { block: 'minecraft:mud_bricks',                 rgb: [137, 106,  82] },
  { block: 'minecraft:nether_bricks',              rgb: [ 72,  30,  35] },
  { block: 'minecraft:red_nether_bricks',          rgb: [ 69,   3,   5] },
  // Prismarine — LEGO sand green / dark turquoise, which no concrete reaches.
  { block: 'minecraft:prismarine',                 rgb: [102, 175, 162] },
  { block: 'minecraft:prismarine_bricks',          rgb: [102, 175, 148] },
  { block: 'minecraft:dark_prismarine',            rgb: [ 64, 108,  88] },
  // Whites and the end/purpur pastels.
  { block: 'minecraft:quartz_block',               rgb: [235, 230, 224] },
  { block: 'minecraft:purpur_block',               rgb: [175, 130, 175] },
  { block: 'minecraft:end_stone_bricks',           rgb: [222, 228, 168] },
  // Waxed copper oxidation ramp — orange → teal, the LEGO dark-orange and
  // sand-green corner of the space. Waxed so the colour cannot drift in-world.
  { block: 'minecraft:waxed_cut_copper',           rgb: [192, 108,  78] },
  { block: 'minecraft:waxed_exposed_cut_copper',   rgb: [150, 117,  85] },
  { block: 'minecraft:waxed_weathered_cut_copper', rgb: [105, 141, 103] },
  { block: 'minecraft:waxed_oxidized_cut_copper',  rgb: [ 81, 164, 134] },
  // All 11 plank families — LEGO's browns, nougats and reddish browns.
  { block: 'minecraft:oak_planks',                 rgb: [162, 130,  78] },
  { block: 'minecraft:spruce_planks',              rgb: [114,  85,  48] },
  { block: 'minecraft:birch_planks',               rgb: [192, 175, 121] },
  { block: 'minecraft:jungle_planks',              rgb: [160, 115,  80] },
  { block: 'minecraft:acacia_planks',              rgb: [168,  90,  50] },
  { block: 'minecraft:dark_oak_planks',            rgb: [ 67,  43,  20] },
  { block: 'minecraft:mangrove_planks',            rgb: [115,  54,  44] },
  { block: 'minecraft:cherry_planks',              rgb: [226, 168, 158] },
  { block: 'minecraft:bamboo_planks',              rgb: [193, 154,  72] },
  { block: 'minecraft:crimson_planks',             rgb: [101,  49,  71] },
  { block: 'minecraft:warped_planks',              rgb: [ 43, 105,  99] },
];

/**
 * The 16 dyed concretes, kept in the pool so the saturated LEGO colours that
 * nothing textured can reach still land somewhere honest. RGB from
 * `color-utils.ts` BLOCK_PALETTE (real Minecraft averages) — NOT from
 * `src/blocks/colors.ts`, whose concrete entries are LEGO-tuned.
 */
const DYED_FALLBACKS: readonly TexturedCandidate[] = [
  { block: 'minecraft:white_concrete',      rgb: [207, 213, 214] },
  { block: 'minecraft:orange_concrete',     rgb: [224,  97,   0] },
  { block: 'minecraft:magenta_concrete',    rgb: [169,  48, 159] },
  { block: 'minecraft:light_blue_concrete', rgb: [ 36, 137, 199] },
  { block: 'minecraft:yellow_concrete',     rgb: [240, 175,  21] },
  { block: 'minecraft:lime_concrete',       rgb: [ 94, 169,  24] },
  { block: 'minecraft:pink_concrete',       rgb: [213, 101, 142] },
  { block: 'minecraft:gray_concrete',       rgb: [ 54,  57,  61] },
  { block: 'minecraft:light_gray_concrete', rgb: [125, 125, 115] },
  { block: 'minecraft:cyan_concrete',       rgb: [ 21, 119, 136] },
  { block: 'minecraft:purple_concrete',     rgb: [100,  31, 156] },
  { block: 'minecraft:blue_concrete',       rgb: [ 44,  46, 143] },
  { block: 'minecraft:brown_concrete',      rgb: [ 96,  59,  31] },
  { block: 'minecraft:green_concrete',      rgb: [ 73,  91,  36] },
  { block: 'minecraft:red_concrete',        rgb: [142,  32,  32] },
  { block: 'minecraft:black_concrete',      rgb: [  8,  10,  15] },
];

/** Every candidate the profile may pick, textured first. */
export const TEXTURED_PALETTE: readonly TexturedCandidate[] = [...TEXTURED_MATERIALS, ...DYED_FALLBACKS];

/**
 * How much WORSE a shape-capable block may be than the best dyed one and still
 * win. This is the "shapes are worth a little colour" allowance.
 */
export const SHAPE_PENALTY = 0.02;

/**
 * How far a shape-capable block may be from the LEGO colour in absolute terms,
 * however badly the dyed families do.
 *
 * BOTH CONSTANTS ARE TUNED, NOT GUESSED — `scripts/_textured_survey.ts` prints
 * every LDraw colour with the best shape-capable distance, the best dyed
 * distance and the margin between them. The margin alone is NOT sufficient, and
 * that was the first version's bug: OKLab genuinely rates `acacia_planks`
 * (0.103) a closer match to LEGO Red than `red_concrete` (0.123), because
 * Minecraft's red concrete is a dark maroon. A margin-only rule therefore
 * repainted LEGO red as wood, orange as bamboo and purple as crimson planks —
 * all "nearest" and all obviously wrong to a viewer. The absolute gate is the
 * statement that when NOTHING textured is close, the dyed family — whose entire
 * purpose is to be that colour — keeps the cell.
 *
 * At 0.08 the anchors land where they should (pinned in the tests): the four
 * LEGO grays → stone/stone_bricks/smooth_stone, white → quartz (0.073, mostly a
 * lightness gap because LDraw idealizes LEGO white to #FFFFFF), tan → smooth
 * sandstone, dark tan → polished andesite, reddish brown → dark oak; while red
 * (0.103), orange (0.102), yellow (0.096), lime (0.139), purple (0.126) and
 * black (0.097 — vanilla's darkest slab material, `blackstone`, is a whole
 * OKLab lightness step above LEGO black) all stay on concrete.
 */
export const MAX_TEXTURED_DISTANCE = 0.08;

/**
 * Hue/chroma guard — the third gate, and the one a schemat.io A/B forced.
 *
 * OKLab distance trades lightness against hue freely, and for LEGO's muted
 * colours the lightness term dominates. Measured on 21063 with only the two
 * distance gates: **121,594 cells of Olive Green landscaping came out as
 * `bamboo_planks`** — a yellow wood floor where the set has a lawn
 * (output/schem-backlog/schemat-io-21063-prof-textured.png, first cut) — and
 * LEGO Dark Tan went to `polished_andesite`, i.e. a neutral gray, dropping the
 * warmth entirely. Both were "nearest" and both read as wrong immediately.
 *
 * So a candidate must also keep the colour's character:
 *   • a CHROMATIC source (C ≥ CHROMA_FLOOR) needs a candidate within
 *     MAX_HUE_SHIFT degrees that keeps at least MIN_CHROMA_RATIO of its chroma;
 *   • a NEUTRAL source (C < CHROMA_FLOOR, where the hue angle is numerical
 *     noise — `#FFFFFF` reads as h 90°, `#A0A5A9` as h 242°) has no hue
 *     constraint but may not GAIN chroma beyond CHROMA_FLOOR, so a gray brick
 *     can take gray stone but never a green or a plank.
 * The matcher then takes the nearest candidate that passes, not the nearest
 * overall — that is what turns Dark Tan into `oak_planks` (dh 7°) instead of
 * andesite, and what makes Dark Green fall back to concrete rather than becoming
 * `deepslate_tiles`.
 */
export const CHROMA_FLOOR = 0.02;
/** Degrees of OKLab hue a shape-capable candidate may shift a chromatic colour. */
export const MAX_HUE_SHIFT = 20;
/** Fraction of the source's chroma a candidate must retain. */
export const MIN_CHROMA_RATIO = 0.35;

interface ScoredCandidate extends TexturedCandidate {
  lab: [number, number, number];
  chroma: number;
  /** Degrees; meaningless (and unused) when `chroma` is below CHROMA_FLOOR. */
  hue: number;
  shapeable: boolean;
}

function polar(lab: readonly [number, number, number]): { chroma: number; hue: number } {
  return {
    chroma: Math.hypot(lab[1], lab[2]),
    hue: (Math.atan2(lab[2], lab[1]) * 180 / Math.PI + 360) % 360,
  };
}

/** Smallest absolute angle between two hues, in degrees. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

const SCORED: readonly ScoredCandidate[] = TEXTURED_PALETTE.map(c => {
  const lab = rgbToOklab(c.rgb[0], c.rgb[1], c.rgb[2]);
  return {
    ...c, lab, ...polar(lab),
    // Read shape availability from the pass that actually uses it, so this file
    // cannot claim a slab exists when block-shapes.ts knows it does not.
    shapeable: SHAPE_VARIANTS[c.block]?.slab != null,
  };
});

/** Does a candidate keep the source colour's hue and saturation character? */
export function keepsColourCharacter(
  source: readonly [number, number, number], candidate: ScoredCandidate,
): boolean {
  const { chroma, hue } = polar(source);
  if (chroma < CHROMA_FLOOR) return candidate.chroma <= chroma + CHROMA_FLOOR;
  return candidate.chroma >= MIN_CHROMA_RATIO * chroma && hueGap(hue, candidate.hue) <= MAX_HUE_SHIFT;
}

export interface TexturedMatch {
  block: string;
  /** Real OKLab distance to the reported block. */
  distance: number;
  /**
   * True when a shape-capable material won, i.e. this profile has something to
   * offer for the colour. FALSE means `block` is only the nearest DYED
   * candidate, reported for diagnostics — the resolvers keep the default
   * profile's mapping in that case (rule 2 in the header).
   */
  shapeable: boolean;
}

/**
 * Which candidate an sRGB colour resolves to.
 *
 * Two independent searches. The shape-capable one takes the nearest candidate
 * that PASSES the colour-character guard — deliberately not the nearest overall,
 * because the nearest is routinely a neutral stone that matches the lightness
 * and throws the hue away (see CHROMA_FLOOR). The dyed one is a plain nearest
 * neighbour and only ever serves as the comparison for SHAPE_PENALTY.
 */
export function matchTextured(r: number, g: number, b: number): TexturedMatch {
  const lab = rgbToOklab(r, g, b);
  let shape: ScoredCandidate | null = null, dShape = Infinity;
  let plain: ScoredCandidate | null = null, dPlain = Infinity;
  for (const c of SCORED) {
    const d = oklabDistance(lab, c.lab);
    if (c.shapeable) {
      if (d < dShape && keepsColourCharacter(lab, c)) { dShape = d; shape = c; }
    } else if (d < dPlain) { dPlain = d; plain = c; }
  }
  if (shape && dShape <= MAX_TEXTURED_DISTANCE && dShape <= dPlain + SHAPE_PENALTY) {
    return { block: shape.block, distance: dShape, shapeable: true };
  }
  if (!plain) return { block: shape!.block, distance: dShape, shapeable: true };
  return { block: plain.block, distance: dPlain, shapeable: false };
}

/** `#RRGGBB` → the matched block, or null when the hex is unparseable. */
export function matchTexturedHex(hex: string): TexturedMatch | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
  return matchTextured(
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  );
}

// ─── Colour-space resolvers (the profile's colorFn) ──────────────────────────

/**
 * Blocks whose choice is not about hue and must survive untouched: transparent
 * bricks belong in stained glass, chrome/pearl/metallic bricks in a metal block.
 * Neither family has a partial shape, so re-matching them could only lose
 * meaning without gaining coverage.
 */
function keepAsIs(block: string): boolean {
  return block.endsWith('_stained_glass')
    || block === 'minecraft:glass'
    || block === 'minecraft:tinted_glass'
    || METAL_BLOCKS.has(block);
}

const METAL_BLOCKS = new Set([
  'minecraft:iron_block', 'minecraft:gold_block', 'minecraft:diamond_block',
  'minecraft:emerald_block', 'minecraft:lapis_block', 'minecraft:redstone_block',
  'minecraft:coal_block', 'minecraft:netherite_block', 'minecraft:copper_block',
]);

const ldrawCache = new Map<number, string>();
const studioCache = new Map<number, string>();

/** LDraw colour id → block, under the textured profile. */
export function texturedLdrawColorToBlock(colorId: number): string {
  const hit = ldrawCache.get(colorId);
  if (hit !== undefined) return hit;
  const fallback = ldrawColorToBlock(colorId);
  const hex = LDRAW_COLOR_RGB[colorId];
  const m = keepAsIs(fallback) || !hex ? null : matchTexturedHex(hex);
  const matched = m?.shapeable ? m.block : fallback;
  ldrawCache.set(colorId, matched);
  return matched;
}

/**
 * Studio/BrickLink colour id → block, under the textured profile.
 *
 * The BL space has no RGB table of its own, so the hue comes from the LDraw one
 * through `BL_TO_LDRAW` (generated from Studio's own StudioColorDefinition.txt).
 * Studio's 10xxx rubber ids are already present in `LDRAW_COLOR_RGB` verbatim,
 * so they are tried directly as well. A colour neither route resolves keeps the
 * default Studio table's block — the honest answer when we don't know its hue.
 */
export function texturedStudioColorToBlock(colorId: number): string {
  const hit = studioCache.get(colorId);
  if (hit !== undefined) return hit;
  const fallback = studioColorToBlock(colorId);
  const ldrawId = BL_TO_LDRAW[colorId];
  const hex = (ldrawId !== undefined ? LDRAW_COLOR_RGB[ldrawId] : undefined) ?? LDRAW_COLOR_RGB[colorId];
  const m = keepAsIs(fallback) || !hex ? null : matchTexturedHex(hex);
  const matched = m?.shapeable ? m.block : fallback;
  studioCache.set(colorId, matched);
  return matched;
}
