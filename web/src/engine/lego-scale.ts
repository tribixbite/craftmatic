/**
 * THE LEGO ↔ Minecraft scale, shared by the Bedrock entity compiler, the
 * block-export resolution planner and the placement of figures and seats.
 *
 * A standing minifig is 96 LDU from the soles to the top of the head
 * (measured 2026-09-15 from 3816/3815/973/3626 at their standard offsets:
 * legs at y 36, hips 24, torso −8, head −32 → feet at 64, head top at −32)
 * and the Minecraft player is 1.8 blocks, so 1 block = 53.33 LDU = 2.67
 * studs and 1 stud = 6 geometry units (16 per block). Before 2026-09-15 the
 * entity scale was 1 block = 5 studs, which made every vehicle 1.8× too
 * small (a Senna the height of a chair) and read as "erratic" between sets.
 */

/** Feet to head top of a standing minifig, LDU. */
export const LDU_PER_MINIFIG = 96;
/** Minecraft player height in blocks. */
export const PLAYER_HEIGHT_BLOCKS = 1.8;
/** LDU per block at minifig scale (53.33). */
export const LDU_PER_BLOCK = LDU_PER_MINIFIG / PLAYER_HEIGHT_BLOCKS;
/** Bedrock geometry units (16 per block) per LDU: 0.3. */
export const BEDROCK_UNITS_PER_LDU = 16 / LDU_PER_BLOCK;
/** Player eye height above the seat position while riding (seated pose). */
export const SEATED_EYE_HEIGHT_BLOCKS = 1.25;
