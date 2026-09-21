/**
 * The playable add-on's MODEL SCALE: how big the exported model stands in the
 * world relative to the one LEGO ↔ Minecraft scale (lego-scale.ts, a minifig =
 * the player = 1.8 blocks, so 1 block = 53.33 LDU).
 *
 * WHY A SCALE AT ALL. Minifig-scale sets are right at 1×: their doors fit the
 * figures that walk through them and a City car is a car. LEGO Icons and
 * Technic display models are not built to minifig scale - a 1:12 Mini Cooper
 * is 1,076 parts and 25 studs long, which at 1× is a 9-block car, twice the
 * length of anything the player can drive through a street. Microscale
 * landmarks (Hogwarts 71043, the Architecture line) go the other way: at 1×
 * a tower is a block wide and nothing can be walked. The scale is ONE number
 * that every stage shares - the block/collider cell (`LDU_PER_BLOCK / scale`),
 * the entity compiler's units per LDU (`BEDROCK_UNITS_PER_LDU × scale`) and
 * the figure/seat placement - so the geometry, the colliders and the actors
 * always agree.
 *
 * `auto` picks from evidence in the model:
 *   • a minifig (torso / hips / legs) → 1×: the set is built around the figure;
 *   • a microfigure (85863, 48 LDU with its base) and no minifig → 2×: the
 *     microscale set's own figure stands player height (76419 Hogwarts, 21034);
 *   • a vehicle by its title, no figure → shrink so its longest side is the
 *     real thing's length (car 4.6 m, boat 9 m, aircraft 12 m; 1 block = 1 m),
 *     never enlarge, never under ¼;
 *   • anything else → 1×, and the settings popover offers the fixed steps.
 * The extent is measured from the placements' ORIGINS plus a stud each side -
 * a lower bound (a part's geometry extends past its origin), so the fitted
 * vehicle lands a little under its target rather than over it.
 */

import type { ParsedBrick } from './ldraw-parser.js';
import { LDU_PER_BLOCK } from './lego-scale.js';
import { classifyVehicleKind, isWholeVehicleLabel, type PlayableKind } from './playable-components.js';

/** `auto` or a multiplier of the minifig scale rendered as a string (a `<select>` value). */
export type AddonScaleChoice = 'auto' | '0.25' | '0.5' | '0.75' | '1' | '1.5' | '2' | '3' | '4';

export const ADDON_SCALE_OPTIONS: ReadonlyArray<{ value: AddonScaleChoice; label: string }> = [
  { value: 'auto', label: 'Auto - minifig sets 1×, microfigure sets 2×, display vehicles shrunk to real size' },
  { value: '0.25', label: '¼× - a quarter of minifig scale' },
  { value: '0.5', label: '½× - half of minifig scale' },
  { value: '0.75', label: '¾×' },
  { value: '1', label: '1× - minifig scale (a minifig is player height)' },
  { value: '1.5', label: '1.5×' },
  { value: '2', label: '2× - a microfigure stands player height (microscale builds)' },
  { value: '3', label: '3×' },
  { value: '4', label: '4× - four times minifig scale' },
];

/** Lowest scale `auto` will shrink a display vehicle to. */
export const MIN_AUTO_SCALE = 0.25;

/** Real-world length in blocks (1 block = 1 m) `auto` fits a figure-less vehicle to. */
export const VEHICLE_TARGET_BLOCKS: Record<PlayableKind, number> = { car: 4.6, boat: 9, plane: 12 };

/** LDU each side of the origin extent that stands in for the outermost parts' own size. */
const EXTENT_PAD_LDU = 20;

/** Minifig body moulds: a torso, hips or legs in the model means it is built at minifig scale. */
const MINIFIG_BODY_PARTS = /^(?:973|3814|76382|3815|3816|3817|970)(?![0-9])/;

export type AddonScaleCue = 'minifig' | 'microfig' | 'vehicle' | 'none' | 'explicit';

/** The microfigure mould (85863) is 48 LDU tall with its base: player height at 2×. */
export const MICROFIG_PARTS = /^85863(?![0-9])/;
export const MICROFIG_SCALE = 2;

export interface AddonScalePlan {
  choice: AddonScaleChoice;
  /** Multiplier of the minifig scale (1 = a minifig is player height). */
  scale: number;
  /** LDU per block at this scale - the voxel cell for blocks and colliders. */
  lduPerBlock: number;
  /** What decided the scale. */
  cue: AddonScaleCue;
  /** The vehicle kind the title read as, when `cue` is `vehicle`. */
  kind?: PlayableKind;
  /** Model extent at this scale, in blocks (from placement origins, padded). */
  sizeBlocks: { x: number; y: number; z: number };
  /** One sentence for the settings popover / status line. */
  reason: string;
}

/** LDraw extent of the placements' origins, padded by a stud each side; zero for no bricks. */
export function modelExtentLdu(bricks: readonly ParsedBrick[]): { x: number; y: number; z: number } {
  if (!bricks.length) return { x: 0, y: 0, z: 0 };
  let nx = Infinity, xx = -Infinity, ny = Infinity, xy = -Infinity, nz = Infinity, xz = -Infinity;
  for (const b of bricks) {
    if (b.x < nx) nx = b.x; if (b.x > xx) xx = b.x;
    if (b.y < ny) ny = b.y; if (b.y > xy) xy = b.y;
    if (b.z < nz) nz = b.z; if (b.z > xz) xz = b.z;
  }
  return { x: xx - nx + 2 * EXTENT_PAD_LDU, y: xy - ny + 2 * EXTENT_PAD_LDU, z: xz - nz + 2 * EXTENT_PAD_LDU };
}

/** `bl_973pb5574c01_torso` → `973pb5574c01`; `3815c01.dat` → `3815c01`. */
function mouldId(part: string): string {
  return part.toLowerCase().replace(/\.dat$/, '').replace(/^bl_/, '').replace(/_(?:torso|legs|hips|head)$/, '');
}

/** True when the model carries a minifig body part (it is built at minifig scale). */
export function hasMinifigCue(bricks: readonly ParsedBrick[]): boolean {
  return bricks.some(b => MINIFIG_BODY_PARTS.test(mouldId(b.part)) || /_torso$/i.test(b.part));
}

/** True when the model carries a microfigure (it is a microscale build). */
export function hasMicrofigCue(bricks: readonly ParsedBrick[]): boolean {
  return bricks.some(b => MICROFIG_PARTS.test(mouldId(b.part)));
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

function sizeAt(extent: { x: number; y: number; z: number }, scale: number): { x: number; y: number; z: number } {
  const per = LDU_PER_BLOCK / scale;
  return { x: round2(extent.x / per), y: round2(extent.y / per), z: round2(extent.z / per) };
}

/**
 * Decide the add-on's model scale for a brick list. Pure: the same bricks and
 * choice always give the same plan, so the popover preview and the export agree.
 */
export function planAddonScale(bricks: readonly ParsedBrick[], choice: AddonScaleChoice = 'auto', label = ''): AddonScalePlan {
  const extent = modelExtentLdu(bricks);
  const explicit = choice === 'auto' ? undefined : Number(choice);
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return {
      choice, scale: explicit, lduPerBlock: LDU_PER_BLOCK / explicit, cue: 'explicit', sizeBlocks: sizeAt(extent, explicit),
      reason: `${explicit}× minifig scale, as chosen`,
    };
  }
  if (hasMinifigCue(bricks)) {
    return {
      choice: 'auto', scale: 1, lduPerBlock: LDU_PER_BLOCK, cue: 'minifig', sizeBlocks: sizeAt(extent, 1),
      reason: 'minifig scale (1×): the set has a minifig, so its figures stand player height and its doors fit them',
    };
  }
  if (hasMicrofigCue(bricks)) {
    return {
      choice: 'auto', scale: MICROFIG_SCALE, lduPerBlock: LDU_PER_BLOCK / MICROFIG_SCALE, cue: 'microfig', sizeBlocks: sizeAt(extent, MICROFIG_SCALE),
      reason: `${MICROFIG_SCALE}× minifig scale: a microscale set (it has a microfigure and no minifig), enlarged so its microfigures stand player height`,
    };
  }
  const kind = isWholeVehicleLabel(label) ? classifyVehicleKind(label, 'auto') : null;
  if (kind) {
    const longestBlocks = Math.max(extent.x, extent.z) / LDU_PER_BLOCK;
    const target = VEHICLE_TARGET_BLOCKS[kind];
    const scale = longestBlocks > target ? Math.max(MIN_AUTO_SCALE, round2(target / longestBlocks)) : 1;
    if (scale < 1) {
      return {
        choice: 'auto', scale, lduPerBlock: LDU_PER_BLOCK / scale, cue: 'vehicle', kind, sizeBlocks: sizeAt(extent, scale),
        reason: `${scale}× minifig scale: a display ${kind} with no minifig, shrunk from ${round2(longestBlocks)} to ~${target} blocks long (a real ${kind === 'plane' ? 'aircraft' : kind})`,
      };
    }
    return {
      choice: 'auto', scale: 1, lduPerBlock: LDU_PER_BLOCK, cue: 'vehicle', kind, sizeBlocks: sizeAt(extent, 1),
      reason: `minifig scale (1×): the ${kind} is already within a real ${kind === 'plane' ? 'aircraft' : kind}'s length`,
    };
  }
  return {
    choice: 'auto', scale: 1, lduPerBlock: LDU_PER_BLOCK, cue: 'none', sizeBlocks: sizeAt(extent, 1),
    reason: 'minifig scale (1×): no minifig and no vehicle title to size from; pick a scale to shrink a display model or enlarge a microscale one',
  };
}

/** One line for the settings popover: the decision and the resulting footprint. */
export function describeAddonScale(plan: AddonScalePlan): string {
  const { x, y, z } = plan.sizeBlocks;
  return `${plan.reason} — ≈ ${Math.ceil(x)}×${Math.ceil(y)}×${Math.ceil(z)} blocks`;
}

// ─── The player's passage: what an opening must clear to be walked through ────

/**
 * A Minecraft player is 0.6 blocks wide and 1.8 tall, but the world is made of
 * whole blocks: an opening in a block wall is a whole number of cells, so the
 * smallest passage a player fits through is ONE block wide and TWO high (a
 * vanilla door is exactly that). Standing headroom under a ceiling is the
 * same two blocks. These are the numbers every access measurement
 * (`bedrock-scene-actors.ts`, `measureSceneAccess`) compares a model against.
 */
export const PLAYER_WIDTH_BLOCKS = 0.6;
export const PASSAGE_WIDTH_BLOCKS = 1;
export const PASSAGE_HEIGHT_BLOCKS = 2;
/**
 * How far up a player gets without and with a jump (Minecraft's own numbers:
 * the 0.6 auto-step, the 1.25-block jump). A LEGO brick riser is 24 LDU =
 * 0.45 blocks: a step at 100 %, a jump at 200 % (0.9), and a wall at 300 %
 * (1.35) - which is why a size that opens a micro-scale set's doorways can
 * leave its stairs unclimbable (measured on the coaster's platforms, 2026-09-21).
 */
export const STEP_HEIGHT_BLOCKS = 0.6;
export const JUMP_HEIGHT_BLOCKS = 1.25;

/**
 * The size ladder a walk-through recommendation may name: the export scales
 * `planAddonScale` offers at or above 1× (`1.5`…`4`), which are the Brick
 * Wand's 150…400 % size steps (`WAND_SIZE_STEPS`) applied to a 1× export.
 * Steps below 1× only shrink a model, so they can never open a doorway.
 */
export const ACCESS_SCALE_STEPS: readonly number[] = [1, 1.5, 2, 3, 4];

/**
 * The smallest multiplier of the minifig scale at which an opening
 * `widthLdu` wide and `heightLdu` high clears the player's passage. An
 * opening with no lintel (`heightLdu` = Infinity) is limited by width alone.
 */
export function passageRequiredScale(widthLdu: number, heightLdu: number): number {
  const byWidth = PASSAGE_WIDTH_BLOCKS * LDU_PER_BLOCK / Math.max(widthLdu, 1e-9);
  const byHeight = Number.isFinite(heightLdu) ? PASSAGE_HEIGHT_BLOCKS * LDU_PER_BLOCK / Math.max(heightLdu, 1e-9) : 0;
  return Math.max(byWidth, byHeight);
}

/** The first supported step at or above `requiredScale`; undefined when even 4× is not enough. */
export function accessStepFor(requiredScale: number): number | undefined {
  return ACCESS_SCALE_STEPS.find(step => step + 1e-9 >= requiredScale);
}
